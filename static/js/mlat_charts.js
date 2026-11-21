/**
 * mlat_charts.js — the MLAT tab's "Charts" view (from 2026-11-19; Statistics
 * page, MLAT right only): statistics of our own position fixes from
 * /api/mlat/fixstats (collector/mlat_fix.py; by the minute for 1 h, 10-minute
 * steps for 24 h, hours for 7 d — the minutes and hours are stored in mlat.db).
 *
 *   error against ADS-B over time (within 20 NM, 20–40 NM) and fixes per minute
 *   measured against expected error by distance from the airport
 *   where a fix lies from the aircraft's own position, along / across the flight direction
 *   the clock of the receiver without GPS time: spread, reference aircraft, drift
 *   aircraft with a fix, with and without a position of their own; the share by altitude
 *   unresolved fixes and the time until a track is confirmed
 *   the GPS-timed receivers' clocks against the main one (from 2026-11-20)
 *   from 2026-11-21 midday: the counter receiver's clock through the period (fitted / carried / none) and the
 *   aircraft it could be set by; what became of the replies heard by three receivers; fixes inside their stated
 *   error; aircraft without a position of their own, heard and located; the air temperature under the drift;
 *   tracks confirmed and put in doubt; positions that do not fit the GPS-timed receivers (/api/mlat/suspects);
 *   which receivers hear a reply together; one line per day
 *
 * From the evening of 2026-11-21 the panels can be put in another order: drag one by its title bar (mouse or
 * pen) and the others make room, in the same grid; the order is kept in this browser (ms_mlc_order) and
 * "Reset layout" brings the original one back (static/js/panel_order.js, shared with the Statistics page).
 *
 * The view's buttons and the page switching are in static/js/mlat_map.js.
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  if (!$('mst-mlat-charts') || typeof Chart === 'undefined') return;
  const POLL = 30000, CH = {};
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* a convenience only */ } };
  const light = () => document.documentElement.dataset.theme === 'light';
  // two series colours (validated for both themes) and a neutral
  // (c: a third hue, from 2026-11-21 — blue / orange / violet pass the palette checks on both surfaces; n is the neutral)
  const COL = () => light() ? { a: '#1d4ed8', b: '#c2410c', c: '#7c3aed', n: '#64748b', txt: '#475569' } : { a: '#3b82f6', b: '#ea580c', c: '#8b5cf6', n: '#94a3b8', txt: '#94a3b8' };
  const GRID = 'rgba(148,163,184,.18)';
  let on = false, rng = lsGet('ms_mlc_rng', '1h'), timer = null, data = null, sus = null;
  const esc = v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = v => v == null ? '—' : Math.round(v).toLocaleString('en');
  const pct = (a, b, d = 0) => b ? (100 * a / b).toFixed(d) + ' %' : '—';
  const hm = t => { const d = new Date(t * 1000); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const pad = n => String(n).padStart(2, '0');
  const lab = (t, r) => { const d = new Date(t * 1000); return r === '7d' ? `${d.getUTCDate()}.${d.getUTCMonth() + 1} ${pad(d.getUTCHours())}` : `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const mTxt = v => v == null ? '—' : v >= 10000 ? (v / 1000).toFixed(0) + ' km' : v >= 1000 ? (v / 1000).toFixed(1) + ' km' : Math.round(v) + ' m';

  function setRng(r) {
    rng = r; lsSet('ms_mlc_rng', r);
    $('mlc-rng').querySelectorAll('[data-rng]').forEach(b => b.classList.toggle('active', b.dataset.rng === r));
    document.dispatchEvent(new CustomEvent('mlc-range'));      // the map's accuracy grid follows
    if (on) poll();
  }
  $('mlc-rng').addEventListener('click', e => { const b = e.target.closest('[data-rng]'); if (b && b.dataset.rng !== rng) setRng(b.dataset.rng); });
  $('mlc-rng').querySelectorAll('[data-rng]').forEach(b => b.classList.toggle('active', b.dataset.rng === rng));
  document.addEventListener('mlm-view', e => { on = !!(e.detail && e.detail.charts); clearTimeout(timer); if (on) poll(); });
  new MutationObserver(() => { if (on && data) render(data); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // ── The order of the panels: drag one by its title bar (static/js/panel_order.js); kept in this browser ──
  if (window.PanelOrder) window.PanelOrder.attach({ root: $('mst-mlat-charts'), key: 'ms_mlc_order', reset: $('mlc-reset') });

  async function poll() {
    clearTimeout(timer);
    if (!on) return;
    if (!document.hidden) {
      try {
        const r = await fetch('/api/mlat/fixstats?range=' + rng, { cache: 'no-store' });
        if (!r.ok) throw new Error(r.status);
        data = await r.json();
        try { const q = await fetch('/api/mlat/suspects', { cache: 'no-store' }); sus = q.ok ? await q.json() : null; } catch (_) { sus = null; }
        render(data);
      } catch (_) { $('mlc-note').textContent = 'Update failed — retrying'; }
    }
    timer = setTimeout(poll, POLL);
  }

  function chart(key, id, type, labels, datasets, opt = {}) {
    const C = COL();
    const cfg = { type, data: { labels, datasets: datasets.map(d => Object.assign(type === 'line' ? { borderWidth: 2, pointRadius: 0, tension: 0, spanGaps: false } : { borderWidth: 0, borderRadius: 2 }, d)) },
      options: { animation: false, responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: datasets.length > 1, labels: { color: C.txt, boxWidth: 14, font: { size: 10.5 } } },
                   tooltip: { callbacks: opt.tip ? { label: opt.tip } : {} } },
        scales: { x: { stacked: !!opt.stacked, grid: { display: false }, ticks: { color: C.txt, maxRotation: 0, autoSkip: true, maxTicksLimit: opt.xt || 10, font: { size: 10 } } },
                  y: { stacked: !!opt.stacked, beginAtZero: opt.zero !== false, grid: { color: GRID }, ticks: { color: C.txt, font: { size: 10 }, precision: opt.prec },
                       title: { display: !!opt.y, text: opt.y, color: C.txt, font: { size: 10 } }, suggestedMax: opt.smax, max: opt.max } } } };
    if (CH[key]) { CH[key].data = cfg.data; CH[key].options = cfg.options; CH[key].update('none'); }
    else CH[key] = new Chart($(id), cfg);
  }

  function render(d) {
    const note = $('mlc-note');
    if (!d.on) { note.textContent = 'Position fixes are off: ' + (d.why || 'not available on this server'); return; }
    const C = COL(), S = d.series || [], L = S.map(r => lab(r.t, d.range)), T = d.total || {};
    const stepMin = d.step / 60;
    note.textContent = S.length ? `${d.range === '1h' ? 'by the minute' : d.range === '24h' ? '10-minute steps' : 'by the hour'} · times in UTC`
                                : 'No statistics yet — the first minute closes shortly after the start';
    // 1. the error over time, and the number of fixes
    chart('err', 'mlc-err', 'line', L, [
      { label: 'within 20 NM of the airport', data: S.map(r => r.e20 && r.e20[0] >= 20 ? r.e20[1] : null), borderColor: C.a },
      { label: '20–40 NM', data: S.map(r => r.e40 && r.e40[0] >= 20 ? r.e40[1] : null), borderColor: C.b }], { y: 'median, m', xt: 14 });
    chart('fix', 'mlc-fix', 'bar', L, [{ label: 'fixes per minute', data: S.map(r => Math.round(r.fx / stepMin)), backgroundColor: C.n }], { xt: 14 });
    // 2. measured against expected, by distance
    const bn = (d.bands || []).map((b, i, a) => `${i ? a[i - 1] : 0}–${b} NM`).concat([`${(d.bands || []).slice(-1)[0]} NM +`]);
    const B = T.b || [];
    chart('band', 'mlc-band', 'bar', bn, [
      { label: 'measured (median of single fixes)', data: B.map(b => b[0] >= 5 ? b[1] : null), backgroundColor: C.a },
      { label: 'expected from the geometry', data: B.map(b => b[0] >= 5 ? b[3] : null), backgroundColor: C.n }], { y: 'm' });
    $('mlc-band-t').innerHTML = '<thead><tr><th>Distance</th><th class="num">Fixes</th><th class="num">Measured</th><th class="num" title="Nine tenths of the single fixes are closer than this">90 %</th><th class="num">Expected</th><th class="num" title="Median for the smoothed track">Track</th></tr></thead><tbody>' +
      B.map((b, i) => `<tr><td>${bn[i]}</td><td class="num">${b[0]}</td><td class="num">${mTxt(b[1])}</td><td class="num">${mTxt(b[2])}</td><td class="num">${mTxt(b[3])}</td><td class="num">${mTxt(b[4])}</td></tr>`).join('') + '</tbody>';
    // 3. where a fix lies from the own position
    scatter(d.scatter || []);
    // 4. the clock of the receiver without GPS time
    const ck = k => S.map(r => r.ck ? r.ck[k] : null);
    chart('cks', 'mlc-ck-sig', 'line', L, [{ label: 'spread, ns', data: ck(0), borderColor: C.a }], {});
    chart('cka', 'mlc-ck-ac', 'line', L, [{ label: 'reference aircraft', data: ck(3), borderColor: C.a, stepped: true }], { prec: 0 });
    // (in ppb from 2026-11-21 midday — parts in a billion, the unit the crystal's wander is read in; before: ppm)
    chart('ckd', 'mlc-ck-dr', 'line', L, [{ label: 'drift, ppb', data: ck(1).map(v => v == null ? null : +v.toFixed(1)), borderColor: C.a }], { zero: false });
    // 5. aircraft with a fix; the share by altitude
    chart('ac', 'mlc-ac', 'bar', L, [
      { label: 'also broadcast their position', data: S.map(r => Math.max(0, r.ac - r.np)), backgroundColor: C.a, borderColor: 'transparent', borderWidth: { top: 1 } },
      { label: 'send no position of their own', data: S.map(r => r.np), backgroundColor: C.b }], { stacked: true, prec: 0, y: 'aircraft', xt: 10 });
    const ab = d.alt_bands || [], an = ab.map((b, i) => `${i ? ab[i - 1].toLocaleString('en') : 0}–${b.toLocaleString('en')} ft`).concat([`${(ab.slice(-1)[0] || 0).toLocaleString('en')} ft +`]);
    const nS = T.n || 1, per = d.range === '7d' ? 'hour' : d.range === '24h' ? '10 minutes' : 'minute';
    $('mlc-cov').innerHTML = `<thead><tr><th>Altitude</th><th class="num" title="Aircraft heard by two or more receivers, on average per ${per}">Heard</th><th class="num" title="Of them with a resolved fix, on average per ${per}">With a fix</th><th class="num">Share</th></tr></thead><tbody>` +
      (T.cov || []).map((c, i) => `<tr><td>${an[i]}</td><td class="num">${(c[0] / nS).toFixed(1)}</td><td class="num">${(c[1] / nS).toFixed(1)}</td><td class="num">${c[0] ? Math.round(100 * Math.min(c[1], c[0]) / c[0]) + ' %' : '—'}</td></tr>`).join('') + '</tbody>';
    $('mlc-low').textContent = T.low != null ? `Lowest resolved fix within 10 NM of the airport: ${Math.round(T.low).toLocaleString('en')} ft (pressure altitude).` : '';
    // 6. unresolved fixes; the time to confirm a track
    chart('amb', 'mlc-amb', 'line', L, [{ label: 'unresolved, %', data: S.map(r => r.fx >= 20 ? +(100 * r.am / r.fx).toFixed(1) : null), borderColor: C.b }], { smax: 30 });
    chart('rs', 'mlc-rs', 'line', L, [{ label: 'seconds', data: S.map(r => r.rs ? r.rs[1] : null), borderColor: C.a }], {});
    // 7. the GPS-timed receivers' clocks against the main one (from 2026-11-20): gb = {receiver: [ns, aircraft, lowest, highest]}
    const gk = [...new Set(S.flatMap(r => Object.keys(r.gb || {})))].sort();
    const gcol = [C.a, C.b, C.n];
    chart('gb', 'mlc-gb', 'line', L, gk.length ? gk.map((k, i) => ({ label: k, data: S.map(r => r.gb && r.gb[k] ? r.gb[k][0] : null), borderColor: gcol[i % 3] }))
                                               : [{ label: '', data: S.map(() => null), borderColor: C.a }],
      { zero: false, y: 'ns', tip: c => { const v = (S[c.dataIndex].gb || {})[c.dataset.label]; return v ? `${c.dataset.label}: ${v[0]} ns (${v[2]} … ${v[3]}), ${v[1]} aircraft` : ''; } });
    chart('gba', 'mlc-gb-ac', 'line', L, gk.length ? gk.map((k, i) => ({ label: k, data: S.map(r => r.gb && r.gb[k] ? r.gb[k][1] : null), borderColor: gcol[i % 3], stepped: true }))
                                                  : [{ label: '', data: S.map(() => null), borderColor: C.a }], { prec: 0 });
    const gT = T.gb || {};
    $('mlc-gb-t').textContent = gk.length ? gk.map(k => gT[k] ? `${k}: ${gT[k][0]} ns in the middle, between ${gT[k][2]} and ${gT[k][3]} ns (${(gT[k][3] - gT[k][2]).toFixed(0)} ns apart).` : '').join(' ') +
      ' The value itself comes from the cables and electronics and does not matter; how it moves does. Slow waves of some tens of nanoseconds come from the satellites in view and the sky each GPS antenna sees, and the fixes follow them. With only a few aircraft behind it the value also moves with which aircraft they are, because the receivers stamp strong replies a little early. A step means that the GPS time of a receiver jumped.'
      : 'No values yet: they need a second GPS-timed receiver and at least three aircraft with a good position heard by both.';
    $('mlc-cnt').textContent = T.tr ? `In this period: ${T.h3.toLocaleString('en')} replies heard by three receivers, ${T.tr.toLocaleString('en')} tried (at most three per aircraft and second), ` +
      `${T.fx.toLocaleString('en')} fixes (${Math.round(100 * T.fx / T.tr)} %), ${T.fx ? Math.round(100 * T.am / T.fx) : 0} % of them unresolved; no clock line for ${T.nc.toLocaleString('en')} replies` +
      // from 2026-11-21: how many of the tried rested on the clock carried without a reference (hold-over)
      (T.hd ? `; for ${T.hd.toLocaleString('en')} of the tried the clock was carried without a reference.` : '.') : '';

    // ── from 2026-11-21 midday ────────────────────────────────────────────
    // 8. the counter receiver's clock through the period: of the attempts (tried + lost for want of a clock), the
    //    share made on a fitted line, on the carried clock, and lost; under it the aircraft it could be set by
    const att = r => (r.tr || 0) + (r.nc || 0), sh = (v, r) => att(r) >= 20 ? +(100 * v / att(r)).toFixed(1) : null;
    chart('clk', 'mlc-clk', 'bar', L, [
      { label: 'on a fitted line', data: S.map(r => sh((r.tr || 0) - (r.hd || 0), r)), backgroundColor: C.a },
      { label: 'on the carried clock', data: S.map(r => sh(r.hd || 0, r)), backgroundColor: C.c },
      { label: 'no clock', data: S.map(r => sh(r.nc || 0, r)), backgroundColor: C.b }], { stacked: true, y: '% of the attempts', xt: 14, max: 100 });
    const rf = i => S.map(r => r.rf ? r.rf[i] : null);
    chart('rf', 'mlc-rf', 'line', L, [
      { label: 'heard', data: rf(0), borderColor: C.n, stepped: true },
      { label: 'send a position', data: rf(1), borderColor: C.b, stepped: true },
      { label: 'usable to set the clock', data: rf(2), borderColor: C.a, stepped: true }], { prec: 0, xt: 14, y: 'aircraft' });
    const tA = (T.tr || 0) + (T.nc || 0);
    $('mlc-clk-t').textContent = tA ? `In this period ${pct((T.tr || 0) - (T.hd || 0), tA)} of the attempts were made on a fitted line, ${pct(T.hd || 0, tA, 1)} on the clock carried without a reference (at most three minutes) and ${pct(T.nc || 0, tA, 1)} were lost for want of a clock. ` +
      'The clock is set by aircraft with a usable position of their own; when the lowest line falls to zero and stays there, GNSS interference has taken them away and the orange share grows. The counts of the aircraft begin on 21 Nov 2026.' : '';
    // 9. what became of the replies heard by three receivers (the periods that have the new counts)
    const N = S.filter(r => r.sk != null), sum = k => N.reduce((a, r) => a + (r[k] || 0), 0);
    if (N.length) {
      const h3 = sum('h3'), sk = sum('sk'), nh = sum('nh'), nc = sum('nc'), tr = sum('tr'), fx = sum('fx'), am = sum('am'), po = sum('po'), hd = sum('hd');
      const row = (l, v, t, ind) => `<tr${t ? ` title="${esc(t)}"` : ''}><td${ind ? ' style="padding-left:18px"' : ''}>${l}</td><td class="num">${num(v)}</td><td class="num">${pct(v, h3, 1)}</td><td><span class="mlc-bar" style="width:${h3 ? Math.max(1, Math.round(90 * v / h3)) : 0}px"></span></td></tr>`;
      $('mlc-fun').innerHTML = '<thead><tr><th>Replies</th><th class="num">Number</th><th class="num">Share</th><th></th></tr></thead><tbody>' +
        row('heard by three receivers', h3) +
        row('not tried: more than three a second', sk, 'At most three replies of an aircraft are solved in a second; the rest are not needed', true) +
        row('no height for the aircraft', nh, 'No pressure altitude in the reply or known for the aircraft, or no way to turn it into a height', true) +
        row('no clock for the receiver without GPS time', nc, 'No reference aircraft, and the clock could not be carried', true) +
        row('tried', tr, hd ? `${num(hd)} of them on the carried clock` : '', true) +
        row('no position found', Math.max(0, tr - fx), `No solution near a track, or the expected error too large (${num(po)} of them)`, true) +
        row('position fixes', fx, '', true) +
        row('of them unresolved', am, 'Two positions still possible', true) + '</tbody>';
      $('mlc-fun-t').textContent = `${N.length < S.length ? 'The steps since 21 Nov 2026 (the earlier ones do not have all the counts). ' : ''}Of the replies that were tried, ${pct(fx, tr)} gave a fix; of all attempts, ${pct(nc, tr + nc, 1)} had no clock.`;
    } else { $('mlc-fun').innerHTML = ''; $('mlc-fun-t').textContent = 'No counts yet: they begin with the version of 21 Nov 2026.'; }
    chart('out', 'mlc-out', 'bar', L, [
      { label: 'resolved fix', data: S.map(r => sh((r.fx || 0) - (r.am || 0), r)), backgroundColor: C.a },
      { label: 'unresolved fix', data: S.map(r => sh(r.am || 0, r)), backgroundColor: C.c },
      { label: 'no position found', data: S.map(r => sh(Math.max(0, (r.tr || 0) - (r.fx || 0)), r)), backgroundColor: C.n },
      { label: 'no clock', data: S.map(r => sh(r.nc || 0, r)), backgroundColor: C.b }], { stacked: true, xt: 8, max: 100 });
    // 10. fixes inside their stated error (resolved fixes with an own position to compare): about two thirds belong
    const ieN = (r, i) => r.ie && r.ie[i] ? (r.ie[i][2] != null ? r.ie[i][2] : (r.b && r.b[i] ? r.b[i][0] : 0)) : 0;
    const ieS = (r, bands, j) => { if (!r.ie) return null; let a = 0, n = 0; for (const i of bands) { a += r.ie[i] ? r.ie[i][j] : 0; n += ieN(r, i); } return n >= 30 ? +(100 * a / n).toFixed(1) : null; };
    chart('ie', 'mlc-ie', 'line', L, [
      { label: 'within 20 NM of the airport', data: S.map(r => ieS(r, [0, 1], 0)), borderColor: C.a },
      { label: '20–40 NM', data: S.map(r => ieS(r, [2], 0)), borderColor: C.b },
      { label: 'two thirds', data: S.map(() => 66.7), borderColor: C.n, borderWidth: 1, borderDash: [4, 4] }], { y: '% inside the stated error', max: 100, xt: 8 });
    const IE = T.ie || [];
    $('mlc-ie-t').innerHTML = IE.length ? '<thead><tr><th>Distance</th><th class="num">Fixes compared</th><th class="num" title="Share of the fixes closer to the aircraft’s own position than their stated error">Inside the stated error</th><th class="num">Inside twice it</th></tr></thead><tbody>' +
      IE.map((e, i) => `<tr><td>${bn[i]}</td><td class="num">${num(e[2])}</td><td class="num">${e[2] >= 30 ? pct(e[0], e[2]) : '—'}</td><td class="num">${e[2] >= 30 ? pct(e[1], e[2]) : '—'}</td></tr>`).join('') + '</tbody>' : '';
    $('mlc-ie-n').textContent = 'The stated error is what the system expects from the receivers’ timing and the geometry (one sigma). When it is right, about two thirds of the fixes lie inside it and nearly all inside twice it. A line well below two thirds means the fixes are worse than they say — the clocks or the reference aircraft, usually.' + (IE.length ? '' : ' The counts begin on 21 Nov 2026.');
    // 11. aircraft that send no position of their own: heard by three receivers, and located by us
    chart('np', 'mlc-np', 'line', L, [
      { label: 'heard by three receivers', data: S.map(r => r.a3 ? r.a3[1] : null), borderColor: C.n, stepped: true },
      { label: 'located', data: S.map(r => r.a3 ? r.np : null), borderColor: C.b, stepped: true }], { prec: 0, y: 'aircraft' });
    $('mlc-np-t').textContent = T.a3s && T.a3s[1] ? `Over the period ${pct(T.nps, T.a3s[1])} of the aircraft without a position of their own that three receivers heard were located (counted per ${per}).` : '';
    // 12. the air temperature under the drift (the latest METAR at each step), and how the drift goes with it
    const TT = d.temp || [];
    const ttAt = t => { let v = null; for (const p of TT) { if (p[0] <= t + d.step) v = p; else break; } return v && t + d.step - v[0] <= 5400 ? v[1] : null; };
    const tts = S.map(r => ttAt(r.t));
    chart('cktt', 'mlc-ck-tt', 'line', L, [{ label: '°C', data: tts, borderColor: C.b, stepped: true }], { zero: false });
    const dr = ck(1), prs = dr.map((v, i) => [tts[i], v]).filter(p => p[0] != null && p[1] != null), dv = dr.filter(v => v != null);
    let ckTxt = dv.length ? `Drift in this period: ${Math.round(Math.min(...dv))} to ${Math.round(Math.max(...dv))} ppb (parts in a billion; 1 000 ppb = 1 ppm).` : '';
    if (prs.length >= 8) {
      const mx = prs.reduce((a, p) => a + p[0], 0) / prs.length, my = prs.reduce((a, p) => a + p[1], 0) / prs.length;
      const sxx = prs.reduce((a, p) => a + (p[0] - mx) ** 2, 0), syy = prs.reduce((a, p) => a + (p[1] - my) ** 2, 0), sxy = prs.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0);
      const lo = Math.min(...prs.map(p => p[0])), hi = Math.max(...prs.map(p => p[0]));
      if (hi - lo >= 1.5 && sxx > 0 && syy > 0) ckTxt += ` Against the air temperature (${lo} to ${hi} °C): ${(sxy / sxx).toFixed(1)} ppb per degree, correlation ${(sxy / Math.sqrt(sxx * syy)).toFixed(2)} — a first figure only; the receiver is not at the airport and has its own warmth.`;
      else ckTxt += ' The air temperature moved too little in this period to say how the drift goes with it.';
    }
    $('mlc-ck-t').textContent = ckTxt;
    // 13. tracks confirmed by their motion, and tracks put in doubt again
    chart('trk', 'mlc-trk', 'bar', L, [
      { label: 'confirmed', data: S.map(r => r.rs ? r.rs[0] : 0), backgroundColor: C.a },
      { label: 'put in doubt', data: S.map(r => r.dz == null ? null : r.dz), backgroundColor: C.b }], { prec: 0 });
    // 14. positions that do not fit the time stamps of the GPS-timed receivers
    chart('pc', 'mlc-pc', 'bar', L, [{ label: 'aircraft', data: S.map(r => r.pc ? r.pc[1] : null), backgroundColor: C.b }], { prec: 0 });
    const SA = sus && sus.on ? sus.aircraft || [] : [];
    $('mlc-sus').innerHTML = SA.length ? '<thead><tr><th>Aircraft</th><th>Address</th><th>Reg</th><th class="num" title="The accuracy (NACp) and integrity (NIC) the aircraft reported with the position">NACp / NIC</th><th class="num">Level</th>' +
      '<th class="num" title="From the largest misfit of the time stamps: the position was at least this far from where the aircraft was. The check sees only the part across the line of sight, so the real error is this or more">Off by at least</th>' +
      '<th class="num" title="Distance between the position the aircraft broadcast and our own fix of the same moment, when we had one">Our fix from it</th><th class="num" title="Times the check failed (every five seconds while it does)">Failed</th><th>First</th><th>Last, UTC</th></tr></thead><tbody>' +
      SA.map(a => `<tr><td><b>${esc(a.cs || '—')}</b>${a.typ ? ' <span class="mst-dim">' + esc(a.typ) + '</span>' : ''}</td><td>${esc(a.icao)}</td><td>${esc(a.reg || '—')}</td><td class="num">${a.q ? (a.q[0] == null ? '—' : a.q[0]) + ' / ' + (a.q[1] == null ? '—' : a.q[1]) : '—'}</td>` +
        `<td class="num">${a.alt == null ? '—' : 'FL' + String(Math.round(a.alt / 100)).padStart(3, '0')}</td><td class="num">${a.min_km} km</td><td class="num">${a.km == null ? '—' : a.km + ' km'}</td><td class="num">${a.n}</td><td>${hm(a.t0)}</td><td>${hm(a.t)}</td></tr>`).join('') + '</tbody>'
      : '<tbody><tr><td class="mst-dim">No aircraft in the last hour whose position did not fit.</td></tr></tbody>';
    $('mlc-sus-t').textContent = sus && sus.on ? `Every reply of an aircraft that sends a position and is heard by two GPS-timed receivers is checked, whatever accuracy the aircraft reports: the difference of the two time stamps must fit the position. ` +
      `${sus.checked} aircraft are being checked now. An aircraft is listed when the middle value of its last two minutes is ${(sus.limit_ns / 1000).toFixed(0)} µs or more off (300 m of range difference; positions that are right stay under 0.4 µs). ` +
      'A listed position is wrong, not merely uncertain: frozen, far behind or false. On the map, Misfit positions draws where such an aircraft says it is and where our fix puts it.' : '';
    // 15. which receivers heard a reply together (replies heard by two or more)
    const RX = d.rx || {}, CB = T.cb || {}, cbT = Object.values(CB).reduce((a, v) => a + v, 0);
    const rxn = m => Object.keys(RX).filter(b => m & (1 << +b)).map(b => String(RX[b]).replace(/^MODES-/, '')).join(' + ');
    $('mlc-cb').innerHTML = cbT ? '<thead><tr><th>Heard by</th><th class="num">Replies</th><th class="num">Share</th><th></th></tr></thead><tbody>' +
      Object.entries(CB).sort((a, b) => b[1] - a[1]).map(([m, v]) => `<tr><td>${esc(rxn(+m))}</td><td class="num">${num(v)}</td><td class="num">${pct(v, cbT, 1)}</td><td><span class="mlc-bar" style="width:${Math.max(1, Math.round(90 * v / cbT))}px"></span></td></tr>`).join('') +
      Object.keys(RX).map(b => { const v = Object.entries(CB).filter(([m]) => +m & (1 << +b)).reduce((a, e) => a + e[1], 0); return `<tr class="mst-dim"><td>${esc(String(RX[b]).replace(/^MODES-/, ''))} takes part in</td><td class="num">${num(v)}</td><td class="num">${pct(v, cbT, 1)}</td><td></td></tr>`; }).join('') + '</tbody>'
      : '<tbody><tr><td class="mst-dim">No counts yet: they begin with the version of 21 Nov 2026.</td></tr></tbody>';
    $('mlc-cb-t').textContent = cbT ? 'Only a reply heard by all three can give a position; one heard by two gives a time difference. What each receiver hears alone is not counted here — see the receiver’s own tab above.' : '';
    // 16. one line per day
    const DY = (d.days || []).slice().reverse();
    $('mlc-days').innerHTML = DY.length ? '<thead><tr><th>Day (UTC)</th><th class="num" title="Hours with data">Hours</th><th class="num">Fixes</th><th class="num" title="Of the attempts (tried + lost for want of a clock)">No clock</th><th class="num" title="Of the attempts, made on the clock carried without a reference">Carried</th>' +
      '<th class="num" title="Median distance of the single fixes from the aircraft’s own positions, within 20 NM of the airport">Error ≤ 20 NM</th><th class="num">20–40 NM</th><th class="num" title="Share of the fixes inside their stated error, within 20 NM">Inside stated</th><th class="num">Unresolved</th>' +
      '<th class="num" title="Aircraft located that send no position of their own, summed over the hours (an aircraft counts once in every hour it is located)">Located without a position</th><th class="num" title="Aircraft whose broadcast position did not fit, summed over the hours">Misfits</th></tr></thead><tbody>' +
      DY.map(x => { const a = x.tr + x.nc, d0 = new Date(x.t * 1000), ie = x.ie ? [x.ie[0][0] + x.ie[1][0], x.ie[0][2] + x.ie[1][2]] : null;
        return `<tr><td>${d0.getUTCDate()}.${d0.getUTCMonth() + 1}.</td><td class="num">${x.hours}</td><td class="num">${num(x.fx)}</td><td class="num">${pct(x.nc, a, 1)}</td><td class="num">${pct(x.hd, a, 1)}</td><td class="num">${x.e20 && x.e20[0] ? mTxt(x.e20[1]) : '—'}</td><td class="num">${x.e40 && x.e40[0] ? mTxt(x.e40[1]) : '—'}</td>` +
          `<td class="num">${ie && ie[1] >= 30 ? pct(ie[0], ie[1]) : '—'}</td><td class="num">${pct(x.am, x.fx)}</td><td class="num">${num(x.nph)}<span class="mst-dim"> ah</span></td><td class="num">${x.pc ? num(x.pc[1]) : '—'}</td></tr>`; }).join('') + '</tbody>' : '';
    $('mlc-days-t').textContent = DY.length ? 'The stored hours of the last eight days. “ah” is aircraft-hours: an aircraft located in three different hours counts three times. Columns without a value are from before 21 Nov 2026, or from a day with too few fixes.' : '';
  }

  // Scatter of the single fixes around the aircraft's own position: up = ahead in the flight
  // direction, right = to the right of it; rings every 100 m
  function scatter(pts) {
    const cv = $('mlc-sc'), box = cv.parentElement, dpr = window.devicePixelRatio || 1;
    const W = box.clientWidth - 16, H = box.clientHeight - 8;
    if (W < 50) return;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const g = cv.getContext('2d'), C = COL(), R = 400, cx = W / 2, cy = H / 2, k = Math.min(W, H) / 2 / R * 0.94;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    g.strokeStyle = GRID.replace('.18', '.45'); g.fillStyle = C.txt; g.font = '10px sans-serif'; g.lineWidth = 1;
    for (const r of [100, 200, 300, 400]) { g.beginPath(); g.arc(cx, cy, r * k, 0, 2 * Math.PI); g.stroke(); g.fillText(r + ' m', cx + 3, cy - r * k + 11); }
    g.beginPath(); g.moveTo(cx - R * k, cy); g.lineTo(cx + R * k, cy); g.moveTo(cx, cy - R * k); g.lineTo(cx, cy + R * k); g.stroke();
    g.fillText('ahead', cx + 4, cy - R * k + 22); g.fillText('behind', cx + 4, cy + R * k - 4); g.fillText('right', cx + R * k - 28, cy - 4); g.fillText('left', cx - R * k + 2, cy - 4);
    g.fillStyle = C.a; g.globalAlpha = pts.length > 1500 ? 0.25 : 0.4;
    let inside = 0;
    for (const p of pts) {
      const x = cx + p[1] * k, y = cy - p[0] * k;
      if (Math.hypot(p[0], p[1]) <= R) { inside++; g.fillRect(x - 1, y - 1, 2.2, 2.2); }
    }
    g.globalAlpha = 1;
    const med = v => { const s = v.slice().sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };
    const al = med(pts.map(p => p[0])), ac = med(pts.map(p => p[1])), n = pts.length;
    if (n) { g.strokeStyle = C.b; g.lineWidth = 2; const x = cx + ac * k, y = cy - al * k; g.beginPath(); g.moveTo(x - 6, y); g.lineTo(x + 6, y); g.moveTo(x, y - 6); g.lineTo(x, y + 6); g.stroke(); }
    const w100 = n ? Math.round(100 * pts.filter(p => Math.hypot(p[0], p[1]) <= 100).length / n) : 0;
    $('mlc-sc-t').textContent = n ? `${n.toLocaleString('en')} fixes (a sample), ${Math.round(100 * inside / n)} % inside the 400 m shown, ${w100} % within 100 m. ` +
      `The cross is the median: ${Math.abs(al)} m ${al >= 0 ? 'ahead' : 'behind'}, ${Math.abs(ac)} m to the ${ac >= 0 ? 'right' : 'left'}. ` +
      'A cloud stretched up and down points at timing (the age of the broadcast positions); one stretched or shifted sideways at geometry or antenna positions.'
      : 'No fixes of aircraft with an own position in the last hour.';
  }
})();
