/**
 * static/js/gps_aircraft.js — GPS Aircraft page (/gps-aircraft), from 2026-11-08
 *
 * The GPS degradation history of one aircraft (ICAO24, registration), of
 * every aircraft that flew a callsign, or of a type (AT75 …): the days as
 * bars and a calendar, coloured from clean to heavy, next to the share of all
 * aircraft degraded that day, and the flights with their episodes.
 *
 * With the search box empty: the overview of all traffic (from 2026-11-08) —
 * key figures, the days, a weekday × hour matrix and tables by type, airline
 * and the most affected aircraft, optionally for some UTC hours only.
 *
 * Data: GET /api/gps/aircraft?q=<text>&days=<n>  (web/api/gps_aircraft.py)
 *       GET /api/gps/overview?days=<n>&h0=&h1=&min=<flights>
 * Address: /gps-aircraft?q=OH-ATM&days=30, or /gps-aircraft?days=30&h=6-12&min=10&tab=types
 * (kept in sync with the controls).
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
let ov = null;                 // overview data
let mode = '';                 // 'ov' | 'ac'
let hours = '0-0';             // overview hours "h0-h1" (UTC)
let minF = 10;                 // overview tables: at least this many flights
let tab = 'types';
let sortBy = { types: ['flights', -1], airlines: ['flights', -1], aircraft: ['pct', -1] };
let seq = 0;                   // the newest load wins

// ── Load ─────────────────────────────────────────────────────────────────────
async function load() {
  const q = $('gpa-q').value.trim();
  const qs = new URLSearchParams(); if (q) qs.set('q', q); qs.set('days', days);
  if (!q) { if (hours !== '0-0') qs.set('h', hours); if (minF !== 10) qs.set('min', minF); if (tab !== 'types') qs.set('tab', tab); }
  history.replaceState(null, '', '/gps-aircraft?' + qs.toString());
  try { localStorage.setItem('ms_gpa_days', String(days)); } catch (_) {}
  $('gpa-hours-ctrl').style.display = q ? 'none' : '';
  const my = ++seq;
  if (!q) return loadOverview(my);
  mode = 'ac';
  $('gpa-ov').hidden = true;
  $('gpa-status').textContent = 'Loading…';
  let d;
  try {
    const r = await fetch(`/api/gps/aircraft?${qs}`);
    if (!r.ok) throw new Error(r.status);
    d = await r.json();
  } catch (e) { if (my === seq) $('gpa-status').textContent = 'Load failed'; return; }
  if (my !== seq) return;
  data = d;
  selDay = ''; showAll = false;
  const now = new Date();
  $('gpa-status').textContent = `updated ${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())} UTC`;
  render();
}

// Every day of the period, also the empty ones
function allDays(src = data) {
  const by = new Map((src.day || []).map(d => [d.d, d]));
  const out = [];
  const t0 = src.t_from * 1000, today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  for (let t = t0; t <= today; t += 86400000) {
    const iso = new Date(t).toISOString().slice(0, 10);
    out.push(by.get(iso) || { d: iso, flights: iso >= (src.counted_from || '9999') ? 0 : null, deg_flights: 0, episodes: 0, deg_s: 0, spoof: 0, nacp: null, nic: null });
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
  renderChart($('gpa-chart'), $('gpa-legend'), allDays(), false);
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
  $('gpa-title').innerHTML = `<a href="#" data-q="" class="gpa-back" title="Back to the overview of all traffic">‹ All traffic</a> ` + title +
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
function renderChart(el, legEl, ds, isOv) {
  const W = Math.max(320, el.clientWidth || 900), H = 210, L = 34, R = 38, T = 14, B = 30;
  const n = ds.length, bw = (W - L - R) / n;
  const maxF = Math.max(1, ...ds.map(d => Math.max(d.flights || 0, d.deg_flights || 0)));
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000].find(s => maxF / s <= 5) || 5000;
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
    const fc = isOv ? (d.flights ? ramp(d.deg_flights / d.flights) : c.mod) : catCol(k);
    if (d.deg_flights) o.push(`<rect x="${x}" y="${Y(d.deg_flights)}" width="${w}" height="${Y(0) - Y(d.deg_flights)}" fill="${fc}"${d.flights == null ? ' fill-opacity="0.55"' : ''}/>`);
    if (d.spoof) o.push(`<rect x="${x}" y="${Y(0) + 2}" width="${w}" height="3" fill="${c.spoof}"/>`);
    const dt = new Date(d.d + 'T00:00:00Z');
    if (i % lblEvery === 0) o.push(`<text x="${x + bw / 2}" y="${H - B + 13}" text-anchor="middle" class="gpa-ax">${dayLbl(d.d)}</text>`);
    if (dt.getUTCDay() === 1) o.push(`<line x1="${x}" x2="${x}" y1="${T}" y2="${H - B}" stroke="${c.grid}" stroke-dasharray="2 3"/>`);
    if (!isOv && sel(d)) o.push(`<rect x="${x - 1}" y="${T}" width="${w + 2}" height="${H - T - B}" fill="none" stroke="${c.text}" stroke-width="1"/>`);
    o.push(`<rect x="${x}" y="${T}" width="${bw}" height="${H - T - B + 18}" fill="transparent"${isOv ? '' : ` data-d="${d.d}"`}><title>${tip(d, isOv)}</title></rect>`);
  });
  // flights counted from (the days before show only the flights with an episode)
  const ci = ds.findIndex(d => d.flights != null);
  if (ci > 0 && ds.slice(0, ci).some(d => d.deg_flights)) {
    const x = L + ci * bw;
    o.push(`<line x1="${x}" x2="${x}" y1="${T - 4}" y2="${H - B}" stroke="${c.text}" stroke-dasharray="3 3"/>` +
      `<text x="${x - 4}" y="${T + 6}" text-anchor="end" class="gpa-ax">only flights with an episode ‹</text>` +
      `<text x="${x + 4}" y="${T + 6}" class="gpa-ax">› flights counted</text>`);
  }
  // all traffic (line) and this aircraft (dots), right axis
  const pts = ds.map((d, i) => d.all_share != null ? `${L + i * bw + bw / 2},${Yp(d.all_share)}` : null);
  let path = '', pen = false;
  pts.forEach(p => { if (p) { path += (pen ? 'L' : 'M') + p; pen = true; } else pen = false; });
  if (path) o.push(`<path d="${path}" fill="none" stroke="${c.all}" stroke-width="1.5" stroke-dasharray="4 3"/>`);
  ds.forEach((d, i) => {
    if (d.flights) o.push(`<circle cx="${L + i * bw + bw / 2}" cy="${Yp(d.deg_flights / d.flights)}" r="${bw > 8 ? 2.6 : 1.8}" fill="${c.text}" pointer-events="none"/>`);
  });
  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="gpa-svg">${o.join('')}</svg>`;
  legEl.innerHTML =
    `<span class="gpa-sw" style="background:${c.bar};opacity:.55"></span>flights ` +
    (isOv ? `<span class="gpa-sw" style="background:${ramp(0.75)}"></span>with degradation (colour = share of the flights) `
          : `<span class="gpa-sw" style="background:${c.mod}"></span>with degradation (colour = the day) `) +
    (ds.some(d => d.all_share != null) ? `<span class="gpa-ln" style="border-color:${c.all}"></span>aircraft-hours degraded (%) ` : '') +
    `<span class="gpa-dot" style="background:${c.text}"></span>${isOv ? 'flights degraded' : 'this aircraft'} (%) ` +
    `<span class="gpa-sw" style="background:${c.spoof};height:3px"></span>spoofing`;
}

function tip(d, isOv) {
  const dt = new Date(d.d + 'T00:00:00Z');
  const l = [`${WD[dt.getUTCDay()]} ${dayLbl(d.d)}${d.d.slice(0, 4)}`];
  if (d.flights != null) l.push(`${d.flights} flight${d.flights === 1 ? '' : 's'}, ${d.deg_flights} with GPS degradation`);
  else if (d.episodes) l.push(`${d.deg_flights} flight(s) with GPS degradation (flights not counted yet)`);
  else l.push('no flights counted');
  if (d.episodes) l.push(isOv ? `${d.episodes} episodes, ${(d.deg_s / 3600).toFixed(1)} h degraded`
                              : `${d.episodes} episode(s), ${fmtDur(d.deg_s)} degraded — ${CAT_LABEL[cat(d)]}`);
  if (d.nacp != null || d.nic != null) l.push(`lowest NACp ${d.nacp ?? '–'} / NIC ${d.nic ?? '–'}`);
  if (d.spoof) l.push(`${d.spoof} episode(s) with spoofing indicators`);
  if (d.flights && isOv) l.push(`${Math.round(100 * d.deg_flights / d.flights)} % of the flights degraded, ${(d.deg_s / 60 / d.flights).toFixed(1)} min per flight`);
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

// ── Overview of all traffic (search box empty) ─────────────────────────────
const hoursVal = () => hours.split('-').map(Number);
const hoursTxt = () => { const [a, b] = hoursVal(); return a === b ? '' : `${pad2(a)}–${pad2(b || 24)} UTC`; };

async function loadOverview(my) {
  mode = 'ov';
  $('gpa-result').hidden = true;
  $('gpa-intro').hidden = false;
  $('gpa-status').textContent = 'Loading…';
  const [h0, h1] = hoursVal();
  let d;
  try {
    const r = await fetch(`/api/gps/overview?days=${days}&h0=${h0}&h1=${h1}&min=${minF}`);
    if (!r.ok) throw new Error(r.status);
    d = await r.json();
  } catch (e) { if (my === seq) $('gpa-status').textContent = 'Load failed'; return; }
  if (my !== seq) return;
  ov = d;
  const now = new Date();
  $('gpa-status').textContent = `updated ${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())} UTC`;
  renderOverview();
}

function renderOverview() {
  if (!ov) return;
  $('gpa-ov').hidden = false;
  const ds = allDays(ov);
  const known = ds.filter(d => d.flights != null && d.d >= ov.counted_from);
  const fl = known.reduce((s, d) => s + d.flights, 0), df = known.reduce((s, d) => s + d.deg_flights, 0);
  const eps = known.reduce((s, d) => s + d.episodes, 0), degS = known.reduce((s, d) => s + d.deg_s, 0);
  const spf = known.reduce((s, d) => s + (d.spoof || 0), 0);
  const shares = known.filter(d => d.flights >= 20).map(d => ({ d: d.d, p: d.deg_flights / d.flights }));
  const best = shares.reduce((a, x) => (!a || x.p < a.p ? x : a), null), worst = shares.reduce((a, x) => (!a || x.p > a.p ? x : a), null);
  const sh = known.filter(d => d.all_share != null);
  const ah = sh.length ? Math.round(100 * sh.reduce((s, d) => s + d.all_share, 0) / sh.length) : null;
  const from = known.length ? known[0].d : ov.counted_from;
  const ht = hoursTxt();
  $('gpa-ov-title').innerHTML = `<b>All traffic</b> <span class="gpa-dim">${dayLbl(from)}–${dayLbl(ds[ds.length - 1].d)}${ht ? ' · ' + ht : ''} · ` +
    `${ov.n_aircraft} aircraft${ov.untyped ? ` (${ov.untyped} without a known type)` : ''}</span>`;
  const kp = [
    [fl, 'flights seen'],
    [fl ? `${df} (${Math.round(100 * df / fl)} %)` : '—', 'with GPS degradation'],
    [eps, 'episodes'],
    [degS >= 3600 ? Math.round(degS / 3600) + ' h' : Math.round(degS / 60) + ' min', 'degraded'],
    [fl ? (degS / 60 / fl).toFixed(1) + ' min' : '—', 'per flight'],
    [best ? `${Math.round(100 * best.p)} % / ${Math.round(100 * worst.p)} %` : '—',
     best ? `best (${dayLbl(best.d)}) / worst (${dayLbl(worst.d)}) day, flights degraded` : 'best / worst day'],
    [ah != null ? ah + ' %' : '—', 'of aircraft-hours degraded (mean of the days)'],
    [spf, 'episodes with spoofing indicators'],
  ];
  $('gpa-ov-kpis').innerHTML = kp.map(([v, l]) => `<div class="gpa-kpi"><div class="gpa-kv">${esc(v)}</div><div class="gpa-kl">${esc(l)}</div></div>`).join('');
  renderChart($('gpa-ov-chart'), $('gpa-ov-legend'), ds, true);
  renderHeat();
  renderTable();
  const n = [];
  n.push(`Flights = the passes through the receivers' coverage (counted from ${dayLbl(ov.counted_from)}; the days before show only the flights with an episode, and are left out of the key figures and tables).`);
  n.push(`A flight is degraded when it has a GPS degradation episode within ${Math.round(GPA_RADIUS)} NM of ${GPA_AIRPORT} above 1 000 ft. Best / worst day: of the days with at least 20 flights. Heavy days: at least 5 degraded minutes per flight.`);
  n.push(`The time-of-day matrix${ht ? ' and the hours filter' : ' and the Hours filter'} use the flights' start times, kept for the last ${GPA_HSER_DAYS} days (from ${dayLbl(ov.times_from)} here).`);
  n.push('Types and registrations come from the landings, departures, episodes and the aircraft database. Military, government and police aircraft are left out.');
  $('gpa-ov-note').textContent = n.join(' ');
}

// Sequential ramp for a share 0…1 (theme's empty colour → heavy)
function ramp(t) {
  const c = P();
  const h = x => [1, 3, 5].map(i => parseInt(x.slice(i, i + 2), 16));
  const a = h(c.none), b = h(c.heavy);
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * Math.max(0, Math.min(1, t)))).join(',')})`;
}

// Weekday × hour: the share of the flights (started in that hour) with degradation,
// the totals per weekday (right) and per hour (bottom row and the profile)
function renderHeat() {
  const el = $('gpa-heat');
  const hm = ov.heat || [];
  const c = P();
  const W = Math.max(360, el.clientWidth || 900);
  const L = 30, R = 52, T = 16, ch = 22, gap = 6, PH = 70;
  const cw = (W - L - R) / 24;
  const rows = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  const hourTot = Array.from({ length: 24 }, (_, h) => hm.reduce((s, r) => ({ n: s.n + r[h].n, d: s.d + r[h].d }), { n: 0, d: 0 }));
  const all = hourTot.reduce((s, x) => ({ n: s.n + x.n, d: s.d + x.d }), { n: 0, d: 0 });
  const H = T + 8 * ch + gap + PH + 18;
  const o = [];
  const MIN_N = 5;
  const cell = (x, y, w, v, label) => {
    const ok = v.n >= MIN_N, sh = v.n ? v.d / v.n : 0;
    const fill = ok ? ramp(sh) : c.none;
    o.push(`<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${ch - 1}" rx="2" fill="${fill}"${ok ? '' : ' opacity="0.5"'}><title>${esc(label)}: ${v.n} flight${v.n === 1 ? '' : 's'}${v.n ? `, ${v.d} degraded (${Math.round(100 * sh)} %)` : ''}${ok ? '' : ' — too few to colour'}</title></rect>`);
    if (ok && w >= 20) o.push(`<text x="${x + w / 2}" y="${y + ch / 2 + 3.5}" text-anchor="middle" class="gpa-hv" fill="${sh > 0.55 ? '#fff' : c.text}" pointer-events="none">${Math.round(100 * sh)}</text>`);
  };
  const every = cw >= 22 ? 1 : cw >= 12 ? 2 : 3;
  for (let h = 0; h < 24; h += every) o.push(`<text x="${L + h * cw + cw / 2}" y="${T - 4}" text-anchor="middle" class="gpa-ax">${pad2(h)}</text>`);
  o.push(`<text x="${W - R + 26}" y="${T - 4}" text-anchor="middle" class="gpa-ax">all</text>`);
  rows.forEach((w, r) => {
    const y = T + r * ch;
    o.push(`<text x="${L - 6}" y="${y + ch / 2 + 3.5}" text-anchor="end" class="gpa-ax">${w}</text>`);
    for (let h = 0; h < 24; h++) cell(L + h * cw, y, cw, hm[r][h], `${w} ${pad2(h)}–${pad2(h + 1)} UTC`);
    const t = hm[r].reduce((s, x) => ({ n: s.n + x.n, d: s.d + x.d }), { n: 0, d: 0 });
    cell(W - R + 6, y, R - 8, t, `${w}, all hours`);
  });
  const yA = T + 7 * ch;
  o.push(`<text x="${L - 6}" y="${yA + ch / 2 + 3.5}" text-anchor="end" class="gpa-ax">all</text>`);
  for (let h = 0; h < 24; h++) cell(L + h * cw, yA, cw, hourTot[h], `All days ${pad2(h)}–${pad2(h + 1)} UTC`);
  cell(W - R + 6, yA, R - 8, all, 'All days and hours');
  // hour profile: flights (grey, left scale) and the share degraded (bars in the ramp, 0–100 %)
  const y0 = yA + ch + gap, y1 = y0 + PH;
  const maxN = Math.max(1, ...hourTot.map(x => x.n));
  for (const p of [0, 0.5, 1]) {
    const y = y1 - PH * p;
    o.push(`<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="${c.grid}"/><text x="${W - R + 4}" y="${y + 3}" class="gpa-ax">${p * 100}%</text>`);
  }
  hourTot.forEach((v, h) => {
    const x = L + h * cw;
    const hn = PH * v.n / maxN;
    o.push(`<rect x="${x + cw * 0.12}" y="${y1 - hn}" width="${cw * 0.76}" height="${hn}" fill="${c.bar}" opacity="0.35"/>`);
    if (v.n >= MIN_N) {
      const hs = PH * v.d / v.n;
      o.push(`<rect x="${x + cw * 0.3}" y="${y1 - hs}" width="${cw * 0.4}" height="${hs}" fill="${ramp(v.d / v.n)}"/>`);
    }
    o.push(`<rect x="${x}" y="${y0}" width="${cw}" height="${PH}" fill="transparent"><title>${pad2(h)}–${pad2(h + 1)} UTC: ${v.n} flights, ${v.d} degraded${v.n ? ` (${Math.round(100 * v.d / v.n)} %)` : ''}</title></rect>`);
  });
  for (let h = 0; h < 24; h += every) o.push(`<text x="${L + h * cw + cw / 2}" y="${y1 + 13}" text-anchor="middle" class="gpa-ax">${pad2(h)}</text>`);
  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="gpa-svg">${o.join('')}</svg>`;
  $('gpa-heat-sum').textContent = all.n
    ? `share of flights degraded, by start hour (UTC) · ${all.n} flights from ${dayLbl(ov.times_from)}`
    : 'no flights with times in this period';
  $('gpa-heat-leg').innerHTML = [0, 0.25, 0.5, 0.75, 1].map(t => `<span class="gpa-sw" style="background:${ramp(t)}"></span>${t * 100} %`).join(' ') +
    ` <span class="gpa-sw" style="background:${c.none};opacity:.5"></span>fewer than ${MIN_N} flights` +
    ` · profile: <span class="gpa-sw" style="background:${c.bar};opacity:.35"></span>flights per hour <span class="gpa-sw" style="background:${ramp(0.7)}"></span>share degraded`;
}

const TCOLS = {
  types:    [['k', 'Type'], ['aircraft', 'Aircraft'], ['flights', 'Flights'], ['pct', 'Degraded'], ['mpf', 'Min / flight'], ['episodes', 'Episodes'], ['heavy', 'Heavy days'], ['spoof', 'Spoofing']],
  airlines: [['k', 'Airline'], ['aircraft', 'Aircraft'], ['flights', 'Flights'], ['pct', 'Degraded'], ['mpf', 'Min / flight'], ['episodes', 'Episodes'], ['heavy', 'Heavy days'], ['spoof', 'Spoofing']],
  aircraft: [['reg', 'Aircraft'], ['type', 'Type'], ['flights', 'Flights'], ['pct', 'Degraded'], ['mpf', 'Min / flight'], ['episodes', 'Episodes'], ['heavy', 'Heavy days'], ['spoof', 'Spoofing']],
};
const TTIP = {
  pct: 'Flights with a GPS degradation episode', mpf: 'Degraded minutes per flight (all flights)',
  heavy: 'Days with ≥ 5 degraded minutes per flight / days flown', spoof: 'Episodes with spoofing indicators',
  aircraft: 'Different aircraft (ICAO24)', k: '', reg: 'Registration (or ICAO24)',
};

function renderTable() {
  const src = (ov[tab] || []).map(r => ({
    ...r, pct: r.flights ? r.deg / r.flights : 0, mpf: r.flights ? r.deg_s / 60 / r.flights : 0,
    heavy: r.days ? r.heavy_days / r.days : 0, reg: r.reg || r.icao,
  }));
  const [key, dir] = sortBy[tab];
  src.sort((a, b) => {
    const x = a[key], y = b[key];
    if (typeof x === 'string' || typeof y === 'string') return dir * String(x ?? '').localeCompare(String(y ?? ''));
    return dir * ((x ?? -1) - (y ?? -1)) || (b.flights - a.flights);
  });
  const cols = TCOLS[tab];
  const head = '<thead><tr>' + cols.map(([k, l]) =>
    `<th data-sort="${k}" class="gpa-th${k === key ? ' gpa-sorted' : ''}" title="${esc(TTIP[k] || '')}">${l}${k === key ? (dir < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('') + '</tr></thead>';
  const body = src.map(r => {
    const q = tab === 'types' ? r.k : tab === 'aircraft' ? r.icao : '';
    const name = tab === 'airlines'
      ? `<span class="gpe-cs">${esc(r.k === 'other' ? 'other' : r.k)}</span>${r.k === 'other' ? ' <span class="gpa-dim">no airline prefix</span>' : ''}`
      : tab === 'types' ? `<a href="#" data-q="${esc(q)}" title="History of the ${esc(r.k)} fleet">${esc(r.k)}</a>`
      : `<a href="#" data-q="${esc(q)}" title="History of ICAO24 ${esc(r.icao)}">${esc(r.reg)}</a>`;
    const k = r.deg ? (r.mpf < 1 ? 'light' : r.mpf < 5 ? 'mod' : 'heavy') : 'clean';
    const pc = Math.round(100 * r.pct);
    return `<tr>
      <td>${name}</td>
      <td class="gpe-mono">${tab === 'aircraft' ? esc(r.type || '—') : r.aircraft}</td>
      <td class="gpe-mono">${r.flights}</td>
      <td class="gpe-mono gpa-pc"><span class="gpa-pbar"><span style="width:${pc}%;background:${ramp(r.pct)}"></span></span>${pc} %</td>
      <td class="gpe-mono"><span class="gpa-mark" style="background:${catCol(k)}"></span>${r.mpf.toFixed(1)}</td>
      <td class="gpe-mono">${r.episodes}</td>
      <td class="gpe-mono">${r.heavy_days} / ${r.days}</td>
      <td class="gpe-mono">${r.spoof || ''}</td>
    </tr>`;
  });
  if (!src.length) body.push(`<tr><td colspan="8" class="gpe-empty">None with at least ${minF} flights in this period</td></tr>`);
  $('gpa-tbl').innerHTML = head + '<tbody>' + body.join('') + '</tbody>';
  $('gpa-tab-sum').textContent = tab === 'aircraft'
    ? `the ${src.length} with the highest share degraded (of ${ov.n_aircraft})`
    : `${src.length} ${tab}` + (tab === 'types' && ov.untyped ? ` · ${ov.untyped} aircraft without a known type left out` : '') +
      (tab === 'airlines' ? ' · ICAO code from the callsign' : '');
}

function syncHours() {
  const presets = ['0-0', '0-6', '6-12', '12-18', '18-0'];
  const custom = !presets.includes(hours);
  $('gpa-hours').value = custom ? 'custom' : hours;
  $('gpa-hcust').hidden = !custom;
  const [a, b] = hoursVal();
  $('gpa-h0').value = String(a); $('gpa-h1').value = String(b);
}
function syncTabs() {
  document.querySelectorAll('#gpa-tabs [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
}

$('gpa-hours').addEventListener('change', () => {
  const v = $('gpa-hours').value;
  if (v === 'custom') {
    $('gpa-hcust').hidden = false;
    if (hours === '0-0') { hours = '22-4'; syncHours(); }
    $('gpa-hours').value = 'custom';
  } else { hours = v; syncHours(); }
  load();
});
const custH = () => {
  const a = Number($('gpa-h0').value), b = Number($('gpa-h1').value);
  hours = a === b ? '0-0' : `${a}-${b}`;
  syncHours(); if (hours !== '0-0') $('gpa-hours').value = 'custom', $('gpa-hcust').hidden = false;
  load();
};
$('gpa-h0').addEventListener('change', custH);
$('gpa-h1').addEventListener('change', custH);
$('gpa-min').addEventListener('change', () => { minF = Number($('gpa-min').value); load(); });
$('gpa-tabs').addEventListener('click', ev => {
  const b = ev.target.closest('[data-tab]');
  if (!b) return;
  tab = b.dataset.tab; syncTabs();
  const qs = new URLSearchParams(location.search);
  if (tab === 'types') qs.delete('tab'); else qs.set('tab', tab);
  history.replaceState(null, '', '/gps-aircraft?' + qs.toString());
  if (ov) renderTable();
});
$('gpa-tbl').addEventListener('click', ev => {
  const th = ev.target.closest('th[data-sort]');
  if (!th) return;
  const k = th.dataset.sort;
  const [key, dir] = sortBy[tab];
  sortBy[tab] = [k, key === k ? -dir : (['k', 'reg', 'type'].includes(k) ? 1 : -1)];
  renderTable();
});

// ── Events ───────────────────────────────────────────────────────────────────
function pickDay(d) {
  selDay = selDay === d ? '' : d;
  showAll = false;
  renderChart($('gpa-chart'), $('gpa-legend'), allDays(), false); renderCal(); renderFlights();
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
let rsz = 0;
window.addEventListener('resize', () => {
  clearTimeout(rsz);
  rsz = setTimeout(() => {
    if (mode === 'ov') { if (ov) { renderChart($('gpa-ov-chart'), $('gpa-ov-legend'), allDays(ov), true); renderHeat(); } }
    else if (data && data.aircraft && data.aircraft.length) renderChart($('gpa-chart'), $('gpa-legend'), allDays(), false);
  }, 150);
});
window.onThemeChange = () => { if (mode === 'ov') renderOverview(); else render(); };

// ── Startup ──────────────────────────────────────────────────────────────────
(function init() {
  const qs = new URLSearchParams(location.search);
  let d = Number(qs.get('days'));
  if (!qs.has('days')) { try { d = Number(localStorage.getItem('ms_gpa_days') ?? 30); } catch (_) { d = 30; } }
  days = [0, 7, 30, 60, 90].includes(d) ? d : 30;
  syncDays();
  const hs = $('gpa-h0'), he = $('gpa-h1');
  for (let h = 0; h < 24; h++) { hs.add(new Option(pad2(h), h)); he.add(new Option(pad2(h + 1), (h + 1) % 24)); }
  const h = (qs.get('h') || '0-0').split('-').map(Number);
  if (h.length === 2 && h.every(v => Number.isInteger(v) && v >= 0 && v < 24)) hours = h[0] === h[1] ? '0-0' : `${h[0]}-${h[1]}`;
  syncHours();
  const m = Number(qs.get('min'));
  if ([5, 10, 20, 50, 100].includes(m)) minF = m;
  $('gpa-min').value = String(minF);
  if (['types', 'airlines', 'aircraft'].includes(qs.get('tab'))) tab = qs.get('tab');
  syncTabs();
  $('gpa-q').value = qs.get('q') || '';
  load();
})();
