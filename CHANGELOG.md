# Changelog

All notable changes to MODE-S Wind are recorded here, newest first.
No version numbers — entries are organised by date.

---

## 2026-05-24 (Go-around detector — sustained climb gate)

- Fixed **false go-around detections in gusty / turbulent conditions** — the APPROACHING → GO_AROUND transition previously fired on a single poll where vertical rate ≥ 600 fpm; a momentary updraft or gust-induced vert_rate spike was enough to trigger a false event
- Added a **sustained climb gate** (`WINDSHEAR_GA_MIN_CLIMB_POLLS`, default 3): the detector now requires 3 consecutive 3-second poll cycles all reporting vert_rate ≥ 600 fpm before declaring a go-around — equivalent to 9 seconds of sustained climbing and a minimum altitude gain of ~90 ft
- The climb counter resets to zero on any poll that falls below the climb threshold or above the altitude ceiling, so a transient spike during an otherwise normal approach cannot accumulate across poll gaps
- The corridor-exit handler also resets the climb counter alongside the existing descent counter reset
- New parameter `WINDSHEAR_GA_MIN_CLIMB_POLLS` added to `config.py` and wired through `run.py` — raise to 4 or 5 in particularly gusty environments; lower to 2 if go-arounds are being missed

---

## 2026-05-24 (Navigation bar — UTC clock)

- Added a **live UTC clock** to the right side of the navigation bar on all pages, immediately to the left of the Online / Live status indicator — displays the current date and time in `YYYY-MM-DD HH:MM:SS UTC` format, updated every second using the browser clock; uses a monospace font to prevent layout shift as digits change

---

## 2026-05-24 (Windshear ILS profile — Dcl label placement toggle)

- Added **Dcl button** to the ILS profile header, immediately to the right of the `HW` button — toggles a declutter label layout for wind barb annotations
- When **Dcl is on** and HW is active, labels are split to opposite sides of each barb: raw `dir°/spd` appears above the barb, signed headwind value (`+15kt`) appears below — the barb staff acts as a natural visual separator between the two labels, reducing overlap on dense approaches
- When **Dcl is off** (default), both labels remain on the same side (above the barb, flipping below near the top edge) — existing behaviour unchanged
- Edge cases: near the top of the canvas both labels stack below the barb (HW first); near the bottom both labels stack above the barb (HW closest to barb)
- Canvas corner label gains a `· DCL` tag when Dcl is active alongside HW
- Dcl button is greyed out when HW is off; turning HW off also resets Dcl to inactive; turning Barbs off resets both

---

## 2026-05-24 (Windshear ILS profile — Hi-resolution barb mode)

- Added **Hi-resolution barb mode** — a `Hi` segment inserted between `Barbs` and `Auto` in the split button group toggles the barb canvas between two independent wind observation buffers
- **Lo buffer** (unchanged, default): 400 ft / 0.5 NM accumulation gate, 40-observation cap — behaviour identical to before
- **Hi buffer** (new, research mode): 150 ft / 0.2 NM gate, 100-observation cap — approximately 3–4× denser; covers a full 15 NM approach with fine altitude resolution
- Both buffers accumulate in parallel every poll cycle regardless of which is selected — switching to Hi immediately shows the denser data already collected since page load
- The Hi buffer is **display-only** and is never read by any windshear detection algorithm; all six detection algorithms continue to use the Lo buffer exclusively, preserving existing detection behaviour
- `Hi` button turns **violet** when active; canvas corner label gains a `· HI` tag to confirm the mode
- `Hi` button is greyed out (pointer-events disabled) when Barbs are off; turning Barbs off also resets Hi to inactive
- Cleanup on aircraft departure (`delete wsWindHiHistory[icao]`) runs alongside the existing Lo buffer cleanup

---

## 2026-05-22 (Windshear panel — label rename)

- Renamed the **Windshear Log** panel title to **Windshear Alert** — better reflects that the alert level selector controls the banner and flight strip badges, while the log itself always records all severity levels regardless of the selected threshold

---

## 2026-05-22 (Windshear ILS profile — HW/TW barb annotation)

