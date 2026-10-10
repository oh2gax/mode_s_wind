/**
 * static/js/gps_episodes.js — GPS Episodes page (/gps-episodes)
 *
 * One row of the gps_episodes table = one aircraft's continuous period of
 * GPS degradation (see collector/gps_quality.py).  The page shows them on a
 * map (line from the position at the start to the position at the last
 * degraded sweep, plus the recovery point), in a list and in an
 * altitude-vs-distance scatter.  Selecting an episode in any of the three
 * highlights it in the others.
 *
 * Data: GET /api/gps/episodes?window=<s> | ?date=YYYY-MM-DD
 * Time window / date are queried from the server; the other filters
 * (duration, signal, end, altitude) are applied in the browser.
 */
'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const NM_M = 1852;

const END_COLOR = {
  recovered:     '#34d399',
  lost:          '#f87171',
  edge:          '#94a3b8',
  below_min_alt: '#fbbf24',
  shutdown:      '#a78bfa',
};
const END_LABEL = {
  recovered:     'Recovered',
  lost:          'Lost',
  edge:          'Left coverage',
  below_min_alt: 'Below min alt',
  shutdown:      'Server stopped',
};
// Same colours as the GPS Quality page charts
const SIG_META = {
  nacp:      { lbl: 'NACp', col: '#fb923c', tip: 'NACp — reported position accuracy degraded' },
  nic:       { lbl: 'NIC',  col: '#f472b6', tip: 'NIC — reported integrity (containment radius) degraded' },
  freeze:    { lbl: 'FRZ',  col: '#38bdf8', tip: 'Freeze — position stuck while the aircraft moves' },
  gap:       { lbl: 'GAP',  col: '#a78bfa', tip: 'Gap — no position while Mode S replies continue' },
  adsb_loss: { lbl: 'LOSS', col: '#14b8a6', tip: 'ADS-B loss — no own ADS-B position, MLAT still tracks' },
};
const SIG_ORDER = ['nacp', 'nic', 'freeze', 'gap', 'adsb_loss'];

// ── State ────────────────────────────────────────────────────────────────────
let gpeWindow   = 86400;   // seconds (live mode)
let gpeDate     = '';      // YYYY-MM-DD when a day is selected
let gpeAll      = [];      // all episodes from the server (newest first)
let gpeShown    = [];      // after client-side filters
let gpeSelected = null;    // selected episode id
const gpeLayers = new Map(); // id → { group, line, recLine, start, end, rec }

// ── Map ──────────────────────────────────────────────────────────────────────
const _cartoKeyQs = (typeof CARTO_API_KEY !== 'undefined' && CARTO_API_KEY)
  ? `?key=${encodeURIComponent(CARTO_API_KEY)}` : '';
const TILE_DARK  = `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png${_cartoKeyQs}`;
const TILE_LIGHT = `https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png${_cartoKeyQs}`;
const TILE_OPTS  = { attribution: '© OSM, © CARTO', subdomains: 'abcd', maxZoom: 18 };
const isLight    = () => document.documentElement.dataset.theme === 'light';

const map = L.map('gpe-map', { zoomControl: true, preferCanvas: true })
  .setView([GPE_AIRPORT.lat, GPE_AIRPORT.lon], 7);
let tileLayer = L.tileLayer(isLight() ? TILE_LIGHT : TILE_DARK, TILE_OPTS).addTo(map);
const ringLayer = L.layerGroup().addTo(map);
const epLayer   = L.layerGroup().addTo(map);

