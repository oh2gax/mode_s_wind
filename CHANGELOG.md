# Changelog

All notable changes to MODE-S Wind are recorded here, newest first.
No version numbers — entries are organised by date.

---

## 2026-05-28 (Windshear — METAR staleness indicator + Windrose timestamps)

- **METAR staleness colour** — the METAR text in the weather strip changes colour based on how old the issued observation is: **orange** when ≥ 60 minutes old, **red** when ≥ 90 minutes old, normal colour when fresh; age is measured from the `DDHHMM Z` issue time parsed directly from the raw METAR string (e.g. `281550Z`), not from the browser's last fetch time, so the indicator correctly reflects the actual age of the meteorological observation
- **Colour transitions are timely** — `checkMetarAge()` is called both immediately after every `fetchWx()` and independently every minute via `setInterval`; this ensures the colour changes at the correct wall-clock moment even when no new METAR arrives between the 10-minute fetch cycles
- **Windrose canvas timestamps** — the top-right corner of the Wind Rose canvas now shows UTC HH:MM issue/observation times alongside the existing top-left source labels: cyan `HH:MM` for the METAR issue time, green `HH:MM` for the timestamp of the most recent MODE-S observation currently in the 30-minute rolling buffer; `--:--` is shown when no data is available; same font and colour as the left-side dot labels so the pair reads as a natural key

---

## 2026-05-28 (Windshear — Windrose auto-update fix)

- **Windrose server buffer now re-fetched every 60 seconds** — previously `fetchWindroseObs()` was called only once on page load, so approaches that landed mid-session were never reflected in the Windrose until the user refreshed the whole page; a new `setInterval(fetchWindroseObs, 60_000)` ensures the browser re-syncs with the server's rolling 30-minute observation buffer within one minute of any new landing
- **Deduplication via `windroseServerTsSeen` set** — each server observation is keyed by its Unix-ms timestamp; re-fetches skip already-ingested entries so observations are never double-counted in the vector average; stale keys are pruned from the set in sync with the 30-minute rolling window
- **Toggle (open) also triggers an immediate re-fetch** — the Windrose panel toggle handler now calls `fetchWindroseObs()` before `drawWindrose()` when opening the panel; this explains the user-observed behaviour where toggling always showed fresh data (it now does so explicitly rather than by coincidence) and ensures the panel is always maximally current on open
- **Root cause**: after the GPS position-freeze gate was added (2026-05-28), approaches with frozen ADS-B positions produced no windrose observations on either the server path (gate blocks `_windrose_obs` accumulation) or the JS harvest path (`meteo_source === 'NONE'` filter); the page-load-only `fetchWindroseObs()` could not pick up data from aircraft that staled out after page load; the periodic re-fetch closes this gap by polling the server buffer where any pre-freeze valid observations are still stored

---

## 2026-05-28 (Windshear — Approach History crosswind component + layout tidy)

- **Crosswind component added to Approach History** — the altitude-band column display now supports four modes selectable from a new inline dropdown in the control row: **Wind** (raw `dir°/spd kt`), **HW** (headwind component, default), **XW** (crosswind component), and **HW+XW** (both components stacked in a two-line cell with a hairline separator)
- **Crosswind display convention** — XW shows the magnitude in knots with a directional arrow: `←` means the crosswind is coming **from the left** of the aircraft on approach; `→` means from the **right**; the number is the crosswind component magnitude. Example: `←17` on RWY 04L with wind from 310° means 17 kt crosswind from the left — the aircraft drifts right and must crab left to maintain centreline. The arrow always indicates the **source side** of the wind, not the direction it is blowing across the runway. Colour coding: green (< 5 kt, light), amber (5–9 kt, moderate), red (≥ 10 kt, strong)
- **HW+XW two-line cell** — Option A layout: headwind component on the top line, crosswind on the bottom line, separated by a thin hairline rule; both values are colour-coded independently; the cell height increases slightly in this mode to accommodate both values cleanly
- **Crosswind formula** — `XW = wind_speed × sin(wind_dir − runway_heading)`; positive = from right, negative = from left; computed client-side from the existing `{dir, spd}` band data and `rwy_heading` already present in every Approach History record — no backend changes required
- **Control row layout tidy** — the mode dropdown and Lo/Hi button moved from the header row into the time-filter row, placed after the Live button with a thin separator; the panel header now contains only the title, saving one row of vertical space and keeping all interactive controls together on one line
- **Lo and Hi display bands lowered to 600 ft** — the 600 ft band added to both Lo (now 8 columns: 600 / 800 / 1 000 / 1 400 / 1 800 / 2 200 / 2 600 / 3 000 ft) and Hi (now 13 columns: 600–3 000 ft at 200 ft steps, dropping the 200 and 400 ft columns that currently yield no data at EFHK); the server continues to capture all 15 bands down to 200 ft in the DB so the 200 and 400 ft columns can be re-enabled in JS at any time without a backend change

