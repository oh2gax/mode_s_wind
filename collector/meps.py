"""
collector/meps.py — MEPS model profiles for verification (from 2026-10-22).

MEPS (MetCoOp Ensemble Prediction System, 2.5 km; run by MET Norway, SMHI,
FMI and others) is the weather model FMI uses.  FMI's own open data has it
only as a surface grid, so the pressure levels come from MET Norway's open
archive (thredds.met.no, CC BY 4.0).  Every 3 h a new control run
(meps_mbr000_pl_YYYYMMDDTHHZ) appears about 2–3 h after its start time.

What is fetched (plain Python: urllib + the OPeNDAP binary format, no
netCDF / numpy needed): for each run the forecast hours +0 … +5 of
temperature, wind, geopotential, relative and specific humidity on the 10
pressure levels 1000 … 200 hPa, in a 300 × 300 km box around the receiver
sampled every 10 km (31 × 31 points, about 1.4 MB per run, about 11 MB a day).

What is stored (table meps_hours, one row per valid hour, about 2 kB):
  ts    valid time (UTC hour)          run   run start   lead  hours after it
  data  {"p": [200 … 1000 hPa], "n": points, "rad": km,
         "a": {"t": °C, "u": kt, "v": kt, "z": gpm, "rh": %, "q": g/kg}   area mean
         "j": {…}                                                          at Jokioinen}
The area is the sounding radius around the receiver (the same area as the
hourly Mode S profile), "j" the model column at the Jokioinen sounding
station (for the distance check).  Each hour keeps the shortest lead: +0 … +2
from its own run (the verification values); the newest run's +3 … +5 are
stored provisionally (shown on the Skew-T as a forecast, not used in the
verification) and replaced when the next run arrives.

Read side: profile() — the model profile at a time for the Skew-T (MEPS tick
box); check() — Mode S minus MEPS every hour by pressure level (temperature,
wind, heights of the pressure surfaces) and, at each sounding, how much of
the aircraft − sonde difference is the distance to Jokioinen (MEPS check view).

Optional config keys (read with defaults):
  MEPS_FETCH = True             fetch the model data
  MEPS_BACKFILL_DAYS = 3        days fetched at the first start
  MEPS_URL = "https://thredds.met.no/thredds/dodsC/meps25epsarchive"

Nothing else depends on it: when MET Norway cannot be reached the views say
the data is missing and the rest of the system works as before.
"""

from __future__ import annotations

import array
import json
import logging
import math
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
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
        if sys.byteorder == "little":
            a.byteswap()
        pos += n * size
        out[name.split(".")[-1]] = a
    return out


def _get(url: str, timeout: float = 90.0) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "MODE-S-Wind/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ── Table ───────────────────────────────────────────────────────────────────

def ensure_table(db) -> None:
    db.execute("""CREATE TABLE IF NOT EXISTS meps_hours (
                      ts   INTEGER PRIMARY KEY,   -- valid time (UTC hour)
                      run  INTEGER NOT NULL,      -- run start (UTC)
                      lead INTEGER NOT NULL,      -- hours after the run start
                      data TEXT    NOT NULL)""")
    db.commit()


# ── Fetching ────────────────────────────────────────────────────────────────

