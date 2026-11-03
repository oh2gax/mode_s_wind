/**
 * app_gnss.js — the phone's GNSS view (/app, from 2026-11-03): the GPS Quality
 * page in short, for users with the Full view right (web/rights.py — the
 * server leaves the tile, the view and this script out for everyone else, and
 * the APIs answer 403).
 *
 *  - Now: the aircraft with degraded GPS at this moment (the GPS Quality
 *    page's live table) — red when one of them has an unusable position
 *    (NACp 0, NIC 0 or no own position), amber otherwise, green when none.
 *  - Tiles: events, affected aircraft and severe aircraft-hours of the last
 *    24 h, and the peak hour.
 *  - Degraded aircraft per hour (24 h / 48 h / 7 d) or degraded
 *    aircraft-hours per day (1 m = 31 days / 3 m = 90 days, from 3 Nov 2026): severe and mild as stacked bars; a tap gives the numbers.
 *  - FL band heatmap (optional, the menu's switch; from 3 Nov 2026): the GPS Quality page's heatmap — days × FL bands, 14 d or
 *    1 m, Events (each row against its own busiest day) or % aircraft, in
 *    colour only (no numbers in the cells); a tap gives the cell.
 *  - Live list: callsign, level, NACp / NIC and the signal flags.
 *  - Spoofing indicators of the window (at most the last 31 days): aircraft
 *    per indicator, those with two or more independent indicators, and the
 *    newest flagged aircraft.
 *
 * Data: /api/gps/state?lite=1 (&heat=1 with the heatmap; every 30 s while
 * shown), /api/gps/detail?noslots=1 and, for 1 m / 3 m, /api/gps/daily (every
 * 2 min).  Options in the menu (Zone, Window, FL band heatmap) and the
 * heatmap's own chips are kept on the phone (ms_app_gnss_*).  app.js calls
 * init / show / hide / refresh / layout.
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, String(v)); } catch (_) { /* private mode */ } };
  const pad = n => String(n).padStart(2, '0');
  const hm = ts => { const d = new Date(ts * 1000); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const dm = ts => { const d = new Date(ts * 1000); return `${d.getUTCDate()}.${d.getUTCMonth() + 1}.`; };
  const dhm = ts => `${dm(ts)} ${hm(ts)}`;
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const num = v => (v == null ? '—' : Number(v).toLocaleString('en-US').replace(/,/g, ' '));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const light = () => document.documentElement.dataset.theme === 'light';

  const ZONES = { all: 'All', '50nm': '50 NM', '20nm': '20 NM' };
  const WINS = { 24: '24 h', 48: '48 h', 168: '7 days', 744: '31 days', 2160: '90 days' };
  const S = {
    zone: lsGet('ms_app_gnss_zone', 'all'),
    win: parseInt(lsGet('ms_app_gnss_win', '24'), 10),
    heat: lsGet('ms_app_gnss_heat', 'off'),            // FL band heatmap shown (from 3 Nov 2026)
    hrange: lsGet('ms_app_gnss_hrange', '14'),         // its days: 14 / 31
    hmode: lsGet('ms_app_gnss_hmode', 'events'),       // events / pct
  };
  if (!ZONES[S.zone]) S.zone = 'all';
  if (!WINS[S.win]) S.win = 24;
  if (!['on', 'off'].includes(S.heat)) S.heat = 'off';
  if (!['14', '31'].includes(S.hrange)) S.hrange = '14';
  if (!['events', 'pct'].includes(S.hmode)) S.hmode = 'events';
  const daily = () => S.win > 168;

  // the GPS Quality page's names and colours (static/js/gps_quality.js)
  const FLAG = { nacp: ['NACp', 'gps-flag-nacp'], nic: ['NIC', 'gps-flag-nic'], freeze: ['Freeze', 'gps-flag-freeze'],
                 gap: ['Gap', 'gps-flag-gap'], adsb_loss: ['ADS-B', 'gps-flag-adsb'] };
  const SIG = { nacp: 'NACp', nic: 'NIC', freeze: 'Freeze', gap: 'Gap', adsb_loss: 'ADS-B' };
  const SPOOF = {
    mlat_dis: ['ADS-B / MLAT mismatch', 'MLAT ≠'],
    gmb_sat:  ['GNSS−baro at limit', 'Alt limit'],
    gmb_jump: ['GNSS−baro jump', 'Alt jump'],
    pos_jump: ['Position jump', 'Pos jump'],
  };
  const SPOOF_GROUP = { mlat_dis: 'mlat', gmb_sat: 'gmb', gmb_jump: 'gmb', pos_jump: 'pos' };
  const groups = k => new Set((k || []).map(x => SPOOF_GROUP[x] || x)).size;
  const severe = a => {
    const f = a.flags || [];
    return (f.includes('nacp') && a.nac_p === 0) || (f.includes('nic') && a.nic === 0) || f.includes('gap') || f.includes('adsb_loss');
  };
  const pal = () => light()
    ? { sev: '#c0504d', mild: '#d9973f', none: '#b8a07a', grid: 'rgba(15,23,42,.10)', txt: '#64748b', sel: 'rgba(15,23,42,.10)', mark: '#d97706' }
    : { sev: '#d48f8f', mild: '#cf9f6b', none: '#8f8170', grid: 'rgba(148,163,184,.13)', txt: '#94a3b8', sel: 'rgba(226,232,240,.10)', mark: '#f59e0b' };
  // the heatmap (as gps_quality.js HEAT_COLORS / HEAT_COLORS_LIGHT, HEAT_PCT_STEPS)
  const HEAT = { dark: ['#1b2433', '#21344a', '#2b4865', '#3b6185', '#5a80a6'],
                 light: ['#eef2f6', '#dbe5ef', '#bfd2e4', '#9cb8d4', '#7899bf'] };
  const PCT_STEPS = [10, 25, 50];
  const pctStep = p => { if (p <= 0) return 0; let s = 1; for (const t of PCT_STEPS) if (p >= t) s++; return s; };

  let on = false, inited = false, st = null, det = null, day = null, detAt = 0, sel = null, n = 0, err = '';
  let hsel = null, hlay = null;
  let sub = () => {};

  function init(o) {
    if (o && o.sub) sub = o.sub;
    if (inited) return;
    inited = true;
    const z = $('app-gnss-zone'), w = $('app-gnss-win'), h = $('app-gnss-heat');
    z.value = S.zone; w.value = String(S.win); h.value = S.heat;
    for (const el of [z, w, h]) el.dispatchEvent(new Event('change'));      // the chips follow
    z.addEventListener('change', () => {
      if (z.value === S.zone) return;
      S.zone = z.value; lsSet('ms_app_gnss_zone', S.zone); st = det = day = null; sel = hsel = null; render(); load(true);
    });
    w.addEventListener('change', () => {
      const v = parseInt(w.value, 10);
      if (v === S.win) return;
      S.win = v; lsSet('ms_app_gnss_win', S.win); det = day = null; sel = null; render(); load(true);
    });
    h.addEventListener('change', () => {
      if (h.value === S.heat) return;
      S.heat = h.value; lsSet('ms_app_gnss_heat', S.heat); hsel = null; render();
      if (S.heat === 'on' && !(st && st.heat_days)) load(false, true);
    });
    chipRow('agn-hrange', 'hrange', 'ms_app_gnss_hrange');
    chipRow('agn-hmode', 'hmode', 'ms_app_gnss_hmode');
    $('agn-chart').addEventListener('click', e => {
      const rows = chartRows();
      if (!rows.length) return;
      const r = e.currentTarget.getBoundingClientRect();
      const i = Math.floor((e.clientX - r.left - 30) / ((r.width - 34) / rows.length));
      sel = i >= 0 && i < rows.length ? i : null;
      drawChart(); pickTxt();
    });
    $('agn-heat').addEventListener('click', e => {
      if (!hlay) return;
      const r = e.currentTarget.getBoundingClientRect();
      const xi = Math.floor((e.clientX - r.left - hlay.L) / hlay.cw), yi = Math.floor((e.clientY - r.top - hlay.T) / hlay.ch);
      hsel = xi >= 0 && yi >= 0 && xi < hlay.days.length && yi < hlay.bands.length ? [hlay.days[xi], hlay.bands[yi]] : null;
      drawHeat(); heatTxtOut();
    });
  }
  // a row of chips in the view (the heatmap's range and mode)
  function chipRow(id, key, ls) {
    const box = $(id);
    const sync = () => box.querySelectorAll('.app-chip').forEach(b => {
      const on_ = b.dataset.v === S[key]; b.classList.toggle('on', on_); b.setAttribute('aria-pressed', String(on_));
    });
    box.addEventListener('click', e => {
      const b = e.target.closest('.app-chip');
      if (!b || b.dataset.v === S[key]) return;
      S[key] = b.dataset.v; lsSet(ls, S[key]); sync(); hsel = null; drawHeat(); heatTxtOut();
    });
    sync();
  }

  async function load(force, stateOnly) {
    n++;
    const want = n;
    const q = `zone=${encodeURIComponent(S.zone)}`;
    const needDet = !stateOnly && (force || !det || Date.now() - detAt > 120e3);
    const dh = Math.min(S.win, 744);
    try {
      const [a, b, c] = await Promise.all([
        fetch(`/api/gps/state?lite=1${S.heat === 'on' ? '&heat=1' : ''}&${q}`, { cache: 'no-store' }),
        needDet ? fetch(`/api/gps/detail?hours=${dh}&noslots=1&${q}`, { cache: 'no-store' }) : null,
        needDet && daily() ? fetch(`/api/gps/daily?days=${S.win / 24}&${q}`, { cache: 'no-store' }) : null]);
      if ([a, b, c].some(x => x && x.status === 403)) { err = 'The GNSS data needs the Full view right.'; st = det = day = null; }
      else {
        if (!a.ok) throw new Error(a.status);
        const sa = await a.json();
        const sb = b && b.ok ? await b.json() : null;
        const sc = c && c.ok ? await c.json() : null;
        if (want !== n && !force) return;
        // the heatmap's days are kept from the last answer that had them
        if (!sa.heat_days && st && st.heat_days && S.heat === 'on') { sa.heat_days = st.heat_days; sa.band_days = st.band_days; }
        st = sa; err = '';
        if (sb) { det = sb; detAt = Date.now(); }
        if (sc) day = sc.days || [];
        if (!daily()) day = null;
        if (sel != null && sel >= chartRows().length) sel = null;
      }
    } catch (_) { err = 'Could not load the GNSS data — retrying.'; }
    if (on) render();
  }

  // the chart's bars: hours (24 h – 7 d) or days (1 m / 3 m) — {ts, ac, deg, sev, spf, ev}
  function chartRows() {
    if (daily()) return (day || []).map(d => ({ ts: d[0], ac: d[1], deg: d[2], sev: d[3], ev: d[4] }));
    return ((det && det.hours) || []).map(h => ({ ts: h[0], ac: h[1], deg: h[2], sev: h[3], spf: h[4] }));
  }

  function render() {
    if (!inited) return;
    const P = pal();
    const now = $('agn-now'), live = (st && st.live) || [];
    if (err) {
      now.className = 'agn-now'; now.innerHTML = `<b>—</b><span>${esc(err)}</span>`;
    } else if (!st) {
      now.className = 'agn-now'; now.innerHTML = '<b>…</b><span>Loading</span>';
    } else {
      const ns = live.filter(severe).length;
      now.className = 'agn-now ' + (!live.length ? 'agn-ok' : ns ? 'agn-sev' : 'agn-deg');
      now.innerHTML = `<i class="agn-dot"></i><b>${live.length}</b><span>aircraft with degraded GPS now`
        + (ns ? ` · <em>${ns} severe</em>` : '') + `<small>Zone ${ZONES[S.zone]} · updated ${hm(Date.now() / 1000)} UTC</small></span>`;
    }
    const s = (st && st.stats) || {};
    const tile = (v, lbl, cls) => `<div class="am-tile"><b${cls ? ` class="${cls}"` : ''}>${v == null ? '—' : esc(v)}</b><span>${lbl}</span></div>`;
    $('agn-tiles').innerHTML = tile(s.events_24h, 'Events · 24 h')
      + tile(s.degraded_24h, 'Aircraft affected · 24 h')
      + tile(s.severe_24h, 'Severe · 24 h <small>(aircraft-hours, position unusable)</small>', s.severe_24h ? 'agn-sevtxt' : '')
      + tile(s.peak_hour || (st ? 'None' : null), 'Peak hour');
    $('agn-chart-hd').textContent = daily() ? `Degraded aircraft-hours per day · ${WINS[S.win]}` : `Degraded aircraft per hour · ${WINS[S.win]}`;
    $('agn-leg').innerHTML = `<span><i style="background:${P.sev}"></i>Severe</span><span><i style="background:${P.mild}"></i>Mild</span>`
      + (chartRows().some(r => r.sev == null) ? `<span title="before 9 Oct 2026 the severity was not recorded"><i style="background:${P.none}"></i>Not split</span>` : '');
    drawChart(); pickTxt();
    // the FL band heatmap
    $('agn-heat-sec').hidden = S.heat !== 'on';
    if (S.heat === 'on') { drawHeat(); heatTxtOut(); }
    // live list
    const lt = $('agn-live');
    if (!st) lt.innerHTML = '';
    else if (!live.length) lt.innerHTML = '<div class="agn-none">No aircraft with degraded GPS right now.</div>';
    else {
      lt.innerHTML = '<table><thead><tr><th>Callsign</th><th class="num">FL</th><th class="num">NACp</th><th class="num">NIC</th><th>Signals</th></tr></thead><tbody>'
        + live.map(a => {
          const fl = a.altitude != null ? String(Math.round(a.altitude / 100)).padStart(3, '0') : '—';
          const fx = (a.flags || []).map(f => FLAG[f] ? `<span class="gps-flag ${FLAG[f][1]}">${FLAG[f][0]}</span>` : esc(f)).join(' ');
          return `<tr${severe(a) ? ' class="agn-sevrow"' : ''}><td class="agn-cs">${esc(a.callsign || a.icao)}</td><td class="num">${fl}</td>`
            + `<td class="num">${a.nac_p ?? '—'}</td><td class="num">${a.nic ?? '—'}</td><td class="agn-flags">${fx}</td></tr>`;
        }).join('') + '</tbody></table>';
    }
    $('agn-spoof-hd').textContent = S.win > 744 ? 'Spoofing indicators · last 31 days' : 'Spoofing indicators';
    renderSpoof();
    sub(err ? 'GNSS · Full view' : `zone ${ZONES[S.zone]} · ${WINS[S.win]}`);
  }

  function renderSpoof() {
    const el = $('agn-spoof');
    if (!det) { el.innerHTML = st ? '<div class="agn-none">Loading…</div>' : ''; return; }
    if (det.since == null) { el.innerHTML = '<div class="agn-none">No detail recorded in this window.</div>'; return; }
    const sp = det.spoof || {}, fl = sp.flagged || [];
    const multi = new Set(fl.filter(e => groups(e.k) >= 2).map(e => e.icao)).size;
    let h = '<table class="agn-sptab"><tbody>';
    for (const k of Object.keys(SPOOF)) {
      const c = (sp.kinds || {})[k] || { aircraft: 0 };
      h += `<tr><td>${SPOOF[k][0]}</td><td class="num${c.aircraft ? ' agn-hit' : ''}">${c.aircraft}</td></tr>`;
    }
    h += `<tr class="agn-multi"><td><span class="gps-spoof-multi">2+</span> independent indicators</td><td class="num${multi ? ' agn-hit' : ''}">${multi}</td></tr>`;
    const since = det.since > Date.now() / 1000 - det.hours_n * 3600 + 3600 ? ` · data from ${dm(det.since)}` : '';
    h += `</tbody></table><div class="agn-dim">aircraft · the two GNSS−baro indicators count as one check${since}</div>`;
    if (fl.length) {
      const show = fl.slice(0, 12);
      h += `<div class="agn-sub">Newest flagged${sp.flagged_total > show.length ? ` <small>(${show.length} of ${sp.flagged_total})</small>` : ''}</div>`
        + '<table><thead><tr><th>UTC</th><th>Callsign</th><th class="num">FL</th><th>Indicator</th></tr></thead><tbody>'
        + show.map(e => `<tr${(e.q || []).length ? ' class="agn-strong"' : ''}><td class="agn-t">${S.win > 24 ? dhm(e.t) : hm(e.t)}</td>`
          + `<td class="agn-cs">${esc(e.cs || e.icao)}</td><td class="num">${e.alt != null ? String(Math.round(e.alt / 100)).padStart(3, '0') : '—'}</td>`
          + `<td class="agn-ind">${groups(e.k) >= 2 ? '<span class="gps-spoof-multi">2+</span> ' : ''}${(e.k || []).map(k => SPOOF[k] ? SPOOF[k][1] : esc(k)).join(', ')}</td></tr>`).join('')
        + '</tbody></table>';
    } else h += '<div class="agn-none">No aircraft flagged.</div>';
    el.innerHTML = h;
  }

  function sizeCanvas(cv, H) {
    const W = Math.max(200, cv.parentElement.clientWidth), dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
    return [c, W];
  }

  function drawChart() {
    const cv = $('agn-chart');
    const H = 150, [c, W] = sizeCanvas(cv, H);
    const P = pal(), rows = chartRows();
    const L = 30, R = 4, T = 8, B = 20, pw = W - L - R, ph = H - T - B;
    c.font = '10px system-ui, sans-serif'; c.fillStyle = P.txt;
    if (!rows.length) { c.textAlign = 'center'; c.fillText((daily() ? day : det) ? 'No data in this window' : 'Loading…', W / 2, H / 2); return; }
    let mx = Math.max(1, ...rows.map(r => r.deg || 0));
    const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    const step = steps.find(s => mx / s <= 5) || 10000;
    mx = Math.ceil(mx / step) * step;
    c.textAlign = 'right'; c.textBaseline = 'middle';
    for (let v = 0; v <= mx; v += step) {
      const y = T + ph - v / mx * ph;
      c.strokeStyle = P.grid; c.beginPath(); c.moveTo(L, Math.round(y) + 0.5); c.lineTo(W - R, Math.round(y) + 0.5); c.stroke();
      c.fillText(v >= 1000 ? (v / 1000) + 'k' : String(v), L - 4, y);
    }
    const bw = pw / rows.length;
    if (sel != null) { c.fillStyle = P.sel; c.fillRect(L + sel * bw, T, bw, ph); }
    rows.forEach((r, i) => {
      const deg = r.deg || 0, x = L + i * bw + (bw > 4 ? 0.5 : 0), w = Math.max(1, bw - (bw > 4 ? 1 : 0));
      const hd = deg / mx * ph;
      if (r.sev == null) {            // no severity split recorded (before 9 Oct 2026)
        c.fillStyle = P.none; c.fillRect(x, T + ph - hd, w, hd); return;
      }
      const hs = Math.min(deg, r.sev) / mx * ph;
      c.fillStyle = P.mild; c.fillRect(x, T + ph - hd, w, hd - hs);
      c.fillStyle = P.sev; c.fillRect(x, T + ph - hs, w, hs);
    });
    // time labels: every 6 h (24 h), 12 h (48 h), each day (7 d), each Monday (31 d), the 1st and 15th (90 d)
    c.textAlign = 'center'; c.textBaseline = 'top';
    rows.forEach((r, i) => {
      const d = new Date(r.ts * 1000), hh = d.getUTCHours();
      const show = S.win === 2160 ? (d.getUTCDate() === 1 || d.getUTCDate() === 15) : S.win === 744 ? d.getUTCDay() === 1
        : S.win === 168 ? hh === 0 : S.win === 48 ? hh % 12 === 0 : hh % 6 === 0;
      if (!show) return;
      const x = L + i * bw;
      c.strokeStyle = P.grid; c.beginPath(); c.moveTo(Math.round(x) + 0.5, T); c.lineTo(Math.round(x) + 0.5, T + ph + 3); c.stroke();
      c.fillStyle = P.txt;
      c.fillText(S.win >= 168 ? dm(r.ts) : pad(hh), x, T + ph + 5);
    });
  }

  function pickTxt() {
    const el = $('agn-pick'), rows = chartRows(), r = sel != null ? rows[sel] : null;
    if (!r) { el.textContent = daily() ? 'Tap the chart for the day’s numbers.' : 'Tap the chart for the hour’s numbers.'; return; }
    const pct = r.ac ? Math.round(100 * r.deg / r.ac) : 0;
    if (daily()) {
      const d = new Date(r.ts * 1000);
      el.textContent = `${DOW[d.getUTCDay()]} ${dm(r.ts)} · ${num(r.deg)} of ${num(r.ac)} aircraft-hours degraded (${pct} %) · `
        + (r.sev == null ? 'severity not recorded (from 9 Oct 2026)' : `severe ${num(r.sev)}`) + ` · ${num(r.ev)} events`;
      return;
    }
    el.textContent = `${S.win > 24 ? dhm(r.ts) : hm(r.ts)}–${pad((new Date(r.ts * 1000).getUTCHours() + 1) % 24)}:00 UTC · `
      + `${r.deg} of ${r.ac} aircraft degraded (${pct} %) · severe ${r.sev || 0} · spoofing indicator ${r.spf || 0}`;
  }

  // ── FL band heatmap (the GPS Quality page's, gps_quality.js drawHeatmap) ──
  // Events: each FL row coloured against its own busiest day, days on either side of a
  // counting-method change scaled apart (segments shorter than 3 days merged); % aircraft:
  // the share of the band's aircraft-hours that were degraded, one scale for all rows.
  function segments(days, meth) {
    const segs = [];
    days.forEach((d, i) => { if (i === 0 || (meth[d] || 1) !== (meth[days[i - 1]] || 1)) segs.push([]); segs[segs.length - 1].push(i); });
    for (let i = 0; i < segs.length - 1;) {
      if (segs[i].length < 3) { segs[i + 1] = segs[i].concat(segs[i + 1]); segs.splice(i, 1); } else i++;
    }
    if (segs.length > 1 && segs[segs.length - 1].length < 3) { const l = segs.pop(); segs[segs.length - 1] = segs[segs.length - 1].concat(l); }
    const out = new Array(days.length).fill(0);
    segs.forEach((sg, si) => sg.forEach(i => { out[i] = si; }));
    return out;
  }
  function drawHeat() {
    const cv = $('agn-heat');
    if (S.heat !== 'on') return;
    const hd = st && st.heat_days, bands = (st && st.fl_bands) || [];
    const H = 26 + Math.max(1, bands.length) * 22, [c, W] = sizeCanvas(cv, H);
    const P = pal(), cols = HEAT[light() ? 'light' : 'dark'];
    hlay = null;
    c.font = '10px system-ui, sans-serif'; c.fillStyle = P.txt;
    if (!hd || !bands.length) { c.textAlign = 'center'; c.fillText(st ? 'Loading…' : '', W / 2, H / 2); return; }
    const days = Object.keys(hd.days).map(Number).sort((a, b) => a - b).slice(-parseInt(S.hrange, 10));
    const L = 62, R = 2, T = 2, B = 24, cw = (W - L - R) / days.length, ch = (H - T - B) / bands.length;
    const seg = segments(days, hd.method || {});
    const mx = {};
    days.forEach((d, xi) => bands.forEach(b => {
      const k = seg[xi] + '|' + b; mx[k] = Math.max(mx[k] || 1, (hd.days[d] || {})[b] || 0);
    }));
    const bd = (st && st.band_days) || {};
    days.forEach((d, xi) => bands.forEach((b, yi) => {
      const x = L + xi * cw, y = T + yi * ch;
      // colour only, no numbers in the cells (from 2026-11-03): a tap gives the values
      let step;
      if (S.hmode === 'pct') {
        const e = (bd[String(d)] || {})[b];
        if (!e || !e.ac) { c.strokeStyle = P.grid; c.lineWidth = 0.5; c.strokeRect(x + 1.5, y + 1.5, cw - 3, ch - 3); return; }
        step = pctStep(100 * e.deg / e.ac);
      } else {
        const v = (hd.days[d] || {})[b] || 0;
        step = Math.min(4, Math.round(v / mx[seg[xi] + '|' + b] * 4));
      }
      c.fillStyle = cols[step]; c.fillRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
    }));
    if (hsel) {
      const xi = days.indexOf(hsel[0]), yi = bands.indexOf(hsel[1]);
      if (xi >= 0 && yi >= 0) { c.strokeStyle = light() ? '#0f172a' : '#e2e8f0'; c.lineWidth = 1.5; c.strokeRect(L + xi * cw + 1, T + yi * ch + 1, cw - 2, ch - 2); }
    }
    // counting-method changes: a dashed line (events)
    if (S.hmode !== 'pct') days.forEach((d, xi) => {
      if (xi === 0 || (hd.method[d] || 1) === (hd.method[days[xi - 1]] || 1)) return;
      c.save(); c.strokeStyle = P.mark; c.lineWidth = 1.5; c.setLineDash([4, 3]);
      c.beginPath(); c.moveTo(L + xi * cw, T); c.lineTo(L + xi * cw, H - B); c.stroke(); c.restore();
    });
    c.font = '9.5px system-ui, sans-serif'; c.fillStyle = P.txt; c.textAlign = 'right'; c.textBaseline = 'middle';
    bands.forEach((b, yi) => c.fillText('FL' + b, L - 4, T + yi * ch + ch / 2));
    c.textAlign = 'center'; c.textBaseline = 'top';
    const every = days.length > 16 ? 7 : 2;
    days.forEach((d, xi) => {
      if ((days.length - 1 - xi) % every) return;
      const dd = new Date(d * 1000);
      c.fillText(dm(d), L + xi * cw + cw / 2, H - B + 3);
      c.fillText(DOW[dd.getUTCDay()], L + xi * cw + cw / 2, H - B + 13);
    });
    hlay = { L, T, cw, ch, days, bands };
  }
  function heatTxtOut() {
    const el = $('agn-heat-pick');
    if (!el || S.heat !== 'on') return;
    $('agn-heat-leg').textContent = S.hmode === 'pct'
      ? 'Share of the band’s aircraft-hours degraded: 0 · <10 · <25 · <50 · ≥50 % (recorded from 6 Oct 2026); tap a cell for the values'
      : 'Events: each row against its own busiest day (None → High); tap a cell for the values';
    if (!hsel || !st || !st.heat_days) { el.textContent = 'Tap a cell for the day and the flight level band.'; return; }
    const [d, b] = hsel, dd = new Date(d * 1000);
    const ev = (st.heat_days.days[d] || {})[b] || 0;
    const e = ((st.band_days || {})[String(d)] || {})[b];
    let t = `${DOW[dd.getUTCDay()]} ${dm(d)} · FL${b} · ${num(ev)} events`;
    if (e && e.ac) {
      t += ` · ${e.deg} of ${e.ac} aircraft-hours degraded (${Math.round(100 * e.deg / e.ac)} %)` + (e.sev ? ` · severe ${e.sev}` : '');
      const sig = Object.entries(e.sig || {}).filter(([, v]) => v > 0), tot = sig.reduce((a, [, v]) => a + v, 0);
      if (tot) t += '\nSignals: ' + sig.sort((a, b2) => b2[1] - a[1]).map(([k, v]) => `${SIG[k] || k} ${Math.round(100 * v / tot)} %`).join(' · ');
    } else t += ' · aircraft counts not recorded (from 6 Oct 2026)';
    el.textContent = t;
  }

  window.AppGnss = {
    init,
    show() { init(); on = true; render(); load(true); },
    hide() { on = false; },
    refresh() { if (on) load(false); },
    layout() { if (on) { drawChart(); drawHeat(); } },
  };
})();
