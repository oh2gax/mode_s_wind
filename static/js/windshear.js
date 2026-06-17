/**
 * windshear.js — Approach monitoring page for MODE-S Wind.
 *
 * Displays aircraft currently on approach within WS_RADIUS_NM of the
 * configured airport on:
 *   • ATC-style flight strips (left panel)
 *   • Leaflet map with airport + ILS overlays (top right)
 *   • ILS vertical profile / glideslope canvas (bottom right)
 *
 * Data source: /api/windshear/state  — polled every 3 s (RAM-only, no DB).
 * Weather:     /api/wx               — polled every 10 min.
 *
 * Glideslope reference: 3° → 318.5 ft per NM (tan(3°) × 6 076 ft/NM).
 */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const GS_FT_PER_NM   = 318.5;
const GS_TOL_FT      = 300;
const PROFILE_MAX_NM  = 15;    // full-range view
const PROFILE_ZOOM_NM = 7.5;   // zoomed view (half range, denser barb spacing)
const PROFILE_MAX_FT = 5_000;

// Wind barb history accumulation — standard (Lo) resolution
const WS_WIND_HIST_MAX    = 40;   // max stored observations per tracked aircraft
const WS_WIND_MIN_ALT_GAP = 400;  // ft — minimum altitude change before storing a new point
const WS_WIND_MIN_DIST_GAP = 0.5; // NM — OR minimum distance change (for level segments)

// Wind barb history accumulation — high (Hi) resolution (research mode, separate buffer)
const WS_WIND_HI_HIST_MAX    = 100;  // larger buffer — covers full 15 NM approach at Hi density
const WS_WIND_HI_MIN_ALT_GAP = 150;  // ft — tighter altitude gate
const WS_WIND_HI_MIN_DIST_GAP = 0.2; // NM — tighter distance gate (~3–4× denser than Lo)

// Windshear detection thresholds
const WS_MONITOR_KT     = 10;    // sub-threshold informational level (Monitor)
const WS_WARNING_KT     = 15;    // ICAO windshear threshold (Warning)
const WS_ALARM_KT       = 25;    // severe windshear threshold (Alarm)
const WS_MAX_ALT_BAND   = 2000;  // max altitude separation (ft) between compared aircraft
const WS_MIN_ALT_BAND   = 200;   // min altitude separation (ft) — avoid same-level noise
// Minimum stored observations for an aircraft before any detection algorithm fires.
// At the typical 3-second poll rate this equals ~15–20 s of established corridor flight,
// preventing the noisy first BDS 5,0/6,0 snapshot (captured during the ILS intercept
// turn roll-out) from being used as a reference point in oldest-vs-newest comparisons.
// Also ensures the 3-sample median filter on window edges has enough data to be effective.
const WS_MIN_CORRIDOR_SAMPLES = 6;

/** Map a delta_kt value to one of three severity levels. */
function wsSeverity(delta) {
  if (delta >= WS_ALARM_KT)   return 'alarm';
  if (delta >= WS_WARNING_KT) return 'warning';
  return 'monitor';
}

// EFHK runway magnetic headings — used by client-side shear algorithms
const RWY_HEADINGS = {
  '04L': 47, '04R': 47, '22L': 227, '22R': 227, '15': 152, '33': 323,
};

// Meteo-source colour palette (matches live map)
const SRC_COLOR = {
  MRAR:     '#3b82f6',
  COMPUTED: '#10b981',
  MHR:      '#f59e0b',
  JSON:     '#a855f7',
  NONE:     '#6b7280',
};

function acColor(src) {
  return SRC_COLOR[src] || SRC_COLOR.NONE;
}

// GS-status → dot colour for ILS profile
const GS_COLOR = {
  ON:   '#6ee7b7',
  HIGH: '#fcd34d',
  LOW:  '#fca5a5',
  FAR:  '#6b7280',
};

// ── Map initialisation ────────────────────────────────────────────────────────
const map = L.map('ws-map', { zoomControl: true })
             .setView([WS_AIRPORT_LAT, WS_AIRPORT_LON], 10);

// Tile layers for theme switching
const TILES = {
  dark: L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    { attribution: '© OSM © CARTO', subdomains: 'abcd', maxZoom: 18 }
  ),
  grey: L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    { attribution: '© OSM © CARTO', subdomains: 'abcd', maxZoom: 18 }
  ),
  atc: L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png',
    { attribution: '© OSM © CARTO', subdomains: 'abcd', maxZoom: 18,
      opacity: 0.0 }     // tiles hidden, bg = #cfcfcf (ATC radar grey)
  ),
  black: L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
    { attribution: '© OSM © CARTO', subdomains: 'abcd', maxZoom: 18,
      opacity: 0.0 }     // tiles hidden, bg = #000
  ),
};

// Overlay cycling state for ATC and Black themes.
// Level 0 = ILS only, 1 = + coast, 2 = + coast + aqua
const overlayLevelByTheme = { atc: 0, black: 0 };
const OVERLAY_LEVEL_LABELS = {
  atc:   ['ATC', 'ATC+C', 'ATC+CA'],
  black: ['Black', 'Black+C', 'Black+CA'],
};

let currentTheme = 'dark';
TILES.dark.addTo(map);

// Airport marker
L.circleMarker([WS_AIRPORT_LAT, WS_AIRPORT_LON], {
  radius: 6, color: '#fff', fillColor: '#1d4ed8',
  fillOpacity: 1, weight: 2,
}).bindTooltip('EFHK').addTo(map);

// 30 NM range circle
L.circle([WS_AIRPORT_LAT, WS_AIRPORT_LON], {
  radius:      WS_RADIUS_NM * 1_852,
  color:       '#334155',
  weight:      1,
  fill:        false,
  dashArray:   '4 6',
}).addTo(map);

// ── GeoJSON overlays ──────────────────────────────────────────────────────────

let ilsLayer   = null;
let aptLayer   = null;
let coastLayer = null;
let aquaLayer  = null;

function ilsStyle(theme) {
  if (theme === 'atc')  return { color: '#1a3a6b', weight: 2,   opacity: 0.9, dashArray: '6 5',  fillOpacity: 0 };
  if (theme === 'grey') return { color: '#64748b', weight: 1.5, opacity: 0.7, dashArray: '6 5',  fillOpacity: 0 };
  return                       { color: '#38bdf8', weight: 1.5, opacity: 0.6, dashArray: '6 5',  fillOpacity: 0 };
}
// RNP approach centreline — amber, longer dash, visually distinct from ILS
function rnpStyle(theme) {
  if (theme === 'atc')  return { color: '#92400e', weight: 2,   opacity: 0.9, dashArray: '10 5', fillOpacity: 0 };
  if (theme === 'grey') return { color: '#a8a29e', weight: 1.5, opacity: 0.7, dashArray: '10 5', fillOpacity: 0 };
  return                       { color: '#f59e0b', weight: 1.5, opacity: 0.7, dashArray: '10 5', fillOpacity: 0 };
}
function aptStyle(theme) {
  if (theme === 'atc')  return { color: '#2d4a6b', weight: 1, opacity: 0.7, fillOpacity: 0 };
  if (theme === 'grey') return { color: '#475569', weight: 1, opacity: 0.5, fillOpacity: 0 };
  return                       { color: '#94a3b8', weight: 1, opacity: 0.5, fillOpacity: 0 };
}
function coastStyle(theme) {
  if (theme === 'atc') return { color: '#4a6080', weight: 1,   opacity: 0.8, fillOpacity: 0 };
  return                      { color: '#2a4060', weight: 1,   opacity: 0.7, fillOpacity: 0 };
}
function aquaStyle(theme) {
  if (theme === 'atc') return { color: '#7098b8', weight: 0.5, opacity: 0.6, fillColor: '#b8d0e8', fillOpacity: 0.35 };
  return                      { color: '#1a3a60', weight: 0.5, opacity: 0.5, fillColor: '#0a1e3a', fillOpacity: 0.45 };
}

async function loadOverlays(theme, level = 0) {
  // Remove all overlay layers
  if (ilsLayer)   { map.removeLayer(ilsLayer);   ilsLayer   = null; }
  if (aptLayer)   { map.removeLayer(aptLayer);   aptLayer   = null; }
  if (coastLayer) { map.removeLayer(coastLayer); coastLayer = null; }
  if (aquaLayer)  { map.removeLayer(aquaLayer);  aquaLayer  = null; }

  try {
    // ILS — always loaded; filtered to EFHK features
    const ilsGeo = await fetch('/overlays/efhk_ils.geojson').then(r => r.json());
    const efhkIls = {
      type: 'FeatureCollection',
      features: ilsGeo.features.filter(
        f => f.properties && f.properties.airport === 'EFHK'
      ),
    };
    ilsLayer = L.geoJSON(efhkIls, {
      style: f => f.properties?.approach_type === 'RNP' ? rnpStyle(theme) : ilsStyle(theme),
    }).addTo(map);

    // Airport layout — only for tile-based themes (dark / grey)
    if (theme === 'dark' || theme === 'grey') {
      const aptGeo = await fetch('/overlays/efhk_apt.geojson').then(r => r.json());
      aptLayer = L.geoJSON(aptGeo, { style: aptStyle(theme) }).addTo(map);
    }

    // Level 1+: coastline
    if (level >= 1) {
      const coastGeo = await fetch('/overlays/efhk_coast.geojson').then(r => r.json());
      coastLayer = L.geoJSON(coastGeo, { style: coastStyle(theme) }).addTo(map);
    }

    // Level 2: water / aqua polygons
    if (level >= 2) {
      const aquaGeo = await fetch('/overlays/efhk_aqua.geojson').then(r => r.json());
      aquaLayer = L.geoJSON(aquaGeo, { style: aquaStyle(theme) }).addTo(map);
    }
  } catch (e) {
    console.warn('Overlay load failed:', e);
  }
}

loadOverlays(currentTheme);

// ── Theme switching ───────────────────────────────────────────────────────────

function updateThemeButtons() {
  document.querySelectorAll('.ws-theme-btn').forEach(b => {
    const t = b.dataset.theme;
    b.classList.toggle('active', t === currentTheme);
    // Show cycling level label for ATC / Black when active
    if (OVERLAY_LEVEL_LABELS[t]) {
      const level = overlayLevelByTheme[t] ?? 0;
      b.textContent = (t === currentTheme)
        ? OVERLAY_LEVEL_LABELS[t][level]
        : OVERLAY_LEVEL_LABELS[t][0];
    }
  });
}

function applyTheme(theme) {
  const container = document.getElementById('ws-map');

  // ATC / Black: if already active, cycle overlay level instead of re-switching
  if ((theme === 'atc' || theme === 'black') && currentTheme === theme) {
    overlayLevelByTheme[theme] = (overlayLevelByTheme[theme] + 1) % 3;
    loadOverlays(theme, overlayLevelByTheme[theme]);
    updateThemeButtons();
    return;
  }

  currentTheme = theme;

  // Swap tile layer
  Object.values(TILES).forEach(t => map.removeLayer(t));
  TILES[theme].addTo(map);

  // Flat-colour themes: set background; tile-based themes: clear it
  if (theme === 'black') container.style.background = '#000';
  else if (theme === 'atc') container.style.background = '#cfcfcf';
  else container.style.background = '';

  // Load overlays at the stored level for this theme (resets to 0 on first switch)
  const level = overlayLevelByTheme[theme] ?? 0;
  loadOverlays(theme, level);

  updateThemeButtons();

  // Redraw ILS canvas with updated colours
  drawIlsProfile(lastAircraft);
}

document.querySelectorAll('.ws-theme-btn').forEach(btn => {
  btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
});

// ── Aircraft markers on map ───────────────────────────────────────────────────
const acMarkers = {};   // icao → { marker, label }

