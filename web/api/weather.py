"""
web/api/weather.py — the Weather page: MEPS surface maps (from 2026-10-23).

The `meps` thread (collector/meps.py, kind "wx") stores per valid hour the
model's sea-level pressure, the rain and the snow of the hour ending then,
total, low, medium and high cloud, fog and the cloud base on a 10 km grid
over the MEPS area (table meps_wx_hours; compressed int16 planes, 7 days of
history plus the newest forecast up to +48 h).

index()  — the stored hours (ts, run, lead) and the grid, for the time slider.
point()  — (from 2026-11-01, the Live Map's airport weather box) all the fields
           of the hour containing now at one place: the 2.5 km box's nearest
           cell when it has that hour of the same run, else the 10 km grid's.
frames() — the fields of chosen hours for the browser, on the 10 km grid or
           averaged to 20 / 40 km (step 2 / 4) to keep the download small:
           p = (hPa − 1000) × 10, r / s = mm × 100 (rain / snow of the hour),
           c / l / m / h = total / low / medium / high cloud %, f = fog %,
           b = cloud base m, u / v = 10 m wind towards east / north (kt),
           g = 10 m gust (kt; hours stored from 24 Oct 2026), t = 2 m
           temperature (°C × 10, whole degrees; hours stored from 1 Nov 2026;
           the 20 / 40 km means in tenths), t8 = 850 hPa temperature (°C × 10;
           the 10 km grid and GFS, hours stored from 7 Nov 2026), as plain integer
           lists (null = missing); only the fields asked for (default p, r,
           s, c).  Averaged blocks take the mean, the gust the block maximum.
The page draws them itself (static/js/weather.js), so the Pi only reads,
decompresses and averages.

bbox (from 2026-10-30, the phone's Weather view): only the part of the grid
that covers lat0, lon0, lat1, lon1 (whole step blocks, so the averaging is
the same as without it) — a third or less of the download.

fine (from 2026-10-31): the same fields on the full 2.5 km MEPS grid in a box
around the receiver (table meps_wx25_hours, MEPS_WX_FINE_KM, 300 km by
default), for the detail of the Weather page and the phone when zoomed in;
index() lists its hours as "fine" and frames(..., fine=True) sends them
(step and bbox do not apply).

model "gfs" (from 2026-11-05; collector/gfs.py, GFS_WX on): the same answers
from the GFS forecast to +384 h (table gfs_wx_hours in its own file — the
caller passes that connection): a regular 0.25° lat / lon grid (grid "proj":
"latlon", x = longitude, y = latitude, rows south to north), the same field
codes without fog, "b" the cloud ceiling; index rows [ts, run, lead, 1, pi]
with pi the hours of the step (1 to +120 h, then 3: r / s are then the mean
mm per hour of the 3 h).  For viewing only.
"""

from __future__ import annotations

import array
import json
import sys
import time
import zlib
from math import atan2, cos, degrees, pi, radians, sin, tan

FILL = -32768
GFS_SOURCE = "GFS (NOAA/NCEP)"
GFS_TABLE = "gfs_wx_hours"
FIELDS = ("p", "r", "s", "c", "l")    # the fields of rows without a field list (first version)
ALL = ("p", "r", "s", "c", "l", "m", "h", "f", "b", "u", "v", "g", "t", "t8",   # t: 2 m temperature (from 2026-11-01),
       "td", "vi", "zl", "ca", "u8", "v8")                                     # t8: 850 hPa temperature (from 2026-11-07);
# the meteograms' extras (from 2026-11-07 afternoon): td dew point °C × 10, vi visibility 100 m, zl freezing
# level m, ca CAPE J/kg, u8 / v8 850 hPa wind kt — with MEPS on the 10 km grid only (also where the 2.5 km
# cell gives the rest)
GRID10_ONLY = ("t8", "td", "vi", "zl", "ca", "u8", "v8")
BLOCK_MAX = ("g",)                    # averaged blocks: the strongest gust, not the mean
SEND = ("p", "r", "s", "c")          # default


def index_gfs(gdb) -> dict:
    """The GFS hours (model "gfs") and their grid; empty when not configured."""
    out = {"hours": [], "grid": None, "model": "gfs", "source": GFS_SOURCE, "fine": {"hours": [], "grid": None}}
    if gdb is None:
        out["error"] = "GFS is not configured on this server (GFS_WX)"
        return out
    try:
        rows = gdb.execute("SELECT ts, run, lead, meta FROM gfs_wx_hours ORDER BY ts").fetchall()
    except Exception:                                    # noqa: BLE001  (table missing)
        return out
    hs, grid = [], None
    for ts, run, lead, meta in rows:
        m = json.loads(meta)
        hs.append([ts, run, lead, 1, int(m.get("pi") or 1)])
        grid = m
    out["hours"] = hs
    if grid:
        out["grid"] = {k: grid[k] for k in ("proj", "x", "y", "f") if k in grid}
    return out


