"""
collector/meps.py — MEPS model profiles for verification (from 2026-10-22;
model levels from 2026-10-23).

MEPS (MetCoOp Ensemble Prediction System, 2.5 km; run by MET Norway, SMHI,
FMI and others) is the weather model FMI uses.  FMI's own open data has it
only as a surface grid, so the profiles come from MET Norway's open archive
(thredds.met.no, CC BY 4.0).  Every 3 h a new control run (meps_mbr000_…)
appears about 2–3 h after its start time.

What is fetched (plain Python: urllib + the OPeNDAP binary format, no
netCDF / numpy needed), for each run the forecast hours +0 … +5 (model
levels +0 … +6) in a 300 × 300 km box around the receiver sampled every
10 km (31 × 31 points):
  pl  temperature, wind, geopotential, relative and specific humidity on the
      10 standard pressure levels 1000 … 200 hPa (about 1.4 MB per run) —
      the heights of the pressure surfaces and the MEPS check use these;
  ml  temperature, specific humidity and wind on the model's own levels
      (hybrid levels 9 … 64 of 65: 56 levels from about 12 m above the
      ground to about 190 hPa, 25 m apart near the ground, 100 m at 1 km,
      230 m at 3 km, 350 m at 5.5 km and 600–700 m near 200 hPa) and the
      surface pressure (about 6 MB per run, MEPS_MODEL_LEVELS) — the dense
      model profile on the Skew-T.  They appear about 1 h after the
      pressure levels (about 2 h 40 min after the run start).
Together about 60 MB a day; each request is tried three times.

What is stored, one row per valid hour:
  meps_hours     (about 2 kB)
    ts    valid time (UTC hour)          run   run start   lead  hours after it
    data  {"p": [200 … 1000 hPa], "n": points, "rad": km,
           "a": {"t": °C, "u": kt, "v": kt, "z": gpm, "rh": %, "q": g/kg}   area mean
           "j": {…}                                                          at Jokioinen}
  meps_ml_hours  (about 3 kB)
    ts, run, lead as above
    data  {"n": points, "rad": km, "ps": [area, Jokioinen] hPa,
           "a": {"p": hPa, "t": °C, "u": kt, "v": kt, "q": g/kg}  per model level, top down
           "j": {…}}
The area is the sounding radius around the receiver (the same area as the
hourly Mode S profile), "j" the model column at the Jokioinen sounding
station (for the distance check).  A model level follows the ground, so its
area mean is taken on the level and its pressure is the mean pressure of the
level (ap + b · mean surface pressure).  Each hour keeps the shortest lead:
+0 … +2 from its own run (the verification values); the newest run's
+3 … +5 are stored provisionally (shown on the Skew-T as a forecast, not
used in the verification) and replaced when the next run arrives.

Read side: profile() — the model profile at a time for the Skew-T (MEPS tick
box; the model levels when stored, else the 10 pressure levels); check() —
Mode S minus MEPS every hour by pressure level (temperature, wind, heights
of the pressure surfaces) and, at each sounding, how much of the aircraft −
sonde difference is the distance to Jokioinen (MEPS check view).

Optional config keys (read with defaults):
  MEPS_FETCH = True             fetch the model data
  MEPS_MODEL_LEVELS = True      also fetch the model levels (dense Skew-T profile)
  MEPS_BACKFILL_DAYS = 3        days fetched at the first start
  MEPS_URL = "https://thredds.met.no/thredds/dodsC/meps25epsarchive"

Nothing else depends on it: when MET Norway cannot be reached the views say
the data is missing and the rest of the system works as before.
"""

from __future__ import annotations

import array
import http.client
import json
import logging
import math
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from typing import Optional

log = logging.getLogger("modes.meps")

BASE_URL = "https://thredds.met.no/thredds/dodsC/meps25epsarchive"
RUN_STEP_H = 3
LEADS = 6                    # +0 … +5 h; +0 … +2 are the verification values
VERIF_MAX_LEAD = 2
LEV = (3, 12)                # level indices: 200, 250, 300, 400, 500, 700, 800, 850, 925, 1000 hPa
VARS = (("air_temperature_pl", "t"), ("x_wind_pl", "xw"), ("y_wind_pl", "yw"),
        ("geopotential_pl", "z"), ("relative_humidity_pl", "rh"), ("specific_humidity_pl", "q"))
HALF = 60                    # grid cells (× 2.5 km) each side of the receiver
STRIDE = 4                   # every 4th cell: 10 km
CHECK_SEC = 20 * 60          # look for new runs this often
MAX_PER_CYCLE = 8            # runs fetched per look (backfill continues at the next)
RETRY_RECENT_SEC = 30 * 60   # a run not yet published: try again after this
ML_LEADS = 7                 # model levels +0 … +6 h: they appear about 1 h after the pressure
                             # levels, so the extra hour keeps the present hour covered
ML_LEV = (9, 64)             # model (hybrid) levels: about 190 hPa … 12 m above the ground
ML_VARS = (("air_temperature_ml", "t"), ("specific_humidity_ml", "q"),
           ("x_wind_ml", "xw"), ("y_wind_ml", "yw"))
MAP_LEV = (2, 12)            # Wind Map fields: 150, 200, 250, 300, 400, 500, 700, 800, 850, 925, 1000 hPa
MAP_VARS = (("air_temperature_pl", "t"), ("x_wind_pl", "xw"), ("y_wind_pl", "yw"), ("geopotential_pl", "z"))
MAP_HALF = 120               # grid cells (× 2.5 km) each side: ± 300 km
MAP_STRIDE = 8               # every 8th cell: 20 km (31 × 31 points)
MAP_FILL = -32768            # missing value in the stored int16 arrays
WX_VARS = (("air_pressure_at_sea_level", "p"), ("precipitation_amount_acc", "r"),
           ("snowfall_amount_acc", "s"), ("cloud_area_fraction", "c"), ("low_type_cloud_area_fraction", "l"),
           ("medium_type_cloud_area_fraction", "m"), ("high_type_cloud_area_fraction", "h"),
           ("fog_area_fraction", "f"), ("cloud_base_altitude", "b"),
           # 10 m wind (grid x / y components, turned to true north) and the gust (from 2026-10-24)
           ("x_wind_10m", "u"), ("y_wind_10m", "v"), ("wind_speed_of_gust", "g"))
WX_STRIDE = 4                # every 4th cell: 10 km
WX_SHORT, WX_HISTORY = 6, 3  # leads of the other runs (recent / older than 6 h)
WX_CHUNK = 12                # forecast hours per request (the main runs come in 4 pieces, each stored at once)
WX_REFILL_H = 30             # weather-map hours stored without the 10 m wind (before 24 Oct 2026) are
                             # fetched again from the runs of this many hours (once: new rows always have it)
TIMEOUT = {"pl": 120.0, "ml": 240.0, "map": 120.0, "wx": 600.0}
TRIES = 3                    # attempts per request (an empty or cut response is tried again)
JOKIOINEN = (60.81397, 23.49825)
KT = 1 / 0.514444
G0 = 9.80665

# MEPS projection (projection_lambert): Lambert conformal, one standard
# parallel 63.3° N, central meridian 15° E, sphere R = 6 371 km, 2.5 km grid
LCC_LAT1, LCC_LON0, LCC_R, DX = 63.3, 15.0, 6371000.0, 2500.0
_N = math.sin(math.radians(LCC_LAT1))
_F = math.cos(math.radians(LCC_LAT1)) * math.tan(math.pi / 4 + math.radians(LCC_LAT1) / 2) ** _N / _N
_RHO0 = LCC_R * _F / math.tan(math.pi / 4 + math.radians(LCC_LAT1) / 2) ** _N


def lcc_xy(lat: float, lon: float):
    rho = LCC_R * _F / math.tan(math.pi / 4 + math.radians(lat) / 2) ** _N
    th = _N * math.radians(lon - LCC_LON0)
    return rho * math.sin(th), _RHO0 - rho * math.cos(th)


def lcc_latlon(x: float, y: float):
    rho = math.copysign(math.hypot(x, _RHO0 - y), _N)
    th = math.atan2(x, _RHO0 - y)
    lon = LCC_LON0 + math.degrees(th / _N)
    lat = math.degrees(2 * math.atan((LCC_R * _F / rho) ** (1 / _N)) - math.pi / 2)
    return lat, lon


def _km(la1, lo1, la2, lo2) -> float:
    p1, p2 = math.radians(la1), math.radians(la2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lo2 - lo1) / 2) ** 2)
    return 2 * 6371.0 * math.asin(math.sqrt(a))


# ── OPeNDAP (DAP2) binary responses ──────────────────────────────────────────

_DECL = re.compile(r"^\s*(Float32|Float64|Int32|UInt32|Int16|UInt16)\s+([\w.]+)\s*((?:\[[^\]]*\])*)\s*;", re.M)
_TYPES = {"Float32": "f", "Float64": "d", "Int32": "i", "UInt32": "I", "Int16": "i", "UInt16": "I"}


