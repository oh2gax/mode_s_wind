"""
gnss_heights.py — heights of the pressure surfaces from the aircraft GNSS −
baro altitude difference (from 2026-10-21).

An aircraft's barometric altitude is pressure altitude: it says which
pressure surface the aircraft is on.  Its GNSS height minus that altitude
(ADS-B TC 19 "GNSS − baro", observations.gmb_ft and the dense height_series)
is therefore the D-value of the surface — how far the real surface lies above
(+) or below (−) its height in the standard atmosphere.  Warm air columns and
highs lift the surfaces, cold air and lows lower them.

Calibration (self-tuning)
-------------------------
The raw difference contains (a) the geoid (aircraft GNSS heights are
ellipsoidal: about 18 m above mean sea level here, falling by about 3 m per
100 km towards the east), (b) the aircraft's static pressure error, which
depends on speed and so on altitude, and (c) a smaller per-airframe offset
(SD ≈ 9 m, only partly repeatable from day to day).  (a) is removed at each
position with the EGM96 geoid (collector/geoid.py, from 2026-10-22 — before
that the calibration absorbed it as a constant, and its east–west slope
showed as a false slope of the pressure surfaces); (b) and (c) are learnt:
fleet mean about +6 m near the ground falling to about −25 m at FL350
against the radiosonde.  At each Jokioinen sounding the
aircraft within SONDE_RADIUS_KM that pass a level within ±SONDE_WINDOW_SEC of
the balloon are compared with the sounding's measured height of that pressure
surface (sonde GPS height, mean sea level):

    residual = gmb − N(aircraft position) − (z_sonde − pressure altitude)

The balloon's drift is followed from the sounding's winds and, from FL200 up,
each aircraft value is moved to the balloon's position with the slope of the
pressure surface (sonde_cells).  The residuals are kept per sounding (gnss_cal,
key "sonde:YYYYMMDDHH", one cell per airframe and 5 000 ft band; cells of an
older method are computed again), and after each new sounding the
correction is fitted again from the last CAL_DAYS days:

    curve(alt)  fleet correction per 5 000 ft band (interpolated linearly
                between band centres), blended with the prior below with
                PRIOR_WEIGHT cells, so it is usable from the start and follows
                the data as it accumulates
    b[icao]     per-airframe offset, shrunk towards 0 (n / (n + SHRINK)
                soundings)

Corrected height of the pressure surface (MSL, comparable with the sonde):

    z = pressure altitude · 0.3048 + gmb · 0.3048 − N(lat, lon) − curve(alt) − b[icao]

Hourly products (gnss_hours)
----------------------------
Stored raw (uncorrected) so that a new calibration applies to the past too
(only the geoid is removed per row, "g": 1; older rows without it get the
geoid at the receiver subtracted when read):
  "d"   per layer (atmos.LAYER_EDGES) and airframe: mean gmb, mean altitude,
        replies — rows with NACp ≥ 8, outside the airframe's GPS degradation
        episodes, within the profile radius; read side: D-value of the layer
        (median over airframes, moved to the layer centre)
  "tk"  per climb / descent (height_series) and layer of THK_LAYERS: the
        geometric heights of the two pressure surfaces at the layer edges
        (and whether it climbed or descended; hours stored before that are
        computed again once at start while their height_series rows exist);
        read side: thickness (virtual) temperature
            Tv = g0 · ΔH / (R · ln(p1 / p2))
        with H the geopotential height — independent of the Mach / TAS
        temperatures, and the per-airframe offset cancels
Rows are stored STORE_DELAY_H hours after the hour (a visit is only written
when the aircraft has left), newer hours are computed when asked for.

Pure Python (no numpy on the Pi).
"""

from __future__ import annotations

import json
import math
import time as _time
import zlib

from collector.atmos import LAYER_EDGES, layer_of
from collector.geoid import undulation

