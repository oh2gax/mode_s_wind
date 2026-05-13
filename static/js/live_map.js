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
const windHistory    = {};   // icao → [{pressure, alt_ft, temp_c, wind_spd, wind_dir}, ...]
const dbSeeded       = new Set(); // ICAOs whose wind history has been pre-loaded from DB

let selectedIcao = null;
let detailChart  = null;

const MAX_TRAIL       = 20;   // position dots kept ≈ 60 s
const MAX_WIND_HIST   = 80;   // wind obs per aircraft (≈ climb/descent profile)

// Restore persisted UI prefs — default both toggles ON
// localStorage.getItem returns null when key is absent; null !== 'false' → true (default ON)
let meteoOnly   = localStorage.getItem('ms_meteoOnly')  !== 'false';
let showLabels  = localStorage.getItem('ms_showLabels') !== 'false';
let labelMode   = localStorage.getItem('ms_labelMode')  || 'callsign';
let windDensity = parseInt(localStorage.getItem('ms_windDensity') || '2', 10);

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
  return callsignCache[ac.icao] || ac.icao;
}

// ── Wind profile history (per aircraft) ───────────────────────────────────
// Accumulates wind observations as an aircraft climbs or descends so the
// mini Skew-T can show a full vertical wind profile, not just one barb.
function updateWindHistory(ac) {
  if (!ac.best_wind_spd || !ac.best_wind_dir || !ac.altitude) return;

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

let miniAcOverlay  = null; // {alt_ft, temp_c, color} when aircraft selected

// ── ISA helpers ───────────────────────────────────────────────────────────
function altToPressHPa(alt_ft) {
  const m = alt_ft * 0.3048;
  if (m <= 11000) return 1013.25 * Math.pow(1 - 0.0065 * m / 288.15, 5.2561);
  return 226.32 * Math.exp(-0.0001577 * (m - 11000));
}
function isaTempP(p_hPa) {
  // ISA temperature (°C) at a given pressure (hPa)
  if (p_hPa >= 226.32) return 288.15 * Math.pow(p_hPa / 1013.25, 0.19026) - 273.15;
  return -56.5;
}

// ── Mini Skew-T geometry ──────────────────────────────────────────────────
// Canvas: 252 × 346 px.  Log-pressure Y, skewed temperature X.
const MSK = {
  W: 362, H: 346,
  ML: 28, MR: 90, MT: 10, MB: 22,
  TL: -80, TR: 30,   // temperature range °C
  PT: 200, PB: 1050, // pressure range hPa
  SK: 0.38,          // skew factor (higher = more tilt)
};
MSK.PW = MSK.W - MSK.ML - MSK.MR;   // 244
MSK.PH = MSK.H - MSK.MT - MSK.MB;   // 314

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
    if (child !== canvas) fixedH += child.offsetHeight + 4; // 4 = flex gap
  }
  fixedH += 8; // wrap top + bottom padding (4px each)

  const w = Math.max(160, wrap.clientWidth  - 8);
  const h = Math.max(160, wrap.clientHeight - fixedH);

  if (canvas.width === w && canvas.height === h) return; // nothing changed

  canvas.width  = w;
  canvas.height = h;
  MSK.W  = w;
  MSK.H  = h;
  MSK.PW = w - MSK.ML - MSK.MR;
  MSK.PH = h - MSK.MT - MSK.MB;
  drawMiniSounding();
}

function mskY(p) {
  const lt = Math.log(MSK.PT), lb = Math.log(MSK.PB);
  return MSK.MT + MSK.PH * (Math.log(p) - lt) / (lb - lt);
}
function mskX(t, p) {
  const base = MSK.ML + MSK.PW * (t - MSK.TL) / (MSK.TR - MSK.TL);
  const skew = MSK.PH * (Math.log(MSK.PB) - Math.log(p)) /
                        (Math.log(MSK.PB) - Math.log(MSK.PT));
  return base + skew * MSK.SK;
}

