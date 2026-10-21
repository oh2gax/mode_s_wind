/**
 * windmap.js — Gridded wind / temperature map from MODE-S meteo observations.
 *
 * Fetches /api/windmap (web/api/windmap.py) for a chosen flight level,
 * altitude tolerance, period and cell size, then renders standard
 * meteorological wind barbs on a Leaflet map, one per square grid cell.
 * The server averages each aircraft first, then the aircraft of a cell, and
 * removes frozen / impossible (spoofed) positions.
 *
 * Wind barb convention:
 *   Staff points FROM the direction the wind is coming from.
 *   Pennant  = 50 kt,  full barb = 10 kt,  half barb = 5 kt.
 *
 * Colour = averaged cell wind speed (< 15 / 15–30 / 30–50 / > 50 kt);
 * opacity = number of different aircraft in the cell (1 faint, 2, 3+ full).
 * Layers: ΔT (cells by temperature minus the layer mean); isotachs and
 * streamlines from a smoothed field (windmap_analysis.js, only near data);
 * height contours of the pressure surface from the aircraft GNSS − baro
 * difference with the geostrophic wind of the area (experimental, see
 * collector/gnss_heights.py);
 * the jet-stream symbol of aviation SIGWX charts (axis line with arrowhead,
 * barb flags at the maximum, change bars, optional vertical depth);
 * the Jokioinen radiosonde at the level; Compare = change since the previous
 * period or the thermal wind to another level (purple arrows, cells tinted by
 * warming / cooling or by veering / backing).  A time slider steps the period
 * back hour by hour (▶ animates the last 24 h).
 * The map style follows the page's Light / Dark theme.
 */

// ── Map initialisation ────────────────────────────────────────────────────
const map = L.map('wm-map', { zoomControl: true })
             .setView([RECEIVER_LAT, RECEIVER_LON], 7);

// CARTO_API_KEY is injected server-side in base.html (from local api_keys.py);
// appended as a query param so raster tiles are served without the watermark.
const _cartoKeyQs = CARTO_API_KEY ? `?key=${encodeURIComponent(CARTO_API_KEY)}` : '';
const TILES = {
  dark:  L.tileLayer(`https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png${_cartoKeyQs}`,
                     { attribution: '© OSM, © CARTO', subdomains: 'abcd', maxZoom: 18 }),
  light: L.tileLayer(`https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png${_cartoKeyQs}`,
                     { attribution: '© OSM, © CARTO', subdomains: 'abcd', maxZoom: 18 }),
};
const pageIsLight = () => document.documentElement.dataset.theme === 'light';
let tileTheme = pageIsLight() ? 'light' : 'dark';
TILES[tileTheme].addTo(map);

L.circleMarker([RECEIVER_LAT, RECEIVER_LON], {
  radius: 6, color: '#fff', fillColor: '#1d4ed8',
  fillOpacity: 1, weight: 2,
}).bindTooltip('Receiver').addTo(map);

// Layers, bottom to top: cell tints, analysis lines, compare arrows + barbs, sonde
const cellLayer  = L.layerGroup().addTo(map);
const anaLayer   = L.layerGroup().addTo(map);
const cmpLayer   = L.layerGroup().addTo(map);
const barbLayer  = L.layerGroup().addTo(map);
const sondeLayer = L.layerGroup().addTo(map);
let lastData  = null;         // last API answer, redrawn on theme / filter changes
let lastCmp   = null;         // {mode, data} of the comparison
let lastSonde = null;         // /api/sonde answer
let lastDepth = null;         // [{fl, data}] other levels for the jet depth
const DEPTH_FLS = [250, 290, 330, 370, 410];

// Jokioinen (used when a sounding has no position)
const SONDE_SITE = [60.814, 23.498];

// ── Colours ───────────────────────────────────────────────────────────────
// Dark map: bright hues; light map: darker shades of the same hues
const SPEED_COLORS = {
  dark:  ['#6ee7b7', '#3b82f6', '#f59e0b', '#ef4444'],
  light: ['#047857', '#1d4ed8', '#b45309', '#b91c1c'],
};
function barbColor(speedKt) {
  const pal = SPEED_COLORS[pageIsLight() ? 'light' : 'dark'];
  if (speedKt < 15) return pal[0];
  if (speedKt < 30) return pal[1];
  if (speedKt < 50) return pal[2];
  return pal[3];
}
const cmpColor   = () => pageIsLight() ? '#7c3aed' : '#c084fc';   // compare arrows
const sondeColor = () => pageIsLight() ? '#be185d' : '#f472b6';   // as on the Skew-T
const lineColor  = () => pageIsLight() ? '#334155' : '#cbd5e1';   // streamlines
const isoColor   = () => pageIsLight() ? '#a16207' : '#facc15';   // isotachs
const haloColor  = () => pageIsLight() ? '#f1f5f9' : '#0f1923';
const jetColor   = () => pageIsLight() ? '#111827' : '#f8fafc';   // jet-stream symbol
const hgtColor   = () => pageIsLight() ? '#0f766e' : '#5eead4';   // height contours, geostrophic wind

// Barb opacity by the number of different aircraft behind the cell
const acOpacity = ac => ac >= 3 ? 1.0 : ac === 2 ? 0.7 : 0.42;

// Blue … red cell tint, full at ±full (ΔT, warming / cooling, backing / veering)
function tint(value, full, ac) {
  if (value == null || Number.isNaN(value)) return null;
  const k = Math.min(1, Math.abs(value) / full);
  const base = (ac >= 3 ? 0.55 : ac === 2 ? 0.4 : 0.25) * (pageIsLight() ? 1 : 1.25);
  const col = value < 0 ? (pageIsLight() ? '#2563eb' : '#3b82f6')
                        : (pageIsLight() ? '#dc2626' : '#ef4444');
  return { color: col, opacity: base * k };
}
const DT_FULL_K = 3;

