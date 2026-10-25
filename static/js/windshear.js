/**
 * windshear.js — Approach monitoring page for MODE-S Wind.
 *
 * Displays aircraft currently on approach within WS_RADIUS_NM of the
 * configured airport on:
 *   • ATC-style flight strips (left panel)
 *   • Leaflet map with airport + ILS overlays (top right)
 *   • ILS vertical profile / glideslope canvas (bottom right)
 *
 * Data source: /api/windshear/state  — polled every 3 s (RAM-only, no DB):
 *              aircraft, go-arounds and the windshear alerts of the server's
 *              detection (collector/shear.py, from 2026-10-24).
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

// EFHK runway approach headings (true, same table as collector/windshear.py) — ILS-profile wind components
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
// Light theme: darker shades of the same hues, readable on the pale canvas
const GS_COLOR_LIGHT = {
  ON:   '#047857',
  HIGH: '#b45309',
  LOW:  '#b91c1c',
  FAR:  '#64748b',
};

// ── Map initialisation ────────────────────────────────────────────────────────
const map = L.map('ws-map', { zoomControl: true })
             .setView([WS_AIRPORT_LAT, WS_AIRPORT_LON], 10);

// CARTO_API_KEY is injected server-side in base.html (from local api_keys.py);
// appended as a query param so raster tiles are served without the watermark.
const _cartoKeyQs = CARTO_API_KEY ? `?key=${encodeURIComponent(CARTO_API_KEY)}` : '';

// Tile layers for theme switching
const TILES = {
  dark: L.tileLayer(
    `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png${_cartoKeyQs}`,
    { attribution: '© OSM © CARTO', subdomains: 'abcd', maxZoom: 18 }
  ),
  grey: L.tileLayer(
    `https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png${_cartoKeyQs}`,
    { attribution: '© OSM © CARTO', subdomains: 'abcd', maxZoom: 18 }
  ),
  atc: L.tileLayer(
    `https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png${_cartoKeyQs}`,
    { attribution: '© OSM © CARTO', subdomains: 'abcd', maxZoom: 18,
      opacity: 0.0 }     // tiles hidden, bg = #cfcfcf (ATC radar grey)
  ),
  black: L.tileLayer(
    `https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png${_cartoKeyQs}`,
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

// The map style follows the page's Light / Dark theme (navbar button):
// Dark ↔ Grey and Black ↔ ATC (see window.onThemeChange at the end).  The
// four map buttons still choose any style by hand.
const pageIsLight = () => document.documentElement.dataset.theme === 'light';
let currentTheme = pageIsLight() ? 'grey' : 'dark';
TILES[currentTheme].addTo(map);

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

let _ovlSeq = 0;   // newest loadOverlays call; an older, slower call adds nothing
async function loadOverlays(theme, level = 0) {
  const seq = ++_ovlSeq;
  // Remove all overlay layers
  if (ilsLayer)   { map.removeLayer(ilsLayer);   ilsLayer   = null; }
  if (aptLayer)   { map.removeLayer(aptLayer);   aptLayer   = null; }
  if (coastLayer) { map.removeLayer(coastLayer); coastLayer = null; }
  if (aquaLayer)  { map.removeLayer(aquaLayer);  aquaLayer  = null; }

  try {
    // ILS — always loaded; filtered to EFHK features
    const ilsGeo = await fetch('/overlays/efhk_ils.geojson').then(r => r.json());
    if (seq !== _ovlSeq) return;
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
      if (seq !== _ovlSeq) return;
      aptLayer = L.geoJSON(aptGeo, { style: aptStyle(theme) }).addTo(map);
    }

    // Level 1+: coastline
    if (level >= 1) {
      const coastGeo = await fetch('/overlays/efhk_coast.geojson').then(r => r.json());
      if (seq !== _ovlSeq) return;
      coastLayer = L.geoJSON(coastGeo, { style: coastStyle(theme) }).addTo(map);
    }

    // Level 2: water / aqua polygons
    if (level >= 2) {
      const aquaGeo = await fetch('/overlays/efhk_aqua.geojson').then(r => r.json());
      if (seq !== _ovlSeq) return;
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
updateThemeButtons();   // initial style may be Grey (light page theme)

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
// Dark theme: the panel colour (--bg-1 #162030) as background since 23 Oct 2026
// (before #0f1923 / #0a121c); grid and rings one step lighter with it.
function wsCanvasTheme() {
  const light = document.documentElement.dataset.theme === 'light';
  return {
    bg:         light ? '#eef2f7' : '#162030',
    grid:       light ? '#c5d0da' : '#28394f',
    gsband:     light ? 'rgba(37,99,235,0.08)'  : 'rgba(56,189,248,0.07)',
    gsline:     light ? '#2563eb' : '#38bdf8',
    annot:      light ? '#475569' : '#475569',
    axisLabel:  light ? '#475569' : '#64748b',
    noTraffic:  light ? '#64748b' : '#3d4b60',
    trail:      light ? 'rgba(0,0,0,0.26)'      : 'rgba(255,255,255,0.32)',
    staleRing:  light ? 'rgba(37,99,235,0.30)'  : 'rgba(56,189,248,0.30)',
    staleGlow:  light ? 'rgba(37,99,235,0.08)'  : 'rgba(56,189,248,0.08)',
    dotBorder:  '#000',
    barbHint:   light ? '#64748b' : '#475569',
    metar:      light ? '#0284c7' : '#38bdf8',   // METAR surface wind barb at the threshold
    // Wind Rose
    roseBg:     light ? '#e8edf3' : '#162030',
    roseOuter:  light ? '#b8c8d8' : '#243a52',
    roseRing:   light ? '#94a3b8' : '#28446f',
    roseSpeed:  light ? '#94a3b8' : '#475569',
    roseInner:  light ? '#c5d5e5' : '#3b6ea0',
    roseLabel:  light ? '#475569' : '#475569',
    labelBg:    light ? 'rgba(238,242,247,0.88)' : 'rgba(22,32,48,0.85)',   // behind callsign labels
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
  if (wsAlertLevel !== 'off' && shearEvents.length > 0) {
    const selectedRwyForShear = document.getElementById('ws-ils-rwy').value;
    for (const ev of shearEvents) {
      if (!levelShown(ev.lvl)) continue;
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
      const label = `${(WS_LEVEL[ev.lvl] || WS_LEVEL.adv).short}${ev.ph === 'dep' ? ' DEP' : ''} ${ev.delta_kt}kt${trendArrow}`;
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
  // Callsign labels are collected here and drawn last, on a background, so
  // the wind barbs and the glideslope do not hide them
  const acLabels = [];

  for (const ac of aircraft) {
    if (!matchesRwyFilter(ac.approach_runway, selectedRwy)) continue;
    if (ac.dist_thr_nm == null) continue;

    const gs = computeGsStatus(ac);
    const gsPal = pageIsLight() ? GS_COLOR_LIGHT : GS_COLOR;
    const color = gsPal[gs] || gsPal.FAR;

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

    // Label: callsign, or ICAO24 when no callsign is known.  Omitted when
    // near-stale (dot only).  The glideslope deviation is shown by the dot
    // colour (ON / HIGH / LOW) and no longer printed in the label.
    if (!nearStale) {
      // "*" = autopilot engaged (ADS-B TC 29, version 2 transponders only)
      const label = (ac.callsign || ac.icao) + (ac.ap ? '*' : '');

      acLabels.push({ text: label, x, y, color, right: x > M.left + PW * 0.7 });
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
      // Corner-label colour: the aircraft's current meteo source (grey when it
      // has left the corridor list).  The per-barb colour is defined inside the
      // loop below and is not in scope for the label.
      const labelColor = selAc ? acColor(selAc.meteo_source) : (pageIsLight() ? '#64748b' : '#94a3b8');

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
        const bColor = (obs.src && obs.src !== 'NONE') ? acColor(obs.src) : (pageIsLight() ? '#64748b' : '#94a3b8');
        drawWindBarb(ilsCtx, bx, by, obs.wind_spd, obs.wind_dir, bColor);

        // Label placement — edge detection for canvas boundaries
        const plotBottom = M.top + PH;
        const nearTop    = by - 24 < M.top + 6;
        const nearBot    = by + 24 > plotBottom - 6;
        ilsCtx.textAlign = 'center';

        if (barbHwMode !== 'off' && barbRwyHdg != null) {
          // ── Compute the active component (HW or XW) ──────────────────────
          const isHwMode  = barbHwMode === 'hw';
          const compVal   = isHwMode
            ? hwKt(obs.wind_spd, obs.wind_dir, barbRwyHdg)
            : xwKt(obs.wind_spd, obs.wind_dir, barbRwyHdg);
          const compRound = Math.round(compVal);

          // HW: green = headwind, red = tailwind, amber = near-zero (±5 kt)
          // XW: magnitude-based red gradient (matches approach history palette)
          const lt = pageIsLight();
          const compColor = isHwMode
            ? (compVal > 5 ? (lt ? '#15803d' : '#4ade80') : compVal < -5 ? (lt ? '#b91c1c' : '#f87171') : (lt ? '#a16207' : '#fbbf24'))
            : (Math.abs(compVal) >= 10 ? (lt ? '#b91c1c' : '#fca5a5') : Math.abs(compVal) >= 5 ? (lt ? '#a16207' : '#fcd34d') : (lt ? '#047857' : '#6ee7b7'));

          // HW label: "+12" / "-5"   XW label: "+8" (from right) / "-3" (from left) — knots implied
          const compLabel = `${compRound >= 0 ? '+' : ''}${compRound}`;

          // ── Values off (Val): component label only, in the single-label slot ─
          if (!barbValActive) {
            ilsCtx.fillStyle = compColor;
            ilsCtx.font      = 'bold 10px "Courier New", monospace';
            ilsCtx.fillText(compLabel, bx, nearTop ? by + 16 : by - 38);
            continue;
          }

          // ── Label Y positions (identical logic for HW and XW) ────────────
          let compY, rawY;
          if (barbDclActive) {
            // Dcl ON: raw wind ABOVE (lifted clear of staff), component BELOW
            if (nearTop) {
              compY = by + 14; rawY = by + 26;  // near top: both go down
            } else if (nearBot) {
              rawY = by - 34; compY = by - 22;  // near bottom: both go up
            } else {
              rawY = by - 34; compY = by + 16;  // normal: raw above, component below
            }
          } else {
            // Dcl OFF: both labels on same side, lifted clear of the barb staff (sLen=18 px)
            compY = nearTop ? by + 16 : by - 46;
            rawY  = nearTop ? by + 27 : by - 34;
          }

          ilsCtx.fillStyle = compColor;
          ilsCtx.font      = 'bold 9px "Courier New", monospace';
          ilsCtx.fillText(compLabel, bx, compY);

          ilsCtx.fillStyle = bColor + 'bb';
          ilsCtx.font      = '9px "Courier New", monospace';
          ilsCtx.fillText(
            `${Math.round(obs.wind_dir)}/${Math.round(obs.wind_spd)}`,
            bx, rawY
          );
        } else if (barbValActive) {
          // ── No component annotation active: dir°/spd only ────────────────
          // Lifted ~20 px clear of the barb origin so it doesn't sit on the staff
          const lblY = nearTop ? by + 16 : by - 38;
          ilsCtx.fillStyle = bColor + 'ee';
          ilsCtx.font      = '10px "Courier New", monospace';
          ilsCtx.fillText(
            `${Math.round(obs.wind_dir)}/${Math.round(obs.wind_spd)}`,
            bx, lblY
          );
        }
      }

      // Aircraft identifier in the top-left corner of the plot area
      const hwTag  = (barbHwMode !== 'off' && barbRwyHdg != null)
        ? `  · ${barbHwMode.toUpperCase()} ref ${selAc?.approach_runway ?? '?'} (${barbRwyHdg}°)` : '';
      const hiTag  = barbHiResActive ? '  · HI' : '';
      const dclTag = (barbHwMode !== 'off' && barbDclActive && barbValActive) ? '  · DCL' : '';
      const valTag = barbValActive ? '' : '  · NOVAL';
      ilsCtx.fillStyle = labelColor;
      ilsCtx.font      = 'bold 9px "Courier New", monospace';
      ilsCtx.textAlign = 'left';
      ilsCtx.fillText(
        `\u{1F32C} ${bLabel}  (${hist.length} obs)${barbAutoActive ? '  · AUTO' : ''}${hiTag}${valTag}${dclTag}${hwTag}`,
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

  // ── METAR surface wind at the threshold ───────────────────────────────────
  // The 10 m wind of the METAR as a barb at 0 NM on the threshold elevation:
  // the lowest true wind of the profile (aircraft replies usually stop at
  // 400–800 ft), so the change from the lowest aircraft barb to the surface
  // is visible.  With HW / XW on, the component for the same runway is shown.
  if (barbLayerActive && metarWind) {
    // anchored just left of the threshold so a barb pointing right stays on the canvas
    drawMetarBarb(aircraft, distX(0) - 10, altY(gsBaseline), CT);
  }

  // ── Callsign labels (on top, with a background) ────────────────────────────
  // Above-right of the dot (above-left near the threshold); a label that
  // would overlap one already placed is moved up.
  ilsCtx.save();
  ilsCtx.font = 'bold 10px "Courier New", monospace';
  ilsCtx.textBaseline = 'alphabetic';
  const placed = [];
  for (const L of acLabels.sort((a, b) => b.y - a.y)) {
    const w = ilsCtx.measureText(L.text).width + 6, h = 12;
    let bx = L.right ? L.x - 9 - w : L.x + 9 - 3;
    let by = L.y - 7 - 10;                                  // box top
    for (let k = 0; k < 6; k++) {
      const hit = placed.find(r => bx < r.x + r.w && bx + w > r.x && by < r.y + r.h && by + h > r.y);
      if (!hit) break;
      by = hit.y - h - 1;
    }
    by = Math.max(M.top, by);
    placed.push({ x: bx, y: by, w, h });
    ilsCtx.fillStyle = CT.labelBg;
    ilsCtx.fillRect(bx, by, w, h);
    ilsCtx.fillStyle = L.color;
    ilsCtx.textAlign = 'left';
    ilsCtx.fillText(L.text, bx + 3, by + 10);
  }
  ilsCtx.restore();
}

/** METAR surface-wind barb (cyan) with its label, at the threshold point. */
function drawMetarBarb(aircraft, x, y, CT) {
  const mw = metarWind;
  const gust = mw.gust ? `G${mw.gust}` : '';
  let txt;
  ilsCtx.save();
  if (mw.variable || mw.dir == null) {
    ilsCtx.strokeStyle = CT.metar; ilsCtx.lineWidth = 1.5;
    ilsCtx.beginPath(); ilsCtx.arc(x, y, 5, 0, 2 * Math.PI); ilsCtx.stroke();
    txt = `MET VRB/${mw.spd}${gust}`;
  } else {
    drawWindBarb(ilsCtx, x, y, mw.spd, mw.dir, CT.metar);
    ilsCtx.fillStyle = CT.metar;
    ilsCtx.beginPath(); ilsCtx.arc(x, y, 2.5, 0, 2 * Math.PI); ilsCtx.fill();
    txt = `MET ${String(mw.dir).padStart(3, '0')}/${mw.spd}${gust}`;
    // Component for the runway of the selected aircraft (or the dropdown)
    if (barbHwMode !== 'off') {
      const selAc = aircraft.find(a => a.icao === barbSelectedIcao);
      const hdg = getRwyHeading(selAc?.approach_runway || document.getElementById('ws-ils-rwy').value);
      if (hdg != null) {
        const c = Math.round(barbHwMode === 'hw' ? hwKt(mw.spd, mw.dir, hdg) : xwKt(mw.spd, mw.dir, hdg));
        txt += `  ${c >= 0 ? '+' : ''}${c} ${barbHwMode.toUpperCase()}`;
      }
    }
  }
  ilsCtx.fillStyle = CT.metar;
  ilsCtx.font      = 'bold 9px "Courier New", monospace';
  ilsCtx.textAlign = 'right';
  ilsCtx.fillText(txt, x - 10, y + 13);
  ilsCtx.restore();
}

