/**
 * app_wx.js — the phone's Weather view (/app, from 2026-10-30): the MEPS
 * surface maps of the Weather page with a time slider, preloading and an
 * animation, and optionally the live air traffic in the style of the Live
 * Map (static/js/atc_display.js).
 *
 * Loaded by app.js the first time the view is opened, after Leaflet,
 * wx_layer.js (the weather drawing shared with the Weather page and the Live
 * Map) and atc_display.js.  app.js keeps the settings (the menu's Weather
 * options, localStorage ms_app_wx_*) and calls init / show / hide / refresh /
 * option / theme.
 *
 *  - Hours: the newest MEPS run from 6 h back to +24 or +48 h (Forecast),
 *    from /api/weather/index; the frames from /api/weather/frames on the
 *    20 or 10 km grid (Grid), only the fields of the layers shown, and only
 *    the part of the grid over Finland and the Baltic Sea (bbox, a third of
 *    the whole area).  Load: all hours at once (nearest the slider first, in
 *    chunks of 12) or only those within ±6 h of the slider.  The loaded hours
 *    are kept while the view is open; the index is read again every 10 min.
 *  - Slider, −1h / ▶ / +1h / Now; ▶ plays the loaded hours (Speed).
 *  - A tap on the map: the values of that place (WxLayer.describe; they
 *    follow the slider), or the aircraft under the finger; a tap on the card
 *    closes it.
 *  - Air traffic (On): /api/live/traffic every 6 s (slim, gzip) — always the
 *    traffic of now, whatever hour the slider shows; squares, history plots
 *    (one per poll, the last 5), 1-min speed vectors and labels kept apart
 *    (AtcDisplay.drawLabels, 10 px): Standard callsign / FL, or ATC three
 *    lines.  Map style ATC: no street map but the ATC background with the
 *    coastline, the airport, the finals and the borders, monochrome symbols.
 *  - Rain source (from 2026-10-30): MEPS model, FMI radar or Both, as the Live
 *    Map's ☂ panel.  The radar is the newest FMI composite (/api/radar/latest,
 *    rain rate every 5 min, about 2 km, Finland and the nearby seas), read
 *    every 4 min while the view is shown with a radar source, and drawn only
 *    at the present hour of the slider (WxLayer.setOverlay): Radar alone
 *    without the model's rain, Both with the model's rain outside the radar
 *    area and as outlines inside it.  The other hours show the model's rain.
 *    Rain opacity and Radar opacity (25–100 %, 75 % by default) set the two
 *    rains' opacity separately (WxLayer options rainAlpha / radarAlpha).
 */
'use strict';