// ── SVG wind barb icon ────────────────────────────────────────────────────
// Draws a standard meteorological barb, rotated so the staff points FROM
// the direction the wind comes from.  A two-line label (when the cells are
// wide enough on screen) shows dir° speed, and the temperature at the level
// with the number of aircraft — or the given label lines.
function makeBarbIcon(cell, showLabel, opts = {}) {
  const speedKt = cell.wind_spd, dirFrom = cell.wind_dir;
  const color  = opts.color || barbColor(speedKt);
  const spd    = Math.round(speedKt / 5) * 5;  // round to 5 kt for barb symbols
  const op     = opts.opacity != null ? opts.opacity : acOpacity(cell.ac);

  // Canvas size and pivot (cell centre sits at cx, cy)
  const S  = 88, W = opts.width || 96;
  const cx = W / 2, cy = 44;
  const staffLen = 26;
  const tx = cx, ty = cy - staffLen;   // staff tip, unrotated (FROM north)
  const sw = opts.strokeWidth || 1.5;

  let g = '';
  if (spd === 0) {
    g = `<circle cx="${cx}" cy="${cy}" r="6" stroke="${color}" stroke-width="${sw}" fill="none"/>`;
  } else {
    g += `<line x1="${cx}" y1="${cy}" x2="${tx}" y2="${ty}"
               stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>`;
    let rem = spd, pos = 0;
    const step = 5, barbLen = 11;
    while (rem >= 50) {                                   // pennants (50 kt)
      const y1 = ty + pos, y2 = ty + pos + step;
      g += `<polygon points="${tx},${y1} ${tx + barbLen},${y1 + step * 0.5} ${tx},${y2}" fill="${color}"/>`;
      pos += step + 1.5; rem -= 50;
    }
    while (rem >= 10) {                                   // full barbs (10 kt)
      const y = ty + pos;
      g += `<line x1="${tx}" y1="${y}" x2="${tx + barbLen}" y2="${y - 3}"
                  stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>`;
      pos += step; rem -= 10;
    }
    if (rem >= 5) {                                       // half barb (5 kt)
      const y = ty + pos;
      g += `<line x1="${tx}" y1="${y}" x2="${tx + barbLen * 0.5}" y2="${y - 1.5}"
                  stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>`;
    }
  }
  const dot = opts.square
    ? `<rect x="${cx - 3.5}" y="${cy - 3.5}" width="7" height="7" fill="${color}"/>`
    : `<circle cx="${cx}" cy="${cy}" r="2.5" fill="${color}"/>`;

  let labelEl = '';
  if (showLabel) {
    // halo in the map's background colour keeps the text readable over tinted cells
    const halo = haloColor();
    const lines = opts.lines || [
      `${Math.round(dirFrom)}° ${Math.round(speedKt)}kt`,
      (cell.temp != null ? `${fmtT(cell.temp)}° ` : '') + `${cell.ac}ac`,
    ];
    const t = (y, txt) => `<text x="${cx}" y="${y}" text-anchor="middle" fill="${color}"
        stroke="${halo}" stroke-width="2.5" paint-order="stroke" stroke-opacity="0.85"
        font-size="9" font-family="'Courier New',monospace">${txt}</text>`;
    // on the side away from the staff (it points towards the wind direction)
    const staffDown = dirFrom > 90 && dirFrom < 270;
    const y1 = staffDown ? cy - 12 - 10 * lines.length : cy + 22;
    labelEl = `<g opacity="${Math.max(0.75, op)}">${lines.map((l, n) => t(y1 + 10 * n, l)).join('')}</g>`;
  }

  const totalH = S + 4;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${totalH}"
                    viewBox="0 0 ${W} ${totalH}" style="overflow:visible">
    <g opacity="${op}"><g transform="rotate(${dirFrom},${cx},${cy})">${g}</g>${dot}</g>
    ${labelEl}
  </svg>`;
  return L.divIcon({ html: svg, className: '', iconSize: [W, totalH], iconAnchor: [cx, cy] });
}

// Arrow pointing TOWARDS the direction of a vector (bearing °), length by size (kt)
function makeArrowIcon(bearing, kt, label, showLabel, color = cmpColor(), dash = '', shiftPx = 0) {
  const len = Math.max(10, Math.min(40, 8 + 0.8 * kt));
  const W = 96, H = 96, cx = 48, cy = 48;
  const tipY = cy - len;
  const arrow = `<g transform="rotate(${bearing},${cx},${cy})">
      <line x1="${cx}" y1="${cy}" x2="${cx}" y2="${tipY + 2}" stroke="${color}" stroke-width="2.2" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>
      <polygon points="${cx},${tipY - 3} ${cx - 4.5},${tipY + 6} ${cx + 4.5},${tipY + 6}" fill="${color}"/>
    </g>`;
  let lab = '';
  if (showLabel && label) {
    // just beyond the arrow tip (the barb's staff lies on the other side)
    const r = bearing * Math.PI / 180, dl = len + 12;
    const lx = cx + dl * Math.sin(r), ly = cy - dl * Math.cos(r) + 3;
    lab = `<text x="${lx}" y="${ly}" text-anchor="middle" fill="${color}" stroke="${haloColor()}"
        stroke-width="2.5" paint-order="stroke" font-size="9" font-weight="bold"
        font-family="'Courier New',monospace">${label}</text>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"
      style="overflow:visible">${arrow}${lab}</svg>`;
  return L.divIcon({ html: svg, className: '', iconSize: [W, H], iconAnchor: [cx - shiftPx, cy] });
}

const fmtT = t => (t < 0 ? '−' : '') + Math.abs(t).toFixed(1);
const fmtSigned = (v, d = 1) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(d);
const flLabel = fl => fl < 50 ? `${(fl * 100).toLocaleString()} ft` : `FL${String(fl).padStart(3, '0')}`;
const pad2 = n => String(n).padStart(2, '0');
const utcStr = ts => { const d = new Date(ts * 1000);
  return `${d.getUTCDate()}.${d.getUTCMonth() + 1}. ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`; };
const bearingOf = (u, v) => ((Math.atan2(u, v) * 180 / Math.PI) + 360) % 360;   // towards
const angDiff = (a, b) => ((a - b + 540) % 360) - 180;                           // a − b in −180…180

// ISA pressure (hPa) of a pressure altitude (ft) — the Mode S scale
function isaP(ft) {
  if (ft <= 36089) return 1013.25 * Math.pow(1 - 6.8756e-6 * ft, 5.2559);
  return 226.32 * Math.exp(-(ft - 36089) / 20806);
}

// ── Settings (remembered in the browser) ──────────────────────────────────
const SETTINGS_KEY = 'ms_windmap';
const CTRL_IDS = ['wm-fl', 'wm-tol', 'wm-period', 'wm-cell', 'wm-minac', 'wm-cmp', 'wm-fl2', 'wm-jetkt'];
const CHECK_IDS = ['wm-dt', 'wm-gnss', 'wm-auto', 'wm-iso', 'wm-stream', 'wm-hgt', 'wm-jet', 'wm-jetdepth', 'wm-sonde'];
const DATE_IDS = ['wm-start', 'wm-end'];           // the custom period
const $ = id => document.getElementById(id);
function saveSettings() {
  const s = {};
  CTRL_IDS.forEach(id => { s[id] = $(id).value; });
  CHECK_IDS.forEach(id => { s[id] = $(id).checked; });
  DATE_IDS.forEach(id => { s[id] = $(id).value; });
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* private mode */ }
}
function restoreSettings() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (e) { s = null; }
  if (!s) return;
  CTRL_IDS.forEach(id => {
    const el = $(id);
    if (s[id] != null && [...el.options].some(o => o.value === String(s[id]))) el.value = s[id];
  });
  CHECK_IDS.forEach(id => { if (typeof s[id] === 'boolean') $(id).checked = s[id]; });
  DATE_IDS.forEach(id => { if (s[id]) $(id).value = s[id]; });
}

// ── Drawing ───────────────────────────────────────────────────────────────
const keyOf = c => `${c.lat.toFixed(4)},${c.lon.toFixed(4)}`;

function cellWidthPx(d) {
  const c0 = d.cells[0];
  if (!c0 || !c0.bounds) return 0;
  const p1 = map.latLngToContainerPoint([c0.lat, c0.bounds[1]]);
  const p2 = map.latLngToContainerPoint([c0.lat, c0.bounds[3]]);
  return Math.abs(p2.x - p1.x);
}

function render() {
  cellLayer.clearLayers(); anaLayer.clearLayers(); cmpLayer.clearLayers();
  barbLayer.clearLayers(); sondeLayer.clearLayers();
  const d = lastData;
  if (!d || !d.cells) return 0;
  const minAc = parseInt($('wm-minac').value, 10) || 1;
  const cmpMode = lastCmp ? lastCmp.mode : 'off';
  const showDt = $('wm-dt').checked && cmpMode === 'off';
  $('wm-legend-dt').classList.toggle('wm-hidden', !showDt);
  const flStr = flLabel(d.fl);
  const showLabel = cellWidthPx(d) >= 62;          // labels only when cells are wide enough
  const cells = d.cells.filter(c => c.ac >= minAc);

  // compare: matched cells → tint + arrow
  const cmpInfo = renderCompare(d, cells, showLabel);

  for (const cell of cells) {
    if (showDt) {
      const f = tint(cell.dtemp, DT_FULL_K, cell.ac);
      if (f && f.opacity > 0.01) addCellRect(cell, f);
    }
    const lines = [
      `<b>${flStr}</b> &nbsp;<span style="color:#64748b">${cell.lat.toFixed(2)}°N ${cell.lon.toFixed(2)}°E · cell ${d.cell_km} km</span>`,
      `Wind: <b>${cell.wind_dir.toFixed(0)}° @ ${cell.wind_spd.toFixed(1)} kt</b>` +
        (cell.wind_sd != null ? ` <span style="color:#64748b">(spread between aircraft ${cell.wind_sd.toFixed(1)} kt)</span>` : ''),
    ];
    if (cell.dval != null && d.z_isa_m != null) {
      lines.push(`Height of the pressure surface: <b>${Math.round(d.z_isa_m + cell.dval).toLocaleString('en').replace(/,/g, ' ')} m</b> ` +
        `<span style="color:#64748b">(D ${fmtSigned(cell.dval, 0)} m vs the standard atmosphere, ${cell.dval_ac} a/c with GNSS − baro)</span>`);
    }
    if (cell.temp != null) {
      lines.push(`Temp at the level: <b>${fmtT(cell.temp)} °C</b>` +
        (cell.dtemp != null ? ` · ΔT ${fmtSigned(cell.dtemp)} K` : '') +
        (cell.temp_sd != null ? ` <span style="color:#64748b">(SD ${cell.temp_sd.toFixed(1)} K, ${cell.temp_ac} a/c)</span>` : ''));
    }
    lines.push(`Aircraft: <b>${cell.ac}</b> · observations ${cell.obs}` +
      (cell.gnss_deg ? ` · <span style="color:#d97706">${cell.gnss_deg} with degraded GNSS</span>` : ''));
    if (cell.ac < 3) lines.push(`<span style="color:#d97706">Few aircraft — a single airframe's error is not averaged out</span>`);
    const cm = cmpInfo.byKey[keyOf(cell)];
    if (cm) lines.push(cm.popup);

    const tip = `${cell.wind_dir.toFixed(0)}° ${cell.wind_spd.toFixed(0)} kt` +
      (cell.temp != null ? ` · ${fmtT(cell.temp)}°C` : '') +
      (showDt && cell.dtemp != null ? ` · ΔT ${fmtSigned(cell.dtemp)}` : '') +
      (cm ? ` · ${cm.tip}` : '') +
      ` · ${cell.ac} a/c`;
    L.marker([cell.lat, cell.lon], { icon: makeBarbIcon(cell, showLabel && !cm),
                                     zIndexOffset: cell.ac * 10 + Math.min(9, cell.obs) })
      .bindPopup(lines.join('<br>'))
      .bindTooltip(tip, { direction: 'top', offset: [0, -48] })
      .addTo(barbLayer);
  }

  renderAnalysis(d, cells);
  renderSonde(d, cells, showLabel);
  return cells.length;
}

