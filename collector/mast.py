"""
collector/mast.py — the Kivenlahti mast (FMI open data), from 2026-11-01.

The 327 m mast at Latokaski, Espoo (FMI station "Espoo Latokaski", fmisid
101000, WMO 2837; 60.178 N 24.640 E, ground 44 m MSL — 23.6 km south-west of
EFHK, near the extended centreline of runways 04L / 04R) measures every
10 minutes:
  temperature, relative humidity and dewpoint at 2, 26, 49, 92, 141, 217,
  265 and 297 m above the ground, and
  wind speed, direction and gust (m/s) at 26, 92, 217 and 327 m.
The heights are above the ground; ft MSL = (m + 44) × 3.2808: 230, 446, 856
and 1 217 ft for the wind.

FMI WFS stored query fmi::observations::weather::mast::multipointcoverage
(fmisid, starttime, endtime, timestep, parameters; at most 168 h per
request).  The XML is verbose — one member per parameter and time, about
37 kB per 10-minute step — so it is read with regular expressions, not a
DOM.  A new step appears about 5 minutes after its time.

The thread looks every 10 minutes (at about :x5:30) and fetches everything
after the newest stored step; after a start (or a break) it back-fills up to
MAST_BACKFILL_DAYS (7) in 6-hour pieces.  One row per step (table mast_obs,
about 300 bytes, 144 a day — 15 MB a year), kept for good (never purged).
On / off on the Maintenance page (maintenance_config "mast_enabled", on by
default): off, no network requests at all — the off-grid station runs as
before.

Data: Finnish Meteorological Institute open data, CC BY 4.0.

Optional config keys (read with defaults):
  MAST_FMISID = 101000          the mast (FMI station id)
  MAST_BACKFILL_DAYS = 7        days fetched after a start or a break
"""

from __future__ import annotations

import json
import logging
import math
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

log = logging.getLogger("modes.mast")

BASE_URL = "https://opendata.fmi.fi/wfs"
QUERY = "fmi::observations::weather::mast::multipointcoverage"
FMISID = 101000
PARAMS = ("TA", "RH", "TD", "WS", "WD", "WG")
KEYS = {"TA": "t", "RH": "rh", "TD": "td", "WS": "ws", "WD": "wd", "WG": "wg"}
STEP_SEC = 600
CHUNK_SEC = 6 * 3600              # one request: 6 h (about 1.4 MB of XML)
BACKFILL_DAYS = 7
STARTUP_DELAY_SEC = 45
LOOK_OFFSET_SEC = 330             # look at :x5:30 — a step appears about 5 min after its time
TIMEOUT_SEC = 90
KT_MS = 0.514444

SCHEMA = """CREATE TABLE IF NOT EXISTS mast_obs (
    fmisid INTEGER NOT NULL,
    ts     INTEGER NOT NULL,      -- observation time (UTC, Unix s, every 10 min)
    data   TEXT    NOT NULL,      -- {"tl": [m], "t", "rh", "td": [per tl], "wl": [m], "ws", "wd", "wg": [per wl]} (m/s, °C, %)
    PRIMARY KEY (fmisid, ts)
) WITHOUT ROWID"""

_MEMBER = re.compile(r"<wfs:member>(.*?)</wfs:member>", re.S)
_FIELD = re.compile(r'<swe:field name="([^"]+)"')
_TIME = re.compile(r"<gml:timePosition>([^<]+)</gml:timePosition>")
_POS = re.compile(r"<gmlcov:positions>(.*?)</gmlcov:positions>", re.S)
_VALS = re.compile(r"<gml:doubleOrNilReasonTupleList>(.*?)</gml:doubleOrNilReasonTupleList>", re.S)
_GPOS = re.compile(r"<gml:pos>([^<]+)</gml:pos>")
_NAME = re.compile(r'<gml:name codeSpace="http://xml.fmi.fi/namespace/locationcode/name">([^<]+)</gml:name>')
_EXC = re.compile(r"<ExceptionText>([^<]*)</ExceptionText>")


