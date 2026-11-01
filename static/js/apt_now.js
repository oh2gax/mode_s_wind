/**
 * apt_now.js — the airport's weather of now as a small box (from 2026-11-01 night):
 * shared by the Live Map's "Current MEPS & radar wx" box (live_wx.js) and the
 * phone's Mast view (app_mast.js).  Pure HTML building — no map, no Leaflet.
 *
 *   AptNow.parseMetar(raw)  → the newest METAR's wind, gust, T, QNH, base, codes
 *   AptNow.load()           → { d, met, mast } from /api/weather/point, /api/wx
 *                             and /api/mast/profile (mast null when none in 3 h)
 *   AptNow.html({ d, met, mast, min, apt }) → the box's inner HTML (« / » button
 *                             with class lwx-apt-min, rows with hover titles)
 *
 * The rows: the MEPS hour containing now (10 m wind, gust, 2 m T, MSL pressure,
 * rain or snow, cloud, base, fog) and the FMI radar's rain rate; Δ METAR =
 * METAR − MEPS; the Kivenlahti mast rows (highest first) with Δ MEPS = mast −
 * MEPS and Δ Mode S = mast − the airport's Mode S boundary layer.
 */
(function () {
  'use strict';
  const pad2 = n => String(n).padStart(2, '0');
  const fmtUtc = ts => { const d = new Date(ts * 1000); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; };
  const windDir = (u, v) => (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
  const ms = kt => (kt * 0.514444).toFixed(0);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // the newest METAR of the airport for the difference column (from 2026-11-01 evening):
  // time, wind (kt), gust, temperature, QNH, the lowest cloud layer, precipitation and
  // fog / mist codes — only the observation, not the trend (NOSIG / TEMPO / BECMG) or RMK
  function parseMetar(raw) {
    if (!raw || raw[0] === '[') return null;
    let s = ` ${String(raw).replace(/=\s*$/, '')} `;
    const cut = s.search(/ (NOSIG|TEMPO|BECMG|RMK) /);
    if (cut > 0) s = s.slice(0, cut + 1);
    const o = { time: null, dir: null, spd: null, gust: null, t: null, q: null, base: null, cavok: / CAVOK /.test(s), pcp: [], fog: [] };
    let x = s.match(/ \d{2}(\d{4})Z /); if (x) o.time = x[1] + 'Z';
    x = s.match(/ (\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS) /);
    if (x) { const f = x[4] === 'MPS' ? 1.94384 : 1; o.dir = x[1] === 'VRB' ? null : +x[1]; o.spd = Math.round(+x[2] * f); o.gust = x[3] ? Math.round(+x[3] * f) : null; }
    x = s.match(/ (M?\d{2})\/(M?\d{2})? /); if (x) o.t = +x[1].replace('M', '-');
    x = s.match(/ Q(\d{4}) /); if (x) o.q = +x[1];
    x = s.match(/ (FEW|SCT|BKN|OVC|VV)(\d{3})/); if (x) o.base = +x[2] * 100;
    for (const tk of s.trim().split(/\s+/)) {
      if (!/^(\+|-|VC)?(MI|BC|PR|DR|BL|SH|TS|FZ)?(DZ|RA|SN|SG|PL|GR|GS|UP|BR|FG)+$/.test(tk) || tk === 'WS') continue;
      if (/DZ|RA|SN|SG|PL|GR|GS|UP/.test(tk)) o.pcp.push(tk);
      if (/BR|FG/.test(tk)) o.fog.push(tk);
    }
    return o;
  }
  const sgn = (n, d = 0) => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n).toFixed(d);
  const dCell = (txt, big, title) => ({ txt, big, title });
  // the difference column is METAR − MEPS (from 2026-11-01 evening; first MEPS − METAR,
  // which read the wrong way round): +1 = the METAR 1 higher than the model
  const vsMeps = (dv, unit, up, down, d = 0) => dv === 0 ? 'the same as MEPS'
    : `${Math.abs(dv).toFixed(d)}${unit} ${dv > 0 ? up : down} than MEPS`;

  // narrow rows (from 2026-11-01 evening: about half the first width): short labels,
  // kt only (m/s in the hover title), the radar's time and the run in the last lines
  function aptRows(d, M) {
    const v = (d.meps && d.meps.v) || {}, rows = [], short = [];
    let sp = null, dir = null;
    if (v.u != null && v.v != null) {
      sp = Math.hypot(v.u, v.v);
      dir = Math.round(windDir(v.u, v.v)) % 360 || 360;
      let dc = null;
      if (M && M.spd != null) {
        const ds = M.spd - Math.round(sp);
        const mTxt = M.spd === 0 ? 'calm' : `${M.dir == null ? 'VRB' : String(M.dir).padStart(3, '0') + '°'} ${M.spd} kt`;
        let dd = null;
        if (M.dir != null && sp >= 3 && M.spd >= 3) dd = ((M.dir - dir + 540) % 360) - 180;   // + = the METAR veered (clockwise)
        dc = dCell(dd != null ? `${sgn(dd)}°/${sgn(ds)}` : sgn(ds), (dd != null && Math.abs(dd) >= 40 && M.spd >= 5) || Math.abs(ds) >= 5,
                   `METAR ${mTxt}: ${dd != null ? (dd === 0 ? 'the same direction' : `${Math.abs(dd)}° ${dd > 0 ? 'clockwise (veered)' : 'anticlockwise (backed)'} from MEPS`) + ', ' : ''}`
                   + `${vsMeps(ds, ' kt', 'stronger', 'weaker')} (METAR − MEPS)`);
      }
      rows.push(['Wind', sp < 1 ? 'calm' : `${String(dir).padStart(3, '0')}° ${Math.round(sp)} kt`, sp < 1 ? '' : `10 m wind ${ms(sp)} m/s`, dc]);
      short.push(sp < 1 ? 'calm' : `${String(dir).padStart(3, '0')}/${Math.round(sp)}${v.g != null ? 'G' + Math.round(v.g) : ''}kt`);
    }
    if (v.g != null) {
      const dc = !M || M.spd == null ? null : M.gust != null
        ? dCell(sgn(M.gust - Math.round(v.g)), Math.abs(M.gust - Math.round(v.g)) >= 8, `METAR gust ${M.gust} kt: ${vsMeps(M.gust - Math.round(v.g), ' kt', 'stronger', 'weaker')}`)
        : dCell('–', false, 'no gust in the METAR (gusts are reported when 10 kt or more above the mean)');
      rows.push(['Gust', `${Math.round(v.g)} kt`, `10 m gust ${ms(v.g)} m/s`, dc]);
    }
    if (v.t != null) {
      const t = Math.round(v.t / 10), tt = `${t < 0 ? '−' : t > 0 ? '+' : ''}${Math.abs(t)} °C`;
      const dc = M && M.t != null ? dCell(sgn(M.t - t), Math.abs(M.t - t) >= 3, `METAR ${M.t} °C: ${vsMeps(M.t - t, ' °C', 'warmer', 'colder')}`) : null;
      rows.push(['Temp', tt, '2 m temperature', dc]); short.push(tt);
    }
    if (v.p != null) {
      const p = 1000 + v.p / 10;
      const dc = M && M.q != null ? dCell(sgn(M.q - p, 1), Math.abs(M.q - p) >= 2,
        `METAR QNH ${M.q} hPa: ${vsMeps(M.q - p, ' hPa', 'higher', 'lower', 1)} (sea-level pressure) — the two are reduced to sea level in different ways, a few tenths apart`) : null;
      rows.push(['Pressure', `${p.toFixed(1)} hPa`, 'sea-level pressure (MSL)', dc]);
    }
    let mRain = null;
    if (v.r != null) {
      const snow = v.s != null && v.r > 0 && v.s >= 0.5 * v.r;
      mRain = v.r >= 5 ? `${snow ? 'snow' : 'rain'} ${(v.r / 100).toFixed(1)} mm/h` : 'dry';
      const dc = M ? dCell(M.pcp.length ? M.pcp.join(' ') : 'nil', (v.r >= 5) !== (M.pcp.length > 0),
        M.pcp.length ? 'precipitation in the METAR' : 'no precipitation in the METAR') : null;
      rows.push(['MEPS', mRain, 'the model\'s rain or snow of the hour', dc]);
    }
    const ra = d.radar || {};
    const rTxt = ra.error || !ra.ts ? 'n/a' : !ra.in ? 'outside' : ra.r >= 10 ? `rain ${(ra.r / 100).toFixed(1)} mm/h` : 'dry';
    rows.push(['Radar', rTxt, ra.error || !ra.ts ? 'the FMI radar is not available' : !ra.in ? 'outside the radar coverage' : 'the FMI radar\'s observed rain rate', null]);
    short.push(ra.ts && ra.in ? (ra.r >= 10 ? `radar ${(ra.r / 100).toFixed(1)} mm/h` : 'radar dry') : mRain || '');
    const cl = [['Cloud', 'c', 'total cloud cover'], ['Low', 'l', 'low cloud'], ['Medium', 'm', 'medium cloud'], ['High', 'h', 'high cloud']];
    for (const [k, f, t] of cl) if (v[f] != null) rows.push([k, `${v[f]} %`, t, null]);
    if (v.b != null && ((v.l != null && v.l >= 20) || (v.c != null && v.c >= 20) || (v.f != null && v.f >= 20))) {
      const bf = Math.round(v.b * 3.2808 / 100) * 100;
      const dc = !M ? null : M.base != null
        ? dCell(sgn(M.base - bf), Math.abs(M.base - bf) >= 1000, `METAR lowest cloud ${M.base.toLocaleString('en').replace(/,/g, ' ')} ft: ${vsMeps(M.base - bf, ' ft', 'higher', 'lower')}`)
        : dCell(M.cavok ? 'CAVOK' : 'nil', false, M.cavok ? 'CAVOK: no cloud below 5 000 ft in the METAR' : 'no cloud layer in the METAR');
      rows.push(['Base', `${bf.toLocaleString('en').replace(/,/g, ' ')} ft`, 'cloud base', dc]);
    }
    if (v.f != null) {
      const dc = M ? dCell(M.fog.length ? M.fog.join(' ') : 'nil', (v.f >= 50) !== M.fog.some(x => /FG/.test(x)),
        M.fog.length ? 'fog (FG) or mist (BR) in the METAR' : 'no fog or mist in the METAR') : null;
      rows.push(['Fog', `${v.f} %`, 'fog', dc]);
    }
    return { rows, short: short.filter(Boolean).join(' · ') };
  }
  // ── mast rows: mast − MEPS and mast − Mode S at the mast's heights (from 2026-11-01) ──
  const lerp = (pts, h, gap) => {                          // pts [[h, v]] sorted, linear, null outside
    pts = pts.filter(p => p[1] != null);
    for (let i = 0; i + 1 < pts.length; i++) {
      const [h0, v0] = pts[i], [h1, v1] = pts[i + 1];
      if (h0 <= h && h <= h1) return h1 - h0 > gap ? null : v0 + (v1 - v0) * (h1 === h0 ? 0 : (h - h0) / (h1 - h0));
    }
    const near = pts.find(p => Math.abs(p[0] - h) <= gap / 2);
    return near ? near[1] : null;
  };
  const uvOf = (kt, d) => [-kt * Math.sin(d * Math.PI / 180), -kt * Math.cos(d * Math.PI / 180)];
  function mWindAt(pts, h, gap) {                          // pts [[h, kt, dir]]
    const ok = pts.filter(p => p[1] != null && p[2] != null).map(p => [p[0], ...uvOf(p[1], p[2])]);
    const u = lerp(ok.map(p => [p[0], p[1]]), h, gap), v = lerp(ok.map(p => [p[0], p[2]]), h, gap);
    return u == null || v == null ? null : [Math.hypot(u, v), (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360];
  }
  function mastRows(M) {
    if (!M || !M.obs) return null;
    const o = M.obs, FT = 3.28084, top = o.wl.length - 1, tt = o.tl.length - 1;
    const meps = (M.meps && M.meps.lv) || [];                  // [h_m, t, kt, dir]
    const ms = M.modes, ae = ms ? (ms.apt_elev_ft || 179) : 179;
    const msW = ms ? (ms.w || []).map(r => [r[0] - ae, r[1], r[2]]) : [];   // ft above the airport
    const msT = ms ? (ms.t || []).map(r => [r[0] - ae, r[1]]) : [];
    const wd = (a, b) => ((a - b + 540) % 360) - 180;
    const wCell = (src, hm, kt, dir, name) => {
      if (kt == null || dir == null || !src) return dCell('–', false, `no ${name} wind at this height`);
      const dd = kt >= 3 && src[0] >= 3 ? Math.round(wd(dir, src[1])) : null, ds = Math.round(kt - src[0]);
      return dCell(dd != null ? `${sgn(dd)}°/${sgn(ds)}` : sgn(ds), (dd != null && Math.abs(dd) >= 40 && kt >= 5) || Math.abs(ds) >= 5,
        `${name} ${String(Math.round(src[1])).padStart(3, '0')}° ${Math.round(src[0])} kt; mast − ${name}: ` +
        (dd != null ? `${Math.abs(dd)}° ${dd > 0 ? 'clockwise (veered)' : dd < 0 ? 'anticlockwise (backed)' : ''} from ${name}, ` : '') +
        `${Math.abs(ds)} kt ${ds > 0 ? 'stronger' : ds < 0 ? 'weaker' : 'the same'}`);
    };
    const tCell = (v, src, name) => src == null || v == null ? dCell('–', false, `no ${name} temperature at this height`)
      : dCell(sgn(v - src, 1), Math.abs(v - src) >= 2, `${name} ${src.toFixed(1)} °C; the mast ${Math.abs(v - src).toFixed(1)} °C ${v - src > 0 ? 'warmer' : v - src < 0 ? 'colder' : 'the same'}`);
    const rows = [];          // [label, value, hover, Δ MEPS, Δ Mode S, height m] — sorted by height below
    for (const i of [top, 0]) {
      const hm = o.wl[i], kt = o.ws[i], dir = o.wd[i];
      rows.push([`${hm} m`, kt != null ? `${String(Math.round(dir)).padStart(3, '0')}° ${Math.round(kt)} kt` : '–',
        `mast wind at ${hm} m (${Math.round((hm + (M.elev_m || 44)) * FT)} ft MSL), gust ${o.wg[i] != null ? Math.round(o.wg[i]) + ' kt' : '–'}`,
        wCell(mWindAt(meps.map(l => [l[0], l[2], l[3]]), hm, 60), hm, kt, dir, 'MEPS'),
        wCell(mWindAt(msW, hm * FT, 260), hm, kt, dir, 'Mode S'), hm]);
    }
    const mT = h => h <= 2 ? (M.meps_sfc && M.meps_sfc.t != null ? M.meps_sfc.t : null) : lerp(meps.map(l => [l[0], l[1]]), h, 60);
    const sT = h => h < 60 ? null : lerp(msT, h * FT, 420);
    for (const i of [tt, 0]) {
      const hm = o.tl[i], v = o.t[i];
      rows.push([`${hm} m`, v != null ? `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} °C` : '–', `mast temperature at ${hm} m`,
        tCell(v, mT(hm), 'MEPS'), tCell(v, sT(hm), 'Mode S'), hm]);
    }
    // highest at the top, as a profile (327 m wind, 297 m T, 26 m wind, 2 m T; 2026-11-01)
    rows.sort((a, b) => b[5] - a[5]);
    // the inversion: T(top) − T(2 m), and the same difference of the sources
    const dT = o.t[tt] != null && o.t[0] != null ? o.t[tt] - o.t[0] : null;
    const mdT = mT(o.tl[tt]) != null && mT(o.tl[0]) != null ? mT(o.tl[tt]) - mT(o.tl[0]) : null;
    const sdT = sT(o.tl[tt]) != null && ms && ms.tt != null ? sT(o.tl[tt]) - ms.tt : null;
    const stab = dT == null ? '' : dT > 0.3 ? 'inversion' : dT < -0.0098 * (o.tl[tt] - o.tl[0]) - 0.6 ? 'unstable' : 'no inversion';
    rows.push([`ΔT ${o.tl[tt]}−${o.tl[0]}`, dT != null ? `${sgn(dT, 1)} K` : '–', `temperature difference ${o.tl[tt]} m − ${o.tl[0]} m: ${stab} (+ = warmer aloft, an inversion; dry-adiabatic ${(-0.0098 * (o.tl[tt] - o.tl[0])).toFixed(1)} K)`,
      mdT == null || dT == null ? dCell('–', false, 'no MEPS values') : dCell(sgn(dT - mdT, 1), Math.abs(dT - mdT) >= 1.5, `MEPS ${sgn(mdT, 1)} K (model levels − its 2 m at the mast); the mast's inversion ${Math.abs(dT - mdT).toFixed(1)} K ${dT - mdT > 0 ? 'stronger' : 'weaker'}`),
      sdT == null || dT == null ? dCell('–', false, 'no Mode S temperatures of the hour') : dCell(sgn(dT - sdT, 1), Math.abs(dT - sdT) >= 1.5, `Mode S ${sgn(sdT, 1)} K (aircraft at the same height − the METAR); the mast's ${Math.abs(dT - sdT).toFixed(1)} K ${dT - sdT > 0 ? 'more' : 'less'}`)]);
    return { rows, o, ms };
  }
  function mastHtml(mast) {
    const R = mastRows(mast);
    if (!R) return '';
    const t = new Date(R.o.ts * 1000), hh = `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}`;
    const cell = dc => `<td class="lwx-apt-d${dc && dc.big ? ' big' : ''}"${dc && dc.title ? ` title="${esc(dc.title)}"` : ''}>${dc ? esc(dc.txt) : ''}</td>`;
    return `<table class="lwx-apt-mast"><tr class="lwx-apt-h"><td title="The Kivenlahti mast (FMI open data), 24 km south-west of the airport; heights above its ground">Mast ${hh}</td><td></td>`
      + `<td title="Mast − MEPS (the model levels around the receiver; the 2 m temperature at the mast): + = the mast higher (warmer, stronger)">Δ MEPS</td>`
      + `<td title="Mast − Mode S (the airport's boundary layer of the hour${R.ms ? ', ' + pad2(new Date(R.ms.ts * 1000).getUTCHours()) + ' UTC' : ''}, at the same height above the ground): + = the mast higher">Δ Mode S</td></tr>`
      + R.rows.map(([k, x, t2, a, b]) => `<tr title="${esc(t2)}"><td>${k}</td><td>${x}</td>${cell(a)}${cell(b)}</tr>`).join('') + '</table>';
  }
  // o: { d (the /api/weather/point answer), met (parseMetar), mast (/api/mast/profile, found), min, apt (name) }
  function html(o) {
    const d = o.d, aptMet = o.met, APT = o.apt || 'the airport', min = !!o.min;
    const btn = `<button type="button" class="ws-aphist-ctrl-btn ws-aphist-min-btn lwx-apt-min${min ? ' active' : ''}" `
      + `title="${min ? 'Show all the values' : 'Minimize to one line'}" aria-label="${min ? 'Expand' : 'Minimize'}">${min ? '&raquo;' : '&laquo;'}</button>`;
    let html;
    if (!d) html = `${btn}<b>${esc(APT)}</b> <span>loading…</span>`;
    else if (d.error) html = `${btn}<b>${esc(APT)}</b> <span>${esc(d.error)}</span>`;
    else {
      const m = d.meps || {}, ra = d.radar || {}, { rows, short } = aptRows(d, aptMet);
      const hh = m.ts ? (() => { const h = new Date(m.ts * 1000).getUTCHours(); return `${pad2((h + 23) % 24)}–${pad2(h)}`; })() : '';
      if (min) html = `${btn}<b>MEPS ${esc(d.name || APT)}</b> ${short || '<span>no data</span>'}`;   // "MEPS EFHK 214/7G12kt …" (2026-11-01)
      else {
        const r = m.run ? new Date(m.run * 1000) : null;
        html = `${btn}<b>${esc(d.name || APT)} now</b>`
          + `<table>${aptMet ? `<tr class="lwx-apt-h"><td></td><td>MEPS</td><td title="The newest METAR of ${esc(d.name || APT)} against the model, METAR − MEPS: +1 = the METAR 1 higher (warmer, stronger, higher base), − = lower${aptMet.time ? ' (' + aptMet.time + ')' : ''}; the METAR's own value in the hover of each difference. Amber: a large difference">Δ METAR${aptMet.time ? ' ' + aptMet.time.slice(0, 4) : ''}</td></tr>` : ''}`
          + `${rows.map(([k, x, t, dc]) => `<tr${t ? ` title="${t}"` : ''}><td>${k}</td><td>${x}</td>`
            + (aptMet ? `<td class="lwx-apt-d${dc && dc.big ? ' big' : ''}"${dc && dc.title ? ` title="${esc(dc.title)}"` : ''}>${dc ? esc(dc.txt) : ''}</td>` : '')
            + '</tr>').join('')}</table>`
          + mastHtml(o.mast)
          + (m.error ? `<span>MEPS: ${esc(m.error)}</span><br>` : '')
          + `<span title="the model's forecast; the radar is observed">MEPS ${hh} UTC${r ? ` (${pad2(r.getUTCHours())} +${m.lead} h${m.km ? ', ' + m.km + ' km' : ''})` : ''}`
          + `${ra.ts ? `<br>radar ${fmtUtc(ra.ts)} UTC` : ''}</span>`;
      }
    }
    return html;
  }

  async function load() {
    const [r, w, mp] = await Promise.all([fetch('/api/weather/point', { cache: 'no-store' }),
                                          fetch('/api/wx', { cache: 'no-store' }).catch(() => null),
                                          fetch('/api/mast/profile', { cache: 'no-store' }).catch(() => null)]);
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    let mast = null, met = null;
    try { const j = mp && mp.ok ? await mp.json() : null; mast = j && j.found ? j : null; } catch (_) { mast = null; }
    try { met = w && w.ok ? parseMetar((await w.json()).metar) : null; } catch (_) { met = null; }
    return { d, met, mast };
  }

  window.AptNow = { parseMetar, load, html };
})();
