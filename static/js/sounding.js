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
  th:     'Time–height: the hourly area profiles side by side.',
  verif:  'Sonde check: the Mode-S area profile compared with the radiosonde — at launch (±1 h) and hour by hour as the sounding ages.',
  meps:   'MEPS check: the Mode-S area profile compared with the MEPS weather model every hour, by pressure level, and the distance effect at the soundings.',
  area:   'Area: all aircraft within the radius over the selected window.',
  hour:   'Hourly archive: stored once per completed UTC hour (from 9 Oct 2026), also after the observations are purged.',
  flight: 'Flight: altitude profile from a single flight — works best for climbing / descending flights.',
};

function _lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } }
function _lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } }
function _pad(n) { return String(n).padStart(2, '0'); }

// ── Chart state (Analysis / Smooth / Airport / Data quality shared with the Live Map)
let sndMode    = _lsGet('ms_snd_mode', 'area');
let anaLevel   = parseInt(_lsGet('ms_skewtAna', '0'), 10);
let areaSmooth = parseInt(_lsGet('ms_areaSmooth', '0'), 10);
let aptMode    = _lsGet('ms_aptMode', 'off');
let sondeShow  = _lsGet('ms_skewtSonde', 'false') === 'true';   // radiosonde layer (default off)
let rhShow     = _lsGet('ms_skewtRH', 'false') === 'true';      // RH strip: trial moisture indicator (default off)
let sndSonde   = null;   // /api/sonde response for the shown profile
let sndSondeAt = null;   // Auto: newest launched by this time (Unix s; null = latest)
let sndSondePick = 'auto';   // 'auto' or the key (YYYYMMDDHH) chosen in the picker
let sndSondeRef = null;  // time the sonde age is counted to (null = now)
let sndSondeSeq = 0;     // request counter
let sndLastTable = null; // [levels, header] of the table (refilled when the sonde arrives)
let dqShow     = _lsGet('ms_skewtDq', 'true') !== 'false';   // data-validity indicator
let mepsShow   = _lsGet('ms_skewtMeps', 'false') === 'true';   // MEPS model profile (default off)
let sndMeps    = null;   // /api/meps/profile response for the shown profile
let sndMepsAt  = null;   // time the model profile is taken at (Unix s; null = now)
let sndMepsSeq = 0;
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
let sndHourPick = null;  // hour (Unix s, string) to select in Area · hour (time–height click)

const skewt = createSkewT(document.getElementById('skewt-canvas'),
                          document.getElementById('skewt-tip'),
                          { lat: typeof RECEIVER_LAT !== 'undefined' ? RECEIVER_LAT : 60.3 });

function syncChart() {
  skewt.set({ area: sndProfile, low: sndLow, aptMode, anaLevel, smooth: areaSmooth,
              sfc: sndSfc, ac: null, profileTitle: sndTitle, hint: sndHint, dq: dqShow,
              sonde: sondeShow ? sndSonde : null, sondeRef: sndSondeRef,
              meps: mepsShow ? sndMeps : null,
              rh: rhShow, moist: rhShow && sndProfile && sndMode !== 'flight' ? sndProfile.moisture || null : null });
}
function drawChart() { syncChart(); skewt.draw(); renderIndices(); }

