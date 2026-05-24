"""
Sounding data aggregation.

Queries the last SOUNDING_WINDOW_MIN minutes of observations within
SOUNDING_RADIUS_KM of the receiver, then bins them into standard pressure
levels and computes mean wind + temperature per level.

The result is a list of pressure-level dicts suitable for Skew-T rendering.
"""

import math
import sqlite3
import time
import logging
from typing import Optional

from config import Config

log = logging.getLogger("modes.sounding")

# Standard pressure levels used as bin centres (hPa)
# Chosen to match typical radiosonde reporting levels
PRESSURE_BINS = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100]
BIN_HALF_WIDTH = 25   # ± hPa around each bin centre


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _mean_wind(u_vals: list[float], v_vals: list[float]) -> tuple[float, float]:
    """Mean wind speed and direction from lists of U and V components."""
    if not u_vals:
        return 0.0, 0.0
    u_mean = sum(u_vals) / len(u_vals)
    v_mean = sum(v_vals) / len(v_vals)
    spd = math.sqrt(u_mean ** 2 + v_mean ** 2)
    # direction FROM (meteorological)
    direction = (math.degrees(math.atan2(-u_mean, -v_mean)) + 360) % 360
    return round(spd, 1), round(direction, 1)


def build_sounding(cfg: Config, db: sqlite3.Connection) -> dict:
    """
    Return sounding data aggregated from recent observations near the receiver.

    Returns a dict with:
        "window_min"   : minutes aggregated
        "radius_km"    : search radius used
        "obs_used"     : total raw observations included
        "generated_at" : ISO timestamp
        "levels"       : list of pressure-level dicts
    """
    now      = time.time()
    cutoff   = now - cfg.SOUNDING_WINDOW_MIN * 60

    rows = db.execute(
        """SELECT lat, lon, best_temp, best_pressure,
                  best_wind_spd, best_wind_dir, altitude
           FROM observations
           WHERE ts > ?
             AND meteo_source != 'NONE'
             AND lat IS NOT NULL
             AND lon IS NOT NULL
           ORDER BY ts DESC""",
        (cutoff,),
    ).fetchall()

    # Filter by distance from receiver
    in_range = []
    for r in rows:
        try:
            d = _haversine_km(cfg.RECEIVER_LAT, cfg.RECEIVER_LON,
                              r["lat"], r["lon"])
            if d <= cfg.SOUNDING_RADIUS_KM:
                in_range.append(dict(r))
        except Exception:
            continue

    # Bin observations by pressure level
    # For each bin: collect temps and wind vectors (U, V components)
    bins: dict[int, dict] = {
        p: {"temps": [], "u": [], "v": [], "alts": []}
        for p in PRESSURE_BINS
    }

    obs_used = 0
    for r in in_range:
        pressure = r.get("best_pressure")
        temp     = r.get("best_temp")
        wind_spd = r.get("best_wind_spd")
        wind_dir = r.get("best_wind_dir")

        if pressure is None:
            continue

        # Find best matching pressure bin
        best_bin = None
        best_dist = 9999
        for p in PRESSURE_BINS:
            d = abs(pressure - p)
            if d < best_dist and d <= BIN_HALF_WIDTH:
                best_dist = d
                best_bin = p

        if best_bin is None:
            continue

        obs_used += 1
        b = bins[best_bin]

        if temp is not None:
            b["temps"].append(temp)

        if wind_spd is not None and wind_dir is not None:
            # Convert to U (eastward) / V (northward) components
            wd_rad = math.radians(wind_dir)
            u = -wind_spd * math.sin(wd_rad)   # U: positive = eastward
            v = -wind_spd * math.cos(wd_rad)   # V: positive = northward
            b["u"].append(u)
            b["v"].append(v)

        if r.get("altitude") is not None:
            b["alts"].append(r["altitude"])

    # Build output levels
    levels = []
    for p in PRESSURE_BINS:
        b = bins[p]
        level: dict = {"pressure": p}

        if b["temps"]:
            level["temp"]      = round(sum(b["temps"]) / len(b["temps"]), 1)
            level["temp_count"] = len(b["temps"])

        if b["u"]:
            spd, direction = _mean_wind(b["u"], b["v"])
            level["wind_spd"] = spd
            level["wind_dir"] = direction
            level["wind_count"] = len(b["u"])

        if b["alts"]:
            level["altitude"] = int(sum(b["alts"]) / len(b["alts"]))

        levels.append(level)

    import datetime
    return {
        "window_min":   cfg.SOUNDING_WINDOW_MIN,
        "radius_km":    cfg.SOUNDING_RADIUS_KM,
        "obs_used":     obs_used,
        "generated_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "levels":       levels,
    }


# ── ISA helper ────────────────────────────────────────────────────────────────