window.AppWx = (() => {
  const BBOX = [55.5, 14, 70.5, 34];           // Finland and the Baltic Sea (lat0, lon0, lat1, lon1)
  const PAST_H = 6, HOUR = 3600, CHUNK = 12, NEAR_H = 6;
  const SPEED_MS = { slow: 800, normal: 400, fast: 200 };
  const HOME = [60.3, 24.95], HOME_ZOOM = 6, VIEW_KEY = 'ms_app_wxMapView';
  const ATTR = 'model MEPS, MET Norway (CC BY 4.0)';
  let borderSeq = 0;
  let C = null;               // from app.js: { $, lsGet, lsSet, esc, S (settings), sub(text) }
  let map = null, wx = null, tiles = null, tileTheme = null, atcLines = null, border = null, borderGeo = null;
  let hours = [], view = [], grid = null, frames = new Map(), loadedKey = '', loadRun = 0, bytes = 0;
  let current = null, playing = false, playRun = 0, indexAt = 0, shown = false;
  let traffic = null, trafficAt = 0, trafficLayer = null, trails = {}, lblPos = {}, tip = null, tipMk = null;
  let radar = null, radarAt = 0, radarErr = '', radarOn = false;    // the FMI radar (Rain source)
  const pad = n => String(n).padStart(2, '0');
  const nowTs = () => Math.floor(Date.now() / 1000);
  const isLight = () => document.documentElement.dataset.theme === 'light';
  const $ = id => C.$(id);

  // ── settings → layer options, fields ──────────────────────────────────
  const S = () => C.S;
  const atcMap = () => S().mapst === 'atc' && typeof AtcDisplay !== 'undefined';
  const useRadar = () => S().src === 'radar' || S().src === 'both';
  function layerOptions() {
    const s = S();
    return { rain: s.rain === 'on', pres: s.pres === 'on', wind: s.wind === 'on', gust: s.gust === 'on',
             clouds: s.cloud !== 'off' ? [s.cloud] : [],
             modelOutline: radarOn && s.src === 'both', edge: radarOn,
             rainAlpha: (+s.rainop || 75) / 100, radarAlpha: (+s.radarop || 75) / 100 };
  }
  function fieldList() {
    const s = S(), f = ['p', 'r', 's'];
    if (s.cloud !== 'off') f.push(s.cloud, 'b');
    if (s.wind === 'on') f.push('u', 'v');
    if (s.gust === 'on') f.push('g');
    return f.join(',');
  }

  // ── map ───────────────────────────────────────────────────────────────
  function savedView() {
    try {
      const v = JSON.parse(C.lsGet(VIEW_KEY, 'null'));
      if (v && Number.isFinite(v.lat) && Number.isFinite(v.lon) && v.z >= 3 && v.z <= 12) return v;
    } catch (_) { /* the default view */ }
    return null;
  }
  function init(ctx) {
    C = ctx;
    const sv = savedView();
    map = L.map('app-wx-map', { zoomControl: true, attributionControl: true, maxZoom: 11, minZoom: 4 })
           .setView(sv ? [sv.lat, sv.lon] : HOME, sv ? sv.z : HOME_ZOOM);
    map.attributionControl.setPrefix(false);
    map.on('moveend', () => {
      if (!map.getSize().x) return;
      const c = map.getCenter();
      C.lsSet(VIEW_KEY, JSON.stringify({ lat: +c.lat.toFixed(3), lon: +c.lng.toFixed(3), z: map.getZoom() }));
    });
    const Home = L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const box = L.DomUtil.create('div', 'leaflet-bar ms-map-home');
        const a = L.DomUtil.create('a', '', box);
        a.href = '#'; a.title = 'Back to the airport (default view)';
        a.setAttribute('role', 'button'); a.setAttribute('aria-label', a.title);
        a.innerHTML = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">'
          + '<path d="M2.5 7.5 8 2.5l5.5 5M4 6.6V13.5h3V10h2v3.5h3V6.6" fill="none" stroke="currentColor" '
          + 'stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>';
        L.DomEvent.disableClickPropagation(box);
        L.DomEvent.on(a, 'click', e => { L.DomEvent.preventDefault(e); map.setView(HOME, HOME_ZOOM); });
        return box;
      },
    });
    new Home().addTo(map);
    wx = WxLayer.create(map, { pane: 'wxPane', zIndex: 350 });
    wx.setOptions(layerOptions());
    trafficLayer = AtcDisplay.canvasLayer(map, drawTraffic);
    map.on('click', onTap);
    $('app-wx-tip').addEventListener('click', closeTip);
    $('app-wx-t').addEventListener('input', () => { if (playing) play(); showFrame(); maybeLoadNear(); });
    $('app-wx-play').addEventListener('click', play);
    $('app-wx-prev').addEventListener('click', () => stepHour(-1));
    $('app-wx-next').addEventListener('click', () => stepHour(1));
    $('app-wx-now').addEventListener('click', () => { if (playing) play(); $('app-wx-t').value = presentIndex(); showFrame(); maybeLoadNear(); });
    applyMapStyle();
    renderLegend();
  }

  // Street: the CARTO tiles of the theme with the MEPS attribution; ATC: no
  // tiles but the ATC background, AtcDisplay.mapLines (coast, airport, finals)
  // and the borders
  function applyMapStyle() {
    const atc = atcMap(), want = atc ? 'atc-' + (isLight() ? 'light' : 'dark') : (isLight() ? 'light' : 'dark');
    if (want === tileTheme) return;
    tileTheme = want;
    if (tiles) { map.removeLayer(tiles); tiles = null; }
    const el = map.getContainer();
    if (atc) {
      el.style.background = AtcDisplay.pal().bg;
      if (!atcLines) atcLines = AtcDisplay.mapLines(map);
      atcLines.show(true);
      showBorder(true);
      map.attributionControl.addAttribution(ATTR);
    } else {
      el.style.background = '';
      if (atcLines) atcLines.show(false);
      showBorder(false);
      map.attributionControl.removeAttribution(ATTR);
      const key = CARTO_API_KEY ? `?key=${encodeURIComponent(CARTO_API_KEY)}` : '';
      tiles = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${isLight() ? 'light_all' : 'dark_all'}/{z}/{x}/{y}{r}.png${key}`,
        { attribution: '© OSM © CARTO · model MEPS, MET Norway (CC BY 4.0)', subdomains: 'abcd', maxZoom: 12 }).addTo(map);
      tiles.bringToBack();
    }
  }
  async function showBorder(on) {
    const my = ++borderSeq;
    if (border) { border.remove(); border = null; }
    if (!on) return;
    if (!borderGeo) borderGeo = await fetch('/overlays/efhk_border.geojson').then(r => r.ok ? r.json() : null).catch(() => null);
    if (my !== borderSeq || !borderGeo || !atcMap()) return;
    border = L.geoJSON(borderGeo, { interactive: false, pane: 'atcMapPane',
      style: { color: AtcDisplay.pal().coast, weight: 1, opacity: 0.9, dashArray: '4 3', fill: false } }).addTo(map);
  }

  // ── hours and frames ──────────────────────────────────────────────────
  async function loadIndex() {
    indexAt = Date.now();
    try {
      const d = await (await fetch('/api/weather/index', { cache: 'no-store' })).json();
      hours = d.hours || [];
    } catch (_) { status('Could not load the weather map index.'); return; }
    buildView();
  }
  function presentIndex() {
    const now = nowTs();
    let k = 0;
    view.forEach((h, i) => { if (h[0] <= now) k = i; });
    return k;
  }
  function buildView() {
    const now = nowTs(), el = $('app-wx-t');
    const cur = view.length ? view[+el.value]?.[0] : null;
    view = hours.filter(h => h[0] >= now - PAST_H * HOUR && h[0] <= now + (+S().fc) * HOUR);
    el.max = Math.max(0, view.length - 1);
    let k = cur != null ? view.findIndex(h => h[0] === cur) : -1;
    if (k < 0) k = presentIndex();
    el.value = Math.max(0, k);
    ticks();
    drawStrip();
    loadFrames();
    showFrame();
  }
  const fresh = h => { const f = frames.get(h[0]); return f && f.run === h[1] && f.lead === h[2] && (f.w || 0) === (h[3] || 0); };
  async function loadFrames() {
    const step = S().grid === '20' ? 2 : 1, fields = fieldList(), key = step + '|' + fields;
    if (loadedKey !== key) { frames.clear(); loadedKey = key; grid = null; }
    const run = ++loadRun, cur = +$('app-wx-t').value;
    const near = S().load === 'near';
    const need = view.map((h, i) => ({ h, i }))
      .filter(o => !fresh(o.h) && (!near || Math.abs(o.i - cur) <= NEAR_H))
      .sort((a, b) => Math.abs(a.i - cur) - Math.abs(b.i - cur));
    for (let k = 0; k < need.length; k += CHUNK) {
      if (run !== loadRun || !shown) return;
      const ts = need.slice(k, k + CHUNK).map(o => o.h[0]).sort((a, b) => a - b);
      try {
        const r = await fetch(`/api/weather/frames?ts=${ts.join(',')}&step=${step}&fields=${fields}&bbox=${BBOX.join(',')}`);
        const txt = await r.text();
        if (run !== loadRun) return;
        bytes += +(r.headers.get('content-length') || 0) || Math.round(txt.length / 3);
        const d = JSON.parse(txt);
        if (d.grid && (!grid || JSON.stringify(d.grid) !== JSON.stringify(grid))) { if (grid) frames.clear(); grid = d.grid; }
        for (const f of d.frames || []) frames.set(f.ts, f);
      } catch (_) { status('Could not load the weather maps.'); return; }
      drawStrip();
      const h = view[+$('app-wx-t').value];
      if (h && ts.includes(h[0])) showFrame();
      else statusLine();
    }
  }
  function maybeLoadNear() {
    if (S().load !== 'near') return;
    const cur = +$('app-wx-t').value;
    if (view.some((h, i) => Math.abs(i - cur) <= NEAR_H && !fresh(h))) loadFrames();
  }
  function drawStrip() {
    const el = $('app-wx-strip');
    if (el.children.length !== view.length) el.innerHTML = '<i></i>'.repeat(view.length);
    const now = nowTs();
    view.forEach((h, i) => { el.children[i].className = (fresh(h) ? 'ok' : '') + (h[0] > now ? ' fc' : ''); });
  }
  function ticks() {
    const el = $('app-wx-ticks');
    if (view.length < 2) { el.innerHTML = ''; return; }
    const t0 = view[0][0], t1 = view[view.length - 1][0], wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    el.innerHTML = view.filter(h => new Date(h[0] * 1000).getUTCHours() % 12 === 0).map(h => {
      const d = new Date(h[0] * 1000);
      return `<span style="left:${((h[0] - t0) / (t1 - t0) * 100).toFixed(1)}%">${d.getUTCHours() ? '12 UTC' : `${wd[d.getUTCDay()]} ${d.getUTCDate()}.${d.getUTCMonth() + 1}.`}</span>`;
    }).join('');
  }

  // ── drawing ───────────────────────────────────────────────────────────
  function showFrame() {
    const el = $('app-wx-t'), k = +el.value, h = view[k];
    $('app-wx-prev').disabled = !view.length || k <= 0;
    $('app-wx-next').disabled = !view.length || k >= +el.max;
    if (!h) {
      current = null; wx.setFrame(null);
      $('app-wx-time').textContent = '—'; $('app-wx-rel').textContent = ''; $('app-wx-run').textContent = '';
      status(hours.length ? 'No model hours in this period.' : 'No weather maps stored yet.');
      return;
    }
    const d = new Date(h[0] * 1000), r = new Date(h[1] * 1000), now = nowTs();
    const rel = Math.round((h[0] - Math.floor(now / HOUR) * HOUR) / HOUR);
    $('app-wx-time').textContent = `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${d.getUTCDate()}.${d.getUTCMonth() + 1}. ${pad(d.getUTCHours())} UTC`;
    $('app-wx-rel').innerHTML = h[0] > now ? `<span class="fc">+${rel} h</span>` : rel === 0 ? 'now' : `${rel} h`;
    $('app-wx-run').textContent = `MEPS ${pad(r.getUTCHours())} UTC run`;
    C.sub(`MEPS ${r.getUTCDate()}.${r.getUTCMonth() + 1}. ${pad(r.getUTCHours())} UTC · ${S().grid} km · −${PAST_H} … +${S().fc} h`);
    const f = frames.get(h[0]);
    if (!f) { statusLine('loading this hour…'); return; }
    current = f;
    // the radar at the present hour only (the newest composite); Radar alone: without the model's rain
    const on = useRadar() && !!radar && k === presentIndex();
    if (on !== radarOn) { radarOn = on; wx.setOptions(layerOptions()); renderLegend(); }
    wx.setOverlay(on ? radar : null, on ? radar.grid : null);
    wx.setFrame(on && S().src === 'radar' ? Object.assign({}, f, { r: null, s: null }) : f, grid);
    if (on) { const t = new Date(radar.ts * 1000); $('app-wx-rel').innerHTML = `now · <span class="rd">radar ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}</span>`; }
    if (tip && tip.ll && !tip.ac) showTip(tip.ll);
    statusLine();
  }
  function statusLine(extra) {
    const n = view.filter(fresh).length;
    const tr = S().traffic === 'on' && traffic ? (() => { const t = new Date(traffic.t * 1000);
      return `traffic live ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())} UTC · ${traffic.ac.length} aircraft · `; })() : '';
    let rd = '', rain = 'rain of the hour before the shown time';
    if (useRadar()) {
      if (radar) {
        const t = new Date(radar.ts * 1000), age = Math.max(0, Math.round((Date.now() / 1000 - radar.ts) / 60));
        rd = radarOn ? `FMI radar ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())} UTC (${age} min old) · rain rate, about ${radar.km} km · ` +
                       (S().src === 'both' ? 'model rain outside the radar area, outlined inside it · ' : '')
                     : `FMI radar only at the present hour (Now) · `;
        if (radarOn) rain = 'radar: FMI open data, CC BY 4.0 · model';
      } else rd = radarErr ? `FMI radar not reachable${radarErr} — trying again in a few minutes · ` : 'FMI radar loading… · ';
    }
    status(`${tr}${rd}${extra ? extra + ' · ' : ''}${n} / ${view.length} hours loaded · ${(bytes / 1e6).toFixed(1)} MB · ${rain} · MET Norway, CC BY 4.0`);
    $('app-wx-loading').hidden = n >= view.length || !view.length || S().load === 'near';
    $('app-wx-loading').textContent = `Loading ${n} / ${view.length} hours…`;
  }
  const status = t => { $('app-wx-status').textContent = t; };
  function renderLegend() { $('app-wx-legend').innerHTML = WxLayer.legendHtml(layerOptions()); }

  // ── animation ─────────────────────────────────────────────────────────
  async function play() {
    playing = !playing;
    $('app-wx-play').textContent = playing ? '■' : '▶';
    $('app-wx-play').setAttribute('aria-label', playing ? 'Stop' : 'Play');
    if (!playing) return;
    const run = ++playRun, el = $('app-wx-t');
    while (playing && run === playRun && shown) {
      let v = +el.value + 1;
      if (v > +el.max) v = 0;
      el.value = v;
      showFrame();
      if (!fresh(view[v] || [])) maybeLoadNear();
      await new Promise(res => setTimeout(res, fresh(view[v] || []) ? SPEED_MS[S().speed] || 400 : 150));
    }
  }
  function stepHour(dv) {
    if (playing) play();
    const el = $('app-wx-t'), v = +el.value + dv;
    if (v < 0 || v > +el.max) return;
    el.value = v; showFrame(); maybeLoadNear();
  }

  // ── tap read-out ──────────────────────────────────────────────────────
  function onTap(e) {
    // the card at the top of the map when the tap is in its lower half (not over the place)
    $('app-wx-tip').classList.toggle('top', e.containerPoint.y > map.getSize().y / 2);
    const ac = S().traffic === 'on' ? acAt(e.containerPoint) : null;
    if (ac) { tip = { ac: ac[0] }; showAcTip(ac); return; }
    if (!current) return;
    tip = { ll: e.latlng };
    showTip(e.latlng);
  }
  function showTip(ll) {
    let txt = '';
    if (current) {
      const v = wx.valuesAt(ll), ra = radarOn ? wx.radarAt(ll) : null;
      if (v && radarOn && S().src === 'radar') { delete v.r; delete v.s; }
      txt = wx.describe(v, ll);
      if (ra) txt += ra.in ? ` · radar ${ra.r >= 10 ? (ra.r / 100).toFixed(1) + ' mm/h' : 'dry'}` : ' · outside the radar';
    }
    if (!txt) { closeTip(); return; }
    if (tipMk) tipMk.setLatLng(ll); else tipMk = L.marker(ll, { interactive: false, keyboard: false,
      icon: L.divIcon({ className: '', iconSize: [0, 0], html: '<div class="app-wx-pin"></div>' }) }).addTo(map);
    $('app-wx-tip').innerHTML = `${C.esc(txt)}<small>tap elsewhere on the map for another place · tap here to close</small>`;
    $('app-wx-tip').hidden = false;
  }
  function showAcTip(a) {
    const [icao, cs, type, , , alt, gs, trk, vr, sel] = a;
    if (tipMk) { tipMk.remove(); tipMk = null; }
    const lvl = alt == null ? '—' : alt < 5000 ? `${alt.toLocaleString('en-US')} ft` : `FL${String(Math.round(alt / 100)).padStart(3, '0')}`;
    const v = vr == null ? '' : vr >= 300 ? ` climbing ${vr} ft/min` : vr <= -300 ? ` descending ${-vr} ft/min` : ' level';
    $('app-wx-tip').innerHTML = `<b>${C.esc(cs || icao)}</b> ${C.esc(type || '')} · ${lvl}${v}` +
      `${sel != null ? ` · selected ${sel < 5000 ? 'A' + String(Math.round(sel / 100)).padStart(3, '0') : 'FL' + String(Math.round(sel / 100)).padStart(3, '0')}` : ''}` +
      ` · ${gs != null ? gs + ' kt' : '—'}${trk != null ? ` · track ${String(trk).padStart(3, '0')}°` : ''}` +
      `<small>live traffic, ${C.esc(icao)} · tap here to close</small>`;
    $('app-wx-tip').hidden = false;
  }
  function closeTip() {
    $('app-wx-tip').hidden = true;
    if (tipMk) { tipMk.remove(); tipMk = null; }
    tip = null;
  }

  // ── FMI radar ─────────────────────────────────────────────────────────
  // the newest composite, at most every 4 min (the server looks every 5 min)
  async function loadRadar(force) {
    if (!useRadar() || !shown) return;
    if (!force && radar && Date.now() - radarAt < 4 * 60 * 1000) return;
    if (!force && !radar && Date.now() - radarAt < 60 * 1000) return;     // after a failure: once a minute
    radarAt = Date.now();
    let d = null;
    try {
      const r = await fetch('/api/radar/latest', { cache: 'no-store' });
      d = await r.json();
      bytes += +(r.headers.get('content-length') || 0);
    } catch (_) { d = null; }
    if (d && d.ts && d.grid) {
      if (!radar || radar.ts !== d.ts) radar = { ts: d.ts, rs: d.rs, cov: d.cov, grid: d.grid, km: d.km };
      radarErr = '';
    } else {
      radar = null;
      radarErr = d && d.error ? ` (${String(d.error).slice(0, 60)})` : '';
    }
    showFrame();
  }

  // ── air traffic ───────────────────────────────────────────────────────
  async function loadTraffic(force) {
    if (S().traffic !== 'on' || !shown) return;
    if (!force && Date.now() - trafficAt < 5000) return;
    trafficAt = Date.now();
    try {
      const d = await (await fetch('/api/live/traffic', { cache: 'no-store' })).json();
      traffic = d && Array.isArray(d.ac) ? d : null;
    } catch (_) { return; }
    if (!traffic) return;
    const keep = new Set();
    for (const a of traffic.ac) {
      keep.add(a[0]);
      if (a[10] > 15) continue;                            // no new position lately: no new plot
      AtcDisplay.addTrail(trails[a[0]] || (trails[a[0]] = []), a[3], a[4], traffic.t - a[10]);
    }
    for (const k of Object.keys(trails)) if (!keep.has(k)) delete trails[k];
    trafficLayer.redraw();
    if (tip && tip.ac) { const a = traffic.ac.find(x => x[0] === tip.ac); if (a) showAcTip(a); else closeTip(); }
    statusLine();
  }
  const asAc = a => ({ icao: a[0], callsign: a[1], aircraft_type: a[2], lat: a[3], lon: a[4], altitude: a[5],
                       groundspeed: a[6], track: a[7], vert_rate: a[8], sel_alt: a[9] });
  function symCol(a) {
    if (atcMap()) return AtcDisplay.symColor(a);
    return isLight() ? '#0f172a' : '#f8fafc';
  }
  function drawTraffic(g, m, W, H) {
    if (S().traffic !== 'on' || !traffic) return;
    const atcL = S().tlbl === 'atc', lbls = [];
    const obst = AtcDisplay.domObstacles(m, '.leaflet-control-zoom, .ms-map-home, #app-wx-tip:not([hidden]), #app-wx-loading:not([hidden])');
    const lvl3 = pa => String(Math.round(pa / 100)).padStart(3, '0');
    for (const r of traffic.ac) {
      const a = asAc(r), p0 = m.latLngToContainerPoint([a.lat, a.lon]);
      if (p0.x < -200 || p0.y < -200 || p0.x > W + 200 || p0.y > H + 200) continue;
      const c = symCol(a);
      const pts = (trails[a.icao] || []).slice(0, -1).slice(-5);
      AtcDisplay.drawPlots(g, m, pts, 5, c, 1, obst);
      AtcDisplay.drawVector(g, m, p0, a, 60, c, 0.9, 1.3, obst);
      g.globalAlpha = 1; g.strokeStyle = c; g.lineWidth = 1.5;
      g.strokeRect(Math.round(p0.x) - 3.5, Math.round(p0.y) - 3.5, 7, 7);
      obst.push({ x: p0.x - 5, y: p0.y - 5, w: 10, h: 10 });
      lbls.push({ key: a.icao, p: p0, col: c, sel: false, fade: 1, alt: a.altitude ?? 99999,
                  lines: atcL ? AtcDisplay.labelLines(a, 'full', a.callsign || a.icao, lvl3)
                              : [a.callsign || a.icao, a.altitude == null ? '---' : a.altitude < 5000 ? `${a.altitude} ft` : 'FL' + lvl3(a.altitude)] });
    }
    if (lbls.length) AtcDisplay.drawLabels(g, lbls, W, H, obst, lblPos, 10);
  }
  // the aircraft under the finger (within 22 px)
  function acAt(pt) {
    if (!traffic) return null;
    let best = null, bd = 22 * 22;
    for (const a of traffic.ac) {
      const p = map.latLngToContainerPoint([a[3], a[4]]), d = (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2;
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }

  // ── from app.js ───────────────────────────────────────────────────────
  function show() {
    shown = true;
    map.invalidateSize();
    applyMapStyle();
    if (!hours.length || Date.now() - indexAt > 10 * 60 * 1000) loadIndex(); else { buildView(); }
    if (S().traffic === 'on') loadTraffic(true);
    loadRadar();
  }
  function hide() { shown = false; if (playing) play(); }
  function layout() { if (map) { map.invalidateSize(); trafficLayer && trafficLayer.redraw(); } }
  function refresh() {                                     // every 6 s while the view is shown
    if (!shown) return;
    if (S().traffic === 'on') loadTraffic();
    loadRadar();
    if (!playing && Date.now() - indexAt > 10 * 60 * 1000) loadIndex();
  }
  function option(key) {                                   // a Weather option changed in the menu
    if (['rain', 'pres', 'wind', 'gust', 'cloud'].includes(key)) {
      wx.setOptions(layerOptions()); renderLegend();
      if (key !== 'rain' && key !== 'pres') loadFrames();
      else showFrame();
    } else if (key === 'fc') buildView();
    else if (key === 'grid') { bytes = 0; loadFrames(); }
    else if (key === 'load') loadFrames();
    else if (key === 'mapst') { applyMapStyle(); trafficLayer.redraw(); }
    else if (key === 'traffic') { if (S().traffic === 'on') loadTraffic(true); else { traffic = null; trails = {}; trafficLayer.redraw(); closeTip(); } statusLine(); }
    else if (key === 'tlbl') trafficLayer.redraw();
    else if (key === 'rainop' || key === 'radarop') wx.setOptions(layerOptions());
    else if (key === 'src') {
      if (!useRadar()) { radar = null; radarErr = ''; }
      radarOn = null; showFrame();                         // re-applies the options and the overlay
      if (useRadar()) loadRadar(true); else { wx.setOptions(layerOptions()); renderLegend(); }
      if (tip && tip.ll) showTip(tip.ll);
    }
  }
  function theme() {
    if (!map) return;
    applyMapStyle();                                       // the street tiles or the ATC lines in the theme's colours
    wx.redraw(); renderLegend(); trafficLayer.redraw();
  }
  return { init, show, hide, layout, refresh, option, theme, ready: () => !!map };
})();
