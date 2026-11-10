/**
 * hodograph.js — hodograph for the Sounding page (from 2026-11-10).
 *
 * A hodograph shows the wind of every layer as one point: the tip of the wind
 * vector (where the air moves to; east to the right, north up), the points
 * joined from the ground upwards.  What a column of wind barbs hides is plain
 * here: the length of the curve between two heights is the vertical wind
 * shear, a curve turning clockwise with height is a veering wind (warm
 * advection), anticlockwise a backing one (cold), and a low-level jet is a
 * loop that goes out and comes back.
 *
 * A balloon gives one point per level; here each point is the mean wind of
 * all aircraft in the layer (Area · now / Area · hour: within the sounding
 * radius over the period) or of the one flight (Flight).  The faint disc
 * around a point is the uncertainty of that mean — the scatter between the
 * layer's winds divided by √aircraft — so a bend smaller than the discs is
 * noise; points resting on fewer than 3 aircraft are hollow.
 *
 *   levels  the profile's levels {altitude, alt_lo, alt_hi, wind_spd,
 *           wind_dir, wind_sd, wind_count, ac_count}
 *   low     the airport low-level profile's levels (amber, 200-ft steps), or null
 *   prev    [[label, levels], …] earlier hours, drawn faded (newest first)
 *   top     upper limit, ft
 *
 * createHodograph(canvas, tip) → { set(opts), resize(w, h), draw(), hover(ev), leave() }
 */
