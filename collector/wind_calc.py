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
    indicated_airspeed — kt IAS (last-resort TAS source, converted properly)

Magnetic declination must be added to magnetic_heading to get true heading;
the caller supplies the value at the aircraft's position (collector/declination.py).

True airspeed sources (in order)
--------------------------------
  1. BDS50 — TAS field of BDS 5,0 (normal case; 2 kt resolution).
  2. MACH  — TAS = Mach × a(T).  The static air temperature T is the ISA
             temperature at the pressure altitude plus the current ISA
             deviation, estimated area-wide per altitude band from recent
             aircraft that report BOTH BDS 5,0 TAS and BDS 6,0 Mach
             (T = (TAS / Mach)² / (γ·R) — the aircraft's own air-data
             computer measurement).  Falls back to plain ISA when no recent
             samples exist.  A 10 °C ISA deviation is ~2 % TAS (~9 kt at cruise).
  3. IAS   — IAS ≈ CAS converted to TAS with the compressible-flow relations
             at the ISA pressure for the altitude and the same temperature.
             (Previously IAS was used directly as TAS, which at FL350 is
             ~200 kt too low.)  Requires a known altitude.
If none of these is available, no wind is computed.

ISA atmosphere model
--------------------
    T_isa(h) = 288.15 − 0.0065 * h      (h in metres, troposphere)
    T_isa(h) = 216.65                    (above ~11 km / FL360)
    p_isa(h) = 101325 (T/288.15)^5.25588 (troposphere), exponential above
    a(T) = sqrt(γ R T)                   m/s  (speed of sound)
