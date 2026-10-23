/**
 * live_wx.js — weather overlay on the Live Map (from 2026-10-23).
 *
 * A ☂ button at the top right of the map opens a small panel: the source
 * (Off / MEPS model / FMI radar), what to show (MEPS: rain and snow, low
 * cloud, fog, isobars; radar: the observed rain rate) and an opacity slider.
 * The radar (/api/radar/latest, web/api/radar.py) covers Finland and the
 * nearby seas only, the model the whole MEPS area — so MEPS is the default.  The overlay lies in its own pane under the
 * aircraft (wx_layer.js, the same drawing as the Weather page) and shows the
 * model's current hour — the rain of the hour ending at the next full hour —
 * on the stored 10 km grid (/api/weather/frames).  It refreshes itself: at
 * each full hour, and when a newer model run has been stored (the index is
 * read every 5 minutes).  All choices are remembered in the browser; with the
 * panel closed the button shows what is on.
 */
'use strict';

(function () {
  if (typeof map === 'undefined' || typeof WxLayer === 'undefined') return;
  const KEY = 'ms_liveWx';
  const DEF = { src: 'off', rain: true, low: false, fog: false, pres: false, op: 60, open: false };
  let st = Object.assign({}, DEF);
  try { Object.assign(st, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* defaults */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* private mode */ } };

  const layer = WxLayer.create(map, { pane: 'wxPane', zIndex: 350, rainAlpha: 0.85, cloudMax: 0.45 });
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
          </div>
          <div class="lwx-row"><span class="lwx-lbl">Show</span>
            <label title="Rain and snow of the hour (mm of water per hour), radar-like colours; snow in violet"><input type="checkbox" data-k="rain"> Rain / snow</label>
            <label title="Low cloud cover (grey, denser with more cloud)"><input type="checkbox" data-k="low"> Low cloud</label>
            <label title="Fog (yellow)"><input type="checkbox" data-k="fog"> Fog</label>
            <label title="Sea-level pressure: isobars every 4 hPa, highs H and lows L"><input type="checkbox" data-k="pres"> Isobars</label>
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

  // ── State → page ─────────────────────────────────────────────────────────
  function options() {
    if (st.src === 'radar') return { rain: true, pres: false, clouds: [] };
    const clouds = [];
    if (st.low) clouds.push('l');
    if (st.fog) clouds.push('f');
    return { rain: st.rain, pres: st.pres, clouds };
  }
  function fields() {
    const f = ['p'];
    if (st.rain) f.push('r', 's');
    if (st.low) f.push('l', 'b');
    if (st.fog) f.push('f');
    return f.join(',');
  }
  function applyOptions() {
    layer.setOptions(options());
    q('.lwx-legend').innerHTML = st.src === 'off' ? '' : WxLayer.legendHtml(options());
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
    const chip = q('.lwx-chip');
    if (st.src === 'off') chip.textContent = 'Weather';
    else if (st.src === 'radar') {
      chip.textContent = radarShown ? `Radar ${fmtUtc(radarShown.ts)} UTC` : 'Radar …';
    } else if (shown) {
      const hh = new Date(shown.ts * 1000).getUTCHours();
      chip.textContent = `MEPS ${pad2((hh + 23) % 24)}–${pad2(hh)} UTC`;
    } else chip.textContent = 'MEPS …';
    el.classList.toggle('on', st.src !== 'off');
    applyOptions();
  }

  // ── Data ─────────────────────────────────────────────────────────────────
  let index = null, indexAt = 0, busy = false, fetchedKey = '';
  let radarAt = 0, radarTs = null;
  async function refreshRadar(force) {
    const nowMs = Date.now();
    if (!force && radarShown && nowMs - radarAt < 4 * 60 * 1000) return;
    radarAt = nowMs;
    const d = await (await fetch('/api/radar/latest', { cache: 'no-store' })).json();
    if (d.ts && d.grid) {
      if (d.ts !== radarTs || force) { layer.setFrame({ ts: d.ts, rs: d.rs }, d.grid); radarTs = d.ts; }
      radarShown = { ts: d.ts };
      const age = Math.round((nowMs / 1000 - d.ts) / 60);
      q('.lwx-status').innerHTML = `FMI radar ${fmtUtc(d.ts)} UTC (${age} min old) · rain rate, about ${d.km} km` +
        (age > 20 ? ' · <span style="color:#f59e0b">no newer composite</span>' : '') +
        ' · Finland and the nearby seas only · FMI open data, CC BY 4.0';
    } else {
      radarShown = null; layer.setFrame(null);
      q('.lwx-status').textContent = 'FMI radar not reachable' + (d.error ? ` (${d.error})` : '') + ' — trying again in a few minutes.';
    }
  }
  async function refresh(force = false) {
    if (st.src === 'off') { shown = null; radarShown = null; layer.setFrame(null); q('.lwx-status').textContent = ''; sync(); return; }
    if (busy) return;
    if (st.src === 'radar') {
      busy = true;
      try { if (force) { fetchedKey = ''; radarTs = null; } await refreshRadar(force); sync(); }
      catch (e) { console.warn('Radar overlay:', e); q('.lwx-status').textContent = 'FMI radar: loading failed, trying again in a few minutes.'; }
      finally { busy = false; }
      return;
    }
    radarTs = null;
    busy = true;
    try {
      const nowMs = Date.now();
      if (force || !index || nowMs - indexAt > 5 * 60 * 1000) {
        index = (await (await fetch('/api/weather/index', { cache: 'no-store' })).json()).hours || [];
        indexAt = nowMs;
      }
      if (!index.length) {
        shown = null; layer.setFrame(null);
        q('.lwx-status').textContent = 'No MEPS weather maps stored yet (see the Weather page).';
        sync(); return;
      }
      const now = nowMs / 1000;
      let h = index.find(x => x[0] >= now) || index[index.length - 1];   // the hour containing now
      const key = `${h[0]}|${h[1]}|${h[2]}|${fields()}`;
      radarShown = null;
      if (force || key !== fetchedKey) {
        const d = await (await fetch(`/api/weather/frames?ts=${h[0]}&step=1&fields=${fields()}`)).json();
        const f = (d.frames || [])[0];
        if (f) { layer.setFrame(f, d.grid); fetchedKey = key; shown = { ts: f.ts, run: f.run, lead: f.lead }; }
      }
      if (shown) {
        const r = new Date(shown.run * 1000), t = new Date(shown.ts * 1000);
        const stale = shown.ts < now - 3600;
        q('.lwx-status').innerHTML =
          `MEPS ${r.getUTCDate()}.${r.getUTCMonth() + 1}. ${pad2(r.getUTCHours())} UTC run +${shown.lead} h · ` +
          `hour ${pad2((t.getUTCHours() + 23) % 24)}–${pad2(t.getUTCHours())} UTC` +
          (stale ? ' · <span style="color:#f59e0b">old: no newer model hours stored</span>' : '') +
          ' · model, not radar · MET Norway, CC BY 4.0';
      }
      sync();
    } catch (e) {
      console.warn('Weather overlay:', e);
      q('.lwx-status').textContent = 'Weather overlay: loading failed, trying again in a minute.';
    } finally {
      busy = false;
    }
  }
  setInterval(() => { if (!document.hidden) refresh(false); }, 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });

  // the page's Light / Dark button: redraw with the other colours too
  const prevTheme = window.onThemeChange;
  window.onThemeChange = function () { if (prevTheme) prevTheme(); layer.redraw(); applyOptions(); };

  sync();
  refresh(true);
})();
