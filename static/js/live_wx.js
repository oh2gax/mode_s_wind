/**
 * live_wx.js — weather overlay on the Live Map (from 2026-10-23).
 *
 * A ☂ button at the top right of the map opens a small panel: the source
 * (Off / MEPS model / FMI radar / Both), what to show (MEPS: rain and snow,
 * low cloud, fog, isobars; radar: the observed rain rate) and an opacity
 * slider.  Both: the radar's rain inside its coverage (dashed edge), the
 * model's rain outside it (and inside it as outlines, from 2026-10-26), and
 * the model's clouds, fog and isobars.
 * The radar (/api/radar/latest, web/api/radar.py) covers Finland and the
 * nearby seas only, the model the whole MEPS area — so MEPS is the default.  The overlay lies in its own pane under the
 * aircraft (wx_layer.js, the same drawing as the Weather page) and shows the
 * model's current hour — the rain of the hour ending at the next full hour —
 * on the stored 10 km grid (/api/weather/frames).  It refreshes itself: at
 * each full hour, and when a newer model run has been stored (the index is
 * read every 5 minutes).  All choices are remembered in the browser; with the
 * panel closed the button shows what is on.
 *
 * Wind (from 2026-10-25): a Wind row, independent of the source, draws MEPS
 * wind barbs in their own pane above the weather — the 10 m wind (with the
 * gust shading if ticked) from the stored weather maps (whole MEPS area), or
 * the wind at FL50 / 100 / 200 / 300 / 340 / 390 from the stored Wind Map
 * fields (± 300 km around the receiver, /api/meps/winds).  Nothing extra is
 * downloaded by the server.  Hovering a barb shows its wind and temperature.
 *
 * Mode S wind (from 2026-10-25 evening): at the same flight levels the
 * aircraft's own winds of the last 1 / 3 (default) / 6 / 12 / 24 h, averaged
 * into 50 km cells exactly as on the Wind Map page (/api/windmap: heading
 * calibration, frozen / jumping positions removed, QNH below FL050, ± 1 000 ft),
 * drawn in colour by speed (the Wind Map colours) and faint where only one or
 * two aircraft are behind a cell; MEPS and Mode S can be shown together.
 *
 * 2.5 km detail (from 2026-10-31): as on the Weather page, zoomed in to
 * FINE_ZOOM or closer with the box around the receiver in view, the MEPS
 * fields inside the box come from the full 2.5 km grid (same run as the
 * 10 km hour; /api/weather/frames?fine=1, WxLayer.setFine).  Off with the
 * "2.5 km detail" tick box.
 *
 * Receiver coverage (from 2026-10-31): a thin light-blue line around the area
 * the receiver heard in the last 24 h — the farthest ADS-B position per 10°
 * sector, all heights (/api/coverage, the Statistics page's range data).  The
 * API gives a list of receivers; the line is the outline of their union
 * (each outline stroked twice as wide, then all insides cleared), so more
 * receivers later give their combined coverage.  Independent of the source.
 */
'use strict';

