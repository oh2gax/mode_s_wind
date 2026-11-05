"""
collector/gfs.py — the GFS forecast for the Weather pages (from 2026-11-05).

For viewing only: the long-range forecast (to +384 h, 16 days) of NOAA's
Global Forecast System on the Weather page and the phone's Weather view.
Nothing in MODE-S Wind's analysis uses it.

Source: NOAA/NCEP NOMADS, the GRIB filter for the 0.25° GFS
(https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl; NOMADS ended its
OPeNDAP service in February 2026).  One request per forecast hour returns
the needed fields over a lat / lon box as GRIB2 in simple packing (about
0.76 MB for the default box; collector/grib2.py reads it in about 0.1 s).
US government data, public domain; credited as "GFS (NOAA/NCEP)".

The runs: GFS_RUNS (00 and 12 UTC by default) — about 3.5 h after its start
a run's first hours appear and about 5 h after it the last (+384 h).  Hours
+0 … +120 come hourly, +123 … +384 every 3 h: 209 files a run.  The thread
looks every 10 minutes for the newest run of GFS_RUNS that has started at
least 3 h 20 min ago and fetches its hours in order, from the hour before the
current one (no history is kept), 2 s apart (NOMADS asks users not to
hammer it); a file not there yet is tried again at the next look.  A run in
progress is resumed after a restart (table gfs_runs).

What is stored (its own SQLite file GFS_DB_PATH, data/gfs_wx.db by default —
so the forecast does not enlarge the main database or its backups):
  gfs_wx_hours  one row per valid hour (ts primary key): run, lead and the
                fields as compressed int16 planes, in the encoding of the
                MEPS weather maps (web/api/weather.py):
      p  sea-level pressure (hPa − 1000) × 10       PRMSL
      t  2 m temperature °C × 10                    TMP 2 m
      u, v  10 m wind towards east / north, kt      UGRD / VGRD 10 m
      g  gust, kt                                   GUST surface
      c, l, m, h  total / low / middle / high cloud %   TCDC / LCDC / MCDC / HCDC (instantaneous)
      b  cloud ceiling above the ground, m (missing = no ceiling)
                                                    HGT cloud ceiling − HGT surface
      r, s  all precipitation / its snow part, mm per hour × 100 (as MEPS's r / s;
            the mean of the step: the hour, or the 3 h after +120 h; meta "pi" = 1 / 3)
            APCP total since the run start, differences of consecutive hours; the snow
            part by CPOFP (% frozen; where it is undefined — no precipitation in the
            model's own scheme — by the 2 m temperature: snow at +0.5 °C or colder)
      (no fog: GFS has no fog field)
  meta {"proj": "latlon", "x": [lon0, 0.25, nx], "y": [lat0, 0.25, ny], "f": fields, "pi": 1|3}
  gfs_runs      the run being fetched: its start, the hours done, the APCP total of the
                last hour done (for the next difference), state

A newer run replaces the rows hour by hour as it arrives (the hours it has
not reached yet stay from the run before); rows older than the hour before
the current one are deleted at each look.  About 156 kB per hour, about
33 MB per run in the file.  Download about 160 MB per run (320 MB a day for
two runs).

On / off: GFS_WX = True in config_local.py (off by default — the home station
fetches nothing; on the cloud server only), then "gfs_enabled" on the
Maintenance page (on by default).  Nothing else depends on it.

Optional config keys (read with defaults):
  GFS_WX = False                  fetch GFS for the Weather pages
  GFS_DB_PATH = data/gfs_wx.db    (next to DB_PATH)
  GFS_RUNS = (0, 12)              the runs fetched (UTC hours)
  GFS_MAX_H = 384                 the longest lead fetched
  GFS_BOX = (45, 75, -15, 45)     lat0, lat1, lon0, lon1 (°; lon0 may be negative)
"""

from __future__ import annotations

import array
import json
import logging
import os
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib

from collector import grib2

log = logging.getLogger("modes.gfs")

FILTER_URL = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"
RUNS = (0, 12)
MAX_H = 384
BOX = (45.0, 75.0, -15.0, 45.0)
READY_AFTER_SEC = 3 * 3600 + 20 * 60   # a run's first files appear about 3.5 h after its start
GIVE_UP_SEC = 12 * 3600                # a run not complete after 12 h: on to the next one
LOOK_SEC = 600
STARTUP_DELAY_SEC = 60
PAUSE_SEC = 2.0
TIMEOUT_SEC = 120
FILL = -32768
KT_MS = 0.514444
FIELDS = ("p", "r", "s", "c", "l", "m", "h", "b", "u", "v", "g", "t")
SOURCE = "GFS (NOAA/NCEP)"

