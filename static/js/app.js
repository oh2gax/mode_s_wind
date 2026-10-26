/**
 * app.js — the mobile view /app (from 2026-10-26).
 *
 * One product at a time, filling the screen; every choice in the ☰ menu.
 *   Skew-T · Area now   /api/sounding (last N min) with the METAR ground point,
 *                       the airport low-level profile, the sonde and MEPS
 *   Skew-T · Area hour  /api/sounding/hour from the hourly archive (date + hour)
 *   Time–height         timeheight.js (the Sounding page's section; its
 *                       controls are in the menu with the same ids)
 *   ILS approach        ils_profile.js: the Windshear page's ILS profile from
 *                       /api/windshear/state every 5 s, with the strips below
 *   ACI & WS            ws_cond_chart.js (the Windshear page's chart) with
 *                       the landings, departures and go-arounds of 3 h … 1 d
 * The Skew-T options are the same settings as on the Live Map and the
 * Sounding page (shared localStorage keys).  Only the shown view is
 * refreshed, and nothing while the page is hidden (phone screen off, another
 * app).  Taps work as hover: tap or drag over a diagram for its read-out.
 * The menu: the views as tiles, each product's options in a folding section
 * (the shown view's opens by itself, the others stay reachable), the
 * selects marked data-chips shown as tap buttons (the select stays as the
 * value holder, so its change listeners — also timeheight.js's — work).
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, String(v)); } catch (_) { /* private mode */ } };
  const pad = n => String(n).padStart(2, '0');
  const hhmm = t => { const d = new Date(t * 1000); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const LAT = typeof RECEIVER_LAT !== 'undefined' ? RECEIVER_LAT : 60.3;

  const VIEWS = {
    'skewt-now':  { title: 'Skew-T · Area now', sec: 'skewt', el: 'v-skewt' },
    'skewt-hour': { title: 'Skew-T · Area hour', sec: 'skewt', el: 'v-skewt' },
    th:           { title: 'Time–height', sec: 'th', el: 'v-th' },
    ils:          { title: 'ILS approach', sec: 'ils', el: 'v-ils' },
    aci:          { title: 'ACI & WS', sec: 'aci', el: 'v-aci' },
  };
  let view = lsGet('ms_app_view', 'skewt-now');
  if (!VIEWS[view]) view = 'skewt-now';
  let timer = null;

  // ── menu ─────────────────────────────────────────────────────────────────
  const drawer = $('app-drawer'), backdrop = $('app-backdrop');
  function menu(open) {
    if (open) syncChips();
    drawer.classList.toggle('open', open);
    backdrop.hidden = !open;
    drawer.setAttribute('aria-hidden', String(!open));
    $('app-menu-btn').setAttribute('aria-expanded', String(open));
  }
  $('app-menu-btn').addEventListener('click', () => menu(!drawer.classList.contains('open')));
  $('app-menu-close').addEventListener('click', () => menu(false));
  backdrop.addEventListener('click', () => menu(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') menu(false); });

  // chips: a select marked data-chips is shown as a row of tap buttons; the
  // select (hidden) keeps the value and gets the change event
  const chipSels = [];
  function chipify(sel) {
    const box = document.createElement('div');
    box.className = 'app-chips';
    box.setAttribute('role', 'group');
    for (const o of sel.options) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'app-chip'; b.dataset.v = o.value;
      b.textContent = o.dataset.short || o.textContent;
      b.addEventListener('click', () => {
        if (sel.value !== o.value) { sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
        syncChip(sel);
      });
      box.appendChild(b);
    }
    sel.hidden = true;
    sel.after(box);
    sel._chips = box;
    sel.addEventListener('change', () => syncChip(sel));
    chipSels.push(sel);
  }
  function syncChip(sel) {
    for (const b of sel._chips.children) {
      const on = b.dataset.v === sel.value;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }
  const syncChips = () => chipSels.forEach(syncChip);
  document.querySelectorAll('select[data-chips]').forEach(chipify);

  // ── theme ────────────────────────────────────────────────────────────────
  const themeSel = $('app-theme');
  themeSel.value = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  themeSel.addEventListener('change', () => {
    if (themeSel.value === 'light') document.documentElement.dataset.theme = 'light';
    else delete document.documentElement.dataset.theme;
    lsSet('ms_theme', themeSel.value);
    const tc = document.querySelector('meta[name="theme-color"]');
    if (tc) tc.content = themeSel.value === 'light' ? '#e8edf3' : '#0f1923';
    layout(true);
  });

  // ── system health (the Statistics page's indicators, /api/health) ────────
  async function pollHealth() {
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (!r.ok) return;
      const h = await r.json();
      const dot = $('app-health');
      dot.className = 'app-health st-' + h.overall;
      const bad = (h.items || []).filter(i => i.state === 'warn' || i.state === 'err');
      const txt = bad.length ? bad.map(i => `${i.label}: ${i.text}`).join(' · ') : 'all parts working';
      dot.title = 'System health — ' + txt;
      $('app-health-txt').textContent = 'System health: ' + txt;
    } catch (_) { /* silent */ }
  }

  // ══ Skew-T ═══════════════════════════════════════════════════════════════
  const S = {
    ana: parseInt(lsGet('ms_skewtAna', '0'), 10) || 0,
    anaSrc: lsGet('ms_skewtAnaSrc', 'modes'),
    apt: lsGet('ms_aptMode', 'off'),
    smooth: parseInt(lsGet('ms_areaSmooth', '0'), 10) || 0,
    sonde: lsGet('ms_skewtSonde', 'false') === 'true',
    meps: lsGet('ms_skewtMeps', 'false') === 'true',
    rh: lsGet('ms_skewtRH', 'false') === 'true',
    dq: lsGet('ms_skewtDq', 'true') !== 'false',
    minutes: lsGet('ms_app_minutes', '60'),
  };
  if (!(S.ana >= 0 && S.ana <= 5)) S.ana = 0;
  if (!['modes', 'meps', 'sonde'].includes(S.anaSrc)) S.anaSrc = 'modes';
  if (!['off', 'overlay', 'zoom'].includes(S.apt)) S.apt = 'off';
  if (![0, 1, 2].includes(S.smooth)) S.smooth = 0;
  if (!['30', '60', '120', '180'].includes(S.minutes)) S.minutes = '60';

  const skewt = createSkewT($('app-skewt'), $('app-skewt-tip'), { lat: LAT, hidpi: true });
  let prof = null, low = null, lowQs = null, sfc = null, wxSfc = null, wxElev = 179, wxQnh = null, wxWind = null;
  let sonde = null, sondeRef = null, meps = null, title = '', hint = '', req = 0, sondeReq = 0, mepsReq = 0;

  function drawSkewT() {
    skewt.set({ area: prof, low, aptMode: S.apt, anaLevel: S.ana, anaSrc: S.anaSrc, smooth: S.smooth,
                sfc, ac: null, profileTitle: title, hint, dq: S.dq,
                sonde: S.sonde ? sonde : null, sondeRef, meps: S.meps ? meps : null,
                rh: S.rh, moist: S.rh && prof ? prof.moisture || null : null });
    skewt.draw();
  }
  function sizeSkewT() {
    const v = $('v-skewt');
    if (v.hidden) return;
    // portrait: the full width, as tall as the screen allows (up to 2 × the width);
    // landscape: the height of the screen (at least 400 px, the page scrolls),
    // no wider than 0.9 × that, so the diagram keeps its shape
    const availW = Math.max(280, v.clientWidth - 8);
    const availH = v.clientHeight - 8 - $('app-skewt-meta').offsetHeight;
    let w, h;
    if (availW <= availH) { w = availW; h = Math.max(300, Math.min(availH, Math.round(w * 2))); }
    else { h = Math.max(400, availH); w = Math.min(availW, Math.round(h * 0.9)); }
    const box = $('app-skewt-box');
    box.style.width = w + 'px'; box.style.height = h + 'px';
    skewt.resize(w, h);
    drawSkewT();
  }
  function meta(txt) { $('app-skewt-meta').textContent = txt; }

  async function fetchWx() {
    try {
      const r = await fetch('/api/wx');
      if (!r.ok) return;
      const d = await r.json();
      if (d.elev_ft != null) wxElev = Number(d.elev_ft);
      wxSfc = parseMetarSfc(d);
      if (d.qnh_hpa != null) wxQnh = Number(d.qnh_hpa);
      wxWind = d.metar_wind || null;
      if (view === 'ils') drawIls();
      if (view === 'skewt-now') { sfc = wxSfc; drawSkewT(); }
    } catch (_) { /* silent */ }
  }
  async function fetchLow(qs) {
    lowQs = qs; low = null;
    if (S.apt === 'off' || !qs) { drawSkewT(); return; }
    try {
      const d = await (await fetch('/api/lowlevel?' + qs)).json();
      if (lowQs !== qs) return;
      low = d; drawSkewT();
    } catch (_) { /* silent */ }
  }
  async function fetchSonde(at, ref) {
    sondeRef = ref;
    if (!S.sonde) { sonde = null; drawSkewT(); return; }
    const n = ++sondeReq;
    try {
      const d = await (await fetch('/api/sonde' + (at != null ? `?at=${Math.round(at)}` : ''))).json();
      if (n === sondeReq) { sonde = d; drawSkewT(); }
    } catch (_) { /* silent */ }
  }
  async function fetchMeps(at) {
    if (!S.meps) { meps = null; drawSkewT(); return; }
    const n = ++mepsReq;
    try {
      const d = await (await fetch('/api/meps/profile' + (at != null ? `?at=${Math.round(at)}` : ''), { cache: 'no-store' })).json();
      if (n === mepsReq) { meps = d; drawSkewT(); }
    } catch (_) { /* silent */ }
  }
  function showProfile(d, t, h, qs, s, sondeAt, ref, mepsAt, sub) {
    prof = Object.assign({}, d, { levels: (d.levels || []).slice().sort((a, b) => b.pressure - a.pressure) });
    title = t; hint = h; sfc = s || null;
    $('app-sub').textContent = sub;
    meta(`${d.obs_used || 0} obs · ${d.aircraft != null ? d.aircraft + ' aircraft · ' : ''}${prof.levels.length} levels` +
         (d.radius_km ? ` · ${Math.round(d.radius_km)} km` : '') + ' · tap the diagram for values');
    drawSkewT();
    fetchLow(qs);
    fetchSonde(sondeAt, ref);
    fetchMeps(mepsAt);
  }
  async function loadNow() {
    const n = ++req;
    meta('Loading…');
    try {
      const d = await (await fetch(`/api/sounding?minutes=${S.minutes}${S.rh ? '&moist=1' : ''}`, { cache: 'no-store' })).json();
      if (n !== req || view !== 'skewt-now') return;
      const win = d.window_min >= 120 ? `${d.window_min / 60} h` : `${d.window_min} min`;
      showProfile(d, `Area, last ${win}`, `Area profile, ${Math.round(d.radius_km)} km, last ${win}`,
                  `minutes=${d.window_min}`, wxSfc, null, null, null,
                  `last ${win}` + (d.generated_at ? ` · ${d.generated_at.substr(11, 5)} UTC` : ''));
    } catch (e) { if (n === req) meta('Could not load the area profile.'); }
  }
  async function loadHourList(edge) {
    const dateEl = $('app-date');
    if (!dateEl.value) {
      const t = new Date(Date.now() - 3600e3);
      dateEl.value = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
    }
    const sel = $('app-hour'), keep = sel.value;
    try {
      const hours = await (await fetch(`/api/sounding/hours?date=${dateEl.value}`)).json();
      sel.innerHTML = hours.length ? '' : '<option value="">no hours stored</option>';
      for (const h of hours) {
        const t = new Date(h.ts * 1000);
        const o = document.createElement('option');
        o.value = h.ts;
        o.textContent = `${pad(t.getUTCHours())}–${pad((t.getUTCHours() + 1) % 24)} UTC (${h.n} obs)`;
        sel.appendChild(o);
      }
      if (edge === 'first' && hours.length) sel.value = String(hours[0].ts);
      else if (edge !== 'last' && keep && [...sel.options].some(o => o.value === keep)) sel.value = keep;
      else if (hours.length) sel.value = String(hours[hours.length - 1].ts);
      loadHour();
    } catch (_) { meta('Could not load the hour list.'); }
  }
  async function loadHour() {
    const ts = $('app-hour').value;
    if (!ts) { prof = null; drawSkewT(); meta('No hourly profile for this date.'); $('app-sub').textContent = ''; return; }
    const n = ++req;
    meta('Loading…');
    try {
      const d = await (await fetch(`/api/sounding/hour?ts=${ts}${S.rh ? '&moist=1' : ''}`)).json();
      if (n !== req || view !== 'skewt-hour') return;
      if (d.error) { prof = null; drawSkewT(); meta(d.error); return; }
      const t = new Date(d.hour_ts * 1000);
      const hh = `${pad(t.getUTCHours())}–${pad((t.getUTCHours() + 1) % 24)} UTC`;
      const lbl = `${t.getUTCDate()}.${t.getUTCMonth() + 1}.${t.getUTCFullYear()} ${hh}`;
      const m = d.sfc;
      const hs = m ? skewtSfcPoint({ qnh: m.q, t: m.tt, td: m.td, elev: wxElev, cld: m.cld,
                                     station: wxSfc ? wxSfc.station : '',
                                     time: m.z ? `${m.z.slice(2, 4)}:${m.z.slice(4, 6)}Z` : '' }) : null;
      showProfile(d, `Hour ${hh}`, `Hourly profile ${lbl}`, `minutes=60&end=${d.hour_ts + 3600}`, hs,
                  d.hour_ts + 3600, d.hour_ts + 1800, d.hour_ts + 1800, lbl);
    } catch (_) { if (n === req) meta('Could not load the hourly profile.'); }
  }

  // menu controls of the Skew-T (shared keys with the Live Map / Sounding page)
  const bind = (id, key, get, apply) => {
    const el = $(id);
    el.addEventListener('change', () => { const v = get(el); S[key] = v; lsSet(apply.k, v); apply.fn(); });
  };
  $('app-minutes').value = S.minutes;
  $('app-ana').value = String(S.ana);
  $('app-ana-src').value = S.anaSrc;
  $('app-apt').value = S.apt;
  $('app-smooth').value = String(S.smooth);
  $('app-sonde').checked = S.sonde; $('app-meps').checked = S.meps; $('app-rh').checked = S.rh; $('app-dq').checked = S.dq;
  const reload = () => (view === 'skewt-hour' ? loadHour() : loadNow());
  bind('app-minutes', 'minutes', el => el.value, { k: 'ms_app_minutes', fn: () => loadNow() });
  bind('app-ana', 'ana', el => parseInt(el.value, 10), { k: 'ms_skewtAna', fn: drawSkewT });
  bind('app-ana-src', 'anaSrc', el => el.value, { k: 'ms_skewtAnaSrc', fn: () => {
    if (S.anaSrc === 'meps' && !S.meps) { S.meps = true; $('app-meps').checked = true; lsSet('ms_skewtMeps', true); reload(); }
    else if (S.anaSrc === 'sonde' && !S.sonde) { S.sonde = true; $('app-sonde').checked = true; lsSet('ms_skewtSonde', true); reload(); }
    else drawSkewT(); } });
  bind('app-apt', 'apt', el => el.value, { k: 'ms_aptMode', fn: () => fetchLow(lowQs) });
  bind('app-smooth', 'smooth', el => parseInt(el.value, 10), { k: 'ms_areaSmooth', fn: drawSkewT });
  bind('app-sonde', 'sonde', el => el.checked, { k: 'ms_skewtSonde', fn: reload });
  bind('app-meps', 'meps', el => el.checked, { k: 'ms_skewtMeps', fn: reload });
  bind('app-rh', 'rh', el => el.checked, { k: 'ms_skewtRH', fn: () => { sizeSkewT(); reload(); } });
  bind('app-dq', 'dq', el => el.checked, { k: 'ms_skewtDq', fn: drawSkewT });
  $('app-date').addEventListener('change', () => loadHourList());
  $('app-hour').addEventListener('change', loadHour);
  // ‹ › steppers: a day back / forward; an hour back / forward, over midnight
  // to the neighbouring day's last / first stored hour
  function stepDate(days, edge) {
    const el = $('app-date');
    const t = el.value ? new Date(el.value + 'T00:00:00Z') : new Date();
    t.setUTCDate(t.getUTCDate() + days);
    if (t.getTime() > Date.now()) return;
    el.value = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
    loadHourList(edge);
  }
  function stepHour(dir) {
    const sel = $('app-hour'), i = sel.selectedIndex + dir;
    if (sel.value && i >= 0 && i < sel.options.length) { sel.selectedIndex = i; loadHour(); }
    else stepDate(dir, dir < 0 ? 'last' : 'first');
  }
  $('app-date-prev').addEventListener('click', () => stepDate(-1));
  $('app-date-next').addEventListener('click', () => stepDate(1));
  $('app-hour-prev').addEventListener('click', () => stepHour(-1));
  $('app-hour-next').addEventListener('click', () => stepHour(1));

  // taps and drags act like the mouse hover of the desktop pages
  // (the mouse events a phone sends after a tap are ignored, else the
  // read-out would close again at once)
  let lastTouch = 0;
  const viaMouse = () => Date.now() - lastTouch > 1000;
  function touchHover(el, fn) {
    el.addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse') { lastTouch = Date.now(); fn(e); } });
    el.addEventListener('pointermove', e => { if (e.pointerType !== 'mouse') { lastTouch = Date.now(); fn(e); } });
  }
  const sk = $('app-skewt');
  sk.addEventListener('mousemove', e => { if (viaMouse()) skewt.hover(e); });
  sk.addEventListener('mouseleave', () => { if (viaMouse()) skewt.leave(); });
  touchHover(sk, e => skewt.hover(e));
  $('app-skewt-meta').addEventListener('click', () => skewt.leave());

  // ══ Time–height ══════════════════════════════════════════════════════════
  // (a phone: one day by default — set in app.html's head, before timeheight.js reads it)
  let thReady = false;
  function sizeTh() {
    const v = $('v-th');
    if (v.hidden) return;
    const h = Math.max(320, v.clientHeight - 8 - $('th-legend').offsetHeight - $('sounding-meta').offsetHeight);
    $('th-box').style.height = h + 'px';
    if (thReady) TimeHeight.render();
  }
  function loadTh() {
    if (!thReady) { TimeHeight.init({}); thReady = true; }
    Promise.resolve(TimeHeight.load()).then(() => sizeTh());      // the legend's height is known after the load
  }
  touchHover($('th-canvas'), e => $('th-canvas').dispatchEvent(new MouseEvent('mousemove', { clientX: e.clientX, clientY: e.clientY })));
  // registered before timeheight.js's own listener: keep the read-out after a tap
  $('th-canvas').addEventListener('mouseleave', e => { if (!viaMouse()) e.stopImmediatePropagation(); });

  // ══ ACI & WS ═════════════════════════════════════════════════════════════
  const A = { hours: parseInt(lsGet('ms_app_aci_h', '6'), 10), mode: lsGet('ms_app_aci_mode', 'ws'),
              aph: [], dep: [], ga: [], fetched: 0, dots: [] };
  if (![3, 6, 12, 24].includes(A.hours)) A.hours = 6;
  if (!['ws', 'cond'].includes(A.mode)) A.mode = 'ws';
  $('app-aci-hours').value = String(A.hours);
  $('app-aci-ws').value = A.mode;
  $('app-aci-hours').addEventListener('change', e => { A.hours = parseInt(e.target.value, 10); lsSet('ms_app_aci_h', A.hours); loadAci(); });
  $('app-aci-ws').addEventListener('change', e => { A.mode = e.target.value; lsSet('ms_app_aci_mode', A.mode); loadAci(); });
  const WS_COL = { adv: '#3b82f6', wsa: '#d97706', mba: '#ef4444' };
  const ACI_COL_D = ['#34d399', '#a3e635', '#facc15', '#fb923c', '#f87171'];
  const ACI_COL_L = ['#047857', '#4d7c0f', '#a16207', '#c2410c', '#b91c1c'];     // darker on the light theme
  const aciLvl = v => v < 2 ? 0 : v < 4 ? 1 : v < 6 ? 2 : v < 8 ? 3 : 4;

  function drawAci() {
    const v = $('v-aci');
    if (v.hidden) return;
    const cv = $('app-aci'), box = $('app-aci-box');
    const W = Math.max(280, v.clientWidth - 8);
    const H = Math.max(220, Math.min(Math.round(W * (A.mode === 'ws' ? 0.95 : 0.65)), v.clientHeight - 150));
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    box.style.width = W + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    A.dots = WsCondChart.draw(ctx, W, H, $('app-aci-readout'), {
      aph: A.aph, dep: A.dep, ga: A.ga, hours: A.hours, withWs: A.mode === 'ws', fetchedMs: A.fetched });
    // the latest landings as a short list
    const rows = A.aph.slice().sort((a, b) => b.ts - a.ts).slice(0, 15).map(e => {
      const c = e.cond && e.cond.idx != null ? e.cond.idx : null;
      const lv = e.shear && e.shear.lvl && e.shear.lvl !== 'none' ? e.shear.lvl : null;
      return `<tr><td>${esc(e.time_utc || hhmm(e.ts))}</td><td>${esc(e.callsign || e.icao)}</td><td>${esc(e.aircraft_type || '')}</td>` +
             `<td>${esc(e.runway || '')}</td><td class="num"${c != null ? ` style="color:${(document.documentElement.dataset.theme === 'light' ? ACI_COL_L : ACI_COL_D)[aciLvl(c)]};font-weight:600"` : ''}>${c != null ? c.toFixed(1) : '—'}</td>` +
             `<td${lv ? ` style="color:${WS_COL[lv]};font-weight:600"` : ''}>${lv ? lv.toUpperCase() : '—'}</td></tr>`;
    });
    $('app-aci-list').innerHTML = rows.length
      ? `<table><thead><tr><th>UTC</th><th>Flight</th><th>Type</th><th>Rwy</th><th class="num">ACI</th><th>WS</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
      : '';
  }
  async function loadAci() {
    const win = A.hours * 3600;
    try {
      const [aph, dep, st] = await Promise.all([
        fetch(`/api/windshear/approach-history?window=${win}`, { cache: 'no-store' }).then(r => r.json()),
        A.mode === 'ws' ? fetch(`/api/windshear/departures?window=${win}`, { cache: 'no-store' }).then(r => r.json()) : Promise.resolve([]),
        fetch('/api/windshear/state', { cache: 'no-store' }).then(r => r.json()).catch(() => null),
      ]);
      A.aph = Array.isArray(aph) ? aph : [];
      A.dep = Array.isArray(dep) ? dep : [];
      A.ga = st && !Array.isArray(st) ? st.ga_events || [] : [];
      A.fetched = Date.now();
      $('app-sub').textContent = `last ${A.hours === 24 ? '24 h' : A.hours + ' h'} · ${A.aph.length} landings · updated ${new Date().toISOString().slice(11, 16)} UTC`;
    } catch (_) { $('app-sub').textContent = 'Could not load the landings.'; }
    drawAci();
  }
  function pickAci(e) {
    const r = $('app-aci').getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = 18 * 18;
    for (const d of A.dots) {
      const dd = (d.x - x) ** 2 + (d.y - y) ** 2;
      if (dd < bd) { bd = dd; best = d; }
    }
    $('app-aci-pick').textContent = best ? best.label : 'Tap a dot for the landing.';
  }
  $('app-aci').addEventListener('pointerdown', pickAci);
  $('app-aci').addEventListener('pointermove', e => { if (e.pointerType !== 'mouse' || e.buttons) pickAci(e); });

  // ══ ILS approach ═════════════════════════════════════════════════════════
  const I = { rwy: lsGet('ms_app_ils_rwy', ''), range: lsGet('ms_app_ils_range', '15'),
              barbs: lsGet('ms_app_ils_barbs', 'lo'), comp: lsGet('ms_app_ils_comp', 'hw'),
              lvl: lsGet('ms_ws_alert_lvl', 'wsa'), trails: lsGet('ms_app_ils_trails', 'true') !== 'false',
              ac: [], ev: [], sel: null, manual: false, dots: [], fetched: 0 };
  if (!['', '04L&R', '22L&R', '04L', '04R', '22L', '22R', '15', '33'].includes(I.rwy)) I.rwy = '';
  if (!['15', '7.5'].includes(I.range)) I.range = '15';
  if (!['lo', 'hi', 'off'].includes(I.barbs)) I.barbs = 'lo';
  if (!['hw', 'xw', 'off'].includes(I.comp)) I.comp = 'hw';
  if (!['adv', 'wsa', 'mba', 'off'].includes(I.lvl)) I.lvl = 'wsa';
  const ilsCtl = [['app-ils-rwy', 'rwy', 'ms_app_ils_rwy'], ['app-ils-range', 'range', 'ms_app_ils_range'],
                  ['app-ils-barbs', 'barbs', 'ms_app_ils_barbs'], ['app-ils-comp', 'comp', 'ms_app_ils_comp'],
                  ['app-ils-lvl', 'lvl', 'ms_ws_alert_lvl']];
  for (const [id, key, ls] of ilsCtl) {
    $(id).value = I[key];
    $(id).addEventListener('change', e => { I[key] = e.target.value; lsSet(ls, I[key]); autoSel(); drawIls(); });
  }
  $('app-ils-trails').checked = I.trails;
  $('app-ils-trails').addEventListener('change', e => { I.trails = e.target.checked; lsSet('ms_app_ils_trails', I.trails); drawIls(); });

  const ILS_SRC = { MRAR: '#3b82f6', COMPUTED: '#10b981', MHR: '#f59e0b', JSON: '#a855f7' };
  const ILS_GS_D = { ON: '#6ee7b7', HIGH: '#fcd34d', LOW: '#fca5a5', FAR: '#94a3b8' };
  const ILS_GS_L = { ON: '#047857', HIGH: '#b45309', LOW: '#b91c1c', FAR: '#64748b' };
  const LV_RANK = { adv: 0, wsa: 1, mba: 2 };
  const rwyOk = r => !I.rwy || (I.rwy === '04L&R' ? r === '04L' || r === '04R' : I.rwy === '22L&R' ? r === '22L' || r === '22R' : r === I.rwy);
  const onApp = () => I.ac.filter(a => a.in_corridor && a.dist_thr_nm != null && rwyOk(a.approach_runway))
                          .sort((a, b) => a.dist_thr_nm - b.dist_thr_nm);
  const ilsBase = () => WS_THR_ELEVATION_FT + WS_GS_OFFSET_FT + (1013.25 - (wxQnh || 1013.25)) * 27;
  const shownEv = () => I.lvl === 'off' ? [] : I.ev.filter(e => (LV_RANK[e.lvl] ?? 0) >= LV_RANK[I.lvl] && rwyOk(e.rwy));
  // Auto: the barbs of the lowest aircraft on the approach (the closest to the
  // threshold); a tap on an aircraft follows that one while it is on the approach
  function autoSel() {
    const list = onApp();
    if (I.manual && list.some(a => a.icao === I.sel)) return;
    I.manual = false;
    I.sel = list.length ? list[0].icao : null;
  }
  function selectIls(icao) {
    if (icao) { I.sel = icao; I.manual = true; } else { I.manual = false; autoSel(); }
    drawIls();
  }
  function drawIls() {
    const v = $('v-ils');
    if (v.hidden) return;
    const cv = $('app-ils'), box = $('app-ils-box');
    const W = Math.max(280, v.clientWidth - 8);
    const portrait = v.clientHeight >= v.clientWidth;
    const H = portrait ? Math.round(Math.max(260, Math.min(W * 1.3, v.clientHeight - 200)))
                       : Math.max(230, v.clientHeight - 64);
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    box.style.width = W + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    I.dots = IlsProfile.draw(ctx, W, H, {
      aircraft: I.ac, events: shownEv(), qnh: wxQnh, metarWind: wxWind, thrElev: WS_THR_ELEVATION_FT,
      gsOffset: WS_GS_OFFSET_FT, rangeNm: parseFloat(I.range), rwy: I.rwy, selIcao: I.sel,
      barbs: I.barbs, comp: I.comp, trails: I.trails, alertLevel: I.lvl });
    ilsInfo();
    markScroll();
  }
  const fmtWind = (s, d) => s == null || d == null ? '—' : `${String(Math.round(d)).padStart(3, '0')}/${Math.round(s)}`;
  function ilsInfo() {
    const light = document.documentElement.dataset.theme === 'light';
    const pal = light ? ILS_GS_L : ILS_GS_D, base = ilsBase();
    const list = onApp(), evs = shownEv();
    const sel = I.ac.find(a => a.icao === I.sel);
    const hdgOf = a => IlsProfile.RWY_HEADINGS[a.approach_runway];
    const hw = a => a.best_wind_spd != null && a.best_wind_dir != null && hdgOf(a) != null
      ? Math.round(IlsProfile.hwKt(a.best_wind_spd, a.best_wind_dir, hdgOf(a))) : null;
    const hwTxt = v => v == null ? '' : v >= 0 ? ` · HW +${v}` : ` · TW ${-v}`;
    const pick = $('app-ils-pick');
    if (I.barbs === 'off' || !sel) {
      pick.innerHTML = `<span class="txt">${list.length ? 'Tap an aircraft or a strip for its wind barbs.' : 'No aircraft on the approach' + (I.rwy ? ' to ' + esc(I.rwy) : '') + '.'}</span>`;
    } else {
      pick.innerHTML = `<span class="txt"><b>${esc(sel.callsign || sel.icao)}</b> ${esc(sel.aircraft_type || '')} · RWY ${esc(sel.approach_runway || '?')} · ` +
        `${sel.dist_thr_nm != null ? sel.dist_thr_nm.toFixed(1) : '—'} NM · ${sel.altitude != null ? Math.round(sel.altitude) : '—'} ft · ` +
        `wind ${fmtWind(sel.best_wind_spd, sel.best_wind_dir)}${hwTxt(hw(sel))} · ${I.manual ? 'chosen' : 'auto: lowest'}</span>` +
        (I.manual ? '<button type="button" class="app-btn" id="app-ils-auto">Auto</button>' : '');
      const b = $('app-ils-auto');
      if (b) b.addEventListener('click', () => selectIls(null));
    }
    const wsOf = icao => evs.filter(e => e.icao === icao).sort((a, b) => LV_RANK[b.lvl] - LV_RANK[a.lvl])[0];
    const WSC = { adv: '#3b82f6', wsa: '#d97706', mba: '#ef4444' };
    $('app-ils-list').innerHTML = list.length ? list.map(a => {
      const gs = IlsProfile.gsStatus(a, base), w = wsOf(a.icao);
      const vs = a.vert_rate != null ? `${a.vert_rate > 0 ? '+' : ''}${Math.round(a.vert_rate / 10) * 10} fpm` : '';
      return `<button type="button" class="app-strip${a.icao === I.sel && I.barbs !== 'off' ? ' sel' : ''}" data-icao="${esc(a.icao)}"` +
             ` style="--src:${ILS_SRC[a.meteo_source] || 'var(--border)'}">` +
             `<span class="rwy">${esc(a.approach_runway || '?')}</span><span class="cs">${esc(a.callsign || a.icao)}${a.ap ? ' <small>AP</small>' : ''}</span>` +
             `<span class="badges">${w ? `<span class="ws" style="background:${WSC[w.lvl]}">${w.lvl.toUpperCase()}</span>` : ''}<span class="gs" style="color:${pal[gs]}">${gs}</span></span>` +
             `<span class="row">${esc(a.aircraft_type || '—')} · ${a.dist_thr_nm.toFixed(1)} NM · ${a.altitude != null ? Math.round(a.altitude) + ' ft' : '—'}${vs ? ' · ' + vs : ''}</span>` +
             `<span class="row">wind ${fmtWind(a.best_wind_spd, a.best_wind_dir)}${hwTxt(hw(a))}</span></button>`;
    }).join('') : '';
    const alert = evs.length ? ' · ⚠ ' + [...new Set(evs.map(e => `${e.lvl.toUpperCase()} ${e.rwy}`))].join(', ') : '';
    $('app-sub').textContent = I.fetched
      ? `${list.length} on approach · QNH ${wxQnh != null ? Math.round(wxQnh) : '—'}${alert} · ${new Date(I.fetched).toISOString().slice(11, 19)} UTC`
      : 'Loading…';
  }
  async function loadIls() {
    try {
      const st = await (await fetch('/api/windshear/state', { cache: 'no-store' })).json();
      I.ac = st && !Array.isArray(st) ? st.aircraft || [] : Array.isArray(st) ? st : [];
      I.ev = st && !Array.isArray(st) ? st.ws_events || [] : [];
      I.fetched = Date.now();
      autoSel();
      drawIls();
    } catch (_) { $('app-sub').textContent = 'Could not load the approach traffic.'; }
  }
  $('app-ils').addEventListener('pointerdown', e => {
    const r = $('app-ils').getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = 22 * 22;
    for (const d of I.dots) { const dd = (d.x - x) ** 2 + (d.y - y) ** 2; if (dd < bd) { bd = dd; best = d; } }
    if (best) selectIls(best.icao);
  });
  $('app-ils-list').addEventListener('click', e => {
    const b = e.target.closest('.app-strip');
    if (b) selectIls(b.dataset.icao);
  });

  // ══ views ════════════════════════════════════════════════════════════════
  // a view taller than the screen: drags on the diagram scroll the page
  // (taps still give the read-out); otherwise drags move the read-out
  function markScroll() {
    const v = $(VIEWS[view].el);
    v.classList.toggle('scrolls', v.scrollHeight > v.clientHeight + 2);
  }
  function layout(redraw) {
    if (view.startsWith('skewt')) sizeSkewT();
    else if (view === 'th') sizeTh();
    else if (view === 'ils') drawIls();
    else if (view === 'aci') drawAci();
    markScroll();
  }
  function refresh() {
    if (document.hidden) return;
    if (view === 'skewt-now') { loadNow(); }
    else if (view === 'th') loadTh();
    else if (view === 'ils') loadIls();
    else if (view === 'aci') loadAci();
  }
  function startTimer() {
    clearInterval(timer);
    const every = { 'skewt-now': 120e3, 'skewt-hour': 0, th: 600e3, ils: 5e3, aci: 60e3 }[view];
    if (every) timer = setInterval(refresh, every);
  }
  function setView(v, fromMenu) {
    view = VIEWS[v] ? v : 'skewt-now';
    lsSet('ms_app_view', view);
    const cfgv = VIEWS[view];
    for (const k of Object.keys(VIEWS)) $(VIEWS[k].el).hidden = VIEWS[k].el !== cfgv.el;
    // the shown view's options open, the other products' folded (still reachable)
    document.querySelectorAll('.app-sec[data-for]').forEach(s => {
      const cur = s.dataset.for === cfgv.sec;
      s.open = cur; s.classList.toggle('cur', cur);
    });
    document.querySelectorAll('.app-field[data-for]').forEach(r => {
      r.hidden = r.dataset.for !== view;            // Window: Area now; Date + Hour: Area hour
    });
    document.querySelectorAll('.app-tile').forEach(t => {
      const on = t.dataset.view === view;
      t.classList.toggle('on', on); t.setAttribute('aria-pressed', String(on));
    });
    $('app-title').textContent = cfgv.title;
    $('app-sub').textContent = '';
    skewt.leave();
    layout();
    if (view === 'skewt-now') { prof = null; sfc = wxSfc; drawSkewT(); loadNow(); }
    else if (view === 'skewt-hour') { prof = null; drawSkewT(); loadHourList(); }
    else if (view === 'th') { $('app-sub').textContent = 'hourly area profiles'; loadTh(); }
    else if (view === 'ils') { I.fetched = 0; fetchWx(); loadIls(); }
    else if (view === 'aci') loadAci();
    startTimer();
    if (fromMenu) setTimeout(() => menu(false), 150);
  }
  document.querySelectorAll('.app-tile').forEach(t => t.addEventListener('click', () => setView(t.dataset.view, true)));

  let rt = null;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => layout(), 120); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { refresh(); pollHealth(); fetchWx(); }
  });

  fetchWx();
  setInterval(() => { if (!document.hidden) fetchWx(); }, 600e3);
  pollHealth();
  setInterval(() => { if (!document.hidden) pollHealth(); }, 60e3);
  setView(view);
})();