- Added **HW toggle button** to the ILS profile header, immediately to the right of the `Barbs · Auto` split button — annotates each wind barb on the glideslope canvas with the headwind/tailwind component for the matched runway
- When **HW is on**, each barb shows two lines: the signed headwind component as the primary label (e.g. `+15kt` or `−8kt`) colour-coded **green** (headwind > +5 kt), **red** (tailwind < −5 kt), or **amber** (near-zero ±5 kt); the raw `dir°/spd` is shown in smaller dimmer text on a second line below for reference
- When **HW is off** (default), existing behaviour is unchanged — only `248°/24kt` shown
- The runway heading used for the computation is sourced from the selected aircraft's `approach_runway` field (most precise); falls back to the runway filter dropdown value if the aircraft is no longer tracked; HW annotation is silently suppressed per-barb if no valid heading can be resolved
- The active runway reference is shown in the corner label (e.g. `· HW ref 04L (47°)`) so the reference heading is always visible
- The HW button is visually greyed out (pointer-events disabled) when Barbs are off; turning Barbs off also resets HW to inactive

---

## 2026-05-22 (GPS Quality per-signal flush fix)

- Fixed **per-signal counts not persisted on hour rollover** — `_current_bucket()` built a `flush_copy` dict that omitted `nacp_events`, `freeze_events`, and `gap_events`; `_flush_to_db` therefore always wrote zero for all three fields even though the in-memory bucket had the correct counts; the three fields are now included in `flush_copy`; this caused all completed-hour rows in the DB to show as the grey "Unknown" bar in the chart rather than the coloured NACp / Freeze / Gap stacked breakdown — hours flushed before this fix will remain as grey bars (the in-memory data is gone), but all new completed hours will persist correctly going forward

---

## 2026-05-22 (GPS Quality chart range selector)

- Added **time range selector** to the GPS Quality bar chart — five buttons (`1d` / `2d` / `3d` / `1w` / `1m`) in the chart panel header let the user choose how much history is displayed
- **1d / 2d / 3d** — hourly bars; 2d and 3d labels include the date prefix (`M/D`) at midnight boundaries so each day is clearly identified; `maxTicksLimit` is halved for 2d/3d to prevent label crowding
- **1w / 1m** — aggregate to daily bars with day-of-week labels; the Aircraft line shows the peak hourly aircraft count per day (more meaningful than a sum of hourly counts)
- Selected range is persisted in `localStorage` (`ms_gps_range`) and restored on page load
- Chart panel title updates dynamically to match the active range (e.g. "GPS Degradation Events — Last 7 Days")
- Extended `MAX_BUCKETS` in `gps_quality.py` from `7 × 24` to `31 × 24` to support month-long retention; `_load_from_db` cutoff extended to match
- `get_state()` now returns all available cleaned buckets in `time_series` (previously capped at 24 h); the 24 h cap is now applied frontend-side only for the `1d` range; summary stats (Events 24h, Aircraft affected 24h, Peak hour) remain computed server-side from the last 24 h and are unchanged

---

## 2026-05-21 (GPS Quality per-signal event breakdown)

- **Per-signal breakdown** added to hourly GPS quality buckets — each completed hour now records `nacp_events`, `freeze_events`, and `gap_events` separately in addition to the total `events` count
- **Stacked bar chart** — the 24-hour time-series chart now shows three stacked bars per hour: NACp (amber), Freeze (sky blue), Gap (violet); the total bar height still represents all events but the split immediately shows which signal type dominates
- **DB schema migration** — `database/db.py` `init_db()` applies `ALTER TABLE gps_quality_hours ADD COLUMN` for the three new columns on first startup; existing rows default to zero and continue loading correctly
- **Chart.js legend** replaces the old hardcoded HTML legend; the legend now auto-labels NACp / Freeze / Gap / Aircraft with matching colours

---

## 2026-05-20 (GPS Quality Gap detection fix)

- Fixed **Gap signal detection** — removed the `has_ehs` precondition (`alt is not None or gs is not None`) from the Gap check; since `update()` is only called for aircraft seen within the last 60 seconds in any Mode-S message, the aircraft being in the sweep is already proof it is transmitting; the old condition could silently suppress Gap events when GPS jamming also stopped ADS-B velocity messages (making `gs` None) and the aircraft happened to have no recent barometric altitude either; now any aircraft that previously had a GPS position but has not sent one for ≥ 45 s will be flagged regardless of which other Mode-S fields are present

