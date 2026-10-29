// Flights page (redesigned 2026-10-29): the stored flights on the left, the
// selected flight on the right — its track on the map (coloured by altitude or
// by the meteo source, wind barbs), the vertical profile (wind and
// temperature against altitude), the time series and the observations.
// Hovering a time series or a table row marks the point on the map.
'use strict';

// ── Settings (remembered in the browser) ────────────────────────────────────
const FL_KEY = 'ms_fl_view';
const flView = (() => {
  const d = { h: 24, kind: 'all', col: 'alt', barbs: true };
  try { return Object.assign(d, JSON.parse(localStorage.getItem(FL_KEY) || '{}')); } catch (_) { return d; }
})();
function saveView() { try { localStorage.setItem(FL_KEY, JSON.stringify(flView)); } catch (_) {} }

let flPage = 1, flDate = null, flQ = '', flRows = [], flSel = null, flDetail = null, flTotal = 0;
const PER = 50;

const $ = id => document.getElementById(id);
const isLight = () => document.documentElement.dataset.theme === 'light';
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// ── Formatting ──────────────────────────────────────────────────────────────
const pad2 = n => String(n).padStart(2, '0');
function hhmm(ts) { const d = new Date(ts * 1000); return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()); }
function hhmmss(ts) { const d = new Date(ts * 1000); return hhmm(ts) + ':' + pad2(d.getUTCSeconds()); }
function dmy(ts) { const d = new Date(ts * 1000); return pad2(d.getUTCDate()) + '.' + pad2(d.getUTCMonth() + 1) + '.'; }
const sameUtcDay = (a, b) => new Date(a * 1000).toISOString().slice(0, 10) === new Date(b * 1000).toISOString().slice(0, 10);
function altTxt(ft) {
  if (ft == null) return '—';
  return ft >= 10000 ? 'FL' + String(Math.round(ft / 100)).padStart(3, '0') : ft.toLocaleString('en-US').replace(/,/g, ' ');
}
function durTxt(sec) {
  const m = Math.round(sec / 60);
  return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + pad2(m % 60) + ' min';
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── Colours ────────────────────────────────────────────────────────────────
// Altitude: amber near the ground → green → cyan → blue → violet at FL400+
const ALT_STOPS = [[0, [245, 158, 11]], [5000, [132, 204, 22]], [10000, [16, 185, 129]],
                   [20000, [6, 182, 212]], [30000, [59, 130, 246]], [40000, [168, 85, 247]]];
function altCol(ft) {
  if (ft == null) return '#64748b';
  const s = ALT_STOPS;
  if (ft <= s[0][0]) return `rgb(${s[0][1]})`;
  for (let i = 1; i < s.length; i++) {
    if (ft <= s[i][0]) {
      const k = (ft - s[i - 1][0]) / (s[i][0] - s[i - 1][0]);
      const c = s[i - 1][1].map((v, j) => Math.round(v + k * (s[i][1][j] - v)));
      return `rgb(${c})`;
    }
  }
  return `rgb(${s[s.length - 1][1]})`;
}
// The meteo source, as on the Live Map
const SRC_COL = { MRAR: '#3b82f6', COMPUTED: '#10b981', MHR: '#f59e0b', JSON: '#a855f7', MLAT: '#a855f7' };
const srcCol = s => SRC_COL[s] || '#64748b';
const SRC_LBL = { MRAR: 'MRAR', COMPUTED: 'Computed', MHR: 'MHR', JSON: 'JSON' };
const SRC_SHORT = { MRAR: 'MRAR', COMPUTED: 'Comp', MHR: 'MHR', JSON: 'JSON' };
// EDR classes (ICAO): light from 0.10, moderate from 0.20
const edrCls = e => e == null ? '' : e >= 0.20 ? 'fl-edr-mod' : e >= 0.10 ? 'fl-edr-lgt' : 'fl-edr-nil';
const WS_LBL = { none: 'none', adv: 'advisory', wsa: 'windshear alert', mba: 'microburst alert' };

// ── The list ───────────────────────────────────────────────────────────────
function periodTitle() {
  if (flDate) return 'Flights — ' + flDate.split('-').reverse().join('.') + ' UTC';
  if (!flView.h) return 'Flights — all stored';
  return 'Flights — last ' + (flView.h >= 24 ? (flView.h / 24) + (flView.h === 24 ? ' day' : ' days') : flView.h + ' h').replace('1 day', '24 h');
}

async function loadList(keepSel) {
  const p = new URLSearchParams({ page: flPage, per: PER, kind: flView.kind });
  if (flQ) p.set('q', flQ);
  if (flDate) p.set('date', flDate); else p.set('hours', flView.h);
  let d;
  try {
    const r = await fetch('/api/flights?' + p);
    d = await r.json();
  } catch (e) { $('fl-updated').textContent = 'Could not load the flights'; return; }
  flRows = d.flights || [];
  flTotal = d.total || 0;
  for (const k of ['all', 'arr', 'dep', 'snd']) $('fl-n-' + k).textContent = (d.counts?.[k] ?? 0).toLocaleString('en-US').replace(/,/g, ' ');
  $('fl-list-title').textContent = periodTitle() + (flQ ? ` · “${flQ}”` : '');
  $('fl-updated').textContent = 'Updated ' + hhmm(d.now || Date.now() / 1000) + ' UTC';
  const pages = Math.max(1, Math.ceil(flTotal / PER));
  $('fl-page-info').textContent = flTotal
    ? `${((flPage - 1) * PER + 1).toLocaleString('en-US')}–${Math.min(flPage * PER, flTotal).toLocaleString('en-US')} of ${flTotal.toLocaleString('en-US')}`
    : 'No flights';
  $('fl-prev').disabled = flPage <= 1;
  $('fl-next').disabled = flPage >= pages;
  renderList(d.now);
  if (!keepSel && flRows.length && (flSel == null || !flRows.some(f => f.id === flSel))) selectFlight(flRows[0].id);
}

function altBar(f) {
  const top = 45000;
  const lo = Math.max(0, Math.min(top, f.min_altitude ?? 0)), hi = Math.max(0, Math.min(top, f.max_altitude ?? 0));
  const l = lo / top * 100, w = Math.max(1.5, (hi - lo) / top * 100);
  const arrow = f.arr ? '<i class="fl-arr-dn">↓</i>' : f.dep ? '<i class="fl-arr-up">↑</i>' : '';
  const txt = (f.max_altitude ?? 0) - (f.min_altitude ?? 0) < 600 ? altTxt(f.max_altitude)
            : altTxt(f.min_altitude) + '–' + altTxt(f.max_altitude);
  return `<span class="fl-altwrap"><span class="fl-altbar" title="${esc(altTxt(f.min_altitude))} – ${esc(altTxt(f.max_altitude))} ft">` +
         `<span class="fl-altbar-fill" style="left:${l}%;width:${w}%;background:linear-gradient(90deg,${altCol(lo)},${altCol(hi)})"></span></span>` +
         `<span class="fl-alttxt">${arrow}${txt}</span></span>`;
}

function eventCell(f) {
  const out = [];
  if (f.arr) out.push(`<span class="fl-ev fl-ev-arr" title="Landed ${hhmm(f.arr.ts)} UTC on runway ${esc(f.arr.rwy)}">ARR ${esc(f.arr.rwy)}</span>`);
  if (f.dep) out.push(`<span class="fl-ev fl-ev-dep" title="Departed ${hhmm(f.dep.ts)} UTC${f.dep.rwy ? ' from runway ' + esc(f.dep.rwy) : ''}">DEP ${esc(f.dep.rwy || '')}</span>`);
  if ((f.arr && f.arr.ga) || (f.dep && f.dep.ga)) out.push('<span class="fl-ev fl-ev-ga" title="Go-around">GA</span>');
  const ws = (f.arr && f.arr.ws) || (f.dep && f.dep.ws);
  if (ws && ws !== 'none') out.push(`<span class="fl-ev fl-ev-ws" title="Windshear report: ${esc(WS_LBL[ws] || ws)}">WS</span>`);
  return out.join('');
}

function renderList(now) {
  const tb = $('fl-tbody');
  if (!flRows.length) {
    tb.innerHTML = `<tr><td colspan="9" class="fl-empty">No flights${flQ ? ' match “' + esc(flQ) + '”' : ''} in this period</td></tr>`;
    return;
  }
  const today = now || Date.now() / 1000;
  tb.innerHTML = flRows.map(f => {
    const edr = (f.arr && f.arr.edr) ?? (f.dep && f.dep.edr);
    const t = sameUtcDay(f.last_seen, today) ? hhmm(f.last_seen) : `<span class="fl-day">${dmy(f.last_seen)}</span> ${hhmm(f.last_seen)}`;
    return `<tr data-id="${f.id}" class="${f.id === flSel ? 'sel' : ''}">
      <td class="mono">${t}</td>
      <td class="fl-td-cs">${esc(f.callsign || f.icao)}</td>
      <td class="mono dim">${esc(f.reg || '')}</td>
      <td class="mono dim">${esc(f.type || '')}</td>
      <td class="fl-td-alt">${altBar(f)}</td>
      <td>${eventCell(f)}</td>
      <td class="num mono ${edrCls(edr)}">${edr != null ? edr.toFixed(2) : ''}</td>
      <td class="num mono dim">${f.meteo_count}</td>
      <td>${f.snd ? `<a class="fl-snd" href="/sounding?flight=${f.id}" title="Skew-T sounding of this ${f.arr ? 'descent' : f.dep ? 'climb' : 'flight'}">Skew-T</a>` : ''}</td>
    </tr>`;
  }).join('');
}

// ── The selected flight ─────────────────────────────────────────────────────
let map = null, tiles = null, trackLayer = null, barbLayer = null, hoverMk = null, aptMk = null;
const charts = {};

function initMap() {
  map = L.map('fl-map', { zoomControl: true, attributionControl: true, preferCanvas: true })
    .setView([FL_AIRPORT_LAT, FL_AIRPORT_LON], 8);
  setTiles();
  trackLayer = L.layerGroup().addTo(map);
  barbLayer = L.layerGroup().addTo(map);
  map.on('zoomend', drawBarbs);
  aptMk = L.marker([FL_AIRPORT_LAT, FL_AIRPORT_LON], {
    interactive: false,
    icon: L.divIcon({ className: '', iconSize: [0, 0],
      html: `<div class="fl-apt"><svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="2"/></svg><span>${esc(FL_AIRPORT_ICAO)}</span></div>` }),
  }).addTo(map);
}
function setTiles() {
  const key = (typeof CARTO_API_KEY !== 'undefined' && CARTO_API_KEY) ? `?key=${encodeURIComponent(CARTO_API_KEY)}` : '';
  if (tiles) tiles.remove();
  tiles = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${isLight() ? 'light_all' : 'dark_all'}/{z}/{x}/{y}{r}.png${key}`,
    { subdomains: 'abcd', maxZoom: 18, attribution: '© OSM © CARTO' }).addTo(map);
}

async function selectFlight(id) {
  flSel = id;
  document.querySelectorAll('#fl-tbody tr').forEach(tr => tr.classList.toggle('sel', +tr.dataset.id === id));
  try { history.replaceState(null, '', '/flights?id=' + id); } catch (_) {}
  let d;
  try { d = await (await fetch('/api/flights/' + id)).json(); } catch (_) { return; }
  if (flSel !== id) return;
  if (!d || !d.flight) {                      // e.g. an old link to a purged flight: the newest instead
    const first = flRows.find(f => f.id !== id);
    if (first) selectFlight(first.id);
    return;
  }
  flDetail = d;
  renderHead(d.flight, d.observations);
  renderMap();
  renderProfile();
  renderSeries();
  renderObs();
}

function renderHead(f, obs) {
  $('fl-cs').textContent = f.callsign || f.icao;
  $('fl-sub').innerHTML = [f.reg, f.type, f.icao].filter(Boolean).map(esc).join(' · ');
  const met = obs.filter(o => o.best_wind_spd != null || o.best_temp != null).length;
  const facts = [
    ['Seen', `${hhmm(f.first_seen)}–${hhmm(f.last_seen)} UTC <i>${dmy(f.first_seen)}${new Date(f.first_seen * 1000).getUTCFullYear()} · ${durTxt(f.last_seen - f.first_seen)}</i>`],
    ['Altitude', `${altTxt(f.min_altitude)} – ${altTxt(f.max_altitude)}`],
    ['Observations', `${obs.length}` + (met < obs.length ? ` <i>· ${met} with wind / temperature</i>` : ` <i>all with wind / temperature</i>`)],
  ];
  if (f.arr) {
    const a = f.arr;
    facts.push(['Landing', `<span class="fl-ev fl-ev-arr">${esc(a.rwy)}</span> ${hhmm(a.ts)} UTC` +
      (a.ga ? ' <span class="fl-ev fl-ev-ga">GA ' + a.ga + '</span>' : '') +
      (a.aci != null ? ` · ACI <b>${a.aci.toFixed(1)}</b> <i>${esc(a.aci_lbl || '')}</i>` : '') +
      (a.edr != null ? ` · EDR <b class="${edrCls(a.edr)}">${a.edr.toFixed(2)}</b>` : '') +
      (a.ws ? ` · WS <b class="${a.ws !== 'none' ? 'fl-ws-hit' : ''}">${esc(WS_LBL[a.ws] || a.ws)}</b>` : '')]);
  }
  if (f.dep) {
    const a = f.dep;
    facts.push(['Departure', (a.rwy ? `<span class="fl-ev fl-ev-dep">${esc(a.rwy)}</span> ` : '') + `${hhmm(a.ts)} UTC` +
      (a.edr != null ? ` · EDR <b class="${edrCls(a.edr)}">${a.edr.toFixed(2)}</b>` : '') +
      (a.ws ? ` · WS <b class="${a.ws !== 'none' ? 'fl-ws-hit' : ''}">${esc(WS_LBL[a.ws] || a.ws)}</b>` : '')]);
  }
  $('fl-facts').innerHTML = facts.map(([k, v]) => `<span class="fl-fact"><span class="fl-fact-k">${k}</span><span class="fl-fact-v">${v}</span></span>`).join('');
  const sk = $('fl-btn-skewt');
  sk.hidden = !f.snd; sk.href = '/sounding?flight=' + f.id;
  $('fl-btn-link').hidden = false;
}

// A wind barb (SVG) pointing from where the wind blows
function barbIcon(dir, kt, color) {
  const W = 40, cx = 20, cy = 20, L0 = 16, tx = cx, ty = cy - L0;
  let g = '', rem = Math.round(kt / 5) * 5, pos = 0;
  if (rem === 0) g = `<circle cx="${cx}" cy="${cy}" r="4" stroke="${color}" stroke-width="1.4" fill="none"/>`;
  else {
    g += `<line x1="${cx}" y1="${cy}" x2="${tx}" y2="${ty}" stroke="${color}" stroke-width="1.4"/>`;
    while (rem >= 50) { g += `<polygon points="${tx},${ty + pos} ${tx + 8},${ty + pos + 2} ${tx},${ty + pos + 4}" fill="${color}"/>`; pos += 5; rem -= 50; }
    while (rem >= 10) { g += `<line x1="${tx}" y1="${ty + pos}" x2="${tx + 8}" y2="${ty + pos - 2.5}" stroke="${color}" stroke-width="1.4"/>`; pos += 3.5; rem -= 10; }
    if (rem >= 5) g += `<line x1="${tx}" y1="${ty + pos}" x2="${tx + 4.5}" y2="${ty + pos - 1.3}" stroke="${color}" stroke-width="1.4"/>`;
  }
  return L.divIcon({ className: '', iconSize: [W, W], iconAnchor: [cx, cy],
    html: `<svg width="${W}" height="${W}" viewBox="0 0 ${W} ${W}" style="overflow:visible"><g transform="rotate(${dir},${cx},${cy})">${g}</g></svg>` });
}

function renderMap() {
  if (!map) initMap();
  trackLayer.clearLayers(); barbLayer.clearLayers();
  if (hoverMk) { hoverMk.remove(); hoverMk = null; }
  const obs = (flDetail?.observations || []).filter(o => o.lat != null && o.lon != null);
  const legend = $('fl-map-legend');
  if (!obs.length) { legend.innerHTML = '<span>No positions stored</span>'; return; }
  const byAlt = flView.col === 'alt';
  // the track in pieces, each coloured by its altitude / source
  for (let i = 1; i < obs.length; i++) {
    const a = obs[i - 1], b = obs[i];
    const gap = b.ts - a.ts > 120;
    L.polyline([[a.lat, a.lon], [b.lat, b.lon]], {
      color: byAlt ? altCol(((a.altitude ?? 0) + (b.altitude ?? 0)) / 2) : srcCol(b.meteo_source),
      weight: 3, opacity: gap ? 0.45 : 0.95, dashArray: gap ? '4 5' : null, interactive: false,
    }).addTo(trackLayer);
  }
  // the points with meteo data
  obs.forEach((o, i) => {
    const has = o.best_wind_spd != null || o.best_temp != null;
    if (!has) return;
    L.circleMarker([o.lat, o.lon], { radius: 2.6, weight: 0, fillOpacity: 0.9,
      fillColor: byAlt ? altCol(o.altitude) : srcCol(o.meteo_source) })
      .bindTooltip(() => obsTip(o), { direction: 'top', offset: [0, -4], className: 'fl-tip' })
      .on('mouseover', () => highlight(flDetail.observations.indexOf(o), 'map'))
      .addTo(trackLayer);
  });
  // start and end
  const s = obs[0], e = obs[obs.length - 1];
  const endMk = (o, txt, cls) => L.marker([o.lat, o.lon], { interactive: false,
    icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="fl-end ${cls}"><b></b><span>${txt}</span></div>` }) }).addTo(trackLayer);
  endMk(s, hhmm(s.ts) + ' · ' + altTxt(s.altitude), 'fl-end-s');
  endMk(e, hhmm(e.ts) + ' · ' + altTxt(e.altitude), 'fl-end-e');
  map.fitBounds(L.latLngBounds(obs.map(o => [o.lat, o.lon])).extend([FL_AIRPORT_LAT, FL_AIRPORT_LON]),
                { padding: [36, 36], maxZoom: 11, animate: false });
  drawBarbs();
  legend.innerHTML = byAlt
    ? '<span class="fl-lg-bar"></span><span class="fl-lg-ticks"><span>0</span><span>10 000</span><span>FL200</span><span>FL300</span><span>FL400</span></span>'
    : Object.entries(SRC_LBL).map(([k, v]) => `<span class="fl-lg-src"><i style="background:${srcCol(k)}"></i>${v}</span>`).join('');
}

