/**
 * app_mast.js — the phone's Mast view (/app, from 2026-11-01 night): the
 * Kivenlahti mast (FMI open data, collector/mast.py; Espoo Latokaski, 327 m,
 * 24 km south-west of the airport) for the lowest part of the boundary layer.
 *
 *  - EFHK now (On by default, « / »): the Live Map's airport box (apt_now.js —
 *    MEPS, Δ METAR and the mast rows with Δ MEPS / Δ Mode S); a tap on a row
 *    shows its explanation under the box.
 *  - Tiles: the wind at the top, ΔT top − 2 m with the stability, the wind
 *    shear 26 → 327 m, the 2 m temperature and humidity.
 *  - Profile (0–1 500 ft): mast.js profileSvg (compact) with Mode S, MEPS and
 *    the sounding; a tap on a point or barb gives its values.
 *  - Boundary layer · temperature / · wind: ws_cond_chart.js
 *    drawBoundaryLayer with the mast's 10-minute steps filling the plot below
 *    its top (d.mastSteps) and the airport's Mode S hours above it, 0–3 000 ft
 *    by default (d.top); between them the ΔT top − 2 m strip.  A tap gives the
 *    cell; a tap on a mast cell also shows the profile of that time.
 *  - Comparison (Temperature | Wind, 7 / 30 / 90 days): source − mast per
 *    level for Mode S, MEPS and the sounding, as bias / RMS (/api/mast/compare).
 *
 * Data: /api/mast, /api/mast/profile, /api/boundary, /api/mast/compare and,
 * for the box, /api/weather/point and /api/wx.  app.js calls show / hide /
 * refresh (every 5 min while shown) / layout.
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, String(v)); } catch (_) { /* private mode */ } };
  const pad = n => String(n).padStart(2, '0');
  const hm = ts => { const d = new Date(ts * 1000); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const light = () => document.documentElement.dataset.theme === 'light';
  const f1 = (v, d = 1, sign = false) => v == null ? '–' : (sign && v > 0 ? '+' : v < 0 ? '−' : sign ? '±' : '') + Math.abs(v).toFixed(d);
  const FT = 3.28084;

  const S = {
    hours: parseInt(lsGet('ms_app_mast_h', '24'), 10),
    top: parseInt(lsGet('ms_app_mast_top', '3000'), 10),
    apt: lsGet('ms_app_mast_apt', 'on'),
    aptMin: lsGet('ms_app_mast_aptmin', 'false') === 'true',
    days: parseInt(lsGet('ms_app_mast_days', '7'), 10),
    ck: lsGet('ms_app_mast_ck', 't'),
    // the mast in the boundary-layer charts (from 2026-11-01 night): fill — its 10-minute
    // steps fill the plot below its top; cols — narrow hourly columns at the right of each
    // hour (as the Windshear page), the Mode S cells beside them; off — Mode S only
    mfill: lsGet('ms_app_mast_fill', 'fill'),
    // the time series (from 2026-11-01 night): Mode S lines top / all / off, the mast 10-min or 1-h mean
    msLv: lsGet('ms_app_mast_ser_ms', 'top'),
    smooth: [10, 60, 0].includes(parseInt(lsGet('ms_app_mast_ser_sm', '10'), 10)) ? parseInt(lsGet('ms_app_mast_ser_sm', '10'), 10) : 10,   // 0: the mast off (2026-11-02)
    // the profile's sources: shared with the Sounding page's Mast tab
    modes: lsGet('ms_mast_modes', 'true') !== 'false',
    meps: lsGet('ms_mast_meps', 'true') !== 'false',
    sonde: lsGet('ms_mast_sonde', 'true') !== 'false',
    at: null,
  };
  if (![12, 24, 72].includes(S.hours)) S.hours = 24;
  if (![1500, 3000, 5000].includes(S.top)) S.top = 3000;
  if (![7, 30, 90].includes(S.days)) S.days = 7;
  if (!['fill', 'cols', 'off'].includes(S.mfill)) S.mfill = 'fill';
  if (!['top', 'all', 'off'].includes(S.msLv)) S.msLv = 'top';
  let on = false, seq = 0, busy = false;
  let msr = null;
  let ser = null, prof = null, bl = null, cmp = null, cmpAt = 0, cmpDays = 0, apt = null, fetched = 0;
  let dotsT = [], dotsW = [], dotsD = [];

  // ── data ────────────────────────────────────────────────────────────────
  async function load() {
    if (!on || busy) return;
    busy = true;
    const my = ++seq;
    const sub = $('app-sub');
    try {
      const needCmp = !cmp || cmpDays !== S.days || Date.now() - cmpAt > 15 * 60e3;
      const [a, p, b, c, box, m] = await Promise.all([
        fetch(`/api/mast?hours=${S.hours}`, { cache: 'no-store' }).then(r => r.json()),
        fetch(`/api/mast/profile${S.at ? '?at=' + S.at : ''}`, { cache: 'no-store' }).then(r => r.json()).catch(() => null),
        fetch(`/api/boundary?hours=${S.hours + 1}`, { cache: 'no-store' }).then(r => r.json()).catch(() => null),
        needCmp ? fetch(`/api/mast/compare?days=${S.days}`, { cache: 'no-store' }).then(r => r.json()).catch(() => null) : Promise.resolve(cmp),
        S.apt === 'on' && window.AptNow ? AptNow.load().catch(() => ({ d: { error: 'loading failed — trying again in a few minutes' } })) : Promise.resolve(apt),
        fetch(`/api/mast/modes?hours=${S.hours + 1}`, { cache: 'no-store' }).then(r => r.json()).catch(() => null),
      ]);
      if (my !== seq) return;
      ser = a; prof = p; bl = Array.isArray(b) ? b : null; apt = box; msr = m; fetched = Date.now();
      if (needCmp && c) { cmp = c; cmpAt = Date.now(); cmpDays = S.days; }
      const n = (ser.rows || []).length;
      if (sub && on) sub.textContent = n ? `Kivenlahti · newest ${hm(ser.rows[n - 1][0])} UTC · 24 km SW of the airport` : 'Kivenlahti · no observations yet';
    } catch (e) {
      console.warn('Mast:', e);
      if (sub && on) sub.textContent = 'Could not load the mast data.';
    } finally { busy = false; }
    render();
  }
  async function loadProfile(at) {
    S.at = at;
    try { prof = await (await fetch(`/api/mast/profile${at ? '?at=' + at : ''}`, { cache: 'no-store' })).json(); } catch (_) { /* keep */ }
    renderTiles(); renderProfile(); renderSeries();
  }

  // ── render ──────────────────────────────────────────────────────────────
  function render() {
    if (!on) return;
    renderApt(); renderTiles(); renderProfile(); renderCharts(); renderSeries(); renderCompare();
  }
  function renderApt() {
    const el = $('am-apt'), note = $('am-apt-note');
    el.hidden = S.apt !== 'on';
    note.hidden = S.apt !== 'on' || !note.textContent;
    if (S.apt !== 'on' || !window.AptNow) return;
    el.innerHTML = AptNow.html({ d: apt ? apt.d : null, met: apt ? apt.met : null, mast: apt ? apt.mast : null,
                                 min: S.aptMin, apt: typeof WS_AIRPORT_NAME !== 'undefined' ? WS_AIRPORT_NAME : 'EFHK' });
    el.classList.toggle('min', S.aptMin);
  }
  function renderTiles() {
    const el = $('am-tiles');
    const o = prof && prof.found ? prof.obs : null;
    const tile = (v, l) => `<div class="am-tile"><b>${v}</b><span>${l}</span></div>`;
    if (!o) { el.innerHTML = tile('–', 'no mast observation in the last 3 hours'); $('am-prof-hd').innerHTML = 'Profile'; return; }
    const top = o.wl.length - 1, tt = o.tl.length - 1;
    const dT = o.t[tt] != null && o.t[0] != null ? o.t[tt] - o.t[0] : null;
    const dry = -0.0098 * (o.tl[tt] - o.tl[0]);
    const stab = dT == null ? '' : dT > 0.3 ? 'inversion' : dT > dry + 0.6 ? 'stable' : dT < dry - 0.6 ? 'unstable' : 'well mixed';
    const shear = o.ws[top] != null && o.ws[0] != null ? (o.ws[top] - o.ws[0]) / ((o.wl[top] - o.wl[0]) * FT / 1000) : null;
    const wtxt = i => o.ws[i] != null && o.wd[i] != null ? `${String(Math.round(o.wd[i])).padStart(3, '0')}° ${Math.round(o.ws[i])}<small> kt</small>` : '–';
    el.innerHTML = [
      tile(`${wtxt(top)}${o.wg[top] != null ? `<small> G${Math.round(o.wg[top])}</small>` : ''}`, `wind ${o.wl[top]} m (${Math.round((o.wl[top] + (prof.elev_m || 44)) * FT).toLocaleString('en').replace(/,/g, ' ')} ft MSL)`),
      tile(dT != null ? `${f1(dT, 1, true)}<small> K</small>` : '–', `ΔT ${o.tl[tt]} − ${o.tl[0]} m · <b class="am-${stab.replace(' ', '-')}">${stab}</b>`),
      tile(shear != null ? `${f1(shear, 1, true)}<small> kt/1000 ft</small>` : '–', `wind shear ${o.wl[0]} → ${o.wl[top]} m`),
      tile(o.t[0] != null ? `${f1(o.t[0], 1, true)}<small> °C</small>` : '–', `${o.tl[0]} m · RH ${o.rh[0] != null ? Math.round(o.rh[0]) + ' %' : '–'} · ${hm(o.ts)} UTC`),
    ].join('');
    $('am-prof-hd').innerHTML = `Profile ${hm(o.ts)} UTC${S.at ? ' <button type="button" class="app-list-x" id="am-now">Now ×</button>' : ' · newest'}`;
  }
  function renderProfile() {
    const el = $('am-prof'), lg = $('am-prof-lg');
    if (!prof || !prof.found || !window.MastView || !MastView.profileSvg) { el.innerHTML = '<div class="app-small">No mast observation yet.</div>'; lg.innerHTML = ''; return; }
    const r = MastView.profileSvg(prof, { modes: S.modes, meps: S.meps, sonde: S.sonde }, { compact: true });
    el.innerHTML = r.svg;
    lg.innerHTML = r.legend.join(' · ') + ' · <span class="am-dim">- - dry adiabat</span>';
  }
  const viewW = () => Math.max(280, Math.min(720, $('v-mast').clientWidth - 8));
  function sizeCv(cv, W, H) {
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }
  function renderCharts() {
    const W = viewW(), H = Math.round(Math.max(230, Math.min(360, W * 0.72))), nowMs = Date.now();
    document.querySelectorAll('#am-mfill .app-chip').forEach(b => b.classList.toggle('on', b.dataset.v === S.mfill));
    const base = { bl: bl, hours: S.hours, fetchedMs: fetched, nowMs, top: S.top, mastElev: (ser && ser.station && ser.station.elev) || 44,
                   mastSteps: S.mfill === 'fill' ? ser : null, mast: S.mfill === 'cols' ? hourlyOf(ser) : null };
    dotsT = WsCondChart.drawBoundaryLayer(sizeCv($('am-blt'), W, H), W, H, $('am-blt-ro'), { ...base, field: 'temp' });
    dotsD = drawDt(sizeCv($('am-dt'), W, 64), W, 64, nowMs);
    dotsW = WsCondChart.drawBoundaryLayer(sizeCv($('am-blw'), W, H), W, H, $('am-blw-ro'), { ...base, field: 'wind', barbs: true });
  }
  // the time series (mast.js seriesSvg, compact; from 2026-11-01 night): wind speed, direction,
  // temperature (inverted, colder up) and ΔT; a tap gives the step's values and its profile
  let sgeo = null;
  function renderSeries() {
    const el = $('am-ser');
    if (!ser || !ser.rows || !ser.rows.length || !window.MastView || !MastView.seriesSvg) { el.innerHTML = '<div class="app-small">No observations in this period.</div>'; sgeo = null; return; }
    document.querySelectorAll('#am-ser-ms .app-chip').forEach(b => b.classList.toggle('on', b.dataset.v === S.msLv));
    document.querySelectorAll('#am-ser-sm .app-chip').forEach(b => b.classList.toggle('on', +b.dataset.v === S.smooth));
    const r = MastView.seriesSvg(ser, prof && prof.found ? prof.obs.ts : null, { compact: true, ms: msr, msLv: S.msLv, smooth: S.smooth });
    el.innerHTML = r.svg; sgeo = r.geo;
  }
  function pickSeries(e, load) {
    if (!sgeo) return;
    const svg = $('am-ser').querySelector('svg');
    if (!svg) return;
    const b = svg.getBoundingClientRect(), sx = (e.clientX - b.left) * sgeo.W / b.width;
    if (sx < sgeo.ml || sx > sgeo.ml + sgeo.pw) return;
    const t = sgeo.t0 + (sx - sgeo.ml) / sgeo.pw * (sgeo.t1 - sgeo.t0);
    let best = null, bd = Infinity;
    for (const r of sgeo.R) { const d = Math.abs(r[0] - t); if (d < bd) { bd = d; best = r; } }
    if (!best || bd > 1800) return;
    const cur = svg.querySelector('#mt-cur');
    if (cur) { const xx = sgeo.x(best[0]); cur.setAttribute('x1', xx); cur.setAttribute('x2', xx); cur.setAttribute('visibility', 'visible'); }
    const w = sgeo.wl.map((h, i) => `${h} m ${best[5][i] != null ? String(Math.round(best[5][i])).padStart(3, '0') + '°' : '–'} ${best[4][i] != null ? Math.round(best[4][i]) : '–'} kt G${best[6][i] != null ? Math.round(best[6][i]) : '–'}`).reverse().join(' · ');
    const n = sgeo.tl.length - 1;
    const tt = [n, Math.floor(n / 2), 0].map(i => `${sgeo.tl[i]} m ${f1(best[1][i], 1, true)} °C`).join(' · ');
    const dT = best[1][n] != null && best[1][0] != null ? best[1][n] - best[1][0] : null;
    const ml = MastView.msLine ? MastView.msLine(sgeo, best[0]) : '';
    $('am-ser-pick').textContent = !sgeo.mOn ? `${hm(best[0])} UTC\n${ml || 'Mode S: off'}`
      : `${hm(best[0])} UTC (${sgeo.sm ? '1-h mean' : '10-min mean'})\n${w}\n${tt}${dT != null ? ` · ΔT ${f1(dT, 1, true)} K` : ''}${ml ? '\n' + ml : ''}`;
    if (load && best[0] !== S.at) loadProfile(best[0]);
  }

  // the hour means of the 10-minute steps (a step at ts covers ts − 10 min … ts): mean
  // temperatures, vector-mean wind, the highest gust — the shape of /api/mast/hourly
  let hCache = null;
  function hourlyOf(sr) {
    if (!sr || !sr.rows) return null;
    if (hCache && hCache.src === sr) return hCache.v;
    const by = new Map(), nT = sr.tl.length, nW = sr.wl.length;
    for (const r of sr.rows) {
      const h = Math.floor((r[0] - 600) / 3600) * 3600;
      let a = by.get(h);
      if (!a) { a = { n: 0, t: Array(nT).fill(0), tn: Array(nT).fill(0), u: Array(nW).fill(0), v: Array(nW).fill(0), wn: Array(nW).fill(0), g: Array(nW).fill(null) }; by.set(h, a); }
      a.n++;
      for (let i = 0; i < nT; i++) if (r[1][i] != null) { a.t[i] += r[1][i]; a.tn[i]++; }
      for (let i = 0; i < nW; i++) {
        if (r[4][i] != null && r[5][i] != null) {
          const rad = r[5][i] * Math.PI / 180;
          a.u[i] += -r[4][i] * Math.sin(rad); a.v[i] += -r[4][i] * Math.cos(rad); a.wn[i]++;
        }
        if (r[6][i] != null) a.g[i] = Math.max(a.g[i] == null ? -1 : a.g[i], r[6][i]);
      }
    }
    const out = [...by.entries()].sort((x, y) => x[0] - y[0]).map(([ts, a]) => ({
      ts, n: a.n, tl: sr.tl, wl: sr.wl,
      t: a.t.map((x, i) => a.tn[i] ? x / a.tn[i] : null),
      ws: a.u.map((x, i) => a.wn[i] ? Math.hypot(x / a.wn[i], a.v[i] / a.wn[i]) : null),
      wd: a.u.map((x, i) => a.wn[i] ? (Math.atan2(-x / a.wn[i], -a.v[i] / a.wn[i]) * 180 / Math.PI + 360) % 360 : null),
      wg: a.g }));
    hCache = { src: sr, v: out };
    return out;
  }
  // ΔT top − 2 m per 10-minute step, on the charts' time axis (L 34, R 8 as drawBoundaryLayer)
  function drawDt(g, W, H, nowMs) {
    const L = 34, R = 8, T = 14, B = 6, PW = W - L - R, PH = H - T - B, dots = [];
    const t0 = nowMs - S.hours * 3600e3, x = ms => L + (ms - t0) / (S.hours * 3600e3) * PW;
    const Ld = light();
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-1').trim() || (Ld ? '#fff' : '#162030');
    g.clearRect(0, 0, W, H); g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const rows = ser && ser.rows ? ser.rows.filter(r => r[0] * 1000 > t0) : [];
    const tl = ser ? ser.tl : [2, 297], n = tl.length - 1, dry = -0.0098 * (tl[n] - tl[0]);
    let lo = -2, hi = 2;
    for (const r of rows) if (r[1][n] != null && r[1][0] != null) { const v = r[1][n] - r[1][0]; lo = Math.min(lo, v); hi = Math.max(hi, v); }
    lo = Math.max(-6, Math.floor(lo)); hi = Math.min(8, Math.ceil(hi));
    const y = v => T + PH * (1 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo));
    g.strokeStyle = Ld ? '#cbd5e1' : '#334155'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(L, Math.round(y(0)) + 0.5); g.lineTo(L + PW, Math.round(y(0)) + 0.5); g.stroke();
    g.setLineDash([4, 3]); g.beginPath(); g.moveTo(L, y(dry)); g.lineTo(L + PW, y(dry)); g.stroke(); g.setLineDash([]);
    const cInv = Ld ? '#7c3aed' : '#a78bfa', cUn = Ld ? '#c2410c' : '#fb923c', cN = Ld ? '#94a3b8' : '#64748b';
    for (const r of rows) {
      const a = r[1][n], b = r[1][0];
      if (a == null || b == null) continue;
      const v = a - b, xa = x(r[0] * 1000 - 600e3), xb = x(r[0] * 1000);
      g.fillStyle = v > 0.3 ? cInv : v < dry - 0.6 ? cUn : cN;
      g.fillRect(xa, Math.min(y(v), y(0)), Math.max(0.8, xb - xa), Math.max(1, Math.abs(y(v) - y(0))));
      dots.push({ x: (xa + xb) / 2, y: y(v), dotR: 6, ts: r[0],
        label: `${hm(r[0])}Z mast ΔT ${tl[n]} − ${tl[0]} m: ${f1(v, 1, true)} K — ${v > 0.3 ? 'inversion (warmer aloft)' : v < dry - 0.6 ? 'unstable (super-adiabatic)' : v > dry + 0.6 ? 'stable' : 'well mixed'} (dry-adiabatic ${f1(dry, 1, true)} K)` });
    }
    g.font = '9px "Courier New",monospace'; g.fillStyle = Ld ? '#475569' : '#94a3b8'; g.textBaseline = 'middle'; g.textAlign = 'right';
    g.fillText('0', L - 4, y(0)); g.fillText(`${hi > 0 ? '+' : ''}${hi}`, L - 4, y(hi) + 3); g.fillText(String(lo), L - 4, y(lo) - 2);
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillText(`ΔT ${tl[n]}−${tl[0]} m (K) · `, 5, 2);
    const w0 = g.measureText(`ΔT ${tl[n]}−${tl[0]} m (K) · `).width;
    g.fillStyle = cInv; g.fillText('inversion', 5 + w0, 2);
    const w1 = g.measureText('inversion').width;
    g.fillStyle = Ld ? '#475569' : '#94a3b8'; g.fillText(' · - - dry-adiabatic', 5 + w0 + w1, 2);
    g.strokeStyle = Ld ? '#cbd5e1' : '#334155'; g.strokeRect(L + 0.5, T + 0.5, PW, PH);
    return dots;
  }
  function renderCompare() {
    const el = $('am-cmp');
    document.querySelectorAll('#am-cmp-k .app-chip').forEach(b => b.classList.toggle('on', b.dataset.v === S.ck));
    document.querySelectorAll('#am-cmp-d .app-chip').forEach(b => b.classList.toggle('on', +b.dataset.v === S.days));
    if (!cmp || !cmp.sources) { el.innerHTML = '<div class="app-small">No comparison yet.</div>'; return; }
    const E = (cmp.station && cmp.station.elev) || 44, ftOf = m => Math.round((m + E) * FT).toLocaleString('en').replace(/,/g, ' ');
    const src = [['modes', 'Mode S'], ['meps', 'MEPS'], ['sonde', 'Sonde']];
    const C = cmp.sources;
    let h;
    if (S.ck === 't') {
      h = '<table class="app-list am-cmp"><thead><tr><th>Level</th>' + src.map(([, n]) => `<th class="num">${n}</th>`).join('') + '</tr></thead><tbody>' +
        cmp.tl.slice().reverse().map(lv => '<tr><td>' + `${lv} m <span class="dim">${ftOf(lv)} ft</span></td>` + src.map(([k]) => {
          const r = ((C[k] || {}).temp || []).find(x => x.h_m === lv) || {};
          return r.n ? `<td class="num${Math.abs(r.bias) >= 1.5 ? ' am-big' : ''}">${f1(r.bias, 1, true)}<span class="dim"> / ${f1(r.rms, 1)}</span><br><span class="dim">n ${r.n}</span></td>` : '<td class="num dim">–</td>';
        }).join('') + '</tr>').join('') + '</tbody></table>';
    } else {
      h = '<table class="app-list am-cmp"><thead><tr><th>Level</th>' + src.map(([, n]) => `<th class="num">${n}</th>`).join('') + '</tr></thead><tbody>' +
        cmp.wl.slice().reverse().map(lv => '<tr><td>' + `${lv} m <span class="dim">${ftOf(lv)} ft</span></td>` + src.map(([k]) => {
          const r = ((C[k] || {}).wind || []).find(x => x.h_m === lv) || {};
          return r.n ? `<td class="num${Math.abs(r.spd_bias) >= 5 ? ' am-big' : ''}">${f1(r.spd_bias, 1, true)} kt<span class="dim"> / ${f1(r.vrms, 0)}</span><br><span class="dim">${r.dir_bias != null ? f1(r.dir_bias, 0, true) + '° · ' : ''}n ${r.n}</span></td>` : '<td class="num dim">–</td>';
        }).join('') + '</tr>').join('') + '</tbody></table>';
    }
    const sf = C.meps_sfc || {};
    h += `<div class="app-small">${S.ck === 't'
      ? 'Source − mast at the same height above the ground, mean / RMS in K (+ = the source warmer). '
      : 'Source − mast, speed difference in kt / vector RMS (+ = the source stronger), direction difference in ° (winds of 5 kt or more; + = veered). '}`
      + `Last ${cmp.days} days, ${cmp.hours} mast hours: Mode S in ${cmp.n_modes}, MEPS in ${cmp.n_meps}, ${cmp.n_sonde} soundings. `
      + (S.ck === 't' ? `MEPS 2 m at the mast: ${sf.t2m ? `${f1(sf.t2m.bias, 1, true)} K (RMS ${f1(sf.t2m.rms, 1)}, n ${sf.t2m.n})` : '–'}.`
                      : `MEPS 10 m wind against the mast's ${cmp.wl[0]} m: ${sf.w10 ? `${f1(sf.w10.spd_bias, 1, true)} kt (vector RMS ${f1(sf.w10.vrms, 0)}, n ${sf.w10.n})` : '–'}.`)
      + '</div>';
    el.innerHTML = h;
  }

  // ── taps ────────────────────────────────────────────────────────────────
  function pick(cv, dots, out, e, hint) {
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = 18 * 18;
    for (const d of dots) { const dd = (d.x - x) ** 2 + (d.y - y) ** 2; if (dd < bd) { bd = dd; best = d; } }
    out.textContent = best ? best.label : hint;
    return best;
  }
  function bindCv(id, getDots, outId, hint) {
    const cv = $(id), out = $(outId);
    const f = e => {
      const b = pick(cv, getDots(), out, e, hint);
      if (b && b.ts && e.type === 'pointerdown' && b.ts !== S.at) loadProfile(b.ts);
    };
    cv.addEventListener('pointerdown', f);
    cv.addEventListener('pointermove', e => { if (e.pointerType !== 'mouse' || e.buttons) f(e); });
  }

  let inited = false;
  function init() {
    if (inited) return;
    inited = true;
    const HINT = 'Tap the chart for its values; a tap on the mast (below the amber line) also shows its profile of that time.';
    bindCv('am-blt', () => dotsT, 'am-blt-pick', HINT);
    bindCv('am-dt', () => dotsD, 'am-blt-pick', HINT);
    bindCv('am-blw', () => dotsW, 'am-blw-pick', HINT);
    $('am-ser').addEventListener('pointerdown', e => pickSeries(e, true));
    document.querySelectorAll('#am-ser-ms .app-chip').forEach(b => b.addEventListener('click', () => {
      S.msLv = b.dataset.v; lsSet('ms_app_mast_ser_ms', S.msLv); renderSeries(); }));
    document.querySelectorAll('#am-ser-sm .app-chip').forEach(b => b.addEventListener('click', () => {
      S.smooth = +b.dataset.v; lsSet('ms_app_mast_ser_sm', S.smooth); renderSeries(); }));
    $('am-ser').addEventListener('pointermove', e => { if (e.pointerType !== 'mouse' || e.buttons) pickSeries(e, false); });
    $('am-apt').addEventListener('click', e => {
      if (e.target.closest('.lwx-apt-min')) {
        S.aptMin = !S.aptMin; lsSet('ms_app_mast_aptmin', S.aptMin);
        $('am-apt-note').textContent = ''; renderApt(); return;
      }
      const t = e.target.closest('[title]');
      const note = $('am-apt-note');
      note.textContent = t ? t.getAttribute('title') : '';
      note.hidden = !note.textContent;
    });
    $('am-prof').addEventListener('click', e => {
      const t = e.target.closest('g, circle, rect, line');
      const ti = t && (t.querySelector(':scope > title') || (t.parentNode && t.parentNode.querySelector && t.parentNode.querySelector(':scope > title')));
      $('am-prof-note').textContent = ti ? ti.textContent : 'Tap a point or a barb for its values.';
    });
    $('v-mast').addEventListener('click', e => { if (e.target.id === 'am-now') loadProfile(null); });
    document.querySelectorAll('#am-mfill .app-chip').forEach(b => b.addEventListener('click', () => {
      S.mfill = b.dataset.v; lsSet('ms_app_mast_fill', S.mfill); renderCharts(); }));
    document.querySelectorAll('#am-cmp-k .app-chip').forEach(b => b.addEventListener('click', () => {
      S.ck = b.dataset.v; lsSet('ms_app_mast_ck', S.ck); renderCompare(); }));
    document.querySelectorAll('#am-cmp-d .app-chip').forEach(b => b.addEventListener('click', async () => {
      S.days = +b.dataset.v; lsSet('ms_app_mast_days', S.days); renderCompare();
      try { cmp = await (await fetch(`/api/mast/compare?days=${S.days}`, { cache: 'no-store' })).json(); cmpAt = Date.now(); cmpDays = S.days; } catch (_) { /* keep */ }
      renderCompare();
    }));
    // the menu's Mast options (selects shown as chips by app.js)
    const opt = (id, key, val, apply) => {
      const s = $(id);
      if (!s) return;
      s.value = String(val);
      s.addEventListener('change', () => { lsSet(key, s.value); apply(s.value); });
    };
    opt('app-mast-h', 'ms_app_mast_h', S.hours, v => { S.hours = +v; load(); });
    opt('app-mast-top', 'ms_app_mast_top', S.top, v => { S.top = +v; renderCharts(); });
    opt('app-mast-apt', 'ms_app_mast_apt', S.apt, v => { S.apt = v; renderApt(); if (v === 'on') { busy = false; load(); } });
    for (const [id, k] of [['app-mast-modes', 'modes'], ['app-mast-meps', 'meps'], ['app-mast-sonde', 'sonde']]) {
      const c = $(id);
      if (!c) continue;
      c.checked = S[k];
      c.addEventListener('change', () => { S[k] = c.checked; lsSet('ms_mast_' + k, S[k]); renderProfile(); });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  window.AppMast = {
    show() { init(); on = true; render(); load(); },
    hide() { on = false; },
    refresh() { if (on && !document.hidden) load(); },
    layout() { if (on) render(); },
  };
})();
