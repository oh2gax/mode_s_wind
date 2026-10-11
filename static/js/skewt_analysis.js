/**
 * skewt_analysis.js — automatic features of an aircraft-derived temperature /
 * wind profile for the Skew-T diagrams (no humidity is available, so only
 * temperature- and wind-based features).
 *
 * Input: layer list as returned by /api/sounding (`levels`): pressure (hPa),
 * altitude (ft, pressure altitude of the layer centre), temp (°C, 10 %
 * trimmed mean), temp_p10 / temp_p90, temp_count, wind_spd (kt), wind_dir,
 * wind_count.
 *
 * analyzeSkewT(levels) returns
 *   trop        {p, alt, t, q}             WMO lapse-rate tropopause (q '?' = marginal data)
 *   isotherms   {0: [{p, alt}], -10: […], -20: […]}   crossings of 0 / −10 / −20 °C
 *   maxWind     {p, alt, spd, dir, jet}    highest wind (jet = ≥ 60 kt)
 *   llj         {p, alt, spd, dir} | null  low-level jet below 5 000 ft
 *   inversions  [{pBot, pTop, altBot, altTop, dT}]
 *   stability   [{pBot, pTop, lapse, cls}] cls: 'unstable' | 'conditional' | 'stable' | 'inversion'
 *   turbulence  [{pBot, pTop, altBot, altTop, shear, ri, cls}]  cls: 'likely' | 'possible'
 *   advection   [{pBot, pTop, adv, turn}]  thermal advection from the wind turning with
 *               height (thermal wind): adv K/h, > 0 warm (veering), < 0 cold (backing)
 *   contrail    {pHumid, altHumid, pDry, altDry}  lowest level where the temperature is
 *               below the Schmidt–Appleman threshold for saturated air (contrails can
 *               form if humid) and for dry air (they form at any humidity)
 *   thermal     {p, alt, agl, tTop, none}  dry thermal top: the surface temperature
 *               (opts.sfc = {p: station pressure, t: °C}) lifted along the dry
 *               adiabat to where it meets the profile; none = stable at the surface;
 *               na = reason when it cannot be computed (no METAR temperature, …)
 *   parcel      (from 2026-10-11, when opts.sfc.td — the METAR dewpoint — is given)
 *               surface parcel: {w (g/kg), spread (T − Td), rh (%), lcl {p, t, agl, alt},
 *               path [[p, °C], …] (dry adiabat to the LCL, moist adiabat above),
 *               lfc {p, alt} | null, el {p, alt, agl} | null, cape, cin (J/kg),
 *               li (K, 500 hPa) | null, cuBase (the dry thermals reach the LCL)}.
 *               Parcel and environment use the plain temperature (no virtual
 *               temperature correction — there is no humidity aloft), so CAPE is
 *               a rough indication; the LCL (Bolton 1980) estimates the base of
 *               cumulus formed from surface air.
 *
 * Temperatures are smoothed lightly (3 layers, weights 1-2-1 × √replies) for
 * the lapse-rate based features; inversions use the layer means with a
 * significance test.  Layer thickness is the true (hypsometric) thickness
 * from the pressures and the measured temperatures, not the pressure-altitude
 * difference.  Validated roughly against Jokioinen soundings 8–10 Oct 2026:
 * tropopause within ~0.5 km, 0 °C level within ~0.6 km.
 */
