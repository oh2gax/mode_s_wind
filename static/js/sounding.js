/**
 * sounding.js — Skew-T style atmospheric sounding renderer.
 *
 * Draws on an HTML5 Canvas using pressure (log scale) on the Y-axis
 * and temperature on a 45°-skewed X-axis, following radiosonde
 * Skew-T Log-P convention.  Wind barbs are drawn to the right.
 */

const CANVAS_W = 540;
const CANVAS_H = 580;

// Pressure range to display (hPa)
const P_TOP    = 100;
const P_BOTTOM = 1050;

// Temperature axis (°C)
const T_LEFT  = -80;
const T_RIGHT = 30;

// Layout margins
const ML = 56;   // left margin (pressure axis labels)
const MR = 90;   // right margin (wind barbs)
const MT = 30;   // top margin
const MB = 40;   // bottom margin
const PLOT_W = CANVAS_W - ML - MR;
const PLOT_H = CANVAS_H - MT - MB;

// ── Coordinate transforms ──────────────────────────────────────────────────
function pToY(p) {
  // Log-pressure Y coordinate (p in hPa)
  const logTop = Math.log(P_TOP);
  const logBot = Math.log(P_BOTTOM);
  return MT + PLOT_H * (Math.log(p) - logTop) / (logBot - logTop);
}

