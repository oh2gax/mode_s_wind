"""
collector/regdb_update.py

Daily aircraft database update (from 2026-11-01), after the registration
backfill of the companion project modes_logger.

Every morning (default 04:30 UTC, set on the Maintenance page) one
background job:

  1. downloads tar1090-db's aircraft.csv.gz (github.com/wiedehopf/tar1090-db,
     the Mictronics-based database most readsb / tar1090 receivers use;
     about 620 000 aircraft) and, if available, plane-alert-db.csv
     (github.com/sdr-enthusiasts/plane-alert-db: military / government /
     police / civil watchlist with operator).  Both are conditional
     downloads (ETag): a day without a change upstream costs one small
     "304 Not Modified" answer;
  2. keeps them in their own file, data/aircraft_ref.db (never in the main
     database).  Only the rows that changed since the previous day are
     written, so the daily write is small (the first load writes the whole
     table once, about 25 MB).  A download with too few rows is treated as
     broken and the previous data stay;
  3. completes BaseStation.sqb for the aircraft MODE-S Wind has heard in the
     last HEARD_DAYS days (the flights table): empty registrations and types
     are filled; with the type policy "correct" (default) a type that
     differs from tar1090-db is corrected as well.  An existing registration
     is never changed automatically: differences are listed on the
     Maintenance page ("Use tar1090-db value" / "Keep mine").  The previous
     values of every row changed by the last run are kept (table undo), so
     the run can be undone from the Maintenance page.  A missing
     BaseStation.sqb is created with the usual Aircraft table;
  4. tells collector/aircraft_db.py to reopen both files.

When the update is switched off on the Maintenance page no network request
is made at all, and when a download fails (no internet, upstream down) the
existing files are used as before — the off-grid station runs unchanged.
After a failure the job tries once more an hour later; after a restart that
missed the morning run it catches up once.

Settings (maintenance_config of the main database): regdb_enabled ("1",
default on), regdb_time ("HH:MM" UTC), regdb_src_tar1090 / regdb_src_alert
("1"/"0"), regdb_types ("correct" | "fill").  The download and run status
is kept in aircraft_ref.db's meta table, so the main database is not written.

Config overrides (optional): REGDB_TAR1090_URL, REGDB_ALERT_URL,
REGDB_HEARD_DAYS.
"""

from __future__ import annotations

import csv
import gzip
import hashlib
import io
import json
import logging
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

from collector import aircraft_db

log = logging.getLogger("modes.regdb")

TAR1090_URL = "https://raw.githubusercontent.com/wiedehopf/tar1090-db/csv/aircraft.csv.gz"
ALERT_URL   = "https://raw.githubusercontent.com/sdr-enthusiasts/plane-alert-db/main/plane-alert-db.csv"
FETCH_TIMEOUT_SEC = 120
MIN_TAR1090_ROWS  = 100_000     # fewer usable rows → broken download, keep the old data
MIN_ALERT_ROWS    = 1_000
HEARD_DAYS        = 30          # aircraft heard within this many days are completed
STARTUP_DELAY_SEC = 120         # first look after a start
RETRY_AFTER_SEC   = 3600        # one more try this long after a failed run
CATCHUP_AFTER_SEC = 24 * 3600   # a start with no successful run for this long catches up
HISTORY_MAX       = 10
DIFFS_MAX_OUT     = 300
DEFAULT_TIME      = "04:30"     # tar1090-db normally publishes around 04 UTC

HEX6 = re.compile(r"^[0-9A-F]{6}$")
TYPE_RE = re.compile(r"^[A-Z0-9]{2,4}$")

BS_SCHEMA = ("CREATE TABLE IF NOT EXISTS Aircraft(ModeS CHAR(6) UNIQUE PRIMARY KEY, Registration, "
             "ICAOTypeCode, OperatorFlagCode, Manufacturer, Type, RegisteredOwners)")


# ── settings (maintenance_config of the main database) ────────────────────────

def get_settings(conn) -> dict:
    rows = conn.execute(
        "SELECT key, value FROM maintenance_config WHERE key LIKE 'regdb_%'").fetchall()
    c = {r[0]: r[1] for r in rows}
    t = c.get("regdb_time") or DEFAULT_TIME
    if not re.match(r"^([01]\d|2[0-3]):[0-5]\d$", t):
        t = DEFAULT_TIME
    return {
        "enabled":     c.get("regdb_enabled", "1") == "1",     # on by default
        "time":        t,
        "src_tar1090": c.get("regdb_src_tar1090", "1") == "1",
        "src_alert":   c.get("regdb_src_alert", "1") == "1",
        "types":       "fill" if c.get("regdb_types") == "fill" else "correct",
    }


