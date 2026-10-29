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
    hdg_src         TEXT,
    -- GNSS height (from 2026-10-19): the aircraft's GNSS − barometric altitude
    -- difference (ADS-B TC 19, ft, 25 ft steps; NULL when not fresh ≤ 5 s,
    -- not sent or saturated) and its NACp (NULL when not fresh ≤ 30 s).
    -- altitude + gmb_ft ≈ GNSS height of the pressure surface the aircraft
    -- flies on (for pressure-surface heights / D-values).
    gmb_ft          INTEGER,
    nacp            INTEGER
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
    prof_json     TEXT,                       -- per 200-ft band: averaged wind (n, SD), headwind component, Mach/TAS temperature (from 2026-10-09; NULL before)
    shear_json    TEXT,                       -- windshear report (detection v2, from 2026-10-24; back-filled from approach_series)
    edr_json      TEXT                        -- turbulence (EDR) of the landing (collector/edr.py, from 2026-10-29; back-filled from approach_series)
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

-- ── kinematics_hours ──────────────────────────────────────────────────────────
-- Hourly vorticity / divergence profile from plane fits of the aircraft winds
-- within KINEMATICS_RADIUS_KM (from 2026-10-20, collector/kinematics.py):
-- data = JSON {"r": radius km, "lv": [[alt_lo, vort, div, se_vort, se_div,
-- aircraft], …]} in 10⁻⁵ s⁻¹ (only layers with enough well-spread aircraft;
-- an hour without any has "lv": []).  ~0.5 kB per hour, kept indefinitely
-- (the observations it is computed from are purged after 30 days).
CREATE TABLE IF NOT EXISTS kinematics_hours (
    ts    INTEGER PRIMARY KEY,   -- hour start (UTC epoch)
    data  TEXT    NOT NULL
);

