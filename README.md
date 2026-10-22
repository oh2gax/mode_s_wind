# MODE-S Wind

A Python-based system for collecting, decoding and visualising real-time meteorological data from aircraft using **MODE-S Enhanced Surveillance (EHS)** and **ADS-B** messages received by a [Jetvision Radarcape](https://www.jetvision.de/radarcape/) receiver.

Two complementary methods are used to extract meteorological data from aircraft transponder traffic. The primary method is direct decoding of **BDS 4,4 Meteorological Routine Air Report (MRAR)** messages, which carry onboard sensor readings for wind speed, wind direction, static air temperature, and humidity — but MRAR is optional equipment and relatively few aircraft in commercial service transmit it. The majority of observations are therefore derived indirectly from **MODE-S Enhanced Surveillance (EHS)** data: wind speed and direction are computed from the aircraft's air vector — magnetic heading (BDS 6,0, converted to true heading with the World Magnetic Model declination at the aircraft's position) and true airspeed (BDS 5,0, or derived from Mach / IAS in BDS 6,0) — and its ground vector (true track and groundspeed from BDS 5,0). These EHS-derived values are physically equivalent to sensor readings but are calculated rather than measured directly. The system handles both methods transparently, preferring direct MRAR data when available and falling back to EHS computation otherwise.

All decoded observations are stored in a local SQLite database and presented through a web dashboard with a live map, historical flight browser, Skew-T atmospheric sounding diagrams, a gridded historical wind map, an approach / windshear monitor with per-landing approach history and approach-conditions index, and GPS-interference monitoring (hourly GPS Quality statistics and individual GPS degradation episodes).

