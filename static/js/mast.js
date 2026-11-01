/**
 * mast.js — the Sounding page's Mast tab (from 2026-11-01): the Kivenlahti
 * mast (FMI open data, collector/mast.py) — the profile of one observation
 * with the Mode S boundary layer at the airport, the MEPS model and the
 * newest Jokioinen sounding; the wind, direction, temperature and stability
 * time series of 24 h / 3 d / 7 d (a click picks the profile's time); and
 * the comparison tables (source − mast per level, 7 / 30 / 90 days).
 *
 * Heights in ft MSL of the mast site ((m + 44) × 3.28; the mast's own heights
 * in m above the ground in the hovers).  The Mode S values come from the
 * airport, 24 km away, at the same height above the ground.
 *
 * window.MastView = { load(), render(), active(on) }
 */
(function () {
  const $ = id => document.getElementById(id);
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } };
  const pad = n => String(n).padStart(2, '0');
  const light = () => document.documentElement.dataset.theme === 'light';
  const FT = 3.28084;
  const st = {
    hours: parseInt(lsGet('ms_mast_hours', '24'), 10) || 24,
    days: parseInt(lsGet('ms_mast_days', '7'), 10) || 7,
    modes: lsGet('ms_mast_modes', 'true') !== 'false',
    meps: lsGet('ms_mast_meps', 'true') !== 'false',
    sonde: lsGet('ms_mast_sonde', 'true') !== 'false',
    at: null,                          // profile time (null = the newest)
  };
  let ser = null, prof = null, cmp = null, on = false, timer = null, seq = 0;

  const C = () => {
    const L = light();
    return { ink: L ? '#0f172a' : '#e2e8f0', ink2: L ? '#475569' : '#94a3b8', ink3: L ? '#94a3b8' : '#64748b',
             grid: L ? '#d8e0e8' : '#1e2a3a', zero: L ? '#94a3b8' : '#475569', bg: L ? '#ffffff' : '#0f1923',
             mast: L ? '#b45309' : '#f59e0b', modes: L ? '#1d4ed8' : '#60a5fa', meps: L ? '#0e7490' : '#22d3ee',
             sonde: L ? '#be185d' : '#f472b6', dry: L ? '#94a3b8' : '#64748b',
             inv: L ? '#7c3aed' : '#a78bfa', unst: L ? '#c2410c' : '#fb923c' };
  };
  // colours by height (low → high), readable in both themes
  const RAMP = { dark: [[253, 224, 71], [74, 222, 128], [34, 211, 238], [167, 139, 250]],
                 light: [[202, 138, 4], [22, 163, 74], [8, 145, 178], [124, 58, 237]] };
  function ramp(f) {
    const r = RAMP[light() ? 'light' : 'dark'], x = Math.max(0, Math.min(1, f)) * (r.length - 1);
    const i = Math.min(r.length - 2, Math.floor(x)), k = x - i;
    return `rgb(${r[i].map((c, j) => Math.round(c + (r[i + 1][j] - c) * k)).join(',')})`;
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const utc = (ts, date = true) => { const d = new Date(ts * 1000); return (date ? `${d.getUTCDate()}.${d.getUTCMonth() + 1}. ` : '') + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const f1 = (v, d = 1, sign = false) => v == null ? '–' : (sign && v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d);
  const elev = () => (ser && ser.station && ser.station.elev) || (prof && prof.elev_m) || 44;
  const ftOf = m => Math.round((m + elev()) * FT);

  // wind barb as SVG (from the direction the wind blows from; feathers on the left)
  function barb(x, y, kt, dir, col, len = 20) {
    if (kt == null || dir == null) return '';
    if (kt < 2.5) return `<circle cx="${x}" cy="${y}" r="3" fill="none" stroke="${col}" stroke-width="1.3"/>`;
    const a = (dir) * Math.PI / 180, ux = Math.sin(a), uy = -Math.cos(a);       // towards where it comes from
    const ex = x + ux * len, ey = y + uy * len, px = -uy, py = ux;               // feather side
    let s = `<line x1="${x}" y1="${y}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="${col}" stroke-width="1.4" stroke-linecap="round"/>`;
    let rem = Math.round(kt / 5) * 5, pos = 0;
    while (rem >= 50) {
      const bx = ex - ux * pos, by = ey - uy * pos, cx = ex - ux * (pos + 6), cy = ey - uy * (pos + 6);
      s += `<polygon points="${bx.toFixed(1)},${by.toFixed(1)} ${(bx + px * 9).toFixed(1)},${(by + py * 9).toFixed(1)} ${cx.toFixed(1)},${cy.toFixed(1)}" fill="${col}"/>`;
      pos += 7; rem -= 50;
    }
    while (rem >= 10) {
      const bx = ex - ux * pos, by = ey - uy * pos;
      s += `<line x1="${bx.toFixed(1)}" y1="${by.toFixed(1)}" x2="${(bx + px * 9 + ux * 3).toFixed(1)}" y2="${(by + py * 9 + uy * 3).toFixed(1)}" stroke="${col}" stroke-width="1.4" stroke-linecap="round"/>`;
      pos += 4; rem -= 10;
    }
    if (rem >= 5) {
      if (pos === 0) pos = 4;
      const bx = ex - ux * pos, by = ey - uy * pos;
      s += `<line x1="${bx.toFixed(1)}" y1="${by.toFixed(1)}" x2="${(bx + px * 5 + ux * 1.5).toFixed(1)}" y2="${(by + py * 5 + uy * 1.5).toFixed(1)}" stroke="${col}" stroke-width="1.4" stroke-linecap="round"/>`;
    }
    return s;
  }

  // ── data ────────────────────────────────────────────────────────────────
  async function load() {
    const my = ++seq;
    syncControls();
    const meta = $('sounding-meta');
    if (meta && !meta.textContent) meta.textContent = 'Loading…';
    try {
      const [a, b, c] = await Promise.all([
        fetch(`/api/mast?hours=${st.hours}`).then(r => r.json()),
        fetch(`/api/mast/profile${st.at ? '?at=' + st.at : ''}`).then(r => r.json()),
        fetch(`/api/mast/compare?days=${st.days}`).then(r => r.json()),
      ]);
      if (my !== seq) return;
      ser = a; prof = b; cmp = c;
      const n = (ser.rows || []).length;
      if (meta) meta.textContent = n
        ? `Kivenlahti mast · ${n} observations, ${utc(ser.rows[0][0])} – ${utc(ser.rows[n - 1][0])} UTC · FMI open data`
        : 'Kivenlahti mast · no observations stored yet — the first ones arrive about a minute after the start (7 days back-filled)';
      render();
    } catch (e) {
      if (meta) meta.textContent = 'Error loading the mast data.';
      console.error(e);
    }
  }
  async function loadProfile(at) {
    st.at = at;
    try {
      prof = await (await fetch(`/api/mast/profile${at ? '?at=' + at : ''}`)).json();
      renderProfile(); renderTiles();
    } catch (e) { console.error(e); }
  }

  function render() {
    if (!ser) return;
    renderTiles(); renderProfile(); renderSeries(); renderCompare();
  }

  // ── tiles ───────────────────────────────────────────────────────────────
  function renderTiles() {
    const el = $('mt-tiles');
    if (!el) return;
    const tile = (v, l) => `<div class="sv-tile"><div class="v">${v}</div><div class="l">${l}</div></div>`;
    const o = prof && prof.found ? prof.obs : null;
    if (!o) { el.innerHTML = tile('–', 'no mast observation in the last 3 hours'); return; }
    const top = o.wl.length - 1, tt = o.tl.length - 1;
    const dT = o.t[tt] != null && o.t[0] != null ? o.t[tt] - o.t[0] : null;
    const dry = -0.0098 * (o.tl[tt] - o.tl[0]);
    const shear = o.ws[top] != null && o.ws[0] != null ? (o.ws[top] - o.ws[0]) / ((o.wl[top] - o.wl[0]) * FT / 1000) : null;
    const stab = dT == null ? '' : dT > 0.3 ? 'inversion' : dT > dry + 0.6 ? 'stable' : dT < dry - 0.6 ? 'unstable (super-adiabatic)' : 'well mixed (about dry-adiabatic)';
    el.innerHTML = [
      tile(`${utc(o.ts, false)} <small>UTC</small>`, `${st.at ? 'chosen observation' : 'newest observation'} · ${utc(o.ts)} · ${esc((prof.station || {}).name || '')}`),
      tile(o.ws[top] != null ? `${String(Math.round(o.wd[top])).padStart(3, '0')}° ${Math.round(o.ws[top])} <small>kt</small>` : '–',
           `wind at ${o.wl[top]} m (${ftOf(o.wl[top]).toLocaleString('en')} ft MSL), gust ${o.wg[top] != null ? Math.round(o.wg[top]) + ' kt' : '–'} · at ${o.wl[0]} m ${o.ws[0] != null ? String(Math.round(o.wd[0])).padStart(3, '0') + '° ' + Math.round(o.ws[0]) + ' kt' : '–'}`),
      tile(dT != null ? `${f1(dT, 1, true)} <small>K</small>` : '–', `T(${o.tl[tt]} m) − T(${o.tl[0]} m): ${stab} (dry-adiabatic ${f1(dry, 1, true)} K)`),
      tile(shear != null ? `${f1(shear, 1, true)} <small>kt / 1 000 ft</small>` : '–', `wind speed change ${o.wl[0]} → ${o.wl[top]} m (vertical shear)`),
    ].join('');
  }

  // ── profile ─────────────────────────────────────────────────────────────
  function renderProfile() {
    const el = $('mt-profile');
    if (!el) return;
    if (!prof || !prof.found) { el.innerHTML = '<div class="sv-empty">No mast observation yet.</div>'; return; }
    const r = profileSvg(prof, st);
    el.innerHTML = r.svg;
    $('mt-profile-legend').innerHTML = r.legend.join(' &nbsp; ') + ' &nbsp; <span class="text-dim">- - dry adiabat</span>';
  }
  // the profile as SVG (from 2026-11-01 night also the phone's Mast view, app_mast.js):
  // sel = { modes, meps, sonde } the sources shown; o.compact: the phone's size
  function profileSvg(prof, sel, o2 = {}) {
    const K = C(), o = prof.obs, E = prof.elev_m || 44, st = sel;
    const ftOf = m => Math.round((m + E) * FT);
    const cp = !!o2.compact, nSrc = 1 + ['modes', 'meps', 'sonde'].filter(k => sel[k]).length, cs = cp ? 34 : 40;
    const W = cp ? 380 : 560, H = cp ? 360 : 430, ml = cp ? 44 : 52, mr = cp ? 14 + nSrc * cs : 172, mt = 16, mb = 38, pw = W - ml - mr, ph = H - mt - mb;
    const TOP = 1500;                                                  // ft MSL
    const y = ft => mt + ph * (1 - Math.max(0, Math.min(TOP, ft)) / TOP);
    // temperatures of all shown sources → x range
    const srcT = [];
    o.tl.forEach((h, i) => { if (o.t[i] != null) srcT.push([ftOf(h), o.t[i]]); });
    const mp = st.meps && prof.meps ? prof.meps.lv.filter(l => (l[0] + E) * FT <= TOP) : [];
    const ms = st.modes && prof.modes ? prof.modes : null;
    const msT = ms ? (ms.t || []).filter(r => r[0] - (ms.apt_elev_ft || 179) + E * FT <= TOP).map(r => [r[0] - (ms.apt_elev_ft || 179) + E * FT, r[1], r[2]]) : [];
    const msW = ms ? (ms.w || []).map(r => [r[0] - (ms.apt_elev_ft || 179) + E * FT, r[1], r[2], r[3]]).filter(r => r[0] <= TOP && r[0] > 0) : [];
    const sd = st.sonde && prof.sonde ? prof.sonde.lv.filter(l => (l[0] + E) * FT <= TOP) : [];
    const sfc = prof.meps_sfc;
    const all = srcT.map(p => p[1]).concat(mp.map(l => l[1]), msT.map(r => r[1]), sd.map(l => l[1]).filter(v => v != null),
                                           sfc && sfc.t != null && st.meps ? [sfc.t] : []);
    let lo = Math.min(...all), hi = Math.max(...all);
    lo = Math.floor(lo - 0.8); hi = Math.ceil(hi + 0.8);
    if (hi - lo < 4) { const m = (hi + lo) / 2; lo = Math.floor(m - 2); hi = Math.ceil(m + 2); }
    const x = t => ml + pw * (t - lo) / (hi - lo);
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Mast profile">`;
    // grid
    for (let ft = 0; ft <= TOP; ft += 250) {
      s += `<line x1="${ml}" x2="${ml + pw}" y1="${y(ft)}" y2="${y(ft)}" stroke="${K.grid}"/>` +
           `<text x="${ml - 6}" y="${y(ft) + 4}" text-anchor="end" font-size="11" fill="${K.ink2}">${ft.toLocaleString('en')}</text>`;
    }
    const step = hi - lo > 12 ? 4 : hi - lo > 6 ? 2 : 1;
    for (let t = Math.ceil(lo / step) * step; t <= hi; t += step)
      s += `<line x1="${x(t)}" x2="${x(t)}" y1="${mt}" y2="${mt + ph}" stroke="${t === 0 ? K.zero : K.grid}"/>` +
           `<text x="${x(t)}" y="${mt + ph + 14}" text-anchor="middle" font-size="11" fill="${K.ink2}">${t}</text>`;
    s += `<text x="${ml + pw / 2}" y="${H - 6}" text-anchor="middle" font-size="11" fill="${K.ink2}">°C</text>` +
         (cp ? '' : `<text x="12" y="${mt + ph / 2}" font-size="11" fill="${K.ink2}" transform="rotate(-90 12 ${mt + ph / 2})" text-anchor="middle">ft MSL (mast site)</text>`);
    s += `<line x1="${ml}" x2="${ml + pw}" y1="${y(E * FT)}" y2="${y(E * FT)}" stroke="${K.ink3}" stroke-dasharray="2 3"/>` +
         `<text x="${ml + 4}" y="${y(E * FT) - 4}" font-size="10" fill="${K.ink3}">mast ground ${Math.round(E)} m</text>`;
    // dry adiabat through the 2 m temperature
    if (o.t[0] != null) {
      const z0 = ftOf(o.tl[0]), t0 = o.t[0], t1 = t0 - 0.0098 * ((TOP - z0) / FT);
      s += `<line x1="${x(t0)}" y1="${y(z0)}" x2="${x(t1)}" y2="${y(TOP)}" stroke="${K.dry}" stroke-dasharray="5 4"><title>dry adiabat through the ${o.tl[0]} m temperature (−9.8 K/km)</title></line>`;
    }
    const line = (pts, col, w, dash = '') => pts.length > 1 ? `<polyline points="${pts.map(p => `${x(p[1]).toFixed(1)},${y(p[0]).toFixed(1)}`).join(' ')}" fill="none" stroke="${col}" stroke-width="${w}" ${dash ? `stroke-dasharray="${dash}"` : ''}/>` : '';
    // sonde, MEPS, Mode S, then the mast on top
    if (sd.length) s += line(sd.filter(l => l[1] != null).map(l => [(l[0] + E) * FT, l[1]]), K.sonde, 1.6);
    if (mp.length) s += line(mp.map(l => [(l[0] + E) * FT, l[1]]), K.meps, 1.8);
    if (sfc && sfc.t != null && st.meps) s += `<rect x="${x(sfc.t) - 4}" y="${y(ftOf(2)) - 4}" width="8" height="8" fill="none" stroke="${K.meps}" stroke-width="1.6"><title>MEPS 2 m temperature at the mast ${sfc.t.toFixed(1)} °C (weather maps, ${sfc.km} km)</title></rect>`;
    if (msT.length) {
      s += line(msT.map(r => [r[0], r[1]]), K.modes, 1.6, '4 3');
      msT.forEach(r => { s += `<circle cx="${x(r[1])}" cy="${y(r[0])}" r="3" fill="${K.modes}"><title>Mode S (airport) ${Math.round(r[0])} ft: ${r[1].toFixed(1)} °C (${r[2]} flights)</title></circle>`; });
    }
    s += line(srcT, K.mast, 2.6);
    o.tl.forEach((h, i) => {
      if (o.t[i] == null) return;
      s += `<circle cx="${x(o.t[i])}" cy="${y(ftOf(h))}" r="4" fill="${K.mast}" stroke="${K.bg}" stroke-width="1.2"><title>Mast ${h} m (${ftOf(h)} ft MSL): ${o.t[i].toFixed(1)} °C, RH ${o.rh[i] ?? '–'} %, dewpoint ${o.td[i] != null ? o.td[i].toFixed(1) : '–'} °C</title></circle>`;
    });
    // wind barbs: one column per source at the right
    const cols = [['Mast', K.mast, true], ['Mode S', K.modes, !!msW.length], ['MEPS', K.meps, !!mp.length], ['Sonde', K.sonde, !!sd.length]].filter(c => c[2]);
    const cx = i => ml + pw + (cp ? 20 : 26) + i * cs, bl = cp ? 16 : 20;
    cols.forEach((c, i) => { s += `<text x="${cx(i)}" y="${mt + ph + 14}" text-anchor="middle" font-size="10" font-weight="600" fill="${c[1]}">${c[0]}</text>`; });
    const col = name => cols.findIndex(c => c[0] === name);
    o.wl.forEach((h, i) => {
      const yy = y(ftOf(h));
      s += `<g><title>Mast ${h} m (${ftOf(h)} ft MSL): ${o.wd[i] != null ? String(Math.round(o.wd[i])).padStart(3, '0') + '°' : '–'} ${o.ws[i] != null ? Math.round(o.ws[i]) + ' kt' : ''}, gust ${o.wg[i] != null ? Math.round(o.wg[i]) + ' kt' : '–'}</title>${barb(cx(col('Mast')), yy, o.ws[i], o.wd[i], K.mast, bl)}</g>`;
    });
    const thin = (pts, key) => { let last = -1e9; return pts.filter(p => { const yy = y(p[0]); if (Math.abs(yy - last) < 18) return false; last = yy; return true; }); };
    if (msW.length) thin(msW.slice().sort((a, b) => a[0] - b[0])).forEach(r => {
      s += `<g><title>Mode S (airport) ${Math.round(r[0])} ft: ${String(Math.round(r[2])).padStart(3, '0')}° ${Math.round(r[1])} kt (${r[3]} observations)</title>${barb(cx(col('Mode S')), y(r[0]), r[1], r[2], K.modes, bl)}</g>`;
    });
    if (mp.length) thin(mp.map(l => [(l[0] + E) * FT, l[2], l[3]])).forEach(r => {
      s += `<g><title>MEPS ${Math.round(r[0])} ft: ${r[2] != null ? String(Math.round(r[2])).padStart(3, '0') + '°' : '–'} ${r[1] != null ? Math.round(r[1]) + ' kt' : ''}</title>${barb(cx(col('MEPS')), y(r[0]), r[1], r[2], K.meps, bl)}</g>`;
    });
    if (sd.length) thin(sd.map(l => [(l[0] + E) * FT, l[2], l[3]])).forEach(r => {
      s += `<g><title>Sonde ${Math.round(r[0])} ft: ${r[2] != null ? String(Math.round(r[2])).padStart(3, '0') + '°' : '–'} ${r[1] != null ? Math.round(r[1]) + ' kt' : ''}</title>${barb(cx(col('Sonde')), y(r[0]), r[1], r[2], K.sonde, bl)}</g>`;
    });
    s += `<rect x="${ml}" y="${mt}" width="${pw}" height="${ph}" fill="none" stroke="${K.grid}"/></svg>`;
    // legend line under the chart
    const L = [`<span style="color:${K.mast}">● Mast ${utc(o.ts)} UTC</span>`];
    if (ms) L.push(`<span style="color:${K.modes}">● Mode S at EFHK, ${utc(ms.ts, false)}–${pad((new Date(ms.ts * 1000).getUTCHours() + 1) % 24)}:00 UTC</span>`);
    else if (st.modes) L.push('<span class="text-dim">Mode S: no boundary-layer hour</span>');
    if (prof.meps && st.meps) L.push(`<span style="color:${K.meps}">● MEPS run ${utc(prof.meps.run, false)} +${prof.meps.lead} h (area mean)</span>`);
    if (prof.sonde && st.sonde) L.push(`<span style="color:${K.sonde}">● ${esc(prof.sonde.station)} ${utc(prof.sonde.launch)} UTC</span>`);
    return { svg: s, legend: L };
  }

  // ── time series ─────────────────────────────────────────────────────────
  let geo = null;
  function renderSeries() {
    const el = $('mt-series');
    if (!el) return;
    const R = (ser && ser.rows) || [];
    if (!R.length) { el.innerHTML = '<div class="sv-empty">No observations in this period.</div>'; geo = null; return; }
    const r0 = seriesSvg(ser, prof && prof.found ? prof.obs.ts : null);
    el.innerHTML = r0.svg;
    geo = r0.geo;
    const svg = $('mt-series-svg');
    svg.addEventListener('mousemove', hover);
    svg.addEventListener('mouseleave', () => { $('mt-tip').style.display = 'none'; const c = $('mt-cur'); if (c) c.setAttribute('visibility', 'hidden'); });
    svg.addEventListener('click', ev => { const r = nearest(ev); if (r) loadProfile(r[0]); });
  }
  // the time series as SVG (from 2026-11-01 night also the phone's Mast view, o2.compact);
  // the temperature axis inverted (colder up, from 2026-11-01 night): the levels lie as their heights
  function seriesSvg(ser, pt, o2 = {}) {
    const R = ser.rows, cp = !!o2.compact;
    const K = C(), wl = ser.wl, tl = ser.tl;
    const W = cp ? 380 : 900, ml = cp ? 34 : 52, mr = cp ? 62 : 70, pw = W - ml - mr;
    const P = [{ k: 'ws', h: cp ? 110 : 150, label: 'Wind speed (kt)' }, { k: 'wd', h: cp ? 80 : 110, label: 'Direction (°)' },
               { k: 't', h: cp ? 140 : 150, label: 'Temperature (°C) · inverted, colder up' }, { k: 'dt', h: cp ? 70 : 90, label: `T(${tl[tl.length - 1]} m) − T(${tl[0]} m) (K)` }];
    const gap = 26, mt = 10;
    const H = mt + P.reduce((s, p) => s + p.h + gap, 0) + 6;
    const t0 = ser.start, t1 = ser.end;
    const x = t => ml + pw * (t - t0) / (t1 - t0);
    let s = `<svg viewBox="0 0 ${W} ${H}" id="mt-series-svg" role="img" aria-label="Mast time series" style="cursor:crosshair">`;
    // day / hour grid
    const span = t1 - t0, hstep = span > 4 * 86400 ? 86400 : span > 36 * 3600 ? 6 * 3600 : 3 * 3600;
    let yy = mt;
    const panels = [];
    for (const p of P) {
      let vals = [];
      if (p.k === 'ws') { R.forEach(r => { r[4].forEach(v => v != null && vals.push(v)); r[6].forEach(v => v != null && vals.push(v)); }); }
      else if (p.k === 't') R.forEach(r => r[1].forEach(v => v != null && vals.push(v)));
      else if (p.k === 'dt') R.forEach(r => { if (r[1][tl.length - 1] != null && r[1][0] != null) vals.push(r[1][tl.length - 1] - r[1][0]); });
      let lo = p.k === 'wd' ? 0 : Math.min(...vals), hi = p.k === 'wd' ? 360 : Math.max(...vals);
      if (p.k === 'ws') lo = 0;
      if (p.k === 'dt') { lo = Math.min(lo, -3); hi = Math.max(hi, 1); }
      if (p.k === 't') { lo = Math.floor(lo - 0.5); hi = Math.ceil(hi + 0.5); }
      if (p.k === 'ws') hi = Math.max(10, Math.ceil(hi / 5) * 5);
      if (!isFinite(lo) || !isFinite(hi) || hi === lo) { lo = 0; hi = 1; }
      const ya = p.k === 't' ? v => yy + p.h * (v - lo) / (hi - lo) : v => yy + p.h * (1 - (v - lo) / (hi - lo));
      panels.push({ ...p, y0: yy, lo, hi, ya });
      s += `<text x="${ml}" y="${yy - 2}" font-size="11" font-weight="600" fill="${K.ink2}">${p.label}</text>`;
      // horizontal grid
      const ys = p.k === 'wd' ? [0, 90, 180, 270, 360] : (() => { const st2 = (hi - lo) > 20 ? 10 : (hi - lo) > 8 ? 5 : (hi - lo) > 4 ? 2 : 1; const a = []; for (let v = Math.ceil(lo / st2) * st2; v <= hi; v += st2) a.push(v); return a; })();
      for (const v of ys) s += `<line x1="${ml}" x2="${ml + pw}" y1="${ya(v)}" y2="${ya(v)}" stroke="${v === 0 && p.k !== 'wd' ? K.zero : K.grid}"/><text x="${ml - 6}" y="${ya(v) + 4}" text-anchor="end" font-size="10" fill="${K.ink2}">${v}</text>`;
      for (let t = Math.ceil(t0 / hstep) * hstep; t <= t1; t += hstep) {
        const d = new Date(t * 1000), mid = d.getUTCHours() === 0;
        s += `<line x1="${x(t)}" x2="${x(t)}" y1="${yy}" y2="${yy + p.h}" stroke="${mid ? K.zero : K.grid}"/>`;
        if (p.k === 'dt') s += `<text x="${x(t)}" y="${yy + p.h + 14}" text-anchor="middle" font-size="10" fill="${K.ink2}">${mid ? `${d.getUTCDate()}.${d.getUTCMonth() + 1}.` : pad(d.getUTCHours())}</text>`;
      }
      // data
      const path = (get) => {
        let d = '', pen = false, lastT = null;
        for (const r of R) {
          const v = get(r);
          if (v == null || (lastT != null && r[0] - lastT > 1800)) { pen = false; }
          if (v != null) { d += `${pen ? 'L' : 'M'}${x(r[0]).toFixed(1)},${ya(v).toFixed(1)}`; pen = true; }
          lastT = r[0];
        }
        return d;
      };
      if (p.k === 'ws') {
        wl.forEach((h, i) => {
          const c = ramp(i / Math.max(1, wl.length - 1));
          s += `<path d="${path(r => r[6][i])}" fill="none" stroke="${c}" stroke-width="0.9" stroke-dasharray="2 3" opacity="0.7"/>`;
          s += `<path d="${path(r => r[4][i])}" fill="none" stroke="${c}" stroke-width="1.6"/>`;
        });
      } else if (p.k === 'wd') {
        wl.forEach((h, i) => {
          const c = ramp(i / Math.max(1, wl.length - 1));
          const stepN = Math.max(1, Math.round(R.length / 400));
          R.forEach((r, k) => { if (k % stepN === 0 && r[5][i] != null) s += `<circle cx="${x(r[0]).toFixed(1)}" cy="${ya(r[5][i]).toFixed(1)}" r="1.4" fill="${c}"/>`; });
        });
      } else if (p.k === 't') {
        tl.forEach((h, i) => { s += `<path d="${path(r => r[1][i])}" fill="none" stroke="${ramp(i / Math.max(1, tl.length - 1))}" stroke-width="${i === 0 || i === tl.length - 1 ? 1.8 : 1.1}"/>`; });
      } else {
        const dry = -0.0098 * (tl[tl.length - 1] - tl[0]);
        s += `<line x1="${ml}" x2="${ml + pw}" y1="${ya(dry)}" y2="${ya(dry)}" stroke="${K.dry}" stroke-dasharray="5 4"><title>dry-adiabatic ${dry.toFixed(1)} K</title></line>`;
        const bw = Math.max(1, pw / R.length);
        R.forEach(r => {
          const a = r[1][tl.length - 1], b = r[1][0];
          if (a == null || b == null) return;
          const v = a - b, col = v > 0 ? K.inv : v < dry - 0.6 ? K.unst : K.ink3;
          s += `<rect x="${x(r[0]).toFixed(1)}" y="${Math.min(ya(v), ya(0)).toFixed(1)}" width="${bw.toFixed(2)}" height="${Math.max(0.5, Math.abs(ya(v) - ya(0))).toFixed(1)}" fill="${col}" opacity="0.85"/>`;
        });
      }
      s += `<rect x="${ml}" y="${yy}" width="${pw}" height="${p.h}" fill="none" stroke="${K.grid}"/>`;
      yy += p.h + gap;
    }
    // level keys at the right
    const keyY = panels[0].y0 + 6;
    // highest level at the top, lowest at the bottom, as the heights go (2026-11-01)
    const kRow = (n, i) => n - 1 - i;
    wl.forEach((h, i) => { const ky = keyY + kRow(wl.length, i) * 16; s += `<line x1="${ml + pw + 8}" x2="${ml + pw + 22}" y1="${ky}" y2="${ky}" stroke="${ramp(i / Math.max(1, wl.length - 1))}" stroke-width="2"/><text x="${ml + pw + 26}" y="${ky + 4}" font-size="10" fill="${K.ink2}">${h} m</text>`; });
    s += `<text x="${ml + pw + 8}" y="${keyY + wl.length * 16 + 6}" font-size="9" fill="${K.ink3}">- - gust</text>`;
    const keyT = panels[2].y0 + 6;
    tl.forEach((h, i) => { const ky = keyT + kRow(tl.length, i) * 16; s += `<line x1="${ml + pw + 8}" x2="${ml + pw + 22}" y1="${ky}" y2="${ky}" stroke="${ramp(i / Math.max(1, tl.length - 1))}" stroke-width="2"/><text x="${ml + pw + 26}" y="${ky + 4}" font-size="10" fill="${K.ink2}">${h} m</text>`; });
    // cursor line (moved by the hover) and the chosen profile time
    s += `<line id="mt-cur" x1="0" x2="0" y1="${mt}" y2="${H - 30}" stroke="${K.ink2}" stroke-width="1" visibility="hidden"/>`;
    if (pt && pt >= t0 && pt <= t1) s += `<line x1="${x(pt)}" x2="${x(pt)}" y1="${mt}" y2="${H - 30}" stroke="${K.mast}" stroke-width="1.2" stroke-dasharray="3 3"><title>the profile shown</title></line>`;
    s += '</svg>';
    return { svg: s, geo: { x, t0, t1, ml, pw, W, R, wl, tl, panels } };
  }
  function nearest(ev) {
    if (!geo) return null;
    const svg = $('mt-series-svg'), b = svg.getBoundingClientRect();
    const sx = (ev.clientX - b.left) * geo.W / b.width;
    if (sx < geo.ml || sx > geo.ml + geo.pw) return null;
    const t = geo.t0 + (sx - geo.ml) / geo.pw * (geo.t1 - geo.t0);
    let best = null, bd = Infinity;
    for (const r of geo.R) { const d = Math.abs(r[0] - t); if (d < bd) { bd = d; best = r; } }
    return bd <= 1800 ? best : null;
  }
  function hover(ev) {
    const r = nearest(ev), tip = $('mt-tip'), cur = $('mt-cur');
    if (!r) { tip.style.display = 'none'; if (cur) cur.setAttribute('visibility', 'hidden'); return; }
    const xx = geo.x(r[0]);
    if (cur) { cur.setAttribute('x1', xx); cur.setAttribute('x2', xx); cur.setAttribute('visibility', 'visible'); }
    const wl = geo.wl, tl = geo.tl;
    const w = wl.map((h, i) => `${h} m: ${r[5][i] != null ? String(Math.round(r[5][i])).padStart(3, '0') + '°' : '–'} ${r[4][i] != null ? Math.round(r[4][i]) : '–'} kt <span class="mini-tip-dim">G${r[6][i] != null ? Math.round(r[6][i]) : '–'}</span>`).reverse().join('<br>');
    const t = tl.map((h, i) => `${h} m ${r[1][i] != null ? r[1][i].toFixed(1) : '–'} °C <span class="mini-tip-dim">${r[2][i] != null ? Math.round(r[2][i]) + ' %' : ''}</span>`).reverse().join('<br>');
    tip.innerHTML = `<b>${utc(r[0])} UTC</b> <span class="mini-tip-dim">· click: this profile</span><br>${w}<br>${t}`;
    const box = $('mt-series').getBoundingClientRect();
    tip.style.display = '';
    const left = ev.clientX - box.left + 14, tw = tip.offsetWidth;
    tip.style.left = (left + tw > box.width ? ev.clientX - box.left - tw - 14 : left) + 'px';
    tip.style.top = Math.max(0, ev.clientY - box.top - 40) + 'px';
  }

  // ── comparison ──────────────────────────────────────────────────────────
  function renderCompare() {
    const el = $('mt-compare'), elT = $('mt-compare-t');
    if (!el || !elT) return;
    if (!cmp || !cmp.sources) { el.innerHTML = elT.innerHTML = '<tbody><tr><td class="sv-empty">No mast observations in this period.</td></tr></tbody>'; return; }
    const S = cmp.sources, srcs = [['modes', 'Mode S (EFHK)'], ['meps', 'MEPS (model levels)'], ['sonde', 'Sonde (Jokioinen)']];
    const big = (v, lim) => v != null && Math.abs(v) >= lim ? 'snd-dev' : '';
    el.innerHTML = '<thead><tr><th>Mast level</th>' + srcs.map(([, n]) => `<th class="num" colspan="4">${n}</th>`).join('') + '</tr>' +
      '<tr><th></th>' + srcs.map(() => '<th class="num" title="Hours (Mode S) or observations compared">n</th><th class="num" title="Speed difference, source − mast (kt): + = the source stronger">Speed</th><th class="num" title="Vector RMS difference (kt)">Vector RMS</th><th class="num" title="Direction difference, source − mast (°, winds of 5 kt or more): + = the source veered (clockwise)">Dir.</th>').join('') + '</tr></thead><tbody>' +
      cmp.wl.slice().reverse().map(h => {
        const cells = srcs.map(([k]) => {
          const r = (S[k].wind || []).find(x => x.h_m === h) || {};
          return r.n ? `<td class="num text-dim">${r.n}</td><td class="num ${big(r.spd_bias, 5)}">${f1(r.spd_bias, 1, true)}</td><td class="num ${big(r.vrms, 10)}">${f1(r.vrms, 1)}</td><td class="num">${r.dir_bias != null ? f1(r.dir_bias, 0, true) + '°' : '–'}</td>`
                     : '<td class="num text-dim">0</td><td class="num">–</td><td class="num">–</td><td class="num">–</td>';
        }).join('');
        return `<tr><td>${h} m <span class="text-dim">${ftOf(h).toLocaleString('en')} ft</span></td>${cells}</tr>`;
      }).join('') + '</tbody>';
    elT.innerHTML = '<thead><tr><th>Mast level</th>' + srcs.map(([, n]) => `<th class="num" colspan="3">${n}</th>`).join('') + '</tr>' +
      '<tr><th></th>' + srcs.map(() => '<th class="num">n</th><th class="num" title="Mean difference, source − mast (K): + = the source warmer">Mean</th><th class="num">RMS</th>').join('') + '</tr></thead><tbody>' +
      cmp.tl.slice().reverse().map(h => {
        const cells = srcs.map(([k]) => {
          const r = (S[k].temp || []).find(x => x.h_m === h) || {};
          return r.n ? `<td class="num text-dim">${r.n}</td><td class="num ${big(r.bias, 1.5)}">${f1(r.bias, 2, true)}</td><td class="num">${f1(r.rms, 2)}</td>`
                     : '<td class="num text-dim">0</td><td class="num">–</td><td class="num">–</td>';
        }).join('');
        return `<tr><td>${h} m <span class="text-dim">${ftOf(h).toLocaleString('en')} ft</span></td>${cells}</tr>`;
      }).join('') + '</tbody>';
    const sf = (S.meps_sfc || {});
    $('mt-compare-sfc').innerHTML = `Last ${cmp.days} days, ${cmp.hours} mast hours: Mode S in ${cmp.n_modes} hours, MEPS in ${cmp.n_meps}, ${cmp.n_sonde} soundings. ` +
      `MEPS weather maps at the mast: 2 m temperature ${sf.t2m ? `<b>${f1(sf.t2m.bias, 2, true)} K</b> (RMS ${f1(sf.t2m.rms, 2)}, n ${sf.t2m.n})` : '–'}; ` +
      `10 m wind against the mast's ${cmp.wl[0]} m: ${sf.w10 ? `speed <b>${f1(sf.w10.spd_bias, 1, true)} kt</b>, vector RMS ${f1(sf.w10.vrms, 1)} kt (n ${sf.w10.n})` : '–'}.`;
  }

  // ── controls ────────────────────────────────────────────────────────────
  function syncControls() {
    document.querySelectorAll('#mt-hours-btns .snd-mode-btn').forEach(b => b.classList.toggle('active', Number(b.dataset.h) === st.hours));
    document.querySelectorAll('#mt-days-btns .snd-mode-btn').forEach(b => b.classList.toggle('active', Number(b.dataset.days) === st.days));
    if ($('mt-modes')) $('mt-modes').checked = st.modes;
    if ($('mt-meps')) $('mt-meps').checked = st.meps;
    if ($('mt-sonde')) $('mt-sonde').checked = st.sonde;
  }
  function init() {
    document.querySelectorAll('#mt-hours-btns .snd-mode-btn').forEach(b => b.addEventListener('click', () => {
      st.hours = Number(b.dataset.h); lsSet('ms_mast_hours', st.hours); load(); }));
    document.querySelectorAll('#mt-days-btns .snd-mode-btn').forEach(b => b.addEventListener('click', async () => {
      st.days = Number(b.dataset.days); lsSet('ms_mast_days', st.days); syncControls();
      try { cmp = await (await fetch(`/api/mast/compare?days=${st.days}`)).json(); renderCompare(); } catch (e) { console.error(e); }
    }));
    for (const [id, k] of [['mt-modes', 'modes'], ['mt-meps', 'meps'], ['mt-sonde', 'sonde']])
      if ($(id)) $(id).addEventListener('change', e => { st[k] = e.target.checked; lsSet('ms_mast_' + k, st[k]); renderProfile(); });
    if ($('mt-now')) $('mt-now').addEventListener('click', () => loadProfile(null));
    if ($('mt-series')) new ResizeObserver(() => { if (on) renderSeries(); }).observe($('mt-series'));
  }
  function active(v) {
    on = !!v;
    clearInterval(timer);
    if (on) timer = setInterval(() => { if (!document.hidden && on) load(); }, 5 * 60 * 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.MastView = { load, render, active, profileSvg, seriesSvg };
})();