class FmiError(Exception):
    """FMI refused the request (e.g. a too long time interval)."""


def _num(s: str):
    try:
        v = float(s)
    except ValueError:
        return None
    return None if math.isnan(v) else v


def parse(xml: bytes | str) -> tuple:
    """WFS answer → (station {name, lat, lon, elev}, {ts: {param: (levels, values)}})."""
    s = xml.decode("utf-8", "replace") if isinstance(xml, (bytes, bytearray)) else xml
    exc = _EXC.search(s)
    if exc and "<wfs:member>" not in s:
        raise FmiError(exc.group(1).strip()[:200])
    st = {}
    m = _NAME.search(s)
    if m:
        st["name"] = m.group(1)
    m = _GPOS.search(s)
    if m:
        p = m.group(1).split()
        if len(p) >= 2:
            st["lat"], st["lon"] = float(p[0]), float(p[1])
        if len(p) >= 3:
            st["elev"] = float(p[2])
    out: dict = {}
    for mem in _MEMBER.findall(s):
        f, t = _FIELD.search(mem), _TIME.search(mem)
        pos, val = _POS.search(mem), _VALS.search(mem)
        if not (f and t and pos and val):
            continue
        try:
            ts = int(datetime.strptime(t.group(1).strip(), "%Y-%m-%dT%H:%M:%SZ")
                     .replace(tzinfo=timezone.utc).timestamp())
        except ValueError:
            continue
        lv = [float(x) for x in pos.group(1).split()]
        vs = [_num(x) for x in val.group(1).split()]
        if len(lv) != len(vs):
            continue
        out.setdefault(ts, {})[f.group(1)] = (lv, vs)
    return st, out


def compact(params: dict) -> dict | None:
    """{param: (levels, values)} of one step → the stored record, or None when empty."""
    rec = {}
    tl = params.get("TA", params.get("RH", params.get("TD", ([], []))))[0]
    wl = params.get("WS", params.get("WD", ([], [])))[0]
    rec["tl"] = [round(x) for x in tl]
    rec["wl"] = [round(x) for x in wl]
    any_val = False
    for p, k in KEYS.items():
        lv, vs = params.get(p, ([], []))
        ref = tl if p in ("TA", "RH", "TD") else wl
        vals = []
        for h in ref:
            v = None
            if h in lv:
                v = vs[lv.index(h)]
            vals.append(None if v is None else round(v, 1))
        if any(v is not None for v in vals):
            any_val = True
        rec[k] = vals
    return rec if any_val else None


# ── settings (maintenance_config of the main database) ────────────────────────

def get_settings(conn) -> dict:
    try:
        r = conn.execute("SELECT value FROM maintenance_config WHERE key = 'mast_enabled'").fetchone()
    except Exception:                                  # noqa: BLE001  (old database)
        r = None
    return {"enabled": (r[0] if r else "1") == "1"}          # on by default


def set_settings(conn, enabled=None) -> dict:
    if enabled is not None:
        conn.execute("INSERT OR REPLACE INTO maintenance_config (key, value) VALUES ('mast_enabled', ?)",
                     ("1" if enabled else "0",))
        conn.commit()
    return get_settings(conn)


# ── fetcher ───────────────────────────────────────────────────────────────────