## 2026-05-20 (GPS Quality altitude gate)

- Added **minimum altitude gate** for GPS degradation signal checks — aircraft below `GPS_MIN_ALT_FT` (default 1 000 ft / FL010) are counted as seen in the hourly bucket but are not checked for NACp / Freeze / Gap signals; prevents spurious Freeze events from landing aircraft that the receiver loses line-of-sight with at ~300–400 ft while their last-known groundspeed is still ~140 kt
- Gate applied in both `GpsQualityTracker.update()` and `rebuild_live()` so the live degraded table is also clean
- Added `GPS_MIN_ALT_FT: float = 500.0` to `config.py`
- Updated `run.py` to pass `cfg.GPS_MIN_ALT_FT` to `GpsQualityTracker`

## 2026-05-20 (GPS Quality heatmap FL bands)

- Split lowest FL band in GPS Quality heatmap from `000-050` into two bands: `000-030` (ground to 3 000 ft) and `030-050` (3 000–5 000 ft) — heatmap now has 8 rows instead of 7; gives better resolution in the critical approach and initial climb phase where low-level jamming effects are most operationally significant
- Change is backward-compatible with stored DB rows — historical buckets using the old `000-050` label will show 0 for the two new bands; new data is correctly bucketed from the next sweep onward

## 2026-05-20 (GPS Quality DB persistence)

- Added **`gps_quality_hours` SQLite table** — one row per completed UTC hour storing `ts`, `events`, `total` aircraft, `degraded` aircraft, and a JSON `fl_bands` object with per-FL-band event counts; `INSERT OR REPLACE` primary key on `ts` makes the write idempotent
- Added **`GpsQualityTracker._flush_to_db()`** — called automatically when the hour rolls over inside `_current_bucket()`; writes exactly 24 rows per day; a shallow copy of the completed bucket is passed so the lock is not held during disk I/O
- Added **`GpsQualityTracker._load_from_db()`** — called once in `__init__()` if `db_path` is provided; loads the last 7 days of completed hours from `gps_quality_hours` into `_buckets`, restoring the time-series chart and heatmap after a restart in ~0 seconds
- Updated `GpsQualityTracker.__init__()` to accept optional `db_path` parameter (defaults to `""`)
- Updated `run.py` to pass `cfg.DB_PATH` to `GpsQualityTracker`
- Updated `database/schema.sql` with `CREATE TABLE IF NOT EXISTS gps_quality_hours`; applied automatically by `init_db()` on first startup with this version

## 2026-05-20 (GPS Quality page)

- Added **GPS Quality monitoring page** (`/gps`) — area-wide GPS degradation monitor covering all tracked aircraft at all altitudes
- Added **NACp extraction** in `collector/receiver.py` — Navigation Accuracy Category decoded from TC=29 (Target State & Status) and TC=31 (Aircraft Operational Status) ADS-B messages; stored as `nac_p` in `live_state` and persists until next TC=29/31 is received
- Added **`collector/gps_quality.py`** — new `GpsQualityTracker` RAM tracker; detects three degradation signals: NACp ≤ 6 (accuracy degraded), position freeze (identical lat/lon across ≥3 sweeps while GS > 50 kt), and position gap (no ADS-B position for ≥45 s while EHS altitude/GS still arriving); all data in RAM, no DB writes
- Added **24-hour time-series chart** (Chart.js) — hourly event count (red bars) and aircraft count ÷10 (grey line) for the last 24 hours; shows whether events are clustered at specific times of day
- Added **7-day FL-band heatmap** (Canvas) — rows = 7 FL bands (FL000–FL300+), columns = days, cell colour = event intensity; reveals which altitude layers and which days had the most GPS degradation
- Added **live degraded aircraft table** — callsign, ICAO24, FL band, altitude, groundspeed, NACp value, and per-aircraft signal flags (NACp / Freeze / Gap) updated every 30 seconds
- Added **summary bar** with 24-hour event count, affected aircraft count, peak hour, and live degraded count
- Added **signal key panel** explaining detection thresholds and NACp scale for operational reference
- Added `GPS_NACP_THRESHOLD`, `GPS_FREEZE_POLLS`, `GPS_GAP_SEC`, `GPS_MIN_GS_KT`, `GPS_SWEEP_SEC` constants to `config.py`
- Added GPS Quality sweep thread in `run.py` (5-second interval, daemon)
- Added `/gps` page route and `/api/gps/state` endpoint in `web/app.py`
- Added GPS Quality nav link to `base.html`
- Full light/dark theme support — heatmap palette, chart colours, and flag badges all theme-aware

