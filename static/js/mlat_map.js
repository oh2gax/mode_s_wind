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
 * stored time and a list of the aircraft located.  In replay the same drawing code runs on
 * the stored points; the statistics and the receivers' clocks are live only.
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
  async function gridLoad() {
    if (!gridLayer) return;
    if (!S.grid) { gridData = null; gridLayer.clearLayers(); draw(); return; }
    gridT = Date.now();
    try {
      const rng = lsGet('ms_mlc_rng', '1h');
      const d = await (await fetch('/api/mlat/fixstats?range=' + rng, { cache: 'no-store' })).json();
      gridData = d.on ? { cells: d.grid || {}, cell: d.cell, rng } : null;
    } catch (_) { /* keeps the last grid */ }
    gridDraw(); draw();
  }
  function gridDraw() {
    if (!gridLayer) return;
    gridLayer.clearLayers();
    if (!S.grid || !gridData) return;
    const [dla, dlo] = gridData.cell, col = GRID_COL();
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
  document.addEventListener('mlc-range', () => { if (S.grid) gridLoad(); });
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
  function initMap() {
    if (map) return;
    map = L.map('mlm-map', { zoomControl: true, preferCanvas: true, attributionControl: true }).setView([60.317, 24.963], 8);
    renderer = L.canvas({ padding: 0.3 });
    setTiles();
    map.createPane('mlmGrid').style.zIndex = 350;
    map.getPane('mlmGrid').style.pointerEvents = 'none';
    gridLayer = L.layerGroup().addTo(map);
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
      const r = await fetch(`/api/mlat/fixes?win=${S.win}${whole ? '' : '&since=' + last}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      if (RP.on) return;                             // the replay was started meanwhile
      state = d;
      if (d.on) merge(d, whole);
      render(d);
    } catch (e) {
      $('mlm-note').textContent = 'Update failed — retrying';
    }
    timer = setTimeout(() => poll(false), POLL);
  }
  function merge(d, whole) {
    if (!last && d.center && map && !map._mlmCentred) { map.setView(d.center, 8); map._mlmCentred = true; }
    const seen = new Set();
    for (const a of d.aircraft || []) {
      seen.add(a.icao);
      let o = AC.get(a.icao);
      if (!o) { o = { trk: [], adsb: [] }; AC.set(a.icao, o); }
      Object.assign(o, { cs: a.cs, typ: a.typ, pos: a.pos, res: a.res, n: a.n, nrx: a.nrx, err: a.err, last: a.last, vel: a.vel, vr: a.vr, sal: a.sal,
                         mm: a.mm, nh: a.nh, tage: a.tage, doubt: a.doubt });
      if (whole) { o.trk = a.trk || []; o.adsb = a.adsb || []; continue; }
      const t1 = o.trk.length ? o.trk[o.trk.length - 1][0] : 0, t2 = o.adsb.length ? o.adsb[o.adsb.length - 1][0] : 0;
      for (const p of a.trk || []) if (p[0] > t1) o.trk.push(p);
      for (const p of a.adsb || []) if (p[0] > t2) o.adsb.push(p);
    }
    const t0 = d.now - S.win;
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
  function draw() {
    if (!map || !layer) return;
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
    if (atc) atc.redraw();
    $('mlm-legend').innerHTML =
      `<div><i style="border-color:${C.pos}"></i>our fix — aircraft also broadcasts its position</div>` +
      `<div><i style="border-color:${C.nopos}"></i>our fix — aircraft sends no position (a dot in its square)</div>` +
      (S.adsb ? `<div><i style="border-color:${C.adsb};border-top-width:1px"></i>broadcast ADS-B track · <i style="border-color:${C.link};border-top-width:2px;width:10px"></i>difference now</div>` : '') +
      (S.amb ? '<div>dashed: unresolved — two positions possible</div>' : '') +
      (S.grid && gridData ? `<div class="mlm-gridleg">median error, ${gridData.rng}:` + GRID_COL().map((c, i) => `<b style="background:${c}"></b>${i < 4 ? '≤ ' + GRID_CL[i] : '> 500'}`).join('') + ' m</div>' : '');
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
    $('mlm-selt').textContent = `${name(sel, o)} ${o.typ || ''} · ${sel}`;
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
  function tip(k, o) {
    const p = o.last;
    return `<b>${esc(name(k, o))}</b> ${esc(o.typ || '')} · ${esc(k)}<br>${lvl(p[3])}${onQnh(p[3]) != null ? ` (QNH ${Math.round(state.qnh)})` : ''} · ${o.nrx || 3} receivers<br>` +
      `expected ±${mTxt(p[4])}${o.err != null ? ` · measured ${mTxt(o.err)} from its ADS-B position` : (o.pos ? '' : ' · sends no position')}` +
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
      if (!d.on || d.t0 == null) { RP.t0 = RP.t1 = null; return; }
      RP.t0 = d.t0; RP.t1 = d.t1; RP.flights = d.flights || [];
      const sl = $('mlm-rp-sl'); sl.min = Math.floor(d.t0); sl.max = Math.ceil(d.t1);
      if (!RP.on) sl.value = sl.max;
      const fl = $('mlm-rp-fl'), cur = fl.value;
      fl.innerHTML = `<option value="">Flights… (${RP.flights.length})</option>` + RP.flights.slice(0, 600).map((f, i) =>
        `<option value="${i}">${esc(f.cs && f.cs !== f.icao ? f.cs : f.icao)} ${esc(f.typ || '')} · ${utc(f.t0).slice(0, 5)}–${utc(f.t1).slice(0, 5)}${f.pos ? '' : ' · no position'}</option>`).join('');
      fl.value = cur && fl.querySelector(`option[value="${cur}"]`) ? cur : '';
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
    const t = RP.t, from = t - S.win, c0 = Math.floor(from / RP_CHUNK), c1 = Math.floor(t / RP_CHUNK);
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
        if (!o) { o = { cs: a.cs, typ: a.typ, pos: !!a.pos, trk: [], adsb: [] }; acc.set(k, o); }
        if (a.cs) o.cs = a.cs; if (a.typ) o.typ = a.typ; if (a.pos) o.pos = true;
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
    if (!map._mlmCentred && state.center) { map.setView(state.center, 8); map._mlmCentred = true; }
    const live = [...AC.values()].filter(o => t - o.last[0] <= 60), withErr = live.map(o => o.last[5]).filter(v => v != null && !isNaN(v)).sort((a, b) => a - b);
    const tile = (v, l, tt) => `<div class="mlm-tile" title="${esc(tt)}"><b>${v}</b><span>${l}</span></div>`;
    $('mlm-tiles').innerHTML = tile(utc(t).slice(0, 5), 'replay, UTC', 'Time of the picture') + tile(live.length, 'aircraft', 'Aircraft with a stored position in the minute before') +
      tile(live.filter(o => !o.pos).length, 'no own position', 'Of them, aircraft that broadcast no position of their own') +
      tile(withErr.length ? mTxt(withErr[Math.floor(withErr.length / 2)]) : '—', 'median error now', 'Median distance between our track and the aircraft’s own position, the aircraft in the picture');
    $('mlm-note').textContent = `Replay · ${utc(t, true)} UTC · ×${RP.speed}${RP.play ? '' : ' · paused'}${missing ? ' · loading…' : ''}`;
    $('mlm-rp-t').textContent = utc(t, true);
    if (document.activeElement !== $('mlm-rp-sl')) $('mlm-rp-sl').value = Math.round(t);
    draw(); renderList();
  }
  function rpUi() {
    $('mlm-rp').classList.toggle('rp', RP.on);
    $('mlm-rp-live').classList.toggle('on', !RP.on);
    $('mlm-rp-play').classList.toggle('on', RP.on && RP.play);
    $('mlm-rp-play').textContent = RP.on && RP.play ? '❚❚' : '▶';
    $('mlm-liveonly').style.display = RP.on ? 'none' : '';
    $('mlm-rpnote').style.display = RP.on ? '' : 'none';
    if (!RP.on) { $('mlm-rp-t').textContent = 'Live'; if (RP.t1 != null) $('mlm-rp-sl').value = $('mlm-rp-sl').max; }
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
  $('mlm-rp-fl').addEventListener('change', e => {
    const f = RP.flights[+e.target.value];
    if (e.target.value === '' || !f) return;
    sel = f.icao;
    S.solo = true; $('mlm-solo').checked = true; lsSet(LS.solo, '1');
    if (!S.amb) { S.amb = true; $('mlm-amb').checked = true; }               // its unresolved stretches too
    rpGo(f.t0 + 2, true);
  });
  for (const ev of ['wheel', 'dblclick', 'mousedown', 'touchstart']) $('mlm-rp').addEventListener(ev, e => e.stopPropagation(), { passive: true });

  // ── side panel ──────────────────────────────────────────────────────────
  function render(d) {
    const note = $('mlm-note');
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
      if (!r.site) stt = `<span class="mst-warn">no antenna position${r.why ? ' (' + esc(r.why) + ')' : ''}</span>`;
      else if (r.gps) stt = r.bit === (d.receivers.find(x => x.gps) || {}).bit ? 'time reference' : `constant ${r.bias > 0 ? '+' : ''}${r.bias} ns` + (r.bias_ac ? ` · from ${r.bias_ac} aircraft, 10 min` : '');
      else if (!r.clock) stt = '<span class="mst-warn">no clock line yet</span>';
      // from 2026-11-20: a line may rest on ONE other aircraft (many replies over a long stretch; the fix
      // then carries a wider timing error), and a line that was fitted but is too weak for a fix says so
      else stt = `line from ${r.clock.n} replies of ${r.clock.ac} aircraft` +
        (r.clock.ac === 1 && !r.clock.weak ? ' <span title="Only one other aircraft with a good position is heard together with this receiver: the line is used with a wider timing error">(one reference)</span>' : '') +
        ` · ±${r.clock.sig} ns · drift ${(r.clock.drift / 1000).toFixed(3)} ppm` +
        (r.clock.weak ? ' · <span class="mst-warn" title="Too few replies, too short a stretch or too much scatter for a position fix">too weak for a fix</span>' : '') +
        (r.clock.age > 30 ? ` · <span class="mst-warn" title="No other aircraft with a good position has been heard together with this receiver since then: no position fixes meanwhile">${Math.round(r.clock.age)} s old</span>` : '');
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
        `<td>${o.pos ? '' : '<span class="mlm-tag" title="Sends no position of its own">no position</span>'}${o.last[6] ? ' <span class="mlm-tag" title="Two positions are still possible">unresolved</span>' : ''}</td></tr>`).join('') +
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
  let trfSort = (() => { try { const v = JSON.parse(lsGet(LS.trfsort, 'null')); return v && TCOLS.some(c => c[0] === v.k) ? v : { k: 'd', asc: true }; } catch (_) { return { k: 'd', asc: true }; } })();
  function trfRender() {
    const win = $('mlm-trf');
    if (!S.trfon || !state || !state.on || win.classList.contains('min')) { if (state) $('mlm-trf-n').textContent = trfCount(); return; }
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
          `<td><b style="color:${o.pos ? C.pos : C.nopos}">${esc(name(k, o))}</b> ${esc(o.typ || '')}</td><td><code>${esc(k)}</code></td>` +
          `<td class="num">${lvl(p[3])}${arrow}${S.sal && o.sal != null ? ' <span title="Selected altitude">' + lvl(o.sal) + '</span>' : ''}</td>` +
          `<td class="num">${o.vel ? Math.round(o.vel[0]) : '—'} / ${rg == null ? '—' : Math.round(rg)}</td>` +
          `<td class="num">±${mTxt(p[4])}</td><td class="num">${mTxt(o.err)}</td>` +
          `<td class="num${o.mm != null && o.mm > 25 ? ' w' : ''}">${o.mm == null ? '—' : Math.round(o.mm)}</td>` +
          `<td${st === 'resolved' ? '' : ' class="w"'}>${st}${o.pos ? '' : ' <span class="mlm-tag" title="Sends no position of its own">no position</span>'}</td>` +
          `<td class="num">${o.nrx || (RP.on ? '—' : 3)}</td><td class="num">${dur(o.tage)}</td><td class="num">${o.n}</td><td class="num">${d == null ? '—' : d.toFixed(d < 10 ? 1 : 0)}</td></tr>`;
      }).join('') + (rows.length ? '' : `<tr class="mst-dim"><td colspan="${TCOLS.length}">No fixes in the last minute</td></tr>`) + '</tbody>';
  }
  function trfCount() {
    const live = [...AC.values()].filter(o => o.last && state.now - o.last[0] <= 60);
    return live.length ? `${live.length} aircraft · ${live.filter(o => !o.pos).length} without a position of their own` + (state.qnh != null ? ` · QNH ${Math.round(state.qnh)}` : '') : 'no fixes in the last minute';
  }
  // place, size and state: kept in the browser, and kept inside the map area
  function trfGeom() { try { return JSON.parse(lsGet(LS.trf, 'null')) || {}; } catch (_) { return {}; } }
  function trfSave() {
    const w = $('mlm-trf'), g = trfGeom(), min = w.classList.contains('min');
    g.x = w.offsetLeft; g.y = w.offsetTop; g.min = min;
    if (!min && w.offsetWidth > 0) { g.w = w.offsetWidth; g.h = w.offsetHeight; }
    lsSet(LS.trf, JSON.stringify(g));
  }
  function trfClamp() {
    const w = $('mlm-trf'), box = $('mlm-mapwrap');
    if (!box.clientWidth || w.style.display === 'none') return;
    const x = Math.max(0, Math.min(w.offsetLeft, box.clientWidth - Math.min(w.offsetWidth, 120))), y = Math.max(0, Math.min(w.offsetTop, box.clientHeight - 26));
    w.style.left = x + 'px'; w.style.top = y + 'px';
  }
  function trfShow() {
    const w = $('mlm-trf');
    w.style.display = S.trfon ? '' : 'none';
    if (S.trfon) trfClamp();
  }
  (function trfInit() {
    const w = $('mlm-trf'), hdr = $('mlm-trf-hdr'), g = trfGeom();
    if (g.x != null) { w.style.left = g.x + 'px'; w.style.top = g.y + 'px'; }
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
      if (th) {
        trfSort = { k: th.dataset.c, asc: trfSort.k === th.dataset.c ? !trfSort.asc : true };
        lsSet(LS.trfsort, JSON.stringify(trfSort)); trfRender(); return;
      }
      const tr = e.target.closest('tr[data-k]');
      if (tr) pick(tr.dataset.k, true);
    });
    // the corner handle resizes the window (CSS resize): remember the size; a window resize keeps it inside
    if (typeof ResizeObserver !== 'undefined') {
      let t = null;
      new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => { if (w.style.display !== 'none' && !drag) { trfClamp(); trfSave(); } }, 300); }).observe(w);
    }
    window.addEventListener('resize', trfClamp);
    // wheel and clicks in the window are not for the map under it
    for (const ev of ['wheel', 'dblclick', 'mousedown', 'touchstart']) w.addEventListener(ev, e => e.stopPropagation(), { passive: true });
  })();
})();