// ── QNH-corrected glideslope status ──────────────────────────────────────────
/**
 * Compute GS badge status in the browser where the live QNH is available.
 * The server also QNH-corrects its gs_status once the METAR QNH is known, but
 * this JS version additionally applies the WS_GS_OFFSET_FT trim and reacts to
 * the browser's own QNH refresh immediately, so the strip badge and the canvas
 * dot always agree.
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

// ── Windshear detection (v2, server-side) ─────────────────────────────────────
// From 24 Oct 2026 the detection runs on the server for every aircraft on final
// (collector/shear.py): headwind ramps along the path from the aircraft's own
// BDS 5,0 replies (TAS − GS), scaled to a 1-km equivalent ΔV·(1 km/L)^⅓, and the
// change of the 200-ft band winds (as headwind) against all landings and departures of the previous
// 45 min.  /api/windshear/state returns the active alerts (ws_events) and the
// alert log of the last 24 h (ws_log).  The six browser algorithms of May –
// Oct 2026 (Pair, Gradient, Energy, Rate, Baseline, Kinematic) were retired —
// see doc/Windshear_Algorithms_v1_Legacy.pdf.
const WS_LEVEL = {
  adv: { name: 'WS advisory',      short: 'ADV', sev: 'monitor' },
  wsa: { name: 'Windshear alert',  short: 'WSA', sev: 'warning' },
  mba: { name: 'Microburst alert', short: 'MBA', sev: 'alarm'   },
};
const LV_RANK   = { adv: 0, wsa: 1, mba: 2 };
const SEV_ORDER = { monitor: 0, warning: 1, alarm: 2 };
const SEV_LV    = { monitor: 'adv', warning: 'wsa', alarm: 'mba' };
let lastShearEvents = [];   // active alerts (mapped for drawing)
let wsServerLog     = [];   // the server's alert log, newest first

/** Server alert → the fields the strips, banner and ILS profile draw. */
function mapWsEvent(e) {
  const lv = WS_LEVEL[e.lvl] || WS_LEVEL.adv;
  const a1 = e.a1 ?? 0, a2 = e.a2 ?? 0;
  return { ...e, severity: lv.sev, alt_high: Math.max(a1, a2), alt_low: Math.min(a1, a2),
           delta_kt: Math.round(e.kind === 'band' ? Math.abs(e.a) : Math.abs(e.dv)),
           hw_trend: e.dir };
}