// Wind barbs along the track, at least 34 px apart on the screen (redrawn on zoom)
function drawBarbs() {
  barbLayer.clearLayers();
  if (!flView.barbs || !flDetail) return;
  const col = isLight() ? '#0f172a' : '#e2e8f0';
  let last = null;
  for (const o of flDetail.observations) {
    if (o.lat == null || o.best_wind_spd == null || o.best_wind_dir == null) continue;
    const pt = map.latLngToContainerPoint([o.lat, o.lon]);
    if (last && pt.distanceTo(last) < 34) continue;
    L.marker([o.lat, o.lon], { icon: barbIcon(o.best_wind_dir, o.best_wind_spd, col), interactive: false }).addTo(barbLayer);
    last = pt;
  }
}

function obsTip(o) {
  return `<b>${hhmmss(o.ts)}</b> · ${altTxt(o.altitude)} ft` +
    (o.best_wind_spd != null ? `<br>Wind ${Math.round(o.best_wind_dir)}° / ${Math.round(o.best_wind_spd)} kt` : '') +
    (o.best_temp != null ? `<br>Temp ${o.best_temp.toFixed(1)} °C` : '') +
    (o.meteo_source ? `<br><span style="color:${srcCol(o.meteo_source)}">${esc(SRC_LBL[o.meteo_source] || o.meteo_source)}</span>` : '');
}

