"""
web/api/weather.py — the Weather page: MEPS surface maps (from 2026-10-23).

The `meps` thread (collector/meps.py, kind "wx") stores per valid hour the
model's sea-level pressure, the rain and the snow of the hour ending then,
total, low, medium and high cloud, fog and the cloud base on a 10 km grid
over the MEPS area (table meps_wx_hours; compressed int16 planes, 7 days of
history plus the newest forecast up to +48 h).

index()  — the stored hours (ts, run, lead) and the grid, for the time slider.
frames() — the fields of chosen hours for the browser, on the 10 km grid or
           averaged to 20 / 40 km (step 2 / 4) to keep the download small:
           p = (hPa − 1000) × 10, r / s = mm × 100 (rain / snow of the hour),
           c / l / m / h = total / low / medium / high cloud %, f = fog %,
           b = cloud base m, u / v = 10 m wind towards east / north (kt),
           g = 10 m gust (kt; hours stored from 24 Oct 2026), as plain integer
           lists (null = missing); only the fields asked for (default p, r,
           s, c).  Averaged blocks take the mean, the gust the block maximum.
The page draws them itself (static/js/weather.js), so the Pi only reads,
decompresses and averages.

bbox (from 2026-10-30, the phone's Weather view): only the part of the grid
that covers lat0, lon0, lat1, lon1 (whole step blocks, so the averaging is
the same as without it) — a third or less of the download.
"""

from __future__ import annotations

import array
import json
import sys
import zlib
from math import atan2, cos, pi, radians, sin, tan

FILL = -32768
FIELDS = ("p", "r", "s", "c", "l")    # the fields of rows without a field list (first version)
ALL = ("p", "r", "s", "c", "l", "m", "h", "f", "b", "u", "v", "g")
BLOCK_MAX = ("g",)                    # averaged blocks: the strongest gust, not the mean
SEND = ("p", "r", "s", "c")          # default


def index(db) -> dict:
    try:
        # [ts, run, lead, 1 when the hour has the 10 m wind] — a page reloads an
        # hour whose wind arrived later (same run and lead, fetched again)
        rows = db.execute("SELECT ts, run, lead, instr(meta, '\"u\"') > 0 FROM meps_wx_hours ORDER BY ts").fetchall()
        meta = db.execute("SELECT meta FROM meps_wx_hours ORDER BY ts DESC LIMIT 1").fetchone()
    except Exception:                                    # noqa: BLE001  (table missing)
        return {"hours": [], "grid": None}
    return {"hours": [[ts, run, lead, 1 if w else 0] for ts, run, lead, w in rows],
            "grid": json.loads(meta[0]) if meta else None,
            "source": "MEPS (MET Norway, CC BY 4.0)"}


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


_cache: dict = {}             # (ts, run, lead, step) → (grid, frame): repeated views cost nothing


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


def _window(meta: dict, bbox, step: int):
    """The grid indices [i0, i1) × [j0, j1) that cover bbox (lat0, lon0, lat1,
    lon1), on whole step blocks; None = the whole grid."""
    if not bbox:
        return None
    x0, dx, nx = meta["x"]
    y0, dy, ny = meta["y"]
    la0, lo0, la1, lo1 = bbox
    xs, ys = [], []
    for k in range(9):                        # the edges, not only the corners (curved)
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


def frames(db, ts_list, step: int = 2, fields=None, bbox=None) -> dict:
    """The fields of the given hours, averaged to step × 10 km; with bbox only
    the part of the grid over it."""
    step = 1 if step <= 1 else (2 if step <= 2 else 4)
    send = tuple(f for f in ALL if f in (fields or SEND))
    bkey = tuple(round(v, 2) for v in bbox) if bbox else None
    out, grid = [], None
    for ts in ts_list[:96]:
        r = db.execute("SELECT run, lead, instr(meta, '\"u\"') > 0 FROM meps_wx_hours WHERE ts = ?",
                       (int(ts),)).fetchone()
        if not r:
            continue
        key = (int(ts), r[0], r[1], r[2], step, send, bkey)
        hit = _cache.get(key)
        if hit:
            if grid is None:
                grid = hit[0]
            if hit[0] == grid:
                out.append(hit[1])
            continue
        r = db.execute("SELECT run, lead, meta, data FROM meps_wx_hours WHERE ts = ?", (int(ts),)).fetchone()
        if not r:
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
        if grid is None:
            grid = g
        elif g != grid:                     # the grid changed (configuration): skip this hour
            continue
        f = {"ts": int(ts), "run": r[0], "lead": r[1], "w": 1 if "u" in planes else 0}
        for k in send:
            if k in planes:
                f[k] = _block(planes[k], nx, ny, step, k in BLOCK_MAX)
        if len(_cache) > 400:
            _cache.clear()
        _cache[key] = (g, f)
        out.append(f)
    return {"grid": grid, "step": step, "km": 10 * step, "frames": out,
            "source": "MEPS (MET Norway, CC BY 4.0)"}