/** One-line description of an alert (banner / log tooltip). */
function wsEventText(e, long = false) {
  const kt  = e.kind === 'band' ? Math.abs(e.a) : Math.abs(e.dv);
  const dir = e.dir === 'loss' ? 'headwind loss' : 'headwind gain';
  if (e.kind === 'band') {
    const s = `${Math.round(kt)} kt ${dir} at ${e.b} ft vs the last 45 min`;
    return long ? `${s} (${e.ref >= 0 ? '+' : ''}${e.ref} kt before, ${e.n} landings and departures)` : s;
  }
  const km = (e.L / 1000).toFixed(1);
  const s = `${Math.round(kt)} kt ${dir} over ${km} km, ${e.a1}→${e.a2} ft`;
  if (!long) return s;
  const f = e.fh != null ? `  ·  F (horizontal, 1 km) ${e.fh.toFixed(2)}` : '';
  const d = (e.d1 != null && e.d2 != null) ? `  ·  ${e.d1.toFixed(1)}→${e.d2.toFixed(1)} NM` : '';
  return `${s}${d}\n1-km equivalent ${e.sc} kt${f}`;
}

// ── Windshear helpers ────────────────────────────────────────────────────────

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
 * Crosswind component (kt) of a wind observation for a given runway heading.
 * Positive = wind from right of runway centreline, negative = from left.
 * Formula: spd × sin(windDir − rwyHdg)
 */
function xwKt(windSpd, windDir, rwyHdg) {
  return windSpd * Math.sin((windDir - rwyHdg) * Math.PI / 180);
}


// ── Alert level selector ──────────────────────────────────────────────────────
/**
 * Minimum level that shows the alert banner, the flight-strip badge and the
 * band on the ILS profile: off · adv (advisory ≥ 10 kt) · wsa (windshear
 * alert ≥ 15 kt) · mba (microburst alert ≥ 30 kt loss).  The log always lists
 * all levels.  Earlier saved choices (monitor / warning / alarm) are mapped.
 */
let wsAlertLevel = (() => {
  try {
    const v = localStorage.getItem('ms_ws_alert_lvl');
    if (v) return v;
    return ({ monitor: 'adv', warning: 'wsa', alarm: 'mba' })[localStorage.getItem('ms_ws_alert_level')] || 'wsa';
  } catch (_) { return 'wsa'; }
})();

function levelShown(lvl) {
  return wsAlertLevel !== 'off' && (LV_RANK[lvl] ?? 0) >= (LV_RANK[wsAlertLevel] ?? 1);
}
function severityMeetsLevel(severity) { return levelShown(SEV_LV[severity]); }

/** Alert banner at the top of the page (active alerts at or above the chosen level). */
function updateAlertBanner(events) {
  const banner = document.getElementById('ws-alert-banner');
  const active = events.filter(e => levelShown(e.lvl));
  if (active.length === 0) {
    banner.className = 'ws-alert-banner ws-alert-hidden';
    return;
  }
  const hasMba = active.some(e => e.lvl === 'mba');
  const hasWsa = active.some(e => e.lvl === 'wsa');
  const cls  = hasMba ? 'ws-alert-severe' : 'ws-alert-moderate';
  const icon = hasMba ? '🔴' : '⚠';
  const head = hasMba ? 'MICROBURST ALERT' : hasWsa ? 'WINDSHEAR ALERT' : 'WINDSHEAR ADVISORY';
  const tags = active.map(e => {
    const lv = WS_LEVEL[e.lvl] || WS_LEVEL.adv;
    const trendTag = e.dir === 'loss' ? ' ▼LOSS' : ' ▲GAIN';
    return `<span class="ws-alert-tag">${lv.short} · RWY ${e.rwy}${e.ph === 'dep' ? ' departure' : ''} · ${e.delta_kt} kt${trendTag} · ${wsEventText(e).replace(/^\d+ kt headwind (loss|gain) /, '')}  [${e.cs || e.icao}]</span>`;
  }).join(' ');
  banner.className = `ws-alert-banner ${cls}`;
  banner.innerHTML = `${icon} ${head} &nbsp; ${tags}`;
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

// ── Alert level selector (dropdown) ──────────────────────────────────────────
(function () {
  const sel = document.getElementById('ws-alert-level');
  if (!sel) return;
  sel.value = wsAlertLevel;
  sel.addEventListener('change', e => {
    wsAlertLevel = e.target.value;
    try { localStorage.setItem('ms_ws_alert_lvl', wsAlertLevel); } catch (_) {}
    renderStrips(lastAircraft, lastShearEvents);
    drawIlsProfile(lastAircraft.filter(ac => ac.in_corridor), lastShearEvents);
    updateAlertBanner(lastShearEvents);
  });
})();

function buildStrip(ac, wsSeverity = null) {
  const vs     = fmtVs(ac.vert_rate);
  const wind   = fmtWind(ac.best_wind_spd, ac.best_wind_dir);
  const temp   = fmtTemp(ac.best_temp);
  const gs     = computeGsStatus(ac);
  const rwyTxt = ac.approach_runway || '?';
  const rwyClass = ac.approach_runway ? '' : 'rwy-none';

  const wsBadge = wsSeverity
    ? `<div class="ws-ws-badge ws-${wsSeverity}">${(WS_LEVEL[SEV_LV[wsSeverity]] || WS_LEVEL.adv).short}</div>`
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
    ${ac.ap ? `<div class="ws-ap-badge" title="Autopilot engaged${ac.ap_app ? ', approach mode' : ''} (ADS-B target state, version 2 transponders only)">AP</div>` : ''}
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
    if (!levelShown(ev.lvl)) continue;
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
    if (wrView === 'cond') fetchCondData();
  }
});

// ── Windshear event log ───────────────────────────────────────────────────────
const WS_LOG_MAX = 50;   // maximum entries kept in memory
let wsLog = [];          // newest first

let wsLogClearedAt = 0;   // Unix s — the Clear button hides older entries

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

