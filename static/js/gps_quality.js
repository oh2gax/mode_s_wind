/**
 * gps_quality.js — GPS Quality monitoring page for MODE-S Wind.
 *
 * Polls /api/gps/state every 30 seconds and renders:
 *   • 24-hour time-series chart  (Chart.js)
 *   • 14-day × 8 FL-band heatmap  (Canvas)
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

// ── Range selector state ──────────────────────────────────────────────────────
const RANGE_CONFIG = {
  '1d': { hours: 24,  aggregate: 'hour', title: 'Last 24 Hours',  maxTicks: 24 },
  '2d': { hours: 48,  aggregate: 'hour', title: 'Last 2 Days',    maxTicks: 12 },
  '3d': { hours: 72,  aggregate: 'hour', title: 'Last 3 Days',    maxTicks: 12 },
  '1w': { hours: 168, aggregate: 'day',  title: 'Last 7 Days',    maxTicks: 7  },
  '1m': { hours: 744, aggregate: 'day',  title: 'Last 31 Days',   maxTicks: 31 },
};
let currentRange = localStorage.getItem('ms_gps_range') || '1d';
let lastFullTimeSeries = [];

function applyRange(range) {
  if (!RANGE_CONFIG[range]) return;
  currentRange = range;
  localStorage.setItem('ms_gps_range', range);
  document.querySelectorAll('.gps-range-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.range === range);
  });
  const cfg = RANGE_CONFIG[range];
  const titleEl = document.getElementById('gps-chart-title');
  if (titleEl) titleEl.textContent = 'GPS Degradation Events — ' + cfg.title;
  if (lastFullTimeSeries.length > 0) updateTsChart(lastFullTimeSeries);
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
          label:           'NACp',
          data:            [],
          backgroundColor: 'rgba(251,146,60,0.85)',   // amber
          borderColor:     '#fb923c',
          borderWidth:     1,
          stack:           'events',
          order:           2,
          yAxisID:         'y',
        },
        {
          label:           'Freeze',
          data:            [],
          backgroundColor: 'rgba(56,189,248,0.85)',   // sky blue
          borderColor:     '#38bdf8',
          borderWidth:     1,
          stack:           'events',
          order:           3,
          yAxisID:         'y',
        },
        {
          label:           'Gap',
          data:            [],
          backgroundColor: 'rgba(167,139,250,0.85)',  // violet
          borderColor:     '#a78bfa',
          borderWidth:     1,
          stack:           'events',
          order:           4,
          yAxisID:         'y',
        },
        {
          // Fallback for historical hours recorded before per-signal breakdown
          // was introduced.  Shows the legacy 'events' total when all three
          // signal counts are zero.  Will disappear naturally as old hours age
          // out of the 24-hour window.
          label:           'Unknown',
          data:            [],
          backgroundColor: 'rgba(100,116,139,0.65)',  // slate grey
          borderColor:     '#64748b',
          borderWidth:     1,
          stack:           'events',
          order:           5,
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
        legend: {
          display: true,
          labels: { color: th.text, font: { size: 11 }, boxWidth: 12, padding: 8 },
        },
        tooltip: {
          callbacks: {
            title: items => items[0].label + ' UTC',
            label: item => {
              const names = ['NACp', 'Freeze', 'Gap', 'Unknown', 'Aircraft'];
              return ` ${names[item.datasetIndex]}: ${item.raw}`;
            },
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          ticks:  { color: th.axisLabel, maxRotation: 45, font: { size: 10 } },
          grid:   { color: th.grid },
        },
        y: {
          stacked:     true,
          beginAtZero: true,
          position:    'left',
          ticks:  { color: th.axisLabel, font: { size: 10 } },
          grid:   { color: th.grid },
          title:  { display: true, text: 'Events', color: th.axisLabel, font: { size: 10 } },
        },
        y2: {
          beginAtZero: true,
          position:    'right',
          ticks:  { color: '#94a3b8', font: { size: 10 } },
          grid:   { drawOnChartArea: false },
          title:  { display: true, text: 'Aircraft', color: '#94a3b8', font: { size: 10 } },
        },
      },
    },
  });
}

function _unknownEvents(b) {
  // Legacy hours where per-signal breakdown is absent: show events total as 'Unknown'
  const hasBreakdown = (b.nacp_events || 0) + (b.freeze_events || 0) + (b.gap_events || 0) > 0;
  return hasBreakdown ? 0 : (b.events || 0);
}

function updateTsChart(allBuckets) {
  if (!tsChart) return;
  if (!allBuckets || allBuckets.length === 0) return;

  lastFullTimeSeries = allBuckets;

  const cfg    = RANGE_CONFIG[currentRange] || RANGE_CONFIG['1d'];
  const now    = Date.now() / 1000;
  const cutoff = now - cfg.hours * 3600;

  // Build a lookup of all incoming buckets
  const dataMap = {};
  for (const b of allBuckets) dataMap[b.ts] = b;

  let labels, nacp, freeze, gap, unknown, aircraft;

  if (cfg.aggregate === 'hour') {
    // ── Hourly bars ──────────────────────────────────────────────────────────
    const nowHour = Math.floor(now / 3600) * 3600;
    const slots   = [];
    for (let i = cfg.hours - 1; i >= 0; i--) slots.push(nowHour - i * 3600);

    labels = slots.map(ts => {
      const d  = new Date(ts * 1000);
      const hh = d.getUTCHours().toString().padStart(2, '0');
      if (cfg.hours <= 24) {
        return hh + ':00';
      }
      // 2d / 3d: prefix with month/day when hour = 0 (midnight) or first slot
      const isFirst    = ts === slots[0];
      const isMidnight = d.getUTCHours() === 0;
      const prefix     = (isFirst || isMidnight)
        ? `${d.getUTCMonth() + 1}/${d.getUTCDate()} ` : '';
      return prefix + hh + 'h';
    });

    nacp     = slots.map(ts => dataMap[ts]?.nacp_events   || 0);
    freeze   = slots.map(ts => dataMap[ts]?.freeze_events || 0);
    gap      = slots.map(ts => dataMap[ts]?.gap_events    || 0);
    unknown  = slots.map(ts => dataMap[ts] ? _unknownEvents(dataMap[ts]) : 0);
    aircraft = slots.map(ts => dataMap[ts]?.total         || 0);

  } else {
    // ── Daily aggregate bars ─────────────────────────────────────────────────
    const nowDay = Math.floor(now / 86400) * 86400;
    const nDays  = cfg.hours / 24;
    const days   = [];
    for (let i = nDays - 1; i >= 0; i--) days.push(nowDay - i * 86400);

    // Aggregate hourly buckets into day bins
    const dayMap = {};
    for (const b of allBuckets) {
      if (b.ts < cutoff) continue;
      const dayTs = Math.floor(b.ts / 86400) * 86400;
      if (!dayMap[dayTs]) dayMap[dayTs] = { nacp: 0, freeze: 0, gap: 0, unknown: 0, maxTotal: 0 };
      dayMap[dayTs].nacp    += b.nacp_events   || 0;
      dayMap[dayTs].freeze  += b.freeze_events || 0;
      dayMap[dayTs].gap     += b.gap_events    || 0;
      dayMap[dayTs].unknown += _unknownEvents(b);
      // Peak hourly aircraft count = best proxy for daily traffic volume
      dayMap[dayTs].maxTotal = Math.max(dayMap[dayTs].maxTotal, b.total || 0);
    }

    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    labels = days.map(ts => {
      const d = new Date(ts * 1000);
      return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${DOW[d.getUTCDay()]}`;
    });

    nacp     = days.map(ts => dayMap[ts]?.nacp     || 0);
    freeze   = days.map(ts => dayMap[ts]?.freeze   || 0);
    gap      = days.map(ts => dayMap[ts]?.gap      || 0);
    unknown  = days.map(ts => dayMap[ts]?.unknown  || 0);
    aircraft = days.map(ts => dayMap[ts]?.maxTotal || 0);
  }

  // Adjust x-axis tick density for the active range
  tsChart.options.scales.x.ticks.maxTicksLimit = cfg.maxTicks;

  tsChart.data.labels           = labels;
  tsChart.data.datasets[0].data = nacp;
  tsChart.data.datasets[1].data = freeze;
  tsChart.data.datasets[2].data = gap;
  tsChart.data.datasets[3].data = unknown;
  tsChart.data.datasets[4].data = aircraft;
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

  const HEATMAP_MAX_DAYS = 14;
  const allDayKeys = Object.keys(dayMap).map(Number).sort();
  // Keep only the most recent 14 days
  const dayKeys = allDayKeys.slice(-HEATMAP_MAX_DAYS);
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


// ── Live table ──────────────────────────────────────────────────────────────────────────────
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

// ── FL band donut + 14-day stats panel ───────────────────────────────────────
let donutChart = null;

const DONUT_COLORS = [
  '#38bdf8',  // 010-030  sky blue
  '#818cf8',  // 030-050  indigo
  '#34d399',  // 050-100  emerald
  '#fb923c',  // 100-150  orange
  '#f472b6',  // 150-200  pink
  '#a78bfa',  // 200-250  violet
  '#fbbf24',  // 250-300  amber
  '#94a3b8',  // 300+     slate
];

function drawDonutAndStats(heatmapData, flBands) {
  if (!heatmapData || heatmapData.length === 0 || !flBands || flBands.length === 0) return;

  // Limit to most recent 14 days (mirror heatmap cap)
  const DAY_SEC = 86_400;
  const cutoff  = (Date.now() / 1000) - 14 * DAY_SEC;
  const recent  = heatmapData.filter(b => b.ts >= cutoff);
  if (recent.length === 0) return;

  // Accumulate per-band and per-signal totals
  const bandTotals = Object.fromEntries(flBands.map(b => [b, 0]));
  const dayTotals  = {};
  let totalEvents = 0, totalNacp = 0, totalFreeze = 0, totalGap = 0;

  for (const b of recent) {
    totalEvents += b.events;
    totalNacp   += b.nacp_events   || 0;
    totalFreeze += b.freeze_events || 0;
    totalGap    += b.gap_events    || 0;
    for (const band of flBands) bandTotals[band] += b.fl_bands[band] || 0;
    const dayTs = Math.floor(b.ts / DAY_SEC) * DAY_SEC;
    dayTotals[dayTs] = (dayTotals[dayTs] || 0) + b.events;
  }

  // Worst day
  let worstDayTs = null, worstDayCount = 0;
  for (const [ts, cnt] of Object.entries(dayTotals)) {
    if (cnt > worstDayCount) { worstDayCount = cnt; worstDayTs = Number(ts); }
  }

  // Most affected FL band
  let topBand = flBands[0], topBandCount = 0;
  for (const band of flBands) {
    if (bandTotals[band] > topBandCount) { topBandCount = bandTotals[band]; topBand = band; }
  }

  // ── Donut chart ──────────────────────────────────────────────────────────
  const canvas = document.getElementById('gps-donut-canvas');
  if (canvas) {
    const isLight = document.documentElement.dataset.theme === 'light';
    const legendColor = isLight ? '#334155' : '#94a3b8';
    const borderColor = isLight ? '#dde4ec' : '#0f172a';

    if (donutChart) { donutChart.destroy(); donutChart = null; }
    donutChart = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels:   flBands.map(b => 'FL' + b),
        datasets: [{
          data:            flBands.map(b => bandTotals[b]),
          backgroundColor: DONUT_COLORS.slice(0, flBands.length),
          borderColor:     borderColor,
          borderWidth:     2,
        }],
      },
      options: {
        responsive:          true,
        maintainAspectRatio: true,
        aspectRatio:         1.5,   // width:height — legend on left so more vertical room for donut
        cutout:              '58%',
        plugins: {
          legend: {
            position: 'left',
            labels: {
              color:    legendColor,
              font:     { size: 10, family: 'monospace' },
              boxWidth: 11,
              padding:  5,
            },
          },
          tooltip: {
            callbacks: {
              label: ctx => {
                const pct = totalEvents > 0 ? Math.round(ctx.raw / totalEvents * 100) : 0;
                return ` ${ctx.raw.toLocaleString()} events (${pct}%)`;
              },
            },
          },
        },
      },
    });
  }

  // ── Stats panel ──────────────────────────────────────────────────────────
  const pct = (n, tot) => tot > 0 ? ` (${Math.round(n / tot * 100)}%)` : '';
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

  const worstDayStr = worstDayTs
    ? new Date(worstDayTs * 1000).toLocaleDateString('en-GB',
        { day: 'numeric', month: 'short', timeZone: 'UTC' })
    : '—';

  set('gps-stat-total',     totalEvents > 0 ? totalEvents.toLocaleString() : '—');
  set('gps-stat-top-band',  topBandCount > 0 ? `FL${topBand}  (${topBandCount.toLocaleString()})` : '—');
  set('gps-stat-worst-day', worstDayCount > 0 ? `${worstDayStr}  (${worstDayCount.toLocaleString()})` : '—');
  set('gps-stat-nacp',   totalNacp   > 0 ? `${totalNacp.toLocaleString()}${pct(totalNacp,   totalEvents)}` : '—');
  set('gps-stat-freeze', totalFreeze > 0 ? `${totalFreeze.toLocaleString()}${pct(totalFreeze, totalEvents)}` : '—');
  set('gps-stat-gap',    totalGap    > 0 ? `${totalGap.toLocaleString()}${pct(totalGap,    totalEvents)}` : '—');
}

// ── Summary bar ─────────────────────────────────────────────────────────────────────────────
function renderStats(stats) {
  document.getElementById('gps-events-24h').textContent   = stats.events_24h   ?? '—';
  document.getElementById('gps-degraded-24h').textContent = stats.degraded_24h ?? '—';
  document.getElementById('gps-peak-hour').textContent    = stats.peak_hour    || 'None';
}

// ── Main poll loop ────────────────────────────────────────────────────────────────────────────
let lastFlBands    = [];
let lastHeatmapData = [];   // retained for hourly donut refresh
let donutDrawn     = false; // draw once on first load; thereafter only on hourly tick

async function fetchGpsState() {
  try {
    const r = await fetch('/api/gps/state');
    if (!r.ok) return;
    const d = await r.json();

    lastFlBands    = d.fl_bands || lastFlBands;
    lastHeatmapData = d.heatmap || lastHeatmapData;

    renderStats(d.stats || {});
    updateTsChart(d.time_series || []);
    drawHeatmap(d.heatmap || [], lastFlBands);
    // Donut drawn only on first load; hourly interval handles subsequent refreshes
    if (!donutDrawn) { drawDonutAndStats(lastHeatmapData, lastFlBands); donutDrawn = true; }
    renderLiveTable(d.live || []);

    const now = new Date();
    document.getElementById('gps-updated').textContent =
      'Updated ' + now.getUTCHours().toString().padStart(2,'0') + ':' +
      now.getUTCMinutes().toString().padStart(2,'0') + ' UTC';

  } catch (_) { /* silent */ }
}

