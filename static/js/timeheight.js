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
 *   blw/blt  boundary layer (from 29 Oct 2026, /api/boundary → bl_hours,
 *            collector/boundary.py): the lowest 5 000 ft on a linear axis
 *            (ft MSL) — the wind speed of the aircraft within 25 km in
 *            250-ft steps (blw) or the temperature against the surface
 *            (METAR) from the landings and departures (blt), the low-level
 *            jet (◆ with its speed, joined hour to hour) and the surface
 *            inversion (red bar along the bottom, red line at its top);
 *            hatched where there were no flights
 *   blh/bld  boundary layer, flight by flight (from 31 Oct 2026,
 *            /api/boundary/flights → the reports' "hp"): each landing and
 *            departure as its own column, held until the next flight (at most
 *            20 min), in 100-ft steps 200–5 000 ft — the headwind along its
 *            runway (blh; windshear detection v8, a value about every 0.5 s)
 *            or its change against the median of the flights of the previous
 *            45 min in the same direction (bld), or its change with height —
 *            the vertical wind shear, kt per 100 ft over ±200 ft (bls); windshear
 *            alerts outlined
 * Overlays: wind barbs, the 0 / −10 / −20 °C isotherms, the tropopause (WMO
 * lapse-rate definition, magenta dashed) and the height of the strongest wind
 * (≥ 50 kt, yellow), Jokioinen sonde launches (pink ▼ at the top) and — with
 * "Sonde" — each sounding drawn as its own narrow column in the same colour
 * field (temperature anomaly, wind speed, lapse rate, height, moisture), aircraft per
 * hour (strip below the plot, red where < 8: LOW data) and — with "Boundary
 * layer" — the low-level jet (◆ kt) and the surface inversion (red, from the
 * ground to its top) on any field.  "PNG" saves the
 * picture.  Hover for values; click a column to open that
 * hour on the Skew-T (Area · hour).
 * Mast (from 2026-11-01, /api/mast/hourly — the Kivenlahti mast, collector/
 * mast.py): "Mast" adds its own strip under the section (hourly barbs at 26,
 * 92, 217 and 327 m, the background the stability of the lowest 300 m:
 * violet inversion, orange super-adiabatic); "Mast in graph" draws its hourly
 * values inside the section too — on the boundary-layer temperature field a
 * narrow column at the right of each hour in the field's colours (temperature
 * − METAR at its 8 levels: the inversions), on the boundary-layer wind field
 * its speeds, and on every field its barbs (amber) at their heights.
 *
 * From 2026-11-10 (/api/sounding/th_extra → web/api/th_extra.py):
 *   wdir     wind direction as a colour (N red, E yellow-green, S cyan, W violet)
 *   turn     turning of the wind with height between the layers two below and
 *            two above: veering (red) = warm advection, backing (blue) = cold,
 *            coloured by the thermal-wind advection in K/h (as in vvel)
 *   cov      data coverage: distinct aircraft behind each cell
 *   mdt/mdw  Mode S − MEPS: temperature difference (K) and vector wind
 *            difference (kt) against the model's area mean at the layer —
 *            where and when the model was off (a comparison only)
 *   turb     boundary layer · turbulence: the EDR pieces of the landings and
 *            departures in 500-ft bands, 0–5 000 ft (median of the hour),
 *            with the pilot reports and SIGMETs as markers
 * Overlays: "Isentropes" (potential temperature every 5 K — fronts and
 * inversions slope along them), "Cloud base" (METAR ceiling and lowest base
 * in the boundary-layer fields), "Forecast" (the MEPS model continues the
 * section to the right of now: meps_fc_hours, a display only) and the strips
 * "Runway" (in use: landings above, departures below), "Weather" (METAR
 * visibility / ceiling class and the present weather) and "GNSS" (share of
 * the aircraft with a degraded position).  "Average day" folds the shown
 * period into the 24 UTC hours of the day (the daily cycle).
 *
 * window.TimeHeight = { init(opts), load(), render(), show({end, hours}) }
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
    bl: lsGet('ms_th_bl', 'false') === 'true',            // boundary-layer overlay (jet, inversion)
    flk: lsGet('ms_th_flk', 'all'),                         // blh / bld: all flights, landings (a) or departures (d)
    mast: lsGet('ms_th_mast', 'false') === 'true',          // the mast strip under the section (from 2026-11-01)
    mastOv: lsGet('ms_th_mastov', 'false') === 'true',      // the mast's values inside the section
    endDate: '',                       // '' = now, else YYYY-MM-DD (period ends at 24 UTC of it)
    // from 2026-11-10
    theta: lsGet('ms_th_theta', 'false') === 'true',        // isentropes
    cld: lsGet('ms_th_cld', 'false') === 'true',            // METAR cloud base in the boundary-layer fields
    fc: lsGet('ms_th_fc', 'false') === 'true',              // MEPS forecast right of now
    avg: lsGet('ms_th_avg', 'false') === 'true',            // average day (24 UTC hours)
    sRwy: lsGet('ms_th_srwy', 'false') === 'true',          // strips: runway in use
    sWx: lsGet('ms_th_swx', 'false') === 'true',            //         METAR weather / visibility
    sGnss: lsGet('ms_th_sgnss', 'false') === 'true',        //         GNSS-degraded share
  };
  let geo = null;                       // last drawn geometry, for hover / click
  // boundary layer (/api/boundary): rows {ts, w: [[ft, kt, dir, n]], t: [[ft, °C, n]], tt, q, llj, inv, partial}
  let blRows = null, blKey = '', blAt = 0;
  // the Kivenlahti mast, hour means (/api/mast/hourly): {ts, tl, t, rh, td, wl, ws (kt), wd, wg}
  let mastRows = null, mastKey = '', mastAt = 0, mastElev = 44;
  const needMast = () => st.mast || st.mastOv;
  const mastFt = m => (m + mastElev) * 3.28084;
  const BL_TOP = 5000;
  const blTop = () => BL_TOP;   // the temperatures reach 5 000 ft too (the climb-outs, from 30 Oct 2026; 3 000 ft before)
  // wind speed of the boundary layer: the colours of the Windshear page's chart (blue … green … yellow … red)
  const BL_SPD = [[0, [30, 58, 138]], [10, [14, 116, 144]], [20, [16, 185, 129]], [30, [234, 179, 8]], [40, [249, 115, 22]], [55, [220, 38, 38]]];
  function blSpd(v) {
    let i = 0; while (i < BL_SPD.length - 2 && v > BL_SPD[i + 1][0]) i++;
    const [a, ca] = BL_SPD[i], [b, cb] = BL_SPD[i + 1], f = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return `rgb(${ca.map((c, k) => Math.round(c + (cb[k] - c) * f)).join(',')})`;
  }
  const isFL = () => st.field === 'blh' || st.field === 'bld' || st.field === 'bls';
  const isBL = () => st.field === 'blw' || st.field === 'blt' || st.field === 'turb' || isFL();
  // the extras (/api/sounding/th_extra, from 2026-11-10): runway, METAR, GNSS, turbulence, reports, MEPS, forecast
  let ex = null, exKey = '', exAt = 0, exMap = null;
  const isAvg = () => st.avg && !isFL();
  const useFc = () => st.fc && !st.endDate && !isBL() && !isAvg();
  const needEx = () => ['turb', 'mdt', 'mdw'].includes(st.field) || st.sRwy || st.sWx || st.sGnss || st.cld || st.fc;
  function exMaps() {
    if (exMap) return exMap;
    const m = { meps: new Map(), turb: new Map(), rwy: new Map(), gnss: new Map() };
    for (const [ts, lv] of (ex && ex.meps) || []) m.meps.set(ts, new Map(lv.map(r => [r[0], r])));
    for (const [ts, cells] of (ex && ex.turb && ex.turb.hours) || []) m.turb.set(ts, cells);
    for (const r of (ex && ex.rwy) || []) m.rwy.set(r[0], r);
    for (const r of (ex && ex.gnss) || []) m.gnss.set(r[0], r);
    return (exMap = m);
  }
  const needBl = () => isBL() || st.bl;
  // the flights' fine headwind profiles (/api/boundary/flights): [{t, k, cs, ty, rw, h, lo, v, lv, wa, src}]
  let flRows = null, flKey = '', flAt = 0;
  const FL_HOLD = 20 * 60, FL_REF = 45 * 60, FL_BIN = 100, FL_DIR = 30;
  // headwind: the boundary-layer wind colours, tailwind violet
  const hwFill = v => v >= 0 ? blSpd(v) : `rgba(168,85,247,${(0.35 + 0.6 * Math.min(1, -v / 10)).toFixed(2)})`;
  const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

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
  const FULL = { change: 4, anomaly: 6, dval: 300, dchg: 60, thk: 2, turn: 1, mdt: 3 };   // colour full at ±
  // wind direction: a colour wheel (N red, E yellow-green, S cyan, W violet)
  const dirFill = d => `hsl(${Math.round(((d % 360) + 360) % 360)},68%,${light() ? 46 : 52}%)`;
  // data coverage: distinct aircraft behind a cell
  const COV = [[1, '#9a3412', '1–2'], [3, '#155e75', '3–5'], [6, '#0e7490', '6–10'], [11, '#0891b2', '11–20'], [21, '#22d3ee', '> 20']];
  const covFill = n => { let c = COV[0][1]; for (const b of COV) if (n >= b[0]) c = b[1]; return c; };
  // turbulence (EDR, m^⅔ s⁻¹): the ICAO grades of the peak value, here on the pieces' median — research
  const TURB = [[0, '#1e3a5f', 'smooth'], [0.05, '#2fa86e', 'slight'], [0.10, '#f2d930', 'light'], [0.20, '#f28a1e', 'moderate'], [0.45, '#c7303c', 'severe']];
  const turbClass = v => { let c = TURB[0]; for (const b of TURB) if (v >= b[0]) c = b; return c; };
  // potential temperature (K) of T °C at a pressure altitude
  const thetaOf = (t, ft) => (t + 273.15) * Math.pow(1000 / isaP(ft), 0.2857);
  const TH_STEP = 5;
  // moisture index (≈ RH %): dry / moist / humid
  const MOIST = [[-1e9, 40, [180, 116, 52], 'dry'], [40, 70, [132, 170, 90], 'moist'], [70, 1e9, [14, 140, 200], 'humid']];
  const moistClass = v => MOIST.find(b => v >= b[0] && v < b[1]) || MOIST[1];
  const moistFill = v => { const c = moistClass(v)[2]; return `rgb(${c[0]},${c[1]},${c[2]})`; };
  const VV_LO = 5000, VV_HI = 20000;          // layers (bottom..top, ft) with a vertical motion
  const F_COR = 2 * 7.2921e-5 * Math.sin(60.3 * Math.PI / 180), R_D = 287.04, GAMMA_D = 9.8;

  // ── data preparation ────────────────────────────────────────────────────
  function blankCol(ts, nL) {
    const nul = () => new Array(nL).fill(null), zero = () => new Array(nL).fill(0);
    return { ts, a: null, n: null, partial: false, T: nul(), TN: zero(), WD: nul(), WS: nul(), WN: zero(), AC: zero(),
             KZ: nul(), DV: nul(), TK: nul(), bulk: null, MO: nul() };
  }
  // the average day (from 2026-11-10): the completed hours of the period folded
  // into the 24 UTC hours of the day — temperatures and wind speeds weighted by
  // the replies, the wind direction from the mean vector
  function foldDay(cols, nL, endTs) {
    const base = Math.floor(endTs / 86400) * 86400 - 86400;
    const full = cols.filter(c => !c.partial);
    const days = new Set(full.map(c => Math.floor(c.ts / 86400))).size;
    const out = [];
    for (let h = 0; h < 24; h++) {
      const grp = full.filter(c => Math.round(c.ts / 3600) % 24 === h);
      if (!grp.length) continue;
      const o = blankCol(base + h * 3600, nL);
      o.avgN = grp.length;
      let sa = 0, na = 0, sn = 0;
      for (const c of grp) { if (c.a != null) { sa += c.a; na++; } sn += c.n || 0; }
      o.a = na ? Math.round(sa / na) : null; o.n = Math.round(sn / grp.length);
      const md = grp.some(c => c.MD);
      if (md) o.MD = new Array(nL).fill(null);
      for (let i = 0; i < nL; i++) {
        let sT = 0, wT = 0, su = 0, sv = 0, ss = 0, wW = 0, sac = 0, kz = 0, kn = 0, ks = 0, ka = 0, dv = 0, dn = 0, dsd = 0, da = 0;
        let mt = 0, mtn = 0, mv = 0, mvn = 0, mds = 0;
        for (const c of grp) {
          if (c.T[i] != null && c.TN[i] >= 1) { sT += c.T[i] * c.TN[i]; wT += c.TN[i]; }
          if (c.WS[i] != null && c.WD[i] != null && c.WN[i] >= 1) {
            const r = c.WD[i] * Math.PI / 180;
            su += -c.WS[i] * Math.sin(r) * c.WN[i]; sv += -c.WS[i] * Math.cos(r) * c.WN[i]; ss += c.WS[i] * c.WN[i]; wW += c.WN[i];
          }
          sac += c.AC[i] || 0;
          if (c.KZ[i] && c.KZ[i].se <= 10) { kz += c.KZ[i].v; ks += c.KZ[i].se; ka += c.KZ[i].n; kn++; }
          if (c.DV[i]) { dv += c.DV[i].v; dsd += c.DV[i].sd || 0; da += c.DV[i].n; dn++; }
          const m = c.MD && c.MD[i];
          if (m && m.dt != null) { mt += m.dt; mtn++; }
          if (m && m.dv != null) { mv += m.dv; mds += m.ds; mvn++; }
        }
        if (wT) { o.T[i] = sT / wT; o.TN[i] = wT; }
        if (wW) { o.WS[i] = ss / wW; o.WD[i] = (Math.atan2(-su, -sv) * 180 / Math.PI + 360) % 360; o.WN[i] = wW; }
        o.AC[i] = Math.round(sac / grp.length);
        if (kn) o.KZ[i] = { v: kz / kn, se: ks / kn / Math.sqrt(kn), n: Math.round(ka / kn) };
        if (dn) o.DV[i] = { v: dv / dn, sd: dsd / dn, n: Math.round(da / dn) };
        if (md && (mtn || mvn)) o.MD[i] = { dt: mtn ? mt / mtn : null, dv: mvn ? mv / mvn : null, ds: mvn ? mds / mvn : null, n: Math.max(mtn, mvn) };
      }
      out.push(o);
    }
    return { cols: out, base, days, hours: full.length };
  }
  // the boundary-layer hours (bl_hours rows) folded the same way: winds per
  // 250-ft bin, temperatures against the surface per band; how often a
  // low-level jet / a surface inversion was found goes to "avg"
  function foldBl(rows, base) {
    const out = [];
    for (let h = 0; h < 24; h++) {
      const grp = rows.filter(r => !r.partial && Math.round(r.ts / 3600) % 24 === h);
      if (!grp.length) continue;
      const W = new Map(), T = new Map();
      for (const r of grp) {
        for (const [ft, kt, dir, n] of r.w || []) {
          const o = W.get(ft) || W.set(ft, [0, 0, 0, 0, 0]).get(ft), a = dir * Math.PI / 180;
          o[0] += -kt * Math.sin(a) * n; o[1] += -kt * Math.cos(a) * n; o[2] += kt * n; o[3] += n; o[4]++;
        }
        if (r.tt != null) for (const [ft, tc, n] of r.t || []) {
          const o = T.get(ft) || T.set(ft, [0, 0, 0]).get(ft);
          o[0] += (tc - r.tt) * n; o[1] += n; o[2]++;
        }
      }
      out.push({
        ts: base + h * 3600, tt: 0, q: null, llj: null, inv: null,
        w: [...W].sort((a, b) => a[0] - b[0]).map(([ft, o]) => [ft, Math.round(o[2] / o[3]), Math.round((Math.atan2(-o[0], -o[1]) * 180 / Math.PI + 360) % 360), o[3]]),
        t: [...T].sort((a, b) => a[0] - b[0]).map(([ft, o]) => [ft, o[0] / o[1], o[1]]),
        avg: { n: grp.length, llj: grp.filter(r => r.llj).length, inv: grp.filter(r => r.inv).length,
               dT: grp.filter(r => r.inv).reduce((a, r) => a + r.inv.dT, 0) / Math.max(1, grp.filter(r => r.inv).length),
               kt: grp.filter(r => r.llj).reduce((a, r) => a + r.llj.kt, 0) / Math.max(1, grp.filter(r => r.llj).length) },
      });
    }
    return out;
  }
  function prep(d) {
    const layers = d.layers;                     // bottoms + final top
    const nL = layers.length - 1;
    let cols = d.cols.map(c => {
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
    // Mode S − MEPS at each layer (from 2026-11-10): {t model, dt K, wd / ws model, dv vector kt, ds speed kt}
    if (ex && ex.meps && (st.field === 'mdt' || st.field === 'mdw')) {
      const M = exMaps().meps;
      for (const c of cols) {
        const lv = M.get(c.ts);
        if (!lv) continue;
        c.MD = new Array(nL).fill(null);
        for (let i = 0; i < nL; i++) {
          const r = lv.get(layers[i]);
          if (!r) continue;
          const o = { t: r[1], dt: null, dv: null, n: 1 };
          if (r[1] != null && c.T[i] != null && c.TN[i] >= 3) o.dt = c.T[i] - r[1];
          if (r[2] != null && r[3] != null) {
            o.ws = Math.hypot(r[2], r[3]); o.wd = (Math.atan2(-r[2], -r[3]) * 180 / Math.PI + 360) % 360;
            if (c.WS[i] != null && c.WD[i] != null && c.WN[i] >= 3) {
              const a = c.WD[i] * Math.PI / 180;
              o.dv = Math.hypot(-c.WS[i] * Math.sin(a) - r[2], -c.WS[i] * Math.cos(a) - r[3]); o.ds = c.WS[i] - o.ws;
            }
          }
          if (o.dt != null || o.dv != null) c.MD[i] = o;
        }
      }
    }
    // layer means over the period (cells with ≥ 2 replies), for the anomaly
    const mean = new Array(nL).fill(null);
    for (let i = 0; i < nL; i++) {
      let s = 0, w = 0;
      for (const c of cols) if (c.T[i] != null && c.TN[i] >= 2) { s += c.T[i] * c.TN[i]; w += c.TN[i]; }
      if (w) mean[i] = s / w;
    }
    // from 2026-11-10: the average day (the columns folded into the 24 UTC hours)
    // or the MEPS forecast appended after the newest hour
    let avg = null, fcStart = null, start = d.start_ts, end = d.end_ts, obs = cols;
    if (isAvg()) {
      avg = foldDay(cols, nL, d.end_ts);
      obs = cols = avg.cols; start = avg.base; end = avg.base + 86400;
    } else if (useFc() && ex && ex.fc && (ex.fc.cols || []).length && cols.length) {
      const last = cols[cols.length - 1].ts, horizon = Math.min(48, Math.max(12, Math.round(st.hours / 3)));
      const fcc = [];
      for (const [ts, lead, lv] of ex.fc.cols) {
        if (ts <= last || ts > last + horizon * 3600) continue;
        const o = blankCol(ts, nL); o.fc = true; o.lead = lead;
        for (const r of lv) {
          const i = layers.indexOf(r[0]);
          if (i < 0 || i >= nL) continue;
          if (r[1] != null) { o.T[i] = r[1]; o.TN[i] = 9; }
          if (r[2] != null && r[3] != null) {
            o.WS[i] = Math.hypot(r[2], r[3]); o.WD[i] = (Math.atan2(-r[2], -r[3]) * 180 / Math.PI + 360) % 360; o.WN[i] = 9;
          }
        }
        fcc.push(o);
      }
      if (fcc.length) { fcStart = fcc[0].ts; cols = cols.concat(fcc); end = Math.max(end, fcc[fcc.length - 1].ts + 3600); }
    }
    const byTs = new Map(cols.map(c => [c.ts, c]));
    if (avg) for (const c of cols) { byTs.set(c.ts - 86400, c); byTs.set(c.ts + 86400, c); }   // the day wraps around
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
    const P = { layers, nL, cols, mean, byTs, start, end, sondes: avg ? [] : sn, avg, fcStart };
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
    if (f === 'wdir') {
      if (c.WD[i] == null || c.WS[i] == null) return null;
      return { v: c.WD[i], weak: c.WN[i] < 3 || c.WS[i] < 3 };
    }
    if (f === 'turn') return turnValue(P, c, i);
    if (f === 'cov') return c.fc || !c.AC[i] ? null : { v: c.AC[i], weak: false };
    if (f === 'mdt') { const m = c.MD && c.MD[i]; return m && m.dt != null ? { v: m.dt, weak: false } : null; }
    if (f === 'mdw') { const m = c.MD && c.MD[i]; return m && m.dv != null ? { v: m.dv, weak: false } : null; }
    return null;
  }
  // turning of the wind with height at layer i (from 2026-11-10): between the
  // layers two below and two above, from the ±1 h smoothed winds.  turn ° (+ veering),
  // per 1 000 ft, and the thermal-wind advection in K/h (the colour):
  // −f / (R ln(p1/p2)) · (u1 v2 − v1 u2), veering = warm.  Geostrophic balance
  // is assumed, so the lowest 3 000 ft (friction) are marked weak.
  function turnValue(P, c, i) {
    // two layers below and above (as the vertical motion): one layer apart the
    // differences of the hourly layer winds are mostly noise; at the bottom and the top what there is
    const a = Math.max(0, i - 2), b = Math.min(P.nL - 1, i + 2);
    if (b - a < 2 || c.US[a] == null || c.US[b] == null) return null;
    if (Math.hypot(c.US[a], c.VS[a]) < 2.5 || Math.hypot(c.US[b], c.VS[b]) < 2.5) return null;   // < 5 kt: no direction
    let turn = (Math.atan2(-c.US[b], -c.VS[b]) - Math.atan2(-c.US[a], -c.VS[a])) * 180 / Math.PI;
    turn = ((turn + 540) % 360) - 180;
    const L = Math.log(isaP(zc(P, a)) / isaP(zc(P, b)));
    const adv = -(F_COR / (R_D * L)) * (c.US[a] * c.VS[b] - c.VS[a] * c.US[b]) * 3600;
    return { v: adv, turn, per: turn / ((zc(P, b) - zc(P, a)) / 1000),
             weak: c.WSN[a] < 3 || c.WSN[b] < 3 || P.layers[i] < 3000 };
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
    if (st.field === 'wdir') return dirFill(v);
    if (st.field === 'cov') return covFill(v);
    if (st.field === 'mdw') return blSpd(v * 2.5);
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
      theta: L ? '#9a3412' : '#fdba74', fc: L ? '#334155' : '#cbd5e1',
    };
    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
    if (!data) { g.fillStyle = C.ink2; g.font = '13px system-ui'; g.fillText('Loading…', 20, 30); return; }
    const P = prep(data);
    const BLF = isBL();
    const MAST_H = 62;
    const SH = 24, SGAP = 8;                    // the extra strips (from 2026-11-10)
    const strips = P.avg ? [] : [['rwy', st.sRwy], ['wx', st.sWx], ['gnss', st.sGnss]].filter(s => s[1]).map(s => s[0]);
    const ml = 62, mr = 58, mt = 30, mb = 64 + (st.mast && !P.avg ? MAST_H + 16 : 0) + strips.length * (SH + SGAP), stripH = 22;
    const pw = W - ml - mr, ph = H - mt - mb;
    if (pw < 100 || ph < 100) return;
    let topL = 0, y;
    if (BLF) {
      // boundary layer: 0–5 000 ft MSL on a linear axis
      const top = blTop();
      y = ft => mt + ph * (1 - Math.max(0, Math.min(top, ft)) / top);
    } else {
      // y over the layers that have data (always from the ground)
      for (const c of P.cols) for (let i = P.nL - 1; i > topL; i--) if (c.T[i] != null || c.WS[i] != null) { topL = i; break; }
      topL = Math.max(topL, Math.min(P.nL - 1, 20));
      // y: square root of the pressure altitude (+1 500 ft) — the lowest layers
      // (1 000 ft thick: inversions, low-level jets, fronts at the ground) get
      // about a quarter of the height instead of a tenth on a pressure scale
      const sq = ft => Math.sqrt(Math.max(0, ft) + 1500);
      const sBot = sq(0), sTop = sq(P.layers[topL + 1]);
      y = ft => mt + ph * (sTop - sq(ft)) / (sTop - sBot);
    }
    const nH = Math.round((P.end - P.start) / 3600);
    const cw = pw / nH;
    const x = ts => ml + (ts - P.start) / 3600 * cw;
    geo = { P, ml, mt, pw, ph, cw, y, x, topL, nH, bl: BLF };

    g.fillStyle = C.plot; g.fillRect(ml, mt, pw, ph);
    // cells
    if (BLF && isFL()) drawFlCells(g, C, L, P);
    else if (BLF && st.field === 'turb') drawTurbCells(g, C, L, P);
    else if (BLF) drawBlCells(g, C, L, P);
    else for (const c of P.cols) {
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
    if (!BLF && st.sondeCol && SONDE_FIELDS.includes(st.field)) {
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
    // the model forecast (from 2026-11-10): hatched, behind a line at its first hour
    if (P.fcStart != null && !BLF) {
      const x0 = x(P.fcStart);
      g.save(); g.beginPath(); g.rect(x0, mt, ml + pw - x0, ph); g.clip();
      g.strokeStyle = L ? 'rgba(15,23,42,.13)' : 'rgba(226,232,240,.13)'; g.lineWidth = 1;
      for (let xx = x0 - ph; xx < ml + pw; xx += 9) { g.beginPath(); g.moveTo(xx, mt + ph); g.lineTo(xx + ph, mt); g.stroke(); }
      g.restore();
    }
    // day separators and time ticks
    const tickH = nH <= 36 ? 3 : nH <= 96 ? 6 : nH <= 200 ? 12 : 24;
    g.font = '11px system-ui'; g.textAlign = 'center';
    for (let t = Math.ceil(P.start / 3600) * 3600; t <= P.end; t += 3600) {
      const d = new Date(t * 1000), h = d.getUTCHours();
      const xx = x(t);
      if (h === 0 && P.avg) {
        if (t === P.start) { g.fillStyle = C.ink; g.textAlign = 'left';
          g.fillText(`Average day · ${P.avg.days} days (${P.avg.hours} h) by UTC hour`, xx + 3, mt - 8); g.textAlign = 'center'; }
      } else if (h === 0) {
        g.strokeStyle = C.day; g.lineWidth = 1; g.setLineDash([]);
        g.beginPath(); g.moveTo(xx, mt); g.lineTo(xx, mt + ph); g.stroke();
        g.fillStyle = C.ink; g.textAlign = 'left';
        g.fillText(`${DAY[d.getUTCDay()]} ${d.getUTCDate()}.${d.getUTCMonth() + 1}.`, xx + 3, mt - 8);
        g.textAlign = 'center';
      }
      if (h % tickH === 0) {
        g.strokeStyle = C.ink2; g.beginPath(); g.moveTo(xx, mt + ph); g.lineTo(xx, mt + ph + 4); g.stroke();
        if (!(P.avg && t === P.start)) { g.fillStyle = C.ink2; g.fillText(pad(h), xx, mt + ph + 15); }
      }
    }
    g.fillStyle = C.ink2; g.textAlign = 'right'; g.fillText('UTC', ml - 6, mt + ph + 15);
    // altitude axis (left: altitude, right: pressure)
    if (BLF) {
      g.textAlign = 'right';
      for (let f = 0; f <= blTop(); f += 500) {
        const yy = y(f);
        g.strokeStyle = C.grid; g.globalAlpha = f % 1000 ? 0.18 : 0.4; g.beginPath(); g.moveTo(ml, yy); g.lineTo(ml + pw, yy); g.stroke(); g.globalAlpha = 1;
        if (f % 1000 === 0) { g.fillStyle = C.ink2; g.fillText(fmtFt(f), ml - 6, yy + 4); }
      }
      g.save(); g.translate(ml + pw + 30, mt + ph / 2); g.rotate(Math.PI / 2); g.textAlign = 'center'; g.fillStyle = C.ink2;
      g.fillText('ft MSL (QNH) · aircraft within 25 km', 0, 0); g.restore();
    }
    const ticks = BLF ? [] : [0, 1000, 2000, 3000, 5000, 7000, 10000, 14000, 18000, 24000, 30000, 34000, 38000, 42000, 46000]
      .filter(f => f <= P.layers[topL + 1]);
    g.textAlign = 'right';
    for (const f of ticks) {
      const yy = y(f);
      g.strokeStyle = C.grid; g.globalAlpha = 0.35; g.beginPath(); g.moveTo(ml, yy); g.lineTo(ml + pw, yy); g.stroke(); g.globalAlpha = 1;
      g.fillStyle = C.ink2; g.fillText(fmtFt(f), ml - 6, yy + 4);
      g.textAlign = 'left'; g.fillText(`${Math.round(isaP(f))}`, ml + pw + 6, yy + 4); g.textAlign = 'right';
    }
    if (!BLF) { g.save(); g.translate(ml + pw + 46, mt + ph / 2); g.rotate(Math.PI / 2); g.textAlign = 'center';
      g.fillText('hPa (ISA of the pressure altitude)', 0, 0); g.restore(); }
    // isotherms 0 / −10 / −20 °C: lowest crossing per column
    if (st.iso && !BLF) {
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
    // isentropes (from 2026-11-10): potential temperature every 5 K from the ±1 h
    // smoothed layer temperatures — the lowest crossing per column, joined hour to hour
    if (st.theta && !BLF) {
      let lo = Infinity, hi = -Infinity;
      for (const c of P.cols) for (let i = 0; i <= topL; i++) if (c.TS[i] != null && c.TSN[i] >= 2) {
        const th = thetaOf(c.TS[i], zc(P, i)); lo = Math.min(lo, th); hi = Math.max(hi, th);
      }
      g.strokeStyle = C.theta; g.lineWidth = 1; g.setLineDash([]); g.font = '9px system-ui';
      let lastLab = -Infinity;
      for (let th = Math.ceil(lo / TH_STEP) * TH_STEP; th <= hi; th += TH_STEP) {
        let prev = null, firstPt = null;
        g.globalAlpha = th % 10 === 0 ? 0.95 : 0.6;
        for (const c of P.cols) {
          let pt = null;
          for (let i = 0; i < topL; i++) {
            if (c.TS[i] == null || c.TS[i + 1] == null || c.TSN[i] < 4 || c.TSN[i + 1] < 4) continue;
            const a = thetaOf(c.TS[i], zc(P, i)), b = thetaOf(c.TS[i + 1], zc(P, i + 1));
            if (a < th && b >= th) { pt = [x(c.ts) + cw / 2, y(zc(P, i) + (th - a) / (b - a) * (zc(P, i + 1) - zc(P, i)))]; break; }
          }
          if (pt && prev && c.ts - prev.ts <= 2 * 3600 && Math.abs(pt[1] - prev.pt[1]) < ph * 0.1) {
            g.beginPath(); g.moveTo(prev.pt[0], prev.pt[1]); g.lineTo(pt[0], pt[1]); g.stroke();
          }
          if (pt) { prev = { ts: c.ts, pt }; if (!firstPt) firstPt = pt; }
        }
        if (firstPt && th % 10 === 0 && Math.abs(firstPt[1] - lastLab) > 11) {
          g.globalAlpha = 1; g.fillStyle = C.theta; g.textAlign = 'left';
          g.fillText(String(th), Math.max(ml + 2, firstPt[0] - cw / 2 + 2), firstPt[1] - 2); lastLab = firstPt[1];
        }
      }
      g.globalAlpha = 1; g.font = '11px system-ui';
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
    if (st.tp && !BLF) runLine('tp', C.tp, 2.2, [7, 4], 'TP');
    if (st.vmax && !BLF) runLine('vm', C.vmax, 2.2, [], 'Vmax');
    // the mast's values inside the section (from 2026-11-01)
    if (st.mastOv && BLF && !P.avg) drawMastCols(g, L, C, P);
    // wind barbs
    if (st.barbs && BLF) drawBlBarbs(g, L, C, P);
    else if (st.barbs) {
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
    if (st.mastOv && st.barbs && !isFL() && !P.avg) drawMastBarbs(g, L, C, P, BLF);
    // boundary layer: the low-level jet and the surface inversion
    if (BLF || st.bl) drawBlMarks(g, L, P, BLF);
    if (BLF && st.cld && !P.avg) drawCloudBase(g, L, P);
    if (BLF && st.field === 'turb' && !P.avg) drawReports(g, L, C, P);
    if (P.fcStart != null && !BLF) {
      const x0 = x(P.fcStart);
      g.strokeStyle = C.fc; g.lineWidth = 1.5; g.setLineDash([6, 3]);
      g.beginPath(); g.moveTo(x0, mt); g.lineTo(x0, mt + ph); g.stroke(); g.setLineDash([]);
      g.fillStyle = C.fc; g.textAlign = 'left'; g.font = 'bold 10px system-ui';
      g.fillText('MEPS forecast →', Math.min(x0 + 4, ml + pw - 92), mt + 11); g.font = '11px system-ui';
    }
    // the hour in progress: hatch edge
    const last = P.cols.filter(c => !c.fc).pop();
    if (last && last.partial) {
      g.strokeStyle = C.now; g.setLineDash([3, 3]); g.lineWidth = 1;
      g.strokeRect(x(last.ts) + 0.5, mt + 0.5, cw - 1, ph - 1); g.setLineDash([]);
    }
    // frame
    g.strokeStyle = C.grid; g.lineWidth = 1; g.strokeRect(ml + 0.5, mt + 0.5, pw, ph);
    // sonde launches ▼ at the top
    for (const s of P.avg ? [] : sondes) {
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
    geo.mast = null;
    let yy = sy + stripH + 14;
    if (st.mast && !P.avg) { drawMastStrip(g, L, C, P, yy, MAST_H); yy += MAST_H + 16; }
    geo.strips = [];
    for (const k of strips) { drawStrip(g, L, C, P, k, yy, SH); geo.strips.push([k, yy, SH]); yy += SH + SGAP; }
  }

  // ── the extra strips (from 2026-11-10) ──────────────────────────────────
  const RWY_C = { '04L': '#2a78d6', '04R': '#7cb4f0', '15': '#eb6834', '33': '#e87ba4', '22L': '#1baf7a', '22R': '#8fd9b6' };
  const rwyFill = r => RWY_C[r] || '#8a8a86';
  // visibility / ceiling class of a METAR: 0 good, 1 reduced, 2 low, 3 very low
  function wxClass(m) {
    const vis = m[1], ceil = m[3];
    if ((vis != null && vis < 1500) || (ceil != null && ceil < 500)) return 3;
    if ((vis != null && vis < 5000) || (ceil != null && ceil < 1000)) return 2;
    if ((vis != null && vis < 8000) || (ceil != null && ceil < 1500)) return 1;
    return 0;
  }
  const WXC = ['', '#60a5fa', '#f59e0b', '#ef4444'];
  const WXC_T = ['visibility ≥ 8 km and ceiling ≥ 1 500 ft', 'visibility 5–8 km or ceiling 1 000–1 500 ft', 'visibility 1.5–5 km or ceiling 500–1 000 ft', 'visibility < 1.5 km or ceiling < 500 ft'];
  // present weather → [colour, word]; the first that matches
  function wxKind(wx) {
    if (!wx) return null;
    if (/TS/.test(wx)) return ['#dc2626', 'thunder'];
    if (/FZ/.test(wx)) return ['#c026d3', 'freezing'];
    if (/SN|SG|PL|GS|GR/.test(wx)) return ['#e2e8f0', 'snow'];
    if (/RA|SH/.test(wx)) return ['#16a34a', 'rain'];
    if (/DZ/.test(wx)) return ['#86efac', 'drizzle'];
    if (/FG/.test(wx)) return ['#a8a29e', 'fog'];
    if (/BR|HZ/.test(wx)) return ['#78716c', 'mist'];
    return ['#94a3b8', wx];
  }
  const metarAt = ts => { let m = null; for (const r of (ex && ex.metar) || []) { if (r[0] > ts) break; m = r; } return m && ts - m[0] <= 5400 ? m : null; };
  function drawStrip(g, L, C, P, key, sy, h) {
    const { ml, pw, cw, x } = geo;
    g.fillStyle = C.plot; g.fillRect(ml, sy, pw, h);
    g.save(); g.beginPath(); g.rect(ml, sy, pw, h); g.clip();
    const M = exMaps();
    if (key === 'rwy') {
      // landings above, departures below: the runway most used in the hour; its name at the start of each run
      const half = h / 2;
      for (const [row, k] of [[0, 1], [1, 2]]) {
        let prev = null;
        for (let t = P.start; t < P.end; t += 3600) {
          const r = M.rwy.get(t), top = r && r[k].length ? r[k][0][0] : null;
          if (top) {
            g.fillStyle = rwyFill(top); g.fillRect(x(t), sy + row * half + 1, cw + 0.5, half - 2);
            if (top !== prev && cw >= 3) {
              g.font = 'bold 9px system-ui'; g.textAlign = 'left'; g.fillStyle = '#0b1220';
              g.fillText(top, x(t) + 2, sy + row * half + half - 3);
            }
          }
          prev = top;
        }
      }
    } else if (key === 'wx') {
      const rows = (ex && ex.metar) || [], half = h / 2;
      for (let k = 0; k < rows.length; k++) {
        const m = rows[k], t1 = Math.min(k + 1 < rows.length ? rows[k + 1][0] : m[0] + 1800, m[0] + 3600);
        if (t1 <= P.start || m[0] >= P.end) continue;
        const x0 = x(m[0]), w = Math.max(1, x(t1) - x0);
        const c = wxClass(m);
        g.fillStyle = c ? WXC[c] : (L ? 'rgba(15,23,42,.10)' : 'rgba(226,232,240,.10)');     // good: a faint tint (a METAR exists)
        g.fillRect(x0, sy + 1, w + 0.5, half - 2);
        const wk = wxKind(m[2]);
        if (wk) { g.fillStyle = wk[0]; g.fillRect(x0, sy + half + 1, w + 0.5, half - 2); }
      }
    } else if (key === 'gnss') {
      for (let t = P.start; t < P.end; t += 3600) {
        const r = M.gnss.get(t);
        if (!r || !r[1]) continue;
        const f = r[2] / r[1], hh = Math.max(1, f * (h - 2));
        g.fillStyle = f >= 0.5 ? '#ef4444' : f >= 0.2 ? '#f59e0b' : '#64748b';
        g.fillRect(x(t) + 0.5, sy + h - 1 - hh, Math.max(1, cw - 1), hh);
      }
    }
    g.restore();
    g.strokeStyle = C.grid; g.lineWidth = 1; g.strokeRect(ml + 0.5, sy + 0.5, pw, h);
    g.fillStyle = C.ink2; g.textAlign = 'right'; g.font = '10px system-ui';
    const lab = { rwy: ['rwy landing', 'departure'], wx: ['vis / ceiling', 'weather'], gnss: ['GNSS', 'degraded %'] }[key];
    g.fillText(lab[0], ml - 6, sy + 10); g.fillText(lab[1], ml - 6, sy + 21);
    if (!ex) { g.textAlign = 'left'; g.fillText('loading…', ml + 8, sy + h / 2 + 4); }
  }
  function stripTip(key, ts, mx) {
    const M = exMaps();
    if (key === 'rwy') {
      const r = M.rwy.get(ts);
      if (!r) return '<span class="mini-tip-dim">no landings or departures recorded</span>';
      const f = a => a.length ? a.map(([n, c]) => `<b>${n}</b> ${c}`).join(' · ') : '–';
      return `landings: ${f(r[1])}<br>departures: ${f(r[2])}`;
    }
    if (key === 'wx') {
      const t = geo.P.start + (mx - geo.ml) / geo.cw * 3600, m = metarAt(t);
      if (!m) return '<span class="mini-tip-dim">no METAR</span>';
      const d = new Date(m[0] * 1000), wk = wxKind(m[2]);
      return `METAR ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC · ${m[5] ? 'CAVOK' : `visibility ${m[1] != null ? (m[1] >= 9999 ? '≥ 10 km' : m[1] + ' m') : '–'}`}` +
        ` · ceiling ${m[3] != null ? fmtFt(m[3]) + ' AGL' : 'none'}${m[4] != null && m[4] !== m[3] ? ` (lowest cloud ${fmtFt(m[4])})` : ''}` +
        `<br>weather: ${m[2] ? `<b>${m[2]}</b>${wk ? ' (' + wk[1] + ')' : ''}` : 'none'} · wind ${m[6] != null ? String(m[6]).padStart(3, '0') + '°' : 'VRB'} ${m[7] ?? '–'} kt${m[8] ? ' G' + m[8] : ''}` +
        `<br><span class="mini-tip-dim">${WXC_T[wxClass(m)]}</span>`;
    }
    const r = M.gnss.get(ts);
    return r && r[1] ? `GNSS: <b>${Math.round(100 * r[2] / r[1])} %</b> of ${r[1]} aircraft reported a degraded position` +
      '<br><span class="mini-tip-dim">details on the GPS pages</span>' : '<span class="mini-tip-dim">no GNSS record</span>';
  }
  // METAR cloud base in the boundary-layer fields: the ceiling (BKN / OVC, solid)
  // and the lowest base when it is lower (FEW / SCT, dotted), ft MSL
  function drawCloudBase(g, L, P) {
    const { ml, mt, pw, ph, x, y } = geo, rows = (ex && ex.metar) || [], el = (ex && ex.elev) || 0;
    const col = L ? '#334155' : '#e2e8f0';
    g.save(); g.beginPath(); g.rect(ml, mt, pw, ph); g.clip();
    for (const [idx, dash, lw] of [[3, [], 2], [4, [2, 3], 1.3]]) {
      g.setLineDash(dash);
      for (let k = 0; k < rows.length; k++) {
        const m = rows[k], v = m[idx];
        if (v == null || (idx === 4 && m[3] === v) || v + el > blTop()) continue;
        const t1 = Math.min(k + 1 < rows.length ? rows[k + 1][0] : m[0] + 1800, m[0] + 3600);
        if (t1 <= P.start || m[0] >= P.end) continue;
        const yy = y(v + el);
        for (const [c, w] of [[L ? '#ffffff' : '#0f172a', lw + 2], [col, lw]]) {
          g.strokeStyle = c; g.lineWidth = w; g.beginPath(); g.moveTo(x(m[0]), yy); g.lineTo(x(t1), yy); g.stroke();
        }
      }
    }
    g.setLineDash([]); g.restore();
  }
  // ── turbulence 0–5 000 ft (from 2026-11-10) ─────────────────────────────
  function turbIn(P) {
    const src = (ex && ex.turb && ex.turb.hours) || [];
    if (!P.avg) return src.filter(r => r[0] >= P.start && r[0] < P.end);
    const out = [];
    for (let h = 0; h < 24; h++) {
      const B = new Map();
      let n = 0;
      for (const [ts, cells] of src) {
        if (Math.round(ts / 3600) % 24 !== h) continue;
        n++;
        for (const c of cells) (B.get(c[0]) || B.set(c[0], []).get(c[0])).push(c);
      }
      if (!n) continue;
      out.push([P.avg.base + h * 3600, [...B].sort((a, b) => a[0] - b[0]).map(([b, v]) => {
        const med = v.map(c => c[1]).sort((p, q) => p - q);
        return [b, med[Math.floor(med.length / 2)], Math.max(...v.map(c => c[2])), v.reduce((a, c) => a + c[3], 0), v.reduce((a, c) => a + c[4], 0), v.length];
      })]);
    }
    return out;
  }
  function drawTurbCells(g, C, L, P) {
    const { ml, mt, pw, ph, cw, x, y } = geo, bin = (ex && ex.turb && ex.turb.bin) || 500;
    g.save(); g.beginPath(); g.rect(ml, mt, pw, ph); g.clip();
    g.strokeStyle = L ? 'rgba(100,116,139,.22)' : 'rgba(148,163,184,.13)'; g.lineWidth = 1;
    for (let xx = ml - ph; xx < ml + pw; xx += 7) { g.beginPath(); g.moveTo(xx, mt + ph); g.lineTo(xx + ph, mt); g.stroke(); }
    for (const [ts, cells] of turbIn(P)) {
      const x0 = x(ts);
      for (const [b, med, , n] of cells) {
        const ya = y(b + bin), yb = y(b);
        g.globalAlpha = 1; g.fillStyle = C.plot; g.fillRect(x0, ya, cw + 0.5, yb - ya + 0.5);
        g.globalAlpha = n < 3 ? 0.55 : 1; g.fillStyle = turbClass(med)[1]; g.fillRect(x0, ya, cw + 0.5, yb - ya + 0.5);
      }
    }
    g.globalAlpha = 1; g.restore();
  }
  const repCol = ph => /SEV/.test(ph || '') ? '#ef4444' : /MOD/.test(ph || '') ? '#f59e0b' : /FBL|LGT/.test(ph || '') ? '#facc15' : '#94a3b8';
  // pilot reports and SIGMETs: ▼ at the top at their time; those reaching below 5 000 ft also as a bar over their heights
  function drawReports(g, L, C, P) {
    const { ml, mt, pw, x, y } = geo;
    geo.reps = [];
    for (const r of (ex && ex.reps) || []) {
      const [ts, , ph, lo, hi] = r;
      if (ts < P.start || ts >= P.end) continue;
      const xx = x(ts), col = repCol(ph);
      if (xx < ml || xx > ml + pw) continue;
      let y0 = null, y1 = null;
      if (lo != null && hi != null && lo < blTop()) {
        y0 = y(Math.min(hi, blTop())); y1 = y(Math.max(lo, 0));
        for (const [c, w] of [[L ? '#ffffff' : '#0f172a', 5], [col, 2.5]]) {
          g.strokeStyle = c; g.lineWidth = w; g.beginPath(); g.moveTo(xx, y0); g.lineTo(xx, y1); g.stroke();
        }
      }
      g.fillStyle = col; g.strokeStyle = L ? '#ffffff' : '#0f172a'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(xx - 6, mt + 2); g.lineTo(xx + 6, mt + 2); g.lineTo(xx, mt + 12); g.closePath(); g.fill(); g.stroke();
      geo.reps.push({ x: xx, y0, y1, r });
    }
  }
  function turbTip(P, ts, ft) {
    const row = turbIn(P).find(r => r[0] === ts), bin = (ex && ex.turb && ex.turb.bin) || 500;
    const c = row && row[1].find(c => ft >= c[0] && ft < c[0] + bin);
    if (!c) return '<span class="mini-tip-dim">no EDR pieces at this height (no straight flight segment)</span>';
    return `turbulence ${fmtFt(c[0])}–${fmtFt(c[0] + bin)}: <b>${turbClass(c[1])[2]}</b>, EDR ${c[1].toFixed(2)} (median) · strongest piece ${c[2].toFixed(2)}` +
      ` <span class="mini-tip-dim">(${c[3]} pieces of ${c[4]} flights${c[5] ? ` in ${c[5]} hours` : ''})</span>` +
      '<br><span class="mini-tip-dim">EDR from the headwind of the landings and departures (about 2 km pieces) — a research estimate, not the ICAO 1-min peak</span>';
  }

  // ── Kivenlahti mast (from 2026-11-01) ───────────────────────────────────
  const mastIn = P => (mastRows || []).filter(r => r.ts >= P.start && r.ts < P.end);
  const MAST_C = L => L ? '#b45309' : '#f59e0b';
  // stability of the lowest 300 m: T(top) − T(2 m) against the dry adiabat
  function mastStab(r) {
    const n = (r.tl || []).length;
    if (n < 2 || r.t[n - 1] == null || r.t[0] == null) return null;
    const dT = r.t[n - 1] - r.t[0], dry = -0.0098 * (r.tl[n - 1] - r.tl[0]);
    return { dT, dry, cls: dT > 0.3 ? 'inv' : dT > dry + 0.6 ? 'stable' : dT < dry - 0.6 ? 'unstable' : 'mixed' };
  }
  function mastStabFill(s, L) {
    if (!s) return null;
    if (s.cls === 'inv') return `rgba(124,58,237,${(0.25 + 0.6 * Math.min(1, s.dT / 4)).toFixed(2)})`;
    if (s.cls === 'unstable') return `rgba(234,88,12,${(0.25 + 0.5 * Math.min(1, (s.dry - s.dT) / 2)).toFixed(2)})`;
    if (s.cls === 'stable') return L ? 'rgba(96,165,250,.25)' : 'rgba(96,165,250,.2)';
    return null;
  }
  function drawMastStrip(g, L, C, P, sy, h) {
    const { ml, pw, cw, x } = geo;
    geo.mast = [sy, h];
    g.fillStyle = C.plot; g.fillRect(ml, sy, pw, h);
    const rows = mastIn(P);
    for (const r of rows) {
      const f = mastStabFill(mastStab(r), L);
      if (f) { g.fillStyle = f; g.fillRect(x(r.ts), sy, cw + 0.5, h); }
    }
    // barbs: the 4 levels, the highest at the top
    const stepC = Math.max(1, Math.ceil(30 / cw));
    const n = rows.length ? rows[rows.length - 1].wl.length : 4;
    const yy = i => sy + h - 8 - i * (h - 16) / Math.max(1, n - 1);
    for (const [col, lw] of [[L ? 'rgba(248,250,252,0.85)' : 'rgba(15,25,35,0.8)', 2.6], [MAST_C(L), 1.1]]) {
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = lw;
      for (const r of rows) {
        if (Math.round((r.ts - P.start) / 3600) % stepC) continue;
        r.wl.forEach((m, i) => { if (r.ws[i] != null && r.wd[i] != null) barb(g, x(r.ts) + cw / 2, yy(i), r.wd[i], r.ws[i]); });
      }
    }
    g.strokeStyle = C.grid; g.lineWidth = 1; g.strokeRect(ml + 0.5, sy + 0.5, pw, h);
    g.fillStyle = MAST_C(L); g.textAlign = 'right'; g.font = '10px system-ui';
    g.fillText('mast', ml - 6, sy + h / 2 + 4);
    g.fillStyle = C.ink2;
    if (rows.length) { const wl = rows[rows.length - 1].wl; g.fillText(`${wl[wl.length - 1]} m`, ml - 6, yy(wl.length - 1) + 4); g.fillText(`${wl[0]} m`, ml - 6, yy(0) + 4); }
    if (!rows.length) { g.textAlign = 'left'; g.fillText('no mast data in this period', ml + 8, sy + h / 2 + 4); }
  }
  // inside the boundary-layer fields: a narrow column at the right of each hour
  function drawMastCols(g, L, C, P) {
    const { ml, mt, pw, ph, cw, x, y } = geo;
    if (st.field !== 'blt' && st.field !== 'blw') return;
    g.save(); g.beginPath(); g.rect(ml, mt, pw, ph); g.clip();
    const bl = new Map((blRows || []).map(r => [r.ts, r]));
    const w = Math.max(3, cw * 0.38);
    for (const r of mastIn(P)) {
      const x0 = x(r.ts) + cw - w;
      const lv = st.field === 'blt' ? r.tl : r.wl;
      const ref = st.field === 'blt' ? ((bl.get(r.ts) || {}).tt ?? r.t[0]) : null;
      for (let i = 0; i < lv.length; i++) {
        const v = st.field === 'blt' ? r.t[i] : r.ws[i];
        if (v == null || (st.field === 'blt' && ref == null)) continue;
        const fa = i ? (mastFt(lv[i - 1]) + mastFt(lv[i])) / 2 : mastFt(0);
        const fb = i < lv.length - 1 ? (mastFt(lv[i]) + mastFt(lv[i + 1])) / 2 : mastFt(lv[i]) + (mastFt(lv[i]) - fa);
        const ya = y(fb), yb = y(fa);
        g.fillStyle = st.field === 'blt' ? divFill(v - ref, 6) : blSpd(v);
        g.fillRect(x0, ya, w, yb - ya + 0.5);
      }
      // a thin gap on the left and an amber cap on top mark the column as the mast's
      const top = y(mastFt(lv[lv.length - 1]) + 60), bot = y(mastFt(0));
      g.fillStyle = C.plot; g.fillRect(x0 - 1, top, 1, bot - top);
      g.fillStyle = MAST_C(L); g.fillRect(x0, top - 1, w, 2);
    }
    g.restore();
  }
  // the mast's barbs (amber) at their heights, on any field
  function drawMastBarbs(g, L, C, P, BLF) {
    const { ml, mt, pw, ph, cw, x, y } = geo;
    const stepC = Math.max(1, Math.ceil(36 / cw));
    const xo = BLF ? cw - Math.max(3, cw * 0.38) / 2 : cw / 2;
    g.save(); g.beginPath(); g.rect(ml, mt, pw, ph); g.clip();
    for (const [col, lw] of [[L ? 'rgba(248,250,252,0.85)' : 'rgba(15,25,35,0.8)', 2.8], [MAST_C(L), 1.2]]) {
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = lw;
      for (const r of mastIn(P)) {
        if (Math.round((r.ts - P.start) / 3600) % stepC) continue;
        let lastY = Infinity;
        r.wl.forEach((m, i) => {
          const yy = y(mastFt(m));
          if (r.ws[i] == null || r.wd[i] == null || lastY - yy < 14) return;
          barb(g, x(r.ts) + xo, yy, r.wd[i], r.ws[i]); lastY = yy;
        });
      }
    }
    g.restore();
  }
  function mastTip(r) {
    if (!r) return '<span class="mini-tip-dim">no mast data for this hour</span>';
    const s = mastStab(r);
    const w = r.wl.map((m, i) => `${m} m ${r.wd[i] != null ? String(Math.round(r.wd[i])).padStart(3, '0') + '°' : '–'} ${r.ws[i] != null ? Math.round(r.ws[i]) : '–'} kt <span class="mini-tip-dim">G${r.wg[i] != null ? Math.round(r.wg[i]) : '–'}</span>`).reverse().join(' · ');
    return `<b style="color:${MAST_C(light())}">Kivenlahti mast</b> (hour mean, ${r.n} obs.)<br>${w}<br>` +
      `T ${r.t[0] != null ? r.t[0].toFixed(1) : '–'} °C at ${r.tl[0]} m, ${r.t[r.t.length - 1] != null ? r.t[r.t.length - 1].toFixed(1) : '–'} °C at ${r.tl[r.tl.length - 1]} m` +
      (s ? ` · ${s.dT >= 0 ? '+' : ''}${s.dT.toFixed(1)} K: ${s.cls === 'inv' ? 'inversion' : s.cls === 'unstable' ? 'unstable (super-adiabatic)' : s.cls === 'stable' ? 'stable' : 'well mixed'}` : '');
  }

  // ── boundary layer ──────────────────────────────────────────────────────
  let blFoldKey = null, blFolded = null;
  const blIn = P => {
    if (P.avg) {                                          // the average day (from 2026-11-10)
      const k = `${blKey}|${blAt}|${P.avg.base}`;
      if (blFoldKey !== k) { blFolded = foldBl(blRows || [], P.avg.base); blFoldKey = k; }
      return blFolded;
    }
    return (blRows || []).filter(r => r.ts >= P.start && r.ts < P.end).sort((a, b) => a.ts - b.ts);
  };
  const blRed = L => L ? '#b91c1c' : '#f87171';
  // cells: wind speed in 250-ft bins (blw) or temperature − METAR in the 200-ft bands (blt); hatched = no flights
  function drawBlCells(g, C, L, P) {
    const { ml, mt, pw, ph, cw, x, y } = geo;
    g.save(); g.beginPath(); g.rect(ml, mt, pw, ph); g.clip();
    g.strokeStyle = L ? 'rgba(100,116,139,.22)' : 'rgba(148,163,184,.13)'; g.lineWidth = 1;
    for (let xx = ml - ph; xx < ml + pw; xx += 7) { g.beginPath(); g.moveTo(xx, mt + ph); g.lineTo(xx + ph, mt); g.stroke(); }
    for (const r of blIn(P)) {
      const x0 = x(r.ts);
      const cells = st.field === 'blw' ? (r.w || []).map(([ft, kt, , n]) => [ft, 125, blSpd(kt), n < 5])
        : r.tt == null ? [] : (r.t || []).map(([ft, tc, n]) => [ft, 100, divFill(tc - r.tt, 6), n < 6]);
      for (const [ft, hh, col, weak] of cells) {
        const ya = y(ft + hh), yb = y(ft - hh);
        g.globalAlpha = 1; g.fillStyle = C.plot; g.fillRect(x0, ya, cw + 0.5, yb - ya + 0.5);
        g.globalAlpha = weak ? 0.55 : 1; g.fillStyle = col; g.fillRect(x0, ya, cw + 0.5, yb - ya + 0.5);
      }
    }
    g.globalAlpha = 1; g.restore();
  }
  // ── the flights' fine headwind profiles (blh / bld) ─────────────────────
  const flIn = P => (flRows || []).filter(f => f.t >= P.start && f.t < P.end && (st.flk === 'all' || f.k === st.flk));
  const flVal = (f, ft) => { const j = Math.round((ft - f.lo) / FL_BIN); return j >= 0 && j < f.v.length ? f.v[j] : null; };
  // the profile with gaps of up to 300 ft filled linearly (a climb-out loses a
  // few replies in each turn) — [[kt, filled]], memoised on the flight
  function flFilled(f) {
    if (f._fill) return f._fill;
    const v = f.v, out = v.map(x => (x == null ? null : [x, false]));
    for (let j = 0; j < v.length; j++) {
      if (v[j] != null) continue;
      let a = j - 1; while (a >= 0 && v[a] == null) a--;
      let b = j + 1; while (b < v.length && v[b] == null) b++;
      if (a >= 0 && b < v.length && b - a <= 4) out[j] = [v[a] + (v[b] - v[a]) * (j - a) / (b - a), true];
    }
    f._fill = out;
    return out;
  }
  // the median headwind of the flights of the previous 45 min in the same
  // direction (±30°), per 100-ft bin, at least 3 — memoised on the flight
  function flRef(f, rows) {
    if (f._ref !== undefined) return f._ref;
    f._ref = null;
    if (f.h == null) return null;
    const refs = rows.filter(o => o !== f && o.t < f.t && o.t >= f.t - FL_REF && o.h != null && angDiff(o.h, f.h) <= FL_DIR);
    if (refs.length < 3) return null;
    const m = new Map();
    for (let j = 0; j < f.v.length; j++) {
      const ft = f.lo + j * FL_BIN, vs = [];
      for (const o of refs) { const v = flVal(o, ft); if (v != null) vs.push(v); }
      if (vs.length >= 3) { vs.sort((a, b) => a - b); const k = vs.length >> 1; m.set(ft, vs.length % 2 ? vs[k] : (vs[k - 1] + vs[k]) / 2); }
    }
    f._ref = { n: refs.length, m };
    return f._ref;
  }
  // the change against the reference, smoothed over ±100 ft (3 bins) — the single
  // values of a flight scatter by about ±1.5 kt
  function flDiff(f, ref, j) {
    if (!ref) return null;
    const fv = flFilled(f);
    let s = 0, n = 0;
    for (let k = j - 1; k <= j + 1; k++) {
      if (k < 0 || k >= fv.length || !fv[k]) continue;
      const r = ref.m.get(f.lo + k * FL_BIN);
      if (r == null) continue;
      s += fv[k][0] - r; n++;
    }
    return n ? s / n : null;
  }
  // change colour: blue less / red more headwind, nearly clear within ±2 kt, full at ±12 kt
  function chgFill(v) {
    const k = Math.max(0, Math.min(1, (Math.abs(v) - 2) / 10));
    const c = v < 0 ? DIV.neg : DIV.pos;
    return `rgba(${c[0]},${c[1]},${c[2]},${(0.06 + 0.86 * k).toFixed(3)})`;
  }
  // the vertical shear of the flight's headwind: the slope of a straight line through
  // the values within ±200 ft (at least 4 of the 5), kt per 100 ft, + = more headwind higher up
  function flShear(f, j) {
    const fv = flFilled(f);
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let k = j - 2; k <= j + 2; k++) {
      if (k < 0 || k >= fv.length || !fv[k]) continue;
      const x = k - j, y = fv[k][0];
      n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    if (n < 4) return null;
    const den = n * sxx - sx * sx;
    return den ? (n * sxy - sx * sy) / den : null;
  }
  // shear colour: red = the headwind grows upwards (a descending aircraft loses headwind), blue = it falls;
  // nearly clear within ±0.7 kt per 100 ft, full at ±3
  function shFill(v) {
    const k = Math.max(0, Math.min(1, (Math.abs(v) - 0.7) / 2.3));
    const c = v < 0 ? DIV.neg : DIV.pos;
    return `rgba(${c[0]},${c[1]},${c[2]},${(0.05 + 0.87 * k).toFixed(3)})`;
  }
  const LV_COL = { adv: '#3b82f6', wsa: '#d97706', mba: '#ef4444' };
  function drawFlCells(g, C, L, P) {
    const { ml, mt, pw, ph, x, y } = geo;
    g.save(); g.beginPath(); g.rect(ml, mt, pw, ph); g.clip();
    g.strokeStyle = L ? 'rgba(100,116,139,.22)' : 'rgba(148,163,184,.13)'; g.lineWidth = 1;
    for (let xx = ml - ph; xx < ml + pw; xx += 7) { g.beginPath(); g.moveTo(xx, mt + ph); g.lineTo(xx + ph, mt); g.stroke(); }
    const rows = flIn(P), cols = [];
    const all = flRows || [];
    for (let i = 0; i < rows.length; i++) {
      const f = rows[i], nx = rows[i + 1];
      const x0 = x(f.t);
      const w = Math.max(1.5, Math.min((nx ? x(nx.t) : x(P.end)) - x0, x(f.t + FL_HOLD) - x0));
      const ref = st.field === 'bld' ? flRef(f, all) : null;
      cols.push({ x0, w, f, ref });
      const fv = flFilled(f);
      for (let j = 0; j < fv.length; j++) {
        if (!fv[j]) continue;
        const [v, filled] = fv[j];
        const ft = f.lo + j * FL_BIN;
        let col;
        if (st.field === 'blh') col = hwFill(v);
        else if (st.field === 'bls') { const sh = flShear(f, j); if (sh == null) continue; col = shFill(sh); }
        else { const dv = flDiff(f, ref, j); if (dv == null) continue; col = chgFill(dv); }
        const ya = y(ft + FL_BIN / 2), yb = y(ft - FL_BIN / 2);
        g.globalAlpha = 1; g.fillStyle = C.plot; g.fillRect(x0, ya, w + 0.5, yb - ya + 0.5);
        g.globalAlpha = filled ? 0.6 : 1; g.fillStyle = col; g.fillRect(x0, ya, w + 0.5, yb - ya + 0.5);
      }
      g.globalAlpha = 1;
    }
    // windshear alerts: the ramp (or band) of the alert outlined in the level's colour
    for (const c of cols) {
      const f = c.f;
      if (!f.wa || !LV_COL[f.lv]) continue;
      const ya = y(f.wa[1] + 50), yb = y(f.wa[0] - 50), ww = Math.max(c.w, 4);
      for (const [col, lw] of [[L ? '#ffffff' : '#0f172a', 3.5], [LV_COL[f.lv], 1.8]]) {
        g.strokeStyle = col; g.lineWidth = lw; g.strokeRect(c.x0 - 0.5, ya, ww + 1, yb - ya);
      }
    }
    // the runway direction of the flights along the top (the headwind is along
    // each flight's own runway: a change of runway changes the colours too)
    const rwDir = f => (f.rw && /^\d\d/.test(f.rw) ? f.rw.slice(0, 2) : f.h != null ? String(Math.round(f.h / 10) % 36 || 36).padStart(2, '0') : '?');
    const DIRC = { '04': '#38bdf8', '05': '#38bdf8', '15': '#f59e0b', '14': '#f59e0b', '16': '#f59e0b', '22': '#2dd4bf', '23': '#2dd4bf', '33': '#f472b6', '34': '#f472b6', '32': '#f472b6' };
    g.font = 'bold 10px system-ui'; g.textAlign = 'left';
    let lastLbl = -1e9, lastDir = null;
    for (const c of cols) {
      if (c.f.k !== 'a') continue;                       // the landing runway in use
      const d = rwDir(c.f);
      g.fillStyle = DIRC[d] || C.ink2; g.fillRect(c.x0, mt, c.w + 0.5, 4);
      if (d !== lastDir && c.x0 >= lastLbl) {
        g.strokeStyle = L ? '#ffffff' : '#0f172a'; g.lineWidth = 3; g.strokeText(`RWY ${d}`, c.x0 + 2, mt + 15);
        g.fillStyle = DIRC[d] || C.ink; g.fillText(`RWY ${d}`, c.x0 + 2, mt + 15);
        lastLbl = c.x0 + g.measureText(`RWY ${d}`).width + 8;
      }
      lastDir = d;
    }
    g.restore();
    geo.fcols = cols;
  }
  function flTip(c, ft) {
    const f = c.f, d = new Date(f.t * 1000);
    const parts = [`<b>${f.cs || '?'}</b>${f.ty ? ' ' + f.ty : ''} · ${f.k === 'a' ? 'landing' : 'departure'}${f.rw ? ' ' + f.rw : ''} · ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC <span class="mini-tip-dim">(${d.getUTCDate()}.${d.getUTCMonth() + 1}.)</span>`];
    const b = Math.round(ft / FL_BIN) * FL_BIN, v = flVal(f, b);
    if (v == null) parts.push(`<span class="mini-tip-dim">no value at ${fmtFt(b)}${f.v.length ? ` — this flight ${fmtFt(f.lo)}–${fmtFt(f.lo + (f.v.length - 1) * FL_BIN)}` : ''}</span>`);
    else {
      parts.push(`${v >= 0 ? 'headwind' : 'tailwind'} <b>${Math.abs(v).toFixed(1)} kt</b> at ${fmtFt(b)} MSL`);
      const ref = flRef(f, flRows || []), r = ref && ref.m.get(b);
      if (r != null) parts.push(`${v - r >= 0 ? '+' : ''}${(v - r).toFixed(1)} kt against the median ${r.toFixed(1)} kt of ${ref.n} flights of the previous 45 min in the same direction` +
        (st.field === 'bld' ? ` (±100 ft mean ${(() => { const dv = flDiff(f, ref, Math.round((b - f.lo) / FL_BIN)); return dv == null ? '–' : (dv >= 0 ? '+' : '') + dv.toFixed(1); })()} kt)` : '') +
        ` <span class="mini-tip-dim">(${v - r < 0 ? 'less headwind' : 'more headwind'})</span>`);
      else parts.push('<span class="mini-tip-dim">fewer than 3 flights of the previous 45 min in the same direction at this height</span>');
      const sh = flShear(f, Math.round((b - f.lo) / FL_BIN));
      if (sh != null) parts.push(`shear ${sh >= 0 ? '+' : ''}${sh.toFixed(1)} kt per 100 ft over ±200 ft <span class="mini-tip-dim">(${sh >= 0 ? 'more headwind higher up — a descent loses headwind' : 'less headwind higher up — a descent gains headwind'})</span>`);
    }
    if (f.lv && f.lv !== 'none') parts.push(`<b style="color:${LV_COL[f.lv]}">windshear ${f.lv.toUpperCase()}</b>` + (f.wa ? ` at ${fmtFt(f.wa[0])}–${fmtFt(f.wa[1])}` : ''));
    parts.push(`<span class="mini-tip-dim">headwind along the ${f.k === 'a' ? 'approach' : 'climb'}${f.h != null ? ` (${String(Math.round(f.h)).padStart(3, '0')}°)` : ''} · ` +
      `${f.src === 'v7' ? 'TAS − GS of the BDS 5,0 replies (no ADS-B ground speed)' : 'both airspeed registers against the ADS-B ground speed (v8)'} · mean of 100 ft · research</span>`);
    return parts.join('<br>');
  }
  async function loadFl() {
    const key = `${st.hours}|${st.endDate}`;
    if (flRows && flKey === key && (st.endDate || Date.now() - flAt < 60000)) return;
    try {
      const r = await fetch(`/api/boundary/flights?hours=${st.hours}&end=${endTs()}`).then(r => r.json());
      flRows = Array.isArray(r) ? r : [];
    } catch (e) { flRows = []; }
    flKey = key; flAt = Date.now();
  }
  // barbs from the 250-ft wind bins at every 500 ft (fewer when the plot is low)
  function drawBlBarbs(g, L, C, P) {
    const { cw, x, y } = geo;
    const stepC = Math.max(1, Math.ceil(36 / cw));
    const lv = [];
    let lastY = Infinity;
    for (let f = 500; f <= blTop(); f += 500) { const yy = y(f); if (lastY - yy >= 30) { lv.push(f); lastY = yy; } }
    for (const [col, lw] of [[L ? 'rgba(248,250,252,0.85)' : 'rgba(15,25,35,0.8)', 2.8], [C.barb, 1.1]]) {
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = lw;
      for (const r of blIn(P)) {
        if (Math.round((r.ts - P.start) / 3600) % stepC) continue;
        const by = new Map((r.w || []).map(b => [b[0], b]));
        for (const f of lv) { const b = by.get(f); if (b) barb(g, x(r.ts) + cw / 2, y(f), b[2], b[1]); }
      }
    }
  }
  // the surface inversion (red bar along the bottom and a red line at its top;
  // as an overlay also a light red fill from the ground to the top) and the
  // low-level jet (◆ at the nose, joined hour to hour, its speed at the
  // strongest hour of each run or at every hour when the columns are wide)
  function drawBlMarks(g, L, P, BLF) {
    const { ml, mt, pw, ph, cw, x, y } = geo;
    const rows = blIn(P), red = blRed(L);
    g.save(); g.beginPath(); g.rect(ml, mt - 1, pw, ph + 2); g.clip();
    // runs of consecutive inversion hours: light fill (overlay) and a line along the top
    const iruns = [];
    let ir = null;
    for (const r of rows) {
      if (!r.inv) { ir = null; continue; }
      if (!ir || r.ts - ir[ir.length - 1].ts > 3600) { ir = []; iruns.push(ir); }
      ir.push(r);
    }
    const yb = y(0);
    for (const run of iruns) {
      const pts = [];
      for (const r of run) { const x0 = x(r.ts), yt = y(r.inv.top || 1000); pts.push([x0, yt], [x0 + cw, yt]); }
      if (!BLF) {
        g.beginPath(); g.moveTo(pts[0][0], yb); for (const q of pts) g.lineTo(q[0], q[1]); g.lineTo(pts[pts.length - 1][0], yb); g.closePath();
        g.globalAlpha = 0.16; g.fillStyle = red; g.fill(); g.globalAlpha = 1;
      }
      for (const [c, w] of [[L ? '#ffffff' : '#0f172a', 3.5], [red, 2]]) {
        g.strokeStyle = c; g.lineWidth = w; g.beginPath();
        pts.forEach((q, k) => (k ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]))); g.stroke();
      }
      g.fillStyle = red; g.fillRect(pts[0][0], mt + ph - 5, pts[pts.length - 1][0] - pts[0][0], 5);
    }
    const jc = L ? '#0f172a' : '#ffffff', halo = L ? '#ffffff' : '#0f172a';
    const ds = Math.max(3, Math.min(5.5, cw * 0.45));
    const runs = [];
    let prev = null, run = null;
    for (const r of rows) {
      if (!r.llj) { prev = null; run = null; continue; }
      const pt = [x(r.ts) + cw / 2, y(r.llj.ft)];
      if (prev && r.ts - prev.ts <= 3600) {
        for (const [c, w] of [[halo, 4], [jc, 2]]) { g.strokeStyle = c; g.lineWidth = w; g.beginPath(); g.moveTo(prev.pt[0], prev.pt[1]); g.lineTo(pt[0], pt[1]); g.stroke(); }
      } else { run = []; runs.push(run); }
      run.push({ r, pt });
      prev = { ts: r.ts, pt };
    }
    g.font = 'bold 10px system-ui'; g.textAlign = 'center'; g.lineJoin = 'round';
    const boxes = [];                                    // labels drawn, so that they do not overlap
    for (const rn of runs) {
      const top = rn.reduce((a, b) => (b.r.llj.kt > a.r.llj.kt ? b : a));
      for (const { r, pt } of rn) {
        g.beginPath(); g.moveTo(pt[0], pt[1] - ds); g.lineTo(pt[0] + ds, pt[1]); g.lineTo(pt[0], pt[1] + ds); g.lineTo(pt[0] - ds, pt[1]); g.closePath();
        g.fillStyle = jc; g.fill(); g.strokeStyle = halo; g.lineWidth = 1; g.stroke();
        const lx = pt[0], ly = pt[1] - ds - 3;
        if ((cw >= 16 || r === top.r) && !boxes.some(b => Math.abs(b[0] - lx) < 18 && Math.abs(b[1] - ly) < 12)) {
          boxes.push([lx, ly]);
          g.strokeStyle = halo; g.lineWidth = 3; g.strokeText(String(r.llj.kt), pt[0], pt[1] - ds - 3);
          g.fillStyle = jc; g.fillText(String(r.llj.kt), pt[0], pt[1] - ds - 3);
        }
      }
    }
    g.restore();
  }
  // the hover text of the boundary layer of an hour; ft: the cursor height (BL field) or null (overlay)
  function blTip(r, ft) {
    if (!r) return null;
    const parts = [];
    if (ft != null) {
      const b = (r.w || []).find(w => Math.abs(w[0] - ft) <= 125);
      if (b) parts.push(`wind ${String(b[2]).padStart(3, '0')}° ${b[1]} kt <span class="mini-tip-dim">(${b[3]} obs, ${fmtFt(b[0])} MSL)</span>`);
      const t = (r.t || []).find(w => Math.abs(w[0] - ft) <= 100);
      if (t && r.avg) parts.push(`temperature ${t[1] >= 0 ? '+' : ''}${t[1].toFixed(1)} K against the surface <span class="mini-tip-dim">(mean, ${fmtFt(t[0])})</span>`);
      else if (t) parts.push(`T ${t[1].toFixed(1)} °C` + (r.tt != null ? ` · ${t[1] - r.tt >= 0 ? '+' : ''}${(t[1] - r.tt).toFixed(1)} K against the surface` : '') +
        ` <span class="mini-tip-dim">(${t[2]} flights, ${fmtFt(t[0])})</span>`);
      if (!b && !t) parts.push('<span class="mini-tip-dim">no aircraft at this height</span>');
    }
    const red = blRed(light());
    if (r.llj) parts.push(`<b>low-level jet</b> ${r.llj.kt} kt from ${String(r.llj.dir).padStart(3, '0')}° at ${fmtFt(r.llj.ft)}` +
      ` <span class="mini-tip-dim">(${r.llj.drop} m/s weaker within 1 500 ft above${r.llj.sh != null ? `; shear below ${r.llj.sh} kt / 1 000 ft` : ''})</span>`);
    if (r.inv) parts.push(`<b style="color:${red}">surface inversion</b> +${r.inv.dT.toFixed(1)} K at 600–1 000 ft against the surface` +
      (r.inv.top ? `, warmer up to about ${fmtFt(r.inv.top)}` : ''));
    if (r.avg) {
      parts.push(`low-level jet in <b>${r.avg.llj}</b> of ${r.avg.n} hours${r.avg.llj ? ` (mean ${Math.round(r.avg.kt)} kt)` : ''} · surface inversion in <b>${r.avg.inv}</b> of ${r.avg.n}${r.avg.inv ? ` (mean +${r.avg.dT.toFixed(1)} K)` : ''}`);
      return parts.join('<br>');
    }
    if (ft != null || r.llj || r.inv) parts.push(`<span class="mini-tip-dim">METAR ${r.tt != null ? r.tt + ' °C' : '–'}${r.q ? ' · QNH ' + r.q : ''}${r.partial ? ' · hour in progress' : ''} · research</span>`);
    return parts.length ? parts.join('<br>') : null;
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
    if (geo.mast && my >= geo.mast[0] && my <= geo.mast[0] + geo.mast[1]) return { mx, my, ts, c, mastStrip: true };
    for (const [k, sy, sh] of geo.strips || []) if (my >= sy && my <= sy + sh) return { mx, my, ts, c, xs: k };
    if (my > mt + ph) return { mx, my, ts, c, strip: true };
    if (geo.bl && geo.reps) {                                // a pilot report / SIGMET marker (turbulence field)
      const q = geo.reps.find(q => Math.abs(q.x - mx) <= 6 && (my <= mt + 14 || (q.y0 != null && my >= q.y0 - 2 && my <= q.y1 + 2)));
      if (q) return { mx, my, ts, c, rep: q.r };
    }
    if (geo.bl) return { mx, my, ts, c, blft: (1 - (my - mt) / ph) * blTop() };
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
    const AV = geo.P.avg;
    const when = AV ? `average day · ${pad(d.getUTCHours())}–${pad((d.getUTCHours() + 1) % 24)} UTC` + (h.c && h.c.avgN ? ` <span class="mini-tip-dim">(${h.c.avgN} days)</span>` : '')
      : `${d.getUTCDate()}.${d.getUTCMonth() + 1}. ${pad(d.getUTCHours())}–${pad((d.getUTCHours() + 1) % 24)} UTC`;
    let html;
    const blr = blRows && needBl() ? blIn(geo.P).find(r => r.ts === h.ts) : null;
    const fc = h.blft != null && isFL() && geo.fcols ? geo.fcols.find(c => h.mx >= c.x0 && h.mx < c.x0 + Math.max(c.w, 2)) : null;
    const mr = mastRows && needMast() && !geo.P.avg ? mastRows.find(r => r.ts === h.ts) : null;
    if (h.xs) {
      html = `<b>${when}</b><br>` + stripTip(h.xs, h.ts, h.mx);
    } else if (h.rep) {
      const r = h.rep, rd = new Date(r[0] * 1000);
      html = `<b style="color:${repCol(r[2])}">${r[1] === 'SIGMET' ? 'SIGMET' : 'Pilot report'}${r[2] ? ' · ' + r[2] : ''}</b> · ${rd.getUTCDate()}.${rd.getUTCMonth() + 1}. ${pad(rd.getUTCHours())}:${pad(rd.getUTCMinutes())} UTC` +
        (r[3] != null && r[4] != null ? ` · ${r[3] === r[4] ? fmtFt(r[3]) : fmtFt(r[3]) + '–' + fmtFt(r[4])}` : '') +
        `<br><span class="mini-tip-dim">${String(r[7] || '').replace(/[<>&]/g, ' ')}</span>` +
        (r[3] != null && r[3] >= blTop() ? '<br><span class="mini-tip-dim">above the shown 5 000 ft: marked at its time only</span>' : '');
    } else if (h.mastStrip) {
      html = `<b>${when}</b><br>` + mastTip(mr);
    } else if (h.blft != null && st.field === 'turb') {
      html = `<b>${when}</b> · ${fmtFt(Math.max(0, Math.round(h.blft / 50) * 50))} MSL<br>` + turbTip(geo.P, h.ts, h.blft);
      const bt = blr ? blTip(blr, null) : null;
      if (bt) html += '<br>' + bt;
      const cb = cloudTip(h.ts);
      if (cb) html += '<br>' + cb;
    } else if (fc) {
      html = flTip(fc, h.blft);
      if (blr && (blr.llj || blr.inv)) html += '<br>' + blTip(blr, null);
    } else if (h.blft != null && isFL()) {
      html = `<b>${when}</b> · ${fmtFt(Math.max(0, Math.round(h.blft / 50) * 50))} MSL<br><span class="mini-tip-dim">no landing or departure within 20 min before</span>`;
    } else if (h.blft != null) {
      html = `<b>${when}</b> · ${fmtFt(Math.max(0, Math.round(h.blft / 50) * 50))} MSL<br>` +
        (blTip(blr, h.blft) || '<span class="mini-tip-dim">no boundary-layer data (no flights)</span>');
      { const cb = cloudTip(h.ts); if (cb) html += '<br>' + cb; }
      if (st.mastOv && mr && (st.field === 'blt' || st.field === 'blw')) {
        // the mast level nearest the pointer's height
        const lv = st.field === 'blt' ? mr.tl : mr.wl;
        let k = 0; lv.forEach((m, i) => { if (Math.abs(mastFt(m) - h.blft) < Math.abs(mastFt(lv[k]) - h.blft)) k = i; });
        const ref = st.field === 'blt' ? ((blr || {}).tt ?? mr.t[0]) : null;
        html += `<br><span style="color:${MAST_C(light())}">mast ${lv[k]} m (${fmtFt(Math.round(mastFt(lv[k])))} MSL)</span>: ` +
          (st.field === 'blt' ? `${mr.t[k] != null ? mr.t[k].toFixed(1) + ' °C' : '–'}` + (mr.t[k] != null && ref != null ? ` <span class="mini-tip-dim">(${mr.t[k] - ref >= 0 ? '+' : ''}${(mr.t[k] - ref).toFixed(1)} K against ${blr && blr.tt != null ? 'the METAR' : 'its 2 m'})</span>` : '')
            : `${mr.wd[k] != null ? String(Math.round(mr.wd[k])).padStart(3, '0') + '°' : '–'} ${mr.ws[k] != null ? Math.round(mr.ws[k]) + ' kt' : '–'}`);
      }
    } else if (h.sonde && h.li != null) {
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
    else if (h.c.fc) {
      // the model forecast (from 2026-11-10)
      const { P } = geo, c = h.c, i = h.li;
      const run = ex && ex.fc && ex.fc.run ? new Date(ex.fc.run * 1000) : null;
      const parts = [`<b>${when}</b> · <b style="color:var(--text-2)">MEPS forecast +${c.lead} h</b>` + (i != null ? ` · ${fmtFt(P.layers[i])}–${fmtFt(P.layers[i + 1])}` : '')];
      if (i != null) {
        if (c.T[i] != null) parts.push(`T ${c.T[i].toFixed(1)} °C` + (P.mean[i] != null ? ` · anomaly ${c.T[i] - P.mean[i] >= 0 ? '+' : ''}${(c.T[i] - P.mean[i]).toFixed(1)} K` : '') + ` · θ ${thetaOf(c.T[i], zc(P, i)).toFixed(0)} K`);
        const lv = lapseValue(P, c, i);
        if (lv) parts.push(`lapse rate ${lv.v.toFixed(1)} K/km`);
        if (c.WS[i] != null) parts.push(`wind ${Math.round(c.WD[i])}° ${Math.round(c.WS[i])} kt`);
        if (c.T[i] == null && c.WS[i] == null) parts.push('<span class="mini-tip-dim">outside the model\'s 10 pressure levels (1000–200 hPa)</span>');
      }
      parts.push(`<span class="mini-tip-dim">model area mean on 10 pressure levels${run ? `, run ${run.getUTCDate()}.${run.getUTCMonth() + 1}. ${pad(run.getUTCHours())} UTC` : ''} — a forecast, not a measurement</span>`);
      html = parts.join('<br>');
    }
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
                   (ch != null ? ` · 3 h change ${ch >= 0 ? '+' : ''}${ch.toFixed(1)} K` : '') + ` · θ ${thetaOf(c.T[i], zc(P, i)).toFixed(0)} K` + ` <span class="mini-tip-dim">(${Math.round(c.TN[i])} replies)</span>`);
        if (data && data.tcorr && hi > 18000)
          parts.push(`<span class="mini-tip-dim">upper levels corrected for the fleet's warm bias (learnt from the MEPS model; ${tcorrLevels(data.tcorr)})</span>`);
      }
      const lv = lapseValue(P, c, i);
      if (lv) parts.push(`lapse rate ${lv.v.toFixed(1)} K/km <span class="mini-tip-dim">(${(LAPSE.find(b => lv.v >= b[0] && lv.v < b[1]) || LAPSE[3])[3]})</span>`);
      const vv = vvelValue(P, c, i);
      if (vv) parts.push(`vertical motion ${vv.v >= 0 ? '+' : ''}${vv.v.toFixed(1)} cm/s <span class="mini-tip-dim">(${vv.v >= 0 ? 'rising' : 'sinking'}; advection ${vv.adv >= 0 ? '+' : ''}${vv.adv.toFixed(2)} K/h, local change ${vv.dTdt >= 0 ? '+' : ''}${vv.dTdt.toFixed(2)} K/h${vv.recent ? '; newest hours: less certain' : ''})</span>`);
      if (c.WS[i] != null) parts.push(`wind ${Math.round(c.WD[i])}° ${Math.round(c.WS[i])} kt <span class="mini-tip-dim">(${Math.round(c.WN[i])} replies)</span>`);
      const tv = turnValue(P, c, i);
      if (tv && (st.field === 'turn' || st.field === 'wdir' || Math.abs(tv.turn) >= 10))
        parts.push(`wind ${tv.turn >= 0 ? 'veering' : 'backing'} with height ${tv.turn >= 0 ? '+' : ''}${Math.round(tv.turn)}° from two layers below to two above <span class="mini-tip-dim">(${tv.per >= 0 ? '+' : ''}${tv.per.toFixed(0)}° per 1 000 ft → ${tv.v >= 0 ? 'warm' : 'cold'} advection ${tv.v >= 0 ? '+' : ''}${tv.v.toFixed(2)} K/h${P.layers[i] < 3000 ? '; near the ground friction turns the wind too' : ''})</span>`);
      const md = c.MD && c.MD[i];
      if (md) parts.push(`Mode S − MEPS` + (md.dt != null ? ` T ${md.dt >= 0 ? '+' : ''}${md.dt.toFixed(1)} K` : '') +
        (md.dv != null ? `${md.dt != null ? ' ·' : ''} wind ${md.dv.toFixed(1)} kt (vector), speed ${md.ds >= 0 ? '+' : ''}${md.ds.toFixed(1)} kt` : '') +
        (md.t != null ? ` <span class="mini-tip-dim">(model: ${md.t.toFixed(1)} °C${md.ws != null ? `, ${Math.round(md.wd)}° ${Math.round(md.ws)} kt` : ''}; area mean)</span>` : md.n > 1 ? ` <span class="mini-tip-dim">(mean of ${md.n} hours)</span>` : ''));
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
        ` <span class="mini-tip-dim">(±${mo.se ?? '–'} %${mo.ser != null ? ` — ±${mo.ser} % from the flights, the rest systematic` : ''}; ${mo.n} climbs / descents of ±${mo.lo < 5000 ? 2 : 1} h; Tv − T ${mo.corr >= 0 ? '+' : ''}${mo.corr.toFixed(2)} K after the offsets, ${mo.raw >= 0 ? '+' : ''}${mo.raw.toFixed(2)} K raw)</span>`);
      if (c.bulk && (st.field === 'thk' || tk)) {
        const b = c.bulk;
        parts.push(`<span class="mini-tip-dim">FL100–FL300: ${b.tv.toFixed(1)} °C` + (b.tref != null ? ` vs ${b.tref.toFixed(1)} °C (${b.tv - b.tref >= 0 ? '+' : ''}${(b.tv - b.tref).toFixed(1)} K)` : '') + `, ${b.n} flight${b.n === 1 ? '' : 's'}</span>`);
      }
      if (c.tp != null || c.vm) parts.push(`<span class="mini-tip-dim">` + [c.tp != null ? `tropopause ≈ ${fmtFt(c.tp)}` : null,
        c.vm ? `strongest wind ${Math.round(c.vm.dir)}° ${Math.round(c.vm.kt)} kt at ${fmtFt(c.vm.ft)}` : null].filter(Boolean).join(' · ') + '</span>');
      if (st.bl && blr && (blr.llj || blr.inv) && lo < BL_TOP) parts.push(blTip(blr, null));
      parts.push(`<span class="mini-tip-dim">${c.AC[i] || '–'} aircraft in the layer, ${c.a ?? '–'} in the hour${c.partial ? ' · hour in progress' : AV ? '' : ' · click: open on the Skew-T'}</span>`);
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
    if (h && h.c && !h.c.partial && !h.c.fc && !geo.P.avg && !h.xs && openHour) openHour(h.ts);
  }
  // the METAR cloud base at an hour, for the boundary-layer hover (with "Cloud base")
  function cloudTip(ts) {
    if (!st.cld || !ex || (geo && geo.P.avg)) return null;
    const m = metarAt(ts + 1800);
    if (!m) return null;
    const el = ex.elev || 0;
    return `<span class="mini-tip-dim">METAR: ${m[5] ? 'CAVOK' : m[3] != null ? `ceiling ${fmtFt(m[3] + el)} MSL (${fmtFt(m[3])} above the airport)` : 'no ceiling'}` +
      `${m[4] != null && m[4] !== m[3] ? `, lowest cloud ${fmtFt(m[4] + el)} MSL` : ''}</span>`;
  }

  // ── loading ─────────────────────────────────────────────────────────────
  function endTs() {
    if (!st.endDate) return Math.floor(Date.now() / 1000);
    const [Y, M, D] = st.endDate.split('-').map(Number);
    return Date.UTC(Y, M - 1, D + 1) / 1000;
  }
  async function loadBl() {
    const key = `${st.hours}|${st.endDate}`;
    if (blRows && blKey === key && (st.endDate || Date.now() - blAt < 120000)) return;
    try {
      const r = await fetch(`/api/boundary?hours=${st.hours}&end=${endTs()}`).then(r => r.json());
      blRows = Array.isArray(r) ? r : [];
    } catch (e) { blRows = []; }
    blKey = key; blAt = Date.now();
  }
  async function loadMast() {
    const key = `${st.hours}|${st.endDate}`;
    if (mastRows && mastKey === key && (st.endDate || Date.now() - mastAt < 120000)) return;
    try {
      const r = await fetch(`/api/mast/hourly?hours=${st.hours + 1}&end=${endTs()}`).then(r => r.json());
      mastRows = r.hours || [];
      if (r.station && r.station.elev != null) mastElev = r.station.elev;
    } catch (e) { mastRows = []; }
    mastKey = key; mastAt = Date.now();
  }
  async function loadEx() {
    const key = `${st.hours}|${st.endDate}`;
    if (ex && exKey === key && (st.endDate || Date.now() - exAt < 120000)) return;
    try { ex = await fetch(`/api/sounding/th_extra?hours=${st.hours}&end=${endTs()}`).then(r => r.json()); }
    catch (e) { ex = {}; }
    exKey = key; exAt = Date.now(); exMap = null;
  }
  function blMeta() {
    if (!data) return;
    const meta = $('sounding-meta');
    if (!meta || !isBL()) return;
    if (st.field === 'turb') {
      const P = { start: data.start_ts, end: data.end_ts };
      const hrs = ((ex && ex.turb && ex.turb.hours) || []).filter(r => r[0] >= P.start && r[0] < P.end);
      const mod = hrs.filter(r => r[1].some(c => c[1] >= 0.20)).length;
      const reps = ((ex && ex.reps) || []).filter(r => r[0] >= P.start && r[0] < P.end).length;
      meta.textContent = `Boundary layer · turbulence: ${hrs.length} hours with EDR pieces · moderate or more in ${mod} h` + (ex && ex.reps === null ? '' : ` · ${reps} pilot report${reps === 1 ? '' : 's'} / SIGMETs`) + ' (research)';
      return;
    }
    if (isFL()) {
      const fl = flRows ? flIn({ start: data.start_ts, end: data.end_ts }) : [];
      const na = fl.filter(f => f.k === 'a').length;
      meta.textContent = `Boundary layer, flight by flight: ${na} landings · ${fl.length - na} departures · ` +
        `${fl.filter(f => f.lv && f.lv !== 'none').length} with a windshear level (research)`;
      return;
    }
    const rows = blRows ? blIn({ start: data.start_ts, end: data.end_ts }) : [];
    meta.textContent = `Boundary layer: ${rows.filter(r => (r.w || []).length || (r.t || []).length).length} hours with flights · ` +
      `low-level jet in ${rows.filter(r => r.llj).length} h · surface inversion in ${rows.filter(r => r.inv).length} h (research)`;
  }
  async function load() {
    const req = ++seq;
    const meta = $('sounding-meta');
    // a refresh keeps the previous text, faded, so that the controls bar does not
    // re-wrap and the section does not jump (from 30 Oct 2026); "Loading…" when empty
    if (meta) {
      if (meta.textContent && !/^(Error|Loading)/.test(meta.textContent)) meta.classList.add('meta-loading');
      else meta.textContent = 'Loading…';
    }
    try {
      const [d, s] = await Promise.all([
        fetch(`/api/sounding/timeheight?hours=${st.hours}&end=${endTs()}`).then(r => r.json()),
        sondes.length ? Promise.resolve(null) : fetch('/api/sondes').then(r => r.json()).catch(() => null),
        needBl() ? loadBl() : null,
        isFL() ? loadFl() : null,
        needMast() ? loadMast() : null,
        needEx() ? loadEx() : null,
      ]);
      if (req !== seq) return;
      data = d;
      if (s && s.items) sondes = s.items;
      renderLegend();
      const n = d.cols.length, low = d.cols.filter(c => c.a != null && c.a < 8).length;
      if (meta) meta.textContent = `${n} hourly profiles · ${low} with < 8 aircraft` +
        (d.cols.length && d.cols[d.cols.length - 1].partial ? ' · last column: hour in progress' : '');
      if (meta) meta.classList.remove('meta-loading');
      blMeta();
      render();
    } catch (e) {
      if (meta) { meta.classList.remove('meta-loading'); meta.textContent = 'Error loading the time–height section.'; }
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
    if ($('th-bl')) $('th-bl').checked = st.bl;
    if ($('th-flk')) $('th-flk').value = st.flk;
    if ($('th-mast')) $('th-mast').checked = st.mast;
    if ($('th-mastov')) $('th-mastov').checked = st.mastOv;
    $('th-end').value = st.endDate;
    for (const [id, k] of NEW_CHK) if ($(id)) $(id).checked = st[k];
    syncDisabled();
    renderLegend();
  }
  // the tick boxes of 2026-11-10: [element id, state key, storage key, needs the extras]
  const NEW_CHK = [['th-theta', 'theta', 'ms_th_theta', false], ['th-cld', 'cld', 'ms_th_cld', true], ['th-fc', 'fc', 'ms_th_fc', true],
                   ['th-avg', 'avg', 'ms_th_avg', false], ['th-srwy', 'sRwy', 'ms_th_srwy', true], ['th-swx', 'sWx', 'ms_th_swx', true],
                   ['th-sgnss', 'sGnss', 'ms_th_sgnss', true]];
  function setOff(id, off) {
    const el = $(id);
    if (!el) return;
    el.disabled = off;
    const lab = el.closest('label');
    if (lab) lab.classList.toggle('th-off', off);
  }
  // the overlays that do not apply to the boundary-layer field are greyed out
  function syncDisabled() {
    if ($('th-flk')) { $('th-flk').disabled = !isFL(); $('th-flk').classList.toggle('th-off', !isFL()); }
    for (const id of ['th-iso', 'th-tp', 'th-vmax', 'th-sondecol', 'th-bl']) {
      const el = $(id);
      if (!el) continue;
      el.disabled = isBL();
      const lab = el.closest('label');
      if (lab) lab.classList.toggle('th-off', isBL());
    }
    // from 2026-11-10
    setOff('th-theta', isBL());
    setOff('th-cld', !isBL());
    setOff('th-fc', isBL() || !!st.endDate || isAvg());
    setOff('th-avg', isFL());
    for (const id of ['th-srwy', 'th-swx', 'th-sgnss']) setOff(id, isAvg());
    if (isAvg()) setOff('th-sondecol', true);
  }
  function renderLegend() {
    const el = $('th-legend');
    if (!el) return;
    legendMain(el);
    el.innerHTML += legendExtras();
  }
  const sw = (c, t) => `<span class="th-sw" style="background:${c}"${t ? ` title="${t}"` : ''}></span>`;
  // the notes of the overlays and strips of 2026-11-10
  function legendExtras() {
    const out = [];
    if (isAvg()) out.push('<b>average day</b>: the period folded into the 24 UTC hours (local time = UTC + ' + (-new Date().getTimezoneOffset() / 60) + ' h)');
    if (st.theta && !isBL()) out.push(`<span style="color:${light() ? '#9a3412' : '#fdba74'}">—</span> isentropes (potential temperature, every ${TH_STEP} K)`);
    if (st.fc && useFc()) out.push('right of the dashed line, hatched: <b>MEPS forecast</b> (model, 10 pressure levels)');
    if (st.cld && isBL()) out.push('cloud base (METAR): — ceiling · ┄ lowest cloud');
    if (!isAvg()) {
      if (st.sRwy) out.push('runway: ' + Object.keys(RWY_C).map(r => sw(RWY_C[r], r) + `<span class="th-lt">${r}</span>`).join(' '));
      if (st.sWx) out.push('vis / ceiling: ' + [1, 2, 3].map(k => sw(WXC[k], WXC_T[k])).join('') + ' <span class="th-lt">reduced · low · very low</span> · weather: ' +
        [['#16a34a', 'rain'], ['#86efac', 'drizzle'], ['#e2e8f0', 'snow'], ['#a8a29e', 'fog'], ['#c026d3', 'freezing'], ['#dc2626', 'thunder']].map(([c, t]) => sw(c, t) + `<span class="th-lt">${t}</span>`).join(' '));
      if (st.sGnss) out.push('GNSS: share of aircraft with a degraded position ' + sw('#64748b') + sw('#f59e0b') + sw('#ef4444') + ' <span class="th-lt">&lt; 20 · 20–50 · ≥ 50 %</span>');
    }
    return out.length ? ' <span class="th-lt">· ' + out.join(' · ') + '</span>' : '';
  }
  function legendMain(el) {
    const red = blRed(light());
    const blLeg = `<b>◆</b> low-level jet (kt) · <span style="color:${red}">▬</span> surface inversion (line: its top)`;
    if (st.field === 'turb') {
      el.innerHTML = 'Boundary layer · turbulence of the landings and departures (EDR, median of the hour) ' +
        TURB.map(b => sw(b[1], `EDR ≥ ${b[0]}`) + `<span class="th-lt">${b[2]}</span>`).join(' ') +
        ` <span class="th-lt">(EDR &lt; 0.05, 0.05–0.10, 0.10–0.20, 0.20–0.45, ≥ 0.45)${ex && ex.reps === null ? '' : ' · ▼ pilot report / SIGMET (bar: its heights)'} · ${blLeg} · ▨ no flights · faint: &lt; 3 pieces · research</span>`;
      return;
    }
    if (isFL()) {
      el.innerHTML = (st.field === 'blh'
        ? 'Boundary layer · headwind of each flight along its runway ' +
          `<span class="th-sw" style="background:${hwFill(-8)}" title="tailwind"></span>` +
          [0, 10, 20, 30, 40].map(v => `<span class="th-sw" style="background:${hwFill(v)}" title="${v} kt"></span>`).join('') +
          ' <span class="th-lt">tailwind · 0 · 10 · 20 · 30 · 40 kt</span>'
        : st.field === 'bls'
        ? 'Boundary layer · wind shear of each flight (headwind change with height, ±200 ft) <span class="th-bar"></span> <span class="th-lt">less higher up −3 · ±0.7 · +3 kt per 100 ft more higher up</span>'
        : 'Boundary layer · headwind change against the flights of the previous 45 min (same direction, ±100 ft mean) <span class="th-bar"></span> <span class="th-lt">less −12 · ±2 · +12 kt more</span>') +
        ` <span class="th-lt">· one column per landing / departure (held ≤ 20 min) · top line: landing runway${st.field === 'blh' ? ' (a runway change changes the headwind)' : ''} · ▭ windshear alert (ADV · WSA · MBA) · ${blLeg} · ▨ no flights · research</span>`;
      return;
    }
    if (isBL()) {
      el.innerHTML = (st.field === 'blw'
        ? 'Boundary layer · wind speed ' + [0, 10, 20, 30, 40, 55].map(v => `<span class="th-sw" style="background:${blSpd(v)}" title="${v} kt"></span>`).join('') +
          ' <span class="th-lt">0 · 10 · 20 · 30 · 40 · 55 kt</span>'
        : 'Boundary layer · temperature against the surface (METAR) <span class="th-bar"></span> <span class="th-lt">−6 · 0 · +6 K</span>') +
        ` <span class="th-lt">· ${blLeg} · ▨ no flights · faint: few aircraft · research</span>`;
      return;
    }
    if (st.field === 'wdir') {
      el.innerHTML = 'Wind direction (where the wind blows from) ' +
        ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].map((n, k) => sw(dirFill(k * 45), `${k * 45}°`) + `<span class="th-lt">${n}</span>`).join(' ');
    } else if (st.field === 'turn') {
      el.innerHTML = 'Turning of the wind with height (thermal-wind advection) <span class="th-bar"></span> ' +
        '<span class="th-lt">backing · cold −1 · 0 · +1 K/h warm · veering</span> <span class="th-lt">(below 3 000 ft faint: friction turns the wind too)</span>';
    } else if (st.field === 'cov') {
      el.innerHTML = 'Data coverage: aircraft behind each cell ' + COV.map(b => sw(b[1]) + `<span class="th-lt">${b[2]}</span>`).join(' ');
    } else if (st.field === 'mdt') {
      el.innerHTML = 'Mode S − MEPS · temperature (model area mean at the layer) <span class="th-bar"></span> <span class="th-lt">Mode S colder −3 · 0 · +3 K warmer</span>' +
        ' <span class="th-lt">(above FL180 the Mode S temperatures are corrected with the model, so the difference there is small by construction)</span>';
    } else if (st.field === 'mdw') {
      el.innerHTML = 'Mode S − MEPS · wind (vector difference) ' + [0, 4, 8, 12, 16, 22].map(v => sw(blSpd(v * 2.5), `${v} kt`)).join('') +
        ' <span class="th-lt">0 · 4 · 8 · 12 · 16 · 22 kt</span>';
    } else if (st.field === 'wind') {
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
    if (st.bl) el.innerHTML += ` <span class="th-lt">· boundary layer: ${blLeg}</span>`;
  }

  function tcorrLevels(tc) {
    return Object.keys(tc.corr || {}).map(Number).sort((x, y) => y - x)
      .map(p => `${p} hPa ${tc.corr[p] > 0 ? '+' : ''}${tc.corr[p].toFixed(1)} K`).join(', ');
  }

  function moistNote() {
    const m = data && data.mcal;
    if (!m) return '';
    const n = Math.max(...Object.values(m).map(o => o.n || 0), 0);
    const nm = Math.max(...Object.values(m).map(o => (o.src || '').includes('meps') ? (o.n_meps || 0) : 0), 0);
    if (nm) return ` <span class="th-lt">(offsets from ${nm} hours of the MEPS model humidity — still learning)</span>`;
    return n ? ` <span class="th-lt">(offsets from ${n} sounding${n === 1 ? '' : 's'} — still learning)</span>`
             : ' <span class="th-lt">(no offsets yet)</span>';
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
    // a page without these tick boxes (the phone view) does not take their state from another page's visit
    for (const [id, k] of NEW_CHK) if (!$(id)) st[k] = false;
    syncControls();
    $('th-hours').addEventListener('change', e => { st.hours = parseInt(e.target.value, 10); lsSet('ms_th_hours', st.hours); load(); });
    $('th-field').addEventListener('change', async e => {
      st.field = e.target.value; lsSet('ms_th_field', st.field); syncDisabled(); renderLegend();
      if (needBl()) { await loadBl(); }
      if (isFL()) { await loadFl(); }
      if (needEx()) { await loadEx(); }
      if (data) { const meta = $('sounding-meta'); if (isBL()) blMeta(); else if (meta && meta.textContent.startsWith('Boundary')) load(); }
      render();
    });
    if ($('th-flk')) $('th-flk').addEventListener('change', e => { st.flk = e.target.value; lsSet('ms_th_flk', st.flk); blMeta(); render(); });
    $('th-barbs').addEventListener('change', e => { st.barbs = e.target.checked; lsSet('ms_th_barbs', st.barbs); render(); });
    $('th-iso').addEventListener('change', e => { st.iso = e.target.checked; lsSet('ms_th_iso', st.iso); render(); });
    $('th-tp').addEventListener('change', e => { st.tp = e.target.checked; lsSet('ms_th_tp', st.tp); render(); });
    $('th-vmax').addEventListener('change', e => { st.vmax = e.target.checked; lsSet('ms_th_vmax', st.vmax); render(); });
    $('th-sondecol').addEventListener('change', e => { st.sondeCol = e.target.checked; lsSet('ms_th_sondecol', st.sondeCol); render(); });
    if ($('th-bl')) $('th-bl').addEventListener('change', async e => {
      st.bl = e.target.checked; lsSet('ms_th_bl', st.bl); renderLegend();
      if (st.bl) await loadBl();
      render();
    });
    for (const [id, k, ls] of [['th-mast', 'mast', 'ms_th_mast'], ['th-mastov', 'mastOv', 'ms_th_mastov']])
      if ($(id)) $(id).addEventListener('change', async e => {
        st[k] = e.target.checked; lsSet(ls, st[k]);
        if (needMast()) await loadMast();
        render();
      });
    for (const [id, k, ls, needs] of NEW_CHK)
      if ($(id)) $(id).addEventListener('change', async e => {
        st[k] = e.target.checked; lsSet(ls, st[k]);
        syncDisabled(); renderLegend();
        if (k === 'avg' && needBl()) await loadBl();
        if (needs && needEx()) await loadEx();
        if (isBL()) blMeta();
        render();
      });
    $('th-png').addEventListener('click', savePng);
    $('th-end').addEventListener('change', e => { st.endDate = e.target.value; syncDisabled(); load(); });
    $('th-now').addEventListener('click', () => { st.endDate = ''; $('th-end').value = ''; syncDisabled(); load(); });
    const cv = $('th-canvas');
    cv.addEventListener('mousemove', hover);
    cv.addEventListener('mouseleave', () => { $('th-tip').style.display = 'none'; });
    cv.addEventListener('click', click);
    new ResizeObserver(() => { if ($('th-box').clientWidth) render(); }).observe($('th-box'));
  }

  // open a period from outside (the Calendar view, from 2026-11-10): the UTC day `end` (YYYY-MM-DD) and its length
  function show(o = {}) {
    if (o.hours) { st.hours = o.hours; lsSet('ms_th_hours', st.hours); }
    st.endDate = o.end || '';
    if (o.field && $('th-field') && [...$('th-field').options].some(x => x.value === o.field)) { st.field = o.field; lsSet('ms_th_field', st.field); }
    if (st.avg) { st.avg = false; lsSet('ms_th_avg', false); }
    syncControls();
    return load();
  }

  window.TimeHeight = { init, load, render, renderLegend, show };
})();
