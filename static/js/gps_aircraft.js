/**
 * static/js/gps_aircraft.js — GPS Aircraft page (/gps-aircraft), from 2026-11-08
 *
 * The GPS degradation history of one aircraft (ICAO24, registration), of
 * every aircraft that flew a callsign, or of a type (AT75 …): the days as
 * bars and a calendar, coloured from clean to heavy, next to the share of all
 * aircraft degraded that day, and the flights with their episodes.
 *
 * Data: GET /api/gps/aircraft?q=<text>&days=<n>  (web/api/gps_aircraft.py)
 * Address: /gps-aircraft?q=OH-ATM&days=30 (kept in sync with the controls).
 */
'use strict';

const $ = id => document.getElementById(id);
const pad2 = n => String(n).padStart(2, '0');
const isLight = () => document.documentElement.dataset.theme === 'light';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Day categories by the degraded minutes per flight (muted, as the other GPS pages)
const PAL = {
  dark:  { none: '#2a3140', clean: '#5f9d84', light: '#c9b26e', mod: '#d0894f', heavy: '#c96a6a', spoof: '#c995ad',
           bar: '#4b5563', all: '#94a3b8', grid: '#2b3442', text: '#9aa4b2', nacp: '#cf9f6b', nic: '#c995ad',
           freeze: '#88b6cd', gap: '#a8a0d0', adsb: '#76ad9f' },
  light: { none: '#e5e7eb', clean: '#3a7a6d', light: '#c4aa2c', mod: '#c0712a', heavy: '#a94f4f', spoof: '#9c5577',
           bar: '#cbd5e1', all: '#64748b', grid: '#e2e8f0', text: '#475569', nacp: '#a06b2e', nic: '#9c5577',
           freeze: '#3d7896', gap: '#6a5fa3', adsb: '#3a7a6d' },
};
const P = () => PAL[isLight() ? 'light' : 'dark'];
const CAT_LABEL = { none: 'no flights', clean: 'clean', light: '< 1 min / flight', mod: '1–5 min / flight', heavy: '≥ 5 min / flight' };
const SIG = { nacp: 'NACp', nic: 'NIC', freeze: 'FRZ', gap: 'GAP', adsb_loss: 'LOSS' };

function cat(d) {
  if (!d || (!d.flights && !d.episodes)) return 'none';
  if (!d.episodes) return 'clean';
  const m = d.deg_s / 60 / Math.max(1, d.flights || d.deg_flights || 1);
  return m < 1 ? 'light' : m < 5 ? 'mod' : 'heavy';
}
const catCol = c => P()[c];
const fmtDur = s => s == null ? '—' : `${Math.floor(s / 60)}:${pad2(Math.round(s % 60))}`;
const fmtT = ts => { const d = new Date(ts * 1000); return `${d.getUTCDate()}.${d.getUTCMonth() + 1}. ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; };
const hhmm = ts => { const d = new Date(ts * 1000); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; };
const dayLbl = iso => { const [y, m, d] = iso.split('-'); return `${+d}.${+m}.`; };
const WD = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

// ── State ────────────────────────────────────────────────────────────────────
let data = null;
let days = 30;
let selDay = '';
let showAll = false;

// ── Load ─────────────────────────────────────────────────────────────────────
async function load() {
  const q = $('gpa-q').value.trim();
  const qs = new URLSearchParams(); if (q) qs.set('q', q); qs.set('days', days);
  history.replaceState(null, '', '/gps-aircraft?' + qs.toString());
  try { localStorage.setItem('ms_gpa_days', String(days)); } catch (_) {}
  if (!q) { $('gpa-result').hidden = true; $('gpa-intro').hidden = false; $('gpa-status').textContent = ''; return; }
  $('gpa-status').textContent = 'Loading…';
  try {
    const r = await fetch(`/api/gps/aircraft?${qs}`);
    if (!r.ok) throw new Error(r.status);
    data = await r.json();
  } catch (e) { $('gpa-status').textContent = 'Load failed'; return; }
  selDay = ''; showAll = false;
  const now = new Date();
  $('gpa-status').textContent = `updated ${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())} UTC`;
  render();
}

// Every day of the period, also the empty ones
function allDays() {
  const by = new Map((data.day || []).map(d => [d.d, d]));
  const out = [];
  const t0 = data.t_from * 1000, today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  for (let t = t0; t <= today; t += 86400000) {
    const iso = new Date(t).toISOString().slice(0, 10);
    out.push(by.get(iso) || { d: iso, flights: iso >= (data.counted_from || '9999') ? 0 : null, deg_flights: 0, episodes: 0, deg_s: 0, spoof: 0, nacp: null, nic: null });
  }
  return out;
}

// ── Render ───────────────────────────────────────────────────────────────────
function render() {
  if (!data) return;
  $('gpa-intro').hidden = true;
  $('gpa-result').hidden = false;
  if (!data.aircraft || !data.aircraft.length) {
    $('gpa-title').innerHTML = `<span class="gpa-none">No aircraft found for “${esc(data.query)}”.</span>`;
    $('gpa-kpis').innerHTML = $('gpa-acs').innerHTML = $('gpa-chart').innerHTML = $('gpa-cal').innerHTML = '';
    $('gpa-tbody').innerHTML = ''; $('gpa-note').textContent = ''; $('gpa-fl-sum').textContent = ''; $('gpa-cal-leg').innerHTML = '';
    return;
  }
  renderHead();
  renderChart();
  renderCal();
  renderFlights();
  const n = [];
  n.push(`Flights = the passes through the receivers' coverage stored per aircraft (from ${dayLbl(data.flights_from)}; older days from the daily roll-up${data.rolled_from ? ' of ' + dayLbl(data.rolled_from) + ' on' : ''}; before that only the episodes are known).`);
  n.push(`Episodes are counted within ${Math.round(data.radius_nm)} NM of ${GPA_AIRPORT} and above 1 000 ft; low flights far from the receivers are not heard.`);
  n.push('All traffic = the share of all aircraft-hours with a degradation signal that day (GPS Quality page).');
  n.push(`The flight list covers the last ${GPA_HSER_DAYS} days. Military, government and police aircraft are not shown.`);
  $('gpa-note').textContent = n.join(' ');
}

