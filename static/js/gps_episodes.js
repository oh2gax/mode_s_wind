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
 * (from 2026-11-08: &icao=<list> from the GPS Aircraft page — one aircraft's or one type's
 * episodes over its period, ?icao=…&window=<s, 0 = all>; the callsign in the list links
 * to that page)
 * Time window / date are queried from the server; the other filters
 * (duration, signal, end, altitude) are applied in the browser.
 */
'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const NM_M = 1852;

// Calmer colours (from 30 Oct 2026, as the Flights page; before saturated green /
// red / amber / violet): muted, theme-aware — the same signal colours as the GPS
// Quality page (gpsPal there).  END_COLOR and the signal colours are refreshed
// by setEpColors() at start and on a theme switch.
const GPS_PAL = {
  dark:  { nacp: '#cf9f6b', nic: '#c995ad', freeze: '#88b6cd', gap: '#a8a0d0', adsb: '#76ad9f',
           rec: '#76ad9f', lost: '#d48f8f', edge: '#8b97a8', below: '#c9b26e', shut: '#a8a0d0', spoof: '#c995ad', start: '#c9b26e' },
  light: { nacp: '#a06b2e', nic: '#9c5577', freeze: '#3d7896', gap: '#6a5fa3', adsb: '#3a7a6d',
           rec: '#3a7a6d', lost: '#a94f4f', edge: '#64748b', below: '#8f7520', shut: '#6a5fa3', spoof: '#9c5577', start: '#8f7520' },
};
const gpsPal = () => GPS_PAL[document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'];
const END_COLOR = {};
function setEpColors() {
  const P = gpsPal();
  Object.assign(END_COLOR, { recovered: P.rec, lost: P.lost, edge: P.edge, below_min_alt: P.below, shutdown: P.shut });
  SIG_META.nacp.col = P.nacp; SIG_META.nic.col = P.nic; SIG_META.freeze.col = P.freeze;
  SIG_META.gap.col = P.gap;   SIG_META.adsb_loss.col = P.adsb;
}
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
setEpColors();

// ── State ────────────────────────────────────────────────────────────────────
let gpeWindow   = 86400;   // seconds (live mode)
let gpeDate     = '';      // YYYY-MM-DD when a day is selected
let gpeAll      = [];      // all episodes from the server (newest first)
let gpeShown    = [];      // after client-side filters
let gpeSelected = null;    // selected episode id
let gpeIcao     = '';      // from the GPS Aircraft page: only these aircraft (comma list)
let gpeIcaoWin  = 0;       // and their window (s; 0 = all)
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
    `<span class="gpe-chip" style="color:${SIG_META[k].col};border-color:color-mix(in srgb, ${SIG_META[k].col} 45%, transparent)" ` +
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
    let v = sp ? `<span style="color:${gpsPal().spoof}">${sp}</span>` : 'none';
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
        { color: col, weight: 1.5, opacity: 0.55 }).bindTooltip(tip, { sticky: true });
      o.line.addTo(group);
    }
    if (hasEnd && e.rec_lat != null && e.rec_lon != null) {
      o.recLine = L.polyline([[e.end_lat, e.end_lon], [e.rec_lat, e.rec_lon]],
        { color: END_COLOR.recovered, weight: 1, opacity: 0.45, dashArray: '3 4' });
      o.recLine.addTo(group);
      o.rec = L.circleMarker([e.rec_lat, e.rec_lon],
        { radius: 2.5, color: END_COLOR.recovered, weight: 1, fillColor: END_COLOR.recovered, fillOpacity: 0.7, opacity: 0.8 })
        .bindTooltip(tip);
      o.rec.addTo(group);
    }
    if (hasStart) {
      o.start = L.circleMarker([e.start_lat, e.start_lon],
        { radius: 3, color: col, weight: 1.2, fillOpacity: 0, opacity: 0.75 }).bindTooltip(tip);
      o.start.addTo(group);
    }
    if (hasEnd) {
      o.end = L.circleMarker([e.end_lat, e.end_lon],
        { radius: 3, color: col, weight: 1, fillColor: col, fillOpacity: 0.7, opacity: 0.8 }).bindTooltip(tip);
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
    if (o.line)    o.line.setStyle({ opacity: on ? (hi ? 1 : 0.55) : 0.12, weight: hi ? 3 : 1.5 });
    if (o.recLine) o.recLine.setStyle({ opacity: on ? (hi ? 0.8 : 0.45) : 0.08 });
    for (const m of [o.start, o.end, o.rec]) {
      if (!m) continue;
      m.setStyle({ opacity: on ? (hi ? 1 : 0.8) : 0.12, fillOpacity: m === o.start ? 0 : (on ? (hi ? 0.9 : 0.7) : 0.12) });
      if (hi) m.setRadius(4.5); else m.setRadius(m === o.rec ? 2.5 : 3);
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
      <td class="gpe-cs"><a class="gpe-ac-link" href="/gps-aircraft?q=${e.icao}" title="GPS history of this aircraft, day by day">${e.callsign || e.icao}</a></td>
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
  const rad = ctx => (ctx.raw && ctx.raw.sel) ? 6 : 3;
  const th  = scatterTheme(), P = gpsPal();
  const fa  = c => { const n = parseInt(c.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},0.7)`; };   // calmer: slightly transparent points
  const datasets = [
    { label: 'Start',    data: startPts, pointStyle: 'triangle', backgroundColor: fa(P.start), borderColor: fa(P.start), pointRadius: rad },
    { label: 'Recovery', data: recPts,   pointStyle: 'circle',   backgroundColor: fa(P.rec),   borderColor: fa(P.rec),   pointRadius: rad },
    { label: 'Lost',     data: lostPts,  pointStyle: 'crossRot', backgroundColor: P.lost,      borderColor: P.lost,      pointRadius: rad, borderWidth: 1.5 },
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
  const ic = gpeIcao ? `&icao=${encodeURIComponent(gpeIcao)}` : '';
  const url = gpeDate
    ? `/api/gps/episodes?date=${gpeDate}${ic}`
    : `/api/gps/episodes?window=${gpeIcao ? gpeIcaoWin : gpeWindow}${ic}`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    gpeAll = d.episodes || [];
    const now = new Date();
    const upd = document.getElementById('gpe-updated');
    upd.textContent =
      `${gpeDate ? gpeDate : gpeIcao ? (gpeIcaoWin ? Math.round(gpeIcaoWin / 86400) + ' days' : 'all days') : 'Live'} · updated ${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())} UTC`;
    if (gpeIcao) {
      const n = gpeIcao.split(',').length;
      upd.innerHTML = `<a href="/gps-aircraft?q=${n === 1 ? gpeIcao : ''}" title="Back to the GPS Aircraft page">${n === 1 ? gpeIcao : n + ' aircraft'}</a> · ` +
        upd.textContent + ' · <a href="/gps-episodes" title="All aircraft">✕</a>';
    }
    applyFilters();
  } catch (err) {
    document.getElementById('gpe-updated').textContent = 'Load failed';
  }
  if (fpSel && (fpMode === 'win' || !fpLoaded)) { fpLoaded = true; loadFalsePos(); }   // the false positions follow the window
}

// ── False positions (from 27 Nov 2026) ──────────────────────────────────────
// Aircraft whose broadcast position did not fit the arrival times of their
// replies at our GPS-timed receivers (the own multilateration's stored list,
// /api/gps/falsepos; kept without limit).  The control exists only for a user
// with Full view and the MLAT right; then everything is shown, the aircraft too.
// A ring stands where the aircraft said it was — positions that stood still are
// gathered by place (0.05°), the ring growing with their number; a line leads
// from the ring to where the aircraft was by our own fix, when there was one.
const fpSel = document.getElementById('gpe-fp');
const fpMinSel = document.getElementById('gpe-fp-min');
// a pane of its own, above the episode lines: the rings stay on top and can be clicked whenever the lines are redrawn
map.createPane('gpeFp');
map.getPane('gpeFp').style.zIndex = 450;
const fpLayer = L.layerGroup().addTo(map);
// "Episode lines: hidden" (from the evening of 27 Nov 2026): only the false positions on the map.  It applies
// while the false positions are shown; with them off the lines are always drawn, so the map is never empty.
const epLinesSel = document.getElementById('gpe-ep-lines');
let epLines = 'show';
function applyEpLines() {
  if (!epLinesSel) return;
  const hide = epLines === 'hide' && fpMode !== 'off';
  if (hide) { if (map.hasLayer(epLayer)) map.removeLayer(epLayer); }
  else if (!map.hasLayer(epLayer)) map.addLayer(epLayer);
  epLinesSel.disabled = fpMode === 'off';
  const leg = document.getElementById('gpe-legend');
  if (leg) leg.classList.toggle('gpe-ep-off', hide);
}
let fpRows = [], fpSince = null, fpMode = 'off', fpMin = 0, fpFit = false, fpSeq = 0;
let fpLoaded = false;
const FP_MODES = ['off', 'win', '2592000', '7776000', '15811200', '31536000'];
const fpEsc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fpDistKm(p, q) {
  const dy = (q[0] - p[0]) * 111.2, dx = (q[1] - p[1]) * 111.2 * Math.cos((p[0] + q[0]) / 2 * Math.PI / 180);
  return Math.hypot(dx, dy);
}
// how far off at least: from the timing (min_km), or from our own fix (km / kmx)
const fpOff = a => Math.max(a.min_km || 0, a.kmx || 0, a.km || 0);
const fpWho = a => [a.cs, a.reg, a.typ].filter(Boolean).map(fpEsc).join(' ') + ` <span style="opacity:.7">${fpEsc(a.icao)}</span>`;

async function loadFalsePos() {
  if (!fpSel) return;
  const seq = ++fpSeq;
  if (fpMode === 'off') { fpRows = []; renderFalsePos(); return; }
  const url = fpMode === 'win'
    ? (gpeDate ? `/api/gps/falsepos?date=${gpeDate}` : `/api/gps/falsepos?window=${gpeIcao ? (gpeIcaoWin || 31536000) : gpeWindow}`)
    : `/api/gps/falsepos?window=${fpMode}`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    if (seq !== fpSeq) return;                  // a newer request is on its way
    fpRows = d.on ? (d.rows || []) : [];
    fpSince = d.since || null;
    if (gpeIcao) { const only = new Set(gpeIcao.split(',')); fpRows = fpRows.filter(a => only.has(String(a.icao).toUpperCase())); }
    renderFalsePos(d.on ? '' : (d.why || 'not available'));
  } catch (err) {
    if (seq === fpSeq) { fpRows = []; renderFalsePos('load failed'); }
  }
}

function renderFalsePos(why) {
  if (!fpSel) return;
  fpLayer.clearLayers();
  const leg = document.getElementById('gpe-fp-leg'), sum = document.getElementById('gpe-fp-sum');
  if (leg) leg.hidden = fpMode === 'off';
  if (fpMode === 'off') return;
  // the ring's own colour: none of the episode-end colours, and clear of the many "lost" lines
  const P = gpsPal(), ring = isLight() ? '#5b2440' : '#f6e8f0', fillCol = P.spoof, ownCol = P.freeze;
  const home = [GPE_AIRPORT.lat, GPE_AIRPORT.lon];
  // (a first position more than 600 km away is a decoding slip of the first frames, not a place: left out)
  const rows = fpRows.filter(a => a.bc && fpOff(a) >= fpMin)
    .map(a => (a.bc0 && fpDistKm(home, a.bc0) > 600) ? { ...a, bc0: null } : a);
  // positions that stood still, by place; one that moved (2 km or more between its first and last) on its own
  const groups = new Map();
  for (const a of rows) {
    const moved = a.bc0 ? fpDistKm(a.bc0, a.bc) : 0;
    const key = moved < 2 ? `${Math.round(a.bc[0] / 0.05)}_${Math.round(a.bc[1] / 0.05)}` : `m_${a.icao}_${a.t0}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { rows: [], lat: 0, lon: 0, moved: moved >= 2 });
    g.rows.push(a); g.lat += a.bc[0]; g.lon += a.bc[1];
  }
  const bounds = [];
  let lines = 0;
  // large groups first, so the small rings stay on top and can be clicked
  for (const g of [...groups.values()].sort((x, y) => y.rows.length - x.rows.length)) {
    const n = g.rows.length, c = [g.lat / n, g.lon / n];
    const acs = new Set(g.rows.map(a => a.icao)).size;
    const tMin = Math.min(...g.rows.map(a => a.t0)), tMax = Math.max(...g.rows.map(a => a.t1));
    const far = Math.max(...g.rows.map(fpOff));
    if (fpDistKm(home, c) <= 800) bounds.push(c);      // a place further away than that does not zoom the map out
    for (const a of g.rows) {
      if (g.moved && a.bc0) {                   // the broadcast position's own path, first → last
        L.polyline([a.bc0, a.bc], { color: ring, weight: 1.2, opacity: 0.7, dashArray: '1 4', interactive: false, pane: 'gpeFp' }).addTo(fpLayer);
        L.circleMarker(a.bc0, { radius: 3, color: ring, weight: 1.5, fill: false, opacity: 0.8, interactive: false, pane: 'gpeFp' }).addTo(fpLayer);
      }
      if (a.own && lines < 600) {               // where the aircraft was by our own fix
        lines++;
        L.polyline([a.bc, a.own], { color: ring, weight: 1, opacity: 0.45, dashArray: '5 5', interactive: false, pane: 'gpeFp' }).addTo(fpLayer);
        L.circleMarker(a.own, { radius: 3.5, color: isLight() ? '#ffffff' : '#0f172a', weight: 1, fillColor: ownCol, fillOpacity: 0.95, pane: 'gpeFp' })
          .bindTooltip(`${[a.cs, a.reg, a.typ].filter(Boolean).join(' ') || a.icao} · ${fmtUtc(a.t1, true)} UTC · here by our own fix, ` +
                       `${a.km != null ? Math.round(a.km) + ' km from the position it broadcast' : 'position broadcast elsewhere'}`).addTo(fpLayer);
        bounds.push(a.own);
      }
    }
    const newest = [...g.rows].sort((x, y) => y.t1 - x.t1);
    const rowsHtml = newest.slice(0, 14).map(a =>
      `<tr><td>${fmtUtc(a.t0, true)}</td><td>${fmtDur(a.t1 - a.t0)}</td><td>${fpWho(a)}</td><td>FL${fmtFl(a.alt)}</td>` +
      `<td>${a.nic == null ? '–' : a.nic}/${a.nacp == null ? '–' : a.nacp}</td><td>${Math.round(fpOff(a))} km</td>` +
      `<td>${a.own ? (a.km != null ? Math.round(a.km) + ' km' : 'yes') : '–'}</td></tr>`).join('');
    const pop = `<div class="gpe-fp-pop"><b>${n} listing${n === 1 ? '' : 's'} · ${acs} aircraft</b> · ` +
      `${c[0].toFixed(2)}° N ${c[1].toFixed(2)}° E${g.moved ? ' (moving)' : ''}<br>${fmtUtc(tMin, true)} – ${fmtUtc(tMax, true)} UTC · off by up to ${Math.round(far)} km` +
      (g.rows.some(a => a.alias) ? '<br><span style="opacity:.75">Some of these were stored one longitude zone too far west (before 27 Nov 2026); shown here where they were broadcast.</span>' : '') +
      `<table><tr><th>From (UTC)</th><th>Lasted</th><th>Aircraft</th><th>Level</th><th>NIC/NACp</th><th>Off by at least</th><th>From our fix</th></tr>${rowsHtml}</table>` +
      (n > 14 ? `<div class="gpe-fp-more">and ${n - 14} earlier</div>` : '') + '</div>';
    L.circleMarker(c, { radius: Math.min(26, 5 + 3 * Math.sqrt(n)), color: ring, weight: 2.2, opacity: 0.95, fillColor: fillCol, fillOpacity: 0.3, pane: 'gpeFp' })
      .bindTooltip(`${n} false position${n === 1 ? '' : 's'} · ${acs} aircraft · up to ${Math.round(far)} km off — click for the list`)
      .bindPopup(pop, { maxWidth: 460 }).addTo(fpLayer);
  }
  if (sum) {
    const acAll = new Set(rows.map(a => a.icao)).size, own = rows.filter(a => a.own).length;
    const sd = fpSince ? new Date(fpSince * 1000) : null;
    sum.textContent = why ? `Not shown: ${why}` :
      `${rows.length} listing${rows.length === 1 ? '' : 's'} · ${acAll} aircraft · ${groups.size} place${groups.size === 1 ? '' : 's'} · ${own} with our own fix` +
      (sd ? ` · list kept from ${sd.getUTCDate()}.${sd.getUTCMonth() + 1}.${sd.getUTCFullYear()}` : '');
  }
  if (fpFit && bounds.length) {                 // once, when the layer is switched on: show all of it
    fpFit = false;
    map.fitBounds(L.latLngBounds(bounds.concat([[GPE_AIRPORT.lat, GPE_AIRPORT.lon]])).pad(0.12), { maxZoom: 8 });
  }
}