function drawRings() {
  ringLayer.clearLayers();
  const col = isLight() ? '#475569' : '#64748b';
  const rings = [20, 50, GPE_RADIUS_NM];
  for (const nm of rings) {
    L.circle([GPE_AIRPORT.lat, GPE_AIRPORT.lon], {
      radius: nm * NM_M, color: col, weight: 1, opacity: 0.7,
      dashArray: '4 5', fill: false, interactive: false,
    }).addTo(ringLayer);
    const lat = GPE_AIRPORT.lat + nm / 60;          // ring label at north
    L.marker([lat, GPE_AIRPORT.lon], {
      interactive: false,
      icon: L.divIcon({ className: 'gpe-ring-lbl', html: `${nm} NM`, iconSize: [44, 12], iconAnchor: [22, 6] }),
    }).addTo(ringLayer);
  }
  // Receiver coverage edge used for "Left coverage" — fainter
  L.circle([GPE_AIRPORT.lat, GPE_AIRPORT.lon], {
    radius: GPE_EDGE_NM * NM_M, color: col, weight: 1, opacity: 0.35,
    dashArray: '2 6', fill: false, interactive: false,
  }).addTo(ringLayer);
  L.circleMarker([GPE_AIRPORT.lat, GPE_AIRPORT.lon], {
    radius: 4, color: '#38bdf8', weight: 2, fillColor: '#38bdf8', fillOpacity: 0.9,
  }).bindTooltip(GPE_AIRPORT.icao || 'Airport').addTo(ringLayer);
}
drawRings();

// ── Helpers ──────────────────────────────────────────────────────────────────
const pad2 = v => String(v).padStart(2, '0');

function fmtUtc(ts, withDate) {
  const d = new Date(ts * 1000);
  const hm = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  return withDate ? `${d.getUTCDate()}.${d.getUTCMonth() + 1} ${hm}` : hm;
}
function fmtDur(s) {
  if (s == null) return '—';
  return `${Math.floor(s / 60)}:${pad2(Math.round(s % 60))}`;
}
function fmtFl(alt) {
  return alt == null ? '—' : String(Math.round(alt / 100)).padStart(3, '0');
}
function fmtNm(v) { return v == null ? '–' : Math.round(v); }
function startAlt(e) { return e.start_alt != null ? e.start_alt : e.min_alt; }

function sigChips(sigStr) {
  const s = (sigStr || '').split(',').filter(Boolean);
  return SIG_ORDER.filter(k => s.includes(k)).map(k =>
    `<span class="gpe-chip" style="color:${SIG_META[k].col};border-color:${SIG_META[k].col}" ` +
    `title="${SIG_META[k].tip}">${SIG_META[k].lbl}</span>`).join('');
}

const SPOOF_LABEL = {
  mlat_dis: 'ADS-B/MLAT position mismatch',
  gmb_sat:  'GNSS−baro at limit',
  gmb_jump: 'GNSS−baro jump',
  pos_jump: 'Position jump',
};

// Independent checks (the two GNSS − baro indicators come from the same value)
const SPOOF_GROUP = { mlat_dis: 'mlat', gmb_sat: 'gmb', gmb_jump: 'gmb', pos_jump: 'pos' };
function spoofKinds(e) { return (e.spoof || '').split(',').filter(Boolean); }
function spoofGroups(e) { return new Set(spoofKinds(e).map(k => SPOOF_GROUP[k] || k)).size; }
function spoofChip(e) {
  const n = spoofGroups(e);
  if (!n) return '';
  const lbl = spoofKinds(e).map(k => SPOOF_LABEL[k] || k).join(', ');
  return n >= 2
    ? `<span class="gpe-chip gpe-chip-spf2" title="Spoofing indicators from 2+ independent checks: ${lbl}">SPF 2+</span>`
    : `<span class="gpe-chip gpe-chip-spf" title="Spoofing indicator: ${lbl}">SPF</span>`;
}