function renderHead() {
  const ac = data.aircraft;
  const k = data.kind;
  let title;
  if (ac.length === 1) {
    const a = ac[0];
    title = `<b>${esc(a.reg || a.icao)}</b> <span class="gpa-dim">${esc(a.type || '')} · ICAO24 ${esc(a.icao)}</span>`;
  } else {
    title = `<b>${esc(data.query)}</b> <span class="gpa-dim">${k === 'type' ? 'type' : k === 'callsign' ? 'callsign' : 'aircraft'} · ${ac.length} aircraft</span>`;
  }
  const ds = allDays();
  const fl = ds.reduce((s, d) => s + (d.flights || 0), 0);
  const known = ds.filter(d => d.flights != null);
  const flK = known.reduce((s, d) => s + d.flights, 0), dfK = known.reduce((s, d) => s + d.deg_flights, 0);
  const eps = ds.reduce((s, d) => s + d.episodes, 0);
  const degS = ds.reduce((s, d) => s + d.deg_s, 0);
  const spf = ds.reduce((s, d) => s + (d.spoof || 0), 0);
  const cats = {}; ds.forEach(d => { const c = cat(d); cats[c] = (cats[c] || 0) + 1; });
  const minP = Math.min(...ds.filter(d => d.nacp != null).map(d => d.nacp));
  const minI = Math.min(...ds.filter(d => d.nic != null).map(d => d.nic));
  const pct = flK ? Math.round(100 * dfK / flK) : null;
  const kp = [
    [fl, 'flights seen'],
    [pct != null ? `${dfK} (${pct} %)` : '—', 'with GPS degradation'],
    [eps, 'episodes'],
    [degS >= 3600 ? (degS / 3600).toFixed(1).replace(/\.0$/, '') + ' h' : Math.round(degS / 60) + ' min', 'degraded'],
    [fl ? (degS / 60 / Math.max(1, fl)).toFixed(1) + ' min' : '—', 'per flight'],
    [`${cats.clean || 0} / ${(cats.light || 0) + (cats.mod || 0)} / ${cats.heavy || 0}`, 'clean / light–moderate / heavy days'],
    [isFinite(minP) ? `${minP} / ${isFinite(minI) ? minI : '–'}` : '—', 'lowest NACp / NIC'],
    [spf, 'episodes with spoofing indicators'],
  ];
  const ic = ac.map(a => a.icao).join(',');
  $('gpa-title').innerHTML = title +
    ` <a class="gps-switch-btn gpa-map" href="/gps-episodes?icao=${ic}&window=${days ? days * 86400 : 0}" title="These episodes on the GPS Episodes map">On the map ›</a>`;
  $('gpa-kpis').innerHTML = kp.map(([v, l]) => `<div class="gpa-kpi"><div class="gpa-kv">${esc(v)}</div><div class="gpa-kl">${esc(l)}</div></div>`).join('');
  $('gpa-acs').innerHTML = ac.length > 1
    ? ac.slice(0, 60).map(a => `<a href="#" class="gpa-ac" data-q="${esc(a.icao)}" title="ICAO24 ${esc(a.icao)} · ${a.flights} flights · ${a.episodes} episodes">${esc(a.reg || a.icao)}${a.type && data.kind !== 'type' ? ' ' + esc(a.type) : ''} <span class="gpa-dim">${a.episodes}</span></a>`).join('')
      + (ac.length > 60 ? ` <span class="gpa-dim">+${ac.length - 60}</span>` : '')
    : '';
  $('gpa-th-ac').style.display = ac.length > 1 ? '' : 'none';
}