---

## 2026-05-28 (Windshear — GPS position-freeze gate for Approach History and Windrose)

- **Position-freeze gate** added to `collector/windshear.py` — protects the Approach History altitude-band capture and the Windrose low-altitude observation buffer from wind data computed while an aircraft's ADS-B position is frozen by GPS jamming
- **How it works**: a new `_pos_track` dict (keyed by ICAO) records the most recent `{dist_thr, alt}` for every in-corridor aircraft on every sweep, regardless of meteo quality; before writing a band or a Windrose observation, the gate checks whether altitude has dropped more than `BAND_TOL_FT` (100 ft) since the previous sweep while `dist_thr` has not advanced by at least `POS_FREEZE_MIN_NM` (0.05 NM) — the characteristic signature of a frozen GPS position descending through the glideslope; if true, `pos_frozen = True` and the write is skipped, leaving the affected bands as `None` (displayed as `—`) rather than filling them with partially stale wind
- **Why 0.05 NM**: on a 3° glideslope a 100 ft altitude drop corresponds to ~0.31 NM of forward movement; 0.05 NM is well below normal aircraft advance speed, so the gate only fires when there is genuinely zero position change over a meaningful altitude descent; it does not fire during normal GPS update jitter or brief position-message gaps
- **NONE-gap robustness**: `_pos_track` is updated on every in-corridor sweep — even during `meteo_source = NONE` periods — so the tracker does not false-fire when EHS wind data recovers after a legitimate meteo gap; the position history stays current through NONE windows
- **Windrose also protected**: the same `pos_frozen` flag gates the Windrose per-aircraft accumulation loop, preventing stale-groundspeed wind from entering the rolling buffer and corrupting the Windrose average
- **No effect on normal operations**: the gate never fires for aircraft with functioning GPS; all band captures and Windrose observations for unjammed approaches are identical to before; `POS_FREEZE_MIN_NM` constant added to the approach history constants section
- **Cleanup**: `_pos_track` entries are removed in all the same places as `_band_winds` — blocked registration early return, distance/altitude gate early return, aircraft leaves corridor while APPROACHING, and `prune_stale()` — preventing any memory leak for long-tracked aircraft

---

## 2026-05-27 (Windshear — Approach History dynamic panel height + date query)

- **Dynamic Approach History panel height** — the Approach History overlay now stretches automatically with the map container instead of being clipped to a fixed 264 px maximum; the panel is anchored top (`90px`) and bottom (`8px`) inside the positioned `.ws-map-wrap` container and uses a flex-column layout so the scrollable table fills all remaining space; on a 1080p display the visible table area roughly doubles, and on higher resolutions it grows proportionally; no layout or backend changes were required — only `static/css/style.css` was modified
- **Approach History custom date query** — a date picker control is added to the right of the `1d` time-filter button; it consists of a `dd.mm.yyyy` text field, a calendar (📅) icon button, and a `Live` button; entering a date or picking one from the calendar switches the panel into **date mode**: the panel loads all approaches for that full UTC day from the DB (`GET /api/windshear/approach-history?date=YYYY-MM-DD`), the five time-window buttons are dimmed, and the `Live` button becomes highlighted; clicking `Live` or any time-window button exits date mode and resumes live rolling-window queries; the `Live` button is highlighted (blue) in live mode and muted in date mode, so the active mode is always unambiguous
- **Locale-independent `dd.mm.yyyy` input** — the date field is a plain `<input type="text">` with a JS input mask that auto-inserts dots and accepts digits only, ensuring the `dd.mm.yyyy` format is displayed consistently regardless of the user's OS locale (e.g. Finnish Windows shows `pp.kk.vvvv` with a native `<input type="date">`); the hidden `<input type="date">` behind the 📅 button is never visible — it serves only as a calendar UI trigger via `showPicker()`; the text field additionally accepts typed input directly for keyboard users
- **New backend query parameter** — `GET /api/windshear/approach-history?date=YYYY-MM-DD` added to `web/app.py`; queries `WHERE date_utc = ?` on the indexed `date_utc` column; returns all approaches for that calendar day, newest first; the existing `?window=<seconds>` parameter is unchanged; a loose format check (`\d{4}-\d{2}-\d{2}`) rejects malformed inputs with HTTP 400

