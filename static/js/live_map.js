/**
 * live_map.js — Real-time aircraft tracking map with meteo overlay.
 *
 * ATC-style display:
 *   • Small filled square at current position (coloured by meteo source)
 *   • Short speed-vector line pointing in track direction
 *   • ~1-minute trail of fading dots at past positions
 *   • Optional callsign labels (toggle)
 *
 * Meteo source colours:
 *   Blue   (#3b82f6) — BDS 4,4 MRAR direct
 *   Green  (#10b981) — Wind computed from BDS 5,0 + 6,0
 *   Amber  (#f59e0b) — BDS 4,5 MHR hazard report only
 *   Purple (#a855f7) — Radarcape JSON / MLAT
 *   Grey   (#6b7280) — No meteo data
 */

// ── Map init ──────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true }).setView([RECEIVER_LAT, RECEIVER_LON], 8);

// CARTO_API_KEY is injected server-side in base.html (from local api_keys.py);
// appended as a query param so raster tiles are served without the watermark.
const _cartoKeyQs = CARTO_API_KEY ? `?key=${encodeURIComponent(CARTO_API_KEY)}` : '';
const TILE_DARK  = `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png${_cartoKeyQs}`;
const TILE_LIGHT = `https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png${_cartoKeyQs}`;
const TILE_OPTS  = { attribution: '© OSM, © CARTO', subdomains: 'abcd', maxZoom: 18 };

let currentTile = L.tileLayer(
  document.documentElement.dataset.theme === 'light' ? TILE_LIGHT : TILE_DARK,
  TILE_OPTS
).addTo(map);

// Receiver marker
L.circleMarker([RECEIVER_LAT, RECEIVER_LON], {
  radius: 7, color: '#fff', fillColor: '#1d4ed8', fillOpacity: 1, weight: 2,
}).bindTooltip('Receiver (EFHK area)').addTo(map);

// ── State ─────────────────────────────────────────────────────────────────
const markers        = {};   // icao → L.Marker (aircraft symbol)
const trailLayers    = {};   // icao → L.LayerGroup (trail dots)
const trails         = {};   // icao → [[lat, lon], ...] position history
const labelMarkers   = {};   // icao → L.Marker (callsign label)
const windArrows     = {};   // icao → L.Polyline (wind direction arrow)
const aircraftData   = {};   // icao → latest data object
const callsignCache  = {};   // icao → best known callsign (never downgraded to null)
const windHistory    = {};   // icao → [{pressure, alt_ft, temp_c, wind_spd, wind_dir}, ...]
const dbSeeded       = new Set(); // ICAOs whose wind history has been pre-loaded from DB

let selectedIcao = null;

const MAX_TRAIL       = 20;   // position dots kept ≈ 60 s
const MAX_WIND_HIST   = 80;   // wind obs per aircraft (≈ climb/descent profile)

// Restore persisted UI prefs — default both toggles ON
// localStorage.getItem returns null when key is absent; null !== 'false' → true (default ON)
let meteoOnly   = localStorage.getItem('ms_meteoOnly')  !== 'false';
let showLabels  = localStorage.getItem('ms_showLabels') !== 'false';
let showTrack   = localStorage.getItem('ms_showTrack')  === 'true';   // default OFF
let labelMode   = localStorage.getItem('ms_labelMode')  || 'callsign';
// Aircraft list order: 'alt_asc' (lowest on top, default), 'alt_desc', 'name'
const AC_SORTS  = { alt_asc: 'Alt ↑', alt_desc: 'Alt ↓', name: 'A–Z' };
let acSort      = localStorage.getItem('ms_acSort') || 'alt_asc';
if (!(acSort in AC_SORTS)) acSort = 'alt_asc';
let windDensity = parseInt(localStorage.getItem('ms_windDensity') || '2', 10);
// Vertical smoothing of the area temperature profile (0 = off, 1 = 3 layers, 2 = 5 layers)
let areaSmooth  = parseInt(localStorage.getItem('ms_areaSmooth') || '0', 10);
// Skew-T analysis overlay: 0 off, 1 levels, 2 + stability, 3 + turbulence,
// 4 + thermal advection and contrail levels, 5 + dry thermal top
const ANA_NAMES = ['Off', 'Levels', 'Stability', 'Turbulence', 'Advection', 'Full'];
let anaLevel    = parseInt(localStorage.getItem('ms_skewtAna') || '0', 10);
if (!(anaLevel >= 0 && anaLevel < ANA_NAMES.length)) anaLevel = 0;
if (![0, 1, 2].includes(areaSmooth)) areaSmooth = 0;
// Skew-T data-validity indicator (badge, rings on 1–2-aircraft layers); default ON
let dqShow      = localStorage.getItem('ms_skewtDq') !== 'false';

let selectedTrackLayer = null;   // Leaflet polyline for selected aircraft's DB track
// Track of the selected aircraft: [[lat, lon, ts], …] — its stored positions
// of the current flight (fetched on selection) followed by live positions.
// Kept separate from windHistory (capped at MAX_WIND_HIST for the profile),
// and kept while the aircraft is briefly missing from the live data.
let selTrackPts  = [];
let selTrackIcao = null;          // aircraft whose stored track has been fetched
const MAX_TRACK_PTS = 4000;

