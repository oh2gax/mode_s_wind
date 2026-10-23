# User guides

The user guides listed in the **User guides** tab of the What's new window
(web/whats_new.py). Each guide: a `## title` heading, then `key: value` lines —
`file` (PDF in this folder; only these files are served, at /doc/<file>),
`version`, `date` (YYYY-MM-DD), `pages`, `open` (the pages whose **?** button
opens this guide: live and skewt (the Skew-T panels), sounding, windmap; `windmap@27` opens it at PDF page 27)
— then a blank line and the description (bullets, **bold**, `code`).

## Reading the Atmosphere Profile (Skew-T)
file: SkewT_User_Guide.pdf
version: 4.2
date: 2026-10-23
pages: 16
open: live, skewt

How to read the Skew-T diagram of the **Live Map** (the *Atmosphere Profile* panel) and the **Sounding page**: what the lines and the wind barbs mean, where the temperatures and winds come from (the aircraft themselves, not a balloon) and how reliable they are.

- The diagram element by element, the **data-quality** badge and rings, smoothing and a selected aircraft
- The **Airport** low-level profile from the landings and departures at Helsinki-Vantaa
- The **Analysis** button: tropopause, freezing level, jet streams, inversions, stability, turbulence risk, warm / cold advection, contrails and the surface parcel (cloud base, CAPE, Lifted Index)
- The comparison profiles: the Jokioinen **radiosonde**, the **MEPS** weather model on its own levels and the trial **RH** strip with the sonde's and the model's humidity

## The Sounding and Wind Map pages
file: Sounding_Page_User_Guide.pdf
version: 2.6
date: 2026-10-23
pages: 40
open: sounding, windmap@27

All views of the **Sounding page** and the **Wind Map** page, with the physics behind them and worked examples from a cold front and a strong high in October 2026.

- **Area · now**, **Area · hour** and **Flight** profiles, the **Indices** panel and the level table
- The **Time–height section**: temperature anomaly, wind, vertical motion, vorticity, heights of the pressure surfaces, tropopause and max-wind lines — and the **Moisture (trial)** indicator
- **Sonde check**: how well the aircraft profile agrees with the Jokioinen radiosonde, and the GNSS height calibration
- **MEPS check**: the aircraft against the MEPS weather model every hour, and how much of the difference to the sonde is the distance to Jokioinen; the MEPS profile on the Skew-T on the model's own levels
- The **Wind Map** (Section 8): cells and averaging, ΔT, isotachs and streamlines, jet stream, height contours and geostrophic wind, cross-section, compare modes and the time slider