function makeAcIcon(src) {
  const color = acColor(src);
  return L.divIcon({
    html: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14"
               viewBox="0 0 14 14">
             <rect x="1" y="1" width="12" height="12"
                   fill="${color}" stroke="#000" stroke-width="1" rx="2"/>
           </svg>`,
    className:  '',
    iconSize:   [14, 14],
    iconAnchor: [7, 7],
  });
}

function updateMapMarkers(aircraft) {
  const seen = new Set();

  for (const ac of aircraft) {
    if (ac.lat == null || ac.lon == null) continue;

    // When ILS filter is active, hide non-corridor aircraft
    if (ilsFilterActive && !ac.in_corridor) {
      // Remove existing marker if present so it disappears immediately
      if (acMarkers[ac.icao]) {
        map.removeLayer(acMarkers[ac.icao].marker);
        map.removeLayer(acMarkers[ac.icao].label);
        delete acMarkers[ac.icao];
      }
      continue;
    }

    seen.add(ac.icao);

    const tip = [
      `${ac.callsign || ac.icao}`,
      ac.approach_runway ? `RWY ${ac.approach_runway}` : 'No ILS match',
      `${ac.altitude?.toLocaleString()} ft`,
      ac.dist_thr_nm != null
        ? `${ac.dist_thr_nm.toFixed(1)} NM`
        : `${ac.dist_apt_nm?.toFixed(1)} NM (apt)`,
    ].filter(Boolean).join(' · ');

    if (acMarkers[ac.icao]) {
      acMarkers[ac.icao].marker.setLatLng([ac.lat, ac.lon]);
      acMarkers[ac.icao].marker.setIcon(makeAcIcon(ac.meteo_source));
      acMarkers[ac.icao].marker.setTooltipContent(tip);
      acMarkers[ac.icao].label.setLatLng([ac.lat, ac.lon]);
      // Refresh label text so callsign appears as soon as the server provides it,
      // rather than staying frozen as ICAO24 from the first poll.
      acMarkers[ac.icao].label.setIcon(L.divIcon({
        html: `<div class="ws-ac-label${ac.in_corridor ? '' : ' ws-ac-label-dim'}">${ac.callsign || ac.icao}</div>`,
        className: '',
        iconAnchor: [-10, 5],
      }));
    } else {
      const marker = L.marker([ac.lat, ac.lon], {
        icon: makeAcIcon(ac.meteo_source),
        zIndexOffset: ac.in_corridor ? 100 : 50,
      }).bindTooltip(tip, { direction: 'top', offset: [0, -12] }).addTo(map);

      const label = L.marker([ac.lat, ac.lon], {
        icon: L.divIcon({
          html: `<div class="ws-ac-label${ac.in_corridor ? '' : ' ws-ac-label-dim'}">${ac.callsign || ac.icao}</div>`,
          className: '',
          iconAnchor: [-10, 5],
        }),
        interactive: false,
        zIndexOffset: ac.in_corridor ? 50 : 10,
      }).addTo(map);

      acMarkers[ac.icao] = { marker, label };
    }
  }

  // Remove stale markers
  for (const icao of Object.keys(acMarkers)) {
    if (!seen.has(icao)) {
      map.removeLayer(acMarkers[icao].marker);
      map.removeLayer(acMarkers[icao].label);
      delete acMarkers[icao];
    }
  }
}

// ── ILS vertical profile canvas ───────────────────────────────────────────────
const ilsCanvas = document.getElementById('ws-ils-canvas');
const ilsCtx    = ilsCanvas.getContext('2d');

// Margin constants (computed in draw)
const M = { left: 52, right: 20, top: 18, bottom: 34 };

function resizeIlsCanvas() {
  const wrap = ilsCanvas.parentElement;
  ilsCanvas.width  = wrap.clientWidth;
  ilsCanvas.height = wrap.clientHeight;
}

new ResizeObserver(() => {
  resizeIlsCanvas();
  drawIlsProfile(lastAircraft);
}).observe(ilsCanvas.parentElement);
resizeIlsCanvas();

// ── Theme-aware colour palette for the ILS and Wind Rose canvases ─────────
function wsCanvasTheme() {
  const light = document.documentElement.dataset.theme === 'light';
  return {
    bg:         light ? '#eef2f7' : '#0f1923',
    grid:       light ? '#c5d0da' : '#1e2d40',
    gsband:     light ? 'rgba(37,99,235,0.08)'  : 'rgba(56,189,248,0.07)',
    gsline:     light ? '#2563eb' : '#38bdf8',
    annot:      light ? '#475569' : '#475569',
    axisLabel:  light ? '#475569' : '#64748b',
    noTraffic:  light ? '#64748b' : '#334155',
    trail:      light ? 'rgba(0,0,0,0.26)'      : 'rgba(255,255,255,0.32)',
    staleRing:  light ? 'rgba(37,99,235,0.30)'  : 'rgba(56,189,248,0.30)',
    staleGlow:  light ? 'rgba(37,99,235,0.08)'  : 'rgba(56,189,248,0.08)',
    dotBorder:  '#000',
    barbHint:   light ? '#64748b' : '#475569',
    // Wind Rose
    roseBg:     light ? '#e8edf3' : '#0a121c',
    roseOuter:  light ? '#b8c8d8' : '#1a2d40',
    roseRing:   light ? '#94a3b8' : '#1e3a5f',
    roseSpeed:  light ? '#94a3b8' : '#475569',
    roseInner:  light ? '#c5d5e5' : '#3b6ea0',
    roseLabel:  light ? '#475569' : '#475569',
  };
}

function drawIlsProfile(aircraft, shearEvents = []) {
  // Honour the zoom toggle — half the horizontal range for denser barb spacing
  const profileNm = profileZoomActive ? PROFILE_ZOOM_NM : PROFILE_MAX_NM;

  const W = ilsCanvas.width;
  const H = ilsCanvas.height;
  const PW = W - M.left - M.right;
  const PH = H - M.top  - M.bottom;

  ilsCtx.clearRect(0, 0, W, H);
  const CT = wsCanvasTheme();

  // Background
  ilsCtx.fillStyle = CT.bg;
  ilsCtx.fillRect(0, 0, W, H);

  if (PW < 20 || PH < 20) return;

  // Helper: convert distance (NM) to X pixel
  // 0 NM (threshold) → right edge, profileNm → left edge
  const distX = d => M.left + (1 - d / profileNm) * PW;
  // Helper: convert altitude (ft) to Y pixel
  const altY  = a => M.top  + (1 - a / PROFILE_MAX_FT) * PH;

  // ── Grid ──────────────────────────────────────────────────────────────────
  ilsCtx.strokeStyle = CT.grid;
  ilsCtx.lineWidth   = 1;

  // Altitude grid lines (every 500 ft)
  for (let a = 0; a <= PROFILE_MAX_FT; a += 500) {
    const y = altY(a);
    ilsCtx.beginPath();
    ilsCtx.moveTo(M.left, y);
    ilsCtx.lineTo(M.left + PW, y);
    ilsCtx.stroke();
  }
  // Distance grid lines (every 5 NM, or every 2.5 NM when zoomed)
  const gridStepNm = profileZoomActive ? 2.5 : 5;
  for (let d = 0; d <= profileNm; d += gridStepNm) {
    const x = distX(d);
    ilsCtx.beginPath();
    ilsCtx.moveTo(x, M.top);
    ilsCtx.lineTo(x, M.top + PH);
    ilsCtx.stroke();
  }

  // ── 3° glideslope ─────────────────────────────────────────────────────────
  // The glideslope reference is computed in pressure-altitude terms so that
  // aircraft dots (always plotted at MODE-S pressure altitude) land on the
  // line when they are geometrically on the 3° slope.
  //
  //   gs_ref(d) = THR_ELEV_FT           ← threshold above MSL
  //             + d × 318.5             ← 3° geometric climb (ft/NM)
  //             + (1013.25 − QNH) × 27  ← convert geometric → pressure alt
  //             + GS_OFFSET_FT          ← manual calibration trim
  //
  const qnhCorr   = (1013.25 - currentQnh) * 27;   // positive when QNH < std
  const gsBaseline = WS_THR_ELEVATION_FT + WS_GS_OFFSET_FT + qnhCorr;
  const gsRef = d => gsBaseline + d * GS_FT_PER_NM;

  // GS tolerance band (±300 ft around the corrected line); cap at canvas width
  const gsMaxDist = Math.min(profileNm, (PROFILE_MAX_FT - gsBaseline) / GS_FT_PER_NM);
  ilsCtx.beginPath();
  ilsCtx.moveTo(distX(0),         altY(gsRef(0) + GS_TOL_FT));
  ilsCtx.lineTo(distX(gsMaxDist), altY(gsRef(gsMaxDist) + GS_TOL_FT));
  ilsCtx.lineTo(distX(gsMaxDist), altY(gsRef(gsMaxDist) - GS_TOL_FT));
  ilsCtx.lineTo(distX(0),         altY(gsRef(0) - GS_TOL_FT));
  ilsCtx.closePath();
  ilsCtx.fillStyle = CT.gsband;
  ilsCtx.fill();

  // Glideslope centreline
  ilsCtx.beginPath();
  ilsCtx.moveTo(distX(0),         altY(gsRef(0)));
  ilsCtx.lineTo(distX(gsMaxDist), altY(gsRef(gsMaxDist)));
  ilsCtx.strokeStyle  = CT.gsline;
  ilsCtx.lineWidth    = 1.5;
  ilsCtx.setLineDash([6, 4]);
  ilsCtx.globalAlpha = 0.7;
  ilsCtx.stroke();
  ilsCtx.setLineDash([]);
  ilsCtx.globalAlpha = 1;

  // Small annotation: active corrections
  const corrSign = qnhCorr >= 0 ? '+' : '';
  ilsCtx.fillStyle = CT.annot;
  ilsCtx.font      = '9px "Courier New", monospace';
  ilsCtx.textAlign = 'right';
  ilsCtx.fillText(
    `GS ref: thr+${WS_THR_ELEVATION_FT}ft  QNH${corrSign}${Math.round(qnhCorr)}ft  trim${WS_GS_OFFSET_FT >= 0 ? '+' : ''}${WS_GS_OFFSET_FT}ft`,
    M.left + PW - 4, M.top + 10
  );

  // ── Windshear zones ───────────────────────────────────────────────────────
  if (wsDetectionEnabled && shearEvents.length > 0) {
    const selectedRwyForShear = document.getElementById('ws-ils-rwy').value;
    for (const ev of shearEvents) {
      if (!matchesRwyFilter(ev.rwy, selectedRwyForShear)) continue;
      const color = ev.severity === 'alarm'   ? '#ef4444'
                  : ev.severity === 'warning' ? '#d97706'
                  : '#3b82f6';  // monitor — blue informational band
      const yTop  = altY(ev.alt_high);
      const yBot  = altY(ev.alt_low);
      const zoneH = yBot - yTop;
      if (zoneH <= 0) continue;

      // Full-width semi-transparent band
      ilsCtx.fillStyle = color + '22';
      ilsCtx.fillRect(M.left, yTop, PW, zoneH);

      // Left and right edge lines
      ilsCtx.strokeStyle = color + '88';
      ilsCtx.lineWidth   = 1;
      ilsCtx.setLineDash([3, 3]);
      ilsCtx.beginPath();
      ilsCtx.moveTo(M.left, yTop);   ilsCtx.lineTo(M.left + PW, yTop);
      ilsCtx.moveTo(M.left, yBot);   ilsCtx.lineTo(M.left + PW, yBot);
      ilsCtx.stroke();
      ilsCtx.setLineDash([]);

      // Label on the right edge
      ilsCtx.fillStyle  = color;
      ilsCtx.font       = '10px "Courier New", monospace';
      ilsCtx.textAlign  = 'right';
      const trendArrow = ev.hw_trend === 'loss' ? '▼' : ev.hw_trend === 'gain' ? '▲' : '';
      const label = `WS ${ev.delta_kt}kt${trendArrow}`;
      ilsCtx.fillText(label, M.left + PW - 4, yTop + zoneH / 2 + 4);
    }
  }

  // ── Axis labels ───────────────────────────────────────────────────────────
  ilsCtx.fillStyle  = CT.axisLabel;
  ilsCtx.font       = '10px "Courier New", monospace';
  ilsCtx.textAlign  = 'right';
  for (let a = 0; a <= PROFILE_MAX_FT; a += 500) {
    if (a === 0) continue;
    ilsCtx.fillText(a.toLocaleString(), M.left - 4, altY(a) + 3);
  }
  ilsCtx.textAlign = 'center';
  for (let d = 0; d <= profileNm; d += gridStepNm) {
    ilsCtx.fillText(d === 0 ? 'THR' : `${d}`, distX(d), M.top + PH + 12);
  }

  // Axis unit labels
  ilsCtx.save();
  ilsCtx.translate(10, M.top + PH / 2);
  ilsCtx.rotate(-Math.PI / 2);
  ilsCtx.textAlign = 'center';
  ilsCtx.fillText('ft', 0, 0);
  ilsCtx.restore();
  ilsCtx.textAlign = 'center';
  ilsCtx.fillText('NM from threshold', M.left + PW / 2, H - 4);

  // ── Plot aircraft ─────────────────────────────────────────────────────────
  if (!aircraft || aircraft.length === 0) {
    // Only return early if there are no NONE circles to draw for the selected
    // aircraft.  When an aircraft briefly exits the corridor geometry during a
    // wide localizer intercept (while transitioning from NONE to valid meteo),
    // the corridor list becomes empty but the NONE history is still valid.
    // Returning here would hide those circles for the duration of the gap.
    const hasNoneToShow = barbLayerActive && barbSelectedIcao &&
      ((wsNoneHistory[barbSelectedIcao]        || []).length > 0 ||
       (wsPreCorridorHistory[barbSelectedIcao] || []).length > 0);
    if (!hasNoneToShow) {
      ilsCtx.fillStyle  = CT.noTraffic;
      ilsCtx.font       = '12px system-ui, sans-serif';
      ilsCtx.textAlign  = 'center';
      ilsCtx.fillText('No approach traffic', M.left + PW / 2, M.top + PH / 2);
      return;
    }
    // Fall through: draw the grid and NONE circles even with no corridor dots.
  }

  const selectedRwy = document.getElementById('ws-ils-rwy').value;

  for (const ac of aircraft) {
    if (!matchesRwyFilter(ac.approach_runway, selectedRwy)) continue;
    if (ac.dist_thr_nm == null) continue;

    const gs = computeGsStatus(ac);
    const color = GS_COLOR[gs] || GS_COLOR.FAR;

    // ── History trail ────────────────────────────────────────────────────────
    // A gap of >10 s between consecutive history points indicates a position
    // outage (GPS freeze or ADS-B dropout).  Use moveTo instead of lineTo at
    // those breaks so the trail shows a visible blank rather than a straight
    // line connecting across the outage.  Normal polling jitter is 3–6 s so
    // 10 s cleanly separates real gaps from minor timing variation.
    const TRAIL_GAP_SEC = 10;
    if (trkActive && ac.history && ac.history.length > 1) {
      ilsCtx.beginPath();
      let first = true;
      let prevTs = null;
      for (const h of ac.history) {
        if (h.dist_thr > profileNm || h.altitude > PROFILE_MAX_FT) continue;
        const hx = distX(h.dist_thr);
        const hy = altY(h.altitude);
        const isGap = prevTs !== null && (h.ts - prevTs) > TRAIL_GAP_SEC;
        if (first || isGap) { ilsCtx.moveTo(hx, hy); first = false; }
        else ilsCtx.lineTo(hx, hy);
        prevTs = h.ts;
      }
      ilsCtx.strokeStyle  = CT.trail;
      ilsCtx.lineWidth    = 1;
      ilsCtx.stroke();
    }

    // ── Current position dot ─────────────────────────────────────────────────
    if (ac.dist_thr_nm > profileNm || ac.altitude > PROFILE_MAX_FT) continue;

    const x = distX(ac.dist_thr_nm);
    const y = altY(ac.altitude);

    // Near-ground stale: below 1 000 ft AND no data for >20 s.
    // Signal is likely lost on short final.  Show a dimmed dot without label;
    // normal tracker pruning (30–45 s) will remove the aircraft shortly after.
    const nowSec = Date.now() / 1000;
    const nearStale = ac.altitude < 1_000 && (nowSec - ac.last_seen) > 10;

    const dotColor = nearStale ? CT.staleRing : color;

    // Glow ring
    ilsCtx.beginPath();
    ilsCtx.arc(x, y, 8, 0, Math.PI * 2);
    ilsCtx.fillStyle = nearStale ? CT.staleGlow : color + '22';
    ilsCtx.fill();

    // Dot
    ilsCtx.beginPath();
    ilsCtx.arc(x, y, 5, 0, Math.PI * 2);
    ilsCtx.fillStyle = dotColor;
    ilsCtx.fill();
    ilsCtx.strokeStyle = CT.dotBorder;
    ilsCtx.lineWidth   = 1;
    ilsCtx.stroke();

    // Label: omitted when near-stale (callsign/ICAO removed, dot only)
    if (!nearStale) {
      const delta = Math.round(ac.altitude - gsRef(ac.dist_thr_nm));
      const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
      const label = `${ac.callsign || ac.icao} (${deltaStr}ft)`;

      ilsCtx.fillStyle = color;
      ilsCtx.font      = '10px "Courier New", monospace';
      ilsCtx.textAlign = x > M.left + PW * 0.7 ? 'right' : 'left';
      const labelX = x > M.left + PW * 0.7 ? x - 9 : x + 9;
      ilsCtx.fillText(label, labelX, y - 7);
    }
  }

  // ── Wind barb overlay for selected aircraft ───────────────────────────────
  if (barbLayerActive && barbSelectedIcao) {
    const hist = (barbHiResActive ? wsWindHiHistory : wsWindHistory)[barbSelectedIcao] || [];
    if (hist.length > 0) {
      // Label and fallback colour from current aircraft state (callsign may not
      // be in the history entry).  Each barb is coloured from its own captured
      // src tag so grey observations stay grey even after the aircraft recovers.
      const selAc = aircraft.find(a => a.icao === barbSelectedIcao);
      const bLabel = selAc ? (selAc.callsign || barbSelectedIcao) : barbSelectedIcao;

      // Resolve runway heading for HW/TW annotation (once, before the loop).
      // Priority: matched runway of the selected aircraft → runway filter dropdown.
      // If neither resolves to a single known heading, HW annotation is suppressed.
      let barbRwyHdg = null;
      if (selAc?.approach_runway) {
        barbRwyHdg = getRwyHeading(selAc.approach_runway);
      } else {
        barbRwyHdg = getRwyHeading(document.getElementById('ws-ils-rwy').value) ?? null;
      }

      ilsCtx.save();

      for (const obs of hist) {
        if (obs.dist_nm == null || obs.dist_nm < 0 || obs.dist_nm > profileNm) continue;
        if (obs.alt_ft  == null || obs.alt_ft  < 0 || obs.alt_ft  > PROFILE_MAX_FT) continue;
        if (obs.wind_spd == null || obs.wind_dir == null) continue;

        const bx = distX(obs.dist_nm);
        const by = altY(obs.alt_ft);

        // Colour each barb from its own captured quality tag.
        // Falls back to neutral grey when src is absent (old buffer entries).
        const bColor = (obs.src && obs.src !== 'NONE') ? acColor(obs.src) : '#94a3b8';
        drawWindBarb(ilsCtx, bx, by, obs.wind_spd, obs.wind_dir, bColor);

        // Label placement — edge detection for canvas boundaries
        const plotBottom = M.top + PH;
        const nearTop    = by - 24 < M.top + 6;
        const nearBot    = by + 24 > plotBottom - 6;
        ilsCtx.textAlign = 'center';

        if (barbHwActive && barbRwyHdg != null) {
          const hw      = hwKt(obs.wind_spd, obs.wind_dir, barbRwyHdg);
          const hwRound = Math.round(hw);
          // Green = headwind, red = tailwind, amber = near-zero (±5 kt)
          const hwColor = hw > 5 ? '#4ade80' : hw < -5 ? '#f87171' : '#fbbf24';

          let hwY, rawY;
          if (barbDclActive) {
            // ── Dcl ON: split labels — raw wind above barb, HW value below ──
            if (nearTop) {
              // No room above — stack both below, HW first (primary)
              hwY  = by + 14;
              rawY = by + 24;
            } else if (nearBot) {
              // No room below — stack both above, HW closest to barb (primary)
              rawY = by - 14;
              hwY  = by - 5;
            } else {
              // Normal split: raw wind above, HW value below
              rawY = by - 9;
              hwY  = by + 16;
            }
          } else {
            // ── Dcl OFF: current behaviour — both labels on same side ────────
            hwY  = nearTop ? by + 16 : by - 14;
            rawY = nearTop ? by + 25 : by - 5;
          }

          ilsCtx.fillStyle = hwColor;
          ilsCtx.font      = 'bold 9px "Courier New", monospace';
          ilsCtx.fillText(`${hwRound >= 0 ? '+' : ''}${hwRound}kt`, bx, hwY);

          ilsCtx.fillStyle = bColor + '88';
          ilsCtx.font      = '7px "Courier New", monospace';
          ilsCtx.fillText(
            `${Math.round(obs.wind_dir)}°/${Math.round(obs.wind_spd)}kt`,
            bx, rawY
          );
        } else {
          // ── No HW active: dir°/spd only ──────────────────────────────────
          const lblY = nearTop ? by + 16 : by - 5;
          ilsCtx.fillStyle = bColor + 'cc';
          ilsCtx.font      = '8px "Courier New", monospace';
          ilsCtx.fillText(
            `${Math.round(obs.wind_dir)}°/${Math.round(obs.wind_spd)}kt`,
            bx, lblY
          );
        }
      }

      // Aircraft identifier in the top-left corner of the plot area
      const hwTag  = (barbHwActive && barbRwyHdg != null)
        ? `  · HW ref ${selAc?.approach_runway ?? '?'} (${barbRwyHdg}°)` : '';
      const hiTag  = barbHiResActive ? '  · HI' : '';
      const dclTag = (barbHwActive && barbDclActive) ? '  · DCL' : '';
      ilsCtx.fillStyle = bColor;
      ilsCtx.font      = 'bold 9px "Courier New", monospace';
      ilsCtx.textAlign = 'left';
      ilsCtx.fillText(
        `\u{1F32C} ${bLabel}  (${hist.length} obs)${barbAutoActive ? '  · AUTO' : ''}${hiTag}${dclTag}${hwTag}`,
        M.left + 4, M.top + 22
      );

      ilsCtx.restore();
    } else {
      // Aircraft selected but no wind history yet — show hint, noting any NONE-position data
      const noneHintCount = (wsNoneHistory[barbSelectedIcao] || []).length;
      const hintSuffix    = noneHintCount > 0 ? `  (${noneHintCount} pos-only)` : '';
      ilsCtx.fillStyle  = CT.barbHint;
      ilsCtx.font       = '9px "Courier New", monospace';
      ilsCtx.textAlign  = 'left';
      ilsCtx.fillText(`\u{1F32C} Waiting for wind data…${hintSuffix}`, M.left + 4, M.top + 22);
    }

    // ── NONE position markers: hollow circles colour-coded by reason ────────
    //    'qc'     → amber  — pyModeS quality rejection (turn / high bank angle);
    //               normal maneuvering, no GPS issue.
    //    'freeze' → grey   — our position-freeze gate fired; GPS likely jammed.
    //    'gap'    → grey   — no ADS-B position at all; GPS source dropped out.
    //
    //    Amber circles during localizer intercept are expected and operationally
    //    normal.  Grey circles on established final are worth investigating.
    const NONE_COLOR_QC     = '#fb923c';   // amber  — EHS quality rejection (turns)
    const NONE_COLOR_FREEZE = '#6b7280';   // grey   — position freeze (GPS jamming)
    const NONE_COLOR_GAP    = '#6b7280';   // grey   — position gap   (GPS drop-out)

    const noneObs = wsNoneHistory[barbSelectedIcao] || [];
    if (noneObs.length > 0) {
      ilsCtx.save();
      ilsCtx.lineWidth = 1.5;
      for (const obs of noneObs) {
        if (obs.dist_nm < 0 || obs.dist_nm > profileNm) continue;
        if (obs.alt_ft  < 0 || obs.alt_ft  > PROFILE_MAX_FT) continue;
        ilsCtx.strokeStyle = obs.reason === 'qc' ? NONE_COLOR_QC
                           : obs.reason === 'gap' ? NONE_COLOR_GAP
                           : NONE_COLOR_FREEZE;
        ilsCtx.beginPath();
        ilsCtx.arc(distX(obs.dist_nm), altY(obs.alt_ft), 3, 0, 2 * Math.PI);
        ilsCtx.stroke();
      }
      ilsCtx.restore();
    }

    // ── Pre-corridor NONE markers: smaller amber circles ─────────────────
    // Drawn for the selected aircraft when it was outside the corridor
    // (e.g. wide localizer intercept turn) — only 'qc' reason.
    // Smaller radius (2px vs 3px) distinguishes these from corridor circles.
    const preObs = wsPreCorridorHistory[barbSelectedIcao] || [];
    if (preObs.length > 0) {
      ilsCtx.save();
      ilsCtx.strokeStyle = NONE_COLOR_QC;   // amber — always qc in this buffer
      ilsCtx.lineWidth   = 1.2;
      ilsCtx.setLineDash([2, 2]);            // dashed outline to further distinguish
      for (const obs of preObs) {
        if (obs.dist_nm < 0 || obs.dist_nm > profileNm) continue;
        if (obs.alt_ft  < 0 || obs.alt_ft  > PROFILE_MAX_FT) continue;
        ilsCtx.beginPath();
        ilsCtx.arc(distX(obs.dist_nm), altY(obs.alt_ft), 2, 0, 2 * Math.PI);
        ilsCtx.stroke();
      }
      ilsCtx.setLineDash([]);
      ilsCtx.restore();
    }
  } else if (barbLayerActive) {
    // Layer active but no aircraft selected yet
    ilsCtx.fillStyle  = CT.barbHint;
    ilsCtx.font       = '9px "Courier New", monospace';
    ilsCtx.textAlign  = 'left';
    ilsCtx.fillText('Click a strip to show wind barbs', M.left + 4, M.top + 22);
  }
}

// ── QNH-corrected glideslope status ──────────────────────────────────────────
/**
 * Compute GS badge status in the browser where the live QNH is available.
 * The server-side gs_status uses pressure altitude against an uncorrected
 * glideslope, which reads HIGH when QNH is below standard (common in Finnish
 * winter).  This JS version applies the same QNH shift as the ILS canvas so
 * the strip badge and the canvas dot always agree.
 */
function computeGsStatus(ac) {
  if (ac.dist_thr_nm == null || ac.dist_thr_nm > 20) return 'FAR';
  const qnhCorr  = (1013.25 - currentQnh) * 27;
  const baseline = WS_THR_ELEVATION_FT + WS_GS_OFFSET_FT + qnhCorr;
  const expected = baseline + ac.dist_thr_nm * GS_FT_PER_NM;
  const delta    = ac.altitude - expected;
  if (Math.abs(delta) <= GS_TOL_FT) return 'ON';
  return delta > 0 ? 'HIGH' : 'LOW';
}

// ── Wind barb drawing ─────────────────────────────────────────────────────────
/**
 * Draw a standard meteorological wind barb at canvas position (x, y).
 *
 * Staff points FROM the wind direction (meteorological convention).
 * Pennant = 50 kt, full barb = 10 kt, half barb = 5 kt.
 */
function drawWindBarb(ctx, x, y, speedKt, dirFrom, color) {
  if (speedKt == null || dirFrom == null) return;
  const spd = Math.round(speedKt / 5) * 5;

  if (spd === 0) {
    // Calm — open circle
    ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.stroke();
    return;
  }

  const rad  = dirFrom * Math.PI / 180;
  const sLen = 18;
  const ex   = x + sLen * Math.sin(rad);
  const ey   = y - sLen * Math.cos(rad);

  // Staff
  ctx.strokeStyle = color; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();

  let rem = spd, pos = 0;
  const step = 4;

  // Pennants (50 kt) — filled triangle
  while (rem >= 50) {
    const sx = ex - pos * Math.sin(rad), sy = ey + pos * Math.cos(rad);
    const tx = sx + 9 * Math.cos(rad),  ty = sy + 9 * Math.sin(rad);
    const mx = sx + step * Math.sin(rad), my = sy - step * Math.cos(rad);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(tx, ty); ctx.lineTo(mx, my);
    ctx.closePath(); ctx.fill();
    pos += step + 2; rem -= 50;
  }
  // Full barbs (10 kt)
  ctx.lineWidth = 1.5;
  while (rem >= 10) {
    const sx = ex - pos * Math.sin(rad), sy = ey + pos * Math.cos(rad);
    const px = sx + 8 * Math.cos(rad),  py = sy + 8 * Math.sin(rad);
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(px, py); ctx.stroke();
    pos += step; rem -= 10;
  }
  // Half barb (5 kt)
  if (rem >= 5) {
    const sx = ex - pos * Math.sin(rad), sy = ey + pos * Math.cos(rad);
    const px = sx + 4 * Math.cos(rad),  py = sy + 4 * Math.sin(rad);
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(px, py); ctx.stroke();
  }
}

// ── Runway filter helper ──────────────────────────────────────────────────────
/**
 * Returns true if `rwy` matches the selector value.
 * Supports paired options: "04L&R" matches "04L" or "04R";
 * "22L&R" matches "22L" or "22R".  Empty selector matches all.
 */
function matchesRwyFilter(rwy, filter) {
  if (!filter) return true;
  if (filter === '04L&R') return rwy === '04L' || rwy === '04R';
  if (filter === '22L&R') return rwy === '22L' || rwy === '22R';
  return rwy === filter;
}

// ── Flight strips ─────────────────────────────────────────────────────────────

function srcClass(src) {
  const s = (src || 'NONE').toLowerCase();
  return `src-${s}`;
}

function fmtVs(vr) {
  if (vr == null) return { text: '—', cls: '' };
  const abs  = Math.abs(Math.round(vr));
  const sign = vr > 50 ? '↑' : vr < -50 ? '↓' : '→';
  const cls  = vr > 50 ? 'climbing' : vr < -50 ? 'descending' : '';
  return { text: `${sign} ${abs}`, cls };
}

function fmtAlt(alt) {
  if (alt == null) return '—';
  return alt.toLocaleString() + ' ft';
}

function fmtDist(nm) {
  if (nm == null) return '—';
  return nm.toFixed(1) + ' NM';
}

function fmtWind(spd, dir) {
  if (spd == null || dir == null) return null;
  return `${Math.round(dir)}° / ${Math.round(spd)} kt`;
}

function fmtTemp(t) {
  if (t == null) return null;
  const sign = t >= 0 ? '+' : '';
  return `${sign}${t.toFixed(1)} °C`;
}

function gsClass(gs) {
  switch (gs) {
    case 'ON':   return 'gs-on';
    case 'HIGH': return 'gs-high';
    case 'LOW':  return 'gs-low';
    default:     return 'gs-far';
  }
}

// ── Windshear detection engine ────────────────────────────────────────────────
let wsDetectionEnabled = false;
let wsDetAlgo = localStorage.getItem('ms_ws_algo') || 'pair';   // active algorithm key — persisted
let lastShearEvents    = [];

/**
 * Confidence gate — require WS_CONFIDENCE_HITS consecutive poll cycles
 * detecting the same event before it is promoted to the confirmed set.
 * This eliminates single-poll false positives without adding latency for
 * sustained shear (which will fire on the 2nd poll, ~3 s after the 1st).
 *
 * Hit counters are keyed by algo:rwy:icao (or algo:rwy:icao_low:icao_high
 * for pairwise events) and are reset to zero whenever a poll cycle produces
 * no matching event, preventing stale counts from carrying over.
 */
const WS_CONFIDENCE_HITS = 2;
const wsHitCounts = {};   // key → consecutive hit count

function makeConfKey(ev) {
  if (ev.icao_low && ev.icao_high)
    return `${ev.algo}:${ev.rwy}:${ev.icao_low}:${ev.icao_high}`;
  return `${ev.algo}:${ev.rwy}:${ev.icao || ev.cs || ''}`;
}

function applyConfidenceGate(events) {
  const confirmed   = [];
  const currentKeys = new Set();

  for (const ev of events) {
    const key = makeConfKey(ev);
    currentKeys.add(key);
    wsHitCounts[key] = (wsHitCounts[key] || 0) + 1;
    if (wsHitCounts[key] >= WS_CONFIDENCE_HITS) confirmed.push(ev);
  }

  // Reset counters for any event that did not appear this cycle
  for (const key of Object.keys(wsHitCounts)) {
    if (!currentKeys.has(key)) delete wsHitCounts[key];
  }

  return confirmed;
}

// GS history for energy algorithm  icao → [{gs, alt, ts}, …]
const wsGsHistory = {};

// IAS−GS differential history for kinematic algorithm  icao → [{ias, gs, ts}, …]
const wsKinHistory = {};

// ── Windshear algorithm helpers ───────────────────────────────────────────────

/** Return the approach magnetic heading for a runway designator, or null. */
function getRwyHeading(rwy) { return RWY_HEADINGS[rwy] ?? null; }

/**
 * Headwind component (kt) of a wind observation for a given runway heading.
 * Positive = headwind, negative = tailwind.
 * Formula: spd × cos(windDir − rwyHdg)
 */
function hwKt(windSpd, windDir, rwyHdg) {
  return windSpd * Math.cos((windDir - rwyHdg) * Math.PI / 180);
}

/**
 * Return the median of a numeric array.  Returns null for empty input.
 * Used to smooth per-aircraft measurement series before differencing,
 * reducing single-sample noise in detectKinematic and detectRate.
 */
function medianOf(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ── Algorithm 1: Pairwise ─────────────────────────────────────────────────────
/**
 * Classic ICAO pairwise method.
 * Compares headwind between two simultaneously tracked corridor aircraft at
 * different altitudes on the same runway.  Requires ≥2 aircraft on approach.
 *
 * Physics: a sudden change in headwind between altitude levels reveals the
 * presence of a wind shear layer.  ICAO defines windshear as ≥15 kt change.
 */
function detectPairwise(aircraft) {
  const events = [];
  const byRwy  = {};
  for (const ac of aircraft) {
    if (!ac.in_corridor || !ac.approach_runway) continue;
    if (ac.headwind_kt == null) continue;
    if (computeGsStatus(ac) !== 'ON') continue;
    if ((wsWindHistory[ac.icao] || []).length < WS_MIN_CORRIDOR_SAMPLES) continue;
    if (!byRwy[ac.approach_runway]) byRwy[ac.approach_runway] = [];
    byRwy[ac.approach_runway].push(ac);
  }
  for (const [rwy, acs] of Object.entries(byRwy)) {
    if (acs.length < 2) continue;
    acs.sort((a, b) => a.altitude - b.altitude);
    for (let i = 0; i < acs.length - 1; i++) {
      const low  = acs[i];
      const high = acs[i + 1];
      const altDiff = high.altitude - low.altitude;
      if (altDiff < WS_MIN_ALT_BAND || altDiff > WS_MAX_ALT_BAND) continue;
      const delta = Math.abs(high.headwind_kt - low.headwind_kt);
      if (delta < WS_MONITOR_KT) continue;
      events.push({
        algo:     'pair',
        rwy,
        icao_low:  low.icao,
        icao_high: high.icao,
        cs_low:    low.callsign  || low.icao,
        cs_high:   high.callsign || high.icao,
        alt_low:   low.altitude,
        alt_high:  high.altitude,
        hw_low:    low.headwind_kt,
        hw_high:   high.headwind_kt,
        delta_kt:  Math.round(delta),
        severity:  wsSeverity(delta),
        hw_trend:  high.headwind_kt < low.headwind_kt ? 'loss' : 'gain',
      });
    }
  }
  return events;
}

// ── Algorithm 2: Single-aircraft wind gradient ────────────────────────────────
/**
 * Examines the wind barb history accumulated for a single aircraft during
 * its approach.  For each pair of stored observations separated by
 * 200–3 000 ft of altitude, computes the headwind change.  The maximum
 * change found across the whole approach history is reported.
 *
 * Physics: a wind gradient (dHW/dz) directly measures the vertical structure
 * of the low-level wind field.  A gradient exceeding ~15 kt / 1 000 ft is
 * operationally significant.  Unlike pairwise, this works with a single
 * aircraft and accumulates evidence as the aircraft descends.
 */
function detectGradient(aircraft) {
  const events   = [];
  const MIN_BAND = 200;
  const MAX_BAND = 3_000;

  for (const ac of aircraft) {
    if (!ac.in_corridor || !ac.approach_runway) continue;
    const rwyHdg = getRwyHeading(ac.approach_runway);
    if (rwyHdg == null) continue;

    const hist = wsWindHistory[ac.icao] || [];
    const pts  = hist
      .filter(h => h.wind_spd != null && h.wind_dir != null && h.alt_ft != null)
      .map(h => ({ alt: h.alt_ft, hw: hwKt(h.wind_spd, h.wind_dir, rwyHdg) }))
      .sort((a, b) => b.alt - a.alt);   // highest first

    if (pts.length < WS_MIN_CORRIDOR_SAMPLES) continue;

    let maxDelta = 0, bestHi = null, bestLo = null;
    for (let i = 0; i < pts.length - 1; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dAlt  = pts[i].alt - pts[j].alt;
        if (dAlt < MIN_BAND || dAlt > MAX_BAND) continue;
        const delta = Math.abs(pts[i].hw - pts[j].hw);
        if (delta > maxDelta) { maxDelta = delta; bestHi = pts[i]; bestLo = pts[j]; }
      }
    }

    if (maxDelta >= WS_MONITOR_KT && bestHi && bestLo) {
      events.push({
        algo:     'gradient',
        rwy:      ac.approach_runway,
        icao:     ac.icao,
        cs:       ac.callsign || ac.icao,
        alt_low:  Math.round(bestLo.alt),
        alt_high: Math.round(bestHi.alt),
        hw_low:   Math.round(bestLo.hw),
        hw_high:  Math.round(bestHi.hw),
        delta_kt: Math.round(maxDelta),
        severity: maxDelta >= WS_SEVERE_KT ? 'severe' : 'moderate',
        hw_trend: bestHi.hw > bestLo.hw ? 'loss' : 'gain',
      });
    }
  }
  return events;
}

// ── Algorithm 3: Total energy trend ──────────────────────────────────────────
/**
 * Tracks the total mechanical energy proxy of each approach aircraft over a
 * sliding time window.  Energy is approximated as:
 *
 *   E = GS_kt + alt_ft / 100
 *
 * On a stable 3° ILS approach at ~140 kt, roughly 100 ft of altitude
 * corresponds to 1 kt of equivalent kinetic energy (derived from the
 * glideslope geometry and typical approach speed).  A stable approach
 * maintains near-constant E.  A rapid decrease signals that the aircraft
 * is losing more energy than expected — the classic signature of a
 * microburst or strong windshear event reducing effective headwind.
 *
 * Inspired by the energy-rate monitor used in airborne GPWS/EGPWS systems.
 */
function detectEnergy(aircraft) {
  const events      = [];
  const WINDOW_MS   = 45_000;   // 45-second look-back window
  const LOSS_KT     = WS_MONITOR_KT;  // kt-equivalent energy loss to flag (monitor threshold)
  const MIN_POINTS  = WS_MIN_CORRIDOR_SAMPLES;

  const nowMs = Date.now();

  for (const ac of aircraft) {
    if (!ac.in_corridor || !ac.approach_runway) continue;
    if (ac.groundspeed == null || ac.altitude == null) continue;

    const hist = (wsGsHistory[ac.icao] || [])
      .filter(h => (nowMs - h.ts) <= WINDOW_MS);
    if (hist.length < MIN_POINTS) continue;

    // Energy proxy at each stored point
    const ePoints = hist.map(h => ({ E: h.gs + h.alt / 100, alt: h.alt, gs: h.gs, ts: h.ts }));
    const first   = ePoints[0];
    const last    = ePoints[ePoints.length - 1];
    const dE      = last.E - first.E;   // negative = energy loss

    if (dE <= -LOSS_KT) {
      const delta = Math.round(Math.abs(dE));
      events.push({
        algo:       'energy',
        rwy:        ac.approach_runway,
        icao:       ac.icao,
        cs:         ac.callsign || ac.icao,
        alt_low:    Math.round(last.alt),
        alt_high:   Math.round(first.alt),
        hw_low:     Math.round(last.gs),    // repurposed: GS at end of window
        hw_high:    Math.round(first.gs),   // repurposed: GS at start of window
        delta_kt:   delta,
        energy_loss: Math.round(dE),
        severity:   delta >= WS_SEVERE_KT ? 'severe' : 'moderate',
        hw_trend:   'loss',   // energy only fires on dE < 0
      });
    }
  }
  return events;
}

// ── Algorithm 4: Headwind rate of change ─────────────────────────────────────
/**
 * Compares a single aircraft's current headwind to the oldest observation
 * within its recent wind history (up to the last WS_WIND_HIST_MAX points).
 * A large headwind change over the accumulated approach segment — regardless
 * of how many altitude feet are involved — indicates a rapid wind shift.
 *
 * Physics: even on a short final where altitude change is small, the aircraft
 * can experience a sudden headwind loss as it enters a shear zone.  The
 * pairwise and gradient algorithms may miss this if the altitude separation
 * is too small; the rate algorithm catches purely horizontal/time-based shifts.
 */
function detectRate(aircraft) {
  const events   = [];
  const LOOKBACK = 6;   // observations to look back through

  for (const ac of aircraft) {
    if (!ac.in_corridor || !ac.approach_runway || ac.headwind_kt == null) continue;
    const rwyHdg = getRwyHeading(ac.approach_runway);
    if (rwyHdg == null) continue;

    const hist = wsWindHistory[ac.icao] || [];
    if (hist.length < WS_MIN_CORRIDOR_SAMPLES) continue;

    // Use the median of the oldest half of the lookback window as reference
    // (rather than a single raw point) to reduce noise before differencing.
    const window   = hist.slice(-LOOKBACK);
    const refEdge  = Math.min(3, Math.floor(window.length / 2));
    const refSamples = window.slice(0, refEdge)
      .filter(p => p.wind_spd != null && p.wind_dir != null)
      .map(p => hwKt(p.wind_spd, p.wind_dir, rwyHdg));
    if (!refSamples.length) continue;
    const refHw = medianOf(refSamples);
    const delta  = Math.abs(ac.headwind_kt - refHw);

    if (delta >= WS_MONITOR_KT) {
      events.push({
        algo:     'rate',
        rwy:      ac.approach_runway,
        icao:     ac.icao,
        cs:       ac.callsign || ac.icao,
        alt_low:  Math.round(ref.alt_ft  || ac.altitude),
        alt_high: Math.round(ac.altitude),
        hw_low:   Math.round(refHw),
        hw_high:  Math.round(ac.headwind_kt),
        delta_kt: Math.round(delta),
        severity: delta >= WS_SEVERE_KT ? 'severe' : 'moderate',
        hw_trend: ac.headwind_kt < refHw ? 'loss' : 'gain',
      });
    }
  }
  return events;
}

// ── Algorithm 5: Historical baseline deviation ────────────────────────────────
/**
 * Builds a vector-averaged baseline wind from the recentLandingWinds buffer
 * (low-altitude observations harvested from the last 30 minutes of completed
 * approaches).  Each active corridor aircraft's current headwind is compared
 * to the expected headwind derived from this baseline.
 *
 * Physics: the baseline represents the "background" low-level wind field as
 * measured by multiple recent aircraft on the same approach path.  A large
 * deviation for the current aircraft suggests the wind has changed sharply
 * since the baseline was built — either in space (localised shear zone) or
 * in time (frontal passage, microburst onset).  Requires at least 5 recent
 * observations to form a meaningful baseline.
 */
function detectBaseline(aircraft) {
  const events   = [];
  const MIN_OBS  = 5;

  const nowMs   = Date.now();
  const recent  = recentLandingWinds.filter(o => (nowMs - o.ts) <= WINDROSE_MAX_AGE_MS);
  if (recent.length < MIN_OBS) return [];

  const baseline = vectorAvgWind(recent);
  if (!baseline || baseline.spd < 1) return [];

  for (const ac of aircraft) {
    if (!ac.in_corridor || !ac.approach_runway || ac.headwind_kt == null) continue;
    if ((wsWindHistory[ac.icao] || []).length < WS_MIN_CORRIDOR_SAMPLES) continue;
    const rwyHdg = getRwyHeading(ac.approach_runway);
    if (rwyHdg == null) continue;

    const baselineHw = hwKt(baseline.spd, baseline.dir, rwyHdg);
    const delta      = Math.abs(ac.headwind_kt - baselineHw);

    if (delta >= WS_MONITOR_KT) {
      events.push({
        algo:           'baseline',
        rwy:            ac.approach_runway,
        icao:           ac.icao,
        cs:             ac.callsign || ac.icao,
        alt_low:        Math.round(ac.altitude) - 50,
        alt_high:       Math.round(ac.altitude) + 50,
        hw_low:         Math.round(baselineHw),
        hw_high:        Math.round(ac.headwind_kt),
        delta_kt:       Math.round(delta),
        baseline_count: recent.length,
        severity:       delta >= WS_SEVERE_KT ? 'severe' : 'moderate',
        hw_trend:       ac.headwind_kt < baselineHw ? 'loss' : 'gain',
      });
    }
  }
  return events;
}

// ── Algorithm 6: Kinematic IAS−GS differential ───────────────────────────────
/**
 * Detects windshear by tracking the rate of change of the IAS−GS differential
 * over a 45-second sliding window.
 *
 * Physics: at low altitude, air density is close to sea-level so IAS ≈ TAS.
 * The difference (IAS − GS) therefore approximates the headwind component the
 * aircraft is experiencing along its track.  A sudden change in this
 * differential — without any wind direction decoding — directly measures the
 * magnitude of a headwind loss or gain that the aircraft has flown through.
 *
 * Advantages over traditional algorithms:
 *  • Works for a single aircraft in the corridor (no pair required)
 *  • No wind vector decoding needed; uses raw BDS 6,0 IAS and ADS-B GS
 *  • Robust at low altitude where IAS ≈ TAS is most accurate
 *  • Insensitive to heading errors and magnetic variation
 *
 * Thresholds: ≥10 kt = monitor, ≥15 kt = warning, ≥25 kt = alarm (ICAO FAA JAWS).
 * Detection window: 45 seconds (full approach segment).
 * F-factor window: 10–20 s sliding sub-windows (≈1 km at approach speed),
 *   reporting the maximum F found — matching the JAWS reference distance.
 */
function detectKinematic(aircraft) {
  const events    = [];
  const WINDOW_MS = 45_000;   // 45-second look-back window

  for (const ac of aircraft) {
    if (!ac.in_corridor || !ac.approach_runway) continue;
    if (computeGsStatus(ac) !== 'ON') continue;

    const hist = wsKinHistory[ac.icao];
    if (!hist || hist.length < WS_MIN_CORRIDOR_SAMPLES) continue;

    const nowMs = Date.now();
    // Filter to entries within the 45-second window
    const window = hist.filter(p => (nowMs - p.ts) <= WINDOW_MS);
    if (window.length < WS_MIN_CORRIDOR_SAMPLES) continue;

    // Use median of first/last 3 samples instead of raw endpoints to reduce
    // single-observation noise before differencing.
    const EDGE = Math.min(3, Math.floor(window.length / 2));
    const diffOld = medianOf(window.slice(0, EDGE).map(p => p.ias - p.gs));
    const diffNew = medianOf(window.slice(-EDGE).map(p => p.ias - p.gs));
    const delta   = Math.abs(diffNew - diffOld);

    if (delta < WS_MONITOR_KT) continue;

    // F-factor: scan all sub-windows of 10–20 s (≈1 km at approach speed) and
    // report the highest F found.  The JAWS/FAA definition uses a 1-km reference
    // window; computing over the full 45 s span underreads by ~3×, making the
    // F-gate far more conservative than intended.
    let fFactor = null;
    for (let fi = 0; fi < window.length - 1; fi++) {
      for (let fj = fi + 1; fj < window.length; fj++) {
        const spanMs = window[fj].ts - window[fi].ts;
        if (spanMs < 10_000 || spanMs > 20_000) continue;
        const subDelta = Math.abs(
          (window[fj].ias - window[fj].gs) - (window[fi].ias - window[fi].gs)
        );
        const f = (subDelta * 0.51444) / (spanMs / 1000) / 9.81;
        if (fFactor === null || f > fFactor) fFactor = f;
      }
    }
    if (fFactor !== null) fFactor = Math.round(fFactor * 100) / 100;

    // Apply F-factor gate — if enabled, skip events that don't meet the minimum
    if (wsKinFGate !== 'off') {
      const minF = parseFloat(wsKinFGate);
      if (fFactor === null || fFactor < minF) continue;
    }

    events.push({
      algo:     'kinematic',
      rwy:      ac.approach_runway,
      icao:     ac.icao,
      cs:       ac.callsign || ac.icao,
      alt_low:  Math.round(window[0].gs != null ? ac.altitude - 50 : ac.altitude),
      alt_high: Math.round(ac.altitude),
      hw_low:   Math.round(diffOld),   // repurposed: IAS−GS at window start
      hw_high:  Math.round(diffNew),   // repurposed: IAS−GS at window end
      delta_kt: Math.round(delta),
      f_factor: fFactor,
      severity: wsSeverity(delta),
      hw_trend: diffNew < diffOld ? 'loss' : 'gain',
    });
  }
  return events;
}

// ── Algorithm dispatcher ──────────────────────────────────────────────────────
/**
 * Route to the active algorithm.  All algorithms return events in a
 * compatible format with at minimum: { algo, rwy, alt_low, alt_high,
 * delta_kt, severity } so the canvas shading and log work unchanged.
 */
function detectWindshear(aircraft) {
  if (!wsDetectionEnabled) return [];
  switch (wsDetAlgo) {
    case 'gradient':  return detectGradient(aircraft);
    case 'energy':    return detectEnergy(aircraft);
    case 'rate':      return detectRate(aircraft);
    case 'baseline':  return detectBaseline(aircraft);
    case 'kinematic': return detectKinematic(aircraft);
    default:          return detectPairwise(aircraft);
  }
}

// ── Alert level selector ──────────────────────────────────────────────────────
/**
 * Controls the minimum severity that triggers the alert banner and flight
 * strip WS badge.  The log always shows all three severity levels regardless.
 *
 * Levels:  'monitor'  — banner/badge fires at ≥10 kt (all events)
 *          'warning'  — banner/badge fires at ≥15 kt (default)
 *          'alarm'    — banner/badge fires at ≥25 kt only
 */
const SEV_ORDER = { monitor: 0, warning: 1, alarm: 2 };
let wsAlertLevel = localStorage.getItem('ms_ws_alert_level') || 'warning';

function severityMeetsLevel(severity) {
  return (SEV_ORDER[severity] ?? 0) >= (SEV_ORDER[wsAlertLevel] ?? 1);
}

/**
 * Update the alert banner at the top of the page.
 * Hidden when wsDetectionEnabled is false, no events, or all events are
 * below the active alert level.
 */
function updateAlertBanner(events) {
  const banner = document.getElementById('ws-alert-banner');
  const active = events.filter(e => severityMeetsLevel(e.severity));

  if (!wsDetectionEnabled || active.length === 0) {
    banner.className = 'ws-alert-banner ws-alert-hidden';
    return;
  }

  const hasAlarm = active.some(e => e.severity === 'alarm');
  const cls  = hasAlarm ? 'ws-alert-severe' : 'ws-alert-moderate';
  const icon = hasAlarm ? '🔴' : '⚠';

  const ALGO_SHORT = { pair:'Pair', gradient:'Grad', energy:'Engy', rate:'Rate', baseline:'Base', kinematic:'Kinem' };
  const tags = active.map(e => {
    const algoLbl = ALGO_SHORT[e.algo] || 'WS';
    const acInfo  = (e.cs_low && e.cs_high)
      ? `[${e.cs_low}↕${e.cs_high}]`
      : `[${e.cs || ''}]`;
    const trendTag = e.hw_trend === 'loss' ? ' ▼LOSS' : e.hw_trend === 'gain' ? ' ▲GAIN' : '';
    return `<span class="ws-alert-tag">${algoLbl} · RWY ${e.rwy} · ${e.delta_kt} kt${trendTag}  ${Math.round(e.alt_low / 100) * 100}–${Math.round(e.alt_high / 100) * 100} ft  ${acInfo}</span>`;
  }).join(' ');

  banner.className = `ws-alert-banner ${cls}`;
  banner.innerHTML = `${icon} WINDSHEAR ALERT &nbsp; ${tags}`;
}

// ── Emergency squawk alarm banner ─────────────────────────────────────────────
/**
 * Show/hide the full-page emergency squawk banner.
 * Scans ALL tracked aircraft (not just corridor) so a squawking aircraft
 * that is still on radar but outside the ILS corridor is still flagged.
 */
function updateSqkAlarm(aircraft) {
  const alarm = document.getElementById('ws-sqk-alarm');
  if (!alarm) return;

  const SQK_EMG = { '7500': 'HIJACK', '7600': 'NORDO', '7700': 'MAYDAY' };
  const emgAc = (aircraft || []).filter(ac => {
    const sqk = ac.squawk ? String(ac.squawk).padStart(4, '0') : null;
    return sqk && SQK_EMG[sqk];
  });

  if (emgAc.length === 0) {
    alarm.className = 'ws-sqk-alarm ws-sqk-alarm-hidden';
    return;
  }

  const tags = emgAc.map(ac => {
    const sqk  = String(ac.squawk).padStart(4, '0');
    const type = SQK_EMG[sqk];
    const cs   = ac.callsign || ac.icao;
    return `<span class="ws-sqk-alarm-tag">${cs} · ${sqk} ${type}</span>`;
  }).join(' ');

  alarm.className = 'ws-sqk-alarm';
  alarm.innerHTML = `⚠ EMERGENCY SQUAWK &nbsp; ${tags}`;
}

// ── Detection toggle ──────────────────────────────────────────────────────────
document.getElementById('ws-det-btn').addEventListener('click', () => {
  wsDetectionEnabled = !wsDetectionEnabled;
  const btn   = document.getElementById('ws-det-btn');
  const state = document.getElementById('ws-det-state');
  btn.classList.toggle('active', wsDetectionEnabled);
  state.textContent = wsDetectionEnabled ? 'ON' : 'OFF';

  if (!wsDetectionEnabled) {
    // Clear alerts immediately when turned off
    lastShearEvents = [];
    updateAlertBanner([]);
    // Redraw strips and profile without shear markers
    renderStrips(lastAircraft, []);
    drawIlsProfile(lastAircraft.filter(ac => ac.in_corridor), []);
    renderWsLog();  // update log to show "detection off" message
  } else {
    renderWsLog();  // update log to show "no events yet" message
  }
});

// ── Algorithm selector (dropdown) ────────────────────────────────────────────
// Restore saved algorithm on page load
(function () {
  const algoEl = document.getElementById('ws-algo-select');
  if (algoEl && wsDetAlgo) algoEl.value = wsDetAlgo;
})();

document.getElementById('ws-algo-select').addEventListener('change', e => {
  wsDetAlgo = e.target.value;
  localStorage.setItem('ms_ws_algo', wsDetAlgo);
  // Re-run detection immediately with the new algorithm
  if (wsDetectionEnabled) {
    const corridor  = lastAircraft.filter(ac => ac.in_corridor);
    lastShearEvents = applyConfidenceGate(detectWindshear(corridor));
    renderStrips(lastAircraft, lastShearEvents);
    drawIlsProfile(corridor, lastShearEvents);
    updateAlertBanner(lastShearEvents);
    addToWsLog(lastShearEvents);
    renderWsLog();
  }
});

// ── Alert level selector (dropdown) ──────────────────────────────────────────
(function () {
  const sel = document.getElementById('ws-alert-level');
  if (!sel) return;   // guard: element missing if HTML not yet updated
  // Restore saved preference
  if (wsAlertLevel) sel.value = wsAlertLevel;
  sel.addEventListener('change', e => {
    wsAlertLevel = e.target.value;
    localStorage.setItem('ms_ws_alert_level', wsAlertLevel);
    // Re-apply immediately to banner and strips without re-running detection
    renderStrips(lastAircraft, lastShearEvents);
    updateAlertBanner(lastShearEvents);
  });
})();

// ── Kinematic F-factor gate ───────────────────────────────────────────────────
// Minimum F-factor required before a Kinematic event is emitted.
// 'off' disables the gate (all events pass through regardless of F-factor).
// Stored in localStorage so the research setting survives page reloads.
// IMPORTANT: must be declared BEFORE the IIFE below that reads it synchronously.
let wsKinFGate = localStorage.getItem('ms_ws_kin_f_gate') || 'off';

// ── Kinematic F-factor gate selector (dropdown) ───────────────────────────────
(function () {
  const sel     = document.getElementById('ws-kin-f-gate');
  const algoSel = document.getElementById('ws-algo-select');
  if (!sel || !algoSel) return;   // guard: element missing if HTML not yet updated

  // Restore saved preference and sync enabled state with current algo
  sel.value = wsKinFGate;
  function syncEnabled() {
    sel.disabled = algoSel.value !== 'kinematic';
  }
  syncEnabled();

  sel.addEventListener('change', e => {
    wsKinFGate = e.target.value;
    localStorage.setItem('ms_ws_kin_f_gate', wsKinFGate);
    // Re-run detection immediately so the new gate takes effect without waiting
    if (wsDetectionEnabled) {
      const corridor  = lastAircraft.filter(ac => ac.in_corridor);
      lastShearEvents = applyConfidenceGate(detectWindshear(corridor));
      renderStrips(lastAircraft, lastShearEvents);
      drawIlsProfile(corridor, lastShearEvents);
      updateAlertBanner(lastShearEvents);
      addToWsLog(lastShearEvents);
      renderWsLog();
    }
  });

  // Keep enabled state in sync when algorithm is changed
  algoSel.addEventListener('change', syncEnabled);
})();

function buildStrip(ac, wsSeverity = null) {
  const vs     = fmtVs(ac.vert_rate);
  const wind   = fmtWind(ac.best_wind_spd, ac.best_wind_dir);
  const temp   = fmtTemp(ac.best_temp);
  const gs     = computeGsStatus(ac);
  const rwyTxt = ac.approach_runway || '?';
  const rwyClass = ac.approach_runway ? '' : 'rwy-none';

  const wsBadge = wsSeverity
    ? `<div class="ws-ws-badge ws-${wsSeverity}">WS</div>`
    : '';

  // Squawk badge
  const SQK_EMG = { '7500': 'HIJACK', '7600': 'NORDO', '7700': 'MAYDAY' };
  const sqk     = ac.squawk ? String(ac.squawk).padStart(4, '0') : null;
  const sqkType = sqk ? SQK_EMG[sqk] : null;
  const sqkBadge = sqk
    ? `<span class="ws-sqk-badge${sqkType ? ' ws-sqk-emg' : ''}">${sqk}</span>`
    : '';

  // Emergency squawk flash (higher priority than GA flash in the label slot)
  const sqkFlash = sqkType
    ? `<div class="ws-sqk-flash">⚠ ${sqkType}</div>`
    : '';

  // Go-around flash label (only shown when no emergency squawk overrides)
  const gaFlash = (!sqkType && ac.ga_flash)
    ? `<div class="ws-ga-flash">✈ GO-AROUND</div>`
    : '';

  // Return-approach badge next to callsign
  const returnBadge = ac.is_return
    ? `<span class="ws-return-badge">${ac.ga_count > 1 ? ac.ga_count + 'x' : '2nd'} APP</span>`
    : '';

  // Headwind component label: positive = headwind, negative = tailwind
  const hw = ac.headwind_kt != null
    ? (ac.headwind_kt >= 0
        ? `+${ac.headwind_kt.toFixed(0)} kt HW`
        : `${ac.headwind_kt.toFixed(0)} kt TW`)
    : null;

  const row = (label, val) =>
    `<div class="ws-sd"><span class="ws-sd-label">${label}</span><span class="ws-sd-val${val == null ? ' ws-sd-nil' : ''}">${val ?? '—'}</span></div>`;

  // Row 2: callsign (always shown, — if unknown) | aircraft type (always shown, — if unknown)
  const csDisplay   = (ac.callsign && ac.callsign !== ac.icao) ? ac.callsign : '—';
  const typeDisplay = ac.aircraft_type || '—';
  const typeNil     = ac.aircraft_type ? '' : ' ws-sd-nil';

  // Row 3: registration · ICAO24 (both always shown)
  const regDisplay  = ac.registration || '—';
  const icaoDisplay = ac.icao;

  const barbSelClass = (barbLayerActive && ac.icao === barbSelectedIcao) ? ' ws-strip-barb-sel' : '';

  return `
<div class="ws-strip ${srcClass(ac.meteo_source)}${wsSeverity ? ' ws-strip-shear' : ''}${barbSelClass}" data-icao="${ac.icao}">
  <div class="ws-strip-top">
    <div class="ws-strip-rwy ${rwyClass}">${rwyTxt}</div>
    <div class="ws-strip-vs ${vs.cls}">${vs.text} fpm</div>
    <div class="ws-gs-badge ${gsClass(gs)}">${gs}</div>
    ${sqkBadge}${wsBadge}
  </div>
  ${(sqkFlash || gaFlash) ? `<div class="ws-strip-flash-row">${sqkFlash}${gaFlash}</div>` : ''}
  <div class="ws-strip-id">
    <span class="ws-strip-callsign">${csDisplay}</span>
    ${returnBadge}
    <span class="ws-strip-type${typeNil}">${typeDisplay}</span>
  </div>
  <div class="ws-strip-reg">
    <span>${regDisplay}</span>
    <span class="ws-strip-icao">${icaoDisplay}</span>
  </div>
  <div class="ws-strip-data">
    ${row('Alt',  fmtAlt(ac.altitude))}
    ${row('Dist', fmtDist(ac.dist_thr_nm))}
    ${row('Wind', wind)}
    ${row('HW',   hw)}
    ${row('GS',   ac.groundspeed != null ? Math.round(ac.groundspeed) + ' kt' : null)}
    ${row('Temp', temp)}
    ${row('IAS',  ac.ias != null ? ac.ias + ' kt' : null)}
    ${row('XT',   ac.cross_track_nm != null ? ac.cross_track_nm.toFixed(1) + ' NM' : null)}
  </div>
</div>`;
}

function renderStrips(aircraft, shearEvents = []) {
  const container  = document.getElementById('ws-strips');
  const selectedRwy = document.getElementById('ws-ils-rwy').value;

  // Only show aircraft that are inside an ILS corridor, filtered by runway selector
  const onApproach = (aircraft || []).filter(ac =>
    ac.in_corridor && matchesRwyFilter(ac.approach_runway, selectedRwy)
  );

  if (onApproach.length === 0) {
    const msg = selectedRwy
      ? `No aircraft on ${selectedRwy}`
      : 'No aircraft inside ILS corridor';
    container.innerHTML = `<div class="ws-no-traffic">${msg}</div>`;
    return;
  }

  // Build a map of icao → highest shear severity for badge rendering.
  // Only events at or above the active alert level get a strip badge.
  // Pairwise events carry icao_low / icao_high; single-aircraft carry icao.
  const wsMap = new Map();
  for (const ev of shearEvents) {
    if (!severityMeetsLevel(ev.severity)) continue;
    const bump = (icao) => {
      if (!icao) return;
      const cur = wsMap.get(icao);
      if (!cur || SEV_ORDER[ev.severity] > SEV_ORDER[cur]) wsMap.set(icao, ev.severity);
    };
    bump(ev.icao_low);
    bump(ev.icao_high);
    bump(ev.icao);
  }

  // Preserve scroll position
  const scrollTop = container.scrollTop;
  container.innerHTML = onApproach.map(ac => buildStrip(ac, wsMap.get(ac.icao) || null)).join('');
  container.scrollTop = scrollTop;
}

// ── Weather (METAR / TAF / QNH) ───────────────────────────────────────────────
// QNH kept as a module-level variable so drawIlsProfile() can use it.
let currentQnh = 1013.25;

// ── METAR staleness indicator ─────────────────────────────────────────────────
let metarIssuedMs = null;   // UTC timestamp (ms) of the most recently parsed METAR issue time

/**
 * Parse the DDHHMM Z group from a raw METAR string (e.g. "EFHK 281550Z …")
 * and return a UTC Date timestamp in milliseconds, or null on failure.
 */
function parseMetarTime(metarStr) {
  if (!metarStr) return null;
  const m = metarStr.match(/\b(\d{2})(\d{2})(\d{2})Z\b/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const hr  = parseInt(m[2], 10);
  const mn  = parseInt(m[3], 10);
  const now = new Date();
  let   yr  = now.getUTCFullYear();
  let   mo  = now.getUTCMonth();   // 0-based
  // If reported day is ahead of today by more than 1 (clock skew / month boundary),
  // the METAR belongs to the previous month.
  if (day > now.getUTCDate() + 1) {
    mo -= 1;
    if (mo < 0) { mo = 11; yr -= 1; }
  }
  return Date.UTC(yr, mo, day, hr, mn, 0, 0);
}

/**
 * Apply or remove the staleness colour class on the METAR <pre> element
 * based on how many minutes have passed since the METAR was issued.
 * Called after every fetchWx() AND every minute via setInterval so the
 * colour transitions happen on time even when no new METAR arrives.
 */
function checkMetarAge() {
  const el = document.getElementById('ws-metar-text');
  if (!el) return;
  if (metarIssuedMs == null) { el.classList.remove('ws-metar-stale-orange', 'ws-metar-stale-red'); return; }
  const ageMin = (Date.now() - metarIssuedMs) / 60_000;
  if (ageMin >= 90) {
    el.classList.remove('ws-metar-stale-orange');
    el.classList.add('ws-metar-stale-red');
  } else if (ageMin >= 60) {
    el.classList.remove('ws-metar-stale-red');
    el.classList.add('ws-metar-stale-orange');
  } else {
    el.classList.remove('ws-metar-stale-orange', 'ws-metar-stale-red');
  }
}

async function fetchWx() {
  try {
    const r = await fetch('/api/wx');
    if (!r.ok) return;
    const d = await r.json();

    const metarEl = document.getElementById('ws-metar-text');
    const tafEl   = document.getElementById('ws-taf-text');
    if (metarEl) metarEl.textContent = d.metar || '—';
    if (tafEl)   tafEl.textContent   = d.taf   || '—';

    // Parse the METAR issue time and immediately update the staleness colour
    metarIssuedMs = parseMetarTime(d.metar);
    checkMetarAge();

    if (d.qnh_hpa != null) {
      currentQnh = d.qnh_hpa;
      document.getElementById('ws-qnh-val').textContent = d.qnh_hpa.toFixed(0);
      // Redraw profile with updated QNH immediately
      drawIlsProfile(lastAircraft.filter(ac => ac.in_corridor), lastShearEvents);
    }

    // Update METAR wind for the Windrose and redraw
    if (d.metar_wind !== undefined) {
      metarWind = d.metar_wind;
      drawWindrose();
    }
  } catch (_) { /* silent */ }
}

fetchWx();
setInterval(fetchWx,       10 * 60 * 1000);
setInterval(checkMetarAge,      60 * 1000);  // re-check age every minute for timely colour transitions

// ── ILS corridor filter toggle ────────────────────────────────────────────────
let ilsFilterActive = true;                          // ON by default
const ilsFilterBtn  = document.getElementById('ws-ils-filter');
ilsFilterBtn.classList.add('active');                // reflect initial state
ilsFilterBtn.addEventListener('click', () => {
  ilsFilterActive = !ilsFilterActive;
  ilsFilterBtn.classList.toggle('active', ilsFilterActive);
  updateMapMarkers(lastAircraft);
});

// ── Wind Rose toggle ──────────────────────────────────────────────────────────
document.getElementById('ws-windrose-btn').addEventListener('click', () => {
  windroseEnabled = !windroseEnabled;
  document.getElementById('ws-windrose-btn').classList.toggle('active', windroseEnabled);
  document.getElementById('ws-windrose-panel').classList.toggle('ws-windrose-hidden', !windroseEnabled);
  if (windroseEnabled) {
    // Re-sync the server windrose buffer immediately on open so the panel
    // always shows the freshest available data (mirrors the periodic 60 s poll).
    fetchWindroseObs().then(drawWindrose);
  }
});

// ── Windshear event log ───────────────────────────────────────────────────────
const WS_LOG_MAX = 50;   // maximum entries kept in memory
let wsLog = [];          // newest first

/**
 * Add new shear events to the log, deduplicating by runway + aircraft pair
 * within a 60-second window so one sustained event doesn't spam the log.
 */
function addToWsLog(events) {
  if (!wsDetectionEnabled || events.length === 0) return;

  const now  = Date.now();
  const dedup = 60_000; // ms — suppress repeat of same pair within 1 min

  for (const ev of events) {
    // Include algo so switching algorithm doesn't suppress the new detection,
    // and handle single-aircraft events (icao) alongside pairwise (icao_low/high).
    const key = `${ev.algo || 'pair'}:${ev.rwy}:${ev.icao_low || ev.icao || ''}:${ev.icao_high || ''}`;
    const last = wsLog.find(e => e._key === key);
    if (last && (now - last._ts) < dedup) continue;   // still recent — skip

    wsLog.unshift({
      ...ev,
      _key:  key,
      _ts:   now,
      _time: (() => { const d = new Date(now); return String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0') + ':' + String(d.getUTCSeconds()).padStart(2,'0'); })(),
    });
  }

  // Trim to max
  if (wsLog.length > WS_LOG_MAX) wsLog.length = WS_LOG_MAX;
}

// ── Compact log tooltip ───────────────────────────────────────────────────────
const _wsTooltipEl = () => document.getElementById('ws-log-tooltip');

function _showLogTooltip(ev, html) {
  const tip = _wsTooltipEl(); if (!tip) return;
  tip.innerHTML = html;
  tip.style.display = 'block';
  _posLogTooltip(ev);
}
function _posLogTooltip(ev) {
  const tip = _wsTooltipEl(); if (!tip) return;
  const vw = window.innerWidth, vh = window.innerHeight;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = ev.clientX + 14, y = ev.clientY + 14;
  if (x + tw > vw - 8) x = ev.clientX - tw - 14;
  if (y + th > vh - 8) y = ev.clientY - th - 14;
  tip.style.left = x + 'px';
  tip.style.top  = y + 'px';
}
function _hideLogTooltip() {
  const tip = _wsTooltipEl(); if (tip) tip.style.display = 'none';
}

function renderWsLog() {
  const el = document.getElementById('ws-ws-log-entries');
  if (!el) return;

  if (wsLog.length === 0) {
    const msg = wsDetectionEnabled
      ? 'No events detected'
      : 'Enable detection — go-arounds logged automatically';
    el.innerHTML = `<div class="ws-ws-log-empty">${msg}</div>`;
    return;
  }

  const ALGO_LABELS = { pair:'Pair', gradient:'Gradient', energy:'Energy', rate:'Rate', baseline:'Baseline', kinematic:'Kinematic' };

  el.innerHTML = wsLog.map(e => {
    // ── Go-around entry (compact) ─────────────────────────────────────────
    if (e._type === 'go_around') {
      const tip = `${e._time} UTC  ·  RWY ${e.rwy}\n✈ Go-Around  ·  ${e._ordinal} this session\nAlt: ${e.alt_ft} ft\nAircraft: ${e.callsign || e.icao}`;
      return `<div class="ws-log-entry-compact ws-log-ga"
  data-tip="${tip.replace(/"/g,'&quot;')}"
>${e._time} ✈ GA ${e.rwy}  ${e.callsign || e.icao}</div>`;
    }

    // ── Windshear entry (compact) ─────────────────────────────────────────
    const sevCls  = e.severity === 'alarm'   ? ' ws-log-alarm'
                  : e.severity === 'warning' ? ' ws-log-warning'
                  : ' ws-log-monitor';
    const hw_low  = e.hw_low  != null ? Number(e.hw_low).toFixed(0)  : '?';
    const hw_high = e.hw_high != null ? Number(e.hw_high).toFixed(0) : '?';
    const trend   = e.hw_trend === 'loss' ? '▼LOSS' : e.hw_trend === 'gain' ? '▲GAIN' : (e.hw_high > e.hw_low ? '↓' : '↑');
    const algoLbl = ALGO_LABELS[e.algo] || (e.algo || 'WS');

    // Compact one-liner
    let acShort;
    if (e.cs_low && e.cs_high) acShort = `${e.cs_low}/${e.cs_high}`;
    else if (e.cs) acShort = e.cs;
    else acShort = '';
    const compact = `${e._time} [${algoLbl}] ${e.rwy} ${e.delta_kt}kt${trend} ${acShort}`;

    // Full tooltip
    const trendFull = e.hw_trend === 'loss' ? '▼ headwind loss' : e.hw_trend === 'gain' ? '▲ headwind gain' : (e.hw_high > e.hw_low ? '▼ headwind decrease' : '▲ headwind increase');
    let acFull;
    if (e.cs_low && e.cs_high) {
      acFull = `${e.cs_low}: ${hw_low} kt  ↕  ${e.cs_high}: ${hw_high} kt`;
    } else if (e.cs) {
      const detail = e.algo === 'energy' ? `GS ${hw_high}→${hw_low} kt` : `HW ${hw_high}→${hw_low} kt`;
      acFull = `${e.cs}  ${detail}`;
    } else {
      acFull = `${hw_low} kt → ${hw_high} kt`;
    }
    const fLine = (e.algo === 'kinematic' && e.f_factor != null) ? `\nF-factor: ${e.f_factor.toFixed(2)}` : '';
    const tip = `${e._time} UTC  ·  RWY ${e.rwy}  ·  ${algoLbl}\n${e.delta_kt} kt ${trendFull}\nAlt: ${Math.round(e.alt_low/100)*100}–${Math.round(e.alt_high/100)*100} ft${fLine}\n${acFull}`;

    return `<div class="ws-log-entry-compact${sevCls}"
  data-tip="${tip.replace(/"/g,'&quot;')}"
