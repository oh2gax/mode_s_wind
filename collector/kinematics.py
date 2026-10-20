"""
kinematics.py — hourly vorticity (and divergence) profile from the aircraft
winds (from 2026-10-20).

For each completed UTC hour and altitude layer (the atmos.LAYER_EDGES layers)
the winds of all aircraft within KINEMATICS_RADIUS_KM (default 200 km) of the
receiver are fitted with a plane

    u = a + b·x + c·y,   v = d + e·x + f·y          (x east, y north, km)

after averaging each aircraft first (one point per aircraft, so a single
airframe with many replies does not dominate).  The slopes give

    relative vorticity  ζ = ∂v/∂x − ∂u/∂y = e − c   (+ cyclonic in the north)
    divergence          δ = ∂u/∂x + ∂v/∂y = b + f

with standard errors from the fit residuals.  A layer needs at least
MIN_AIRCRAFT aircraft spread over the area in two directions (smallest
spread ≥ MIN_SPREAD_KM — below about FL130 the aircraft follow the airport's
approach and departure paths and rarely qualify); aircraft whose wind
departs from the plane by more than 3 × the RMS (at least 15 kt) are left
out and the plane is fitted again.

Tested on 24 Sep – 20 Oct 2026 (200 km, one hour): vorticity RMS 7–10 ×10⁻⁵ s⁻¹
at FL130–FL390 with a standard error of about 2.3 and an hour-to-hour
correlation of 0.65–0.83 — a usable signal (trough passages cyclonic, ridges
anticyclonic).  The period mean was anticyclonic at all levels (−2 … −4),
partly a sampling effect: climbing and descending aircraft alone gave
different means.  Divergence (RMS 3–4, SE 2.3, hour-to-hour correlation
0.1–0.25) is mostly noise; it is stored for research only.

Stored in kinematics_hours (ts = hour start, data = JSON
{"r": radius km, "lv": [[alt_lo, vort, div, se_vort, se_div, aircraft], …]},
values in 10⁻⁵ s⁻¹), one row per hour, about 0.5 kB; written by the hourly
jobs thread, back-filled from the observations still in the database, kept
indefinitely like profile_hours.  Pure Python (no numpy on the Pi).
"""

from __future__ import annotations

import json
import math
import time as _time

from collector.atmos import LAYER_EDGES, layer_of

MIN_AIRCRAFT = 6
MIN_SPREAD_KM = 30.0
KT_PER_KM_TO_1E5 = 0.514444 * 1e-3 * 1e5     # kt/km → 10⁻⁵ s⁻¹


def _fit(pts):
    """Least-squares plane fit of u and v at (x, y): ((ux, uy), (vx, vy),
    residuals u, v, (Sxx, Syy, Sxy, D)) about the centroid, or None."""
    n = len(pts)
    mx = sum(p[0] for p in pts) / n
    my = sum(p[1] for p in pts) / n
    sxx = sum((p[0] - mx) ** 2 for p in pts)
    syy = sum((p[1] - my) ** 2 for p in pts)
    sxy = sum((p[0] - mx) * (p[1] - my) for p in pts)
    D = sxx * syy - sxy * sxy
    if D <= 0:
        return None
    out = []
    for j in (2, 3):
        m = sum(p[j] for p in pts) / n
        sx = sum((p[0] - mx) * (p[j] - m) for p in pts)
        sy = sum((p[1] - my) * (p[j] - m) for p in pts)
        gx = (sx * syy - sy * sxy) / D
        gy = (sy * sxx - sx * sxy) / D
        res = [p[j] - (m + gx * (p[0] - mx) + gy * (p[1] - my)) for p in pts]
        out.append(((gx, gy), res))
    return out[0][0], out[1][0], out[0][1], out[1][1], (sxx, syy, sxy, D)


def _spread_ok(pts) -> bool:
    n = len(pts)
    mx = sum(p[0] for p in pts) / n
    my = sum(p[1] for p in pts) / n
    sxx = sum((p[0] - mx) ** 2 for p in pts) / n
    syy = sum((p[1] - my) ** 2 for p in pts) / n
    sxy = sum((p[0] - mx) * (p[1] - my) for p in pts) / n
    lmin = (sxx + syy) / 2 - math.sqrt(((sxx - syy) / 2) ** 2 + sxy ** 2)
    return lmin >= MIN_SPREAD_KM ** 2


