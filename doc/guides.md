# User guides

The user guides listed in the **User guides** tab of the What's new window
(web/whats_new.py). Each guide: a `## title` heading, then `key: value` lines —
`file` (PDF in this folder; only these files are served, at /doc/<file>),
`version`, `date` (YYYY-MM-DD), `pages`, `open` (the pages whose **?** button
opens this guide: live and skewt (the Skew-T panels), sounding, windmap, windshear, stats; `windmap@30` opens it at PDF page 30)
— then a blank line and the description (bullets, **bold**, `code`).

## Reading the Atmosphere Profile (Skew-T)
file: SkewT_User_Guide.pdf
version: 4.8
date: 2026-10-26
pages: 20
open: live, skewt

How to read the Skew-T diagram of the **Live Map** (the *Atmosphere Profile* panel) and the **Sounding page**: what the lines and the wind barbs mean, where the temperatures and winds come from (the aircraft themselves, not a balloon) and how reliable they are.

- The diagram element by element, the **data-quality** badge and rings, smoothing and a selected aircraft
- The **Airport** low-level profile from the landings and departures at Helsinki-Vantaa
- The **Analysis** button: tropopause, freezing level, jet streams, inversions, stability, turbulence risk, warm / cold advection, contrails and the surface parcel (cloud base, CAPE, Lifted Index) — of the aircraft, the MEPS model or the sonde (**Analysis of**, with likely cloud layers)
- The comparison profiles: the Jokioinen **radiosonde**, the **MEPS** weather model on its own levels (its wind barbs beside the aircraft's) and the trial **RH** strip (the hour in progress and the last full hour) with the sonde's and the model's humidity
- The **upper-level temperature correction** (*upper T corr.*): the fleet's warm bias at cruise levels, learnt from the MEPS model

## The Sounding and Wind Map pages
file: Sounding_Page_User_Guide.pdf
version: 3.4
date: 2026-10-26
pages: 44
open: sounding, windmap@30

All views of the **Sounding page** and the **Wind Map** page, with the physics behind them and worked examples from a cold front and a strong high in October 2026.

- **Area · now**, **Area · hour** and **Flight** profiles, the **Indices** panel (Mode S, MEPS and the sonde side by side) and the level table
- The **Time–height section**: temperature anomaly, wind, vertical motion, vorticity, heights of the pressure surfaces, tropopause and max-wind lines — and the **Moisture (trial)** indicator, with its offsets from the MEPS model and the check through the front of 23–24 October
- **Sonde check**: how well the aircraft profile agrees with the Jokioinen radiosonde, and the GNSS height calibration
- **MEPS check**: the aircraft against the MEPS weather model every hour, and how much of the difference to the sonde is the distance to Jokioinen; the MEPS profile on the Skew-T on the model's own levels, and the **upper-level temperature correction** learnt from it
- The **Wind Map** (Section 8): cells and averaging, ΔT, isotachs and streamlines, jet stream, height contours and geostrophic wind, the MEPS model at the level, cross-section, compare modes (also Mode S − MEPS) and the time slider

## Windshear detection and the Windshear page
file: Windshear_User_Guide.pdf
version: 1.5
date: 2026-10-25
pages: 15
open: windshear

How MODE-S Wind finds low-level windshear from the aircraft's own Mode S replies (detection v2), the science behind it and how to read the **Windshear** page.

- The method step by step: headwind TAS − GS from each BDS 5,0 reply, **headwind ramps** scaled to a 1-km equivalent, the horizontal **F-factor**, and the **band comparison** with all landings and departures of the last 45 minutes
- The alert levels **ADV / WSA / MBA**, how an event becomes an alert, and the windshear report of every landing and departure
- The scientific basis with references: ICAO definitions, the NASA/FAA F-factor, the Hong Kong Observatory's headwind-ramp alerting, LLWAS/TDWR alert levels
- The page: banner, flight-strip badges, ILS profile, alert log (alerts and go-arounds of the last 24 hours) and the **engine status line**, Approach History **WS** view, ACI and the new **ACI + windshear** view on one time axis, wind rose
- Cases from October 2026 (the wind change of 17 October, a shear layer on 23 October), first results and the limitations

## Mode S & ADS-B and the Statistics page
file: Statistics_User_Guide.pdf
version: 1.2
date: 2026-10-26
pages: 14
open: stats

What the receiver hears from the aircraft, and how to read and use the **Statistics** page.

- Mode S and ADS-B in a nutshell: interrogations and replies, all-call and roll-call, the 24-bit address, interrogator codes (II / SI), squitters, and who interrogates around Helsinki (Fintraffic's WAM network and the Mode S radars)
- The messages: the downlink formats, parity and why some addresses cannot be verified; Comm-B and the registers 1,0 … 6,0 (ELS / EHS) with their contents; the ADS-B type codes, versions and the GNSS − baro difference
- The page part by part: summary bar, the **system health** dots and panel, message rate (1 h / 24 h), downlink formats, **signal strength**, Comm-B registers, ADS-B type codes, **reply cadence** per flight phase, **interrogators** from the all-call replies, the **Radarcape receiver**'s own status (GPS flags, timestamps, GPS module temperature, settings), **range rings**, meteo yield and the Radarcape aircraft list — and how the history is kept over restarts
- What you can analyse: the sample rate of the wind data, changes in the ground system, the aircraft fleet, receiver, antenna and data quality, ACAS activity — and the limitations of a passive receiver

## MODE-S Wind on a phone
file: Mobile_User_Guide.pdf
version: 1.0
date: 2026-10-26
pages: 8

How to use the mobile view **`/app`** on a phone: one product at a time, filling the screen, every choice in the ☰ menu.

- Opening `/app`, **Add to Home Screen** on Android and iPhone, the top bar and the system-health dot
- The menu: view tiles, folding options of each product, tap buttons, switches and the date / hour steppers
- Tap for values, scrolling, portrait and landscape, when each view is updated (and the data the live ILS view uses)
- **Skew-T** (Area now / Area hour), **Time–height**, the live **ILS approach** (glideslope, traffic, wind barbs, windshear alerts, strips) and **ACI & WS**, with their options
- What to do when something looks wrong, and a quick reference

## Windshear detection v1 — retired algorithms (legacy)
file: Windshear_Algorithms_v1_Legacy.pdf
version: 1.0
date: 2026-10-24
pages: 8

The six browser algorithms of the **Windshear** page used May – 24 October 2026 (Pair, Gradient, Energy, Rate, Baseline, Kinematic), kept for reference after their retirement.

- Why they were retired: a replay of 3 084 landings showed that they mostly flagged the normal change of the wind with height
- A short summary of how they worked, and the README text of 23 October 2026
- What replaced them: detection v2, one server-side headwind-ramp detector with a windshear report for every landing
