/**
 * weather_mg.js — the Weather page's Meteogram view (from 2026-11-05).
 *
 * Map | Meteogram at the start of the control strip.  The meteogram of one place
 * (the airport by default, a receiver site — from the evening of 5 Nov 2026 — or a
 * place pinned on the map — the point card's "Meteogram" button) from
 * /api/weather/meteogram, drawn by meteogram.js:
 * temperature, precipitation, wind, pressure and clouds on one time axis (UTC).
 *   Model  MEPS (the past days and ~2 days ahead) · GFS (now … 16 days) · Both
 *          (GFS's days with MEPS over its own); GFS only where the server has it
 *   Range  MEPS: past 24 h / 3 days / 7 days + its forecast; GFS / Both: 5 / 10 / 16 days
 *   Panels tick boxes
 * The view and the choices are remembered in this browser (ms_weather_mg); the
 * address #mg=lat,lon (or #mg=RX-02) opens the meteogram of that place.  Refreshed every 10 min
 * while shown (the server caches the answers, a new run makes new ones).
 */
'use strict';

const WxMg = (() => {
  const $ = id => document.getElementById(id);
  const KEY = 'ms_weather_mg';
  const PANELS = ['temp', 'precip', 'wind', 'pres', 'cloud'];
  const RANGES = {
    meps: [['24', 'past 24 h + forecast'], ['72', 'past 3 days + forecast'], ['168', 'past 7 days + forecast']],
    gfs: [['120', '5 days'], ['240', '10 days'], ['384', '16 days']],
  };
  let st = { view: 'map', model: MG_GFS ? 'both' : 'meps', range: { meps: '24', gfs: '384' }, panels: {}, pin: null };
  try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s) st = Object.assign(st, s, { range: Object.assign(st.range, s.range || {}) }); } catch (e) { /* private mode */ }
  if (!MG_GFS) st.model = 'meps';
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* private mode */ } };
  // the place: the airport, a receiver site (Meteogram.receivers — the maps' receiver triangles,
  // to 0.01°) or the pinned place; st.place 'apt' | 'rx:<id>' | 'pin'
  const APT = { kind: 'apt', lat: MG_AIRPORT.lat, lon: MG_AIRPORT.lon, title: MG_AIRPORT.icao };
  let rxs = [];
  let place = APT;
  const pinPlace = () => ({ kind: 'pin', lat: st.pin.lat, lon: st.pin.lon, title: 'Pinned place' });
  const rxPlace = r => ({ kind: 'rx', id: r.id, lat: r.lat, lon: r.lon, title: r.label });
  const placeVal = () => place.kind === 'rx' ? 'rx:' + place.id : place.kind;
  function pickPlace(v) {
    const r = v.startsWith('rx:') && rxs.find(x => 'rx:' + x.id === v);
    place = r ? rxPlace(r) : v === 'pin' && st.pin ? pinPlace() : APT;
  }
  let chart = null, run = 0, timer = 0, lastData = null;

  const fmtLL = (lat, lon) => `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`;
  const runTxt = r => { const d = new Date(r * 1000); return `${d.getUTCDate()}.${d.getUTCMonth() + 1}. ${String(d.getUTCHours()).padStart(2, '0')} UTC`; };

  function fillRange() {
    const el = $('wx-mg-range'), m = st.model === 'meps' ? 'meps' : 'gfs';
    el.innerHTML = RANGES[m].map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
    el.value = st.range[m] && RANGES[m].some(r => r[0] === st.range[m]) ? st.range[m] : RANGES[m][m === 'meps' ? 0 : 2][0];
  }
  function fillPlace() {
    const el = $('wx-mg-place');
    const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    el.innerHTML = `<option value="apt">${MG_AIRPORT.icao}</option>`
      + (rxs.length ? '<optgroup label="Receiver sites">' + rxs.map(r => `<option value="rx:${esc(r.id)}">${esc(r.label)}</option>`).join('') + '</optgroup>' : '')
      + (st.pin ? `<option value="pin">${fmtLL(st.pin.lat, st.pin.lon)} (pinned)</option>` : '');
    el.value = placeVal();
  }
  function syncControls() {
    $('wx-mg-model').value = st.model;
    PANELS.forEach(k => { $('wx-mg-' + k).checked = st.panels[k] !== false; });
    fillRange(); fillPlace();
  }

  function setView(v, push = true) {
    st.view = v; save();
    const page = document.querySelector('.weather-page');
    page.classList.toggle('wx-mg-mode', v === 'mg');
    $('wx-v-map').classList.toggle('wx-von', v === 'map');
    $('wx-v-mg').classList.toggle('wx-von', v === 'mg');
    if (v === 'mg') { load(); if (push) setHash(); }
    else {
      clearInterval(timer); timer = 0;
      if (location.hash.startsWith('#mg')) history.replaceState(null, '', location.pathname + location.search);
      if (typeof map !== 'undefined' && map.invalidateSize) setTimeout(() => map.invalidateSize(), 0);   // weather.js's map
    }
  }
  function setHash() {
    const h = place.kind === 'apt' ? '#mg' : place.kind === 'rx' ? '#mg=' + String(place.id).replace(/^MODES-/, '')
      : `#mg=${place.lat.toFixed(3)},${place.lon.toFixed(3)}`;
    if (location.hash !== h) history.replaceState(null, '', location.pathname + location.search + h);
  }

  async function load() {
    const my = ++run;
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden && st.view === 'mg') load(); }, 10 * 60 * 1000);
    const m = st.model, rng = parseInt(st.range[m === 'meps' ? 'meps' : 'gfs'], 10);
    const q = `lat=${place.lat.toFixed(4)}&lon=${place.lon.toFixed(4)}`;
    const want = m === 'both' ? ['meps', 'gfs'] : [m];
    const url = k => k === 'meps'
      ? `/api/weather/meteogram?${q}&model=meps&past=${m === 'meps' ? rng : 6}&fc=${m === 'meps' ? 80 : rng}`
      : `/api/weather/meteogram?${q}&model=gfs&past=2&fc=${rng}`;
    $('wx-mg-head').innerHTML = `<b>${place.title}</b> · ${fmtLL(place.lat, place.lon)} · loading…`;
    try {
      const res = await Promise.all(want.map(k => fetch(url(k)).then(r => r.json())));
      if (my !== run) return;
      const data = {};
      want.forEach((k, i) => { data[k] = res[i] && !res[i].error ? res[i] : null; data[k + 'Err'] = res[i] && res[i].error; });
      lastData = data;
      draw();
    } catch (e) {
      console.error('Meteogram:', e);
      $('wx-mg-head').innerHTML += ' · <span class="mg-dim">error loading the meteogram</span>';
    }
  }
  function draw() {
    const data = lastData;
    if (!data) return;
    const cells = [];
    if (data.meps) cells.push(`MEPS ${data.meps.cell.fine_grid ? '2.5 km / 10 km' : '10 km'} cell ${fmtLL(data.meps.cell.lat, data.meps.cell.lon)}`);
    if (data.gfs) cells.push(`GFS 0.25° cell ${fmtLL(data.gfs.cell.lat, data.gfs.cell.lon)}`);
    $('wx-mg-head').innerHTML = `<b>${place.title}</b> · ${fmtLL(place.lat, place.lon)}` + (cells.length ? ' · ' + cells.join(' · ') : '');
    if (chart) chart.destroy();
    const panels = {};
    PANELS.forEach(k => { panels[k] = st.panels[k] !== false; });
    const err = [data.mepsErr, data.gfsErr].filter(Boolean);
    chart = Meteogram.render($('wx-mg-chart'), { meps: data.meps, gfs: data.gfs }, {
      panels, emptyText: err.length ? err.join(' · ') : 'No model hours for this place.' });
    const runs = [];
    if (data.meps) runs.push(`MEPS run ${runTxt(Math.max(...data.meps.runs))}${data.meps.runs.length > 1 ? ' (the past hours from the earlier runs)' : ''}${data.meps.cell.fine_grid ? ', the 2.5 km cell where that run has the hour' : ''} — MET Norway, CC BY 4.0`);
    if (data.gfs) runs.push(`GFS run ${runTxt(Math.max(...data.gfs.runs))}${data.gfs.runs.length > 1 ? ' (partly the run before)' : ''}, hourly to +120 h then every 3 h — NOAA/NCEP; beyond a week a rough guide only`);
    if (err.length && (data.meps || data.gfs)) runs.push(err.join(' · '));
    $('wx-mg-foot').textContent = runs.join(' · ') + ' · times UTC · the model at the grid cell of the place; for viewing';
  }

  // ── controls ───────────────────────────────────────────────────────────
  $('wx-v-map').addEventListener('click', () => setView('map'));
  $('wx-v-mg').addEventListener('click', () => setView('mg'));
  $('wx-mg-model').addEventListener('change', e => { st.model = e.target.value; save(); fillRange(); load(); });
  $('wx-mg-range').addEventListener('change', e => { st.range[st.model === 'meps' ? 'meps' : 'gfs'] = e.target.value; save(); load(); });
  $('wx-mg-place').addEventListener('change', e => {
    pickPlace(e.target.value); st.place = placeVal(); save();
    setHash(); load();
  });
  PANELS.forEach(k => $('wx-mg-' + k).addEventListener('change', e => { st.panels[k] = e.target.checked; save(); draw(); }));
  const prevTheme = window.onThemeChange;
  window.onThemeChange = function () { if (prevTheme) prevTheme(); if (st.view === 'mg') draw(); };

  // the place from the address (#mg, #mg=lat,lon or #mg=RX-02); a receiver once the list is in
  function fromHash() {
    const m = /^#mg(?:=(?:(-?[\d.]+),(-?[\d.]+)|([A-Za-z0-9-]+)))?$/.exec(location.hash);
    if (!m) return false;
    if (m[1] != null) {
      const lat = +m[1], lon = +m[2];
      if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        st.pin = { lat, lon }; place = pinPlace(); st.place = 'pin';
      }
    } else if (m[3]) st.place = 'rx:MODES-' + m[3].toUpperCase().replace(/^MODES-/, '');
    else { st.place = 'apt'; place = APT; }
    return true;
  }
  const hashed = fromHash();
  if (!hashed) pickPlace(st.place || 'apt');
  syncControls();
  // the receiver sites: the place chosen before (or in the address) once they are known
  Meteogram.receivers().then(list => {
    rxs = list;
    const was = placeVal();
    if (st.place && st.place.startsWith('rx:')) pickPlace(st.place);
    fillPlace();
    if (placeVal() !== was && st.view === 'mg') { setHash(); load(); }
  });
  if (hashed) setView('mg', false);
  else if (st.view === 'mg') setView('mg');

  // the point card's "Meteogram" (weather.js)
  function open(lat, lon) {
    st.pin = { lat, lon }; st.place = 'pin'; save();
    place = pinPlace();
    fillPlace();
    setView('mg');
  }
  return { open };
})();
