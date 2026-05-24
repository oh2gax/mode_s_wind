-- MODE-S Meteorological Database Schema
-- SQLite with WAL mode for safe SD-card operation

PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;

-- ── flights ───────────────────────────────────────────────────────────────
-- One row per continuous contact with an aircraft.
-- A gap > FLIGHT_GAP_SEC creates a new row even for the same ICAO.
CREATE TABLE IF NOT EXISTS flights (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    icao         TEXT    NOT NULL,
    callsign     TEXT,
    first_seen   REAL    NOT NULL,   -- Unix epoch (UTC)
    last_seen    REAL    NOT NULL,
    first_lat    REAL,
    first_lon    REAL,
    max_altitude INTEGER,            -- ft barometric, highest seen
    min_altitude INTEGER,            -- ft barometric, lowest seen
    obs_count    INTEGER DEFAULT 0,  -- total raw observations stored
    meteo_count  INTEGER DEFAULT 0   -- observations with any meteo data
);

CREATE INDEX IF NOT EXISTS idx_flights_icao      ON flights(icao);
CREATE INDEX IF NOT EXISTS idx_flights_last_seen ON flights(last_seen DESC);

-- ── observations ──────────────────────────────────────────────────────────
-- One row per decoded EHS message that carries useful data.
-- All meteo columns are nullable — not every message has every field.
CREATE TABLE IF NOT EXISTS observations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    flight_id   INTEGER REFERENCES flights(id),
    icao        TEXT    NOT NULL,
    ts          REAL    NOT NULL,    -- Unix epoch (UTC)

    -- Position (from ADS-B BDS 0,5)
    lat         REAL,
    lon         REAL,
    altitude    INTEGER,             -- ft barometric

    -- Motion (from ADS-B BDS 0,9 or BDS 5,0)
    groundspeed INTEGER,             -- kt
    track       REAL,                -- degrees true
    vert_rate   INTEGER,             -- ft/min

    -- BDS 4,4 MRAR — direct meteorological report from aircraft ─────────
    mrar_wind_spd   REAL,            -- kt
    mrar_wind_dir   REAL,            -- degrees FROM (meteorological convention)
    mrar_temp       REAL,            -- °C  static air temperature
    mrar_pressure   REAL,            -- hPa static pressure
    mrar_humidity   REAL,            -- %
    mrar_turbulence INTEGER,         -- 0=nil 1=light 2=moderate 3=severe
    mrar_fom        INTEGER,         -- Figure of Merit 0–4

    -- BDS 4,5 MHR — meteorological hazard report ──────────────────────
    mhr_temp        REAL,            -- °C
    mhr_pressure    REAL,            -- hPa
    mhr_turbulence  INTEGER,         -- 0–3
    mhr_wind_shear  INTEGER,         -- 0–3
    mhr_icing       INTEGER,         -- 0–3
    mhr_microburst  INTEGER,         -- 0–3
    mhr_radio_height INTEGER,        -- ft AGL (radio altimeter)

    -- Computed wind — derived from BDS 5,0 + BDS 6,0 pair ─────────────
    wind_spd        REAL,            -- kt
    wind_dir        REAL,            -- degrees FROM (meteorological convention)
    wind_qual       REAL,            -- quality score 0.0–1.0

    -- Raw BDS 5,0 inputs (stored for audit / re-processing)
    bds50_true_track    REAL,        -- degrees true
    bds50_groundspeed   INTEGER,     -- kt
    bds50_true_airspeed INTEGER,     -- kt
    bds50_roll          REAL,        -- degrees (positive = right bank)

    -- Raw BDS 6,0 inputs
    bds60_mag_heading   REAL,        -- degrees magnetic
    bds60_ias           INTEGER,     -- kt indicated airspeed
    bds60_mach          REAL,        -- dimensionless

    -- Best-available consolidated fields (for sounding queries) ────────
    best_wind_spd   REAL,            -- kt  (MRAR preferred, else computed)
    best_wind_dir   REAL,            -- degrees FROM
    best_temp       REAL,            -- °C  (MRAR preferred, else MHR)
    best_pressure   REAL,            -- hPa (MRAR preferred, else MHR)
    meteo_source    TEXT             -- 'MRAR' | 'MHR' | 'COMPUTED' | 'NONE'
);

CREATE INDEX IF NOT EXISTS idx_obs_icao_ts   ON observations(icao, ts);
CREATE INDEX IF NOT EXISTS idx_obs_ts        ON observations(ts DESC);
CREATE INDEX IF NOT EXISTS idx_obs_flight_id ON observations(flight_id);
CREATE INDEX IF NOT EXISTS idx_obs_altitude  ON observations(altitude)
    WHERE altitude IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_obs_meteo     ON observations(meteo_source, ts DESC)
    WHERE meteo_source != 'NONE';

-- ── gps_quality_hours ─────────────────────────────────────────────────────────
-- One row per completed UTC hour of GPS degradation monitoring.
-- Populated by GpsQualityTracker._flush_to_db() when an hour rolls over.
-- fl_bands is a JSON object mapping FL band labels to event counts.
-- Using INSERT OR REPLACE so restarts never create duplicate rows.
CREATE TABLE IF NOT EXISTS gps_quality_hours (
    ts              INTEGER PRIMARY KEY,   -- Unix epoch of hour start (UTC)
    events          INTEGER NOT NULL DEFAULT 0,   -- total event count this hour
    total           INTEGER NOT NULL DEFAULT 0,   -- unique aircraft seen this hour
    degraded        INTEGER NOT NULL DEFAULT 0,   -- unique aircraft with ≥1 event
    fl_bands        TEXT    NOT NULL DEFAULT '{}', -- JSON: {band_label: count}
    nacp_events     INTEGER NOT NULL DEFAULT 0,   -- events flagged by NACp signal
    freeze_events   INTEGER NOT NULL DEFAULT 0,   -- events flagged by Freeze signal
    gap_events      INTEGER NOT NULL DEFAULT 0    -- events flagged by Gap signal
);

CREATE INDEX IF NOT EXISTS idx_gps_hours_ts ON gps_quality_hours(ts DESC);
