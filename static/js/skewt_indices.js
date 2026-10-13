/**
 * skewt_indices.js — stability indices and characteristic levels of a
 * profile, for the Sounding page's Indices panel.  The same function is run
 * on the Mode S area profile and on the radiosonde, so the two columns are
 * directly comparable.
 *
 * skewtIndices(levels, opts) → { rows: {key: {v, txt, cls, tip, na}}, info }
 *
 *   levels  layer list in the /api/sounding naming (pressure, altitude, temp,
 *           temp_count, temp_p10 / p90, wind_spd, wind_dir, wind_count,
 *           wind_sd, and for a sonde dewpoint)
 *   opts    { sfc: {p, t, td, elev (ft), qnh}  surface point (METAR / sonde),
 *             lat, humid: true when the levels carry dewpoints (sonde),
 *             top: highest pressure level reached (hPa; partial sondes) }
 *
 * sondeLayers(sondeLevels) averages a full-resolution sounding into the
 * Mode S layers (1 000 ft below 10 000 ft, 2 000 ft above, by pressure
 * altitude) — the same vertical resolution as the aircraft profile, so the
 * comparison shows measurement differences rather than resolution.
 *
 * Built on analyzeSkewT (skewt_analysis.js): tropopause, isotherms,
 * inversions, max wind / low-level jet, turbulence, thermal advection,
 * contrail levels, dry thermal top and the surface parcel (LCL, LFC, EL,
 * CAPE, CIN, Lifted Index).  Added here: CCL and convective temperature,
 * temperatures at 850 / 700 / 500 hPa, lapse rates, 1000–500 hPa thickness,
 * Vertical Totals, bulk wind shear, and with dewpoints aloft (sonde only)
 * Showalter, K index, Total Totals and precipitable water.  Heights are
 * hypsometric from the surface point (ft above ground / above mean sea
 * level); without a surface point only flight levels are given.  Plain
 * temperature throughout (no virtual-temperature correction), as for the
 * aircraft, which report no humidity.
 */
