# Changelog

All notable changes to MODE-S Wind are recorded here, newest first.
No version numbers — entries are organised by date.

---

## 2026-05-20 (continued)

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
