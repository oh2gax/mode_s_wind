/**
 * timeheight.js — Time–height cross-section for the Sounding page.
 *
 * One column per UTC hour from the hourly profile archive (/api/sounding/
 * timeheight → profile_hours; the hour in progress live), altitude layers on
 * a square-root altitude axis (low layers stretched; ISA pressure on the right).  Colour field:
 *   anomaly  temperature minus the mean of the same layer over the shown
 *            period — warm and cold air masses, fronts (sloping boundaries),
 *            the daily cycle near the ground, subsidence
 *   change   temperature change over the previous 3 hours (warm / cold
 *            advection as it happens)
 *   wind     wind speed — jets, low-level jets, a jet descending
 *   lapse    lapse rate between adjacent layers — inversions (violet / blue)
 *            to steep / unstable (orange / red)
 *   vvel     vertical motion by the adiabatic method, FL050–FL200: the part
 *            of the local temperature change that advection does not explain
 *            is ascent (cooling) or descent (warming) at the rate (Γd − Γ):
 *              w = (adv − ∂T/∂t) / (Γd − Γ)
 *            adv from the thermal wind between the layers two below and two
 *            above, ∂T/∂t over ±3 h, Γ from the layers next to it, all from
 *            ±1 h smoothed values (cm/s, green rising / orange sinking)
 * Overlays: wind barbs, the 0 / −10 / −20 °C isotherms, Jokioinen sonde
 * launches (pink ▼ at the top), aircraft per hour (strip below the plot,
 * red where < 8: LOW data).  Hover for values; click a column to open that
 * hour on the Skew-T (Area · hour).
 *
 * window.TimeHeight = { init(opts), load(), render(), setOpenHour(fn) }
 */