// ── Engine status line (ws_engine of /api/windshear/state, from 2026-10-24) ─
// One line under the Windshear Alert header: is the server-side detection
// running, how many aircraft it analyses now, the reference flights of the
// band comparison, today's (UTC) windshear reports by level and the strongest
// values of the day; the hover gives the details.
function _ago(sec) {
  if (sec == null) return '—';
  if (sec < 90) return `${Math.round(sec)} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  return `${Math.floor(sec / 3600)} h ${String(Math.round(sec % 3600 / 60)).padStart(2, '0')} min`;
}
function _hm(ts) {
  const d = new Date(ts * 1000);
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}
function renderEngineStatus(e) {
  const el = document.getElementById('ws-engine');
  if (!el) return;
  if (!e) { el.style.display = 'none'; return; }
  el.style.display = '';
  const stalled = e.final > 0 && (e.age == null || e.age > 120);
  const idle = !stalled && e.age == null;
  const st = stalled ? 'stalled' : idle ? 'idle' : 'ok';
  const dot = `<span class="ws-eng-dot ws-eng-${st}"></span>`;
  const head = stalled ? `no analysis for ${_ago(e.age)}` : idle ? 'waiting for traffic' : 'running';
  const now = stalled ? `${e.final} in the ILS corridors`
    : e.arr_now || e.dep_now ? `${e.arr_now} on final${e.dep_now ? ` · ${e.dep_now} dep` : ''}` : 'none on final';
  const refsLow = e.refs != null && e.refs < e.refs_min;
  const refs = e.refs == null ? '' : refsLow
    ? `<span class="ws-eng-dim">refs ${e.refs} · band check waiting</span>` : `refs ${e.refs}`;
  const lv = e.lvl || {};
  const lvTxt = `<span class="ws-eng-adv">ADV ${lv.adv || 0}</span> <span class="ws-eng-wsa">WSA ${lv.wsa || 0}</span>` +
                (lv.mba ? ` <span class="ws-eng-mba">MBA ${lv.mba}</span>` : '');
  const rS = e.ramp ? e.ramp.sc : null, bS = e.band ? Math.abs(e.band.a) : null;
  let mx = '';
  if (rS != null || bS != null) {
    const ramp = rS != null && (bS == null || rS >= bS);
    mx = `max ${Math.round(ramp ? rS : bS)} kt ${ramp ? 'ramp' : 'band'}`;
  }
  // [html, optional] — optional parts are hidden on narrow screens (CSS)
  const parts = [[`${dot}${head}`], [now, true], [refs], [`today ${e.arr} ldg / ${e.dep} dep`], [lvTxt], [mx, true]]
    .filter(p => p[0]);
  const sep = '<span class="ws-eng-sep"> · </span>';
  el.innerHTML = parts.map(([h, opt], i) => opt ? `<span class="ws-eng-opt">${sep}${h}</span>` : (i ? sep : '') + h).join('');
  // too long for the panel: leave out the optional parts (they stay in the hover)
  el.classList.remove('ws-eng-narrow');
  if (el.scrollWidth > el.clientWidth + 1) el.classList.add('ws-eng-narrow');

  const r = e.ramp, b = e.band;
  const tip = [
    '<b>Windshear detection v2 — on the server</b>',
    stalled ? `<span style="color:#f59e0b">No analysis for ${_ago(e.age)} although ${e.final} aircraft are in the ILS corridors — check the server log</span>`
            : e.age != null ? `Last analysis ${_ago(e.age)} ago` : 'No aircraft analysed since the server started',
    `Analysed now: ${e.arr_now} landing${e.arr_now === 1 ? '' : 's'} on final, ${e.dep_now} departure${e.dep_now === 1 ? '' : 's'} climbing out (in the ILS corridors: ${e.final})`,
    e.refs == null ? '' : `Band comparison: ${e.refs} landings and departures in the last 45 min` +
      (refsLow ? ` — at least ${e.refs_min} needed, so the change against earlier flights waits` : ` (at least ${e.refs_min} needed)`),
    `Today (UTC ${e.day}): ${e.arr} landings and ${e.dep} departures checked; flights with a report at ADV ${lv.adv || 0} · WSA ${lv.wsa || 0} · MBA ${lv.mba || 0}`,
    r ? `Strongest ramp: ${r.sc} kt per 1 km (${r.dir} ${Math.abs(r.dv)} kt over ${(r.L / 1000).toFixed(1)} km) — ${r.cs || '?'} ${_hm(r.ts)}` : 'Strongest ramp: none above the noise yet',
    b ? `Largest band change: ${b.a > 0 ? '+' : ''}${b.a} kt at ${b.b} ft — ${b.cs || '?'} ${_hm(b.ts)}${b.ph === 'dep' ? ' (departure)' : ''}` : 'Largest band change: no comparison yet',
    (e.noise != null || e.low != null) ? `Median of today's landings: reply noise ±${e.noise != null ? e.noise.toFixed(1) : '?'} kt · lowest height followed ${e.low != null ? e.low + ' ft' : '?'}` : '',
    e.last_alert ? `Last alert ${_hms(e.last_alert)} UTC (${_ago(e.now - e.last_alert)} ago)` : 'No alert in the last 24 h',
    `<span class="ws-eng-dim">Server running for ${_ago(e.uptime)} · levels: ADV ≥ 10 kt, WSA ≥ 15 kt, MBA ≥ 30 kt loss</span>`,
  ].filter(Boolean).join('<br>');
  el.onmouseenter = ev => _showLogTooltip(ev, tip);
  el.onmousemove  = ev => _posLogTooltip(ev);
  el.onmouseleave = () => _hideLogTooltip();
}

/** UTC hh:mm:ss of a Unix time (s). */
function _hms(ts) {
  const d = new Date(ts * 1000);
  return String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0') + ':' + String(d.getUTCSeconds()).padStart(2,'0');
}

