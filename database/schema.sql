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
    tas_source      TEXT,            -- TAS used for computed wind: 'BDS50' | 'MACH' | 'IAS'
    mag_decl        REAL,            -- magnetic declination used (°E; WMM at aircraft position)

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
    meteo_source    TEXT,            -- 'MRAR' | 'MHR' | 'COMPUTED' | 'NONE'
    -- Static air temperature from BDS 5,0 TAS + BDS 6,0 Mach (°C; from
    -- 2026-10-09, NULL before or when Mach < 0.2) — see collector/atmos.py.
    -- best_temp = MRAR > this (MHR temperatures not used since 2026-10-10).
    tm_temp         REAL,
    -- Heading calibration (from 2026-10-10, collector/heading_cal.py):
    -- offset subtracted from the true heading for best_wind_* (°; reported −
    -- true heading) and its source: A = own airframe value, T = aircraft-type
    -- median, F = fleet median, D = default, X = airframe excluded (no best
    -- wind); lower case = learn mode (not applied).  wind_spd / wind_dir stay
    -- the raw, uncorrected wind.
    hdg_off         REAL,
    hdg_src         TEXT
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
    nacp_events       INTEGER NOT NULL DEFAULT 0,   -- events flagged by NACp signal
    freeze_events     INTEGER NOT NULL DEFAULT 0,   -- events flagged by Freeze signal
    gap_events        INTEGER NOT NULL DEFAULT 0,   -- events flagged by Gap signal
    adsb_loss_events  INTEGER NOT NULL DEFAULT 0,   -- events flagged by ADS-B loss (MLAT covering for GPS dropout)
    method          INTEGER,                        -- counting-method version (see collector/gps_quality.py METHOD_VERSION)
    nic_events      INTEGER NOT NULL DEFAULT 0,     -- events flagged by the NIC (integrity) signal (method ≥ 4)
    band_detail     TEXT                            -- JSON per FL band: {"ac":{band:n},"deg":{band:n},"sig":{band:{signal:n}}} (from 2026-10-06; NULL before)
                                                    -- from 2026-10-09 also "sev"/"s0" (severity), "spf"/"spa"/"spl"
                                                    -- (spoofing indicators) and "t10" (10-minute slots);
                                                    -- see collector/gps_quality.py module docstring
);

CREATE INDEX IF NOT EXISTS idx_gps_hours_ts ON gps_quality_hours(ts DESC);

-- ── gps_quality_zone_hours ────────────────────────────────────────────────────
-- Distance-zone filtered variant of gps_quality_hours.
-- Same structure but PRIMARY KEY is (ts, zone) so multiple zones can share
-- the same timestamp.  Zones: '50nm' and '20nm' (radius from airport).
-- Only aircraft whose last-known position is within the zone radius are counted.
-- The 'all' zone continues to use gps_quality_hours (unchanged).
-- Data starts accumulating from first deployment; no backfill of historical data.
CREATE TABLE IF NOT EXISTS gps_quality_zone_hours (
    ts              INTEGER NOT NULL,         -- Unix epoch of hour start (UTC)
    zone            TEXT    NOT NULL,         -- '50nm' or '20nm'
    events          INTEGER NOT NULL DEFAULT 0,
    total           INTEGER NOT NULL DEFAULT 0,
    degraded        INTEGER NOT NULL DEFAULT 0,
    fl_bands        TEXT    NOT NULL DEFAULT '{}',
    nacp_events       INTEGER NOT NULL DEFAULT 0,
    freeze_events     INTEGER NOT NULL DEFAULT 0,
    gap_events        INTEGER NOT NULL DEFAULT 0,
    adsb_loss_events  INTEGER NOT NULL DEFAULT 0,   -- events flagged by ADS-B loss
    method          INTEGER,                        -- counting-method version
    nic_events      INTEGER NOT NULL DEFAULT 0,     -- events flagged by the NIC signal
    band_detail     TEXT,                           -- JSON per FL band (see gps_quality_hours)
    PRIMARY KEY (ts, zone)
);

CREATE INDEX IF NOT EXISTS idx_gps_zone_hours_ts ON gps_quality_zone_hours(ts DESC, zone);