// ── Indices panel (skewt_indices.js): the shown Mode S profile and the sonde,
// computed with the same method (the sonde averaged into the Mode S layers)
let idxShow = _lsGet('ms_sndIdx', 'true') !== 'false';
let idxKey = null;
function renderIndices(force = false) {
  const tbl = document.getElementById('snd-idx-table');
  if (!tbl || !idxShow || typeof skewtIndices !== 'function') return;
  const sonde = sondeShow && sndSonde && sndSonde.found ? sndSonde : null;
  const key = [sndProfile, sonde, sndSfc, sndMode];
  if (!force && idxKey && key.every((v, i) => v === idxKey[i])) return;
  idxKey = key;
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const levels = sndProfile && sndProfile.levels ? sndProfile.levels : [];
  const sfc = sndSfc && sndSfc.t != null
    ? { p: sndSfc.p, t: sndSfc.t, td: sndSfc.td, elev: sndSfc.elev, qnh: sndSfc.qnh,
        src: `METAR ${sndSfc.station || ''} ${sndSfc.time || ''}`.trim() } : null;
  const lat = typeof RECEIVER_LAT !== 'undefined' ? RECEIVER_LAT : 60.3;
  const M = levels.length ? skewtIndices(levels, { sfc, lat,
              noSfc: sndMode === 'flight' ? 'flight profile: no surface observation' : 'no METAR with this profile' }) : null;
  let S = null;
  if (sonde) {
    const sl = (sonde.levels || []).slice().sort((a, b) => b.pressure - a.pressure);
    const s0 = sl.find(l => l.temp != null);
    const ssfc = s0 ? { p: s0.pressure, t: s0.temp, td: s0.dewpoint, elev: s0.z_m != null ? s0.z_m / 0.3048 : null,
                        src: `${sonde.station || 'sonde'} surface` } : null;
    S = skewtIndices(skewtSondeLayers(sl), { sfc: ssfc, lat: sonde.lat || lat, humid: true, top: sonde.min_p });
  }
  const ac = sndProfile && sndProfile.aircraft != null ? sndProfile.aircraft : null;
  const win = sndProfile && sndProfile.window_min ? sndProfile.window_min / 60 : 1;
  const low = sndMode !== 'flight' && ac != null && ac / Math.max(1, win) < 8;
  const st = sonde ? new Date(sonde.nominal * 1000) : null;
  const sName = sonde ? (sonde.station || 'Sonde').split(/\s+/)[0] : '';
  let h = `<thead><tr><th>Index</th><th class="${low ? 'low' : ''}" title="${low ? 'LOW data: few aircraft behind the profile' : ''}">Mode S` +
          `<small>${sndMode === 'flight' ? 'flight' : ac != null ? ac + ' aircraft' + (low ? ' · LOW' : '') : 'area'}</small></th>` +
          (S ? `<th title="${esc(sonde.station)} ${st.getUTCDate()}.${st.getUTCMonth() + 1}. ${_pad(st.getUTCHours())} UTC${sonde.qc ? ' — top cut: ' + esc(sonde.qc) : ''}">${esc(sName.charAt(0) + sName.slice(1).toLowerCase())}` +
               `<small>${st.getUTCDate()}.${st.getUTCMonth() + 1}. ${_pad(st.getUTCHours())} UTC</small></th>` : '') +
          `</tr></thead><tbody>`;
  const cell = r => {
    if (!r) return '<td class="na">–</td>';
    const tip = r.na ? r.na : r.tip || '';
    return `<td class="${r.na ? 'na' : r.cls || ''}" title="${esc(tip)}">${esc(r.txt)}</td>`;
  };
  for (const [grp, k, label, expl] of SKEWT_INDEX_ROWS) {
    if (grp) h += `<tr class="grp"><td colspan="${S ? 3 : 2}">${esc(grp)}</td></tr>`;
    h += `<tr><td title="${esc(expl)}">${esc(label)}</td>${M ? cell(M.rows[k]) : '<td class="na">–</td>'}${S ? cell(S.rows[k]) : ''}</tr>`;
  }
  tbl.innerHTML = h + '</tbody>';
  const notes = [];
  if (!M) notes.push('No profile loaded.');
  else {
    notes.push('Mode S: aircraft temperature / wind' + (sfc ? ' + METAR surface T / Td' : '') + '; humidity-aloft indices are sonde only.');
    if (M.info.gaps.length) notes.push(`Mode S profile has data gaps (${M.info.gaps.join(', ')}): levels found above a gap are uncertain.`);
    if (low) notes.push('LOW data: few aircraft — single-aircraft layers can be several degrees off.');
  }
  if (S) notes.push('Sonde: averaged into the same layers, own surface values (about 100 km NW, inland).' +
                    (sonde.min_p > 150 ? ` Partial: to ${Math.round(sonde.min_p)} hPa.` : ''));
  else if (!sondeShow) notes.push('Tick Sonde to compare with the radiosonde.');
  notes.push('Heights: ft AMSL from the surface (FL without one). Hover for details.');
  document.getElementById('snd-idx-note').innerHTML = notes.map(esc).join(' ');
}
function setIdxShow(v) {
  idxShow = v;
  _lsSet('ms_sndIdx', String(v));
  document.querySelector('.sounding-layout').classList.toggle('idx-hidden', !v);
  if (v) renderIndices(true);
}

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
  sndMode = ['area', 'hour', 'flight', 'th', 'verif', 'meps'].includes(mode) ? mode : 'area';
  _lsSet('ms_snd_mode', sndMode);
  document.querySelectorAll('#snd-mode-btns .snd-mode-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === sndMode));
  document.getElementById('snd-area-ctl').style.display   = sndMode === 'area'   ? '' : 'none';
  document.getElementById('snd-hour-ctl').style.display   = sndMode === 'hour'   ? '' : 'none';
  document.getElementById('snd-flight-ctl').style.display = sndMode === 'flight' ? '' : 'none';
  document.getElementById('snd-verif-ctl').style.display  = sndMode === 'verif'  ? '' : 'none';
  document.getElementById('snd-meps-ctl').style.display   = sndMode === 'meps'   ? '' : 'none';
  document.getElementById('snd-th-ctl').style.display     = sndMode === 'th'     ? '' : 'none';
  // Sonde check and Time–height replace the diagram and the level table
  document.querySelector('.sounding-layout').style.display = (sndMode === 'verif' || sndMode === 'th' || sndMode === 'meps') ? 'none' : '';
  document.getElementById('snd-verif').style.display = sndMode === 'verif' ? '' : 'none';
  document.getElementById('snd-meps').style.display = sndMode === 'meps' ? '' : 'none';
  document.getElementById('snd-th').style.display = sndMode === 'th' ? '' : 'none';
  document.getElementById('sounding-meta').textContent = '';
  document.getElementById('snd-mode-note').textContent = MODE_NOTES[sndMode];
  if (sndMode === 'verif') { loadVerification(); return; }
  if (sndMode === 'meps') { loadMepsCheck(); return; }
  document.getElementById('flight-banner').classList.add('hidden');
  if (sndMode === 'th') { TimeHeight.load(); return; }
  if (sndMode === 'hour') loadHourList();
  else loadCurrent();
}

function loadCurrent() {
  if (sndMode === 'verif')  return loadVerification();
  if (sndMode === 'meps')   return loadMepsCheck();
  if (sndMode === 'th')     return TimeHeight.load();
  if (sndMode === 'area')   return loadAreaSounding();
  if (sndMode === 'hour')   return loadHourSounding();
  return loadFlightSounding();
}

function refillTable() { if (sndLastTable) fillTable(sndLastTable[0], sndLastTable[1]); }

