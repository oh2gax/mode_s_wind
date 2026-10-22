"""
web/api/windmap.py

Builds a gridded horizontal wind (and temperature) map from stored
observations within a chosen flight-level band and time window.

Grid
----
Square cells of cell_km × cell_km on a local flat projection centred on the
receiver (east–west distance scaled with cos(latitude)), so a cell is the same
size in both directions — a grid in degrees would be twice as tall as wide at
60° N.

Averaging (per aircraft first)
------------------------------
Within a cell, each aircraft's observations are averaged first (wind as U/V
components, so 350° and 010° give 000°), then the aircraft means are averaged.
One aircraft with 30 stored replies therefore counts as much as one with 3.
Each cell reports the aircraft count, the observation count and the spread
between aircraft (vector RMS difference of the wind, SD of the temperature).

Temperature at the level
------------------------
A ± band of up to 3 000 ft spans 6 K or more of normal cooling with height,
which would swamp the horizontal differences.  Each temperature is therefore
moved to the band centre with the lapse rate fitted to all temperatures of the
band and period (least squares, limited to −3.5 … +1.5 K / 1 000 ft — an
inversion inside the band gives a positive slope).  The map's ΔT is the cell
temperature minus the mean of all cells (weighted by aircraft): warm and cold
air masses and frontal zones, independent of the absolute level.

Position checks
---------------
Under GNSS interference an aircraft's broadcast position can freeze (the last
fix is repeated while the aircraft moves on) or jump to a false (spoofed)
place, e.g. a fixed point east of St Petersburg.  The wind itself (BDS 5,0 /
6,0) is unaffected, but it would be placed in the wrong cell.  Removed:
  • frozen positions — the same latitude / longitude as the aircraft's
    previous stored row ≥ 10 s earlier while moving (> 80 kt);
  • jumps — each aircraft's rows are split where the step between two
    positions is impossible (> 3 NM + 800 kt × time); only its largest
    consistent part is kept;
  • optionally (gnss_ok) all rows inside a GPS degradation episode of the
    aircraft (gps_episodes, + 120 s recovery).  Off by default: at cruise
    levels about two thirds of the observations fall inside an episode while
    most positions still move normally (inertial / hybrid navigation).
The number of aircraft with an episode is reported per cell.

QNH altitude correction
-----------------------
Transponders always transmit pressure altitude referenced to 1013.25 hPa.
Below the transition altitude (FL050) the band is shifted into pressure-
altitude space with the QNH of the period: the current METAR QNH when the
period ends within the last hour, otherwise the METAR QNH stored with the
hourly profile archive (profile_hours "m") nearest to the middle of the
period (within 3 h), else the current one.

    pressure_alt = msl_alt + (1013.25 − qnh_hpa) × 27.3
"""

import json
import math
import time

from collector.geoid import undulation   # GNSS heights are ellipsoidal: EGM96 geoid removed

TRANSITION_FL = 50             # FL050 — below this apply QNH correction
ISA_CORRECTION_FACTOR = 27.3   # ft per hPa
KM_PER_DEG_LAT = 110.57
FROZEN_MIN_DT = 10.0           # s — same position again after this long …
FROZEN_MIN_GS = 80.0           # kt — … while moving faster than this = frozen
JUMP_SLACK_NM = 3.0            # a step longer than this + JUMP_MAX_KT × Δt is impossible
JUMP_MAX_KT = 800.0
EPISODE_RECOVERY_SEC = 120.0
LAPSE_MIN, LAPSE_MAX = -3.5, 1.5   # K per 1 000 ft, limits of the fitted band lapse rate


