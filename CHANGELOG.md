# Changelog

All notable changes to MODE-S Wind are recorded here, newest first.
One version per day of development, named after the date: v.DDMMYYYY (e.g. v.22102026).
The newest heading (here or in `doc/whats_new.md`) gives the version in the web pages' top bar; short user-oriented
notes of the latest versions are in `doc/whats_new.md` (the **What's new** window).

---

## v.24102026 — 2026-10-24 (Windshear detection v2 on the server: headwind ramps and band change, WS advisory / WSA / MBA alerts, a windshear report for every landing and departure, band comparison on the wind vector across runways; the six browser algorithms retired; Weather page: 10 m wind and gusts; upper-level temperature correction and moisture offsets learnt from MEPS; MEPS column in the Sounding page Indices panel; Skew-T analysis of the MEPS or sonde profile with likely cloud layers; Windshear user guide and engine status line; ADS-B ground speed in the approach series; ILS-profile wind barbs collected on the server; post-front data check)

### Windshear detection v2

- **New detector** (`collector/shear.py`): headwind along the track from each raw BDS 5,0 reply as TAS − GS (no heading or wind vector), distance along the path from the integrated ground speed (immune to GNSS position freeze), 400 m running mean on a 100 m grid; headwind ramps of 400–4 000 m scaled to a 1-km equivalent ΔV·(1 km/L)^⅓ (HKO GLYGA style) with coverage, 5σ significance and short-ramp persistence gates, in the low-level zone (below 1 600 ft above the threshold or within 5 NM); horizontal F-factor over 1 km; band comparison of the aircraft's 200-ft band headwinds (≤ 1 800 ft MSL) with the median of the landings on the same runway direction in the previous 45 min (≥ 3)
- **Levels renamed** (LLWAS style): *WS advisory* `ADV` ≥ 10 kt · *Windshear alert* `WSA` ≥ 15 kt · *Microburst alert* `MBA` ≥ 30 kt loss (band change: advisory ≥ 10, WSA ≥ 15 kt) — replacing Monitor / Warning / Alarm
- **Live detection on the server** (`collector/windshear.py`): every aircraft on final is analysed whenever new replies arrive; an event becomes an alert after 2 consecutive analyses, stays active 10 min after last seen, escalations are logged again; alert log of the last 24 h (≤ 100) in RAM; `/api/windshear/state` returns `ws_events` and `ws_log`
- **Windshear report per landing**: stored in the new column `approach_history.shear_json` (about 0.35 kB; migration in `database/db.py`), returned as `shear` by the approach-history API and loaded with the RAM history; a one-off startup back-fill (`shear_backfill` thread in `run.py`) writes the report for older landings with stored raw replies, oldest first, in batches of 200
- **Windshear page** (`static/js/windshear.js`, `web/templates/windshear.html`, `static/css/style.css`): the detection engine, the OFF/ON toggle, the algorithm selector and the Kinematic F-factor gate removed; the page shows the server's alerts — new alert-level select (Banner off / ADV / WSA (default) / MBA), banner headings *MICROBURST ALERT* / *WINDSHEAR ALERT* / *WINDSHEAR ADVISORY*, strip badges `ADV` / `WSA` / `MBA`, the ILS-profile band over the alert's height range, server log merged with the go-around log (Clear hides the shown entries in this browser), **ⓘ v2** link to the legacy description
- **Approach History — new WS display mode**: Level, Loss, Gain (1-km equivalents), F 1 km, Band Δ, Low, n (with noise); hover shows the whole report
- **Replay** of 3 071 landings 9–23 Oct 2026 (benign weather): no ramp WSA, 37 ramp advisories (1.2 %); band comparison of the landings 3 WSA and 1 advisory (the three WSA: the wind change of 17 Oct ~09:04 UTC on 22L)

### Windshear: band comparison on the wind vector, departures included

- **Band comparison on the wind vector** (`collector/shear.py` `vec_bands()`, `vec_refs()`, `band_anomaly()`): each flight's heading-calibrated band winds (prof_json, 400–1 800 ft MSL; corrupt bands with a mean above 80 kt or a spread above 15 kt left out) against the median wind of **all landings and departures of the previous 45 min, any runway**, as the headwind change along the flight's direction; a landing band needs ≥ 2 wind pairs; a departure band on a single pair gets a level only when a neighbouring band agrees (≥ 10 kt the same way); the ramps keep TAS − GS
- **Why:** the first version of the same day (TAS − GS band headwinds, same runway direction only, departures from raw replies in a ±15° track window with a 2.3 kt offset) did not work in practice — the data check found 55 % of departures without a same-direction landing in the previous 45 min (land 15 / depart 22R) and only 7 of 19 live climb-outs with enough replies; it was replaced (`dep_bands()`, `refs_from()` and the departures' raw-reply capture removed)
- **Departures** (`collector/departures.py`, `WindshearTracker.dep_shear()`): the climb-out's band winds are compared live (band alerts marked *departure*, `ph: dep`) and at the end; every climb-out becomes a reference for 45 min (reloaded from `departure_profiles.prof_json` after a restart); runway from the first position and initial track (within 25°, ≤ 1 NM from the extended centreline); go-around climb-outs not used
- **Reports, version 3:** `approach_history.shear_json` and the new `departure_profiles.shear_json` (`rwy`, `hdg`, `band` {`b`, `a`, `ref`, `n`, `np`, `dv`, `lvl`}, `lvl`, `v`; migration in `database/db.py`, both columns also in `database/schema.sql`); the startup back-fill (`run.py`) now also fills the departures and recomputes the band comparison of older reports (landings keep their ramps), landings and departures in one time order — 6 400 flights in a few seconds
- Page: banner `RWY 22R departure`, log `22R dep`, ILS profile `WSA DEP`; Approach History *Band Δ* and the report hover describe the vector comparison
- **Replay** 9–24 Oct (3 310 landings, 3 084 departures): landings 4 WSA (17 Oct ×3, 18 Oct); departures 9 WSA and 21 advisories (1 %) — FIN863 22R at 08:54 on 17 Oct ten minutes before the landings, the reversed wind seen by the departures on 04 at 09:13–09:38, and a departure at 04:42 UTC on 24 Oct (+16 kt at 1 800 ft) during the night-time frontal passage

### Upper-level temperature correction (learnt from MEPS)

- New `collector/tcorr.py` and table `t_correction`: every hour (hourly jobs in `run.py`) the mean Mode S − MEPS difference per level of the last 21 days (hours with ≥ 8 aircraft, raw hourly profiles) is learnt; the correction at 400, 300, 250 and 200 hPa (shrunk with 24 hours, from 24 hours on) is applied when the Skew-T (live, hour, flight) and the time–height section are served (`web/api/sounding.py`): interpolated in log pressure, held above 200 hPa, faded out between 400 and 500 hPa; stored data stay raw
- MEPS check: new column *Correction* per level; Sonde check: band bias *with* the correction and a note (`web/app.py`, `static/js/sounding.js`); Skew-T badge `· upper T corr.` and hover with the raw value (`static/js/skewt_chart.js`); time–height hover note (`static/js/timeheight.js`)
- Without model data the last learnt values stay in use; optional config `TEMP_CORRECTION` (default True) and `TEMP_CORRECTION_DAYS` (21)
- Test: learnt from 19–24 Oct leaving out each sounding's day, 27 soundings 12–24 Oct: 200–300 hPa RMS 1.27 → 0.96 K, bias +0.8–0.9 → +0.1–0.3 K; 400–925 hPa unchanged

### Moisture indicator: offsets learnt from MEPS

- `collector/moisture.py`: offsets per layer and direction also from the MEPS model humidity (model levels, same area): hours of the last 14 days with ≥ 4 climbs / descents in a layer give aircraft − model Tv − T pairs; with ≥ 12 hours the model offset (shrunk with 6 hours) replaces the sonde offset; otherwise, or with `MOIST_MEPS_OFFSETS = False` (optional config), the soundings as before
- API: `offsets_src`, `offsets_meps_h` (moisture of the Skew-T), `mcal` `src` / `n_meps` (time–height); hovers name the source
- Leave-one-day-out test at 8 soundings per layer: bias +11 / +1 / +13 → 0 / +2 / −6 points; scatter unchanged

### Retired: the six browser algorithms (v1)

- Pairwise, Gradient, Energy, Rate, Baseline and Kinematic (in use May – 24 Oct 2026) are **retired** after a restudy on 3 084 stored landings: in benign weather they mostly measured the normal wind profile (Warning on 98 % of approaches with Energy, 13 % with Gradient, 7.6 % of pairs with Pairwise)
- Their description, the replay results and the README text of 23 Oct 2026 are kept in the new `doc/Windshear_Algorithms_v1_Legacy.pdf` (8 pages; listed in `doc/guides.md`, so it is in the *User guides* tab)

### Weather page: 10 m wind and gusts

- `collector/meps.py`: the weather maps also store the MEPS 10 m wind (`x_wind_10m` / `y_wind_10m`, turned from the model grid to true north; rotation table kept per grid) and the 10 m gust (`wind_speed_of_gust`), kt in 2-kt steps, as fields `u`, `v`, `g` of `meps_wx_hours` (about 250 kB per hour instead of 180; download about a third more, ~80 MB per main run); hours stored without the wind are fetched again from the runs of the last 30 hours (`WX_REFILL_H`; once after the update, ~200 MB), older ones stay without it
- `web/api/weather.py`: `?fields=` accepts `u,v,g`; on the 20 / 40 km grid the gust is the block maximum, the wind the block mean; the index and frames carry a wind flag `w` so the page (and the frame cache) reloads an hour whose wind arrived later with the same run and lead
- Weather page (`web/templates/weather.html`, `static/js/weather.js`, `static/js/wx_layer.js`): new tick boxes **Wind** (10 m wind barbs about 50 px apart, fixed to the grid while panning) and **Gusts** (shading from 25 kt in Beaufort steps 25 / 34 / 41 / 48 / 56 / 64 kt, under the rain); hover read-out with wind direction / speed (kt, m/s) and gust; legend; the status line notes hours without stored wind

### Sounding page: MEPS column in the Indices panel

- `static/js/sounding.js`: the Indices panel gets a **MEPS** column; the columns follow the MEPS / Sonde tick boxes (Mode S + MEPS, Mode S + sonde or all three). The model profile shown on the Skew-T (`/api/meps/profile`) is averaged into the Mode S layers like the sonde (`skewtSondeLayers`) and run through the same `skewtIndices` with humidity aloft; its surface point is the model's lowest level (height from the model geopotential, extrapolated hypsometrically when below the lowest pressure level), not the METAR. Header: run hour, lead time and `fcst` when more than 2 h into the run, hover with run, valid time, model points and levels; notes per column ("no MEPS data for this time" when missing)
- Clear differences: a MEPS or sonde value differing from Mode S beyond a per-row limit is shaded faint violet; every value's hover gives *Mode S − reference*; the note counts the shaded values
- `static/js/skewt_indices.js`: `SKEWT_INDEX_DIFF` (limits per row) and `skewtIndexDiff(key, a, b)`; option `topWhat` for the "above the top of …" note; row tips mention MEPS
- `web/templates/sounding.html`: shading style (dark / light), three-column mode (`idx-wide`: compact text and wrapping row labels, panel 440 px from 1 801 px wide screens), panel tooltip; on narrow screens where the panels wrap the Skew-T keeps a height of at least 560 px (it could collapse to a thin strip)

### Skew-T: analysis of the MEPS or sonde profile

- New selector **Analysis of** (Mode S / MEPS / Sonde) below the Skew-T on the Live Map and the Sounding page (`web/templates/live.html`, `web/templates/sounding.html`; `static/js/live_map.js`, `static/js/sounding.js`; shared setting `ms_skewtAnaSrc`, default Mode S). Choosing MEPS or Sonde ticks that profile on and switches a hidden analysis on at Levels
- `static/js/skewt_chart.js`: option `anaSrc`; the analysis (all levels) runs on the chosen profile averaged into the Mode S layers (`skewtSondeLayers`) with its own surface point (lowest model level / sonde surface; height hypsometric when missing) for the thermal top and the parcel; cached per input; falls back to Mode S when the profile is not shown; tag `ANALYSIS · …` under the top-left labels; LCL hover names the surface point; METAR cloud comparison with Mode S only; airport inversions unchanged
- `web/templates/live.html` loads `static/js/skewt_indices.js` (for the layer averaging)
- Likely cloud layers for the MEPS / sonde analysis (from Analysis Stability): `skewtCloudLayers` in `static/js/skewt_analysis.js` — RH ≥ 90 % (over water at ≥ 0 °C, over ice below) on the full-resolution levels, base / top interpolated in ln p, layers < 1 000 ft apart joined, < 100 ft dropped; drawn as grey shading with a bar at the left and a `CLOUD base–top RH n%` label (`skewt_chart.js`, colour `anaCloud`)

### Windshear page: engine status line

- `collector/windshear.py`: the tracker records the time of the last analysis and the aircraft analysed (landings on final, departures), and keeps today's (UTC) windshear report statistics in RAM — flights with a report, flights per level, the strongest ramp and band change, reply noise and lowest height; `seed_day()` rebuilds them from the stored reports; `get_state()` returns them as `ws_engine` with the reference flights of the band comparison, the aircraft in the corridors, the last alert and the uptime
- `run.py`: `_seed_ws_day()` at startup and after the windshear back-fill (today's `approach_history` and `departure_profiles` reports)
- `web/templates/windshear.html`, `static/js/windshear.js`, `static/css/style.css`: one status line under the Windshear Alert header (running / no analysis / waiting dot, aircraft analysed now, refs with *band check waiting* below 3, today's flights and levels, strongest value of the day; optional parts left out when the panel is narrow), hover with the details

### Windshear page: wind barbs collected on the server

- `collector/windshear.py`: `_barb_history()` keeps for every aircraft on approach the ILS-profile wind barbs (Lo: every 400 ft / 0.5 NM, 40; Hi: every 150 ft / 0.2 NM, 100; only fresh, non-NONE winds in the corridor with an unfrozen position) and the NONE markers (in the corridor with their reason; before the corridor for turns, also every 15 s), with the same gates the page used; RAM only, dropped with the aircraft; sent in `/api/windshear/state` as `barbs`, `barbs_hi`, `none_hist`, `pre_hist` (compact lists, up to ~5 kB per aircraft on final)
- `static/js/windshear.js`: the page takes them from the server, so a newly opened page shows the whole approach so far of the aircraft on final (Auto and a strip click work at once); its own accumulation is kept only as a fallback for a server without these fields

### Approach series: ADS-B ground speed

- `collector/receiver.py`: ADS-B airborne velocity messages (TC 19, ground speed, track, vertical rate; about twice a second) kept per aircraft for 20 s (`get_vel_samples`), pruned with the BDS caches
- `collector/windshear.py`: the approach capture also takes these samples while established on final (`vel_sample_fn`), stored in `approach_series` as the new list `v19` (t, gs, trk, vr, alt; about 1–2 kB more per landing); older series have none, `decode_series()` handles both
- `run.py`: passes `get_vel_samples` to the tracker
- Purpose: a later test of a denser headwind for the windshear detection (TAS of the Comm-B replies against the 2-Hz ADS-B ground speed); not used by the detection yet

### Documentation

- Guides: the Mode S interrogations are described as coming from the ground interrogators of Fintraffic's wide-area multilateration (WAM) network and Mode S radars (Windshear v1.2, Skew-T v4.6, Sounding and Wind Map v3.2); the Windshear guide also mentions the ADS-B ground-speed collection
- New user guide **Windshear detection and the Windshear page** v1.1 (status line added the same evening) (`doc/Windshear_User_Guide.pdf`, 14 pages with v1.3 — barbs collected on the server; Section 5.3 *The engine status line*): the detection v2 step by step with its formulas (TAS − GS, distance along the path, 400 m smoothing, ramps and the 1-km scaling, significance and persistence tests, horizontal F-factor, band comparison on the wind vector, departures, levels, confirmation), the scientific basis with references (ICAO Annex 3 / Doc 9817, NASA/FAA F-factor, Hong Kong Observatory GLYGA headwind ramps, LLWAS/TDWR alert levels, Mode S winds), the Windshear page (banner, strips, ILS profile, alert log, Approach History WS view, ACI, wind rose), the cases of 17 and 23 October 2026, results 9–24 October and limitations; listed in `doc/guides.md` (`open: windshear`) and opened by a new **?** in the *Windshear Alert* header (`web/templates/windshear.html`)
- User guides updated: **Skew-T v4.5** (20 pages; new Section 10.6 *Analysis of the MEPS model or the radiosonde* with a Mode S / MEPS comparison figure and the likely cloud layers with a sonde example; controls and limitations) and **Sounding and Wind Map pages v3.1** (44 pages; *Analysis of* and the cloud layers in the Skew-T controls) — earlier **v2.9** (44 pages; new Section 4.4 *Comparing with MEPS and the sonde* with a screenshot of the three-column panel and the table of shading limits; MEPS humidity indices in Section 4; the Wind Map section now starts at page 30, `open: windmap@30`) — earlier today **v2.8** (42 pages; new Section 7.1 *The upper-level temperature correction* with its table, the MEPS check *Correction* column and the Sonde check *corrected* column with new screenshots, the moisture offsets from MEPS and the check through the front of 23–24 Oct, data and limitations) and **Skew-T v4.3** (18 pages; the upper-level correction with the `upper T corr.` badge and hover, the RH strip status); `doc/guides.md` updated
- README: new section *Project status and data checks* (data collection continues; findings of the post-front check of 24 Oct: windshear, moisture, temperature, wind, heights; model data optional); *Upper-level temperature correction* under the MEPS check; *Moisture (trial)* status after the front and the MEPS offsets; windshear band comparison on the wind vector and its results; `t_correction`, `departure_profiles.shear_json`, API fields and optional config keys
- README: *Indices panel* — the MEPS column, the column choice by the tick boxes, the shading limits and the narrow-screen layout
- README: new *Weather* controls Wind and Gusts, `meps_wx_hours` fields `u v g`, `/api/weather/frames` fields
- README: new *Windshear detection* section (v2: method, levels, alerts, per-landing report, departures, first results, limitations, retirement note), revised alert log, strip badge, ILS profile, Approach History WS mode, API and project structure

## v.23102026 — 2026-10-23 (MEPS on the model's own levels: a dense model profile on the Skew-T and the model's humidity in the RH strip; MEPS on the Wind Map; new Weather page with cloud layers; weather overlay on the Live Map with MEPS and FMI radar; user management; unified dark-theme diagram background)

### MEPS model levels

- **MEPS model levels** (`collector/meps.py`): besides the 10 standard pressure levels, every run now also brings temperature, specific humidity and wind on the model's own (hybrid) levels — the 56 lowest of 65, from about 12 m above the ground to about 190 hPa (25 m apart near the ground, 100 m at 1 km, 230 m at 3 km, 350 m at 5.5 km, 600–700 m near 200 hPa) — with the surface pressure, forecast hours +0 … +6 (they appear about 1 h after the pressure levels), in the same box and area. Each level is averaged on the level, its pressure is ap + b · the mean surface pressure. Second OPeNDAP request of about 6 MB per run (about 50 MB a day), new table `meps_ml_hours` (about 3.3 kB per hour); the pressure levels stay for the heights and the MEPS check (at the shared levels the two agree within 0.05 K and 0.2 kt). Optional `MEPS_MODEL_LEVELS` (default on); after the update the first start back-fills the model levels of the last `MEPS_BACKFILL_DAYS` (3) days
- **Skew-T MEPS profile** (`/api/meps/profile`, `levels_kind`): drawn on the model levels — a smooth curve with the model's surface inversions and tropopause, also in the Airport zoom, barbs thinned as before; falls back to the 10 standard levels for hours without model levels (label *10 std levels*)
- **RH strip — MEPS humidity**: with the MEPS tick box on, the model's relative humidity over the same area is drawn in the RH strip as a teal line (model levels), next to the aircraft moisture indicator and the sonde's pink line; the hover adds the model's mean RH of each indicator layer and its RH at the level. A live check of the moisture trial every hour, also between the soundings
- **More robust fetching**: an empty, cut or timed-out OPeNDAP answer is tried three times (after 15 and 30 s); a failure of one request no longer stops the other runs of the cycle and is retried later (after 30 min for recent runs)
- **User guides**: Sounding and Wind Map pages v2.6 (40 pages; the model's levels with a table, how the data are made, the MEPS line in the RH strip; the Wind Map section now starts at page 27) and Skew-T v4.2 (the model's levels and humidity), with new screenshots

### Wind Map: MEPS model

- **MEPS** tick box (off by default): the MEPS weather model at the level, averaged into the same cells as the aircraft — teal barbs in the cells without aircraft, a thin teal barb under the aircraft barb in the others, the model wind and temperature and the difference in the popups. New compare mode **Mode S − MEPS model**: vector difference arrows and a warmer / colder tint per cell. Works with the time slider. `collector/meps.py` now also fetches the model's pressure levels 1000 … 150 hPa in a ± 300 km box every 20 km (about 1 MB per run) into the new table `meps_map_hours` (about 50 kB per hour, kept 7 days); `/api/windmap` and `/api/windmap/frames` take `meps=1`. Optional `MEPS_MAP`, `MEPS_MAP_DAYS`
- User guide Sounding and Wind Map pages v2.7 (41 pages; new section *The MEPS model at the level* and *Mode S − MEPS model*)

### Weather page

- **New Weather page** (`/weather`, navigation bar): the MEPS weather model over the whole MEPS area (Scandinavia, Finland, the Baltic) with a time slider from the past (24 h / 3 days / 7 days) to the forecast (none / 24 h / 48 h) and ▶ animation — isobars every 4 hPa with highs **H** and lows **L**, the rain and snow of each hour in radar-like colours (light blue → blue → green → yellow → red → pink; snow violet), total cloud cover as grey, a hover read-out and the run / lead of each hour. Drawn by the browser on a canvas (new `static/js/weather.js`, `web/templates/weather.html`); grid 20 km (about 30 kB per hour) or 10 km
- `collector/meps.py` fetches each run's surface file — sea-level pressure, accumulated precipitation and snowfall, total and low cloud every 10 km; the main runs to +48 h while they are the newest (about 62 MB), the others to +6 h, back-fill to +3 h — into the new table `meps_wx_hours` (compressed, about 120 kB per hour, kept 7 days). New `web/api/weather.py` with `/api/weather/index` and `/api/weather/frames`. Optional `MEPS_WX`, `MEPS_WX_KM` (3000 = whole area, 800 = ± 800 km), `MEPS_WX_FORECAST_H`, `MEPS_WX_DAYS`
- Weather maps fetched in pieces of 12 hours, each stored and logged at once (`MEPS weather maps: …` in the main log), and stored about twice as fast; the page looks for new hours every minute while few are stored
- **Cloud layers**: the weather maps now also hold medium and high cloud, fog and the cloud base (clouds in 5 % and the base in 50 m steps, about 180 kB per hour); the Weather page's **Clouds** selector shows Total / Low / Medium / High / Fog and the hover read-out adds the cloud base in ft. `/api/weather/frames` takes `fields=`
- **Live Map — weather overlay** (☂ button at the top right of the map, new `static/js/live_wx.js`): source Off / **MEPS model** (rain and snow, low cloud, fog, isobars of the present model hour) / **FMI radar** (observed rain rate every 5 min, Finland only), an opacity slider, under the aircraft; refreshed automatically; remembered in the browser. The drawing is shared with the Weather page (new `static/js/wx_layer.js`)
- **FMI radar** (new `web/api/radar.py`, `/api/radar/latest`): the newest national composite of the download service (`fmi::radar::composite::rr`) at about 2 km, fetched on demand at most every 5 minutes and shared by all viewers, read with plain Python (uncompressed 16-bit GeoTIFF, ETRS-TM35FIN); nothing written to disk
- Live Map weather overlay: new source **Both** — the FMI radar's rain inside the radar coverage, the MEPS model's rain outside it (cut away along the coverage edge), with the model's low cloud, fog and isobars; the edge of the radar coverage is drawn as a dashed line (also with the radar alone). `/api/radar/latest` adds `cov` (the coverage as runs of cells per row, about 2 kB); `static/js/wx_layer.js` gains `setOverlay`
- Weather page: **−1h** / **+1h** buttons beside the time slider step one hour back or forward with the mouse (greyed at the ends; a step stops the animation)
- Navigation bar: the page links keep to one line on narrower screens (smaller padding below 1 700 / 1 450 px)

### Documentation

- README: copyright notice and a new section *Credit and commercial use* (how to credit the project when building on it, and the GPLv3 obligations in short); new `CITATION.cff` (GitHub "Cite this repository")

### User management

- User management added
- Login protection improved

### Dark theme

- The Skew-T diagrams (Live Map, Sounding page), the Windshear ILS profile, Wind Rose and Approach Conditions chart and the Approach History overlay now use the same blue-grey background as the panels (`--bg-1`) instead of slightly different darker shades; the faint grid lines, isotherms, adiabats and rings are one step lighter with it. Light theme unchanged
- Windshear page: the view buttons of the Wind Rose panel are now **WR** and **ACI** (were Rose and Cond), and the Approach History column mode **Cond** is now **ACI**

---

## v.22102026 — 2026-10-22 (MEPS model data and the MEPS check; taller Skew-T on the Live Map; version numbering by date and the What's new window with the user guides; geoid correction of the GNSS heights; honest uncertainty of the moisture trial)

### MEPS model data: MEPS check and the Skew-T MEPS profile

- **MEPS model profiles** (new `collector/meps.py`, background thread `meps`): every 3 h the newest control run of the MEPS weather model (2.5 km, the model FMI uses) is fetched from MET Norway's open archive (thredds.met.no, CC BY 4.0) — forecast hours +0 … +5 of temperature, wind, geopotential and humidity on 10 pressure levels in a 300 × 300 km box around the receiver every 10 km, one OPeNDAP request of about 1.4 MB read with plain Python (no new libraries). The mean over the sounding radius and the column at Jokioinen are stored per hour in the new table `meps_hours` (about 0.9 kB per hour); +0 … +2 are the verification values, the newest run's +3 … +5 are kept as a provisional forecast. Back-fills 3 days at the first start; optional `MEPS_FETCH`, `MEPS_BACKFILL_DAYS`, `MEPS_URL`. Nothing else depends on it
- **Sounding page — MEPS check** (new view): the Mode S area profile minus the model every hour by pressure level — temperature, wind and the heights of the pressure surfaces from the GNSS heights — also at night and between the soundings (3 d / 7 d / 14 d / 30 d, ≥ 8 aircraft), and at each sounding how much of the aircraft − sonde difference is the 100 km distance to Jokioinen (`/api/meps/check`). First study (24 Sep – 22 Oct, hours with ≥ 8 aircraft): temperature 0.6–0.9 K RMS up to 400 hPa and 1.0–1.4 K above, wind 3–5 kt up to 500 hPa and 6–9 kt above; the distance explains about 40 % of the temperature and 60 % of the wind difference to the sonde
- **Skew-T — MEPS** tick box (Live Map and Sounding page, shared, off by default): the model's temperature, dewpoint and winds over the same area, with the run, the lead time and the area − model difference in the label and the values in the hover (`/api/meps/profile`)
- **User guides**: Sounding and Wind Map pages v2.4 (39 pages; new sections *The MEPS model beside the aircraft* and *MEPS check*, the Wind Map is now Section 8) and Skew-T v4 (16 pages; new section on the comparison profiles Sonde, MEPS and RH), both explaining why the model has only 10 pressure levels

### Live Map layout: taller Skew-T, compact aircraft box

- The **Atmosphere Profile** panel now uses the full height of the page: the bottom strip (aircraft details, METAR / TAF) lies only under the aircraft list and the map. The diagram is about 25 % taller on a 1920 × 1080 screen and 45 % on 1366 × 768, and the panel about 8 % wider (590 instead of 548 px on 1920 × 1080; at least 560 px), so the RH strip has room. METAR and TAF side by side (40 / 60 %; one third / two thirds and slightly smaller text below 1 600 px window width); a long METAR or TAF shrinks its text and line spacing to fit (down to 12 px, about 9 TAF lines) before it scrolls
- **Aircraft detail box** compact (330 px instead of 520 px, three columns): altitude, vertical rate, temperature, ground speed, track, wind (`252° / 45 kt`), heading correction; pressure, humidity and turbulence only when an aircraft sends them; the meteo source stays as the badge in the header
- Tablet portrait mode (no map) unchanged: the strip spans the full width

### Version number, What's new and user guides

- **Version number by date** (v.DDMMYYYY, one per development day, taken from the newest version heading of `doc/whats_new.md` or of this CHANGELOG, whichever is newer — all headings here now carry it) shown in the top bar of every page, next to the theme button, with a **What's new** link: a scrollable window over the current page with short user-oriented notes of the last 10 versions (new `doc/whats_new.md`, `web/whats_new.py`, `/api/whatsnew`). A small dot on the link marks a version this browser has not opened yet
- **User guides in the web pages**: a second tab of the window lists the PDF guides (Skew-T; Sounding and Wind Map pages) with descriptions, **Open PDF** and **Download** (new `doc/guides.md`; `/doc/<file>` serves only the listed PDFs, behind the login). Small **?** buttons open the matching guide directly from the Live Map *Atmosphere Profile*, the Sounding page and the Wind Map (at its own section)
### Geoid correction and moisture uncertainty

- **EGM96 geoid** removed from the aircraft GNSS heights at each position (new `collector/geoid.py`, a built-in 5′ grid of southern Finland): the geoid falls from about 19 m at Jokioinen to 15 m east of Kotka, which the calibration had absorbed as a constant. Applies to the D-values, the Wind Map heights and geostrophic wind, the layer thicknesses (moisture trial) and the sonde comparison; the calibration curve now holds only the aircraft's pressure error (about 18 m lower). Effect on 20–22 Oct data: geostrophic wind about 1 kt, thicknesses 0.03–0.1 K. Stored hours and sonde comparisons are computed again once at start while their observations exist
- **Moisture (trial)**: its ± now includes a systematic part (0.3 K of Tv − T) besides the scatter of the flights, after the first comparison with four soundings showed sounding-to-sounding differences of 0.2–0.45 K (index RMS about 37 %); the index is drawn faint above ±40 % and described as a tendency. The hovers show both parts
- User guide v2.3

---

## v.21102026 — 2026-10-21 (heights of the pressure surfaces from GNSS: self-tuning calibration, D-value and thickness temperature in the time–height section, height contours and geostrophic wind on the Wind Map; jet-stream symbol, isotherms and cross-section on the Wind Map; all slider frames loaded at once and faster map queries; a trial moisture indicator; tropopause, max-wind line, sonde columns and PNG in the time–height section; airframe altimeter offsets; user guide v2.2; web server logging improvements)

### Moisture indicator (trial)

- **Sounding page, Time–height section — Moisture (trial)**: a humidity indicator for 1 000–5 000, 5 000–10 000 and 10 000–15 000 ft from the aircraft themselves. Moist air is lighter, so the thickness temperature from the GNSS heights of climbing and descending aircraft minus the Mach/TAS temperature measures the moisture of a layer (the principle of the ADS-B humidity study at Amsterdam Schiphol). The flights of a few hours are averaged, offsets learnt against the Jokioinen soundings (separately for climbs and descents) are subtracted, and the result is divided by the value of saturated air: an index of about the relative humidity, shown as dry / moist / humid; with **Sonde** on, the soundings show the same index from their own humidity. New `collector/moisture.py`
- **Skew-T — RH (trial)**, Live Map *Atmosphere Profile* and Sounding page: a new **RH** tick box (shared, off by default) adds a narrow RH strip between the diagram and the wind barbs — the moisture indicator as bars for its three layers (dry / moist / humid, with the ± range) and, with **Sonde** on, the radiosonde's relative humidity as a pink line for comparison; hover for the values. Area · now uses the flights of the last 1–2 hours, Area · hour the same values as the Time–height field; not for a single flight. `/api/sounding` and `/api/sounding/hour` take `moist=1`
- GNSS hourly cells (`gnss_hours`) now also give the 1 000–5 000 ft layer (crossed whatever the QNH) and whether each flight climbed or descended; hours stored by the previous version are computed again once at start while their height series exist

### Wind Map — time slider frames loaded at once; faster queries

- On the first slider move or ▶ all 24 frames of the time slider (with the comparison, the jet depth levels and the sonde) are loaded at once and kept in the browser: dragging the slider and the animation show them without waiting. A thin strip under the slider marks the loaded frames; the ones needed next come first. New `/api/windmap/frames` (several frames from one database query, each identical to the single map of its period; gzip-compressed)
- *Last …* periods: the earlier slider positions now end on whole hours (−1 = the last full hour), so the loaded frames stay valid while the clock runs; 0 is still *now*
- Map queries read through the time index for periods up to 72 h instead of the altitude index (which read the band over the whole database): a single map is now about 10–30 × faster. The queries of the other pages were checked the same way and already use the right index, except the Flights list and the Sounding page's flight list, which sorted every flight: now read in order from the index (about 10 × faster)

### Time–height section, Wind Map and calibration extras

- **Time–height section**: **Tropopause** line (WMO lapse-rate definition from the smoothed layer temperatures), **Max wind** line (height of the strongest wind ≥ 50 kt above 10 000 ft), **Sonde** — each Jokioinen sounding as its own narrow column in the same colour field (temperature anomaly, wind speed, lapse rate, height of the pressure surfaces) with a sonde-vs-aircraft hover, and **PNG** to save the picture; the column hover gives the tropopause and the strongest wind
- **Wind Map**: **Isotherms** (temperature contours at the level); **✎ Section** — a vertical cross-section along a line drawn with two clicks (temperature anomaly, wind speed, wind across the section, height of the pressure surface; barbs and isotherms; new `/api/windmap/xsection`, `static/js/windmap_xsection.js`)
- **GNSS height calibration**: aircraft are now paired with the radiosonde's drifted position (followed from the sounding's winds) instead of the launch site; the cells of the stored soundings are recomputed once. Optional `GNSS_CAL_SLOPE` (default off) also moves the values from FL200 up to the balloon with the slope of the pressure surface — tested, but kept off for now
- **Sonde check** shows the GNSS height calibration: correction per band, mean offset per aircraft type and a **per-airframe altimeter offset** table (registration, type, soundings, raw and used offset); `/api/gnss/calibration` gained `airframe_list` and `by_type`
- README: footnote on the A220 vertical-rate finding

### User guide v2.0 – v2.2

- `doc/Sounding_Page_User_Guide.pdf` version 2.0 (30 pages): now covers the Sounding **and** Wind Map pages — new section on the heights of the pressure surfaces, height change and thickness-temperature check in the time–height section, and a new Wind Map section (controls, how the cells are made, ΔT, isotachs and streamlines, jet stream, heights and geostrophic wind, sonde, compare modes, time slider) with screenshots
- Version 2.2 (36 pages): a new section on the trial **Moisture** field and the Skew-T RH strip — why it works (virtual temperature), the size of the signal in the soundings, how the data are gathered and the index calculated, the 20–21 Oct example with the sonde columns, and how to read it for now; version 2.1 covered the extras of the day (time–height lines and sonde columns, Wind Map isotherms, cross-section and time slider, airframe offsets)

### Wind Map — jet stream symbol

- **Jet** tick box: the jet stream as on aviation SIGWX charts — thick line along the axis of strongest wind where the smoothed wind is ≥ 80 kt (or ≥ 60 kt), arrowhead downstream, barb flags with level and speed at the maximum, double change bars every 20 kt of decrease; dashed (and `↑ stronger beyond?`) where the strongest wind lies at the edge of the data
- **Depth**: also loads FL250–FL410 and labels the levels with ≥ the chosen speed at the maximum (e.g. `330/410`)
- `windmap_analysis.js`: new `wmJetAxis()` (axis from across-flow sections of the analysed field)

### Heights of the pressure surfaces from the GNSS − baro difference

- **Self-tuning calibration** (`collector/gnss_heights.py`, table `gnss_cal`): after each Jokioinen sounding the aircraft heights of the pressure surfaces within 150 km and ±1 h of the balloon are compared with the sounding; the fleet correction per 5 000 ft band (geoid + speed-dependent altimeter error, starting from a built-in default) and small per-airframe offsets are refitted from the last 30 days. `/api/gnss/calibration` shows it
- **Hourly cells** (table `gnss_hours`, raw so that a new calibration also corrects the past; written 4 h after the hour, back-filled at the first start): airframe mean GNSS − baro per layer, and the GNSS heights of the pressure surfaces at the 5 000 ft layer edges from the climbs and descents of `height_series`
- **Sounding page, Time–height section** — three new colour fields: **Height of the pressure surfaces** (D-value, ±300 m), **Height change 6 h** (±60 m) and **Thickness temperature check** (mean virtual temperature of 5 000 ft layers from the height gained by climbing / descending aircraft minus the Mach/TAS temperature, ±2 K); hover adds the surface height, D-value, 6 h change and the thickness temperatures (also FL100–FL300)
- **Wind Map — Heights** (experimental): teal height contours of the pressure surface, and the geostrophic wind of the area from a plane fit of the aircraft heights (dashed arrow Vg) next to the mean measured wind (V), with the ageostrophic difference in the hover and status line; cell popups give the surface height and D-value
- Maintenance page: `gnss_hours` statistics row; optional `config.py` key `GNSS_HOURS_DAYS` (default 0 = keep)

### Web server

- Improved web server access logging and login handling; see the README (Installation → Running in the background) for the access log

---

## v.20102026 — 2026-10-20 (dense height series per aircraft visit; vertical motion and vorticity in the time–height section; surface inversion join on the Skew-T)

- **Skew-T (Live Map and Sounding page): dashed join from the METAR surface temperature to the lowest aircraft layer** above the ground — surface inversions on calm mornings (and steep heated surface layers) now show without the Airport profile; the ground-line hover gives the difference and its height above the ground (`static/js/skewt_chart.js`)
- **Sounding page user guide v1.1** (`doc/Sounding_Page_User_Guide.pdf`, 17 pages): new sections on the Time–height *Vertical motion* (adiabatic method, its test and limits) and *Vorticity* (plane fit, cyclonic / anticyclonic flow, positive vorticity advection, the period-mean caveat) with screenshots of the 17–18 October front and trough
- **Hourly vorticity profile** (new table `kinematics_hours`, new `collector/kinematics.py`): every hour the winds of the aircraft within 200 km are fitted with a plane per altitude layer (each aircraft averaged first, outliers removed) — relative vorticity and divergence with their standard errors, written by the hourly jobs and back-filled at the first start from the observations still in the database (before the 30-day purge removes them), kept indefinitely; listed on the Maintenance page; optional `config.py` key `KINEMATICS_RADIUS_KM` (`run.py`, `database/schema.sql`, `database/maintenance.py`, Maintenance page)
- **Sounding page Time–height — Vorticity** colour field (about FL130–FL390): purple cyclonic / gold anticyclonic, hover with error, fraction of f and aircraft; `/api/sounding/timeheight` columns carry `kz`, the hour in progress computed live (`web/api/sounding.py`, `web/app.py`, `static/js/timeheight.js`, `web/templates/sounding.html`)
- **Sounding page Time–height — Vertical motion** colour field (FL050–FL200): rising / sinking air in cm/s by the adiabatic method — the part of the temperature change that the thermal-wind advection does not explain, divided by Γd − Γ; hover shows the advection and local-change terms; the newest hours fainter (`static/js/timeheight.js`, `web/templates/sounding.html`)
- **Dense height series** (new table `height_series`, new `collector/height_series.py`): every aircraft visit is recorded as a compact series of its ADS-B pressure altitude, GNSS − baro difference, position and NACp — a row whenever the altitude or the difference steps by 25 ft, NACp changes or the difference stops, plus a position keyframe every 20 s (flicker between two neighbouring values in level flight at most every 10 s). As exact as twice-a-second samples, about 2–4 kB per climb or descent, one INSERT per visit; research data for thin-layer thickness temperatures, the speed-dependent altimeter error and level-leg geostrophic winds. Kept `HEIGHT_SERIES_DAYS` (default 30) days, purged daily (archived first when Archive before purge is on); listed on the Maintenance page; optional `config.py` keys `HEIGHT_SERIES`, `HEIGHT_SERIES_DAYS` (`collector/receiver.py`, `run.py`, `database/schema.sql`, `database/archive.py`, `database/maintenance.py`, Maintenance page)
- README: first results of the GNSS − baro difference (ellipsoidal heights ≈ 18 m above the sonde's, per-airframe offsets, thickness temperature and geostrophic wind checks)

---

## v.19102026 — 2026-10-19 (Sounding page user guide; GNSS − baro difference stored per observation; Sounding page time–height section; Wind Map: per-aircraft averaging, square cells, ΔT layer, position checks, isotachs, streamlines, sonde, change / thermal wind, time slider; radiosonde earlier start, completeness check and re-check; Live Map Sonde refresh; degree sign in HC; Sonde check hour rows; log rotation)

- **Sounding page user guide** (`doc/Sounding_Page_User_Guide.pdf`, 14 pages): the five views, the radiosonde comparison, the Indices panel and the time–height section explained with the physics behind them (air masses and fronts, advection, the thermal wind, stability and inversions, subsidence) and worked examples from the 17 October 2026 cold front and the high of 18–19 October; the Sonde check and the limitations
- **GNSS − baro altitude difference stored per observation** (new `observations` columns `gmb_ft` and `nacp`, added automatically at start): the aircraft's latest GNSS − barometric altitude difference (ADS-B TC 19, used until now only for the spoofing checks) when at most 5 s old, and its NACp when at most 30 s old — collected for pressure-surface heights (D-values), thickness temperatures and geostrophic winds; no extra writes (`collector/receiver.py`, `collector/writer.py`, `database/schema.sql`, `database/db.py`)
- **Sounding page — Time–height section** (new fifth view, new `static/js/timeheight.js`, `/api/sounding/timeheight`): the hourly profile archive as a time–height cross-section over 24 h – 14 days (the hour in progress live): colour field temperature anomaly / 3-hour temperature change / wind speed / lapse rate, wind barbs, 0 / −10 / −20 °C isotherms, Jokioinen launch marks and an aircraft-per-hour strip; hover for values, click a column to open that hour on the Skew-T
- **Wind Map — second round** (`static/js/windmap.js`, new `static/js/windmap_analysis.js`, `windmap.html`, `/api/windmap` returns `alt_query_ft`), in a new second control strip:
  - **Isotachs** (dashed, every 10 / 20 kt, with the strongest analysed wind) and **Streamlines** from a smoothed field of the cells (Barnes-type, drawn only where there are data)
  - **Sonde**: the Jokioinen radiosonde at the level as a pink barb at its launch site, with the difference from the nearest Mode S cell
  - **Compare**: *change since the previous period* (vector change of the wind as purple arrows, cells tinted by warming / cooling) or *other level* (thermal wind arrows, cells tinted by veering = warm advection / backing = cold advection, lapse rate between the levels in the popup)
  - **Time slider and ▶ animation**: the period moved back hour by hour over the last 24 hours
  - the status line and the ΔT / Compare legends float over the bottom left of the map instead of sitting in the control strip, so the strips no longer change height (and the map no longer jumps) when the text changes
- **Wind Map — first round of improvements** (`web/api/windmap.py`, `static/js/windmap.js`, `windmap.html`):
  - each aircraft is averaged first, then the aircraft of a cell — one aircraft with many stored replies no longer outweighs the others; the barb's opacity shows the number of aircraft (1 faint, 2, 3+ full), and the popup gives the aircraft and observation counts, the spread between aircraft (wind and temperature) and how many had degraded GNSS; new **Min** selector (1 / 2 / 3 aircraft)
  - square grid cells of 25 / 50 / 100 km (default 50) instead of 0.25° / 0.5° / 1.0° (which were twice as tall as wide at 60° N)
  - temperatures are moved to the level with the lapse rate fitted to the band, and the new **ΔT** tick box colours the cells by their difference from the layer mean (blue colder, red warmer) — air masses and frontal zones
  - frozen positions and impossible jumps (GNSS jamming / spoofing, e.g. the false point east of St Petersburg) are removed; **GNSS ok only** also leaves out observations inside GPS degradation episodes
  - low layers use the METAR QNH of the period (hourly profile archive) instead of the current one for historical periods
  - two-line labels shown only when the cells are wide enough on screen; map style and colours follow the Light / Dark theme; settings remembered; the map loads when the page opens; optional **Auto** reload every 2 min
- **Radiosonde re-check every 6 h**: the soundings of the last 48 h are fetched again every 6 h (as at start), because FMI sometimes replaces an early, partial copy with a fuller one hours later (18 Oct 12 UTC: 100 hPa at first, 52 hPa the next morning); only a copy with more data is written, and the Sonde check then recomputes its rows (`collector/sondes.py`)
- **Collector Stats log line every 10 min** (`Stats: N messages processed (M in the last 10 min), K aircraft tracked`) instead of every 5000 messages (about 3 200 lines a day before) (`collector/receiver.py`)
- **Log file rotated and smaller**: `logs/modes_meteo.log` is rotated at 10 MB with 3 old files kept (`.1`–`.3`, at most about 40 MB; it had grown to 199 MB since June — an existing large file is rotated at the first line written), and the web server's access lines (one per page request, two thirds of the log) are no longer written; warnings and errors still are. Optional `config.py` keys `LOG_MAX_MB`, `LOG_BACKUPS`, `LOG_HTTP_ACCESS` (`run.py`)
- **Radiosonde fetch — only the due sounding is asked for**: each 15-min look requests the time window of the sounding that is due (from 1 h before its nominal time) instead of FMI's latest sounding, so until the new one appears the answer is empty (under 1 kB) instead of the whole previous sounding (100–400 kB each time) (`collector/sondes.py`)
- **Sonde check — hour rows with the right sounding**: an hourly row compared with an older sounding because the sounding launched in that hour was stored only later (FMI late, or an extra launch such as an 08 UTC one found by the start-up back-fill) is now computed again with that sounding (age about 0 h instead of 3–6 h). Rows of the last 14 days are corrected at the next hourly run (`collector/sonde_verif.py`)
- **Radiosonde fetch — earlier start and completeness check**: a new sounding is looked for from the nominal hour (about 30 min after launch, the balloon at about 10 km) instead of 80 min after it, every 15 min (was 20) until it appears; after that it is fetched again every 15 min until it no longer grows (raw level count unchanged twice and the last data ≥ 15 min old, or 5 h after the nominal hour), and the stored copy is rewritten only when it has more levels. Before, the first copy found was kept for good, so a sounding published before its flight data were complete stayed incomplete
- **Live Map Sonde layer**: the newest sounding appears within 2 minutes (checked every 2 min instead of 10, and at once when the page becomes visible again — browsers pause timers in background tabs, so it could show an older sounding until Sonde was switched off and on); `/api/sonde?have=KEY:N_RAW` answers `unchanged` while the shown copy is current, so the polling stays light
- **Live Map aircraft list**: the heading correction has the degree sign (`HC +1.1° own`)

---

## v.13102026 — 2026-10-13 (Live Map aircraft list: flight levels, vertical rate, climb / descent arrows; Sounding page table top-down; Windshear page Light theme colours and readable ILS profile labels; WR / ACI button; Live Map layout for large screens and tablets)

- **Windshear flight strips**: no visible scrollbar either (still scrolls with the mouse wheel / touch)
- **Live Map aircraft list**: no visible scrollbar (it flickered in Firefox as the list updated) — still scrolls with the mouse wheel / touch; the list is swapped in at once on each update, so its height and scroll position no longer jump
- **Live Map aircraft list, QNH altitude**: below the 5 000 ft transition altitude the altitude is shown on the METAR QNH (pressure altitude + 27 ft/hPa above 1013.25; hover shows QNH and pressure altitude), above it the flight level; the switch is decided on the QNH altitude. Without a METAR QNH the pressure altitude is shown as `ft PA`
- **Live Map aircraft list**: altitudes above the 5 000 ft transition altitude are shown as flight levels (`FL350`), feet below it; the vertical rate is shown after the altitude when at least 100 fpm (`+1,850 fpm`); a small one-colour ▲ / ▼ at the right end of the first row marks aircraft climbing / descending at least 300 fpm; the heading correction is shortened to `HC +1.3 own`
- **Windshear page, Light theme**: the ILS profile dots and callsign labels (ON / HIGH / LOW), the barb HW / XW component labels and the legend, and the Approach History callsigns, runways and wind components use darker shades of the dark-theme pastels (light green, yellow, pink and light blue were hard to read on the pale background). The source / storage mode badges in the top bar are also readable in the Light theme
- **Live Map layout**: the Atmosphere Profile panel width follows the available height (0.73 × height, at least 540 px, at most 45 % of the window), so the Skew-T keeps its shape on large screens (about 900 px wide on 2560 × 1600 instead of a fixed 540 px); on a tablet in portrait (narrower than 1 100 px, taller than wide) the map is left out on purpose and the aircraft list and Skew-T share the width, with METAR / TAF below. The map re-measures itself when its size changes (rotation)
- Sounding page Indices: the 0–3 km lapse rate and the 1000–500 hPa thickness are no longer computed across a data gap of a thin (night) Mode S profile (one 3-aircraft hour gave 509 instead of 537 dam)
- Skew-T: the top pressure label (200 hPa; 850 hPa in airport zoom) is written just below its line, so it is no longer cut off at the top edge
- **Windshear page**: the Wind Rose button is labelled `WR / ACI` — the panel also holds the Approach Conditions Index (ACI) view; the README uses the ACI abbreviation
- **Windshear ILS profile labels**: the callsign labels are drawn last, on a small background box, so the wind barbs and the glideslope no longer cover them; a label that would overlap another one is moved up
- **Sounding page level table**: listed from the highest level (lowest pressure) at the top to the lowest at the bottom, in line with the Skew-T diagram

---

## v.12102026 — 2026-10-12 (Live Map aircraft list sorted by altitude, heading correction in the list; Windshear map follows Light / Dark; Jokioinen radiosonde on the Skew-T; sounding selector, sonde table columns and automatic Sonde check on the Sounding page; go-arounds begun over the runway; quality check of the radiosonde profiles; Indices panel on the Sounding page; AP box on the Windshear flight strips)

- **Radiosonde on the Skew-T** (Live Map Atmosphere Profile and Sounding page): new **Sonde** tick box (off by default, shared) adds the Jokioinen sounding — temperature (pink), dewpoint (green dashed: humidity aloft) and winds (pink barbs inside the right edge) — with its age (`JOKIOINEN 12.10. 06 UTC · 4 h 35 min old`, fading after 6 / 12 h), the difference of the area profile from it (`Δ area−sonde: T … K (RMS …) · wind … kt RMS`) and its values in the hover read-out; partial FMI profiles are labelled with their top (`to 350 hPa`). On the Sounding page the sounding launched by the end of the shown hour or flight is used. New `collector/sondes.py`: background fetch from FMI open data about 1.5 h after the 00 / 06 / 12 UTC launches, stored as small gzipped JSON files in `data/soundings/`, kept `SONDE_KEEP_DAYS` (default 365); optional `SONDE_FETCH`, `SONDE_PLACE`, `SONDE_DIR`. New `/api/sondes` and `/api/sonde`. `data/soundings/` is added to `.gitignore`
- **Sounding page — sounding selector and sonde columns**: with **Sonde** on, a selector lists all stored soundings (Auto = the rule above, or any sounding to compare with the shown profile), and the level table adds Sonde T, ΔT (amber > 2 K), Sonde wind and ΔV (vector difference, amber > 10 kt)
- **Sonde check** (new fourth view of the Sounding page, period 7 d / 30 d / 90 d / 1 y): automatic verification of the Mode S area profile against the radiosonde. New `collector/sonde_verif.py`, run by the hourly jobs, fills the new table `sonde_verification`: each stored sounding vs the area profile of ±1 h around its launch, and each archived hourly profile vs the newest earlier sounding (with its age). Shown as totals (temperature bias ± SD, wind vector RMS), a table per altitude band, the list of verified launches and two bar charts of the temperature / wind RMS difference by the age of the sounding (0–1 … 18–24 h). Missing rows of the last 14 days are added at each run. New `/api/sonde/verification`

- **Windshear flight strips**: autopilot engaged is shown as a framed `AP` box in the strip's top row, left of the glideslope badge (white frame; dark in the Light theme), instead of the `*` after the callsign. The ILS profile labels keep the `*`
- **Indices panel on the Sounding page** (between the diagram and the level table; hideable): stability indices and characteristic levels of the shown Mode S profile and of the radiosonde side by side, computed by the same code (new `static/js/skewt_indices.js`, built on `skewt_analysis.js`) — surface parcel (LCL, CCL and convective temperature, dry thermal top, LFC, EL, CAPE, CIN, Lifted Index), Showalter, K index, Total Totals and precipitable water (sonde only: they need humidity aloft), Vertical Totals, 0 / −10 / −20 °C levels, tropopause, contrail levels, lapse rates (0–3 km, 850–500, 700–500 hPa), 1000–500 hPa thickness, 850 / 700 / 500 hPa temperatures, bulk shear 0–1 / 0–3 / 0–6 km, max wind, low-level jet, lowest inversion, turbulence layers and thermal advection. The sonde is averaged into the Mode S layers. The level table is more compact on screens narrower than 1 800 px and moves below the diagram under 1 250 px
- **Quality check of the radiosonde profiles** (`collector/sondes.py`): a sounding is cut at a data gap (≥ 25 hPa or 500 m) across which the temperature does not change although the air below and above it cools like the troposphere — the 12 Oct 00 UTC Jokioinen profile had no data from 519 to 422 hPa and was about 11 K too warm above the gap. Applied when storing and when reading (also to files stored earlier). The diagram label shows `to 519 hPa (bad data above cut)`, the Sounding page selector `(cut)` with the reason on hover; `/api/sonde` and `/api/sondes` return `qc`. Sonde check rows made with a different version of a sounding (cut, or a fuller copy stored later) are recomputed: the 12 Oct 00 UTC launch changes from T −1.5 K / RMS 4.5 K to +0.5 K / 1.0 K
- **Go-arounds begun at or after the threshold are counted**: a missed approach that starts over the runway — a low go-around near the decision altitude, a low approach or a touch-and-go of training circuits — climbs outside the ILS corridor, which ends at the threshold, so the go-around detector missed it and only the pending landing was cancelled (in 24 Sep – 12 Oct about 12 such climb-outs had no go-around recorded, e.g. the training circuits of 5, 6 and 9 Oct). Now a threshold-crossing that climbs away more than 200 ft is counted as a go-around on the runway of the approach (log entry marked `low`, the final landing gets the go-around count and the return-approach badge). A threshold-crossing landing is confirmed after 60 s instead of 20 s, so the ground roll of a touch-and-go is not recorded as a landing. A go-around confirmed over the parallel runway's corridor keeps the runway of the approach. Departure profiles of such climb-outs get `ga` = 1
- **Live Map aircraft list**: sorted by altitude, lowest on top, by default; a sort button in the panel title steps Alt ↑ / Alt ↓ / A–Z (remembered in the browser). The meteo line shows the aircraft's heading correction after the temperature (`· HDG CORR +1.6 own`, source own / type / fleet / default, `excluded`)
- **Windshear page**: the map style follows the page's Light / Dark button (Dark ↔ Grey, Black ↔ ATC; a page opened in Light starts with Grey), and the ILS profile, wind rose and conditions chart are redrawn at once on a theme change (they changed only with their next data refresh, up to 60 s later). Overlay loads of a quickly changed map style no longer stack

---

## v.11102026 — 2026-10-11 (Airport low-level profile from landings and departures; departure climb-out capture; monthly archive before purge and snapshots; layer-aware write throttle; Sounding page with the Live Map Skew-T; METAR dewpoint and surface parcel on the Skew-T; Skew-T user guide v2; data-validity indicator on the Skew-T; fresh radar replies for the approach winds; METAR wind on the ILS profile)

- **Airport low-level profile** on the Live Map Atmosphere Profile — new **Airport** selector (Off / Overlay / Zoom): Mach/TAS temperature and wind per 200 ft band from 200 to 3 000 ft MSL, pooled from every raw reply of the landings and departures of the last 60 min (new `/api/lowlevel`, `web/api/lowlevel.py`), for low-level inversions that the 1 000 ft layers of the area profile smooth out. **Zoom** shows the surface … about 840 hPa with less skew, finer isobars, isotherms and adiabats, the airport temperatures labelled and its winds. With Analysis at Stability or higher, significant airport inversions are shaded and a second, amber-framed stability strip (600 ft slabs) is drawn; hover shows the band, flights, replies and spread
- **Departure climb-out capture** (new `collector/departures.py`, table `departure_profiles`): each departure is followed from below 1 500 ft MSL near the airport to 3 300 ft, and every raw BDS 5,0 / 6,0 reply is turned into Mach/TAS temperature and (bank ≤ 5°, heading-calibrated) wind per 200 ft band, with the altitude interpolated between sweeps; one row per departure. Kept `DEPARTURE_PROFILE_DAYS` (default 90) days; `DEPARTURE_PROFILES = False` turns it off
- **Archive before purge** (Maintenance page, new `database/archive.py`): when on, every flight & meteo purge (automatic and manual) and the retention purges of `approach_series` / `departure_profiles` first copy the rows to monthly archive files `modes_meteo_archive_YYYY-MM.db` (same ids, checked day by day; nothing is deleted if the copy fails, e.g. disk full). New **Archive Files & Snapshots** panel: folder and free space, list of archive files and **Create snapshot now** (compact copy of the whole database, `VACUUM INTO`). Optional `ARCHIVE_DIR`. New `tools/archive_query.py` combines the archive files and the running database into one analysis database or runs a query on them
- **Layer-aware write throttle** (`WRITE_ON_LAYER_CHANGE`, default on): an observation with meteo data is also stored when the aircraft has entered a new sounding layer since its last stored row (≥ 5 s apart), so climbing / descending aircraft get a value in every layer of their own profile; a few per cent more rows. (A test on the stored data showed that a shorter interval would not improve the area profile.)
- Maintenance statistics also show `departure_profiles`
- **METAR dewpoint on the Skew-T diagrams** (Live Map Atmosphere Profile and Sounding page): green diamond on the ground line; the ground hover adds dewpoint, spread, relative humidity, a quick cloud-base estimate and the lowest METAR cloud group. **Analysis Full** adds the **surface parcel**: LCL (cumulus base estimate) where the dry adiabat meets the mixing-ratio line, shown with the METAR cloud group for comparison (`LCL 2,100ft AGL · METAR FEW030`, `Cu base` when the dry thermals reach it), the parcel curve along the moist adiabat with the CAPE area shaded, CAPE / CIN, Lifted Index (500 hPa), equilibrium level, and a fog / low stratus flag for a small spread; details on hover. The METAR parser moved to `skewt_chart.js` (shared)
- METAR temperature, dewpoint, QNH and lowest cloud group are stored with each landing (`rough_json` → `metar`: `tt`, `td`, `q`, `cld`) and with each hourly profile (`profile_hours` → `m`, shown on the Sounding page's **Area · hour** with the ground line, dewpoint and parcel analysis); no extra database writes
- Departure climb-out profiles are also stored with winds only (≥ 3 bands with temperature or wind): turboprops report no Mach, so their climbs were dropped before
- Zoom mode: shear / turbulence labels of layers outside the zoomed range are no longer stacked at the top
- **Skew-T user guide, version 2** (`doc/SkewT_User_Guide.pdf`, 13 pages): new sections on the airport low-level profile, the surface parcel with the METAR dewpoint (LCL vs METAR cloud, CAPE / CIN, Lifted Index, fog / low stratus flag — with a real low-stratus case of 11 Oct 2026) and the Sounding page; dewpoint and Airport selector in the diagram anatomy; heading correction, limitations, quick reference and formulas updated; all screenshots renewed
- README describes the current features only: the dated "since …" / "before …" notes were removed (the history is kept in this changelog); notes on older database rows (`NULL` columns etc.) remain, without dates
- README screenshots updated (main screen, Approach / Windshear) and a Skew-T screenshot (Atmosphere Profile, Analysis Full) added to the Atmosphere Profile section
- **Data-validity indicator on the Skew-T** (Live Map and Sounding page): a badge `DATA GOOD / FAIR / LOW · N aircraft · N obs` from the distinct aircraft behind the area profile (≥ 20 / 8–19 / < 8 per hour); layers from only one or two aircraft get a red ring and red value, and the hover read-out gives the aircraft count of each layer with a warning for single-aircraft layers. The Sounding page table has an A/C column. `/api/sounding` returns `aircraft` and per-level `ac_count`; the hourly profile archive stores them too (`a`, and `ac_count` in the levels). A **Data quality** tick box in the diagram title (Live Map and Sounding page, shared setting, default on) shows or hides the indicator
- Departure profiles: the go-around flag `ga` is set only when the aircraft was established on an approach; the windshear tracker also holds departing aircraft seen on the runway, so about a quarter of normal departures were flagged on the first day (the flag is not used by any page)
- **Fresh radar replies only where the altitude matters**: the live wind is recomputed with every message from the latest BDS 5,0 / 6,0 pair (up to 60 s old), so low on final, where the radar replies stop while ADS-B positions continue, a wind measured higher up was placed at the aircraft's current altitude (28–33 % of the live approach winds at 400–600 ft on 10–11 Oct were exact copies of the band above). Now the wind and Mach/TAS temperature are used only when the older reply is at most `WIND_MAX_AGE_SEC` (new optional key, default 6 s) old for stored observations, the Windshear ILS barbs, approach bands, wind rose buffer and detection (also the IAS of the kinematic check) and the Live Map aircraft profile; the live display keeps the latest value. Replaying 211 stored approaches: bands above 1 200 ft unchanged
- **METAR surface wind on the Windshear ILS profile**: with Barbs on, a cyan barb at the threshold (`MET 050/9G19`, with the HW / XW component when active) — the lowest true wind of the profile. `/api/wx` → `metar_wind` also gives the gust
- **Skew-T user guide, version 3** (`doc/SkewT_User_Guide.pdf`, 14 pages): new section on the data-quality indicator (badge, single-aircraft rings, hover warning, Data quality tick box, typical aircraft counts by hour) with a night example; why the range bars are wider low down; Sounding page A/C column; quick reference and all screenshots updated
- The airport legend of the Skew-T (`AIRPORT 60 min: …`) is drawn on a label background, so it stays readable where it crosses the top of the curve
- README: why the 10–90 % range bars of the area profile are wider at low altitude (Mach / TAS step size), with typical widths
- Live Map aircraft list: the wind and temperature reading is shown without the wind / thermometer symbols, separated by a dot (`245 kt @ 270° · -45.3°C`)
- **Sounding page uses the Live Map Skew-T**: the diagram code of the Live Map *Atmosphere Profile* moved to the new shared `static/js/skewt_chart.js`, and the Sounding page now draws with it (sized to the window) instead of its own older renderer — same look, hover read-out, **Analysis**, **Smooth** and **Airport** controls (settings shared with the Live Map). The airport low-level profile follows the shown period (Area · now: the selected window; Area · hour: that hour; Flight: the flight ± 15 min; new optional `end` parameter of `/api/lowlevel`); the METAR ground line is drawn for Area · now

---

## v.10102026 — 2026-10-10 (GPS spoofing indicators: 2+ independent checks marked; dry and moist adiabats, smoothing, ground line and automatic analysis on the Skew-T diagrams; BDS 4,5 temperatures no longer used; per-airframe heading calibration; registrations on the Live Map)

- **Live Map — registrations**: the aircraft list shows the registration next to the callsign and the aircraft type before the altitude; the aircraft detail panel header shows the callsign with registration · type · ICAO24 (it showed only the ICAO24 code before); the map popup shows the same identity line; new **Registration** option in the map label selector. Registration and type come from the Radarcape JSON feed or BaseStation.sqb (now included in the live stream)
- **Per-airframe heading calibration** (new `collector/heading_cal.py`): the system learns each airframe's heading offset (reported BDS 6,0 magnetic heading vs the true heading, mostly from outdated magnetic-variation tables in the avionics; +1.5° on average, 1° ≈ 8 kt wind error at cruise) by comparing its wind with the other aircraft in the same altitude layer over the last 60 min, and corrects the wind. Own value after 2 flights, otherwise aircraft-type median, fleet median or 1.5°; airframes over 5° are excluded; the learnt sums fade with a 30-day half-life and an airframe restarts when three flights in a row disagree. The corrected wind goes to `best_wind_*` (used by all pages, area profiles, Windshear and the approach profile winds); the raw wind stays in `wind_spd / wind_dir`, and the offset and its source are stored per observation (`hdg_off`, `hdg_src`). Learnt values are kept in the new `heading_cal` table, written once an hour; on the first start the offsets are learnt from the last 30 days of stored observations. In the replayed data the area-mean wind difference to the Jokioinen soundings fell from 11.1 to 8.9 kt RMS. Optional `HEADING_CAL_*` config keys (`HEADING_CAL_MODE` = apply / learn / off), new `/api/heading_cal`, and a **Hdg corr** cell in the Live Map aircraft detail panel
- **BDS 4,5 (MHR) temperatures are no longer used** for `best_temp` (`collector/filter.py`) or in `TEMP_SQL` (`collector/atmos.py`: area profiles, Sounding page, Live Map Skew-T, hourly profile archive). Most were other Comm-B registers misidentified as BDS 4,5 — two thirds more than 40 K from ISA — and they widened the layer p10–p90 spreads by up to 60 K, while making up only 0.5 % of the temperatures. Temperature now comes from MRAR or Mach / TAS only; the raw value stays in `mhr_temp`
- **Skew-T user guide** (`doc/SkewT_User_Guide.pdf`, 10 pages): how to read the Live Map Atmosphere Profile — upper-air parameters, data sources and accuracy, every element of the diagram, aircraft overlay, smoothing, all Analysis levels with screenshots, limitations (no humidity, layer resolution vs radiosondes, sampling) and a quick reference
- **Skew-T diagrams — dry and moist adiabats**: faint dry adiabats (solid) and moist / saturated adiabats (dashed), every 10 K, on the Sounding page (with a key) and the Live Map Atmosphere Profile, for reading the stability of the measured temperature profile. Reference curves only, no humidity data needed. The Live Map right panel is wider (540 px, was 460 px) to keep the diagram readable
- **Live Map Atmosphere Profile — Analysis button** (panel title; click or mouse wheel: Off / Levels / Stability / Turbulence / Advection / Full): automatic analysis of the 60-min area profile with labels at the right edge — tropopause band, 0 °C level(s), max wind / jet and low-level jet; −10 / −20 °C levels, inversions and a stability strip (unstable / conditionally unstable / stable / inversion vs the adiabats); wind shear and Richardson-number turbulence risk. The Advection level adds warm / cold air advection from the wind turning with height (thermal wind, 850–250 hPa layers, K/h) and contrail formation levels with Schmidt–Appleman threshold curves; Full adds the dry thermal top (METAR surface temperature lifted along the dry adiabat). Temperature and wind only; new `static/js/skewt_analysis.js`
- **Live Map Atmosphere Profile — ground line**: the airport's station pressure from the METAR QNH and field elevation is drawn as a ground line (area below shaded) with the METAR surface temperature; hover shows QNH, station pressure and temperature. At low QNH the lowest pressure-altitude layers lie below ground. `/api/wx` also returns `elev_ft`
- **Live Map Atmosphere Profile — Smooth selector**: Off / 3 layers / 5 layers vertical running mean of the 60-min area temperature profile (weighted by the number of replies), e.g. for comparing lapse rates with the adiabats; the hover shows the smoothed and the layer value; remembered in the browser
- **GPS Quality — Severity & Spoofing panel**: aircraft flagged by two or more independent checks in the same hour (ADS-B vs MLAT, GNSS − baro altitude, position jump) are counted on a new `2+ independent indicators` row and marked with a pink `2+` badge in the flagged-aircraft list; a `2+ only` button shows just those. A single large ADS-B / MLAT mismatch is more often an MLAT outlier; agreeing checks are the convincing spoofing cases
- **GPS Episodes**: `SPF` / `SPF 2+` chips after the signal chips for episodes with spoofing indicators, a **Spoofing** filter (Any / Any indicator / 2+ independent) and a note in the detail popup when 2+ independent checks agree

---

## v.09102026 — 2026-10-09 (Air temperature from Mach / TAS and new Skew-T soundings; approach wind / temperature profile, autopilot and raw series; hourly profile archive; GPS Quality: 10-minute resolution, severity split and spoofing indicators)

- **GPS Quality — finer data for later analysis**, all stored in the existing hourly rows, checkpoint and episode rows (no extra database writes):
  - **10-minute resolution**: each hourly row now also holds six 10-minute slots with the aircraft seen, degraded, severely degraded and with a spoofing indicator (all altitudes and FL050–250), per zone
  - **Severity split**: a degraded aircraft is *severe* when its position is unusable (NACp 0, NIC 0 or no own ADS-B position); counted per FL band separately from the milder NACp / NIC 1–6 cases
  - **Spoofing indicators**: own ADS-B position disagreeing with the MLAT position, GNSS − barometric altitude difference (from the velocity message) jumping or at its limit, and confirmed position jumps faster than the aircraft can fly. Recorded per FL band, with a list of the flagged aircraft per hour, and on the episode rows. The degradation counts and charts are unchanged
- **GPS Quality page shows the new data**:
  - **`10 min` view** of the time-series chart: degraded aircraft per 10 minutes split into severe / mild, the share of FL050–250 traffic degraded and markers for aircraft with a spoofing indicator (up to 7 days)
  - **Severity & Spoofing panel** (right column, `1d` / `7d` / `1m`): severe vs degraded aircraft-hours, severe sweeps by kind, the spoofing indicators with how often each check could be made, and the list of flagged aircraft
  - **Severe 24h** in the summary bar, severe aircraft-hours in the heatmap hover text, and a red marking for aircraft with a severe (unusable) position in the live table; the signal key explains severity and the spoofing indicators
  - New API `/api/gps/detail`
- **Air temperature from Mach / TAS**: every observation with a BDS 5,0 + 6,0 pair now gets the static air temperature from the aircraft's true airspeed and Mach number (`tm_temp`, also `best_temp`). Until now temperature came only from the rare MRAR / MHR replies (147 of 35 841 observations on 8–9 Oct); now about 85 % have one. One reply scatters ±1–4 K (more at low speed), the layer means agree with the Jokioinen radiosonde within 0.7 K on average. Temperature priority is now MRAR → Mach/TAS → MHR (the BDS 4,5 hazard reports proved unreliable). The live map and aircraft details show it too
- **Sounding page rebuilt**: **Area · now** (all aircraft within 150 km over the last 30 min – 3 h, the new default), **Area · hour** (hourly archive) and **Flight** (as before). Altitude layers of 1 000 ft (2 000 ft above 10 000 ft) at the standard-atmosphere pressure of the pressure altitude, trimmed-mean temperature with its 10–90 % range, vector-mean wind; older observations get their temperature from the stored TAS and Mach. The area sounding was almost always empty before (it binned by the rarely reported pressure). The Skew-T axis labels, which were clipped away, are shown again, and overlapping value labels are thinned
- **Hourly profile archive** (`profile_hours`): wind and temperature per altitude layer of every completed UTC hour, computed from the observations a few minutes after the hour (one read, one insert; missing hours back-filled at startup), kept after the observations are purged
- **Approach history additions** (no extra database commits): autopilot state on final from ADS-B (`rough_json` `ap`: altitude where it was switched off, share engaged below 1 000 ft), a per-200-ft wind / headwind / temperature profile of each final approach (`prof_json`, `prof` in the API), and the raw BDS 5,0 / 6,0 reply series behind the roughness statistics (`approach_series`, about 2–3 kB per landing, kept `APPROACH_SERIES_DAYS` = 90 days, optional config key)
- **Live Map Atmosphere Profile**: wider panel (460 px) and a temperature scale centred on the typical profile; temperature curve with values for the selected aircraft (stored observations get their Mach/TAS temperature too); the area profile of the last 60 min in grey (with its values and wind barbs when no aircraft is selected); altitude markers in km; the temperature scale, which was clipped away, is shown; hovering shows altitude (ft / FL / km), pressure, temperature and wind of the nearest level
- **Windshear — autopilot mark**: a `*` after the callsign on the ILS glideslope profile and in the flight strip (e.g. `FIN64A*`) when the aircraft reports the autopilot engaged (ADS-B version 2 only; no mark = off or not reported)
- Maintenance page statistics also list `approach_series` and `profile_hours`; approach-history purges also remove the matching series
- **Spoofing indicators refined** (after the first hours of data):
  - ADS-B / MLAT mismatch is counted only when it repeats on two consecutive comparisons with new positions — single MLAT or decoding outliers (one 144 NM mismatch in the first hours) are ignored
  - Flags raised while the aircraft reports **normal GPS quality** (NACp ≥ 7, no degradation signal) are counted separately — the strong spoofing case; the first flags all came during jamming (NACp 0), where they are more likely the receiver re-acquiring. The flagged-aircraft list now also stores the NACp at the first flag. Shown on the GPS Quality page (Severity & Spoofing panel: *normal GPS* column, NACp column, yellow marking)
- README: the GPS jamming note for test users is now general (jamming is common in the whole EFHK and Gulf of Finland area) instead of describing specific runways and dates
- **Live Map — track line of the selected aircraft fixed**: the dashed line could vanish during a long climb or descent (it shared the capped profile history, from which new altitude points pushed the stored positions out) and was lost when the aircraft briefly disappeared from the map. The line now keeps the stored positions of the flight, continues with the live positions, and stays (with the selection) while the aircraft is temporarily missing
- **Live Map**: clicking an empty spot on the map, pressing Esc or closing the aircraft's map popup (its ×) deselects the aircraft, returning the Atmosphere Profile to the area profile (as the ✕ in the detail panel)
- **README audit** (checked against the code): corrected the NACp accuracy table (also in the GPS Quality signal key), the `METEO_ONLY` flight-row note, the status indicator (`Error` on pages other than Live), the Wind Map QNH example (+416 ft), the Windshear noise-reduction and Baseline thresholds (10 / 15 / 25 kt), the NONE-circle stale-out (45 s in the browser, 30 s on the server), GPS hourly rows per rollover (3), the autopurge interval (24 h), the approach-history data volume (about 2 kB per landing), the ISA-deviation sample rules and the config example (go-around keys added; which keys are optional); added the hourly-jobs thread, the wind vectors on the Live Map and how to open the Maintenance page
- Live Map aircraft details now show MRAR humidity and turbulence (they were not sent to the page); Approach History Hi/Lo button tooltip and Sounding note corrected
- **GPS Episodes**: new columns `severe_sweeps`, `spoof`, `max_mlat_nm`, `mlat_cmp`, `gmb_min`, `gmb_max` (added automatically at startup); the detail popup shows them for new episodes

---

## v.08102026 — 2026-10-08 (Approach-conditions index class factors; Approach History registration filter; one browser tab per page)

- **Navigation — one browser tab per page**: the navbar links now open each page in its own tab. A page that is already open is brought to the front without reloading (e.g. going from Windshear to GPS Quality and back keeps the Windshear selections); a page that is not open yet opens in a new tab
- **Approach History — registration filter**: a small `Reg: OH-A` box left of the date field shows only the landings whose registration starts with the typed text (e.g. `OH-ATR` or `OH-A`; case and hyphen ignored, `Esc` clears). It applies at once, survives the automatic refresh and window / date changes, and the title shows e.g. `3 of 24 landings` while a filter is active
- **Approach-conditions index — aircraft class factors measured**: on 356 landings, each landing's score was compared with the other landings within ±45 minutes. Relative to narrowbodies, turboprops respond about 1.5 times and widebodies about the same as narrowbodies, so the turboprop factor was raised from 1.35 to 1.5 and the widebody factor from 0.85 to 1.0 (widebodies were scored about 15 % too high). Regional jets (1.15) and business jets (1.25, still too few landings) are unchanged. Past landings are re-scored automatically

---

## v.07102026 — 2026-10-07 (Optional BaseStation.sqb registration source; wider Approach Conditions chart; approach-conditions index re-tuned)

- **Approach-conditions index re-tuned** on 236 landings (METAR 6–20 kt): IAS fluctuation 45 % (0.6 → 3.0 kt), vertical-rate fluctuation 30 % (30 → 160 ft/min), bank-angle fluctuation 25 % (0.4 → 2.5°); the crab-angle variation showed no relation to the wind and is now shown for information only. The previous scale was compressed (median 2.4 at 13–16 kt); now about 1 when calm, 3 at 9–12 kt and 4.3 at 13–16 kt. Past landings are re-scored automatically (the index is not stored)
- **Registrations from an optional BaseStation.sqb**: when the Radarcape JSON feed has no registration / type for an aircraft, it is looked up by ICAO24 in `data/BaseStation.sqb` (optional; path configurable with `BASESTATION_DB_PATH`), e.g. as kept up to date by [modes_logger](https://github.com/oh2gax/modes_logger). The registration blocklist therefore now also catches aircraft the JSON feed has no registration for. Read-only, cached per aircraft, re-read when the file changes, ignored when the file is missing. New module `collector/aircraft_db.py`; `data/*.sqb` added to `.gitignore`
- **Windrose panel — Cond view**: the approach-conditions chart widens to the width of the map controls bar (the wind rose keeps its size), and the range button now cycles `3h` → `6h` → `12h` → `1d`; the data request follows the selected range

---

## v.06102026 — 2026-10-06 (GNSS logging: per-band GPS detail, degradation episode log, GNSS quality in Approach History; approach roughness logging and approach-conditions index; GPS Episodes page; GPS Quality heatmap % aircraft mode; memory audit; GPS episodes survive restarts)

- **GPS episodes survive restarts**: the open episodes are saved with the 60-s checkpoint and once more when the server is stopped (SIGTERM from systemd / `kill`, or Ctrl+C — both now write a final checkpoint, which also saves the hour in progress). After a restart within 10 minutes they continue; before, every restart cut the episodes in progress in two (the first part was lost and a new episode started after the restart — about 30 such splits on 6 Oct). After a longer stop they are saved with the new end reason `shutdown`, shown as *Server stopped* on the GPS Episodes page
- **Memory audit** (long uptime on the Pi): the database writer now forgets flight sessions and write-throttle timestamps of inactive aircraft every 10 minutes (they kept one entry for every aircraft ever received); closed GPS episodes waiting for a failed DB write are capped at 20 000; `/api/windshear/approach-history?window=` is capped at 31 days; the Live Map page drops callsigns of aircraft that are no longer live (it kept every callsign while the page stayed open)
- **GPS Quality heatmap — `Events` / `% aircraft` mode**: % aircraft shows the share of the aircraft in each FL band that were degraded (aircraft-hours, from the per-band detail recorded since today), on one colour scale for all rows. Hovering a cell shows events, degraded / seen aircraft and the signal mix; clicking a cell opens GPS Episodes for that day and FL band in a new tab (`?date=…&fl=…`). GPS Episodes' altitude filter now matches episodes whose altitude range overlaps the band
- GPS Quality: completed hours kept in RAM no longer hold their per-aircraft sets (only needed while the hour is counted), which keeps memory use flat over a long uptime; the per-band detail is reloaded from the database for the last 31 days at startup
- **New GPS Episodes page** (`/gps-episodes`, nav link right of GPS Quality): the individual degradation episodes on a map (line from the start position to the last degraded position, coloured by how it ended — recovered / lost / left coverage / below min alt — with the recovery point), in a list with signal chips, flight level, distances, end and NACp / NIC minimum, and in an altitude-vs-distance chart of start, recovery and lost points. Selecting an episode in any view highlights it in the others and opens a detail popup. Rolling window 3h–1w or one UTC day (`dd.mm.yyyy`), filters for minimum duration, signal, end and altitude. "Lost" episodes ending at the coverage edge (≥ 130 NM, optional `GPS_EPISODE_EDGE_NM`) are shown as "left coverage". New API `/api/gps/episodes`. First version, to be tuned with more data
- **GPS Quality — per-band detail in the hourly rows**: new `band_detail` JSON column in `gps_quality_hours` and `gps_quality_zone_hours` with, per FL band, the distinct aircraft seen, the distinct degraded aircraft and the event count per signal. Previously only the event count per band was stored, so it was not possible to tell whether a band's events came from one aircraft or many, or which signal caused them. Also kept in the 60-s current-hour checkpoint, so a restart does not lose it. Collected for analysis only; the page does not show it yet
- **GPS degradation episode log**: new `gps_episodes` table with one row per aircraft per continuous degraded period that starts within 100 NM of the airport (optional config key `GPS_EPISODE_RADIUS_NM`, no change to `config.py` needed). Clean gaps shorter than 120 s are merged. Each row records start, end and recovery position / altitude / track / vertical rate / groundspeed / distance, duration, altitude range, lowest NACp and NIC, the signals seen and how it ended (`recovered`, `lost`, `below_min_alt`). Rows are written together with the existing 60-s checkpoint commit, so no extra database writes. Never auto-purged
- **Approach History — GNSS quality per approach**: new `gnss_json` column in `approach_history` (also returned as `gnss` by `/api/windshear/approach-history`): per 200-ft band the lowest NACp and NIC, the largest age of the aircraft's own ADS-B position and whether the position-freeze gate fired, plus the altitude and distance to the threshold where degradation first and last occurred and where the aircraft recovered. Not shown in the panel yet
- **Approach History — approach roughness per landing**: new `rough_json` column (API field `rough`). While an aircraft is established on final, every raw BDS 5,0 / 6,0 reply — including those the wind calculation rejects for bank > 5° or track rate > 1°/s, which show as Turn rings — is collected for two segments (3 000–1 000 ft and 1 000–200 ft MSL) and summarised as bank-angle RMS / 90th percentile / count over 5°, track-rate RMS, IAS fluctuation about its deceleration trend, vertical-rate fluctuation and crab angle. The METAR wind and gust at landing time are stored with it. Basis for a planned approach-conditions index and its daily / weekly views; nothing is displayed yet
- **Approach-conditions index (provisional)**: one 0–10 number per landing (Smooth / Light / Choppy / Rough / Very rough) from the IAS, bank-angle and vertical-rate fluctuation and the crab-angle variation, with a factor for the aircraft class (turboprops are moved more than widebodies by the same air). Calculated by the server when the data is requested (new `collector/approach_cond.py`, API field `cond`), so later re-tuning re-scores all past landings. The roughness record also gets "high-pass" fluctuation values that ignore slow changes such as the end of the intercept turn or glideslope capture
- **Approach History — new `Cond` display mode**: index badge and level, Hi / Lo segment indices, bank / IAS / VS / crab fluctuation as hi / lo pairs, mean crab angle and the METAR wind at landing; hover a row for the full breakdown
- **Windrose panel — `Rose | Cond` view selector**: the Cond view charts the index of every landing over the last 3 h or 6 h (dots coloured by aircraft class, running median line, level bands) with the last-hour median and level below the chart
- **Maintenance page**: `gps_episodes` row in the statistics and a new *GPS Degradation Episode Log* section with Older Than N Days (default 365) and Delete by Date Range purges (Preview + Purge, as for Approach History)
- Database columns and the new table are added automatically on the first start
- The repository no longer contains the `pyModeS-main` reference copy of the pyModeS library — pyModeS is installed from PyPI (`requirements.txt`), as before

---

## v.05102026 — 2026-10-05 (Approach History landing count)

- **Approach History panel now shows the number of landings** for the selected time window (1h–1d) or date directly after its title, e.g. `Approach History – 24 landings`, in the same small font. The count follows the time buttons, date picker and Live button and updates with each refresh

---

## v.03102026 — 2026-10-03 (Windshear page bug fixes)

- **Fix: ILS profile with Barbs on stopped the page from updating.** The corner label (`🌬 callsign (N obs) · AUTO …`) used a colour variable that only exists inside the per-barb loop (left over from the 2026-05-26 per-barb colouring change), so drawing the profile threw an error whenever Barbs was on and the selected aircraft had at least one barb. The error aborted the rest of each 3-second poll: no corner label, no Turn / GPS / Pre-ILS circles while barbs existed, and the alert banner, emergency squawk alarm, windshear / go-around log, windrose and approach-count summary were not refreshed. The label now takes the selected aircraft's current meteo-source colour
- **Fix: Gradient, Energy, Rate and Baseline detection crashed on their first event.** They referred to an undefined `WS_SEVERE_KT` constant and used `severe` / `moderate` severities that the alert-level filter, strip badges and log colours do not know. All six algorithms now use the same Monitor ≥ 10 kt / Warning ≥ 15 kt / Alarm ≥ 25 kt classification, as documented. (Pair and Kinematic were not affected)
- **Fix: Rate detection** also referred to an undefined reference point; the reference altitude is now the median altitude of the same samples that form the reference headwind, and the ILS-profile zone spans the reference and current altitude (previously the zone would have had negative height and not been drawn)
- Windshear log tooltip: single-aircraft entries consistently show earlier → later values (Rate and Kinematic were reversed); Kinematic values are labelled `IAS−GS` instead of `HW`
- Fix: Sounding page — the Dark / Light toggle did not redraw the Skew-T (it looked for a `sounding-select` element the page does not have); the displayed profile is now redrawn with the new palette

---

## v.30092026 — 2026-09-30 (ILS profile label)

- ILS glideslope profile: aircraft labels show only the callsign (ICAO24 when no callsign is known); the `(+85ft)` glideslope deviation was removed — the dot colour already shows ON / HIGH / LOW

---

## v.28092026 — 2026-09-28 (Collector merge fix, GPS chart bars scaled to events)

- Fix: the live_state merge let `None` values in a new observation overwrite stored values before filtering, although it was meant to overwrite only with non-None values; e.g. the callsign was erased by the next message without a callsign (hidden by the JSON poller and page caches). Now merged as intended
- Analysis of the first v4 days: the same bug had erased NACp with the aircraft's next message in methods 1–3, so NACp was heavily under-counted before v4 (2–10 vs 40–140 events per aircraft-hour now) — v4 had already moved NACp to its own field; jammed aircraft broadcast NACp 0 together with losing their positions, so NACp now largely coincides with ADS-B loss
- GPS Quality time-series chart: stacked signal segments are scaled so the bar height equals the number of events (one sweep can raise several signals, which roughly doubled the bars under v4); tooltips show the real per-signal counts and the events / signals-raised totals

---

## v.26092026 — 2026-09-26 (GPS Quality — per-visit ADS-B loss, restart-safe hours, normalised index, method v4 with NIC)

- **ADS-B loss counted per visit**: an aircraft is flagged when it is transmitting extended squitters now (any DF17 within 30 s) and MLAT knows its position, but it has sent no own ADS-B position for ≥ 45 s during this visit; new `live_state` fields `first_seen` and `last_es_ts`. Also catches aircraft already jammed when they come into range; no longer flags aircraft that stop all extended squitters, and nothing is inherited from earlier visits
- Analysis of the old data showed the previous definition was inflated by never-pruned state: ADS-B loss events per aircraft-hour grew from ~50 after a restart to ~100 after weeks of uptime (fixed by the 2026-09-25 pruning)
- **Restart-safe hours**: the hour in progress (incl. the sets of aircraft seen) is checkpointed every 60 s to the new `gps_quality_live` table and resumed after a restart; an hour interrupted across the hour boundary is saved from its checkpoint; a maintenance purge no longer drops the current hour
- **Counting-method version** stored per hourly row (new `method` column; existing rows set to 1 before 2026-09-25 11:00 UTC and 2 after); time-series chart and heatmap mark each change with a dashed amber `v2` / `v3` line, explained in the bar tooltip; several changes within one bar (e.g. v3 and v4 on the same day in daily views) are shown as one marker (`v3 v4`); the hour in progress during an upgrade keeps the older version tag because it resumes from its checkpoint
- Time-series chart: in daily views the Aircraft line is now the average aircraft per hour instead of the busiest hour (which dropped whenever a restart hit the 13 UTC traffic wave or the day was still in progress); new dashed **Events / aircraft** line — events per aircraft-hour — for comparing days with different traffic
- **Counting method v4**: only aircraft heard by this receiver are counted (new `last_rx_ts`; aircraft kept alive only by the JSON / MLAT list are ignored); **Freeze** now requires the aircraft's own ADS-B positions to keep arriving with identical coordinates (a position that simply stopped updating was counted as Freeze before); **Gap** = still transmitting ADS-B but no position from any source for ≥ 45 s (previously practically never triggered); Freeze / Gap / ADS-B loss are mutually exclusive
- **New NIC (integrity) signal**: NIC and containment radius Rc derived from the airborne-position type code + NIC supplements per ADS-B version; flagged at NIC ≤ `GPS_NIC_THRESHOLD` (default 6, Rc ≥ 0.3 NM); own chart colour, stats line, badge; `nic_events` column
- FL heatmap colours are scaled separately on either side of a counting-method change (segments shorter than 3 days merge with a neighbour), so days recorded with different methods do not distort each other's shading
- NACp is now version-aware (TC 31 NACp ignored for ADS-B version 0, where it is undefined) and used only while fresh (≤ 30 s); live table shows NIC (hover: Rc) and NACv
- Fix: removed a dead pyModeS v2 call (`pms.adsb.nac_p`) that raised a silently caught error on every extended-squitter message; NACp always came from the pyModeS v3 decoder result
- Fix: CPR single-frame fallback now also runs when a cached / MLAT position exists (previously an aircraft still in the decoder's start-up phase looked like it had no own ADS-B position), and no longer decodes surface-position messages with the airborne formula

---

## v.25092026 — 2026-09-25 (Audit fixes, WMM declination and TAS fallbacks for computed wind)

- **Position-freeze gate fixed**: compared consecutive 3-s sweeps against a 100 ft threshold, which a 3° descent (~40 ft/sweep) never reaches, so it never fired; now uses an anchor that only moves with the position — freezes are flagged after ~8–10 s of descent on a stuck position, excluding those sweeps from bands, windrose and trail as intended
- **live_state pruning**: new housekeeping thread in `run.py` removes aircraft unseen for 10 min and prunes the BDS 5,0/6,0 pairing caches every 60 s (previously every aircraft ever received stayed in RAM)
- **Server-side QNH**: METAR QNH is now passed to `WindshearTracker` (`set_qnh`); the glideslope floor gate and `gs_status` are QNH-corrected (high-QNH days no longer reject approaches slightly low of the path) and approach-history bands are captured in MSL; new `approach_history.qnh_hpa` column (auto-migrated; `NULL` on older rows = bands in pressure altitude); no correction until the first METAR arrives
- **Landings tracked through the threshold** are now recorded (threshold crossing + 20 s without climb, record time = crossing time); previously lost because the phase reset on leaving the corridor, and an aircraft lost just past a 04L/22R threshold could be logged on the parallel runway
- Fix: go-around count now cleared on any recorded landing and expires 2 h after the go-around, so a diverted aircraft's later visit is no longer flagged "2nd APP"
- Fix: a ground track of exactly 0° (due north) was discarded as missing in `receiver.py`
- **Large purges no longer drop incoming data**: flight/meteo purges delete in committed batches of 5 000 rows; the collector writer rolls back and keeps a locked batch for retry (up to 50 000 obs) instead of dropping it; SQLite busy timeout raised from 5 s to 15 s
- Fix: date-range flight purge failed entirely (FOREIGN KEY error) when a flight crossed midnight into the start date — flights are now deleted only when none of their observations remain; date-range purge and preview use indexed timestamp ranges instead of `date()` scans
- Fix: "older than N days" flight purge now also skips flights that still own observations, so one inconsistent flight row can no longer abort the purge with a FOREIGN KEY error
- Fix: JSON squawk was never read — the Radarcape field is `squ` (`sqk`/`squawk` kept as fallbacks)
- `/api/stats` (navbar, every 15 s per tab) is now RAM-only; the unused database totals that required a full `COUNT(*)` of the observations table were removed
- Approach History XW column uses signed values like the ILS profile (`+8` from right, `-14` from left) instead of arrows
- **Position-based magnetic declination**: computed wind now uses the WMM2025 declination at each aircraft's position (`pygeomag`, cached 0.5° grid, rebuilt daily) instead of one fixed 10.5° — within 150 NM of EFHK it ranges 8.7°–12.6°, up to ~16 kt wind error at cruise; `MAG_DECLINATION` is now only the fallback; new `USE_WMM_DECLINATION` setting (default on); `pygeomag` added to requirements
- **Better TAS fallbacks**: when BDS 5,0 TAS is missing, Mach is converted with the current ISA deviation estimated area-wide from aircraft reporting both TAS and Mach (instead of plain ISA), and IAS is converted to TAS with the compressible-flow relations (previously used directly as TAS — ~200 kt too low at FL350); no wind is computed when neither TAS nor altitude is known
- New observation columns `tas_source` (`BDS50` / `MACH` / `IAS`) and `mag_decl` (auto-migrated)
- README: documented the above plus previously undocumented config keys, GPS "event" definition, unused overlay files; removed unused `requests` from install instructions; stale code comments corrected; full review against the code — corrected Python version (3.11), ADS-B signal in GPS page descriptions, algorithm details (Energy threshold, Rate reference, GS-ON gate only for Pairwise/Kinematic, NONE exclusion, true runway headings, BDS 6,0 heading resolution), ILS Only not persisted, `MAINTENANCE_AUTH_FILE` / local `config.py` edits, purge duration, project structure

---

## v.24092026 — 2026-09-24 (ILS profile — Val toggle, compact HW/XW labels)

- **`Val` segment** added to the `Barbs · Hi · Auto` group: hides or shows the `dir/spd` label next to each barb; with Val off, plain barbs are drawn, or only the HW/XW component value when a component mode is active; Dcl greys out while Val is off; corner label shows `· NOVAL`; setting persisted in `localStorage` (`ms_ws_barb_val`)
- HW/XW component labels on the ILS profile drop the `kt` suffix (`+25` instead of `+25kt`) — knots are implied
- Fix: enabling Barbs via the `Auto` segment left `Hi` and `HW` greyed out (and unclickable) — now un-greyed together with `Val`

---

## v.07092026 — 2026-09-07 (CARTO API key, GPS Quality range selectors + FL band split)

- **CARTO Basemaps API key**: CARTO now requires a key to remove the tile watermark; added to all three map pages (Live Map, Wind Map, Windshear) as a `?key=...` query param, sourced from a new gitignored `api_keys.py` (`api_keys.py.example` is the committed template) and injected into every page via the existing `inject_config_modes` context processor
- **GPS Quality — `3m`/`6m` time-series range selectors** added alongside the existing `1d`–`1m` buttons; required raising `MAX_BUCKETS` (in-RAM buffer + DB reload cap) from 31 days to 6 months; the heatmap payload is capped independently at 31 days (`HEATMAP_MAX_BUCKETS`) since it never needed more
- **GPS Quality — FL heatmap split into 9 bands**: the old combined `050-100` band is now `050-080`/`080-100` for finer resolution; historical events recorded before the split stay tagged under the old label and won't populate either new band
- **GPS Quality — heatmap gets its own `14d`/`1m` selector**, independent of the time-series chart's range; also fixed the FL Band Analysis donut, which was wired to the time-series selector even though its data source is capped at 31 days — now correctly follows the heatmap's own selector

---

## v.17062026 — 2026-06-17 (ILS profile zoom, HW/XW barb annotation, label declutter)

- **Zoom button** added to the ILS glideslope profile toolbar (purple when active); toggles the horizontal range between 15 NM (full view) and 7.5 NM (zoomed), roughly doubling the horizontal pixel density available for wind barbs; distance grid steps at 2.5 NM intervals in zoomed mode; full 15 NM history always buffered so switching back is instant
- **HW/XW component annotation**: the `HW` button now cycles through three states — off → HW (headwind/tailwind) → XW (crosswind) → off; button label updates to match (`HW` or `XW`); HW mode: amber button, `+12kt` / `-5kt`, green/red/amber colour coding; XW mode: orange button, `+8kt` (from right) / `-3kt` (from left), teal/amber/red magnitude palette matching the Approach History XW column; `xwKt()` function added (`spd × sin(windDir − rwyHdg)`)
- **Dcl works for both HW and XW** — becomes available whenever any component mode is active; places component value below the barb and raw wind above
- **Wind barb labels lifted**: raw wind and component labels shifted clear of the 18 px barb staff; font sizes increased (10 px plain, 9 px raw-alongside-component) and opacity raised for better legibility; label format simplified to `dir/spd` (no degree symbol or kt unit) for compactness
- `barbHwMode` string (`'off'` / `'hw'` / `'xw'`) replaces the former `barbHwActive` boolean; label drawing unified into a single code path; corner label shows `· HW ref …` or `· XW ref …`
- **Fix: NONE-quality aircraft triggering false windshear detections** — all six detection algorithms (Pairwise, Gradient, Energy, Rate, Baseline, Kinematic) now skip any aircraft whose `meteo_source === 'NONE'` (grey) at the top of their per-aircraft loop; previously, an aircraft that accumulated valid wind history and then went NONE during an ILS intercept turn could still fire Rate/Baseline detections via its stale `headwind_kt`, and Energy/Kinematic buffers (`wsGsHistory`, `wsKinHistory`) had no NONE filter at all — all gaps closed

---

## v.14062026 — 2026-06-14 (Wind detection — minimum corridor samples gate)

- **WS_MIN_CORRIDOR_SAMPLES = 6 gate** added to all six windshear detection algorithms; no algorithm can fire until an aircraft has accumulated at least 6 valid observations in the ILS corridor (≈15–20 s at the 3-second poll rate)
- Root cause addressed: the first wind observation for a newly-established aircraft is frequently tagged `meteo_source = MHR` (BDS 4,5 decoded in the same message sweep) and is computed from a BDS 5,0/6,0 pair captured during the ILS intercept roll-out; at that moment roll angle and track rate are near their quality-gate limits, producing a geometrically noisy result; algorithms that compare oldest vs. newest window samples (kinematic, rate) used this noisy first point as the reference, generating spurious detections immediately after the flight strip appeared
- Each algorithm gates differently: pairwise and baseline check `wsWindHistory[icao].length`; gradient checks `pts.length` (altitude-valid wind points); energy promotes `MIN_POINTS` from 4 to `WS_MIN_CORRIDOR_SAMPLES`; rate checks `hist.length`; kinematic checks both raw history length and the 45-second time-filtered window length
- The gate also ensures the 3-sample edge median introduced in the previous release has ≥ 2 samples per edge before any detection fires (EDGE = `Math.min(3, Math.floor(window.length / 2))` reaches 3 only when `window.length ≥ 6`)

---

## v.13062026 — 2026-06-13 (wind detection: F-factor window, declination fix, shear direction signing, median filter)

### Wind detection — F-factor window fix

- **detectKinematic F-factor corrected**: the previous implementation computed F over the full 45-second detection window, which is ~3× longer than the 1 km (≈15 s at approach speed) reference defined by JAWS/FAA; this made the F-gate silently 3× more conservative than intended — an F ≥ 0.10 setting was effectively acting as F ≥ 0.03 in proper units; F is now computed by scanning all 10–20 s sub-windows within the 45-second history and reporting the maximum, which matches the JAWS reference distance; the 45-second detection window (what triggers the event) is unchanged — only the F-factor value and gate calibration are affected
- Also fixed two broken variable references (`oldest.ts`, `newest.ts`, `oldest.gs`) left over from the previous median filter change that would have caused a JavaScript ReferenceError when the Kinematic algorithm was active

### Wind detection — declination fix, shear signing, median filter

- **MAG_DECLINATION corrected**: updated from `8.0` to `10.5`°E (EFHK WMM value for 2026); the previous value introduced a ~2.5° systematic heading error translating to ~6.5 kt spurious wind bias at typical approach ground speeds; the constant is now annotated with a date note and a reminder to re-check every 2–3 years
- **Shear direction signing**: all six windshear detection algorithms now tag each event with `hw_trend: 'loss' | 'gain'`; headwind loss (the operationally hazardous case) is distinct from headwind gain; the alert banner, ILS-profile canvas label, and event log compact line all now show `▼LOSS` or `▲GAIN` so the direction is unambiguous at a glance; event severity thresholds and `delta_kt` magnitude are unchanged
- **Median filter for detectKinematic and detectRate**: instead of comparing two raw endpoint samples (oldest vs. newest), both algorithms now compute the median of the three oldest and three newest measurements in their look-back window before differencing; this suppresses single-sample transients (e.g. a momentary IAS spike or a noisy BDS 6,0 heading decode) without adding meaningful latency — events that persist across 3 samples represent ~9 s of data at the 3-second poll rate

---

## v.12062026 — 2026-06-12 (Maintenance: Approach History purge and delete by day or date range; Approach History duplicate-commit cooldown; Windrose observation timestamps fix)

### Maintenance — Approach History manual purge controls

- **Approach History section** added to the Maintenance page with full manual delete controls; Approach History is never touched by Autopurge, so this is the only way to remove old entries
- **Manual Purge — Older Than N Days** panel: enter a day threshold, Preview shows the row count and date range to be deleted, Purge executes after confirmation; default threshold is 90 days
- **Delete by Date Range** panel: From / To date pickers with Preview + Delete flow, same single-day-by-same-date shortcut as the other sections
- Both operations call `ws_tracker.clear_approach_history()` so the in-RAM approach history list is also cleared, preventing already-deleted entries from re-appearing via the live WebSocket feed
- **Server-side**: 4 new API routes (`/api/maintenance/approach/preview`, `/api/maintenance/approach/purge`, `/api/maintenance/approach/date-preview`, `/api/maintenance/approach/date-purge`) backed by 4 new functions in `database/maintenance.py` (`preview_approach_purge`, `purge_approach_data`, `preview_approach_date_purge`, `purge_approach_date_range`); approach date-range uses the existing `date_utc TEXT` column directly with `BETWEEN`
- Page subtitle updated: "Autopurge covers Flight & Meteo data only — Approach History requires manual action."
- Files changed: `database/maintenance.py`, `web/app.py`, `web/templates/maintenance.html`, `static/js/maintenance.js`

### Maintenance — delete by single day or date range

- **Delete by Date Range** panel added to both the **Flight & Meteo Data** and **GPS Quality Data** sections of the Maintenance page; each panel has From / To date pickers (`YYYY-MM-DD`), a **Preview** button that shows the row counts to be deleted, and a **Delete** button that requires a Preview first and asks for confirmation before executing
- **Single-day delete** works by entering the same date in both From and To fields — a hint below the inputs explains this
- **Preview** shows exact counts before any deletion: observations + flights (flight section) or hourly rows + zone rows (GPS section), plus the selected date range; the Delete button is only enabled after a non-zero preview
- **Server-side validation** rejects malformed dates (must match `YYYY-MM-DD`) and ranges where `date_from > date_to`, returning HTTP 400 with an error message surfaced in the UI
- **GPS delete reloads in-RAM cache** so the GPS Quality page reflects the deletion immediately, matching the behaviour of the existing older-than-N-days purge
- Existing older-than-N-days purge panels and Autopurge are unchanged; panel titles updated from "Manual Purge" to "Manual Purge — Older Than N Days" to distinguish them from the new panels
- Files changed: `database/maintenance.py`, `web/app.py`, `web/templates/maintenance.html`, `static/js/maintenance.js`, `static/css/style.css`

### Approach History — duplicate commit cooldown

- **Root cause:** an aircraft that loses ADS-B contact for more than 30 s (STALE_TIMEOUT_SEC) is pruned and committed to Approach History, then re-admitted when it reappears; if the second state entry also meets the commit condition (e.g. APPROACHING, or NONE+rwy for the GPS-jammed path) a second record is written within the same minute, producing two rows with identical `HH:MM` timestamps; this was particularly visible for helicopters with erratic routes or intermittent ADS-B coverage
- **Fix:** a `_recent_commits` dict (icao → commit timestamp) is maintained in the tracker; before writing a commit, `prune_stale()` checks whether the same ICAO committed within the last 5 minutes (`COMMIT_COOLDOWN_SEC = 300`); if so the duplicate is suppressed silently; go-around second approaches always land 10–15+ minutes after the first and are never affected by this gate; the dict is pruned to entries within 2× cooldown on each commit to keep its size bounded

### Windrose — fix: all observations from same aircraft now ingested on fresh session

- **Root cause:** when an aircraft's windrose observations are flushed to `_windrose_buffer` on landing, every observation in the batch was assigned the same timestamp (`now`); the JS `fetchWindroseObs()` dedup set (`windroseServerTsSeen`) treats identical timestamps as already-seen and skips them, so only the first observation per aircraft survived ingestion — typically 1 out of 5–10 observations per approach
- **Effect:** a fresh browser session with three recent completed approaches would show only ~3 windrose observations instead of ~15–30; the green MODE-S averaged arrow was based on very sparse data and the Hist trend dots were under-populated
- **Fix:** observations are now assigned timestamps 1 second apart (`now − (n−1−i)` for index `i`), oldest first, ending at `now`; all remain within a few tens of seconds of the landing time — well inside the 30-minute and 6-hour windows — so no filtering or bucketing logic is affected; the JS dedup now sees unique timestamps and ingests every observation correctly
- No effect on approach history, band wind capture, or any database writes — only `_windrose_buffer` timestamps changed

---

## v.11062026 — 2026-06-11 (METAR / TAF background polling; go-around count in the statistics panel; GPS-jammed aircraft in Approach History; false "2nd APP" badge fix)

### Weather — METAR/TAF background polling with retry and cache

- **Background WX polling thread** — METAR and TAF are now fetched by a dedicated daemon thread (`wx_poll`) that runs every 10 minutes independently of browser requests; `/api/wx` no longer makes a live NOAA HTTP call on each poll — it returns the cached result immediately, so the browser response is instant
- **Retry on failure** — each fetch cycle retries up to 3 times with a 5-second delay between attempts before giving up on a source; individual retry attempts are logged at DEBUG level; only a full 3-attempt failure triggers a WARNING in the server log
- **Stale-cache fallback** — when a fetch cycle fails entirely for a source, the previously cached value is preserved; brief NOAA outages or network hiccups no longer cause `[unavailable]` in the UI as long as the cache holds a previous successful result
- **`[unavailable]` only on cold start** — the sentinel is returned for metar/taf only if the server has never had a successful fetch yet (first few seconds after startup); thereafter the cached value is always used
- **`cache_age_s` field added** to the `/api/wx` JSON response — seconds since last successful fetch; available for future UI use (e.g. "METAR 8 min ago") but no display change made now

### Statistics panel — go-around count below runway usage

- **Go-around count added to runway usage section** — a `Go-arounds: N` line is appended below the runway percentage bars in the statistics panel; the count is the sum of all go-around events within the active time window (Today / Yesterday / 1w / date picker), computed client-side from the `go_arounds` field already present in each approach record; the label is shown in normal text when the count is ≥ 1 and in muted grey when it is 0; no server or database changes required

### Approach History — go-around callsign highlight + GPS-jammed aircraft logging

- **Go-around callsign highlight** — callsigns in the Approach History table are now shown in amber-yellow when the aircraft performed one or more go-arounds before its final landing; hovering over the callsign shows a tooltip (e.g. `2× go-around`); approaches without a go-around continue to show in the existing light-blue colour; historical rows already in the database before this update default to no highlight (go_arounds = 0)
- **GPS-jammed aircraft now logged to Approach History** — previously, aircraft whose GPS position froze at altitude (~2 000 ft) were silently dropped from Approach History when they went stale because their frozen altitude prevented the `vert_rate`-based descent confirmation (`ga_phase` never reached `"APPROACHING"`); the commit gate in `prune_stale()` now also commits aircraft that have `ga_phase == "NONE"` but a confirmed runway assignment (`approach_runway` set), capturing all aircraft that were geometrically established inside an ILS corridor; band wind columns show `—` for aircraft with no IAS data; runway usage and aircraft-type statistics are now accurate
- **Alert banner now clears when GPS-jammed aircraft stales out** — kinematic detection was accumulating IAS−GS history for `pos_frozen` aircraft; when GPS jams GS (GPS-derived) but IAS (Mode S BDS 6,0, GPS-independent) keeps updating, the differential grows indefinitely and the alert banner stayed active after the aircraft landed; fixed by clearing `wsKinHistory` for any corridor aircraft with `pos_frozen = true` on each poll cycle, matching the existing `pos_frozen` guard already present on the wind-barb history accumulation loop
- **Database migration** — a `go_arounds INTEGER NOT NULL DEFAULT 0` column is added to `approach_history` automatically on first server start via `ALTER TABLE`; no manual schema change needed; existing rows default to 0
- Files changed: `collector/windshear.py`, `database/schema.sql`, `database/db.py`, `run.py`, `web/app.py`, `static/js/windshear.js`, `static/css/style.css`

### Approach history — GPS-jammed aircraft now committed on stale

- **Root cause:** aircraft experiencing GPS position jamming at ~2 000 ft freeze their reported altitude; the frozen altitude means `vert_rate` reports ~0 fpm, so the go-around state machine never accumulates the 5 consecutive descent polls required to transition from `"NONE"` to `"APPROACHING"`; when the aircraft goes stale after losing ADS-B contact, `prune_stale()` only committed aircraft in `"APPROACHING"` state, so GPS-jammed aircraft were silently dropped — missing from runway usage and aircraft-type statistics
- **Fix:** `prune_stale()` now commits an approach history record for aircraft in `"NONE"` phase **when `approach_runway` is set** (meaning the aircraft was geometrically confirmed inside an ILS corridor); the band wind data is committed as-is (all `None` for aircraft with no IAS / NONE meteo source); windrose observations are also harvested under the same condition
- The log line now includes the commit reason (`APPROACHING` vs `NONE+rwy(GPS-jam)`) to make these entries distinguishable in the collector log

### Windshear — false "2nd APP" badge on unrelated approaches

- **Root cause:** `_ga_counts` (the per-ICAO go-around counter) was intentionally designed to survive `prune_stale()` so the "2nd APP" badge would persist through the climb-out phase and still be visible when the aircraft re-entered the corridor; however it was never cleared when the aircraft successfully landed, meaning the same ICAO returning later in the same collector session (a new rotation) would immediately show the "2nd APP" badge even though no go-around had occurred
- **Fix:** `prune_stale()` now calls `self._ga_counts.pop(k, None)` when an aircraft is pruned with `ga_phase == "APPROACHING"` (i.e. confirmed landing); the count is preserved only for the duration of the active go-around sequence and cleared on landing; only `collector/windshear.py` changed

---

## v.06062026 — 2026-06-06 (Windrose historical trend (Hist); go-around second-approach badge and history fix)

### Windrose — historical wind trend Hist button

- **New Hist button** added below the Windrose canvas — cycles Off → 3h → 6h; when active, draws a colored dot on the compass ring perimeter for each past hour bucket, at the bearing of that hour's vector-averaged wind direction; dot radius scales with wind speed (3.5–7 px); consecutive dots are joined by a faint connecting line showing the direction drift path; colors: 0–1h amber, 1–2h orange, 2–3h rose, 3–4h purple, 4–5h violet, 5–6h slate; dots are drawn on the ring perimeter and never overlap the center area where the METAR and MODE-S arrows are drawn
- **Hover tooltip** — moving the mouse over any hist dot shows a small tooltip (e.g. `0–1h: 270°/12kt`) in the dot's own color; no persistent text legend is shown so the readout area stays compact
- **Bug fix** — initial implementation had a `ReferenceError` (`nowMs` used before declaration) that caused `drawWindrose()` to crash whenever Hist was active, blanking the entire canvas including live arrows and timestamps; fixed by moving `const nowMs = Date.now()` to the top of the function
- **Server windrose buffer extended to 6 hours** — `WINDROSE_BUFFER_MAX_SEC` changed from 1 800 s to 21 600 s so the server retains enough history to populate all buckets for a fresh browser session; client-side `recentLandingWinds` pruning and `fetchWindroseObs` ingestion updated to match
- The 30-minute window used for the main MODE-S averaged arrow is unchanged; only the buffer retention and Hist bucketing use the extended window

### Windshear — go-around 2nd approach badge and history fix

- **"2nd APP" badge now appears correctly on 2nd approach** — after a go-around the flight strip badge was never shown because `ga_phase` was stuck in `"GO_AROUND"` state permanently; the state machine was missing the `GO_AROUND → NONE` transition needed when the aircraft re-enters the corridor for its 2nd approach; fixed by adding a `ga_left_corridor` flag that is set when the aircraft leaves the corridor in `GO_AROUND` state and cleared (with `ga_phase` reset to `"NONE"`) when it re-enters; `ga_count` is preserved so the badge shows correctly
- **2nd approach data now saved to Approach History** — as a side-effect of the same bug, 2nd approach wind profiles were silently discarded because `prune_stale()` only commits to Approach History when `ga_phase == "APPROACHING"` at pruning time; with the state now correctly transitioning to `APPROACHING` during the 2nd approach, the wind profile is captured and saved
- **Windrose observations from 2nd approach also saved** — same `prune_stale()` gate; windrose obs for 2nd approaches are now committed correctly

---

## v.04062026 — 2026-06-04 (Windshear statistics date picker, Trk trail button, ILS trail gap detection, no barb stacking during GPS freeze; GPS Quality donut follows the time range)

### Windshear — statistics panel date picker

- **Calendar date picker added to the statistics panel** — a small 📅 button placed after the `1w` button in the stats timerow opens the native browser date picker; selecting any date in history switches both Runway Usage and Aircraft Types sections to show data for that specific UTC day using the existing `?date=YYYY-MM-DD` API parameter
- **Date badge with clear button** — when a date is active, a compact blue badge showing the formatted date (e.g. `04 Jun 2026`) appears in the timerow with an inline `×` button; clicking `×` clears the date selection and returns to whichever Live / Yest / 1w range was previously active
- **Range buttons deactivate during date mode** — Live, Yest, and 1w buttons lose their active highlight when a date is selected; clicking any of them clears the date and switches to that range
- **No persistence** — date mode is intentionally not saved to localStorage; the stats panel always opens on the last-used Live/Yest/1w range, which is the more useful default for operational monitoring

### Windshear — Trk trail toggle button

- **New Trk button** added to the ILS glideslope toolbar after Dcl — toggles the aircraft position history trail on the ILS profile canvas on/off; trail is visible by default (matches previous behaviour); button turns teal when active, matches the style of HW and Dcl buttons
- **Independent of barb mode** — Trk can be toggled at any time regardless of whether Barbs is on or off
- **Preference persisted** to `localStorage` (`ms_ws_trk`) so the setting survives page reloads

### Windshear — suppress vertical wind barb stacking during GPS freeze

- **Wind barbs no longer accumulate during GPS position freeze** — when a GPS jam freezes the aircraft's ADS-B position, the barometric altitude continues to decrease while `dist_thr_nm` stays constant; without a guard the JS wind history buffers would collect observations at the same horizontal position but decreasing altitudes, producing a vertical column of barbs that falsely suggests valid wind data; fixed by adding `"pos_frozen": pos_frozen` to the per-aircraft state dict sent by the server and adding `if (ac.pos_frozen) continue` to both the Lo and Hi wind history accumulation loops in the JS; the `pos_frozen` flag is already computed by the server for band capture and windrose protection — this change simply exposes it to the client for the same purpose
- Approach History, Windrose, windshear detection algorithms and all other features are unaffected

### Windshear — ILS profile trail gap detection, extended

- **GPS-freeze periods now also produce a visible gap in the trail** — the previous fix only broke the trail for ADS-B dropout (timestamp gap in history); GPS freeze was not covered because the server continued appending history entries with the frozen (unchanging) position at regular 3-second intervals, so no timestamp gap existed; fixed by moving `history.append` to after the `pos_frozen` computation in `windshear.py` and adding `and not pos_frozen` to the append condition — frozen-position sweeps are now excluded from the history array, creating a timestamp gap that the existing JS 10-second gap detector converts to a `moveTo` break in the trail

### Windshear — ILS profile trail gap detection

- **History trail no longer connects across position outages** — previously the ILS glideslope canvas drew a straight line between the last known position before a GPS freeze or ADS-B dropout and the first position after it, making an outage look like a normal continuous track; the trail drawing loop now checks the timestamp gap between consecutive history entries and uses `moveTo` instead of `lineTo` when the gap exceeds 10 seconds; the 10-second threshold comfortably separates real outages from normal 3–6 s polling jitter; the blank space in the trail makes the outage duration immediately visible

### GPS Quality — FL Band Analysis donut follows time-range selector

- **FL Band Analysis donut and stats panel now follow the active time-range selector** — previously the donut was hard-coded to a 14-day window regardless of the range buttons (1d / 2d / 3d / 1w / 2w / 1m); the cutoff now uses `RANGE_CONFIG[currentRange].hours` so the donut always shows the same period as the GPS degradation events chart
- **Panel title updates dynamically** — the "FL Band Analysis" header now appends the active range label (e.g. "FL Band Analysis — Last 24 Hours") and updates immediately when the range changes
- **Instant redraw on range switch** — `applyRange` now calls `drawDonutAndStats` immediately after switching so the donut updates without waiting for the next hourly tick or poll cycle; data is taken from the in-memory `lastHeatmapData` buffer so no new API request is needed
- **Hourly refresh unchanged** — the existing hourly `setInterval` continues to fire and will automatically use whatever range is active at that time
- **`lastDonutRange` guard added** — `fetchGpsState` now tracks the last range used for the donut (alongside the existing `lastDonutZone` guard) so a range change detected in the poll loop also triggers a redraw

---

## v.03062026 — 2026-06-03 (Windshear pre-corridor NONE circle improvements and persistence fix)

### Windshear — pre-corridor NONE circle improvements

- **Pre-corridor circles now plot at the correct X-axis position** — previously `dist_nearest_thr_nm` was computed as the raw minimum distance to any runway threshold, which for a RWY15 intercept could snap to a RWY22 threshold (physically closer) and plot the circles at the wrong location on the ILS canvas; fixed by selecting the threshold with a priority order: (1) previously matched approach runway stored in aircraft state, (2) runways whose approach heading is within 90° of the aircraft's current track, (3) all runways as a final fallback when track is unavailable
- **Level-altitude turns now generate multiple circles** — the altitude/distance minimum-gap thresholds (400 ft / 0.5 NM) meant a level localizer intercept stored only the very first observation and silently skipped all subsequent polls; a 15-second time-based fallback is now added to both `wsNoneHistory` and `wsPreCorridorHistory` accumulation loops so at least one new circle is stored every 15 s regardless of altitude or distance movement, giving 3–5 visible circles across a typical 45–60 s intercept turn; wind barb accumulation (`wsWindHistory`) is unchanged

### Windshear — NONE circle persistence fix

- **Orange NONE circles and pre-corridor dashed circles now persist correctly after aircraft transitions from NONE to valid meteo data** — two related bugs caused both circle types to disappear the moment an aircraft started providing good wind data during or just after the localizer intercept turn
- **Root cause 1 — auto-barb lost its target during brief corridor gap**: `runAutoBarbSelection` immediately switched away from `barbAutoTarget` when the aircraft was not found in the corridor list, even if the aircraft was still tracked in the full aircraft list; this happened when a wide intercept turn briefly crossed the corridor boundary at the same moment meteo data became valid; fixed by adding a second guard that keeps the current target if it is still in `allAircraft` and its `vert_rate` is below +400 fpm (descending or level = still on approach); aircraft climbing above +400 fpm (departures, go-arounds) correctly fall through so the selection switches as before
- **Root cause 2 — `drawIlsProfile` early return suppressed circles when corridor was momentarily empty**: when the corridor aircraft list was empty the function returned immediately with "No approach traffic", skipping all NONE circle drawing even though `wsNoneHistory` and `wsPreCorridorHistory` still held valid entries for the selected aircraft; fixed by checking for NONE history before returning — if circles exist for `barbSelectedIcao` the function falls through and draws the grid and circles with no aircraft dots
- **Departure filtering preserved**: the +400 fpm `vert_rate` gate in the auto-barb guard ensures that departing aircraft whose ICAO was previously tracked on approach are not mistakenly held as the barb target; pre-corridor circles for departing aircraft are therefore not shown

---

## v.01062026 — 2026-06-01 (Maintenance page; Windshear statistics panel, compact alert log, pre-corridor NONE circles, remembered algorithm; GPS Quality chart and purge fixes)

### Windshear — statistics panel extended to full page height

- **Statistics panel now extends to the bottom of the page** — the bottom area of the Windshear page is restructured so the right column (Alerts + Statistics) spans the full height including the area previously occupied by METAR/TAF on the right; Statistics gains the extra ~165px previously lost to the wx-strip, giving all runway rows and many more aircraft type rows visible space without scrolling
- **METAR and TAF moved to left column** — the wx-strip is now absolutely positioned inside the left column (ILS side) and extended to 136.67% of the left column width so it covers both the ILS area (METAR, left half) and the alerts area (TAF, right half); METAR and TAF share the strip equally (50/50)
- **Clean single border lines** — careful removal of duplicate border declarations ensures exactly one 1px divider line appears between: alerts bottom and TAF top (horizontal), and alerts right and statistics left (vertical)
- **Layout structure**: `ws-bottom-grid` (new flex-row wrapper) contains `ws-bottom-left` (ILS canvas + absolute wx-strip) and `ws-ws-log` (alerts capped at original height + statistics fills remaining full height)

### Windshear — statistics time range selector + runway section fixes

- **Statistics time range selector** — three compact buttons added to the statistics panel: **Live** (today's UTC data, default), **Yest** (previous UTC day), **1w** (last 7 days via `?window=604800`); switching range immediately re-fetches and updates both Runway Usage and Aircraft Types sections and updates the section labels accordingly; selected range persisted to `localStorage` (`ms_ws_stats_range`)
- **Runway Usage section now scrollable** — previously the runway section used an incorrect CSS selector (`first-of-type`) that matched nothing, silently clipping any rows that exceeded the available height; fixed to use `:not(:last-child)` which correctly targets the runway section; all runway rows are now reachable via scrollbar when more runways are active than can fit
- **Runway Usage section taller** — flex weight increased from 1 to 1.4 (Aircraft Types remains at 2) so approximately one extra runway row is always visible without scrolling; useful when all EFHK runway directions are active simultaneously
- **Total counts shown in section labels** — Runway Usage label now shows the total landing count (e.g. "Runway Usage · Today  Total: 89") and Aircraft Types label shows the number of distinct types seen (e.g. "Aircraft Types · Today  Total types: 23"); counts update whenever data refreshes or the time range changes; "UTC" removed from labels as all times in the system are UTC by convention; hover tooltip "today" text removed since it was misleading for Yesterday and 1w ranges

### Windshear — algorithm selection persisted across page reloads

- **Windshear algorithm selection now saved to localStorage** — previously the detection algorithm dropdown (Pair / Gradient / Energy / Rate / Baseline / Kinematic) always reset to Pair on every page reload; the selected algorithm is now stored under the `ms_ws_algo` key and restored on page load, matching the existing behaviour of the alert level and F-factor gate dropdowns; first visit still defaults to Pair

### Maintenance — days-of-data column in statistics table

- **Days column added to the maintenance statistics table** — the database statistics panel now shows a **Days** column between Rows and Oldest record for each table; computed as `COUNT(DISTINCT date(...))` on the relevant timestamp column so it reflects the true number of calendar days with data, not just the span between oldest and newest; helps the user choose an appropriate purge threshold before entering the day count in the purge field
- Statistics grid updated from 4 to 5 columns: **Table · Rows · Days · Oldest record · Newest record**

### Windshear — today's statistics panel + compact alert log

- **Windshear alert panel split 55/45** — the right side of the bottom row is now divided: the left 55% remains the windshear alert log; the right 45% is a new **Today's Statistics** panel showing runway usage and aircraft type distributions for the current UTC day
- **Compact windshear alert entries** — each log entry is now a single compact line (`HH:MM [Algo] RWY NNkt↑/↓ CS1/CS2`); hovering over any entry shows a positioned tooltip with the full original detail (algorithm, altitude band, individual headwind components, exact timestamp); go-around entries similarly condensed with hover for full context
- **Runway Usage section** — counts completed approaches per runway since UTC midnight and displays each as a horizontal percentage bar sorted by frequency; data computed client-side from the existing `approach_history` API so no new backend endpoint was needed
- **Aircraft Types section** — top 10 aircraft types by approach count with percentage bars; `Unknown` used when `aircraft_type` is absent in the record; section given double the vertical space of the runway section for readability
- **`fetchTodayStats()`** — new async function fetching `/api/windshear/approach-history?date=YYYY-MM-DD` at page load and every 5 minutes; statistics update automatically as new approaches are committed throughout the day; independent of the approach history panel enable state
- **Hover tooltips on stats rows** — hovering over any runway or aircraft type row shows the exact approach count for today (e.g. "RWY 22L: 18 landings today", "A320: 7 approaches today"); uses the same positioned tooltip element already in place for the compact windshear alert entries
- **Aircraft Types shows all types with scrollbar** — removed the top-10 cap; all distinct aircraft types seen today are listed sorted by frequency with a vertical scrollbar so none are hidden; the label row stays fixed while the list scrolls
- **Unknown aircraft type label shortened to NIL** — aircraft records without a decoded type code are shown as `NIL` instead of `Unknown` for a cleaner visual fit in the narrow stats column

### Windshear — pre-corridor NONE circle visualisation

- **Pre-corridor NONE circles on ILS profile** — small dashed amber circles now appear on the ILS canvas during the wide localizer intercept turn phase, before the aircraft is established in the ILS corridor; previously this phase was completely invisible, making a normal turn look identical to a GPS-jamming gap
- **Only `qc` reason accumulated** — pre-corridor circles are shown only when `none_reason === 'qc'` (pyModeS quality rejection due to bank angle) meaning the aircraft has valid GPS but the wind computation is suppressed; GPS-related NONE events outside the corridor are intentionally not shown as they would be ambiguous
- **`dist_nearest_thr_nm` field added to windshear state** — `collector/windshear.py` now computes the distance to the nearest runway threshold for non-corridor aircraft (using the existing `_haversine_nm` helper and `self.runways` data); this read-only field provides the ILS canvas X-axis position for pre-corridor circles; all existing band capture, windrose, windshear detection and approach history logic is completely unchanged
- **Visual distinction** — pre-corridor circles are smaller (2 px radius vs 3 px for corridor circles) and use a dashed stroke outline, making them clearly distinguishable from established-approach NONE markers; colour remains amber consistent with the `qc` Turn symbol
- **`wsPreCorridorHistory` buffer** — parallel to `wsNoneHistory` but keyed on non-corridor aircraft; accumulates with the same 400 ft / 0.5 NM minimum-gap thresholds; drawn only for the currently selected barb aircraft; pruned when the aircraft leaves `liveIcaos`
- **ILS legend updated** — new **Pre-ILS** entry with a dashed amber ring added to the legend row
- **NONE circle history no longer cleared by brief reception gaps** — previously `wsNoneHistory` and `wsPreCorridorHistory` were deleted the moment an aircraft missed a single 3-second poll cycle; during GPS jamming an aircraft can briefly drop from the feed and reappear, which caused all accumulated circles to vanish when valid wind data resumed (appearing as if circles were removed by the valid data); fixed by replacing the per-poll immediate deletion with a 45-second stale-timeout (`WS_NONE_HIST_STALE_MS`) matching the server stale-out window — circles now correctly persist alongside returning green barbs for the full duration of the approach

### Maintenance page + GPS Quality chart and purge fixes

- **Maintenance page** added at `/maintenance` — administrator tool for database housekeeping; protected by a separate credential file (`MAINTENANCE_AUTH_FILE` in config) independent of the main web authentication; credentials are never stored in a session and are submitted with each operation
- **Flight & Meteo data purge** — removes records from `observations` and `flights` older than a configurable number of days; approach history is never touched; a preview step shows the exact row counts and date range before any deletion is executed
- **GPS Quality data purge** — separately removes rows from `gps_quality_hours` and `gps_quality_zone_hours` older than a configurable threshold; no autopurge for GPS quality data
- **Autopurge** — optional scheduled purge for flight/meteo data; when enabled, runs automatically once per day via a background thread; threshold (days) is configurable from the maintenance page; settings persisted in the new `maintenance_config` DB table
- **Database statistics panel** — shows row counts, oldest and newest record timestamps, and SQLite file size for all tables; refreshed on demand
- **GPS quality purge now reloads in-RAM cache** — previously purging GPS quality data removed rows from the DB but the live GPS Quality page continued to show the old data from the in-RAM bucket cache until next server restart; the purge route now calls `GpsQualityTracker.reload_from_db()` immediately after deletion
- **GPS Quality chart X-axis labels fixed** — for multi-day hourly views (2d / 3d / 1w) the tick labels now always show `M/D HHh` format; previously only midnight and the first slot carried a date prefix, so when Chart.js chose which ticks to display the remaining labels showed bare hour numbers with no day context

---

## v.29052026 — 2026-05-29 (GPS Quality ADS-B position-loss detection, distance zones, range selectors, 14-day heatmap and statistics; Windshear NONE marker colours)

### GPS Quality — ADS-B position loss detection + stats percentage fix

- **New `adsb_loss` detection signal** — detects when an aircraft's own GPS-derived ADS-B position has dropped out while the Radarcape MLAT system continues to keep it visible; this is the most common GPS-jamming signature at EFHK where MLAT coverage is strong enough that the plain `gap` signal (requiring `lat is None`) almost never fires; `adsb_loss` and `gap` are mutually exclusive by design
- **Why Gap rarely fires at EFHK** — when GPS jamming causes ADS-B position loss, the Radarcape JSON/MLAT poller immediately fills `lat`/`lon` in `live_state` with MLAT-derived positions, so `lat` is never `None` and the Gap condition never triggers for MLAT-covered aircraft
- **Implementation via Beast feed timestamp** — `collector/receiver.py` sets `merged["last_adsb_pos_ts"] = ts` whenever a TC=9-18/20-22 ADS-B airborne-position message is decoded from the Beast feed (either by pyModeS PipeDecoder or the CPR fallback); this timestamp is set only for genuine aircraft-transmitted GPS positions, never for BDS 5,0/6,0 replies or cached state enrichment; `collector/gps_quality.py` reads `last_adsb_pos_ts` directly from `live_state` and fires `adsb_loss` when `lat is not None` AND `(now - last_adsb_pos_ts) >= gap_sec` (45 seconds without a real ADS-B position)
- **Frontend** — teal **ADS-B** badge in the live table, new chart segment in the time-series stacked bar, 14-day stats row, and signal key description in the Detection Signals panel; DB columns `adsb_loss_events` added to both `gps_quality_hours` and `gps_quality_zone_hours`
- **Stats panel percentage fix** — the four signal percentages (NACp / Freeze / Gap / ADS-B) previously divided by `totalEvents` which counts one per aircraft-sweep regardless of how many signals fired simultaneously; one aircraft can trigger both Freeze and ADS-B in the same sweep, causing percentages to sum beyond 100%; fixed by dividing by `totalSignals` (sum of all individual signal counts) so the percentages always sum to exactly 100% and represent each signal's share of total flag firings
- **No effect on other systems** — `receiver.py` adds one new key to `live_state`; all other consumers (windshear tracker, ILS profile, windrose, approach history) ignore keys they don't read

### Windshear — NONE position marker colour-coding by reason

- **NONE position circles on ILS profile now colour-coded by cause** — previously all hollow circles were the same grey regardless of why wind data was unavailable; they are now split into two visually distinct types to help the user immediately distinguish normal maneuvering from a potential GPS problem
- **Amber hollow circle — `'qc'` (EHS quality rejection)** — pyModeS suppressed the wind computation because the aircraft's bank angle or roll rate exceeded its quality threshold during a turn; the aircraft has a valid, actively updating GPS position and this is entirely expected during localizer intercept; seeing amber circles during the initial approach join is normal and requires no action
- **Grey hollow circle — `'freeze'` / `'gap'` (GPS-related)** — either our position-freeze gate fired (`pos_frozen = True`: altitude descending while lat/lon is static — a GPS jamming signature) or the aircraft has no ADS-B position at all; grey circles on established final approach are worth investigating
- **Classification logic** (`collector/windshear.py`) — a `none_reason` field is added to every aircraft's state dict entry; value is `None` when `meteo_source != 'NONE'`; when NONE: `'freeze'` if `pos_frozen` is True, `'gap'` if `lat is None`, otherwise `'qc'`; all existing upstream logic (wind computation, windrose, band capture, GPS quality DB) is completely unchanged — the classification is a read-only label derived from values already computed
- **`wsNoneHistory` extended** — each stored observation now carries a `reason` field (`'qc'` / `'freeze'` / `'gap'`); the canvas draws loop picks the stroke colour per-observation rather than using a single fixed colour for the whole trail; older entries without a reason field default to `'qc'`
- **ILS profile legend updated** — two new hollow-ring legend items added: **Turn** (amber ring) and **GPS** (grey ring), rendered with the new `.ws-ils-leg-ring` CSS class (border-only circle, transparent fill)

### GPS Quality — donut chart updates on zone switch

- **FL Band Analysis donut now redraws on zone change** — previously the donut was drawn once on page load and then only refreshed on the hourly tick, so switching zones (All / 50 nm / 20 nm) updated the heatmap and time series but left the donut showing All-zone data; a new `lastDonutZone` variable tracks which zone the donut was last drawn for; `fetchGpsState()` now redraws the donut whenever `lastDonutZone !== currentZone`, i.e. exactly once per zone switch immediately after the zone's data arrives; the hourly background refresh continues unchanged

### GPS Quality — distance zone filtering: All / 50 nm / 20 nm

- **Distance zone selector** added to the GPS Quality page — three buttons in the summary bar (**All · 50 nm · 20 nm**) filter all charts, heatmap, donut, and stats to show only aircraft within the selected radius from the airport (EFHK); the selection persists across browser sessions via `localStorage` and defaults to **All** on first use; switching zones re-fetches all data immediately
- **Parallel zone bucket storage** — a new `gps_quality_zone_hours` SQLite table stores hourly buckets for each distance zone with `PRIMARY KEY (ts, zone)`; the existing `gps_quality_hours` table is completely unchanged so all historical **All** data is preserved; zone buckets start accumulating from first deployment — no backfill of historical data is possible or attempted
- **Zone assignment logic** (`collector/gps_quality.py`) — each aircraft is assigned to zones using a haversine distance calculation from the configured airport coordinates on every 5-second sweep; for **Position Gap** events (no current ADS-B position) the aircraft's last-known position is used if it is no more than 120 seconds old, ensuring that aircraft experiencing a full GPS drop-out near the airport still contribute to the 20 nm and 50 nm zone counts; aircraft with no known position at all are counted in **All** only
- **Zone-aware recording** — both the "seen" count (total aircraft) and event counts (NACp / Freeze / Gap) are recorded independently into each qualifying zone bucket alongside the existing **All** bucket; the `_write_event_to_bucket()` static method handles generic bucket updates shared across zones
- **Airport coordinates** passed from `cfg.WINDSHEAR_AIRPORT_LAT` / `cfg.WINDSHEAR_AIRPORT_LON` into `GpsQualityTracker` via two new constructor parameters (`airport_lat`, `airport_lon`); `run.py` wires these from the existing config constants already used by the windshear tracker
- **API** — `GET /api/gps/state?zone=50nm` (or `20nm`) returns data from the corresponding zone bucket; `?zone=all` or no parameter returns the existing **All** data (backward compatible); the active zone name is echoed back in the JSON response as `"zone"`
- **DB migration** — the new `gps_quality_zone_hours` table is created automatically by `schema.sql` via `CREATE TABLE IF NOT EXISTS`; no manual migration steps are needed; existing installations upgrade transparently on next restart

### GPS Quality — time-series range selector: 1w hourly + new 2w button

- **`1w` range changed to hourly bars** — the 7-day range now shows one bar per hour (168 bars total) matching the same style as `1d`, `2d`, and `3d`; previously it aggregated to one bar per day, hiding intra-day patterns; the X-axis shows 7 day-boundary tick labels for orientation
- **New `2w` range button** — shows the last 14 days aggregated to one bar per calendar day (14 bars); fills the gap between the hourly 7-day view and the 31-day monthly view; the Aircraft line in the 2w view shows peak hourly aircraft count per day, consistent with the other daily-aggregate views (`1m`)

### GPS Quality — 14-day heatmap + FL band donut + 14-day stats panel

- **Heatmap extended to 14 days** — the FL Band Heatmap now shows the most recent 14 calendar days instead of 7; the backend already stored up to 31 days so no DB or API changes were required; `drawHeatmap()` now slices to the last 14 days via `allDayKeys.slice(-14)` before rendering; the panel header label updated accordingly
- **FL Band Analysis panel added** — a new panel in the right column (below the live degraded aircraft table) shows a Chart.js doughnut chart of GPS degradation events broken down by FL band across the 14-day window; FL band labels are displayed as a vertical list on the left side of the chart for compactness; each segment is colour-coded with a distinct per-band colour; hover tooltips show the event count and percentage for each band
- **14-day summary stats** — below the donut, six key figures are shown for the same 14-day window: total events, most affected FL band (with count), worst single day (with count), and a NACp / Freeze / Gap signal breakdown with event counts and percentage of total
- **Donut refresh rate** — the donut and stats are drawn once on page load and then refreshed every **60 minutes** via `setInterval`; they are intentionally decoupled from the 30-second main poll cycle since the 14-day aggregates change slowly; the live table and time-series chart continue to update every 30 seconds as before
- **Live degraded aircraft table** capped at **7 rows** of visible height (approximately 248 px); additional rows are accessible via an in-panel scrollbar; this reserves space in the right column for the donut and stats panel without requiring the overall column to scroll
- **Sharp donut rendering** — removed CSS `width: 100% !important` and `height: auto !important` overrides on the donut canvas; these were preventing Chart.js from applying the correct `devicePixelRatio` scaling, causing blurry text in the legend and tooltips on HiDPI displays; Chart.js now manages canvas pixel dimensions directly

---

## v.28052026 — 2026-05-28 (Windshear METAR staleness indicator, Windrose fixes, Approach History crosswind, GPS position-freeze gate)

### Windshear — METAR staleness indicator + Windrose timestamps

- **METAR staleness colour** — the METAR text in the weather strip changes colour based on how old the issued observation is: **orange** when ≥ 60 minutes old, **red** when ≥ 90 minutes old, normal colour when fresh; age is measured from the `DDHHMM Z` issue time parsed directly from the raw METAR string (e.g. `281550Z`), not from the browser's last fetch time, so the indicator correctly reflects the actual age of the meteorological observation
- **Colour transitions are timely** — `checkMetarAge()` is called both immediately after every `fetchWx()` and independently every minute via `setInterval`; this ensures the colour changes at the correct wall-clock moment even when no new METAR arrives between the 10-minute fetch cycles
- **Windrose canvas timestamps** — the top-right corner of the Wind Rose canvas now shows UTC HH:MM issue/observation times alongside the existing top-left source labels: cyan `HH:MM` for the METAR issue time, green `HH:MM` for the timestamp of the most recent MODE-S observation currently in the 30-minute rolling buffer; `--:--` is shown when no data is available; same font and colour as the left-side dot labels so the pair reads as a natural key

### Windshear — Windrose auto-update fix

- **Windrose server buffer now re-fetched every 60 seconds** — previously `fetchWindroseObs()` was called only once on page load, so approaches that landed mid-session were never reflected in the Windrose until the user refreshed the whole page; a new `setInterval(fetchWindroseObs, 60_000)` ensures the browser re-syncs with the server's rolling 30-minute observation buffer within one minute of any new landing
- **Deduplication via `windroseServerTsSeen` set** — each server observation is keyed by its Unix-ms timestamp; re-fetches skip already-ingested entries so observations are never double-counted in the vector average; stale keys are pruned from the set in sync with the 30-minute rolling window
- **Toggle (open) also triggers an immediate re-fetch** — the Windrose panel toggle handler now calls `fetchWindroseObs()` before `drawWindrose()` when opening the panel; this explains the user-observed behaviour where toggling always showed fresh data (it now does so explicitly rather than by coincidence) and ensures the panel is always maximally current on open
- **Root cause**: after the GPS position-freeze gate was added (2026-05-28), approaches with frozen ADS-B positions produced no windrose observations on either the server path (gate blocks `_windrose_obs` accumulation) or the JS harvest path (`meteo_source === 'NONE'` filter); the page-load-only `fetchWindroseObs()` could not pick up data from aircraft that staled out after page load; the periodic re-fetch closes this gap by polling the server buffer where any pre-freeze valid observations are still stored

### Windshear — Approach History crosswind component + layout tidy

- **Crosswind component added to Approach History** — the altitude-band column display now supports four modes selectable from a new inline dropdown in the control row: **Wind** (raw `dir°/spd kt`), **HW** (headwind component, default), **XW** (crosswind component), and **HW+XW** (both components stacked in a two-line cell with a hairline separator)
- **Crosswind display convention** — XW shows the magnitude in knots with a directional arrow: `←` means the crosswind is coming **from the left** of the aircraft on approach; `→` means from the **right**; the number is the crosswind component magnitude. Example: `←17` on RWY 04L with wind from 310° means 17 kt crosswind from the left — the aircraft drifts right and must crab left to maintain centreline. The arrow always indicates the **source side** of the wind, not the direction it is blowing across the runway. Colour coding: green (< 5 kt, light), amber (5–9 kt, moderate), red (≥ 10 kt, strong)
- **HW+XW two-line cell** — Option A layout: headwind component on the top line, crosswind on the bottom line, separated by a thin hairline rule; both values are colour-coded independently; the cell height increases slightly in this mode to accommodate both values cleanly
- **Crosswind formula** — `XW = wind_speed × sin(wind_dir − runway_heading)`; positive = from right, negative = from left; computed client-side from the existing `{dir, spd}` band data and `rwy_heading` already present in every Approach History record — no backend changes required
- **Control row layout tidy** — the mode dropdown and Lo/Hi button moved from the header row into the time-filter row, placed after the Live button with a thin separator; the panel header now contains only the title, saving one row of vertical space and keeping all interactive controls together on one line
- **Lo and Hi display bands lowered to 600 ft** — the 600 ft band added to both Lo (now 8 columns: 600 / 800 / 1 000 / 1 400 / 1 800 / 2 200 / 2 600 / 3 000 ft) and Hi (now 13 columns: 600–3 000 ft at 200 ft steps, dropping the 200 and 400 ft columns that currently yield no data at EFHK); the server continues to capture all 15 bands down to 200 ft in the DB so the 200 and 400 ft columns can be re-enabled in JS at any time without a backend change

### Windshear — GPS position-freeze gate for Approach History and Windrose

- **Position-freeze gate** added to `collector/windshear.py` — protects the Approach History altitude-band capture and the Windrose low-altitude observation buffer from wind data computed while an aircraft's ADS-B position is frozen by GPS jamming
- **How it works**: a new `_pos_track` dict (keyed by ICAO) records the most recent `{dist_thr, alt}` for every in-corridor aircraft on every sweep, regardless of meteo quality; before writing a band or a Windrose observation, the gate checks whether altitude has dropped more than `BAND_TOL_FT` (100 ft) since the previous sweep while `dist_thr` has not advanced by at least `POS_FREEZE_MIN_NM` (0.05 NM) — the characteristic signature of a frozen GPS position descending through the glideslope; if true, `pos_frozen = True` and the write is skipped, leaving the affected bands as `None` (displayed as `—`) rather than filling them with partially stale wind
- **Why 0.05 NM**: on a 3° glideslope a 100 ft altitude drop corresponds to ~0.31 NM of forward movement; 0.05 NM is well below normal aircraft advance speed, so the gate only fires when there is genuinely zero position change over a meaningful altitude descent; it does not fire during normal GPS update jitter or brief position-message gaps
- **NONE-gap robustness**: `_pos_track` is updated on every in-corridor sweep — even during `meteo_source = NONE` periods — so the tracker does not false-fire when EHS wind data recovers after a legitimate meteo gap; the position history stays current through NONE windows
- **Windrose also protected**: the same `pos_frozen` flag gates the Windrose per-aircraft accumulation loop, preventing stale-groundspeed wind from entering the rolling buffer and corrupting the Windrose average
- **No effect on normal operations**: the gate never fires for aircraft with functioning GPS; all band captures and Windrose observations for unjammed approaches are identical to before; `POS_FREEZE_MIN_NM` constant added to the approach history constants section
- **Cleanup**: `_pos_track` entries are removed in all the same places as `_band_winds` — blocked registration early return, distance/altitude gate early return, aircraft leaves corridor while APPROACHING, and `prune_stale()` — preventing any memory leak for long-tracked aircraft

---

## v.27052026 — 2026-05-27 (Windshear — Approach History dynamic panel height + date query)

- **Dynamic Approach History panel height** — the Approach History overlay now stretches automatically with the map container instead of being clipped to a fixed 264 px maximum; the panel is anchored top (`90px`) and bottom (`8px`) inside the positioned `.ws-map-wrap` container and uses a flex-column layout so the scrollable table fills all remaining space; on a 1080p display the visible table area roughly doubles, and on higher resolutions it grows proportionally; no layout or backend changes were required — only `static/css/style.css` was modified
- **Approach History custom date query** — a date picker control is added to the right of the `1d` time-filter button; it consists of a `dd.mm.yyyy` text field, a calendar (📅) icon button, and a `Live` button; entering a date or picking one from the calendar switches the panel into **date mode**: the panel loads all approaches for that full UTC day from the DB (`GET /api/windshear/approach-history?date=YYYY-MM-DD`), the five time-window buttons are dimmed, and the `Live` button becomes highlighted; clicking `Live` or any time-window button exits date mode and resumes live rolling-window queries; the `Live` button is highlighted (blue) in live mode and muted in date mode, so the active mode is always unambiguous
- **Locale-independent `dd.mm.yyyy` input** — the date field is a plain `<input type="text">` with a JS input mask that auto-inserts dots and accepts digits only, ensuring the `dd.mm.yyyy` format is displayed consistently regardless of the user's OS locale (e.g. Finnish Windows shows `pp.kk.vvvv` with a native `<input type="date">`); the hidden `<input type="date">` behind the 📅 button is never visible — it serves only as a calendar UI trigger via `showPicker()`; the text field additionally accepts typed input directly for keyboard users
- **New backend query parameter** — `GET /api/windshear/approach-history?date=YYYY-MM-DD` added to `web/app.py`; queries `WHERE date_utc = ?` on the indexed `date_utc` column; returns all approaches for that calendar day, newest first; the existing `?window=<seconds>` parameter is unchanged; a loose format check (`\d{4}-\d{2}-\d{2}`) rejects malformed inputs with HTTP 400

---

## v.26052026 — 2026-05-26 (Windshear Approach History in the database at 200 ft resolution, server-side Windrose buffer, RWY 33 filters, NONE markers, wind quality gates)

### Windshear — Approach History DB persistence + time filter

- **Approach History is now persisted to SQLite** — a new `approach_history` table stores one row per completed landing approach; data survives server restarts and accumulates indefinitely, making multi-hour and full-day queries practical
- **New DB table schema**: `ts` (Unix epoch), `date_utc` (YYYY-MM-DD), `time_utc` (HH:MM), `icao`, `callsign`, `registration`, `aircraft_type`, `runway`, `rwy_heading`, `bands_json` (JSON object keyed by altitude ft); three indexes on `ts`, `date_utc`, and `runway` for fast filtering; data volume is under 1 MB/year at EFHK approach rates
- **Callback hook** — `WindshearTracker` accepts an optional `on_approach_committed` callable; called from the windshear sweep thread immediately when an APPROACHING aircraft goes stale; the callback (`_on_approach_committed` in `run.py`) writes to the DB using the sweep thread's own thread-local connection — `WindshearTracker` remains DB-free; a `"ts"` Unix timestamp field is now included in every approach record
- **Startup preload** — `_preload_approach_history()` in `run.py` queries the last 24 h of DB records and calls `ws_tracker.preload_approach_history()` before the sweep thread starts; the RAM approach history list is immediately populated on server restart rather than waiting for the first landing
- **RAM cap increased** from 25 → **500 entries** to cover ~24 h of typical EFHK approach traffic in memory
- **Time filter UI** — a row of five compact buttons (`1h · 3h · 6h · 12h · 1d`) appears between the panel title row and the table; the active window is highlighted in blue; default is **3 h**; switching window immediately refetches from DB via `GET /api/windshear/approach-history?window=<seconds>`
- **API updated**: `GET /api/windshear/approach-history?window=N` now queries the DB directly for the requested time window; without the `window` param the RAM list is returned (backward compat); `POST /api/windshear/approach-history/clear` now deletes all rows from the DB table in addition to clearing the RAM list so the panel stays empty after a page refresh
- **Smart UTC timestamp display** — the UTC column shows plain `HH:MM` for approaches from today; approaches from a previous UTC date show `D.M HH:MM` (e.g. `26.5 14:32`) so multi-day views in the 6h/12h/1d windows are unambiguous; computed client-side from the `ts` Unix timestamp already present in every record, no backend change required
- **Clear button removed** — with DB persistence the Clear button would permanently delete historical data; it has been removed from the panel; the time filter already controls what is visible and data naturally ages out of each window

### Windshear — Approach History 200 ft resolution + Windrose server-side buffer

- **Approach History resolution increased to 200 ft** — `APPROACH_HISTORY_BANDS` in `collector/windshear.py` expanded from 5 bands (1 000–3 000 ft at 500 ft spacing) to **15 bands at 200 ft spacing** (200, 400, 600 … 3 000 ft); `BAND_TOL_FT` tightened from ±150 ft to **±100 ft** so bands at 200 ft resolution do not overlap
- **Approach History Hi/Lo column toggle** — a new **Lo/Hi** button in the Approach History panel header switches between two views of the same server-side data: *Lo* shows 6 columns at 400 ft steps (1 000 / 1 400 / 1 800 / 2 200 / 2 600 / 3 000 ft) aligned to the 200 ft server grid so every column is guaranteed to have data; *Hi* shows all 15 columns (200–3 000 ft at 200 ft steps) and the panel expands to `width: max-content` (`.ws-aphist-hi` CSS modifier class) so all columns are visible without horizontal scrolling, using the map area beneath; the table `<thead>` is now dynamically generated by JS to match the active band selection, and band cells in body rows are also rendered dynamically so no static column count is hardcoded in the HTML
- **Lo band alignment fix** — the original Lo bands (1 000 / 1 500 / 2 000 / 2 500 / 3 000 ft) were not present in the new 200 ft server grid, causing 1 500 ft and 2 500 ft columns to always show `—`; Lo is now `[800, 1000, 1400, 1800, 2200, 2600, 3000]` (7 columns, every other band from the 200 ft grid starting at 800 ft) so all columns reflect real captured data; the 800 ft band gives visibility into the lowest part of the approach where wind shear is most operationally significant — *subsequently updated: 600 ft added to Lo and Hi bottom; see 2026-05-28 entry*
- **Server-side Windrose rolling buffer** — `WindshearTracker` now accumulates per-aircraft low-altitude wind observations in a `_windrose_obs` dict during `sweep()`, using identical gate thresholds to the client-side JS Lo buffer (400 ft altitude gap OR 0.5 NM distance gap, 40-entry cap per aircraft, only in-corridor/non-NONE/alt ≤ 2 000 ft observations); when a landing aircraft goes stale (APPROACHING → silent), its observations are harvested into a global `_windrose_buffer` list with wall-clock timestamps; entries older than 30 minutes are pruned both at harvest time and on `get_windrose_obs()` calls
- **New Flask route** `GET /api/windshear/windrose-obs` returns the rolling buffer as a JSON list of `{ts, dir, spd, alt}` dicts
- **Browser pre-population on page load** — `fetchWindroseObs()` in `windshear.js` is called once on page open; observations from the last 30 minutes are injected directly into `recentLandingWinds` (JS uses ms timestamps, server sends Unix seconds — converted on the client); the windrose is immediately meaningful in a freshly opened browser window after a busy approach sequence rather than starting empty

### Windshear — RWY 33 corridor false-detection filters

- **Glideslope floor gate** added to corridor detection in `collector/windshear.py`: after `_best_runway()` matches an aircraft to a runway, the match is discarded if the aircraft is more than `CORRIDOR_GS_FLOOR_FT` (1 000 ft) below the theoretical 3° glidepath at its current distance from the threshold; this is the primary filter for traffic overflying the RWY 33 approach area at 12–15 NM while being vectored to RWY 22L/22R — at those distances such traffic is typically 1 000–2 500 ft below the glidepath and would otherwise pass all geometric and heading gates; legitimate approaches always clear this gate with at least 200 ft margin
- **Per-runway heading gate** — `_best_runway()` now reads an optional `max_track_dev` field from the runway definition, falling back to the global `CORRIDOR_MAX_TRACK_DEV_DEG` (60°) when absent; RWY 33 is set to **45°** (vs the default 60°) because aircraft vectored northward to RWY 22 from the south typically fly heading ~010°–020°, which is 47°–57° from RWY 33's approach heading of 323° — these headings pass the 60° gate but are correctly rejected by the 45° gate; all five ILS runways retain the existing 60° gate via the fallback
- The two filters are complementary: distant overflights (12–15 NM at 2 000–3 000 ft) are caught by the glideslope floor regardless of heading; mid-range cases (8–10 NM, ~010° heading) are caught by the tighter heading gate even when altitude slips above the floor; GPS-jammed frozen-position scenarios where track is unavailable are partially mitigated by the floor gate alone (track check is skipped when `track is None`, existing behaviour preserved)
- No change to ILS runway behaviour — the glideslope floor applies to all runways but has no practical effect on aircraft correctly established on approach; the per-runway heading gate applies only to RWY 33

### Windshear — NONE position markers on ILS glideslope canvas

- When the barb layer is active and an aircraft is selected, the ILS glideslope canvas now draws **grey hollow circles** (3 px radius, `#6b7280` stroke) at every position where wind computation was suspended (`meteo_source === 'NONE'`); circles appear alongside the coloured wind barbs from valid periods, or alone when the entire approach has been in NONE state
- A new `wsNoneHistory` per-aircraft buffer accumulates these position-only observations during the poll cycle; entries are stored whenever the aircraft is in the ILS corridor, `meteo_source === 'NONE'`, and valid `dist_thr_nm` + `altitude` are present; the same 400 ft / 0.5 NM gate and 40-entry cap as the Lo wind buffer are applied to keep marker density consistent
- When no valid wind history exists yet but NONE-position entries are already accumulated, the canvas hint text changes from `Waiting for wind data…` to `Waiting for wind data…  (N pos-only)` so it is immediately clear that position data is arriving even though wind decoding has not started
- The feature is useful for **GPS-jamming situational awareness**: a trail of hollow circles through the glideslope profile confirms that ADS-B position messages (BDS 0,5/0,6) are being received normally during a grey phase, even while wind computation (BDS 5,0/6,0) is suspended; the absence of circles would indicate a genuine position data gap rather than just a meteo quality issue
- No change to any windshear detection algorithm, Windrose, Approach History, or flight strip rendering — `wsNoneHistory` is consumed only by the ILS canvas draw path and has no effect on any alert or analysis logic

### Windshear — wind data quality gates for barb display, Windrose and Approach History

- **Per-barb quality colouring on the ILS glideslope canvas** — each wind barb now carries the `meteo_source` tag from the moment it was captured; barbs recorded during a grey (NONE) period remain grey permanently even after the aircraft's data recovers, instead of being retroactively recoloured green; this makes the canvas an honest record of data quality throughout the approach rather than reflecting only the aircraft's current state
- **NONE-period entries excluded from wind history buffers** — both the Lo and Hi accumulation loops now skip any poll where `meteo_source === 'NONE'`; stale non-null `best_wind_spd` values that linger in `live_state` from a previous good computation can no longer enter `wsWindHistory` or `wsWindHiHistory` during a grey phase; a gap appears on the canvas where data was absent, rather than a repeated stale position
- **Windrose no longer receives grey-period observations** — the Windrose harvests low-altitude wind from `wsWindHistory` when an aircraft leaves the tracked set; because NONE entries are now excluded from that buffer at accumulation time, they cannot flow into the Windrose rolling average
- **Approach History band capture excludes NONE-period data** — the Python-side band capture gate (`collector/windshear.py`) skips any sweep where `meteo_source == "NONE"`, preventing stale wind values that persist in `live_state` from being locked into the altitude-band history record for a landing approach
- Root cause of all four fixes: the `live_state` merge in `receiver.py` is non-destructive — new observations only overwrite existing fields with non-`None` values; when a wind computation is discarded (result > 150 kt, quality gate failure, or insufficient BDS data), `best_wind_spd` retains its previous value while `meteo_source` correctly updates to `"NONE"`; the fixes use `meteo_source` as the authoritative quality signal at every consumer

---

## v.25052026 — 2026-05-25 (Windshear Approach History panel; RWY 33 RNP approach support)

### Windshear — Approach History panel

- Added a new **Approach History** floating overlay panel on the Windshear page, toggled by the **Apch Hist** button in the map controls bar
- The panel shows a scrollable table of recently landed aircraft (newest first, up to 25 entries) with columns: **UTC time**, **Callsign**, **Registration**, **Type**, **Runway**, and wind at **1000 / 1500 / 2000 / 2500 / 3000 ft**; Registration and Type show `—` when not available
- Data is accumulated in RAM only while the page is running; it clears on server restart or when the **Clear** button is pressed
- A **Wind / HW** toggle button switches the five altitude columns between raw wind display (`270°/15`) and headwind component (`+12` / `-5` kt); headwind positive = into the aircraft, colour-coded green / red / amber for immediate situational awareness
- **Landing detection**: when an aircraft that was established on approach (APPROACHING state) goes ADS-B-silent — typically at 200–400 ft on final where receiver line-of-sight is lost — the 30-second stale timeout fires and the record is committed; the UTC timestamp reflects this moment, which closely approximates actual touchdown; aircraft that go around (GO_AROUND state) are automatically excluded
- **Band capture**: as each approach aircraft descends through the corridor, the first wind reading within ±150 ft of each target altitude is recorded; once a band is captured it is locked (highest-altitude reading wins); bands with no wind data (aircraft not BDS 6,0 equipped or meteo not decoded at that level) show `—`
- No effect on any existing windshear detection, barb display, go-around detector, or map calculations — the history list is a passive accumulator fed entirely by existing live_state data
- Backend: `WindshearTracker` gains `_approach_history` list and `_band_winds` per-aircraft dict; two new Flask routes `GET /api/windshear/approach-history` and `POST /api/windshear/approach-history/clear`

### Windshear — RWY 33 RNP approach support

- Added **RWY 33** to the windshear approach tracker and runway selector — aircraft established on the RNP approach to RWY 33 are now tracked, displayed on the ILS glideslope canvas, and shown in flight strips exactly like the five ILS runways
- RWY 33 uses a standard **3.00° vertical path angle** (identical to the ILS glidepaths); no special glideslope logic was required — the existing `GS_FT_PER_NM = 318.5` calculation applies without modification
- Threshold coordinates updated to exact AIP values from FINTRAFFIC ANS EFHK ADC (AD 2.4-1, 16 APR 2026) for all six runways; RWY 33 threshold: `60.3071°N, 24.9883°E`, approach heading 323°
- **Per-runway threshold elevation** — `thr_elevation_ft` added as a field in each runway dict; the global `WINDSHEAR_THR_ELEVATION_FT` config value is now a fallback only; RWY 33 is anchored at **148 ft MSL** (vs ~179 ft for the other EFHK runways), ensuring the glideslope reference line is correctly positioned for each runway independently; the `gs_status()` call now resolves the elevation from the matched runway rather than the global setting
- **RWY 33 approach centreline added to the Windshear map** — three GeoJSON line segments in `overlays/efhk_ils.geojson` extend the RNP final approach track from the threshold outbound to 25 NM; styled in amber (`#f59e0b`) with a longer dash pattern (`10 5`) so the RNP line is visually distinct from the ILS centrelines (blue `#38bdf8`, short dash `6 5`); the Leaflet style callback routes on the `approach_type: "RNP"` property
- Centreline bearing uses the **true geographic runway axis (153.1°T outbound)** derived from the published approach chart value of 333.1°T for the inbound track — not the magnetic heading (323°) and not the uncorrected magnetic reciprocal (143°); using the correct true bearing eliminates the ~10° angular error (≈4.4 NM lateral offset at 25 NM) that would result from directly reversing the magnetic approach heading

---

## v.24052026 — 2026-05-24 (system-wide registration blocklist and WAM ground-station filter; go-around detector gates; UTC clock; ILS profile label and barb modes)

### System-wide registration blocklist — helicopter filter

- Added **`BLOCKED_REG_PREFIXES`** to `config.py` — a tuple of registration prefixes that are silently dropped system-wide, complementing the existing `BLOCKED_ICAO_PREFIXES` ICAO24 filter
- Default entry: `("OH-H",)` — covers Finnish helicopters whose continuous manoeuvring near EFHK (especially around RWY 33) produces unreliable BDS 5,0/6,0 computed wind and false meteo observations
- New helper `is_blocked_registration()` added to `collector/filter.py`; applied at both live_state entry points:
  - **JSON/MLAT poller** (`radarcape_json.py`) — drops the aircraft and removes any existing live_state entry as soon as the registration is known from the JSON feed; this is the primary filter path since registration is only available from the Radarcape JSON endpoint
  - **Beast TCP receiver** (`receiver.py`) — after the live_state merge, removes the aircraft and skips the DB write if the registration (previously populated by the JSON poller) matches a blocked prefix; provides belt-and-suspenders coverage for the window between first Beast message and first JSON poll
- `WindshearTracker` hardcoded `OH-H` string replaced with the config-driven `blocked_reg_prefixes` parameter — the tracker now uses `is_blocked_registration()` for consistency; `run.py` wires `cfg.BLOCKED_REG_PREFIXES` into the constructor
- Adding further registration prefixes to the tuple in `config.py` requires no code changes

### System-wide WAM ground station filter

- Added **ICAO24 prefix blocklist** (`BLOCKED_ICAO_PREFIXES` in `config.py`) — any ICAO24 address whose prefix matches an entry in the list is silently dropped at both live\_state entry points before it can affect any subsystem
- Default blocklist: `("T40",)` — covers Finnish Air Navigation Services **Wide Area Multilateration (WAM)** ground interrogator stations whose ICAO24 codes begin with `T40`; these fixed infrastructure nodes produce valid Mode-S replies but are not aircraft and previously inflated the GPS quality "total aircraft seen" count and could trigger spurious Gap events
- New helper `is_blocked_icao()` added to `collector/filter.py`; called in both `collector/receiver.py` (Beast TCP feed) and `collector/radarcape_json.py` (JSON/MLAT poller) immediately after ICAO extraction — no blocked address can enter live\_state through either path
- Comparison is case-insensitive; additional prefixes can be added to the tuple as needed without code changes

### Go-around detector — minimum altitude gain check

- Added a second AND condition to the go-around confirmation: the aircraft must have gained at least **50 ft of actual pressure altitude** since the climb started (`WINDSHEAR_GA_MIN_ALT_GAIN_FT`, default 50 ft)
- Guards against barometric lag and vert_rate quantization noise where the reported climb rate is high for multiple polls but the aircraft's actual altitude barely changes — both the poll counter and the altitude gain check must pass simultaneously before a go-around fires
- `ga_climb_start_alt` is recorded on the first climbing poll and cleared on reset; the log line now includes the measured altitude gain for easier post-event review

### Go-around detector — sustained climb gate

- Fixed **false go-around detections in gusty / turbulent conditions** — the APPROACHING → GO_AROUND transition previously fired on a single poll where vertical rate ≥ 600 fpm; a momentary updraft or gust-induced vert_rate spike was enough to trigger a false event
- Added a **sustained climb gate** (`WINDSHEAR_GA_MIN_CLIMB_POLLS`, default 3): the detector now requires 3 consecutive 3-second poll cycles all reporting vert_rate ≥ 600 fpm before declaring a go-around — equivalent to 9 seconds of sustained climbing and a minimum altitude gain of ~90 ft
- The climb counter resets to zero on any poll that falls below the climb threshold or above the altitude ceiling, so a transient spike during an otherwise normal approach cannot accumulate across poll gaps
- The corridor-exit handler also resets the climb counter alongside the existing descent counter reset
- New parameter `WINDSHEAR_GA_MIN_CLIMB_POLLS` added to `config.py` and wired through `run.py` — raise to 4 or 5 in particularly gusty environments; lower to 2 if go-arounds are being missed

### Navigation bar — UTC clock

- Added a **live UTC clock** to the right side of the navigation bar on all pages, immediately to the left of the Online / Live status indicator — displays the current date and time in `YYYY-MM-DD HH:MM:SS UTC` format, updated every second using the browser clock; uses a monospace font to prevent layout shift as digits change

### Windshear ILS profile — Dcl label placement toggle

- Added **Dcl button** to the ILS profile header, immediately to the right of the `HW` button — toggles a declutter label layout for wind barb annotations
- When **Dcl is on** and HW is active, labels are split to opposite sides of each barb: raw `dir°/spd` appears above the barb, signed headwind value (`+15kt`) appears below — the barb staff acts as a natural visual separator between the two labels, reducing overlap on dense approaches
- When **Dcl is off** (default), both labels remain on the same side (above the barb, flipping below near the top edge) — existing behaviour unchanged
- Edge cases: near the top of the canvas both labels stack below the barb (HW first); near the bottom both labels stack above the barb (HW closest to barb)
- Canvas corner label gains a `· DCL` tag when Dcl is active alongside HW
- Dcl button is greyed out when HW is off; turning HW off also resets Dcl to inactive; turning Barbs off resets both

### Windshear ILS profile — Hi-resolution barb mode

- Added **Hi-resolution barb mode** — a `Hi` segment inserted between `Barbs` and `Auto` in the split button group toggles the barb canvas between two independent wind observation buffers
- **Lo buffer** (unchanged, default): 400 ft / 0.5 NM accumulation gate, 40-observation cap — behaviour identical to before
- **Hi buffer** (new, research mode): 150 ft / 0.2 NM gate, 100-observation cap — approximately 3–4× denser; covers a full 15 NM approach with fine altitude resolution
- Both buffers accumulate in parallel every poll cycle regardless of which is selected — switching to Hi immediately shows the denser data already collected since page load
- The Hi buffer is **display-only** and is never read by any windshear detection algorithm; all six detection algorithms continue to use the Lo buffer exclusively, preserving existing detection behaviour
- `Hi` button turns **violet** when active; canvas corner label gains a `· HI` tag to confirm the mode
- `Hi` button is greyed out (pointer-events disabled) when Barbs are off; turning Barbs off also resets Hi to inactive
- Cleanup on aircraft departure (`delete wsWindHiHistory[icao]`) runs alongside the existing Lo buffer cleanup

---

## v.22052026 — 2026-05-22 (Windshear label rename and HW/TW barb annotation; GPS Quality flush fix and chart range selector)

### Windshear panel — label rename

- Renamed the **Windshear Log** panel title to **Windshear Alert** — better reflects that the alert level selector controls the banner and flight strip badges, while the log itself always records all severity levels regardless of the selected threshold

### Windshear ILS profile — HW/TW barb annotation

- Added **HW toggle button** to the ILS profile header, immediately to the right of the `Barbs · Auto` split button — annotates each wind barb on the glideslope canvas with the headwind/tailwind component for the matched runway
- When **HW is on**, each barb shows two lines: the signed headwind component as the primary label (e.g. `+15kt` or `−8kt`) colour-coded **green** (headwind > +5 kt), **red** (tailwind < −5 kt), or **amber** (near-zero ±5 kt); the raw `dir°/spd` is shown in smaller dimmer text on a second line below for reference
- When **HW is off** (default), existing behaviour is unchanged — only `248°/24kt` shown
- The runway heading used for the computation is sourced from the selected aircraft's `approach_runway` field (most precise); falls back to the runway filter dropdown value if the aircraft is no longer tracked; HW annotation is silently suppressed per-barb if no valid heading can be resolved
- The active runway reference is shown in the corner label (e.g. `· HW ref 04L (47°)`) so the reference heading is always visible
- The HW button is visually greyed out (pointer-events disabled) when Barbs are off; turning Barbs off also resets HW to inactive

### GPS Quality per-signal flush fix

- Fixed **per-signal counts not persisted on hour rollover** — `_current_bucket()` built a `flush_copy` dict that omitted `nacp_events`, `freeze_events`, and `gap_events`; `_flush_to_db` therefore always wrote zero for all three fields even though the in-memory bucket had the correct counts; the three fields are now included in `flush_copy`; this caused all completed-hour rows in the DB to show as the grey "Unknown" bar in the chart rather than the coloured NACp / Freeze / Gap stacked breakdown — hours flushed before this fix will remain as grey bars (the in-memory data is gone), but all new completed hours will persist correctly going forward

### GPS Quality chart range selector

- Added **time range selector** to the GPS Quality bar chart — five buttons (`1d` / `2d` / `3d` / `1w` / `1m`) in the chart panel header let the user choose how much history is displayed
- **1d / 2d / 3d** — hourly bars; 2d and 3d labels include the date prefix (`M/D`) at midnight boundaries so each day is clearly identified; `maxTicksLimit` is halved for 2d/3d to prevent label crowding
- **1w / 1m** — aggregate to daily bars with day-of-week labels; the Aircraft line shows the peak hourly aircraft count per day (more meaningful than a sum of hourly counts)
- Selected range is persisted in `localStorage` (`ms_gps_range`) and restored on page load
- Chart panel title updates dynamically to match the active range (e.g. "GPS Degradation Events — Last 7 Days")
- Extended `MAX_BUCKETS` in `gps_quality.py` from `7 × 24` to `31 × 24` to support month-long retention; `_load_from_db` cutoff extended to match
- `get_state()` now returns all available cleaned buckets in `time_series` (previously capped at 24 h); the 24 h cap is now applied frontend-side only for the `1d` range; summary stats (Events 24h, Aircraft affected 24h, Peak hour) remain computed server-side from the last 24 h and are unchanged

---

## v.21052026 — 2026-05-21 (GPS Quality per-signal event breakdown)

- **Per-signal breakdown** added to hourly GPS quality buckets — each completed hour now records `nacp_events`, `freeze_events`, and `gap_events` separately in addition to the total `events` count
- **Stacked bar chart** — the 24-hour time-series chart now shows three stacked bars per hour: NACp (amber), Freeze (sky blue), Gap (violet); the total bar height still represents all events but the split immediately shows which signal type dominates
- **DB schema migration** — `database/db.py` `init_db()` applies `ALTER TABLE gps_quality_hours ADD COLUMN` for the three new columns on first startup; existing rows default to zero and continue loading correctly
- **Chart.js legend** replaces the old hardcoded HTML legend; the legend now auto-labels NACp / Freeze / Gap / Aircraft with matching colours

---

## v.20052026 — 2026-05-20 (GPS Quality page with database persistence, FL bands, altitude gate and gap fix; Windshear Kinematic algorithm, severity levels and confidence gating)

### GPS Quality Gap detection fix

- Fixed **Gap signal detection** — removed the `has_ehs` precondition (`alt is not None or gs is not None`) from the Gap check; since `update()` is only called for aircraft seen within the last 60 seconds in any Mode-S message, the aircraft being in the sweep is already proof it is transmitting; the old condition could silently suppress Gap events when GPS jamming also stopped ADS-B velocity messages (making `gs` None) and the aircraft happened to have no recent barometric altitude either; now any aircraft that previously had a GPS position but has not sent one for ≥ 45 s will be flagged regardless of which other Mode-S fields are present

### GPS Quality altitude gate

- Added **minimum altitude gate** for GPS degradation signal checks — aircraft below `GPS_MIN_ALT_FT` (default 1 000 ft / FL010) are counted as seen in the hourly bucket but are not checked for NACp / Freeze / Gap signals; prevents spurious Freeze events from landing aircraft that the receiver loses line-of-sight with at ~300–400 ft while their last-known groundspeed is still ~140 kt
- Gate applied in both `GpsQualityTracker.update()` and `rebuild_live()` so the live degraded table is also clean
- Added `GPS_MIN_ALT_FT: float = 500.0` to `config.py`
- Updated `run.py` to pass `cfg.GPS_MIN_ALT_FT` to `GpsQualityTracker`

### GPS Quality heatmap FL bands

- Split lowest FL band in GPS Quality heatmap from `000-050` into two bands: `000-030` (ground to 3 000 ft) and `030-050` (3 000–5 000 ft) — heatmap now has 8 rows instead of 7; gives better resolution in the critical approach and initial climb phase where low-level jamming effects are most operationally significant
- Change is backward-compatible with stored DB rows — historical buckets using the old `000-050` label will show 0 for the two new bands; new data is correctly bucketed from the next sweep onward

### GPS Quality DB persistence

- Added **`gps_quality_hours` SQLite table** — one row per completed UTC hour storing `ts`, `events`, `total` aircraft, `degraded` aircraft, and a JSON `fl_bands` object with per-FL-band event counts; `INSERT OR REPLACE` primary key on `ts` makes the write idempotent
- Added **`GpsQualityTracker._flush_to_db()`** — called automatically when the hour rolls over inside `_current_bucket()`; writes exactly 24 rows per day; a shallow copy of the completed bucket is passed so the lock is not held during disk I/O
- Added **`GpsQualityTracker._load_from_db()`** — called once in `__init__()` if `db_path` is provided; loads the last 7 days of completed hours from `gps_quality_hours` into `_buckets`, restoring the time-series chart and heatmap after a restart in ~0 seconds
- Updated `GpsQualityTracker.__init__()` to accept optional `db_path` parameter (defaults to `""`)
- Updated `run.py` to pass `cfg.DB_PATH` to `GpsQualityTracker`
- Updated `database/schema.sql` with `CREATE TABLE IF NOT EXISTS gps_quality_hours`; applied automatically by `init_db()` on first startup with this version

### GPS Quality page

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

### Windshear — Kinematic F-factor gate, three severity levels, confidence gating, go-around tuning

- Added **Kinematic F-factor gate** — a dedicated dropdown (`F: Off / F ≥0.05 / F ≥0.08 / F ≥0.10 / F ≥0.15`) in the windshear log header that sets a minimum F-factor threshold for Kinematic detections; events whose computed F-factor falls below the gate are suppressed before reaching the log, banner or strip badge; the control is automatically disabled when any other algorithm is active; preference is stored in `localStorage` as `ms_ws_kin_f_gate`, default Off; if the window is too short to compute a valid F-factor and the gate is active, the event is also suppressed
- Added **three-level windshear severity system** replacing the previous two-level moderate/severe scale — events are now classified as **Monitor** (≥10 kt, informational blue), **Warning** (≥15 kt, amber) or **Alarm** (≥25 kt, red); all six detection algorithms updated to use the new `wsSeverity()` helper and the lower 10 kt detection floor
- Added **user-selectable alert level** dropdown in the Windshear Log header (`Mon ≥10kt` / `Warn ≥15kt` / `Alarm ≥25kt`) — controls the minimum severity that triggers the alert banner and flight strip WS badge; the log always shows all three levels; preference is stored in `localStorage` as `ms_ws_alert_level`, default Warning
- Added **confidence gating** — all algorithms now require 2 consecutive poll cycles (≈6 seconds) detecting the same event before it is promoted to the log and banner; eliminates single-poll false positives; hit counters reset immediately when an event disappears, so genuine brief shear still fires on the 2nd confirmation
- Added **F-factor** display to Kinematic log entries — computed as `(Δ IAS−GS in m/s) / (window_secs × 9.81)`, displayed as `F=x.xx` in italic after the kt delta; F≥0.1 is operationally significant, F≥0.15 is severe; F-factor is stored in the event object as `f_factor`
- ILS profile canvas windshear zone bands now show three colours: blue (Monitor), amber (Warning), red (Alarm)
- Removed wind symbol (🌬) from the Barbs button label — button now reads plain `Barbs`, consistent with the Windrose button style; canvas hint text updated to match
- Fixed historical go-around events flooding the log for new users — added `wsSessionStart` timestamp gate in `addGaToWsLog()`; events that occurred before the current page load are silently skipped, so a fresh page open against a long-running server never surfaces days-old events
- Tightened go-around detection defaults to reduce false alarms — altitude ceiling lowered from 3 000 ft to **2 200 ft** (`WINDSHEAR_GA_MAX_ALT_FT`), minimum climb rate raised from 500 fpm to **600 fpm** (`WINDSHEAR_GA_CLIMB_FPM`); both values updated in `config.py` and `collector/windshear.py`

### Windshear — Kinematic detection algorithm

- Added **Kinematic windshear detection algorithm** (Algorithm 6) — detects windshear by tracking the rate of change of the IAS − GS differential over a 45-second sliding window; at low altitude IAS ≈ TAS, so `IAS − GS` approximates the headwind component along the aircraft's track; a sudden change in this differential directly measures a headwind gain or loss without any wind direction decoding
- Kinematic requires only a single aircraft in the ILS corridor (no pair needed), uses raw BDS 6,0 IAS and ADS-B groundspeed, and is robust at low altitude where the IAS ≈ TAS approximation holds best
- Added `wsKinHistory` rolling buffer (30 entries, ~90 s) per corridor aircraft storing `{ias, gs, ts}` on each poll cycle when IAS is available; algorithm applies its own 45-second time filter on top
- Added crimson-rose badge colour for Kinematic log entries (`#4c0519` background, `#fda4af` text)
- Added `Kinematic` option to the algorithm selector dropdown in Windshear page; all five previous algorithms (Pair, Gradient, Energy, Rate, Baseline) unchanged

---

## v.19052026 — 2026-05-19 (global Light theme; Windshear ATC map theme with coastline overlays; faster Radarcape JSON poll; Windshear label fixes)

- Added **global Light theme** — a blue-grey paper-toned palette (`#dde4ec` background) selectable on any page via a **Dark / Light** toggle button in the navbar; preference is stored in `localStorage` and applied before first paint so there is no flash on page load
- Light theme overrides all 9 CSS colour variables (covering ~200 references automatically) plus targeted overrides for the handful of hardcoded values: Leaflet map backgrounds, semi-transparent overlay panels (map-legend, map-controls, Wind Rose panel), Skew-T canvas background, and map aircraft callsign label text/shadow
- Live Map tile layer switches between CartoDB dark and light variants when the theme is toggled
- All canvas renderers (mini Skew-T on Live Map, full Skew-T on Sounding page, ILS glideslope profile and Wind Rose on Windshear page) use theme-aware colour palettes via a `canvasTheme()` helper that selects the correct colour set at draw time; `window.onThemeChange` is called on toggle so canvases redraw instantly without a page refresh
- Flight detail modal Chart.js charts use theme-aware grid and tick colours
- Dark theme is completely unchanged; all light-theme rules are additive and scoped under `[data-theme="light"]`
- Added **ATC map theme** on the Windshear page — flat `#cfcfcf` radar-grey background with no tile imagery, ILS centreline in dark navy (`#1a3a6b`), button placed between Grey and Black in the map controls bar
- Added **overlay cycling** for the ATC and Black themes — clicking the active button again cycles through three overlay levels: ILS only → ILS + coastline (`efhk_coast.geojson`) → ILS + coastline + water polygons (`efhk_aqua.geojson`); button label updates to show current level (ATC / ATC+C / ATC+CA and Black / Black+C / Black+CA); each theme remembers its level independently
- Reduced Radarcape JSON poll interval from 5 s to 2 s — cuts worst-case callsign latency from ~8–10 s to ~5 s; typical latency from the JSON path halved
- Fixed Windshear map labels staying frozen as ICAO24 — label text was only set on marker creation; update path now calls `setIcon` on the label marker each poll so callsign appears as soon as the server has it, without requiring a page reload
- Changed Wind Rose toggle button label from "🌹 Rose" to "Windrose" — no symbol, same active colour

---

## v.18052026 — 2026-05-18 (Windshear layout and Wind Rose fonts; detection toggle and algorithm selector in the log header; five windshear detection algorithms; Wind Rose, Auto barb mode, IAS on flight strips, departure gate)

- Restructured Windshear page layout — flight strips now extend to the full bottom of the screen; METAR/TAF strip moved inside the right column so it aligns only under the map and ILS profile, not under the strips
- Fixed spurious empty gap between navbar and page content — ws-page had a redundant `margin-top: var(--navbar-h)` that doubled the offset already applied by the `main` container; replaced with `height: 100%`
- Fixed ILS profile canvas height regression caused by the layout change — `ws-map-wrap` flex-basis adjusted from `58%` to `calc(58% - 96px)` to compensate for the METAR strip now being inside the right column flex container
- Removed lightning bolt (⚡) symbols from the Windshear Log title, detection toggle button, log entries, and placeholder messages — detection toggle and log title remain visually distinct via amber colour and border styling
- Increased Wind Rose canvas font sizes — compass cardinal/intercardinal labels (12 px / 10 px), runway end numbers (11 px), METAR/MODE-S legend (10 px)
- Moved windshear detection toggle and algorithm selector out of the left panel into the Windshear Log header — toggle and dropdown now sit inline in the log header bar (Windshear Log · [OFF] · [Pair ▼] · [Clear]); left panel now uses the full height exclusively for flight strips
- Changed algorithm selector from five compact pill buttons to a single dropdown (`<select>`) — less space, all five options (Pair, Gradient, Energy, Rate, Baseline) accessible from one control with full description in tooltip
- Added five selectable windshear detection algorithms replacing the single pairwise method — Pairwise (classic ICAO, ≥ 2 aircraft), Gradient (single-aircraft wind history dHW/dz), Energy (groundspeed + altitude proxy, GPWS-inspired), Rate (headwind change over recent observation window), Baseline (compare to vector-averaged recent landing wind); active algorithm selected via a compact button row below the detection toggle
- Added GS history buffer for the Energy algorithm — groundspeed + altitude + timestamp stored per corridor aircraft on every poll cycle; pruned when aircraft leave the tracker
- Added algorithm badge (coloured pill) to windshear log entries; updated log deduplication key to include algorithm so switching algo logs fresh events immediately
- Fixed alert banner and flight-strip WS badge for single-aircraft algorithms — previously only Pairwise-format events (cs_low / cs_high) were handled; now all five event shapes are supported
- Added per-algorithm accent colours for log badges (Pair = blue, Gradient = green, Energy = orange, Rate = purple, Baseline = teal)
- Updated README with detailed physics documentation for all five windshear detection algorithms and updated windshear event log section
- Added Wind Rose widget on Windshear page — compass rose overlay on the map showing METAR surface wind (cyan arrow) vs. MODE-S derived wind (green arrow) from recently landed aircraft at ≤ 2 000 ft; wind rose is enabled by default via the `🌹 Rose` toggle button; MODE-S wind is vector-averaged from a 30-minute rolling buffer of low-altitude observations harvested when approach aircraft go stale; numeric readout below the compass shows direction/speed and observation count with age
- Fixed Wind Rose arrow convention and runway labels — arrows now point in the downwind direction (where the wind blows TO) so the arrowhead points toward the runway label that has a headwind; runway end labels corrected to match threshold convention (047° end = RWY 22, 227° end = RWY 04, 152° end = RWY 33, 332° end = RWY 15)
- Added Auto barb mode on ILS profile — `🌬 Barbs` button now has an `Auto` segment; when enabled, the system automatically selects the lowest aircraft on approach (smallest distance from threshold) and holds it until it goes stale, then hands off to the next arrival; manual strip click disables auto and pins the selected aircraft
- Added entry state gate in windshear tracker — new corridor entrants climbing faster than +200 fpm are rejected, filtering departing aircraft that briefly pass the ILS geometric gates near the threshold; existing tracked aircraft are fully exempt so go-around detection is unaffected
- Added Indicated Airspeed (IAS) field to Windshear flight strips — sourced from BDS 6,0 decoded data, shows `—` when not available
- Fixed near-ground stale indicator on ILS canvas not triggering — tracker was writing sweep time instead of actual receiver last-seen time to the state dict

---

## v.17052026 — 2026-05-17

- Fixed go-around detector false triggers when aircraft join ILS glideslope from below — increased `WINDSHEAR_GA_MIN_DESCENT_POLLS` default from 5 to 8 (24 s confirmed descent required)
- Fixed Clear button in windshear log — cleared go-around entries no longer bounce back on the next poll cycle
- Fixed squawk codes not appearing on flight strips — squawk now decoded directly from Beast feed (DF5/DF21 Mode-A replies) in addition to Radarcape JSON feed
- Fixed windshear detection including aircraft not yet established on glideslope — detection now restricted to aircraft with GS status ON (within ±300 ft of corrected glideslope)
- Added near-ground stale indicator on ILS vertical profile — aircraft below 1 000 ft with no data received for 10 s are shown as a dimmed blue dot with label removed; normal tracker removal still applies at 30–45 s
- Increased METAR/TAF font size on both Live Map and Windshear pages; colour unified to match across both pages

---

## v.16052026 — 2026-05-16

- Added squawk code badge on Windshear flight strips — grey pill for normal codes, red pill for emergency codes
- Added emergency squawk alarm banner for codes 7500 (HIJACK), 7600 (NORDO), 7700 (MAYDAY) with blinking strip label
- Added go-around detector — server-side st
