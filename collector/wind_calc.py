"""
Wind vector calculation from BDS 5,0 (Track and Turn) + BDS 6,0 (Heading and Speed).

Theory
------
An aircraft's ground velocity vector is the sum of its air velocity vector
and the ambient wind vector:

    V_ground = V_air + V_wind
    ∴  V_wind = V_ground − V_air

Both vectors are in Earth-fixed North/East coordinates.

Inputs required
---------------
From BDS 5,0 (Track and Turn Report):
    true_track      — direction of ground motion, degrees true
    groundspeed     — magnitude of ground velocity, kt
    true_airspeed   — magnitude of air velocity, kt  (optional; prefer over Mach-derived)
    roll            — bank angle, degrees (used for quality gate)
    track_rate      — turn rate, °/s    (used for quality gate)

From BDS 6,0 (Heading and Speed Report):
    magnetic_heading — direction the nose points, degrees magnetic
    mach             — airspeed as Mach number (used when true_airspeed absent)
    indicated_airspeed — kt IAS (fallback for TAS when Mach unavailable)

Magnetic declination must be added to magnetic_heading to get true heading.

ISA atmosphere model
--------------------
Used to convert Mach → True Airspeed when BDS 5,0 TAS is unavailable.
    T_isa(h) = 288.15 − 0.0065 * h      (h in metres, troposphere)
    T_isa(h) = 216.65                    (above ~11 km / FL360)
    a(T) = 340.294 * sqrt(T / 288.15)   m/s  (speed of sound)
    TAS  = Mach * a(T)
"""

import math
import logging
from typing import Optional

log = logging.getLogger("modes.wind")

# ── ISA atmosphere ────────────────────────────────────────────────────────

_TROPOPAUSE_M = 11_000.0        # metres
_T_SEA_LEVEL  = 288.15          # K
_LAPSE        = 0.0065           # K/m
_T_TROPO      = 216.65           # K  (above tropopause, isothermal)
_A_SEA_LEVEL  = 340.294          # m/s  speed of sound at sea level ISA


def _ft_to_m(ft: float) -> float:
    return ft * 0.3048


def isa_temperature_k(altitude_ft: float) -> float:
    """ISA static air temperature in Kelvin at pressure altitude (ft)."""
    h = _ft_to_m(altitude_ft)
    if h <= _TROPOPAUSE_M:
        return _T_SEA_LEVEL - _LAPSE * h
    return _T_TROPO


def mach_to_tas_kt(mach: float, altitude_ft: float) -> float:
    """Convert Mach number + pressure altitude (ft) → true airspeed (kt)."""
    T = isa_temperature_k(altitude_ft)
    a_ms = _A_SEA_LEVEL * math.sqrt(T / _T_SEA_LEVEL)   # m/s
    tas_ms = mach * a_ms
    return tas_ms / 0.5144                               # kt


# ── Wind vector computation ───────────────────────────────────────────────

def compute_wind(
    true_track: float,
    groundspeed: float,
    true_heading: float,
    true_airspeed: float,
) -> tuple[float, float]:
    """
    Compute wind speed (kt) and meteorological wind direction (degrees FROM).

    Args:
        true_track    : direction of ground motion, degrees true (0–360)
        groundspeed   : kt
        true_heading  : direction the nose points, degrees true (0–360)
        true_airspeed : kt

    Returns:
        (wind_speed_kt, wind_dir_from_deg)
        wind_dir_from_deg follows meteorological convention:
        e.g. 270° means wind coming FROM the west.
    """
    tt_rad  = math.radians(true_track)
    th_rad  = math.radians(true_heading)

    # Ground velocity components (north, east)
    gs_n = groundspeed   * math.cos(tt_rad)
    gs_e = groundspeed   * math.sin(tt_rad)

    # Air velocity components (north, east)
    tas_n = true_airspeed * math.cos(th_rad)
    tas_e = true_airspeed * math.sin(th_rad)

    # Wind vector (the direction the air mass is MOVING TOWARD)
    w_n = gs_n - tas_n
    w_e = gs_e - tas_e

    wind_speed = math.sqrt(w_n**2 + w_e**2)

    # Convert to meteorological FROM direction (opposite of motion direction)
    wind_dir_to  = math.degrees(math.atan2(w_e, w_n)) % 360.0
    wind_dir_from = (wind_dir_to + 180.0) % 360.0

    return wind_speed, wind_dir_from


