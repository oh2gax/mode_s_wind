"""
collector/windshear.py

High-resolution in-RAM approach tracker for the Windshear monitoring page.
No database writes — all data lives in memory only.

For each aircraft within WINDSHEAR_RADIUS_NM of the configured airport and
below WINDSHEAR_MAX_ALT_FT, this module:

  • Identifies which ILS runway the aircraft is established on using a
    geometric corridor check against each runway's extended centreline.
    The corridor is defined by:
      – Cross-track offset ≤ CORRIDOR_HALF_WIDTH_NM (default 2.5 NM)
        (signed: positive = right of centreline, negative = left)
      – Along-track distance from threshold: 0 … MAX_ILS_NM (default 25 NM)
        (positive = approaching; negative = departed / past threshold)
    This naturally excludes departures, go-arounds, taxiing traffic, and
    aircraft overflying the area without being on approach.

  • Aircraft within the outer distance + altitude gates but outside any ILS
    corridor are still tracked (in_corridor=False) so they can be shown or
    hidden via the JS map toggle.

  • Stores a rolling 10-minute position history for the ILS vertical profile
    display (glideslope graph in the web UI).

  • Exposes get_state() to the Flask web layer via a thread-safe RLock.

EFHK runway thresholds
-----------------------
Threshold coordinates sourced from FINTRAFFIC ANS EFHK ADC (AD 2.4-1,
16 APR 2026).  Threshold elevations from the same chart.

  RWY 04L — threshold [lat 60.3129, lon 24.9039]  approach hdg  047°  elev 179 ft
  RWY 04R — threshold [lat 60.3113, lon 24.9364]  approach hdg  047°  elev 179 ft
  RWY 22L — threshold [lat 60.3307, lon 24.9791]  approach hdg  227°  elev 179 ft
  RWY 22R — threshold [lat 60.3311, lon 24.9439]  approach hdg  227°  elev 179 ft
  RWY 15  — threshold [lat 60.3303, lon 24.9645]  approach hdg  152°  elev 179 ft
  RWY 33  — threshold [lat 60.3071, lon 24.9883]  approach hdg  323°  elev 148 ft

RWY 33 uses an RNP approach (no ILS) with a standard 3.00° vertical path
angle — identical glideslope geometry to the ILS runways; no special
handling required.  Its lower threshold elevation (148 ft vs ~179 ft for
the other runways) is stored per-runway so the glideslope reference line
is correctly anchored for each runway independently.

Glideslope reference
---------------------
Standard 3° ILS glideslope: altitude (ft) = distance_from_threshold (NM)
× 318.5 ft/NM  (= tan(3°) × 6 076 ft/NM)

An aircraft is considered "on glideslope" when its altitude is within
±300 ft of this reference.
"""

import json
import math
import zlib
import re
import threading
import time
import logging

from collector.filter import is_blocked_registration
from collector.atmos import tm_temp_c, trimmed_mean
from collector.wind_calc import compute_wind

log = logging.getLogger("modes.windshear")

# ── Physical constants ────────────────────────────────────────────────────────
EARTH_RADIUS_NM    = 3_440.065      # nautical miles
GS_FT_PER_NM       = 318.5         # tan(3°) × 6 076 — 3° glideslope
GS_TOLERANCE_FT    = 300.0         # ±ft to consider "on glideslope"

# ── Tracker parameters ────────────────────────────────────────────────────────
ILS_CORRIDOR_HALF_WIDTH_NM = 2.5   # default ±NM from centreline (configurable)
ILS_MAX_RANGE_NM           = 25.0  # default max along-track distance from thr
MAX_HISTORY_SEC            = 600.0 # retain 10 min of position history
STALE_TIMEOUT_SEC          = 30.0  # drop aircraft silent for 30 s
CORRIDOR_MAX_TRACK_DEV_DEG = 60.0  # default max track deviation from approach hdg
CORRIDOR_GS_FLOOR_FT      = 1000.0 # reject corridor match when aircraft is more than
                                    # this many ft below the theoretical 3° glidepath;
                                    # filters overflying traffic vectored to other runways

# ── Go-around detection defaults ──────────────────────────────────────────────
GA_MIN_DESCENT_POLLS = 5       # sweeps descending before 'APPROACHING' is set
GA_MIN_CLIMB_POLLS   = 3       # consecutive sweeps climbing before GO-AROUND fires
GA_MIN_ALT_GAIN_FT   = 50.0   # minimum actual altitude gain (ft) required to confirm
GA_CLIMB_FPM         = 600.0   # ft/min climb rate that triggers detection
GA_MAX_ALT_FT        = 2_200.0 # altitude ceiling for detection
GA_FLASH_SEC         = 60.0    # seconds to keep the GO-AROUND flag active
GA_EVENTS_MAX        = 20      # maximum go-around events retained in RAM
GA_COUNT_EXPIRY_SEC  = 7_200.0 # forget a go-around count 2 h after the go-around if
                               # the aircraft never came back to land (e.g. diverted),
                               # so its next visit is not shown as a "2nd APP"

# ── Approach history ─────────────────────────────────────────────────────────
APPROACH_HISTORY_MAX   = 500          # RAM cap — covers ~24 h at typical EFHK load
COMMIT_COOLDOWN_SEC    = 300          # suppress duplicate commits for same ICAO within 5 min
APPROACH_HISTORY_BANDS = (
    200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800,
    2000, 2200, 2400, 2600, 2800, 3000,
)                                     # 15 bands at 200 ft resolution, ft MSL
BAND_TOL_FT            = 100          # ±ft window for band wind capture

# GNSS quality per approach band (stored as gnss_json, from 2026-10-06).
# Captured on every in-corridor sweep before the threshold, independent of
# wind availability and of the position-freeze gate (which it records).
# A sweep counts as "degraded" for the first-degraded / recovery summary when
# NACp or NIC ≤ the thresholds below (fresh values only), our own ADS-B
# position is older than GNSS_POS_AGE_DEG_SEC while the aircraft is still
# transmitting extended squitters, or the position-freeze gate fired.
GNSS_NACP_DEG          = 6            # NACp ≤ this = degraded (as GPS_NACP_THRESHOLD)
GNSS_NIC_DEG           = 6            # NIC ≤ this = degraded (as GPS_NIC_THRESHOLD)
GNSS_FRESH_SEC         = 30.0         # NACp / NIC values older than this are ignored
GNSS_POS_AGE_DEG_SEC   = 10.0         # own ADS-B position older than this = degraded
GNSS_ES_ACTIVE_SEC     = 30.0         # aircraft counts as ADS-B-active if any ES within this

# Approach roughness (stored as rough_json, from 2026-10-06).
# Every raw BDS 5,0 / 6,0 reply received while the aircraft is established on
# final (in corridor, |cross-track| ≤ ROUGH_MAX_XTRACK_NM, track within
# ROUGH_MAX_TRACK_DEV of the runway heading, not in a go-around, before the
# threshold) is collected per altitude segment — including the replies the
# wind quality gates reject — and summarised at commit: bank-angle and
# track-rate activity, IAS fluctuation about its deceleration trend, vertical
# rate fluctuation and crab angle (heading − track).  Plus the METAR wind /
# gust at landing time.  Collect-only; no display yet.
ROUGH_SEGMENTS       = (("hi", 1000.0, 3000.0),   # (name, low, high) ft MSL; low exclusive for "hi"
                        ("lo",  200.0, 1000.0))
ROUGH_MAX_XTRACK_NM  = 1.0     # established on the localizer
ROUGH_MAX_TRACK_DEV  = 20.0    # ° track vs runway heading
ROUGH_MAX_SAMPLES    = 400     # per list per segment (≈ 7 min at 1 reply/s)
ROUGH_ROLL_GATE      = 5.0     # counted like WIND_MAX_ROLL_DEG (wind calc rejects above)
ROUGH_TRK_RATE_GATE  = 1.0     # counted like WIND_MAX_TRACK_RATE
ROUGH_METAR_MAX_AGE  = 7_200.0 # s — METAR older than this (not refreshed) is not stored
ROUGH_HP_HALF_WIN    = 7.5     # s — half-width of the moving median removed by the
                               # "high-pass" statistics (rhp / ihp / vhp): slow changes
                               # (intercept turn, glideslope capture, flap-speed steps)
                               # are removed, gust response of a few seconds remains
ROUGH_HP_MIN_N       = 8       # samples needed for a high-pass statistic
# Approach profile / series / autopilot (from 2026-10-09)
PROF_PAIR_SEC        = 2.0     # BDS 5,0 and 6,0 replies paired within this for wind / temperature
PROF_MAX_ROLL        = 5.0     # ° — no wind pair above this bank (as WIND_MAX_ROLL_DEG)
AP_FRESH_SEC         = 10.0    # TC 29 autopilot state older than this is ignored
SERIES_MAX_ROWS      = 900     # per list per landing (≈ 15 min at 1 reply/s)

# Position-freeze gate — protects band capture and windrose from GPS-frozen
# positions where altitude keeps falling but lat/lon is stuck (GPS jamming).
# On a 3° glideslope, BAND_TOL_FT of altitude drop ≙ ~0.31 NM forward
# movement; 0.05 NM is well below this, so the gate only fires when there
# is genuinely zero position change over a meaningful altitude descent.
POS_FREEZE_MIN_NM      = 0.05         # NM; minimum dist change per BAND_TOL_FT altitude drop

# ── Threshold-pass landing detection ─────────────────────────────────────────
# Normally a landing is committed when an APPROACHING aircraft goes silent
# inside the corridor (receiver loses it at a few hundred ft).  When the
# receiver keeps tracking the aircraft past the threshold (touchdown/rollout),
# it leaves the corridor and the phase resets — without this gate the landing
# would never be recorded.
LANDING_THR_PASS_NM    = 0.2          # NM; along-track ≤ this (i.e. at/past threshold) = crossed
LANDING_CONFIRM_SEC    = 20.0         # s without climbing after threshold → commit landing
LANDING_CANCEL_CLIMB_FT = 200.0       # ft climbed above threshold-crossing alt → missed approach

