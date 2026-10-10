/**
 * live_map.js — Real-time aircraft tracking map with meteo overlay.
 *
 * ATC-style display:
 *   • Small filled square at current position (coloured by meteo source)
 *   • Short speed-vector line pointing in track direction
 *   • ~1-minute trail of fading dots at past positions
 *   • Optional callsign labels (toggle)
 *
 * Meteo source colours:
 *   Blue   (#3b82f6) — BDS 4,4 MRAR direct
 *   Green  (#10b981) — Wind computed from BDS 5,0 + 6,0
 *   Amber  (#f59e0b) — BDS 4,5 MHR hazard report only
 *   Purple (#a855f7) — Radarcape JSON / MLAT
 *   Grey   (#6b7280) — No meteo data
 */

// ── Map init ──────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true }).setView([RECEIVER_LAT, RECEIVER_LON], 8);

// CARTO_API_KEY is injected server-side in base.html (from local api_keys.py);
// appended as a query param so raster tiles are served without the watermark.
const _cartoKeyQs = CARTO_API_KEY ? `?key=${encodeURIComponent(CARTO_API_KEY)}` : '';
const TILE_DARK  = `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png${_cartoKeyQs}`;
const TILE_LIGHT = `https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png${_cartoKeyQs}`;
const TILE_OPTS  = { attribution: '© OSM, © CARTO', subdomains: 'abcd', maxZoom: 18 };

let currentTile = L.tileLayer(
  document.documentElement.dataset.theme === 'light' ? TILE_LIGHT : TILE_DARK,
  TILE_OPTS
).addTo(map);

// Receiver marker
L.circleMarker([RECEIVER_LAT, RECEIVER_LON], {
  radius: 7, color: '#fff', fillColor: '#1d4ed8', fillOpacity: 1, weight: 2,
}).bindTooltip('Receiver (EFHK area)').addTo(map);

// ── State ─────────────────────────────────────────────────────────────────
const markers        = {};   // icao → L.Marker (aircraft symbol)
const trailLayers    = {};   // icao → L.LayerGroup (trail dots)
const trails         = {};   // icao → [[lat, lon], ...] position history
const labelMarkers   = {};   // icao → L.Marker (callsign label)
const windArrows     = {};   // icao → L.Polyline (wind direction arrow)
const aircraftData   = {};   // icao → latest data object
const callsignCache  = {};   // icao → best known callsign (never downgraded to null)
const windHistory    = {};   // icao → [{pressure, alt_ft, temp_c, wind_spd, wind_dir}, ...]
const dbSeeded       = new Set(); // ICAOs whose wind history has been pre-loaded from DB

let selectedIcao = null;

const MAX_TRAIL       = 20;   // position dots kept ≈ 60 s
const MAX_WIND_HIST   = 80;   // wind obs per aircraft (≈ climb/descent profile)

// Restore persisted UI prefs — default both toggles ON
// localStorage.getItem returns null when key is absent; null !== 'false' → true (default ON)
let meteoOnly   = localStorage.getItem('ms_meteoOnly')  !== 'false';
let showLabels  = localStorage.getItem('ms_showLabels') !== 'false';
let showTrack   = localStorage.getItem('ms_showTrack')  === 'true';   // default OFF
let labelMode   = localStorage.getItem('ms_labelMode')  || 'callsign';
let windDensity = parseInt(localStorage.getItem('ms_windDensity') || '2', 10);
// Vertical smoothing of the area temperature profile (0 = off, 1 = 3 layers, 2 = 5 layers)
let areaSmooth  = parseInt(localStorage.getItem('ms_areaSmooth') || '0', 10);
if (![0, 1, 2].includes(areaSmooth)) areaSmooth = 0;

let selectedTrackLayer = null;   // Leaflet polyline for selected aircraft's DB track
// Track of the selected aircraft: [[lat, lon, ts], …] — its stored positions
// of the current flight (fetched on selection) followed by live positions.
// Kept separate from windHistory (capped at MAX_WIND_HIST for the profile),
// and kept while the aircraft is briefly missing from the live data.
let selTrackPts  = [];
let selTrackIcao = null;          // aircraft whose stored track has been fetched
const MAX_TRACK_PTS = 4000;

// ── Source colours ────────────────────────────────────────────────────────
const SOURCE_COLOR = {
  'MRAR':     '#3b82f6',
  'COMPUTED': '#10b981',
  'MHR':      '#f59e0b',
  'JSON':     '#a855f7',
  'NONE':     '#6b7280',
};

function acColor(ac) {
  return SOURCE_COLOR[ac.meteo_source] ?? SOURCE_COLOR['NONE'];
}

function getLabelText(ac) {
  if (labelMode === 'icao') return ac.icao;
  return callsignCache[ac.icao] || ac.icao;
}

// ── Wind profile history (per aircraft) ───────────────────────────────────
// Accumulates wind observations as an aircraft climbs or descends so the
// mini Skew-T can show a full vertical wind profile, not just one barb.
function updateWindHistory(ac) {
  if (!ac.best_wind_spd || !ac.best_wind_dir || !ac.altitude) return;

  if (!windHistory[ac.icao]) windHistory[ac.icao] = [];
  const hist = windHistory[ac.icao];
  const last = hist[hist.length - 1];

  // Only record a new point when altitude changed by ≥ 400 ft so level
  // cruise doesn't fill the array with identical readings.
  if (last && Math.abs(last.alt_ft - ac.altitude) < 400) {
    // Still update the last entry's wind/temp in case it improved
    last.wind_spd = ac.best_wind_spd;
    last.wind_dir = ac.best_wind_dir;
    if (ac.best_temp     != null) last.temp_c  = ac.best_temp;
    // Always derive from altitude — best_pressure may be QNH, not static air pressure
    last.pressure = altToPressHPa(ac.altitude);
    return;
  }

  hist.push({
    alt_ft:   ac.altitude,
    pressure: altToPressHPa(ac.altitude),
    temp_c:   ac.best_temp,
    wind_spd: ac.best_wind_spd,
    wind_dir: ac.best_wind_dir,
  });

  if (hist.length > MAX_WIND_HIST) hist.shift();
}

// ── Mini sounding profile ─────────────────────────────────────────────────

let miniAcOverlay  = null; // {alt_ft, temp_c, color} when aircraft selected

// ── ISA helpers ───────────────────────────────────────────────────────────
function altToPressHPa(alt_ft) {
  const m = alt_ft * 0.3048;
  if (m <= 11000) return 1013.25 * Math.pow(1 - 0.0065 * m / 288.15, 5.2561);
  return 226.32 * Math.exp(-0.0001577 * (m - 11000));
}
function isaTempP(p_hPa) {
  // ISA temperature (°C) at a given pressure (hPa)
  if (p_hPa >= 226.32) return 288.15 * Math.pow(p_hPa / 1013.25, 0.19026) - 273.15;
  return -56.5;
}

