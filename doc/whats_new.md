# What's new in MODE-S Wind

Short notes for users of the web pages, newest first. Each version is one day of
development (v.DDMMYYYY). The full technical history is in CHANGELOG.md.

## v.22102026 — MEPS check, What's new and user guides, geoid correction, honest moisture uncertainty

- **MEPS check** (Sounding page, new view): our aircraft profile compared every hour with the MEPS weather model (the model FMI uses; data from MET Norway) — temperature, wind and the heights of the pressure surfaces, level by level, also at night and between the soundings. It also shows how much of the difference to the Jokioinen radiosonde comes simply from the 100 km between Helsinki and Jokioinen.
- **MEPS** tick box on the Skew-T (Live Map and Sounding page): the model profile — temperature, dewpoint and winds in teal — next to the aircraft profile, with the difference in the label. On the Live Map it is the newest model forecast for the present hour.
- **What's new**: this window. The version of the system is shown in the top bar; a small dot on the link means there are changes you have not opened yet.
- **User guides**: the second tab of this window lists the PDF user guides with a short description; **Open PDF** opens a guide in a new browser tab. A small **?** next to the Live Map *Atmosphere Profile*, the Sounding page Skew-T and controls and the Wind Map controls opens the matching guide directly (the Wind Map one at its own section).
- **More accurate heights of the pressure surfaces**: the aircraft GNSS heights are now corrected with the geoid (the sea level is about 19 m above the GPS reference surface at Jokioinen but only 15 m east of Kotka). The Wind Map heights, the geostrophic wind and the time–height height fields are affected only slightly.
- **Moisture (trial) is more honest about its uncertainty**: a first comparison with the radiosondes showed that the indicator is a tendency, uncertain by about ±30–50 %. Uncertain cells are now drawn faint, and the hover shows how much of the uncertainty comes from the flights and how much is systematic.
- User guide (Sounding and Wind Map pages, PDF) updated to version 2.3.

## v.21102026 — Heights of the pressure surfaces, jet stream, moisture trial, faster Wind Map

- **Sounding page, Time–height section**: new colour fields **Height of the pressure surfaces**, **Height change 6 h** and **Thickness temperature check**, from the GNSS heights of the aircraft, calibrated automatically against every Jokioinen radiosonde.
- **Time–height section extras**: **Tropopause** and **Max wind** lines, each radiosonde as its own narrow column (**Sonde**), and **PNG** to save the picture.
- **Moisture (trial)**: a first experiment that shows dry / moist / humid layers between 1 000 and 15 000 ft from the aircraft heights — in the Time–height section and, with the new **RH** tick box, as a narrow strip beside the Skew-T diagram (Live Map and Sounding page) together with the radiosonde's humidity.
- **Wind Map — Jet**: the jet stream drawn as on aviation weather charts (axis line, barb flags with level and speed, change bars); **Depth** shows the levels where it is strong.
- **Wind Map — Heights, Isotherms and Section**: height contours of the pressure surface with the geostrophic wind, temperature contours at the level, and a vertical cross-section along a line you draw with two clicks.
- **Wind Map time slider**: all 24 frames are loaded at once, so dragging the slider and the ▶ animation run smoothly; maps also load much faster.
- **Sonde check**: shows the GNSS height calibration, per aircraft type and per airframe.
- Flight lists load faster; the user guide now covers the Wind Map page too.

## v.20102026 — Vertical motion and vorticity

- **Sounding page, Time–height section**: new **Vertical motion** field (rising / sinking air in cm/s, about 5 000 ft–FL200) and **Vorticity** field (the spin of the wind field: troughs and ridges).
- **Skew-T**: a dashed line now joins the airport's METAR temperature to the lowest aircraft layer, so surface inversions on calm mornings show without switching on the airport profile.
- Behind the scenes, every climb and descent is now recorded in detail for the coming height and humidity products.
- User guide updated (version 1.1).

## v.19102026 — Time–height section and the new Wind Map

