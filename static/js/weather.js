/**
 * weather.js — the Weather page: MEPS surface maps with a time slider.
 *
 * /api/weather/index lists the stored model hours (collector/meps.py kind
 * "wx": 7 days of history and the newest forecast up to +48 h);
 * /api/weather/frames brings the fields of chosen hours on a 20 km (or
 * 10 km) grid in the model's Lambert projection.  The page draws them on a
 * canvas over the Leaflet map (wx_layer.js, shared with the Live Map):
 *   clouds   — total, low, medium or high cloud (grey) or fog (yellow)
 *   gusts    — the model's 10 m gust, shaded from 25 kt
 *   rain     — the rain of the hour ending at the shown time, radar-like
 *              colours by intensity; snow (at least half of it) in violet
 *   wind     — barbs of the model's 10 m wind
 *   pressure — isobars every 4 hPa (marching squares on the smoothed field)
 *              with labels, highs H and lows L with their central pressure
 * The hover read-out adds the cloud base, the wind and the gust.
 * The slider steps hour by hour from the chosen past to the end of the
 * forecast; ▶ animates.  Frames are loaded in chunks, the ones near the
 * slider first, and kept while the grid stays the same.
 */
'use strict';

// ── Map ───────────────────────────────────────────────────────────────────
// The map view (centre and zoom) is remembered in this browser (from
// 2026-10-28) and the page opens where it was left; the ⌂ button under the
// zoom buttons goes back to the receiver at the default zoom.
function msSavedView(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    if (v && Number.isFinite(v.lat) && Number.isFinite(v.lon) && Number.isFinite(v.z)
        && Math.abs(v.lat) <= 85 && Math.abs(v.lon) <= 180 && v.z >= 3 && v.z <= 18) return v;
  } catch (e) { /* private mode / broken value: the default view */ }
  return null;
}
function msRememberView(map, key, homeZoom) {
  map.on('moveend', () => {
    if (!map.getSize().x) return;                 // hidden map (portrait tablet): nothing to keep
    const c = map.getCenter();
    try {
      localStorage.setItem(key, JSON.stringify({ lat: +c.lat.toFixed(4), lon: +c.lng.toFixed(4), z: map.getZoom() }));
    } catch (e) { /* private mode */ }
  });
  const Home = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const box = L.DomUtil.create('div', 'leaflet-bar ms-map-home');
      const a = L.DomUtil.create('a', '', box);
      a.href = '#';
      a.title = 'Back to the receiver (default view)';
      a.setAttribute('role', 'button');
      a.setAttribute('aria-label', a.title);
      a.innerHTML = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">'
        + '<path d="M2.5 7.5 8 2.5l5.5 5M4 6.6V13.5h3V10h2v3.5h3V6.6" fill="none" stroke="currentColor" '
        + 'stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>';
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.on(a, 'click', e => {
        L.DomEvent.preventDefault(e);
        map.setView([RECEIVER_LAT, RECEIVER_LON], homeZoom);
      });
      return box;
    },
  });
  new Home().addTo(map);
}
const MAP_HOME_ZOOM = 5;
const MAP_VIEW_KEY = 'ms_weatherMapView';
const _savedView = msSavedView(MAP_VIEW_KEY);
const map = L.map('wx-map', { zoomControl: true })
             .setView(_savedView ? [_savedView.lat, _savedView.lon] : [RECEIVER_LAT, RECEIVER_LON],
                      _savedView ? _savedView.z : MAP_HOME_ZOOM);
