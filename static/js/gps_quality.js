/**
 * gps_quality.js — GPS Quality monitoring page for MODE-S Wind.
 *
 * Polls /api/gps/state every 30 seconds and renders:
 *   • 24-hour time-series chart  (Chart.js); "10 min" view from /api/gps/detail
 *   • Severity & spoofing panel (/api/gps/detail, every 60 s)
 *   • FL-band heatmap  (Canvas) — 14d / 1m day-range selector, 9 FL bands
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

// ── Zone selector state ───────────────────────────────────────────────────────
let currentZone = localStorage.getItem('ms_gps_zone') || 'all';

function applyZone(zone) {
  currentZone = zone;
  localStorage.setItem('ms_gps_zone', zone);
  document.querySelectorAll('.gps-zone-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.zone === zone);
  });
  // Re-fetch immediately so charts update without waiting for the next interval
  fetchGpsState();
  refreshT10();
  refreshSpoofPanel();
}

// ── Range selector state ──────────────────────────────────────────────────────
const RANGE_CONFIG = {
  '1d': { hours:   24, aggregate: 'hour', title: 'Last 24 Hours',  maxTicks: 24 },
  '2d': { hours:   48, aggregate: 'hour', title: 'Last 2 Days',    maxTicks: 12 },
  '3d': { hours:   72, aggregate: 'hour', title: 'Last 3 Days',    maxTicks: 12 },
  '1w': { hours:  168, aggregate: 'hour', title: 'Last 7 Days',    maxTicks:  7 },
  '2w': { hours:  336, aggregate: 'day',  title: 'Last 14 Days',   maxTicks: 14 },
  '1m': { hours:  744, aggregate: 'day',  title: 'Last 31 Days',   maxTicks: 31 },
  '3m': { hours: 2160, aggregate: 'day',  title: 'Last 3 Months',  maxTicks: 13 },
  '6m': { hours: 4320, aggregate: 'day',  title: 'Last 6 Months',  maxTicks: 13 },
};
let currentRange = localStorage.getItem('ms_gps_range') || '1d';
let lastFullTimeSeries = [];

function applyRange(range) {
  if (!RANGE_CONFIG[range]) return;
  currentRange = range;
  localStorage.setItem('ms_gps_range', range);
  // Scoped to the time-series panel's own button group — #gps-heatmap-range-btns
  // reuses the same .gps-range-btn class for styling and must not be touched here.
  document.querySelectorAll('#gps-range-btns .gps-range-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.range === range);
  });
  updateTsTitle();
  if (lastFullTimeSeries.length > 0) updateTsChart(lastFullTimeSeries);
  refreshT10();
}

// ── Heatmap day-range selector (independent of the time-series range above) ──
// The server already caps the heatmap payload at HEATMAP_MAX_BUCKETS (31 days
// — see collector/gps_quality.py), so both options here are served from data
// already present in lastHeatmapData; switching never needs a new fetch.
const HEATMAP_RANGE_CONFIG = {
  '14d': { days: 14, title: 'Last 14 Days' },
  '1m':  { days: 31, title: 'Last 31 Days' },
};
let currentHeatmapRange = localStorage.getItem('ms_gps_heatmap_range') || '14d';

function applyHeatmapRange(range) {
  if (!HEATMAP_RANGE_CONFIG[range]) return;
  currentHeatmapRange = range;
  localStorage.setItem('ms_gps_heatmap_range', range);
  document.querySelectorAll('#gps-heatmap-range-btns .gps-range-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.heatmapRange === range);
  });
  const cfg = HEATMAP_RANGE_CONFIG[range];
  const titleEl = document.getElementById('gps-heatmap-title');
  if (titleEl) titleEl.textContent = 'FL Band Heatmap — ' + cfg.title;
  // Redraw immediately from cached data — no fetch needed (see comment above).
  if (lastHeatmapData.length > 0) drawHeatmap(lastHeatmapData, lastFlBands);
}

// ── Chart.js time-series ──────────────────────────────────────────────────────
let tsChart = null;

// ── Counting-method changes ───────────────────────────────────────────────────
// Every hourly bucket carries the counting-method version it was recorded
// with (collector/gps_quality.py METHOD_VERSION).  Where the version changes
// the charts draw a dashed marker: numbers on either side are not comparable.
const METHOD_LABELS = {
  2: 'Method v2: stale aircraft state removed',
  3: 'Method v3: ADS-B loss per visit',
  4: 'Method v4: own reception only, clean Freeze/Gap, NIC signal',
};

/** Timestamps (hour starts) where the method differs from the previous bucket. */
function methodChangeTimes(buckets) {
  const out = [];
  let prev = null;
  for (const b of [...buckets].sort((a, c) => a.ts - c.ts)) {
    const m = b.method || 1;
    if (prev !== null && m !== prev) out.push({ ts: b.ts, method: m });
    prev = m;
  }
  return out;
}

// Chart.js plugin: dashed vertical line + short label at each method change
const methodMarkerPlugin = {
  id: 'methodMarkers',
  afterDatasetsDraw(chart) {
    const marks = chart.$methodMarks || [];
    if (!marks.length) return;
    const xs = chart.scales.x, area = chart.chartArea, ctx = chart.ctx;
    const n  = chart.data.labels.length;
    const half = n > 1 ? (xs.getPixelForValue(1) - xs.getPixelForValue(0)) / 2 : 0;
    ctx.save();
    for (const mk of marks) {
      const x = xs.getPixelForValue(mk.index) - half;
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(x, area.top); ctx.lineTo(x, area.bottom); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#f59e0b';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(mk.methods.map(m => 'v' + m).join(' '), x + 3, area.top + 2);
    }
    ctx.restore();
  },
};