>${compact}</div>`;
  }).join('');

  // Wire tooltip events
  el.querySelectorAll('[data-tip]').forEach(row => {
    row.addEventListener('mouseenter', ev => _showLogTooltip(ev, row.dataset.tip.replace(/\n/g,'<br>')));
    row.addEventListener('mousemove',  ev => _posLogTooltip(ev));
    row.addEventListener('mouseleave', _hideLogTooltip);
  });
}

// ── Today's approach statistics ───────────────────────────────────────────────
// ── Stats range state ────────────────────────────────────────────────────────
let wsStatsRange    = localStorage.getItem('ms_ws_stats_range') || 'live';
let wsStatsDateMode = false;   // true when a specific date is selected via calendar
let wsStatsDate     = '';      // YYYY-MM-DD selected date (empty when not in date mode)

function _statsUrl() {
  const now = new Date();
  const fmt = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  if (wsStatsDateMode && wsStatsDate) {
    return `/api/windshear/approach-history?date=${wsStatsDate}`;
  }
  if (wsStatsRange === 'yesterday') {
    return `/api/windshear/approach-history?date=${fmt(new Date(now - 86_400_000))}`;
  } else if (wsStatsRange === '1w') {
    return `/api/windshear/approach-history?window=604800`;
  }
  return `/api/windshear/approach-history?date=${fmt(now)}`;
}

function _statsLabel() {
  if (wsStatsDateMode && wsStatsDate) {
    // Format YYYY-MM-DD → "01 Jun 2026" for display in section labels
    const [y, m, d] = wsStatsDate.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${d} ${months[Number(m) - 1]} ${y}`;
  }
  if (wsStatsRange === 'yesterday') return 'Yesterday';
  if (wsStatsRange === '1w')        return 'Last 7 Days';
  return 'Today';
}