msRememberView(map, MAP_VIEW_KEY, MAP_HOME_ZOOM);
const _cartoKeyQs = CARTO_API_KEY ? `?key=${encodeURIComponent(CARTO_API_KEY)}` : '';
const TILES = {
  dark:  L.tileLayer(`https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png${_cartoKeyQs}`,
                     { attribution: '© OSM, © CARTO · model MEPS, MET Norway (CC BY 4.0)', subdomains: 'abcd', maxZoom: 12 }),
  light: L.tileLayer(`https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png${_cartoKeyQs}`,
                     { attribution: '© OSM, © CARTO · model MEPS, MET Norway (CC BY 4.0)', subdomains: 'abcd', maxZoom: 12 }),
};
const isLight = () => document.documentElement.dataset.theme === 'light';
let tileTheme = isLight() ? 'light' : 'dark';
TILES[tileTheme].addTo(map);
L.circleMarker([RECEIVER_LAT, RECEIVER_LON], { radius: 5, color: '#fff', fillColor: '#1d4ed8', fillOpacity: 1, weight: 2 })
  .bindTooltip('Receiver').addTo(map);

const $ = id => document.getElementById(id);
const pad2 = n => String(n).padStart(2, '0');
const HOUR = 3600;

// ── Settings ──────────────────────────────────────────────────────────────
const SKEY = 'ms_weather';
const S_IDS = ['wx-pres', 'wx-rain', 'wx-wind', 'wx-gust', 'wx-cloud', 'wx-past', 'wx-fc', 'wx-step', 'wx-fine', 'wx-smooth'];
function saveSettings() {
  const s = {};
  S_IDS.forEach(id => { const el = $(id); s[id] = el.type === 'checkbox' ? el.checked : el.value; });
  try { localStorage.setItem(SKEY, JSON.stringify(s)); } catch (e) { /* private mode */ }
}
(function restore() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(SKEY) || 'null'); } catch (e) { s = null; }
  if (!s) return;
  S_IDS.forEach(id => {
    const el = $(id);
    if (s[id] == null) return;
    if (el.type === 'checkbox') el.checked = !!s[id];
    else if ([...el.options].some(o => o.value === String(s[id]))) el.value = s[id];
  });
})();

// ── Weather layer (wx_layer.js) ───────────────────────────────────────────
const wx = WxLayer.create(map, { pane: 'wxPane', zIndex: 350 });
const cloudKey = () => { const v = $('wx-cloud').value; return v === 'off' ? null : v; };
function layerOptions() {
  return { rain: $('wx-rain').checked, pres: $('wx-pres').checked, clouds: cloudKey() ? [cloudKey()] : [],
           wind: $('wx-wind').checked, gust: $('wx-gust').checked, fine: wx.fineShown(),
           smooth: $('wx-smooth').value !== 'off' };          // Shading: Smooth / Cells (from 2026-10-31)
}
function fieldList() {
  const f = ['p', 'r', 's'], c = cloudKey();
  if (c) f.push(c, 'b');
  if ($('wx-wind').checked) f.push('u', 'v');
  if ($('wx-gust').checked) f.push('g');
  return f.join(',');
}

// ── Data ──────────────────────────────────────────────────────────────────
let hours = [];            // [[ts, run, lead, has wind]] stored
let view = [];             // the hours of the slider
let grid = null;           // {x:[x0,dx,nx], y:[y0,dy,ny]} of the loaded frames
const frames = new Map();  // ts → frame (for the current step and fields)
let loadedKey = null;
let loadRun = 0;

async function loadIndex() {
  const r = await fetch('/api/weather/index', { cache: 'no-store' });
  const d = await r.json();
  hours = d.hours || [];
  fineInfo = d.fine || { hours: [], grid: null };
  fineBox = null;
  buildView();
}