if (fpSel) {
  const sm = localStorage.getItem('ms_gpe_fp');
  if (FP_MODES.includes(sm)) fpMode = sm;
  fpSel.value = fpMode;
  const sv = Number(localStorage.getItem('ms_gpe_fp_min'));
  if ([0, 5, 20].includes(sv)) fpMin = sv;
  fpMinSel.value = String(fpMin);
  fpSel.addEventListener('change', () => {
    fpFit = fpMode === 'off' && fpSel.value !== 'off';     // switched on: fit the map to it once
    fpMode = fpSel.value;
    localStorage.setItem('ms_gpe_fp', fpMode);
    applyEpLines();
    loadFalsePos();
  });
  if (localStorage.getItem('ms_gpe_ep_lines') === 'hide') epLines = 'hide';
  epLinesSel.value = epLines;
  epLinesSel.addEventListener('change', () => {
    epLines = epLinesSel.value === 'hide' ? 'hide' : 'show';
    localStorage.setItem('ms_gpe_ep_lines', epLines);
    applyEpLines();
  });
  applyEpLines();
  fpMinSel.addEventListener('change', () => {
    fpMin = Number(fpMinSel.value) || 0;
    localStorage.setItem('ms_gpe_fp_min', String(fpMin));
    renderFalsePos();
  });
  // a longer period than the window: the stored list changes once a minute at most
  setInterval(() => { if (fpMode !== 'off' && fpMode !== 'win') loadFalsePos(); }, 600_000);
}