// ── Mini Skew-T geometry ──────────────────────────────────────────────────
// Canvas sized to the right panel (resizeMiniCanvas).  Log-pressure Y, skewed temperature X.
const MSK = {
  W: 362, H: 346,
  ML: 30, MR: 112, MT: 14, MB: 22,
  TL: -40, TR: 40,   // temperature range °C at the bottom (skewed: −60 … −40 °C fit at 200–300 hPa)
  PT: 200, PB: 1050, // pressure range hPa
  SK: 0.38,          // skew factor (higher = more tilt)
};
MSK.PW = MSK.W - MSK.ML - MSK.MR;
MSK.PH = MSK.H - MSK.MT - MSK.MB;

// ── Responsive canvas sizing ───────────────────────────────────────────────
// Fills all available height in the right panel.  Called once on load and
// whenever the panel changes size (window resize / font-size change, etc).
function resizeMiniCanvas() {
  const canvas = document.getElementById('mini-sounding-canvas');
  if (!canvas) return;
  const wrap = canvas.parentElement;
  if (!wrap || wrap.clientWidth === 0) return;

  // Sum the heights of every sibling element (density row, ac-info line)
  let fixedH = 0;
  for (const child of wrap.children) {
    if (child !== canvas) fixedH += child.offsetHeight + 4; // 4 = flex gap
  }
  fixedH += 8; // wrap top + bottom padding (4px each)

  const w = Math.max(160, wrap.clientWidth  - 8);
  const h = Math.max(160, wrap.clientHeight - fixedH);

  if (canvas.width === w && canvas.height === h) return; // nothing changed

  canvas.width  = w;
  canvas.height = h;
  MSK.W  = w;
  MSK.H  = h;
  MSK.PW = w - MSK.ML - MSK.MR;
  MSK.PH = h - MSK.MT - MSK.MB;
  drawMiniSounding();
}

