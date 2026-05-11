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

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '© OSM, © CARTO',
  subdomains: 'abcd',
  maxZoom: 18,
}).addTo(map);

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

let selectedIcao = null;
let meteoOnly    = false;
let showLabels   = false;
let labelMode    = 'callsign';   // 'callsign' | 'icao'
let detailChart  = null;

const MAX_TRAIL = 20;   // positions kept ≈ 60 s at 3-second SSE interval

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
  // callsign mode: prefer cached callsign (never lost between SSE cycles)
  return callsignCache[ac.icao] || ac.icao;
}

// ── Mini sounding profile ─────────────────────────────────────────────────

let soundingLevels = [];   // cached from /api/sounding
let miniAcOverlay  = null; // {alt_ft, temp_c, color} when aircraft selected

// Client-side ISA helpers
function pressToAltFt(p) {
  if (p >= 226.32)
    return ((288.15 / 0.0065) * (1 - Math.pow(p / 1013.25, 1 / 5.2561))) * 3.28084;
  return (11000 - Math.log(p / 226.32) / 0.0001577) * 3.28084;
}
function isaTemp(alt_ft) {
  const m = alt_ft * 0.3048;
  return m <= 11000 ? 15 - 0.0065 * m : -56.5;
}

// Canvas geometry constants
const MS = {
  W: 204, H: 330,
  ML: 32, MR: 6, MT: 12, MB: 20,
  TMIN: -75, TMAX: 30,   // °C range
  AMAX: 42000,            // ft
};
MS.PW = MS.W - MS.ML - MS.MR;
MS.PH = MS.H - MS.MT - MS.MB;

const msY = alt  => MS.MT + MS.PH * (1 - Math.max(0, Math.min(alt, MS.AMAX)) / MS.AMAX);
const msX = temp => MS.ML + MS.PW * (temp - MS.TMIN) / (MS.TMAX - MS.TMIN);

async function fetchMiniSounding() {
  try {
    const r = await fetch('/api/sounding');
    const d = await r.json();
    soundingLevels = d.levels || [];
    const meta = document.getElementById('mini-sounding-meta');
    if (meta) meta.textContent =
      `${d.obs_used ?? 0} obs · last ${(d.generated_at || '').substr(11, 5)} UTC`;
    drawMiniSounding();
  } catch (_) {
    const meta = document.getElementById('mini-sounding-meta');
    if (meta) meta.textContent = 'Sounding unavailable';
  }
}