def parse_dods(body: bytes) -> dict:
    """{name: array of values (flattened, C order), …} of a .dods response
    (arrays of the numeric types only; 16-bit integers travel as 32 bits)."""
    k = body.find(b"\nData:\n")
    if k < 0:
        raise ValueError("not an OPeNDAP data response: " + body[:200].decode("utf-8", "replace"))
    dds = body[:k].decode("utf-8", "replace")
    pos = k + 7
    out = {}
    for typ, name, dims in _DECL.findall(dds):
        n = 1
        for d in re.findall(r"=\s*(\d+)\s*\]", dims) or re.findall(r"\[(\d+)\]", dims):
            n *= int(d)
        if dims:
            cnt = int.from_bytes(body[pos:pos + 4], "big")
            pos += 8                                     # the count is sent twice
            if cnt != n:
                raise ValueError(f"{name}: {cnt} values, expected {n}")
        a = array.array(_TYPES[typ])
        size = a.itemsize
        a.frombytes(body[pos:pos + n * size])
        if len(a) != n:
            raise ValueError(f"{name}: response cut short")
        if sys.byteorder == "little":
            a.byteswap()
        pos += n * size
        out[name.split(".")[-1]] = a
    return out


def _get(url: str, timeout: float = 90.0) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "MODE-S-Wind/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _fetch(url: str, cons: str, timeout: float = 120.0, tries: int = TRIES) -> dict:
    """One OPeNDAP data request, parsed; an empty, cut or timed-out response is
    tried again (after 15 s, 30 s).  "Not found" (HTTP 400 / 404) is raised at once."""
    full = url + ".dods?" + urllib.parse.quote(cons, safe=",:.")
    for k in range(tries):
        try:
            return parse_dods(_get(full, timeout))
        except urllib.error.HTTPError as exc:
            if exc.code in (400, 404) or k == tries - 1:
                raise
        except (ValueError, OSError, http.client.HTTPException):
            if k == tries - 1:
                raise
        time.sleep(15 * (k + 1))
    raise RuntimeError("unreachable")


# ── Table ───────────────────────────────────────────────────────────────────

def ensure_table(db) -> None:
    db.execute("""CREATE TABLE IF NOT EXISTS meps_hours (
                      ts   INTEGER PRIMARY KEY,   -- valid time (UTC hour)
                      run  INTEGER NOT NULL,      -- run start (UTC)
                      lead INTEGER NOT NULL,      -- hours after the run start
                      data TEXT    NOT NULL)""")
    db.execute("""CREATE TABLE IF NOT EXISTS meps_ml_hours (
                      ts   INTEGER PRIMARY KEY,   -- valid time (UTC hour)
                      run  INTEGER NOT NULL,
                      lead INTEGER NOT NULL,
                      data TEXT    NOT NULL)""")
    db.execute("""CREATE TABLE IF NOT EXISTS meps_map_hours (
                      ts   INTEGER PRIMARY KEY,   -- valid time (UTC hour)
                      run  INTEGER NOT NULL,
                      lead INTEGER NOT NULL,
                      meta TEXT    NOT NULL,      -- {"p": [hPa], "x": [x0, dx, nx], "y": [y0, dy, ny]} (LCC m)
                      data BLOB    NOT NULL)""")   # zlib(int16 [var t,u,v,z][level][point])
    db.execute("""CREATE TABLE IF NOT EXISTS meps_wx_hours (
                      ts   INTEGER PRIMARY KEY,   -- valid time (UTC hour); rain / snow of the hour ending then
                      run  INTEGER NOT NULL,
                      lead INTEGER NOT NULL,
                      meta TEXT    NOT NULL,      -- {"x": [x0, dx, nx], "y": [y0, dy, ny], "f": fields} (LCC m)
                      data BLOB    NOT NULL)""")   # zlib(int16 [field p,r,s,c,l][point])
    db.commit()


_TABLE = {"pl": "meps_hours", "ml": "meps_ml_hours", "map": "meps_map_hours", "wx": "meps_wx_hours"}
_UPSERT = """INSERT INTO {t} (ts, run, lead, data) VALUES (?, ?, ?, ?)
             ON CONFLICT(ts) DO UPDATE SET run = excluded.run, lead = excluded.lead, data = excluded.data
             WHERE excluded.lead < {t}.lead
                OR (excluded.lead = {t}.lead AND excluded.run >= {t}.run)"""


# ── Fetching ────────────────────────────────────────────────────────────────