# the GRIB filter request: every variable at every level listed (it combines them);
# a few records come along that are not used (interval-mean clouds, TMP surface, the APCP bucket)
_VARS = ("PRMSL", "TMP", "UGRD", "VGRD", "GUST", "APCP", "CPOFP", "TCDC", "LCDC", "MCDC", "HCDC", "HGT")
_LEVS = ("mean_sea_level", "2_m_above_ground", "10_m_above_ground", "surface", "entire_atmosphere",
         "low_cloud_layer", "middle_cloud_layer", "high_cloud_layer", "cloud_ceiling")

# (discipline, category, number, level type, level value) → name, instantaneous records
_INST = {(0, 3, 1, 101, 0): "PRMSL", (0, 0, 0, 103, 2): "T2", (0, 2, 2, 103, 10): "U10",
         (0, 2, 3, 103, 10): "V10", (0, 2, 22, 1, 0): "GUST", (0, 1, 39, 1, 0): "CPOFP",
         (0, 6, 1, 10, 0): "TCDC", (0, 6, 3, 214, 0): "LCDC", (0, 6, 4, 224, 0): "MCDC",
         (0, 6, 5, 234, 0): "HCDC", (0, 3, 5, 215, 0): "CEIL", (0, 3, 5, 1, 0): "OROG"}
_APCP = (0, 1, 8, 1, 0)

SCHEMA = ("""CREATE TABLE IF NOT EXISTS gfs_wx_hours (
                 ts   INTEGER PRIMARY KEY,   -- valid time (UTC hour)
                 run  INTEGER NOT NULL,      -- run start
                 lead INTEGER NOT NULL,      -- hours after it
                 meta TEXT    NOT NULL,      -- {"proj": "latlon", "x": [lon0, d, nx], "y": [lat0, d, ny], "f": fields, "pi": h}
                 data BLOB    NOT NULL)""",
          """CREATE TABLE IF NOT EXISTS gfs_runs (
                 run   INTEGER PRIMARY KEY,
                 done  INTEGER NOT NULL,     -- the last lead stored (−1: none yet)
                 apcp  BLOB,                 -- its APCP total (int32 × 100, zlib) for the next difference
                 state TEXT    NOT NULL,     -- fetching / complete / abandoned
                 updated INTEGER NOT NULL)""")


def leads(max_h: int = MAX_H) -> list:
    return [h for h in range(0, min(120, max_h) + 1)] + [h for h in range(123, max_h + 1, 3)]


# ── settings (maintenance_config of the main database) ────────────────────────

def get_settings(conn) -> dict:
    try:
        r = conn.execute("SELECT value FROM maintenance_config WHERE key = 'gfs_enabled'").fetchone()
    except Exception:                                  # noqa: BLE001  (old database)
        r = None
    return {"enabled": (r[0] if r else "1") == "1"}          # on by default (when GFS_WX is on)


def set_settings(conn, enabled=None) -> dict:
    if enabled is not None:
        conn.execute("INSERT OR REPLACE INTO maintenance_config (key, value) VALUES ('gfs_enabled', ?)",
                     ("1" if enabled else "0",))
        conn.commit()
    return get_settings(conn)


# ── its own database file ─────────────────────────────────────────────────────

_local = threading.local()
_db_path: str | None = None


def db_path_of(cfg) -> str:
    p = getattr(cfg, "GFS_DB_PATH", None)
    if p:
        return str(p)
    return os.path.join(os.path.dirname(os.path.abspath(str(cfg.DB_PATH))), "gfs_wx.db")


def get_gfs_db():
    """The thread's connection to the GFS file (None when GFS is not configured)."""
    if not _db_path:
        return None
    c = getattr(_local, "conn", None)
    if c is None:
        c = sqlite3.connect(_db_path, check_same_thread=False, timeout=15.0)
        c.execute("PRAGMA journal_mode = WAL")
        c.execute("PRAGMA synchronous = NORMAL")
        for s in SCHEMA:
            c.execute(s)
        c.commit()
        _local.conn = c
    return c


# ── one forecast hour ─────────────────────────────────────────────────────────

def _scale(vals, f):
    out = array.array("h")
    ap = out.append
    for v in vals:
        if v is None:
            ap(FILL)
        else:
            x = round(f(v))
            ap(FILL if x <= FILL or x > 32767 else x)
    return out


