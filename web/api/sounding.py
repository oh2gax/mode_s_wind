"""
Sounding data aggregation.

Area sounding (last SOUNDING_WINDOW_MIN minutes within SOUNDING_RADIUS_KM
of the receiver), hourly archive soundings (profile_hours) and per-flight
soundings, all in the altitude layers of collector/atmos.py with the
Mach/TAS temperature.

The result is a list of pressure-level dicts suitable for Skew-T rendering.
"""

import math
import sqlite3
import time
import logging
from typing import Optional

from config import Config
from collector.atmos import (TEMP_SQL, aggregate_layers, area_profile,
                             isa_pressure_hpa, unpack_levels)

log = logging.getLogger("modes.sounding")

def build_sounding(cfg: Config, db: sqlite3.Connection,
                   minutes: Optional[int] = None) -> dict:
    """
    Area sounding: all aircraft within SOUNDING_RADIUS_KM of the receiver over
    the last `minutes` (default SOUNDING_WINDOW_MIN), in altitude layers
    (1 000 ft to 10 000 ft, 2 000 ft above — collector/atmos.py).

    Temperature is the Mach/TAS temperature (median per layer; MRAR / MHR
    only where present); pressure is the ISA pressure of the pressure
    altitude.  (Until 2026-10-09 observations were binned by their reported
    pressure, which only the rare MRAR / MHR replies carry, so this view was
    almost always empty.)

    Returns {"mode": "area", "window_min", "radius_km", "obs_used",
             "generated_at", "levels"} — levels surface first.
    """
    import datetime
    now = time.time()
    minutes = int(minutes or cfg.SOUNDING_WINDOW_MIN)
    minutes = max(10, min(minutes, 360))
    levels, used = area_profile(db, now - minutes * 60, now,
                                cfg.RECEIVER_LAT, cfg.RECEIVER_LON,
                                cfg.SOUNDING_RADIUS_KM)
    return {
        "mode":         "area",
        "window_min":   minutes,
        "radius_km":    cfg.SOUNDING_RADIUS_KM,
        "obs_used":     used,
        "generated_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "levels":       levels,
    }


def build_hour_sounding(db: sqlite3.Connection, hour_ts: int) -> dict:
    """Area sounding of one completed UTC hour from the profile_hours archive
    (kept after the observations are purged)."""
    import datetime, json
    row = db.execute("SELECT ts, data FROM profile_hours WHERE ts = ?",
                     (int(hour_ts),)).fetchone()
    if not row:
        return {"error": "no profile stored for this hour"}
    d = json.loads(row["data"])
    return {
        "mode":         "hour",
        "hour_ts":      row["ts"],
        "radius_km":    d.get("r"),
        "obs_used":     d.get("n", 0),
        "generated_at": datetime.datetime.utcfromtimestamp(row["ts"]).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "levels":       unpack_levels(d.get("lv")),
    }


def list_profile_hours(db: sqlite3.Connection, date: str) -> list:
    """Hours (ts, observations) stored in profile_hours for a UTC date."""
    import calendar
    y, m, d = (int(x) for x in date.split("-"))
    t0 = calendar.timegm((y, m, d, 0, 0, 0))
    rows = db.execute(
        "SELECT ts, json_extract(data, '$.n') AS n FROM profile_hours "
        "WHERE ts >= ? AND ts < ? ORDER BY ts", (t0, t0 + 86400)).fetchall()
    return [{"ts": r["ts"], "n": r["n"]} for r in rows]


# ── ISA helper ────────────────────────────────────────────────────────────────

def _isa_pressure_hpa(alt_ft: float) -> float:
    """Convert altitude (ft) to pressure (hPa) using the ISA standard atmosphere."""
    return isa_pressure_hpa(alt_ft)


# ── Per-flight sounding ───────────────────────────────────────────────────────

def build_flight_sounding(flight_id: int, db: sqlite3.Connection) -> dict:
    """
    Build a Skew-T sounding profile from a single flight's observations.

    Observations are binned into altitude layers (1 000 ft to 10 000 ft,
    2 000 ft above).  Each layer becomes one Skew-T level at the ISA pressure
    of its pressure altitude.  Temperature is the median Mach/TAS temperature
    (collector/atmos.py); wind components are averaged as U/V vectors.

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
        f"""SELECT altitude, best_wind_spd, best_wind_dir,
                   {TEMP_SQL} AS temp
            FROM observations
            WHERE flight_id = ?
              AND altitude IS NOT NULL
              AND meteo_source != 'NONE'
            ORDER BY altitude ASC""",
        (flight_id,),
    ).fetchall()

    # Same layers as the area sounding (1 000 ft to 10 000 ft, then 2 000 ft);
    # temperature = Mach/TAS temperature (median), pressure = ISA pressure
    # of the pressure altitude
    levels = aggregate_layers([(r["altitude"], r["temp"], r["best_wind_spd"],
                                r["best_wind_dir"]) for r in rows])
    obs_used = len(rows)
    for lv in levels:
        lv.setdefault("temp_count", 0)
        lv.setdefault("wind_count", 0)

    # Sort high pressure → low pressure (surface → top) for Skew-T
    levels.sort(key=lambda lv: lv["pressure"], reverse=True)

    return {
        "flight":       flight,
        "obs_used":     obs_used,
        "generated_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "levels":       levels,
        "mode":         "flight",
    }
