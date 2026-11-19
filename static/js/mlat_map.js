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
 * The first request takes the whole trail; then only the new points every 5 s.
 * The fixes are a few seconds late (the server waits for clock references on
 * both sides of a reply).
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  if (!$('mst-mlat-map')) return;
  const POLL = 5000;
  const LS = { win: 'ms_mlm_win', exp: 'ms_mlm_exp', adsb: 'ms_mlm_adsb', amb: 'ms_mlm_amb', lbl: 'ms_mlm_lbl', vec: 'ms_mlm_vec', view: 'ms_mlm_view' };
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
  const AC = new Map();                       // icao → { cs, typ, pos, res, n, nrx, err, last, trk: [], adsb: [] }
  const S = {
    win: +lsGet(LS.win, '300'), exp: +lsGet(LS.exp, '500'),
    adsb: lsGet(LS.adsb, '1') === '1', amb: lsGet(LS.amb, '0') === '1', lbl: lsGet(LS.lbl, '1') === '1',
    vec: lsGet(LS.vec, '1') === '1',
  };
  let atc = null;                             // the canvas with the squares, vectors and labels
  let gridLayer = null, gridData = null, gridT = 0, selCh = {};
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
    if (onMap) { initMap(); setTimeout(() => map && map.invalidateSize(), 50); poll(true); if (S.grid) gridLoad(); }
  }
  document.addEventListener('mst-mlat', e => { tabOn = !!(e.detail && e.detail.on); apply(); });
  $('mst-mlat-views').addEventListener('click', e => {
    const b = e.target.closest('[data-mlview]');
    if (!b || b.dataset.mlview === view) return;
    view = b.dataset.mlview; lsSet(LS.view, view); apply();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && tabOn && view === 'map') poll(false); });

  // ── controls ────────────────────────────────────────────────────────────
  $('mlm-win').value = String(S.win); $('mlm-exp').value = String(S.exp);
  $('mlm-adsb').checked = S.adsb; $('mlm-amb').checked = S.amb; $('mlm-lbl').checked = S.lbl; $('mlm-vec').checked = S.vec;
  $('mlm-win').addEventListener('change', e => { S.win = +e.target.value; lsSet(LS.win, S.win); poll(true); });
  $('mlm-exp').addEventListener('change', e => { S.exp = +e.target.value; lsSet(LS.exp, S.exp); draw(); });
  $('mlm-grid').checked = S.grid = lsGet('ms_mlm_grid', '0') === '1';
  $('mlm-grid').addEventListener('change', e => { S.grid = e.target.checked; lsSet('ms_mlm_grid', S.grid ? '1' : '0'); gridLoad(); });
  document.addEventListener('mlc-range', () => { if (S.grid) gridLoad(); });
  for (const [id, k] of [['mlm-adsb', 'adsb'], ['mlm-amb', 'amb'], ['mlm-lbl', 'lbl'], ['mlm-vec', 'vec']]) {
    $(id).addEventListener('change', e => { S[k] = e.target.checked; lsSet(LS[k], S[k] ? '1' : '0'); draw(); });
  }

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
    if (typeof AtcDisplay !== 'undefined') atc = AtcDisplay.canvasLayer(map, drawTargets);
    if (window.msRxMarkers) { try { window.msRxMarkers(map).addTo(map); } catch (_) { /* the receivers are optional */ } }
    L.control.scale({ imperial: false, nautic: false }).addTo(map);
    new MutationObserver(() => { setTiles(); draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  // ── data ────────────────────────────────────────────────────────────────
  async function poll(full) {
    clearTimeout(timer);
    if (!tabOn || view !== 'map') return;
    if (document.hidden) { timer = setTimeout(() => poll(false), POLL); return; }
    // a full answer at the start and once a minute: the server drops the points of a
    // candidate position that turned out to be the wrong one of two
    if (full) { AC.clear(); last = 0; nPoll = 0; }
    const whole = !last || (++nPoll % 12 === 0);
    try {
      const r = await fetch(`/api/mlat/fixes?win=${S.win}${whole ? '' : '&since=' + last}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
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
      Object.assign(o, { cs: a.cs, typ: a.typ, pos: a.pos, res: a.res, n: a.n, nrx: a.nrx, err: a.err, last: a.last, vel: a.vel, vr: a.vr });
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
  function shown(o) { return o.last && (S.amb || !o.last[6]); }
  function draw() {
    if (!map || !layer) return;
    layer.clearLayers();
    const C = COL(), now = state ? state.now : 0;
    for (const [k, o] of AC) {
      if (!shown(o)) continue;
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
      m.on('click', () => { sel = sel === k ? null : k; draw(); renderList(); });
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
    if (S.grid && Date.now() - gridT > 60000) gridLoad();
    selPanel();
  }
  // Squares, speed vectors and labels, as the Live Map's ATC style (one canvas over the map)
  const fl3 = alt => String(Math.max(0, Math.round(alt / 100))).padStart(3, '0');
  function drawTargets(g, m, W, H) {
    if (!state || !state.on) return;
    const C = COL(), now = state.now, obst = [], items = [];
    for (const [k, o] of AC) {
      if (!shown(o)) continue;
      const lp = o.last;
      if ((lp[4] != null && lp[4] > S.exp) || now - lp[0] > 60) continue;
      const p = m.latLngToContainerPoint([lp[1], lp[2]]);
      if (p.x < -40 || p.y < -40 || p.x > W + 40 || p.y > H + 40) continue;
      const col = o.pos ? C.pos : C.nopos, on = sel === k, sz = on ? 9 : 8;
      const ac = { lat: lp[1], lon: lp[2], altitude: lp[3], icao: k, aircraft_type: o.typ, vert_rate: o.vr,
                   groundspeed: o.vel ? o.vel[0] : null, track: o.vel ? o.vel[1] : null };
      if (S.vec) AtcDisplay.drawVector(g, m, p, ac, VEC_SEC, col, 0.95, 1.5, obst);
      g.globalAlpha = 1;
      g.strokeStyle = col; g.lineWidth = on ? 1.8 : 1.5;
      g.setLineDash(lp[6] ? [2, 2] : []);
      g.strokeRect(Math.round(p.x - sz / 2) + 0.5, Math.round(p.y - sz / 2) + 0.5, sz, sz);
      g.setLineDash([]);
      if (!o.pos) { g.fillStyle = col; g.fillRect(p.x - 1.5, p.y - 1.5, 3, 3); }      // no position of its own: a dot inside
      if (on) { g.globalAlpha = 0.75; g.lineWidth = 1; g.strokeRect(Math.round(p.x - sz / 2 - 4) + 0.5, Math.round(p.y - sz / 2 - 4) + 0.5, sz + 8, sz + 8); g.globalAlpha = 1; }
      if (S.lbl) items.push({ key: k, p, lines: AtcDisplay.labelLines(ac, 'std', name(k, o), fl3), col, sel: on, fade: 1, alt: lp[3] });
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
    return `<b>${esc(name(k, o))}</b> ${esc(o.typ || '')} · ${esc(k)}<br>${p[3]} ft · ${o.nrx || 3} receivers<br>` +
      `expected ±${mTxt(p[4])}${o.err != null ? ` · measured ${mTxt(o.err)} from its ADS-B position` : (o.pos ? '' : ' · sends no position')}` +
      (p[6] ? '<br>unresolved: two positions possible' : '');
  }

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
      else stt = `line from ${r.clock.n} replies of ${r.clock.ac} aircraft · ±${r.clock.sig} ns · drift ${(r.clock.drift / 1000).toFixed(3)} ppm` +
        (r.clock.age > 30 ? ` · <span class="mst-warn">${Math.round(r.clock.age)} s old</span>` : '');
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
    $('mlm-ac').innerHTML = '<thead><tr><th>Aircraft</th><th>Address</th><th class="num">Alt ft</th><th class="num" title="Expected error of the last fix, from the geometry">Expected</th>' +
      '<th class="num" title="Median distance from the aircraft’s own ADS-B position, last fixes">Measured</th><th></th></tr></thead><tbody>' +
      rows.map(([k, o]) => `<tr data-k="${esc(k)}"${sel === k ? ' class="sel"' : ''}><td><b>${esc(name(k, o))}</b> ${esc(o.typ || '')}</td><td><code>${esc(k)}</code></td>` +
        `<td class="num">${o.last[3]}</td><td class="num">±${mTxt(o.last[4])}</td><td class="num">${mTxt(o.err)}</td>` +
        `<td>${o.pos ? '' : '<span class="mlm-tag" title="Sends no position of its own">no position</span>'}${o.last[6] ? ' <span class="mlm-tag" title="Two positions are still possible">unresolved</span>' : ''}</td></tr>`).join('') +
      (rows.length ? '' : '<tr class="mst-dim"><td colspan="6">No fixes in the last minute</td></tr>') + '</tbody>';
  }
  $('mlm-ac').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-k]');
    if (!tr) return;
    const k = tr.dataset.k, o = AC.get(k);
    sel = sel === k ? null : k;
    if (sel && o && o.last && map) map.panTo([o.last[1], o.last[2]]);
    if (sel && o && o.last && o.last[6] && !S.amb) { S.amb = true; $('mlm-amb').checked = true; }
    draw(); renderList();
  });
})();