function _syncStatsButtons() {
  // Range buttons are deactivated when a specific date is selected
  document.querySelectorAll('.ws-stats-time-btn').forEach(b =>
    b.classList.toggle('active', !wsStatsDateMode && b.dataset.statsRange === wsStatsRange));
  const lbl = _statsLabel();
  const rwyLbl  = document.getElementById('ws-stats-rwy-label');
  const typeLbl = document.getElementById('ws-stats-type-label');
  if (rwyLbl)  rwyLbl.textContent  = `Runway Usage · ${lbl}`;
  if (typeLbl) typeLbl.textContent = `Aircraft Types · ${lbl}`;
  // Show/hide the date badge
  const badge = document.getElementById('ws-stats-date-badge');
  if (badge) {
    if (wsStatsDateMode && wsStatsDate) {
      badge.innerHTML = `${lbl} <span class="ws-stats-date-clear" title="Clear date, return to Live">×</span>`;
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
  }
  // Totals are appended by renderTodayStats after data loads
}

async function fetchTodayStats() {
  try {
    const r = await fetch(_statsUrl());
    if (!r.ok) return;
    const data = await r.json();
    renderTodayStats(Array.isArray(data) ? data : []);
  } catch (_) {}
}

function renderTodayStats(approaches) {
  const rwyEl  = document.getElementById('ws-stats-rwy');
  const typeEl = document.getElementById('ws-stats-types');
  if (!rwyEl || !typeEl) return;

  const total = approaches.length;
  if (total === 0) {
    rwyEl.innerHTML  = '<span class="ws-stats-empty">No landings yet</span>';
    typeEl.innerHTML = '<span class="ws-stats-empty">No data</span>';
    return;
  }

  // Count per runway and per aircraft type
  const rwyCounts  = {};
  const typeCounts = {};
  for (const ap of approaches) {
    if (ap.runway)       rwyCounts[ap.runway]                     = (rwyCounts[ap.runway]       || 0) + 1;
    const t = ap.aircraft_type || 'NIL';
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }

  // Render runway bars (sorted by count desc)
  const rwySorted = Object.entries(rwyCounts).sort((a,b) => b[1]-a[1]);
  const maxRwy = rwySorted[0]?.[1] || 1;
  rwyEl.innerHTML = rwySorted.map(([rwy, cnt]) => {
    const pct = Math.round(cnt / total * 100);
    const barW = Math.round(cnt / maxRwy * 100);
    const tip  = `RWY ${rwy}: ${cnt} landing${cnt !== 1 ? 's' : ''}`;
    return `<div class="ws-stats-row" data-tip="${tip}">
  <span class="ws-stats-rwy-name">${rwy}</span>
  <div class="ws-stats-bar-wrap"><div class="ws-stats-bar" style="width:${barW}%;background:var(--accent)"></div></div>
  <span class="ws-stats-pct">${pct}%</span>
</div>`;
  }).join('');

  // Render top 10 aircraft types (sorted by count desc)
  const typeSorted = Object.entries(typeCounts).sort((a,b) => b[1]-a[1]);
  const maxType = typeSorted[0]?.[1] || 1;
  typeEl.innerHTML = typeSorted.map(([type, cnt]) => {
    const pct = Math.round(cnt / total * 100);
    const barW = Math.round(cnt / maxType * 100);
    const tip  = `${type}: ${cnt} approach${cnt !== 1 ? 'es' : ''}`;
    return `<div class="ws-stats-row" data-tip="${tip}">
  <span class="ws-stats-type-name">${type}</span>
  <div class="ws-stats-bar-wrap"><div class="ws-stats-bar" style="width:${barW}%;background:#10b981"></div></div>
  <span class="ws-stats-pct">${pct}%</span>
</div>`;
  }).join('');

  // Update section labels with totals
  const totalTypes = Object.keys(typeCounts).length;
  const lbl = _statsLabel();
  const rwyLblEl  = document.getElementById('ws-stats-rwy-label');
  const typLblEl  = document.getElementById('ws-stats-type-label');
  if (rwyLblEl)  rwyLblEl.textContent  = `Runway Usage · ${lbl}  Total: ${total}`;
  if (typLblEl)  typLblEl.textContent  = `Aircraft Types · ${lbl}  Total types: ${totalTypes}`;

  // Go-around count — appended below the runway bars
  const gaTotal = approaches.reduce((sum, e) => sum + (e.go_arounds || 0), 0);
  rwyEl.innerHTML += `<div class="ws-stats-ga-row${gaTotal === 0 ? ' ws-stats-ga-none' : ''}">Go-arounds: ${gaTotal}</div>`;

  // Wire hover tooltips (reuse the existing log tooltip element and helpers)
  [rwyEl, typeEl].forEach(container => {
    container.querySelectorAll('[data-tip]').forEach(row => {
      row.addEventListener('mouseenter', ev => _showLogTooltip(ev, row.dataset.tip));
      row.addEventListener('mousemove',  ev => _posLogTooltip(ev));
      row.addEventListener('mouseleave', _hideLogTooltip);
    });
  });
}

/**
 * Add go-around events from the server to the shared log.
 * Deduplicates by icao + count using a persistent Set that survives log
 * clears — this prevents cleared GA entries from bouncing back on the next
 * poll cycle (the server keeps returning the same events from RAM).
 * GA events are always logged regardless of whether windshear detection
 * is enabled.
 */
const wsGaSeenKeys   = new Set();          // persists across Clear button presses
const wsSessionStart = Date.now() / 1000;  // Unix seconds — gate for historical events

function addGaToWsLog(events) {
  if (!events || events.length === 0) return;
  for (const ev of events) {
    if (ev.ts < wsSessionStart) continue;  // occurred before this page session — skip
    const key = `ga:${ev.icao}:${ev.count}`;
    if (wsGaSeenKeys.has(key)) continue;   // already seen — don't re-add after clear
    wsGaSeenKeys.add(key);

    const n = ev.count;
    const ordinal = n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
    wsLog.unshift({
      ...ev,
      _type:    'go_around',
      _key:     key,
      _ts:      ev.ts * 1000,
      _time:    (() => { const d = new Date(ev.ts * 1000); return String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0') + ':' + String(d.getUTCSeconds()).padStart(2,'0'); })(),
      _ordinal: ordinal,
    });
  }
  if (wsLog.length > WS_LOG_MAX) wsLog.length = WS_LOG_MAX;
}

// Clear button
document.getElementById('ws-log-clear')?.addEventListener('click', () => {
  wsLog = [];
  renderWsLog();
});

// ── Wind barb layer state ─────────────────────────────────────────────────────
const wsWindHistory        = {};  // icao → [{dist_nm, alt_ft, wind_spd, wind_dir}, …]  Lo buffer
const wsWindHiHistory      = {};  // icao → [{dist_nm, alt_ft, wind_spd, wind_dir}, …]  Hi buffer (research, display-only)
const wsNoneHistory        = {};  // icao → [{dist_nm, alt_ft, reason}, …]  in-corridor NONE positions
const wsPreCorridorHistory = {};  // icao → [{dist_nm, alt_ft, reason}, …]  pre-corridor NONE positions (e.g. wide turns)
const wsNoneHistLastSeen   = {};  // icao → ms timestamp — guards against brief poll gaps clearing NONE history
// How long (ms) an icao must be absent from the live feed before its NONE history is cleared.
// Matches the server's ~30-45 s stale-out window so circles survive GPS-jamming reception gaps.
const WS_NONE_HIST_STALE_MS = 45_000;
let barbLayerActive  = false;  // toggle: show barb overlay on ILS canvas
let barbSelectedIcao = null;   // which aircraft's barbs are displayed (null = none)
let barbAutoActive   = false;  // auto-select mode: always show lowest approach aircraft
let barbAutoTarget   = null;   // icao currently held by auto mode (null = none yet)
let barbHwActive     = false;  // toggle: annotate each barb with headwind/tailwind value
let barbHiResActive  = false;  // toggle: use Hi-resolution buffer instead of Lo for barb display
let barbDclActive    = false;  // toggle: split HW/raw labels above+below barb for readability
let trkActive          = localStorage.getItem('ms_ws_trk') !== 'false'; // trail visible by default
let profileZoomActive  = false;  // toggle: zoom ILS profile to PROFILE_ZOOM_NM (7.5 NM) half-range

// ── Wind Rose state ───────────────────────────────────────────────────────────
const WINDROSE_ALT_MAX       = 2_000;              // ft — ceiling for MODE-S wind samples
const WINDROSE_MAX_AGE_MS    = 30 * 60 * 1000;     // 30-minute window for main M-S arrow
const WINDROSE_HIST_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6-hour buffer for Hist trend arrows

let windroseEnabled      = true;   // shown by default
let wrHistMode           = 0;      // 0=off  1=3h  2=6h
let wrHistDots           = [];     // last-drawn hist dots for hover tooltip: [{x,y,dotR,label,color}]
let metarWind            = null;   // { dir, spd, variable } — updated by fetchWx
const recentLandingWinds    = [];          // { dir, spd, alt, ts } — low-alt obs from departed aircraft
const windroseServerTsSeen  = new Set();   // Unix-ms ts values already ingested from the server buffer
let prevLiveIcaos            = new Set();  // icao set from previous poll, used to detect departures

// ── Wind Rose helpers ─────────────────────────────────────────────────────────

/**
 * Vector-average a list of {dir, spd} wind observations.
 * Uses U/V decomposition to handle 360°→0° wraparound correctly.
 * Returns { dir, spd, count } or null if the list is empty.
 */
function vectorAvgWind(obs) {
  if (!obs || obs.length === 0) return null;
  let sumU = 0, sumV = 0;
  for (const o of obs) {
    const r = o.dir * Math.PI / 180;
    sumU += o.spd * Math.sin(r);
    sumV += o.spd * Math.cos(r);
  }
  const avgU = sumU / obs.length;
  const avgV = sumV / obs.length;
  const spd  = Math.sqrt(avgU * avgU + avgV * avgV);
  let   dir  = Math.atan2(avgU, avgV) * 180 / Math.PI;
  if (dir < 0) dir += 360;
  return { dir: Math.round(dir), spd: Math.round(spd), count: obs.length };
}

/**
 * Draw the EFHK wind rose on the ws-windrose-canvas and update the
 * text readout div below it.
 *
 * Compass convention:
 *   Arrow tip points in the DOWNWIND direction (where the wind is blowing TO).
 *   e.g. wind FROM 050° → arrow points toward 230° (SW/"04" end), showing
 *   that RWY 04 approaches have a headwind.  This makes head/tailwind
 *   assessment immediate: arrowhead toward a runway label = headwind for it.
 *
 * Runways drawn as plain crossing lines:
 *   047°/227°  (04L, 04R, 22L, 22R — same magnetic heading)
 *   152°/332°  (RWY 15 / RWY 33)
 */
function drawWindrose() {
  const canvas  = document.getElementById('ws-windrose-canvas');
  const readout = document.getElementById('ws-windrose-readout');
  if (!canvas || !windroseEnabled) return;

  const ctx = canvas.getContext('2d');
  const W   = canvas.width;
  const H   = canvas.height;
  const cx  = W / 2;
  const cy  = H / 2;
  const R   = Math.min(cx, cy) - 22;  // auto-scales with canvas size; 22 px for labels
  const LR  = R + 14;                 // label radius
  const MAX_SPD = 40;                  // kt → full radius
  const CT  = wsCanvasTheme();
  const nowMs = Date.now();            // used by hist buckets and MODE-S age calc

  // ── Background ──────────────────────────────────────────────────────────────
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = CT.roseBg;
  ctx.fillRect(0, 0, W, H);

  // ── Speed reference rings (10 / 20 / 30 kt) ────────────────────────────────
  ctx.lineWidth = 0.5;
  for (const spd of [10, 20, 30]) {
    ctx.beginPath();
    ctx.arc(cx, cy, R * spd / MAX_SPD, 0, Math.PI * 2);
    ctx.strokeStyle = CT.roseOuter;
    ctx.stroke();
  }

  // ── Compass ring ────────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = CT.roseRing;
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  // ── Tick marks ──────────────────────────────────────────────────────────────
  for (let deg = 0; deg < 360; deg += 10) {
    const rad  = deg * Math.PI / 180;
    const maj  = deg % 90  === 0;
    const semi = deg % 45  === 0;
    const len  = maj ? 7 : semi ? 5 : 3;
    ctx.beginPath();
    ctx.moveTo(cx + R * Math.sin(rad),       cy - R * Math.cos(rad));
    ctx.lineTo(cx + (R - len) * Math.sin(rad), cy - (R - len) * Math.cos(rad));
    ctx.strokeStyle = maj ? CT.roseSpeed : CT.roseRing;
    ctx.lineWidth   = maj ? 1.5 : 0.75;
    ctx.stroke();
  }

  // ── Compass labels ──────────────────────────────────────────────────────────
  const COMPASS_LABELS = {
    0: 'N', 45: 'NE', 90: 'E', 135: 'SE',
    180: 'S', 225: 'SW', 270: 'W', 315: 'NW',
  };
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  for (const [d, lbl] of Object.entries(COMPASS_LABELS)) {
    const rad = Number(d) * Math.PI / 180;
    ctx.font      = Number(d) % 90 === 0 ? 'bold 12px "Courier New",monospace' : '10px "Courier New",monospace';
    ctx.fillStyle = CT.roseLabel;
    ctx.fillText(lbl, cx + LR * Math.sin(rad), cy - LR * Math.cos(rad));
  }

  // ── Runway lines (plain crossing lines, no arrows) ──────────────────────────
  // EFHK: 047°/227° covers all 04/22 runways; 152°/332° covers RWY 15/33.
  // Label convention: each end is labelled with the runway whose approach
  // flies TOWARD that compass direction (= headwind side for that runway).
  // e.g. wind FROM NE (047°) = headwind for RWY 22 → '22' at the NE/047° end.
  const RUNWAY_LINES = [
    { hdg: 47,  ends: ['22', '04'] },   // 047° end = RWY 22 headwind side
    { hdg: 152, ends: ['33', '15'] },   // 152° end = RWY 33 headwind side
  ];
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1.5;
  for (const rl of RUNWAY_LINES) {
    const r1 = rl.hdg * Math.PI / 180;
    const r2 = (rl.hdg + 180) * Math.PI / 180;
    const rLen = R * 0.93;
    ctx.beginPath();
    ctx.moveTo(cx + rLen * Math.sin(r1), cy - rLen * Math.cos(r1));
    ctx.lineTo(cx + rLen * Math.sin(r2), cy - rLen * Math.cos(r2));
    ctx.strokeStyle = CT.roseSpeed;
    ctx.stroke();
    // End labels just inside the ring
    ctx.font      = '11px "Courier New",monospace';
    ctx.fillStyle = CT.roseInner;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const inset = R * 0.78;
    ctx.fillText(rl.ends[0], cx + inset * Math.sin(r1), cy - inset * Math.cos(r1));
    ctx.fillText(rl.ends[1], cx + inset * Math.sin(r2), cy - inset * Math.cos(r2));
  }
  ctx.setLineDash([]);

  // ── Center dot ──────────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fillStyle = CT.roseSpeed;
  ctx.fill();

  // ── Wind arrow helper ────────────────────────────────────────────────────────
  // Arrow points in the DOWNWIND direction (where the wind is blowing TO).
  // This means the arrowhead points toward the runway label that receives a
  // headwind — e.g. wind FROM 050° blows toward 230°/SW, arrow points to the
  // "04" end, showing RWY 04 has the headwind.
  function drawArrow(dir, spd, color) {
    if (dir == null || spd == null) return;
    const len  = R * Math.min(spd, MAX_SPD) / MAX_SPD;
    if (len < 2) {
      // Calm / near-calm — open circle at origin
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.strokeStyle = color; ctx.lineWidth = 1.5;
      ctx.stroke();
      return;
    }
    // Downwind direction = dir + 180°
    const rad = (dir + 180) * Math.PI / 180;
    const tx  = cx + len * Math.sin(rad);
    const ty  = cy - len * Math.cos(rad);

    // Shaft
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tx, ty);
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2;
    ctx.stroke();

    // Arrowhead
    const hLen = 7, hAng = 0.38;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - hLen * Math.sin(rad - hAng), ty + hLen * Math.cos(rad - hAng));
    ctx.lineTo(tx - hLen * Math.sin(rad + hAng), ty + hLen * Math.cos(rad + hAng));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  // ── Historical direction dots on compass ring (Hist mode) ───────────────────
  // Each hour bucket: one dot on the ring edge at that hour's avg wind direction.
  // Dot radius scales with speed.  Consecutive dots joined by a faint drift arc.
  // Center of compass stays clear so live METAR/MODE-S arrows are unobstructed.
  // Dot positions are saved to wrHistDots for canvas mouseover tooltip.
  wrHistDots = [];   // reset on every redraw
  if (wrHistMode > 0) {
    const histHours = wrHistMode === 1 ? 3 : 6;
    const HIST_BUCKETS = [
      { color: '#f59e0b', alpha: 0.80 },  // 0–1 h  amber
      { color: '#f97316', alpha: 0.70 },  // 1–2 h  orange
      { color: '#fb7185', alpha: 0.60 },  // 2–3 h  rose
      { color: '#a78bfa', alpha: 0.55 },  // 3–4 h  purple
      { color: '#818cf8', alpha: 0.50 },  // 4–5 h  violet
      { color: '#94a3b8', alpha: 0.45 },  // 5–6 h  slate
    ].slice(0, histHours);
    const HIST_LABELS = ['0–1h','1–2h','2–3h','3–4h','4–5h','5–6h'];

    // Compute avg per bucket; store positions for arc and tooltip
    const dotPts = [];   // { x, y, color, alpha, dotR, label } or null if no data
    for (let i = 0; i < histHours; i++) {
      const toMs   = nowMs - i * 3_600_000;
      const fromMs = nowMs - (i + 1) * 3_600_000;
      const bucket = recentLandingWinds.filter(o => o.ts >= fromMs && o.ts < toMs);
      if (bucket.length === 0) { dotPts.push(null); continue; }
      const avg = vectorAvgWind(bucket);
      if (!avg || avg.spd < 1) { dotPts.push(null); continue; }

      const { color, alpha } = HIST_BUCKETS[i];
      const rad   = avg.dir * Math.PI / 180;          // direction FROM = dot position on ring
      const dotR  = Math.max(3.5, Math.min(7, 3.5 + avg.spd / MAX_SPD * 7)); // 3.5–7 px
      const dotX  = cx + R * Math.sin(rad);
      const dotY  = cy - R * Math.cos(rad);
      const label = `${HIST_LABELS[i]}: ${String(avg.dir).padStart(3,'0')}°/${avg.spd}kt`;
      dotPts.push({ x: dotX, y: dotY, color, alpha, dotR, label });
    }

    // Draw connecting arcs between consecutive present dots (faint)
    let prevPt = null;
    for (const pt of dotPts) {
      if (pt && prevPt) {
        ctx.globalAlpha = 0.25;
        ctx.beginPath();
        ctx.moveTo(prevPt.x, prevPt.y);
        ctx.lineTo(pt.x, pt.y);
        ctx.strokeStyle = pt.color;
        ctx.lineWidth   = 1;
        ctx.stroke();
      }
      prevPt = pt || prevPt;  // keep last known for arc continuity
    }

    // Draw dots on top of arcs; save to wrHistDots for hover tooltip
    for (const pt of dotPts) {
      if (!pt) continue;
      ctx.globalAlpha = pt.alpha;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, pt.dotR, 0, Math.PI * 2);
      ctx.fillStyle = pt.color;
      ctx.fill();
      wrHistDots.push({ x: pt.x, y: pt.y, dotR: pt.dotR, label: pt.label, color: pt.color });
    }

    ctx.globalAlpha = 1;
  }

  // ── METAR wind arrow (cyan) ──────────────────────────────────────────────────
  const METAR_COL = '#38bdf8';
  const MODES_COL = '#10b981';

  if (metarWind) {
    if (metarWind.variable) {
      // VRB — draw a dotted ring at the speed radius
      const r = R * Math.min(metarWind.spd || 5, MAX_SPD) / MAX_SPD;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = METAR_COL; ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      drawArrow(metarWind.dir, metarWind.spd, METAR_COL);
    }
  }

  // ── MODE-S averaged wind arrow (green) ──────────────────────────────────────
  const recent = recentLandingWinds.filter(o => (nowMs - o.ts) <= WINDROSE_MAX_AGE_MS);
  const modesW = vectorAvgWind(recent);
  if (modesW && modesW.spd > 0) {
    drawArrow(modesW.dir, modesW.spd, MODES_COL);
  }

  // ── Top-left legend dots + top-right timestamps (UTC HH:MM) ────────────────
  const fmtUtcHHMM = ms => {
    if (ms == null) return '--:--';
    const d = new Date(ms);
    return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  };
  const latestModesMs = recent.length > 0 ? Math.max(...recent.map(o => o.ts)) : null;

  ctx.font = '10px "Courier New",monospace';
  ctx.textBaseline = 'top';

  // Left: coloured dot + source label
  ctx.textAlign = 'left';
  ctx.fillStyle = METAR_COL;
  ctx.fillText('● METAR', 5, 4);
  ctx.fillStyle = modesW ? MODES_COL : CT.roseSpeed;
  ctx.fillText('● MODE-S', 5, 14);

  // Right: UTC issue / observation time
  ctx.textAlign = 'right';
  ctx.fillStyle = METAR_COL;
  ctx.fillText(fmtUtcHHMM(metarIssuedMs), W - 5, 4);
  ctx.fillStyle = modesW ? MODES_COL : CT.roseSpeed;
  ctx.fillText(fmtUtcHHMM(latestModesMs), W - 5, 14);

  // ── Text readout below canvas ────────────────────────────────────────────────
  if (!readout) return;

  let metarLine = '<span style="color:#38bdf8">MET —</span>';
  if (metarWind) {
    const dStr = metarWind.variable
      ? 'VRB'
      : String(metarWind.dir).padStart(3, '0') + '°';
    metarLine = `<span style="color:#38bdf8">MET ${dStr} / ${metarWind.spd} kt</span>`;
  }

  const waitCol = document.documentElement.dataset.theme === 'light' ? '#64748b' : '#334155';
  let modesLine = `<span style="color:${waitCol}">M-S  waiting for data…</span>`;
  if (modesW) {
    const ageMin  = recent.length > 0
      ? Math.round((nowMs - Math.max(...recent.map(o => o.ts))) / 60_000)
      : null;
    const ageStr  = ageMin != null ? ` · ${ageMin}min ago` : '';
    modesLine = `<span style="color:#10b981">M-S ${String(modesW.dir).padStart(3,'0')}° / ${modesW.spd} kt  (${modesW.count}obs${ageStr})</span>`;
  }

  readout.innerHTML = `${metarLine}<br>${modesLine}`;
}

// ── Main poll loop ────────────────────────────────────────────────────────────
let lastAircraft = [];

async function fetchApproachState() {
  try {
    const r = await fetch('/api/windshear/state');
    if (!r.ok) return;
    const data     = await r.json();
    // API returns {aircraft, ga_events}; fall back to plain list for compat
    const aircraft = Array.isArray(data) ? data : (data.aircraft || []);
    const gaEvents = Array.isArray(data) ? [] : (data.ga_events  || []);
    lastAircraft   = aircraft;

    const corridor = aircraft.filter(ac => ac.in_corridor);

    // ── Wind history: remove data for aircraft no longer tracked ──────────
    const liveIcaos = new Set(aircraft.map(a => a.icao));

    // ── Windrose: save low-altitude wind from aircraft that just left ─────
    // Do this BEFORE deleting wsWindHistory so we can still read the data.
    const nowMs = Date.now();
    for (const icao of prevLiveIcaos) {
      if (!liveIcaos.has(icao)) {
        const hist = wsWindHistory[icao] || [];
        const below2k = hist.filter(o => o.alt_ft <= WINDROSE_ALT_MAX && o.wind_spd != null);
        for (const obs of below2k) {
          recentLandingWinds.push({
            dir: obs.wind_dir,
            spd: obs.wind_spd,
            alt: obs.alt_ft,
            ts:  nowMs,
          });
        }
      }
    }
    prevLiveIcaos = liveIcaos;

    // Prune observations older than the 6-hour hist buffer
    const windroseCutoff = nowMs - WINDROSE_HIST_MAX_AGE_MS;
    while (recentLandingWinds.length > 0 && recentLandingWinds[0].ts < windroseCutoff) {
      recentLandingWinds.shift();
    }

    for (const icao of Object.keys(wsWindHistory)) {
      if (!liveIcaos.has(icao)) {
        delete wsWindHistory[icao];
        delete wsWindHiHistory[icao];
        if (barbSelectedIcao === icao) barbSelectedIcao = null;
      }
    }
    // wsNoneHistory has its own cleanup loop so that:
    // (a) aircraft that were NONE for their entire approach (never got a wsWindHistory
    //     entry) are still pruned when they leave the display, and
    // (b) wsNoneHistory entries survive brief reception gaps that happen to coincide
    //     with the aircraft's transition from NONE to valid state — previously the
    //     shared loop would see the first wsWindHistory entry, find the aircraft
    //     momentarily absent from liveIcaos, and delete wsNoneHistory prematurely.
    // Update last-seen timestamps for all currently tracked aircraft so the
    // stale-timeout cleanup below has accurate timing data.
    for (const icao of liveIcaos) wsNoneHistLastSeen[icao] = nowMs;

    // Prune NONE circle history only after the aircraft has been absent for
    // WS_NONE_HIST_STALE_MS (45 s), matching the server stale-out window.
    // A brief 1-poll absence (GPS-jamming reception gap) no longer wipes the
    // history — circles correctly persist alongside the returning valid barbs.
    for (const icao of Object.keys(wsNoneHistory)) {
      const lastSeen = wsNoneHistLastSeen[icao] || 0;
      if ((nowMs - lastSeen) > WS_NONE_HIST_STALE_MS) {
        delete wsNoneHistory[icao];
        delete wsNoneHistLastSeen[icao];
        // Clear selection if this was a NONE-only aircraft.
        if (barbSelectedIcao === icao) barbSelectedIcao = null;
      }
    }
    for (const icao of Object.keys(wsPreCorridorHistory)) {
      const lastSeen = wsNoneHistLastSeen[icao] || 0;
      if ((nowMs - lastSeen) > WS_NONE_HIST_STALE_MS) {
        delete wsPreCorridorHistory[icao];
      }
    }

    // ── Pre-corridor NONE history: accumulate for non-corridor aircraft ───
    // Captures positions where meteo_source is NONE but the aircraft is NOT
    // in the ILS corridor — the typical wide localizer intercept turn.
    // Uses dist_nearest_thr_nm (server-computed) for the X-axis position.
    // Only 'qc' reason is accumulated (quality rejection from bank angle = turn)
    // to avoid showing GPS-jamming events outside the corridor.
    // Drawn on the ILS canvas as smaller amber circles when the aircraft
    // is selected, clearly distinct from full-size corridor circles.
    //
    // Time-based fallback: a level-altitude turn barely changes dist_nearest_thr_nm
    // or altitude, so the standard alt/dist gates would store only the first
    // observation for the entire duration of the turn.  The 15-second fallback
    // ensures at least one new circle per 15 s regardless of movement, giving
    // 3–5 circles across a typical 45–60 s localizer intercept.
    for (const ac of aircraft) {
      if (ac.in_corridor) continue;                        // corridor handled by wsNoneHistory
      if (ac.meteo_source !== 'NONE') continue;
      if (ac.none_reason !== 'qc') continue;               // only turn-related NONE
      if (ac.dist_nearest_thr_nm == null) continue;        // need valid X-position
      if (ac.altitude == null) continue;
      if (ac.dist_nearest_thr_nm > PROFILE_MAX_NM) continue; // outside canvas range
      if (!wsPreCorridorHistory[ac.icao]) wsPreCorridorHistory[ac.icao] = [];
      const pcHist = wsPreCorridorHistory[ac.icao];
      const pcLast = pcHist[pcHist.length - 1];
      const pcAltMoved  = !pcLast || Math.abs(pcLast.alt_ft  - ac.altitude)            >= WS_WIND_MIN_ALT_GAP;
      const pcDistMoved = !pcLast || Math.abs(pcLast.dist_nm - ac.dist_nearest_thr_nm) >= WS_WIND_MIN_DIST_GAP;
      const pcTimeMoved = !pcLast || (nowMs - (pcLast.ts || 0)) >= 15_000;
      if (pcAltMoved || pcDistMoved || pcTimeMoved) {
        pcHist.push({ dist_nm: ac.dist_nearest_thr_nm, alt_ft: ac.altitude, reason: 'qc', ts: nowMs });
        if (pcHist.length > WS_WIND_HIST_MAX) pcHist.shift();
      }
    }
    // Clean up GS history for aircraft no longer tracked
    for (const icao of Object.keys(wsGsHistory)) {
      if (!liveIcaos.has(icao)) delete wsGsHistory[icao];
    }
    // Clean up kinematic history for aircraft no longer tracked
    for (const icao of Object.keys(wsKinHistory)) {
      if (!liveIcaos.has(icao)) delete wsKinHistory[icao];
    }

    // ── GS history: accumulate for energy algorithm ───────────────────────
    for (const ac of corridor) {
      if (ac.groundspeed == null || ac.altitude == null) continue;
      if (!wsGsHistory[ac.icao]) wsGsHistory[ac.icao] = [];
      wsGsHistory[ac.icao].push({ gs: ac.groundspeed, alt: ac.altitude, ts: nowMs });
      // Keep a rolling 30-point buffer (~90 s at 3 s polling); the energy
      // algorithm applies its own 45-second time filter on top.
      if (wsGsHistory[ac.icao].length > 30) wsGsHistory[ac.icao].shift();
    }

    // ── Kinematic history: accumulate IAS−GS differential for corridor aircraft
    //    Requires IAS from BDS 6,0.  Only stored when aircraft is in corridor.
    //    pos_frozen guard: when GPS jamming freezes the aircraft's position, GS
    //    (derived from ADS-B GPS velocity) is also frozen while IAS (Mode S BDS 6,0,
    //    independent of GPS) may keep changing — producing an artificial and growing
    //    IAS−GS differential that keeps kinematic detection firing indefinitely even
    //    after the aircraft has landed.  Clear any accumulated history on pos_frozen
    //    so stale entries cannot keep triggering events, and stop accumulating until
    //    valid GPS data resumes.
    for (const ac of corridor) {
      if (ac.ias == null || ac.groundspeed == null) continue;
      if (ac.pos_frozen) {
        delete wsKinHistory[ac.icao];   // purge stale entries immediately
        continue;
      }
      if (!wsKinHistory[ac.icao]) wsKinHistory[ac.icao] = [];
      wsKinHistory[ac.icao].push({ ias: ac.ias, gs: ac.groundspeed, ts: nowMs });
      // 30-point rolling buffer (~90 s at 3 s polling); algorithm applies 45 s filter
      if (wsKinHistory[ac.icao].length > 30) wsKinHistory[ac.icao].shift();
    }

    // ── Wind history (Lo): accumulate for corridor aircraft with wind data ─
    for (const ac of corridor) {
      if (ac.dist_thr_nm == null || ac.best_wind_spd == null || ac.best_wind_dir == null) continue;
      if (ac.meteo_source === 'NONE') continue;   // skip stale values from grey aircraft
      if (ac.pos_frozen) continue;                // skip GPS-frozen position — barb would stack vertically
      if (!wsWindHistory[ac.icao]) wsWindHistory[ac.icao] = [];
      const hist = wsWindHistory[ac.icao];
      const last = hist[hist.length - 1];
      const altMoved  = !last || Math.abs(last.alt_ft  - ac.altitude)     >= WS_WIND_MIN_ALT_GAP;
      const distMoved = !last || Math.abs(last.dist_nm - ac.dist_thr_nm)  >= WS_WIND_MIN_DIST_GAP;
      if (altMoved || distMoved) {
        hist.push({
          dist_nm:  ac.dist_thr_nm,
          alt_ft:   ac.altitude,
          wind_spd: ac.best_wind_spd,
          wind_dir: ac.best_wind_dir,
          src:      ac.meteo_source,  // quality tag — used for per-barb colouring
        });
        if (hist.length > WS_WIND_HIST_MAX) hist.shift();
      }
    }

    // ── Wind history (Hi): parallel high-resolution buffer — display only ──
    // Tighter thresholds (150 ft / 0.2 NM), larger cap (100 obs).
    // Never read by any detection algorithm — safe to accumulate independently.
    for (const ac of corridor) {
      if (ac.dist_thr_nm == null || ac.best_wind_spd == null || ac.best_wind_dir == null) continue;
      if (ac.meteo_source === 'NONE') continue;   // skip stale values from grey aircraft
      if (ac.pos_frozen) continue;                // skip GPS-frozen position — barb would stack vertically
      if (!wsWindHiHistory[ac.icao]) wsWindHiHistory[ac.icao] = [];
      const hiHist = wsWindHiHistory[ac.icao];
      const hiLast = hiHist[hiHist.length - 1];
      const hiAltMoved  = !hiLast || Math.abs(hiLast.alt_ft  - ac.altitude)    >= WS_WIND_HI_MIN_ALT_GAP;
      const hiDistMoved = !hiLast || Math.abs(hiLast.dist_nm - ac.dist_thr_nm) >= WS_WIND_HI_MIN_DIST_GAP;
      if (hiAltMoved || hiDistMoved) {
        hiHist.push({
          dist_nm:  ac.dist_thr_nm,
          alt_ft:   ac.altitude,
          wind_spd: ac.best_wind_spd,
          wind_dir: ac.best_wind_dir,
          src:      ac.meteo_source,  // quality tag — used for per-barb colouring
        });
        if (hiHist.length > WS_WIND_HI_HIST_MAX) hiHist.shift();
      }
    }

    // ── Position history (NONE): track corridor aircraft whose wind computation
    //    has failed (meteo_source === 'NONE') so their positions can be drawn as
    //    grey open circles on the ILS profile.  Useful for detecting GPS-jamming
    //    periods: a hollow-circle trail shows the aircraft was receiving position
    //    data normally even while wind decoding was suspended.
    //
    //    Time-based fallback: same rationale as wsPreCorridorHistory above —
    //    a level-altitude turn within the corridor (e.g. late ILS capture)
    //    barely moves along-track or altitude, so only the first observation
    //    would be stored without the 15-second time gate.
    for (const ac of corridor) {
      if (ac.meteo_source !== 'NONE') continue;
      if (ac.dist_thr_nm == null || ac.altitude == null) continue;
      if (!wsNoneHistory[ac.icao]) wsNoneHistory[ac.icao] = [];
      const noneHist = wsNoneHistory[ac.icao];
      const noneLast = noneHist[noneHist.length - 1];
      const noneAltMoved  = !noneLast || Math.abs(noneLast.alt_ft  - ac.altitude)    >= WS_WIND_MIN_ALT_GAP;
      const noneDistMoved = !noneLast || Math.abs(noneLast.dist_nm - ac.dist_thr_nm) >= WS_WIND_MIN_DIST_GAP;
      const noneTimeMoved = !noneLast || (nowMs - (noneLast.ts || 0)) >= 15_000;
      if (noneAltMoved || noneDistMoved || noneTimeMoved) {
        noneHist.push({
          dist_nm: ac.dist_thr_nm,
          alt_ft:  ac.altitude,
          reason:  ac.none_reason || 'qc',   // 'qc' | 'freeze' | 'gap'
          ts:      nowMs,
        });
        if (noneHist.length > WS_WIND_HIST_MAX) noneHist.shift();
      }
    }

    // Run windshear detection — apply confidence gate (requires N consecutive hits)
    lastShearEvents = applyConfidenceGate(detectWindshear(corridor));

    // Auto-barb: update selection before rendering so strips + canvas are in sync
    runAutoBarbSelection(corridor, aircraft);

    renderStrips(aircraft, lastShearEvents);
    updateMapMarkers(aircraft);
    drawIlsProfile(corridor, lastShearEvents);
    updateAlertBanner(lastShearEvents);
    updateSqkAlarm(aircraft);
    addToWsLog(lastShearEvents);
    addGaToWsLog(gaEvents);
    renderWsLog();
    drawWindrose();

    // Summary: count corridor aircraft per runway
    const rwyCounts = {};
    corridor.forEach(ac => {
      if (ac.approach_runway) rwyCounts[ac.approach_runway] = (rwyCounts[ac.approach_runway] || 0) + 1;
    });
    const rwySummary = Object.entries(rwyCounts)
      .map(([rwy, c]) => `${c}×${rwy}`)
      .join('  ');
    const nCorridor = corridor.length;
    const nTotal    = aircraft.length;

    document.getElementById('ws-ac-summary').textContent =
      nCorridor === 0 ? 'No aircraft inside ILS corridor'
                      : `${nCorridor} on ILS${rwySummary ? '  ·  ' + rwySummary : ''}${nTotal > nCorridor ? `  (${nTotal - nCorridor} other)` : ''}`;
    document.getElementById('ws-map-count').textContent =
      ilsFilterActive
        ? `${nCorridor} ILS corridor`
        : `${nTotal} tracked  ·  ${nCorridor} on ILS`;

  } catch (e) {
    console.warn('Windshear state fetch error:', e);
  }
}

// Runway selector triggers profile redraw + strip filter
document.getElementById('ws-ils-rwy').addEventListener('change', () => {
  drawIlsProfile(lastAircraft.filter(ac => ac.in_corridor), lastShearEvents);
  renderStrips(lastAircraft, lastShearEvents);
});

// ── Auto-barb selection ───────────────────────────────────────────────────────
/**
 * Called on every poll when barbAutoActive is true.
 *
 * Holds the current target as long as it is still alive in the corridor.
 * When the target goes stale (pruned by the server), picks the new lowest
 * aircraft (smallest dist_thr_nm).  Assigns barbSelectedIcao so the
 * existing barb-draw path works without any other changes.
 *
 * allAircraft (optional) — the full tracked aircraft list (corridor + non-corridor).
 * Used to keep the current target alive when it briefly exits the corridor
 * geometry (e.g. wide localizer intercept turn) without switching to another
 * aircraft prematurely.
 */
function runAutoBarbSelection(corridor, allAircraft = []) {
  if (!barbLayerActive || !barbAutoActive) return;

  // Keep existing target if it is still inside the corridor.
  if (barbAutoTarget && corridor.some(ac => ac.icao === barbAutoTarget)) {
    barbSelectedIcao = barbAutoTarget;
    return;
  }

  // Keep existing target if it is still tracked AND not climbing away
  // (brief corridor gap — e.g. wide localizer intercept that momentarily
  // crosses the corridor boundary while transitioning from NONE to valid
  // meteo data).  The vert_rate guard (<+400 fpm) prevents a departing or
  // go-around aircraft from being held as the target after it leaves the
  // corridor on a climb-out; those will have strongly positive vert_rate
  // and fall through so the selection switches to the next corridor aircraft.
  if (barbAutoTarget && allAircraft.some(
        ac => ac.icao === barbAutoTarget && (ac.vert_rate ?? 0) < 400)) {
    barbSelectedIcao = barbAutoTarget;
    return;
  }

  // Target truly gone (pruned by server) — pick lowest corridor aircraft.
  const candidates = corridor.filter(ac => ac.dist_thr_nm != null);
  if (candidates.length === 0) {
    barbAutoTarget   = null;
    barbSelectedIcao = null;
    return;
  }
  candidates.sort((a, b) => a.dist_thr_nm - b.dist_thr_nm);
  barbAutoTarget   = candidates[0].icao;
  barbSelectedIcao = barbAutoTarget;
}

// ── Wind barb toggle ──────────────────────────────────────────────────────────────
document.getElementById('ws-barb-btn').addEventListener('click', () => {
  barbLayerActive = !barbLayerActive;
  document.getElementById('ws-barb-btn').classList.toggle('active', barbLayerActive);
  if (!barbLayerActive) {
    // Turning barbs off — also cancel auto mode, HW annotation and Hi-res mode
    barbSelectedIcao = null;
    barbAutoActive   = false;
    barbAutoTarget   = null;
    barbHwActive     = false;
    barbHiResActive  = false;
    barbDclActive    = false;
    document.getElementById('ws-barb-auto-btn').classList.remove('active');
    document.getElementById('ws-barb-hw-btn').classList.remove('active');
    document.getElementById('ws-barb-hw-btn').classList.add('ws-barb-hw-off');
    document.getElementById('ws-barb-hi-btn').classList.remove('active');
    document.getElementById('ws-barb-hi-btn').classList.add('ws-barb-hi-off');
    document.getElementById('ws-barb-dcl-btn').classList.remove('active');
    document.getElementById('ws-barb-dcl-btn').classList.add('ws-barb-dcl-off');
  } else {
    document.getElementById('ws-barb-hw-btn').classList.remove('ws-barb-hw-off');
    document.getElementById('ws-barb-hi-btn').classList.remove('ws-barb-hi-off');
    // Dcl stays greyed until HW is also on
  }
  drawIlsProfile(lastAircraft.filter(ac => ac.in_corridor), lastShearEvents);
  renderStrips(lastAircraft, lastShearEvents);
});

// ── HW/TW annotation toggle ───────────────────────────────────────────────────
document.getElementById('ws-barb-hw-btn').addEventListener('click', () => {
  if (!barbLayerActive) return;   // button is visually disabled when barbs are off
  barbHwActive = !barbHwActive;
  document.getElementById('ws-barb-hw-btn').classList.toggle('active', barbHwActive);
  // Dcl only makes sense when HW is on — enable/disable accordingly
  if (barbHwActive) {
    document.getElementById('ws-barb-dcl-btn').classList.remove('ws-barb-dcl-off');
  } else {
    barbDclActive = false;
    document.getElementById('ws-barb-dcl-btn').classList.remove('active');
    document.getElementById('ws-barb-dcl-btn').classList.add('ws-barb-dcl-off');
  }
  drawIlsProfile(lastAircraft.filter(ac => ac.in_corridor), lastShearEvents);
});

// ── Dcl (declutter) label placement toggle ────────────────────────────────────
// Splits HW and raw wind labels to opposite sides of each barb for readability.
// Only active when both Barbs and HW are on.
document.getElementById('ws-barb-dcl-btn').addEventListener('click', () => {
  if (!barbLayerActive || !barbHwActive) return;
  barbDclActive = !barbDclActive;
  document.getElementById('ws-barb-dcl-btn').classList.toggle('active', barbDclActive);
  drawIlsProfile(lastAircraft.filter(ac => ac.in_corridor), lastShearEvents);
});

// ── Trail toggle ─────────────────────────────────────────────────────────────
// Shows or hides the position history trail on the ILS glideslope canvas.
// State is persisted to localStorage so the preference survives page reloads.
document.getElementById('ws-trk-btn').addEventListener('click', () => {
  trkActive = !trkActive;
  localStorage.setItem('ms_ws_trk', trkActive);
  document.getElementById('ws-trk-btn').classList.toggle('active', trkActive);
  drawIlsProfile(lastAircraft.filter(ac => ac.in_corridor), lastShearEvents);
});

// Restore saved trail state on page load
document.getElementById('ws-trk-btn').classList.toggle('active', trkActive);

// ── ILS profile zoom toggle ───────────────────────────────────────────────────
// Halves the horizontal range from 15 NM to 7.5 NM, giving roughly double
// the horizontal pixel density for wind barbs — useful with Hi-res mode active.
document.getElementById('ws-zoom-btn').addEventListener('click', () => {
  profileZoomActive = !profileZoomActive;
  document.getElementById('ws-zoom-btn').classList.toggle('active', profileZoomActive);
  drawIlsProfile(lastAircraft.filter(ac => ac.in_corridor), lastShearEvents);
});

// ── Hi-resolution barb mode toggle ───────────────────────────────────────────
// Switches the canvas from the Lo buffer (wsWindHistory, 400 ft / 0.5 NM / 40 obs)
// to the Hi buffer (wsWindHiHistory, 150 ft / 0.2 NM / 100 obs).
// The Hi buffer is accumulated every poll regardless of this toggle — switching
// modes shows the denser data that has already built up since page load.
document.getElementById('ws-barb-hi-btn').addEventListener('click', () => {
  if (!barbLayerActive) return;   // button is visually disabled when barbs are off
  barbHiResActive = !barbHiResActive;
  document.getElementById('ws-barb-hi-btn').classList.toggle('active', barbHiResActive);
  drawIlsProfile(lastAircraft.filter(ac => ac.in_corridor), lastShearEvents);
});

// Auto segment click: if barbs are off, turn them on then enable auto;
// if barbs are already on, simply toggle auto.
document.getElementById('ws-barb-auto-btn').addEventListener('click', () => {
  if (!barbLayerActive) {
    barbLayerActive = true;
    document.getElementById('ws-barb-btn').classList.add('active');
  }
  barbAutoActive = !barbAutoActive;
  document.getElementById('ws-barb-auto-btn').classList.toggle('active', barbAutoActive);
  if (!barbAutoActive) {
    barbAutoTarget = null;
    // Leave barbSelectedIcao as-is so the last barb stays visible after turning off auto
  } else {
    // Run a selection immediately so barbs appear without waiting for the next poll
    runAutoBarbSelection(lastAircraft.filter(ac => ac.in_corridor), lastAircraft);
  }
  drawIlsProfile(lastAircraft.filter(ac => ac.in_corridor), lastShearEvents);
  renderStrips(lastAircraft, lastShearEvents);
});

// ── Strip click — select aircraft for barb display ────────────────────────────────────────────
// Event delegation on the scroll container so clicks work after each re-render.
document.getElementById('ws-strips').addEventListener('click', e => {
  if (!barbLayerActive) return;
  const strip = e.target.closest('[data-icao]');
  if (!strip) return;
  const icao = strip.dataset.icao;

  // Manual selection cancels auto mode so the chosen aircraft stays pinned
  if (barbAutoActive) {
    barbAutoActive = false;
    barbAutoTarget = null;
    document.getElementById('ws-barb-auto-btn').classList.remove('active');
  }

  // Toggle: clicking the same strip again deselects
  barbSelectedIcao = (barbSelectedIcao === icao) ? null : icao;
  drawIlsProfile(lastAircraft.filter(ac => ac.in_corridor), lastShearEvents);
  renderStrips(lastAircraft, lastShearEvents);
});


// ── Approach History panel ────────────────────────────────────────────────────
let approachHistoryEnabled = false;
let approachHistoryMode    = 'hw';    // 'wind' | 'hw'
let aphHistHiMode          = false;   // false = Lo (7 bands), true = Hi (15 bands)
let aphHistWindow          = 3 * 3600; // active time window in seconds (default 3 h)
let aphHistDateMode        = false;   // true when a specific date is selected
let aphHistDate            = '';      // YYYY-MM-DD selected by the user

// Lo: every 500 ft from 1000–3000;  Hi: every 200 ft from 200–3000
const APHIST_BANDS_LO = [600, 800, 1000, 1400, 1800, 2200, 2600, 3000];
const APHIST_BANDS_HI = [
   600,  800, 1000,
  1200, 1400, 1600, 1800, 2000,
  2200, 2400, 2600, 2800, 3000,
];

/** Return the active band list based on Hi/Lo mode. */
function aphBands() { return aphHistHiMode ? APHIST_BANDS_HI : APHIST_BANDS_LO; }

/** Total column count: 5 fixed cols (UTC/CS/Reg/Type/Rwy) + band cols. */
function aphColspan() { return 5 + aphBands().length; }

/** Rebuild the <thead> row to match the current Lo/Hi band selection. */
function renderApproachHistoryHeader() {
  const thead = document.getElementById('ws-aphist-thead');
  if (!thead) return;
  const bandThs = aphBands()
    .map(b => `<th class="ws-aphist-th">${b}</th>`)
    .join('');
  thead.innerHTML = `<tr>
    <th class="ws-aphist-th">UTC</th>
    <th class="ws-aphist-th">Callsign</th>
    <th class="ws-aphist-th">Reg</th>
    <th class="ws-aphist-th">Type</th>
    <th class="ws-aphist-th">Rwy</th>
    ${bandThs}
  </tr>`;
}

// Build header on load
renderApproachHistoryHeader();

document.getElementById('ws-aphist-btn').addEventListener('click', () => {
  approachHistoryEnabled = !approachHistoryEnabled;
  document.getElementById('ws-aphist-btn').classList.toggle('active', approachHistoryEnabled);
  document.getElementById('ws-aphist-panel').classList.toggle('ws-aphist-hidden', !approachHistoryEnabled);
  if (approachHistoryEnabled) fetchApproachHistory();
});

document.getElementById('ws-aphist-mode-sel').addEventListener('change', e => {
  approachHistoryMode = e.target.value;
  if (approachHistoryEnabled) fetchApproachHistory();
});

document.getElementById('ws-aphist-hi-btn').addEventListener('click', () => {
  aphHistHiMode = !aphHistHiMode;
  const btn   = document.getElementById('ws-aphist-hi-btn');
  const panel = document.getElementById('ws-aphist-panel');
  btn.textContent = aphHistHiMode ? 'Hi' : 'Lo';
  btn.classList.toggle('active', aphHistHiMode);
  panel.classList.toggle('ws-aphist-hi', aphHistHiMode);
  renderApproachHistoryHeader();
  if (approachHistoryEnabled) fetchApproachHistory();
});

// Time window selector — delegate clicks on the timerow div
document.querySelector('.ws-aphist-timerow').addEventListener('click', e => {
  const btn = e.target.closest('.ws-aphist-time-btn');
  if (!btn) return;
  aphHistWindow = parseInt(btn.dataset.window, 10);
  // Exit date mode when a time-window button is clicked
  aphHistDateMode = false;
  aphHistDate     = '';
  document.getElementById('ws-aphist-date').value        = '';
  document.getElementById('ws-aphist-date-picker').value = '';
  _aphHistSyncDateModeUI();
  // Update active highlight
  document.querySelectorAll('.ws-aphist-time-btn').forEach(b =>
    b.classList.toggle('ws-aphist-time-active', b === btn)
  );
  if (approachHistoryEnabled) fetchApproachHistory();
});

/** Sync dimmed / active state of time buttons and Live button to current mode. */
function _aphHistSyncDateModeUI() {
  const inDate = aphHistDateMode;
  document.querySelectorAll('.ws-aphist-time-btn').forEach(b =>
    b.classList.toggle('ws-aphist-time-dimmed', inDate)
  );
  document.getElementById('ws-aphist-live-btn').classList.toggle('ws-aphist-live-active', !inDate);
}

// Calendar button — opens the hidden native date picker
document.getElementById('ws-aphist-cal-btn').addEventListener('click', () => {
  try { document.getElementById('ws-aphist-date-picker').showPicker(); } catch (_) {}
});

// Hidden date picker — when user picks a date via calendar, fill the text field
document.getElementById('ws-aphist-date-picker').addEventListener('change', e => {
  const val = e.target.value; // YYYY-MM-DD
  if (!val) return;
  const [yyyy, mm, dd] = val.split('-');
  document.getElementById('ws-aphist-date').value = `${dd}.${mm}.${yyyy}`;
  aphHistDate     = val;
  aphHistDateMode = true;
  document.querySelectorAll('.ws-aphist-time-btn').forEach(b =>
    b.classList.remove('ws-aphist-time-active')
  );
  _aphHistSyncDateModeUI();
  if (approachHistoryEnabled) fetchApproachHistory();
});

// Date text input — dd.mm.yyyy text mask; auto-queries when a full valid date is typed
document.getElementById('ws-aphist-date').addEventListener('input', e => {
  // Strip everything that isn't a digit, keep up to 8 digits
  const digits = e.target.value.replace(/\D/g, '').slice(0, 8);
  // Rebuild dd.mm.yyyy progressively
  let formatted = digits.slice(0, 2);
  if (digits.length > 2) formatted += '.' + digits.slice(2, 4);
  if (digits.length > 4) formatted += '.' + digits.slice(4, 8);
  e.target.value = formatted;

  // Fire query only when all 8 digits are present
  if (digits.length < 8) return;
  const dd = digits.slice(0, 2), mm = digits.slice(2, 4), yyyy = digits.slice(4, 8);
  // Basic validity check via Date object
  const d = new Date(`${yyyy}-${mm}-${dd}`);
  if (isNaN(d.getTime())) return; // invalid date — wait for user to correct
  aphHistDate     = `${yyyy}-${mm}-${dd}`;
  aphHistDateMode = true;
  document.querySelectorAll('.ws-aphist-time-btn').forEach(b =>
    b.classList.remove('ws-aphist-time-active')
  );
  _aphHistSyncDateModeUI();
  if (approachHistoryEnabled) fetchApproachHistory();
});

// Live button — revert to rolling window
document.getElementById('ws-aphist-live-btn').addEventListener('click', () => {
  aphHistDateMode = false;
  aphHistDate     = '';
  document.getElementById('ws-aphist-date').value        = '';
  document.getElementById('ws-aphist-date-picker').value = '';
  _aphHistSyncDateModeUI();
  // Re-activate the time button that matches the current window
  document.querySelectorAll('.ws-aphist-time-btn').forEach(b =>
    b.classList.toggle('ws-aphist-time-active',
      parseInt(b.dataset.window, 10) === aphHistWindow)
  );
  if (approachHistoryEnabled) fetchApproachHistory();
});

/**
 * Format one altitude-band cell.
 *   'wind'  — "270°/15"   raw wind (direction / speed kt)
 *   'hw'    — "+12"/"-5"  headwind component, colour-coded green/red/amber
 *   'xw'    — "←8"/"→3"  crosswind component, colour-coded; ← = from left, → = from right
 *   'hwxw'  — two-line: HW on top, XW below
 *
 * Sign convention (both components):
 *   HW positive = headwind, negative = tailwind
 *   XW positive = wind from right of centreline, negative = from left
 */
function _hwVal(band, rwyHdg) {
  if (band == null || rwyHdg == null) return null;
  return Math.round(band.spd * Math.cos((band.dir - rwyHdg) * Math.PI / 180));
}
function _xwVal(band, rwyHdg) {
  if (band == null || rwyHdg == null) return null;
  return Math.round(band.spd * Math.sin((band.dir - rwyHdg) * Math.PI / 180));
}
function _hwHtml(hw) {
  const cls = hw >=  5 ? 'ws-aphist-hw-pos'
            : hw <= -5 ? 'ws-aphist-hw-neg'
            :             'ws-aphist-hw-zero';
  return `<span class="${cls}">${hw > 0 ? '+' : ''}${hw}</span>`;
}
function _xwHtml(xw) {
  const abs = Math.abs(xw);
  const cls = abs >= 10 ? 'ws-aphist-xw-strong'
            : abs >=  5 ? 'ws-aphist-xw-mod'
            :              'ws-aphist-xw-light';
  const arrow = xw < 0 ? '←' : '→';
  return `<span class="${cls}">${arrow}${abs}</span>`;
}

function formatBandCell(band, rwyHdg) {
  if (!band) return '<td class="ws-aphist-cell ws-aphist-nil">—</td>';

  if (approachHistoryMode === 'hw') {
    const hw = _hwVal(band, rwyHdg);
    if (hw == null) return '<td class="ws-aphist-cell ws-aphist-nil">—</td>';
    return `<td class="ws-aphist-cell">${_hwHtml(hw)}</td>`;
  }

  if (approachHistoryMode === 'xw') {
    const xw = _xwVal(band, rwyHdg);
    if (xw == null) return '<td class="ws-aphist-cell ws-aphist-nil">—</td>';
    return `<td class="ws-aphist-cell">${_xwHtml(xw)}</td>`;
  }

  if (approachHistoryMode === 'hwxw') {
    const hw = _hwVal(band, rwyHdg);
    const xw = _xwVal(band, rwyHdg);
    if (hw == null || xw == null) return '<td class="ws-aphist-cell ws-aphist-nil">—</td>';
    return `<td class="ws-aphist-cell">` +
      `<div class="ws-aphist-hwxw">${_hwHtml(hw)}<span class="ws-aphist-hwxw-sep"></span>${_xwHtml(xw)}</div>` +
      `</td>`;
  }

  // 'wind' mode: dir°/spd
  return `<td class="ws-aphist-cell">${band.dir}°/${band.spd}</td>`;
}

function renderApproachHistory(entries) {
  const tbody = document.getElementById('ws-aphist-table-body');
  if (!tbody) return;
  if (!entries || entries.length === 0) {
    tbody.innerHTML =
      `<tr><td colspan="${aphColspan()}" class="ws-aphist-empty">No approaches logged yet</td></tr>`;
    return;
  }

  // Midnight UTC of today — entries from a previous date get a D.M prefix on the time
  const todayMidnightUtc = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
  );

  const bands = aphBands();

  tbody.innerHTML = entries.map(e => {
    const tsMs    = (e.ts || 0) * 1000;
    const isToday = tsMs >= todayMidnightUtc;
    const timeStr = isToday
      ? (e.time_utc || '—')
      : (() => {
          const d = new Date(tsMs);
          return `${d.getUTCDate()}.${d.getUTCMonth() + 1} ${e.time_utc || ''}`;
        })();

    const rwyHdg   = e.rwy_heading ?? null;
    const bandCells = bands
      .map(b => formatBandCell(e.bands ? e.bands[String(b)] : null, rwyHdg))
      .join('');

    return `<tr>
  <td class="ws-aphist-cell ws-aphist-time">${timeStr}</td>
  <td class="ws-aphist-cell ws-aphist-cs${e.go_arounds > 0 ? ' ws-aphist-cs-ga' : ''}"${e.go_arounds > 0 ? ` title="${e.go_arounds}× go-around"` : ''}>${e.callsign || '—'}</td>
  <td class="ws-aphist-cell ws-aphist-reg">${e.registration  || '—'}</td>
  <td class="ws-aphist-cell ws-aphist-type">${e.aircraft_type || '—'}</td>
  <td class="ws-aphist-cell ws-aphist-rwy">${e.runway       || '—'}</td>
  ${bandCells}
</tr>`;
  }).join('');
}



