/**
 * weather.js — the Weather page: MEPS surface maps with a time slider.
 *
 * /api/weather/index lists the stored model hours (collector/meps.py kind
 * "wx": 7 days of history and the newest forecast up to +48 h);
 * /api/weather/frames brings the fields of chosen hours on a 20 km (or
 * 10 km) grid in the model's Lambert projection.  The page draws them on a
 * canvas over the Leaflet map:
 *   clouds   — grey, denser with more total cloud cover
 *   rain     — the rain of the hour ending at the shown time, radar-like
 *              colours by intensity; snow (at least half of it) in violet
 *   pressure — isobars every 4 hPa (marching squares on the smoothed field)
 *              with labels, highs H and lows L with their central pressure
 * The slider steps hour by hour from the chosen past to the end of the
 * forecast; ▶ animates.  Frames are loaded in chunks, the ones near the
 * slider first, and kept while the grid stays the same.
 */
'use strict';

// ── MEPS Lambert projection (as collector/meps.py) ────────────────────────
const LCC = (() => {
  const R = 6371000, lat1 = 63.3 * Math.PI / 180, lon0 = 15;
  const n = Math.sin(lat1);
  const F = Math.cos(lat1) * Math.pow(Math.tan(Math.PI / 4 + lat1 / 2), n) / n;
  const rho0 = R * F / Math.pow(Math.tan(Math.PI / 4 + lat1 / 2), n);
  return {
    xy(lat, lon) {
      const rho = R * F / Math.pow(Math.tan(Math.PI / 4 + lat * Math.PI / 360), n);
      const th = n * (lon - lon0) * Math.PI / 180;
      return [rho * Math.sin(th), rho0 - rho * Math.cos(th)];
    },
    latlon(x, y) {
      const rho = Math.sign(n) * Math.hypot(x, rho0 - y);
      const th = Math.atan2(x, rho0 - y);
      return [(2 * Math.atan(Math.pow(R * F / rho, 1 / n)) - Math.PI / 2) * 180 / Math.PI, lon0 + th / n * 180 / Math.PI];
    },
  };
})();

// ── Map ───────────────────────────────────────────────────────────────────
const map = L.map('wx-map', { zoomControl: true }).setView([RECEIVER_LAT, RECEIVER_LON], 5);
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

// ── Colours ───────────────────────────────────────────────────────────────
const RAIN_T = [0.1, 0.5, 1, 2, 5, 10];                                    // mm / h
const RAIN_C = ['#7dd3fc', '#3b82f6', '#22c55e', '#facc15', '#ef4444', '#ec4899'];
const SNOW_C = ['#ede9fe', '#ddd6fe', '#c4b5fd', '#a78bfa', '#8b5cf6', '#d946ef'];
const rainClass = mm => { let k = -1; for (let i = 0; i < RAIN_T.length; i++) if (mm >= RAIN_T[i]) k = i; return k; };
const theme = () => isLight()
  ? { iso: 'rgba(30,41,59,0.85)', isoLbl: '#1e293b', halo: 'rgba(241,245,249,0.9)', hi: '#1d4ed8', lo: '#b91c1c', cloud: '71,85,105' }
  : { iso: 'rgba(226,232,240,0.8)', isoLbl: '#e2e8f0', halo: 'rgba(15,25,35,0.85)', hi: '#60a5fa', lo: '#f87171', cloud: '226,232,240' };

// ── Settings ──────────────────────────────────────────────────────────────
const SKEY = 'ms_weather';
const S_IDS = ['wx-pres', 'wx-rain', 'wx-cloud', 'wx-past', 'wx-fc', 'wx-step'];
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