(function (root) {
  'use strict';
  const RD = 287.04, CP = 1005.7, G = 9.80665, LV = 2.501e6, EPS = 0.622;
  const analyze = root.analyzeSkewT || (typeof require !== 'undefined' ? require('./skewt_analysis.js').analyzeSkewT : null);

  const es = tc => 6.112 * Math.exp(17.67 * tc / (tc + 243.5));
  const tdFromE = e => { const l = Math.log(e / 6.112); return 243.5 * l / (17.67 - l); };
  const thick = (pLo, pHi, tMean) => RD * (tMean + 273.15) / G * Math.log(pLo / pHi);
  const pToAltFt = p => (1 - Math.pow(p / 1013.25, 0.190263)) * 145366.45;
  const altToP = ft => 1013.25 * Math.pow(1 - ft / 145366.45, 1 / 0.190263);
  const uv = (spd, dir) => { const r = dir * Math.PI / 180; return [-spd * Math.sin(r), -spd * Math.cos(r)]; };
  const dirOf = (u, v) => (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
  function moistDTdp(p, tk) {
    const e = es(tk - 273.15), rs = EPS * e / Math.max(p - e, 1);
    return (RD * tk + LV * rs) / (p * (CP + LV * LV * rs * EPS / (RD * tk * tk)));
  }
  // Parcel from (p0, t0, td0) lifted to pEnd: dry to the LCL (Bolton 1980), moist above
  function liftParcel(p0, t0, td0, pEnd) {
    const T0 = t0 + 273.15, Td0 = Math.min(td0, t0) + 273.15;
    const TL = 1 / (1 / (Td0 - 56) + Math.log(T0 / Td0) / 800) + 56;
    const pL = p0 * Math.pow(TL / T0, CP / RD);
    if (pEnd >= pL) return T0 * Math.pow(pEnd / p0, RD / CP) - 273.15;
    let p = pL, tk = TL;
    while (p > pEnd + 1e-6) {
      const dp = -Math.min(5, p - pEnd);
      const k1 = moistDTdp(p, tk), k2 = moistDTdp(p + dp, tk + k1 * dp);
      tk += 0.5 * (k1 + k2) * dp; p += dp;
    }
    return tk - 273.15;
  }
  // log-p interpolation of key over a surface-first list; with maxGapFt no
  // interpolation across a data gap deeper than that (pressure altitude)
  function atP(list, p, key, maxGapFt) {
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i], b = list[i + 1];
      if (a[key] == null || b[key] == null) continue;
      if (a.p >= p && p >= b.p) {
        if (maxGapFt && pToAltFt(b.p) - pToAltFt(a.p) > maxGapFt) return null;
        const f = a.p === b.p ? 0 : Math.log(p / a.p) / Math.log(b.p / a.p);
        return a[key] + f * (b[key] - a[key]);
      }
    }
    return null;
  }

  // ── Sonde → Mode S layers ──────────────────────────────────────────────
  const LAYER_EDGES = (() => {
    const e = [];
    for (let a = 0; a < 10000; a += 1000) e.push([a, a + 1000]);
    for (let a = 10000; a < 46000; a += 2000) e.push([a, a + 2000]);
    return e;
  })();
  function sondeLayers(levels) {
    const out = [];
    const L = (levels || []).filter(l => l.pressure != null);
    if (!L.length) return out;
    const top = Math.min(...L.map(l => l.pressure));
    for (const [lo, hi] of LAYER_EDGES) {
      const mid = (lo + hi) / 2, pMid = altToP(mid);
      if (pMid < top) break;                          // layer centre above the sonde's top
      const sel = L.filter(l => { const a = pToAltFt(l.pressure); return a >= lo && a < hi; });
      if (!sel.length) continue;
      const tv = sel.filter(l => l.temp != null), dv = sel.filter(l => l.dewpoint != null);
      const wv = sel.filter(l => l.wind_spd != null && l.wind_dir != null);
      const lay = { pressure: pMid, altitude: mid };
      if (tv.length) {
        const t = tv.reduce((s, l) => s + l.temp, 0) / tv.length;
        Object.assign(lay, { temp: t, temp_count: 10, temp_p10: t - 1.2, temp_p90: t + 1.2 });
      }
      if (dv.length) lay.dewpoint = dv.reduce((s, l) => s + l.dewpoint, 0) / dv.length;
      if (wv.length) {
        let su = 0, sv = 0;
        for (const l of wv) { const [u, v] = uv(l.wind_spd, l.wind_dir); su += u; sv += v; }
        su /= wv.length; sv /= wv.length;
        Object.assign(lay, { wind_spd: Math.hypot(su, sv), wind_dir: dirOf(su, sv), wind_count: 10, wind_sd: 3 });
      }
      out.push(lay);
    }
    return out;
  }

  // ── Indices ────────────────────────────────────────────────────────────
  function skewtIndices(levels, opts = {}) {
    const rows = {};
    const sfc = opts.sfc && opts.sfc.p && opts.sfc.t != null ? opts.sfc : null;
    const humid = !!opts.humid;
    const topP = opts.top || null;
    const set = (k, v, txt, extra = {}) => { rows[k] = Object.assign({ v, txt }, extra); };
    const na = (k, why) => { rows[k] = { v: null, txt: '–', na: why }; };
    const NO_HUM = 'needs humidity aloft — aircraft report none';
    const NO_SFC = opts.noSfc || 'needs the METAR surface temperature / dewpoint';
    const ABOVE = topP ? `above the top of the sounding (${Math.round(topP)} hPa)` : 'outside the profile';

    const L = (levels || []).filter(l => l.pressure != null).slice().sort((a, b) => b.pressure - a.pressure);
    const tl = L.filter(l => l.temp != null && (l.temp_count || 0) >= 3 && (!sfc || l.pressure < sfc.p - 5));
    const A = analyze ? analyze(L, { lat: opts.lat, sfc: sfc ? { p: sfc.p, t: sfc.t, td: sfc.td } : null }) : {};

    // environment (surface first) with hypsometric height z (m above the surface)
    const env = (sfc ? [{ p: sfc.p, t: sfc.t, td: sfc.td }] : [])
      .concat(tl.map(l => ({ p: l.pressure, t: l.temp, td: l.dewpoint != null ? l.dewpoint : null, alt: l.altitude })));
    if (env.length) {
      env[0].z = 0;
      for (let i = 1; i < env.length; i++) env[i].z = env[i - 1].z + thick(env[i - 1].p, env[i].p, (env[i - 1].t + env[i].t) / 2);
    }
    const hasZ = !!sfc;                                // heights above ground only with a surface point
    const zAt = p => {
      if (!env.length) return null;
      if (p > env[0].p) return null;
      return atP(env, p, 'z');
    };
    const elevFt = sfc && sfc.elev != null ? sfc.elev : null;
    const aglFt = p => { const z = zAt(p); return z == null ? null : z / 0.3048; };
    const ft = v => `${(Math.round(v / 100) * 100).toLocaleString('en-US')} ft`;
    const fl = alt => `FL${String(Math.max(0, Math.round(alt / 100))).padStart(3, '0')}`;
    // height of a pressure level for display: ft AMSL with a surface point, else flight level
    const hText = (p, alt) => {
      if (hasZ && elevFt != null) { const a = aglFt(p); if (a != null) return ft(a + elevFt); }
      return fl(alt != null ? alt : pToAltFt(p));
    };
    const MAX_GAP_FT = 4500;                         // one missing 2 000 ft layer is bridged, no more
    const tAt = p => atP(env, p, 't', MAX_GAP_FT);
    const tdAt = p => atP(env, p, 'td', MAX_GAP_FT);
    const inRange = p => env.length && p <= env[0].p && p >= env[env.length - 1].p;
    // a data gap deeper than MAX_GAP_FT anywhere between the pressures pHi > pLo
    const gapBetween = (pHi, pLo) => {
      for (let i = 0; i < env.length - 1; i++) {
        const a = env[i], b = env[i + 1];
        if (b.p <= pHi && a.p >= pLo && pToAltFt(b.p) - pToAltFt(a.p) > MAX_GAP_FT) return true;
      }
      return false;
    };

    // ── Surface & parcel ─────────────────────────────────────────────────
    if (sfc) set('sfc', sfc.t, `${sfc.t.toFixed(1)} / ${sfc.td != null ? sfc.td.toFixed(1) : '–'}`,
                 { tip: `${Math.round(sfc.p)} hPa${sfc.src ? ' · ' + sfc.src : ''}` });
    else na('sfc', opts.noSfc || 'no surface observation with this profile');
    const P = A.parcel;
    if (P) {
      set('lcl', P.lcl.agl, ft(P.lcl.agl), { tip: `${Math.round(P.lcl.p)} hPa, ${P.lcl.t.toFixed(1)} °C · RH at the surface ${Math.round(P.rh)} %` });
      if (P.lfc) { const a = aglFt(P.lfc.p); set('lfc', a, a != null ? ft(a) : fl(P.lfc.alt), { tip: `${Math.round(P.lfc.p)} hPa` }); }
      else set('lfc', null, 'none', { tip: 'the surface parcel never becomes warmer than the air around it' });
      if (P.el) set('el', P.el.alt, fl(P.el.alt) + (P.el.open ? '+' : ''), { tip: `${Math.round(P.el.p)} hPa${P.el.open ? ' — still buoyant at the top of the profile' : ''}` });
      else set('el', null, 'none');
      set('cape', P.cape, `${Math.round(P.cape)}`, { cls: P.cape >= 1000 ? 'alert' : P.cape >= 100 ? 'warn' : '' });
      if (P.lfc) set('cin', P.cin, `${Math.round(P.cin)}`);
      else na('cin', 'no LFC — the parcel is never buoyant');
      if (P.li != null) set('li', P.li, `${P.li >= 0 ? '+' : ''}${P.li.toFixed(1)}`, { cls: P.li <= -5 ? 'alert' : P.li <= -1 ? 'warn' : '' });
      else na('li', ABOVE);
    } else {
      const why = sfc ? (sfc.td == null ? 'no surface dewpoint' : 'no profile above the surface') : NO_SFC;
      ['lcl', 'lfc', 'el', 'cape', 'cin', 'li'].forEach(k => na(k, why));
    }
    // CCL and convective temperature: mixing-ratio line through the surface dewpoint
    if (sfc && sfc.td != null && env.length > 2) {
      const e0 = es(sfc.td), w0 = EPS * e0 / (sfc.p - e0);
      const tdw = p => tdFromE(w0 * p / (EPS + w0));
      let ccl = null;
      for (let i = 1; i < env.length; i++) {
        const a = env[i - 1], b = env[i];
        const da = a.t - tdw(a.p), db = b.t - tdw(b.p);
        if (db <= 0 && da > 0) {
          const f = da / (da - db);
          const p = Math.exp(Math.log(a.p) + f * Math.log(b.p / a.p));
          ccl = { p, t: tAt(p) };
          break;
        }
        if (b.p < 300) break;
      }
      if (ccl && ccl.t != null) {
        const tc = (ccl.t + 273.15) * Math.pow(sfc.p / ccl.p, RD / CP) - 273.15;
        const a = aglFt(ccl.p);
        set('ccl', a, `${ft(a)} · ${tc.toFixed(0)}°`, { tip: `CCL ${Math.round(ccl.p)} hPa; convective temperature ${tc.toFixed(1)} °C (surface temperature needed for cumulus from surface heating; now ${sfc.t.toFixed(1)} °C)`,
                                                    cls: sfc.t >= tc - 0.5 ? 'warn' : '' });
      } else na('ccl', 'no crossing below 300 hPa');
    } else na('ccl', sfc ? 'no surface dewpoint' : NO_SFC);
    // dry thermal top
    const Th = A.thermal;
    if (Th && !Th.na) set('thermal', Th.none ? 0 : Th.agl, Th.none ? 'stable sfc' : ft(Th.agl),
                          { tip: Th.none ? 'the surface air is colder than the air above it (stable surface layer)' : `${Math.round(Th.p)} hPa${P && P.cuBase ? ' — reaches the LCL: cumulus base' : ''}` });
    else na('thermal', Th && Th.na ? Th.na : NO_SFC);

    // standard levels
    const T850 = inRange(850) ? tAt(850) : null, T700 = inRange(700) ? tAt(700) : null, T500 = inRange(500) ? tAt(500) : null;
    const gapOr = p => inRange(p) ? 'data gap in the profile' : ABOVE;
    const Td850 = humid && inRange(850) ? tdAt(850) : null, Td700 = humid && inRange(700) ? tdAt(700) : null, Td500 = humid && inRange(500) ? tdAt(500) : null;
    const lvl = (k, t, td, p) => {
      if (t == null) { na(k, env.length && p < env[env.length - 1].p ? ABOVE : env.length && p <= env[0].p ? 'data gap in the profile' : 'below the ground or no data'); return; }
      set(k, t, humid ? `${t.toFixed(1)} / ${td != null ? td.toFixed(1) : '–'}` : t.toFixed(1), { tip: humid ? 'temperature / dewpoint °C' : 'temperature °C' });
    };
    lvl('t850', T850, Td850, 850); lvl('t700', T700, Td700, 700); lvl('t500', T500, Td500, 500);

    if (T850 != null && T500 != null) set('vt', T850 - T500, (T850 - T500).toFixed(1), { cls: T850 - T500 >= 30 ? 'warn' : '' });
    else na('vt', T850 == null ? gapOr(850) : gapOr(500));
    if (humid) {
      if (T850 != null && T500 != null && Td850 != null) {
        const tt = (T850 - T500) + (Td850 - T500);
        set('tt', tt, tt.toFixed(0), { cls: tt >= 50 ? 'alert' : tt >= 44 ? 'warn' : '' });
        const si = T500 - liftParcel(850, T850, Td850, 500);
        set('si', si, `${si >= 0 ? '+' : ''}${si.toFixed(1)}`, { cls: si <= -3 ? 'alert' : si <= 0 ? 'warn' : '' });
        if (T700 != null && Td700 != null) {
          const k = (T850 - T500) + Td850 - (T700 - Td700);
          set('kidx', k, k.toFixed(0), { cls: k >= 31 ? 'alert' : k >= 26 ? 'warn' : '' });
        } else na('kidx', 'no 700 hPa values');
      } else ['tt', 'si', 'kidx'].forEach(k => na(k, ABOVE));
      // precipitable water, surface – 300 hPa (or the top)
      const hum = env.filter(l => l.td != null && l.p >= 300);
      if (hum.length > 3) {
        let pw = 0;
        for (let i = 1; i < hum.length; i++) {
          const w = l => EPS * es(l.td) / (l.p - es(l.td));
          pw += (w(hum[i - 1]) + w(hum[i])) / 2 * (hum[i - 1].p - hum[i].p) * 100 / G;
        }
        set('pw', pw, pw.toFixed(1), { tip: `surface – ${Math.round(hum[hum.length - 1].p)} hPa` });
      } else na('pw', 'too few dewpoints');
    } else ['tt', 'si', 'kidx', 'pw'].forEach(k => na(k, NO_HUM));

    // ── Levels ───────────────────────────────────────────────────────────
    const iso = (k, tc) => {
      const cr = (A.isotherms && A.isotherms[tc]) || [];
      const first = cr[0];
      if (!first) {
        if (sfc && sfc.t <= tc) set(k, 0, 'surface', { tip: `the surface is at or below ${tc} °C` });
        else na(k, env.length ? `no ${tc} °C crossing within the profile` : 'no data');
        return;
      }
      const more = cr.length > 1 ? ` (+${cr.length - 1})` : '';
      set(k, first.alt, hText(first.p, first.alt) + more,
          { tip: `${Math.round(first.p)} hPa, ${fl(first.alt)}` + (cr.length > 1 ? ` · further crossings: ${cr.slice(1).map(c => fl(c.alt)).join(', ')} (warm / cold layer aloft)` : '') });
    };
    iso('fz', 0); iso('m10', -10); iso('m20', -20);
    if (A.trop) set('trop', A.trop.alt, `${fl(A.trop.alt)} · ${Math.round(A.trop.t)}°`,
                    { tip: `${Math.round(A.trop.p)} hPa (WMO lapse-rate definition)${A.trop.q === '?' ? ' — marginal data above it' : ''}` });
    else na('trop', env.length && env[env.length - 1].p > 250 ? ABOVE : 'no tropopause found within the profile');
    if (A.contrail) set('con', A.contrail.altHumid, `${fl(A.contrail.altHumid)} / ${A.contrail.altDry != null ? fl(A.contrail.altDry) : '–'}`,
                        { tip: 'lowest level where contrails form if the air is humid / at any humidity (Schmidt–Appleman); they persist only in ice-supersaturated air' });
    else na('con', 'not cold enough within the profile');

    // ── Lapse rates & thickness ─────────────────────────────────────────
    const lapse = (k, pA, pB) => {
      const ta = tAt(pA), tb = tAt(pB), za = zAt(pA), zb = zAt(pB);
      if (ta == null || tb == null || za == null || zb == null || !inRange(pA) || !inRange(pB)) { na(k, !inRange(pA) ? 'below the ground or no data' : gapOr(ta == null ? pA : pB)); return; }
      const g = (ta - tb) / ((zb - za) / 1000);
      set(k, g, g.toFixed(1), { cls: g >= 9.0 ? 'alert' : g >= 7.0 ? 'warn' : '' });
    };
    // the reference height for 850–500 / 700–500 needs no surface: integrate from the lowest layer
    if (!hasZ && env.length) { /* env z from the lowest layer — fine for lapse rates */ }
    lapse('lr85', 850, 500); lapse('lr75', 700, 500);
    if (hasZ) {
      // lowest 3 km above the ground
      let t3 = null, gap3 = false;
      for (let i = 1; i < env.length; i++) if (env[i].z >= 3000) {
        const a = env[i - 1], b = env[i], f = (3000 - a.z) / (b.z - a.z);
        t3 = a.t + f * (b.t - a.t); gap3 = gapBetween(env[0].p, b.p); break;
      }
      if (gap3) na('lr03', 'data gap in the profile');
      else if (t3 != null) { const g = (sfc.t - t3) / 3; set('lr03', g, g.toFixed(1), { cls: g >= 9.0 ? 'alert' : g >= 7.0 ? 'warn' : '', tip: 'surface – 3 km above the ground' }); }
      else na('lr03', 'profile does not reach 3 km');
    } else na('lr03', NO_SFC);
    // 1000–500 hPa thickness (hypsometric; below-ground part from the surface temperature)
    if (env.length && inRange(500) || (env.length && env[env.length - 1].p <= 500)) {
      const z500 = zAt(500);
      let z1000 = null;
      if (env[0].p >= 1000) z1000 = zAt(1000);
      else if (sfc) z1000 = -thick(1000, sfc.p, sfc.t + 0.3);
      if (gapBetween(Math.max(1000, env[0].p), 500)) na('thk', 'data gap in the profile');
      else if (z500 != null && z1000 != null) {
        const dam = (z500 - z1000) / 10;
        set('thk', dam, `${Math.round(dam)}`, { tip: sfc && sfc.p < 1000 ? '1000 hPa below the ground: extended with the surface temperature' : '' });
      } else na('thk', 'no surface / 1000 hPa level');
    } else na('thk', ABOVE);

    // ── Wind ─────────────────────────────────────────────────────────────
    const W = L.filter(l => l.wind_spd != null && l.wind_dir != null && (l.wind_count || 0) >= 3)
               .map(l => { const [u, v] = uv(l.wind_spd, l.wind_dir);
                           const h = hasZ && zAt(l.pressure) != null ? zAt(l.pressure) : (l.altitude - (sfc ? pToAltFt(sfc.p) : L[0].altitude)) * 0.3048;
                           return { p: l.pressure, alt: l.altitude, h, u, v, spd: l.wind_spd, dir: l.wind_dir }; })
               .filter(w => w.h > -100);
    const base = W.find(w => w.h <= 460);            // lowest wind within ~1 500 ft of the ground
    const windAtH = h => {
      for (let i = 0; i < W.length - 1; i++) {
        const a = W[i], b = W[i + 1];
        if (a.h <= h && h <= b.h && b.h - a.h <= 1300) {
          const f = (h - a.h) / (b.h - a.h);
          return { u: a.u + f * (b.u - a.u), v: a.v + f * (b.v - a.v) };
        }
      }
      return null;
    };
    for (const [k, km] of [['sh1', 1], ['sh3', 3], ['sh6', 6]]) {
      const w = base ? windAtH(km * 1000) : null;
      if (!w) { na(k, base ? (W.length && W[W.length - 1].h < km * 1000 ? ABOVE : 'gap in the winds') : 'no wind near the ground'); continue; }
      const s = Math.hypot(w.u - base.u, w.v - base.v);
      set(k, s, `${Math.round(s)}`, { cls: k === 'sh6' && s >= 40 ? 'warn' : k === 'sh1' && s >= 20 ? 'warn' : '',
                                         tip: `vector difference from the lowest layer (about ${Math.round(base.h / 0.3048 / 100) * 100} ft above the ground)` });
    }
    if (A.maxWind) set('maxw', A.maxWind.spd, `${String(Math.round(A.maxWind.dir)).padStart(3, '0')}°/${Math.round(A.maxWind.spd)} ${fl(A.maxWind.alt)}`,
                       { cls: A.maxWind.spd >= 100 ? 'warn' : '', tip: A.maxWind.jet ? 'jet stream (≥ 60 kt)' : '' });
    else na('maxw', 'no winds');
    if (A.llj) set('llj', A.llj.spd, `${Math.round(A.llj.spd)} ${fl(A.llj.alt)}`, { tip: 'low-level jet below 5 000 ft: ≥ 25 kt and ≥ 10 kt stronger than above' });
    else set('llj', null, 'none');
    const inv = (A.inversions || []);
    if (inv.length) {
      const i0 = inv[0];
      set('inv', i0.dT, `${fl(i0.altBot)}–${fl(i0.altTop).slice(2)} +${i0.dT.toFixed(1)} K`,
          { tip: inv.map(x => `${hText(x.pBot, x.altBot)} – ${hText(x.pTop, x.altTop)}: +${x.dT.toFixed(1)} K`).join('\n') + (inv.length > 1 ? `\n(${inv.length} inversions)` : '') });
    } else set('inv', null, 'none');
    const tu = (A.turbulence || []);
    if (tu.length) {
      const worst = tu.slice().sort((a, b) => a.ri - b.ri)[0];
      set('turb', tu.length, `${tu.length} · ${fl(worst.altBot)}–${fl(worst.altTop).slice(2)}`,
          { cls: tu.some(t => t.cls === 'likely') ? 'warn' : '',
            tip: tu.map(t => `${fl(t.altBot)}–${fl(t.altTop)}: shear ${t.shear.toFixed(1)} kt/1000 ft, Ri ${isFinite(t.ri) ? t.ri.toFixed(2) : '∞'} (${t.cls})`).join('\n') });
    } else set('turb', 0, 'none');
    const adv = (A.advection || []);
    if (adv.length) {
      const a0 = adv.slice().sort((a, b) => Math.abs(b.adv) - Math.abs(a.adv))[0];
      set('adv', a0.adv, `${a0.adv > 0 ? '+' : ''}${a0.adv.toFixed(1)} (${a0.pBot}–${a0.pTop})`,
          { tip: (a0.adv > 0 ? 'warm' : 'cold') + ' advection\n' + adv.map(a => `${a.pBot}–${a.pTop} hPa: ${a.adv > 0 ? '+' : ''}${a.adv.toFixed(1)} K/h (wind turning ${a.turn > 0 ? '+' : ''}${Math.round(a.turn)}°)`).join('\n') });
    } else set('adv', null, 'none');

    // data gaps (deeper than MAX_GAP_FT) in the temperature profile
    const gaps = [];
    for (let i = 1; i < tl.length; i++) {
      const a0 = tl[i - 1].altitude, a1 = tl[i].altitude;
      if (a1 - a0 > MAX_GAP_FT) gaps.push([a0, a1]);
    }
    return { rows, info: { layers: tl.length, top: env.length ? env[env.length - 1].p : null,
                           gaps: gaps.map(([a0, a1]) => `${fl(a0)}–${fl(a1)}`) } };
  }

  // Row definitions for the panel: [group, key, label, explanation]
  const ROWS = [
    ['Surface & parcel', 'sfc', 'Surface T / Td (°C)', 'Surface temperature / dewpoint: METAR (Mode S column) or the sonde\'s surface values'],
    [null, 'lcl', 'LCL (AGL)', 'Lifting condensation level: where surface air lifted dry-adiabatically saturates — the base of cumulus formed from surface air (Bolton 1980)'],
    [null, 'ccl', 'CCL (AGL) · T conv', 'Convective condensation level: where the mixing-ratio line through the surface dewpoint meets the profile; the convective temperature is the surface temperature needed for cumulus from surface heating alone (amber: reached)'],
    [null, 'thermal', 'Dry thermal top (AGL)', 'Surface temperature lifted along the dry adiabat until it meets the profile — top of dry thermals / mixing height'],
    [null, 'lfc', 'LFC (AGL)', 'Level of free convection of the surface parcel'],
    [null, 'el', 'EL', 'Equilibrium level of the surface parcel (approximate cloud top of free convection)'],
    [null, 'cape', 'CAPE (J/kg)', 'Convective available potential energy of the surface parcel (plain temperature; amber ≥ 100, red ≥ 1000 J/kg)'],
    [null, 'cin', 'CIN (J/kg)', 'Convective inhibition: energy needed to lift the surface parcel to its LFC'],
    [null, 'li', 'Lifted Index', 'Profile minus surface parcel temperature at 500 hPa; negative = unstable (amber ≤ −1, red ≤ −5)'],
    [null, 'si', 'Showalter', 'Like the Lifted Index but for an 850 hPa parcel (needs the 850 hPa dewpoint; amber ≤ 0, red ≤ −3)'],
    [null, 'kidx', 'K index', '(T850 − T500) + Td850 − (T700 − Td700): air-mass thunderstorm potential (amber ≥ 26, red ≥ 31)'],
    [null, 'tt', 'Total Totals', 'VT + (Td850 − T500) (amber ≥ 44, red ≥ 50)'],
    [null, 'vt', 'Vertical Totals', 'T850 − T500: the temperature part of Total Totals — available from the aircraft (amber ≥ 30)'],
    [null, 'pw', 'Precip. water (mm)', 'Precipitable water: all the water vapour of the column, surface – 300 hPa'],
    ['Levels', 'fz', '0 °C level', 'Freezing level (ft above mean sea level, hypsometric from the surface; FL without a surface point); (+n) further crossings'],
    [null, 'm10', '−10 °C level', '−10 °C level (icing / cloud glaciation)'],
    [null, 'm20', '−20 °C level', '−20 °C level'],
    [null, 'trop', 'Tropopause', 'WMO lapse-rate tropopause: lowest level above 5 km where the lapse rate falls to ≤ 2 K/km for at least 2 km'],
    [null, 'con', 'Contrails humid / any', 'Lowest level of contrail formation if the air is saturated / at any humidity (Schmidt–Appleman)'],
    ['Lapse rates & thickness', 'lr03', 'Lapse 0–3 km (K/km)', 'Temperature lapse rate, surface – 3 km above the ground (amber ≥ 7, red ≥ 9 K/km; dry adiabat 9.8)'],
    [null, 'lr85', 'Lapse 850–500 (K/km)', 'Lapse rate 850–500 hPa (amber ≥ 7 K/km: steep mid-level lapse rates)'],
    [null, 'lr75', 'Lapse 700–500 (K/km)', 'Lapse rate 700–500 hPa'],
    [null, 'thk', '1000–500 hPa (dam)', 'Thickness of the 1000–500 hPa layer from the temperatures (dam); about 528 dam is a common rain / snow divide'],
    [null, 't850', 'T 850 hPa (°C)', 'Temperature (sonde: / dewpoint) at 850 hPa'],
    [null, 't700', 'T 700 hPa (°C)', 'Temperature (sonde: / dewpoint) at 700 hPa'],
    [null, 't500', 'T 500 hPa (°C)', 'Temperature (sonde: / dewpoint) at 500 hPa'],
    ['Wind', 'sh1', 'Shear 0–1 km (kt)', 'Bulk wind shear: vector difference between the wind 1 km above the ground and the lowest layer'],
    [null, 'sh3', 'Shear 0–3 km (kt)', 'Bulk wind shear 0–3 km'],
    [null, 'sh6', 'Shear 0–6 km (kt)', 'Bulk wind shear 0–6 km (amber ≥ 40 kt: organised convection possible)'],
    [null, 'maxw', 'Max wind (kt)', 'Strongest wind of the profile (jet ≥ 60 kt)'],
    [null, 'llj', 'Low-level jet (kt)', 'Wind maximum below 5 000 ft'],
    [null, 'inv', 'Lowest inversion', 'Lowest significant inversion (base–top, temperature rise); hover for all'],
    [null, 'turb', 'Turbulence layers', 'Layers with turbulence risk from the shear and the Richardson number; hover for the list'],
    [null, 'adv', 'Advection (K/h)', 'Strongest warm / cold advection from the wind turning with height (thermal wind)'],
  ];

  root.skewtIndices = skewtIndices;
  root.skewtSondeLayers = sondeLayers;
  root.SKEWT_INDEX_ROWS = ROWS;
  if (typeof module !== 'undefined') module.exports = { skewtIndices, sondeLayers, ROWS };
})(typeof window !== 'undefined' ? window : globalThis);
