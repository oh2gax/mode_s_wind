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
      t8  temperature at 850 hPa, °C × 10 (from 2026-11-07; the meteograms' 850 hPa line)
      (from 2026-11-07 afternoon, the meteograms' extra options:)
      td  2 m dew point °C × 10                     DPT 2 m
      vi  visibility, units of 100 m (500-m steps)  VIS surface
      zl  freezing level, m above sea level (50 m)  HGT highest tropospheric freezing level
      ca  CAPE, J/kg (10 J/kg steps)                CAPE surface
      u8, v8  850 hPa wind towards east / north, kt (2-kt steps)   UGRD / VGRD 850 mb
                                                    TMP 850 mb (the request then also brings
                                                    UGRD / VGRD / HGT at 850 mb, not used yet)
      (no fog: GFS has no fog field)
  meta {"proj": "latlon", "x": [lon0, 0.25, nx], "y": [lat0, 0.25, ny], "f": fields, "pi": 1|3}
  gfs_runs      the run being fetched: its start, the hours done, the APCP total of the
                last hour done (for the next difference), state

A newer run replaces the rows hour by hour as it arrives (the hours it has
not reached yet stay from the run before); rows older than the hour before
the current one are deleted at each look.  About 156 kB per hour, about
33 MB per run in the file (about 45 MB from 2026-11-07 with the meteograms' extra fields).
Download about 160 MB per run (about 250 MB from 2026-11-07; 320 MB a day for
two runs).

The forecast at the airport, kept for the skill check (from 2026-11-06,
collector/gfs_skill.py): every fetched hour also gives one row of table
fc_points — model "gfs", run, lead, valid time and the values at the
airport's 0.25° cell (the meteogram's cell) in plain units (°C, hPa, kt,
mm/h, %, m).  MEPS adds its main runs at the airport's 2.5 km cell the same
way (collector/meps.py, model "meps").  Kept GFS_SKILL_DAYS (90).  So that
results come at once, the runs NOAA still holds (about the last 10 days,
GFS_SKILL_BACKFILL_DAYS; 0 = off) are fetched once for that one cell — a
3 × 3-cell request for every 3rd hour, 2 s apart — while the newest run is complete
(table gfs_point_runs: each run's progress; "live" = the newest runs, from
the regular fetch).

On / off: GFS_WX = True in config_local.py (off by default — the home station
fetches nothing; on the cloud server only), then "gfs_enabled" on the
Maintenance page (on by default).  Nothing else depends on it.

Optional config keys (read with defaults):
  GFS_WX = False                  fetch GFS for the Weather pages
  GFS_DB_PATH = data/gfs_wx.db    (next to DB_PATH)
  GFS_RUNS = (0, 12)              the runs fetched (UTC hours)
  GFS_MAX_H = 384                 the longest lead fetched
  GFS_BOX = (45, 75, -15, 45)     lat0, lat1, lon0, lon1 (°; lon0 may be negative)
  GFS_SKILL_DAYS = 90             the airport forecasts kept for the skill check
  GFS_SKILL_BACKFILL_DAYS = 10    the earlier runs fetched once for the airport cell (0 = off)
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
FIELDS = ("p", "r", "s", "c", "l", "m", "h", "b", "u", "v", "g", "t", "t8", "td", "vi", "zl", "ca", "u8", "v8")
SKILL_DAYS = 90
SKILL_BACKFILL_DAYS = 10
BACKFILL_BUDGET_SEC = 480              # at most this long per look, after the newest run is complete
POINT_COLS = ("t", "p", "u", "v", "g", "r", "s", "c", "b", "pi")
SOURCE = "GFS (NOAA/NCEP)"

# the GRIB filter request: every variable at every level listed (it combines them);
# a few records come along that are not used (interval-mean clouds, TMP surface, the APCP bucket)
_VARS = ("PRMSL", "TMP", "UGRD", "VGRD", "GUST", "APCP", "CPOFP", "TCDC", "LCDC", "MCDC", "HCDC", "HGT")
_LEVS = ("mean_sea_level", "2_m_above_ground", "10_m_above_ground", "surface", "entire_atmosphere",
         "low_cloud_layer", "middle_cloud_layer", "high_cloud_layer", "cloud_ceiling")
_LEV_850 = "850_mb"         # the main fetch only (from 2026-11-07), not the skill back-fill of one cell
# the meteograms' extra options (from 2026-11-07 afternoon), main fetch only as well
_VARS_MORE = ("DPT", "VIS", "CAPE")
_LEVS_MORE = ("highest_tropospheric_freezing_level",)

# (discipline, category, number, level type, level value) → name, instantaneous records
_INST = {(0, 3, 1, 101, 0): "PRMSL", (0, 0, 0, 103, 2): "T2", (0, 2, 2, 103, 10): "U10",
         (0, 2, 3, 103, 10): "V10", (0, 2, 22, 1, 0): "GUST", (0, 1, 39, 1, 0): "CPOFP",
         (0, 6, 1, 10, 0): "TCDC", (0, 6, 3, 214, 0): "LCDC", (0, 6, 4, 224, 0): "MCDC",
         (0, 6, 5, 234, 0): "HCDC", (0, 3, 5, 215, 0): "CEIL", (0, 3, 5, 1, 0): "OROG",
         (0, 0, 0, 100, 85000): "T850",
         (0, 0, 6, 103, 2): "TD2", (0, 19, 0, 1, 0): "VIS", (0, 7, 6, 1, 0): "CAPE",
         (0, 3, 5, 204, 0): "ZL", (0, 2, 2, 100, 85000): "U850", (0, 2, 3, 100, 85000): "V850"}
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
                 updated INTEGER NOT NULL)""",
          # the forecasts at the airport for the skill check (from 2026-11-06; collector/gfs_skill.py)
          """CREATE TABLE IF NOT EXISTS fc_points (
                 model TEXT    NOT NULL,     -- gfs / meps
                 run   INTEGER NOT NULL,
                 lead  INTEGER NOT NULL,
                 ts    INTEGER NOT NULL,     -- valid time
                 t REAL, p REAL,             -- 2 m temperature °C, sea-level pressure hPa
                 u REAL, v REAL, g REAL,     -- 10 m wind towards east / north, gust: kt
                 r REAL, s REAL,             -- precipitation / its snow part, mm per hour (mean of the step)
                 c REAL, b REAL,             -- total cloud %, cloud base / ceiling m
                 pi INTEGER,                 -- the hours of the precipitation step (1, 3)
                 PRIMARY KEY (model, run, lead))""",
          "CREATE INDEX IF NOT EXISTS fc_points_ts ON fc_points (ts)",
          """CREATE TABLE IF NOT EXISTS gfs_point_runs (
                 run   INTEGER PRIMARY KEY,
                 done  INTEGER NOT NULL,     -- the last lead stored (−1: none yet)
                 apcp  REAL,                 -- the APCP total of that lead at the cell
                 state TEXT    NOT NULL,     -- live / fetching / complete / missing
                 updated INTEGER NOT NULL)""")


# ── the forecast at the airport (fc_points; from 2026-11-06) ─────────────────

_place: tuple | None = None          # (lat, lon) of the airport


def place():
    return _place


def store_point(db, model: str, run: int, lead: int, ts: int, vals: dict) -> None:
    """One forecast hour at the airport (plain units, None = missing)."""
    db.execute("INSERT OR REPLACE INTO fc_points (model, run, lead, ts, " + ", ".join(POINT_COLS) + ") "
               "VALUES (?, ?, ?, ?" + ", ?" * len(POINT_COLS) + ")",
               (model, int(run), int(lead), int(ts)) + tuple(vals.get(k) for k in POINT_COLS))


def point_of(P: dict, k: int) -> dict:
    """The values of grid index k from planes_of() in plain units."""
    def g(f, scale=1.0, off=0.0):
        a = P.get(f)
        if a is None or k >= len(a) or a[k] == FILL:
            return None
        return off + a[k] / scale
    return {"t": g("t", 10.0), "p": g("p", 10.0, 1000.0), "u": g("u"), "v": g("v"), "g": g("g"),
            "r": g("r", 100.0), "s": g("s", 100.0), "c": g("c"), "b": g("b")}


def cell_index(r0, lat: float, lon: float):
    """Grid index of the 0.25° cell nearest (lat, lon) in a record's grid (None outside)."""
    lon0 = r0.lo1 - 360.0 if r0.lo1 > 180.0 else r0.lo1
    i, j = round((lon - lon0) / r0.di), round((lat - r0.la1) / r0.dj)
    if 0 <= i < r0.ni and 0 <= j < r0.nj:
        return j * r0.ni + i
    return None


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
    if "T850" in g:                                  # from 2026-11-07
        P["t8"] = _scale(g["T850"], lambda x: (x - 273.15) * 10.0)
    # the meteograms' extra options (from 2026-11-07 afternoon)
    if "TD2" in g:
        P["td"] = _scale(g["TD2"], lambda x: (x - 273.15) * 10.0)
    if "VIS" in g:
        P["vi"] = _scale(g["VIS"], lambda x: round(min(x, 30000.0) / 500.0) * 5.0)      # 500-m steps
    if "ZL" in g:
        P["zl"] = _scale(g["ZL"], lambda x: round(max(0.0, x) / 50.0) * 50.0)           # 50-m steps
    if "CAPE" in g:
        P["ca"] = _scale(g["CAPE"], lambda x: round(max(0.0, x) / 10.0) * 10.0)         # 10-J/kg steps
    if "U850" in g and "V850" in g:
        P["u8"] = _scale(g["U850"], lambda x: round(x / KT_MS / 2.0) * 2.0)            # 2-kt steps
        P["v8"] = _scale(g["V850"], lambda x: round(x / KT_MS / 2.0) * 2.0)
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
        self.skill_days = float(getattr(cfg, "GFS_SKILL_DAYS", SKILL_DAYS))
        self.backfill_days = float(getattr(cfg, "GFS_SKILL_BACKFILL_DAYS", SKILL_BACKFILL_DAYS))
        self.backfill = None             # {"run", "done", "state"} of the run being back-filled
        self.running = False
        self.last = None                 # (time, ok, text)
        self.cur = None                  # {"run", "done", "state"} of the run being worked on
        self.bytes_total = 0
        self.files_total = 0
        self.errors = 0
        self._lock = threading.Lock()

    # the request
    def _query(self, run: int, lead: int, box=None) -> str:
        d = time.strftime("%Y%m%d", time.gmtime(run))
        hh = time.strftime("%H", time.gmtime(run))
        la0, la1, lo0, lo1 = box or self.box
        q = [("dir", f"/gfs.{d}/{hh}/atmos"), ("file", f"gfs.t{hh}z.pgrb2.0p25.f{lead:03d}")]
        levs = _LEVS + ((_LEV_850,) + _LEVS_MORE if box is None else ())
        vs = _VARS + (_VARS_MORE if box is None else ())
        q += [(f"var_{v}", "on") for v in vs] + [(f"lev_{lv}", "on") for lv in levs]
        q += [("subregion", ""), ("toplat", f"{la1:g}"), ("leftlon", f"{lo0:g}"),
              ("rightlon", f"{lo1:g}"), ("bottomlat", f"{la0:g}")]
        return self.url + "?" + urllib.parse.urlencode(q)

    def _get(self, run: int, lead: int, box=None):
        """The GRIB bytes of one hour, or None when NOAA does not have it (yet)."""
        req = urllib.request.Request(self._query(run, lead, box), headers={"User-Agent": "MODE-S-Wind/1.0 (GFS viewer)"})
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
        db.execute("DELETE FROM fc_points WHERE ts < ?", (int(now - self.skill_days * 86400),))
        db.execute("DELETE FROM gfs_point_runs WHERE run < ?", (int(now - (self.skill_days + 20) * 86400),))
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
                # the newest run is in: time for the earlier runs at the airport (skill check)
                self._backfill_step(db, run, now)
                return 0
            done, prev, _ = row if row else (-1, None, "fetching")
            if _place:                                 # the airport's forecast comes with this run's hours
                db.execute("INSERT OR IGNORE INTO gfs_point_runs (run, done, apcp, state, updated) "
                           "VALUES (?, -1, NULL, 'live', ?)", (run, int(now)))
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
                if _place:                             # the airport's cell (skill check)
                    k = cell_index(r0, _place[0], _place[1])
                    if k is not None:
                        store_point(db, "gfs", run, lead, ts, dict(point_of(P, k), pi=step_h))
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

    # the earlier runs at the airport (once, for the skill check; from 2026-11-06)
    def _backfill_step(self, db, live_run: int, now: float) -> int:
        """Fetch, for the airport cell only, the hours of the runs of the last
        backfill_days that have no airport forecast yet — every 3rd hour (+0, +3 …
        +384: 129 requests a run; the precipitation then as the mean of the 3 h) —
        oldest first, for at most BACKFILL_BUDGET_SEC.  A run NOAA no longer has
        is marked "missing"."""
        if not _place or self.backfill_days <= 0:
            return 0
        la, lo = _place
        box = (round(la * 4) / 4 - 0.25, round(la * 4) / 4 + 0.25, round(lo * 4) / 4 - 0.25, round(lo * 4) / 4 + 0.25)
        day = int(now // 86400 * 86400)
        first = int(now - self.backfill_days * 86400)
        cands = sorted(d + h * 3600 for d in range(day - int(self.backfill_days + 1) * 86400, day + 86400, 86400)
                       for h in self.runs)
        cands = [r for r in cands if first <= r < live_run]
        state = {r: (d, a, st) for r, d, a, st in db.execute(
            "SELECT run, done, apcp, state FROM gfs_point_runs WHERE run >= ?", (first - 86400,))}
        todo = [r for r in cands if state.get(r, (None, None, "fetching"))[2] == "fetching"]
        if not todo:
            self.backfill = None
            return 0
        t_end = time.time() + BACKFILL_BUDGET_SEC
        n = 0
        bleads = [h for h in self.leads if h % 3 == 0]
        for run in todo:
            done, prev_tot, _ = state.get(run, (-1, None, "fetching"))
            for lead in [h for h in bleads if h > done]:
                if time.time() > t_end:
                    return n
                body = self._get(run, lead, box)
                if body is None:
                    if lead == 0 or done < 0:          # NOAA no longer has this run
                        db.execute("INSERT OR REPLACE INTO gfs_point_runs (run, done, apcp, state, updated) "
                                   "VALUES (?, -1, NULL, 'missing', ?)", (run, int(time.time())))
                        db.commit()
                        break
                    return n                           # a gap: the next look
                self.files_total += 1
                pos = bleads.index(lead)
                step_h = lead - bleads[pos - 1] if pos > 0 else 1
                recs = grib2.records(body, lambda r: (r.pdt == 0 and r.key in _INST)
                                     or (r.pdt == 8 and r.key == _APCP and r.ft == 0))
                r0 = next(r for r in recs if r.values is not None)
                k = cell_index(r0, la, lo) if r0.scan & 0x40 else None
                if k is None:
                    raise grib2.Grib2Error("airport cell not in the back-fill box")
                npts = r0.ni * r0.nj
                prev = None if lead == 0 else ([prev_tot] * npts if prev_tot is not None else None)
                P, apcp = planes_of(recs, prev, step_h)
                store_point(db, "gfs", run, lead, run + lead * 3600, dict(point_of(P, k), pi=step_h))
                tot = apcp[k] if apcp and k < len(apcp) else None
                prev_tot = tot if tot is not None else (0.0 if lead == 0 else None)
                done = lead
                st = "complete" if lead == bleads[-1] else "fetching"
                db.execute("INSERT OR REPLACE INTO gfs_point_runs (run, done, apcp, state, updated) VALUES (?, ?, ?, ?, ?)",
                           (run, lead, prev_tot, st, int(time.time())))
                db.commit()
                n += 1
                self.backfill = {"run": run, "done": lead, "state": st, "left": len(todo) - todo.index(run) - 1}
                if st == "complete":
                    log.info("GFS skill: run %s UTC fetched for the airport (back-fill, %d run(s) left)",
                             time.strftime("%d.%m. %H", time.gmtime(run)), len(todo) - todo.index(run) - 1)
                time.sleep(PAUSE_SEC)
        self.backfill = None
        return n

    def status(self, main_db) -> dict:
        out = {"settings": get_settings(main_db), "configured": True, "runs": list(self.runs),
               "max_h": self.max_h, "box": list(self.box), "files_per_run": len(self.leads),
               "running": self.running, "cur": self.cur, "bytes_total": self.bytes_total,
               "files_total": self.files_total, "errors": self.errors, "db_path": os.path.basename(_db_path or ""),
               "backfill": self.backfill,
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
            q = db.execute("SELECT COUNT(*), COUNT(DISTINCT run), MIN(run) FROM fc_points WHERE model = 'gfs'").fetchone()
            b = db.execute("SELECT SUM(state = 'complete'), SUM(state = 'fetching'), SUM(state = 'missing') "
                           "FROM gfs_point_runs").fetchone()
            out["skill"] = {"points": q[0] or 0, "runs": q[1] or 0, "first_run": q[2],
                            "meps_points": db.execute("SELECT COUNT(*) FROM fc_points WHERE model = 'meps'").fetchone()[0],
                            "backfill_days": self.backfill_days, "backfilled": b[0] or 0, "backfill_open": b[1] or 0,
                            "missing": b[2] or 0}
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
    global _instance, _db_path, _place
    if not bool(getattr(cfg, "GFS_WX", False)):
        return None
    _db_path = db_path_of(cfg)
    _place = (float(cfg.WINDSHEAR_AIRPORT_LAT), float(cfg.WINDSHEAR_AIRPORT_LON))
    get_gfs_db()                                       # create the tables
    _instance = GfsFetcher(cfg, get_main_db)
    return _instance


def get() -> GfsFetcher | None:
    return _instance


def configured() -> bool:
    return _db_path is not None