// ── Controls ─────────────────────────────────────────────────────────────────
function syncTimeButtons() {
  document.querySelectorAll('#gpe-window-btns .gps-range-btn').forEach(b =>
    b.classList.toggle('active', !gpeDate && !gpeIcao && Number(b.dataset.window) === gpeWindow));
  document.getElementById('gpe-live-btn').classList.toggle('active', !gpeDate && !gpeIcao);
}

document.getElementById('gpe-window-btns').addEventListener('click', ev => {
  const b = ev.target.closest('.gps-range-btn');
  if (!b) return;
  gpeIcao = '';                      // a window button: back to all aircraft
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
  gpeIcao = '';
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
  setEpColors();
  renderAll();            // map lines, list, summary and scatter in the theme's colours
  renderFalsePos();       // and the false positions (from 27 Nov 2026)
};

// ── Startup ──────────────────────────────────────────────────────────────────
(function init() {
  // Optional deep link: /gps-episodes?date=YYYY-MM-DD
  const qs = new URLSearchParams(location.search);
  // From the GPS Aircraft page (2026-11-08): ?icao=A,B&window=<s> (0 = all)
  const qi = (qs.get('icao') || '').split(',').filter(x => /^[0-9A-Fa-f]{6}$/.test(x)).join(',').toUpperCase();
  if (qi) {
    gpeIcao = qi;
    gpeIcaoWin = Math.max(0, Number(qs.get('window') || 0));
    document.getElementById('gpe-f-dur').value = '0';
  }
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
  setInterval(() => { if (!gpeDate && !gpeIcao) loadEpisodes(); }, 60_000);
})();