def index(db) -> dict:
    try:
        # [ts, run, lead, 1 when the hour has the 10 m wind] — a page reloads an
        # hour whose wind arrived later (same run and lead, fetched again)
        rows = db.execute("SELECT ts, run, lead, instr(meta, '\"u\"') > 0 FROM meps_wx_hours ORDER BY ts").fetchall()
        meta = db.execute("SELECT meta FROM meps_wx_hours ORDER BY ts DESC LIMIT 1").fetchone()
    except Exception:                                    # noqa: BLE001  (table missing)
        return {"hours": [], "grid": None}
    out = {"hours": [[ts, run, lead, 1 if w else 0] for ts, run, lead, w in rows],
           "grid": json.loads(meta[0]) if meta else None,
           "source": "MEPS (MET Norway, CC BY 4.0)"}
    # the 2.5 km box: [[ts, run, lead], …] and its grid (none when not fetched)
    try:
        frows = db.execute("SELECT ts, run, lead FROM meps_wx25_hours ORDER BY ts").fetchall()
        fmeta = db.execute("SELECT meta FROM meps_wx25_hours ORDER BY ts DESC LIMIT 1").fetchone()
        out["fine"] = {"hours": [list(r) for r in frows], "grid": json.loads(fmeta[0]) if fmeta else None}
    except Exception:                                    # noqa: BLE001  (table missing)
        out["fine"] = {"hours": [], "grid": None}
    return out


def _decode(meta: dict, blob: bytes):
    a = array.array("h")
    a.frombytes(zlib.decompress(blob))
    if sys.byteorder != "little":
        a.byteswap()
    n = meta["x"][2] * meta["y"][2]
    fields = meta.get("f") or list(FIELDS)
    if len(a) != n * len(fields):
        return None
    return {f: a[i * n:(i + 1) * n] for i, f in enumerate(fields)}


def _mean(t):
    v = [x for x in t if x != FILL]
    return round(sum(v) / len(v)) if v else None


def _block(plane, nx: int, ny: int, step: int, use_max: bool = False):
    """Mean (or maximum) of step × step blocks (missing values left out);
    None where all missing."""
    if step == 1:
        return [None if v == FILL else int(v) for v in plane]
    mx, my = nx // step, ny // step
    k = step * step
    full = FILL not in plane
    out = []
    for J in range(my):
        rows = [plane[(J * step + j) * nx:(J * step + j + 1) * nx] for j in range(step)]
        cols = [row[i::step][:mx] for row in rows for i in range(step)]
        if use_max:
            out.extend((max(t) if full else max((x for x in t if x != FILL), default=None))
                       for t in zip(*cols))
        elif full:                             # the usual case: plain sums
            out.extend(round(sum(t) / k) for t in zip(*cols))
        else:
            out.extend(_mean(t) for t in zip(*cols))
    return out




# The MEPS Lambert projection (as static/js/wx_layer.js and collector/meps.py):
# sphere R 6371 km, one standard parallel 63.3° N, central meridian 15° E
_R, _LAT1, _LON0 = 6371000.0, radians(63.3), 15.0
_N = sin(_LAT1)
_F = cos(_LAT1) * tan(pi / 4 + _LAT1 / 2) ** _N / _N
_RHO0 = _R * _F / tan(pi / 4 + _LAT1 / 2) ** _N


def _lcc_xy(lat: float, lon: float):
    rho = _R * _F / tan(pi / 4 + radians(lat) / 2) ** _N
    th = _N * radians(lon - _LON0)
    return rho * sin(th), _RHO0 - rho * cos(th)


_point_cache: dict = {}       # (table, ts, run, lead, lat, lon) → values


def point_gfs(gdb, lat: float, lon: float, now: float = None) -> dict:
    """point() from the GFS hours (model "gfs"): the hour containing now (or the
    next stored one) at the nearest 0.25° cell."""
    now = time.time() if now is None else now
    if gdb is None:
        return {"error": "GFS is not configured on this server (GFS_WX)"}
    try:
        r = (gdb.execute("SELECT ts, run, lead, meta, data FROM gfs_wx_hours WHERE ts >= ? ORDER BY ts LIMIT 1",
                         (int(now),)).fetchone())
    except Exception:                                    # noqa: BLE001
        r = None
    if not r:
        return {"error": "no GFS hours stored yet"}
    ts, run, lead, meta, data = r
    key = (GFS_TABLE, ts, run, lead, round(lat, 4), round(lon, 4))
    hit = _point_cache.get(key)
    m = json.loads(meta)
    if hit is None:
        planes = _decode(m, data)
        if planes is None:
            return {"error": "GFS hour not readable"}
        (x0, dx, nx), (y0, dy, ny) = m["x"], m["y"]
        i, j = round((lon - x0) / dx), round((lat - y0) / dy)
        if not (0 <= i < nx and 0 <= j < ny):
            return {"error": "the place is outside the GFS area", "ts": ts, "run": run, "lead": lead}
        k = j * nx + i
        hit = {f: int(planes[f][k]) for f in ALL if f in planes and planes[f][k] != FILL}
        if len(_point_cache) > 64:
            _point_cache.clear()
        _point_cache[key] = hit
    return {"ts": ts, "run": run, "lead": lead, "deg": m["x"][1], "pi": int(m.get("pi") or 1), "v": hit,
            "source": GFS_SOURCE}


