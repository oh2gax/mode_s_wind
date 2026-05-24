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
    ctx.fillStyle = T.label;
    ctx.textAlign = 'right';
    ctx.fillText(p, ML - 6, y + 4);
  }

  // Isotherms (skewed temperature lines)
  const isotherms = [-80,-70,-60,-50,-40,-30,-20,-10,0,10,20,30];
  for (const t of isotherms) {
    ctx.strokeStyle = t === 0 ? T.isotherm0 : T.isothermN;
    ctx.beginPath();
    ctx.moveTo(tToX(t, P_BOTTOM), pToY(P_BOTTOM));
    ctx.lineTo(tToX(t, P_TOP),    pToY(P_TOP));
    ctx.stroke();
    // Label at bottom
    const x = tToX(t, P_BOTTOM);
    if (x > ML && x < ML + PLOT_W) {
      ctx.fillStyle = T.isotLabel;
      ctx.textAlign = 'center';
      ctx.fillText(t + '°', x, CANVAS_H - MB + 14);
    }
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
function renderSounding(levels) {
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
    for (const l of tempLevels) {
      const x = tToX(l.temp, l.pressure);
      const y = pToY(l.pressure);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = T.dotRing;
      ctx.font      = '9px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(l.temp.toFixed(1) + '°', x + 5, y + 3);
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
  for (const l of windLevels) {
    const y = pToY(l.pressure);
    ctx.fillStyle = T.barb;
    ctx.font      = '9px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(Math.round(l.wind_spd) + 'kt', bx + 28, y + 3);
    drawBarb(ctx, bx, y, l.wind_spd, l.wind_dir);
  }
}

// Called by base.html theme toggle so the diagram redraws with the new palette
window.onThemeChange = function () {
  // Re-render only if there is data already displayed (skewt-canvas has content)
  const sel = document.getElementById('sounding-select');
  if (sel && sel.value) loadSounding();
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