## 2026-05-20 (continued)

- Added **Kinematic F-factor gate** — a dedicated dropdown (`F: Off / F ≥0.05 / F ≥0.08 / F ≥0.10 / F ≥0.15`) in the windshear log header that sets a minimum F-factor threshold for Kinematic detections; events whose computed F-factor falls below the gate are suppressed before reaching the log, banner or strip badge; the control is automatically disabled when any other algorithm is active; preference is stored in `localStorage` as `ms_ws_kin_f_gate`, default Off; if the window is too short to compute a valid F-factor and the gate is active, the event is also suppressed
- Added **three-level windshear severity system** replacing the previous two-level moderate/severe scale — events are now classified as **Monitor** (≥10 kt, informational blue), **Warning** (≥15 kt, amber) or **Alarm** (≥25 kt, red); all six detection algorithms updated to use the new `wsSeverity()` helper and the lower 10 kt detection floor
- Added **user-selectable alert level** dropdown in the Windshear Log header (`Mon ≥10kt` / `Warn ≥15kt` / `Alarm ≥25kt`) — controls the minimum severity that triggers the alert banner and flight strip WS badge; the log always shows all three levels; preference is stored in `localStorage` as `ms_ws_alert_level`, default Warning
- Added **confidence gating** — all algorithms now require 2 consecutive poll cycles (≈6 seconds) detecting the same event before it is promoted to the log and banner; eliminates single-poll false positives; hit counters reset immediately when an event disappears, so genuine brief shear still fires on the 2nd confirmation
- Added **F-factor** display to Kinematic log entries — computed as `(Δ IAS−GS in m/s) / (window_secs × 9.81)`, displayed as `F=x.xx` in italic after the kt delta; F≥0.1 is operationally significant, F≥0.15 is severe; F-factor is stored in the event object as `f_factor`
- ILS profile canvas windshear zone bands now show three colours: blue (Monitor), amber (Warning), red (Alarm)
- Removed wind symbol (🌬) from the Barbs button label — button now reads plain `Barbs`, consistent with the Windrose button style; canvas hint text updated to match
- Fixed historical go-around events flooding the log for new users — added `wsSessionStart` timestamp gate in `addGaToWsLog()`; events that occurred before the current page load are silently skipped, so a fresh page open against a long-running server never surfaces days-old events
- Tightened go-around detection defaults to reduce false alarms — altitude ceiling lowered from 3 000 ft to **2 200 ft** (`WINDSHEAR_GA_MAX_ALT_FT`), minimum climb rate raised from 500 fpm to **600 fpm** (`WINDSHEAR_GA_CLIMB_FPM`); both values updated in `config.py` and `collector/windshear.py`

## 2026-05-20

- Added **Kinematic windshear detection algorithm** (Algorithm 6) — detects windshear by tracking the rate of change of the IAS − GS differential over a 45-second sliding window; at low altitude IAS ≈ TAS, so `IAS − GS` approximates the headwind component along the aircraft's track; a sudden change in this differential directly measures a headwind gain or loss without any wind direction decoding
- Kinematic requires only a single aircraft in the ILS corridor (no pair needed), uses raw BDS 6,0 IAS and ADS-B groundspeed, and is robust at low altitude where the IAS ≈ TAS approximation holds best
- Added `wsKinHistory` rolling buffer (30 entries, ~90 s) per corridor aircraft storing `{ias, gs, ts}` on each poll cycle when IAS is available; algorithm applies its own 45-second time filter on top
- Added crimson-rose badge colour for Kinematic log entries (`#4c0519` background, `#fda4af` text)
- Added `Kinematic` option to the algorithm selector dropdown in Windshear page; all five previous algorithms (Pair, Gradient, Energy, Rate, Baseline) unchanged

## 2026-05-19 (continued, 3)