def point(db, lat: float, lon: float, now: float = None) -> dict:
    """All the fields (ALL, as frames() encodes them) of the model hour that
    contains now — the hour ending at the next full hour, as the Live Map's
    overlay — at the nearest grid cell of (lat, lon): from the 2.5 km box when
    it has that hour of the same run, else from the 10 km grid.  {ts, run, lead,
    km, v: {field: value}}, or {error}."""
    now = time.time() if now is None else now
    try:
        r = (db.execute("SELECT ts, run, lead FROM meps_wx_hours WHERE ts >= ? ORDER BY ts LIMIT 1", (int(now),)).fetchone()
             or db.execute("SELECT ts, run, lead FROM meps_wx_hours ORDER BY ts DESC LIMIT 1").fetchone())
    except Exception:                                    # noqa: BLE001  (table missing)
        r = None
    if not r:
        return {"error": "no MEPS weather maps stored yet"}
    ts, run, lead = r
    x, y = _lcc_xy(lat, lon)
    for table, km in (("meps_wx25_hours", 2.5), ("meps_wx_hours", 10)):
        key = (table, ts, run, lead, round(lat, 4), round(lon, 4))
        hit = _point_cache.get(key)
        if hit is None:
            try:
                row = db.execute(f"SELECT run, lead, meta, data FROM {table} WHERE ts = ?", (ts,)).fetchone()
            except Exception:                            # noqa: BLE001  (table missing)
                row = None
            if not row or row[0] != run:
                continue                                 # the 2.5 km box only of the same run
            meta = json.loads(row[2])
            planes = _decode(meta, row[3])
            if planes is None:
                continue
            (x0, dx, nx), (y0, dy, ny) = meta["x"], meta["y"]
            i, j = round((x - x0) / dx), round((y - y0) / dy)
            if not (0 <= i < nx and 0 <= j < ny):
                continue                                 # outside this grid
            k = j * nx + i
            hit = {f: int(planes[f][k]) for f in ALL if f in planes and planes[f][k] != FILL}
            if len(_point_cache) > 64:
                _point_cache.clear()
            _point_cache[key] = hit
        return {"ts": ts, "run": run, "lead": lead, "km": km, "v": hit,
                "source": "MEPS (MET Norway, CC BY 4.0)"}
    return {"error": "the place is outside the MEPS area", "ts": ts, "run": run, "lead": lead}