-- ── gnss_cal / gnss_hours ─────────────────────────────────────────────────────
-- Heights of the pressure surfaces from the GNSS − baro difference (from
-- 2026-10-21, collector/gnss_heights.py).
-- gnss_cal: key "sonde:YYYYMMDDHH" = aircraft − sonde residuals of one
-- Jokioinen sounding (JSON {"n": pairs, "c": [[icao, band, residual m,
-- replies], …]}, ~2–5 kB), key "current" = the fitted correction (fleet curve
-- per 5 000 ft band + per-airframe offsets).  Refitted after each sounding.
CREATE TABLE IF NOT EXISTS gnss_cal (
    key   TEXT PRIMARY KEY,
    ts    REAL,                  -- sounding launch / fit time
    data  TEXT NOT NULL
);
-- gnss_hours: raw hourly cells, zlib-compressed JSON (uncorrected, so a new
-- calibration applies to the past): {"d": [[layer bottom, icao, mean gmb ft, mean alt ft, replies]],
-- "tk": [[lo ft, hi ft, icao, z_lo m, z_hi m, mid time]]} — D-values per
-- layer and thickness temperatures of climbs / descents.  Written 4 h after
-- the hour; ~1–2 kB per hour; kept GNSS_HOURS_DAYS (default 0 = always).
CREATE TABLE IF NOT EXISTS gnss_hours (
    ts    INTEGER PRIMARY KEY,   -- hour start (UTC epoch)
    data  BLOB    NOT NULL
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

-- ── departure_series ──────────────────────────────────────────────────────────
-- Raw reply series of each climb-out (research data, from 2026-10-27): the
-- BDS 5,0 / 6,0 replies, the ADS-B velocity messages and the sweeps of the
-- climb, same format as approach_series ("sw" dthr = distance from the airport
-- NM); for the trial headwind ramps of the departures.  Same ts / icao as the
-- departure_profiles row.  ~1–3 kB per departure; kept APPROACH_SERIES_DAYS.
CREATE TABLE IF NOT EXISTS departure_series (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      REAL    NOT NULL,
    icao    TEXT    NOT NULL,
    runway  TEXT,
    data    BLOB    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_depser_ts ON departure_series(ts);

-- ── height_series ─────────────────────────────────────────────────────────────
-- Dense pressure-altitude / GNSS − baro series per aircraft visit (research
-- data, from 2026-10-20; collector/height_series.py): a row whenever the
-- ADS-B pressure altitude (TC 9–18) or the GNSS − baro difference (TC 19)
-- steps by 25 ft, NACp changes or the difference stops, plus a position
-- keyframe every 20 s.  data = zlib-compressed JSON (columns t, alt, gmb,
-- lat, lon, nacp; see height_series.decode).  ~2–4 kB per climb or descent;
-- kept HEIGHT_SERIES_DAYS (default 30) days, purged daily (archived first
-- when "Archive before purge" is on).
CREATE TABLE IF NOT EXISTS height_series (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        REAL    NOT NULL,   -- first row
    t_end     REAL    NOT NULL,   -- last row
    icao      TEXT    NOT NULL,
    callsign  TEXT,
    n         INTEGER NOT NULL,   -- rows
    n_gmb     INTEGER NOT NULL,   -- rows with a GNSS − baro value
    alt_min   INTEGER,            -- ft pressure altitude
    alt_max   INTEGER,
    data      BLOB    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hser_ts ON height_series(ts);

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

-- ── departure_profiles ────────────────────────────────────────────────────────
-- Climb-out profile of each departure from the airport (from 2026-10-11,
-- collector/departures.py): Mach/TAS temperature and wind per 200 ft band from
-- 200 to 3 000 ft MSL, built from every raw BDS 5,0 / 6,0 reply during the
-- climb (not throttled).  prof_json has the same format as
-- approach_history.prof_json: {"band_ft": {"n", "ws", "wd", "sd", "t", "tn"}}.
-- Together with the approach profiles it gives the airport low-level profile
-- (/api/lowlevel, Live Map Skew-T).  About 0.5–1 kB per departure; kept
-- DEPARTURE_PROFILE_DAYS (default 90) days, purged daily (archived first when
-- "Archive before purge" is on).
CREATE TABLE IF NOT EXISTS departure_profiles (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            REAL    NOT NULL,   -- time the climb reached the top band / was closed
    t_start       REAL,               -- first sample
    icao          TEXT    NOT NULL,
    callsign      TEXT,
    registration  TEXT,
    aircraft_type TEXT,
    qnh_hpa       REAL,               -- METAR QNH used for the MSL altitudes
    track         REAL,               -- initial climb track (°)
    lat           REAL,               -- first position
    lon           REAL,
    ga            INTEGER NOT NULL DEFAULT 0,   -- 1 = climb-out of a go-around
    prof_json     TEXT    NOT NULL,
    shear_json    TEXT,               -- windshear band comparison of the climb-out (from 2026-10-24)
    edr_json      TEXT                -- turbulence (EDR) of the climb-out (from 2026-10-29; from departure_series)
);
CREATE INDEX IF NOT EXISTS idx_depprof_ts ON departure_profiles(ts);

-- ── go_arounds ────────────────────────────────────────────────────────────────
-- One row per go-around detected by the windshear tracker (from 2026-10-25,
-- collector/windshear.py): the Windshear page's alert log shows those of the
-- last 24 h also after a restart, and it is a go-around history for the
-- windshear validation (ws = the highest windshear level active at that moment
-- for the aircraft or its runway).  A few rows a day, about 0.1 kB each; never
-- auto-purged (with approach_history in the Maintenance purges and Clear).
CREATE TABLE IF NOT EXISTS go_arounds (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            REAL    NOT NULL,   -- time the go-around was confirmed
    icao          TEXT    NOT NULL,
    callsign      TEXT,
    aircraft_type TEXT,
    runway        TEXT,
    alt_ft        INTEGER,            -- altitude when confirmed (ft)
    count         INTEGER,            -- go-around number of this flight (1, 2, …)
    low           INTEGER NOT NULL DEFAULT 0,   -- 1 = climb-out at / after the threshold
    ws            TEXT                -- none / adv / wsa / mba active at that moment
);
CREATE INDEX IF NOT EXISTS idx_go_arounds_ts ON go_arounds(ts);

-- ── msg_stats_hours / msg_stats_state ────────────────────────────────────────
-- Statistics page history kept over restarts (from 2026-10-25,
-- collector/msg_stats.py): one row per closed clock hour (zlib-compressed JSON:
-- counters, histograms, aircraft sets, signal and range data, and the hour's
-- per-minute chart series; about 10–50 kB), kept MSG_STATS_DAYS (default 7)
-- days; and one 'state' row written at a clean stop (the hour in progress, the
-- minute records, the 24 h and 10-s series), read back and deleted at the start.
CREATE TABLE IF NOT EXISTS msg_stats_hours (
    ts    INTEGER PRIMARY KEY,   -- clock hour (UTC, Unix s)
    data  BLOB    NOT NULL
);
CREATE TABLE IF NOT EXISTS msg_stats_state (
    k     TEXT PRIMARY KEY,      -- 'state'
    saved REAL NOT NULL,         -- time of the save
    data  BLOB NOT NULL
);

-- ── sonde_verification ───────────────────────────────────────────────────────
-- Mode S area profile vs the radiosonde (collector/sonde_verif.py, written by
-- the hourly jobs thread): kind 'launch' = area profile of ±1 h around a
-- sounding's launch minus the sounding; kind 'hour' = each archived hourly
-- profile minus the newest sounding launched by then (age_h = hour middle −
-- launch).  Per row the layer counts, temperature bias / RMS (K), wind vector
-- RMS and speed bias (kt) and the same per altitude band (bands JSON).
CREATE TABLE IF NOT EXISTS sonde_verification (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    kind      TEXT    NOT NULL,      -- 'launch' | 'hour'
    ts        INTEGER NOT NULL,      -- launch time (launch) / hour start (hour)
    sonde_key TEXT    NOT NULL,      -- YYYYMMDDHH of the sounding
    age_h     REAL,                  -- profile middle − launch (h)
    min_p     REAL,                  -- top of the sounding (hPa)
    aircraft  INTEGER,               -- distinct aircraft behind the area profile
    obs       INTEGER,               -- observations used
    n_t       INTEGER, t_bias REAL, t_rms REAL,
    n_w       INTEGER, w_rms  REAL, ws_bias REAL,
    bands     TEXT,                  -- {"0-5k": {n_t, t_bias, t_rms, n_w, w_rms, ws_bias}, …}
    UNIQUE(kind, ts)
);
CREATE INDEX IF NOT EXISTS idx_sondever_ts ON sonde_verification(ts);

-- ── t_correction ─────────────────────────────────────────────────────────────
-- Upper-level temperature correction learnt every hour from the MEPS model
-- (collector/tcorr.py, from 2026-10-24): data = {"ts", "days", "src", "n":
-- {hPa: hours}, "bias": {hPa: Mode S − MEPS K}, "corr": {hPa: K added at
-- 400–200 hPa}}.  Applied when the Skew-T and time–height are served; the
-- stored profiles stay raw.  Kept 90 days (created by the module if missing).
CREATE TABLE IF NOT EXISTS t_correction (
    ts   INTEGER PRIMARY KEY,
    data TEXT    NOT NULL
);

-- ── metar_reports ────────────────────────────────────────────────────────────
-- Every METAR of the airport, stored once (collector/wx_reports.py, from
-- 2026-10-29): the live METARs of the WX poll thread (src 'live', NOAA) and the
-- history loaded with tools/load_metar_history.py (src 'iem', Iowa Environmental
-- Mesonet).  Full text plus the parsed values; ws = the windshear group of a
-- manual METAR ("R22L", "R22L R22R" or "ALL"; NULL = none).  Never purged
-- (about 17 500 rows a year).
CREATE TABLE IF NOT EXISTS metar_reports (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    station  TEXT    NOT NULL,
    ts       INTEGER NOT NULL,              -- observation time (UTC, Unix s)
    kind     TEXT    NOT NULL DEFAULT 'METAR',   -- METAR | SPECI
    cor      INTEGER NOT NULL DEFAULT 0,    -- 1 = corrected (COR)
    auto     INTEGER NOT NULL DEFAULT 0,    -- 1 = AUTO METAR
    raw      TEXT    NOT NULL,
    src      TEXT,                          -- live | iem
    fetched  REAL,                          -- when stored
    wdir     INTEGER, wspd INTEGER, wgst INTEGER,   -- wind ° / kt / gust kt (dir NULL = VRB)
    wvar     TEXT,                          -- "200V260"
    vis      INTEGER,                       -- m (9999 = 10 km or more)
    wx       TEXT,                          -- present weather groups ("-SHRA BR")
    cld      TEXT,                          -- lowest cloud group / CAVOK / NSC …
    tt       REAL, td REAL,                 -- °C
    qnh      REAL,                          -- hPa
    ws       TEXT,                          -- windshear group
    UNIQUE(station, ts, cor)
);
CREATE INDEX IF NOT EXISTS idx_metar_reports_ws ON metar_reports(ws) WHERE ws IS NOT NULL;

-- ── pilot_reports ────────────────────────────────────────────────────────────
-- ARS, WXREP and SIGMET messages of the FMI aviation weather page ilmailusaa.fi
-- (collector/wx_reports.py, polled every PILOT_REPORTS_INTERVAL_MIN, from
-- 2026-10-29), each stored once with the parsed kind, callsign / aircraft type,
-- phenomena, position, heights and near = 1 for reports within
-- PILOT_REPORTS_NEAR_NM of the airport (or naming it) at or below 10 000 ft.
-- Never purged (a few rows a day).
CREATE TABLE IF NOT EXISTS pilot_reports (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       INTEGER NOT NULL,              -- message time (UTC, Unix s)
    obs_ts   INTEGER,                       -- observed at (OBS AT / REP hhmm), if given
    kind     TEXT    NOT NULL,              -- ARS | WXREP | SIGMET | AIRMET | AIREP | OTHER
    raw      TEXT    NOT NULL,
    src      TEXT    NOT NULL,              -- ilmailusaa
    fetched  REAL,
    ident    TEXT,                          -- callsign (ARS) / aircraft type (WXREP)
    phen     TEXT,                          -- "MOD ICE", "FBL TURB, INV" …
    place    TEXT,                          -- WXREP place text ("S OF EFTP")
    lat      REAL, lon REAL,                -- reported position (ARS)
    lo_ft    INTEGER, hi_ft INTEGER,        -- height range (ft; FL × 100)
    near     INTEGER NOT NULL DEFAULT 0,
    UNIQUE(src, ts, raw)
);
CREATE INDEX IF NOT EXISTS idx_pilot_reports_ts ON pilot_reports(ts);

-- ── bl_hours ─────────────────────────────────────────────────────────────────
-- The boundary layer at the airport per UTC hour (collector/boundary.py, from
-- 2026-10-29; hourly jobs thread, back-filled at the first start): data = JSON
-- {"w": [[ft MSL, kt, dir, n]] wind 250–5000 ft, "t": [[ft MSL, °C, flights]]
-- low-level temperatures 400–3000 ft, "tt" / "q" METAR temperature / QNH,
-- "llj" low-level jet {ft, kt, dir, drop, sh} or null, "inv" surface inversion
-- {dT, top} or null}.  About 1–1.5 kB a row; never purged.
CREATE TABLE IF NOT EXISTS bl_hours (
    ts   INTEGER PRIMARY KEY,   -- hour start (UTC, Unix s)
    data TEXT    NOT NULL
);