function fillTable(levels, header) {
  sndLastTable = [levels, header];
  const tbody = document.getElementById('sounding-tbody');
  tbody.innerHTML = '';
  // radiosonde columns (Sonde tick box with a sounding found)
  const withSonde = !!(sondeShow && sndSonde && sndSonde.found);
  tbody.closest('table').classList.toggle('with-sonde', withSonde);
  if (withSonde) { syncChart(); }
  const sondeCells = l => {
    if (!withSonde) return '';
    const sv = l.pressure != null ? skewt.sondeAt(l.pressure) : null;
    let dT = '', dV = '', dTc = 'text-dim', dVc = 'text-dim';
    if (sv && sv.t != null && l.temp != null) {
      const d = l.temp - sv.t; dT = (d >= 0 ? '+' : '') + d.toFixed(1); if (Math.abs(d) > 2) dTc = 'snd-dev';
    }
    if (sv && sv.u != null && l.wind_spd != null && l.wind_dir != null) {
      const r = l.wind_dir * Math.PI / 180;
      const d = Math.hypot(-l.wind_spd * Math.sin(r) - sv.u, -l.wind_spd * Math.cos(r) - sv.v);
      dV = d.toFixed(0); if (d > 10) dVc = 'snd-dev';
    }
    return `<td class="num snd-sonde-col">${sv && sv.t != null ? sv.t.toFixed(1) : '–'}</td>
      <td class="num snd-sonde-col ${dTc}">${dT || '–'}</td>
      <td class="num snd-sonde-col">${sv && sv.ws != null ? String(Math.round(sv.wd)).padStart(3, '0') + '° / ' + Math.round(sv.ws) : '–'}</td>
      <td class="num snd-sonde-col ${dVc}">${dV || '–'}</td>`;
  };
  // highest level (lowest pressure) on top, as in the Skew-T diagram
  const rows = levels.slice().sort((a, b) => (a.pressure ?? 0) - (b.pressure ?? 0));
  for (const l of rows) {
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
      <td class="num ${l.ac_count != null && l.ac_count <= 2 ? 'snd-weak' : 'text-dim'}">${l.ac_count != null ? l.ac_count : '–'}</td>
      ${sondeCells(l)}
    </tr>`);
  }
  document.getElementById('table-header').textContent = header;
}

// Radiosonde for the shown profile (Area · now: latest; hour / flight: the
// newest launched by then).  at: Unix s or null; ref: time the age counts to.
async function fetchSonde(at, ref) {
  sndSondeAt = at != null ? at : null;
  sndSondeRef = ref != null ? ref : null;
  document.getElementById('sonde-pick').style.display = sondeShow ? 'inline-block' : 'none';
  if (!sondeShow) { sndSonde = null; drawChart(); refillTable(); return; }
  const qs = sndSondePick !== 'auto' ? `key=${sndSondePick}`
           : sndSondeAt != null ? `at=${Math.round(sndSondeAt)}` : '';
  const req = ++sndSondeSeq;
  try {
    const r = await fetch('/api/sonde' + (qs ? '?' + qs : ''));
    const d = await r.json();
    if (req !== sndSondeSeq) return;           // a newer request is under way
    sndSonde = d;
  } catch (_) { sndSonde = null; }
  drawChart();
  refillTable();
}

// MEPS model profile (/api/meps/profile) at the time of the shown profile
// (null = now: the newest model hours, a forecast of up to +5 h)
async function fetchMeps(at) {
  sndMepsAt = at != null ? at : null;
  if (!mepsShow) { sndMeps = null; drawChart(); return; }
  const req = ++sndMepsSeq;
  try {
    const r = await fetch('/api/meps/profile' + (sndMepsAt != null ? `?at=${Math.round(sndMepsAt)}` : ''));
    const d = await r.json();
    if (req !== sndMepsSeq) return;
    sndMeps = d;
  } catch (_) { sndMeps = null; }
  drawChart();
}

// Picker: Auto + every stored sounding (newest first)
async function loadSondeList() {
  const sel = document.getElementById('sonde-pick');
  try {
    const r = await fetch('/api/sondes');
    const d = await r.json();
    const keep = sel.value;
    sel.innerHTML = '<option value="auto">Auto</option>';
    for (const it of (d.items || [])) {
      const t = new Date(it.nominal * 1000);
      const o = document.createElement('option');
      o.value = it.key;
      o.textContent = `${t.getUTCDate()}.${t.getUTCMonth() + 1}. ${_pad(t.getUTCHours())} UTC` +
                      (it.min_p != null && it.min_p > 150 ? ` · to ${Math.round(it.min_p)} hPa` : '') +
                      (it.qc ? ' (cut)' : '');
      if (it.qc) o.title = `Top cut by the quality check: ${it.qc}`;
      sel.appendChild(o);
    }
    sel.value = [...sel.options].some(o => o.value === keep) ? keep : 'auto';
    sndSondePick = sel.value;
  } catch (_) { /* silent */ }
}

// d: /api/sounding… response; title: hover title; hint: text at the top of
// the diagram; lowQs: query of the matching airport low-level profile
function showProfile(d, header, metaPrefix, title, hint, lowQs, sfc) {
  const levels = (d.levels || []).slice().sort((a, b) => b.pressure - a.pressure);
  sndProfile = Object.assign({}, d, { levels });
  sndTitle = title; sndHint = hint; sndSfc = sfc || null;
  fillTable(levels, header);
  document.getElementById('sounding-meta').textContent =
    `${metaPrefix}${d.obs_used} obs used${d.aircraft != null ? ' · ' + d.aircraft + ' aircraft' : ''} · ${levels.length} levels`;
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
    const r = await fetch(`/api/sounding?minutes=${minutes}${rhShow ? '&moist=1' : ''}`);
    const d = await r.json();
    if (req !== sndReq) return;
    const win = d.window_min >= 120 ? `${d.window_min / 60} h` : `${d.window_min} min`;
    showProfile(d, `Area profile — ${d.radius_km} km, last ${win}`,
                d.generated_at ? `generated ${d.generated_at.substr(11, 5)} UTC · ` : '',
                `Area, last ${win}`, `Area profile, ${Math.round(d.radius_km)} km, last ${win}`,
                `minutes=${d.window_min}`, wxSfc);
    fetchSonde(null, null);
    fetchMeps(null);
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
  const prev = sndHourPick || sel.value;     // an hour clicked in the time–height section
  sndHourPick = null;
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
    const r = await fetch(`/api/sounding/hour?ts=${ts}${rhShow ? '&moist=1' : ''}`);
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
    fetchSonde(d.hour_ts + 3600, d.hour_ts + 1800);
    fetchMeps(d.hour_ts + 1800);
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
    if (t0 != null && t1 != null) fetchSonde(t1, (t0 + t1) / 2); else fetchSonde(null, null);
    fetchMeps(t0 != null && t1 != null ? (t0 + t1) / 2 : null);

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

const dqChk = document.getElementById('skewt-dq');
dqChk.checked = dqShow;
dqChk.addEventListener('change', e => {
  dqShow = e.target.checked;
  _lsSet('ms_skewtDq', String(dqShow));
  drawChart();
});

const sondeChk = document.getElementById('skewt-sonde');
sondeChk.checked = sondeShow;
sondeChk.addEventListener('change', e => {
  sondeShow = e.target.checked;
  _lsSet('ms_skewtSonde', String(sondeShow));
  if (sondeShow) loadSondeList();
  fetchSonde(sndSondeAt, sndSondeRef);
});
// RH strip (trial moisture indicator): the profile is loaded again with it
const rhChk = document.getElementById('skewt-rh');
if (rhChk) {
  rhChk.checked = rhShow;
  rhChk.addEventListener('change', e => {
    rhShow = e.target.checked;
    _lsSet('ms_skewtRH', String(rhShow));
    if (rhShow && sndProfile && sndMode !== 'flight' && !('moisture' in sndProfile)) loadCurrent();
    else drawChart();
  });
}
const mepsChk = document.getElementById('skewt-meps');
if (mepsChk) {
  mepsChk.checked = mepsShow;
  mepsChk.addEventListener('change', e => {
    mepsShow = e.target.checked;
    _lsSet('ms_skewtMeps', String(mepsShow));
    fetchMeps(sndMepsAt);
  });
}
const sondePick = document.getElementById('sonde-pick');
sondePick.style.display = sondeShow ? 'inline-block' : 'none';
sondePick.addEventListener('change', e => {
  sndSondePick = e.target.value;
  fetchSonde(sndSondeAt, sndSondeRef);
});
if (sondeShow) loadSondeList();
document.querySelectorAll('#sv-days-btns .snd-mode-btn').forEach(b =>
  b.addEventListener('click', () => { svDays = Number(b.dataset.days); _lsSet('ms_sondeVerifDays', String(svDays)); loadVerification(); }));

const aptSel = document.getElementById('apt-mode');
aptSel.value = aptMode;
aptSel.addEventListener('change', e => {
  aptMode = e.target.value;
  _lsSet('ms_aptMode', aptMode);
  fetchLow(sndLowQs);
});

document.getElementById('snd-idx-hide').addEventListener('click', () => setIdxShow(false));
document.getElementById('snd-idx-show').addEventListener('click', () => setIdxShow(true));
document.querySelector('.sounding-layout').classList.toggle('idx-hidden', !idxShow);

const canvasEl = document.getElementById('skewt-canvas');
canvasEl.addEventListener('mousemove', ev => { syncChart(); skewt.hover(ev); });
canvasEl.addEventListener('mouseleave', () => { syncChart(); skewt.leave(); });
new ResizeObserver(() => resizeChart()).observe(document.getElementById('skewt-box'));
window.onThemeChange = () => {
  drawChart();
  if (sndMode === 'verif') renderVerification();
  if (sndMode === 'meps') renderMepsCheck();
  if (sndMode === 'th') TimeHeight.render();
};

// ── Time–height section (timeheight.js); a click on a column opens that hour
TimeHeight.init({
  openHour(ts) {
    const d = new Date(ts * 1000);
    document.getElementById('snd-date').value =
      `${d.getUTCFullYear()}-${_pad(d.getUTCMonth() + 1)}-${_pad(d.getUTCDate())}`;
    sndHourPick = String(ts);
    setMode('hour');
  },
});

// ── Sonde check: automatic verification against the radiosonde ─────────────
// /api/sonde/verification (collector/sonde_verif.py): launch statistics,
// per band, difference by sounding age, list of verified launches.
let svDays = Number(_lsGet('ms_sondeVerifDays', '30')) || 30;
let svData = null;
let svGcal = null;           // /api/gnss/calibration
const _f = (v, d = 1, sign = false) => v == null ? '–' : (sign && v >= 0 ? '+' : '') + v.toFixed(d);

async function loadVerification() {
  document.querySelectorAll('#sv-days-btns .snd-mode-btn').forEach(b =>
    b.classList.toggle('active', Number(b.dataset.days) === svDays));
  const meta = document.getElementById('sounding-meta');
  meta.textContent = 'Loading…';
  try {
    const [r, g] = await Promise.all([fetch(`/api/sonde/verification?days=${svDays}`),
                                      fetch('/api/gnss/calibration').catch(() => null)]);
    svData = await r.json();
    try { svGcal = g && g.ok ? await g.json() : null; } catch (_) { svGcal = null; }
    meta.textContent = `last ${svDays} days · ${svData.launch_total.rows} launches · ${svData.hour_total.rows} hourly comparisons`;
    renderVerification();
  } catch (e) {
    meta.textContent = 'Error loading the verification.';
    console.error(e);
  }
}

function renderVerification() {
  const d = svData;
  if (!d) return;
  const L = d.launch_total, H = d.age;
  const late = H.filter(b => b.lo >= 10 && b.lo < 18 && b.n_t > 0);
  const lateT = late.length ? Math.sqrt(late.reduce((s, b) => s + b.t_rms * b.t_rms * b.n_t, 0) / late.reduce((s, b) => s + b.n_t, 0)) : null;
  const lateW = late.length && late.some(b => b.w_rms != null)
    ? Math.sqrt(late.reduce((s, b) => s + (b.w_rms || 0) ** 2 * b.n_w, 0) / Math.max(1, late.reduce((s, b) => s + b.n_w, 0))) : null;
  const tile = (v, l) => `<div class="sv-tile"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  document.getElementById('sv-tiles').innerHTML = [
    tile(`${L.rows}`, `launches verified · ${L.n_t} temperature layers`),
    tile(L.t_bias == null ? '–' : `${_f(L.t_bias, 1, true)} <small>± ${_f(L.t_sd)} K</small>`, `temperature, area − sonde at launch (RMS ${_f(L.t_rms)} K)`),
    tile(L.w_rms == null ? '–' : `${_f(L.w_rms, 1)} <small>kt</small>`, `wind vector RMS at launch (speed ${_f(L.ws_bias, 1, true)} kt)`),
    tile(lateT != null ? `${lateT.toFixed(1)} <small>K</small> · ${lateW != null ? lateW.toFixed(0) : '–'} <small>kt</small>` : '–',
         'RMS when the sounding is 10–18 h old'),
  ].join('');
  ageChart('sv-age-t', H, 't_rms', 'K', L.t_rms);
  ageChart('sv-age-w', H, 'w_rms', 'kt', L.w_rms);
  // bands
  const BN = { '0-5k': '0–5 000 ft', '5-10k': '5–10 000 ft', '10-20k': '10–20 000 ft', '20-30k': '20–30 000 ft', '30k+': '> 30 000 ft' };
  const tcOn = !!d.tcorr;
  document.getElementById('sv-bands').innerHTML = d.bands.length
    ? `<thead><tr><th>Band</th><th class="num">Layers T / W</th><th class="num">T bias (K)</th>` +
      (tcOn ? `<th class="num" title="The bias with the upper-level temperature correction of the Skew-T and the time–height section (learnt from the MEPS model)">corrected</th>` : '') +
      `<th class="num">T SD</th><th class="num">T RMS</th><th class="num">Wind RMS (kt)</th><th class="num">Speed bias</th></tr></thead><tbody>` +
      d.bands.map(b => `<tr><td style="white-space:nowrap">${(BN[b.band] || b.band).replace(/ /g, '\u00a0')}</td><td class="num text-dim">${b.n_t} / ${b.n_w}</td><td class="num">${_f(b.t_bias, 2, true)}</td>` +
        (tcOn ? `<td class="num text-dim">${b.t_bias_corr != null ? _f(b.t_bias_corr, 2, true) : ''}</td>` : '') +
        `<td class="num">${_f(b.t_sd, 2)}</td><td class="num">${_f(b.t_rms, 2)}</td><td class="num">${_f(b.w_rms, 1)}</td><td class="num">${_f(b.ws_bias, 1, true)}</td></tr>`).join('') + '</tbody>' +
      (tcOn ? `<tfoot><tr><td colspan="8" class="text-dim" style="padding:4px 6px">${tcorrText(d.tcorr)}</td></tr></tfoot>` : '')
    : '<tbody><tr><td class="sv-empty">No verified launches in this period yet.</td></tr></tbody>';
  // launches
  document.getElementById('sv-launches').innerHTML = d.launches.length
    ? `<thead><tr><th>Launch (UTC)</th><th class="num" title="Highest level of the sounding">Top (hPa)</th><th class="num" title="Distinct aircraft behind the area profile (±1 h)">Aircraft</th><th class="num">Layers T / W</th><th class="num">T bias (K)</th><th class="num">T RMS</th><th class="num">Wind RMS (kt)</th><th class="num">Speed bias</th></tr></thead><tbody>` +
      d.launches.map(r => {
        const t = new Date(r.ts * 1000);
        const low = r.aircraft != null && r.aircraft < 16;      // < 8 per hour of the 2-h window
        return `<tr><td>${t.getUTCFullYear()}-${_pad(t.getUTCMonth() + 1)}-${_pad(t.getUTCDate())} ${_pad(t.getUTCHours())}:${_pad(t.getUTCMinutes())}</td>` +
          `<td class="num">${r.min_p != null ? Math.round(r.min_p) : '–'}</td>` +
          `<td class="num ${low ? 'snd-weak' : ''}" title="${low ? 'few aircraft (LOW data)' : ''}">${r.aircraft ?? '–'}</td>` +
          `<td class="num text-dim">${r.n_t} / ${r.n_w}</td><td class="num">${_f(r.t_bias, 1, true)}</td><td class="num ${r.t_rms > 2 ? 'snd-dev' : ''}">${_f(r.t_rms, 1)}</td>` +
          `<td class="num ${r.w_rms > 15 ? 'snd-dev' : ''}">${_f(r.w_rms, 1)}</td><td class="num">${_f(r.ws_bias, 1, true)}</td></tr>`;
      }).join('') + '</tbody>'
    : '<tbody><tr><td class="sv-empty">No verified launches in this period yet — a launch is verified once the hour after it is over and the sounding is stored.</td></tr></tbody>';
  renderGnssCal();
}

// The upper-level temperature correction (collector/tcorr.py) in words
function tcorrText(tc) {
  if (!tc || !tc.corr) return '';
  const lv = Object.keys(tc.corr).map(Number).sort((a, b) => b - a)
    .map(p => `${p} hPa ${_f(tc.corr[p], 2, true)}`).join(' · ');
  const n = Math.max(0, ...Object.values(tc.n || {}).map(v => v || 0));
  return `The values here are the raw Mach/TAS temperatures. The Skew-T and the time–height section correct the fleet's warm bias at the upper levels: ${lv} K ` +
    `(learnt from ${n} hours of the MEPS model, last ${tc.days || 21} days, updated ${tc.ts ? new Date(tc.ts * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '–'}; nothing below about FL180).`;
}

// GNSS height calibration (collector/gnss_heights.py): band correction,
// per-type and per-airframe offsets
function renderGnssCal() {
  const g = svGcal;
  const elB = document.getElementById('sv-gcal-bands'), elT = document.getElementById('sv-gcal-types'),
        elA = document.getElementById('sv-gcal-af');
  if (!elB) return;
  if (!g) { elB.innerHTML = elT.innerHTML = elA.innerHTML = '<tbody><tr><td class="sv-empty">No calibration available.</td></tr></tbody>'; return; }
  const ft = v => v >= 40000 ? '40 000+' : `${(v / 1000).toFixed(0)}–${((v + 5000) / 1000).toFixed(0)} 000`;
  elB.innerHTML = `<thead><tr><th>Band (ft)</th><th class="num" title="Subtracted from pressure altitude + GNSS − baro">Correction (m)</th><th class="num" title="Airframe cells (airframe × sounding) behind the value">Cells</th><th class="num" title="Built-in starting value (October 2026)">Default</th></tr></thead><tbody>` +
    g.bands.map(b => `<tr><td style="white-space:nowrap">${ft(b.ft[0]).replace(/ /g, '\u00a0')}</td><td class="num">${_f(b.corr_m, 1, true)}</td>` +
      `<td class="num ${b.cells < 5 ? 'snd-weak' : 'text-dim'}">${b.cells}</td><td class="num text-dim">${_f(b.prior_m, 1, true)}</td></tr>`).join('') +
    `</tbody><tfoot><tr><td colspan="4" class="text-dim" style="padding:4px 6px">${g.soundings || 0} soundings · ${g.pairs || 0} pairs` +
    (g.computed ? ` · fitted ${new Date(g.computed * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '') + '</td></tr></tfoot>';
  elT.innerHTML = g.by_type && g.by_type.length
    ? `<thead><tr><th>Type</th><th class="num">Airframes</th><th class="num">Mean (m)</th><th class="num">SD</th></tr></thead><tbody>` +
      g.by_type.map(t => `<tr><td>${t.type}</td><td class="num text-dim">${t.airframes}</td><td class="num">${_f(t.mean_m, 1, true)}</td><td class="num text-dim">${_f(t.sd_m, 1)}</td></tr>`).join('') + '</tbody>'
    : '<tbody><tr><td class="sv-empty">Types appear with 2 or more calibrated airframes.</td></tr></tbody>';
  const A = g.airframe_list || [];
  elA.innerHTML = A.length
    ? `<thead><tr><th>ICAO</th><th>Reg.</th><th>Type</th><th class="num" title="Soundings the airframe was compared with">Soundings</th><th class="num" title="Mean residual of its soundings after the band correction">Raw (m)</th><th class="num" title="Offset applied (shrunk towards 0: n / (n + 3) of the raw mean)">Used (m)</th></tr></thead><tbody>` +
      A.map(r => `<tr><td class="mono">${r.icao}</td><td>${r.reg || '–'}</td><td>${r.type || '–'}</td><td class="num text-dim">${r.soundings ?? '–'}</td>` +
        `<td class="num ${Math.abs(r.raw_m || 0) > 15 ? 'snd-dev' : ''}">${_f(r.raw_m, 1, true)}</td><td class="num">${_f(r.offset_m, 1, true)}</td></tr>`).join('') + '</tbody>'
    : '<tbody><tr><td class="sv-empty">No airframes calibrated yet — they appear after the first soundings.</td></tr></tbody>';
}

// RMS by age bin as columns (SVG); dashed line = the RMS at launch (±1 h)
function ageChart(id, bins, key, unit, ref) {
  const el = document.getElementById(id);
  const B = bins.filter(b => b[key] != null);
  if (!B.length) { el.innerHTML = '<div class="sv-empty">No hourly comparisons in this period yet.</div>'; return; }
  const light = document.documentElement.dataset.theme === 'light';
  const C = { bar: light ? '#2a78d6' : '#3987e5', ink: light ? '#1e293b' : '#e2e8f0', ink2: light ? '#475569' : '#94a3b8',
              grid: light ? '#d8e0e8' : '#1e2a3a', ref: light ? '#c2410c' : '#fb923c' };
  const W = 560, H = 236, ml = 40, mr = 12, mt = 24, mb = 38;
  const pw = W - ml - mr, ph = H - mt - mb;
  const ymax = Math.max(...B.map(b => b[key]), ref || 0) * 1.18;
  const step = ymax > 20 ? 10 : ymax > 8 ? 2 : ymax > 3 ? 1 : 0.5;
  const y = v => mt + ph - v / ymax * ph;
  const bw = pw / B.length;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${unit === 'K' ? 'Temperature' : 'Wind'} RMS difference by sounding age">`;
  for (let v = 0; v <= ymax + 1e-9; v += step) {
    svg += `<line x1="${ml}" x2="${W - mr}" y1="${y(v)}" y2="${y(v)}" stroke="${C.grid}" stroke-width="1"/>` +
           `<text x="${ml - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="${C.ink2}">${v % 1 ? v.toFixed(1) : v}</text>`;
  }
  B.forEach((b, i) => {
    const x = ml + i * bw + bw * 0.18, w = bw * 0.64, v = b[key];
    const h = Math.max(1, mt + ph - y(v));
    svg += `<g><title>${b.lo}–${b.hi} h old: RMS ${v.toFixed(unit === 'K' ? 2 : 1)} ${unit} (${b.rows} hours, ${unit === 'K' ? b.n_t : b.n_w} layers)</title>` +
           `<path d="M${x},${mt + ph} v${-(h - 4)} q0,-4 4,-4 h${w - 8} q4,0 4,4 v${h - 4} z" fill="${C.bar}"/>` +
           `<text x="${x + w / 2}" y="${y(v) - 5}" text-anchor="middle" font-size="11" font-weight="600" fill="${C.ink}">${v.toFixed(unit === 'K' ? 1 : 0)}</text>` +
           `<text x="${x + w / 2}" y="${mt + ph + 15}" text-anchor="middle" font-size="11" fill="${C.ink2}">${b.lo}–${b.hi}</text></g>`;
  });
  if (ref != null) {
    svg += `<line x1="${ml}" x2="${W - mr}" y1="${y(ref)}" y2="${y(ref)}" stroke="${C.ref}" stroke-width="1.5" stroke-dasharray="5 4"/>` +
           `<line x1="${W - mr - 150}" x2="${W - mr - 128}" y1="10" y2="10" stroke="${C.ref}" stroke-width="1.5" stroke-dasharray="5 4"/>` +
           `<text x="${W - mr}" y="14" text-anchor="end" font-size="11" fill="${C.ref}">at launch (±1 h): ${ref.toFixed(unit === 'K' ? 1 : 0)} ${unit}</text>`;
  }
  svg += `<text x="${ml + pw / 2}" y="${H - 4}" text-anchor="middle" font-size="11" fill="${C.ink2}">age of the sounding (h) — hourly area profile vs the newest earlier sounding</text>`;
  svg += `<text x="12" y="${mt + ph / 2}" text-anchor="middle" font-size="11" fill="${C.ink2}" transform="rotate(-90 12 ${mt + ph / 2})">RMS (${unit})</text></svg>`;
  el.innerHTML = svg;
}

// ── MEPS check: Mode S minus the MEPS model every hour (/api/meps/check) ────
let mcDays = Number(_lsGet('ms_mepsCheckDays', '7')) || 7;
let mcBusy = _lsGet('ms_mepsCheckBusy', 'false') === 'true';
let mcData = null;

async function loadMepsCheck() {
  document.querySelectorAll('#mc-days-btns .snd-mode-btn').forEach(b =>
    b.classList.toggle('active', Number(b.dataset.days) === mcDays));
  document.getElementById('mc-busy').checked = mcBusy;
  const meta = document.getElementById('sounding-meta');
  meta.textContent = 'Loading…';
  try {
    const r = await fetch(`/api/meps/check?days=${mcDays}&busy=${mcBusy ? 8 : 0}`);
    mcData = await r.json();
    meta.textContent = `last ${mcDays} days · ${mcData.hours || 0} hours compared` +
      (mcData.newest_run ? ` · newest model run ${_utc(mcData.newest_run)}` : '');
    renderMepsCheck();
  } catch (e) {
    meta.textContent = 'Error loading the MEPS check.';
    console.error(e);
  }
}

function _utc(ts) {
  const t = new Date(ts * 1000);
  return `${t.getUTCDate()}.${t.getUTCMonth() + 1}. ${_pad(t.getUTCHours())} UTC`;
}

function renderMepsCheck() {
  const d = mcData;
  if (!d) return;
  const tile = (v, l) => `<div class="sv-tile"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  const T = d.totals || {}, A = T.all || {}, Dy = T.day || {}, Nt = T.night || {};
  const L = (d.levels || []).slice().sort((a, b) => b.p - a.p);
  const hd = L.filter(l => l.n_d >= 3);
  const dPool = hd.length ? {
    bias: hd.reduce((s, l) => s + l.d_bias * l.n_d, 0) / hd.reduce((s, l) => s + l.n_d, 0),
    sd: Math.sqrt(hd.reduce((s, l) => s + (l.d_sd || 0) ** 2 * l.n_d, 0) / hd.reduce((s, l) => s + l.n_d, 0)),
    n: Math.max(...hd.map(l => l.n_d)) } : null;
  const st = document.getElementById('mc-status');
  const s = d.status;
  st.textContent = s && s.last ? ` Last fetch ${new Date(s.last.ts * 1000).toISOString().slice(11, 16)} UTC: ${s.last.result}.` :
                   (s && !s.enabled ? ' Fetching is off (MEPS_FETCH = False).' : '');
  if (!d.hours_meps) {
    document.getElementById('mc-tiles').innerHTML = tile('–', 'no model data stored yet — the first runs are fetched a few minutes after the start, about 2–3 h after each run time (00, 03, 06 … UTC)');
    ['mc-chart-t', 'mc-chart-w'].forEach(id => document.getElementById(id).innerHTML = '<div class="sv-empty">No model data in this period yet.</div>');
    document.getElementById('mc-levels').innerHTML = document.getElementById('mc-sondes').innerHTML = '';
    document.getElementById('mc-dist').innerHTML = '';
    return;
  }
  document.getElementById('mc-tiles').innerHTML = [
    tile(`${d.hours || 0}`, `hours compared · ${d.hours_meps} model hours stored`),
    tile(A.t_bias == null ? '–' : `${_f(A.t_bias, 2, true)} <small>K · RMS ${_f(A.t_rms, 2)}</small>`,
         `temperature, Mode S − MEPS, 925–200 hPa (day ${_f(Dy.t_rms, 2)} / night ${_f(Nt.t_rms, 2)} K RMS)`),
    tile(A.w_rms == null ? '–' : `${_f(A.w_rms, 1)} <small>kt</small>`,
         `wind vector RMS (day ${_f(Dy.w_rms, 1)} / night ${_f(Nt.w_rms, 1)} kt)`),
    tile(dPool ? `${_f(dPool.bias, 1, true)} <small>m · SD ${_f(dPool.sd, 1)}</small>` : '–',
         dPool ? `heights of the pressure surfaces (GNSS) − MEPS, 850–250 hPa` : 'heights: no GNSS height hours in this period'),
  ].join('');
  levelChart('mc-chart-t', L, 't_rms', 't_bias', 'K', 'n_t');
  levelChart('mc-chart-w', L, 'w_rms', 'ws_bias', 'kt', 'n_w');
  document.getElementById('mc-levels').innerHTML = L.length
    ? `<thead><tr><th>Level</th><th class="num" title="Pressure altitude (standard atmosphere)">≈ ft</th><th class="num">Hours</th><th class="num">T mean (K)</th><th class="num">T SD</th><th class="num">T RMS</th>` +
      (d.tcorr ? `<th class="num" title="Correction added to the Mode S temperature in the Skew-T and the time–height section at this level (learnt from these differences, last ${d.tcorr.days || 21} days, shrunk while there are few hours); this table compares the raw values">Correction</th>` : '') +
      `<th class="num">Wind RMS (kt)</th><th class="num">Speed diff.</th><th class="num" title="Height of the pressure surface from the aircraft GNSS heights minus MEPS (m), and the correlation of the hourly values">Height diff. (m)</th><th class="num">SD</th><th class="num">r</th></tr></thead><tbody>` +
      L.map(l => `<tr><td>${l.p} hPa</td><td class="num text-dim">${l.ft.toLocaleString()}</td><td class="num text-dim">${l.n_t}</td>` +
        `<td class="num">${_f(l.t_bias, 2, true)}</td><td class="num">${_f(l.t_sd, 2)}</td><td class="num ${l.t_rms > 1.5 ? 'snd-dev' : ''}">${_f(l.t_rms, 2)}</td>` +
        (d.tcorr ? `<td class="num text-dim">${d.tcorr.corr && d.tcorr.corr[String(l.p)] != null ? _f(d.tcorr.corr[String(l.p)], 2, true) : ''}</td>` : '') +
        `<td class="num ${l.w_rms > 12 ? 'snd-dev' : ''}">${_f(l.w_rms, 1)}</td><td class="num">${_f(l.ws_bias, 1, true)}</td>` +
        `<td class="num">${l.n_d ? _f(l.d_bias, 1, true) : '–'}</td><td class="num text-dim">${l.n_d ? _f(l.d_sd, 1) : '–'}</td><td class="num text-dim">${l.d_r != null ? l.d_r.toFixed(3) : '–'}</td></tr>`).join('') + '</tbody>'
    : '<tbody><tr><td class="sv-empty">No hours with both a Mode S profile and the model in this period.</td></tr></tbody>';
  const D = d.distance;
  document.getElementById('mc-dist').innerHTML = D
    ? `Temperature (${D.n} level values): Mode S − sonde <b>${_f(D.t_as, 2)} K</b> RMS, Mode S − MEPS <b>${_f(D.t_am, 2)} K</b>; ` +
      `the model's own difference between the Helsinki area and Jokioinen explains <b>${Math.round(D.t_explained * 100)} %</b> of the Mode S − sonde difference.` +
      (D.w_as != null ? `<br>Wind: Mode S − sonde <b>${_f(D.w_as, 1)} kt</b>, Mode S − MEPS <b>${_f(D.w_am, 1)} kt</b>; distance explains <b>${Math.round(D.w_explained * 100)} %</b>.` : '')
    : 'The distance check needs a few soundings with both the model and a Mode S profile in this period.';
  const S = d.soundings || [];
  document.getElementById('mc-sondes').innerHTML = S.length
    ? `<thead><tr><th>Launch (UTC)</th><th class="num">Aircraft</th>` +
      `<th class="num" title="Mode S area profile − radiosonde, mean over 925–200 hPa">T: Mode S − sonde</th><th class="num" title="Mode S − MEPS over the same area">− MEPS</th>` +
      `<th class="num" title="MEPS at Jokioinen − radiosonde (the model takes the sounding in, so this is small by construction)">MEPS − sonde</th><th class="num" title="MEPS mean over the Helsinki area − MEPS at Jokioinen: the difference the distance makes">MEPS area − Jok.</th>` +
      `<th class="num" title="Wind vector RMS, Mode S − sonde">Wind: − sonde</th><th class="num" title="Wind vector RMS, Mode S − MEPS">− MEPS</th></tr></thead><tbody>` +
      S.map(r => {
        const t = new Date(r.ts * 1000);
        const big = v => v != null && Math.abs(v) >= 1 ? 'snd-dev' : '';
        return `<tr><td>${t.getUTCFullYear()}-${_pad(t.getUTCMonth() + 1)}-${_pad(t.getUTCDate())} ${_pad(t.getUTCHours())}:${_pad(t.getUTCMinutes())}</td>` +
          `<td class="num ${r.aircraft != null && r.aircraft < 8 ? 'snd-weak' : 'text-dim'}">${r.aircraft ?? '–'}</td>` +
          `<td class="num ${big(r.t_as)}">${_f(r.t_as, 2, true)}</td><td class="num">${_f(r.t_am, 2, true)}</td>` +
          `<td class="num text-dim">${_f(r.t_js, 2, true)}</td><td class="num ${big(r.t_aj)}">${_f(r.t_aj, 2, true)}</td>` +
          `<td class="num">${_f(r.w_as, 1)}</td><td class="num">${_f(r.w_am, 1)}</td></tr>`;
      }).join('') + '</tbody>'
    : '<tbody><tr><td class="sv-empty">No soundings with model data in this period.</td></tr></tbody>';
}

// Horizontal bars by pressure level (SVG): bar = RMS, dot = mean difference
function levelChart(id, levels, keyR, keyB, unit, keyN) {
  const el = document.getElementById(id);
  const L = levels.filter(l => l[keyR] != null && l.p >= 200 && l.p <= 925);
  if (!L.length) { el.innerHTML = '<div class="sv-empty">No comparisons in this period yet.</div>'; return; }
  const light = document.documentElement.dataset.theme === 'light';
  const C = { bar: light ? '#2a78d6' : '#3987e5', dot: light ? '#c2410c' : '#fb923c', ink: light ? '#1e293b' : '#e2e8f0',
              ink2: light ? '#475569' : '#94a3b8', grid: light ? '#d8e0e8' : '#1e2a3a', zero: light ? '#94a3b8' : '#475569' };
  const W = 560, rowH = 22, mt = 10, mb = 30, ml = 66, mr = 54;
  const H = mt + mb + rowH * L.length;
  const lo = Math.min(0, ...L.map(l => l[keyB] ?? 0)), hi = Math.max(...L.map(l => l[keyR]), ...L.map(l => l[keyB] ?? 0));
  const span = (hi - lo) * 1.12 || 1;
  const x = v => ml + (v - lo) / span * (W - ml - mr);
  const step = span > 20 ? 5 : span > 8 ? 2 : span > 3 ? 1 : span > 1.5 ? 0.5 : 0.25;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Mode S minus MEPS by pressure level">`;
  for (let v = Math.ceil(lo / step) * step; v <= lo + span + 1e-9; v += step) {
    svg += `<line x1="${x(v)}" x2="${x(v)}" y1="${mt}" y2="${H - mb}" stroke="${Math.abs(v) < 1e-9 ? C.zero : C.grid}" stroke-width="1"/>` +
           `<text x="${x(v)}" y="${H - mb + 14}" text-anchor="middle" font-size="11" fill="${C.ink2}">${+v.toFixed(2)}</text>`;
  }
  L.forEach((l, i) => {
    const y = mt + i * rowH + 4, h = rowH - 8, v = l[keyR], b = l[keyB];
    svg += `<g><title>${l.p} hPa (≈ ${l.ft.toLocaleString()} ft): RMS ${v.toFixed(unit === 'K' ? 2 : 1)} ${unit}` +
           (b != null ? `, mean ${b >= 0 ? '+' : ''}${b.toFixed(unit === 'K' ? 2 : 1)} ${unit}` : '') + ` (${l[keyN]} hours)</title>` +
           `<text x="${ml - 8}" y="${y + h - 3}" text-anchor="end" font-size="11" fill="${C.ink2}">${l.p} hPa</text>` +
           `<rect x="${x(0)}" y="${y}" width="${Math.max(1, x(v) - x(0))}" height="${h}" rx="3" fill="${C.bar}" opacity="0.85"/>` +
           `<text x="${x(v) + 5}" y="${y + h - 3}" font-size="11" font-weight="600" fill="${C.ink}">${v.toFixed(unit === 'K' ? 2 : 1)}</text>` +
           (b != null ? `<circle cx="${x(b)}" cy="${y + h / 2}" r="4.5" fill="${C.dot}" stroke="${light ? '#fff' : '#0b1220'}" stroke-width="1.5"/>` : '') + '</g>';
  });
  svg += `<text x="${ml + (W - ml - mr) / 2}" y="${H - 4}" text-anchor="middle" font-size="11" fill="${C.ink2}">${unit} — bar: RMS difference, dot: mean (${unit === 'K' ? 'Mode S warmer when positive' : 'Mode S faster when positive'})</text></svg>`;
  el.innerHTML = svg;
}

document.querySelectorAll('#mc-days-btns .snd-mode-btn').forEach(b =>
  b.addEventListener('click', () => { mcDays = Number(b.dataset.days); _lsSet('ms_mepsCheckDays', String(mcDays)); loadMepsCheck(); }));
document.getElementById('mc-busy').addEventListener('change', e => {
  mcBusy = e.target.checked; _lsSet('ms_mepsCheckBusy', String(mcBusy)); loadMepsCheck();
});

// ── Startup ───────────────────────────────────────────────────────────────
document.querySelectorAll('#snd-mode-btns .snd-mode-btn').forEach(b =>
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
