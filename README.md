# MODE-S Wind

A Python-based system for collecting, decoding and visualising real-time meteorological data from aircraft using **MODE-S Enhanced Surveillance (EHS)** and **ADS-B** messages received by a [Jetvision Radarcape](https://www.jetvision.de/radarcape/) receiver.

Two complementary methods are used to extract meteorological data from aircraft transponder traffic. The primary method is direct decoding of **BDS 4,4 Meteorological Routine Air Report (MRAR)** messages, which carry onboard sensor readings for wind speed, wind direction, static air temperature, and humidity — but MRAR is optional equipment and relatively few aircraft in commercial service transmit it. The majority of observations are therefore derived indirectly from **MODE-S Enhanced Surveillance (EHS)** data: wind speed and direction are computed from the combination of Indicated Airspeed (BDS 6,0), Mach number (BDS 5,0), true heading (BDS 5,0), and ADS-B groundspeed and track angle; static air temperature is computed from Mach number and the standard atmosphere model. These EHS-derived values are physically equivalent to sensor readings but are calculated rather than measured directly. The system handles both methods transparently, preferring direct MRAR data when available and falling back to EHS computation otherwise.

All decoded observations are stored in a local SQLite database and presented through a web dashboard with a live map, historical flight browser, Skew-T atmospheric sounding diagrams, and a gridded historical wind map.

> **⚠ Note for test users:** Due to heavy GPS jamming originating from the east, GPS-derived positions between approximately 3 000 ft and 1 000 ft are currently intermittently unreliable. Approaches to RWY 04L and 04R are particularly affected. Position data at these altitudes should be interpreted with caution.
>
> The current situation has worsened significantly since the beginning of May 2026. Previously, jamming was mostly limited to higher altitudes (8 000 – 10 000 ft) with little practical impact on approach traffic. The jamming is now effective down to much lower altitudes, directly affecting final approach segments.

![MODE-S Wind main screen](Mode_S_Wind_Main_Screen_1.png)

> **Display note:** the web interface is optimised for **1920 × 1080** desktop resolution. On mobile phones the layout will adapt but the experience is limited. On tablets, horizontal (landscape) orientation gives significantly better results — an iPad in landscape mode works reasonably well.

---

## Features

- **Real-time live map** — ATC-style aircraft display with 1-minute position trails, colour-coded by meteo data source, with optional callsign or ICAO24 labels
- **Three meteo data sources** decoded simultaneously:
  - BDS 4,4 MRAR — Meteorological Routine Air Report (direct temp, pressure, humidity, wind, turbulence from aircraft avionics)
  - BDS 4,5 MHR — Meteorological Hazard Report (icing, wind shear, microburst, turbulence levels)
  - BDS 5,0 + 6,0 computed wind — wind vector derived from true track, ground speed, magnetic heading and airspeed
- **MLAT position support** — polls the Radarcape's JSON feed for multilateration-derived positions that remain accurate even when GPS jamming suppresses ADS-B position broadcasts
- **Skew-T atmospheric soundings** — per-flight vertical profiles for climbing/descending flights, accessible from the Sounding page or directly from the Flights browser
- **Mini atmosphere profile panel** — always-visible Skew-T profile in the live map sidebar; clicking any aircraft immediately loads its full historical wind and temperature profile from the database, then continues accumulating live updates on top. Profile persists across page navigation — navigating away and back restores the full picture instantly.
- **Historical flight browser** — searchable and paginated table of all recorded flights with meteo statistics, time-series charts, and a flight track map
- **Light / Dark theme toggle** — a **Dark / Light** button in the navbar switches all pages between the default dark theme and a blue-grey paper-toned light theme; preference is stored in `localStorage` and applied before first paint so there is no flash on page load; all canvas renderers (Skew-T diagrams, ILS profile, Wind Rose) redraw instantly with the new palette
- **Persistent UI preferences** — all toggles (Meteo only, Labels, label mode, wind history density, theme) are remembered across browser sessions via localStorage
- **Configurable meteo source mode** — choose between EHS-only (pyModeS Beast decoding), JSON-only (Radarcape's own decoded values), or Hybrid priority; active mode shown as a read-only badge in the navbar on every page
- **Configurable storage mode** — store all observations or meteo-only to drastically reduce database size and SD-card write load; active mode shown in the navbar badge alongside source mode
- **Per-aircraft write throttle** — configurable minimum interval between successive database writes for the same aircraft, dramatically reducing write volume without meaningfully affecting sounding data quality
- **Gridded historical wind map** — select a flight level, altitude tolerance, time window (preset or custom historical range) and grid resolution; U/V-averaged wind barbs are plotted on a Leaflet map at each populated grid cell, colour-coded by wind speed
- **QNH pressure-altitude correction** — for wind map layers below FL050, the query band is automatically shifted into pressure-altitude space using the latest METAR QNH so that observations are binned to the correct MSL altitude. Raw pressure altitudes are kept intact in the database; correction is applied at query time only
- **Windshear approach monitoring page** — ATC-style real-time display of all aircraft established on ILS or RNP approach (RWY 04L, 04R, 22L, 22R, 15, 33), with flight strips, an ILS/RNP glideslope vertical profile canvas, and an optional windshear detection algorithm; see [Windshear](#windshear--windshear) below
- **GPS Quality monitoring page** — area-wide real-time and historical GPS degradation monitor covering all tracked aircraft at all altitudes; detects NACp degradation, position freeze, and position gap events; renders a 24-hour stacked bar chart (NACp / Freeze / Gap signal breakdown per hour), a 14-day × 8 FL-band heatmap, a FL band distribution doughnut chart, a 14-day summary stats panel, and a **distance zone selector** (All / 50 nm / 20 nm) that filters all views to aircraft within a chosen radius from the airport; see [GPS Quality](#gps-quality--gps) below
- **Maintenance page** — administrator tool for database housekeeping accessible at `/maintenance`; protected by a separate credential file independent of the main web auth; provides manual and scheduled purge of flight/meteo data with approach history always preserved; see [Maintenance](#maintenance--maintenance) below
- **ICAO24 blocklist** — a configurable prefix list (`BLOCKED_ICAO_PREFIXES`) silently drops non-aircraft Mode-S emitters system-wide at both the Beast TCP and JSON/MLAT live\_state entry points; default entry `T40` filters Finnish Air Navigation Services WAM ground interrogator stations that would otherwise inflate GPS quality counts and traffic statistics
- **Registration blocklist** — a complementary prefix list (`BLOCKED_REG_PREFIXES`) silently drops aircraft by registration system-wide; default entry `OH-H` filters Finnish helicopters whose continuous manoeuvring near EFHK produces unreliable computed wind and should not feed any meteo analysis
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
                             ┌────────────────┼──────────────────┐
                             │                │                  │
                       database/       windshear sweep     gps sweep      web/app.py
                       writer thread   daemon (3 s)         daemon (5 s)   Flask + SSE
                       (SQLite WAL)         │                    │          │
                             │       WindshearTracker    GpsQualityTracker  ├─ /           Live map
                             │       (RAM only, no DB)   (RAM+DB persist)   ├─ /flights    History
                             │                                              ├─ /sounding   Skew-T
                       data/modes_meteo.db                                  ├─ /windmap    Wind map
                                                                            ├─ /windshear  Approach
                                                                            └─ /gps        GPS Quality
```

### Data source priority

When multiple sources are available for the same observation the `best_*` consolidated fields are populated in this order of preference:

1. **MRAR** (BDS 4,4) — highest quality, direct avionics measurement with Figure of Merit
2. **MHR** (BDS 4,5) — secondary hazard report
3. **COMPUTED** — wind vector calculated from BDS 5,0 + 6,0 pair
4. **JSON** — temperature or wind injected from Radarcape's JSON feed

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/oh2gax/mode_s_wind.git
cd mode_s_wind
```

### 2. Install Python dependencies

Python 3.10 or newer is required.

```bash
pip3 install flask pyModeS requests --break-system-packages
```

Or inside a virtual environment:

```bash
python3 -m venv venv
source venv/bin/activate
pip install flask pyModeS requests
```

> **Note:** The `pyModeS-main` folder in the repository is a reference copy of the pyModeS library by Junzi Sun. If you install `pyModeS` via pip you do not need to use this folder.

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

    # ── ICAO24 blocklist ──────────────────────────────────────────────────
    BLOCKED_ICAO_PREFIXES = ("T40",)   # Finnish WAM ground interrogators — not aircraft
    BLOCKED_REG_PREFIXES  = ("OH-H",)  # Finnish helicopters — unreliable meteo, exclude everywhere

    # ── Receiver location ─────────────────────────────────────────────────
    RECEIVER_LAT = 60.317              # decimal degrees N
    RECEIVER_LON = 24.963             # decimal degrees E

    # ── Magnetic declination ──────────────────────────────────────────────
    MAG_DECLINATION = 8.0             # degrees E (Finland 2025–2026 ≈ +8°)

    # ── Radarcape JSON / MLAT feed ────────────────────────────────────────
    RADARCAPE_JSON_URL = "http://192.168.0.119/aircraftlist.json"
    RADARCAPE_JSON_INTERVAL = 5.0     # poll interval in seconds

    # ── Sounding aggregation ──────────────────────────────────────────────
    SOUNDING_RADIUS_KM = 150.0        # aggregate obs within this radius
    SOUNDING_WINDOW_MIN = 60          # aggregate over this many past minutes

    # ── Meteo source mode ─────────────────────────────────────────────────
    METEO_SOURCE_MODE = "HYBRID"      # "EHS" | "JSON" | "HYBRID"

    # ── Storage mode ──────────────────────────────────────────────────────
    STORAGE_MODE = "ALL"              # "ALL" | "METEO_ONLY"

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

    # ── GPS Quality monitoring ────────────────────────────────────────────
    GPS_NACP_THRESHOLD = 6       # NACp ≤ this value is flagged as degraded
    GPS_FREEZE_POLLS   = 3       # consecutive same-position polls to flag freeze
    GPS_GAP_SEC        = 45.0    # seconds without position (EHS still active) → gap
    GPS_MIN_GS_KT      = 50.0    # minimum groundspeed for freeze detection
    GPS_SWEEP_SEC      = 5.0     # sweep interval for GPS quality thread
```

Key values to change for your installation:

- `RADARCAPE_HOST` — IP address of your Radarcape on the local network
- `RECEIVER_LAT` / `RECEIVER_LON` — your receiver's location (used for CPR position decoding and sounding radius)
- `MAG_DECLINATION` — magnetic declination for your location (affects computed wind accuracy); find your value at [NOAA magnetic declination calculator](https://www.ngdc.noaa.gov/geomag/calculators/magcalc.shtml)
- `AIRPORT_ICAO` — ICAO code of your nearest airport (used for METAR/TAF display on the Live Map bottom strip and as the QNH source for Wind Map low-altitude corrections)
- `WEB_USER` / `WEB_PASS` — credentials for the web interface
- `METEO_SOURCE_MODE`, `STORAGE_MODE`, and `WRITE_MIN_INTERVAL_SEC` — see the [Operational Modes](#operational-modes) section below
- `WINDSHEAR_AIRPORT_LAT` / `WINDSHEAR_AIRPORT_LON` — reference point for the 15 NM outer tracking circle on the Windshear page (set to your monitoring airport coordinates)
- `WINDSHEAR_THR_ELEVATION_FT` — runway threshold elevation above MSL in feet; used to anchor the 3° glideslope correctly on the ILS vertical profile (EFHK = 179 ft)
- `WINDSHEAR_GS_OFFSET_FT` — manual calibration trim for the glideslope line; adjust if aircraft you know to be on glideslope still appear consistently high or low after the threshold and QNH corrections are applied
- `WINDSHEAR_MAX_TRACK_DEV_DEG` — maximum allowed deviation in degrees between an aircraft's ADS-B ground track and the runway's approach heading; the default of 60° rejects departures on parallel runways (which fly ~180° off the approach heading) while accepting all legitimate approach aircraft including those still rolling out of a late vector intercept

### 4. Run

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
2025-05-11 12:00:00  INFO     modes.main             Storage mode: ALL
```

Open `http://<raspberry-pi-ip>:5010` in a browser. You will be prompted for username and password.

### 5. Running in the background (optional)

```bash
nohup python3 run.py > logs/modes_wind.log 2>&1 &
echo $! > run.pid          # save PID to stop later
```

To stop:

```bash
kill $(cat run.pid)
```

### 6. Run as a systemd service (recommended for permanent deployment)

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

**Note:** In `METEO_ONLY` mode the `flights` table still records every flight session, but individual `observations` rows exist only for moments when meteo data was present. Flight track maps in the Flights browser will show only the positions where meteo was decoded rather than the full continuous path.

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

**Tuning guide:**

- Start with `30.0` and monitor database growth over a few hours of peak traffic.
- If growth is still too fast, increase to `60.0`.
- If you need finer vertical resolution in sounding profiles (e.g. studying temperature inversions in thin layers), reduce toward `10.0`–`15.0`.
- Set to `0` temporarily if you want to capture a specific event at full resolution, then restore your normal value.

---

## Web Interface

### Status indicator

The top navigation bar always shows the connection status:

- 🟢 **Live** — SSE stream active (Live page only)
- 🟢 **Online** — web API responding (Flights and Sounding pages)
- 🔴 **Reconnecting…** — connection lost, retrying automatically

The navbar also shows live aircraft counts: total aircraft visible and how many are currently providing meteo data, two read-only configuration badges (meteo source mode and storage mode), a **live UTC clock** displaying the current date and time in `YYYY-MM-DD HH:MM:SS UTC` format (updated every second), and the **Dark / Light** theme toggle button which applies to all pages.

---

### Live Map  `/`

The main dashboard showing all currently tracked aircraft in real time, updated every 3 seconds via Server-Sent Events.

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
| 🟣 Purple | JSON | Temperature/wind from Radarcape JSON feed (MLAT source) |
| ⚫ Grey | NONE | Aircraft visible but no meteo data decoded yet |

#### Trail dots

Each aircraft leaves a trail of fading dots showing its position over the past ~60 seconds. Older positions are more transparent; the trail gives an immediate sense of direction and speed without cluttering the map.

#### Left panel — Aircraft list

Lists all currently visible aircraft sorted alphabetically. Shows callsign, ICAO24 code, altitude, ground speed, and the current wind/temperature reading if available. Click any row to select that aircraft and open the detail strip.

**Meteo only** checkbox — hides all aircraft that do not currently have any decoded meteo data. Defaults **on**; state persists across browser sessions.

#### Map labels

**Labels checkbox** — toggles callsign or ICAO24 labels next to each aircraft symbol on the map. Defaults **on**; state persists across browser sessions.

**Label mode selector** — choose between:
- **Callsign** — shows the flight's callsign (e.g. FIN3GJ). Once a callsign has been seen for an aircraft it is cached and will never revert to the ICAO24 code even if some subsequent messages do not include it.
- **ICAO24** — always shows the aircraft's ICAO 24-bit address (e.g. 461F52).

The selected label mode persists across browser sessions.

**Track checkbox** — when enabled, selecting an aircraft draws a dashed polyline on the map showing its recorded flight path, built from the latitude/longitude coordinates stored alongside each meteo observation in the database. The polyline is drawn in the aircraft's meteo-source colour and updates automatically each time the DB history is refreshed. The Track setting defaults **off** and persists across browser sessions via localStorage. The polyline is removed when the aircraft is deselected or the Track checkbox is turned off.

#### Bottom strip — METAR / TAF

The bottom of the live map always shows the current METAR and TAF for the configured airport (`AIRPORT_ICAO` in `config.py`, default EFHK). The data is fetched server-side from NOAA and refreshed automatically every 10 minutes. METAR and TAF are displayed side-by-side in a fixed-position panel anchored to the right; selecting an aircraft does not shift or disturb this panel.

#### Clicking an aircraft

Clicking an aircraft symbol or list entry:

1. **Enlarges the symbol** on the map for easy tracking
2. **Opens the aircraft detail panel** on the left side of the bottom strip showing all decoded values:
   - Altitude, ground speed, track, vertical rate (shown in **fpm**)
   - Wind speed and direction
   - Temperature, pressure, humidity
   - Turbulence level and Figure of Merit (FOM) if from MRAR
   - Meteo source badge
3. **Overlays the aircraft's full wind profile** on the Atmosphere Profile panel (right side) — see below

Click the **✕** button to deselect and close the aircraft detail panel. The METAR/TAF panel remains visible at all times.

#### Right panel — Atmosphere Profile

A permanently visible Skew-T Log-P diagram filling the full height of the right panel. The canvas automatically sizes itself to the available space when the page loads and reflows whenever the browser window is resized, giving maximum vertical resolution for the profile. The diagram uses a log-pressure Y axis and a skewed temperature X axis, with the ISA (International Standard Atmosphere) reference temperature shown as a dashed blue line.

**When no aircraft is selected** the diagram shows only the ISA reference grid and a "Click an aircraft to show profile" hint.

**When an aircraft is selected** the panel immediately loads the aircraft's full flight history from the database, then continues accumulating live updates:

- **Wind barbs** — drawn in the aircraft's colour for each stored altitude observation, labelled with direction and speed in the format **248° 24kt** (FROM direction, meteorological convention). Older history barbs are shown at 40% opacity.
- **Temperature dots** — plotted at the correct skewed-temperature position for each altitude observation.
- **Level indicator** — a dashed horizontal line showing the aircraft's current pressure level derived from barometric altitude via the ISA model. When temperature data is available a white-ringed coloured dot marks the point on the temperature curve; otherwise a small diamond appears on the pressure axis.

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

Skew-T style atmospheric sounding for individual flights. Observations from a single flight are binned into 2 000 ft altitude bands to build a vertical profile. This works best for climbing departures or descending arrivals where the aircraft samples many different altitude layers.

Select a flight from the dropdown (populated with all flights that have meteo data and an altitude range > 5 000 ft, most recent first), then click **Load Sounding**.

The flight info banner below the controls shows callsign, ICAO24, time range, altitude range, and observation count.

You can also reach a specific flight's sounding directly from the Flights page via the 🌡 Sounding button, which opens this page with that flight pre-selected.

#### Skew-T diagram

The diagram shows:

- **Red line** — temperature profile (°C)
- **Wind barbs** on the right axis — wind speed and direction at each level (full barb = 10 kt, half barb = 5 kt, pennant = 50 kt)
- Standard pressure levels labelled on the left axis

#### Level data table

The table on the right shows each pressure level with:

| Column | Description |
|--------|-------------|
| Press (hPa) | Pressure level |
| Alt (ft) | Mean altitude of observations at this level |
| Temp (°C) | Mean temperature |
| Wind (kt) | Mean wind speed |
| Dir (°) | Mean wind direction (FROM, meteorological convention) |
| Obs | Number of observations contributing to this level |

---

### Wind Map  `/windmap`

A gridded horizontal wind analysis map built from historical observations stored in the database. Wind vectors within each grid cell are averaged using proper U/V component decomposition — the same mathematically correct method used by the sounding aggregation — so directional accuracy is preserved when combining multiple observations.

#### Controls

| Control | Options | Description |
|---------|---------|-------------|
| FL | 1 000 ft – 4 000 ft, FL050 – FL450 | Centre altitude for the filter. Low-altitude options (1 000–4 000 ft) are displayed in feet and sit below the transition altitude; FL050 and above use standard flight-level notation |
| ± | 500 / 1 000 / 2 000 / 3 000 ft | Altitude band around the chosen level; observations within ± tolerance are included. For the 1 000 ft layer a ±500 ft tolerance is recommended to keep the band tight |
| Period | Last 1 h / 3 h / 6 h / 12 h / 24 h / Custom | Time window for the database query. **Custom** reveals date+time pickers for selecting any historical hour from the database |
| Grid | 0.25° / 0.5° / 1.0° | Grid cell size in decimal degrees. Finer grids place barbs more precisely along flight routes; coarser grids merge nearby observations and produce a cleaner overview |
| Load | — | Executes the query and renders the map |

The status bar below the controls shows the number of raw observations used, the resulting cell count, the exact UTC time period, and the active grid resolution. For low-altitude layers (below FL050) the status bar additionally shows the QNH value that was used and the resulting pressure-altitude correction — for example `· QNH 998.0 hPa (alt corr +410 ft)`.

#### Wind barbs

Each populated grid cell is represented by a standard meteorological wind barb placed at the cell centre:

- **Staff** — points FROM the direction the wind is coming from (meteorological convention)
- **Pennant** — filled triangle = 50 kt
- **Full barb** — line = 10 kt
- **Half barb** — short line = 5 kt
- **Calm** — open circle when averaged speed rounds to 0 kt

**Colour** indicates averaged wind speed: green < 15 kt, blue 15–30 kt, amber 30–50 kt, red > 50 kt.

The label below each barb shows direction, speed, temperature (if available), and observation count — for example `248° 45kt −35.1°C (12)`. Clicking a barb opens a popup with full cell details including exact grid coordinates. Hovering shows a compact tooltip.

#### Interpreting the map

Observations will be concentrated along the main flight routes visible from your receiver — typically approach/departure corridors and overfly routes. Areas with no aircraft traffic will have no barbs. A longer time window and wider altitude tolerance populate more cells but may mix observations from different weather systems; a shorter window gives a snapshot closer to current conditions.

For best results when studying a specific weather event, use the Custom period selector to load exactly the hour of interest from your historical database.

#### QNH correction for low-altitude layers

Aircraft transponders always broadcast pressure altitude referenced to the ICAO standard pressure of 1013.25 hPa, regardless of what QNH the pilot has set. Above the transition altitude (FL050 / 5 000 ft) this is correct by convention — pressure altitude IS the reference. Below FL050, however, the difference between pressure altitude and true MSL altitude can reach several hundred feet when QNH departs significantly from standard, which is common in Finnish winter conditions (QNH can be 980–990 hPa, causing 600–900 ft of offset).

When a low-altitude layer (1 000–4 000 ft) is selected, the system automatically shifts the database query window into pressure-altitude space using the correction:

```
pressure_alt = msl_alt + (1013.25 − qnh_hpa) × 27.3
```

For example, if QNH is 998 hPa, a request for the 2 000 ft layer queries the database for pressure altitudes between roughly 1 610 ft and 2 610 ft (with ±500 ft tolerance), which correspond to aircraft actually flying at 1 500–2 500 ft MSL. The displayed layer name always shows the MSL altitude you selected. The QNH is sourced from the cached METAR fetched by the server every 10 minutes via `/api/wx`; it falls back to 1013.25 hPa until the first METAR is available. Raw pressure altitudes are never modified in the database.

---

### Windshear  `/windshear`

A dedicated real-time approach monitoring page for tracking aircraft established on ILS final approach. All tracking data is held entirely in RAM — the Windshear page does not write to the database and has no dependency on historical stored data.

> **Keep the page open for best results.** All client-side history buffers — wind barb accumulation, kinematic IAS−GS differential history, the windshear event log, and the go-around log — exist only in the browser tab running the page. Navigating to another page or closing the tab clears these buffers entirely. When the Windshear page is reopened, it starts fresh: aircraft currently on approach will appear immediately, but any history built up during the previous session (wind profiles along the approach path, earlier windshear events, go-around events from before the page was opened) is gone. If you are monitoring an active approach sequence or want to study the windshear log over multiple arrival waves, keep the Windshear page as a dedicated open tab.

![MODE-S Wind Approach / Windshear screen](https://raw.githubusercontent.com/oh2gax/mode_s_wind/master/Mode_S_Wind_Approach_Screen_1.png)

#### Layout

The page is divided into seven main areas:

- **Left panel** — QNH display, approach traffic count summary, and ATC-style flight strips for all aircraft inside an ILS corridor. Strips extend the full height of the screen to maximise capacity during busy arrival sequences and are filtered to match the runway selected in the ILS profile dropdown.

- **Map (right top)** — Leaflet map showing all tracked aircraft with ATC-style callsign labels, ILS centreline overlays for all configured runways, and a 15 NM range circle centred on the airport. A map controls bar overlaid on the map provides: an aircraft count, an `ILS Only` filter that hides non-corridor traffic, four map theme buttons (`Dark` / `Grey` / `ATC` / `Black` — ATC and Black support overlay cycling through ILS-only, ILS+coastline, and ILS+coastline+water with repeated button presses), the `Windrose` toggle, and the `Apch Hist` toggle.

- **Wind Rose** — a compass rose panel overlaid on the top-right corner of the map, toggled by the `Windrose` button (enabled by default). Displays METAR surface wind as a cyan arrow and the MODE-S derived approach wind as a green arrow, both pointing in the downwind direction. The MODE-S wind is vector-averaged from low-altitude observations (≤ 2 000 ft) harvested from aircraft that have completed approaches in the last 30 minutes; observations recorded during grey (`meteo_source = NONE`) periods are excluded from the average, as are observations taken while a GPS position freeze is detected (same position-freeze gate as Approach History). Runway end labels are shown at the correct threshold positions. A numeric readout below the rose shows direction, speed, observation count, and age for each source.

- **Approach History** — a scrollable table panel overlaid on the top-left corner of the map, toggled by the `Apch Hist` button (hidden by default). Logs each completed landing approach with columns: UTC time, callsign, registration, aircraft type, runway, and wind at altitude bands. The server records all 15 bands at 200 ft resolution (200, 400, 600 … 3 000 ft, ±100 ft tolerance per band) and persists every approach to a SQLite `approach_history` table so data survives server restarts and accumulates over weeks. A **position-freeze gate** prevents GPS-jammed frozen-position sweeps from contaminating band data: if an aircraft's altitude drops more than 100 ft between sweeps but `dist_thr_nm` has not advanced by at least 0.05 NM, the position is considered frozen and no wind is written to any band for that sweep — the affected bands remain `—` rather than showing wind computed from a stale groundspeed vector; the tracker stays current through genuine `NONE` meteo gaps so it does not false-fire when EHS data recovers after a jamming window. The panel height scales dynamically with the map container so the full available screen height is used. A **time filter row** (1h · 3h · 6h · 12h · 1d, default 3h) selects the displayed window; the server queries the DB directly for the selected period. To the right of the time buttons, a **date picker** (`dd.mm.yyyy` text field + 📅 calendar button) switches the panel into *date mode*: all approaches for that full UTC day are fetched from the DB and the time-window buttons are dimmed; a **Live** button (always visible, highlighted in blue during live mode) exits date mode and resumes the rolling-window view. The `dd.mm.yyyy` text field accepts typed digits with auto-inserted dots and always displays in that format regardless of OS locale; the 📅 button opens the native calendar for mouse users. The UTC column shows plain `HH:MM` for today's approaches and `D.M HH:MM` (e.g. `26.5 14:32`) for entries from a previous date, keeping multi-day views unambiguous. All interactive controls sit on a single control row below the title. A **Lo / Hi** button selects the column count: Lo shows 8 columns (600 / 800 / 1 000 / 1 400 / 1 800 / 2 200 / 2 600 / 3 000 ft) for a compact overview; Hi shows 13 columns (600–3 000 ft at 200 ft steps) and the panel expands to fit them all without scrolling. The server captures all 15 bands down to 200 ft in the DB; the 200 and 400 ft display columns are simply not shown as no data is currently received at those altitudes at EFHK. A **display mode dropdown** to the right of the Live button selects what is shown in the altitude columns:

- **Wind** — raw wind as `dir°/spd kt` (e.g. `310°/17`)
- **HW** — headwind component in knots, sign indicates direction: `+12` = headwind (into the aircraft), `−5` = tailwind; colour-coded green (headwind) / red (tailwind) / amber (near-zero). Default mode.
- **XW** — crosswind component in knots with a directional arrow: `←17` means 17 kt crosswind **from the left** of the aircraft on approach; `→8` means 8 kt crosswind **from the right**. The arrow indicates the **source side** of the wind — where the wind is coming from — not the direction it blows across the runway. A left crosswind (`←`) pushes the aircraft to the right, requiring a left crab correction to maintain centreline. Colour-coded green (< 5 kt) / amber (5–9 kt) / red (≥ 10 kt).
- **HW+XW** — both components in a two-line cell: headwind on top, crosswind below, separated by a hairline rule; each value is independently colour-coded.

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
|cross-track offset| ≤ WINDSHEAR_CORRIDOR_HALF_WIDTH_NM       (default 2.5 NM)
0 ≤ along-track distance ≤ WINDSHEAR_MAX_ILS_NM                (default 25 NM)
|track − approach_heading| ≤ max_track_dev                     (default 60°, RWY 33: 45°, when track available)
altitude ≥ (thr_elevation + dist_thr × GS_FT_PER_NM) − 1 000 ft   (glideslope floor)
```

The along-track gate excludes aircraft that have already passed through the threshold (negative along-track), such as aircraft that have landed and are rolling out. The track heading gate is the primary defence against **parallel-runway departures**: at EFHK, the two parallel runway pairs (04L/22R and 04R/22L) are only about 0.9 NM apart — well within the cross-track corridor — so a departure on 22L flying ~220° would otherwise pass the geometric gates for the 04L corridor (approaching its threshold from the north). The 60° track tolerance rejects it immediately since 220° is ~173° from the 04L approach heading of 047°. The same logic applies to all configured runways automatically.

**RWY 33 uses a tighter 45° heading gate** (vs the default 60°) because it is an RNP approach with no ILS localizer, making it more vulnerable to false detections from traffic vectored to RWY 22L/22R from the south. Such aircraft typically fly northward headings of ~010°–020° (47°–57° from RWY 33's 323° heading), which pass the 60° gate but are rejected by the 45° gate. The per-runway gate is set via a `max_track_dev` field in the runway definition; runways without this field use the global default.

**The glideslope floor** rejects any corridor match where the aircraft is more than 1 000 ft below the theoretical 3° glidepath at its current distance from the threshold. This is the primary filter for traffic overflying the RWY 33 approach area at 12–15 NM while being vectored to other runways: at those distances such traffic is typically 1 000–2 500 ft below the glidepath. Legitimate approach aircraft always clear this gate — even an aircraft 800 ft low of the glidepath has a 200 ft margin. The floor applies to all runways but has no practical effect on the five ILS runways under normal operations.

The track check is skipped when track data is not available for an aircraft (rare at low altitude); those aircraft fall back to geometry-only and floor-only matching.

For airports with parallel runways (EFHK has 04L/04R and 22L/22R), the correct runway is identified by the sign of the cross-track offset: positive → right-hand runway (04R, 22R), negative → left-hand runway (04L, 22L).

**Entry state gate** — an additional filter rejects departing aircraft that briefly pass all the geometric gates near the threshold. Any aircraft that enters the tracker for the first time while climbing faster than +200 fpm is silently discarded. Existing tracked aircraft are fully exempt from this check: a go-around aircraft begins climbing while already present in the tracker, so the gate never interferes with legitimate missed-approach detection.

Aircraft that are within the outer radius and altitude limits but outside any ILS corridor remain visible on the map (shown dimmed) but do not appear in the flight strips.

#### Flight strips

Each aircraft inside an ILS corridor gets an ATC-style flight strip in the left panel, sorted by distance from threshold (closest first). The runway selector above the ILS profile canvas also filters the strips — selecting RWY 04L shows only 04L strips; selecting 04L & 04R shows both parallel approaches simultaneously.

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
- **Labels** — callsign and current deviation from glideslope in feet (e.g. `FIN3GJ (+85ft)`)
- **Windshear zones** — amber/red horizontal bands between the altitudes of the two aircraft involved in a detected shear event (visible when detection is enabled)

The glideslope line accounts for two corrections applied at render time so that aircraft on the correct slope land exactly on the line:

1. **Threshold elevation** — the glideslope starts at the runway threshold altitude above MSL (configurable via `WINDSHEAR_THR_ELEVATION_FT`; EFHK ≈ 179 ft), not at sea level
2. **QNH correction** — MODE-S transponders always broadcast pressure altitude (1013.25 hPa reference). The glideslope reference is shifted by `(1013.25 − QNH) × 27 ft` to convert between pressure altitude and geometric altitude. At a QNH of 1000 hPa, this correction is approximately +357 ft. The current QNH is sourced from the live METAR and applied automatically; when QNH changes (polled every 10 minutes) the canvas redraws immediately.

The small annotation at the top-right of the canvas shows the active corrections so you can verify they are being applied — for example: `GS ref: thr+179ft  QNH+223ft  trim+0ft`.

A **manual trim** (`WINDSHEAR_GS_OFFSET_FT`) is also available for residual calibration errors such as slightly inaccurate threshold coordinates. Positive values shift the line up; negative shift it down.

#### Runway selector

The dropdown above the ILS profile header lets you filter by runway. It acts simultaneously as both a profile filter (only the selected runway's aircraft are drawn on the canvas) and a strip filter (only matching strips appear in the left panel).

Available options: **All runways**, **04L & 04R** (both parallel approaches together), **22L & 22R**, and each runway individually (04L, 04R, 22L, 22R, 15). The paired options are useful during dual-runway operations at EFHK where both parallel runways are in use simultaneously.

#### Wind barb overlay

The **Barbs** button, located in the ILS profile header immediately to the right of the runway selector, enables a wind barb layer drawn directly on top of the ILS glideslope canvas. The feature is fully RAM-based — data accumulates while the page is open and is lost when you navigate away, consistent with the rest of the Windshear page.

**Enabling the layer:** click the Barbs button to toggle it on (it turns cyan). While active, the system quietly accumulates wind observations for every aircraft inside the ILS corridor in two independent parallel buffers — one at standard (Lo) resolution and one at high (Hi) resolution. Both buffers run continuously from the moment Barbs are enabled, regardless of which resolution is currently displayed.

**Selecting an aircraft manually:** with Barbs enabled, click any flight strip in the left panel. The selected strip gains a cyan left border and the ILS canvas immediately draws that aircraft's accumulated wind barb history on top of the glideslope profile. Each barb is drawn at the exact (distance from threshold, pressure altitude) position where it was recorded. A small `dir°/spdkt` label appears above each barb showing the decoded wind direction and speed, and the aircraft callsign with total observation count is shown in the top-left corner of the canvas. Clicking the same strip again deselects it and clears the overlay.

**Auto barb mode:** the `Auto` segment attached to the Barbs button enables fully automatic aircraft selection. When active, the system selects the aircraft that is furthest along the approach (smallest distance from threshold — i.e. closest to the runway) and holds that selection until the aircraft goes stale and is removed from the display. At that point the next lowest aircraft is selected automatically, ensuring barbs are always visible as long as there is any approach traffic. The canvas corner label shows `· AUTO` when automatic selection is driving the display. Clicking any flight strip while Auto is active cancels automatic selection and pins the manually chosen aircraft instead — the Auto button deactivates to reflect this. Clicking the Auto segment again while Barbs is already off will enable both Barbs and Auto in a single click.

**Barb convention:** barb staff points FROM the wind direction (standard meteorological convention). Pennant = 50 kt, full barb = 10 kt, half barb = 5 kt, open circle = calm. The barb colour matches the aircraft's meteo source colour (blue = MRAR, green = COMPUTED, purple = JSON).

**HW/TW annotation:** the **HW** button, immediately to the right of the `Barbs · Auto` split button, toggles a headwind/tailwind overlay on each barb. When active, two lines are shown at each barb point:

- **Primary** — the signed headwind component in knots: `+15kt` (headwind) or `−8kt` (tailwind), colour-coded **green** (headwind > +5 kt), **red** (tailwind < −5 kt), or **amber** (near-zero)
- **Secondary** — the raw `dir°/spd` in smaller, dimmer text for reference

The headwind component is computed as `wind_spd × cos(wind_dir − runway_heading)` using the matched runway's magnetic approach heading. The runway used as reference is shown in the corner label (e.g. `· HW ref 04L (47°)`). The HW button is greyed out when Barbs are off and is reset to inactive when Barbs are turned off.

**Dcl (declutter) label placement:** the `Dcl` button, immediately to the right of `HW`, is active only when HW annotation is on. When enabled, the two labels at each barb are split to opposite sides: the raw `dir°/spd` moves above the barb and the signed headwind value moves below it, using the barb staff itself as a visual separator. This significantly reduces label overlap when barbs are close together, particularly in Hi-resolution mode. Near the top of the canvas both labels stack below the barb (HW first); near the bottom both stack above. The corner label shows `· DCL` to confirm the mode. Turning HW off resets Dcl automatically.

**Trk (trail) toggle:** the `Trk` button, immediately to the right of `Dcl`, shows or hides the faint position history trail drawn on the ILS glideslope canvas for each corridor aircraft. The trail is enabled by default (button is teal/active). Clicking it hides all trails without affecting barbs, NONE circles, or position dots — only the connecting line segments are suppressed. This is useful when wind barbs are dense and the trail adds visual clutter rather than clarity. The preference is saved to `localStorage` and restored on the next page load. The `Trk` button is fully independent of barb mode and can be toggled at any time. Note that the trail automatically breaks (shows a visible gap) at any position outage longer than ~10 seconds — both GPS freeze events (position stuck while altitude descends) and complete ADS-B dropouts produce a blank segment in the trail rather than a straight connecting line.

**Hi-resolution mode:** the `Hi` segment sits inside the `Barbs · Hi · Auto` split button. Clicking it switches the canvas from the standard Lo buffer to the Hi buffer — a denser accumulation that stores a new observation whenever the aircraft has moved at least 150 ft in altitude or 0.2 NM along the track (versus 400 ft / 0.5 NM for Lo). The Hi buffer holds up to 100 observations per aircraft, enough to cover a full 15 NM approach at fine resolution. Because both buffers accumulate simultaneously, switching to Hi immediately shows the denser dataset already built up since the Barbs layer was enabled — there is no need to wait for a new approach. The Hi buffer is for research and visual inspection only; it is never used by any of the windshear detection algorithms, so enabling it has no effect on alert behaviour. The `Hi` button turns violet when active and the canvas corner label shows `· HI` to confirm the mode.

**Track lifetime:** only one aircraft's barbs are displayed at a time. Clicking a different flight strip immediately replaces the current overlay — no need to deselect first. When the selected aircraft lands and stops transmitting (typically 30–45 seconds after touchdown), its stored wind history is discarded and the overlay clears automatically. In Auto mode the next aircraft furthest along the approach is picked up on the same poll cycle, so the barb display stays continuous as long as there is approach traffic.

**NONE position markers:** in addition to coloured wind barbs, the canvas draws **small hollow circles** at every position where the selected aircraft's wind computation was suspended (`meteo_source === 'NONE'`). Circles are colour-coded by the reason for the suspension so the user can immediately distinguish normal maneuvering from a GPS problem:

- **Amber hollow circle (Turn)** — pyModeS quality rejection: the aircraft has a valid, actively updating GPS position but its bank angle or roll rate during a turn exceeded the library's quality threshold, so the wind computation was deliberately suppressed. Amber circles during localizer intercept or go-around turns are entirely expected and require no action.
- **Grey hollow circle (GPS)** — GPS-related suspension: either the position-freeze gate fired (`pos_frozen = True` — latitude/longitude is static while altitude descends, a GPS jamming signature), or no ADS-B position message is being received at all (GPS source dropped out). Grey circles on an established final approach are worth investigating.

Both corridor circle types persist alongside valid wind barbs once wind data recovers — they are not cleared when the aircraft transitions from NONE to valid meteo, so the full NONE history remains visible on the canvas for the duration of the approach. Circles are only removed after the aircraft has been absent from the feed for 45 seconds (matching the server stale-out), which means brief reception gaps caused by GPS jamming no longer wipe the accumulated circle history. The canvas hint text includes a `(N pos-only)` count when NONE positions are accumulating but no valid wind data has arrived yet. The ILS profile legend shows amber **Turn** and grey **GPS** ring symbols for reference. The absence of any circles (no hollow rings at all alongside a gap in barbs) indicates that ADS-B position messages themselves have stopped arriving — a genuine position outage rather than a wind computation hold.

- **Small dashed amber circle (Pre-ILS)** — pre-corridor quality rejection: the aircraft is not yet inside the ILS corridor (cross-track or track deviation outside the corridor gates) but is producing `qc`-reason NONE data — the characteristic signature of a wide localizer intercept turn. These circles use a smaller radius (2 px vs 3 px) and a dashed stroke to distinguish them from established-approach circles. They are drawn using the `dist_nearest_thr_nm` field (distance to the closest runway threshold) as the X-axis position, giving an accurate placement even outside the corridor. Only `qc` events are shown pre-corridor — GPS-related NONE events outside the corridor are not visualised as they would be ambiguous. This prevents the common misreading where a wide turning arc before final looks identical to a GPS jamming gap.

Enable the barb layer during an active approach sequence to study how the wind profile evolves along the final approach path and correlate it with the glideslope position and any detected windshear zones.

#### Wind Rose

The `Windrose` button in the map controls bar toggles a compass rose panel that overlays the top-right corner of the Leaflet map. It is enabled by default. The rose compares two wind sources side by side:

**METAR surface wind (cyan arrow)** is parsed directly from the METAR string returned by `/api/wx` and is available immediately on page load, refreshed every 10 minutes alongside the METAR text. A variable-direction wind (VRB) is shown as a dotted cyan ring at the reported speed radius rather than a directional arrow.

**MODE-S approach wind (green arrow)** is derived from aircraft that have recently completed approaches. When a tracked aircraft disappears from the display (landed and gone stale after 30–45 s), the system automatically harvests any wind observations that were recorded below 2 000 ft and adds them to a 30-minute rolling buffer. The green arrow is the vector average of all observations currently in that buffer. Vector averaging (U/V decomposition) is used throughout so that direction wraparound near 360°/0° is handled correctly. The text readout below the compass shows the averaged direction and speed, total observation count, and how many minutes ago the most recent observation was recorded. The arrow and readout remain hidden until the first low-altitude observation has been collected.

The server maintains its own parallel rolling buffer (`_windrose_buffer`) using identical gate thresholds (400 ft / 0.5 NM minimum gap, 40 obs per aircraft, alt ≤ 2 000 ft, non-NONE meteo only). The buffer is retained for **6 hours** so that the Hist trend feature (see below) can populate all hourly buckets for a fresh browser session. When the page is first loaded, `fetchWindroseObs()` pre-populates the client-side buffer with observations from the last 6 hours; the 30-minute window is only used for the main MODE-S averaged arrow, not for storage. The server buffer is re-fetched every **60 seconds** in the background so that aircraft landing mid-session are reflected in the Windrose within one minute; a seen-timestamp set prevents duplicate entries if the same observation appears in two consecutive fetches. Opening the Windrose panel (toggle ON) also triggers an immediate re-fetch so the panel always shows the freshest available data.

**Hist trend button** — a small **Hist** button below the canvas cycles through Off → 3h → 6h mode. When active, a colored dot is drawn on the compass ring perimeter at the bearing of each past hour's vector-averaged wind direction. Dot radius scales lightly with wind speed (3.5–7 px) so a calm bucket looks different from a strong one. Consecutive dots that have data are joined by a faint connecting line showing the direction drift path over time. Each hour bucket uses a distinct color: 0–1h amber, 1–2h orange, 2–3h rose, 3–4h purple, 4–5h violet, 5–6h slate. The dots are drawn on the compass ring perimeter and never overlap the center area where the METAR and MODE-S arrows are drawn, so live data remains fully readable with Hist active. An active range badge (e.g. `3h`) appears next to the button, and the text readout below the canvas gains per-bucket direction/speed lines (e.g. `● 0–1h 270°/12kt`) for buckets that have observations; hours with no data are silently omitted.

The EFHK runway geometry is drawn on the compass as two plain crossing dashed lines: the 047°/227° line covers all four 04/22 runways (they share the same magnetic heading), and the 152°/332° line covers RWY 15/33. Each end is labelled with the runway designator whose approach flies toward that compass direction — so the 047° (NE) end is labelled **22** and the 227° (SW) end is labelled **04**, because an aircraft landing on RWY 22 flies toward SW and its headwind comes from the NE. Speed-reference rings at 10, 20, and 30 kt are drawn inside the compass to give a visual sense of arrow scale; the full ring radius corresponds to 40 kt.

**Arrow convention:** both arrows point in the **downwind direction** — where the wind is blowing toward, not where it is coming from. This means the arrowhead always points toward the runway label that has a headwind. For example, wind from 050° produces an arrow pointing toward the SW/`04` end, instantly showing that RWY 04 approaches have the headwind. When both METAR and MODE-S arrows align with the same runway end, conditions are consistent; a divergence between the two arrows is a prompt to investigate further.

**Canvas timestamps** — the top-right corner of the compass canvas shows a UTC HH:MM timestamp alongside each source label: the cyan time is the METAR **issue time** parsed from the `DDHHMM Z` group in the raw METAR string (e.g. `281550Z` → `15:50`), and the green time is the timestamp of the **most recent MODE-S observation** currently in the 30-minute rolling buffer. Both use the same font and colour as the left-side dot labels. `--:--` is shown when no data is available for that source.

**METAR staleness colouring** — the METAR text in the weather strip below the map changes colour when the observation is getting old: **orange** at ≥ 60 minutes, **red** at ≥ 90 minutes, normal colour when fresh. Age is measured from the METAR issue time (same timestamp shown in the canvas corner), not from the browser's last fetch. The colour is re-evaluated every minute independently of the 10-minute fetch cycle so the transition happens on time.

The rose is intended to let you quickly judge whether the MODE-S wind profile measured during recent approaches matches the METAR surface observation — a useful sanity check for windshear monitoring and EHS data quality assessment.

#### Windshear Alert + Today's Statistics

The bottom-right area is split into two panels side by side (55 % / 45 %).

**Left — Windshear Alert log:** maintains a compact timestamped log of all detected windshear events and go-around detections during the current session, newest first. Each entry is a single line showing time, algorithm badge, runway, magnitude, and callsign(s). Hovering over an entry shows a full tooltip with algorithm, altitude band, individual headwind components, and exact timestamp. Events are deduplicated per algorithm, runway, and aircraft within a 60-second window. The log is cleared by the **Clear** button or on page refresh and does not persist to the database.

**Right — Today's Statistics:** shows two sections with a **Live / Yest / 1w** time range selector at the top. **Live** shows today's UTC data, **Yest** shows the previous UTC day, and **1w** aggregates the last 7 days. Both sections are refreshed every 5 minutes and also update immediately on range switch; the selected range persists across sessions. A 📅 **calendar button** placed after `1w` opens the native browser date picker — selecting any date switches both sections to show historical data for that specific UTC day. When a date is active, a compact blue badge showing the formatted date (e.g. `04 Jun 2026`) appears in the timerow with an inline `×` clear button; clicking `×` returns to the previously active Live/Yest/1w range. Clicking any range button also clears the date selection. Date mode is not persisted across sessions — the panel always opens on the last-used range. **Runway Usage** lists each runway with a percentage bar; the section label shows the total landing count for the selected range (e.g. "Total: 89"); tall enough to show all active runways without scrolling in most configurations, with a scrollbar available when all directions are in use. **Aircraft Types** shows all distinct aircraft types sorted by approach count with percentage bars and a vertical scrollbar; the label shows the number of distinct types (e.g. "Total types: 23"); aircraft with no decoded type code are labelled `NIL`. Hovering over any row shows the exact count for that runway or type.

#### Go-around detector

The tracker continuously monitors each approach aircraft for a go-around (missed approach) using a server-side state machine. Detection requires no user action and runs regardless of whether the windshear detection toggle is enabled.

The state machine works in three stages:

1. **APPROACHING** — the aircraft is descending (vertical rate ≤ −200 fpm) inside the corridor. Consecutive polls confirming descent are counted. Only after a configurable number of descending poll cycles (default 8, configurable via `WINDSHEAR_GA_MIN_DESCENT_POLLS`) does the state advance to APPROACHING — this prevents go-around false triggers from aircraft that are still vectoring in and temporarily levelling.

2. **GO_AROUND detection** — from the APPROACHING state, two conditions must both be satisfied before a go-around is declared. First, the detector counts consecutive poll cycles where the aircraft's vertical rate is ≥ 600 fpm AND altitude is at or below 2 200 ft — a configurable number of consecutive climbing polls (default 3, `WINDSHEAR_GA_MIN_CLIMB_POLLS`) must be accumulated, equivalent to 9 seconds of sustained climb. Second, the actual pressure altitude must have risen by at least 50 ft since the climb started (`WINDSHEAR_GA_MIN_ALT_GAIN_FT`), guarding against barometric lag or vert_rate quantization where a high reported rate does not correspond to meaningful altitude change. If any poll during the window falls below the climb threshold both counters reset to zero. The climb rate and altitude ceiling are configurable via `WINDSHEAR_GA_CLIMB_FPM` and `WINDSHEAR_GA_MAX_ALT_FT`.

3. **Return approach tracking** — a go-around count is maintained per ICAO24 address for the duration of the page session. An aircraft coming back for a second approach gets a **2nd APP** badge next to its callsign; a third approach shows **3x APP**, and so on.

When a go-around fires:

- A blinking **✈ GO-AROUND** label appears on the flight strip (flashes for up to 60 seconds, configurable via `WINDSHEAR_GA_FLASH_SEC`)
- The event is appended to the **windshear event log** with a timestamp, runway, altitude at detection, and ordinal count (1st / 2nd / 3rd go-around this session)
- Go-around log entries are always recorded even when windshear detection is disabled

**Tuning the detector** — the default values work well at EFHK but may need adjustment depending on traffic mix and local procedures:

- **False positives** (aircraft flagged as go-around when they are not): increase `WINDSHEAR_GA_MIN_CLIMB_POLLS` (default 3) to require a longer sustained climb, or raise `WINDSHEAR_GA_MIN_ALT_GAIN_FT` (default 50 ft) to require more actual altitude change before the event fires — both are useful in gusty or turbulent conditions. You can also increase `WINDSHEAR_GA_MIN_DESCENT_POLLS` (default 8) to require a longer confirmed descent before the state machine arms, or raise `WINDSHEAR_GA_CLIMB_FPM` (default 600 fpm) to ignore shallower climbs from glideslope corrections or level-offs.
- **Missed go-arounds** (aircraft that go around but are not detected): check `WINDSHEAR_GA_MAX_ALT_FT`. If an aircraft initiates a go-around above the 2 200 ft ceiling — for example on a high-energy visual approach or after a late ATC instruction — it will not be detected. Raise the ceiling to 3 000 or 4 000 ft to capture earlier go-arounds, bearing in mind that this also increases the chance of triggering on climbing traffic that enters the corridor from below.
- **Flash duration**: `WINDSHEAR_GA_FLASH_SEC` (default 60 s) controls how long the blinking label stays on the strip after detection. Increase it if you want the indication to persist longer during a busy sequence.

#### Map

The Leaflet map shows:

- **Approach centreline overlays** from `overlays/efhk_ils.geojson` — each runway's extended centreline drawn as a line on the map; ILS runways (04L, 04R, 22L, 22R, 15) are styled in blue (`#38bdf8`) with a short dash pattern; the RNP approach to RWY 33 is styled in amber (`#f59e0b`) with a longer dash pattern so the two approach types are immediately visually distinct; the Leaflet style callback routes on the `approach_type: "RNP"` property in the GeoJSON feature; the RWY 33 centreline uses the true geographic runway axis (153.1°T outbound / 333.1°T inbound) as published on the approach chart — not the magnetic heading
- **Airport layout overlay** from `overlays/efhk_apt.geojson` — taxiways and runway markings
- **15 NM range circle** centred on the configured airport reference point
- **Aircraft markers** with callsign labels; corridor aircraft are brighter and have a higher z-index than non-corridor traffic
- **Tooltips** showing callsign, matched runway, altitude, and distance from threshold

**Map themes** — four tile layer choices accessible via buttons in the map controls overlay: Dark (CartoDB dark), Grey (CartoDB light), ATC (flat `#cfcfcf` radar grey, no tile imagery), Black (pure black background, no labels).

The **ATC** and **Black** themes support **overlay cycling** — clicking the active button a second time does not re-apply the theme but instead cycles through three overlay levels: ILS centrelines only → ILS + coastline (`efhk_coast.geojson`) → ILS + coastline + water polygons (`efhk_aqua.geojson`). The button label reflects the current level (ATC / ATC+C / ATC+CA and Black / Black+C / Black+CA). A further click wraps back to ILS only. Each theme remembers its overlay level independently, so switching between ATC and Black retains the previous level for each.

Overlay layers on ATC use muted navy/steel colours that contrast clearly against the grey radar background; on Black the same layers use deep blue tones against the dark canvas.

**ILS Only toggle** — filters the map to show only aircraft currently inside an ILS corridor, hiding all other tracked traffic. Defaults **on**; state persists across browser sessions.

**Windrose toggle** — shows a compass rose overlay (top-right of the map) comparing METAR surface wind direction with low-altitude MODE-S wind observations from recent approach traffic.

**Approach History toggle** (`Apch Hist` button) — opens a floating table overlay (top-left of the map) that logs the wind profile for each completed approach. Every approach is persisted to the SQLite `approach_history` table and survives server restarts. The panel height scales dynamically with the map container. All controls sit on a single row: time-window buttons (1h · 3h · 6h · 12h · 1d, default 3h), a `dd.mm.yyyy` date picker + 📅 calendar button for querying a specific day, a **Live** button (blue when in live rolling-window mode), and — after a separator — a **display mode dropdown** and a **Lo/Hi** resolution button. Columns: UTC time, callsign, registration, aircraft type, runway, and wind at altitude bands; registration and type show `—` when not available. Lo shows 8 columns (600–3 000 ft); Hi shows 13 columns (600–3 000 ft at 200 ft steps). The display mode dropdown offers four options: **Wind** (raw `dir°/spd`), **HW** (headwind component, default), **XW** (crosswind component — `←` = from left, `→` = from right, colour-coded by magnitude), and **HW+XW** (both in a two-line cell). See the Layout section above for a full explanation of the crosswind arrow convention. There is no Clear button — data is persistent and the time filter or date picker controls what is visible.

#### Windshear detection

Windshear detection is controlled from the **Windshear Alert header bar**, which contains three inline controls: the **OFF/ON toggle button**, an **algorithm dropdown** (`Pair / Gradient / Energy / Rate / Baseline / Kinematic`), and the **Clear** button. Detection is **OFF by default** to allow monitoring of approach patterns before trusting automated alerts.

Six independent detection algorithms are available from the dropdown. Switching algorithm takes effect instantly and re-runs detection against the current aircraft set without waiting for the next poll. Only one algorithm is active at a time. Hovering over the dropdown shows a one-line description of each option.

All algorithms use the same headwind component formula:

```
headwind (kt) = wind_speed × cos(wind_direction − runway_heading)
```

Positive values represent a headwind; negative values represent a tailwind. The runway heading used is the published magnetic approach heading for the matched runway (e.g. 047° for RWY 04L/04R, 227° for RWY 22L/22R).

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

Only aircraft with GS status **ON** (within ±300 ft of the QNH-corrected glideslope) are included in detection, preventing false alerts from aircraft still intercepting the glideslope from above or below.

Turning the toggle OFF immediately clears all active alerts. Previously logged events remain visible until cleared manually. All data is held in RAM and does not persist across page refreshes.

##### Algorithm 1 — Pairwise (classic ICAO method)

**Requires: ≥ 2 aircraft simultaneously on the same approach.**

The Pairwise algorithm is the classical windshear detection technique defined in ICAO Doc 9817 and used operationally by airport LLWAS (Low-Level Windshear Alert Systems). It compares the headwind component between two simultaneously tracked aircraft on the same ILS corridor, one higher and one lower on the glideslope.

For every pair of corridor aircraft within a 200–2 000 ft altitude separation window, the algorithm computes:

```
ΔHW = headwind(upper aircraft) − headwind(lower aircraft)
```

A large |ΔHW| reveals the presence of a wind shear layer between the two altitude levels. The 200 ft minimum separation prevents noise from aircraft at nearly the same level; the 2 000 ft maximum limits comparison to physically adjacent approach segments.

**Limitation:** requires two aircraft on approach simultaneously. During low-traffic periods this algorithm produces no output even when real shear is present. It is most powerful during busy arrival sequences with closely stacked aircraft.

##### Algorithm 2 — Gradient (single-aircraft wind history)

**Requires: ≥ 3 stored wind observations for the same aircraft.**

The Gradient algorithm examines the wind history accumulated for a single aircraft during its approach. As an aircraft descends from 3 000 ft to the threshold, the system stores up to 40 wind snapshots at intervals of ≥ 400 ft altitude change or ≥ 0.5 NM distance. The algorithm then finds the pair of observations — within a 200–3 000 ft altitude band — with the largest headwind difference.

This directly measures the **vertical wind gradient** (dHW/dz) in the low-level approach environment. A gradient exceeding ~15 kt over 1 000 ft of altitude is operationally significant and is indicative of a wind shear layer within the approach path.

**Advantage over Pairwise:** works with a single aircraft and accumulates evidence progressively as the aircraft descends through the wind field. Effective during single-runway VMC traffic when only one aircraft is on approach at a time.

**Limitation:** detection sensitivity increases with each new wind observation. The algorithm produces no output for the first few observations (< 3 valid wind points) and improves in accuracy as the aircraft continues its descent.

##### Algorithm 3 — Energy (total energy trend, GPWS-inspired)

**Requires: ≥ 4 groundspeed + altitude observations within the last 45 seconds.**

The Energy algorithm tracks a total mechanical energy proxy for each approach aircraft over a sliding 45-second window. The proxy is:

```
E = groundspeed (kt) + altitude (ft) / 100
```

On a stabilised 3° ILS approach at ~140 kt groundspeed, the aircraft descends roughly 318 ft per NM. Geometry and typical approach speeds mean that ~100 ft of altitude corresponds to approximately 1 kt of equivalent kinetic energy along the approach path. On a stable approach, E remains approximately constant as the aircraft trades altitude for forward speed at a predictable rate.

A rapid decrease in E signals that the aircraft is losing more total energy than the normal glideslope geometry predicts — the classic kinematic signature of a microburst or strong headwind loss event. A drop of ≥ 15 kt-equivalent in 45 seconds is flagged.

This algorithm is inspired conceptually by the energy-rate monitor in airborne EGPWS (Enhanced Ground Proximity Warning System) devices, which monitor the rate of total energy change to detect abnormal energy loss states during approach.

**Advantage:** entirely groundspeed-based — no wind decoding required. Effective even when the aircraft's EHS wind registers (BDS 4,4 / 5,0) are not broadcasting.

**Limitation:** any unrelated groundspeed fluctuation (e.g. temporary speed adjustment on ATC instruction) can trigger a false alarm. Works best with stable, consistent groundspeed data.

##### Algorithm 4 — Rate (headwind rate of change)

**Requires: ≥ 2 stored wind observations and a current headwind value.**

The Rate algorithm compares the aircraft's current headwind component to the oldest value in its recent wind history (up to the last 6 observations). Unlike the Gradient algorithm, it is not altitude-filtered — it detects any headwind change along the approach path, whether driven by altitude-related wind structure or by horizontal passage through a shear zone.

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

If a current corridor aircraft's headwind deviates from `baseline_HW` by ≥ 15 kt, shear is flagged.

**Physical basis:** the baseline represents the background low-level wind field sampled by multiple recent aircraft on the same approach path. A large deviation for the current aircraft suggests that the wind environment has changed sharply since the baseline was established — either spatially (a localised shear zone has developed) or temporally (a frontal passage or microburst onset has changed the surface wind since the last landing).

**Advantage:** the most context-aware of the five algorithms — it adapts to the actual recent wind environment at the airport rather than using a fixed reference. It can detect wind changes that develop gradually between arrival waves.

**Limitation:** requires landing traffic in the preceding 30 minutes to populate the baseline buffer. The algorithm is silent at the start of a session or after a long traffic gap. Also assumes the baseline is representative of the current runway and direction, which may not hold perfectly when runway direction changes between the baseline and current approaches.

##### Algorithm 6 — Kinematic (IAS − GS differential rate)

**Requires: a single aircraft in the ILS corridor with BDS 6,0 IAS data available.**

The Kinematic algorithm detects windshear by monitoring the rate of change of the difference between Indicated Airspeed (IAS) and GPS groundspeed (GS) over a 45-second sliding window.

At low altitude, air density is close to sea-level ISA conditions, so IAS ≈ TAS (True Airspeed). The identity `IAS − GS ≈ headwind component along track` therefore holds without requiring any wind direction decoding. If the aircraft is flying into a headwind the differential is positive; a tailwind makes it negative. A sudden change in this differential is a direct kinematic measurement of a windshear encounter:

```
differential(t) = IAS(t) − GS(t)
delta = |differential_now − differential_45s_ago|
```

If `delta ≥ 15 kt` the event is flagged as moderate; `≥ 25 kt` is severe.

**Physical basis:** the approach phase is the only flight phase where a sudden change in `IAS − GS` can reliably be attributed to a wind shear and not to a deliberate speed change, because:
- the aircraft is flying a stabilised approach at a fixed target IAS;
- any large unintended IAS change is caused by an aerodynamic disturbance (gust, shear, microburst), not a throttle input;
- GS reflects the aircraft's inertial motion, which lags momentarily behind the aerodynamic change, creating a measurable differential.

A microburst headwind-loss encounter produces a rapid decrease in the differential (IAS drops faster than GS responds), while a headwind-gain event produces the opposite.

**Advantage:** the most dataflow-simple of all algorithms — uses only two raw Mode S fields (BDS 6,0 airspeed, ADS-B groundspeed) with no wind vector reconstruction. Works with a single aircraft. No runway heading or wind direction needed.

**Limitation:** requires BDS 6,0 Indicated Airspeed to be broadcast by the aircraft, which most modern jets do but is not mandatory. The IAS ≈ TAS approximation breaks down above ~6 000 ft (density altitude effect), but the algorithm is gated to GS-status-ON aircraft which are already on the glideslope well below that altitude.

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

**Why F-factor adds information beyond the kt value:** two events could both show `18 kt Warning` but have very different F-factors depending on how quickly the 18 kt was lost. An aircraft that lost 18 kt of headwind over 40 seconds (`F ≈ 0.06`) is a very different situation from one that lost it over 8 seconds (`F ≈ 0.30`). The kt value tells you the magnitude; the F-factor tells you the rate, which is what determines whether the crew had time to respond.

F-factor is displayed as supplementary information in the log. Severity classification is still driven by the kt thresholds, but the **Kinematic F-factor gate** dropdown (`F: Off / F ≥0.05 / F ≥0.08 / F ≥0.10 / F ≥0.15`) in the log header lets you suppress Kinematic events whose F-factor is below a chosen minimum. This is useful for research — setting the gate to `F ≥0.05` silently discards the slow background drift events (typically F=0.02–0.03) that represent normal approach variation according to the JAWS thresholds, while preserving genuine rapid shear events. The gate is automatically greyed out when any other algorithm is selected, since F-factor is only computed for Kinematic. The preference is saved across sessions. Default is Off (no filtering).

#### Stale aircraft removal

Aircraft that stop transmitting (e.g. because the receiver loses line-of-sight on short final) are removed from the display within approximately 30–45 seconds. The tracker's sweep thread checks `last_seen` timestamps against a 30-second window and the `prune_stale()` method removes any aircraft not updated within 30 seconds. This keeps the display clean during busy approach sequences where multiple aircraft land in quick succession.

---

### GPS Quality  `/gps`

An area-wide real-time and historical monitor for GPS signal quality degradation across all aircraft tracked by the receiver. The page auto-refreshes every 30 seconds.

Hourly summary data is persisted to the SQLite `gps_quality_hours` table (All zone) and `gps_quality_zone_hours` table (50 nm and 20 nm zones) so that the time-series chart and heatmap survive process restarts. Only completed hours are written to the database (up to 72 rows per hour rollover — 24 per day for All, up to 24 per day per distance zone), so the write load is negligible. On startup the tracker reloads the last **31 days** of history automatically — the charts are immediately populated from stored data. The current (incomplete) hour accumulates in RAM only and is lost on an unplanned restart, but this is an acceptable trade-off (at most 59 minutes of data).

> **Why "GPS Quality" and not "GPS Jamming"?** The page detects and displays objective signal quality parameters — it does not assert a cause. True GPS jamming, spoofing, receiver failure, and genuine satellite outages can all produce the same observable signatures. The term "GPS Quality" is deliberately neutral.

#### Detection signals

The tracker watches every aircraft in the live_state snapshot on each 5-second sweep and flags aircraft showing any of four degradation signals:

| Signal | Badge | Condition | Typical cause |
|--------|-------|-----------|---------------|
| **NACp** | Blue | Navigation Accuracy Category ≤ 6 (horizontal accuracy worse than ~0.1 NM) | GPS degradation reported by the aircraft avionics themselves; sourced from TC=29 / TC=31 ADS-B messages |
| **Freeze** | Cyan | Identical lat/lon across ≥ 3 consecutive sweeps while groundspeed > 50 kt | GPS receiver output is frozen at the last valid fix; the aircraft is clearly moving but its position is not updating |
| **Gap** | Purple | No ADS-B position message for ≥ 45 seconds while the aircraft is still visible in any Mode-S message (surveillance replies, squitters, identification frames, etc.) | GPS source has dropped out entirely; the transponder is alive but not producing position messages. Rare at EFHK because MLAT coverage keeps `lat` non-null even during GPS outages |
| **ADS-B** | Teal | No TC=9-18/20-22 ADS-B airborne-position message received in the Beast feed for ≥ 45 seconds while the aircraft still has a visible position (maintained by MLAT) | ADS-B GPS position dropout covered by MLAT — the aircraft's own GPS has failed but the Radarcape multilateration network continues to track it; the most operationally relevant jamming signal at EFHK where MLAT coverage is strong |

The **ADS-B** signal is detected via a `last_adsb_pos_ts` timestamp maintained by `collector/receiver.py` — updated only when a genuine TC=9-18/20-22 position message is decoded from the Beast feed (not from BDS 5,0/6,0 replies or cached state). The Gap signal requires `lat is None`, which almost never occurs at EFHK since MLAT immediately fills in positions when ADS-B GPS fails. ADS-B and Gap are mutually exclusive by design.

NACp is extracted from TC=29 (Target State & Status) and TC=31 (Aircraft Operational Status) ADS-B messages broadcast periodically by modern Mode S transponders. Older transponders that do not transmit these message types will show `—` in the NACp column and can only be detected via the Freeze, Gap, or ADS-B signals.

**NACp scale reference:**

| NACp | Horizontal accuracy | Interpretation |
|------|---------------------|----------------|
| 0 | Unknown | No position accuracy information available |
| 1–3 | > 10 NM | Very poor — GPS effectively unusable |
| 4–6 | 0.1 – 10 NM | Degraded — flagged by the tracker (threshold ≤ 6) |
| 7–9 | 0.1 – 0.05 NM | Good to excellent |
| 10–11 | < 30 m | Highest accuracy |

#### Layout

The page has three main panels:

**Time-series chart (left top)** — a stacked bar chart with three colour-coded segments per bar showing the per-signal event breakdown: **NACp** (amber), **Freeze** (sky blue), and **Gap** (violet). The total bar height represents all events in that period; the segment proportions immediately reveal which detection signal is dominant. A grey **Aircraft** line (right Y-axis) overlays aircraft count for traffic normalisation — bars consistently taller than the aircraft line suggest genuine elevated degradation rather than traffic density alone. Historical hours recorded before per-signal tracking was introduced are shown as a neutral grey **Unknown** segment. The chart updates on each 30-second poll.

A **range selector** in the chart header controls how much history is displayed:

| Button | Granularity | Description |
|--------|-------------|-------------|
| `1d` | Hourly bars | Last 24 hours — default view |
| `2d` | Hourly bars | Last 48 hours; date prefix shown at midnight boundaries |
| `3d` | Hourly bars | Last 72 hours |
| `1w` | Hourly bars | Last 7 days — full hourly resolution, 7 day-boundary tick labels |
| `2w` | Daily bars  | Last 14 days aggregated per calendar day |
| `1m` | Daily bars  | Last 31 days aggregated per calendar day |

For the daily-aggregate views (`2w` / `1m`) the Aircraft line shows the **peak hourly aircraft count** per day rather than a sum, giving a meaningful sense of traffic volume. The selected range is remembered across browser sessions via `localStorage`.

**FL-band heatmap (left bottom)** — a colour-coded grid with eight rows (FL bands: FL010–030 / FL030–050 / FL050–100 / FL100–150 / FL150–200 / FL200–250 / FL250–300 / FL300+) and one column per day for the **last 14 days**. Cell colour ranges from near-background (no events) through blue, amber, and red to dark red (high activity). The event count is printed inside non-zero cells. This view is most useful for identifying which altitude layers are most affected on which days — low-level bands being consistently darker than high-level bands is a signature of ground-based jamming that affects climb/descent phases more than cruise.

**Live degraded aircraft table (right top)** — shows all aircraft currently flagged by any detection signal, sorted highest altitude first. Columns: callsign, ICAO24, FL band, altitude (ft), groundspeed (kt), NACp value, and active flag badges. The table is sized to show 7 rows; additional entries are accessible via scrollbar. Refreshes every 30 seconds.

**FL Band Analysis panel (right middle)** — a doughnut chart showing how total degradation events are distributed across the eight FL bands over the same 14-day window as the heatmap. FL band labels appear as a vertical list on the left side of the chart; hover tooltips show the event count and percentage for each segment. Below the chart a compact stats block shows: total events, most affected FL band (with count), worst single day (date and count), and a NACp / Freeze / Gap signal breakdown with counts and percentages. The donut reflects the **active zone** — switching the zone selector redraws it immediately using the newly fetched zone data; within a zone it is refreshed every **60 minutes** and intentionally not updated on every 30-second poll since the 14-day aggregates change slowly.

**Summary bar** — across the top of the page: total events in the last 24 hours, number of unique aircraft affected, peak hour, current live degraded count, and the **zone selector** (see below).

**Signal key panel (right bottom)** — explains each detection signal with its threshold values and the full NACp scale for reference.

**Distance zone selector (summary bar)** — three buttons **All · 50 nm · 20 nm** filter every view on the page to aircraft within the selected radius from the airport. **All** (default) shows the full receiver coverage area with no distance limit. **50 nm** covers the terminal area and nearby overflights — typically the most relevant traffic for EFHK operations. **20 nm** covers approach and departure operations only, roughly matching the ILS corridor monitored on the Windshear page. Zone data is stored in a separate `gps_quality_zone_hours` DB table and begins accumulating from the moment the feature is first deployed; the All historical data is unaffected. For Position Gap events (no current ADS-B position) the aircraft's last-known position is used if it is no more than 2 minutes old, so that aircraft experiencing a complete GPS drop-out near the airport still count in the close-range zones. The selected zone is remembered across browser sessions.

#### WAM ground station filtering

The Finnish Air Navigation Services operate a network of Wide Area Multilateration (WAM) ground interrogator stations that transmit Mode-S replies detectable by the Radarcape. Their ICAO24 addresses begin with `T40`. These are fixed ground infrastructure — not aircraft — but without filtering they would be included in the "total aircraft seen" count every hour and could generate spurious Gap events (a WAM station never transmits ADS-B position, so it would immediately satisfy the Gap condition once seen). The system filters all `T40` prefixed addresses system-wide at both live\_state entry points (`BLOCKED_ICAO_PREFIXES` in `config.py`) so WAM stations never reach the GPS quality tracker or any other subsystem.

Finnish helicopters (`OH-H` registration prefix) are similarly excluded via `BLOCKED_REG_PREFIXES`. Their continuous manoeuvring near the airport produces unreliable BDS 5,0/6,0 computed wind unsuitable for meteo analysis. The registration filter is applied at the same two live\_state entry points, so helicopters are invisible to the GPS quality tracker, the windshear tracker, and the database writer alike.

#### Interpreting the data

The heatmap and time series together provide complementary views. The heatmap answers "which days and altitude layers had the most degradation?" — useful for spotting multi-day patterns and altitude-dependent effects. The time series answers "what time of day does degradation tend to peak?" — useful for identifying scheduled jamming exercises or dawn/dusk atmospheric effects.

At EFHK, GPS interference from the east tends to affect low-altitude bands (FL000–100) most heavily since the geometry between aircraft at low altitude and a ground-based jammer to the east is most favourable. High-altitude aircraft in cruise on the same routes may show weaker effects. The FL-band heatmap makes this altitude dependence immediately visible. The lowest two bands (FL010–030 and FL030–050) give extra resolution in the critical approach and initial climb phase where jamming effects are most operationally significant. Aircraft below FL010 (1 000 ft) are excluded from all signal checks to avoid false positives from landing aircraft that disappear from reception on short final.

After the first restart, completed hourly buckets are restored from the database and the charts are populated immediately. On a brand-new installation the heatmap will be sparse for the first few hours; a meaningful pattern typically emerges after 12–24 hours of traffic.

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

Written automatically when each hour rolls over (24 writes per day). Loaded on startup to restore up to 31 days of heatmap and time-series history. The per-signal columns were added progressively in May 2026; existing rows carry 0 for any columns added after they were written and are displayed as grey "Unknown" bars in the chart until they age out.

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

Written in parallel with `gps_quality_hours` on each hour rollover (up to 2 extra rows per hour — one per zone). Zone data begins accumulating from the first deployment of this feature; the `gps_quality_hours` table is not modified. Loaded on startup via a separate query per zone.

**`approach_history`** — one row per completed landing approach (persisted by `WindshearTracker` via callback hook in `run.py`):

| Column | Description |
|--------|-------------|
| id | Auto-increment primary key |
| ts | Unix timestamp (UTC) of landing / stale-out moment |
| date_utc | `"YYYY-MM-DD"` — used for date-based filtering |
| time_utc | `"HH:MM"` — display time |
| icao | ICAO24 hex address |
| callsign | Flight callsign |
| registration | Aircraft registration (if known) |
| aircraft_type | Aircraft type code (if known) |
| runway | Runway designator, e.g. `"22L"` |
| rwy_heading | Runway approach heading (°) |
| bands_json | JSON object keyed by altitude ft (as string); value is `{"dir": int, "spd": float}` or `null` when no wind was captured at that level; e.g. `{"200": {"dir": 270, "spd": 15}, "400": null, …}` |

Indexed on `ts`, `date_utc`, and `runway`. Data volume is under 1 MB/year at typical EFHK approach rates. Loaded on server startup to pre-populate the RAM approach list for immediate display in fresh browser sessions.

**`maintenance_config`** — key/value store for maintenance page settings:

| Column | Description |
|--------|-------------|
| key | Setting name (primary key) |
| value | Setting value as text |

Used keys: `autopurge_flight_enabled` (`'0'`/`'1'`), `autopurge_flight_days` (integer as text), `autopurge_last_run` (Unix timestamp as text). Written by the maintenance API; read by the autopurge background thread.

**`observations`** — one row per decoded message with useful data:

- Position: `lat`, `lon`, `altitude` (ft)
- Motion: `groundspeed` (kt), `track` (°), `vert_rate` (ft/min)
- MRAR: `mrar_wind_spd/dir/temp/pressure/humidity/turbulence/fom`
- MHR: `mhr_temp/pressure/turbulence/wind_shear/icing/microburst/radio_height`
- Computed wind: `wind_spd/dir/qual`
- Raw BDS 5,0 / 6,0 inputs (stored for re-processing)
- Consolidated best values: `best_wind_spd/dir/temp/pressure`, `meteo_source`

### Direct database queries

The database can be queried while the system is running (WAL mode allows concurrent reads):

```bash
sqlite3 data/modes_meteo.db
```

Useful queries:

```sql
-- Meteo observation counts by source
SELECT meteo_source, COUNT(*) FROM observations GROUP BY meteo_source;

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

1. **MLAT positions from the Radarcape JSON feed** — the Radarcape calculates aircraft positions via Multilateration (MLAT), which uses precise timing of Mode-S replies at multiple ground stations and does not depend on GPS. These positions are merged into the live display automatically and marked with a purple symbol.

2. **Single-frame CPR decoding** — for aircraft that are transmitting CPR position data but whose messages are being rejected by the bootstrap mechanism, the system uses `airborne_position_with_ref()` to decode position from a single frame using the receiver's known location as a reference (valid within 180 NM).

---

## Project Structure

```
mode_s_wind/
├── config.py                  # All configuration settings
├── run.py                     # Main entry point + windshear sweep thread
├── database/
│   ├── db.py                  # SQLite connection management
│   └── schema.sql             # Database schema
├── collector/
│   ├── receiver.py            # Beast TCP connection + EHS decoder (incl. NACp extraction)
│   ├── radarcape_json.py      # Radarcape JSON/MLAT poller
│   ├── wind_calc.py           # BDS 5,0 + 6,0 computed wind
│   ├── windshear.py           # RAM-only approach tracker + windshear detection
│   ├── gps_quality.py         # Area-wide GPS quality monitor (RAM + DB persistence)
│   └── filter.py              # Observation quality filters
├── web/
│   ├── app.py                 # Flask app + all API routes
│   ├── api/
│   │   ├── sounding.py        # Sounding aggregation logic
│   │   └── windmap.py         # Gridded wind map aggregation logic
│   └── templates/
│       ├── base.html          # Navbar, status indicator, config badges
│       ├── live.html          # Live map page
│       ├── flights.html       # Flights browser page
│       ├── sounding.html      # Skew-T sounding page
│       ├── windmap.html       # Gridded wind map page
│       ├── windshear.html     # Approach monitoring + windshear page
│       └── gps_quality.html   # GPS quality monitoring page
├── static/
│   ├── css/style.css          # Dark/light theme stylesheet
│   └── js/
│       ├── live_map.js        # Live map, ATC display, atmosphere profile
│       ├── sounding.js        # Skew-T canvas renderer
│       ├── windmap.js         # Wind map barb rendering + controls
│       ├── windshear.js       # Approach strips, ILS profile, windshear detection
│       └── gps_quality.js     # GPS quality charts, heatmap, live table
├── overlays/                  # GeoJSON overlays served to the Windshear map
│   ├── efhk_ils.geojson       # EFHK ILS centreline geometry (all runways)
│   ├── efhk_apt.geojson       # EFHK airport layout (runways, taxiways)
│   ├── efhk_coast.geojson     # Coastline overlay (ATC+C / Black+C overlay level)
│   └── efhk_aqua.geojson      # Water / aqua polygons (ATC+CA / Black+CA overlay level)
├── data/                      # SQLite database (created at runtime)
├── logs/                      # Log files (created at runtime)
└── pyModeS-main/              # Reference copy of pyModeS library
```

---

## Maintenance  `/maintenance`

An administrator page for database housekeeping. It is accessible at `/maintenance` and rendered by `web/templates/maintenance.html`.

Authentication is handled separately from the main web credentials — all operations require a username and password read from a credential file whose path is set in `config.py` as `MAINTENANCE_AUTH_FILE`. The file contains a single line in `username:password` format and should be placed outside the project directory and excluded from version control (`.gitignore` already ignores `dbauth.txt`). Credentials are submitted with every operation and never stored in a server session.

**Operations:**

- **Database statistics** — read-only view showing for each table: row count, number of distinct calendar days with data, oldest and newest record dates, and total SQLite file size; refreshed on demand; the days count helps choosing an appropriate purge threshold
- **Flight & Meteo data purge** — deletes records from `observations` and `flights` older than a configurable number of days; a preview step shows exact counts before any deletion; `approach_history` is never touched by any maintenance operation
- **GPS Quality data purge** — separately deletes rows from `gps_quality_hours` and `gps_quality_zone_hours` older than a configurable threshold; the in-RAM GPS quality cache is reloaded immediately after so the GPS Quality page reflects the change without a server restart
- **Autopurge** — optional daily scheduled purge for flight/meteo data; when enabled, a background thread checks once per hour and runs the purge if it has not yet run today; settings (enabled/disabled, day threshold) are persisted in the `maintenance_config` DB table; GPS Quality and Approach History data are never auto-purged

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
| GET | `/api/sounding` | Area-average sounding from recent observations |
| GET | `/api/stats` | Summary counters for the navbar |
| GET | `/api/windmap` | Gridded wind map (params: `fl`, `tolerance`, `grid`, `window` or `start`+`end`) |
| GET | `/api/wx` | METAR and TAF for the configured airport, fetched server-side from NOAA |
| GET | `/api/windshear/state` | Snapshot of all currently tracked approach aircraft (RAM-only, no DB) |
| GET | `/api/windshear/approach-history` | Landed approach history. Without params: in-RAM list (backward compat). `?window=<seconds>` (e.g. `?window=10800`): DB query for rolling time window. `?date=YYYY-MM-DD`: DB query for a specific UTC calendar day (`WHERE date_utc = ?`); returns HTTP 400 on malformed date. `window` takes precedence over `date` if both supplied. Each entry: `ts`, `time_utc`, `icao`, `callsign`, `registration`, `aircraft_type`, `runway`, `rwy_heading`, `bands` (dict keyed by altitude ft) |
| POST | `/api/windshear/approach-history/clear` | Delete all rows from the `approach_history` DB table and clear the RAM list (administrative use; no UI button exposes this) |
| GET | `/api/windshear/windrose-obs` | Rolling 6-hour buffer of low-altitude wind observations (alt ≤ 2 000 ft, non-NONE, in-corridor) harvested from recently landed aircraft; used by the browser on page load and re-fetched every 60 s to keep the Windrose and Hist trend feature current mid-session; each entry: `ts`, `dir`, `spd`, `alt` |
| GET | `/api/gps/state` | GPS quality monitor state: live degraded aircraft, time series, 14-day FL heatmap, FL band summary stats; optional `?zone=50nm` or `?zone=20nm` filters data to aircraft within that radius from the airport (default `all`); completed hours persisted in `gps_quality_hours` and `gps_quality_zone_hours` and reloaded on restart |
| GET | `/overlays/<filename>` | Serves GeoJSON overlay files from the project-level `overlays/` directory |
| GET | `/maintenance` | Maintenance page (HTML) — requires separate maintenance credentials for all operations |
| POST | `/api/maintenance/stats` | Database statistics: row counts, date ranges, file size for all tables |
| POST | `/api/maintenance/flight/preview` | Preview flight/observation rows that would be deleted for a given day threshold |
| POST | `/api/maintenance/flight/purge` | Delete observations and flights older than N days; approach history untouched |
| POST | `/api/maintenance/flight/autopurge` | Save autopurge settings (enabled, days threshold) to `maintenance_config` |
| POST | `/api/maintenance/flight/autopurge-config` | Read current autopurge settings |
| POST | `/api/maintenance/gps/preview` | Preview GPS quality rows that would be deleted for a given day threshold |
| POST | `/api/maintenance/gps/purge` | Delete GPS quality hourly rows older than N days; reloads in-RAM cache after deletion |

All `/api/maintenance/*` endpoints require `username` and `password` fields in the JSON request body, validated against the `MAINTENANCE_AUTH_FILE` credential file.

---

## Acknowledgements

- **[pyModeS](https://github.com/junzis/pyModeS)** by Junzi Sun — the foundational MODE-S / ADS-B decoding library this project is built on
- **[Leaflet](https://leafletjs.com/)** — interactive maps
- **[Chart.js](https://www.chartjs.org/)** — time-series charts
- **[CartoDB](https://carto.com/)** — dark map tiles
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

The project uses several open-source libraries (pyModeS, Leaflet, Chart.js) which retain their own respective licenses — see the Acknowledgements section.