def quality_score(
    roll_deg: Optional[float],
    track_rate_dps: Optional[float],
    tas_kt: float,
    gs_kt: float,
) -> float:
    """
    Return a quality score in [0, 1] for a computed wind observation.

    Factors:
      - Roll angle: should be near zero for straight flight
      - Track rate: should be near zero
      - TAS/GS ratio: physically plausible aircraft motion
    A score ≥ 0.5 is considered usable; ≥ 0.8 is good.
    """
    score = 1.0

    # Penalise bank angle
    if roll_deg is not None:
        roll_abs = abs(roll_deg)
        if roll_abs > 5.0:
            score -= min(0.5, (roll_abs - 5.0) / 30.0)

    # Penalise turning rate
    if track_rate_dps is not None:
        rate_abs = abs(track_rate_dps)
        if rate_abs > 1.0:
            score -= min(0.4, (rate_abs - 1.0) / 5.0)

    # Penalise implausible TAS/GS ratio
    if gs_kt > 0:
        ratio = tas_kt / gs_kt
        if ratio < 0.5 or ratio > 2.0:
            score -= 0.3

    return max(0.0, score)


def try_compute_wind(
    bds50: dict,
    bds60: dict,
    altitude_ft: Optional[float],
    mag_declination: float,
    max_roll: float,
    max_track_rate: float,
    max_wind_kt: float,
) -> Optional[dict]:
    """
    Attempt wind calculation given BDS 5,0 and 6,0 decoded dicts.

    Returns a dict with keys:
        wind_spd, wind_dir, wind_qual,
        bds50_true_track, bds50_groundspeed, bds50_true_airspeed, bds50_roll,
        bds60_mag_heading, bds60_ias, bds60_mach
    or None if inputs are insufficient or quality gate fails.
    """
    # Need at minimum: true_track, groundspeed from BDS 5,0
    #                  magnetic_heading from BDS 6,0
    true_track  = bds50.get("true_track")
    groundspeed = bds50.get("groundspeed")
    mag_heading = bds60.get("magnetic_heading")

    if true_track is None or groundspeed is None or mag_heading is None:
        return None

    roll        = bds50.get("roll")           # may be None
    track_rate  = bds50.get("track_rate")     # may be None
    tas_bds50   = bds50.get("true_airspeed")  # may be None

    mach        = bds60.get("mach")
    ias         = bds60.get("indicated_airspeed")

    # Hard quality gates before computing
    if roll is not None and abs(roll) > max_roll:
        log.debug("Wind calc skipped: roll=%.1f° > max %.1f°", roll, max_roll)
        return None
    if track_rate is not None and abs(track_rate) > max_track_rate:
        log.debug("Wind calc skipped: track_rate=%.2f°/s > max %.2f°/s",
                  track_rate, max_track_rate)
        return None

    # Resolve TAS (preference order: BDS5,0 → Mach → IAS as rough proxy)
    tas: Optional[float] = None
    if tas_bds50 is not None:
        tas = float(tas_bds50)
    elif mach is not None and altitude_ft is not None:
        tas = mach_to_tas_kt(mach, altitude_ft)
    elif ias is not None:
        # IAS ≈ TAS only at low altitude; use with caution
        tas = float(ias)

    if tas is None or tas < 50.0:   # reject obviously wrong TAS
        return None

    true_heading = (mag_heading + mag_declination) % 360.0

    wind_spd, wind_dir = compute_wind(
        float(true_track), float(groundspeed), true_heading, tas
    )

    if wind_spd > max_wind_kt:
        log.debug("Wind calc skipped: computed wind %.0f kt exceeds max %.0f kt",
                  wind_spd, max_wind_kt)
        return None

    qual = quality_score(roll, track_rate, tas, float(groundspeed))

    return {
        "wind_spd":              round(wind_spd, 1),
        "wind_dir":              round(wind_dir, 1),
        "wind_qual":             round(qual, 3),
        "bds50_true_track":      true_track,
        "bds50_groundspeed":     groundspeed,
        "bds50_true_airspeed":   tas_bds50,
        "bds50_roll":            roll,
        "bds60_mag_heading":     mag_heading,
        "bds60_ias":             ias,
        "bds60_mach":            mach,
    }
