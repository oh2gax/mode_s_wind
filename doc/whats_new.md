# What's new in MODE-S Wind

Short notes for users of the web pages, newest first. Each version is one day of
development (v.DDMMYYYY). The full technical history is in CHANGELOG.md.

## v.25102026 — About window, Statistics page, go-arounds kept for 24 hours, model and aircraft winds on the Live Map

- **About**: the new button right of the version (**What's new**) opens a window with who made MODE-S Wind and how to reach him, where the receiver is, and a description for meteorologists and scientists: how the wind, temperature and pressure-surface heights are measured and verified, the derived products (temperature anomaly, lapse rate, vertical motion, vorticity, …), the new windshear detection, why the system is interesting, and special credits to Siebren de Haan (KNMI) and Junzi Sun (TU Delft, pyModeS), whose work this system builds on. On smaller screens it is a small **i**.
- The top bar now fits also on 1 280 px wide screens; below 1 550 px the clock shows the time only (hover it for the date).
- **New Statistics page**: what the receiver hears from the aircraft, updated every 10 seconds — messages per second, the message formats, which Comm-B registers the aircraft are asked for, the ADS-B messages, and **how often each aircraft answers** on final, in the terminal area and en route (the rhythm of the WAM and radar interrogations behind the wind and windshear data). It also lists the **ground interrogators** whose all-call replies are heard, so a change in the ground system shows up, and how many winds the replies give.
- **Model winds on the Live Map**: the ☂ weather panel has a new **Wind** choice — the MEPS model's 10 m wind (with gusts if you like) or its wind at **FL50, FL100, FL200, FL300, FL340 or FL390** (within about 300 km of the receiver). The barbs are drawn in a muted grey under the aircraft, so you can compare the model with the winds the aircraft measure; hover a barb for its wind and temperature. It works with the radar too.
- **Aircraft winds on the Live Map too**: under *Barbs* tick **Mode S** to draw the winds the aircraft themselves measured at the chosen flight level over the last 3 hours (or 1, 6, 12, 24 h), averaged into 50 km squares as on the Wind Map page — in colour by speed, faint where only one or two aircraft were there. Tick **MEPS model** as well to compare them with the model's grey barbs; hover a barb for the details.
- **Statistics page: signal strength, range rings and 24 hours.** A histogram of how strongly the replies arrive (for all messages or one kind, e.g. ADS-B), and **range rings** that show how far the receiver hears aircraft in each direction at high, middle and low levels — hover a sector for the farthest aircraft. The table below them gives the positions and the typical signal per distance. The **Window** now also has **24 h**.
- **System health at a glance** on the Statistics page, right of the Window buttons: a green, amber or red dot for each important part — the receiver feed, the aircraft list, decoding, the database, windshear, GPS, MEPS, soundings, calibrations, METAR and the Raspberry Pi itself (temperature, power, memory, disk). Hover a dot for the reason, click for the details and the recent changes. Amber also shows when the system is running on its stored calibration because there is no new model data. On smaller screens it is one chip, e.g. *Healthy 10/10*.
- **New user guide: Mode S & ADS-B and the Statistics page** (User guides tab, or the **?** on the Statistics page): how Mode S interrogations, replies and ADS-B work, what every register contains, how to read each part of the page and what you can analyse with it — the sample rate of the wind data, changes in the radar and WAM network, the aircraft fleet, the receiver itself. The Interrogators table now also says what each code is used for (radar, WAM / multilateration, test, military).
- **GPS Quality and GPS Episodes now share one GPS link** in the top bar; switch between them with *Quality / Episodes* at the top left of the page.
- **Go-arounds stay in the Windshear alert log for 24 hours** — also when you open the page later or after a restart of the server — and are stored with the windshear level active at that moment, so they can later be compared with the alerts.
- The Windshear user guide (version 1.4) is updated for these.

## v.24102026 — New windshear detection; the old algorithms are retired; wind and gusts on the Weather page; upper-level temperatures corrected; MEPS in the Indices panel and in the Skew-T analysis

- **The six old windshear algorithms are retired.** Pairwise, Gradient, Energy, Rate, Baseline and Kinematic are no longer on the Windshear page, and the algorithm selector, the ON/OFF button and the F-factor gate are gone. A study of more than 3 000 recorded landings showed that in calm weather they mostly reacted to the normal increase of the wind with height — Energy, for example, would have warned on almost every approach. Their description is kept in the user guide *Windshear detection v1 — retired algorithms* (User guides tab), so older screenshots and notes can still be read.
- **New windshear detection (v2) runs on the server** for every aircraft on final, all the time — also when nobody has the page open. It follows each aircraft's own headwind along its path (true airspeed − ground speed, straight from the aircraft's replies) and looks for sudden changes over 0.4–4 km, and it compares each flight's wind at each height with all landings and departures of the last 45 minutes, which shows a front or gust front changing the wind between flights.
- **New alert names**, as at airports: **WS advisory (ADV)** from 10 kt, **Windshear alert (WSA)** from 15 kt and **Microburst alert (MBA)** from a 30 kt headwind loss. Choose from which level the banner, strip badge and ILS-profile band appear (default WSA, or *Banner off*).
- **The alert log keeps the last 24 hours** and is shown again when you reopen the page; hover an entry for heights, distance and the F-factor.
- **Departures count too**: every climb-out is compared with the landings and departures of the last 45 minutes — whatever runway they used — and becomes a reference for the next flights. Helsinki-Vantaa works in waves and often lands on one runway while departing from another, so during a departure wave there may be no comparable landing for half an hour; the departures now fill those gaps. Their alerts are marked *departure* (`dep` in the log). In the recorded data a departure on 22R showed the sudden wind change of 17 October ten minutes before the first landing did, and another one a 16 kt change during the frontal passage on the night of 24 October.
- **A windshear report for every landing** (and departure): the Approach History has a new **WS** view with the level, the strongest headwind loss and gain, the F-factor and the change against the earlier flights. Flights of the last weeks get their report automatically after the update.
- In the first two weeks of data (calm weather) the new detector gave no windshear alert from a single approach and advisories on about 1 % of landings — mostly real low-level wind changes such as the night inversion of 11 October. The comparison with earlier landings caught the sudden wind change on runway 22L on 17 October around 09:04 UTC. The alerts are experimental research output, not an operational warning.
- **Upper-level temperatures corrected**: the aircraft read about 0.7 K too warm at cruise levels (around FL300), found the same way against the weather model and the radiosondes. The Skew-T and the time–height section now take this off above about FL240, learnt every hour from the MEPS model comparison; the Skew-T says *upper T corr.* and the hover shows the raw value. Against the soundings the error at these levels fell from 1.3 to 1.0 K. Below FL180 nothing changes, and the checks keep the raw values.
- **Humidity (trial)**: the moisture indicator now learns its offsets from the MEPS model's humidity every hour as well as from the soundings. The check after the front showed only a weak signal below 5 000 ft and none above so far, so it stays a trial while more data is collected — for the humidity itself use the MEPS line in the RH strip.
- **User guides updated**: the Sounding and Wind Map guide (version 3.1) explains the upper-level temperature correction and the new columns of the MEPS and Sonde checks, what the humidity trial showed through the front, the MEPS column of the Indices panel and *Analysis of*; the Skew-T guide (version 4.5) the *upper T corr.* badge and hover and the analysis of the MEPS model or the sonde with its cloud layers.
- **Model data stays optional**: everything is still measured from the aircraft alone; the MEPS model is only used for comparison and to learn these two small calibrations, and without it the system keeps working with the last learnt values or the soundings.
- **MEPS in the Indices panel** (Sounding page): tick **MEPS** above the Skew-T and the panel shows the model's indices in their own column next to Mode S — with **Sonde** ticked as well, all three side by side. The model's humidity gives the indices the aircraft cannot (Showalter, K index, Total Totals, precipitable water), and its surface values come from the model itself. Values of the model or the sonde that differ clearly from Mode S are shaded; hover any value to see the difference. In *Area · now* the model column is a short forecast (*fcst*).
- **Skew-T analysis of the model or the sonde** (Live Map and Sounding page): the new **Analysis of** selector below the diagram runs the Analysis on the **MEPS** model or the **Sonde** instead of the aircraft (Mode S stays the default). The model and the sonde bring their own surface values and humidity, so the cloud base, CAPE and Lifted Index of *Full* come from them. A tag at the top left says which profile is analysed; if it is not available (box unticked, no data, no network) the analysis stays with Mode S and the tag says so. From *Stability* up, the model or sonde analysis also shades the **likely cloud layers** — where the relative humidity is 90 % or more (over ice in sub-zero air) — with their base and top, e.g. *CLOUD 3,800ft–7,800ft*.
- **Windshear engine status line**: under the Windshear Alert header a single line now shows that the detection is running on the server (green dot), how many aircraft it is analysing, how many earlier flights the comparison can use (fewer than 3 at night: *band check waiting*), how many landings and departures it has checked today with their levels, and the strongest value of the day. Hover it for the details.
- **Wind barbs right away**: the wind barbs on the Windshear page's ILS profile are now collected on the server. When you open the page, the aircraft already on final show their barbs from the whole approach so far, instead of starting empty.
- **More data for windshear research**: each landing now also stores the aircraft's own ADS-B ground speed, broadcast about twice a second, to test later whether it can make the windshear detection finer. The user guides now say that the interrogations come from Fintraffic's wide-area multilateration (WAM) network as well as radars.
- **New user guide: Windshear detection** (User guides tab, or the **?** in the *Windshear Alert* header of the Windshear page): how the new detection works and is calculated, the research it builds on, how to read the alerts, the log and the WS view of the Approach History, with the wind change of 17 October as a worked example.
- **Wind and gusts on the Weather page**: two new tick boxes show the MEPS model's wind at 10 m as wind barbs and its gusts as shading — from 25 kt through gale (34 kt) and storm (48 kt) to hurricane force. Hover the map for the wind direction and speed (kt and m/s) and the gust. After the update the last day and the forecast get the wind within about half an hour; older hours show the map without it.

