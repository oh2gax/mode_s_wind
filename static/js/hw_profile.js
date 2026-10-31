/**
 * hw_profile.js — the fine headwind profile of one landing or departure
 * (from 2026-10-31): the flight's headwind every 100 ft (windshear detection
 * v8 values: both airspeed registers against the ADS-B ground speed) against
 * the median and the middle half of the flights of the previous 45 min in the
 * same direction, the ramps of its windshear report marked along it, the band
 * change and its turbulence (EDR) pieces in a strip on the right.
 * Data: /api/windshear/flight-profile?k=a|d&ts=&icao=.
 * Used by the Windshear page's Approach History (a click on a row opens it in
 * a small window) and the phone's History cards (drawn in the opened card).
 *
 * window.HwProfile = { load(k, ts, icao), draw(canvas, d), fill(root), popup(ev, k, ts, icao) }
 */
(function () {
  const cache = new Map();
  const light = () => document.documentElement.dataset.theme === 'light';
  const pad = n => String(n).padStart(2, '0');
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const LV = { adv: ['ADV', '#3b82f6'], wsa: ['WSA', '#d97706'], mba: ['MBA', '#ef4444'] };

  async function load(k, ts, icao) {
    const key = `${k}|${Math.round(ts)}|${icao}`;
    if (cache.has(key)) return cache.get(key);
    const p = fetch(`/api/windshear/flight-profile?k=${k}&ts=${ts}&icao=${encodeURIComponent(icao)}`)
      .then(r => r.json()).catch(() => ({ error: 'network' }));
    cache.set(key, p);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return p;
  }

  const at = (lo, arr, ft) => {               // value of a 100-ft profile at ft (linear between the bins)
    if (lo == null || !arr || !arr.length) return null;
    const f = (ft - lo) / 100, i = Math.floor(f);
    if (i < 0 || i >= arr.length) return null;
    const a = arr[i], b = i + 1 < arr.length ? arr[i + 1] : null;
    if (a == null) return b != null && f - i > 0.5 ? b : null;
    return b == null ? a : a + (b - a) * (f - i);
  };
  const edrCol = (e, L) => e == null ? 'transparent' : e >= 0.45 ? '#dc2626' : e >= 0.2 ? '#f97316' : e >= 0.1 ? (L ? '#ca8a04' : '#facc15') : (L ? '#cbd5e1' : '#334155');

  function draw(cv, d) {
    const L = light();
    const C = {
      bg: L ? '#ffffff' : '#0f1923', grid: L ? '#e2e8f0' : '#243447', ink: L ? '#0f172a' : '#e2e8f0',
      ink2: L ? '#475569' : '#94a3b8', ref: L ? 'rgba(100,116,139,.22)' : 'rgba(148,163,184,.20)', refl: L ? '#64748b' : '#94a3b8',
      fl: L ? '#0f172a' : '#f8fafc', loss: '#2563eb', gain: '#dc2626',
    };
    const W = cv.clientWidth || 360, H = cv.clientHeight || 260, dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
    g.font = '11px system-ui'; g.textBaseline = 'alphabetic';
    if (!d || d.error || !d.v || !d.v.length) {
      g.fillStyle = C.ink2;
      g.fillText(d && d.error === undefined ? 'No fine headwind profile stored for this flight.' : d && d.error === 'network' ? 'Could not load the profile.' :
                 d ? 'No fine headwind profile stored for this flight.' : 'Loading…', 10, 20);
      return;
    }
    const ml = 52, mr = 20, mt = 22, mb = 30, pw = W - ml - mr, ph = H - mt - mb;
    const fTop = d.lo + 100 * (d.v.length - 1);
    const r = d.ref, rTop = r ? r.lo + 100 * (r.med.length - 1) : 0;
    const top = Math.max(1000, Math.ceil((Math.max(fTop, r ? Math.min(rTop, fTop + 500) : 0) + 100) / 500) * 500);
    const vals = d.v.filter(v => v != null);
    if (r) for (let i = 0; i < r.med.length; i++) { const ft = r.lo + i * 100; if (ft <= top && r.p25[i] != null) vals.push(r.p25[i], r.p75[i]); }
    let x0 = Math.min(0, ...vals) - 3, x1 = Math.max(0, ...vals) + 3;
    const step = x1 - x0 > 40 ? 10 : 5;
    x0 = Math.floor(x0 / step) * step; x1 = Math.ceil(x1 / step) * step;
    const X = v => ml + (v - x0) / (x1 - x0) * pw, Y = ft => mt + ph * (1 - ft / top);
    // grid
    g.strokeStyle = C.grid; g.lineWidth = 1; g.fillStyle = C.ink2; g.textAlign = 'right';
    const ys = top > 3000 ? 1000 : 500;
    for (let ft = 0; ft <= top; ft += ys) { g.beginPath(); g.moveTo(ml, Y(ft)); g.lineTo(ml + pw, Y(ft)); g.stroke(); g.fillText(ft === 0 ? '0' : ft.toLocaleString('en').replace(/,/g, ' '), ml - 4, Y(ft) + 4); }
    g.textAlign = 'center';
    for (let v = x0; v <= x1; v += step) { g.beginPath(); g.moveTo(X(v), mt); g.lineTo(X(v), mt + ph); g.stroke(); g.fillText(String(v), X(v), mt + ph + 13); }
    if (x0 < 0 && x1 > 0) { g.strokeStyle = C.ink2; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(X(0), mt); g.lineTo(X(0), mt + ph); g.stroke(); g.setLineDash([]); }
    g.fillText('headwind kt (− tailwind)', ml + pw / 2, H - 4);
    g.save(); g.translate(9, mt + ph / 2); g.rotate(-Math.PI / 2); g.fillText('ft MSL', 0, 0); g.restore();
    // the reference: the middle half (band) and the median (line)
    if (r) {
      g.beginPath(); let open = false; const back = [];
      for (let i = 0; i < r.med.length; i++) {
        const ft = r.lo + i * 100;
        if (ft > top || r.p25[i] == null) { if (open) { for (const q of back.reverse()) g.lineTo(q[0], q[1]); g.closePath(); open = false; back.length = 0; } continue; }
        if (!open) { g.moveTo(X(r.p25[i]), Y(ft)); open = true; } else g.lineTo(X(r.p25[i]), Y(ft));
        back.push([X(r.p75[i]), Y(ft)]);
      }
      if (open) { for (const q of back.reverse()) g.lineTo(q[0], q[1]); g.closePath(); }
      g.fillStyle = C.ref; g.fill();
      g.strokeStyle = C.refl; g.lineWidth = 1.5; g.setLineDash([5, 3]); g.beginPath(); open = false;
      for (let i = 0; i < r.med.length; i++) {
        const ft = r.lo + i * 100;
        if (ft > top || r.med[i] == null) { open = false; continue; }
        open ? g.lineTo(X(r.med[i]), Y(ft)) : g.moveTo(X(r.med[i]), Y(ft)); open = true;
      }
      g.stroke(); g.setLineDash([]);
    }
    // the turbulence pieces (EDR) as a strip on the right
    for (const s of d.edr || []) {
      if (!s.a || s.e == null) continue;
      const a = Math.min(...s.a), b = Math.max(...s.a);
      g.fillStyle = edrCol(s.e, L); g.fillRect(ml + pw + 6, Y(Math.min(top, b)), 6, Math.max(2, Y(a) - Y(Math.min(top, b))));
    }
    // the flight
    g.strokeStyle = C.fl; g.lineWidth = 1.8; g.beginPath();
    let open = false;
    d.v.forEach((v, i) => { const ft = d.lo + i * 100; if (v == null) { open = false; return; } open ? g.lineTo(X(v), Y(ft)) : g.moveTo(X(v), Y(ft)); open = true; });
    g.stroke();
    g.fillStyle = C.fl;
    d.v.forEach((v, i) => { if (v != null) { g.beginPath(); g.arc(X(v), Y(d.lo + i * 100), 1.6, 0, 2 * Math.PI); g.fill(); } });
    // the ramps of the report, thick along the flight's line
    const notes = [];
    for (const rp of d.ramps || []) {
      if (rp.a1 == null || rp.a2 == null) continue;
      const a = Math.min(rp.a1, rp.a2), b = Math.max(rp.a1, rp.a2), col = rp.kind === 'loss' ? C.loss : C.gain;
      const pts = [];
      for (let ft = a; ft <= b; ft += 20) { const v = at(d.lo, d.v, ft); if (v != null) pts.push([X(v), Y(ft)]); }
      if (pts.length < 2) continue;
      g.strokeStyle = col; g.lineWidth = rp.zone && rp.sc >= 10 ? 5 : 3; g.globalAlpha = rp.zone ? 0.85 : 0.5;
      g.beginPath(); pts.forEach((q, k) => (k ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]))); g.stroke(); g.globalAlpha = 1;
      notes.push({ y: (Y(a) + Y(b)) / 2, col, txt: `${rp.kind} ${Math.abs(rp.dv).toFixed(0)} kt / ${(rp.L / 1000).toFixed(1)} km = ${rp.sc} kt per km` });
    }
    // labels of the ramps at the left edge of the plot, kept apart
    g.font = 'bold 10px system-ui'; g.textAlign = 'left';
    let lastY = -1e9;
    for (const n of notes.sort((p, q) => p.y - q.y)) {
      const yy = Math.max(n.y, lastY + 12);
      g.strokeStyle = C.bg; g.lineWidth = 3; g.strokeText(n.txt, ml + 4, yy + 3);
      g.fillStyle = n.col; g.fillText(n.txt, ml + 4, yy + 3); lastY = yy;
    }
    // the band change of the report
    const bd = d.band;
    if (bd && bd.b != null && bd.b <= top) {
      const v = at(d.lo, d.v, bd.b);
      g.fillStyle = bd.lvl && LV[bd.lvl] ? LV[bd.lvl][1] : C.ink2;
      if (v != null) { g.beginPath(); g.moveTo(X(v), Y(bd.b) - 5); g.lineTo(X(v) + 5, Y(bd.b)); g.lineTo(X(v), Y(bd.b) + 5); g.lineTo(X(v) - 5, Y(bd.b)); g.closePath(); g.fill(); }
    }
    // the title
    const t = new Date(d.t * 1000);
    g.font = 'bold 11px system-ui'; g.textAlign = 'left'; g.fillStyle = C.ink;
    const lv = LV[d.lv];
    const title = `${d.cs || '?'} ${d.ty || ''} · ${d.k === 'a' ? 'landing' : 'departure'}${d.rw ? ' ' + d.rw : ''} · ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())} UTC`;
    g.fillText(title, 6, 14);
    if (lv) { const w = g.measureText(title).width; g.fillStyle = lv[1]; g.fillRect(12 + w, 4, 30, 13); g.fillStyle = '#fff'; g.textAlign = 'center'; g.fillText(lv[0], 27 + w, 14); }
  }

  function legendHtml(d) {
    if (!d || d.error || !d.v || !d.v.length) return '';
    const r = d.ref;
    const parts = [`<b>—</b> this ${d.k === 'a' ? 'landing' : 'departure'} (${d.src === 'v7' ? 'BDS 5,0 TAS − GS' : 'detection v8'}, mean of 100 ft)`,
      r ? `<span class="hwp-ref">▬ ┅</span> middle half and median of ${r.n} flights of the previous 45 min in the same direction` : 'fewer than 3 flights of the previous 45 min in the same direction',
      `<span style="color:#2563eb">▬</span> loss / <span style="color:#dc2626">▬</span> gain ramp of the report${d.k === 'd' ? ' (trial)' : ''}`,
      d.band ? `◆ band ${d.band.b} ft: ${d.band.a > 0 ? '+' : ''}${d.band.a} kt against the flights before` : '',
      (d.edr || []).length ? 'right edge: turbulence (EDR) of each straight piece' : ''];
    if ((d.v7 || []).length) parts.push(`v7 shadow: ${d.v7.map(x => `${x.kind} ${Math.abs(x.dv).toFixed(0)} kt / ${(x.L / 1000).toFixed(1)} km`).join(', ')}`);
    return parts.filter(Boolean).join(' · ');            // numbers and fixed text only
  }

  // the canvases canvas.hwp[data-k][data-ts][data-icao] in root (the phone's opened cards)
  function fill(root) {
    if (!root) return;
    for (const cv of root.querySelectorAll('canvas.hwp:not([data-done])')) {
      cv.dataset.done = '1';
      const { k, ts, icao } = cv.dataset;
      draw(cv, null);
      load(k, +ts, icao).then(d => {
        if (!cv.isConnected) return;
        draw(cv, d);
        const lg = cv.nextElementSibling;
        if (lg && lg.classList.contains('hwp-leg')) lg.innerHTML = legendHtml(d);
      });
    }
  }

  // a small window beside the pointer (the Windshear page's Approach History)
  let pop = null;
  function close() { if (pop) { pop.remove(); pop = null; } }
  function popup(ev, k, ts, icao) {
    close();
    pop = document.createElement('div');
    pop.className = 'hwp-pop';
    pop.innerHTML = '<button type="button" class="hwp-x" title="Close (Esc)">×</button>' +
      '<div class="hwp-h">Headwind profile <span class="hwp-dim">— research</span></div>' +
      '<canvas class="hwp"></canvas><div class="hwp-leg"></div>';
    document.body.appendChild(pop);
    const vw = window.innerWidth, vh = window.innerHeight, w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = Math.max(8, Math.min(vw - w - 8, ev.clientX + 16)) + 'px';
    pop.style.top = Math.max(8, Math.min(vh - h - 8, ev.clientY - h / 2)) + 'px';
    pop.querySelector('.hwp-x').addEventListener('click', close);
    const cv = pop.querySelector('canvas');
    cv.dataset.k = k; cv.dataset.ts = ts; cv.dataset.icao = icao;
    fill(pop);
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  document.addEventListener('mousedown', e => { if (pop && !pop.contains(e.target) && !e.target.closest('[data-hwp]')) close(); });

  window.HwProfile = { load, draw, fill, popup, close };
})();
