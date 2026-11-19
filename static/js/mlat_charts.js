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
  const COL = () => light() ? { a: '#1d4ed8', b: '#c2410c', n: '#64748b', txt: '#475569' } : { a: '#3b82f6', b: '#ea580c', n: '#94a3b8', txt: '#94a3b8' };
  const GRID = 'rgba(148,163,184,.18)';
  let on = false, rng = lsGet('ms_mlc_rng', '1h'), timer = null, data = null;
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

  async function poll() {
    clearTimeout(timer);
    if (!on) return;
    if (!document.hidden) {
      try {
        const r = await fetch('/api/mlat/fixstats?range=' + rng, { cache: 'no-store' });
        if (!r.ok) throw new Error(r.status);
        data = await r.json();
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
                       title: { display: !!opt.y, text: opt.y, color: C.txt, font: { size: 10 } }, suggestedMax: opt.smax } } } };
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
    chart('ckd', 'mlc-ck-dr', 'line', L, [{ label: 'drift, ppm', data: ck(1).map(v => v == null ? null : +(v / 1000).toFixed(4)), borderColor: C.a }], { zero: false });
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
    $('mlc-cnt').textContent = T.tr ? `In this period: ${T.h3.toLocaleString('en')} replies heard by three receivers, ${T.tr.toLocaleString('en')} tried (at most three per aircraft and second), ` +
      `${T.fx.toLocaleString('en')} fixes (${Math.round(100 * T.fx / T.tr)} %), ${T.fx ? Math.round(100 * T.am / T.fx) : 0} % of them unresolved; no clock line for ${T.nc.toLocaleString('en')} replies.` : '';
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