def planes_of(recs: list, prev_apcp, step_h: int):
    """The GRIB records of one hour → ({field: array('h')}, APCP total list).
    prev_apcp: the APCP total (mm) of the previous lead (None at +0)."""
    g, apcp = {}, None
    for r in recs:
        if r.values is None:
            continue
        if r.pdt == 0 and r.key in _INST:
            g[_INST[r.key]] = r.values
        elif r.pdt == 8 and r.key == _APCP and r.ft == 0:
            apcp = r.values                          # the total since the run start
    need = ("PRMSL", "T2", "U10", "V10", "GUST", "TCDC", "LCDC", "MCDC", "HCDC")
    missing = [k for k in need if k not in g]
    if missing:
        raise grib2.Grib2Error("records missing: " + ", ".join(missing))
    P = {"p": _scale(g["PRMSL"], lambda x: (x / 100.0 - 1000.0) * 10.0),
         "t": _scale(g["T2"], lambda x: (x - 273.15) * 10.0),
         "u": _scale(g["U10"], lambda x: x / KT_MS),
         "v": _scale(g["V10"], lambda x: x / KT_MS),
         "g": _scale(g["GUST"], lambda x: x / KT_MS),
         "c": _scale(g["TCDC"], float), "l": _scale(g["LCDC"], float),
         "m": _scale(g["MCDC"], float), "h": _scale(g["HCDC"], float)}
    if "CEIL" in g and "OROG" in g:
        P["b"] = _scale([None if c is None or z is None or c >= 15000 else max(0.0, c - z)
                         for c, z in zip(g["CEIL"], g["OROG"])], float)
    if apcp is not None and prev_apcp is not None and len(prev_apcp) == len(apcp):
        cp = g.get("CPOFP") or [None] * len(apcp)
        T = g["T2"]
        rain, snow = [], []
        for a, b, c, t in zip(apcp, prev_apcp, cp, T):
            if a is None or b is None:
                rain.append(None); snow.append(None)
                continue
            mmh = max(0.0, a - b) / step_h
            if c is not None and c >= 0:
                fr = min(1.0, c / 100.0)
            else:
                fr = 1.0 if t is not None and t <= 273.65 else 0.0
            rain.append(mmh * 100.0)                 # all of it, as MEPS's r
            snow.append(mmh * fr * 100.0)            # its frozen part
        P["r"] = _scale(rain, float)
        P["s"] = _scale(snow, float)
    return P, apcp


def _pack_planes(P: dict) -> tuple:
    fields = [f for f in FIELDS if f in P]
    a = array.array("h")
    for f in fields:
        a.extend(P[f])
    if sys.byteorder != "little":
        a.byteswap()
    return fields, zlib.compress(a.tobytes(), 6)


def _pack_apcp(vals) -> bytes:
    a = array.array("i", (-1 if v is None else int(round(v * 100)) for v in vals))
    if sys.byteorder != "little":
        a.byteswap()
    return zlib.compress(a.tobytes(), 6)


def _unpack_apcp(blob):
    if not blob:
        return None
    a = array.array("i")
    a.frombytes(zlib.decompress(blob))
    if sys.byteorder != "little":
        a.byteswap()
    return [None if v < 0 else v / 100.0 for v in a]


# ── the fetcher ───────────────────────────────────────────────────────────────