function addCellRect(cell, f) {
  const [s, w, n, e] = cell.bounds;
  L.rectangle([[s, w], [n, e]], {
    stroke: false, fillColor: f.color, fillOpacity: f.opacity, interactive: false,
  }).addTo(cellLayer);
}

// ── Compare: change since previous period / thermal wind ─────────────────
function renderCompare(d, cells, showLabel) {
  const out = { byKey: {}, n: 0 };
  const legend = $('wm-legend-cmp');
  if (!lastCmp || !lastCmp.data || !lastCmp.data.cells) { legend.classList.add('wm-hidden'); return out; }
  const minAc = parseInt($('wm-minac').value, 10) || 1;
  const other = {};
  for (const c of lastCmp.data.cells) if (c.ac >= minAc) other[keyOf(c)] = c;
  const mode = lastCmp.mode;
  const o = lastCmp.data;
  legend.classList.remove('wm-hidden');
  if (mode === 'prev') {
    legend.innerHTML = `<span class="wm-arrow-key">→</span> wind change since ${utcStr(o.start_ts).replace(' UTC', '')}–${utcStr(o.end_ts)}` +
      ` · <span class="wm-dt-bar"></span> cooled · warmed (±3 K)`;
  } else {
    const up = d.fl > o.fl ? d : o, lo = d.fl > o.fl ? o : d;
    legend.innerHTML = `<span class="wm-arrow-key">→</span> thermal wind ${flLabel(lo.fl)} → ${flLabel(up.fl)} (cold air to the left)` +
      ` · <span class="wm-dt-bar"></span> backing (cold advection) · veering (warm advection)`;
  }
  for (const c of cells) {
    const p = other[keyOf(c)];
    if (!p) continue;
    const [u1, v1] = wmToUV(c.wind_dir, c.wind_spd);
    const [u0, v0] = wmToUV(p.wind_dir, p.wind_spd);
    const ac = Math.min(c.ac, p.ac);
    let du, dv, f, label, popup, tip;
    if (mode === 'prev') {
      du = u1 - u0; dv = v1 - v0;
      const mag = Math.hypot(du, dv);
      const dT = c.temp != null && p.temp != null ? c.temp - p.temp : null;
      f = tint(dT, 3, ac);
      label = `${Math.round(mag)}kt` + (dT != null ? ` ${fmtSigned(dT)}K` : '');
      popup = `<span style="color:${cmpColor()}">Change since the previous period: wind ${p.wind_dir.toFixed(0)}° ${p.wind_spd.toFixed(0)} kt → ` +
        `${c.wind_dir.toFixed(0)}° ${c.wind_spd.toFixed(0)} kt (vector change ${mag.toFixed(0)} kt)` +
        (dT != null ? `, temperature ${fmtSigned(dT)} K` : '') + ` · ${p.ac} a/c before</span>`;
      tip = `Δ ${mag.toFixed(0)} kt` + (dT != null ? ` ${fmtSigned(dT)} K` : '');
    } else {
      const upper = d.fl > o.fl ? c : p, lower = d.fl > o.fl ? p : c;
      const [uu, vu] = wmToUV(upper.wind_dir, upper.wind_spd);
      const [ul, vl] = wmToUV(lower.wind_dir, lower.wind_spd);
      du = uu - ul; dv = vu - vl;
      const mag = Math.hypot(du, dv);
      const turn = angDiff(upper.wind_dir, lower.wind_dir);      // + = veering with height
      const strong = upper.wind_spd >= 8 && lower.wind_spd >= 8;
      f = strong ? tint(turn, 30, ac) : null;
      const dz = Math.abs(d.altitude_ft - o.altitude_ft) / 1000;
      const lapse = upper.temp != null && lower.temp != null && dz > 0 ? (upper.temp - lower.temp) / dz : null;
      label = `${Math.round(mag)}kt` + (strong ? ` ${turn >= 0 ? 'V' : 'B'}${Math.abs(Math.round(turn))}°` : '');
      popup = `<span style="color:${cmpColor()}">Thermal wind ${flLabel(Math.min(d.fl, o.fl))} → ${flLabel(Math.max(d.fl, o.fl))}: ` +
        `${bearingOf(du, dv).toFixed(0)}° ${mag.toFixed(0)} kt (towards; cold air on its left)` +
        (strong ? ` · wind ${turn >= 0 ? 'veers' : 'backs'} ${Math.abs(turn).toFixed(0)}° with height → ${turn >= 0 ? 'warm' : 'cold'} advection` : '') +
        (lapse != null ? ` · lapse ${fmtSigned(lapse)} K/1000 ft` : '') + ` · other level ${p.ac} a/c</span>`;
      tip = `TW ${mag.toFixed(0)} kt` + (strong ? ` ${turn >= 0 ? 'veer' : 'back'} ${Math.abs(turn).toFixed(0)}°` : '');
    }
    if (f && f.opacity > 0.01) addCellRect(c, f);
    const mag = Math.hypot(du, dv);
    if (mag >= 2) {
      L.marker([c.lat, c.lon], { icon: makeArrowIcon(bearingOf(du, dv), mag, label, showLabel),
                                 interactive: false, zIndexOffset: -1000 }).addTo(cmpLayer);
    }
    out.byKey[keyOf(c)] = { popup, tip };
    out.n++;
  }
  return out;
}