---

## 2026-05-26 (Windshear — Approach History DB persistence + time filter)

- **Approach History is now persisted to SQLite** — a new `approach_history` table stores one row per completed landing approach; data survives server restarts and accumulates indefinitely, making multi-hour and full-day queries practical
- **New DB table schema**: `ts` (Unix epoch), `date_utc` (YYYY-MM-DD), `time_utc` (HH:MM), `icao`, `callsign`, `registration`, `aircraft_type`, `runway`, `rwy_heading`, `bands_json` (JSON object keyed by altitude ft); three indexes on `ts`, `date_utc`, and `runway` for fast filtering; data volume is under 1 MB/year at EFHK approach rates
- **Callback hook** — `WindshearTracker` accepts an optional `on_approach_committed` callable; called from the windshear sweep thread immediately when an APPROACHING aircraft goes stale; the callback (`_on_approach_committed` in `run.py`) writes to the DB using the sweep thread's own thread-local connection — `WindshearTracker` remains DB-free; a `"ts"` Unix timestamp field is now included in every approach record
- **Startup preload** — `_preload_approach_history()` in `run.py` queries the last 24 h of DB records and calls `ws_tracker.preload_approach_history()` before the sweep thread starts; the RAM approach history list is immediately populated on server restart rather than waiting for the first landing
- **RAM cap increased** from 25 → **500 entries** to cover ~24 h of typical EFHK approach traffic in memory
- **Time filter UI** — a row of five compact buttons (`1h · 3h · 6h · 12h · 1d`) appears between the panel title row and the table; the active window is highlighted in blue; default is **3 h**; switching window immediately refetches from DB via `GET /api/windshear/approach-history?window=<seconds>`
- **API updated**: `GET /api/windshear/approach-history?window=N` now queries the DB directly for the requested time window; without the `window` param the RAM list is returned (backward compat); `POST /api/windshear/approach-history/clear` now deletes all rows from the DB table in addition to clearing the RAM list so the panel stays empty after a page refresh
- **Smart UTC timestamp display** — the UTC column shows plain `HH:MM` for approaches from today; approaches from a previous UTC date show `D.M HH:MM` (e.g. `26.5 14:32`) so multi-day views in the 6h/12h/1d windows are unambiguous; computed client-side from the `ts` Unix timestamp already present in every record, no backend change required
- **Clear button removed** — with DB persistence the Clear button would permanently delete historical data; it has been removed from the panel; the time filter already controls what is visible and data naturally ages out of each window

---

## 2026-05-26 (Windshear — Approach History 200 ft resolution + Windrose server-side buffer)

- **Approach History resolution increased to 200 ft** — `APPROACH_HISTORY_BANDS` in `collector/windshear.py` expanded from 5 bands (1 000–3 000 ft at 500 ft spacing) to **15 bands at 200 ft spacing** (200, 400, 600 … 3 000 ft); `BAND_TOL_FT` tightened from ±150 ft to **±100 ft** so bands at 200 ft resolution do not overlap
- **Approach History Hi/Lo column toggle** — a new **Lo/Hi** button in the Approach History panel header switches between two views of the same server-side data: *Lo* shows 6 columns at 400 ft steps (1 000 / 1 400 / 1 800 / 2 200 / 2 600 / 3 000 ft) aligned to the 200 ft server grid so every column is guaranteed to have data; *Hi* shows all 15 columns (200–3 000 ft at 200 ft steps) and the panel expands to `width: max-content` (`.ws-aphist-hi` CSS modifier class) so all columns are visible without horizontal scrolling, using the map area beneath; the table `<thead>` is now dynamically generated by JS to match the active band selection, and band cells in body rows are also rendered dynamically so no static column count is hardcoded in the HTML
- **Lo band alignment fix** — the original Lo bands (1 000 / 1 500 / 2 000 / 2 500 / 3 000 ft) were not present in the new 200 ft server grid, causing 1 500 ft and 2 500 ft columns to always show `—`; Lo is now `[800, 1000, 1400, 1800, 2200, 2600, 3000]` (7 columns, every other band from the 200 ft grid starting at 800 ft) so all columns reflect real captured data; the 800 ft band gives visibility into the lowest part of the approach where wind shear is most operationally significant — *subsequently updated: 600 ft added to Lo and Hi bottom; see 2026-05-28 entry*
- **Server-side Windrose rolling buffer** — `WindshearTracker` now accumulates per-aircraft low-altitude wind observations in a `_windrose_obs` dict during `sweep()`, using identical gate thresholds to the client-side JS Lo buffer (400 ft altitude gap OR 0.5 NM distance gap, 40-entry cap per aircraft, only in-corridor/non-NONE/alt ≤ 2 000 ft observations); when a landing aircraft goes stale (APPROACHING → silent), its observations are harvested into a global `_windrose_buffer` list with wall-clock timestamps; entries older than 30 minutes are pruned both at harvest time and on `get_windrose_obs()` calls
- **New Flask route** `GET /api/windshear/windrose-obs` returns the rolling buffer as a JSON list of `{ts, dir, spd, alt}` dicts
- **Browser pre-population on page load** — `fetchWindroseObs()` in `windshear.js` is called once on page open; observations from the last 30 minutes are injected directly into `recentLandingWinds` (JS uses ms timestamps, server sends Unix seconds — converted on the client); the windrose is immediately meaningful in a freshly opened browser window after a busy approach sequence rather than starting empty

