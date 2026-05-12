/**
 * windmap.js — Gridded historical wind map from MODE-S meteo observations.
 *
 * Fetches aggregated wind data from /api/windmap for a chosen flight level,
 * altitude tolerance, time period and grid resolution, then renders standard
 * meteorological wind barbs on a Leaflet map.
 *
 * Wind barb convention:
 *   Staff points FROM the direction the wind is coming from.
 *   Pennant  = 50 kt,  full barb = 10 kt,  half barb = 5 kt.
 *
 * Colour scale (by averaged cell wind speed):
 *   Green  < 15 kt  |  Blue 15–30 kt  |  Amber 30–50 kt  |  Red > 50 kt
 */

// ── Map initialisation ────────────────────────────────────────────────────
const map = L.map('wm-map', { zoomControl: true })
             .setView([RECEIVER_LAT, RECEIVER_LON], 6);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '© OSM, © CARTO',
  subdomains:  'abcd',
  maxZoom:     18,
}).addTo(map);

L.circleMarker([RECEIVER_LAT, RECEIVER_LON], {
  radius: 6, color: '#fff', fillColor: '#1d4ed8',
  fillOpacity: 1, weight: 2,
}).bindTooltip('Receiver').addTo(map);

// Layer group that holds all barb markers — cleared on each load
let barbLayer = L.layerGroup().addTo(map);

// ── Wind speed → colour ───────────────────────────────────────────────────
function barbColor(speedKt) {
  if (speedKt < 15) return '#6ee7b7';
  if (speedKt < 30) return '#3b82f6';
  if (speedKt < 50) return '#f59e0b';
  return '#ef4444';
}