## v.23102026 — Weather page, MEPS on the model's own levels and on the Wind Map

- **New Weather page**: the MEPS weather model over Scandinavia and Finland as a moving weather map — isobars with highs (H) and lows (L), rain and snow in radar-like colours and, if you like, the clouds. The time slider goes up to 7 days back and 48 hours ahead; press ▶ to watch the weather systems move, or step one hour at a time with **−1h** / **+1h**. Remember it is a model, not a radar: showers can be somewhat off in place and time.
- **Weather on the Live Map**: the new ☂ button at the top right of the map puts the weather under the aircraft — the **MEPS model** (rain and snow, low cloud, fog, isobars) or the **FMI radar** (observed rain every 5 minutes; Finland only), or **Both**: the radar's rain where the radar sees and the model's rain beyond it (Baltic states, Sweden), with the model's clouds and isobars — with an opacity slider. A dashed line marks the edge of the radar coverage. It updates by itself.
- **More cloud layers on the Weather page**: total, low, medium and high cloud and fog, and the cloud base in the hover read-out.
- **MEPS on the Skew-T in much more detail**: the model profile (the **MEPS** tick box on the Live Map and the Sounding page) is now drawn on the model's own levels — 56 levels from just above the ground up to about 190 hPa instead of the 10 standard pressure levels. Near the ground they are only 25 m apart, so the model line is a smooth curve that shows its surface inversions and the shape of the tropopause, also in the Airport zoom. If the detailed levels of an hour are missing, the old 10 levels are used and the label says *10 std levels*.
- **Model humidity in the RH strip**: with both **RH** and **MEPS** ticked, the strip beside the Skew-T also shows the model's relative humidity as a teal line, next to the aircraft moisture bars and the sonde's pink line — so you can follow every hour, also between the soundings, whether the aircraft moisture indicator sees the moist layers of a front arriving. Hover the strip for the layer averages.
- **User guides updated**: the Skew-T guide (version 4.2) and the Sounding and Wind Map guide (version 2.7) explain the model's levels, the new humidity line and the MEPS model on the Wind Map.
- **MEPS on the Wind Map**: the new **MEPS** tick box draws the weather model's winds at the chosen level as teal barbs — also where no aircraft fly — and the new compare mode **Mode S − MEPS model** shows in each cell how much the aircraft differ from the model (arrow and warmer / colder colour). Model maps of the last 7 days.
- **Personal logins**: the administrator can now give each tester their own username and password.
- **Calmer dark theme**: the Skew-T diagrams and the Windshear page's ILS profile, Wind Rose and Approach Conditions windows now have the same blue-grey background as the rest of the page instead of a darker shade.

## v.22102026 — MEPS check, What's new and user guides, geoid correction, honest moisture uncertainty

- **MEPS check** (Sounding page, new view): our aircraft profile compared every hour with the MEPS weather model (the model FMI uses; data from MET Norway) — temperature, wind and the heights of the pressure surfaces, level by level, also at night and between the soundings. It also shows how much of the difference to the Jokioinen radiosonde comes simply from the 100 km between Helsinki and Jokioinen.
- **MEPS** tick box on the Skew-T (Live Map and Sounding page): the model profile — temperature, dewpoint and winds in teal — next to the aircraft profile, with the difference in the label. On the Live Map it is the newest model forecast for the present hour. The model is published on 10 standard pressure levels only, so its lines are straight between them and it has fewer wind barbs than the aircraft profile — that is not missing data.
- **Live Map: bigger Skew-T** — the Atmosphere Profile panel now uses the full height of the page; METAR and TAF sit under the map, and the selected aircraft's details are in a smaller box (empty fields such as humidity are left out until an aircraft actually sends them).
- **User guides updated**: the Sounding and Wind Map guide (version 2.4) and the Skew-T guide (version 4) now explain the MEPS profile and the MEPS check.
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