function tToX(t, p) {
  // Skewed temperature: at each pressure level, add a horizontal offset
  // proportional to log(P_BOTTOM/p) to create the 45° skew.
  const base   = ML + PLOT_W * (t - T_LEFT) / (T_RIGHT - T_LEFT);
  const skewPx = PLOT_H * (Math.log(P_BOTTOM) - Math.log(p)) / (Math.log(P_BOTTOM) - Math.log(P_TOP));
  return base + skewPx * 0.5;  // 0.5 controls skew angle
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

// ── Theme-aware colour palette for canvas drawing ─────────────────────────
function skewTTheme() {
  const light = document.documentElement.dataset.theme === 'light';
  return {
    bg:       light ? '#eef2f7' : '#0c1620',
    isobarMaj: light ? '#c0cdd8' : '#253448',
    isobarMin: light ? '#d5dfe8' : '#1d2d3f',
    isotherm0: light ? '#9ab4c8' : '#1e3a5f',
    isothermN: light ? '#cdd7e0' : '#1a2a3a',
    isotLabel: light ? '#475569' : '#334155',
    axisLine:  light ? '#94a3b8' : '#3d5268',
    label:     light ? '#475569' : '#64748b',
    barb:      light ? '#64748b' : '#94a3b8',
    dotRing:   light ? '#1e293b' : '#e2e8f0',
    noData:    light ? '#64748b' : '#64748b',
    windOnly:  light ? '#64748b' : '#4b5563',
    dryAdi:    light ? '#e2c3a0' : '#584530',
    moistAdi:  light ? '#a9d4b7' : '#2c5a43',
  };
}

// ── Draw grid ──────────────────────────────────────────────────────────────
function drawGrid(ctx) {
  const T = skewTTheme();
  ctx.lineWidth = 0.5;
  ctx.font      = '10px monospace';

  // Isobars (horizontal pressure lines)
  const isobars = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100];
  for (const p of isobars) {
    const y = pToY(p);
    ctx.strokeStyle = p % 100 === 0 ? T.isobarMaj : T.isobarMin;
    ctx.beginPath();
    ctx.moveTo(ML, y);
    ctx.lineTo(ML + PLOT_W, y);
    ctx.stroke();
  }

  // Isotherms (skewed temperature lines)
  const isotherms = [-80,-70,-60,-50,-40,-30,-20,-10,0,10,20,30];
  for (const t of isotherms) {
    ctx.strokeStyle = t === 0 ? T.isotherm0 : T.isothermN;
    ctx.beginPath();
    ctx.moveTo(tToX(t, P_BOTTOM), pToY(P_BOTTOM));
    ctx.lineTo(tToX(t, P_TOP),    pToY(P_TOP));
    ctx.stroke();
  }

  // Dry (solid) and moist (dashed) adiabats, every 10 K
  const thetas = []; for (let th = 240; th <= 470; th += 10) thetas.push(th);
  const adi = adiabatCurves(P_TOP, P_BOTTOM, thetas, [-20, -10, 0, 10, 20, 30]);
  const adiLine = (pts) => {
    ctx.beginPath();
    pts.forEach(([p, t], i) => { const x = tToX(t, p), y = pToY(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  };
  ctx.save();
  ctx.beginPath(); ctx.rect(ML, MT, PLOT_W, PLOT_H); ctx.clip();
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = T.dryAdi;   ctx.setLineDash([]);     adi.dry.forEach(adiLine);
  ctx.strokeStyle = T.moistAdi; ctx.setLineDash([5, 4]); adi.moist.forEach(adiLine);
  ctx.setLineDash([]);
  ctx.restore();

  // Key for the adiabats (empty cold upper-left corner of the diagram)
  ctx.font = '9px sans-serif'; ctx.textAlign = 'left'; ctx.lineWidth = 1.2;
  const kx = ML + 8, ky = MT + 12;
  ctx.strokeStyle = T.dryAdi; ctx.beginPath(); ctx.moveTo(kx, ky - 3); ctx.lineTo(kx + 16, ky - 3); ctx.stroke();
  ctx.fillStyle = T.label; ctx.fillText('dry adiabat', kx + 20, ky);
  ctx.strokeStyle = T.moistAdi; ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(kx, ky + 9); ctx.lineTo(kx + 16, ky + 9); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillText('moist adiabat', kx + 20, ky + 12);
}

// Axis labels — drawn outside the plot clip (inside drawGrid they were
// clipped away, so the pressure and temperature scales never showed)
function drawGridLabels(ctx) {
  const T = skewTTheme();
  ctx.font = '10px monospace';
  ctx.fillStyle = T.label;
  ctx.textAlign = 'right';
  for (const p of [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100]) {
    ctx.fillText(p, ML - 6, pToY(p) + 4);
  }
  ctx.fillStyle = T.isotLabel;
  ctx.textAlign = 'center';
  for (const t of [-80,-70,-60,-50,-40,-30,-20,-10,0,10,20,30]) {
    const x = tToX(t, P_BOTTOM);
    if (x > ML && x < ML + PLOT_W) ctx.fillText(t + '°', x, CANVAS_H - MB + 14);
  }
}

// ── Wind barb ──────────────────────────────────────────────────────────────
function drawBarb(ctx, x, y, speedKt, dirFrom) {
  if (speedKt == null || dirFrom == null) return;
  const spd   = Math.round(speedKt / 5) * 5;   // round to 5 kt
  const angle = dirFrom * Math.PI / 180;  // staff points FROM wind direction (met convention)

  const staffLen = 20;
  const endX     = x + staffLen * Math.sin(angle);
  const endY     = y - staffLen * Math.cos(angle);

  const barbCol = skewTTheme().barb;
  ctx.strokeStyle = barbCol;
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(endX, endY);
  ctx.stroke();

  // Flags and barbs
  let remaining = spd;
  let pos       = 0;
  const step    = 4;

  // Pennants (50 kt triangles)
  while (remaining >= 50) {
    const sx  = endX - pos * Math.sin(angle);
    const sy  = endY + pos * Math.cos(angle);
    const tx  = sx + 10 * Math.cos(angle);
    const ty  = sy + 10 * Math.sin(angle);
    const mx  = sx + step * Math.sin(angle);
    const my  = sy - step * Math.cos(angle);
    ctx.fillStyle = barbCol;
    ctx.beginPath();
    ctx.moveTo(sx, sy); ctx.lineTo(tx, ty); ctx.lineTo(mx, my);
    ctx.closePath(); ctx.fill();
    pos += step + 1;
    remaining -= 50;
  }

  // Full barbs (10 kt)
  while (remaining >= 10) {
    const sx = endX - pos * Math.sin(angle);
    const sy = endY + pos * Math.cos(angle);
    const ex = sx + 9 * Math.cos(angle);
    const ey = sy + 9 * Math.sin(angle);
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
    pos += step;
    remaining -= 10;
  }

  // Half barb (5 kt)
  if (remaining >= 5) {
    const sx = endX - pos * Math.sin(angle);
    const sy = endY + pos * Math.cos(angle);
    const ex = sx + 5 * Math.cos(angle);
    const ey = sy + 5 * Math.sin(angle);
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
  }
}

// ── Main render ────────────────────────────────────────────────────────────
let lastSoundingLevels = null;   // last rendered levels — redrawn on theme change

function renderSounding(levels) {
  lastSoundingLevels = levels;
  const canvas = document.getElementById('skewt-canvas');
  const ctx    = canvas.getContext('2d');

  const T = skewTTheme();
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.fillStyle = T.bg;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Clip to plot area
  ctx.save();
  ctx.beginPath();
  ctx.rect(ML, MT, PLOT_W + MR, PLOT_H);
  ctx.clip();
  drawGrid(ctx);
  ctx.restore();
  drawGridLabels(ctx);

  // Y axis line
  ctx.strokeStyle = T.axisLine;
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(ML, MT); ctx.lineTo(ML, MT + PLOT_H); ctx.stroke();

  // Axis labels
  ctx.fillStyle = T.label;
  ctx.font      = '10px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('Temperature (°C)', ML + PLOT_W / 2, CANVAS_H - 4);
  ctx.save();
  ctx.translate(12, MT + PLOT_H / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('Pressure (hPa)', 0, 0);
  ctx.restore();

  // Separate temp and wind levels
  const tempLevels = levels.filter(
    l => l.temp     != null && l.pressure >= P_TOP && l.pressure <= P_BOTTOM);
  const windLevels = levels.filter(
    l => l.wind_spd != null && l.wind_dir != null &&
         l.pressure >= P_TOP && l.pressure <= P_BOTTOM);

  // Nothing to draw at all
  if (tempLevels.length === 0 && windLevels.length === 0) {
    ctx.fillStyle = T.noData;
    ctx.font      = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data available', CANVAS_W / 2, CANVAS_H / 2);
    return;
  }

  // ── Temperature spread (10–90 % of the replies in each layer) ───────────
  ctx.save();
  ctx.strokeStyle = 'rgba(239,68,68,0.45)';
  ctx.lineWidth   = 1;
  for (const l of tempLevels) {
    if (l.temp_p10 == null || l.temp_p90 == null) continue;
    const y  = pToY(l.pressure);
    const x0 = tToX(l.temp_p10, l.pressure), x1 = tToX(l.temp_p90, l.pressure);
    ctx.beginPath();
    ctx.moveTo(x0, y); ctx.lineTo(x1, y);
    ctx.moveTo(x0, y - 3); ctx.lineTo(x0, y + 3);
    ctx.moveTo(x1, y - 3); ctx.lineTo(x1, y + 3);
    ctx.stroke();
  }
  ctx.restore();

  // ── Temperature curve ───────────────────────────────────────────────────
  if (tempLevels.length >= 2) {
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth   = 2.5;
    ctx.beginPath();
    tempLevels.forEach((l, i) => {
      const x = tToX(l.temp, l.pressure);
      const y = pToY(l.pressure);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = '#ef4444';
    let lastLblY = null;
    for (const l of tempLevels) {
      const x = tToX(l.temp, l.pressure);
      const y = pToY(l.pressure);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
      // value label only where it does not overlap the previous one
      if (lastLblY == null || Math.abs(lastLblY - y) >= 11) {
        ctx.fillStyle = T.dotRing;
        ctx.font      = '9px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(l.temp.toFixed(1) + '°', x + 5, y + 3);
        lastLblY = y;
      }
      ctx.fillStyle = '#ef4444';
    }
  } else if (tempLevels.length === 0) {
    // Note that only wind data is available
    ctx.fillStyle = T.windOnly;
    ctx.font      = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Wind only — no temperature data', CANVAS_W / 2, MT + 14);
  }

  // ── Wind barbs (right of plot area) ────────────────────────────────────
  const bx = ML + PLOT_W + 20;
  let lastWY = null;
  for (const l of windLevels) {
    const y = pToY(l.pressure);
    ctx.fillStyle = T.barb;
    ctx.font      = '9px monospace';
    ctx.textAlign = 'left';
    if (lastWY == null || Math.abs(lastWY - y) >= 10) {
      ctx.fillText(Math.round(l.wind_spd) + 'kt', bx + 28, y + 3);
      lastWY = y;
    }
    drawBarb(ctx, bx, y, l.wind_spd, l.wind_dir);
  }
}

// Called by base.html theme toggle so the diagram redraws with the new palette
window.onThemeChange = function () {
  // Redraw the displayed profile with the new palette (no refetch needed).
  // (Previously looked for a 'sounding-select' element that the page does not
  // have, so the diagram kept the old theme until the next Load.)
  if (lastSoundingLevels) renderSounding(lastSoundingLevels);
};

// ── Data loading ────────────────────────────────────────────────────────────
async function loadSounding() {
  const meta = document.getElementById('sounding-meta');
  meta.textContent = 'Loading…';

  try {
    const r = await fetch('/api/sounding');
    const d = await r.json();

    renderSounding(d.levels);

    meta.textContent =
      `${d.obs_used} obs used · generated ${d.generated_at} UTC`;

    // Table
    const tbody = document.getElementById('sounding-tbody');
    tbody.innerHTML = '';
    for (const l of d.levels) {
      const hasData = l.temp != null || l.wind_spd != null;
      tbody.insertAdjacentHTML('beforeend', `<tr class="${hasData ? '' : 'empty-level'}">
        <td class="num" style="font-weight:700">${l.pressure}</td>
        <td class="num">${l.altitude != null ? l.altitude.toLocaleString() : '–'}</td>
        <td class="num ${l.temp != null ? '' : 'text-dim'}">${l.temp != null ? l.temp.toFixed(1) : '–'}</td>
        <td class="num">${l.wind_spd != null ? l.wind_spd.toFixed(1) : '–'}</td>
        <td class="num">${l.wind_dir != null ? l.wind_dir.toFixed(0) + '°' : '–'}</td>
        <td class="num text-dim">${l.temp_count ?? l.wind_count ?? '–'}</td>
      </tr>`);
    }
  } catch(e) {
    meta.textContent = 'Error loading sounding data.';
    console.error(e);
  }
}