// ── Windrose server buffer fetch ─────────────────────────────────────────────
async function fetchWindroseObs() {
  try {
    const r = await fetch('/api/windshear/windrose-obs');
    if (!r.ok) return;
    const obs = await r.json();
    const nowMs  = Date.now();
    let   newObs = 0;
    for (const o of obs) {
      const tsMs = o.ts * 1000;              // server sends Unix seconds; JS uses ms
      if (nowMs - tsMs > WINDROSE_HIST_MAX_AGE_MS) continue;
      if (windroseServerTsSeen.has(tsMs))            continue;  // already ingested this cycle
      windroseServerTsSeen.add(tsMs);
      recentLandingWinds.push({ dir: o.dir, spd: o.spd, alt: o.alt, ts: tsMs });
      newObs++;
    }
    // Prune seen-set: drop entries older than the hist buffer window
    const cutoff = nowMs - WINDROSE_HIST_MAX_AGE_MS;
    for (const ts of windroseServerTsSeen) {
      if (ts < cutoff) windroseServerTsSeen.delete(ts);
    }
    if (newObs > 0) drawWindrose();
  } catch (_) { /* silent */ }
}

// ── Approach history fetch ────────────────────────────────────────────────────
async function fetchApproachHistory() {
  if (!approachHistoryEnabled) return;
  try {
    const url = aphHistDateMode
      ? `/api/windshear/approach-history?date=${aphHistDate}`
      : `/api/windshear/approach-history?window=${aphHistWindow}`;
    const r = await fetch(url);
    if (!r.ok) return;
    renderApproachHistory(await r.json());
  } catch (_) {}
}