function popupHtml(e) {
  const sig = (e.signals || '').split(',').filter(Boolean)
    .map(k => SIG_META[k] ? SIG_META[k].lbl : k).join(', ');
  const rows = [
    ['Aircraft', `${e.callsign || e.icao} · ${e.aircraft_type || '?'}${e.registration ? ' · ' + e.registration : ''}`],
    ['Time (UTC)', `${fmtUtc(e.t_start, true)} → ${fmtUtc(e.t_end, false)}  (${fmtDur(e.duration_s)}, ${e.sweeps} sweeps)`],
    ['Signals', sig || '—'],
    ['NACp / NIC min', `${e.min_nacp ?? '–'} / ${e.min_nic ?? '–'}`],
    ['Altitude', e.min_alt != null ? `${e.min_alt} – ${e.max_alt} ft` : '—'],
    ['Start', `${fmtNm(e.start_dist_nm)} NM · ${e.start_alt ?? '–'} ft · trk ${e.start_track ?? '–'}° · ${e.start_vrate ?? '–'} fpm` +
              (e.start_edge ? ' <span class="gpe-note">(entered the radius already degraded)</span>' : '')],
    ['End', `${fmtNm(e.end_dist_nm)} NM · ${e.end_alt ?? '–'} ft · trk ${e.end_track ?? '–'}°` +
            (e.end_pos_age != null ? ` · position ${e.end_pos_age} s old` : '')],
    ['Recovery', e.rec_alt != null ? `${fmtNm(e.rec_dist_nm)} NM · ${e.rec_alt} ft` : '—'],
    ['Ended', `<span style="color:${END_COLOR[e.end_class] || '#94a3b8'}">${END_LABEL[e.end_class] || e.end_class}</span>`],
  ];
  // Severity and spoofing indicators (episodes logged from 2026-10-09)
  if (e.severe_sweeps != null)
    rows.push(['Severe', `${e.severe_sweeps} of ${e.sweeps} sweeps` +
      ' <span class="gpe-note">(position unusable: NACp 0, NIC 0 or no own position)</span>']);
  if (e.spoof || e.gmb_min != null || e.mlat_cmp) {
    const sp = (e.spoof || '').split(',').filter(Boolean).map(k => SPOOF_LABEL[k] || k).join(', ');
    let v = sp ? `<span style="color:#f472b6">${sp}</span>` : 'none';
    if (spoofGroups(e) >= 2) v += ' <span class="gpe-note">(2+ independent checks agree)</span>';
    if (e.max_mlat_nm != null) v += ` · ADS-B vs MLAT ${e.max_mlat_nm} NM`;
    if (e.mlat_cmp) v += ` · ${e.mlat_cmp} MLAT comparisons`;
    if (e.gmb_min != null) v += ` · GNSS−baro ${e.gmb_min}…${e.gmb_max} ft`;
    rows.push(['Spoofing ind.', v]);
  }
  return `<div class="gpe-popup">` +
    rows.map(([k, v]) => `<div><span class="gpe-pk">${k}</span>${v}</div>`).join('') + `</div>`;
}

// ── Filtering ────────────────────────────────────────────────────────────────
function applyFilters() {
  const minDur = Number(document.getElementById('gpe-f-dur').value) || 0;
  const sig    = document.getElementById('gpe-f-sig').value;
  const end    = document.getElementById('gpe-f-end').value;
  const altSel = document.getElementById('gpe-f-alt').value;
  const spf    = document.getElementById('gpe-f-spf').value;
  let aLo = -1e9, aHi = 1e9;
  if (altSel) [aLo, aHi] = altSel.split('-').map(Number);
  // Altitude filter: the episode's altitude range overlaps the selected band
  gpeShown = gpeAll.filter(e => {
    if ((e.duration_s || 0) < minDur) return false;
    if (sig && !(e.signals || '').split(',').includes(sig)) return false;
    if (end && e.end_class !== end) return false;
    if (spf && spoofGroups(e) < (spf === 'multi' ? 2 : 1)) return false;
    if (altSel) {
      const lo = e.min_alt != null ? e.min_alt : startAlt(e);
      const hi = e.max_alt != null ? e.max_alt : startAlt(e);
      if (lo == null || hi < aLo || lo >= aHi) return false;
    }
    return true;
  });
  if (gpeSelected != null && !gpeShown.some(e => e.id === gpeSelected)) gpeSelected = null;
  renderAll();
}

// ── Rendering ────────────────────────────────────────────────────────────────
function renderAll() {
  renderSummary();
  renderMap();
  renderList();
  renderScatter();
}