function mskY(p) {
  const lt = Math.log(MSK.PT), lb = Math.log(MSK.PB);
  return MSK.MT + MSK.PH * (Math.log(p) - lt) / (lb - lt);
}
function mskX(t, p) {
  const base = MSK.ML + MSK.PW * (t - MSK.TL) / (MSK.TR - MSK.TL);
  const skew = MSK.PH * (Math.log(MSK.PB) - Math.log(p)) /
                        (Math.log(MSK.PB) - Math.log(MSK.PT));
  return base + skew * MSK.SK;
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

// ── Mini wind barb (scaled for small canvas) ──────────────────────────────
// color defaults to grey for area sounding barbs; pass aircraft colour for overlays.
function drawMiniBarb(ctx, x, y, speedKt, dirFrom, color = '#94a3b8') {
  if (speedKt == null || dirFrom == null) return;
  const spd   = Math.round(speedKt / 5) * 5;
  const angle = dirFrom * Math.PI / 180;  // staff points FROM wind direction (met convention)
  const sLen  = 14;
  const ex    = x + sLen * Math.sin(angle);
  const ey    = y - sLen * Math.cos(angle);

  ctx.strokeStyle = color; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();

  let rem = spd, pos = 0;
  const step = 3;

  while (rem >= 50) {
    const sx = ex - pos * Math.sin(angle), sy = ey + pos * Math.cos(angle);
    const tx = sx + 7 * Math.cos(angle),  ty = sy + 7 * Math.sin(angle);
    const mx = sx + step * Math.sin(angle), my = sy - step * Math.cos(angle);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(tx, ty); ctx.lineTo(mx, my);
    ctx.closePath(); ctx.fill();
    pos += step + 1; rem -= 50;
  }
  while (rem >= 10) {
    const sx = ex - pos * Math.sin(angle), sy = ey + pos * Math.cos(angle);
    const px = sx + 7 * Math.cos(angle),  py = sy + 7 * Math.sin(angle);
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(px, py); ctx.stroke();
    pos += step; rem -= 10;
  }
  if (rem >= 5) {
    const sx = ex - pos * Math.sin(angle), sy = ey + pos * Math.cos(angle);
    const px = sx + 4 * Math.cos(angle),  py = sy + 4 * Math.sin(angle);
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(px, py); ctx.stroke();
  }
}


// ── Theme-aware colour palette for mini Skew-T canvas ────────────────────
function miniSkewTTheme() {
  const light = document.documentElement.dataset.theme === 'light';
  return {
    bg:        light ? '#eef2f7' : '#0c1620',
    isobarMaj: light ? '#c5d0da' : '#1e2a3a',
    isobarMin: light ? '#d8e0e8' : '#172030',
    isotherm0: light ? '#9ab4c8' : '#1e3a5f',
    isothermN: light ? '#cdd7e0' : '#182030',
    isotLabel: light ? '#64748b' : '#374151',
    axisLine:  light ? '#94a3b8' : '#2d3f52',
    isa:       light ? '#9ab4c8' : '#1e3a5f',
    label:     light ? '#475569' : '#374151',
    hint:      light ? '#64748b' : '#374151',
    dotRing:   light ? '#1e293b' : '#ffffff',
    kmLabel:   light ? '#94a3b8' : '#3b4b5e',
    area:      light ? '#64748b' : '#94a3b8',
    tempLbl:   light ? '#1e293b' : '#e2e8f0',
    dryAdi:    light ? '#e2c3a0' : '#54422d',
    ground:    light ? '#8b6f4e' : '#7c6345',
    groundLbl: light ? '#6b5137' : '#b08d62',
    moistAdi:  light ? '#a9d4b7' : '#2a5640',
  };
}

// ── Area profile for the mini Skew-T (from /api/sounding, every 5 min) ──────
let miniArea     = null;   // last /api/sounding response
let miniHoverPts = [];     // [{y, src, alt_ft, p, t, ws, wd, n…}] rebuilt on every draw

async function fetchMiniArea() {
  try {
    const r = await fetch('/api/sounding?minutes=60');
    if (!r.ok) return;
    miniArea = await r.json();
    drawMiniSounding();
  } catch (_) { /* silent */ }
}

// Weighted running mean of the layer temperatures over 3 (1-2-1) or 5
// (1-2-3-2-1) neighbouring layers with a temperature, each also weighted by
// √(replies) so that thin layers count less.  Only for display: the raw
// value is kept in temp_raw.  Strong smoothing also softens inversions and
// the tropopause.
const SMOOTH_KERNELS = { 1: [1, 2, 1], 2: [1, 2, 3, 2, 1] };
function smoothAreaTemps(tl, mode) {
  const k = SMOOTH_KERNELS[mode];
  if (!k) return tl.map(l => ({ ...l, temp_raw: l.temp }));
  const h = (k.length - 1) / 2;
  return tl.map((l, i) => {
    let sw = 0, st = 0;
    for (let j = -h; j <= h; j++) {
      const m = tl[i + j];
      if (!m) continue;
      const w = k[j + h] * Math.sqrt(Math.max(1, m.temp_count || 1));
      sw += w; st += w * m.temp;
    }
    return { ...l, temp_raw: l.temp, temp: st / sw };
  });
}

function drawMiniArea(ctx, T, withBarbs) {
  if (!miniArea || !miniArea.levels) return;
  const { ML, PW, PT, PB, W } = MSK;
  const lv0 = miniArea.levels.filter(l => l.pressure >= PT && l.pressure <= PB)
                             .sort((a, b) => b.pressure - a.pressure);
  const tl = smoothAreaTemps(lv0.filter(l => l.temp != null), areaSmooth);
  const sm = new Map(tl.map(l => [l.alt_lo, l]));
  const lv = lv0.map(l => sm.get(l.alt_lo) || l);
  ctx.save();
  ctx.globalAlpha = withBarbs ? 0.9 : 0.45;
  // 10–90 % range bars
  ctx.strokeStyle = T.area; ctx.lineWidth = 1;
  for (const l of tl) {
    if (l.temp_p10 == null) continue;
    const y = mskY(l.pressure);
    ctx.beginPath();
    ctx.moveTo(mskX(l.temp_p10, l.pressure), y); ctx.lineTo(mskX(l.temp_p90, l.pressure), y);
    ctx.globalAlpha = withBarbs ? 0.35 : 0.2; ctx.stroke();
  }
  ctx.globalAlpha = withBarbs ? 0.9 : 0.45;
  if (tl.length >= 2) {
    ctx.strokeStyle = T.area; ctx.lineWidth = withBarbs ? 2 : 1.5;
    ctx.beginPath();
    tl.forEach((l, i) => {
      const x = mskX(l.temp, l.pressure), y = mskY(l.pressure);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  }
  if (withBarbs) {
    let lastT = null, lastW = null;
    ctx.font = '9px monospace';
    for (const l of tl) {
      const y = mskY(l.pressure);
      if (lastT != null && Math.abs(y - lastT) < 12) continue;
      ctx.fillStyle = T.tempLbl; ctx.textAlign = 'left';
      ctx.fillText(l.temp.toFixed(0) + '°', mskX(l.temp, l.pressure) + 5, y + 3);
      lastT = y;
    }
    for (const l of lv) {
      if (l.wind_spd == null) continue;
      const y = mskY(l.pressure);
      if (lastW != null && Math.abs(y - lastW) < 9) continue;   // keep the barbs readable
      drawMiniBarb(ctx, ML + PW + 22, y, l.wind_spd, l.wind_dir, T.area);
      ctx.fillStyle = T.area; ctx.textAlign = 'right';
      ctx.fillText(Math.round(l.wind_dir) + '° ' + Math.round(l.wind_spd) + 'kt', W - 2, y + 3);
      lastW = y;
    }
  }
  ctx.restore();
  for (const l of lv) {
    miniHoverPts.push({ y: mskY(l.pressure), src: 'area', alt_ft: l.altitude, p: l.pressure,
                        t: l.temp, traw: areaSmooth ? l.temp_raw : null, t10: l.temp_p10, t90: l.temp_p90, tn: l.temp_count,
                        ws: l.wind_spd, wd: l.wind_dir, wsd: l.wind_sd, wn: l.wind_count });
  }
}

// Ground line at the airport's station pressure (QNH reduced to the field
// elevation), shading below it, and the METAR surface temperature.  Aircraft
// pressure altitudes refer to 1013.25 hPa, so the layers below this line are
// below ground (e.g. the 0–1000 ft layer when QNH is low).
function drawMiniGround(ctx, T) {
  if (!miniSfc) return;
  const { ML, PW, MT, PH, PB, PT } = MSK;
  const p = miniSfc.p;
  if (p > PB || p < PT) return;
  const y = mskY(p);
  ctx.save();
  ctx.fillStyle = T.ground; ctx.globalAlpha = 0.18;
  ctx.fillRect(ML, y, PW, MT + PH - y);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = T.ground; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(ML + PW, y); ctx.stroke();
  ctx.font = '9px monospace'; ctx.fillStyle = T.groundLbl; ctx.textAlign = 'right';
  ctx.fillText(`${miniSfc.station || 'ground'} ${Math.round(p)} hPa (QNH ${Math.round(miniSfc.qnh)})`, ML + PW - 4, y - 3);
  if (miniSfc.t != null) {
    const x = mskX(miniSfc.t, p);
    if (x >= ML && x <= ML + PW) {
      ctx.fillStyle = T.groundLbl; ctx.strokeStyle = T.bg; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.textAlign = 'left'; ctx.fillText(`${miniSfc.t}°`, x + 7, y + 11);
    }
  }
  ctx.restore();
  miniHoverPts.push({ y, src: 'sfc', p, t: miniSfc.t, alt_ft: null });
}

// Hover read-out: nearest level / observation to the mouse (aircraft points
// first when an aircraft is selected), shown in a small box over the canvas
function miniHover(ev) {
  const canvas = document.getElementById('mini-sounding-canvas');
  const tip    = document.getElementById('mini-skewt-tip');
  if (!canvas || !tip) return;
  const r  = canvas.getBoundingClientRect();
  const my = (ev.clientY - r.top) * (canvas.height / r.height);
  const pref = miniAcOverlay ? 'ac' : 'area';
  let best = null;
  for (const src of [pref, pref === 'ac' ? 'area' : null]) {
    if (!src) continue;
    for (const p of miniHoverPts) {
      if (p.src !== src && p.src !== 'sfc') continue;
      const d = Math.abs(p.y - my);
      if (d <= 25 && (!best || d < Math.abs(best.y - my))) best = p;
    }
    if (best) break;
  }
  if (!best) { tip.style.display = 'none'; return; }
  const ft  = best.alt_ft != null ? Math.round(best.alt_ft) : null;
  if (best.src === 'sfc' && miniSfc) {
    tip.innerHTML = [`<b>Ground, ${miniSfc.station || 'airport'} METAR ${miniSfc.time}</b>`,
      `QNH ${Math.round(miniSfc.qnh)} hPa · elevation ${Math.round(miniSfc.elev)} ft`,
      `Station pressure ${miniSfc.p.toFixed(1)} hPa`,
      miniSfc.t != null ? `Temp ${miniSfc.t} °C` : '',
      `<span class="mini-tip-dim">Layers below this line are below ground (pressure altitude, 1013.25 hPa)</span>`]
      .filter(Boolean).join('<br>');
    tip.style.display = 'block';
    const wrap0 = canvas.parentElement.getBoundingClientRect();
    tip.style.top  = Math.max(4, Math.min(ev.clientY - wrap0.top - tip.offsetHeight - 8, r.height - tip.offsetHeight)) + 'px';
    tip.style.left = '8px';
    return;
  }
  const lines = [
    `<b>${best.src === 'ac' ? (getLabelText(aircraftData[selectedIcao] || {}) || 'Aircraft') : 'Area, last ' + (miniArea ? miniArea.window_min : 60) + ' min'}</b>`,
    ft != null ? `${ft.toLocaleString()} ft · FL${String(Math.round(ft / 100)).padStart(3, '0')} · ${(ft * 0.0003048).toFixed(1)} km` : '',
    `${Math.round(best.p)} hPa`,
  ];
  if (best.t != null) lines.push(`Temp ${best.t.toFixed(1)} °C` +
      (best.traw != null ? ` <span class="mini-tip-dim">(smoothed; layer ${best.traw.toFixed(1)})</span>` : '') +
      (best.t10 != null ? ` <span class="mini-tip-dim">(10–90 % ${best.t10.toFixed(0)}…${best.t90.toFixed(0)}, n ${best.tn})</span>` : ''));
  if (best.ws != null) lines.push(`Wind ${String(Math.round(best.wd)).padStart(3, '0')}° / ${Math.round(best.ws)} kt` +
      (best.wsd != null ? ` <span class="mini-tip-dim">(SD ${best.wsd.toFixed(0)} kt, n ${best.wn})</span>` : ''));
  tip.innerHTML = lines.filter(Boolean).join('<br>');
  tip.style.display = 'block';
  const wrap = canvas.parentElement.getBoundingClientRect();
  const y = ev.clientY - wrap.top;
  tip.style.top  = Math.max(4, Math.min(y - tip.offsetHeight - 8, r.height - tip.offsetHeight)) + 'px';
  tip.style.left = '8px';
  // crosshair at the chosen level
  drawMiniSounding();
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.strokeStyle = miniSkewTTheme().tempLbl; ctx.globalAlpha = 0.5; ctx.setLineDash([2, 3]);
  ctx.beginPath(); ctx.moveTo(MSK.ML, best.y); ctx.lineTo(MSK.W - 2, best.y); ctx.stroke();
  ctx.restore();
}

function drawMiniSounding() {
  const canvas = document.getElementById('mini-sounding-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const { W, H, ML, MR, MT, MB, PW, PH, TL, TR, PT, PB } = MSK;
  const barbX = ML + PW + 20;  // X of the wind barbs (staff up to 14 px each way)
  const T = miniSkewTTheme();

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = T.bg;
  ctx.fillRect(0, 0, W, H);

  // ── Clip to plot + barb area for grid ──────────────────────────────────
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, MT, W, PH);
  ctx.clip();

  // Isobars (horizontal lines + pressure labels)
  const isobars = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200];
  ctx.font = '9px monospace'; ctx.textAlign = 'right';
  for (const p of isobars) {
    if (p < PT || p > PB) continue;
    const y = mskY(p);
    ctx.strokeStyle = p % 100 === 0 ? T.isobarMaj : T.isobarMin;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(ML + PW, y); ctx.stroke();
    ctx.fillStyle = T.isotLabel;
    ctx.fillText(p, ML - 3, y + 3);
  }

  // Isotherms (skewed temperature lines)
  for (const t of [-90, -80, -70, -60, -50, -40, -30, -20, -10, 0, 10, 20, 30]) {
    const x1 = mskX(t, PB), y1 = mskY(PB);
    const x2 = mskX(t, PT), y2 = mskY(PT);
    ctx.strokeStyle = t === 0 ? T.isotherm0 : T.isothermN;
    ctx.lineWidth   = t === 0 ? 1.2 : 0.7;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }

  ctx.restore();

  // Dry (solid) and moist (dashed) adiabats, every 10 K, clipped to the plot
  ctx.save();
  ctx.beginPath(); ctx.rect(ML, MT, PW, PH); ctx.clip();
  const adi = adiabatCurves(PT, PB, [250, 260, 270, 280, 290, 300, 310, 320, 330, 340, 350, 360, 370, 380, 390, 400],
                            [-10, 0, 10, 20, 30]);
  const adiLine = (pts) => {
    ctx.beginPath();
    pts.forEach(([p, t], i) => { const x = mskX(t, p), y = mskY(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  };
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = T.dryAdi;   ctx.setLineDash([]);     adi.dry.forEach(adiLine);
  ctx.strokeStyle = T.moistAdi; ctx.setLineDash([4, 3]); adi.moist.forEach(adiLine);
  ctx.setLineDash([]);
  ctx.restore();

  // Temperature scale below the plot (outside the clip — inside it the
  // labels were cut off)
  ctx.font = '9px monospace'; ctx.textAlign = 'center'; ctx.fillStyle = T.label;
  for (const t of [-40, -30, -20, -10, 0, 10, 20, 30]) {
    const x1 = mskX(t, PB);
    if (x1 >= ML + 6 && x1 <= ML + PW - 6) ctx.fillText(t + '°', x1, MT + PH + 14);
  }

  // Altitude markers (pressure altitude, km) just right of the pressure axis
  // (the cold upper-left corner of a Skew-T is empty)
  ctx.font = '9px monospace'; ctx.textAlign = 'left';
  for (const km of [1, 2, 3, 4, 5, 6, 8, 10, 12]) {
    const p = altToPressHPa(km * 3280.84);
    if (p < PT || p > PB) continue;
    const y = mskY(p);
    ctx.strokeStyle = T.axisLine; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(ML + 4, y); ctx.stroke();
    ctx.fillStyle = T.kmLabel;
    ctx.fillText(km + ' km', ML + 6, y + 3);
  }
  miniHoverPts = [];

  // Y axis line
  ctx.strokeStyle = T.axisLine; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(ML, MT); ctx.lineTo(ML, MT + PH); ctx.stroke();

  // ── ISA reference (dashed blue) ─────────────────────────────────────────
  const isaPs = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200];
  ctx.strokeStyle = T.isa; ctx.lineWidth = 1.2;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  let isaFirst = true;
  for (const p of isaPs) {
    if (p < PT || p > PB) continue;
    const t = isaTempP(p);
    const x = mskX(t, p), y = mskY(p);
    if (x >= ML && x <= ML + PW) {
      isaFirst ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      isaFirst = false;
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // ── Ground: station pressure from the METAR QNH, with the surface temperature ─
  drawMiniGround(ctx, T);

  // ── Area profile (all aircraft within the sounding radius, last 60 min) ──
  // Grey background reference; with no aircraft selected it is the profile
  // shown, with its wind barbs.
  drawMiniArea(ctx, T, !miniAcOverlay);

  // ── No aircraft selected hint ───────────────────────────────────────────
  if (!miniAcOverlay) {
    ctx.fillStyle = T.hint; ctx.font = '10px system-ui'; ctx.textAlign = 'center';
    const msg = miniArea && miniArea.levels && miniArea.levels.length
      ? `Area profile, last ${miniArea.window_min} min — click an aircraft`
      : 'Click an aircraft to show its profile';
    ctx.fillText(msg, ML + PW / 2, MT + 12);
  }

  // ── Aircraft overlay ────────────────────────────────────────────────────
  if (miniAcOverlay) {
    const { temp_c, pressure, alt_ft, color, windHistory: wh } = miniAcOverlay;

    // ── Wind + temperature history (density-filtered vertical profile) ──
    if (wh && wh.length > 0) {
      // Build density-filtered index list: include a point only when altitude
      // has changed by at least windDensity × 400 ft since the last included.
      const minGapFt = windDensity * 400;
      const shownIdx = [];
      let lastShownAlt = null;
      for (let i = 0; i < wh.length; i++) {
        if (lastShownAlt === null || Math.abs(wh[i].alt_ft - lastShownAlt) >= minGapFt) {
          shownIdx.push(i);
          lastShownAlt = wh[i].alt_ft;
        }
      }
      // Always include the most recent observation regardless of gap
      if (shownIdx[shownIdx.length - 1] !== wh.length - 1) shownIdx.push(wh.length - 1);

      // Temperature line through the shown points (sorted by pressure)
      const tPts = shownIdx.map(i => wh[i])
        .filter(o => o.temp_c != null && o.pressure >= PT && o.pressure <= PB)
        .sort((a, b) => b.pressure - a.pressure);
      if (tPts.length >= 2) {
        ctx.strokeStyle = color + 'cc'; ctx.lineWidth = 1.5;
        ctx.beginPath();
        tPts.forEach((o, i) => {
          const x = mskX(o.temp_c, o.pressure), y = mskY(o.pressure);
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        });
        ctx.stroke();
      }
      // Temperature values next to the points (thinned so they do not overlap)
      let lastLblY = null;
      ctx.font = '9px monospace'; ctx.textAlign = 'left';
      for (const o of tPts) {
        const y = mskY(o.pressure);
        if (lastLblY != null && Math.abs(y - lastLblY) < 12) continue;
        ctx.fillStyle = T.tempLbl;
        ctx.fillText(o.temp_c.toFixed(0) + '°', mskX(o.temp_c, o.pressure) + 5, y + 3);
        lastLblY = y;
      }

      let lastBarbLblY = null;
      for (const idx of shownIdx) {
        const obs = wh[idx];
        if (obs.pressure < PT || obs.pressure > PB) continue;
        const oy        = mskY(obs.pressure);
        const isCurrent = (idx === wh.length - 1);
        const barbColor = isCurrent ? color : color + '66';
        miniHoverPts.push({ y: oy, src: 'ac', alt_ft: obs.alt_ft, p: obs.pressure,
                            t: obs.temp_c, ws: obs.wind_spd, wd: obs.wind_dir });

        // Temperature dot on the skewed T axis
        if (obs.temp_c != null) {
          const ox = mskX(obs.temp_c, obs.pressure);
          ctx.fillStyle = barbColor;
          ctx.beginPath();
          ctx.arc(ox, oy, isCurrent ? 3 : 2, 0, Math.PI * 2);
          ctx.fill();
        }

        // Wind barb in aircraft colour + speed label
        if (obs.wind_spd != null && obs.wind_dir != null) {
          drawMiniBarb(ctx, barbX + 2, oy, obs.wind_spd, obs.wind_dir, barbColor);
          if (isCurrent || lastBarbLblY == null || Math.abs(oy - lastBarbLblY) >= 11) {
            ctx.fillStyle = barbColor;
            ctx.font      = '9px monospace'; ctx.textAlign = 'right';
            ctx.fillText(Math.round(obs.wind_dir) + '° ' + Math.round(obs.wind_spd) + 'kt', W - 2, oy + 3);
            lastBarbLblY = oy;
          }
        }
      }
    }

    // ── Current altitude/pressure level indicator ───────────────────────
    // Always show a dashed horizontal line at the aircraft's current level,
    // even when temperature data is not available.
    const p = (pressure != null) ? pressure
            : (alt_ft  != null) ? altToPressHPa(alt_ft)
            : null;

    if (p != null && p >= PT && p <= PB) {
      const y = mskY(p);

      // Full-width dashed line spanning plot + barb area
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(W - 2, y); ctx.stroke();
      ctx.setLineDash([]);

      // Circle on temperature profile (only if temp available)
      if (temp_c != null) {
        const x = mskX(temp_c, p);
        ctx.strokeStyle = T.dotRing; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
      } else {
        // No temp: draw a small diamond on the pressure axis instead
        const dx = ML + 5, dy = y;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(dx, dy - 5); ctx.lineTo(dx + 4, dy);
        ctx.lineTo(dx, dy + 5); ctx.lineTo(dx - 4, dy);
        ctx.closePath(); ctx.fill();
      }
    }
  }
}

// ── ATC-style aircraft icon ───────────────────────────────────────────────
// A filled square with a speed-vector line pointing in the track direction.
function makeIcon(color, track, selected) {
  const sq    = selected ? 8 : 5;       // half-width of the square (px)
  const S     = 60;                     // SVG canvas size
  const cx    = 30, cy = 30;            // centre point
  const vLen  = selected ? 22 : 16;     // speed-vector length (px)
  const sw    = selected ? 2.5 : 1.5;   // stroke width

  // Convert track (°, 0=North, clockwise) to SVG angle (0=right, clockwise)
  const rad = ((track ?? 0) - 90) * Math.PI / 180;
  const vx  = (cx + vLen * Math.cos(rad)).toFixed(1);
  const vy  = (cy + vLen * Math.sin(rad)).toFixed(1);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
    <line x1="${cx}" y1="${cy}" x2="${vx}" y2="${vy}"
          stroke="${color}" stroke-width="${sw}" stroke-linecap="round" opacity="0.9"/>
    <rect x="${cx - sq}" y="${cy - sq}" width="${sq * 2}" height="${sq * 2}"
          fill="${color}" stroke="#ffffff" stroke-width="${sw}" opacity="0.95"/>
  </svg>`;

  return L.divIcon({
    html:       svg,
    className:  '',
    iconSize:   [S, S],
    iconAnchor: [cx, cy],
  });
}

// ── Trail dots ────────────────────────────────────────────────────────────
function updateTrail(icao, lat, lon, color) {
  if (!trails[icao]) trails[icao] = [];
  const t    = trails[icao];
  const last = t[t.length - 1];

  // Only store if position has moved meaningfully (~50 m threshold)
  if (!last || Math.abs(last[0] - lat) > 0.0005 || Math.abs(last[1] - lon) > 0.0005) {
    t.push([lat, lon]);
  }
  if (t.length > MAX_TRAIL) t.shift();

  // Rebuild trail layer
  if (trailLayers[icao]) trailLayers[icao].remove();
  const group = L.layerGroup();
  const n     = t.length;
  for (let i = 0; i < n - 1; i++) {          // skip newest (that's the main marker)
    const frac = i / Math.max(n - 2, 1);     // 0 = oldest, 1 = newest-1
    L.circleMarker(t[i], {
      radius:      2,
      color:       color,
      fillColor:   color,
      fillOpacity: 0.10 + 0.55 * frac,
      weight:      0,
      interactive: false,
    }).addTo(group);
  }
  group.addTo(map);
  trailLayers[icao] = group;
}

// ── Callsign labels ───────────────────────────────────────────────────────
function updateLabel(icao, lat, lon, label) {
  if (!showLabels) {
    if (labelMarkers[icao]) { labelMarkers[icao].remove(); delete labelMarkers[icao]; }
    return;
  }
  const icon = L.divIcon({
    html:       `<div class="ac-map-label">${label}</div>`,
    className:  '',
    iconSize:   null,
    iconAnchor: [-10, 6],   // offset: label sits to the right of the square
  });
  if (labelMarkers[icao]) {
    labelMarkers[icao].setLatLng([lat, lon]).setIcon(icon);
  } else {
    labelMarkers[icao] = L.marker([lat, lon], {
      icon,
      interactive:  false,
      zIndexOffset: -100,
    }).addTo(map);
  }
}

// ── Wind arrow ────────────────────────────────────────────────────────────
function drawWindArrow(icao, lat, lon, windSpd, windDir) {
  if (windArrows[icao]) windArrows[icao].remove();
  if (windSpd == null || windDir == null || windSpd < 1) return;

  const len     = Math.min(0.012, windSpd / 1000);
  const dir_rad = (windDir + 180) * Math.PI / 180;
  const endLat  = lat + len * Math.cos(dir_rad);
  const endLon  = lon + len * Math.sin(dir_rad) / Math.cos(lat * Math.PI / 180);

  windArrows[icao] = L.polyline([[lat, lon], [endLat, endLon]], {
    color: '#93c5fd', weight: 1.5, opacity: 0.7,
  }).addTo(map);
}

// ── Update / create marker ────────────────────────────────────────────────
function upsertMarker(ac) {
  if (!ac.lat || !ac.lon) return;

  const color    = acColor(ac);
  const selected = ac.icao === selectedIcao;
  const icon     = makeIcon(color, ac.track, selected);
  const label    = getLabelText(ac);

  let popup = `<b>${label}</b>  <span style="color:${color}">${ac.meteo_source || 'NONE'}</span><br>`;
  if (ac.altitude)    popup += `${ac.altitude.toLocaleString()} ft &nbsp;`;
  if (ac.groundspeed) popup += `${ac.groundspeed} kt &nbsp;`;
  if (ac.track)       popup += `${ac.track.toFixed(0)}°<br>`;
  if (ac.best_temp    != null) popup += `Temp: <b>${ac.best_temp.toFixed(1)}°C</b> &nbsp;`;
  if (ac.best_wind_spd != null)
    popup += `Wind: <b>${ac.best_wind_spd.toFixed(0)} kt @ ${ac.best_wind_dir?.toFixed(0)}°</b>`;

  if (markers[ac.icao]) {
    markers[ac.icao].setLatLng([ac.lat, ac.lon]).setIcon(icon);
    markers[ac.icao]._popup.setContent(popup);
  } else {
    const m = L.marker([ac.lat, ac.lon], { icon })
      .bindPopup(popup)
      .addTo(map);
    m.on('click', () => selectAircraft(ac.icao));
    // Closing the aircraft's popup (its × button) also deselects it, so the
    // Atmosphere Profile returns to the area profile.  Only when this
    // aircraft is still the selected one — clicking another aircraft closes
    // this popup too, after or before selecting the new one.
    m.on('popupclose', () => { if (selectedIcao === ac.icao) closeDetail(); });
    markers[ac.icao] = m;
  }

  updateTrail(ac.icao, ac.lat, ac.lon, color);
  updateLabel(ac.icao, ac.lat, ac.lon, label);
  drawWindArrow(ac.icao, ac.lat, ac.lon, ac.best_wind_spd, ac.best_wind_dir);
}

// ── Remove stale markers ──────────────────────────────────────────────────
function removeStale(liveIcaos) {
  for (const icao of Object.keys(markers)) {
    if (!liveIcaos.has(icao)) {
      // Removing a marker closes its popup — that must not deselect the
      // aircraft (it is only missing for now, e.g. lost position under jamming)
      markers[icao].off('popupclose');
      markers[icao].remove();       delete markers[icao];
      if (windArrows[icao])  { windArrows[icao].remove();  delete windArrows[icao]; }
      if (trailLayers[icao]) { trailLayers[icao].remove(); delete trailLayers[icao]; }
      if (labelMarkers[icao]){ labelMarkers[icao].remove();delete labelMarkers[icao]; }
      delete trails[icao];
      delete aircraftData[icao];
      // The selected aircraft keeps its profile history and its track, which
      // stays on the map and continues when the aircraft reappears
      if (icao !== selectedIcao) {
        delete windHistory[icao];
        dbSeeded.delete(icao);  // allow re-seed if aircraft reappears
      }
    }
  }
  // Callsign cache: forget aircraft that are no longer live (a page left
  // open for days would otherwise keep every aircraft ever seen)
  for (const icao of Object.keys(callsignCache)) {
    if (!liveIcaos.has(icao)) delete callsignCache[icao];
  }
}

// ── Aircraft list panel ───────────────────────────────────────────────────
function renderList(data) {
  const list    = document.getElementById('aircraft-list');
  const visible = meteoOnly
    ? data.filter(d => d.meteo_source && d.meteo_source !== 'NONE')
    : data;
  visible.sort((a, b) => (a.callsign || a.icao).localeCompare(b.callsign || b.icao));

  if (visible.length === 0) {
    list.innerHTML = '<div class="ac-placeholder">No aircraft' +
      (meteoOnly ? ' with meteo data' : '') + ' visible.</div>';
    return;
  }

  list.innerHTML = '';
  for (const ac of visible) {
    const div   = document.createElement('div');
    div.className = 'ac-item' + (ac.icao === selectedIcao ? ' selected' : '');
    div.dataset.icao = ac.icao;
    const color = acColor(ac);

    let meteoLine = '';
    if (ac.best_wind_spd != null)
      meteoLine += `💨 ${ac.best_wind_spd.toFixed(0)} kt @ ${ac.best_wind_dir?.toFixed(0)}° `;
    if (ac.best_temp != null)
      meteoLine += `🌡 ${ac.best_temp.toFixed(1)}°C`;
    if (!meteoLine) meteoLine = 'No meteo';

    div.innerHTML = `
      <div>
        <span class="ac-callsign" style="color:${color}">${ac.callsign || ac.icao}</span>
        <span class="ac-icao">${ac.callsign ? ac.icao : ''}</span>
      </div>
      <div class="ac-detail">${ac.altitude != null ? ac.altitude.toLocaleString() + ' ft' : '–'}
        ${ac.groundspeed != null ? ' · ' + ac.groundspeed + ' kt' : ''}</div>
      <div class="ac-meteo">${meteoLine}</div>
    `;
    div.onclick = () => selectAircraft(ac.icao);
    list.appendChild(div);
  }
}

// ── Select aircraft ────────────────────────────────────────────────────────
function selectAircraft(icao) {
  selectedIcao = icao;
  const ac = aircraftData[icao];
  if (!ac) return;

  for (const [k, m] of Object.entries(markers)) {
    const d = aircraftData[k];
    if (d) m.setIcon(makeIcon(acColor(d), d.track, k === icao));
  }

  document.getElementById('detail-ac-panel').classList.remove('hidden');

  document.getElementById('detail-callsign').textContent = ac.icao;
  document.getElementById('detail-icao').textContent     = '';

  const src   = ac.meteo_source || 'NONE';
  const badge = document.getElementById('detail-bds');
  badge.textContent = src;
  badge.className   = 'badge-source badge-' +
    (src === 'MRAR' ? 'mrar' : src === 'COMPUTED' ? 'comp' : src === 'MHR' ? 'mhr' : 'source');

  const set = (id, val, unit = '') =>
    document.getElementById(id).textContent = val != null ? val + unit : '–';

  set('d-alt',   ac.altitude    != null ? ac.altitude.toLocaleString()    : null, ' ft');
  set('d-gs',    ac.groundspeed, ' kt');
  set('d-track', ac.track       != null ? ac.track.toFixed(0)             : null, '°');
  set('d-vr',    ac.vert_rate,   ' fpm');
  set('d-wsp',   ac.best_wind_spd  != null ? ac.best_wind_spd.toFixed(1)  : null, ' kt');
  set('d-wdir',  ac.best_wind_dir  != null ? ac.best_wind_dir.toFixed(0)  : null, '°');
  set('d-temp',  ac.best_temp      != null ? ac.best_temp.toFixed(1)      : null, '°C');
  set('d-pres',  ac.best_pressure  != null ? ac.best_pressure.toFixed(0)  : null, ' hPa');
  set('d-hum',   ac.mrar_humidity  != null ? ac.mrar_humidity.toFixed(0)  : null, '%');
  const turbMap = ['NIL', 'Light', 'Moderate', 'Severe'];
  set('d-turb',  ac.mrar_turbulence != null ? turbMap[ac.mrar_turbulence] : null);
  set('d-fom',   ac.mrar_fom);
  set('d-src',   src);

  // Update mini sounding overlay — includes full wind history for the profile
  miniAcOverlay = {
    alt_ft:      ac.altitude,
    temp_c:      ac.best_temp,
    pressure:    ac.altitude != null ? altToPressHPa(ac.altitude) : null,  // ISA, not QNH
    wind_spd:    ac.best_wind_spd,
    wind_dir:    ac.best_wind_dir,
    color:       acColor(ac),
    windHistory: windHistory[ac.icao] || [],
  };
  drawMiniSounding();

  // ── Pre-seed wind history from DB (once per aircraft per page session) ────
  // Fetch the full flight's stored observations so the Skew-T profile is
  // immediately populated, even on first load or after navigating away.
  // The dbSeeded set prevents re-fetching on every SSE-triggered redraw.
  // The stored track is (re)fetched whenever a different aircraft is selected.
  const needSeed  = !dbSeeded.has(icao);
  const needTrack = selTrackIcao !== icao;
  if (needTrack) { selTrackIcao = icao; selTrackPts = []; }
  appendSelTrack(ac);
  if (needSeed || needTrack) {
    dbSeeded.add(icao);
    fetch(`/api/aircraft/${icao}/wind_history`)
      .then(r => r.json())
      .then(rows => {
        if (needTrack && selTrackIcao === icao) {
          setSelTrackFromDb(rows);
          if (selectedIcao === icao) drawSelectedTrack(icao);
        }
        if (!needSeed || !rows.length) return;

        // Convert DB rows to the same format used by updateWindHistory()
        const dbPoints = rows.map(r => ({
          alt_ft:   r.altitude,
          pressure: altToPressHPa(r.altitude),
          temp_c:   r.best_temp    ?? null,
          wind_spd: r.best_wind_spd ?? null,
          wind_dir: r.best_wind_dir ?? null,
          lat:      r.lat  ?? null,
          lon:      r.lon  ?? null,
        }));

        // Prepend DB history; keep any live points already accumulated
        const livePoints = windHistory[icao] || [];
        windHistory[icao] = [...dbPoints, ...livePoints];

        // Trim to MAX_WIND_HIST cap (keep most recent)
        if (windHistory[icao].length > MAX_WIND_HIST)
          windHistory[icao] = windHistory[icao].slice(-MAX_WIND_HIST);

        // Refresh the overlay if this aircraft is still selected
        if (selectedIcao === icao && miniAcOverlay) {
          miniAcOverlay.windHistory = windHistory[icao];
          drawMiniSounding();
          drawSelectedTrack(icao);
        }
      })
      .catch(() => {});  // silently ignore network errors
  }

  // Draw track from whatever history is already available (DB fetch may still be in-flight)
  drawSelectedTrack(icao);

  // Update info line below canvas
  const info = document.getElementById('mini-ac-info');
  if (info) {
    const cs = getLabelText(ac);
    if (ac.altitude != null && ac.best_temp != null) {
      info.textContent = `${cs}  ·  ${ac.altitude.toLocaleString()} ft  ·  ${ac.best_temp.toFixed(1)}°C`;
      info.style.color = acColor(ac);
    } else if (ac.altitude != null) {
      info.textContent = `${cs}  ·  ${ac.altitude.toLocaleString()} ft  ·  no temp`;
      info.style.color = '#64748b';
    } else {
      info.textContent = `${cs}  ·  no position`;
      info.style.color = '#64748b';
    }
  }

}


// ── Selected aircraft track polyline ──────────────────────────────────────────
// Stored positions of the current flight, replacing the track built so far
// except the live positions newer than the last stored one.
function setSelTrackFromDb(rows) {
  const db = rows.filter(r => r.lat != null && r.lon != null)
                 .map(r => [r.lat, r.lon, r.ts]);
  const lastTs = db.length ? db[db.length - 1][2] : -Infinity;
  selTrackPts = db.concat(selTrackPts.filter(p => p[2] > lastTs));
  if (selTrackPts.length > MAX_TRACK_PTS) selTrackPts = selTrackPts.slice(-MAX_TRACK_PTS);
}

// Live position of the selected aircraft: added when it has moved and at
// most every 5 s (a frozen position, e.g. under GPS jamming, adds nothing).
function appendSelTrack(ac) {
  if (!ac || ac.icao !== selTrackIcao || ac.lat == null || ac.lon == null) return;
  const ts   = ac.last_seen ?? Date.now() / 1000;
  const last = selTrackPts[selTrackPts.length - 1];
  if (last && ((last[0] === ac.lat && last[1] === ac.lon) || ts - last[2] < 5)) return;
  selTrackPts.push([ac.lat, ac.lon, ts]);
  if (selTrackPts.length > MAX_TRACK_PTS) selTrackPts.shift();
}

function drawSelectedTrack(icao) {
  if (!showTrack || !icao || icao !== selTrackIcao || selTrackPts.length < 2) {
    if (selectedTrackLayer) { selectedTrackLayer.remove(); selectedTrackLayer = null; }
    return;
  }
  const points = selTrackPts.map(p => [p[0], p[1]]);
  const ac     = aircraftData[icao];
  if (selectedTrackLayer) {
    selectedTrackLayer.setLatLngs(points);
    if (ac) selectedTrackLayer.setStyle({ color: acColor(ac) });
    return;
  }
  selectedTrackLayer = L.polyline(points, {
    color:     ac ? acColor(ac) : '#94a3b8',
    weight:    2,
    opacity:   0.65,
    dashArray: '5 4',
  }).addTo(map);
}

function closeDetail() {
  if (selectedTrackLayer) { selectedTrackLayer.remove(); selectedTrackLayer = null; }
  // An aircraft deselected while missing from the live data: drop its history
  if (selectedIcao && !aircraftData[selectedIcao]) {
    delete windHistory[selectedIcao];
    dbSeeded.delete(selectedIcao);
  }
  selTrackPts   = [];
  selTrackIcao  = null;
  selectedIcao  = null;
  miniAcOverlay = null;
  drawMiniSounding();
  const info = document.getElementById('mini-ac-info');
  if (info) { info.textContent = 'Click an aircraft to overlay'; info.style.color = ''; }
  document.getElementById('detail-ac-panel').classList.add('hidden');
  for (const [k, m] of Object.entries(markers)) {
    const d = aircraftData[k];
    if (d) m.setIcon(makeIcon(acColor(d), d.track, false));
  }
}

// ── SSE connection ─────────────────────────────────────────────────────────
let evtSource = null;
const statusDot  = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

function connectSSE() {
  if (evtSource) evtSource.close();
  evtSource = new EventSource('/api/live/stream');

  evtSource.onopen = () => {
    statusDot.className   = 'status-dot status-live';
    statusText.textContent = 'Live';
  };

  evtSource.onerror = () => {
    statusDot.className   = 'status-dot status-error';
    statusText.textContent = 'Reconnecting…';
    setTimeout(connectSSE, 5000);
  };

  evtSource.onmessage = (e) => {
    const data     = JSON.parse(e.data);
    const liveIcaos = new Set(data.map(d => d.icao));

    for (const ac of data) {
      if (ac.callsign) callsignCache[ac.icao] = ac.callsign;
      updateWindHistory(ac);       // accumulate vertical wind profile
      aircraftData[ac.icao] = ac;
      upsertMarker(ac);
    }
    removeStale(liveIcaos);
    renderList(data);

    if (selectedIcao && aircraftData[selectedIcao]) {
      selectAircraft(selectedIcao);
    }
  };
}

// ── Filter toggles ─────────────────────────────────────────────────────────

// Restore saved state into the DOM controls before first render
document.getElementById('filter-meteo-only').checked = meteoOnly;
document.getElementById('toggle-labels').checked     = showLabels;
document.getElementById('toggle-track').checked      = showTrack;
document.getElementById('label-mode').value          = labelMode;

document.getElementById('filter-meteo-only').addEventListener('change', e => {
  meteoOnly = e.target.checked;
  localStorage.setItem('ms_meteoOnly', meteoOnly);
  renderList(Object.values(aircraftData));
});

document.getElementById('toggle-track').addEventListener('change', e => {
  showTrack = e.target.checked;
  localStorage.setItem('ms_showTrack', showTrack);
  drawSelectedTrack(selectedIcao);   // redraw (or clear) immediately
});

document.getElementById('toggle-labels').addEventListener('change', e => {
  showLabels = e.target.checked;
  localStorage.setItem('ms_showLabels', showLabels);
  if (!showLabels) {
    for (const icao of Object.keys(labelMarkers)) {
      labelMarkers[icao].remove();
      delete labelMarkers[icao];
    }
  } else {
    for (const [icao, ac] of Object.entries(aircraftData)) {
      if (ac.lat && ac.lon) updateLabel(icao, ac.lat, ac.lon, getLabelText(ac));
    }
  }
});

document.getElementById('label-mode').addEventListener('change', e => {
  labelMode = e.target.value;
  localStorage.setItem('ms_labelMode', labelMode);
  if (showLabels) {
    for (const [icao, ac] of Object.entries(aircraftData)) {
      if (ac.lat && ac.lon) updateLabel(icao, ac.lat, ac.lon, getLabelText(ac));
    }
  }
});

// ── Wind density slider ───────────────────────────────────────────────────
const densitySlider = document.getElementById('wind-density');
const densityVal    = document.getElementById('wind-density-val');

if (densitySlider) {
  densitySlider.value  = windDensity;
  densityVal.textContent = windDensity;

  densitySlider.addEventListener('input', e => {
    windDensity = parseInt(e.target.value, 10);
    localStorage.setItem('ms_windDensity', windDensity);
    densityVal.textContent = windDensity;
    drawMiniSounding();   // re-render immediately with new density
  });
}

// ── Area profile smoothing selector ───────────────────────────────────────
const smoothSel = document.getElementById('area-smooth');
if (smoothSel) {
  smoothSel.value = String(areaSmooth);
  smoothSel.addEventListener('change', e => {
    areaSmooth = parseInt(e.target.value, 10) || 0;
    localStorage.setItem('ms_areaSmooth', String(areaSmooth));
    drawMiniSounding();
  });
}

// ── METAR / TAF fetcher ───────────────────────────────────────────────────
// Surface point for the mini Skew-T from the METAR: station pressure (QNH
// reduced to the airport elevation) and air temperature.  The dewpoint is not
// used — the aircraft data carry no humidity, so the diagram stays dry.
let miniSfc = null;   // {p, qnh, t, elev, station, time}
function parseMetarSfc(d) {
  const m = d.metar || '';
  const qnh = d.qnh_hpa != null ? Number(d.qnh_hpa) : (() => {
    const q = m.match(/\sQ(\d{4})\b/); if (q) return Number(q[1]);
    const a = m.match(/\sA(\d{4})\b/); return a ? Number(a[1]) * 0.338639 : null;
  })();
  if (!qnh || qnh < 900 || qnh > 1100) return null;
  const tm = m.match(/\s(M?\d{2})\/(M?\d{2}|\/\/)?(?=\s)/);
  const t  = tm ? (tm[1][0] === 'M' ? -Number(tm[1].slice(1)) : Number(tm[1])) : null;
  const elev = d.elev_ft != null ? Number(d.elev_ft) : 179;
  const p  = qnh * Math.pow(1 - 2.25577e-5 * elev * 0.3048, 5.25588);   // QNH → station pressure
  const st = m.match(/\b([A-Z]{4})\s\d{6}Z/), tt = m.match(/\s(\d{2})(\d{2})(\d{2})Z\s/);
  return { p, qnh, t, elev, station: st ? st[1] : '', time: tt ? `${tt[2]}:${tt[3]}Z` : '' };
}

async function fetchWx() {
  try {
    const r = await fetch('/api/wx');
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    miniSfc = parseMetarSfc(d);
    drawMiniSounding();
    const metarEl = document.getElementById('wx-metar');
    const tafEl   = document.getElementById('wx-taf');
    if (metarEl) metarEl.textContent = d.metar || '–';
    if (tafEl)   tafEl.textContent   = d.taf   || '–';
  } catch (e) {
    const metarEl = document.getElementById('wx-metar');
    if (metarEl) metarEl.textContent = '[fetch error]';
  }
}

fetchWx();
setInterval(fetchWx, 10 * 60 * 1000);   // refresh every 10 minutes

// ── Start ──────────────────────────────────────────────────────────────────
connectSSE();

// Size the canvas to the available panel space and keep it responsive.
// ResizeObserver fires on first observe too, so no separate initial call needed.
const _mskWrap = document.querySelector('.mini-sounding-wrap');
if (_mskWrap) {
  new ResizeObserver(() => resizeMiniCanvas()).observe(_mskWrap);
} else {
  drawMiniSounding();   // fallback: draw with default dimensions
}

// Deselect: clicking an empty spot on the map or pressing Esc returns the
// Atmosphere Profile to the area profile (same as the ✕ in the detail panel).
// Marker clicks do not reach the map (Leaflet markers do not bubble clicks).
map.on('click', () => { if (selectedIcao) closeDetail(); });
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape' && selectedIcao) closeDetail();
});

// Area profile behind the mini Skew-T, refreshed every 5 minutes
fetchMiniArea();
setInterval(fetchMiniArea, 5 * 60 * 1000);
(function () {
  const c = document.getElementById('mini-sounding-canvas');
  if (!c) return;
  c.addEventListener('mousemove', miniHover);
  c.addEventListener('mouseleave', () => {
    const tip = document.getElementById('mini-skewt-tip');
    if (tip) tip.style.display = 'none';
    drawMiniSounding();
  });
})();

// Redraw mini Skew-T and swap map tile when the global page theme changes
window.onThemeChange = function () {
  map.removeLayer(currentTile);
  currentTile = L.tileLayer(
    document.documentElement.dataset.theme === 'light' ? TILE_LIGHT : TILE_DARK,
    TILE_OPTS
  ).addTo(map);
  drawMiniSounding();
};