def set_settings(conn, **kw) -> dict:
    cur = get_settings(conn)
    vals = {}
    if "enabled" in kw:
        vals["regdb_enabled"] = "1" if kw["enabled"] else "0"
    if "time" in kw and re.match(r"^([01]\d|2[0-3]):[0-5]\d$", str(kw["time"] or "")):
        vals["regdb_time"] = kw["time"]
    if "src_tar1090" in kw:
        vals["regdb_src_tar1090"] = "1" if kw["src_tar1090"] else "0"
    if "src_alert" in kw:
        vals["regdb_src_alert"] = "1" if kw["src_alert"] else "0"
    if "types" in kw and kw["types"] in ("fill", "correct"):
        vals["regdb_types"] = kw["types"]
    for k, v in vals.items():
        conn.execute("INSERT OR REPLACE INTO maintenance_config (key, value) VALUES (?, ?)", (k, v))
    conn.commit()
    cur.update(get_settings(conn))
    return cur


# ── helpers ───────────────────────────────────────────────────────────────────

def _utc(ts: float | None) -> str | None:
    if not ts:
        return None
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def _n(v) -> str:
    return f"{int(v):,}".replace(",", " ")


def _norm_reg(v: str | None) -> str:
    return re.sub(r"[\s-]", "", (v or "").upper())