function renderWsLog() {
  const el = document.getElementById('ws-ws-log-entries');
  if (!el) return;

  // Windshear alerts from the server log (last 24 h) + go-arounds (last 24 h, from 25 Oct 2026
  // also those before the page was opened or the server restarted)
  const ws = wsServerLog.filter(e => e.ts > wsLogClearedAt)
    .map(e => ({ ...mapWsEvent(e), _type: 'ws', _ts: e.ts * 1000, _time: _hms(e.ts) }));
  const gaCut = Math.max(wsLogClearedAt, Date.now() / 1000 - 86400);
  const all = ws.concat(wsLog.filter(e => e._ts / 1000 > gaCut))
    .sort((a, b) => b._ts - a._ts).slice(0, WS_LOG_MAX);

  if (all.length === 0) {
    el.innerHTML = `<div class="ws-ws-log-empty">No windshear alerts in the last 24 h<br>`
      + `<span class="ws-ws-log-note">Detection v2 runs on the server for every landing (from 24 Oct 2026).`
      + ` The six earlier algorithms were retired — <a href="/doc/Windshear_Algorithms_v1_Legacy.pdf" target="_blank" rel="noopener">legacy description</a>.</span></div>`;
    return;
  }

  el.innerHTML = all.map(e => {
    // ── Go-around entry (compact) ─────────────────────────────────────────
    if (e._type === 'go_around') {
      const lowTxt = e.low ? '\nClimb-out at / after the threshold (low go-around or touch-and-go)' : '';
      const wsTxt = e.ws && e.ws !== 'none' && WS_LEVEL[e.ws] ? `\n${WS_LEVEL[e.ws].name} active at that moment` : '';
      const tip = `${e._time} UTC  ·  RWY ${e.rwy}\n✈ Go-Around  ·  ${e._ordinal} go-around of this flight\nAlt: ${e.alt_ft} ft${lowTxt}${wsTxt}\nAircraft: ${e.callsign || e.icao}${e.ac_type ? '  ' + e.ac_type : ''}`;
      return `<div class="ws-log-entry-compact ws-log-ga"
  data-tip="${tip.replace(/"/g,'&quot;')}"
>${e._time} ✈ GA ${e.rwy}${e.low ? ' low' : ''}  ${e.callsign || e.icao}</div>`;
    }

    // ── Windshear alert (compact) ─────────────────────────────────────────
    const lv     = WS_LEVEL[e.lvl] || WS_LEVEL.adv;
    const sevCls = e.lvl === 'mba' ? ' ws-log-alarm' : e.lvl === 'wsa' ? ' ws-log-warning' : ' ws-log-monitor';
    const trend  = e.dir === 'loss' ? '▼' : '▲';
    const where  = e.kind === 'band' ? `@${e.b}ft` : `${(e.L / 1000).toFixed(1)}km`;
    const dep = e.ph === 'dep';
    const compact = `${e._time} ${lv.short} ${e.rwy}${dep ? ' dep' : ''} ${e.delta_kt}kt${trend} ${where} ${e.cs || e.icao}`;
    const how = dep ? 'climb-out compared with the earlier landings and departures'
              : e.kind === 'band' ? 'change against the earlier landings and departures' : 'headwind ramp along the path';
    const tip = `${e._time} UTC  ·  RWY ${e.rwy}${dep ? ' departure' : ''}  ·  ${lv.name}\n${wsEventText(e, true)}\n(${how})\n${e.cs || e.icao}${e.type ? '  ' + e.type : ''}`;

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
 * Deduplicates by icao + time using a persistent Set that survives log
 * clears — this prevents cleared GA entries from bouncing back on the next
 * poll cycle (the server keeps returning the same events from RAM).
 * GA events are always logged regardless of whether windshear detection
 * is enabled.
 */
const wsGaSeenKeys   = new Set();          // persists across Clear button presses

function addGaToWsLog(events) {
  if (!events || events.length === 0) return;
  for (const ev of events) {
    if (ev.ts < Date.now() / 1000 - 86400) continue;   // older than the 24 h log
    const key = `ga:${ev.icao}:${Math.round(ev.ts)}`;
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

// Clear button — hides the entries so far (the server keeps its log)
document.getElementById('ws-log-clear')?.addEventListener('click', () => {
  wsLogClearedAt = Date.now() / 1000;
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
let barbHwMode       = 'off';  // cycle 'off' → 'hw' → 'xw': which component annotation is active
let barbHiResActive  = false;  // toggle: use Hi-resolution buffer instead of Lo for barb display
let barbDclActive    = false;  // toggle: split component/raw labels above+below barb for readability
let barbValActive    = localStorage.getItem('ms_ws_barb_val') !== 'false'; // show dir/spd value labels (default on, persisted)
let trkActive          = localStorage.getItem('ms_ws_trk') !== 'false'; // trail visible by default
let profileZoomActive  = false;  // toggle: zoom ILS profile to PROFILE_ZOOM_NM (7.5 NM) half-range

// ── Wind Rose state ───────────────────────────────────────────────────────────
const WINDROSE_ALT_MAX       = 2_000;              // ft — ceiling for MODE-S wind samples
const WINDROSE_MAX_AGE_MS    = 30 * 60 * 1000;     // 30-minute window for main M-S arrow
const WINDROSE_HIST_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6-hour buffer for Hist trend arrows

let windroseEnabled      = true;   // shown by default
let wrView               = localStorage.getItem('ms_ws_wr_view') === 'cond' ? 'cond' : 'rose'; // 'rose' | 'cond'
const WR_COND_RANGES     = [3, 6, 12, 24];   // Cond chart range options (h), cycled by the range button
let wrCondHours          = WR_COND_RANGES.includes(Number(localStorage.getItem('ms_ws_wr_cond_h')))
                           ? Number(localStorage.getItem('ms_ws_wr_cond_h')) : 3;    // Cond chart range
let wrCondEntries        = [];     // landings with a conditions index (last 6 h), newest first
let wrCondFetchedMs      = 0;
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
  sizeWindroseCanvas();
  if (wrView === 'cond') { drawCondChart(); return; }

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

// ── Approach-conditions chart (Windrose panel, Cond view) ─────────────────────
const COND_CLASS_COLORS_DARK  = { N: '#e2e8f0', R: '#a78bfa', T: '#22d3ee', W: '#fbbf24', B: '#f472b6', '?': '#94a3b8' };
const COND_CLASS_COLORS_LIGHT = { N: '#334155', R: '#7c3aed', T: '#0891b2', W: '#b45309', B: '#db2777', '?': '#64748b' };

/**
 * Canvas size of the Windrose panel: 265 × 265 for the wind rose; in the
 * Cond view the panel widens to the width of the map controls bar above it
 * (left edge at the "N ILS corridor" counter).  Small width changes of the
 * bar (counter digits) are ignored so the chart does not jitter.
 */
const WR_ROSE_SIZE = 265;
function sizeWindroseCanvas() {
  const canvas = document.getElementById('ws-windrose-canvas');
  if (!canvas) return;
  let w = WR_ROSE_SIZE;
  if (wrView === 'cond') {
    const ctrl = document.querySelector('.ws-map-controls');
    // panel = canvas + 2 × 5 px padding + 2 × 1 px border
    if (ctrl && ctrl.offsetWidth) w = Math.max(WR_ROSE_SIZE, ctrl.offsetWidth - 12);
    if (Math.abs(canvas.width - w) <= 12 && canvas.width > WR_ROSE_SIZE) return;
  }
  if (canvas.width !== w)            canvas.width  = w;
  if (canvas.height !== WR_ROSE_SIZE) canvas.height = WR_ROSE_SIZE;
}
window.addEventListener('resize', () => { if (windroseEnabled) drawWindrose(); });

const wrRangeLabel = h => (h === 24 ? '1d' : `${h}h`);

async function fetchCondData() {
  try {
    const r = await fetch(`/api/windshear/approach-history?window=${wrCondHours * 3600}`);
    if (!r.ok) return;
    const rows = await r.json();
    wrCondEntries   = rows.filter(e => e.cond && e.cond.idx != null);
    wrCondFetchedMs = Date.now();
    if (windroseEnabled && wrView === 'cond') drawWindrose();
  } catch (_) { /* silent */ }
}

function _median(v) {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Cond view of the Windrose panel: approach-conditions index of each landing
 * over the last 3 h / 6 h / 12 h / 1 d (dot per landing, coloured by aircraft class) with a
 * running median line (±30 min, ≥ 3 landings) over faint level bands.
 */
function drawCondChart() {
  const canvas  = document.getElementById('ws-windrose-canvas');
  const readout = document.getElementById('ws-windrose-readout');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const CT    = wsCanvasTheme();
  const light = document.documentElement.dataset.theme === 'light';
  const CLS_COL = light ? COND_CLASS_COLORS_LIGHT : COND_CLASS_COLORS_DARK;
  const nowMs = Date.now();
  const spanMs = wrCondHours * 3_600_000;
  const t0 = nowMs - spanMs;
  const L = 24, R = 8, T = 22, B = 18;          // plot margins
  const PW = W - L - R, PH = H - T - B;
  const xOf = ms  => L + (ms - t0) / spanMs * PW;
  const yOf = idx => T + PH - Math.max(0, Math.min(10, idx)) / 10 * PH;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = CT.roseBg;
  ctx.fillRect(0, 0, W, H);

  // Level bands (0–2 smooth … 8–10 very rough)
  for (let l = 0; l < 5; l++) {
    ctx.globalAlpha = light ? 0.13 : 0.09;
    ctx.fillStyle = COND_LVL_COLORS[l];
    ctx.fillRect(L, yOf((l + 1) * 2), PW, yOf(l * 2) - yOf((l + 1) * 2));
  }
  ctx.globalAlpha = 1;

  // Axes, y labels, hourly x ticks
  ctx.strokeStyle = CT.roseRing;
  ctx.lineWidth = 1;
  ctx.strokeRect(L + 0.5, T + 0.5, PW, PH);
  ctx.font = '9px "Courier New",monospace';
  ctx.fillStyle = CT.roseLabel;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let v = 0; v <= 10; v += 2) ctx.fillText(String(v), L - 4, yOf(v));
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const tickH   = wrCondHours <= 6 ? 1 : wrCondHours <= 12 ? 2 : 3;   // hours between x labels
  const tickMs  = tickH * 3_600_000;
  const firstHour = Math.ceil(t0 / tickMs) * tickMs;
  for (let h = firstHour; h <= nowMs; h += tickMs) {
    const x = xOf(h);
    ctx.strokeStyle = CT.roseOuter;
    ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + PH); ctx.stroke();
    ctx.fillText(String(new Date(h).getUTCHours()).padStart(2, '0') + 'Z', x, T + PH + 4);
  }

  // Title + range
  ctx.font = '10px "Courier New",monospace';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';  ctx.fillStyle = CT.roseLabel;
  ctx.fillText('Approach conditions', 5, 5);
  ctx.textAlign = 'right';
  ctx.fillText(wrRangeLabel(wrCondHours), W - 5, 5);

  const pts = wrCondEntries
    .filter(e => e.ts * 1000 >= t0)
    .map(e => ({ ms: e.ts * 1000, idx: e.cond.idx, e }))
    .sort((a, b) => a.ms - b.ms);

  // Running median (±30 min window, ≥ 3 landings), every 5 min
  ctx.strokeStyle = '#10b981';
  ctx.lineWidth = 2;
  ctx.beginPath();
  let pen = false;
  for (let t = t0; t <= nowMs; t += 300_000) {
    const win = pts.filter(p => Math.abs(p.ms - t) <= 1_800_000).map(p => p.idx);
    if (win.length < 3) { pen = false; continue; }
    const m = _median(win);
    if (!pen) { ctx.moveTo(xOf(t), yOf(m)); pen = true; } else ctx.lineTo(xOf(t), yOf(m));
  }
  ctx.stroke();

  // Landing dots (hover tooltip reuses the Hist dot tooltip)
  wrHistDots = [];
  for (const p of pts) {
    const x = xOf(p.ms), y = yOf(p.idx);
    const col = CLS_COL[p.e.cond.cls] || CLS_COL['?'];
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
    const lbl = `${p.e.time_utc} ${p.e.callsign || p.e.icao} ${p.e.aircraft_type || ''} ` +
                `${p.e.runway || ''}: ${p.idx.toFixed(1)} ${p.e.cond.lbl}`;
    wrHistDots.push({ x, y, dotR: 3, label: lbl, color: col });
  }
  if (!pts.length) {
    ctx.fillStyle = CT.noTraffic;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(wrCondFetchedMs ? 'No scored landings yet' : 'Loading…', L + PW / 2, T + PH / 2);
  }

  // ── Readout ────────────────────────────────────────────────────────────────
  if (!readout) return;
  const lastH = pts.filter(p => nowMs - p.ms <= 3_600_000).map(p => p.idx);
  const mLast = _median(lastH);
  const mAll  = _median(pts.map(p => p.idx));
  const worst = pts.reduce((a, p) => (!a || p.idx > a.idx) ? p : a, null);
  const lvlName = v => ['Smooth', 'Light', 'Choppy', 'Rough', 'Very rough'][_condLvl(v)];
  const line1 = mLast != null
    ? `Last 1h: <span style="color:${_condTextColor(mLast)}">${lvlName(mLast)} ${mLast.toFixed(1)}</span> (${lastH.length} ldg)`
    : 'Last 1h: no scored landings';
  const line2 = mAll != null
    ? `${wrRangeLabel(wrCondHours)} median ${mAll.toFixed(1)} · max ${worst.idx.toFixed(1)} ${worst.e.callsign || ''}`
    : '';
  const legend = ['N', 'R', 'T', 'W']
    .map(k => `<span style="color:${CLS_COL[k]}">●${k}</span>`).join(' ');
  const met = pts.length && pts[pts.length - 1].e.cond.metar ? ` · ${pts[pts.length - 1].e.cond.metar}` : '';
  readout.innerHTML = `${line1}<br>${line2}<br><span class="ws-cond-legend">${legend}${met}</span>`;
}

function _syncWrViewBtns() {
  document.querySelectorAll('.ws-wr-view-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === wrView));
  const histBtn  = document.getElementById('ws-windrose-hist-btn');
  const histBdg  = document.getElementById('ws-windrose-hist-badge');
  const rangeBtn = document.getElementById('ws-wr-range-btn');
  if (histBtn)  histBtn.style.display  = wrView === 'cond' ? 'none' : '';
  if (histBdg)  histBdg.style.display  = wrView === 'cond' ? 'none' : '';
  if (rangeBtn) {
    rangeBtn.style.display = wrView === 'cond' ? '' : 'none';
    rangeBtn.textContent   = wrRangeLabel(wrCondHours);
  }
}
document.querySelectorAll('.ws-wr-view-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    wrView = btn.dataset.view;
    localStorage.setItem('ms_ws_wr_view', wrView);
    _syncWrViewBtns();
    if (wrView === 'cond') fetchCondData();
    drawWindrose();
  });
});
const _wrRangeBtn = document.getElementById('ws-wr-range-btn');
if (_wrRangeBtn) {
  _wrRangeBtn.addEventListener('click', () => {
    wrCondHours = WR_COND_RANGES[(WR_COND_RANGES.indexOf(wrCondHours) + 1) % WR_COND_RANGES.length];
    localStorage.setItem('ms_ws_wr_cond_h', String(wrCondHours));
    _syncWrViewBtns();
    drawWindrose();
    fetchCondData();          // the request window follows the range
  });
}
_syncWrViewBtns();

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

    // ── Barbs and NONE markers from the server (from 2026-10-24) ───────────
    // The tracker collects them with the same gates as below for every
    // aircraft, also while no page is open, so a newly opened page shows the
    // whole approach so far.  The local accumulation below is kept only as a
    // fallback for a server without these fields.
    let serverBarbs = false;
    for (const ac of aircraft) {
      if (!Array.isArray(ac.barbs)) continue;
      serverBarbs = true;
      const conv = r => ({ dist_nm: r[0], alt_ft: r[1], wind_spd: r[2], wind_dir: r[3], src: r[4] });
      if (ac.barbs.length)              wsWindHistory[ac.icao]   = ac.barbs.map(conv);
      if ((ac.barbs_hi  || []).length)  wsWindHiHistory[ac.icao] = ac.barbs_hi.map(conv);
      if ((ac.none_hist || []).length)  wsNoneHistory[ac.icao]   =
        ac.none_hist.map(r => ({ dist_nm: r[0], alt_ft: r[1], reason: r[2], ts: r[3] * 1000 }));
      if ((ac.pre_hist  || []).length)  wsPreCorridorHistory[ac.icao] =
        ac.pre_hist.map(r => ({ dist_nm: r[0], alt_ft: r[1], reason: 'qc', ts: r[2] * 1000 }));
    }

    if (!serverBarbs) {
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
    // ── Wind history (Lo): accumulate for corridor aircraft with wind data ─
    for (const ac of corridor) {
      if (ac.dist_thr_nm == null || ac.best_wind_spd == null || ac.best_wind_dir == null) continue;
      if (ac.meteo_source === 'NONE') continue;   // skip stale values from grey aircraft
      if (ac.wind_stale) continue;                // wind from older radar replies — measured higher up
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
      if (ac.wind_stale) continue;                // wind from older radar replies — measured higher up
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
    }   // end of the local fallback accumulation

    // Windshear alerts of the server's detection (collector/shear.py)
    lastShearEvents = Array.isArray(data) ? [] : (data.ws_events || []).map(mapWsEvent);
    wsServerLog     = Array.isArray(data) ? [] : (data.ws_log || []);
    renderEngineStatus(Array.isArray(data) ? null : data.ws_engine);

    // Auto-barb: update selection before rendering so strips + canvas are in sync
    runAutoBarbSelection(corridor, aircraft);

    renderStrips(aircraft, lastShearEvents);
    updateMapMarkers(aircraft);
    drawIlsProfile(corridor, lastShearEvents);
    updateAlertBanner(lastShearEvents);
    updateSqkAlarm(aircraft);
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
    // Turning barbs off — also cancel auto mode, HW/XW annotation and Hi-res mode
    barbSelectedIcao = null;
    barbAutoActive   = false;
    barbAutoTarget   = null;
    barbHwMode       = 'off';
    barbHiResActive  = false;
    barbDclActive    = false;
    document.getElementById('ws-barb-auto-btn').classList.remove('active');
    const _hwBtn = document.getElementById('ws-barb-hw-btn');
    _hwBtn.classList.remove('active', 'ws-hw-xw-mode');
    _hwBtn.textContent = 'HW';
    _hwBtn.classList.add('ws-barb-hw-off');
    document.getElementById('ws-barb-hi-btn').classList.remove('active');
    document.getElementById('ws-barb-hi-btn').classList.add('ws-barb-hi-off');
    document.getElementById('ws-barb-dcl-btn').classList.remove('active');
    document.getElementById('ws-barb-dcl-btn').classList.add('ws-barb-dcl-off');
    // Val keeps its remembered state — just greyed out while barbs are off
    document.getElementById('ws-barb-val-btn').classList.add('ws-barb-val-off');
  } else {
    document.getElementById('ws-barb-hw-btn').classList.remove('ws-barb-hw-off');
    document.getElementById('ws-barb-hi-btn').classList.remove('ws-barb-hi-off');
    document.getElementById('ws-barb-val-btn').classList.remove('ws-barb-val-off');
    // Dcl stays greyed until HW/XW mode is active (and Val is on)
  }
  drawIlsProfile(lastAircraft.filter(ac => ac.in_corridor), lastShearEvents);
  renderStrips(lastAircraft, lastShearEvents);
});

// ── HW/XW component annotation — cycling toggle ──────────────────────────────
// Cycles: off → HW (headwind/tailwind) → XW (crosswind) → off.
// Button label and colour update to reflect the active mode.
// Dcl becomes available as soon as any component mode is active.
document.getElementById('ws-barb-hw-btn').addEventListener('click', () => {
  if (!barbLayerActive) return;   // button is visually disabled when barbs are off
  // Advance cycle
  if      (barbHwMode === 'off') barbHwMode = 'hw';
  else if (barbHwMode === 'hw')  barbHwMode = 'xw';
  else                           barbHwMode = 'off';

  const btn = document.getElementById('ws-barb-hw-btn');
  btn.textContent = barbHwMode === 'xw' ? 'XW' : 'HW';
  btn.classList.toggle('active',        barbHwMode !== 'off');
  btn.classList.toggle('ws-hw-xw-mode', barbHwMode === 'xw');   // orange tint for XW

  // Dcl available when any component mode is active
  if (barbHwMode === 'off') barbDclActive = false;
  updateDclButton();
  drawIlsProfile(lastAircraft.filter(ac => ac.in_corridor), lastShearEvents);
});

// ── Dcl (declutter) label placement toggle ────────────────────────────────────
// Splits component value and raw wind labels to opposite sides of each barb.
// Works for both HW and XW modes. Only active when a component mode is on.
document.getElementById('ws-barb-dcl-btn').addEventListener('click', () => {
  if (!barbLayerActive || barbHwMode === 'off' || !barbValActive) return;
  barbDclActive = !barbDclActive;
  document.getElementById('ws-barb-dcl-btn').classList.toggle('active', barbDclActive);
  drawIlsProfile(lastAircraft.filter(ac => ac.in_corridor), lastShearEvents);
});

// Dcl is only meaningful when a component mode is on AND value labels are shown
// (with values off there is only one label per barb — nothing to split).
function updateDclButton() {
  const dclBtn = document.getElementById('ws-barb-dcl-btn');
  const avail  = barbLayerActive && barbHwMode !== 'off' && barbValActive;
  dclBtn.classList.toggle('ws-barb-dcl-off', !avail);
  dclBtn.classList.toggle('active', avail && barbDclActive);
}

// ── Val (value labels) toggle ────────────────────────────────────────────────
// Shows or hides the dir/spd labels next to each barb. With HW/XW active and
// Val off, only the component value is drawn. Persisted to localStorage.
document.getElementById('ws-barb-val-btn').addEventListener('click', () => {
  if (!barbLayerActive) return;   // button is visually disabled when barbs are off
  barbValActive = !barbValActive;
  localStorage.setItem('ms_ws_barb_val', barbValActive);
  document.getElementById('ws-barb-val-btn').classList.toggle('active', barbValActive);
  updateDclButton();
  drawIlsProfile(lastAircraft.filter(ac => ac.in_corridor), lastShearEvents);
});
// Restore saved Val state on page load (greyed until Barbs is switched on)
document.getElementById('ws-barb-val-btn').classList.toggle('active', barbValActive);

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
    // Enabling barbs via Auto must also un-grey the dependent segments
    document.getElementById('ws-barb-hw-btn').classList.remove('ws-barb-hw-off');
    document.getElementById('ws-barb-hi-btn').classList.remove('ws-barb-hi-off');
    document.getElementById('ws-barb-val-btn').classList.remove('ws-barb-val-off');
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
let approachHistoryMode    = 'hw';    // 'wind' | 'hw' | 'xw' | 'hwxw' | 'cond' | 'ws'
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

/** Total column count: 5 fixed cols (UTC/CS/Reg/Type/Rwy) + band cols
 *  (or the 9 approach-conditions columns in 'cond' mode, 7 windshear-report
 *  columns in 'ws' mode). */
function aphColspan() {
  return 5 + (approachHistoryMode === 'cond' ? 9 : approachHistoryMode === 'ws' ? 7 : aphBands().length);
}
/** Views with their own fixed column set (no Lo / Hi bands). */
const aphFixedMode = () => approachHistoryMode === 'cond' || approachHistoryMode === 'ws';

/** Rebuild the <thead> row to match the current Lo/Hi band selection. */
function renderApproachHistoryHeader() {
  const thead = document.getElementById('ws-aphist-thead');
  if (!thead) return;
  const bandThs = approachHistoryMode === 'cond'
    ? [
        ['Index', 'Approach-conditions index 0–10 (provisional) and level'],
        ['Hi',    'Segment index 3000–1000 ft MSL'],
        ['Lo',    'Segment index 1000–200 ft MSL'],
        ['Bank°', 'Bank-angle fluctuation (°), hi / lo segment'],
        ['IAS',   'IAS fluctuation (kt), hi / lo segment'],
        ['VS',    'Vertical-rate fluctuation (ft/min), hi / lo segment'],
        ['Crab°', 'Crab-angle (crosswind) variation (°), hi / lo segment'],
        ['Crab',  'Mean crab angle (°): + nose right of track = wind from the right'],
        ['METAR', 'METAR surface wind at landing time'],
      ].map(([t, tip]) => `<th class="ws-aphist-th" title="${tip}">${t}</th>`).join('')
    : approachHistoryMode === 'ws'
    ? [
        ['Level', 'Windshear report of the landing: ADV advisory ≥ 10 kt · WSA windshear alert ≥ 15 kt · MBA microburst alert ≥ 30 kt loss (1-km equivalent, below 1600 ft or within 5 NM)'],
        ['Loss',  'Strongest headwind loss along the path: kt over km (hover for the 1-km equivalent and heights)'],
        ['Gain',  'Strongest headwind gain along the path: kt over km'],
        ['F 1km', 'Horizontal F-factor over 1 km (headwind loss rate / g; the downdraft part cannot be seen)'],
        ['Band Δ','Largest change of the headwind in a 200-ft band (400–1800 ft) against all landings and departures of the previous 45 min (their wind vectors, any runway)'],
        ['Low',   'Lowest height (ft MSL) the receiver followed the aircraft'],
        ['n',     'BDS 5,0 replies used (and their noise, kt)'],
      ].map(([t, tip]) => `<th class="ws-aphist-th" title="${tip}">${t}</th>`).join('')
    : aphBands()
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
  // Lo/Hi only selects wind-band columns — not used by the Cond view
  const hiBtn = document.getElementById('ws-aphist-hi-btn');
  if (hiBtn) hiBtn.disabled = aphFixedMode();
  // Cond / WS views have their own fixed column set — let the panel size to it (as Hi does)
  document.getElementById('ws-aphist-panel')
    .classList.toggle('ws-aphist-hi', aphHistHiMode || aphFixedMode());
  renderApproachHistoryHeader();
  if (approachHistoryEnabled) fetchApproachHistory();
});

document.getElementById('ws-aphist-hi-btn').addEventListener('click', () => {
  aphHistHiMode = !aphHistHiMode;
  const btn   = document.getElementById('ws-aphist-hi-btn');
  const panel = document.getElementById('ws-aphist-panel');
  btn.textContent = aphHistHiMode ? 'Hi' : 'Lo';
  btn.classList.toggle('active', aphHistHiMode);
  panel.classList.toggle('ws-aphist-hi', aphHistHiMode || aphFixedMode());
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
 *   'xw'    — "+8"/"-3"  crosswind component, colour-coded; + = from right, - = from left
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
  // Same sign format as the ILS profile XW labels: + from right, - from left
  return `<span class="${cls}">${xw > 0 ? '+' : ''}${xw}</span>`;
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

// ── Approach conditions (provisional index, server: collector/approach_cond.py) ──
const COND_LVL_COLORS = ['#34d399', '#a3e635', '#facc15', '#fb923c', '#f87171'];
const COND_LVL_TEXT_LIGHT = ['#047857', '#4d7c0f', '#a16207', '#c2410c', '#b91c1c'];  // text on light theme
const COND_CLASS_NAME = { T: 'turboprop', B: 'business jet', R: 'regional jet',
                          N: 'narrowbody', W: 'widebody', '?': 'unknown type' };

function _condLvl(idx) {
  return idx == null ? null : idx < 2 ? 0 : idx < 4 ? 1 : idx < 6 ? 2 : idx < 8 ? 3 : 4;
}
function _condColor(idx) {
  const l = _condLvl(idx);
  return l == null ? null : COND_LVL_COLORS[l];
}
/** Text colour for an index value (darker shades on the light theme). */
function _condTextColor(idx) {
  const l = _condLvl(idx);
  if (l == null) return null;
  return document.documentElement.dataset.theme === 'light' ? COND_LVL_TEXT_LIGHT[l] : COND_LVL_COLORS[l];
}
function _condIdxHtml(idx) {
  if (idx == null) return '<span class="ws-aphist-nil">—</span>';
  return `<span style="color:${_condTextColor(idx)};font-weight:600">${idx.toFixed(1)}</span>`;
}
/** "hi / lo" pair of one component value. */
function _condPair(c, key, dec) {
  const f = seg => (c[seg] && c[seg][key] != null) ? Number(c[seg][key]).toFixed(dec) : '–';
  if (!c.hi && !c.lo) return '—';
  return `${f('hi')}<span class="ws-aphist-nil"> / </span>${f('lo')}`;
}
/** Multi-line tooltip for one landing's conditions. */
function _condTitle(c, rough) {
  if (!c || c.idx == null) return '';
  const seg = (name, lbl) => {
    const s = c[name];
    if (!s) return `${lbl}: no data`;
    const p = [];
    if (s.roll != null) p.push(`bank ${s.roll}°`);
    if (s.ias  != null) p.push(`IAS ${s.ias} kt`);
    if (s.vr   != null) p.push(`VS ${s.vr} fpm`);
    if (s.crab != null) p.push(`crab sd ${s.crab}°`);
    const r = rough && rough[name] ? rough[name] : {};
    const extra = r.r5 ? `, ${r.r5}× bank > 5°` : '';
    return `${lbl}: ${s.idx.toFixed(1)}  (${p.join(', ')}; ${s.n} replies${extra})`;
  };
  return [
    `Approach conditions ${c.idx.toFixed(1)} – ${c.lbl}  (${COND_CLASS_NAME[c.cls] || c.cls}` +
      (c.raw != null && c.raw !== c.idx ? `, before class factor ${c.raw.toFixed(1)}` : '') + ')',
    seg('hi', '3000–1000 ft'),
    seg('lo', '1000–200 ft'),
    c.metar ? `METAR ${c.metar}` : '',
    'Provisional index — scale will be re-tuned',
  ].filter(Boolean).join('\n');
}
function formatCondCells(e) {
  const c = e.cond;
  if (!c || c.idx == null) {
    const met = c && c.metar ? c.metar : '—';
    return '<td class="ws-aphist-cell ws-aphist-nil">—</td>'.repeat(8) +
           `<td class="ws-aphist-cell ws-aphist-nil">${met}</td>`;
  }
  const crabMean = seg => (e.rough && e.rough[seg] && e.rough[seg].cm != null)
    ? (e.rough[seg].cm > 0 ? '+' : '') + Math.round(e.rough[seg].cm) : '–';
  return `<td class="ws-aphist-cell ws-cond-idxcell"><span class="ws-cond-badge" style="background:${_condColor(c.idx)}">${c.idx.toFixed(1)}</span>` +
           `<span class="ws-cond-lbl" style="color:${_condTextColor(c.idx)}">${c.lbl === 'Very rough' ? 'V.rough' : c.lbl}</span></td>` +
    `<td class="ws-aphist-cell">${_condIdxHtml(c.hi ? c.hi.idx : null)}</td>` +
    `<td class="ws-aphist-cell">${_condIdxHtml(c.lo ? c.lo.idx : null)}</td>` +
    `<td class="ws-aphist-cell">${_condPair(c, 'roll', 1)}</td>` +
    `<td class="ws-aphist-cell">${_condPair(c, 'ias', 1)}</td>` +
    `<td class="ws-aphist-cell">${_condPair(c, 'vr', 0)}</td>` +
    `<td class="ws-aphist-cell">${_condPair(c, 'crab', 1)}</td>` +
    `<td class="ws-aphist-cell">${crabMean('hi')}<span class="ws-aphist-nil"> / </span>${crabMean('lo')}</td>` +
    `<td class="ws-aphist-cell ws-aphist-type">${c.metar || '—'}</td>`;
}

// ── Windshear report columns ('ws' mode) ─────────────────────────────────────
const WS_LV_COLOR = { adv: '#3b82f6', wsa: '#d97706', mba: '#ef4444' };
function _wsLvOfSc(sc, loss) {
  if (sc == null) return null;
  if (loss && sc >= 30) return 'mba';
  return sc >= 15 ? 'wsa' : sc >= 10 ? 'adv' : null;
}
function _wsCell(html, lvl) {
  const c = lvl ? ` style="color:${WS_LV_COLOR[lvl]};font-weight:600"` : '';
  return `<td class="ws-aphist-cell"${c}>${html}</td>`;
}
function _wsRamp(r, loss) {
  if (!r) return _wsCell('<span class="ws-aphist-nil">—</span>');
  return _wsCell(`${Math.abs(r.dv).toFixed(0)}<span class="ws-aphist-nil"> kt/</span>${(r.L / 1000).toFixed(1)}`,
                 r.zone ? _wsLvOfSc(r.sc, loss) : null);
}
function formatWsCells(e) {
  const w = e.shear;
  if (!w) return '<td class="ws-aphist-cell ws-aphist-nil">—</td>'.repeat(7);
  const lv = w.lvl && w.lvl !== 'none' ? w.lvl : null;
  const lvHtml = lv
    ? `<span class="ws-cond-badge" style="background:${WS_LV_COLOR[lv]}">${WS_LEVEL[lv].short}</span>`
    : '<span class="ws-aphist-nil">—</span>';
  const b = w.band;
  const bHtml = b ? `${b.a > 0 ? '+' : ''}${Math.round(b.a)}<span class="ws-aphist-nil"> @${b.b}</span>` : '<span class="ws-aphist-nil">—</span>';
  return `<td class="ws-aphist-cell">${lvHtml}</td>` +
    _wsRamp(w.loss, true) + _wsRamp(w.gain, false) +
    `<td class="ws-aphist-cell">${w.fh != null ? w.fh.toFixed(2) : '—'}</td>` +
    _wsCell(bHtml, b && b.lvl !== 'none' ? b.lvl : null) +
    `<td class="ws-aphist-cell">${w.a && w.a[1] != null ? w.a[1] : '—'}</td>` +
    `<td class="ws-aphist-cell">${w.n}${w.noise != null ? `<span class="ws-aphist-nil"> ±${w.noise.toFixed(1)}</span>` : ''}</td>`;
}
/** Multi-line tooltip for one landing's windshear report. */
function _wsTitle(w) {
  if (!w) return 'No windshear report (too few replies on final, or landed before 24 Oct 2026 without stored replies)';
  const ramp = (r, lbl) => r
    ? `${lbl}: ${Math.abs(r.dv).toFixed(0)} kt over ${(r.L / 1000).toFixed(1)} km, ${r.a1}→${r.a2} ft` +
      (r.d1 != null && r.d2 != null ? ` (${r.d1.toFixed(1)}→${r.d2.toFixed(1)} NM)` : '') +
      ` = ${r.sc} kt per 1 km${r.zone ? '' : ' (outside the low-level zone)'}`
    : `${lbl}: none above the noise`;
  const b = w.band;
  return [
    `Windshear report — ${w.lvl && w.lvl !== 'none' ? WS_LEVEL[w.lvl].name : 'no alert'}`,
    ramp(w.loss, 'Strongest loss'),
    ramp(w.gain, 'Strongest gain'),
    w.fh != null ? `Horizontal F-factor over 1 km: ${w.fh.toFixed(3)}${w.fh_a != null ? ` (at ${w.fh_a} ft)` : ''}` : '',
    b ? `Band ${b.b} ft: ${b.a > 0 ? '+' : ''}${b.a} kt against ${b.ref} kt in the last 45 min (${b.n} landings and departures)` : 'Band change: no reference flights',
    w.a ? `Followed ${w.a[0]}→${w.a[1]} ft, ${w.d && w.d[0] != null ? w.d[0].toFixed(1) : '?'}→${w.d && w.d[1] != null ? w.d[1].toFixed(1) : '?'} NM · ${w.n} replies, noise ±${w.noise != null ? w.noise : '?'} kt` : '',
    'Ramps: headwind = TAS − GS of each BDS 5,0 reply · band change: the heading-calibrated band winds against all flights of the last 45 min (detection v2)',
  ].filter(Boolean).join('\n');
}

// Registration filter (prefix, case and hyphen / space ignored).  The last
// fetched list is kept so typing re-filters at once without a new request.
let _aphLastEntries = null;
let _aphRegFilter   = '';
const _aphNormReg = s => (s || '').toUpperCase().replace(/[\s-]/g, '');

(function initAphRegFilter() {
  const inp = document.getElementById('ws-aphist-reg-filter');
  if (!inp) return;
  const apply = () => {
    _aphRegFilter = _aphNormReg(inp.value);
    inp.classList.toggle('ws-aphist-reg-active', !!_aphRegFilter);
    if (_aphLastEntries) renderApproachHistory(_aphLastEntries);
  };
  inp.addEventListener('input', apply);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Escape') { inp.value = ''; apply(); inp.blur(); }
  });
})();

function renderApproachHistory(entries) {
  const tbody = document.getElementById('ws-aphist-table-body');
  if (!tbody) return;
  _aphLastEntries = entries || [];
  const total = _aphLastEntries.length;
  if (_aphRegFilter) {
    entries = _aphLastEntries.filter(e => _aphNormReg(e.registration).startsWith(_aphRegFilter));
  }

  // Landing count for the selected window/date on the panel title line
  const countEl = document.getElementById('ws-aphist-count');
  if (countEl) {
    const n = entries ? entries.length : 0;
    countEl.textContent = _aphRegFilter
      ? `–  ${n} of ${total} landing${total === 1 ? '' : 's'}`
      : `–  ${n} landing${n === 1 ? '' : 's'}`;
  }
  if (!entries || entries.length === 0) {
    const msg = (_aphRegFilter && total > 0)
      ? 'No landings match the registration filter'
      : 'No approaches logged yet';
    tbody.innerHTML =
      `<tr><td colspan="${aphColspan()}" class="ws-aphist-empty">${msg}</td></tr>`;
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
    const condMode = approachHistoryMode === 'cond';
    const wsMode   = approachHistoryMode === 'ws';
    const bandCells = condMode
      ? formatCondCells(e)
      : wsMode ? formatWsCells(e)
      : bands
      .map(b => formatBandCell(e.bands ? e.bands[String(b)] : null, rwyHdg))
      .join('');
    const rowTitle = (condMode ? _condTitle(e.cond, e.rough) : wsMode ? _wsTitle(e.shear) : '').replace(/"/g, '&quot;');

    return `<tr${rowTitle ? ` title="${rowTitle}"` : ''}>
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
      // Position tooltip (position: fixed → viewport coordinates): right of the
      // cursor, or left of it when it would run past the right screen edge —
      // the panel sits at the right edge of the map
      const tipW = _wrHistTip.offsetWidth;
      let tipX = e.clientX + 12;
      if (tipX + tipW > window.innerWidth - 6) tipX = Math.max(6, e.clientX - 12 - tipW);
      const tipY = Math.max(4, e.clientY - 8);
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
// Approach-conditions chart data (only while the Cond view is shown)
fetchCondData();
setInterval(() => { if (windroseEnabled && wrView === 'cond') fetchCondData(); }, 60_000);
setInterval(fetchTodayStats,       5 * 60_000);  // today's stats refresh every 5 min

// ── Page Light / Dark theme (navbar button) ─────────────────────────────────
// Called by base.html right after the theme switch: the map style follows
// (Dark ↔ Grey, Black ↔ ATC, overlay level kept), and the ILS profile and the
// wind rose / conditions chart are redrawn at once instead of on their next
// data refresh.
window.onThemeChange = function () {
  const light = pageIsLight();
  const want = light ? ({ dark: 'grey', black: 'atc' })[currentTheme]
                     : ({ grey: 'dark', atc: 'black' })[currentTheme];
  if (want) {
    if (want in overlayLevelByTheme && currentTheme in overlayLevelByTheme)
      overlayLevelByTheme[want] = overlayLevelByTheme[currentTheme];
    applyTheme(want);
  }
  drawIlsProfile(lastAircraft.filter(ac => ac.in_corridor), lastShearEvents);
  drawWindrose();
};