function initTsChart() {
  const ctx = document.getElementById('gps-timeseries-canvas').getContext('2d');
  const th  = canvasTheme();
  tsChart = new Chart(ctx, {
    plugins: [methodMarkerPlugin],
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
          // NIC (integrity / containment radius) — self-reported, from the
          // airborne-position type code.  Recorded from counting method v4.
          label:           'NIC',
          data:            [],
          backgroundColor: 'rgba(244,114,182,0.85)',  // rose
          borderColor:     '#f472b6',
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
          label:           'ADS-B',
          data:            [],
          backgroundColor: 'rgba(20,184,166,0.85)',   // teal
          borderColor:     '#14b8a6',
          borderWidth:     1,
          stack:           'events',
          order:           5,
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
        {
          // Normalised degradation index: events per aircraft-hour
          // (events ÷ sum of hourly unique-aircraft counts).  Comparable
          // between days with different traffic volume.
          label:           'Events / aircraft',
          data:            [],
          type:            'line',
          borderColor:     '#facc15',
          borderWidth:     1.5,
          borderDash:      [4, 3],
          pointRadius:     1.5,
          pointBackgroundColor: '#facc15',
          fill:            false,
          tension:         0.3,
          order:           0,
          yAxisID:         'y3',
          spanGaps:        false,
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
              const names = ['NACp', 'NIC', 'Freeze', 'Gap', 'ADS-B', 'Unknown',
                             tsChart.$aircraftLabel || 'Aircraft', 'Events / aircraft'];
              // Signal segments: show the real (unscaled) count of that signal
              if (item.datasetIndex <= 5 && tsChart.$rawSignals)
                return ` ${names[item.datasetIndex]}: ${tsChart.$rawSignals[item.datasetIndex][item.dataIndex]}`;
              return ` ${names[item.datasetIndex]}: ${item.raw}`;
            },
            footer: items => {
              const i = items[0].dataIndex, ev = tsChart.$events?.[i];
              if (ev == null || !tsChart.$rawSignals) return [];
              const sum = tsChart.$rawSignals.reduce((a, arr) => a + arr[i], 0);
              return [`Events: ${ev}  (signals raised: ${sum})`,
                      'Bar height = events; colours = share of each signal'];
            },
            // Explain a counting-method change when hovering its bar
            afterBody: items => {
              const mk = (tsChart.$methodMarks || []).find(m => m.index === items[0].dataIndex);
              return mk ? ['', ...mk.methods.map(m => '⚠ ' + (METHOD_LABELS[m] || ('Method v' + m))),
                           '  values before/after are not comparable'] : [];
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
        y3: {
          display:     'auto',          // shown only while the index line is visible
          beginAtZero: true,
          position:    'right',
          ticks:  { color: '#facc15', font: { size: 10 } },
          grid:   { drawOnChartArea: false },
          title:  { display: true, text: 'Events / aircraft', color: '#facc15', font: { size: 10 } },
        },
      },
    },
  });
}

function _unknownEvents(b) {
  // Legacy hours where per-signal breakdown is absent: show events total as 'Unknown'
  const hasBreakdown = (b.nacp_events || 0) + (b.nic_events || 0) + (b.freeze_events || 0)
                     + (b.gap_events  || 0) + (b.adsb_loss_events || 0) > 0;
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

  let labels, nacp, nic, freeze, gap, adsbLoss, unknown, aircraft, index, markIndex, events;

  if (cfg.aggregate === 'hour') {
    // ── Hourly bars ──────────────────────────────────────────────────────────
    const nowHour = Math.floor(now / 3600) * 3600;
    const slots   = [];
    for (let i = cfg.hours - 1; i >= 0; i--) slots.push(nowHour - i * 3600);

    labels = slots.map(ts => {
      const d  = new Date(ts * 1000);
      const hh = d.getUTCHours().toString().padStart(2, '0');
      if (cfg.hours <= 24) {
        // 1d: plain HH:00 — all bars are within one known day
        return hh + ':00';
      }
      // 2d / 3d / 1w: always include M/D so every tick label is self-contained.
      // Chart.js may skip any tick based on maxTicksLimit, so relying on only
      // midnight bars carrying the date prefix made most labels unreadable.
      return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hh}h`;
    });

    nacp     = slots.map(ts => dataMap[ts]?.nacp_events        || 0);
    nic      = slots.map(ts => dataMap[ts]?.nic_events         || 0);
    freeze   = slots.map(ts => dataMap[ts]?.freeze_events      || 0);
    gap      = slots.map(ts => dataMap[ts]?.gap_events         || 0);
    adsbLoss = slots.map(ts => dataMap[ts]?.adsb_loss_events   || 0);
    unknown  = slots.map(ts => dataMap[ts] ? _unknownEvents(dataMap[ts]) : 0);
    events   = slots.map(ts => dataMap[ts]?.events             || 0);
    aircraft = slots.map(ts => dataMap[ts]?.total              || 0);
    index    = slots.map(ts => {
      const b = dataMap[ts];
      return (b && b.total > 0) ? Math.round(b.events / b.total * 10) / 10 : null;
    });
    markIndex = ts => slots.indexOf(Math.floor(ts / 3600) * 3600);
    tsChart.$aircraftLabel = 'Aircraft';

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
      if (!dayMap[dayTs]) dayMap[dayTs] = { nacp: 0, nic: 0, freeze: 0, gap: 0, adsbLoss: 0, unknown: 0,
                                            events: 0, acHours: 0, hours: 0 };
      dayMap[dayTs].nacp     += b.nacp_events        || 0;
      dayMap[dayTs].nic      += b.nic_events         || 0;
      dayMap[dayTs].freeze   += b.freeze_events      || 0;
      dayMap[dayTs].gap      += b.gap_events         || 0;
      dayMap[dayTs].adsbLoss += b.adsb_loss_events   || 0;
      dayMap[dayTs].unknown  += _unknownEvents(b);
      // Traffic: sum of hourly unique-aircraft counts (aircraft-hours) and
      // number of hours with data → average aircraft per hour.  Unlike the
      // former busiest-hour value this is not distorted by one partial hour
      // (restart) or by a day that is still in progress.
      dayMap[dayTs].events  += b.events || 0;
      dayMap[dayTs].acHours += b.total  || 0;
      dayMap[dayTs].hours   += 1;
    }

    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    labels = days.map(ts => {
      const d = new Date(ts * 1000);
      return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${DOW[d.getUTCDay()]}`;
    });

    nacp     = days.map(ts => dayMap[ts]?.nacp     || 0);
    nic      = days.map(ts => dayMap[ts]?.nic      || 0);
    freeze   = days.map(ts => dayMap[ts]?.freeze   || 0);
    gap      = days.map(ts => dayMap[ts]?.gap      || 0);
    adsbLoss = days.map(ts => dayMap[ts]?.adsbLoss || 0);
    unknown  = days.map(ts => dayMap[ts]?.unknown  || 0);
    events   = days.map(ts => dayMap[ts]?.events   || 0);
    aircraft = days.map(ts => {
      const d = dayMap[ts];
      return d && d.hours ? Math.round(d.acHours / d.hours * 10) / 10 : 0;
    });
    index    = days.map(ts => {
      const d = dayMap[ts];
      return d && d.acHours > 0 ? Math.round(d.events / d.acHours * 10) / 10 : null;
    });
    markIndex = ts => days.indexOf(Math.floor(ts / 86400) * 86400);
    tsChart.$aircraftLabel = 'Aircraft (avg / hour)';
  }

  // Method-change markers inside the displayed range
  // Several changes inside one bar (e.g. v3 and v4 on the same day in the
  // daily views) are merged into one marker listing all versions.
  const _marks = {};
  for (const m of methodChangeTimes(allBuckets)) {
    if (m.ts < cutoff) continue;
    const idx = markIndex(m.ts);
    if (idx <= 0) continue;
    (_marks[idx] = _marks[idx] || { index: idx, methods: [] }).methods.push(m.method);
  }
  tsChart.$methodMarks = Object.values(_marks);
  tsChart.options.scales.y2.title.text = tsChart.$aircraftLabel;

  // Adjust x-axis tick density for the active range
  tsChart.options.scales.x.ticks.maxTicksLimit = cfg.maxTicks;

  // ── Scale the stacked segments so each bar's height = distinct events ──
  // One sweep of one aircraft can raise several signals at once (typically
  // NACp + ADS-B loss for a jammed aircraft), so the plain sum of signal
  // counts over-states the degraded aircraft-time.  Each segment is scaled by
  // events ÷ (sum of signal counts): the bar height becomes the number of
  // events and the colours show each signal's share.  Unscaled counts are
  // kept for the tooltip.
  const raw = [nacp, nic, freeze, gap, adsbLoss, unknown];
  const scaled = raw.map(() => []);
  for (let i = 0; i < labels.length; i++) {
    const sum = raw.reduce((a, arr) => a + arr[i], 0);
    const f   = sum > 0 ? events[i] / sum : 0;
    raw.forEach((arr, k) => { scaled[k][i] = Math.round(arr[i] * f * 10) / 10; });
  }
  tsChart.$rawSignals = raw;
  tsChart.$events     = events;

  tsChart.data.labels           = labels;
  tsChart.data.datasets[0].data = scaled[0];
  tsChart.data.datasets[1].data = scaled[1];
  tsChart.data.datasets[2].data = scaled[2];
  tsChart.data.datasets[3].data = scaled[3];
  tsChart.data.datasets[4].data = scaled[4];
  tsChart.data.datasets[5].data = scaled[5];
  tsChart.data.datasets[6].data = aircraft;
  tsChart.data.datasets[7].data = index;
  tsChart.update('none');
}