---

## 2026-05-26 (Windshear — RWY 33 corridor false-detection filters)

- **Glideslope floor gate** added to corridor detection in `collector/windshear.py`: after `_best_runway()` matches an aircraft to a runway, the match is discarded if the aircraft is more than `CORRIDOR_GS_FLOOR_FT` (1 000 ft) below the theoretical 3° glidepath at its current distance from the threshold; this is the primary filter for traffic overflying the RWY 33 approach area at 12–15 NM while being vectored to RWY 22L/22R — at those distances such traffic is typically 1 000–2 500 ft below the glidepath and would otherwise pass all geometric and heading gates; legitimate approaches always clear this gate with at least 200 ft margin
- **Per-runway heading gate** — `_best_runway()` now reads an optional `max_track_dev` field from the runway definition, falling back to the global `CORRIDOR_MAX_TRACK_DEV_DEG` (60°) when absent; RWY 33 is set to **45°** (vs the default 60°) because aircraft vectored northward to RWY 22 from the south typically fly heading ~010°–020°, which is 47°–57° from RWY 33's approach heading of 323° — these headings pass the 60° gate but are correctly rejected by the 45° gate; all five ILS runways retain the existing 60° gate via the fallback
- The two filters are complementary: distant overflights (12–15 NM at 2 000–3 000 ft) are caught by the glideslope floor regardless of heading; mid-range cases (8–10 NM, ~010° heading) are caught by the tighter heading gate even when altitude slips above the floor; GPS-jammed frozen-position scenarios where track is unavailable are partially mitigated by the floor gate alone (track check is skipped when `track is None`, existing behaviour preserved)
- No change to ILS runway behaviour — the glideslope floor applies to all runways but has no practical effect on aircraft correctly established on approach; the per-runway heading gate applies only to RWY 33

---

## 2026-05-26 (Windshear — NONE position markers on ILS glideslope canvas)

- When the barb layer is active and an aircraft is selected, the ILS glideslope canvas now draws **grey hollow circles** (3 px radius, `#6b7280` stroke) at every position where wind computation was suspended (`meteo_source === 'NONE'`); circles appear alongside the coloured wind barbs from valid periods, or alone when the entire approach has been in NONE state
- A new `wsNoneHistory` per-aircraft buffer accumulates these position-only observations during the poll cycle; entries are stored whenever the aircraft is in the ILS corridor, `meteo_source === 'NONE'`, and valid `dist_thr_nm` + `altitude` are present; the same 400 ft / 0.5 NM gate and 40-entry cap as the Lo wind buffer are applied to keep marker density consistent
- When no valid wind history exists yet but NONE-position entries are already accumulated, the canvas hint text changes from `Waiting for wind data…` to `Waiting for wind data…  (N pos-only)` so it is immediately clear that position data is arriving even though wind decoding has not started
- The feature is useful for **GPS-jamming situational awareness**: a trail of hollow circles through the glideslope profile confirms that ADS-B position messages (BDS 0,5/0,6) are being received normally during a grey phase, even while wind computation (BDS 5,0/6,0) is suspended; the absence of circles would indicate a genuine position data gap rather than just a meteo quality issue
- No change to any windshear detection algorithm, Windrose, Approach History, or flight strip rendering — `wsNoneHistory` is consumed only by the ILS canvas draw path and has no effect on any alert or analysis logic

