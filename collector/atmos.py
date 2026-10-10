"""
collector/atmos.py

Air temperature from Mode S Enhanced Surveillance replies and layer
aggregation of wind / temperature (Skew-T soundings and the hourly
profile archive).

Mach / TAS temperature
----------------------
BDS 5,0 reports true airspeed (TAS, 2 kt resolution) and BDS 6,0 the Mach
number (0.004 resolution).  Both come from the aircraft's air-data computer,
so the static air temperature follows directly from the speed of sound:

    a = TAS / M,   T = a² / (γ·R)   →   T[K] = 288.15 · (TAS / (661.47 · M))²

(661.47 kt is the speed of sound at 288.15 K).  One reply pair scatters by
about ±1.3 K (median absolute deviation) at cruise Mach 0.75–0.85 and about
±3–4 K at Mach 0.2–0.25 (approach), because the Mach resolution is fixed —
so values are used as (10 % trimmed) means over many replies.  Checked against the
Jokioinen radiosonde 8 Oct 2026 12 UTC (850–260 hPa, 2-hour median over
150 km): mean difference +0.7 K, SD 1.6 K.  Below Mach TM_MIN_MACH the
value is not computed.

Pressure for a level is the ISA pressure of the pressure altitude: Mode S /
ADS-B altitude is barometric altitude referenced to 1013.25 hPa, i.e. by
definition the ISA altitude of the static pressure — so this is the
measured static pressure, not an approximation.
"""

import math
import statistics

TM_MIN_MACH = 0.20     # below this the Mach resolution makes T too noisy
TM_MIN_TAS  = 60.0     # kt
TM_MAX_ISA_DEV = 40.0  # K — reject values further than this from ISA

# SQL expression giving the best temperature of an observation row:
# MRAR (measured) → Mach/TAS temperature (stored from 2026-10-09, computed
# from the stored BDS 5,0 TAS and BDS 6,0 Mach for older rows).
# MHR (BDS 4,5) temperatures are not used (since 2026-10-10): most of them are
# other Comm-B registers misidentified as BDS 4,5 — two thirds were more than
# 40 K from ISA (median ISA + 47 K) and they widened the layer p10–p90 spreads
# by up to 60 K.  They are still stored in mhr_temp for reference.
TEMP_SQL = (
    "COALESCE(mrar_temp, tm_temp,"
    " CASE WHEN bds60_mach >= 0.2 AND bds50_true_airspeed >= 60"
    " THEN 288.15 * (bds50_true_airspeed / (661.47 * bds60_mach))"
    "            * (bds50_true_airspeed / (661.47 * bds60_mach)) - 273.15 END)"
)

# Layer edges (ft, pressure altitude) for soundings and the hourly archive:
# 1 000 ft steps to 10 000 ft, then 2 000 ft steps to 46 000 ft.
LAYER_EDGES = list(range(0, 10_000, 1_000)) + list(range(10_000, 46_001, 2_000))


def isa_temperature_c(alt_ft: float) -> float:
    m = alt_ft * 0.3048
    return (288.15 - 0.0065 * m if m <= 11_000 else 216.65) - 273.15


def isa_pressure_hpa(alt_ft: float) -> float:
    """ISA pressure (hPa) of a pressure altitude (ft)."""
    m = alt_ft * 0.3048
    if m <= 11_000:
        return 1013.25 * (1.0 - 0.0065 * m / 288.15) ** 5.25588
    return 226.32 * math.exp(-0.000157688 * (m - 11_000))


def tm_temp_c(tas_kt, mach, alt_ft=None):
    """Static air temperature (°C) from TAS (kt) and Mach, or None."""
    if tas_kt is None or mach is None:
        return None
    try:
        tas, m = float(tas_kt), float(mach)
    except (TypeError, ValueError):
        return None
    if m < TM_MIN_MACH or tas < TM_MIN_TAS:
        return None
    t = 288.15 * (tas / (661.47 * m)) ** 2 - 273.15
    if not -85.0 <= t <= 50.0:
        return None
    if alt_ft is not None and abs(t - isa_temperature_c(alt_ft)) > TM_MAX_ISA_DEV:
        return None
    return round(t, 1)


def trimmed_mean(vals, cut: float = 0.1) -> float:
    """Mean without the lowest and highest `cut` fraction.  Mach is reported in
    0.004 steps (~1 K at cruise, ~4 K on approach), so the median of many
    replies snaps to a step; a trimmed mean averages across the steps and
    still ignores outliers."""
    v = sorted(vals)
    k = int(len(v) * cut)
    v = v[k:len(v) - k] or v
    return sum(v) / len(v)


def layer_of(alt_ft):
    """Index of the layer containing alt_ft, or None outside 0–46 000 ft."""
    if alt_ft is None or alt_ft < LAYER_EDGES[0] or alt_ft >= LAYER_EDGES[-1]:
        return None
    lo, hi = 0, len(LAYER_EDGES) - 1
    while hi - lo > 1:                     # binary search
        mid = (lo + hi) // 2
        if LAYER_EDGES[mid] <= alt_ft:
            lo = mid
        else:
            hi = mid
    return lo


def _pct(sorted_vals, q):
    return sorted_vals[min(len(sorted_vals) - 1, int(q * len(sorted_vals)))]