// ── 2.5 km detail (from 31 Oct 2026) ──────────────────────────────────────
// The full MEPS grid in a box around the receiver (/api/weather/index "fine",
// /api/weather/frames?fine=1): loaded and drawn only when Detail is on, the
// map zoomed to FINE_ZOOM or closer and the box in view; an hour of the box
// is used only with the same run as the 10 km hour.
const FINE_ZOOM = 7;
let fineInfo = { hours: [], grid: null }, fineBox = null, fineKey = null, fineRun = 0;
const fineFrames = new Map();
function fineBounds() {
  const g = fineInfo.grid;
  if (!g) return null;
  if (!fineBox) {
    const xs = [g.x[0] - g.x[1] / 2, g.x[0] + (g.x[2] - 0.5) * g.x[1]], ys = [g.y[0] - g.y[1] / 2, g.y[0] + (g.y[2] - 0.5) * g.y[1]];
    fineBox = L.latLngBounds(xs.flatMap(x => ys.map(y => WxLayer.LCC.latlon(x, y))));
  }
  return fineBox;
}
function fineWanted() {
  const b = fineBounds();
  return $('wx-fine').value !== 'off' && !!b && map.getZoom() >= FINE_ZOOM && map.getBounds().intersects(b);
}
async function loadFine() {
  if (!fineWanted()) return;
  const fields = fieldList();
  if (fineKey !== fields) { fineFrames.clear(); fineKey = fields; }
  const run = ++fineRun, cur = parseInt($('wx-t').value, 10);
  const have = new Map(fineInfo.hours.map(h => [h[0], h]));
  const need = view.map((h, i) => ({ h, i, fh: have.get(h[0]) }))
    .filter(o => o.fh && !(fineFrames.get(o.h[0]) && fineFrames.get(o.h[0]).run === o.fh[1] && fineFrames.get(o.h[0]).lead === o.fh[2]))
    .sort((a, b) => Math.abs(a.i - cur) - Math.abs(b.i - cur));
  for (let k = 0; k < need.length; k += 12) {
    if (run !== fineRun || !fineWanted()) return;
    const ts = need.slice(k, k + 12).map(o => o.h[0]).sort((a, b) => a - b);
    try {
      const d = await (await fetch(`/api/weather/frames?ts=${ts.join(',')}&fields=${fields}&fine=1`)).json();
      if (run !== fineRun) return;
      for (const f of d.frames || []) fineFrames.set(f.ts, f);
    } catch (e) { console.error('Weather 2.5 km frames:', e); return; }
    const shown = view[parseInt($('wx-t').value, 10)];
    if (shown && ts.includes(shown[0])) showFrame();
  }
}
// a redraw only when the detail comes or goes (the layer redraws itself on a move)
let fineWas = false;
map.on('zoomend moveend', () => { const w = fineWanted(); if (w !== fineWas) { fineWas = w; showFrame(); } loadFine(); });

function nowTs() { return Math.floor(Date.now() / 1000); }
function buildView(keepTs = null) {
  const now = nowTs();
  const past = parseInt($('wx-past').value, 10) * HOUR, fc = parseInt($('wx-fc').value, 10) * HOUR;
  const cur = keepTs != null ? keepTs : (view.length ? view[parseInt($('wx-t').value, 10)]?.[0] : null);
  view = hours.filter(h => h[0] >= now - past && h[0] <= now + fc);
  const el = $('wx-t');
  el.max = Math.max(0, view.length - 1);
  let k = -1;
  if (cur != null) k = view.findIndex(h => h[0] === cur);
  if (k < 0) k = presentIndex();
  el.value = Math.max(0, k);
  drawLoadStrip();
  loadFrames();
  showFrame();
  loadFine();
}
function presentIndex() {
  const now = nowTs();
  let k = 0;
  view.forEach((h, i) => { if (h[0] <= now) k = i; });
  return k;
}

