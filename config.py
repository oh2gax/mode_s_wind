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

    # ── Receiver location ─────────────────────────────────────────────────
    # Approximate EFHK area — used for surface CPR reference and sounding radius
    RECEIVER_LAT: float = 60.317
    RECEIVER_LON: float = 24.963

    # ── Magnetic declination ───────────────────────────────────────────────
    # Finland 2025–2026: ~+8° East (increases by ~0.1°/year)
    # Used to convert magnetic heading → true heading for wind calculation.
    MAG_DECLINATION: float = 8.0

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
    STORAGE_MODE: str = "ALL"