// ── Canvas layer ──────────────────────────────────────────────────────────
// Cells are drawn opaque on an offscreen canvas (fill + a hairline stroke, so
// the anti-aliased edges of neighbouring cells leave no seams) and then laid
// over the map with transparency; clouds go through the red channel → alpha.
const canvas = L.DomUtil.create('canvas', 'wx-canvas');
const off = document.createElement('canvas');
map.getPanes().overlayPane.appendChild(canvas);
function placeCanvas() {
  const size = map.getSize(), dpr = window.devicePixelRatio || 1;
  L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
  canvas.width = Math.round(size.x * dpr); canvas.height = Math.round(size.y * dpr);
  canvas.style.width = size.x + 'px'; canvas.style.height = size.y + 'px';
  off.width = canvas.width; off.height = canvas.height;
  draw();
}
map.on('zoomstart', () => { canvas.style.visibility = 'hidden'; });
map.on('zoomend moveend resize', () => { canvas.style.visibility = ''; placeCanvas(); });

// ── Data ──────────────────────────────────────────────────────────────────
let hours = [];            // [[ts, run, lead]] stored
let view = [];             // the hours of the slider
let grid = null;           // {x:[x0,dx,nx], y:[y0,dy,ny]} of the loaded frames
let geo = null;            // lat/lon of the points and the cell corners
const frames = new Map();  // ts → frame (for the current step)
let loadedStep = null;
let loadRun = 0;

function buildGeo(g) {
  const [x0, dx, nx] = g.x, [y0, dy, ny] = g.y;
  const pts = [], cor = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) pts.push(LCC.latlon(x0 + i * dx, y0 + j * dy));
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) cor.push(LCC.latlon(x0 + (i - 0.5) * dx, y0 + (j - 0.5) * dy));
  return { nx, ny, pts, cor };
}

async function loadIndex() {
  const r = await fetch('/api/weather/index', { cache: 'no-store' });
  const d = await r.json();
  hours = d.hours || [];
  buildView();
}

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
}
function presentIndex() {
  const now = nowTs();
  let k = 0;
  view.forEach((h, i) => { if (h[0] <= now) k = i; });
  return k;
}