// ── Canvas heatmap ────────────────────────────────────────────────────────────
const HEATMAP_MIN_SEGMENT_DAYS = 3;

// Heatmap mode: 'events' (event counts, per-row scaling) or 'pct' (% of the
// aircraft in the band that were degraded, from the per-band detail recorded
// since 2026-10-06; one absolute scale for all rows).
let heatmapMode  = localStorage.getItem('ms_gps_heatmap_mode') === 'pct' ? 'pct' : 'events';
let lastBandDays = {};     // {dayTs: {band: {ac, deg, sig}}} from /api/gps/state
let heatLayout   = null;   // geometry of the last drawn heatmap (hover / click)
const HEAT_PCT_STEPS = [10, 25, 50];   // % thresholds between colour steps 1–4
const HEAT_LEGEND = {
  events: { txt: 'None → High',
            tip: 'Each FL row is coloured relative to its own busiest day. Days on either side of a counting-method change (dashed amber line) are scaled separately, as their counts are not comparable. Numbers in the cells are absolute event counts.' },
  pct:    { txt: '0 · <10 · <25 · <50 · ≥50 %',
            tip: 'Share of the aircraft seen in each FL band that had at least one degradation event — counted per hour and summed over the day (aircraft-hours). One colour scale for all rows. Empty cells: no per-band data (recorded from 6 Oct 2026) or no traffic.' },
};
const SIG_NAMES = { nacp: 'NACp', nic: 'NIC', freeze: 'Freeze', gap: 'Gap', adsb_loss: 'ADS-B' };