class GfsFetcher:
    def __init__(self, cfg, get_main_db):
        self.get_main_db = get_main_db
        self.runs = tuple(int(h) for h in (getattr(cfg, "GFS_RUNS", RUNS) or RUNS))
        self.max_h = int(getattr(cfg, "GFS_MAX_H", MAX_H))
        b = tuple(float(x) for x in (getattr(cfg, "GFS_BOX", BOX) or BOX))
        self.box = b                     # lat0, lat1, lon0, lon1
        self.url = str(getattr(cfg, "GFS_FILTER_URL", FILTER_URL))
        self.leads = leads(self.max_h)
        self.running = False
        self.last = None                 # (time, ok, text)
        self.cur = None                  # {"run", "done", "state"} of the run being worked on
        self.bytes_total = 0
        self.files_total = 0
        self.errors = 0
        self._lock = threading.Lock()

    # the request
    def _query(self, run: int, lead: int) -> str:
        d = time.strftime("%Y%m%d", time.gmtime(run))
        hh = time.strftime("%H", time.gmtime(run))
        la0, la1, lo0, lo1 = self.box
        q = [("dir", f"/gfs.{d}/{hh}/atmos"), ("file", f"gfs.t{hh}z.pgrb2.0p25.f{lead:03d}")]
        q += [(f"var_{v}", "on") for v in _VARS] + [(f"lev_{lv}", "on") for lv in _LEVS]
        q += [("subregion", ""), ("toplat", f"{la1:g}"), ("leftlon", f"{lo0:g}"),
              ("rightlon", f"{lo1:g}"), ("bottomlat", f"{la0:g}")]
        return self.url + "?" + urllib.parse.urlencode(q)

    def _get(self, run: int, lead: int):
        """The GRIB bytes of one hour, or None when NOAA does not have it (yet)."""
        req = urllib.request.Request(self._query(run, lead), headers={"User-Agent": "MODE-S-Wind/1.0 (GFS viewer)"})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as r:
                body = r.read()
        except urllib.error.HTTPError as exc:
            if exc.code in (403, 404):
                return None
            raise
        self.bytes_total += len(body)
        if body[:4] != b"GRIB":
            return None                              # the filter's "data file is not present" page
        return body

    # the database
    def _run_row(self, db, run: int):
        r = db.execute("SELECT done, apcp, state FROM gfs_runs WHERE run = ?", (run,)).fetchone()
        return (r[0], _unpack_apcp(r[1]), r[2]) if r else None

    def _target(self, now: float):
        """The newest run of self.runs that has started at least READY_AFTER_SEC ago."""
        day = int(now // 86400 * 86400)
        cands = [day - 86400 + h * 3600 for h in self.runs] + [day + h * 3600 for h in self.runs]
        ok = [c for c in cands if c <= now - READY_AFTER_SEC]
        return max(ok) if ok else None

    def _purge(self, db, now: float) -> int:
        cut = int(now // 3600 * 3600) - 3600
        n = db.execute("DELETE FROM gfs_wx_hours WHERE ts < ?", (cut,)).rowcount
        db.execute("DELETE FROM gfs_runs WHERE run < ?", (int(now) - 3 * 86400,))
        db.commit()
        return n

    def look(self, reason: str = "") -> int:
        """Fetch what is new of the target run; returns the number of hours stored."""
        with self._lock:
            if self.running:
                return 0
            self.running = True
        now = time.time()
        stored = 0
        try:
            db = get_gfs_db()
            self._purge(db, now)
            run = self._target(now)
            if run is None:
                self.last = (now, True, "no run ready yet")
                return 0
            row = self._run_row(db, run)
            if row and row[2] in ("complete", "abandoned"):
                self.cur = {"run": run, "done": row[0], "state": row[2]}
                self.last = (now, True, f"run {time.strftime('%d.%m. %H', time.gmtime(run))} UTC {row[2]}")
                return 0
            done, prev, _ = row if row else (-1, None, "fetching")
            first_ts = int(now // 3600 * 3600) - 3600
            todo = [h for h in self.leads if h > done]
            if not todo:
                db.execute("UPDATE gfs_runs SET state = 'complete', updated = ? WHERE run = ?", (int(now), run))
                db.commit()
                return 0
            # no history: a lead is stored only from the hour before the current one; a past lead
            # is still fetched (not stored) when it is the one right before the first stored lead —
            # its APCP total gives that lead's precipitation; the leads before it are skipped
            for lead in todo:
                ts = run + lead * 3600
                pos = self.leads.index(lead)
                prev_lead = self.leads[pos - 1] if pos > 0 else None
                nxt_ts = run + self.leads[pos + 1] * 3600 if pos + 1 < len(self.leads) else None
                if nxt_ts is not None and nxt_ts < first_ts:
                    continue
                body = self._get(run, lead)
                if body is None:
                    break                             # not there yet: the next look
                self.files_total += 1
                step_h = lead - prev_lead if prev_lead is not None else 1
                recs = grib2.records(body, lambda r: (r.pdt == 0 and r.key in _INST)
                                     or (r.pdt == 8 and r.key == _APCP and r.ft == 0))
                if prev is None and prev_lead == 0:
                    prev = [0.0] * (recs[0].ni * recs[0].nj)  # the total at +0 is nothing
                P, apcp = planes_of(recs, prev if lead > 0 else None, step_h)
                r0 = next(r for r in recs if r.values is not None)
                lon0 = r0.lo1 - 360.0 if r0.lo1 > 180.0 else r0.lo1
                lat0, dj = (r0.la1, r0.dj) if r0.scan & 0x40 else (r0.la1, -r0.dj)
                if not (r0.scan & 0x40):
                    raise grib2.Grib2Error("north-to-south rows (scan mode) not expected")
                fields, blob = _pack_planes(P)
                meta = {"proj": "latlon", "x": [round(lon0, 4), r0.di, r0.ni], "y": [round(lat0, 4), dj, r0.nj],
                        "f": fields, "pi": step_h}
                if ts >= first_ts:
                    db.execute("INSERT OR REPLACE INTO gfs_wx_hours (ts, run, lead, meta, data) VALUES (?, ?, ?, ?, ?)",
                               (ts, run, lead, json.dumps(meta, separators=(",", ":")), blob))
                    stored += 1
                prev = apcp
                state = "complete" if lead == self.leads[-1] else "fetching"
                db.execute("INSERT OR REPLACE INTO gfs_runs (run, done, apcp, state, updated) VALUES (?, ?, ?, ?, ?)",
                           (run, lead, _pack_apcp(apcp) if apcp else None, state, int(time.time())))
                if state == "complete":                # the run is whole: no hours of older runs left over
                    db.execute("DELETE FROM gfs_wx_hours WHERE run < ?", (run,))
                db.commit()
                self.cur = {"run": run, "done": lead, "state": state}
                if stored and stored % 40 == 0:
                    log.info("GFS run %s UTC: +%d h stored (%d hour(s) this look)",
                             time.strftime("%d.%m. %H", time.gmtime(run)), lead, stored)
                time.sleep(PAUSE_SEC)
            row = self._run_row(db, run)
            if row and row[2] == "fetching" and time.time() - run > GIVE_UP_SEC:
                db.execute("UPDATE gfs_runs SET state = 'abandoned', updated = ? WHERE run = ?", (int(time.time()), run))
                db.commit()
            row = self._run_row(db, run)
            self.cur = {"run": run, "done": row[0] if row else -1, "state": row[2] if row else "waiting"}
            txt = f"run {time.strftime('%d.%m. %H', time.gmtime(run))} UTC: {stored} hour(s) stored" + \
                  (f", +{row[0]} h done" if row else ", not available yet") + (f" ({reason})" if reason else "")
            self.last = (time.time(), True, txt)
            if stored:
                log.info("GFS %s", txt)
            return stored
        except Exception as exc:                       # noqa: BLE001
            self.errors += 1
            log.info("GFS fetch failed: %s", exc)
            self.last = (time.time(), False, f"failed: {exc}")
            return stored
        finally:
            self.running = False

    def status(self, main_db) -> dict:
        out = {"settings": get_settings(main_db), "configured": True, "runs": list(self.runs),
               "max_h": self.max_h, "box": list(self.box), "files_per_run": len(self.leads),
               "running": self.running, "cur": self.cur, "bytes_total": self.bytes_total,
               "files_total": self.files_total, "errors": self.errors, "db_path": os.path.basename(_db_path or ""),
               "last": {"ts": self.last[0], "ok": self.last[1], "text": self.last[2]} if self.last else None}
        try:
            db = get_gfs_db()
            r = db.execute("SELECT COUNT(*), MIN(ts), MAX(ts), COUNT(DISTINCT run) FROM gfs_wx_hours").fetchone()
            out.update(hours=r[0] or 0, first=r[1], last_ts=r[2], n_runs=r[3] or 0)
            if out["cur"] is None:                     # after a restart, before the first look
                q = db.execute("SELECT run, done, state FROM gfs_runs ORDER BY run DESC LIMIT 1").fetchone()
                if q:
                    out["cur"] = {"run": q[0], "done": q[1], "state": q[2]}
            out["db_bytes"] = os.path.getsize(_db_path) if _db_path and os.path.exists(_db_path) else None
        except Exception as exc:                       # noqa: BLE001
            out["db_err"] = str(exc)
        return out

    def run(self) -> None:
        time.sleep(STARTUP_DELAY_SEC)
        first = True
        while True:
            try:
                on = get_settings(self.get_main_db())["enabled"]
            except Exception:                          # noqa: BLE001
                on = True
            if on:
                self.look("start" if first else "")
                first = False
            time.sleep(LOOK_SEC)


_instance: GfsFetcher | None = None


def init(cfg, get_main_db) -> GfsFetcher | None:
    """Set up the GFS file and the fetcher when GFS_WX is on; None otherwise."""
    global _instance, _db_path
    if not bool(getattr(cfg, "GFS_WX", False)):
        return None
    _db_path = db_path_of(cfg)
    get_gfs_db()                                       # create the tables
    _instance = GfsFetcher(cfg, get_main_db)
    return _instance


def get() -> GfsFetcher | None:
    return _instance


def configured() -> bool:
    return _db_path is not None
