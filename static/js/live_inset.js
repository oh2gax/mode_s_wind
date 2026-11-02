/**
 * live_inset.js — the EFHK close-up box of the Live Map (from 2026-11-02).
 *
 * A small second map at the bottom right of the Live Map's map: EFHK with its
 * ILS / RNP finals and the airport, about 15 NM around it, with the same air
 * traffic as the big map.  Minimized by default (a small "EFHK · 15 NM" tab);
 * ▴ opens it, ▾ in its bottom-right corner minimizes it again.  It has its own
 * zoom (mouse wheel, + / −) and can be dragged; ⌂ goes back to EFHK at 15 NM.
 * The grip at its top-left corner resizes it (default 330 × 290 px).  The open
 * state, the size and the view are remembered in the browser (ms_liveInset).
 *
 * It follows the Live Map's settings: the map (Street: the street tiles of the
 * theme with the finals and the airport outline as on the Windshear page; ATC:
 * the ATC background and map lines, with the range rings of the Rings button),
 * the labels (Normal: as the Lbl button chooses; ATC: the three-line ATC labels,
 * the selected aircraft's extended label), the history plots and the speed
 * vectors (Hist, Vec), Solo, Meteo only and the selected aircraft.  A click on
 * an aircraft selects it as on the big map.  No weather overlay.
 *
 * Nothing new is fetched: it draws the aircraft the page already has
 * (live_map.js: aircraftData, markers, trails — the stream every 3 s), on one
 * canvas (static/js/atc_display.js), each time the big map's canvas is redrawn.
 * While minimized nothing is drawn, and its map is made at the first opening.
 * Loaded after live_map.js (it uses that file's top-level names).
 */
'use strict';