// ── Analysis: isotachs, strongest wind, streamlines, heights ──────────────
function renderAnalysis(d, cells) {
  const iso = $('wm-iso').checked, stream = $('wm-stream').checked, hgt = $('wm-hgt').checked;
  const jet = $('wm-jet').checked;
  if (hgt) renderGeostrophic(d);
  if (!(iso || stream || hgt || jet) || cells.length < 4) return;
  const g = wmAnalyse(cells, { lat0: RECEIVER_LAT, lon0: RECEIVER_LON, cellKm: d.cell_km });
  if (!g) return;
  if (stream) {
    for (const line of wmStreamlines(g)) {
      L.polyline(line, { color: lineColor(), weight: 1, opacity: 0.55, interactive: false }).addTo(anaLayer);
      // arrowhead at the middle, pointing downstream
      const m = Math.floor(line.length / 2);
      if (m >= 1) {
        const [la0, lo0] = line[m - 1], [la1, lo1] = line[m];
        const brg = bearingOf((lo1 - lo0) * Math.cos(la1 * Math.PI / 180), la1 - la0);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">
          <polygon points="6,1 10,10 6,7.5 2,10" fill="${lineColor()}" fill-opacity="0.7"
            transform="rotate(${brg},6,6)"/></svg>`;
        L.marker(line[m], { icon: L.divIcon({ html: svg, className: '', iconSize: [12, 12], iconAnchor: [6, 6] }),
                            interactive: false }).addTo(anaLayer);
      }
    }
  }
  if (iso) {
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < g.spd.length; k++) if (g.ok[k]) { lo = Math.min(lo, g.spd[k]); hi = Math.max(hi, g.spd[k]); }
    if (hi > lo) {
      const step = hi - lo > 60 ? 20 : 10;
      const levels = [];
      for (let lv = Math.ceil(lo / step) * step; lv <= hi; lv += step) levels.push(lv);
      const C = wmContours(g, 'spd', levels);
      for (const [lv, segs] of Object.entries(C)) {
        const col = isoColor();
        L.polyline(segs, { color: col, weight: 1.6, opacity: 0.8, dashArray: '5 3', interactive: false }).addTo(anaLayer);
        // a few labels along the line
        const picks = segs.length > 6 ? [Math.floor(segs.length / 3), Math.floor(2 * segs.length / 3)] : [Math.floor(segs.length / 2)];
        for (const n of picks) {
          const [a, b] = segs[n];
          L.marker([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], { interactive: false, icon: L.divIcon({
            className: 'wm-iso-label', html: `<span style="color:${col}">${lv}</span>`, iconSize: [26, 12], iconAnchor: [13, 6] }),
          }).addTo(anaLayer);
        }
      }
      const jc = wmJetCore(g, 30);
      if (jc) renderJet(jc);
    }
  }
  if (hgt) renderHeights(d, g);
  if (jet) renderJetAxis(d, g);
}

// ── Jet stream (aviation SIGWX symbol) ────────────────────────────────────
// Thick line along the axis of strongest wind where it is ≥ the chosen speed
// (wmJetAxis), arrowhead downstream, barb flags and "FLxxx nnn kt" at the
// maximum, change bars where the speed has changed by 20 kt from the maximum,
// optionally the depth (levels with ≥ the speed at the maximum).  Dashed where
// the strongest wind lies at the edge of the data — the real axis may be beyond.
function jetFlagsIcon(bearing, spd) {
  const W = 120, cx = 60, cy = 60, FLEN = 13;
  const flags = (col, sw) => {                    // on the left of the axis, upstream of the maximum
    let g = '', y = cy + 2, rem = Math.round(spd / 5) * 5;
    while (rem >= 50) { g += `<polygon points="${cx},${y} ${cx - FLEN},${y - 4} ${cx},${y + 6}" fill="${col}" stroke="${col}" stroke-width="${sw - 2.2}"/>`; y += 8; rem -= 50; }
    while (rem >= 10) { g += `<line x1="${cx}" y1="${y}" x2="${cx - FLEN}" y2="${y - 5}" stroke="${col}" stroke-width="${sw}" stroke-linecap="round"/>`; y += 5; rem -= 10; }
    if (rem >= 5) g += `<line x1="${cx}" y1="${y}" x2="${cx - FLEN / 2}" y2="${y - 2.5}" stroke="${col}" stroke-width="${sw}" stroke-linecap="round"/>`;
    return g;
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}" style="overflow:visible">
      <g transform="rotate(${bearing},${cx},${cy})"><g opacity="0.6">${flags(haloColor(), 5)}</g>${flags(jetColor(), 2.2)}</g></svg>`;
  return L.divIcon({ html: svg, className: '', iconSize: [W, W], iconAnchor: [cx, cy] });
}
function jetDepth(d, pt, minKt) {
  // levels (of the current one and DEPTH_FLS) with ≥ minKt at the maximum, contiguous around the current level
  if (!lastDepth) return null;
  const lv = lastDepth.filter(x => x.data && x.data.cells && x.data.cells.length >= 4 && x.fl !== d.fl)
    .map(x => ({ fl: x.fl, data: x.data }));
  lv.push({ fl: d.fl, here: true });
  lv.sort((a, b) => a.fl - b.fl);
  for (const x of lv) {
    if (x.here) { x.spd = pt.spd; continue; }
    const g2 = wmAnalyse(x.data.cells, { lat0: RECEIVER_LAT, lon0: RECEIVER_LON, cellKm: x.data.cell_km });
    x.spd = null;
    if (!g2) continue;
    const [px, py] = g2.proj.toXY(pt.lat, pt.lon);
    let best = Infinity;
    for (let k = 0; k < g2.spd.length; k++) {
      if (!g2.ok[k]) continue;
      const i = k % g2.nx, j = Math.floor(k / g2.nx);
      const r = Math.hypot(g2.x0 + i * g2.dx - px, g2.y0 + j * g2.dx - py);
      if (r < best && r <= x.data.cell_km) { best = r; x.spd = g2.spd[k]; }
    }
  }
  const h = lv.findIndex(x => x.here);
  let a = h, b = h;
  while (a > 0 && lv[a - 1].spd != null && lv[a - 1].spd >= minKt) a--;
  while (b < lv.length - 1 && lv[b + 1].spd != null && lv[b + 1].spd >= minKt) b++;
  return { lo: lv[a].fl, hi: lv[b].fl, levels: lv.map(x => `${flLabel(x.fl)} ${x.spd != null ? Math.round(x.spd) + ' kt' : '–'}`) };
}
function renderJetAxis(d, g) {
  const minKt = parseInt($('wm-jetkt').value, 10) || 80;
  const J = wmJetAxis(g, { minKt });
  if (!J) return;
  const P = J.pts, col = jetColor(), halo = haloColor();
  const mx = P[J.iMax];
  const dep = $('wm-jetdepth').checked ? jetDepth(d, mx, minKt) : null;
  const flS = flLabel(d.fl);
  const depS = dep && (dep.lo !== d.fl || dep.hi !== d.fl) ? ` ${flLabel(dep.lo).replace('FL', '')}/${flLabel(dep.hi).replace('FL', '')}` : '';
  const edgeMax = mx.edge;
  const tip = `Jet stream ${flS}: maximum ${Math.round(mx.spd)} kt from ${Math.round(mx.dir)}°` +
    ` · axis drawn where the smoothed wind is ≥ ${minKt} kt (${P.length} section${P.length === 1 ? '' : 's'} of ${Math.round(2 * g.dx)} km)` +
    (edgeMax ? ' · the strongest wind lies at the edge of the data: the real axis is probably beyond it (dashed)' : '') +
    (dep ? ` · ≥ ${minKt} kt at the maximum: ${flLabel(dep.lo)}–${flLabel(dep.hi)} (${dep.levels.join(', ')})` : '');
  // the line: solid where the axis is inside the data, dashed at the edge
  const ext = P.length === 1
    ? [{ ...P[0], lat: g.proj.toLL(P[0].x - J.ex * g.dx, P[0].y - J.ey * g.dx)[0], lon: g.proj.toLL(P[0].x - J.ex * g.dx, P[0].y - J.ey * g.dx)[1] },
       { ...P[0], lat: g.proj.toLL(P[0].x + J.ex * g.dx, P[0].y + J.ey * g.dx)[0], lon: g.proj.toLL(P[0].x + J.ex * g.dx, P[0].y + J.ey * g.dx)[1] }]
    : P;
  L.polyline(ext.map(p => [p.lat, p.lon]), { color: halo, weight: 8, opacity: 0.55, interactive: false }).addTo(anaLayer);
  for (let i = 0; i < ext.length - 1; i++) {
    const a = ext[i], b = ext[i + 1], dashed = a.edge || b.edge;
    L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: col, weight: 4, opacity: 0.95, dashArray: dashed ? '10 7' : null,
                                                  lineCap: dashed ? 'butt' : 'round' }).bindTooltip(tip).addTo(anaLayer);
  }
  // arrowhead at the downstream end
  const e1 = ext[ext.length - 1], e0 = ext[ext.length - 2];
  const brgEnd = bearingOf((e1.lon - e0.lon) * Math.cos(e1.lat * Math.PI / 180), e1.lat - e0.lat);
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26" style="overflow:visible">
      <polygon points="13,0 22,20 13,15 4,20" fill="${col}" stroke="${halo}" stroke-width="1.5" transform="rotate(${brgEnd},13,13)"/></svg>`;
  L.marker([e1.lat, e1.lon], { icon: L.divIcon({ html: head, className: '', iconSize: [26, 26], iconAnchor: [13, 13] }),
                               interactive: false }).addTo(anaLayer);
  // barb flags and label at the maximum (bearing of the axis there)
  // (the flags lie on the axis upstream of the maximum: bearing of the segment leading into it)
  const im = P.length === 1 ? 1 : Math.max(1, J.iMax);
  const m0 = ext[im - 1], m1 = ext[im];
  const brgMax = bearingOf((m1.lon - m0.lon) * Math.cos(m1.lat * Math.PI / 180), m1.lat - m0.lat);
  L.marker([mx.lat, mx.lon], { icon: jetFlagsIcon(brgMax, mx.spd), zIndexOffset: 6500 }).bindTooltip(tip).addTo(anaLayer);
  const lab = `${flS} ${Math.round(mx.spd)} kt${depS}${edgeMax ? ' ↑ stronger beyond?' : ''}`;
  L.marker([mx.lat, mx.lon], { interactive: false, zIndexOffset: 6501, icon: L.divIcon({ className: 'wm-iso-label wm-jet-label',
      html: `<span style="color:${col}">${lab}</span>`, iconSize: [170, 14], iconAnchor: [-14, 22] }) }).addTo(anaLayer);
  // change bars: where the speed along the axis has dropped by 20, 40 … kt from the maximum
  const kx = 110.57 * Math.cos(RECEIVER_LAT * Math.PI / 180);
  for (const dirn of [-1, 1]) {
    let next = Math.round(mx.spd) - 20;
    for (let i = J.iMax; i + dirn >= 0 && i + dirn < P.length; i += dirn) {
      const a = P[i], b = P[i + dirn];
      while (next >= minKt - 20 && a.spd >= next && b.spd < next) {
        const f = (a.spd - next) / (a.spd - b.spd);
        const x = a.x + f * (b.x - a.x), y = a.y + f * (b.y - a.y);
        for (const off of [-3, 3]) {                     // double bar across the axis
          const cx = x + off * J.ex, cy = y + off * J.ey;
          const p1 = g.proj.toLL(cx + 14 * J.lx, cy + 14 * J.ly), p2 = g.proj.toLL(cx - 14 * J.lx, cy - 14 * J.ly);
          L.polyline([p1, p2], { color: col, weight: 2.5, opacity: 0.95, interactive: false }).addTo(anaLayer);
        }
        next -= 20;
      }
    }
  }
}

function renderJet(jc) {
  L.marker([jc.lat, jc.lon], { icon: L.divIcon({ className: 'wm-iso-label wm-jet-label',
      html: `<span style="color:${isoColor()}">▲ max ${Math.round(jc.spd)} kt</span>`,
      iconSize: [80, 14], iconAnchor: [40, -6] }) })
    .bindTooltip(`Strongest analysed wind ${Math.round(jc.dir)}° ${Math.round(jc.spd)} kt (smoothed field; may lie at the edge of the data)`)
    .addTo(anaLayer);
}

// Height contours of the pressure surface (m above mean sea level) from the
// cells' D-values, only where cells with a GNSS − baro difference are near
function renderHeights(d, g) {
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < g.h.length; k++) if (g.hok[k]) { lo = Math.min(lo, g.h[k]); hi = Math.max(hi, g.h[k]); }
  if (!(hi > lo)) return;
  const step = hi - lo > 120 ? 20 : hi - lo > 40 ? 10 : 5;
  const z0 = d.z_isa_m || 0;
  const levels = [];
  for (let lv = Math.ceil((z0 + lo) / step) * step; lv <= z0 + hi; lv += step) levels.push(lv - z0);
  const C = wmContours(g, 'h', levels, 'hok');
  const col = hgtColor();
  for (const [lv, segs] of Object.entries(C)) {
    L.polyline(segs, { color: col, weight: 1.5, opacity: 0.85, interactive: false }).addTo(anaLayer);
    const picks = segs.length > 6 ? [Math.floor(segs.length / 3), Math.floor(2 * segs.length / 3)] : [Math.floor(segs.length / 2)];
    const z = Math.round(z0 + parseFloat(lv));
    for (const n of picks) {
      const [a, b] = segs[n];
      L.marker([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], { interactive: false, icon: L.divIcon({
        className: 'wm-iso-label', html: `<span style="color:${col}">${z}</span>`, iconSize: [34, 12], iconAnchor: [17, 6] }),
      }).addTo(anaLayer);
    }
  }
}

// Geostrophic wind of the area (plane fit of the heights, server side) and
// the mean measured wind of the same aircraft, at the centre of the fit
function renderGeostrophic(d) {
  const g = d.geo;
  if (!g) return;
  const [la, lo] = wmProj(RECEIVER_LAT, RECEIVER_LON).toLL(g.centre_km[0], g.centre_km[1]);
  const tip = `Geostrophic wind of the area ${g.dir}° ${Math.round(g.spd)} kt (±${Math.round(g.se_kt)}) from the height gradient ` +
    `${g.grad_m_per_100km} m / 100 km · measured mean ${g.meas_dir}° ${Math.round(g.meas_spd)} kt · ageostrophic ${Math.round(g.ageo_spd)} kt ` +
    `(${g.aircraft} aircraft positions${g.removed ? `, ${g.removed} outliers left out` : ''}, residual ${g.rms_m} m)`;
  L.marker([la, lo], { icon: makeArrowIcon(meas(g.meas_dir), g.meas_spd, `V ${Math.round(g.meas_spd)}`, true, lineColor(), '', 18),
                       zIndexOffset: 6000 }).bindTooltip(tip).addTo(sondeLayer);
  L.marker([la, lo], { icon: makeArrowIcon(meas(g.dir), g.spd, `Vg ${Math.round(g.spd)}`, true, hgtColor(), '4 2', -18),
                       zIndexOffset: 6001 }).bindTooltip(tip).addTo(sondeLayer);
}
const meas = from => (from + 180) % 360;              // wind FROM → arrow towards

// ── Radiosonde at the level ───────────────────────────────────────────────
function sondeAtLevel(s, pHpa) {
  const lv = (s.levels || []).filter(l => l.pressure != null).sort((a, b) => b.pressure - a.pressure);
  if (lv.length < 2 || pHpa > lv[0].pressure || pHpa < lv[lv.length - 1].pressure) return null;
  for (let i = 0; i < lv.length - 1; i++) {
    const a = lv[i], b = lv[i + 1];
    if (pHpa <= a.pressure && pHpa >= b.pressure) {
      const f = (Math.log(a.pressure) - Math.log(pHpa)) / (Math.log(a.pressure) - Math.log(b.pressure) || 1);
      const out = {};
      if (a.temp != null && b.temp != null) out.temp = a.temp + f * (b.temp - a.temp);
      if (a.wind_spd != null && b.wind_spd != null && a.wind_dir != null && b.wind_dir != null) {
        const [ua, va] = wmToUV(a.wind_dir, a.wind_spd), [ub, vb] = wmToUV(b.wind_dir, b.wind_spd);
        const [dir, spd] = wmFromUV(ua + f * (ub - ua), va + f * (vb - va));
        out.wind_dir = dir; out.wind_spd = spd;
      }
      return out;
    }
  }
  return null;
}

function renderSonde(d, cells, showLabel) {
  const s = lastSonde;
  if (!$('wm-sonde').checked || !s || !s.found) return;
  const pos = (s.lat != null && s.lon != null) ? [s.lat, s.lon] : SONDE_SITE;
  const p = isaP(d.alt_query_ft != null ? d.alt_query_ft : d.altitude_ft);
  const v = sondeAtLevel(s, p);
  const hh = s.key ? `${s.key.slice(6, 8)}.${+s.key.slice(4, 6)}. ${s.key.slice(8, 10)} UTC` : '';
  const age = s.launch && d.end_ts ? (d.end_ts - s.launch) / 3600 : null;
  const head = `<b style="color:${sondeColor()}">${s.station || 'Jokioinen'} radiosonde ${hh}</b>` +
    (age != null ? ` <span style="color:#64748b">(launched ${age.toFixed(1)} h before the end of the period)</span>` : '');
  if (!v || v.wind_spd == null) {
    const why = s.min_p != null && p < s.min_p ? `the sounding stops at ${Math.round(s.min_p)} hPa, below this level (${Math.round(p)} hPa)` : 'no wind at this level';
    L.circleMarker(pos, { radius: 5, color: sondeColor(), weight: 2, fillOpacity: 0 })
      .bindPopup(`${head}<br>${why}`).bindTooltip(`Sonde ${hh}: ${why}`).addTo(sondeLayer);
    return;
  }
  const cell = { wind_dir: v.wind_dir, wind_spd: v.wind_spd, temp: v.temp, ac: 3 };
  // nearest Mode S cell within one cell size
  let near = null, best = Infinity;
  for (const c of cells) {
    const dist = Math.hypot((c.lat - pos[0]) * 110.57, (c.lon - pos[1]) * 110.57 * Math.cos(pos[0] * Math.PI / 180));
    if (dist < best) { best = dist; near = c; }
  }
  let cmp = '';
  if (near && best <= d.cell_km) {
    const [u1, v1] = wmToUV(near.wind_dir, near.wind_spd), [u0, v0] = wmToUV(v.wind_dir, v.wind_spd);
    cmp = `<br>Nearest Mode S cell (${best.toFixed(0)} km, ${near.ac} a/c): ${near.wind_dir.toFixed(0)}° ${near.wind_spd.toFixed(0)} kt` +
      (near.temp != null ? `, ${fmtT(near.temp)} °C` : '') +
      ` → difference ${Math.hypot(u1 - u0, v1 - v0).toFixed(0)} kt` +
      (near.temp != null && v.temp != null ? `, ${fmtSigned(near.temp - v.temp)} K` : '');
  }
  const lines = [`JOK ${s.key ? s.key.slice(8, 10) + 'Z' : ''} ${Math.round(v.wind_spd)}kt`];
  if (v.temp != null) lines.push(`${fmtT(v.temp)}°`);
  L.marker(pos, { icon: makeBarbIcon(cell, showLabel, { color: sondeColor(), opacity: 1, square: true, strokeWidth: 2, lines }),
                  zIndexOffset: 5000 })
    .bindPopup(`${head}<br>At ${Math.round(p)} hPa: <b>${v.wind_dir.toFixed(0)}° @ ${v.wind_spd.toFixed(1)} kt</b>` +
               (v.temp != null ? ` · <b>${fmtT(v.temp)} °C</b>` : '') + cmp)
    .bindTooltip(`Sonde ${hh}: ${v.wind_dir.toFixed(0)}° ${v.wind_spd.toFixed(0)} kt` + (v.temp != null ? ` · ${fmtT(v.temp)}°C` : ''),
                 { direction: 'top', offset: [0, -48] })
    .addTo(sondeLayer);
}

function statusText(d, shown) {
  const flStr = flLabel(d.fl);
  const rm = d.removed || {};
  const rmParts = [];
  if (rm.frozen) rmParts.push(`${rm.frozen} frozen`);
  if (rm.jump) rmParts.push(`${rm.jump} jumped`);
  if (rm.gnss) rmParts.push(`${rm.gnss} degraded GNSS`);
  let qnhNote = '';
  if (d.fl < 50 && d.qnh_hpa != null) {
    const corr = d.qnh_correction_ft != null ? d.qnh_correction_ft : 0;
    qnhNote = ` · QNH ${d.qnh_hpa} hPa${d.qnh_source ? ' (' + d.qnh_source + ')' : ''}, alt corr ${corr >= 0 ? '+' : '−'}${Math.abs(corr)} ft`;
  }
  const tl = d.temp_layer != null ? ` · layer ${fmtT(d.temp_layer)} °C (lapse ${fmtSigned(d.lapse_k_per_1000ft)} K/1000 ft)` : '';
  let hg = '';
  if ($('wm-hgt').checked) {
    const g = d.geo;
    hg = g ? ` · geostrophic ${g.dir}°/${Math.round(g.spd)} kt vs measured ${g.meas_dir}°/${Math.round(g.meas_spd)} kt (${g.aircraft} aircraft positions)`
           : ' · heights: too few or too clustered aircraft for the geostrophic wind';
    if (d.gcal && !d.gcal.soundings) hg += ' · height calibration: default (no soundings yet)';
  }
  const shownTxt = shown != null && shown !== d.cells_count ? `${shown} of ${d.cells_count}` : `${d.cells_count}`;
  let cmp = '';
  if (lastCmp && lastCmp.data) {
    const o = lastCmp.data;
    cmp = lastCmp.mode === 'prev'
      ? ` · previous period ${o.aircraft} a/c, ${o.cells_count} cells`
      : ` · ${flLabel(o.fl)} ${o.aircraft} a/c, ${o.cells_count} cells`;
  }
  return `${flStr} ±${d.tolerance_ft} ft · ${d.aircraft} a/c, ${d.obs_used} obs → ${shownTxt} cells (${d.cell_km} km)` +
    (rmParts.length ? ` · removed ${rmParts.join(', ')}` : '') +
    ` · ${d.period_start} – ${d.period_end}${tl}${qnhNote}${cmp}${hg}`;
}

// ── Period and time slider ────────────────────────────────────────────────
// The slider moves the period back by whole hours (0 = the chosen end).
function periodRange() {
  const shift = parseInt($('wm-tshift').value, 10) * 3600;
  const period = $('wm-period').value;
  if (period === 'custom') {
    const sv = $('wm-start').value, ev = $('wm-end').value;
    if (!sv || !ev) return { error: 'Please select start and end date/time.' };
    const s = Math.floor(new Date(sv).getTime() / 1000), e = Math.floor(new Date(ev).getTime() / 1000);
    if (e <= s) return { error: 'End time must be after start time.' };
    return { start: s + shift, end: e + shift };
  }
  const end = Math.floor(Date.now() / 1000) + shift;
  return { start: end - parseInt(period, 10) * 60, end };
}
function updateTimeLabel() {
  const r = periodRange();
  const shift = parseInt($('wm-tshift').value, 10);
  $('wm-tlabel').textContent = r.error ? '' :
    (shift === 0 && $('wm-period').value !== 'custom' ? 'now' : `to ${utcStr(r.end)}`) + (shift ? ` (${shift} h)` : '');
}

// ── Fetch ─────────────────────────────────────────────────────────────────
let loading = false;
function apiUrl(fl, tol, cell, gnss, start, end) {
  return `/api/windmap?fl=${fl}&tolerance=${tol}&cell=${cell}${gnss ? '&gnss_ok=1' : ''}` +
         `&start=${start}&end=${end}`;
}
async function loadWindMap() {
  if (loading) return;
  const fl   = parseInt($('wm-fl').value, 10);
  const tol  = parseInt($('wm-tol').value, 10);
  const cell = parseFloat($('wm-cell').value);
  const gnss = $('wm-gnss').checked;
  const cmpMode = $('wm-cmp').value;
  const fl2  = parseInt($('wm-fl2').value, 10);
  const btn = $('wm-load'), status = $('wm-status');

  const r = periodRange();
  if (r.error) { status.textContent = r.error; return; }
  updateTimeLabel();

  loading = true;
  btn.disabled = true;
  // keep the previous text (dimmed) while loading; the status floats over the map
  if (!lastData) status.textContent = 'Loading…';
  status.classList.add('wm-loading');
  saveSettings();
  try {
    const jobs = [fetch(apiUrl(fl, tol, cell, gnss, r.start, r.end)).then(x => x.json())];
    if (cmpMode === 'prev') {
      const len = r.end - r.start;
      jobs.push(fetch(apiUrl(fl, tol, cell, gnss, r.start - len, r.start)).then(x => x.json()));
    } else if (cmpMode === 'level' && fl2 !== fl) {
      jobs.push(fetch(apiUrl(fl2, tol, cell, gnss, r.start, r.end)).then(x => x.json()));
    } else {
      jobs.push(Promise.resolve(null));
    }
    jobs.push($('wm-sonde').checked
      ? fetch(`/api/sonde?at=${r.end}&max_age_h=24`).then(x => x.json()).catch(() => null)
      : Promise.resolve(null));
    const depthOn = $('wm-jet').checked && $('wm-jetdepth').checked;
    jobs.push(depthOn
      ? Promise.all(DEPTH_FLS.filter(f => f !== fl).map(f => fetch(apiUrl(f, 2000, cell, gnss, r.start, r.end))
          .then(x => x.json()).then(data => ({ fl: f, data })).catch(() => ({ fl: f, data: null }))))
      : Promise.resolve(null));
    const [d, c, s, dep] = await Promise.all(jobs);
    lastDepth = dep;
    lastData = d;
    lastCmp = c ? { mode: cmpMode, data: c } : null;
    lastSonde = s;
    const shown = render();
    if (!d.cells || d.cells.length === 0) {
      status.textContent =
        `No data for ${flLabel(fl)} ±${tol} ft in the selected period. ` +
        `Try a longer time window or wider altitude tolerance.`;
    } else {
      status.textContent = statusText(d, shown);
    }
  } catch (e) {
    status.textContent = 'Error loading wind map data.';
    console.error(e);
  }
  status.classList.remove('wm-loading');
  btn.disabled = false;
  loading = false;
}

// ── Animation over the last 24 h ──────────────────────────────────────────
let playing = false;
async function play() {
  playing = !playing;
  $('wm-play').textContent = playing ? '■' : '▶';
  while (playing) {
    const el = $('wm-tshift');
    let v = parseInt(el.value, 10) + 1;
    if (v > 0) v = parseInt(el.min, 10);
    el.value = v;
    await loadWindMap();
    await new Promise(res => setTimeout(res, 1200));
  }
}

// ── Auto reload (Last … periods, slider at "now") ─────────────────────────
const AUTO_MS = 2 * 60 * 1000;
let lastAuto = 0;
function autoOn() {
  return $('wm-auto').checked && $('wm-period').value !== 'custom' &&
         !playing && parseInt($('wm-tshift').value, 10) === 0;
}
setInterval(() => {
  if (autoOn() && !document.hidden) { lastAuto = Date.now(); loadWindMap(); }
}, AUTO_MS);
// Browsers pause timers in background tabs: reload when the page is shown again
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && autoOn() && Date.now() - lastAuto > AUTO_MS) {
    lastAuto = Date.now(); loadWindMap();
  }
});

// ── Theme: map style and colours follow the page's Light / Dark button ────
window.onThemeChange = function () {
  const want = pageIsLight() ? 'light' : 'dark';
  if (want !== tileTheme) {
    map.removeLayer(TILES[tileTheme]);
    TILES[want].addTo(map);
    TILES[want].bringToBack();
    tileTheme = want;
  }
  if (lastData) render();
};

// Labels appear / disappear with the zoom
map.on('zoomend', () => { if (lastData && lastData.cells && lastData.cells.length) render(); });

// ── Control wiring ────────────────────────────────────────────────────────
function syncVisibility() {
  $('wm-custom-range').classList.toggle('wm-hidden', $('wm-period').value !== 'custom');
  $('wm-fl2').classList.toggle('wm-hidden', $('wm-cmp').value !== 'level');
  $('wm-dt').disabled = $('wm-cmp').value !== 'off';
  $('wm-jetkt').disabled = $('wm-jetdepth').disabled = !$('wm-jet').checked;
  updateTimeLabel();
}
$('wm-period').addEventListener('change', syncVisibility);
$('wm-load').addEventListener('click', loadWindMap);
$('wm-play').addEventListener('click', play);
$('wm-tshift').addEventListener('input', updateTimeLabel);
$('wm-tshift').addEventListener('change', () => { if (!playing) loadWindMap(); });
// Display-only options redraw the last answer without a new query
['wm-minac', 'wm-dt', 'wm-iso', 'wm-stream', 'wm-hgt', 'wm-jetkt'].forEach(id => $(id).addEventListener('change', () => {
  saveSettings();
  if (lastData && lastData.cells && lastData.cells.length) {
    const shown = render();
    $('wm-status').textContent = statusText(lastData, shown);
  }
}));
// Options that need another query
['wm-cmp', 'wm-fl2', 'wm-sonde', 'wm-jet', 'wm-jetdepth'].forEach(id => $(id).addEventListener('change', () => {
  syncVisibility(); loadWindMap();
}));
['wm-auto'].forEach(id => $(id).addEventListener('change', saveSettings));

// Enter key anywhere in the control strips triggers load
document.querySelectorAll('.windmap-controls').forEach(el => el.addEventListener('keydown', e => {
  if (e.key === 'Enter') loadWindMap();
}));

// Pre-fill datetime inputs with a sensible default (last hour in local time)
(function initDatetimes() {
  const now  = new Date();
  const ago  = new Date(now - 3600_000);
  const fmt  = dt => `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}` +
                     `T${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
  $('wm-start').value = fmt(ago);
  $('wm-end').value   = fmt(now);
})();

restoreSettings();
syncVisibility();
// The map loads at once when the page opens (with the remembered settings)
loadWindMap();