FT = 0.3048
G0, R_D = 9.80665, 287.04
EARTH_R = 6371008.8
MIN_NACP = 8
EP_MARGIN_SEC = 120.0
SONDE_RADIUS_KM = 150.0
SONDE_WINDOW_SEC = 3600.0
SONDE_ASCENT_MS = 5.0           # balloon time at a level ≈ launch + height gain / 5 m/s
CAL_DAYS = 30
BAND_FT = 5000
# Prior fleet correction (m) per 5 000 ft band (centres 2 500 … 42 500 ft):
# aircraft − sonde, 20–21 Oct 2026, after the EGM96 geoid (the static
# pressure error; until 22 Oct 2026 the geoid, about 18.6 m around the sonde
# pairs, was part of this correction)
PRIOR = [6.2, 3.5, -0.5, -6.7, -6.8, -16.5, -23.4, -26.1, -26.1]
GEOID_OLD_M = 18.6              # sonde cells of version < 3 (geoid not removed): subtract this
PRIOR_WEIGHT = 5.0              # cells
SHRINK = 3.0                    # soundings
CELL_W_MAX = 10                 # a cell with many replies counts at most this much
GRAD_MIN_FT = 20000             # sonde pairing: slope correction from this band up …
GRAD_MIN_PAIRS = 30             # … with at least this many pairs …
GRAD_MIN_SPREAD_KM = 15.0       # … spread at least this much across the area
CELLS_VERSION = 3               # sonde cells older than this are computed again (3: EGM96 geoid removed)
THK_LAYERS = [(0, 5000), (5000, 10000), (10000, 15000), (15000, 20000), (20000, 25000),
              (25000, 30000), (30000, 35000), (35000, 40000), (10000, 30000),
              (1000, 5000)]             # 1 000 ft: crossed whatever the QNH (moisture indicator)
CELLS_V = 3                     # gnss_hours cells: 2 = with 1 000–5 000 ft and the climb / descent flag,
                                # 3 = heights above mean sea level (EGM96 geoid removed, "g": 1)
THK_EDGE_FT = 300               # rows within ± this of a layer edge give its height
THK_MAX_SEC = 1500              # both edges within 25 min
STORE_DELAY_H = 4               # gnss_hours rows written this long after the hour
CACHE_SEC = 600


# ── geometry ────────────────────────────────────────────────────────────────

def isa_pressure(ft: float) -> float:
    if ft <= 36089:
        return 1013.25 * (1 - 6.8756e-6 * ft) ** 5.2559
    return 226.32 * math.exp(-(ft - 36089) / 20806)


def isa_temp_k(ft: float) -> float:
    return 288.15 - 1.98 * ft / 1000 if ft <= 36089 else 216.65


def gravity(lat: float) -> float:
    s = math.sin(math.radians(lat)) ** 2
    return 9.780327 * (1 + 0.0053024 * s - 0.0000058 * math.sin(math.radians(2 * lat)) ** 2)


def geopotential(z_m: float, lat: float) -> float:
    """Geopotential height (m) of the geometric height z_m (m)."""
    return gravity(lat) / G0 * EARTH_R * z_m / (EARTH_R + z_m)


def _km(la1, lo1, la2, lo2) -> float:
    return math.hypot((la1 - la2) * 111.2, (lo1 - lo2) * 111.2 * math.cos(math.radians((la1 + la2) / 2)))


def _episodes(db, t0, t1) -> dict:
    out: dict = {}
    try:
        for icao, a, b in db.execute(
                "SELECT icao, t_start, t_end FROM gps_episodes WHERE t_end >= ? AND t_start <= ?",
                (t0 - EP_MARGIN_SEC, t1 + EP_MARGIN_SEC)):
            if a is not None:
                out.setdefault(icao, []).append((a - EP_MARGIN_SEC, (b or a) + EP_MARGIN_SEC))
    except Exception:                                    # noqa: BLE001  (table missing)
        pass
    return out


def _in_ep(eps, icao, ts) -> bool:
    return any(a <= ts <= b for a, b in eps.get(icao, ()))


# ── calibration ─────────────────────────────────────────────────────────────