---

## 2026-05-26 (Windshear — wind data quality gates for barb display, Windrose and Approach History)

- **Per-barb quality colouring on the ILS glideslope canvas** — each wind barb now carries the `meteo_source` tag from the moment it was captured; barbs recorded during a grey (NONE) period remain grey permanently even after the aircraft's data recovers, instead of being retroactively recoloured green; this makes the canvas an honest record of data quality throughout the approach rather than reflecting only the aircraft's current state
- **NONE-period entries excluded from wind history buffers** — both the Lo and Hi accumulation loops now skip any poll where `meteo_source === 'NONE'`; stale non-null `best_wind_spd` values that linger in `live_state` from a previous good computation can no longer enter `wsWindHistory` or `wsWindHiHistory` during a grey phase; a gap appears on the canvas where data was absent, rather than a repeated stale position
- **Windrose no longer receives grey-period observations** — the Windrose harvests low-altitude wind from `wsWindHistory` when an aircraft leaves the tracked set; because NONE entries are now excluded from that buffer at accumulation time, they cannot flow into the Windrose rolling average
- **Approach History band capture excludes NONE-period data** — the Python-side band capture gate (`collector/windshear.py`) skips any sweep where `meteo_source == "NONE"`, preventing stale wind values that persist in `live_state` from being locked into the altitude-band history record for a landing approach
- Root cause of all four fixes: the `live_state` merge in `receiver.py` is non-destructive — new observations only overwrite existing fields with non-`None` values; when a wind computation is discarded (result > 150 kt, quality gate failure, or insufficient BDS data), `best_wind_spd` retains its previous value while `meteo_source` correctly updates to `"NONE"`; the fixes use `meteo_source` as the authoritative quality signal at every consumer

---

## 2026-05-25 (Windshear — Approach History panel)

- Added a new **Approach History** floating overlay panel on the Windshear page, toggled by the **Apch Hist** button in the map controls bar
- The panel shows a scrollable table of recently landed aircraft (newest first, up to 25 entries) with columns: **UTC time**, **Callsign**, **Registration**, **Type**, **Runway**, and wind at **1000 / 1500 / 2000 / 2500 / 3000 ft**; Registration and Type show `—` when not available
- Data is accumulated in RAM only while the page is running; it clears on server restart or when the **Clear** button is pressed
- A **Wind / HW** toggle button switches the five altitude columns between raw wind display (`270°/15`) and headwind component (`+12` / `-5` kt); headwind positive = into the aircraft, colour-coded green / red / amber for immediate situational awareness
- **Landing detection**: when an aircraft that was established on approach (APPROACHING state) goes ADS-B-silent — typically at 200–400 ft on final where receiver line-of-sight is lost — the 30-second stale timeout fires and the record is committed; the UTC timestamp reflects this moment, which closely approximates actual touchdown; aircraft that go around (GO_AROUND state) are automatically excluded
- **Band capture**: as each approach aircraft descends through the corridor, the first wind reading within ±150 ft of each target altitude is recorded; once a band is captured it is locked (highest-altitude reading wins); bands with no wind data (aircraft not BDS 6,0 equipped or meteo not decoded at that level) show `—`
- No effect on any existing windshear detection, barb display, go-around detector, or map calculations — the history list is a passive accumulator fed entirely by existing live_state data
- Backend: `WindshearTracker` gains `_approach_history` list and `_band_winds` per-aircraft dict; two new Flask routes `GET /api/windshear/approach-history` and `POST /api/windshear/approach-history/clear`

---

## 2026-05-25 (Windshear — RWY 33 RNP approach support)