- **Sounding page — Time–height section** (new view): the hourly profiles side by side over 1–14 days — temperature anomaly, 3-hour change, wind speed or lapse rate, with wind barbs and the 0 / −10 / −20 °C lines. Fronts, inversions and jet streams are seen as they pass.
- **Wind Map** rebuilt: square cells of 25 / 50 / 100 km, each aircraft counted once per cell, faint barbs where only one or two aircraft were seen, **ΔT** colouring of warm and cold air, **Isotachs** and **Streamlines**, the radiosonde at the level, **Compare** with the previous period or another level, and a **time slider** with ▶ animation over the last 24 hours.
- False GPS positions (jamming / spoofing) are removed from the Wind Map; **GNSS ok only** can leave out disturbed aircraft completely.
- New radiosondes appear sooner (about 30 minutes after launch) and are updated as the balloon climbs.
- New **Sounding page user guide** (PDF).

## v.13102026 — Clearer aircraft list and layout

- **Live Map aircraft list**: flight levels above 5 000 ft and QNH altitudes below it, the vertical rate, small ▲ / ▼ arrows for climbing and descending aircraft; no flickering scrollbar.
- **Live Map layout** adapts to large screens and tablets: the Skew-T keeps its shape.
- **Windshear page**: labels and colours readable in the Light theme; the ILS profile labels are no longer hidden behind barbs; the wind rose button is now **WR / ACI**.
- **Sounding page**: the level table is listed from the top of the profile down, like the diagram.

## v.12102026 — Radiosonde on the Skew-T and the Sonde check

- **Sonde** tick box on the Skew-T (Live Map and Sounding page): the Jokioinen radiosonde — temperature, dewpoint and winds — beside the aircraft profile, with its age and the difference from the aircraft.
- **Sounding page**: choose any stored sounding, sonde columns in the level table, a new **Indices** panel (stability indices and levels for the aircraft and the sonde side by side) and a new **Sonde check** view that measures how well the aircraft profile agrees with the radiosondes.
- **Live Map aircraft list** sorted by altitude (or A–Z), with the aircraft's heading correction.
- **Windshear page**: the map follows Light / Dark; go-arounds that begin over the runway are now counted; autopilot shown as an **AP** box.

## v.11102026 — Airport low-level profile and the new Sounding page

- **Airport** selector on the Live Map Skew-T: temperature and wind every 200 ft from the landings and departures of the last hour — as an overlay or zoomed to the lowest 5 000 ft.
- **METAR dewpoint** on the Skew-T, and with **Analysis Full** the surface parcel: cloud base (LCL), CAPE and Lifted Index.
- **Data-quality badge** on the Skew-T (GOOD / FAIR / LOW) and red rings on layers measured by only one or two aircraft.
- The **Sounding page** now uses the same Skew-T diagram as the Live Map.
- **Windshear page**: the METAR surface wind at the runway threshold on the ILS profile; approach winds low on final are more reliable.
- Skew-T user guide updated (versions 2 and 3).

## v.10102026 — Analysis on the Skew-T and heading calibration

- **Skew-T**: dry and moist adiabats, a ground line from the METAR QNH, **Smooth** (3 / 5 layers) and the **Analysis** button: tropopause, freezing level, jets, stability, turbulence and warm / cold advection.
- **Heading calibration**: the system learns each aircraft's heading error and corrects the winds — about 2 kt better on average.
- **Live Map**: registrations and aircraft types in the list and the aircraft details.
- **GPS Quality / GPS Episodes**: aircraft flagged by two or more independent spoofing checks are marked (**2+**).
- New **Skew-T user guide** (PDF).

## v.09102026 — Air temperature from every aircraft

- **Temperature from Mach and true airspeed**: almost every aircraft with wind data now gives the air temperature too, so the Skew-T profiles are full instead of nearly empty.
- **Sounding page** rebuilt: **Area · now**, **Area · hour** (hourly archive kept long-term) and **Flight**.
- **Windshear**: autopilot mark on the ILS profile and flight strips.
- **GPS Quality**: 10-minute resolution, severe vs mild degradation and spoofing indicators, with a new Severity & Spoofing panel.
- **Live Map**: the selected aircraft's track line no longer disappears; click on the map or press Esc to deselect.

## v.08102026 — One tab per page

- **Navigation**: each page opens in its own browser tab; a page that is already open is brought to the front without reloading, so your selections are kept.
- **Approach History**: a **Reg** filter shows only the landings of the registrations you type (e.g. `OH-A`).
- The approach-conditions index was tuned for turboprops, narrowbodies and widebodies.