// ── Source colours ────────────────────────────────────────────────────────
const SOURCE_COLOR = {
  'MRAR':     '#3b82f6',
  'COMPUTED': '#10b981',
  'MHR':      '#f59e0b',
  'JSON':     '#a855f7',
  'NONE':     '#6b7280',
};

function acColor(ac) {
  return SOURCE_COLOR[ac.meteo_source] ?? SOURCE_COLOR['NONE'];
}

function getLabelText(ac) {
  if (labelMode === 'icao') return ac.icao;
  if (labelMode === 'reg')  return ac.registration || callsignCache[ac.icao] || ac.icao;
  return callsignCache[ac.icao] || ac.icao;
}

// Escape text from the data feeds before it goes into innerHTML
function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Secondary identity line: registration · type · ICAO24 (whatever is known)
function idLine(ac, withIcao = true) {
  const parts = [];
  if (ac.registration)  parts.push(ac.registration);
  if (ac.aircraft_type) parts.push(ac.aircraft_type);
  if (withIcao)         parts.push(ac.icao);
  return parts.map(esc).join(' · ');
}

// ── Wind profile history (per aircraft) ───────────────────────────────────
// Accumulates wind observations as an aircraft climbs or descends so the
// mini Skew-T can show a full vertical wind profile, not just one barb.
function updateWindHistory(ac) {
  if (!ac.best_wind_spd || !ac.best_wind_dir || !ac.altitude) return;
  // Wind / temperature from radar replies older than WIND_MAX_AGE_SEC: they
  // were measured at another altitude, so they are not placed at this one
  if (ac.wind_stale) return;

  if (!windHistory[ac.icao]) windHistory[ac.icao] = [];
  const hist = windHistory[ac.icao];
  const last = hist[hist.length - 1];

  // Only record a new point when altitude changed by ≥ 400 ft so level
  // cruise doesn't fill the array with identical readings.
  if (last && Math.abs(last.alt_ft - ac.altitude) < 400) {
    // Still update the last entry's wind/temp in case it improved
    last.wind_spd = ac.best_wind_spd;
    last.wind_dir = ac.best_wind_dir;
    if (ac.best_temp     != null) last.temp_c  = ac.best_temp;
    // Always derive from altitude — best_pressure may be QNH, not static air pressure
    last.pressure = altToPressHPa(ac.altitude);
    return;
  }

  hist.push({
    alt_ft:   ac.altitude,
    pressure: altToPressHPa(ac.altitude),
    temp_c:   ac.best_temp,
    wind_spd: ac.best_wind_spd,
    wind_dir: ac.best_wind_dir,
  });

  if (hist.length > MAX_WIND_HIST) hist.shift();
}

// ── Mini sounding profile ─────────────────────────────────────────────────
// The Skew-T itself is drawn by static/js/skewt_chart.js (createSkewT), the
// same diagram as on the Sounding page; this page supplies its data and
// options and keeps the controls.

let miniAcOverlay  = null; // {alt_ft, temp_c, color} when aircraft selected
let miniSfc        = null; // METAR ground point {p, qnh, t, td, elev, station, time, cld}

// ── Area profile for the mini Skew-T (from /api/sounding, every 5 min) ──────
let miniArea     = null;   // last /api/sounding response

async function fetchMiniArea() {
  try {
    const r = await fetch('/api/sounding?minutes=60');
    if (!r.ok) return;
    miniArea = await r.json();
    drawMiniSounding();
  } catch (_) { /* silent */ }
  fetchMiniLow();
}

// ── Airport low-level profile (landings + departures, /api/lowlevel) ──────
// aptMode: 'off' | 'overlay' (amber profile 200–3 000 ft MSL on the diagram)
// | 'zoom' (diagram range surface … 850 hPa, airport profile with its winds)
let aptMode = localStorage.getItem('ms_aptMode') || 'off';
let miniLow = null;    // last /api/lowlevel response
async function fetchMiniLow() {
  if (aptMode === 'off') { miniLow = null; return; }
  try {
    const r = await fetch('/api/lowlevel?minutes=60');
    if (!r.ok) return;
    miniLow = await r.json();
    drawMiniSounding();
  } catch (_) { /* silent */ }
}

const skewt = createSkewT(document.getElementById('mini-sounding-canvas'),
                          document.getElementById('mini-skewt-tip'), { lat: RECEIVER_LAT });

function syncSkewT() {
  skewt.set({
    area: miniArea, low: miniLow, aptMode, anaLevel, smooth: areaSmooth, sfc: miniSfc,
    ac: miniAcOverlay, density: windDensity,
    acLabel: (selectedIcao && getLabelText(aircraftData[selectedIcao] || {})) || 'Aircraft',
    profileTitle: 'Area, last ' + (miniArea ? miniArea.window_min : 60) + ' min',
    hint: null, dq: dqShow,
  });
}
function drawMiniSounding() { syncSkewT(); skewt.draw(); }
function miniHover(ev)      { syncSkewT(); skewt.hover(ev); }