> **⚠ Note for test users:** GPS jamming is very common in the whole EFHK and Gulf of Finland area. Aircraft affected by it may broadcast degraded or no GPS-derived (ADS-B) positions, at times down to low altitudes on approach and departure, so position data should be interpreted with caution. The extent of the interference varies from day to day and over the day; it is monitored on the [GPS Quality](#gps-quality--gps) and [GPS Episodes](#gps-episodes--gps-episodes) pages (see also [GPS Jamming Note](#gps-jamming-note)).

![MODE-S Wind main screen](doc/Mode_S_Wind_Main_Screen_1.png)

> **Display note:** the web interface is optimised for **1920 × 1080** desktop resolution. On mobile phones the layout will adapt but the experience is limited. On tablets, horizontal (landscape) orientation gives significantly better results — an iPad in landscape mode works reasonably well.

---

## Features

- **Real-time live map** — ATC-style aircraft display with 1-minute position trails, colour-coded by meteo data source, with optional callsign or ICAO24 labels
- **Meteo data sources** decoded simultaneously:
  - BDS 4,4 MRAR — Meteorological Routine Air Report (direct temp, pressure, humidity, wind, turbulence from aircraft avionics)
  - BDS 4,5 MHR — Meteorological Hazard Report (icing, wind shear, microburst, turbulence levels; rare and often unreliable at EFHK, its temperature is not used — see [Data source priority](#data-source-priority))
  - BDS 5,0 + 6,0 computed wind — wind vector derived from true track, ground speed, magnetic heading and airspeed
  - BDS 5,0 + 6,0 **air temperature** — static air temperature from the true airspeed and the Mach number (available for about 85 % of the observations, see [Air temperature](#air-temperature-bds-50--60))
- **MLAT position support** — polls the Radarcape's JSON feed for multilateration-derived positions that remain accurate even when GPS jamming suppresses ADS-B position broadcasts
- **Skew-T atmospheric soundings** — area profile of all aircraft over the last 30 min – 3 h, an hourly profile archive kept indefinitely, and per-flight vertical profiles for climbing/descending flights (Sounding page, or directly from the Flights browser); the Jokioinen radiosonde (FMI open data) and the **MEPS** weather model (MET Norway open data) can be drawn for comparison, every sounding is verified against the area profile automatically (**Sonde check**) and every hour is compared with the model (**MEPS check**); an **Indices** panel gives the stability indices and characteristic levels (CAPE, Lifted Index, LCL, freezing level, tropopause, lapse rates, wind shear …) of the shown profile next to those of the sonde
- **Mini atmosphere profile panel** — always-visible Skew-T profile in the live map sidebar; clicking any aircraft immediately loads its full historical wind and temperature profile from the database, then continues accumulating live updates on top. Profile persists across page navigation — navigating away and back restores the full picture instantly.
- **Historical flight browser** — searchable and paginated table of all recorded flights with meteo statistics, time-series charts, and a flight track map
- **Light / Dark theme toggle** — a **Dark / Light** button in the navbar switches all pages between the default dark theme and a blue-grey paper-toned light theme; preference is stored in `localStorage` and applied before first paint so there is no flash on page load; all canvas renderers (Skew-T diagrams, ILS profile, Wind Rose) redraw instantly with the new palette
- **Persistent UI preferences** — all toggles (Meteo only, Labels, label mode, aircraft list order, wind history density, theme) are remembered across browser sessions via localStorage
- **Configurable meteo source mode** — choose between EHS-only (pyModeS Beast decoding), JSON-only (Radarcape's own decoded values), or Hybrid priority; active mode shown as a read-only badge in the navbar on every page
- **Configurable storage mode** — store all observations or meteo-only to drastically reduce database size and SD-card write load; active mode shown in the navbar badge alongside source mode
- **Per-aircraft write throttle** — configurable minimum interval between successive database writes for the same aircraft, dramatically reducing write volume without meaningfully affecting sounding data quality
- **Gridded wind and temperature map** — select a flight level, altitude tolerance, time window (preset or custom historical range) and cell size (25 / 50 / 100 km square cells); per-aircraft-averaged wind barbs at each populated cell, colour-coded by wind speed, faded by the number of aircraft behind them, optional ΔT colouring (temperature difference from the layer mean: air masses and fronts), isotachs and streamlines from a smoothed field, the Jokioinen radiosonde at the level, the change since the previous period or the thermal wind to another level (warm / cold advection per cell), and a time slider / animation over the last 24 hours; frozen and spoofed positions removed
- **QNH pressure-altitude correction** — for wind map layers below FL050, the query band is automatically shifted into pressure-altitude space using the METAR QNH of the period so that observations are binned to the correct MSL altitude. Raw pressure altitudes are kept intact in the database; correction is applied at query time only
- **Windshear approach monitoring page** — ATC-style real-time display of all aircraft established on ILS or RNP approach (RWY 04L, 04R, 22L, 22R, 15, 33), with flight strips, an ILS/RNP glideslope vertical profile canvas, six selectable windshear detection algorithms, a go-around detector, a wind rose (with an approach-conditions chart view) and a persistent **Approach History** of every landing — wind per 200 ft band, GNSS quality on final, and a provisional **Approach Conditions Index (ACI)** (roughness) from the aircraft's own bank-angle, airspeed and vertical-rate activity; see [Windshear](#windshear--windshear) below
- **GPS Quality monitoring page** — area-wide real-time and historical GPS degradation monitor covering all tracked aircraft at all altitudes; detects self-reported degradation (NACp accuracy and NIC integrity), position freeze, position gap and ADS-B position loss (MLAT covering a GPS dropout); renders a stacked bar chart (NACp / NIC / Freeze / Gap / ADS-B signal breakdown, with a `1d`–`6m` range selector), a 9-FL-band heatmap with its own `14d` / `1m` day-range selector, an `Events` / `% aircraft` mode, hover details and click-through to the GPS Episodes page, a FL band distribution doughnut chart with a summary stats panel over the same window, and a **distance zone selector** (All / 50 nm / 20 nm) that filters all views to aircraft within a chosen radius from the airport; see [GPS Quality](#gps-quality--gps) below
- **GPS Episodes page** — map, list and altitude-vs-distance view of individual GPS degradation episodes (one aircraft's continuous degraded period: where it started, where the aircraft recovered or was lost); see [GPS Episodes](#gps-episodes--gps-episodes) below
- **Maintenance page** — administrator tool for database housekeeping accessible at `/maintenance`; protected by a separate credential file independent of the main web auth; provides manual and scheduled purge of flight/meteo data (approach history, GPS quality data and the GPS degradation episode log are only ever purged manually); see [Maintenance](#maintenance--maintenance) below
- **ICAO24 blocklist** — a configurable prefix list (`BLOCKED_ICAO_PREFIXES`) silently drops non-aircraft Mode-S emitters system-wide at both the Beast TCP and JSON/MLAT live\_state entry points; default entry `T40` filters Finnish Air Navigation Services WAM ground interrogator stations that would otherwise inflate GPS quality counts and traffic statistics
- **Registration blocklist** — a complementary prefix list (`BLOCKED_REG_PREFIXES`) silently drops aircraft by registration system-wide (registration from the Radarcape JSON feed, or from an optional `BaseStation.sqb` aircraft database when the feed has none — see [WAM ground station filtering](#wam-ground-station-filtering)); default entry `OH-H` filters Finnish helicopters whose continuous manoeuvring near EFHK produces unreliable computed wind and should not feed any meteo analysis
- **SQLite database** with WAL mode — safe for Raspberry Pi SD-card or USB SSD operation
- **HTTP Basic Auth** — simple credentials-based access control for local network deployment

---

## Hardware Requirements

| Component | Requirement |
|-----------|-------------|
| MODE-S receiver | Jetvision Radarcape (Beast binary TCP output on port 10003, JSON feed on port 80) |
| Computer | Raspberry Pi 4 (2 GB RAM or more recommended) or any Linux machine |
| Storage | SD card works; USB SSD strongly recommended for long-term database growth |
| Network | Receiver and Raspberry Pi on same local network |

The system was developed and tested with a Radarcape receiver and Raspberry Pi 4 near EFHK (Helsinki-Vantaa Airport, Finland). Any receiver that outputs Beast binary format over TCP will work, though the JSON/MLAT feed integration is specific to the Radarcape.

---

## Software Architecture

```
Radarcape receiver (192.168.0.119)
        │
        ├─ TCP :10003  Beast binary  ──► collector/receiver.py
        │                                      │  pyModeS decoding
        │                                      │  BDS 4,4 / 4,5 / 5,0 / 6,0
        │                                      │  CPR position decoding
        │                                      ▼
        └─ HTTP /aircraftlist.json ──► collector/radarcape_json.py
                                               │  MLAT positions
                                               │  Pre-decoded temp & wind
                                               ▼
                                     ┌─────────────────┐
                                     │  live_state dict │  (shared in-memory)
                                     └────────┬────────┘
                                              │
                             ┌────────────────┼──────────────────┬──────────────────┐
                             │                │                  │                  │
                       database/       windshear sweep     gps sweep         wx poll        web/app.py
                       writer thread   daemon (3 s)         daemon (5 s)      thread (10 m)  Flask + SSE
                       (SQLite WAL)         │                    │                │           │
                             │       WindshearTracker    GpsQualityTracker   _wx_cache       ├─ /              Live map
                             │       (RAM; landings →    (RAM; hourly rows   (METAR/TAF)     ├─ /flights       History
                             │       approach_history)   + episode log)                      ├─ /sounding      Skew-T
                       data/modes_meteo.db                                                   ├─ /windmap       Wind map
                                                                                             ├─ /windshear     Approach
                                                                                             ├─ /gps           GPS Quality
                                                                                             ├─ /gps-episodes  GPS Episodes
                                                                                             └─ /maintenance   DB maintenance
```

Further background threads in `run.py`: **housekeeping** (see below), **autopurge** (daily flight / meteo purge when enabled on the Maintenance page) and **hourly_jobs** (hourly profile archive `profile_hours`, vorticity profile `kinematics_hours` and GNSS-height cells `gnss_hours` with the height calibration `gnss_cal` a few minutes after each hour, back-fill at startup, daily retention purges of `approach_series` and `departure_profiles` — archived first when enabled — and the hourly save of the heading calibration `heading_cal`, the radiosonde verification `sonde_verification`), **sondes** (radiosonde soundings from FMI open data) and **meps** (MEPS model profiles from MET Norway every 3 h into `meps_hours`, see *MEPS check*). The **ws_sweep** thread also runs the departure climb-out capture (`collector/departures.py`). On the first start with the heading calibration a one-off **heading_cal_boot** thread learns the offsets from the stored observations. The BDS 5,0 / 6,0 replies decoded by `receiver.py` are also kept briefly per aircraft (last 16 of each) for the windshear tracker's approach-roughness capture.

A small **housekeeping thread** (`run.py`) runs every 60 s and removes aircraft from `live_state` that have not been seen for 10 minutes, and prunes the BDS 5,0 / 6,0 pairing caches. Without it every aircraft ever received would stay in RAM for the life of the process. 10 minutes is longer than every consumer window (map/API 5 min, GPS sweep 60 s, windshear sweep 30 s), so nothing displayed or analysed is affected — an aircraft that reappears is simply re-created from its next message.

**Bounded memory for long uptimes:** besides `live_state` and the BDS caches, the other per-aircraft structures are also cleaned up: the database writer forgets flight sessions and write-throttle timestamps of inactive aircraft every 10 minutes; the windshear and GPS quality trackers drop aircraft that go stale; completed GPS quality hours keep only their counts (the per-aircraft sets are dropped when the hour ends, and the per-band detail is kept for the last 31 days); closed GPS episodes waiting for a failed database write are capped at 20 000; and the Live Map page forgets callsigns of aircraft that are no longer live.

### Data source priority

When multiple sources are available for the same observation the `best_*` consolidated fields are populated in this order of preference:

1. **MRAR** (BDS 4,4) — highest quality, direct avionics measurement with Figure of Merit
2. **MHR** (BDS 4,5) — secondary hazard report
3. **COMPUTED** — wind vector calculated from BDS 5,0 + 6,0 pair
4. **JSON** — temperature or wind injected from Radarcape's JSON feed

Temperature (`best_temp`): **MRAR → Mach/TAS temperature** (→ JSON in the live view). At EFHK MRAR is practically never received. BDS 4,5 (MHR) temperatures are **not used** — not for `best_temp`, the area profiles, the Sounding page, the Live Map Skew-T or the hourly profile archive (`TEMP_SQL` in `collector/atmos.py`). Most BDS 4,5 replies at EFHK are other Comm-B registers misidentified as BDS 4,5: in 24 Sep – 10 Oct 2026 two thirds of their temperatures were more than 40 K from ISA (median ISA + 47 K, mostly FL340–400), and they widened the p10–p90 spread of the profile layers by up to 60 K. They made up only 0.5 % of the temperatures. The raw value is still stored in `mhr_temp`. Hourly profiles archived before this rule may still contain them (wide p10–p90 bars in some hours).

### Computed wind (BDS 5,0 + 6,0)

Wind = ground vector − air vector. The ground vector is the true track and groundspeed from BDS 5,0; the air vector is the true heading and true airspeed. A BDS 5,0 and a BDS 6,0 reply from the same aircraft at most `WIND_MAX_PAIR_AGE` (10 s) apart are paired, and the result is rejected while the aircraft banks more than `WIND_MAX_ROLL_DEG` or turns faster than `WIND_MAX_TRACK_RATE`.

**Fresh pairs only where the altitude matters** — the live view recomputes the wind with every message of the aircraft from the latest BDS 5,0 / 6,0 pair in memory (up to 60 s old), so the aircraft keeps its wind and temperature between radar replies. When the radar replies stop while ADS-B positions continue — typically low on final, below about 1 000 ft — that pair would be placed at the aircraft's current, lower altitude. Where the altitude matters, the wind and the Mach/TAS temperature are therefore only used when the older of the two replies is at most `WIND_MAX_AGE_SEC` (optional, default 6 s) old: stored observations (a stale pair is not stored; the next fresh one is), the Windshear page's ILS barbs, approach bands, wind rose buffer and detection, and the Live Map aircraft profile on the Skew-T. The live wind shown in the aircraft list, popups and flight strips keeps the latest value. On 10–11 Oct 2026, 28–33 % of the live approach winds at 400–600 ft were an exact copy of the band 200 ft above, measured higher up.

**True heading** — BDS 6,0 reports magnetic heading. The magnetic declination is taken from the **World Magnetic Model (WMM2025)** at the aircraft's own position via the `pygeomag` package (cached on a 0.5° grid, rebuilt daily so the ~0.15°/year drift is followed automatically). Within 150 NM of EFHK declination ranges from about 8.7° (west / south-west) to 12.6° (north-east); a single fixed value would be off by up to ~2°, which at 450 kt TAS is a ~16 kt wind error. `MAG_DECLINATION` is used only as a fallback — when the position is not yet known, `pygeomag` is not installed, or `USE_WMM_DECLINATION = False`. The value used is stored per observation (`mag_decl`).

**True airspeed** — taken from the best available source, stored per observation as `tas_source`:

| `tas_source` | Source | Notes |
|---|---|---|
| `BDS50` | TAS field of BDS 5,0 | Normal case — the same register that carries track and groundspeed; 2 kt resolution |
| `MACH` | Mach (BDS 6,0) × speed of sound | Temperature = ISA at the pressure altitude + the current ISA deviation for that altitude band. The deviation is estimated continuously from aircraft that report both TAS and Mach (Mach ≥ 0.40, at most one sample per aircraft per 20 s, |deviation| ≤ 30 K) (their air-data computer's temperature: T = (TAS / Mach)² / (γ·R)), median of the last 30 min per 5 000 ft band; plain ISA when fewer than 5 samples exist. A 10 °C deviation left uncorrected would be ~2 % TAS error (~9 kt at cruise) |
| `IAS` | IAS (BDS 6,0) converted to TAS | Compressible-flow CAS → Mach → TAS at the ISA pressure for the altitude, same temperature as above. Requires a known altitude |

If none of these can be determined (e.g. no TAS and no altitude yet), no wind is computed. (IAS is never used directly as TAS: at altitude it is badly wrong, ≈200 kt too low at FL350.)

### Heading calibration (per airframe)

The system learns and corrects a **heading offset for each airframe** (`collector/heading_cal.py`). The declination is already correct (WMM2025, above), but the magnetic heading an aircraft reports in BDS 6,0 has its own small offset: most airliners convert their inertial true heading to magnetic heading with a magnetic-variation table stored in the avionics, and that table is often years old. Declination at Helsinki has grown from 7.0° (2005) to 10.5° (2026), so for example a 2015 table makes the reported heading about 2° too large once today's declination is added back. One degree at 450 kt is about 8 kt of wind error across the aircraft's heading.

The study behind this (`tmp_files/Articles/ModeS_Upper_Air_Profiles_10_2026.pdf`, Sect. 3.6) found offsets of +1.5° on average for 403 airframes (24 Sep – 10 Oct 2026), stable between two periods and grouped by aircraft type (E190 3.5°, CRJ900 / A220 2.1–2.3°, A320neo / A350 1.1–1.2°, B777-300ER ≈ 0°). Correcting them reduced the difference between the area-mean wind and the Jokioinen soundings from 11.5 to 9.1 kt RMS and halved the spread of single-aircraft winds. A replay of the stored data through the live learner (starting from nothing, using only past data) gave 11.1 → 8.9 kt.

**Learning** (continuous, in RAM): for each aircraft at most one sample every 30 s — true airspeed ≥ 100 kt, roll ≤ 5°, within `HEADING_CAL_RADIUS_KM` (default `SOUNDING_RADIUS_KM`) of the receiver. The aircraft's wind is compared with the mean (corrected) wind of the *other* aircraft in the same altitude layer during the last 60 minutes (at least 4 other airframes). A heading offset δ shows up as a wind error at right angles to the heading, proportional to the airspeed, so per airframe δ = −Σ V (r·n̂) / Σ V² (r = wind difference, n̂ = unit vector to the right of the heading; differences above 40 kt ignored). The sums fade with a half-life of `HEADING_CAL_HALFLIFE_DAYS` (30 days), so an avionics database update is followed within weeks; if three consecutive flights of an airframe disagree with its long-term value by more than 1.5°, it restarts from those flights.

**Applying** — true heading = magnetic heading + declination − δ, where δ is:

| `hdg_src` | Offset used | Shown in Live Map as |
|---|---|---|
| `A` | the airframe's own value, after data from ≥ `HEADING_CAL_MIN_FLIGHTS` (2) flights and ≥ 20 samples (about ±0.5°) | `+1.6° own` |
| `T` | otherwise the median of its aircraft type (≥ 3 calibrated airframes; type from the JSON feed or BaseStation.sqb) | `+2.1° type` |
| `F` | otherwise the median of all calibrated airframes (≥ 10) | `+1.6° fleet` |
| `D` | otherwise `HEADING_CAL_DEFAULT_DEG` (1.5°) | `+1.5° default` |
| `X` | airframe whose own offset exceeds `HEADING_CAL_EXCLUDE_DEG` (5°) — probably a different heading reference: its winds are **not used** (no best wind) | `excluded` |

The **raw wind is kept**: `observations.wind_spd / wind_dir` stay uncorrected, while `best_wind_spd / best_wind_dir` — used by everything (Live Map, area profiles, Sounding, Wind Map, Windshear and approach history, hourly profile archive) — are corrected. The offset applied and its source are stored per observation (`hdg_off`, `hdg_src`), so the raw and corrected winds can always be compared or recomputed. The approach-profile winds on final (`prof_json`) are corrected the same way; the crab angle and the raw approach series keep the reported heading. Observations stored before the calibration existed are not changed.

**Storage and start-up** — the learnt values are kept in the `heading_cal` table (one row per airframe, about 1–2 thousand rows), written **once an hour** (only the airframes that changed) and at shutdown, and loaded at startup. On the first start with an empty table the offsets are learnt once from the stored observations of the last `HEADING_CAL_BOOTSTRAP_DAYS` (30) days in a background thread (read only; about 30 s and up to ~70 MB of memory on a Raspberry Pi 4 for 30 days of data), so the correction is in use from the start. `/api/heading_cal` lists the mode, fleet and type medians and every airframe's offset.

**Config** (all optional, `getattr` defaults):

| Key | Default | |
|---|---|---|
| `HEADING_CAL_MODE` | `"apply"` | `"apply"` learn and correct · `"learn"` learn only (offset stored with a lower-case `hdg_src`, wind not corrected) · `"off"` disabled |
| `HEADING_CAL_DEFAULT_DEG` | `1.5` | offset before any airframe / type / fleet value exists |
| `HEADING_CAL_MIN_FLIGHTS` | `2` | flights with data before an airframe's own value is used |
| `HEADING_CAL_MIN_SAMPLES` | `20` | samples (faded) before an airframe's own value is used |
| `HEADING_CAL_EXCLUDE_DEG` | `5.0` | airframes with a larger own offset are excluded |
| `HEADING_CAL_HALFLIFE_DAYS` | `30` | fading half-life of the learnt sums |
| `HEADING_CAL_RADIUS_KM` | `SOUNDING_RADIUS_KM` | learning area around the receiver |
| `HEADING_CAL_SAMPLE_SEC` | `30` | at most one learning sample per aircraft per this many seconds |
| `HEADING_CAL_BOOTSTRAP_DAYS` | `30` | days of stored observations learnt from on the first start (0 = no bootstrap) |

The offsets are relative to the fleet as a whole (the shared part was confirmed against the radiosondes); the radiosonde comparison remains the long-term check. Airspeed (TAS) is not corrected — its per-airframe offsets were not repeatable.

### Air temperature (BDS 5,0 + 6,0)

Every observation with a wind pair also gets the **static air temperature** computed from the true airspeed (BDS 5,0, 2 kt resolution) and the Mach number (BDS 6,0, 0.004 resolution) reported by the same aircraft's air-data computer (`tm_temp` column, also `best_temp`):

> a = TAS / M,  T = a² / (γ·R)  →  T [K] = 288.15 · (TAS / (661.47 kt · M))²

MRAR temperatures are rare (on 8–9 Oct 2026 just 147 of 35 841 stored observations had one); with the Mach/TAS temperature about 85 % have a temperature. A single value scatters by about ±1.3 K at cruise (Mach 0.75–0.85) and ±3–4 K on approach (Mach 0.2–0.25), because the Mach step of 0.004 is a larger fraction of a small Mach number, so profiles use the (10 % trimmed) mean of many replies. Not computed below Mach 0.2 or more than 40 K from ISA. Checked against the Jokioinen radiosonde (8 Oct 2026 12 UTC, 850–260 hPa, two-hour mean over 150 km): mean difference +0.7 K, standard deviation 1.6 K. Older observations have no `tm_temp`, but the Sounding page computes it on the fly from their stored TAS and Mach (`collector/atmos.py`).

**Why there is no per-airframe temperature calibration** (unlike the [heading calibration](#heading-calibration-per-airframe)) — tested on 24 Sep – 19 Oct 2026 data (408 000 temperatures within 150 km, 396 airframes), comparing each airframe with the other aircraft of the same layer and hour:
- **Airframe biases are small**: about ±0.6 K between airframes, of which only about ±0.45 K repeats from one half of the period to the other; just 5 % of airframes are more than 1 K off, and the fleet as a whole has no common offset between airframes (+0.04 K).
- **They are not the main error**: a single airframe's temperature in a layer and hour scatters about ±2 K (±3.4 K at approach speeds) — almost all of it from the 0.004 Mach and 2 kt TAS steps, which the averaging of many replies removes.
- **The bias depends on the speed**: an airframe's offset at cruise says little about its offset at low speed (correlation 0.2), so a single offset per airframe would not even carry to the low levels.
- **The decisive test**: biases learnt from the first half of the period and applied to the second half reduced the scatter from 1.673 K to 1.658 K — **1 %**. The heading calibration, in comparison, cut the single-wind error from 14.7 to 9.3 kt, because heading offsets are large (typically 1.5°, 8–12 kt of wind) and share a common cause (outdated magnetic-variation tables); temperatures have no such cause.

A few airframes (mostly business jets) are repeatably 1–4 K off; in busy hours the trimmed mean removes them, and they matter only at night when one or two aircraft make up a layer. The remaining common offset against the radiosonde (about +0.3 K, see the Sounding page's Sonde check) cannot be found by comparing aircraft with each other at all — only an independent reference can, such as the radiosonde or, later, layer temperatures from the GNSS heights of pressure surfaces (see [GNSS height](#gnss-height-gnss--baro-difference)).

**A footnote — the vertical rates of the A220.** The ratio of an aircraft's inertial (BDS 6,0) to its barometric vertical rate should in principle follow the air temperature (dh/dH = Tv / T_ISA), a second, independent temperature source. Tested on 1 958 landings of 9–20 Oct 2026, it does not work for the fleet: the measured ratio did not follow the expected one at all (correlation −0.09) — most types blend the barometric altitude into their "inertial" vertical channel, so its long-term ratio to the baro rate carries no temperature signal. The one exception was the **Airbus A220 (BCS3)**: 55 landings, correlation +0.53 and a slope of 0.68 (95 % range 0.41–0.96), the only type that followed the temperature — possibly a GNSS-aided vertical channel. Not used (the GNSS heights of the pressure surfaces do the same job for all aircraft), but noted as a curiosity.

### GNSS height (GNSS − baro difference)

Aircraft report their barometric altitude as **pressure altitude** (referenced to 1013.25 hPa), so it tells which pressure surface they fly on; their ADS-B velocity messages (TC 19, about twice a second) also carry the **difference between the GNSS height and the barometric altitude** (25 ft steps, up to ±3 125 ft). Pressure altitude + this difference is the GNSS height of that pressure surface, and the difference itself is close to the surface's deviation from the standard atmosphere (D-value) — the quantity of a height chart: negative in cold air and troughs, positive in warm air and ridges. Each stored observation carries the aircraft's latest difference (`gmb_ft`, only when at most 5 s old; NULL when not sent or saturated) and its NACp (`nacp`, at most 30 s old), taken from the aircraft's ADS-B messages in memory — no extra database writes. Shown as the heights of the pressure surfaces and thickness temperatures on the Sounding page's Time–height section and as height contours with the geostrophic wind on the Wind Map (see *Heights of the pressure surfaces* below).

What the first days of data (19–21 Oct 2026) showed: the aircraft send the difference whenever their GNSS is healthy (96 % of the rows with NACp ≥ 8 carry it) and mostly stop when it is degraded, so jammed aircraft simply have none. Against the Jokioinen radiosonde the raw aircraft heights of the pressure surfaces lie about 24 m too high near the ground, about 0 m at FL250–FL330 and 6 m too low above: the GNSS height is ellipsoidal (about 18 m above mean sea level here, the geoid — removed separately since 22 Oct 2026, see *Geoid* below), and the rest follows the aircraft's speed — the static pressure error of the altimeter grows with Mach. Each airframe has its own offset of typically ±9 m, but only about 40 % of it repeated from one day to the next. A climb's height gain between two pressure altitudes gives the mean temperature of the layer to about ±0.5 K (FL100–FL300) or ±0.8 K (5 000 ft layers) — once the speed-dependent error is corrected (uncorrected, the layers came out 1–2 K too cold). Above about FL170 the slope of the pressure surface gave geostrophic winds within about 7–13 kt of the measured ones.

#### Heights of the pressure surfaces (calibration and products)

`collector/gnss_heights.py` turns the difference into the height of the pressure surface above mean sea level:

    z = (pressure altitude + GNSS − baro) × 0.3048 − N(lat, lon) − curve(altitude) − offset(airframe)

**Geoid.** The aircraft's GNSS height is measured from the WGS84 ellipsoid; `N` is the EGM96 geoid height at the aircraft's position (`collector/geoid.py`: a 5′ grid over 57.5–65.5° N, 16–34° E built into the file, about 12 kB, bilinear) — about 17.9 m at EFHK, 19.1 m at Jokioinen, 18.2 m at Tallinn and 14.9 m east of Kotka, falling by about 3 m per 100 km east of Helsinki. It is removed from every aircraft value (D-values, the Wind Map heights and geostrophic wind, thickness edges and the sonde comparison), so the calibration `curve` holds only the aircraft's pressure error. On 20–22 Oct 2026 data this moved the Wind Map geostrophic wind by about 1 kt and the layer thicknesses by 0.03–0.1 K — small, but it removes a false east–west slope of the pressure surfaces. Hours and sonde comparisons stored before the change are computed again once at start while their observations exist; older stored hours get the geoid at the receiver subtracted when read.

**Calibration (self-tuning).** After each Jokioinen sounding the hourly jobs compare every aircraft within 150 km of the balloon that passed a level within ±1 h of it (NACp ≥ 8, outside its GPS degradation episodes) with the sounding's measured height of that pressure surface — the balloon's position at each level is followed from the sounding's own winds as it drifts (tens of km by FL300), and keep the residuals per airframe and 5 000 ft band in `gnss_cal`. The correction is then fitted again from the last 30 days: `curve` per 5 000 ft band (linear between band centres; blended with a built-in default from the October 2026 data while a band has fewer than about 5 airframe cells, so it works from the first start and follows the data as they accumulate) and a small per-airframe `offset` (shrunk towards 0 until the airframe has been seen at several soundings). `/api/gnss/calibration` shows the current curve, the soundings and pairs used and the offsets, and the Sounding page's **Sonde check** lists them per band, per aircraft type and per airframe (see below). The optional `GNSS_CAL_SLOPE = True` also moves each aircraft's value from FL200 up to the balloon's position with the slope of the pressure surface seen by the aircraft of the band: on the first 6 soundings this halved the sounding-to-sounding scatter at FL250–FL350 (12–13 → 4–7 m), but it also removed most of the fall of the correction with altitude and made the independent thickness-temperature check worse (FL100–FL300 −0.6 → −0.9 K against Mach/TAS), so it is off until more soundings decide.

**Hourly products** (`gnss_hours`, stored raw so a new calibration also corrects the past): per hour and altitude layer the airframes' mean difference (→ **D-value**, the height of the surface minus its standard-atmosphere height, median of the airframes, moved to the layer centre), and per climb or descent the GNSS heights of the pressure surfaces at the edges of the 5 000 ft layers 0–40 000 ft, of 1 000–5 000 ft and of FL100–FL300, with whether it climbed or descended (hours stored by an older version are computed again once at start while their height series still exist) (→ **thickness temperature** Tv = g₀ ΔH / (R ln(p₁/p₂)), with H the geopotential height — the airframe offset cancels, and it does not use the Mach/TAS temperatures at all). Rows are written 4 h after the hour (an aircraft's visit is stored only when it has left), the newer hours are computed when the page asks; at the first start the hours since the logging began are back-filled. Shown on the Sounding page's Time–height section (**Height of the pressure surfaces**, **Height change 6 h**, **Thickness temperature check**) and on the Wind Map (**Heights**). These are new and will be tuned as data accumulate — in particular the calibration in stronger winds and the geostrophic wind of the Wind Map.

**Dense height series** — besides the throttled observations, every aircraft visit is recorded as a compact series in the `height_series` table (`collector/height_series.py`): a row whenever the pressure altitude of its ADS-B positions or the GNSS − baro difference steps by 25 ft, when its NACp changes or the difference stops, plus a position keyframe every 20 s (a value flickering between two neighbours in level flight is recorded at most every 10 s). Both quantities come in 25 ft steps, so the series is as exact as twice-a-second samples but small: about 2–4 kB per climb or descent, under 1 kB for a level overflight, one INSERT per visit (written once a minute). Visits with fewer than 10 rows with a difference are not stored. Research data for thin-layer thickness temperatures, the speed-dependent altimeter error and level-leg geostrophic winds; kept `HEIGHT_SERIES_DAYS` (default 30) days and purged daily (archived first when **Archive before purge** is on); `HEIGHT_SERIES = False` turns it off.

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/oh2gax/mode_s_wind.git
cd mode_s_wind
```

### 2. Install Python dependencies

Python 3.11 or newer is required (pyModeS 3.x requires 3.11).

```bash
pip3 install flask pyModeS pygeomag --break-system-packages
```

Or inside a virtual environment:

```bash
python3 -m venv venv
source venv/bin/activate
pip install flask pyModeS pygeomag
```

> **Note:** pyModeS (by Junzi Sun) is installed from PyPI as a normal dependency — the repository does not include a copy of the library. MODE-S Wind requires pyModeS 3.x (`requirements.txt`: `pyModeS>=3.0.0`).

### 3. Configure the system

Edit `config.py` — all settings are in one place:

```python
class Config:
    # ── Radarcape connection ──────────────────────────────────────────────
    RADARCAPE_HOST = "192.168.0.119"   # change to your receiver's IP
    RADARCAPE_PORT = 10003             # Beast binary TCP port (Radarcape default)

    # ── Web interface ─────────────────────────────────────────────────────
    WEB_HOST = "0.0.0.0"
    WEB_PORT = 5010
    WEB_USER = "admin"                 # change before exposing to network
    WEB_PASS = "admin123"              # change before exposing to network

    # ── Database path ─────────────────────────────────────────────────────
    DB_PATH = "data/modes_meteo.db"    # relative to project root
    # For USB SSD: "/mnt/usb/modes_meteo.db"
    DB_WRITE_INTERVAL = 5.0            # seconds between batched observation writes
    FLIGHT_GAP_SEC = 1800.0            # contact gap (s) that starts a new flight session

    # ── ICAO24 blocklist ──────────────────────────────────────────────────
    BLOCKED_ICAO_PREFIXES = ("T40",)   # Finnish WAM ground interrogators — not aircraft
    BLOCKED_REG_PREFIXES  = ("OH-H",)  # Finnish helicopters — unreliable meteo, exclude everywhere
    # BASESTATION_DB_PATH = "data/BaseStation.sqb"  # optional: aircraft database for registrations
    #                                               # missing from the JSON feed (default: data/BaseStation.sqb, used if present)

    # ── Receiver location ─────────────────────────────────────────────────
    RECEIVER_LAT = 60.317              # decimal degrees N
    RECEIVER_LON = 24.963             # decimal degrees E

    # ── Magnetic declination ──────────────────────────────────────────────
    MAG_DECLINATION = 10.5            # degrees E — fallback only (see USE_WMM_DECLINATION)
    USE_WMM_DECLINATION = True        # position-based declination from WMM2025 (needs pygeomag)

    # ── Radarcape JSON / MLAT feed ────────────────────────────────────────
    RADARCAPE_JSON_URL = "http://192.168.0.119/aircraftlist.json"
    RADARCAPE_JSON_INTERVAL = 5.0     # not currently used — poller runs every 2 s (radarcape_json.py)

    # ── Sounding aggregation ──────────────────────────────────────────────
    SOUNDING_RADIUS_KM = 150.0        # area sounding + hourly profile archive: obs within this radius
    SOUNDING_WINDOW_MIN = 60          # default window of the "Area · now" sounding (minutes)
    # APPROACH_SERIES_DAYS = 90       # optional: days to keep the raw approach series (approach_series; 0 = never purge)
    # WRITE_ON_LAYER_CHANGE = True    # optional: also store a row when an aircraft enters a new sounding layer
    # ARCHIVE_DIR = "data/archive"    # optional: folder of the monthly archive files and snapshots
    # DEPARTURE_PROFILES = True       # optional: departure climb-out profile capture (departure_profiles)
    # DEPARTURE_PROFILE_DAYS = 90     # optional: days to keep departure_profiles (0 = never purge)
    # HEIGHT_SERIES = True            # optional: dense pressure-altitude / GNSS − baro series per visit (height_series)
    # HEIGHT_SERIES_DAYS = 30         # optional: days to keep height_series (0 = never purge)
    # KINEMATICS_RADIUS_KM = 200      # optional: radius of the hourly vorticity plane fits (kinematics_hours)
    # GNSS_HOURS_DAYS = 0             # optional: days to keep the hourly GNSS-height cells gnss_hours (0 = always)
    # GNSS_CAL_SLOPE = False          # optional: slope correction of the sonde pairing above FL200 (experimental)
    # SONDE_FETCH = True              # optional: fetch radiosonde soundings from FMI open data
    # SONDE_PLACE = "Jokioinen"       # optional: FMI sounding station
    # SONDE_KEEP_DAYS = 365           # optional: days to keep the files in data/soundings (0 = forever)
    # MEPS_FETCH = True               # optional: fetch MEPS model profiles (MET Norway open data) for the MEPS check
    # MEPS_BACKFILL_DAYS = 3          # optional: days of model runs fetched at the first start
    # MEPS_URL = "https://thredds.met.no/thredds/dodsC/meps25epsarchive"   # optional: MEPS archive (OPeNDAP)
    # WIND_MAX_AGE_SEC = 6.0          # optional: max age (s) of the older BDS 5,0 / 6,0 reply for a wind placed at an altitude
    # HEADING_CAL_MODE = "apply"      # optional: per-airframe heading calibration "apply" | "learn" | "off"
    #                                 # (other HEADING_CAL_* keys: see "Heading calibration" above)

    # ── Meteo source mode ─────────────────────────────────────────────────
    METEO_SOURCE_MODE = "HYBRID"      # "EHS" | "JSON" | "HYBRID"

    # ── Storage mode ──────────────────────────────────────────────────────
    STORAGE_MODE = "METEO_ONLY"       # "ALL" | "METEO_ONLY"

    # ── Airport ICAO ──────────────────────────────────────────────────────
    AIRPORT_ICAO = "EFHK"             # used for METAR/TAF display and QNH correction

    # ── Per-aircraft write throttle ───────────────────────────────────────
    WRITE_MIN_INTERVAL_SEC = 30.0     # 0 = disabled (store every observation)

    # ── Windshear / Approach monitoring ───────────────────────────────────
    WINDSHEAR_AIRPORT_LAT = 60.3172   # airport reference point (lat)
    WINDSHEAR_AIRPORT_LON = 24.9634   # airport reference point (lon)
    WINDSHEAR_RADIUS_NM = 15.0        # outer tracking radius (NM)
    WINDSHEAR_MAX_ALT_FT = 5000.0     # altitude gate (ft) — ignore aircraft above
    WINDSHEAR_CORRIDOR_HALF_WIDTH_NM = 1.5   # ILS corridor half-width (NM)
    WINDSHEAR_MAX_ILS_NM = 25.0       # max along-track range from threshold
    WINDSHEAR_THR_ELEVATION_FT = 179.0        # fallback threshold elevation (per-runway values in EFHK_RUNWAYS)
    WINDSHEAR_GS_OFFSET_FT = 0.0      # manual glideslope calibration trim (ft)
    WINDSHEAR_MAX_TRACK_DEV_DEG = 60.0        # max track deviation from approach hdg (°)
    WINDSHEAR_GA_MIN_DESCENT_POLLS = 8        # go-around detector: descending sweeps before "approaching"
    WINDSHEAR_GA_MIN_CLIMB_POLLS = 3          # consecutive climbing sweeps (3 s each) to confirm a go-around
    WINDSHEAR_GA_MIN_ALT_GAIN_FT = 50.0       # minimum real altitude gain during the climb
    WINDSHEAR_GA_CLIMB_FPM = 600.0            # climb rate that counts as go-around climb
    WINDSHEAR_GA_MAX_ALT_FT = 2200.0          # go-around detection ceiling (ft)
    WINDSHEAR_GA_FLASH_SEC = 60.0             # seconds the GO-AROUND flash stays on the strip

    # ── GPS Quality monitoring ────────────────────────────────────────────
    GPS_NACP_THRESHOLD = 6       # NACp ≤ this value is flagged as degraded
    GPS_FREEZE_POLLS   = 3       # consecutive same-position polls to flag freeze
    GPS_GAP_SEC        = 45.0    # seconds without position (EHS still active) → gap
    GPS_MIN_GS_KT      = 50.0    # minimum groundspeed for freeze detection
    GPS_SWEEP_SEC      = 5.0     # sweep interval for GPS quality thread
    GPS_MIN_ALT_FT     = 1000.0  # no degradation checks below this altitude (landing aircraft)
    GPS_NIC_THRESHOLD  = 6       # NIC ≤ this value (Rc ≥ 0.3 NM) is flagged as degraded integrity (optional, default 6)
    # GPS_EPISODE_RADIUS_NM = 100.0  # optional: radius (NM from the airport) for the degradation episode log (default 100)
    # GPS_EPISODE_EDGE_NM = 130.0    # optional: "lost" episodes ending this far out are shown as "Left coverage" (default 130)

    # ── Wind calculation quality gates (BDS 5,0 + 6,0) ────────────────────
    WIND_MAX_ROLL_DEG   = 5.0     # reject computed wind when bank angle exceeds this
    WIND_MAX_TRACK_RATE = 1.0     # °/s — reject while turning
    WIND_MAX_PAIR_AGE   = 10.0    # s — max time between the paired BDS 5,0 and 6,0 replies
    WIND_MAX_SPEED_KT   = 150.0   # sanity limit for computed wind speed
    MRAR_MIN_FOM        = 1       # minimum BDS 4,4 Figure of Merit accepted (0–4)

    # ── Maintenance page ──────────────────────────────────────────────────
    MAINTENANCE_AUTH_FILE = ""        # path to username:password file — page stays locked while empty
```

> **Keep a note of your local edits.** `config.py` is part of the repository, so replacing it with a newer version (e.g. copying the updated file from GitHub to the Pi) resets any values you changed locally — such as `MAINTENANCE_AUTH_FILE`, `WEB_USER` / `WEB_PASS` or IP addresses. Re-apply them after updating `config.py`. Optional settings added later are read with safe defaults (e.g. `USE_WMM_DECLINATION`, `GPS_EPISODE_RADIUS_NM`, `APPROACH_SERIES_DAYS`, `HEADING_CAL_*`, `WRITE_ON_LAYER_CHANGE`, `ARCHIVE_DIR`, `DEPARTURE_PROFILE*`, `HEIGHT_SERIES*`, `KINEMATICS_RADIUS_KM`, `GNSS_HOURS_DAYS`, `GNSS_CAL_SLOPE`, `WIND_MAX_AGE_SEC`, `SONDE_*`, `ACCESS_*` — shown as commented lines below), so an update of the code does not require updating `config.py` unless the change notes say so. The other settings in the block below — including the `WINDSHEAR_GA_*` go-around keys — must exist in `config.py`.

Key values to change for your installation:

- `RADARCAPE_HOST` — IP address of your Radarcape on the local network
- `RECEIVER_LAT` / `RECEIVER_LON` — your receiver's location (used for CPR position decoding and sounding radius)
- `MAG_DECLINATION` — magnetic declination at your receiver in degrees East. With `pygeomag` installed and `USE_WMM_DECLINATION = True` (default) the declination at each aircraft's own position is calculated automatically and this value is only a fallback (aircraft without a known position, or pygeomag missing — a warning is logged at startup). Find your value at [NOAA magnetic declination calculator](https://www.ngdc.noaa.gov/geomag/calculators/magcalc.shtml); WMM2025 is valid until 2030, after which it is extrapolated with a warning — upgrade pygeomag then
- `AIRPORT_ICAO` — ICAO code of your nearest airport (used for METAR/TAF display on the Live Map bottom strip and as the QNH source for Wind Map low-altitude corrections)
- `WEB_USER` / `WEB_PASS` — credentials for the web interface
- `MAINTENANCE_AUTH_FILE` — full path to the maintenance credential file (see [Maintenance](#maintenance--maintenance)); empty by default, which keeps the maintenance operations locked
- `METEO_SOURCE_MODE`, `STORAGE_MODE`, and `WRITE_MIN_INTERVAL_SEC` — see the [Operational Modes](#operational-modes) section below
- `WINDSHEAR_AIRPORT_LAT` / `WINDSHEAR_AIRPORT_LON` — reference point for the 15 NM outer tracking circle on the Windshear page (set to your monitoring airport coordinates)
- `WINDSHEAR_THR_ELEVATION_FT` — runway threshold elevation above MSL in feet; used to anchor the 3° glideslope correctly on the ILS vertical profile (EFHK = 179 ft)
- `WINDSHEAR_GS_OFFSET_FT` — manual calibration trim for the glideslope line; adjust if aircraft you know to be on glideslope still appear consistently high or low after the threshold and QNH corrections are applied
- `WINDSHEAR_MAX_TRACK_DEV_DEG` — maximum allowed deviation in degrees between an aircraft's ADS-B ground track and the runway's approach heading; the default of 60° rejects departures on parallel runways (which fly ~180° off the approach heading) while accepting all legitimate approach aircraft including those still rolling out of a late vector intercept

### 4. Configure API keys

The Live Map, Wind Map and Windshear pages use **CARTO** raster basemaps (dark / light / no-labels tile styles). CARTO requires a free API key to serve tiles without an "API key required" watermark — get one at [carto.com/basemaps/apikey](https://carto.com/basemaps/apikey/) (free up to 5,000,000 tile requests/month).

API keys are kept out of the git repository in a local, gitignored file so you can commit and push freely without ever exposing your key:

```bash
cp api_keys.py.example api_keys.py
```

Then edit `api_keys.py` and fill in your key:

```python
CARTO_API_KEY = "your-carto-key-here"
```

`api_keys.py` is listed in `.gitignore` and will never be committed — `api_keys.py.example` is the safe-to-commit template documenting what needs to be filled in. `config.py` imports from `api_keys.py` at startup and falls back to an empty string with a console warning if the file is missing, so the app still starts (map tiles just show the watermark until the key is added). As more API keys are needed in the future, add them to both files following the same pattern.

### 5. Run

```bash
python3 run.py
```

The system will log startup information and the web interface address:

```
2025-05-11 12:00:00  INFO     modes.main           ============================================================
2025-05-11 12:00:00  INFO     modes.main           MODE-S Wind System starting
2025-05-11 12:00:00  INFO     modes.main             Database    : /home/pi/mode_s_wind/data/modes_meteo.db
2025-05-11 12:00:00  INFO     modes.main             Radarcape   : 192.168.0.119:10003
2025-05-11 12:00:00  INFO     modes.main             Web         : http://0.0.0.0:5010
2025-05-11 12:00:00  INFO     modes.main             Source mode : HYBRID
2025-05-11 12:00:00  INFO     modes.main             Storage mode: METEO_ONLY
```

Open `http://<raspberry-pi-ip>:5010` in a browser. You will be prompted for username and password.

### 6. Running in the background (optional)

```bash
mkdir -p logs
nohup python3 run.py > logs/modes_wind.log 2>&1 &
echo $! > run.pid          # save PID to stop later
```

`run.py` already writes its own log to `logs/modes_meteo.log`, so the redirected file contains the same lines (plus any uncaught error output); redirect to `/dev/null` instead if you do not want the duplicate.

The log `logs/modes_meteo.log` is rotated: at 10 MB it is renamed `modes_meteo.log.1` (older ones `.2`, `.3`) and 3 old files are kept, so the logs take at most about 40 MB. The web server's access lines (one per page request — the open pages poll every few seconds) are not logged; its warnings and errors are. Optional `config.py` keys: `LOG_MAX_MB` (default `10`), `LOG_BACKUPS` (default `3`), `LOG_HTTP_ACCESS` (default `False`; `True` logs every request again). The redirected `nohup` file above is not rotated.

**Access log.** Who uses the web interface and any misuse are written to a separate compact log, `logs/access.log` — one line per event rather than per request (the open pages poll every few seconds), typically a few kilobytes a day:

| Line | Meaning |
|---|---|
| `LOGIN` | A successful login from an address (first request of a session), with the user name, the first page and the browser; `new address` when this address has never logged in before (also a warning in the main log), `LAN` for the local network |
| `SESSION` | End of that session (no requests for 30 min): time span, number of requests, pages opened |
| `DENIED` | A request without credentials — internet scanners, link checkers. The browser's own first request before the login dialog is not listed when the same address logs in within 30 s |
| `BADPASS` | A wrong user name or password (the user name tried is shown, never the password) |
| `BLOCKED` | 10 wrong passwords within 10 min from one address: it gets HTTP 429 for 15 min (not applied to local-network addresses); also a warning in the main log |
| `PROBE` | A connection that is not HTTP at all, classified: TLS handshake (`https://` to the plain-HTTP port), SOCKS4 / SOCKS5 open-proxy test, Remote Desktop (RDP) probe, SSH, other malformed request |
| `ACTION` | A successful changing request — maintenance purge / delete / settings, Approach History clear |
| `MAINT-PW` | A wrong maintenance password |
| `ERROR` | A server error (HTTP 5xx) |
| `DAILY` | Summary of the day at local midnight: logins and their addresses, denied requests, wrong passwords, blocks, probes, actions |
| `START` | The web server started |

At most 20 lines per address and kind are written per clock hour; the rest are counted in one summary line (`… 190 more in the last hour not listed (e.g. /.env, /phpinfo.php …)`), so a path scanner costs a few lines. The log rotates at 1 MB with 5 old files. The addresses that have logged in are kept in `logs/access_known.json` (written only when a session starts). The startup log no longer prints the web password, and warns while `WEB_PASS` is still a default value. Optional `config.py` keys: `ACCESS_LOG` (default `True`), `ACCESS_SESSION_IDLE_MIN` (`30`), `ACCESS_LOG_PER_IP_HOUR` (`20`), `ACCESS_LOCKOUT_FAILS` (`10`; `0` = no blocking), `ACCESS_LOCKOUT_MIN` (`15`), `ACCESS_LOG_MAX_MB` (`1`), `ACCESS_LOG_BACKUPS` (`5`).

> **Exposing the web interface to the internet.** The interface uses HTTP Basic authentication over plain HTTP, so the password is sent readable with every request — anyone on the network path (public Wi-Fi, a company proxy) could see it. Use a password that is not used anywhere else, and preferably put an HTTPS reverse proxy (e.g. Caddy with a Let's Encrypt certificate) or a VPN (WireGuard, Tailscale) in front instead of forwarding the port directly.

To stop:

```bash
kill $(cat run.pid)
```

### 7. Run as a systemd service (recommended for permanent deployment)

Create `/etc/systemd/system/modes-wind.service`:

```ini
[Unit]
Description=MODE-S Wind System
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/mode_s_wind
ExecStart=/usr/bin/python3 run.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable modes-wind
sudo systemctl start modes-wind
sudo systemctl status modes-wind
```

---

## Operational Modes

Two independent settings in `config.py` control how the system collects and stores data. Both are displayed as read-only pill badges in the navbar on every page of the web interface so you always know which modes are active without opening any files.

Changing either setting requires editing `config.py` and restarting the service. The active configuration is also printed in the startup log.

---

### Meteo Source Mode (`METEO_SOURCE_MODE`)

Controls which data source provides the meteorological values (wind speed/direction, temperature, pressure) that appear in the live map, sounding diagrams, and database.

| Value | Behaviour |
|-------|-----------|
| `"HYBRID"` | **Default.** EHS data from the Beast feed has priority. The Radarcape JSON feed provides MLAT positions and fills in meteo values only for aircraft where pyModeS has not yet produced any EHS data. This preserves the full decode chain while also capturing aircraft that are only reachable via MLAT. |
| `"EHS"` | The JSON feed is used exclusively for MLAT positions. It never injects meteo values. All wind, temperature and pressure data comes from pyModeS decoding of BDS 4,4 / 4,5 / 5,0 / 6,0 registers received via the Beast TCP feed. Use this mode to work with fully transparent, self-decoded data. |
| `"JSON"` | The Radarcape's own decoded wind and temperature values from `aircraftlist.json` are always used and overwrite any EHS-derived values for the same aircraft on every poll cycle. Use this to compare the Radarcape's internal processing against the pyModeS decode chain, or to rely on the receiver hardware's own algorithms. |

**Tip:** If you are seeing mostly `COMPUTED` source tags (green symbols on the map), EHS decoding is working well. Switch to `"EHS"` mode to confirm that the JSON feed is not contributing anything and that all meteo originates from pyModeS. Switch to `"JSON"` mode to see what the Radarcape produces on its own and compare values.

---

### Storage Mode (`STORAGE_MODE`)

Controls which decoded observations are written to the SQLite database.

| Value | Behaviour |
|-------|-----------|
| `"METEO_ONLY"` | **Default.** Only observations that carry at least one decoded meteo value (`meteo_source ≠ NONE`) are written to disk. Position-only messages are used to update the live map in memory but are never persisted. This typically reduces database growth by 60–80% depending on what fraction of tracked aircraft are producing meteo data. Recommended for long-running deployments on SD card or when storage is limited. |
| `"ALL"` | Every decoded observation is stored — positions, motion data, and meteo — regardless of whether it carries any meteorological values. This gives the most complete flight tracks and motion history but grows the database quickly. At a busy location like EFHK, the database can accumulate several hundred megabytes per day. |

**Note:** In `METEO_ONLY` mode observations without meteo data are dropped before they reach the database, so a `flights` row is created only once at least one meteo observation of that contact is stored, and its observation count and altitude range cover the stored rows only. Flight track maps in the Flights browser will show only the positions where meteo was decoded rather than the full continuous path.

**SD card recommendation:** Even with `METEO_ONLY`, SQLite WAL mode generates frequent small writes which accelerate SD card wear. Moving the database to a USB SSD (update `DB_PATH` in `config.py`) is strongly recommended for any deployment intended to run continuously for more than a few days.

---

### Write Throttle (`WRITE_MIN_INTERVAL_SEC`)

Controls the minimum time gap (in seconds) between successive database writes for the same aircraft. This is the most effective single setting for controlling database growth during extended operation.

| Value | Behaviour |
|-------|-----------|
| `30.0` | **Default.** At most one observation stored per aircraft per 30 seconds. An aircraft cruising at FL350 for 20 minutes produces ~40 rows instead of potentially hundreds. During climbs and descents a typical jet ascends ~1 000 ft per 30-second interval, so consecutive stored observations naturally sample different altitude layers — sounding profile quality is essentially unaffected. |
| `60.0` | One observation per minute per aircraft. Halves the write volume again compared to 30 s. Suitable for very long-running deployments or slower storage media. Sounding resolution remains good since standard pressure levels are typically 1 000–2 000 ft apart. |
| `0` | Throttle disabled — every qualifying observation is stored immediately. Use only for short diagnostic sessions or when studying individual message rates. |

**Combined effect:** Running `METEO_ONLY` together with `WRITE_MIN_INTERVAL_SEC = 30.0` is the recommended configuration for continuous long-term operation. At a busy location like EFHK, testing has shown this reduces database growth from several hundred MB per hour (all observations, no throttle) to a much more manageable level while preserving all the data needed for sounding profiles and historical analysis.

**Layer-aware throttle (`WRITE_ON_LAYER_CHANGE`, default `True`)** — an observation with meteo data is also written before the interval has passed when the aircraft has entered a new sounding layer (1 000 ft below 10 000 ft, 2 000 ft above) since its last stored row, but not sooner than 5 s after it. A jet climbing at 3 000–4 000 fpm crosses a 1 000 ft layer in 15–20 s, so with a plain 30 s throttle its single-aircraft profile (Flights page sounding, aircraft overlay) skipped layers; now it gets a value in every layer. Level flight is unchanged; the cost is estimated at a few per cent more rows.

**How much does the interval matter?** Tested on 24 Sep – 10 Oct 2026 data: thinning the stored observations from 30 s to 60 s or 120 s per aircraft left the agreement of the 60-min area profile with the Jokioinen soundings practically unchanged (temperature SD 1.27 / 1.28 / 1.35 K, wind 11.5 / 11.7 / 11.8 kt RMS, also below 5 000 ft). The area profile already averages dozens of aircraft per layer; its accuracy is limited by the 150 km × 60 min averaging and per-aircraft biases, not by the number of replies. So **15 s would double the database for no measurable gain in the area profile**; low-level inversions are better seen in the **airport low-level profile** (Live Map, Airport selector), which uses every raw reply of landings and departures at 200 ft resolution.

**Tuning guide:**

- Start with `30.0` and monitor database growth over a few hours of peak traffic.
- If growth is still too fast, increase to `60.0`.
- Thin inversions near the airport: use the Live Map **Airport** profile rather than a shorter interval.
- Set to `0` temporarily if you want to capture a specific event at full resolution, then restore your normal value.

**Note:** the throttle applies to every observation regardless of source. Because computed wind is available on almost every message, a rare BDS 4,4 MRAR / BDS 4,5 MHR report arriving within the interval after a computed-wind row is not stored.

---

## Web Interface

### Status indicator

The top navigation bar always shows the connection status:

- 🟢 **Live** — SSE stream active (Live page only)
- 🟢 **Online** — web API responding (all other pages)
- 🔴 **Reconnecting…** — Live page: SSE connection lost, retrying automatically
- 🔴 **Error** — other pages: the `/api/stats` request failed (retried every 15 s)

The navbar also shows live aircraft counts: total aircraft visible and how many are currently providing meteo data, two read-only configuration badges (meteo source mode and storage mode), a **live UTC clock** displaying the current date and time in `YYYY-MM-DD HH:MM:SS UTC` format (updated every second), and the **Dark / Light** theme toggle button which applies to all pages.

**Version and What's new:** next to the theme button the navbar shows the version of the system, **v.DDMMYYYY** — one version per day of development, named after the date and taken automatically from the newest version heading in `doc/whats_new.md` or `CHANGELOG.md`, whichever is newer (so `CHANGELOG.md` need not be copied to the device). Clicking it (**v.… · What's new · Guides**; on screens narrower than 1 700 px only the version) opens a window over the current page with two tabs: **What's new** — short notes for users of the last 10 versions (from `doc/whats_new.md`, updated with each delivery) — and **User guides** — the PDF user guides with a short description each, **Open PDF** (new browser tab) and **Download** (listed in `doc/guides.md`: title, file, version, date, pages and description). The window scrolls and closes with ×, Esc or a click outside it (`/api/whatsnew`). Only the PDFs listed in `doc/guides.md` are served (`/doc/<file>`, behind the same login).

**Guide shortcuts:** a small **?** opens the matching user guide in a new tab — next to *Atmosphere Profile* on the Live Map and *Skew-T* on the Sounding page (Skew-T guide), after **Refresh** on the Sounding page (Sounding and Wind Map guide) and at the end of the Wind Map controls (the same guide, opened at the Wind Map section; `open: windmap@23` in `doc/guides.md`). A small dot on the link means the system has a newer version than the one this browser last opened in the window; it disappears once the window has been opened (remembered per browser in `localStorage`).

**One browser tab per page:** the navigation links open each page in its own browser tab. If the page is already open in another tab, clicking its link switches to that tab without reloading it, so selections made there (runway, time window, filters, display modes) are kept; a page that is not open yet opens in a new tab. Clicking the link of the page shown in the current tab reloads it in place, as before. Ctrl-, Shift- or middle-click keep the browser's normal behaviour.

---

### Live Map  `/`

The main dashboard showing all currently tracked aircraft in real time, updated every 3 seconds via Server-Sent Events.

**Layout** — aircraft list (left, 270 px), map (centre) and the Atmosphere Profile (right), with METAR / TAF below. The Atmosphere Profile panel is as wide as about 0.73 × its height — about 540 px on a 1920 × 1080 screen, about 900 px on 2560 × 1600 — so the Skew-T keeps the same shape on large screens (at least 540 px, at most 45 % of the window width). On a tablet in portrait (window narrower than 1 100 px and taller than wide, e.g. a 10" iPad) the map is left out: the aircraft list and the Skew-T share the width, aircraft are selected from the list, and METAR / TAF stay below. Turning the tablet to landscape brings the map back.

#### Aircraft symbols

Aircraft are drawn in an ATC-style display:

- **Filled square** — current position of the aircraft
- **Speed vector line** — short line extending from the square in the direction of travel (track)
- **Colour** — indicates the meteo data source:

| Colour | Source | Description |
|--------|--------|-------------|
| 🔵 Blue | MRAR | BDS 4,4 Meteorological Routine Air Report — direct avionics data |
| 🟢 Green | COMPUTED | Wind calculated from BDS 5,0 + BDS 6,0 pair |
| 🟡 Amber | MHR | BDS 4,5 Meteorological Hazard Report |
| 🟣 Purple | JSON | Temperature/wind injected from the Radarcape JSON feed (MLAT positions themselves are not marked by colour) |
| ⚫ Grey | NONE | Aircraft visible but no meteo data decoded yet |

#### Trail dots

Each aircraft leaves a trail of fading dots showing its position over the past ~60 seconds. Older positions are more transparent; the trail gives an immediate sense of direction and speed without cluttering the map.

#### Left panel — Aircraft list

Lists all currently visible aircraft, by default by altitude with the lowest on top. The sort button at the right of the panel title steps through **Alt ↑** (lowest on top), **Alt ↓** (highest on top) and **A–Z** (by callsign); aircraft without an altitude are listed last, and the choice is remembered in the browser. Shows callsign, registration and ICAO24 code (e.g. `FIN7KM  OH-LKH  461E1B`), a small **▲ / ▼** at the right end of the row when the aircraft climbs / descends at least 300 fpm (hover: rate), aircraft type, altitude — below the 5 000 ft transition altitude the altitude on the METAR QNH (pressure altitude + 27 ft per hPa above 1013.25, e.g. `1,760 ft` for a reported 1,500 ft at QNH 1023; hover: QNH and pressure altitude; `ft PA` = pressure altitude when no METAR QNH is available), above it the flight level (`FL350`), the switch decided on the QNH altitude — vertical rate when at least 100 fpm (`+1,850 fpm`, `−960 fpm`), ground speed, and the current wind and temperature reading with the aircraft's heading correction if available (e.g. `245 kt @ 270° · -45.3°C · HC +1.6° own`; the source is `own` airframe value, `type`, `fleet` or `default`, `excluded` for airframes beyond the 5° limit, `(learn)` in learn mode — see [Heading calibration](#heading-calibration-per-airframe)). Registration and type come from the Radarcape JSON feed or the optional BaseStation.sqb; an aircraft without a callsign is listed under its registration (or ICAO24). Click any row to select that aircraft and open the detail strip. The list scrolls with the mouse wheel or touch but shows no scrollbar (a bar that changes with every update would flicker), and keeps its scroll position while it updates.

**Meteo only** checkbox — hides all aircraft that do not currently have any decoded meteo data. Defaults **on**; state persists across browser sessions.

#### Map labels

**Labels checkbox** — toggles callsign, registration or ICAO24 labels next to each aircraft symbol on the map. Defaults **on**; state persists across browser sessions.

**Label mode selector** — choose between:
- **Callsign** — shows the flight's callsign (e.g. FIN3GJ). Once a callsign has been seen for an aircraft it is cached and will never revert to the ICAO24 code even if some subsequent messages do not include it.
- **Registration** — shows the aircraft's registration (e.g. OH-LKH) when known, otherwise the callsign or ICAO24 code.
- **ICAO24** — always shows the aircraft's ICAO 24-bit address (e.g. 461F52).

The selected label mode persists across browser sessions.

**Track checkbox** — when enabled, selecting an aircraft draws a dashed polyline on the map showing its flight path: the positions stored with its meteo observations of the current flight, continued with its live positions while it stays selected. The polyline is drawn in the aircraft's meteo-source colour. If the selected aircraft disappears from the map for a while (e.g. it loses its position under GPS jamming), it stays selected and the line stays on the map and continues when the aircraft reappears. The Track setting defaults **off** and persists across browser sessions via localStorage. The polyline is removed when the aircraft is deselected or the Track checkbox is turned off.

#### Bottom strip — METAR / TAF

The bottom strip under the aircraft list and the map always shows the current METAR and TAF for the configured airport (`AIRPORT_ICAO` in `config.py`, default EFHK). The data is fetched server-side from NOAA and refreshed automatically every 10 minutes. METAR (40 % of the width) and TAF (60 %; in windows narrower than 1 600 px one third / two thirds) are side by side; with an aircraft selected its detail box takes the first 330 px of the strip and METAR / TAF share the rest. In windows narrower than 1 600 px their text is slightly smaller (14 px). A long METAR or TAF first tightens its line spacing and shrinks its text (in 0.5 px steps, down to 12 px) to fit its box — refitted whenever the text or the box size changes (new message, aircraft selected or closed, window resized); only beyond that (about 9 TAF lines) it scrolls. The strip does not extend under the Atmosphere Profile panel, which uses the full height of the page (in tablet portrait mode, without the map, the strip spans the full width).

**Wind vectors:** every aircraft with a wind reading also gets a short light-blue line pointing downwind (the direction the air moves; longer for stronger wind), so the wind field over the map is visible at a glance.

#### Clicking an aircraft

Clicking an aircraft symbol or list entry:

1. **Enlarges the symbol** on the map for easy tracking
2. **Opens the aircraft detail box** (330 px, three columns) on the left of the bottom strip:
   - Header: callsign, then registration · aircraft type · ICAO24 code (e.g. `FIN7KM  OH-LKH · E190 · 461E1B`) and the meteo source badge (MRAR / COMPUTED / MHR / JSON). The map popup of the aircraft shows the same identity line
   - Altitude, vertical rate (**fpm**), temperature
   - Ground speed, track, wind (direction / speed, e.g. `252° / 45 kt`)
   - **Hdg corr** — the heading correction used for this aircraft's wind (e.g. `+1.6° own`, `+2.1° type`, `+1.5° default`, `excluded`; see [Heading calibration](#heading-calibration-per-airframe)); the MRAR Figure of Merit (FOM) is shown in this cell instead when an MRAR reply is received
   - Pressure, humidity and turbulence (MRAR / MHR values, which practically no aircraft send) get their own cells only when present
3. **Overlays the aircraft's full wind profile** on the Atmosphere Profile panel (right side) — see below

Click the **✕** button to deselect and close the aircraft detail box. The METAR/TAF panel remains visible at all times.

#### Right panel — Atmosphere Profile

A permanently visible Skew-T Log-P diagram filling the full height of the right panel, which runs from the navigation bar to the bottom of the page (from 22 Oct 2026; before, the METAR/TAF strip ran under it). Its width follows the window height (about 590 px on a 1920 × 1080 screen — a little wider than before, room for the RH strip; at least 560 px, at most 45 % of the window). A user guide with screenshots — how to read the diagram, the upper-air parameters, where the data come from, all controls and analysis levels, the airport low-level profile, the METAR dewpoint and surface parcel (LCL, CAPE, Lifted Index), the data-quality indicator, the comparison profiles (Sonde, MEPS — including why the model has only 10 levels — and the RH strip), the Sounding page and the limitations — is in [`doc/SkewT_User_Guide.pdf`](doc/SkewT_User_Guide.pdf). The canvas automatically sizes itself to the available space when the page loads and reflows whenever the browser window is resized, giving maximum vertical resolution for the profile. The diagram uses a log-pressure Y axis and a skewed temperature X axis, with the ISA (International Standard Atmosphere) reference temperature shown as a dashed blue line.

<p align="center"><img src="doc/Mode_S_Wind_SkewT_1.png" alt="MODE-S Wind Atmosphere Profile (Skew-T) with Analysis Full" width="540"></p>

*Atmosphere Profile with **Analysis: Full** on a low-stratus morning (METAR 05/04, SCT005 BKN006): tropopause, jet, 0 / −10 / −20 °C levels, contrail level, the inversion on top of the stratus (`INV +4.4° FL005–015`), the fog / low-stratus flag, and the LCL from the METAR dewpoint (400 ft) next to the METAR cloud base (SCT005).*

**Scales** — pressure (hPa) on the left, altitude markers (**1–12 km**, pressure altitude) just right of the pressure axis, and the temperature scale (−40 … +30 °C at the bottom of the skewed axis) below the plot. The panel is at least 540 px wide (wider on tall screens, see *Layout* above) and the temperature range is centred on the typical profile, so the curve stays clear of the wind barbs. The dashed blue line is the ISA reference.

**Adiabats** — faint **dry adiabats** (solid, brownish) and **moist (saturated) adiabats** (dashed, green), every 10 K, for reading stability: where the temperature line is steeper than a dry adiabat the layer is unstable; between the dry and moist adiabats it is conditionally unstable (stable for clear air, unstable once saturated); where it leans right (temperature rising with height) it is an inversion. They are fixed reference curves and need no humidity data (none is available from Mode S); the moist ones are computed by integrating the saturated pseudo-adiabatic lapse rate from 1000 hPa. Near the ground single-aircraft temperatures scatter ±3–4 K, so judge low-level stability from the area profile rather than one aircraft.

**Ground line** — a brown line at the airport's **station pressure**, computed from the current METAR QNH and the airport elevation (`WINDSHEAR_THR_ELEVATION_FT`, EFHK 179 ft; about QNH − 6.5 hPa), labelled e.g. `EFHK 980 hPa (QNH 986)`, with the area below it shaded and the METAR **surface temperature** as a diamond on the line. The aircraft data need no QNH correction — Mode S altitude is pressure altitude (1013.25 hPa reference), i.e. a direct measure of static pressure, so every point is already at its true pressure — but the km markers and FL are pressure altitude, not true height. The ground line shows where the surface lies: at low QNH the lowest layers are below ground (e.g. the 0–1000 ft layer at QNH 986), at high QNH the ground is below 1013 hPa. A **dashed line** in the area-profile colour joins the METAR temperature to the lowest aircraft layer above the ground, so a **surface inversion** (clear calm mornings: e.g. 20 Oct 2026 04 UTC −2 °C at the ground and +5 °C at 995 hPa, about 900 ft above it) or a steep, heated surface layer on sunny afternoons stands out; it joins two separate measurements — the real inversion is often much shallower (the Jokioinen sounding of the same morning had the whole +8 K within the lowest 80 m), and the **Airport** low-level profile resolves it in 200 ft bands when there is traffic. The METAR **dewpoint** is drawn as a green diamond on the same line (`Td 6°`). Hovering the line shows the METAR time, QNH, station pressure, temperature, dewpoint, spread T − Td, relative humidity, a quick cloud-base estimate (≈ 410 ft per K of spread), the lowest METAR cloud group, and the temperature difference to the lowest aircraft layer with its height above the ground (e.g. `+7.4 K — inversion`). The dewpoint is the only humidity value on the diagram — Mode S aircraft data carry none — so it is used for the surface parcel of Analysis *Full* (below) and for cross-checking, not drawn as a profile. Refreshed with the METAR every 10 minutes. On the Sounding page: **Area · now** with the current METAR, **Area · hour** with the METAR stored with that hour (hours stored before this existed have none), none for flights.

**Analysis button** — the **Analysis: Off** button at the right of the panel title runs an automatic analysis of the 60-min area profile. Click it (or scroll the mouse wheel over it) to step through the levels (Off → Levels → Stability → Turbulence → Advection → Full); the choice is remembered in the browser. Features are drawn across the plot with their labels at its right edge:

| Level | Adds |
|---|---|
| **Levels** | **Tropopause** (WMO lapse-rate definition: lowest level above 5 km where the lapse rate is ≤ 2 K/km and stays so over the next 2 km) as a violet band ± 1 000 ft, e.g. `TROP FL350 −56°` (`?` = little data above it); **0 °C level(s)** (dashed blue; a second crossing only for a real warm or cold layer of ≥ 1 K); **max wind** (`JET` when ≥ 60 kt) and a **low-level jet** below 5 000 ft (≥ 25 kt and ≥ 10 kt stronger than the air above), as a yellow tick at the right edge |
| **Stability** | **−10 / −20 °C levels** (dotted; with 0 °C they bound the temperature range where icing is possible in cloud — humidity is unknown); **inversions** (orange shading, `INV +2.5° FL035–045`; only when the warming exceeds twice the uncertainty of the two layer means and is below the tropopause); a **stability strip** right of the pressure axis comparing each layer's lapse rate with the dry and moist adiabats — red unstable (> 9.8 K/km), amber conditionally unstable (between moist and dry), green stable, violet inversion — with a key at the bottom left |
| **Turbulence** | **Wind shear / turbulence risk** between adjacent layers: vertical shear (kt / 1 000 ft) and the bulk **Richardson number** Ri from the temperature and wind profile; `TURB` (red bar) for Ri < 0.5 with ≥ 4 kt / 1 000 ft, `SHEAR` (amber) for Ri < 1 or ≥ 8 kt / 1 000 ft. The shear must exceed twice the uncertainty of the two vector-mean winds |
| **Advection** | **Warm / cold air advection** (red / blue bar next to the shear bar, e.g. `WAA +0.7K/h 850–700`) for the layers 850–700, 700–500, 500–400, 400–300 and 300–250 hPa, from the turning of the wind with height (thermal wind): wind veering with height means warm advection, backing cold advection; the rate is −f/(R·ln(p₁/p₂))·(V₁ × V₂), in K per hour. Geostrophic flow is assumed, so the friction layer below 850 hPa is left out; shown only when both winds are ≥ 10 kt, the wind turns ≥ 10° and the change exceeds twice its uncertainty. **Contrail formation levels** (Schmidt–Appleman criterion, kerosene, propulsion efficiency 0.3): two faint threshold curves above 500 hPa — dashed for air saturated with respect to water, dotted for dry air (about −42 / −51 °C at 250 hPa) — and a label such as `CONTRAIL FL290+ humid / FL330+ dry`: above the first level contrails form if the air is humid enough, above the second at any humidity. Whether they persist (ice supersaturation) cannot be told without humidity data |
| **Full** | **Dry thermal top**: the METAR surface temperature at the station pressure (see *Ground line*) lifted along the dry adiabat (orange line) to where it is no longer warmer than the profile, labelled e.g. `THERMAL TOP 2200ft AGL (FL031)` — the top of dry thermals, i.e. the daytime mixing height. When the surface air is colder than the air just above it (night, morning inversion) it shows `THERMALS: none (stable surface layer)`; when it cannot be computed, `THERMAL TOP: n/a (…)` gives the reason (no METAR temperature, too few low-level temperatures, no area profile data, or surface air warmer than the whole profile). No superadiabatic surface excess is added, so on sunny afternoons the real top is often somewhat higher. **Surface parcel with the METAR dewpoint**: the **LCL** (lifting condensation level, Bolton 1980) where the dry adiabat from the temperature meets the mixing-ratio line from the dewpoint (green dotted) — the base of cumulus formed from surface air, labelled e.g. `LCL 2,100ft AGL · METAR FEW030` with the lowest METAR cloud group beside it for comparison, and `Cu base` when the dry thermals reach it; above the LCL the parcel follows the moist adiabat (orange dashed). Where it is warmer than the profile its area is shaded (**CAPE**), and the label gives `CAPE … CIN … J/kg`, the **Lifted Index** at 500 hPa and the **equilibrium level** `EL FL…` (≈ top of a convective cloud), or `PARCEL stable (no CAPE) LI +9.2`. A spread T − Td ≤ 1.5 K adds `FOG / LOW ST risk`. Hovering the LCL bar gives the details. Parcel and profile use the plain temperature (no virtual-temperature correction, no humidity aloft), so CAPE is a rough indication; at night the surface parcel is usually stable and the LCL is mainly a check against low cloud. A layered stratus or fog deck is not a surface-parcel cloud, so the METAR base then differs from the LCL |

The analysis uses temperature and wind (humidity only from the METAR dewpoint at the surface, for the parcel of *Full*; contrail persistence cannot be told), lightly smoothed (3 layers, weighted by √ replies) whatever the Smooth selector shows, with layer thickness from the hypsometric equation; layers need ≥ 3 replies. Checked against the Jokioinen soundings of 8–10 Oct 2026: tropopause within about 0.5 km, 0 °C level within about 0.6 km (worst at night and low down, where data are sparse). Bulk Ri over 1 000–2 000 ft layers smooths out thin shear layers, so `SHEAR` / `TURB` marks are indications, not forecasts. Browser only (`static/js/skewt_analysis.js`); nothing is stored.

**Airport selector** — **Off** / **Overlay** / **Zoom** (right of Smooth): the **airport low-level profile** in amber — Mach/TAS temperature and wind per 200 ft band from 200 to 3 000 ft MSL, pooled from the landings (approach profile, `approach_history.prof_json`) and departures (climb-out profile, `departure_profiles`) of the last 60 minutes (`/api/lowlevel`). Each band is built from **every raw BDS 5,0 / 6,0 reply** on final or in the climb, not from the 30 s stored observations, so a busy hour gives some hundred replies per band — enough for low-level inversions that the 1 000 ft layers of the area profile smooth out. Dots: reply-weighted band temperature; thin bars: spread between flights (10–90 %).
- **Overlay** draws it on the normal diagram (it occupies roughly the bottom 1 000–900 hPa).
- **Zoom** changes the diagram to the surface … about 840 hPa (≈ 5 000 ft) with less skew, 25 hPa isobars, 5 °C isotherms, dense dry / moist adiabats and pressure-altitude marks every 1 000 ft; the airport temperatures are labelled and its winds replace the area winds in the barb column, the area profile is drawn for comparison.
- With **Analysis** at Stability or higher, significant airport inversions (same significance test as the area profile, with the spread between flights) are shaded amber and labelled `INV apt +1.2° 2600–3000ft MSL`, and a second, amber-framed stability strip shows the lapse rate of 600 ft slabs (a weighted fit of the 200 ft bands; single 200 ft steps are too noisy for a class of their own).
- Hover read-out: band (ft MSL and pressure altitude), number of landings / departures, temperature with the spread between flights, flights and replies, wind with its spread.
- Heights: the bands are MSL from the METAR QNH at the time of each flight and are plotted at their pressure altitude, like the area layers. Compared with the area profile at the same pressure altitude (within 50 km), the approach temperatures were 0.4 K colder on average over 23 hours on 9–10 Oct 2026 (single hours up to 1–2 K, part real, part representativeness); keep this in mind when comparing the two lines. Few flights → wide bars and no inversion marks; at night the profile is often empty. The choice is remembered in the browser.

**Smooth selector** — next to the Density slider: **Off** / **3 layers** / **5 layers** applies a vertical running mean (weights 1-2-1 or 1-2-3-2-1, each layer also weighted by √ of its number of replies) to the temperatures of the 60-min area profile, which makes lapse rates easier to compare with the adiabats. Display only: the hover read-out then shows the smoothed value and the layer's own value, and the 10–90 % bars stay unsmoothed. Strong smoothing also softens inversions and the tropopause. The aircraft overlay is not smoothed. The choice is remembered in the browser.

**Area profile** — the profile of all aircraft within `SOUNDING_RADIUS_KM` over the last 60 minutes (the same as the Sounding page's **Area · now**, refreshed every 5 minutes) is drawn in grey: temperature curve with its 10–90 % range bars and, when no aircraft is selected, its temperature values and wind barbs. With an aircraft selected it stays in the background as a reference.

**Why the range bars are wider low down** — the 10–90 % bars are much wider near the ground than at cruise level, and that is normal. The Mach/TAS temperature comes from two coarse values: Mach in steps of 0.004 and true airspeed in steps of 2 kt (see *Air temperature (BDS 5,0 + 6,0)* above). At cruise one step changes the temperature by about 2 K; at approach and climb speeds (Mach ≈ 0.25, 160 kt) it is roughly 7–9 K, so single low-level replies scatter widely. Typical daytime bar widths at EFHK (28 Sep – 11 Oct 2026): about 13–14 K at 0–1 000 ft, 12 K at 1 000–2 000 ft, 8–9 K at 2 000–4 000 ft and 5–6 K from 6 000 ft up; turbulent days widen them further. The mean line of a layer averages dozens of replies and is much steadier than the bars suggest — read the line, and use the bars as a measure of the scatter. More replies per layer make the mean steadier but do not narrow the bars.

**Data badge** — with the **Data quality** tick box at the right of the panel title ticked (default; the choice is remembered in the browser and shared with the Sounding page), the top-left corner of the diagram tells how much data the area profile rests on, e.g. `DATA GOOD · 66 aircraft · 1610 obs`: the number of distinct aircraft and observations in the window, coloured **GOOD** (green, ≥ 20 aircraft per hour of window), **FAIR** (amber, 8–19) or **LOW** (red, < 8). At EFHK a daytime hour has 25–70 aircraft within 150 km, about 20 per altitude band; around midnight UTC only 2–5, often a single aircraft per layer. Layers that rest on only **one or two aircraft** are marked with a small red ring and red value — single-aircraft values that can be off by several degrees or knots — and the key `○ = 1–2 aircraft` is added to the badge; the hover read-out gives the number of aircraft of every layer. The automatic analysis still runs on such layers, so features found in a LOW profile (inversions, shear, turbulence) deserve extra caution. Unticking **Data quality** hides the badge, the rings and the hover warning (the aircraft counts stay in the hover read-out).

**Sonde (radiosonde)** — the **Sonde** tick box in the panel title (off by default; remembered in the browser and shared with the Sounding page) adds the latest **Jokioinen radiosonde** (about 100 km north-west of EFHK) to the diagram for comparison: its temperature as a pink line, its **dewpoint** as a green dashed line — humidity aloft, which the aircraft do not report — and its winds as pink barbs along the right edge of the plot. The label below the top-left texts gives the launch time and the **age** of the sounding, e.g. `JOKIOINEN 12.10. 06 UTC · 4 h 35 min old`, and how much the area profile differs from it over the common layers, e.g. `Δ area−sonde: T +0.4 K (RMS 1.1) · wind 7 kt RMS · 18 layers`; the lines fade after 6 h and 12 h and the label turns amber after 12 h, so you can follow the live profile moving away from an ageing sounding. The hover read-out adds the sonde's temperature, dewpoint, relative humidity and wind at the same level. Many FMI open-data profiles stop early (00 UTC flights usually near 350 hPa); the label then adds `to 350 hPa`. Jokioinen is inland: at night it is often a few degrees colder near the ground than the airport area (a real difference, not an error of either). With no sounding in the last 36 h the label says so. The Live Map checks for a newer sounding (or a fuller copy of the shown one) every 2 minutes and whenever the page becomes visible again (browsers pause timers in background tabs); the server answers briefly while the shown copy is still current.

**RH (trial)** — the **RH** tick box in the panel title (off by default; remembered in the browser and shared with the Sounding page) adds a narrow **RH strip** between the diagram and the wind barbs, scaled 0–100 % (dotted lines at 40 and 70 %). It shows the trial **moisture indicator** of the Sounding page's Time–height section (see *Moisture (trial)* there): for 1 000–5 000, 5 000–10 000 and 10 000–15 000 ft a bar at the index (about the relative humidity, from the thickness of climbing and descending aircraft minus the Mach/TAS temperature, flights of the last 1–2 hours) coloured **dry** (brown, < 40 %), **moist** (green) or **humid** (blue, ≥ 70 %), with its ± range; faint when uncertain, a small arrow when above 100 %. With **Sonde** on, the radiosonde's relative humidity (from its temperature and dewpoint) is drawn in the strip as a pink line, so the two can be compared directly. Hover the strip for the index, its uncertainty, the number of flights, Tv − T before and after the sonde offsets, the sonde's mean RH of the layer and its RH at the level. The area profile is then requested with `moist=1`. A first trial: the offsets are still being learnt from the soundings.

**MEPS (model)** — the **MEPS** tick box in the panel title (off by default; remembered in the browser and shared with the Sounding page) adds the **MEPS** weather model (the 2.5 km model FMI uses; MET Norway open data, CC BY 4.0) as the mean over the same area as the Mode S profile: its temperature as a teal line, its dewpoint as a teal dashed line and its winds as teal barbs a little inside the sonde's, on the 10 pressure levels 1000 … 200 hPa. On the Live Map it is the model at the present time — the newest model hours, a forecast of up to +5 h, since each run appears about 2–3 h after its start; the label then says *(forecast)* — refreshed every 10 min; on the Sounding page the model at the time of the shown hour or flight. The label gives the run and lead time and the area profile minus the model (temperature bias / RMS, wind RMS); the hover read-out adds the model's temperature, dewpoint, relative humidity and wind at the level. *MEPS: no model data for this time* when nothing is stored for it (fetching off, MET Norway not reachable, or before the first runs arrived).

The soundings come from **FMI open data** (stored query `fmi::observations::weather::sounding::multipointcoverage`, CC BY 4.0): a background thread (`collector/sondes.py`) looks for each new sounding from the nominal hour of the 00, 06 and 12 UTC launches (launch is at about HH−30 min, so about 30 min after launch, with the balloon at about 10 km; the flight to burst height takes 1 h 45 min – 2 h), every 15 min until it appears (at most 8 h) — each look asks FMI only for the sounding that is due (a time window from 1 h before its nominal time to now), so while it has not appeared the answer is empty (under 1 kB) instead of the whole previous sounding (100–400 kB) — and then fetches it again every 15 min until it no longer grows (the same number of raw levels twice in a row and the last data at least 15 min old, at the latest 5 h after the nominal hour) — a profile published while the balloon is still climbing is shown early and completed as it grows; fills gaps of the last two days at start and fetches those two days again every 6 h, since FMI sometimes replaces an early, partial copy with a fuller one hours later. A copy is rewritten only when it has more levels, and the Sonde check then recomputes its rows. Each sounding is stored as one gzipped JSON file in `data/soundings/` (`jokioinen_YYYYMMDDHH.json.gz`, about 6 kB: the ascending part thinned to about every 3 hPa plus the turning points of the temperature and dewpoint curves) and kept `SONDE_KEEP_DAYS` (default 365) days — about 30 small HTTPS requests a day plus four 48-h re-checks (about 1–2 MB each), and one file write per sounding, or a few while one grows, nothing in the database. Optional `config.py` keys: `SONDE_FETCH` (default `True`), `SONDE_PLACE` (`"Jokioinen"`), `SONDE_KEEP_DAYS`, `SONDE_DIR`. The stored soundings are also verified against the area profile automatically — see the Sounding page's **Sonde check**.

**Quality check of the soundings** — FMI open-data profiles occasionally have a data gap after which the temperature is wrong (e.g. no data from 519 to 422 hPa, the temperature unchanged across the 1.5 km gap and the part above about 11 K too warm). A sounding is therefore cut at a gap of at least 25 hPa (or 500 m) when the air below it cools with height (≥ 5 K/km over the last ~800 m, so ≥ 5 K of cooling is expected across the gap), the temperature changes by less than 1.5 K across it, and the air above the gap again cools like the troposphere (≥ 4 K/km). Gaps at the tropopause, where the temperature is naturally flat, are kept. The check runs when a sounding is stored and when a stored file is read, so it also applies to files stored earlier; the file itself is not changed. A cut sounding shows `to 519 hPa (bad data above cut)` in the diagram label and `(cut)` in the Sounding page selector (hover for the reason), and its Sonde check rows are recomputed.

**Hover read-out** — moving the mouse over the diagram shows the nearest level: altitude (ft, FL, km), pressure, temperature and wind — for the selected aircraft's observations, otherwise (or above / below them) for the area profile, with its 10–90 % temperature range, wind spread, number of replies and number of aircraft (with a warning for layers from only one or two aircraft).

**When an aircraft is selected** the panel immediately loads the aircraft's full flight history from the database, then continues accumulating live updates:

- **Wind barbs** — drawn in the aircraft's colour for each stored altitude observation, labelled with direction and speed in the format **248° 24kt** (FROM direction, meteorological convention). Older history barbs are shown at 40% opacity.
- **Temperature curve** — a dot for each shown altitude observation, joined into a line, with the values (°C) next to them (thinned so they do not overlap). The temperature is available for most observations (Mach/TAS temperature, also computed for older stored observations); single values scatter by a few degrees, especially at low speed, so compare with the grey area profile.
- **Level indicator** — a dashed horizontal line showing the aircraft's current pressure level derived from barometric altitude via the ISA model. When temperature data is available a white-ringed coloured dot marks the point on the temperature curve; otherwise a small diamond appears on the pressure axis.

**Deselecting** — click an empty spot on the map, press **Esc**, close the aircraft's map popup (its ×) or use the ✕ in the aircraft detail panel to return the diagram to the area profile.

**Profile persistence** — the profile is pre-loaded from the database the first time you click an aircraft during a page session. Navigating to another page and returning, then clicking the same aircraft again, restores the complete historical profile instantly from the database rather than starting from scratch.

**Wind history density slider** — controls how densely history barbs are drawn. Each step equals a 400 ft minimum altitude gap between consecutive barbs:
- Position **1** (leftmost) — show a barb for nearly every 400 ft increment (dense, full detail)
- Position **8** (rightmost) — show barbs only every 3 200 ft (coarse, avoids overlap at high sample rates)
- Default is **2** (800 ft gap). The setting persists across browser sessions.

---

### Flights  `/flights`

Historical browser for all flights recorded in the database.

#### Filter bar

- **ICAO** — filter by ICAO24 address (partial match, e.g. `461F`)
- **Callsign** — filter by callsign (partial match, e.g. `FIN`)
- **Meteo only** — show only flights that have at least one meteo observation
- **Search** / **Reset** buttons
- Result count shown on the right

#### Flights table

| Column | Description |
|--------|-------------|
| ICAO | ICAO24 hex address |
| Callsign | Flight callsign if decoded |
| First seen (UTC) | Time the flight was first contacted |
| Last seen (UTC) | Time of last contact |
| Max alt | Highest altitude observed (ft) |
| Min alt | Lowest altitude observed (ft) |
| Obs | Total number of raw observations stored |
| Meteo obs | Number of observations with meteo data (highlighted if > 0) |
| Sounding | 🌡 Sounding button appears if the flight has meteo data AND an altitude range > 5 000 ft (suitable for a vertical profile) |

Flights are sorted newest first. Pagination at the bottom, up to 50 flights per page.

#### Flight detail modal

Clicking a flight row opens a modal showing:

- **Flight track map** — the aircraft's recorded path, with meteo observation points colour-coded by source (blue = MRAR, green = COMPUTED, amber = MHR)
- **Four time-series charts** — altitude, temperature, wind speed, wind direction over the flight duration
- **Observation table** — all meteo observations for the flight with UTC time, altitude, ground speed, source badge, wind, temperature, and pressure

#### Sounding link

The 🌡 **Sounding** button (visible on flights with sufficient altitude range) opens the Sounding page pre-loaded with that flight's vertical profile.

---

### Sounding  `/sounding`

Skew-T style atmospheric soundings with the Mach/TAS temperature (see [Air temperature](#air-temperature-bds-50--60)). User guide with the physics behind each view and worked examples (Sounding and Wind Map pages): [`doc/Sounding_Page_User_Guide.pdf`](doc/Sounding_Page_User_Guide.pdf). Three sources, selected with the buttons at the top left (the choice is remembered in the browser):

- **Area · now** (default) — all aircraft within `SOUNDING_RADIUS_KM` (150 km) of the receiver over the last 30 min, 60 min (default, `SOUNDING_WINDOW_MIN`), 2 h or 3 h
- **Area · hour** — the **hourly profile archive** (`profile_hours`): one stored profile per completed UTC hour, kept indefinitely — also after the observations themselves have been purged. Pick a date and hour; the hour list shows the observations used
- **Flight** — profile of a single flight: select a flight from the dropdown (flights with meteo data and an altitude range > 5 000 ft, most recent first), then **Load Sounding**. The flight info banner shows callsign, ICAO24, time range, altitude range and observation count. The Flights page's 🌡 Sounding button opens this page with the flight pre-selected

Two more buttons replace the diagram: **Time–height** shows the hourly profiles side by side as a time–height section (see [Time–height section](#timeheight-section) below), and **Sonde check** the automatic verification against the radiosonde (see [Sonde check](#sonde-check) below).

All three use the same altitude layers — 1 000 ft deep below 10 000 ft, 2 000 ft above (to 46 000 ft) — at the standard-atmosphere pressure of the layer's pressure altitude (Mode S altitude is referenced to 1013.25 hPa, so this is the measured static pressure). Temperature is the 10 % trimmed mean of the replies in the layer, wind the vector mean.

#### Skew-T diagram

The Sounding page uses **the same Skew-T diagram as the Live Map *Atmosphere Profile*** (user guide: [`doc/SkewT_User_Guide.pdf`](doc/SkewT_User_Guide.pdf)) (`static/js/skewt_chart.js`, shared by both pages), sized to the window: temperature profile with the 10–90 % bars, wind barbs with direction / speed labels on the right, dry and moist adiabats, hover read-out of each level, and the same controls — see the Live Map *Atmosphere Profile* above for how to read it:

- **Analysis** button (panel title; click or mouse wheel): Off / Levels / Stability / Turbulence / Advection / Full — the automatic analysis of the shown profile
- **Data quality** tick box (panel title): the data badge with the aircraft count, red rings on 1–2-aircraft layers and the hover warning — area profiles only (Area · now, and Area · hour for hours archived with the aircraft count); flight profiles come from one aircraft and have no badge
- **Sonde** tick box (panel title): the Jokioinen radiosonde (see the Live Map *Atmosphere Profile*) — Area · now: the latest sounding; Area · hour and Flight: the newest sounding launched by the end of that hour or flight (at most 36 h older), with its age counted to the middle of the hour or flight. With the tick box on, a **sounding selector** next to it lists every stored sounding (`12.10. 12 UTC`, partial ones with their top, `· to 350 hPa`): **Auto** follows the rule above, or pick any sounding to compare with the shown profile (the age is then counted from that launch). The level table gets the sonde columns (below)
- **RH** tick box (panel title): the RH strip with the trial moisture indicator and the sonde's relative humidity (see the Live Map *Atmosphere Profile*) — Area · now: the flights of the last 1–2 hours; Area · hour: the same values as the Time–height *Moisture (trial)* field of that hour; Flight: no aircraft value (one flight is far too noisy)
- **Smooth**: Off / 3 layers / 5 layers vertical running mean of the temperature profile
- **Airport**: Off / Overlay / Zoom — the airport low-level profile (200 ft bands from the landings and departures) **of the shown period**: Area · now — the selected window; Area · hour — that hour; Flight — the flight's time ± 15 min (`/api/lowlevel?…&end=`)

These settings are shared with the Live Map (remembered in the browser). The METAR ground line with temperature and dewpoint (and so the thermal top and surface parcel of Analysis *Full*) is drawn for **Area · now** (current METAR) and **Area · hour** (the METAR stored with the hourly profile); flights have none. The aircraft overlay of the Live Map does not apply here.

#### Indices panel

Between the diagram and the level table, the **Indices** panel lists stability indices and characteristic levels of the shown profile (**Mode S** column) and — with the **Sonde** tick box on — of the radiosonde shown in the diagram (**Jokioinen** column), computed by the same code (`static/js/skewt_indices.js`, built on the diagram's automatic analysis in `skewt_analysis.js`), so the two columns compare directly. Hover a row label for the definition and a value for details (pressure, all inversions / turbulence layers, the reason when a value cannot be given). The ⟨ button hides the panel (a slim *Indices* tab brings it back; remembered in the browser); on narrow screens the level table moves below the diagram.

| Group | Rows |
|-------|------|
| Surface & parcel | surface T / Td; LCL (cloud base of surface air, Bolton 1980); CCL and convective temperature (amber when the surface has reached it); dry thermal top; LFC; EL; CAPE; CIN (only with an LFC); Lifted Index (500 hPa); Showalter; K index; Total Totals; Vertical Totals (T850 − T500); precipitable water |
| Levels | 0 / −10 / −20 °C levels (with the number of further crossings); WMO tropopause; contrail formation levels (humid air / any humidity, Schmidt–Appleman) |
| Lapse rates & thickness | lapse rate 0–3 km above the ground, 850–500 and 700–500 hPa; 1000–500 hPa thickness; temperatures (sonde: and dewpoints) at 850 / 700 / 500 hPa |
| Wind | bulk shear 0–1 / 0–3 / 0–6 km (from the lowest layer); max wind; low-level jet; lowest inversion; turbulence layers; strongest thermal advection |

- **Mode S**: the aircraft temperature and wind layers; the surface point is the METAR temperature / dewpoint (Area · now: current METAR; Area · hour: the METAR stored with the hour; a flight has none, so the surface-based values are left out). The aircraft report no humidity, so Showalter, K index, Total Totals and precipitable water are sonde only; the parcel values (LCL, CAPE, LI …) use the METAR dewpoint at the surface only.
- **Sonde**: averaged into the same layers as the aircraft profile (1 000 ft below 10 000 ft, 2 000 ft above), with its own surface values (Jokioinen, about 100 km NW and inland) — the comparison shows measurement differences, not resolution. Values above the top of a partial sounding are left out.
- Heights are hypsometric from the surface point (feet above the ground for the parcel levels, above mean sea level for the isotherms); without a surface point flight levels. Plain temperature throughout, no virtual-temperature correction. Temperatures are not interpolated, and lapse rates and the thickness not computed, across a data gap of more than one missing 2 000 ft layer; the panel note lists such gaps and a LOW data warning when few aircraft are behind the profile.
- Colours: amber / red for values that indicate instability or strong gradients (e.g. Lifted Index ≤ −1 / ≤ −5, CAPE ≥ 100 / ≥ 1000 J/kg, K index ≥ 26 / ≥ 31, Total Totals ≥ 44 / ≥ 50, lapse rate ≥ 7 / ≥ 9 K/km, 0–6 km shear ≥ 40 kt).
- Checked on the hourly profiles at the launch hours of the Jokioinen soundings of 11–12 Oct 2026 (five with enough aircraft data): lapse rates within 1 K/km, 1000–500 hPa thickness within 1 dam, Vertical Totals −0.3 … +2.7 (mean +1.1), −10 / −20 °C levels within 800 ft, tropopause within 2 000 ft; the 0 °C level was 300–2 000 ft higher from the aircraft (850 hPa up to 2 K warmer: the low-level air at Jokioinen, inland, was colder) and the max wind 3–27 kt stronger (as in the Sonde check).

#### Level data table

The table on the right shows each altitude layer — the highest (lowest pressure) on top and the lowest at the bottom, as in the diagram — with:

| Column | Description |
|--------|-------------|
| Press (hPa) | Standard-atmosphere pressure of the layer centre |
| Alt (ft) | Layer centre (pressure altitude) |
| Temp (°C) | Trimmed mean temperature (hover: 10–90 % range) |
| Wind (kt) | Vector-mean wind speed (hover: vector standard deviation) |
| Dir (°) | Vector-mean wind direction (FROM, meteorological convention) |
| Obs T / W | Replies used for temperature / wind |
| A/C | Distinct aircraft in the layer (red: only 1–2, a single-aircraft value); the line above the table also gives the total aircraft of the profile |
| Sonde T | Radiosonde temperature at the layer's pressure (interpolated in log pressure) — with the **Sonde** tick box on; `–` above the top of the sounding |
| ΔT | Layer temperature − sonde (K); amber when more than 2 K |
| Sonde wind | Radiosonde wind direction / speed (kt) at the layer |
| ΔV (kt) | Length of the vector difference layer wind − sonde wind; amber when more than 10 kt |

#### Time–height section

**Time–height** (button next to Flight) draws the hourly profile archive as a time–height cross-section: one column per UTC hour, one row per altitude layer (1 000 ft up to 10 000 ft, 2 000 ft above), time running to the right — the weather passing over the receiver at a glance. The hour in progress is added live from the observations (dashed frame). The height scale is stretched near the ground (square root of the pressure altitude, so the 1 000 ft layers below 5 000 ft stay readable); the left axis gives altitude / flight levels, the right axis the ISA pressure.

| Control | Options | Description |
|---------|---------|-------------|
| Length | 24 h / 48 h / 72 h / 7 days / 14 days | Hours shown |
| ending | date (empty) · **Now** | The section ends at the end of that UTC day; empty or **Now** = up to now |
| Colour field | Temperature anomaly / Temperature change 3 h / Wind speed / Lapse rate / Vertical motion / Vorticity / Height of the pressure surfaces / Height change 6 h / Thickness temperature check / Moisture (trial) | See below |
| Barbs | tick box | Wind barbs (every second column / layer as space allows), with a halo so they read on any colour |
| Isotherms | tick box | The lowest 0 °C (solid), −10 and −20 °C (dashed) crossing of each hour, joined across hours |
| Tropopause | tick box | The tropopause of each hour (magenta dashed `TP`): the lowest layer above 5 km where the lapse rate falls to ≤ 2 K/km and the mean lapse rate to every layer within the next 2 km stays ≤ 2 K/km (WMO), from the ±1 h smoothed layer temperatures — only where the aircraft data reach above it (usually up to about FL420, so a high tropopause is not found) |
| Max wind | tick box | The height of the strongest wind above 10 000 ft in each hour when it is ≥ 50 kt (yellow `Vmax`): the level of the jet core |
| Sonde | tick box | Each Jokioinen sounding as its own narrow column at its launch time (pink frame), averaged into the same layers and coloured by the same field (temperature anomaly, wind speed, lapse rate, height of the pressure surfaces or moisture); hover it for the sonde values against the aircraft column of that hour |
| PNG | button | Saves the picture (with a title line) as a PNG file |

- **Temperature anomaly** — each layer's temperature minus the mean of the same layer over the shown period (blue colder, red warmer, full at ±6 K). Warm and cold air masses stand out; a front or trough passes as a sloping boundary (often reaching the ground first and the upper levels later, or the reverse), the night inversion as a cold layer near the ground, a falling tropopause as warming at FL340–FL380.
- **Temperature change 3 h** — the temperature minus that of the same layer three hours earlier (full at ±4 K): warm and cold advection as it happens.
- **Wind speed** — 10 kt colour steps: jets, low-level jets and their descent, calm layers.
- **Lapse rate** — from the temperatures of the layers below and above (smoothed over ±1 h, since a single hour's Mach/TAS layer means scatter by about 1 K): violet inversion (< −1 K/km), blue very stable / stable, grey normal (5–7), orange steep (7–9), red dry-unstable (≥ 9). Night inversions, subsidence inversions and the stable stratosphere above the tropopause show as violet / blue bands.
- **Vertical motion** (FL050–FL200) — rising (green) or sinking (orange) air in cm/s, full colour at ±3 cm/s, by the *adiabatic method*: air that rises cools and air that sinks warms at the difference between the dry adiabatic and the actual lapse rate, so the part of the local temperature change that the wind does not bring in is vertical motion, w = (advection − ∂T/∂t) / (Γd − Γ). The advection comes from the turning of the wind between the layers two below and two above (thermal wind: veering = warm, backing = cold advection), ∂T/∂t from the temperatures 3 h before and after, Γ from the layers next to it — all from the ±1 h smoothed values (the hover shows the two terms). The newest hours use a shorter time difference and are drawn fainter; the hour in progress has none. Tested on 24 Sep – 20 Oct 2026: typically 2–3 cm/s, with about 0.6–1 cm/s of noise (two independent halves of the aircraft agreed with r = 0.65–0.83); rising air ahead of fronts, steady sinking of 0.5–2.5 cm/s under a high, rising air twice as often with broken cloud as in clear sky, and a correlation of −0.47 with the 6-hour QNH change (falling pressure, rising air). Not drawn below 5 000 ft (the daily heating cycle) or above FL200 (small Γd − Γ and strong shear); heating in cloud (condensation) is not included, so ascent in cloud is underestimated.
- **Vorticity** (about FL130–FL390) — the relative vorticity of the hour, the spin of the wind field over 200 km: purple cyclonic (anticlockwise, troughs, the cold side of a jet), gold anticyclonic (ridges, highs), full colour at ±15 ×10⁻⁵ s⁻¹ (the Earth's own spin f at 60° N is 12.7). For each layer every aircraft within `KINEMATICS_RADIUS_KM` (default 200 km) is averaged first, and a plane u, v = a + b·x + c·y is fitted to their winds; ζ = ∂v/∂x − ∂u/∂y, with its standard error from the fit (hover: value, ±error, fraction of f, aircraft). A layer needs at least 6 aircraft spread over the area in two directions — below about FL130 the traffic follows the airport's approach and departure paths and rarely qualifies; outliers beyond 3 × the RMS are left out. Faint: error > 4 or fewer than 10 aircraft. Tested on 24 Sep – 20 Oct 2026: RMS 7–10 with an error of about 2.3 and an hour-to-hour correlation of 0.65–0.83 — trough passages show as cyclonic columns (e.g. 18 Oct 03 UTC with the tropopause descent), ridges and highs as anticyclonic. The long-term mean came out anticyclonic at all levels (−2 … −4); climbing and descending aircraft alone gave different means, so 2–3 units of that are probably a sampling effect of the fit, not weather (radiosonde winds rule out a common heading error: the aircraft − sonde wind across the track was only +0.7 kt). Divergence is computed and stored too but not shown: it is mostly noise. Stored per hour in `kinematics_hours` by the hourly jobs (back-filled at the first start from the observations still in the database, kept indefinitely); the hour in progress is computed live.

- **Height of the pressure surfaces** — the D-value of each layer: how far the pressure surface lies above (red) or below (blue) its height in the standard atmosphere, full colour at ±300 m, from the aircraft's GNSS − baro difference with the calibration against the soundings (see [GNSS height](#gnss-height-gnss--baro-difference)); median of the airframes of the hour (faint: fewer than 3). Warm air columns and highs lift the surfaces, cold air and lows lower them, so the D-value grows with height in a warm high and turns negative aloft in a cold low. The hover gives the surface's height above mean sea level, the D-value, its 6-hour change and the spread between airframes. Night hours with GNSS jamming have few values (jammed aircraft stop sending the difference).
- **Height change 6 h** — the D-value minus that of the same layer 6 hours earlier (full at ±60 m): falling surfaces (blue) ahead of a trough or front, rising (red) behind it and in a building high. On 20 Oct 2026 the surfaces fell 20–40 m per 6 h while the METAR QNH fell from 1037 to 1032 hPa.
- **Thickness temperature check** — the mean virtual temperature of each 5 000 ft layer from the height gained by climbing and descending aircraft between its bottom and top pressure surfaces, minus the Mach/TAS temperature of the same layers (full at ±2 K; faint: one flight). Near 0 when both are right; moist air near the ground makes the thickness temperature a few tenths of a kelvin warmer (virtual temperature). The hover gives both temperatures, the number of flights and the bulk FL100–FL300 value. First test (20–21 Oct 2026): agreement within about ±0.5 K per 5 000 ft layer after the calibration.
- **Moisture (trial)** — an experimental humidity indicator for 1 000–5 000, 5 000–10 000 and 10 000–15 000 ft (`collector/moisture.py`). Aircraft report no humidity, but moist air is lighter: a moist layer is a little thicker than a dry one at the same temperature, so the thickness temperature (virtual temperature Tv, from the GNSS heights) minus the Mach/TAS temperature T is the moisture of the layer, Tv − T ≈ 0.608 · q · T (the principle of the ADS-B humidity study at Amsterdam Schiphol). The signal is small — in the Jokioinen soundings of October 2026 about 0.9 K in humid and 0.2 K in dry air at 1 000–5 000 ft, 0.6 / 0.2 K at 5 000–10 000 ft, 0.45 / 0.15 K at 10 000–15 000 ft and under 0.3 K above, which is why higher layers are not shown — while a single flight scatters by about 1 K (1.8 K below 5 000 ft, where the altimeter error changes with speed and flaps). Each hour therefore averages the climbs and descents of ±1 h (±2 h below 5 000 ft; trimmed mean, at least 6 / 12 flights), subtracts an offset per layer and for climbs and descents separately, learnt against the soundings of the last 30 days (aircraft of ±2 h around the balloon vs the sonde's own Tv − T from its temperature and dewpoint, shrunk towards 0 with 3 soundings, so it starts small and follows the data), and divides by the value saturated air of the same temperature would give. The result, the **index**, is about the relative humidity of the layer: **dry** (brown, < 40 %), **moist** (green, 40–70 %), **humid** (blue, ≥ 70 %); faint where its uncertainty exceeds ±40 %. The ± combines the scatter of the flights with a systematic part of 0.3 K that does not average out (the first comparison with four soundings, 22 Oct 2026, gave aircraft − sonde differences that changed by 0.2–0.45 K from one sounding to the next — partly the 95 km between Helsinki and Jokioinen — an RMS of about 37 % in the index and no gain yet from the learnt offsets), so the index is uncertain by about ±30–35 % at 1 000–10 000 ft and ±50 % at 10 000–15 000 ft: read it as a tendency. With **Sonde** on, each sounding shows the same index from its own humidity (and its mean RH in the hover). The hover gives the index, its uncertainty, the number of flights and Tv − T before and after the offsets. Only where aircraft climb and descend (within the sounding radius, mostly near EFHK and Tallinn) and mostly in daytime; it says *when* and *at which height* the area is humid, not where. First look (20–21 Oct 2026): it followed the moistening from the dry high (5 000–10 000 ft: Tv − T +0.2 K on 20 Oct → +1.1 K on 21 Oct) but read about twice the sonde's change — the offsets are expected to settle this as soundings in varied weather accumulate.

Faint cells rest on fewer than 3 replies. Pink ▼ at the top mark the Jokioinen radiosonde launches; the strip below the plot shows the aircraft per hour (red: < 8, LOW data — typically around midnight; amber: < 20). Hover a cell for the hour, layer, temperature with its anomaly and 3-hour change, lapse rate, wind and aircraft; **click a column** to open that hour on the Skew-T (**Area · hour**). The settings are remembered in the browser.

#### Sonde check

**Sonde check** (fourth source button) shows how well the Mode S area profile agrees with the radiosonde, from the table `sonde_verification` that the hourly jobs fill automatically (`collector/sonde_verif.py`). Period buttons **7 d / 30 d / 90 d / 1 y** (remembered in the browser).

- **At launch** — every stored sounding is compared with the area profile of ±1 h around its launch (all aircraft within `SOUNDING_RADIUS_KM`, computed from the observations once the hour after the launch is over): temperature bias area − sonde and its standard deviation, wind vector RMS difference and speed bias. Tiles give the totals of the period, a table splits them by altitude band (0–5 000, 5–10 000, 10–20 000, 20–30 000 ft, above 30 000 ft) and a list shows each verified launch with the top of the sounding and the number of aircraft (red below 16, i.e. a LOW night profile; amber values: T RMS > 2 K, wind RMS > 15 kt).
- **By age of the sounding** — every archived hourly profile (`profile_hours`, once it is 3 h old) is compared with the newest sounding launched by the middle of that hour (+ 15 min, at most 24 h before). Two bar charts give the temperature and wind RMS difference by the age of the sounding (0–1, 1–2, 2–3, 3–4, 4–6, 6–8, 8–10, 10–12, 12–18, 18–24 h) with the at-launch value as a dashed line: how fast the atmosphere moves away from a sounding, and so what a live profile adds between the launches.

- **GNSS height calibration** — the correction of the aircraft GNSS heights of the pressure surfaces (see [GNSS height](#gnss-height-gnss--baro-difference)) per 5 000 ft band with the airframe cells behind it and the built-in default; **by aircraft type** the mean raw offset of the calibrated airframes of each type (e.g. 20–21 Oct 2026: A320 +12 m, A321 0 m, AT75 −7.5 m); and the **per-airframe altimeter offsets**: registration and type, the soundings the airframe was compared with, its raw mean offset after the band correction and the offset actually used (shrunk towards 0 until it has been seen at several soundings — only about 40 % of an airframe's offset repeated from one day to the next).

Layers count when they have ≥ 3 replies and lie within the sounding's range (FMI profiles may stop early). Jokioinen is about 100 km north-west and inland, so part of the difference is real (cooler nights near the ground), and the totals are pooled over layers (each row weighted by its layer count). Missing rows of the last 14 days are added at each run — soundings that arrive late, or a restart — so the table fills by itself; a few small inserts an hour. Rows made with an earlier version of a sounding (a fuller copy stored later, or a top cut by the quality check) have a different sounding top (`min_p`) and are deleted and computed again. Likewise, an hourly row compared with an older sounding because the one launched in that hour was stored only later (FMI late, or an extra launch found at start-up) is computed again with the right sounding.

#### MEPS check

**MEPS check** (fifth source button) compares the Mode S area profile with the **MEPS** weather model every hour — also at night and between the soundings — from the model profiles the background thread `meps` stores in `meps_hours` (`collector/meps.py`). Period buttons **3 d / 7 d / 14 d / 30 d** and a **≥ 8 aircraft** tick box (only hours with at least 8 aircraft behind the profile; both remembered in the browser).

- **Tiles** — hours compared, temperature Mode S − MEPS over 925–200 hPa (mean and RMS; day 05–19 UTC / night), wind vector RMS (day / night), and the heights of the pressure surfaces from the aircraft GNSS heights (D-values, see *Heights of the pressure surfaces*) minus the model geopotential over 850–250 hPa.
- **By pressure level** — two bar charts (RMS as the bar, the mean difference as a dot: Mode S warmer / faster when positive) and a table per level: hours, temperature mean / SD / RMS, wind vector RMS and speed difference, height difference with its SD and the correlation of the hourly heights.
- **At the soundings: method or distance?** — at each Jokioinen sounding (925–200 hPa) the Mode S profile minus the sonde, minus MEPS over the same area, MEPS at Jokioinen minus the sonde (small by construction: the model takes the sounding in), and the model's own difference between the Helsinki area and Jokioinen; above the list how much of the Mode S − sonde difference that distance explains (in October 2026 about 40 % of the temperature and 60 % of the wind difference — the Sonde check overstates the Mode S errors).

How it works: every 3 h a new MEPS control run appears in MET Norway's open archive (thredds.met.no) about 2–3 h after its start. The thread fetches its forecast hours +0 … +5 of temperature, wind, geopotential and relative / specific humidity on the 10 pressure levels in a 300 × 300 km box around the receiver every 10 km (one OPeNDAP request, about 1.4 MB, read with plain Python), averages the points within `SOUNDING_RADIUS_KM` (the same area as the Mode S profile; winds turned from the model grid to true north) and takes the model column at Jokioinen, and stores one row per valid hour. Each hour keeps the shortest lead: +0 … +2 from its own run are the verification values; the newest run's +3 … +5 are kept provisionally for the Skew-T (*forecast*) and replaced by the next run. The thread looks for new runs every 20 min, back-fills `MEPS_BACKFILL_DAYS` (3) days at the first start and retries runs not published yet. The Mode S layers (≥ 3 replies) are interpolated in log pressure to the model levels, and the model value of an hour is the mean of its start and end. The model is not the truth (about 0.3–0.5 K and 3–4 kt from the radiosonde), but it is there every hour and at the same place. When MET Norway cannot be reached nothing else is affected; the view says when no model data is stored.

---

### Wind Map  `/windmap`

User guide with screenshots and examples (Section 8 of the Sounding page guide): [`doc/Sounding_Page_User_Guide.pdf`](doc/Sounding_Page_User_Guide.pdf).

A gridded horizontal wind and temperature map built from the observations stored in the database: one wind barb per grid cell, averaged over the aircraft that crossed the cell in the chosen level band and period. It shows the horizontal structure that the area profile (one column within 150 km) averages away — where the jet core lies, how the wind changes across the region, and with **ΔT** the warm and cold air masses and frontal zones.

#### Controls

| Control | Options | Description |
|---------|---------|-------------|
| FL | 1 000 ft – 4 000 ft, FL050 – FL450 | Centre altitude. Low-altitude options (1 000–4 000 ft) are MSL altitudes (QNH corrected, see below); FL050 and above are flight levels |
| ± | 500 / 1 000 / 2 000 / 3 000 ft | Altitude band around the chosen level |
| Period | Last 1 h / 3 h / 6 h / 12 h / 24 h / Custom | Time window. **Custom** shows date+time pickers for any historical period in the database |
| Cell | 25 / 50 / 100 km | Square grid cells (the east–west size is scaled with latitude, so a cell is as wide as it is tall) |
| Min | 1 / 2 / 3 a/c | Show only cells with at least this many different aircraft |
| ΔT | tick box | Colour the cells by their temperature difference from the mean of the whole layer (see below) |
| GNSS ok only | tick box | Leave out the observations of aircraft while their GPS position was degraded (see *Positions* below) |
| Auto | tick box | Reload every 2 minutes (Last … periods), and at once when the page becomes visible again |
| Load | — | Runs the query (also Enter in the control strip). The page loads the map at once when opened |
| Isotachs | tick box | Lines of equal wind speed and the strongest analysed wind (see *Analysis* below) |
| Streamlines | tick box | Streamlines through the smoothed wind field |
| Isotherms | tick box | Lines of equal temperature at the level (dotted red, every 1 K, 2 K when the range exceeds 8 K) from the same smoothed field, with the band's temperatures moved to its centre |
| Heights | tick box | Experimental: height contours of the pressure surface and the geostrophic wind of the area (see *Heights* below) |
| Jet, ≥ 80 / 60 kt, Depth | tick box, speed, tick box | The jet-stream symbol of aviation charts along the axis of strongest wind; Depth also loads FL250–FL410 for its vertical extent (see *Jet stream* below) |
| Sonde | tick box | The Jokioinen radiosonde at the chosen level (see below) |
| Compare | Off / Change since previous period / Other level (thermal wind) + level | Purple arrows and cell tints comparing with the previous period of the same length, or with another level (see below) |
| ✎ Section | button | Vertical cross-section along a line: click A and B on the map (see *Cross-section* below) |
| ▶ and slider | 0 … −23 h | Moves the period back in whole hours from the chosen end (the label shows the new end); ▶ animates the last 24 hours, ■ stops (one frame about every second). On the first slider move or ▶ all 24 frames are loaded at once and kept in the browser, so dragging the slider and the animation show them without waiting; a thin strip under the slider marks the frames already loaded (the ones needed next are loaded first). With a *Last …* period 0 is *now* and the earlier positions end on whole hours (−1 = the last full hour), so the loaded frames stay valid while the clock runs; a changed setting or **Load** loads them again |

The settings (including a custom period) are remembered in the browser. The status line (with the ΔT and Compare legends) floats over the bottom left of the map, so the control strips keep their height while it changes. It shows the number of aircraft and observations used, the cells shown, the positions removed, the period, the mean temperature of the layer with the lapse rate used, and for low layers the QNH used with its source.

#### Averaging and reliability

Within a cell, each aircraft's observations are averaged first (wind as U/V components, so 350° and 010° give 000°), then the aircraft means are averaged — one aircraft with 30 stored replies counts as much as one with 3. The barb's **opacity** shows how many different aircraft are behind it: faint = 1, medium = 2, full = 3 or more (a single airframe's error, e.g. a heading or temperature bias, is not averaged out in the faint ones). The popup gives the aircraft and observation counts, the **spread between aircraft** (vector RMS difference of the wind, SD of the temperature) and how many of the aircraft had degraded GNSS.

How many aircraft to expect (50 km cells, ±2 000 ft, October 2026, medians): at FL350 about 50 cells with data in 3 h, of which about 25 with ≥ 3 aircraft (17 at night), about 10 in 1 h; at FL150–250 about 9 such cells in 3 h (3–5 at night), mostly within about 100 km of Helsinki; at FL050 and below only the 3–4 cells around the airport — for the lowest levels the airport low-level profile of the Live Map is the better tool.

#### Wind barbs

Each cell is represented by a standard meteorological wind barb at the cell centre:

- **Staff** — points FROM the direction the wind is coming from (meteorological convention)
- **Pennant** — filled triangle = 50 kt
- **Full barb** — line = 10 kt
- **Half barb** — short line = 5 kt
- **Calm** — open circle when averaged speed rounds to 0 kt

**Colour** indicates averaged wind speed: green < 15 kt, blue 15–30 kt, amber 30–50 kt, red > 50 kt (darker shades in the Light theme). When the cells are wide enough on screen, a two-line label next to the barb shows `direction° speed kt` and `temperature° N ac` (number of aircraft); zoom in to see the labels at small cell sizes. Hovering shows a compact tooltip, clicking opens the popup. The map style follows the page's Light / Dark button.

#### Temperature and ΔT

A ± band of 2 000 ft spans about 8 K of normal cooling with height, more than the horizontal differences. Each temperature is therefore moved to the band centre with the lapse rate fitted to all temperatures of the band and period (least squares, limited to −3.5 … +1.5 K per 1 000 ft; an inversion inside the band gives a positive value; about −2 K / 1 000 ft when there are too few points). The labels and popups show these level temperatures. **ΔT** is the cell temperature minus the mean of all cells of the layer (weighted by aircraft): blue cells are colder, red cells warmer, full colour at ±3 K, fainter with fewer aircraft. Differences of 1 K or less are within the Mach/TAS temperature noise of single aircraft; look for coherent areas of several cells.

#### Positions

Under GNSS interference an aircraft's broadcast position can freeze (the last fix is repeated while the aircraft moves on) or jump to a false (spoofed) place — e.g. a fixed point about 60 km east-north-east of St Petersburg and its decoding twin over the Sea of Åland. The wind itself (BDS 5,0 / 6,0) is not affected, but it would be drawn in the wrong cell. Always removed: **frozen** positions (the same position as the aircraft's previous stored row ≥ 10 s earlier while moving) and **jumps** (each aircraft's rows are split where a step is impossible — more than 3 NM + 800 kt × time — and only its largest consistent part is kept). With **GNSS ok only** also every observation inside a GPS degradation episode of the aircraft (the GPS Episodes table, + 120 s) is left out. That is off by default: at cruise levels about two thirds of the observations fall inside an episode (the Gulf of Finland traffic), while most of those positions still move normally (inertial / hybrid navigation).

#### Analysis: isotachs and streamlines

For these layers the cell winds are smoothed onto a regular grid of points half a cell apart (a Barnes-type weighted average with a Gaussian weight of one cell length, each cell weighted by its number of aircraft, up to 10). A grid point is analysed only when a cell centre lies within ¾ of a cell, so the field is drawn only where there are data — never extrapolated over empty areas. **Isotachs** are dashed yellow lines every 10 kt (20 kt when the speeds span more than 60 kt) with their values; **▲ max** marks the strongest analysed wind (it may lie at the edge of the data, so it is not necessarily the jet core). **Streamlines** are traced through the smoothed field with a small arrow showing the flow direction. Both follow the **Min** aircraft filter. The isotachs show where the wind strengthens — a jet stream at cruise levels, or the narrow speed maximum of a low-level jet — and the streamlines its curvature (troughs, ridges, confluence).

#### Heights and geostrophic wind (experimental)

With **Heights**, each cell also gets the height of the pressure surface from the aircraft's GNSS − baro difference (the [GNSS height](#gnss-height-gnss--baro-difference) calibration, NACp ≥ 8, outside GPS degradation episodes, moved to the band centre with the band's temperature; median of the cell's aircraft, in the popup with its D-value). The heights are smoothed like the winds and drawn as teal **height contours** (metres above mean sea level, every 5, 10 or 20 m depending on the range), only near cells with heights. The wind blows along the contours with the lower heights on its left, faster where they are closer together.

A plane fitted to all aircraft heights of the band (one point per aircraft and cell, outliers beyond 3 × the RMS — at least 20 m — left out; at least 6 points spread over 30 km in both directions) gives the **geostrophic wind** of the area, Vg = (g / f) × the slope: a dashed teal arrow **Vg** at the centre of the points, next to the mean measured wind of the same aircraft (**V**, grey); the hover and the status line give both, the slope (m / 100 km), the ageostrophic difference and the residual. In a high the real wind is somewhat stronger than the geostrophic and in a low weaker (curved flow), and the difference also shows the acceleration into and out of jet streams. First test (20–21 Oct 2026, a weak high): at FL250–FL350 within about 10–20° and 2–10 kt of the measured winds, poorer at FL180 and below (traffic clustered near Helsinki). To be tuned with more data — especially in stronger flow.

#### Jet stream

With **Jet**, the jet stream is drawn like on aviation significant-weather (SIGWX) charts: a thick line along its **axis**, an **arrowhead** at the downstream end, **barb flags** on the line at the maximum (pennant 50 kt, flag 10 kt, half flag 5 kt) with the level and speed (e.g. `FL350 107 kt`), and double **change bars** across the line where the speed has dropped by 20 kt, 40 kt … from the maximum. The axis is found in the smoothed wind field (the same analysis as the isotachs): the mean direction of the points with at least the chosen speed (**≥ 80 kt** as on aviation charts, or **≥ 60 kt** for weaker jets) defines the flow; the field is cut into sections across the flow two grid steps (one cell) apart, and in each section the strongest point lies on the axis. The sections with at least the chosen speed around the overall maximum form the jet (a single empty section is bridged); the axis position is smoothed over three sections.

The line is **solid** where the speed falls off on both sides of the axis inside the data — the axis is really seen — and **dashed** where the strongest wind of the section lies at the edge of the data, so the real axis is probably beyond what the receiver sees; the label then adds `↑ stronger beyond?`. At cruise levels the data reach about 250–300 km from Helsinki, and a jet is often wider than that: in the 16–18 Oct 2026 jet (85–114 kt) the maximum lay at the edge of the data in almost every 3-hour period, so the direction, speed and passage of the jet are right but the axis position is often uncertain.

With **Depth**, FL250, FL290, FL330, FL370 and FL410 (±2 000 ft, same period and cells) are loaded as well, and the label adds the levels where the wind at the jet maximum is at least the chosen speed, as on the charts: `330/410` = from about FL330 to FL410 (the levels next to each other around the shown one; slower to load). The hover gives all of it with the speeds per level.

#### Cross-section along a line

**✎ Section** turns the map into drawing mode: click the start point **A** and the end point **B** (Esc cancels). A panel at the bottom of the map then shows a vertical cross-section along the line for the map's period: all observations within one cell size of the line (e.g. ±50 km with 50 km cells), at all levels, binned every half cell along the line and into the time–height altitude layers (1 000 ft up to 10 000 ft, 2 000 ft above; pressure altitude on a square-root scale, ISA pressure on the right), each aircraft averaged first, with the same position checks as the map (`/api/windmap/xsection`). The colour field: **temperature anomaly** (minus the layer's mean along the section, full at ±4 K — fronts slope through it), **wind speed**, **wind across the section** (red blowing from the left to the right when looking from A to B, blue the opposite, full at ±60 kt — a jet across the line is a red or blue core) or **height of the pressure surface** (D-value from the GNSS heights). Wind barbs, the 0 / −10 / −20 °C isotherms; faint cells rest on one aircraft; hover for the values. The section is reloaded with the map when the period changes; × closes it. Low levels have data only near the airport.

#### Radiosonde at the level

With **Sonde**, the newest Jokioinen sounding launched before the end of the period (at most 24 h old) is shown at its launch site as a pink barb with a square dot (the Skew-T sonde colour), interpolated in log-pressure to the level's ISA pressure (the band centre in pressure altitude). The label gives the launch hour, the speed and the temperature; the popup the values, the age of the sounding at the end of the period and the difference from the nearest Mode S cell (within one cell size). If the sounding stops below the level, a pink ring says so.

#### Compare: change since previous period, thermal wind

- **Change since previous period** loads the previous period of the same length (e.g. 07–10 UTC for 10–13 UTC) and draws, in every cell with data in both, a purple arrow of the **vector change of the wind** (pointing in the direction of the change, longer for a larger change) with its size and the temperature change; the cells are tinted red where the level has warmed and blue where it has cooled (full at ±3 K) — the passage of a front or a trough shows as a band of cooling with a turn of the wind.
- **Other level (thermal wind)** loads the second level chosen next to it for the same period and draws in each common cell the **thermal wind** — the difference of the wind vectors from the lower to the upper level. It blows along the isotherms of the layer between the two levels with the cold air on its left. The cells are tinted by how the wind turns with height: **veering** (clockwise) = warm advection, red; **backing** = cold advection, blue (full at 30°, shown when both winds are at least 8 kt) — the same rule as the advection analysis of the Skew-T, now for every cell. The popup adds the turning angle and the lapse rate between the two levels. Mid levels (FL100–250) have cells mostly near Helsinki, so the thermal wind is usually available within about 100 km.

While a comparison is shown, the ΔT colouring is switched off (the tint shows the comparison) and the barb labels of the compared cells are replaced by the arrow labels.

#### Interpreting the map

Observations are concentrated along the main flight routes visible from your receiver — approach / departure corridors and overfly routes; areas with no traffic have no barbs. A longer period and a wider band populate more cells but may mix different weather; a shorter period gives a snapshot closer to current conditions. For a specific weather event use the Custom period.

#### QNH correction for low-altitude layers

Aircraft transponders always broadcast pressure altitude referenced to the ICAO standard pressure of 1013.25 hPa, regardless of what QNH the pilot has set. Above the transition altitude (FL050 / 5 000 ft) this is correct by convention — pressure altitude IS the reference. Below FL050, however, the difference between pressure altitude and true MSL altitude can reach several hundred feet when QNH departs significantly from standard, which is common in Finnish winter conditions (QNH can be 980–990 hPa, causing 600–900 ft of offset).

When a low-altitude layer (1 000–4 000 ft) is selected, the query window is shifted into pressure-altitude space:

```
pressure_alt = msl_alt + (1013.25 − qnh_hpa) × 27.3
```

For example, if QNH is 998 hPa, a request for the 2 000 ft layer queries pressure altitudes between about 1 916 ft and 2 916 ft (correction (1013.25 − 998) × 27.3 ≈ +416 ft, ±500 ft tolerance), which correspond to aircraft actually flying at 1 500–2 500 ft MSL. The displayed layer name always shows the MSL altitude you selected. The QNH is the **QNH of the period**: for a period ending within the last hour the current METAR (fetched by the server's background weather thread every 10 minutes), for an older period the METAR QNH stored with the hourly profile archive (`profile_hours`) nearest to the middle of the period (within 3 h); 1013.25 hPa when neither is available. The status line shows which (`QNH 1014 hPa (METAR 17 07 UTC)`). Raw pressure altitudes are never modified in the database.

---

### Windshear  `/windshear`

A dedicated real-time approach monitoring page for tracking aircraft established on ILS final approach. Live tracking is held entirely in RAM; the only data written to the database is one `approach_history` row per completed landing (used by the Approach History panel and the statistics panel).

> **Keep the page open for best results.** All client-side history buffers — wind barb accumulation, kinematic IAS−GS differential history, the windshear event log, and the go-around log — exist only in the browser tab running the page. Navigating to another page or closing the tab clears these buffers entirely. When the Windshear page is reopened, it starts fresh: aircraft currently on approach will appear immediately, but any history built up during the previous session (wind profiles along the approach path, earlier windshear events, go-around events from before the page was opened) is gone. If you are monitoring an active approach sequence or want to study the windshear log over multiple arrival waves, keep the Windshear page as a dedicated open tab.

![MODE-S Wind Approach / Windshear screen](doc/Mode_S_Wind_Approach_Screen_1.png)

#### Layout

The page is divided into seven main areas:

- **Left panel** — QNH display, approach traffic count summary, and ATC-style flight strips for all aircraft inside an ILS corridor. Strips extend the full height of the screen to maximise capacity during busy arrival sequences and are filtered to match the runway selected in the ILS profile dropdown.

- **Map (right top)** — Leaflet map showing all tracked aircraft with ATC-style callsign labels, ILS centreline overlays for all configured runways, and a 15 NM range circle centred on the airport. A map controls bar overlaid on the map provides: an aircraft count, an `ILS Only` filter that hides non-corridor traffic, four map theme buttons (`Dark` / `Grey` / `ATC` / `Black` — ATC and Black support overlay cycling through ILS-only, ILS+coastline, and ILS+coastline+water with repeated button presses), the `WR / ACI` toggle (Wind Rose / Approach Conditions Index panel), and the `Apch Hist` toggle.

- **Wind Rose** — a compass rose panel overlaid on the top-right corner of the map, toggled by the `WR / ACI` button (enabled by default). Displays METAR surface wind as a cyan arrow and the MODE-S derived approach wind as a green arrow, both pointing in the downwind direction. The MODE-S wind is vector-averaged from low-altitude observations (≤ 2 000 ft) harvested from aircraft that have completed approaches in the last 30 minutes; observations recorded during grey (`meteo_source = NONE`) periods are excluded from the average, as are observations taken while a GPS position freeze is detected (same position-freeze gate as Approach History). Runway end labels are shown at the correct threshold positions. A numeric readout below the rose shows direction, speed, observation count, and age for each source.

- **Approach History** — a scrollable table panel overlaid on the top-left corner of the map, toggled by the `Apch Hist` button (hidden by default). Logs each completed landing approach with columns: UTC time, callsign, registration, aircraft type, runway, and wind at altitude bands. The server records all 15 bands at 200 ft resolution (200, 400, 600 … 3 000 ft, ±100 ft tolerance per band) and persists every approach to a SQLite `approach_history` table so data survives server restarts and accumulates over weeks. **Callsigns are shown in amber-yellow when the aircraft performed one or more go-arounds before its final landing** — hovering the callsign cell shows a tooltip such as `2× go-around`; normal approaches remain in light blue (in the Light theme the callsign, runway and wind-component colours are darker shades of the same hues, as are the ILS profile dots and labels). **GPS-jammed aircraft are logged even when their position freezes at altitude:** if an aircraft's frozen altitude suppresses the descent-rate confirmation (preventing the tracker from reaching the `APPROACHING` state), the approach is still committed to history as long as a runway assignment was confirmed — band wind columns show `—` in this case but runway usage and aircraft-type statistics remain accurate. **Duplicate commit prevention:** a 5-minute per-ICAO cooldown (`COMMIT_COOLDOWN_SEC = 300`) suppresses a second history entry if the same aircraft commits again within 5 minutes of a previous commit; this prevents duplicate rows when an aircraft briefly loses ADS-B contact (causing a stale-prune and re-admission within seconds) while still correctly recording go-around second approaches, which always occur more than 5 minutes after the first landing. A **position-freeze gate** prevents GPS-jammed frozen-position sweeps from contaminating band data: if an aircraft's altitude has dropped more than 100 ft since its position last moved, while `dist_thr_nm` has not advanced by at least 0.05 NM, the position is considered frozen and no wind is written to any band for that sweep — the affected bands remain `—` rather than showing wind computed from a stale groundspeed vector. The reference point only moves when the position moves, so a freeze is flagged after roughly 8–10 s of descent on a stuck position (comparing consecutive 3-second sweeps would never reach 100 ft on a 3° glideslope); the tracker stays current through genuine `NONE` meteo gaps so it does not false-fire when EHS data recovers after a jamming window. **Band altitudes are MSL:** transponders report pressure altitude, so once the METAR QNH is known the server converts it with `(1013.25 − QNH) × 27 ft` before matching bands; the QNH used is stored with each record (`qnh_hpa`). Records without a METAR QNH have `qnh_hpa = NULL` and their bands are raw pressure altitude, so on days far from 1013 hPa they are shifted relative to the others. **Landings tracked through the threshold:** normally a landing is recorded when the receiver loses the aircraft on short final. If the aircraft is still tracked when it crosses the threshold, the crossing itself is detected (along-track distance to the threshold of the runway it was established on ≤ 0.2 NM); after 60 s without climbing (longer than the ground roll of a touch-and-go) the landing is committed with the threshold-crossing time and that runway. A climb of more than 200 ft after the crossing cancels it and counts as a go-around — a low go-around or touch-and-go (see [Go-around detector](#go-around-detector)). The panel height scales dynamically with the map container so the full available screen height is used. A **time filter row** (1h · 3h · 6h · 12h · 1d, default 3h) selects the displayed window; the server queries the DB directly for the selected period. To the right of the time buttons, a **date picker** (`dd.mm.yyyy` text field + 📅 calendar button) switches the panel into *date mode*: all approaches for that full UTC day are fetched from the DB and the time-window buttons are dimmed; a **Live** button (always visible, highlighted in blue during live mode) exits date mode and resumes the rolling-window view. The `dd.mm.yyyy` text field accepts typed digits with auto-inserted dots and always displays in that format regardless of OS locale; the 📅 button opens the native calendar for mouse users. The UTC column shows plain `HH:MM` for today's approaches and `D.M HH:MM` (e.g. `26.5 14:32`) for entries from a previous date, keeping multi-day views unambiguous. The title line shows the number of landings in the selected window or date directly after the title (e.g. `Approach History – 24 landings`), in the same small font. A **registration filter** box (`Reg: OH-A`) to the left of the date field shows only the aircraft whose registration starts with the typed text — e.g. `OH-ATR` for one aircraft or `OH-A` for a whole series; upper / lower case and the hyphen are ignored (`ohatr` works too) and `Esc` clears it. The filter applies at once, stays active across the automatic refreshes and window / date changes, and the title then shows e.g. `Approach History – 3 of 24 landings`. All interactive controls sit on a single control row below the title. A **Lo / Hi** button selects the column count: Lo shows 8 columns (600 / 800 / 1 000 / 1 400 / 1 800 / 2 200 / 2 600 / 3 000 ft) for a compact overview; Hi shows 13 columns (600–3 000 ft at 200 ft steps) and the panel expands to fit them all without scrolling. The server captures all 15 bands down to 200 ft in the DB; the 200 and 400 ft display columns are simply not shown as no data is currently received at those altitudes at EFHK. A **display mode dropdown** to the right of the Live button selects what is shown in the altitude columns:

- **Wind** — raw wind as `dir°/spd kt` (e.g. `310°/17`)
- **HW** — headwind component in knots, sign indicates direction: `+12` = headwind (into the aircraft), `−5` = tailwind; colour-coded green (headwind) / red (tailwind) / amber (near-zero). Default mode.
- **XW** — crosswind component in knots, signed the same way as the ILS profile XW labels: `-17` means 17 kt crosswind **from the left** of the aircraft on approach; `+8` means 8 kt crosswind **from the right**. The sign indicates the **source side** of the wind — where the wind is coming from — not the direction it blows across the runway. A left crosswind (`-`) pushes the aircraft to the right, requiring a left crab correction to maintain centreline. Colour-coded green (< 5 kt) / amber (5–9 kt) / red (≥ 10 kt).
- **HW+XW** — both components in a two-line cell: headwind on top, crosswind below, separated by a hairline rule; each value is independently colour-coded.
- **Cond** — approach conditions instead of the wind bands (see [Approach roughness logging](#approach-roughness-logging) and [How the Approach Conditions Index (ACI) is calculated](#how-the-approach-conditions-index-aci-is-calculated)): the provisional **Index** (0–10, coloured badge + level *Smooth / Light / Choppy / Rough / Very rough*), the segment indices **Hi** (3 000–1 000 ft) and **Lo** (1 000–200 ft), and as `hi / lo` pairs the **Bank°**, **IAS** (kt) and **VS** (ft/min) fluctuation and the **Crab°** variation, the mean **Crab** angle (`+` = nose right of track, wind from the right) and the **METAR** wind at landing time. Hovering a row shows the full breakdown. `—` = not enough data (e.g. landings before the logging started, or contact lost before the aircraft was established). The panel widens to fit these columns; the Lo/Hi button is not used in this mode.

There is no Clear button — data is persistent and the time filter or date picker controls what is visible.
- **ILS vertical profile (bottom left)** — a canvas rendering the 3° glideslope reference line for the selected runway from 0 to 15 NM, with all corridor aircraft plotted at their current distance and QNH-corrected altitude. Colour-coded zones show the glideslope tolerance band. An optional wind barb overlay accumulates per-aircraft barbs during the approach; barb display is selected by clicking a flight strip or using the `Auto` mode which always tracks the lowest aircraft on approach. Each barb is coloured from the `meteo_source` at the time it was captured — barbs recorded during a grey (NONE) period remain grey permanently even after the aircraft's data recovers, so the canvas gives an honest picture of data quality throughout the approach; observations from grey periods are not added to the barb buffer at all, leaving a visible gap rather than a repeated stale position.

- **Windshear Alert + Today's Statistics (bottom right)** — the right portion of the bottom row is split 55/45: the left side is the windshear alert log (compact one-line entries with hover tooltip for full detail); the right side is a statistics panel showing today's runway usage and top aircraft types as percentage bars, refreshed every 5 minutes from the approach history database.

- **METAR / TAF strip** — displayed below the map and ILS profile in the right column, showing the latest decoded METAR and TAF for the configured airport. Does not overlap the flight strips panel.

#### ILS corridor detection

Aircraft are accepted into the display using precise geometric corridor matching combined with a track heading check. For each of the configured runway ILS centrelines, the system computes:

- **Cross-track offset** — perpendicular distance from the extended ILS centreline (signed: positive = right of centreline, negative = left)
- **Along-track distance** — projection along the centreline from the runway threshold (positive = aircraft is approaching, not yet at threshold)

An aircraft matches a runway only when all conditions hold:

```
|cross-track offset| ≤ WINDSHEAR_CORRIDOR_HALF_WIDTH_NM       (default 1.5 NM)
0 ≤ along-track distance ≤ WINDSHEAR_MAX_ILS_NM                (default 25 NM)
|track − approach_heading| ≤ max_track_dev                     (default 60°, RWY 33: 45°, when track available)
altitude ≥ (thr_elevation + dist_thr × GS_FT_PER_NM + QNH corr) − 1 000 ft   (glideslope floor)
```

The along-track gate excludes aircraft that have already passed through the threshold (negative along-track), such as aircraft that have landed and are rolling out. The track heading gate is the primary defence against **parallel-runway departures**: at EFHK, the two parallel runway pairs (04L/22R and 04R/22L) are only about 0.9 NM apart — well within the cross-track corridor — so a departure on 22L flying ~220° would otherwise pass the geometric gates for the 04L corridor (approaching its threshold from the north). The 60° track tolerance rejects it immediately since 220° is ~173° from the 04L approach heading of 047°. The same logic applies to all configured runways automatically.

**RWY 33 uses a tighter 45° heading gate** (vs the default 60°) because it is an RNP approach with no ILS localizer, making it more vulnerable to false detections from traffic vectored to RWY 22L/22R from the south. Such aircraft typically fly northward headings of ~010°–020° (47°–57° from RWY 33's 323° heading), which pass the 60° gate but are rejected by the 45° gate. The per-runway gate is set via a `max_track_dev` field in the runway definition; runways without this field use the global default.

**The glideslope floor** rejects any corridor match where the aircraft is more than 1 000 ft below the theoretical 3° glidepath at its current distance from the threshold. This is the primary filter for traffic overflying the RWY 33 approach area at 12–15 NM while being vectored to other runways: at those distances such traffic is typically 1 000–2 500 ft below the glidepath. Legitimate approach aircraft always clear this gate — even an aircraft 800 ft low of the glidepath has a 200 ft margin. The floor applies to all runways but has no practical effect on the five ILS runways under normal operations. Because transponders report pressure altitude, the expected glidepath altitude is shifted by the QNH correction `(1013.25 − QNH) × 27 ft` once the server has a METAR QNH (until then no correction is applied). Without it, on a high-pressure day (e.g. QNH 1045, where pressure altitude reads ~850 ft below true altitude) a legitimate approach only slightly low of the path was rejected; the server-side glideslope status (`gs_status`) uses the same correction.

The track check is skipped when track data is not available for an aircraft (rare at low altitude); those aircraft fall back to geometry-only and floor-only matching.

For airports with parallel runways (EFHK has 04L/04R and 22L/22R), an aircraft can fall inside both parallel corridors; the runway with the smallest absolute cross-track offset wins.

**Entry state gate** — an additional filter rejects departing aircraft that briefly pass all the geometric gates near the threshold. Any aircraft that enters the tracker for the first time while climbing faster than +200 fpm is silently discarded. Existing tracked aircraft are fully exempt from this check: a go-around aircraft begins climbing while already present in the tracker, so the gate never interferes with legitimate missed-approach detection.

Aircraft that are within the outer radius and altitude limits but outside any ILS corridor remain visible on the map (shown dimmed) but do not appear in the flight strips.

#### Flight strips

Each aircraft inside an ILS corridor gets an ATC-style flight strip in the left panel, sorted by distance from threshold (closest first); the strip list scrolls with the mouse wheel or touch without a visible scrollbar. The runway selector above the ILS profile canvas also filters the strips — selecting RWY 04L shows only 04L strips; selecting 04L & 04R shows both parallel approaches simultaneously.

The strip layout is fixed — every row is always rendered so the strip never shifts in height as data arrives:

- **Row 1** — Runway designator · vertical rate (fpm) · glideslope badge · squawk badge · WS badge
- **Row 2** — Callsign · **2nd APP / Nx APP** return-approach badge · aircraft type (all always shown; `—` when unknown)
- **Row 3** — Registration · ICAO24 hex code (both always shown)
- **Data grid** — two-column grid with labelled fields:

| Field | Description |
|-------|-------------|
| **RWY** | Large runway designator (04L, 22R, 15, etc.) |
| **↕ fpm** | Vertical rate — arrow up/down, colour-coded |
| **GS badge** | ON (green) / HIGH (amber) / LOW (red) / FAR (grey) — position relative to the 3° glideslope, computed client-side with full QNH correction applied (same correction as the ILS canvas) so strip badges always agree with the profile canvas |
| **Squawk badge** | SSR Mode-A transponder code decoded from Mode-S replies; grey pill for normal codes, red pill for emergency codes (7500 HIJACK, 7600 NORDO, 7700 MAYDAY) |
| **WS badge** | Pulsing amber/red badge when inside a detected windshear layer (visible only when detection is enabled) |
| **Alt** | Pressure altitude (ft) |
| **Dist** | Distance from runway threshold (NM) |
| **Wind** | Wind direction / speed decoded from EHS or JSON |
| **HW** | Headwind component along the runway heading (positive = headwind, negative = tailwind) |
| **Temp** | Temperature (°C) |
| **GS** | Groundspeed (kt) |
| **IAS** | Indicated Airspeed (kt) decoded from BDS 6,0 — shown when available, `—` otherwise |
| **XT** | Cross-track offset from centreline (NM) |

**Emergency squawk alarm** — when any tracked aircraft squawks 7500 (hijacking), 7600 (radio failure / NORDO), or 7700 (general emergency), a blinking red alarm banner appears at the top of the page, a ⚠ flash label blinks on the corresponding flight strip, and the squawk badge turns red. The alarm clears automatically if the code is no longer received. All tracked aircraft are scanned for emergency codes, not only those inside the ILS corridor.

Callsign stability — once a callsign has been decoded from either the ADS-B identification message (Beast feed) or the Radarcape JSON `fli` field, it is cached in the tracker and will never revert to the ICAO24 code even if some subsequent sweep cycles arrive without a callsign value.

#### ILS vertical profile

The canvas on the bottom left plots all corridor aircraft on a distance-vs-altitude graph:

- **X axis** — distance from threshold (0 NM at right = threshold, up to 15 NM at left)
- **Y axis** — pressure altitude (ft)
- **Dashed blue line** — 3° ILS glideslope reference, correctly positioned in pressure-altitude space
- **Blue shaded band** — ±300 ft glideslope tolerance zone
- **Coloured dots** — each aircraft, coloured by glideslope status (green = ON, amber = HIGH, red = LOW, grey = FAR)
- **History trails** — faint white line showing the aircraft's path over the past 10 minutes
- **Near-ground stale indicator** — when an aircraft is below 1 000 ft and no data has been received for more than 10 seconds (signal likely lost on short final), its dot fades to a dimmed blue and the label is removed. The dot remains at its last known position until the tracker removes it after the normal 30–45 second timeout
- **Labels** — callsign, or the ICAO24 code when no callsign is known (e.g. `FIN3GJ`), drawn on top of the wind barbs on a small background box above-right of the dot (above-left near the threshold; a label that would overlap another is moved up); the glideslope deviation is shown by the dot colour. A trailing **`*`** (e.g. `FIN64A*`) means the **autopilot is engaged**, as reported in the aircraft's ADS-B target-state message (TC 29). Only version-2 transponders report it, so no `*` means either autopilot off or not reported. The flight strip shows a framed **`AP`** box in its top row, left of the glideslope badge (hover: autopilot engaged, and whether approach mode is active); no box = autopilot off or not reported
- **Windshear zones** — amber/red horizontal bands between the altitudes of the two aircraft involved in a detected shear event (visible when detection is enabled)

The glideslope line accounts for two corrections applied at render time so that aircraft on the correct slope land exactly on the line:

1. **Threshold elevation** — the glideslope starts at the runway threshold altitude above MSL (configurable via `WINDSHEAR_THR_ELEVATION_FT`; EFHK ≈ 179 ft), not at sea level. The canvas uses this single value for all runways; the server-side corridor logic uses the per-runway values in `EFHK_RUNWAYS` (RWY 33 threshold is 148 ft, so its line on the canvas sits ~31 ft high)
2. **QNH correction** — MODE-S transponders always broadcast pressure altitude (1013.25 hPa reference). The glideslope reference is shifted by `(1013.25 − QNH) × 27 ft` to convert between pressure altitude and geometric altitude. At a QNH of 1000 hPa, this correction is approximately +357 ft. The current QNH is sourced from the live METAR and applied automatically; when QNH changes (polled every 10 minutes) the canvas redraws immediately.

The small annotation at the top-right of the canvas shows the active corrections so you can verify they are being applied — for example: `GS ref: thr+179ft  QNH+223ft  trim+0ft`.

A **manual trim** (`WINDSHEAR_GS_OFFSET_FT`) is also available for residual calibration errors such as slightly inaccurate threshold coordinates. Positive values shift the line up; negative shift it down.

#### Runway selector

The dropdown above the ILS profile header lets you filter by runway. It acts simultaneously as both a profile filter (only the selected runway's aircraft are drawn on the canvas) and a strip filter (only matching strips appear in the left panel).

Available options: **All runways**, **04L & 04R** (both parallel approaches together), **22L & 22R**, and each runway individually (04L, 04R, 22L, 22R, 15, 33). The paired options are useful during dual-runway operations at EFHK where both parallel runways are in use simultaneously.

#### Wind barb overlay

The **Barbs** button, located in the ILS profile header immediately to the right of the runway selector, enables a wind barb layer drawn directly on top of the ILS glideslope canvas. The feature is fully RAM-based — data accumulates while the page is open and is lost when you navigate away, consistent with the rest of the Windshear page.

**Enabling the layer:** click the Barbs button to toggle it on (it turns cyan). While active, the system quietly accumulates wind observations for every aircraft inside the ILS corridor in two independent parallel buffers — one at standard (Lo) resolution and one at high (Hi) resolution. Both buffers run continuously from the moment Barbs are enabled, regardless of which resolution is currently displayed.

**Selecting an aircraft manually:** with Barbs enabled, click any flight strip in the left panel. The selected strip gains a cyan left border and the ILS canvas immediately draws that aircraft's accumulated wind barb history on top of the glideslope profile. Each barb is drawn at the exact (distance from threshold, pressure altitude) position where it was recorded; only winds from fresh radar replies are recorded (older than `WIND_MAX_AGE_SEC` = measured higher up, see [Computed wind](#computed-wind-bds-50--60)), so low on final, where the radar replies often stop, the lowest barbs may be missing rather than repeated. A small `dir/spd` label appears above each barb showing the decoded wind direction and speed, and the aircraft callsign with total observation count is shown in the top-left corner of the canvas. Clicking the same strip again deselects it and clears the overlay.

**Auto barb mode:** the `Auto` segment attached to the Barbs button enables fully automatic aircraft selection. When active, the system selects the aircraft that is furthest along the approach (smallest distance from threshold — i.e. closest to the runway) and holds that selection until the aircraft goes stale and is removed from the display. At that point the next lowest aircraft is selected automatically, ensuring barbs are always visible as long as there is any approach traffic. The canvas corner label shows `· AUTO` when automatic selection is driving the display. Clicking any flight strip while Auto is active cancels automatic selection and pins the manually chosen aircraft instead — the Auto button deactivates to reflect this. Clicking the Auto segment again while Barbs is already off will enable both Barbs and Auto in a single click.

**Val (value labels):** the `Val` segment at the right end of the `Barbs · Hi · Auto · Val` group shows or hides the `dir/spd` label next to each barb. With Val off and no component mode active, only the barbs are drawn; with HW or XW active, only the component value (e.g. `+12`) is shown, placed just above the barb. Dcl is greyed out while Val is off since there is only one label to place. The corner label shows `· NOVAL` when values are hidden. The setting is remembered across page loads (`localStorage`) and is kept, greyed out, while Barbs is off.

**METAR surface wind at the threshold:** with Barbs on, the METAR wind is drawn as a cyan barb at the threshold (0 NM, threshold elevation), labelled e.g. `MET 050/9G19`; with HW or XW active the component for the same runway is added (`+9 HW`). It is the 10 m wind, the lowest true wind of the profile — aircraft winds usually end at 400–800 ft — so a change between the lowest aircraft barb and the surface (e.g. a wind veering 40° and dropping 6 kt) is visible. Refreshed with the METAR every 10 minutes.

**Barb convention:** barb staff points FROM the wind direction (standard meteorological convention). Pennant = 50 kt, full barb = 10 kt, half barb = 5 kt, open circle = calm. The barb colour matches the aircraft's meteo source colour (blue = MRAR, amber = MHR, green = COMPUTED, purple = JSON).

**HW / XW component annotation:** the button immediately to the right of the `Barbs · Hi · Auto · Val` split button cycles through three states on each click: **off → HW → XW → off**. The button label updates to show the active mode (`HW` or `XW`).

In **HW mode** (amber button) the headwind/tailwind component is shown at each barb: `+15` = headwind, `−8` = tailwind (knots implied, no unit shown), colour-coded **green** (headwind > 5 kt), **red** (tailwind < −5 kt), **amber** (near-zero). The component is computed as `wind_spd × cos(wind_dir − runway_heading)`.

In **XW mode** (orange button) the crosswind component is shown using the same `+`/`−` sign format as HW: `+8` = wind from the right of the centreline, `−3` = from the left. Colour-coded by magnitude — **teal** (< 5 kt, light), **amber** (5–9 kt, moderate), **red** (≥ 10 kt, strong) — matching the Approach History XW palette. Computed as `wind_spd × sin(wind_dir − runway_heading)`.

In both modes a second smaller label shows the raw `dir/spd` for reference (when `Val` is on). The corner label shows `· HW ref 04L (47°)` or `· XW ref 04L (47°)` to identify the mode and runway reference. The button is greyed out when Barbs are off and resets to off when Barbs are turned off.

**Dcl (declutter) label placement:** the `Dcl` button, immediately to the right of the HW/XW button, works for **both HW and XW modes** and becomes available as soon as either is active (and Val is on). When enabled, the component value moves below the barb and the raw `dir/spd` moves above it, using the barb staff as a visual separator — significantly reducing label overlap when barbs are dense. Near the top of the canvas both labels stack below the barb; near the bottom both stack above. The corner label shows `· DCL` to confirm the mode. Dcl resets automatically when the component mode is cycled back to off.

**Trk (trail) toggle:** the `Trk` button, immediately to the right of `Dcl`, shows or hides the faint position history trail drawn on the ILS glideslope canvas for each corridor aircraft. The trail is enabled by default (button is teal/active). Clicking it hides all trails without affecting barbs, NONE circles, or position dots — only the connecting line segments are suppressed. This is useful when wind barbs are dense and the trail adds visual clutter rather than clarity. The preference is saved to `localStorage` and restored on the next page load. The `Trk` button is fully independent of barb mode and can be toggled at any time. Note that the trail automatically breaks (shows a visible gap) at any position outage longer than ~10 seconds — both GPS freeze events (position stuck while altitude descends) and complete ADS-B dropouts produce a blank segment in the trail rather than a straight connecting line.

**Zoom toggle:** the `Zoom` button, immediately to the right of `Trk`, halves the horizontal range of the ILS glideslope canvas from 15 NM to 7.5 NM. With the same canvas width now covering only the inner half of the approach, each NM occupies twice as many pixels, giving wind barbs and their labels significantly more horizontal room. The button turns purple when active and the effect is immediate — the existing barb and trail history is redrawn at the new scale without waiting for a new poll. The distance grid steps at 2.5 NM intervals in zoomed mode (versus 5 NM at full range) so axis labels remain readable. Aircraft or barbs beyond 7.5 NM from the threshold simply fall outside the canvas and are not drawn; they are not discarded — the full 15 NM history is always buffered, so toggling back to the full view immediately restores them. Zoom pairs well with Hi-resolution barb mode: activating both gives the highest possible barb density in the critical low-altitude segment of the approach. The zoom state is not persisted across page loads and resets to the full 15 NM view on reload.

**Hi-resolution mode:** the `Hi` segment sits inside the `Barbs · Hi · Auto · Val` split button. Clicking it switches the canvas from the standard Lo buffer to the Hi buffer — a denser accumulation that stores a new observation whenever the aircraft has moved at least 150 ft in altitude or 0.2 NM along the track (versus 400 ft / 0.5 NM for Lo). The Hi buffer holds up to 100 observations per aircraft, enough to cover a full 15 NM approach at fine resolution. Because both buffers accumulate simultaneously, switching to Hi immediately shows the denser dataset already built up since the Barbs layer was enabled — there is no need to wait for a new approach. The Hi buffer is for research and visual inspection only; it is never used by any of the windshear detection algorithms, so enabling it has no effect on alert behaviour. The `Hi` button turns violet when active and the canvas corner label shows `· HI` to confirm the mode.

**Track lifetime:** only one aircraft's barbs are displayed at a time. Clicking a different flight strip immediately replaces the current overlay — no need to deselect first. When the selected aircraft lands and stops transmitting (typically 30–45 seconds after touchdown), its stored wind history is discarded and the overlay clears automatically. In Auto mode the next aircraft furthest along the approach is picked up on the same poll cycle, so the barb display stays continuous as long as there is approach traffic.

**NONE position markers:** in addition to coloured wind barbs, the canvas draws **small hollow circles** at every position where the selected aircraft's wind computation was suspended (`meteo_source === 'NONE'`). Circles are colour-coded by the reason for the suspension so the user can immediately distinguish normal maneuvering from a GPS problem:

- **Amber hollow circle (Turn)** — wind quality rejection: the aircraft has a valid, actively updating position but no wind could be computed — typically because the bank angle (> `WIND_MAX_ROLL_DEG`, 5°) or turn rate (> `WIND_MAX_TRACK_RATE`, 1°/s) exceeded the wind-calculation quality gates during a turn, or no fresh BDS 5,0 / 6,0 pair was available. Amber circles during localizer intercept or go-around turns are entirely expected and require no action.
- **Grey hollow circle (GPS)** — GPS-related suspension: either the position-freeze gate fired (`pos_frozen = True` — latitude/longitude is static while altitude descends, a GPS jamming signature), or no ADS-B position message is being received at all (GPS source dropped out). Grey circles on an established final approach are worth investigating.

Both corridor circle types persist alongside valid wind barbs once wind data recovers — they are not cleared when the aircraft transitions from NONE to valid meteo, so the full NONE history remains visible on the canvas for the duration of the approach. Circles are only removed after the aircraft has been absent from the feed for 45 seconds (browser-side; the server tracker itself drops an aircraft after 30 s), which means brief reception gaps caused by GPS jamming do not wipe the accumulated circle history. The canvas hint text includes a `(N pos-only)` count when NONE positions are accumulating but no valid wind data has arrived yet. The ILS profile legend shows amber **Turn** and grey **GPS** ring symbols for reference. The absence of any circles (no hollow rings at all alongside a gap in barbs) indicates that ADS-B position messages themselves have stopped arriving — a genuine position outage rather than a wind computation hold.

- **Small dashed amber circle (Pre-ILS)** — pre-corridor quality rejection: the aircraft is not yet inside the ILS corridor (cross-track or track deviation outside the corridor gates) but is producing `qc`-reason NONE data — the characteristic signature of a wide localizer intercept turn. These circles use a smaller radius (2 px vs 3 px) and a dashed stroke to distinguish them from established-approach circles. They are drawn using the `dist_nearest_thr_nm` field (distance to the closest runway threshold) as the X-axis position, giving an accurate placement even outside the corridor. Only `qc` events are shown pre-corridor — GPS-related NONE events outside the corridor are not visualised as they would be ambiguous. This prevents the common misreading where a wide turning arc before final looks identical to a GPS jamming gap.

Enable the barb layer during an active approach sequence to study how the wind profile evolves along the final approach path and correlate it with the glideslope position and any detected windshear zones.

#### Wind Rose

The `WR / ACI` button in the map controls bar toggles a compass rose panel that overlays the top-right corner of the Leaflet map. It is enabled by default. The rose compares two wind sources side by side:

**METAR surface wind (cyan arrow)** is parsed directly from the METAR string returned by `/api/wx` and is available immediately on page load, refreshed every 10 minutes alongside the METAR text. A variable-direction wind (VRB) is shown as a dotted cyan ring at the reported speed radius rather than a directional arrow.

**MODE-S approach wind (green arrow)** is derived from aircraft that have recently completed approaches. When a tracked aircraft disappears from the display (landed and gone stale after 30–45 s), the system automatically harvests any wind observations that were recorded below 2 000 ft and adds them to a 30-minute rolling buffer. The green arrow is the vector average of all observations currently in that buffer. Vector averaging (U/V decomposition) is used throughout so that direction wraparound near 360°/0° is handled correctly. The text readout below the compass shows the averaged direction and speed, total observation count, and how many minutes ago the most recent observation was recorded. The arrow and readout remain hidden until the first low-altitude observation has been collected.

The server maintains its own parallel rolling buffer (`_windrose_buffer`) using identical gate thresholds (400 ft / 0.5 NM minimum gap, 40 obs per aircraft, alt ≤ 2 000 ft, non-NONE meteo only). The buffer is retained for **6 hours** so that the Hist trend feature (see below) can populate all hourly buckets for a fresh browser session. Each observation in the buffer is assigned a unique timestamp (1-second spacing within the same landing batch, oldest first) so the client-side dedup set does not collapse multiple observations from the same aircraft into one. When the page is first loaded, `fetchWindroseObs()` pre-populates the client-side buffer with observations from the last 6 hours; the 30-minute window is only used for the main MODE-S averaged arrow, not for storage. The server buffer is re-fetched every **60 seconds** in the background so that aircraft landing mid-session are reflected in the Windrose within one minute; a seen-timestamp set prevents duplicate entries if the same observation appears in two consecutive fetches. Opening the Windrose panel (toggle ON) also triggers an immediate re-fetch so the panel always shows the freshest available data.

**Hist trend button** — a small **Hist** button below the canvas cycles through Off → 3h → 6h mode. When active, a colored dot is drawn on the compass ring perimeter at the bearing of each past hour's vector-averaged wind direction. Dot radius scales lightly with wind speed (3.5–7 px) so a calm bucket looks different from a strong one. Consecutive dots that have data are joined by a faint connecting line showing the direction drift path over time. Each hour bucket uses a distinct color: 0–1h amber, 1–2h orange, 2–3h rose, 3–4h purple, 4–5h violet, 5–6h slate. The dots are drawn on the compass ring perimeter and never overlap the center area where the METAR and MODE-S arrows are drawn, so live data remains fully readable with Hist active. An active range badge (e.g. `3h`) appears next to the button. Hovering the mouse over any dot shows a small tooltip (e.g. `0–1h: 270°/12kt`) in the dot's own color; hour buckets with no observations produce no dot and no tooltip entry.

The EFHK runway geometry is drawn on the compass as two plain crossing dashed lines: the 047°/227° line covers all four 04/22 runways (they share the same true heading), and the 152°/332° line covers RWY 15/33. Each end is labelled with the runway designator whose approach flies toward that compass direction — so the 047° (NE) end is labelled **22** and the 227° (SW) end is labelled **04**, because an aircraft landing on RWY 22 flies toward SW and its headwind comes from the NE. Speed-reference rings at 10, 20, and 30 kt are drawn inside the compass to give a visual sense of arrow scale; the full ring radius corresponds to 40 kt.

**Arrow convention:** both arrows point in the **downwind direction** — where the wind is blowing toward, not where it is coming from. This means the arrowhead always points toward the runway label that has a headwind. For example, wind from 050° produces an arrow pointing toward the SW/`04` end, instantly showing that RWY 04 approaches have the headwind. When both METAR and MODE-S arrows align with the same runway end, conditions are consistent; a divergence between the two arrows is a prompt to investigate further.

**Canvas timestamps** — the top-right corner of the compass canvas shows a UTC HH:MM timestamp alongside each source label: the cyan time is the METAR **issue time** parsed from the `DDHHMM Z` group in the raw METAR string (e.g. `281550Z` → `15:50`), and the green time is the timestamp of the **most recent MODE-S observation** currently in the 30-minute rolling buffer. Both use the same font and colour as the left-side dot labels. `--:--` is shown when no data is available for that source.

**METAR staleness colouring** — the METAR text in the weather strip below the map changes colour when the observation is getting old: **orange** at ≥ 60 minutes, **red** at ≥ 90 minutes, normal colour when fresh. Age is measured from the METAR issue time (same timestamp shown in the canvas corner), not from the browser's last fetch. The colour is re-evaluated every minute independently of the 10-minute fetch cycle so the transition happens on time.

**Rose | Cond view selector** — two buttons below the canvas switch the panel between the wind rose and the **approach-conditions chart** (the choice is remembered in the browser). The wind rose keeps its 265 × 265 px size; in the Cond view the panel widens to the full width of the map controls bar above it (its left edge lines up with the `N ILS corridor` counter), giving the time axis more room. The Cond view plots the conditions index (0–10, see [How the Approach Conditions Index (ACI) is calculated](#how-the-approach-conditions-index-aci-is-calculated)) of every landing of the last **3 h**, **6 h**, **12 h** or **1 d** (the range button replaces Hist in this view and cycles `3h` → `6h` → `12h` → `1d`) as one dot per landing, coloured by aircraft class (`N` narrowbody, `R` regional jet, `T` turboprop, `W` widebody, `B` business jet), over faint level bands (Smooth → Very rough), with a green **running median** line (±30 min, at least 3 landings). Hovering a dot shows time, callsign, type, runway and index. The readout below gives the median of the last hour with its level and landing count, the median and maximum of the chart range, and the latest METAR wind. Data is re-fetched every 60 s while the Cond view is shown.

The rose is intended to let you quickly judge whether the MODE-S wind profile measured during recent approaches matches the METAR surface observation — a useful sanity check for windshear monitoring and EHS data quality assessment.

#### Windshear Alert + Today's Statistics

The bottom-right area is split into two panels side by side (55 % / 45 %).

**Left — Windshear Alert log:** maintains a compact timestamped log of all detected windshear events and go-around detections during the current session, newest first. Each entry is a single line showing time, algorithm badge, runway, magnitude, and callsign(s). Hovering over an entry shows a full tooltip with algorithm, altitude band, individual headwind components, and exact timestamp. Events are deduplicated per algorithm, runway, and aircraft within a 60-second window. The log is cleared by the **Clear** button or on page refresh and does not persist to the database.

**Right — Today's Statistics:** shows two sections with a **Live / Yest / 1w** time range selector at the top. **Live** shows today's UTC data, **Yest** shows the previous UTC day, and **1w** aggregates the last 7 days. Both sections are refreshed every 5 minutes and also update immediately on range switch; the selected range persists across sessions. A 📅 **calendar button** placed after `1w` opens the native browser date picker — selecting any date switches both sections to show historical data for that specific UTC day. When a date is active, a compact blue badge showing the formatted date (e.g. `04 Jun 2026`) appears in the timerow with an inline `×` clear button; clicking `×` returns to the previously active Live/Yest/1w range. Clicking any range button also clears the date selection. Date mode is not persisted across sessions — the panel always opens on the last-used range. **Runway Usage** lists each runway with a percentage bar; the section label shows the total landing count for the selected range (e.g. "Total: 89"); tall enough to show all active runways without scrolling in most configurations, with a scrollbar available when all directions are in use. Below the runway bars a **go-around count line** (`Go-arounds: N`) shows the total number of go-around events within the active time window, computed client-side from the `go_arounds` field of each approach record; the label is shown in muted grey when the count is zero and in normal text colour when at least one go-around is present. **Aircraft Types** shows all distinct aircraft types sorted by approach count with percentage bars and a vertical scrollbar; the label shows the number of distinct types (e.g. "Total types: 23"); aircraft with no decoded type code are labelled `NIL`. Hovering over any row shows the exact count for that runway or type.

#### Go-around detector

The tracker continuously monitors each approach aircraft for a go-around (missed approach) using a server-side state machine. Detection requires no user action and runs regardless of whether the windshear detection toggle is enabled.

The state machine works in three stages:

1. **APPROACHING** — the aircraft is descending (vertical rate ≤ −200 fpm) inside the corridor. Consecutive polls confirming descent are counted. Only after a configurable number of descending poll cycles (default 8, configurable via `WINDSHEAR_GA_MIN_DESCENT_POLLS`) does the state advance to APPROACHING — this prevents go-around false triggers from aircraft that are still vectoring in and temporarily levelling.

2. **GO_AROUND detection** — from the APPROACHING state, two conditions must both be satisfied before a go-around is declared. First, the detector counts consecutive poll cycles where the aircraft's vertical rate is ≥ 600 fpm AND altitude is at or below 2 200 ft — a configurable number of consecutive climbing polls (default 3, `WINDSHEAR_GA_MIN_CLIMB_POLLS`) must be accumulated, equivalent to 9 seconds of sustained climb. Second, the actual pressure altitude must have risen by at least 50 ft since the climb started (`WINDSHEAR_GA_MIN_ALT_GAIN_FT`), guarding against barometric lag or vert_rate quantization where a high reported rate does not correspond to meaningful altitude change. If any poll during the window falls below the climb threshold both counters reset to zero. The climb rate and altitude ceiling are configurable via `WINDSHEAR_GA_CLIMB_FPM` and `WINDSHEAR_GA_MAX_ALT_FT`.

   **Climb-out at or after the threshold** — the corridor ends at the threshold, so a missed approach begun over the runway (a low go-around near the decision altitude, a low approach or a touch-and-go of training circuits) climbs outside it and cannot pass the climb gate above. These are caught by the threshold-crossing check (see *Landings tracked through the threshold* under Approach History): an aircraft that was APPROACHING, crossed the threshold of its runway and then climbs more than 200 ft above its crossing altitude before the landing is confirmed (60 s) is counted as a go-around on that runway. In the log they are marked `low`.

3. **Return approach tracking** — a go-around count is maintained per ICAO24 address on the server. An aircraft coming back for a second approach gets a **2nd APP** badge next to its callsign; a third approach shows **3x APP**, and so on. The count is cleared when the aircraft's landing is recorded, and forgotten 2 hours after the last go-around if the aircraft never came back to land (e.g. diverted), so a later visit of the same aircraft is not flagged as a return approach.

When a go-around fires:

- A blinking **✈ GO-AROUND** label appears on the flight strip (flashes for up to 60 seconds, configurable via `WINDSHEAR_GA_FLASH_SEC`)
- The event is appended to the **windshear event log** with a timestamp, runway, altitude at detection, and ordinal count (1st / 2nd / 3rd go-around this session); a climb-out at or after the threshold is marked `low` (`✈ GA 22L low`)
- Go-around log entries are always recorded even when windshear detection is disabled

**Tuning the detector** — the default values work well at EFHK but may need adjustment depending on traffic mix and local procedures:

- **False positives** (aircraft flagged as go-around when they are not): increase `WINDSHEAR_GA_MIN_CLIMB_POLLS` (default 3) to require a longer sustained climb, or raise `WINDSHEAR_GA_MIN_ALT_GAIN_FT` (default 50 ft) to require more actual altitude change before the event fires — both are useful in gusty or turbulent conditions. You can also increase `WINDSHEAR_GA_MIN_DESCENT_POLLS` (default 8) to require a longer confirmed descent before the state machine arms, or raise `WINDSHEAR_GA_CLIMB_FPM` (default 600 fpm) to ignore shallower climbs from glideslope corrections or level-offs.
- **Missed go-arounds** (aircraft that go around but are not detected): check `WINDSHEAR_GA_MAX_ALT_FT`. If an aircraft initiates a go-around above the 2 200 ft ceiling — for example on a high-energy visual approach or after a late ATC instruction — it will not be detected. Raise the ceiling to 3 000 or 4 000 ft to capture earlier go-arounds, bearing in mind that this also increases the chance of triggering on climbing traffic that enters the corridor from below. Missed approaches begun over the runway are counted only when the receiver still tracks the aircraft at the threshold; if contact is lost on short final for more than 30 s, the approach is recorded as a landing.
- **Flash duration**: `WINDSHEAR_GA_FLASH_SEC` (default 60 s) controls how long the blinking label stays on the strip after detection. Increase it if you want the indication to persist longer during a busy sequence.

#### Map

The Leaflet map shows:

- **Approach centreline overlays** from `overlays/efhk_ils.geojson` — each runway's extended centreline drawn as a line on the map; ILS runways (04L, 04R, 22L, 22R, 15) are styled in blue (`#38bdf8`) with a short dash pattern; the RNP approach to RWY 33 is styled in amber (`#f59e0b`) with a longer dash pattern so the two approach types are immediately visually distinct; the Leaflet style callback routes on the `approach_type: "RNP"` property in the GeoJSON feature; the RWY 33 centreline uses the true geographic runway axis (153.1°T outbound / 333.1°T inbound) as published on the approach chart — not the magnetic heading
- **Airport layout overlay** from `overlays/efhk_apt.geojson` — taxiways and runway markings
- **15 NM range circle** centred on the configured airport reference point
- **Aircraft markers** with callsign labels; corridor aircraft are brighter and have a higher z-index than non-corridor traffic
- **Tooltips** showing callsign, matched runway, altitude, and distance from threshold

**Map themes** — four tile layer choices accessible via buttons in the map controls overlay: Dark (CartoDB dark), Grey (CartoDB light), ATC (flat `#cfcfcf` radar grey, no tile imagery), Black (pure black background, no labels). The map follows the page's **Light / Dark** button: switching the page to Light changes Dark → Grey and Black → ATC, switching to Dark the other way (the overlay level is kept), and a page opened in Light starts with Grey; the four buttons still choose any style by hand. The ILS profile, wind rose and conditions chart are redrawn with the new colours at once.

The **ATC** and **Black** themes support **overlay cycling** — clicking the active button a second time does not re-apply the theme but instead cycles through three overlay levels: ILS centrelines only → ILS + coastline (`efhk_coast.geojson`) → ILS + coastline + water polygons (`efhk_aqua.geojson`). The button label reflects the current level (ATC / ATC+C / ATC+CA and Black / Black+C / Black+CA). A further click wraps back to ILS only. Each theme remembers its overlay level independently, so switching between ATC and Black retains the previous level for each.

Overlay layers on ATC use muted navy/steel colours that contrast clearly against the grey radar background; on Black the same layers use deep blue tones against the dark canvas.

**ILS Only toggle** — filters the map to show only aircraft currently inside an ILS corridor, hiding all other tracked traffic. Defaults **on** and resets to on when the page is reloaded (not persisted).

**WR / ACI toggle** — shows a compass rose overlay (top-right of the map) comparing METAR surface wind direction with low-altitude MODE-S wind observations from recent approach traffic.

**Approach History toggle** (`Apch Hist` button) — opens a floating table overlay (top-left of the map) that logs the wind profile for each completed approach; the title line shows the landing count for the selected time window or date. Every approach is persisted to the SQLite `approach_history` table and survives server restarts. The panel height scales dynamically with the map container. All controls sit on a single row: time-window buttons (1h · 3h · 6h · 12h · 1d, default 3h), a registration filter box (`Reg: OH-A`, prefix match), a `dd.mm.yyyy` date picker + 📅 calendar button for querying a specific day, a **Live** button (blue when in live rolling-window mode), and — after a separator — a **display mode dropdown** and a **Lo/Hi** resolution button. Columns: UTC time, callsign, registration, aircraft type, runway, and wind at altitude bands; registration and type show `—` when not available. Lo shows 8 columns (600–3 000 ft); Hi shows 13 columns (600–3 000 ft at 200 ft steps). The display mode dropdown offers five options: **Wind** (raw `dir°/spd`), **HW** (headwind component, default), **XW** (crosswind component — `+` = from right, `-` = from left, colour-coded by magnitude), **HW+XW** (both in a two-line cell) and **Cond** (approach-conditions index and its components per landing). See the Layout section above for a full explanation of the crosswind sign convention. There is no Clear button — data is persistent and the time filter or date picker controls what is visible.

#### Windshear detection

Windshear detection is controlled from the **Windshear Alert header bar**, which contains five inline controls: the **OFF/ON toggle button**, an **algorithm dropdown** (`Pair / Gradient / Energy / Rate / Baseline / Kinematic`), the **alert level** dropdown, the **Kinematic F-factor gate** dropdown, and the **Clear** button. Detection is **OFF by default** to allow monitoring of approach patterns before trusting automated alerts.

Six independent detection algorithms are available from the dropdown. Switching algorithm takes effect instantly and re-runs detection against the current aircraft set without waiting for the next poll. Only one algorithm is active at a time. Hovering over the dropdown shows a one-line description of each option.

**Shear direction:** every detected event is classified as `▼LOSS` (headwind decreasing — the operationally hazardous case) or `▲GAIN` (headwind increasing). The label appears in the alert banner, the ILS-profile canvas zone label, and the event log compact line. Severity thresholds (monitor / warning / alarm) are unchanged and based on the magnitude of the change regardless of direction.

**Noise reduction:** the Kinematic algorithm uses a 3-sample median on both the reference and the current measurement window, the Rate algorithm on the reference window (compared with the aircraft's current headwind) before computing the headwind differential. This suppresses single-sample transients (momentary IAS spikes, noisy BDS 6,0 decodes) without adding meaningful detection latency — three samples at the 3-second poll rate represent ~9 seconds of data.

**Establishment gate:** no algorithm can fire until an aircraft has accumulated at least 6 valid observations inside the corridor (≈15–20 seconds at the 3-second poll rate). This prevents false detections from the first wind snapshot, which is computed during the ILS intercept roll-out when the aircraft is transitioning from the turn onto final and the BDS 5,0/6,0 data is at its least stable.

**Grey (NONE) aircraft are excluded:** every algorithm skips aircraft whose current `meteo_source` is `NONE`, and their groundspeed / IAS samples are not added to the Energy and Kinematic buffers. An aircraft that goes grey during an intercept turn therefore cannot trigger an alert from a stale headwind value. This also means Energy and Kinematic only evaluate aircraft that currently have a valid computed wind.

All algorithms use the same headwind component formula:

```
headwind (kt) = wind_speed × cos(wind_direction − runway_heading)
```

Positive values represent a headwind; negative values represent a tailwind. The runway heading used is the approach heading from the tracker's runway table (true headings, e.g. 047° for RWY 04L/04R, 227° for RWY 22L/22R), matching the true wind direction from the wind calculation.

Events are classified into three severity levels based on headwind change magnitude:

| Level | Threshold | Colour | Meaning |
|-------|-----------|--------|---------|
| **Monitor** | ≥ 10 kt | Blue | Informational — sub-threshold variation worth watching |
| **Warning** | ≥ 15 kt | Amber | ICAO windshear threshold — operationally significant |
| **Alarm**   | ≥ 25 kt | Red   | Severe windshear — significant aircraft performance impact |

A **confidence gate** requires 2 consecutive poll cycles (≈ 6 seconds) both detecting the same event before it is promoted to the log or banner. This eliminates single-poll false positives from transient data artefacts without meaningfully delaying alerts for real sustained shear.

The **alert level selector** dropdown in the log header (`Mon ≥10kt` / `Warn ≥15kt` / `Alarm ≥25kt`) controls the minimum severity that activates the banner and flight strip WS badge. The log always shows all three levels regardless of this setting. The preference is saved across sessions. Default is Warning.

When a confirmed shear event meets the active alert level:

- An **alert banner** appears at the top of the page with the algorithm name, runway, altitude band, and aircraft information
- Affected flight strips get a pulsing **WS badge** (blue = monitor, amber = warning, red = alarm) — monitor badges do not pulse
- A coloured **horizontal band** (blue / amber / red) is drawn on the ILS profile canvas between the relevant altitudes
- The event is appended to the **windshear event log** with a coloured algorithm badge, timestamp, magnitude, gradient direction, and aircraft detail; Kinematic entries additionally show an **F-factor** value (e.g. `F=0.12`) — see [What is F-factor?](#what-is-f-factor) below for a full explanation

The **Pairwise** and **Kinematic** algorithms only include aircraft with GS status **ON** (within ±300 ft of the QNH-corrected glideslope), preventing false alerts from aircraft still intercepting the glideslope from above or below; the other algorithms rely on the establishment gate.

Turning the toggle OFF immediately clears all active alerts. Previously logged events remain visible until cleared manually. All data is held in RAM and does not persist across page refreshes.

##### Algorithm 1 — Pairwise (classic ICAO method)

**Requires: ≥ 2 aircraft simultaneously on the same approach, each with ≥ 6 wind history observations (establishment gate).**

The Pairwise algorithm is the classical windshear detection technique defined in ICAO Doc 9817 and used operationally by airport LLWAS (Low-Level Windshear Alert Systems). It compares the headwind component between two simultaneously tracked aircraft on the same ILS corridor, one higher and one lower on the glideslope.

For every pair of corridor aircraft within a 200–2 000 ft altitude separation window, the algorithm computes:

```
ΔHW = headwind(upper aircraft) − headwind(lower aircraft)
```

A large |ΔHW| reveals the presence of a wind shear layer between the two altitude levels. The 200 ft minimum separation prevents noise from aircraft at nearly the same level; the 2 000 ft maximum limits comparison to physically adjacent approach segments.

**Limitation:** requires two aircraft on approach simultaneously. During low-traffic periods this algorithm produces no output even when real shear is present. It is most powerful during busy arrival sequences with closely stacked aircraft.

##### Algorithm 2 — Gradient (single-aircraft wind history)

**Requires: ≥ 6 stored wind observations for the same aircraft (establishment gate).**

The Gradient algorithm examines the wind history accumulated for a single aircraft during its approach. As an aircraft descends from 3 000 ft to the threshold, the system stores up to 40 wind snapshots at intervals of ≥ 400 ft altitude change or ≥ 0.5 NM distance. The algorithm then finds the pair of observations — within a 200–3 000 ft altitude band — with the largest headwind difference.

This directly measures the **vertical wind gradient** (dHW/dz) in the low-level approach environment. A gradient exceeding ~15 kt over 1 000 ft of altitude is operationally significant and is indicative of a wind shear layer within the approach path.

**Advantage over Pairwise:** works with a single aircraft and accumulates evidence progressively as the aircraft descends through the wind field. Effective during single-runway VMC traffic when only one aircraft is on approach at a time.

**Limitation:** detection sensitivity increases with each new wind observation. The algorithm produces no output until the establishment gate is satisfied (< 6 valid wind points) and improves in accuracy as the aircraft continues its descent.

##### Algorithm 3 — Energy (total energy trend, GPWS-inspired)

**Requires: ≥ 6 groundspeed + altitude observations within the last 45 seconds (establishment gate).**

The Energy algorithm tracks a total mechanical energy proxy for each approach aircraft over a sliding 45-second window. The proxy is:

```
E = groundspeed (kt) + altitude (ft) / 100
```

On a stabilised 3° ILS approach at ~140 kt groundspeed, the aircraft descends roughly 318 ft per NM. Geometry and typical approach speeds mean that ~100 ft of altitude corresponds to approximately 1 kt of equivalent kinetic energy along the approach path. On a stable approach, E remains approximately constant as the aircraft trades altitude for forward speed at a predictable rate.

A rapid decrease in E signals that the aircraft is losing more total energy than the normal glideslope geometry predicts — the classic kinematic signature of a microburst or strong headwind loss event. A drop of ≥ 10 kt-equivalent in 45 seconds is flagged (Monitor); ≥ 15 is Warning and ≥ 25 Alarm, as for the other algorithms.

This algorithm is inspired conceptually by the energy-rate monitor in airborne EGPWS (Enhanced Ground Proximity Warning System) devices, which monitor the rate of total energy change to detect abnormal energy loss states during approach.

**Advantage:** the energy trend itself is groundspeed-based — no wind vector is needed for the calculation. (Aircraft without a valid computed wind are nevertheless skipped, see *Grey (NONE) aircraft are excluded* above.)

**Limitation:** any unrelated groundspeed fluctuation (e.g. temporary speed adjustment on ATC instruction) can trigger a false alarm. Works best with stable, consistent groundspeed data.

##### Algorithm 4 — Rate (headwind rate of change)

**Requires: ≥ 6 stored wind observations and a current headwind value (establishment gate).**

The Rate algorithm compares the aircraft's current headwind component to a reference taken from its recent wind history (median of the oldest up to three of the last 6 observations). Unlike the Gradient algorithm, it is not altitude-filtered — it detects any headwind change along the approach path, whether driven by altitude-related wind structure or by horizontal passage through a shear zone.

A large headwind change over a short segment — regardless of the altitude separation — indicates that the aircraft has rapidly entered a different wind environment. This catches purely horizontal or time-based wind shifts that develop at a fixed altitude level, including the leading edge of a microburst outflow where the shear layer may be nearly horizontal near the surface.

**Advantage:** sensitive to rapid temporal wind changes that have little altitude variation. Particularly useful on short final (< 500 ft) where altitude change between observations is small but wind speed can still shift dramatically.

**Limitation:** uses a short rolling window, so sustained slow changes may not accumulate to the threshold. More prone to transient false alarms than the altitude-separated algorithms.

##### Algorithm 5 — Baseline (historical approach deviation)

**Requires: ≥ 5 low-altitude wind observations from completed approaches in the last 30 minutes.**

The Baseline algorithm constructs a reference wind from recent completed approaches and compares each active corridor aircraft's current headwind to what was expected based on that reference.

When an approach aircraft disappears from the tracker (landed or left the corridor), the system harvests all of its stored wind observations below 2 000 ft and adds them to a rolling 30-minute buffer. The algorithm then vector-averages all observations in this buffer — using U/V component decomposition to handle the 360°/0° directional wrap correctly — to produce a background wind direction and speed. The expected headwind component for the current runway is derived from this averaged wind:

```
baseline_HW = avg_wind_speed × cos(avg_wind_dir − runway_heading)
```

If a current corridor aircraft's headwind deviates from `baseline_HW` by ≥ 10 kt (Monitor), ≥ 15 kt (Warning) or ≥ 25 kt (Alarm), shear is flagged — like the other algorithms, only for aircraft established in the corridor with at least the minimum number of corridor wind samples and valid meteo.

**Physical basis:** the baseline represents the background low-level wind field sampled by multiple recent aircraft on the same approach path. A large deviation for the current aircraft suggests that the wind environment has changed sharply since the baseline was established — either spatially (a localised shear zone has developed) or temporally (a frontal passage or microburst onset has changed the surface wind since the last landing).

**Advantage:** the most context-aware of the six algorithms — it adapts to the actual recent wind environment at the airport rather than using a fixed reference. It can detect wind changes that develop gradually between arrival waves.

**Limitation:** requires landing traffic in the preceding 30 minutes to populate the baseline buffer. The algorithm is silent at the start of a session or after a long traffic gap. Also assumes the baseline is representative of the current runway and direction, which may not hold perfectly when runway direction changes between the baseline and current approaches.

##### Algorithm 6 — Kinematic (IAS − GS differential rate)

**Requires: a single aircraft in the ILS corridor with BDS 6,0 IAS data available.**

The Kinematic algorithm detects windshear by monitoring the rate of change of the difference between Indicated Airspeed (IAS) and GPS groundspeed (GS) over a 45-second sliding window.

At low altitude, air density is close to sea-level ISA conditions, so IAS ≈ TAS (True Airspeed). The identity `IAS − GS ≈ headwind component along track` therefore holds without requiring any wind direction decoding. If the aircraft is flying into a headwind the differential is positive; a tailwind makes it negative. A sudden change in this differential is a direct kinematic measurement of a windshear encounter:

```
differential(t) = IAS(t) − GS(t)
diffOld = median(differential, oldest 3 samples in 45 s window)
diffNew = median(differential, newest 3 samples in 45 s window)
delta   = |diffNew − diffOld|
```

The median of 3 samples (rather than a single raw point) is used at each end to suppress single-poll IAS transients or noisy BDS 6,0 decodes before differencing. At the 3-second poll rate, three samples represent approximately 9 seconds of data.

If `delta ≥ 10 kt` the event is recorded at **Monitor** level (sub-threshold, informational). `≥ 15 kt` is **Warning**; `≥ 25 kt` is **Alarm**.

**Physical basis:** the approach phase is the only flight phase where a sudden change in `IAS − GS` can reliably be attributed to a wind shear and not to a deliberate speed change, because:
- the aircraft is flying a stabilised approach at a fixed target IAS;
- any large unintended IAS change is caused by an aerodynamic disturbance (gust, shear, microburst), not a throttle input;
- GS reflects the aircraft's inertial motion, which lags momentarily behind the aerodynamic change, creating a measurable differential.

A microburst headwind-loss encounter produces a rapid decrease in the differential (IAS drops faster than GS responds), while a headwind-gain event produces the opposite.

**Advantage:** the most dataflow-simple of all algorithms — uses only two raw Mode S fields (BDS 6,0 airspeed, ADS-B groundspeed) with no wind vector reconstruction. Works with a single aircraft. No runway heading or wind direction needed.

**Limitation:** requires BDS 6,0 Indicated Airspeed to be broadcast by the aircraft, which most modern jets do but is not mandatory. The IAS ≈ TAS approximation breaks down above ~6 000 ft (density altitude effect), but the algorithm is gated to GS-status-ON aircraft which are already on the glideslope well below that altitude.

**Why Kinematic is the recommended algorithm for MODE-S EHS monitoring:**

The other five algorithms all ultimately depend on computing a wind vector from BDS 5,0 (track, groundspeed, TAS) and BDS 6,0 (magnetic heading), then projecting it onto the runway axis as a headwind component. That chain has several vulnerable links specific to Mode-S data:

- **Magnetic heading errors** — BDS 6,0 magnetic heading is encoded at ~0.18° resolution (90/512°) and some transponders carry small per-aircraft biases from the compass installation. Small heading errors produce proportionally large wind direction errors at approach speeds.
- **Magnetic declination** — converting magnetic heading to true heading requires an accurate declination. The position-based WMM value removes the main error, but any residual difference between the model and the aircraft's own magnetic variation table still shifts computed wind vectors systematically, affecting pairwise, gradient, rate, and baseline equally.
- **BDS 6,0 availability and quality** — IAS and magnetic heading are in the same BDS 6,0 register; a transponder broadcasting a bad magnetic heading also corrupts the wind vector even when IAS itself is clean.
- **Multi-aircraft requirements** — Pairwise requires two aircraft simultaneously on the same corridor at different altitudes, which is not always available. The other single-aircraft algorithms need a long wind barb history to accumulate enough altitude range or time span to build a meaningful comparison.

Kinematic sidesteps all of this. The `IAS − GS` differential is computed from two independent data sources: BDS 6,0 IAS (airspeed sensor) and ADS-B groundspeed (GPS/GNSS). Neither requires a heading, a declination constant, or any wind vector calculation. A change in the differential is a direct aerodynamic measurement — the aircraft itself is the sensor. No amount of magnetic heading noise, declination drift, or runway geometry uncertainty can corrupt it. At EFHK, where the GPS jamming environment from the east adds an additional source of position and velocity noise for other algorithms, this independence is particularly valuable.

The practical consequence is that Kinematic produces the fewest false events from data-quality artifacts, while remaining sensitive to real shear. The 3-sample median filter (added to smooth single-poll IAS transients) and the corrected JAWS-reference F-factor gate give further control over the signal-to-noise trade-off.

#### What is F-factor?

Kinematic log entries display an F-factor value alongside the kt delta (for example `18 kt · F=0.12`). F-factor is a dimensionless number that answers the question: *how fast is the headwind changing relative to gravity?*

```
F = (headwind change in m/s) / (time window in seconds) / 9.81
```

Gravity (9.81 m/s²) is used as the normaliser because aircraft performance is ultimately governed by it — a headwind loss creates a sink rate, and that sink rate competes with the aircraft's ability to maintain the glideslope. An F-factor of 0.1 means the headwind is decaying at one-tenth of gravitational acceleration, which is the point where most approach aircraft start to struggle to maintain energy.

**Reference thresholds from NASA/FAA JAWS research:**

| F-factor | Interpretation |
|----------|----------------|
| < 0.05   | Negligible — normal approach variation |
| 0.05–0.10 | Noticeable — pilot may sense it |
| ≥ 0.10   | Operationally significant — performance impact likely |
| ≥ 0.15   | Severe — significant control input needed |

These thresholds come from the Joint Airport Weather Studies (JAWS) programme which established F-factor as the standard hazard metric used in airborne windshear warning systems (GPWS/EGPWS).

**Why F-factor adds information beyond the kt value:** two events could both show `18 kt Warning` but have very different F-factors depending on how quickly the 18 kt was lost. An aircraft that lost 18 kt of headwind over 40 seconds (`F ≈ 0.024`) is a very different situation from one that lost it over 8 seconds (`F ≈ 0.12`). The kt value tells you the magnitude; the F-factor tells you the rate, which is what determines whether the crew had time to respond.

F-factor is displayed as supplementary information in the log. Severity classification is still driven by the kt thresholds, but the **Kinematic F-factor gate** dropdown (`F: Off / F ≥0.05 / F ≥0.08 / F ≥0.10 / F ≥0.15`) in the log header lets you suppress Kinematic events whose F-factor is below a chosen minimum. This is useful for research — setting the gate to `F ≥0.05` silently discards the slow background drift events (typically F=0.02–0.03) that represent normal approach variation according to the JAWS thresholds, while preserving genuine rapid shear events. The gate is automatically greyed out when any other algorithm is selected, since F-factor is only computed for Kinematic. The preference is saved across sessions. Default is Off (no filtering).

**F-factor reference window:** F is computed by scanning all 10–20 second sub-windows within the 45-second detection history and reporting the maximum. This matches the JAWS 1 km reference distance (≈15 s at typical approach speed). The 45-second detection window that determines whether an event fires is unchanged — only the F-factor value reported is affected. The F-gate thresholds in the table above are therefore correctly calibrated against the published JAWS values.

#### Stale aircraft removal

Aircraft that stop transmitting (e.g. because the receiver loses line-of-sight on short final) are removed from the display within approximately 30–45 seconds. The tracker's sweep thread checks `last_seen` timestamps against a 30-second window and the `prune_stale()` method removes any aircraft not updated within 30 seconds. This keeps the display clean during busy approach sequences where multiple aircraft land in quick succession.


#### Approach roughness logging

Every landing in Approach History also stores how "rough" the final approach was (`rough_json` column, `rough` in the API). On a windy, gusty day the aircraft's own Mode S data shows the pilots (or autopilot) working: larger bank-angle corrections, a wandering track, airspeed jumping around its normal deceleration and an uneven descent rate. These are the same moments that appear as orange **Turn** rings on the ILS profile — the computed wind is rejected when the bank angle exceeds 5° or the track changes faster than 1°/s — so the wind bands alone cannot show them.

**What is collected:** every raw BDS 5,0 (bank angle, track rate) and BDS 6,0 (indicated airspeed, magnetic heading, inertial / barometric vertical rate) reply received while the aircraft is **established on final** — in the ILS corridor, within 1 NM of the centreline, track within 20° of the runway heading, not in a go-around and before the threshold. The replies the wind calculation rejects are included, since they are the interesting ones. Replies that disagree with the aircraft's ADS-B track or groundspeed (a mis-identified Comm-B register) are dropped and counted. Two altitude segments are summarised separately: **`hi`** 3 000–1 000 ft MSL (usually autopilot) and **`lo`** 1 000–200 ft MSL (often hand-flown). The METAR surface wind and gust valid at landing time are stored with the record for comparison.

| Key (per segment) | Meaning |
|-------------------|---------|
| `n5` / `n6` | Number of BDS 5,0 / 6,0 replies used |
| `dur` | Seconds from the first to the last reply in the segment |
| `rr` | Bank-angle RMS (°) — near 0 on a calm stabilised approach |
| `rp90` / `rmax` | 90th percentile / largest absolute bank angle (°) |
| `r5` | Replies with bank angle over 5° (the wind calculation rejects these) |
| `tr` | Track-rate RMS (°/s); `t1` replies with track rate over 1°/s |
| `isd` / `imx` | IAS standard deviation / largest deviation (kt) about a straight-line fit over time — the normal deceleration is removed, what remains is gust response |
| `vsd` / `vm` | Vertical-rate standard deviation / mean (ft/min); `vs` = `i` inertial, `b` barometric (inertial preferred) |
| `cm` / `csd` | Crab angle (heading − track, °) mean / standard deviation; `+` = nose right of the track, i.e. wind from the right. Mean ≈ crosswind, standard deviation ≈ gusty crosswind |
| `rhp` / `ihp` / `vhp` | "High-pass" fluctuation of bank angle (°), IAS (kt) and vertical rate (ft/min): RMS about a ±7.5 s moving median, so slow changes — the end of the intercept turn, glideslope capture, flap-speed steps — are removed and the gust response of a few seconds remains (the very first records only have the plain statistics) |

Record-level keys: `bad` (replies dropped as inconsistent) and `metar` (`{"t": "DDHHMM", "dir": °, "spd": kt, "gst": kt or null, "var": "200V270" or null}`, plus `"tt"` / `"td"` air temperature / dewpoint °C, `"q"` QNH and `"cld"` lowest cloud group such as `"BKN008"` or `"CAVOK"`; omitted when no METAR has been received in the last 2 h). The JSON is about 300–450 bytes per landing (roughly 30 MB per year at EFHK traffic levels), written in the same insert as the landing itself.

**Autopilot, wind / temperature profile and raw series** — three records for later analysis, all written with the landing row (no extra commits):

- `rough_json` key **`ap`** — autopilot state from ADS-B TC 29 (version 2 transponders; others have no `ap`) on the sweeps while established: `n` / `on` sweeps with a known state / with the autopilot engaged, `n_lo` / `on_lo` the same below 1 000 ft MSL, `off_ft` the altitude where it was switched off (first on → off), `app` approach mode seen. Separates hand-flown and coupled segments — the aircraft's response to turbulence depends on who flies.
- **`prof_json`** column (`prof` in the API) — per 200-ft band of the final approach: `n` paired BDS 5,0 / 6,0 replies with the vector-mean wind `wd` / `ws` and its spread `sd` (kt) — instead of the single reading in `bands_json` —, the headwind component `hw` (TAS − GS, kt; `hn` replies) and the Mach/TAS temperature `t` (°C; `tn` pairs). Every landing is thus a small 3 000 → 200 ft sounding: low-level wind shear and the temperature lapse rate (stability) near the airport. About 0.5–1 kB per landing.
- **`approach_series`** table — the raw replies behind the statistics (BDS 5,0: roll, track rate, track, GS, TAS; BDS 6,0: IAS, heading, vertical rates, Mach; each 3-s sweep: altitude, distance, cross-track, position, autopilot), zlib-compressed integer columns, about 2–3 kB per landing. Lets new methods (spectra, EDR-type turbulence estimates, other filters) be applied to past landings. Kept **`APPROACH_SERIES_DAYS`** (default 90; about 50 MB) and purged daily; `collector/windshear.py` `WindshearTracker.decode_series()` decodes a row.

#### How the Approach Conditions Index (ACI) is calculated

From the roughness record the server computes one number per landing, **0 (smooth) to 10 (very rough)** — the *approach-conditions index* (provisional; `collector/approach_cond.py`). It is calculated when the data is requested (API field `cond`) and never stored, so a re-tune of the constants below re-scores all past landings. It is shown in the Approach History **Cond** mode and in the Windrose panel's **Cond** view.

The idea: on a stabilised approach in calm air, airspeed, descent rate and bank angle are almost constant. Gusts and turbulence make them fluctuate *quickly* — within a few seconds — while the normal, slow changes of an approach (deceleration, glideslope capture, the end of the intercept turn) happen over tens of seconds. The index measures only the quick part.

**Step 1 — samples.** All BDS 5,0 (bank angle) and BDS 6,0 (indicated airspeed, inertial — or barometric — vertical rate) replies received while the aircraft is established on final, separately for the segments **hi** (3 000–1 000 ft MSL) and **lo** (1 000–200 ft MSL); see *What is collected* above. A segment is scored only if it has at least **8** replies. At EFHK an aircraft is interrogated roughly once per second, i.e. typically 60–120 replies in `hi` and 10–25 in `lo`.

**Step 2 — fluctuation ("high-pass" RMS).** For each quantity *x* with samples *xᵢ* at times *tᵢ*:

```
medianᵢ = median of all x_j with |t_j − t_i| ≤ 7.5 s        (moving median, 15 s window)
rᵢ      = xᵢ − medianᵢ                                        (quick part only)
value   = √( mean(rᵢ²) )                                      (RMS of the quick part)
```

This gives `ihp` (IAS, kt), `vhp` (vertical rate, ft/min) and `rhp` (bank angle, °). A median is used instead of a mean so that a single bad reply does not shift the reference. The very first landings recorded only have plain statistics (IAS deviation from a straight-line fit, plain standard deviations, bank RMS); for them fallback references are used.

**Step 3 — component score (0–10).** Each value is placed linearly between a *calm* and a *rough* reference and clipped:

```
score = clamp( 10 × (value − calm) / (rough − calm), 0, 10 )
```

| Component | Value | Calm → rough (fallback) | Weight |
|-----------|-------|-------------------------|--------|
| IAS fluctuation | `ihp` kt (`isd`) | 0.6 → 3.0 (1.2 → 6.0) | 45 % |
| Vertical-rate fluctuation | `vhp` ft/min (`vsd`) | 30 → 160 (60 → 300) | 30 % |
| Bank-angle fluctuation | `rhp` ° (`rr`) | 0.4 → 2.5 (0.6 → 4.0) | 25 % |
| Crab-angle variation | `csd` ° | — | shown only, not scored |

**Step 4 — segment score** = weighted mean of the available component scores: `(0.45·S_ias + 0.30·S_vr + 0.25·S_roll) / (sum of the weights used)`.

**Step 5 — landing score** = mean of the scored segments (`hi` and / or `lo`).

**Step 6 — aircraft class.** Lighter aircraft are moved more by the same air, so the landing score is divided by a class factor and clipped to 10:

```
index = min( 10, landing score / class factor )
```

| Class | Examples (ICAO type code) | Factor |
|-------|---------------------------|--------|
| T turboprop | AT75, AT76, DH8D, SF34 | 1.50 |
| B business jet | GLF6, C68A, FA7X, PC24 | 1.25 (estimate) |
| R regional jet | E190, E195, CRJ9, BCS3 | 1.15 |
| N narrowbody | A320, A321, B738, B38M | 1.00 |
| W widebody | A359, A333, B77W, B789 | 1.00 |

**Step 7 — level:** < 2 *Smooth*, 2–4 *Light*, 4–6 *Choppy*, 6–8 *Rough*, ≥ 8 *Very rough*. These are deliberately not the ICAO turbulence terms (light / moderate / severe), because the index is not a turbulence report.

**Worked example** (A320, METAR 27013KT):

| | `ihp` | score | `vhp` | score | `rhp` | score | segment |
|---|---|---|---|---|---|---|---|
| hi | 1.0 kt | (1.0−0.6)/2.4×10 = 1.7 | 87 fpm | (87−30)/130×10 = 4.4 | 1.61° | (1.61−0.4)/2.1×10 = 5.8 | 0.45·1.7 + 0.30·4.4 + 0.25·5.8 = **3.5** |
| lo | 1.5 kt | 3.8 | 37 fpm | 0.5 | 0.69° | 1.4 | **2.2** |

Landing score (3.5 + 2.2) / 2 = 2.85; narrowbody factor 1.0 → **index 2.9, Light**.

**Limitations.** The index describes how much the aircraft was moved and corrected on final — it mixes the air with the aircraft's response: autopilot vs hand flying (usually below 1 000 ft), approach speed, flap setting and aircraft size all play a part, and the class factors are a first approximation. It is most meaningful when compared over time and between landings of the same class and runway, not as an absolute turbulence measurement.

**Calibration:** on 236 landings with METAR winds of 6–20 kt, the high-pass IAS, vertical-rate and bank-angle values follow the surface wind (rank correlation ≈ 0.4–0.7, IAS strongest), whereas the plain statistics and the crab-angle variation do not — so the index uses the high-pass values and leaves the crab variation out. With the current scale the median index is about **1** at 0–8 kt, **3** at 9–12 kt and **4.3** at 13–16 kt (index vs METAR wind: rank correlation 0.70). The upper part of the scale still has to be confirmed on a gusty day.

**Class factors:** measured on 356 landings by comparing each landing's score with the median of all other landings within ±45 minutes (same weather). Relative to narrowbodies, turboprops scored 1.53, regional jets 1.20 and widebodies 1.02 — the same with ±30 or ±60 min windows. The factors are therefore 1.5 for turboprops, 1.15 for regional jets and 1.0 for widebodies. The business-jet factor is an estimate, as there are only a few such landings so far. The aircraft types also differ in *which* quantity moves most (turboprops mainly vertical rate, regional jets bank angle), so a single factor per class is an approximation.

---

### GPS Quality  `/gps`

An area-wide real-time and historical monitor for GPS signal quality degradation across all aircraft tracked by the receiver. The page auto-refreshes every 30 seconds.

Hourly summary data is persisted to the SQLite `gps_quality_hours` table (All zone) and `gps_quality_zone_hours` table (50 nm and 20 nm zones) so that the time-series chart and heatmap survive process restarts. Only completed hours are written to the database (up to 3 rows per hour rollover — one for All and one per distance zone, i.e. up to 72 rows per day), so the write load is negligible. On startup the tracker reloads the last **6 months** of history automatically (`MAX_BUCKETS` in `collector/gps_quality.py`) — the charts are immediately populated from stored data, covering the full range of the `6m` selector below. The current (incomplete) hour, including the sets of aircraft already counted, is checkpointed every 60 s to the `gps_quality_live` table; after a restart the tracker resumes that hour, so a restart loses at most the last minute of data. If the process was down across an hour boundary, the interrupted hour is saved from its checkpoint on the next start. This data is never auto-purged — it accumulates indefinitely unless manually cleared from the [Maintenance](#maintenance--maintenance) page's GPS Quality purge section, so the `3m`/`6m` selectors are only as useful as how much history you choose to retain there. The heatmap response is capped independently at the most recent 31 days regardless of the time-series window — this matches the heatmap panel's own `14d`/`1m` range selector (see [GPS Quality](#gps-quality--gps) below), whose longest option is exactly 31 days.

**Per-band detail:** each hourly row (all three zones) also stores a `band_detail` JSON column with, per FL band, the number of distinct aircraft seen (`ac`), the number of distinct degraded aircraft (`deg`) and the signal mix (`sig`, event counts per signal). The existing `fl_bands` column only counts events, so a band with many events could not tell whether one aircraft or twenty were affected, nor which signals dominated; `band_detail` makes both visible per altitude layer. The JSON adds roughly 0.5–1 kB per hourly row; older rows without it have `NULL`. It is used by the heatmap's **% aircraft** mode and hover text (see *Layout* below) and can also be queried directly (e.g. with `json_extract` in SQLite).

**Degradation episode log:** in addition to the hourly counts, every continuous period of degradation of one aircraft is written as one row to the `gps_episodes` table (see [Database](#database)). An episode starts when an aircraft at or above `GPS_MIN_ALT_FT` raises any detection signal while it is within `GPS_EPISODE_RADIUS_NM` (optional config key, default 100 NM) of the airport; it is extended by every further degraded sweep, and clean gaps shorter than 120 s are merged into the same episode. It ends as `recovered` (120 s without any signal), `lost` (the aircraft disappeared from tracking while degraded — typical for an aircraft that loses its position completely) or `below_min_alt` (descended below `GPS_MIN_ALT_FT`, e.g. on final). Each row stores the start and end snapshot (position, altitude, track, vertical rate, groundspeed and distance from the airport; for the end also the age of the last position), the first clean position after the last degraded sweep (where the aircraft recovered), the altitude range, the lowest fresh NACp and NIC, the signals that occurred, and the callsign, type and registration. This answers questions the hourly buckets cannot, such as *at what altitude and distance did aircraft lose and recover GPS*, *how long did it last* and *in which direction were they flying*. Closed episodes are buffered in RAM and written in the same transaction as the 60-s current-hour checkpoint, so the log adds no extra database commits. The episodes still open are saved with the same checkpoint and once more when the server stops (SIGTERM / Ctrl+C): after a restart within 10 minutes they simply continue, so a restart does not cut an episode in two; after a longer stop they are written as ended at their last degraded sweep with end reason `shutdown`. Typical volume is a few hundred rows on a heavy jamming day (well under 1 MB per month). The log is **never auto-purged** — it is collected without a time limit and can be purged manually on the [Maintenance](#maintenance--maintenance) page. It is displayed on the [GPS Episodes](#gps-episodes--gps-episodes) page.

**Finer detail for later analysis:** three records, all written inside the existing hourly rows, checkpoint and episode rows — no extra database commits, only a few hundred bytes more per hourly row:

- **10-minute resolution** — `band_detail` gets `t10`: the hour split into six 10-minute slots, each with the distinct aircraft seen (`ac`), degraded (`deg`), severely degraded (`sev`) and with a spoofing indicator (`spf`), plus seen / degraded in FL050–250 (`mac` / `mdeg`). Stored per zone like the hourly row, so the 50 nm and 20 nm zones have their own slots. Shows when an episode started and ended within the hour (useful around the clock change and for daytime events).
- **Severity** — a degraded sweep is *severe* when the position is unusable: fresh NACp 0 (accuracy unknown or ≥ 10 NM), NIC 0 (no integrity) or no own ADS-B position at all (ADS-B loss / Gap). `band_detail` `sev` = distinct severe aircraft per FL band, `s0` = severe sweeps per band split into `nacp0` / `nic0` / `nopos`. Everything else (NACp / NIC 1–6, Freeze) is the milder rest — this separates "degraded accuracy" from "position lost".
- **Spoofing indicators** — jamming removes the GNSS position; spoofing replaces it with a false one, which NACp / NIC do not necessarily show. Four indicators are recorded (they are *not* detection signals: the counts, charts and episode definition above are unchanged):
  - `mlat_dis` — the aircraft's own ADS-B position disagrees with the Radarcape MLAT position (both at most 10 s old) by more than 2 NM plus the distance flown in the time difference, **on two consecutive comparisons** with new positions on both sides (a single MLAT or decoding outlier is ignored). MLAT positions exist mainly for aircraft whose ADS-B position is missing, so comparisons happen typically when the ADS-B position comes back; `cmp` counts the sweeps where a comparison was possible. The Radarcape MLAT network covers mainly higher altitudes (e.g. the Gulf of Finland, where traffic to and from Kaliningrad is often jammed); low near EFHK there is practically no MLAT, so this is a high-altitude check.
  - `gmb_sat` — the GNSS − barometric altitude difference reported in the airborne-velocity message (TC 19) is at its largest encodable value (more than ±3 137 ft).
  - `gmb_jump` — that difference changed by 500 ft or more between two reports at most 30 s apart (normally it changes only slowly with altitude and temperature); `gmb_n` counts the sweeps with a fresh value.
  - `pos_jump` — the own ADS-B position stepped further than the groundspeed allows (2 NM + 1.5 × groundspeed × time), confirmed by the next position, so a single decoding outlier is not counted.

  **Normal-quality flags** (from the evening of 9 Oct): an indicator raised while the aircraft reports *normal* GPS quality — fresh NACp above the threshold (≥ 7) and no degradation signal in that sweep — is the strong spoofing case: a false position the aircraft itself trusts. These are counted separately as `ok_<indicator>` per FL band, and each flagged-aircraft entry stores the NACp at the first flag (`nacp`) and the indicators raised with normal quality (`q`). Indicators raised during jamming (NACp 0) are more often the GNSS receiver re-acquiring after the outage.

  `band_detail` `spf` = counts per FL band, `spa` = distinct aircraft per band and, in the All zone, `spl` = the flagged aircraft of the hour (up to 100: ICAO, callsign, first time in the hour, altitude, distance and the largest disagreement / jump). Episode rows also store the indicators seen while the episode was open (including the 120-s recovery window, where a false "recovery" would show up), the largest ADS-B/MLAT distance, the number of MLAT comparisons, the GNSS − baro range and the number of severe sweeps. The thresholds are first estimates; the stored magnitudes allow re-evaluating them later. Shown on the GPS Quality page (10 min view, Severity & Spoofing panel, Severe 24h, see *Layout* below) and in the GPS Episodes detail popup; everything is also available with `json_extract`.

> **Why "GPS Quality" and not "GPS Jamming"?** The page detects and displays objective signal quality parameters — it does not assert a cause. True GPS jamming, spoofing, receiver failure, and genuine satellite outages can all produce the same observable signatures. The term "GPS Quality" is deliberately neutral.

#### Detection signals

The tracker watches every aircraft **heard by this receiver** (any Mode-S message on the Beast feed within the last 60 s) on each 5-second sweep and flags aircraft showing any of five degradation signals. Aircraft kept on the list only by the Radarcape JSON / MLAT network (beyond this antenna's reception) are not evaluated and not counted as traffic. **An "event" is one aircraft flagged in one 5-second sweep** — an aircraft that stays degraded for a minute produces about 12 events — so event counts measure degraded aircraft-time rather than separate incidents. One sweep can raise several signals at once (e.g. Freeze and ADS-B), which is why the per-signal counts can add up to more than the event total.

| Signal | Badge | Condition | Typical cause |
|--------|-------|-----------|---------------|
| **NACp** | Blue | Navigation Accuracy Category ≤ `GPS_NACP_THRESHOLD` (6: accuracy worse than ~0.1 NM), from a status message received within the last 30 s — TC=29, or TC=31 with ADS-B version ≥ 1 (the field is undefined in version 0) | Degraded **accuracy** reported by the aircraft avionics themselves |
| **NIC** | Rose | Navigation Integrity Category ≤ `GPS_NIC_THRESHOLD` (6: containment radius Rc ≥ 0.3 NM), from an airborne-position message received within the last 30 s. NIC is encoded in the position **type code** plus the NIC supplement bits (NIC-A from TC=31, NIC-B in the position message), interpreted per ADS-B version | Degraded **integrity** reported by the aircraft; reacts within about a second since every position message carries it — typically the onset / fringe of jamming while the GPS still produces a position |
| **Freeze** | Cyan | The aircraft's **own** ADS-B position messages keep arriving (latest within 10 s) but their coordinates are identical for ≥ 3 consecutive sweeps while groundspeed > 50 kt | GPS output stuck at the last fix although the transponder keeps broadcasting it |
| **Gap** | Purple | The aircraft is transmitting ADS-B extended squitters right now (any DF17 within 30 s), but no position update from **any** source — own ADS-B or MLAT — for ≥ 45 s during this visit | GPS has dropped out and MLAT is not covering the aircraft |
| **ADS-B** | Teal | Transmitting extended squitters right now, no **own** ADS-B position for ≥ 45 s during this visit (counted from its last own position, or from the start of the visit if none has arrived yet), while MLAT keeps updating its position | GPS has dropped out, MLAT covering — the most operationally relevant jamming signal at EFHK where MLAT coverage is strong; also catches aircraft already jammed when they come into range |

The signals use per-visit fields maintained in `live_state` by the collector: `last_rx_ts` (any message on our own Beast feed — the JSON poller never sets it), `last_es_ts` (any DF17 extended squitter), `first_seen` (start of the visit; an aircraft is re-created after 10 minutes of silence), `last_adsb_pos_ts` + `adsb_lat` / `adsb_lon` (the aircraft's own ADS-B position, kept separately because MLAT overwrites `lat` / `lon`), `last_pos_update_ts` (last position change from any source), and the self-reported quality values `nac_p` / `nic` / `nic_rc_m` / `nac_v` / `adsb_version`, each with its own timestamp. Freeze, Gap and ADS-B are mutually exclusive; NACp and NIC can coincide with any of them. Aircraft that stop all extended squitters are not flagged (that is not a GPS symptom), and nothing is inherited from an earlier visit of the same aircraft.

**Why several signals?** They cover different stages of GPS trouble: NACp / NIC — "my GPS knows it is degraded" (onset, fringe, partial jamming); ADS-B loss / Gap — "GPS gave up" (many transponders then stop sending positions); Freeze — "GPS output is stuck". Note that a *spoofed* position usually carries healthy-looking NACp / NIC, because the receiver believes the false signal.

**Counting-method versions:** every hourly row stores the counting method it was recorded with (`method` column), and the charts mark each change with a dashed amber line (`v2`, `v4` …); values on either side of a marker are not directly comparable.

| Version | From | Change |
|---|---|---|
| 1 | start of data | `live_state` was never pruned — an aircraft returning hours or days later carried its old ADS-B timestamp and position, flagging ADS-B loss (and sometimes Freeze) until a fresh position arrived, or for the whole visit if it was tracked only by MLAT. The effect grew with uptime: ADS-B loss events per aircraft-hour rose from ~50 just after a restart to ~100 after several weeks |
| 2 | 2026-09-25 11:00 UTC | `live_state` pruned after 10 minutes of silence — the stale-state inflation disappears |
| 3 | 2026-09-26 (deployment) | ADS-B loss counted per visit (requires current extended-squitter activity; also flags aircraft jammed on entry); current hour survives restarts |
| 4 | 2026-09-26 (deployment) | Only aircraft heard by this receiver are counted (traffic and signals); Freeze requires own ADS-B positions to keep arriving (a position that simply stopped updating is no longer Freeze); Gap = no position from any source (previously practically never triggered — it required an empty position, which `live_state` never has); new **NIC** signal; NACp version-aware and only while fresh. Out-of-range aircraft kept alive by the JSON list no longer produce Freeze / ADS-B events. **NACp in methods 1–3 was heavily under-counted:** a collector merge bug erased the stored NACp with the aircraft's next message (a fraction of a second later), so the 5-second sweep only saw it by chance. v4 stores NACp in its own field, and NACp events rose from 2–10 to 40–140 per aircraft-hour — jammed aircraft broadcast NACp 0 alongside losing their positions |

NACp comes from TC=29 (Target State & Status) and TC=31 (Aircraft Operational Status) messages, broadcast every few seconds by ADS-B version 1/2 transponders; NIC from the type code of every airborne-position message; NACv (velocity accuracy, shown in the live table only) from TC=19. ADS-B version 0 transponders do not report NACp (the field is ignored for them) — they can still be detected through NIC, Freeze, Gap and ADS-B loss.

**NIC scale reference (airborne):** 11 = Rc < 7.5 m · 10 = < 25 m · 9 = < 75 m · 8 = < 0.1 NM · 7 = < 0.2 NM · 6 = 0.3–0.6 NM · 5 = < 1 NM · 4 = < 2 NM · 3 = < 4 NM · 2 = < 8 NM · 1 = < 20 NM · 0 = unknown.

**NACp scale reference:**

| NACp | Horizontal accuracy | Interpretation |
|------|---------------------|----------------|
| 0 | Unknown | No position accuracy information available |
| 1 / 2 / 3 | < 10 / < 4 / < 2 NM | Very poor |
| 4 / 5 / 6 | < 1 / < 0.5 / < 0.3 NM | Degraded — flagged by the tracker (threshold ≤ 6) |
| 7 / 8 | < 0.1 / < 0.05 NM | Good (RNP-grade) |
| 9 / 10 / 11 | < 30 / < 10 / < 3 m | Excellent (typical healthy GNSS) |

#### Layout

The page has these panels:

**Time-series chart (left top)** — a stacked bar chart with five colour-coded segments per bar showing the per-signal event breakdown: **NACp** (amber), **NIC** (rose), **Freeze** (sky blue), **Gap** (violet), and **ADS-B** (teal). The total bar height equals the number of events in that period (degraded aircraft-sweeps). One sweep of a jammed aircraft often raises two signals at once (typically NACp + ADS-B loss), so the segments are scaled proportionally: their colours show each signal's share, and the bar is not inflated by double counting. Hovering a segment shows the real, unscaled count of that signal; the tooltip footer shows the events and the total number of signals raised. A grey **Aircraft** line (right Y-axis) shows traffic: in the hourly views the number of unique aircraft seen in that hour (in the selected zone); in the daily views the **average aircraft per hour** (sum of the hourly counts ÷ hours with data). A dashed yellow **Events / aircraft** line (own right axis) is a traffic-normalised degradation index — events ÷ aircraft-hours — so days with different traffic volume can be compared directly. Click a legend entry to hide or show a line. Dashed amber markers (`v2`, `v3`) show where the counting method changed; hovering that bar explains the change. Historical hours recorded before per-signal tracking was introduced are shown as a neutral grey **Unknown** segment. The chart updates on each 30-second poll.

A **range selector** in the chart header controls how much history is displayed:

| Button | Granularity | Description |
|--------|-------------|-------------|
| `1d` | Hourly bars | Last 24 hours — default view |
| `2d` | Hourly bars | Last 48 hours; date prefix shown at midnight boundaries |
| `3d` | Hourly bars | Last 72 hours |
| `1w` | Hourly bars | Last 7 days — full hourly resolution, 7 day-boundary tick labels |
| `2w` | Daily bars  | Last 14 days aggregated per calendar day |
| `1m` | Daily bars  | Last 31 days aggregated per calendar day |
| `3m` | Daily bars  | Last 90 days aggregated per calendar day |
| `6m` | Daily bars  | Last 180 days aggregated per calendar day |

For the daily-aggregate views (`2w` / `1m` / `3m` / `6m`) the Aircraft line shows the **average aircraft per hour** of that day (not the busiest single hour, which at EFHK is almost always the 13 UTC traffic wave and would make a day still in progress look quiet). The selected range is remembered across browser sessions via `localStorage`. This selector is independent of the heatmap's own range selector described next — the two panels track different questions (event volume over time vs. which altitude layers are affected) and are capped differently server-side (see note above), so they intentionally do not share a control.

**`Events` / `10 min` view** — two buttons left of the range selector switch the chart. **Events** is the chart described above. **10 min** shows the number of **degraded aircraft per 10 minutes**, split into **Severe** (red — position unusable: NACp 0, NIC 0 or no own ADS-B position) and **Mild** (amber — the rest), the **% of FL050–250 traffic degraded** (blue line, right axis) and pink triangles for slots with an aircraft carrying a spoofing indicator. Hovering a slot also shows the aircraft seen in total and in FL050–250. The window follows the range selector up to 7 days (`2w` and longer show the last 7 days). Data from the 10-minute slots (see *Finer detail* above); periods recorded before these slots existed show nothing. Refreshed every 60 s; the choice is remembered in the browser.

**FL-band heatmap (left bottom)** — a colour-coded grid with **nine rows** (FL bands: FL010–030 / FL030–050 / FL050–080 / FL080–100 / FL100–150 / FL150–200 / FL200–250 / FL250–300 / FL300+) and one column per day. A `14d` / `1m` range selector in the panel header switches between the last 14 days and the last 31 days; both draw instantly from data already held in the browser (no new fetch). Cell colour ranges from near-background (no events) through blue, amber, and red to dark red (high activity), normalised independently per row so low-altitude bands remain readable even when high-altitude bands have far higher absolute counts. Days on either side of a counting-method change (dashed amber line) are scaled separately, because their counts are not comparable — otherwise, for example, old days with higher counts would make every newer day look pale. A side shorter than 3 days is merged with its neighbour, so the new side gets its own scale from its third day onward. The event count is printed inside non-zero cells; font size scales down automatically in the denser `1m` view so 4-digit counts stay legible in the narrower daily columns. This view is most useful for identifying which altitude layers are most affected on which days — low-level bands being consistently darker than high-level bands is a signature of ground-based jamming that affects climb/descent phases more than cruise. The FL050–100 band was split into FL050–080 and FL080–100 for finer resolution around the transition altitude; events recorded before the split remain tagged under the old combined band and will not appear in either new row. A dashed amber line at the left edge of a day marks a counting-method change.

**Heatmap mode `Events` / `% aircraft`** — two buttons next to the range selector (the choice is remembered in the browser). **Events** is the view described above. **% aircraft** shows in each cell the share of the aircraft seen in that FL band that had at least one degradation event, from the per-band detail (`band_detail`): distinct aircraft are counted per hour and summed over the day, so the figure is *degraded aircraft-hours ÷ aircraft-hours*. Unlike the event count it is not inflated by a few long-degraded aircraft or by a busy band, and all rows share one colour scale: 0 %, below 10 %, 10–25 %, 25–50 % and 50 % or more. Cells without per-band data (older days without `band_detail`, or no traffic) are drawn as empty outlines.

**Heatmap hover and click** — hovering any cell shows the day and band, the event count and — where per-band data exists — the degraded / seen aircraft (aircraft-hours, with the percentage) and the signal mix (share of NACp / NIC / Freeze / Gap / ADS-B events), and the severely degraded aircraft-hours where recorded. Clicking a cell opens the [GPS Episodes](#gps-episodes--gps-episodes) page in a new tab for that UTC day, filtered to that FL band (episodes whose altitude range overlaps the band, any duration).

**Live degraded aircraft table (right top)** — shows all aircraft currently flagged by any detection signal, sorted highest altitude first. Columns: callsign, ICAO24, FL band, altitude (ft), groundspeed (kt), NACp, NIC (hover for the containment radius Rc), NACv, and active flag badges. The table is sized to show 7 rows; additional entries are accessible via scrollbar. Refreshes every 30 seconds.

Aircraft whose position is currently **severe** (NACp 0, NIC 0 or no own position) are marked with a red callsign and a red bar at the left edge.

**FL Band Analysis panel (right middle)** — a doughnut chart showing how total degradation events are distributed across the nine FL bands, over the **same `14d` / `1m` window as the heatmap** (they share that selector, not the time-series chart's `1d`–`6m` selector, since both panels draw from the same server-side data which is only ever retained up to 31 days regardless of the time-series range). FL band labels appear as a vertical list on the left side of the chart; hover tooltips show the event count and percentage for each segment. Below the chart a compact stats block shows: total events, most affected FL band (with count), worst single day (date and count), and a NACp / NIC / Freeze / Gap / ADS-B signal breakdown with counts and percentages. The donut reflects the **active zone** — switching the zone selector redraws it immediately using the newly fetched zone data; within a zone it is refreshed every **60 minutes** and intentionally not updated on every 30-second poll since these aggregates change slowly.

**Severity & Spoofing panel (right, below FL Band Analysis)** — with its own `1d` / `7d` / `1m` selector and the zone selector applied:
- **Severity** — degraded and severely degraded aircraft-hours (with the severe share) and the severe sweeps split into NACp 0 / NIC 0 / no own position
- **Spoofing indicators** — per indicator (ADS-B / MLAT mismatch, GNSS−baro at limit, GNSS−baro jump, position jump) the number of aircraft, how many of them were flagged while reporting **normal GPS** quality (yellow when non-zero — the strong spoofing case) and the sweeps / events, and how often the checks could be made at all (sweeps with an ADS-B vs MLAT comparison and with a GNSS − baro value) — a zero means more when the check was possible thousands of times. **`2+` independent indicators** counts the aircraft flagged by two or more *independent* checks in the same hour — ADS-B vs MLAT, GNSS − baro altitude (its two indicators come from the same value and count as one) and position jump. Agreeing checks are much stronger evidence of spoofing than one alone: in the first days most single large ADS-B / MLAT mismatches (80–200 NM, also at short range) were evidently MLAT outliers, while the 2+ cases showed e.g. a 25 NM position jump and a 24 NM MLAT mismatch at the same time
- **Flagged aircraft** — newest first: time (UTC), callsign (hover for ICAO24), flight level, distance and NACp when first flagged in that hour, indicator and its size (distance from MLAT, jump distance, GNSS − baro change or value). Rows flagged with normal GPS quality have a yellow bar at the left edge; rows with 2+ independent indicators have a pink `2+` badge, and the **`2+ only`** button in the list header shows only those (remembered in the browser). For the 50 nm / 20 nm zones the list is filtered by the distance at the first flag

The panel refreshes every 60 s.

**Summary bar** — across the top of the page: total events in the last 24 hours, number of unique aircraft affected, **Severe 24h** (aircraft-hours with an unusable position), peak hour, current live degraded count, and the **zone selector** (see below).

**Signal key panel (right bottom)** — explains each detection signal with its threshold values, the severity classification and the spoofing indicators, and the full NACp scale for reference.

**Distance zone selector (summary bar)** — three buttons **All · 50 nm · 20 nm** filter every view on the page to aircraft within the selected radius from the airport. **All** (default) shows the full receiver coverage area with no distance limit. **50 nm** covers the terminal area and nearby overflights — typically the most relevant traffic for EFHK operations. **20 nm** covers approach and departure operations only, roughly matching the ILS corridor monitored on the Windshear page. Zone data is stored in a separate `gps_quality_zone_hours` DB table and begins accumulating from the moment the feature is first deployed; the All historical data is unaffected. For Position Gap events (no current ADS-B position) the aircraft's last-known position is used if it is no more than 2 minutes old, so that aircraft experiencing a complete GPS drop-out near the airport still count in the close-range zones. The selected zone is remembered across browser sessions.

#### WAM ground station filtering

The Finnish Air Navigation Services operate a network of Wide Area Multilateration (WAM) ground interrogator stations that transmit Mode-S replies detectable by the Radarcape. Their ICAO24 addresses begin with `T40`. These are fixed ground infrastructure — not aircraft — but without filtering they would be included in the "total aircraft seen" count every hour and could generate spurious Gap events (a WAM station never transmits ADS-B position, so it would immediately satisfy the Gap condition once seen). The system filters all `T40` prefixed addresses system-wide at both live\_state entry points (`BLOCKED_ICAO_PREFIXES` in `config.py`) so WAM stations never reach the GPS quality tracker or any other subsystem.

Finnish helicopters (`OH-H` registration prefix) are similarly excluded via `BLOCKED_REG_PREFIXES`. Their continuous manoeuvring near the airport produces unreliable BDS 5,0/6,0 computed wind unsuitable for meteo analysis. The registration filter is applied at the same two live\_state entry points, so helicopters are invisible to the GPS quality tracker, the windshear tracker, and the database writer alike.

**Registration source — JSON feed + optional BaseStation.sqb:** registrations (and aircraft types) normally come from the Radarcape JSON feed, which does not have them for every aircraft. When an aircraft has no registration from the JSON feed, it is looked up by ICAO24 address in an optional **BaseStation.sqb** aircraft database (the SQLite format of BaseStation / Virtual Radar Server; kept populated e.g. by the companion project [modes_logger](https://github.com/oh2gax/modes_logger)). Place the file at `data/BaseStation.sqb` (default) or set `BASESTATION_DB_PATH` in `config.py`. The file is opened read-only; lookups are cached per aircraft. If the file does not exist, only the JSON feed is used, as before. It is looked for again every 5 minutes and re-read when it changes, so it can be added or replaced (manually updated) while the server runs. A JSON-feed registration always takes precedence; registrations filled from the file are marked `reg_src = "BS"` in the live aircraft state. The file is gitignored (`data/*.sqb`).

#### Interpreting the data

The heatmap and time series together provide complementary views. The heatmap answers "which days and altitude layers had the most degradation?" — useful for spotting multi-day patterns and altitude-dependent effects. The time series answers "what time of day does degradation tend to peak?" — useful for identifying scheduled jamming exercises or dawn/dusk atmospheric effects.

At EFHK, GPS interference from the east tends to affect low-altitude bands (FL000–100) most heavily since the geometry between aircraft at low altitude and a ground-based jammer to the east is most favourable. High-altitude aircraft in cruise on the same routes may show weaker effects. The FL-band heatmap makes this altitude dependence immediately visible. The narrower low bands (FL010–030, FL030–050, FL050–080 and FL080–100) give extra resolution in the approach, initial climb and transition phase where jamming effects are most operationally significant. Aircraft below FL010 (1 000 ft) are excluded from all signal checks to avoid false positives from landing aircraft that disappear from reception on short final.

After the first restart, completed hourly buckets are restored from the database and the charts are populated immediately. On a brand-new installation the heatmap will be sparse for the first few hours; a meaningful pattern typically emerges after 12–24 hours of traffic.

---

### GPS Episodes  `/gps-episodes`

The detailed companion of the GPS Quality page: instead of hourly counts it shows the **individual degradation episodes** from the `gps_episodes` table (see *Degradation episode log* under [GPS Quality](#gps-quality--gps)) — which aircraft lost GPS quality, where it started, where the aircraft recovered or was lost, at what altitude and for how long. Linked from the navigation bar right of GPS Quality. The page loads data when the time selection changes and refreshes every 60 s in Live mode.

**Control bar:**
- **Window** `3h · 6h · 12h · 1d · 3d · 1w` (default 1d, remembered in the browser) — episodes that started within the rolling window; a **date** field (`dd.mm.yyyy`, typed or via the 📅 calendar) shows the episodes that started on one UTC day; **Live** returns to the rolling window. `/gps-episodes?date=YYYY-MM-DD` opens a day directly.
- Filters applied in the browser: **Min duration** (Any / ≥ 30 s / ≥ 1 min (default) / ≥ 5 min / ≥ 15 min — very short episodes are usually a single NIC or NACp blip), **Signal** (episodes in which that signal occurred), **End**, **Altitude** (episodes whose altitude range overlaps below FL100 / FL100–250 / above FL250) and **Spoofing** (Any / Any indicator / 2+ independent). `/gps-episodes?date=YYYY-MM-DD&fl=100-150` (as opened from the GPS Quality heatmap) selects that day and FL band, with the minimum duration set to Any.

**Map** — airport marker, dashed range rings at 20, 50 and 100 NM (the episode radius, `GPS_EPISODE_RADIUS_NM`) and a fainter ring at the receiver coverage edge (130 NM). Each episode is a line from the aircraft's position at the **start** (hollow circle) to its position at the **last degraded sweep** (filled circle), coloured by how it ended:

| Colour | End | Meaning |
|--------|-----|---------|
| green | Recovered | 120 s without any degradation signal; a dashed green line leads to the **recovery point** (first clean position) |
| red | Lost | the aircraft disappeared from tracking while degraded, inside receiver coverage — typically a complete loss of position |
| grey | Left coverage | "lost" at or beyond the coverage edge (end distance ≥ `GPS_EPISODE_EDGE_NM`, optional config key, default 130 NM) — the aircraft simply flew out of range while degraded, not necessarily a GPS loss |
| yellow | Below min alt | descended below `GPS_MIN_ALT_FT` while degraded (e.g. on final) |
| violet | Server stopped | the server was stopped for more than 10 minutes while the episode was open; it is shown as ended at its last degraded sweep |

Hovering a line shows callsign, type, start time, duration and end; clicking it selects the episode.

**Episode list** — newest first: start time (UTC; `D.M` prefix for earlier days), callsign, type, duration (min:s), signal chips (`NACp`, `NIC`, `FRZ` freeze, `GAP`, `LOSS` ADS-B loss — same colours as the GPS Quality charts), flight level at start, distance from the airport at start → end (an `*` marks episodes that started at the edge of the 100 NM radius, i.e. the aircraft was most likely already degraded when it entered it), end and the lowest NACp / NIC. The header line summarises the shown episodes (count, aircraft, recovered / lost / left coverage, median duration). Clicking a row highlights the episode on the map (others are dimmed), zooms to it if needed and opens a popup with all details: time span and sweeps, signals, NACp / NIC minimum, altitude range, start / end / recovery distance, altitude, track and vertical rate, and the age of the last position. Clicking the row again clears the selection.

The **detail popup** of an episode also shows the number of *severe* sweeps (position unusable) and the spoofing indicators with the largest ADS-B/MLAT distance, the number of MLAT comparisons and the GNSS − baro altitude range. In the list, a pink `SPF` chip after the signal chips marks an episode with a spoofing indicator and a filled `SPF 2+` chip one with indicators from two or more independent checks (see the Severity & Spoofing panel above).

**Altitude vs distance** — every shown episode's start (amber ▲), recovery point (green ●) and, for lost episodes, the last degraded position (red ✕), as altitude (ft) against distance from the airport (NM). If the interference source is beyond the radio horizon, start and recovery points should follow a line-of-sight pattern (aircraft lower down are affected only closer to the source). Clicking a point selects that episode.

> The defaults (minimum duration, coverage edge) and the views are based on the first episode data and may be tuned as more data is collected.

---

## Database

The SQLite database is stored at the path configured in `DB_PATH` (default: `data/modes_meteo.db`). It uses WAL journal mode for safe concurrent access.

### Tables

**`flights`** — one row per continuous contact session with an aircraft:

| Column | Description |
|--------|-------------|
| id | Auto-increment primary key |
| icao | ICAO24 hex address |
| callsign | Flight callsign (if decoded) |
| first_seen / last_seen | Unix timestamps (UTC) |
| first_lat / first_lon | Position of the first observation of the session (if known) |
| max_altitude / min_altitude | Altitude range observed (ft) |
| obs_count | Total raw observations stored |
| meteo_count | Observations with any meteo data |

**`gps_quality_hours`** — one row per completed UTC hour of GPS degradation monitoring:

| Column | Description |
|--------|-------------|
| ts | Unix timestamp of the hour start (UTC) — primary key |
| events | Total GPS degradation event count this hour |
| total | Unique aircraft seen this hour |
| degraded | Unique aircraft with at least one degradation event |
| fl_bands | JSON object mapping FL band labels to per-band event counts |
| nacp_events | Events flagged by the NACp signal this hour |
| freeze_events | Events flagged by the Freeze signal this hour |
| gap_events | Events flagged by the Gap signal this hour |
| adsb_loss_events | Events flagged by the ADS-B loss signal this hour (MLAT covering GPS dropout) |
| method | Counting-method version the hour was recorded with (1 – 4, see *Counting-method versions* under GPS Quality); existing rows were assigned 1 or 2 automatically by timestamp |
| nic_events | Events flagged by the NIC (integrity) signal this hour (0 before method 4) |
| band_detail | JSON per-band detail (`NULL` in older rows): `{"ac": {band: distinct aircraft seen}, "deg": {band: distinct degraded aircraft}, "sig": {band: {signal: events}}}`; bands below FL010 are not counted in `ac`; zero entries are omitted. Also `sev` / `s0` (severity), `spf` / `spa` / `spl` (spoofing indicators) and `t10` (10-minute slots) — see *Finer detail* under GPS Quality |

Written automatically when each hour rolls over (24 writes per day). Loaded on startup to restore up to 6 months of time-series history (the heatmap uses the most recent 31 days). Rows written before a per-signal column existed carry 0 in it and are displayed as grey "Unknown" bars in the chart until they age out.

**`gps_quality_zone_hours`** — same structure as `gps_quality_hours` but with an additional `zone` column and a composite `PRIMARY KEY (ts, zone)`; stores hourly buckets for the **50 nm** and **20 nm** distance zones separately from the All view:

| Column | Description |
|--------|-------------|
| ts | Unix timestamp of the hour start (UTC) |
| zone | Zone identifier: `'50nm'` or `'20nm'` |
| events | Total GPS degradation event count this hour within the zone |
| total | Unique aircraft seen this hour within the zone |
| degraded | Unique aircraft with at least one event within the zone |
| fl_bands | JSON object mapping FL band labels to per-band event counts |
| nacp_events | Events flagged by NACp within the zone |
| freeze_events | Events flagged by Freeze within the zone |
| gap_events | Events flagged by Gap within the zone |
| adsb_loss_events | Events flagged by ADS-B loss within the zone |

Written in parallel with `gps_quality_hours` on each hour rollover (up to 2 extra rows per hour — one per zone). Zone data begins accumulating from the first deployment of this feature; the `gps_quality_hours` table is not modified. Loaded on startup via a separate query per zone. Also has the `method`, `nic_events` and `band_detail` columns.

**`gps_quality_live`** — checkpoint of the hour in progress, one row per zone (`all`, `50nm`, `20nm`): `zone`, `ts` (hour start) and `data` (JSON bucket including the ICAO lists of aircraft seen / degraded). Rewritten every 60 s; read on startup to resume the current hour after a restart. An additional row `_episodes` holds the GPS degradation episodes open at the last checkpoint (JSON), so that they continue after a restart.

**`gps_episodes`** — GPS degradation episode log: one row per aircraft per continuous degraded period within `GPS_EPISODE_RADIUS_NM` (default 100 NM) of the airport; see *Degradation episode log* under [GPS Quality](#gps-quality--gps):

| Column | Description |
|--------|-------------|
| id | Auto-increment primary key |
| icao / callsign / registration / aircraft_type | Aircraft identity (last known value during the episode) |
| t_start / t_end | Unix timestamps (UTC) of the first and last degraded sweep |
| duration_s | `t_end − t_start` in seconds |
| sweeps | Number of degraded 5-s sweeps in the episode |
| signals | Comma-separated signals that occurred: `nacp`, `nic`, `freeze`, `gap`, `adsb_loss` |
| min_nacp / min_nic | Lowest fresh (≤ 30 s old) NACp and NIC during the episode, `NULL` if none received |
| min_alt / max_alt | Altitude range (ft, pressure altitude) during the degraded sweeps |
| start_lat / start_lon / start_alt / start_track / start_vrate / start_gs / start_dist_nm | Snapshot at the first degraded sweep (position as currently known, distance from the airport) |
| end_lat / end_lon / end_alt / end_track / end_vrate / end_gs / end_dist_nm / end_pos_age | Snapshot at the last degraded sweep; `end_pos_age` = age (s) of the position at that moment |
| rec_lat / rec_lon / rec_alt / rec_dist_nm | First clean sweep after the last degraded one (recovery point); `NULL` when the episode ended `lost` or `below_min_alt` without a clean sweep |
| end_reason | `recovered`, `lost`, `below_min_alt` or `shutdown` (server stopped > 10 min while the episode was open) |
| method | GPS counting-method version (4) |
| severe_sweeps | Degraded sweeps with an unusable position (NACp 0, NIC 0 or no own ADS-B position); `NULL` in older rows |
| spoof | Spoofing indicators seen while the episode was open, e.g. `mlat_dis,gmb_jump` (`mlat_dis`, `gmb_sat`, `gmb_jump`, `pos_jump`; see *Finer detail* under GPS Quality); `NULL` = none |
| max_mlat_nm | Largest flagged distance between the own ADS-B and the MLAT position (NM) |
| mlat_cmp | Sweeps in which the own ADS-B position could be compared with an MLAT position |
| gmb_min / gmb_max | Range of the GNSS − barometric altitude difference (ft, TC 19) while the episode was open |

Unique index on `(icao, t_start)`, index on `t_start`. Never auto-purged; manual purge on the Maintenance page.

**`approach_history`** — one row per completed landing approach (persisted by `WindshearTracker` via callback hook in `run.py`):

| Column | Description |
|--------|-------------|
| id | Auto-increment primary key |
| ts | Unix timestamp (UTC) of the landing: contact-lost (stale-out) moment, or the threshold-crossing time when the aircraft was tracked through the threshold |
| date_utc | `"YYYY-MM-DD"` — used for date-based filtering |
| time_utc | `"HH:MM"` — display time |
| icao | ICAO24 hex address |
| callsign | Flight callsign |
| registration | Aircraft registration (if known) |
| aircraft_type | Aircraft type code (if known) |
| runway | Runway designator, e.g. `"22L"` |
| rwy_heading | Runway approach heading (°) |
| bands_json | JSON object keyed by altitude ft MSL (as string; see `qnh_hpa`); value is `{"dir": int, "spd": float}` or `null` when no fresh wind was captured at that level (see `WIND_MAX_AGE_SEC`); e.g. `{"200": {"dir": 270, "spd": 15}, "400": null, …}` |
| go_arounds | Integer count of go-arounds performed by this aircraft before the final landing; 0 for normal straight-in approaches |
| qnh_hpa | METAR QNH (hPa) used to convert the band altitudes from pressure altitude to MSL; `NULL` when no METAR QNH was available (bands are then raw pressure altitude) |
| gnss_json | GNSS quality during the approach (`NULL` in older rows or when nothing was captured). `bands`: per altitude band (same keys and ±100 ft tolerance as `bands_json`) `{"nacp": lowest fresh NACp, "nic": lowest fresh NIC, "pa": largest age (s) of the aircraft's own ADS-B position, "fz": 1 if the position-freeze gate fired, "n": sweeps}`; `n` / `deg_n`: in-corridor sweeps / degraded sweeps; `first_deg`, `last_deg`, `rec`: `{"alt": ft MSL, "dist": NM to threshold}` of the first and last degraded sweep and of the first clean sweep after degradation. A sweep counts as degraded when NACp ≤ 6, NIC ≤ 6, the position freeze gate fired, or the aircraft is sending extended squitters but its own ADS-B position is ≥ 10 s old. Note that at the lowest altitudes `pa` also grows when the aircraft drops below the receiver's line of sight, so a large `pa` alone is not proof of jamming |
| rough_json | Approach roughness on the established final (`NULL` in older rows): per segment `hi` (3 000–1 000 ft MSL) and `lo` (1 000–200 ft MSL) bank-angle, track-rate, IAS, vertical-rate and crab-angle statistics from all raw BDS 5,0 / 6,0 replies, plus the METAR at landing time and the autopilot state `ap`; see [Approach roughness logging](#approach-roughness-logging) |
| prof_json | Wind / temperature profile of the final approach per 200-ft band (`NULL` in older rows): averaged wind with sample count and spread, headwind component (TAS − GS) and Mach/TAS temperature; see [Approach roughness logging](#approach-roughness-logging) |

Indexed on `ts`, `date_utc`, and `runway`. Data volume: about 2 kB per landing with all JSON columns (bands ~0.4 kB, rough ~0.4 kB, GNSS ~0.6 kB, profile ~0.6 kB — measured 9 Oct 2026), i.e. roughly 0.5 MB per day or 150–200 MB per year at EFHK traffic (about 230 landings per day); never auto-purged (manual purge on the Maintenance page). Older rows without the JSON columns are much smaller (bands only). Loaded on server startup to pre-populate the RAM approach list for immediate display in fresh browser sessions.

**`maintenance_config`** — key/value store for maintenance page settings:

| Column | Description |
|--------|-------------|
| key | Setting name (primary key) |
| value | Setting value as text |

Used keys: `autopurge_flight_enabled` (`'0'`/`'1'`), `autopurge_flight_days` (integer as text), `autopurge_last_run` (Unix timestamp as text). Written by the maintenance API; read by the autopurge background thread.

**`observations`** — decoded observations, subject to `STORAGE_MODE` and the write throttle:

- Position: `lat`, `lon`, `altitude` (ft)
- Motion: `groundspeed` (kt), `track` (°), `vert_rate` (ft/min)
- `flight_id` (→ `flights.id`), `icao`, `ts`
- MRAR: `mrar_wind_spd/dir/temp/pressure/humidity/turbulence/fom`
- MHR: `mhr_temp/pressure/turbulence/wind_shear/icing/microburst/radio_height`
- Computed wind: `wind_spd/dir/qual`, `tas_source` (`BDS50` / `MACH` / `IAS`, see [Computed wind](#computed-wind-bds-50--60)), `mag_decl` (declination used, °E)
- Raw BDS 5,0 / 6,0 inputs (stored for re-processing): `bds50_true_track`, `bds50_groundspeed`, `bds50_true_airspeed`, `bds50_roll`, `bds60_mag_heading`, `bds60_ias`, `bds60_mach`
- Consolidated best values: `best_wind_spd/dir/temp/pressure`, `meteo_source`
- `tm_temp` — static air temperature from BDS 5,0 TAS and BDS 6,0 Mach (°C; see [Air temperature](#air-temperature-bds-50--60))
- `hdg_off`, `hdg_src` — heading calibration: offset (°) subtracted from the true heading for `best_wind_*` and its source (`A` own airframe, `T` type median, `F` fleet median, `D` default, `X` excluded — no best wind; lower case = learn mode, not applied). `wind_spd / wind_dir` are the raw, uncorrected wind. See [Heading calibration](#heading-calibration-per-airframe)

**`heading_cal`** — per-airframe heading offsets learnt from the data: `icao` (primary key), `typ` (ICAO aircraft type), `s`, `w`, `n` (faded least-squares sums and sample count; offset = −s/w), `t` (time the sums were last faded to), `flights` (completed flights with data), `last_ts`, `delta` (current offset, °), `updated`. One row per airframe (about 1–2 thousand rows), written once an hour for the airframes that changed and at shutdown; rows of airframes unseen for 8 half-lives (240 days) are deleted.

**`departure_profiles`** — climb-out profile of each departure (`collector/departures.py`): `ts` (end of capture), `t_start`, `icao`, `callsign`, `registration`, `aircraft_type`, `qnh_hpa`, `track` (initial climb track), `lat` / `lon` (first position), `ga` (1 = climb-out of a go-around: the aircraft was established on an approach, descending in an ILS corridor, or had crossed the threshold of its approach without a confirmed landing — low go-around or touch-and-go — when its climb began), `prof_json` (same format as `approach_history.prof_json`: per 200 ft band from 200 to 3 000 ft MSL `n` / `ws` / `wd` / `sd` wind pairs and vector mean, `t` / `tn` Mach/TAS temperature trimmed mean and replies). A departure is followed from within 6 NM of the airport, below 1 500 ft MSL, climbing ≥ 300 fpm, until it is above 3 300 ft, 25 NM away, descending or not updated for 60 s; every raw BDS 6,0 reply is paired with the nearest BDS 5,0 reply (≤ 2 s), its altitude interpolated between the 3-s sweeps (a climbing jet moves 150 ft in 3 s); temperature always, wind only with ≤ 5° bank and with the heading calibration applied. Committed when ≥ 3 bands have a temperature or a wind (turboprops report no Mach, so their climbs give winds only); one INSERT per departure, about 0.5–1 kB. Departures give fewer replies per band than approaches (they climb 4–5 times faster than a 3° glide path) and turn earlier (fewer wind pairs pass the bank gate); temperature is not affected by turns. Kept `DEPARTURE_PROFILE_DAYS` (default 90) days, purged daily (archived first when **Archive before purge** is on). `DEPARTURE_PROFILES = False` turns the capture off.

**`profile_hours`** — hourly atmospheric profile archive: one row per completed UTC hour (`ts` = hour start) with the area profile of all aircraft within `SOUNDING_RADIUS_KM` of the receiver, `data` = `{"r": radius km, "n": observations used, "a": distinct aircraft, "lv": [[alt_lo, temp, temp_p10, temp_p90, temp_count, wind_dir, wind_spd, wind_sd, wind_count, ac_count], …]}` per altitude layer (1 000 ft to 10 000 ft, 2 000 ft above), and `"m": {"z": "DDHHMM", "q": QNH, "tt": °C, "td": °C, "cld": "BKN014"}` — the latest METAR of that hour (observation time within the hour or up to 20 min after; back-filled hours have none), for the Sounding page's ground line, dewpoint and parcel analysis. Computed a few minutes after each hour change from the observations (one read query and one insert; at startup missing hours of the last 31 days are back-filled from the observations still in the database), so the profiles survive the observation autopurge. About 0.4–1.2 kB per row, 24 rows per day; never purged. Shown on the Sounding page (**Area · hour**).

**`kinematics_hours`** — hourly vorticity / divergence profile (`collector/kinematics.py`): `ts` (hour start), `data` = `{"r": radius km, "lv": [[alt_lo, vort, div, se_vort, se_div, aircraft], …]}` in 10⁻⁵ s⁻¹, only layers with at least 6 aircraft spread in two directions (an hour without any has `"lv": []`). Computed by the hourly jobs from plane fits of the aircraft winds within `KINEMATICS_RADIUS_KM` (default 200 km); at startup missing hours of the last 31 days are back-filled. About 0.3 kB per row; never purged. Shown on the Sounding page's Time–height section (**Vorticity**).

**`gnss_cal`** — calibration of the GNSS heights of the pressure surfaces (`collector/gnss_heights.py`): `key` `sonde:YYYYMMDDHH` = the aircraft − sonde residuals of one sounding (`data` = `{"n": pairs, "c": [[icao, band, residual m, replies], …]}`, a few kB), `key` `current` = the fitted correction (`curve` per 5 000 ft band, airframe offsets `b`, `soundings`, `pairs`). Updated by the hourly jobs after each sounding; the correction uses the last 30 days.

**`gnss_hours`** — hourly raw GNSS-height cells: `ts` (hour start), `data` = zlib-compressed JSON `{"d": [[layer bottom, icao, mean GNSS − baro ft, mean altitude ft, replies], …], "tk": [[lo ft, hi ft, icao, height m at lo, height m at hi, mid time, +1 climb / −1 descent], …], "v": 3, "g": 1}` (the EGM96 geoid removed at each position, otherwise uncorrected — the current calibration is applied when read). Written 4 h after the hour, about 1–2 kB per row; kept `GNSS_HOURS_DAYS` days (default 0 = always).

**`sonde_verification`** — automatic comparison of the area profile with the radiosonde (`collector/sonde_verif.py`, shown under **Sonde check** on the Sounding page): `kind` (`launch` — area profile ±1 h around a sounding's launch; `hour` — an archived hourly profile vs the newest earlier sounding), `ts` (launch time / hour start, unique per kind), `sonde_key` (YYYYMMDDHH), `age_h` (profile middle − launch, h), `min_p` (top of the sounding, hPa), `aircraft`, `obs`, `n_t` / `t_bias` / `t_rms` (temperature layers, area − sonde, K), `n_w` / `w_rms` / `ws_bias` (wind layers, vector RMS difference and speed bias, kt) and `bands` (JSON, the same per altitude band). Written by the hourly jobs (3 launch rows and up to 24 hour rows a day, about 0.3 kB each); never purged.

**`meps_hours`** — MEPS model profiles (`collector/meps.py`, MET Norway open data, CC BY 4.0; shown under **MEPS check** and with the Skew-T **MEPS** tick box): `ts` (valid time, UTC hour), `run` (run start), `lead` (hours after it; +0 … +2 verification values, +3 … +5 provisional), `data` = JSON `{"p": [200 … 1000 hPa], "n": model points, "rad": km, "a": {"t": °C, "u": kt, "v": kt, "z": gpm, "rh": %, "q": g/kg}` (mean over the sounding radius), `"j": {…}` (the model column at Jokioinen)}. About 0.9 kB per hour (8 MB a year); never purged.

**`height_series`** — dense pressure-altitude / GNSS − baro series per aircraft visit (`collector/height_series.py`): `ts` / `t_end` (first / last row), `icao`, `callsign`, `n` (rows), `n_gmb` (rows with a difference), `alt_min` / `alt_max` (ft pressure altitude), `data` = zlib-compressed JSON of integer columns `t` (0.1 s), `alt` (ft), `gmb` (ft), `lat` / `lon` (1e-4°), `nacp`, delta-coded except NACp; decoded by `height_series.decode()`. Rows older than `HEIGHT_SERIES_DAYS` (default 30) are deleted daily.

**`approach_series`** — raw reply series on final per landing: `ts`, `icao`, `runway` (same as the `approach_history` row) and `data` = zlib-compressed JSON of integer columns (BDS 5,0 / 6,0 replies and the 3-s sweeps; layout in `WindshearTracker.SERIES_COLS`, decoded by `WindshearTracker.decode_series()`). About 2–3 kB per landing; rows older than `APPROACH_SERIES_DAYS` (default 90) are deleted daily, and with the approach history purges. See [Approach roughness logging](#approach-roughness-logging).

### Direct database queries

The database can be queried while the system is running (WAL mode allows concurrent reads):

```bash
sqlite3 data/modes_meteo.db
```

Useful queries:

```sql
-- Meteo observation counts by source
SELECT meteo_source, COUNT(*) FROM observations GROUP BY meteo_source;

-- Which true-airspeed source computed winds used (last 7 days)
SELECT tas_source, COUNT(*) FROM observations
WHERE meteo_source = 'COMPUTED' AND ts > unixepoch('now','-7 days')
GROUP BY tas_source;

-- Recent temperature readings
SELECT datetime(ts,'unixepoch'), icao, altitude, best_temp, best_wind_spd, best_wind_dir
FROM observations
WHERE meteo_source != 'NONE' AND ts > unixepoch('now','-1 hour')
ORDER BY ts DESC LIMIT 20;

-- Flights with most meteo data
SELECT icao, callsign, meteo_count, max_altitude, min_altitude,
       datetime(first_seen,'unixepoch') AS first, datetime(last_seen,'unixepoch') AS last
FROM flights ORDER BY meteo_count DESC LIMIT 20;

-- All approaches today
SELECT time_utc, callsign, registration, aircraft_type, runway
FROM approach_history
WHERE date_utc = date('now')
ORDER BY ts DESC;

-- Wind at 800 ft and 1000 ft for RWY 22L over the last 7 days
SELECT time_utc, callsign,
       json_extract(bands_json, '$.800.dir')  AS dir_800,
       json_extract(bands_json, '$.800.spd')  AS spd_800,
       json_extract(bands_json, '$.1000.dir') AS dir_1000,
       json_extract(bands_json, '$.1000.spd') AS spd_1000
FROM approach_history
WHERE runway = '22L'
  AND ts > unixepoch('now', '-7 days')
ORDER BY ts DESC;

-- Approach count by runway today
SELECT runway, COUNT(*) AS approaches
FROM approach_history
WHERE date_utc = date('now')
GROUP BY runway
ORDER BY approaches DESC;
```

---

## GPS Jamming Note

The EFHK (Helsinki-Vantaa) area is periodically affected by GPS jamming originating from the east (Russian Federation). This disrupts ADS-B position broadcasts from aircraft that rely on GPS, causing them to disappear from the map or appear stationary.

The system mitigates this in two ways:

1. **MLAT positions from the Radarcape JSON feed** — the Radarcape calculates aircraft positions via Multilateration (MLAT), which uses precise timing of Mode-S replies at multiple ground stations and does not depend on GPS. These positions are merged into the live display automatically (the aircraft keeps its meteo-source colour — MLAT positions are not marked separately; purple means meteo values from the JSON feed).

2. **Single-frame CPR decoding** — for aircraft that are transmitting CPR position data but whose messages are being rejected by the bootstrap mechanism, the system uses `airborne_position_with_ref()` to decode position from a single frame using the receiver's known location as a reference (valid within 180 NM). It applies to airborne-position type codes only, and is used whenever the decoder withheld the position — also when an older or MLAT position is already known for the aircraft.

The interference itself is monitored on the [GPS Quality](#gps-quality--gps) page (hourly statistics per altitude band) and the [GPS Episodes](#gps-episodes--gps-episodes) page (where individual aircraft lost and regained GPS), and GNSS quality on final approach is stored with every landing in Approach History (`gnss_json`).

---

## Project Structure

```
mode_s_wind/
├── README.md                  # This document
├── CHANGELOG.md               # Dated record of all changes
├── LICENSE                    # GNU GPL v3
├── config.py                  # All configuration settings
├── api_keys.py                # Local API keys (gitignored — not committed)
├── api_keys.py.example        # Template for api_keys.py (safe to commit)
├── run.py                     # Main entry point; starts collector, JSON poller, windshear / GPS sweeps,
│                              # housekeeping, autopurge and hourly-jobs threads, then Flask
├── requirements.txt           # Python dependencies (pyModeS, flask, pygeomag)
├── install.sh                 # Raspberry Pi install script (venv + dependencies)
├── tools/
│   └── archive_query.py       # Combine monthly archive files + running DB into one analysis DB / CSV query
├── database/
│   ├── db.py                  # SQLite connection management + schema migrations
│   ├── maintenance.py         # Purge / statistics / autopurge logic for the Maintenance page
│   ├── archive.py             # Monthly archive files before purge, snapshots (VACUUM INTO)
│   └── schema.sql             # Database schema
├── collector/
│   ├── receiver.py            # Beast TCP connection + EHS decoder (NACp / NIC, BDS 5,0/6,0 pairing + raw reply buffer)
│   ├── radarcape_json.py      # Radarcape JSON/MLAT poller
│   ├── aircraft_db.py         # Optional BaseStation.sqb registration / type lookup (cached, read-only)
│   ├── writer.py              # Batched SQLite writer (storage mode, write throttle, flight sessions)
│   ├── wind_calc.py           # BDS 5,0 + 6,0 computed wind, TAS sources, ISA-deviation estimate
│   ├── atmos.py               # Mach/TAS air temperature, altitude-layer profiles, hourly profile archive
│   ├── declination.py         # Position-based magnetic declination (WMM2025 via pygeomag)
│   ├── heading_cal.py         # Per-airframe heading offset learning and wind correction
│   ├── departures.py          # Departure climb-out profile capture (200 ft bands, raw replies)
│   ├── sondes.py              # Radiosonde soundings from FMI open data (fetch, store in data/soundings)
│   ├── meps.py                # MEPS model profiles from MET Norway (OPeNDAP, plain Python), MEPS check
│   ├── sonde_verif.py         # Automatic verification of the area profile against the radiosonde (Sonde check)
│   ├── height_series.py       # Dense pressure-altitude / GNSS − baro series per aircraft visit
│   ├── kinematics.py          # Hourly vorticity / divergence from plane fits of the aircraft winds
│   ├── gnss_heights.py        # Heights of the pressure surfaces: sonde calibration, D-values, thickness temperatures
│   ├── moisture.py            # Trial moisture indicator (thickness Tv − Mach/TAS T, offsets from the soundings)
│   ├── geoid.py               # EGM96 geoid height over southern Finland (built-in 5′ grid)
│   ├── windshear.py           # Approach tracker: ILS corridor, go-arounds, approach history capture (wind bands, GNSS quality, roughness, autopilot, band profile, raw series)
│   ├── approach_cond.py       # Provisional approach-conditions index (roughness → 0–10)
│   ├── gps_quality.py         # Area-wide GPS quality monitor: hourly buckets (RAM + DB), degradation episode log
│   └── filter.py              # Observation quality filters
├── web/
│   ├── app.py                 # Flask app + all API routes
│   ├── access_log.py          # Compact access / misuse log (logs/access.log), login lockout
│   ├── whats_new.py           # Version v.DDMMYYYY (newest of doc/whats_new.md, CHANGELOG.md), What's new notes, user guides
│   ├── api/
│   │   ├── sounding.py        # Sounding aggregation logic (area, hourly archive, single flight)
│   │   ├── lowlevel.py        # Airport low-level profile (landings + departures, 200 ft bands)
│   │   └── windmap.py         # Gridded wind map aggregation logic, cross-section along a line
│   └── templates/
│       ├── base.html          # Navbar, status indicator, config badges
│       ├── live.html          # Live map page
│       ├── flights.html       # Flights browser page
│       ├── sounding.html      # Skew-T sounding page
│       ├── windmap.html       # Gridded wind map page
│       ├── windshear.html     # Approach monitoring + windshear page
│       ├── gps_quality.html   # GPS quality monitoring page
│       ├── gps_episodes.html  # GPS degradation episode map / list / scatter page
│       └── maintenance.html   # Database maintenance page
├── static/
│   ├── css/style.css          # Dark/light theme stylesheet
│   └── js/
│       ├── live_map.js        # Live map, ATC display, atmosphere profile
│       ├── skewt_analysis.js  # Skew-T analysis: tropopause, isotherms, wind max, inversions, stability, shear / Ri
│       ├── skewt_chart.js     # Skew-T diagram (createSkewT), shared by the Live Map and the Sounding page
│       ├── skewt_indices.js   # Stability indices and levels for the Sounding page's Indices panel
│       ├── sounding.js        # Sounding page: sources, data table, diagram controls
│       ├── timeheight.js      # Sounding page: time–height section of the hourly profiles
│       ├── windmap.js         # Wind map barb rendering + controls
│       ├── windmap_analysis.js # Wind map smoothed field, isotachs, streamlines, jet axis
│       ├── windmap_xsection.js # Wind map vertical cross-section along a drawn line
│       ├── windshear.js       # Approach strips, ILS profile, windshear detection
│       ├── gps_quality.js     # GPS quality charts, heatmap, live table
│       ├── gps_episodes.js    # GPS Episodes page: map, episode list, altitude/distance scatter
│       └── maintenance.js     # Maintenance page client-side logic (purge controls, autopurge, stats)
├── overlays/                  # GeoJSON overlays served to the Windshear map
│   ├── efhk_ils.geojson       # EFHK ILS centreline geometry (all runways)
│   ├── efhk_apt.geojson       # EFHK airport layout (runways, taxiways)
│   ├── efhk_coast.geojson     # Coastline overlay (ATC+C / Black+C overlay level)
│   ├── efhk_aqua.geojson      # Water / aqua polygons (ATC+CA / Black+CA overlay level)
│   └── efhk_ats.geojson, efhk_border.geojson, efhk_fir.geojson, efhk_nav.geojson
│                              # Present but not currently loaded by any page (reserved for future overlays)
├── doc/                       # README screenshots, Skew-T user guide (SkewT_User_Guide.pdf), Approach Conditions Index article,
│                              # Sounding page / Wind Map guide (Sounding_Page_User_Guide.pdf), whats_new.md (user notes of the
│                              # latest versions) and guides.md (the guides of the User guides tab) for the What's new window
├── data/                      # SQLite database (created at runtime); optional BaseStation.sqb; soundings/ (radiosondes)
├── logs/                      # Log files (created at runtime)
└── tmp_files/                 # Local scratch folder (gitignored)
```

---

## Maintenance  `/maintenance`

The page has no navigation-bar link; open it by typing `/maintenance` after the server address.

An administrator page for database housekeeping. It is accessible at `/maintenance` and rendered by `web/templates/maintenance.html`.

Authentication is handled separately from the main web credentials — all operations require a username and password read from a credential file whose path is set in `config.py` as `MAINTENANCE_AUTH_FILE`. The file contains a single line in `username:password` format and should be placed outside the project directory and excluded from version control (`.gitignore` already ignores `dbauth.txt`). `MAINTENANCE_AUTH_FILE` is empty by default — while it is empty (or the file cannot be read) every login is rejected, so set the full path in your local `config.py`. Credentials are submitted with every operation and never stored in a server session.

**Operations:**

- **Database statistics** — read-only view showing for each table: row count, number of distinct calendar days with data, oldest and newest record dates, and total SQLite file size; refreshed on demand; the days count helps choosing an appropriate purge threshold
- **Flight & Meteo data purge** — deletes records from `observations` and `flights` either older than a configurable number of days, or within a chosen date range; each section has a **Preview** step that shows exact row counts before deletion; `approach_history` is never touched by Autopurge. Deletes run in batches of 5 000 rows, each committed separately, so the database write lock is only held briefly and the collector keeps storing live observations during a large purge (if the database is still momentarily locked, the collector keeps the observations in RAM and retries on its next flush instead of dropping them). Both purge types delete a flight row only when none of its observations remain — e.g. a flight that started before a chosen date range (crossed midnight) keeps its row and its earlier observations. **A large purge can take a long time** (on a Raspberry Pi roughly 2 000–7 000 observation rows per second, i.e. several minutes to tens of minutes for millions of rows); the result line appears on the page only when the purge has finished, and a browser may give up waiting after ~5 minutes while the server keeps purging. Completion is always logged: `Maintenance: deleted N observations, M flights` in `logs/modes_meteo.log`
- **GPS Quality data purge** — separately deletes rows from `gps_quality_hours` and `gps_quality_zone_hours` either older than a configurable threshold or within a chosen date range; useful for removing a maintenance day with incomplete data; the in-RAM GPS quality cache is reloaded immediately after the delete so the GPS Quality page reflects the change without a server restart
- **Approach History purge** — `approach_history` is never auto-purged; manual purge controls are provided: **Older Than N Days** (Preview + Purge, default 90 days) and **Delete by Date Range** (From / To date pickers, same single-day shortcut as other sections); both operations also clear the in-RAM approach history list so the live panel stays consistent; the Delete button is only enabled after a non-zero Preview
- **GPS Degradation Episode Log purge** — `gps_episodes` is never auto-purged and is not affected by the GPS Quality purge; manual controls: **Older Than N Days** (Preview + Purge, default 365 days) and **Delete by Date Range**; episodes are selected by their start time (UTC). The statistics table shows the row count and date range of `gps_episodes` (and of `approach_series` and `profile_hours`; approach series are purged automatically after `APPROACH_SERIES_DAYS` and together with the approach history)
- **Delete by Date Range** — Flight, GPS, Approach History and GPS Episode Log sections each include a **Delete by Date Range** panel with From / To date pickers; entering the same date in both fields deletes a single day; the server validates the date format and rejects ranges where From > To
- **Autopurge** — optional daily scheduled purge for flight/meteo data only; when enabled, a background thread checks once per hour and runs the purge when the last run is more than 24 hours ago; settings (enabled/disabled, day threshold) are persisted in the `maintenance_config` DB table; GPS Quality, Approach History and the GPS Episode Log are never auto-purged
- **Archive before purge** — selector next to the autopurge threshold (saved with **Save**, `maintenance_config` key `archive_enabled`). When on, every flight & meteo purge — the daily autopurge and the manual **Older Than N Days** / **Delete by Date Range** purges — first copies the observations it is about to delete, with their flights, into a **monthly archive file** `modes_meteo_archive_YYYY-MM.db` (UTC month of the observation) in the archive folder, and the daily retention purges of `approach_series` and `departure_profiles` do the same. The copy runs day by day (`ATTACH` + `INSERT OR IGNORE … SELECT`, all columns, same ids — a repeated run never duplicates rows), each day is committed and checked (every row of the day must be in the archive) before anything is deleted; on any problem (disk full: at least 200 MB must remain free; I/O error) the purge is skipped, nothing is deleted, and the error is shown on the page and logged. Columns added to the database later are added to an existing archive file automatically. Every observation is in exactly one place: the running database or one monthly file (a flight crossing a month boundary appears in both files). Measured size about 200 bytes per observation (≈ 6 MB per day, 175 MB per month at the 30 s throttle). Tables that are never auto-purged (approach history, GPS quality, episodes, hourly profiles, heading calibration) stay in the running database. Folder: `ARCHIVE_DIR` in `config.py` (optional; default `data/archive/`, e.g. a USB SSD or NAS path)
- **Archive Files & Snapshots** — folder and free space, the list of archive files (size, observations, first / last) and **Create snapshot now**: a compact copy of the whole running database (all tables, `VACUUM INTO`) as `modes_meteo_snapshot_YYYYMMDD_HHMM.db` in the same folder, written in the background while the system keeps running (needs free space up to the database size) — e.g. for analysis on another computer
- **Combining archive and live data** — `tools/archive_query.py` (run on the Pi or on a copy): `--list` shows what is where; `--from 2026-09-01 --to 2026-12-31 --out analysis.db` writes one SQLite file with all observations / flights / approach series / departure profiles of the period from the archive files and the running database (de-duplicated by id) plus the tables that live only in the running database; `--sql "…"` runs a query on the combined data and prints CSV. It only reads the database and the archive files

**Reclaiming disk space after a purge (VACUUM):** SQLite does not shrink the database file automatically after deleting rows — freed pages are kept in an internal free list and reused by future writes, so the file stays the same size on disk. New data written after a purge will fill those free pages first, meaning the file will not grow again until all reclaimed space is consumed. To actually compact the file and release disk space to the OS, run `VACUUM` manually after stopping the server:

```bash
# Stop the server first, then:
sqlite3 data/modes_meteo.db "VACUUM;"
```

`VACUUM` rewrites the entire database into a fresh compact file. It requires roughly the same amount of free disk space as the current file size temporarily; a small database finishes in seconds, a multi-hundred-MB database on an SD card can take several minutes. The WAL journal mode used by this project is fully compatible with `VACUUM`. Always stop the server before running it to avoid write conflicts.

---

## API Endpoints

The web server exposes a REST JSON API used by the frontend. All endpoints require HTTP Basic Auth.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/live/state` | Snapshot of all currently visible aircraft |
| GET | `/api/live/stream` | Server-Sent Events stream (3-second updates) |
| GET | `/api/live/aircraft/<icao>` | Last 30 minutes of observations for one aircraft |
| GET | `/api/aircraft/<icao>/wind_history` | Full wind+temp history for the aircraft's current flight (used to pre-seed the live map atmosphere profile and aircraft track polyline); response includes `lat` and `lon` fields for each observation |
| GET | `/api/flights` | Paginated flight list (params: `page`, `per`, `icao`, `callsign`, `meteo`) |
| GET | `/api/flights/<id>` | Full observation track for one historical flight |
| GET | `/api/flights/<id>/sounding` | Per-flight Skew-T sounding profile |
| GET | `/api/flights/suitable_soundings` | Flights eligible for per-flight sounding |
| GET | `/api/sounding` | Area sounding of all aircraft within `SOUNDING_RADIUS_KM` over the last `?minutes=` (10–360, default `SOUNDING_WINDOW_MIN`): altitude layers with trimmed-mean Mach/TAS temperature (10–90 % range, count), vector-mean wind (SD, count) and `ac_count` (distinct aircraft per layer); `aircraft` = distinct aircraft in the window; `?moist=1` adds `moisture` = the trial moisture indicator of the hour in progress (`hour`, `rows` = [[lo ft, hi ft, index %, ± % total, flights, Tv − T after the offsets K, raw K, ± % from the flights], …], `window_h`, `offsets_n`, `uncertain_pct`) |
| GET | `/api/sondes` | Stored radiosonde soundings (`data/soundings/`): `station`, `fetch`, `keep_days`, `last_fetch` and `items` (newest first: `key` YYYYMMDDHH, `nominal`, `launch`, `end`, `min_p`, `n` stored levels, `n_raw`, `qc` — reason when the quality check cut the top, else `null`) |
| GET | `/api/sonde/verification` | Sonde check summary of the last `?days=` (1–366, default 30) days from `sonde_verification`: `launch_total`, `hour_total` and per altitude band (`bands`) / age bin (`age`, with `lo` / `hi` hours) pooled `rows`, `n_t`, `n_w`, `t_bias`, `t_sd`, `t_rms`, `w_rms`, `ws_bias`; `launches` (newest first, one per verified launch) |
| GET | `/api/meps/profile` | MEPS area-mean profile for the Skew-T at `?at=<Unix s>` (default now), linear in time between the stored hours: `found`, `run`, `lead`, `provisional` (lead > 2), `points`, `radius_km`, `levels` (`pressure`, `temp`, `dewpoint`, `wind_dir`, `wind_spd`, `z_m`, `rh`); `{found: false, newest}` when there is none |
| GET | `/api/meps/check` | MEPS check of the last `?days=` (1–90, default 7), `?busy=N` hours with at least N aircraft: `hours`, `hours_meps`, `newest_run`, `status` (fetcher), `totals` (`all` / `day` / `night`: `t_bias`, `t_rms`, `w_rms`), `levels` (per pressure level `n_t`, `t_bias`, `t_sd`, `t_rms`, `n_w`, `w_rms`, `ws_bias`, `n_d`, `d_bias`, `d_sd`, `d_r`), `soundings` (per sounding `t_as`, `t_am`, `t_js`, `t_aj`, `w_as`, `w_am`, `w_js`) and `distance` (pooled RMS and the share explained by the distance) |
| GET | `/api/sonde` | One sounding for the Skew-T: `?key=YYYYMMDDHH`, or `?at=<Unix s>` (newest launched at or before that time, at most `?max_age_h=` 36 h older), default the latest; `levels` with `pressure`, `altitude` (ISA pressure altitude, ft), `z_m`, `temp`, `dewpoint`, `wind_dir`, `wind_spd` (kt); `qc` (reason when the top was cut by the quality check); `{"found": false}` when there is none; with `?have=KEY:N_RAW` and that copy still current only `{"found": true, "unchanged": true, "key"}` |
| GET | `/api/sounding/hours` | Hours stored in the hourly profile archive for `?date=YYYY-MM-DD` (UTC): `[{ts, n}, …]` |
| GET | `/api/sounding/timeheight` | Time–height section: `?hours=` (6–336, default 72) `&end=<Unix s>` (default now) → `layers` (layer bottoms, ft), `start_ts`, `end_ts`, `cols` (one per UTC hour from `profile_hours`, the hour in progress live with `partial`: `ts`, `a` aircraft, `n` replies, `q` / `tt` METAR QNH / temperature, `lv` = [[alt_lo, temp, temp_n, wind_dir, wind_spd, wind_n, aircraft], …], `kz` = [[alt_lo, vorticity, error, aircraft], …] in 10⁻⁵ s⁻¹ from `kinematics_hours`, `dv` = [[alt_lo, D-value m, SD m, airframes], …], `tk` = [[lo ft, hi ft, thickness temperature °C, SD K, flights, Mach/TAS temperature °C], …], `mo` = [[lo ft, hi ft, moisture index %, ± % total, flights, Tv − T after the offsets K, raw K, ± % from the flights], …]); `gcal` = soundings / pairs of the height calibration; `mcal` = the moisture offsets per layer (`climb`, `descent` K, `n_climb`, `n_descent`, `n` soundings); `moist_faint_pct` = the ± above which the moisture field is drawn faint; `sondes` = the Jokioinen soundings launched in the period averaged into the layers (`key`, `launch`, `min_p`, `lv` = [[alt_lo, temp, wind_dir, wind_spd, D-value m], …], `mo` = [[lo ft, hi ft, moisture index %, mean RH %], …]) |
| GET | `/api/gnss/calibration` | Current calibration of the GNSS heights: `bands` (per 5 000 ft: `corr_m`, `cells`, `prior_m`), `soundings`, `pairs`, `airframes`, `offset_sd_m`, `offsets` (per ICAO, m), `airframe_list` (`icao`, `reg`, `type`, `soundings`, `raw_m`, `offset_m`), `by_type` (`type`, `airframes`, `mean_m`, `sd_m`) |
| GET | `/api/sounding/hour` | Hourly archive profile of one completed UTC hour, `?ts=<hour start>`; `sfc` = the METAR stored with the hour (`z`, `q`, `tt`, `td`, `cld`) or null; `?moist=1` adds `moisture` (as `/api/sounding`); HTTP 404 when none is stored |
| GET | `/api/stats` | Live aircraft counters for the navbar (`live_aircraft`, `live_with_meteo`); RAM-only, no database queries |
| GET | `/api/whatsnew` | Version (`version`, v.DDMMYYYY, newest heading of `doc/whats_new.md` / `CHANGELOG.md`) and the notes of the What's new window (`entries`: newest 10 of `doc/whats_new.md`, each `version`, `date`, `title`, `lines` in Markdown) and the user guides (`guides`: from `doc/guides.md`, each `title`, `file`, `url`, `version`, `date`, `pages`, `size` in bytes, `lines`, `open`) |
| GET | `/doc/<file>` | A user guide PDF — only the files listed in `doc/guides.md` (404 for anything else); supports range requests for the browser's PDF viewer |
| GET | `/api/lowlevel` | Airport low-level profile: the 200 ft band profiles (Mach/TAS temperature, wind) of the landings and departures of the last `?minutes=` (10–360, default 60) pooled per band, with spread and counts (`web/api/lowlevel.py`); optional `?end=<Unix s>` ends the window at that time instead of now |
| POST | `/api/maintenance/archive/list` | Archive folder status (free space, last archive run / error, snapshot state) and the archive / snapshot files (maintenance credentials) |
| POST | `/api/maintenance/archive/snapshot` | Start a snapshot of the whole database (`VACUUM INTO`) in the background (maintenance credentials) |
| GET | `/api/heading_cal` | Heading calibration status: mode, airframe counts (calibrated / excluded), fleet and aircraft-type median offsets, and each airframe's offset, flights, samples and status (`?airframes=0` omits the list); RAM-only |
| GET | `/api/windmap` | Gridded wind map (params: `fl`, `tolerance`, `cell` km (default 50; the old `grid` in degrees is still accepted), `window` or `start`+`end`, `gnss_ok=1`): per cell `lat`, `lon`, `bounds`, `wind_dir`, `wind_spd`, `wind_sd`, `temp` (at the level), `dtemp`, `temp_sd`, `ac`, `obs`, `gnss_deg`, `dval` (D-value of the pressure surface, m) and `dval_ac`; plus `geo` (geostrophic wind of the area: `dir`, `spd`, `se_kt`, `meas_dir`, `meas_spd`, `ageo_dir`, `ageo_spd`, `grad_m_per_100km`, `aircraft`, `rms_m`, `centre_km`; null when too few points), `z_isa_m`, `gcal`, `alt_query_ft` (pressure altitude of the band centre), `aircraft`, `obs_used`, `removed` {frozen, jump, gnss}, `temp_layer`, `lapse_k_per_1000ft`, `qnh_hpa`, `qnh_source` |
| GET | `/api/windmap/frames` | All frames of the time slider in one request: `fl`, `tolerance`, `cell`, `gnss_ok=1` as `/api/windmap`, plus `end` (end of the newest frame), `period` (length in seconds, ≤ 86 400) and `n` (frames, ≤ 48; each an hour earlier than the previous) → `frames` = [answers as `/api/windmap`, newest first]. One database query; each frame is identical to the single answer for its period. Gzip-compressed when the browser accepts it |
| GET | `/api/windmap/xsection` | Vertical cross-section along a line: `lat1`, `lon1`, `lat2`, `lon2`, `start`, `end`, optional `width` (km, default 50), `step` (km, default 25), `gnss_ok=1` → `a`, `b`, `length_km`, `dir_deg`, `bins`, `step_km`, `width_km`, `layers`, `cells` = [[bin, alt_lo, temp, wind_dir, wind_spd, aircraft, dval], …], `aircraft`, `obs_used`, `removed` |
| GET | `/api/wx` | METAR and TAF for the configured airport, served from an in-memory cache populated by a background polling thread (10-minute interval, 3 retries per source); response includes `cache_age_s` (seconds since last successful fetch), `qnh_hpa`, `elev_ft` (airport elevation for the Live Map ground line) and `metar_wind` (`dir`, `spd`, `gust`, `variable`); returns `[unavailable]` for a source only if the server has never successfully fetched it |
| GET | `/api/windshear/state` | Snapshot of all currently tracked approach aircraft (RAM-only, no DB) |
| GET | `/api/windshear/approach-history` | Landed approach history. Without params: in-RAM list (backward compat). `?window=<seconds>` (e.g. `?window=10800`): DB query for rolling time window. `?date=YYYY-MM-DD`: DB query for a specific UTC calendar day (`WHERE date_utc = ?`); returns HTTP 400 on malformed date. `window` takes precedence over `date` if both supplied. Each entry: `ts`, `time_utc`, `icao`, `callsign`, `registration`, `aircraft_type`, `runway`, `rwy_heading`, `bands` (dict keyed by altitude ft), `go_arounds` (integer, number of go-arounds before final landing; 0 for normal approaches), `gnss` (GNSS quality during the approach, see `gnss_json` under [Database](#database); `null` when not captured), `rough` (approach roughness + METAR wind, see `rough_json`; `null` when not captured), `cond` (provisional approach-conditions index computed from `rough`: `idx` 0–10, `lvl` 0–4, `lbl`, aircraft class `cls`, `raw` before the class factor, per-segment `hi` / `lo` scores and component values, `metar` wind string; `null` when not enough data) |
| POST | `/api/windshear/approach-history/clear` | Delete all rows from the `approach_history` DB table and clear the RAM list (administrative use; no UI button exposes this) |
| GET | `/api/windshear/windrose-obs` | Rolling 6-hour buffer of low-altitude wind observations (alt ≤ 2 000 ft, non-NONE, in-corridor) harvested from recently landed aircraft; used by the browser on page load and re-fetched every 60 s to keep the Windrose and Hist trend feature current mid-session; each entry: `ts`, `dir`, `spd`, `alt` |
| GET | `/api/gps/state` | GPS quality monitor state: live degraded aircraft, time series (up to 6 months), FL heatmap (up to 31 days), `band_days` (per UTC day and FL band: aircraft-hours seen `ac` / degraded `deg` and signal events `sig`, from `band_detail`; for the heatmap's % aircraft mode and hover text; `sev` = severe aircraft-hours), FL band summary stats (incl. `severe_24h`); optional `?zone=50nm` or `?zone=20nm` filters data to aircraft within that radius from the airport (default `all`); completed hours persisted in `gps_quality_hours` and `gps_quality_zone_hours` and reloaded on restart |
| GET | `/api/gps/detail` | 10-minute slots, severity split and spoofing indicators for the GPS Quality page: `?zone=all\|50nm\|20nm`, `?hours=N` (1 – 744, default 24). Response `{slots: [[slot_ts, ac, deg, sev, spf, mac, mdeg], …], hours: [[hour_ts, aircraft, degraded, severe, spoof-flagged], …], severity: {degraded_ach, severe_ach, sweeps}, spoof: {kinds: {kind: {aircraft, sweeps, ok_aircraft, ok_sweeps}}, cmp, gmb_n, flagged, flagged_total}, since, thresholds}`. Completed hours are read from the database once per hour and cached; the hour in progress comes from RAM |
| GET | `/api/gps/episodes` | GPS degradation episodes from `gps_episodes`, newest first (max 5 000): `?window=<seconds>` (default 86 400, max 31 days) or `?date=YYYY-MM-DD` (episodes starting that UTC day; HTTP 400 on a malformed date). Response `{episodes, radius_nm, edge_nm, t0, t1}`; each episode has all table columns plus `end_class` (`end_reason`, with `lost` at ≥ `GPS_EPISODE_EDGE_NM` reported as `edge`) and `start_edge` (started within 3 NM of the episode radius) |
| GET | `/gps-episodes` | GPS Episodes page (HTML) |
| GET | `/overlays/<filename>` | Serves GeoJSON overlay files from the project-level `overlays/` directory |
| GET | `/maintenance` | Maintenance page (HTML) — requires separate maintenance credentials for all operations |
| POST | `/api/maintenance/stats` | Database statistics: row counts, date ranges, file size for all tables |
| POST | `/api/maintenance/flight/preview` | Preview flight/observation rows that would be deleted for a given day threshold |
| POST | `/api/maintenance/flight/purge` | Delete observations and flights older than N days; approach history untouched |
| POST | `/api/maintenance/flight/autopurge` | Save autopurge settings (enabled, days threshold) to `maintenance_config` |
| POST | `/api/maintenance/flight/autopurge-config` | Read current autopurge settings |
| POST | `/api/maintenance/gps/preview` | Preview GPS quality rows that would be deleted for a given day threshold |
| POST | `/api/maintenance/gps/purge` | Delete GPS quality hourly rows older than N days; reloads in-RAM cache after deletion |
| POST | `/api/maintenance/flight/date-preview` | Preview flight/observation rows within a date range; params: `date_from`, `date_to` (`YYYY-MM-DD`) |
| POST | `/api/maintenance/flight/date-purge` | Delete observations and flights within a date range |
| POST | `/api/maintenance/gps/date-preview` | Preview GPS quality rows within a date range |
| POST | `/api/maintenance/gps/date-purge` | Delete GPS quality hourly rows within a date range; reloads in-RAM cache after deletion |
| POST | `/api/maintenance/approach/preview` | Preview approach_history rows older than N days; params: `days` |
| POST | `/api/maintenance/approach/purge` | Delete approach_history rows older than N days; clears in-RAM list |
| POST | `/api/maintenance/approach/date-preview` | Preview approach_history rows within a date range; params: `date_from`, `date_to` (`YYYY-MM-DD`) |
| POST | `/api/maintenance/approach/date-purge` | Delete approach_history rows within a date range; clears in-RAM list |
| POST | `/api/maintenance/episodes/preview` | Preview gps_episodes rows older than N days; params: `days` |
| POST | `/api/maintenance/episodes/purge` | Delete gps_episodes rows older than N days |
| POST | `/api/maintenance/episodes/date-preview` | Preview gps_episodes rows starting within a date range; params: `date_from`, `date_to` (`YYYY-MM-DD`) |
| POST | `/api/maintenance/episodes/date-purge` | Delete gps_episodes rows starting within a date range |

All `/api/maintenance/*` endpoints require `username` and `password` fields in the JSON request body, validated against the `MAINTENANCE_AUTH_FILE` credential file.

---

## Acknowledgements

- **[pyModeS](https://github.com/junzis/pyModeS)** by Junzi Sun — the foundational MODE-S / ADS-B decoding library this project is built on
- **[Leaflet](https://leafletjs.com/)** — interactive maps
- **[Chart.js](https://www.chartjs.org/)** — time-series charts
- **[CARTO](https://carto.com/)** — basemap tiles (dark / light / no-labels)
- **[pygeomag](https://github.com/boxpet/pygeomag)** and the **World Magnetic Model (WMM2025, NOAA NCEI / BGS)** — position-based magnetic declination
- **[Jetvision Radarcape](http://jetvision.de/)** — hardware receiver providing Beast binary output and MLAT positions

---

## Changelog

A detailed record of all changes, fixes and new features is maintained in [CHANGELOG.md](CHANGELOG.md).

---

## Contributing

This project is developed and maintained by **Otso Laakso / OH2GAX**. In active development. Feedback, observations and bug reports — especially from UI testing and real-world operational use — are welcome. If you encounter unexpected behaviour, display glitches, or data quality issues, please describe the conditions (runway in use, weather, time UTC) so they can be reproduced against the live feed.

This is a personal research tool built around a specific hardware setup at EFHK. Well-described issue reports and suggestions for improvement are appreciated.

---

## License

This project is licensed under the **GNU General Public License v3.0**. You are free to use, study, modify and distribute this software under the terms of the GPLv3. Any derivative work must also be distributed under the same license.

See the [LICENSE](LICENSE) file for the full license text, or visit [https://www.gnu.org/licenses/gpl-3.0.html](https://www.gnu.org/licenses/gpl-3.0.html).

The project uses several open-source libraries (pyModeS, Leaflet, Chart.js, pygeomag) which retain their own respective licenses — see the Acknowledgements section.