def aggregate_layers(rows) -> list:
    """Aggregate (alt_ft, temp_c, wind_spd, wind_dir) rows into layers.

    Returns a list of level dicts (surface first) for layers with data:
      alt_lo / alt_hi / altitude (centre, ft), pressure (ISA hPa at centre),
      temp (10 % trimmed mean °C), temp_p10 / temp_p90, temp_count,
      wind_spd / wind_dir (vector mean), wind_sd (RMS vector deviation, kt),
      wind_count.
    """
    acc: dict = {}
    for alt, temp, spd, wdir in rows:
        i = layer_of(alt)
        if i is None:
            continue
        a = acc.setdefault(i, {"t": [], "u": [], "v": []})
        if temp is not None:
            a["t"].append(float(temp))
        if spd is not None and wdir is not None:
            r = math.radians(wdir)
            a["u"].append(-spd * math.sin(r))
            a["v"].append(-spd * math.cos(r))
    out = []
    for i in sorted(acc):
        a = acc[i]
        lo, hi = LAYER_EDGES[i], LAYER_EDGES[i + 1]
        mid = (lo + hi) / 2
        lv = {"alt_lo": lo, "alt_hi": hi, "altitude": int(mid),
              "pressure": round(isa_pressure_hpa(mid), 1)}
        if a["t"]:
            t = sorted(a["t"])
            lv["temp"] = round(trimmed_mean(t), 1)
            lv["temp_p10"] = round(_pct(t, 0.1), 1)
            lv["temp_p90"] = round(_pct(t, 0.9), 1)
            lv["temp_count"] = len(t)
        if a["u"]:
            n = len(a["u"])
            um, vm = sum(a["u"]) / n, sum(a["v"]) / n
            lv["wind_spd"] = round(math.hypot(um, vm), 1)
            lv["wind_dir"] = round((math.degrees(math.atan2(-um, -vm)) + 360) % 360, 1)
            lv["wind_sd"] = round(math.sqrt(sum((u - um) ** 2 + (v - vm) ** 2
                                                for u, v in zip(a["u"], a["v"])) / n), 1)
            lv["wind_count"] = n
        out.append(lv)
    return out


def _haversine_km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(a))


def area_profile(db, t0: float, t1: float, lat: float, lon: float,
                 radius_km: float) -> tuple[list, int]:
    """Layer profile of all observations in [t0, t1) within radius_km of
    (lat, lon).  Returns (levels, observations used).  Read only."""
    rows = db.execute(
        f"""SELECT altitude, lat, lon, best_wind_spd, best_wind_dir,
                   {TEMP_SQL} AS temp
            FROM observations
            WHERE ts >= ? AND ts < ?
              AND altitude IS NOT NULL AND lat IS NOT NULL AND lon IS NOT NULL""",
        (t0, t1),
    ).fetchall()
    use = []
    for r in rows:
        if r["temp"] is None and r["best_wind_spd"] is None:
            continue
        try:
            if _haversine_km(lat, lon, r["lat"], r["lon"]) > radius_km:
                continue
        except (TypeError, ValueError):
            continue
        use.append((r["altitude"], r["temp"], r["best_wind_spd"], r["best_wind_dir"]))
    return aggregate_layers(use), len(use)


# ── Hourly profile archive (profile_hours table) ──────────────────────────────
# One row per completed UTC hour: the area profile of that hour, compact.
# Level list entries: [alt_lo, temp, p10, p90, tn, wdir, wspd, wsd, wn]
# (None where a layer has no temperature or no wind).

PROFILE_KEYS = ("alt_lo", "temp", "temp_p10", "temp_p90", "temp_count",
                "wind_dir", "wind_spd", "wind_sd", "wind_count")


def pack_levels(levels: list) -> list:
    return [[lv.get(k) for k in PROFILE_KEYS] for lv in levels]


def unpack_levels(packed: list) -> list:
    out = []
    for row in packed or []:
        lv = dict(zip(PROFILE_KEYS, row))
        i = layer_of(lv["alt_lo"])
        if i is None:
            continue
        lo, hi = LAYER_EDGES[i], LAYER_EDGES[i + 1]
        lv["alt_hi"] = hi
        lv["altitude"] = int((lo + hi) / 2)
        lv["pressure"] = round(isa_pressure_hpa((lo + hi) / 2), 1)
        out.append({k: v for k, v in lv.items() if v is not None})
    return out


def store_missing_profile_hours(db, lat: float, lon: float, radius_km: float,
                                max_hours: int = 31 * 24, now: float | None = None,
                                pause_sec: float = 0.0) -> int:
    """Compute and store the area profile of every completed UTC hour of the
    last max_hours that has no profile_hours row yet (normally just the hour
    that ended; after a first start or a stop it back-fills from the
    observations still in the database).  All rows in one commit.
    Returns the number of hours stored."""
    import json
    import time as _time
    now = _time.time() if now is None else now
    cur_hour = int(now // 3600 * 3600)
    first = cur_hour - max_hours * 3600
    oldest = db.execute("SELECT MIN(ts) FROM observations").fetchone()[0]
    if oldest is None:
        return 0
    first = max(first, int(oldest // 3600 * 3600))
    have = {r[0] for r in db.execute(
        "SELECT ts FROM profile_hours WHERE ts >= ? AND ts < ?", (first, cur_hour))}
    rows = []
    for h in range(first, cur_hour, 3600):
        if h in have:
            continue
        levels, used = area_profile(db, h, h + 3600, lat, lon, radius_km)
        if pause_sec:
            _time.sleep(pause_sec)     # back-fill: leave CPU / SD card to the collector
        if not used:
            continue
        rows.append((h, json.dumps({"r": radius_km, "n": used, "lv": pack_levels(levels)},
                                   separators=(",", ":"))))
    if rows:
        db.executemany("INSERT OR IGNORE INTO profile_hours (ts, data) VALUES (?, ?)", rows)
        db.commit()
    return len(rows)