(function () {
  if (typeof map === 'undefined' || typeof AtcDisplay === 'undefined' || typeof plotLayer === 'undefined') return;
  const KEY = 'ms_liveInset';
  const DEF = { open: false, w: 330, h: 290, view: null };
  const MIN_W = 220, MIN_H = 180, RANGE_NM = 15;
  const st = (() => {
    try { return Object.assign({}, DEF, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (_) { return Object.assign({}, DEF); }
  })();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (_) { /* private mode */ } };

  // ── the box ────────────────────────────────────────────────────────────
  const host = map.getContainer();
  const box = L.DomUtil.create('div', 'lin-box', host);
  box.innerHTML =
      '<div class="lin-map"></div>'
    + '<div class="lin-grip" title="Drag to resize"></div>'
    + '<div class="lin-ctl leaflet-bar"><a href="#" class="lin-home" role="button" title="Back to EFHK, 15 NM around it" aria-label="Back to EFHK">'
    +   '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2.5 7.5 8 2.5l5.5 5M4 6.6V13.5h3V10h2v3.5h3V6.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg></a>'
    +   '<a href="#" class="lin-zin" role="button" title="Zoom in" aria-label="Zoom in">+</a><a href="#" class="lin-zout" role="button" title="Zoom out" aria-label="Zoom out">−</a></div>'
    + '<div class="lin-tag" title="The EFHK close-up: the same air traffic as the big map, with its own zoom — the map and the labels follow the Live Map\'s settings">EFHK</div>'
    + '<button type="button" class="lin-min" title="Minimize" aria-label="Minimize the EFHK close-up">▾</button>'
    + '<button type="button" class="lin-open" title="The EFHK close-up: the airport and its finals, about 15 NM around it, with the live traffic — its own zoom and drag; the map and the labels follow the Live Map\'s settings">'
    +   '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M2.3 11.5 13.7 4.5" stroke="currentColor" stroke-width="1" stroke-dasharray="2 1.5"/></svg>'
    +   '<span>EFHK · 15 NM</span><i>▴</i></button>';
  L.DomEvent.disableClickPropagation(box);
  L.DomEvent.disableScrollPropagation(box);
  ['pointerdown', 'touchstart', 'mousedown', 'dblclick', 'contextmenu'].forEach(t => box.addEventListener(t, e => e.stopPropagation()));
  const q = s => box.querySelector(s);

  let imap = null, layer = null, atcLines = null, tiles = null, tileKey = '', street = null, ilsFeat = null, styleKey = '';
  let lblRects = {}, lblPos = {};

  const nmPerPx = m => {                             // nautical miles per screen pixel at the centre
    const c = m.getCenter(), p = m.latLngToContainerPoint(c);
    return m.distance(c, m.containerPointToLatLng([p.x + 100, p.y])) / 100 / 1852;
  };
  function tagText() {
    if (!imap) return;
    const sz = imap.getSize(), r = Math.min(sz.x, sz.y) / 2 * nmPerPx(imap);
    q('.lin-tag').textContent = `EFHK · ${r >= 10 ? Math.round(r) : r.toFixed(1)} NM`;
  }
  // EFHK in the middle and 15 NM from it to the nearer edge of the box
  function homeView() {
    if (!imap) return;
    const c = L.latLng(AIRPORT_LAT, AIRPORT_LON), sz = imap.getSize();
    imap.setView(c, 10, { animate: false });
    const want = RANGE_NM / (Math.min(sz.x, sz.y) / 2);              // NM per pixel
    imap.setView(c, 10 + Math.log2(nmPerPx(imap) / want), { animate: false });
  }

  function layout() {
    const mw = host.clientWidth, mh = host.clientHeight;
    const w = Math.max(MIN_W, Math.min(st.w, Math.max(MIN_W, mw - 70))), h = Math.max(MIN_H, Math.min(st.h, Math.max(MIN_H, mh - 70)));
    box.classList.toggle('open', !!st.open);
    if (st.open) { box.style.width = w + 'px'; box.style.height = h + 'px'; }
    else { box.style.width = ''; box.style.height = ''; }
    // the big map's legend keeps left of the open box
    const lg = document.querySelector('.map-legend');
    if (lg) lg.style.maxWidth = st.open ? `calc(100% - ${w + 44}px)` : '';
    if (imap) imap.invalidateSize({ animate: false });
  }

  // ── the map and its style ──────────────────────────────────────────────
  function makeMap() {
    imap = L.map(q('.lin-map'), { zoomControl: false, attributionControl: false, zoomSnap: 0, zoomDelta: 0.5,
                                  wheelPxPerZoomLevel: 90, minZoom: 6, maxZoom: 14 });
    layout();
    if (st.view && Number.isFinite(st.view.lat) && Number.isFinite(st.view.lon) && Number.isFinite(st.view.z)) imap.setView([st.view.lat, st.view.lon], st.view.z, { animate: false });
    else homeView();
    imap.on('moveend', () => {
      if (!imap.getSize().x) return;
      const c = imap.getCenter();
      st.view = { lat: +c.lat.toFixed(4), lon: +c.lng.toFixed(4), z: imap.getZoom() }; save();
      tagText();
    });
    atcLines = AtcDisplay.mapLines(imap);
    layer = AtcDisplay.canvasLayer(imap, draw);
    imap.on('click', onClick);
    imap.on('mousemove', e => { imap.getContainer().style.cursor = acAt(e.containerPoint) ? 'pointer' : ''; });
    applyStyle(true);
    tagText();
  }
  // the street style's finals and airport outline (as the Windshear page)
  async function streetLines() {
    if (street) return street;
    const [ils, apt] = await Promise.all(['efhk_ils', 'efhk_apt'].map(n => fetch(`/overlays/${n}.geojson`).then(r => r.ok ? r.json() : null).catch(() => null)));
    ilsFeat = ils ? (ils.features || []).filter(f => f.properties && f.properties.airport === 'EFHK') : [];
    street = { ils: { type: 'FeatureCollection', features: ilsFeat }, apt, layer: null };
    return street;
  }
  async function applyStyle(force) {
    if (!imap) return;
    const light = document.documentElement.dataset.theme === 'light', atc = liveMap === 'atc';
    const key = (atc ? 'atc' : 'street') + (light ? 'L' : 'D');
    if (!force && key === styleKey) return;
    styleKey = key;
    imap.getContainer().style.background = atc ? AtcDisplay.pal().bg : '';
    // tiles (street)
    const tk = light ? 'L' : 'D';
    if (!atc) {
      if (!tiles || tileKey !== tk) { if (tiles) tiles.remove(); tiles = L.tileLayer(light ? TILE_LIGHT : TILE_DARK, TILE_OPTS); tileKey = tk; }
      if (!imap.hasLayer(tiles)) tiles.addTo(imap);
    } else if (tiles) tiles.remove();
    atcLines.show(atc);
    // the street finals and airport
    const s = await streetLines();
    if (styleKey !== key) return;                     // a newer style meanwhile
    if (s.layer) { s.layer.remove(); s.layer = null; }
    if (!atc) {
      const g = L.layerGroup();
      const ils = light ? { color: '#475569', weight: 1.5, opacity: 0.8 } : { color: '#38bdf8', weight: 1.5, opacity: 0.6 };
      const rnp = light ? { color: '#a16207', weight: 1.5, opacity: 0.8 } : { color: '#f59e0b', weight: 1.5, opacity: 0.7 };
      L.geoJSON(s.ils, { interactive: false, style: f => Object.assign({ dashArray: f.properties?.approach_type === 'RNP' ? '10 5' : '6 5', fill: false },
                                                                    f.properties?.approach_type === 'RNP' ? rnp : ils) }).addTo(g);
      if (s.apt) L.geoJSON(s.apt, { interactive: false, style: { color: light ? '#475569' : '#94a3b8', weight: 1, opacity: light ? 0.6 : 0.5, fill: false } }).addTo(g);
      s.layer = g.addTo(imap);
    }
    if (layer) layer.redraw();
  }

  // ── the traffic ────────────────────────────────────────────────────────
  const shown = () => Object.entries(aircraftData).filter(([k, a]) => markers[k] && a.lat && a.lon && !soloHide(k));
  // the normal labels in text, as the big map's (liveLabelHtml) at the Lbl level
  function normalLines(ac) {
    const lv = lblLvl;
    if (lv === 'off') return null;
    const cs = callsignCache[ac.icao] || ac.callsign || ac.icao, ty = ac.aircraft_type || '';
    if (lv === 'cs') return [cs];
    if (lv === 'reg') return [ac.registration || cs];
    if (lv === 'icao') return [ac.icao];
    if (lv === 'type') return [ty || '—'];
    const vr = ac.vert_rate, tr = vr == null ? '' : vr >= 300 ? '↑' : vr <= -300 ? '↓' : '';
    const sel = lv === 'full' ? selAltTxt(ac) : '';
    const l2 = ac.landed ? 'landed' : liveAtcAlt(ac.altitude) + (sel || tr);
    return [cs + ((lv === 'type+' || lv === 'full') && ty ? ' ' + ty : ''), l2];
  }
  function draw(g, m, W, H) {
    if (!st.open) return;
    const atcMap = liveMap === 'atc', atcL = lblAtc(), P = AtcDisplay.pal();
    if (atcMap) AtcDisplay.drawRings(g, m, W, H, ringNm, AIRPORT_LAT, AIRPORT_LON);
    const obst = [...AtcDisplay.domObstacles(m, '.lin-ctl, .lin-tag, .lin-min, .lin-grip')];
    if (atcMap) obst.push(...atcLines.obstacles(W, H));
    else if (ilsFeat) obst.push(...AtcDisplay.lineObstacles(m, ilsFeat, W, H));
    const lbls = [];
    for (const [icao, ac] of shown()) {
      const p0 = m.latLngToContainerPoint([ac.lat, ac.lon]);
      if (p0.x < -200 || p0.y < -200 || p0.x > W + 200 || p0.y > H + 200) continue;
      const col = acSymColor(ac), sel = icao === selectedIcao, fade = ac.landed ? 0.4 : 1;
      if (histN) {
        const curTs = ac.pos_ts || ac.last_seen || 0;
        AtcDisplay.drawPlots(g, m, (trails[icao] || []).filter(x => x[2] < curTs).slice(-histN), histN, col, fade, obst);
      }
      AtcDisplay.drawVector(g, m, p0, ac, vecS, sel && !atcMap ? selColorNow() : col, 0.9 * fade, 1.3, obst);
      // the symbol: an open square as on the big map (the selected one larger; ATC: with a frame)
      const s = sel ? 9 : 8;
      g.globalAlpha = fade;
      g.lineWidth = sel ? 1.6 : 1.5;
      g.strokeStyle = sel && !atcMap ? selColorNow() : col;
      g.strokeRect(p0.x - s / 2, p0.y - s / 2, s, s);
      if (sel && atcMap) { g.lineWidth = 1; g.globalAlpha = 0.75 * fade; g.strokeRect(p0.x - s / 2 - 4, p0.y - s / 2 - 4, s + 8, s + 8); }
      g.globalAlpha = 1;
      obst.push({ x: p0.x - 7, y: p0.y - 7, w: 14, h: 14 });
      const lines = atcL
        ? (sel ? AtcDisplay.extLines(ac, selExt.key === icao ? selExt.data : null, {
                   cs: callsignCache[icao] || ac.callsign || icao, lvl3: atcLvl3, apt: [AIRPORT_LAT, AIRPORT_LON, AIRPORT_NAME] })
               : atcLabelLines(ac))
        : normalLines(ac);
      if (lines) lbls.push({ key: icao, p: p0, lines, sel, fade, ext: atcL && sel, col: atcMap ? P.high : streetLblCol(), alt: ac.altitude ?? 99999 });
    }
    lblRects = lbls.length ? AtcDisplay.drawLabels(g, lbls, W, H, obst, lblPos, 11, atcMap ? {} : streetLblOpt()) : {};
  }
  // the aircraft (its square or its label) under a point of the box's map
  function acAt(pt) {
    if (!imap) return null;
    for (const [k, r] of Object.entries(lblRects)) if (r && pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h) return k;
    let best = null, bd = 10;
    for (const [icao, ac] of shown()) {
      const p = imap.latLngToContainerPoint([ac.lat, ac.lon]), d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d <= bd) { bd = d; best = icao; }
    }
    return best;
  }
  function onClick(e) {
    const icao = acAt(e.containerPoint);
    if (icao) selectAircraft(icao);
  }

  // redrawn with the big map's canvas (every stream update and every settings change)
  const bigRedraw = plotLayer.redraw.bind(plotLayer);
  plotLayer.redraw = function () {
    bigRedraw();
    if (st.open && imap) { applyStyle(false); layer.redraw(); }
  };

  // ── open / minimize / resize ───────────────────────────────────────────
  function setOpen(v) {
    st.open = !!v; save();
    layout();
    if (st.open && !imap) makeMap();
    else if (st.open) { applyStyle(false); layer.redraw(); tagText(); }
    plotLayer.redraw();                               // the big map's labels keep clear of the box
  }
  q('.lin-open').addEventListener('click', () => setOpen(true));
  q('.lin-min').addEventListener('click', () => setOpen(false));
  q('.lin-home').addEventListener('click', e => { e.preventDefault(); homeView(); });
  q('.lin-zin').addEventListener('click', e => { e.preventDefault(); if (imap) imap.zoomIn(0.5); });
  q('.lin-zout').addEventListener('click', e => { e.preventDefault(); if (imap) imap.zoomOut(0.5); });
  // the grip at the top-left corner: the box grows up and to the left
  q('.lin-grip').addEventListener('pointerdown', e => {
    e.preventDefault();
    const g = e.currentTarget, x0 = e.clientX, y0 = e.clientY, w0 = box.offsetWidth, h0 = box.offsetHeight;
    g.setPointerCapture(e.pointerId);
    const mv = ev => {
      st.w = Math.round(Math.max(MIN_W, Math.min(w0 + x0 - ev.clientX, host.clientWidth - 70)));
      st.h = Math.round(Math.max(MIN_H, Math.min(h0 + y0 - ev.clientY, host.clientHeight - 70)));
      layout();
    };
    const up = () => { g.removeEventListener('pointermove', mv); g.removeEventListener('pointerup', up); save(); if (imap) { tagText(); layer.redraw(); } plotLayer.redraw(); };
    g.addEventListener('pointermove', mv);
    g.addEventListener('pointerup', up);
  });
  new ResizeObserver(() => { if (st.open) layout(); }).observe(host);

  layout();
  if (st.open) makeMap();
  window.LiveInset = { open: () => setOpen(true), close: () => setOpen(false), map: () => imap };
})();