class RegDbUpdater:
    """The daily job; one instance, created by run.py (init())."""

    def __init__(self, cfg, ref_path: str, get_main_db):
        self.cfg = cfg
        self.ref_path = ref_path
        self._get_main_db = get_main_db
        self.tar1090_url = getattr(cfg, "REGDB_TAR1090_URL", None) or TAR1090_URL
        self.alert_url = getattr(cfg, "REGDB_ALERT_URL", None) or ALERT_URL
        self.heard_days = int(getattr(cfg, "REGDB_HEARD_DAYS", HEARD_DAYS) or HEARD_DAYS)
        self._run_lock = threading.Lock()
        self._caught_up = False
        self.started = time.time()
        self.phase = ""                 # shown while running

    # ── reference file ────────────────────────────────────────────────────────

    def _ref(self, timeout: float = 30.0) -> sqlite3.Connection:
        os.makedirs(os.path.dirname(os.path.abspath(self.ref_path)), exist_ok=True)
        c = sqlite3.connect(self.ref_path, timeout=timeout)
        c.execute("PRAGMA journal_mode = WAL")
        c.executescript("""
            CREATE TABLE IF NOT EXISTS ac (icao TEXT PRIMARY KEY, reg TEXT, type TEXT,
                                           flags TEXT, descr TEXT) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS alert (icao TEXT PRIMARY KEY, reg TEXT, operator TEXT,
                                              type_name TEXT, icao_type TEXT, cmpg TEXT,
                                              category TEXT) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE IF NOT EXISTS diffs (icao TEXT PRIMARY KEY, ours TEXT, theirs TEXT,
                                              type TEXT, last_heard INTEGER);
            CREATE TABLE IF NOT EXISTS dismissed (icao TEXT PRIMARY KEY, theirs TEXT);
            CREATE TABLE IF NOT EXISTS undo (icao TEXT PRIMARY KEY, existed INTEGER,
                                             reg TEXT, type TEXT, run_ts INTEGER);
        """)
        return c

    @staticmethod
    def _meta(c) -> dict:
        return dict(c.execute("SELECT key, value FROM meta").fetchall())

    @staticmethod
    def _set_meta(c, **kw) -> None:
        c.executemany("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
                      [(k, "" if v is None else str(v)) for k, v in kw.items()])

    def _ref_ro(self):
        if not os.path.exists(self.ref_path):
            return None
        from pathlib import Path
        try:
            return sqlite3.connect(Path(self.ref_path).resolve().as_uri() + "?mode=ro",
                                   uri=True, timeout=5)
        except sqlite3.Error:
            return None

    # ── download ──────────────────────────────────────────────────────────────

    def _download(self, url: str, etag: str | None) -> tuple[bytes | None, str]:
        """(data, etag); data None = 304 Not Modified.  Raises on failure."""
        hdr = {"User-Agent": "MODE-S-Wind/1.0 (daily aircraft database update)"}
        if etag:
            hdr["If-None-Match"] = etag
        req = urllib.request.Request(url, headers=hdr)
        try:
            with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_SEC) as r:
                return r.read(), r.headers.get("ETag") or ""
        except urllib.error.HTTPError as e:
            if e.code == 304:
                return None, etag or ""
            raise

    # ── tar1090-db ────────────────────────────────────────────────────────────

    @staticmethod
    def _tar1090_rows(gz: bytes):
        """(icao, reg, type, flags, descr) of aircraft.csv.gz
        ("icao;reg;type;flags;description;…"; flags = military, interesting,
        PIA, LADD as 0/1 characters).  The description is kept only for
        military-flagged aircraft (for the visit log)."""
        with gzip.GzipFile(fileobj=io.BytesIO(gz)) as f:
            for line in io.TextIOWrapper(f, encoding="utf-8", errors="replace"):
                p = line.rstrip("\r\n").split(";")
                if len(p) < 4:
                    continue
                icao = p[0].strip().upper()
                if not HEX6.match(icao):
                    continue
                reg, typ, flags = p[1].strip(), p[2].strip().upper(), p[3].strip()
                if not reg and not typ and "1" not in flags:
                    continue
                descr = p[4].strip()[:60] if flags[:1] == "1" and len(p) > 4 else None
                yield icao, reg or None, typ or None, flags or None, descr or None

    def _load_tar1090(self, c, gz: bytes, etag: str) -> dict:
        sha = hashlib.sha256(gz).hexdigest()
        if self._meta(c).get("ac_sha") == sha:
            return {"changed": 0, "same": True}
        c.execute("PRAGMA temp_store = MEMORY")
        c.execute("DROP TABLE IF EXISTS temp.n_ac")
        c.execute("CREATE TEMP TABLE n_ac (icao TEXT PRIMARY KEY, reg TEXT, type TEXT, "
                  "flags TEXT, descr TEXT) WITHOUT ROWID")
        try:
            c.executemany("INSERT OR REPLACE INTO temp.n_ac VALUES (?,?,?,?,?)", self._tar1090_rows(gz))
            n = c.execute("SELECT COUNT(*) FROM temp.n_ac").fetchone()[0]
            if n < MIN_TAR1090_ROWS:
                raise ValueError(f"tar1090-db: only {n} usable rows — previous data kept")
            before = c.total_changes
            c.execute("DELETE FROM ac WHERE icao NOT IN (SELECT icao FROM temp.n_ac)")
            removed = c.total_changes - before
            before = c.total_changes
            c.execute("""INSERT OR REPLACE INTO ac (icao, reg, type, flags, descr)
                         SELECT n.icao, n.reg, n.type, n.flags, n.descr FROM temp.n_ac n
                         LEFT JOIN ac a ON a.icao = n.icao
                         WHERE a.icao IS NULL OR a.reg IS NOT n.reg OR a.type IS NOT n.type
                            OR a.flags IS NOT n.flags OR a.descr IS NOT n.descr""")
            changed = c.total_changes - before
            mil = c.execute("SELECT COUNT(*) FROM ac WHERE flags LIKE '1%'").fetchone()[0]
            self._set_meta(c, ac_entries=n, ac_sha=sha, ac_etag=etag, ac_downloaded=int(time.time()),
                           ac_mil=mil)
            c.commit()
        except Exception:
            c.rollback()
            raise
        finally:
            try:
                c.execute("DROP TABLE IF EXISTS temp.n_ac")
            except sqlite3.Error:
                pass
        return {"changed": changed, "removed": removed, "entries": n}

    # ── plane-alert-db ────────────────────────────────────────────────────────

    def _load_alert(self, c, data: bytes, etag: str) -> dict:
        sha = hashlib.sha256(data).hexdigest()
        if self._meta(c).get("alert_sha") == sha:
            return {"same": True}
        rows = {}
        rdr = csv.DictReader(io.StringIO(data.decode("utf-8", errors="replace")))
        for r in rdr:
            icao = (r.get("$ICAO") or "").strip().upper().zfill(6)
            if not HEX6.match(icao):
                continue
            rows[icao] = (icao, (r.get("$Registration") or "").strip() or None,
                          (r.get("$Operator") or "").strip()[:80] or None,
                          (r.get("$Type") or "").strip()[:80] or None,
                          (r.get("$ICAO Type") or "").strip().upper()[:4] or None,
                          (r.get("#CMPG") or "").strip()[:3] or None,
                          (r.get("Category") or "").strip()[:40] or None)
        if len(rows) < MIN_ALERT_ROWS:
            raise ValueError(f"plane-alert-db: only {len(rows)} rows — previous data kept")
        try:
            c.execute("DELETE FROM alert")
            c.executemany("INSERT INTO alert VALUES (?,?,?,?,?,?,?)", rows.values())
            self._set_meta(c, alert_entries=len(rows), alert_sha=sha, alert_etag=etag,
                           alert_downloaded=int(time.time()))
            c.commit()
        except Exception:
            c.rollback()
            raise
        return {"entries": len(rows)}

    # ── BaseStation.sqb ───────────────────────────────────────────────────────

    def _heard(self) -> dict[str, int]:
        """{icao: last heard (Unix s)} of the last heard_days days."""
        since = time.time() - self.heard_days * 86400
        conn = self._get_main_db()
        out: dict[str, int] = {}
        for icao, ls in conn.execute(
                "SELECT icao, MAX(last_seen) FROM flights WHERE last_seen >= ? GROUP BY icao", (since,)):
            k = (icao or "").strip().upper()
            if HEX6.match(k):
                out[k] = int(ls or 0)
        return out

    def _bs_connect(self, create: bool):
        path = aircraft_db.paths()[0]
        if not path:
            return None, None
        if not os.path.exists(path):
            if not create:
                return None, path
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        b = sqlite3.connect(path, timeout=30)
        b.execute("PRAGMA busy_timeout = 30000")
        if create:
            b.execute(BS_SCHEMA)
            b.commit()
        return b, path

    def _fill_basestation(self, c, types_policy: str) -> dict:
        heard = self._heard()
        b, path = self._bs_connect(create=True)
        if b is None:
            return {"error": "no BaseStation.sqb path"}
        dismissed = dict(c.execute("SELECT icao, theirs FROM dismissed").fetchall())
        icaos = sorted(heard)
        regs = types = fixed = unknown = 0
        examples: list[str] = []
        undo: list[tuple] = []
        diffs: list[tuple] = []
        now = int(time.time())
        try:
            cur = b.cursor()
            for i in range(0, len(icaos), 500):
                chunk = icaos[i:i + 500]
                ph = ",".join("?" * len(chunk))
                ours = {r[0].upper(): (r[1], r[2]) for r in cur.execute(
                    f"SELECT ModeS, Registration, ICAOTypeCode FROM Aircraft WHERE ModeS IN ({ph})", chunk)}
                theirs = {r[0]: (r[1], r[2]) for r in c.execute(
                    f"SELECT icao, reg, type FROM ac WHERE icao IN ({ph})", chunk)}
                for icao in chunk:
                    o = ours.get(icao)
                    o_reg = (o[0] or "").strip() if o else ""
                    o_typ = (o[1] or "").strip().upper() if o else ""
                    t = theirs.get(icao)
                    t_reg = (t[0] or "").strip() if t else ""
                    t_typ = (t[1] or "").strip().upper() if t else ""
                    if t_typ and not TYPE_RE.match(t_typ):
                        t_typ = ""
                    new_reg, new_typ = o_reg, o_typ
                    # a different registration means the address now belongs to
                    # another aircraft (e.g. reused 9H- addresses): leave the row
                    # to the user (registration differences) — no type change
                    conflict = bool(o_reg and t_reg and _norm_reg(o_reg) != _norm_reg(t_reg))
                    if t_reg and not o_reg:
                        new_reg = t_reg
                        regs += 1
                    if conflict:
                        pass
                    elif t_typ and not o_typ:
                        new_typ = t_typ
                        types += 1
                    elif t_typ and o_typ and t_typ != o_typ and types_policy == "correct":
                        new_typ = t_typ
                        fixed += 1
                        if len(examples) < 5:
                            examples.append(f"{o_typ} → {t_typ}")
                    if not new_reg:
                        unknown += 1
                    if conflict and _norm_reg(dismissed.get(icao)) != _norm_reg(t_reg):
                        diffs.append((icao, o_reg, t_reg, t_typ or None, heard[icao]))
                    if (new_reg, new_typ) == (o_reg, o_typ):
                        continue
                    undo.append((icao, 1 if o else 0, o[0] if o else None, o[1] if o else None, now))
                    if o:
                        cur.execute("UPDATE Aircraft SET Registration = ?, ICAOTypeCode = ? WHERE ModeS = ?",
                                    (new_reg or o[0], new_typ or o[1], icao))
                    else:
                        cur.execute("INSERT INTO Aircraft (ModeS, Registration, ICAOTypeCode) VALUES (?, ?, ?)",
                                    (icao, new_reg or None, new_typ or None))
            b.commit()
        except Exception:
            b.rollback()
            raise
        finally:
            b.close()
        # undo data and the differences list live in aircraft_ref.db
        if undo:
            c.execute("DELETE FROM undo")
            c.executemany("INSERT OR REPLACE INTO undo VALUES (?,?,?,?,?)", undo)
        c.execute("DELETE FROM diffs")
        c.executemany("INSERT OR REPLACE INTO diffs VALUES (?,?,?,?,?)", diffs)
        c.commit()
        return {"heard": len(icaos), "regs": regs, "types": types, "fixed": fixed,
                "examples": examples, "unknown": unknown, "diffs": len(diffs),
                "rows_changed": len(undo)}

    # ── one run ───────────────────────────────────────────────────────────────

    def update(self, reason: str = "scheduled") -> bool:
        """One full run (download(s) + BaseStation.sqb).  False when a run
        was already in progress."""
        if not self._run_lock.acquire(blocking=False):
            return False
        t0 = time.time()
        try:
            s = get_settings(self._get_main_db())
            c = self._ref()
            meta = self._meta(c)
            self._set_meta(c, attempt_ts=int(t0), attempt_reason=reason)
            c.commit()
            errors, notes = [], []
            if s["src_tar1090"]:
                self.phase = "downloading tar1090-db"
                try:
                    have = c.execute("SELECT 1 FROM ac LIMIT 1").fetchone() is not None
                    data, etag = self._download(self.tar1090_url, meta.get("ac_etag") if have else None)
                    if data is None:
                        notes.append("tar1090-db unchanged upstream")
                    else:
                        self.phase = "loading tar1090-db"
                        r = self._load_tar1090(c, data, etag)
                        notes.append("tar1090-db unchanged" if r.get("same") else
                                     f"tar1090-db {_n(r['entries'])} aircraft, {_n(r['changed'])} rows new or "
                                     f"changed, {_n(r['removed'])} removed")
                except Exception as exc:
                    errors.append(f"tar1090-db: {exc}")
                    log.warning("Aircraft database: tar1090-db download failed: %s", exc)
            if s["src_alert"]:
                self.phase = "downloading plane-alert-db"
                try:
                    have = c.execute("SELECT 1 FROM alert LIMIT 1").fetchone() is not None
                    data, etag = self._download(self.alert_url, meta.get("alert_etag") if have else None)
                    if data is None:
                        notes.append("plane-alert-db unchanged upstream")
                    else:
                        r = self._load_alert(c, data, etag)
                        notes.append("plane-alert-db unchanged" if r.get("same") else
                                     f"plane-alert-db {_n(r['entries'])} aircraft")
                except Exception as exc:
                    errors.append(f"plane-alert-db: {exc}")
                    log.warning("Aircraft database: plane-alert-db download failed: %s", exc)
            fill = None
            if c.execute("SELECT 1 FROM ac LIMIT 1").fetchone() is not None:
                self.phase = "completing BaseStation.sqb"
                try:
                    fill = self._fill_basestation(c, s["types"])
                except Exception as exc:
                    errors.append(f"BaseStation.sqb: {exc}")
                    log.warning("Aircraft database: BaseStation.sqb update failed: %s", exc)
            elif not errors:
                errors.append("no aircraft data yet")
            ok = not errors
            run = {"ts": int(t0), "dur": round(time.time() - t0, 1), "ok": ok, "reason": reason,
                   "errors": errors, "notes": notes, "fill": fill}
            hist = []
            try:
                hist = json.loads(self._meta(c).get("history") or "[]")
            except ValueError:
                hist = []
            hist = ([run] + hist)[:HISTORY_MAX]
            kw = {"last_run": json.dumps(run), "history": json.dumps(hist), "last_ok": "1" if ok else "0"}
            if ok:
                kw["ok_ts"] = int(time.time())
            self._set_meta(c, **kw)
            c.commit()
            c.close()
            aircraft_db.reload()
            if fill:
                log.info("Aircraft database: %d heard aircraft checked — %d registrations and %d types "
                         "filled, %d types corrected, %d registration differences (%s)",
                         fill["heard"], fill["regs"], fill["types"], fill["fixed"], fill["diffs"],
                         "; ".join(notes) or "no download")
            return True
        except Exception as exc:
            log.warning("Aircraft database update error: %s", exc)
            return True
        finally:
            self.phase = ""
            self._run_lock.release()

    def update_async(self, reason: str = "manual") -> bool:
        if self._run_lock.locked():
            return False
        threading.Thread(target=self.update, args=(reason,), name="regdb_now", daemon=True).start()
        return True

    @property
    def running(self) -> bool:
        return self._run_lock.locked()

    # ── schedule ──────────────────────────────────────────────────────────────

    def _due(self, now: float, s: dict) -> str | None:
        r = self._ref_ro()
        meta = {}
        if r is not None:
            try:
                meta = self._meta(r)
            except sqlite3.Error:
                meta = {}
            finally:
                r.close()
        attempt = float(meta.get("attempt_ts") or 0)
        ok_ts = float(meta.get("ok_ts") or 0)
        hh, mm = (int(x) for x in s["time"].split(":"))
        d = datetime.fromtimestamp(now, timezone.utc).replace(hour=hh, minute=mm, second=0, microsecond=0)
        sched = d.timestamp()
        if sched > now:
            sched -= 86400                          # the latest scheduled time already passed
        if attempt < sched <= now:
            return "scheduled"
        if meta.get("last_ok") == "0" and attempt >= sched and now - attempt >= RETRY_AFTER_SEC \
                and meta.get("retry_for") != str(int(sched)):
            return "retry"
        if not self._caught_up and now - ok_ts > CATCHUP_AFTER_SEC and now - attempt > RETRY_AFTER_SEC:
            return "catch-up"
        return None

    def run(self) -> None:
        """Background thread (run.py): looks once a minute whether a run is due."""
        time.sleep(STARTUP_DELAY_SEC)
        while True:
            try:
                s = get_settings(self._get_main_db())
                if s["enabled"]:
                    reason = self._due(time.time(), s)
                    self._caught_up = True
                    if reason:
                        if reason == "retry":
                            c = self._ref()
                            hh, mm = (int(x) for x in s["time"].split(":"))
                            d = datetime.now(timezone.utc).replace(hour=hh, minute=mm, second=0, microsecond=0)
                            sched = d.timestamp() - (86400 if d.timestamp() > time.time() else 0)
                            self._set_meta(c, retry_for=int(sched))
                            c.commit()
                            c.close()
                        self.update(reason)
            except Exception as exc:
                log.debug("Aircraft database schedule error: %s", exc)
            time.sleep(60)

    # ── Maintenance page ──────────────────────────────────────────────────────

    def status(self) -> dict:
        s = get_settings(self._get_main_db())
        out = {"settings": s, "running": self.running, "phase": self.phase,
               "bs": aircraft_db.status(), "meta": {}, "last_run": None, "history": [],
               "diffs": [], "hidden": 0, "undo": None,
               "sources": {"tar1090": self.tar1090_url, "alert": self.alert_url},
               "heard_days": self.heard_days}
        r = self._ref_ro()
        if r is None:
            return out
        try:
            m = self._meta(r)
            out["meta"] = {
                "ac_entries": int(m.get("ac_entries") or 0) or None,
                "ac_mil": int(m.get("ac_mil") or 0) or None,
                "ac_downloaded": _utc(float(m.get("ac_downloaded") or 0)),
                "alert_entries": int(m.get("alert_entries") or 0) or None,
                "alert_downloaded": _utc(float(m.get("alert_downloaded") or 0)),
                "attempt": _utc(float(m.get("attempt_ts") or 0)),
                "ok": _utc(float(m.get("ok_ts") or 0)),
                "ok_ts": float(m.get("ok_ts") or 0) or None,
                "last_ok": m.get("last_ok"),
            }
            try:
                out["last_run"] = json.loads(m.get("last_run") or "null")
                out["history"] = json.loads(m.get("history") or "[]")
            except ValueError:
                pass
            for h in [out["last_run"]] + out["history"]:
                if h:
                    h["utc"] = _utc(h.get("ts"))
            rows = r.execute("SELECT icao, ours, theirs, type, last_heard FROM diffs "
                             "ORDER BY last_heard DESC LIMIT ?", (DIFFS_MAX_OUT,)).fetchall()
            out["diffs"] = [{"icao": a, "ours": b, "theirs": t, "type": ty,
                             "heard": datetime.fromtimestamp(h, timezone.utc).strftime("%Y-%m-%d") if h else None}
                            for a, b, t, ty, h in rows]
            out["diffs_total"] = r.execute("SELECT COUNT(*) FROM diffs").fetchone()[0]
            out["hidden"] = r.execute("SELECT COUNT(*) FROM dismissed").fetchone()[0]
            u = r.execute("SELECT COUNT(*), MAX(run_ts) FROM undo").fetchone()
            if u and u[0]:
                out["undo"] = {"rows": u[0], "utc": _utc(u[1])}
        except sqlite3.Error as exc:
            out["error"] = str(exc)
        finally:
            r.close()
        return out

    def health(self) -> dict:
        """Brief state for the system health (Statistics page)."""
        s = get_settings(self._get_main_db())
        out = {"enabled": s["enabled"], "ok_ts": None, "last_ok": None, "error": None,
               "started": self.started}
        r = self._ref_ro()
        if r is None:
            return out
        try:
            m = self._meta(r)
            out["ok_ts"] = float(m.get("ok_ts") or 0) or None
            out["last_ok"] = m.get("last_ok")
            try:
                lr = json.loads(m.get("last_run") or "null")
                if lr and lr.get("errors"):
                    out["error"] = lr["errors"][0]
            except ValueError:
                pass
        except sqlite3.Error:
            pass
        finally:
            r.close()
        return out

    def diffs_action(self, action: str, icaos: list[str]) -> int:
        """use: set BaseStation.sqb's registration to tar1090-db's;
        keep: hide the difference (until tar1090-db's value changes);
        unhide: list every hidden difference again."""
        icaos = [i.strip().upper() for i in (icaos or []) if HEX6.match((i or "").strip().upper())]
        c = self._ref()
        try:
            if action == "unhide":
                n = c.execute("DELETE FROM dismissed").rowcount
                c.commit()
                return n
            if not icaos:
                return 0
            ph = ",".join("?" * len(icaos))
            rows = c.execute(f"SELECT icao, theirs, type FROM diffs WHERE icao IN ({ph})", icaos).fetchall()
            n = 0
            if action == "use":
                b, _ = self._bs_connect(create=False)
                if b is None:
                    return 0
                try:
                    for icao, theirs, typ in rows:    # tar1090-db's registration and its type
                        n += b.execute("UPDATE Aircraft SET Registration = ?, "
                                       "ICAOTypeCode = COALESCE(?, ICAOTypeCode) WHERE ModeS = ?",
                                       (theirs, typ, icao)).rowcount
                    b.commit()
                finally:
                    b.close()
                aircraft_db.reload()
            elif action == "keep":
                c.executemany("INSERT OR REPLACE INTO dismissed VALUES (?, ?)", [(r[0], r[1]) for r in rows])
                n = len(rows)
            else:
                return 0
            c.executemany("DELETE FROM diffs WHERE icao = ?", [(r[0],) for r in rows])
            c.commit()
            return n
        finally:
            c.close()

    def undo_last(self) -> int:
        """Restore the rows the last run changed in BaseStation.sqb."""
        if self._run_lock.locked():
            return -1
        c = self._ref()
        try:
            rows = c.execute("SELECT icao, existed, reg, type FROM undo").fetchall()
            if not rows:
                return 0
            b, _ = self._bs_connect(create=False)
            if b is None:
                return 0
            try:
                for icao, existed, reg, typ in rows:
                    if existed:
                        b.execute("UPDATE Aircraft SET Registration = ?, ICAOTypeCode = ? WHERE ModeS = ?",
                                  (reg, typ, icao))
                    else:
                        b.execute("DELETE FROM Aircraft WHERE ModeS = ?", (icao,))
                b.commit()
            finally:
                b.close()
            c.execute("DELETE FROM undo")
            c.commit()
            aircraft_db.reload()
            log.info("Aircraft database: last update undone (%d BaseStation.sqb rows restored)", len(rows))
            return len(rows)
        finally:
            c.close()


_updater: RegDbUpdater | None = None


def init(cfg, ref_path: str, get_main_db) -> RegDbUpdater:
    global _updater
    _updater = RegDbUpdater(cfg, ref_path, get_main_db)
    return _updater


def get() -> RegDbUpdater | None:
    return _updater
