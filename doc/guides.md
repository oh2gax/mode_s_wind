# User guides

The user guides listed in the **User guides** tab of the What's new window
(web/whats_new.py). Each guide: a `## title` heading, then `key: value` lines —
`file` (PDF in this folder; only these files are served, at /doc/<file>),
`version`, `date` (YYYY-MM-DD), `pages`, `open` (the pages whose **?** button
opens this guide: live and skewt (the Skew-T panels), sounding, windmap, windshear, stats; `windmap@30` opens it at PDF page 30)
— then a blank line and the description (bullets, **bold**, `code`).

## The receiving station (brochure)
file: MODE_S_Wind_Receiving_Station_Poster_OH2GAX.pdf
version: 1.2
date: 2026-11-03
pages: 2

A two-page brochure of MODE-S Wind and its receiving station — for handing to interested people; always two pages (A4; an A3 print version beside it in the repository). The nine-page overview below has the details.

- **Front**: airliners as weather sensors — the key numbers, how it works from the transponder to the browser (with photos of the antenna, the Radarcape and the workstation), what the aircraft measure (wind, temperature, the heights of the pressure surfaces) and a graph of how well they agree with the radiosonde and the MEPS model, with the self-correction
- **Back**: low-level windshear and turbulence for every landing and departure (a front band by band in the space–time picture, the alert levels and message, wind shear flight by flight), the phone view `/app` with four screens and a QR code, the pages in the browser (the GPS page for users with the Full view right), and how to see it live — a research system, not for flight operations

## The receiving station (A4 overview)
file: MODE_S_Wind_Receiving_Station_OH2GAX.pdf
version: 1.15
date: 2026-11-03
pages: 9

A nine-page overview of the station behind MODE-S Wind — poster style, for printing or showing to others.

- The hardware: the 1090 MHz antenna, the Jetvision Radarcape and the Raspberry Pi 4, and the signal chain from the aircraft's transponder to the browser
- What the aircraft send: Mode S EHS, the Comm-B registers (BDS 5,0, 6,0 …), ADS-B and the quality gates
- From replies to weather: the formulas for wind, temperature and the heights of the pressure surfaces; the self-correction and calibration against the soundings and the MEPS model; data storage and the pages (the GPS pages for users with the Full view right)
- **Windshear detection and the ongoing study** (page 3): headwind ramps and the band comparison, the alert levels (with the 14-kt rule), the alert message in the controllers' short form with its spoken form, the study phases so far and the results
- **One system, two sites** (page 4): the off-grid capable local station and the cloud server at https://mode-s-wind.oh2gax.org that serves the users, the tunnel between them, how both are kept up to date, and what comes next
- **MODE-S Wind on your phone** (page 5): the mobile view `/app` for all users — opening it, *Add to Home Screen*, a QR code, screens of the Skew-T, the ILS approach with the turbulence (EDR) of the last hour on the approach map, ACI + windshear and Statistics, and the eight views
- **Turbulence and the boundary layer** (page 6): EDR from the headwind replies of every landing and departure, with the ICAO classes and the first results; the low-level jet and the surface inversion hour by hour, and how they relate to the windshear levels
- **The ATC-style map** (page 7, research): the Live Map and the Windshear map as a radar display for readers with an air traffic control background — how a full label is read (callsign / level, trend and selected level / ground speed and type), history plots, speed vectors, labels kept apart, the selected altitude (BDS 4,0 / ADS-B), **Hover** — the six-line extended label of the aircraft under the mouse (airspeeds, Mach, heading, drift, bank, wind components, AP / APP) — with live traffic of 30 Oct 2026 drawn in the style; not for air traffic control
- **Windshear v8 and the boundary layer per flight** (page 8): the headwind every 0.5 s from the aircraft's own ADS-B ground speed (detection v8, from 31 Oct 2026) with one landing's headwind profile, and the headwind, its change and the wind shear of every landing and departure as its own column
- **More receivers, one weather** (page 9, from 2 Nov 2026): how the multi-receiver system works — each receiver sends its live stream through its own outbound, encrypted tunnel and the cloud server merges them into one stream of replies (one clock, each reply once, in time order); the merge in four steps with an illustration, what it gives (more of the low approach, fewer gaps, it keeps going when one receiver stops), where it shows, what comes next, and how a new receiver joins

## Reading the Atmosphere Profile (Skew-T)
file: SkewT_User_Guide.pdf
version: 4.9
date: 2026-10-29
pages: 21
open: live, skewt