function createHodograph(canvas, tip) {
  const light = () => document.documentElement.dataset.theme === 'light';
  const fmtFt = ft => ft >= 6000 ? `FL${String(Math.round(ft / 100)).padStart(3, '0')}` : `${Math.round(ft).toLocaleString('en').replace(/,/g, ' ')} ft`;
  let o = { levels: [], low: null, prev: [], top: 46000, flight: false, note: '' };
  let W = 0, H = 0, pts = [], lowPts = [];

  // colour by height: red at the ground through amber, green and cyan to violet at the top
  const STOPS = [[0, [239, 68, 68]], [5000, [245, 158, 11]], [10000, [34, 197, 94]], [20000, [6, 182, 212]], [36000, [139, 92, 246]]];
  function altColor(ft) {
    let i = 0;
    while (i < STOPS.length - 2 && ft > STOPS[i + 1][0]) i++;
    const [a, ca] = STOPS[i], [b, cb] = STOPS[i + 1], f = Math.max(0, Math.min(1, (ft - a) / (b - a)));
    return `rgb(${ca.map((c, k) => Math.round(c + (cb[k] - c) * f)).join(',')})`;
  }
  const uv = (dir, spd) => { const r = dir * Math.PI / 180; return [-spd * Math.sin(r), -spd * Math.cos(r)]; };
  function pointsOf(levels, top, altKey) {
    return (levels || [])
      .filter(l => l.wind_spd != null && l.wind_dir != null && (l[altKey] ?? l.altitude) != null && (l[altKey] ?? l.altitude) <= top)
      .map(l => { const [u, v] = uv(l.wind_dir, l.wind_spd); return { u, v, alt: l[altKey] ?? l.altitude, l }; })
      .sort((a, b) => a.alt - b.alt);
  }

  function set(opts) { o = Object.assign(o, opts); }
  function resize(w, h) {
    if (w === W && h === H) return false;
    W = w; H = h;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    return true;
  }

  function draw() {
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1, g = canvas.getContext('2d'), L = light();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const C = { bg: L ? '#f8fafc' : '#0f1923', ink: L ? '#0f172a' : '#e2e8f0', ink2: L ? '#475569' : '#94a3b8', grid: L ? '#cbd5e1' : '#2a3a4f',
                prev: L ? '#64748b' : '#94a3b8', low: L ? '#b45309' : '#f59e0b' };
    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
    const P = pointsOf(o.levels, o.top, 'altitude');
    const LW = o.low ? pointsOf(o.low, Math.min(o.top, 5000), 'alt_msl') : [];
    pts = []; lowPts = [];
    if (!P.length) {
      g.fillStyle = C.ink2; g.font = '12px system-ui'; g.textAlign = 'center';
      g.fillText(o.levels && o.levels.length ? 'No winds in this height range' : 'No profile', W / 2, H / 2);
      return;
    }
    // the text column on the right when there is room for it
    const side = W >= 470 ? 180 : 0;
    const pw = W - side;
    // the view is fitted to the data and the origin (calm), so that a profile lying in
    // one quadrant — the usual case — fills the panel; the rings stay centred on calm
    let u0 = 0, u1 = 0, v0 = 0, v1 = 0, vmax = 10;
    const all = P.concat(LW);
    for (const [, lv] of o.prev || []) all.push(...pointsOf(lv, o.top, 'altitude'));
    for (const p of all) { u0 = Math.min(u0, p.u); u1 = Math.max(u1, p.u); v0 = Math.min(v0, p.v); v1 = Math.max(v1, p.v); vmax = Math.max(vmax, Math.hypot(p.u, p.v)); }
    const padK = Math.max(6, vmax * 0.12);
    u0 -= padK; u1 += padK; v0 -= padK; v1 += padK;
    const mg = 14, k = Math.min((pw - 2 * mg) / (u1 - u0), (H - 2 * mg) / (v1 - v0));
    const cx = pw / 2 - (u0 + u1) / 2 * k, cy = H / 2 + (v0 + v1) / 2 * k;
    const step = vmax <= 30 ? 5 : vmax <= 60 ? 10 : vmax <= 120 ? 20 : 40;
    const rmax = Math.ceil((vmax + padK) / step) * step;
    const X = u => cx + u * k, Y = v => cy - v * k;
    g.save(); g.beginPath(); g.rect(0, 0, pw, H); g.clip();
    // rings and axes
    g.lineWidth = 1; g.font = '10px system-ui'; g.textAlign = 'left';
    const ang = Math.atan2((v0 + v1) / 2, (u0 + u1) / 2) || -Math.PI / 4;      // ring labels towards the middle of the data, a little aside
    for (let r = step; r <= rmax; r += step) {
      g.strokeStyle = C.grid; g.globalAlpha = r % (step * 2) ? 0.55 : 1; g.beginPath(); g.arc(cx, cy, r * k, 0, 2 * Math.PI); g.stroke(); g.globalAlpha = 1;
      if (r % (step * 2) === 0 || rmax / step <= 4) {
        const a2 = ang + 0.5;
        g.fillStyle = C.ink2; g.fillText(String(r), cx + r * k * Math.cos(a2) + 2, cy - r * k * Math.sin(a2) + 3);
      }
    }
    g.strokeStyle = C.grid; g.beginPath(); g.moveTo(0, cy); g.lineTo(pw, cy); g.moveTo(cx, 0); g.lineTo(cx, H); g.stroke();
    // where the wind blows from, at the end of the axis its vector points along
    g.fillStyle = C.ink2;
    if (cx > 20 && cx < pw - 20) { g.textAlign = 'left'; if (cy > 30) g.fillText('from 180°', cx + 3, 11); if (cy < H - 30) g.fillText('from 360°', cx + 3, H - (side ? 4 : 18)); }
    if (cy > 14 && cy < H - 6) { if (cx < pw - 60) { g.textAlign = 'right'; g.fillText('from 270°', pw - 4, cy - 4); } if (cx > 60) { g.textAlign = 'left'; g.fillText('from 090°', 4, cy - 4); } }
    // calm
    g.fillStyle = C.ink2; g.beginPath(); g.arc(cx, cy, 2, 0, 2 * Math.PI); g.fill();
    // earlier hours, faded
    (o.prev || []).forEach(([, lv], n) => {
      const q = pointsOf(lv, o.top, 'altitude');
      if (q.length < 2) return;
      g.strokeStyle = C.prev; g.globalAlpha = n ? 0.28 : 0.5; g.lineWidth = 1.3; g.setLineDash(n ? [2, 3] : [5, 3]);
      g.beginPath(); q.forEach((p, i) => (i ? g.lineTo(X(p.u), Y(p.v)) : g.moveTo(X(p.u), Y(p.v)))); g.stroke();
    });
    g.setLineDash([]); g.globalAlpha = 1;
    // uncertainty discs
    for (const p of P) {
      const n = p.l.ac_count || p.l.wind_count || 1, sd = p.l.wind_sd;
      if (sd == null || o.flight) continue;
      p.se = sd / Math.sqrt(Math.max(1, n));
      g.globalAlpha = 0.16; g.fillStyle = altColor(p.alt);
      g.beginPath(); g.arc(X(p.u), Y(p.v), Math.max(1.5, p.se * k), 0, 2 * Math.PI); g.fill();
    }
    g.globalAlpha = 1;
    // the curve, coloured by height (a gap of more than two layers is not joined)
    g.lineWidth = 2.4; g.lineCap = 'round';
    for (let i = 1; i < P.length; i++) {
      const a = P[i - 1], b = P[i];
      if (b.alt - a.alt > 4500) continue;
      const grad = g.createLinearGradient(X(a.u), Y(a.v), X(b.u), Y(b.v));
      grad.addColorStop(0, altColor(a.alt)); grad.addColorStop(1, altColor(b.alt));
      g.strokeStyle = grad; g.beginPath(); g.moveTo(X(a.u), Y(a.v)); g.lineTo(X(b.u), Y(b.v)); g.stroke();
    }
    // the airport low-level profile (amber)
    if (LW.length > 1) {
      g.strokeStyle = C.low; g.lineWidth = 1.1; g.globalAlpha = 0.75;
      g.beginPath(); LW.forEach((p, i) => (i ? g.lineTo(X(p.u), Y(p.v)) : g.moveTo(X(p.u), Y(p.v)))); g.stroke();
      for (const p of LW) {
        g.fillStyle = C.low; g.beginPath(); g.arc(X(p.u), Y(p.v), 1.5, 0, 2 * Math.PI); g.fill();
        lowPts.push({ x: X(p.u), y: Y(p.v), p });
      }
      g.globalAlpha = 1;
    }
    // points and height labels
    const labelled = [];
    g.font = 'bold 10px system-ui';
    for (const p of P) {
      const x = X(p.u), y = Y(p.v), n = p.l.ac_count ?? p.l.wind_count ?? 0, thin = !o.flight && n < 3;
      g.beginPath(); g.arc(x, y, 3.3, 0, 2 * Math.PI);
      if (thin) { g.fillStyle = C.bg; g.fill(); g.strokeStyle = altColor(p.alt); g.lineWidth = 1.4; g.stroke(); }
      else { g.fillStyle = altColor(p.alt); g.fill(); g.strokeStyle = C.bg; g.lineWidth = 1; g.stroke(); }
      pts.push({ x, y, p });
    }
    const want = o.top <= 5000 ? [500, 1500, 2500, 3500, 4500] : o.top <= 10000 ? [500, 2500, 4500, 6500, 9500] : [500, 2500, 5500, 9500, 15000, 21000, 31000, 39000];
    for (const w of want) {
      const p = P.reduce((a, b) => (Math.abs(b.alt - w) < Math.abs(a.alt - w) ? b : a));
      if (Math.abs(p.alt - w) > 1100 || labelled.includes(p)) continue;
      const x = X(p.u), y = Y(p.v);
      // the label on the side away from the neighbouring points
      const i = P.indexOf(p), nb = P[i + 1] || P[i - 1] || p, pv = P[i - 1] || P[i + 1] || p;
      let dx = -((nb.v - pv.v)), dy = (nb.u - pv.u);
      const dn = Math.hypot(dx, dy) || 1; dx /= dn; dy /= dn;
      const lx = x + dx * 15, ly = y - dy * 15 + 3;
      if (labelled.some(q => Math.hypot(q.lx - lx, q.ly - ly) < 24)) continue;
      p.lx = lx; p.ly = ly;
      labelled.push(p);
      const txt = p.l.alt_lo === 0 ? 'low' : p.l.alt_lo != null && p.l.alt_lo < 6000 ? `${(p.l.alt_lo / 1000).toFixed(0)}k` : fmtFt(p.l.alt_lo ?? p.alt);
      g.textAlign = 'center'; g.lineWidth = 3; g.strokeStyle = C.bg; g.strokeText(txt, lx, ly);
      g.fillStyle = altColor(p.alt); g.fillText(txt, lx, ly);
    }
    g.restore();
    // total turning and the shear from the lowest to the highest point
    let turnAll = 0;
    for (let i = 1; i < P.length; i++) {
      if (Math.hypot(P[i].u, P[i].v) < 5 || Math.hypot(P[i - 1].u, P[i - 1].v) < 5) continue;
      turnAll += ((P[i].l.wind_dir - P[i - 1].l.wind_dir + 540) % 360) - 180;
    }
    if (!side && P.length > 1) {                          // narrow panel: one line at the bottom instead of the side text
      const a = P[0], b = P[P.length - 1];
      const t = `shear ${a.l.alt_lo === 0 ? 'lowest' : fmtFt(a.l.alt_lo ?? a.alt)} → ${fmtFt(b.l.alt_lo ?? b.alt)}: ${Math.round(Math.hypot(b.u - a.u, b.v - a.v))} kt · ` +
        (Math.abs(turnAll) < 15 ? 'little turning' : turnAll > 0 ? `veering ${Math.round(turnAll)}°` : `backing ${Math.round(-turnAll)}°`) + ' · rings kt';
      g.font = '10px system-ui'; g.textAlign = 'right';
      g.lineWidth = 3; g.strokeStyle = C.bg; g.strokeText(t, W - 6, H - 5); g.fillStyle = C.ink2; g.fillText(t, W - 6, H - 5);
    }
    // the side text: shear between heights, what the colours mean
    if (side) {
      const x0 = pw + 4;
      let y0 = 18;
      g.textAlign = 'left'; g.font = 'bold 11px system-ui'; g.fillStyle = C.ink;
      g.fillText('Wind shear (vector difference)', x0, y0); y0 += 16;
      g.font = '11px system-ui';
      const at = ft => { const c = P.filter(p => Math.abs(p.alt - ft) <= 1100); return c.length ? c.reduce((a, b) => (Math.abs(b.alt - ft) < Math.abs(a.alt - ft) ? b : a)) : null; };
      const base = P[0];
      for (const [ft, lab] of [[2500, '3 000 ft'], [5500, '6 000 ft'], [9500, 'FL100'], [19000, 'FL200'], [31000, 'FL300']]) {
        const p = at(ft);
        if (!p || p === base || ft > o.top) continue;
        const dv = Math.hypot(p.u - base.u, p.v - base.v);
        g.fillStyle = C.ink2; g.fillText(`${base.alt < 1000 ? 'lowest' : fmtFt(base.l.alt_lo ?? base.alt)} → ${lab}`, x0, y0);
        g.fillStyle = C.ink; g.textAlign = 'right'; g.fillText(`${Math.round(dv)} kt`, W - 8, y0); g.textAlign = 'left';
        y0 += 15;
      }
      const turn = turnAll;
      y0 += 4; g.fillStyle = C.ink2;
      g.fillText(Math.abs(turn) < 15 ? 'little turning with height' : turn > 0 ? `veering ${Math.round(turn)}° with height` : `backing ${Math.round(-turn)}° with height`, x0, y0); y0 += 20;
      g.font = 'bold 11px system-ui'; g.fillStyle = C.ink; g.fillText('Height', x0, y0); y0 += 8;
      const bw = side - 16;
      for (let i = 0; i < bw; i++) { g.fillStyle = altColor(Math.min(o.top, 36000) * i / bw); g.fillRect(x0 + i, y0, 1.5, 8); }
      y0 += 20; g.font = '10px system-ui'; g.fillStyle = C.ink2;
      g.fillText('ground', x0, y0); g.textAlign = 'right'; g.fillText(fmtFt(Math.min(o.top, 36000)), x0 + bw, y0); g.textAlign = 'left'; y0 += 18;
      const lines = ['rings: wind speed, kt', 'labels: wind from (°)'];
      if (!o.flight) lines.push('disc: uncertainty of the mean', 'hollow: fewer than 3 aircraft');
      if (LW.length > 1) lines.push('amber: airport, 200-ft steps');
      if ((o.prev || []).length) lines.push('grey: ' + o.prev.map(p => p[0]).join(', '));
      for (const t of lines) { g.fillText(t, x0, y0); y0 += 13; }
    }
  }

  function hover(ev) {
    if (!tip) return;
    const rect = canvas.getBoundingClientRect(), mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    let best = null, bd = 14;
    for (const q of pts.concat(lowPts.map(q => Object.assign({ low: true }, q)))) {
      const d = Math.hypot(q.x - mx, q.y - my);
      if (d < bd) { bd = d; best = q; }
    }
    if (!best) { tip.style.display = 'none'; return; }
    const l = best.p.l;
    const hd = best.low ? `airport ${fmtFt(l.alt_msl)} MSL` : `${fmtFt(l.alt_lo ?? best.p.alt)}${l.alt_hi != null ? '–' + fmtFt(l.alt_hi) : ''}`;
    let html = `<b>${hd}</b><br>wind ${String(Math.round(l.wind_dir)).padStart(3, '0')}° ${l.wind_spd.toFixed(0)} kt`;
    if (!best.low && !o.flight) {
      html += `<br><span class="mini-tip-dim">${l.ac_count != null ? l.ac_count + ' aircraft, ' : ''}${l.wind_count ?? '–'} winds` +
        (l.wind_sd != null ? ` · scatter ${l.wind_sd.toFixed(1)} kt${best.p.se != null ? ` → mean good to about ±${best.p.se.toFixed(1)} kt` : ''}` : '') + '</span>';
    } else if (best.low) {
      html += `<br><span class="mini-tip-dim">${l.wind_count ?? '–'} flights${l.wind_sd != null ? ` · scatter ${l.wind_sd.toFixed(1)} kt` : ''} (landings and departures)</span>`;
    } else html += `<br><span class="mini-tip-dim">${l.wind_count ?? '–'} winds of this flight</span>`;
    tip.innerHTML = html; tip.style.display = '';
    tip.style.left = Math.max(2, Math.min(W - tip.offsetWidth - 4, mx + 12)) + 'px';
    tip.style.top = Math.max(2, Math.min(H - tip.offsetHeight - 4, my + 12)) + 'px';
  }
  function leave() { if (tip) tip.style.display = 'none'; }

  return { set, resize, draw, hover, leave };
}