// ── Mini wind barb (scaled for small canvas) ──────────────────────────────
// color defaults to grey for area sounding barbs; pass aircraft colour for overlays.
function drawMiniBarb(ctx, x, y, speedKt, dirFrom, color = '#94a3b8') {
  if (speedKt == null || dirFrom == null) return;
  const spd   = Math.round(speedKt / 5) * 5;
  const angle = dirFrom * Math.PI / 180;  // staff points FROM wind direction (met convention)
  const sLen  = 14;
  const ex    = x + sLen * Math.sin(angle);
  const ey    = y - sLen * Math.cos(angle);

  ctx.strokeStyle = color; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();

  let rem = spd, pos = 0;
  const step = 3;

  while (rem >= 50) {
    const sx = ex - pos * Math.sin(angle), sy = ey + pos * Math.cos(angle);
    const tx = sx + 7 * Math.cos(angle),  ty = sy + 7 * Math.sin(angle);
    const mx = sx + step * Math.sin(angle), my = sy - step * Math.cos(angle);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(tx, ty); ctx.lineTo(mx, my);
    ctx.closePath(); ctx.fill();
    pos += step + 1; rem -= 50;
  }
  while (rem >= 10) {
    const sx = ex - pos * Math.sin(angle), sy = ey + pos * Math.cos(angle);
    const px = sx + 7 * Math.cos(angle),  py = sy + 7 * Math.sin(angle);
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(px, py); ctx.stroke();
    pos += step; rem -= 10;
  }
  if (rem >= 5) {
    const sx = ex - pos * Math.sin(angle), sy = ey + pos * Math.cos(angle);
    const px = sx + 4 * Math.cos(angle),  py = sy + 4 * Math.sin(angle);
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(px, py); ctx.stroke();
  }
}