async function loadFrames() {
  const step = parseInt($('wx-step').value, 10), fields = fieldList();
  if (loadedKey !== step + '|' + fields) { frames.clear(); loadedKey = step + '|' + fields; grid = null; }
  const run = ++loadRun;
  const cur = parseInt($('wx-t').value, 10);
  const need = view.map((h, i) => ({ h, i })).filter(o => {
    const f = frames.get(o.h[0]);
    return !f || f.run !== o.h[1] || f.lead !== o.h[2] || (f.w || 0) !== (o.h[3] || 0);
  }).sort((a, b) => Math.abs(a.i - cur) - Math.abs(b.i - cur));
  for (let k = 0; k < need.length; k += 12) {
    if (run !== loadRun) return;
    const ts = need.slice(k, k + 12).map(o => o.h[0]).sort((a, b) => a - b);
    try {
      const d = await (await fetch(`/api/weather/frames?ts=${ts.join(',')}&step=${step}&fields=${fields}`)).json();
      if (run !== loadRun) return;
      if (d.grid && (!grid || JSON.stringify(d.grid) !== JSON.stringify(grid))) {
        if (grid) frames.clear();
        grid = d.grid;
      }
      for (const f of d.frames || []) frames.set(f.ts, f);
    } catch (e) {
      console.error('Weather frames:', e);
      $('wx-status').textContent = 'Error loading the weather maps.';
      return;
    }
    drawLoadStrip();
    const shown = view[parseInt($('wx-t').value, 10)];
    if (shown && ts.includes(shown[0])) showFrame();
  }
}

function drawLoadStrip() {
  const el = $('wx-tload');
  if (!view.length) { el.classList.add('wm-hidden'); return; }
  el.classList.remove('wm-hidden');
  if (el.children.length !== view.length) el.innerHTML = '<i></i>'.repeat(view.length);
  const now = nowTs();
  view.forEach((h, i) => {
    const f = frames.get(h[0]);
    el.children[i].className = (f && f.run === h[1] && f.lead === h[2] && (f.w || 0) === (h[3] || 0) ? 'ok' : '') + (h[0] > now ? ' fc' : '');
  });
}

// ── Drawing ───────────────────────────────────────────────────────────────
let current = null;        // the frame shown
function showFrame() {
  stepButtons();
  const k = parseInt($('wx-t').value, 10);
  const h = view[k];
  updateLabel(h);
  if (!h) {
    current = null; wx.setFrame(null); renderLegend();
    $('wx-status').textContent = hours.length ? 'No model hours in the chosen period.' :
      'No weather maps stored yet — after a start the first ones arrive within minutes (back-fill), later with each MEPS run (every 3 h, about 2–3 h after it). The page looks again every minute.';
    return;
  }
  const f = frames.get(h[0]);
  if (!f) { $('wx-status').textContent = 'Loading…'; return; }
  current = f;
  const ff = fineWanted() ? fineFrames.get(h[0]) : null;
  wx.setFine(ff && ff.run === f.run ? ff : null, fineInfo.grid, true);
  wx.setFrame(f, grid);
  // hours stored before 24 Oct 2026 have no wind / gust
  const noWind = ($('wx-wind').checked && !f.u) || ($('wx-gust').checked && !f.g);
  renderLegend();
  statusLine(f, noWind);
}
function updateLabel(h) {
  const el = $('wx-tlabel');
  if (!h) { el.textContent = '—'; return; }
  const d = new Date(h[0] * 1000), now = nowTs();
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const rel = Math.round((h[0] - Math.floor(now / HOUR) * HOUR) / HOUR);
  const relTxt = h[0] > now ? `<span class="wx-fc">forecast +${rel} h</span>` : rel === 0 ? 'present hour' : `${rel} h`;
  el.innerHTML = `${wd} ${d.getUTCDate()}.${d.getUTCMonth() + 1}. ${pad2(d.getUTCHours())} UTC · ${relTxt}`;
}
function statusLine(f, noWind = false) {
  const r = new Date(f.run * 1000), t = new Date(f.ts * 1000);
  const loaded = view.filter(h => frames.has(h[0])).length;
  $('wx-status').textContent =
    `MEPS ${r.getUTCDate()}.${r.getUTCMonth() + 1}. ${pad2(r.getUTCHours())} UTC run +${f.lead} h` +
    ` · rain / snow of the hour ${pad2((t.getUTCHours() + 23) % 24)}–${pad2(t.getUTCHours())} UTC` +
    ` · grid ${grid ? Math.round(grid.x[1] / 1000) : '—'} km${wx.fineShown() ? ' (2.5 km near the airport)' : ''} · ${loaded} / ${view.length} hours loaded · MET Norway, CC BY 4.0` +
    (noWind ? ' · no wind stored for this hour (wind from 24 Oct 2026)' : '');
}