function heatColorStep(step) {
  const palette = document.documentElement.dataset.theme === 'light'
    ? HEAT_COLORS_LIGHT : HEAT_COLORS;
  return palette[Math.max(0, Math.min(palette.length - 1, step))];
}
function pctStep(pct) {
  if (pct <= 0) return 0;
  let s = 1;
  for (const t of HEAT_PCT_STEPS) if (pct >= t) s++;
  return s;
}
function applyHeatmapMode(mode) {
  heatmapMode = mode === 'pct' ? 'pct' : 'events';
  localStorage.setItem('ms_gps_heatmap_mode', heatmapMode);
  document.querySelectorAll('#gps-heatmap-mode-btns .gps-range-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.heatmapMode === heatmapMode));
  const lg = document.getElementById('gps-heat-legend');
  const lt = document.getElementById('gps-heat-legend-txt');
  if (lg) lg.title = HEAT_LEGEND[heatmapMode].tip;
  if (lt) lt.textContent = HEAT_LEGEND[heatmapMode].txt;
  if (lastHeatmapData.length > 0) drawHeatmap(lastHeatmapData, lastFlBands);
}

/**
 * Assign each displayed day to a colour-scaling segment.
 * Segments are split at the days where the counting method changed; short
 * segments (< HEATMAP_MIN_SEGMENT_DAYS) are merged forward into the next
 * segment, and a short newest segment is merged back into the previous one.
 * Returns an array of segment ids, one per entry of dayKeys.
 */
function heatmapSegments(dayKeys, changes, daySec) {
  const changeDays = new Set(changes.map(c => Math.floor(c.ts / daySec) * daySec));
  const segs = [];
  dayKeys.forEach((dt, xi) => {
    if (xi === 0 || changeDays.has(dt)) segs.push([]);
    segs[segs.length - 1].push(xi);
  });
  for (let i = 0; i < segs.length - 1; ) {
    if (segs[i].length < HEATMAP_MIN_SEGMENT_DAYS) {
      segs[i + 1] = segs[i].concat(segs[i + 1]);
      segs.splice(i, 1);
    } else i++;
  }
  if (segs.length > 1 && segs[segs.length - 1].length < HEATMAP_MIN_SEGMENT_DAYS) {
    const last = segs.pop();
    segs[segs.length - 1] = segs[segs.length - 1].concat(last);
  }
  const out = new Array(dayKeys.length).fill(0);
  segs.forEach((seg, si) => seg.forEach(xi => { out[xi] = si; }));
  return out;
}
function drawHeatmap(heatmapData, flBands) {
  const canvas = document.getElementById('gps-heatmap-canvas');
  if (!canvas || !heatmapData || heatmapData.length === 0) return;

  const th       = canvasTheme();
  const ctx      = canvas.getContext('2d');
  const nBands   = flBands.length;   // dynamic — currently 9 FL bands
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

  // Day count driven by the heatmap's own range selector (14d / 1m) —
  // independent of the time-series chart's range selector above.
  const heatmapMaxDays = (HEATMAP_RANGE_CONFIG[currentHeatmapRange] || HEATMAP_RANGE_CONFIG['14d']).days;
  const allDayKeys = Object.keys(dayMap).map(Number).sort();
  const dayKeys = allDayKeys.slice(-heatmapMaxDays);
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

  // Per-band maximum for row-independent normalisation.
  // Each FL band is coloured relative to its own worst day so that low-altitude
  // bands (e.g. FL010-030) use the full colour range even when high-altitude
  // bands (e.g. FL300+) have far higher absolute counts.  The event count
  // printed inside each cell still shows the absolute number for comparison.
  //
  // Counting-method segments: days on either side of a method change (dashed
  // marker) are scaled separately, because the counts are not comparable
  // across a change.  A segment shorter than HEATMAP_MIN_SEGMENT_DAYS is merged
  // into its neighbour (normally the following one; the newest segment into
  // the preceding one) so that a lone day is not scaled against itself, which
  // would paint every non-zero cell at full intensity.
  const segOf = heatmapSegments(dayKeys, methodChangeTimes(heatmapData), DAY_SEC);
  const bandMaxVals = {};   // `${segment}|${band}` → max
  for (const band of flBands) {
    dayKeys.forEach((dt, xi) => {
      const k = segOf[xi] + '|' + band;
      const v = dayMap[dt][band] || 0;
      bandMaxVals[k] = Math.max(bandMaxVals[k] || 1, v);   // floor 1 avoids ÷0
    });
  }

  // Background
  ctx.fillStyle = th.bg;
  ctx.fillRect(0, 0, W, H);

  // Cells — '% aircraft' mode
  if (heatmapMode === 'pct') {
    dayKeys.forEach((dt, xi) => {
      flBands.forEach((band, yi) => {
        const bd = (lastBandDays[String(dt)] || {})[band];
        const x  = MARGIN_L + xi * cellW;
        const y  = MARGIN_T + yi * cellH;
        if (!bd || !bd.ac) {                       // no per-band data / no traffic
          ctx.strokeStyle = th.grid;
          ctx.lineWidth   = 0.5;
          ctx.strokeRect(x + 1.5, y + 1.5, cellW - 3, cellH - 3);
          return;
        }
        const pct  = 100 * bd.deg / bd.ac;
        const step = pctStep(pct);
        ctx.fillStyle = heatColorStep(step);
        ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
        ctx.fillStyle = step >= 3 ? '#fff' : th.text;
        const fontSize = Math.max(6, Math.min(11, Math.floor(cellH * 0.45), Math.floor(cellW / 4 / 0.62)));
        ctx.font      = `bold ${fontSize}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(Math.round(pct), x + cellW / 2, y + cellH / 2);
      });
    });
  }

  // Cells — 'events' mode
  if (heatmapMode !== 'pct') dayKeys.forEach((dt, xi) => {
    flBands.forEach((band, yi) => {
      const val  = dayMap[dt][band] || 0;
      const norm = val / bandMaxVals[segOf[xi] + '|' + band];
      const x    = MARGIN_L + xi * cellW;
      const y    = MARGIN_T + yi * cellH;
      ctx.fillStyle = heatColor(norm);
      ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);

      // Event count inside cell (skip zeros for clarity).  Font size is
      // clamped by both cell height and cell width so 4-digit counts stay
      // legible even in the narrower daily columns of the 1m heatmap range
      // (31 columns vs 14) — width budget assumes up to 4 monospace digits.
      if (val > 0) {
        ctx.fillStyle = norm > 0.5 ? '#fff' : th.text;
        const fontSize = Math.max(6, Math.min(11, Math.floor(cellH * 0.45), Math.floor(cellW / 4 / 0.62)));
        ctx.font      = `bold ${fontSize}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(val, x + cellW / 2, y + cellH / 2);
      }
    });
  });

  // Method-change markers: dashed line at the left edge of the day in which
  // the counting method changed (see METHOD_LABELS)
  for (const mk of methodChangeTimes(heatmapData)) {
    const xi = dayKeys.indexOf(Math.floor(mk.ts / DAY_SEC) * DAY_SEC);
    if (xi <= 0) continue;
    const x = MARGIN_L + xi * cellW;
    ctx.save();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth   = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(x, MARGIN_T); ctx.lineTo(x, MARGIN_T + plotH); ctx.stroke();
    ctx.restore();
  }

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

  heatLayout = { ML: MARGIN_L, MT: MARGIN_T, cellW, cellH, plotW, plotH, dayKeys, flBands, dayMap };
}

// ── Heatmap hover text + click → GPS Episodes ────────────────────────────────
function heatCellAt(ev) {
  const canvas = document.getElementById('gps-heatmap-canvas');
  if (!heatLayout || !canvas) return null;
  const r  = canvas.getBoundingClientRect();
  const mx = (ev.clientX - r.left) * (canvas.width / r.width);
  const my = (ev.clientY - r.top)  * (canvas.height / r.height);
  const L  = heatLayout;
  const xi = Math.floor((mx - L.ML) / L.cellW);
  const yi = Math.floor((my - L.MT) / L.cellH);
  if (xi < 0 || yi < 0 || xi >= L.dayKeys.length || yi >= L.flBands.length) return null;
  return { dt: L.dayKeys[xi], band: L.flBands[yi] };
}

function heatTipHtml(cell) {
  const d   = new Date(cell.dt * 1000);
  const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()];
  const ev  = (heatLayout.dayMap[cell.dt] || {})[cell.band] || 0;
  const bd  = (lastBandDays[String(cell.dt)] || {})[cell.band];
  const lines = [`<b>${dow} ${d.getUTCDate()}.${d.getUTCMonth() + 1}. · FL${cell.band}</b>`,
                 `Events: ${ev}`];
  if (bd && bd.ac) {
    lines.push(`Aircraft degraded: ${bd.deg} of ${bd.ac} (${Math.round(100 * bd.deg / bd.ac)} %, aircraft-hours)`);
    if (bd.sev) lines.push(`Severe (position unusable): ${bd.sev}`);
    const sig = Object.entries(bd.sig || {}).filter(([, n]) => n > 0);
    const tot = sig.reduce((a, [, n]) => a + n, 0);
    if (tot > 0) {
      lines.push('Signals: ' + sig.sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${SIG_NAMES[k] || k} ${Math.round(100 * n / tot)} %`).join(' · '));
    }
  } else {
    lines.push('<span class="gps-heat-tip-dim">Aircraft counts: not recorded (from 6 Oct 2026)</span>');
  }
  lines.push('<span class="gps-heat-tip-dim">Click: open GPS Episodes for this day and band</span>');
  return lines.join('<br>');
}

(function wireHeatmapPointer() {
  const canvas = document.getElementById('gps-heatmap-canvas');
  const tip    = document.getElementById('gps-heat-tip');
  if (!canvas || !tip) return;
  canvas.addEventListener('mousemove', ev => {
    const cell = heatCellAt(ev);
    canvas.style.cursor = cell ? 'pointer' : 'default';
    if (!cell) { tip.style.display = 'none'; return; }
    tip.innerHTML = heatTipHtml(cell);
    tip.style.display = 'block';
    // position: fixed — right of the cursor, flipped left / up near the edges
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let x = ev.clientX + 14, y = ev.clientY - h - 8;
    if (x + w > window.innerWidth - 6) x = Math.max(6, ev.clientX - 14 - w);
    if (y < 4) y = ev.clientY + 16;
    tip.style.left = x + 'px';
    tip.style.top  = y + 'px';
  });
  canvas.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  canvas.addEventListener('click', ev => {
    const cell = heatCellAt(ev);
    if (!cell) return;
    const d   = new Date(cell.dt * 1000);
    const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    window.open(`/gps-episodes?date=${iso}&fl=${encodeURIComponent(cell.band)}`, '_blank');
  });
})();


// ── Live table ──────────────────────────────────────────────────────────────────────────────
const FLAG_HTML = {
  nacp:      '<span class="gps-flag gps-flag-nacp">NACp</span>',
  nic:       '<span class="gps-flag gps-flag-nic">NIC</span>',
  freeze:    '<span class="gps-flag gps-flag-freeze">Freeze</span>',
  gap:       '<span class="gps-flag gps-flag-gap">Gap</span>',
  adsb_loss: '<span class="gps-flag gps-flag-adsb">ADS-B</span>',
};

function renderLiveTable(liveEvents) {
  const tbody = document.getElementById('gps-live-tbody');
  if (!liveEvents || liveEvents.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="gps-no-data">No degraded aircraft detected</td></tr>';
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
    // NIC with containment radius (Rc) in NM as tooltip; NACv as-is
    const rcNm  = ac.nic_rc_m != null ? (ac.nic_rc_m / 1852).toFixed(ac.nic_rc_m < 1852 ? 2 : 1) + ' NM' : 'unknown';
    const nic   = ac.nic      != null ? `<span title="Rc ${rcNm}">${ac.nic}</span>` : '—';
    const nacv  = ac.nac_v    != null ? ac.nac_v : '—';
    const fl_ = ac.flags || [];
    // Severe = position unusable (NACp 0, NIC 0 or no own position)
    const severe = (fl_.includes('nacp') && ac.nac_p === 0) || (fl_.includes('nic') && ac.nic === 0)
                   || fl_.includes('gap') || fl_.includes('adsb_loss');
    const flags = fl_.map(f => FLAG_HTML[f] || f).join(' ');
    return `<tr${severe ? ' class="gps-row-sev" title="Severe — position unusable (NACp 0, NIC 0 or no own position)"' : ''}>
      <td class="gps-td-cs">${cs}</td>
      <td class="gps-td-icao">${ac.icao}</td>
      <td>${fl}</td>
      <td>${alt}</td>
      <td>${gs}</td>
      <td>${nacp}</td>
      <td>${nic}</td>
      <td>${nacv}</td>
      <td>${flags}</td>
    </tr>`;
  }).join('');
}

// ── FL band donut + 14-day stats panel ───────────────────────────────────────
let donutChart = null;

const DONUT_COLORS = [
  '#38bdf8',  // 010-030  sky blue
  '#818cf8',  // 030-050  indigo
  '#34d399',  // 050-080  emerald
  '#2dd4bf',  // 080-100  teal
  '#fb923c',  // 100-150  orange
  '#f472b6',  // 150-200  pink
  '#a78bfa',  // 200-250  violet
  '#fbbf24',  // 250-300  amber
  '#94a3b8',  // 300+     slate
];

function drawDonutAndStats(heatmapData, flBands) {
  if (!heatmapData || heatmapData.length === 0 || !flBands || flBands.length === 0) return;

  // Cutoff follows the heatmap's own day-range selector (14d / 1m) — NOT the
  // time-series chart's 1d–6m selector. Both this donut and the heatmap draw
  // from the same heatmapData, which the server caps at 31 days
  // (HEATMAP_MAX_BUCKETS) regardless of the time-series range, so tying the
  // cutoff to a selector that goes up to 6 months would silently do nothing
  // beyond 31 days. Falls back to 14 days if the range config is unavailable.
  const DAY_SEC   = 86_400;
  const rangeCfg  = HEATMAP_RANGE_CONFIG[currentHeatmapRange];
  const cutoffSec = (Date.now() / 1000) - (rangeCfg ? rangeCfg.days * DAY_SEC : 14 * DAY_SEC);
  const recent    = heatmapData.filter(b => b.ts >= cutoffSec);
  if (recent.length === 0) return;

  // Update panel title to reflect the active range
  const titleEl = document.getElementById('gps-donut-title');
  if (titleEl) titleEl.textContent = 'FL Band Analysis — ' + (rangeCfg ? rangeCfg.title : '14 Days');

  // Accumulate per-band and per-signal totals
  const bandTotals = Object.fromEntries(flBands.map(b => [b, 0]));
  const dayTotals  = {};
  let totalEvents = 0, totalNacp = 0, totalNic = 0, totalFreeze = 0, totalGap = 0, totalAdsbLoss = 0;

  for (const b of recent) {
    totalEvents   += b.events;
    totalNacp     += b.nacp_events        || 0;
    totalNic      += b.nic_events         || 0;
    totalFreeze   += b.freeze_events      || 0;
    totalGap      += b.gap_events         || 0;
    totalAdsbLoss += b.adsb_loss_events   || 0;
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

  // Use total signal firings as denominator so percentages sum to 100%.
  // One aircraft sweep can trigger multiple signals simultaneously (e.g. both
  // Freeze and ADS-B), so totalEvents < sum of individual signal counts.
  const totalSignals = totalNacp + totalNic + totalFreeze + totalGap + totalAdsbLoss;

  set('gps-stat-total',     totalEvents > 0 ? totalEvents.toLocaleString() : '—');
  set('gps-stat-top-band',  topBandCount > 0 ? `FL${topBand}  (${topBandCount.toLocaleString()})` : '—');
  set('gps-stat-worst-day', worstDayCount > 0 ? `${worstDayStr}  (${worstDayCount.toLocaleString()})` : '—');
  set('gps-stat-nacp',   totalNacp     > 0 ? `${totalNacp.toLocaleString()}${pct(totalNacp,     totalSignals)}` : '—');
  set('gps-stat-nic',    totalNic      > 0 ? `${totalNic.toLocaleString()}${pct(totalNic,       totalSignals)}` : '—');
  set('gps-stat-freeze', totalFreeze   > 0 ? `${totalFreeze.toLocaleString()}${pct(totalFreeze,   totalSignals)}` : '—');
  set('gps-stat-gap',    totalGap      > 0 ? `${totalGap.toLocaleString()}${pct(totalGap,      totalSignals)}` : '—');
  set('gps-stat-adsb',   totalAdsbLoss > 0 ? `${totalAdsbLoss.toLocaleString()}${pct(totalAdsbLoss, totalSignals)}` : '—');
}

// ── Summary bar ─────────────────────────────────────────────────────────────────────────────
function renderStats(stats) {
  document.getElementById('gps-events-24h').textContent   = stats.events_24h   ?? '—';
  document.getElementById('gps-degraded-24h').textContent = stats.degraded_24h ?? '—';
  document.getElementById('gps-peak-hour').textContent    = stats.peak_hour    || 'None';
  document.getElementById('gps-severe-24h').textContent   = stats.severe_24h   ?? '—';
}

// ── 10-minute view + severity / spoofing panel (data from 2026-10-09) ─────────
// Both read /api/gps/detail (completed hours cached server-side, the hour in
// progress live).  The 10-minute view replaces the events chart while the
// "10 min" button is active; its window follows the range selector, capped at
// 7 days.
const T10_MAX_HOURS = 168;
const SPOOF_META = {
  mlat_dis: { lbl: 'ADS-B / MLAT mismatch', short: 'MLAT ≠', tip: 'Own ADS-B position disagrees with the MLAT position by more than 2 NM plus the distance flown in the time difference, on two consecutive comparisons (MLAT covers mainly higher altitudes)' },
  gmb_sat:  { lbl: 'GNSS−baro at limit',    short: 'Alt limit', tip: 'GNSS − barometric altitude difference (velocity message) at its largest encodable value (> 3 137 ft)' },
  gmb_jump: { lbl: 'GNSS−baro jump',        short: 'Alt jump', tip: 'GNSS − barometric altitude difference changed by ≥ 500 ft between two reports ≤ 30 s apart' },
  pos_jump: { lbl: 'Position jump',         short: 'Pos jump', tip: 'Own ADS-B position stepped further than the groundspeed allows, confirmed by the next position' },
};
const SPOOF_ORDER = ['mlat_dis', 'gmb_sat', 'gmb_jump', 'pos_jump'];

let tsView      = localStorage.getItem('ms_gps_ts_view') === '10m' ? '10m' : 'hour';
let t10Chart    = null;
let spoofHours  = Number(localStorage.getItem('ms_gps_spoof_hours')) || 24;
if (![24, 168, 744].includes(spoofHours)) spoofHours = 24;

function t10Hours() {
  const cfg = RANGE_CONFIG[currentRange] || RANGE_CONFIG['1d'];
  return Math.min(cfg.hours, T10_MAX_HOURS);
}

function _pad2(n) { return String(n).padStart(2, '0'); }
function _hhmm(ts) { const d = new Date(ts * 1000); return `${_pad2(d.getUTCHours())}:${_pad2(d.getUTCMinutes())}`; }
function _dmhm(ts) { const d = new Date(ts * 1000); return `${d.getUTCDate()}.${d.getUTCMonth() + 1}. ${_hhmm(ts)}`; }

// Message in an empty chart
const t10EmptyPlugin = {
  id: 't10Empty',
  afterDraw(chart) {
    if (!chart.$emptyMsg) return;
    const { ctx, chartArea: a } = chart;
    if (!a) return;
    ctx.save();
    ctx.fillStyle = canvasTheme().textDim;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(chart.$emptyMsg, (a.left + a.right) / 2, (a.top + a.bottom) / 2);
    ctx.restore();
  },
};

function initT10Chart() {
  const ctx = document.getElementById('gps-t10-canvas').getContext('2d');
  const th  = canvasTheme();
  t10Chart = new Chart(ctx, {
    type: 'bar',
    plugins: [t10EmptyPlugin],
    data: {
      labels: [],
      datasets: [
        { label: 'Severe', data: [], backgroundColor: 'rgba(239,68,68,0.85)', borderColor: '#ef4444',
          borderWidth: 1, stack: 'deg', order: 2, yAxisID: 'y' },
        { label: 'Mild', data: [], backgroundColor: 'rgba(251,146,60,0.75)', borderColor: '#fb923c',
          borderWidth: 1, stack: 'deg', order: 2, yAxisID: 'y' },
        { label: 'Spoofing ind.', data: [], type: 'line', showLine: false, borderColor: '#f472b6',
          backgroundColor: '#f472b6', pointStyle: 'triangle', order: 0, yAxisID: 'y',
          pointRadius: ctx => (ctx.raw ? 5 : 0), pointHoverRadius: ctx => (ctx.raw ? 6 : 0) },
        { label: '% FL050–250 degraded', data: [], type: 'line', borderColor: '#38bdf8',
          borderWidth: 1.5, pointRadius: 0, pointHitRadius: 4, tension: 0.2, fill: false,
          order: 1, yAxisID: 'y1', spanGaps: false },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, labels: { color: th.text, font: { size: 11 }, boxWidth: 12, padding: 8,
                                            sort: (a, b) => a.datasetIndex - b.datasetIndex } },
        tooltip: {
          callbacks: {
            title: items => {
              const ts = t10Chart.$slotTs[items[0].dataIndex];
              return `${_dmhm(ts)}–${_hhmm(ts + 600)} UTC`;
            },
            label: item => {
              if (item.raw == null) return null;
              if (item.datasetIndex === 3) return ` ${item.dataset.label}: ${item.raw} %`;
              return ` ${item.dataset.label}: ${item.raw}`;
            },
            footer: items => {
              const r = t10Chart.$rows[items[0].dataIndex];
              if (!r) return ['No data'];
              return [`Aircraft seen: ${r.ac} · degraded ${r.deg}`,
                      `FL050–250: ${r.mdeg} of ${r.mac} degraded`];
            },
          },
        },
      },
      scales: {
        x: { stacked: true, ticks: { color: th.axisLabel, maxRotation: 0, autoSkip: true, maxTicksLimit: 12, font: { size: 10 } },
             grid: { color: th.grid } },
        y: { stacked: true, beginAtZero: true, position: 'left',
             ticks: { color: th.axisLabel, precision: 0, font: { size: 10 } }, grid: { color: th.grid },
             title: { display: true, text: 'Degraded aircraft / 10 min', color: th.axisLabel, font: { size: 10 } } },
        y1: { beginAtZero: true, suggestedMax: 20, max: 100, position: 'right',
              ticks: { color: '#38bdf8', font: { size: 10 }, callback: v => v + ' %' },
              grid: { drawOnChartArea: false },
              title: { display: true, text: 'FL050–250 degraded', color: '#38bdf8', font: { size: 10 } } },
      },
    },
  });
}

async function fetchDetail(hours) {
  const r = await fetch(`/api/gps/detail?zone=${encodeURIComponent(currentZone)}&hours=${hours}`);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function updateT10Chart(d) {
  if (!t10Chart) return;
  const keys = d.keys || ['ac', 'deg', 'sev', 'spf', 'mac', 'mdeg'];
  const bySlot = {};
  for (const s of d.slots || []) {
    const o = {};
    keys.forEach((k, i) => { o[k] = s[i + 1]; });
    bySlot[s[0]] = o;
  }
  const now   = Date.now() / 1000;
  const last  = Math.floor(now / 600) * 600;
  let first   = Math.floor(now / 3600) * 3600 - ((d.hours_n || 24) - 1) * 3600;
  if (d.since != null && d.since > first) first = d.since;   // nothing recorded before
  const slotTs = [];
  for (let t = first; t <= last; t += 600) slotTs.push(t);
  const multiDay = slotTs.length > 144;
  const rows = slotTs.map(t => bySlot[t] || null);
  t10Chart.$slotTs = slotTs;
  t10Chart.$rows   = rows;
  t10Chart.data.labels = slotTs.map(t => (multiDay ? _dmhm(t) : _hhmm(t)));
  t10Chart.data.datasets[0].data = rows.map(r => r ? r.sev : null);
  t10Chart.data.datasets[1].data = rows.map(r => r ? Math.max(0, r.deg - r.sev) : null);
  t10Chart.data.datasets[2].data = rows.map(r => r && r.spf ? r.spf : null);
  t10Chart.data.datasets[3].data = rows.map(r => r && r.mac ? Math.round(1000 * r.mdeg / r.mac) / 10 : null);
  t10Chart.options.scales.x.ticks.maxTicksLimit = multiDay ? 8 : 12;
  t10Chart.$emptyMsg = d.since == null ? '10-minute data is recorded from 9 Oct 2026 — none in this window yet' : '';
  t10Chart.update('none');
}

async function refreshT10() {
  if (tsView !== '10m') return;
  try { updateT10Chart(await fetchDetail(t10Hours())); } catch (_) { /* silent */ }
}

function applyTsView(view) {
  tsView = view === '10m' ? '10m' : 'hour';
  localStorage.setItem('ms_gps_ts_view', tsView);
  document.querySelectorAll('#gps-ts-view-btns .gps-range-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tsView === tsView);
  });
  const ev  = document.getElementById('gps-timeseries-canvas');
  const t10 = document.getElementById('gps-t10-canvas');
  ev.style.display  = tsView === 'hour' ? '' : 'none';
  t10.style.display = tsView === '10m'  ? '' : 'none';
  updateTsTitle();
  if (tsView === '10m') {
    if (!t10Chart) initT10Chart();
    t10Chart.resize();
    refreshT10();
  } else if (tsChart) {
    tsChart.resize();
  }
}

function updateTsTitle() {
  const titleEl = document.getElementById('gps-chart-title');
  if (!titleEl) return;
  const cfg = RANGE_CONFIG[currentRange] || RANGE_CONFIG['1d'];
  if (tsView === '10m') {
    const capped = cfg.hours > T10_MAX_HOURS;
    titleEl.textContent = 'Degraded Aircraft per 10 min — ' + (capped ? 'Last 7 Days (max)' : cfg.title);
  } else {
    titleEl.textContent = 'GPS Degradation Events — ' + cfg.title;
  }
}

// ── Severity & spoofing panel ─────────────────────────────────────────────────
function _fmtFlagVal(e) {
  const v = [];
  if (e.mlat_nm != null)  v.push(`${e.mlat_nm} NM from MLAT`);
  if (e.jump_nm != null)  v.push(`${e.jump_nm} NM jump`);
  if (e.gmb_jump != null) v.push(`Δ ${e.gmb_jump > 0 ? '+' : ''}${e.gmb_jump} ft`);
  if (e.gmb != null && (e.k || []).includes('gmb_sat')) v.push(`${e.gmb} ft`);
  return v.join(' · ') || '—';
}

function renderSpoofPanel(d) {
  const body = document.getElementById('gps-spoof-body');
  if (!body) return;
  const sev = d.severity || {}, sp = d.spoof || {};
  if (d.since == null) {
    body.innerHTML = '<div class="gps-no-data">Recorded from 9 Oct 2026 — no data in this window yet</div>';
    return;
  }
  const sw = sev.sweeps || {};
  const pct = sev.degraded_ach ? Math.round(100 * sev.severe_ach / sev.degraded_ach) : 0;
  const since = d.since > Date.now() / 1000 - d.hours_n * 3600 + 3600
    ? `<div class="gps-spoof-note">Data from ${_dmhm(d.since)} UTC</div>` : '';
  let h = since;
  h += `<div class="gps-spoof-sec">Severity <span class="gps-spoof-dim">(aircraft-hours)</span></div>
    <div class="gps-stat-row"><span class="gps-stat-label">Degraded</span><span class="gps-stat-val">${sev.degraded_ach ?? 0}</span></div>
    <div class="gps-stat-row"><span class="gps-stat-label"><span class="gps-flag gps-flag-sev">SEV</span> position unusable</span>
      <span class="gps-stat-val">${sev.severe_ach ?? 0}${sev.degraded_ach ? ` <span class="gps-spoof-dim">(${pct} %)</span>` : ''}</span></div>
    <div class="gps-spoof-line">Severe sweeps: NACp 0 <b>${sw.nacp0 || 0}</b> · NIC 0 <b>${sw.nic0 || 0}</b> · no own position <b>${sw.nopos || 0}</b></div>`;
  h += `<div class="gps-spoof-sec">Spoofing indicators <span class="gps-spoof-dim gps-spoof-cols"
      title="aircraft flagged · of them while reporting normal GPS quality (fresh NACp ≥ 7, no degradation signal — the strong spoofing case) · sweeps / events">aircraft · normal GPS · sweeps</span></div>`;
  for (const k of SPOOF_ORDER) {
    const c = (sp.kinds || {})[k] || { aircraft: 0, sweeps: 0 };
    const ok = c.ok_aircraft || 0;
    h += `<div class="gps-stat-row" title="${SPOOF_META[k].tip}"><span class="gps-stat-label">${SPOOF_META[k].lbl}</span>
      <span class="gps-stat-val${c.aircraft ? ' gps-spoof-hit' : ''}">${c.aircraft} · <span class="${ok ? 'gps-spoof-ok' : ''}">${ok}</span> · ${c.sweeps}</span></div>`;
  }
  h += `<div class="gps-spoof-line" title="How often the checks could be made at all">Checked: ADS-B vs MLAT in <b>${sp.cmp || 0}</b> sweeps · GNSS−baro values in <b>${sp.gmb_n || 0}</b> sweeps</div>`;
  const fl = sp.flagged || [];
  if (!fl.length) {
    h += '<div class="gps-no-data gps-spoof-none">No aircraft flagged</div>';
  } else {
    h += `<div class="gps-spoof-sec">Flagged aircraft${sp.flagged_total > fl.length ? ` <span class="gps-spoof-dim">(newest ${fl.length} of ${sp.flagged_total})</span>` : ''}</div>
      <table class="gps-live-table gps-spoof-table"><thead><tr>
        <th>UTC</th><th>Callsign</th><th>FL</th><th>NM</th><th title="NACp when first flagged">NACp</th><th>Indicator</th><th>Value</th></tr></thead><tbody>`;
    for (const e of fl) {
      const ind = (e.k || []).map(k => `<span title="${SPOOF_META[k] ? SPOOF_META[k].lbl + ' — ' + SPOOF_META[k].tip : k}">${SPOOF_META[k]?.short || k}</span>`).join(', ');
      const t = spoofHours > 24 ? _dmhm(e.t) : _hhmm(e.t);
      const strong = (e.q || []).length > 0;
      h += `<tr${strong ? ' class="gps-spoof-strong" title="Flagged while the aircraft reported normal GPS quality — strong spoofing case"' : ''}><td class="gps-spoof-time">${t}</td>
        <td class="gps-td-cs" title="${e.icao}">${e.cs || e.icao}</td>
        <td>${e.alt != null ? String(Math.round(e.alt / 100)).padStart(3, '0') : '—'}</td>
        <td>${e.dist != null ? Math.round(e.dist) : '—'}</td>
        <td>${e.nacp != null ? e.nacp : '—'}</td>
        <td class="gps-spoof-ind">${ind}</td><td class="gps-spoof-val">${_fmtFlagVal(e)}</td></tr>`;
    }
    h += '</tbody></table>';
  }
  body.innerHTML = h;
}

async function refreshSpoofPanel() {
  try { renderSpoofPanel(await fetchDetail(spoofHours)); } catch (_) { /* silent */ }
}

function applySpoofRange(hours) {
  spoofHours = [24, 168, 744].includes(hours) ? hours : 24;
  localStorage.setItem('ms_gps_spoof_hours', String(spoofHours));
  document.querySelectorAll('#gps-spoof-range-btns .gps-range-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.spoofRange) === spoofHours);
  });
  const t = document.getElementById('gps-spoof-title');
  if (t) t.textContent = 'Severity & Spoofing — ' +
    ({ 24: 'Last 24 Hours', 168: 'Last 7 Days', 744: 'Last 31 Days' })[spoofHours];
  refreshSpoofPanel();
}

// ── Main poll loop ────────────────────────────────────────────────────────────────────────────
let lastFlBands    = [];
let lastHeatmapData = [];   // retained for hourly donut refresh
let donutDrawn     = false; // draw once on first load; thereafter only on hourly tick, zone or heatmap-range change
let lastDonutZone  = null;  // zone the donut was last drawn for; triggers redraw on zone switch
let lastDonutRange = null;  // heatmap range (14d/1m) the donut was last drawn for; triggers redraw on change

async function fetchGpsState() {
  try {
    const url = currentZone === 'all' ? '/api/gps/state' : `/api/gps/state?zone=${currentZone}`;
    const r = await fetch(url);
    if (!r.ok) return;
    const d = await r.json();

    lastFlBands    = d.fl_bands || lastFlBands;
    lastHeatmapData = d.heatmap || lastHeatmapData;
    lastBandDays    = d.band_days || {};

    renderStats(d.stats || {});
    updateTsChart(d.time_series || []);
    drawHeatmap(d.heatmap || [], lastFlBands);
    // Donut drawn on first load and whenever the zone or heatmap range changes; hourly interval handles the rest
    if (!donutDrawn || lastDonutZone !== currentZone || lastDonutRange !== currentHeatmapRange) {
      drawDonutAndStats(lastHeatmapData, lastFlBands);
      donutDrawn    = true;
      lastDonutZone = currentZone;
      lastDonutRange = currentHeatmapRange;
    }
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

// Wire up range selector buttons (scoped to the time-series panel's own
// button group — #gps-heatmap-range-btns below reuses the same .gps-range-btn
// class for styling but must not trigger this handler)
document.querySelectorAll('#gps-range-btns .gps-range-btn').forEach(btn => {
  btn.addEventListener('click', () => applyRange(btn.dataset.range));
});
// Restore saved range (updates button state + chart title without data yet)
applyRange(currentRange);

// Wire up heatmap's own day-range selector (14d / 1m)
document.querySelectorAll('#gps-heatmap-range-btns .gps-range-btn').forEach(btn => {
  btn.addEventListener('click', () => applyHeatmapRange(btn.dataset.heatmapRange));
});
// Restore saved heatmap range (updates button state + title without data yet)
document.querySelectorAll('#gps-heatmap-range-btns .gps-range-btn').forEach(btn => {
  btn.classList.toggle('active', btn.dataset.heatmapRange === currentHeatmapRange);
});
{
  const heatmapTitleEl = document.getElementById('gps-heatmap-title');
  const heatmapCfg = HEATMAP_RANGE_CONFIG[currentHeatmapRange];
  if (heatmapTitleEl && heatmapCfg) heatmapTitleEl.textContent = 'FL Band Heatmap — ' + heatmapCfg.title;
}

// Heatmap mode (Events / % aircraft)
document.querySelectorAll('#gps-heatmap-mode-btns .gps-range-btn').forEach(btn => {
  btn.addEventListener('click', () => applyHeatmapMode(btn.dataset.heatmapMode));
});
applyHeatmapMode(heatmapMode);

// Wire up zone selector buttons
document.querySelectorAll('.gps-zone-btn').forEach(btn => {
  btn.addEventListener('click', () => applyZone(btn.dataset.zone));
});
// Restore saved zone (updates button active state)
document.querySelectorAll('.gps-zone-btn').forEach(btn => {
  btn.classList.toggle('active', btn.dataset.zone === currentZone);
});

// Events / 10 min view of the time-series panel
document.querySelectorAll('#gps-ts-view-btns .gps-range-btn').forEach(btn => {
  btn.addEventListener('click', () => applyTsView(btn.dataset.tsView));
});
applyTsView(tsView);

// Severity & spoofing panel range
document.querySelectorAll('#gps-spoof-range-btns .gps-range-btn').forEach(btn => {
  btn.addEventListener('click', () => applySpoofRange(Number(btn.dataset.spoofRange)));
});
applySpoofRange(spoofHours);

fetchGpsState();
setInterval(fetchGpsState, 30_000);
setInterval(() => { refreshT10(); refreshSpoofPanel(); }, 60_000);
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
  if (t10Chart) {
    const th = canvasTheme();
    t10Chart.options.plugins.legend.labels.color = th.text;
    for (const ax of ['x', 'y']) {
      t10Chart.options.scales[ax].ticks.color = th.axisLabel;
      t10Chart.options.scales[ax].grid.color  = th.grid;
    }
    t10Chart.options.scales.y.title.color = th.axisLabel;
    t10Chart.update('none');
  }
  // Redraw heatmap with new theme
  fetchGpsState();
};

// Redraw heatmap on window resize
window.addEventListener('resize', () => {
  if (lastFlBands.length > 0) fetchGpsState();
});
