/**
 * live_wx.js — weather overlay on the Live Map (from 2026-10-23).
 *
 * A ☂ button at the top right of the map opens a small panel: the source
 * (Off / MEPS model / FMI radar / Both), what to show (MEPS: rain and snow,
 * low cloud, fog, isobars; radar: the observed rain rate) and an opacity
 * slider.  Both: the radar's rain inside its coverage (dashed edge), the
 * model's rain outside it, and the model's clouds, fog and isobars.
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
 */
'use strict';

(function () {
  if (typeof map === 'undefined' || typeof WxLayer === 'undefined') return;
  const KEY = 'ms_liveWx';
  const DEF = { src: 'off', rain: true, low: false, fog: false, pres: false, op: 60, open: false,
                wind: 'off', gust: false };
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
            <label title="The FMI radar's rain inside the radar coverage (dashed edge), the MEPS model's rain outside it, and the model's low cloud, fog and isobars as chosen"><input type="radio" name="lwx-src" value="both"> Both</label>
          </div>
          <div class="lwx-row"><span class="lwx-lbl">Show</span>
            <label title="Rain and snow of the hour (mm of water per hour), radar-like colours; snow in violet. With the radar: the observed rain rate (mm/h)"><input type="checkbox" data-k="rain"> Rain / snow</label>
            <label title="Low cloud cover (grey, denser with more cloud)"><input type="checkbox" data-k="low"> Low cloud</label>
            <label title="Fog (yellow)"><input type="checkbox" data-k="fog"> Fog</label>
            <label title="Sea-level pressure: isobars every 4 hPa, highs H and lows L"><input type="checkbox" data-k="pres"> Isobars</label>
          </div>
          <div class="lwx-row"><span class="lwx-lbl">Wind</span>
            <select class="lwx-wind" title="MEPS model wind barbs: the 10 m wind (whole map) or the wind at a flight level (± 300 km around the receiver; pressure altitude, ISA)">
              ${WIND_LEVELS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}
            </select>
            <label title="10 m gusts from 25 kt (with the 10 m wind)"><input type="checkbox" class="lwx-gust"> Gusts</label>
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

  // ── State → page ─────────────────────────────────────────────────────────
  const useMeps = () => st.src === 'meps' || st.src === 'both';
  const useRadar = () => st.src === 'radar' || st.src === 'both';
  function options() {
    const edge = useRadar() && !!radarShown;
    if (st.src === 'radar') return { rain: true, pres: false, clouds: [], edge };
    const clouds = [];
    if (st.low) clouds.push('l');
    if (st.fog) clouds.push('f');
    return { rain: st.rain, pres: st.pres, clouds, edge };
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
    return { rain: false, pres: false, clouds: [], wind: st.wind !== 'off', gust: st.wind === 'sfc' && !!st.gust,
             windLabel: windLabel() };
  }
  function applyOptions() {
    layer.setOptions(options());
    windLayer.setOptions(windOptions());
    const parts = [];
    if (st.src !== 'off') parts.push(WxLayer.legendHtml(options()));
    if (st.wind !== 'off') parts.push(WxLayer.legendHtml(windOptions()));
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
    q('.lwx-gust').disabled = st.wind !== 'sfc';
    windLayer.show(st.wind !== 'off');
    const chip = q('.lwx-chip');
    const mTxt = () => { if (!shown) return 'MEPS …'; const hh = new Date(shown.ts * 1000).getUTCHours(); return `MEPS ${pad2((hh + 23) % 24)}–${pad2(hh)}`; };
    const rTxt = () => radarShown ? `Radar ${fmtUtc(radarShown.ts)}` : 'Radar …';
    let txt;
    if (st.src === 'off') txt = st.wind === 'off' ? 'Weather' : '';
    else if (st.src === 'radar') txt = `${rTxt()} UTC`;
    else if (st.src === 'meps') txt = `${mTxt()} UTC`;
    else txt = `${rTxt()} + ${mTxt()} UTC`;
    if (st.wind !== 'off') txt += (txt ? ' · ' : '') + 'Wind ' + (st.wind === 'sfc' ? '10 m' : 'FL' + st.wind);
    chip.textContent = txt;
    el.classList.toggle('on', st.src !== 'off' || st.wind !== 'off');
    applyOptions();
  }

  // ── Data ─────────────────────────────────────────────────────────────────
  let index = null, indexAt = 0, busy = false, fetchedKey = '';
  let radarAt = 0, radarTs = null;
  let mepsStatus = '', radarStatus = '', windStatus = '';
  let windShown = null, windKey = '', windAt = 0;     // {ts, run, lead, p} of the wind shown
  const showStatus = () => { q('.lwx-status').innerHTML = [radarStatus, mepsStatus, windStatus].filter(Boolean).join('<br>'); };

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
      index = (await (await fetch('/api/weather/index', { cache: 'no-store' })).json()).hours || [];
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
      if (f) { layer.setFrame(f, d.grid); fetchedKey = key; shown = { ts: f.ts, run: f.run, lead: f.lead }; }
    }
    if (shown) {
      const r = new Date(shown.run * 1000), t = new Date(shown.ts * 1000);
      const stale = shown.ts < now - 3600;
      mepsStatus =
        `MEPS ${r.getUTCDate()}.${r.getUTCMonth() + 1}. ${pad2(r.getUTCHours())} UTC run +${shown.lead} h · ` +
        `hour ${pad2((t.getUTCHours() + 23) % 24)}–${pad2(t.getUTCHours())} UTC` +
        (stale ? ' · <span style="color:#f59e0b">old: no newer model hours stored</span>' : '') +
        (st.src === 'both' && radarShown ? ' · rain outside the radar area' : '') +
        ' · model, not radar · MET Norway, CC BY 4.0';
    }
  }

  let pending = false;
  async function refresh(force = false) {
    if (busy) { pending = true; return; }          // a change during a load: load again after it
    busy = true;
    try {
      if (!useMeps()) { shown = null; fetchedKey = ''; mepsStatus = ''; layer.setFrame(null); }
      if (!useRadar()) { radarShown = null; radarTs = null; radarStatus = ''; layer.setOverlay(null); }
      // radar, model weather and model wind load side by side (a slow radar does not hold up the rest)
      const jobs = [];
      if (useRadar()) jobs.push(loadRadar(force).catch(e => { console.warn('Radar overlay:', e); }));
      if (useMeps()) jobs.push(loadMeps(force).catch(e => {
        console.warn('Weather overlay:', e); mepsStatus = 'MEPS: loading failed, trying again in a minute.'; }));
      if (st.wind === 'off') { windShown = null; windKey = ''; windStatus = ''; windLayer.setFrame(null); }
      else jobs.push(loadWind(force).catch(e => {
        console.warn('Wind overlay:', e); windStatus = 'MEPS wind: loading failed, trying again in a minute.'; }));
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
  window.onThemeChange = function () { if (prevTheme) prevTheme(); layer.redraw(); windLayer.redraw(); applyOptions(); };

  // hover a model barb: its wind (and temperature at a flight level)
  const tip = L.DomUtil.create('div', 'lwx-tip', map.getContainer());
  tip.style.display = 'none';
  map.on('mousemove', e => {
    if (st.wind === 'off' || !windShown) { tip.style.display = 'none'; return; }
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
