/**
 * skewt_chart.js — the Skew-T diagram of the Live Map Atmosphere Profile,
 * shared with the Sounding page (from 2026-10-11).
 *
 *   const chart = createSkewT(canvas, tipElement, { lat: 60.3 });
 *   chart.set({ area, low, aptMode, anaLevel, smooth, sfc, ac, density,
 *               acLabel, profileTitle, hint, dq, sonde, sondeRef });
 *   chart.resize(width, height);  chart.draw();
 *   canvas.addEventListener('mousemove', ev => chart.hover(ev));
 *
 *   area     /api/sounding-style profile {levels, window_min} — the main profile
 *   low      /api/lowlevel airport low-level profile (or null)
 *   aptMode  'off' | 'overlay' | 'zoom'     anaLevel  0–5 (Off … Full)
 *   smooth   0 / 1 / 2 (Off / 3 / 5 layers) sfc  METAR ground point or null
 *   ac       Live Map aircraft overlay {alt_ft, temp_c, pressure, color,
 *            windHistory} or null;  density: aircraft point thinning
 *   acLabel / profileTitle  hover titles;  hint  text at the top (null =
 *            the Live Map default, '' = none)
 *   dq       data-validity indicator on/off (badge, rings on 1–2-aircraft
 *            layers, hover warning); default on
 *   sonde    radiosonde from /api/sonde ({levels, launch, min_p, station…})
 *            or null;  sondeRef: time its age is counted to (null = now)
 *   meps     MEPS model profile from /api/meps/profile ({found, levels, run,
 *            lead, provisional…}) or null — teal lines and barbs
 *   rh       RH strip on/off: a narrow strip between the plot and the wind
 *            barbs with the trial moisture indicator (moist = the "moisture"
 *            of /api/sounding?moist=1 or /api/sounding/hour, collector/
 *            moisture.py: index ≈ RH of 1 000–5 000, 5 000–10 000 and
 *            10 000–15 000 ft), the sonde's relative humidity as a line and
 *            (with meps) the model's relative humidity as a teal line
 *
 * Needs skewt_analysis.js (analyzeSkewT, skewtMoistLapse,
 * skewtContrailThresholds) loaded first.
 */