async function loadFrames() {
  const step = parseInt($('wx-step').value, 10);
  if (loadedStep !== step) { frames.clear(); loadedStep = step; grid = null; geo = null; }
  const run = ++loadRun;
  const cur = parseInt($('wx-t').value, 10);
  const need = view.map((h, i) => ({ h, i })).filter(o => {
    const f = frames.get(o.h[0]);
    return !f || f.run !== o.h[1] || f.lead !== o.h[2];
  }).sort((a, b) => Math.abs(a.i - cur) - Math.abs(b.i - cur));
  for (let k = 0; k < need.length; k += 12) {
    if (run !== loadRun) return;
    const ts = need.slice(k, k + 12).map(o => o.h[0]).sort((a, b) => a - b);
    try {
      const d = await (await fetch(`/api/weather/frames?ts=${ts.join(',')}&step=${step}`)).json();
      if (run !== loadRun) return;
      if (d.grid && (!grid || JSON.stringify(d.grid) !== JSON.stringify(grid))) {
        if (grid) frames.clear();
        grid = d.grid; geo = buildGeo(grid);
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
    el.children[i].className = (f && f.run === h[1] && f.lead === h[2] ? 'ok' : '') + (h[0] > now ? ' fc' : '');
  });
}

// ── Drawing ───────────────────────────────────────────────────────────────
let current = null;        // the frame shown
function showFrame() {
  const k = parseInt($('wx-t').value, 10);
  const h = view[k];
  updateLabel(h);
  if (!h) {
    current = null; draw();
    $('wx-status').textContent = hours.length ? 'No model hours in the chosen period.' :
      'No weather maps stored yet — they arrive with the next MEPS runs (fetched every 3 h, about 2–3 h after each run).';
    return;
  }
  const f = frames.get(h[0]);
  if (!f) { $('wx-status').textContent = 'Loading…'; return; }
  current = f;
  draw();
  statusLine(f);
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
function statusLine(f) {
  const r = new Date(f.run * 1000), t = new Date(f.ts * 1000);
  const loaded = view.filter(h => frames.has(h[0])).length;
  $('wx-status').textContent =
    `MEPS ${r.getUTCDate()}.${r.getUTCMonth() + 1}. ${pad2(r.getUTCHours())} UTC run +${f.lead} h` +
    ` · rain / snow of the hour ${pad2((t.getUTCHours() + 23) % 24)}–${pad2(t.getUTCHours())} UTC` +
    ` · grid ${grid ? Math.round(grid.x[1] / 1000) : '—'} km · ${loaded} / ${view.length} hours loaded · MET Norway, CC BY 4.0`;
}

function smooth(v, nx, ny, r) {
  if (r <= 0) return v;
  const out = new Array(v.length);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let s = 0, n = 0;
    for (let b = Math.max(0, j - r); b <= Math.min(ny - 1, j + r); b++)
      for (let a = Math.max(0, i - r); a <= Math.min(nx - 1, i + r); a++) {
        const x = v[b * nx + a]; if (x != null) { s += x; n++; }
      }
    out[j * nx + i] = n ? s / n : null;
  }
  return out;
}

function draw() {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!current || !geo) { renderLegend(); return; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const T = theme(), { nx, ny } = geo;
  const P = ll => map.latLngToContainerPoint(ll);
  const cor = geo.cor.map(P);
  const o = off.getContext('2d');
  const quad = (i, j, col) => {
    const a = cor[j * (nx + 1) + i], b = cor[j * (nx + 1) + i + 1], c = cor[(j + 1) * (nx + 1) + i + 1], d = cor[(j + 1) * (nx + 1) + i];
    o.fillStyle = o.strokeStyle = col;
    o.beginPath(); o.moveTo(a.x, a.y); o.lineTo(b.x, b.y); o.lineTo(c.x, c.y); o.lineTo(d.x, d.y); o.closePath();
    o.fill(); o.stroke();
  };
  const layer = (alpha) => {                 // the offscreen cells onto the map canvas
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha; ctx.drawImage(off, 0, 0); ctx.globalAlpha = 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const begin = () => { o.setTransform(1, 0, 0, 1, 0, 0); o.clearRect(0, 0, off.width, off.height); o.setTransform(dpr, 0, 0, dpr, 0, 0); o.lineWidth = 0.8; };
  const f = current;
  // clouds: grey value = cover, then red → alpha
  if ($('wx-cloud').checked && f.c) {
    begin();
    let any = false;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = f.c[j * nx + i];
      if (c == null || c < 15) continue;
      const v = Math.round(255 * c / 100);
      quad(i, j, `rgb(${v},${v},${v})`); any = true;
    }
    if (any) {
      const img = o.getImageData(0, 0, off.width, off.height), px = img.data;
      const [cr, cg, cb] = T.cloud.split(',').map(Number);
      for (let q = 0; q < px.length; q += 4) {
        const a = px[q + 3] ? px[q] * 0.38 * px[q + 3] / 255 : 0;
        px[q] = cr; px[q + 1] = cg; px[q + 2] = cb; px[q + 3] = a;
      }
      o.putImageData(img, 0, 0);
      layer(1);
    }
  }
  // rain / snow
  if ($('wx-rain').checked && f.r) {
    begin();
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i, r = f.r[k];
      if (r == null || r < 10) continue;
      const cl = rainClass(r / 100);
      if (cl < 0) continue;
      const snow = f.s && f.s[k] != null && f.s[k] >= 0.5 * r;
      quad(i, j, (snow ? SNOW_C : RAIN_C)[cl]);
    }
    layer(0.72);
  }
  // pressure
  if ($('wx-pres').checked && f.p) drawPressure(ctx, f, T, P);
  renderLegend();
}