// Bars: flights (grey) with the degraded flights in the day's colour; line: the
// share of all aircraft degraded (right axis) and dots: this aircraft's share
function renderChart() {
  const el = $('gpa-chart');
  const ds = allDays();
  const W = Math.max(320, el.clientWidth || 900), H = 210, L = 34, R = 38, T = 14, B = 30;
  const n = ds.length, bw = (W - L - R) / n;
  const maxF = Math.max(1, ...ds.map(d => Math.max(d.flights || 0, d.deg_flights || 0)));
  const step = maxF > 40 ? 20 : maxF > 20 ? 10 : maxF > 8 ? 5 : maxF > 4 ? 2 : 1;
  const top = Math.ceil(maxF / step) * step;
  const Y = v => T + (H - T - B) * (1 - v / top), Yp = p => T + (H - T - B) * (1 - p);
  const c = P();
  const o = [];
  for (let v = 0; v <= top; v += step) o.push(`<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="${c.grid}"/><text x="${L - 4}" y="${Y(v) + 3}" text-anchor="end" class="gpa-ax">${v}</text>`);
  for (const p of [0, 0.5, 1]) o.push(`<text x="${W - R + 4}" y="${Yp(p) + 3}" class="gpa-ax">${p * 100}%</text>`);
  const lblEvery = Math.ceil(n / Math.floor((W - L - R) / 34));
  ds.forEach((d, i) => {
    const x = L + i * bw, w = Math.max(1, bw - (bw > 6 ? 2 : 0.5));
    const k = cat(d);
    if (d.flights) o.push(`<rect x="${x}" y="${Y(d.flights)}" width="${w}" height="${Y(0) - Y(d.flights)}" fill="${c.bar}" opacity="0.55"/>`);
    if (d.deg_flights) o.push(`<rect x="${x}" y="${Y(d.deg_flights)}" width="${w}" height="${Y(0) - Y(d.deg_flights)}" fill="${catCol(k)}"${d.flights == null ? ' fill-opacity="0.55"' : ''}/>`);
    if (d.spoof) o.push(`<rect x="${x}" y="${Y(0) + 2}" width="${w}" height="3" fill="${c.spoof}"/>`);
    const dt = new Date(d.d + 'T00:00:00Z');
    if (i % lblEvery === 0) o.push(`<text x="${x + bw / 2}" y="${H - B + 13}" text-anchor="middle" class="gpa-ax">${dayLbl(d.d)}</text>`);
    if (dt.getUTCDay() === 1) o.push(`<line x1="${x}" x2="${x}" y1="${T}" y2="${H - B}" stroke="${c.grid}" stroke-dasharray="2 3"/>`);
    if (sel(d)) o.push(`<rect x="${x - 1}" y="${T}" width="${w + 2}" height="${H - T - B}" fill="none" stroke="${c.text}" stroke-width="1"/>`);
    o.push(`<rect x="${x}" y="${T}" width="${bw}" height="${H - T - B + 18}" fill="transparent" data-d="${d.d}"><title>${tip(d)}</title></rect>`);
  });
  // all traffic (line) and this aircraft (dots), right axis
  const pts = ds.map((d, i) => d.all_share != null ? `${L + i * bw + bw / 2},${Yp(d.all_share)}` : null);
  let path = '', pen = false;
  pts.forEach(p => { if (p) { path += (pen ? 'L' : 'M') + p; pen = true; } else pen = false; });
  if (path) o.push(`<path d="${path}" fill="none" stroke="${c.all}" stroke-width="1.5" stroke-dasharray="4 3"/>`);
  ds.forEach((d, i) => {
    if (d.flights) o.push(`<circle cx="${L + i * bw + bw / 2}" cy="${Yp(d.deg_flights / d.flights)}" r="${bw > 8 ? 2.6 : 1.8}" fill="${c.text}" pointer-events="none"/>`);
  });
  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="gpa-svg">${o.join('')}</svg>`;
  $('gpa-legend').innerHTML =
    `<span class="gpa-sw" style="background:${c.bar};opacity:.55"></span>flights ` +
    `<span class="gpa-sw" style="background:${c.mod}"></span>with degradation (colour = the day) ` +
    `<span class="gpa-ln" style="border-color:${c.all}"></span>all traffic degraded (%) ` +
    `<span class="gpa-dot" style="background:${c.text}"></span>this aircraft (%) ` +
    `<span class="gpa-sw" style="background:${c.spoof};height:3px"></span>spoofing`;
}

function tip(d) {
  const dt = new Date(d.d + 'T00:00:00Z');
  const l = [`${WD[dt.getUTCDay()]} ${dayLbl(d.d)}${d.d.slice(0, 4)}`];
  if (d.flights != null) l.push(`${d.flights} flight${d.flights === 1 ? '' : 's'}, ${d.deg_flights} with GPS degradation`);
  else if (d.episodes) l.push(`${d.deg_flights} flight(s) with GPS degradation (flights not counted yet)`);
  else l.push('no flights counted');
  if (d.episodes) l.push(`${d.episodes} episode(s), ${fmtDur(d.deg_s)} degraded — ${CAT_LABEL[cat(d)]}`);
  if (d.nacp != null || d.nic != null) l.push(`lowest NACp ${d.nacp ?? '–'} / NIC ${d.nic ?? '–'}`);
  if (d.spoof) l.push(`${d.spoof} episode(s) with spoofing indicators`);
  if (d.all_share != null) l.push(`all traffic: ${Math.round(d.all_share * 100)} % of aircraft-hours degraded`);
  return esc(l.join('\n'));
}
const sel = d => selDay && d.d === selDay;

function renderCal() {
  const ds = allDays();
  if (!ds.length) { $('gpa-cal').innerHTML = ''; return; }
  const first = new Date(ds[0].d + 'T00:00:00Z');
  const lead = (first.getUTCDay() + 6) % 7;              // Monday first
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<div class="gpa-cell gpa-pad"></div>');
  ds.forEach(d => {
    const k = cat(d), dt = new Date(d.d + 'T00:00:00Z');
    const col = catCol(k);
    const txt = k === 'none' || k === 'clean' ? '' : 'color:#fff;';
    cells.push(`<div class="gpa-cell${sel(d) ? ' gpa-sel' : ''}${d.spoof ? ' gpa-spf' : ''}" data-d="${d.d}" style="background:${col};${txt}${d.spoof ? 'box-shadow: inset 0 0 0 2px ' + P().spoof + ';' : ''}" title="${tip(d)}">${dt.getUTCDate()}</div>`);
  });
  $('gpa-cal').innerHTML = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(w => `<div class="gpa-wd">${w}</div>`).join('') + cells.join('');
  $('gpa-cal-leg').innerHTML = ['clean', 'light', 'mod', 'heavy', 'none'].map(k =>
    `<span class="gpa-sw" style="background:${catCol(k)}"></span>${CAT_LABEL[k]}`).join(' ') +
    ` <span class="gpa-sw" style="background:transparent;box-shadow:inset 0 0 0 2px ${P().spoof}"></span>spoofing`;
}

function renderFlights() {
  const eps = new Map((data.episodes || []).map(e => [e.id, e]));
  let fl = data.flights || [];
  if (selDay) fl = fl.filter(f => new Date(f.t0 * 1000).toISOString().slice(0, 10) === selDay);
  const multi = data.aircraft.length > 1;
  const nDeg = fl.filter(f => f.ep.length).length;
  $('gpa-fl-sum').innerHTML = (selDay ? `${dayLbl(selDay)} · ` : '') + `${fl.length} flights, ${nDeg} with degradation` +
    (selDay ? ' · <a href="#" id="gpa-clear">all days</a>' : '');
  const shown = showAll ? fl : fl.slice(0, 300);
  const rows = shown.map(f => {
    const fe = f.ep.map(id => eps.get(id)).filter(Boolean);
    const sig = new Set(); let p = null, i = null, spf = false;
    fe.forEach(e => {
      (e.signals || '').split(',').filter(Boolean).forEach(s => sig.add(s));
      if (e.min_nacp != null) p = p == null ? e.min_nacp : Math.min(p, e.min_nacp);
      if (e.min_nic != null) i = i == null ? e.min_nic : Math.min(i, e.min_nic);
      if (e.spoof) spf = true;
    });
    const c = P();
    const chips = [...sig].map(s => `<span class="gpe-chip" style="color:${c[s === 'adsb_loss' ? 'adsb' : s]};border-color:${c[s === 'adsb_loss' ? 'adsb' : s]}">${SIG[s] || s}</span>`).join('') +
      (spf ? `<span class="gpe-chip gpe-chip-spf">SPF</span>` : '');
    const apt = f.arr ? `ARR ${esc(f.arr.rwy || '')} ${hhmm(f.arr.t)}` : f.dep ? `DEP ${hhmm(f.dep.t)}` : '—';
    const iso = new Date(f.t0 * 1000).toISOString().slice(0, 10);
    const alt = f.alt_min != null ? `${Math.round(f.alt_min / 100) * 100}–${Math.round(f.alt_max / 100) * 100}` : '—';
    const k = f.ep.length ? (f.deg_s / 60 < 1 ? 'light' : f.deg_s / 60 < 5 ? 'mod' : 'heavy') : 'clean';
    return `<tr>
      <td class="gpe-mono"><span class="gpa-mark" style="background:${catCol(k)}"></span>${fmtT(f.t0)}</td>
      <td class="gpe-cs">${esc(f.callsign || '—')}</td>
      <td style="display:${multi ? '' : 'none'}">${esc(f.reg || f.icao)} <span class="gpa-dim">${esc(f.type || '')}</span></td>
      <td class="gpe-mono">${apt}</td>
      <td class="gpe-mono">${alt}</td>
      <td class="gpe-chips">${chips || '<span class="gpa-dim">clean</span>'}</td>
      <td class="gpe-mono">${f.ep.length ? fmtDur(f.deg_s) : ''}</td>
      <td class="gpe-mono">${f.ep.length ? `${p ?? '–'}/${i ?? '–'}` : ''}</td>
      <td>${f.ep.length ? `<a href="/gps-episodes?date=${iso}&icao=${f.icao}" title="This aircraft's episodes of that day on the map">map ›</a>` : ''}</td>
    </tr>`;
  });
  if (!showAll && fl.length > 300) rows.push(`<tr><td colspan="9" class="gpe-empty"><a href="#" id="gpa-more">Show all ${fl.length} flights</a></td></tr>`);
  if (!fl.length) rows.push(`<tr><td colspan="9" class="gpe-empty">${selDay ? 'No flights counted on this day' : 'No flights in the last ' + GPA_HSER_DAYS + ' days'}</td></tr>`);
  $('gpa-tbody').innerHTML = rows.join('');
}

// ── Events ───────────────────────────────────────────────────────────────────
function pickDay(d) {
  selDay = selDay === d ? '' : d;
  showAll = false;
  renderChart(); renderCal(); renderFlights();
}
$('gpa-chart').addEventListener('click', ev => { const r = ev.target.closest('[data-d]'); if (r) pickDay(r.dataset.d); });
$('gpa-cal').addEventListener('click', ev => { const r = ev.target.closest('[data-d]'); if (r) pickDay(r.dataset.d); });
document.addEventListener('click', ev => {
  const a = ev.target.closest('a[data-q]');
  if (a) { ev.preventDefault(); $('gpa-q').value = a.dataset.q; load(); return; }
  if (ev.target.id === 'gpa-clear') { ev.preventDefault(); pickDay(selDay); }
  if (ev.target.id === 'gpa-more') { ev.preventDefault(); showAll = true; renderFlights(); }
});
$('gpa-go').addEventListener('click', load);
$('gpa-q').addEventListener('keydown', ev => { if (ev.key === 'Enter') load(); });
$('gpa-days').addEventListener('click', ev => {
  const b = ev.target.closest('[data-days]');
  if (!b) return;
  days = Number(b.dataset.days);
  syncDays();
  load();
});
function syncDays() {
  document.querySelectorAll('#gpa-days [data-days]').forEach(b => b.classList.toggle('active', Number(b.dataset.days) === days));
}
window.addEventListener('resize', () => { if (data && data.aircraft && data.aircraft.length) renderChart(); });
window.onThemeChange = () => render();

// ── Startup ──────────────────────────────────────────────────────────────────
(function init() {
  const qs = new URLSearchParams(location.search);
  let d = Number(qs.get('days'));
  if (!qs.has('days')) { try { d = Number(localStorage.getItem('ms_gpa_days') ?? 30); } catch (_) { d = 30; } }
  days = [0, 7, 30, 60, 90].includes(d) ? d : 30;
  syncDays();
  $('gpa-q').value = qs.get('q') || '';
  load();
})();
