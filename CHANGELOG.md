# Changelog

All notable changes to MODE-S Wind are recorded here, newest first.
No version numbers — entries are organised by date.

---

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