function renderSummary() {
  const el = document.getElementById('gpe-summary');
  const n  = gpeShown.length;
  const ac = new Set(gpeShown.map(e => e.icao)).size;
  const cnt = k => gpeShown.filter(e => e.end_class === k).length;
  const durs = gpeShown.map(e => e.duration_s || 0).sort((a, b) => a - b);
  const med  = durs.length ? durs[durs.length >> 1] : null;
  el.innerHTML =
    `${n}${n !== gpeAll.length ? ` of ${gpeAll.length}` : ''} · ${ac} aircraft · ` +
    `<span style="color:${END_COLOR.recovered}">${cnt('recovered')} rec</span> · ` +
    `<span style="color:${END_COLOR.lost}">${cnt('lost')} lost</span> · ` +
    `<span style="color:${END_COLOR.edge}">${cnt('edge')} edge</span>` +
    (med != null ? ` · median ${fmtDur(med)}` : '');
}

function renderMap() {
  epLayer.clearLayers();
  gpeLayers.clear();
  // Oldest first so the newest lines are drawn on top
  for (const e of [...gpeShown].reverse()) {
    const col = END_COLOR[e.end_class] || '#94a3b8';
    const group = L.layerGroup();
    const o = { group };
    const hasStart = e.start_lat != null && e.start_lon != null;
    const hasEnd   = e.end_lat   != null && e.end_lon   != null;
    const tip = `${e.callsign || e.icao} ${e.aircraft_type || ''} · ${fmtUtc(e.t_start, false)} · ${fmtDur(e.duration_s)} · ${END_LABEL[e.end_class] || ''}`;
    if (hasStart && hasEnd) {
      o.line = L.polyline([[e.start_lat, e.start_lon], [e.end_lat, e.end_lon]],
        { color: col, weight: 2, opacity: 0.75 }).bindTooltip(tip, { sticky: true });
      o.line.addTo(group);
    }
    if (hasEnd && e.rec_lat != null && e.rec_lon != null) {
      o.recLine = L.polyline([[e.end_lat, e.end_lon], [e.rec_lat, e.rec_lon]],
        { color: END_COLOR.recovered, weight: 1.5, opacity: 0.6, dashArray: '3 4' });
      o.recLine.addTo(group);
      o.rec = L.circleMarker([e.rec_lat, e.rec_lon],
        { radius: 3, color: END_COLOR.recovered, weight: 1, fillColor: END_COLOR.recovered, fillOpacity: 0.9 })
        .bindTooltip(tip);
      o.rec.addTo(group);
    }
    if (hasStart) {
      o.start = L.circleMarker([e.start_lat, e.start_lon],
        { radius: 3.5, color: col, weight: 1.5, fillOpacity: 0, opacity: 0.9 }).bindTooltip(tip);
      o.start.addTo(group);
    }
    if (hasEnd) {
      o.end = L.circleMarker([e.end_lat, e.end_lon],
        { radius: 3.5, color: col, weight: 1, fillColor: col, fillOpacity: 0.9 }).bindTooltip(tip);
      o.end.addTo(group);
    }
    for (const lyr of [o.line, o.recLine, o.rec, o.start, o.end]) {
      if (lyr) lyr.on('click', () => selectEpisode(e.id, { fromMap: true }));
    }
    group.addTo(epLayer);
    gpeLayers.set(e.id, o);
  }
  styleSelection();
}

function styleSelection() {
  const sel = gpeSelected;
  for (const [id, o] of gpeLayers) {
    const on  = sel == null || id === sel;
    const hi  = id === sel;
    if (o.line)    o.line.setStyle({ opacity: on ? (hi ? 1 : 0.75) : 0.15, weight: hi ? 4 : 2 });
    if (o.recLine) o.recLine.setStyle({ opacity: on ? 0.6 : 0.1 });
    for (const m of [o.start, o.end, o.rec]) {
      if (!m) continue;
      m.setStyle({ opacity: on ? 0.9 : 0.15, fillOpacity: m === o.start ? 0 : (on ? 0.9 : 0.15) });
      if (hi) m.setRadius(5); else m.setRadius(m === o.rec ? 3 : 3.5);
    }
    if (hi) for (const l of [o.line, o.recLine, o.start, o.end, o.rec]) if (l && l.bringToFront) l.bringToFront();
  }
}