(function () {
  const $ = id => document.getElementById(id);
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } };
  const pad = n => String(n).padStart(2, '0');
  const light = () => document.documentElement.dataset.theme === 'light';
  const isaP = ft => ft <= 36089 ? 1013.25 * Math.pow(1 - 6.8756e-6 * ft, 5.2559)
                                 : 226.32 * Math.exp(-(ft - 36089) / 20806);
  const fmtFt = ft => ft >= 6000 ? `FL${String(Math.round(ft / 100)).padStart(3, '0')}` : `${(ft).toLocaleString('en').replace(/,/g, ' ')} ft`;
  const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  let data = null, sondes = [], openHour = null, seq = 0;
  const st = {
    hours: parseInt(lsGet('ms_th_hours', '72'), 10) || 72,
    field: lsGet('ms_th_field', 'anomaly'),
    barbs: lsGet('ms_th_barbs', 'true') !== 'false',
    iso: lsGet('ms_th_iso', 'true') !== 'false',
    endDate: '',                       // '' = now, else YYYY-MM-DD (period ends at 24 UTC of it)
  };
  let geo = null;                       // last drawn geometry, for hover / click

  // ── colour scales ───────────────────────────────────────────────────────
  const DIV = { neg: [37, 99, 235], pos: [220, 38, 38] };         // blue / red
  function divFill(v, full) {
    const k = Math.min(1, Math.abs(v) / full);
    const c = v < 0 ? DIV.neg : DIV.pos;
    return `rgba(${c[0]},${c[1]},${c[2]},${(0.08 + 0.82 * k).toFixed(3)})`;
  }
  // wind speed: 10-kt steps (perceptually ordered, readable in both themes)
  const SPD = ['#1e3a5f', '#1d4e89', '#1f6fa8', '#21918c', '#2fa86e', '#6cc24a', '#b5d334',
               '#f2d930', '#f7b32b', '#f28a1e', '#e5592b', '#c7303c', '#9b1d4c', '#6e1458'];
  const spdFill = v => SPD[Math.max(0, Math.min(SPD.length - 1, Math.floor(v / 10)))];
  // lapse rate K/km
  const LAPSE = [[-1e9, -1, '#7c3aed', 'inversion'], [-1, 2, '#2563eb', 'very stable'],
                 [2, 5, '#60a5fa', 'stable'], [5, 7, '#64748b', 'normal'],
                 [7, 9, '#f59e0b', 'steep'], [9, 1e9, '#ef4444', 'dry-unstable']];
  const lapseFill = v => (LAPSE.find(b => v >= b[0] && v < b[1]) || LAPSE[3])[2];
  // vertical motion cm/s: green rising / orange sinking, full at ±3 cm/s
  const VV = { neg: [234, 88, 12], pos: [16, 160, 110] };
  function vvFill(v) {
    const k = Math.min(1, Math.abs(v) / 3), c = v < 0 ? VV.neg : VV.pos;
    return `rgba(${c[0]},${c[1]},${c[2]},${(0.08 + 0.82 * k).toFixed(3)})`;
  }
  const VV_LO = 5000, VV_HI = 20000;          // layers (bottom..top, ft) with a vertical motion
  const F_COR = 2 * 7.2921e-5 * Math.sin(60.3 * Math.PI / 180), R_D = 287.04, GAMMA_D = 9.8;

  // ── data preparation ────────────────────────────────────────────────────
  function prep(d) {
    const layers = d.layers;                     // bottoms + final top
    const nL = layers.length - 1;
    const cols = d.cols.map(c => {
      const T = new Array(nL).fill(null), TN = new Array(nL).fill(0);
      const WD = new Array(nL).fill(null), WS = new Array(nL).fill(null), WN = new Array(nL).fill(0), AC = new Array(nL).fill(0);
      for (const r of c.lv) {
        const i = layers.indexOf(r[0]);
        if (i < 0 || i >= nL) continue;
        T[i] = r[1]; TN[i] = r[2] || 0; WD[i] = r[3]; WS[i] = r[4]; WN[i] = r[5] || 0; AC[i] = r[6] || 0;
      }
      return { ts: c.ts, a: c.a, n: c.n, partial: !!c.partial, T, TN, WD, WS, WN, AC };
    });
    // layer means over the period (cells with ≥ 2 replies), for the anomaly
    const mean = new Array(nL).fill(null);
    for (let i = 0; i < nL; i++) {
      let s = 0, w = 0;
      for (const c of cols) if (c.T[i] != null && c.TN[i] >= 2) { s += c.T[i] * c.TN[i]; w += c.TN[i]; }
      if (w) mean[i] = s / w;
    }
    const byTs = new Map(cols.map(c => [c.ts, c]));
    // temperatures smoothed over ±1 h (weighted by replies) for the lapse rate:
    // single Mach/TAS layer means scatter by about 1 K, which over 1 000 ft
    // layers would be ±3 K/km of noise
    for (const c of cols) {
      c.TS = new Array(nL).fill(null); c.TSN = new Array(nL).fill(0);
      for (let i = 0; i < nL; i++) {
        let s = 0, w = 0;
        for (const dt of [-3600, 0, 3600]) {
          const o = byTs.get(c.ts + dt);
          if (o && o.T[i] != null && o.TN[i] >= 1) { const ww = o.TN[i] * (dt ? 0.5 : 1); s += o.T[i] * ww; w += ww; }
        }
        if (w) { c.TS[i] = s / w; c.TSN[i] = w; }
      }
      // winds smoothed the same way (u, v in m/s; for the thermal-wind advection)
      c.US = new Array(nL).fill(null); c.VS = new Array(nL).fill(null); c.WSN = new Array(nL).fill(0);
      for (let i = 0; i < nL; i++) {
        let su = 0, sv = 0, w = 0;
        for (const dt of [-3600, 0, 3600]) {
          const o = byTs.get(c.ts + dt);
          if (!o || o.WS[i] == null || o.WD[i] == null || o.WN[i] < 1) continue;
          const ww = o.WN[i] * (dt ? 0.5 : 1), r = o.WD[i] * Math.PI / 180, s = o.WS[i] * 0.5144;
          su += -s * Math.sin(r) * ww; sv += -s * Math.cos(r) * ww; w += ww;
        }
        if (w) { c.US[i] = su / w; c.VS[i] = sv / w; c.WSN[i] = w; }
      }
    }
    return { layers, nL, cols, mean, byTs, start: d.start_ts, end: d.end_ts };
  }

  // value of the colour field for column c, layer i (null = none); weak = few replies
  function fieldValue(P, c, i) {
    const f = st.field;
    if (f === 'anomaly') {
      if (c.T[i] == null || P.mean[i] == null) return null;
      return { v: c.T[i] - P.mean[i], weak: c.TN[i] < 3 };
    }
    if (f === 'change') {
      const p = P.byTs.get(c.ts - 3 * 3600);
      if (!p || c.T[i] == null || p.T[i] == null) return null;
      return { v: c.T[i] - p.T[i], weak: c.TN[i] < 3 || p.TN[i] < 3 };
    }
    if (f === 'wind') {
      if (c.WS[i] == null) return null;
      return { v: c.WS[i], weak: c.WN[i] < 3 };
    }
    if (f === 'vvel') return vvelValue(P, c, i);
    return null;
  }
  // vertical motion (cm/s, + rising) at layer i by the adiabatic method:
  // w = (adv − ∂T/∂t) / (Γd − Γ).  ∂T/∂t from the ±1 h smoothed temperature
  // 3 h before and after (up to 2 h less after for the newest hours: those
  // are marked weak, and the newest hour has none); adv = −V·∇T from the
  // thermal wind between the layers two below and two above:
  // −f / (R ln(p1/p2)) · (u1 v2 − v1 u2).  Only FL050–FL200: below, the daily
  // heating cycle dominates; above, Γd − Γ is small and the shear large.
  function vvelValue(P, c, i) {
    if (P.layers[i] < VV_LO || P.layers[i + 1] > VV_HI || i < 2 || i + 2 >= P.nL) return null;
    const before = P.byTs.get(c.ts - 3 * 3600);
    let after = null, ah = 0;
    for (const h of [3, 2, 1]) { const o = P.byTs.get(c.ts + h * 3600); if (o && o.TS[i] != null) { after = o; ah = h; break; } }
    if (!before || !after || before.TS[i] == null || c.TS[i] == null) return null;
    const dTdt = (after.TS[i] - before.TS[i]) / (ah + 3);                       // K/h
    const lv = lapseValue(P, c, i);
    if (!lv || GAMMA_D - lv.v < 1.5) return null;
    const a = i - 2, b = i + 2;
    if (c.US[a] == null || c.US[b] == null) return null;
    const L = Math.log(isaP(zc(P, a)) / isaP(zc(P, b)));
    const adv = -(F_COR / (R_D * L)) * (c.US[a] * c.VS[b] - c.VS[a] * c.US[b]) * 3600;   // K/h
    const w = (adv - dTdt) / (GAMMA_D - lv.v) * 1e5 / 3600;                     // km/h → cm/s
    return { v: w, adv, dTdt, weak: lv.weak || ah < 3 || c.TSN[i] < 3 || c.WSN[a] < 3 || c.WSN[b] < 3, recent: ah < 3 };
  }
  // lapse rate (K/km) at layer i: between the layers below and above it
  // (one-sided at the ends), from the ±1 h smoothed temperatures
  const zc = (P, i) => (P.layers[i] + P.layers[i + 1]) / 2;
  function lapseValue(P, c, i) {
    let a = i - 1, b = i + 1;
    if (a < 0 || c.TS[a] == null) a = i;
    if (b >= P.nL || c.TS[b] == null) b = i;
    if (a === b || c.TS[a] == null || c.TS[b] == null) return null;
    const dz = (zc(P, b) - zc(P, a)) * 0.3048 / 1000;
    return { v: -(c.TS[b] - c.TS[a]) / dz, weak: c.TSN[a] < 3 || c.TSN[b] < 3 };
  }

  // ── drawing ─────────────────────────────────────────────────────────────
  function render() {
    const canvas = $('th-canvas'), box = $('th-box');
    if (!canvas || !box || box.clientWidth === 0) return;
    const W = box.clientWidth, H = box.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const L = light();
    const C = {
      bg: L ? '#f8fafc' : '#0f1923', plot: L ? '#eef2f6' : '#131e2b', grid: L ? '#cbd5e1' : '#243447',
      ink: L ? '#0f172a' : '#e2e8f0', ink2: L ? '#475569' : '#94a3b8', barb: L ? '#0f172a' : '#e2e8f0',
      iso0: L ? '#0369a1' : '#38bdf8', iso: L ? '#0e7490' : '#67e8f9', sonde: L ? '#be185d' : '#f472b6',
      day: L ? '#94a3b8' : '#3b4b5f', now: L ? '#64748b' : '#94a3b8',
    };
    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
    if (!data) { g.fillStyle = C.ink2; g.font = '13px system-ui'; g.fillText('Loading…', 20, 30); return; }
    const P = prep(data);
    const ml = 62, mr = 58, mt = 30, mb = 64, stripH = 22;
    const pw = W - ml - mr, ph = H - mt - mb;
    if (pw < 100 || ph < 100) return;
    // y: log pressure over the layers that have data (always from the ground)
    let topL = 0;
    for (const c of P.cols) for (let i = P.nL - 1; i > topL; i--) if (c.T[i] != null || c.WS[i] != null) { topL = i; break; }
    topL = Math.max(topL, Math.min(P.nL - 1, 20));
    // y: square root of the pressure altitude (+1 500 ft) — the lowest layers
    // (1 000 ft thick: inversions, low-level jets, fronts at the ground) get
    // about a quarter of the height instead of a tenth on a pressure scale
    const sq = ft => Math.sqrt(Math.max(0, ft) + 1500);
    const sBot = sq(0), sTop = sq(P.layers[topL + 1]);
    const y = ft => mt + ph * (sTop - sq(ft)) / (sTop - sBot);
    const nH = Math.round((P.end - P.start) / 3600);
    const cw = pw / nH;
    const x = ts => ml + (ts - P.start) / 3600 * cw;
    geo = { P, ml, mt, pw, ph, cw, y, x, topL, nH };

    g.fillStyle = C.plot; g.fillRect(ml, mt, pw, ph);
    // cells
    for (const c of P.cols) {
      const x0 = x(c.ts), x1 = x0 + cw;
      if (x1 < ml || x0 > ml + pw) continue;
      for (let i = 0; i <= topL; i++) {
        if (st.field === 'lapse') {
          const lv = lapseValue(P, c, i);
          if (!lv) continue;
          const y0 = y(P.layers[i]), y1 = y(P.layers[i + 1]);
          g.globalAlpha = lv.weak ? 0.45 : 0.9;
          g.fillStyle = lapseFill(lv.v);
          g.fillRect(x0, y1, cw + 0.5, y0 - y1 + 0.5);
          continue;
        }
        const fv = fieldValue(P, c, i);
        if (!fv) continue;
        const y0 = y(P.layers[i]), y1 = y(P.layers[i + 1]);
        g.globalAlpha = fv.weak ? 0.5 : 1;
        g.fillStyle = st.field === 'wind' ? spdFill(fv.v) : st.field === 'vvel' ? vvFill(fv.v) : divFill(fv.v, st.field === 'change' ? 4 : 6);
        g.fillRect(x0, y1, cw + 0.5, y0 - y1 + 0.5);
      }
    }
    g.globalAlpha = 1;
    // day separators and time ticks
    const tickH = nH <= 36 ? 3 : nH <= 96 ? 6 : nH <= 200 ? 12 : 24;
    g.font = '11px system-ui'; g.textAlign = 'center';
    for (let t = Math.ceil(P.start / 3600) * 3600; t <= P.end; t += 3600) {
      const d = new Date(t * 1000), h = d.getUTCHours();
      const xx = x(t);
      if (h === 0) {
        g.strokeStyle = C.day; g.lineWidth = 1; g.setLineDash([]);
        g.beginPath(); g.moveTo(xx, mt); g.lineTo(xx, mt + ph); g.stroke();
        g.fillStyle = C.ink; g.textAlign = 'left';
        g.fillText(`${DAY[d.getUTCDay()]} ${d.getUTCDate()}.${d.getUTCMonth() + 1}.`, xx + 3, mt - 8);
        g.textAlign = 'center';
      }
      if (h % tickH === 0) {
        g.strokeStyle = C.ink2; g.beginPath(); g.moveTo(xx, mt + ph); g.lineTo(xx, mt + ph + 4); g.stroke();
        g.fillStyle = C.ink2; g.fillText(pad(h), xx, mt + ph + 15);
      }
    }
    g.fillStyle = C.ink2; g.textAlign = 'right'; g.fillText('UTC', ml - 6, mt + ph + 15);
    // altitude axis (left: altitude, right: pressure)
    const ticks = [0, 1000, 2000, 3000, 5000, 7000, 10000, 14000, 18000, 24000, 30000, 34000, 38000, 42000, 46000]
      .filter(f => f <= P.layers[topL + 1]);
    g.textAlign = 'right';
    for (const f of ticks) {
      const yy = y(f);
      g.strokeStyle = C.grid; g.globalAlpha = 0.35; g.beginPath(); g.moveTo(ml, yy); g.lineTo(ml + pw, yy); g.stroke(); g.globalAlpha = 1;
      g.fillStyle = C.ink2; g.fillText(fmtFt(f), ml - 6, yy + 4);
      g.textAlign = 'left'; g.fillText(`${Math.round(isaP(f))}`, ml + pw + 6, yy + 4); g.textAlign = 'right';
    }
    g.save(); g.translate(ml + pw + 46, mt + ph / 2); g.rotate(Math.PI / 2); g.textAlign = 'center';
    g.fillText('hPa (ISA of the pressure altitude)', 0, 0); g.restore();
    // isotherms 0 / −10 / −20 °C: lowest crossing per column
    if (st.iso) {
      for (const [th, col, w, dash] of [[0, C.iso0, 2.2, []], [-10, C.iso, 1.3, [5, 4]], [-20, C.iso, 1.3, [2, 3]]]) {
        let prev = null, lastPt = null;
        g.strokeStyle = col; g.lineWidth = w; g.setLineDash(dash);
        for (const c of P.cols) {
          let pt = null;
          for (let i = 0; i < topL; i++) {
            const a = c.T[i], b = c.T[i + 1];
            if (a == null || b == null || c.TN[i] < 2 || c.TN[i + 1] < 2) continue;
            if ((a - th) * (b - th) <= 0 && a !== b) {
              const za = (P.layers[i] + P.layers[i + 1]) / 2, zb = (P.layers[i + 1] + P.layers[i + 2]) / 2;
              pt = [x(c.ts) + cw / 2, y(za + (th - a) / (b - a) * (zb - za))];
              break;
            }
          }
          if (pt && prev && c.ts - prev.ts <= 3 * 3600 && Math.abs(pt[1] - prev.pt[1]) < ph * 0.3) {
            g.beginPath(); g.moveTo(prev.pt[0], prev.pt[1]); g.lineTo(pt[0], pt[1]); g.stroke();
          }
          if (pt) { prev = { ts: c.ts, pt }; lastPt = pt; }
        }
        g.setLineDash([]);
        if (lastPt) {
          g.fillStyle = col; g.textAlign = 'left'; g.font = 'bold 10px system-ui';
          g.fillText(`${th}°`, Math.min(lastPt[0] + 4, ml + pw - 22), lastPt[1] - 4);
          g.font = '11px system-ui';
        }
      }
    }
    // wind barbs
    if (st.barbs) {
      const stepC = Math.max(1, Math.ceil(36 / cw));
      let lastY = Infinity;
      const rows = [];
      for (let i = 0; i <= topL; i++) {
        const yc = y((P.layers[i] + P.layers[i + 1]) / 2);
        if (lastY - yc >= 30) { rows.push(i); lastY = yc; }
      }
      // drawn twice: a halo in the opposite colour, then the barb — readable on any cell colour
      for (const [col, lw] of [[L ? 'rgba(248,250,252,0.85)' : 'rgba(15,25,35,0.8)', 2.8], [C.barb, 1.1]]) {
        g.strokeStyle = col; g.fillStyle = col; g.lineWidth = lw;
        for (const c of P.cols) {
          const k = Math.round((c.ts - P.start) / 3600);
          if (k % stepC) continue;
          for (const i of rows) {
            if (c.WS[i] == null || c.WN[i] < 2) continue;
            barb(g, x(c.ts) + cw / 2, y((P.layers[i] + P.layers[i + 1]) / 2), c.WD[i], c.WS[i]);
          }
        }
      }
    }
    // the hour in progress: hatch edge
    const last = P.cols[P.cols.length - 1];
    if (last && last.partial) {
      g.strokeStyle = C.now; g.setLineDash([3, 3]); g.lineWidth = 1;
      g.strokeRect(x(last.ts) + 0.5, mt + 0.5, cw - 1, ph - 1); g.setLineDash([]);
    }
    // frame
    g.strokeStyle = C.grid; g.lineWidth = 1; g.strokeRect(ml + 0.5, mt + 0.5, pw, ph);
    // sonde launches ▼ at the top
    for (const s of sondes) {
      const t = s.launch || s.nominal;
      if (!t || t < P.start || t > P.end) continue;
      const xx = x(t);
      g.fillStyle = C.sonde; g.beginPath(); g.moveTo(xx - 5, mt - 7); g.lineTo(xx + 5, mt - 7); g.lineTo(xx, mt); g.closePath(); g.fill();
    }
    // aircraft per hour strip
    const sy = mt + ph + 24;
    let amax = 1;
    for (const c of P.cols) amax = Math.max(amax, c.a || 0);
    for (const c of P.cols) {
      if (c.a == null) continue;
      const h = Math.max(1, (c.a / amax) * stripH);
      g.fillStyle = c.a < 8 ? '#ef4444' : c.a < 20 ? '#f59e0b' : (L ? '#64748b' : '#64748b');
      g.fillRect(x(c.ts) + 0.5, sy + stripH - h, Math.max(1, cw - 1), h);
    }
    g.fillStyle = C.ink2; g.textAlign = 'right'; g.font = '10px system-ui';
    g.fillText('aircraft', ml - 6, sy + 10); g.fillText(`/h (max ${amax})`, ml - 6, sy + 21);
    geo.strip = [sy, stripH];
  }

  // meteorological wind barb at (cx, cy), staff pointing to where the wind comes from
  function barb(g, cx, cy, dir, spd) {
    const s = Math.round(spd / 5) * 5;
    const r = dir * Math.PI / 180, ux = Math.sin(r), uy = -Math.cos(r);   // towards FROM
    const L = 15, fx = -uy, fy = ux;                                        // feather side
    const tx = cx + ux * L, ty = cy + uy * L;
    g.beginPath(); g.arc(cx, cy, 1.4, 0, 2 * Math.PI); g.fill();
    if (s < 5) return;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(tx, ty); g.stroke();
    let rem = s, pos = 0;
    while (rem >= 50) {
      const ax = tx - ux * pos, ay = ty - uy * pos;
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax + fx * 7 - ux * 2, ay + fy * 7 - uy * 2);
      g.lineTo(ax - ux * 4, ay - uy * 4); g.closePath(); g.fill();
      pos += 5; rem -= 50;
    }
    while (rem >= 10) {
      const ax = tx - ux * pos, ay = ty - uy * pos;
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax + fx * 7 + ux * 2, ay + fy * 7 + uy * 2); g.stroke();
      pos += 3.5; rem -= 10;
    }
    if (rem >= 5) {
      const ax = tx - ux * (pos || 3), ay = ty - uy * (pos || 3);
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax + fx * 3.5 + ux, ay + fy * 3.5 + uy); g.stroke();
    }
  }

  // ── hover / click ───────────────────────────────────────────────────────
  function locate(ev) {
    if (!geo) return null;
    const rect = $('th-canvas').getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    const { P, ml, mt, pw, ph, cw, y, topL } = geo;
    if (mx < ml || mx > ml + pw || my < mt) return null;
    const ts = P.start + Math.floor((mx - ml) / cw) * 3600;
    const c = P.byTs.get(ts);
    if (my > mt + ph) return { mx, my, ts, c, strip: true };
    let li = null;
    for (let i = 0; i <= topL; i++) if (my <= y(P.layers[i]) && my >= y(P.layers[i + 1])) { li = i; break; }
    return { mx, my, ts, c, li };
  }
  function hover(ev) {
    const tip = $('th-tip');
    const h = locate(ev);
    if (!h) { tip.style.display = 'none'; return; }
    const d = new Date(h.ts * 1000);
    const when = `${d.getUTCDate()}.${d.getUTCMonth() + 1}. ${pad(d.getUTCHours())}–${pad((d.getUTCHours() + 1) % 24)} UTC`;
    let html;
    if (!h.c) html = `${when}<br><span class="mini-tip-dim">no hourly profile stored</span>`;
    else if (h.strip || h.li == null) html = `${when}<br>${h.c.a ?? '–'} aircraft · ${h.c.n ?? '–'} replies` +
      (h.c.a != null && h.c.a < 8 ? ' <span style="color:#ef4444">LOW</span>' : '') + (h.c.partial ? '<br><span class="mini-tip-dim">hour in progress</span>' : '');
    else {
      const { P } = geo, c = h.c, i = h.li;
      const lo = P.layers[i], hi = P.layers[i + 1];
      const parts = [`<b>${when}</b> · ${fmtFt(lo)}–${fmtFt(hi)} (${Math.round(isaP(hi))}–${Math.round(isaP(lo))} hPa)`];
      if (c.T[i] != null) {
        const an = P.mean[i] != null ? c.T[i] - P.mean[i] : null;
        const p3 = P.byTs.get(c.ts - 3 * 3600);
        const ch = p3 && p3.T[i] != null ? c.T[i] - p3.T[i] : null;
        parts.push(`T ${c.T[i].toFixed(1)} °C` + (an != null ? ` · anomaly ${an >= 0 ? '+' : ''}${an.toFixed(1)} K` : '') +
                   (ch != null ? ` · 3 h change ${ch >= 0 ? '+' : ''}${ch.toFixed(1)} K` : '') + ` <span class="mini-tip-dim">(${c.TN[i]} replies)</span>`);
      }
      const lv = lapseValue(P, c, i);
      if (lv) parts.push(`lapse rate ${lv.v.toFixed(1)} K/km <span class="mini-tip-dim">(${(LAPSE.find(b => lv.v >= b[0] && lv.v < b[1]) || LAPSE[3])[3]})</span>`);
      const vv = vvelValue(P, c, i);
      if (vv) parts.push(`vertical motion ${vv.v >= 0 ? '+' : ''}${vv.v.toFixed(1)} cm/s <span class="mini-tip-dim">(${vv.v >= 0 ? 'rising' : 'sinking'}; advection ${vv.adv >= 0 ? '+' : ''}${vv.adv.toFixed(2)} K/h, local change ${vv.dTdt >= 0 ? '+' : ''}${vv.dTdt.toFixed(2)} K/h${vv.recent ? '; newest hours: less certain' : ''})</span>`);
      if (c.WS[i] != null) parts.push(`wind ${Math.round(c.WD[i])}° ${Math.round(c.WS[i])} kt <span class="mini-tip-dim">(${c.WN[i]} replies)</span>`);
      parts.push(`<span class="mini-tip-dim">${c.AC[i] || '–'} aircraft in the layer, ${c.a ?? '–'} in the hour${c.partial ? ' · hour in progress' : ' · click: open on the Skew-T'}</span>`);
      html = parts.join('<br>');
    }
    tip.innerHTML = html;
    tip.style.display = '';
    const box = $('th-box');
    const tw = tip.offsetWidth, thh = tip.offsetHeight;
    tip.style.left = Math.min(box.clientWidth - tw - 4, h.mx + 14) + 'px';
    tip.style.top = Math.max(2, Math.min(box.clientHeight - thh - 4, h.my + 14)) + 'px';
  }
  function click(ev) {
    const h = locate(ev);
    if (h && h.c && !h.c.partial && openHour) openHour(h.ts);
  }

  // ── loading ─────────────────────────────────────────────────────────────
  function endTs() {
    if (!st.endDate) return Math.floor(Date.now() / 1000);
    const [Y, M, D] = st.endDate.split('-').map(Number);
    return Date.UTC(Y, M - 1, D + 1) / 1000;
  }
  async function load() {
    const req = ++seq;
    const meta = $('sounding-meta');
    if (meta) meta.textContent = 'Loading…';
    try {
      const [d, s] = await Promise.all([
        fetch(`/api/sounding/timeheight?hours=${st.hours}&end=${endTs()}`).then(r => r.json()),
        sondes.length ? Promise.resolve(null) : fetch('/api/sondes').then(r => r.json()).catch(() => null),
      ]);
      if (req !== seq) return;
      data = d;
      if (s && s.items) sondes = s.items;
      const n = d.cols.length, low = d.cols.filter(c => c.a != null && c.a < 8).length;
      if (meta) meta.textContent = `${n} hourly profiles · ${low} with < 8 aircraft` +
        (d.cols.length && d.cols[d.cols.length - 1].partial ? ' · last column: hour in progress' : '');
      render();
    } catch (e) {
      if (meta) meta.textContent = 'Error loading the time–height section.';
      console.error(e);
    }
  }

  function syncControls() {
    $('th-hours').value = String(st.hours);
    $('th-field').value = st.field;
    $('th-barbs').checked = st.barbs;
    $('th-iso').checked = st.iso;
    $('th-end').value = st.endDate;
    renderLegend();
  }
  function renderLegend() {
    const el = $('th-legend');
    if (!el) return;
    if (st.field === 'wind') {
      el.innerHTML = 'Wind speed ' + SPD.map((c, i) => `<span class="th-sw" style="background:${c}" title="${i * 10}–${i * 10 + 10} kt"></span>`).join('') +
        ' <span class="th-lt">0 · 50 · 100 · 130+ kt</span>';
    } else if (st.field === 'vvel') {
      el.innerHTML = 'Vertical motion (adiabatic, FL050–FL200) <span class="th-bar th-bar-vv"></span> ' +
        '<span class="th-lt">sinking −3 · 0 · +3 cm/s rising</span>';
    } else if (st.field === 'lapse') {
      el.innerHTML = 'Lapse rate ' + LAPSE.map(b => `<span class="th-sw" style="background:${b[2]}"></span><span class="th-lt">${b[3]}</span>`).join(' ') +
        ' <span class="th-lt">(K/km: &lt; −1, −1–2, 2–5, 5–7, 7–9, ≥ 9)</span>';
    } else {
      const full = st.field === 'change' ? 4 : 6;
      el.innerHTML = (st.field === 'change' ? 'Temperature change over 3 h ' : 'Temperature anomaly (layer mean of the period) ') +
        `<span class="th-bar"></span> <span class="th-lt">−${full} · 0 · +${full} K</span>`;
    }
    el.innerHTML += ` <span class="th-lt">· faint: &lt; 3 replies · <span style="color:var(--th-sonde)">▼</span> Jokioinen launch · dashed frame: hour in progress</span>`;
  }

  function init(opts = {}) {
    openHour = opts.openHour || null;
    syncControls();
    $('th-hours').addEventListener('change', e => { st.hours = parseInt(e.target.value, 10); lsSet('ms_th_hours', st.hours); load(); });
    $('th-field').addEventListener('change', e => { st.field = e.target.value; lsSet('ms_th_field', st.field); renderLegend(); render(); });
    $('th-barbs').addEventListener('change', e => { st.barbs = e.target.checked; lsSet('ms_th_barbs', st.barbs); render(); });
    $('th-iso').addEventListener('change', e => { st.iso = e.target.checked; lsSet('ms_th_iso', st.iso); render(); });
    $('th-end').addEventListener('change', e => { st.endDate = e.target.value; load(); });
    $('th-now').addEventListener('click', () => { st.endDate = ''; $('th-end').value = ''; load(); });
    const cv = $('th-canvas');
    cv.addEventListener('mousemove', hover);
    cv.addEventListener('mouseleave', () => { $('th-tip').style.display = 'none'; });
    cv.addEventListener('click', click);
    new ResizeObserver(() => { if ($('th-box').clientWidth) render(); }).observe($('th-box'));
  }

  window.TimeHeight = { init, load, render, renderLegend };
})();