def _hav_nm(la1, lo1, la2, lo2):
    p1, p2 = math.radians(la1), math.radians(la2)
    dp, dl = p2 - p1, math.radians(lo2 - lo1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 3440.065 * 2 * math.asin(min(1.0, math.sqrt(a)))


def period_qnh(db, start_ts: float, end_ts: float, now: float,
               current_qnh: float, current_ok: bool):
    """(qnh_hpa, source text) for the low-level correction of a period."""
    if end_ts >= now - 3600 and current_ok:
        return current_qnh, "METAR now"
    mid = (start_ts + end_ts) / 2
    try:
        rows = db.execute(
            "SELECT ts, data FROM profile_hours WHERE ts BETWEEN ? AND ?",
            (int(mid - 3 * 3600 - 1800), int(mid + 3 * 3600 - 1800))).fetchall()
    except Exception:                                    # noqa: BLE001
        rows = []
    best = None
    for ts, data in rows:
        try:
            q = (json.loads(data).get("m") or {}).get("q")
        except (ValueError, TypeError):
            continue
        if q is None:
            continue
        d = abs(ts + 1800 - mid)
        if best is None or d < best[0]:
            best = (d, float(q), ts)
    if best is not None:
        return best[1], "METAR " + time.strftime("%d %H UTC", time.gmtime(best[2]))
    return current_qnh, "METAR now" if current_ok else "standard (no METAR)"


G0 = 9.80665
OMEGA = 7.2921e-5
KT_PER_MS = 1.943844
GEO_MIN_AC = 6                 # plane fit of the heights: at least this many aircraft …
GEO_MIN_SPREAD_KM = 30.0       # … spread at least this much in both directions


def _isa_height_m(ft: float) -> float:
    """Geopotential height of the pressure altitude in the standard atmosphere (m)."""
    return ft * 0.3048


def geostrophic(pts, lat0: float):
    """Plane fit D = a + b·x + c·y of the aircraft heights of the pressure
    surface (one point per aircraft and cell; outliers > 3 × RMS, at least
    20 m, removed and refitted) → geostrophic wind of the area
    (Vg = g / f · k × ∇z), the mean measured wind of the same points and the
    ageostrophic difference.  None when too few or too clustered aircraft."""
    if len(pts) < GEO_MIN_AC:
        return None

    def fit(P):
        n = len(P)
        mx = sum(p[0] for p in P) / n
        my = sum(p[1] for p in P) / n
        sxx = sum((p[0] - mx) ** 2 for p in P) / n
        syy = sum((p[1] - my) ** 2 for p in P) / n
        sxy = sum((p[0] - mx) * (p[1] - my) for p in P) / n
        lmin = (sxx + syy) / 2 - math.sqrt(((sxx - syy) / 2) ** 2 + sxy ** 2)
        if lmin < GEO_MIN_SPREAD_KM ** 2:
            return None
        md = sum(p[2] for p in P) / n
        sx = sum((p[0] - mx) * (p[2] - md) for p in P) / n
        sy = sum((p[1] - my) * (p[2] - md) for p in P) / n
        D = sxx * syy - sxy * sxy
        gx = (sx * syy - sy * sxy) / D
        gy = (sy * sxx - sx * sxy) / D
        res = [p[2] - (md + gx * (p[0] - mx) + gy * (p[1] - my)) for p in P]
        return gx, gy, res, (sxx, syy, sxy, D, n), md, (mx, my)

    f0 = fit(pts)
    if f0 is None:
        return None
    rms = math.sqrt(sum(r * r for r in f0[2]) / len(f0[2]))
    keep = [p for p, r in zip(pts, f0[2]) if abs(r) <= max(3 * rms, 20.0)]
    f1 = fit(keep) if len(keep) >= GEO_MIN_AC else None
    if f1 is None:
        return None
    gx, gy, res, (sxx, syy, sxy, D, n), md, (mx, my) = f1
    f = 2 * OMEGA * math.sin(math.radians(lat0))
    k = G0 / f / 1000.0 * KT_PER_MS                 # (m per km) → kt
    ug, vg = -k * gy, k * gx
    s2 = sum(r * r for r in res) / max(1, n - 3)
    se_gx = math.sqrt(s2 / (n * D / syy)) if D > 0 else None
    se_gy = math.sqrt(s2 / (n * D / sxx)) if D > 0 else None
    se = k * math.hypot(se_gx or 0, se_gy or 0)
    um = sum(p[3] for p in keep) / n
    vm = sum(p[4] for p in keep) / n
    to_dir = lambda u, v: (math.degrees(math.atan2(-u, -v)) % 360, math.hypot(u, v))
    gd, gs = to_dir(ug, vg)
    mdir, ms = to_dir(um, vm)
    ad, as_ = to_dir(um - ug, vm - vg)
    return {"dir": round(gd), "spd": round(gs, 1), "se_kt": round(se, 1),
            "meas_dir": round(mdir), "meas_spd": round(ms, 1),
            "ageo_dir": round(ad), "ageo_spd": round(as_, 1),
            "grad_m_per_100km": round(math.hypot(gx, gy) * 100, 1),
            "d_mean_m": round(md, 1), "rms_m": round(math.sqrt(s2), 1), "aircraft": n,
            "removed": len(pts) - n,
            "centre_km": [round(mx, 1), round(my, 1)]}


def _episodes(db, start_ts, end_ts):
    """{icao: [(t0, t1), …]} of GPS degradation episodes overlapping the period."""
    out = {}
    try:
        for icao, t0, t1 in db.execute(
                "SELECT icao, t_start, t_end FROM gps_episodes "
                "WHERE t_end >= ? AND t_start <= ?",
                (start_ts - EPISODE_RECOVERY_SEC, end_ts)):
            if t0 is None:
                continue
            out.setdefault(icao, []).append((t0, (t1 or t0) + EPISODE_RECOVERY_SEC))
    except Exception:                                    # noqa: BLE001  (table missing)
        pass
    return out


def position_checked(rows, eps, gnss_ok):
    """Rows (icao, ts, lat, lon, altitude, groundspeed, …) ordered by icao, ts
    → ([(row, in_episode)], frozen, jumped, gnss-removed): frozen positions
    and impossible jumps removed (largest consistent part per aircraft kept),
    rows inside GPS episodes dropped when gnss_ok."""
    kept = []
    n_frozen = n_jump = n_gnss = 0
    i = 0
    while i < len(rows):
        icao = rows[i][0]
        j = i
        while j < len(rows) and rows[j][0] == icao:
            j += 1
        track = rows[i:j]
        i = j
        # frozen positions
        good, prev = [], None
        for r in track:
            if (prev is not None and r[2] == prev[2] and r[3] == prev[3]
                    and r[1] - prev[1] >= FROZEN_MIN_DT
                    and (r[5] is None or r[5] > FROZEN_MIN_GS)):
                n_frozen += 1
            else:
                good.append(r)
            prev = r
        # impossible jumps: split into consistent parts, keep the largest
        if good:
            parts, cur = [], [good[0]]
            for r in good[1:]:
                p = cur[-1]
                d = _hav_nm(p[2], p[3], r[2], r[3])
                if d > JUMP_SLACK_NM + JUMP_MAX_KT * max(0.0, r[1] - p[1]) / 3600.0:
                    parts.append(cur)
                    cur = [r]
                else:
                    cur.append(r)
            parts.append(cur)
            best = max(parts, key=len)
            n_jump += len(good) - len(best)
            good = best
        ep = eps.get(icao)
        for r in good:
            in_ep = bool(ep) and any(a <= r[1] <= b for a, b in ep)
            if in_ep and gnss_ok:
                n_gnss += 1
                continue
            kept.append((r, in_ep))
    return kept, n_frozen, n_jump, n_gnss


# ── Shared steps of one map (also used by the multi-frame builder) ────────────

_OBS_SQL = """SELECT icao, ts, lat, lon, altitude, groundspeed,
                  best_wind_spd, best_wind_dir, best_temp, gmb_ft, nacp
           FROM observations
           WHERE {alt}altitude BETWEEN ? AND ?
             AND ts          BETWEEN ? AND ?
             AND best_wind_spd IS NOT NULL
             AND best_wind_dir IS NOT NULL
             AND lat IS NOT NULL
             AND lon IS NOT NULL
           ORDER BY icao, ts"""
TS_INDEX_MAX_S = 72 * 3600      # periods up to this long are read through the time index


def _obs_rows(db, alt_lo, alt_hi, start_ts, end_ts):
    """Observations of an altitude band and period, ordered by icao, ts.
    SQLite would pick the altitude index, which reads the band over the whole
    database (a month); for periods up to a few days the time index is
    10–50 × faster, so the altitude index is switched off there ("+altitude")."""
    sql = _OBS_SQL.format(alt="+" if end_ts - start_ts <= TS_INDEX_MAX_S else "")
    return db.execute(sql, (alt_lo, alt_hi, start_ts, end_ts)).fetchall()


def _new_ac():
    # Sums of one aircraft in one cell.  Temperature and D-value are kept as
    # raw sums plus the summed height offset from the band centre, so the
    # lapse-rate and D-value corrections (which depend on the whole band and
    # period) are applied afterwards: t = t0 − lapse·ta/1000, d = d0 + k_d·da.
    return {"u": 0.0, "v": 0.0, "n": 0, "t0": 0.0, "ta": 0.0, "tn": 0, "ep": False,
            "d0": 0.0, "da": 0.0, "dn": 0, "x": 0.0, "y": 0.0}


class _Binner:
    """Rows → cell → aircraft sums, plus the lapse-fit sums of the band."""

    def __init__(self, cell_km, center_lat, center_lon, cal):
        self.cell_km = cell_km
        self.lat0, self.lon0 = center_lat, center_lon
        self.kx = KM_PER_DEG_LAT * math.cos(math.radians(center_lat))
        self.cal = cal
        self.cells: dict = {}
        self.lap = [0, 0.0, 0.0, 0.0, 0.0]     # n, Σa, Σt, Σa², Σa·t  (a = alt − centre)

    def add(self, r, in_ep, centre):
        from collector import gnss_heights as gh
        x = (r[3] - self.lon0) * self.kx
        y = (r[2] - self.lat0) * KM_PER_DEG_LAT
        key = (math.floor(x / self.cell_km), math.floor(y / self.cell_km))
        spd = float(r[6])
        dr = math.radians(float(r[7]))
        a = self.cells.setdefault(key, {}).get(r[0])
        if a is None:
            a = self.cells[key][r[0]] = _new_ac()
        a["u"] += -spd * math.sin(dr)
        a["v"] += -spd * math.cos(dr)
        a["n"] += 1
        a["x"] += x
        a["y"] += y
        a["ep"] = a["ep"] or in_ep
        off = r[4] - centre
        if r[9] is not None and (r[10] or 0) >= gh.MIN_NACP and not in_ep:
            a["d0"] += r[9] * gh.FT - undulation(r[2], r[3]) - gh.correction(self.cal, r[4], r[0])
            a["da"] += -off
            a["dn"] += 1
        if r[8] is not None:
            t = float(r[8])
            a["t0"] += t
            a["ta"] += off
            a["tn"] += 1
            lp = self.lap
            lp[0] += 1; lp[1] += off; lp[2] += t; lp[3] += off * off; lp[4] += off * t


def _lapse(lap, fl):
    """Fitted band lapse rate (K / 1 000 ft) from the sums, or the standard."""
    n, sa, st, saa, sat = lap
    if n >= 10:
        mx, my = sa / n, st / n
        sxx = saa - n * mx * mx
        if sxx > 0 and math.sqrt(sxx / n) >= 150:          # altitudes spread enough to fit
            slope = (sat - n * mx * my) / sxx * 1000.0
            return min(LAPSE_MAX, max(LAPSE_MIN, slope))
    return -2.0 if fl >= 50 else -1.5                       # ≈ standard, K / 1 000 ft


def _cells_out(cells, lap, fl, alt_centre_query, cell_km, center_lat, center_lon):
    """Cell → aircraft sums → (result cells, layer temperature, geostrophic, lapse)."""
    from collector import gnss_heights as gh
    lapse = _lapse(lap, fl)
    # D-value moved to the band centre: dD/dz_p = T / T_isa − 1
    t_band = lap[2] / lap[0] if lap[0] else None
    tisa_c = gh.isa_temp_k(alt_centre_query)
    k_d = ((t_band + 273.15) / tisa_c - 1) if t_band is not None else 0.0
    km_per_deg_lon = KM_PER_DEG_LAT * math.cos(math.radians(center_lat))

    result_cells = []
    geo_pts = []                    # (x km, y km, D m, u kt, v kt) per aircraft and cell
    for (cx, cy), acs in cells.items():
        means = []
        dvals = []
        for a in acs.values():
            t = ((a["t0"] - lapse * a["ta"] / 1000.0) / a["tn"]) if a["tn"] else None
            means.append((a["u"] / a["n"], a["v"] / a["n"], t, a["n"], a["ep"]))
            if a["dn"]:
                dv = (a["d0"] + k_d * a["da"] * gh.FT) / a["dn"]
                dvals.append(dv)
                geo_pts.append((a["x"] / a["n"], a["y"] / a["n"], dv,
                                a["u"] / a["n"], a["v"] / a["n"]))
        k = len(means)
        u_m = sum(m[0] for m in means) / k
        v_m = sum(m[1] for m in means) / k
        spd_avg = math.hypot(u_m, v_m)
        dir_avg = math.degrees(math.atan2(-u_m, -v_m)) % 360
        w_sd = (math.sqrt(sum((m[0] - u_m) ** 2 + (m[1] - v_m) ** 2 for m in means) / (k - 1))
                if k >= 2 else None)
        temps = [m[2] for m in means if m[2] is not None]
        t_avg = sum(temps) / len(temps) if temps else None
        t_sd = (math.sqrt(sum((t - t_avg) ** 2 for t in temps) / (len(temps) - 1))
                if len(temps) >= 2 else None)
        lat_s = center_lat + cy * cell_km / KM_PER_DEG_LAT
        lat_n = center_lat + (cy + 1) * cell_km / KM_PER_DEG_LAT
        lon_w = center_lon + cx * cell_km / km_per_deg_lon
        lon_e = center_lon + (cx + 1) * cell_km / km_per_deg_lon
        result_cells.append({
            "lat":      round((lat_s + lat_n) / 2, 4),
            "lon":      round((lon_w + lon_e) / 2, 4),
            "bounds":   [round(lat_s, 4), round(lon_w, 4), round(lat_n, 4), round(lon_e, 4)],
            "wind_spd": round(spd_avg, 1),
            "wind_dir": round(dir_avg, 1),
            "wind_sd":  round(w_sd, 1) if w_sd is not None else None,
            "temp":     round(t_avg, 1) if t_avg is not None else None,
            "temp_sd":  round(t_sd, 1) if t_sd is not None else None,
            "temp_ac":  len(temps),
            "ac":       k,
            "obs":      sum(m[3] for m in means),
            "gnss_deg": sum(1 for m in means if m[4]),
            "dval":     round(sorted(dvals)[len(dvals) // 2], 1) if dvals else None,
            "dval_ac":  len(dvals),
        })

    # Layer mean temperature (weighted by aircraft) → ΔT per cell
    tw = [(c["temp"], c["temp_ac"]) for c in result_cells if c["temp"] is not None]
    t_layer = (sum(t * w for t, w in tw) / sum(w for _, w in tw)) if tw else None
    for c in result_cells:
        c["dtemp"] = (round(c["temp"] - t_layer, 1)
                      if c["temp"] is not None and t_layer is not None else None)

    # Fewest aircraft first so better-supported cells render on top
    result_cells.sort(key=lambda c: (c["ac"], c["obs"]))
    return result_cells, t_layer, geostrophic(geo_pts, center_lat), lapse


def _result(fl, tolerance_ft, cell_km, alt_centre_query, cells_out, n_query, n_used,
            removed, gnss_ok, n_aircraft, cal, qnh_hpa, qnh_source, qnh_correction_ft,
            start_ts, end_ts):
    result_cells, t_layer, geo, lapse = cells_out
    return {
        "fl":                  fl,
        "altitude_ft":         fl * 100,         # MSL altitude the user requested
        "alt_query_ft":        round(alt_centre_query),  # pressure altitude of the band centre
        "tolerance_ft":        tolerance_ft,
        "cell_km":             cell_km,
        "cells":               result_cells,
        "obs_query":           n_query,
        "obs_used":            n_used,
        "removed":             {"frozen": removed[0], "jump": removed[1], "gnss": removed[2]},
        "gnss_ok":             bool(gnss_ok),
        "aircraft":            n_aircraft,
        "cells_count":         len(result_cells),
        "temp_layer":          round(t_layer, 1) if t_layer is not None else None,
        "geo":                 geo,
        "z_isa_m":             round(_isa_height_m(alt_centre_query), 1),
        "gcal":                {"soundings": cal.get("soundings"), "pairs": cal.get("pairs")},
        "lapse_k_per_1000ft":  round(lapse, 2),
        "qnh_hpa":             round(qnh_hpa, 1),
        "qnh_source":          qnh_source,
        "qnh_correction_ft":   round(qnh_correction_ft, 0) if fl < TRANSITION_FL else None,
        "period_start":        time.strftime("%Y-%m-%d %H:%M", time.gmtime(start_ts)) + " UTC",
        "period_end":          time.strftime("%Y-%m-%d %H:%M", time.gmtime(end_ts))   + " UTC",
        "start_ts":            start_ts,
        "end_ts":              end_ts,
        "generated_at":        time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())      + " UTC",
    }


def _qnh_shift_ft(fl, qnh_hpa):
    """Pressure-altitude shift of the band below the transition altitude."""
    return (1013.25 - qnh_hpa) * ISA_CORRECTION_FACTOR if fl < TRANSITION_FL else 0.0


def build_windmap(
    db,
    fl: int,               # flight level (e.g. 350 for FL350 = 35 000 ft)
    tolerance_ft: int,     # ± ft band around the centre altitude
    start_ts: float,       # period start (Unix timestamp, UTC)
    end_ts: float,         # period end   (Unix timestamp, UTC)
    cell_km: float,        # grid-cell size (km)
    qnh_hpa: float = 1013.25,  # QNH (hPa) of the period; used below FL050
    qnh_source: str = "",
    center_lat: float = 60.317,
    center_lon: float = 24.963,
    gnss_ok: bool = False,  # drop rows inside GPS degradation episodes
) -> dict:
    """
    Query observations in the altitude band and time range, remove frozen and
    impossible positions, bin into square cells and return per-cell wind and
    temperature averaged per aircraft first.
    """
    # Below transition altitude: shift query band into pressure-altitude space
    alt_centre_query = fl * 100 + _qnh_shift_ft(fl, qnh_hpa)
    rows = _obs_rows(db, alt_centre_query - tolerance_ft, alt_centre_query + tolerance_ft,
                     start_ts, end_ts)
    return _map_from_rows(db, rows, _episodes(db, start_ts, end_ts), fl, tolerance_ft,
                          start_ts, end_ts, cell_km, qnh_hpa, qnh_source,
                          center_lat, center_lon, gnss_ok)


def _map_from_rows(db, rows, eps, fl, tolerance_ft, start_ts, end_ts, cell_km,
                   qnh_hpa, qnh_source, center_lat, center_lon, gnss_ok):
    """The map of one period from its queried rows (ordered by icao, ts)."""
    from collector import gnss_heights as gh
    qnh_correction_ft = _qnh_shift_ft(fl, qnh_hpa)
    alt_centre_query = fl * 100 + qnh_correction_ft

    # Position checks per aircraft
    kept, n_frozen, n_jump, n_gnss = position_checked(rows, eps, gnss_ok)

    # Bin: cell → aircraft → sums (D-value with the current GNSS calibration,
    # collector/gnss_heights.py); lapse rate and D-value moved to the band centre
    cal = gh.current(db)
    b = _Binner(cell_km, center_lat, center_lon, cal)
    for r, in_ep in kept:
        b.add(r, in_ep, alt_centre_query)
    out = _cells_out(b.cells, b.lap, fl, alt_centre_query, cell_km, center_lat, center_lon)
    return _result(fl, tolerance_ft, cell_km, alt_centre_query, out, len(rows), len(kept),
                   (n_frozen, n_jump, n_gnss), gnss_ok, len({r[0] for r, _ in kept}), cal,
                   qnh_hpa, qnh_source, qnh_correction_ft, start_ts, end_ts)


# ── All frames of the time slider in one go ───────────────────────────────────

FRAMES_MAX = 48                 # frames per request
FRAMES_MAX_PERIOD_S = 24 * 3600  # period length per frame


def build_windmap_frames(db, fl: int, tolerance_ft: int, end_ts: float, period_s: float,
                         n_frames: int, cell_km: float, qnh_of=None,
                         center_lat: float = 60.317, center_lon: float = 24.963,
                         gnss_ok: bool = False) -> dict:
    """
    n_frames maps of period_s seconds each, the newest ending at end_ts and
    each one an hour earlier than the next (the Wind Map time slider), from a
    single query.

    Reading the observations is nearly all of the time a map takes, so the
    whole span (n_frames − 1 h + period) is read once; each frame then takes
    its own rows from memory and goes through the same position checks,
    binning and averaging as a single map (build_windmap), with its own QNH
    (qnh_of(start, end) → (hPa, source); used below FL050).  The frames are
    therefore identical to single maps of the same periods.
    """
    H = 3600
    t0 = end_ts - (n_frames - 1) * H - period_s
    per = []
    for k in range(n_frames):                       # k = 0: the newest frame
        e = end_ts - k * H
        s = e - period_s
        q, src = qnh_of(s, e) if qnh_of is not None else (1013.25, "")
        per.append((s, e, q, src, fl * 100 + _qnh_shift_ft(fl, q)))
    lo = min(p[4] for p in per) - tolerance_ft
    hi = max(p[4] for p in per) + tolerance_ft
    rows = _obs_rows(db, lo, hi, t0, end_ts)
    eps = _episodes(db, t0, end_ts)
    frames = []
    for s, e, q, src, c in per:
        sub = [r for r in rows
               if s <= r[1] <= e and c - tolerance_ft <= r[4] <= c + tolerance_ft]
        frames.append(_map_from_rows(db, sub, eps, fl, tolerance_ft, s, e, cell_km,
                                     q, src, center_lat, center_lon, gnss_ok))
    return {"fl": fl, "tolerance_ft": tolerance_ft, "cell_km": cell_km,
            "period_s": period_s, "end_ts": end_ts, "frames": frames}


# ── Vertical cross-section along a line ───────────────────────────────────────

def build_xsection(db, lat1: float, lon1: float, lat2: float, lon2: float,
                   start_ts: float, end_ts: float, width_km: float = 50.0,
                   step_km: float = 25.0, gnss_ok: bool = False,
                   center_lat: float = 60.317) -> dict:
    """Vertical cross-section along the line A (lat1, lon1) → B (lat2, lon2):
    all observations of the period within width_km of the line (all levels;
    frozen / impossible positions removed as for the map), binned by the
    distance along the line (step_km) and the time–height altitude layers
    (atmos.LAYER_EDGES, pressure altitude).  Per bin and layer each aircraft
    is averaged first, then the aircraft: temperature, wind (vector), the
    D-value of the pressure surface from GNSS − baro (calibrated, NACp ≥ 8,
    outside episodes) and the aircraft count.

    {"a", "b", "length_km", "step_km", "width_km", "bins", "layers",
     "cells": [[bin, alt_lo, temp, wind_dir, wind_spd, aircraft, dval], …],
     "aircraft", "obs_used", "removed", "period_start", "period_end"}"""
    from collector.atmos import LAYER_EDGES, layer_of
    from collector import gnss_heights as gh
    kx = KM_PER_DEG_LAT * math.cos(math.radians(center_lat))
    ax, ay = lon1 * kx, lat1 * KM_PER_DEG_LAT
    bx, by = lon2 * kx, lat2 * KM_PER_DEG_LAT
    L = math.hypot(bx - ax, by - ay)
    if L < 1.0:
        return {"error": "line too short"}
    ex, ey = (bx - ax) / L, (by - ay) / L
    pad_lat = width_km / KM_PER_DEG_LAT
    pad_lon = width_km / kx
    rows = db.execute(
        """SELECT icao, ts, lat, lon, altitude, groundspeed,
                  best_wind_spd, best_wind_dir, best_temp, gmb_ft, nacp
           FROM observations
           WHERE ts BETWEEN ? AND ?
             AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
             AND altitude IS NOT NULL
             AND (best_temp IS NOT NULL OR best_wind_spd IS NOT NULL)
           ORDER BY icao, ts""",
        (start_ts, end_ts, min(lat1, lat2) - pad_lat, max(lat1, lat2) + pad_lat,
         min(lon1, lon2) - pad_lon, max(lon1, lon2) + pad_lon)).fetchall()
    eps = _episodes(db, start_ts, end_ts)
    kept, n_frozen, n_jump, n_gnss = position_checked(rows, eps, gnss_ok)
    cal = gh.current(db)
    nb = max(1, int(math.ceil(L / step_km)))
    acc: dict = {}
    used = 0
    for r, in_ep in kept:
        px, py = r[3] * kx - ax, r[2] * KM_PER_DEG_LAT - ay
        s_ = px * ex + py * ey
        d_ = -px * ey + py * ex
        if s_ < 0 or s_ > L or abs(d_) > width_km:
            continue
        k = layer_of(r[4])
        if k is None:
            continue
        b = min(nb - 1, int(s_ // step_km))
        a = acc.setdefault((b, LAYER_EDGES[k]), {}).setdefault(
            r[0], [0.0, 0, 0.0, 0.0, 0, 0.0, 0])
        if r[8] is not None:
            a[0] += float(r[8]); a[1] += 1
        if r[6] is not None and r[7] is not None:
            rr = math.radians(float(r[7]))
            a[2] += -float(r[6]) * math.sin(rr); a[3] += -float(r[6]) * math.cos(rr); a[4] += 1
        if r[9] is not None and (r[10] or 0) >= gh.MIN_NACP and not in_ep:
            centre = (LAYER_EDGES[k] + LAYER_EDGES[k + 1]) / 2
            a[5] += r[9] * gh.FT - undulation(r[2], r[3]) - gh.correction(cal, centre, r[0]); a[6] += 1
        used += 1
    cells = []
    for (b, lo), acs in sorted(acc.items()):
        ts_ = [a[0] / a[1] for a in acs.values() if a[1]]
        us = [(a[2] / a[4], a[3] / a[4]) for a in acs.values() if a[4]]
        ds = sorted(a[5] / a[6] for a in acs.values() if a[6])
        t = round(sum(ts_) / len(ts_), 2) if ts_ else None
        wd = ws = None
        if us:
            u = sum(x for x, _ in us) / len(us)
            v = sum(y for _, y in us) / len(us)
            ws = round(math.hypot(u, v), 1)
            wd = round(math.degrees(math.atan2(-u, -v)) % 360)
        dv = round(ds[len(ds) // 2], 1) if ds else None
        cells.append([b, lo, t, wd, ws, len(acs), dv])
    return {
        "a": [lat1, lon1], "b": [lat2, lon2], "length_km": round(L, 1),
        "step_km": step_km, "width_km": width_km, "bins": nb, "layers": LAYER_EDGES,
        "dir_deg": round(math.degrees(math.atan2(ex, ey)) % 360, 1),
        "cells": cells, "aircraft": len({r[0] for r, _ in kept}), "obs_used": used,
        "removed": {"frozen": n_frozen, "jump": n_jump, "gnss": n_gnss},
        "period_start": time.strftime("%Y-%m-%d %H:%M", time.gmtime(start_ts)) + " UTC",
        "period_end": time.strftime("%Y-%m-%d %H:%M", time.gmtime(end_ts)) + " UTC",
    }