function drawPressure(ctx, f, T, P) {
  const { nx, ny } = geo;
  const km = grid.x[1] / 1000;
  if (!f._p) {                               // smoothed fields, once per frame
    f._p = smooth(f.p.map(v => v == null ? null : 1000 + v / 10), nx, ny, Math.max(1, Math.round(30 / km)));
    f._ps = smooth(f._p, nx, ny, Math.max(1, Math.round(60 / km)));
  }
  const p = f._p, ps = f._ps;
  const pts = geo.pts.map(P);
  let lo = Infinity, hi = -Infinity;
  for (const v of p) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (!isFinite(lo)) return;
  const levels = [];
  for (let L = Math.ceil(lo / 4) * 4; L <= hi; L += 4) levels.push(L);
  const W = canvas.width / (window.devicePixelRatio || 1), H = canvas.height / (window.devicePixelRatio || 1);
  const labels = [];
  ctx.strokeStyle = T.iso;
  for (const L of levels) {
    ctx.lineWidth = L === 1000 ? 1.9 : 1.1;
    ctx.beginPath();
    const mids = [];
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const ia = j * nx + i, ib = ia + 1, ic = ia + nx + 1, id = ia + nx;
      const va = p[ia], vb = p[ib], vc = p[ic], vd = p[id];
      if (va == null || vb == null || vc == null || vd == null) continue;
      const cut = [];
      const edge = (v1, v2, k1, k2) => {
        if ((v1 - L) * (v2 - L) < 0) {
          const t = (L - v1) / (v2 - v1), A = pts[k1], B = pts[k2];
          cut.push([A.x + (B.x - A.x) * t, A.y + (B.y - A.y) * t]);
        }
      };
      edge(va, vb, ia, ib); edge(vb, vc, ib, ic); edge(vc, vd, ic, id); edge(vd, va, id, ia);
      if (cut.length === 2) {
        ctx.moveTo(cut[0][0], cut[0][1]); ctx.lineTo(cut[1][0], cut[1][1]);
        mids.push([(cut[0][0] + cut[1][0]) / 2, (cut[0][1] + cut[1][1]) / 2]);
      } else if (cut.length === 4) {
        const centre = (va + vb + vc + vd) / 4;
        const pairs = (centre - L) * (va - L) > 0 ? [[0, 3], [1, 2]] : [[0, 1], [2, 3]];
        for (const [m, n] of pairs) { ctx.moveTo(cut[m][0], cut[m][1]); ctx.lineTo(cut[n][0], cut[n][1]); }
      }
    }
    ctx.stroke();
    // labels: spread along the line, inside the view
    let placed = 0;
    for (let q = 0; q < mids.length && placed < 4; q += 7) {
      const [x, y] = mids[q];
      if (x < 30 || y < 20 || x > W - 30 || y > H - 20) continue;
      if (labels.some(l => Math.hypot(l[0] - x, l[1] - y) < (l[2] === L ? 260 : 55))) continue;
      labels.push([x, y, L]); placed++;
    }
  }
  ctx.font = 'bold 10px "Courier New", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const [x, y, L] of labels) {
    ctx.lineWidth = 3; ctx.strokeStyle = T.halo; ctx.strokeText(String(L), x, y);
    ctx.fillStyle = T.isoLbl; ctx.fillText(String(L), x, y);
  }
  // highs and lows on a smoother field: extreme within ~250 km, at least 1 hPa from the ring around
  const R = Math.max(3, Math.round(250 / km)), E = Math.max(2, Math.round(40 / km));
  const marks = f._marks || [];
  if (!f._marks) for (let j = E; j < ny - E; j++) for (let i = E; i < nx - E; i++) {
    const v = ps[j * nx + i];
    if (v == null) continue;
    let lmin = true, lmax = true;                 // a local extreme of its 3 × 3 neighbours first
    for (let b = j - 1; b <= j + 1; b++) for (let a = i - 1; a <= i + 1; a++) {
      const w = ps[b * nx + a];
      if (w == null || (a === i && b === j)) continue;
      if (w <= v) lmin = false;
      if (w >= v) lmax = false;
    }
    if (!lmin && !lmax) continue;
    let isMin = true, isMax = true, ring = 0, rn = 0;
    for (let b = Math.max(0, j - R); b <= Math.min(ny - 1, j + R) && (isMin || isMax); b++)
      for (let a = Math.max(0, i - R); a <= Math.min(nx - 1, i + R); a++) {
        const w = ps[b * nx + a];
        if (w == null || (a === i && b === j)) continue;
        if (w < v || (w === v && b * nx + a < j * nx + i)) isMin = false;
        if (w > v || (w === v && b * nx + a < j * nx + i)) isMax = false;
        if (Math.max(Math.abs(a - i), Math.abs(b - j)) === R) { ring += w; rn++; }
      }
    if (!(isMin || isMax) || !rn) continue;
    const dpth = v - ring / rn;
    if (isMin && dpth <= -1) marks.push({ i, j, t: 'L', v: p[j * nx + i] });
    if (isMax && dpth >= 1) marks.push({ i, j, t: 'H', v: p[j * nx + i] });
  }
  f._marks = marks;
  for (const m of marks) {
    const q = pts[m.j * nx + m.i];
    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.lineWidth = 4; ctx.strokeStyle = T.halo; ctx.strokeText(m.t, q.x, q.y - 6);
    ctx.fillStyle = m.t === 'H' ? T.hi : T.lo; ctx.fillText(m.t, q.x, q.y - 6);
    ctx.font = 'bold 11px "Courier New", monospace';
    const txt = String(Math.round(m.v));
    ctx.lineWidth = 3; ctx.strokeText(txt, q.x, q.y + 12); ctx.fillText(txt, q.x, q.y + 12);
  }
}