// ── Stats time range button handlers ─────────────────────────────────────────
document.querySelectorAll('.ws-stats-time-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    // Clicking a range button always clears any active date selection
    wsStatsDateMode = false;
    wsStatsDate     = '';
    document.getElementById('ws-stats-date-picker').value = '';
    wsStatsRange = btn.dataset.statsRange;
    localStorage.setItem('ms_ws_stats_range', wsStatsRange);
    _syncStatsButtons();
    fetchTodayStats();
  });
});

// ── Stats calendar picker handlers ───────────────────────────────────────────
const _statsCalBtn    = document.getElementById('ws-stats-cal-btn');
const _statsDateInput = document.getElementById('ws-stats-date-picker');
const _statsDateBadge = document.getElementById('ws-stats-date-badge');

if (_statsCalBtn) {
  _statsCalBtn.addEventListener('click', () => {
    try { _statsDateInput && _statsDateInput.showPicker(); } catch (_) {}
  });
}

if (_statsDateInput) {
  _statsDateInput.addEventListener('change', e => {
    const val = e.target.value;   // YYYY-MM-DD
    if (!val) return;
    wsStatsDate     = val;
    wsStatsDateMode = true;
    _syncStatsButtons();
    fetchTodayStats();
  });
}

// Clear button inside the date badge — returns to the active range mode
if (_statsDateBadge) {
  _statsDateBadge.addEventListener('click', e => {
    if (!e.target.classList.contains('ws-stats-date-clear')) return;
    wsStatsDateMode = false;
    wsStatsDate     = '';
    if (_statsDateInput) _statsDateInput.value = '';
    _syncStatsButtons();
    fetchTodayStats();
  });
}

