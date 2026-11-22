/**
 * app_mlat_map.js — the phone's own-MLAT map (/app, MLAT view; from 2026-11-20 evening).
 * For users with the MLAT right only (web/rights.py: the server leaves the view and this
 * script out for everyone else, and /api/mlat/* answers a plain 404).
 *
 * The Statistics page's MLAT tab, view "Map" (static/js/mlat_map.js), in the phone's shape:
 *
 *  - Map on top (Leaflet and static/js/atc_display.js are loaded the first time the view is
 *    opened): our own position fixes as open squares with the 30-second speed vector of OUR
 *    track and the radar-display label (callsign / level with the trend arrow / speed in tens
 *    of knots and type), our track, the track the aircraft broadcasts itself beside it, the
 *    approach lines of the airport and the receivers.  Blue: the aircraft also broadcasts its
 *    position; orange: it sends none.  Levels as on a radar label: up to the transition
 *    altitude the altitude on the EFHK METAR QNH, above it the flight level.
 *  - Replay bar under the map: Live, back / forward 1 and 10 minutes, play / pause, the speed
 *    (a tap steps ×1 … ×50), the time, a slider over the stored time and beside it a time field
 *    (UTC) to start the replay at a clock time (/api/mlat/replay, /api/mlat/replay/flights —
 *    the last 24 hours, one point per aircraft every 2 s).
 *  - One line for the selected aircraft (a tap on the map or on a row; a second tap releases).
 *  - Panels chosen with chips (app_mlat.js shows and hides them):
 *      Traffic  every aircraft with a fix in the last minute, two lines each: registration
 *               (when known), address and state, level, our speed / the reported one, stated / measured error, the
 *               motion figure / how long the track has run; nearest to the airport first
 *      Fixes    the tiles, the errors by distance and the receivers' clocks
 *      Flights  the aircraft located in the last 3 / 6 / 12 / 24 hours; a tap replays one alone
 *    (the fourth panel, Recorder, is app_mlat.js itself)
 *
 * Accuracy grid (from the evening of 2026-11-20, option): each cell of about 5 km coloured by the
 * median distance between our fixes there and the aircraft's own positions over the last 1 h to
 * 7 d (/api/mlat/grid), with its legend under the slider.
 *
 * Left to the web page: the coverage outline, the selected aircraft's two charts, sorting by
 * column, and the Traffic window (the chips do its job here).
 *
 * Options (menu, "MLAT options"; remembered on the phone as ms_app_mlm_*): Trail, Expected
 * error, ADS-B track, Unresolved, Vector, Labels, Show Sel Alt, Solo, Approach lines, Accuracy grid.
 *
 * Data: /api/mlat/fixes — the whole trail first and once a minute, in between only the new
 * points every 5 s, while the view is shown.  app_mlat.js calls init / show / hide / layout /
 * setPanel.
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  if (!$('aml-map')) return;
  const POLL = 5000, VEC_SEC = 30, RP_CHUNK = 600, HOME_ZOOM = 7, VIEW_KEY = 'ms_app_mlmView';
  const SPEEDS = [1, 2, 5, 10, 50];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const light = () => document.documentElement.dataset.theme === 'light';
  const COL = () => light()
    ? { pos: '#1d4ed8', nopos: '#c2410c', adsb: '#64748b', link: '#b91c1c' }
    : { pos: '#60a5fa', nopos: '#fb923c', adsb: '#94a3b8', link: '#f87171' };
  let lsGet = (k, d) => d, lsSet = () => {}, sub = () => {}, loadLeaflet = null, loadAtc = null;
  let inited = false, on = false, panel = 'trf', map = null, tiles = null, tileKey = null, renderer = null, layer = null, atc = null;
  let libs = null, libFail = false, timer = null, last = 0, nPoll = 0, sel = null, state = null, lastCnt = null, rate = null, failed = false;
  let ilsGeo = null, ilsLayer = null, ilsFeat = [], ilsSeq = 0, centre = null, flRange = 24;
  const AC = new Map();                       // icao → { cs, typ, pos, res, n, nrx, err, last, trk: [], adsb: [], … }
  const lblPos = {};
  const RP = { on: false, t: 0, play: false, speed: 10, t0: null, t1: null, chunks: new Map(), wait: new Set(), tick: null, wall: 0, meta: null, rangeT: 0, flights: [], missing: false };
  // the options: [key, select id, default, number?]
  const OPTS = [['win', 'app-mlat-win', '300', 1], ['exp', 'app-mlat-exp', '500', 1], ['adsb', 'app-mlat-adsb', 'on'], ['amb', 'app-mlat-amb', 'off'],
                ['vec', 'app-mlat-vec', 'on'], ['lbl', 'app-mlat-lbl', 'on'], ['sal', 'app-mlat-sal', 'off'], ['solo', 'app-mlat-solo', 'off'], ['ils', 'app-mlat-ils', 'on'],
                ['grid', 'app-mlat-grid', '0', 1],         // the accuracy grid's period in hours, 0 = off
                ['sus', 'app-mlat-sus', 'off']];           // misfit positions (from 2026-11-22, as on the Statistics page's map)
  const S = {};

  function setOpt(k, v) {                    // set from the code (a flight chosen for replay turns Solo on): the chips follow
    const o = OPTS.find(x => x[0] === k), el = $(o[1]);
    S[k] = v; lsSet('ms_app_mlm_' + k, String(o[3] ? v : v ? 'on' : 'off'));
    el.value = o[3] ? String(v) : v ? 'on' : 'off'; el._aml = true; el.dispatchEvent(new Event('change')); el._aml = false;
  }
  function init(o) {
    if (inited) return;
    inited = true;
    lsGet = o.lsGet; lsSet = o.lsSet; sub = o.sub; loadLeaflet = o.loadLeaflet; loadAtc = o.loadAtc;
    for (const [k, id, def, num] of OPTS) {
      const el = $(id);
      let v = lsGet('ms_app_mlm_' + k, def);
      if (![...el.options].some(x => x.value === v)) v = def;
      el.value = v; el.dispatchEvent(new Event('change'));                   // the chips follow
      S[k] = num ? +v : v === 'on';
      el.addEventListener('change', () => {
        if (el._aml) return;
        S[k] = num ? +el.value : el.value === 'on';
        lsSet('ms_app_mlm_' + k, el.value);
        if (k === 'win') { if (RP.on) rpFrame(); else poll(true); }
        else if (k === 'ils') ilsShow();
        else if (k === 'grid') gridLoad();
        else if (k === 'sus') { if (S.sus) susLoad(); else { susData = null; draw(); } }
        else { draw(); renderLists(); }
      });
    }
    RP.speed = +lsGet('ms_app_mlm_rpspeed', '10'); if (!SPEEDS.includes(RP.speed)) RP.speed = 10;
    $('aml-rp-speed').textContent = '×' + RP.speed;
    $('aml-rp-live').addEventListener('click', rpLive);
    $('aml-rp-play').addEventListener('click', () => {
      if (!RP.on) return rpGo((state && !state.replay ? state.now : Date.now() / 1000) - 600, true);     // from live: ten minutes back
      RP.play = !RP.play; rpUi(); rpFrame();
    });
    $('aml-rp').addEventListener('click', e => {
      const b = e.target.closest('[data-rpj]');
      if (!b) return;
      const base = RP.on ? RP.t : (state ? state.now : Date.now() / 1000);
      rpGo(base + (+b.dataset.rpj), RP.on ? null : true);
    });
    $('aml-rp-speed').addEventListener('click', () => {
      RP.speed = SPEEDS[(SPEEDS.indexOf(RP.speed) + 1) % SPEEDS.length];
      lsSet('ms_app_mlm_rpspeed', String(RP.speed)); $('aml-rp-speed').textContent = '×' + RP.speed;
      if (RP.on) rpFrame();
    });
    $('aml-rp-sl').addEventListener('input', e => rpGo(+e.target.value, RP.on ? null : false));
    // Enter (the keyboard's Go), or leaving the field after a change, starts the replay there
    $('aml-rp-at').addEventListener('keydown', e => { if (e.key === 'Enter') { e.target._done = e.target.value; rpAt(e.target); e.target.blur(); } });
    $('aml-rp-at').addEventListener('change', e => { if (e.target._done === e.target.value) { e.target._done = null; return; } rpAt(e.target); });
    $('aml-rp-at').addEventListener('input', e => e.target.classList.remove('bad'));
    $('aml-rp-at').addEventListener('focus', e => e.target.select());
    // the range of the Flights panel
    const fr = $('aml-fl-rng');
    flRange = +lsGet('ms_app_mlm_flrange', '24'); if (![3, 6, 12, 24].includes(flRange)) flRange = 24;
    fr.value = String(flRange); fr.dispatchEvent(new Event('change'));        // the chips follow
    fr.addEventListener('change', () => { flRange = +fr.value; lsSet('ms_app_mlm_flrange', fr.value); renderFlights(); });
    $('aml-trf').addEventListener('click', e => { const tr = e.target.closest('tr[data-k]'); if (tr) pick(tr.dataset.k, true); });
    $('aml-fl').addEventListener('click', e => {
      const tr = e.target.closest('tr[data-i]'), f = tr && RP.flights[+tr.dataset.i];
      if (!f) return;
      sel = f.icao;
      setOpt('solo', true);
      if (!S.amb) setOpt('amb', true);                                       // its unresolved stretches too
      rpGo(f.t0 + 2, true);
      $('v-mlat').scrollTo({ top: 0, behavior: 'smooth' });
    });
    $('aml-pick').addEventListener('click', () => { if (sel) pick(sel, false); });
    new MutationObserver(() => { setTiles(); ilsShow(); gridDraw(); draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && on && !RP.on) poll(false); });
  }

  // ── map ─────────────────────────────────────────────────────────────────
  function savedView() {
    try {
      const v = JSON.parse(lsGet(VIEW_KEY, 'null'));
      if (v && Number.isFinite(v.lat) && Number.isFinite(v.lon) && Number.isFinite(v.z) && Math.abs(v.lat) <= 85 && Math.abs(v.lon) <= 180 && v.z >= 4 && v.z <= 15) return v;
    } catch (_) { /* a broken value: the default view */ }
    return null;
  }
  function setTiles() {
    if (!map) return;
    const tk = light() ? 'l' : 'd';
    if (tiles && tileKey === tk) return;
    if (tiles) tiles.remove();
    const key = (typeof CARTO_API_KEY !== 'undefined' && CARTO_API_KEY) ? `?key=${encodeURIComponent(CARTO_API_KEY)}` : '';
    tiles = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${tk === 'l' ? 'light_all' : 'dark_all'}/{z}/{x}/{y}{r}.png${key}`,
      { attribution: '© OSM © CARTO', subdomains: 'abcd', maxZoom: 15 }).addTo(map);
    tileKey = tk;
  }
  function initMap() {
    if (map || !window.L) return;
    const sv = savedView();
    map = L.map('aml-map', { zoomControl: true, preferCanvas: true, attributionControl: true, minZoom: 4, maxZoom: 15 })
           .setView(sv ? [sv.lat, sv.lon] : (centre || [60.317, 24.963]), sv ? sv.z : HOME_ZOOM);
    map._amlCentred = !!sv || !!centre;
    map.attributionControl.setPrefix(false);
    map.on('moveend', () => {
      if (!map.getSize().x) return;
      const c = map.getCenter();
      lsSet(VIEW_KEY, JSON.stringify({ lat: +c.lat.toFixed(4), lon: +c.lng.toFixed(4), z: map.getZoom() }));
    });
    const Home = L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const box = L.DomUtil.create('div', 'leaflet-bar ms-map-home');
        const a = L.DomUtil.create('a', '', box);
        a.href = '#'; a.title = 'Back to the default view';
        a.setAttribute('role', 'button'); a.setAttribute('aria-label', a.title);
        a.innerHTML = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">'
          + '<path d="M2.5 7.5 8 2.5l5.5 5M4 6.6V13.5h3V10h2v3.5h3V6.6" fill="none" stroke="currentColor" '
          + 'stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>';
        L.DomEvent.disableClickPropagation(box);
        L.DomEvent.on(a, 'click', e => { L.DomEvent.preventDefault(e); map.setView(centre || [60.317, 24.963], HOME_ZOOM); });
        return box;
      },
    });
    new Home().addTo(map);
    renderer = L.canvas({ padding: 0.3 });
    setTiles();
    map.createPane('amlGrid').style.zIndex = 350;               // the accuracy grid: under everything drawn
    map.getPane('amlGrid').style.pointerEvents = 'none';
    gridLayer = L.layerGroup().addTo(map);
    if (S.grid) gridLoad();
    map.createPane('amlHist').style.zIndex = 390;               // the long trails: under the tracks of the last hour
    map.getPane('amlHist').style.pointerEvents = 'none';
    histRend = L.canvas({ pane: 'amlHist', padding: 0.3 });
    histLayer = L.layerGroup().addTo(map);
    layer = L.layerGroup().addTo(map);
    if (typeof AtcDisplay !== 'undefined') atc = AtcDisplay.canvasLayer(map, drawTargets);
    if (window.msRxMarkers) { try { window.msRxMarkers(map).addTo(map); } catch (_) { /* the receivers are optional */ } }
    L.control.scale({ imperial: false, nautic: false }).addTo(map);
    ilsShow();
  }
  async function ilsShow() {
    const my = ++ilsSeq;
    if (!map) return;
    if (S.ils && !ilsGeo) {
      const [ils, apt] = await Promise.all(['efhk_ils', 'efhk_apt'].map(n => fetch(`/overlays/${n}.geojson`).then(r => r.ok ? r.json() : null).catch(() => null)));
      ilsGeo = { ils, apt };
    }
    if (my !== ilsSeq) return;
    if (ilsLayer) { ilsLayer.remove(); ilsLayer = null; }
    ilsFeat = [];
    if (!S.ils || !ilsGeo) { if (atc) atc.redraw(); return; }
    const lt = light(), grp = L.layerGroup(), rend = L.canvas({ pane: map.getPane('atcMapPane') ? 'atcMapPane' : 'overlayPane', padding: 0.3 });
    if (ilsGeo.apt) L.geoJSON(ilsGeo.apt, { renderer: rend, interactive: false, style: { color: lt ? '#475569' : '#94a3b8', weight: 1, opacity: lt ? 0.7 : 0.5, fillOpacity: 0 } }).addTo(grp);
    if (ilsGeo.ils) {
      ilsFeat = (ilsGeo.ils.features || []).filter(f => f.properties && f.properties.airport === 'EFHK');
      L.geoJSON({ type: 'FeatureCollection', features: ilsFeat }, { renderer: rend, interactive: false,
        style: f => f.properties && f.properties.approach_type === 'RNP'
          ? { color: lt ? '#92400e' : '#f59e0b', weight: 1.5, opacity: lt ? 0.9 : 0.7, dashArray: '10 5', fillOpacity: 0 }
          : { color: lt ? '#1a3a6b' : '#38bdf8', weight: 1.5, opacity: lt ? 0.9 : 0.6, dashArray: '6 5', fillOpacity: 0 } }).addTo(grp);
    }
    ilsLayer = grp.addTo(map);
    if (atc) atc.redraw();
  }
  function ensureMap() {
    if (map || libFail) return;
    if (!libs) {
      libs = loadLeaflet().then(() => loadAtc().catch(() => {})).then(() => {
        $('aml-mapmsg').hidden = true;
        initMap(); draw();
        setTimeout(() => map && map.invalidateSize(), 60);
      }).catch(() => {
        libs = null; libFail = true;
        $('aml-mapmsg').hidden = false; $('aml-mapmsg').textContent = 'The map could not be loaded — the lists below still work.';
      });
    }
  }

  // ── data ────────────────────────────────────────────────────────────────
  async function poll(full) {
    clearTimeout(timer);
    if (!on || RP.on) return;
    if (document.hidden) { timer = setTimeout(() => poll(false), POLL); return; }
    // a full answer at the start and once a minute: the server drops the points of a
    // candidate position that turned out to be the wrong one of two
    if (full) { AC.clear(); last = 0; nPoll = 0; }
    const whole = !last || (++nPoll % 12 === 0);
    try {
      const r = await fetch(`/api/mlat/fixes?win=${Math.min(S.win, DETAIL)}${whole ? '' : '&since=' + last}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      if (RP.on || !on) return;                      // the replay was started, or the view left, meanwhile
      state = d; failed = false;
      fxNote(d);
      if (d.on) merge(d, whole);
      const c = d.counters || {};
      rate = lastCnt && d.now > lastCnt.t ? (c.fix - lastCnt.fix) / (d.now - lastCnt.t) : rate;
      lastCnt = { t: d.now, fix: c.fix };
    } catch (e) { failed = true; }
    if (on && !RP.on) { render(); timer = setTimeout(() => poll(false), POLL); }
  }
  function merge(d, whole) {
    if (d.center) centre = d.center;
    if (map && !map._amlCentred && centre) { map.setView(centre, HOME_ZOOM); map._amlCentred = true; }
    const seen = new Set();
    for (const a of d.aircraft || []) {
      seen.add(a.icao);
      let o = AC.get(a.icao);
      if (!o) { o = { trk: [], adsb: [] }; AC.set(a.icao, o); }
      Object.assign(o, { cs: a.cs, typ: a.typ, reg: a.reg, pos: a.pos, np0: a.np0, res: a.res, n: a.n, nrx: a.nrx, err: a.err, last: a.last, vel: a.vel, vr: a.vr, sal: a.sal,
                         mm: a.mm, nh: a.nh, tage: a.tage, doubt: a.doubt });
      if (whole) { o.trk = a.trk || []; o.adsb = a.adsb || []; continue; }
      const t1 = o.trk.length ? o.trk[o.trk.length - 1][0] : 0, t2 = o.adsb.length ? o.adsb[o.adsb.length - 1][0] : 0;
      for (const p of a.trk || []) if (p[0] > t1) o.trk.push(p);
      for (const p of a.adsb || []) if (p[0] > t2) o.adsb.push(p);
    }
    const t0 = d.now - Math.min(S.win, DETAIL);
    for (const [k, o] of AC) {
      if (!seen.has(k)) { AC.delete(k); continue; }
      while (o.trk.length && o.trk[0][0] < t0) o.trk.shift();
      while (o.adsb.length && o.adsb[0][0] < t0) o.adsb.shift();
    }
    last = d.now;
  }

  // ── drawing ─────────────────────────────────────────────────────────────
  const name = (k, o) => o.cs && o.cs !== k ? o.cs : k;
  const shown = (k, o) => o.last && (S.amb || !o.last[6]) && (!S.solo || !sel || sel === k);
  const TA = () => (state && state.ta_ft) || 5000;
  const onQnh = pa => { const q = state && state.qnh; if (q == null || pa == null) return null; const a = pa - (1013.25 - q) * 27; return a <= TA() ? a : null; };
  const h3 = v => String(Math.max(0, Math.round(v / 100))).padStart(3, '0');
  const fl3 = pa => { const a = onQnh(pa); return h3(a == null ? pa : a); };
  const lvl = pa => { if (pa == null) return '—'; const a = onQnh(pa); return a == null ? 'FL' + h3(pa) : 'A' + h3(a); };
  const mTxt = v => v == null ? '—' : v >= 10000 ? (v / 1000).toFixed(0) + ' km' : v >= 1000 ? (v / 1000).toFixed(1) + ' km' : Math.round(v) + ' m';

  // ── long trails (from the evening of 2026-11-20) ────────────────────────
  // The engine keeps an hour of each track.  A trail of 3 h or more takes its older part from the stored tracks,
  // thinned by the server (/api/mlat/trails: one point of each aircraft per step) and drawn as thinner lines under
  // the detailed last hour.  The picture's time is state.now — the present, or the replay time; a little more than
  // the trail is fetched on both sides, so that steps in a replay need no new request.
  const DETAIL = 3600;                         // s of full-detail trail: the engine's memory
  const HIST = { step: 0, from: 0, to: 0, ac: new Map(), busy: false, ver: 0, key: null, fail: 0 };
  let histLayer = null, histRend = null;
  const histStep = w => w <= 21600 ? 10 : w <= 43200 ? 20 : 30;
  function histClear() { HIST.step = 0; HIST.from = HIST.to = 0; HIST.ac.clear(); HIST.ver++; }
  async function histFetch(a, b, step, append) {
    HIST.busy = true;
    try {
      const r = await fetch(`/api/mlat/trails?from=${Math.floor(a / step) * step}&to=${Math.ceil(b)}&step=${step}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      if (d.on && S.win > DETAIL && histStep(S.win) === step) {
        if (!append) { HIST.ac.clear(); HIST.from = d.from; }
        for (const k in d.aircraft) {
          const n = d.aircraft[k];
          let o = HIST.ac.get(k);
          if (!o) { o = { pos: false, p: [] }; HIST.ac.set(k, o); }
          if (n.pos) o.pos = true;
          const tl = o.p.length ? o.p[o.p.length - 1][0] : 0;
          for (const p of n.p) if (p[0] > tl) o.p.push(p);
        }
        if (append && state) {                       // live: what the trail has left behind goes
          const old = state.now - S.win - 3600;
          if (old > HIST.from) {
            for (const [k, o] of HIST.ac) { const i = o.p.findIndex(p => p[0] >= old); if (i < 0) HIST.ac.delete(k); else if (i > 0) o.p = o.p.slice(i); }
            HIST.from = old;
          }
        }
        HIST.step = step; HIST.to = d.to; HIST.ver++; HIST.fail = 0;
      } else if (!d.on) HIST.fail = Date.now();
    } catch (_) { HIST.fail = Date.now(); }
    HIST.busy = false;
    if (on) draw();
  }
  function histCheck() {
    if (S.win <= DETAIL || !state || !state.on) { if (HIST.step) histClear(); return; }
    const step = histStep(S.win), t = state.now, a = t - S.win, b = t - DETAIL + 600;       // ten minutes shared with the detailed hour
    if (HIST.busy || Date.now() - HIST.fail < 15000) return;
    const cover = HIST.step === step && HIST.from <= a + step;
    if (cover && HIST.to >= b) return;
    const more = Math.min(S.win / 4, 3 * 3600);
    if (cover && HIST.to > a) histFetch(HIST.to, t + more, step, true);
    else histFetch(a - more, t + more, step, false);
  }
  function histDraw() {
    if (!histLayer) return;
    const on = S.win > DETAIL && HIST.step && state && state.on;
    const key = on ? [HIST.ver, S.win, S.exp, S.amb, S.solo, sel, light(), Math.floor(state.now / 60)].join('|') : 'off';
    if (key === HIST.key) return;                    // drawn again only when something changed, or once a minute
    HIST.key = key;
    histLayer.clearLayers();
    if (!on) return;
    const C = COL(), a = state.now - S.win, b = state.now - DETAIL + 300, gap = Math.max(3 * HIST.step, 60);
    for (const [k, o] of HIST.ac) {
      if (S.solo && sel && sel !== k) continue;
      const col = o.pos ? C.pos : C.nopos, isSel = sel === k;
      let seg = [], pt = null, dash = false;
      const flush = () => { if (seg.length > 1) L.polyline(seg, { renderer: histRend, color: col, weight: isSel ? 2.5 : 1.3, opacity: isSel ? 0.9 : 0.6, dashArray: dash ? '3 5' : null, interactive: false }).addTo(histLayer); seg = []; };
      for (const p of o.p) {
        if (p[0] < a) continue;
        if (p[0] > b) break;
        const ok = (p[3] == null || p[3] <= S.exp) && (S.amb || !p[4]);
        if (!ok || (pt && (p[0] - pt[0] > gap || !!p[4] !== dash))) flush();
        if (ok) { if (!seg.length) dash = !!p[4]; seg.push([p[1], p[2]]); pt = p; }
      }
      flush();
    }
  }
  // ── accuracy grid (from the evening of 2026-11-20) ──────────────────────
  // Five classes of the median error, one hue, the larger the error the stronger (as on the web map)
  const GRID_CL = [50, 100, 250, 500];
  const GRID_COL = () => light() ? ['#ddd6fe', '#c4b5fd', '#8b5cf6', '#6d28d9', '#4c1d95'] : ['#3b2a6b', '#5b3fb0', '#7c5ce0', '#a78bfa', '#ddd6fe'];
  let gridLayer = null, gridData = null, gridT = 0;
  async function gridLoad() {
    gridT = Date.now();
    const h = S.grid;
    if (!h) { gridData = null; gridDraw(); return; }
    try {
      const d = await (await fetch('/api/mlat/grid?hours=' + h, { cache: 'no-store' })).json();
      if (h !== S.grid) return;                      // changed meanwhile: the newer request draws
      gridData = d.on ? { cells: d.grid || {}, cell: d.cell, rng: h === 168 ? '7 d' : h + ' h' } : null;
    } catch (_) { /* keeps the last grid */ }
    gridDraw();
  }
  function gridDraw() {
    const leg = $('aml-gridleg');
    leg.hidden = !(S.grid && gridData);
    if (!leg.hidden) leg.innerHTML = `<span>median error, ${gridData.rng}</span>` + GRID_COL().map((c, i) => `<b style="background:${c}"></b>${i < 4 ? '≤ ' + GRID_CL[i] : '> 500'}`).join('') + ' m';
    if (!gridLayer) return;
    gridLayer.clearLayers();
    if (!S.grid || !gridData) return;
    const [dla, dlo] = gridData.cell, col = GRID_COL();
    for (const [k, g] of Object.entries(gridData.cells)) {
      const [i, j] = k.split(',').map(Number), q = GRID_CL.findIndex(x => g[1] <= x);
      const c = g[1] == null ? null : col[q < 0 ? 4 : q];
      L.rectangle([[i * dla, j * dlo], [(i + 1) * dla, (j + 1) * dlo]], { pane: 'amlGrid', stroke: false, fillColor: c || '#94a3b8', fillOpacity: c ? 0.6 : 0.25, interactive: false }).addTo(gridLayer);
    }
  }
  // Misfit positions (from 2026-11-22 on the phone; the Statistics page's map has had them from 2026-11-21): aircraft
  // whose broadcast position does not fit the time stamps of the GPS-timed receivers (/api/mlat/suspects), drawn
  // where they SAY they are — a dotted ring, with a dotted line to our own fix when there is one.  A tap on a ring
  // tells which aircraft in the line under the map (a tooltip would go with the next redraw).
  let susData = null, susT = 0, susSel = null;
  const SUS_SHOW = 120;                        // s: a misfit is drawn this long after it last failed the check
  async function susLoad() {
    susT = Date.now();
    try { const d = await (await fetch('/api/mlat/suspects', { cache: 'no-store' })).json(); susData = d.on ? d : null; } catch (_) { /* keeps the last */ }
    if (S.sus) draw();
  }
  function susLegend(n) {
    const el = $('aml-susleg');
    if (!el) return;
    el.hidden = !(S.sus && !RP.on && state && state.on);
    if (el.hidden) return;
    const a = n && susSel && susData ? susData.aircraft.find(x => x.icao === susSel && x.bc && state.now - x.t <= SUS_SHOW) : null;
    if (!a) susSel = null;
    el.textContent = a ? `${a.cs || a.reg || a.icao}${a.reg && a.cs ? ' · ' + a.reg : ''} · ${a.icao}: the position it broadcasts does not fit the receivers’ timing — at least ${a.min_km} km off`
        + (a.km != null ? `; our fix is ${a.km} km from it.` : '; no fix of our own to compare with.')
      : n ? `Dotted ring: a broadcast position that does not fit the receivers’ timing (${n} now) — the dotted line goes to our fix. Tap a ring for the aircraft.`
      : 'Misfit positions: none in the last two minutes.';
  }
  function draw() {
    if (!map || !layer) return;
    histCheck(); histDraw();
    if (S.grid && Date.now() - gridT > 60000) gridLoad();
    if (S.sus && !RP.on && Date.now() - susT > 15000) susLoad();
    layer.clearLayers();
    if (!state || !state.on) { susLegend(0); if (atc) atc.redraw(); return; }
    const C = COL(), now = state.now;
    for (const [k, o] of AC) {
      if (!shown(k, o)) continue;
      const col = o.pos ? C.pos : C.nopos, isSel = sel === k, amb = !!o.last[6];
      if (S.adsb && o.adsb.length > 1) L.polyline(o.adsb.map(p => [p[1], p[2]]), { renderer, color: C.adsb, weight: isSel ? 2 : 1, opacity: 0.9, interactive: false }).addTo(layer);
      // the track, broken where the expected error is over the limit, the fix unresolved or the points far apart in time
      let seg = [], pt = null;
      const flush = () => { if (seg.length > 1) L.polyline(seg, { renderer, color: col, weight: isSel ? 3.5 : 2, opacity: 0.95, dashArray: amb ? '4 5' : null, interactive: false }).addTo(layer); seg = []; };
      for (const p of o.trk) {
        const ok = (p[4] == null || p[4] <= S.exp) && (S.amb || !p[6]);
        if (!ok || (pt && p[0] - pt[0] > 30)) flush();
        if (ok) { seg.push([p[1], p[2]]); pt = p; }
      }
      flush();
      const lp = o.last;
      if ((lp[4] != null && lp[4] > S.exp) || now - lp[0] > 60) continue;
      if (S.adsb && o.adsb.length) {
        const ap = o.adsb[o.adsb.length - 1];
        if (Math.abs(ap[0] - lp[0]) < 4) L.polyline([[lp[1], lp[2]], [ap[1], ap[2]]], { renderer, color: C.link, weight: 1.5, opacity: 0.9, interactive: false }).addTo(layer);
      }
      // the target itself is drawn on the canvas (drawTargets); this invisible disc takes the tap
      L.circleMarker([lp[1], lp[2]], { renderer, radius: 15, stroke: false, fillOpacity: 0 }).addTo(layer).on('click', () => pick(k, false));
      if (!atc) L.circleMarker([lp[1], lp[2]], { renderer, radius: 4, color: col, weight: 1.5, fillOpacity: 0, interactive: false }).addTo(layer);
    }
    // the misfit rings last, over the aircraft's tap areas (a ring often lies on its own aircraft): a tap on a ring
    // names the aircraft under the map and, when it is in the picture, selects it
    let nSus = 0;
    if (S.sus && susData && !RP.on) {
      for (const a of susData.aircraft) {
        if (!a.bc || now - a.t > SUS_SHOW) continue;
        nSus++;
        if (a.own) L.polyline([a.bc, [a.own[0], a.own[1]]], { renderer, color: C.link, weight: 1.5, dashArray: '2 5', opacity: 0.9, interactive: false }).addTo(layer);
        L.circleMarker(a.bc, { renderer, radius: 11, color: C.link, weight: susSel === a.icao ? 3 : 2, dashArray: '2 4', fillOpacity: 0, bubblingMouseEvents: false }).addTo(layer)
          .on('click', () => {
            const was = susSel === a.icao;
            susSel = was ? null : a.icao;
            if (AC.has(a.icao) && (sel === a.icao) === was) pick(a.icao, false); else draw();
          });
      }
    }
    susLegend(nSus);
    if (atc) atc.redraw();
  }
  function drawTargets(g, m, W, H) {
    if (!state || !state.on) return;
    const C = COL(), now = state.now, items = [];
    const obst = AtcDisplay.domObstacles(m, '#aml-map .leaflet-control-zoom, #aml-map .ms-map-home, #aml-map .leaflet-control-attribution, #aml-map .leaflet-control-scale');
    if (S.ils && ilsFeat.length) for (const r of AtcDisplay.lineObstacles(m, ilsFeat, W, H)) obst.push(r);     // labels keep clear of the finals
    for (const [k, o] of AC) {
      if (!shown(k, o)) continue;
      const lp = o.last;
      if ((lp[4] != null && lp[4] > S.exp) || now - lp[0] > 60) continue;
      const p = m.latLngToContainerPoint([lp[1], lp[2]]);
      if (p.x < -40 || p.y < -40 || p.x > W + 40 || p.y > H + 40) continue;
      const col = o.pos ? C.pos : C.nopos, isSel = sel === k, sz = isSel ? 9 : 8;
      const ac = { lat: lp[1], lon: lp[2], altitude: lp[3], icao: k, aircraft_type: o.typ, vert_rate: o.vr,
                   groundspeed: o.vel ? o.vel[0] : null, track: o.vel ? o.vel[1] : null, sel_alt: o.sal };
      if (S.vec) AtcDisplay.drawVector(g, m, p, ac, VEC_SEC, col, 0.95, 1.5, obst);
      g.globalAlpha = 1;
      g.strokeStyle = col; g.lineWidth = isSel ? 1.8 : 1.5;
      g.setLineDash(lp[6] ? [2, 2] : []);
      g.strokeRect(Math.round(p.x - sz / 2) + 0.5, Math.round(p.y - sz / 2) + 0.5, sz, sz);
      g.setLineDash([]);
      if (!o.pos) { g.fillStyle = col; g.fillRect(p.x - 1.5, p.y - 1.5, 3, 3); }      // no position of its own: a dot inside
      if (isSel) { g.globalAlpha = 0.75; g.lineWidth = 1; g.strokeRect(Math.round(p.x - sz / 2 - 4) + 0.5, Math.round(p.y - sz / 2 - 4) + 0.5, sz + 8, sz + 8); g.globalAlpha = 1; }
      if (S.lbl) items.push({ key: k, p, lines: AtcDisplay.labelLines(ac, S.sal ? 'full' : 'std', name(k, o), fl3), col, sel: isSel, fade: 1, alt: lp[3] });
    }
    if (items.length) AtcDisplay.drawLabels(g, items, W, H, obst, lblPos, 11, { halo: light() ? 'rgba(255,255,255,.9)' : 'rgba(11,18,32,.9)', leader: C.adsb });
  }

  // ── replay ──────────────────────────────────────────────────────────────
  const utc = (t, date) => { const d = new Date(t * 1000), z = n => String(n).padStart(2, '0');
    return (date ? `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ` : '') + `${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())}`; };
  async function rpRange(force) {
    if (!force && Date.now() - RP.rangeT < 60000) return;
    RP.rangeT = Date.now();
    try {
      const r = await fetch('/api/mlat/replay/flights', { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      RP.hours = d.hours;
      RP.got = true;                                 // an answer has come: an empty list now means that nothing is stored
      if (!d.on || d.t0 == null) { RP.t0 = RP.t1 = null; RP.flights = []; renderFlights(); return; }
      RP.t0 = d.t0; RP.t1 = d.t1; RP.flights = d.flights || [];
      const sl = $('aml-rp-sl'); sl.min = Math.floor(d.t0); sl.max = Math.ceil(d.t1);
      if (!RP.on) sl.value = sl.max;
      renderFlights();
    } catch (_) { /* tried again in a minute */ }
  }
  async function rpFetch(c) {
    if (RP.chunks.has(c) || RP.wait.has(c)) return;
    RP.wait.add(c);
    try {
      const r = await fetch(`/api/mlat/replay?from=${c * RP_CHUNK}&to=${(c + 1) * RP_CHUNK}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      // a chunk that reaches the present is not complete yet: it is fetched again later
      if (d.on) RP.chunks.set(c, { ac: d.aircraft || {}, qnh: d.qnh, center: d.center, ta: d.ta_ft, open: RP.t1 != null && (c + 1) * RP_CHUNK > RP.t1, at: Date.now() });
      if (RP.chunks.size > 20) {                     // the farthest from the replay time go
        const here = Math.floor(RP.t / RP_CHUNK);
        for (const k of [...RP.chunks.keys()].sort((a, b) => Math.abs(b - here) - Math.abs(a - here)).slice(0, RP.chunks.size - 20)) RP.chunks.delete(k);
      }
    } catch (_) { /* asked again by the next frame */ }
    RP.wait.delete(c);
    if (RP.on && on) rpFrame();
  }
  // The picture at the replay time: the stored points of the trail's length up to it, in the form the live code draws
  function rpFrame() {
    if (!RP.on) return;
    const t = RP.t, from = t - Math.min(S.win, DETAIL), c0 = Math.floor(from / RP_CHUNK), c1 = Math.floor(t / RP_CHUNK);
    let meta = RP.meta, missing = false;
    const acc = new Map();
    for (let c = c0; c <= c1; c++) {
      const ch = RP.chunks.get(c);
      if (!ch) { missing = true; rpFetch(c); continue; }
      if (ch.open && Date.now() - ch.at > 30000) { RP.chunks.delete(c); rpFetch(c); }
      if (c === c1) meta = RP.meta = ch;
      for (const k in ch.ac) {
        const a = ch.ac[k];
        let o = acc.get(k);
        if (!o) { o = { cs: a.cs, typ: a.typ, reg: a.reg, pos: !!a.pos, trk: [], adsb: [] }; acc.set(k, o); }
        if (a.cs) o.cs = a.cs; if (a.typ) o.typ = a.typ; if (a.reg) o.reg = a.reg; if (a.pos) o.pos = true;
        for (const p of a.p) {
          if (p[0] < from || p[0] > t) continue;
          o.trk.push([p[0], p[1], p[2], p[3], p[4], p[6], p[5], p[9], null, p[10], p[11]]);
          if (p[7] != null) o.adsb.push([p[0], p[7], p[8]]);
        }
      }
    }
    if (c1 + 1 <= Math.floor((RP.t1 || t) / RP_CHUNK)) rpFetch(c1 + 1);      // the next chunk ahead of the play
    AC.clear();
    for (const [k, o] of acc) {
      if (!o.trk.length) continue;
      const lp = o.trk[o.trk.length - 1];
      o.last = lp.slice(0, 7);
      o.vel = lp[7] != null && lp[9] != null ? [lp[7], lp[9]] : null;
      const old = o.trk.find(p => lp[0] - p[0] <= 30);                       // climb or descent over the last half minute
      o.vr = old && lp[0] - old[0] >= 10 && lp[3] != null && old[3] != null ? (lp[3] - old[3]) / (lp[0] - old[0]) * 60 : null;
      const er = o.trk.slice(-30).map(p => p[5]).filter(v => v != null).sort((a, b) => a - b);
      o.err = er.length ? er[Math.floor(er.length / 2)] : null;
      o.n = o.trk.length; o.nrx = null; o.res = !lp[6]; o.sal = lp[10] == null ? null : lp[10];
      AC.set(k, o);
    }
    state = { on: true, now: t, qnh: meta ? meta.qnh : null, ta_ft: meta ? meta.ta : 5000, center: meta ? meta.center : null, replay: true };
    if (state.center) centre = state.center;
    if (map && !map._amlCentred && centre) { map.setView(centre, HOME_ZOOM); map._amlCentred = true; }
    RP.missing = missing;
    $('aml-rp-t').textContent = utc(t);              // UTC; the day is in the sub line under the title
    if (document.activeElement !== $('aml-rp-at')) $('aml-rp-at').value = utc(t).slice(0, 5);
    if (document.activeElement !== $('aml-rp-sl')) $('aml-rp-sl').value = Math.round(t);
    render();
  }
  function rpUi() {
    $('aml-rp').classList.toggle('rp', RP.on);
    $('aml-rp-live').classList.toggle('on', !RP.on);
    $('aml-rp-play').classList.toggle('on', RP.on && RP.play);
    $('aml-rp-play').textContent = RP.on && RP.play ? '❚❚' : '▶';
    $('aml-rp-play').setAttribute('aria-label', RP.on && RP.play ? 'Pause the replay' : 'Play the replay');
    if (RP.on) showMsg(null);
    if (!RP.on) { $('aml-rp-t').textContent = 'Live'; $('aml-rp-at').value = ''; if (RP.t1 != null) $('aml-rp-sl').value = $('aml-rp-sl').max; }
  }
  function rpLoop() {
    clearInterval(RP.tick);
    if (!RP.on) return;
    RP.wall = performance.now();
    RP.tick = setInterval(() => {
      const w = performance.now(), dt = (w - RP.wall) / 1000; RP.wall = w;
      if (!RP.on || !on || document.hidden) return;
      if (RP.play) {
        RP.t += dt * RP.speed;
        if (RP.t1 != null && RP.t >= RP.t1) { rpRange(false); if (RP.t >= RP.t1 + 5) return rpLive(); }   // the present is reached
        rpFrame();
      }
    }, 250);
  }
  // Enter the replay at a time (or move in it); the range is asked for first when it is not known
  async function rpGo(t, play) {
    if (RP.t0 == null) await rpRange(true);
    if (RP.t0 == null) { $('aml-rp-t').textContent = 'nothing stored yet'; return; }
    clearTimeout(timer);
    RP.on = true;
    RP.t = Math.max(RP.t0, Math.min(t, RP.t1));
    if (play != null) RP.play = play;
    rpUi(); rpFrame(); rpLoop(); rpRange(false);
  }
  // Start the replay at a clock time (UTC).  The store holds the last 24 hours, so a clock time is in it once: the
  // latest moment with that time that is not after the newest stored point (a time later than now is yesterday's)
  // The field is plain text, not a time picker: a picker shows AM / PM in some browsers, and the time is UTC.
  // Accepts 14:00, 14.00, 1400, 930 and 14; returns [h, m] or null
  const hhmm = v => { const m = /^\s*(\d{1,2})(?:[:.,h ]?(\d{2}))?\s*$/.exec(v || ''); return m && +m[1] <= 23 && +(m[2] || 0) <= 59 ? [+m[1], +(m[2] || 0)] : null; };
  async function rpAt(el) {
    const m = hhmm(el.value);
    el.classList.toggle('bad', !m && el.value.trim() !== '');
    if (!m) return;
    await rpRange(RP.t0 == null);
    if (RP.t0 == null) { $('aml-rp-t').textContent = 'nothing stored yet'; return; }
    const ref = RP.t1, d = new Date(ref * 1000);
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), m[0], m[1]) / 1000;
    if (t > ref) t -= 86400;
    rpGo(t, true);
  }
  function rpLive() {
    if (!RP.on) return;
    RP.on = false; RP.play = false; RP.meta = null;
    clearInterval(RP.tick);
    rpUi();
    poll(true);
  }

  // ── the line of the selected aircraft and the panels ────────────────────
  const nmFrom = (lat, lon) => {
    const c = centre; if (!c) return null;
    const r = Math.PI / 180, dlat = (lat - c[0]) * r, dlon = (lon - c[1]) * r;
    const a = Math.sin(dlat / 2) ** 2 + Math.cos(c[0] * r) * Math.cos(lat * r) * Math.sin(dlon / 2) ** 2;
    return 3440.065 * 2 * Math.asin(Math.sqrt(a));
  };
  const repGs = o => { const p = o.trk.length ? o.trk[o.trk.length - 1] : null; return p && p[8] != null ? p[8] : null; };
  const stateOf = o => o.last[6] ? (RP.on ? 'unresolved' : o.doubt ? 'in doubt' : o.nh > 1 ? 'unresolved' : 'new') : 'resolved';
  const dur = s => s == null ? '—' : s < 60 ? s + ' s' : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  const liveRows = () => [...AC.entries()].filter(([, o]) => o.last && state.now - o.last[0] <= 60);
  function pick(k, pan) {
    const o = AC.get(k);
    sel = sel === k ? null : k;
    if (pan && sel && o && o.last && map) { map.panTo([o.last[1], o.last[2]]); $('v-mlat').scrollTo({ top: 0, behavior: 'smooth' }); }
    if (pan && sel && o && o.last && o.last[6] && !S.amb) setOpt('amb', true);
    draw(); renderLists();
  }
  function renderPick() {
    const el = $('aml-pick'), o = sel && AC.get(sel);
    el.classList.toggle('on', !!sel);
    if (!state) { el.textContent = failed ? 'No answer from the server.' : 'Loading…'; return; }
    if (!state.on) { el.textContent = 'Position fixes are off: ' + (state.why || 'not available on this server'); return; }
    if (!sel) { el.textContent = 'Tap an aircraft on the map or in the list.'; return; }
    if (!o || !o.last) { el.innerHTML = `<b>${esc(sel)}</b> — not in the picture now${S.solo ? ' (Solo: nothing else is drawn)' : ''}<small>tap to release</small>`; return; }
    const p = o.last, C = COL();
    // with Misfit positions on: said here too, as the ring can lie under the aircraft's own tap area
    const ms = S.sus && susData && !RP.on ? susData.aircraft.find(a => a.icao === sel && a.bc && state.now - a.t <= SUS_SHOW) : null;
    el.innerHTML = `<b style="color:${o.pos ? C.pos : C.nopos}">${esc(name(sel, o))}</b> ${esc(o.typ || '')} · ${o.reg ? esc(o.reg) + ' · ' : ''}${esc(sel)} · ${lvl(p[3])}${onQnh(p[3]) != null ? ` (QNH ${Math.round(state.qnh)})` : ''}`
      + (o.sal != null ? ` · sel ${lvl(o.sal)}` : '') + (o.nrx ? ` · ${o.nrx} receivers` : '')
      + `\nstated ±${mTxt(p[4])}` + (o.err != null ? ` · measured ${mTxt(o.err)}` : o.pos ? '' : o.np0 ? ' · sends no position, and says so (type code 0)' : ' · sends no position')
      + ` · ${stateOf(o)}` + (o.mm != null ? ` · motion ${Math.round(o.mm)} m/s` : '')
      + (ms ? ` · the position it broadcasts does not fit the receivers’ timing: at least ${ms.min_km} km off` : '') + '<small>tap to release</small>';
  }
  function renderTraffic() {
    const box = $('aml-trf');
    if (!state || !state.on) { box.innerHTML = ''; $('aml-trf-n').textContent = ''; return; }
    const rows = liveRows().map(([k, o]) => [k, o, nmFrom(o.last[1], o.last[2])]).sort((a, b) => (a[2] == null ? 1e9 : a[2]) - (b[2] == null ? 1e9 : b[2]));
    const nop = rows.filter(r => !r[1].pos).length;
    $('aml-trf-n').textContent = rows.length ? `${rows.length} aircraft · ${nop} without own position` + (state.qnh != null ? ` · QNH ${Math.round(state.qnh)}` : '') : '';
    if (!rows.length) { box.innerHTML = '<div class="agn-none">No fixes in the last minute.</div>'; return; }
    const C = COL();
    box.innerHTML = '<table><thead><tr><th>Aircraft<small>registration · address · state</small></th><th class="num">Level<small>NM</small></th><th class="num">Speed<small>reported</small></th>'
      + '<th class="num">Stated<small>measured</small></th><th class="num">Motion<small>track</small></th></tr></thead><tbody>'
      + rows.map(([k, o, d]) => {
        const p = o.last, vr = o.vr, arrow = vr == null ? '' : vr >= 300 ? '↑' : vr <= -300 ? '↓' : '', rg = repGs(o), st = stateOf(o);
        return `<tr data-k="${esc(k)}"${sel === k ? ' class="sel"' : ''}>`
          + `<td><b style="color:${o.pos ? C.pos : C.nopos}">${esc(name(k, o))}</b> ${esc(o.typ || '')}<small>${o.reg ? esc(o.reg) + ' · ' : ''}${esc(k)} · <span${st === 'resolved' ? '' : ' class="w"'}>${st}</span>${o.pos ? '' : o.np0 ? ' · no position, says so' : ' · no position'}</small></td>`
          + `<td class="num">${lvl(p[3])}${arrow}${S.sal && o.sal != null ? ' ' + lvl(o.sal) : ''}<small>${d == null ? '—' : d.toFixed(d < 10 ? 1 : 0) + ' NM'}</small></td>`
          + `<td class="num">${o.vel ? Math.round(o.vel[0]) : '—'}<small>${rg == null ? '—' : Math.round(rg)}</small></td>`
          + `<td class="num">±${mTxt(p[4])}<small>${mTxt(o.err)}</small></td>`
          + `<td class="num${o.mm != null && o.mm > 25 ? ' w' : ''}">${o.mm == null ? '—' : Math.round(o.mm)}<small>${RP.on ? '—' : dur(o.tage)}</small></td></tr>`;
      }).join('') + '</tbody></table>';
  }
  function renderFixes() {
    const d = state, tile = (v, l) => `<div class="am-tile"><b>${v}</b><span>${l}</span></div>`;
    if (!d || !d.on) { ['aml-fx-tiles', 'aml-fx-bands', 'aml-fx-rx'].forEach(id => { $(id).innerHTML = ''; }); $('aml-fx-note').textContent = ''; return; }
    const live = liveRows().map(r => r[1]);
    if (d.replay) {
      const we = live.map(o => o.last[5]).filter(v => v != null && !isNaN(v)).sort((a, b) => a - b);
      $('aml-fx-tiles').innerHTML = tile(utc(d.now).slice(0, 5), 'replay, UTC') + tile(live.length, 'aircraft') + tile(live.filter(o => !o.pos).length, 'no own position')
        + tile(we.length ? mTxt(we[Math.floor(we.length / 2)]) : '—', 'median error now');
      $('aml-fx-bands').innerHTML = ''; $('aml-fx-rx').innerHTML = '';
      $('aml-fx-note').textContent = 'Replay of the stored tracks: one point of each aircraft every two seconds, as they were shown at the time. The errors by distance and the receivers’ clocks are shown in Live only.';
      return;
    }
    const c = d.counters || {}, st = d.bands || [], near = st.filter(b => b.hi != null && b.hi <= 20 && b.n);
    const nearMed = near.length ? Math.round(near.reduce((s, b) => s + b.med * b.n, 0) / near.reduce((s, b) => s + b.n, 0)) : null;
    const unr = live.filter(o => o.last[6]).length;
    $('aml-fx-tiles').innerHTML = tile(rate == null ? '…' : (rate < 10 ? rate.toFixed(1) : Math.round(rate)) + '<small> /s</small>', 'position fixes')
      + tile(live.length, 'aircraft, last minute' + (unr ? ` <small>(${unr} unresolved)</small>` : ''))
      + tile(live.filter(o => !o.pos).length, 'send no position of their own')
      + tile(nearMed == null ? '—' : nearMed + ' m', 'median error within 20 NM');
    $('aml-fx-bands').innerHTML = st.length ? '<table><thead><tr><th>From the airport</th><th class="num">Fixes</th><th class="num">Half within</th><th class="num">90 %</th><th class="num">Track</th></tr></thead><tbody>'
      + st.map(b => `<tr><td>${b.lo}${b.hi == null ? ' NM +' : '–' + b.hi + ' NM'}</td><td class="num">${b.n}</td><td class="num">${mTxt(b.med)}</td><td class="num">${mTxt(b.p90)}</td><td class="num">${mTxt(b.trk)}</td></tr>`).join('')
      + '</tbody></table>' : '<div class="agn-none">No fixes to compare yet.</div>';
    const ref = (d.receivers || []).find(x => x.gps);
    $('aml-fx-rx').innerHTML = '<table><thead><tr><th>Receiver</th><th>Clock</th><th>State</th></tr></thead><tbody>' + (d.receivers || []).map(r => {
      let s;
      if (r.rec_only) return `<tr><td>${esc(String(r.id).replace(/^MODES-/, ''))}</td><td>—</td><td class="aml-wrap">recorded only · not used for the fixes</td></tr>`;
      if (!r.site) s = `<span class="w">no antenna position${r.why ? ' (' + esc(r.why) + ')' : ''}</span>`;
      else if (r.gps) s = ref && r.bit === ref.bit ? 'time reference' : `constant ${r.bias > 0 ? '+' : ''}${r.bias} ns` + (r.bias_ac ? ` · from ${r.bias_ac} aircraft, 10 min` : '');
      else if (!r.clock) s = '<span class="w">no clock line yet</span>';
      else if (r.clock.hold != null && (r.clock.age == null || r.clock.age > 15)) s = `<span class="w">carried ${r.clock.hold} s without a reference · ±${r.clock.hold_sig} ns</span>`;
      else s = `line from ${r.clock.n} replies of ${r.clock.ac} aircraft` + (r.clock.ac === 1 && !r.clock.weak ? ' (one reference)' : '')
        + ` · ±${r.clock.sig} ns · drift ${(r.clock.drift / 1000).toFixed(3)} ppm`
        + (r.clock.weak ? ' · <span class="w">too weak for a fix</span>' : '')
        + (r.clock.age > 30 ? ` · <span class="w">no reference for ${Math.round(r.clock.age)} s</span>` : '');
      return `<tr><td>${esc(String(r.id).replace(/^MODES-/, ''))}</td><td>${r.gps ? 'GPS' : 'counter'}</td><td class="aml-wrap">${s}</td></tr>`;
    }).join('') + '</tbody></table>';
    const tried = c.tried || 0;
    $('aml-fx-note').textContent = `${d.delay} s behind · ${tried ? Math.round(100 * c.fix / tried) : 0} % of the tried replies gave a fix`
      + (d.stat_amb && d.stat_n ? ` · ${Math.round(100 * d.stat_amb / d.stat_n)} % unresolved` : '') + ` · processor ${d.cpu} %`;
  }
  let flKey = null;                            // what the list shows: it is rewritten only when that changes (a replay asks
                                               // 4 times a second, and a row rewritten under a finger loses the tap)
  function renderFlights() {
    const box = $('aml-fl');
    if (panel !== 'fl') { flKey = null; return; }
    const key = [RP.flights.length, RP.t1, RP.t0, !!RP.got, flRange, RP.on ? sel : '', light()].join('|');
    if (key === flKey) return;
    flKey = key;
    const t1 = RP.t1 != null ? RP.t1 : Date.now() / 1000;
    const rows = RP.flights.map((f, i) => [f, i]).filter(([f]) => f.t1 >= t1 - flRange * 3600);          // newest first, as the server sends them
    $('aml-fl-n').textContent = rows.length ? `${rows.length} in the last ${flRange} h` : '';
    if (!rows.length) { box.innerHTML = `<div class="agn-none">${RP.t0 == null ? (RP.got ? 'Nothing is stored for the replay yet.' : 'Loading…') : 'No aircraft located in the last ' + flRange + ' h.'}</div>`; return; }
    const C = COL();
    box.innerHTML = '<table><thead><tr><th>Aircraft<small>registration · address</small></th><th class="num">From – to, UTC</th><th class="num">Points</th></tr></thead><tbody>'
      + rows.slice(0, 400).map(([f, i]) => `<tr data-i="${i}"${RP.on && sel === f.icao ? ' class="sel"' : ''}>`
        + `<td><b style="color:${f.pos ? C.pos : C.nopos}">${esc(f.cs && f.cs !== f.icao ? f.cs : f.icao)}</b> ${esc(f.typ || '')}<small>${f.reg ? esc(f.reg) + ' · ' : ''}${esc(f.icao)}${f.pos ? '' : ' · no position'}</small></td>`
        + `<td class="num">${utc(f.t0).slice(0, 5)}–${utc(f.t1).slice(0, 5)}<small>${utc(f.t0, true).slice(0, -9)}</small></td><td class="num">${f.n}</td></tr>`).join('')
      + '</tbody></table>' + (rows.length > 400 ? `<div class="agn-none">The newest 400 of ${rows.length}.</div>` : '');
  }
  function renderLists() {
    renderPick();
    if (panel === 'trf') renderTraffic();
    else if (panel === 'fix') renderFixes();
    else if (panel === 'fl') renderFlights();
  }
  // ── the message about the clock (from 2026-11-21) ───────────────────────
  // The fixes need the clock of the receiver without GPS time, and that clock is set by aircraft with a usable own
  // position.  Under GNSS interference there are none for minutes to hours: the map then says so, with the numbers,
  // so that an empty map does not look like a fault.  While the server carries the clock on without references
  // (up to hold_max seconds) a softer line says that, too.  Returns { cls, html, title } or null.
  // The clock state in the answer is that of the LAST reply solved, and a reply of an aircraft that is itself a
  // reference is solved without its own references — so one answer can say "weak" or "carried" while the fixes of
  // the other aircraft flow.  The message therefore goes by what happened over the last polls (fxHist): "no fixes"
  // only when none was made for 12 seconds or more, "carried" only when no line has been fitted for a while.
  let fxHist = [];                             // { t, fix, nc } of the last polls (about 40 s)
  function fxNote(d) {
    const c = d && d.on && d.counters;
    if (!c) { fxHist = []; return; }
    const lastH = fxHist[fxHist.length - 1];
    if (lastH && (lastH.t === d.now)) return;
    if (lastH && (c.fix < lastH.fix || d.now < lastH.t)) fxHist = [];        // the server was restarted
    fxHist.push({ t: d.now, fix: c.fix, nc: c.no_clock });
    while (fxHist.length && d.now - fxHist[0].t > 40) fxHist.shift();
  }
  function clockMsg(d) {
    if (!d || !d.on) return null;
    const c0 = d.counters || {}, old = fxHist.find(h => d.now - h.t >= 12);
    // from 2026-11-22 the server tells how long ago the last fix was made (fix_age) and the last reply was lost for want
    // of a clock line (nc_age), so the message is right from the first answer; an older server: the last polls, as before
    const srv = d.fix_age !== undefined, fa = d.fix_age, na = d.nc_age;
    const made = srv ? (fa != null && fa < 12 ? 1 : 0) : old ? c0.fix - old.fix : null;                // made null: opened just now
    const lost = srv ? (na != null && na < 12 ? 1 : 0) : old ? c0.no_clock - old.nc : 0;
    const rx = (d.receivers || []).find(r => !r.gps && !r.rec_only && r.site);
    if (!rx) return null;
    const nm = esc(String(rx.id).replace(/^MODES-/, '')), ck = rx.clock, rf = d.refs;
    const ref = (d.receivers || []).find(r => r.gps), rn = ref ? esc(String(ref.id).replace(/^MODES-/, '')) : 'the time reference';
    const title = rf ? `In the last ${rf.sec} seconds ${rf.heard} aircraft were heard by ${nm} and ${rn} together; ${rf.pos} of them broadcast a position, ${rf.good} with an accuracy and integrity that lets it set the clock (NACp 8 or better and NIC 6 or better, and only when the GPS-timed receivers confirm the position)` : '';
    if (ck && ck.hold != null && ck.hold >= 20 && (ck.age == null || ck.age > 15)) {   // carried for all, not for one aircraft
      return { cls: 'hold', title, html: `<b>${nm}’s clock is being carried:</b> ${ck.hold} s without a reference aircraft (limit ${ck.hold_max} s). The fixes go on with a wider error` +
        (rf && rf.heard ? ` — ${rf.good} of the ${rf.heard} aircraft it hears send${rf.good === 1 ? 's' : ''} a usable position.` : '.') };
    }
    const noLine = !ck || ck.age == null || ck.age > 30;
    if (made === null ? !noLine : (made > 0 || !(lost > 0 || noLine || ck.weak))) return null;
    let why;
    if (!rf) why = `${nm}’s clock has no reference aircraft.`;
    else if (!rf.heard) why = `no aircraft is heard by ${nm} and ${rn} together.`;
    else if (!rf.good) why = `none of the ${rf.heard} aircraft ${nm} hears sends a usable position, so its clock cannot be set. This is GNSS interference in the area, not a fault — the fixes return by themselves.`;
    else why = `only ${rf.good} of the ${rf.heard} aircraft ${nm} hears send${rf.good === 1 ? 's' : ''} a usable position — too little to set its clock. This is GNSS interference in the area, not a fault — the fixes return by themselves.`;
    return { cls: 'stop', title, html: `<b>No position fixes ${srv && fa != null && fa >= 20 ? 'for ' + (fa < 90 ? Math.round(fa) + ' s' : Math.round(fa / 60) + ' min') : 'at the moment'}:</b> ${why}` };
  }
  function showMsg(m) {
    const el = $('aml-clkmsg');
    if (!el) return;
    if (!m || RP.on) { el.hidden = true; return; }
    el.className = 'aml-clkmsg ' + m.cls; el.innerHTML = m.html; el.hidden = false;
  }
  function render() {
    if (!on) return;
    showMsg(RP.on ? null : clockMsg(state));
    draw(); renderLists();
    if (!state) { sub(failed ? 'MLAT · no answer from the server' : 'MLAT · loading…'); return; }
    if (!state.on) { sub('MLAT · position fixes off'); return; }
    if (RP.on) sub(`Replay · ${utc(state.now, true)} UTC · ×${RP.speed}${RP.play ? '' : ' · paused'}${RP.missing ? ' · loading…' : ''}`);
    else sub(`MLAT · ${utc(state.now).slice(0, 5)} UTC · ${state.delay} s behind` + (state.stat_amb && state.stat_n ? ` · ${Math.round(100 * state.stat_amb / state.stat_n)} % unresolved` : '') + (failed ? ' · update failed' : ''));
  }

  window.AppMlatMap = {
    init,
    show() {
      on = true;
      ensureMap();
      if (map) setTimeout(() => map.invalidateSize(), 60);
      rpUi(); render();
      if (RP.on) { rpFrame(); rpLoop(); } else poll(true);
      rpRange(false);
    },
    hide() { on = false; clearTimeout(timer); clearInterval(RP.tick); },
    layout() { if (on && map) map.invalidateSize(); },
    setPanel(p) { panel = p; if (p === 'fl') rpRange(false); if (on) renderLists(); },
  };
})();