# ── QNH correction ───────────────────────────────────────────────────────────
# Transponders report pressure altitude (1013.25 hPa).  Pressure altitude ≈
# MSL altitude + (1013.25 − QNH) × QNH_FT_PER_HPA.  Same factor as the JS ILS
# profile (windshear.js) so server and browser agree.
QNH_FT_PER_HPA         = 27.0

# ── Windrose low-altitude observation buffer ──────────────────────────────────
# Per-aircraft rolling buffer that mirrors the JS Lo-buffer gate exactly
# (same 400 ft / 0.5 NM min-gap thresholds) so that observations harvested
# here match what the browser would accumulate client-side.  Observations are
# collected in sweep() whenever the aircraft is in the corridor, below
# WINDROSE_OBS_MAX_ALT_FT, with valid (non-NONE) wind.  On landing the list is
# flushed to _windrose_buffer with timestamps so a fresh browser session can
# pre-populate recentLandingWinds instead of starting cold.
WINDROSE_OBS_MAX_ALT_FT  = 2_000.0   # ft — mirror of JS WINDROSE_ALT_MAX
WINDROSE_MIN_ALT_GAP_FT  = 400.0     # ft — mirror of JS WS_WIND_MIN_ALT_GAP
WINDROSE_MIN_DIST_GAP_NM = 0.5       # NM — mirror of JS WS_WIND_MIN_DIST_GAP
WINDROSE_OBS_CAP         = 40        # per-aircraft obs cap (same as JS Lo buf)
WINDROSE_BUFFER_MAX_SEC  = 6 * 3_600.0  # 6 h — extended for Hist trend view

# ── EFHK runway definitions ──────────────────────────────────────────────────
# Coordinates and threshold elevations from FINTRAFFIC ANS EFHK ADC
# (AD 2.4-1, 16 APR 2026).  thr_elevation_ft is used to anchor the 3°
# glideslope reference correctly for each runway.
EFHK_RUNWAYS = [
    {"name": "04L", "heading":  47, "thr_lat": 60.3129, "thr_lon": 24.9039, "thr_elevation_ft": 179},
    {"name": "04R", "heading":  47, "thr_lat": 60.3113, "thr_lon": 24.9364, "thr_elevation_ft": 179},
    {"name": "22L", "heading": 227, "thr_lat": 60.3307, "thr_lon": 24.9791, "thr_elevation_ft": 179},
    {"name": "22R", "heading": 227, "thr_lat": 60.3311, "thr_lon": 24.9439, "thr_elevation_ft": 179},
    {"name": "15",  "heading": 152, "thr_lat": 60.3303, "thr_lon": 24.9645, "thr_elevation_ft": 179},
    {"name": "33",  "heading": 323, "thr_lat": 60.3071, "thr_lon": 24.9883, "thr_elevation_ft": 148,
     "max_track_dev": 45},  # tighter than default 60° — RNP approach, no localizer;
                            # aircraft vectored to 22L/22R from south fly ~000°-020°
                            # (47°-57° from 323°) and must be excluded
]


# ── Geometry helpers ──────────────────────────────────────────────────────────