def band_of(alt_ft: float) -> int:
    return max(0, min(len(PRIOR) - 1, int(alt_ft // BAND_FT)))


def _interp(curve: list, alt_ft: float) -> float:
    x = alt_ft / BAND_FT - 0.5
    if x <= 0:
        return curve[0]
    i = int(x)
    if i >= len(curve) - 1:
        return curve[-1]
    f = x - i
    return curve[i] + f * (curve[i + 1] - curve[i])


def default_calibration() -> dict:
    return {"v": 0, "curve": list(PRIOR), "nb": [0] * len(PRIOR), "b": {}, "pairs": 0,
            "soundings": 0, "t": None}


def correction(cal: dict, alt_ft: float, icao: str | None = None) -> float:
    """Metres to subtract from (pressure altitude + gmb) for the MSL height."""
    c = _interp(cal.get("curve") or PRIOR, alt_ft)
    if icao:
        c += (cal.get("b") or {}).get(icao, 0.0)
    return c


_cache = {"t": 0.0, "cal": None}


def current(db, max_age: float = CACHE_SEC) -> dict:
    """The current calibration (cached), the prior when none is stored yet."""
    now = _time.time()
    if _cache["cal"] is not None and now - _cache["t"] < max_age:
        return _cache["cal"]
    cal = None
    try:
        row = db.execute("SELECT data FROM gnss_cal WHERE key = 'current'").fetchone()
        if row:
            cal = json.loads(row[0])
    except Exception:                                    # noqa: BLE001
        cal = None
    _cache["cal"], _cache["t"] = cal or default_calibration(), now
    return _cache["cal"]


def _min_spread_km(pts) -> float:
    """Spread (km, SD along the narrowest direction) of [(…, x, y)]."""
    n = len(pts)
    mx = sum(p[-2] for p in pts) / n
    my = sum(p[-1] for p in pts) / n
    sxx = sum((p[-2] - mx) ** 2 for p in pts) / n
    syy = sum((p[-1] - my) ** 2 for p in pts) / n
    sxy = sum((p[-2] - mx) * (p[-1] - my) for p in pts) / n
    return math.sqrt(max(0.0, (sxx + syy) / 2 - math.sqrt(((sxx - syy) / 2) ** 2 + sxy ** 2)))


def sonde_cells(db, rec: dict, slope: bool = False) -> dict:
    """Aircraft − sonde residuals of one sounding:
    {"v": 3, "m": "drift" | "slope", "n": pairs, "c": [[icao, band, mean residual m, replies], …]};
    residual = aircraft GNSS height above mean sea level (EGM96 geoid
    removed at the aircraft's position) − the sonde's height of that surface.

    The balloon drifts with the wind (tens of km by FL300): its position at
    each level is followed from the sounding's own winds at the assumed
    ascent rate, and aircraft are paired within SONDE_RADIUS_KM of that
    position.  With slope=True (config GNSS_CAL_SLOPE, default off), from
    GRAD_MIN_FT up, where the aircraft are spread over the area, the slope of
    the pressure surface seen by the aircraft of the band (plane fit,
    ≥ GRAD_MIN_PAIRS pairs spread ≥ GRAD_MIN_SPREAD_KM) moves each aircraft's
    value to the balloon's position.  Test on 6 soundings 20–21 Oct 2026:
    the slope correction cut the leave-one-out RMS at FL250–FL350 from 12–13
    to 4–7 m, but it removed most of the drop of the correction with altitude
    (FL250–FL300 +7 → +18 m), and the independent thickness-temperature check
    then got worse (FL100–FL300 −0.6 → −0.9 K against Mach/TAS), so it stays
    off until more soundings decide.  The drift alone changed little."""
    import bisect
    lv = sorted([l for l in rec.get("lv") or [] if l[1] is not None and l[2] is not None],
                key=lambda l: l[2])
    if len(lv) < 10:
        return {"v": CELLS_VERSION, "m": "slope" if slope else "drift", "n": 0, "c": []}
    launch = rec.get("launch") or rec.get("nominal")
    end = rec.get("end") or (launch + 7200)
    slat, slon = rec.get("lat") or 60.814, rec.get("lon") or 23.498
    kx = 111.2 * math.cos(math.radians(slat))
    # balloon track: time and position (km east / north of the site) per level
    x = y = 0.0
    tt, px, py = [], [], []
    t = launch
    prev = lv[0]
    for l in lv:
        dt = max(0.0, (l[2] - prev[2]) / SONDE_ASCENT_MS)
        if len(prev) > 6 and prev[5] is not None and prev[6] is not None:
            r = math.radians(prev[5])
            sp = prev[6] * 0.514444 / 1000.0
            x += -sp * math.sin(r) * dt
            y += -sp * math.cos(r) * dt
        t += dt
        tt.append(t); px.append(x); py.append(y)
        prev = l
    order = sorted(range(len(lv)), key=lambda i: lv[i][1])       # by pressure altitude
    alts = [lv[i][1] for i in order]
    eps = _episodes(db, launch - SONDE_WINDOW_SEC, end + SONDE_WINDOW_SEC)
    pairs = []
    for icao, ts, alt, lat, lon, g, nacp in db.execute(
            """SELECT icao, ts, altitude, lat, lon, gmb_ft, nacp FROM observations
               WHERE ts >= ? AND ts <= ? AND gmb_ft IS NOT NULL AND altitude IS NOT NULL
                 AND lat IS NOT NULL AND lon IS NOT NULL AND nacp >= ?""",
            (launch - SONDE_WINDOW_SEC, end + SONDE_WINDOW_SEC, MIN_NACP)):
        if alt < alts[0] or alt > alts[-1]:
            continue
        j = max(1, bisect.bisect_left(alts, alt))
        ia, ib = order[j - 1], order[j]
        a, b = lv[ia], lv[ib]
        f = (alt - a[1]) / (b[1] - a[1]) if b[1] != a[1] else 0.0
        z = a[2] + f * (b[2] - a[2])
        tl = tt[ia] + f * (tt[ib] - tt[ia])
        bx = px[ia] + f * (px[ib] - px[ia])
        by = py[ia] + f * (py[ib] - py[ia])
        dx, dy = (lon - slon) * kx - bx, (lat - slat) * 111.2 - by
        if math.hypot(dx, dy) > SONDE_RADIUS_KM or abs(ts - tl) > SONDE_WINDOW_SEC or _in_ep(eps, icao, ts):
            continue
        # aircraft GNSS height is above the ellipsoid, the sonde's above mean sea level
        pairs.append((icao, band_of(alt), g * FT - undulation(lat, lon) - (z - alt * FT), alt, dx, dy))
    # upper bands: move each value to the balloon with the band's plane slope
    by_band: dict = {}
    for p_ in pairs:
        by_band.setdefault(p_[1], []).append(p_)
    out = []
    for bd, P in by_band.items():
        if (slope and bd * BAND_FT >= GRAD_MIN_FT and len(P) >= GRAD_MIN_PAIRS
                and _min_spread_km(P) >= GRAD_MIN_SPREAD_KM):
            n = len(P)
            mx = sum(q[4] for q in P) / n
            my = sum(q[5] for q in P) / n
            mv = sum(q[2] for q in P) / n
            sxx = sum((q[4] - mx) ** 2 for q in P)
            syy = sum((q[5] - my) ** 2 for q in P)
            sxy = sum((q[4] - mx) * (q[5] - my) for q in P)
            sx = sum((q[4] - mx) * (q[2] - mv) for q in P)
            sy = sum((q[5] - my) * (q[2] - mv) for q in P)
            D = sxx * syy - sxy * sxy
            if D > 0:
                gx = (sx * syy - sy * sxy) / D
                gy = (sy * sxx - sx * sxy) / D
                P = [(q[0], q[1], q[2] - gx * q[4] - gy * q[5]) + q[3:] for q in P]
        out.extend(P)
    acc: dict = {}
    for icao, bd, v, *_ in out:
        s_ = acc.setdefault((icao, bd), [0.0, 0])
        s_[0] += v
        s_[1] += 1
    return {"v": CELLS_VERSION, "m": "slope" if slope else "drift", "n": len(pairs),
            "c": [[k[0], k[1], round(v[0] / v[1], 1), v[1]] for k, v in sorted(acc.items())]}


def fit_calibration(rows: list) -> dict:
    """rows: [(sounding key, {"c": cells})] → calibration dict."""
    cells = [(key, c[0], c[1], c[2], min(CELL_W_MAX, c[3])) for key, d in rows for c in d.get("c", [])]
    nb_n = len(PRIOR)
    curve, b = list(PRIOR), {}
    used = [0] * nb_n
    for _ in range(4):
        for k in range(nb_n):
            vals = [(v - b.get(ic, 0.0), w) for _, ic, bd, v, w in cells if bd == k]
            if not vals:
                curve[k], used[k] = PRIOR[k], 0
                continue
            srt = sorted(x for x, _ in vals)
            med = srt[len(srt) // 2]
            mad = sorted(abs(x - med) for x in srt)[len(srt) // 2] * 1.4826
            keep = [(x, w) for x, w in vals if abs(x - med) <= max(3 * mad, 15.0)]
            sw = sum(w for _, w in keep)
            fit = sum(x * w for x, w in keep) / sw
            n = len(keep)
            curve[k] = (fit * n + PRIOR[k] * PRIOR_WEIGHT) / (n + PRIOR_WEIGHT)
            used[k] = n
        per: dict = {}
        for key, ic, bd, v, w in cells:
            per.setdefault(ic, {}).setdefault(key, []).append(v - curve[bd])
        b, bn = {}, {}
        for ic, by_key in per.items():
            means = [sum(x) / len(x) for x in by_key.values()]
            b[ic] = sum(means) / (len(means) + SHRINK)
            bn[ic] = [len(means), round(sum(means) / len(means), 1)]
    return {"v": int(_time.time()), "curve": [round(c, 2) for c in curve], "nb": used,
            "b": {k: round(v, 1) for k, v in sorted(b.items()) if abs(v) >= 0.5},
            "bn": {k: v for k, v in sorted(bn.items())},     # airframe → [soundings, raw mean m]
            "pairs": sum(d.get("n", 0) for _, d in rows), "soundings": len(rows),
            "t": int(_time.time())}


def update_calibration(db, store, now: float | None = None, cal_days: float = CAL_DAYS,
                       slope: bool = False) -> int:
    """Residuals of every finished sounding of the last cal_days not yet in
    gnss_cal, then (when any was added, or none is stored) a new fit.
    Returns the number of soundings added."""
    if store is None:
        return 0
    now = _time.time() if now is None else now
    first_obs = db.execute("SELECT MIN(ts) FROM observations WHERE gmb_ft IS NOT NULL").fetchone()[0]
    if first_obs is None:
        return 0
    have = set()                     # soundings with cells of the current method
    for k, d in db.execute("SELECT key, data FROM gnss_cal WHERE key LIKE 'sonde:%'"):
        try:
            j = json.loads(d)
            if j.get("v", 1) >= CELLS_VERSION and j.get("m", "drift") == ("slope" if slope else "drift"):
                have.add(k)
        except (ValueError, TypeError):
            pass
    added = 0
    import calendar
    for key in store.keys():
        if "sonde:" + key in have:
            continue
        try:                                             # skip old files without loading them
            nominal = calendar.timegm(_time.strptime(key, "%Y%m%d%H"))
        except ValueError:
            continue
        if nominal < now - cal_days * 86400 - 86400 or nominal < first_obs - 86400:
            continue
        rec = store.load(key)
        if not rec:
            continue
        launch = rec.get("launch") or rec.get("nominal")
        end = rec.get("end") or launch
        if launch is None or launch < now - cal_days * 86400 or launch < first_obs:
            continue
        if end + SONDE_WINDOW_SEC + 600 > now:
            continue                                     # aircraft after the balloon not in yet
        cells = sonde_cells(db, rec, slope)
        db.execute("INSERT OR REPLACE INTO gnss_cal (key, ts, data) VALUES (?, ?, ?)",
                   ("sonde:" + key, launch, json.dumps(cells, separators=(",", ":"))))
        added += 1
    has_current = db.execute("SELECT 1 FROM gnss_cal WHERE key = 'current'").fetchone() is not None
    if added or not has_current:
        rows = [(k[6:], _geoid_cells(json.loads(d))) for k, d in db.execute(
            "SELECT key, data FROM gnss_cal WHERE key LIKE 'sonde:%' AND ts >= ?",
            (now - cal_days * 86400,))]
        cal = fit_calibration(rows)
        db.execute("INSERT OR REPLACE INTO gnss_cal (key, ts, data) VALUES ('current', ?, ?)",
                   (now, json.dumps(cal, separators=(",", ":"))))
        _cache["cal"] = None
    db.commit()
    return added


def _geoid_cells(d: dict) -> dict:
    """Sonde cells of an older version (geoid not removed; kept only when the
    observations to compute them again are gone): GEOID_OLD_M subtracted."""
    if d.get("v", 1) >= 3:
        return d
    return dict(d, c=[[c[0], c[1], c[2] - GEOID_OLD_M] + list(c[3:]) for c in d.get("c", [])])


# ── hourly raw cells ────────────────────────────────────────────────────────

def _edge(D: dict, ft: float):
    """(height m above mean sea level of pressure altitude ft, time) at a
    single crossing, from the rows within ±THK_EDGE_FT with a difference and
    NACp ≥ 8; the EGM96 geoid at the crossing is removed."""
    idx = [i for i, a in enumerate(D["alt"])
           if a is not None and abs(a - ft) <= THK_EDGE_FT and D["gmb"][i] is not None
           and (D["nacp"][i] or 0) >= MIN_NACP]
    if len(idx) < 3:
        return None
    ts = [D["t"][i] for i in idx]
    if max(ts) - min(ts) > 240:                          # not one crossing (levelled off near it)
        return None
    pos = [(D["lat"][i], D["lon"][i]) for i in idx if D["lat"][i] is not None and D["lon"][i] is not None]
    if not pos:                                          # nearest row with a position
        tm = sum(ts) / len(ts)
        near = [i for i in range(len(D["t"])) if D["lat"][i] is not None and D["lon"][i] is not None]
        if not near:
            return None
        j = min(near, key=lambda i: abs(D["t"][i] - tm))
        pos = [(D["lat"][j], D["lon"][j])]
    n_ = undulation(sum(p[0] for p in pos) / len(pos), sum(p[1] for p in pos) / len(pos))
    return (ft + sum(D["gmb"][i] for i in idx) / len(idx)) * FT - n_, sum(ts) / len(ts)


def hour_cells(db, h: int, lat: float, lon: float, radius_km: float) -> dict:
    """Raw cells of the hour [h, h + 3600): see the module docstring.
    {"d": [[layer bottom, icao, mean gmb ft, mean alt ft, replies], …],
     "tk": [[lo, hi, icao, z_lo m, z_hi m, mid time, +1 climb / −1 descent], …],
     "v": CELLS_V, "g": 1} — gmb and the heights above mean sea level (the
    EGM96 geoid at each position removed); cells without "g" still contain it."""
    from collector.height_series import decode
    eps = _episodes(db, h - 4 * 3600, h + 3600 + 4 * 3600)
    acc: dict = {}
    for icao, ts, alt, la, lo, g in db.execute(
            """SELECT icao, ts, altitude, lat, lon, gmb_ft FROM observations
               WHERE ts >= ? AND ts < ? AND gmb_ft IS NOT NULL AND altitude IS NOT NULL
                 AND lat IS NOT NULL AND lon IS NOT NULL AND nacp >= ?""",
            (h, h + 3600, MIN_NACP)):
        if _km(la, lo, lat, lon) > radius_km or _in_ep(eps, icao, ts):
            continue
        k = layer_of(alt)
        if k is None:
            continue
        s = acc.setdefault((LAYER_EDGES[k], icao), [0.0, 0.0, 0])
        s[0] += g - undulation(la, lo) / FT              # above mean sea level
        s[1] += alt
        s[2] += 1
    d = [[k[0], k[1], round(v[0] / v[2], 1), round(v[1] / v[2]), v[2]] for k, v in sorted(acc.items())]
    tk = []
    try:
        blobs = db.execute(
            "SELECT icao, data FROM height_series WHERE t_end >= ? AND ts < ? AND alt_max - alt_min >= 4000",
            (h, h + 3600)).fetchall()
    except Exception:                                    # noqa: BLE001  (table missing)
        blobs = []
    for icao, blob in blobs:
        try:
            D = decode(blob)
        except Exception:                                # noqa: BLE001
            continue
        for lo_ft, hi_ft in THK_LAYERS:
            a, b = _edge(D, lo_ft), _edge(D, hi_ft)
            if not a or not b or abs(a[1] - b[1]) > THK_MAX_SEC:
                continue
            mid = (a[1] + b[1]) / 2
            if not (h <= mid < h + 3600) or _in_ep(eps, icao, a[1]) or _in_ep(eps, icao, b[1]):
                continue
            # position at mid time: inside the radius
            j = min(range(len(D["t"])), key=lambda i: abs(D["t"][i] - mid))
            la, lo = D["lat"][j], D["lon"][j]
            if la is None or lo is None or _km(la, lo, lat, lon) > radius_km:
                continue
            tk.append([lo_ft, hi_ft, icao, round(a[0], 1), round(b[0], 1), round(mid),
                       1 if b[1] > a[1] else -1])
    return {"d": d, "tk": tk, "v": CELLS_V, "g": 1}


def store_missing_gnss_hours(db, lat: float, lon: float, radius_km: float,
                             max_hours: int = 31 * 24, now: float | None = None,
                             pause_sec: float = 0.0) -> int:
    """Store the raw cells of every hour ending at least STORE_DELAY_H hours
    ago (within max_hours) without a gnss_hours row; hours before the first
    observation with a GNSS − baro difference are skipped.  One commit."""
    now = _time.time() if now is None else now
    last = int(now // 3600 * 3600) - STORE_DELAY_H * 3600      # first hour not yet final
    first_obs = db.execute("SELECT MIN(ts) FROM observations WHERE gmb_ft IS NOT NULL").fetchone()[0]
    if first_obs is None:
        return 0
    first = max(last - max_hours * 3600, int(first_obs // 3600 * 3600))
    have = {r[0] for r in db.execute("SELECT ts FROM gnss_hours WHERE ts >= ? AND ts < ?", (first, last))}
    rows = []
    for h in range(first, last, 3600):
        if h in have:
            continue
        rows.append((h, pack(hour_cells(db, h, lat, lon, radius_km))))
        if pause_sec:
            _time.sleep(pause_sec)
    if rows:
        db.executemany("INSERT OR IGNORE INTO gnss_hours (ts, data) VALUES (?, ?)", rows)
        db.commit()
    return len(rows) + _upgrade_cells(db, lat, lon, radius_km)


_upgraded = False


def _upgrade_cells(db, lat: float, lon: float, radius_km: float) -> int:
    """Once per start: hours stored by an older version (before CELLS_V) are
    computed again while their data still exist — the observations (D-value
    cells) and, for hours that had thickness rows, the height_series (v2:
    the 1 000–5 000 ft layer and the climb / descent flag; v3: the geoid
    removed).  Older hours keep their cells; the read side allows for them.
    One commit."""
    global _upgraded
    if _upgraded:
        return 0
    _upgraded = True
    try:
        first_obs = db.execute("SELECT MIN(ts) FROM observations WHERE gmb_ft IS NOT NULL").fetchone()[0]
        first_hs = db.execute("SELECT MIN(ts) FROM height_series").fetchone()[0]
    except Exception:                                    # noqa: BLE001  (table missing)
        return 0
    if first_obs is None:
        return 0
    h_obs = int(first_obs // 3600 * 3600) + 3600
    h_hs = int(first_hs // 3600 * 3600) + 3600 if first_hs is not None else None
    old = []
    for ts, data in db.execute("SELECT ts, data FROM gnss_hours WHERE ts >= ?", (h_obs,)):
        try:
            c = unpack(data)
            if c.get("v", 1) >= CELLS_V:
                continue
            if c.get("tk") and (h_hs is None or ts < h_hs):
                continue                                 # its height series are gone: keep it
        except Exception:                                # noqa: BLE001
            pass
        old.append(ts)
    rows = []
    for h in old:
        rows.append((pack(hour_cells(db, h, lat, lon, radius_km)), h))
        _time.sleep(0.2)
    if rows:
        db.executemany("UPDATE gnss_hours SET data = ? WHERE ts = ?", rows)
        db.commit()
    return len(rows)


def pack(cells: dict) -> bytes:
    return zlib.compress(json.dumps(cells, separators=(",", ":")).encode(), 9)


def unpack(data) -> dict:
    if isinstance(data, (bytes, memoryview)):
        return json.loads(zlib.decompress(bytes(data)))
    return json.loads(data)


_live: dict = {}                 # hour → (computed at, cells): recent hours not stored yet


def cells_for_hours(db, start: int, end: int, lat: float, lon: float, radius_km: float,
                    now: float | None = None) -> dict:
    """{hour: raw cells} for the hours in [start, end): stored rows, and the
    newest hours (not stored yet, at most STORE_DELAY_H + 1) computed live
    (cached CACHE_SEC / 2; the hour in progress 60 s)."""
    now = _time.time() if now is None else now
    out = {}
    try:
        for ts, data in db.execute("SELECT ts, data FROM gnss_hours WHERE ts >= ? AND ts < ?", (start, end)):
            try:
                out[ts] = unpack(data)
            except Exception:                            # noqa: BLE001
                pass
    except Exception:                                    # noqa: BLE001  (table missing)
        return out
    cur = int(now // 3600 * 3600)
    for h in range(max(start, cur - (STORE_DELAY_H + 1) * 3600), min(end, cur + 3600), 3600):
        if h in out:
            continue
        c = _live.get(h)
        if c is None or now - c[0] > (60 if h == cur else CACHE_SEC / 2):
            c = _live[h] = (now, hour_cells(db, h, lat, lon, radius_km))
        out[h] = c[1]
    for h in [k for k in _live if k < cur - (STORE_DELAY_H + 2) * 3600]:
        del _live[h]
    return out


# ── read side ───────────────────────────────────────────────────────────────

def _layer_temp_k(lv_temps: dict, lo_ft: float, hi_ft: float):
    """ln-p weighted mean temperature (K) of [lo, hi] from {layer bottom: °C}
    (atmos layers), or None below 80 % coverage."""
    num = den = 0.0
    for k in range(len(LAYER_EDGES) - 1):
        a, b = LAYER_EDGES[k], LAYER_EDGES[k + 1]
        t = lv_temps.get(a)
        if t is None or b <= lo_ft or a >= hi_ft:
            continue
        x0, x1 = max(a, lo_ft), min(b, hi_ft)
        w = math.log(isa_pressure(x0) / isa_pressure(x1))
        num += w * (t + 273.15)
        den += w
    full = math.log(isa_pressure(lo_ft) / isa_pressure(hi_ft))
    return num / den if den >= 0.8 * full else None


def column_products(cells: dict, cal: dict, lv_temps: dict, lat: float, lon: float | None = None):
    """(dv, tk) of one hour from its raw cells (cells stored before the geoid
    was removed: the geoid at (lat, lon) subtracted from their D-values):
    dv = [[layer bottom, D m, SD m, airframes], …]   (layers with ≥ 2 airframes)
    tk = [[lo, hi, Tv °C, SD K, flights, T Mach/TAS °C or None], …]"""
    dv = []
    by_layer: dict = {}
    g_old = 0.0 if cells.get("g") else undulation(lat, lon if lon is not None else 24.963) / FT
    for lo_ft, icao, g, alt, n in cells.get("d") or []:
        g -= g_old
        k = LAYER_EDGES.index(lo_ft) if lo_ft in LAYER_EDGES else None
        if k is None or k + 1 >= len(LAYER_EDGES):
            continue
        centre = (LAYER_EDGES[k] + LAYER_EDGES[k + 1]) / 2
        t = lv_temps.get(lo_ft)
        tk_ = (t + 273.15) if t is not None else isa_temp_k(centre)
        d = g * FT - correction(cal, centre, icao) + (tk_ / isa_temp_k(centre) - 1) * (centre - alt) * FT
        by_layer.setdefault(lo_ft, []).append(d)
    for lo_ft in sorted(by_layer):
        v = sorted(by_layer[lo_ft])
        if len(v) < 2:
            continue
        med = v[len(v) // 2] if len(v) % 2 else (v[len(v) // 2 - 1] + v[len(v) // 2]) / 2
        sd = math.sqrt(sum((x - med) ** 2 for x in v) / (len(v) - 1))
        dv.append([lo_ft, round(med, 1), round(sd, 1), len(v)])
    tk = []
    by_thk: dict = {}
    for lo_ft, hi_ft, icao, z1, z2, *_ in cells.get("tk") or []:
        z1c = z1 - correction(cal, lo_ft, icao)
        z2c = z2 - correction(cal, hi_ft, icao)
        dH = geopotential(z2c, lat) - geopotential(z1c, lat)
        tv = G0 * dH / (R_D * math.log(isa_pressure(lo_ft) / isa_pressure(hi_ft))) - 273.15
        by_thk.setdefault((lo_ft, hi_ft), []).append(tv)
    for (lo_ft, hi_ft), v in sorted(by_thk.items()):
        m = sum(v) / len(v)
        sd = math.sqrt(sum((x - m) ** 2 for x in v) / (len(v) - 1)) if len(v) > 1 else None
        tref = _layer_temp_k(lv_temps, lo_ft, hi_ft)
        tk.append([lo_ft, hi_ft, round(m, 2), round(sd, 2) if sd is not None else None, len(v),
                   round(tref - 273.15, 2) if tref is not None else None])
    return dv, tk


def summary(cal: dict, info=None) -> dict:
    """Calibration for display (API): correction per band, and per airframe
    the offset used (shrunk), the soundings it was seen at and its raw mean
    residual after the band correction; per type the mean of the airframes.
    info(icao) → (registration, type) or None."""
    b = cal.get("b") or {}
    bn = cal.get("bn") or {}
    vals = sorted(b.values())
    rows = []
    for ic in sorted(set(b) | set(bn)):
        m, raw = (bn.get(ic) or [None, None])
        reg, typ = (info(ic) if info else None) or (None, None)
        rows.append({"icao": ic, "reg": reg, "type": typ, "offset_m": b.get(ic, 0.0),
                     "soundings": m, "raw_m": raw})
    rows.sort(key=lambda r: (-(r["soundings"] or 0), -abs(r["raw_m"] or 0)))
    types: dict = {}
    for r in rows:
        if r["type"] and r["raw_m"] is not None:
            types.setdefault(r["type"], []).append(r["raw_m"])
    by_type = [{"type": t, "airframes": len(v), "mean_m": round(sum(v) / len(v), 1),
                "sd_m": round(math.sqrt(sum((x - sum(v) / len(v)) ** 2 for x in v) / (len(v) - 1)), 1) if len(v) > 1 else None}
               for t, v in types.items() if len(v) >= 2]
    by_type.sort(key=lambda r: -r["airframes"])
    return {"version": cal.get("v"), "computed": cal.get("t"), "soundings": cal.get("soundings"),
            "pairs": cal.get("pairs"),
            "bands": [{"ft": [k * BAND_FT, (k + 1) * BAND_FT], "corr_m": c, "cells": n, "prior_m": p}
                      for k, (c, n, p) in enumerate(zip(cal.get("curve") or PRIOR,
                                                        cal.get("nb") or [0] * len(PRIOR), PRIOR))],
            "airframes": len(rows),
            "offset_sd_m": round(math.sqrt(sum(x * x for x in vals) / len(vals)), 1) if vals else None,
            "offsets": b, "airframe_list": rows, "by_type": by_type}