class MepsFetcher:
    """Background fetcher (thread target: run)."""

    def __init__(self, lat: float, lon: float, radius_km: float, base: str = BASE_URL,
                 backfill_days: float = 3.0, enabled: bool = True, model_levels: bool = True,
                 map_fields: bool = True, map_days: float = 7.0,
                 wx: bool = True, wx_days: float = 7.0, wx_hours: int = 48, wx_km: float = 3000.0):
        self.lat, self.lon, self.radius = lat, lon, radius_km
        self.model_levels = model_levels
        self.map_fields = map_fields
        self.map_days = map_days
        self.wx, self.wx_days = wx, wx_days
        self.wx_hours = max(6, min(66, int(wx_hours)))
        self.wx_half = max(40, int(round(wx_km / 2.5 / WX_STRIDE)))       # points each side
        self.base = base.rstrip("/")
        self.backfill_days = backfill_days
        self.enabled = enabled
        self.grid = None             # (ix0, iy0, nx, ny) of the box in the model grid
        self.missing: dict = {}      # (kind, run) → time it was last found missing or failed
        self.last = None             # (time, text) of the last look
        self.newest_run = None

    def _wx_leads(self, run: int, now: Optional[float] = None) -> int:
        """Leads fetched for the weather maps: the main runs (00/06/12/18 UTC)
        to the forecast length while they are the newest, the others +6 h,
        and only +3 h for runs older than 6 h (history)."""
        now = time.time() if now is None else now
        if run < now - 6 * 3600:
            return WX_HISTORY
        return self.wx_hours if (run // 3600) % 6 == 0 else WX_SHORT

    def _url(self, run: int, kind: str = "pl") -> str:
        tag = time.strftime("%Y%m%dT%HZ", time.gmtime(run))
        return f"{self.base}/{time.strftime('%Y/%m/%d/%H', time.gmtime(run))}/meps_mbr000_{kind}_{tag}.ncml"

    def _box(self, url: str):
        """Grid indices of the box around the receiver (from the run's own x / y axes)."""
        if self.grid is None:
            d = _fetch(url, "x,y", TIMEOUT["pl"])
            x, y = d["x"], d["y"]
            ex, ey = lcc_xy(self.lat, self.lon)
            ix = int(round((ex - x[0]) / (x[1] - x[0])))
            iy = int(round((ey - y[0]) / (y[1] - y[0])))
            if not (HALF <= ix < len(x) - HALF and HALF <= iy < len(y) - HALF) \
                    or abs(x[ix] - ex) > 2000 or abs(y[iy] - ey) > 2000:
                raise ValueError("receiver outside the MEPS grid or projection changed")
            self.grid = (ix - HALF, iy - HALF, len(x), len(y))
        return self.grid

    def _cons(self, url: str, kind: str, run: Optional[int] = None, leads: Optional[tuple] = None) -> str:
        ix0, iy0, _, _ = self._box(url)
        sx, sy = f"[{ix0}:{STRIDE}:{ix0 + 2 * HALF}]", f"[{iy0}:{STRIDE}:{iy0 + 2 * HALF}]"
        if kind == "pl":
            box = f"[0:{LEADS - 1}][{LEV[0]}:{LEV[1]}]{sy}{sx}"
            return ",".join([f"time[0:{LEADS - 1}]", f"pressure[{LEV[0]}:{LEV[1]}]", f"x{sx}", f"y{sy}"]
                            + [f"{v}.{v}{box}" for v, _ in VARS])
        if kind == "wx":
            gx, gy = ix0 + HALF, iy0 + HALF
            nxg, nyg = self.grid[2], self.grid[3]
            kx0, kx1 = min(self.wx_half, gx // WX_STRIDE), min(self.wx_half, (nxg - 1 - gx) // WX_STRIDE)
            ky0, ky1 = min(self.wx_half, gy // WX_STRIDE), min(self.wx_half, (nyg - 1 - gy) // WX_STRIDE)
            wxs = f"[{gx - kx0 * WX_STRIDE}:{WX_STRIDE}:{gx + kx1 * WX_STRIDE}]"
            wys = f"[{gy - ky0 * WX_STRIDE}:{WX_STRIDE}:{gy + ky1 * WX_STRIDE}]"
            t0, t1 = leads if leads else (0, self._wx_leads(run))
            box = f"[{t0}:{t1}][0:0]{wys}{wxs}"
            return ",".join([f"time[{t0}:{t1}]", f"x{wxs}", f"y{wys}"] + [f"{v}.{v}{box}" for v, _ in WX_VARS])
        if kind == "map":
            cx, cy = ix0 + HALF, iy0 + HALF
            mx = f"[{cx - MAP_HALF}:{MAP_STRIDE}:{cx + MAP_HALF}]"
            my = f"[{cy - MAP_HALF}:{MAP_STRIDE}:{cy + MAP_HALF}]"
            box = f"[0:{LEADS - 1}][{MAP_LEV[0]}:{MAP_LEV[1]}]{my}{mx}"
            return ",".join([f"time[0:{LEADS - 1}]", f"pressure[{MAP_LEV[0]}:{MAP_LEV[1]}]", f"x{mx}", f"y{my}"]
                            + [f"{v}.{v}{box}" for v, _ in MAP_VARS])
        k0, k1 = ML_LEV
        nt = ML_LEADS - 1
        box = f"[0:{nt}][{k0}:{k1}]{sy}{sx}"
        return ",".join([f"time[0:{nt}]", f"ap[{k0}:{k1}]", f"b[{k0}:{k1}]", f"x{sx}", f"y{sy}",
                         f"surface_air_pressure.surface_air_pressure[0:{nt}][0:0]{sy}{sx}"]
                        + [f"{v}.{v}{box}" for v, _ in ML_VARS])

    def fetch_run(self, db, run: int, kind: str = "pl") -> int:
        """Fetch one run (pressure levels "pl", model levels "ml" or the Wind Map
        fields "map"), store its hours; returns the rows written."""
        url = self._url(run, {"ml": "ml", "wx": "sfc"}.get(kind, "pl"))
        if kind == "wx":
            return self._fetch_wx(db, run, url)
        d = _fetch(url, self._cons(url, kind, run), TIMEOUT[kind])
        if kind == "map":
            return self._store_map(db, run, d)
        return self._store(db, run, d) if kind == "pl" else self._store_ml(db, run, d)

    def _fetch_wx(self, db, run: int, url: str) -> int:
        """Weather maps of one run in pieces of WX_CHUNK hours (each request
        also brings the hour before, for the rain of the first hour), each
        piece stored and logged at once."""
        self._box(self._url(run, "pl"))              # the grid from a pressure-level file
        n = self._wx_leads(run)
        tag = time.strftime("%d.%m. %H UTC", time.gmtime(run))
        written = 0
        for a in range(1, n + 1, WX_CHUNK):
            b = min(n, a + WX_CHUNK - 1)
            t = time.time()
            d = _fetch(url, self._cons(url, "wx", run, (a - 1, b)), TIMEOUT["wx"])
            t1 = time.time()
            w = self._store_wx(db, run, d)
            written += w
            log.info("MEPS weather maps: run %s +%d…+%d h, %d hour(s) stored (download %.0f s, store %.1f s)",
                     tag, a, b, w, t1 - t, time.time() - t1)
        return written

    def _store_wx(self, db, run: int, d: dict) -> int:
        """Weather maps: per valid hour (leads 1 … n) the sea-level pressure
        ((hPa − 1000) × 10), the rain and the snow of the hour ending then
        (mm water × 100, from the accumulated amounts), total, low, medium
        and high cloud and fog (% in 5 % steps), cloud base (m in 50 m steps;
        missing where no cloud), the 10 m wind u / v towards east / north and
        the 10 m gust (kt in 2-kt steps); compressed int16 arrays, rows older
        than wx_days removed.  The field list of each row is in its meta "f"
        (older rows have no wind)."""
        xs, ys = list(d["x"]), list(d["y"])
        nx, ny = len(xs), len(ys)
        np_ = nx * ny
        meta = json.dumps({"x": [xs[0], xs[1] - xs[0], nx], "y": [ys[0], ys[1] - ys[0], ny],
                           "f": [k for _, k in WX_VARS]}, separators=(",", ":"))
        P, R, S = d["air_pressure_at_sea_level"], d["precipitation_amount_acc"], d["snowfall_amount_acc"]
        FRAC = [d[v] for v, k in WX_VARS if k in "clmhf"]
        B = d["cloud_base_altitude"]
        XW, YW, GU = d["x_wind_10m"], d["y_wind_10m"], d["wind_speed_of_gust"]
        rot = self._wx_rot(xs, ys)
        KT2 = KT / 2.0
        F = MAP_FILL
        written = 0
        ensure_table(db)
        times = list(d["time"])
        for k in range(1, len(times)):
            valid = int(round(times[k]))
            lead = int(round((valid - run) / 3600))
            o1, o0 = k * np_, (k - 1) * np_
            # plain comprehensions (no function call per value: about 5 × faster on the Pi)
            a = array.array("h", [F if v > 1e30 else int(round(v * 0.1 - 10000.0)) for v in P[o1:o1 + np_]])
            for acc in (R, S):
                a.extend(array.array("h", [F if x > 1e30 or y > 1e30 else (int(min(x - y, 320.0) * 100.0 + 0.5) if x > y else 0)
                                           for x, y in zip(acc[o1:o1 + np_], acc[o0:o0 + np_])]))
            # clouds in 5 % steps and the cloud base in 50 m steps: a third smaller compressed
            for cl in FRAC:
                a.extend(array.array("h", [F if v > 1e30 else int(v * 20.0 + 0.5) * 5 for v in cl[o1:o1 + np_]]))
            a.extend(array.array("h", [F if v > 1e30 or v < 0 or v > 30000 else int(v / 50.0 + 0.5) * 50
                                       for v in B[o1:o1 + np_]]))
            # 10 m wind turned from the grid axes to true north, and the gust:
            # kt in 2-kt steps (a third smaller compressed than whole knots)
            xw, yw = XW[o1:o1 + np_], YW[o1:o1 + np_]
            a.extend(array.array("h", [F if x > 1e30 or y > 1e30 else int(round((x * c + y * sn) * KT2)) * 2
                                       for x, y, (c, sn) in zip(xw, yw, rot)]))
            a.extend(array.array("h", [F if x > 1e30 or y > 1e30 else int(round((y * c - x * sn) * KT2)) * 2
                                       for x, y, (c, sn) in zip(xw, yw, rot)]))
            a.extend(array.array("h", [F if v > 1e30 or v < 0 else int(round(v * KT2)) * 2 for v in GU[o1:o1 + np_]]))
            if sys.byteorder != "little":
                a.byteswap()
            cur = db.execute(
                """INSERT INTO meps_wx_hours (ts, run, lead, meta, data) VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(ts) DO UPDATE SET run = excluded.run, lead = excluded.lead,
                                                 meta = excluded.meta, data = excluded.data
                   WHERE excluded.lead < meps_wx_hours.lead
                      OR (excluded.lead = meps_wx_hours.lead AND excluded.run >= meps_wx_hours.run)""",
                (valid, run, lead, meta, zlib.compress(a.tobytes(), 6)))
            written += cur.rowcount
        db.execute("DELETE FROM meps_wx_hours WHERE ts < ?", (int(time.time() - self.wx_days * 86400),))
        db.commit()
        return written

    def _wx_rot(self, xs: list, ys: list) -> list:
        """(cos, sin) of the angle between the grid y axis and true north at
        each point of the weather-map grid (kept while the grid is the same)."""
        key = (xs[0], xs[-1], len(xs), ys[0], ys[-1], len(ys))
        if getattr(self, "_wx_rot_key", None) != key:
            rot = []
            for y in ys:
                for x in xs:
                    al = math.radians(_N * (lcc_latlon(x, y)[1] - LCC_LON0))
                    rot.append((math.cos(al), math.sin(al)))
            self._wx_rot_key, self._wx_rot_val = key, rot
        return self._wx_rot_val

    def _store_map(self, db, run: int, d: dict) -> int:
        """Wind Map fields: every point of the ± 300 km box on the pressure
        levels, winds turned to true north, as compressed int16 arrays
        (t °C × 100, u / v kt × 10, z gpm); rows older than map_days removed."""
        P = [round(p, 1) for p in d["pressure"]]
        xs, ys = list(d["x"]), list(d["y"])
        nl, nx, ny = len(P), len(xs), len(ys)
        np_ = nx * ny
        rot = []
        for j in range(ny):
            for i in range(nx):
                _, lo = lcc_latlon(xs[i], ys[j])
                al = math.radians(_N * (lo - LCC_LON0))
                rot.append((math.cos(al), math.sin(al)))
        meta = json.dumps({"p": P, "x": [xs[0], xs[1] - xs[0], nx], "y": [ys[0], ys[1] - ys[0], ny]},
                          separators=(",", ":"))
        T, XW, YW, Z = (d[v] for v, _ in MAP_VARS)
        q = lambda v, k: MAP_FILL if v is None or v != v or abs(v) > 32000 else int(round(v * k))
        written = 0
        ensure_table(db)
        for k in range(len(d["time"])):
            valid = int(round(d["time"][k]))
            lead = int(round((valid - run) / 3600))
            a_t, a_u, a_v, a_z = (array.array("h") for _ in range(4))
            for lv in range(nl):
                off = (k * nl + lv) * np_
                for idx in range(np_):
                    t, xw, yw, z = T[off + idx], XW[off + idx], YW[off + idx], Z[off + idx]
                    if t > 1e30 or xw > 1e30 or yw > 1e30:
                        a_t.append(MAP_FILL); a_u.append(MAP_FILL); a_v.append(MAP_FILL)
                    else:
                        ca, sa = rot[idx]
                        a_t.append(q(t - 273.15, 100))
                        a_u.append(q((xw * ca + yw * sa) * KT, 10))
                        a_v.append(q((-xw * sa + yw * ca) * KT, 10))
                    a_z.append(MAP_FILL if z > 1e30 else q(z / G0, 1))
            raw = a_t + a_u + a_v + a_z
            if sys.byteorder != "little":
                raw.byteswap()
            cur = db.execute(
                """INSERT INTO meps_map_hours (ts, run, lead, meta, data) VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(ts) DO UPDATE SET run = excluded.run, lead = excluded.lead,
                                                 meta = excluded.meta, data = excluded.data
                   WHERE excluded.lead < meps_map_hours.lead
                      OR (excluded.lead = meps_map_hours.lead AND excluded.run >= meps_map_hours.run)""",
                (valid, run, lead, meta, zlib.compress(raw.tobytes(), 6)))
            written += cur.rowcount
        db.execute("DELETE FROM meps_map_hours WHERE ts < ?", (int(time.time() - self.map_days * 86400),))
        db.commit()
        return written

    def _geom(self, xs: list, ys: list):
        """Points of the area with their wind rotation (grid → true north), and
        the bilinear weights and rotation angle at Jokioinen."""
        nx, ny = len(xs), len(ys)
        pts = []
        for j in range(ny):
            for i in range(nx):
                la, lo = lcc_latlon(xs[i], ys[j])
                if _km(self.lat, self.lon, la, lo) <= self.radius:
                    al = math.radians(_N * (lo - LCC_LON0))
                    pts.append((j * nx + i, math.cos(al), math.sin(al)))
        if not pts:
            raise ValueError("no model points in the area")
        jx, jy = lcc_xy(*JOKIOINEN)
        fx, fy = (jx - xs[0]) / (xs[1] - xs[0]), (jy - ys[0]) / (ys[1] - ys[0])
        jw = []
        if 0 <= fx < nx - 1 and 0 <= fy < ny - 1:
            i0, j0 = int(fx), int(fy)
            ax, ay = fx - i0, fy - j0
            jw = [(j0 * nx + i0, (1 - ax) * (1 - ay)), (j0 * nx + i0 + 1, ax * (1 - ay)),
                  ((j0 + 1) * nx + i0, (1 - ax) * ay), ((j0 + 1) * nx + i0 + 1, ax * ay)]
        return pts, jw, math.radians(_N * (JOKIOINEN[1] - LCC_LON0))

    def _store(self, db, run: int, d: dict) -> int:
        P = list(d["pressure"])
        xs, ys = list(d["x"]), list(d["y"])
        nl, ny, nx = len(P), len(ys), len(xs)
        nt = len(d["time"])
        pts, jw, alj = self._geom(xs, ys)
        np_ = nx * ny
        written = 0
        ensure_table(db)
        for k in range(nt):
            valid = int(round(d["time"][k]))
            lead = int(round((valid - run) / 3600))
            area = {n: [] for n in ("t", "u", "v", "z", "rh", "q")}
            jok = {n: [] for n in ("t", "u", "v", "z", "rh", "q")}
            for lv in range(nl):
                off = (k * nl + lv) * np_
                f = {short: d[name] for name, short in VARS}
                s = dict.fromkeys(("t", "u", "v", "z", "rh", "q"), 0.0)
                cnt = 0
                for idx, ca, sa in pts:
                    t, xw, yw = f["t"][off + idx], f["xw"][off + idx], f["yw"][off + idx]
                    if t > 1e30 or xw > 1e30:
                        continue
                    cnt += 1
                    s["t"] += t; s["z"] += f["z"][off + idx]; s["rh"] += f["rh"][off + idx]; s["q"] += f["q"][off + idx]
                    s["u"] += xw * ca + yw * sa
                    s["v"] += -xw * sa + yw * ca
                if not cnt:
                    for n in area:
                        area[n].append(None)
                else:
                    area["t"].append(round(s["t"] / cnt - 273.15, 2))
                    area["u"].append(round(s["u"] / cnt * KT, 1))
                    area["v"].append(round(s["v"] / cnt * KT, 1))
                    area["z"].append(round(s["z"] / cnt / G0, 1))
                    area["rh"].append(round(s["rh"] / cnt * 100, 1))
                    area["q"].append(round(s["q"] / cnt * 1000, 3))
                if jw:
                    v = {n: sum(w * f[n][off + i] for i, w in jw) for n in ("t", "xw", "yw", "z", "rh", "q")}
                    jok["t"].append(round(v["t"] - 273.15, 2))
                    jok["u"].append(round((v["xw"] * math.cos(alj) + v["yw"] * math.sin(alj)) * KT, 1))
                    jok["v"].append(round((-v["xw"] * math.sin(alj) + v["yw"] * math.cos(alj)) * KT, 1))
                    jok["z"].append(round(v["z"] / G0, 1))
                    jok["rh"].append(round(v["rh"] * 100, 1))
                    jok["q"].append(round(v["q"] * 1000, 3))
            row = {"p": [round(p, 1) for p in P], "n": len(pts), "rad": self.radius, "a": area}
            if jw:
                row["j"] = jok
            cur = db.execute(_UPSERT.format(t="meps_hours"),
                             (valid, run, lead, json.dumps(row, separators=(",", ":"))))
            written += cur.rowcount
        db.commit()
        return written

    def _store_ml(self, db, run: int, d: dict) -> int:
        """Model levels: area mean on each level (top down) and the Jokioinen column."""
        ap, bk = list(d["ap"]), list(d["b"])
        xs, ys = list(d["x"]), list(d["y"])
        nl, ny, nx = len(ap), len(ys), len(xs)
        nt = len(d["time"])
        pts, jw, alj = self._geom(xs, ys)
        np_ = nx * ny
        T, Q, XW, YW, PS = d["air_temperature_ml"], d["specific_humidity_ml"], d["x_wind_ml"], d["y_wind_ml"], \
            d["surface_air_pressure"]
        ca_j, sa_j = math.cos(alj), math.sin(alj)
        written = 0
        ensure_table(db)
        for k in range(nt):
            valid = int(round(d["time"][k]))
            lead = int(round((valid - run) / 3600))
            ps_off = k * np_
            good = [(idx, ca, sa) for idx, ca, sa in pts if PS[ps_off + idx] < 1e30]
            if not good:
                continue
            ps_a = sum(PS[ps_off + idx] for idx, _, _ in good) / len(good)
            area = {n: [] for n in ("p", "t", "u", "v", "q")}
            jok = {n: [] for n in ("p", "t", "u", "v", "q")}
            ps_j = sum(w * PS[ps_off + i] for i, w in jw) if jw else None
            if ps_j is not None and ps_j > 1e30:
                ps_j = None
            for lv in range(nl):
                off = (k * nl + lv) * np_
                st = sq = su = sv = 0.0
                cnt = 0
                for idx, ca, sa in good:
                    t, xw, yw = T[off + idx], XW[off + idx], YW[off + idx]
                    if t > 1e30 or xw > 1e30:
                        continue
                    cnt += 1
                    st += t; sq += Q[off + idx]
                    su += xw * ca + yw * sa
                    sv += -xw * sa + yw * ca
                area["p"].append(round((ap[lv] + bk[lv] * ps_a) / 100, 1))
                if cnt:
                    area["t"].append(round(st / cnt - 273.15, 2))
                    area["q"].append(round(sq / cnt * 1000, 3))
                    area["u"].append(round(su / cnt * KT, 1))
                    area["v"].append(round(sv / cnt * KT, 1))
                else:
                    for n in ("t", "q", "u", "v"):
                        area[n].append(None)
                if ps_j is not None:
                    v = {n: sum(w * A[off + i] for i, w in jw) for n, A in (("t", T), ("q", Q), ("xw", XW), ("yw", YW))}
                    jok["p"].append(round((ap[lv] + bk[lv] * ps_j) / 100, 1))
                    jok["t"].append(round(v["t"] - 273.15, 2))
                    jok["q"].append(round(v["q"] * 1000, 3))
                    jok["u"].append(round((v["xw"] * ca_j + v["yw"] * sa_j) * KT, 1))
                    jok["v"].append(round((-v["xw"] * sa_j + v["yw"] * ca_j) * KT, 1))
            row = {"n": len(good), "rad": self.radius,
                   "ps": [round(ps_a / 100, 1), round(ps_j / 100, 1) if ps_j is not None else None], "a": area}
            if ps_j is not None:
                row["j"] = jok
            cur = db.execute(_UPSERT.format(t="meps_ml_hours"),
                             (valid, run, lead, json.dumps(row, separators=(",", ":"))))
            written += cur.rowcount
        db.commit()
        return written

    def due_runs(self, db, now: float, span_h: float) -> list:
        """[(run, kinds)] newest first: the runs whose hours +0 … +2 are not all
        stored with their own lead, per kind ("pl", and "ml" when model levels are on)."""
        newest = int(now // (RUN_STEP_H * 3600)) * RUN_STEP_H * 3600
        runs = [newest - k * RUN_STEP_H * 3600 for k in range(int(span_h // RUN_STEP_H) + 1)]
        ensure_table(db)
        kinds = ("pl",) + (("ml",) if self.model_levels else ()) + (("map",) if self.map_fields else ()) \
            + (("wx",) if self.wx else ())
        have = {kd: dict(db.execute(f"SELECT ts, lead FROM {_TABLE[kd]} WHERE ts >= ?", (runs[-1],)).fetchall())
                for kd in kinds}
        # weather-map hours with the 10 m wind: the recent runs are fetched again
        # for the hours stored without it (rows written before the wind was added)
        wx_wind = dict(db.execute("SELECT ts, lead FROM meps_wx_hours WHERE ts >= ? AND instr(meta, '\"u\"') > 0",
                                  (runs[-1],)).fetchall()) if self.wx else {}
        map_from = now - self.map_days * 86400 + RUN_STEP_H * 3600     # not older than the map retention
        out = []
        for r in runs:
            need = []
            for kd in kinds:
                if kd == "map" and r < map_from:
                    continue
                if kd == "wx":
                    if r < now - self.wx_days * 86400 + RUN_STEP_H * 3600:
                        continue
                    hv = wx_wind if r >= now - WX_REFILL_H * 3600 else have[kd]
                    if all(hv.get(r + h * 3600, 99) <= h for h in range(1, WX_HISTORY + 1)):
                        continue
                elif all(have[kd].get(r + h * 3600, 99) <= h for h in range(VERIF_MAX_LEAD + 1)):
                    continue
                seen = self.missing.get((kd, r))
                if seen is not None:
                    wait = RETRY_RECENT_SEC if r > now - 12 * 3600 else 24 * 3600
                    if now - seen < wait:
                        continue
                need.append(kd)
            if need:
                out.append((r, need))
        return out

    def cycle(self, db, first: bool = False) -> int:
        now = time.time()
        span = max(self.backfill_days * 24, 30) if first else 30
        n_runs = 0
        rows = {"pl": 0, "ml": 0, "map": 0, "wx": 0}
        errors = []
        for r, kinds in self.due_runs(db, now, span)[:MAX_PER_CYCLE]:
            done = False
            for kd in kinds:
                try:
                    rows[kd] += self.fetch_run(db, r, kd)
                    self.missing.pop((kd, r), None)
                    done = True
                    if kd == "pl":
                        self.newest_run = max(self.newest_run or 0, r)
                except urllib.error.HTTPError as exc:
                    if exc.code not in (400, 404):           # 400 / 404: not (yet) published
                        errors.append(f"{kd} {exc}")
                    self.missing[(kd, r)] = now
                except Exception as exc:                     # noqa: BLE001  (after the retries)
                    errors.append(f"{kd} {exc}")
                    self.missing[(kd, r)] = now
            n_runs += done
            time.sleep(1.0)
        txt = f"{n_runs} run(s), {rows['pl']} hour(s) stored" + \
              (f", {rows['ml']} model-level hour(s)" if self.model_levels else "") + \
              (f", {rows['map']} map hour(s)" if self.map_fields else "") + \
              (f", {rows['wx']} weather hour(s)" if self.wx else "")
        if errors:
            txt += f"; failed: {errors[-1]}"
            log.warning("MEPS fetch: %d request(s) failed, last: %s", len(errors), errors[-1])
        self.last = (time.time(), txt)
        return n_runs

    def run(self) -> None:
        from database.db import get_db
        time.sleep(90)
        first = True
        while True:
            try:
                n = self.cycle(get_db(), first)
                if n:
                    log.info("MEPS: %s", self.last[1])
                first = first and n >= MAX_PER_CYCLE   # keep back-filling while there is more
            except Exception as exc:                     # noqa: BLE001
                self.last = (time.time(), f"failed: {exc}")
                log.warning("MEPS fetch failed: %s", exc)
            time.sleep(CHECK_SEC if not first else 5)


_instance: Optional[MepsFetcher] = None


def init(cfg) -> MepsFetcher:
    global _instance
    _instance = MepsFetcher(cfg.RECEIVER_LAT, cfg.RECEIVER_LON,
                            float(getattr(cfg, "SOUNDING_RADIUS_KM", 150.0)),
                            base=getattr(cfg, "MEPS_URL", BASE_URL),
                            backfill_days=float(getattr(cfg, "MEPS_BACKFILL_DAYS", 3)),
                            enabled=bool(getattr(cfg, "MEPS_FETCH", True)),
                            model_levels=bool(getattr(cfg, "MEPS_MODEL_LEVELS", True)),
                            map_fields=bool(getattr(cfg, "MEPS_MAP", True)),
                            map_days=float(getattr(cfg, "MEPS_MAP_DAYS", 7)),
                            wx=bool(getattr(cfg, "MEPS_WX", True)),
                            wx_days=float(getattr(cfg, "MEPS_WX_DAYS", 7)),
                            wx_hours=int(getattr(cfg, "MEPS_WX_FORECAST_H", 48)),
                            wx_km=float(getattr(cfg, "MEPS_WX_KM", 3000)))
    return _instance


def get() -> Optional[MepsFetcher]:
    return _instance


# ── Read side ───────────────────────────────────────────────────────────────

def hours(db, t0: float, t1: float, max_lead: int = 99, kind: str = "pl") -> dict:
    """{valid ts: row dict + "run", "lead"} for t0 ≤ ts < t1 (pressure levels
    "pl" from meps_hours, model levels "ml" from meps_ml_hours)."""
    out = {}
    try:
        for ts, run, lead, data in db.execute(
                f"SELECT ts, run, lead, data FROM {_TABLE[kind]} WHERE ts >= ? AND ts < ? AND lead <= ?",
                (int(t0), int(t1), max_lead)):
            try:
                d = json.loads(data)
            except ValueError:
                continue
            d["run"], d["lead"] = run, lead
            out[ts] = d
    except Exception:                                    # noqa: BLE001  (table missing)
        pass
    return out


def _es(t: float) -> float:
    return 6.112 * math.exp(17.67 * t / (t + 243.5))


def _dewpoint(q_gkg: float, p: float, t: float):
    q = q_gkg / 1000.0
    if q <= 0:
        return None
    e = min(q * p / (0.622 + 0.378 * q), _es(t))
    x = math.log(e / 6.112)
    return 243.5 * x / (17.67 - x)


def _mix(a: dict, b: dict, w: float, key: str) -> dict:
    out = {}
    for n in a[key]:
        va, vb = a[key].get(n) or [], b[key].get(n) or []
        out[n] = [None if x is None or y is None else x * (1 - w) + y * w for x, y in zip(va, vb)]
    return out


def column_at(db, at: float, key: str = "a", max_lead: int = 99, kind: str = "pl"):
    """The model column (area "a" or Jokioinen "j") at time `at`, linear in
    time between the hours around it: (column dict, info) or (None, None).
    Model levels ("ml"): the column carries its own pressures ("p")."""
    h = int(at // 3600 * 3600)
    rows = hours(db, h - 3600, h + 7200, max_lead, kind)
    a, b = rows.get(h), rows.get(h + 3600)
    w = (at - h) / 3600.0
    if a and b and key in a and key in b:
        col = _mix(a, b, w, key)
        info = {"run": max(a["run"], b["run"]), "lead": max(a["lead"], b["lead"])}
    else:
        near = a if (a and (w < 0.5 or not b)) else b
        if not near or key not in near or abs(at - (h + (3600 if near is b else 0))) > 5400:
            return None, None
        col = near[key]
        info = {"run": near["run"], "lead": near["lead"]}
    info["p"] = col.get("p") or (a or b).get("p")
    info["n"] = (a or b).get("n")
    info["rad"] = (a or b).get("rad")
    return col, info


def _wind(lv: dict, u, v) -> None:
    if u is not None and v is not None:
        lv["wind_spd"] = round(math.hypot(u, v), 1)
        lv["wind_dir"] = round(math.degrees(math.atan2(-u, -v)) % 360, 0)


def profile(db, at: float) -> dict:
    """Model profile for the Skew-T (area mean) at time `at`: the model levels
    when stored (levels_kind "model"), else the 10 pressure levels ("standard")."""
    col, info = column_at(db, at)
    mcol, minfo = column_at(db, at, kind="ml")
    if col is None and mcol is None:
        newest = None
        try:
            newest = db.execute("SELECT MAX(ts) FROM meps_hours").fetchone()[0]
        except Exception:                                # noqa: BLE001
            pass
        return {"found": False, "at": at, "newest": newest}
    levels = []
    if mcol is not None:
        # heights of the model levels from the pressure-level geopotential (ln p)
        zp = []
        if col is not None:
            zp = sorted((math.log(p), z) for p, z in zip(info["p"], col["z"]) if z is not None)
        for i, p in enumerate(minfo["p"]):
            t, u, v, q = (mcol[n][i] for n in ("t", "u", "v", "q"))
            if t is None or p is None:
                continue
            lv = {"pressure": round(p, 1), "temp": round(t, 2)}
            td = _dewpoint(q, p, t) if q is not None else None
            lv["dewpoint"] = round(td, 2) if td is not None else None
            lv["rh"] = round(min(100.0, 100 * _es(td) / _es(t)), 1) if td is not None else None
            x = math.log(p)
            for (x0, z0), (x1, z1) in zip(zp, zp[1:]):
                if x0 <= x <= x1:
                    lv["z_m"] = round(z0 + (z1 - z0) * (x - x0) / (x1 - x0), 1)
                    break
            _wind(lv, u, v)
            levels.append(lv)
        info = minfo
        kind = "model"
    else:
        for i, p in enumerate(info["p"]):
            t, u, v, z, rh, q = (col[n][i] for n in ("t", "u", "v", "z", "rh", "q"))
            if t is None:
                continue
            lv = {"pressure": p, "temp": round(t, 2), "z_m": round(z, 1) if z is not None else None,
                  "rh": round(rh, 1) if rh is not None else None}
            td = _dewpoint(q, p, t) if q is not None else None
            lv["dewpoint"] = round(td, 2) if td is not None else None
            _wind(lv, u, v)
            levels.append(lv)
        kind = "standard"
    levels.sort(key=lambda l: -l["pressure"])
    return {"found": True, "at": at, "run": info["run"], "lead": info["lead"],
            "provisional": info["lead"] > VERIF_MAX_LEAD, "points": info["n"], "radius_km": info["rad"],
            "levels_kind": kind, "levels": levels, "source": "MEPS (MET Norway, CC BY 4.0)"}


# ── Wind Map: the model at a flight level, averaged into the map cells ──────

_map_cache: dict = {}         # ts → (run, lead, meta, arrays)
_pts_cache: dict = {}         # meta x / y → [(lat, lon)]
_lev_cache: dict = {}         # (ts, run, lead, p) → [(u, v, t) or None] (the time slider asks the same hours)
_KM_PER_DEG_LAT = 110.57      # the same as web/api/windmap.py KM_PER_DEG_LAT (cells must match)


def _map_hour(db, ts: int, run: int, lead: int):
    c = _map_cache.get(ts)
    if c and c[0] == run and c[1] == lead:
        return c
    r = db.execute("SELECT meta, data FROM meps_map_hours WHERE ts = ?", (ts,)).fetchone()
    if not r:
        return None
    meta = json.loads(r[0])
    a = array.array("h")
    a.frombytes(zlib.decompress(r[1]))
    if sys.byteorder != "little":
        a.byteswap()
    n = len(meta["p"]) * meta["x"][2] * meta["y"][2]
    if len(a) != 4 * n:
        return None
    c = (run, lead, meta, a)
    if len(_map_cache) > 72:
        _map_cache.pop(min(_map_cache))
    _map_cache[ts] = c
    return c


def _map_points(meta):
    key = (tuple(meta["x"]), tuple(meta["y"]))
    pts = _pts_cache.get(key)
    if pts is None:
        x0, dx, nx = meta["x"]
        y0, dy, ny = meta["y"]
        pts = [lcc_latlon(x0 + i * dx, y0 + j * dy) for j in range(ny) for i in range(nx)]
        _pts_cache.clear()
        _pts_cache[key] = pts
    return pts


def _at_pressure(entry, p_hpa: float):
    """[(u kt, v kt, t °C) or None per point] of one stored hour at p_hpa (ln p between levels)."""
    _, _, meta, a = entry
    P = meta["p"]
    npt = meta["x"][2] * meta["y"][2]
    n = len(P) * npt
    lp = math.log(p_hpa)
    k = None
    for i in range(len(P) - 1):
        if P[i] <= p_hpa <= P[i + 1]:
            k = i
            break
    if k is None:
        if abs(p_hpa - P[-1]) <= 15:          # just below the lowest level (1000 hPa)
            k, w = len(P) - 2, 1.0
        else:
            return None
    else:
        w = (lp - math.log(P[k])) / (math.log(P[k + 1]) - math.log(P[k]))
    out = []
    o0, o1 = k * npt, (k + 1) * npt
    for idx in range(npt):
        vals = []
        for var in range(3):                  # t, u, v
            b = var * n
            x0, x1 = a[b + o0 + idx], a[b + o1 + idx]
            if x0 == MAP_FILL or x1 == MAP_FILL:
                vals = None
                break
            vals.append(x0 + (x1 - x0) * w)
        out.append(None if vals is None else (vals[1] / 10, vals[2] / 10, vals[0] / 100))
    return out


def map_cells(db, alt_ft: float, start_ts: float, end_ts: float, cell_km: float,
              lat0: float, lon0: float) -> Optional[dict]:
    """The model at pressure altitude alt_ft over the period, averaged in time
    (each hour weighted by how much of [hour − 30 min, hour + 30 min] lies in
    the period) and over the model points (20 km apart) in each Wind Map cell
    (same cells and centres as web/api/windmap.py):
    {"cells": [{lat, lon, bounds, wind_spd, wind_dir, temp, n}], "runs", "lead_max",
     "provisional", "hours", "p_hpa", "source"}; {"cells": [], "outside": True} above
    150 hPa (about FL445); None when nothing is stored for the period."""
    p_hpa = _isa_p(alt_ft)
    try:
        rows = db.execute("SELECT ts, run, lead FROM meps_map_hours WHERE ts >= ? AND ts <= ? ORDER BY ts",
                          (int(start_ts - 1800), int(end_ts + 1800))).fetchall()
    except Exception:                                    # noqa: BLE001  (table missing)
        return None
    acc = None
    wsum = 0.0
    used, runs, leads = 0, [], []
    pts = None
    for ts, run, lead in rows:
        w = (min(end_ts, ts + 1800) - max(start_ts, ts - 1800)) / 3600.0
        if w <= 0:
            continue
        e = _map_hour(db, ts, run, lead)
        if e is None:
            continue
        ck = (ts, run, lead, round(p_hpa, 2))
        vals = _lev_cache.get(ck)
        if vals is None:
            vals = _at_pressure(e, p_hpa)
            if len(_lev_cache) > 96:
                _lev_cache.clear()
            _lev_cache[ck] = vals
        if vals is None:
            return {"cells": [], "p_hpa": round(p_hpa, 1), "outside": True, "hours": 0}
        if pts is None:
            pts = _map_points(e[2])
            acc = [[0.0, 0.0, 0.0, 0.0] for _ in pts]
        for i, v in enumerate(vals):
            if v is not None:
                a = acc[i]
                a[0] += w * v[0]; a[1] += w * v[1]; a[2] += w * v[2]; a[3] += w
        wsum += w
        used += 1
        runs.append(run); leads.append(lead)
    if not used:
        return None
    kx = _KM_PER_DEG_LAT * math.cos(math.radians(lat0))
    cells: dict = {}
    for (la, lo), a in zip(pts, acc):
        if a[3] <= 0:
            continue
        key = (math.floor((lo - lon0) * kx / cell_km), math.floor((la - lat0) * _KM_PER_DEG_LAT / cell_km))
        c = cells.setdefault(key, [0.0, 0.0, 0.0, 0])
        c[0] += a[0] / a[3]; c[1] += a[1] / a[3]; c[2] += a[2] / a[3]; c[3] += 1
    need = max(1, int(0.5 * (cell_km / 20.0) ** 2))      # leave out cells cut by the box edge
    out = []
    for (cx, cy), (su, sv, st, n) in cells.items():
        if n < need:
            continue
        u, v = su / n, sv / n
        lat_s = lat0 + cy * cell_km / _KM_PER_DEG_LAT
        lat_n = lat0 + (cy + 1) * cell_km / _KM_PER_DEG_LAT
        lon_w = lon0 + cx * cell_km / kx
        lon_e = lon0 + (cx + 1) * cell_km / kx
        out.append({"lat": round((lat_s + lat_n) / 2, 4), "lon": round((lon_w + lon_e) / 2, 4),
                    "bounds": [round(lat_s, 4), round(lon_w, 4), round(lat_n, 4), round(lon_e, 4)],
                    "wind_spd": round(math.hypot(u, v), 1),
                    "wind_dir": round(math.degrees(math.atan2(-u, -v)) % 360, 1),
                    "temp": round(st / n, 1), "n": n})
    return {"cells": out, "runs": sorted(set(runs)), "lead_max": max(leads),
            "provisional": max(leads) > VERIF_MAX_LEAD, "hours": used, "p_hpa": round(p_hpa, 1),
            "source": "MEPS (MET Norway, CC BY 4.0)"}


_lvl_frame_cache: dict = {}   # (ts, run, lead, fl) → frame (Live Map wind barbs)


def level_frame(db, fl: int, now: float | None = None) -> dict:
    """The model wind and temperature at flight level fl (pressure altitude
    fl × 100 ft, ISA pressure, ln p between the stored levels) on every point
    of the stored Wind Map box (± 300 km around the receiver, 20 km) for the
    stored hour nearest to now (within 90 min) — for the wind barbs of the Live
    Map weather overlay (from 2026-10-25).  Nothing is fetched: the hours are
    those stored for the Wind Map (meps_map_hours).
    {"ts", "run", "lead", "fl", "p_hpa", "grid": {"x", "y"}, "u", "v" (kt, true
    north), "t" (°C) lists in grid order (None where missing)} or {"error"}."""
    import time as _t
    now = _t.time() if now is None else now
    p_hpa = _isa_p(fl * 100.0)
    try:
        row = db.execute("SELECT ts, run, lead FROM meps_map_hours ORDER BY ABS(ts - ?) LIMIT 1",
                         (int(now),)).fetchone()
    except Exception:                                    # noqa: BLE001  (table missing)
        row = None
    if not row or abs(row[0] - now) > 5400:
        return {"error": "no MEPS upper-air hours stored near now (Wind Map MEPS fields, MEPS_MAP)"}
    ts, run, lead = row
    key = (ts, run, lead, int(fl))
    c = _lvl_frame_cache.get(key)
    if c is not None:
        return c
    e = _map_hour(db, ts, run, lead)
    if e is None:
        return {"error": "stored hour not readable"}
    vals = _at_pressure(e, p_hpa)
    if vals is None:
        return {"error": f"FL{fl} is outside the stored levels"}
    meta = e[2]
    out = {"ts": ts, "run": run, "lead": lead, "fl": int(fl), "p_hpa": round(p_hpa, 1),
           "grid": {"x": meta["x"], "y": meta["y"]},
           "u": [None if v is None else round(v[0], 1) for v in vals],
           "v": [None if v is None else round(v[1], 1) for v in vals],
           "t": [None if v is None else round(v[2], 1) for v in vals],
           "source": "MEPS (MET Norway, CC BY 4.0)"}
    if len(_lvl_frame_cache) > 24:
        _lvl_frame_cache.clear()
    _lvl_frame_cache[key] = out
    return out


# ── MEPS check (Mode S minus MEPS) ──────────────────────────────────────────

def _isa_p(ft: float) -> float:
    if ft <= 36089:
        return 1013.25 * (1 - 6.8756e-6 * ft) ** 5.2559
    return 226.32 * math.exp(-(ft - 36089) / 20806)


def _isa_ft(p: float) -> float:
    if p >= 226.32:
        return (1 - (p / 1013.25) ** (1 / 5.2559)) / 6.8756e-6
    return 36089 - 20806 * math.log(p / 226.32)


def _at_levels(cen: list, vals: list, P: list, max_gap_ft: float = 2000) -> list:
    """Values at layer centres (ft, ascending) → at the pressure levels P (ln p)."""
    lp = [-math.log(_isa_p(c)) for c in cen]
    out = []
    for p in P:
        x = -math.log(p)
        r = None
        for k in range(1, len(lp)):
            if lp[k - 1] <= x <= lp[k]:
                if vals[k - 1] is not None and vals[k] is not None and cen[k] - cen[k - 1] <= max_gap_ft:
                    w = (x - lp[k - 1]) / (lp[k] - lp[k - 1])
                    r = vals[k - 1] * (1 - w) + vals[k] * w
                break
        out.append(r)
    return out


def modes_levels(lv_rows: list, P: list) -> dict:
    """Hourly Mode S profile (profile_hours "lv") at the model levels:
    {"t": °C, "u": kt, "v": kt} (layers with ≥ 3 replies)."""
    from collector.atmos import LAYER_EDGES
    cen, T, U, V = [], [], [], []
    for r in lv_rows or []:
        lo, t, _, _, tc, wd, ws, _, wc = (list(r) + [None] * 10)[:9]
        if lo not in LAYER_EDGES or LAYER_EDGES.index(lo) + 1 >= len(LAYER_EDGES):
            continue
        k = LAYER_EDGES.index(lo)
        cen.append((LAYER_EDGES[k] + LAYER_EDGES[k + 1]) / 2)
        T.append(t if t is not None and (tc or 0) >= 3 else None)
        if ws is not None and wd is not None and (wc or 0) >= 3:
            U.append(-ws * math.sin(math.radians(wd))); V.append(-ws * math.cos(math.radians(wd)))
        else:
            U.append(None); V.append(None)
    return {"t": _at_levels(cen, T, P), "u": _at_levels(cen, U, P), "v": _at_levels(cen, V, P)}


def _hour_mean(rows: dict, h: int, key: str = "a"):
    """Model value for the Mode S hour [h, h + 1 h): mean of the hours h and h + 1."""
    a, b = rows.get(h), rows.get(h + 3600)
    if not a or key not in a:
        return None
    if not b or key not in b:
        return a[key]
    return {n: [None if x is None or y is None else (x + y) / 2 for x, y in zip(a[key][n], b[key][n])]
            for n in a[key]}


def _zgeom(zg: float, lat: float) -> float:
    from collector import gnss_heights as gh
    k = gh.gravity(lat) / gh.G0
    return gh.EARTH_R * zg / (k * gh.EARTH_R - zg)


def _sonde_levels(rec: dict, P: list) -> dict:
    """Sonde T °C, u, v kt, z m at the model levels (ln p), None outside."""
    lv = sorted([l for l in rec.get("lv") or [] if l[0]], key=lambda l: -l[0])
    out = {n: [] for n in ("t", "u", "v", "z")}
    for p in P:
        x = -math.log(p)
        vals = dict.fromkeys(out)
        for a, b in zip(lv, lv[1:]):
            if a[0] >= p >= b[0] and a[0] > b[0]:
                w = (x + math.log(a[0])) / (math.log(a[0]) - math.log(b[0]))
                g = lambda i: None if a[i] is None or b[i] is None else a[i] + (b[i] - a[i]) * w
                vals["t"], vals["z"] = g(3), g(2)
                if None not in (a[5], a[6], b[5], b[6]):
                    ua, va = -a[6] * math.sin(math.radians(a[5])), -a[6] * math.cos(math.radians(a[5]))
                    ub, vb = -b[6] * math.sin(math.radians(b[5])), -b[6] * math.cos(math.radians(b[5]))
                    vals["u"], vals["v"] = ua + (ub - ua) * w, va + (vb - va) * w
                break
        for n in out:
            out[n].append(vals[n])
    return out


_check_cache: dict = {}


def check(db, days: float, lat: float, lon: float, radius_km: float, busy: int = 0,
          now: Optional[float] = None, store=None) -> dict:
    """Mode S minus MEPS over the last `days` days (cached 10 min):
    levels: per pressure level T bias / SD / RMS, wind vector RMS, speed bias,
            D-value (height of the pressure surface) bias / SD;
    totals, day / night;  soundings: at each sounding the aircraft − sonde,
    aircraft − MEPS and MEPS area − MEPS Jokioinen temperature and wind."""
    now = time.time() if now is None else now
    key = (round(days, 2), busy, int(now // 600))
    if key in _check_cache:
        return _check_cache[key]
    t1 = int(now // 3600 * 3600)
    t0 = t1 - int(days * 86400)
    rows = hours(db, t0, t1 + 7200, VERIF_MAX_LEAD)
    out = {"days": days, "busy": busy, "hours_meps": len(rows), "levels": [], "totals": {}, "soundings": []}
    f = get()
    if f is not None:
        out["status"] = {"enabled": f.enabled, "last": {"ts": f.last[0], "result": f.last[1]} if f.last else None}
    try:
        nr = db.execute("SELECT MAX(run) FROM meps_hours").fetchone()[0]
        out["newest_run"] = nr
    except Exception:                                    # noqa: BLE001
        out["newest_run"] = None
    if not rows:
        _check_cache.clear(); _check_cache[key] = out
        return out
    P = next(iter(rows.values()))["p"]
    prof = {}
    for ts, data in db.execute("SELECT ts, data FROM profile_hours WHERE ts >= ? AND ts < ?", (t0, t1)):
        try:
            prof[ts] = json.loads(data)
        except ValueError:
            pass
    # GNSS heights of the pressure surfaces (D-values) per hour
    dv_by_h = {}
    try:
        from collector import gnss_heights as gh
        from collector.atmos import LAYER_EDGES
        cal = gh.current(db)
        cells = gh.cells_for_hours(db, t0, t1, lat, lon, radius_km, now=now)
        for h, cl in cells.items():
            pr = prof.get(h)
            if not pr:
                continue
            lv_t = {r[0]: r[1] for r in pr.get("lv") or [] if r[1] is not None}
            dv, _ = gh.column_products(cl, cal, lv_t, lat, lon)
            if len(dv) >= 2:
                cen = [(lo + LAYER_EDGES[LAYER_EDGES.index(lo) + 1]) / 2 for lo, *_ in dv]
                dv_by_h[h] = _at_levels(cen, [d for _, d, _, _ in dv], P)
    except Exception as exc:                             # noqa: BLE001
        log.debug("MEPS check heights: %s", exc)
    nL = len(P)
    acc = [{"t": [], "w": [], "s": [], "d": [], "dm": []} for _ in P]
    tot = {"all": [[], []], "day": [[], []], "night": [[], []]}
    n_hours = 0
    for h, pr in sorted(prof.items()):
        m = _hour_mean(rows, h)
        if m is None or pr.get("a", 0) < busy:
            continue
        a = modes_levels(pr.get("lv"), P)
        hh = (h // 3600) % 24
        part = "day" if 5 <= hh < 19 else "night"
        used = False
        for j in range(nL):
            if P[j] < 200 or P[j] > 925:
                continue
            if a["t"][j] is not None and m["t"][j] is not None:
                d = a["t"][j] - m["t"][j]
                acc[j]["t"].append(d); tot["all"][0].append(d); tot[part][0].append(d); used = True
            if None not in (a["u"][j], a["v"][j], m["u"][j], m["v"][j]):
                dw2 = (a["u"][j] - m["u"][j]) ** 2 + (a["v"][j] - m["v"][j]) ** 2
                acc[j]["w"].append(dw2); tot["all"][1].append(dw2); tot[part][1].append(dw2)
                acc[j]["s"].append(math.hypot(a["u"][j], a["v"][j]) - math.hypot(m["u"][j], m["v"][j]))
        dvh = dv_by_h.get(h)
        if dvh:
            for j in range(nL):
                if dvh[j] is not None and m["z"][j] is not None and 250 <= P[j] <= 850:
                    dmeps = _zgeom(m["z"][j], lat) - _isa_ft(P[j]) * 0.3048
                    acc[j]["d"].append(dvh[j] - dmeps); acc[j]["dm"].append((dvh[j], dmeps))
        n_hours += used

    def tstats(v):
        if not v:
            return None, None, None
        mu = sum(v) / len(v)
        sd = math.sqrt(sum((x - mu) ** 2 for x in v) / (len(v) - 1)) if len(v) > 1 else None
        return mu, sd, math.sqrt(sum(x * x for x in v) / len(v))

    for j, p in enumerate(P):
        A = acc[j]
        if not A["t"] and not A["w"]:
            continue
        tb, tsd, trms = tstats(A["t"])
        db_, dsd, _ = tstats(A["d"])
        r = None
        if len(A["dm"]) >= 5:
            xs, ys = [x for x, _ in A["dm"]], [y for _, y in A["dm"]]
            mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
            sx = math.sqrt(sum((x - mx) ** 2 for x in xs)); sy = math.sqrt(sum((y - my) ** 2 for y in ys))
            r = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy) if sx and sy else None
        out["levels"].append({
            "p": p, "ft": round(_isa_ft(p)), "n_t": len(A["t"]), "t_bias": _r(tb, 2), "t_sd": _r(tsd, 2), "t_rms": _r(trms, 2),
            "n_w": len(A["w"]), "w_rms": _r(math.sqrt(sum(A["w"]) / len(A["w"])), 1) if A["w"] else None,
            "ws_bias": _r(sum(A["s"]) / len(A["s"]), 1) if A["s"] else None,
            "n_d": len(A["d"]), "d_bias": _r(db_, 1), "d_sd": _r(dsd, 1), "d_r": _r(r, 3)})
    for k, (tv, wv) in tot.items():
        tb, tsd, trms = tstats(tv)
        out["totals"][k] = {"n_t": len(tv), "t_bias": _r(tb, 2), "t_rms": _r(trms, 2),
                            "w_rms": _r(math.sqrt(sum(wv) / len(wv)), 1) if wv else None}
    out["hours"] = n_hours
    out["soundings"], out["distance"] = _soundings(db, store, rows, prof, P, t0, t1)
    _check_cache.clear()
    _check_cache[key] = out
    return out


def _r(v, n):
    return None if v is None else round(v, n)


def _soundings(db, store, rows, prof, P, t0, t1):
    """Per sounding: aircraft − sonde, aircraft − MEPS (area), MEPS Jokioinen − sonde,
    MEPS area − MEPS Jokioinen (T K mean / RMS, wind RMS kt), 925–200 hPa."""
    if store is None:
        return [], None
    res, pool = [], {"as": [], "am": [], "res": [], "was": [], "wam": [], "wres": [], "c": [], "cw": []}
    for meta in store.items():
        launch = meta.get("launch") or meta.get("nominal")
        if launch is None or not (t0 <= launch < t1):
            continue
        h = int(launch // 3600 * 3600)
        MA, MJ = _hour_mean(rows, h, "a"), _hour_mean(rows, h, "j")
        if MA is None or MJ is None:
            continue
        rec = store.load(meta["key"])
        if not rec:
            continue
        S = _sonde_levels(rec, P)
        pr = prof.get(h)
        A = modes_levels(pr.get("lv"), P) if pr else None
        d = {"as": [], "am": [], "js": [], "aj": [], "was": [], "wam": [], "wjs": [], "waj": []}
        for j, p in enumerate(P):
            if p < 200 or p > 925:
                continue
            s, ma, mj = S["t"][j], MA["t"][j], MJ["t"][j]
            a = A["t"][j] if A else None
            if None not in (s, mj):
                d["js"].append(mj - s)
            if None not in (ma, mj):
                d["aj"].append(ma - mj)
            if None not in (a, s, ma, mj):
                d["as"].append(a - s); d["am"].append(a - ma)
                pool["as"].append(a - s); pool["am"].append(a - ma)
                pool["res"].append((a - s) - (ma - mj)); pool["c"].append((a - s, ma - mj))
            su, sv, mu, mv, ju, jv = S["u"][j], S["v"][j], MA["u"][j], MA["v"][j], MJ["u"][j], MJ["v"][j]
            au, av = (A["u"][j], A["v"][j]) if A else (None, None)
            if None not in (su, sv, ju, jv):
                d["wjs"].append((ju - su) ** 2 + (jv - sv) ** 2)
            if None not in (au, av, su, sv, mu, mv, ju, jv):
                d["was"].append((au - su) ** 2 + (av - sv) ** 2)
                d["wam"].append((au - mu) ** 2 + (av - mv) ** 2)
                pool["was"].append(d["was"][-1]); pool["wam"].append(d["wam"][-1])
                pool["wres"].append((au - su - (mu - ju)) ** 2 + (av - sv - (mv - jv)) ** 2)
                pool["cw"].append(((au - su, av - sv), (mu - ju, mv - jv)))
        mean = lambda v: _r(sum(v) / len(v), 2) if v else None
        wr = lambda v: _r(math.sqrt(sum(v) / len(v)), 1) if v else None
        res.append({"key": meta["key"], "ts": launch, "aircraft": (pr or {}).get("a"),
                    "t_as": mean(d["as"]), "t_am": mean(d["am"]), "t_js": mean(d["js"]), "t_aj": mean(d["aj"]),
                    "w_as": wr(d["was"]), "w_am": wr(d["wam"]), "w_js": wr(d["wjs"]), "n": len(d["as"])})
    res.sort(key=lambda r: -r["ts"])
    dist = None
    if len(pool["as"]) >= 10:
        rms = lambda v: math.sqrt(sum(x * x for x in v) / len(v))
        xs, ys = [a for a, _ in pool["c"]], [b for _, b in pool["c"]]
        mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
        sx = math.sqrt(sum((x - mx) ** 2 for x in xs)); sy = math.sqrt(sum((y - my) ** 2 for y in ys))
        dist = {"n": len(pool["as"]), "t_as": _r(rms(pool["as"]), 2), "t_am": _r(rms(pool["am"]), 2),
                "t_res": _r(rms(pool["res"]), 2),
                "t_corr": _r(sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy), 2) if sx and sy else None}
        if pool["was"]:
            wv = lambda v: math.sqrt(sum(v) / len(v))
            dist.update(w_as=_r(wv(pool["was"]), 1), w_am=_r(wv(pool["wam"]), 1), w_res=_r(wv(pool["wres"]), 1),
                        w_explained=_r(max(0.0, 1 - sum(pool["wres"]) / sum(pool["was"])), 2))
        dist["t_explained"] = _r(max(0.0, 1 - sum(x * x for x in pool["res"]) / sum(x * x for x in pool["as"])), 2)
    return res, dist