"""

import math
import logging
import statistics
import threading
from collections import deque
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


_KT_TO_MS    = 0.514444
_GAMMA       = 1.4
_R_AIR       = 287.053          # J/(kg·K)
_P_SEA_LEVEL = 101_325.0        # Pa
_G0          = 9.80665          # m/s²


def isa_pressure_pa(altitude_ft: float) -> float:
    """ISA static pressure (Pa) at pressure altitude (ft)."""
    h = _ft_to_m(altitude_ft)
    if h <= _TROPOPAUSE_M:
        return _P_SEA_LEVEL * (isa_temperature_k(altitude_ft) / _T_SEA_LEVEL) ** 5.25588
    p11 = _P_SEA_LEVEL * (_T_TROPO / _T_SEA_LEVEL) ** 5.25588
    return p11 * math.exp(-_G0 / (_R_AIR * _T_TROPO) * (h - _TROPOPAUSE_M))


def speed_of_sound_ms(temp_k: float) -> float:
    return math.sqrt(_GAMMA * _R_AIR * temp_k)


def mach_to_tas_kt(mach: float, altitude_ft: float, isa_dev_k: float = 0.0) -> float:
    """Mach + pressure altitude (ft) → true airspeed (kt).

    isa_dev_k: static air temperature minus ISA temperature (K); 0 = ISA.
    """
    T = isa_temperature_k(altitude_ft) + isa_dev_k
    return mach * speed_of_sound_ms(T) / _KT_TO_MS


def cas_to_tas_kt(cas_kt: float, altitude_ft: float, isa_dev_k: float = 0.0) -> Optional[float]:
    """Calibrated airspeed (≈ IAS) → true airspeed (kt), compressible flow.

    CAS → impact pressure qc (sea-level ISA) → Mach at the ISA static pressure
    for the altitude → TAS with the (ISA + deviation) temperature.
    Returns None for non-physical results (supersonic / invalid).
    """
    a0 = speed_of_sound_ms(_T_SEA_LEVEL)
    qc = _P_SEA_LEVEL * ((1 + 0.2 * (cas_kt * _KT_TO_MS / a0) ** 2) ** 3.5 - 1)
    p  = isa_pressure_pa(altitude_ft)
    m2 = 5.0 * ((qc / p + 1.0) ** (2.0 / 7.0) - 1.0)
    if m2 <= 0 or m2 >= 1.0:
        return None
    return mach_to_tas_kt(math.sqrt(m2), altitude_ft, isa_dev_k)


# ── Area-wide ISA deviation estimate ──────────────────────────────────────
# Aircraft that report both BDS 5,0 TAS and BDS 6,0 Mach effectively report
# the static air temperature measured by their air-data computer:
#     T = (TAS / Mach)² / (γ·R)
# The deviation from ISA (T − T_isa) is roughly uniform over a region and
# changes slowly, so it is collected per altitude band from all aircraft and
# applied to aircraft that send Mach but no TAS.

ISA_DEV_BAND_FT    = 5_000     # altitude band width
ISA_DEV_MAX_AGE    = 1_800.0   # s — use samples from the last 30 min
ISA_DEV_MIN_SAMPLES = 5        # need at least this many samples in a band
ISA_DEV_MIN_MACH   = 0.40      # Mach resolution (0.004) makes low-Mach samples noisy
ISA_DEV_PER_AC_SEC = 20.0      # at most one sample per aircraft per 20 s
ISA_DEV_LIMIT_K    = 30.0      # sanity limit on |deviation|


class _IsaDeviationEstimator:
    def __init__(self):
        self._lock    = threading.Lock()
        self._bands: dict[int, deque] = {}     # band → deque[(ts, dev_k)]
        self._last_ac: dict[str, float] = {}   # icao → last sample ts

    @staticmethod
    def _band(altitude_ft: float) -> int:
        return int(altitude_ft // ISA_DEV_BAND_FT)

    def add(self, icao: str, altitude_ft: float, tas_kt: float, mach: float, ts: float) -> None:
        if mach < ISA_DEV_MIN_MACH or tas_kt <= 0:
            return
        with self._lock:
            if ts - self._last_ac.get(icao, 0.0) < ISA_DEV_PER_AC_SEC:
                return
            self._last_ac[icao] = ts
            if len(self._last_ac) > 5_000:   # bound memory
                cutoff = ts - ISA_DEV_MAX_AGE
                self._last_ac = {k: v for k, v in self._last_ac.items() if v > cutoff}
            t_meas = (tas_kt * _KT_TO_MS / mach) ** 2 / (_GAMMA * _R_AIR)
            dev = t_meas - isa_temperature_k(altitude_ft)
            if abs(dev) > ISA_DEV_LIMIT_K:
                return
            self._bands.setdefault(self._band(altitude_ft), deque(maxlen=300)).append((ts, dev))

    def get(self, altitude_ft: float, ts: float) -> Optional[float]:
        """Median ISA deviation (K) for the altitude band, or None if too few samples."""
        cutoff = ts - ISA_DEV_MAX_AGE
        with self._lock:
            b = self._band(altitude_ft)
            for band in (b, b - 1, b + 1):          # own band first, then neighbours
                vals = [d for t, d in self._bands.get(band, ()) if t >= cutoff]
                if len(vals) >= ISA_DEV_MIN_SAMPLES:
                    return statistics.median(vals)
        return None


isa_deviation = _IsaDeviationEstimator()


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
    icao: str = "",
    ts: float = 0.0,
) -> Optional[dict]:
    """
    Attempt wind calculation given BDS 5,0 and 6,0 decoded dicts.

    Returns a dict with keys:
        wind_spd, wind_dir, wind_qual, tas_source, mag_decl,
        bds50_true_track, bds50_groundspeed, bds50_true_airspeed, bds50_roll,
        bds60_mag_heading, bds60_ias, bds60_mach
    or None if inputs are insufficient or quality gate fails.
    mag_declination is the declination at the aircraft's position (°E).
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

    # Feed the area-wide ISA-deviation estimate whenever both TAS and Mach
    # are reported (independent of whether this pair passes the gates below).
    if tas_bds50 is not None and mach and altitude_ft is not None and icao:
        isa_deviation.add(icao, altitude_ft, float(tas_bds50), float(mach), ts)

    # Resolve TAS (preference order: BDS5,0 → Mach → IAS, see module docstring)
    tas: Optional[float] = None
    tas_source: Optional[str] = None
    if tas_bds50 is not None:
        tas, tas_source = float(tas_bds50), "BDS50"
    elif altitude_ft is not None and (mach is not None or ias is not None):
        dev = isa_deviation.get(altitude_ft, ts) or 0.0
        if mach is not None:
            tas, tas_source = mach_to_tas_kt(mach, altitude_ft, dev), "MACH"
        else:
            tas, tas_source = cas_to_tas_kt(float(ias), altitude_ft, dev), "IAS"
    # No altitude and no BDS 5,0 TAS → TAS cannot be determined → no wind

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
        "tas_source":            tas_source,
        "mag_decl":              round(mag_declination, 2),
        "bds50_true_track":      true_track,
        "bds50_groundspeed":     groundspeed,
        "bds50_true_airspeed":   tas_bds50,
        "bds50_roll":            roll,
        "bds60_mag_heading":     mag_heading,
        "bds60_ias":             ias,
        "bds60_mach":            mach,
    }
