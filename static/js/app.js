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
 *                       /api/windshear/state?lite=1 every 5 s (only the
 *                       corridor aircraft and the alerts, gzipped), with
 *                       the strips below
 *   ACI · WS · ST       ws_cond_chart.js (the Windshear page's chart) with
 *                       the landings, departures and go-arounds of 3 h … 1 d;
 *                       Space–time: drawSpaceTime of /api/windshear/spacetime
 *                       (from 2026-10-28)
 *   History             the Approach History as cards (from 2026-10-28):
 *                       landings (/api/windshear/approach-history?lite=1) or
 *                       departures (/api/windshear/departures?full=1), with a
 *                       search; a tap opens a flight's bands and reports
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
    aci:          { title: 'ACI · WS · ST', sec: 'aci', el: 'v-aci' },
    hist:         { title: 'History', sec: 'hist', el: 'v-hist' },
    stats:        { title: 'Statistics', sec: 'stats', el: 'v-stats' },
    wx:           { title: 'Weather', sec: 'wx', el: 'v-wx' },        // from 2026-10-30 (app_wx.js)
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
  // the button of the top bar (from 2026-10-28; was a selector in General): Dark,
  // Light or Auto — Auto follows the phone's setting (prefers-color-scheme) and
  // switches with it while the page is open.  The icon shows the setting in use;
  // a tap steps Dark → Light → Auto → Dark.  Auto is ms_app_theme_auto = 1 (also
  // the default when no theme was ever chosen); a chosen Light / Dark stays in
  // ms_theme as before, shared with the full site, which has no Auto.
  const themeBtn = $('app-theme-btn');
  const themeMq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  const THEME_LBL = { dark: 'Dark', light: 'Light', auto: 'Auto — follows the phone' };
  let themeMode = (() => {
    const a = lsGet('ms_app_theme_auto', null), t = lsGet('ms_theme', null);
    return a === '1' || (a == null && t == null) ? 'auto' : (t === 'light' ? 'light' : 'dark');
  })();
  function applyTheme(redraw) {
    const root = document.documentElement;
    const was = root.dataset.theme === 'light';
    const light = themeMode === 'auto' ? !!(themeMq && themeMq.matches) : themeMode === 'light';
    if (light) root.dataset.theme = 'light'; else delete root.dataset.theme;
    root.dataset.themeMode = themeMode;
    const tc = document.querySelector('meta[name="theme-color"]');
    if (tc) tc.content = light ? '#e8edf3' : '#0f1923';
    const lbl = `Theme: ${THEME_LBL[themeMode]}${themeMode === 'auto' ? ` (now ${light ? 'light' : 'dark'})` : ''} — tap to change`;
    themeBtn.title = lbl; themeBtn.setAttribute('aria-label', lbl);
    if (redraw && was !== light) {
      layout(true);
      if (typeof window.onThemeChange === 'function') window.onThemeChange();   // the Statistics charts
      if (window.AppWx && window.AppWx.ready()) window.AppWx.theme();            // the Weather view's map
    }
  }
  let themeNoteT = null;
  function themeNote(txt) {
    const n = $('app-theme-note');
    n.textContent = txt; n.hidden = false; n.classList.remove('fade');
    clearTimeout(themeNoteT);
    themeNoteT = setTimeout(() => { n.classList.add('fade'); themeNoteT = setTimeout(() => { n.hidden = true; }, 300); }, 1600);
  }
  applyTheme(false);
  themeBtn.addEventListener('click', () => {
    themeMode = { dark: 'light', light: 'auto', auto: 'dark' }[themeMode];
    lsSet('ms_app_theme_auto', themeMode === 'auto' ? '1' : '0');
    if (themeMode !== 'auto') lsSet('ms_theme', themeMode);
    applyTheme(true);
    themeNote(`Theme: ${THEME_LBL[themeMode]}`);
  });
  if (themeMq) {
    const onMq = () => { if (themeMode === 'auto') applyTheme(true); };
    if (themeMq.addEventListener) themeMq.addEventListener('change', onMq); else if (themeMq.addListener) themeMq.addListener(onMq);
  }

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
              aph: [], dep: [], ga: [], st: null, wx: null, fetched: 0, dots: [], all: false, cell: null };
  if (![3, 6, 12, 24].includes(A.hours)) A.hours = 6;
  if (!['ws', 'cond', 'st', 'edr', 'bl', 'blt'].includes(A.mode)) A.mode = 'ws';
  const isBl = () => A.mode === 'bl' || A.mode === 'blt';     // boundary layer (from 2026-10-29)
  const pickHint = () => A.mode === 'st' ? 'Tap a cell for its flights.' : isBl() ? 'Tap a cell, a jet ◆ or the inversion bar.' : 'Tap a dot for the landing.';
  $('app-aci-hours').value = String(A.hours);
  $('app-aci-ws').value = A.mode;
  $('app-aci-pick').textContent = pickHint();
  $('app-aci-hours').addEventListener('change', e => { A.hours = parseInt(e.target.value, 10); lsSet('ms_app_aci_h', A.hours);
    A.all = false; A.cell = null; loadAci(); });
  $('app-aci-ws').addEventListener('change', e => {
    A.mode = e.target.value; lsSet('ms_app_aci_mode', A.mode); A.all = false; A.cell = null;
    $('app-aci-pick').textContent = pickHint();
    loadAci(); });
  const WS_COL = { adv: '#3b82f6', wsa: '#d97706', mba: '#ef4444' };
  const ACI_COL_D = ['#34d399', '#a3e635', '#facc15', '#fb923c', '#f87171'];
  const ACI_COL_L = ['#047857', '#4d7c0f', '#a16207', '#c2410c', '#b91c1c'];     // darker on the light theme
  const aciLvl = v => v < 2 ? 0 : v < 4 ? 1 : v < 6 ? 2 : v < 8 ? 3 : 4;

  function drawAci() {
    const v = $('v-aci');
    if (v.hidden) return;
    const cv = $('app-aci'), box = $('app-aci-box');
    const W = Math.max(280, v.clientWidth - 8);
    const H = Math.max(220, Math.min(Math.round(W * (isBl() ? 1.0 : A.mode === 'edr' ? 1.25 : A.mode === 'ws' ? 0.95 : A.mode === 'st' ? 0.8 : 0.65)), v.clientHeight - 150));
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    box.style.width = W + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (isBl()) {                    // boundary layer: no flight list under it
      A.dots = WsCondChart.drawBoundaryLayer(ctx, W, H, $('app-aci-readout'), {
        bl: A.bl, hours: A.hours, field: A.mode === 'blt' ? 'temp' : 'wind', fetchedMs: A.bl ? A.fetched : 0 });
      $('app-aci-list').innerHTML = '';
      return;
    }
    A.dots = A.mode === 'st'
      ? WsCondChart.drawSpaceTime(ctx, W, H, $('app-aci-readout'), { st: A.st, hours: A.hours, fetchedMs: A.st ? A.fetched : 0 })
      : WsCondChart.draw(ctx, W, H, $('app-aci-readout'), {
          aph: A.aph, dep: A.dep, ga: A.ga, hours: A.hours, withWs: A.mode === 'ws' || A.mode === 'edr', withEdr: A.mode === 'edr', selMs: A.selMs, fetchedMs: A.fetched,
          met: A.wx ? A.wx.metars : [], rep: A.wx ? A.wx.reports : [] });
    drawAciList();
  }

  // The list under the chart (from 2026-10-28): the flights of the chosen range,
  // newest first, as the chart shows them — ACI only: the landings; ACI +
  // windshear: landings and departures; Space–time: the flights of the diagram,
  // or of the tapped cell.  15 rows, the rest behind "Show all"; the buttons open
  // the History view with the same range.
  const ACI_LIST_N = 15;
  const rangeTxt = h => h === 24 ? '24 h' : h + ' h';
  const wsCell = lv => lv && lv !== 'none' && WS_COL[lv] ? `<td style="color:${WS_COL[lv]};font-weight:600">${lv.toUpperCase()}</td>` : '<td>—</td>';
  const phCell = dep => `<td class="ph" title="${dep ? 'departure' : 'landing'}">${dep ? '↑' : '↓'}</td>`;
  const kts = a => a == null ? '—' : (a > 0 ? '+' : a < 0 ? '−' : '') + Math.abs(Math.round(a));
  function aciFlights() {
    const t0 = Date.now() / 1000 - A.hours * 3600;
    if (A.mode === 'st') {
      return ((A.st && A.st.flights) || []).filter(f => f.ts >= t0).map(f => {
        let d = null;                                    // the largest band change of the flight
        for (const [b, v] of Object.entries(f.b || {})) if (v[0] != null && (!d || Math.abs(v[0]) > Math.abs(d[1]))) d = [+b, v[0]];
        return { ts: f.ts, dep: f.ph === 'dep', cs: f.cs, type: f.type, rwy: f.rwy, lvl: f.lvl, d };
      });
    }
    const out = A.aph.map(e => ({ ts: e.ts, dep: false, cs: e.callsign || e.icao, type: e.aircraft_type, rwy: e.runway,
      aci: e.cond && e.cond.idx != null ? e.cond.idx : null, lvl: e.shear && e.shear.lvl }));
    if (A.mode === 'ws' || A.mode === 'edr') for (const e of A.dep) {
      out.push({ ts: e.ts, dep: true, cs: e.callsign || e.icao, type: e.aircraft_type, rwy: e.shear && e.shear.rwy, aci: null, lvl: e.shear && e.shear.lvl });
    }
    return out;
  }
  function drawAciList() {
    const el = $('app-aci-list');
    const both = A.mode !== 'cond';
    const histBtns = `<div class="app-list-act"><button type="button" class="app-btn" data-hist="arr">Landings in History ›</button>` +
      (both ? `<button type="button" class="app-btn" data-hist="dep">Departures in History ›</button>` : '') + '</div>';
    // a tapped space–time cell: its flights
    if (A.mode === 'st' && A.cell) {
      const c = A.cell;
      const rows = c.items.slice().sort((a, b) => b.ts - a.ts).map(f =>
        `<tr><td>${hhmm(f.ts)}</td>${phCell(f.ph === 'dep')}<td>${esc(f.cs || '?')}</td><td>${esc(f.type || '')}</td><td>${esc(f.rwy || '')}</td>` +
        `<td class="num">${kts(f.a)}</td><td class="num">${f.wd != null ? String(f.wd).padStart(3, '0') + '°/' + f.ws : '—'}</td>${wsCell(f.lvl)}</tr>`);
      el.innerHTML = `<div class="app-list-hd"><span>${c.t1}–${c.t2} UTC · ${c.b} ft · ${c.items.length} flight${c.items.length === 1 ? '' : 's'}` +
        `${c.med != null ? ` · median ${kts(c.med)} kt` : ''}</span><button type="button" class="app-list-x" data-cell="clear">All flights ×</button></div>` +
        `<table><thead><tr><th>UTC</th><th></th><th>Flight</th><th>Type</th><th>Rwy</th><th class="num">Δ kt</th><th class="num">Wind</th><th>WS</th></tr></thead><tbody>${rows.join('')}</tbody></table>` + histBtns;
      return;
    }
    const fl = aciFlights().sort((a, b) => b.ts - a.ts);
    const nDep = fl.filter(f => f.dep).length, nArr = fl.length - nDep;
    const noun = both ? `flight${fl.length === 1 ? '' : 's'}` : `landing${fl.length === 1 ? '' : 's'}`;
    const split = both ? ` (${nArr} landing${nArr === 1 ? '' : 's'} · ${nDep} departure${nDep === 1 ? '' : 's'})` : '';
    const cut = !A.all && fl.length > ACI_LIST_N;
    const hd = fl.length
      ? `${cut ? `Latest ${ACI_LIST_N} of ` : ''}${fl.length} ${noun}${split} · last ${rangeTxt(A.hours)}`
      : `No ${both ? 'flights' : 'landings'} in the last ${rangeTxt(A.hours)}`;
    const rows = (cut ? fl.slice(0, ACI_LIST_N) : fl).map(f =>
      `<tr><td>${hhmm(f.ts)}</td>${both ? phCell(f.dep) : ''}<td>${esc(f.cs || '')}</td><td>${esc(f.type || '')}</td><td>${esc(f.rwy || '')}</td>` +
      (A.mode === 'st'
        ? `<td class="num">${f.d ? `${kts(f.d[1])} <span class="dim">@${f.d[0]}</span>` : '—'}</td>`
        : `<td class="num"${f.aci != null ? ` style="color:${(document.documentElement.dataset.theme === 'light' ? ACI_COL_L : ACI_COL_D)[aciLvl(f.aci)]};font-weight:600"` : ''}>${f.aci != null ? f.aci.toFixed(1) : '—'}</td>`) +
      `${wsCell(f.lvl)}</tr>`);
    const more = fl.length > ACI_LIST_N
      ? `<button type="button" class="app-btn" data-more="1">${A.all ? `Show the latest ${ACI_LIST_N}` : `Show all ${fl.length}`}</button>` : '';
    el.innerHTML = `<div class="app-list-hd"><span>${hd}</span></div>` +
      (fl.length ? `<table><thead><tr><th>UTC</th>${both ? '<th></th>' : ''}<th>Flight</th><th>Type</th><th>Rwy</th>` +
        `${A.mode === 'st' ? '<th class="num" title="the largest band change of the flight and its band (ft)">Δ max kt</th>' : '<th class="num">ACI</th>'}<th>WS</th></tr></thead>` +
        `<tbody>${rows.join('')}</tbody></table>` : '') +
      histBtns.replace('<div class="app-list-act">', `<div class="app-list-act">${more}`);
  }
  function openHist(kind) {
    H.kind = kind; H.hours = A.hours; H.date = ''; H.q = ''; H.rows = []; H.open.clear();
    lsSet('ms_app_hist_kind', kind); lsSet('ms_app_hist_h', A.hours);
    $('app-hist-kind').value = kind; $('app-hist-hours').value = String(A.hours);
    $('app-hist-date').value = ''; $('app-hist-q').value = '';
    histFields();
    syncChips();
    setView('hist');
  }
  $('app-aci-list').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.more) { A.all = !A.all; drawAciList(); markScroll(); }
    else if (b.dataset.cell) { A.cell = null; $('app-aci-pick').textContent = 'Tap a cell for its flights.'; drawAciList(); markScroll(); }
    else if (b.dataset.hist) openHist(b.dataset.hist);
  });
  async function loadAci() {
    const win = A.hours * 3600;
    try {
      // landings lite (no per-landing details, gzipped: about an eighth of the full answer)
      const [aph, dep, st, sp, wx] = await Promise.all([
        fetch(`/api/windshear/approach-history?lite=1&window=${win}`, { cache: 'no-store' }).then(r => r.json()),
        A.mode === 'ws' || A.mode === 'edr' ? fetch(`/api/windshear/departures?window=${win}`, { cache: 'no-store' }).then(r => r.json()) : Promise.resolve([]),
        A.mode === 'st' || isBl() ? Promise.resolve(null) : fetch('/api/windshear/state', { cache: 'no-store' }).then(r => r.json()).catch(() => null),
        A.mode === 'st' ? fetch(`/api/windshear/spacetime?hours=${A.hours}`, { cache: 'no-store' }).then(r => r.json()) : Promise.resolve(null),
        // METAR windshear groups and pilot reports near the airport (from 2026-10-29)
        A.mode === 'ws' || A.mode === 'edr' ? fetch(`/api/wx/reports?hours=${A.hours + 1}&ws=1&near=1`, { cache: 'no-store' }).then(r => r.json()).catch(() => null) : Promise.resolve(null),
      ]);
      A.st = sp;
      A.bl = isBl() ? await (await fetch(`/api/boundary?hours=${A.hours}`, { cache: 'no-store' })).json() : null;
      A.wx = wx;
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
    $('app-aci-pick').textContent = best ? best.label : pickHint();
    if (A.mode === 'edr' && best && best.ms && best.ms !== A.selMs) { A.selMs = best.ms; drawAci(); }
    if (A.mode === 'st') {                     // the list follows the tapped cell
      const c = best && best.cell ? best.cell : null;
      if (c !== A.cell && (c || e.type === 'pointerdown')) { A.cell = c; drawAciList(); markScroll(); }
    }
  }
  $('app-aci').addEventListener('pointerdown', pickAci);
  $('app-aci').addEventListener('pointermove', e => { if (e.pointerType !== 'mouse' || e.buttons) pickAci(e); });

  // ══ History (from 2026-10-28) ════════════════════════════════════════════
  // The Windshear page's Approach History for a phone: the landings or the
  // departures of 1 h … 1 day or of one UTC date as cards, newest first, with a
  // search (callsign, registration, type — anywhere, case and hyphens ignored).
  // Line 1: time, callsign, type, runway and chips (ACI, windshear level,
  // trial, go-around); line 2: one cell per height band (headwind, crosswind
  // or wind) or a one-line ACI / windshear summary.  A tap opens all the bands
  // and the reports (the texts the desktop shows on hover).
  const HB_LO = [600, 800, 1000, 1400, 1800, 2200, 2600, 3000];
  const HB_HI = [600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400, 2600, 2800, 3000];
  const HB_ALL = [200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400, 2600, 2800, 3000];
  const H = { kind: lsGet('ms_app_hist_kind', 'arr'), hours: parseInt(lsGet('ms_app_hist_h', '3'), 10),
              show: lsGet('ms_app_hist_show', 'hw'), res: lsGet('ms_app_hist_res', 'lo'),
              rep: lsGet('ms_app_hist_rep', 'all'), wx: null,
              date: '', q: '', rows: [], open: new Set(), fetched: 0, req: 0 };
  // kind 'rep' (from 2026-10-29): the stored METARs and pilot reports, filter all / ws / arch
  if (!['arr', 'dep', 'rep'].includes(H.kind)) H.kind = 'arr';
  if (!['all', 'ws', 'arch'].includes(H.rep)) H.rep = 'all';
  if (![1, 3, 6, 12, 24].includes(H.hours)) H.hours = 3;
  if (!['hw', 'xw', 'wind', 'aci', 'ws', 'edr'].includes(H.show)) H.show = 'hw';
  if (!['lo', 'hi'].includes(H.res)) H.res = 'lo';
  const histCtl = [['app-hist-kind', 'kind', 'ms_app_hist_kind'], ['app-hist-hours', 'hours', 'ms_app_hist_h'],
                   ['app-hist-show', 'show', 'ms_app_hist_show'], ['app-hist-res', 'res', 'ms_app_hist_res'],
                   ['app-hist-rep', 'rep', 'ms_app_hist_rep']];
  for (const [id, key, ls] of histCtl) {
    $(id).value = String(H[key]);
    $(id).addEventListener('change', e => {
      H[key] = key === 'hours' ? parseInt(e.target.value, 10) : e.target.value;
      lsSet(ls, H[key]);
      if (key === 'hours' && H.date) { H.date = ''; $('app-hist-date').value = ''; }
      if (key === 'kind') histFields();
      if (key === 'kind' || key === 'hours' || key === 'rep') { H.rows = []; H.open.clear(); loadHist(); } else drawHist();
    });
  }
  // the reports have their own filter instead of the band display
  function histFields() {
    const rep = H.kind === 'rep';
    for (const id of ['app-hist-show', 'app-hist-res']) $(id).closest('.app-field').hidden = rep;
    $('app-hist-rep').closest('.app-field').hidden = !rep;
    $('app-hist-q').placeholder = rep ? 'Search the text: WS, R22L, TURB, WXREP' : 'Search: callsign, registration, type';
  }
  histFields();
  const isoDay = t => `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  function histDate(v) {
    H.date = v || ''; $('app-hist-date').value = H.date;
    H.rows = []; H.open.clear(); loadHist(); startTimer();
  }
  $('app-hist-date').addEventListener('change', e => histDate(e.target.value));
  $('app-hist-live').addEventListener('click', () => histDate(''));
  function histStep(days) {
    const t = H.date ? new Date(H.date + 'T00:00:00Z') : new Date();
    if (H.date) t.setUTCDate(t.getUTCDate() + days);
    if (t.getTime() > Date.now()) { histDate(''); return; }
    histDate(isoDay(t));
  }
  $('app-hist-prev').addEventListener('click', () => histStep(-1));
  $('app-hist-next').addEventListener('click', () => histStep(1));
  const normQ = s => String(s || '').toUpperCase().replace(/[\s-]/g, '');
  $('app-hist-q').addEventListener('input', e => { H.q = normQ(e.target.value); drawHist(); });

  const hwOf = (b, h) => b && h != null ? Math.round(b.spd * Math.cos((b.dir - h) * Math.PI / 180)) : null;
  const xwOf = (b, h) => b && h != null ? Math.round(b.spd * Math.sin((b.dir - h) * Math.PI / 180)) : null;
  const sgn = v => (v > 0 ? '+' : '') + v;
  const hwCls = v => v >= 5 ? 'ws-aphist-hw-pos' : v <= -5 ? 'ws-aphist-hw-neg' : 'ws-aphist-hw-zero';
  const xwCls = v => Math.abs(v) >= 10 ? 'ws-aphist-xw-strong' : Math.abs(v) >= 5 ? 'ws-aphist-xw-mod' : 'ws-aphist-xw-light';
  const LV_TXT = { adv: 'ADV', wsa: 'WSA', mba: 'MBA' };
  const LV_NAME = { adv: 'windshear advisory', wsa: 'windshear alert', mba: 'microburst alert' };
  const aciCol = c => (document.documentElement.dataset.theme === 'light' ? ACI_COL_L : ACI_COL_D)[aciLvl(c)];
  const rampTxt = r => r ? `${Math.abs(r.dv).toFixed(0)} kt over ${(r.L / 1000).toFixed(1)} km, ${r.a1}→${r.a2} ft` +
    (r.d1 != null && r.d2 != null ? ` (${r.d1.toFixed(1)}→${r.d2.toFixed(1)} NM)` : '') + ` = ${r.sc} kt per 1 km${r.zone ? '' : ' (outside the low-level zone)'}` : 'none above the noise';
  const refWho = (b, dep) => b.ph === 'same' ? `${b.n} ${dep ? 'departures' : 'landings'}`
    : b.ph === 'all' ? `${b.n} landings and departures, phase bias removed` : `${b.n} flights`;
  const cfTxt = cf => { if (!cf) return ''; const n = (cf.b || 0) + (cf.a || 0);
    return n ? `Confirmed: the same ramp was seen by ${n} of ${(cf.nb || 0) + (cf.na || 0)} nearby landings`
             : `Isolated${cf.fin ? '' : ' so far'}: not seen by the nearby landings — probably turbulence`; };

  // turbulence (EDR, collector/edr.py; from 2026-10-29, research): the ICAO
  // Annex 3 classes of a medium aircraft, as the ACI + EDR + WS chart
  const EDR_NAME = ['smooth', 'light', 'moderate', 'severe'];
  const edrCls = v => v >= 0.45 ? 3 : v >= 0.20 ? 2 : v >= 0.10 ? 1 : 0;
  const edrCol = v => (document.documentElement.dataset.theme === 'light'
    ? ['#047857', '#a16207', '#c2410c', '#b91c1c'] : ['#34d399', '#facc15', '#fb923c', '#ef4444'])[edrCls(v)];
  const f2 = v => v == null ? '–' : v < 0.01 ? '<0.01' : v.toFixed(2);
  // the boundary layer of the hours of the shown list (/api/boundary, collector/boundary.py)
  const HB = { map: new Map(), keys: new Map(), busy: false };
  async function loadHistBl() {
    const endTs = H.date ? Date.parse(H.date + 'T00:00:00Z') / 1000 + 86400 : null;
    const key = endTs ? String(endTs) : 'now', t = HB.keys.get(key);
    if (HB.busy || (t && (endTs || Date.now() - t < 600_000))) return;
    HB.busy = true;
    try {
      const d = await (await fetch(endTs ? `/api/boundary?hours=24&end=${endTs}` : `/api/boundary?hours=${Math.max(24, H.hours + 1)}`, { cache: 'no-store' })).json();
      for (const r of Array.isArray(d) ? d : []) if (!r.partial) HB.map.set(r.ts, r);
    } catch (_) { /* nothing */ }
    HB.keys.set(key, Date.now()); HB.busy = false;
    drawHist();
  }
  function blThen(ts) {
    const r = HB.map.get(Math.floor(ts / 3600) * 3600);
    if (!r) return '';
    const p = [];
    if (r.llj) p.push(`low-level jet ${r.llj.ft} ft ${r.llj.kt} kt from ${String(r.llj.dir).padStart(3, '0')}°`);
    if (r.inv) p.push(`surface inversion +${r.inv.dT.toFixed(1)} K${r.inv.top ? ` up to ${r.inv.top} ft` : ''}`);
    return `Boundary layer then: ${p.length ? p.join(' · ') : (r.w || []).length ? 'no low-level jet, no surface inversion' : 'no flights in that hour'}`;
  }

  function histChips(e, S = H) {   // S: the settings (kind, show, res) — H, or the ILS view's list (from 2026-10-30)
    const dep = S.kind === 'dep', w = e.shear || null, out = [];
    const c = !dep && e.cond && e.cond.idx != null ? e.cond.idx : null;
    if (c != null) out.push(`<span class="ch" style="color:${aciCol(c)}">ACI ${c.toFixed(1)}</span>`);
    const lv = w && w.lvl && w.lvl !== 'none' ? w.lvl : null;
    if (lv) out.push(`<span class="ch lv" style="background:${WS_COL[lv]}">${LV_TXT[lv]}</span>`);
    const tl = dep && w && w.trial && w.trial.lvl && w.trial.lvl !== 'none' ? w.trial.lvl : null;
    if (tl) out.push(`<span class="ch trial" style="color:${WS_COL[tl]}">${LV_TXT[tl]} trial</span>`);
    if (e.edr && e.edr.m != null) out.push(`<span class="ch edr" style="color:${edrCol(e.edr.m)}">EDR ${f2(e.edr.m)}</span>`);
    if (e.go_arounds > 0 || e.ga) out.push('<span class="ch ga">GA</span>');
    return out.join('');
  }
  function histLine2(e, S = H) {
    const dep = S.kind === 'dep', hdg = e.rwy_heading;
    if (S.show === 'aci') {
      const c = e.cond;
      if (dep) return '<span class="dim">ACI is computed for landings only</span>';
      if (!c || c.idx == null) return `<span class="dim">no index${c && c.metar ? ' · METAR ' + esc(c.metar) : ''}</span>`;
      return `<b style="color:${aciCol(c.idx)}">${c.idx.toFixed(1)} ${esc(c.lbl || '')}</b>` +
             ` · hi ${c.hi ? c.hi.idx.toFixed(1) : '–'} · lo ${c.lo ? c.lo.idx.toFixed(1) : '–'}${c.metar ? ' · ' + esc(c.metar) : ''}`;
    }
    if (S.show === 'edr') {
      const d = e.edr;
      if (!d || d.m == null) return '<span class="dim">no EDR (too few straight pieces)</span>';
      return `<span><b style="color:${edrCol(d.m)}">${f2(d.m)} ${EDR_NAME[edrCls(d.m)]}</b> · lo ${f2(d.lo)} · hi ${f2(d.hi)} · peak <b style="color:${edrCol(d.pk)}">${f2(d.pk)}</b> · ${d.n} pcs</span>`;
    }
    if (S.show === 'ws') {
      const w = e.shear;
      if (!w) return '<span class="dim">no windshear report</span>';
      const t = dep ? w.trial : w, b = w.band, parts = [];
      const strong = t ? [t.loss, t.gain].filter(Boolean).sort((x, y) => y.sc - x.sc)[0] : null;
      if (strong) parts.push(`<span${dep ? ' class="trial"' : ''}>${strong.dv < 0 ? 'loss' : 'gain'} ${Math.abs(strong.dv).toFixed(0)} kt/${(strong.L / 1000).toFixed(1)} km${dep ? ' (trial)' : ''}</span>`);
      if (b) parts.push(`band ${sgn(Math.round(b.a))} @${b.b}`);
      if (!dep && w.cf && w.lvl && w.lvl !== 'none') { const n = (w.cf.b || 0) + (w.cf.a || 0); parts.push(n ? `✓${n}` : 'iso'); }
      return parts.length ? parts.join(' · ') : '<span class="dim">nothing above the noise</span>';
    }
    const bands = S.res === 'hi' ? HB_HI : HB_LO;
    return `<span class="strip" style="--n:${bands.length}">` + bands.map(bb => {
      const b = e.bands ? e.bands[String(bb)] : null;
      if (!b) return '<i class="nil">·</i>';
      if (S.show === 'wind') return `<i><span class="arr" style="transform:rotate(${(b.dir + 180) % 360}deg)">↑</span>${Math.round(b.spd)}</i>`;
      const v = S.show === 'xw' ? xwOf(b, hdg) : hwOf(b, hdg);
      return v == null ? '<i class="nil">·</i>' : `<i class="${S.show === 'xw' ? xwCls(v) : hwCls(v)}">${sgn(v)}</i>`;
    }).join('') + '</span>';
  }
  function histBody(e, S = H) {
    const dep = S.kind === 'dep', hdg = e.rwy_heading, rows = [];
    for (const bb of HB_ALL) {
      const b = e.bands ? e.bands[String(bb)] : null;
      if (!b) continue;
      const hw = hwOf(b, hdg), xw = xwOf(b, hdg);
      rows.push(`<tr><td>${bb}</td><td>${String(Math.round(b.dir)).padStart(3, '0')}°/${Math.round(b.spd)}</td>` +
                `<td class="num ${hw != null ? hwCls(hw) : ''}">${hw != null ? sgn(hw) : '—'}</td>` +
                `<td class="num ${xw != null ? xwCls(xw) : ''}">${xw != null ? sgn(xw) : '—'}</td></tr>`);
    }
    const tbl = rows.length ? `<table><thead><tr><th>ft</th><th>Wind</th><th class="num">HW</th><th class="num">XW</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
                            : '<div class="dim">No band winds stored.</div>';
    const txt = [];
    if (!dep && e.cond && e.cond.idx != null) {
      const c = e.cond, seg = (s, l) => s ? `${l}: ${s.idx.toFixed(1)} (${[s.roll != null ? `bank ${s.roll}°` : '', s.ias != null ? `IAS ${s.ias} kt` : '',
        s.vr != null ? `VS ${s.vr} fpm` : '', s.crab != null ? `crab sd ${s.crab}°` : ''].filter(Boolean).join(', ')}; ${s.n} replies)` : `${l}: no data`;
      txt.push(`Approach conditions ${c.idx.toFixed(1)} – ${c.lbl}`, seg(c.hi, '3000–1000 ft'), seg(c.lo, '1000–200 ft'), c.metar ? `METAR ${c.metar}` : '');
    }
    const w = e.shear;
    if (w) {
      const b = w.band;
      txt.push('', `Windshear — ${w.lvl && w.lvl !== 'none' ? LV_NAME[w.lvl] : 'no alert'}${dep ? ' (band comparison)' : ''}`);
      if (!dep) txt.push(`Strongest loss: ${rampTxt(w.loss)}`, `Strongest gain: ${rampTxt(w.gain)}`,
                         w.fh != null ? `Horizontal F-factor over 1 km: ${w.fh.toFixed(3)}` : '');
      txt.push(b ? `Band ${b.b} ft: ${sgn(b.a)} kt against ${b.ref} kt in the last 45 min (${refWho(b, dep)})` : 'Band change: no reference flights');
      if (b && b.thr) txt.push(`Turboprop climb-out: limits ${b.thr} / ${+(b.thr * 1.5).toFixed(1)} kt`);
      if (!dep && w.cf) txt.push(cfTxt(w.cf));
      if (!dep && w.a) txt.push(`Followed ${w.a[0]}→${w.a[1]} ft · ${w.n} replies, noise ±${w.noise != null ? w.noise : '?'} kt`);
      if (dep) {
        const t = w.trial;
        if (t) txt.push(`TRIAL — ramps along the climb (no alert${t.lvl && t.lvl !== 'none' ? '; would be ' + LV_TXT[t.lvl] : ''}):`,
                        `  loss: ${rampTxt(t.loss)}`, `  gain: ${rampTxt(t.gain)}`,
                        t.a ? `  followed ${t.a[1]}→${t.a[0]} ft · ${t.n} replies, noise ±${t.noise != null ? t.noise : '?'} kt` : '');
        else txt.push('Trial ramps: no climb-out series (before 27 Oct 2026 or too few replies)');
      }
    }
    const d = e.edr;
    txt.push('', d && d.m != null
      ? `Turbulence (EDR, research) ${f2(d.m)} – ${EDR_NAME[edrCls(d.m)]}: 200–1000 ft ${f2(d.lo)} · 1000–${d.top || 3000} ft ${f2(d.hi)} · roughest 2-km piece ${f2(d.pk)} · ${d.n} pieces`
      : 'Turbulence (EDR): no value (too few straight 2-km pieces)');
    const bl = blThen(e.ts);
    if (bl) txt.push(bl);
    if (e.registration) txt.unshift(`${e.registration}${e.icao ? ' · ' + e.icao.toUpperCase() : ''}`);
    return tbl + `<div class="txt">${esc(txt.filter((x, i, a) => x !== '' || (i && a[i - 1] !== '')).join('\n'))}</div>`;
  }
  // ── METAR & pilot reports as cards (from 2026-10-29) ──
  const REP_KCOL_D = { ARS: '#f87171', WXREP: '#2dd4bf', SIGMET: '#c084fc', AIRMET: '#c084fc' };
  const REP_KCOL_L = { ARS: '#b91c1c', WXREP: '#0f766e', SIGMET: '#7e22ce', AIRMET: '#7e22ce' };
  function repHighlight(raw, met) {
    const h = esc(raw);
    return met ? h.replace(/\bWS\s+(ALL\s+RWY|(?:R(?:WY)?\s?\d{2}[LRC]?\s*)+)/g, m => `<b class="wsg">${m.trim()}</b> `)
               : h.replace(/\b((?:FBL|LGT|MOD|SEV|HVY)\s+)?(TURB|ICE|ICG|MTW|LLWS|WS|INVERSION|INV|TSGR|TS|VA|CB)\b/g, m => `<b class="ph">${m}</b>`);
  }
  function drawRep() {
    const all = H.rows;
    const list = H.q ? all.filter(i => normQ(i.raw).includes(H.q)) : all;
    const nMet = all.filter(i => i.met).length, nRep = all.length - nMet;
    $('app-hist-n').textContent = H.q ? `${list.length} / ${all.length}` : `${all.length}`;
    const range = H.rep === 'arch' ? 'WS & near, whole archive' : H.date ? H.date.split('-').reverse().join('.') : `last ${H.hours === 24 ? '24 h' : H.hours + ' h'}`;
    $('app-sub').textContent = H.fetched ? `METAR & reports · ${range} · ${nMet} METAR${nMet === 1 ? '' : 's'} · ${nRep} report${nRep === 1 ? '' : 's'}` : 'Loading…';
    $('app-hist-head').hidden = true;
    const today = isoDay(new Date()), year = new Date().getUTCFullYear();
    const REP_KCOL = document.documentElement.dataset.theme === 'light' ? REP_KCOL_L : REP_KCOL_D;
    $('app-hist-list').innerHTML = list.length ? list.slice(0, 600).map(i => {
      const d = new Date(i.ts * 1000);
      const tm = (isoDay(d) !== today ? `${d.getUTCDate()}.${d.getUTCMonth() + 1}${d.getUTCFullYear() !== year ? '.' + String(d.getUTCFullYear()).slice(2) : ''} ` : '') + hhmm(i.ts);
      const chips = [i.ws ? `<span class="ch lv" style="background:${WS_COL.wsa}">WS ${esc(i.ws === 'ALL' ? 'ALL' : i.ws)}</span>` : '',
                     i.near ? `<span class="ch" style="color:${REP_KCOL.WXREP}">near</span>` : '',
                     i.sub ? `<span class="ch dim">${i.sub}</span>` : ''].join('');
      const r = i.r, extra = r ? [r.ident, r.phen, r.lo_ft != null ? (r.lo_ft === r.hi_ft ? r.lo_ft + ' ft' : `${r.lo_ft}–${r.hi_ft} ft`) : ''].filter(Boolean).join(' · ') : '';
      return `<div class="app-card rep${i.ws || i.near ? ' hit' : ''}"><div class="hd"><span class="l1"><span class="t">${esc(tm)}</span>` +
        `<b style="${REP_KCOL[i.kind] ? 'color:' + REP_KCOL[i.kind] : ''}">${esc(i.kind)}</b><span class="ty">${esc(extra)}</span><span class="chs">${chips}</span></span>` +
        `<span class="rtxt">${repHighlight(i.raw, i.met)}</span></div></div>`;
    }).join('') : `<div class="app-empty">${H.fetched ? (H.q && all.length ? 'No messages match the search.'
        : H.rep === 'arch' ? 'No METAR windshear groups or pilot reports near the airport stored yet.'
        : H.rep === 'ws' ? 'No METAR windshear groups or pilot reports near the airport in this range.'
        : 'No METARs or pilot reports stored in this range.') : 'Loading…'}</div>`;
    markScroll();
  }
  function drawHist() {
    if ($('v-hist').hidden) return;
    if (H.kind === 'rep') return drawRep();
    const dep = H.kind === 'dep', all = H.rows;
    const list = H.q ? all.filter(e => [e.callsign, e.registration, e.aircraft_type, e.icao].some(x => normQ(x).includes(H.q))) : all;
    const what = dep ? 'departure' : 'landing';
    const unit = { hw: 'HW kt', xw: 'XW kt', wind: 'wind kt' }[H.show];
    $('app-hist-n').textContent = (H.q ? `${list.length} / ${all.length}` : `${all.length}`) + (unit ? ` · ${unit}` : '');
    const range = H.date ? H.date.split('-').reverse().join('.') : `last ${H.hours === 24 ? '24 h' : H.hours + ' h'}`;
    $('app-sub').textContent = H.fetched
      ? `${dep ? 'Departures' : 'Landings'} · ${range} · ${all.length} ${what}${all.length === 1 ? '' : 's'}` +
        (H.date ? '' : ` · ${new Date(H.fetched).toISOString().slice(11, 16)} UTC`)
      : 'Loading…';
    const bandsShown = ['hw', 'xw', 'wind'].includes(H.show);
    const bands = H.res === 'hi' ? HB_HI : HB_LO;
    $('app-hist-head').innerHTML = bandsShown
      ? `<span class="strip" style="--n:${bands.length}">` +
        bands.map(b => `<i>${H.res === 'hi' ? (b % 1000 === 0 ? b / 1000 + 'k' : String(b / 100)) : b}</i>`).join('') + '</span>'
      : '';
    $('app-hist-head').hidden = !bandsShown;
    const today = isoDay(new Date());
    $('app-hist-list').innerHTML = list.length ? list.map(e => {
      const k = `${Math.round(e.ts)}|${e.icao}`, open = H.open.has(k);
      const d = new Date(e.ts * 1000), day = isoDay(d);
      const tm = (day !== today && !H.date ? `${d.getUTCDate()}.${d.getUTCMonth() + 1} ` : '') + (e.time_utc || hhmm(e.ts));
      return `<div class="app-card${open ? ' open' : ''}" data-k="${esc(k)}">` +
        `<button type="button" class="hd"><span class="l1"><span class="t">${esc(tm)}</span><b>${esc(e.callsign || e.icao)}</b>` +
        `<span class="ty">${esc(e.aircraft_type || '')}</span><span class="rw">${esc(e.runway || '')}</span><span class="chs">${histChips(e)}</span></span>` +
        `<span class="l2">${histLine2(e)}</span></button>` +
        (open ? `<div class="bd">${histBody(e)}</div>` : '') + '</div>';
    }).join('') : `<div class="app-empty">${H.fetched ? (H.q && all.length ? `No ${what}s match “${esc($('app-hist-q').value)}”.` : `No ${what}s in this range.`) : 'Loading…'}</div>`;
    markScroll();
  }
  $('app-hist-list').addEventListener('click', ev => {
    const hd = ev.target.closest('.hd');
    if (!hd) return;
    const k = hd.parentElement.dataset.k;
    H.open.has(k) ? H.open.delete(k) : H.open.add(k);
    drawHist();
  });
  async function loadHist() {
    const n = ++H.req, dep = H.kind === 'dep';
    if (H.kind === 'rep') {
      const q = H.rep === 'arch' ? 'hours=0&ws=1&near=1&limit=5000'
        : (H.date ? `date=${H.date}` : `hours=${H.hours}`) + (H.rep === 'ws' ? '&ws=1&near=1' : '');
      if (!H.rows.length) { H.fetched = 0; drawHist(); }
      try {
        const d = await (await fetch(`/api/wx/reports?${q}`, { cache: 'no-store' })).json();
        if (n !== H.req) return;
        const items = [];
        for (const m of d.metars || []) items.push({ ts: m.ts, met: true, kind: 'METAR', sub: m.auto ? 'AUTO' : m.cor ? 'COR' : '', raw: m.raw, ws: m.ws });
        for (const r of d.reports || []) items.push({ ts: r.obs_ts || r.ts, met: false, kind: r.kind, raw: r.raw, near: r.near, r });
        H.rows = items.sort((a, b) => b.ts - a.ts); H.wx = d; H.fetched = Date.now();
      } catch (_) { if (n === H.req) $('app-sub').textContent = 'Could not load the reports.'; return; }
      drawHist();
      return;
    }
    const q = H.date ? `date=${H.date}` : `window=${H.hours * 3600}`;
    const url = dep ? `/api/windshear/departures?full=1&${q}` : `/api/windshear/approach-history?lite=1&${q}`;
    if (!H.rows.length) { H.fetched = 0; drawHist(); }
    try {
      const d = await (await fetch(url, { cache: 'no-store' })).json();
      if (n !== H.req) return;
      H.rows = Array.isArray(d) ? d.slice().sort((a, b) => b.ts - a.ts) : [];
      H.fetched = Date.now();
    } catch (_) { if (n === H.req) $('app-sub').textContent = 'Could not load the history.'; return; }
    drawHist();
    loadHistBl();
  }

  // ══ ILS approach ═════════════════════════════════════════════════════════
  const I = { rwy: lsGet('ms_app_ils_rwy', ''), range: lsGet('ms_app_ils_range', '15'),
              barbs: lsGet('ms_app_ils_barbs', 'lo'), comp: lsGet('ms_app_ils_comp', 'hw'),
              lvl: lsGet('ms_ws_alert_lvl', 'wsa'), trails: lsGet('ms_app_ils_trails', 'true') !== 'false',
              ac: [], ev: [], sel: null, manual: false, dots: [], fetched: 0,
              // Show: profile / map / both, aircraft on the map: app / all (from 2026-10-28)
              show: lsGet('ms_app_ils_show', 'both'), mapac: lsGet('ms_app_ils_mapac', 'app'),
              // the chart under the profile / map: off / WS + ACI / WS + EDR (default, from
              // 2026-10-30) and its range 3 / 6 / 12 h (the old WS + ACI setting gives the range)
              wschart: lsGet('ms_app_ils_wschart', 'edr'),
              wsh: lsGet('ms_app_ils_wsh', ['3', '6'].includes(lsGet('ms_app_ils_wsaci', '')) ? lsGet('ms_app_ils_wsaci', '') : '3'),
              // speed vectors on the map: off / 30 / 60 / 120 s (from 2026-10-29)
              vec: lsGet('ms_app_ils_vec', 'off'),
              // departures on the map: hide (default) / show (from 2026-10-29)
              deps: lsGet('ms_app_ils_deps', 'hide'), edrmap: lsGet('ms_app_ils_edrmap', 'off'),
              // the MCP / FCU selected altitude after the altitude: off (default) / on (from 2026-10-30)
              selalt: lsGet('ms_app_ils_selalt', 'off'),
              // the ICAO type after the callsign on the map: off (default) / on (from 2026-10-30)
              actype: lsGet('ms_app_ils_actype', 'off'),
              // the map labels: std (callsign / altitude, as before) or atc — the ATC style's three
              // lines in a small monospaced font (from 2026-10-30): callsign / level, trend and
              // selected level / ground speed in tens of knots and type
              lbl: lsGet('ms_app_ils_lbl', 'std'),
              // the map style: street (CARTO tiles, default) or atc — the radar-display look of
              // the Live Map and the Windshear map (static/js/atc_display.js; from 2026-10-30)
              mapst: lsGet('ms_app_ils_mapst', 'street'),
              // the approach history under the strips: off / 3 / 6 h (default 3) and what its
              // cards show (default edr — the turbulence), as the History view (from 2026-10-30)
              hist: lsGet('ms_app_ils_hist', '3'), hshow: lsGet('ms_app_ils_hshow', 'edr') };
  if (!['', '04L&R', '22L&R', '04L', '04R', '22L', '22R', '15', '33'].includes(I.rwy)) I.rwy = '';
  if (!['15', '7.5'].includes(I.range)) I.range = '15';
  if (!['lo', 'hi', 'off'].includes(I.barbs)) I.barbs = 'lo';
  if (!['hw', 'xw', 'off'].includes(I.comp)) I.comp = 'hw';
  if (!['adv', 'wsa', 'mba', 'off'].includes(I.lvl)) I.lvl = 'wsa';
  if (!['profile', 'map', 'both'].includes(I.show)) I.show = 'both';
  if (!['app', 'all'].includes(I.mapac)) I.mapac = 'app';
  if (!['off', 'aci', 'edr'].includes(I.wschart)) I.wschart = 'edr';
  if (!['3', '6', '12'].includes(I.wsh)) I.wsh = '3';
  if (!['off', '30', '60', '120'].includes(I.vec)) I.vec = 'off';
  if (!['hide', 'show'].includes(I.deps)) I.deps = 'hide';
  if (!['off', '30', '60'].includes(I.edrmap)) I.edrmap = 'off';
  if (!['off', 'on'].includes(I.selalt)) I.selalt = 'off';
  if (!['off', 'on'].includes(I.actype)) I.actype = 'off';
  if (!['std', 'atc'].includes(I.lbl)) I.lbl = 'std';
  if (!['street', 'atc'].includes(I.mapst)) I.mapst = 'street';
  if (!['off', '3', '6'].includes(I.hist)) I.hist = '3';
  if (!['hw', 'xw', 'wind', 'aci', 'ws', 'edr'].includes(I.hshow)) I.hshow = 'edr';
  const ilsCtl = [['app-ils-rwy', 'rwy', 'ms_app_ils_rwy'], ['app-ils-range', 'range', 'ms_app_ils_range'],
                  ['app-ils-barbs', 'barbs', 'ms_app_ils_barbs'], ['app-ils-comp', 'comp', 'ms_app_ils_comp'],
                  ['app-ils-lvl', 'lvl', 'ms_ws_alert_lvl'], ['app-ils-show', 'show', 'ms_app_ils_show'],
                  ['app-ils-mapac', 'mapac', 'ms_app_ils_mapac'], ['app-ils-wschart', 'wschart', 'ms_app_ils_wschart'], ['app-ils-wsh', 'wsh', 'ms_app_ils_wsh'],
                  ['app-ils-vec', 'vec', 'ms_app_ils_vec'], ['app-ils-deps', 'deps', 'ms_app_ils_deps'], ['app-ils-edrmap', 'edrmap', 'ms_app_ils_edrmap'], ['app-ils-selalt', 'selalt', 'ms_app_ils_selalt'], ['app-ils-actype', 'actype', 'ms_app_ils_actype'], ['app-ils-lbl', 'lbl', 'ms_app_ils_lbl'], ['app-ils-mapst', 'mapst', 'ms_app_ils_mapst'],
                  ['app-ils-histopt', 'hist', 'ms_app_ils_hist'], ['app-ils-hshow', 'hshow', 'ms_app_ils_hshow']];
  for (const [id, key, ls] of ilsCtl) {
    $(id).value = I[key];
    $(id).addEventListener('change', e => {
      I[key] = e.target.value; lsSet(ls, I[key]); autoSel(); drawIls();
      if (key === 'show' || key === 'mapac' || key === 'deps') loadIls();   // the map needs positions (map=1 / near=1)
      if (key === 'wschart' || key === 'wsh') { IW.at = 0; loadIlsWs(); }
      if (key === 'edrmap') { IE.at = 0; loadEdrTracks(); }
      if (key === 'mapst' && I.mapst === 'atc' && window.L) loadAtc().then(drawIls).catch(() => {});
      if (key === 'hist') { IHist.at = 0; IHist.open.clear(); loadIlsHist(); }
    });
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
  // ATC-style altitude (from 2026-10-29): up to the transition altitude 5000 ft
  // the altitude on the METAR QNH in hundreds of feet (A023), above it the flight
  // level from the pressure altitude (FL061) — as on a controller's radar label.
  // The transponder reports pressure altitude (1013.25 hPa); without a QNH it is used as it is.
  const ATC_TA_FT = 5000;
  function atcAlt(pa) {
    if (pa == null) return '—';
    const alt = pa - (1013.25 - (wxQnh || 1013.25)) * 27;
    return alt <= ATC_TA_FT ? 'A' + String(Math.max(0, Math.round(alt / 100))).padStart(3, '0')
                            : 'FL' + String(Math.round(pa / 100)).padStart(3, '0');
  }
  // With *Selected altitude* on (from 2026-10-30) the altitude is followed by the altitude selected
  // on the MCP / FCU, when the aircraft has sent it (BDS 4,0 or ADS-B, within 2 min), in the Live
  // Map's form (from 30 Oct 2026 evening; before A023+020): + climbing, - descending (300 ft/min
  // or more), = level; A and the hundreds of feet up to the transition altitude, FL above —
  // A023+A050 = at 2 300 ft, climbing, 5 000 ft selected; FL120-A030 = at FL120, descending,
  // 3 000 ft selected; FL390=FL390 level at the selected FL390.
  function altLbl(a) {
    const base = atcAlt(a.altitude);
    if (I.selalt !== 'on' || a.sel_alt == null || a.altitude == null) return base;
    const vr = a.vert_rate || 0;
    return base + (vr >= 300 ? '+' : vr <= -300 ? '-' : '=') + (a.sel_alt > ATC_TA_FT ? 'FL' : 'A')
      + String(Math.round(a.sel_alt / 100)).padStart(3, '0');
  }
  // The ATC label (Labels on the map: ATC, from 2026-10-30), as the Live Map's and the Windshear
  // map's ATC style with Lbl Full: callsign / level in hundreds of feet (QNH altitude up to the
  // transition altitude, flight level above, without A / FL), ↑ / ↓ at 300 ft/min or more and the
  // selected level (019↑060) / ground speed in tens of knots and the type (19 AT75)
  function atcLines(a) {
    const vr = a.vert_rate, tr = vr == null ? '' : vr >= 300 ? '↑' : vr <= -300 ? '↓' : ' ';
    const sel = a.sel_alt != null ? String(Math.round(a.sel_alt / 100)).padStart(3, '0') : '';
    const l2 = a.landed ? 'landed' : ((a.altitude == null ? '---' : atcAlt(a.altitude).replace(/^(A|FL)/, '')) + tr + sel).trimEnd();
    const gs = a.groundspeed != null ? String(Math.round(a.groundspeed / 10)).padStart(2, '0') : '--';
    const l3 = `${gs} ${a.aircraft_type || ''}`.trimEnd() + (a.dep ? ` ${a.dep_rwy || 'DEP'}↑` : '');
    return [a.callsign || a.icao, l2, l3];
  }
  const shownEv = () => I.lvl === 'off' ? [] : I.ev.filter(e => (LV_RANK[e.lvl] ?? 0) >= LV_RANK[I.lvl] && rwyOk(e.rwy));
  // Auto: the barbs of the lowest aircraft on the approach (the closest to the
  // threshold); a tap on an aircraft follows that one while it is on the approach
  function autoSel() {
    const list = onApp();
    if (I.manual && list.some(a => a.icao === I.sel)) return;
    I.manual = false;
    const live = list.filter(a => !a.landed);           // a landed (fading) one is not followed by Auto
    I.sel = live.length ? live[0].icao : list.length ? list[0].icao : null;
  }
  function selectIls(icao) {
    if (icao) { I.sel = icao; I.manual = true; } else { I.manual = false; autoSel(); }
    drawIls();
  }
  // The point an aircraft reaches after sec seconds at its ground speed (kt) along its
  // track (great circle; the end of a speed vector, from 29 Oct 2026).
  function vecEnd(lat, lon, trackDeg, gsKt, sec) {
    const d = gsKt * sec / 3600 * 1852 / 6371000, br = trackDeg * Math.PI / 180;
    const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
    const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(br));
    const lo2 = lo + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
    return [la2 * 180 / Math.PI, lo2 * 180 / Math.PI];
  }
  // ── the approach map (from 2026-10-28) ──────────────────────────────────
  // The aircraft as on a radar screen: an open square in the colour of the
  // meteo source with callsign and ATC-style altitude (the selected one larger,
  // framed in white; 22R traffic labelled to the left, 22L to the right), the ILS / RNP centrelines, the airport layout and the tracking
  // radius; tiles Dark / Grey with the theme.  A tap on an aircraft on the
  // approach follows it (as on the profile).  Leaflet is loaded the first time
  // the map is shown; the view is remembered (ms_app_ilsMapView), ⌂ = home.
  const IM = { map: null, loading: null, theme: null, tiles: null, ovl: null, ac: null, geo: null, atcLoading: null, atcLines: null,
               lbl: null, items: [], lblStyle: null, lblPos: {}, ilsFeat: null,     // the canvas labels (2026-10-31)
               hist: {} };   // ATC style + Trails: icao → history plots [[lat, lon, ts], …] (2026-10-31)
  const IM_KEY = 'ms_app_ilsMapView', IM_HOME_ZOOM = 9;
  const IM_SRC = { MRAR: '#3b82f6', COMPUTED: '#10b981', MHR: '#f59e0b', JSON: '#a855f7', NONE: '#6b7280' };
  const isLight = () => document.documentElement.dataset.theme === 'light';
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (!IM.loading) {
      const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = APP_LEAFLET_CSS; document.head.appendChild(css);
      IM.loading = new Promise((ok, fail) => {
        const sc = document.createElement('script'); sc.src = APP_LEAFLET_JS; sc.onload = ok;
        sc.onerror = () => { IM.loading = null; fail(); }; document.head.appendChild(sc);
      });
    }
    return IM.loading;
  }
  // the shared ATC display code (static/js/atc_display.js), loaded after Leaflet the
  // first time the ATC map style is used (from 2026-10-30)
  const atcReady = () => typeof AtcDisplay !== 'undefined';
  function loadAtc() {
    if (atcReady()) return Promise.resolve();
    if (!IM.atcLoading) {
      IM.atcLoading = new Promise((ok, fail) => {
        const sc = document.createElement('script'); sc.src = APP_ATC_JS; sc.onload = ok;
        sc.onerror = () => { IM.atcLoading = null; fail(); }; document.head.appendChild(sc);
      });
    }
    return IM.atcLoading;
  }
  const imAtc = () => I.mapst === 'atc' && atcReady();
  function imSavedView() {
    try {
      const v = JSON.parse(lsGet(IM_KEY, 'null'));
      if (v && Number.isFinite(v.lat) && Number.isFinite(v.lon) && Number.isFinite(v.z)
          && Math.abs(v.lat) <= 85 && Math.abs(v.lon) <= 180 && v.z >= 5 && v.z <= 16) return v;
    } catch (_) { /* broken value: the default view */ }
    return null;
  }
  function initIlsMap() {
    if (IM.map || !window.L) return;
    const sv = imSavedView();
    const m = L.map('app-ils-map', { zoomControl: true, attributionControl: true })
               .setView(sv ? [sv.lat, sv.lon] : [WS_AIRPORT_LAT, WS_AIRPORT_LON], sv ? sv.z : IM_HOME_ZOOM);
    m.attributionControl.setPrefix(false);
    m.on('moveend', () => {
      if (!m.getSize().x) return;
      const c = m.getCenter();
      lsSet(IM_KEY, JSON.stringify({ lat: +c.lat.toFixed(4), lon: +c.lng.toFixed(4), z: m.getZoom() }));
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
        L.DomEvent.on(a, 'click', e => { L.DomEvent.preventDefault(e); m.setView([WS_AIRPORT_LAT, WS_AIRPORT_LON], IM_HOME_ZOOM); });
        return box;
      },
    });
    new Home().addTo(m);
    IM.map = m; IM.ovl = L.layerGroup().addTo(m); IM.ac = L.layerGroup().addTo(m);
    Promise.all(['efhk_ils.geojson', 'efhk_apt.geojson'].map(f => fetch('/overlays/' + f).then(r => r.ok ? r.json() : null).catch(() => null)))
      .then(([ils, apt]) => { IM.geo = { ils, apt }; IM.ilsFeat = ils ? (ils.features || []).filter(f => f.properties && f.properties.airport === 'EFHK') : null;
                              IM.theme = null; drawIlsMap(); });
  }
  // tiles and overlays in the colours of the theme (the Windshear page's Dark / Grey)
  // Map style ATC (from 2026-10-30): no tiles but the ATC background (dark grey in the
  // dark theme, light grey in the light one) with the coastline, the airport layout and
  // the ILS / RNP finals of AtcDisplay.mapLines — the same as the Live Map and the
  // Windshear map; no tracking radius and no airport marker
  function imTheme() {
    const light = isLight(), atc = imAtc(), t = (light ? 'light' : 'dark') + (atc ? '-atc' : '');
    if (IM.theme === t) return;
    IM.theme = t;
    if (IM.tiles) { IM.map.removeLayer(IM.tiles); IM.tiles = null; }
    IM.ovl.clearLayers();
    const el = IM.map.getContainer();
    if (atc) {
      el.style.background = AtcDisplay.pal().bg;
      if (!IM.atcLines) IM.atcLines = AtcDisplay.mapLines(IM.map);
      IM.atcLines.show(true);                       // drawn again in the theme's colours
      return;
    }
    el.style.background = '';
    if (IM.atcLines) IM.atcLines.show(false);
    const key = CARTO_API_KEY ? `?key=${encodeURIComponent(CARTO_API_KEY)}` : '';
    IM.tiles = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${light ? 'light_all' : 'dark_all'}/{z}/{x}/{y}{r}.png${key}`,
      { attribution: '© OSM © CARTO', subdomains: 'abcd', maxZoom: 16 }).addTo(IM.map);
    const g = IM.geo || {};
    if (g.apt) L.geoJSON(g.apt, { interactive: false, style: { color: light ? '#475569' : '#94a3b8', weight: 1, opacity: light ? 0.5 : 0.5, fillOpacity: 0 } }).addTo(IM.ovl);
    if (g.ils) L.geoJSON({ type: 'FeatureCollection', features: (g.ils.features || []).filter(f => f.properties && f.properties.airport === 'EFHK') }, {
      interactive: false,
      style: f => f.properties?.approach_type === 'RNP'
        ? { color: light ? '#a8a29e' : '#f59e0b', weight: 1.5, opacity: 0.7, dashArray: '10 5', fillOpacity: 0 }
        : { color: light ? '#64748b' : '#38bdf8', weight: 1.5, opacity: light ? 0.7 : 0.6, dashArray: '6 5', fillOpacity: 0 } }).addTo(IM.ovl);
    L.circle([WS_AIRPORT_LAT, WS_AIRPORT_LON], { interactive: false, radius: WS_RADIUS_NM * 1852, color: light ? '#94a3b8' : '#334155',
      weight: 1, fill: false, dashArray: '4 6' }).addTo(IM.ovl);
    L.circleMarker([WS_AIRPORT_LAT, WS_AIRPORT_LON], { interactive: false, radius: 5, color: '#fff', fillColor: '#1d4ed8', fillOpacity: 1, weight: 2 }).addTo(IM.ovl);
  }
  // Boundary layer line under the aircraft (from 2026-10-29; always shown): the
  // low-level jet and the surface inversion of the last hour (/api/boundary,
  // fetched at most every 5 min while the ILS view is open) as chips, grey text
  // when there is neither, "no recent flights" without data.
  const IB = { rec: null, at: 0 };
  async function loadBlNow() {
    if (Date.now() - IB.at < 300000) return;
    IB.at = Date.now();
    try {
      const d = await (await fetch('/api/boundary?hours=2', { cache: 'no-store' })).json();
      const rows = Array.isArray(d) ? d.filter(r => (r.w && r.w.length >= 5) || (r.t && r.t.length >= 3)) : [];
      // the hour in progress once it has enough data, else the last full hour
      IB.rec = rows.length ? rows[rows.length - 1] : null;
    } catch (_) { IB.at = 0; return; }
    drawBlLine();
  }
  function drawBlLine() {
    const el = $('app-ils-bl');
    if (!el) return;
    const r = IB.rec, red = isLight() ? '#b91c1c' : '#f87171';
    if (!r) { el.innerHTML = `<b>Boundary layer</b> · <span class="dim">${IB.at ? 'no recent flights' : 'loading…'}</span>`; return; }
    el.innerHTML = `<b>Boundary layer</b>, ${r.partial ? 'this hour' : 'last hour'} · ` +
      (r.llj ? `<span class="app-bl-chip" title="low-level jet: ${r.llj.drop} m/s weaker within 1500 ft above">LLJ ${r.llj.ft} ft · ${r.llj.kt} kt ${String(r.llj.dir).padStart(3, '0')}°</span> `
             : '<span class="dim">no jet</span> · ') +
      (r.inv ? `<span class="app-bl-chip" style="color:${red};border-color:${red}" title="600–1000 ft against the METAR ${r.tt} °C">surface INV +${Math.round(r.inv.dT)} K</span> `
             : (r.tt != null && r.t && r.t.length ? '<span class="dim">no inversion</span> ' : '<span class="dim">temperature: too few flights</span> ')) +
      '<span class="ws-research-tag">research</span>';
  }
  // EDR pieces of the map, fetched at most once a minute while the option is on
  const IE = { tracks: [], at: 0, min: 0 };
  async function loadEdrTracks() {
    const min = I.edrmap === 'off' ? 0 : parseInt(I.edrmap, 10) || 0;
    if (!min || (Date.now() - IE.at < 60000 && IE.min === min)) return;
    IE.at = Date.now(); IE.min = min;
    try {
      const d = await (await fetch(`/api/windshear/edr-tracks?minutes=${min}`, { cache: 'no-store' })).json();
      IE.tracks = Array.isArray(d) ? d : [];
    } catch (_) { IE.at = 0; return; }
    drawIls();
  }
  function drawIlsMap() {
    if (!IM.map) return;
    imTheme();
    IM.ac.clearLayers();
    const light = isLight();
    // the ATC map style (from 2026-10-30): monochrome as on the Live Map and the Windshear
    // map — below 6 000 ft light, above grey, landed grey; the followed aircraft not marked
    const atc = imAtc(), AP = atc ? AtcDisplay.pal() : null;
    // Turbulence on the map (from 2026-10-29; RESEARCH, option Off / 30 min / 1 h): the
    // straight 2-km pieces of the paths of the landings and departures of the period
    // coloured by their EDR (collector/edr.py, /api/windshear/edr-tracks), the strongest
    // drawn last so that the colour shows the worst piece; and a summary line
    const EMIN = I.edrmap === 'off' ? 0 : parseInt(I.edrmap, 10) || 0;
    // departures only when *Departures on the map: Shown* (from 2026-10-30)
    const ET = EMIN ? IE.tracks.filter(t => Date.now() / 1000 - t.ts < EMIN * 60 && (t.ph !== 'dep' || I.deps === 'show')) : [];
    const ecol = v => v >= 0.45 ? '#ef4444' : v >= 0.20 ? '#fb923c' : v >= 0.10 ? '#facc15' : (light ? '#059669' : '#34d399');
    // the strongest on top: the colour shows the worst piece of the period
    const SG = []; for (const t of ET) for (const g of t.seg) if (g.p.length > 1) SG.push(g);
    SG.sort((x, y) => x.e - y.e);
    // thin lines (from 2026-10-30; were 5 px on an 8-px halo) so that the aircraft and
    // their labels stay readable over them
    for (const g of SG) {
      L.polyline(g.p, { interactive: false, color: atc ? AP.bg : light ? '#ffffff' : '#0b1220', weight: 4, opacity: 0.6 }).addTo(IM.ac);
      L.polyline(g.p, { interactive: false, color: ecol(g.e), weight: 2.5, opacity: 0.9 }).addTo(IM.ac);
    }
    const el = $('app-ils-edr');
    if (el) el.hidden = !EMIN;
    if (el && EMIN) {
      let mx = null, n = 0, nd = 0; const lay = { lo: [], hi: [] };
      for (const t of ET) { if (t.ph === 'dep') nd++; else n++; for (const g of t.seg) { const h = (g.a[0] + g.a[1]) / 2 - WS_THR_ELEVATION_FT; (h < 1000 ? lay.lo : lay.hi).push(g.e);
        if (!mx || g.e > mx.e) mx = { e: g.e, h: Math.round(h / 100) * 100, cs: t.cs, rwy: t.rwy }; } }
      const nm = v => v >= 0.45 ? 'severe' : v >= 0.20 ? 'moderate' : v >= 0.10 ? 'light' : 'smooth';
      const md = a => { a = a.slice().sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
      el.innerHTML = mx ? `<b>Turbulence (EDR), last ${EMIN} min</b> · ${n} landings${I.deps === 'show' ? `, ${nd} departures` : ''} · max <b style="color:${ecol(mx.e)}">${mx.e.toFixed(2)} ${nm(mx.e)}</b> at ${mx.h} ft (${esc(mx.cs || '')} ${esc(mx.rwy || '')})` +
        ` · median below 1000 ft ${md(lay.lo) != null ? md(lay.lo).toFixed(2) : '—'}, 1000–3000 ft ${md(lay.hi) != null ? md(lay.hi).toFixed(2) : '—'} <span class="ws-research-tag">research</span>`
        : `Turbulence (EDR): no flights in the last ${EMIN} min`;
    }
    const atcL  = I.lbl === 'atc';                                   // the ATC labels (from 2026-10-30)
    const dense = atcL || I.actype === 'on' || I.selalt === 'on';    // longer labels (from 2026-10-30)
    // the labels (from 2026-10-31): on a canvas with leader lines, placed apart from each
    // other, the squares, the speed vectors, the trails and the approach lines
    // (AtcDisplay.drawLabels, as the Live Map and the Windshear map); before, beside the
    // square at a fixed place — on 04L / 04R straight ahead, over the approach line
    const items = [];
    const lblCol = (onA, a) => atc ? null : (onA && !a.landed ? (light ? '#0b1220' : '#f8fafc') : (light ? '#334155' : '#cbd5e1'));
    for (const a of I.ac) {
      if (a.lat == null || a.lon == null) continue;
      const onA = a.in_corridor && a.dist_thr_nm != null && rwyOk(a.approach_runway);
      if (!onA) {
        if (a.in_corridor) continue;                                 // another runway's approach: not shown
        if (a.dep) { if (I.deps !== 'show') continue; }               // a departure: only when chosen (2026-10-29)
        else if (I.mapac !== 'all') continue;
      }
      const sel = onA && a.icao === I.sel && I.barbs !== 'off';
      const selM = sel && !atc;                                      // the followed aircraft marked (not in ATC)
      const ac0 = atc ? (a.landed ? AP.high : AtcDisplay.symColor(a)) : null;   // its ATC colour
      if (onA && I.trails && !atc && Array.isArray(a.trail) && a.trail.length > 1)     // ATC style: plots (below)
        L.polyline(a.trail, { interactive: false, color: atc ? ac0 : light ? '#334155' : '#cbd5e1', weight: 1.5, opacity: atc ? 0.45 : 0.6 }).addTo(IM.ac);
      // the square: 12 px selected, 9 px on the approach, 7 px others (smaller from 28 Oct 2026 evening);
      // drawn in a 24-px icon so that it stays easy to tap
      // a landed aircraft (no new position for 15 s near the threshold): grey, "landed" (from 2026-10-29)
      // An open square as on a radar screen (from 2026-10-29): framed in the colour of the meteo
      // source, the selected one in white (dark theme) / near-black (light theme, white would vanish
      // on the light tiles); 10 px on the approach (also the selected one, with a thin frame — from
      // 2026-10-30, was 12 px with a heavy frame), 8 px others, in a 24-px tap area
      // with the type and / or the selected altitude in the labels (from 2026-10-30) smaller
      // squares (8 / 6 px) and a smaller label font, so the longer labels fit
      const c = atc ? ac0 : a.landed ? '#94a3b8' : IM_SRC[a.meteo_source] || IM_SRC.NONE, H = 24;
      const s = dense ? (sel || onA ? 8 : 6) : (sel || onA ? 10 : 8), o = (H - s) / 2;
      // speed vector (from 2026-10-29): to where the aircraft will be after 30 s / 1 / 2 min at its
      // ground speed along its track, in map distance; not for a landed aircraft
      const vEnd = I.vec !== 'off' && !a.landed && a.groundspeed > 30 && a.track != null
        ? vecEnd(a.lat, a.lon, a.track, a.groundspeed, +I.vec) : null;
      if (vEnd)
        L.polyline([[a.lat, a.lon], vEnd], { interactive: false,
          color: selM ? (light ? '#0f172a' : '#fff') : c, weight: 1.6, opacity: onA ? 0.95 : 0.6 }).addTo(IM.ac);
      const icon = L.divIcon({ className: '', iconSize: [H, H], iconAnchor: [H / 2, H / 2],
        html: `<svg width="${H}" height="${H}" viewBox="0 0 ${H} ${H}" aria-hidden="true"><rect x="${o}" y="${o}" width="${s}" height="${s}" rx="1" fill="none"` +
              ` stroke="${selM ? (light ? '#0f172a' : '#fff') : c}" stroke-opacity="${onA ? 1 : 0.65}" stroke-width="${selM ? 1.6 : onA ? 2 : 1.5}"/></svg>` });
      const mk = L.marker([a.lat, a.lon], { icon, zIndexOffset: sel ? 300 : onA ? 100 : 0, keyboard: false }).addTo(IM.ac);
      if (onA) mk.on('click', () => selectIls(a.icao));
      const alt = a.altitude == null ? '' : altLbl(a);
      const lines = atcL ? atcLines(a)
        : [(a.callsign || a.icao) + (I.actype === 'on' && a.aircraft_type ? ' ' + a.aircraft_type : ''),
           (alt + (a.landed ? ' · landed' : '') + (a.dep ? ` · ${a.dep_rwy || 'DEP'}↑` : '')).replace(/^ · /, '')].filter(Boolean);
      items.push({ key: a.icao, lat: a.lat, lon: a.lon, lines, sel, vec: vEnd,
                   trail: onA && I.trails && !atc && Array.isArray(a.trail) ? a.trail : null, ts: a.last_seen,
                   col: atc ? c : lblCol(onA, a), fade: atc && !(onA && !a.landed) ? 0.75 : 1,
                   alt: (a.altitude ?? 99999) - (onA ? 100000 : 0) });     // the approach traffic placed first
    }
    // the label style: ATC three monospaced lines, or the callsign and the level in a
    // sans-serif; on the street map with an outline (dark theme) / a light one (light theme)
    const fs = atcL ? 9 : dense ? 9 : 10.5;
    IM.items = items;
    IM.lblStyle = { fs, opt: {
      font: atcL ? `500 ${fs}px ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace`
                 : `600 ${fs}px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`,
      lh: Math.round(fs * (atcL ? 1.14 : 1.2)),
      halo: atc ? null : light ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.8)',
      leader: atc ? null : light ? '#64748b' : '#94a3b8' }, plots: atc && I.trails };
    if (atcReady() && !IM.lbl) IM.lbl = AtcDisplay.canvasLayer(IM.map, drawIlsLabels);
    if (IM.lbl) IM.lbl.redraw();
  }
  // the labels of drawIlsMap's items, at every draw of the canvas (also while the map moves)
  function drawIlsLabels(g, m, W, H) {
    const items = IM.items || [];
    if (!items.length || !IM.lblStyle) return;
    g.globalAlpha = 1;
    const obst = AtcDisplay.domObstacles(m, '.leaflet-control-zoom, .ms-map-home, .leaflet-control-attribution');
    if (IM.ilsFeat) obst.push(...AtcDisplay.lineObstacles(m, IM.ilsFeat, W, H));
    const lbls = [];
    for (const it of items) {
      const p = m.latLngToContainerPoint([it.lat, it.lon]);
      if (p.x < -200 || p.y < -200 || p.x > W + 200 || p.y > H + 200) continue;
      if (it.vec) {                                  // the speed vector's line
        const pe = m.latLngToContainerPoint(it.vec), dx = pe.x - p.x, dy = pe.y - p.y, L0 = Math.hypot(dx, dy);
        for (let d = 8; d < L0; d += 8) obst.push({ x: p.x + dx * d / L0 - 2, y: p.y + dy * d / L0 - 2, w: 4, h: 4 });
      }
      if (it.trail) for (const q of it.trail) { const t = m.latLngToContainerPoint(q); obst.push({ x: t.x - 2, y: t.y - 2, w: 4, h: 4 }); }
      // ATC style + Trails: the last 5 history plots (not the current position), as on the big maps
      if (IM.lblStyle.plots) {
        const pts = (IM.hist[it.key] || []).filter(q => it.ts == null || q[2] < it.ts - 0.5).slice(-5);
        if (pts.length) AtcDisplay.drawPlots(g, m, pts, 5, it.col, it.fade, obst);
      }
      lbls.push({ key: it.key, p, lines: it.lines, col: it.col, sel: it.sel, fade: it.fade, alt: it.alt });
    }
    AtcDisplay.drawLabels(g, lbls, W, H, obst, IM.lblPos, IM.lblStyle.fs, IM.lblStyle.opt);
    g.globalAlpha = 1;
  }
  // ── Chart under the profile or the map (from 2026-10-29) ─────────────────
  // The chart of the ACI · WS · ST view (ws_cond_chart.js): from 2026-10-30
  // WS + EDR (turbulence over windshear, the default — on) or WS + ACI, for the
  // last 3, 6 or 12 h; its landings and departures are fetched at most once a
  // minute while the ILS view is open.
  const IW = { aph: [], dep: [], wx: null, fetched: 0, at: 0, hours: 3, dots: [] };
  async function loadIlsWs() {
    if (I.wschart === 'off' || Date.now() - IW.at < 60000) return;
    IW.at = Date.now();
    const hours = parseInt(I.wsh, 10) || 3, win = hours * 3600;
    try {
      const [aph, dep, wx] = await Promise.all([
        fetch(`/api/windshear/approach-history?lite=1&window=${win}`, { cache: 'no-store' }).then(r => r.json()),
        fetch(`/api/windshear/departures?window=${win}`, { cache: 'no-store' }).then(r => r.json()),
        fetch(`/api/wx/reports?hours=${hours + 1}&ws=1&near=1`, { cache: 'no-store' }).then(r => r.json()).catch(() => null)]);
      IW.aph = Array.isArray(aph) ? aph : []; IW.dep = Array.isArray(dep) ? dep : []; IW.wx = wx;
      IW.hours = hours; IW.fetched = Date.now();
    } catch (_) { IW.at = 0; return; }
    drawIls();
  }
  function drawIlsWs(W) {
    const box = $('app-ils-ws');
    box.hidden = I.wschart === 'off';
    if (box.hidden || !IW.fetched) return;
    const cv = $('app-ils-wscv'), H = Math.round(Math.max(200, W * 0.62)), dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ro = document.createElement('div');                       // the chart's own read-out, shortened below
    IW.dots = WsCondChart.draw(ctx, W, H, ro, { aph: IW.aph, dep: IW.dep, ga: [], hours: IW.hours, fetchedMs: IW.fetched,
      parts: I.wschart === 'aci' ? ['aci', 'ws'] : ['edr', 'ws'],
      met: IW.wx ? IW.wx.metars : [], rep: IW.wx ? IW.wx.reports : [] });
    const parts = ro.innerHTML.split('<br>').map(t => t.trim());                 // its own lines (ws_cond_chart.js)
    $('app-ils-wsro').innerHTML = [parts.find(t => t.startsWith('Last') || t.startsWith('EDR')), parts.find(t => t.startsWith('WS ')),
      parts.find(t => t.startsWith('<span style='))].filter(Boolean).join(' · ');   // + METAR WS / pilot reports
  }
  $('app-ils-wscv').addEventListener('pointerdown', e => {
    const r = $('app-ils-wscv').getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = 18 * 18;
    for (const d of IW.dots || []) { const dd = (d.x - x) ** 2 + (d.y - y) ** 2; if (dd < bd) { bd = dd; best = d; } }
    $('app-ils-wspick').textContent = best ? best.label : 'Tap a dot for the landing.';
  });
  function drawIls() {
    drawBlLine();
    const v = $('v-ils');
    if (v.hidden) return;
    const cv = $('app-ils'), box = $('app-ils-box');
    const portrait = v.clientHeight >= v.clientWidth;
    const showMap = I.show !== 'profile', showProf = I.show !== 'map';
    const side = !portrait && I.show === 'both';
    const full = Math.max(280, v.clientWidth - 8);
    $('app-ils-wrap').classList.toggle('side', side);
    $('app-ils-mapbox').hidden = !showMap; box.hidden = !showProf;
    if (showMap) {
      const mb = $('app-ils-mapbox');
      mb.style.width = (side ? Math.round(full * 0.45) : full) + 'px';
      mb.style.height = (!portrait ? Math.max(230, v.clientHeight - 64)
        : I.show === 'map' ? Math.round(Math.max(300, v.clientHeight * 0.58))     // room for the strips (2026-10-29)
        : Math.round(Math.max(220, v.clientHeight * 0.40))) + 'px';
      if (IM.map) { IM.map.invalidateSize(); drawIlsMap(); }
      else loadLeaflet().then(() => loadAtc().catch(() => {}))      // the labels use it in every map style (2026-10-31)
                        .then(() => { initIlsMap(); drawIlsMap(); }).catch(() => {
        $('app-ils-map').textContent = 'The map could not be loaded.'; });
    }
    drawIlsWs(full);
    if (!showProf) { ilsInfo(); markScroll(); return; }
    const W = side ? full - Math.round(full * 0.45) - 6 : full;
    const H = portrait ? (I.show === 'both' ? Math.round(Math.max(190, v.clientHeight * 0.26))
                                            : Math.round(Math.max(260, Math.min(W * 1.3, v.clientHeight - 200))))
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
    const wsOf = icao => evs.filter(e => e.icao === icao).sort((a, b) => LV_RANK[b.lvl] - LV_RANK[a.lvl])[0];
    const selWs = sel && wsOf(sel.icao);
    if (I.barbs === 'off' || !sel) {
      pick.innerHTML = `<span class="txt">${list.length ? 'Tap an aircraft or a strip for its wind barbs.' : 'No aircraft on the approach' + (I.rwy ? ' to ' + esc(I.rwy) : '') + '.'}</span>`;
    } else {
      pick.innerHTML = `<span class="txt"><b>${esc(sel.callsign || sel.icao)}</b> ${esc(sel.aircraft_type || '')} · RWY ${esc(sel.approach_runway || '?')} · ` +
        `${sel.dist_thr_nm != null ? sel.dist_thr_nm.toFixed(1) : '—'} NM · ${altLbl(sel)} · ` +
        `wind ${fmtWind(sel.best_wind_spd, sel.best_wind_dir)}${hwTxt(hw(sel))} · ${I.manual ? 'chosen' : 'auto: lowest'}` +
        (selWs && selWs.msg ? ` · <b>⚠ ${esc(selWs.msg)}</b> <small>(research)</small>` : '') + `</span>` +
        (I.manual ? '<button type="button" class="app-btn" id="app-ils-auto">Auto</button>' : '');
      const b = $('app-ils-auto');
      if (b) b.addEventListener('click', () => selectIls(null));
    }
    const WSC = { adv: '#3b82f6', wsa: '#d97706', mba: '#ef4444' };
    $('app-ils-list').innerHTML = list.length ? list.map(a => {
      const gs = IlsProfile.gsStatus(a, base), w = wsOf(a.icao);
      const vs = a.vert_rate != null ? `${a.vert_rate > 0 ? '+' : ''}${Math.round(a.vert_rate / 10) * 10} fpm` : '';
      return `<button type="button" class="app-strip${a.icao === I.sel && I.barbs !== 'off' ? ' sel' : ''}${a.landed ? ' landed' : ''}" data-icao="${esc(a.icao)}"` +
             ` style="--src:${ILS_SRC[a.meteo_source] || 'var(--border)'}">` +
             `<span class="rwy">${esc(a.approach_runway || '?')}</span><span class="cs">${esc(a.callsign || a.icao)}${a.ap ? ' <small>AP</small>' : ''}</span>` +
             `<span class="badges">${w ? `<span class="ws" style="background:${WSC[w.lvl]}"${w.msg ? ` title="${esc(w.msg + (w.say ? ' · ' + w.say : '') + ' (research)')}"` : ''}>${w.lvl.toUpperCase()}</span>` : ''}<span class="gs" style="color:${a.landed ? 'var(--text-3)' : pal[gs]}">${a.landed ? 'LANDED?' : gs}</span></span>` +
             `<span class="row">${esc(a.aircraft_type || '—')} · ${a.dist_thr_nm.toFixed(1)} NM · ${altLbl(a)}${vs ? ' · ' + vs : ''}</span>` +
             `<span class="row">${a.landed ? `no new position for ${a.landed} s` : `wind ${fmtWind(a.best_wind_spd, a.best_wind_dir)}${hwTxt(hw(a))}`}</span></button>`;
    }).join('') : '';
    drawIlsHist();
    // ICAO-style messages ("15A WSA 15K+ 2MF", from 28 Oct 2026) — research, not operational
    const alert = evs.length ? ' · ⚠ ' + [...new Set(evs.map(e => e.msg || `${e.lvl.toUpperCase()} ${e.rwy}`))].join(', ') + ' (research)' : '';
    $('app-sub').textContent = I.fetched
      ? `${list.length} on approach · QNH ${wxQnh != null ? Math.round(wxQnh) : '—'}${alert} · ${new Date(I.fetched).toISOString().slice(11, 19)} UTC`
      : 'Loading…';
  }
  // ── Approach history under the strips (from 2026-10-30) ─────────────────
  // The History view's cards (histChips / histLine2 / histBody with the ILS view's
  // settings: landings, I.hshow, Lo bands) of the landings of the last 3 or 6 h of
  // the runways chosen; fetched at most once a minute while the ILS view is open,
  // the boundary layer of those hours (for the opened cards) every 10 min.
  const IHist = { rows: [], at: 0, hours: 0, fetched: 0, open: new Set(), blAt: 0 };
  async function loadIlsHist() {
    const h = parseInt(I.hist, 10) || 0;
    if (!h || (Date.now() - IHist.at < 60000 && IHist.hours === h)) return;
    IHist.at = Date.now();
    try {
      const d = await (await fetch(`/api/windshear/approach-history?lite=1&window=${h * 3600}`, { cache: 'no-store' })).json();
      IHist.rows = Array.isArray(d) ? d.slice().sort((a, b) => b.ts - a.ts) : [];
      IHist.hours = h; IHist.fetched = Date.now();
    } catch (_) { IHist.at = 0; return; }
    drawIlsHist();
    if (Date.now() - IHist.blAt > 600000) {
      IHist.blAt = Date.now();
      try {
        const b = await (await fetch(`/api/boundary?hours=${h + 1}`, { cache: 'no-store' })).json();
        for (const r of Array.isArray(b) ? b : []) if (!r.partial) HB.map.set(r.ts, r);
      } catch (_) { IHist.blAt = 0; }
    }
  }
  function drawIlsHist() {
    const box = $('app-ils-hist');
    const h = parseInt(I.hist, 10) || 0;
    box.hidden = !h;
    if (!h) return;
    const S = { kind: 'arr', show: I.hshow, res: 'lo' };
    const list = IHist.rows.filter(e => !I.rwy || rwyOk(e.runway));
    const what = { edr: 'turbulence (EDR, research)', hw: 'headwind kt', xw: 'crosswind kt', wind: 'wind kt', aci: 'approach conditions', ws: 'windshear' }[S.show];
    $('app-ils-histhd').innerHTML = `<b>Approach history</b> · last ${h} h${I.rwy ? ' · ' + esc(I.rwy) : ''} · ` +
      (IHist.fetched && IHist.hours === h ? `${list.length} landing${list.length === 1 ? '' : 's'} · ${what}` : 'loading…');
    const bandsShown = ['hw', 'xw', 'wind'].includes(S.show);
    $('app-ils-histband').innerHTML = bandsShown
      ? `<span class="strip" style="--n:${HB_LO.length}">` + HB_LO.map(b => `<i>${b}</i>`).join('') + '</span>' : '';
    $('app-ils-histband').hidden = !bandsShown || !list.length;
    const today = isoDay(new Date());
    $('app-ils-histlist').innerHTML = list.map(e => {
      const k = `${Math.round(e.ts)}|${e.icao}`, open = IHist.open.has(k);
      const d = new Date(e.ts * 1000);
      const tm = (isoDay(d) !== today ? `${d.getUTCDate()}.${d.getUTCMonth() + 1} ` : '') + (e.time_utc || hhmm(e.ts));
      return `<div class="app-card${open ? ' open' : ''}" data-k="${esc(k)}">` +
        `<button type="button" class="hd"><span class="l1"><span class="t">${esc(tm)}</span><b>${esc(e.callsign || e.icao)}</b>` +
        `<span class="ty">${esc(e.aircraft_type || '')}</span><span class="rw">${esc(e.runway || '')}</span><span class="chs">${histChips(e, S)}</span></span>` +
        `<span class="l2">${histLine2(e, S)}</span></button>` +
        (open ? `<div class="bd">${histBody(e, S)}</div>` : '') + '</div>';
    }).join('') || (IHist.fetched ? `<div class="app-empty">No landings${I.rwy ? ' on ' + esc(I.rwy) : ''} in the last ${h} h.</div>` : '');
  }
  $('app-ils-histlist').addEventListener('click', ev => {
    const hd = ev.target.closest('.hd');
    if (!hd) return;
    const k = hd.parentElement.dataset.k;
    IHist.open.has(k) ? IHist.open.delete(k) : IHist.open.add(k);
    drawIlsHist(); markScroll();
  });
  // History plots of the ATC map style (from 2026-10-31): a position of every aircraft
  // on the map at most every 5 s (AtcDisplay.addTrail, from each poll); an aircraft on
  // the approach starts with the last points of its server trail (2 min), so its dots
  // show at once
  function ilsHistAdd() {
    if (!atcReady()) return;
    const keep = new Set(), now = Date.now() / 1000;
    for (const a of I.ac) {
      if (a.lat == null || a.lon == null) continue;
      keep.add(a.icao);
      const t = IM.hist[a.icao] || (IM.hist[a.icao] = []), ts = a.last_seen || now;
      if (!t.length && Array.isArray(a.trail) && a.trail.length > 2) {
        const tr = a.trail.slice(-6, -1);                      // about every 6 s, oldest first
        tr.forEach((q, k) => t.push([q[0], q[1], ts - (tr.length - k) * 6]));
      }
      AtcDisplay.addTrail(t, a.lat, a.lon, ts);
    }
    for (const k of Object.keys(IM.hist)) if (!keep.has(k)) delete IM.hist[k];
  }
  async function loadIls() {
    try {
      // All tracked (from 2026-10-31): every aircraft within 30 NM at any level; Departures
      // alone: those within the windshear radius below its ceiling (15 NM, 5 000 ft)
      const q = I.show === 'profile' ? '' : I.mapac === 'all' ? '&map=1&near=1&nm=30&alt=all'
              : I.deps === 'show' ? '&map=1&near=1' : '&map=1';
      const st = await (await fetch('/api/windshear/state?lite=1' + q, { cache: 'no-store' })).json();
      I.ac = IlsProfile.landedFilter(st && !Array.isArray(st) ? st.aircraft || [] : Array.isArray(st) ? st : []);
      ilsHistAdd();
      I.ev = st && !Array.isArray(st) ? st.ws_events || [] : [];
      I.fetched = Date.now();
      autoSel();
      drawIls();
      if (I.wschart !== 'off') loadIlsWs();
      if (I.edrmap !== 'off') loadEdrTracks();
      loadBlNow();
      if (I.hist !== 'off') loadIlsHist();
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
    else if (view === 'hist') drawHist();
    else if (view === 'stats' && window.MsStats) window.MsStats.redraw();
    else if (view === 'wx' && window.AppWx && window.AppWx.ready()) window.AppWx.layout();
    markScroll();
  }
  function refresh() {
    if (document.hidden) return;
    if (view === 'skewt-now') { loadNow(); }
    else if (view === 'th') loadTh();
    else if (view === 'ils') loadIls();
    else if (view === 'aci') loadAci();
    else if (view === 'hist' && !H.date) loadHist();
    else if (view === 'wx' && window.AppWx && window.AppWx.ready()) window.AppWx.refresh();
  }
  function startTimer() {
    clearInterval(timer);
    const every = { 'skewt-now': 120e3, 'skewt-hour': 0, th: 600e3, ils: 5e3, aci: 60e3,
                    hist: H.date ? 0 : 60e3, stats: 0, wx: 6e3 }[view];   // wx: the air traffic (and the index every 10 min)          // stats.js polls itself (30 s)
    if (every) timer = setInterval(refresh, every);
  }
  function setView(v, fromMenu) {
    view = VIEWS[v] ? v : 'skewt-now';
    if (view !== 'stats' && window.MsStats) window.MsStats.stop();
    if (view !== 'wx' && window.AppWx && window.AppWx.ready()) window.AppWx.hide();
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
    else if (view === 'hist') loadHist();
    else if (view === 'stats') openStats();
    else if (view === 'wx') openWx();
    startTimer();
    if (fromMenu) setTimeout(() => menu(false), 150);
  }
  document.querySelectorAll('.app-tile').forEach(t => t.addEventListener('click', () => setView(t.dataset.view, true)));

  let rt = null;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => layout(), 120); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { refresh(); pollHealth(); fetchWx(); }
  });

  // ══ Statistics (from 2026-10-28) ═════════════════════════════════════════
  // The Statistics page's panels (stats.js, reused) in one column.  Chart.js and
  // stats.js are loaded on the first visit only (they are not needed elsewhere
  // on the phone); stats.js polls every 30 s, only while this view is shown.
  const ST_SECS = ['rate', 'df', 'meteo', 'rng', 'sig', 'bds', 'tc', 'cad', 'rc', 'iid', 'health'];
  const ST_DEFAULT = ['rate', 'df', 'meteo', 'rng'];
  const ST = { win: parseInt(lsGet('ms_app_stats_win', '1440'), 10), on: null, loading: null };
  if (![10, 60, 1440, 10080].includes(ST.win)) ST.win = 1440;
  try { ST.on = JSON.parse(lsGet('ms_app_stats_secs', 'null')); } catch (_) { ST.on = null; }
  if (!Array.isArray(ST.on)) ST.on = ST_DEFAULT.slice();
  const stWinTxt = w => ({ 10: '10 min', 60: '1 h', 1440: '24 h', 10080: '7 days' }[w]);
  function applyStatsSecs() {
    document.querySelectorAll('#v-stats .app-st-sec').forEach(el => { el.hidden = !ST.on.includes(el.dataset.sec); });
    document.querySelectorAll('#app-st-secs input[data-sec]').forEach(cb => { cb.checked = ST.on.includes(cb.dataset.sec); });
    $('app-st-none').hidden = ST.on.length > 0;
    if (view === 'stats') { if (window.MsStats) window.MsStats.redraw(); markScroll(); }
  }
  document.querySelectorAll('#app-st-secs input[data-sec]').forEach(cb => cb.addEventListener('change', () => {
    ST.on = ST_SECS.filter(k => k === cb.dataset.sec ? cb.checked : ST.on.includes(k));
    lsSet('ms_app_stats_secs', JSON.stringify(ST.on));
    applyStatsSecs();
  }));
  $('app-st-win').value = String(ST.win);
  syncChip($('app-st-win'));
  $('app-st-win').addEventListener('change', e => {
    ST.win = parseInt(e.target.value, 10); lsSet('ms_app_stats_win', ST.win);
    if (view === 'stats') $('app-sub').textContent = `last ${stWinTxt(ST.win)}`;
    if (window.MsStats) window.MsStats.setWindow(ST.win);
  });
  applyStatsSecs();
  const loadScript = src => new Promise((ok, fail) => {
    const sc = document.createElement('script'); sc.src = src; sc.onload = ok; sc.onerror = fail; document.head.appendChild(sc);
  });
  // ══ Weather (from 2026-10-30) ════════════════════════════════════════
  // The MEPS maps with a time slider and the live air traffic: static/js/app_wx.js,
  // loaded the first time with Leaflet, wx_layer.js and atc_display.js.  The menu's
  // Weather options live here (ms_app_wx_<key>) and are passed on as they change.
  const WX_OPTS = { rain: ['on', 'off'], pres: ['on', 'off'], wind: ['off', 'on'], gust: ['off', 'on'],
                    cloud: ['off', 'c', 'l', 'm', 'h', 'f'], traffic: ['off', 'on'], mapst: ['street', 'atc'],
                    tlbl: ['atc', 'std'], fc: ['48', '24'], grid: ['10', '20'], load: ['all', 'near'],
                    speed: ['normal', 'slow', 'fast'], src: ['meps', 'radar', 'both'],
                    rainop: ['75', '25', '50', '100'], radarop: ['75', '25', '50', '100'], detail: ['auto', 'off'] };   // the first value is the default
  const W = {};
  for (const [k, vals] of Object.entries(WX_OPTS)) {
    const v = lsGet('ms_app_wx_' + k, vals[0]);
    W[k] = vals.includes(v) ? v : vals[0];
    const el = $('app-wx-' + k);
    el.value = W[k];
    el.addEventListener('change', e => {
      W[k] = e.target.value; lsSet('ms_app_wx_' + k, W[k]);
      if (window.AppWx && window.AppWx.ready()) window.AppWx.option(k);
    });
  }
  const WXL = { loading: null };
  async function openWx() {
    $('app-sub').textContent = 'MEPS maps · loading…';
    if (!(window.AppWx && window.AppWx.ready())) {
      if (!WXL.loading) {
        WXL.loading = loadLeaflet()
          .then(() => Promise.all([typeof WxLayer === 'undefined' ? loadScript(APP_WXLAYER_JS) : null, loadAtc()]))
          .then(() => (window.AppWx ? null : loadScript(APP_WX_JS)))
          .then(() => window.AppWx.init({ $, lsGet, lsSet, esc, S: W,
                                          sub: t => { if (view === 'wx') $('app-sub').textContent = t; } }));
      }
      try { await WXL.loading; } catch (e) { WXL.loading = null; $('app-sub').textContent = 'The weather map could not be loaded.'; return; }
    }
    if (view === 'wx') window.AppWx.show();
  }

  async function openStats() {
    $('app-sub').textContent = `last ${stWinTxt(ST.win)}`;
    if (!window.MsStats) {
      if (!ST.loading) {
        window.MST_EMBED = { win: ST.win };
        ST.loading = (typeof Chart === 'undefined' ? loadScript(APP_CHART_JS).catch(() => null) : Promise.resolve())
          .then(() => loadScript(APP_STATS_JS));
      }
      try { await ST.loading; } catch (_) { $('mst-updated').textContent = 'Could not load the statistics.'; return; }
    }
    if (view === 'stats' && window.MsStats) { window.MsStats.setWindow(ST.win); window.MsStats.start(); markScroll(); }
  }

  // ══ UTC clock of the top bar (from 2026-10-28) ═══════════════════════════
  // hours and minutes in UTC, set on each minute change (and when the page
  // becomes visible again: timers sleep in a background tab)
  function tickUtc() {
    const d = new Date();
    $('app-utc-t').textContent = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  function scheduleUtc() {
    tickUtc();
    setTimeout(scheduleUtc, 60_000 - (Date.now() % 60_000) + 50);
  }
  scheduleUtc();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tickUtc(); });

  // ══ About and User guides (from 2026-10-28) ══════════════════════════════
  // A full-screen sheet over the view: the desktop About text (in the page) or
  // the PDF guides of doc/guides.md (/api/whatsnew).  × / Esc / Back closes it
  // (a history entry is pushed while it is open).
  // What's new (from 2026-10-28 evening): the notes of doc/whats_new.md, the
  // same as the desktop window; a red dot on ☰ and the button until the
  // current version has been opened (ms_seen_version, shared with the site).
  const sheet = $('app-sheet');
  let sheetHist = false, guidesLoaded = false, newsLoaded = false, wnData = null;
  const loadWn = () => wnData || (wnData = fetch('/api/whatsnew', { cache: 'no-store' })
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .catch(e => { wnData = null; throw e; }));
  function newsDots() {
    const unseen = !!APP_VERSION && lsGet('ms_seen_version', null) !== APP_VERSION;
    $('app-menu-dot').hidden = !unseen; $('app-news-dot').hidden = !unseen; $('app-news-dot2').hidden = !unseen;
  }
  newsDots();
  const escH = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inlineMd = t => escH(t).replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
  function renderMd(lines) {                       // the notes' small Markdown subset (as the desktop)
    let html = '', depth = 0, para = [];
    const flush = () => { if (para.length) { html += '<p>' + inlineMd(para.join(' ')) + '</p>'; para = []; } };
    const close = to => { while (depth > to) { html += '</ul>'; depth--; } };
    for (const l of lines || []) {
      const m = l.match(/^(\s*)[-*]\s+(.*)$/);
      if (m) {
        flush();
        const d = m[1].length >= 2 ? 2 : 1;
        while (depth < d) { html += '<ul>'; depth++; }
        close(d);
        html += '<li>' + inlineMd(m[2]) + '</li>';
      } else if (!l.trim()) { flush(); close(0); }
      else { close(0); para.push(l.trim()); }
    }
    flush(); close(0);
    return html;
  }
  const isoFi = d => { const p = (d || '').split('-'); return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : (d || ''); };
  const fmtVer = v => { const d = String(v || '').slice(2); return d.length === 8 ? `${d.slice(0, 2)}.${d.slice(2, 4)}.${d.slice(4)}` : ''; };
  async function loadNews() {
    const el = $('app-sheet-news');
    try {
      const es = (await loadWn()).entries || [];
      el.innerHTML = es.length
        ? es.map((e, i) => {
            const head = `<span class="app-news-ver">${escH(e.version)}</span><span class="app-news-date">${fmtVer(e.version)}</span>` +
                         (e.version === APP_VERSION ? '<span class="app-news-cur">current</span>' : '');
            const body = (e.title ? `<div class="app-news-title">${inlineMd(e.title)}</div>` : '') + renderMd(e.lines);
            return i === 0 ? `<section class="app-news-entry"><h3>${head}</h3>${body}</section>`
                           : `<details class="app-news-entry"><summary><h3>${head}</h3></summary>${body}</details>`;
          }).join('') + '<p class="app-small">Older versions are folded — tap to open. The full history: CHANGELOG.md in the project.</p>'
        : '<p class="app-small">No notes found.</p>';
      newsLoaded = true;
    } catch (_) { el.innerHTML = '<p class="app-small">Could not load the notes.</p>'; }
  }
  async function loadGuides() {
    const el = $('app-sheet-guides');
    try {
      const d = await loadWn();
      const gs = d.guides || [];
      el.innerHTML = gs.length
        ? '<p class="app-small">The guides open as PDF (large files: the first opening can take a while on a slow connection).</p>' +
          gs.map(g => {
            const meta = [g.version ? 'Version ' + escH(g.version) : '', g.date ? isoFi(g.date) : '',
                          g.pages ? escH(g.pages) + ' pages' : '', (g.size / 1e6).toFixed(1) + ' MB'].filter(Boolean).join(' · ');
            return `<section class="app-guide"><h3>${escH(g.title)}</h3><div class="app-guide-meta">${meta}</div>` +
              `<details class="app-guide-more"><summary>Contents</summary>${renderMd(g.lines)}</details>` +
              `<div class="app-guide-btns"><a class="app-btn app-btn-primary" href="${escH(g.url)}" target="_blank" rel="noopener">Open PDF</a>` +
              `<a class="app-btn" href="${escH(g.url)}" download>Download</a></div></section>`;
          }).join('')
        : '<p class="app-small">No user guides on this system.</p>';
      guidesLoaded = true;
    } catch (_) { el.innerHTML = '<p class="app-small">Could not load the guides.</p>'; }
  }
  function openSheet(kind) {
    $('app-sheet-title').textContent = { about: 'About', guides: 'User guides', news: "What's new" }[kind];
    $('app-sheet-about').hidden = kind !== 'about';
    $('app-sheet-guides').hidden = kind !== 'guides';
    $('app-sheet-news').hidden = kind !== 'news';
    // the other two of What's new, User guides and About (from 2026-10-30 the first two, About from 2026-10-31)
    const others = { news: ['guides', 'about'], guides: ['news', 'about'], about: ['news', 'guides'] }[kind] || [];
    const NAME = { news: "What's new", guides: 'User guides', about: 'About' };
    ['app-sheet-alt', 'app-sheet-alt2'].forEach((id, k) => {
      const b = $(id), o = others[k];
      b.hidden = !o;
      if (o) { b.textContent = NAME[o]; b.dataset.kind = o; }
    });
    if (kind === 'guides' && !guidesLoaded) { $('app-sheet-guides').innerHTML = '<p class="app-small">Loading…</p>'; loadGuides(); }
    if (kind === 'news') {
      if (!newsLoaded) { $('app-sheet-news').innerHTML = '<p class="app-small">Loading…</p>'; loadNews(); }
      if (APP_VERSION) lsSet('ms_seen_version', APP_VERSION);
      newsDots();
    }
    sheet.hidden = false;
    $('app-sheet-body').scrollTop = 0;
    menu(false);
    if (!sheetHist) { try { history.pushState({ appSheet: kind }, ''); sheetHist = true; } catch (_) { /* */ } }
  }
  function closeSheet(fromPop) {
    if (sheet.hidden) return;
    sheet.hidden = true;
    if (sheetHist && !fromPop) { sheetHist = false; try { history.back(); } catch (_) { /* */ } }
    sheetHist = false;
  }
  $('app-news-btn').addEventListener('click', () => openSheet('news'));
  $('app-news-btn2').addEventListener('click', () => openSheet('news'));   // at the top of the menu (from 2026-10-30)
  $('app-about-btn').addEventListener('click', () => openSheet('about'));
  $('app-guides-btn').addEventListener('click', () => openSheet('guides'));
  $('app-sheet-close').addEventListener('click', () => closeSheet(false));
  $('app-sheet-alt').addEventListener('click', e => openSheet(e.currentTarget.dataset.kind));
  $('app-sheet-alt2').addEventListener('click', e => openSheet(e.currentTarget.dataset.kind));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(false); });
  window.addEventListener('popstate', () => closeSheet(true));

  fetchWx();
  setInterval(() => { if (!document.hidden) fetchWx(); }, 600e3);
  pollHealth();
  setInterval(() => { if (!document.hidden) pollHealth(); }, 60e3);
  setView(view);
})();
