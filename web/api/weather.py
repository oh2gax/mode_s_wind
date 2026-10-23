"""
web/api/weather.py — the Weather page: MEPS surface maps (from 2026-10-23).

The `meps` thread (collector/meps.py, kind "wx") stores per valid hour the
model's sea-level pressure, the rain and the snow of the hour ending then,
and the total and low cloud cover on a 10 km grid of ±800 km around the
receiver (table meps_wx_hours; compressed int16 planes, about 50 kB per hour,
7 days of history plus the newest forecast up to +48 h).

index()  — the stored hours (ts, run, lead) and the grid, for the time slider.
frames() — the fields of chosen hours for the browser, on the 10 km grid or
           averaged to 20 / 40 km (step 2 / 4) to keep the download small:
           p = (hPa − 1000) × 10, r / s = mm × 100 (rain / snow of the hour),
           c = total cloud %, as plain integer lists (null = missing).
The page draws them itself (static/js/weather.js), so the Pi only reads,
decompresses and averages.
"""

from __future__ import annotations

import array
import json
import sys
import zlib

FILL = -32768
FIELDS = ("p", "r", "s", "c", "l")
SEND = ("p", "r", "s", "c")          # the fields the page uses


def index(db) -> dict:
    try:
        rows = db.execute("SELECT ts, run, lead FROM meps_wx_hours ORDER BY ts").fetchall()
        meta = db.execute("SELECT meta FROM meps_wx_hours ORDER BY ts DESC LIMIT 1").fetchone()
    except Exception:                                    # noqa: BLE001  (table missing)
        return {"hours": [], "grid": None}
    return {"hours": [[ts, run, lead] for ts, run, lead in rows],
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


def _block(plane, nx: int, ny: int, step: int):
    """Mean of step × step blocks (missing values left out); None where all missing."""
    if step == 1:
        return [None if v == FILL else int(v) for v in plane]
    mx, my = nx // step, ny // step
    out = []
    if FILL not in plane:                      # fast path (the usual case): row slices, no checks
        k = step * step
        w = mx * step
        for J in range(my):
            rows = [plane[(J * step + j) * nx:(J * step + j) * nx + w] for j in range(step)]
            col = [sum(v) for v in zip(*rows)]
            out.extend(round(sum(col[i:i + step]) / k) for i in range(0, w, step))
        return out
    for J in range(my):
        for I in range(mx):
            s = n = 0
            for j in range(J * step, J * step + step):
                row = j * nx
                for i in range(I * step, I * step + step):
                    v = plane[row + i]
                    if v != FILL:
                        s += v
                        n += 1
            out.append(round(s / n) if n else None)
    return out


_cache: dict = {}             # (ts, run, lead, step) → (grid, frame): repeated views cost nothing


def frames(db, ts_list, step: int = 2) -> dict:
    """The fields of the given hours, averaged to step × 10 km."""
    step = 1 if step <= 1 else (2 if step <= 2 else 4)
    out, grid = [], None
    for ts in ts_list[:96]:
        r = db.execute("SELECT run, lead FROM meps_wx_hours WHERE ts = ?", (int(ts),)).fetchone()
        if not r:
            continue
        key = (int(ts), r[0], r[1], step)
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
        g = {"x": [x0 + (step - 1) * dx / 2, dx * step, nx // step],
             "y": [y0 + (step - 1) * dy / 2, dy * step, ny // step]}
        if grid is None:
            grid = g
        elif g != grid:                     # the grid changed (configuration): skip this hour
            continue
        f = {"ts": int(ts), "run": r[0], "lead": r[1]}
        for k in SEND:
            if k in planes:
                f[k] = _block(planes[k], nx, ny, step)
        if len(_cache) > 400:
            _cache.clear()
        _cache[key] = (g, f)
        out.append(f)
    return {"grid": grid, "step": step, "km": 10 * step, "frames": out,
            "source": "MEPS (MET Norway, CC BY 4.0)"}
