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

import math
import threading
import time
import logging

from collector.filter import is_blocked_registration

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

# ── Go-around detection defaults ──────────────────────────────────────────────
GA_MIN_DESCENT_POLLS = 5       # sweeps descending before 'APPROACHING' is set
GA_MIN_CLIMB_POLLS   = 3       # consecutive sweeps climbing before GO-AROUND fires
GA_MIN_ALT_GAIN_FT   = 50.0   # minimum actual altitude gain (ft) required to confirm
GA_CLIMB_FPM         = 600.0   # ft/min climb rate that triggers detection
GA_MAX_ALT_FT        = 2_200.0 # altitude ceiling for detection
GA_FLASH_SEC         = 60.0    # seconds to keep the GO-AROUND flag active
GA_EVENTS_MAX        = 20      # maximum go-around events retained in RAM

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
    {"name": "33",  "heading": 323, "thr_lat": 60.3071, "thr_lon": 24.9883, "thr_elevation_ft": 148},
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


def gs_status(
    altitude_ft: float,
    dist_thr_nm: float,
    thr_elevation_ft: float = 0.0,
) -> str:
    """
    Return 'ON', 'HIGH', 'LOW', or 'FAR' for the aircraft's position relative
    to the 3° glideslope.  'FAR' is returned when the aircraft is more than
    20 NM from the threshold (glideslope interception not yet expected).

    thr_elevation_ft: threshold elevation above MSL (ft).  MODE-S altitude is
    a pressure altitude, which at low altitudes approximates true altitude
    closely enough for strip status purposes; the QNH fine-correction is
    applied only in the JS ILS profile canvas where live QNH is available.
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
        self.blocked_reg_prefixes = blocked_reg_prefixes

        self._state: dict[str, dict]  = {}   # icao → approach record
        self._ga_counts: dict[str, int] = {}  # icao → session go-around count (persists after prune)
        self._ga_events: list[dict]   = []    # recent go-around events for the API/log
        self._lock  = threading.RLock()

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
                if _hdg_diff(track, rwy["heading"]) > self.max_track_dev:
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
            return

        now = time.time()

        # ── Distance and altitude gates ───────────────────────────────────────
        dist_apt = _haversine_nm(self.airport_lat, self.airport_lon, lat, lon)
        if dist_apt > self.max_dist_nm or alt > self.max_alt_ft:
            with self._lock:
                self._state.pop(icao, None)
            return

        # ── ILS corridor detection ────────────────────────────────────────────
        track  = aircraft.get("track")
        runway, dist_thr, cross_track, along_track = self._best_runway(lat, lon, track)
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
        gs_stat     = gs_status(alt, dist_thr, rwy_thr_elev) if in_corridor else "FAR"

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

            if in_corridor:
                history.append({
                    "ts":       now,
                    "lat":      lat,
                    "lon":      lon,
                    "altitude": alt,
                    "dist_thr": round(dist_thr, 2),
                })

            # ── Go-around state machine ───────────────────────────────────────
            # Carry forward per-aircraft state from the previous sweep.
            ga_phase           = prev.get("ga_phase", "NONE")
            ga_descent_polls   = prev.get("ga_descent_polls", 0)
            ga_climb_polls     = prev.get("ga_climb_polls", 0)
            ga_climb_start_alt = prev.get("ga_climb_start_alt", None)
            ga_flash_until     = prev.get("ga_flash_until", 0.0)

            if in_corridor:
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
                # GO_AROUND: stays until aircraft leaves the display entirely
                # (removed by prune_stale or altitude gate); resets on return.
            else:
                # Left the corridor — reset APPROACHING; GO_AROUND persists
                # so the flash continues during the climb-out phase.
                if ga_phase == "APPROACHING":
                    ga_phase           = "NONE"
                    ga_descent_polls   = 0
                    ga_climb_polls     = 0
                    ga_climb_start_alt = None

            ga_count  = self._ga_counts.get(icao, 0)
            is_return = ga_count > 0 and ga_phase != "GO_AROUND"

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
                "meteo_source":   aircraft.get("meteo_source", "NONE"),
                "in_corridor":    in_corridor,
                "approach_runway":runway,
                "dist_apt_nm":    round(dist_apt, 1),
                "dist_thr_nm":    round(dist_thr, 2) if in_corridor else None,
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
                "ga_descent_polls":   ga_descent_polls,
                "ga_climb_polls":     ga_climb_polls,
                "ga_climb_start_alt": ga_climb_start_alt,
                "ga_flash_until":     ga_flash_until,
                "ga_flash":         ga_flash_until > now,
                "ga_count":         ga_count,
                "is_return":        is_return,
            }

    def prune_stale(self) -> None:
        """Remove aircraft not updated within STALE_TIMEOUT_SEC."""
        cutoff = time.time() - STALE_TIMEOUT_SEC
        with self._lock:
            stale = [k for k, v in self._state.items() if v["last_seen"] < cutoff]
            for k in stale:
                del self._state[k]
                log.debug("Windshear: dropped stale %s", k)

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