// ── ISA helpers (global: also used by live_map.js) ───────────────────────────────────────────────────────────
function altToPressHPa(alt_ft) {
  const m = alt_ft * 0.3048;
  if (m <= 11000) return 1013.25 * Math.pow(1 - 0.0065 * m / 288.15, 5.2561);
  return 226.32 * Math.exp(-0.0001577 * (m - 11000));
}
// METAR surface point for the diagrams: station pressure from the QNH and
// the field elevation, temperature, dewpoint (from 2026-10-11) and the
// lowest cloud group.  o: {qnh, t, td, elev, station, time, cld}
function skewtSfcPoint(o) {
  if (!o || !o.qnh || o.qnh < 900 || o.qnh > 1100) return null;
  const elev = o.elev != null ? Number(o.elev) : 179;
  const p = o.qnh * Math.pow(1 - 2.25577e-5 * elev * 0.3048, 5.25588);   // QNH → station pressure
  return { p, qnh: o.qnh, t: o.t != null ? o.t : null,
           td: o.td != null && o.t != null && o.td <= o.t + 0.5 ? o.td : null,
           elev, station: o.station || '', time: o.time || '', cld: o.cld || null };
}
// /api/wx response → surface point (METAR text parsed here)
function parseMetarSfc(d) {
  const m = d && d.metar || '';
  const qnh = d && d.qnh_hpa != null ? Number(d.qnh_hpa) : (() => {
    const q = m.match(/\sQ(\d{4})\b/); if (q) return Number(q[1]);
    const a = m.match(/\sA(\d{4})\b/); return a ? Number(a[1]) * 0.338639 : null;
  })();
  const tm = m.match(/\s(M?\d{2})\/(M?\d{2}|\/\/)?(?=\s|$)/);
  const cv = g => g[0] === 'M' ? -Number(g.slice(1)) : Number(g);
  const t  = tm ? cv(tm[1]) : null;
  const td = tm && tm[2] && tm[2] !== '//' ? cv(tm[2]) : null;
  const cl = m.match(/\b((?:FEW|SCT|BKN|OVC)\d{3}(?:CB|TCU)?|VV\d{3}|CAVOK|NSC|NCD|SKC|CLR)\b/);
  const st = m.match(/\b([A-Z]{4})\s\d{6}Z/), tt = m.match(/\s(\d{2})(\d{2})(\d{2})Z\s/);
  return skewtSfcPoint({ qnh, t, td, elev: d && d.elev_ft, station: st ? st[1] : '',
                         time: tt ? `${tt[2]}:${tt[3]}Z` : '', cld: cl ? cl[1] : null });
}
// Lowest cloud group → text with the base in ft, e.g. "BKN008" → "BKN 800 ft"
function skewtCloudText(c) {
  if (!c) return '';
  const m = c.match(/^(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?$/);
  return m ? `${m[1]} ${(Number(m[2]) * 100).toLocaleString()} ft${m[3] ? ' ' + m[3] : ''}` : c;
}

function isaTempP(p_hPa) {
  // ISA temperature (°C) at a given pressure (hPa)
  if (p_hPa >= 226.32) return 288.15 * Math.pow(p_hPa / 1013.25, 0.19026) - 273.15;
  return -56.5;
}


function createSkewT(canvas, tip, cfg = {}) {
  const LAT = cfg.lat != null ? cfg.lat : 60.3;
  // State, set by the page with set()
  let miniArea = null, miniLow = null, aptMode = 'off', anaLevel = 0, areaSmooth = 0,
      miniSfc = null, miniSfcLink = null, miniAcOverlay = null, windDensity = 2,
      acLabel = 'Aircraft', profileTitle = 'Area, last 60 min', hintText = null,
      dqShow = true,      // data-validity indicator (badge, rings, hover warning)
      miniSonde = null,   // radiosonde (/api/sonde) or null
      sondeRef = null,    // time (Unix s) the sonde age is counted to; null = now
      sondeNote = null,   // "no sounding" text when switched on but none found
      miniMeps = null,    // MEPS model profile (/api/meps/profile) or null
      mepsNote = null,    // "no model data" text when switched on but none found
      rhOn = false,       // RH strip (trial moisture indicator + sonde RH)
      miniMoist = null;   // {rows: [[lo, hi, index, ±, flights, Tv−T corr, raw]], window_h, offsets_n}
  const RH_W = 46;        // strip width (px) when on
  let stripW = 0;
  let miniHoverPts = [];   // [{y, src, alt_ft, p, t, ws, wd, n…}] rebuilt on every draw
  let topOff = 0;          // extra offset of the top-left texts when the data badge is shown

  // ── Mini Skew-T geometry ──────────────────────────────────────────────────
  // Canvas sized to the right panel (resizeMiniCanvas).  Log-pressure Y, skewed temperature X.
  const MSK = {
    W: 362, H: 346,
    ML: 30, MR: 112, MT: 14, MB: 22,
    TL: -40, TR: 40,   // temperature range °C at the bottom (skewed: −60 … −40 °C fit at 200–300 hPa)
    PT: 200, PB: 1050, // pressure range hPa
    SK: 0.38,          // skew factor (higher = more tilt)
  };
  MSK.PW = MSK.W - MSK.ML - MSK.MR;
  MSK.PH = MSK.H - MSK.MT - MSK.MB;

  function mskY(p) {
    const lt = Math.log(MSK.PT), lb = Math.log(MSK.PB);
    return MSK.MT + MSK.PH * (Math.log(p) - lt) / (lb - lt);
  }
  function mskX(t, p) {
    const base = MSK.ML + MSK.PW * (t - MSK.TL) / (MSK.TR - MSK.TL);
    const skew = MSK.PH * (Math.log(MSK.PB) - Math.log(p)) /
                          (Math.log(MSK.PB) - Math.log(MSK.PT));
    return base + skew * MSK.SK;
  }

  // ── Dry and moist (saturated pseudo-) adiabats ────────────────────────────
  // Reference curves only; they need no humidity data.  Dry: T = θ·(p/1000)^κ.
  // Moist: dT/dp = (Rd·T + Lv·rs) / (p·(cp + Lv²·rs·ε/(Rd·T²))), integrated
  // from 1000 hPa (start = wet-bulb potential temperature θw).
  const ADI_RD = 287.04, ADI_CP = 1005.7, ADI_LV = 2.501e6, ADI_EPS = 0.622;
  function adiEs(tc) { return 6.112 * Math.exp(17.67 * tc / (tc + 243.5)); }   // hPa
  function adiMoistRate(p, tk) {
    const es = adiEs(tk - 273.15), rs = ADI_EPS * es / Math.max(p - es, 1);
    return (ADI_RD * tk + ADI_LV * rs) /
           (p * (ADI_CP + ADI_LV * ADI_LV * rs * ADI_EPS / (ADI_RD * tk * tk)));
  }
  const _adiCache = {};
  function adiabatCurves(pTop, pBot, thetaDryK, thetaWetC) {
    const key = [pTop, pBot, thetaDryK.join(), thetaWetC.join()].join('|');
    if (_adiCache[key]) return _adiCache[key];
    const ps = [];
    for (let p = pBot; p >= pTop; p -= 10) ps.push(p);
    if (ps[ps.length - 1] !== pTop) ps.push(pTop);
    const dry = thetaDryK.map(th => ps.map(p => [p, th * Math.pow(p / 1000, ADI_RD / ADI_CP) - 273.15]));
    const moist = thetaWetC.map(tw => {
      const integ = (from, to, step) => {        // RK2 in pressure, returns [[p, °C], …]
        const out = []; let p = from, t = tw + 273.15;
        out.push([p, t - 273.15]);
        while ((step < 0 && p > to) || (step > 0 && p < to)) {
          const dp = step < 0 ? Math.max(step, to - p) : Math.min(step, to - p);
          const k1 = adiMoistRate(p, t), k2 = adiMoistRate(p + dp, t + k1 * dp);
          t += 0.5 * (k1 + k2) * dp; p += dp;
          out.push([p, t - 273.15]);
        }
        return out;
      };
      const up = integ(1000, pTop, -5), down = integ(1000, pBot, 5);
      return down.reverse().concat(up.slice(1));
    });
    return (_adiCache[key] = { dry, moist });
  }

  // ── Mini wind barb (scaled for small canvas) ──────────────────────────────
  // color defaults to grey for area sounding barbs; pass aircraft colour for overlays.
  function drawMiniBarb(ctx, x, y, speedKt, dirFrom, color = '#94a3b8') {
    if (speedKt == null || dirFrom == null) return;
    const spd   = Math.round(speedKt / 5) * 5;
    const angle = dirFrom * Math.PI / 180;  // staff points FROM wind direction (met convention)
    const sLen  = 14;
    const ex    = x + sLen * Math.sin(angle);
    const ey    = y - sLen * Math.cos(angle);

    ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();

    let rem = spd, pos = 0;
    const step = 3;

    while (rem >= 50) {
      const sx = ex - pos * Math.sin(angle), sy = ey + pos * Math.cos(angle);
      const tx = sx + 7 * Math.cos(angle),  ty = sy + 7 * Math.sin(angle);
      const mx = sx + step * Math.sin(angle), my = sy - step * Math.cos(angle);
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(tx, ty); ctx.lineTo(mx, my);
      ctx.closePath(); ctx.fill();
      pos += step + 1; rem -= 50;
    }
    while (rem >= 10) {
      const sx = ex - pos * Math.sin(angle), sy = ey + pos * Math.cos(angle);
      const px = sx + 7 * Math.cos(angle),  py = sy + 7 * Math.sin(angle);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(px, py); ctx.stroke();
      pos += step; rem -= 10;
    }
    if (rem >= 5) {
      const sx = ex - pos * Math.sin(angle), sy = ey + pos * Math.cos(angle);
      const px = sx + 4 * Math.cos(angle),  py = sy + 4 * Math.sin(angle);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(px, py); ctx.stroke();
    }
  }


  // ── Theme-aware colour palette for mini Skew-T canvas ────────────────────
  // Dark theme: the panel colour (--bg-1 #162030) as background since
  // 23 Oct 2026 (before #0c1620); the faint grid lines one step lighter with it.
  function miniSkewTTheme() {
    const light = document.documentElement.dataset.theme === 'light';
    return {
      bg:        light ? '#eef2f7' : '#162030',
      isobarMaj: light ? '#c5d0da' : '#28344a',
      isobarMin: light ? '#d8e0e8' : '#212a40',
      isotherm0: light ? '#9ab4c8' : '#28446f',
      isothermN: light ? '#cdd7e0' : '#222a40',
      isotLabel: light ? '#64748b' : '#414b61',
      axisLine:  light ? '#94a3b8' : '#374962',
      isa:       light ? '#9ab4c8' : '#28446f',
      label:     light ? '#475569' : '#414b61',
      hint:      light ? '#64748b' : '#414b61',
      dotRing:   light ? '#1e293b' : '#ffffff',
      kmLabel:   light ? '#94a3b8' : '#45556e',
      area:      light ? '#64748b' : '#94a3b8',
      tempLbl:   light ? '#1e293b' : '#e2e8f0',
      dryAdi:    light ? '#e2c3a0' : '#5e4c37',
      ground:    light ? '#8b6f4e' : '#7c6345',
      anaTrop:   light ? '#7c3aed' : '#a78bfa',
      anaZero:   light ? '#0284c7' : '#38bdf8',
      anaIso:    light ? '#64748b' : '#7dd3fc',
      anaWind:   light ? '#b45309' : '#fbbf24',
      anaInv:    light ? '#ea580c' : '#fb923c',
      anaWarm:   light ? '#dc2626' : '#f87171',
      anaCold:   light ? '#2563eb' : '#60a5fa',
      anaCon:    light ? '#475569' : '#cbd5e1',
      anaTherm:  light ? '#c2410c' : '#fdba74',
      anaLblBg:  light ? 'rgba(238,242,247,0.85)' : 'rgba(22,32,48,0.85)',
      apt:       light ? '#b45309' : '#f59e0b',      // airport low-level profile
      stUnst:    '#ef4444', stCond: '#f59e0b', stStab: '#22c55e', stInv: '#a855f7',
      groundLbl: light ? '#6b5137' : '#b08d62',
      moistAdi:  light ? '#a9d4b7' : '#346050',
      dew:       light ? '#15803d' : '#4ade80',      // METAR dewpoint, mixing-ratio line
      weak:      light ? '#dc2626' : '#f87171',      // layer from only 1–2 aircraft
      dqGood:    light ? '#15803d' : '#4ade80', dqFair: light ? '#b45309' : '#fbbf24', dqLow: light ? '#dc2626' : '#f87171',
      cape:      light ? 'rgba(220,38,38,0.13)' : 'rgba(248,113,113,0.16)',
      sonde:     light ? '#be185d' : '#f472b6',      // radiosonde (Jokioinen)
      sondeOld:  light ? '#b45309' : '#fbbf24',      // its label when older than 12 h
      meps:      light ? '#0e7490' : '#22d3ee',      // MEPS model profile
    };
  }

  // Diagram range: full troposphere, or the lowest ~5 000 ft in zoom mode
  function applyMskRange() {
    // (zoom: less skew — over 200 hPa the full skew would push the profile
    //  against the right edge)
    if (aptMode === 'zoom') Object.assign(MSK, { PT: 840, PB: 1040, TL: -12, TR: 26, SK: 0.15 });
    else                    Object.assign(MSK, { PT: 200, PB: 1050, TL: -40, TR: 40, SK: 0.38 });
  }

  // Airport profile as levels for analyzeSkewT: altitude = MSL (labels in ft MSL)
  function lowLevelsForAnalysis() {
    if (!miniLow || !miniLow.levels) return [];
    return miniLow.levels.map(l => ({ ...l, altitude: l.alt_msl }));
  }

  // Lapse rate of the airport profile in 600 ft slabs (weighted linear fit of
  // the 200 ft band temperatures, ≥ 3 bands with ≥ 3 flights) — the single
  // 200 ft steps are too noisy for a stability class of their own.
  function lowStabilitySlabs() {
    const out = [];
    if (!miniLow || !miniLow.levels) return out;
    const L = miniLow.levels.filter(l => l.temp != null && (l.temp_count || 0) >= 3);
    for (let lo = 200; lo < 3000; lo += 600) {
      const s = L.filter(l => l.alt_msl >= lo && l.alt_msl <= lo + 600);
      if (s.length < 3) continue;
      let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const l of s) {
        const w = Math.sqrt(l.temp_replies || l.temp_count), x = l.alt_msl * 0.0003048;   // km
        sw += w; sx += w * x; sy += w * l.temp; sxx += w * x * x; sxy += w * x * l.temp;
      }
      const den = sw * sxx - sx * sx;
      if (den <= 0) continue;
      const lapse = -(sw * sxy - sx * sy) / den;                 // K/km, + = cooling with height
      const pBot = s[0].pressure, pTop = s[s.length - 1].pressure;
      const tm = sy / sw;
      const gm = typeof skewtMoistLapse === 'function' ? skewtMoistLapse((pBot + pTop) / 2, tm) : 6;
      const cls = lapse < -0.5 ? 'inversion' : lapse > 9.8 + 0.7 ? 'unstable'
                : lapse > gm + 0.5 ? 'conditional' : 'stable';
      out.push({ pBot, pTop, lapse, cls, lo, hi: lo + 600 });
    }
    return out;
  }

  function drawMiniLow(ctx, T) {
    if (!miniLow || !miniLow.levels || aptMode === 'off') return;
    const { ML, PW, PT, PB, W, MT, PH } = MSK;
    const lv = miniLow.levels.filter(l => l.pressure >= PT && l.pressure <= PB);
    const tl = lv.filter(l => l.temp != null && (l.temp_count || 0) >= 2);
    const zoom = aptMode === 'zoom';
    ctx.save();
    ctx.beginPath(); ctx.rect(ML, MT, PW, PH); ctx.clip();
    ctx.strokeStyle = T.apt; ctx.lineWidth = 1;
    for (const l of tl) {                         // spread between flights (10–90 %)
      if (l.temp_p10 == null) continue;
      const y = mskY(l.pressure);
      ctx.globalAlpha = 0.3;
      ctx.beginPath(); ctx.moveTo(mskX(l.temp_p10, l.pressure), y); ctx.lineTo(mskX(l.temp_p90, l.pressure), y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (tl.length >= 2) {
      ctx.lineWidth = zoom ? 2 : 1.6; ctx.beginPath();
      tl.forEach((l, i) => { const x = mskX(l.temp, l.pressure), y = mskY(l.pressure); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
    }
    ctx.fillStyle = T.apt;
    for (const l of tl) {
      ctx.beginPath(); ctx.arc(mskX(l.temp, l.pressure), mskY(l.pressure), zoom ? 2.5 : 1.8, 0, Math.PI * 2); ctx.fill();
    }
    if (zoom) {
      let lastT = null;
      ctx.font = '9px monospace'; ctx.textAlign = 'right';
      for (const l of tl) {
        const y = mskY(l.pressure);
        if (lastT != null && Math.abs(y - lastT) < 12) continue;
        ctx.fillText(l.temp.toFixed(1) + '°', mskX(l.temp, l.pressure) - 5, y + 3);
        lastT = y;
      }
    }
    ctx.restore();
    if (zoom && !miniAcOverlay) {                 // airport winds in the barb column
      let lastW = null;
      ctx.save(); ctx.font = '9px monospace';
      for (const l of lv) {
        if (l.wind_spd == null) continue;
        const y = mskY(l.pressure);
        if (lastW != null && Math.abs(y - lastW) < 11) continue;
        drawMiniBarb(ctx, ML + PW + stripW + 22, y, l.wind_spd, l.wind_dir, T.apt);
        ctx.fillStyle = T.apt; ctx.textAlign = 'right';
        ctx.fillText(Math.round(l.wind_dir) + '° ' + Math.round(l.wind_spd) + 'kt', W - 2, y + 3);
        lastW = y;
      }
      ctx.restore();
    }
    // Legend (top-left of the plot)
    // on a label background, so it stays readable where it crosses the top of the curve
    ctx.save(); ctx.font = '9px monospace'; ctx.textAlign = 'left';
    const aptTxt = `AIRPORT ${miniLow.window_min} min: ${miniLow.arrivals} arr / ${miniLow.departures} dep`;
    const aptY = MT + topOff + (zoom ? 12 : 24);
    ctx.fillStyle = T.anaLblBg; ctx.fillRect(ML + 9, aptY - 9, ctx.measureText(aptTxt).width + 6, 12);
    ctx.fillStyle = T.apt; ctx.fillText(aptTxt, ML + 12, aptY);
    ctx.restore();
    for (const l of lv) {
      miniHoverPts.push({ y: mskY(l.pressure), src: 'apt', alt_ft: l.altitude, alt_msl: l.alt_msl, p: l.pressure,
                          t: l.temp, t10: l.temp_p10, t90: l.temp_p90, tn: l.temp_count, tr: l.temp_replies,
                          ws: l.wind_spd, wd: l.wind_dir, wsd: l.wind_sd, wn: l.wind_count,
                          na: l.n_arr, nd: l.n_dep });
    }
  }

  // Weighted running mean of the layer temperatures over 3 (1-2-1) or 5
  // (1-2-3-2-1) neighbouring layers with a temperature, each also weighted by
  // √(replies) so that thin layers count less.  Only for display: the raw
  // value is kept in temp_raw.  Strong smoothing also softens inversions and
  // the tropopause.
  const SMOOTH_KERNELS = { 1: [1, 2, 1], 2: [1, 2, 3, 2, 1] };
  function smoothAreaTemps(tl, mode) {
    const k = SMOOTH_KERNELS[mode];
    if (!k) return tl.map(l => ({ ...l, temp_raw: l.temp }));
    const h = (k.length - 1) / 2;
    return tl.map((l, i) => {
      let sw = 0, st = 0;
      for (let j = -h; j <= h; j++) {
        const m = tl[i + j];
        if (!m) continue;
        const w = k[j + h] * Math.sqrt(Math.max(1, m.temp_count || 1));
        sw += w; st += w * m.temp;
      }
      return { ...l, temp_raw: l.temp, temp: st / sw };
    });
  }

  function drawMiniArea(ctx, T, withBarbs, strong = withBarbs) {
    if (!miniArea || !miniArea.levels) return;
    const { ML, PW, PT, PB, W } = MSK;
    const lv0 = miniArea.levels.filter(l => l.pressure >= PT && l.pressure <= PB)
                               .sort((a, b) => b.pressure - a.pressure);
    const tl = smoothAreaTemps(lv0.filter(l => l.temp != null), areaSmooth);
    const sm = new Map(tl.map(l => [l.alt_lo, l]));
    const lv = lv0.map(l => sm.get(l.alt_lo) || l);
    ctx.save();
    ctx.globalAlpha = strong ? 0.9 : 0.45;
    // 10–90 % range bars
    ctx.strokeStyle = T.area; ctx.lineWidth = 1;
    for (const l of tl) {
      if (l.temp_p10 == null) continue;
      const y = mskY(l.pressure);
      ctx.beginPath();
      ctx.moveTo(mskX(l.temp_p10, l.pressure), y); ctx.lineTo(mskX(l.temp_p90, l.pressure), y);
      ctx.globalAlpha = strong ? 0.35 : 0.2; ctx.stroke();
    }
    ctx.globalAlpha = strong ? 0.9 : 0.45;
    if (tl.length >= 2) {
      ctx.strokeStyle = T.area; ctx.lineWidth = strong ? 2 : 1.5;
      ctx.beginPath();
      tl.forEach((l, i) => {
        const x = mskX(l.temp, l.pressure), y = mskY(l.pressure);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
    }
    // Dashed join from the METAR surface temperature to the lowest layer
    // above the ground (from 2026-10-20): shows a surface inversion (or a
    // steep daytime surface layer) between the 2 m METAR value and the first
    // aircraft layer — a join of two separate measurements, not data; the
    // real depth of an inversion is not known (often much shallower).
    miniSfcLink = null;
    if (miniSfc && miniSfc.t != null && miniSfc.p) {
      const first = tl.find(l => l.pressure < miniSfc.p - 1);
      if (first) {
        miniSfcLink = { p: first.pressure, t: first.temp };
        ctx.save();
        ctx.strokeStyle = T.area; ctx.lineWidth = strong ? 1.6 : 1.2; ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(mskX(miniSfc.t, miniSfc.p), mskY(miniSfc.p));
        ctx.lineTo(mskX(first.temp, first.pressure), mskY(first.pressure));
        ctx.stroke();
        ctx.restore();
      }
    }
    // layers resting on only one or two aircraft: hollow ring (data-validity cue)
    const weak = l => dqShow && l.ac_count != null && l.ac_count <= 2;
    ctx.strokeStyle = T.weak; ctx.lineWidth = 1.2;
    for (const l of tl) {
      if (!weak(l)) continue;
      ctx.beginPath(); ctx.arc(mskX(l.temp, l.pressure), mskY(l.pressure), 3.2, 0, 2 * Math.PI); ctx.stroke();
    }
    if (strong) {
      let lastT = null, lastW = null;
      ctx.font = '9px monospace';
      for (const l of tl) {
        const y = mskY(l.pressure);
        if (lastT != null && Math.abs(y - lastT) < 12) continue;
        ctx.fillStyle = weak(l) ? T.weak : T.tempLbl; ctx.textAlign = 'left';
        ctx.fillText(l.temp.toFixed(0) + '°', mskX(l.temp, l.pressure) + 5, y + 3);
        lastT = y;
      }
      for (const l of (withBarbs ? lv : [])) {
        if (l.wind_spd == null) continue;
        const y = mskY(l.pressure);
        if (lastW != null && Math.abs(y - lastW) < 9) continue;   // keep the barbs readable
        drawMiniBarb(ctx, ML + PW + stripW + 22, y, l.wind_spd, l.wind_dir, T.area);
        ctx.fillStyle = T.area; ctx.textAlign = 'right';
        ctx.fillText(Math.round(l.wind_dir) + '° ' + Math.round(l.wind_spd) + 'kt', W - 2, y + 3);
        lastW = y;
      }
    }
    ctx.restore();
    for (const l of lv) {
      miniHoverPts.push({ y: mskY(l.pressure), src: 'area', alt_ft: l.altitude, p: l.pressure,
                          t: l.temp, traw: areaSmooth ? l.temp_raw : null, t10: l.temp_p10, t90: l.temp_p90, tn: l.temp_count,
                          ws: l.wind_spd, wd: l.wind_dir, wsd: l.wind_sd, wn: l.wind_count, ac: l.ac_count });
    }
  }

  // ── Radiosonde (Jokioinen, FMI open data) ────────────────────────────────
  // Temperature (pink line), dewpoint (green dashed — humidity aloft, which the
  // aircraft do not report) and winds (pink barbs along the right edge of the
  // plot).  The lines fade with the age of the sounding.
  function sondeAgeS() {
    if (!miniSonde) return null;
    const ref = sondeRef != null ? sondeRef : Date.now() / 1000;
    return ref - (miniSonde.launch || miniSonde.nominal);
  }
  function sondeAlpha() {
    const a = sondeAgeS();
    return a == null ? 1 : a <= 6 * 3600 ? 1 : a <= 12 * 3600 ? 0.75 : 0.5;
  }
  // Values at pressure p, interpolated in log p (null outside the profile)
  function sondeAt(p) {
    return miniSonde ? levelsAt(miniSonde.levels, p) : null;
  }
  function levelsAt(L, p) {                         // L: pressure descending
    const out = {};
    const interp = (key) => {
      let a = null;
      for (const l of L) {
        if (l[key] == null) continue;
        if (l.pressure >= p) { a = l; continue; }
        if (!a) return null;
        const f = (Math.log(a.pressure) - Math.log(p)) / (Math.log(a.pressure) - Math.log(l.pressure));
        return [a, l, f];
      }
      return a && Math.abs(a.pressure - p) < 0.5 ? [a, a, 0] : null;
    };
    const t = interp('temp');
    if (t) out.t = t[0].temp + (t[1].temp - t[0].temp) * t[2];
    const d = interp('dewpoint');
    if (d) out.td = d[0].dewpoint + (d[1].dewpoint - d[0].dewpoint) * d[2];
    const w = interp('wind_spd');
    if (w) {
      const uv = l => [-l.wind_spd * Math.sin(l.wind_dir * Math.PI / 180), -l.wind_spd * Math.cos(l.wind_dir * Math.PI / 180)];
      const [u0, v0] = uv(w[0]), [u1, v1] = uv(w[1]);
      const u = u0 + (u1 - u0) * w[2], v = v0 + (v1 - v0) * w[2];
      out.ws = Math.hypot(u, v);
      out.wd = (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
      out.u = u; out.v = v;
    }
    return (out.t != null || out.ws != null) ? out : null;
  }
  // Area profile minus sonde over the common layers (≥ 3 replies)
  function sondeDiff() {
    if (!miniSonde || !miniArea || !miniArea.levels) return null;
    let n = 0, s = 0, s2 = 0, nw = 0, w2 = 0;
    for (const l of miniArea.levels) {
      const sv = sondeAt(l.pressure);
      if (!sv) continue;
      if (l.temp != null && (l.temp_count || 0) >= 3 && sv.t != null) {
        const d = l.temp - sv.t; n++; s += d; s2 += d * d;
      }
      if (l.wind_spd != null && (l.wind_count || 0) >= 3 && sv.u != null) {
        const r = l.wind_dir * Math.PI / 180;
        const du = -l.wind_spd * Math.sin(r) - sv.u, dv = -l.wind_spd * Math.cos(r) - sv.v;
        nw++; w2 += du * du + dv * dv;
      }
    }
    if (!n && !nw) return null;
    return { n, bias: n ? s / n : null, rms: n ? Math.sqrt(s2 / n) : null, nw, wrms: nw ? Math.sqrt(w2 / nw) : null };
  }
  function drawSondeProfile(ctx, T) {
    if (!miniSonde) return;
    const { ML, PW, MT, PH, PT, PB } = MSK;
    const L = miniSonde.levels.filter(l => l.pressure >= PT * 0.97 && l.pressure <= PB * 1.02);
    ctx.save();
    ctx.beginPath(); ctx.rect(ML, MT, PW, PH); ctx.clip();
    ctx.globalAlpha = sondeAlpha();
    const line = (key, color, width, dash) => {
      const pts = L.filter(l => l[key] != null);
      if (pts.length < 2) return;
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
      ctx.beginPath();
      pts.forEach((l, i) => { const x = mskX(l[key], l.pressure), y = mskY(l.pressure); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
    };
    line('dewpoint', T.dew, 1.2, [5, 3]);
    line('temp', T.sonde, 1.7, []);
    ctx.setLineDash([]);
    // winds: barbs just inside the right edge of the plot, ≥ 17 px apart
    let lastY = null;
    for (const l of L) {
      if (l.wind_spd == null || l.wind_dir == null) continue;
      const y = mskY(l.pressure);
      if (y < MT + 4 || y > MT + PH - 2 || (lastY != null && Math.abs(y - lastY) < 17)) continue;
      drawMiniBarb(ctx, ML + PW - 14, y, l.wind_spd, l.wind_dir, T.sonde);
      lastY = y;
    }
    ctx.restore();
  }
  // ── MEPS model profile (MET Norway open data; area mean) ─────────────────
  // Temperature (teal line), dewpoint (teal dashed) and winds (teal barbs a
  // little inside the sonde's, ≥ 17 px apart): the model's own levels (about
  // 56 up to 190 hPa) or, when those are missing, the 10 pressure levels.
  function mepsAt(p) { return miniMeps ? levelsAt(miniMeps.levels, p) : null; }
  function mepsDiff() {
    if (!miniMeps || !miniArea || !miniArea.levels) return null;
    let n = 0, s = 0, s2 = 0, nw = 0, w2 = 0;
    for (const l of miniArea.levels) {
      const mv = mepsAt(l.pressure);
      if (!mv) continue;
      if (l.temp != null && (l.temp_count || 0) >= 3 && mv.t != null) { const d = l.temp - mv.t; n++; s += d; s2 += d * d; }
      if (l.wind_spd != null && (l.wind_count || 0) >= 3 && mv.u != null) {
        const r = l.wind_dir * Math.PI / 180;
        const du = -l.wind_spd * Math.sin(r) - mv.u, dv = -l.wind_spd * Math.cos(r) - mv.v;
        nw++; w2 += du * du + dv * dv;
      }
    }
    if (!n && !nw) return null;
    return { n, bias: n ? s / n : null, rms: n ? Math.sqrt(s2 / n) : null, nw, wrms: nw ? Math.sqrt(w2 / nw) : null };
  }
  function drawMepsProfile(ctx, T) {
    if (!miniMeps) return;
    const { ML, PW, MT, PH, PT, PB } = MSK;
    const L = miniMeps.levels.filter(l => l.pressure >= PT * 0.97 && l.pressure <= PB * 1.02);
    ctx.save();
    ctx.beginPath(); ctx.rect(ML, MT, PW, PH); ctx.clip();
    const line = (key, width, dash, alpha) => {
      const pts = L.filter(l => l[key] != null);
      if (pts.length < 2) return;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = T.meps; ctx.lineWidth = width; ctx.setLineDash(dash);
      ctx.beginPath();
      pts.forEach((l, i) => { const x = mskX(l[key], l.pressure), y = mskY(l.pressure); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
    };
    line('dewpoint', 1.2, [5, 3], 0.8);
    line('temp', 1.6, [], 1);
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    let lastY = null;
    for (const l of L) {
      if (l.wind_spd == null || l.wind_dir == null) continue;
      const y = mskY(l.pressure);
      if (y < MT + 4 || y > MT + PH - 2 || (lastY != null && Math.abs(y - lastY) < 17)) continue;
      drawMiniBarb(ctx, ML + PW - 34, y, l.wind_spd, l.wind_dir, T.meps);
      lastY = y;
    }
    ctx.restore();
  }
  function mepsLabelText() {
    if (!miniMeps) return null;
    const r = new Date(miniMeps.run * 1000);
    const l1 = `MEPS ${r.getUTCDate()}.${r.getUTCMonth() + 1}. ${String(r.getUTCHours()).padStart(2, '0')} UTC run +${miniMeps.lead} h` +
               (miniMeps.provisional ? ' (forecast)' : '') +
               (miniMeps.levels_kind === 'standard' ? ' · 10 std levels' : '');
    const dd = mepsDiff();
    const l2 = dd ? `Δ area−MEPS: ` + (dd.n ? `T ${dd.bias >= 0 ? '+' : ''}${dd.bias.toFixed(1)} K (RMS ${dd.rms.toFixed(1)})` : '') +
                    (dd.nw ? `${dd.n ? ' · ' : ''}wind ${Math.round(dd.wrms)} kt RMS` : '') : '';
    return [l1, l2].filter(Boolean);
  }
  function drawMepsLabel(ctx, T, y) {
    const lines = miniMeps ? mepsLabelText() : (mepsNote ? [mepsNote] : []);
    const { ML } = MSK;
    ctx.save(); ctx.font = '9px monospace'; ctx.textAlign = 'left';
    lines.forEach((txt, i) => {
      const yy = y + i * 12, w = ctx.measureText(txt).width + 16;
      ctx.fillStyle = T.anaLblBg; ctx.fillRect(ML + 9, yy - 9, w, 12);
      if (i === 0 && miniMeps) {
        ctx.strokeStyle = T.meps; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(ML + 11, yy - 5); ctx.lineTo(ML + 18, yy - 5); ctx.stroke();
        ctx.lineWidth = 1.2; ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.moveTo(ML + 11, yy - 1); ctx.lineTo(ML + 18, yy - 1); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = T.meps;
      ctx.fillText(txt, ML + 22, yy);
    });
    ctx.restore();
    return lines.length;
  }
  function mepsHoverLines(p) {
    const mv = miniMeps ? mepsAt(p) : null;
    if (!mv) return [];
    const r = new Date(miniMeps.run * 1000);
    const head = `<span style="color:${miniSkewTTheme().meps}"><b>MEPS ${String(r.getUTCHours()).padStart(2, '0')} UTC +${miniMeps.lead} h</b></span>`;
    const parts = [];
    if (mv.t != null) parts.push(`T ${mv.t.toFixed(1)} °C`);
    if (mv.td != null) {
      const rh = typeof skewtEs === 'function' && mv.t != null ? 100 * skewtEs(mv.td) / skewtEs(mv.t) : null;
      parts.push(`Td ${mv.td.toFixed(1)} °C` + (rh != null ? ` (RH ${Math.round(rh)} %)` : ''));
    }
    if (mv.ws != null) parts.push(`${String(Math.round(mv.wd)).padStart(3, '0')}° / ${Math.round(mv.ws)} kt`);
    return [head + ' ' + parts.join(' · ')];
  }

  function drawSondeLabel(ctx, T, y) {
    if (!miniSonde) return 0;
    const age = sondeAgeS();
    const h = Math.floor(Math.max(0, age) / 3600), m = Math.floor(Math.max(0, age) % 3600 / 60);
    const nom = new Date(miniSonde.nominal * 1000);
    const day = `${nom.getUTCDate()}.${nom.getUTCMonth() + 1}.`;
    const ageTxt = age < 0 ? 'later than the profile' : `${h} h ${String(m).padStart(2, '0')} min old`;
    const partial = miniSonde.min_p != null && miniSonde.min_p > 150
      ? ` · to ${Math.round(miniSonde.min_p)} hPa${miniSonde.qc ? ' (bad data above cut)' : ''}` : '';
    const l1 = `${(miniSonde.station || 'SONDE').toUpperCase()} ${day} ${String(nom.getUTCHours()).padStart(2, '0')} UTC · ${ageTxt}${partial}`;
    const dd = sondeDiff();
    const l2 = dd ? `Δ area−sonde: ` + (dd.n ? `T ${dd.bias >= 0 ? '+' : ''}${dd.bias.toFixed(1)} K (RMS ${dd.rms.toFixed(1)})` : '') +
                    (dd.nw ? `${dd.n ? ' · ' : ''}wind ${Math.round(dd.wrms)} kt RMS` : '') + ` · ${Math.max(dd.n, dd.nw)} layers` : '';
    const { ML } = MSK;
    ctx.save(); ctx.font = '9px monospace'; ctx.textAlign = 'left';
    const col = age > 12 * 3600 ? T.sondeOld : T.sonde;
    [l1, l2].filter(Boolean).forEach((txt, i) => {
      const yy = y + i * 12, w = ctx.measureText(txt).width + 16;
      ctx.fillStyle = T.anaLblBg; ctx.fillRect(ML + 9, yy - 9, w, 12);
      if (i === 0) {                              // legend swatch: pink line + green dash
        ctx.strokeStyle = T.sonde; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(ML + 11, yy - 5); ctx.lineTo(ML + 18, yy - 5); ctx.stroke();
        ctx.strokeStyle = T.dew; ctx.lineWidth = 1.5; ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.moveTo(ML + 11, yy - 1); ctx.lineTo(ML + 18, yy - 1); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = i === 0 ? col : T.sonde;
      ctx.fillText(txt, ML + 22, yy);
    });
    ctx.restore();
    return [l1, l2].filter(Boolean).length;
  }
  // Hover lines: the sonde values at the hovered level
  function sondeHoverLines(p) {
    const sv = miniSonde ? sondeAt(p) : null;
    if (!sv) return [];
    const nom = new Date(miniSonde.nominal * 1000);
    const head = `<span style="color:${miniSkewTTheme().sonde}"><b>${miniSonde.station || 'Sonde'} ${String(nom.getUTCHours()).padStart(2, '0')} UTC</b></span>`;
    const parts = [];
    if (sv.t != null) parts.push(`T ${sv.t.toFixed(1)} °C`);
    if (sv.td != null) {
      const rh = typeof skewtEs === 'function' && sv.t != null ? 100 * skewtEs(sv.td) / skewtEs(sv.t) : null;
      parts.push(`Td ${sv.td.toFixed(1)} °C` + (rh != null ? ` (RH ${Math.round(rh)} %)` : ''));
    }
    if (sv.ws != null) parts.push(`${String(Math.round(sv.wd)).padStart(3, '0')}° / ${Math.round(sv.ws)} kt`);
    return [head + ' ' + parts.join(' · ')];
  }

  // ── Data-validity badge (top-left): aircraft behind the area profile ─────────
  // GOOD ≥ 20 aircraft per hour of window, FAIR 8–19, LOW < 8 (typical: 25–70
  // by day, 2–5 around midnight).  Layers from 1–2 aircraft carry a ring.
  function dataQuality() {
    if (!dqShow || !miniArea || miniArea.aircraft == null || !miniArea.levels || !miniArea.levels.length) return null;
    const win = Math.max(30, miniArea.window_min || 60);
    const rate = miniArea.aircraft * 60 / win;
    const cls = rate >= 20 ? 'GOOD' : rate >= 8 ? 'FAIR' : 'LOW';
    const weakN = miniArea.levels.filter(l => l.ac_count != null && l.ac_count <= 2 && l.temp != null
                                            && l.pressure >= MSK.PT && l.pressure <= MSK.PB).length;
    return { cls, n: miniArea.aircraft, obs: miniArea.obs_used, weakN };
  }
  function drawDataBadge(ctx, T) {
    const q = dataQuality();
    if (!q) return;
    const { ML, MT } = MSK;
    const col = q.cls === 'GOOD' ? T.dqGood : q.cls === 'FAIR' ? T.dqFair : T.dqLow;
    const main = `DATA ${q.cls} · ${q.n} aircraft · ${q.obs} obs`;
    const key = q.weakN ? `  ○ = 1–2 aircraft` : '';
    ctx.save(); ctx.font = '9px monospace'; ctx.textAlign = 'left';
    const x = ML + 16, y = MT + 12, w = ctx.measureText(main + key).width + 16;
    ctx.fillStyle = T.anaLblBg; ctx.fillRect(x - 3, y - 9, w, 12);
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x + 3, y - 3, 3, 0, 2 * Math.PI); ctx.fill();
    ctx.fillText(main, x + 10, y);
    if (key) { ctx.fillStyle = T.weak; ctx.fillText(key, x + 10 + ctx.measureText(main).width, y); }
    ctx.restore();
  }

  // Ground line at the airport's station pressure (QNH reduced to the field
  // elevation), shading below it, and the METAR surface temperature.  Aircraft
  // pressure altitudes refer to 1013.25 hPa, so the layers below this line are
  // below ground (e.g. the 0–1000 ft layer when QNH is low).
  // Hover text for the dashed surface → lowest-layer join: temperature
  // difference, height above the ground (hypsometric) and what it means
  function sfcLinkText() {
    if (!miniSfcLink || !miniSfc || miniSfc.t == null) return '';
    const dT = miniSfcLink.t - miniSfc.t;
    const tm = (miniSfcLink.t + miniSfc.t) / 2 + 273.15;
    const dz = 287.04 * tm / 9.80665 * Math.log(miniSfc.p / miniSfcLink.p);           // m
    const lapse = -dT / (dz / 1000);
    const kind = dT >= 1 ? 'inversion' : lapse >= 9.8 ? 'steeper than dry adiabatic (heated ground)'
               : lapse >= 7 ? 'steep' : lapse < 2 ? 'stable' : `lapse rate ${lapse.toFixed(1)} K/km`;
    return `Surface → lowest Mode S layer (${Math.round(miniSfcLink.p)} hPa, about ${(Math.round(dz / 0.3048 / 100) * 100).toLocaleString()} ft above the ground): ` +
           `<b>${dT >= 0 ? '+' : ''}${dT.toFixed(1)} K</b> — ${kind}<br>` +
           `<span class="mini-tip-dim">dashed line: a join of the METAR (2 m) and the aircraft layer, not a measurement — the real inversion is often much shallower</span>`;
  }

  function drawMiniGround(ctx, T) {
    if (!miniSfc) return;
    const { ML, PW, MT, PH, PB, PT } = MSK;
    const p = miniSfc.p;
    if (p > PB || p < PT) return;
    const y = mskY(p);
    ctx.save();
    ctx.fillStyle = T.ground; ctx.globalAlpha = 0.18;
    ctx.fillRect(ML, y, PW, MT + PH - y);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = T.ground; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(ML + PW, y); ctx.stroke();
    ctx.font = '9px monospace'; ctx.fillStyle = T.groundLbl; ctx.textAlign = 'right';
    ctx.fillText(`${miniSfc.station || 'ground'} ${Math.round(p)} hPa (QNH ${Math.round(miniSfc.qnh)})`, ML + PW - 4, y - 3);
    if (miniSfc.t != null) {
      const x = mskX(miniSfc.t, p);
      if (x >= ML && x <= ML + PW) {
        ctx.fillStyle = T.groundLbl; ctx.strokeStyle = T.bg; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y); ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.textAlign = 'left'; ctx.fillText(`${miniSfc.t}°`, x + 7, y + 11);
      }
    }
    // METAR dewpoint (from 2026-10-11): green diamond on the ground line
    if (miniSfc.td != null) {
      const x = mskX(miniSfc.td, p);
      if (x >= ML && x <= ML + PW) {
        ctx.fillStyle = T.dew; ctx.strokeStyle = T.bg; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y); ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.textAlign = 'right'; ctx.fillText(`Td ${miniSfc.td}°`, x - 7, y + 11);
      }
    }
    ctx.restore();
    miniHoverPts.push({ y, src: 'sfc', p, t: miniSfc.t, alt_ft: null });
  }

  // ── Surface parcel with the METAR dewpoint (Analysis Full, from 2026-10-11) ──
  // Mixing-ratio line from the dewpoint and the dry adiabat from the
  // temperature meet at the LCL (cumulus base estimate); above it the parcel
  // follows the moist adiabat.  Where it is warmer than the profile (LFC → EL)
  // the area (CAPE) is shaded.  Labels: LCL with the METAR cloud group for
  // comparison; CAPE / CIN / LI; a small T − Td spread (fog / low stratus).
  function drawMiniParcel(ctx, T, pc, labels, hline, fl, inPlot) {
    const { ML, PW, MT, PH, PT, PB } = MSK;
    const path = pc.path.filter(([p]) => p >= PT - 5);
    const sfcP = path.length ? path[0][0] : null;
    // CAPE area: parcel path LFC → EL and the environment back
    if (pc.lfc && pc.el && pc.cape >= 1 && pc.env) {
      const envT = pp => {
        for (let i = 0; i < pc.env.length - 1; i++) {
          const a = pc.env[i], b = pc.env[i + 1];
          if (pp <= a.p && pp >= b.p)
            return a.t + (Math.log(pp / a.p) / Math.log(b.p / a.p)) * (b.t - a.t);
        }
        return null;
      };
      const seg = path.filter(([p]) => p <= pc.lfc.p && p >= pc.el.p && p >= PT && p <= PB);
      if (seg.length >= 2) {
        ctx.fillStyle = T.cape; ctx.beginPath();
        seg.forEach(([p, t], i) => i ? ctx.lineTo(mskX(t, p), mskY(p)) : ctx.moveTo(mskX(t, p), mskY(p)));
        for (let i = seg.length - 1; i >= 0; i--) {
          const e = envT(seg[i][0]);
          if (e != null) ctx.lineTo(mskX(e, seg[i][0]), mskY(seg[i][0]));
        }
        ctx.closePath(); ctx.fill();
      }
    }
    // parcel path (dashed): dry adiabat to the LCL, moist adiabat above — to
    // the EL + 50 hPa, or to 500 hPa (the Lifted Index level) without CAPE
    const pEnd = Math.max(PT, pc.lfc && pc.el ? pc.el.p - 50 : Math.min(500, pc.lcl.p - 50));
    ctx.strokeStyle = T.anaTherm; ctx.lineWidth = 1.2; ctx.setLineDash([5, 3]); ctx.beginPath();
    let first = true;
    for (const [p, t] of path) {
      if (p < pEnd || p > PB) continue;
      first ? ctx.moveTo(mskX(t, p), mskY(p)) : ctx.lineTo(mskX(t, p), mskY(p)); first = false;
    }
    ctx.stroke(); ctx.setLineDash([]);
    // mixing-ratio line from the surface dewpoint to the LCL
    if (sfcP != null && miniSfc && miniSfc.td != null) {
      const w = pc.w / 1000;
      ctx.strokeStyle = T.dew; ctx.lineWidth = 1.2; ctx.setLineDash([2, 3]); ctx.beginPath();
      first = true;
      for (let p = miniSfc.p; p >= pc.lcl.p - 0.01; p -= 5) {
        const pp = Math.max(p, pc.lcl.p);
        const e = w * pp / (0.622 + w), le = Math.log(e / 6.112);
        const tdp = 243.5 * le / (17.67 - le);
        first ? ctx.moveTo(mskX(tdp, pp), mskY(pp)) : ctx.lineTo(mskX(tdp, pp), mskY(pp)); first = false;
      }
      ctx.stroke(); ctx.setLineDash([]);
    }
    // LCL: short bar across the parcel path
    const ftAgl = v => `${(Math.round(v / 100) * 100).toLocaleString()}ft AGL`;
    const cloud = miniSfc && miniSfc.cld ? ` · METAR ${miniSfc.cld}` : '';
    if (inPlot(pc.lcl.p)) {
      const x = mskX(pc.lcl.t, pc.lcl.p), y = mskY(pc.lcl.p);
      ctx.strokeStyle = T.dew; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x - 14, y); ctx.lineTo(x + 14, y); ctx.stroke();
      labels.push({ y, color: T.dew,
                    text: `LCL ${ftAgl(pc.lcl.agl)}${pc.cuBase ? ' Cu base' : ''}${cloud}` });
      miniHoverPts.push({ y, src: 'lcl', p: pc.lcl.p, pc });
    }
    // CAPE / CIN / LI and the equilibrium level (cloud top of a cumulus)
    const li = pc.li != null ? ` LI ${pc.li > 0 ? '+' : ''}${pc.li.toFixed(1)}` : '';
    if (pc.lfc && pc.cape >= 1) {
      let y = inPlot(pc.lcl.p) ? mskY(pc.lcl.p) - 1 : MT + 24;
      if (pc.el && inPlot(pc.el.p)) y = hline(pc.el.p, T.anaTherm, [2, 3]);
      labels.push({ y, color: T.anaTherm,
                    text: `CAPE ${Math.round(pc.cape)} CIN ${Math.round(pc.cin)} J/kg${li}` +
                          (pc.el ? ` EL ${pc.el.open ? '>' : ''}${fl(pc.el.alt)}` : '') });
    } else {
      labels.push({ y: inPlot(pc.lcl.p) ? mskY(pc.lcl.p) - 1 : MT + 24, color: T.anaTherm,
                    text: `PARCEL stable (no CAPE)${li}` });
    }
    if (pc.spread <= 1.5 && miniSfc && inPlot(miniSfc.p)) {
      labels.push({ y: mskY(miniSfc.p) - 16, color: T.dew,
                    text: `T−Td ${pc.spread.toFixed(0)}K: FOG / LOW ST risk` });
    }
  }

  // ── Skew-T analysis overlay (skewt_analysis.js) ─────────────────────────────
  // Lines / bands across the plot, labels at its right edge (spread so they do
  // not overlap), the stability strip just right of the pressure axis.
  function drawMiniAnalysis(ctx, T) {
    if (!miniArea || !miniArea.levels || typeof analyzeSkewT !== 'function') return;
    const { ML, PW, MT, PH, PT, PB } = MSK;
    const a = analyzeSkewT(miniArea.levels, { lat: LAT,
                                               sfc: miniSfc && miniSfc.t != null ? { p: miniSfc.p, t: miniSfc.t, td: miniSfc.td } : null });
    const fl = ft => 'FL' + String(Math.max(0, Math.round(ft / 100))).padStart(3, '0');
    const inPlot = p => p >= PT && p <= PB;
    const labels = [];                       // {y, text, color}
    ctx.save();
    ctx.beginPath(); ctx.rect(ML, MT, PW, PH); ctx.clip();
    const hline = (p, color, dash, width = 1) => {
      const y = mskY(p);
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
      ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(ML + PW, y); ctx.stroke(); ctx.setLineDash([]);
      return y;
    };

    // Tropopause: band ±1 000 ft and a dashed line
    if (a.trop && inPlot(a.trop.p)) {
      const y1 = mskY(altToPressHPa(a.trop.alt + 1000)), y2 = mskY(altToPressHPa(a.trop.alt - 1000));
      ctx.fillStyle = T.anaTrop; ctx.globalAlpha = 0.12; ctx.fillRect(ML, y1, PW, y2 - y1); ctx.globalAlpha = 1;
      const y = hline(a.trop.p, T.anaTrop, [6, 3], 1.2);
      labels.push({ y, color: T.anaTrop,
                    text: `TROP ${fl(a.trop.alt)} ${Math.round(a.trop.t)}°${a.trop.q === '?' ? ' ?' : ''}` });
    }
    // 0 °C (all real crossings), −10 / −20 °C from level 2
    for (const z of a.isotherms[0]) if (inPlot(z.p))
      labels.push({ y: hline(z.p, T.anaZero, [5, 3], 1.2), color: T.anaZero, text: `0° ${fl(z.alt)}` });
    if (anaLevel >= 2) for (const tc of [-10, -20]) for (const z of a.isotherms[tc]) if (inPlot(z.p))
      labels.push({ y: hline(z.p, T.anaIso, [1, 3]), color: T.anaIso, text: `${tc}° ${fl(z.alt)}` });

    // Max wind / jet and low-level jet: a short tick at the right edge
    const windMark = (w, txt) => {
      if (!w || !inPlot(w.p)) return;
      const y = mskY(w.p);
      ctx.strokeStyle = T.anaWind; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(ML + PW - 18, y); ctx.lineTo(ML + PW, y); ctx.stroke();
      labels.push({ y, color: T.anaWind, text: txt });
    };
    if (a.maxWind) windMark(a.maxWind, `${a.maxWind.jet ? 'JET' : 'MAX'} ${Math.round(a.maxWind.spd)}kt ${fl(a.maxWind.alt)}`);
    if (a.llj) windMark(a.llj, `LLJ ${Math.round(a.llj.spd)}kt ${Math.round(a.llj.alt / 100) * 100}ft`);

    if (anaLevel >= 2) {
      // Inversions: shaded layer
      for (const v of a.inversions) {
        if (!inPlot(v.pBot) && !inPlot(v.pTop)) continue;
        const yb = mskY(Math.min(v.pBot, PB)), yt = mskY(Math.max(v.pTop, PT));
        ctx.fillStyle = T.anaInv; ctx.globalAlpha = 0.14; ctx.fillRect(ML, yt, PW, yb - yt); ctx.globalAlpha = 1;
        labels.push({ y: (yb + yt) / 2, color: T.anaInv,
                      text: `INV +${v.dT.toFixed(1)}° ${fl(v.altBot)}–${fl(v.altTop).slice(2)}` });
      }
    }
    // Airport low-level profile: significant inversions (200 ft resolution)
    if (anaLevel >= 2 && aptMode !== 'off' && miniLow && miniLow.levels && miniLow.levels.length >= 3) {
      const la = analyzeSkewT(lowLevelsForAnalysis(), { lat: LAT });
      for (const v of la.inversions) {
        if (!inPlot(v.pBot) && !inPlot(v.pTop)) continue;
        const yb = mskY(Math.min(v.pBot, PB)), yt = mskY(Math.max(v.pTop, PT));
        ctx.fillStyle = T.apt; ctx.globalAlpha = 0.16; ctx.fillRect(ML, yt, PW, yb - yt); ctx.globalAlpha = 1;
        labels.push({ y: (yb + yt) / 2, color: T.apt,
                      text: `INV apt +${v.dT.toFixed(1)}° ${Math.round(v.altBot)}–${Math.round(v.altTop)}ft MSL` });
      }
    }
    if (anaLevel >= 3) {
      // Wind shear / turbulence risk: a bar at the right edge of the plot
      for (const s of a.turbulence) {
        if (!inPlot(s.pBot) && !inPlot(s.pTop)) continue;
        const yb = mskY(Math.min(s.pBot, PB)), yt = mskY(Math.max(s.pTop, PT));
        ctx.fillStyle = s.cls === 'likely' ? T.stUnst : T.stCond;
        ctx.globalAlpha = 0.85; ctx.fillRect(ML + PW - 5, yt, 4, yb - yt); ctx.globalAlpha = 1;
        labels.push({ y: (yb + yt) / 2, color: s.cls === 'likely' ? T.stUnst : T.stCond,
                      text: `${s.cls === 'likely' ? 'TURB' : 'SHEAR'} ${fl(s.altBot)}–${fl(s.altTop).slice(2)} ` +
                            `${Math.round(s.shear)}kt/1000ft Ri ${s.ri < 10 ? s.ri.toFixed(1) : '>10'}` });
      }
    }
    if (anaLevel >= 5 && a.thermal) {
      // Dry thermal top: METAR surface temperature lifted along the dry adiabat
      const th = a.thermal;
      if (th.na) {
        labels.push({ y: MT + PH - 30, color: T.anaTherm, text: `THERMAL TOP: n/a (${th.na})` });
      } else if (th.none) {
        labels.push({ y: mskY(Math.min(th.p, PB)) - 14, color: T.anaTherm, text: 'THERMALS: none (stable surface layer)' });
      } else if (inPlot(th.p)) {
        const theta = (miniSfc.t + 273.15) * Math.pow(1000 / miniSfc.p, 0.2857);
        ctx.strokeStyle = T.anaTherm; ctx.lineWidth = 1.8; ctx.beginPath();
        let first = true;
        for (let p = miniSfc.p; p >= th.p - 0.01; p -= 5) {
          const pp = Math.max(p, th.p);
          const x = mskX(theta * Math.pow(pp / 1000, 0.2857) - 273.15, pp), y = mskY(pp);
          first ? ctx.moveTo(x, y) : ctx.lineTo(x, y); first = false;
        }
        ctx.lineTo(mskX(th.tTop, th.p), mskY(th.p));
        ctx.stroke();
        const y = hline(th.p, T.anaTherm, [4, 3]);
        labels.push({ y, color: T.anaTherm,
                      text: `THERMAL TOP ${Math.round(th.agl / 100) * 100}ft AGL (${fl(th.alt)})` });
      }
    }
    if (anaLevel >= 5 && a.parcel) drawMiniParcel(ctx, T, a.parcel, labels, hline, fl, inPlot);
    if (anaLevel >= 4) {
      // Thermal advection: a red (warm) / blue (cold) bar left of the shear bar
      for (const v of a.advection) {
        if (!inPlot(v.pBot) && !inPlot(v.pTop)) continue;
        const yb = mskY(Math.min(v.pBot, PB)), yt = mskY(Math.max(v.pTop, PT));
        const c = v.adv > 0 ? T.anaWarm : T.anaCold;
        ctx.fillStyle = c; ctx.globalAlpha = 0.75; ctx.fillRect(ML + PW - 11, yt + 1, 4, yb - yt - 2); ctx.globalAlpha = 1;
        labels.push({ y: (yb + yt) / 2, color: c,
                      text: `${v.adv > 0 ? 'WAA +' : 'CAA '}${v.adv.toFixed(1)}K/h ${v.pBot}–${v.pTop}` });
      }
      // Contrails: Schmidt–Appleman threshold curves (dashed = saturated air,
      // dotted = dry air) from 500 hPa up, and the lowest levels below them
      const curve = (key, dash) => {
        ctx.strokeStyle = T.anaCon; ctx.lineWidth = 1; ctx.setLineDash(dash); ctx.globalAlpha = 0.7;
        ctx.beginPath();
        let first = true;
        for (let p = 500; p >= PT; p -= 10) {
          const x = mskX(skewtContrailThresholds(p)[key], p), y = mskY(p);
          first ? ctx.moveTo(x, y) : ctx.lineTo(x, y); first = false;
        }
        ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      };
      curve('tLM', [6, 3]); curve('tLC', [1, 3]);
      if (a.contrail && inPlot(a.contrail.pHumid)) {
        const c = a.contrail;
        const y = hline(c.pHumid, T.anaCon, [2, 2]);
        if (c.pDry != null && c.pDry !== c.pHumid && inPlot(c.pDry)) hline(c.pDry, T.anaCon, [2, 2]);
        labels.push({ y, color: T.anaCon,
                      text: `CONTRAIL ${fl(c.altHumid)}+ humid` + (c.altDry != null ? ` / ${fl(c.altDry)}+ dry` : '') });
      }
    }
    ctx.restore();

    // Stability strip just right of the pressure axis
    if (anaLevel >= 2) {
      const col = { unstable: T.stUnst, conditional: T.stCond, stable: T.stStab, inversion: T.stInv };
      for (const s of a.stability) {
        if (!inPlot(s.pBot) && !inPlot(s.pTop)) continue;
        const yb = mskY(Math.min(s.pBot, PB)), yt = mskY(Math.max(s.pTop, PT));
        ctx.fillStyle = col[s.cls]; ctx.globalAlpha = 0.8;
        ctx.fillRect(ML + 1, yt, 5, yb - yt); ctx.globalAlpha = 1;
      }
      // Airport profile: second strip (600 ft slabs), amber frame
      if (aptMode !== 'off') {
        for (const s of lowStabilitySlabs()) {
          if (!inPlot(s.pBot) && !inPlot(s.pTop)) continue;
          const yb = mskY(Math.min(s.pBot, PB)), yt = mskY(Math.max(s.pTop, PT));
          ctx.fillStyle = col[s.cls]; ctx.globalAlpha = 0.85;
          ctx.fillRect(ML + 8, yt, 5, yb - yt); ctx.globalAlpha = 1;
          ctx.strokeStyle = T.apt; ctx.lineWidth = 1; ctx.strokeRect(ML + 7.5, yt + 0.5, 6, yb - yt - 1);
        }
      }
      // key, bottom-left (cold low-level corner, normally empty)
      ctx.font = '8px sans-serif'; ctx.textAlign = 'left';
      let kx = ML + 10; const ky = MT + PH - 6;
      for (const [c, t] of [[T.stUnst, 'unstable'], [T.stCond, 'cond.'], [T.stStab, 'stable'], [T.stInv, 'inv.']]) {
        ctx.fillStyle = c; ctx.fillRect(kx, ky - 6, 6, 6);
        ctx.fillStyle = T.area; ctx.fillText(t, kx + 8, ky); kx += ctx.measureText(t).width + 16;
      }
    }

    // Labels at the right edge of the plot, spread so they do not overlap
    ctx.font = '9px monospace'; ctx.textAlign = 'right';
    labels.sort((p, q) => p.y - q.y);
    const H = 11; let last = MT - H;
    for (const l of labels) { l.y = Math.max(l.y - 2, last + H); last = l.y; }
    for (let i = labels.length - 1, lim = MT + PH - 2; i >= 0; i--) {   // keep inside the plot
      labels[i].y = Math.min(labels[i].y, lim); lim = labels[i].y - H;
    }
    const x = ML + PW - 8;
    for (const l of labels) {
      const w = ctx.measureText(l.text).width;
      ctx.fillStyle = T.anaLblBg; ctx.fillRect(x - w - 3, l.y - 8, w + 6, 11);
      ctx.fillStyle = l.color; ctx.fillText(l.text, x, l.y);
    }
  }

  // Hover read-out: nearest level / observation to the mouse (aircraft points
  // first when an aircraft is selected), shown in a small box over the canvas
  function miniHover(ev) {
    if (!canvas || !tip) return;
    const r  = canvas.getBoundingClientRect();
    const my = (ev.clientY - r.top) * (canvas.height / r.height);
    if (rhOn) {                                      // over the RH strip
      const mx = (ev.clientX - r.left) * (canvas.width / r.width), g = rhGeom();
      if (mx >= g.x0 - 3 && mx <= g.x1 + 3 && my >= MSK.MT && my <= MSK.MT + MSK.PH) {
        tip.innerHTML = rhHover(my);
        tip.style.display = 'block';
        const wr = canvas.parentElement.getBoundingClientRect();
        tip.style.top  = Math.max(4, Math.min(ev.clientY - wr.top - tip.offsetHeight - 8, r.height - tip.offsetHeight)) + 'px';
        tip.style.left = '8px';
        return;
      }
    }
    // aircraft points first when selected; then the airport profile (when shown)
    // and the area profile together, nearest wins
    const groups = miniAcOverlay ? [['ac'], ['apt', 'area']] : [['apt', 'area']];
    let best = null;
    for (const g of groups) {
      for (const p of miniHoverPts) {
        if (!g.includes(p.src) && p.src !== 'sfc' && p.src !== 'lcl') continue;
        const d = Math.abs(p.y - my);
        if (d <= 25 && (!best || d < Math.abs(best.y - my))) best = p;
      }
      if (best) break;
    }
    if (!best) { tip.style.display = 'none'; return; }
    const ft  = best.alt_ft != null ? Math.round(best.alt_ft) : null;
    if (best.src === 'lcl' && best.pc) {
      const pc = best.pc, r100 = v => (Math.round(v / 100) * 100).toLocaleString();
      tip.innerHTML = [`<b>Lifting condensation level (surface parcel)</b>`,
        `${r100(pc.lcl.agl)} ft AGL · ${Math.round(pc.lcl.p)} hPa · ${pc.lcl.t.toFixed(1)} °C`,
        `<span class="mini-tip-dim">METAR ${miniSfc ? miniSfc.t : '?'} / ${miniSfc ? miniSfc.td : '?'} °C, mixing ratio ${pc.w.toFixed(1)} g/kg — base of cumulus formed from surface air</span>`,
        miniSfc && miniSfc.cld ? `METAR lowest cloud: ${skewtCloudText(miniSfc.cld)}` : 'METAR: no cloud group',
        pc.cuBase ? 'Dry thermals reach the LCL → cumulus base' : '<span class="mini-tip-dim">Dry thermals end below the LCL (no cumulus from surface heating now)</span>',
        pc.lfc && pc.cape >= 1
          ? `CAPE ${Math.round(pc.cape)} J/kg · CIN ${Math.round(pc.cin)} J/kg · LFC ${r100(pc.lfc.alt)} ft` +
            (pc.el ? ` · EL ${pc.el.open ? '> ' : ''}${r100(pc.el.alt)} ft` : '')
          : 'Parcel colder than the profile above the LCL: no CAPE',
        pc.li != null ? `Lifted Index ${pc.li > 0 ? '+' : ''}${pc.li.toFixed(1)} K (500 hPa)` : '',
        `<span class="mini-tip-dim">No humidity aloft and no virtual-temperature correction: CAPE is a rough indication</span>`]
        .filter(Boolean).join('<br>');
      tip.style.display = 'block';
      const wrapL = canvas.parentElement.getBoundingClientRect();
      tip.style.top  = Math.max(4, Math.min(ev.clientY - wrapL.top - tip.offsetHeight - 8, r.height - tip.offsetHeight)) + 'px';
      tip.style.left = '8px';
      return;
    }
    if (best.src === 'sfc' && miniSfc) {
      const rh = miniSfc.td != null && miniSfc.t != null && typeof skewtEs === 'function'
        ? 100 * skewtEs(miniSfc.td) / skewtEs(miniSfc.t) : null;
      tip.innerHTML = [`<b>Ground, ${miniSfc.station || 'airport'} METAR ${miniSfc.time}</b>`,
        `QNH ${Math.round(miniSfc.qnh)} hPa · elevation ${Math.round(miniSfc.elev)} ft`,
        `Station pressure ${miniSfc.p.toFixed(1)} hPa`,
        miniSfc.t != null ? `Temp ${miniSfc.t} °C` + (miniSfc.td != null
          ? ` · dewpoint ${miniSfc.td} °C · spread ${miniSfc.t - miniSfc.td} K · RH ${Math.round(rh)} %` : '') : '',
        miniSfc.td != null && miniSfc.t != null
          ? `<span class="mini-tip-dim">LCL ≈ ${(Math.round((miniSfc.t - miniSfc.td) * 410 / 100) * 100).toLocaleString()} ft AGL (≈ 410 ft per K of spread; exact value with Analysis Full)</span>` : '',
        miniSfc.cld ? `Lowest cloud ${skewtCloudText(miniSfc.cld)}` : '',
        sfcLinkText(),
        `<span class="mini-tip-dim">Layers below this line are below ground (pressure altitude, 1013.25 hPa)</span>`]
        .filter(Boolean).join('<br>');
      tip.style.display = 'block';
      const wrap0 = canvas.parentElement.getBoundingClientRect();
      tip.style.top  = Math.max(4, Math.min(ev.clientY - wrap0.top - tip.offsetHeight - 8, r.height - tip.offsetHeight)) + 'px';
      tip.style.left = '8px';
      return;
    }
    if (best.src === 'apt') {
      const L = [`<b>Airport low-level, last ${miniLow ? miniLow.window_min : 60} min</b>`,
        `${best.alt_msl} ft MSL (±100 ft) · pressure alt ${Math.round(best.alt_ft).toLocaleString()} ft · ${Math.round(best.p)} hPa`,
        `${best.na || 0} landings, ${best.nd || 0} departures in this band`];
      if (best.t != null) L.push(`Temp ${best.t.toFixed(1)} °C <span class="mini-tip-dim">(flights 10–90 % ${best.t10.toFixed(1)}…${best.t90.toFixed(1)}, ${best.tn} flights, ${best.tr} replies)</span>`);
      if (best.ws != null) L.push(`Wind ${String(Math.round(best.wd)).padStart(3, '0')}° / ${Math.round(best.ws)} kt <span class="mini-tip-dim">(SD ${best.wsd} kt between ${best.wn} flights)</span>`);
      L.push(...sondeHoverLines(best.p), ...mepsHoverLines(best.p));
      tip.innerHTML = L.join('<br>');
      tip.style.display = 'block';
      const wrapA = canvas.parentElement.getBoundingClientRect();
      tip.style.top  = Math.max(4, Math.min(ev.clientY - wrapA.top - tip.offsetHeight - 8, r.height - tip.offsetHeight)) + 'px';
      tip.style.left = '8px';
      return;
    }
    const lines = [
      `<b>${best.src === 'ac' ? (acLabel) : profileTitle}</b>`,
      ft != null ? `${ft.toLocaleString()} ft · FL${String(Math.round(ft / 100)).padStart(3, '0')} · ${(ft * 0.0003048).toFixed(1)} km` : '',
      `${Math.round(best.p)} hPa`,
    ];
    if (best.t != null) lines.push(`Temp ${best.t.toFixed(1)} °C` +
        (best.traw != null ? ` <span class="mini-tip-dim">(smoothed; layer ${best.traw.toFixed(1)})</span>` : '') +
        (best.t10 != null ? ` <span class="mini-tip-dim">(10–90 % ${best.t10.toFixed(0)}…${best.t90.toFixed(0)}, n ${best.tn}${best.ac != null ? ', ' + best.ac + ' aircraft' : ''})</span>` : ''));
    if (dqShow && best.src === 'area' && best.ac != null && best.ac <= 2)
      lines.push(`<span style="color:${miniSkewTTheme().weak}">Only ${best.ac} aircraft in this layer — single-aircraft value, read with care</span>`);
    if (best.ws != null) lines.push(`Wind ${String(Math.round(best.wd)).padStart(3, '0')}° / ${Math.round(best.ws)} kt` +
        (best.wsd != null ? ` <span class="mini-tip-dim">(SD ${best.wsd.toFixed(0)} kt, n ${best.wn})</span>` : ''));
    lines.push(...sondeHoverLines(best.p), ...mepsHoverLines(best.p));
    tip.innerHTML = lines.filter(Boolean).join('<br>');
    tip.style.display = 'block';
    const wrap = canvas.parentElement.getBoundingClientRect();
    const y = ev.clientY - wrap.top;
    tip.style.top  = Math.max(4, Math.min(y - tip.offsetHeight - 8, r.height - tip.offsetHeight)) + 'px';
    tip.style.left = '8px';
    // crosshair at the chosen level
    drawMiniSounding();
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.strokeStyle = miniSkewTTheme().tempLbl; ctx.globalAlpha = 0.5; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(MSK.ML, best.y); ctx.lineTo(MSK.W - 2, best.y); ctx.stroke();
    ctx.restore();
  }

  function drawMiniSounding() {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    applyMskRange();
    stripW = rhOn ? RH_W : 0;    // the RH strip takes its width from the plot
    MSK.PW = MSK.W - MSK.ML - MSK.MR - stripW;
    const zoom = aptMode === 'zoom';
    const { W, H, ML, MR, MT, MB, PW, PH, TL, TR, PT, PB } = MSK;
    const barbX = ML + PW + stripW + 20;  // X of the wind barbs (staff up to 14 px each way)
    const T = miniSkewTTheme();

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = T.bg;
    ctx.fillRect(0, 0, W, H);

    // ── Clip to plot + barb area for grid ──────────────────────────────────
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, MT, W, PH);
    ctx.clip();

    // Isobars (horizontal lines + pressure labels)
    const isobars = zoom ? [1025, 1000, 975, 950, 925, 900, 875, 850]
                         : [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200];
    ctx.font = '9px monospace'; ctx.textAlign = 'right';
    for (const p of isobars) {
      if (p < PT || p > PB) continue;
      const y = mskY(p);
      ctx.strokeStyle = p % (zoom ? 50 : 100) === 0 ? T.isobarMaj : T.isobarMin;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(ML + PW, y); ctx.stroke();
      ctx.fillStyle = T.isotLabel;
      // the top label (200 hPa, or 850 in zoom) would be cut by the plot
      // clip at the top edge — write it just below its line instead
      ctx.fillText(p, ML - 3, y - 6 < MT ? y + 9 : y + 3);
    }

    // Isotherms (skewed temperature lines)
    const isoT = zoom ? [-30, -25, -20, -15, -10, -5, 0, 5, 10, 15, 20, 25, 30, 35]
                      : [-90, -80, -70, -60, -50, -40, -30, -20, -10, 0, 10, 20, 30];
    for (const t of isoT) {
      const x1 = mskX(t, PB), y1 = mskY(PB);
      const x2 = mskX(t, PT), y2 = mskY(PT);
      ctx.strokeStyle = t === 0 ? T.isotherm0 : T.isothermN;
      ctx.lineWidth   = t === 0 ? 1.2 : 0.7;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }

    ctx.restore();

    // Dry (solid) and moist (dashed) adiabats, every 10 K, clipped to the plot
    ctx.save();
    ctx.beginPath(); ctx.rect(ML, MT, PW, PH); ctx.clip();
    const adi = zoom
      ? adiabatCurves(PT, PB, [256, 260, 264, 268, 272, 276, 280, 284, 288, 292, 296, 300, 304, 308, 312],
                      [-12, -8, -4, 0, 4, 8, 12, 16, 20, 24])
      : adiabatCurves(PT, PB, [250, 260, 270, 280, 290, 300, 310, 320, 330, 340, 350, 360, 370, 380, 390, 400],
                      [-10, 0, 10, 20, 30]);
    const adiLine = (pts) => {
      ctx.beginPath();
      pts.forEach(([p, t], i) => { const x = mskX(t, p), y = mskY(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
    };
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = T.dryAdi;   ctx.setLineDash([]);     adi.dry.forEach(adiLine);
    ctx.strokeStyle = T.moistAdi; ctx.setLineDash([4, 3]); adi.moist.forEach(adiLine);
    ctx.setLineDash([]);
    ctx.restore();

    // Temperature scale below the plot (outside the clip — inside it the
    // labels were cut off)
    ctx.font = '9px monospace'; ctx.textAlign = 'center'; ctx.fillStyle = T.label;
    for (const t of (zoom ? [-10, -5, 0, 5, 10, 15, 20] : [-40, -30, -20, -10, 0, 10, 20, 30])) {
      const x1 = mskX(t, PB);
      if (x1 >= ML + 6 && x1 <= ML + PW - 6) ctx.fillText(t + '°', x1, MT + PH + 14);
    }

    // Altitude markers (pressure altitude, km) just right of the pressure axis
    // (the cold upper-left corner of a Skew-T is empty)
    ctx.font = '9px monospace'; ctx.textAlign = 'left';
    // (zoom: every 1 000 ft of pressure altitude)
    const altMarks = zoom ? [1, 2, 3, 4, 5].map(k => [k * 1000, `${k}000 ft`])
                          : [1, 2, 3, 4, 5, 6, 8, 10, 12].map(km => [km * 3280.84, km + ' km']);
    for (const [ft, lbl] of altMarks) {
      const p = altToPressHPa(ft);
      if (p < PT || p > PB) continue;
      const y = mskY(p);
      ctx.strokeStyle = T.axisLine; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(ML + 4, y); ctx.stroke();
      ctx.fillStyle = T.kmLabel;
      ctx.fillText(lbl, ML + (anaLevel >= 2 ? (aptMode !== 'off' ? 15 : 10) : 6), y + 3);
    }
    miniHoverPts = [];

    // Y axis line
    ctx.strokeStyle = T.axisLine; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ML, MT); ctx.lineTo(ML, MT + PH); ctx.stroke();

    // ── ISA reference (dashed blue) ─────────────────────────────────────────
    const isaPs = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200];
    ctx.strokeStyle = T.isa; ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    let isaFirst = true;
    for (const p of isaPs) {
      if (p < PT || p > PB) continue;
      const t = isaTempP(p);
      const x = mskX(t, p), y = mskY(p);
      if (x >= ML && x <= ML + PW) {
        isaFirst ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        isaFirst = false;
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // ── Ground: station pressure from the METAR QNH, with the surface temperature ─
    topOff = dataQuality() ? 14 : 0;
    drawMiniGround(ctx, T);

    // ── Radiosonde (when switched on) under the Mode S profiles ─────────────
    drawSondeProfile(ctx, T);
    drawMepsProfile(ctx, T);

    // ── Area profile (all aircraft within the sounding radius, last 60 min) ──
    // Grey background reference; with no aircraft selected it is the profile
    // shown, with its wind barbs.
    drawMiniArea(ctx, T, !miniAcOverlay && !zoom, !miniAcOverlay);

    // ── Airport low-level profile (landings + departures, last 60 min) ──────
    drawMiniLow(ctx, T);

    // ── Automatic analysis of the area profile (button in the panel title) ──
    if (anaLevel > 0) drawMiniAnalysis(ctx, T);

    // ── No aircraft selected hint ───────────────────────────────────────────
    if (!miniAcOverlay) {
      ctx.fillStyle = T.hint; ctx.font = '10px system-ui'; ctx.textAlign = 'center';
      const msg = hintText != null ? hintText
        : miniArea && miniArea.levels && miniArea.levels.length
        ? `Area profile, last ${miniArea.window_min} min — click an aircraft`
        : 'Click an aircraft to show its profile';
      // with the analysis on, the right edge holds its labels → hint on the left
      if (zoom || !msg) { /* airport legend sits at the top-left */ }
      else if (anaLevel > 0 || topOff) { ctx.textAlign = 'left'; ctx.fillText(msg, ML + 12, MT + topOff + 12); }
      else ctx.fillText(msg, ML + PW / 2, MT + 12);
    }

    // ── Aircraft overlay ────────────────────────────────────────────────────
    if (miniAcOverlay) {
      const { temp_c, pressure, alt_ft, color, windHistory: wh } = miniAcOverlay;

      // ── Wind + temperature history (density-filtered vertical profile) ──
      if (wh && wh.length > 0) {
        // Build density-filtered index list: include a point only when altitude
        // has changed by at least windDensity × 400 ft since the last included.
        const minGapFt = windDensity * 400;
        const shownIdx = [];
        let lastShownAlt = null;
        for (let i = 0; i < wh.length; i++) {
          if (lastShownAlt === null || Math.abs(wh[i].alt_ft - lastShownAlt) >= minGapFt) {
            shownIdx.push(i);
            lastShownAlt = wh[i].alt_ft;
          }
        }
        // Always include the most recent observation regardless of gap
        if (shownIdx[shownIdx.length - 1] !== wh.length - 1) shownIdx.push(wh.length - 1);

        // Temperature line through the shown points (sorted by pressure)
        const tPts = shownIdx.map(i => wh[i])
          .filter(o => o.temp_c != null && o.pressure >= PT && o.pressure <= PB)
          .sort((a, b) => b.pressure - a.pressure);
        if (tPts.length >= 2) {
          ctx.strokeStyle = color + 'cc'; ctx.lineWidth = 1.5;
          ctx.beginPath();
          tPts.forEach((o, i) => {
            const x = mskX(o.temp_c, o.pressure), y = mskY(o.pressure);
            i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
          });
          ctx.stroke();
        }
        // Temperature values next to the points (thinned so they do not overlap)
        let lastLblY = null;
        ctx.font = '9px monospace'; ctx.textAlign = 'left';
        for (const o of tPts) {
          const y = mskY(o.pressure);
          if (lastLblY != null && Math.abs(y - lastLblY) < 12) continue;
          ctx.fillStyle = T.tempLbl;
          ctx.fillText(o.temp_c.toFixed(0) + '°', mskX(o.temp_c, o.pressure) + 5, y + 3);
          lastLblY = y;
        }

        let lastBarbLblY = null;
        for (const idx of shownIdx) {
          const obs = wh[idx];
          if (obs.pressure < PT || obs.pressure > PB) continue;
          const oy        = mskY(obs.pressure);
          const isCurrent = (idx === wh.length - 1);
          const barbColor = isCurrent ? color : color + '66';
          miniHoverPts.push({ y: oy, src: 'ac', alt_ft: obs.alt_ft, p: obs.pressure,
                              t: obs.temp_c, ws: obs.wind_spd, wd: obs.wind_dir });

          // Temperature dot on the skewed T axis
          if (obs.temp_c != null) {
            const ox = mskX(obs.temp_c, obs.pressure);
            ctx.fillStyle = barbColor;
            ctx.beginPath();
            ctx.arc(ox, oy, isCurrent ? 3 : 2, 0, Math.PI * 2);
            ctx.fill();
          }

          // Wind barb in aircraft colour + speed label
          if (obs.wind_spd != null && obs.wind_dir != null) {
            drawMiniBarb(ctx, barbX + 2, oy, obs.wind_spd, obs.wind_dir, barbColor);
            if (isCurrent || lastBarbLblY == null || Math.abs(oy - lastBarbLblY) >= 11) {
              ctx.fillStyle = barbColor;
              ctx.font      = '9px monospace'; ctx.textAlign = 'right';
              ctx.fillText(Math.round(obs.wind_dir) + '° ' + Math.round(obs.wind_spd) + 'kt', W - 2, oy + 3);
              lastBarbLblY = oy;
            }
          }
        }
      }

      // ── Current altitude/pressure level indicator ───────────────────────
      // Always show a dashed horizontal line at the aircraft's current level,
      // even when temperature data is not available.
      const p = (pressure != null) ? pressure
              : (alt_ft  != null) ? altToPressHPa(alt_ft)
              : null;

      if (p != null && p >= PT && p <= PB) {
        const y = mskY(p);

        // Full-width dashed line spanning plot + barb area
        ctx.strokeStyle = color; ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(W - 2, y); ctx.stroke();
        ctx.setLineDash([]);

        // Circle on temperature profile (only if temp available)
        if (temp_c != null) {
          const x = mskX(temp_c, p);
          ctx.strokeStyle = T.dotRing; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke();
          ctx.fillStyle = color;
          ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
        } else {
          // No temp: draw a small diamond on the pressure axis instead
          const dx = ML + 5, dy = y;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(dx, dy - 5); ctx.lineTo(dx + 4, dy);
          ctx.lineTo(dx, dy + 5); ctx.lineTo(dx - 4, dy);
          ctx.closePath(); ctx.fill();
        }
      }
    }

    // ── Sonde label below the top-left texts (hint, airport legend) ─────────
    {
      const aptOn = !!(miniLow && miniLow.levels && aptMode !== 'off');
      let line = zoom ? (aptOn ? 2 : 1) : (aptOn ? 3 : 2);
      if (miniSonde) line += drawSondeLabel(ctx, T, MT + topOff + 12 * line);
      else if (sondeNote) {
        ctx.save(); ctx.font = '9px monospace'; ctx.textAlign = 'left';
        const yy = MT + topOff + 12 * line;
        ctx.fillStyle = T.anaLblBg; ctx.fillRect(ML + 9, yy - 9, ctx.measureText(sondeNote).width + 6, 12);
        ctx.fillStyle = T.sonde; ctx.fillText(sondeNote, ML + 12, yy);
        ctx.restore();
        line += 1;
      }
      // ── MEPS label below the sonde label ──────────────────────────────────
      if (miniMeps || mepsNote) drawMepsLabel(ctx, T, MT + topOff + 12 * line);
    }

    // ── RH strip: trial moisture indicator and the sonde's relative humidity ─
    if (rhOn) drawRhStrip(ctx, T);

    // ── Data-validity badge on top of everything ────────────────────────────
    drawDataBadge(ctx, T);
  }

  // ── RH strip (between the plot and the wind barbs) ─────────────────────────
  // Aircraft: the trial moisture indicator as bars for its three layers (index
  // ≈ relative humidity, brown dry < 40 / green moist / blue humid ≥ 70 %,
  // with its ± range; faint when uncertain).  Sonde: its relative humidity
  // from temperature and dewpoint as a pink line, at full vertical detail.
  // MEPS (with the MEPS tick box): the model's relative humidity over the
  // same area as a teal line (model levels).
  const MOIST_CLS = [[40, 'dry', [180, 116, 52]], [70, 'moist', [132, 170, 90]], [1e9, 'humid', [14, 140, 200]]];
  const moistCls = v => MOIST_CLS.find(c => v < c[0]);
  function rhGeom() {
    const { ML, PW } = MSK;
    const x0 = ML + PW + 5, x1 = ML + PW + stripW - 3;
    return { x0, x1, x: v => x0 + (x1 - x0) * Math.max(0, Math.min(100, v)) / 100 };
  }
  function sondeRh(l) {
    if (l.temp == null || l.dewpoint == null) return null;
    const es = t => 6.112 * Math.exp(17.67 * t / (t + 243.5));
    return 100 * es(l.dewpoint) / es(l.temp);
  }
  function mepsRh(l) { return l.rh != null ? l.rh : sondeRh(l); }
  // mean RH (ln-p weighted) of the layer [lo, hi] ft from levels (pressure
  // descending) with the RH function f, or null (≥ 3 levels in the layer)
  function layerRh(levels, f, lo, hi) {
    const p0 = altToPressHPa(lo), p1 = altToPressHPa(hi);
    const L = levels.filter(l => l.pressure <= p0 && l.pressure >= p1 && f(l) != null);
    if (L.length < 3) return null;
    let s = 0, w = 0;
    for (let i = 1; i < L.length; i++) {
      const dw = Math.log(L[i - 1].pressure / L[i].pressure);
      s += dw * (f(L[i - 1]) + f(L[i])) / 2; w += dw;
    }
    return w > 0 ? s / w : null;
  }
  const sondeLayerRh = (lo, hi) => miniSonde ? layerRh(miniSonde.levels, sondeRh, lo, hi) : null;
  const mepsLayerRh  = (lo, hi) => miniMeps  ? layerRh(miniMeps.levels, mepsRh, lo, hi) : null;
  // RH at pressure p from levels (pressure descending), linear in ln p
  function rhAt(levels, f, p) {
    let a = null;
    for (const l of levels) {
      if (f(l) == null) continue;
      if (l.pressure >= p) { a = l; continue; }
      if (!a) return null;
      const w = Math.log(a.pressure / p) / Math.log(a.pressure / l.pressure);
      return f(a) + (f(l) - f(a)) * w;
    }
    return null;
  }
  function drawRhStrip(ctx, T) {
    const { MT, PH, PT, PB } = MSK;
    const { x0, x1, x } = rhGeom();
    ctx.save();
    ctx.fillStyle = T.bg; ctx.fillRect(x0 - 3, MT, x1 - x0 + 6, PH);     // over the isotherm lines
    ctx.beginPath(); ctx.rect(x0 - 3, MT, x1 - x0 + 6, PH); ctx.clip();
    ctx.strokeStyle = T.axisLine; ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, MT + 0.5, x1 - x0 - 1, PH - 1);
    ctx.globalAlpha = 0.6; ctx.setLineDash([2, 3]);
    for (const v of [40, 70]) { ctx.beginPath(); ctx.moveTo(x(v) + 0.5, MT); ctx.lineTo(x(v) + 0.5, MT + PH); ctx.stroke(); }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    // aircraft bars
    for (const r of (miniMoist && miniMoist.rows) || []) {
      const [lo, hi, idx, se] = r;
      if (idx == null) continue;
      const yb = mskY(altToPressHPa(lo)), yt = mskY(altToPressHPa(hi));
      if (yb < MT || yt > MT + PH) continue;
      const weak = se == null || se > (miniMoist.uncertain_pct || 40), c = moistCls(idx)[2];
      ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${weak ? 0.3 : 0.65})`;
      ctx.fillRect(x0 + 1, yt + 1, Math.max(2, x(idx) - x0 - 1), yb - yt - 2);
      ctx.strokeStyle = `rgb(${c[0]},${c[1]},${c[2]})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x(idx), yt + 1); ctx.lineTo(x(idx), yb - 1); ctx.stroke();
      if (se != null) {                                // ± range at the middle of the layer
        const ym = (yt + yb) / 2;
        ctx.strokeStyle = T.tempLbl; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x(idx - se), ym); ctx.lineTo(x(idx + se), ym);
        ctx.moveTo(x(idx - se), ym - 3); ctx.lineTo(x(idx - se), ym + 3);
        ctx.moveTo(x(idx + se), ym - 3); ctx.lineTo(x(idx + se), ym + 3); ctx.stroke();
      }
      if (idx > 100) {                                 // beyond the scale: a small arrow at the edge
        const ym = (yt + yb) / 2 - 8;
        ctx.fillStyle = T.tempLbl; ctx.beginPath(); ctx.moveTo(x1 - 1, ym); ctx.lineTo(x1 - 6, ym - 3); ctx.lineTo(x1 - 6, ym + 3); ctx.fill();
      }
    }
    // sonde RH line
    if (miniSonde) {
      const L = miniSonde.levels.filter(l => l.pressure >= PT * 0.97 && l.pressure <= PB * 1.02 && sondeRh(l) != null);
      if (L.length >= 2) {
        ctx.globalAlpha = sondeAlpha();
        ctx.strokeStyle = T.sonde; ctx.lineWidth = 1.3;
        ctx.beginPath();
        L.forEach((l, i) => { const xx = x(sondeRh(l)), yy = mskY(l.pressure); i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); });
        ctx.stroke(); ctx.globalAlpha = 1;
      }
    }
    // MEPS RH line (model over the same area)
    if (miniMeps) {
      const L = miniMeps.levels.filter(l => l.pressure >= PT * 0.97 && l.pressure <= PB * 1.02 && mepsRh(l) != null);
      if (L.length >= 2) {
        ctx.strokeStyle = T.meps; ctx.lineWidth = 1.3;
        ctx.beginPath();
        L.forEach((l, i) => { const xx = x(mepsRh(l)), yy = mskY(l.pressure); i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); });
        ctx.stroke();
      }
    }
    ctx.restore();
    // labels: title above, scale below
    ctx.save(); ctx.font = '9px monospace'; ctx.fillStyle = T.area; ctx.textAlign = 'center';
    ctx.fillText('RH %', (x0 + x1) / 2, MT - 3);
    ctx.textAlign = 'left'; ctx.fillText('0', x0, MT + PH + 14);
    ctx.textAlign = 'right'; ctx.fillText('100', x1 + 2, MT + PH + 14);
    if (!miniMoist || !(miniMoist.rows || []).length) {
      ctx.textAlign = 'center'; ctx.fillStyle = T.area;
      ctx.save(); ctx.translate((x0 + x1) / 2, mskY(altToPressHPa(8000))); ctx.rotate(-Math.PI / 2);
      ctx.fillText(miniMoist ? 'too few flights' : 'no aircraft value', 0, 3); ctx.restore();
    }
    ctx.restore();
  }
  // hover text of the RH strip at canvas y, or null
  function rhHover(my) {
    const parts = [];
    const p = Math.exp(Math.log(MSK.PT) + (my - MSK.MT) / MSK.PH * (Math.log(MSK.PB) - Math.log(MSK.PT)));
    const ft = (1 - Math.pow(p / 1013.25, 1 / 5.2559)) / 6.8756e-6;
    const fmt = f => f >= 6000 ? `FL${String(Math.round(f / 100)).padStart(3, '0')}` : `${Math.round(f).toLocaleString()} ft`;
    const r = ((miniMoist && miniMoist.rows) || []).find(r => ft >= r[0] && ft < r[1]);
    parts.push(`<b>Moisture (trial)</b> · ${fmt(ft)} · ${Math.round(p)} hPa`);
    if (r) {
      const [lo, hi, idx, se, n, corr, raw, ser] = r;
      const w = miniMoist.window_h ? miniMoist.window_h[String(lo)] : null;
      parts.push(`Aircraft ${fmt(lo)}–${fmt(hi)}: <b>${moistCls(idx)[1]}</b>, index ${idx} %${se != null ? ` ±${se} %` : ''}` +
        (ser != null ? ` <span class="mini-tip-dim">(±${ser} % from the flights, the rest systematic)</span>` : '') +
        ` <span class="mini-tip-dim">(${n} climbs / descents${w ? ` of ±${w} h` : ''}; Tv − T ${corr >= 0 ? '+' : ''}${corr.toFixed(2)} K after the sonde offsets, ${raw >= 0 ? '+' : ''}${raw.toFixed(2)} K raw)</span>`);
      const sl = sondeLayerRh(lo, hi);
      if (sl != null) parts.push(`<span style="color:${miniSkewTTheme().sonde}">Sonde mean RH of the layer ${Math.round(sl)} %</span>`);
      const ml = mepsLayerRh(lo, hi);
      if (ml != null) parts.push(`<span style="color:${miniSkewTTheme().meps}">MEPS mean RH of the layer ${Math.round(ml)} %</span>`);
    } else if (miniMoist) parts.push('<span class="mini-tip-dim">no aircraft value here (1 000–15 000 ft only, enough climbs / descents needed)</span>');
    const sv = miniSonde ? sondeAt(p) : null;
    if (sv && sv.t != null && sv.td != null) {
      const es = t => 6.112 * Math.exp(17.67 * t / (t + 243.5));
      parts.push(`<span style="color:${miniSkewTTheme().sonde}">Sonde RH ${Math.round(100 * es(sv.td) / es(sv.t))} % at this level</span>`);
    }
    const mr = miniMeps ? rhAt(miniMeps.levels, mepsRh, p) : null;
    if (mr != null) parts.push(`<span style="color:${miniSkewTTheme().meps}">MEPS RH ${Math.round(mr)} % at this level</span>`);
    parts.push(`<span class="mini-tip-dim">Index ≈ RH from the thickness of climbs / descents (virtual temperature) minus the Mach/TAS temperature — a first trial, a tendency rather than a measurement` +
      (miniMoist ? `, offsets from ${miniMoist.offsets_n || 0} sounding${miniMoist.offsets_n === 1 ? '' : 's'}` : '') + `</span>`);
    return parts.join('<br>');
  }


  function resize(w, h) {
    if (canvas.width === w && canvas.height === h) return false;
    canvas.width = w; canvas.height = h;
    MSK.W = w; MSK.H = h;
    MSK.PW = w - MSK.ML - MSK.MR;
    MSK.PH = h - MSK.MT - MSK.MB;
    return true;
  }

  function set(o) {
    if ('area' in o)         miniArea = o.area;
    if ('low' in o)          miniLow = o.low;
    if ('aptMode' in o)      aptMode = o.aptMode || 'off';
    if ('anaLevel' in o)     anaLevel = o.anaLevel || 0;
    if ('smooth' in o)       areaSmooth = o.smooth || 0;
    if ('sfc' in o)          miniSfc = o.sfc;
    if ('ac' in o)           miniAcOverlay = o.ac;
    if ('density' in o)      windDensity = o.density;
    if ('acLabel' in o)      acLabel = o.acLabel;
    if ('profileTitle' in o) profileTitle = o.profileTitle;
    if ('hint' in o)         hintText = o.hint;
    if ('dq' in o)           dqShow = o.dq !== false;
    if ('sonde' in o) {
      miniSonde = o.sonde && o.sonde.levels && o.sonde.levels.length ? o.sonde : null;
      sondeNote = o.sonde && !miniSonde ? `${(o.sonde.station || 'Sonde').toUpperCase()}: no sounding stored for this time` : null;
    }
    if ('sondeRef' in o)     sondeRef = o.sondeRef;
    if ('meps' in o) {
      miniMeps = o.meps && o.meps.found && o.meps.levels && o.meps.levels.length ? o.meps : null;
      mepsNote = o.meps && !miniMeps ? 'MEPS: no model data for this time' : null;
    }
    if ('rh' in o)           rhOn = !!o.rh;
    if ('moist' in o)        miniMoist = o.moist || null;
  }

  function leave() {
    if (tip) tip.style.display = 'none';
    drawMiniSounding();
  }

  return { set, draw: drawMiniSounding, hover: miniHover, leave, resize, geometry: MSK, sondeAt };
}

if (typeof window !== 'undefined') {
  window.createSkewT = createSkewT;
  window.skewtSfcPoint = skewtSfcPoint;
  window.parseMetarSfc = parseMetarSfc;
  window.skewtCloudText = skewtCloudText;
}
