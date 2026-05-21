/**
 * gps_quality.js — GPS Quality monitoring page for MODE-S Wind.
 *
 * Polls /api/gps/state every 30 seconds and renders:
 *   • 24-hour time-series chart  (Chart.js)
 *   • 7-day × 7 FL-band heatmap  (Canvas)
 *   • Live degraded aircraft table
 */

'use strict';

// ── Theme-aware colour helpers ────────────────────────────────────────────────
function canvasTheme() {
  const light = document.documentElement.dataset.theme === 'light';
  return {
    bg:        light ? '#dde4ec' : '#0f172a',
    grid:      light ? '#b0bec5' : '#334155',
    text:      light ? '#1e293b' : '#cbd5e1',
    textDim:   light ? '#64748b' : '#64748b',
    axisLabel: light ? '#334155' : '#94a3b8',
  };
}

// ── Heatmap colour scale ──────────────────────────────────────────────────────
// Five steps from "no events" to "high activity"
const HEAT_COLORS = [
  '#1e293b',   // 0  — no events (dark slate, almost bg)
  '#1e3a5f',   // 1  — low
  '#b45309',   // 2  — moderate (amber)
  '#dc2626',   // 3  — high (red)
  '#7f1d1d',   // 4  — very high (dark red)
];
const HEAT_COLORS_LIGHT = [
  '#e2e8f0',   // 0  — no events
  '#bfdbfe',   // 1  — low (light blue)
  '#fde68a',   // 2  — moderate (amber)
  '#fca5a5',   // 3  — high (red)
  '#f87171',   // 4  — very high
];

function heatColor(norm) {
  // norm 0..1
  const palette = document.documentElement.dataset.theme === 'light'
    ? HEAT_COLORS_LIGHT : HEAT_COLORS;
  const idx = Math.min(palette.length - 1, Math.round(norm * (palette.length - 1)));
  return palette[idx];
}

// Expose CSS variables for the legend cells (set once on load)
function applyHeatCssVars() {
  const palette = document.documentElement.dataset.theme === 'light'
    ? HEAT_COLORS_LIGHT : HEAT_COLORS;
  const root = document.documentElement;
  palette.forEach((c, i) => root.style.setProperty(`--gps-heat-${i}`, c));
}

// ── Chart.js time-series ──────────────────────────────────────────────────────
let tsChart = null;

