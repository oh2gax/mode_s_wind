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

    # ── Radarcape JSON feed ───────────────────────────────────────────────
    # Provides MLAT positions (GPS-jamming immune) and pre-decoded MRAR
    # temperature / wind for aircraft the Radarcape has decoded directly.
    RADARCAPE_JSON_URL: str = "http://192.168.0.119/aircraftlist.json"
    RADARCAPE_JSON_INTERVAL: float = 5.0   # poll every N seconds

    # ── Sounding aggregation ──────────────────────────────────────────────
    SOUNDING_RADIUS_KM: float = 150.0   # use obs within this radius of receiver
    SOUNDING_WINDOW_MIN: int = 60       # aggregate over this many past minutes