// ── Charts ─────────────────────────────────────────────────────────────────
function chartTheme() {
  return { tick: isLight() ? '#475569' : '#94a3b8', grid: isLight() ? '#d5dde6' : '#223247' };
}
// a vertical line at the hovered time, drawn by every series chart
const crossPlugin = {
  id: 'flCross',
  afterDatasetsDraw(c) {
    const x = c.$flCrossX;
    if (x == null) return;
    const { ctx, chartArea: a } = c;
    ctx.save(); ctx.strokeStyle = isLight() ? 'rgba(15,23,42,.45)' : 'rgba(226,232,240,.5)';
    ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, a.top); ctx.lineTo(x, a.bottom); ctx.stroke(); ctx.restore();
  },
};

function mkChart(id, cfg) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart($(id).getContext('2d'), cfg);
  return charts[id];
}

// Wind barb drawn on a canvas (staff towards the direction the wind comes from)
function canvasBarb(ctx, x, y, dir, kt, color) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(dir * Math.PI / 180);
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.3; ctx.lineCap = 'round';
  let rem = Math.round(kt / 5) * 5;
  if (rem === 0) { ctx.beginPath(); ctx.arc(0, 0, 3.5, 0, 2 * Math.PI); ctx.stroke(); ctx.restore(); return; }
  const L0 = 18, ty = -L0; let pos = 0;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, ty); ctx.stroke();
  while (rem >= 50) { ctx.beginPath(); ctx.moveTo(0, ty + pos); ctx.lineTo(8, ty + pos + 2); ctx.lineTo(0, ty + pos + 4); ctx.fill(); pos += 5; rem -= 50; }
  while (rem >= 10) { ctx.beginPath(); ctx.moveTo(0, ty + pos); ctx.lineTo(8, ty + pos - 2.5); ctx.stroke(); pos += 3.5; rem -= 10; }
  if (rem >= 5) { ctx.beginPath(); ctx.moveTo(0, ty + pos); ctx.lineTo(4.5, ty + pos - 1.3); ctx.stroke(); }
  ctx.restore();
}
// the mean wind per altitude band (1 000 ft below FL100, 2 000 ft above) as barbs at the right edge
const profBarbs = {
  id: 'flProfBarbs',
  afterDatasetsDraw(c) {
    const bands = c.$flBands; if (!bands) return;
    const { ctx, chartArea: a } = c, x = a.right + 18;
    let lastY = null;
    for (const b of bands) {
      const y = c.scales.y.getPixelForValue(b.alt);
      if (y < a.top + 6 || y > a.bottom - 4) continue;
      if (lastY != null && lastY - y < 20) continue;      // at least 20 px apart
      lastY = y;
      canvasBarb(ctx, x, y, b.dir, b.kt, isLight() ? '#0f172a' : '#e2e8f0');
    }
  },
};
function windBands(obs) {
  const m = new Map();
  for (const o of obs) {
    if (o.best_wind_spd == null || o.best_wind_dir == null || o.altitude == null) continue;
    const step = o.altitude < 10000 ? 1000 : 2000, k = Math.round(o.altitude / step) * step;
    const r = o.best_wind_dir * Math.PI / 180, e = m.get(k) || { u: 0, v: 0, n: 0 };
    e.u += -o.best_wind_spd * Math.sin(r); e.v += -o.best_wind_spd * Math.cos(r); e.n++; m.set(k, e);
  }
  const out = [];
  for (const [alt, e] of m) {
    const u = e.u / e.n, v = e.v / e.n;
    out.push({ alt, kt: Math.hypot(u, v), dir: (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360 });
  }
  return out.sort((p, q) => p.alt - q.alt);
}

function renderProfile() {
  const th = chartTheme();
  const obs = flDetail.observations.filter(o => o.altitude != null);
  const wind = obs.filter(o => o.best_wind_spd != null).map(o => ({ x: o.best_wind_spd, y: o.altitude, d: o.best_wind_dir }));
  const temp = obs.filter(o => o.best_temp != null).map(o => ({ x: o.best_temp, y: o.altitude }));
  $('fl-prof-note').textContent = temp.length ? '' : 'no temperature (no Mach / TAS replies)';
  const pc = mkChart('fl-prof', {
    type: 'scatter', plugins: [profBarbs],
    data: { datasets: [
      { label: 'Wind kt', data: wind, xAxisID: 'xw', borderColor: '#10b981', backgroundColor: '#10b981', pointRadius: 2.2, showLine: false },
      { label: 'Temperature °C', data: temp, xAxisID: 'xt', borderColor: '#ef4444', backgroundColor: '#ef4444', pointRadius: 2.2, showLine: false },
    ] },
    options: {
      animation: false, maintainAspectRatio: false, layout: { padding: { right: 34 } },
      plugins: { legend: { display: false },
                 tooltip: { callbacks: { label: c => c.dataset.xAxisID === 'xw'
                   ? `${altTxt(c.raw.y)}: ${Math.round(c.raw.d)}° / ${c.raw.x.toFixed(0)} kt` : `${altTxt(c.raw.y)}: ${c.raw.x.toFixed(1)} °C` } } },
      scales: {
        y:  { title: { display: false }, ticks: { color: th.tick, font: { size: 10 }, callback: v => altTxt(v) }, grid: { color: th.grid } },
        xw: { position: 'bottom', min: 0, title: { display: true, text: 'wind kt', color: '#10b981', font: { size: 10 } }, ticks: { color: th.tick, font: { size: 10 } }, grid: { color: th.grid } },
        xt: { position: 'top', display: temp.length > 0, title: { display: true, text: 'temperature °C', color: '#ef4444', font: { size: 10 } }, ticks: { color: th.tick, font: { size: 10 } }, grid: { display: false } },
      },
    },
  });
  pc.$flBands = windBands(obs);
  pc.draw();
}

// suggested y range of the data ± pad (Chart.js would round it to wide steps)
function padRange(vals, pad) {
  const v = vals.filter(x => x != null);
  return v.length ? { min: Math.floor((Math.min(...v) - pad) / 10) * 10, max: Math.ceil((Math.max(...v) + pad) / 10) * 10 } : {};
}

function renderSeries() {
  const th = chartTheme();
  const obs = flDetail.observations;
  const t0 = obs.length ? obs[0].ts : 0;
  const pts = (fn) => obs.map((o, i) => ({ x: o.ts, y: fn(o), i })).filter(p => p.y != null);
  const xAxis = { type: 'linear', min: obs[0]?.ts, max: obs[obs.length - 1]?.ts,
    ticks: { color: th.tick, font: { size: 10 }, maxTicksLimit: 8, callback: v => hhmm(v) }, grid: { color: th.grid } };
  const xNo = Object.assign({}, xAxis, { ticks: Object.assign({}, xAxis.ticks, { display: false }) });
  const common = (y, extra = {}, x = xNo) => ({
    animation: false, maintainAspectRatio: false, parsing: false,
    layout: { padding: { bottom: x === xNo ? 6 : 0 } },
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    onHover: (ev, els, c) => { if (els.length) highlight(c.data.datasets[els[0].datasetIndex].data[els[0].index].i, 'chart'); },
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: Object.assign({ x, y: Object.assign({ ticks: { color: th.tick, font: { size: 10 }, maxTicksLimit: 4 }, grid: { color: th.grid } }, y) }, extra),
  });
  mkChart('fl-ts-alt', { type: 'line', plugins: [crossPlugin],
    data: { datasets: [{ data: pts(o => o.altitude), borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,.15)', fill: true, pointRadius: 0, borderWidth: 1.6, tension: 0.2 }] },
    options: common({ ticks: { color: th.tick, font: { size: 10 }, maxTicksLimit: 4, callback: v => altTxt(v) } }) });
  mkChart('fl-ts-wind', { type: 'line', plugins: [crossPlugin],
    data: { datasets: [
      { data: pts(o => o.best_wind_spd), borderColor: '#10b981', pointRadius: 1.5, borderWidth: 1.5, tension: 0.2, yAxisID: 'y' },
      { data: pts(o => o.best_wind_dir), borderColor: '#f59e0b', backgroundColor: '#f59e0b', pointRadius: 1.8, showLine: false, yAxisID: 'yd' },
    ] },
    options: common({ min: 0 }, { yd: { position: 'right', min: 0, max: 360, ticks: { color: '#f59e0b', font: { size: 10 }, stepSize: 90 }, grid: { display: false } } }) });
  const hasT = obs.some(o => o.best_temp != null);
  $('fl-ts-temp').parentElement.classList.toggle('fl-ts-none', !hasT);
  mkChart('fl-ts-temp', { type: 'line', plugins: [crossPlugin],
    data: { datasets: [{ data: pts(o => o.best_temp), borderColor: '#ef4444', pointRadius: 1.5, borderWidth: 1.5, tension: 0.2 }] },
    options: common(padRange(obs.map(o => o.best_temp), 3), {}, xAxis) });
  void t0;
}

function renderObs() {
  const obs = flDetail.observations;
  const met = obs.map((o, i) => [o, i]).filter(([o]) => o.best_wind_spd != null || o.best_temp != null);
  $('fl-obs-note').textContent = `${met.length} with wind or temperature`;
  $('fl-obs-tbody').innerHTML = met.map(([o, i]) => `<tr data-i="${i}">
    <td class="mono">${hhmmss(o.ts)}</td>
    <td class="num mono">${o.altitude != null ? o.altitude.toLocaleString('en-US').replace(/,/g, ' ') : '–'}</td>
    <td class="num mono dim">${o.vert_rate != null ? (o.vert_rate > 0 ? '+' : '') + Math.round(o.vert_rate / 50) * 50 : ''}</td>
    <td><span class="fl-src" style="--c:${srcCol(o.meteo_source)}" title="${esc(SRC_LBL[o.meteo_source] || '')}">${esc(SRC_SHORT[o.meteo_source] || o.meteo_source || '–')}</span></td>
    <td class="num mono">${o.best_wind_spd != null ? String(Math.round(o.best_wind_dir)).padStart(3, '0') + '° ' + Math.round(o.best_wind_spd) : '–'}</td>
    <td class="num mono">${o.best_temp != null ? o.best_temp.toFixed(1) : '–'}</td>
  </tr>`).join('') || '<tr><td colspan="6" class="fl-empty">No wind or temperature stored</td></tr>';
}

// The hovered point: a ring on the map, the line on the series charts, the table row
function highlight(i, from) {
  const o = flDetail?.observations?.[i];
  if (!o) return;
  if (o.lat != null) {
    if (!hoverMk) hoverMk = L.circleMarker([o.lat, o.lon], { radius: 7, color: isLight() ? '#0f172a' : '#fff', weight: 2, fill: false, interactive: false }).addTo(map);
    else hoverMk.setLatLng([o.lat, o.lon]);
  }
  for (const id of ['fl-ts-alt', 'fl-ts-wind', 'fl-ts-temp']) {
    const c = charts[id]; if (!c) continue;
    c.$flCrossX = c.scales.x.getPixelForValue(o.ts); c.draw();
  }
  document.querySelectorAll('#fl-obs-tbody tr.hl').forEach(tr => tr.classList.remove('hl'));
  const tr = document.querySelector(`#fl-obs-tbody tr[data-i="${i}"]`);
  if (tr) { tr.classList.add('hl'); if (from !== 'table') tr.scrollIntoView({ block: 'nearest' }); }
}

// ── Events ─────────────────────────────────────────────────────────────────
$('fl-tbody').addEventListener('click', ev => {
  if (ev.target.closest('a')) return;
  const tr = ev.target.closest('tr[data-id]');
  if (tr) selectFlight(+tr.dataset.id);
});
$('fl-obs-tbody').addEventListener('mouseover', ev => {
  const tr = ev.target.closest('tr[data-i]');
  if (tr) highlight(+tr.dataset.i, 'table');
});
document.addEventListener('keydown', ev => {
  if (ev.target.matches('input, select, textarea') || !flRows.length) return;
  if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
  const i = flRows.findIndex(f => f.id === flSel);
  const n = Math.max(0, Math.min(flRows.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)));
  if (n !== i) { selectFlight(flRows[n].id); document.querySelector(`#fl-tbody tr[data-id="${flRows[n].id}"]`)?.scrollIntoView({ block: 'nearest' }); }
  ev.preventDefault();
});
function segInit(id, attr, cur, fn) {
  const box = $(id);
  box.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset[attr] === String(cur)));
  box.addEventListener('click', ev => {
    const b = ev.target.closest('button'); if (!b) return;
    box.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    fn(b.dataset[attr]);
  });
}
segInit('fl-period', 'h', flView.h, v => { flView.h = +v; flDate = null; $('fl-date').value = ''; flPage = 1; saveView(); loadList(); });
segInit('fl-kind', 'k', flView.kind, v => { flView.kind = v; flPage = 1; saveView(); loadList(); });
segInit('fl-map-col', 'c', flView.col, v => { flView.col = v; saveView(); if (flDetail) renderMap(); });
$('fl-barbs-btn').classList.toggle('active', !!flView.barbs);
$('fl-barbs-btn').addEventListener('click', () => {
  flView.barbs = !flView.barbs; saveView();
  $('fl-barbs-btn').classList.toggle('active', flView.barbs);
  if (flDetail) renderMap();
});
$('fl-prev').addEventListener('click', () => { if (flPage > 1) { flPage--; loadList(); $('fl-list-scroll').scrollTop = 0; } });
$('fl-next').addEventListener('click', () => { flPage++; loadList(); $('fl-list-scroll').scrollTop = 0; });