- Added **RWY 33** to the windshear approach tracker and runway selector — aircraft established on the RNP approach to RWY 33 are now tracked, displayed on the ILS glideslope canvas, and shown in flight strips exactly like the five ILS runways
- RWY 33 uses a standard **3.00° vertical path angle** (identical to the ILS glidepaths); no special glideslope logic was required — the existing `GS_FT_PER_NM = 318.5` calculation applies without modification
- Threshold coordinates updated to exact AIP values from FINTRAFFIC ANS EFHK ADC (AD 2.4-1, 16 APR 2026) for all six runways; RWY 33 threshold: `60.3071°N, 24.9883°E`, approach heading 323°
- **Per-runway threshold elevation** — `thr_elevation_ft` added as a field in each runway dict; the global `WINDSHEAR_THR_ELEVATION_FT` config value is now a fallback only; RWY 33 is anchored at **148 ft MSL** (vs ~179 ft for the other EFHK runways), ensuring the glideslope reference line is correctly positioned for each runway independently; the `gs_status()` call now resolves the elevation from the matched runway rather than the global setting
- **RWY 33 approach centreline added to the Windshear map** — three GeoJSON line segments in `overlays/efhk_ils.geojson` extend the RNP final approach track from the threshold outbound to 25 NM; styled in amber (`#f59e0b`) with a longer dash pattern (`10 5`) so the RNP line is visually distinct from the ILS centrelines (blue `#38bdf8`, short dash `6 5`); the Leaflet style callback routes on the `approach_type: "RNP"` property
- Centreline bearing uses the **true geographic runway axis (153.1°T outbound)** derived from the published approach chart value of 333.1°T for the inbound track — not the magnetic heading (323°) and not the uncorrected magnetic reciprocal (143°); using the correct true bearing eliminates the ~10° angular error (≈4.4 NM lateral offset at 25 NM) that would result from directly reversing the magnetic approach heading

---

## 2026-05-24 (System-wide registration blocklist — helicopter filter)

- Added **`BLOCKED_REG_PREFIXES`** to `config.py` — a tuple of registration prefixes that are silently dropped system-wide, complementing the existing `BLOCKED_ICAO_PREFIXES` ICAO24 filter
- Default entry: `("OH-H",)` — covers Finnish helicopters whose continuous manoeuvring near EFHK (especially around RWY 33) produces unreliable BDS 5,0/6,0 computed wind and false meteo observations
- New helper `is_blocked_registration()` added to `collector/filter.py`; applied at both live_state entry points:
  - **JSON/MLAT poller** (`radarcape_json.py`) — drops the aircraft and removes any existing live_state entry as soon as the registration is known from the JSON feed; this is the primary filter path since registration is only available from the Radarcape JSON endpoint
  - **Beast TCP receiver** (`receiver.py`) — after the live_state merge, removes the aircraft and skips the DB write if the registration (previously populated by the JSON poller) matches a blocked prefix; provides belt-and-suspenders coverage for the window between first Beast message and first JSON poll
- `WindshearTracker` hardcoded `OH-H` string replaced with the config-driven `blocked_reg_prefixes` parameter — the tracker now uses `is_blocked_registration()` for consistency; `run.py` wires `cfg.BLOCKED_REG_PREFIXES` into the constructor
- Adding further registration prefixes to the tuple in `config.py` requires no code changes

---

## 2026-05-24 (System-wide WAM ground station filter)

- Added **ICAO24 prefix blocklist** (`BLOCKED_ICAO_PREFIXES` in `config.py`) — any ICAO24 address whose prefix matches an entry in the list is silently dropped at both live\_state entry points before it can affect any subsystem
- Default blocklist: `("T40",)` — covers Finnish Air Navigation Services **Wide Area Multilateration (WAM)** ground interrogator stations whose ICAO24 codes begin with `T40`; these fixed infrastructure nodes produce valid Mode-S replies but are not aircraft and previously inflated the GPS quality "total aircraft seen" count and could trigger spurious Gap events
- New helper `is_blocked_icao()` added to `collector/filter.py`; called in both `collector/receiver.py` (Beast TCP feed) and `collector/radarcape_json.py` (JSON/MLAT poller) immediately after ICAO extraction — no blocked address can enter live\_state through either path
- Comparison is case-insensitive; additional prefixes can be added to the tuple as needed without code changes

---

## 2026-05-24 (Go-around detector — minimum altitude gain check)

- Added a second AND condition to the go-around confirmation: the aircraft must have gained at least **50 ft of actual pressure altitude** since the climb started (`WINDSHEAR_GA_MIN_ALT_GAIN_FT`, default 50 ft)
- Guards against barometric lag and vert_rate quantization noise where the reported climb rate is high for multiple polls but the aircraft's actual altitude barely changes — both the poll counter and the altitude gain check must pass simultaneously before a go-around fires
- `ga_climb_start_alt` is recorded on the first climbing poll and cleared on reset; the log line now includes the measured altitude gain for easier post-event review

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