def _isa_pressure_hpa(alt_ft: float) -> float:
    """Convert altitude (ft) to pressure (hPa) using the ISA standard atmosphere."""
    alt_m = alt_ft * 0.3048
    if alt_m <= 11_000:
        # Troposphere: T lapse rate 6.5 K/km
        return 1013.25 * (1.0 - 0.0065 * alt_m / 288.15) ** 5.2561
    else:
        # Lower stratosphere: isothermal at 216.65 K
        return 226.32 * math.exp(-0.0001577 * (alt_m - 11_000))


# ── Per-flight sounding ───────────────────────────────────────────────────────

def build_flight_sounding(flight_id: int, db: sqlite3.Connection) -> dict:
    """
    Build a Skew-T sounding profile from a single flight's observations.

    Observations are binned into 2 000 ft altitude bands.  Each band
    becomes one Skew-T level.  Pressure is taken from measured MRAR
    values when available, otherwise estimated via ISA.  Wind components
    are averaged as U/V vectors before converting back to speed/direction.

    Works best for climbing / descending flights (departures and arrivals)
    where the aircraft samples multiple altitude layers.  For level cruise
    flights only a single or very few levels will be populated.

    Returns the same dict shape as build_sounding() so the same
    renderSounding() JS function can display it.
    """
    import datetime

    flight_row = db.execute(
        """SELECT id, icao, callsign,
                  datetime(first_seen, 'unixepoch') AS first_seen,
                  datetime(last_seen,  'unixepoch') AS last_seen,
                  max_altitude, min_altitude, obs_count, meteo_count
           FROM flights WHERE id = ?""",
        (flight_id,),
    ).fetchone()
    if not flight_row:
        return {"error": "flight not found"}

    flight = dict(flight_row)

    rows = db.execute(
        """SELECT altitude, best_temp, best_wind_spd, best_wind_dir,
                  best_pressure, meteo_source
           FROM observations
           WHERE flight_id = ?
             AND altitude IS NOT NULL
             AND meteo_source != 'NONE'
           ORDER BY altitude ASC""",
        (flight_id,),
    ).fetchall()

    BAND_FT = 2_000   # altitude bin width in feet

    # band_ft → {temps, u_vals, v_vals, pressures}
    bands: dict[int, dict] = {}

    obs_used = 0
    for r in rows:
        alt   = r["altitude"]
        band  = round(alt / BAND_FT) * BAND_FT

        if band not in bands:
            bands[band] = {"temps": [], "u": [], "v": [], "pressures": []}

        b = bands[band]
        obs_used += 1

        if r["best_temp"] is not None:
            b["temps"].append(r["best_temp"])

        if r["best_wind_spd"] is not None and r["best_wind_dir"] is not None:
            rad = math.radians(r["best_wind_dir"])
            b["u"].append(-r["best_wind_spd"] * math.sin(rad))
            b["v"].append(-r["best_wind_spd"] * math.cos(rad))

        if r["best_pressure"] is not None:
            b["pressures"].append(r["best_pressure"])

    def _safe(v):
        """Return None for non-finite floats (nan/inf) so JSON stays valid."""
        if v is None:
            return None
        try:
            return None if not math.isfinite(v) else v
        except (TypeError, ValueError):
            return None

    levels = []
    for alt_ft in sorted(bands.keys()):
        b = bands[alt_ft]

        # Pressure: prefer measured average, fall back to ISA
        if b["pressures"]:
            pressure = round(sum(b["pressures"]) / len(b["pressures"]), 1)
        else:
            pressure = round(_isa_pressure_hpa(alt_ft), 1)

        temp = wind_spd = wind_dir = None
        temp_count = wind_count = 0

        if b["temps"]:
            temp       = _safe(round(sum(b["temps"]) / len(b["temps"]), 1))
            temp_count = len(b["temps"])

        if b["u"]:
            u_mean   = sum(b["u"]) / len(b["u"])
            v_mean   = sum(b["v"]) / len(b["v"])
            wind_spd = _safe(round(math.sqrt(u_mean ** 2 + v_mean ** 2), 1))
            wind_dir = _safe(round((math.degrees(math.atan2(-u_mean, -v_mean)) + 360) % 360, 1))
            wind_count = len(b["u"])

        levels.append({
            "pressure":   _safe(pressure),
            "altitude":   alt_ft,
            "temp":       temp,
            "wind_spd":   wind_spd,
            "wind_dir":   wind_dir,
            "temp_count": temp_count,
            "wind_count": wind_count,
        })

    # Sort high pressure → low pressure (surface → top) for Skew-T
    levels.sort(key=lambda lv: lv["pressure"], reverse=True)

    return {
        "flight":       flight,
        "obs_used":     obs_used,
        "generated_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "levels":       levels,
        "mode":         "flight",
    }