let qTimer = null;
$('fl-q').addEventListener('input', () => {
  $('fl-q-clear').hidden = !$('fl-q').value;
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { flQ = $('fl-q').value.trim().toUpperCase(); flPage = 1; loadList(); }, 400);
});
$('fl-q').addEventListener('keydown', ev => {
  if (ev.key === 'Escape') { $('fl-q').value = ''; $('fl-q').dispatchEvent(new Event('input')); }
});
$('fl-q-clear').addEventListener('click', () => { $('fl-q').value = ''; $('fl-q').dispatchEvent(new Event('input')); $('fl-q').focus(); });

// One UTC day: dd.mm.yyyy typed, or the calendar
function setDate(iso) {
  flDate = iso; flPage = 1;
  document.querySelectorAll('#fl-period button').forEach(b => b.classList.toggle('active', !iso && +b.dataset.h === flView.h));
  loadList();
}
$('fl-date').addEventListener('keydown', ev => {
  if (ev.key !== 'Enter') return;
  const m = $('fl-date').value.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) setDate(`${m[3]}-${pad2(m[2])}-${pad2(m[1])}`);
  else if (!$('fl-date').value.trim()) setDate(null);
});
$('fl-cal-btn').addEventListener('click', () => { const p = $('fl-date-picker'); try { p.showPicker(); } catch (_) { p.click(); } });
$('fl-date-picker').addEventListener('change', ev => {
  const v = ev.target.value; if (!v) return;
  $('fl-date').value = v.split('-').reverse().join('.');
  setDate(v);
});
$('fl-btn-link').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(location.origin + '/flights?id=' + flSel); $('fl-btn-link').textContent = 'Copied'; }
  catch (_) { $('fl-btn-link').textContent = 'Link: /flights?id=' + flSel; }
  setTimeout(() => { $('fl-btn-link').textContent = 'Link'; }, 2000);
});

window.onThemeChange = function () {
  if (map) setTiles();
  if (flDetail) { renderMap(); renderProfile(); renderSeries(); }
};

// The list follows the newest flights (every minute, on the first page, while visible)
setInterval(() => { if (!document.hidden && flPage === 1 && !flDate) loadList(true); }, 60000);

// A link /flights?id=N opens that flight
(function start() {
  const id = parseInt(new URLSearchParams(location.search).get('id'), 10);
  if (id > 0) loadList(true).then(() => selectFlight(id));
  else loadList();
})();