(function () {
  if (typeof map === 'undefined' || typeof WxLayer === 'undefined') return;
  const KEY = 'ms_liveWx';
  const DEF = { src: 'off', rain: true, low: false, fog: false, pres: false, op: 60, open: false,
                wind: 'off', gust: false, wMeps: true, wModes: false, wPer: 180, fine: true, cov: false };
  const FINE_ZOOM = 7;                 // as the Weather page
  const COV_HOURS = 24;
  const PERIODS = [[60, '1 h'], [180, '3 h'], [360, '6 h'], [720, '12 h'], [1440, '24 h']];
  const MODES_CELL_KM = 50, MODES_TOL_FT = 1000;
  const WIND_LEVELS = [['off', 'Off'], ['sfc', '10 m'], ['50', 'FL50'], ['100', 'FL100'], ['200', 'FL200'],
                       ['300', 'FL300'], ['340', 'FL340'], ['390', 'FL390']];
  let st = Object.assign({}, DEF);
  try { Object.assign(st, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* defaults */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* private mode */ } };

  const layer = WxLayer.create(map, { pane: 'wxPane', zIndex: 350, rainAlpha: 0.85, cloudMax: 0.45 });
  // the MEPS wind barbs: own pane above the weather, under the aircraft; muted colours
  // so they are not mistaken for the winds measured by the aircraft
  const windLayer = WxLayer.create(map, { pane: 'wxWindPane', zIndex: 360, gustAlpha: 0.5,
                                          barb: ['rgba(186,198,214,0.85)', 'rgba(51,65,85,0.8)'] });
  const pad2 = n => String(n).padStart(2, '0');

  // ── Mode S wind barbs: cells of the Wind Map at the level ────────────────
  const MODES_COL = { dark: ['#6ee7b7', '#3b82f6', '#f59e0b', '#ef4444'], light: ['#047857', '#1d4ed8', '#b45309', '#b91c1c'] };
  const modesLayer = (() => {
    const paneName = 'wxModesPane';
    if (!map.getPane(paneName)) { const p = map.createPane(paneName); p.style.zIndex = 365; p.style.pointerEvents = 'none'; }
    const canvas = L.DomUtil.create('canvas', 'wx-canvas');
    canvas.style.position = 'absolute'; canvas.style.left = '0'; canvas.style.top = '0'; canvas.style.pointerEvents = 'none';
    map.getPane(paneName).appendChild(canvas);
    let cells = null, meta = null, drawn = [], on = false;
    const isLight = () => document.documentElement.dataset.theme === 'light';
    const col = spd => { const p = MODES_COL[isLight() ? 'light' : 'dark']; return spd < 15 ? p[0] : spd < 30 ? p[1] : spd < 50 ? p[2] : p[3]; };
    function place() {
      const size = map.getSize(), dpr = window.devicePixelRatio || 1;
      L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
      canvas.width = Math.round(size.x * dpr); canvas.height = Math.round(size.y * dpr);
      canvas.style.width = size.x + 'px'; canvas.style.height = size.y + 'px';
      draw();
    }
    function draw() {
      const ctx = canvas.getContext('2d'), dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawn = [];
      if (!on || !cells) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.lineCap = 'round';
      const sz = map.getSize();
      const list = [];
      for (const c of [...cells].sort((a, b) => (b.ac || 0) - (a.ac || 0))) {      // best-covered cells first
        const q = map.latLngToContainerPoint([c.lat, c.lon]);
        if (q.x < -20 || q.y < -20 || q.x > sz.x + 20 || q.y > sz.y + 20) continue;
        if (list.some(o => Math.hypot(o[0] - q.x, o[1] - q.y) < 30)) continue;     // keep about 30 px apart
        list.push([q.x, q.y, c]);
      }
      const halo = isLight() ? 'rgba(241,245,249,0.9)' : 'rgba(15,25,35,0.85)';
      for (const pass of ['halo', 'line']) {
        for (const [x, y, c] of list) {
          ctx.globalAlpha = (c.ac || 0) >= 3 ? 1 : (c.ac || 0) === 2 ? 0.7 : 0.45;
          ctx.strokeStyle = ctx.fillStyle = pass === 'halo' ? halo : col(c.wind_spd);
          ctx.lineWidth = pass === 'halo' ? 3.4 : 1.6;
          WxLayer.barb(ctx, x, y, c.wind_dir, c.wind_spd);
          if (pass === 'line') { ctx.beginPath(); ctx.arc(x, y, 2, 0, 2 * Math.PI); ctx.fill(); }
        }
      }
      ctx.globalAlpha = 1;
      drawn = list;
    }
    map.on('zoomstart', () => { canvas.style.visibility = 'hidden'; });
    map.on('zoomend moveend resize', () => { canvas.style.visibility = ''; place(); });
    place();
    return {
      set(c, m) { cells = c; meta = m || null; draw(); },
      show(v) { on = !!v; canvas.style.display = on ? '' : 'none'; draw(); },
      redraw: draw,
      meta: () => meta,
      at(pt, r = 12) {
        if (!on) return null;
        let best = null, bd = r * r;
        for (const d of drawn) { const k = (d[0] - pt.x) ** 2 + (d[1] - pt.y) ** 2; if (k <= bd) { bd = k; best = d[2]; } }
        return best;
      },
    };
  })();

  // ── Receiver coverage: the outline of the union of the receivers' areas ──
  const COV_COL = { dark: 'rgba(191,219,254,0.9)', light: 'rgba(29,78,216,0.75)' };
  const covLayer = (() => {
    const paneName = 'wxCovPane';
    if (!map.getPane(paneName)) { const p = map.createPane(paneName); p.style.zIndex = 368; p.style.pointerEvents = 'none'; }
    const canvas = L.DomUtil.create('canvas', 'wx-canvas');
    canvas.style.position = 'absolute'; canvas.style.left = '0'; canvas.style.top = '0'; canvas.style.pointerEvents = 'none';
    map.getPane(paneName).appendChild(canvas);
    let data = null, on = false, segs = [];      // [[x, y, sector] …] per receiver, for the hover
    function place() {
      const size = map.getSize(), dpr = window.devicePixelRatio || 1;
      L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
      canvas.width = Math.round(size.x * dpr); canvas.height = Math.round(size.y * dpr);
      canvas.style.width = size.x + 'px'; canvas.style.height = size.y + 'px';
      draw();
    }
    function draw() {
      const ctx = canvas.getContext('2d'), dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
      segs = [];
      if (!on || !data) return;
      const rings = data.receivers.filter(r => r.outline && r.outline.length >= 3).map(r => {
        const ring = r.outline.map(([la, lo]) => map.latLngToContainerPoint([la, lo]));
        const sec = r.sectors.filter(Boolean);
        segs.push(ring.map((p, k) => [p.x, p.y, sec[k]]));
        return ring;
      });
      if (!rings.length) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const path = () => { ctx.beginPath(); for (const ring of rings) { ring.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); } };
      // stroke twice the width, then clear every inside: the outer half is the union's edge
      path();
      ctx.lineJoin = 'round';
      ctx.strokeStyle = COV_COL[document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'];
      ctx.lineWidth = 2.6; ctx.stroke();
      ctx.globalCompositeOperation = 'destination-out';
      path(); ctx.fillStyle = '#000'; ctx.fill('nonzero');
      ctx.globalCompositeOperation = 'source-over';
    }
    map.on('zoomstart', () => { canvas.style.visibility = 'hidden'; });
    map.on('zoomend moveend resize', () => { canvas.style.visibility = ''; place(); });
    place();
    return {
      set(d) { data = d; draw(); },
      show(v) { on = !!v; canvas.style.display = on ? '' : 'none'; draw(); },
      redraw: draw,
      at(pt, r = 6) {                       // on the line: the sector of the nearer corner
        if (!on) return null;
        let best = null, bd = r;
        for (const ring of segs) {
          for (let k = 0; k < ring.length; k++) {
            const a = ring[k], b = ring[(k + 1) % ring.length];
            const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
            const u = l2 ? Math.max(0, Math.min(1, ((pt.x - a[0]) * dx + (pt.y - a[1]) * dy) / l2)) : 0;
            const d = Math.hypot(a[0] + u * dx - pt.x, a[1] + u * dy - pt.y);
            if (d <= bd) { bd = d; best = u < 0.5 ? a[2] : b[2]; }
          }
        }
        return best;
      },
    };
  })();

  // ── Control ──────────────────────────────────────────────────────────────
  let el = null;
  const Ctl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      el = L.DomUtil.create('div', 'lwx');
      el.innerHTML = `
        <button type="button" class="lwx-btn" title="Weather overlay: MEPS model rain, snow, low cloud, fog and isobars under the aircraft">☂ <span class="lwx-chip">Weather</span></button>
        <div class="lwx-panel">
          <div class="lwx-head"><b>Weather overlay</b><button type="button" class="lwx-x" title="Close (the overlay stays on)">✕</button></div>
          <div class="lwx-row"><span class="lwx-lbl">Source</span>
            <label><input type="radio" name="lwx-src" value="off"> Off</label>
            <label title="The MEPS weather model (MET Norway open data, CC BY 4.0): the present hour, from the newest stored run"><input type="radio" name="lwx-src" value="meps"> MEPS model</label>
            <label title="FMI radar composite (FMI open data, CC BY 4.0): the observed rain rate every 5 minutes, about 2 km — Finland and the nearby seas only (not the Baltic states)"><input type="radio" name="lwx-src" value="radar"> FMI radar</label>
            <label title="The FMI radar's rain inside the radar coverage (dashed edge), the MEPS model's rain outside it — and inside it as outlines (thin from 0.1, thick from 1 mm/h) to compare the forecast with the radar — and the model's low cloud, fog and isobars as chosen"><input type="radio" name="lwx-src" value="both"> Both</label>
          </div>
          <div class="lwx-row"><span class="lwx-lbl">Show</span>
            <label title="Rain and snow of the hour (mm of water per hour), radar-like colours; snow in violet. With the radar: the observed rain rate (mm/h)"><input type="checkbox" data-k="rain"> Rain / snow</label>
            <label title="Low cloud cover (grey, denser with more cloud)"><input type="checkbox" data-k="low"> Low cloud</label>
            <label title="Fog (yellow)"><input type="checkbox" data-k="fog"> Fog</label>
            <label title="Sea-level pressure: isobars every 4 hPa, highs H and lows L"><input type="checkbox" data-k="pres"> Isobars</label>
            <label title="Zoomed in near the airport (zoom 7 or closer): the MEPS fields inside the box around the receiver from the model's full 2.5 km grid instead of the stored 10 km grid (faint dotted edge), as on the Weather page"><input type="checkbox" class="lwx-fine"> 2.5 km detail</label>
          </div>
          <div class="lwx-row"><span class="lwx-lbl">Wind</span>
            <select class="lwx-wind" title="MEPS model wind barbs: the 10 m wind (whole map) or the wind at a flight level (± 300 km around the receiver; pressure altitude, ISA)">
              ${WIND_LEVELS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}
            </select>
            <label title="10 m gusts from 25 kt (with the MEPS 10 m wind)"><input type="checkbox" class="lwx-gust"> Gusts</label>
          </div>
          <div class="lwx-row"><span class="lwx-lbl">Barbs</span>
            <label title="The MEPS weather model's wind (MET Norway): muted grey barbs"><input type="checkbox" class="lwx-wm"> MEPS model</label>
            <label title="The winds measured by the aircraft (Mode S), averaged into 50 km cells as on the Wind Map page: coloured barbs, faint with only 1–2 aircraft. Flight levels only (no aircraft winds at 10 m)"><input type="checkbox" class="lwx-ws"> Mode S</label>
            <select class="lwx-per" title="Period of the Mode S winds: the last 1, 3, 6, 12 or 24 hours">
              ${PERIODS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}
            </select>
          </div>
          <div class="lwx-row"><span class="lwx-lbl">Receiver</span>
            <label title="A thin light-blue line around the area the receiver heard in the last 24 hours: the farthest ADS-B position in each 10° direction, any height (the range data of the Statistics page). With more receivers, their combined coverage"><input type="checkbox" class="lwx-cov"> Coverage (24 h)</label>
          </div>
          <div class="lwx-row"><span class="lwx-lbl">Opacity</span>
            <input type="range" class="lwx-op" min="10" max="100" step="5"> <span class="lwx-opv"></span>
          </div>
          <div class="lwx-status"></div>
          <div class="lwx-legend"></div>
        </div>`;
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
      return el;
    },
  });
  map.addControl(new Ctl());
  const q = s => el.querySelector(s);
  q('.lwx-btn').addEventListener('click', () => { st.open = !st.open; save(); sync(); });
  q('.lwx-x').addEventListener('click', () => { st.open = false; save(); sync(); });
  el.querySelectorAll('input[name=lwx-src]').forEach(r => r.addEventListener('change', () => {
    st.src = r.value; save(); sync(); refresh(true);
  }));
  el.querySelectorAll('input[data-k]').forEach(c => c.addEventListener('change', () => {
    const before = fields();
    st[c.dataset.k] = c.checked; save(); sync();
    if (fields() !== before) refresh(true); else applyOptions();
  }));
  q('.lwx-op').addEventListener('input', e => { st.op = parseInt(e.target.value, 10); save(); sync(); });
  q('.lwx-wind').addEventListener('change', e => { st.wind = e.target.value; save(); windKey = ''; sync(); refresh(true); });
  q('.lwx-gust').addEventListener('change', e => { st.gust = e.target.checked; save(); windKey = ''; sync(); refresh(true); });
  q('.lwx-wm').addEventListener('change', e => { st.wMeps = e.target.checked; save(); windKey = ''; sync(); refresh(true); });
  q('.lwx-ws').addEventListener('change', e => { st.wModes = e.target.checked; save(); modesKey = ''; sync(); refresh(true); });
  q('.lwx-per').addEventListener('change', e => { st.wPer = parseInt(e.target.value, 10); save(); modesKey = ''; sync(); refresh(true); });
  q('.lwx-fine').addEventListener('change', e => { st.fine = e.target.checked; save(); fineKey = ''; sync(); refresh(true); });
  q('.lwx-cov').addEventListener('change', e => { st.cov = e.target.checked; save(); covAt = 0; sync(); refresh(false); });

  // ── State → page ─────────────────────────────────────────────────────────
  const useMeps = () => st.src === 'meps' || st.src === 'both';
  const useRadar = () => st.src === 'radar' || st.src === 'both';
  const mepsWind = () => st.wind !== 'off' && st.wMeps;                     // MEPS barbs shown
  const modesWind = () => st.wind !== 'off' && st.wind !== 'sfc' && st.wModes; // Mode S barbs shown
  const perTxt = () => (PERIODS.find(p => p[0] === st.wPer) || [0, st.wPer + ' min'])[1];
  function options() {
    const edge = useRadar() && !!radarShown;
    if (st.src === 'radar') return { rain: true, pres: false, clouds: [], edge };
    const clouds = [];
    if (st.low) clouds.push('l');
    if (st.fog) clouds.push('f');
    return { rain: st.rain, pres: st.pres, clouds, edge, modelOutline: st.src === 'both' };
  }
  function fields() {
    const f = ['p'];
    if (st.rain) f.push('r', 's');
    if (st.low) f.push('l', 'b');
    if (st.fog) f.push('f');
    return f.join(',');
  }
  const windLabel = () => st.wind === 'sfc' ? '10 m wind' : `MEPS wind FL${st.wind}` + (windShown && windShown.p ? ` (${Math.round(windShown.p)} hPa)` : '');
  function windOptions() {
    // the gust shading follows the opacity slider (as on the Weather page at 100 %); the barbs stay opaque
    const gustAlpha = (document.documentElement.dataset.theme === 'light' ? 0.55 : 0.72) * st.op / 100;
    return { rain: false, pres: false, clouds: [], wind: st.wind !== 'off', gust: st.wind === 'sfc' && !!st.gust, gustAlpha,
             windLabel: windLabel() };
  }
  function applyOptions() {
    layer.setOptions(options());
    windLayer.setOptions(windOptions());
    const parts = [];
    if (st.src !== 'off') parts.push(WxLayer.legendHtml(options()));
    if (mepsWind()) parts.push(WxLayer.legendHtml(windOptions()));
    if (st.cov) parts.push(`<span style="display:inline-block;width:16px;border-top:1.5px solid ${COV_COL[document.documentElement.dataset.theme === 'light' ? 'light' : 'dark']};vertical-align:middle"></span> receiver coverage, last 24 h`);
    if (modesWind()) parts.push('Mode S barbs (aircraft, last ' + perTxt() + '): ' +
      MODES_COL[document.documentElement.dataset.theme === 'light' ? 'light' : 'dark']
        .map((c, i) => `<span class="wx-key" style="background:${c}"></span> ${['< 15', '15–30', '30–50', '≥ 50'][i]}`).join(' ') +
      ' kt · faint: 1–2 aircraft');
    q('.lwx-legend').innerHTML = parts.join(' &nbsp;·&nbsp; ');
  }
  let shown = null;          // {ts, run, lead} of the MEPS hour shown
  let radarShown = null;     // {ts} of the radar composite shown
  const fmtUtc = ts => { const d = new Date(ts * 1000); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; };
  function sync() {
    el.classList.toggle('open', !!st.open);
    el.querySelectorAll('input[name=lwx-src]').forEach(r => { r.checked = r.value === st.src; });
    el.querySelectorAll('input[data-k]').forEach(c => {
      c.checked = !!st[c.dataset.k];
      c.disabled = st.src === 'off' || (st.src === 'radar' && c.dataset.k !== 'rain');
    });
    q('.lwx-op').value = st.op; q('.lwx-opv').textContent = `${st.op} %`;
    layer.setOpacity(st.op / 100);
    layer.show(st.src !== 'off');
    q('.lwx-wind').value = st.wind;
    q('.lwx-gust').checked = !!st.gust;
    q('.lwx-gust').disabled = st.wind !== 'sfc' || !st.wMeps;
    q('.lwx-wm').checked = !!st.wMeps;
    q('.lwx-ws').checked = !!st.wModes;
    q('.lwx-ws').disabled = st.wind === 'sfc';
    q('.lwx-per').value = String(st.wPer);
    q('.lwx-per').disabled = !st.wModes || st.wind === 'sfc';
    windLayer.show(mepsWind());
    modesLayer.show(modesWind());
    q('.lwx-fine').checked = !!st.fine;
    q('.lwx-fine').disabled = !useMeps();
    q('.lwx-cov').checked = !!st.cov;
    covLayer.show(st.cov);
    const chip = q('.lwx-chip');
    const mTxt = () => { if (!shown) return 'MEPS …'; const hh = new Date(shown.ts * 1000).getUTCHours(); return `MEPS ${pad2((hh + 23) % 24)}–${pad2(hh)}`; };
    const rTxt = () => radarShown ? `Radar ${fmtUtc(radarShown.ts)}` : 'Radar …';
    let txt;
    if (st.src === 'off') txt = st.wind === 'off' ? 'Weather' : '';
    else if (st.src === 'radar') txt = `${rTxt()} UTC`;
    else if (st.src === 'meps') txt = `${mTxt()} UTC`;
    else txt = `${rTxt()} + ${mTxt()} UTC`;
    if (mepsWind() || modesWind()) {
      const lvl = st.wind === 'sfc' ? '10 m' : 'FL' + st.wind;
      const who = [mepsWind() ? 'MEPS' : '', modesWind() ? 'Mode S ' + perTxt() : ''].filter(Boolean).join(' + ');
      txt += (txt ? ' · ' : '') + `Wind ${lvl} (${who})`;
    }
    if (st.cov) txt = txt === 'Weather' ? 'Coverage 24 h' : txt + (txt ? ' · ' : '') + 'Coverage 24 h';
    chip.textContent = txt;
    el.classList.toggle('on', st.src !== 'off' || st.wind !== 'off' || !!st.cov);
    applyOptions();
  }

  // ── Data ─────────────────────────────────────────────────────────────────
  let index = null, indexAt = 0, busy = false, fetchedKey = '';
  let radarAt = 0, radarTs = null;
  let mepsStatus = '', radarStatus = '', windStatus = '', modesStatus = '', covStatus = '';
  let fineInfo = { hours: [], grid: null }, fineBox = null, fineKey = '', fineOn = false;
  let covAt = 0;
  let modesKey = '', modesAt = 0;
  let windShown = null, windKey = '', windAt = 0;     // {ts, run, lead, p} of the wind shown
  const showStatus = () => { q('.lwx-status').innerHTML = [radarStatus, mepsStatus, windStatus, modesStatus, covStatus].filter(Boolean).join('<br>'); };

  async function loadRadar(force) {
    const nowMs = Date.now();
    if (!force && radarShown && nowMs - radarAt < 4 * 60 * 1000) return;
    radarAt = nowMs;
    let d;
    try { d = await (await fetch('/api/radar/latest', { cache: 'no-store' })).json(); }
    catch (e) { d = { error: 'loading failed' }; }
    if (d.ts && d.grid) {
      if (d.ts !== radarTs || force) { layer.setOverlay({ ts: d.ts, rs: d.rs, cov: d.cov }, d.grid); radarTs = d.ts; }
      radarShown = { ts: d.ts };
      const age = Math.round((nowMs / 1000 - d.ts) / 60);
      radarStatus = `FMI radar ${fmtUtc(d.ts)} UTC (${age} min old) · rain rate, about ${d.km} km` +
        (age > 20 ? ' · <span style="color:#f59e0b">no newer composite</span>' : '') +
        ' · Finland and the nearby seas only · FMI open data, CC BY 4.0';
    } else {
      radarShown = null; radarTs = null; layer.setOverlay(null);
      radarStatus = 'FMI radar not reachable' + (d.error ? ` (${d.error})` : '') + ' — trying again in a few minutes.' +
        (st.src === 'both' ? ' The model’s rain is shown everywhere meanwhile.' : '');
    }
  }

  async function getIndex(force) {
    const nowMs = Date.now();
    if (force || !index || nowMs - indexAt > 5 * 60 * 1000) {
      const d = await (await fetch('/api/weather/index', { cache: 'no-store' })).json();
      index = d.hours || [];
      const fg = d.fine && d.fine.grid;
      if (JSON.stringify(fg) !== JSON.stringify(fineInfo.grid)) fineBox = null;
      fineInfo = d.fine || { hours: [], grid: null };
      indexAt = nowMs;
    }
    return index;
  }

  // MEPS wind barbs: 10 m from the weather maps, flight levels from the Wind Map fields
  async function loadWind(force) {
    const nowMs = Date.now(), now = nowMs / 1000;
    if (st.wind === 'sfc') {
      const idx = await getIndex(force);
      if (!idx.length) { windShown = null; windLayer.setFrame(null); windStatus = 'MEPS 10 m wind: no weather maps stored yet.'; return; }
      const h = idx.find(x => x[0] >= now) || idx[idx.length - 1];
      const fl = st.gust ? 'u,v,g' : 'u,v';
      const key = `sfc|${h[0]}|${h[1]}|${h[2]}|${fl}`;
      if (force || key !== windKey) {
        const d = await (await fetch(`/api/weather/frames?ts=${h[0]}&step=2&fields=${fl}`)).json();
        const f = (d.frames || [])[0];
        if (f) { windLayer.setFrame(f, d.grid); windKey = key; windShown = { ts: f.ts, run: f.run, lead: f.lead }; }
      }
    } else {
      if (!force && windKey.startsWith(st.wind + '|') && nowMs - windAt < 10 * 60 * 1000) return;
      windAt = nowMs;
      const d = await (await fetch(`/api/meps/winds?fl=${st.wind}`)).json();
      if (d.error || !d.u) {
        windShown = null; windKey = ''; windLayer.setFrame(null);
        windStatus = `MEPS wind FL${st.wind}: ${d.error || 'not available'}.`;
        return;
      }
      const key = `${st.wind}|${d.ts}|${d.run}|${d.lead}`;
      if (force || key !== windKey) {
        windLayer.setFrame({ u: d.u, v: d.v, t: d.t }, d.grid);
        windKey = key;
        windShown = { ts: d.ts, run: d.run, lead: d.lead, p: d.p_hpa };
      }
    }
    if (windShown) {
      const r = new Date(windShown.run * 1000), t = new Date(windShown.ts * 1000);
      const lvl = st.wind === 'sfc' ? '10 m wind' + (st.gust ? ' and gusts' : '') + `, hour ${pad2((t.getUTCHours() + 23) % 24)}–${pad2(t.getUTCHours())} UTC`
        : `wind FL${st.wind} (${Math.round(windShown.p)} hPa) at ${pad2(t.getUTCHours())} UTC · ± 300 km around the receiver`;
      windStatus = `MEPS ${lvl} · ${r.getUTCDate()}.${r.getUTCMonth() + 1}. ${pad2(r.getUTCHours())} UTC run +${windShown.lead} h` +
        (windShown.ts < now - 5400 ? ' · <span style="color:#f59e0b">old: no newer model hours stored</span>' : '') +
        ' · model barbs (muted), not aircraft · MET Norway, CC BY 4.0';
    }
  }

  // Mode S winds of the last st.wPer minutes at the level, 50 km cells (the Wind Map's /api/windmap)
  async function loadModes(force) {
    const nowMs = Date.now();
    const key = `${st.wind}|${st.wPer}`;
    if (!force && key === modesKey && nowMs - modesAt < 5 * 60 * 1000) return;
    modesAt = nowMs;
    const d = await (await fetch(`/api/windmap?fl=${st.wind}&tolerance=${MODES_TOL_FT}&cell=${MODES_CELL_KM}&window=${st.wPer}`)).json();
    modesKey = key;
    const cells = (d.cells || []).filter(c => c.wind_spd != null && c.wind_dir != null);
    modesLayer.set(cells, { fl: st.wind, per: perTxt(), end: d.end_ts });
    modesStatus = `Mode S FL${st.wind} ± ${MODES_TOL_FT.toLocaleString('en').replace(',', ' ')} ft, last ${perTxt()}: ` +
      `${d.aircraft || 0} aircraft, ${d.obs_used || 0} observations → ${cells.length} cells of ${MODES_CELL_KM} km` +
      (cells.length ? '' : ' · <span style="color:#f59e0b">no aircraft winds at this level in the period</span>') +
      ' · measured by the aircraft, averaged as on the Wind Map page';
  }

  // the 2.5 km box: wanted when ticked, zoomed in and the box in view
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
    return useMeps() && !!st.fine && !!b && map.getZoom() >= FINE_ZOOM && map.getBounds().intersects(b);
  }
  async function loadFine(force) {
    if (!shown || !fineWanted()) { fineOn = false; layer.setFine(null); return; }
    const fh = (fineInfo.hours || []).find(h => h[0] === shown.ts);
    if (!fh || fh[1] !== shown.run) { fineOn = false; layer.setFine(null); return; }   // same run as the 10 km hour only
    const key = `${fh[0]}|${fh[1]}|${fh[2]}|${fields()}`;
    if (!force && key === fineKey) { fineOn = true; return; }
    const d = await (await fetch(`/api/weather/frames?ts=${fh[0]}&fields=${fields()}&fine=1`)).json();
    const f = (d.frames || [])[0];
    if (f && fineWanted()) { layer.setFine(f, fineInfo.grid); fineKey = key; fineOn = true; }
    else { fineOn = false; layer.setFine(null); }
  }
  // a load only when the box comes into view (the layer redraws itself on a move)
  let fineWas = false;
  map.on('zoomend moveend', () => {
    const w = fineWanted();
    if (w === fineWas) return;
    fineWas = w;
    if (!w) { fineOn = false; layer.setFine(null); mepsLine(); showStatus(); return; }
    loadFine(false).then(() => { mepsLine(); showStatus(); }).catch(e => console.warn('Weather 2.5 km:', e));
  });

  // the receiver coverage of the last 24 h (every 5 minutes)
  async function loadCov(force) {
    const nowMs = Date.now();
    if (!force && covAt && nowMs - covAt < 5 * 60 * 1000) return;
    covAt = nowMs;
    const d = await (await fetch(`/api/coverage?hours=${COV_HOURS}`, { cache: 'no-store' })).json();
    covLayer.set(d);
    const rx = (d.receivers || []).filter(r => r.outline && r.outline.length);
    if (!rx.length) { covStatus = 'Receiver coverage: no ADS-B positions yet.'; return; }
    const far = rx.map(r => r.farthest).filter(Boolean).sort((a, b) => b.nm - a.nm)[0];
    const hrs = Math.min(COV_HOURS, (d.now - d.since) / 3600);
    covStatus = `Receiver coverage, last ${hrs >= COV_HOURS - 0.05 ? COV_HOURS + ' h' : hrs.toFixed(1) + ' h (since the start)'}: ` +
      `the farthest ADS-B position in each 10° direction, any height` +
      (far ? ` · farthest ${Math.round(far.nm)} NM at ${String(Math.round(far.brg - 5)).padStart(3, '0')}–${String(Math.round(far.brg + 5)).padStart(3, '0')}°` : '') +
      (rx.length > 1 ? ` · ${rx.length} receivers combined` : '');
  }

  function mepsLine() {
    if (!shown) return;
    const now = Date.now() / 1000;
    const r = new Date(shown.run * 1000), t = new Date(shown.ts * 1000);
    const stale = shown.ts < now - 3600;
    mepsStatus =
      `MEPS ${r.getUTCDate()}.${r.getUTCMonth() + 1}. ${pad2(r.getUTCHours())} UTC run +${shown.lead} h · ` +
      `hour ${pad2((t.getUTCHours() + 23) % 24)}–${pad2(t.getUTCHours())} UTC` +
      (stale ? ' · <span style="color:#f59e0b">old: no newer model hours stored</span>' : '') +
      (st.src === 'both' && radarShown ? ' · rain outside the radar area, outlined inside it' : '') +
      (fineOn ? ' · 2.5 km near the airport (dotted box), 10 km elsewhere'
        : st.fine && fineInfo.grid ? ` · 10 km grid (2.5 km near the airport when zoomed in)` : ' · 10 km grid') +
      ' · model, not radar · MET Norway, CC BY 4.0';
  }

  async function loadMeps(force) {
    const nowMs = Date.now();
    await getIndex(force);
    if (!index.length) {
      shown = null; fetchedKey = ''; layer.setFrame(null);
      mepsStatus = 'No MEPS weather maps stored yet (see the Weather page).';
      return;
    }
    const now = nowMs / 1000;
    const h = index.find(x => x[0] >= now) || index[index.length - 1];   // the hour containing now
    const key = `${h[0]}|${h[1]}|${h[2]}|${fields()}`;
    if (force || key !== fetchedKey) {
      const d = await (await fetch(`/api/weather/frames?ts=${h[0]}&step=1&fields=${fields()}`)).json();
      const f = (d.frames || [])[0];
      if (f) { layer.setFrame(f, d.grid); fetchedKey = key; fineKey = ''; shown = { ts: f.ts, run: f.run, lead: f.lead }; }
    }
    try { await loadFine(force); } catch (e) { console.warn('Weather 2.5 km:', e); fineOn = false; layer.setFine(null); }
    fineWas = fineWanted();
    mepsLine();
  }

  let pending = false;
  async function refresh(force = false) {
    if (busy) { pending = true; return; }          // a change during a load: load again after it
    busy = true;
    try {
      if (!useMeps()) { shown = null; fetchedKey = ''; mepsStatus = ''; layer.setFrame(null); fineKey = ''; fineOn = false; layer.setFine(null); }
      if (!useRadar()) { radarShown = null; radarTs = null; radarStatus = ''; layer.setOverlay(null); }
      // radar, model weather and model wind load side by side (a slow radar does not hold up the rest)
      const jobs = [];
      if (useRadar()) jobs.push(loadRadar(force).catch(e => { console.warn('Radar overlay:', e); }));
      if (useMeps()) jobs.push(loadMeps(force).catch(e => {
        console.warn('Weather overlay:', e); mepsStatus = 'MEPS: loading failed, trying again in a minute.'; }));
      if (!modesWind()) { modesKey = ''; modesStatus = ''; modesLayer.set(null); }
      else jobs.push(loadModes(force).catch(e => {
        console.warn('Mode S wind overlay:', e); modesStatus = 'Mode S wind: loading failed, trying again in a minute.'; }));
      if (!mepsWind()) { windShown = null; windKey = ''; windStatus = ''; windLayer.setFrame(null); }
      else jobs.push(loadWind(force).catch(e => {
        console.warn('Wind overlay:', e); windStatus = 'MEPS wind: loading failed, trying again in a minute.'; }));
      if (!st.cov) { covAt = 0; covStatus = ''; covLayer.set(null); }
      else jobs.push(loadCov(force).catch(e => {
        console.warn('Coverage:', e); covAt = 0; covStatus = 'Receiver coverage: loading failed, trying again in a minute.'; }));
      await Promise.all(jobs);
      showStatus(); sync();
    } finally {
      busy = false;
      if (pending) { pending = false; refresh(true); }
    }
  }
  setInterval(() => { if (!document.hidden) refresh(false); }, 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });

  // the page's Light / Dark button: redraw with the other colours too
  const prevTheme = window.onThemeChange;
  window.onThemeChange = function () { if (prevTheme) prevTheme(); layer.redraw(); windLayer.redraw(); modesLayer.redraw(); covLayer.redraw(); applyOptions(); };

  // hover a model barb: its wind (and temperature at a flight level)
  const tip = L.DomUtil.create('div', 'lwx-tip', map.getContainer());
  tip.style.display = 'none';
  const place = e => { tip.style.display = ''; tip.style.left = (e.containerPoint.x + 14) + 'px'; tip.style.top = (e.containerPoint.y + 10) + 'px'; };
  map.on('mousemove', e => {
    const c = modesWind() ? modesLayer.at(e.containerPoint) : null;          // a Mode S barb first
    if (c) {
      const m = modesLayer.meta() || {};
      tip.innerHTML = `<b>Mode S FL${m.fl}</b> (aircraft, last ${m.per}): ${String(Math.round(c.wind_dir) % 360 || 360).padStart(3, '0')}°/${Math.round(c.wind_spd)} kt` +
        (c.temp != null ? `, ${c.temp.toFixed(0)} °C` : '') +
        `<br><span>${c.ac} aircraft, ${c.obs} observations${c.wind_sd != null ? `, spread ${Math.round(c.wind_sd)} kt` : ''} · ${MODES_CELL_KM} km cell at ${c.lat.toFixed(2)}°N ${c.lon.toFixed(2)}°E</span>`;
      place(e);
      return;
    }
    const cv = st.cov ? covLayer.at(e.containerPoint) : null;           // the coverage line
    if (cv) {
      const a = String(Math.round(cv.brg - 5)).padStart(3, '0'), b = String(Math.round(cv.brg + 5) % 360 || 360).padStart(3, '0');
      tip.innerHTML = `<b>Receiver coverage</b>, last ${COV_HOURS} h: ${Math.round(cv.nm)} NM at ${a}–${b}°` +
        `<br><span>the farthest ADS-B position in this 10° direction${cv.alt != null ? `, at ${cv.alt >= 10000 ? 'FL' + String(Math.round(cv.alt / 100)).padStart(3, '0') : cv.alt.toLocaleString('en').replace(',', ' ') + ' ft'}` : ''}</span>`;
      place(e);
      return;
    }
    if (!mepsWind() || !windShown) { tip.style.display = 'none'; return; }
    const b = windLayer.barbAt(e.containerPoint);
    if (!b) { tip.style.display = 'none'; return; }
    const v = b.values, sp = Math.hypot(v.u, v.v);
    const wTxt = sp < 1 ? 'calm' : `${String(Math.round(b.dir) % 360 || 360).padStart(3, '0')}°/${Math.round(sp)} kt`;
    const r = new Date(windShown.run * 1000);
    const lvl = st.wind === 'sfc' ? '10 m' : `FL${st.wind} (${Math.round(windShown.p)} hPa)`;
    tip.innerHTML = `<b>MEPS ${lvl}</b>: ${wTxt}` + (v.t != null ? `, ${v.t.toFixed(0)} °C` : '') +
      (v.g != null ? `, gust ${Math.round(v.g)} kt` : '') +
      `<br><span>run ${pad2(r.getUTCHours())} UTC +${windShown.lead} h · ${b.latlng[0].toFixed(2)}°N ${b.latlng[1].toFixed(2)}°E</span>`;
    tip.style.display = '';
    tip.style.left = (e.containerPoint.x + 14) + 'px';
    tip.style.top = (e.containerPoint.y + 10) + 'px';
  });
  map.on('mouseout zoomstart movestart', () => { tip.style.display = 'none'; });

  sync();
  refresh(true);
})();