def layer_kinematics(pts):
    """pts: one (x km, y km, u kt, v kt) per aircraft → (vort, div, se_vort,
    se_div, n) in 10⁻⁵ s⁻¹, or None when the layer does not qualify."""
    if len(pts) < MIN_AIRCRAFT or not _spread_ok(pts):
        return None
    f = _fit(pts)
    if f is None:
        return None
    (ux, uy), (vx, vy), ru, rv, _ = f
    rr = [math.hypot(a, b) for a, b in zip(ru, rv)]
    rms = math.sqrt(sum(r * r for r in rr) / len(rr))
    keep = [p for p, r in zip(pts, rr) if r <= max(3 * rms, 15.0)]
    if len(keep) < len(pts):
        if len(keep) < MIN_AIRCRAFT or not _spread_ok(keep):
            return None
        f = _fit(keep)
        if f is None:
            return None
        (ux, uy), (vx, vy), ru, rv, _ = f
    sxx, syy, sxy, D = f[4]
    n = len(keep)
    dof = max(1, n - 3)
    su2 = sum(r * r for r in ru) / dof
    sv2 = sum(r * r for r in rv) / dof
    var_gx, var_gy = syy / D, sxx / D          # (XᵀX)⁻¹ diagonal for the slopes
    vort = (vx - uy) * KT_PER_KM_TO_1E5
    div = (ux + vy) * KT_PER_KM_TO_1E5
    se_v = math.sqrt(sv2 * var_gx + su2 * var_gy) * KT_PER_KM_TO_1E5
    se_d = math.sqrt(su2 * var_gx + sv2 * var_gy) * KT_PER_KM_TO_1E5
    return vort, div, se_v, se_d, n


def kinematics_profile(db, t0: float, t1: float, lat: float, lon: float,
                       radius_km: float) -> list:
    """[[alt_lo, vort, div, se_vort, se_div, aircraft], …] for the layers of
    [t0, t1) that qualify.  Read only."""
    kx = 111.2 * math.cos(math.radians(lat))
    acc: dict = {}
    for icao, alt, la, lo, ws, wd in db.execute(
            """SELECT icao, altitude, lat, lon, best_wind_spd, best_wind_dir
               FROM observations
               WHERE ts >= ? AND ts < ? AND best_wind_spd IS NOT NULL AND best_wind_dir IS NOT NULL
                 AND altitude IS NOT NULL AND lat IS NOT NULL AND lon IS NOT NULL""", (t0, t1)):
        x, y = (lo - lon) * kx, (la - lat) * 111.2
        if x * x + y * y > radius_km * radius_km:
            continue
        k = layer_of(alt)
        if k is None:
            continue
        r = math.radians(wd)
        a = acc.setdefault((k, icao), [0.0, 0.0, 0.0, 0.0, 0])
        a[0] += x; a[1] += y; a[2] += -ws * math.sin(r); a[3] += -ws * math.cos(r); a[4] += 1
    layers: dict = {}
    for (k, _), a in acc.items():
        n = a[4]
        layers.setdefault(k, []).append((a[0] / n, a[1] / n, a[2] / n, a[3] / n))
    out = []
    for k in sorted(layers):
        res = layer_kinematics(layers[k])
        if res is None:
            continue
        vort, div, se_v, se_d, n = res
        out.append([LAYER_EDGES[k], round(vort, 1), round(div, 1), round(se_v, 1), round(se_d, 1), n])
    return out


def store_missing_kinematics_hours(db, lat: float, lon: float, radius_km: float,
                                   max_hours: int = 31 * 24, now: float | None = None,
                                   pause_sec: float = 0.0) -> int:
    """Compute and store the kinematics of every completed UTC hour of the
    last max_hours without a kinematics_hours row (normally just the hour
    that ended; at the first start a back-fill from the observations still in
    the database).  Hours without any qualifying layer get an empty row, so
    they are not computed again.  All rows in one commit; returns the count."""
    now = _time.time() if now is None else now
    cur_hour = int(now // 3600 * 3600)
    oldest = db.execute("SELECT MIN(ts) FROM observations").fetchone()[0]
    if oldest is None:
        return 0
    first = max(cur_hour - max_hours * 3600, int(oldest // 3600 * 3600) + 3600)
    have = {r[0] for r in db.execute(
        "SELECT ts FROM kinematics_hours WHERE ts >= ? AND ts < ?", (first, cur_hour))}
    rows = []
    for h in range(first, cur_hour, 3600):
        if h in have:
            continue
        lv = kinematics_profile(db, h, h + 3600, lat, lon, radius_km)
        rows.append((h, json.dumps({"r": radius_km, "lv": lv}, separators=(",", ":"))))
        if pause_sec:
            _time.sleep(pause_sec)     # back-fill: leave CPU / SD card to the collector
    if rows:
        db.executemany("INSERT OR IGNORE INTO kinematics_hours (ts, data) VALUES (?, ?)", rows)
        db.commit()
    return len(rows)