def _haversine_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in nautical miles."""
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return 2 * EARTH_RADIUS_NM * math.asin(math.sqrt(min(1.0, a)))


def _bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """True bearing (0–360°) from point 1 to point 2."""
    dlon = math.radians(lon2 - lon1)
    lat1r, lat2r = math.radians(lat1), math.radians(lat2)
    x = math.sin(dlon) * math.cos(lat2r)
    y = math.cos(lat1r) * math.sin(lat2r) - math.sin(lat1r) * math.cos(lat2r) * math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def _hdg_diff(h1: float, h2: float) -> float:
    """Smallest absolute difference between two headings (°), in range 0–180."""
    return abs((h1 - h2 + 540) % 360 - 180)


def _cross_track_nm(
    lat: float, lon: float,
    thr_lat: float, thr_lon: float,
    approach_hdg: float,
) -> float:
    """
    Signed cross-track distance (NM) of (lat, lon) from the extended ILS
    centreline that passes through (thr_lat, thr_lon) with the inbound
    approach bearing `approach_hdg`.

    Sign convention (from pilot's perspective on final approach):
      Positive  → aircraft is to the RIGHT of the centreline
      Negative  → aircraft is to the LEFT of the centreline
    """
    dist = _haversine_nm(thr_lat, thr_lon, lat, lon)
    if dist < 1e-4:
        return 0.0
    brg_from_thr = _bearing(thr_lat, thr_lon, lat, lon)
    # Outbound direction from threshold = opposite of the approach heading
    outbound = (approach_hdg + 180) % 360
    return dist * math.sin(math.radians(brg_from_thr - outbound))


def _along_track_nm(
    lat: float, lon: float,
    thr_lat: float, thr_lon: float,
    approach_hdg: float,
) -> float:
    """
    Along-track distance (NM) from threshold to aircraft, projected onto the
    ILS centreline.

    Positive  → aircraft is outside (approaching, not yet at threshold)
    Negative  → aircraft is past the threshold (departed or rolled through)

    The outbound direction from the threshold is the reciprocal of the approach
    heading (i.e. looking out along the extended approach path).
    """
    dist = _haversine_nm(thr_lat, thr_lon, lat, lon)
    if dist < 1e-4:
        return 0.0
    brg_from_thr = _bearing(thr_lat, thr_lon, lat, lon)
    outbound = (approach_hdg + 180) % 360
    angle = math.radians(((brg_from_thr - outbound) + 180) % 360 - 180)
    return dist * math.cos(angle)


def _headwind_kt(
    wind_spd: float | None,
    wind_dir: float | None,
    rwy_heading: float,
) -> float | None:
    """
    Headwind component (kt) along the runway approach heading.
    Positive = headwind into the aircraft, negative = tailwind.

    Formula: headwind = wind_speed × cos(wind_dir − rwy_heading)
    where wind_dir is the direction the wind is FROM (met. convention)
    and rwy_heading is the direction the aircraft flies to land.
    """
    if wind_spd is None or wind_dir is None:
        return None
    return round(wind_spd * math.cos(math.radians(wind_dir - rwy_heading)), 1)


def _ap_state(ac: dict, now: float, key: str):
    """Fresh autopilot flag (True / False) from live_state, or None."""
    ts = ac.get("ap_ts")
    if ts is None or now - ts > AP_FRESH_SEC:
        return None
    v = ac.get(key)
    return None if v is None else bool(v)


def gs_status(
    altitude_ft: float,
    dist_thr_nm: float,
    thr_elevation_ft: float = 0.0,
) -> str:
    """
    Return 'ON', 'HIGH', 'LOW', or 'FAR' for the aircraft's position relative
    to the 3° glideslope.  'FAR' is returned when the aircraft is more than
    20 NM from the threshold (glideslope interception not yet expected).

    thr_elevation_ft: reference elevation (ft) of the glideslope origin in
    the same altitude frame as altitude_ft.  MODE-S altitude is pressure
    altitude, so WindshearTracker passes threshold elevation + QNH correction
    ((1013.25 − QNH) × 27 ft) once the METAR QNH is known.
    """
    if dist_thr_nm is None or dist_thr_nm > 20:
        return "FAR"
    expected = thr_elevation_ft + dist_thr_nm * GS_FT_PER_NM
    delta = altitude_ft - expected
    if abs(delta) <= GS_TOLERANCE_FT:
        return "ON"
    return "HIGH" if delta > 0 else "LOW"


# ── WindshearTracker ──────────────────────────────────────────────────────────

class WindshearTracker:
    """
    Thread-safe in-RAM store for aircraft currently on approach.

    Instantiated once in run.py and shared between the background sweep
    thread (writer) and the Flask web layer (reader via get_state()).
    """

    def __init__(
        self,
        airport_lat: float,
        airport_lon: float,
        max_dist_nm: float          = 30.0,
        max_alt_ft: float           = 5_000.0,
        corridor_half_width: float  = ILS_CORRIDOR_HALF_WIDTH_NM,
        max_ils_nm: float           = ILS_MAX_RANGE_NM,
        thr_elevation_ft: float     = 0.0,
        max_track_dev: float        = CORRIDOR_MAX_TRACK_DEV_DEG,
        runways: list               = None,
        ga_min_descent_polls: int   = GA_MIN_DESCENT_POLLS,
        ga_min_climb_polls: int     = GA_MIN_CLIMB_POLLS,
        ga_min_alt_gain_ft: float   = GA_MIN_ALT_GAIN_FT,
        ga_climb_fpm: float         = GA_CLIMB_FPM,
        ga_max_alt_ft: float        = GA_MAX_ALT_FT,
        ga_flash_sec: float         = GA_FLASH_SEC,
        blocked_reg_prefixes: tuple = (),
        on_approach_committed       = None,
        bds_sample_fn               = None,
        mag_declination: float | None = None,
    ):
        self.airport_lat          = airport_lat
        self.airport_lon          = airport_lon
        self.max_dist_nm          = max_dist_nm
        self.max_alt_ft           = max_alt_ft
        self.corridor_half_width  = corridor_half_width
        self.max_ils_nm           = max_ils_nm
        self.thr_elevation_ft     = thr_elevation_ft
        self.max_track_dev        = max_track_dev
        self.runways              = runways or EFHK_RUNWAYS
        self.ga_min_descent_polls = ga_min_descent_polls
        self.ga_min_climb_polls   = ga_min_climb_polls
        self.ga_min_alt_gain_ft   = ga_min_alt_gain_ft
        self.ga_climb_fpm         = ga_climb_fpm
        self.ga_max_alt_ft        = ga_max_alt_ft
        self.ga_flash_sec         = ga_flash_sec
        self.blocked_reg_prefixes     = blocked_reg_prefixes
        self._on_approach_committed   = on_approach_committed  # optional callback(record)
        # Optional callable(icao, since_ts) -> (bds50_samples, bds60_samples)
        # (collector.receiver.get_bds_samples); None disables the roughness capture.
        self._bds_sample_fn           = bds_sample_fn
        self.mag_declination          = mag_declination  # fallback °E when the aircraft has no mag_decl

        self._state: dict[str, dict]  = {}   # icao → approach record
        self._ga_counts: dict[str, int] = {}  # icao → session go-around count (persists after prune)
        self._ga_events: list[dict]   = []    # recent go-around events for the API/log
        self._approach_history: list[dict] = []   # landed approach records (newest first)
        self._band_winds: dict[str, dict]  = {}   # icao → in-flight band capture state
        self._band_gnss:  dict[str, dict]  = {}   # icao → in-flight GNSS-quality band capture
        self._rough:      dict[str, dict]  = {}   # icao → in-flight approach-roughness capture
        self._windrose_obs: dict[str, list] = {}  # icao → in-flight low-alt wind obs list
        self._windrose_buffer: list[dict]   = []  # global rolling buffer, newest last
        self._pos_track: dict[str, dict]   = {}   # icao → {dist, alt} for position-freeze detection
        self._recent_commits: dict[str, float] = {}  # icao → timestamp of last approach-history commit
        self._ga_last_ts: dict[str, float] = {}      # icao → time of last go-around (count expiry)
        self._qnh_hpa: float | None = None           # latest METAR QNH (None = not yet known → no correction)
        self._metar: dict | None = None              # latest METAR surface wind (see set_metar)
        self._metar_set_ts: float = 0.0
        self._lock  = threading.RLock()

    # ── QNH ───────────────────────────────────────────────────────────────────

    def set_qnh(self, qnh_hpa: float | None) -> None:
        """Update the QNH used for pressure-altitude correction.

        Called by the WX poll thread (web/app.py) whenever a new METAR is
        parsed.  Until the first call no correction is applied, i.e. the
        tracker behaves exactly as before (pressure altitude used as-is).
        """
        if qnh_hpa is not None and 900.0 <= float(qnh_hpa) <= 1100.0:
            self._qnh_hpa = float(qnh_hpa)

    def set_metar(self, metar_text: str | None) -> None:
        """Store the latest METAR surface wind for the approach records.

        Called by the WX poll thread with the raw METAR text.  Keeps
        {"t": "DDHHMM" observation time, "dir": ° or None (VRB), "spd": kt,
        "gst": kt or None, "var": "200V260" or None}.
        """
        if not metar_text:
            return
        w = re.search(r"\b(VRB|\d{3})(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)\b", metar_text)
        if not w:
            return
        k = 1.943844 if w.group(4) == "MPS" else 1.0
        t = re.search(r"\b(\d{6})Z\b", metar_text)
        v = re.search(r"\b(\d{3}V\d{3})\b", metar_text)
        self._metar = {
            "t":   t.group(1) if t else None,
            "dir": None if w.group(1) == "VRB" else int(w.group(1)),
            "spd": int(round(int(w.group(2)) * k)),
            "gst": int(round(int(w.group(3)) * k)) if w.group(3) else None,
            "var": v.group(1) if v else None,
        }
        self._metar_set_ts = time.time()

    def _qnh_corr_ft(self) -> float:
        """Pressure altitude minus MSL altitude (ft); 0 when QNH is unknown."""
        if self._qnh_hpa is None:
            return 0.0
        return (1013.25 - self._qnh_hpa) * QNH_FT_PER_HPA

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _best_runway(self, lat: float, lon: float,
                     track: float | None = None) -> tuple:
        """
        Find the best-matching ILS runway using rectangular corridor geometry
        plus an optional track heading check to reject departures.

        For each runway the aircraft must satisfy all of:
          • |cross_track| ≤ corridor_half_width  (within corridor width)
          • 0 ≤ along_track ≤ max_ils_nm         (approaching, not departed)
          • |track − approach_hdg| ≤ max_track_dev  (heading right direction)
            — only applied when track data is available; omitted otherwise so
            that aircraft without a current ground track are still accepted on
            geometry alone.

        The track gate is the key filter for parallel-runway departures: a
        departure on 22L flies ~180° opposite to the 04L approach heading and
        is trivially rejected, even though it passes all the geometric gates.

        Among qualifying runways, the one with the smallest |cross_track| wins.

        Returns (runway_name, dist_from_threshold_nm, cross_track_nm, along_track_nm).
        All values are None when no runway corridor matches.
        """
        best_name    = None
        best_dist    = None
        best_xt      = None
        best_at      = None
        best_abs_xt  = float("inf")

        for rwy in self.runways:
            xt = _cross_track_nm(lat, lon, rwy["thr_lat"], rwy["thr_lon"], rwy["heading"])
            at = _along_track_nm(lat, lon, rwy["thr_lat"], rwy["thr_lon"], rwy["heading"])

            # Geometric corridor gates
            if abs(xt) > self.corridor_half_width:
                continue
            if at < 0 or at > self.max_ils_nm:
                continue

            # Track heading gate — reject if aircraft is flying the wrong way.
            # Skipped when track is unavailable (None) to preserve behaviour for
            # aircraft that do not broadcast ground track on short final.
            if track is not None:
                track_limit = rwy.get("max_track_dev", self.max_track_dev)
                if _hdg_diff(track, rwy["heading"]) > track_limit:
                    continue

            if abs(xt) < best_abs_xt:
                best_abs_xt = abs(xt)
                best_name   = rwy["name"]
                best_dist   = _haversine_nm(rwy["thr_lat"], rwy["thr_lon"], lat, lon)
                best_xt     = xt
                best_at     = at

        return best_name, best_dist, best_xt, best_at

    # ── Public API ────────────────────────────────────────────────────────────

    def update(self, aircraft: dict) -> None:
        """
        Evaluate one aircraft snapshot and update the tracker.

        Called every ~3 s from the background sweep thread.
        """
        icao = aircraft.get("icao")
        lat  = aircraft.get("lat")
        lon  = aircraft.get("lon")
        alt  = aircraft.get("altitude")

        if not (icao and lat is not None and lon is not None and alt is not None):
            return

        # Exclude registration-blocked aircraft (e.g. helicopters) — they are
        # filtered system-wide from live_state via the JSON poller, but may
        # briefly appear here on Beast-only messages before the JSON poller
        # has populated their registration.  Belt-and-suspenders: prune them
        # from the windshear tracker state as well.
        reg = (aircraft.get("registration") or "")
        if is_blocked_registration(reg, self.blocked_reg_prefixes):
            with self._lock:
                self._state.pop(icao, None)
                self._band_winds.pop(icao, None)
                self._band_gnss.pop(icao, None)
                self._rough.pop(icao, None)
                self._windrose_obs.pop(icao, None)
                self._pos_track.pop(icao, None)
            return

        now = time.time()

        # ── Distance and altitude gates ───────────────────────────────────────
        dist_apt = _haversine_nm(self.airport_lat, self.airport_lon, lat, lon)
        if dist_apt > self.max_dist_nm or alt > self.max_alt_ft:
            with self._lock:
                self._state.pop(icao, None)
                self._band_winds.pop(icao, None)
                self._band_gnss.pop(icao, None)
                self._rough.pop(icao, None)
                self._windrose_obs.pop(icao, None)
                self._pos_track.pop(icao, None)
            return

        # ── ILS corridor detection ────────────────────────────────────────────
        qnh_corr = self._qnh_corr_ft()   # pressure alt − MSL alt (0 until QNH known)
        track  = aircraft.get("track")
        runway, dist_thr, cross_track, along_track = self._best_runway(lat, lon, track)

        # Glideslope floor gate — reject the corridor match when the aircraft is
        # more than CORRIDOR_GS_FLOOR_FT below the theoretical 3° glidepath.
        # Primary filter for traffic overflying the RWY 33 approach area while
        # vectored to 22L/22R: at 12–15 NM they are 1 000–2 000 ft below the
        # glidepath and would otherwise pass all geometric and heading gates.
        # Legitimate approaches always clear this gate; an aircraft 800 ft low
        # of the glidepath still has a 200 ft margin at any distance.
        if runway is not None and dist_thr is not None:
            _floor_thr_elev = next(
                (r.get("thr_elevation_ft", self.thr_elevation_ft)
                 for r in self.runways if r["name"] == runway),
                self.thr_elevation_ft,
            )
            # Expected pressure altitude on the 3° path (QNH-corrected so that
            # high-QNH days do not push legitimate approaches below the floor)
            _gs_expected = _floor_thr_elev + dist_thr * GS_FT_PER_NM + qnh_corr
            if alt < _gs_expected - CORRIDOR_GS_FLOOR_FT:
                runway = dist_thr = cross_track = along_track = None

        in_corridor = runway is not None

        vert_rate   = aircraft.get("vert_rate") or 0
        wind_spd    = aircraft.get("best_wind_spd")
        wind_dir    = aircraft.get("best_wind_dir")
        temperature = aircraft.get("best_temp")
        squawk      = aircraft.get("squawk")
        ias         = aircraft.get("bds60_ias")
        rwy_thr_elev = next(
            (r.get("thr_elevation_ft", self.thr_elevation_ft) for r in self.runways if r["name"] == runway),
            self.thr_elevation_ft,
        )
        gs_stat     = gs_status(alt, dist_thr, rwy_thr_elev + qnh_corr) if in_corridor else "FAR"

        # Headwind component along the matched runway's approach heading.
        # Used by the JS windshear detection algorithm.
        rwy_hdg     = next((r["heading"] for r in self.runways if r["name"] == runway), None)
        headwind_kt = _headwind_kt(wind_spd, wind_dir, rwy_hdg) if rwy_hdg is not None else None

        # ── Entry state gate ──────────────────────────────────────────────────────
        # If this aircraft has never been tracked before AND it is currently
        # climbing hard (vert_rate > +200 fpm), it is almost certainly a
        # departing aircraft that has briefly passed the geometric corridor gates
        # near the threshold.  Reject it before it pollutes the ILS profile.
        #
        # Existing tracked aircraft are always exempt: a go-around aircraft will
        # start climbing while already present in self._state, so the gate never
        # fires for a legitimate missed approach.
        #
        # self._state is written only by this sweep thread, so reading it without
        # the lock is safe here (RLock is still used for the state update below).
        if icao not in self._state and vert_rate > 200:
            return

        with self._lock:
            prev    = self._state.get(icao, {})
            history = [h for h in prev.get("history", [])
                       if now - h["ts"] <= MAX_HISTORY_SEC]

            # Prefer the latest real callsign; once known, never revert to ICAO.
            raw_cs   = aircraft.get("callsign")
            prev_cs  = prev.get("callsign")
            if raw_cs and raw_cs != icao:
                callsign = raw_cs
            elif prev_cs and prev_cs != icao:
                callsign = prev_cs   # keep cached value
            else:
                callsign = icao      # nothing known yet

            # NOTE: history.append is deferred to after pos_frozen is computed
            # (see below) so that frozen-position sweeps are excluded from the
            # trail and produce a visible gap on the ILS canvas.

            # ── Go-around state machine ───────────────────────────────────────
            # Carry forward per-aircraft state from the previous sweep.
            prev_ga_phase      = prev.get("ga_phase", "NONE")
            ga_phase           = prev.get("ga_phase", "NONE")
            ga_descent_polls   = prev.get("ga_descent_polls", 0)
            ga_climb_polls     = prev.get("ga_climb_polls", 0)
            ga_climb_start_alt = prev.get("ga_climb_start_alt", None)
            ga_flash_until     = prev.get("ga_flash_until", 0.0)
            ga_left_corridor   = prev.get("ga_left_corridor", False)

            # ── Threshold-pass landing candidate ──────────────────────────────
            # An APPROACHING aircraft whose runway match changes (leaves the
            # corridor, or flips to the parallel runway's corridor while rolling
            # out) at or past the threshold of the runway it was established on
            # has crossed the threshold → landing candidate for that runway.
            # Only relevant when the receiver tracks aircraft that low; the
            # normal "lost contact on final" path in prune_stale() is unchanged.
            landing_rwy       = prev.get("landing_rwy")
            landing_ts        = prev.get("landing_ts")
            landing_exit_alt  = prev.get("landing_exit_alt")
            landing_committed = prev.get("landing_committed", False)
            _prev_rwy = prev.get("approach_runway")
            if (landing_rwy is None and prev_ga_phase == "APPROACHING"
                    and _prev_rwy and runway != _prev_rwy):
                _pr = next((r for r in self.runways if r["name"] == _prev_rwy), None)
                if _pr is not None:
                    _at_prev = _along_track_nm(lat, lon, _pr["thr_lat"], _pr["thr_lon"], _pr["heading"])
                    if _at_prev <= LANDING_THR_PASS_NM:
                        landing_rwy      = _prev_rwy
                        landing_ts       = now
                        landing_exit_alt = alt
                        log.debug("Threshold crossing: %s RWY %s at %d ft", icao, _prev_rwy, round(alt))

            if in_corridor:
                # GO_AROUND → NONE transition: aircraft has left the corridor
                # during climb-out (ga_left_corridor flag set below) and has
                # now re-entered — it is on its 2nd approach.  Reset the phase
                # so approach tracking and history capture start fresh while
                # preserving ga_count for the "2nd APP" badge.
                if ga_phase == "GO_AROUND" and ga_left_corridor:
                    ga_phase           = "NONE"
                    ga_left_corridor   = False
                    ga_descent_polls   = 0
                    ga_climb_polls     = 0
                    ga_climb_start_alt = None

                if ga_phase == "NONE":
                    # Accumulate descent polls; decay when not descending
                    if vert_rate <= -200:
                        ga_descent_polls += 1
                        if ga_descent_polls >= self.ga_min_descent_polls:
                            ga_phase = "APPROACHING"
                    else:
                        ga_descent_polls = max(0, ga_descent_polls - 1)

                elif ga_phase == "APPROACHING":
                    if vert_rate >= self.ga_climb_fpm and alt <= self.ga_max_alt_ft:
                        # Sustained climb gate — require ga_min_climb_polls consecutive
                        # polls above the climb threshold before firing.  This prevents
                        # a single gust-induced vert_rate spike from triggering a false
                        # go-around detection in turbulent / gusty conditions.
                        if ga_climb_polls == 0:
                            ga_climb_start_alt = alt   # record altitude at climb onset
                        ga_climb_polls += 1
                        alt_gained = (alt - ga_climb_start_alt) if ga_climb_start_alt is not None else 0
                        if (ga_climb_polls >= self.ga_min_climb_polls
                                and alt_gained >= self.ga_min_alt_gain_ft):
                            # ── Go-around confirmed ───────────────────────────
                            self._ga_counts[icao] = self._ga_counts.get(icao, 0) + 1
                            self._ga_last_ts[icao] = now
                            count              = self._ga_counts[icao]
                            ga_phase           = "GO_AROUND"
                            ga_climb_polls     = 0
                            ga_climb_start_alt = None
                            ga_flash_until     = now + self.ga_flash_sec
                            event = {
                                "type":     "go_around",
                                "ts":       now,
                                "icao":     icao,
                                "callsign": callsign,
                                "rwy":      runway or "?",
                                "alt_ft":   round(alt),
                                "count":    count,
                            }
                            self._ga_events.append(event)
                            if len(self._ga_events) > GA_EVENTS_MAX:
                                self._ga_events.pop(0)
                            log.info(
                                "GO-AROUND detected: %s (%s) RWY %s at %d ft "
                                "(gained %d ft, GA #%d)",
                                callsign, icao, runway, round(alt),
                                round(alt_gained), count,
                            )
                    else:
                        # Not climbing or above ceiling — reset both climb counters
                        ga_climb_polls     = 0
                        ga_climb_start_alt = None
            else:
                # Left the corridor — reset APPROACHING; mark GO_AROUND so that
                # when the aircraft re-enters for a 2nd approach the phase resets.
                if ga_phase == "APPROACHING":
                    ga_phase           = "NONE"
                    ga_descent_polls   = 0
                    ga_climb_polls     = 0
                    ga_climb_start_alt = None
                elif ga_phase == "GO_AROUND":
                    ga_left_corridor   = True

            # Landing candidate housekeeping
            if landing_rwy is not None and not landing_committed:
                if (ga_phase == "GO_AROUND"
                        or (landing_exit_alt is not None
                            and alt > landing_exit_alt + LANDING_CANCEL_CLIMB_FT)):
                    # Climbed away after crossing the threshold — missed approach
                    log.info("Threshold crossing cancelled (climb-out): %s RWY %s",
                             icao, landing_rwy)
                    landing_rwy = landing_ts = landing_exit_alt = None
            if (landing_rwy is not None and in_corridor
                    and ga_phase == "APPROACHING" and dist_thr is not None and dist_thr > 3.0):
                # Established on a new approach well out on final — start fresh
                landing_rwy = landing_ts = landing_exit_alt = None
                landing_committed = False

            ga_count  = self._ga_counts.get(icao, 0)
            is_return = ga_count > 0 and ga_phase != "GO_AROUND"

            # ── Position-freeze detection ─────────────────────────────────────
            # Update the per-aircraft position tracker on every in-corridor
            # sweep — even during NONE periods — so the detector stays current
            # through meteo gaps and does not false-fire when wind data recovers
            # after a legitimate NONE window.
            #
            # pos_frozen is True when altitude has dropped more than BAND_TOL_FT
            # since the position last moved, while dist_thr has not advanced by
            # at least POS_FREEZE_MIN_NM — the signature of a GPS-jammed frozen
            # position.  Wind computed in this state is based on a stale
            # groundspeed vector and must not be written to Approach History or
            # the Windrose buffer.
            #
            # The reference point is an *anchor* that only moves when the
            # position moves (or the aircraft climbs above it).  Comparing
            # consecutive 3-s sweeps instead never fires: a 3° descent loses only
            # ~40 ft per sweep, far below the 100 ft BAND_TOL_FT threshold.
            pos_frozen = False
            if in_corridor and dist_thr is not None:
                anchor = self._pos_track.get(icao)
                if anchor is None:
                    self._pos_track[icao] = {"dist": dist_thr, "alt": alt}
                else:
                    dist_moved = abs(dist_thr - anchor["dist"])
                    alt_drop   = anchor["alt"] - alt
                    if dist_moved >= POS_FREEZE_MIN_NM or alt_drop < 0:
                        # Position moved (or climbed) — normal flight; re-anchor
                        self._pos_track[icao] = {"dist": dist_thr, "alt": alt}
                    elif alt_drop > BAND_TOL_FT:
                        pos_frozen = True   # keep anchor until the position moves again
            elif not in_corridor:
                self._pos_track.pop(icao, None)

            # ── ILS profile position history ──────────────────────────────────
            # Append only when in corridor AND position is not frozen.
            # Excluding frozen sweeps means consecutive history entries will
            # have a timestamp gap whenever GPS is jammed, which the JS trail
            # renderer detects (>10 s gap → moveTo instead of lineTo) and shows
            # as a visible blank rather than a straight line across the outage.
            if in_corridor and not pos_frozen:
                history.append({
                    "ts":       now,
                    "lat":      lat,
                    "lon":      lon,
                    "altitude": alt,
                    "dist_thr": round(dist_thr, 2),
                })

            # ── Approach history: altitude-band wind capture ──────────────────────
            # Capture the first wind reading within ±BAND_TOL_FT of each target
            # altitude while the aircraft is in the corridor with valid wind data.
            # Bands are locked once captured so we record the highest-altitude
            # reading at each level, not the last one.
            # pos_frozen guards against GPS-jammed frozen-position sweeps where
            # EHS wind may be computed from a stale groundspeed vector.
            # Bands are MSL altitudes: pressure altitude is QNH-corrected
            # (no correction until the first METAR QNH is known).  No capture
            # after a threshold crossing (rollout wind is not meaningful).
            alt_msl = alt - qnh_corr
            if (in_corridor and not pos_frozen and landing_rwy is None
                    and wind_spd is not None and wind_dir is not None
                    and aircraft.get("meteo_source", "NONE") != "NONE"):
                bw = self._band_winds.setdefault(icao, {
                    "icao": icao, "callsign": callsign, "runway": runway,
                    "bands": {str(b): None for b in APPROACH_HISTORY_BANDS},
                })
                bw["callsign"] = callsign   # update once callsign becomes known
                bw["runway"]   = runway     # track most-recently matched runway
                for band in APPROACH_HISTORY_BANDS:
                    key = str(band)
                    if bw["bands"][key] is None and abs(alt_msl - band) <= BAND_TOL_FT:
                        bw["bands"][key] = {"dir": round(wind_dir), "spd": round(wind_spd, 1)}
            # ── Approach history: GNSS quality per altitude band ─────────────────
            # Recorded on every in-corridor sweep before the threshold (no wind
            # or freeze gate) so GPS degradation and recovery on final can be
            # analysed per band and per runway.
            if in_corridor and landing_rwy is None:
                self._capture_gnss(icao, aircraft, now, alt_msl, dist_thr, pos_frozen)
                # Approach roughness (raw BDS 5,0 / 6,0 activity on final)
                self._capture_rough(icao, aircraft, now, alt_msl, runway,
                                    cross_track, ga_phase, dist_thr)
            # Reset band state when established aircraft leaves the corridor
            # (vectored-off, overflight, missed approach leaving laterally).
            # (kept when the aircraft left by crossing the threshold — landing)
            if not in_corridor and prev_ga_phase == "APPROACHING" and landing_rwy is None:
                self._band_winds.pop(icao, None)
                self._band_gnss.pop(icao, None)
                self._rough.pop(icao, None)

            # ── Windrose low-altitude observation buffer ──────────────────────
            # Mirror the JS Lo-buffer gate: accumulate one obs per 400 ft of
            # altitude change OR 0.5 NM of along-track progress, capped at 40
            # entries per aircraft.  Requirements: in corridor, alt ≤ 2 000 ft,
            # valid non-NONE wind — identical conditions to JS wsWindHistory.
            # pos_frozen guard matches the band capture gate above.
            if (in_corridor and not pos_frozen and landing_rwy is None
                    and alt <= WINDROSE_OBS_MAX_ALT_FT
                    and wind_spd is not None
                    and wind_dir is not None
                    and aircraft.get("meteo_source", "NONE") != "NONE"):
                wr_hist = self._windrose_obs.setdefault(icao, [])
                wr_last = wr_hist[-1] if wr_hist else None
                wr_alt_moved  = (not wr_last
                                 or abs(wr_last["alt_ft"]  - alt)          >= WINDROSE_MIN_ALT_GAP_FT)
                wr_dist_moved = (not wr_last
                                 or abs(wr_last["dist_nm"] - dist_thr)     >= WINDROSE_MIN_DIST_GAP_NM)
                if wr_alt_moved or wr_dist_moved:
                    wr_hist.append({
                        "dist_nm":  round(dist_thr, 2),
                        "alt_ft":   round(alt),
                        "wind_dir": round(wind_dir),
                        "wind_spd": round(wind_spd, 1),
                    })
                    if len(wr_hist) > WINDROSE_OBS_CAP:
                        wr_hist.pop(0)

            # ── NONE reason classification ──────────────────────────────────
            # Classifies why meteo_source is NONE so the frontend can draw
            # different symbols for normal maneuvering vs GPS-related issues.
            #   'qc'     — pyModeS quality rejection (turn, high bank angle, etc.);
            #              the aircraft has a valid, updating GPS position so this
            #              is entirely expected and operationally normal.
            #   'freeze' — our position-freeze gate fired; GPS position is stuck
            #              while altitude descends, a signature of GPS jamming.
            #   'gap'    — no ADS-B position message; GPS source has dropped out.
            #   None     — meteo_source is not NONE; classification not applicable.
            _meteo_src = aircraft.get("meteo_source", "NONE")
            if _meteo_src != "NONE":
                none_reason = None
            elif pos_frozen:
                none_reason = "freeze"
            elif lat is None:
                none_reason = "gap"
            else:
                none_reason = "qc"

            self._state[icao] = {
                "icao":           icao,
                "callsign":       callsign,
                "registration":   aircraft.get("registration"),
                "aircraft_type":  aircraft.get("aircraft_type"),
                "lat":            lat,
                "lon":            lon,
                "altitude":       round(alt),
                "vert_rate":      round(vert_rate),
                "groundspeed":    aircraft.get("groundspeed"),
                "track":          track,
                "best_wind_spd":  wind_spd,
                "best_wind_dir":  wind_dir,
                "best_temp":      temperature,
                "meteo_source":   _meteo_src,
                "none_reason":    none_reason,
                # Autopilot engaged / approach mode (ADS-B TC 29, version 2
                # transponders; None when unknown or older than AP_FRESH_SEC)
                "ap":             _ap_state(aircraft, now, "ap"),
                "ap_app":         _ap_state(aircraft, now, "ap_app"),
                "pos_frozen":     pos_frozen,
                "in_corridor":    in_corridor,
                "approach_runway":runway,
                "dist_apt_nm":    round(dist_apt, 1),
                "dist_thr_nm":    round(dist_thr, 2) if in_corridor else None,
                # Distance to the most-likely approach runway threshold for
                # non-corridor aircraft — used by the frontend to place
                # pre-corridor NONE circles on the ILS canvas X-axis
                # (e.g. during a wide localizer intercept turn).
                #
                # Selection priority:
                #   1. Previously matched runway still stored in state — the
                #      aircraft was just in the corridor for that runway so
                #      using its threshold gives the most coherent X-axis.
                #   2. Runways whose approach heading is within 90° of the
                #      aircraft's current track — filters out opposite-direction
                #      runways (e.g. a RWY15 intercept won't snap to a RWY22
                #      threshold because 22 is ~75° away from 15 but its
                #      threshold can be physically closer).
                #   3. All runways — fallback when track is unavailable.
                #
                # None when position is unavailable or aircraft is in corridor
                # (in-corridor aircraft use dist_thr_nm for the X-axis).
                "dist_nearest_thr_nm": (lambda: (
                    None if (in_corridor or lat is None) else
                    round(
                        min(
                            (_haversine_nm(lat, lon, r["thr_lat"], r["thr_lon"])
                             for r in (
                                 # Priority 1: previously matched runway
                                 [r for r in self.runways
                                  if r["name"] == prev.get("approach_runway")]
                                 # Priority 2: heading-compatible runways (track within 90°)
                                 or (
                                     [r for r in self.runways
                                      if track is not None
                                      and _hdg_diff(track, r["heading"]) <= 90]
                                 )
                                 # Priority 3: all runways (track unavailable)
                                 or self.runways
                             )
                            )
                        ),
                        2,
                    )
                ))(),
                "cross_track_nm": round(cross_track, 2) if in_corridor else None,
                "along_track_nm": round(along_track, 2) if in_corridor else None,
                "headwind_kt":    headwind_kt,
                "squawk":         squawk,
                "ias":            round(ias) if ias is not None else None,
                "gs_status":      gs_stat,
                "history":        history,
                "last_seen":      aircraft.get("last_seen", now),
                # Go-around state (consumed by the web UI)
                "ga_phase":           ga_phase,
                "ga_left_corridor":   ga_left_corridor,
                "ga_descent_polls":   ga_descent_polls,
                "ga_climb_polls":     ga_climb_polls,
                "ga_climb_start_alt": ga_climb_start_alt,
                "ga_flash_until":     ga_flash_until,
                "ga_flash":         ga_flash_until > now,
                "ga_count":         ga_count,
                "is_return":        is_return,
                # Threshold-pass landing state (see LANDING_* constants)
                "landing_rwy":       landing_rwy,
                "landing_ts":        landing_ts,
                "landing_exit_alt":  landing_exit_alt,
                "landing_committed": landing_committed,
            }

            # Confirm a threshold-pass landing once the aircraft has stayed
            # down for LANDING_CONFIRM_SEC — commit now rather than waiting for
            # stale-out (an aircraft may keep transmitting on the ground for a
            # long time, or depart again before ever going silent).
            if (landing_rwy is not None and not landing_committed
                    and now - landing_ts >= LANDING_CONFIRM_SEC):
                st = self._state[icao]
                st["landing_committed"] = True
                self._commit_approach(
                    icao, st,
                    self._band_winds.pop(icao, None),
                    self._windrose_obs.pop(icao, None),
                    now, rec_ts=landing_ts, runway=landing_rwy,
                    ga_count=self._ga_counts.get(icao, 0),
                    reason="THRESHOLD-PASS",
                    gnss=self._band_gnss.pop(icao, None),
                    rough=self._rough.pop(icao, None),
                )
                self._ga_counts.pop(icao, None)
                self._ga_last_ts.pop(icao, None)

    def prune_stale(self) -> None:
        """Remove aircraft not updated within STALE_TIMEOUT_SEC.

        When a corridor aircraft goes stale it is assumed to have landed.
        Its accumulated altitude-band wind data is committed to _approach_history
        under three conditions:

          • ga_phase == "APPROACHING" — normal case: ADS-B contact lost on final
            (typically 200–500 ft), approach fully confirmed by sustained descent.

          • ga_phase == "NONE" with approach_runway set — GPS-jamming case: the
            aircraft was geometrically established inside the ILS corridor (runway
            assigned) but its altitude was frozen so vert_rate never accumulated
            enough descent polls to confirm APPROACHING.  Still recorded so runway
            usage and aircraft-type statistics remain accurate.

          • landing_rwy set but not yet committed — threshold-pass landing whose
            LANDING_CONFIRM_SEC confirmation had not elapsed when contact was lost.

        Aircraft in GO_AROUND state are not committed, nor are aircraft whose
        threshold-pass landing was already committed from update().
        Go-around counts older than GA_COUNT_EXPIRY_SEC are forgotten here.
        """
        cutoff = time.time() - STALE_TIMEOUT_SEC
        now    = time.time()
        with self._lock:
            stale = [k for k, v in self._state.items() if v["last_seen"] < cutoff]
            for k in stale:
                entry = self._state.pop(k)
                bw    = self._band_winds.pop(k, None)
                gn    = self._band_gnss.pop(k, None)
                rg    = self._rough.pop(k, None)
                wr    = self._windrose_obs.pop(k, None)
                self._pos_track.pop(k, None)
                # Capture go-around count BEFORE clearing so it can be
                # included in the approach history record.
                ga_count_at_commit = self._ga_counts.get(k, 0)

                _landing_pending = (entry.get("landing_rwy") is not None
                                    and not entry.get("landing_committed"))
                _should_commit = (
                    entry.get("ga_phase") == "APPROACHING"
                    or (entry.get("ga_phase") == "NONE" and entry.get("approach_runway"))
                    or _landing_pending
                )
                if entry.get("landing_committed"):
                    _should_commit = False   # already recorded at threshold crossing

                # Clear go-around count on landing so future approaches from the
                # same aircraft (same ICAO, new flight) start without a stale
                # "2nd APP" badge.  The count is only needed to bridge the gap
                # between the go-around climb-out and the re-entry for the next
                # approach; once the aircraft lands it is no longer relevant.
                if entry.get("ga_phase") == "APPROACHING" or _should_commit:
                    self._ga_counts.pop(k, None)
                    self._ga_last_ts.pop(k, None)

                if _should_commit:
                    self._commit_approach(
                        k, entry, bw, wr, now,
                        rec_ts=entry.get("landing_ts") if _landing_pending else None,
                        runway=entry.get("landing_rwy") if _landing_pending else None,
                        ga_count=ga_count_at_commit,
                        gnss=gn,
                        rough=rg,
                        reason=("THRESHOLD-PASS" if _landing_pending
                                else "APPROACHING" if entry.get("ga_phase") == "APPROACHING"
                                else "NONE+rwy(GPS-jam)"),
                    )
                log.debug("Windshear: dropped stale %s (ga_phase=%s)", k, entry.get("ga_phase"))

            # Purge windrose entries older than WINDROSE_BUFFER_MAX_SEC
            wr_cutoff = now - WINDROSE_BUFFER_MAX_SEC
            while self._windrose_buffer and self._windrose_buffer[0]["ts"] < wr_cutoff:
                self._windrose_buffer.pop(0)

            # Forget go-around counts of aircraft that never came back to land
            # (e.g. diverted) so a later visit is not flagged "2nd APP".
            ga_cutoff = now - GA_COUNT_EXPIRY_SEC
            for k in [k for k, ts in self._ga_last_ts.items() if ts < ga_cutoff]:
                self._ga_last_ts.pop(k, None)
                self._ga_counts.pop(k, None)

    def _commit_approach(self, k: str, entry: dict, bw: dict | None, wr: list | None,
                         now: float, rec_ts: float | None = None,
                         runway: str | None = None, ga_count: int = 0,
                         reason: str = "", gnss: dict | None = None,
                         rough: dict | None = None) -> None:
        """Harvest windrose obs and write one landing to the approach history.

        Called with self._lock held, from prune_stale() (contact lost on final)
        or update() (confirmed threshold-pass landing).  rec_ts / runway
        override the record time and runway (threshold-pass landings use the
        threshold-crossing time and the runway the aircraft was established on).
        """
        # Harvest windrose observations.  Each obs gets a unique timestamp
        # (1-second apart, oldest first, ending at 'now') so the JS dedup in
        # fetchWindroseObs() does not collapse all observations from the same
        # aircraft into one entry.
        if wr:
            n_wr = len(wr)
            for i, obs in enumerate(wr):
                self._windrose_buffer.append({
                    "ts":  now - (n_wr - 1 - i),
                    "dir": obs["wind_dir"],
                    "spd": obs["wind_spd"],
                    "alt": obs["alt_ft"],
                })

        # Cooldown gate: suppress duplicate commits for the same ICAO within
        # COMMIT_COOLDOWN_SEC (5 min).  Prevents two history entries when an
        # aircraft briefly loses ADS-B signal (< 30 s gap triggers prune +
        # re-admit).  Go-around second approaches happen 10–15+ minutes later
        # and are never suppressed by this gate.
        if (now - self._recent_commits.get(k, 0.0)) < COMMIT_COOLDOWN_SEC:
            return

        # bw may be None when the aircraft never produced valid wind data
        # (e.g. meteo_source always NONE) — still record the landing with all
        # band values as None so it appears with "—" in the wind columns.
        ts  = rec_ts if rec_ts is not None else now
        t   = time.gmtime(ts)
        rwy = runway or (bw.get("runway") if bw else None) or entry.get("approach_runway") or "?"
        rwy_hdg = next((r["heading"] for r in self.runways if r["name"] == rwy), None)
        record = {
            "ts":            ts,
            "time_utc":      f"{t.tm_hour:02d}:{t.tm_min:02d}",
            "callsign":      (bw.get("callsign") if bw else None) or entry.get("callsign") or k,
            "icao":          k,
            "registration":  entry.get("registration"),
            "aircraft_type": entry.get("aircraft_type"),
            "runway":        rwy,
            "rwy_heading":   rwy_hdg,
            "bands":         bw.get("bands", {}) if bw else {str(b): None for b in APPROACH_HISTORY_BANDS},
            "go_arounds":    ga_count,
            # QNH used to convert band altitudes to MSL (None = not yet known,
            # bands are then raw pressure altitude as in records before 2026-09-25)
            "qnh_hpa":       self._qnh_hpa,
            # GNSS quality on final per band + first-degraded / recovery points
            "gnss":          self._gnss_record(gnss),
            # Approach roughness per segment + METAR wind at landing time
            "rough":         self._rough_record(rough, now),
            # Wind / headwind / Mach-TAS temperature per 200-ft band (from 2026-10-09)
            "prof":          self._prof_record(rough),
        }
        # Raw reply series for approach_series (DB only, not kept in RAM)
        series = self._series_blob(rough, record)
        self._approach_history.insert(0, record)
        if len(self._approach_history) > APPROACH_HISTORY_MAX:
            self._approach_history.pop()
        # Record commit time for the cooldown gate and prune old entries
        # (keep anything within 2× cooldown to bound size).
        self._recent_commits[k] = now
        cutoff_rc = now - COMMIT_COOLDOWN_SEC * 2
        self._recent_commits = {ik: t0 for ik, t0 in self._recent_commits.items() if t0 > cutoff_rc}

        # Notify the DB writer callback (wired in run.py) so the record is
        # persisted immediately without coupling this class to the DB layer.
        if self._on_approach_committed is not None:
            try:
                self._on_approach_committed({**record, "series": series})
            except Exception as cb_exc:
                log.warning("approach_committed callback failed: %s", cb_exc)
        log.info(
            "Approach history: %s (%s) RWY %s phase=%s — bands captured: %s",
            record["callsign"], k, rwy, reason,
            [ft for ft, v in record["bands"].items() if v],
        )

    # ── GNSS quality capture on final ─────────────────────────────────────────

    def _capture_gnss(self, icao: str, ac: dict, now: float, alt_msl: float,
                      dist_thr: float | None, pos_frozen: bool) -> None:
        """Record GNSS quality for one in-corridor sweep (lock held).

        Per band (±BAND_TOL_FT): lowest fresh NACp / NIC, largest age (s) of
        our own ADS-B position, whether the position-freeze gate fired, and
        the number of sweeps.  Plus the altitude / distance of the first and
        last degraded sweep and of the first clean sweep after degradation.
        """
        g = self._band_gnss.setdefault(icao, {
            "bands": {}, "n": 0, "deg_n": 0,
            "first_deg": None, "last_deg": None, "rec": None,
        })
        nacp, nacp_ts = ac.get("nac_p"), ac.get("nac_p_ts")
        if nacp_ts is None or now - nacp_ts > GNSS_FRESH_SEC:
            nacp = None
        nic, nic_ts = ac.get("nic"), ac.get("nic_ts")
        if nic_ts is None or now - nic_ts > GNSS_FRESH_SEC:
            nic = None
        own_ts  = ac.get("last_adsb_pos_ts")
        last_es = ac.get("last_es_ts")
        es_active = last_es is not None and now - last_es <= GNSS_ES_ACTIVE_SEC
        pos_age = None if own_ts is None else max(0, int(round(now - own_ts)))

        degraded = (
            (nacp is not None and nacp <= GNSS_NACP_DEG)
            or (nic is not None and nic <= GNSS_NIC_DEG)
            or (es_active and (pos_age is None or pos_age >= GNSS_POS_AGE_DEG_SEC))
            or pos_frozen
        )
        point = {"alt": int(round(alt_msl)),
                 "dist": None if dist_thr is None else round(dist_thr, 2)}
        g["n"] += 1
        if degraded:
            g["deg_n"] += 1
            if g["first_deg"] is None:
                g["first_deg"] = point
            g["last_deg"] = point
            g["rec"] = None
        elif g["last_deg"] is not None and g["rec"] is None:
            g["rec"] = point

        for band in APPROACH_HISTORY_BANDS:
            if abs(alt_msl - band) > BAND_TOL_FT:
                continue
            b = g["bands"].setdefault(str(band), {"nacp": None, "nic": None,
                                                  "pa": None, "fz": 0, "n": 0})
            if nacp is not None:
                b["nacp"] = nacp if b["nacp"] is None else min(b["nacp"], nacp)
            if nic is not None:
                b["nic"] = nic if b["nic"] is None else min(b["nic"], nic)
            if pos_age is not None:
                b["pa"] = pos_age if b["pa"] is None else max(b["pa"], pos_age)
            if pos_frozen:
                b["fz"] = 1
            b["n"] += 1

    @staticmethod
    def _gnss_record(g: dict | None) -> dict | None:
        """Compact GNSS record for approach_history (None if nothing captured)."""
        if not g or not g.get("n"):
            return None
        return {
            "bands":     g["bands"],
            "n":         g["n"],
            "deg_n":     g["deg_n"],
            "first_deg": g["first_deg"],
            "last_deg":  g["last_deg"],
            "rec":       g["rec"],
        }

    # ── Approach roughness capture on final ───────────────────────────────────

    def _capture_rough(self, icao: str, ac: dict, now: float, alt_msl: float,
                       runway: str | None, cross_track: float | None,
                       ga_phase: str, dist_thr: float | None = None) -> None:
        """Collect the raw BDS 5,0 / 6,0 replies received since the previous
        sweep into the current altitude segment (lock held).

        Samples are consumed even when the aircraft is not (yet) established,
        so only replies received while established are ever collected.
        Replies that disagree with the ADS-B track / groundspeed (likely a
        mis-identified Comm-B register) are dropped and counted as "bad".

        From 2026-10-09 the accepted replies are also kept as a raw series
        (approach_series), paired per 200-ft band into wind / headwind /
        Mach-TAS temperature (prof_json), and the TC 29 autopilot state is
        recorded per sweep (rough_json "ap").
        """
        if self._bds_sample_fn is None:
            return
        r = self._rough.get(icao)
        if r is None:
            r = self._rough[icao] = {"last": now - 4.0, "seg": {}, "bad": 0}
        try:
            b50, b60 = self._bds_sample_fn(icao, r["last"])
        except Exception as exc:
            log.debug("BDS sample fetch failed for %s: %s", icao, exc)
            return
        newest = max([s[0] for s in b50] + [s[0] for s in b60], default=None)
        if newest is not None:
            r["last"] = newest

        seg = None
        for name, lo, hi in ROUGH_SEGMENTS:
            if (lo < alt_msl <= hi) if name == "hi" else (lo <= alt_msl <= hi):
                seg = name
                break
        track   = ac.get("track")
        rwy_hdg = next((rw["heading"] for rw in self.runways if rw["name"] == runway), None)
        if (seg is None or ga_phase == "GO_AROUND" or cross_track is None
                or abs(cross_track) > ROUGH_MAX_XTRACK_NM or track is None
                or rwy_hdg is None or _hdg_diff(track, rwy_hdg) > ROUGH_MAX_TRACK_DEV):
            return
        if not b50 and not b60:
            return

        S = r["seg"].setdefault(seg, {"roll": [], "tr": [], "ias": [], "vr": [],
                                      "vsrc": set(), "crab": [], "t0": None, "t1": None})
        def _rd(v, nd):
            return None if v is None else (int(round(v)) if nd == 0 else round(v, nd))
        raw5 = r.setdefault("raw5", [])
        raw6 = r.setdefault("raw6", [])
        alt_r = int(round(alt_msl))

        # Per-sweep state for the series and the autopilot summary
        ap, app = ac.get("ap"), ac.get("ap_app")
        if ac.get("ap_ts") is None or now - ac["ap_ts"] > AP_FRESH_SEC:
            ap = app = None
        if ap is not None:
            r.setdefault("ap", []).append((alt_r, bool(ap), bool(app)))
        sw = r.setdefault("sw", [])
        if len(sw) < SERIES_MAX_ROWS:
            def _f(v, nd):
                return None if v is None else round(v, nd)
            sw.append([round(now, 1), alt_r, ac.get("altitude"), _f(dist_thr, 2),
                       _f(cross_track, 2), _f(ac.get("lat"), 5), _f(ac.get("lon"), 5),
                       ac.get("groundspeed"), _f(ac.get("track"), 1),
                       None if ap is None else int(ap), None if app is None else int(app)])
        band = min(APPROACH_HISTORY_BANDS, key=lambda b: abs(alt_msl - b))
        P = None
        if abs(alt_msl - band) <= BAND_TOL_FT:
            P = r.setdefault("prof", {}).setdefault(str(band), {"u": [], "v": [], "hw": [], "t": []})
        ok50 = []                           # accepted BDS 5,0 replies of this sweep

        def _span(ts):
            S["t0"] = ts if S["t0"] is None else min(S["t0"], ts)
            S["t1"] = ts if S["t1"] is None else max(S["t1"], ts)

        gs = ac.get("groundspeed")
        for ts, roll, trate, ttrk, bgs, _tas in b50:
            if (roll is None or abs(roll) > 40.0
                    or (bgs is not None and gs is not None and abs(bgs - gs) > 50)
                    or (ttrk is not None and _hdg_diff(ttrk, track) > 30.0)):
                r["bad"] += 1
                continue
            if len(S["roll"]) < ROUGH_MAX_SAMPLES:
                S["roll"].append((ts, roll))
                if trate is not None and abs(trate) <= 8.0:
                    S["tr"].append(trate)
            _span(ts)
            ok50.append((ts, roll, ttrk, bgs, _tas))
            if len(raw5) < SERIES_MAX_ROWS:
                raw5.append([round(ts, 2), _rd(roll, 2), _rd(trate, 3), _rd(ttrk, 2),
                             bgs, _tas, alt_r])
            if P is not None and _tas is not None and bgs is not None:
                P["hw"].append(_tas - bgs)          # headwind component (TAS − GS)

        decl = ac.get("mag_decl")
        if decl is None:
            decl = self.mag_declination
        for smp in b60:
            ts, ias, mhdg, vri, vrb = smp[:5]
            mach = smp[5] if len(smp) > 5 else None
            if ias is None or not 80 <= ias <= 260:
                r["bad"] += 1
                continue
            crab = None
            if mhdg is not None and decl is not None:
                crab = (mhdg + decl - track + 180.0) % 360.0 - 180.0
                if abs(crab) > 40.0:
                    r["bad"] += 1
                    continue
            if len(raw6) < SERIES_MAX_ROWS:
                raw6.append([round(ts, 2), ias, _rd(mhdg, 2), _rd(vri, 0), _rd(vrb, 0),
                             _rd(mach, 3), alt_r])
            if P is not None and ok50:
                # pair with the nearest accepted BDS 5,0 reply of this sweep
                p5 = min(ok50, key=lambda x: abs(x[0] - ts))
                t5, roll5, ttrk5, bgs5, tas5 = p5
                if abs(t5 - ts) <= PROF_PAIR_SEC and tas5 is not None:
                    tm = tm_temp_c(tas5, mach)
                    if tm is not None:
                        P["t"].append(tm)
                    if (mhdg is not None and decl is not None and ttrk5 is not None
                            and bgs5 is not None and abs(roll5) <= PROF_MAX_ROLL):
                        wspd, wdir = compute_wind(float(ttrk5), float(bgs5),
                                                  (mhdg + decl) % 360.0, float(tas5))
                        rd = math.radians(wdir)
                        P["u"].append(-wspd * math.sin(rd))
                        P["v"].append(-wspd * math.cos(rd))
            if len(S["ias"]) >= ROUGH_MAX_SAMPLES:
                continue
            S["ias"].append((ts, ias))
            if crab is not None:
                S["crab"].append((ts, crab))
            vr, src = (vri, "i") if vri is not None else (vrb, "b")
            if vr is not None and abs(vr) <= 4000:
                S["vr"].append((ts, vr))
                S["vsrc"].add(src)
            _span(ts)

    @staticmethod
    def _hp_rms(series: list) -> float | None:
        """RMS of a (ts, value) series about its moving median (±ROUGH_HP_HALF_WIN s)."""
        if len(series) < ROUGH_HP_MIN_N:
            return None
        series = sorted(series)
        ts = [t for t, _ in series]
        vs = [v for _, v in series]
        res = []
        j0 = 0
        n = len(series)
        for i in range(n):
            while ts[j0] < ts[i] - ROUGH_HP_HALF_WIN:
                j0 += 1
            j1 = i
            while j1 + 1 < n and ts[j1 + 1] <= ts[i] + ROUGH_HP_HALF_WIN:
                j1 += 1
            w = sorted(vs[j0:j1 + 1])
            m = len(w)
            med = w[m // 2] if m % 2 else 0.5 * (w[m // 2 - 1] + w[m // 2])
            res.append(vs[i] - med)
        return math.sqrt(sum(e * e for e in res) / len(res))

    @staticmethod
    def _sd(v: list) -> float:
        m = sum(v) / len(v)
        return math.sqrt(sum((x - m) ** 2 for x in v) / len(v))

    def _rough_record(self, r: dict | None, now: float) -> dict | None:
        """Compact roughness summary for approach_history (None if nothing).

        Per segment ("hi" 3000–1000 ft, "lo" 1000–200 ft MSL):
          n5 / n6  BDS 5,0 / 6,0 replies used;  dur  s from first to last
          rr       bank-angle RMS (°);  rp90 / rmax  90th pct / max |bank| (°)
          r5       replies with |bank| > 5° (wind calc rejects these)
          tr       track-rate RMS (°/s);  t1  replies with |track rate| > 1°/s
          isd      IAS std (kt) about a linear fit vs time (deceleration removed)
          imx      largest |IAS residual| (kt)
          vsd / vm vertical-rate std / mean (ft/min); vs  "i" inertial, "b" baro
          cm / csd crab angle (heading − track, °) mean / std; + = nose right
                   of track (wind from the right)
          rhp / ihp / vhp  "high-pass" RMS of bank (°), IAS (kt) and vertical
                   rate (ft/min) about their ±7.5 s moving median — slow changes
                   such as the end of the intercept turn, glideslope capture or
                   flap-speed steps removed; used by the approach-conditions index
        Plus "bad" (replies dropped as inconsistent) and "metar".
        """
        out: dict = {}
        for name, S in ((r or {}).get("seg") or {}).items():
            d: dict = {}
            rl = [v for _, v in S["roll"]]
            if rl:
                a = sorted(abs(x) for x in rl)
                d["n5"]   = len(rl)
                d["rr"]   = round(math.sqrt(sum(x * x for x in rl) / len(rl)), 2)
                d["rp90"] = round(a[min(len(a) - 1, int(0.9 * len(a)))], 1)
                d["rmax"] = round(a[-1], 1)
                d["r5"]   = sum(1 for x in a if x > ROUGH_ROLL_GATE)
                hp = self._hp_rms(S["roll"])
                if hp is not None:
                    d["rhp"] = round(hp, 2)
            tr = S["tr"]
            if tr:
                d["tr"] = round(math.sqrt(sum(x * x for x in tr) / len(tr)), 2)
                d["t1"] = sum(1 for x in tr if abs(x) > ROUGH_TRK_RATE_GATE)
            ias = S["ias"]
            if ias:
                d["n6"] = len(ias)
            if len(ias) >= 5:
                t0 = ias[0][0]
                xs = [t - t0 for t, _ in ias]
                ys = [float(v) for _, v in ias]
                mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
                sxx = sum((x - mx) ** 2 for x in xs)
                b = (sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx) if sxx > 0 else 0.0
                res = [y - (my + b * (x - mx)) for x, y in zip(xs, ys)]
                d["isd"] = round(math.sqrt(sum(e * e for e in res) / len(res)), 1)
                d["imx"] = round(max(abs(e) for e in res))
                hp = self._hp_rms(ias)
                if hp is not None:
                    d["ihp"] = round(hp, 1)
            vr = [v for _, v in S["vr"]]
            if len(vr) >= 3:
                d["vsd"] = int(round(self._sd(vr)))
                d["vm"]  = int(round(sum(vr) / len(vr)))
                d["vs"]  = "".join(sorted(S["vsrc"]))
                hp = self._hp_rms(S["vr"])
                if hp is not None:
                    d["vhp"] = int(round(hp))
            cr = [v for _, v in S["crab"]]
            if len(cr) >= 3:
                d["cm"]  = round(sum(cr) / len(cr), 1)
                d["csd"] = round(self._sd(cr), 1)
            if S["t0"] is not None:
                d["dur"] = int(round(S["t1"] - S["t0"]))
            if d:
                out[name] = d
        if out and r and r.get("bad"):
            out["bad"] = r["bad"]
        apl = (r or {}).get("ap") or []
        if apl:
            # Autopilot (ADS-B TC 29, version 2 transponders) while established:
            # n / on sweeps with a known state, the same below 1000 ft MSL, the
            # altitude where it was switched off (first on → off), approach mode
            lo = [x for x in apl if x[0] <= 1000]
            off_ft = next((apl[i][0] for i in range(1, len(apl))
                           if apl[i - 1][1] and not apl[i][1]), None)
            out["ap"] = {"n": len(apl), "on": sum(1 for x in apl if x[1]),
                         "n_lo": len(lo), "on_lo": sum(1 for x in lo if x[1]),
                         "off_ft": off_ft, "app": any(x[2] for x in apl)}
        if self._metar and now - self._metar_set_ts <= ROUGH_METAR_MAX_AGE:
            out["metar"] = dict(self._metar)
        return out or None

    @staticmethod
    def _prof_record(r: dict | None) -> dict | None:
        """Per 200-ft band on final (prof_json): n wind pairs, vector-mean
        wind wd / ws with sd (RMS vector deviation, kt), headwind component
        hw (TAS − GS, kt, + = headwind) with hn replies, Mach/TAS
        temperature t (°C, 10 % trimmed mean — at approach speeds one Mach
        step of 0.004 is ~4 K, so a mean resolves better than a median)
        with tn pairs.  None if nothing."""
        out = {}
        for band, P in ((r or {}).get("prof") or {}).items():
            d = {}
            n = len(P["u"])
            if n:
                um, vm = sum(P["u"]) / n, sum(P["v"]) / n
                d["n"]  = n
                d["ws"] = round(math.hypot(um, vm), 1)
                d["wd"] = int(round((math.degrees(math.atan2(-um, -vm)) + 360) % 360)) % 360
                d["sd"] = round(math.sqrt(sum((u - um) ** 2 + (v - vm) ** 2
                                              for u, v in zip(P["u"], P["v"])) / n), 1)
            if P["hw"]:
                d["hw"] = round(sum(P["hw"]) / len(P["hw"]), 1)
                d["hn"] = len(P["hw"])
            if P["t"]:
                d["t"]  = round(trimmed_mean(P["t"]), 1)
                d["tn"] = len(P["t"])
            if d:
                out[band] = d
        return out or None

    # Column layout of the approach_series blob: (name, scale, delta-coded).
    # Stored value = round(value × scale); delta-coded columns hold the
    # difference to the previous row (first row absolute).  None stays None.
    SERIES_COLS = {
        "b50": (("t", 100, True), ("roll", 100, False), ("trate", 1000, False),
                ("trk", 100, False), ("gs", 1, False), ("tas", 1, False),
                ("alt", 1, True)),
        "b60": (("t", 100, True), ("ias", 1, False), ("hdg", 100, False),
                ("vri", 1, False), ("vrb", 1, False), ("mach", 1000, False),
                ("alt", 1, True)),
        "sw":  (("t", 10, True), ("alt", 1, True), ("palt", 1, False),
                ("dthr", 100, False), ("xt", 100, False), ("lat", 100000, False),
                ("lon", 100000, False), ("gs", 1, False), ("trk", 10, False),
                ("ap", 1, False), ("app", 1, False)),
    }

    @classmethod
    def _series_blob(cls, r: dict | None, record: dict) -> bytes | None:
        """Raw series of one landing for approach_series: zlib-compressed JSON
        {"v": 1, "t0", "icao", "type", "rwy", "cols": {list: [[name, scale,
        delta], …]}, "b50": {col: [...]}, "b60": {...}, "sw": {...}} with
          b50  BDS 5,0 replies: t (s after t0), roll °, track rate °/s,
               true track °, GS kt, TAS kt, alt (ft MSL of the sweep)
          b60  BDS 6,0 replies: t, IAS kt, magnetic heading °, inertial and
               baro vertical rate ft/min, Mach, alt
          sw   sweeps (3 s): t, alt ft MSL, pressure alt ft, distance to
               threshold NM, cross-track NM, lat, lon, GS kt, track °,
               autopilot 0/1, approach mode 0/1
        Column values are integers: value × scale, delta-coded where marked
        (see SERIES_COLS) — about 2–3 kB per landing.  Only replies accepted
        while established on final (as the roughness statistics).
        Decode: v = cumsum(col) if delta else col; value = v / scale."""
        if not r:
            return None
        src = {"b50": r.get("raw5") or [], "b60": r.get("raw6") or [], "sw": r.get("sw") or []}
        if not any(src.values()):
            return None
        t0 = min(x[0] for v in src.values() for x in v)
        out = {"v": 1, "t0": round(t0, 2), "icao": record.get("icao"),
               "type": record.get("aircraft_type"), "rwy": record.get("runway"),
               "cols": {k: [list(c) for c in cols] for k, cols in cls.SERIES_COLS.items()}}
        for key, cols in cls.SERIES_COLS.items():
            rows = src[key]
            block = {}
            for i, (name, scale, delta) in enumerate(cols):
                vals = []
                prev = 0
                for row in rows:
                    v = row[i]
                    if i == 0:
                        v = v - t0
                    if v is None:
                        vals.append(None)
                        continue
                    iv = int(round(v * scale))
                    if delta:
                        vals.append(iv - prev)
                        prev = iv
                    else:
                        vals.append(iv)
                block[name] = vals
            out[key] = block
        return zlib.compress(json.dumps(out, separators=(",", ":")).encode(), 9)

    @classmethod
    def decode_series(cls, blob: bytes) -> dict:
        """Inverse of _series_blob: {"b50"|"b60"|"sw": {col: [values]}} plus
        the header fields (for analysis scripts)."""
        d = json.loads(zlib.decompress(blob))
        for key, cols in d.get("cols", {}).items():
            block = d.get(key) or {}
            for name, scale, delta in cols:
                vals, acc, res = block.get(name, []), 0, []
                for v in vals:
                    if v is None:
                        res.append(None)
                        continue
                    if delta:
                        acc += v
                        v = acc
                    res.append(v / scale)
                if name == "t":
                    res = [None if v is None else round(v + d["t0"], 2) for v in res]
                block[name] = res
        return d

    def get_state(self) -> dict:
        """
        Thread-safe snapshot of all currently tracked approach aircraft plus
        recent go-around events for the web log panel.

        Returns a dict with keys:
          'aircraft'  — list of aircraft dicts, sorted by distance from threshold
          'ga_events' — list of go-around event dicts from this session
        """
        with self._lock:
            items     = list(self._state.values())
            ga_events = list(self._ga_events)   # snapshot to avoid race
        items.sort(key=lambda x: x.get("dist_thr_nm") or x.get("dist_apt_nm") or 999)
        return {"aircraft": items, "ga_events": ga_events}

    def get_approach_history(self) -> list:
        """Thread-safe snapshot of the landed approach history list (newest first)."""
        with self._lock:
            return list(self._approach_history)

    def preload_approach_history(self, records: list) -> None:
        """
        Pre-populate _approach_history from DB records on server startup.

        Called once from run.py after the tracker is created but before the
        sweep thread starts.  Records must already be sorted newest-first
        (i.e. ORDER BY ts DESC from the DB query).  The on_approach_committed
        callback is intentionally NOT called here — these records are already
        in the DB.
        """
        with self._lock:
            self._approach_history = list(records[:APPROACH_HISTORY_MAX])
        log.info("Approach history: pre-loaded %d records from DB", len(records))

    def clear_approach_history(self) -> None:
        """Clear the approach history list (called by the web Clear button)."""
        with self._lock:
            self._approach_history.clear()

    def get_windrose_obs(self) -> list:
        """
        Thread-safe snapshot of the rolling windrose observation buffer.

        Returns a list of dicts, newest last, each with keys:
          ts   — Unix timestamp (float) of harvest time
          dir  — wind direction (°, integer)
          spd  — wind speed (kt, float)
          alt  — altitude at observation (ft, integer)

        Entries older than WINDROSE_BUFFER_MAX_SEC are pruned here as well as
        in prune_stale() so that stale data is removed even between landings.
        """
        cutoff = time.time() - WINDROSE_BUFFER_MAX_SEC
        with self._lock:
            while self._windrose_buffer and self._windrose_buffer[0]["ts"] < cutoff:
                self._windrose_buffer.pop(0)
            return list(self._windrose_buffer)