function drawMiniSounding() {
  const canvas = document.getElementById('mini-sounding-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const { W, H, ML, MR, MT, MB, PW, PH, TMIN, TMAX, AMAX } = MS;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0f1923';
  ctx.fillRect(0, 0, W, H);

  // Altitude grid lines + labels
  ctx.font = '9px system-ui, sans-serif';
  ctx.textAlign = 'right';
  for (const alt of [0, 5000, 10000, 15000, 20000, 25000, 30000, 35000, 40000]) {
    const y = msY(alt);
    ctx.strokeStyle = '#1e2a3a'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(ML + PW, y); ctx.stroke();
    ctx.fillStyle = '#4b5563';
    ctx.fillText(alt === 0 ? '0' : (alt / 1000) + 'k', ML - 3, y + 3);
  }

  // Temperature grid lines + labels
  ctx.textAlign = 'center';
  for (const t of [-60, -40, -20, 0, 20]) {
    const x = msX(t);
    ctx.strokeStyle = t === 0 ? '#2d3f52' : '#1a2535';
    ctx.lineWidth   = t === 0 ? 1.5 : 1;
    ctx.beginPath(); ctx.moveTo(x, MT); ctx.lineTo(x, MT + PH); ctx.stroke();
    ctx.fillStyle = '#4b5563';
    ctx.fillText(t + '°', x, MT + PH + 14);
  }

  // Axes border
  ctx.strokeStyle = '#2d3f52'; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ML, MT); ctx.lineTo(ML, MT + PH); ctx.lineTo(ML + PW, MT + PH);
  ctx.stroke();

  // ISA standard atmosphere reference (dashed blue)
  const isaAlts = [0, 3000, 6000, 9000, 11000, 15000, 20000, 25000, 30000, 36000, 40000];
  ctx.strokeStyle = '#1e3a5f'; ctx.lineWidth = 1.2;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  let first = true;
  for (const a of isaAlts) {
    const x = msX(isaTemp(a)), y = msY(a);
    if (x >= ML - 2 && x <= ML + PW + 2) {
      first ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      first = false;
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Build temperature profile points
  const pts = soundingLevels
    .map(l => ({
      alt:  l.altitude != null ? l.altitude : pressToAltFt(l.pressure),
      temp: l.temp,
    }))
    .filter(p => p.temp != null && p.alt >= 0 && p.alt <= AMAX)
    .sort((a, b) => a.alt - b.alt);

  if (pts.length >= 2) {
    // Shaded fill between actual and ISA
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = msX(p.temp), y = msY(p.alt);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    for (let i = pts.length - 1; i >= 0; i--)
      ctx.lineTo(msX(isaTemp(pts[i].alt)), msY(pts[i].alt));
    ctx.closePath();
    ctx.fillStyle = 'rgba(239,68,68,0.08)';
    ctx.fill();

    // Temperature line
    ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath();
    pts.forEach((p, i) => {
      i === 0 ? ctx.moveTo(msX(p.temp), msY(p.alt))
              : ctx.lineTo(msX(p.temp), msY(p.alt));
    });
    ctx.stroke();

    // Dots at measured levels
    ctx.fillStyle = '#ef4444';
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(msX(p.temp), msY(p.alt), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    ctx.fillStyle = '#374151'; ctx.font = '11px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('No data yet', ML + PW / 2, MT + PH / 2 - 8);
    ctx.fillText('Collecting…', ML + PW / 2, MT + PH / 2 + 8);
  }

  // ISA label (bottom right)
  ctx.fillStyle = '#1e3a5f'; ctx.font = '9px system-ui'; ctx.textAlign = 'left';
  ctx.fillText('ISA', msX(isaTemp(0)) + 3, MT + PH - 4);

  // Aircraft overlay
  if (miniAcOverlay) {
    const { alt_ft, temp_c, color } = miniAcOverlay;
    if (temp_c != null && alt_ft != null && alt_ft <= AMAX) {
      const x = msX(temp_c), y = msY(alt_ft);

      // Dashed guide lines to axes
      ctx.strokeStyle = color + '99'; ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(ML, y); ctx.lineTo(x, y);       // → temp axis
      ctx.moveTo(x, y); ctx.lineTo(x, MT + PH);  // ↓ alt axis
      ctx.stroke();
      ctx.setLineDash([]);

      // White ring + coloured fill
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
    }
  }
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

  let popup = `<b>${label}</b>  <span style="color:${color}">${ac.meteo_source || 'NONE'}</span><br>`;
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
      markers[icao].remove();       delete markers[icao];
      if (windArrows[icao])  { windArrows[icao].remove();  delete windArrows[icao]; }
      if (trailLayers[icao]) { trailLayers[icao].remove(); delete trailLayers[icao]; }
      if (labelMarkers[icao]){ labelMarkers[icao].remove();delete labelMarkers[icao]; }
      delete trails[icao];
      delete aircraftData[icao];
    }
  }
}

// ── Aircraft list panel ───────────────────────────────────────────────────
function renderList(data) {
  const list    = document.getElementById('aircraft-list');
  const visible = meteoOnly
    ? data.filter(d => d.meteo_source && d.meteo_source !== 'NONE')
    : data;
  visible.sort((a, b) => (a.callsign || a.icao).localeCompare(b.callsign || b.icao));

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

    let meteoLine = '';
    if (ac.best_wind_spd != null)
      meteoLine += `💨 ${ac.best_wind_spd.toFixed(0)} kt @ ${ac.best_wind_dir?.toFixed(0)}° `;
    if (ac.best_temp != null)
      meteoLine += `🌡 ${ac.best_temp.toFixed(1)}°C`;
    if (!meteoLine) meteoLine = 'No meteo';

    div.innerHTML = `
      <div>
        <span class="ac-callsign" style="color:${color}">${ac.callsign || ac.icao}</span>
        <span class="ac-icao">${ac.callsign ? ac.icao : ''}</span>
      </div>
      <div class="ac-detail">${ac.altitude != null ? ac.altitude.toLocaleString() + ' ft' : '–'}
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

  const strip = document.getElementById('detail-strip');
  strip.classList.remove('hidden');

  document.getElementById('detail-callsign').textContent = ac.callsign || ac.icao;
  document.getElementById('detail-icao').textContent     = ac.callsign ? ac.icao : '';

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
  set('d-vr',    ac.vert_rate,   ' ft/min');
  set('d-wsp',   ac.best_wind_spd  != null ? ac.best_wind_spd.toFixed(1)  : null, ' kt');
  set('d-wdir',  ac.best_wind_dir  != null ? ac.best_wind_dir.toFixed(0)  : null, '°');
  set('d-temp',  ac.best_temp      != null ? ac.best_temp.toFixed(1)      : null, '°C');
  set('d-pres',  ac.best_pressure  != null ? ac.best_pressure.toFixed(0)  : null, ' hPa');
  set('d-hum',   ac.mrar_humidity  != null ? ac.mrar_humidity.toFixed(0)  : null, '%');
  const turbMap = ['NIL', 'Light', 'Moderate', 'Severe'];
  set('d-turb',  ac.mrar_turbulence != null ? turbMap[ac.mrar_turbulence] : null);
  set('d-fom',   ac.mrar_fom);
  set('d-src',   src);

  // Update mini sounding overlay
  miniAcOverlay = {
    alt_ft: ac.altitude,
    temp_c: ac.best_temp,
    color:  acColor(ac),
  };
  drawMiniSounding();

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

  loadDetailChart(icao);
}

async function loadDetailChart(icao) {
  try {
    const r   = await fetch(`/api/live/aircraft/${icao}`);
    const obs = await r.json();
    const times = obs.map(o => new Date(o.ts * 1000).toISOString().substr(11, 5));
    const alts  = obs.map(o => o.altitude);
    const temps = obs.map(o => o.best_temp);

    const ctx = document.getElementById('detail-chart').getContext('2d');
    if (detailChart) detailChart.destroy();
    detailChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: times,
        datasets: [
          { label: 'Alt (÷100 ft)', data: alts.map(v => v ? v / 100 : null),
            borderColor: '#3b82f6', tension: 0.3, pointRadius: 0, borderWidth: 1.5 },
          { label: 'Temp (°C×10)', data: temps.map(v => v ? v * 10 : null),
            borderColor: '#ef4444', tension: 0.3, pointRadius: 0, borderWidth: 1.5 },
        ],
      },
      options: {
        animation: false,
        plugins: { legend: { display: true, labels: { color: '#94a3b8', boxWidth: 12 } } },
        scales: {
          x: { ticks: { maxTicksLimit: 5, color: '#64748b' }, grid: { color: '#1e2a3a' } },
          y: { ticks: { color: '#64748b' }, grid: { color: '#1e2a3a' } },
        },
      },
    });
  } catch (e) {}
}

function closeDetail() {
  selectedIcao  = null;
  miniAcOverlay = null;
  drawMiniSounding();
  const info = document.getElementById('mini-ac-info');
  if (info) { info.textContent = 'Click an aircraft to overlay'; info.style.color = ''; }
  document.getElementById('detail-strip').classList.add('hidden');
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
      // Update callsign cache — only upgrade, never downgrade to null
      if (ac.callsign) callsignCache[ac.icao] = ac.callsign;
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
document.getElementById('filter-meteo-only').addEventListener('change', e => {
  meteoOnly = e.target.checked;
  renderList(Object.values(aircraftData));
});

document.getElementById('toggle-labels').addEventListener('change', e => {
  showLabels = e.target.checked;
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
  // Refresh all visible labels with new text
  if (showLabels) {
    for (const [icao, ac] of Object.entries(aircraftData)) {
      if (ac.lat && ac.lon) updateLabel(icao, ac.lat, ac.lon, getLabelText(ac));
    }
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
connectSSE();
fetchMiniSounding();
setInterval(fetchMiniSounding, 120_000);   // refresh sounding every 2 minutes