function renderList() {
  const tbody = document.getElementById('gpe-tbody');
  if (!gpeShown.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="gpe-empty">${gpeAll.length ? 'No episodes match the filters' : 'No episodes in this period'}</td></tr>`;
    return;
  }
  const todayMs = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  tbody.innerHTML = gpeShown.map(e => {
    const col = END_COLOR[e.end_class] || '#94a3b8';
    const old = e.t_start * 1000 < todayMs;
    return `<tr data-id="${e.id}" class="${e.id === gpeSelected ? 'gpe-sel' : ''}">
      <td class="gpe-mono">${fmtUtc(e.t_start, old)}</td>
      <td class="gpe-cs">${e.callsign || e.icao}</td>
      <td>${e.aircraft_type || '—'}</td>
      <td class="gpe-mono">${fmtDur(e.duration_s)}</td>
      <td class="gpe-chips">${sigChips(e.signals)}${spoofChip(e)}</td>
      <td class="gpe-mono">${fmtFl(startAlt(e))}</td>
      <td class="gpe-mono"${e.start_edge ? ' title="Entered the radius already degraded"' : ''}>${fmtNm(e.start_dist_nm)}${e.start_edge ? '*' : ''}→${fmtNm(e.end_dist_nm)}</td>
      <td style="color:${col}">${END_LABEL[e.end_class] || e.end_class || '—'}</td>
      <td class="gpe-mono">${e.min_nacp ?? '–'}/${e.min_nic ?? '–'}</td>
    </tr>`;
  }).join('');
}

document.getElementById('gpe-tbody').addEventListener('click', ev => {
  const tr = ev.target.closest('tr[data-id]');
  if (tr) selectEpisode(Number(tr.dataset.id), { fromList: true });
});

function selectEpisode(id, opts = {}) {
  gpeSelected = (gpeSelected === id && !opts.fromMap && !opts.fromScatter) ? null : id;
  styleSelection();
  document.querySelectorAll('#gpe-tbody tr[data-id]').forEach(tr =>
    tr.classList.toggle('gpe-sel', Number(tr.dataset.id) === gpeSelected));
  renderScatter();
  map.closePopup();
  if (gpeSelected == null) return;
  const e = gpeShown.find(x => x.id === gpeSelected);
  const o = gpeLayers.get(gpeSelected);
  if (!e) return;
  if (!opts.fromList) {
    const tr = document.querySelector(`#gpe-tbody tr[data-id="${gpeSelected}"]`);
    if (tr) tr.scrollIntoView({ block: 'nearest' });
  }
  const pts = [[e.start_lat, e.start_lon], [e.end_lat, e.end_lon], [e.rec_lat, e.rec_lon]]
    .filter(p => p[0] != null && p[1] != null);
  if (pts.length && !opts.fromMap) {
    const b = L.latLngBounds(pts);
    if (!map.getBounds().contains(b)) map.fitBounds(b.pad(0.6), { maxZoom: 8 });
  }
  const at = (e.end_lat != null) ? [e.end_lat, e.end_lon] : pts[0];
  if (at) L.popup({ maxWidth: 360, autoPan: true }).setLatLng(at).setContent(popupHtml(e)).openOn(map);
  if (o) styleSelection();
}

// ── Altitude vs distance scatter ─────────────────────────────────────────────
let scatter = null;

function scatterTheme() {
  return isLight()
    ? { grid: 'rgba(100,116,139,0.18)', tick: '#475569' }
    : { grid: 'rgba(148,163,184,0.10)', tick: '#64748b' };
}