- Added **global Light theme** — a blue-grey paper-toned palette (`#dde4ec` background) selectable on any page via a **Dark / Light** toggle button in the navbar; preference is stored in `localStorage` and applied before first paint so there is no flash on page load
- Light theme overrides all 9 CSS colour variables (covering ~200 references automatically) plus targeted overrides for the handful of hardcoded values: Leaflet map backgrounds, semi-transparent overlay panels (map-legend, map-controls, Wind Rose panel), Skew-T canvas background, and map aircraft callsign label text/shadow
- Live Map tile layer switches between CartoDB dark and light variants when the theme is toggled
- All canvas renderers (mini Skew-T on Live Map, full Skew-T on Sounding page, ILS glideslope profile and Wind Rose on Windshear page) use theme-aware colour palettes via a `canvasTheme()` helper that selects the correct colour set at draw time; `window.onThemeChange` is called on toggle so canvases redraw instantly without a page refresh
- Flight detail modal Chart.js charts use theme-aware grid and tick colours
- Dark theme is completely unchanged; all light-theme rules are additive and scoped under `[data-theme="light"]`

## 2026-05-19 (continued, 2)

- Added **ATC map theme** on the Windshear page — flat `#cfcfcf` radar-grey background with no tile imagery, ILS centreline in dark navy (`#1a3a6b`), button placed between Grey and Black in the map controls bar
- Added **overlay cycling** for the ATC and Black themes — clicking the active button again cycles through three overlay levels: ILS only → ILS + coastline (`efhk_coast.geojson`) → ILS + coastline + water polygons (`efhk_aqua.geojson`); button label updates to show current level (ATC / ATC+C / ATC+CA and Black / Black+C / Black+CA); each theme remembers its level independently

## 2026-05-19 (continued)

- Reduced Radarcape JSON poll interval from 5 s to 2 s — cuts worst-case callsign latency from ~8–10 s to ~5 s; typical latency from the JSON path halved

## 2026-05-19

- Fixed Windshear map labels staying frozen as ICAO24 — label text was only set on marker creation; update path now calls `setIcon` on the label marker each poll so callsign appears as soon as the server has it, without requiring a page reload
- Changed Wind Rose toggle button label from "🌹 Rose" to "Windrose" — no symbol, same active colour

## 2026-05-18 (continued, 3)

- Restructured Windshear page layout — flight strips now extend to the full bottom of the screen; METAR/TAF strip moved inside the right column so it aligns only under the map and ILS profile, not under the strips
- Fixed spurious empty gap between navbar and page content — ws-page had a redundant `margin-top: var(--navbar-h)` that doubled the offset already applied by the `main` container; replaced with `height: 100%`
- Fixed ILS profile canvas height regression caused by the layout change — `ws-map-wrap` flex-basis adjusted from `58%` to `calc(58% - 96px)` to compensate for the METAR strip now being inside the right column flex container
- Removed lightning bolt (⚡) symbols from the Windshear Log title, detection toggle button, log entries, and placeholder messages — detection toggle and log title remain visually distinct via amber colour and border styling
- Increased Wind Rose canvas font sizes — compass cardinal/intercardinal labels (12 px / 10 px), runway end numbers (11 px), METAR/MODE-S legend (10 px)

## 2026-05-18 (continued, 2)

- Moved windshear detection toggle and algorithm selector out of the left panel into the Windshear Log header — toggle and dropdown now sit inline in the log header bar (Windshear Log · [OFF] · [Pair ▼] · [Clear]); left panel now uses the full height exclusively for flight strips
- Changed algorithm selector from five compact pill buttons to a single dropdown (`<select>`) — less space, all five options (Pair, Gradient, Energy, Rate, Baseline) accessible from one control with full description in tooltip

## 2026-05-18 (continued)

- Added five selectable windshear detection algorithms replacing the single pairwise method — Pairwise (classic ICAO, ≥ 2 aircraft), Gradient (single-aircraft wind history dHW/dz), Energy (groundspeed + altitude proxy, GPWS-inspired), Rate (headwind change over recent observation window), Baseline (compare to vector-averaged recent landing wind); active algorithm selected via a compact button row below the detection toggle
- Added GS history buffer for the Energy algorithm — groundspeed + altitude + timestamp stored per corridor aircraft on every poll cycle; pruned when aircraft leave the tracker
- Added algorithm badge (coloured pill) to windshear log entries; updated log deduplication key to include algorithm so switching algo logs fresh events immediately
- Fixed alert banner and flight-strip WS badge for single-aircraft algorithms — previously only Pairwise-format events (cs_low / cs_high) were handled; now all five event shapes are supported
- Added per-algorithm accent colours for log badges (Pair = blue, Gradient = green, Energy = orange, Rate = purple, Baseline = teal)
- Updated README with detailed physics documentation for all five windshear detection algorithms and updated windshear event log section

