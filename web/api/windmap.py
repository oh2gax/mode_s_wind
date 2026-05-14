"""
web/api/windmap.py

Builds a gridded horizontal wind map from stored observations within a
chosen flight-level band and time window.

Wind vectors within each grid cell are averaged using U/V component
decomposition so that directional accuracy is preserved — e.g. averaging
350° and 010° correctly produces 000°, not 180°.

QNH altitude correction
-----------------------
Transponders always transmit pressure altitude referenced to 1013.25 hPa,
regardless of the QNH setting on the aircraft's altimeter.  Below the
transition altitude (FL050 / 5 000 ft) the difference between pressure
altitude and true MSL altitude can be several hundred feet when QNH departs
significantly from standard — common in Finnish winter conditions.

When a low-altitude layer is requested (fl < TRANSITION_FL) and a QNH value
is provided, the centre altitude is shifted into pressure-altitude space
before the DB query so that observations at the correct MSL altitude are
returned.  The displayed altitude in the response remains the original
MSL value the user selected.

Correction formula:
    pressure_alt = msl_alt + (1013.25 − qnh_hpa) × 27.3
"""

import math
import time

TRANSITION_FL = 50        # FL050 — below this apply QNH correction
ISA_CORRECTION_FACTOR = 27.3   # ft per hPa


def build_windmap(
    db,
    fl: int,               # flight level (e.g. 350 for FL350 = 35 000 ft)
    tolerance_ft: int,     # ± ft band around the centre altitude
    start_ts: float,       # period start (Unix timestamp, UTC)
    end_ts: float,         # period end   (Unix timestamp, UTC)
    grid_deg: float,       # grid-cell size in decimal degrees
    qnh_hpa: float = 1013.25,  # current airport QNH (hPa); used below FL050
) -> dict:
    """
    Query observations in the altitude band and time range, bin them into
    a regular lat/lon grid, and return averaged wind + temperature per cell.
    """
    alt_centre_msl = fl * 100    # requested MSL altitude (what the user sees)

    # Below transition altitude: shift query band into pressure-altitude space
    # so the DB lookup matches what transponders actually transmitted.
    if fl < TRANSITION_FL:
        qnh_correction_ft = (1013.25 - qnh_hpa) * ISA_CORRECTION_FACTOR
        alt_centre_query  = alt_centre_msl + qnh_correction_ft
    else:
        qnh_correction_ft = 0.0
        alt_centre_query  = float(alt_centre_msl)

    alt_min = alt_centre_query - tolerance_ft
    alt_max = alt_centre_query + tolerance_ft

    rows = db.execute(
        """SELECT lat, lon, best_wind_spd, best_wind_dir, best_temp
           FROM observations
           WHERE altitude    BETWEEN ? AND ?
             AND ts          BETWEEN ? AND ?
             AND best_wind_spd IS NOT NULL
             AND best_wind_dir IS NOT NULL
             AND lat IS NOT NULL
             AND lon IS NOT NULL""",
        (alt_min, alt_max, start_ts, end_ts),
    ).fetchall()

    # ── Bin into grid cells and accumulate U/V vectors ────────────────────
    cells: dict = {}

    for row in rows:
        # Snap lat/lon to nearest grid node
        glat = round(round(row["lat"] / grid_deg) * grid_deg, 6)
        glon = round(round(row["lon"] / grid_deg) * grid_deg, 6)
        key  = (glat, glon)

        spd     = float(row["best_wind_spd"])
        dir_rad = math.radians(float(row["best_wind_dir"]))

        # Meteorological convention: wind FROM direction
        # U = westward component, V = southward component
        u = -spd * math.sin(dir_rad)
        v = -spd * math.cos(dir_rad)

        if key not in cells:
            cells[key] = {
                "u": 0.0, "v": 0.0,
                "temp_sum": 0.0, "temp_count": 0,
                "obs": 0,
            }

        c = cells[key]
        c["u"]   += u
        c["v"]   += v
        c["obs"] += 1

        if row["best_temp"] is not None:
            c["temp_sum"]   += float(row["best_temp"])
            c["temp_count"] += 1

    # ── Compute cell averages and convert back to speed / direction ───────
    result_cells = []

    for (glat, glon), c in cells.items():
        n   = c["obs"]
        u_m = c["u"] / n
        v_m = c["v"] / n

        spd_avg = math.sqrt(u_m ** 2 + v_m ** 2)
        dir_avg = math.degrees(math.atan2(-u_m, -v_m)) % 360

        temp_avg = (c["temp_sum"] / c["temp_count"]) if c["temp_count"] > 0 else None

        result_cells.append({
            "lat":      glat,
            "lon":      glon,
            "wind_spd": round(spd_avg, 1),
            "wind_dir": round(dir_avg, 1),
            "temp":     round(temp_avg, 1) if temp_avg is not None else None,
            "obs":      n,
        })

    # Sort ascending by obs count so denser cells render on top in the browser
    result_cells.sort(key=lambda x: x["obs"])

    return {
        "fl":                  fl,
        "altitude_ft":         alt_centre_msl,   # MSL altitude the user requested
        "tolerance_ft":        tolerance_ft,
        "grid_deg":            grid_deg,
        "cells":               result_cells,
        "obs_used":            len(rows),
        "cells_count":         len(result_cells),
        "qnh_hpa":             round(qnh_hpa, 1),
        "qnh_correction_ft":   round(qnh_correction_ft, 0) if fl < TRANSITION_FL else None,
        "period_start":        time.strftime("%Y-%m-%d %H:%M", time.gmtime(start_ts)) + " UTC",
        "period_end":          time.strftime("%Y-%m-%d %H:%M", time.gmtime(end_ts))   + " UTC",
        "generated_at":        time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())      + " UTC",
    }
