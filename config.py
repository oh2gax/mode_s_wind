"""
Central configuration for the MODE-S Meteo system.
Edit this file before starting; all other modules import from here.
"""

import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


class Config:
    # ── Radarcape connection ───────────────────────────────────────────────
    RADARCAPE_HOST: str = "192.168.0.119"
    RADARCAPE_PORT: int = 10003

    # ── Web interface ──────────────────────────────────────────────────────
    WEB_HOST: str = "0.0.0.0"
    WEB_PORT: int = 5010
    WEB_USER: str = "admin"
    WEB_PASS: str = "admin123"

    # ── Database ───────────────────────────────────────────────────────────
    # On RPi with SD-card only: keep DB in project folder.
    # Recommend moving to USB SSD later: /mnt/usb/modes_meteo.db
    DB_PATH: str = os.path.join(BASE_DIR, "data", "modes_meteo.db")

    # ── ICAO24 blocklist ─────────────────────────────────────────────────
    # Prefixes of ICAO24 addresses that should be silently dropped system-wide
    # before entering live_state.  Add additional prefixes as needed.
    # T40xxx — Finnish Air Navigation Services WAM (Wide Area Multilateration)
    # ground interrogator stations; they produce Mode-S signals but are fixed
    # infrastructure, not aircraft, and pollute GPS quality and traffic counts.
    BLOCKED_ICAO_PREFIXES: tuple = ("T40",)

    # ── Registration blocklist ────────────────────────────────────────────
    # Prefixes of aircraft registrations that should be silently dropped
    # system-wide before entering live_state.  Add additional prefixes as
    # needed.
    # OH-H — Finnish helicopters; their continuous manoeuvring near the
    # airport (especially close to RWY 33) produces unreliable BDS 5,0/6,0
    # computed wind and false meteo observations unsuitable for any analysis.
    BLOCKED_REG_PREFIXES: tuple = ("OH-H",)

    # ── Receiver location ─────────────────────────────────────────────────
    # Approximate EFHK area — used for surface CPR reference and sounding radius
    RECEIVER_LAT: float = 60.317
    RECEIVER_LON: float = 24.963

    # ── Magnetic declination ───────────────────────────────────────────────
    # EFHK (Helsinki-Vantaa) WMM value: ~+10.5°E as of 2026-01.
    # Re-check every 2–3 years; current rate of change ~+0.1°/year.
    # Used to convert magnetic heading → true heading for wind calculation.
    MAG_DECLINATION: float = 10.5

    # ── Wind calculation quality gates ────────────────────────────────────
    # Max roll angle (°) for wind calculation to be considered valid
    WIND_MAX_ROLL_DEG: float = 5.0
    # Max track rate (°/s) — aircraft must be flying straight
    WIND_MAX_TRACK_RATE: float = 1.0
    # Max time gap (s) between BDS 5,0 and BDS 6,0 readings for pairing
    WIND_MAX_PAIR_AGE: float = 10.0
    # Sanity range for computed wind speed
    WIND_MAX_SPEED_KT: float = 150.0

    # ── MRAR quality gate ─────────────────────────────────────────────────
    # Minimum Figure of Merit accepted (0–4).  0 = unreliable, 4 = excellent.
    MRAR_MIN_FOM: int = 1

    # ── Collector ─────────────────────────────────────────────────────────
    # How often to flush the in-memory buffer to SQLite (seconds)
    DB_WRITE_INTERVAL: float = 5.0
    # Gap (seconds) between two contacts with same ICAO that starts a new flight
    FLIGHT_GAP_SEC: float = 1800.0   # 30 minutes
    # Minimum gap (seconds) between successive DB writes for the same aircraft.
    # Prevents storing dozens of near-identical rows for a cruising aircraft.
    # 30 s is a good balance: enough resolution for sounding profiles while
    # cutting write volume by ~80-90 % compared to storing every observation.
    # Set to 0 to disable throttling (store every qualifying observation).
    WRITE_MIN_INTERVAL_SEC: float = 30.0

    # ── Radarcape JSON feed ───────────────────────────────────────────────
    # Provides MLAT positions (GPS-jamming immune) and pre-decoded MRAR
    # temperature / wind for aircraft the Radarcape has decoded directly.
    RADARCAPE_JSON_URL: str = "http://192.168.0.119/aircraftlist.json"
    RADARCAPE_JSON_INTERVAL: float = 5.0   # poll every N seconds

    # ── Sounding aggregation ──────────────────────────────────────────────
    SOUNDING_RADIUS_KM: float = 150.0   # use obs within this radius of receiver
    SOUNDING_WINDOW_MIN: int = 60       # aggregate over this many past minutes

    # ── Meteo source mode ─────────────────────────────────────────────────
    # Controls which source provides meteorological values in live_state.
    #   "EHS"    — use only BDS-decoded data from Beast TCP feed
    #              (MRAR / MHR / COMPUTED); JSON feed provides MLAT positions
    #              only and never injects meteo values.
    #   "JSON"   — Radarcape JSON meteo values are primary; they overwrite
    #              any EHS value for the same aircraft every poll cycle.
    #   "HYBRID" — EHS has priority; JSON meteo fills in only when EHS has
    #              not yet produced a value for that aircraft. (default)
    METEO_SOURCE_MODE: str = "HYBRID"

    # ── Airport ICAO ──────────────────────────────────────────────────────
    # Used to fetch METAR and TAF for the live map bottom panel.
    AIRPORT_ICAO: str = "EFHK"

    # ── Storage mode ──────────────────────────────────────────────────────
    # Controls which observations are written to the SQLite database.
    #   "ALL"        — store every decoded observation (positions + meteo)
    #   "METEO_ONLY" — store only observations that carry meteo data;
    #                  significantly reduces DB size and SD-card wear.
    STORAGE_MODE: str = "METEO_ONLY"

    # ── Windshear / Approach monitoring ───────────────────────────────────────
    # Airport reference point used for approach-range filtering and the 30 NM
    # range circle displayed on the Windshear map.  Set to your monitoring
    # airport; coordinates below are EFHK (Helsinki-Vantaa).
    WINDSHEAR_AIRPORT_LAT: float = 60.3172
    WINDSHEAR_AIRPORT_LON: float = 24.9634
    # Maximum distance from the airport (NM) for an aircraft to be considered
    # on approach and shown on the Windshear page.
    WINDSHEAR_RADIUS_NM: float = 15.0
    # Maximum altitude (ft) for approach monitoring.  Aircraft above this
    # value are ignored by the windshear tracker even if they are close.
    WINDSHEAR_MAX_ALT_FT: float = 5000.0
    # ILS corridor half-width (NM) measured perpendicular to the centreline.
    # Aircraft must be within this distance either side of the extended ILS
    # centreline to be matched to a runway.  Departures and overflights are
    # also rejected by the positive along-track gate.
    # Once established on a localizer, aircraft are typically within ±0.3 NM;
    # 1.5 NM allows for late vector intercepts while filtering non-approach traffic.
    WINDSHEAR_CORRIDOR_HALF_WIDTH_NM: float = 1.5
    # Maximum along-track distance (NM) from the threshold for a corridor
    # match.  Aircraft further out are shown on the map only (not in strips).
    WINDSHEAR_MAX_ILS_NM: float = 25.0
    # Threshold elevation (ft MSL) — fallback used when a runway definition
    # does not carry its own thr_elevation_ft value.  In practice each runway
    # in EFHK_RUNWAYS now has an explicit value, so this setting is only
    # relevant if you supply a custom runway list without the field.
    WINDSHEAR_THR_ELEVATION_FT: float = 179.0
    # Manual glideslope offset (ft) for calibration.  Positive shifts the GS
    # line up (aircraft appear lower relative to it); negative shifts it down.
    # Adjust this if aircraft that you know are on GS still read consistently
    # high or low after the threshold-elevation and QNH corrections are applied.
    WINDSHEAR_GS_OFFSET_FT: float = 0.0
    # Maximum allowed deviation (°) between the aircraft's ADS-B ground track
    # and the runway's approach heading for the aircraft to be accepted into an
    # ILS corridor.  Departures on a parallel runway fly the reciprocal heading
    # (~180° off) and are rejected by this gate.  Applies only when track data
    # is available; aircraft without a current track report are accepted on
    # geometry alone (same behaviour as before this check was added).
    # 60° is a generous tolerance that accepts all legitimate approach aircraft
    # (including those still rolling out of a late vector intercept) while
    # reliably rejecting parallel-runway departures.
    WINDSHEAR_MAX_TRACK_DEV_DEG: float = 60.0
    # ── Go-around detection ───────────────────────────────────────────────────
    # Minimum consecutive 3-second sweep cycles with vert_rate ≤ -200 ft/min
    # inside the corridor before an aircraft is considered "established on
    # approach".  5 cycles = 15 s — prevents brief corridor transits from
    # arming the detector.
    WINDSHEAR_GA_MIN_DESCENT_POLLS: int   = 8
    # Consecutive 3-second sweep cycles with vert_rate ≥ GA_CLIMB_FPM required
    # before a go-around event is fired.  Prevents a single gust-induced
    # vert_rate spike from triggering a false detection in turbulent conditions.
    # 3 cycles = 9 s of sustained climb (aircraft climbs ≥ 90 ft at 600 fpm).
    WINDSHEAR_GA_MIN_CLIMB_POLLS: int     = 3
    # Minimum actual altitude gain (ft) measured from climb onset to confirmation.
    # Works alongside GA_MIN_CLIMB_POLLS as a second AND condition — the aircraft
    # must have gained at least this much real altitude during the climbing polls,
    # guarding against barometric lag or vert_rate quantization producing a high
    # reported rate without meaningful actual altitude change.
    WINDSHEAR_GA_MIN_ALT_GAIN_FT: float  = 50.0
    # Climb rate (ft/min) required — while still below GA_MAX_ALT_FT — to
    # classify the transition as a go-around rather than a glideslope correction.
    WINDSHEAR_GA_CLIMB_FPM: float         = 600.0
    # Altitude ceiling (ft) for go-around detection.  Above this height the
    # aircraft may be flying a missed-approach procedure that started earlier
    # and false positives become more likely.
    WINDSHEAR_GA_MAX_ALT_FT: float        = 2200.0
    # Seconds the GO-AROUND flash label stays visible on the flight strip.
    # The aircraft typically climbs above the 5 000 ft gate and leaves the
    # display within this window.
    WINDSHEAR_GA_FLASH_SEC: float         = 60.0

    # ── GPS Quality monitoring ─────────────────────────────────────────────────
    # NACp (Navigation Accuracy Category for Position) threshold.
    # Observations at or below this value are flagged as degraded GPS quality.
    # NACp scale: 0 = unknown, 1–3 = poor, 4–6 = moderate, 7–11 = excellent.
    # NACp ≤ 6 corresponds to horizontal accuracy worse than ~0.1 NM (185 m).
    GPS_NACP_THRESHOLD: int = 6
    # Consecutive sweep polls with the same lat/lon (while groundspeed is above
    # GPS_MIN_GS_KT) before an aircraft is flagged as having a frozen position.
    # 3 polls × 5 s sweep interval ≈ 15 s of frozen position.
    GPS_FREEZE_POLLS: int = 3
    # Seconds since last received ADS-B position message before an aircraft
    # is flagged as a GPS gap (EHS data still arriving, position lost).
    GPS_GAP_SEC: float = 45.0
    # Minimum groundspeed (kt) for position freeze detection.
    # Below this speed the aircraft may be taxiing or holding — position
    # stability is expected and should not be flagged.
    GPS_MIN_GS_KT: float = 50.0
    # Minimum altitude (ft, pressure altitude) for GPS degradation signal checks.
    # Aircraft below this altitude are counted as "seen" but are not checked for
    # NACp / Freeze / Gap signals.  This prevents false Freeze events when the
    # receiver loses line-of-sight with a landing aircraft at ~300–400 ft and the
    # last-known groundspeed (still ~140 kt) + frozen lat/lon would otherwise
    # trigger the freeze detector for up to 60 seconds after last reception.
    GPS_MIN_ALT_FT: float = 1000.0
    # Sweep interval (seconds) for the GPS quality background thread.
    GPS_SWEEP_SEC: float = 5.0

    # ── Maintenance page ───────────────────────────────────────────────────
    # Path to the maintenance authentication file.
    # File format: a single line  username:password
    # Keep this file outside the project directory and out of version control.
    # Example: /home/rspi22/mode_s_wind/dbauth.txt
    MAINTENANCE_AUTH_FILE: str = ""
