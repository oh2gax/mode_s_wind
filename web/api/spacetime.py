"""
web/api/spacetime.py — space–time (time–height) diagram of the headwind
changes over successive flights, for the ST view of the Windshear page
(from 2026-10-27).

For every landing and departure of the last 3 / 6 / 12 / 24 hours the change
of the headwind in EVERY 200-ft band (400–1 800 ft MSL) against the median of
the flights of the previous 45 minutes is computed exactly as the band
comparison of the windshear detection (collector/shear.py band_changes: the
same references, the same flight-phase correction and the same sign, + = more
headwind along the flight's own direction than before).  The detection stores
only the largest change of each flight; the diagram needs all of them, so they
are recomputed here from the stored band profiles (prof_json of
approach_history and departure_profiles) in time order — no database writes.

A front or a shear layer shows as a streak of the same colour running through
successive flights (sloping when it descends); a turbulent eddy met by one
aircraft is a lone column.

One request over 24 h reads about 800 flights and takes well under a second
on a Raspberry Pi 4; the result is cached until a new flight is stored (at
most 60 s).
"""

from __future__ import annotations

import json
import math
import threading
import time
from collections import deque

from collector import shear as _shear

RANGES_H = (3, 6, 12, 24)
CACHE_SEC = 60.0
_cache: dict = {}
_lock = threading.Lock()


def _wind(u: float, v: float) -> tuple[int, int]:
    """(direction the wind blows from °, speed kt) of a band vector."""
    return int(round(math.degrees(math.atan2(-u, -v)) % 360)), int(round(math.hypot(u, v)))


def build(db, hours: int, now: float | None = None) -> dict:
    """{"t0", "t1", "hours", "bands", "flights": [{ts, ph, cs, type, rwy, hdg, lvl,
    b: {band: [change kt, references, wind pairs, wind dir, wind kt]}}]} — flights
    oldest first; ph "arr" / "dep"; lvl the stored windshear level."""
    hours = hours if hours in RANGES_H else 12
    now = now or time.time()
    t0 = now - hours * 3600
    t_from = t0 - _shear.BAND_WINDOW_SEC
    newest = db.execute("SELECT MAX(ts) FROM approach_history").fetchone()[0] or 0
    try:
        newest = max(newest, db.execute("SELECT MAX(ts) FROM departure_profiles").fetchone()[0] or 0)
    except Exception:                                  # noqa: BLE001  (older database)
        pass
    key = hours
    with _lock:
        c = _cache.get(key)
        if c and c["newest"] == newest and now - c["at"] < CACHE_SEC:
            return c["data"]

    land = db.execute(
        """SELECT ts, callsign, icao, aircraft_type, runway, rwy_heading, prof_json, shear_json
           FROM approach_history WHERE ts >= ? AND ts <= ? ORDER BY ts""", (t_from, now)).fetchall()
    try:
        dep = db.execute(
            """SELECT ts, callsign, icao, aircraft_type, track, prof_json, shear_json
               FROM departure_profiles WHERE ts >= ? AND ts <= ? AND ga = 0 ORDER BY ts""", (t_from, now)).fetchall()
    except Exception:                                  # noqa: BLE001
        dep = []
    events = sorted([(r[0], 0, r) for r in land] + [(r[0], 1, r) for r in dep],
                    key=lambda e: (e[0], e[1]))
    hist: deque = deque()
    flights = []
    for ts, kind, r in events:
        while hist and hist[0]["ts"] < ts - _shear.BAND_WINDOW_SEC:
            hist.popleft()
        pj, sj = (r[6], r[7]) if kind == 0 else (r[5], r[6])
        try:
            prof = json.loads(pj) if pj else None
        except ValueError:
            prof = None
        try:
            rep = json.loads(sj) if sj else {}
        except ValueError:
            rep = {}
        if kind == 0:
            ph, hdg, rwy = "arr", r[5], r[4]
            own = _shear.vec_bands(prof, _shear.VEC_MIN_N_ARR)
        else:
            ph, hdg, rwy = "dep", (rep or {}).get("hdg"), (rep or {}).get("rwy")
            own = _shear.vec_bands(prof, _shear.VEC_MIN_N_DEP)
        if ts >= t0 and own and hdg is not None:
            per = _shear.band_changes(own, _shear.vec_refs(hist, ts), hdg, phase=ph)
            b = {}
            for band, (u, v, n) in own.items():
                wd, ws = _wind(u, v)
                c = per.get(band)
                b[band] = [c["a"] if c else None, c["n"] if c else 0, n, wd, ws]
            if b:
                flights.append({"ts": round(ts), "ph": ph, "cs": r[1] or r[2], "type": r[3],
                                "rwy": rwy, "hdg": round(hdg), "lvl": (rep or {}).get("lvl") or "none",
                                "thr": ((rep or {}).get("band") or {}).get("thr"), "b": b})
        bv = _shear.vec_bands(prof, 1)
        if bv:
            hist.append({"ts": ts, "bv": bv, "ph": "arr" if kind == 0 else "dep",
                         "hdg": r[5] if kind == 0 else r[4]})
    data = {"t0": round(t0), "t1": round(now), "hours": hours,
            "bands": list(range(_shear.VEC_MIN_FT, int(_shear.BAND_MAX_FT) + 1, 200)),
            "limits": [_shear.BAND_ADVISORY, _shear.BAND_WSA], "flights": flights}
    with _lock:
        _cache[key] = {"at": now, "newest": newest, "data": data}
    return data
