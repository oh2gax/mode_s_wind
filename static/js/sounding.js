/**
 * sounding.js — Sounding page (/sounding).
 *
 * From 2026-10-11 the page draws with the same Skew-T as the Live Map
 * Atmosphere Profile (static/js/skewt_chart.js: createSkewT), with the same
 * Analysis / Smooth / Airport controls (settings shared with the Live Map).
 * Three sources: Area · now (last N minutes, with the METAR ground point),
 * Area · hour (hourly profile archive, with the METAR stored with the hour) and Flight (one climbing / descending
 * flight).  The airport low-level profile follows the selected period.
 *
 * Needs skewt_analysis.js and skewt_chart.js loaded first, and RECEIVER_LAT
 * set by the template.
 */

const ANA_NAMES = ['Off', 'Levels', 'Stability', 'Turbulence', 'Advection', 'Full'];
const MODE_NOTES = {
  area:   'Area: all aircraft within the radius over the selected window.',
  hour:   'Hourly archive: stored once per completed UTC hour (from 9 Oct 2026), also after the observations are purged.',
  flight: 'Flight: altitude profile from a single flight — works best for climbing / descending flights.',
};

function _lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } }
function _lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } }
function _pad(n) { return String(n).padStart(2, '0'); }

// ── Chart state (Analysis / Smooth / Airport shared with the Live Map) ────
let sndMode    = _lsGet('ms_snd_mode', 'area');
let anaLevel   = parseInt(_lsGet('ms_skewtAna', '0'), 10);
let areaSmooth = parseInt(_lsGet('ms_areaSmooth', '0'), 10);
let aptMode    = _lsGet('ms_aptMode', 'off');
if (!(anaLevel >= 0 && anaLevel < ANA_NAMES.length)) anaLevel = 0;
if (![0, 1, 2].includes(areaSmooth)) areaSmooth = 0;
if (!['off', 'overlay', 'zoom'].includes(aptMode)) aptMode = 'off';

let sndProfile = null;   // last /api/sounding… response (the main profile)
let sndLow     = null;   // airport low-level profile of the same period
let sndLowQs   = null;   // its query (minutes=…&end=…), refetched when Airport is switched on
let sndSfc     = null;   // METAR ground point (Area · now only)
let sndTitle   = 'Area profile';
let sndHint    = '';
let sndReq     = 0;      // request counter: a late answer of an older request is dropped

const skewt = createSkewT(document.getElementById('skewt-canvas'),
                          document.getElementById('skewt-tip'),
                          { lat: typeof RECEIVER_LAT !== 'undefined' ? RECEIVER_LAT : 60.3 });

function syncChart() {
  skewt.set({ area: sndProfile, low: sndLow, aptMode, anaLevel, smooth: areaSmooth,
              sfc: sndSfc, ac: null, profileTitle: sndTitle, hint: sndHint });
}
function drawChart() { syncChart(); skewt.draw(); }

function resizeChart() {
  const box = document.getElementById('skewt-box');
  if (!box || box.clientWidth === 0 || box.clientHeight === 0) return;
  const w = Math.max(320, box.clientWidth), h = Math.max(320, box.clientHeight);
  if (skewt.resize(w, h)) drawChart();
}

// ── Surface point from the METAR (parseMetarSfc in skewt_chart.js) ───────
// Area · now: the current METAR (/api/wx); Area · hour: the METAR stored with
// the hourly profile (from 2026-10-11); Flight: none.
let wxElev = 179;
let wxSfc = null;
async function fetchWx() {
  try {
    const r = await fetch('/api/wx');
    if (!r.ok) return;
    const d = await r.json();
    if (d.elev_ft != null) wxElev = Number(d.elev_ft);
    wxSfc = parseMetarSfc(d);
    if (sndMode === 'area') { sndSfc = wxSfc; drawChart(); }
  } catch (_) { /* silent */ }
}

// ── Airport low-level profile of the shown period ─────────────────────────
async function fetchLow(qs) {
  sndLowQs = qs;
  sndLow = null;
  if (aptMode === 'off' || !qs) { drawChart(); return; }
  try {
    const r = await fetch('/api/lowlevel?' + qs);
    if (!r.ok) return;
    const d = await r.json();
    if (sndLowQs !== qs) return;          // another period was selected meanwhile
    sndLow = d;
    drawChart();
  } catch (_) { /* silent */ }
}