(function (root) {
  'use strict';
  const RD = 287.04, CP = 1005.7, G = 9.80665, LV = 2.501e6, EPS = 0.622;
  const MIN_T_N = 3, MIN_W_N = 3;          // replies needed per layer

  function es(tc) { return 6.112 * Math.exp(17.67 * tc / (tc + 243.5)); }
  // Saturated (moist) adiabatic lapse rate, K/km, at p (hPa) and t (°C)
  function moistLapse(p, tc) {
    const tk = tc + 273.15, e = es(tc), rs = EPS * e / Math.max(p - e, 1);
    const dTdp = (RD * tk + LV * rs) / (p * (CP + LV * LV * rs * EPS / (RD * tk * tk)));
    return dTdp * p * G / (RD * tk) * 1000;
  }
  // Moist adiabat as dT/dp (K/hPa) at p (hPa) and tk (K)
  function moistDTdp(p, tk) {
    const e = es(tk - 273.15), rs = EPS * e / Math.max(p - e, 1);
    return (RD * tk + LV * rs) / (p * (CP + LV * LV * rs * EPS / (RD * tk * tk)));
  }
  // True thickness (m) between two pressures with mean temperature tMean (°C)
  function thick(pLo, pHi, tMean) { return RD * (tMean + 273.15) / G * Math.log(pLo / pHi); }
  function uv(spd, dir) { const r = dir * Math.PI / 180; return [-spd * Math.sin(r), -spd * Math.cos(r)]; }
  // Interpolate the pressure where t crosses tc between two layers (log-p)
  function crossP(a, b, tc) {
    const f = (tc - a.t) / (b.t - a.t);
    return Math.exp(Math.log(a.p) + f * (Math.log(b.p) - Math.log(a.p)));
  }
  function pToAltFt(p) { return (1 - Math.pow(p / 1013.25, 0.190263)) * 145366.45; }

  // ── Schmidt–Appleman contrail thresholds (Schumann 1996) ─────────────────
  // G = EI·cp·p / (ε·Q·(1−η)) [Pa/K]; kerosene EI(H2O) 1.25, Q 43.2 MJ/kg,
  // overall propulsion efficiency η 0.3.  T_LM: threshold for air saturated
  // with respect to water; T_LC: threshold for dry air (T_LM − e_s(T_LM)/G).
  function contrailThresholds(p) {
    const Gp = 1.25 * 1004 * p * 100 / (EPS * 43.2e6 * (1 - 0.3));
    const x = Math.log(Gp - 0.053);
    const tLM = -46.46 + 9.43 * x + 0.720 * x * x;
    const tLC = tLM - es(tLM) * 100 / Gp;
    return { tLM, tLC };
  }

  function analyzeSkewT(levels, opts = {}) {
    const lat = opts.lat != null ? opts.lat : 60.3;
    const out = { trop: null, isotherms: { 0: [], '-10': [], '-20': [] }, maxWind: null, llj: null,
                  inversions: [], stability: [], turbulence: [], advection: [], contrail: null,
                  thermal: null };
    if (!levels || !levels.length) { out.thermal = { na: 'no area profile data' }; return out; }
    const L = levels.slice().sort((a, b) => b.pressure - a.pressure);   // surface first

    // ── Temperature layers (enough replies), lightly smoothed ──────────────
    const T = L.filter(l => l.temp != null && (l.temp_count || 0) >= MIN_T_N)
               .map(l => ({ p: l.pressure, alt: l.altitude, raw: l.temp, n: l.temp_count,
                            se: l.temp_p10 != null ? Math.max(0.3, (l.temp_p90 - l.temp_p10) / 2.56 / Math.sqrt(l.temp_count)) : 1 }));
    T.forEach((l, i) => {
      let sw = 0, st = 0;
      [[-1, 1], [0, 2], [1, 1]].forEach(([j, k]) => {
        const m = T[i + j]; if (!m) return;
        const w = k * Math.sqrt(m.n); sw += w; st += w * m.raw;
      });
      l.t = st / sw;
    });
    // Height above the lowest layer (true, hypsometric), m
    if (T.length) {
      T[0].z = 0;
      for (let i = 1; i < T.length; i++) T[i].z = T[i - 1].z + thick(T[i - 1].p, T[i].p, (T[i - 1].t + T[i].t) / 2);
    }

    // ── Tropopause (WMO): lowest level above 5 km (pressure altitude) where the
    //    lapse rate is ≤ 2 K/km and stays ≤ 2 K/km on average over the next 2 km
    for (let i = 0; i < T.length - 1; i++) {
      if (T[i].alt < 16400) continue;
      const lapse = -(T[i + 1].t - T[i].t) / ((T[i + 1].z - T[i].z) / 1000);
      if (lapse > 2) continue;
      let ok = true, covered = 0;
      for (let j = i + 1; j < T.length && T[j].z - T[i].z <= 2000; j++) {
        covered = T[j].z - T[i].z;
        if (-(T[j].t - T[i].t) / ((T[j].z - T[i].z) / 1000) > 2) { ok = false; break; }
      }
      if (!ok) continue;
      out.trop = { p: T[i].p, alt: T[i].alt, t: T[i].t,
                   q: (covered >= 1200 && T[i].n >= 10) ? 'ok' : '?' };
      break;
    }

    // ── Isotherm crossings 0 / −10 / −20 °C (smoothed profile) ─────────────
    //    A crossing pair enclosing an excursion of less than 1 K from the
    //    isotherm (noise around it) is dropped, so only a real warm / cold
    //    layer aloft gives a second crossing.
    for (const tc of [0, -10, -20]) {
      let cr = [];
      for (let i = 0; i < T.length - 1; i++) {
        const a = T[i], b = T[i + 1];
        if ((a.t - tc) * (b.t - tc) < 0) {
          const p = crossP(a, b, tc);
          cr.push({ p, alt: pToAltFt(p), i, dir: b.t < a.t ? 'down' : 'up' });
        }
      }
      let changed = true;
      while (changed && cr.length > 1) {
        changed = false;
        for (let k = 0; k < cr.length - 1; k++) {
          let ext = 0;
          for (let m = cr[k].i + 1; m <= cr[k + 1].i; m++) ext = Math.max(ext, Math.abs(T[m].t - tc));
          if (ext < 1.0) { cr.splice(k, 2); changed = true; break; }
        }
      }
      out.isotherms[tc] = cr.map(({ p, alt, dir }) => ({ p, alt, dir }));
    }

    // ── Inversions (layer means, significance-tested) ──────────────────────
    for (let i = 0; i < T.length - 1; ) {
      let j = i;
      while (j + 1 < T.length && T[j + 1].raw > T[j].raw) j++;
      if (j > i) {
        const dT = T[j].raw - T[i].raw;
        const noise = 2 * Math.hypot(T[i].se, T[j].se);
        const belowTrop = !out.trop || T[i].p > out.trop.p;      // stratosphere is an inversion anyway
        if (dT >= Math.max(1.0, noise) && belowTrop)
          out.inversions.push({ pBot: T[i].p, pTop: T[j].p, altBot: T[i].alt, altTop: T[j].alt, dT });
        i = j;
      } else i++;
    }

    // ── Stability between consecutive layers (smoothed), vs dry / moist adiabats
    for (let i = 0; i < T.length - 1; i++) {
      const a = T[i], b = T[i + 1], dz = (b.z - a.z) / 1000;
      if (dz <= 0) continue;
      const lapse = -(b.t - a.t) / dz;
      const gm = moistLapse((a.p + b.p) / 2, (a.t + b.t) / 2);
      const cls = lapse < -0.5 ? 'inversion' : lapse > 9.8 + 0.7 ? 'unstable'
                : lapse > gm + 0.5 ? 'conditional' : 'stable';
      out.stability.push({ pBot: a.p, pTop: b.p, lapse, gm, cls });
    }

    // ── Wind: max wind / jet, low-level jet ────────────────────────────────
    const W = L.filter(l => l.wind_spd != null && l.wind_dir != null && (l.wind_count || 0) >= MIN_W_N)
               .map(l => ({ p: l.pressure, alt: l.altitude, spd: l.wind_spd, dir: l.wind_dir,
                            se: (l.wind_sd != null ? l.wind_sd : 5) / Math.sqrt(l.wind_count) }));
    if (W.length) {
      const m = W.reduce((a, b) => (b.spd > a.spd ? b : a));
      out.maxWind = { ...m, jet: m.spd >= 60 };
      const low = W.filter(w => w.alt < 5000);
      if (low.length) {
        const c = low.reduce((a, b) => (b.spd > a.spd ? b : a));
        const above = W.filter(w => w.alt > c.alt && w.alt <= c.alt + 4000);
        if (c.spd >= 25 && above.length && Math.min(...above.map(w => w.spd)) <= c.spd - 10)
          out.llj = c;
      }
    }

    // ── Turbulence: vertical shear and bulk Richardson number ──────────────
    const tAt = p => {                       // smoothed temperature at p (log-p interpolation)
      for (let i = 0; i < T.length - 1; i++)
        if (T[i].p >= p && p >= T[i + 1].p) {
          const f = (Math.log(p) - Math.log(T[i].p)) / (Math.log(T[i + 1].p) - Math.log(T[i].p));
          return T[i].t + f * (T[i + 1].t - T[i].t);
        }
      return null;
    };
    for (let i = 0; i < W.length - 1; i++) {
      const a = W[i], b = W[i + 1];
      const ta = tAt(a.p), tb = tAt(b.p);
      if (ta == null || tb == null) continue;
      const dz = thick(a.p, b.p, (ta + tb) / 2);
      if (dz <= 0 || dz > 1500) continue;      // only adjacent layers
      const [ua, va] = uv(a.spd, a.dir), [ub, vb] = uv(b.spd, b.dir);
      const dV = Math.hypot(ub - ua, vb - va);                 // kt
      const shear = dV / (dz / 304.8);                         // kt per 1000 ft
      const thA = (ta + 273.15) * Math.pow(1000 / a.p, RD / CP), thB = (tb + 273.15) * Math.pow(1000 / b.p, RD / CP);
      const N2 = G / ((thA + thB) / 2) * (thB - thA) / dz;
      const S2 = Math.pow(dV * 0.514444 / dz, 2);
      const ri = S2 > 0 ? N2 / S2 : Infinity;
      // Shear must exceed twice the uncertainty of the two vector means
      // (SD/√n), otherwise sampling noise alone could create it
      if (dV < 2 * Math.hypot(a.se, b.se)) continue;
      const cls = (ri < 0.5 && shear >= 4) ? 'likely'
                : ((ri < 1 && shear >= 4) || shear >= 8) ? 'possible' : null;
      if (cls) out.turbulence.push({ pBot: a.p, pTop: b.p, altBot: a.alt, altTop: b.alt, shear, ri, cls });
    }

    // ── Thermal advection from the turning of the wind (thermal wind) ──────
    //    −V̄·∇T = −f/(R·ln(p1/p2)) · (u1·v2 − v1·u2): veering with height →
    //    warm advection, backing → cold.  Geostrophic balance assumed, so the
    //    friction layer (below 850 hPa) is left out.  Winds at the band edges
    //    are interpolated (log-p) between adjacent layers.
    const windAt = p => {
      for (let i = 0; i < W.length - 1; i++)
        if (W[i].p >= p && p >= W[i + 1].p && W[i + 1].alt - W[i].alt <= 4000) {
          const f = (Math.log(p) - Math.log(W[i].p)) / (Math.log(W[i + 1].p) - Math.log(W[i].p));
          const [u1, v1] = uv(W[i].spd, W[i].dir), [u2, v2] = uv(W[i + 1].spd, W[i + 1].dir);
          return { u: u1 + f * (u2 - u1), v: v1 + f * (v2 - v1), se: Math.max(W[i].se, W[i + 1].se) };
        }
      return null;
    };
    const fCor = 2 * 7.292e-5 * Math.sin(lat * Math.PI / 180);
    for (const [p1, p2] of [[850, 700], [700, 500], [500, 400], [400, 300], [300, 250]]) {
      const w1 = windAt(p1), w2 = windAt(p2);
      if (!w1 || !w2) continue;
      const s1 = Math.hypot(w1.u, w1.v), s2 = Math.hypot(w2.u, w2.v);
      if (s1 < 10 || s2 < 10) continue;                       // direction too uncertain
      const cross = w1.u * w2.v - w1.v * w2.u;                // kt²
      let turn = (Math.atan2(w2.u, w2.v) - Math.atan2(w1.u, w1.v)) * 180 / Math.PI;   // + = clockwise (veering)
      turn = ((turn + 540) % 360) - 180;
      const dV = Math.hypot(w2.u - w1.u, w2.v - w1.v);
      if (Math.abs(turn) < 10 || dV < 2 * Math.hypot(w1.se, w2.se)) continue;
      const adv = -fCor / (RD * Math.log(p1 / p2)) * cross * 0.514444 * 0.514444 * 3600;   // K/h
      if (Math.abs(adv) < 0.2) continue;
      out.advection.push({ pBot: p1, pTop: p2, adv, turn });
    }

    // ── Contrail formation levels (temperature only; persistence needs ice
    //    supersaturation, which is not known) ────────────────────────────────
    for (const l of T) {
      if (l.p > 500) continue;
      const th = contrailThresholds(l.p);
      if (!out.contrail && l.t < th.tLM) out.contrail = { pHumid: l.p, altHumid: l.alt, pDry: null, altDry: null };
      if (out.contrail && out.contrail.pDry == null && l.t < th.tLC) { out.contrail.pDry = l.p; out.contrail.altDry = l.alt; }
    }

    // ── Dry thermal top: surface parcel along the dry adiabat (θ constant)
    //    until it is no longer warmer than the (smoothed) profile.  Without a
    //    dewpoint the cloud base is unknown, so this is the top of dry
    //    thermals / the daytime mixing height, meaningful when the surface is
    //    heated (by night a stable surface layer gives "none").
    const sfc = opts.sfc;
    if (!sfc || !sfc.p || sfc.t == null) out.thermal = { na: 'no METAR temperature' };
    else {
      const th0 = (sfc.t + 273.15) * Math.pow(1000 / sfc.p, RD / CP);
      const parcel = p => th0 * Math.pow(p / 1000, RD / CP) - 273.15;
      const up = T.filter(l => l.p < sfc.p - 5);           // layers above the ground
      if (up.length < 2) out.thermal = { na: 'too few low-level temperatures' };
      else {
        let prev = { p: sfc.p, d: 0.0001 };
        for (const l of up) {
          const d = parcel(l.p) - l.t;
          if (d <= 0) {
            const first = prev.p === sfc.p;
            const f = first ? 0 : prev.d / (prev.d - d);   // first layer already warmer → none
            const p = Math.exp(Math.log(prev.p) + f * (Math.log(l.p) - Math.log(prev.p)));
            const tTop = parcel(p);
            out.thermal = first
              ? { none: true, p: sfc.p }
              : { p, alt: pToAltFt(p), tTop, agl: thick(sfc.p, p, (sfc.t + tTop) / 2) / 0.3048, none: false };
            break;
          }
          prev = { p: l.p, d };
        }
        if (!out.thermal) out.thermal = { na: 'surface air warmer than the whole profile' };
      }
    }

    // ── Surface parcel with the METAR dewpoint (from 2026-10-11) ───────────
    //    LCL (Bolton 1980), dry adiabat to the LCL and moist adiabat above,
    //    compared with the profile: LFC, EL, CAPE / CIN and the 500 hPa
    //    Lifted Index.  The environment is the METAR surface temperature at
    //    the station pressure and the (smoothed) layers above the ground.
    if (sfc && sfc.p && sfc.t != null && sfc.td != null && sfc.td <= sfc.t + 0.5) {
      const td = Math.min(sfc.td, sfc.t);
      const T0 = sfc.t + 273.15, Td0 = td + 273.15, p0 = sfc.p;
      const e0 = es(td);
      const par = { w: 1000 * EPS * e0 / (p0 - e0), spread: sfc.t - td,
                    rh: 100 * e0 / es(sfc.t), lfc: null, el: null, cape: 0, cin: 0, li: null };
      const TL = 1 / (1 / (Td0 - 56) + Math.log(T0 / Td0) / 800) + 56;
      const pL = p0 * Math.pow(TL / T0, CP / RD);
      par.lcl = { p: pL, t: TL - 273.15, alt: pToAltFt(pL),
                  agl: thick(p0, pL, (sfc.t + TL - 273.15) / 2) / 0.3048 };
      // parcel path, 5 hPa steps (RK2 on the moist adiabat)
      const path = [];
      for (let p = p0; p > pL; p -= 5) path.push([p, T0 * Math.pow(p / p0, RD / CP) - 273.15]);
      path.push([pL, TL - 273.15]);
      let p = pL, tk = TL;
      while (p > 150) {
        const dp = -Math.min(5, p - 150);
        const k1 = moistDTdp(p, tk), k2 = moistDTdp(p + dp, tk + k1 * dp);
        tk += 0.5 * (k1 + k2) * dp; p += dp;
        path.push([p, tk - 273.15]);
      }
      par.path = path;
      // environment: surface + layers above the ground, interpolated in log p
      const env = [{ p: p0, t: sfc.t }].concat(T.filter(l => l.p < p0 - 5).map(l => ({ p: l.p, t: l.t })));
      par.env = env;
      const envT = pp => {
        for (let i = 0; i < env.length - 1; i++) {
          const a = env[i], b = env[i + 1];
          if (pp <= a.p && pp >= b.p) {
            const f = (Math.log(pp) - Math.log(a.p)) / (Math.log(b.p) - Math.log(a.p));
            return a.t + f * (b.t - a.t);
          }
        }
        return null;
      };
      // buoyancy along the path; CAPE = positive area above the LFC up to the
      // EL, CIN = negative area between the surface and the LFC
      let prevB = null, negBelow = 0, posArea = 0, top = null;
      for (let i = 1; i < path.length; i++) {
        const [pa, ta] = path[i - 1], [pb, tb] = path[i];
        const ea = envT(pa), eb = envT(pb);
        if (ea == null || eb == null) { top = pa; break; }
        const ba = ta - ea, bb = tb - eb;
        const area = RD * ((ba + bb) / 2) * Math.log(pa / pb);      // J/kg
        if (bb > 0 && pb <= pL + 0.01) {
          if (!par.lfc) {
            const f = ba < 0 ? ba / (ba - bb) : 0;
            const pf = Math.exp(Math.log(pa) + f * (Math.log(pb) - Math.log(pa)));
            par.lfc = { p: pf, alt: pToAltFt(pf) };
            par.cin = negBelow;
          }
          if (par.lfc) { posArea += Math.max(area, 0); par.el = null; }
        } else if (bb <= 0 && par.lfc && !par.el && prevB > 0) {
          const f = ba / (ba - bb);
          const pe = Math.exp(Math.log(pa) + f * (Math.log(pb) - Math.log(pa)));
          par.el = { p: pe, alt: pToAltFt(pe) };
          posArea += Math.max(area * f, 0);
          par.cape = posArea;
          break;                                  // the first positive area only
        } else if (!par.lfc) negBelow += Math.min(area, 0);
        prevB = bb;
      }
      if (par.lfc && !par.el) {                    // still buoyant at the profile top
        par.cape = posArea;
        par.el = top != null ? { p: top, alt: pToAltFt(top), open: true } : null;
      }
      if (!par.lfc) par.cin = negBelow;
      if (par.el) par.el.agl = thick(p0, par.el.p, (sfc.t + (envT(par.el.p) ?? sfc.t)) / 2) / 0.3048;
      // Lifted Index at 500 hPa
      const e5 = envT(500);
      if (e5 != null) {
        let t5 = null;
        for (let i = 1; i < path.length; i++)
          if (path[i][0] <= 500) { const [pa, ta] = path[i - 1], [pb, tb] = path[i];
            t5 = ta + (tb - ta) * (Math.log(500 / pa) / Math.log(pb / pa)); break; }
        if (t5 != null) par.li = e5 - t5;
      }
      // do the dry thermals from the surface reach the LCL (cumulus base)?
      par.cuBase = !!(out.thermal && !out.thermal.na && !out.thermal.none && out.thermal.p <= pL);
      out.parcel = par;
    }
    return out;
  }

  root.analyzeSkewT = analyzeSkewT;
  root.skewtMoistLapse = moistLapse;
  root.skewtContrailThresholds = contrailThresholds;
  root.skewtEs = es;
  if (typeof module !== 'undefined') module.exports = { analyzeSkewT, moistLapse, contrailThresholds };
})(typeof window !== 'undefined' ? window : globalThis);
