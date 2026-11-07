/**
 * meteogram.js — a meteogram of MEPS and / or GFS at one place (from 2026-11-05).
 *
 * Shared by the Weather page's Meteogram view (weather_mg.js) and the phone's
 * Meteogram view (app_mg.js).  The data: /api/weather/meteogram (web/api/weather.py
 * meteogram) — every stored model hour at the grid cell of the place, in the
 * frames' encoding (p (hPa − 1000) × 10, t °C × 10, r all precipitation / s its snow
 * part mm per hour × 100, u / v / g kt, c / l / m / h / f %, b m — the cloud base with
 * MEPS, the ceiling with GFS; GFS's 3-hour steps after +120 h: pi = 3).
 *
 *   Meteogram.render(el, {meps, gfs}, opts) → {destroy()}
 *     opts.panels  {temp, precip, wind, pres, cloud} (true = drawn)
 *     opts.compact the phone's smaller layout
 *     opts.now     (s) the now-line; default the clock
 *     opts.onRead  fn(text) — the hover / touch read-out; default a line above the chart
 *     opts.t850    (from 2026-11-07) the 850 hPa temperature in the temperature panel: the
 *                  models' line (field t8; fuchsia, GFS thin and dashed with Both) and
 *                  MODE-S Wind's own measured value of the past hours (data.*.o850 — the hourly
 *                  aircraft profile, places within its radius of the receiver) as dots
 *
 * One time axis (UTC) for all panels: day lines and labels, the night shaded from the
 * sun's elevation at the place, the forecast tinted, the now-line.  With both models
 * ("Both") GFS is drawn thin and dashed over its whole range and MEPS bold over its own;
 * the barbs, clouds and daily totals come from MEPS where it has the hour, else GFS.
 * Plain SVG, drawn again on a resize.
 */
'use strict';