class MastFetcher:
    def __init__(self, get_db, fmisid: int = FMISID, backfill_days: float = BACKFILL_DAYS,
                 base_url: str = BASE_URL):
        self.get_db = get_db
        self.fmisid = int(fmisid)
        self.backfill_days = float(backfill_days)
        self.base_url = base_url
        self.station = {"name": "Espoo Latokaski (Kivenlahti mast)", "lat": 60.17771, "lon": 24.64009, "elev": 44.0}
        self.last = None              # (time, ok, text)
        self.last_ok = None
        self.stored_total = 0
        self.running = False
        self._lock = threading.Lock()

    def ensure_table(self, db) -> None:
        db.execute(SCHEMA)
        db.commit()

    def newest(self, db):
        try:
            r = db.execute("SELECT MAX(ts) FROM mast_obs WHERE fmisid = ?", (self.fmisid,)).fetchone()
            return r[0] if r and r[0] is not None else None
        except Exception:                              # noqa: BLE001
            return None

    def _get(self, start: float, end: float) -> bytes:
        iso = lambda t: datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        q = {"service": "WFS", "version": "2.0.0", "request": "getFeature", "storedquery_id": QUERY,
             "fmisid": str(self.fmisid), "starttime": iso(start), "endtime": iso(end), "timestep": "10"}
        url = self.base_url + "?" + urllib.parse.urlencode(q, safe=":,")
        req = urllib.request.Request(url, headers={"User-Agent": "MODE-S-Wind/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as r:
                return r.read()
        except urllib.error.HTTPError as exc:
            body = exc.read()
            m = _EXC.search(body.decode("utf-8", "replace"))
            if exc.code < 500:
                raise FmiError(f"HTTP {exc.code}: {m.group(1).strip()[:120] if m else ''}")
            raise ConnectionError(f"HTTP {exc.code}")

    def fetch_range(self, start: float, end: float) -> int:
        """Fetch [start, end] in pieces of CHUNK_SEC and store the steps; returns the number stored."""
        db = self.get_db()
        n = 0
        t = start
        while t < end:
            t1 = min(end, t + CHUNK_SEC)
            st, steps = parse(self._get(t, t1))
            if st.get("lat") is not None:
                self.station.update({k: v for k, v in st.items() if v is not None})
            rows = []
            for ts, params in sorted(steps.items()):
                rec = compact(params)
                if rec:
                    rows.append((self.fmisid, ts, json.dumps(rec, separators=(",", ":"))))
            if rows:
                db.executemany("INSERT OR REPLACE INTO mast_obs (fmisid, ts, data) VALUES (?, ?, ?)", rows)
                db.commit()
                n += len(rows)
            t = t1
            if t < end:
                time.sleep(1.5)                       # be polite to FMI between the pieces
        return n

    def look(self, reason: str = "") -> int:
        """Fetch everything after the newest stored step (at most BACKFILL_DAYS back)."""
        if self.running:
            return 0
        self.running = True
        now = time.time()
        try:
            db = self.get_db()
            last = self.newest(db)
            oldest = (now - self.backfill_days * 86400) // STEP_SEC * STEP_SEC
            start = max(oldest, (last + STEP_SEC) if last else oldest)
            if now - start < STEP_SEC:
                self.last = (now, True, "up to date")
                return 0
            n = self.fetch_range(start, now)
            self.stored_total += n
            self.last = (time.time(), True, f"{n} step(s) stored" + (f" ({reason})" if reason else ""))
            self.last_ok = time.time()
            return n
        except Exception as exc:                       # noqa: BLE001
            log.info("Mast fetch failed: %s", exc)
            self.last = (time.time(), False, f"failed: {exc}")
            return 0
        finally:
            self.running = False

    def status(self, db) -> dict:
        try:
            r = db.execute("SELECT COUNT(*), MIN(ts), MAX(ts) FROM mast_obs WHERE fmisid = ?",
                           (self.fmisid,)).fetchone()
        except Exception:                              # noqa: BLE001
            r = (0, None, None)
        return {"settings": get_settings(db), "fmisid": self.fmisid, "station": self.station,
                "rows": r[0] or 0, "first": r[1], "newest": r[2], "backfill_days": self.backfill_days,
                "last": {"ts": self.last[0], "ok": self.last[1], "text": self.last[2]} if self.last else None,
                "last_ok": self.last_ok, "running": self.running}

    def run(self) -> None:
        time.sleep(STARTUP_DELAY_SEC)
        try:
            self.ensure_table(self.get_db())
        except Exception as exc:                       # noqa: BLE001
            log.warning("Mast table: %s", exc)
        first = True
        while True:
            try:
                on = get_settings(self.get_db())["enabled"]
            except Exception:                          # noqa: BLE001
                on = True
            if on:
                n = self.look("start" if first else "")
                if first:
                    log.info("Kivenlahti mast: %d step(s) back-filled", n)
                first = False
            now = time.time()
            nxt = (now - LOOK_OFFSET_SEC) // STEP_SEC * STEP_SEC + STEP_SEC + LOOK_OFFSET_SEC
            time.sleep(max(30.0, nxt - now))


_instance: MastFetcher | None = None


def init(cfg, get_db) -> MastFetcher:
    global _instance
    _instance = MastFetcher(get_db, int(getattr(cfg, "MAST_FMISID", FMISID)),
                            float(getattr(cfg, "MAST_BACKFILL_DAYS", BACKFILL_DAYS)))
    return _instance


def get() -> MastFetcher | None:
    return _instance


# ── read side (web/api/mast.py uses these) ────────────────────────────────────

def rows(db, start: float, end: float, fmisid: int = FMISID) -> list:
    """[(ts, record)] for start ≤ ts ≤ end, oldest first."""
    out = []
    try:
        for ts, data in db.execute("SELECT ts, data FROM mast_obs WHERE fmisid = ? AND ts >= ? AND ts <= ? ORDER BY ts",
                                   (fmisid, int(start), int(end))):
            try:
                out.append((ts, json.loads(data)))
            except ValueError:
                continue
    except Exception:                                  # noqa: BLE001  (table missing)
        pass
    return out


def uv(spd, d):
    """(u, v) of a wind (from direction d) — None when missing."""
    if spd is None or d is None:
        return None
    r = math.radians(d)
    return -spd * math.sin(r), -spd * math.cos(r)


def wind_of(u, v):
    return math.hypot(u, v), (math.degrees(math.atan2(-u, -v)) + 360) % 360


def hourly(db, start: float, end: float, fmisid: int = FMISID) -> list:
    """Hour means [h, h + 1 h): temperature, RH, dewpoint per level, the vector
    mean wind (kt, °) and the highest gust (kt) per wind level; n = steps."""
    hs: dict = {}
    for ts, r in rows(db, start // 3600 * 3600, end, fmisid):
        hs.setdefault(ts // 3600 * 3600, []).append(r)
    out = []
    for h in sorted(hs):
        rs = hs[h]
        tl, wl = rs[-1].get("tl") or [], rs[-1].get("wl") or []
        rec = {"ts": h, "n": len(rs), "tl": tl, "wl": wl}
        for k in ("t", "rh", "td"):
            vals = []
            for i in range(len(tl)):
                xs = [r[k][i] for r in rs if r.get("tl") == tl and i < len(r.get(k) or []) and r[k][i] is not None]
                vals.append(round(sum(xs) / len(xs), 2) if xs else None)
            rec[k] = vals
        ws, wd, wg = [], [], []
        for i in range(len(wl)):
            us = [uv(r["ws"][i], r["wd"][i]) for r in rs if r.get("wl") == wl and i < len(r.get("ws") or [])]
            us = [x for x in us if x is not None]
            if us:
                s, d = wind_of(sum(x[0] for x in us) / len(us), sum(x[1] for x in us) / len(us))
                ws.append(round(s / KT_MS, 1)); wd.append(round(d))
            else:
                ws.append(None); wd.append(None)
            gs = [r["wg"][i] for r in rs if r.get("wl") == wl and i < len(r.get("wg") or []) and r["wg"][i] is not None]
            wg.append(round(max(gs) / KT_MS, 1) if gs else None)
        rec["ws"], rec["wd"], rec["wg"] = ws, wd, wg
        out.append(rec)
    return out
