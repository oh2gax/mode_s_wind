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
const MAP_HOME_ZOOM = 8;
const MAP_VIEW_KEY = 'ms_liveMapView';
const _savedView = msSavedView(MAP_VIEW_KEY);
const map = L.map('map', { zoomControl: true })
             .setView(_savedView ? [_savedView.lat, _savedView.lon] : [RECEIVER_LAT, RECEIVER_LON],
                      _savedView ? _savedView.z : MAP_HOME_ZOOM);
msRememberView(map, MAP_VIEW_KEY, MAP_HOME_ZOOM);
// The map is hidden on a portrait tablet and its size follows the Skew-T
// panel width: let Leaflet re-measure whenever its container changes size
new ResizeObserver(() => map.invalidateSize()).observe(document.getElementById('map'));

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

// Receiver marker (hidden in the ATC style)
const receiverMarker = L.circleMarker([RECEIVER_LAT, RECEIVER_LON], {
  radius: 7, color: '#fff', fillColor: '#1d4ed8', fillOpacity: 1, weight: 2,
}).bindTooltip('Receiver (EFHK area)').addTo(map);

// ── State ─────────────────────────────────────────────────────────────────
const markers        = {};   // icao → L.Marker (aircraft symbol)
const trails         = {};   // icao → [[lat, lon, ts], ...] history plots (one per ~6 s)
const labelMarkers   = {};   // icao → L.Marker (callsign label)
const windArrows     = {};   // icao → L.Polyline (wind direction arrow)
const aircraftData   = {};   // icao → latest data object
const callsignCache  = {};   // icao → best known callsign (never downgraded to null)
const windHistory    = {};   // icao → [{pressure, alt_ft, temp_c, wind_spd, wind_dir}, ...]
const dbSeeded       = new Set(); // ICAOs whose wind history has been pre-loaded from DB

let selectedIcao = null;

const MAX_TRAIL       = 40;   // history plots kept ≈ 4 min (Hist shows up to 20)
const MAX_WIND_HIST   = 80;   // wind obs per aircraft (≈ climb/descent profile)

// Restore persisted UI prefs — default both toggles ON
// localStorage.getItem returns null when key is absent; null !== 'false' → true (default ON)
let meteoOnly   = localStorage.getItem('ms_meteoOnly')  !== 'false';
let showTrack   = localStorage.getItem('ms_showTrack')  === 'true';   // default OFF
// Map labels (from 2026-10-30; before a Labels tick box and a Callsign /
// Registration / ICAO24 menu): one button steps the levels, as the Windshear
// map's Lbl button — ATC-style labels (callsign over the altitude).
const LBL_STEPS = ['off', 'cs', 'reg', 'icao', 'type', 'alt', 'type+', 'full'];
const LBL_NAME  = { off: 'Off', cs: 'CS', reg: 'Reg', icao: 'ICAO24', type: 'Type', alt: 'CS+Alt', 'type+': '+Type', full: 'Full' };
let lblLvl = (() => {
  const v = localStorage.getItem('ms_liveLbl');
  if (LBL_STEPS.includes(v)) return v;
  if (localStorage.getItem('ms_showLabels') === 'false') return 'off';     // the old settings
  const m = localStorage.getItem('ms_labelMode');
  return m === 'icao' ? 'icao' : m === 'reg' ? 'reg' : 'alt';
})();
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
let anaSrc      = localStorage.getItem('ms_skewtAnaSrc') || 'modes';   // analysis of: modes / meps / sonde (shared with the Sounding page)
if (!['modes', 'meps', 'sonde'].includes(anaSrc)) anaSrc = 'modes';
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
  if (lblLvl === 'icao') return ac.icao;
  if (lblLvl === 'reg')  return ac.registration || callsignCache[ac.icao] || ac.icao;
  return callsignCache[ac.icao] || ac.callsign || ac.icao;
}

