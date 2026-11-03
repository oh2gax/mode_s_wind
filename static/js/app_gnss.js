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
 *  - Degraded aircraft per hour (24 h / 48 h / 7 d): severe and mild as
 *    stacked bars; a tap gives the hour's numbers.
 *  - Live list: callsign, level, NACp / NIC and the signal flags.
 *  - Spoofing indicators of the window: aircraft per indicator, those with
 *    two or more independent indicators, and the newest flagged aircraft.
 *
 * Data: /api/gps/state?lite=1 (every 30 s while shown) and /api/gps/detail
 * (every 2 min).  Options in the menu (Zone, Window) are kept on the phone
 * (ms_app_gnss_zone, ms_app_gnss_win).  app.js calls show / hide / refresh /
 * layout.
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, String(v)); } catch (_) { /* private mode */ } };
  const pad = n => String(n).padStart(2, '0');
  const hm = ts => { const d = new Date(ts * 1000); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const dhm = ts => { const d = new Date(ts * 1000); return `${d.getUTCDate()}.${d.getUTCMonth() + 1}. ${hm(ts)}`; };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const light = () => document.documentElement.dataset.theme === 'light';

  const ZONES = { all: 'All', '50nm': '50 NM', '20nm': '20 NM' };
  const S = { zone: lsGet('ms_app_gnss_zone', 'all'), win: parseInt(lsGet('ms_app_gnss_win', '24'), 10) };
  if (!ZONES[S.zone]) S.zone = 'all';
  if (![24, 48, 168].includes(S.win)) S.win = 24;

  // the GPS Quality page's names (static/js/gps_quality.js)
  const FLAG = { nacp: ['NACp', 'gps-flag-nacp'], nic: ['NIC', 'gps-flag-nic'], freeze: ['Freeze', 'gps-flag-freeze'],
                 gap: ['Gap', 'gps-flag-gap'], adsb_loss: ['ADS-B', 'gps-flag-adsb'] };
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
    ? { sev: '#c0504d', mild: '#d9973f', grid: 'rgba(15,23,42,.10)', txt: '#64748b', sel: 'rgba(15,23,42,.10)' }
    : { sev: '#d48f8f', mild: '#cf9f6b', grid: 'rgba(148,163,184,.13)', txt: '#94a3b8', sel: 'rgba(226,232,240,.10)' };

  let on = false, inited = false, st = null, det = null, detAt = 0, sel = null, n = 0, err = '';
  let sub = () => {};

  function init(o) {
    if (o && o.sub) sub = o.sub;
    if (inited) return;
    inited = true;
    const z = $('app-gnss-zone'), w = $('app-gnss-win');
    z.value = S.zone; w.value = String(S.win);
    z.dispatchEvent(new Event('change'));      // the chips follow
    w.dispatchEvent(new Event('change'));
    z.addEventListener('change', () => {
      if (z.value === S.zone) return;
      S.zone = z.value; lsSet('ms_app_gnss_zone', S.zone); st = null; det = null; sel = null; render(); load(true);
    });
    w.addEventListener('change', () => {
      const v = parseInt(w.value, 10);
      if (v === S.win) return;
      S.win = v; lsSet('ms_app_gnss_win', S.win); det = null; sel = null; render(); load(true);
    });
    $('agn-chart').addEventListener('click', e => {
      const hrs = det && det.hours;
      if (!hrs || !hrs.length) return;
      const r = e.currentTarget.getBoundingClientRect();
      const i = Math.floor((e.clientX - r.left - 30) / ((r.width - 34) / hrs.length));
      sel = i >= 0 && i < hrs.length ? i : null;
      drawChart(); pickTxt();
    });
  }

  async function load(force) {
    n++;
    const want = n;
    const q = `zone=${encodeURIComponent(S.zone)}`;
    const needDet = force || !det || Date.now() - detAt > 120e3;
    try {
      const [a, b] = await Promise.all([
        fetch(`/api/gps/state?lite=1&${q}`, { cache: 'no-store' }),
        needDet ? fetch(`/api/gps/detail?hours=${S.win}&${q}`, { cache: 'no-store' }) : null]);
      if (a.status === 403 || (b && b.status === 403)) { err = 'The GNSS data needs the Full view right.'; st = det = null; }
      else {
        if (!a.ok) throw new Error(a.status);
        const sa = await a.json();
        const sb = b && b.ok ? await b.json() : null;
        if (want !== n && !force) return;
        st = sa; err = '';
        if (sb) { det = sb; detAt = Date.now(); if (sel != null && sel >= (det.hours || []).length) sel = null; }
      }
    } catch (_) { err = 'Could not load the GNSS data — retrying.'; }
    if (on) render();
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
    $('agn-chart-hd').textContent = `Degraded aircraft per hour · ${S.win === 168 ? '7 days' : S.win + ' h'}`;
    $('agn-leg').innerHTML = `<span><i style="background:${P.sev}"></i>Severe</span><span><i style="background:${P.mild}"></i>Mild</span>`;
    drawChart(); pickTxt();
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
    renderSpoof();
    const wt = S.win === 168 ? '7 d' : S.win + ' h';
    sub(err ? 'GNSS · Full view' : `zone ${ZONES[S.zone]} · ${wt}`);
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
    h += '</tbody></table><div class="agn-dim">aircraft · the two GNSS−baro indicators count as one check</div>';
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

  function drawChart() {
    const cv = $('agn-chart'), box = cv.parentElement;
    const W = Math.max(200, box.clientWidth), H = 150, dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
    const P = pal(), hrs = (det && det.hours) || [];
    const L = 30, R = 4, T = 8, B = 20, pw = W - L - R, ph = H - T - B;
    c.font = '10px system-ui, sans-serif'; c.fillStyle = P.txt;
    if (!hrs.length) { c.textAlign = 'center'; c.fillText(det ? 'No data in this window' : 'Loading…', W / 2, H / 2); return; }
    let mx = Math.max(1, ...hrs.map(h => h[2] || 0));
    const step = mx <= 5 ? 1 : mx <= 10 ? 2 : mx <= 25 ? 5 : mx <= 50 ? 10 : mx <= 100 ? 20 : mx <= 250 ? 50 : 100;
    mx = Math.ceil(mx / step) * step;
    c.textAlign = 'right'; c.textBaseline = 'middle';
    for (let v = 0; v <= mx; v += step) {
      const y = T + ph - v / mx * ph;
      c.strokeStyle = P.grid; c.beginPath(); c.moveTo(L, Math.round(y) + 0.5); c.lineTo(W - R, Math.round(y) + 0.5); c.stroke();
      c.fillText(String(v), L - 4, y);
    }
    const bw = pw / hrs.length;
    if (sel != null) { c.fillStyle = P.sel; c.fillRect(L + sel * bw, T, bw, ph); }
    hrs.forEach((h, i) => {
      const deg = h[2] || 0, sv = Math.min(deg, h[3] || 0), x = L + i * bw + (bw > 4 ? 0.5 : 0), w = Math.max(1, bw - (bw > 4 ? 1 : 0));
      const hs = sv / mx * ph, hd = deg / mx * ph;
      c.fillStyle = P.mild; c.fillRect(x, T + ph - hd, w, hd - hs);
      c.fillStyle = P.sev; c.fillRect(x, T + ph - hs, w, hs);
    });
    // time labels: every 6 h (24 / 48 h) or each day (7 d), at 00 UTC bold
    c.textAlign = 'center'; c.textBaseline = 'top';
    hrs.forEach((h, i) => {
      const d = new Date(h[0] * 1000), hh = d.getUTCHours();
      const show = S.win === 168 ? hh === 0 : S.win === 48 ? hh % 12 === 0 : hh % 6 === 0;
      if (!show) return;
      const x = L + i * bw;
      c.strokeStyle = P.grid; c.beginPath(); c.moveTo(Math.round(x) + 0.5, T); c.lineTo(Math.round(x) + 0.5, T + ph + 3); c.stroke();
      c.fillStyle = P.txt;
      c.fillText(S.win === 168 ? `${d.getUTCDate()}.${d.getUTCMonth() + 1}.` : pad(hh), x, T + ph + 5);
    });
  }

  function pickTxt() {
    const el = $('agn-pick'), hrs = (det && det.hours) || [];
    if (sel == null || !hrs[sel]) { el.textContent = 'Tap the chart for the hour’s numbers.'; return; }
    const [ts, ac, deg, sv, spf] = hrs[sel];
    const pct = ac ? Math.round(100 * deg / ac) : 0;
    el.textContent = `${S.win > 24 ? dhm(ts) : hm(ts)}–${pad((new Date(ts * 1000).getUTCHours() + 1) % 24)}:00 UTC · `
      + `${deg} of ${ac} aircraft degraded (${pct} %) · severe ${sv || 0} · spoofing indicator ${spf || 0}`;
  }

  window.AppGnss = {
    init,
    show() { init(); on = true; render(); load(true); },
    hide() { on = false; },
    refresh() { if (on) load(false); },
    layout() { if (on) drawChart(); },
  };
})();
