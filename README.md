# MODE-S Meteo

A Python-based system for collecting, decoding and visualising real-time meteorological data from aircraft using **MODE-S Enhanced Surveillance (EHS)** and **ADS-B** messages received by a [Jetvision Radarcape](https://www.jetvision.de/radarcape/) receiver.

Aircraft continuously broadcast meteorological data from their onboard sensors as part of their secondary surveillance transponder output. This system decodes those messages in real time, stores the data in a local SQLite database, and presents it through a dark-themed web dashboard with a live map, historical flight browser, and Skew-T atmospheric sounding diagrams.

---

## Features

- **Real-time live map** — ATC-style aircraft display with 1-minute position trails, colour-coded by meteo data source, with optional callsign or ICAO24 labels
- **Three meteo data sources** decoded simultaneously:
  - BDS 4,4 MRAR — Meteorological Routine Air Report (direct temp, pressure, humidity, wind, turbulence from aircraft avionics)
  - BDS 4,5 MHR — Meteorological Hazard Report (icing, wind shear, microburst, turbulence levels)
  - BDS 5,0 + 6,0 computed wind — wind vector derived from true track, ground speed, magnetic heading and airspeed
- **MLAT position support** — polls the Radarcape's JSON feed for multilateration-derived positions that remain accurate even when GPS jamming suppresses ADS-B position broadcasts
- **Skew-T atmospheric soundings** — aggregated area profile built from all aircraft near the receiver over a configurable time window, plus per-flight vertical profiles for climbing/descending flights
- **Mini atmosphere profile panel** — always-visible Skew-T profile in the live map sidebar with ISA reference, area wind barbs labelled with direction and speed, and a live aircraft overlay that accumulates a full vertical wind history as the aircraft climbs or descends
- **Historical flight browser** — searchable and paginated table of all recorded flights with meteo statistics
- **Persistent UI preferences** — all toggles (Meteo only, Labels, label mode, wind history density) are remembered across browser sessions via localStorage
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
                                    ┌─────────┴──────────┐
                                    │                    │
                              database/            web/app.py
                              writer thread        Flask + SSE
                              (SQLite WAL)         │
                                    │              ├─ /           Live map
                                    │              ├─ /flights    History
                                    │              └─ /sounding   Skew-T
                                    │
                              data/modes_meteo.db
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
git clone https://github.com/YOUR_USERNAME/mode-s-meteo.git
cd mode-s-meteo
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
```

Key values to change for your installation:

- `RADARCAPE_HOST` — IP address of your Radarcape on the local network
- `RECEIVER_LAT` / `RECEIVER_LON` — your receiver's location (used for CPR position decoding and sounding radius)
- `MAG_DECLINATION` — magnetic declination for your location (affects computed wind accuracy); find your value at [NOAA magnetic declination calculator](https://www.ngdc.noaa.gov/geomag/calculators/magcalc.shtml)
- `WEB_USER` / `WEB_PASS` — credentials for the web interface

### 4. Run

```bash
python3 run.py
```

The system will log startup information and the web interface address:

```
2025-05-11 12:00:00  INFO     modes.main           ============================================================
2025-05-11 12:00:00  INFO     modes.main           MODE-S Meteo System starting
2025-05-11 12:00:00  INFO     modes.main             Database : /home/pi/mode-s-meteo/data/modes_meteo.db
2025-05-11 12:00:00  INFO     modes.main             Radarcape: 192.168.0.119:10003
2025-05-11 12:00:00  INFO     modes.main             Web      : http://0.0.0.0:5010
```

Open `http://<raspberry-pi-ip>:5010` in a browser. You will be prompted for username and password.

### 5. Running in the background (optional)

```bash
nohup python3 run.py > logs/modes_meteo.log 2>&1 &
echo $! > run.pid          # save PID to stop later
```

To stop:

```bash
kill $(cat run.pid)
```

### 6. Run as a systemd service (recommended for permanent deployment)

Create `/etc/systemd/system/modes-meteo.service`:

```ini
[Unit]
Description=MODE-S Meteo System
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/mode-s-meteo
ExecStart=/usr/bin/python3 run.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable modes-meteo
sudo systemctl start modes-meteo
sudo systemctl status modes-meteo
```

---

## Web Interface

### Status indicator

The top navigation bar always shows the connection status:

- 🟢 **Live** — SSE stream active (Live page only)
- 🟢 **Online** — web API responding (Flights and Sounding pages)
- 🔴 **Reconnecting…** — connection lost, retrying automatically

The navbar also shows live aircraft counts: total aircraft visible and how many are currently providing meteo data.

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

#### Clicking an aircraft

Clicking an aircraft symbol or list entry:

1. **Enlarges the symbol** on the map for easy tracking
2. **Opens the detail strip** at the bottom of the screen showing all decoded values:
   - Altitude, ground speed, track, vertical rate
   - Wind speed and direction
   - Temperature, pressure, humidity
   - Turbulence level and Figure of Merit (FOM) if from MRAR
   - Meteo source badge
   - A 30-minute altitude and temperature history chart
3. **Overlays the aircraft position** on the Atmosphere Profile panel (right side) — see below

Click the **✕** button to deselect and close the detail strip.

#### Right panel — Atmosphere Profile

A permanently visible mini Skew-T Log-P diagram built from the same aggregated area data as the Sounding page and auto-refreshed every 2 minutes. The wider panel provides room for labelled wind barbs and wind history detail.

**Area sounding layer** (always visible):
- **Red line + dots** — measured temperature profile from all recent aircraft near the receiver, plotted on the skewed temperature axis
- **Dashed blue line** — ISA (International Standard Atmosphere) reference temperature at each pressure level
- **Wind barbs** — one barb per standard pressure level where wind data is available, labelled with direction and speed in the format **248° 24kt** (FROM direction, meteorological convention)

**Wind history density slider** — the slider below the canvas controls how densely the aircraft's wind history barbs are drawn. Each step equals a 400 ft minimum altitude gap between consecutive barbs:
- Position **1** (leftmost) — show a barb for nearly every 400 ft increment (dense, full detail)
- Position **8** (rightmost) — show barbs only every 3 200 ft (coarse, avoids overlap at high sample rates)
- Default is **2** (800 ft gap). The setting persists across browser sessions.

**Aircraft overlay** (visible when an aircraft is selected):

When you click an aircraft the panel overlays its data in the aircraft's own colour (matching the map symbol colour):

- **Wind barbs** — drawn in the aircraft's colour for each accumulated altitude observation; older history barbs are shown at 40% opacity to distinguish them from the current reading. Each barb is labelled with direction and speed.
- **Temperature dots** — plotted at the correct skewed-temperature position for each altitude observation.
- **Level indicator** — a dashed horizontal line spanning the full width of the diagram (plot area and barb column) showing the aircraft's current pressure/altitude level. When temperature data is available a white-ringed coloured dot marks the exact point on the temperature curve; when only wind data is available a small diamond appears on the pressure axis instead.
- **Accumulated wind history** — as an aircraft climbs or descends the panel builds up a full vertical wind profile from the observations received during the session. A new point is added whenever the aircraft changes altitude by at least 400 ft, so level cruise does not flood the history with identical readings. Up to 80 observations are kept per aircraft.

The label below the canvas shows the selected aircraft's callsign, current altitude, and temperature. Closing the detail strip (✕) clears the overlay and returns to the area sounding view.

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

Skew-T style atmospheric sounding diagrams. Two modes are available, toggled by the buttons at the top.

#### 📡 Area Average mode

Aggregates all meteo observations recorded within `SOUNDING_RADIUS_KM` of the receiver over the past `SOUNDING_WINDOW_MIN` minutes. Observations are binned into standard pressure levels (1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100 hPa) and wind vectors are averaged correctly as U/V components before converting back to speed and direction.

This mode auto-refreshes every 2 minutes. Click **↻ Refresh** to update manually.

The status line shows the number of observations used and the generation time (UTC).

#### ✈️ Flight Profile mode

Builds a vertical profile from a single flight's observations. Observations are binned into 2 000 ft altitude bands. This works best for climbing departures or descending arrivals where the aircraft samples many different altitude layers.

Select a flight from the dropdown (populated with all flights that have meteo data and an altitude range > 5 000 ft, most recent first), then click **Load Sounding**.

The flight info banner below the controls shows callsign, ICAO24, time range, altitude range, and observation count.

You can also reach a specific flight's sounding directly from the Flights page via the 🌡 Sounding button, which opens this page in Flight Profile mode with that flight pre-selected.

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
mode-s-meteo/
├── config.py                  # All configuration settings
├── run.py                     # Main entry point
├── database/
│   ├── db.py                  # SQLite connection management
│   └── schema.sql             # Database schema
├── collector/
│   ├── receiver.py            # Beast TCP connection + EHS decoder
│   ├── radarcape_json.py      # Radarcape JSON/MLAT poller
│   ├── wind_calc.py           # BDS 5,0 + 6,0 computed wind
│   └── filter.py              # Observation quality filters
├── web/
│   ├── app.py                 # Flask app + all API routes
│   ├── api/
│   │   └── sounding.py        # Sounding aggregation logic
│   └── templates/
│       ├── base.html          # Navbar, status indicator
│       ├── live.html          # Live map page
│       ├── flights.html       # Flights browser page
│       └── sounding.html      # Skew-T sounding page
├── static/
│   ├── css/style.css          # Dark theme stylesheet
│   └── js/
│       ├── live_map.js        # Live map, ATC display, mini sounding
│       └── sounding.js        # Skew-T canvas renderer
├── data/                      # SQLite database (created at runtime)
├── logs/                      # Log files (created at runtime)
└── pyModeS-main/              # Reference copy of pyModeS library
```

---

## API Endpoints

The web server exposes a REST JSON API used by the frontend. All endpoints require HTTP Basic Auth.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/live/state` | Snapshot of all currently visible aircraft |
| GET | `/api/live/stream` | Server-Sent Events stream (3-second updates) |
| GET | `/api/live/aircraft/<icao>` | Last 30 minutes of observations for one aircraft |
| GET | `/api/flights` | Paginated flight list (params: `page`, `per`, `icao`, `callsign`, `meteo`) |
| GET | `/api/flights/<id>` | Full observation track for one historical flight |
| GET | `/api/flights/<id>/sounding` | Per-flight Skew-T sounding profile |
| GET | `/api/flights/suitable_soundings` | Flights eligible for per-flight sounding |
| GET | `/api/sounding` | Area-average sounding from recent observations |
| GET | `/api/stats` | Summary counters for the navbar |

---

## Acknowledgements

- **[pyModeS](https://github.com/junzis/pyModeS)** by Junzi Sun — the foundational MODE-S / ADS-B decoding library this project is built on
- **[Leaflet](https://leafletjs.com/)** — interactive maps
- **[Chart.js](https://www.chartjs.org/)** — time-series charts
- **[CartoDB](https://carto.com/)** — dark map tiles
- **Jetvision Radarcape** — hardware receiver providing Beast binary output and MLAT positions

---

## Contributing

This project is in active development. Contributions, issue reports and pull requests are welcome.

Some areas where contributions would be valuable:

- Systemd service hardening and auto-restart configuration
- Export of sounding data to standard formats (e.g. University of Wyoming format)
- Additional meteo BDS register support
- Unit tests for the collector and wind calculation modules
- Support for other Beast-compatible receivers (dump1090, readsb)

---

## License

MIT License — see [LICENSE](LICENSE) for details.