function renderScatter() {
  const startPts = [], recPts = [], lostPts = [];
  for (const e of gpeShown) {
    const sel = e.id === gpeSelected;
    if (e.start_dist_nm != null && startAlt(e) != null)
      startPts.push({ x: e.start_dist_nm, y: startAlt(e), id: e.id, sel });
    if (e.rec_dist_nm != null && e.rec_alt != null)
      recPts.push({ x: e.rec_dist_nm, y: e.rec_alt, id: e.id, sel });
    if (e.end_class === 'lost' && e.end_dist_nm != null && e.end_alt != null)
      lostPts.push({ x: e.end_dist_nm, y: e.end_alt, id: e.id, sel });
  }
  const rad = ctx => (ctx.raw && ctx.raw.sel) ? 7 : 3.5;
  const th  = scatterTheme();
  const datasets = [
    { label: 'Start',    data: startPts, pointStyle: 'triangle', backgroundColor: '#f59e0b', borderColor: '#f59e0b', pointRadius: rad },
    { label: 'Recovery', data: recPts,   pointStyle: 'circle',   backgroundColor: '#34d399', borderColor: '#34d399', pointRadius: rad },
    { label: 'Lost',     data: lostPts,  pointStyle: 'crossRot', backgroundColor: '#f87171', borderColor: '#f87171', pointRadius: rad, borderWidth: 2 },
  ];
  if (scatter) {
    scatter.data.datasets = datasets;
    scatter.options.scales.x.grid.color  = th.grid;
    scatter.options.scales.y.grid.color  = th.grid;
    scatter.options.scales.x.ticks.color = th.tick;
    scatter.options.scales.y.ticks.color = th.tick;
    scatter.update('none');
    return;
  }
  scatter = new Chart(document.getElementById('gpe-scatter').getContext('2d'), {
    type: 'scatter',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: c => {
              const e = gpeShown.find(x => x.id === c.raw.id);
              const who = e ? `${e.callsign || e.icao} ${e.aircraft_type || ''}` : '';
              return `${c.dataset.label}: ${who} · ${Math.round(c.raw.x)} NM · ${Math.round(c.raw.y)} ft`;
            },
          },
        },
      },
      scales: {
        x: { type: 'linear', min: 0, suggestedMax: Math.max(GPE_EDGE_NM, 140),
             title: { display: true, text: 'Distance from airport (NM)', color: th.tick, font: { size: 10 } },
             grid: { color: th.grid }, ticks: { color: th.tick, font: { size: 10 } } },
        y: { type: 'linear', min: 0, suggestedMax: 42000,
             title: { display: true, text: 'Altitude (ft)', color: th.tick, font: { size: 10 } },
             grid: { color: th.grid }, ticks: { color: th.tick, font: { size: 10 } } },
      },
      onClick: (ev, els) => {
        if (!els.length) return;
        const p = scatter.data.datasets[els[0].datasetIndex].data[els[0].index];
        selectEpisode(p.id, { fromScatter: true });
      },
    },
  });
}

// ── Data loading ─────────────────────────────────────────────────────────────
async function loadEpisodes() {
  const url = gpeDate
    ? `/api/gps/episodes?date=${gpeDate}`
    : `/api/gps/episodes?window=${gpeWindow}`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    gpeAll = d.episodes || [];
    const now = new Date();
    document.getElementById('gpe-updated').textContent =
      `${gpeDate ? gpeDate : 'Live'} · updated ${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())} UTC`;
    applyFilters();
  } catch (err) {
    document.getElementById('gpe-updated').textContent = 'Load failed';
  }
}

// ── Controls ─────────────────────────────────────────────────────────────────
function syncTimeButtons() {
  document.querySelectorAll('#gpe-window-btns .gps-range-btn').forEach(b =>
    b.classList.toggle('active', !gpeDate && Number(b.dataset.window) === gpeWindow));
  document.getElementById('gpe-live-btn').classList.toggle('active', !gpeDate);
}