-- ── approach_history ──────────────────────────────────────────────────────────
-- One row per completed landing approach.
-- Committed by WindshearTracker when an APPROACHING aircraft goes ADS-B-silent
-- (assumed landed).  bands_json is a JSON object keyed by altitude (ft as
-- string) with {"dir": int, "spd": float} values or null when no wind was
-- captured at that level.
-- Data volume: ~200–400 rows/day at EFHK; ~2 kB/row with all JSON columns
-- (from 2026-10-09), i.e. ~0.5 MB/day.  Never auto-purged.
CREATE TABLE IF NOT EXISTS approach_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            REAL    NOT NULL,    -- Unix epoch (UTC) of landing / stale-out
    date_utc      TEXT    NOT NULL,    -- "YYYY-MM-DD" for date-based queries
    time_utc      TEXT    NOT NULL,    -- "HH:MM"
    icao          TEXT    NOT NULL,
    callsign      TEXT,
    registration  TEXT,
    aircraft_type TEXT,
    runway        TEXT    NOT NULL,
    rwy_heading   INTEGER,
    bands_json    TEXT    NOT NULL,    -- JSON: {"200":{"dir":270,"spd":15},"400":null,…}  keys = ft MSL (see qnh_hpa)
    go_arounds    INTEGER NOT NULL DEFAULT 0, -- number of go-arounds before final landing
    qnh_hpa       REAL,                       -- METAR QNH used to convert bands to MSL (NULL = legacy rows: bands are pressure altitude)
    gnss_json     TEXT,                       -- GNSS quality on final per band + first-degraded / recovery points (from 2026-10-06; NULL before)
    rough_json    TEXT,                       -- approach roughness per segment (bank / track-rate / IAS / vertical-rate activity, crab) + METAR wind (from 2026-10-06; NULL before); "ap" autopilot state (from 2026-10-09)
    prof_json     TEXT                        -- per 200-ft band: averaged wind (n, SD), headwind component, Mach/TAS temperature (from 2026-10-09; NULL before)
);

CREATE INDEX IF NOT EXISTS idx_aphist_ts   ON approach_history(ts DESC);
CREATE INDEX IF NOT EXISTS idx_aphist_date ON approach_history(date_utc);
CREATE INDEX IF NOT EXISTS idx_aphist_rwy  ON approach_history(runway);

-- ── maintenance_config ────────────────────────────────────────────────────────
-- Key-value store for maintenance page settings (autopurge configuration).
-- Written by the maintenance API; read by the autopurge background thread.
CREATE TABLE IF NOT EXISTS maintenance_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- ── gps_quality_live ──────────────────────────────────────────────────────────
-- Checkpoint of the CURRENT (incomplete) hour bucket per zone, including the
-- sets of aircraft seen, written every 60 s so a restart does not lose the
-- hour in progress.  One row per zone ('all', '50nm', '20nm').
CREATE TABLE IF NOT EXISTS gps_quality_live (
    zone   TEXT    PRIMARY KEY,
    ts     INTEGER NOT NULL,        -- hour start (UTC epoch)
    data   TEXT    NOT NULL         -- JSON bucket incl. seen / degraded ICAO lists
);