function initTsChart() {
  const ctx = document.getElementById('gps-timeseries-canvas').getContext('2d');
  const th  = canvasTheme();
  tsChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels:   [],
      datasets: [
        {
          label:           'Events',
          data:            [],
          backgroundColor: 'rgba(56,189,248,0.75)',
          borderColor:     '#38bdf8',
          borderWidth:     1,
          order:           1,
          yAxisID:         'y',
        },
        {
          label:           'Aircraft',
          data:            [],
          type:            'line',
          borderColor:     '#94a3b8',
          borderWidth:     1.5,
          pointRadius:     2,
          pointBackgroundColor: '#94a3b8',
          fill:            false,
          tension:         0.3,
          order:           0,
          yAxisID:         'y2',
        },
      ],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      animation:           { duration: 300 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => items[0].label + ' UTC',
            label: item => {
              if (item.datasetIndex === 0) return ` Events: ${item.raw}`;
              return ` Aircraft: ${item.raw}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks:  { color: th.axisLabel, maxRotation: 45, font: { size: 10 } },
          grid:   { color: th.grid },
        },
        y: {
          beginAtZero: true,
          position: 'left',
          ticks:  { color: '#38bdf8', font: { size: 10 } },
          grid:   { color: th.grid },
          title:  { display: true, text: 'Events', color: '#38bdf8', font: { size: 10 } },
        },
        y2: {
          beginAtZero: true,
          position: 'right',
          ticks:  { color: '#94a3b8', font: { size: 10 } },
          grid:   { drawOnChartArea: false },
          title:  { display: true, text: 'Aircraft', color: '#94a3b8', font: { size: 10 } },
        },
      },
    },
  });
}

function updateTsChart(timeSeries) {
  if (!tsChart) return;
  if (!timeSeries || timeSeries.length === 0) return;

  // Generate labels for all 24 hours, filling gaps with zeros
  const now     = Date.now() / 1000;
  const buckets = [];
  for (let i = 23; i >= 0; i--) {
    const hourTs = Math.floor((now - i * 3600) / 3600) * 3600;
    buckets.push(hourTs);
  }

  const dataMap = {};
  for (const b of timeSeries) dataMap[b.ts] = b;

  const labels  = buckets.map(ts => {
    const d = new Date(ts * 1000);
    return d.getUTCHours().toString().padStart(2, '0') + ':00';
  });
  const events   = buckets.map(ts => (dataMap[ts] ? dataMap[ts].events : 0));
  const aircraft = buckets.map(ts => (dataMap[ts] ? dataMap[ts].total  : 0));

  tsChart.data.labels              = labels;
  tsChart.data.datasets[0].data    = events;
  tsChart.data.datasets[1].data    = aircraft;
  tsChart.update('none');
}

// ── Canvas heatmap ────────────────────────────────────────────────────────────
function drawHeatmap(heatmapData, flBands) {
  const canvas = document.getElementById('gps-heatmap-canvas');
  if (!canvas || !heatmapData || heatmapData.length === 0) return;

  const th       = canvasTheme();
  const ctx      = canvas.getContext('2d');
  const nBands   = flBands.length;   // 7
  const MARGIN_L = 68;  // left margin for FL labels
  const MARGIN_B = 46;  // bottom margin for date labels
  const MARGIN_T = 8;
  const MARGIN_R = 12;

  // Group buckets by day (UTC day truncated to midnight)
  const DAY_SEC  = 86_400;
  const dayMap   = {};
  for (const b of heatmapData) {
    const dayTs = Math.floor(b.ts / DAY_SEC) * DAY_SEC;
    if (!dayMap[dayTs]) dayMap[dayTs] = {};
    for (const band of flBands) {
      dayMap[dayTs][band] = (dayMap[dayTs][band] || 0) + (b.fl_bands[band] || 0);
    }
  }

  const dayKeys = Object.keys(dayMap).map(Number).sort();
  const nDays   = dayKeys.length;
  if (nDays === 0) return;

  // Canvas sizing — full width of container
  const W = canvas.parentElement.clientWidth  || 600;
  const H = 220;
  canvas.width  = W;
  canvas.height = H;

  const plotW = W - MARGIN_L - MARGIN_R;
  const plotH = H - MARGIN_T - MARGIN_B;
  const cellW = plotW / nDays;
  const cellH = plotH / nBands;

  // Find max for normalisation
  let maxVal = 1;
  for (const dt of dayKeys) {
    for (const band of flBands) {
      maxVal = Math.max(maxVal, dayMap[dt][band] || 0);
    }
  }

  // Background
  ctx.fillStyle = th.bg;
  ctx.fillRect(0, 0, W, H);

  // Cells
  dayKeys.forEach((dt, xi) => {
    flBands.forEach((band, yi) => {
      const val  = dayMap[dt][band] || 0;
      const norm = val / maxVal;
      const x    = MARGIN_L + xi * cellW;
      const y    = MARGIN_T + yi * cellH;
      ctx.fillStyle = heatColor(norm);
      ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);

      // Event count inside cell (skip zeros for clarity)
      if (val > 0) {
        ctx.fillStyle = norm > 0.5 ? '#fff' : th.text;
        ctx.font      = `bold ${Math.min(11, Math.floor(cellH * 0.45))}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(val, x + cellW / 2, y + cellH / 2);
      }
    });
  });

  // FL band labels (Y axis)
  ctx.fillStyle   = th.axisLabel;
  ctx.font        = '10px sans-serif';
  ctx.textAlign   = 'right';
  ctx.textBaseline = 'middle';
  flBands.forEach((band, yi) => {
    const y = MARGIN_T + yi * cellH + cellH / 2;
    ctx.fillText('FL' + band, MARGIN_L - 4, y);
  });

  // Day labels (X axis)
  ctx.textAlign   = 'center';
  ctx.textBaseline = 'top';
  dayKeys.forEach((dt, xi) => {
    const x   = MARGIN_L + xi * cellW + cellW / 2;
    const y   = MARGIN_T + plotH + 4;
    const d   = new Date(dt * 1000);
    const lbl = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    ctx.fillText(lbl, x, y);
    // Day-of-week
    const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()];
    ctx.fillStyle = th.textDim;
    ctx.fillText(dow, x, y + 13);
    ctx.fillStyle = th.axisLabel;
  });

  // Grid lines between rows
  ctx.strokeStyle = th.grid;
  ctx.lineWidth   = 0.5;
  for (let yi = 1; yi < nBands; yi++) {
    const y = MARGIN_T + yi * cellH;
    ctx.beginPath();
    ctx.moveTo(MARGIN_L, y);
    ctx.lineTo(W - MARGIN_R, y);
    ctx.stroke();
  }
}