document.getElementById('gpe-window-btns').addEventListener('click', ev => {
  const b = ev.target.closest('.gps-range-btn');
  if (!b) return;
  gpeWindow = Number(b.dataset.window);
  gpeDate   = '';
  document.getElementById('gpe-date').value = '';
  document.getElementById('gpe-date-picker').value = '';
  localStorage.setItem('ms_gpe_window', String(gpeWindow));
  syncTimeButtons();
  loadEpisodes();
});
// Date: dd.mm.yyyy text field (independent of the browser locale, as in the
// Windshear Approach History panel) + calendar button with a hidden picker
function setDate(iso) {                       // iso = YYYY-MM-DD
  gpeDate = iso;
  const [y, m, d] = iso.split('-');
  document.getElementById('gpe-date').value = `${d}.${m}.${y}`;
  document.getElementById('gpe-date-picker').value = iso;
  syncTimeButtons();
  loadEpisodes();
}
document.getElementById('gpe-cal-btn').addEventListener('click', () => {
  try { document.getElementById('gpe-date-picker').showPicker(); } catch (_) {}
});
document.getElementById('gpe-date-picker').addEventListener('change', ev => {
  if (ev.target.value) setDate(ev.target.value);
});
document.getElementById('gpe-date').addEventListener('input', ev => {
  const digits = ev.target.value.replace(/\D/g, '').slice(0, 8);
  let f = digits.slice(0, 2);
  if (digits.length > 2) f += '.' + digits.slice(2, 4);
  if (digits.length > 4) f += '.' + digits.slice(4, 8);
  ev.target.value = f;
  if (digits.length < 8) return;
  const iso = `${digits.slice(4, 8)}-${digits.slice(2, 4)}-${digits.slice(0, 2)}`;
  if (isNaN(new Date(iso).getTime())) return;
  setDate(iso);
});
document.getElementById('gpe-live-btn').addEventListener('click', () => {
  gpeDate = '';
  document.getElementById('gpe-date').value = '';
  document.getElementById('gpe-date-picker').value = '';
  syncTimeButtons();
  loadEpisodes();
});
for (const id of ['gpe-f-dur', 'gpe-f-sig', 'gpe-f-end', 'gpe-f-alt', 'gpe-f-spf']) {
  document.getElementById(id).addEventListener('change', applyFilters);
}

// Theme switch (navbar button): swap tiles, recolour rings and scatter
window.onThemeChange = function () {
  map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(isLight() ? TILE_LIGHT : TILE_DARK, TILE_OPTS).addTo(map);
  tileLayer.bringToBack();
  drawRings();
  renderScatter();
};

// ── Startup ──────────────────────────────────────────────────────────────────
(function init() {
  // Optional deep link: /gps-episodes?date=YYYY-MM-DD
  const qs = new URLSearchParams(location.search);
  const qd = qs.get('date');
  if (qd && /^\d{4}-\d{2}-\d{2}$/.test(qd)) {
    gpeDate = qd;
    const [y, m, d] = qd.split('-');
    document.getElementById('gpe-date').value = `${d}.${m}.${y}`;
    document.getElementById('gpe-date-picker').value = qd;
  }
  // Optional FL band from the GPS Quality heatmap: ?fl=100-150 or ?fl=300+
  const qf = qs.get('fl');
  const m  = qf && /^(\d{3})(?:-(\d{3})|\+)$/.exec(qf);
  if (m) {
    const lo = Number(m[1]) * 100, hi = m[2] ? Number(m[2]) * 100 : 99999;
    const sel = document.getElementById('gpe-f-alt');
    const val = `${lo}-${hi}`;
    if (![...sel.options].some(o => o.value === val)) {
      const o = document.createElement('option');
      o.value = val;
      o.textContent = m[2] ? `FL${m[1]}–${m[2]}` : `Above FL${m[1]}`;
      sel.appendChild(o);
    }
    sel.value = val;
    document.getElementById('gpe-f-dur').value = '0';   // show all episodes of that band
  }
  const savedW = Number(localStorage.getItem('ms_gpe_window'));
  if ([10800, 21600, 43200, 86400, 259200, 604800].includes(savedW)) gpeWindow = savedW;
  syncTimeButtons();
  loadEpisodes();
  // Live mode: new episodes are written every 60 s (with the GPS checkpoint)
  setInterval(() => { if (!gpeDate) loadEpisodes(); }, 60_000);
})();
