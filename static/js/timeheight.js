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
 *   vort     relative vorticity of the hour (kinematics_hours: plane fit of
 *            the aircraft winds within 200 km), purple cyclonic / gold
 *            anticyclonic, 10⁻⁵ s⁻¹ — troughs, ridges, jet shear
 *   dval     height of the pressure surfaces: D-value (m) = GNSS height of
 *            the surface − its standard-atmosphere height, median of the
 *            airframes of the hour (collector/gnss_heights.py, calibrated
 *            against the soundings); red higher / blue lower than standard
 *   dchg     change of the D-value over 6 hours (falling ahead of troughs)
 *   thk      thickness temperature check: mean virtual temperature of the
 *            5 000 ft layers from the height gained by climbing / descending
 *            aircraft minus the Mach / TAS temperature of the same layers
 *   moist    moisture indicator (trial, collector/moisture.py): that
 *            difference (Tv − T) for 1 000–5 000, 5 000–10 000 and
 *            10 000–15 000 ft from the flights of ±1–2 h, minus offsets learnt
 *            against the soundings, over the value of saturated air — about
 *            the relative humidity: dry < 40, moist 40–70, humid ≥ 70 %
 * Overlays: wind barbs, the 0 / −10 / −20 °C isotherms, the tropopause (WMO
 * lapse-rate definition, magenta dashed) and the height of the strongest wind
 * (≥ 50 kt, yellow), Jokioinen sonde launches (pink ▼ at the top) and — with
 * "Sonde" — each sounding drawn as its own narrow column in the same colour
 * field (temperature anomaly, wind speed, lapse rate, height, moisture), aircraft per
 * hour (strip below the plot, red where < 8: LOW data).  "PNG" saves the
 * picture.  Hover for values; click a column to open that
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
    tp: lsGet('ms_th_tp', 'false') === 'true',
    vmax: lsGet('ms_th_vmax', 'false') === 'true',
    sondeCol: lsGet('ms_th_sondecol', 'false') === 'true',
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
  // vorticity 10⁻⁵ s⁻¹: purple cyclonic / gold anticyclonic, full at ±15
  const VO = { neg: [202, 138, 4], pos: [147, 51, 234] };
  function vortFill(v) {
    const k = Math.min(1, Math.abs(v) / 15), c = v < 0 ? VO.neg : VO.pos;
    return `rgba(${c[0]},${c[1]},${c[2]},${(0.08 + 0.82 * k).toFixed(3)})`;
  }
  const FULL = { change: 4, anomaly: 6, dval: 300, dchg: 60, thk: 2 };   // colour full at ±
  // moisture index (≈ RH %): dry / moist / humid
  const MOIST = [[-1e9, 40, [180, 116, 52], 'dry'], [40, 70, [132, 170, 90], 'moist'], [70, 1e9, [14, 140, 200], 'humid']];
  const moistClass = v => MOIST.find(b => v >= b[0] && v < b[1]) || MOIST[1];
  const moistFill = v => { const c = moistClass(v)[2]; return `rgb(${c[0]},${c[1]},${c[2]})`; };
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
      const KZ = new Array(nL).fill(null);              // vorticity {v, se, n}
      for (const r of c.kz || []) {
        const i = layers.indexOf(r[0]);
        if (i >= 0 && i < nL && r[1] != null) KZ[i] = { v: r[1], se: r[2], n: r[3] };
      }
      const DV = new Array(nL).fill(null);              // D-value {v m, sd, n airframes}
      for (const r of c.dv || []) {
        const i = layers.indexOf(r[0]);
        if (i >= 0 && i < nL && r[1] != null) DV[i] = { v: r[1], sd: r[2], n: r[3] };
      }
      // thickness temperatures: each layer gets the 5 000 ft layer around its centre
      const TK = new Array(nL).fill(null);
      let bulk = null;
      for (const r of c.tk || []) {
        const o = { lo: r[0], hi: r[1], tv: r[2], sd: r[3], n: r[4], tref: r[5] };
        if (r[1] - r[0] > 5000) { bulk = o; continue; }
        for (let i = 0; i < nL; i++) {
          const zc = (layers[i] + layers[i + 1]) / 2;
          if (zc >= r[0] && zc < r[1]) TK[i] = o;
        }
      }
      // moisture indicator: each layer gets the block (1 000–5 000 / 5 000–10 000 / 10 000–15 000 ft) around its centre
      const MO = new Array(nL).fill(null);
      for (const r of c.mo || []) {
        const o = { lo: r[0], hi: r[1], idx: r[2], se: r[3], n: r[4], corr: r[5], raw: r[6], ser: r[7] };
        for (let i = 0; i < nL; i++) {
          const zc = (layers[i] + layers[i + 1]) / 2;
          if (zc >= r[0] && zc < r[1]) MO[i] = o;
        }
      }
      return { ts: c.ts, a: c.a, n: c.n, partial: !!c.partial, T, TN, WD, WS, WN, AC, KZ, DV, TK, bulk, MO };
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
    const sn = (d.sondes || []).map(s => {
      const T = new Array(nL).fill(null), WD = new Array(nL).fill(null), WS = new Array(nL).fill(null), D = new Array(nL).fill(null);
      for (const r of s.lv || []) {
        const i = layers.indexOf(r[0]);
        if (i < 0 || i >= nL) continue;
        T[i] = r[1]; WD[i] = r[2]; WS[i] = r[3]; D[i] = r[4];
      }
      const MO = new Array(nL).fill(null);
      for (const r of s.mo || []) {
        for (let i = 0; i < nL; i++) {
          const z = (layers[i] + layers[i + 1]) / 2;
          if (z >= r[0] && z < r[1] && r[2] != null) MO[i] = { lo: r[0], hi: r[1], idx: r[2], rh: r[3] };
        }
      }
      return { key: s.key, launch: s.launch, min_p: s.min_p, T, WD, WS, D, MO };
    });
    const P = { layers, nL, cols, mean, byTs, start: d.start_ts, end: d.end_ts, sondes: sn };
    for (const c of cols) { c.tp = tropopause(P, c); c.vm = maxWind(P, c); }
    return P;
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
    if (f === 'vort') {
      const z = c.KZ[i];
      if (!z || z.se > 10) return null;
      return { v: z.v, weak: z.se > 4 || z.n < 10 };
    }
    if (f === 'dval') {
      const z = c.DV[i];
      return z ? { v: z.v, weak: z.n < 3 } : null;
    }
    if (f === 'dchg') {
      const p = P.byTs.get(c.ts - 6 * 3600);
      const a = c.DV[i], b = p && p.DV[i];
      return a && b ? { v: a.v - b.v, weak: a.n < 3 || b.n < 3 } : null;
    }
    if (f === 'thk') {
      const z = c.TK[i];
      return z && z.tref != null ? { v: z.tv - z.tref, weak: z.n < 2 } : null;
    }
    if (f === 'moist') {
      const z = c.MO[i];
      return z && z.idx != null ? { v: z.idx, weak: z.se == null || z.se > ((data && data.moist_faint_pct) || 40) } : null;
    }
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

  // WMO tropopause from the ±1 h smoothed layer temperatures: the lowest
  // layer centre above 5 km (16 400 ft) where the lapse rate to the next
  // layer is ≤ 2 K/km and the mean lapse rate to every layer within the next
  // 2 km stays ≤ 2 K/km (with at least the next layer available) → ft or null
  function tropopause(P, c) {
    for (let i = 0; i < P.nL - 1; i++) {
      const z = zc(P, i);
      if (z < 16400 || c.TS[i] == null || c.TSN[i] < 2) continue;
      if (c.TS[i + 1] == null || c.TSN[i + 1] < 2) continue;
      const lap = (a, b) => -(c.TS[b] - c.TS[a]) / ((zc(P, b) - zc(P, a)) * 0.3048 / 1000);
      if (lap(i, i + 1) > 2) continue;
      let ok = true;
      for (let j = i + 1; j < P.nL && zc(P, j) - z <= 6562; j++) {
        if (c.TS[j] == null) break;
        if (lap(i, j) > 2) { ok = false; break; }
      }
      if (ok) return z;
    }
    return null;
  }
  // strongest wind of the column above 10 000 ft (≥ 2 replies), when ≥ 50 kt → {ft, kt, dir} or null
  function maxWind(P, c) {
    let best = null;
    for (let i = 0; i < P.nL; i++) {
      if (P.layers[i] < 10000 || c.WS[i] == null || c.WN[i] < 2) continue;
      if (!best || c.WS[i] > best.kt) best = { ft: zc(P, i), kt: c.WS[i], dir: c.WD[i], i };
    }
    return best && best.kt >= 50 ? best : null;
  }
  // value of the colour field for a sounding column (sonde layer values), or null
  function sondeValue(P, s, i) {
    const f = st.field;
    if (f === 'anomaly') return s.T[i] != null && P.mean[i] != null ? s.T[i] - P.mean[i] : null;
    if (f === 'wind') return s.WS[i];
    if (f === 'dval') return s.D[i];
    if (f === 'moist') return s.MO[i] ? s.MO[i].idx : null;
    if (f === 'lapse') {
      let a = i - 1, b = i + 1;
      if (a < 0 || s.T[a] == null) a = i;
      if (b >= P.nL || s.T[b] == null) b = i;
      if (a === b || s.T[a] == null || s.T[b] == null) return null;
      return -(s.T[b] - s.T[a]) / ((zc(P, b) - zc(P, a)) * 0.3048 / 1000);
    }
    return null;
  }
  function fillOf(v) {
    if (st.field === 'wind') return spdFill(v);
    if (st.field === 'vvel') return vvFill(v);
    if (st.field === 'vort') return vortFill(v);
    if (st.field === 'lapse') return lapseFill(v);
    if (st.field === 'moist') return moistFill(v);
    return divFill(v, FULL[st.field] || 6);
  }
  const SONDE_FIELDS = ['anomaly', 'wind', 'lapse', 'dval', 'moist'];
  const sondeStrip = (P, s) => {                       // [x0, x1] of a sounding's own column
    const xx = geo.x(s.launch), w = Math.max(6, Math.min(16, geo.cw * 0.7));
    return [xx - w / 2, xx + w / 2];
  };

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
      tp: L ? '#a21caf' : '#e879f9', vmax: L ? '#a16207' : '#fde047',
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
        g.globalAlpha = st.field === 'moist' ? (fv.weak ? 0.35 : 0.8) : fv.weak ? 0.5 : 1;
        g.fillStyle = fillOf(fv.v);
        g.fillRect(x0, y1, cw + 0.5, y0 - y1 + 0.5);
      }
    }
    g.globalAlpha = 1;
    // the soundings as their own narrow columns (same colour field), pink frame
    if (st.sondeCol && SONDE_FIELDS.includes(st.field)) {
      for (const s of P.sondes) {
        if (s.launch < P.start || s.launch > P.end) continue;
        const [sx0, sx1] = sondeStrip(P, s);
        let top = null, bot = null;
        for (let i = 0; i <= topL; i++) {
          const v = sondeValue(P, s, i);
          if (v == null) continue;
          const y0 = y(P.layers[i]), y1 = y(P.layers[i + 1]);
          g.fillStyle = C.bg; g.fillRect(sx0 - 1, y1, sx1 - sx0 + 2, y0 - y1 + 0.5);
          g.fillStyle = fillOf(v); g.fillRect(sx0, y1, sx1 - sx0, y0 - y1 + 0.5);
          top = top == null ? y1 : Math.min(top, y1); bot = bot == null ? y0 : Math.max(bot, y0);
        }
        if (top != null) { g.strokeStyle = C.sonde; g.lineWidth = 1.5; g.strokeRect(sx0 - 0.5, top, sx1 - sx0 + 1, bot - top); }
      }
    }
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
    // tropopause and height of the strongest wind, joined across hours (gaps ≤ 3 h)
    const runLine = (key, col, w, dash, label) => {
      let prev = null, last = null;
      g.strokeStyle = col; g.lineWidth = w; g.setLineDash(dash);
      for (const c of P.cols) {
        const v = c[key];
        if (v == null) continue;
        const pt = [x(c.ts) + cw / 2, y(key === 'vm' ? v.ft : v)];
        if (prev && c.ts - prev.ts <= 3 * 3600) { g.beginPath(); g.moveTo(prev.pt[0], prev.pt[1]); g.lineTo(pt[0], pt[1]); g.stroke(); }
        else { g.beginPath(); g.arc(pt[0], pt[1], w, 0, 2 * Math.PI); g.fillStyle = col; g.fill(); }
        prev = { ts: c.ts, pt }; last = pt;
      }
      g.setLineDash([]);
      if (last) { g.fillStyle = col; g.textAlign = 'left'; g.font = 'bold 10px system-ui';
        g.fillText(label, Math.min(last[0] + 4, ml + pw - 30), last[1] - 4); g.font = '11px system-ui'; }
    };
    if (st.tp) runLine('tp', C.tp, 2.2, [7, 4], 'TP');
    if (st.vmax) runLine('vm', C.vmax, 2.2, [], 'Vmax');
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
    let sonde = null;
    if (st.sondeCol && SONDE_FIELDS.includes(st.field))
      for (const s of P.sondes) { const [a, b] = sondeStrip(P, s); if (mx >= a - 1 && mx <= b + 1) { sonde = s; break; } }
    return { mx, my, ts, c, li, sonde };
  }
  function hover(ev) {
    const tip = $('th-tip');
    const h = locate(ev);
    if (!h) { tip.style.display = 'none'; return; }
    const d = new Date(h.ts * 1000);
    const when = `${d.getUTCDate()}.${d.getUTCMonth() + 1}. ${pad(d.getUTCHours())}–${pad((d.getUTCHours() + 1) % 24)} UTC`;
    let html;
    if (h.sonde && h.li != null) {
      const { P } = geo, s = h.sonde, i = h.li, c = h.c;
      const lt = new Date(s.launch * 1000);
      const parts = [`<b style="color:var(--th-sonde)">Jokioinen sonde ${lt.getUTCDate()}.${lt.getUTCMonth() + 1}. ${pad(lt.getUTCHours())}:${pad(lt.getUTCMinutes())} UTC</b> · ${fmtFt(P.layers[i])}–${fmtFt(P.layers[i + 1])}`];
      const dd = (a, b, u, dg = 1) => a != null && b != null ? ` <span class="mini-tip-dim">(aircraft ${b.toFixed(dg)}${u}, sonde − aircraft ${a - b >= 0 ? '+' : ''}${(a - b).toFixed(dg)}${u})</span>` : '';
      if (s.T[i] != null) parts.push(`T ${s.T[i].toFixed(1)} °C` + dd(s.T[i], c ? c.T[i] : null, ' °C'));
      if (s.WS[i] != null) parts.push(`wind ${Math.round(s.WD[i])}° ${Math.round(s.WS[i])} kt` + (c && c.WS[i] != null ? ` <span class="mini-tip-dim">(aircraft ${Math.round(c.WD[i])}° ${Math.round(c.WS[i])} kt)</span>` : ''));
      if (s.MO[i]) {
        const m = s.MO[i], a = c && c.MO[i];
        parts.push(`moisture ${fmtFt(m.lo)}–${fmtFt(m.hi)}: ${moistClass(m.idx)[3]}, index ${m.idx} % <span class="mini-tip-dim">(mean RH ${m.rh} %` +
          (a && a.idx != null ? `; aircraft ${a.idx} % ±${a.se ?? '–'} — ${moistClass(a.idx)[3]}` : '') + ')</span>');
      }
      if (s.D[i] != null) parts.push(`D ${s.D[i] >= 0 ? '+' : ''}${Math.round(s.D[i])} m` + (c && c.DV[i] ? ` <span class="mini-tip-dim">(aircraft ${c.DV[i].v >= 0 ? '+' : ''}${Math.round(c.DV[i].v)} m, sonde − aircraft ${s.D[i] - c.DV[i].v >= 0 ? '+' : ''}${Math.round(s.D[i] - c.DV[i].v)} m)</span>` : ''));
      if (s.min_p) parts.push(`<span class="mini-tip-dim">sounding to ${Math.round(s.min_p)} hPa · values: mean of the sounding's levels in the layer</span>`);
      html = parts.join('<br>');
    } else if (!h.c) html = `${when}<br><span class="mini-tip-dim">no hourly profile stored</span>`;
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
      const z = c.KZ[i];
      if (z) parts.push(`vorticity ${z.v >= 0 ? '+' : ''}${z.v.toFixed(1)} ×10⁻⁵ s⁻¹ <span class="mini-tip-dim">(${z.v >= 0 ? 'cyclonic' : 'anticyclonic'}, ±${z.se.toFixed(1)}, ${(z.v / (2 * 7.2921 * Math.sin(60.3 * Math.PI / 180))).toFixed(2)} f, ${z.n} aircraft within 200 km)</span>`);
      const dz = c.DV[i];
      if (dz) {
        const p6 = P.byTs.get(c.ts - 6 * 3600), d6 = p6 && p6.DV[i];
        const zc_m = ((lo + hi) / 2) * 0.3048 + dz.v;
        parts.push(`pressure surface at ${Math.round(zc_m).toLocaleString('en').replace(/,/g, ' ')} m <span class="mini-tip-dim">(D ${dz.v >= 0 ? '+' : ''}${Math.round(dz.v)} m` +
          (d6 ? `, 6 h change ${dz.v - d6.v >= 0 ? '+' : ''}${Math.round(dz.v - d6.v)} m` : '') + `, ±${Math.round(dz.sd)} m between ${dz.n} airframes)</span>`);
      }
      const tk = c.TK[i];
      if (tk) parts.push(`thickness temperature ${fmtFt(tk.lo)}–${fmtFt(tk.hi)} ${tk.tv.toFixed(1)} °C` +
        (tk.tref != null ? ` vs Mach/TAS ${tk.tref.toFixed(1)} °C → ${tk.tv - tk.tref >= 0 ? '+' : ''}${(tk.tv - tk.tref).toFixed(1)} K` : '') +
        ` <span class="mini-tip-dim">(${tk.n} climb${tk.n === 1 ? '' : 's'} / descents${tk.sd != null ? `, ±${tk.sd.toFixed(1)} K` : ''})</span>`);
      const mo = c.MO[i];
      if (mo && mo.idx != null) parts.push(`moisture (trial) ${fmtFt(mo.lo)}–${fmtFt(mo.hi)}: <b>${moistClass(mo.idx)[3]}</b>, index ${mo.idx} %` +
        ` <span class="mini-tip-dim">(±${mo.se ?? '–'} %${mo.ser != null ? ` — ±${mo.ser} % from the flights, the rest systematic` : ''}; ${mo.n} climbs / descents of ±${mo.lo < 5000 ? 2 : 1} h; Tv − T ${mo.corr >= 0 ? '+' : ''}${mo.corr.toFixed(2)} K after the sonde offsets, ${mo.raw >= 0 ? '+' : ''}${mo.raw.toFixed(2)} K raw)</span>`);
      if (c.bulk && (st.field === 'thk' || tk)) {
        const b = c.bulk;
        parts.push(`<span class="mini-tip-dim">FL100–FL300: ${b.tv.toFixed(1)} °C` + (b.tref != null ? ` vs ${b.tref.toFixed(1)} °C (${b.tv - b.tref >= 0 ? '+' : ''}${(b.tv - b.tref).toFixed(1)} K)` : '') + `, ${b.n} flight${b.n === 1 ? '' : 's'}</span>`);
      }
      if (c.tp != null || c.vm) parts.push(`<span class="mini-tip-dim">` + [c.tp != null ? `tropopause ≈ ${fmtFt(c.tp)}` : null,
        c.vm ? `strongest wind ${Math.round(c.vm.dir)}° ${Math.round(c.vm.kt)} kt at ${fmtFt(c.vm.ft)}` : null].filter(Boolean).join(' · ') + '</span>');
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
      renderLegend();
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
    $('th-tp').checked = st.tp;
    $('th-vmax').checked = st.vmax;
    $('th-sondecol').checked = st.sondeCol;
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
    } else if (st.field === 'vort') {
      el.innerHTML = 'Relative vorticity (wind plane fit, 200 km) <span class="th-bar th-bar-vo"></span> ' +
        '<span class="th-lt">anticyclonic −15 · 0 · +15 ×10⁻⁵ s⁻¹ cyclonic</span>';
    } else if (st.field === 'dval') {
      el.innerHTML = 'Height of the pressure surfaces vs the standard atmosphere (D-value, GNSS) <span class="th-bar th-bar-dv"></span> ' +
        '<span class="th-lt">lower −300 · 0 · +300 m higher</span>' + calNote();
    } else if (st.field === 'dchg') {
      el.innerHTML = 'Height change over 6 h (GNSS) <span class="th-bar th-bar-dv"></span> ' +
        '<span class="th-lt">falling −60 · 0 · +60 m rising</span>' + calNote();
    } else if (st.field === 'thk') {
      el.innerHTML = 'Thickness temperature − Mach/TAS temperature (5 000 ft layers, climbs / descents) <span class="th-bar"></span> ' +
        '<span class="th-lt">−2 · 0 · +2 K</span>' + calNote();
    } else if (st.field === 'moist') {
      el.innerHTML = 'Moisture (trial, 1 000–15 000 ft): ' + MOIST.map(b => `<span class="th-sw" style="background:${moistFill((b[0] + b[1]) / 2 || (b[0] < 0 ? 0 : 100))}"></span><span class="th-lt">${b[3]}</span>`).join(' ') +
        ` <span class="th-lt">(index ≈ RH: &lt; 40, 40–70, ≥ 70 % — thickness Tv − Mach/TAS T over the saturated value; a tendency, uncertain by ±30–50 %; faint: ± over ${(data && data.moist_faint_pct) || 40} %)</span>` + moistNote();
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

  function moistNote() {
    const m = data && data.mcal;
    if (!m) return '';
    const n = Math.max(...Object.values(m).map(o => o.n || 0), 0);
    return n ? ` <span class="th-lt">(offsets from ${n} sounding${n === 1 ? '' : 's'} — still learning)</span>`
             : ' <span class="th-lt">(no sonde offsets yet)</span>';
  }
  function calNote() {
    const g = data && data.gcal;
    if (!g) return '';
    return g.soundings ? ` <span class="th-lt">(calibrated with ${g.soundings} soundings)</span>`
                       : ' <span class="th-lt">(default calibration — no soundings yet)</span>';
  }

  // save the picture (with a title line and the legend text) as a PNG file
  function savePng() {
    const cv = $('th-canvas');
    if (!cv || !data) return;
    const dpr = window.devicePixelRatio || 1, head = Math.round(26 * dpr);
    const out = document.createElement('canvas');
    out.width = cv.width; out.height = cv.height + head;
    const g = out.getContext('2d');
    const L = light();
    g.fillStyle = L ? '#f8fafc' : '#0f1923'; g.fillRect(0, 0, out.width, out.height);
    g.drawImage(cv, 0, head);
    g.fillStyle = L ? '#0f172a' : '#e2e8f0'; g.font = `${Math.round(12 * dpr)}px system-ui`; g.textBaseline = 'middle';
    const end = new Date(data.end_ts * 1000).toISOString().slice(0, 13).replace('T', ' ');
    const fs = $('th-field'), leg = fs && fs.selectedOptions[0] ? fs.selectedOptions[0].textContent : st.field;
    g.fillText(`MODE-S Wind · Time–height section · ${leg} · ${data.hours} h to ${end} UTC`, 10 * dpr, head / 2);
    out.toBlob(b => {
      if (!b) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = `timeheight_${st.field}_${end.replace(/[- :]/g, '')}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, 'image/png');
  }

  function init(opts = {}) {
    openHour = opts.openHour || null;
    syncControls();
    $('th-hours').addEventListener('change', e => { st.hours = parseInt(e.target.value, 10); lsSet('ms_th_hours', st.hours); load(); });
    $('th-field').addEventListener('change', e => { st.field = e.target.value; lsSet('ms_th_field', st.field); renderLegend(); render(); });
    $('th-barbs').addEventListener('change', e => { st.barbs = e.target.checked; lsSet('ms_th_barbs', st.barbs); render(); });
    $('th-iso').addEventListener('change', e => { st.iso = e.target.checked; lsSet('ms_th_iso', st.iso); render(); });
    $('th-tp').addEventListener('change', e => { st.tp = e.target.checked; lsSet('ms_th_tp', st.tp); render(); });
    $('th-vmax').addEventListener('change', e => { st.vmax = e.target.checked; lsSet('ms_th_vmax', st.vmax); render(); });
    $('th-sondecol').addEventListener('change', e => { st.sondeCol = e.target.checked; lsSet('ms_th_sondecol', st.sondeCol); render(); });
    $('th-png').addEventListener('click', savePng);
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