-- ── gps_episodes ──────────────────────────────────────────────────────────────
-- Degradation episode log: one row per aircraft per continuous period of GPS
-- degradation (any of the five signals; clean gaps < 120 s merged), for
-- aircraft within 100 NM of the airport when the episode starts.
-- start_* = first degraded sweep, end_* = last degraded sweep,
-- rec_*   = first clean sweep afterwards (NULL if contact was lost first).
-- end_reason: 'recovered' | 'lost' | 'below_min_alt'.
-- Written in the 60-s checkpoint transaction; never auto-purged
-- (manual purge on the Maintenance page).  ~150 B/row, ~1 000–1 500 rows/day.
CREATE TABLE IF NOT EXISTS gps_episodes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    icao          TEXT    NOT NULL,
    callsign      TEXT,
    registration  TEXT,
    aircraft_type TEXT,
    t_start       REAL    NOT NULL,   -- Unix epoch (UTC), first degraded sweep
    t_end         REAL    NOT NULL,   -- last degraded sweep
    duration_s    INTEGER,
    sweeps        INTEGER,            -- degraded sweeps (5 s each)
    signals       TEXT,               -- e.g. "nacp,nic,adsb_loss"
    min_nacp      INTEGER,
    min_nic       INTEGER,
    min_alt       INTEGER,            -- ft pressure altitude during the episode
    max_alt       INTEGER,
    start_lat REAL, start_lon REAL, start_alt INTEGER, start_track INTEGER,
    start_vrate INTEGER, start_gs INTEGER, start_dist_nm REAL,
    end_lat REAL, end_lon REAL, end_alt INTEGER, end_track INTEGER,
    end_vrate INTEGER, end_gs INTEGER, end_dist_nm REAL,
    end_pos_age INTEGER,              -- s since the position last updated (any source)
    rec_lat REAL, rec_lon REAL, rec_alt INTEGER, rec_dist_nm REAL,
    end_reason    TEXT,
    method        INTEGER,            -- GPS counting-method version
    -- since 2026-10-09 (NULL in older rows):
    severe_sweeps INTEGER,            -- degraded sweeps with an unusable position
                                      -- (NACp 0, NIC 0 or no own ADS-B position)
    spoof         TEXT,               -- spoofing indicators seen while open, e.g.
                                      -- "mlat_dis,gmb_jump" (mlat_dis|gmb_sat|gmb_jump|pos_jump)
    max_mlat_nm   REAL,               -- largest own-ADS-B vs MLAT position distance flagged
    mlat_cmp      INTEGER,            -- sweeps where ADS-B and MLAT could be compared
    gmb_min       INTEGER,            -- GNSS − baro altitude difference range (ft, TC 19)
    gmb_max       INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gps_ep_key   ON gps_episodes(icao, t_start);
CREATE INDEX        IF NOT EXISTS idx_gps_ep_start ON gps_episodes(t_start);

-- ── profile_hours ─────────────────────────────────────────────────────────────
-- Hourly atmospheric profile archive (from 2026-10-09): one row per completed
-- UTC hour, the area profile of all aircraft within SOUNDING_RADIUS_KM of the
-- receiver — per altitude layer (1 000 ft to 10 000 ft, 2 000 ft to 46 000 ft)
-- the median Mach/TAS temperature (p10 / p90, n) and the vector-mean wind
-- (SD, n).  data = {"r": radius km, "n": observations used,
--                   "lv": [[alt_lo, temp, p10, p90, tn, wdir, wspd, wsd, wn], …]}
-- Computed from the observations at each hour change (read query + one
-- INSERT), so the profiles survive the observation autopurge.  ~1–2 kB/row,
-- 24 rows/day.  Never auto-purged.  Shown on the Sounding page (hourly archive).
CREATE TABLE IF NOT EXISTS profile_hours (
    ts    INTEGER PRIMARY KEY,   -- hour start (UTC epoch)
    data  TEXT    NOT NULL
);

-- ── approach_series ───────────────────────────────────────────────────────────
-- Raw Comm-B reply series on final for each landing (research data, from
-- 2026-10-09): the BDS 5,0 / 6,0 replies used for the approach-conditions
-- index plus the per-sweep position / altitude / autopilot state, so that
-- new methods can be applied to past landings.  data = zlib-compressed JSON
-- (see collector/windshear.py _series_blob).  Same ts / icao as the
-- approach_history row.  ~2–4 kB per landing; kept APPROACH_SERIES_DAYS
-- (default 90) days, purged daily.
CREATE TABLE IF NOT EXISTS approach_series (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      REAL    NOT NULL,
    icao    TEXT    NOT NULL,
    runway  TEXT,
    data    BLOB    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apser_ts ON approach_series(ts);

-- ── heading_cal ───────────────────────────────────────────────────────────────
-- Per-airframe heading offset learnt from the data (from 2026-10-10, see
-- collector/heading_cal.py).  s / w / n are the faded least-squares sums
-- (offset = −s/w in radians), t the time they were last faded to, flights the
-- completed flights with data.  One row per airframe (~1–2 thousand rows),
-- written once an hour for the airframes that changed; rows unseen for
-- 8 half-lives are deleted.
CREATE TABLE IF NOT EXISTS heading_cal (
    icao     TEXT PRIMARY KEY,
    typ      TEXT,              -- ICAO aircraft type (JSON feed / BaseStation.sqb)
    s        REAL NOT NULL,
    w        REAL NOT NULL,
    n        REAL NOT NULL,     -- faded sample count
    t        REAL NOT NULL,
    flights  INTEGER NOT NULL DEFAULT 0,
    last_ts  REAL,              -- last learning sample
    delta    REAL,              -- current offset (°), for convenience
    updated  REAL
);