// Restore saved range on page load
_syncStatsButtons();

// ── Windrose Hist button ──────────────────────────────────────────────────────
const _wrHistBtn   = document.getElementById('ws-windrose-hist-btn');
const _wrHistBadge = document.getElementById('ws-windrose-hist-badge');

function _syncWrHistBtn() {
  if (!_wrHistBtn) return;
  const labels = ['', '3h', '6h'];
  _wrHistBtn.classList.toggle('active', wrHistMode > 0);
  if (_wrHistBadge) _wrHistBadge.textContent = labels[wrHistMode] || '';
}

if (_wrHistBtn) {
  _wrHistBtn.addEventListener('click', () => {
    wrHistMode = (wrHistMode + 1) % 3;
    _syncWrHistBtn();
    drawWindrose();
  });
}

// ── Windrose hist dot hover tooltip ──────────────────────────────────────────
const _wrCanvas  = document.getElementById('ws-windrose-canvas');
const _wrHistTip = document.getElementById('ws-windrose-hist-tip');

if (_wrCanvas && _wrHistTip) {
  _wrCanvas.addEventListener('mousemove', e => {
    if (wrHistDots.length === 0) { _wrHistTip.style.display = 'none'; return; }
    const rect = _wrCanvas.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    const my   = e.clientY - rect.top;
    let hit = null;
    for (const dot of wrHistDots) {
      const dx = mx - dot.x, dy = my - dot.y;
      if (Math.sqrt(dx*dx + dy*dy) <= dot.dotR + 6) { hit = dot; break; }
    }
    if (hit) {
      _wrHistTip.textContent  = hit.label;
      _wrHistTip.style.color  = hit.color;
      _wrHistTip.style.display = 'block';
      // Position tooltip: right of cursor, flip left if near right edge
      const tipX = mx + 10 + rect.left + window.scrollX;
      const tipY = my - 8  + rect.top  + window.scrollY;
      _wrHistTip.style.left = tipX + 'px';
      _wrHistTip.style.top  = tipY + 'px';
    } else {
      _wrHistTip.style.display = 'none';
    }
  });
  _wrCanvas.addEventListener('mouseleave', () => {
    _wrHistTip.style.display = 'none';
  });
}

// ── Startup ────────────────────────────────────────────────────────────────────────────────
fetchApproachState();
fetchApproachHistory();
fetchWindroseObs();
fetchTodayStats();
setInterval(fetchApproachState,   3_000);
setInterval(fetchApproachHistory, 15_000);
setInterval(fetchWindroseObs,     60_000);  // re-sync server windrose buffer every 60 s
setInterval(fetchTodayStats,       5 * 60_000);  // today's stats refresh every 5 min