// ── Source selection (area now / hourly archive / flight) ─────────────────
function setMode(mode) {
  sndMode = ['area', 'hour', 'flight'].includes(mode) ? mode : 'area';
  _lsSet('ms_snd_mode', sndMode);
  document.querySelectorAll('.snd-mode-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === sndMode));
  document.getElementById('snd-area-ctl').style.display   = sndMode === 'area'   ? '' : 'none';
  document.getElementById('snd-hour-ctl').style.display   = sndMode === 'hour'   ? '' : 'none';
  document.getElementById('snd-flight-ctl').style.display = sndMode === 'flight' ? '' : 'none';
  document.getElementById('flight-banner').classList.add('hidden');
  document.getElementById('snd-mode-note').textContent = MODE_NOTES[sndMode];
  if (sndMode === 'hour') loadHourList();
  else loadCurrent();
}

function loadCurrent() {
  if (sndMode === 'area')   return loadAreaSounding();
  if (sndMode === 'hour')   return loadHourSounding();
  return loadFlightSounding();
}

function fillTable(levels, header) {
  const tbody = document.getElementById('sounding-tbody');
  tbody.innerHTML = '';
  for (const l of levels) {
    const hasData = l.temp != null || l.wind_spd != null;
    const tTip = l.temp_p10 != null ? `10–90 %: ${l.temp_p10.toFixed(1)} … ${l.temp_p90.toFixed(1)} °C` : '';
    const wTip = l.wind_sd != null ? `wind vector SD ${l.wind_sd.toFixed(1)} kt` : '';
    tbody.insertAdjacentHTML('beforeend', `<tr class="${hasData ? '' : 'empty-level'}">
      <td class="num" style="font-weight:700">${l.pressure != null ? Math.round(l.pressure) : '–'}</td>
      <td class="num">${l.altitude != null ? l.altitude.toLocaleString() : '–'}</td>
      <td class="num ${l.temp != null ? '' : 'text-dim'}" title="${tTip}">${l.temp != null ? l.temp.toFixed(1) : '–'}</td>
      <td class="num" title="${wTip}">${l.wind_spd != null ? l.wind_spd.toFixed(1) : '–'}</td>
      <td class="num">${l.wind_dir != null ? l.wind_dir.toFixed(0) + '°' : '–'}</td>
      <td class="num text-dim">${l.temp_count || 0} / ${l.wind_count || 0}</td>
    </tr>`);
  }
  document.getElementById('table-header').textContent = header;
}

// d: /api/sounding… response; title: hover title; hint: text at the top of
// the diagram; lowQs: query of the matching airport low-level profile
function showProfile(d, header, metaPrefix, title, hint, lowQs, sfc) {
  const levels = (d.levels || []).slice().sort((a, b) => b.pressure - a.pressure);
  sndProfile = Object.assign({}, d, { levels });
  sndTitle = title; sndHint = hint; sndSfc = sfc || null;
  fillTable(levels, header);
  document.getElementById('sounding-meta').textContent =
    `${metaPrefix}${d.obs_used} obs used · ${levels.length} levels`;
  drawChart();
  fetchLow(lowQs);
}

function clearProfile(msg) {
  sndProfile = null; sndLow = null; sndLowQs = null; sndSfc = null;
  sndHint = '';
  fillTable([], 'Profile levels');
  if (msg != null) document.getElementById('sounding-meta').textContent = msg;
  drawChart();
}

// ── Area sounding (last N minutes) ────────────────────────────────────────
async function loadAreaSounding() {
  const meta = document.getElementById('sounding-meta');
  meta.textContent = 'Loading…';
  const minutes = document.getElementById('snd-minutes').value;
  const req = ++sndReq;
  try {
    const r = await fetch(`/api/sounding?minutes=${minutes}`);
    const d = await r.json();
    if (req !== sndReq) return;
    const win = d.window_min >= 120 ? `${d.window_min / 60} h` : `${d.window_min} min`;
    showProfile(d, `Area profile — ${d.radius_km} km, last ${win}`,
                d.generated_at ? `generated ${d.generated_at.substr(11, 5)} UTC · ` : '',
                `Area, last ${win}`, `Area profile, ${Math.round(d.radius_km)} km, last ${win}`,
                `minutes=${d.window_min}`, wxSfc);
  } catch (e) {
    if (req === sndReq) clearProfile('Error loading area sounding.');
    console.error(e);
  }
}

// ── Hourly archive ────────────────────────────────────────────────────────
async function loadHourList() {
  const dateEl = document.getElementById('snd-date');
  if (!dateEl.value) {
    const n = new Date(Date.now() - 3600e3);
    dateEl.value = `${n.getUTCFullYear()}-${_pad(n.getUTCMonth() + 1)}-${_pad(n.getUTCDate())}`;
  }
  const sel = document.getElementById('snd-hour');
  const prev = sel.value;
  sel.innerHTML = '<option value="">—</option>';
  try {
    const r = await fetch(`/api/sounding/hours?date=${dateEl.value}`);
    const hours = await r.json();
    for (const h of hours) {
      const d = new Date(h.ts * 1000);
      const o = document.createElement('option');
      o.value = h.ts;
      o.textContent = `${_pad(d.getUTCHours())}–${_pad((d.getUTCHours() + 1) % 24)} UTC (${h.n} obs)`;
      sel.appendChild(o);
    }
    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
    else if (hours.length) sel.value = String(hours[hours.length - 1].ts);
    if (sel.value) loadHourSounding();
    else clearProfile('No hourly profiles stored for this date.');
  } catch (e) {
    console.error('Could not load hour list', e);
  }
}

async function loadHourSounding() {
  const ts = document.getElementById('snd-hour').value;
  const meta = document.getElementById('sounding-meta');
  if (!ts) { clearProfile('Select a date and hour.'); return; }
  meta.textContent = 'Loading…';
  const req = ++sndReq;
  try {
    const r = await fetch(`/api/sounding/hour?ts=${ts}`);
    const d = await r.json();
    if (req !== sndReq) return;
    if (d.error) { clearProfile(d.error); return; }
    const t = new Date(d.hour_ts * 1000);
    const hh = `${_pad(t.getUTCHours())}–${_pad((t.getUTCHours() + 1) % 24)} UTC`;
    const lbl = `${t.getUTCDate()}.${t.getUTCMonth() + 1}.${t.getUTCFullYear()} ${hh}`;
    // METAR stored with the hour (from 2026-10-11): z DDHHMM, q, tt, td, cld
    const m = d.sfc;
    const hsfc = m ? skewtSfcPoint({ qnh: m.q, t: m.tt, td: m.td, elev: wxElev, cld: m.cld,
                                     station: wxSfc ? wxSfc.station : '',
                                     time: m.z ? `${m.z.slice(2, 4)}:${m.z.slice(4, 6)}Z` : '' }) : null;
    showProfile(d, `Hourly profile — ${lbl}, ${d.radius_km} km`, '',
                `Hour ${hh}`, `Hourly profile ${lbl}`,
                `minutes=60&end=${d.hour_ts + 3600}`, hsfc);
  } catch (e) {
    if (req === sndReq) clearProfile('Error loading hourly profile.');
    console.error(e);
  }
}

// ── Flight list ───────────────────────────────────────────────────────────
async function loadFlightList() {
  const sel = document.getElementById('flight-select');
  try {
    const r = await fetch('/api/flights/suitable_soundings');
    const flights = await r.json();
    sel.innerHTML = '<option value="">— select a flight with altitude profile —</option>';
    for (const f of flights) {
      const range = f.max_altitude && f.min_altitude
        ? `${Math.round(f.min_altitude / 100) * 100}–${Math.round(f.max_altitude / 100) * 100} ft`
        : '';
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = `${f.callsign || f.icao}  ${range}  (${f.last_seen.substr(0, 16)} UTC,  ${f.meteo_count} meteo obs)`;
      sel.appendChild(opt);
    }
  } catch (e) {
    console.error('Could not load flight list', e);
  }
}

function _utcSec(s) {   // 'YYYY-MM-DD HH:MM:SS' (UTC) → Unix seconds
  const t = s ? Date.parse(s.replace(' ', 'T') + 'Z') : NaN;
  return isNaN(t) ? null : t / 1000;
}

// ── Flight profile sounding ───────────────────────────────────────────────
async function loadFlightSounding() {
  const flightId = document.getElementById('flight-select').value;
  const meta = document.getElementById('sounding-meta');
  if (!flightId) { clearProfile('Select a flight first.'); return; }
  meta.textContent = 'Loading…';
  const req = ++sndReq;
  try {
    const r = await fetch(`/api/flights/${flightId}/sounding`);
    const d = await r.json();
    if (req !== sndReq) return;
    if (d.error) { clearProfile('Error: ' + d.error); return; }

    const f = d.flight;
    const name = f.callsign || f.icao;
    const span = `${f.first_seen ? f.first_seen.substr(11, 5) : ''}–${f.last_seen ? f.last_seen.substr(11, 5) : ''} UTC`;
    // airport low-level profile over the flight ± 15 min (its landing or take-off)
    const t0 = _utcSec(f.first_seen), t1 = _utcSec(f.last_seen);
    let lowQs = null;
    if (t0 != null && t1 != null) {
      const end = t1 + 900;
      const minutes = Math.max(10, Math.min(360, Math.ceil((end - (t0 - 900)) / 60)));
      lowQs = `minutes=${minutes}&end=${Math.round(end)}`;
    }
    showProfile(d, `Flight profile — ${d.levels.length} levels`,
                d.generated_at ? `generated ${d.generated_at.substr(11, 5)} UTC · ` : '',
                name, `${name} ${f.first_seen ? f.first_seen.substr(0, 10) : ''} ${span}`, lowQs, null);

    const banner = document.getElementById('flight-banner');
    const rangeStr = (f.min_altitude != null && f.max_altitude != null)
      ? `${f.min_altitude.toLocaleString()}–${f.max_altitude.toLocaleString()} ft`
      : '–';
    banner.innerHTML =
      `<strong>${name}</strong> &nbsp;·&nbsp; ${f.icao}` +
      `&nbsp;·&nbsp; ${f.first_seen ? f.first_seen.substr(0, 16) : ''} – ${f.last_seen ? f.last_seen.substr(0, 16) : ''} UTC` +
      `&nbsp;·&nbsp; Altitude range: ${rangeStr}` +
      `&nbsp;·&nbsp; ${f.meteo_count} meteo obs`;
    banner.classList.remove('hidden');
  } catch (e) {
    if (req === sndReq) clearProfile('Error loading flight sounding.');
    console.error(e);
  }
}

// ── Diagram controls (as on the Live Map) ─────────────────────────────────
const anaBtn = document.getElementById('skewt-ana-btn');
function setAnaLevel(v, redraw = true) {
  anaLevel = (v + ANA_NAMES.length) % ANA_NAMES.length;
  _lsSet('ms_skewtAna', String(anaLevel));
  anaBtn.textContent = 'Analysis: ' + ANA_NAMES[anaLevel];
  anaBtn.classList.toggle('active', anaLevel > 0);
  if (redraw) drawChart();
}
anaBtn.addEventListener('click', () => setAnaLevel(anaLevel + 1));
anaBtn.addEventListener('wheel', ev => { ev.preventDefault(); setAnaLevel(anaLevel + (ev.deltaY > 0 ? 1 : -1)); },
                        { passive: false });
setAnaLevel(anaLevel, false);

const smoothSel = document.getElementById('area-smooth');
smoothSel.value = String(areaSmooth);
smoothSel.addEventListener('change', e => {
  areaSmooth = parseInt(e.target.value, 10) || 0;
  _lsSet('ms_areaSmooth', String(areaSmooth));
  drawChart();
});

const aptSel = document.getElementById('apt-mode');
aptSel.value = aptMode;
aptSel.addEventListener('change', e => {
  aptMode = e.target.value;
  _lsSet('ms_aptMode', aptMode);
  fetchLow(sndLowQs);
});

const canvasEl = document.getElementById('skewt-canvas');
canvasEl.addEventListener('mousemove', ev => { syncChart(); skewt.hover(ev); });
canvasEl.addEventListener('mouseleave', () => { syncChart(); skewt.leave(); });
new ResizeObserver(() => resizeChart()).observe(document.getElementById('skewt-box'));
window.onThemeChange = drawChart;

// ── Startup ───────────────────────────────────────────────────────────────
document.querySelectorAll('.snd-mode-btn').forEach(b =>
  b.addEventListener('click', () => setMode(b.dataset.mode)));
document.getElementById('snd-minutes').addEventListener('change', loadAreaSounding);
document.getElementById('snd-date').addEventListener('change', loadHourList);
document.getElementById('snd-hour').addEventListener('change', loadHourSounding);

fetchWx();
setInterval(fetchWx, 10 * 60 * 1000);

// Populate the flight list, then check for a ?flight=<id> URL parameter
loadFlightList().then(() => {
  const preFlightId = new URLSearchParams(window.location.search).get('flight');
  if (preFlightId) {
    const sel = document.getElementById('flight-select');
    sel.value = preFlightId;
    if (!sel.value) {
      // Flight not in the list (too old / not qualifying) — add it manually
      const o = document.createElement('option');
      o.value = preFlightId; o.textContent = `Flight #${preFlightId}`;
      sel.appendChild(o);
      sel.value = preFlightId;
    }
    setMode('flight');
  } else {
    setMode(sndMode);
  }
});