function drawMiniSounding() {
  const canvas = document.getElementById('mini-sounding-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const { W, H, ML, MR, MT, MB, PW, PH, TL, TR, PT, PB } = MSK;
  const barbX = ML + PW + 6;   // X start of wind barb column

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0c1620';
  ctx.fillRect(0, 0, W, H);

  // ── Clip to plot + barb area for grid ──────────────────────────────────
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, MT, W, PH);
  ctx.clip();

  // Isobars (horizontal lines + pressure labels)
  const isobars = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200];
  ctx.font = '8px monospace'; ctx.textAlign = 'right';
  for (const p of isobars) {
    if (p < PT || p > PB) continue;
    const y = mskY(p);
    ctx.strokeStyle = p % 100 === 0 ? '#1e2a3a' : '#172030';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(ML + PW, y); ctx.stroke();
    ctx.fillStyle = '#4b5563';
    ctx.fillText(p, ML - 3, y + 3);
  }

  // Isotherms (skewed temperature lines)
  for (const t of [-70, -60, -50, -40, -30, -20, -10, 0, 10, 20]) {
    const x1 = mskX(t, PB), y1 = mskY(PB);
    const x2 = mskX(t, PT), y2 = mskY(PT);
    ctx.strokeStyle = t === 0 ? '#1e3a5f' : '#182030';
    ctx.lineWidth   = t === 0 ? 1.2 : 0.7;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    // Temperature label at bottom of plot
    if (x1 >= ML && x1 <= ML + PW) {
      ctx.fillStyle = '#374151'; ctx.font = '8px monospace'; ctx.textAlign = 'center';
      ctx.fillText(t + '°', x1, MT + PH + 14);
    }
  }

  ctx.restore();

  // Y axis line
  ctx.strokeStyle = '#2d3f52'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(ML, MT); ctx.lineTo(ML, MT + PH); ctx.stroke();

  // ── ISA reference (dashed blue) ─────────────────────────────────────────
  const isaPs = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200];
  ctx.strokeStyle = '#1e3a5f'; ctx.lineWidth = 1.2;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  let isaFirst = true;
  for (const p of isaPs) {
    if (p < PT || p > PB) continue;
    const t = isaTempP(p);
    const x = mskX(t, p), y = mskY(p);
    if (x >= ML && x <= ML + PW) {
      isaFirst ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      isaFirst = false;
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // ── No aircraft selected hint ───────────────────────────────────────────
  if (!miniAcOverlay) {
    ctx.fillStyle = '#374151'; ctx.font = '10px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('Click an aircraft', ML + PW / 2, MT + PH / 2 - 6);
    ctx.fillText('to show profile',   ML + PW / 2, MT + PH / 2 + 8);
  }

  // ── Aircraft overlay ────────────────────────────────────────────────────
  if (miniAcOverlay) {
    const { temp_c, pressure, alt_ft, color, windHistory: wh } = miniAcOverlay;

    // ── Wind + temperature history (density-filtered vertical profile) ──
    if (wh && wh.length > 0) {
      // Build density-filtered index list: include a point only when altitude
      // has changed by at least windDensity × 400 ft since the last included.
      const minGapFt = windDensity * 400;
      const shownIdx = [];
      let lastShownAlt = null;
      for (let i = 0; i < wh.length; i++) {
        if (lastShownAlt === null || Math.abs(wh[i].alt_ft - lastShownAlt) >= minGapFt) {
          shownIdx.push(i);
          lastShownAlt = wh[i].alt_ft;
        }
      }
      // Always include the most recent observation regardless of gap
      if (shownIdx[shownIdx.length - 1] !== wh.length - 1) shownIdx.push(wh.length - 1);

      for (const idx of shownIdx) {
        const obs = wh[idx];
        if (obs.pressure < PT || obs.pressure > PB) continue;
        const oy        = mskY(obs.pressure);
        const isCurrent = (idx === wh.length - 1);
        const barbColor = isCurrent ? color : color + '66';

        // Temperature dot on the skewed T axis
        if (obs.temp_c != null) {
          const ox = mskX(obs.temp_c, obs.pressure);
          ctx.fillStyle = barbColor;
          ctx.beginPath();
          ctx.arc(ox, oy, isCurrent ? 3 : 2, 0, Math.PI * 2);
          ctx.fill();
        }

        // Wind barb in aircraft colour + speed label
        if (obs.wind_spd != null && obs.wind_dir != null) {
          drawMiniBarb(ctx, barbX + 2, oy, obs.wind_spd, obs.wind_dir, barbColor);
          ctx.fillStyle = barbColor;
          ctx.font      = '9px monospace'; ctx.textAlign = 'right';
          ctx.fillText(Math.round(obs.wind_dir) + '° ' + Math.round(obs.wind_spd) + 'kt', W - 2, oy + 3);
        }
      }
    }

    // ── Current altitude/pressure level indicator ───────────────────────
    // Always show a dashed horizontal line at the aircraft's current level,
    // even when temperature data is not available.
    const p = (pressure != null) ? pressure
            : (alt_ft  != null) ? altToPressHPa(alt_ft)
            : null;

    if (p != null && p >= PT && p <= PB) {
      const y = mskY(p);

      // Full-width dashed line spanning plot + barb area
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(W - 2, y); ctx.stroke();
      ctx.setLineDash([]);

      // Circle on temperature profile (only if temp available)
      if (temp_c != null) {
        const x = mskX(temp_c, p);
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
      } else {
        // No temp: draw a small diamond on the pressure axis instead
        const dx = ML + 5, dy = y;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(dx, dy - 5); ctx.lineTo(dx + 4, dy);
        ctx.lineTo(dx, dy + 5); ctx.lineTo(dx - 4, dy);
        ctx.closePath(); ctx.fill();
      }
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
      delete windHistory[icao];
      delete aircraftData[icao];
      dbSeeded.delete(icao);  // allow re-seed if aircraft reappears
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
  if (!dbSeeded.has(icao)) {
    dbSeeded.add(icao);
    fetch(`/api/aircraft/${icao}/wind_history`)
      .then(r => r.json())
      .then(rows => {
        if (!rows.length) return;

        // Convert DB rows to the same format used by updateWindHistory()
        const dbPoints = rows.map(r => ({
          alt_ft:   r.altitude,
          pressure: altToPressHPa(r.altitude),
          temp_c:   r.best_temp    ?? null,
          wind_spd: r.best_wind_spd ?? null,
          wind_dir: r.best_wind_dir ?? null,
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
        }
      })
      .catch(() => {});  // silently ignore network errors
  }

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
document.getElementById('label-mode').value          = labelMode;

document.getElementById('filter-meteo-only').addEventListener('change', e => {
  meteoOnly = e.target.checked;
  localStorage.setItem('ms_meteoOnly', meteoOnly);
  renderList(Object.values(aircraftData));
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