def _window(meta: dict, bbox, step: int):
    """The grid indices [i0, i1) × [j0, j1) that cover bbox (lat0, lon0, lat1,
    lon1), on whole step blocks; None = the whole grid."""
    if not bbox:
        return None
    x0, dx, nx = meta["x"]
    y0, dy, ny = meta["y"]
    la0, lo0, la1, lo1 = bbox
    xs, ys = [], []
    if meta.get("proj") == "latlon":          # GFS: x = longitude, y = latitude
        xs, ys = [lo0, lo1], [la0, la1]
    for k in (range(9) if meta.get("proj") != "latlon" else ()):   # the edges, not only the corners (curved)
        f = k / 8
        for la, lo in ((la0, lo0 + (lo1 - lo0) * f), (la1, lo0 + (lo1 - lo0) * f),
                       (la0 + (la1 - la0) * f, lo0), (la0 + (la1 - la0) * f, lo1)):
            x, y = _lcc_xy(la, lo)
            xs.append(x)
            ys.append(y)
    fi = sorted(((min(xs) - x0) / dx, (max(xs) - x0) / dx))
    fj = sorted(((min(ys) - y0) / dy, (max(ys) - y0) / dy))
    i0 = max(0, int(fi[0] // step) * step)
    j0 = max(0, int(fj[0] // step) * step)
    i1 = min((nx // step) * step, (int(fi[1] // step) + 1) * step)
    j1 = min((ny // step) * step, (int(fj[1] // step) + 1) * step)
    if i1 - i0 < step or j1 - j0 < step:
        return None
    return i0, i1, j0, j1


def _crop(plane, nx: int, win):
    i0, i1, j0, j1 = win
    out = array.array("h")
    for j in range(j0, j1):
        out.extend(plane[j * nx + i0:j * nx + i1])
    return out


# ── Meteogram (from 2026-11-05): every stored hour of a model at one place ──────
# One answer per (model, cell, the hours with their run / lead): a repeated view is
# instant, a new run gives other keys.  Reading a series means decompressing each
# hour (about 2 ms for a MEPS hour of the whole area), so the answer is cached.
_mg_cache: "OrderedDict" = None
_MG_MAX = 48


def _lcc_latlon(x: float, y: float):
    """The inverse of _lcc_xy: (lat, lon) of MEPS grid coordinates."""
    from math import atan, atan2, degrees, hypot
    rho = hypot(x, _RHO0 - y)
    th = atan2(x, _RHO0 - y)
    lat = degrees(2 * atan((_R * _F / rho) ** (1 / _N)) - pi / 2)
    return lat, _LON0 + degrees(th / _N)


def _cell_values(meta: dict, blob: bytes, k: int) -> dict:
    """The fields of grid index k of one stored hour (only that cell is read after
    the decompression)."""
    raw = zlib.decompress(blob)
    n = meta["x"][2] * meta["y"][2]
    fields = meta.get("f") or list(FIELDS)
    if len(raw) != 2 * n * len(fields):
        return {}
    out = {}
    for i, f in enumerate(fields):
        off = 2 * (i * n + k)
        v = int.from_bytes(raw[off:off + 2], "little", signed=True)
        if v != FILL:
            out[f] = v
    return out


def meteogram(db, lat: float, lon: float, model: str = "meps", past_h: float = 24, fc_h: float = 400,
              now: float = None) -> dict:
    """The time series of every field at the grid cell nearest (lat, lon): MEPS
    (db = the main database; the 2.5 km cell inside its box when the hour has the
    same run there, else the 10 km cell) or GFS (db = the GFS file), the hours from
    now − past_h to now + fc_h.  Values in the frames' encoding (p (hPa − 1000) × 10,
    t °C × 10, r / s mm per hour × 100, u / v / g kt, c / l / m / h / f %, b m);
    None = missing.  {model, lat, lon, cell, ts, run, lead, pi, fine, v: {field: [...]},
    runs, source}."""
    global _mg_cache
    from collections import OrderedDict as _OD
    if _mg_cache is None:
        _mg_cache = _OD()
    now = time.time() if now is None else now
    t0, t1 = int(now - past_h * 3600), int(now + fc_h * 3600)
    gfs = model == "gfs"
    table = GFS_TABLE if gfs else "meps_wx_hours"
    if db is None:
        return {"error": "GFS is not configured on this server (GFS_WX)" if gfs else "no database"}
    try:
        hours = db.execute(f"SELECT ts, run, lead FROM {table} WHERE ts >= ? AND ts <= ? ORDER BY ts", (t0, t1)).fetchall()
        meta_row = db.execute(f"SELECT meta FROM {table} ORDER BY ts DESC LIMIT 1").fetchone()
    except Exception:                                    # noqa: BLE001  (table missing)
        hours, meta_row = [], None
    if not hours or not meta_row:
        return {"error": f"no {'GFS' if gfs else 'MEPS'} hours stored for this period", "model": model}
    meta = json.loads(meta_row[0])
    (x0, dx, nx), (y0, dy, ny) = meta["x"], meta["y"]
    if gfs:
        i, j = round((lon - x0) / dx), round((lat - y0) / dy)
    else:
        x, y = _lcc_xy(lat, lon)
        i, j = round((x - x0) / dx), round((y - y0) / dy)
    if not (0 <= i < nx and 0 <= j < ny):
        return {"error": f"the place is outside the {'GFS' if gfs else 'MEPS'} area", "model": model}
    k = j * nx + i
    if gfs:
        clat, clon = y0 + j * dy, x0 + i * dx
    else:
        clat, clon = _lcc_latlon(x0 + i * dx, y0 + j * dy)
    # MEPS: the 2.5 km box's cell of the place, when inside the box
    fine = {}
    fk = None
    if not gfs:
        try:
            fm = db.execute("SELECT meta FROM meps_wx25_hours ORDER BY ts DESC LIMIT 1").fetchone()
        except Exception:                                # noqa: BLE001
            fm = None
        if fm:
            fmeta = json.loads(fm[0])
            (fx0, fdx, fnx), (fy0, fdy, fny) = fmeta["x"], fmeta["y"]
            fi, fj = round((x - fx0) / fdx), round((y - fy0) / fdy)
            if 0 <= fi < fnx and 0 <= fj < fny:
                fk = fj * fnx + fi
                try:
                    fine = {ts: (run, lead) for ts, run, lead in
                            db.execute("SELECT ts, run, lead FROM meps_wx25_hours WHERE ts >= ? AND ts <= ?", (t0, t1))}
                except Exception:                        # noqa: BLE001
                    fine = {}
    key = (model, k, fk, tuple(hours), tuple(sorted((t, r) for t, (r, _) in fine.items())))
    with _lock:
        hit = _mg_cache.get(key)
        if hit is not None:
            _mg_cache.move_to_end(key)
            return hit
    out = {"model": model, "lat": lat, "lon": lon,
           "cell": {"lat": round(clat, 4), "lon": round(clon, 4),
                    "grid": "0.25°" if gfs else "10 km", "fine_grid": "2.5 km" if fk is not None else None},
           "ts": [], "run": [], "lead": [], "pi": [], "fine": [], "v": {f: [] for f in ALL},
           "source": GFS_SOURCE if gfs else "MEPS (MET Norway, CC BY 4.0)"}
    for ts, run, lead in hours:
        vals, used_fine = None, 0
        if fk is not None and fine.get(ts, (None,))[0] == run:
            r = db.execute("SELECT meta, data FROM meps_wx25_hours WHERE ts = ?", (ts,)).fetchone()
            if r:
                vals = _cell_values(json.loads(r[0]), r[1], fk)
                used_fine = 1 if vals else 0
                if vals and any(vals.get(f) is None for f in GRID10_ONLY):   # on the 10 km grid only
                    r10 = db.execute(f"SELECT meta, data FROM {table} WHERE ts = ?", (ts,)).fetchone()
                    if r10:
                        m10 = json.loads(r10[0])
                        if (m10["x"], m10["y"]) == (meta["x"], meta["y"]):
                            v10 = _cell_values(m10, r10[1], k)
                            vals = dict(vals, **{f: v10.get(f) for f in GRID10_ONLY if vals.get(f) is None})
        if not vals:
            r = db.execute(f"SELECT meta, data FROM {table} WHERE ts = ?", (ts,)).fetchone()
            if not r:
                continue
            m = json.loads(r[0])
            vals = _cell_values(m, r[1], k) if (m["x"], m["y"]) == (meta["x"], meta["y"]) else {}
        out["ts"].append(ts)
        out["run"].append(run)
        out["lead"].append(lead)
        out["pi"].append((1 if lead <= 120 else 3) if gfs else 1)
        out["fine"].append(used_fine)
        for f in ALL:
            out["v"][f].append(vals.get(f))
    out["v"] = {f: a for f, a in out["v"].items() if any(x is not None for x in a)}
    out["runs"] = sorted(set(out["run"]))
    with _lock:
        _mg_cache[key] = out
        while len(_mg_cache) > _MG_MAX:
            _mg_cache.popitem(last=False)
    return out


# ── The measured 850 hPa temperature (from 2026-11-07) ──────────────────────────
# MODE-S Wind's own hourly area profile (profile_hours, collector/atmos.py: the
# median temperature of the aircraft in 1 000-ft layers of pressure altitude within
# SOUNDING_RADIUS_KM of the receiver).  850 hPa is the ISA pressure altitude
# 4 781 ft (Mode S altitudes are referenced to 1013.25 hPa, so this is the measured
# static pressure), between the centres of the layers 4 000–5 000 and 5 000–6 000 ft.
T850_ALT_FT = 4781.0
T850_MIN_N = 3                         # temperatures in each of the two layers


def measured_850(db, lat: float, lon: float, t0: float, t1: float, rlat: float, rlon: float) -> list:
    """[[hour middle ts, °C, values], …] of the hourly profiles from t0 to t1 at a
    place within the profile radius of the receiver (else [])."""
    if db is None:
        return []
    try:
        rows = db.execute("SELECT ts, data FROM profile_hours WHERE ts >= ? AND ts < ? ORDER BY ts",
                          (int(t0) - 3600, int(t1))).fetchall()
    except Exception:                                    # noqa: BLE001  (no such table)
        return []
    lo_c, hi_c = 4500.0, 5500.0
    f = (T850_ALT_FT - lo_c) / (hi_c - lo_c)
    out, near = [], None
    for ts, data in rows:
        try:
            d = json.loads(data)
        except (TypeError, ValueError):
            continue
        if near is None:
            near = _dist_km(lat, lon, rlat, rlon) <= float(d.get("r") or 150.0)
            if not near:
                return []
        lv = {row[0]: row for row in d.get("lv") or [] if row}
        a, b = lv.get(4000), lv.get(5000)
        if not a or not b or a[1] is None or b[1] is None or (a[4] or 0) < T850_MIN_N or (b[4] or 0) < T850_MIN_N:
            continue
        out.append([int(ts) + 1800, round(a[1] + f * (b[1] - a[1]), 1), int(a[4]) + int(b[4])])
    return out


# ── The meteograms' observations (from 2026-11-07 afternoon) ──────────────────────
OBS_APT_KM = 20.0                      # METAR and the landings' winds: places this near the airport
LW_HEIGHTS = (1000, 2000)              # the landings' band winds, ft above the runway
_obs_cache: dict = {}


def observed(db, lat: float, lon: float, t0: float, t1: float, rlat: float, rlon: float,
             alat: float, alon: float, station: str = "EFHK") -> dict:
    """What MODE-S Wind measured in the past hours of a meteogram:
      o850   [[hour middle, °C, values]] the 850 hPa temperature (measured_850)
      o850w  [[hour middle, dir, kt, values]] the 850 hPa wind of the same layers
      ozl    [[hour middle, ft MSL, sfc]] the freezing level — the highest 0 °C crossing of
             the METAR surface, the airport's climb-out / landing bands (bl_hours) and the area
             layers above (pressure altitude + 27.5 ft per hPa of QNH − 1013.25); sfc 1 when the
             whole column is below 0 °C (then ft = the airport)
      metar  [[ts, tt, td, wdir, wspd, wgst, qnh, vis m, ceiling ft, raw]] the airport's METARs
      lw     [[hour middle, ft above the runway, dir, kt, landings]] the hour's median band wind
             of the landings (approach_history) at 1 000 and 2 000 ft above their runway
    the first three for places within the profile radius of the receiver, the last two within
    OBS_APT_KM of the airport (else empty lists).  Kept 5 minutes."""
    key = (round(lat, 3), round(lon, 3), int(t0 // 300), int(t1 // 300))
    hit = _obs_cache.get(key)
    if hit is not None:
        return hit
    out = {"o850": [], "o850w": [], "ozl": [], "metar": [], "lw": []}
    if db is None:
        return out
    from web.api import pilot as _p
    near_apt = _dist_km(lat, lon, alat, alon) <= OBS_APT_KM
    # the METARs (also the surface of the freezing level)
    mets = []
    try:
        mets = db.execute("SELECT ts, tt, td, wdir, wspd, wgst, qnh, vis, cld, raw FROM metar_reports WHERE station = ? "
                          "AND kind IN ('METAR', 'SPECI') AND ts >= ? AND ts <= ? ORDER BY ts",
                          (station, int(t0) - 3600, int(t1))).fetchall()
    except Exception:                                    # noqa: BLE001
        mets = []
    if near_apt:
        out["metar"] = [[int(r[0]), r[1], r[2], r[3], r[4], r[5], r[6], r[7], _ceiling_ft(r[8]), r[9]]
                        for r in mets if r[0] >= t0]
    # the hourly profiles
    try:
        rows = db.execute("SELECT ts, data FROM profile_hours WHERE ts >= ? AND ts < ? ORDER BY ts",
                          (int(t0) - 3600, int(t1))).fetchall()
        bls = dict(db.execute("SELECT ts, data FROM bl_hours WHERE ts >= ? AND ts < ?", (int(t0) - 3600, int(t1))).fetchall())
    except Exception:                                    # noqa: BLE001
        rows, bls = [], {}
    near_rx = None
    f8 = (T850_ALT_FT - 4500.0) / 1000.0
    mi = 0
    for ts, data in rows:
        try:
            d = json.loads(data)
        except (TypeError, ValueError):
            continue
        if near_rx is None:
            near_rx = _dist_km(lat, lon, rlat, rlon) <= float(d.get("r") or 150.0)
        if not near_rx:
            break
        lv = {row[0]: row for row in d.get("lv") or [] if row}
        a, b = lv.get(4000), lv.get(5000)
        mid = int(ts) + 1800
        if a and b and a[1] is not None and b[1] is not None and (a[4] or 0) >= T850_MIN_N and (b[4] or 0) >= T850_MIN_N:
            out["o850"].append([mid, round(a[1] + f8 * (b[1] - a[1]), 1), int(a[4]) + int(b[4])])
        if a and b and a[6] is not None and b[6] is not None and (a[8] or 0) >= T850_MIN_N and (b[8] or 0) >= T850_MIN_N:
            ua, va = _uv(a[5], a[6])
            ub, vb = _uv(b[5], b[6])
            u, v = ua + f8 * (ub - ua), va + f8 * (vb - va)
            out["o850w"].append([mid, round((degrees(atan2(-u, -v)) + 360) % 360), round((u * u + v * v) ** 0.5, 1),
                                 int(a[8]) + int(b[8])])
        # the freezing level of the hour: the METAR surface, the airport's bands, the area layers
        while mi + 1 < len(mets) and mets[mi + 1][0] <= ts + 3600:
            mi += 1
        m = mets[mi] if mets and mets[mi][0] <= ts + 3600 and mets[mi][0] >= ts - 3600 else None
        try:
            bl = json.loads(bls.get(ts) or "null") or {}
        except (TypeError, ValueError):
            bl = {}
        qnh = (m[6] if m else None) or bl.get("q") or 1013.25
        pts = [(_p.APT_FT, m[1])] if m and m[1] is not None else []
        pts += [(x[0], x[1]) for x in bl.get("t") or [] if x[1] is not None and x[0] > _p.APT_FT + 50]
        top = pts[-1][0] if pts else 0
        dz = (qnh - 1013.25) * 27.5
        pts += [(row[0] + (500 if row[0] < 10000 else 1000) + dz, row[1]) for row in d.get("lv") or []
                if row and row[1] is not None and (row[4] or 0) >= 3 and row[0] + 500 + dz > top + 300 and row[0] < 20000]
        pts.sort()
        if len(pts) >= 2:
            fl = _freezing_level(pts, _p.APT_FT)
            if fl is not None:
                out["ozl"].append([mid, fl[0], fl[1]])
    # the landings' band winds at 1 000 and 2 000 ft above their runway, per hour
    if near_apt:
        try:
            L = db.execute("SELECT ts, runway, bands_json FROM approach_history WHERE ts >= ? AND ts <= ? ORDER BY ts",
                           (int(t0), int(t1))).fetchall()
        except Exception:                                # noqa: BLE001
            L = []
        hours: dict = {}
        for ts, rwy, bj in L:
            try:
                bands = json.loads(bj) if bj else None
            except (TypeError, ValueError):
                continue
            for h in LW_HEIGHTS:
                w = _p._band_wind(bands, h + _p._thr(rwy), near=100.0)
                if w:
                    hours.setdefault((int(ts // 3600 * 3600), h), []).append(_uv(w[0], w[1]))
        for (hh, h), uv in sorted(hours.items()):
            us, vs = sorted(x[0] for x in uv), sorted(x[1] for x in uv)
            n = len(uv)
            med = lambda a: a[n // 2] if n % 2 else 0.5 * (a[n // 2 - 1] + a[n // 2])
            u, v = med(us), med(vs)
            out["lw"].append([hh + 1800, h, round((degrees(atan2(-u, -v)) + 360) % 360), round((u * u + v * v) ** 0.5, 1), n])
    if len(_obs_cache) > 64:
        _obs_cache.clear()
    _obs_cache[key] = out
    return out


def _freezing_level(pts: list, ground_ft: float):
    """(ft, at the ground) of a measured profile [(ft MSL, °C)] going up: the top of the
    highest layer above 0 °C — the one from the ground, or one aloft that reaches at least
    +0.5 °C (the medians of an almost isothermal layer near 0 °C can wobble around it);
    (ground, 1) when the whole column is below 0 °C from the ground; None otherwise."""
    runs, cur = [], None
    for i, (z, t) in enumerate(pts):
        if t > 0:
            if cur is None:
                cur = {"i0": i, "max": t}
            cur["max"], cur["i1"] = max(cur["max"], t), i
        elif cur is not None:
            runs.append(cur)
            cur = None
    if cur is not None:
        return None                                      # above 0 °C at the top: the level is higher
    keep = [r for r in runs if r["i0"] == 0 or r["max"] >= 0.5]
    if not keep:
        return (round(ground_ft), 1) if pts[0][0] <= ground_ft + 50 and pts[0][1] < 0 else None
    i = keep[-1]["i1"]
    (z0, t0), (z1, t1) = pts[i], pts[i + 1]
    if z1 - z0 > 3000:
        return None
    return round(z0 + (0 - t0) / (t1 - t0) * (z1 - z0), -2), 0


def _uv(d: float, s: float):
    """Wind from d° at s → (u, v) towards east / north."""
    return -s * sin(radians(d)), -s * cos(radians(d))


def _ceiling_ft(cld):
    """The METAR's ceiling (ft): the lowest BKN / OVC / VV layer, None without one."""
    best = None
    for part in str(cld or "").split():
        if part[:3] in ("BKN", "OVC") and part[3:6].isdigit():
            h = int(part[3:6]) * 100
        elif part[:2] == "VV" and part[2:5].isdigit():
            h = int(part[2:5]) * 100
        else:
            continue
        best = h if best is None else min(best, h)
    return best


def _dist_km(la1: float, lo1: float, la2: float, lo2: float) -> float:
    p1, p2 = radians(la1), radians(la2)
    dp, dl = p2 - p1, radians(lo2 - lo1)
    h = sin(dp / 2) ** 2 + cos(p1) * cos(p2) * sin(dl / 2) ** 2
    return 6371.0 * 2 * atan2(h ** 0.5, (1 - h) ** 0.5)


# ── Memory caches (from 2026-11-03; before, one dict of whole hours per field list,
# emptied at 400 entries) ─────────────────────────────────────────────────────────
# _fc: one averaged field of one hour — (table, ts, run, lead, w, step, bbox, field) →
#      array('h') with FILL for missing, or False when the hour has no such field —
#      so a page with other fields (e.g. clouds switched on) reuses the rest; least
#      recently used out first, at most _FC_MAX_VALS values (2 bytes each, ~24 MB).
# _gc: the grid of each hour key (small).
# _rc: whole answers of /api/weather/frames as gzip bytes — (table, the hours with
#      their run / lead, step, fields, bbox) → bytes — so the next page open, the
#      phone or another user asking for the same hours gets them in about a
#      millisecond; least recently used out first, at most _RC_MAX_BYTES (32 MB).
# Everything is in memory only (nothing written); a new run of an hour has another
# run / lead, so its old entries are simply not asked for again and age out.
import threading
from collections import OrderedDict

_lock = threading.Lock()
_fc: "OrderedDict" = OrderedDict()
_fc_vals = 0
_FC_MAX_VALS = 12_000_000
_gc: dict = {}
_rc: "OrderedDict" = OrderedDict()
_rc_bytes = 0
_RC_MAX_BYTES = 32 * 1024 * 1024
_stats = {"rc_hit": 0, "rc_miss": 0, "fc_hit": 0, "fc_miss": 0}


def _fc_get(key):
    with _lock:
        v = _fc.get(key)
        if v is not None:
            _fc.move_to_end(key)
        return v


def _fc_put(key, arr):
    global _fc_vals
    with _lock:
        old = _fc.pop(key, None)
        if old:
            _fc_vals -= len(old)
        _fc[key] = arr
        _fc_vals += len(arr) if arr else 0
        while _fc_vals > _FC_MAX_VALS and _fc:
            _, a = _fc.popitem(last=False)
            _fc_vals -= len(a) if a else 0
        if len(_gc) > 20000:
            _gc.clear()


def _hours(db, table: str, ts_list):
    """{ts: (run, lead, 1 when the hour has the 10 m wind)} of the stored hours asked for."""
    out = {}
    tl = [int(t) for t in ts_list]
    for k in range(0, len(tl), 400):
        part = tl[k:k + 400]
        try:
            rows = db.execute(f"SELECT ts, run, lead, instr(meta, '\"u\"') > 0 FROM {table} "
                              f"WHERE ts IN ({','.join('?' * len(part))})", part).fetchall()
        except Exception:                                # noqa: BLE001  (table missing)
            return {}
        for ts, run, lead, w in rows:
            out[ts] = (run, lead, 1 if w else 0)
    return out


def _norm(step: int, fields, bbox, fine: bool, model: str = "meps"):
    if model == "gfs":
        table, fine = GFS_TABLE, False
    else:
        table = "meps_wx25_hours" if fine else "meps_wx_hours"
    if fine:
        step, bbox = 1, None
    step = 1 if step <= 1 else (2 if step <= 2 else 4)
    send = tuple(f for f in ALL if f in (fields or SEND))
    bkey = tuple(round(v, 2) for v in bbox) if bbox else None
    return table, step, send, bbox, bkey


def frames(db, ts_list, step: int = 2, fields=None, bbox=None, fine: bool = False, model: str = "meps") -> dict:
    """The fields of the given hours, averaged to step × 10 km; with bbox only
    the part of the grid over it; fine: the 2.5 km box (every cell).  model
    "gfs": the GFS hours (db = the GFS file), step × 0.25°."""
    table, step, send, bbox, bkey = _norm(step, fields, bbox, fine, model)
    ts_list = [int(t) for t in ts_list[:96]]
    have = _hours(db, table, ts_list)
    return _frames(db, table, ts_list, have, step, send, bbox, bkey, fine)


def _frames(db, table, ts_list, have, step, send, bbox, bkey, fine) -> dict:
    out, grid = [], None
    for ts in ts_list:
        h = have.get(ts)
        if not h:
            continue
        run, lead, w = h
        hk = (table, ts, run, lead, w, step, bkey)
        g = _gc.get(hk)
        vals = {k: (_fc_get(hk + (k,)) if g else None) for k in send}
        missing = [k for k in send if vals[k] is None]
        if missing or not g:
            _stats["fc_miss"] += 1
            r = db.execute(f"SELECT run, lead, meta, data FROM {table} WHERE ts = ?", (ts,)).fetchone()
            if not r or (r[0], r[1]) != (run, lead):
                continue
            meta = json.loads(r[2])
            planes = _decode(meta, r[3])
            if planes is None:
                continue
            x0, dx, nx = meta["x"]
            y0, dy, ny = meta["y"]
            win = _window(meta, bbox, step)
            if win:                             # only the part over bbox (whole blocks)
                i0, i1, j0, j1 = win
                planes = {k: _crop(v, nx, win) for k, v in planes.items()}
                x0, y0 = x0 + i0 * dx, y0 + j0 * dy
                nx, ny = i1 - i0, j1 - j0
            g = {"x": [x0 + (step - 1) * dx / 2, dx * step, nx // step],
                 "y": [y0 + (step - 1) * dy / 2, dy * step, ny // step]}
            if meta.get("proj"):
                g["proj"] = meta["proj"]
            _gc[hk] = g
            for k in (send if missing == [] else missing):
                if k in planes:
                    b = _block(planes[k], nx, ny, step, k in BLOCK_MAX)
                    arr = array.array("h", (FILL if v is None else v for v in b))
                else:
                    arr = False
                _fc_put(hk + (k,), arr)
                vals[k] = arr
        else:
            _stats["fc_hit"] += 1
        if grid is None:
            grid = g
        elif g != grid:                     # the grid changed (configuration): skip this hour
            continue
        f = {"ts": ts, "run": run, "lead": lead, "w": w}
        if table == GFS_TABLE:
            f["pi"] = 1 if lead <= 120 else 3
        for k in send:
            a = vals.get(k)
            if a:
                f[k] = [None if v == FILL else v for v in a]
        out.append(f)
    if table == GFS_TABLE:
        return {"grid": grid, "step": step, "deg": 0.25 * step, "km": round(27.8 * step), "fine": 0, "frames": out,
                "model": "gfs", "source": GFS_SOURCE}
    return {"grid": grid, "step": step, "km": 2.5 if fine else 10 * step, "fine": 1 if fine else 0, "frames": out,
            "source": "MEPS (MET Norway, CC BY 4.0)"}


def frames_gz(db, ts_list, step: int = 2, fields=None, bbox=None, fine: bool = False, model: str = "meps") -> bytes:
    """frames() as gzip-compressed JSON, from the answer cache when the same hours
    (with the same run and lead) were asked for before (from 2026-11-03)."""
    import gzip
    global _rc_bytes
    table, step, send, bbox, bkey = _norm(step, fields, bbox, fine, model)
    ts_list = [int(t) for t in ts_list[:96]]
    have = _hours(db, table, ts_list)
    key = (table, tuple((ts,) + have[ts] for ts in ts_list if ts in have), step, send, bkey)
    with _lock:
        hit = _rc.get(key)
        if hit is not None:
            _rc.move_to_end(key)
            _stats["rc_hit"] += 1
            return hit
    _stats["rc_miss"] += 1
    d = _frames(db, table, ts_list, have, step, send, bbox, bkey, fine)
    z = gzip.compress(json.dumps(d, separators=(",", ":")).encode(), compresslevel=5)
    with _lock:
        if key not in _rc:
            _rc[key] = z
            _rc_bytes += len(z)
        while _rc_bytes > _RC_MAX_BYTES and _rc:
            _, old = _rc.popitem(last=False)
            _rc_bytes -= len(old)
    return z


def cache_info() -> dict:
    """The memory caches' size and hits (for the maintenance view / tests)."""
    with _lock:
        return {"fields": len(_fc), "field_values": _fc_vals, "answers": len(_rc), "answer_bytes": _rc_bytes, **_stats}