// The altitude as on a controller's radar label (as the Windshear map): up to
// the transition altitude 5 000 ft A + hundreds of feet on the METAR QNH, above
// it the flight level; without a QNH the pressure altitude.
function liveAtcAlt(pa) {
  if (pa == null) return '—';
  const qnh = miniSfc && miniSfc.qnh ? miniSfc.qnh : 1013.25;
  const alt = pa - (1013.25 - qnh) * 27;
  return alt <= 5000 ? 'A' + String(Math.max(0, Math.round(alt / 100))).padStart(3, '0')
                     : 'FL' + String(Math.round(pa / 100)).padStart(3, '0');
}
// The label of one aircraft at the current level ('' = none)
function liveLabelHtml(ac) {
  const lv = lblLvl;
  if (lv === 'off') return '';
  const cs = esc(callsignCache[ac.icao] || ac.callsign || ac.icao);
  const ty = esc(ac.aircraft_type || '');
  if (lv === 'cs')   return cs;
  if (lv === 'reg')  return esc(ac.registration || callsignCache[ac.icao] || ac.icao);
  if (lv === 'icao') return esc(ac.icao);
  if (lv === 'type') return ty || '<span class="ac-lbl-notype">—</span>';
  const vr = ac.vert_rate, tr = vr == null ? '' : vr >= 300 ? '↑' : vr <= -300 ? '↓' : '';
  const sel = lv === 'full' ? selAltTxt(ac) : '';    // as in the list: A023+A050, FL120-A030, FL061-FL070, FL390=FL390
  const l2 = ac.landed ? 'landed' : liveAtcAlt(ac.altitude) + (sel || tr);
  return cs + ((lv === 'type+' || lv === 'full') && ty ? ` <span class="ac-lbl-type">${ty}</span>` : '') + `<small>${l2}</small>`;
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
let rhShow       = localStorage.getItem('ms_skewtRH') === 'true';   // RH strip (trial moisture indicator)

async function fetchMiniArea() {
  try {
    const r = await fetch('/api/sounding?minutes=60' + (rhShow ? '&moist=1' : ''));
    if (!r.ok) return;
    miniArea = await r.json();
    drawMiniSounding();
  } catch (_) { /* silent */ }
  fetchMiniLow();
}

// ── Radiosonde (Jokioinen, /api/sonde) — 'Sonde' tick box, default off ─────
let sondeShow = localStorage.getItem('ms_skewtSonde') === 'true';
let miniSonde = null;  // /api/sonde response (found: false → "no sounding" note)
// Polled every 2 min and when the page becomes visible again (browsers pause
// timers in background tabs); the server answers "unchanged" while the shown
// copy (key and raw level count) is still the newest, so polling stays light.
async function fetchMiniSonde() {
  if (!sondeShow) { miniSonde = null; return; }
  try {
    const have = miniSonde && miniSonde.found && miniSonde.key ? `?have=${miniSonde.key}:${miniSonde.n_raw}` : '';
    const r = await fetch('/api/sonde' + have, { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    if (d.unchanged) return;
    miniSonde = d;
    drawMiniSounding();
  } catch (_) { /* silent */ }
}

// ── MEPS model profile (/api/meps/profile, now) — 'MEPS' tick box, default off
// The newest model hours are a forecast of up to +5 h; the time moves on, so
// it is fetched again every 10 min (one small request).
let mepsShow = localStorage.getItem('ms_skewtMeps') === 'true';
let miniMeps = null;
async function fetchMiniMeps() {
  if (!mepsShow) { miniMeps = null; return; }
  try {
    const r = await fetch('/api/meps/profile', { cache: 'no-store' });
    if (!r.ok) return;
    miniMeps = await r.json();
    drawMiniSounding();
  } catch (_) { /* silent */ }
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
    area: miniArea, low: miniLow, aptMode, anaLevel, anaSrc, smooth: areaSmooth, sfc: miniSfc,
    ac: miniAcOverlay, density: windDensity,
    acLabel: (selectedIcao && getLabelText(aircraftData[selectedIcao] || {})) || 'Aircraft',
    profileTitle: 'Area, last ' + (miniArea ? miniArea.window_min : 60) + ' min',
    hint: null, dq: dqShow, sonde: sondeShow ? miniSonde : null, sondeRef: null,
    meps: mepsShow ? miniMeps : null,
    rh: rhShow, moist: rhShow && miniArea ? miniArea.moisture || null : null,
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

// ── Aircraft symbol (from 2026-10-30, as the Windshear map) ──────────────
// An open square in the meteo-source colour, as on a controller's radar
// display; the selected aircraft a slightly larger square in white (near-black
// in the Light theme).  The heading stick of the earlier filled square is gone:
// the direction shows in the history plots and, when on, the speed vector.
const selSymColor = () => document.documentElement.dataset.theme === 'light' ? '#0f172a' : '#ffffff';
function makeIcon(color, selected) {
  const s = selected ? 9 : 8, H = 22, o = (H - s) / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${H}" height="${H}" viewBox="0 0 ${H} ${H}">
    <rect x="${o}" y="${o}" width="${s}" height="${s}" rx="1" fill="none"
          stroke="${selected ? selColorNow() : color}" stroke-width="${selected ? 1.4 : 1.5}"/></svg>`;
  return L.divIcon({ html: svg, className: '', iconSize: [H, H], iconAnchor: [H / 2, H / 2] });
}

// ── History plots and speed vectors (from 2026-10-30) ─────────────────────
// History plots as on a radar display: small filled squares at the earlier
// positions, one per ~6 s (every second stream update), older ones fainter.
// The Hist button: Off · 5 · 10 · 20 plots (30 s · 1 min · 2 min).  The Vec
// button: the speed vector, where the aircraft is in 30 s · 1 min · 2 min at
// its ground speed and track (as the Windshear map).  All plots and vectors are
// drawn on one canvas layer, not as a map object each (100 aircraft × 20 plots).
const HIST_STEPS   = [0, 5, 10, 20];
const VEC_STEPS    = [0, 30, 60, 120];
const HIST_EVERY_S = 5;          // a plot kept when ≥ 5 s after the previous (stream every 3 s → ~6 s)
const lsInt = (k, steps, dflt) => {
  try { const v = parseInt(localStorage.getItem(k), 10); return steps.includes(v) ? v : dflt; }
  catch (_) { return dflt; }
};
let histN = lsInt('ms_liveHist', HIST_STEPS, 5);
let vecS  = lsInt('ms_liveVec',  VEC_STEPS,  0);

function updateTrail(icao, lat, lon, ts) {
  if (!trails[icao]) trails[icao] = [];
  const t    = trails[icao];
  const last = t[t.length - 1];
  if (last && ts - last[2] < HIST_EVERY_S) return;
  if (last && Math.abs(last[0] - lat) < 1e-5 && Math.abs(last[1] - lon) < 1e-5) return;  // standing still
  t.push([lat, lon, ts]);
  if (t.length > MAX_TRAIL) t.shift();
}

// The point sec seconds ahead along the track at the ground speed (great circle)
function vecEnd(lat, lon, trackDeg, gsKt, sec) {
  const d = gsKt * sec / 3600 * 1852 / 6371000, br = trackDeg * Math.PI / 180;
  const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(br));
  const lo2 = lo + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return [la2 * 180 / Math.PI, lo2 * 180 / Math.PI];
}

const PlotLayer = L.Layer.extend({
  onAdd(m) {
    this._c = L.DomUtil.create('canvas', 'live-plot-layer');
    m.getPane('livePlots').appendChild(this._c);
    m.on('moveend zoomend resize viewreset', this._reset, this);
    m.on('zoomstart', this._hide, this);
    this._reset();
  },
  onRemove(m) {
    m.off('moveend zoomend resize viewreset', this._reset, this);
    m.off('zoomstart', this._hide, this);
    this._c.remove();
  },
  _hide() { this._c.style.visibility = 'hidden'; },
  _reset() {
    const m = this._map, sz = m.getSize(), dpr = window.devicePixelRatio || 1;
    L.DomUtil.setPosition(this._c, m.containerPointToLayerPoint([0, 0]));
    this._c.width  = Math.round(sz.x * dpr);
    this._c.height = Math.round(sz.y * dpr);
    this._c.style.width  = sz.x + 'px';
    this._c.style.height = sz.y + 'px';
    this._c.style.visibility = '';
    this.redraw();
  },
  redraw() {
    if (!this._map) return;
    const c = this._c, g = c.getContext('2d'), m = this._map, dpr = window.devicePixelRatio || 1;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    const atc = liveStyle === 'atc';
    if (!histN && !vecS && !atc) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = c.width / dpr, H = c.height / dpr;
    if (atc && ringNm) drawRangeRings(g, m, W, H, ringNm);
    const lbls = [], obst = [];                       // ATC style: the labels, placed after; plots and vectors to keep clear of
    // newest → oldest plot opacity; stronger on the pale Light-theme map
    const light = document.documentElement.dataset.theme === 'light';
    const aNew = light ? 0.95 : 0.85, aOld = light ? 0.45 : 0.25;
    for (const [icao, ac] of Object.entries(aircraftData)) {
      if (!markers[icao] || !ac.lat || !ac.lon) continue;
      const p0 = m.latLngToContainerPoint([ac.lat, ac.lon]);
      if (p0.x < -300 || p0.y < -300 || p0.x > W + 300 || p0.y > H + 300) continue;
      const col  = acSymColor(ac), sel = icao === selectedIcao;
      const fade = ac.landed ? 0.4 : 1;
      g.fillStyle = col;
      if (histN) {
        const curTs = ac.pos_ts || ac.last_seen || 0;
        const t = (trails[icao] || []).filter(q => q[2] < curTs);   // not the current position
        const pts = t.slice(-histN), n = pts.length;
        for (let k = 0; k < n; k++) {                 // k = 0 the oldest
          const age = n - 1 - k;                      // 0 = the newest plot
          const q = m.latLngToContainerPoint([pts[k][0], pts[k][1]]);
          g.globalAlpha = (aNew - (aNew - aOld) * age / Math.max(1, histN - 1)) * fade;
          g.fillRect(q.x - 1.75, q.y - 1.75, 3.5, 3.5);
          if (atc) obst.push({ x: q.x - 2, y: q.y - 2, w: 4, h: 4 });
        }
      }
      if (vecS && ac.track != null && ac.groundspeed > 30) {
        const e  = vecEnd(ac.lat, ac.lon, ac.track, ac.groundspeed, vecS);
        const pe = m.latLngToContainerPoint(e);
        const dx = pe.x - p0.x, dy = pe.y - p0.y, L0 = Math.hypot(dx, dy);
        if (L0 > 6) {                                 // from the square's edge
          g.globalAlpha = 0.9 * fade;
          g.strokeStyle = sel ? selColorNow() : col;
          g.lineWidth = 1.3;
          g.beginPath();
          g.moveTo(p0.x + dx * 5 / L0, p0.y + dy * 5 / L0);
          g.lineTo(pe.x, pe.y);
          g.stroke();
          if (atc) for (let d = 8; d < L0; d += 8) obst.push({ x: p0.x + dx * d / L0 - 2, y: p0.y + dy * d / L0 - 2, w: 4, h: 4 });
        }
      }
      if (atc) {
        const lines = atcLabelLines(ac);
        if (lines) lbls.push({ icao, p: p0, lines, sel, fade, col: sel ? selColorNow() : col, alt: ac.altitude ?? 99999 });
      }
    }
    if (atc && lbls.length) drawAtcLabels(g, lbls, W, H, obst);
    g.globalAlpha = 1;
  },
});
// own panes: the plots, vectors and ATC labels above the map lines and the
// weather (350–365), under the aircraft symbols (markerPane 600); the ATC map
// lines (airport, finals, coast) above the weather
map.createPane('livePlots').style.zIndex = 450;
map.getPane('livePlots').style.pointerEvents = 'none';
map.createPane('atcMapPane').style.zIndex = 370;
map.getPane('atcMapPane').style.pointerEvents = 'none';

// ── Style: Meteo / ATC (from 2026-10-30) ──────────────────────────────────
// ATC: a radar-display look for the air traffic controllers among the users —
// no street map but a plain background with the airport, the ILS / RNP finals,
// the coastline and, with the Rings button, range rings from the airport; monochrome symbols
// (below 6 000 ft light, above grey, the selected aircraft yellow), the labels
// in three lines with a leader line, moved automatically so that they do not
// overlap: callsign / level, trend ↑↓ and selected level in hundreds of feet
// (019↑060) / ground speed in tens of knots and type (19 AT75).  A generic
// European radar style (after Thales TopSky as used in Finland, whose screens
// and settings are not public) — a research display, not for controlling.
// Follows the page theme: dark grey in Dark, light grey in Light.
const ATC_LOW_FT = 6000;
// Range rings from the airport (the Rings button, ATC style only): off (default),
// every 5 NM or every 10 NM, to 30 NM
const RING_STEPS = [0, 5, 10];
let ringNm = (() => { try { const v = parseInt(localStorage.getItem('ms_liveRings'), 10); return RING_STEPS.includes(v) ? v : 0; } catch (_) { return 0; } })();
let liveStyle = (() => { try { return localStorage.getItem('ms_liveStyle') === 'atc' ? 'atc' : 'meteo'; } catch (_) { return 'meteo'; } })();
const ATC_PAL = {
  dark:  { bg: '#1b2027', apt: '#5b6573', ils: '#46566a', rnp: '#6b5a3c', coast: '#36414e', ring: '#2c3540', ringTxt: '#4f5a67',
           low: '#d1fae5', high: '#9ca3af', sel: '#facc15', leader: '#7b8594' },
  light: { bg: '#cfd2d5', apt: '#59626e', ils: '#2a4a7a', rnp: '#8a5a1c', coast: '#8b9bb0', ring: '#b3b8be', ringTxt: '#8a9099',
           low: '#0b3b2c', high: '#4b5563', sel: '#1d4ed8', leader: '#5d6672' },
};
const atcPal = () => ATC_PAL[document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'];
function acSymColor(ac) {
  if (liveStyle !== 'atc') return acColor(ac);
  const P = atcPal();
  return ac.altitude != null && ac.altitude < ATC_LOW_FT ? P.low : P.high;
}
const selColorNow = () => liveStyle === 'atc' ? atcPal().sel : selSymColor();

// Level in hundreds of feet, three digits: up to the transition altitude on the
// METAR QNH, above it the flight level (as liveAtcAlt without the A / FL)
const atcLvl3 = pa => pa == null ? '---' : liveAtcAlt(pa).replace(/^(A|FL)/, '');
function atcLabelLines(ac) {
  const lv = lblLvl;
  if (lv === 'off') return null;
  const cs = callsignCache[ac.icao] || ac.callsign || ac.icao;
  if (lv === 'cs')   return [cs];
  if (lv === 'reg')  return [ac.registration || cs];
  if (lv === 'icao') return [ac.icao];
  if (lv === 'type') return [ac.aircraft_type || '—'];
  const vr = ac.vert_rate, tr = vr == null ? ' ' : vr >= 300 ? '↑' : vr <= -300 ? '↓' : ' ';
  const sel = lv === 'full' && ac.sel_alt != null ? String(Math.round(ac.sel_alt / 100)).padStart(3, '0') : '';
  const l2 = ac.landed ? 'landed' : (atcLvl3(ac.altitude) + tr + sel).trimEnd();
  if (lv === 'alt') return [cs, l2];
  const gs = ac.groundspeed != null ? String(Math.round(ac.groundspeed / 10)).padStart(2, '0') : '--';
  return [cs, l2, `${gs} ${ac.aircraft_type || ''}`.trimEnd()];
}

// Range rings every 5 or 10 NM from the airport (to 30 NM), with their distance
function drawRangeRings(g, m, W, H, step) {
  const P = atcPal(), c = m.latLngToContainerPoint([AIRPORT_LAT, AIRPORT_LON]);
  const pxPerNm = Math.abs(m.latLngToContainerPoint([AIRPORT_LAT + 1 / 60, AIRPORT_LON]).y - c.y);
  if (pxPerNm * step < 14) return;                    // zoomed far out: no rings
  g.globalAlpha = 1;
  g.strokeStyle = P.ring; g.lineWidth = 1;
  g.fillStyle = P.ringTxt; g.font = '10px Consolas, "DejaVu Sans Mono", monospace';
  g.textAlign = 'center'; g.textBaseline = 'bottom';
  for (let nm = step; nm <= 30; nm += step) {
    const r = nm * pxPerNm;
    g.beginPath(); g.arc(c.x, c.y, r, 0, 2 * Math.PI); g.stroke();
    if (c.y - r > 8 && c.y - r < H) g.fillText(String(nm), c.x, c.y - r - 1);
  }
  g.textAlign = 'left';
}

// ATC labels with leader lines, placed so that they do not overlap: each tries
// 16 positions (8 directions, near and far) and takes the free one with the
// least overlap with the labels already placed, the aircraft symbols and the
// history plots and speed vectors; it
// keeps its last position while that stays free, so the labels do not jump.
// The selected aircraft first, then from the lowest up (the approach traffic).
const ATC_DIRS = [[1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1]];  // NE first
const atcLblPos = {};            // icao → the chosen position (0–15)
const ATC_LH = 13;               // line height, px
function drawAtcLabels(g, items, W, H, obst) {
  const P = atcPal();
  g.font = '12px Consolas, "DejaVu Sans Mono", "Courier New", monospace';
  g.textBaseline = 'top';
  for (const it of items) {
    it.w = Math.ceil(Math.max(...it.lines.map(t => g.measureText(t).width))) + 4;
    it.h = it.lines.length * ATC_LH + 2;
  }
  const syms = items.map(it => ({ x: it.p.x - 6, y: it.p.y - 6, w: 12, h: 12, icao: it.icao }));
  const ov = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
                       Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const rectFor = (it, k) => {
    const [dx, dy] = ATC_DIRS[k % 8], r = k < 8 ? 22 : 44, u = dx && dy ? 0.7071 : 1;
    const ax = it.p.x + dx * r * u, ay = it.p.y + dy * r * u;
    const x = dx > 0 ? ax : dx < 0 ? ax - it.w : ax - it.w / 2;
    const y = dy < 0 ? ay - it.h : dy > 0 ? ay : ay - it.h / 2;
    return { x, y, w: it.w, h: it.h, ax, ay, ux: dx * u, uy: dy * u };
  };
  items.sort((a, b) => (b.sel - a.sel) || (a.alt - b.alt));
  const placed = [];
  for (const it of items) {
    const prev = atcLblPos[it.icao];
    const order = prev != null ? [prev, ...Array.from({ length: 16 }, (_, i) => i).filter(i => i !== prev)]
                               : Array.from({ length: 16 }, (_, i) => i);
    let best = null, bestCost = Infinity;
    for (const k of order) {
      const R = rectFor(it, k);
      let cost = (k >= 8 ? 1 : 0);                   // a near position first
      for (const q of placed) cost += ov(R, q) * 4;
      for (const q of syms) if (q.icao !== it.icao) cost += ov(R, q) * 8;
      for (const q of obst) cost += ov(R, q) * 2;
      if (R.x < 0 || R.y < 0 || R.x + R.w > W || R.y + R.h > H) cost += 50;
      if (k === prev && cost <= 1) { best = { k, R }; break; }
      if (cost < bestCost) { bestCost = cost; best = { k, R }; }
    }
    atcLblPos[it.icao] = best.k;
    placed.push(best.R);
    const R = best.R;
    g.globalAlpha = it.fade;
    g.strokeStyle = it.sel ? it.col : P.leader; g.lineWidth = 1;
    g.beginPath(); g.moveTo(it.p.x + R.ux * 6, it.p.y + R.uy * 6); g.lineTo(R.ax, R.ay); g.stroke();
    g.fillStyle = it.col;
    it.lines.forEach((t, i) => g.fillText(t, R.x + 2, R.y + 1 + i * ATC_LH));
  }
  g.globalAlpha = 1;
}

// The ATC map lines: loaded at the first switch to the ATC style
let atcMap = null, atcGeo = null;
const atcRenderer = L.canvas({ pane: 'atcMapPane', padding: 0.3 });
async function loadAtcMap() {
  if (!atcGeo) {
    try {
      const [ils, apt, coast] = await Promise.all(['efhk_ils', 'efhk_apt', 'efhk_coast']
        .map(n => fetch(`/overlays/${n}.geojson`).then(r => r.ok ? r.json() : null).catch(() => null)));
      atcGeo = { ils, apt, coast };
    } catch (_) { atcGeo = {}; }
  }
  if (atcMap) { atcMap.remove(); atcMap = null; }
  if (liveStyle !== 'atc') return;
  const P = atcPal(), g = L.layerGroup();
  const opt = st => ({ renderer: atcRenderer, interactive: false, style: st });
  if (atcGeo.coast) L.geoJSON(atcGeo.coast, opt({ color: P.coast, weight: 1, opacity: 0.9, fill: false })).addTo(g);
  if (atcGeo.apt)   L.geoJSON(atcGeo.apt,   opt({ color: P.apt,   weight: 1, opacity: 0.9, fill: false })).addTo(g);
  if (atcGeo.ils) {
    const efhk = { type: 'FeatureCollection', features: (atcGeo.ils.features || []).filter(f => f.properties && f.properties.airport === 'EFHK') };
    L.geoJSON(efhk, opt(f => f.properties?.approach_type === 'RNP'
      ? { color: P.rnp, weight: 1, opacity: 0.9, dashArray: '8 5', fill: false }
      : { color: P.ils, weight: 1, opacity: 0.9, dashArray: '4 4', fill: false })).addTo(g);
  }
  atcMap = g.addTo(map);
}

const legendEl = document.querySelector('.map-legend');
const legendMeteoHtml = legendEl ? legendEl.innerHTML : '';
function applyLiveStyle() {
  const atc = liveStyle === 'atc', P = atcPal();
  if (atc) { if (map.hasLayer(currentTile)) map.removeLayer(currentTile); }
  else if (!map.hasLayer(currentTile)) currentTile.addTo(map);
  map.getContainer().style.background = atc ? P.bg : '';
  if (atc) receiverMarker.remove(); else receiverMarker.addTo(map);
  if (legendEl) {
    legendEl.classList.toggle('atc', atc);
    legendEl.innerHTML = atc
      ? `<span class="legend-sq" style="border-color:${P.low}"></span> below ${ATC_LOW_FT.toLocaleString('en-US')} ft
         <span class="legend-sq" style="border-color:${P.high}"></span> above
         <span class="legend-sq" style="border-color:${P.sel}"></span> selected
         <span class="legend-note" title="A radar-display look for research and comparison: positions as received by this station (ADS-B / MLAT), not certified surveillance data">Research display — not for air traffic control</span>`
      : legendMeteoHtml;
  }
  loadAtcMap();
  for (const [k, m] of Object.entries(markers)) {
    const d = aircraftData[k];
    if (!d) continue;
    m.setIcon(makeIcon(acSymColor(d), k === selectedIcao));
    updateLabel(k, d.lat, d.lon, d);
    drawWindArrow(k, d.lat, d.lon, d.best_wind_spd, d.best_wind_dir);
  }
  plotLayer.redraw();
}
// created after the style state above (its first draw reads it)
const plotLayer = new PlotLayer().addTo(map);

// ── Map labels (ATC style, levels of the Lbl button) ──────────────────────
function updateLabel(icao, lat, lon, ac) {
  // the ATC style draws its labels on the plot canvas (drawAtcLabels)
  const html = liveStyle === 'atc' ? '' : liveLabelHtml(ac || aircraftData[icao] || { icao });
  if (!html) {
    if (labelMarkers[icao]) { labelMarkers[icao].remove(); delete labelMarkers[icao]; }
    return;
  }
  const two = ['alt', 'type+', 'full'].includes(lblLvl);
  const icon = L.divIcon({
    html:       `<div class="ac-map-label${lblLvl === 'type+' || lblLvl === 'full' ? ' dense' : ''}">${html}</div>`,
    className:  '',
    iconSize:   null,
    iconAnchor: [-10, two ? 7 : 6],   // offset: label sits to the right of the square
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
  if (windArrows[icao]) { windArrows[icao].remove(); delete windArrows[icao]; }
  if (liveStyle === 'atc') return;                  // no wind lines in the ATC style
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
  const icon     = makeIcon(acSymColor(ac), selected);

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

  updateTrail(ac.icao, ac.lat, ac.lon, ac.pos_ts || ac.last_seen || Date.now() / 1000);
  updateLabel(ac.icao, ac.lat, ac.lon, ac);
  drawWindArrow(ac.icao, ac.lat, ac.lon, ac.best_wind_spd, ac.best_wind_dir);
  // landed (no new position near the airport for 15 s): faded
  const op = ac.landed ? 0.4 : 1;
  markers[ac.icao].setOpacity(op);
  if (labelMarkers[ac.icao]) labelMarkers[ac.icao].setOpacity(op);
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
      if (labelMarkers[icao]){ labelMarkers[icao].remove();delete labelMarkers[icao]; }
      delete trails[icao];
      delete atcLblPos[icao];
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

// Altitude for the list, as used in the air: below the transition altitude
// (EFHK 5 000 ft) the altitude on the METAR QNH, above it the flight level.
// Transponders report pressure altitude (1013.25 hPa); on QNH the aircraft is
// about 27 ft higher per hPa above 1013.25.  The switch to FL is decided on
// the QNH altitude.  Without a METAR QNH: pressure altitude, marked "PA".
const TRANSITION_ALT_FT = 5000;
function listAlt(alt) {
  if (alt == null) return '–';
  const fl = 'FL' + String(Math.round(alt / 100)).padStart(3, '0');
  const qnh = miniSfc && miniSfc.qnh ? miniSfc.qnh : null;
  if (qnh == null) {
    return alt > TRANSITION_ALT_FT ? fl
      : `<span title="Pressure altitude (1013.25 hPa) — no METAR QNH available">${alt.toLocaleString()} ft PA</span>`;
  }
  const amsl = Math.round((alt + (qnh - 1013.25) * 27) / 10) * 10;
  if (amsl > TRANSITION_ALT_FT)
    return `<span title="Flight level (pressure altitude ${alt.toLocaleString()} ft)">${fl}</span>`;
  return `<span title="Altitude on QNH ${Math.round(qnh)} hPa (METAR) · pressure altitude ${alt.toLocaleString()} ft">${amsl.toLocaleString()} ft</span>`;
}
// Climbing / descending: arrow when the vertical rate is at least 300 fpm
const VS_ARROW_FPM = 300;
// The altitude selected on the autopilot panel (MCP / FCU; sel_alt of the live
// stream when heard within 2 min) after the altitude (from 30 Oct 2026):
// + climbing, - descending (≥ 300 fpm), = level; the value as the controllers
// write it — up to the transition altitude A + hundreds of feet (A030), above
// it a flight level (FL080): FL120-A030, FL120-FL080, FL050+FL380,
// FL390=FL390.  '' when not known.
function selAltTxt(ac) {
  if (ac.sel_alt == null || ac.altitude == null) return '';
  const vr = ac.vert_rate || 0;
  const sign = vr >= VS_ARROW_FPM ? '+' : vr <= -VS_ARROW_FPM ? '-' : '=';
  const h = Math.round(ac.sel_alt / 100);
  return sign + (ac.sel_alt > TRANSITION_ALT_FT ? 'FL' : 'A') + String(h).padStart(3, '0');
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

  // built off-screen and swapped in at once: the list never goes empty in
  // between, so its height and scroll position stay steady while updating
  const frag = document.createDocumentFragment();
  for (const ac of visible) {
    const div   = document.createElement('div');
    div.className = 'ac-item' + (ac.icao === selectedIcao ? ' selected' : '') + (ac.landed ? ' ac-landed' : '');
    div.dataset.icao = ac.icao;
    const color = acColor(ac);

    const meteo = [];
    if (ac.best_wind_spd != null)
      meteo.push(`${ac.best_wind_spd.toFixed(0)} kt @ ${ac.best_wind_dir?.toFixed(0)}°`);
    if (ac.best_temp != null)
      meteo.push(`${ac.best_temp.toFixed(1)}°C`);
    const hc = hdgCorrText(ac, '°');
    if (meteo.length && hc) meteo.push(`HC ${hc}`);
    const meteoLine = meteo.length ? meteo.join(' · ') : 'No meteo';

    const vr = ac.vert_rate;
    const vsDir = vr != null && Math.abs(vr) >= VS_ARROW_FPM ? (vr > 0 ? 'up' : 'down') : null;
    const vsArrow = vsDir ? `<span class="ac-vs-arrow" title="${vsDir === 'up' ? 'Climbing' : 'Descending'} ${Math.abs(vr).toLocaleString()} fpm">${vsDir === 'up' ? '▲' : '▼'}</span>` : '';
    const vsText = vr != null && Math.abs(vr) >= 100 ? ` · ${vr > 0 ? '+' : '−'}${Math.abs(vr).toLocaleString()} fpm` : '';

    div.innerHTML = `
      <div>
        <span class="ac-callsign" style="color:${color}">${esc(ac.callsign || ac.registration || ac.icao)}</span>
        ${ac.registration && ac.callsign ? `<span class="ac-reg">${esc(ac.registration)}</span>` : ''}
        <span class="ac-icao">${ac.callsign || ac.registration ? ac.icao : ''}</span>
        ${vsArrow}
      </div>
      <div class="ac-detail">${ac.aircraft_type ? esc(ac.aircraft_type) + ' · ' : ''}${listAlt(ac.altitude)}${selAltTxt(ac) ? `<span class="ac-sel" title="Selected altitude on the autopilot panel (MCP / FCU): ${ac.sel_alt.toLocaleString()} ft — + climbing, - descending, = level">${selAltTxt(ac)}</span>` : ''}${vsText}
        ${ac.groundspeed != null ? ' · ' + ac.groundspeed + ' kt' : ''}</div>
      <div class="ac-meteo">${ac.landed ? `Landed? — no new position for ${ac.landed} s` : meteoLine}</div>
    `;
    div.onclick = () => selectAircraft(ac.icao);
    frag.appendChild(div);
  }
  const keepTop = list.scrollTop;
  list.replaceChildren(frag);
  list.scrollTop = keepTop;
}

// ── Select aircraft ────────────────────────────────────────────────────────
function selectAircraft(icao) {
  selectedIcao = icao;
  const ac = aircraftData[icao];
  if (!ac) return;

  for (const [k, m] of Object.entries(markers)) {
    const d = aircraftData[k];
    if (d) m.setIcon(makeIcon(acSymColor(d), k === icao));
  }
  plotLayer.redraw();                    // the selected aircraft's vector colour

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
  set('d-wind',  ac.best_wind_spd != null && ac.best_wind_dir != null
                   ? `${String(Math.round(ac.best_wind_dir)).padStart(3, '0')}° / ${Math.round(ac.best_wind_spd)}` : null, ' kt');
  set('d-temp',  ac.best_temp      != null ? ac.best_temp.toFixed(1)      : null, ' °C');
  // MRAR / MHR values (practically never sent): their cells only when present
  const opt = (id, val, unit) => {
    set(id, val, unit);
    document.getElementById(id).closest('.detail-cell').classList.toggle('hidden', val == null);
  };
  opt('d-pres',  ac.best_pressure  != null ? ac.best_pressure.toFixed(0)  : null, ' hPa');
  opt('d-hum',   ac.mrar_humidity  != null ? ac.mrar_humidity.toFixed(0)  : null, ' %');
  const turbMap = ['NIL', 'Light', 'Moderate', 'Severe'];
  opt('d-turb',  ac.mrar_turbulence != null ? turbMap[ac.mrar_turbulence] : null, '');
  // Heading calibration (collector/heading_cal.py); the rarely received MRAR
  // figure of merit takes the cell when present
  if (ac.mrar_fom != null) {
    document.getElementById('d-hdg-label').textContent = 'FOM';
    set('d-hdg', ac.mrar_fom);
  } else {
    document.getElementById('d-hdg-label').textContent = 'Hdg corr';
    set('d-hdg', hdgCorrText(ac, '°'));
  }

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
    if (d) m.setIcon(makeIcon(acSymColor(d), false));
  }
  plotLayer.redraw();
}

// ── SSE connection ─────────────────────────────────────────────────────────
// ── A landed aircraft leaves sooner (from 2026-10-29, as on the Windshear page
// and the phone) ─────────────────────────────────────────────────────────────
// After touchdown the receiver keeps hearing the aircraft (ground replies, the
// receiver's aircraft list) at its last airborne position, so it stayed on the
// map until its transponder was switched off and 5 min after that.  Within
// 3 NM of the airport and below 1 500 ft (pressure altitude) the time since
// its position last changed now decides: from 15 s it is shown faded
// ("landed?"), from 30 s it is no longer shown.  Display only.
const LANDED_NM = 3, LANDED_FT = 1500, LANDED_FADE_S = 15, LANDED_GONE_S = 30;
function nmFromAirport(lat, lon) {
  const r = Math.PI / 180, dLat = (lat - AIRPORT_LAT) * r, dLon = (lon - AIRPORT_LON) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(AIRPORT_LAT * r) * Math.cos(lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(a));
}
function landedFilter(list) {
  const srvNow = Math.max(0, ...list.map(a => a.last_seen || 0));
  return list.filter(a => {
    a.landed = 0;
    if (a.pos_ts == null || a.lat == null || a.lon == null) return true;
    if (a.altitude != null && a.altitude >= LANDED_FT) return true;
    if (nmFromAirport(a.lat, a.lon) > LANDED_NM) return true;
    const age = srvNow - a.pos_ts;
    if (age >= LANDED_GONE_S) return false;
    if (age >= LANDED_FADE_S) a.landed = Math.round(age);
    return true;
  });
}

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
    const data     = landedFilter(JSON.parse(e.data));
    const liveIcaos = new Set(data.map(d => d.icao));

    for (const ac of data) {
      if (ac.callsign) callsignCache[ac.icao] = ac.callsign;
      updateWindHistory(ac);       // accumulate vertical wind profile
      aircraftData[ac.icao] = ac;
      upsertMarker(ac);
    }
    removeStale(liveIcaos);
    plotLayer.redraw();            // history plots and vectors, once per update
    renderList(data);

    if (selectedIcao && aircraftData[selectedIcao]) {
      selectAircraft(selectedIcao);
    }
  };
}

// ── Filter toggles ─────────────────────────────────────────────────────────

// Restore saved state into the DOM controls before first render
document.getElementById('filter-meteo-only').checked = meteoOnly;
document.getElementById('toggle-track').checked      = showTrack;

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

// Map labels: the Lbl button steps Off → CS → Reg → ICAO24 → Type → CS+Alt → +Type → Full
const lblBtn = document.getElementById('lbl-btn');
if (lblBtn) {
  const showLbl = () => {
    lblBtn.textContent = `Lbl ${LBL_NAME[lblLvl]}`;
    lblBtn.classList.toggle('active', lblLvl !== 'off');
  };
  showLbl();
  lblBtn.addEventListener('click', () => {
    lblLvl = LBL_STEPS[(LBL_STEPS.indexOf(lblLvl) + 1) % LBL_STEPS.length];
    try { localStorage.setItem('ms_liveLbl', lblLvl); } catch (_) { /* private mode */ }
    showLbl();
    for (const [icao, ac] of Object.entries(aircraftData)) {
      if (ac.lat && ac.lon) updateLabel(icao, ac.lat, ac.lon, ac);
    }
    renderList(Object.values(aircraftData));     // the list follows Reg / ICAO24
    plotLayer.redraw();                          // the ATC style's labels
    syncSkewT();
  });
}

// History plots and speed vectors: the Hist and Vec buttons step the lengths
function stepBtn(id, steps, get, set, key, fmt) {
  const b = document.getElementById(id);
  if (!b) return;
  const show = () => { b.textContent = fmt(get()); b.classList.toggle('active', get() !== 0); };
  show();
  b.addEventListener('click', () => {
    set(steps[(steps.indexOf(get()) + 1) % steps.length]);
    try { localStorage.setItem(key, String(get())); } catch (_) { /* private mode */ }
    show();
    plotLayer.redraw();
  });
}
stepBtn('hist-btn', HIST_STEPS, () => histN, v => { histN = v; }, 'ms_liveHist',
        v => `Hist ${v ? v : 'Off'}`);
stepBtn('vec-btn', VEC_STEPS, () => vecS, v => { vecS = v; }, 'ms_liveVec',
        v => `Vec ${v === 0 ? 'Off' : v < 60 ? v + 's' : v / 60 + 'm'}`);

// Style: Meteo / ATC
const styleBtn = document.getElementById('style-btn');
if (styleBtn) {
  const showStyle = () => {
    styleBtn.textContent = liveStyle === 'atc' ? 'ATC' : 'Meteo';
    styleBtn.classList.toggle('active', liveStyle === 'atc');
  };
  showStyle();
  styleBtn.addEventListener('click', () => {
    liveStyle = liveStyle === 'atc' ? 'meteo' : 'atc';
    try { localStorage.setItem('ms_liveStyle', liveStyle); } catch (_) { /* private mode */ }
    showStyle();
    showRings();
    applyLiveStyle();
  });
}
// Range rings (ATC style): the Rings button steps Off · 5 NM · 10 NM; shown only in the ATC style
const ringsBtn = document.getElementById('rings-btn');
function showRings() {
  if (!ringsBtn) return;
  ringsBtn.hidden = liveStyle !== 'atc';
  ringsBtn.textContent = ringNm ? `Rings ${ringNm}` : 'Rings Off';
  ringsBtn.classList.toggle('active', ringNm !== 0);
}
showRings();
if (ringsBtn) ringsBtn.addEventListener('click', () => {
  ringNm = RING_STEPS[(RING_STEPS.indexOf(ringNm) + 1) % RING_STEPS.length];
  try { localStorage.setItem('ms_liveRings', String(ringNm)); } catch (_) { /* private mode */ }
  showRings();
  plotLayer.redraw();
});
if (liveStyle === 'atc') applyLiveStyle();

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

// ── Radiosonde tick box (panel title); refreshed every 10 min while on ─────
const sondeChk = document.getElementById('skewt-sonde');
if (sondeChk) {
  sondeChk.checked = sondeShow;
  sondeChk.addEventListener('change', e => {
    sondeShow = e.target.checked;
    localStorage.setItem('ms_skewtSonde', String(sondeShow));
    drawMiniSounding();
    fetchMiniSonde();
  });
}
// ── MEPS tick box (panel title)
const mepsChk = document.getElementById('skewt-meps');
if (mepsChk) {
  mepsChk.checked = mepsShow;
  mepsChk.addEventListener('change', e => {
    mepsShow = e.target.checked;
    localStorage.setItem('ms_skewtMeps', String(mepsShow));
    drawMiniSounding();
    fetchMiniMeps();
  });
}
fetchMiniMeps();
setInterval(fetchMiniMeps, 10 * 60 * 1000);
// ── RH strip tick box (trial moisture indicator); the area profile is loaded again with it
const rhChk = document.getElementById('skewt-rh');
if (rhChk) {
  rhChk.checked = rhShow;
  rhChk.addEventListener('change', e => {
    rhShow = e.target.checked;
    localStorage.setItem('ms_skewtRH', String(rhShow));
    if (rhShow && miniArea && !('moisture' in miniArea)) fetchMiniArea();
    else drawMiniSounding();
  });
}
fetchMiniSonde();
setInterval(fetchMiniSonde, 2 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) fetchMiniSonde(); });
setInterval(() => { if (sondeShow && miniSonde) drawMiniSounding(); }, 60 * 1000);   // age label

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

// ── Analysis source selector (Mode S / MEPS / Sonde): choosing MEPS or Sonde
// also ticks that profile on; unticking it later falls back to Mode S
const anaSrcSel = document.getElementById('ana-src');
if (anaSrcSel) {
  anaSrcSel.value = anaSrc;
  anaSrcSel.addEventListener('change', e => {
    anaSrc = e.target.value;
    localStorage.setItem('ms_skewtAnaSrc', anaSrc);
    const chk = document.getElementById(anaSrc === 'meps' ? 'skewt-meps' : anaSrc === 'sonde' ? 'skewt-sonde' : '');
    if (chk && !chk.checked) { chk.checked = true; chk.dispatchEvent(new Event('change')); }
    if (anaLevel === 0) setAnaLevel(1, false);
    drawMiniSounding();
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
  fitWxText();
}

// A long METAR / TAF first tightens its line spacing (1.5 → 1.3), then shrinks
// its text in 0.5 px steps down to WX_MIN_FONT (line spacing 1.2) to fit its
// box; only beyond that it scrolls.  Refitted when the text changes and when a
// box changes size (aircraft selected / closed, window).
const WX_MIN_FONT = 12;
function fitWxText() {
  for (const el of document.querySelectorAll('.wx-text')) {
    el.style.fontSize = el.style.lineHeight = '';   // back to the style sheet
    if (!el.clientHeight) continue;
    const over = () => el.scrollHeight > el.clientHeight + 1;
    if (!over()) continue;
    el.style.lineHeight = '1.3';
    let size = parseFloat(getComputedStyle(el).fontSize);
    while (over() && size > WX_MIN_FONT) {
      size = Math.max(WX_MIN_FONT, size - 0.5);
      el.style.fontSize = size + 'px';
      el.style.lineHeight = size <= 13 ? '1.2' : '1.3';
    }
  }
}
if (typeof ResizeObserver !== 'undefined') {
  let wxFitPending = false;
  const wxRo = new ResizeObserver(() => {
    if (wxFitPending) return;
    wxFitPending = true;
    requestAnimationFrame(() => { wxFitPending = false; fitWxText(); });
  });
  document.querySelectorAll('.wx-section').forEach(el => wxRo.observe(el));
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
  );
  applyLiveStyle();       // the tiles (Meteo) or the ATC colours; the selected square
  drawMiniSounding();
};