class MepsFetcher:
    """Background fetcher (thread target: run)."""

    def __init__(self, lat: float, lon: float, radius_km: float, base: str = BASE_URL,
                 backfill_days: float = 3.0, enabled: bool = True):
        self.lat, self.lon, self.radius = lat, lon, radius_km
        self.base = base.rstrip("/")
        self.backfill_days = backfill_days
        self.enabled = enabled
        self.grid = None             # (ix0, iy0, nx, ny) of the box in the model grid
        self.missing: dict = {}      # run → time it was last found missing
        self.last = None             # (time, text) of the last look
        self.newest_run = None

    def _url(self, run: int) -> str:
        tag = time.strftime("%Y%m%dT%HZ", time.gmtime(run))
        return f"{self.base}/{time.strftime('%Y/%m/%d/%H', time.gmtime(run))}/meps_mbr000_pl_{tag}.ncml"

    def _box(self, url: str):
        """Grid indices of the box around the receiver (from the run's own x / y axes)."""
        if self.grid is None:
            d = parse_dods(_get(url + ".dods?" + urllib.parse.quote("x,y", safe=",")))
            x, y = d["x"], d["y"]
            ex, ey = lcc_xy(self.lat, self.lon)
            ix = int(round((ex - x[0]) / (x[1] - x[0])))
            iy = int(round((ey - y[0]) / (y[1] - y[0])))
            if not (HALF <= ix < len(x) - HALF and HALF <= iy < len(y) - HALF) \
                    or abs(x[ix] - ex) > 2000 or abs(y[iy] - ey) > 2000:
                raise ValueError("receiver outside the MEPS grid or projection changed")
            self.grid = (ix - HALF, iy - HALF, len(x), len(y))
        return self.grid

    def fetch_run(self, db, run: int) -> int:
        """Fetch one run, store its hours; returns the rows written."""
        url = self._url(run)
        ix0, iy0, _, _ = self._box(url)
        sl = lambda a, n: f"[{a}:{STRIDE}:{a + 2 * HALF}]"
        box = f"[0:{LEADS - 1}][{LEV[0]}:{LEV[1]}]{sl(iy0, 0)}{sl(ix0, 0)}"
        cons = ",".join([f"time[0:{LEADS - 1}]", f"pressure[{LEV[0]}:{LEV[1]}]",
                         f"x{sl(ix0, 0)}", f"y{sl(iy0, 0)}"]
                        + [f"{v}.{v}{box}" for v, _ in VARS])
        d = parse_dods(_get(url + ".dods?" + urllib.parse.quote(cons, safe=",:.")))
        return self._store(db, run, d)

    def _store(self, db, run: int, d: dict) -> int:
        P = list(d["pressure"])
        xs, ys = list(d["x"]), list(d["y"])
        nl, ny, nx = len(P), len(ys), len(xs)
        nt = len(d["time"])
        # points of the area and their wind rotation (grid → true north)
        pts = []
        for j in range(ny):
            for i in range(nx):
                la, lo = lcc_latlon(xs[i], ys[j])
                if _km(self.lat, self.lon, la, lo) <= self.radius:
                    al = math.radians(_N * (lo - LCC_LON0))
                    pts.append((j * nx + i, math.cos(al), math.sin(al)))
        # Jokioinen: bilinear weights in the 10 km box
        jx, jy = lcc_xy(*JOKIOINEN)
        fx, fy = (jx - xs[0]) / (xs[1] - xs[0]), (jy - ys[0]) / (ys[1] - ys[0])
        jw = []
        if 0 <= fx < nx - 1 and 0 <= fy < ny - 1:
            i0, j0 = int(fx), int(fy)
            ax, ay = fx - i0, fy - j0
            alj = math.radians(_N * (JOKIOINEN[1] - LCC_LON0))
            jw = [(j0 * nx + i0, (1 - ax) * (1 - ay)), (j0 * nx + i0 + 1, ax * (1 - ay)),
                  ((j0 + 1) * nx + i0, (1 - ax) * ay), ((j0 + 1) * nx + i0 + 1, ax * ay)]
        if not pts:
            raise ValueError("no model points in the area")
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
            cur = db.execute(
                """INSERT INTO meps_hours (ts, run, lead, data) VALUES (?, ?, ?, ?)
                   ON CONFLICT(ts) DO UPDATE SET run = excluded.run, lead = excluded.lead, data = excluded.data
                   WHERE excluded.lead < meps_hours.lead
                      OR (excluded.lead = meps_hours.lead AND excluded.run >= meps_hours.run)""",
                (valid, run, lead, json.dumps(row, separators=(",", ":"))))
            written += cur.rowcount
        db.commit()
        return written

    def due_runs(self, db, now: float, span_h: float) -> list:
        """Runs (newest first) whose hours +0 … +2 are not all stored with their own lead."""
        newest = int(now // (RUN_STEP_H * 3600)) * RUN_STEP_H * 3600
        runs = [newest - k * RUN_STEP_H * 3600 for k in range(int(span_h // RUN_STEP_H) + 1)]
        ensure_table(db)
        have = dict(db.execute("SELECT ts, lead FROM meps_hours WHERE ts >= ?", (runs[-1],)).fetchall())
        out = []
        for r in runs:
            if all(have.get(r + h * 3600, 99) <= h for h in range(VERIF_MAX_LEAD + 1)):
                continue
            seen = self.missing.get(r)
            if seen is not None:
                wait = RETRY_RECENT_SEC if r > now - 12 * 3600 else 24 * 3600
                if now - seen < wait:
                    continue
            out.append(r)
        return out

    def cycle(self, db, first: bool = False) -> int:
        now = time.time()
        span = max(self.backfill_days * 24, 30) if first else 30
        n_runs = n_rows = 0
        for r in self.due_runs(db, now, span)[:MAX_PER_CYCLE]:
            try:
                n_rows += self.fetch_run(db, r)
                n_runs += 1
                self.missing.pop(r, None)
                self.newest_run = max(self.newest_run or 0, r)
            except urllib.error.HTTPError as exc:
                if exc.code in (400, 404):               # not (yet) published
                    self.missing[r] = now
                    continue
                raise
            time.sleep(1.0)
        self.last = (time.time(), f"{n_runs} run(s), {n_rows} hour(s) stored")
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
                            enabled=bool(getattr(cfg, "MEPS_FETCH", True)))
    return _instance


def get() -> Optional[MepsFetcher]:
    return _instance


# ── Read side ───────────────────────────────────────────────────────────────

def hours(db, t0: float, t1: float, max_lead: int = 99) -> dict:
    """{valid ts: row dict + "run", "lead"} for t0 ≤ ts < t1."""
    out = {}
    try:
        for ts, run, lead, data in db.execute(
                "SELECT ts, run, lead, data FROM meps_hours WHERE ts >= ? AND ts < ? AND lead <= ?",
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
    for n in ("t", "u", "v", "z", "rh", "q"):
        va, vb = a[key].get(n) or [], b[key].get(n) or []
        out[n] = [None if x is None or y is None else x * (1 - w) + y * w for x, y in zip(va, vb)]
    return out


def column_at(db, at: float, key: str = "a", max_lead: int = 99):
    """The model column (area "a" or Jokioinen "j") at time `at`, linear in
    time between the hours around it: (column dict, info) or (None, None)."""
    h = int(at // 3600 * 3600)
    rows = hours(db, h - 3600, h + 7200, max_lead)
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
    info["p"] = (a or b)["p"]
    info["n"] = (a or b).get("n")
    info["rad"] = (a or b).get("rad")
    return col, info


def profile(db, at: float) -> dict:
    """Model profile for the Skew-T (area mean) at time `at`."""
    col, info = column_at(db, at)
    if col is None:
        newest = None
        try:
            newest = db.execute("SELECT MAX(ts) FROM meps_hours").fetchone()[0]
        except Exception:                                # noqa: BLE001
            pass
        return {"found": False, "at": at, "newest": newest}
    levels = []
    for i, p in enumerate(info["p"]):
        t, u, v, z, rh, q = (col[n][i] for n in ("t", "u", "v", "z", "rh", "q"))
        if t is None:
            continue
        lv = {"pressure": p, "temp": round(t, 2), "z_m": round(z, 1) if z is not None else None,
              "rh": round(rh, 1) if rh is not None else None}
        td = _dewpoint(q, p, t) if q is not None else None
        lv["dewpoint"] = round(td, 2) if td is not None else None
        if u is not None and v is not None:
            lv["wind_spd"] = round(math.hypot(u, v), 1)
            lv["wind_dir"] = round(math.degrees(math.atan2(-u, -v)) % 360, 0)
        levels.append(lv)
    levels.sort(key=lambda l: -l["pressure"])
    return {"found": True, "at": at, "run": info["run"], "lead": info["lead"],
            "provisional": info["lead"] > VERIF_MAX_LEAD, "points": info["n"], "radius_km": info["rad"],
            "levels": levels, "source": "MEPS (MET Norway, CC BY 4.0)"}


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