// ── SVG wind barb icon ────────────────────────────────────────────────────
// Draws a standard meteorological barb, rotated so the staff points FROM
// the direction the wind comes from.  A small label shows dir° speed kt
// and optional temperature below the barb.
function makeBarbIcon(speedKt, dirFrom, obs, temp) {
  const color  = barbColor(speedKt);
  const spd    = Math.round(speedKt / 5) * 5;  // round to 5 kt for barb symbols

  // Canvas size and pivot (observation location sits at cx, cy)
  const S  = 80;
  const cx = 40, cy = 44;
  const staffLen = 26;

  // Staff tip in the unrotated frame (pointing straight up = FROM north)
  const tx = cx, ty = cy - staffLen;

  let g = '';   // SVG elements inside the rotating group

  if (spd === 0) {
    // Calm: open circle at observation point, no staff
    g = `<circle cx="${cx}" cy="${cy}" r="6" stroke="${color}"
                  stroke-width="1.5" fill="none"/>`;
  } else {
    // Staff
    g += `<line x1="${cx}" y1="${cy}" x2="${tx}" y2="${ty}"
               stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>`;

    // Barbs accumulate from the staff tip downward
    let rem = spd, pos = 0;
    const step = 5, barbLen = 11;

    // Pennants (50 kt filled triangle)
    while (rem >= 50) {
      const y1 = ty + pos, y2 = ty + pos + step;
      g += `<polygon points="${tx},${y1} ${tx + barbLen},${y1 + step * 0.5} ${tx},${y2}"
                      fill="${color}"/>`;
      pos += step + 1.5; rem -= 50;
    }
    // Full barbs (10 kt)
    while (rem >= 10) {
      const y = ty + pos;
      g += `<line x1="${tx}" y1="${y}" x2="${tx + barbLen}" y2="${y - 3}"
                  stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>`;
      pos += step; rem -= 10;
    }
    // Half barb (5 kt)
    if (rem >= 5) {
      const y = ty + pos;
      g += `<line x1="${tx}" y1="${y}" x2="${tx + barbLen * 0.5}" y2="${y - 1.5}"
                  stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>`;
    }
  }

  // Small dot at the observation/cell-centre point
  const dot = `<circle cx="${cx}" cy="${cy}" r="2.5" fill="${color}"/>`;

  // Label below the SVG (outside the rotating group so it stays horizontal)
  const label = `${Math.round(dirFrom)}° ${Math.round(speedKt)}kt`;
  const tempStr = temp != null ? ` ${temp.toFixed(1)}°C` : '';
  const obsStr  = obs > 1 ? ` (${obs})` : '';

  const labelEl = `<text x="${cx}" y="${S + 9}" text-anchor="middle"
      fill="${color}" font-size="8.5" font-family="'Courier New',monospace"
      opacity="0.9">${label}${tempStr}${obsStr}</text>`;

  const totalH = S + 14;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"
                    width="${S}" height="${totalH}"
                    viewBox="0 0 ${S} ${totalH}">
    <g transform="rotate(${dirFrom},${cx},${cy})">${g}</g>
    ${dot}
    ${labelEl}
  </svg>`;

  return L.divIcon({
    html:       svg,
    className:  '',
    iconSize:   [S, totalH],
    iconAnchor: [cx, cy],
  });
}

// ── Fetch and render ──────────────────────────────────────────────────────
async function loadWindMap() {
  const fl     = parseInt(document.getElementById('wm-fl').value,    10);
  const tol    = parseInt(document.getElementById('wm-tol').value,   10);
  const grid   = parseFloat(document.getElementById('wm-grid').value);
  const period = document.getElementById('wm-period').value;

  const btn    = document.getElementById('wm-load');
  const status = document.getElementById('wm-status');

  btn.disabled     = true;
  status.textContent = 'Loading…';

  // Build API URL
  let url = `/api/windmap?fl=${fl}&tolerance=${tol}&grid=${grid}`;

  if (period === 'custom') {
    const sv = document.getElementById('wm-start').value;
    const ev = document.getElementById('wm-end').value;
    if (!sv || !ev) {
      status.textContent = 'Please select start and end date/time.';
      btn.disabled = false;
      return;
    }
    const startTs = Math.floor(new Date(sv).getTime() / 1000);
    const endTs   = Math.floor(new Date(ev).getTime() / 1000);
    if (endTs <= startTs) {
      status.textContent = 'End time must be after start time.';
      btn.disabled = false;
      return;
    }
    url += `&start=${startTs}&end=${endTs}`;
  } else {
    url += `&window=${period}`;
  }

  try {
    const r = await fetch(url);
    const d = await r.json();

    barbLayer.clearLayers();

    const flStr = `FL${String(fl).padStart(3, '0')}`;

    if (!d.cells || d.cells.length === 0) {
      status.textContent =
        `No data for ${flStr} ±${tol} ft in the selected period. ` +
        `Try a longer time window or wider altitude tolerance.`;
      btn.disabled = false;
      return;
    }

    // Draw one barb marker per grid cell
    for (const cell of d.cells) {
      const icon = makeBarbIcon(
        cell.wind_spd, cell.wind_dir, cell.obs, cell.temp
      );

      const popupHtml =
        `<b>${flStr}</b> &nbsp;<span style="color:#64748b">${cell.lat.toFixed(3)}°N ` +
        `${cell.lon.toFixed(3)}°E</span><br>` +
        `Wind: <b>${cell.wind_dir.toFixed(0)}° @ ${cell.wind_spd.toFixed(1)} kt</b><br>` +
        (cell.temp != null
          ? `Temp: <b>${cell.temp.toFixed(1)} °C</b><br>` : '') +
        `Obs averaged: ${cell.obs}<br>` +
        `Grid cell: ${d.grid_deg}°`;

      L.marker([cell.lat, cell.lon], { icon, zIndexOffset: cell.obs })
        .bindPopup(popupHtml)
        .bindTooltip(
          `${cell.wind_dir.toFixed(0)}° ${cell.wind_spd.toFixed(0)} kt` +
          (cell.temp != null ? ` · ${cell.temp.toFixed(1)}°C` : '') +
          ` · ${cell.obs} obs`,
          { direction: 'top', offset: [0, -48] }
        )
        .addTo(barbLayer);
    }

    status.textContent =
      `${flStr} ±${tol} ft · ${d.obs_used} obs → ${d.cells_count} grid cells · ` +
      `${d.period_start} – ${d.period_end} · grid ${grid}°`;

  } catch (e) {
    status.textContent = 'Error loading wind map data.';
    console.error(e);
  }

  btn.disabled = false;
}

// ── Control wiring ────────────────────────────────────────────────────────
document.getElementById('wm-period').addEventListener('change', function () {
  document.getElementById('wm-custom-range')
    .classList.toggle('wm-hidden', this.value !== 'custom');
});

document.getElementById('wm-load').addEventListener('click', loadWindMap);

// Enter key anywhere in the control strip triggers load
document.querySelector('.windmap-controls').addEventListener('keydown', e => {
  if (e.key === 'Enter') loadWindMap();
});

// Pre-fill datetime inputs with a sensible default (last hour in local time)
(function initDatetimes() {
  const now  = new Date();
  const ago  = new Date(now - 3600_000);
  const fmt  = dt => {
    // datetime-local format: "YYYY-MM-DDTHH:MM"
    const pad = n => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}` +
           `T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  };
  document.getElementById('wm-start').value = fmt(ago);
  document.getElementById('wm-end').value   = fmt(now);
})();