How to read the Skew-T diagram of the **Live Map** (the *Atmosphere Profile* panel) and the **Sounding page**: what the lines and the wind barbs mean, where the temperatures and winds come from (the aircraft themselves, not a balloon) and how reliable they are.

- The diagram element by element, the **data-quality** badge and rings, smoothing and a selected aircraft
- The **Airport** low-level profile from the landings and departures at Helsinki-Vantaa, with the hour's **low-level jet** and **surface inversion**
- The **Analysis** button: tropopause, freezing level, jet streams, inversions, stability, turbulence risk, warm / cold advection, contrails and the surface parcel (cloud base, CAPE, Lifted Index) — of the aircraft, the MEPS model or the sonde (**Analysis of**, with likely cloud layers)
- The comparison profiles: the Jokioinen **radiosonde**, the **MEPS** weather model on its own levels (its wind barbs beside the aircraft's) and the trial **RH** strip (the hour in progress and the last full hour) with the sonde's and the model's humidity
- The **upper-level temperature correction** (*upper T corr.*): the fleet's warm bias at cruise levels, learnt from the MEPS model

## The Sounding and Wind Map pages
file: Sounding_Page_User_Guide.pdf
version: 3.11
date: 2026-11-05
pages: 52
open: sounding, windmap@38

All views of the **Sounding page** and the **Wind Map** page, with the physics behind them and worked examples from a cold front and a strong high in October 2026.

- **Area · now**, **Area · hour** and **Flight** profiles, the **Indices** panel (Mode S, MEPS and the sonde side by side) and the level table
- The **Time–height section**: temperature anomaly, wind, vertical motion, vorticity, heights of the pressure surfaces, tropopause and max-wind lines, the airport's **boundary layer** (low-level jet and surface inversion, also as an overlay; and **flight by flight** — the headwind of every landing and departure, its change against the flights before it and its vertical shear) — and the **Moisture (trial)** indicator, with its offsets from the MEPS model and the check through the front of 23–24 October
- **Sonde check**: how well the aircraft profile agrees with the Jokioinen radiosonde, and the GNSS height calibration
- **MEPS check**: the aircraft against the MEPS weather model every hour, and how much of the difference to the sonde is the distance to Jokioinen; the MEPS profile on the Skew-T on the model's own levels, the comparison at the aircraft's own positions, and the **upper-level temperature correction** learnt from it
- **Mast** (new in 3.11): the Kivenlahti mast's 10-minute temperatures and winds of the lowest 300 m against the aircraft, MEPS and the sonde — tiles, profile, time series and comparison — and the mast in the time–height section and on the Skew-T, with the night inversion of 3–4 November 2026
- The **Wind Map** (Section 9): cells and averaging, ΔT, isotachs and streamlines, jet stream, height contours and geostrophic wind, the MEPS model at the level, cross-section, compare modes (also Mode S − MEPS) and the time slider

## Windshear detection and the Windshear page
file: Windshear_User_Guide.pdf
version: 2.44
date: 2026-11-05
pages: 31
open: windshear

How MODE-S Wind finds low-level windshear from the aircraft's own Mode S replies (detection v2), the science behind it and how to read the **Windshear** page.

- The method step by step: the headwind from both airspeed registers against the aircraft's ADS-B ground speed (**detection v8**, from 31 October 2026; before, and for a flight without ADS-B ground speed, TAS − GS from each BDS 5,0 reply), **headwind ramps** scaled to a 1-km equivalent, the horizontal **F-factor**, and the **band comparison** with the landings and departures of the last 45 minutes (each flight with its own phase; higher limits for turboprop departures), the trial ramps along the departures
- The alert levels **ADV / WSA / MBA** (small ramps judged against the other flights' profile; a windshear alert needs a real change of 14 kt, as at Hong Kong), ramp alerts **confirmed** or **isolated** by the nearby landings, **unverified** levels from aircraft with jammed GNSS (no alert, shown as `WSA?`), the higher limits of **turboprop climb-outs** (by height from 5 November 2026), how an event becomes an alert, and the windshear report of every landing and departure
- The scientific basis with references: ICAO definitions, the NASA/FAA F-factor, the Hong Kong Observatory's headwind-ramp alerting, LLWAS/TDWR alert levels
- The **alert message** in the controllers' short form (e.g. `15A WSA 15K+ 2MF` — runway one five arrival, windshear alert, 15-kt gain, two-mile final), marked as research
- The page: banner, flight-strip badges, the map (the traffic **ILS Only / Departures / All 30NM / All 100NM**, labels with A023 / FL061, speed vectors, history plots and the **ATC** map style shared with the Live Map — radar look, three-line labels kept apart and clear of the finals, range rings, **Hover** for the extended label, the **EDR** button for the turbulence of the recent landings — and departures — on the finals), ILS profile, alert log (alerts and go-arounds of the last 24 hours, dated and fading with age) and the **engine status line**, Approach History (**«** for a narrow panel) **WS** view with **landings and departures** and a click for **one flight's headwind profile** against the flights before it, the chart views **ACI + EDR**, **WS** and **EDR + WS** on one time axis and the **space–time diagram (ST)**, wind rose
- **The boundary layer** (research): the low-level jet and the surface inversion hour by hour, the **BL** view (also **flight by flight**: headwind, its change and the wind shear of every landing and departure), and the **LLJ / INV** tag of the windshear alerts and reports
- **Turbulence (EDR)** (research): the ICAO turbulence measure of every landing and departure from the aircraft's own replies (departures up to 5 000 ft), the **EDR + WS** and **ACI + EDR** views and the Approach History **EDR** view with its filter
- **METAR and pilot reports**: the METAR windshear groups (`WS R22L`) and the pilot reports (ARS, WXREP) near the airport on the ACI + windshear view, and the Approach History's **Reports** list with the archive of windshear METARs
- **Any day in the chart window**: the ACI, WS, EDR, BL and ST views for a chosen date (yesterday or any stored day) instead of the last hours, with the WS and ST views of 2 November 2026
- Cases from October 2026 (the wind change of 17 October, a shear layer on 23 October, turbulence on 26 October), first results and the limitations

## Mode S & ADS-B and the Statistics page
file: Statistics_User_Guide.pdf
version: 1.13
date: 2026-11-05
pages: 18
open: stats

What the receiver hears from the aircraft, and how to read and use the **Statistics** page.

- Mode S and ADS-B in a nutshell: interrogations and replies, all-call and roll-call, the 24-bit address, interrogator codes (II / SI), squitters, and who interrogates around Helsinki (Fintraffic's WAM network and the Mode S radars)
- The messages: the downlink formats, parity and why some addresses cannot be verified; Comm-B and the registers 1,0 … 6,0 (ELS / EHS) with their contents; the ADS-B type codes, versions and the GNSS − baro difference
- The page part by part: summary bar, the **system health** dots and panel (including the magnetic declination model, and the **Pi / Server** dot of the computer the page runs on), the windows 1 min … **7 d**, message rate (1 h / 24 h / 7 d), the **data transfer** meter (bytes from the receiver, served to the users and through the network interface — per minute, hour, day and month), downlink formats, **signal strength**, Comm-B registers, ADS-B type codes, **reply cadence** per flight phase, **interrogators** from the all-call replies, the **Radarcape receiver**'s own status (GPS flags, timestamps, GPS module temperature, settings), **range rings**, meteo yield and the Radarcape aircraft list — and how the history is kept over restarts
- **More receivers** (from 2 Nov 2026): the receiver row — **All receivers** (every receiver's replies, each once: what the weather uses) and each receiver's own tab; how the cloud server merges them (one time scale, each reply once, late and too-late frames); the *Receivers · merged* panel and a receiver's own panel; a feed dot per receiver; and who sees which receiver — everyone *All receivers*, the owners their own (**yours**), Full view every receiver
- What you can analyse: the sample rate of the wind data, changes in the ground system, the aircraft fleet, receiver, antenna and data quality, ACAS activity — and the limitations of a passive receiver

## MODE-S Wind on a phone
file: Mobile_User_Guide.pdf
version: 1.56
date: 2026-11-05
pages: 49

How to use the mobile view **`/app`** on a phone: one product at a time, filling the screen, every choice in the ☰ menu.

- Opening `/app`, **Add to Home Screen** on Android and iPhone, the top bar (UTC time, theme Dark / Light / **Auto** following the phone) and the system-health dot
- The menu: view tiles, folding options of each product, tap buttons, switches and the date / hour steppers; **What's new**, **About** and all the **User guides** in the General section
- Tap for values, scrolling, portrait and landscape, when each view is updated (and the data the live ILS view uses)
- **Skew-T** (Area now / Area hour), **Time–height** (also the boundary layer and its flight-by-flight headwind, change and shear), the live **ILS approach** (glideslope, traffic, wind barbs, windshear alerts, strips with ATC-style altitudes, the **approach map** with speed vectors, departures and **turbulence (EDR)** on request, ATC labels placed apart with leader lines and the **extended label** on a tap, **All tracked (30 NM)** and the **ATC map style** of the big pages, the **approach history** of the last 3–6 h under the strips, and the optional **WS + EDR** or **WS + ACI chart**, 3–12 h), **EDR · WS · ACI · ST** with **ACI + EDR + WS**, **EDR + WS** and a **boundary-layer chart below** on the same hours (also under the ILS view's chart), the space–time diagram and the **boundary layer** (low-level jet, inversion, and flight by flight: headwind, its change and the shear; also a line in the ILS view) and the list of the period's flights, the **History** of landings and departures (also **Both** in one list, the departures' runway in light blue) with its search and each flight's **headwind profile** chart, the **EDR** chip and *Show: Turbulence*, the **METAR & reports** list (windshear METARs and pilot reports, also on the charts), and the **Statistics** (message rate, downlink formats, meteo yield, range rings and the sections you switch on; with more receivers *All receivers* and, for its owners and Full view, a receiver's own tab marked **yours**), and the **Weather** maps (MEPS, 6 h back to 24 / 48 h ahead, slider and animation, tap for values, the **2.5 km detail** near the airport when zoomed in, **smooth shading** or grid cells, the **2 m temperature** in colours or isotherms, and as **numbers** on their own, the **FMI radar** at the present hour, one **Opacity** for all the coloured layers, the live air traffic with the ATC map and labels, and the extended label on a tap, and the receivers as small triangles), and — for users with the **Full view** right — **GNSS** (degraded GPS now, hour by hour or day by day up to 3 months, the **FL band heatmap**, the live list and the spoofing indicators), with their options
- **Pilot** (the Pilot right, research only): **Now** — the METAR, runways in use, the wind on final, windshear, turbulence and go-arounds; **Approach** — the headwind on final by runway in ft above the runway, your aircraft class highlighted; **Departure** — the headwind, crosswind and temperature on the climb-out with a climb table and the low-level jet; **Aloft** — winds and temperatures by flight level for your class, the tropopause and the jet; **Icing** — freezing levels and a warm layer above a sub-freezing surface; **Turbulence** — EDR by height and over 6 hours; **GNSS** — degraded GPS as counts; **My flight** — a landing or departure against the flights before it; **Map** — the Weather view's pilot presets; and the full site's **Pilot page** with the same tabs
- What to do when something looks wrong, and a quick reference

## EFHK windshear detection study (study log)
file: EFHK_MODE_S_EHS_Windshear_Detection_Study.pdf
version: 1.10
date: 2026-11-01
pages: 26

The development of the windshear detection as a study log for aviation meteorologists and atmospheric scientists — each change of the method, why it was made and what the stored data showed. Updated whenever the method changes or the database is checked.

- Phase 0: the six browser algorithms (May – 24 October 2026) and why they were abandoned; the move to the Hong Kong Observatory's headwind-ramp method
- Phases 1–5: detection v2/v3 (ramps and the band comparison on the wind vector), the relative rule for weak ramp advisories, the **confirmed / isolated** label, the band comparison by flight phase and the higher limits for turboprop departures — each with its evidence and replay; the new tools (space–time diagram, trial ramps along the climb-out); the first night of the departure trial — a **nocturnal low-level jet**, the climb into it and two departure advisories during its weakening
- **Comparison with the Hong Kong lidar method** (GLYGA): a replay of its 14-kt alert rule over all stored landings, the severity–length (Woodfield) diagram and the alert duration
- **Turbulence (EDR)** from the replies (method, the rejected first version, results against the ACI and the wind, class independence, why the departure series now reach 5 000 ft), the **boundary layer** (low-level jet and surface inversion hour by hour, and how both relate to the windshear flags and the turbulence) and the **validation data** (METAR windshear groups, pilot reports)
- **Phase 7: the ADS-B ground speed and the BDS 6,0 airspeed** in the headwind — timing, temperature, agreement of the two registers, noise and density, the replay of the ramps and whether the extra short ramps are real; detection v8 running in shadow beside v7
- **Phase 8: v8 becomes the detection** (31 October 2026) — receiver message times ahead of the clock found and corrected, the replay of v8 against v7 with the correction, and why v8 was switched on after one day in shadow, with v7 kept beside it
- The dated log of the database checks (the latest of 1 November 2026: the first day of v8 as the detection, and the landings that GNSS jamming leaves without a record), the results so far, the current parameters, the limits and the next steps (the short v8 ramps on windy days, the convective season, validation)

## Mode S and the Kivenlahti mast (study log)
file: EFHK_Mode_S_Mast_Wind_Study.pdf
version: 1.2
date: 2026-11-04
pages: 13

The aircraft's winds and temperatures in the lowest 300 m against the FMI's 327-m weather mast at Kivenlahti, Espoo (24 km south-west of the airport), with the MEPS model and the Jokioinen radiosonde — a study log for aviation meteorologists and atmospheric scientists, updated as the data grow.

- The mast and how it is matched with the Mode S boundary layer, MEPS and the soundings (at the same height above the ground)
- **Temperature** level by level: Mode S within 0.1 K of the mast at 217–297 m, colder below 200 m; MEPS within 0.12 K
- **Stability and inversions**: the aircraft's T(297 m) − METAR against the mast's T(297 m) − T(2 m) (r 0.83), the shallow evening and night inversions the aircraft do not see, and the case of 29 October 2026 — with MEPS too warm near the ground
- **Wind**: speeds that follow the mast closely, direction differences at the mast's 217 and 327 m shared by all three other sources, the speed profile and the low-level jet
- **Mast data quality** (version 1.1): the wind differences by wind sector — the mast's 217-m and 327-m directions off by a nearly constant +16° / −8° (a sensor alignment, not the flow; a 30° turn between them where the aircraft see 6°), its 92-m speed low in south-westerly winds; temperatures without a fault
- **Update to 4 November 2026** (version 1.2, 237 hours): the tables for the whole period; the direction offsets unchanged in the new north-westerly and northerly winds, the 92-m speed loss confined to the south-west; the strong surface inversion of 3–4 November ahead of a front (up to 5 K), seen by the aircraft from 04 UTC and with MEPS 2.8 K too warm at 26 m
- What the mast adds, the dated log of the checks (the latest of 4 November 2026), limits and next steps

## EDR explained — turbulence intensity
file: EDR_Explained.pdf
version: 1.2
date: 2026-11-01
pages: 12
open: edr

The eddy dissipation rate (EDR), the ICAO measure of turbulence, for aviation meteorologists and atmospheric scientists — with a first section in plain words for everyone. Updated whenever the MODE-S Wind calculation changes.

- **EDR in plain words**: what turbulence and EDR are, and the ICAO scale (light 0.10, moderate 0.20, severe 0.45)
- **The physics**: Kolmogorov's cascade and inertial subrange, the structure function, why EDR describes the air and not the aircraft, mean and peak
- **History and use in aviation**: from pilot reports and gust loads to MacCready, the NCAR in-situ algorithms and the ICAO standard (2001; the limits of Amendment 79, 2020, and PANS-MET), WAFS and GTG forecasts in EDR
- **Hong Kong International Airport**: the Hong Kong Observatory's anemometer, lidar and flight-data EDR and ADS-B turbulence detection
- **The MODE-S Wind method**: EDR from the headwind TAS − GS of the Mode S replies on final approach and climb-out (straight 2-km pieces, the 100–200 m structure function, the noise floor of the 2-kt rounding), its parameters (method v2 from 31 October 2026: repeated and out-of-order reply times dropped) and the scale problem
- **Results at Helsinki-Vantaa** 9–30 October 2026: distribution, surface wind and height, class independence, the daily agreement with the ACI, departures; where EDR is shown (also the Windshear map and one flight's headwind profile); limitations, calibration (the first pilot reports) and the version history

## Data-Driven Development (D-D-D) — method note
file: Data_Driven_Development_DDD.pdf
version: 1.0
date: 2026-11-04
pages: 1

How MODE-S Wind is developed: a simple loop in which the stored data decide what the code should do next — one page for software developers, engineers and scientists.

- **The loop**: collect the raw data and keep it, check it regularly, analyse it against independent references, correct the code only when the data say so, replay all stored data through the new version, and record the result
- **Seven cycles** of October–November 2026 with their numbers — among them two where the data said *not* to change the code — and one cycle in a day (the GNSS gate of 4 November 2026)
- What makes it work, and its limits

## Windshear detection v1 — retired algorithms (legacy)
file: Windshear_Algorithms_v1_Legacy.pdf
version: 1.0
date: 2026-10-24
pages: 8

The six browser algorithms of the **Windshear** page used May – 24 October 2026 (Pair, Gradient, Energy, Rate, Baseline, Kinematic), kept for reference after their retirement.

- Why they were retired: a replay of 3 084 landings showed that they mostly flagged the normal change of the wind with height
- A short summary of how they worked, and the README text of 23 October 2026
- What replaced them: detection v2, one server-side headwind-ramp detector with a windshear report for every landing