// ── Responsive canvas sizing ───────────────────────────────────────────────
// Fills all available height in the right panel.  Called once on load and
// whenever the panel changes size (window resize / font-size change, etc).
function resizeMiniCanvas() {
  const canvas = document.getElementById('mini-sounding-canvas');
  if (!canvas) return;
  const wrap = canvas.parentElement;
  if (!wrap || wrap.clientWidth === 0) return;
  // Sum the heights of every sibling element (density row, ac-info line)
  let fixedH = 0;
  for (const child of wrap.children) {
    if (child !== canvas && child.id !== 'mini-skewt-tip') fixedH += child.offsetHeight + 4; // 4 = flex gap
  }
  fixedH += 8; // wrap top + bottom padding (4px each)
  const w = Math.max(160, wrap.clientWidth  - 8);
  const h = Math.max(160, wrap.clientHeight - fixedH);
  if (skewt.resize(w, h)) drawMiniSounding();
}

// ── ATC-style aircraft icon ───────────────────────────────────────────────
// A filled square with a speed-vector line pointing in the track direction.
function makeIcon(color, track, selected) {
  const sq    = selected ? 8 : 5;       // half-width of the square (px)
  const S     = 60;                     // SVG canvas size
  const cx    = 30, cy = 30;            // centre point
  const vLen  = selected ? 22 : 16;     // speed-vector length (px)
  const sw    = selected ? 2.5 : 1.5;   // stroke width

  // Convert track (°, 0=North, clockwise) to SVG angle (0=right, clockwise)
  const rad = ((track ?? 0) - 90) * Math.PI / 180;
  const vx  = (cx + vLen * Math.cos(rad)).toFixed(1);
  const vy  = (cy + vLen * Math.sin(rad)).toFixed(1);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
    <line x1="${cx}" y1="${cy}" x2="${vx}" y2="${vy}"
          stroke="${color}" stroke-width="${sw}" stroke-linecap="round" opacity="0.9"/>
    <rect x="${cx - sq}" y="${cy - sq}" width="${sq * 2}" height="${sq * 2}"
          fill="${color}" stroke="#ffffff" stroke-width="${sw}" opacity="0.95"/>
  </svg>`;

  return L.divIcon({
    html:       svg,
    className:  '',
    iconSize:   [S, S],
    iconAnchor: [cx, cy],
  });
}

// ── Trail dots ────────────────────────────────────────────────────────────
function updateTrail(icao, lat, lon, color) {
  if (!trails[icao]) trails[icao] = [];
  const t    = trails[icao];
  const last = t[t.length - 1];

  // Only store if position has moved meaningfully (~50 m threshold)
  if (!last || Math.abs(last[0] - lat) > 0.0005 || Math.abs(last[1] - lon) > 0.0005) {
    t.push([lat, lon]);
  }
  if (t.length > MAX_TRAIL) t.shift();

  // Rebuild trail layer
  if (trailLayers[icao]) trailLayers[icao].remove();
  const group = L.layerGroup();
  const n     = t.length;
  for (let i = 0; i < n - 1; i++) {          // skip newest (that's the main marker)
    const frac = i / Math.max(n - 2, 1);     // 0 = oldest, 1 = newest-1
    L.circleMarker(t[i], {
      radius:      2,
      color:       color,
      fillColor:   color,
      fillOpacity: 0.10 + 0.55 * frac,
      weight:      0,
      interactive: false,
    }).addTo(group);
  }
  group.addTo(map);
  trailLayers[icao] = group;
}

// ── Callsign labels ───────────────────────────────────────────────────────
function updateLabel(icao, lat, lon, label) {
  if (!showLabels) {
    if (labelMarkers[icao]) { labelMarkers[icao].remove(); delete labelMarkers[icao]; }
    return;
  }
  const icon = L.divIcon({
    html:       `<div class="ac-map-label">${label}</div>`,
    className:  '',
    iconSize:   null,
    iconAnchor: [-10, 6],   // offset: label sits to the right of the square
  });
  if (labelMarkers[icao]) {
    labelMarkers[icao].setLatLng([lat, lon]).setIcon(icon);
  } else {
    labelMarkers[icao] = L.marker([lat, lon], {
      icon,
      interactive:  false,
      zIndexOffset: -100,
    }).addTo(map);
  }
}

// ── Wind arrow ────────────────────────────────────────────────────────────
function drawWindArrow(icao, lat, lon, windSpd, windDir) {
  if (windArrows[icao]) windArrows[icao].remove();
  if (windSpd == null || windDir == null || windSpd < 1) return;

  const len     = Math.min(0.012, windSpd / 1000);
  const dir_rad = (windDir + 180) * Math.PI / 180;
  const endLat  = lat + len * Math.cos(dir_rad);
  const endLon  = lon + len * Math.sin(dir_rad) / Math.cos(lat * Math.PI / 180);

  windArrows[icao] = L.polyline([[lat, lon], [endLat, endLon]], {
    color: '#93c5fd', weight: 1.5, opacity: 0.7,
  }).addTo(map);
}

// ── Update / create marker ────────────────────────────────────────────────
function upsertMarker(ac) {
  if (!ac.lat || !ac.lon) return;

  const color    = acColor(ac);
  const selected = ac.icao === selectedIcao;
  const icon     = makeIcon(color, ac.track, selected);
  const label    = getLabelText(ac);

  const cs = callsignCache[ac.icao] || ac.callsign;
  let popup = `<b>${esc(cs || ac.registration || ac.icao)}</b>  <span style="color:${color}">${ac.meteo_source || 'NONE'}</span><br>`;
  popup += `<span style="color:var(--text-3,#9ca3af);font-size:11px">${idLine(ac)}</span><br>`;
  if (ac.altitude)    popup += `${ac.altitude.toLocaleString()} ft &nbsp;`;
  if (ac.groundspeed) popup += `${ac.groundspeed} kt &nbsp;`;
  if (ac.track)       popup += `${ac.track.toFixed(0)}°<br>`;
  if (ac.best_temp    != null) popup += `Temp: <b>${ac.best_temp.toFixed(1)}°C</b> &nbsp;`;
  if (ac.best_wind_spd != null)
    popup += `Wind: <b>${ac.best_wind_spd.toFixed(0)} kt @ ${ac.best_wind_dir?.toFixed(0)}°</b>`;

  if (markers[ac.icao]) {
    markers[ac.icao].setLatLng([ac.lat, ac.lon]).setIcon(icon);
    markers[ac.icao]._popup.setContent(popup);
  } else {
    const m = L.marker([ac.lat, ac.lon], { icon })
      .bindPopup(popup)
      .addTo(map);
    m.on('click', () => selectAircraft(ac.icao));
    // Closing the aircraft's popup (its × button) also deselects it, so the
    // Atmosphere Profile returns to the area profile.  Only when this
    // aircraft is still the selected one — clicking another aircraft closes
    // this popup too, after or before selecting the new one.
    m.on('popupclose', () => { if (selectedIcao === ac.icao) closeDetail(); });
    markers[ac.icao] = m;
  }

  updateTrail(ac.icao, ac.lat, ac.lon, color);
  updateLabel(ac.icao, ac.lat, ac.lon, label);
  drawWindArrow(ac.icao, ac.lat, ac.lon, ac.best_wind_spd, ac.best_wind_dir);
}

// ── Remove stale markers ──────────────────────────────────────────────────
function removeStale(liveIcaos) {
  for (const icao of Object.keys(markers)) {
    if (!liveIcaos.has(icao)) {
      // Removing a marker closes its popup — that must not deselect the
      // aircraft (it is only missing for now, e.g. lost position under jamming)
      markers[icao].off('popupclose');
      markers[icao].remove();       delete markers[icao];
      if (windArrows[icao])  { windArrows[icao].remove();  delete windArrows[icao]; }
      if (trailLayers[icao]) { trailLayers[icao].remove(); delete trailLayers[icao]; }
      if (labelMarkers[icao]){ labelMarkers[icao].remove();delete labelMarkers[icao]; }
      delete trails[icao];
      delete aircraftData[icao];
      // The selected aircraft keeps its profile history and its track, which
      // stays on the map and continues when the aircraft reappears
      if (icao !== selectedIcao) {
        delete windHistory[icao];
        dbSeeded.delete(icao);  // allow re-seed if aircraft reappears
      }
    }
  }
  // Callsign cache: forget aircraft that are no longer live (a page left
  // open for days would otherwise keep every aircraft ever seen)
  for (const icao of Object.keys(callsignCache)) {
    if (!liveIcaos.has(icao)) delete callsignCache[icao];
  }
}

// ── Heading correction text (collector/heading_cal.py) ─────────────────────
// "+1.6 own" — offset and its source: own airframe value, aircraft type,
// fleet median or default; "excluded" for airframes beyond the 5° limit;
// a lower-case source code means learn mode (not applied to the wind).
const HDG_SRC = { A: 'own', T: 'type', F: 'fleet', D: 'default', X: 'excluded' };
function hdgCorrText(ac, unit = '') {
  const hs = ac.hdg_src;
  if (!hs) return null;
  if (hs.toUpperCase() === 'X') return 'excluded';
  if (ac.hdg_off == null) return null;
  return (ac.hdg_off >= 0 ? '+' : '') + ac.hdg_off.toFixed(1) + unit + ' ' +
         (HDG_SRC[hs.toUpperCase()] || hs) + (hs === hs.toLowerCase() ? ' (learn)' : '');
}

// ── Aircraft list panel ───────────────────────────────────────────────────
function renderList(data) {
  const list    = document.getElementById('aircraft-list');
  const visible = meteoOnly
    ? data.filter(d => d.meteo_source && d.meteo_source !== 'NONE')
    : data;
  const byName = (a, b) => (a.callsign || a.registration || a.icao).localeCompare(b.callsign || b.registration || b.icao);
  if (acSort === 'name') {
    visible.sort(byName);
  } else {
    // aircraft without an altitude go to the end in both directions
    const dir = acSort === 'alt_desc' ? -1 : 1;
    visible.sort((a, b) => {
      const ha = a.altitude != null, hb = b.altitude != null;
      if (ha !== hb) return ha ? -1 : 1;
      if (ha && a.altitude !== b.altitude) return dir * (a.altitude - b.altitude);
      return byName(a, b);
    });
  }

  if (visible.length === 0) {
    list.innerHTML = '<div class="ac-placeholder">No aircraft' +
      (meteoOnly ? ' with meteo data' : '') + ' visible.</div>';
    return;
  }

  list.innerHTML = '';
  for (const ac of visible) {
    const div   = document.createElement('div');
    div.className = 'ac-item' + (ac.icao === selectedIcao ? ' selected' : '');
    div.dataset.icao = ac.icao;
    const color = acColor(ac);

    const meteo = [];
    if (ac.best_wind_spd != null)
      meteo.push(`${ac.best_wind_spd.toFixed(0)} kt @ ${ac.best_wind_dir?.toFixed(0)}°`);
    if (ac.best_temp != null)
      meteo.push(`${ac.best_temp.toFixed(1)}°C`);
    const hc = hdgCorrText(ac);
    if (meteo.length && hc) meteo.push(`HDG CORR ${hc}`);
    const meteoLine = meteo.length ? meteo.join(' · ') : 'No meteo';

    div.innerHTML = `
      <div>
        <span class="ac-callsign" style="color:${color}">${esc(ac.callsign || ac.registration || ac.icao)}</span>
        ${ac.registration && ac.callsign ? `<span class="ac-reg">${esc(ac.registration)}</span>` : ''}
        <span class="ac-icao">${ac.callsign || ac.registration ? ac.icao : ''}</span>
      </div>
      <div class="ac-detail">${ac.aircraft_type ? esc(ac.aircraft_type) + ' · ' : ''}${ac.altitude != null ? ac.altitude.toLocaleString() + ' ft' : '–'}
        ${ac.groundspeed != null ? ' · ' + ac.groundspeed + ' kt' : ''}</div>
      <div class="ac-meteo">${meteoLine}</div>
    `;
    div.onclick = () => selectAircraft(ac.icao);
    list.appendChild(div);
  }
}

// ── Select aircraft ────────────────────────────────────────────────────────
function selectAircraft(icao) {
  selectedIcao = icao;
  const ac = aircraftData[icao];
  if (!ac) return;

  for (const [k, m] of Object.entries(markers)) {
    const d = aircraftData[k];
    if (d) m.setIcon(makeIcon(acColor(d), d.track, k === icao));
  }

  document.getElementById('detail-ac-panel').classList.remove('hidden');

  // Header: callsign, then registration · type · ICAO24
  const csSel = callsignCache[ac.icao] || ac.callsign;
  document.getElementById('detail-callsign').textContent = csSel || ac.registration || ac.icao;
  document.getElementById('detail-icao').textContent     =
    [csSel ? ac.registration : null, ac.aircraft_type, ac.icao].filter(Boolean).join(' · ');

  const src   = ac.meteo_source || 'NONE';
  const badge = document.getElementById('detail-bds');
  badge.textContent = src;
  badge.className   = 'badge-source badge-' +
    (src === 'MRAR' ? 'mrar' : src === 'COMPUTED' ? 'comp' : src === 'MHR' ? 'mhr' : 'source');

  const set = (id, val, unit = '') =>
    document.getElementById(id).textContent = val != null ? val + unit : '–';

  set('d-alt',   ac.altitude    != null ? ac.altitude.toLocaleString()    : null, ' ft');
  set('d-gs',    ac.groundspeed, ' kt');
  set('d-track', ac.track       != null ? ac.track.toFixed(0)             : null, '°');
  set('d-vr',    ac.vert_rate,   ' fpm');
  set('d-wsp',   ac.best_wind_spd  != null ? ac.best_wind_spd.toFixed(1)  : null, ' kt');
  set('d-wdir',  ac.best_wind_dir  != null ? ac.best_wind_dir.toFixed(0)  : null, '°');
  set('d-temp',  ac.best_temp      != null ? ac.best_temp.toFixed(1)      : null, '°C');
  set('d-pres',  ac.best_pressure  != null ? ac.best_pressure.toFixed(0)  : null, ' hPa');
  set('d-hum',   ac.mrar_humidity  != null ? ac.mrar_humidity.toFixed(0)  : null, '%');
  const turbMap = ['NIL', 'Light', 'Moderate', 'Severe'];
  set('d-turb',  ac.mrar_turbulence != null ? turbMap[ac.mrar_turbulence] : null);
  // Heading calibration (collector/heading_cal.py); the rarely received MRAR
  // figure of merit takes the cell when present
  if (ac.mrar_fom != null) {
    document.getElementById('d-hdg-label').textContent = 'FOM';
    set('d-hdg', ac.mrar_fom);
  } else {
    document.getElementById('d-hdg-label').textContent = 'Hdg corr';
    set('d-hdg', hdgCorrText(ac, '°'));
  }
  set('d-src',   src);

  // Update mini sounding overlay — includes full wind history for the profile
  miniAcOverlay = {
    alt_ft:      ac.altitude,
    temp_c:      ac.best_temp,
    pressure:    ac.altitude != null ? altToPressHPa(ac.altitude) : null,  // ISA, not QNH
    wind_spd:    ac.best_wind_spd,
    wind_dir:    ac.best_wind_dir,
    color:       acColor(ac),
    windHistory: windHistory[ac.icao] || [],
  };
  drawMiniSounding();

  // ── Pre-seed wind history from DB (once per aircraft per page session) ────
  // Fetch the full flight's stored observations so the Skew-T profile is
  // immediately populated, even on first load or after navigating away.
  // The dbSeeded set prevents re-fetching on every SSE-triggered redraw.
  // The stored track is (re)fetched whenever a different aircraft is selected.
  const needSeed  = !dbSeeded.has(icao);
  const needTrack = selTrackIcao !== icao;
  if (needTrack) { selTrackIcao = icao; selTrackPts = []; }
  appendSelTrack(ac);
  if (needSeed || needTrack) {
    dbSeeded.add(icao);
    fetch(`/api/aircraft/${icao}/wind_history`)
      .then(r => r.json())
      .then(rows => {
        if (needTrack && selTrackIcao === icao) {
          setSelTrackFromDb(rows);
          if (selectedIcao === icao) drawSelectedTrack(icao);
        }
        if (!needSeed || !rows.length) return;

        // Convert DB rows to the same format used by updateWindHistory()
        const dbPoints = rows.map(r => ({
          alt_ft:   r.altitude,
          pressure: altToPressHPa(r.altitude),
          temp_c:   r.best_temp    ?? null,
          wind_spd: r.best_wind_spd ?? null,
          wind_dir: r.best_wind_dir ?? null,
          lat:      r.lat  ?? null,
          lon:      r.lon  ?? null,
        }));

        // Prepend DB history; keep any live points already accumulated
        const livePoints = windHistory[icao] || [];
        windHistory[icao] = [...dbPoints, ...livePoints];

        // Trim to MAX_WIND_HIST cap (keep most recent)
        if (windHistory[icao].length > MAX_WIND_HIST)
          windHistory[icao] = windHistory[icao].slice(-MAX_WIND_HIST);

        // Refresh the overlay if this aircraft is still selected
        if (selectedIcao === icao && miniAcOverlay) {
          miniAcOverlay.windHistory = windHistory[icao];
          drawMiniSounding();
          drawSelectedTrack(icao);
        }
      })
      .catch(() => {});  // silently ignore network errors
  }

  // Draw track from whatever history is already available (DB fetch may still be in-flight)
  drawSelectedTrack(icao);

  // Update info line below canvas
  const info = document.getElementById('mini-ac-info');
  if (info) {
    const cs = getLabelText(ac);
    if (ac.altitude != null && ac.best_temp != null) {
      info.textContent = `${cs}  ·  ${ac.altitude.toLocaleString()} ft  ·  ${ac.best_temp.toFixed(1)}°C`;
      info.style.color = acColor(ac);
    } else if (ac.altitude != null) {
      info.textContent = `${cs}  ·  ${ac.altitude.toLocaleString()} ft  ·  no temp`;
      info.style.color = '#64748b';
    } else {
      info.textContent = `${cs}  ·  no position`;
      info.style.color = '#64748b';
    }
  }

}


// ── Selected aircraft track polyline ──────────────────────────────────────────
// Stored positions of the current flight, replacing the track built so far
// except the live positions newer than the last stored one.
function setSelTrackFromDb(rows) {
  const db = rows.filter(r => r.lat != null && r.lon != null)
                 .map(r => [r.lat, r.lon, r.ts]);
  const lastTs = db.length ? db[db.length - 1][2] : -Infinity;
  selTrackPts = db.concat(selTrackPts.filter(p => p[2] > lastTs));
  if (selTrackPts.length > MAX_TRACK_PTS) selTrackPts = selTrackPts.slice(-MAX_TRACK_PTS);
}

// Live position of the selected aircraft: added when it has moved and at
// most every 5 s (a frozen position, e.g. under GPS jamming, adds nothing).
function appendSelTrack(ac) {
  if (!ac || ac.icao !== selTrackIcao || ac.lat == null || ac.lon == null) return;
  const ts   = ac.last_seen ?? Date.now() / 1000;
  const last = selTrackPts[selTrackPts.length - 1];
  if (last && ((last[0] === ac.lat && last[1] === ac.lon) || ts - last[2] < 5)) return;
  selTrackPts.push([ac.lat, ac.lon, ts]);
  if (selTrackPts.length > MAX_TRACK_PTS) selTrackPts.shift();
}

function drawSelectedTrack(icao) {
  if (!showTrack || !icao || icao !== selTrackIcao || selTrackPts.length < 2) {
    if (selectedTrackLayer) { selectedTrackLayer.remove(); selectedTrackLayer = null; }
    return;
  }
  const points = selTrackPts.map(p => [p[0], p[1]]);
  const ac     = aircraftData[icao];
  if (selectedTrackLayer) {
    selectedTrackLayer.setLatLngs(points);
    if (ac) selectedTrackLayer.setStyle({ color: acColor(ac) });
    return;
  }
  selectedTrackLayer = L.polyline(points, {
    color:     ac ? acColor(ac) : '#94a3b8',
    weight:    2,
    opacity:   0.65,
    dashArray: '5 4',
  }).addTo(map);
}

function closeDetail() {
  if (selectedTrackLayer) { selectedTrackLayer.remove(); selectedTrackLayer = null; }
  // An aircraft deselected while missing from the live data: drop its history
  if (selectedIcao && !aircraftData[selectedIcao]) {
    delete windHistory[selectedIcao];
    dbSeeded.delete(selectedIcao);
  }
  selTrackPts   = [];
  selTrackIcao  = null;
  selectedIcao  = null;
  miniAcOverlay = null;
  drawMiniSounding();
  const info = document.getElementById('mini-ac-info');
  if (info) { info.textContent = 'Click an aircraft to overlay'; info.style.color = ''; }
  document.getElementById('detail-ac-panel').classList.add('hidden');
  for (const [k, m] of Object.entries(markers)) {
    const d = aircraftData[k];
    if (d) m.setIcon(makeIcon(acColor(d), d.track, false));
  }
}

// ── SSE connection ─────────────────────────────────────────────────────────
let evtSource = null;
const statusDot  = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

function connectSSE() {
  if (evtSource) evtSource.close();
  evtSource = new EventSource('/api/live/stream');

  evtSource.onopen = () => {
    statusDot.className   = 'status-dot status-live';
    statusText.textContent = 'Live';
  };

  evtSource.onerror = () => {
    statusDot.className   = 'status-dot status-error';
    statusText.textContent = 'Reconnecting…';
    setTimeout(connectSSE, 5000);
  };

  evtSource.onmessage = (e) => {
    const data     = JSON.parse(e.data);
    const liveIcaos = new Set(data.map(d => d.icao));

    for (const ac of data) {
      if (ac.callsign) callsignCache[ac.icao] = ac.callsign;
      updateWindHistory(ac);       // accumulate vertical wind profile
      aircraftData[ac.icao] = ac;
      upsertMarker(ac);
    }
    removeStale(liveIcaos);
    renderList(data);

    if (selectedIcao && aircraftData[selectedIcao]) {
      selectAircraft(selectedIcao);
    }
  };
}

// ── Filter toggles ─────────────────────────────────────────────────────────

// Restore saved state into the DOM controls before first render
document.getElementById('filter-meteo-only').checked = meteoOnly;
document.getElementById('toggle-labels').checked     = showLabels;
document.getElementById('toggle-track').checked      = showTrack;
document.getElementById('label-mode').value          = labelMode;

// Aircraft list order button: Alt ↑ → Alt ↓ → A–Z
const acSortBtn = document.getElementById('ac-sort-btn');
if (acSortBtn) {
  acSortBtn.textContent = AC_SORTS[acSort];
  acSortBtn.addEventListener('click', () => {
    const keys = Object.keys(AC_SORTS);
    acSort = keys[(keys.indexOf(acSort) + 1) % keys.length];
    localStorage.setItem('ms_acSort', acSort);
    acSortBtn.textContent = AC_SORTS[acSort];
    renderList(Object.values(aircraftData));
  });
}

document.getElementById('filter-meteo-only').addEventListener('change', e => {
  meteoOnly = e.target.checked;
  localStorage.setItem('ms_meteoOnly', meteoOnly);
  renderList(Object.values(aircraftData));
});

document.getElementById('toggle-track').addEventListener('change', e => {
  showTrack = e.target.checked;
  localStorage.setItem('ms_showTrack', showTrack);
  drawSelectedTrack(selectedIcao);   // redraw (or clear) immediately
});

document.getElementById('toggle-labels').addEventListener('change', e => {
  showLabels = e.target.checked;
  localStorage.setItem('ms_showLabels', showLabels);
  if (!showLabels) {
    for (const icao of Object.keys(labelMarkers)) {
      labelMarkers[icao].remove();
      delete labelMarkers[icao];
    }
  } else {
    for (const [icao, ac] of Object.entries(aircraftData)) {
      if (ac.lat && ac.lon) updateLabel(icao, ac.lat, ac.lon, getLabelText(ac));
    }
  }
});

document.getElementById('label-mode').addEventListener('change', e => {
  labelMode = e.target.value;
  localStorage.setItem('ms_labelMode', labelMode);
  if (showLabels) {
    for (const [icao, ac] of Object.entries(aircraftData)) {
      if (ac.lat && ac.lon) updateLabel(icao, ac.lat, ac.lon, getLabelText(ac));
    }
  }
});

// ── Wind density slider ───────────────────────────────────────────────────
const densitySlider = document.getElementById('wind-density');
const densityVal    = document.getElementById('wind-density-val');

if (densitySlider) {
  densitySlider.value  = windDensity;
  densityVal.textContent = windDensity;

  densitySlider.addEventListener('input', e => {
    windDensity = parseInt(e.target.value, 10);
    localStorage.setItem('ms_windDensity', windDensity);
    densityVal.textContent = windDensity;
    drawMiniSounding();   // re-render immediately with new density
  });
}

// ── Skew-T analysis button (panel title): click / mouse wheel steps the level ─
const anaBtn = document.getElementById('skewt-ana-btn');
function setAnaLevel(v, redraw = true) {
  anaLevel = (v + ANA_NAMES.length) % ANA_NAMES.length;
  localStorage.setItem('ms_skewtAna', String(anaLevel));
  if (anaBtn) {
    anaBtn.textContent = 'Analysis: ' + ANA_NAMES[anaLevel];
    anaBtn.classList.toggle('active', anaLevel > 0);
  }
  if (redraw) drawMiniSounding();
}
if (anaBtn) {
  anaBtn.addEventListener('click', () => setAnaLevel(anaLevel + 1));
  anaBtn.addEventListener('wheel', ev => { ev.preventDefault(); setAnaLevel(anaLevel + (ev.deltaY > 0 ? 1 : -1)); },
                          { passive: false });
  setAnaLevel(anaLevel, false);   // the first draw happens later (resize observer)
}

// ── Data-validity indicator tick box (panel title) ────────────────────────
const dqChk = document.getElementById('skewt-dq');
if (dqChk) {
  dqChk.checked = dqShow;
  dqChk.addEventListener('change', e => {
    dqShow = e.target.checked;
    localStorage.setItem('ms_skewtDq', String(dqShow));
    drawMiniSounding();
  });
}

// ── Airport low-level profile selector (Off / Overlay / Zoom) ─────────────
const aptSel = document.getElementById('apt-mode');
if (aptSel) {
  aptSel.value = aptMode;
  aptSel.addEventListener('change', e => {
    aptMode = e.target.value;
    localStorage.setItem('ms_aptMode', aptMode);
    drawMiniSounding();
    fetchMiniLow();
  });
}

// ── Area profile smoothing selector ───────────────────────────────────────
const smoothSel = document.getElementById('area-smooth');
if (smoothSel) {
  smoothSel.value = String(areaSmooth);
  smoothSel.addEventListener('change', e => {
    areaSmooth = parseInt(e.target.value, 10) || 0;
    localStorage.setItem('ms_areaSmooth', String(areaSmooth));
    drawMiniSounding();
  });
}

// ── METAR / TAF fetcher ───────────────────────────────────────────────────
// Surface point for the mini Skew-T from the METAR (parseMetarSfc in
// skewt_chart.js): station pressure (QNH reduced to the airport elevation),
// air temperature and, from 2026-10-11, the dewpoint and lowest cloud group.
// (miniSfc is declared with the other Skew-T state above)

async function fetchWx() {
  try {
    const r = await fetch('/api/wx');
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    miniSfc = parseMetarSfc(d);
    drawMiniSounding();
    const metarEl = document.getElementById('wx-metar');
    const tafEl   = document.getElementById('wx-taf');
    if (metarEl) metarEl.textContent = d.metar || '–';
    if (tafEl)   tafEl.textContent   = d.taf   || '–';
  } catch (e) {
    const metarEl = document.getElementById('wx-metar');
    if (metarEl) metarEl.textContent = '[fetch error]';
  }
}

fetchWx();
setInterval(fetchWx, 10 * 60 * 1000);   // refresh every 10 minutes

// ── Start ──────────────────────────────────────────────────────────────────
connectSSE();

// Size the canvas to the available panel space and keep it responsive.
// ResizeObserver fires on first observe too, so no separate initial call needed.
const _mskWrap = document.querySelector('.mini-sounding-wrap');
if (_mskWrap) {
  new ResizeObserver(() => resizeMiniCanvas()).observe(_mskWrap);
} else {
  drawMiniSounding();   // fallback: draw with default dimensions
}

// Deselect: clicking an empty spot on the map or pressing Esc returns the
// Atmosphere Profile to the area profile (same as the ✕ in the detail panel).
// Marker clicks do not reach the map (Leaflet markers do not bubble clicks).
map.on('click', () => { if (selectedIcao) closeDetail(); });
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape' && selectedIcao) closeDetail();
});

// Area profile behind the mini Skew-T, refreshed every 5 minutes
fetchMiniArea();
setInterval(fetchMiniArea, 5 * 60 * 1000);
(function () {
  const c = document.getElementById('mini-sounding-canvas');
  if (!c) return;
  c.addEventListener('mousemove', miniHover);
  c.addEventListener('mouseleave', () => { syncSkewT(); skewt.leave(); });
})();

// Redraw mini Skew-T and swap map tile when the global page theme changes
window.onThemeChange = function () {
  map.removeLayer(currentTile);
  currentTile = L.tileLayer(
    document.documentElement.dataset.theme === 'light' ? TILE_LIGHT : TILE_DARK,
    TILE_OPTS
  ).addTo(map);
  drawMiniSounding();
};
