/**
 * mlat_map.js — Own MLAT map (from 2026-11-19): the Statistics page's MLAT tab,
 * view "Map".  Loaded only for a user with the MLAT right (stats.html).
 *
 * Draws nothing but our own multilateration: the positions the server computes
 * from the time stamps of its receivers (collector/mlat_fix.py,
 * /api/mlat/fixes) — each aircraft's track and last fix; beside it, when asked,
 * the track the aircraft broadcasts itself (ADS-B), so the two can be compared.
 * The Radarcape's own MLAT positions are not shown here (they are on the Live
 * Map as before).
 *
 * Targets as on the Live Map's ATC style (static/js/atc_display.js): an open
 * square, the optional 30-second speed vector — from the speed and direction
 * of OUR track, not from what the aircraft reports — and the radar-display
 * label (callsign / flight level with the trend arrow / speed in tens of knots
 * and type) with a leader line, placed so that labels do not overlap.
 *
 *   blue    an aircraft that also broadcasts its position — the error against
 *           it is measured (list, table by distance)
 *   orange  an aircraft that sends no position of its own
 *   grey    the broadcast ADS-B track
 *   dashed  unresolved: two positions are still possible (option)
 *
 * From 2026-11-20: a Traffic window over the map (movable, resizable, minimizable; every
 * aircraft with a fix and what the multilateration knows of it), Solo (only the selected
 * aircraft is drawn), and levels as on a radar label — up to the transition altitude the
 * altitude on the EFHK METAR QNH (A023), above it the flight level (FL061).
 *
 * Replay (from 2026-11-20): the bar at the bottom of the map plays back the tracks the
 * server stored in the last 24 hours (/api/mlat/replay, one point per aircraft every 2 s) —
 * Live, back / forward 1 and 10 minutes, play / pause, speeds ×1 … ×50, a slider over the
 * stored time and a time field (UTC) to start the replay at a clock time.  In replay the same
 * drawing code runs on the stored points; the statistics and the receivers' clocks are live only.
 *
 * The Traffic window has two lists (from the evening of 2026-11-20): Now — the aircraft with
 * a fix — and Flights — the aircraft located in the last 3 / 6 / 12 / 24 hours, each with a
 * Replay button that plays it alone from the start of its track (before: a drop-down in the bar).
 *
 * The first request takes the whole trail; then only the new points every 5 s.
 * The fixes are a few seconds late (the server waits for clock references on
 * both sides of a reply).
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  if (!$('mst-mlat-map')) return;
  const POLL = 5000;
  const LS = { win: 'ms_mlm_win', exp: 'ms_mlm_exp', adsb: 'ms_mlm_adsb', amb: 'ms_mlm_amb', lbl: 'ms_mlm_lbl', vec: 'ms_mlm_vec', view: 'ms_mlm_view',
               solo: 'ms_mlm_solo', sal: 'ms_mlm_sal', trfon: 'ms_mlm_trfon', trf: 'ms_mlm_trf', trfsort: 'ms_mlm_trfsort' };
  const VEC_SEC = 30;
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* a convenience only */ } };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const light = () => document.documentElement.dataset.theme === 'light';
  const COL = () => light()
    ? { pos: '#1d4ed8', nopos: '#c2410c', adsb: '#64748b', link: '#b91c1c' }
    : { pos: '#60a5fa', nopos: '#fb923c', adsb: '#94a3b8', link: '#f87171' };

  let tabOn = false, view = lsGet(LS.view, 'rec'), map = null, tiles = null, tileKey = null, renderer = null;
  let layer = null, timer = null, last = 0, sel = null, lastCnt = null, state = null, nPoll = 0;
  // the replay: its clock (t, Unix s), the stored range, the chunks fetched so far (10 minutes each)
  const RP = { on: false, t: 0, play: false, speed: 10, t0: null, t1: null, chunks: new Map(), wait: new Set(), tick: null, wall: 0, meta: null, rangeT: 0, flights: [] };
  const RP_CHUNK = 600;
  const AC = new Map();                       // icao → { cs, typ, pos, res, n, nrx, err, last, trk: [], adsb: [] }
  const S = {
    win: +lsGet(LS.win, '300'), exp: +lsGet(LS.exp, '500'),
    adsb: lsGet(LS.adsb, '1') === '1', amb: lsGet(LS.amb, '0') === '1', lbl: lsGet(LS.lbl, '1') === '1',
    vec: lsGet(LS.vec, '1') === '1', cov: lsGet('ms_mlm_cov', 'off'), ils: lsGet('ms_mlm_ils', '1') === '1',
    solo: lsGet(LS.solo, '0') === '1', sal: lsGet(LS.sal, '0') === '1', trfon: lsGet(LS.trfon, '1') === '1',
  };
  let atc = null;                             // the canvas with the squares, vectors and labels
  let gridLayer = null, gridData = null, gridT = 0, selCh = {};
  let susData = null, susT = 0;
  const SUS_SHOW = 120;                        // s: a misfit is drawn this long after it last failed the check
  async function susLoad() {
    susT = Date.now();
    try { const d = await (await fetch('/api/mlat/suspects', { cache: 'no-store' })).json(); susData = d.on ? d : null; } catch (_) { /* keeps the last */ }
    if (S.sus) draw();
  }
  // Receiver coverage (from 2026-11-19), in the Live Map's style (static/js/live_wx.js): the
  // outline of the area heard in the last 24 h from /api/coverage — the farthest ADS-B position
  // per 10° sector — as a 1 px dashed line; all receivers together (the edge of their union, or
  // the server's combined outline for a user who may not see each receiver's own) or one receiver
  const COV_HOURS = 24;
  const COV_COLS = [{ dark: 'rgba(191,219,254,0.75)', light: 'rgba(29,78,216,0.7)' }, { dark: 'rgba(196,181,253,0.9)', light: 'rgba(109,40,217,0.8)' },
                    { dark: 'rgba(94,234,212,0.85)', light: 'rgba(15,118,110,0.8)' }, { dark: 'rgba(253,230,138,0.85)', light: 'rgba(180,83,9,0.8)' }];
  const covCol = k => COV_COLS[k % COV_COLS.length][light() ? 'light' : 'dark'];
  const rxShort = id => (id || '').replace(/^MODES-/, '') || 'Receiver';
  let covLayer = null, covData = null, covT = 0, covOff = null;
  // The airport's approach lines (from 2026-11-19), as on the Windshear map (static/js/windshear.js):
  // the EFHK ILS finals (short dashes) and RNP approaches (long dashes) of /overlays/efhk_ils.geojson
  // and the airport's outline; the labels keep clear of the finals
  let ilsGeo = null, ilsLayer = null, ilsFeat = [], ilsSeq = 0;
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
  const covRx = () => ((covData && covData.receivers) || []).map((r, i) => ({ r, i })).filter(x => x.r.outline && x.r.outline.length >= 3);
  async function covLoad() {
    covT = Date.now();
    if (S.cov === 'off') { if (covLayer) covLayer.redraw(); return; }
    try {
      const d = await (await fetch(`/api/coverage?hours=${COV_HOURS}`, { cache: 'no-store' })).json();
      covData = d;
      const sel = $('mlm-cov'), have = covRx();
      sel.innerHTML = '<option value="off">off</option><option value="all">all receivers</option>' +
        have.map(x => `<option value="${esc(x.r.id)}">${esc(rxShort(x.r.id))}</option>`).join('');
      if (S.cov !== 'all' && !have.some(x => x.r.id === S.cov)) S.cov = 'all';
      sel.value = S.cov;
    } catch (_) { /* keeps the last outline */ }
    if (covLayer) covLayer.redraw();
    draw();
  }
  function drawCov(g, m) {
    if (S.cov === 'off' || !covData) return;
    const dpr = window.devicePixelRatio || 1;
    const ringOf = r => r.outline.map(([la, lo]) => m.latLngToContainerPoint([la, lo]));
    const trace = (c, ring) => { ring.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)); c.closePath(); };
    const stroke = (c, ring, col, w) => { c.beginPath(); trace(c, ring); c.strokeStyle = col; c.lineWidth = w; c.lineJoin = 'round'; c.setLineDash([6, 4]); c.stroke(); c.setLineDash([]); };
    const have = covRx();
    if (S.cov !== 'all') {
      const x = have.find(h => h.r.id === S.cov);
      if (x) stroke(g, ringOf(x.r), covCol(x.i), 1.2);
      return;
    }
    const cb = covData.combined;
    if (cb && cb.outline && cb.outline.length >= 3) { stroke(g, ringOf(cb), covCol(0), 1); return; }
    const rings = have.map(h => ringOf(h.r));
    if (rings.length === 1) { stroke(g, rings[0], covCol(0), 1); return; }
    // each outline with the parts inside the other receivers' areas cleared: the edge of the union
    const cv = g.canvas;
    if (!covOff) covOff = document.createElement('canvas');
    covOff.width = cv.width; covOff.height = cv.height;
    const o = covOff.getContext('2d');
    rings.forEach((ring, k) => {
      o.setTransform(1, 0, 0, 1, 0, 0); o.clearRect(0, 0, covOff.width, covOff.height);
      o.setTransform(dpr, 0, 0, dpr, 0, 0);
      stroke(o, ring, covCol(0), 1);
      o.globalCompositeOperation = 'destination-out'; o.fillStyle = '#000';
      o.beginPath(); rings.forEach((r, j) => { if (j !== k) trace(o, r); }); o.fill('nonzero');
      o.globalCompositeOperation = 'source-over';
      g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(covOff, 0, 0); g.restore();
    });
  }
  // Accuracy grid: five classes of the median error, one hue, the larger the error the stronger
  const GRID_CL = [50, 100, 250, 500];
  const GRID_COL = () => light() ? ['#ddd6fe', '#c4b5fd', '#8b5cf6', '#6d28d9', '#4c1d95'] : ['#3b2a6b', '#5b3fb0', '#7c5ce0', '#a78bfa', '#ddd6fe'];
  // From 2026-11-21 midday the grid has three things to show (S.gridM, #mlm-gridm): "acc" the accuracy as before;
  // "fix" of the aircraft-minutes heard by three receivers, the share that had a resolved fix; "rx3" of the
  // aircraft-minutes heard by two or more receivers, the share heard by three.  The last two come from the
  // server's coverage cells (aircraft with a good own position only: they are placed by it), one hue, five classes.
  const COVER_CL = [20, 40, 60, 80];
  const COVER_COL = () => light() ? ['#e0f2fe', '#bae6fd', '#7dd3fc', '#0ea5e9', '#0369a1'] : ['#0c3a55', '#0e5a85', '#0284c7', '#38bdf8', '#bae6fd'];
  const GRID_MODES = { acc: 'median error', fix: 'heard by three receivers: share with a fix', rx3: 'heard by two or more: share heard by three' };
  async function gridLoad() {
    if (!gridLayer) return;
    if (!S.grid) { gridData = null; gridLayer.clearLayers(); draw(); return; }
    gridT = Date.now();
    try {
      // its own period (from the evening of 2026-11-20; before: the Charts view's), /api/mlat/grid?hours=
      const h = S.gridH, d = await (await fetch('/api/mlat/grid?hours=' + h, { cache: 'no-store' })).json();
      if (h !== S.gridH) return;                       // changed meanwhile: the newer request draws
      gridData = d.on ? { cells: d.grid || {}, cover: d.cover || {}, cell: d.cell, rng: h === 168 ? '7 d' : h + ' h' } : null;
    } catch (_) { /* keeps the last grid */ }
    gridDraw(); draw();
  }
  function gridDraw() {
    if (!gridLayer) return;
    gridLayer.clearLayers();
    if (!S.grid || !gridData) return;
    const [dla, dlo] = gridData.cell, col = GRID_COL();
    if (S.gridM !== 'acc') {
      const cc = COVER_COL(), fx = S.gridM === 'fix';
      for (const [k, g] of Object.entries(gridData.cover)) {
        const den = fx ? g[1] : g[0], num = fx ? g[2] : g[1];
        if (den < 3) continue;                         // fewer than three aircraft-minutes: no share
        const [i, j] = k.split(',').map(Number), pc = 100 * num / den, q = COVER_CL.findIndex(x => pc <= x);
        L.rectangle([[i * dla, j * dlo], [(i + 1) * dla, (j + 1) * dlo]], { pane: 'mlmGrid', stroke: false, fillColor: cc[q < 0 ? 4 : q], fillOpacity: 0.6, interactive: false }).addTo(gridLayer);
      }
      return;
    }
    for (const [k, g] of Object.entries(gridData.cells)) {
      const [i, j] = k.split(',').map(Number);
      const c = g[1] == null ? null : col[GRID_CL.findIndex(x => g[1] <= x) < 0 ? 4 : GRID_CL.findIndex(x => g[1] <= x)];
      L.rectangle([[i * dla, j * dlo], [(i + 1) * dla, (j + 1) * dlo]], { pane: 'mlmGrid', stroke: false, fillColor: c || '#94a3b8', fillOpacity: c ? 0.6 : 0.25, interactive: false }).addTo(gridLayer);
    }
  }
  const lblPos = {};                          // icao → the label's chosen position

  // ── the two views of the tab ────────────────────────────────────────────
  function apply() {
    const bar = $('mst-mlat-views');
    bar.style.display = tabOn ? '' : 'none';
    const onMap = tabOn && view === 'map', onCh = tabOn && view === 'charts';
    $('mst-mlat-map').style.display = onMap ? '' : 'none';
    if (!onMap) showMsg(null);
    $('mlm-ctl').style.display = onMap ? '' : 'none';
    $('mst-mlat-charts').style.display = onCh ? '' : 'none';
    $('mlc-ctl').style.display = onCh ? '' : 'none';
    if (tabOn) $('mst-mlat').style.display = onMap || onCh ? 'none' : '';
    document.dispatchEvent(new CustomEvent('mlm-view', { detail: { charts: onCh } }));   // static/js/mlat_charts.js
    bar.querySelectorAll('[data-mlview]').forEach(b => b.classList.toggle('active', b.dataset.mlview === view));
    clearTimeout(timer);
    if (onMap) { initMap(); setTimeout(() => map && map.invalidateSize(), 50); if (RP.on) { rpFrame(); rpLoop(); } else poll(true); if (S.grid) gridLoad(); if (S.cov !== 'off') covLoad(); trfShow(); rpRange(false); }
  }
  document.addEventListener('mst-mlat', e => { tabOn = !!(e.detail && e.detail.on); apply(); });
  $('mst-mlat-views').addEventListener('click', e => {
    const b = e.target.closest('[data-mlview]');
    if (!b || b.dataset.mlview === view) return;
    view = b.dataset.mlview; lsSet(LS.view, view); apply();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && tabOn && view === 'map' && !RP.on) poll(false); });

  // ── controls ────────────────────────────────────────────────────────────
  $('mlm-win').value = String(S.win); $('mlm-exp').value = String(S.exp);
  $('mlm-adsb').checked = S.adsb; $('mlm-amb').checked = S.amb; $('mlm-lbl').checked = S.lbl; $('mlm-vec').checked = S.vec;
  $('mlm-win').addEventListener('change', e => { S.win = +e.target.value; lsSet(LS.win, S.win); if (RP.on) rpFrame(); else poll(true); });
  $('mlm-exp').addEventListener('change', e => { S.exp = +e.target.value; lsSet(LS.exp, S.exp); draw(); });
  $('mlm-grid').checked = S.grid = lsGet('ms_mlm_grid', '0') === '1';
  $('mlm-grid').addEventListener('change', e => { S.grid = e.target.checked; lsSet('ms_mlm_grid', S.grid ? '1' : '0'); gridLoad(); });
  // the grid's period: 1, 3, 6, 12, 24 h or 7 d; the first time it starts from the Charts view's period, which it followed before
  S.gridH = +lsGet('ms_mlm_gridh', String({ '1h': 1, '24h': 24, '7d': 168 }[lsGet('ms_mlc_rng', '1h')] || 1));
  if (![1, 3, 6, 12, 24, 168].includes(S.gridH)) S.gridH = 1;
  $('mlm-gridh').value = String(S.gridH);
  $('mlm-gridh').addEventListener('change', e => { S.gridH = +e.target.value; lsSet('ms_mlm_gridh', String(S.gridH)); if (S.grid) gridLoad(); });
  S.gridM = lsGet('ms_mlm_gridm', 'acc'); if (!GRID_MODES[S.gridM]) S.gridM = 'acc';
  $('mlm-gridm').value = S.gridM;
  $('mlm-gridm').addEventListener('change', e => { S.gridM = e.target.value; lsSet('ms_mlm_gridm', S.gridM); gridDraw(); draw(); });
  // Misfit positions (from 2026-11-21 midday): aircraft whose broadcast position does not fit the time stamps of the
  // GPS-timed receivers (/api/mlat/suspects), drawn where they SAY they are, with a line to our own fix when there is one
  $('mlm-sus').checked = S.sus = lsGet('ms_mlm_sus', '0') === '1';
  $('mlm-sus').addEventListener('change', e => { S.sus = e.target.checked; lsSet('ms_mlm_sus', S.sus ? '1' : '0'); if (S.sus) susLoad(); else { susData = null; draw(); } });
  if (S.cov !== 'off' && S.cov !== 'all') $('mlm-cov').insertAdjacentHTML('beforeend', `<option value="${esc(S.cov)}">${esc(rxShort(S.cov))}</option>`);
  $('mlm-ils').checked = S.ils;
  $('mlm-ils').addEventListener('change', e => { S.ils = e.target.checked; lsSet('ms_mlm_ils', S.ils ? '1' : '0'); ilsShow(); });
  $('mlm-cov').value = S.cov;
  $('mlm-cov').addEventListener('change', e => { S.cov = e.target.value; lsSet('ms_mlm_cov', S.cov); covLoad(); });
  for (const [id, k] of [['mlm-adsb', 'adsb'], ['mlm-amb', 'amb'], ['mlm-lbl', 'lbl'], ['mlm-vec', 'vec']]) {
    $(id).addEventListener('change', e => { S[k] = e.target.checked; lsSet(LS[k], S[k] ? '1' : '0'); draw(); });
  }
  $('mlm-solo').checked = S.solo;
  $('mlm-solo').addEventListener('change', e => { S.solo = e.target.checked; lsSet(LS.solo, S.solo ? '1' : '0'); draw(); });
  $('mlm-sal').checked = S.sal;
  $('mlm-sal').addEventListener('change', e => { S.sal = e.target.checked; lsSet(LS.sal, S.sal ? '1' : '0'); draw(); renderList(); });
  $('mlm-trfon').checked = S.trfon;
  $('mlm-trfon').addEventListener('change', e => { S.trfon = e.target.checked; lsSet(LS.trfon, S.trfon ? '1' : '0'); trfShow(); renderList(); });

  // ── map ─────────────────────────────────────────────────────────────────
  function setTiles() {
    if (!map) return;
    const tk = light() ? 'l' : 'd';
    if (tiles && tileKey === tk) return;
    if (tiles) tiles.remove();
    const key = (typeof CARTO_API_KEY !== 'undefined' && CARTO_API_KEY) ? `?key=${encodeURIComponent(CARTO_API_KEY)}` : '';
    tiles = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${tk === 'l' ? 'light_all' : 'dark_all'}/{z}/{x}/{y}{r}.png${key}`,
      { attribution: '© OSM, © CARTO', subdomains: 'abcd', maxZoom: 15 }).addTo(map);
    tileKey = tk;
  }
  // The map's place and zoom are remembered in the browser (from the evening of 2026-11-20, ms_mlm_mapview), and a
  // house button under + / − goes back to the default view: the airport the server gives as the centre, zoom 8
  const HOME_ZOOM = 8;
  let homeC = [60.317, 24.963];
  function savedView() {
    try {
      const v = JSON.parse(lsGet('ms_mlm_mapview', 'null'));
      if (v && Number.isFinite(v.lat) && Number.isFinite(v.lon) && Number.isFinite(v.z) && Math.abs(v.lat) <= 85 && Math.abs(v.lon) <= 180 && v.z >= 3 && v.z <= 15) return v;
    } catch (_) { /* a broken value: the default view */ }
    return null;
  }
  function initMap() {
    if (map) return;
    const sv = savedView();
    map = L.map('mlm-map', { zoomControl: true, preferCanvas: true, attributionControl: true }).setView(sv ? [sv.lat, sv.lon] : homeC, sv ? sv.z : HOME_ZOOM);
    map._mlmCentred = !!sv;                          // a remembered view is not replaced by the server's centre
    map.on('moveend', () => {
      if (!map.getSize().x || !map._mlmCentred) return;           // hidden, or still at the built-in start
      const c = map.getCenter();
      lsSet('ms_mlm_mapview', JSON.stringify({ lat: +c.lat.toFixed(4), lon: +c.lng.toFixed(4), z: map.getZoom() }));
    });
    const Home = L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const box = L.DomUtil.create('div', 'leaflet-bar ms-map-home');
        const a = L.DomUtil.create('a', '', box);
        a.href = '#'; a.title = 'Back to the default view (the airport, zoom 8)';
        a.setAttribute('role', 'button'); a.setAttribute('aria-label', a.title);
        a.innerHTML = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">'
          + '<path d="M2.5 7.5 8 2.5l5.5 5M4 6.6V13.5h3V10h2v3.5h3V6.6" fill="none" stroke="currentColor" '
          + 'stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>';
        L.DomEvent.disableClickPropagation(box);
        L.DomEvent.on(a, 'click', e => { L.DomEvent.preventDefault(e); map._mlmCentred = true; map.setView(homeC, HOME_ZOOM); });
        return box;
      },
    });
    new Home().addTo(map);
    renderer = L.canvas({ padding: 0.3 });
    setTiles();
    map.createPane('mlmGrid').style.zIndex = 350;
    map.getPane('mlmGrid').style.pointerEvents = 'none';
    gridLayer = L.layerGroup().addTo(map);
    map.createPane('mlmHist').style.zIndex = 390;               // the long trails: under the tracks of the last hour
    map.getPane('mlmHist').style.pointerEvents = 'none';
    histRend = L.canvas({ pane: 'mlmHist', padding: 0.3 });
    histLayer = L.layerGroup().addTo(map);
    layer = L.layerGroup().addTo(map);
    if (typeof AtcDisplay !== 'undefined') {
      covLayer = AtcDisplay.canvasLayer(map, drawCov);           // under the targets' canvas
      atc = AtcDisplay.canvasLayer(map, drawTargets);
    }
    if (window.msRxMarkers) { try { window.msRxMarkers(map).addTo(map); } catch (_) { /* the receivers are optional */ } }
    L.control.scale({ imperial: false, nautic: false }).addTo(map);
    ilsShow();
    new MutationObserver(() => { setTiles(); ilsShow(); draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  // ── data ────────────────────────────────────────────────────────────────
  async function poll(full) {
    clearTimeout(timer);
    if (!tabOn || view !== 'map' || RP.on) return;
    if (document.hidden) { timer = setTimeout(() => poll(false), POLL); return; }
    // a full answer at the start and once a minute: the server drops the points of a
    // candidate position that turned out to be the wrong one of two
    if (full) { AC.clear(); last = 0; nPoll = 0; }
    const whole = !last || (++nPoll % 12 === 0);
    try {
      const r = await fetch(`/api/mlat/fixes?win=${Math.min(S.win, DETAIL)}${whole ? '' : '&since=' + last}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      if (RP.on) return;                             // the replay was started meanwhile
      state = d;
      if (d.on) merge(d, whole);
      render(d);
      if (trfMode === 'fl' && S.trfon) rpRange(false);          // the Flights list: once a minute (rpRange keeps the pace)
    } catch (e) {
      $('mlm-note').textContent = 'Update failed — retrying';
    }
    timer = setTimeout(() => poll(false), POLL);
  }
  function merge(d, whole) {
    if (d.center) homeC = d.center;
    if (!last && d.center && map && !map._mlmCentred) { map._mlmCentred = true; map.setView(d.center, HOME_ZOOM); }
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
  // Solo (from 2026-11-20): with an aircraft selected only that one is drawn
  function shown(k, o) { return o.last && (S.amb || !o.last[6]) && (!S.solo || !sel || sel === k); }

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
    if (tabOn && view === 'map') draw();
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
  function draw() {
    if (!map || !layer) return;
    histCheck(); histDraw();
    layer.clearLayers();
    const C = COL(), now = state ? state.now : 0;
    for (const [k, o] of AC) {
      if (!shown(k, o)) continue;
      const col = o.pos ? C.pos : C.nopos, on = sel === k, amb = !!o.last[6];
      if (S.adsb && o.adsb.length > 1) {
        L.polyline(o.adsb.map(p => [p[1], p[2]]), { renderer, color: C.adsb, weight: on ? 2 : 1, opacity: 0.9, interactive: false }).addTo(layer);
      }
      // the track, broken where the expected error is over the limit, the fix unresolved or the points far apart in time
      let seg = [], pt = null;
      const flush = () => { if (seg.length > 1) L.polyline(seg, { renderer, color: col, weight: on ? 3.5 : 2, opacity: 0.95, dashArray: amb ? '4 5' : null, interactive: false }).addTo(layer); seg = []; };
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
      // the target itself is drawn on the canvas (drawTargets); this invisible disc takes the click and the hover
      const m = L.circleMarker([lp[1], lp[2]], { renderer, radius: 9, stroke: false, fillOpacity: 0 }).addTo(layer);
      m.on('click', () => pick(k, false));
      m.bindTooltip(tip(k, o), { direction: 'top', offset: [0, -8] });
      if (!atc) L.circleMarker([lp[1], lp[2]], { renderer, radius: 4, color: col, weight: 1.5, fillOpacity: 0, interactive: false }).addTo(layer);
    }
    // misfit positions: a dotted ring where the aircraft says it is, and a dotted line to where our fix puts it
    if (S.sus && susData && !RP.on) {
      for (const a of susData.aircraft) {
        if (!a.bc || now - a.t > SUS_SHOW) continue;
        const nm = esc(a.cs || a.reg || a.icao), far = `at least ${a.min_km} km off`;
        L.circleMarker(a.bc, { renderer, radius: 9, color: C.link, weight: 2, dashArray: '2 4', fillOpacity: 0 }).addTo(layer)
          .bindTooltip(`${nm} · the position it broadcasts does not fit the receivers’ timing: ${far}` + (a.km != null ? ` · our fix is ${a.km} km from it` : ''), { direction: 'top', offset: [0, -8] });
        if (a.own) L.polyline([a.bc, [a.own[0], a.own[1]]], { renderer, color: C.link, weight: 1.5, dashArray: '2 5', opacity: 0.9, interactive: false }).addTo(layer);
      }
    }
    if (atc) atc.redraw();
    $('mlm-legend').innerHTML =
      `<div><i style="border-color:${C.pos}"></i>our fix — aircraft also broadcasts its position</div>` +
      `<div><i style="border-color:${C.nopos}"></i>our fix — aircraft sends no position (a dot in its square)</div>` +
      (S.adsb ? `<div><i style="border-color:${C.adsb};border-top-width:1px"></i>broadcast ADS-B track · <i style="border-color:${C.link};border-top-width:2px;width:10px"></i>difference now</div>` : '') +
      (S.amb ? '<div>dashed: unresolved — two positions possible</div>' : '') +
      (S.win > DETAIL ? `<div>thin lines: the stored tracks older than an hour, a point every ${histStep(S.win)} s</div>` : '') +
      (S.grid && gridData ? (S.gridM === 'acc'
        ? `<div class="mlm-gridleg">median error, ${gridData.rng}:` + GRID_COL().map((c, i) => `<b style="background:${c}"></b>${i < 4 ? '≤ ' + GRID_CL[i] : '> 500'}`).join('') + ' m</div>'
        : `<div class="mlm-gridleg">${GRID_MODES[S.gridM]}, ${gridData.rng}:` + COVER_COL().map((c, i) => `<b style="background:${c}"></b>${i < 4 ? '≤ ' + COVER_CL[i] : '> 80'}`).join('') + ' %</div>') : '') +
      (S.sus && susData && susData.aircraft.some(a => a.bc && state && state.now - a.t <= SUS_SHOW) ? `<div><i style="border-top:2px dotted ${C.link}"></i>broadcast position that does not fit the receivers' timing (ring) — line to our fix</div>` : '');
    if (S.ils && ilsFeat.length) {
      const lt = light();
      $('mlm-legend').insertAdjacentHTML('beforeend', `<div><i style="border-top:1.5px dashed ${lt ? '#1a3a6b' : '#38bdf8'}"></i>ILS final · ` +
        `<i style="border-top:1.5px dashed ${lt ? '#92400e' : '#f59e0b'}"></i>RNP approach</div>`);
    }
    if (S.cov !== 'off' && covData) {
      const one = S.cov !== 'all' ? covRx().find(h => h.r.id === S.cov) : null;
      $('mlm-legend').insertAdjacentHTML('beforeend', `<div><i style="border-top:1px dashed ${covCol(one ? one.i : 0)}"></i>` +
        `reception in the last ${COV_HOURS} h: ${one ? esc(rxShort(one.r.id)) : 'all receivers together'}</div>`);
    }
    if (S.cov !== 'off' && Date.now() - covT > 300000) covLoad();
    if (S.grid && Date.now() - gridT > 60000) gridLoad();
    if (S.sus && !RP.on && Date.now() - susT > 15000) susLoad();
    selPanel();
  }
  // Squares, speed vectors and labels, as the Live Map's ATC style (one canvas over the map)
  // Levels as on a radar label (from 2026-11-20, as the Windshear map's wsAtcAlt): up to the transition
  // altitude the altitude on the EFHK METAR QNH, above it the flight level.  Without a QNH: flight levels
  const TA = () => (state && state.ta_ft) || 5000;
  const onQnh = pa => { const q = state && state.qnh; if (q == null || pa == null) return null; const a = pa - (1013.25 - q) * 27; return a <= TA() ? a : null; };
  const h3 = v => String(Math.max(0, Math.round(v / 100))).padStart(3, '0');
  const fl3 = pa => { const a = onQnh(pa); return h3(a == null ? pa : a); };
  const lvl = pa => { if (pa == null) return '—'; const a = onQnh(pa); return a == null ? 'FL' + h3(pa) : 'A' + h3(a); };
  function drawTargets(g, m, W, H) {
    if (!state || !state.on) return;
    const C = COL(), now = state.now, items = [];
    const obst = S.ils && ilsFeat.length ? AtcDisplay.lineObstacles(m, ilsFeat, W, H) : [];     // labels keep clear of the finals
    for (const [k, o] of AC) {
      if (!shown(k, o)) continue;
      const lp = o.last;
      if ((lp[4] != null && lp[4] > S.exp) || now - lp[0] > 60) continue;
      const p = m.latLngToContainerPoint([lp[1], lp[2]]);
      if (p.x < -40 || p.y < -40 || p.x > W + 40 || p.y > H + 40) continue;
      const col = o.pos ? C.pos : C.nopos, on = sel === k, sz = on ? 9 : 8;
      const ac = { lat: lp[1], lon: lp[2], altitude: lp[3], icao: k, aircraft_type: o.typ, vert_rate: o.vr,
                   groundspeed: o.vel ? o.vel[0] : null, track: o.vel ? o.vel[1] : null, sel_alt: o.sal };
      if (S.vec) AtcDisplay.drawVector(g, m, p, ac, VEC_SEC, col, 0.95, 1.5, obst);
      g.globalAlpha = 1;
      g.strokeStyle = col; g.lineWidth = on ? 1.8 : 1.5;
      g.setLineDash(lp[6] ? [2, 2] : []);
      g.strokeRect(Math.round(p.x - sz / 2) + 0.5, Math.round(p.y - sz / 2) + 0.5, sz, sz);
      g.setLineDash([]);
      if (!o.pos) { g.fillStyle = col; g.fillRect(p.x - 1.5, p.y - 1.5, 3, 3); }      // no position of its own: a dot inside
      if (on) { g.globalAlpha = 0.75; g.lineWidth = 1; g.strokeRect(Math.round(p.x - sz / 2 - 4) + 0.5, Math.round(p.y - sz / 2 - 4) + 0.5, sz + 8, sz + 8); g.globalAlpha = 1; }
      if (S.lbl) items.push({ key: k, p, lines: AtcDisplay.labelLines(ac, S.sal ? 'full' : 'std', name(k, o), fl3), col, sel: on, fade: 1, alt: lp[3] });
    }
    if (items.length) AtcDisplay.drawLabels(g, items, W, H, obst, lblPos, 12, { halo: light() ? 'rgba(255,255,255,.9)' : 'rgba(11,18,32,.9)', leader: C.adsb });
  }
  // The selected aircraft: its distance from its own ADS-B position over the trail, and our
  // ground speed against the one it reports (track points: [t, lat, lon, alt, expected, error,
  // unresolved, our speed kt, reported speed kt])
  function selPanel() {
    const o = sel ? AC.get(sel) : null, box = $('mlm-selp');
    box.style.display = o ? '' : 'none';
    if (!o || typeof Chart === 'undefined') return;
    $('mlm-selt').textContent = `${name(sel, o)} ${o.typ || ''} · ${o.reg ? o.reg + ' · ' : ''}${sel}`;
    const C = COL(), txt = light() ? '#475569' : '#94a3b8', grid = 'rgba(148,163,184,.18)';
    const pts = o.trk.filter(p => !p[6]);
    const lab = pts.map(p => { const t = new Date(p[0] * 1000); return String(t.getUTCHours()).padStart(2, '0') + ':' + String(t.getUTCMinutes()).padStart(2, '0') + ':' + String(t.getUTCSeconds()).padStart(2, '0'); });
    const mk = (key, id, ds) => {
      const cfg = { type: 'line', data: { labels: lab, datasets: ds.map(d => Object.assign({ borderWidth: 2, pointRadius: 0, tension: 0, spanGaps: false }, d)) },
        options: { animation: false, responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
          plugins: { legend: { display: ds.length > 1, labels: { color: txt, boxWidth: 14, font: { size: 10 } } } },
          scales: { x: { grid: { display: false }, ticks: { color: txt, maxRotation: 0, autoSkip: true, maxTicksLimit: 6, font: { size: 10 } } },
                    y: { beginAtZero: key === 'e', grid: { color: grid }, ticks: { color: txt, font: { size: 10 } } } } } };
      if (selCh[key]) { selCh[key].data = cfg.data; selCh[key].options = cfg.options; selCh[key].update('none'); }
      else selCh[key] = new Chart($(id), cfg);
    };
    mk('e', 'mlm-sel-err', [{ label: 'distance from its own position, m', data: pts.map(p => p[5]), borderColor: o.pos ? C.pos : C.nopos }]);
    mk('g', 'mlm-sel-gs', [{ label: 'ours', data: pts.map(p => p[7]), borderColor: o.pos ? C.pos : C.nopos },
                           { label: 'reported', data: pts.map(p => p[8]), borderColor: C.adsb, borderDash: [4, 3] }]);
  }
  const mTxt = v => v == null ? '—' : v >= 10000 ? (v / 1000).toFixed(0) + ' km' : v >= 1000 ? (v / 1000).toFixed(1) + ' km' : Math.round(v) + ' m';
  // an aircraft without a position of its own; from 2026-11-22 "says so" when it sends ADS-B position messages with type code 0
  const NOPOS = o => o.np0 ? '<span class="mlm-tag" title="Sends position messages that say “no position” (ADS-B type code 0): the aircraft itself reports that it has none">no position · says so</span>'
                           : '<span class="mlm-tag" title="Sends no position of its own">no position</span>';
  function tip(k, o) {
    const p = o.last;
    return `<b>${esc(name(k, o))}</b> ${esc(o.typ || '')} · ${o.reg ? esc(o.reg) + ' · ' : ''}${esc(k)}<br>${lvl(p[3])}${onQnh(p[3]) != null ? ` (QNH ${Math.round(state.qnh)})` : ''} · ${o.nrx || 3} receivers<br>` +
      `expected ±${mTxt(p[4])}${o.err != null ? ` · measured ${mTxt(o.err)} from its ADS-B position` : (o.pos ? '' : o.np0 ? ' · sends no position, and says so (type code 0)' : ' · sends no position')}` +
      (p[6] ? '<br>unresolved: two positions possible' : '');
  }

  // ── replay (from 2026-11-20) ────────────────────────────────────────────
  const utc = (t, date) => { const d = new Date(t * 1000), z = n => String(n).padStart(2, '0');
    return (date ? `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ` : '') + `${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())}`; };
  async function rpRange(force) {
    if (!force && Date.now() - RP.rangeT < 60000) return;
    RP.rangeT = Date.now();
    try {
      const r = await fetch('/api/mlat/replay/flights', { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      RP.got = true;                                 // an answer has come: an empty list now means that nothing is stored
      if (!d.on || d.t0 == null) { RP.t0 = RP.t1 = null; RP.flights = []; if (trfMode === 'fl') trfRender(); return; }
      RP.t0 = d.t0; RP.t1 = d.t1; RP.flights = d.flights || [];
      const sl = $('mlm-rp-sl'); sl.min = Math.floor(d.t0); sl.max = Math.ceil(d.t1);
      if (!RP.on) sl.value = sl.max;
      if (trfMode === 'fl') trfRender();
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
      if (RP.chunks.size > 30) {                     // the farthest from the replay time go
        const here = Math.floor(RP.t / RP_CHUNK);
        for (const k of [...RP.chunks.keys()].sort((a, b) => Math.abs(b - here) - Math.abs(a - here)).slice(0, RP.chunks.size - 30)) RP.chunks.delete(k);
      }
    } catch (_) { /* asked again by the next frame */ }
    RP.wait.delete(c);
    if (RP.on) rpFrame();
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
    if (state.center) homeC = state.center;
    if (!map._mlmCentred && state.center) { map._mlmCentred = true; map.setView(state.center, HOME_ZOOM); }
    const live = [...AC.values()].filter(o => t - o.last[0] <= 60), withErr = live.map(o => o.last[5]).filter(v => v != null && !isNaN(v)).sort((a, b) => a - b);
    const tile = (v, l, tt) => `<div class="mlm-tile" title="${esc(tt)}"><b>${v}</b><span>${l}</span></div>`;
    $('mlm-tiles').innerHTML = tile(utc(t).slice(0, 5), 'replay, UTC', 'Time of the picture') + tile(live.length, 'aircraft', 'Aircraft with a stored position in the minute before') +
      tile(live.filter(o => !o.pos).length, 'no own position', 'Of them, aircraft that broadcast no position of their own') +
      tile(withErr.length ? mTxt(withErr[Math.floor(withErr.length / 2)]) : '—', 'median error now', 'Median distance between our track and the aircraft’s own position, the aircraft in the picture');
    $('mlm-note').textContent = `Replay · ${utc(t, true)} UTC · ×${RP.speed}${RP.play ? '' : ' · paused'}${missing ? ' · loading…' : ''}`;
    $('mlm-rp-t').textContent = utc(t, true);
    if (document.activeElement !== $('mlm-rp-at')) $('mlm-rp-at').value = utc(t).slice(0, 5);
    if (document.activeElement !== $('mlm-rp-sl')) $('mlm-rp-sl').value = Math.round(t);
    draw(); renderList();
  }
  function rpUi() {
    $('mlm-rp').classList.toggle('rp', RP.on);
    $('mlm-rp-live').classList.toggle('on', !RP.on);
    $('mlm-rp-play').classList.toggle('on', RP.on && RP.play);
    $('mlm-rp-play').textContent = RP.on && RP.play ? '❚❚' : '▶';
    $('mlm-liveonly').style.display = RP.on ? 'none' : '';
    if (RP.on) showMsg(null);
    $('mlm-rpnote').style.display = RP.on ? '' : 'none';
    if (!RP.on) { $('mlm-rp-t').textContent = 'Live'; $('mlm-rp-at').value = ''; if (RP.t1 != null) $('mlm-rp-sl').value = $('mlm-rp-sl').max; }
  }
  function rpLoop() {
    clearInterval(RP.tick);
    if (!RP.on) return;
    RP.wall = performance.now();
    RP.tick = setInterval(() => {
      const w = performance.now(), dt = (w - RP.wall) / 1000; RP.wall = w;
      if (!RP.on || !tabOn || view !== 'map' || document.hidden) return;
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
    if (RP.t0 == null) { $('mlm-note').textContent = 'Nothing is stored for the replay yet'; return; }
    clearTimeout(timer);
    RP.on = true;
    RP.t = Math.max(RP.t0, Math.min(t, RP.t1));
    if (play != null) RP.play = play;
    rpUi(); rpFrame(); rpLoop(); rpRange(false);
  }
  function rpLive() {
    if (!RP.on) return;
    RP.on = false; RP.play = false; RP.meta = null;
    clearInterval(RP.tick);
    rpUi();
    poll(true);
  }
  $('mlm-rp-live').addEventListener('click', rpLive);
  $('mlm-rp-play').addEventListener('click', () => {
    if (!RP.on) return rpGo((state && !state.replay ? state.now : Date.now() / 1000) - 600, true);     // from live: ten minutes back
    RP.play = !RP.play; rpUi(); rpFrame();
  });
  $('mlm-rp').addEventListener('click', e => {
    const b = e.target.closest('[data-rpj]');
    if (!b) return;
    const base = RP.on ? RP.t : (state ? state.now : Date.now() / 1000);
    rpGo(base + (+b.dataset.rpj), RP.on ? null : true);
  });
  $('mlm-rp-speed').value = lsGet('ms_mlm_rpspeed', '10'); RP.speed = +$('mlm-rp-speed').value || 10;
  $('mlm-rp-speed').addEventListener('change', e => { RP.speed = +e.target.value || 1; lsSet('ms_mlm_rpspeed', String(RP.speed)); if (RP.on) rpFrame(); });
  $('mlm-rp-sl').addEventListener('input', e => rpGo(+e.target.value, RP.on ? null : false));
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
    if (RP.t0 == null) { $('mlm-note').textContent = 'Nothing is stored for the replay yet'; return; }
    const ref = RP.t1, d = new Date(ref * 1000);
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), m[0], m[1]) / 1000;
    if (t > ref) t -= 86400;
    rpGo(t, true);
  }
  // Enter, or leaving the field after a change, starts the replay there
  $('mlm-rp-at').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.target._done = e.target.value; rpAt(e.target); e.target.blur(); } });
  $('mlm-rp-at').addEventListener('change', e => { if (e.target._done === e.target.value) { e.target._done = null; return; } rpAt(e.target); });
  $('mlm-rp-at').addEventListener('input', e => e.target.classList.remove('bad'));
  // Replay one aircraft alone from the start of a stored track (the Flights list of the Traffic window)
  function rpFlight(f) {
    if (!f) return;
    sel = f.icao;
    S.solo = true; $('mlm-solo').checked = true; lsSet(LS.solo, '1');
    if (!S.amb) { S.amb = true; $('mlm-amb').checked = true; }               // its unresolved stretches too
    rpGo(f.t0 + 2, true);
  }
  for (const ev of ['wheel', 'dblclick', 'mousedown', 'touchstart']) $('mlm-rp').addEventListener(ev, e => e.stopPropagation(), { passive: true });

  // ── the message about the clock (from 2026-11-21) ───────────────────────
  // The fixes need the clock of the receiver without GPS time, and that clock is set by aircraft with a usable own
  // position.  Under GNSS interference there are none for minutes to hours: the Position fixes window then says so
  // under its receivers table (first above the map, which made the whole map jump when it came and went),
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
    const el = $('mlm-msg');
    if (!el) return;
    if (!m || RP.on || view !== 'map') { el.style.display = 'none'; return; }
    el.className = 'mlm-msg ' + m.cls; el.innerHTML = m.html; el.title = m.title || ''; el.style.display = '';
  }

  // ── side panel ──────────────────────────────────────────────────────────
  function render(d) {
    const note = $('mlm-note');
    fxNote(d);
    showMsg(clockMsg(d));
    if (!d.on) {
      note.textContent = 'Position fixes are off: ' + (d.why || 'not available on this server');
      $('mlm-tiles').innerHTML = ''; $('mlm-bands').innerHTML = ''; $('mlm-rx').innerHTML = ''; $('mlm-ac').innerHTML = ''; $('mlm-acn').textContent = '';
      if (layer) layer.clearLayers();
      return;
    }
    const c = d.counters || {};
    let rate = null;
    if (lastCnt && d.now > lastCnt.t) rate = (c.fix - lastCnt.fix) / (d.now - lastCnt.t);
    lastCnt = { t: d.now, fix: c.fix };
    const live = [...AC.values()].filter(o => o.last && d.now - o.last[0] <= 60);
    const nop = live.filter(o => !o.pos).length, unr = live.filter(o => o.last[6]).length;
    const st = d.bands || [], near = st.filter(b => b.hi != null && b.hi <= 20 && b.n);
    const nearMed = near.length ? Math.round(near.reduce((s, b) => s + b.med * b.n, 0) / near.reduce((s, b) => s + b.n, 0)) : null;
    const tile = (v, l, t) => `<div class="mlm-tile" title="${esc(t)}"><b>${v}</b><span>${l}</span></div>`;
    $('mlm-tiles').innerHTML =
      tile(rate == null ? '…' : rate < 10 ? rate.toFixed(1) : Math.round(rate), 'fixes / s', 'Position fixes computed per second (at most three per aircraft and second)') +
      tile(live.length, 'aircraft', 'Aircraft with a fix in the last minute' + (unr ? ` — ${unr} of them unresolved (two positions possible)` : '')) +
      tile(nop, 'no own position', 'Of them, aircraft that broadcast no position of their own: their place is known only from our receivers’ timing') +
      tile(nearMed == null ? '—' : nearMed + ' m', 'median error ≤ 20 NM', 'Median distance between a single fix and the aircraft’s own ADS-B position, within 20 NM of the airport, last 10 minutes');
    $('mlm-bands').innerHTML = '<thead><tr><th>From the airport</th><th class="num">Fixes</th><th class="num" title="Half of the single fixes are closer than this to the aircraft’s own position">Half within</th>' +
      '<th class="num">68 %</th><th class="num">90 %</th><th class="num" title="The same for the smoothed track">Track</th></tr></thead><tbody>' +
      st.map(b => `<tr><td>${b.lo}${b.hi == null ? ' NM +' : '–' + b.hi + ' NM'}</td><td class="num">${b.n}</td><td class="num">${mTxt(b.med)}</td><td class="num">${mTxt(b.p68)}</td><td class="num">${mTxt(b.p90)}</td><td class="num">${mTxt(b.trk)}</td></tr>`).join('') +
      '</tbody>';
    $('mlm-rx').innerHTML = '<thead><tr><th>Receiver</th><th>Clock</th><th>State</th></tr></thead><tbody>' + (d.receivers || []).map(r => {
      let stt;
      // a receiver the server's MLAT_FIX_RX leaves out (from the evening of 2026-11-20): connected and recorded, not in the fixes
      if (r.rec_only) return `<tr class="mst-dim"><td>${esc(String(r.id).replace(/^MODES-/, ''))}</td><td>—</td><td title="This receiver is connected and its time stamps are recorded, but the live position fixes are computed without it (the server's MLAT_FIX_RX setting)">recorded only · not used for the fixes</td></tr>`;
      if (!r.site) stt = `<span class="mst-warn">no antenna position${r.why ? ' (' + esc(r.why) + ')' : ''}</span>`;
      else if (r.gps) stt = r.bit === (d.receivers.find(x => x.gps) || {}).bit ? 'time reference' : `constant ${r.bias > 0 ? '+' : ''}${r.bias} ns` + (r.bias_ac ? ` · from ${r.bias_ac} aircraft, 10 min` : '');
      else if (!r.clock) stt = '<span class="mst-warn">no clock line yet</span>';
      // from 2026-11-20: a line may rest on ONE other aircraft (many replies over a long stretch; the fix
      // then carries a wider timing error), and a line that was fitted but is too weak for a fix says so
      // from 2026-11-21: no reference aircraft at the moment, and the server carries the clock on (see clockMsg)
      else if (r.clock.hold != null && (r.clock.age == null || r.clock.age > 15)) stt = `<span class="mst-warn" title="No reference aircraft at the moment: the clock is carried on along the curve of the references of the last ten minutes, for at most ${r.clock.hold_max} seconds; the fixes of this time carry the wider timing error shown">carried ${r.clock.hold} s without a reference · ±${r.clock.hold_sig} ns</span>`;
      else stt = `line from ${r.clock.n} replies of ${r.clock.ac} aircraft` +
        (r.clock.ac === 1 && !r.clock.weak ? ' <span title="Only one other aircraft with a good position is heard together with this receiver: the line is used with a wider timing error">(one reference)</span>' : '') +
        ` · ±${r.clock.sig} ns · drift ${(r.clock.drift / 1000).toFixed(3)} ppm` +
        (r.clock.weak ? ' · <span class="mst-warn" title="Too few replies, too short a stretch or too much scatter for a position fix">too weak for a fix</span>' : '') +
        (r.clock.age > 30 ? ` · <span class="mst-warn" title="No other aircraft with a usable position has been heard together with this receiver since then: no position fixes meanwhile">no reference for ${Math.round(r.clock.age)} s</span>` : '');
      return `<tr><td>${esc(String(r.id).replace(/^MODES-/, ''))}</td><td>${r.gps ? 'GPS' : 'counter'}</td><td>${stt}</td></tr>`;
    }).join('') + '</tbody>';
    const tried = c.tried || 0;
    note.textContent = `${d.delay} s behind · ${tried ? Math.round(100 * c.fix / tried) : 0} % of the tried replies gave a fix` +
      (d.stat_amb && d.stat_n ? ` · ${Math.round(100 * d.stat_amb / d.stat_n)} % unresolved` : '') + ` · processor ${d.cpu} %`;
    draw();
    renderList();
  }
  function renderList() {
    if (!state) return;
    const rows = [...AC.entries()].filter(([, o]) => o.last && state.now - o.last[0] <= 60)
      .sort((a, b) => (a[1].pos - b[1].pos) || name(a[0], a[1]).localeCompare(name(b[0], b[1])));
    $('mlm-acn').textContent = rows.length ? `${rows.length} in the last minute` : '';
    $('mlm-ac').innerHTML = '<thead><tr><th>Aircraft</th><th>Address</th><th class="num" title="Up to the transition altitude the altitude on the EFHK METAR QNH (A023), above it the flight level">Level</th><th class="num" title="Expected error of the last fix, from the geometry">Expected</th>' +
      '<th class="num" title="Median distance from the aircraft’s own ADS-B position, last fixes">Measured</th><th></th></tr></thead><tbody>' +
      rows.map(([k, o]) => `<tr data-k="${esc(k)}"${sel === k ? ' class="sel"' : ''}><td><b>${esc(name(k, o))}</b> ${esc(o.typ || '')}</td><td><code>${esc(k)}</code></td>` +
        `<td class="num">${lvl(o.last[3])}</td><td class="num">±${mTxt(o.last[4])}</td><td class="num">${mTxt(o.err)}</td>` +
        `<td>${o.pos ? '' : NOPOS(o)}${o.last[6] ? ' <span class="mlm-tag" title="Two positions are still possible">unresolved</span>' : ''}</td></tr>`).join('') +
      (rows.length ? '' : '<tr class="mst-dim"><td colspan="6">No fixes in the last minute</td></tr>') + '</tbody>';
    trfRender();
  }
  // Select / unselect an aircraft (map, side list, Traffic window)
  function pick(k, pan) {
    const o = AC.get(k);
    sel = sel === k ? null : k;
    if (pan && sel && o && o.last && map) map.panTo([o.last[1], o.last[2]]);
    if (pan && sel && o && o.last && o.last[6] && !S.amb) { S.amb = true; $('mlm-amb').checked = true; }
    draw(); renderList();
  }
  $('mlm-ac').addEventListener('click', e => { const tr = e.target.closest('tr[data-k]'); if (tr) pick(tr.dataset.k, true); });

  // ── Traffic window (from 2026-11-20) ─────────────────────────────────────
  // One row per aircraft with a fix in the last minute.  Columns: [key, heading, tooltip, numeric, value]
  const nmFrom = (lat, lon) => {
    const c = state && state.center; if (!c) return null;
    const r = Math.PI / 180, dlat = (lat - c[0]) * r, dlon = (lon - c[1]) * r;
    const a = Math.sin(dlat / 2) ** 2 + Math.cos(c[0] * r) * Math.cos(lat * r) * Math.sin(dlon / 2) ** 2;
    return 3440.065 * 2 * Math.asin(Math.sqrt(a));
  };
  const repGs = o => { const p = o.trk.length ? o.trk[o.trk.length - 1] : null; return p && p[8] != null ? p[8] : null; };
  const stateOf = o => o.last[6] ? (RP.on ? 'unresolved' : o.doubt ? 'in doubt' : o.nh > 1 ? 'unresolved' : 'new') : 'resolved';
  const dur = s => s == null ? '—' : s < 60 ? s + ' s' : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  const TCOLS = [
    ['ac', 'Aircraft', 'Callsign (or address) and type', 0, (k, o) => name(k, o)],
    ['icao', 'Address', 'Mode S address', 0, k => k],
    ['reg', 'Reg', 'Registration, when the aircraft database knows it (from the evening of 2026-11-20)', 0, (k, o) => o.reg || '\uffff'],
    ['lvl', 'Level', 'Up to the transition altitude the altitude on the EFHK METAR QNH (A023), above it the flight level; the arrow: climbing or descending 300 ft/min or more', 1, (k, o) => o.last[3]],
    ['gs', 'Speed', 'Ground speed in knots from our own track / the one the aircraft reports', 1, (k, o) => o.vel ? o.vel[0] : null],
    ['exp', 'Stated', 'Stated error of the last fix: from the timing errors and the geometry of the receivers, with a floor of 35 m', 1, (k, o) => o.last[4]],
    ['err', 'Measured', 'Median distance from the aircraft’s own ADS-B position over the last fixes — only for aircraft that broadcast one', 1, (k, o) => o.err],
    ['mm', 'Motion', 'How far the motion of our track is from the speed and direction the aircraft reports, m/s. Up to 25 the track counts as confirmed; above 40 it is put in doubt', 1, (k, o) => o.mm],
    ['st', 'State', 'resolved: one position, confirmed by its motion or old enough · unresolved: two positions possible · in doubt: the track no longer moves like the aircraft · new: not checked yet', 0, (k, o) => stateOf(o) + (o.pos ? '' : ' np')],
    ['rx', 'Rx', 'Receivers in the last fix', 1, (k, o) => o.nrx || 3],
    ['age', 'Track', 'How long the present track has run without a break', 1, (k, o) => o.tage],
    ['n', 'Fixes', 'Fixes of this aircraft since it was first located', 1, (k, o) => o.n],
    ['d', 'NM', 'Distance from the airport', 1, (k, o) => nmFrom(o.last[1], o.last[2])],
  ];
  // The window's two lists (from the evening of 2026-11-20): 'now' — the aircraft with a fix — and 'fl' — the stored
  // tracks of the last flRange hours (/api/mlat/replay/flights, newest first), each with a Replay button
  let trfMode = lsGet('ms_mlm_trfmode', 'now') === 'fl' ? 'fl' : 'now';
  let flRange = [3, 6, 12, 24].includes(+lsGet('ms_mlm_flrange', '24')) ? +lsGet('ms_mlm_flrange', '24') : 24;
  const flName = f => f.cs && f.cs !== f.icao ? f.cs : f.icao;
  const FCOLS = [
    ['ac', 'Aircraft', 'Callsign (or address) and type', 0, f => flName(f)],
    ['icao', 'Address', 'Mode S address', 0, f => f.icao],
    ['reg', 'Reg', 'Registration, when the aircraft database knows it', 0, f => f.reg || '\uffff'],
    ['t0', 'From', 'Start of the stored track, UTC', 1, f => f.t0],
    ['t1', 'To', 'End of the stored track, UTC. A break of 15 minutes or more starts a new track', 1, f => f.t1],
    ['len', 'Length', 'From the first to the last stored point', 1, f => f.t1 - f.t0],
    ['n', 'Points', 'Stored points: at most one every two seconds', 1, f => f.n],
    ['pos', 'Own position', 'Whether the aircraft broadcast a position of its own during the track; without one its place is known only from our receivers', 0, f => f.pos ? 'broadcast' : 'none'],
  ];
  let flSort = (() => { try { const v = JSON.parse(lsGet('ms_mlm_flsort', 'null')); return v && FCOLS.some(c => c[0] === v.k) ? v : { k: 't0', asc: false }; } catch (_) { return { k: 't0', asc: false }; } })();
  const flRows = () => { const t1 = RP.t1 != null ? RP.t1 : Date.now() / 1000; return RP.flights.map((f, i) => [f, i]).filter(([f]) => f.t1 >= t1 - flRange * 3600); };
  function trfModeUi() {
    for (const b of $('mlm-trf-mode').children) b.classList.toggle('on', b.dataset.trfm === trfMode);
    for (const b of $('mlm-trf-rng').children) b.classList.toggle('on', +b.dataset.flr === flRange);
    $('mlm-trf-rng').style.display = trfMode === 'fl' ? '' : 'none';
  }
  let flKey = null;                            // what the table shows: it is rewritten only when that changes (a replay asks 4 times a second)
  function flRender() {
    const key = [RP.flights.length, RP.t1, RP.t0, !!RP.got, flRange, flSort.k, flSort.asc, RP.on ? sel : '', light()].join('|');
    if (key === flKey) return;
    flKey = key;
    const rows = flRows(), col = FCOLS.find(c => c[0] === flSort.k) || FCOLS.find(c => c[0] === 't0'), C = COL();
    rows.sort((a, b) => { const x = col[4](a[0]), y = col[4](b[0]), c = col[3] ? x - y : String(x).localeCompare(String(y)); return flSort.asc ? c : -c; });
    const day = t => utc(t, true).slice(0, -9), today = day(RP.t1 != null ? RP.t1 : Date.now() / 1000);
    const len = v => v < 60 ? Math.round(v) + ' s' : v < 3600 ? Math.floor(v / 60) + ' min' : Math.floor(v / 3600) + ' h ' + String(Math.floor(v % 3600 / 60)).padStart(2, '0');
    $('mlm-trf-tab').innerHTML = '<thead><tr>' + FCOLS.map(c => `<th data-c="${c[0]}" title="${esc(c[2])}" class="${c[3] ? 'num' : ''}${c[0] === flSort.k ? ' srt' + (flSort.asc ? ' asc' : '') : ''}">${c[1]}</th>`).join('') + '<th></th></tr></thead><tbody>' +
      rows.slice(0, 1500).map(([f, i]) => `<tr data-i="${i}"${RP.on && sel === f.icao ? ' class="sel"' : ''}>` +
        `<td><b style="color:${f.pos ? C.pos : C.nopos}">${esc(flName(f))}</b> ${esc(f.typ || '')}</td><td><code>${esc(f.icao)}</code></td><td>${esc(f.reg || '—')}</td>` +
        `<td class="num">${day(f.t0) === today ? '' : day(f.t0) + ' '}${utc(f.t0).slice(0, 5)}</td><td class="num">${utc(f.t1).slice(0, 5)}</td><td class="num">${len(f.t1 - f.t0)}</td><td class="num">${f.n}</td>` +
        `<td>${f.pos ? 'broadcast' : '<span class="mlm-tag" title="Sent no position of its own">no position</span>'}</td>` +
        `<td><button type="button" class="mlm-fl-go" title="Replay this aircraft alone from the start of this track (Solo is turned on)">▶ Replay</button></td></tr>`).join('') +
      (rows.length ? '' : `<tr class="mst-dim"><td colspan="${FCOLS.length + 1}">${RP.t0 == null ? (RP.got ? 'Nothing is stored for the replay yet' : 'Loading…') : 'No aircraft located in the last ' + flRange + ' h'}</td></tr>`) + '</tbody>';
  }
  let trfSort = (() => { try { const v = JSON.parse(lsGet(LS.trfsort, 'null')); return v && TCOLS.some(c => c[0] === v.k) ? v : { k: 'd', asc: true }; } catch (_) { return { k: 'd', asc: true }; } })();
  function trfRender() {
    const win = $('mlm-trf');
    if (trfMode === 'fl') {                          // the Flights list does not depend on the live state
      $('mlm-trf-n').textContent = trfCount();
      if (S.trfon && !win.classList.contains('min')) flRender();
      return;
    }
    if (!S.trfon || !state || !state.on || win.classList.contains('min')) { if (state) $('mlm-trf-n').textContent = trfCount(); return; }
    flKey = null;
    const col = TCOLS.find(c => c[0] === trfSort.k) || TCOLS[0];
    const rows = [...AC.entries()].filter(([, o]) => o.last && state.now - o.last[0] <= 60);
    rows.sort((a, b) => {
      const x = col[4](a[0], a[1]), y = col[4](b[0], b[1]);
      if (x == null && y == null) return 0;
      if (x == null) return 1;                       // nothing to sort by: at the end
      if (y == null) return -1;
      const c = col[3] ? x - y : String(x).localeCompare(String(y));
      return trfSort.asc ? c : -c;
    });
    $('mlm-trf-n').textContent = trfCount();
    const C = COL();
    $('mlm-trf-tab').innerHTML = '<thead><tr>' + TCOLS.map(c => `<th data-c="${c[0]}" title="${esc(c[2])}" class="${c[3] ? 'num' : ''}${c[0] === trfSort.k ? ' srt' + (trfSort.asc ? ' asc' : '') : ''}">${c[1]}</th>`).join('') + '</tr></thead><tbody>' +
      rows.map(([k, o]) => {
        const p = o.last, vr = o.vr, arrow = vr == null ? '' : vr >= 300 ? '↑' : vr <= -300 ? '↓' : '', rg = repGs(o), st = stateOf(o), d = nmFrom(p[1], p[2]);
        return `<tr data-k="${esc(k)}"${sel === k ? ' class="sel"' : ''}>` +
          `<td><b style="color:${o.pos ? C.pos : C.nopos}">${esc(name(k, o))}</b> ${esc(o.typ || '')}</td><td><code>${esc(k)}</code></td><td>${esc(o.reg || '—')}</td>` +
          `<td class="num">${lvl(p[3])}${arrow}${S.sal && o.sal != null ? ' <span title="Selected altitude">' + lvl(o.sal) + '</span>' : ''}</td>` +
          `<td class="num">${o.vel ? Math.round(o.vel[0]) : '—'} / ${rg == null ? '—' : Math.round(rg)}</td>` +
          `<td class="num">±${mTxt(p[4])}</td><td class="num">${mTxt(o.err)}</td>` +
          `<td class="num${o.mm != null && o.mm > 25 ? ' w' : ''}">${o.mm == null ? '—' : Math.round(o.mm)}</td>` +
          `<td${st === 'resolved' ? '' : ' class="w"'}>${st}${o.pos ? '' : ' ' + NOPOS(o)}</td>` +
          `<td class="num">${o.nrx || (RP.on ? '—' : 3)}</td><td class="num">${dur(o.tage)}</td><td class="num">${o.n}</td><td class="num">${d == null ? '—' : d.toFixed(d < 10 ? 1 : 0)}</td></tr>`;
      }).join('') + (rows.length ? '' : `<tr class="mst-dim"><td colspan="${TCOLS.length}">No fixes in the last minute</td></tr>`) + '</tbody>';
  }
  function trfCount() {
    if (trfMode === 'fl') {
      const rows = flRows();
      return rows.length ? `${rows.length} tracks in the last ${flRange} h · ${rows.filter(r => !r[0].pos).length} without a position of their own` : '';
    }
    if (!state) return '';
    const live = [...AC.values()].filter(o => o.last && state.now - o.last[0] <= 60);
    return live.length ? `${live.length} aircraft · ${live.filter(o => !o.pos).length} without a position of their own` + (state.qnh != null ? ` · QNH ${Math.round(state.qnh)}` : '') : 'no fixes in the last minute';
  }
  // place, size and state: kept in the browser. The window belongs to the Map view (#mst-mlat-map), not to the map box, so
  // it can stand over the map or beside it (over the column on the right, or below the map on a narrow screen); it is
  // kept inside the view. Places are counted from the view's corner (v: 2; before 20.11.2026 evening: from the map's)
  function trfGeom() { try { return JSON.parse(lsGet(LS.trf, 'null')) || {}; } catch (_) { return {}; } }
  function trfSave() {
    const w = $('mlm-trf'), g = trfGeom(), min = w.classList.contains('min');
    g.x = w.offsetLeft; g.y = w.offsetTop; g.min = min; g.v = 2; g.reg = 1;
    if (!min && w.offsetWidth > 0) { g.w = w.offsetWidth; g.h = w.offsetHeight; }
    lsSet(LS.trf, JSON.stringify(g));
  }
  function trfClamp() {
    const w = $('mlm-trf'), box = $('mst-mlat-map');
    if (!box.clientWidth || w.style.display === 'none') return;
    // the whole window stays in the view, so its corner handle is always within reach; and it cannot be made larger than
    // the room between its place and the view's edge
    const x = Math.max(0, Math.min(w.offsetLeft, box.clientWidth - w.offsetWidth)), y = Math.max(0, Math.min(w.offsetTop, box.clientHeight - w.offsetHeight));
    w.style.left = x + 'px'; w.style.top = y + 'px';
    w.style.maxWidth = Math.max(240, box.clientWidth - x) + 'px'; w.style.maxHeight = Math.max(26, box.clientHeight - y) + 'px';
    // over the map it is slightly see-through; with more than half of it beside the map (over text) it is solid
    const mp = $('mlm-mapwrap'), cx = x + w.offsetWidth / 2, cy = y + w.offsetHeight / 2;
    w.classList.toggle('solid', cx < mp.offsetLeft || cx > mp.offsetLeft + mp.offsetWidth || cy < mp.offsetTop || cy > mp.offsetTop + mp.offsetHeight);
  }
  function trfShow() {
    const w = $('mlm-trf');
    w.style.display = S.trfon ? '' : 'none';
    if (S.trfon) trfClamp();
  }
  (function trfInit() {
    const w = $('mlm-trf'), hdr = $('mlm-trf-hdr'), g = trfGeom();
    if (g.x != null && g.v !== 2) { g.x += 12; g.y += 8; }          // a place stored against the map box: the same spot
    if (g.x != null) { w.style.left = g.x + 'px'; w.style.top = g.y + 'px'; }
    // the Reg column (20.11.2026) made the table a little wider than the old default: a window stored at about that
    // width is widened once, so that it does not get a sideways scroll bar from the new column
    if (g.w && !g.reg && g.w >= 780 && g.w < 850) g.w = 850;
    if (g.w) { w.style.width = g.w + 'px'; w.style.height = g.h + 'px'; }
    w.classList.toggle('min', !!g.min);
    let drag = null;
    hdr.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      drag = { x: e.clientX - w.offsetLeft, y: e.clientY - w.offsetTop };
      hdr.setPointerCapture(e.pointerId); e.preventDefault();
    });
    hdr.addEventListener('pointermove', e => {
      if (!drag) return;
      w.style.left = (e.clientX - drag.x) + 'px'; w.style.top = (e.clientY - drag.y) + 'px';
      trfClamp();
    });
    const end = () => { if (drag) { drag = null; trfSave(); } };
    hdr.addEventListener('pointerup', end); hdr.addEventListener('pointercancel', end);
    $('mlm-trf-min').addEventListener('click', () => {
      const min = !w.classList.contains('min');
      if (min) trfSave();                            // the open size, before it collapses
      w.classList.toggle('min', min);
      if (!min) { const q = trfGeom(); if (q.h) w.style.height = q.h + 'px'; }
      $('mlm-trf-min').textContent = min ? '+' : '–';
      trfSave(); trfRender();
    });
    $('mlm-trf-min').textContent = g.min ? '+' : '–';
    $('mlm-trf-tab').addEventListener('click', e => {
      const th = e.target.closest('th[data-c]');
      if (th && trfMode === 'fl') {
        flSort = { k: th.dataset.c, asc: flSort.k === th.dataset.c ? !flSort.asc : ['ac', 'icao', 'reg'].includes(th.dataset.c) };
        lsSet('ms_mlm_flsort', JSON.stringify(flSort)); trfRender(); return;
      }
      if (th) {
        trfSort = { k: th.dataset.c, asc: trfSort.k === th.dataset.c ? !trfSort.asc : true };
        lsSet(LS.trfsort, JSON.stringify(trfSort)); trfRender(); return;
      }
      const go = e.target.closest('button.mlm-fl-go'), fr = go && go.closest('tr[data-i]');
      if (fr) { rpFlight(RP.flights[+fr.dataset.i]); return; }
      const tr = e.target.closest('tr[data-k]');
      if (tr) pick(tr.dataset.k, true);
    });
    // the two lists and the range of the Flights list
    $('mlm-trf-mode').addEventListener('click', e => {
      const b = e.target.closest('[data-trfm]');
      if (!b || b.dataset.trfm === trfMode) return;
      trfMode = b.dataset.trfm; lsSet('ms_mlm_trfmode', trfMode); trfModeUi();
      flKey = null; $('mlm-trf-tab').innerHTML = '';
      if (trfMode === 'fl') rpRange(true);
      trfRender();
    });
    $('mlm-trf-rng').addEventListener('click', e => {
      const b = e.target.closest('[data-flr]');
      if (!b) return;
      flRange = +b.dataset.flr; lsSet('ms_mlm_flrange', String(flRange)); trfModeUi(); trfRender();
    });
    trfModeUi();
    // the corner handle resizes the window (CSS resize): remember the size; a window resize keeps it inside
    if (typeof ResizeObserver !== 'undefined') {
      let t = null;
      new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => { if (w.style.display !== 'none' && !drag) { trfClamp(); trfSave(); } }, 300); }).observe(w);
    }
    window.addEventListener('resize', trfClamp);
    // wheel and clicks in the window are not for anything under it
    for (const ev of ['wheel', 'dblclick', 'mousedown', 'touchstart']) w.addEventListener(ev, e => e.stopPropagation(), { passive: true });
  })();
})();