function renderLegend() {
  const el = $('wx-legend');
  el.innerHTML = WxLayer.legendHtml(layerOptions());
  el.classList.toggle('wm-hidden', !el.innerHTML);
}

// ── Hover read-out ────────────────────────────────────────────────────────
map.on('mousemove', e => {
  const ro = $('wx-readout');
  const txt = current ? wx.describe(wx.valuesAt(e.latlng), e.latlng) : '';
  ro.textContent = txt;
  ro.classList.toggle('wm-hidden', !txt);
});
map.on('mouseout', () => $('wx-readout').classList.add('wm-hidden'));

// ── Animation and controls ────────────────────────────────────────────────
let playing = false, playRun = 0;
async function play() {
  playing = !playing;
  $('wx-play').textContent = playing ? '■' : '▶';
  if (!playing) return;
  const run = ++playRun;
  const el = $('wx-t');
  while (playing && run === playRun) {
    let v = parseInt(el.value, 10) + 1;
    if (v > parseInt(el.max, 10)) v = 0;
    el.value = v;
    showFrame();
    await new Promise(res => setTimeout(res, frames.has(view[v]?.[0]) ? 400 : 250));
  }
}
$('wx-play').addEventListener('click', play);
$('wx-now').addEventListener('click', () => { $('wx-t').value = presentIndex(); showFrame(); });
$('wx-t').addEventListener('input', showFrame);
// ±1 h buttons (for a mouse; the slider itself takes the arrow keys): stop an
// animation and move one model hour, not past the ends
function stepHour(d) {
  if (playing) play();
  const el = $('wx-t'), v = parseInt(el.value, 10) + d;
  if (v < 0 || v > parseInt(el.max, 10)) return;
  el.value = v;
  showFrame();
}
function stepButtons() {
  const el = $('wx-t'), v = parseInt(el.value, 10), max = parseInt(el.max, 10);
  $('wx-prev').disabled = !view.length || v <= 0;
  $('wx-next').disabled = !view.length || v >= max;
}
$('wx-prev').addEventListener('click', () => stepHour(-1));
$('wx-next').addEventListener('click', () => stepHour(1));
['wx-pres', 'wx-rain'].forEach(id => $(id).addEventListener('change', () => { saveSettings(); wx.setOptions(layerOptions()); renderLegend(); }));
['wx-cloud', 'wx-wind', 'wx-gust'].forEach(id => $(id).addEventListener('change', () => {
  saveSettings(); wx.setOptions(layerOptions()); renderLegend(); loadFrames(); loadFine();
}));
$('wx-fine').addEventListener('change', () => { saveSettings(); showFrame(); loadFine(); });
$('wx-smooth').addEventListener('change', () => { saveSettings(); wx.setOptions(layerOptions()); });
['wx-past', 'wx-fc'].forEach(id => $(id).addEventListener('change', () => { saveSettings(); buildView(); }));
$('wx-step').addEventListener('change', () => { saveSettings(); loadFrames(); });

window.onThemeChange = function () {
  const want = isLight() ? 'light' : 'dark';
  if (want !== tileTheme) {
    map.removeLayer(TILES[tileTheme]); TILES[want].addTo(map); TILES[want].bringToBack(); tileTheme = want;
  }
  wx.redraw(); renderLegend();
};

// new model runs: look again every 10 min — every minute while nothing (or only a little) is stored
let lastIndex = Date.now();
setInterval(() => {
  if (document.hidden || playing) return;
  const sparse = hours.length < 12;
  if (sparse || Date.now() - lastIndex >= 10 * 60 * 1000) { lastIndex = Date.now(); loadIndex().catch(() => {}); }
}, 60 * 1000);

wx.setOptions(layerOptions());
renderLegend();
loadIndex().catch(e => { console.error(e); $('wx-status').textContent = 'Error loading the weather map index.'; });