function renderLegend() {
  const parts = [];
  if ($('wx-rain').checked) {
    const key = (c, t) => `<span class="wx-key" style="background:${c}"></span> ${t}`;
    parts.push('rain ' + RAIN_C.map((c, i) => key(c, RAIN_T[i])).join(' ') + ' mm/h');
    parts.push('snow ' + SNOW_C.map(c => `<span class="wx-key" style="background:${c}"></span>`).join(''));
  }
  if ($('wx-pres').checked) parts.push('isobars every 4 hPa · <b style="color:' + theme().hi + '">H</b> high · <b style="color:' + theme().lo + '">L</b> low');
  if ($('wx-cloud').checked) parts.push('grey: cloud cover');
  const el = $('wx-legend');
  el.innerHTML = parts.join(' &nbsp;·&nbsp; ');
  el.classList.toggle('wm-hidden', !parts.length);
}

// ── Hover read-out ────────────────────────────────────────────────────────
map.on('mousemove', e => {
  const ro = $('wx-readout');
  if (!current || !grid) { ro.classList.add('wm-hidden'); return; }
  const [x, y] = LCC.xy(e.latlng.lat, e.latlng.lng);
  const i = Math.round((x - grid.x[0]) / grid.x[1]), j = Math.round((y - grid.y[0]) / grid.y[1]);
  if (i < 0 || j < 0 || i >= grid.x[2] || j >= grid.y[2]) { ro.classList.add('wm-hidden'); return; }
  const k = j * grid.x[2] + i, f = current;
  const parts = [`${e.latlng.lat.toFixed(2)}°N ${e.latlng.lng.toFixed(2)}°E`];
  if (f.p && f.p[k] != null) parts.push(`${(1000 + f.p[k] / 10).toFixed(1)} hPa`);
  if (f.r && f.r[k] != null) {
    const snow = f.s && f.s[k] != null && f.r[k] > 0 && f.s[k] >= 0.5 * f.r[k];
    parts.push(f.r[k] >= 5 ? `${snow ? 'snow' : 'rain'} ${(f.r[k] / 100).toFixed(1)} mm/h` : 'dry');
  }
  if (f.c && f.c[k] != null) parts.push(`cloud ${f.c[k]} %`);
  ro.textContent = parts.join(' · ');
  ro.classList.remove('wm-hidden');
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
['wx-pres', 'wx-rain', 'wx-cloud'].forEach(id => $(id).addEventListener('change', () => { saveSettings(); draw(); }));
['wx-past', 'wx-fc'].forEach(id => $(id).addEventListener('change', () => { saveSettings(); buildView(); }));
$('wx-step').addEventListener('change', () => { saveSettings(); loadFrames(); });

window.onThemeChange = function () {
  const want = isLight() ? 'light' : 'dark';
  if (want !== tileTheme) {
    map.removeLayer(TILES[tileTheme]); TILES[want].addTo(map); TILES[want].bringToBack(); tileTheme = want;
  }
  draw();
};

// new model runs: look again every 10 min
setInterval(() => { if (!document.hidden && !playing) loadIndex().catch(() => {}); }, 10 * 60 * 1000);

placeCanvas();
renderLegend();
loadIndex().catch(e => { console.error(e); $('wx-status').textContent = 'Error loading the weather map index.'; });