// ── Live table ────────────────────────────────────────────────────────────────
const FLAG_HTML = {
  nacp:   '<span class="gps-flag gps-flag-nacp">NACp</span>',
  freeze: '<span class="gps-flag gps-flag-freeze">Freeze</span>',
  gap:    '<span class="gps-flag gps-flag-gap">Gap</span>',
};

function renderLiveTable(liveEvents) {
  const tbody = document.getElementById('gps-live-tbody');
  if (!liveEvents || liveEvents.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="gps-no-data">No degraded aircraft detected</td></tr>';
    document.getElementById('gps-live-count').textContent = '0';
    return;
  }

  document.getElementById('gps-live-count').textContent = liveEvents.length;

  tbody.innerHTML = liveEvents.map(ac => {
    const cs    = ac.callsign || '—';
    const alt   = ac.altitude != null ? Math.round(ac.altitude).toLocaleString() : '—';
    const fl    = ac.fl_band  || '—';
    const gs    = ac.groundspeed != null ? Math.round(ac.groundspeed) : '—';
    const nacp  = ac.nac_p    != null ? ac.nac_p : '—';
    const flags = (ac.flags || []).map(f => FLAG_HTML[f] || f).join(' ');
    return `<tr>
      <td class="gps-td-cs">${cs}</td>
      <td class="gps-td-icao">${ac.icao}</td>
      <td>${fl}</td>
      <td>${alt}</td>
      <td>${gs}</td>
      <td>${nacp}</td>
      <td>${flags}</td>
    </tr>`;
  }).join('');
}

// ── Summary bar ───────────────────────────────────────────────────────────────
function renderStats(stats) {
  document.getElementById('gps-events-24h').textContent   = stats.events_24h   ?? '—';
  document.getElementById('gps-degraded-24h').textContent = stats.degraded_24h ?? '—';
  document.getElementById('gps-peak-hour').textContent    = stats.peak_hour    || 'None';
}

// ── Main poll loop ────────────────────────────────────────────────────────────
let lastFlBands = [];

async function fetchGpsState() {
  try {
    const r = await fetch('/api/gps/state');
    if (!r.ok) return;
    const d = await r.json();

    lastFlBands = d.fl_bands || lastFlBands;

    renderStats(d.stats || {});
    updateTsChart(d.time_series || []);
    drawHeatmap(d.heatmap || [], lastFlBands);
    renderLiveTable(d.live || []);

    const now = new Date();
    document.getElementById('gps-updated').textContent =
      'Updated ' + now.getUTCHours().toString().padStart(2,'0') + ':' +
      now.getUTCMinutes().toString().padStart(2,'0') + ' UTC';

  } catch (_) { /* silent */ }
}

// ── Initialise ────────────────────────────────────────────────────────────────
applyHeatCssVars();
initTsChart();
fetchGpsState();
setInterval(fetchGpsState, 30_000);

// Redraw canvases on theme change
window.onThemeChange = function () {
  applyHeatCssVars();
  // Update Chart.js colours
  if (tsChart) {
    const th = canvasTheme();
    tsChart.options.scales.x.ticks.color    = th.axisLabel;
    tsChart.options.scales.x.grid.color     = th.grid;
    tsChart.options.scales.y.grid.color     = th.grid;
    tsChart.update('none');
  }
  // Redraw heatmap with new theme
  fetchGpsState();
};

// Redraw heatmap on window resize
window.addEventListener('resize', () => {
  if (lastFlBands.length > 0) fetchGpsState();
});