const Meteogram = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const HOUR = 3600, DAY = 86400;
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const light = () => document.documentElement.dataset.theme === 'light';
  function pal() {
    const L = light();
    return {
      text: L ? '#1f2937' : '#d1d5db', dim: L ? '#6b7280' : '#8b95a5', grid: L ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)',
      day: L ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.22)', night: L ? 'rgba(30,41,59,0.07)' : 'rgba(0,0,0,0.28)',
      fc: L ? 'rgba(124,58,237,0.045)' : 'rgba(168,85,247,0.06)', now: L ? '#7c3aed' : '#c084fc',
      warm: L ? '#dc2626' : '#f87171', cold: L ? '#2563eb' : '#60a5fa', zero: L ? 'rgba(37,99,235,0.45)' : 'rgba(96,165,250,0.45)',
      rain: '#3b82f6', snow: '#a78bfa', wind: L ? '#0f766e' : '#2dd4bf', gust: L ? '#ea580c' : '#fb923c',
      pres: L ? '#374151' : '#cbd5e1', cloud: L ? '96,105,120' : '200,206,214', fog: L ? '161,98,7' : '250,204,21',
      barb: L ? '#111827' : '#e5e7eb', panel: L ? 'rgba(0,0,0,0.025)' : 'rgba(255,255,255,0.025)',
      band: L ? 'rgba(71,85,105,0.16)' : 'rgba(203,213,225,0.15)',
      t850: L ? '#c026d3' : '#e879f9',
    };
  }

  // ── the sun at a place (for the night shading): elevation in degrees ──────
  function sunElev(lat, lon, ts) {
    const d = ts / DAY - 10957.5;                          // days since J2000.0
    const g = (357.529 + 0.98560028 * d) * Math.PI / 180;
    const q = 280.459 + 0.98564736 * d;
    const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * Math.PI / 180;
    const e = (23.439 - 0.00000036 * d) * Math.PI / 180;
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
    const ha = ((gmst * 15 + lon) * Math.PI / 180) - ra;
    const la = lat * Math.PI / 180;
    return Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha)) * 180 / Math.PI;
  }

  // ── a wind barb (wind from dir, kt) as SVG, centred at the station point ──
  function barbSvg(x, y, dir, kt, col, len = 17) {
    if (kt < 2.5) return `<circle cx="${x}" cy="${y}" r="3" fill="none" stroke="${col}" stroke-width="1.2"/>`;
    let k = Math.round(kt / 5) * 5, p = '', pos = -len;
    const f = len * 0.45;
    p += `M0 0L0 ${-len}`;
    while (k >= 50) { p += `M0 ${pos}L${f} ${pos + 3}L0 ${pos + 6}Z`; pos += 7; k -= 50; }
    while (k >= 10) { p += `M0 ${pos}L${f} ${pos - 3.5}`; pos += 3.5; k -= 10; }
    if (k >= 5) { if (pos === -len) pos += 3.5; p += `M0 ${pos}L${f / 2} ${pos - 1.75}`; }
    return `<g transform="translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${Math.round(dir)})"><path d="${p}" fill="${col}" stroke="${col}" stroke-width="1.2" stroke-linecap="round"/></g>`;
  }
  const windDir = (u, v) => (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;

  // ── one model's series in plain units ─────────────────────────────────────
  // the typical error by lead day (from 2026-11-06, /api/weather/gfs_skill): {day: {t, ws}} → the
  // band of a point (8 in 10 of the checked hours were within ± this)
  const leadDay = lead => Math.max(1, Math.ceil((lead || 0) / 24));
  function series(d, key, err) {
    if (!d || !d.ts || !d.ts.length) return null;
    const v = d.v || {}, n = d.ts.length, g = (f, i) => (v[f] ? v[f][i] : null);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const u = g('u', i), w = g('v', i);
      pts.push({
        ts: d.ts[i], run: d.run[i], lead: d.lead[i], pi: d.pi ? d.pi[i] || 1 : 1, fine: d.fine ? d.fine[i] : 0,
        t: g('t', i) == null ? null : g('t', i) / 10, p: g('p', i) == null ? null : 1000 + g('p', i) / 10,
        r: g('r', i) == null ? null : g('r', i) / 100, s: g('s', i) == null ? null : g('s', i) / 100,
        ws: u == null || w == null ? null : Math.hypot(u, w), wd: u == null || w == null ? null : windDir(u, w),
        gu: g('g', i), c: g('c', i), l: g('l', i), m: g('m', i), h: g('h', i), f: g('f', i), b: g('b', i),
        t8: g('t8', i) == null ? null : g('t8', i) / 10,
      });
      const e = err && err[leadDay(d.lead[i])];
      if (e) { pts[i].et = e.t; pts[i].ew = e.ws; }
    }
    return { key, d, pts, t0: d.ts[0] - (pts[0].pi || 1) * HOUR, t1: d.ts[n - 1], hasFog: !!v.f };
  }
  // the point of a series nearest ts (within its step)
  function nearest(S, ts) {
    if (!S) return null;
    let best = null, bd = Infinity;
    for (const q of S.pts) { const x = Math.abs(q.ts - ts); if (x < bd) { bd = x; best = q; } }
    return best && bd <= (best.pi || 1) * HOUR * 0.75 + 1 ? best : null;
  }

  // ── the chart ─────────────────────────────────────────────────────────────
  function render(el, data, opts = {}) {
    const C = !!opts.compact;
    const P0 = Object.assign({ temp: true, precip: true, wind: true, pres: true, cloud: true }, opts.panels || {});
    const EB = opts.errBand || null;           // {gfs: {day: {t, ws}}, meps: {…}, where} or null
    // MEPS's own band where its days are known; until then (its first runs being checked) GFS's of the
    // same lead day, so the first days are not left without a band (from 2026-11-06 evening)
    const EM = EB && (EB.meps || EB.gfs) ? Object.assign({}, EB.gfs || {}, EB.meps || {}) : null;
    const SM = series(data.meps, 'meps', EM), SG = series(data.gfs, 'gfs', EB && EB.gfs);
    const both = !!(SM && SG);
    const prim = SG || SM;                       // the axis range and the daily labels
    // the 850 hPa temperature (from 2026-11-07): the models' t8 and the measured values [[ts, °C, n]]
    const T8 = !!opts.t850;
    const O8 = T8 ? (((data.meps && data.meps.o850) || (data.gfs && data.gfs.o850) || [])) : [];
    el.innerHTML = '';
    if (!prim) { el.innerHTML = `<div class="mg-empty">${esc(opts.emptyText || 'No model hours for this place.')}</div>`; return { destroy() {} }; }
    const read = document.createElement('div');
    read.className = 'mg-read';
    const box = document.createElement('div');
    box.className = 'mg-svgbox';
    el.appendChild(read); el.appendChild(box);
    const lat = (data.meps || data.gfs).lat, lon = (data.meps || data.gfs).lon;
    let ro = null, raf = 0;

    function draw() {
      const T = pal();
      const W = Math.max(280, box.clientWidth || el.clientWidth || 600);
      const AL = C ? 34 : 46, AR = C ? 8 : 14, TOP = C ? 30 : 34, GAP = C ? 6 : 9;
      const H = { temp: C ? 112 : 150, precip: C ? 54 : 80, wind: C ? 92 : 118, pres: C ? 58 : 78, cloud: 0 };
      const rowH = C ? 10 : 13;
      const fogRow = (SM && SM.hasFog) ? 1 : 0;
      H.cloud = (3 + fogRow) * rowH + (C ? 14 : 18);
      const panels = ['temp', 'precip', 'wind', 'pres', 'cloud'].filter(k => P0[k]);
      const t0 = Math.min(...[SM, SG].filter(Boolean).map(s => s.t0)), t1 = Math.max(...[SM, SG].filter(Boolean).map(s => s.t1));
      const pw = W - AL - AR, X = ts => AL + (ts - t0) / (t1 - t0) * pw;
      const now = opts.now || Date.now() / 1000;
      let y = TOP;
      const box0 = {};
      panels.forEach(k => { box0[k] = { y0: y, y1: y + H[k] }; y += H[k] + GAP; });
      const Ht = y - GAP + (C ? 16 : 20);
      const out = [];
      const line = (pts, col, w, dash, op = 1) => pts.length < 2 ? '' :
        `<path d="${pts.map((p, i) => `${i && !p.gap ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('')}" fill="none" stroke="${col}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-linejoin="round" stroke-linecap="round" opacity="${op}"/>`;
      const txt = (x, yy, s, o = {}) => `<text x="${x.toFixed(1)}" y="${yy.toFixed(1)}" font-size="${o.fs || (C ? 9 : 10.5)}" fill="${o.col || T.dim}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.w ? ` font-weight="${o.w}"` : ''}>${esc(s)}</text>`;
      // the points of a value, broken where missing or the step gap is larger than the model's step
      const path = (S, f, Y) => {
        const r = []; let prev = null;
        for (const q of S.pts) {
          const v = typeof f === 'function' ? f(q) : q[f];
          if (v == null) { prev = null; continue; }
          r.push({ x: X(q.ts), y: Y(v), gap: !prev || q.ts - prev.ts > (q.pi || 1) * HOUR * 1.6 });
          prev = q;
        }
        return r;
      };
      const meps1 = SM ? SM.t1 : -Infinity, mepsT0 = SM ? SM.t0 : Infinity;
      const pick = q => (SM && q.ts > mepsT0 && q.ts <= meps1);          // MEPS has this time (Both)
      // the typical-error band of a value (f, its error e) — with both models, MEPS's over its own
      // hours and GFS's after them; broken where the error is not known (yet)
      let banded = false;
      const band = (S, f, e, Y, lo0) => {
        const segs = []; let cur = [], prev = null;
        for (const q of S.pts) {
          const v = q[f], er = q[e];
          const skip = (both && S.key === 'gfs' && pick(q)) || q.ts < now - HOUR;   // the forecast part only
          if (v == null || er == null || skip || (prev && q.ts - prev.ts > (q.pi || 1) * HOUR * 1.6)) {
            if (cur.length > 1) segs.push(cur);
            cur = [];
            if (v == null || er == null || skip) { prev = null; continue; }
          }
          cur.push({ x: X(q.ts), a: Y(v + er), b: Y(lo0 == null ? v - er : Math.max(lo0, v - er)) });
          prev = q;
        }
        if (cur.length > 1) segs.push(cur);
        segs.forEach(sg => {
          banded = true;
          out.push(`<path d="${sg.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.a.toFixed(1)}`).join('')}${sg.slice().reverse().map(p => `L${p.x.toFixed(1)} ${p.b.toFixed(1)}`).join('')}Z" fill="${T.band}" stroke="none"/>`);
        });
      };
      const bandVals = (f, e) => [SM, SG].filter(Boolean).flatMap(S => S.pts.flatMap(q => q[f] != null && q[e] != null ? [q[f] - q[e], q[f] + q[e]] : []));
      // background: panels, night, forecast tint, day lines
      out.push(`<defs><clipPath id="mgc"><rect x="${AL}" y="0" width="${pw}" height="${Ht}"/></clipPath></defs>`);
      panels.forEach(k => out.push(`<rect x="${AL}" y="${box0[k].y0}" width="${pw}" height="${H[k]}" fill="${T.panel}"/>`));
      // night (the sun below the horizon at the place)
      let nightFrom = null;
      for (let t = Math.floor(t0 / 1800) * 1800; t <= t1 + 1800; t += 1800) {
        const dark = sunElev(lat, lon, t) < -0.833;
        if (dark && nightFrom == null) nightFrom = t;
        if ((!dark || t > t1) && nightFrom != null) {
          const a = Math.max(t0, nightFrom), b = Math.min(t1, t);
          if (b > a) panels.forEach(k => out.push(`<rect x="${X(a).toFixed(1)}" y="${box0[k].y0}" width="${(X(b) - X(a)).toFixed(1)}" height="${H[k]}" fill="${T.night}"/>`));
          nightFrom = null;
        }
      }
      if (now < t1) panels.forEach(k => { const a = Math.max(t0, now); out.push(`<rect x="${X(a).toFixed(1)}" y="${box0[k].y0}" width="${(X(t1) - X(a)).toFixed(1)}" height="${H[k]}" fill="${T.fc}"/>`); });
      const dayW = DAY / (t1 - t0) * pw;
      for (let t = Math.ceil(t0 / DAY) * DAY; t <= t1; t += DAY) {
        out.push(`<line x1="${X(t).toFixed(1)}" x2="${X(t).toFixed(1)}" y1="${TOP - 4}" y2="${y - GAP}" stroke="${T.day}" stroke-width="1"/>`);
      }
      for (let t = Math.floor(t0 / DAY) * DAY; t <= t1; t += DAY) {
        const a = Math.max(t0, t), b = Math.min(t1, t + DAY);
        if (X(b) - X(a) < 14) continue;
        const dt = new Date(t * 1000);
        const lab = dayW >= 78 ? `${WD[dt.getUTCDay()]} ${dt.getUTCDate()}.${dt.getUTCMonth() + 1}.` : dayW >= 34 ? `${WD[dt.getUTCDay()].slice(0, 2)} ${dt.getUTCDate()}.` : `${dt.getUTCDate()}`;
        out.push(txt((X(a) + X(b)) / 2, TOP - (C ? 18 : 20), lab, { anchor: 'middle', col: T.text, w: 600 }));
      }
      // hour ticks when the days are wide
      const tickH = dayW >= 260 ? 3 : dayW >= 130 ? 6 : dayW >= 70 ? 12 : 0;
      if (tickH) for (let t = Math.ceil(t0 / (tickH * HOUR)) * tickH * HOUR; t <= t1; t += tickH * HOUR) {
        const h = new Date(t * 1000).getUTCHours();
        if (h === 0) continue;
        out.push(txt(X(t), TOP - 6, String(h).padStart(2, '0'), { anchor: 'middle', fs: C ? 8 : 9 }));
      }
      const ylab = (k, s) => out.push(txt(4, box0[k].y0 + (C ? 9 : 11), s, { col: T.text, fs: C ? 8.5 : 10, w: 600 }));
      const yaxis = (k, lo, hi, step, fmt, Y) => {
        // at least ~15 px between the labels (a larger step from 1-2-5 when needed)
        const pxU = Math.abs(Y(lo) - Y(hi)) / Math.max(1e-9, hi - lo);
        const cand = [0.5, 1, 2, 5, 10, 20, 25, 50, 100];
        if (step * pxU < (C ? 13 : 15)) step = cand.find(c => c >= step && c * pxU >= (C ? 13 : 15)) || step * 4;
        for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
          const yy = Y(v);
          if (yy < box0[k].y0 + (C ? 12 : 14) || yy > box0[k].y1 - 2) continue;
          out.push(`<line x1="${AL}" x2="${AL + pw}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="${T.grid}"/>`);
          out.push(txt(AL - 3, yy + 3, fmt(v), { anchor: 'end', fs: C ? 8 : 9 }));
        }
      };
      const lines = [];                          // the drawn series (both models), for the order MEPS on top
      // 1 temperature
      if (P0.temp) {
        const b = box0.temp, vals = [SM, SG].filter(Boolean).flatMap(S => S.pts.flatMap(q => T8 ? [q.t, q.t8] : [q.t])).filter(v => v != null).concat(bandVals('t', 'et'))
          .concat(O8.filter(o => o[0] >= t0 && o[0] <= t1).map(o => o[1]));
        if (vals.length) {
          let lo = Math.min(...vals), hi = Math.max(...vals);
          const pad = Math.max(1, (hi - lo) * 0.12); lo -= pad; hi += pad;
          const Y = v => b.y1 - 4 - (v - lo) / (hi - lo) * (H.temp - (C ? 16 : 20));
          const st = hi - lo > 30 ? 10 : hi - lo > 12 ? 5 : 2;
          ylab('temp', '°C');
          yaxis('temp', lo, hi, st, v => (v > 0 ? '+' : '') + v, Y);
          const yz = Y(0);
          if (lo < 0 && hi > 0) out.push(`<line x1="${AL}" x2="${AL + pw}" y1="${yz.toFixed(1)}" y2="${yz.toFixed(1)}" stroke="${T.zero}" stroke-width="1.3"/>`);
          for (const S of [SG, SM].filter(Boolean)) band(S, 't', 'et', Y);
          const zc = Math.max(b.y0, Math.min(b.y1, yz));
          out.push(`<clipPath id="mgw"><rect x="${AL}" y="${b.y0}" width="${pw}" height="${(zc - b.y0).toFixed(1)}"/></clipPath>`
                 + `<clipPath id="mgk"><rect x="${AL}" y="${zc.toFixed(1)}" width="${pw}" height="${(b.y1 - zc).toFixed(1)}"/></clipPath>`);
          for (const S of [SG, SM].filter(Boolean)) {
            const p = path(S, 't', Y), thin = both && S.key === 'gfs';
            for (const [clip, col] of [['mgw', T.warm], ['mgk', T.cold]])
              out.push(`<g clip-path="url(#${clip})">${line(p, col, thin ? 1.3 : C ? 1.8 : 2.2, thin ? '4 3' : '', thin ? 0.85 : 1)}</g>`);
          }
          // the 850 hPa temperature: the models' line and the measured dots (from 2026-11-07)
          if (T8) {
            for (const S of [SG, SM].filter(Boolean)) {
              const thin = both && S.key === 'gfs';
              out.push(line(path(S, 't8', Y), T.t850, thin ? 1.1 : C ? 1.4 : 1.7, thin ? '4 3' : '', thin ? 0.8 : 0.95));
            }
            for (const o of O8) {
              if (o[0] < t0 || o[0] > t1) continue;
              out.push(`<circle cx="${X(o[0]).toFixed(1)}" cy="${Y(o[1]).toFixed(1)}" r="${C ? 2.2 : 2.6}" fill="${T.t850}" stroke="${light() ? '#fff' : '#111827'}" stroke-width="0.8"/>`);
            }
          }
          // the day's highest and lowest (the primary model) when the days are wide enough
          if (dayW >= 64) for (let t = Math.floor(t0 / DAY) * DAY; t <= t1; t += DAY) {
            const day = (prim.pts).filter(q => q.ts > t && q.ts <= t + DAY && q.t != null && (!both || !pick(q)))
              .concat(both && SM ? SM.pts.filter(q => q.ts > t && q.ts <= t + DAY && q.t != null) : []);
            if (day.length < 4) continue;
            const mx = day.reduce((a, q) => q.t > a.t ? q : a), mn = day.reduce((a, q) => q.t < a.t ? q : a);
            out.push(txt(X(mx.ts), Y(mx.t) - 5, (mx.t > 0 ? '+' : '') + Math.round(mx.t), { anchor: 'middle', col: T.warm, fs: C ? 8 : 9.5, w: 600 }));
            out.push(txt(X(mn.ts), Y(mn.t) + 12, (mn.t > 0 ? '+' : '') + Math.round(mn.t), { anchor: 'middle', col: T.cold, fs: C ? 8 : 9.5, w: 600 }));
          }
          lines.push({ k: 'temp', Y });
        }
      }
      // 2 precipitation
      if (P0.precip) {
        const b = box0.precip, all = [SM, SG].filter(Boolean).flatMap(S => S.pts.map(q => q.r)).filter(v => v != null);
        const mx = Math.max(1, Math.ceil(Math.max(0, ...all)));
        const Y = v => b.y1 - v / mx * (H.precip - (C ? 14 : 18));
        ylab('precip', 'mm/h');
        yaxis('precip', 0, mx, mx > 6 ? 2 : mx > 2 ? 1 : 0.5, v => String(v), Y);
        for (const S of [SG, SM].filter(Boolean)) {
          const thin = both && S.key === 'gfs';
          for (const q of S.pts) {
            if (!q.r || q.r < 0.05) continue;
            let xa = X(q.ts - (q.pi || 1) * HOUR), xb = X(q.ts);
            if (both && S.key === 'meps') { const c = (xa + xb) / 2, w = (xb - xa) * 0.3; xa = c - w; xb = c + w; }
            const w = Math.max(0.8, xb - xa - (xb - xa > 3 ? 0.6 : 0));
            const sn = Math.min(q.r, q.s || 0), rn = q.r - sn;
            if (rn > 0) out.push(`<rect x="${xa.toFixed(1)}" y="${Y(rn).toFixed(1)}" width="${w.toFixed(1)}" height="${(b.y1 - Y(rn)).toFixed(1)}" fill="${T.rain}" opacity="${thin ? 0.4 : 0.9}"/>`);
            if (sn > 0) out.push(`<rect x="${xa.toFixed(1)}" y="${Y(q.r).toFixed(1)}" width="${w.toFixed(1)}" height="${(Y(rn) - Y(q.r)).toFixed(1)}" fill="${T.snow}" opacity="${thin ? 0.45 : 0.95}"/>`);
          }
        }
        // the day's total (mm), from MEPS where it has the hour, else GFS
        if (dayW >= 22) for (let t = Math.floor(t0 / DAY) * DAY; t <= t1; t += DAY) {
          let sum = 0, n = 0;
          for (const S of [SM, SG].filter(Boolean)) for (const q of S.pts) {
            if (q.ts <= t || q.ts > t + DAY || q.r == null) continue;
            if (both && S.key === 'gfs' && pick(q)) continue;
            sum += q.r * (q.pi || 1); n++;
          }
          if (!n || sum < 0.1) continue;
          const a = Math.max(t0, t), bb = Math.min(t1, t + DAY);
          out.push(txt((X(a) + X(bb)) / 2, b.y0 + (C ? 9 : 11), sum >= 10 ? Math.round(sum) + (dayW >= 40 ? ' mm' : '') : sum.toFixed(1) + (dayW >= 40 ? ' mm' : ''), { anchor: 'middle', col: T.rain, fs: C ? 8 : 9.5, w: 600 }));
        }
      }
      // 3 wind
      if (P0.wind) {
        const b = box0.wind, all = [SM, SG].filter(Boolean).flatMap(S => S.pts.flatMap(q => [q.ws, q.gu])).filter(v => v != null).concat(bandVals('ws', 'ew'));
        const mx = Math.max(20, Math.ceil(Math.max(0, ...all) * 1.1 / 5) * 5);
        const top = C ? 26 : 32;                    // the barbs' row
        const Y = v => b.y1 - 3 - v / mx * (H.wind - top - 4);
        ylab('wind', 'kt');
        yaxis('wind', 0, mx, mx > 60 ? 20 : 10, v => String(v), Y);
        for (const S of [SG, SM].filter(Boolean)) band(S, 'ws', 'ew', Y, 0);
        for (const S of [SG, SM].filter(Boolean)) {
          const thin = both && S.key === 'gfs';
          out.push(line(path(S, 'gu', Y), T.gust, thin ? 1 : C ? 1.3 : 1.6, thin ? '2 3' : '4 3', thin ? 0.8 : 1));
          out.push(line(path(S, 'ws', Y), T.wind, thin ? 1.3 : C ? 1.8 : 2.2, thin ? '4 3' : '', thin ? 0.85 : 1));
        }
        // barbs along the top: every N hours, at least ~26 px apart
        const pxH = pw / ((t1 - t0) / HOUR);
        const N = [1, 3, 6, 12, 24, 48].find(n => n * pxH >= (C ? 22 : 26)) || 48;
        for (let t = Math.ceil(t0 / (N * HOUR)) * N * HOUR; t <= t1; t += N * HOUR) {
          const q = (both && SM && t > mepsT0 && t <= meps1) ? nearest(SM, t) : nearest(prim === SG ? SG : SM, t) || nearest(SM, t);
          if (!q || q.ws == null) continue;
          out.push(barbSvg(X(t), b.y0 + top / 2 + (C ? 3 : 4), q.wd, q.ws, T.barb, C ? 13 : 16));
        }
      }
      // 4 pressure
      if (P0.pres) {
        const b = box0.pres, vals = [SM, SG].filter(Boolean).flatMap(S => S.pts.map(q => q.p)).filter(v => v != null);
        if (vals.length) {
          let lo = Math.min(...vals), hi = Math.max(...vals);
          if (hi - lo < 10) { const c = (hi + lo) / 2; lo = c - 5; hi = c + 5; }
          const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
          const Y = v => b.y1 - 3 - (v - lo) / (hi - lo) * (H.pres - (C ? 14 : 18));
          ylab('pres', 'hPa');
          yaxis('pres', lo, hi, hi - lo > 40 ? 10 : 5, v => String(v), Y);
          for (const S of [SG, SM].filter(Boolean)) {
            const thin = both && S.key === 'gfs';
            out.push(line(path(S, 'p', Y), T.pres, thin ? 1.2 : C ? 1.6 : 2, thin ? '4 3' : '', thin ? 0.8 : 1));
          }
        }
      }
      // 5 clouds: high / medium / low / fog rows (MEPS where it has the hour, else GFS), the base / ceiling
      if (P0.cloud) {
        const b = box0.cloud, rows = [['h', 'High'], ['m', 'Medium'], ['l', 'Low']].concat(fogRow ? [['f', 'Fog']] : []);
        const yr = i => b.y0 + 2 + i * rowH;
        rows.forEach(([, name], i) => out.push(txt(AL - 3, yr(i) + rowH - 3, C && name === 'Medium' ? 'Med' : name, { anchor: 'end', fs: C ? 7.5 : 9 })));
        for (const S of [SG, SM].filter(Boolean)) {
          const pts = S.pts;
          pts.forEach((q, i) => {
            if (both && S.key === 'gfs' && pick(q)) return;
            const a = i ? (pts[i - 1].ts + q.ts) / 2 : q.ts - (q.pi || 1) * HOUR / 2;
            const e = i < pts.length - 1 ? (q.ts + pts[i + 1].ts) / 2 : q.ts + (q.pi || 1) * HOUR / 2;
            const xa = X(Math.max(t0, a)), xb = X(Math.min(t1, e));
            rows.forEach(([f], r) => {
              const v = q[f];
              if (v == null || v < 3) return;
              const col = f === 'f' ? T.fog : T.cloud;
              out.push(`<rect x="${xa.toFixed(1)}" y="${yr(r).toFixed(1)}" width="${Math.max(0.5, xb - xa + 0.3).toFixed(1)}" height="${rowH - 1}" fill="rgb(${col})" opacity="${(0.12 + 0.83 * v / 100).toFixed(2)}"/>`);
            });
          });
        }
        // the cloud base (MEPS) / ceiling (GFS) in ft, every N hours as the barbs
        const pxH = pw / ((t1 - t0) / HOUR);
        const N = [1, 3, 6, 12, 24, 48].find(n => n * pxH >= (C ? 30 : 38)) || 48;
        const yb = yr(rows.length) + (C ? 10 : 12);
        out.push(txt(AL - 3, yb, 'ft', { anchor: 'end', fs: C ? 7.5 : 9 }));
        for (let t = Math.ceil(t0 / (N * HOUR)) * N * HOUR; t <= t1; t += N * HOUR) {
          const useM = SM && (!both || (t > mepsT0 && t <= meps1));
          const q = useM ? nearest(SM, t) : nearest(SG, t);
          if (!q || q.b == null || q.b > 6100) continue;      // above about 20 000 ft: not shown
          const cloudy = useM ? ((q.l != null && q.l >= 20) || (q.c != null && q.c >= 20) || (q.f != null && q.f >= 20)) : true;
          if (!cloudy) continue;
          const ft = Math.round(q.b * 3.2808 / 100) * 100;
          out.push(txt(X(t), yb, ft >= 10000 ? Math.round(ft / 1000) + 'k' : String(ft), { anchor: 'middle', fs: C ? 7.5 : 9, col: T.text }));
        }
      }
      // the now-line
      if (now > t0 && now < t1) out.push(`<line x1="${X(now).toFixed(1)}" x2="${X(now).toFixed(1)}" y1="${TOP - 4}" y2="${y - GAP}" stroke="${T.now}" stroke-width="1.4"/>`);
      // the legend line
      const lg = [];
      if (both) lg.push(`<tspan font-weight="600">MEPS</tspan> bold · <tspan font-weight="600">GFS</tspan> thin, dashed`);
      if (P0.wind) lg.push(`<tspan fill="${T.wind}">━</tspan> wind <tspan fill="${T.gust}">╍</tspan> gust`);
      if (P0.precip) lg.push(`<tspan fill="${T.rain}">■</tspan> rain <tspan fill="${T.snow}">■</tspan> snow (day totals in mm)`);
      if (P0.cloud) lg.push(SG && !SM ? 'ft: the ceiling' : SM && !SG ? 'ft: the cloud base' : 'ft: cloud base (MEPS) / ceiling (GFS)');
      if (T8 && P0.temp) lg.push(`<tspan fill="${T.t850}">━</tspan> 850 hPa${O8.length ? ` <tspan fill="${T.t850}">●</tspan> 850 hPa measured (MODE-S Wind)` : ''}`);
      if (banded) lg.push(`<tspan fill="${T.dim}" style="fill-opacity:1">▒</tspan> typical error: 8 in 10 hours within it${EB && EB.where ? ' (' + esc(EB.where) + ')' : ''}`);
      // as many lines as the width needs (the phone's narrow screen: two or three)
      const lgFs = C ? 8.5 : 10, lgW = W - AL - 4, chW = lgFs * 0.55;
      const plain = h => h.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').length;
      const lgLines = [[]];
      lg.forEach(item => {
        const cur = lgLines[lgLines.length - 1];
        const len = cur.reduce((n, h) => n + plain(h) + 3, 0) + plain(item);
        if (cur.length && len * chW > lgW) lgLines.push([item]); else cur.push(item);
      });
      lgLines.forEach((ln, i) => out.push(`<text x="${AL}" y="${(y - GAP + (C ? 13 : 15) + i * (lgFs + 3)).toFixed(1)}" font-size="${lgFs}" fill="${T.dim}">${ln.join(' &nbsp;·&nbsp; ')}</text>`));
      const HtAll = Ht + (lgLines.length - 1) * (lgFs + 3);
      // the hover line (moved by the pointer)
      out.push(`<line id="mg-cur" x1="0" x2="0" y1="${TOP - 4}" y2="${y - GAP}" stroke="${T.text}" stroke-width="1" opacity="0" pointer-events="none"/>`);
      out.push(`<rect id="mg-hit" x="${AL}" y="${TOP - 4}" width="${pw}" height="${y - GAP - TOP + 4}" fill="transparent" style="cursor:crosshair;touch-action:pan-y"/>`);
      box.innerHTML = `<svg xmlns="${NS}" width="${W}" height="${HtAll.toFixed(0)}" viewBox="0 0 ${W} ${HtAll.toFixed(0)}" style="display:block;font-family:inherit">${out.join('')}</svg>`;
      // hover / touch read-out
      const svg = box.firstChild, cur = svg.querySelector('#mg-cur'), hit = svg.querySelector('#mg-hit');
      const onMove = ev => {
        const r = svg.getBoundingClientRect(), x = ev.clientX - r.left;
        const ts = t0 + (x - AL) / pw * (t1 - t0);
        if (ts < t0 || ts > t1) return;
        cur.setAttribute('x1', x); cur.setAttribute('x2', x); cur.setAttribute('opacity', '0.55');
        const text = readText(ts);
        if (opts.onRead) opts.onRead(text); else read.innerHTML = text;
      };
      hit.addEventListener('pointermove', onMove);
      hit.addEventListener('pointerdown', onMove);
      hit.addEventListener('pointerleave', () => { cur.setAttribute('opacity', '0'); });
      if (!opts.onRead && !read.innerHTML) read.innerHTML = `<span class="mg-dim">${C ? 'Tap or drag on the chart for the values' : 'Move over the chart for the values'}</span>`;
    }
    function one(q, name) {
      if (!q) return '';
      const p = [];
      if (q.t != null) p.push(`${q.t > 0 ? '+' : q.t < 0 ? '−' : ''}${Math.abs(q.t).toFixed(1)} °C${q.et != null ? ` (±${q.et.toFixed(1)})` : ''}`);
      if (T8 && q.t8 != null) p.push(`850 hPa ${q.t8 > 0 ? '+' : q.t8 < 0 ? '−' : ''}${Math.abs(q.t8).toFixed(1)} °C`);
      if (q.ws != null) p.push((q.ws < 1 ? 'calm' : `wind ${String(Math.round(q.wd) % 360).padStart(3, '0')}° ${Math.round(q.ws)} kt (${(q.ws * 0.514444).toFixed(0)} m/s)`) + (q.ew != null ? ` (±${Math.round(q.ew)} kt)` : ''));
      if (q.gu != null) p.push(`gust ${q.gu} kt`);
      if (q.r != null) {
        const sn = q.s != null && q.r > 0 && q.s >= 0.5 * q.r;
        p.push(q.r >= 0.05 ? `${sn ? 'snow' : 'rain'} ${q.r.toFixed(1)} mm/h${q.pi > 1 ? ` (mean of ${q.pi} h)` : ''}` : 'dry');
      }
      if (q.p != null) p.push(`${q.p.toFixed(1)} hPa`);
      const cl = [['l', 'low'], ['m', 'med'], ['h', 'high']].filter(([f]) => q[f] != null).map(([f, n]) => `${n} ${q[f]} %`);
      if (cl.length) p.push('cloud ' + cl.join(' / '));
      if (q.f != null && q.f >= 20) p.push(`fog ${q.f} %`);
      if (q.b != null) p.push(`${name === 'GFS' ? 'ceiling' : 'base'} ${(Math.round(q.b * 3.2808 / 100) * 100).toLocaleString('en').replace(/,/g, ' ')} ft`);
      return `<b>${name}</b> +${q.lead} h${q.fine ? ' (2.5 km)' : ''}: ${esc(p.join(' · '))}`;
    }
    function readText(ts) {
      const qm = nearest(SM, ts), qg = nearest(SG, ts), q = qm || qg;
      const dt = new Date((q ? q.ts : Math.round(ts / HOUR) * HOUR) * 1000);
      const head = `${WD[dt.getUTCDay()]} ${dt.getUTCDate()}.${dt.getUTCMonth() + 1}. <b>${String(dt.getUTCHours()).padStart(2, '0')} UTC</b>`;
      const parts = [one(qm, 'MEPS'), one(qg, 'GFS')].filter(Boolean);
      // the measured 850 hPa temperature of that hour (from 2026-11-07)
      let o = null;
      for (const x of O8) if (Math.abs(x[0] - ts) <= 1800 && (!o || Math.abs(x[0] - ts) < Math.abs(o[0] - ts))) o = x;
      if (o) { const h = new Date((o[0] - 1800) * 1000).getUTCHours(); parts.unshift(`<b>Measured</b> 850 hPa ${o[1] > 0 ? '+' : o[1] < 0 ? '−' : ''}${Math.abs(o[1]).toFixed(1)} °C (${String(h).padStart(2, '0')}–${String((h + 1) % 24).padStart(2, '0')} UTC, ${o[2]} values)`); }
      return head + ' · ' + (parts.length ? parts.join(C ? '<br>' : ' &nbsp;|&nbsp; ') : 'no model hour');
    }
    draw();
    if (window.ResizeObserver) {
      let lastW = box.clientWidth;
      ro = new ResizeObserver(() => {
        if (Math.abs(box.clientWidth - lastW) < 2) return;
        lastW = box.clientWidth;
        cancelAnimationFrame(raf); raf = requestAnimationFrame(draw);
      });
      ro.observe(box);
    }
    return { destroy() { if (ro) ro.disconnect(); el.innerHTML = ''; }, redraw: draw };
  }

  // the receiver sites as places (from 2026-11-05 evening): the same list and positions as the
  // maps' receiver triangles (/api/coverage — each receiver's own position, rounded to 0.01°;
  // one whose position is not known yet is left out).  [{id, short, name, label, lat, lon}]
  let rxP = null, rxAt = 0;
  function receivers() {
    if (rxP && Date.now() - rxAt < 10 * 60e3) return rxP;
    rxAt = Date.now();
    rxP = fetch('/api/coverage?hours=1', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(d =>
      ((d && d.receivers) || []).filter(r => r.lat != null && r.lon != null && r.src !== 'centre').map(r => {
        const short = String(r.id || 'Receiver').replace(/^MODES-/, '');
        return { id: r.id, short, name: r.name || '', label: short + (r.name ? ' · ' + r.name : ''), lat: +r.lat, lon: +r.lon };
      })).catch(() => { rxAt = 0; return []; });
    return rxP;
  }

  // /api/weather/gfs_skill → the bands of render(): the lead days with enough checked hours,
  // {gfs: {day: {t, ws}}, meps: {…}} (the 80th percentile of the absolute error); null without any
  function errBand(sk, where) {
    if (!sk || sk.error) return null;
    const one = rows => {
      const o = {};
      (rows || []).forEach(r => {
        if (!r.ok) return;
        const t = r.t && r.t.p80, ws = r.ws && r.ws.p80;
        if (t != null || ws != null) o[r.day] = { t: t != null ? t : null, ws: ws != null ? ws : null };
      });
      return Object.keys(o).length ? o : null;
    };
    const g = one(sk.gfs), m = one(sk.meps);
    return g || m ? { gfs: g, meps: m, where } : null;
  }
  // the skill data, fetched once per 30 min (shared by the views of the page)
  let skP = null, skAt = 0;
  function skill() {
    if (skP && Date.now() - skAt < 30 * 60e3) return skP;
    skAt = Date.now();
    skP = fetch('/api/weather/gfs_skill?days=30').then(r => r.ok ? r.json() : null).catch(() => { skAt = 0; return null; });
    return skP;
  }

  return { render, sunElev, receivers, errBand, skill, leadDay };
})();