// ── Initialise ────────────────────────────────────────────────────────────────────────────────
applyHeatCssVars();
initTsChart();

// Wire up range selector buttons
document.querySelectorAll('.gps-range-btn').forEach(btn => {
  btn.addEventListener('click', () => applyRange(btn.dataset.range));
});
// Restore saved range (updates button state + chart title without data yet)
applyRange(currentRange);

fetchGpsState();
setInterval(fetchGpsState, 30_000);
setInterval(() => drawDonutAndStats(lastHeatmapData, lastFlBands), 60 * 60 * 1000); // hourly

// Redraw canvases on theme change
window.onThemeChange = function () {
  applyHeatCssVars();
  // Update Chart.js colours
  if (tsChart) {
    const th = canvasTheme();
    tsChart.options.plugins.legend.labels.color  = th.text;
    tsChart.options.scales.x.ticks.color         = th.axisLabel;
    tsChart.options.scales.x.grid.color          = th.grid;
    tsChart.options.scales.y.ticks.color         = th.axisLabel;
    tsChart.options.scales.y.grid.color          = th.grid;
    tsChart.options.scales.y.title.color         = th.axisLabel;
    tsChart.update('none');
  }
  // Redraw heatmap with new theme
  fetchGpsState();
};

// Redraw heatmap on window resize
window.addEventListener('resize', () => {
  if (lastFlBands.length > 0) fetchGpsState();
});
