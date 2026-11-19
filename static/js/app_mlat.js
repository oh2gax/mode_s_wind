/**
 * app_mlat.js — the phone's MLAT view (/app, from 2026-11-19): the Statistics
 * page's MLAT tab in short, for users with the MLAT right (web/rights.py — the
 * server leaves the tile, the view and this script out for everyone else, and
 * /api/mlat/state answers a plain 404).
 *
 *  - Now: the pair recorder's state — green when it runs and every GPS-timed
 *    receiver is on GPS time, amber otherwise — with each receiver's clock,
 *    GPS state and temperature.
 *  - Tiles: pairs per second, and the median and spread of measured −
 *    expected time difference of the last 10 minutes.
 *  - Clock agreement for 10 min / 1 h / 24 h (pairs, median, spread).
 *  - Charts drawn on canvases: the minute medians of the last 24 h with the
 *    middle 68 % as a band, the histogram of the last 10 minutes, and the
 *    median by direction from the middle of the two sites (twelve 30°
 *    sectors).
 *  - Lists: by reply type, by signal strength, and the aircraft both
 *    receivers heard in the last 5 minutes (with their addresses; an aircraft
 *    without an own ADS-B position is marked).
 *  The newest-pairs table of the web page is left out (too wide for a phone).
 *
 * Data: /api/mlat/state?detail=1 every 10 s while shown.  app.js calls
 * init / show / hide / refresh / layout.
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const hm = ts => { const d = new Date(ts * 1000); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const nf = v => v == null ? '—' : Number(v).toLocaleString('en-US');
  const ns = v => v == null ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(0) + ' ns';
  const sp = v => v == null ? '—' : '±' + Number(v).toFixed(0) + ' ns';
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const DFN = { 0: 'DF0', 4: 'DF4 altitude', 5: 'DF5 squawk', 11: 'DF11 all-call', 16: 'DF16', 17: 'DF17 ADS-B', 18: 'DF18', 20: 'DF20 Comm-B', 21: 'DF21 Comm-B' };
  let on = false, inited = false, data = null, sub = () => {}, busy = false, failed = false;

  function init(o) {
    if (o && o.sub) sub = o.sub;
    inited = true;
  }

  async function load() {
    if (busy) return;
    busy = true;
    try {
      const r = await fetch('/api/mlat/state?detail=1');
      if (!r.ok) throw new Error(r.status);
      data = await r.json(); failed = false;
    } catch (_) { failed = true; }
    busy = false;
    if (on) render();
  }

  function sizeCanvas(cv, H) {
    const W = Math.max(200, cv.parentElement.clientWidth), dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
    return [c, W];
  }
  const pal = () => ({ txt: css('--text-2') || '#9ca3af', grid: css('--border') || '#374151', acc: css('--accent') || '#3b82f6' });
  // a y axis that includes zero, in round steps; returns [min, max, step]
  function axis(lo, hi) {
    lo = Math.min(lo, 0); hi = Math.max(hi, 0);
    const span = Math.max(1, hi - lo), steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
    const st = steps.find(s => span / s <= 5) || 20000;
    return [Math.floor(lo / st) * st, Math.ceil(hi / st) * st, st];
  }
  function frame(c, W, H, L, T, B, mn, mx, st, P, unit) {
    const ph = H - T - B, y = v => T + ph - (v - mn) / (mx - mn || 1) * ph;
    c.font = '10px system-ui, sans-serif'; c.textAlign = 'right'; c.textBaseline = 'middle';
    for (let v = mn; v <= mx + 1e-9; v += st) {
      c.strokeStyle = P.grid; c.globalAlpha = v === 0 ? 1 : 0.55;
      c.beginPath(); c.moveTo(L, Math.round(y(v)) + 0.5); c.lineTo(W - 4, Math.round(y(v)) + 0.5); c.stroke();
      c.globalAlpha = 1; c.fillStyle = P.txt; c.fillText((v > 0 && unit ? '+' : '') + v, L - 4, y(v));
    }
    return y;
  }
  function empty(cv, H, msg) {
    const [c, W] = sizeCanvas(cv, H);
    c.font = '11px system-ui, sans-serif'; c.fillStyle = pal().txt; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(msg, W / 2, H / 2);
  }

  function drawLine() {
    const cv = $('aml-line'), H = 150, p = data && data.on && (data.pairs || [])[0];
    const pts = p ? p.series.filter(m => m[3] != null) : [];
    if (pts.length < 2) { empty(cv, H, 'The line starts after two minutes with positions'); return; }
    const [c, W] = sizeCanvas(cv, H), P = pal(), L = 38, T = 8, B = 18, pw = W - L - 4;
    // the band is clipped to the 5th–95th percentile of its edges so that one wild minute does not flatten the rest
    const los = pts.map(m => m[4]).sort((a, b) => a - b), his = pts.map(m => m[5]).sort((a, b) => a - b);
    const [mn, mx, st] = axis(los[Math.floor(los.length * 0.05)], his[Math.min(his.length - 1, Math.floor(his.length * 0.95))]);
    const y = frame(c, W, H, L, T, B, mn, mx, st, P, true);
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0], x = t => L + (t - t0) / Math.max(60, t1 - t0) * pw;
    const cl = v => Math.max(mn, Math.min(mx, v));
    c.fillStyle = P.acc; c.globalAlpha = 0.18; c.beginPath();
    pts.forEach((m, i) => { const X = x(m[0]), Y = y(cl(m[5])); if (i) c.lineTo(X, Y); else c.moveTo(X, Y); });
    for (let i = pts.length - 1; i >= 0; i--) c.lineTo(x(pts[i][0]), y(cl(pts[i][4])));
    c.closePath(); c.fill(); c.globalAlpha = 1;
    c.strokeStyle = P.acc; c.lineWidth = 1.4; c.beginPath();
    pts.forEach((m, i) => { const X = x(m[0]), Y = y(cl(m[3])); if (i) c.lineTo(X, Y); else c.moveTo(X, Y); });
    c.stroke(); c.lineWidth = 1;
    c.fillStyle = P.txt; c.textBaseline = 'alphabetic'; c.textAlign = 'left'; c.fillText(hm(t0), L, H - 4);
    c.textAlign = 'right'; c.fillText(hm(t1) + ' UTC', W - 4, H - 4);
  }

  function drawHist() {
    const cv = $('aml-hist'), H = 130, x = data && data.detail;
    if (!x || x.n_res < 50) { empty(cv, H, 'Not enough pairs with a position yet'); return; }
    const [c, W] = sizeCanvas(cv, H), P = pal(), L = 38, T = 8, B = 18, pw = W - L - 4, h = x.hist;
    const [mn, mx, st] = axis(0, Math.max(...h));
    const y = frame(c, W, H, L, T, B, mn, mx, st, P, false), bw = pw / h.length;
    c.fillStyle = P.acc;
    h.forEach((v, i) => { const Y = y(v); c.fillRect(L + i * bw + 0.5, Y, Math.max(1, bw - 1), y(0) - Y); });
    c.fillStyle = P.txt; c.textBaseline = 'alphabetic'; c.textAlign = 'center';
    [[1, '−400'], [9, '−200'], [17, '0'], [25, '+200'], [33, '+400 ns']].forEach(([i, t]) => c.fillText(t, Math.min(W - 22, L + i * bw), H - 4));
  }

  function drawSect() {
    const cv = $('aml-sect'), H = 130, x = data && data.detail;
    const v = x ? x.sectors.map(r => r[1]) : [];
    if (!v.some(q => q != null)) { empty(cv, H, 'Not enough pairs with a position yet'); return; }
    const [c, W] = sizeCanvas(cv, H), P = pal(), L = 38, T = 8, B = 18, pw = W - L - 4;
    const ok = v.filter(q => q != null), [mn, mx, st] = axis(Math.min(...ok), Math.max(...ok));
    const y = frame(c, W, H, L, T, B, mn, mx, st, P, true), bw = pw / 12;
    c.fillStyle = P.acc;
    v.forEach((q, i) => { if (q == null) return; const Y = y(q), Z = y(0); c.fillRect(L + i * bw + 2, Math.min(Y, Z), bw - 4, Math.max(1, Math.abs(Z - Y))); });
    c.fillStyle = P.txt; c.textBaseline = 'alphabetic'; c.textAlign = 'center';
    ['N', '', '', 'E', '', '', 'S', '', '', 'W', '', ''].forEach((t, i) => { if (t) c.fillText(t, L + (i + 0.5) * bw, H - 4); });
  }

  function render() {
    const now = $('aml-now');
    if (!data) {
      now.className = 'agn-now'; now.innerHTML = `<i class="agn-dot"></i><span>${failed ? 'No answer from the server' : 'Loading…'}</span>`;
      return;
    }
    if (!data.on) {
      now.className = 'agn-now agn-deg';
      now.innerHTML = `<i class="agn-dot"></i><span>Recorder off<small>${esc(data.why || '')}</small></span>`;
      ['aml-tiles', 'aml-clock', 'aml-df', 'aml-sig', 'aml-ac'].forEach(id => { $(id).innerHTML = ''; });
      sub('MLAT · recorder off');
      drawLine(); drawHist(); drawSect();
      return;
    }
    const rx = data.receivers || [], bad = !!data.err || rx.some(r => r.clock !== 'gps' || (r.gps_red || []).length);
    const rxTxt = r => `${esc(r.id)}: ${r.clock === 'gps' ? 'GPS time' : 'no GPS time'}`
      + ((r.gps_red || []).length ? ' · ' + esc(r.gps_red.join('; ')) : '') + (r.temp != null ? ` · ${Number(r.temp).toFixed(0)} °C` : '');
    now.className = 'agn-now ' + (bad ? 'agn-deg' : 'agn-ok');
    now.innerHTML = `<i class="agn-dot"></i><span>${data.err ? 'Recorder error: ' + esc(data.err) : 'Recorder running'}`
      + `<small>${rx.map(rxTxt).join('<br>')}`
      + (data.counter_receivers || []).map(r => `<br>${esc(r.id)}: own counter${r.clock === 'sync' ? ', lined up' : ', not lined up'} · raw stamps only`).join('')
      + `</small></span>`;
    const x = data.detail || {}, tile = (v, l) => `<div class="am-tile"><b>${v}</b><span>${l}</span></div>`;
    $('aml-tiles').innerHTML = tile(data.rate == null ? '—' : data.rate.toFixed(0) + '<small> /s</small>', 'pairs heard by both')
      + tile(nf(x.aircraft_n), 'aircraft, last 5 min' + (x.no_position_n ? ` <small>(${x.no_position_n} without ADS-B position)</small>` : ''))
      + tile(ns(x.med), 'median, last 10 min') + tile(sp(x.spread), 'spread, last 10 min');
    const p = (data.pairs || [])[0];
    $('aml-clock').innerHTML = p ? '<table><thead><tr><th>Window</th><th class="num">Pairs</th><th class="num">Median</th><th class="num">Spread</th></tr></thead><tbody>'
      + [['10', '10 min'], ['60', '1 h'], ['1440', '24 h']].map(([w, l]) => { const q = p.windows[w] || {};
          return `<tr><td>${l}</td><td class="num">${nf(q.n)}</td><td class="num"><b>${ns(q.med)}</b></td><td class="num">${q.lo == null ? '—' : sp((q.hi - q.lo) / 2)}</td></tr>`; }).join('')
      + '</tbody></table>' : '<div class="agn-none">No pairs yet.</div>';
    $('aml-df').innerHTML = (x.by_df || []).length ? '<table><thead><tr><th>Reply type</th><th class="num">Pairs</th><th class="num">Median</th><th class="num">Spread</th></tr></thead><tbody>'
      + x.by_df.map(r => `<tr><td>${esc(DFN[r[0]] || 'DF' + r[0])}</td><td class="num">${nf(r[1])}</td><td class="num">${ns(r[3])}</td><td class="num">${sp(r[4])}</td></tr>`).join('')
      + '</tbody></table>' : '<div class="agn-none">No pairs yet.</div>';
    $('aml-sig').innerHTML = (x.by_signal || []).length ? '<table><thead><tr><th>Signal (weaker of the two)</th><th class="num">dBFS</th><th class="num">Spread</th></tr></thead><tbody>'
      + x.by_signal.map((r, i) => `<tr><td>${['weakest quarter', 'second quarter', 'third quarter', 'strongest quarter'][r[4] != null ? r[4] : i]}</td><td class="num">${r[0].toFixed(0)}</td><td class="num">${sp(r[3])}</td></tr>`).join('')
      + '</tbody></table>' : '<div class="agn-none">Not enough pairs with a position yet.</div>';
    $('aml-ac').innerHTML = (x.aircraft || []).length ? '<table><thead><tr><th>Address</th><th class="num">Pairs</th><th class="num">Median</th><th class="num">Spread</th><th class="num">Altitude</th></tr></thead><tbody>'
      + x.aircraft.slice(0, 40).map(r => `<tr><td class="agn-cs">${esc(r[0])}${r[8] ? '' : ' <small class="aml-nopos">no ADS-B pos.</small>'}</td><td class="num">${nf(r[1])}</td><td class="num">${ns(r[3])}</td><td class="num">${sp(r[4])}</td><td class="num">${r[7] == null ? '—' : nf(Math.round(r[7] / 100) * 100)}</td></tr>`).join('')
      + '</tbody></table>' : '<div class="agn-none">No aircraft yet.</div>';
    sub(`MLAT · ${hm(data.now)} UTC${failed ? ' · update failed' : ''}`);
    drawLine(); drawHist(); drawSect();
  }

  window.AppMlat = {
    init,
    show() { if (!inited) init(); on = true; render(); load(); },
    hide() { on = false; },
    refresh() { if (on) load(); },
    layout() { if (on && data) { drawLine(); drawHist(); drawSect(); } },
  };
})();
