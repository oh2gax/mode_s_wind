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
const PROFILE_MAX_NM = 15;
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
    trail:      light ? 'rgba(0,0,0,0.10)'      : 'rgba(255,255,255,0.12)',
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
  // 0 NM (threshold) → right edge, PROFILE_MAX_NM → left edge
  const distX = d => M.left + (1 - d / PROFILE_MAX_NM) * PW;
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
  // Distance grid lines (every 5 NM)
  for (let d = 0; d <= PROFILE_MAX_NM; d += 5) {
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
  const gsMaxDist = Math.min(PROFILE_MAX_NM, (PROFILE_MAX_FT - gsBaseline) / GS_FT_PER_NM);
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
      const label = `WS ${ev.delta_kt} kt`;
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
  for (let d = 0; d <= PROFILE_MAX_NM; d += 5) {
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
    ilsCtx.fillStyle  = CT.noTraffic;
    ilsCtx.font       = '12px system-ui, sans-serif';
    ilsCtx.textAlign  = 'center';
    ilsCtx.fillText('No approach traffic', M.left + PW / 2, M.top + PH / 2);
    return;
  }

  const selectedRwy = document.getElementById('ws-ils-rwy').value;

  for (const ac of aircraft) {
    if (!matchesRwyFilter(ac.approach_runway, selectedRwy)) continue;
    if (ac.dist_thr_nm == null) continue;

    const gs = computeGsStatus(ac);
    const color = GS_COLOR[gs] || GS_COLOR.FAR;

    // ── History trail ────────────────────────────────────────────────────────
    if (ac.history && ac.history.length > 1) {
      ilsCtx.beginPath();
      let first = true;
      for (const h of ac.history) {
        if (h.dist_thr > PROFILE_MAX_NM || h.altitude > PROFILE_MAX_FT) continue;
        const hx = distX(h.dist_thr);
        const hy = altY(h.altitude);
        if (first) { ilsCtx.moveTo(hx, hy); first = false; }
        else ilsCtx.lineTo(hx, hy);
      }
      ilsCtx.strokeStyle  = CT.trail;
      ilsCtx.lineWidth    = 1;
      ilsCtx.stroke();
    }

    // ── Current position dot ─────────────────────────────────────────────────
    if (ac.dist_thr_nm > PROFILE_MAX_NM || ac.altitude > PROFILE_MAX_FT) continue;

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
        if (obs.dist_nm == null || obs.dist_nm < 0 || obs.dist_nm > PROFILE_MAX_NM) continue;
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

    // ── NONE position markers: grey open circles for observations where wind
    //    computation was suspended (meteo_source === 'NONE').  These appear
    //    alongside regular wind barbs (or alone) so the user can see that the
    //    aircraft was still transmitting valid position data during grey periods.
    //    Useful for GPS-jamming detection: hollow circles confirm position data
    //    is arriving normally even while wind decoding is suspended.
    const noneObs = wsNoneHistory[barbSelectedIcao] || [];
    if (noneObs.length > 0) {
      ilsCtx.save();
      ilsCtx.strokeStyle = SRC_COLOR.NONE;   // #6b7280 — same grey as NONE aircraft icons
      ilsCtx.lineWidth   = 1.5;
      for (const obs of noneObs) {
        if (obs.dist_nm < 0 || obs.dist_nm > PROFILE_MAX_NM) continue;
        if (obs.alt_ft  < 0 || obs.alt_ft  > PROFILE_MAX_FT) continue;
        ilsCtx.beginPath();
        ilsCtx.arc(distX(obs.dist_nm), altY(obs.alt_ft), 3, 0, 2 * Math.PI);
        ilsCtx.stroke();
      }
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
let wsDetAlgo          = 'pair';   // active algorithm key
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

    if (pts.length < 3) continue;

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
  const MIN_POINTS  = 4;

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
    if (hist.length < 2) continue;

    // Take the oldest point within the lookback window as reference
    const window = hist.slice(-LOOKBACK);
    const ref    = window[0];
    if (ref.wind_spd == null || ref.wind_dir == null) continue;

    const refHw  = hwKt(ref.wind_spd, ref.wind_dir, rwyHdg);
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
 * Window: 45 seconds (oldest vs newest sample within the window).
 */
function detectKinematic(aircraft) {
  const events    = [];
  const WINDOW_MS = 45_000;   // 45-second look-back window

  for (const ac of aircraft) {
    if (!ac.in_corridor || !ac.approach_runway) continue;
    if (computeGsStatus(ac) !== 'ON') continue;

    const hist = wsKinHistory[ac.icao];
    if (!hist || hist.length < 2) continue;

    const nowMs = Date.now();
    // Filter to entries within the 45-second window
    const window = hist.filter(p => (nowMs - p.ts) <= WINDOW_MS);
    if (window.length < 2) continue;

    const oldest = window[0];
    const newest = window[window.length - 1];

    const diffOld = oldest.ias - oldest.gs;   // IAS−GS at start of window
    const diffNew = newest.ias - newest.gs;   // IAS−GS at end of window
    const delta   = Math.abs(diffNew - diffOld);

    if (delta < WS_MONITOR_KT) continue;

    // F-factor: (headwind rate of change in m/s²) / g — dimensionless performance hazard index
    const windowSecs = (newest.ts - oldest.ts) / 1000;
    const fFactor    = windowSecs > 1
      ? Math.round(((delta * 0.51444) / windowSecs / 9.81) * 100) / 100
      : null;

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
      alt_low:  Math.round(oldest.gs != null ? ac.altitude - 50 : ac.altitude),
      alt_high: Math.round(ac.altitude),
      hw_low:   Math.round(diffOld),   // repurposed: IAS−GS at window start
      hw_high:  Math.round(diffNew),   // repurposed: IAS−GS at window end
      delta_kt: Math.round(delta),
      f_factor: fFactor,
      severity: wsSeverity(delta),
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
    return `<span class="ws-alert-tag">${algoLbl} · RWY ${e.rwy} · ${e.delta_kt} kt  ${Math.round(e.alt_low / 100) * 100}–${Math.round(e.alt_high / 100) * 100} ft  ${acInfo}</span>`;
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
document.getElementById('ws-algo-select').addEventListener('change', e => {
  wsDetAlgo = e.target.value;
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

async function fetchWx() {
  try {
    const r = await fetch('/api/wx');
    if (!r.ok) return;
    const d = await r.json();

    const metarEl = document.getElementById('ws-metar-text');
    const tafEl   = document.getElementById('ws-taf-text');
    if (metarEl) metarEl.textContent = d.metar || '—';
    if (tafEl)   tafEl.textContent   = d.taf   || '—';

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
setInterval(fetchWx, 10 * 60 * 1000);

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
  if (windroseEnabled) drawWindrose();
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
      _time: new Date(now).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    });
  }

  // Trim to max
  if (wsLog.length > WS_LOG_MAX) wsLog.length = WS_LOG_MAX;
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

  el.innerHTML = wsLog.map(e => {
    // ── Go-around entry ──────────────────────────────────────────────────
    if (e._type === 'go_around') {
      return `<div class="ws-log-entry ws-log-ga">
  <div class="ws-log-entry-time">${e._time}</div>
  <div>
    <span class="ws-log-entry-rwy">RWY ${e.rwy}</span>
    <span class="ws-ga-label">✈ GO-AROUND</span>
    &nbsp;at ${e.alt_ft} ft &nbsp;·&nbsp; ${e._ordinal} this session
  </div>
  <div class="ws-log-entry-ac">${e.callsign || e.icao}</div>
</div>`;
    }
    // ── Windshear entry ───────────────────────────────────────────────────
    const sevCls  = e.severity === 'alarm'   ? ' ws-log-alarm'
                  : e.severity === 'warning' ? ' ws-log-warning'
                  : ' ws-log-monitor';
    const hw_low  = e.hw_low  != null ? Number(e.hw_low).toFixed(0)  : '?';
    const hw_high = e.hw_high != null ? Number(e.hw_high).toFixed(0) : '?';
    const trend   = e.hw_high > e.hw_low ? '▼ decr HW' : '▲ incr TW';
    const fTag    = (e.algo === 'kinematic' && e.f_factor != null)
      ? ` <span class="ws-log-ffactor" title="F-factor: performance-scaled hazard index">F=${e.f_factor.toFixed(2)}</span>`
      : '';

    // Algorithm badge
    const ALGO_LABELS = { pair:'Pair', gradient:'Gradient', energy:'Energy', rate:'Rate', baseline:'Baseline', kinematic:'Kinematic' };
    const algoLbl  = ALGO_LABELS[e.algo] || (e.algo || 'WS');
    const algoBadge = `<span class="ws-log-algo-badge ws-algo-${e.algo || 'pair'}">${algoLbl}</span>`;

    // Aircraft detail line — pairwise has two callsigns; single-aircraft has one
    let acLine;
    if (e.cs_low && e.cs_high) {
      acLine = `${e.cs_low} (${hw_low} kt) ↕ ${e.cs_high} (${hw_high} kt)`;
    } else if (e.cs) {
      const detail = e.algo === 'energy'
        ? `GS ${hw_high}→${hw_low} kt`
        : `HW ${hw_high}→${hw_low} kt`;
      acLine = `${e.cs}  ${detail}`;
    } else {
      acLine = `${hw_low} kt → ${hw_high} kt`;
    }

    return `<div class="ws-log-entry${sevCls}">
  <div class="ws-log-entry-time">${e._time}</div>
  <div>
    <span class="ws-log-entry-rwy">RWY ${e.rwy}</span>
    ${algoBadge}
    <span class="ws-log-entry-delta">${e.delta_kt} kt</span>${fTag}
    &nbsp;${trend}&nbsp;·&nbsp;${Math.round(e.alt_low / 100) * 100}–${Math.round(e.alt_high / 100) * 100} ft
  </div>
  <div class="ws-log-entry-ac">${acLine}</div>
</div>`;
  }).join('');
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
      _time:    new Date(ev.ts * 1000).toLocaleTimeString('en-GB',
                  { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
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
const wsWindHistory   = {};     // icao → [{dist_nm, alt_ft, wind_spd, wind_dir}, …]  Lo buffer
const wsWindHiHistory = {};     // icao → [{dist_nm, alt_ft, wind_spd, wind_dir}, …]  Hi buffer (research, display-only)
const wsNoneHistory   = {};     // icao → [{dist_nm, alt_ft}, …]  position-only buffer for NONE-state aircraft
let barbLayerActive  = false;  // toggle: show barb overlay on ILS canvas
let barbSelectedIcao = null;   // which aircraft's barbs are displayed (null = none)
let barbAutoActive   = false;  // auto-select mode: always show lowest approach aircraft
let barbAutoTarget   = null;   // icao currently held by auto mode (null = none yet)
let barbHwActive     = false;  // toggle: annotate each barb with headwind/tailwind value
let barbHiResActive  = false;  // toggle: use Hi-resolution buffer instead of Lo for barb display
let barbDclActive    = false;  // toggle: split HW/raw labels above+below barb for readability

// ── Wind Rose state ───────────────────────────────────────────────────────────
const WINDROSE_ALT_MAX    = 2_000;          // ft — ceiling for MODE-S wind samples
const WINDROSE_MAX_AGE_MS = 30 * 60 * 1000; // 30-minute rolling buffer

let windroseEnabled      = true;   // shown by default
let metarWind            = null;   // { dir, spd, variable } — updated by fetchWx
const recentLandingWinds = [];     // { dir, spd, alt, ts } — low-alt obs from departed aircraft
let prevLiveIcaos        = new Set(); // icao set from previous poll, used to detect departures

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
  const nowMs  = Date.now();
  const recent = recentLandingWinds.filter(o => (nowMs - o.ts) <= WINDROSE_MAX_AGE_MS);
  const modesW = vectorAvgWind(recent);
  if (modesW && modesW.spd > 0) {
    drawArrow(modesW.dir, modesW.spd, MODES_COL);
  }

  // ── Top-left legend dots ─────────────────────────────────────────────────────
  ctx.font = '10px "Courier New",monospace';
  ctx.textBaseline = 'top'; ctx.textAlign = 'left';
  ctx.fillStyle = METAR_COL;
  ctx.fillText('● METAR', 5, 4);
  ctx.fillStyle = modesW ? MODES_COL : CT.roseSpeed;
  ctx.fillText('● MODE-S', 5, 14);

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
        for (const obs of hist) {
          if (obs.alt_ft  <= WINDROSE_ALT_MAX &&
              obs.wind_spd != null && obs.wind_dir != null) {
            recentLandingWinds.push({
              dir: obs.wind_dir,
              spd: obs.wind_spd,
              alt: obs.alt_ft,
              ts:  nowMs,
            });
          }
        }
      }
    }
    prevLiveIcaos = liveIcaos;

    // Prune observations older than the 30-minute window
    const windroseCutoff = nowMs - WINDROSE_MAX_AGE_MS;
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
    for (const icao of Object.keys(wsNoneHistory)) {
      if (!liveIcaos.has(icao)) delete wsNoneHistory[icao];
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
    for (const ac of corridor) {
      if (ac.ias == null || ac.groundspeed == null) continue;
      if (!wsKinHistory[ac.icao]) wsKinHistory[ac.icao] = [];
      wsKinHistory[ac.icao].push({ ias: ac.ias, gs: ac.groundspeed, ts: nowMs });
      // 30-point rolling buffer (~90 s at 3 s polling); algorithm applies 45 s filter
      if (wsKinHistory[ac.icao].length > 30) wsKinHistory[ac.icao].shift();
    }

    // ── Wind history (Lo): accumulate for corridor aircraft with wind data ─
    for (const ac of corridor) {
      if (ac.dist_thr_nm == null || ac.best_wind_spd == null || ac.best_wind_dir == null) continue;
      if (ac.meteo_source === 'NONE') continue;   // skip stale values from grey aircraft
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
    for (const ac of corridor) {
      if (ac.meteo_source !== 'NONE') continue;
      if (ac.dist_thr_nm == null || ac.altitude == null) continue;
      if (!wsNoneHistory[ac.icao]) wsNoneHistory[ac.icao] = [];
      const noneHist = wsNoneHistory[ac.icao];
      const noneLast = noneHist[noneHist.length - 1];
      const noneAltMoved  = !noneLast || Math.abs(noneLast.alt_ft  - ac.altitude)    >= WS_WIND_MIN_ALT_GAP;
      const noneDistMoved = !noneLast || Math.abs(noneLast.dist_nm - ac.dist_thr_nm) >= WS_WIND_MIN_DIST_GAP;
      if (noneAltMoved || noneDistMoved) {
        noneHist.push({ dist_nm: ac.dist_thr_nm, alt_ft: ac.altitude });
        if (noneHist.length > WS_WIND_HIST_MAX) noneHist.shift();
      }
    }

    // Run windshear detection — apply confidence gate (requires N consecutive hits)
    lastShearEvents = applyConfidenceGate(detectWindshear(corridor));

    // Auto-barb: update selection before rendering so strips + canvas are in sync
    runAutoBarbSelection(corridor);

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
 */
function runAutoBarbSelection(corridor) {
  if (!barbLayerActive || !barbAutoActive) return;

  // Keep existing target if it is still on approach
  if (barbAutoTarget && corridor.some(ac => ac.icao === barbAutoTarget)) {
    barbSelectedIcao = barbAutoTarget;
    return;
  }

  // Target gone (staled out or left the corridor) — pick lowest
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
    runAutoBarbSelection(lastAircraft.filter(ac => ac.in_corridor));
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
let approachHistoryMode    = 'wind';   // 'wind' | 'hw'
const APPROACH_BANDS       = [1000, 1500, 2000, 2500, 3000];

document.getElementById('ws-aphist-btn').addEventListener('click', () => {
  approachHistoryEnabled = !approachHistoryEnabled;
  document.getElementById('ws-aphist-btn').classList.toggle('active', approachHistoryEnabled);
  document.getElementById('ws-aphist-panel').classList.toggle('ws-aphist-hidden', !approachHistoryEnabled);
  if (approachHistoryEnabled) fetchApproachHistory();
});

document.getElementById('ws-aphist-mode-btn').addEventListener('click', () => {
  approachHistoryMode = approachHistoryMode === 'wind' ? 'hw' : 'wind';
  document.getElementById('ws-aphist-mode-btn').textContent =
    approachHistoryMode === 'wind' ? 'Wind' : 'HW';
  if (approachHistoryEnabled) fetchApproachHistory();
});

document.getElementById('ws-aphist-clear-btn').addEventListener('click', async () => {
  try {
    await fetch('/api/windshear/approach-history/clear', { method: 'POST' });
  } catch (_) { /* silent */ }
  document.getElementById('ws-aphist-table-body').innerHTML =
    '<tr><td colspan="10" class="ws-aphist-empty">No approaches logged yet</td></tr>';
});

/**
 * Format one altitude-band cell.
 * In 'wind' mode: "270°/15"  (direction / speed kt)
 * In 'hw' mode:  "+12"  or "-5"  (headwind component, green/red/amber)
 */
function formatBandCell(band, rwyHdg) {
  if (!band) return '<td class="ws-aphist-cell ws-aphist-nil">—</td>';
  if (approachHistoryMode === 'hw') {
    const hw = (rwyHdg != null)
      ? Math.round(band.spd * Math.cos((band.dir - rwyHdg) * Math.PI / 180))
      : null;
    if (hw == null) return '<td class="ws-aphist-cell ws-aphist-nil">—</td>';
    const cls = hw >=  5 ? 'ws-aphist-hw-pos'
              : hw <= -5 ? 'ws-aphist-hw-neg'
              :             'ws-aphist-hw-zero';
    return `<td class="ws-aphist-cell ${cls}">${hw > 0 ? '+' : ''}${hw}</td>`;
  }
  // Wind mode: dir°/spd
  return `<td class="ws-aphist-cell">${band.dir}°/${band.spd}</td>`;
}

function renderApproachHistory(entries) {
  const tbody = document.getElementById('ws-aphist-table-body');
  if (!entries || entries.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="8" class="ws-aphist-empty">No approaches logged yet</td></tr>';
    return;
  }
  tbody.innerHTML = entries.map(e => {
    const rwyHdg   = e.rwy_heading;
    const bandCells = APPROACH_BANDS
      .map(b => formatBandCell(e.bands[String(b)], rwyHdg))
      .join('');
    return `<tr>
      <td class="ws-aphist-cell ws-aphist-time">${e.time_utc}</td>
      <td class="ws-aphist-cell ws-aphist-cs">${e.callsign}</td>
      <td class="ws-aphist-cell ws-aphist-reg">${e.registration || "—"}</td>
      <td class="ws-aphist-cell ws-aphist-type">${e.aircraft_type || "—"}</td>
      <td class="ws-aphist-cell ws-aphist-rwy">${e.runway}</td>
      ${bandCells}
    </tr>`;
  }).join('');
}

async function fetchApproachHistory() {
  if (!approachHistoryEnabled) return;
  try {
    const r = await fetch('/api/windshear/approach-history');
    if (!r.ok) return;
    renderApproachHistory(await r.json());
  } catch (_) { /* silent */ }
}

fetchApproachState();
fetchApproachHistory();
setInterval(fetchApproachState, 3_000);
setInterval(fetchApproachHistory, 15_000);