## 2026-05-18

- Added Wind Rose widget on Windshear page — compass rose overlay on the map showing METAR surface wind (cyan arrow) vs. MODE-S derived wind (green arrow) from recently landed aircraft at ≤ 2 000 ft; wind rose is enabled by default via the `🌹 Rose` toggle button; MODE-S wind is vector-averaged from a 30-minute rolling buffer of low-altitude observations harvested when approach aircraft go stale; numeric readout below the compass shows direction/speed and observation count with age
- Fixed Wind Rose arrow convention and runway labels — arrows now point in the downwind direction (where the wind blows TO) so the arrowhead points toward the runway label that has a headwind; runway end labels corrected to match threshold convention (047° end = RWY 22, 227° end = RWY 04, 152° end = RWY 33, 332° end = RWY 15)
- Added Auto barb mode on ILS profile — `🌬 Barbs` button now has an `Auto` segment; when enabled, the system automatically selects the lowest aircraft on approach (smallest distance from threshold) and holds it until it goes stale, then hands off to the next arrival; manual strip click disables auto and pins the selected aircraft
- Added entry state gate in windshear tracker — new corridor entrants climbing faster than +200 fpm are rejected, filtering departing aircraft that briefly pass the ILS geometric gates near the threshold; existing tracked aircraft are fully exempt so go-around detection is unaffected
- Added Indicated Airspeed (IAS) field to Windshear flight strips — sourced from BDS 6,0 decoded data, shows `—` when not available
- Fixed near-ground stale indicator on ILS canvas not triggering — tracker was writing sweep time instead of actual receiver last-seen time to the state dict

## 2026-05-17

- Fixed go-around detector false triggers when aircraft join ILS glideslope from below — increased `WINDSHEAR_GA_MIN_DESCENT_POLLS` default from 5 to 8 (24 s confirmed descent required)
- Fixed Clear button in windshear log — cleared go-around entries no longer bounce back on the next poll cycle
- Fixed squawk codes not appearing on flight strips — squawk now decoded directly from Beast feed (DF5/DF21 Mode-A replies) in addition to Radarcape JSON feed
- Fixed windshear detection including aircraft not yet established on glideslope — detection now restricted to aircraft with GS status ON (within ±300 ft of corrected glideslope)
- Added near-ground stale indicator on ILS vertical profile — aircraft below 1 000 ft with no data received for 10 s are shown as a dimmed blue dot with label removed; normal tracker removal still applies at 30–45 s
- Increased METAR/TAF font size on both Live Map and Windshear pages; colour unified to match across both pages

## 2026-05-16

- Added squawk code badge on Windshear flight strips — grey pill for normal codes, red pill for emergency codes
- Added emergency squawk alarm banner for codes 7500 (HIJACK), 7600 (NORDO), 7700 (MAYDAY) with blinking strip label
- Added go-around detector — server-side state machine detects missed approaches and logs events to the windshear log panel
- Added 2nd APP / Nx APP return-approach badge on flight strips for aircraft on a subsequent approach
- Added wind barb overlay on ILS vertical profile canvas — per-aircraft selection by clicking flight strip, barb history accumulated during approach

## 2026-05-15

- Added track polyline on Live Map for selected aircraft — dashed line built from stored observation positions, colour-coded by meteo source
- Fixed GS badge showing HIGH for RWY 15 approaches — glideslope status now computed client-side with full QNH correction applied, matching the ILS canvas
- Live Map detail strip now always shows ICAO24 only for display stability

---

## May 2026 — Initial release

Project created. Core features: Beast binary TCP receiver, pyModeS EHS decoding (BDS 4,4 / 4,5 / 5,0 / 6,0), Radarcape JSON/MLAT feed integration, SQLite database, live map with ATC-style aircraft display, historical flights browser, Skew-T atmospheric sounding diagrams, gridded historical wind map, and Windshear approach monitoring page with ILS vertical profile and windshear detection algorithm.
