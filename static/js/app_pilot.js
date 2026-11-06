/**
 * app_pilot.js — the phone's Pilot view (/app, from 2026-11-05): what the aircraft
 * before you measured at EFHK, for the briefing on the ground, the turnaround and
 * the debrief.  For the users with the Pilot right (web/rights.py — the server
 * leaves the tile, the view and this script out for everyone else, and
 * /api/pilot/* answers 403).  Research only.
 *
 *  - Now: the METAR, the runways in use, the wind on final (head / cross at the
 *    surface and 500 / 1000 / 2000 ft above the runway) — of the runways in use
 *    (Auto) or of up to three runways the pilot chooses (from 2026-11-06:
 *    e.g. a turboprop given another runway), at 3 heights or 7 (300 … 2 500 ft,
 *    the Heights 3 / 7 buttons, from 2026-11-06), the windshear reports
 *    of arrivals and departures, EDR and the go-arounds of the window.
 *  - Approach: the headwind on final of one runway's landings (ft above the
 *    runway) — each flight, its median and middle half, the own class
 *    highlighted (All / the class), the crosswind per 200 ft, the shear
 *    markers, a summary and the latest landings.
 *  - Icing: the 0 / −10 / −20 (jets also −40) °C heights, the temperature from
 *    the ground up (the airport's flights, the area, the mast, MEPS, the METAR),
 *    a warm layer above a sub-freezing surface, MEPS cloud and the icing reports.
 *  - My flight: a landing or departure of the last 7 days by callsign or
 *    registration — its headwind against the flights of the 45 min before, its
 *    windshear report, EDR and GNSS quality on final.
 *
 * Options in the menu (Aircraft class, Window) and the view's own choices (tab,
 * runway, filter, search) are kept on the phone (ms_app_pilot_*).  app.js calls
 * init / show / hide / refresh / layout.
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, String(v)); } catch (_) { /* private mode */ } };
  const pad = n => String(n).padStart(2, '0');
  const hm = ts => { const d = new Date(ts * 1000); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const dhm = ts => { const d = new Date(ts * 1000); return `${d.getUTCDate()}.${d.getUTCMonth() + 1}. ${hm(ts)}`; };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = v => (v == null ? '—' : String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '));

  const CLS = { T: 'Turboprop', R: 'Regional jet', N: 'Narrowbody', W: 'Widebody' };
  const TABS = { now: 'Now', app: 'Approach', dep: 'Departure', alo: 'Aloft', ice: 'Icing', turb: 'Turbulence',
                 gnss: 'GNSS', fl: 'My flight', map: 'Map' };
  const SUB = { now: m => `EFHK now · last ${m} min`, app: () => 'final approach by runway', dep: () => 'climb-out by runway',
                alo: () => 'winds and temperatures aloft', ice: () => 'freezing levels · warm layers',
                turb: m => `EDR · last ${m} min`, gnss: () => 'GNSS interference · counts', fl: () => 'debrief',
                map: () => 'weather map presets' };
  const LV = { adv: 'ADV', wsa: 'WSA', mba: 'MBA' };
  const S = {
    tab: lsGet('ms_app_pilot_tab', 'now'),
    cls: lsGet('ms_app_pilot_class', 'T'),
    min: parseInt(lsGet('ms_app_pilot_min', '60'), 10),
    rwy: lsGet('ms_app_pilot_rwy', ''),
    drwy: lsGet('ms_app_pilot_drwy', ''),                // the departure runway
    nrwy: lsGet('ms_app_pilot_nrwy', '').split(',').filter(Boolean).slice(0, 3),   // Now: the chosen runways ([] = Auto)
    hts: lsGet('ms_app_pilot_hts', 'basic') === 'more' ? 'more' : 'basic',          // Now: 3 or 7 heights (from 2026-11-06)
    filt: lsGet('ms_app_pilot_filter', 'all'),          // all / cls
    q: lsGet('ms_app_pilot_q', ''),
  };
  if (!TABS[S.tab]) S.tab = 'now';
  if (!CLS[S.cls]) S.cls = 'T';
  if (![30, 60, 120].includes(S.min)) S.min = 60;
  if (!['all', 'cls'].includes(S.filt)) S.filt = 'all';
  let on = false, inited = false, sub = () => {};
  const OPT = { wide: false, wx: null, wxSaved: () => false };
  const D = { now: null, app: null, dep: null, alo: null, ice: null, turb: null, gnss: null, list: null, fl: null };
  const ERR = {};
  let n = 0;

  // ── data ───────────────────────────────────────────────────────────────
  async function get(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (r.status === 403) throw new Error('The Pilot view needs the Pilot right.');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  async function load(tab) {
    tab = tab || S.tab;
    const want = ++n;
    try {
      if (tab === 'now') D.now = await get(`/api/pilot/brief?min=${S.min}${S.nrwy.length ? '&rwys=' + encodeURIComponent(S.nrwy.join(',')) : ''}${S.hts === 'more' ? '&hts=more' : ''}`);
      else if (tab === 'app') {
        D.app = await get(`/api/pilot/approach?min=${S.min}${S.rwy ? '&rwy=' + encodeURIComponent(S.rwy) : ''}`);
        if (D.app && D.app.rwy && D.app.rwy !== S.rwy && !(D.app.runways || {})[S.rwy]) S.rwy = '';
      } else if (tab === 'dep') {
        D.dep = await get(`/api/pilot/departure?min=${S.min}${S.drwy ? '&rwy=' + encodeURIComponent(S.drwy) : ''}`);
        if (D.dep && D.dep.rwy && D.dep.rwy !== S.drwy && !(D.dep.runways || {})[S.drwy]) S.drwy = '';
      } else if (tab === 'alo') D.alo = await get(`/api/pilot/aloft?cls=${S.cls}`);
      else if (tab === 'ice') D.ice = await get(`/api/pilot/icing?cls=${S.cls}`);
      else if (tab === 'turb') D.turb = await get(`/api/pilot/turbulence?min=${S.min}`);
      else if (tab === 'gnss') D.gnss = await get('/api/pilot/gnss');
      else if (tab === 'map') { /* nothing to load */ }
      else if (tab === 'fl' && S.q.length >= 2) D.list = await get(`/api/pilot/flight?q=${encodeURIComponent(S.q)}`);
      ERR[tab] = '';
    } catch (e) { ERR[tab] = e.message.includes('Pilot right') ? e.message : 'Could not load the data — retrying.'; }
    if (on && want === n && tab === S.tab) render();
  }
  async function openFlight(k, id) {
    try { D.fl = await get(`/api/pilot/flight?k=${k}&id=${id}`); ERR.fl = ''; }
    catch (e) { ERR.fl = 'Could not load the flight.'; }
    render();
  }

  // ── small pieces ───────────────────────────────────────────────────────
  const hw = v => v == null ? '<span class="apl-dim">—</span>' : `<span class="${v >= 0 ? 'apl-hw' : 'apl-tw'}">${v > 0 ? '+' : ''}${Math.round(v)}</span>`;
  const xw = v => {
    if (v == null) return '<span class="apl-dim">—</span>';
    const a = Math.abs(Math.round(v));
    return `<span class="${a >= 15 ? 'apl-xh' : ''}">${a}${a ? (v > 0 ? 'R' : 'L') : ''}</span>`;
  };
  const badge = (lv, ulvl) => LV[lv] ? `<span class="apl-lv apl-${lv}">${LV[lv]}</span>`
    : (LV[ulvl] ? `<span class="apl-lv apl-unv" title="Unverified: GNSS degraded at these heights — not raised">${LV[ulvl]}?</span>` : '');
  const card = (title, note, body, cls) => `<div class="apl-cd${cls ? ' ' + cls : ''}"><div class="apl-h"><b>${title}</b>${note ? `<i>${note}</i>` : ''}</div>${body}</div>`;
  const big = items => `<div class="apl-big">${items.map(([v, l, c]) => `<div><b${c ? ` class="${c}"` : ''}>${v}</b><small>${l}</small></div>`).join('')}</div>`;
  function metarCard(m, when) {
    if (!m) return card('EFHK METAR', '', '<div class="apl-dim">No METAR stored.</div>');
    const ch = [];
    if (m.wspd != null) ch.push(`Wind <b>${m.wdir == null ? 'VRB' : String(m.wdir).padStart(3, '0')}/${pad(m.wspd)}${m.wgst ? 'G' + m.wgst : ''}</b> kt`);
    if (m.vis != null) ch.push(`Vis <b>${m.vis >= 9999 ? '≥10' : (m.vis / 1000).toFixed(m.vis < 5000 ? 1 : 0)} km</b>`);
    if (m.cld) {
      const c = /^(FEW|SCT|BKN|OVC|VV)(\d{3})/.exec(m.cld);
      ch.push(c ? `Cloud <b>${c[1]} ${Number(c[2]) * 100} ft</b>` : `<b>${esc(m.cld)}</b>`);
    }
    if (m.tt != null) ch.push(`T/Td <b>${Math.round(m.tt)}/${m.td != null ? Math.round(m.td) : '—'}</b> °C`);
    if (m.qnh != null) ch.push(`QNH <b>${Math.round(m.qnh)}</b>`);
    if (m.ws) ch.push(`<b class="apl-xh">${esc(m.ws)}</b>`);
    return card('EFHK METAR', `${hm(m.ts)} UTC${when ? ' · ' + when : ''}`,
      `<div class="apl-mono">${esc(m.raw)}</div><div class="apl-chips">${ch.map(x => `<span>${x}</span>`).join('')}</div>`);
  }

  // ── SVG profile chart: y = ft (z0..z1), x = values (x0..x1) ─────────────
  function chart(o) {
    // the phone: the screen's width; the full page: 460 wide, scaled to the card by the browser
    const W = OPT.wide ? (o.w || 460) : Math.max(280, Math.min(560, ($('v-pilot').clientWidth || 360) - 28)), H = o.h || 300;
    const L = o.left || 40, R = o.right || 44, T = 24, B = 30, w = W - L - R, h = H - T - B;
    const x = v => L + (v - o.x0) / (o.x1 - o.x0) * w, y = z => T + (o.z1 - z) / (o.z1 - o.z0) * h;
    const s = [`<svg class="apl-svg" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">`];
    for (let v = Math.ceil(o.x0 / o.xs) * o.xs; v <= o.x1; v += o.xs)
      s.push(`<line class="g" x1="${x(v)}" y1="${T}" x2="${x(v)}" y2="${T + h}"/><text class="t" x="${x(v)}" y="${T + h + 12}" text-anchor="middle">${v}</text>`);
    for (let z = o.z0; z <= o.z1; z += o.zs)
      s.push(`<line class="g" x1="${L}" y1="${y(z)}" x2="${L + w}" y2="${y(z)}"/><text class="t" x="${L - 4}" y="${y(z) + 3}" text-anchor="end">${o.zfmt ? o.zfmt(z) : num(z)}</text>`);
    s.push(`<text class="t" x="${L + w / 2}" y="${H - 2}" text-anchor="middle">${o.xlab}</text><text class="t" x="2" y="${T - 12}">${o.zlab}</text>`);
    o.draw(s, x, y, { L, T, w, h, W });
    s.push('</svg>');
    return s.join('');
  }
  const line = (pts, cls) => pts.length > 1 ? `<polyline class="${cls}" points="${pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')}"/>` : '';
  function bandPoly(rows, x, y, cls) {         // rows [z, med, lo, hi]
    const r = rows.filter(m => m[1] != null);
    if (r.length < 2) return '';
    const pts = r.map(m => [x(m[2]), y(m[0])]).concat(r.slice().reverse().map(m => [x(m[3]), y(m[0])]));
    return `<polygon class="${cls}" points="${pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')}"/>`;
  }
  const prof = (lo, v, x, y, top) => v.map((a, i) => a == null || lo + i * 100 > top || lo + i * 100 < 0 ? null : [x(a), y(lo + i * 100)]).filter(Boolean);

  // ── Now ────────────────────────────────────────────────────────────────
  function renderNow() {
    const d = D.now;
    if (!d) return `<div class="apl-dim apl-pad">${ERR.now || 'Loading…'}</div>`;
    const cnt = o => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<b>${esc(k)}</b> ×${v}`).join(' · ') || '—';
    const out = [metarCard(d.metar)];
    out.push(card('In use', `last ${S.min} min`, `<div class="apl-note">Arrivals ${cnt(d.arr)} &nbsp;&nbsp; Departures ${cnt(d.dep)}</div>`));
    // the runways of the wind on final: Auto (the runways in use) or the pilot's own choice
    const all = d.runways || ['04L', '04R', '22L', '22R', '15', '33'], chosen = d.chosen || [];
    out.push(`<div class="apl-seg apl-nrwy"><span class="apl-dim apl-sm">Wind on final</span><button type="button" data-nrwy="" class="${chosen.length ? '' : 'on'}">Auto</button>`
      + all.map(k => `<button type="button" data-nrwy="${esc(k)}" class="${chosen.includes(k) ? 'on' : ''}">${esc(k)}</button>`).join('')
      + `<span class="sp"></span><span class="apl-dim apl-sm apl-hlbl">Heights</span><button type="button" data-hts="basic" class="${S.hts === 'more' ? '' : 'on'}">3</button><button type="button" data-hts="more" class="${S.hts === 'more' ? 'on' : ''}">7</button></div>`);
    const rowsShown = chosen.length ? (d.rows || []) : (d.rows || []).slice(0, 2);
    if (!rowsShown.length) out.push(card('Wind on final', `last ${S.min} min`, '<div class="apl-dim">No landings in the window — choose a runway above for its surface wind from the METAR.</div>'));
    rowsShown.forEach((e, i) => {
      const rows = [['Surface (METAR)', e.sfc]].concat((d.heights || [500, 1000, 2000]).map(h => [`${num(h)} ft`, e[String(h)]]));
      const from = Object.entries(e.from || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} ×${v}`).join(', ');
      const subT = e.src === 'own' ? `${e.n} landing${e.n > 1 ? 's' : ''}, median${e.chosen ? ' · chosen' : ''}`
        : e.src === 'all' ? `chosen · aloft from ${from}`
        : 'chosen · no landings: the METAR only';
      out.push(card(`Wind on final ${esc(e.rwy)}`, subT,
        `<table class="apl-tab"><tr><th>above the runway</th><th>head / tail kt</th><th>cross kt</th></tr>` +
        rows.map(([l, v]) => `<tr><td>${l}</td><td>${v ? hw(v[0]) : hw(null)}</td><td>${v ? xw(v[1]) : xw(null)}</td></tr>`).join('') +
        `</table>` + (i === 0 ? '<div class="apl-dim apl-sm">Crosswind from the right (R) or left (L); amber from 15 kt.</div>' : '')));
    });
    const ws = d.ws || [];
    out.push(card('Windshear', `last ${S.min} min · A arrival / D departure`, ws.length
      ? ws.map(e => `<div class="apl-ev${LV[e.lvl] ? '' : ' apl-evu'}"><span class="t">${hm(e.t)}</span><span class="k">${e.k === 'a' ? 'A' : 'D'}</span><span>${esc(e.rwy || '')}</span>${badge(e.lvl, e.ulvl)}<span class="w">${esc(e.what)}</span><span class="ty">${esc(e.ty || '')}</span></div>`).join('')
        + `<div class="apl-dim apl-sm">Research levels from the aircraft's own data; heights ft above the runway.</div>`
      : '<div class="apl-ok">No windshear reports.</div>'));
    const E = d.edr || {};
    out.push(card('Turbulence · go-arounds', `${E.n || 0} flights with EDR`, big([
      [E.med != null ? E.med.toFixed(2) : '—', 'EDR median' + (E.med != null ? ' · ' + edrName(E.med) : '')],
      [E.max != null ? E.max.toFixed(2) : '—', 'EDR highest' + (E.max != null ? ' · ' + edrName(E.max) : ''), E.max >= 0.2 ? 'apl-xh' : ''],
      [String((d.ga || []).length), 'go-arounds', (d.ga || []).length ? 'apl-xh' : '']])
      + ((d.ga || []).length ? `<div class="apl-sm">${d.ga.map(g => `${hm(g.t)} ${esc(g.rwy || '')} ${esc(g.ty || '')}${g.alt != null ? ' · ' + num(g.alt) + ' ft' : ''}`).join(' · ')}</div>` : '')));
    return out.join('');
  }
  const edrName = e => e < 0.1 ? 'smooth' : e < 0.2 ? 'light' : e < 0.45 ? 'moderate' : 'severe';

  // ── Approach ───────────────────────────────────────────────────────────
  function renderApp() {
    const d = D.app;
    if (!d) return `<div class="apl-dim apl-pad">${ERR.app || 'Loading…'}</div>`;
    const rws = Object.entries(d.runways || {}).sort((a, b) => b[1] - a[1]);
    const seg = `<div class="apl-seg" id="apl-rwy">${rws.map(([k, v]) => `<button type="button" data-rwy="${esc(k)}" class="${k === d.rwy ? 'on' : ''}">${esc(k)} · ${v}</button>`).join('')}`
      + `<span class="sp"></span><button type="button" data-f="all" class="${S.filt === 'all' ? 'on' : ''}">All</button><button type="button" data-f="cls" class="${S.filt === 'cls' ? 'on' : ''}">${CLS[S.cls]}</button></div>`;
    if (!d.rwy || !(d.flights || []).length) return seg + card('Final approach', `last ${S.min} min`, '<div class="apl-dim">No landings with a headwind profile in the window.</div>');
    const F = d.flights;
    const mine = e => e.c === S.cls;
    const sel = S.filt === 'cls' ? F.filter(mine) : F;
    const med = S.filt === 'cls' ? ((d.med_c || {})[S.cls] || []) : d.med;
    const ok = med.some(m => m[1] != null);
    const svg = chart({
      x0: -10, x1: 40, xs: 10, z0: 0, z1: 3000, zs: 500, h: 320, right: 52, xlab: 'headwind kt (− tailwind)', zlab: 'ft above rwy',
      draw: (s, x, y, g) => {
        s.push(`<line class="z" x1="${x(0)}" y1="${g.T}" x2="${x(0)}" y2="${g.T + g.h}"/>`);
        if (ok) s.push(bandPoly(med, x, y, 'band'));
        F.forEach(e => { if (S.filt !== 'cls' || mine(e)) s.push(line(prof(e.lo, e.v, x, y, 3000), mine(e) ? 'own' : 'oth')); });
        if (ok) s.push(line(med.filter(m => m[1] != null).map(m => [x(m[1]), y(m[0])]), 'med'));
        if (d.sfc && d.sfc[0] != null) s.push(`<circle class="met" cx="${x(d.sfc[0])}" cy="${y(0)}" r="4.5"/><text class="mt" x="${x(d.sfc[0]) + 7}" y="${y(0) - 4}">METAR ${d.sfc[0]}</text>`);
        // shear markers of the shown flights
        const mx = g.L + g.w + 4;
        sel.forEach(e => {
          (e.ramps || []).forEach(r => s.push(`<line class="${r.kind === 'loss' ? 'rl' : 'rg'}" x1="${mx}" y1="${y(r.a1)}" x2="${mx}" y2="${y(r.a2)}"/>`));
          if (e.band) s.push(`<line class="rb" x1="${mx + 6}" y1="${y(e.band.b + 100)}" x2="${mx + 6}" y2="${y(e.band.b - 100)}"/>`);
        });
        // crosswind per 200 ft
        const cx = g.L + g.w + 16;
        (d.xw || []).forEach(([z, v]) => {
          if (v == null || z > 3000) return;
          const len = Math.min(30, Math.abs(v) * 1.2);
          s.push(`<rect class="${Math.abs(v) >= 15 ? 'xh' : 'xw'}" x="${v > 0 ? cx : cx + 30 - len}" y="${y(z) - 3}" width="${len.toFixed(1)}" height="6"/>`);
        });
        s.push(`<text class="t" x="${cx + 15}" y="${g.T - 4}" text-anchor="middle">XW L|R</text>`);
      },
    });
    const leg = `thick line the median, band the middle half · <span class="apl-own">${CLS[S.cls]}</span> highlighted · red loss / green gain ramps, blue band changes · bars the crosswind`;
    const out = [seg, card(`Headwind on final ${esc(d.rwy)}`, `${sel.length} landing${sel.length === 1 ? '' : 's'} · last ${S.min} min`, svg + `<div class="apl-dim apl-sm">${leg}</div>`, 'apl-cdc')];
    out.push(card('In short', '', `<div class="apl-note">${summary(med, d)}</div>`));
    const last = F.slice().sort((a, b) => b.t - a.t).slice(0, 8);
    out.push(card('Latest landings', 'headwind at 1000 / 500 ft above the runway',
      `<table class="apl-tab"><tr><th>UTC · type</th><th>1000</th><th>500</th><th>WS</th><th>EDR</th></tr>` +
      last.map(e => `<tr class="${mine(e) ? 'apl-mine' : ''}"><td>${hm(e.t)} <span class="apl-dim">${esc(e.ty || '')}</span></td><td>${hw(e.hw1000)}</td><td>${hw(e.hw500)}</td><td>${badge(e.lvl, e.ulvl) || '<span class="apl-dim">—</span>'}</td><td>${e.edr != null ? e.edr.toFixed(2) : '—'}</td></tr>`).join('') + '</table>'));
    return out.join('');
  }
  function summary(med, d) {
    const r = med.filter(m => m[1] != null && m[0] <= 2500);
    if (r.length < 3) return `Too few ${S.filt === 'cls' ? CLS[S.cls].toLowerCase() + ' ' : ''}landings for a median (at least 3 at each height).`;
    const pk = r.reduce((a, b) => (b[1] > a[1] ? b : a));
    const lo = r[0];
    const sf = d.sfc && d.sfc[0] != null ? d.sfc[0] : null;
    const t = [`Headwind peaks at about <b>${Math.round(pk[1])} kt at ${num(pk[0])} ft</b>`];
    if (pk[0] > lo[0]) t.push(`and falls to <b>${Math.round(lo[1])} kt at ${num(lo[0])} ft</b>` + (sf != null ? ` and ${sf} kt at the surface` : '')
      + (sf != null && pk[1] - sf >= 8 ? ` — <b>${Math.round(pk[1] - sf)} kt less</b> in the last ${num(pk[0])} ft` : ''));
    const xs = (d.xw || []).filter(x => x[1] != null);
    const hi = xs.filter(x => x[0] >= 800), low = xs.filter(x => x[0] <= 600);
    let xt = '';
    if (hi.length) {
      const m = hi.reduce((a, b) => (Math.abs(b[1]) > Math.abs(a[1]) ? b : a));
      xt = ` Crosswind up to <b>${Math.abs(Math.round(m[1]))} kt from the ${m[1] > 0 ? 'right' : 'left'}</b> at ${num(m[0])} ft`;
      if (low.length) { const l = Math.max(...low.map(x => Math.abs(x[1]))); xt += `, ${Math.round(l)} kt or less below 600 ft`; }
      xt += '.';
    }
    return t.join(' ') + '.' + xt;
  }

  // ── Icing ──────────────────────────────────────────────────────────────
  function renderIce() {
    const d = D.ice;
    if (!d) return `<div class="apl-dim apl-pad">${ERR.ice || 'Loading…'}</div>`;
    const jets = S.cls !== 'T';
    const lv = d.levels || {};
    const first = k => (lv[k] || [])[0];
    const nums = [['0', '0 °C'], ['-10', '−10 °C'], ['-20', '−20 °C']].concat(jets ? [['-40', '−40 °C']] : []);
    const tiles = nums.map(([k, l]) => {
      const v = lv[k] || [];
      return [v.length ? num(v[0]) : (d.sfc_t != null && ((k === '0' && d.sfc_t <= 0))) ? 'SFC' : '—',
              `${l} ft MSL${v.length > 1 ? ` <em>+${v.length - 1} more</em>` : ''}`];
    });
    const out = [card('Freezing levels', d.hour ? `${hm(d.hour)}–${hm(d.hour + 3600)} UTC` : '', big(tiles))];
    const top = jets ? 30000 : 20000;
    const all = [].concat(d.apt || [], d.area || [], (d.meps || []).filter(m => m[0] <= top)).map(p => p[1]).filter(v => v != null);
    const tmin = Math.floor(Math.min(-24, ...all) / 4) * 4, tmax = Math.ceil(Math.max(8, ...all) / 4) * 4;
    const X0 = Math.max(tmin, jets ? -48 : -32), X1 = Math.min(tmax, 24);
    const svg = chart({
      x0: X0, x1: X1, xs: jets ? 8 : 4, z0: 0, z1: top, zs: jets ? 5000 : 2000, h: 360, right: 46,
      xlab: 'temperature °C', zlab: 'ft MSL',
      draw: (s, x, y, g) => {
        if (d.warm) s.push(`<rect class="warm" x="${x(0)}" y="${y(d.warm.top)}" width="${Math.max(4, x(Math.min(d.warm.max + 0.5, 24)) - x(0))}" height="${Math.max(3, y(d.warm.base) - y(d.warm.top))}"/>`);
        for (const v of [-10, -20, -40]) if (v > X0) s.push(`<line class="iso" x1="${x(v)}" y1="${g.T}" x2="${x(v)}" y2="${g.T + g.h}"/>`);
        s.push(`<line class="frz" x1="${x(0)}" y1="${g.T}" x2="${x(0)}" y2="${g.T + g.h}"/>`);
        s.push(line((d.meps || []).filter(m => m[0] <= top).map(m => [x(m[1]), y(m[0])]), 'meps'));
        s.push(line((d.area || []).filter(m => m[0] <= top).map(m => [x(m[1]), y(m[0])]), 'area'));
        s.push(line((d.apt || []).map(m => [x(m[1]), y(m[0])]), 'apt'));
        if (d.mast) s.push(line(d.mast.map(m => [x(m[1]), y(m[0])]), 'mast'));
        if (d.metar && d.metar.tt != null) s.push(`<rect class="met" x="${x(d.metar.tt) - 4}" y="${y(179) - 4}" width="8" height="8"/>`);
        // MEPS cloud: RH ≥ 95 % white, 85–95 % grey
        const cx = g.L + g.w + 18;
        (d.cloud || []).forEach(([z, rh]) => { if (z <= top) s.push(`<rect class="${rh >= 95 ? 'cl' : 'cm'}" x="${cx}" y="${y(z) - 3}" width="16" height="6"/>`); });
        s.push(`<text class="t" x="${cx + 8}" y="${g.T - 4}" text-anchor="middle">cloud</text>`);
        if (!(d.cloud || []).some(c => c[0] <= top)) s.push(`<text class="t" x="${cx + 8}" y="${g.T + g.h / 2}" text-anchor="middle">dry</text>`);
      },
    });
    out.push(card('Temperature', '', svg + `<div class="apl-dim apl-sm"><span class="apl-k apt"></span>EFHK flights <span class="apl-k area"></span>area 150 km <span class="apl-k mast"></span>Kivenlahti mast <span class="apl-k meps"></span>MEPS ▫ METAR · cloud: MEPS humidity (white ≥ 95 %, grey 85–95 %)</div>`, 'apl-cdc'));
    if (d.warm) {
      const w = d.warm;
      out.push(`<div class="apl-warn"><b>Warm layer above a sub-freezing surface.</b> +${w.max.toFixed(1)} °C at ${num(w.at)} ft (above 0 °C at ${num(w.base)}–${num(w.top)} ft MSL) over ${w.sfc.toFixed(1)} °C at the ground. Rain or drizzle falling through it would freeze on contact.${w.precip ? ' <b>Precipitation reported.</b>' : ' No precipitation in the METAR now.'}</div>`);
    }
    const rp = d.reports || [];
    out.push(card('Icing reports', 'last 6 h · ARS, WXREP, SIGMET', rp.length
      ? rp.map(r => `<div class="apl-ev"><span class="t">${hm(r.t)}</span><span class="k">${esc(r.kind)}</span><span class="w"><b>${esc(r.phen || '')}</b>${r.lo != null || r.hi != null ? ` ${r.lo ? num(r.lo) : 'SFC'}–${r.hi != null ? num(r.hi) : '?'} ft` : ''}</span><span class="${r.near ? 'apl-xh' : 'apl-dim'}">${r.near ? 'near EFHK' : 'not near'}</span></div>`).join('')
      : '<div class="apl-ok">No icing reports.</div>'));
    return out.join('');
  }

  // ── My flight ──────────────────────────────────────────────────────────
  function renderFl() {
    const out = [`<div class="apl-srch"><input type="search" id="apl-q" value="${esc(S.q)}" placeholder="Callsign or registration (last 7 days)" autocapitalize="characters" autocomplete="off" spellcheck="false" enterkeyhint="search"></div>`];
    if (D.fl) out.push(renderFlight(D.fl));
    else if (S.q.length < 2) out.push('<div class="apl-dim apl-pad">Type a callsign or registration, e.g. FIN654 or OH-ATK.</div>');
    else if (!D.list) out.push(`<div class="apl-dim apl-pad">${ERR.fl || 'Searching…'}</div>`);
    else if (!D.list.list.length) out.push('<div class="apl-dim apl-pad">No landing or departure in the last 7 days.</div>');
    else out.push(card('Flights', `${D.list.list.length} found`, D.list.list.map(e =>
      `<button type="button" class="apl-row" data-k="${e.k}" data-id="${e.id}"><span>${dhm(e.t)}</span><b>${esc(e.cs || '')}</b><span>${esc(e.ty || '')}</span><span class="apl-dim">${esc(e.reg || '')}</span><span class="rw">${e.k === 'a' ? 'land' : 'dep'} ${esc(e.rwy || '')}</span></button>`).join('')));
    return out.join('');
  }
  function renderFlight(f) {
    const dep = f.k === 'd';
    const out = [`<button type="button" class="apl-back" id="apl-back">‹ Results</button>`];
    out.push(card(`${esc(f.cs || '')} · ${esc(f.ty || '')} · ${esc(f.reg || '')}`, `${dep ? 'departed' : 'landed'} ${esc(f.rwy || '')} ${dhm(f.t)} UTC`,
      f.metar ? `<div class="apl-mono">${esc(f.metar.raw)}</div>` : ''));
    const top = dep ? 5000 : 3000;
    const rows = (f.ref && f.ref.rows) || [];
    const svg = chart({
      x0: -10, x1: 45, xs: 10, z0: 0, z1: top, zs: dep ? 1000 : 500, h: 300, right: 44, xlab: 'headwind kt', zlab: 'ft above rwy',
      draw: (s, x, y, g) => {
        s.push(`<line class="z" x1="${x(0)}" y1="${g.T}" x2="${x(0)}" y2="${g.T + g.h}"/>`);
        s.push(bandPoly(rows.filter(r => r[0] <= top), x, y, 'band2'));
        s.push(line(rows.filter(r => r[0] <= top).map(r => [x(r[1]), y(r[0])]), 'refm'));
        if (f.v && f.v.length) s.push(line(prof(f.lo, f.v, x, y, top), 'you'));
        const mx = g.L + g.w + 8;
        (f.ramps || []).forEach(r => s.push(`<line class="${r.kind === 'loss' ? 'rl' : 'rg'}" x1="${mx}" y1="${y(r.a1)}" x2="${mx}" y2="${y(r.a2)}"/><text class="t" x="${mx + 5}" y="${(y(r.a1) + y(r.a2)) / 2 + 3}">${r.dv > 0 ? '+' : '−'}${Math.abs(Math.round(r.dv))}</text>`));
        if (f.band && f.band.b != null) s.push(`<line class="rb" x1="${mx + 20}" y1="${y(f.band.b + 100)}" x2="${mx + 20}" y2="${y(f.band.b - 100)}"/>`);
      },
    });
    out.push(card(dep ? 'Your headwind on the climb-out' : 'Your headwind on final', `violet you · grey the ${f.ref ? f.ref.n : 0} ${dep ? 'departures' : 'landings'} of the 45 min before`, svg, 'apl-cdc'));
    const t = [];
    (f.ramps || []).forEach(r => t.push(`${r.trial ? '<span class="apl-lv apl-unv">trial</span>' : ''} <b>Headwind ${r.kind} ${Math.abs(r.dv).toFixed(0)} kt over ${(r.L / 1000).toFixed(1)} km</b>, ${num(r.a1)} → ${num(r.a2)} ft above the runway` + (r.d1 != null ? ` (${r.d1.toFixed(1)} → ${r.d2.toFixed(1)} NM)` : '') + (r.unv ? ' — unverified (GNSS)' : '')));
    if (f.band && f.band.a != null) t.push(`Band ${num(f.band.b)} ft: ${f.band.a > 0 ? '+' : ''}${f.band.a.toFixed(0)} kt against the flights before ${badge(f.band.lvl, f.band.ulvl)}`);
    if (f.cf) t.push(`Ramp seen also by ${f.cf.b} of ${f.cf.nb} landings before` + (f.cf.a != null ? ` and ${f.cf.a} of ${f.cf.na} after` : '') + ((f.cf.b || 0) + (f.cf.a || 0) ? ' — a real layer, not one gust' : ' — isolated'));
    out.push(card('Windshear report', '', `<div class="apl-note">${badge(f.lvl, f.ulvl) || '<span class="apl-ok">No windshear level.</span>'} ${t.join('<br>') || ''}</div>`
      + (f.unv ? '<div class="apl-dim apl-sm">Unverified: the GNSS was degraded at these heights, so the level was not raised.</div>' : '')));
    const e = f.edr || {}, gq = f.gnss;
    out.push(card('Turbulence · GNSS', '', big([
      [e.m != null ? e.m.toFixed(2) : '—', 'EDR' + (e.m != null ? ' · ' + edrName(e.m) : '')],
      [e.lo != null ? e.lo.toFixed(2) : '—', 'below 1 000 ft'],
      gq ? [gq.nacp_min != null ? String(gq.nacp_min) : '—', 'lowest NACp on final' + (gq.frozen ? ' · position frozen' : gq.nacp_min != null && gq.nacp_min > 6 ? ' · normal' : ''), gq.frozen || (gq.nacp_min != null && gq.nacp_min <= 6) ? 'apl-xh' : '']
         : [e.pk != null ? e.pk.toFixed(2) : '—', 'roughest piece']])
      + (f.ga ? `<div class="apl-sm apl-xh">Go-around${f.ga > 1 ? 's: ' + f.ga : ''} on this approach.</div>` : '')));
    return out.join('');
  }

  // ── shared: the runway bar with All / class ────────────────────────────
  function rwyBar(counts, cur, key) {
    const rws = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]);
    return `<div class="apl-seg">${rws.map(([k, v]) => `<button type="button" data-${key}="${esc(k)}" class="${k === cur ? 'on' : ''}">${esc(k)} · ${v}</button>`).join('')}`
      + `<span class="sp"></span><button type="button" data-f="all" class="${S.filt === 'all' ? 'on' : ''}">All</button><button type="button" data-f="cls" class="${S.filt === 'cls' ? 'on' : ''}">${CLS[S.cls]}</button></div>`;
  }
  const wnd = (d, s) => d == null || s == null ? '—' : `${String(Math.round(d) % 360).padStart(3, '0')}/${pad(Math.round(s))}`;
  const sgn = (v, nd) => { if (v == null) return '—'; const k = 10 ** (nd || 0), r = Math.round(v * k) / k; return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(nd || 0)}`; };
  const tC = v => v == null ? '—' : `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(0)}`;
  const isaT = ft => 15 - 1.98 * Math.min(ft, 36089) / 1000;

  // ── Departure / climb-out ──────────────────────────────────────────────
  function renderDep() {
    const d = D.dep;
    if (!d) return `<div class="apl-dim apl-pad">${ERR.dep || 'Loading…'}</div>`;
    const seg = rwyBar(d.runways, d.rwy, 'drwy');
    if (!d.rwy || !(d.flights || []).length) return seg + card('Climb-out', `last ${S.min} min`, '<div class="apl-dim">No departures in the window.</div>');
    const F = d.flights, mine = e => e.c === S.cls;
    const sel = S.filt === 'cls' ? F.filter(mine) : F;
    const med = S.filt === 'cls' ? ((d.med_c || {})[S.cls] || []) : d.med;
    const ok = med.some(m => m[1] != null);
    const TOP = 5000;
    const svg = chart({
      x0: -10, x1: 45, xs: 10, z0: 0, z1: TOP, zs: 1000, h: 340, right: 52, xlab: 'headwind kt (− tailwind)', zlab: 'ft above rwy',
      draw: (s, x, y, g) => {
        s.push(`<line class="z" x1="${x(0)}" y1="${g.T}" x2="${x(0)}" y2="${g.T + g.h}"/>`);
        if (ok) s.push(bandPoly(med, x, y, 'band'));
        F.forEach(e => { if (e.v && e.v.length && (S.filt !== 'cls' || mine(e))) s.push(line(prof(e.lo, e.v, x, y, TOP), mine(e) ? 'own' : 'oth')); });
        if (ok) s.push(line(med.filter(m => m[1] != null).map(m => [x(m[1]), y(m[0])]), 'med'));
        if (d.sfc && d.sfc[0] != null) s.push(`<circle class="met" cx="${x(d.sfc[0])}" cy="${y(0)}" r="4.5"/><text class="mt" x="${x(d.sfc[0]) + 7}" y="${y(0) - 4}">METAR ${d.sfc[0]}</text>`);
        const mx = g.L + g.w + 4;
        sel.forEach(e => { if (e.band) s.push(`<line class="rb" x1="${mx + 6}" y1="${y(e.band.b + 150)}" x2="${mx + 6}" y2="${y(e.band.b - 150)}"/>`); });
        if (d.bl && d.bl.llj) {
          const z = d.bl.llj.ft - d.thr;
          if (z > 0 && z < TOP) s.push(`<line class="iso" x1="${g.L}" y1="${y(z)}" x2="${g.L + g.w}" y2="${y(z)}"/><text class="t" x="${g.L + g.w - 2}" y="${y(z) - 3}" text-anchor="end">LLJ</text>`);
        }
        const cx = g.L + g.w + 16;
        (d.xw || []).forEach(([z, v]) => {
          if (v == null || z > TOP) return;
          const len = Math.min(30, Math.abs(v) * 1.2);
          s.push(`<rect class="${Math.abs(v) >= 15 ? 'xh' : 'xw'}" x="${v > 0 ? cx : cx + 30 - len}" y="${y(z) - 3}" width="${len.toFixed(1)}" height="6"/>`);
        });
        s.push(`<text class="t" x="${cx + 15}" y="${g.T - 4}" text-anchor="middle">XW L|R</text>`);
      },
    });
    const out = [seg, card(`Headwind on the climb-out ${esc(d.rwy)}`, `${sel.length} departure${sel.length === 1 ? '' : 's'} · last ${S.min} min`,
      svg + `<div class="apl-dim apl-sm">headwind along each departure\u2019s own track · thick line the median, band the middle half · <span class="apl-own">${CLS[S.cls]}</span> highlighted · blue band changes · bars the crosswind on the runway heading · LLJ the low-level jet of the hour</div>`, 'apl-cdc')];
    out.push(card('Climb table', 'median of the departures · ft above the runway',
      `<table class="apl-tab"><tr><th>ft</th><th>head kt</th><th>wind</th><th>x-rwy</th><th>°C</th><th>ISA</th></tr>` +
      d.climb.slice().reverse().map(c => `<tr><td>${num(c.z)}</td><td>${hw(c.hw)}</td><td>${wnd(c.wd, c.ws)}</td><td>${xw(c.xw)}</td><td>${tC(c.t)}</td><td>${sgn(c.isa)}</td></tr>`).join('') +
      `</table><div class="apl-dim apl-sm">Head: along each departure\u2019s own track, also after its turn. Wind: the departures\u2019 own band winds (true °, kt), the vector mean; x-rwy its crosswind on the runway heading. ISA: the temperature against the standard atmosphere at that height (+ warmer, less climb performance).</div>`));
    // the temperature on the climb-out with the ISA line
    const tt = (d.tt || []).filter(r => r[1] != null);
    if (tt.length >= 3) {
      const vals = tt.map(r => r[1]).concat([isaT(d.thr), isaT(TOP + d.thr)]);
      const X0 = Math.floor((Math.min(...vals) - 1) / 2) * 2, X1 = Math.ceil((Math.max(...vals) + 1) / 2) * 2;
      out.push(card('Temperature on the climb-out', 'the departures’ own bands', chart({
        x0: X0, x1: X1, xs: X1 - X0 > 16 ? 4 : 2, z0: 0, z1: TOP, zs: 1000, h: 250, right: 16, xlab: 'temperature °C', zlab: 'ft above rwy',
        draw: (s, x, y, g) => {
          if (X0 < 0 && X1 > 0) s.push(`<line class="frz" x1="${x(0)}" y1="${g.T}" x2="${x(0)}" y2="${g.T + g.h}"/>`);
          s.push(line([[x(isaT(d.thr)), y(0)], [x(isaT(TOP + d.thr)), y(TOP)]], 'isa'));
          s.push(line(tt.map(r => [x(r[1]), y(r[0])]), 'apt'));
          if (d.metar && d.metar.tt != null) s.push(`<rect class="met" x="${x(d.metar.tt) - 4}" y="${y(0) - 4}" width="8" height="8"/>`);
        },
      }) + '<div class="apl-dim apl-sm">thick line the departures (running median over 400 ft) · dashed the ISA · ▫ METAR</div>', 'apl-cdc'));
    }
    const bl = d.bl || {}, notes = [];
    if (bl.llj) notes.push(`<b>Low-level jet ${bl.llj.kt} kt from ${String(bl.llj.dir).padStart(3, '0')}°</b> at about ${num(bl.llj.ft - d.thr)} ft above the runway — the wind falls off above it: expect the headwind (or tailwind) to change through that height.`);
    if (bl.inv) notes.push(`<b>Surface inversion +${bl.inv.dT.toFixed(1)} K</b> up to about ${num(bl.inv.top - d.thr)} ft above the runway — warmer air on the climb-out, usually smooth below it.`);
    out.push(card('Boundary layer', bl.hour ? `${hm(bl.hour)}–${hm(bl.hour + 3600)} UTC` : '',
      `<div class="apl-note">${notes.join('<br>') || 'No low-level jet or surface inversion in the hour.'}</div>`));
    const last = F.slice().sort((a, b) => b.t - a.t).slice(0, 8);
    out.push(card('Latest departures', 'headwind at 1000 / 3000 ft above the runway',
      `<table class="apl-tab"><tr><th>UTC · type</th><th>1000</th><th>3000</th><th>WS</th><th>EDR</th></tr>` +
      last.map(e => `<tr class="${mine(e) ? 'apl-mine' : ''}"><td>${hm(e.t)} <span class="apl-dim">${esc(e.ty || '')}</span></td><td>${hw(e.hw1000)}</td><td>${hw(e.hw3000)}</td><td>${badge(e.lvl, e.ulvl) || '<span class="apl-dim">—</span>'}</td><td>${e.edr != null ? e.edr.toFixed(2) : '—'}</td></tr>`).join('') + '</table>'));
    return out.join('');
  }

  // ── Winds and temperatures aloft ───────────────────────────────────────
  const AL_ROWS = { T: [20, 50, 70, 100, 120, 140, 160, 180, 200, 220, 250], R: [50, 100, 140, 180, 240, 270, 300, 320, 340, 360, 390],
                    N: [50, 100, 140, 180, 240, 270, 300, 320, 340, 360, 390], W: [50, 100, 180, 240, 300, 320, 340, 360, 380, 410, 450] };
  const CRUISE = { T: [140, 250], R: [250, 390], N: [300, 390], W: [310, 410] };
  const SRC = { m: 'Mode S', s: 'sonde', p: 'MEPS' };
  function renderAlo() {
    const d = D.alo;
    if (!d) return `<div class="apl-dim apl-pad">${ERR.alo || 'Loading…'}</div>`;
    const cr = CRUISE[S.cls] || CRUISE.N, inCr = fl => fl >= cr[0] && fl <= cr[1];
    const byFl = {};
    (d.rows || []).forEach(r => { byFl[r.fl] = r; });
    const rows = (AL_ROWS[S.cls] || AL_ROWS.N).map(fl => byFl[fl]).filter(Boolean);
    const hasS = !!d.sonde && rows.some(r => r.s);
    // the tiles: tropopause, jet, ISA deviation in the cruise band
    const tp = ['m', 's', 'p'].find(k => d.tropo && d.tropo[k] != null);
    const topFl = Math.max(...['m', 'p', 's'].map(k => (d.top || {})[k] || 0));
    const jk = ['m', 's', 'p'].find(k => d.jet && d.jet[k]);
    const dev = (d.rows || []).filter(r => inCr(r.fl)).map(r => (r.m && r.m[2] != null ? r.m[2] : r.p && r.p[2] != null ? r.p[2] : null) - r.isa)
      .filter(v => !isNaN(v));
    const devm = dev.length ? dev.reduce((a, b) => a + b, 0) / dev.length : null;
    const out = [card('Aloft', d.hour ? `${hm(d.hour)}–${hm(d.hour + 3600)} UTC · ${d.ac || 0} aircraft` : '', big([
      [tp ? 'FL' + d.tropo[tp] : (topFl >= 300 ? '>FL' + topFl : '—'), 'tropopause' + (tp ? ' · ' + SRC[tp] : topFl >= 300 ? ' · above the data' : '')],
      [jk ? `${d.jet[jk].kt} kt` : '—', jk ? `jet FL${d.jet[jk].fl} from ${String(d.jet[jk].dir).padStart(3, '0')}°` : 'no jet ≥ 60 kt', jk && d.jet[jk].kt >= 120 ? 'apl-xh' : ''],
      [devm != null ? sgn(devm) + ' °C' : '—', `ISA FL${pad(cr[0]).padStart(3, '0')}–${cr[1]}`]]))];
    out.push(card('Winds and temperatures', `${CLS[S.cls]} · cruise band highlighted`,
      `<table class="apl-tab apl-alo"><tr><th>FL</th><th>wind</th><th>°C</th><th>ISA</th><th>MEPS</th>${hasS ? '<th>sonde</th>' : ''}</tr>` +
      rows.slice().reverse().map(r => {
        const m = r.m, p = r.p, t = m && m[2] != null ? m[2] : null;
        const main = m && m[1] != null ? wnd(m[0], m[1]) : '<span class="apl-dim">—</span>';
        const pm = p ? `${wnd(p[0], p[1])} ${tC(p[2])}` : '—';
        const sm = r.s ? `${wnd(r.s[0], r.s[1])} ${tC(r.s[2])}` : '—';
        return `<tr class="${inCr(r.fl) ? 'apl-mine' : ''}"><td>${String(r.fl).padStart(3, '0')}</td><td>${main}</td><td>${tC(t)}</td><td>${t != null ? sgn(t - r.isa) : '—'}</td>`
          + `<td class="apl-sm2">${pm}</td>${hasS ? `<td class="apl-sm2">${sm}</td>` : ''}</tr>`;
      }).join('') + `</table><div class="apl-dim apl-sm">Wind and °C: the area's aircraft (Mode S, 150 km) in the hour; MEPS the model${hasS ? ', sonde the Jokioinen sounding ' + hm(d.sonde.launch) + ' UTC' : ''}. True °, kt. ISA: + warmer than the standard atmosphere. Levels by pressure altitude (FL).</div>`));
    // the wind speed against the FL
    const P = d.prof || {}, zt = S.cls === 'T' ? 260 : S.cls === 'W' ? 450 : 400;
    const allw = [].concat(P.m || [], P.p || [], P.s || []).filter(r => r[0] <= zt * 100 && r[1] != null).map(r => r[1]);
    const X1 = Math.max(60, Math.ceil((Math.max(0, ...allw) + 10) / 20) * 20);
    const svg = chart({
      x0: 0, x1: X1, xs: X1 > 120 ? 40 : 20, z0: 0, z1: zt, zs: S.cls === 'T' ? 50 : 100, h: 330, right: 16, xlab: 'wind speed kt', zlab: 'FL',
      zfmt: z => String(z).padStart(3, '0'),
      draw: (s, x, y, g) => {
        s.push(`<rect class="crz" x="${g.L}" y="${y(Math.min(cr[1], zt))}" width="${g.w}" height="${Math.max(0, y(cr[0]) - y(Math.min(cr[1], zt)))}"/>`);
        const pl = (r, c) => s.push(line((r || []).filter(v => v[1] != null && v[0] <= zt * 100).map(v => [x(v[1]), y(v[0] / 100)]), c));
        pl(P.p, 'meps'); pl(P.s, 'mast'); pl(P.m, 'apt');
        if (tp && d.tropo[tp] <= zt) s.push(`<line class="iso" x1="${g.L}" y1="${y(d.tropo[tp])}" x2="${g.L + g.w}" y2="${y(d.tropo[tp])}"/><text class="t" x="${g.L + g.w - 2}" y="${y(d.tropo[tp]) - 3}" text-anchor="end">tropopause</text>`);
      },
    });
    out.push(card('Wind speed', '', svg + `<div class="apl-dim apl-sm"><span class="apl-k apt"></span>Mode S area <span class="apl-k meps"></span>MEPS${hasS ? ' <span class="apl-k mast"></span>sonde' : ''} · shaded the cruise band</div>`, 'apl-cdc'));
    // the ISA deviation against the FL
    const devp = (r, i) => (r || []).filter(v => v[2] != null && v[0] <= zt * 100).map(v => [v[2] - isaT(v[0]), v[0] / 100]);
    const dm = devp(P.m), dp = devp(P.p), ds = devp(P.s);
    const dv = [].concat(dm, dp, ds).map(v => v[0]);
    if (dv.length) {
      const A = Math.max(10, Math.ceil((Math.max(...dv.map(Math.abs)) + 1) / 5) * 5);
      out.push(card('ISA deviation', '', chart({
        x0: -A, x1: A, xs: 5, z0: 0, z1: zt, zs: S.cls === 'T' ? 50 : 100, h: 300, right: 16, xlab: '°C against the ISA (+ warmer)', zlab: 'FL',
        zfmt: z => String(z).padStart(3, '0'),
        draw: (s, x, y, g) => {
          s.push(`<line class="z" x1="${x(0)}" y1="${g.T}" x2="${x(0)}" y2="${g.T + g.h}"/>`);
          const pl = (r, c) => s.push(line(r.map(v => [x(Math.max(-A, Math.min(A, v[0]))), y(v[1])]), c));
          pl(dp, 'meps'); pl(ds, 'mast'); pl(dm, 'apt');
        },
      }), 'apl-cdc'));
    }
    return out.join('');
  }

  // ── Turbulence ─────────────────────────────────────────────────────────
  const edrCls = e => e == null ? '' : e >= 0.45 ? 'apl-tw' : e >= 0.2 ? 'apl-xh' : '';
  const edrV = e => e == null ? '—' : `<span class="${edrCls(e)}">${e.toFixed(2)}</span>`;
  function renderTurb() {
    const d = D.turb;
    if (!d) return `<div class="apl-dim apl-pad">${ERR.turb || 'Loading…'}</div>`;
    const R = d.rough || [], top = R[0];
    const mod = R.filter(r => (r.pk || 0) >= 0.2).length;
    const m = d.metar || {};
    const out = [card('Turbulence', `${d.n} flights · last ${S.min} min`, big([
      [d.med != null ? d.med.toFixed(2) : '—', 'EDR median' + (d.med != null ? ' · ' + edrName(d.med) : '')],
      [top && top.pk != null ? top.pk.toFixed(2) : '—', top ? `roughest · ${esc(top.ty || '')} ${top.at != null ? num(top.at) + ' ft' : ''}` : 'roughest', edrCls(top && top.pk)],
      [String(mod), 'flights moderate (0.20+)', mod ? 'apl-xh' : ''],
      [m.wgst ? `G${m.wgst}` : m.wspd != null ? String(m.wspd) : '—', m.wgst ? 'METAR gusts kt' : 'METAR wind kt', m.wgst && m.wgst - (m.wspd || 0) >= 10 ? 'apl-xh' : '']]))];
    out.push(card('By height', 'median · highest piece (pieces) · ft above the runway',
      `<table class="apl-tab"><tr><th>ft</th><th>arrivals</th><th>departures</th></tr>` +
      (d.bands || []).slice().reverse().map(b => {
        const c = v => v ? `${edrV(v[0])} · ${edrV(v[1])} <span class="apl-dim">(${v[2]})</span>` : '<span class="apl-dim">—</span>';
        return `<tr><td>${num(b.lo)}–${num(b.lo + 1000)}</td><td>${c(b.a)}</td><td>${c(b.d)}</td></tr>`;
      }).join('') + '</table><div class="apl-dim apl-sm">EDR (m<sup>2/3</sup>/s) from the aircraft’s own data, research: smooth below 0.10, light 0.10, <span class="apl-xh">moderate 0.20</span>, <span class="apl-tw">severe 0.45</span>. Landings below 3 000 ft, departures to 5 000 ft.</div>'));
    // the last 6 hours: the highest piece (bar) and the median (dot) per hour
    const H = d.hist || [];
    if (H.length) {
      const W = OPT.wide ? 460 : Math.max(280, Math.min(560, ($('v-pilot').clientWidth || 360) - 28)), Hh = 150, L = 34, T = 10, B = 22;
      const w = W - L - 8, h = Hh - T - B, bw = w / H.length, ym = 0.5;
      const y = v => T + h - Math.min(ym, v) / ym * h;
      const s = [`<svg class="apl-svg" viewBox="0 0 ${W} ${Hh}" width="100%">`];
      for (const v of [0.1, 0.2, 0.45]) s.push(`<line class="${v >= 0.2 ? 'iso' : 'g'}" x1="${L}" y1="${y(v)}" x2="${L + w}" y2="${y(v)}"/><text class="t" x="${L - 4}" y="${y(v) + 3}" text-anchor="end">${v.toFixed(2)}</text>`);
      H.forEach((r, i) => {
        const x = L + i * bw;
        if (r.max != null) s.push(`<rect class="tb ${r.max >= 0.45 ? 'sev' : r.max >= 0.2 ? 'mod' : r.max >= 0.1 ? 'lgt' : ''}" x="${(x + bw * 0.2).toFixed(1)}" y="${y(r.max).toFixed(1)}" width="${(bw * 0.6).toFixed(1)}" height="${(T + h - y(r.max)).toFixed(1)}"/>`);
        if (r.med != null) s.push(`<circle class="tm" cx="${(x + bw / 2).toFixed(1)}" cy="${y(r.med).toFixed(1)}" r="3.5"/>`);
        s.push(`<text class="t" x="${(x + bw / 2).toFixed(1)}" y="${Hh - 8}" text-anchor="middle">${hm(r.h)}</text><text class="t" x="${(x + bw / 2).toFixed(1)}" y="${Hh - 0}" text-anchor="middle">${r.n}</text>`);
      });
      s.push('</svg>');
      out.push(card('The last 6 hours', 'UTC hour · flights', s.join('') + '<div class="apl-dim apl-sm">bar the roughest piece, dot the median of the hour’s landings and departures</div>', 'apl-cdc'));
    }
    out.push(card('Roughest flights', `last ${S.min} min · EDR 0.10+ or a piece 0.20+`, R.length
      ? R.map(r => `<div class="apl-ev"><span class="t">${hm(r.t)}</span><span class="k">${r.k === 'a' ? 'A' : 'D'}</span><span>${esc(r.rwy || '')}</span><span class="w">${esc(r.ty || '')} · ${edrV(r.pk)}${r.at != null ? ` at ${num(r.at)} ft` : ''}</span><span class="ty">median ${edrV(r.m)}</span></div>`).join('')
      : '<div class="apl-ok">No rough flights.</div>'));
    const rp = d.reports || [];
    out.push(card('Turbulence reports', 'last 6 h · ARS, WXREP, SIGMET', rp.length
      ? rp.map(r => `<div class="apl-ev"><span class="t">${hm(r.t)}</span><span class="k">${esc(r.kind)}</span><span class="w"><b>${esc(r.phen || '')}</b>${r.lo != null || r.hi != null ? ` ${r.lo ? num(r.lo) : 'SFC'}–${r.hi != null ? num(r.hi) : '?'} ft` : ''}</span><span class="${r.near ? 'apl-xh' : 'apl-dim'}">${r.near ? 'near EFHK' : 'not near'}</span></div>`).join('')
      : '<div class="apl-ok">No turbulence reports.</div>'));
    return out.join('');
  }

  // ── GNSS ───────────────────────────────────────────────────────────────
  function renderGnss() {
    const d = D.gnss;
    if (!d) return `<div class="apl-dim apl-pad">${ERR.gnss || 'Loading…'}</div>`;
    const lv = d.live, ap = d.apt || {}, a6 = (ap['6'] || {}).a || [0, 0], d6 = (ap['6'] || {}).d || [0, 0];
    const pct = v => v[1] ? `${Math.round(100 * v[0] / v[1])} %` : '—';
    const out = [card('GNSS now', 'the receiver’s coverage', big([
      [lv ? String(lv.n) : '—', 'aircraft degraded now', lv && lv.n ? 'apl-xh' : ''],
      [lv ? String(lv.sev) : '—', 'severe (NACp 0, NIC 0 or frozen)', lv && lv.sev ? 'apl-tw' : ''],
      [a6[1] ? `${a6[0]}/${a6[1]}` : '—', 'landings degraded on final · 6 h', a6[0] ? 'apl-xh' : '']])
      + (lv && lv.bands.length ? `<div class="apl-chips">${lv.bands.map(([b, n]) => `<span>${esc(b)} <b>${n}</b></span>`).join('')}</div>` : '')
      + (!lv ? '<div class="apl-dim apl-sm">The live GNSS state is not available.</div>' : ''))];
    const n24 = d.near24;
    if (n24 && n24.hours.length) {
      const W = OPT.wide ? 460 : Math.max(280, Math.min(560, ($('v-pilot').clientWidth || 360) - 28)), Hh = 120, L = 28, T = 8, B = 18;
      const w = W - L - 6, h = Hh - T - B, bw = w / 24, mx = Math.max(4, ...n24.hours.map(r => r[1]));
      const h0 = n24.hours[n24.hours.length - 1][0] - 23 * 3600;
      const s = [`<svg class="apl-svg" viewBox="0 0 ${W} ${Hh}" width="100%"><line class="g" x1="${L}" y1="${T + h}" x2="${L + w}" y2="${T + h}"/><text class="t" x="${L - 4}" y="${T + 8}" text-anchor="end">${mx}</text>`];
      n24.hours.forEach(([ts, dg]) => {
        const i = Math.round((ts - h0) / 3600);
        if (i < 0 || i > 23) return;
        const bh = dg / mx * h;
        if (dg) s.push(`<rect class="tb mod" x="${(L + i * bw + 1).toFixed(1)}" y="${(T + h - bh).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${bh.toFixed(1)}"/>`);
        if (i % 6 === 0) s.push(`<text class="t" x="${(L + i * bw).toFixed(1)}" y="${Hh - 4}">${hm(ts)}</text>`);
      });
      s.push('</svg>');
      out.push(card('The last 24 h within 50 NM', `${n24.degraded} degraded aircraft-hours${n24.peak ? ' · peak ' + n24.peak : ''}`, s.join(''), 'apl-cdc'));
    }
    const rowsA = ['6', '24'].map(k => { const e = ap[k] || {}; return `<tr><td>last ${k} h</td><td>${(e.a || [0, 0])[0]}/${(e.a || [0, 0])[1]} <span class="apl-dim">${pct(e.a || [0, 0])}</span></td><td>${(e.d || [0, 0])[1] ? `${e.d[0]}/${e.d[1]} <span class="apl-dim">${pct(e.d)}</span>` : '—'}</td></tr>`; }).join('');
    out.push(card('At EFHK', 'flights with degraded GNSS in their own replies',
      `<table class="apl-tab"><tr><th></th><th>landings (final)</th><th>departures</th></tr>${rowsA}</table>`
      + `<div class="apl-dim apl-sm">Degraded: NACp 6 or less, or a frozen position, on final (landings) or on the climb-out (departures). The windshear levels of such heights are only “unverified”. Counts only — the GPS pages (Full view) have the aircraft and the episodes.</div>`));
    if (d6[0]) out.push(`<div class="apl-warn"><b>Degraded GNSS on the climb-out:</b> ${d6[0]} of ${d6[1]} departures in the last 6 h.</div>`);
    return out.join('');
  }

  // ── Map: the Weather presets ───────────────────────────────────────────
  const WXP = {
    app: ['Approach &amp; departure', 'Rain and snow (the model and the FMI radar), low cloud, the wind and its gusts, the live traffic.',
          'Rain and snow, low cloud, the wind barbs and the gusts.'],
    ice: ['Icing &amp; freezing', 'The 2 m temperature’s isotherms with 0 °C, all cloud, rain and snow.'],
    fog: ['Fog &amp; low visibility', 'Fog, the wind, the live traffic.', 'Fog and the wind barbs.'],
  };
  function renderMap() {
    if (!OPT.wx) return '<div class="apl-dim apl-pad">The weather map is not available here.</div>';
    const where = OPT.wide ? 'the Weather page' : 'the Weather view';
    const out = [card('Weather map', 'pilot presets', `<div class="apl-note">Opens ${where} set for a pilot: the MEPS model (MET Norway) from 6 h back to up to two days ahead — slide to your ETA. Your own settings are kept: <i>Back to my settings</i> puts them back.</div>`)];
    out.push(`<div class="apl-pre">${Object.entries(WXP).map(([k, [t, x, xw]]) => `<button type="button" class="apl-preb" data-wx="${k}"><b>${t}</b><small>${OPT.wide && xw ? xw : x}</small></button>`).join('')}`
      + (OPT.wxSaved() ? '<button type="button" class="apl-preb apl-prer" data-wx="restore"><b>Back to my settings</b><small>The settings you had before the first preset.</small></button>' : '') + '</div>');
    return out.join('');
  }

  // ── the wide page's columns (from 2026-11-06) ──────────────────────────
  // The full Pilot page places each tab's cards in fixed columns (instead of a grid
  // that let cards of different heights land anywhere): 3 columns from 1 250 px,
  // 2 from 820 px (the third column's cards go under the shorter one), else one.
  // A column lists the cards by their title ('…*' its start; '@nrwy' the Now runway
  // bar, '#first' the first card); a card not listed goes to the shortest column;
  // the bars and boxes before the first card stay across the top.
  const WIDE = {
    now:  { t: '1fr 1fr 1fr', c: [['EFHK METAR', 'In use', 'Turbulence · go-arounds'], ['@nrwy', 'Wind on final*'], ['Windshear']] },
    app:  { t: '1.2fr 1fr', c: [['Headwind on final*', 'Final approach'], ['In short', 'Latest landings']] },
    dep:  { t: '1.15fr 1fr 0.85fr', c: [['Headwind on the climb-out*', 'Climb-out'], ['Climb table', 'Latest departures'], ['Temperature on the climb-out', 'Boundary layer']] },
    alo:  { t: '1fr 1fr 1fr', c: [['Aloft', 'Winds and temperatures'], ['Wind speed'], ['ISA deviation']] },
    ice:  { t: '1fr 1.2fr', c: [['Freezing levels', 'Icing reports'], ['Temperature']] },
    turb: { t: '1fr 1fr 1fr', c: [['Turbulence', 'Roughest flights'], ['By height', 'Turbulence reports'], ['The last 6 hours']] },
    gnss: { t: '1fr 1fr 1fr', c: [['GNSS now'], ['The last 24 h within 50 NM'], ['At EFHK']] },
    fl:   { t: '1fr 1.2fr 1fr', c: [['#first', 'Turbulence · GNSS', 'Flights'], ['Your headwind*'], ['Windshear report']] },
  };
  function wideLayout(body, tab) {
    const spec = WIDE[tab];
    const cards = [...body.children].filter(e => e.classList.contains('apl-cd') || e.classList.contains('apl-nrwy'));
    if (!spec || cards.length < 2) return;
    const W = body.clientWidth, n = W >= 1250 ? 3 : W >= 820 ? 2 : 1;
    if (n === 1) { body.classList.add('apl-one'); return; }
    const title = e => ((e.querySelector('.apl-h > b') || {}).textContent || '');
    const firstCard = cards.find(e => e.classList.contains('apl-cd'));
    const cols = spec.c.map(() => []), used = new Set();
    spec.c.forEach((keys, ci) => keys.forEach(k => cards.forEach(e => {
      if (used.has(e)) return;
      const hit = k === '@nrwy' ? e.classList.contains('apl-nrwy') : k === '#first' ? e === firstCard
        : e.classList.contains('apl-cd') && (k.endsWith('*') ? title(e).startsWith(k.slice(0, -1)) : title(e) === k);
      if (hit) { cols[ci].push(e); used.add(e); }
    })));
    const row = document.createElement('div');
    row.className = 'apl-colrow';
    const nc = Math.min(n, spec.c.length);
    const tmpl = spec.t.split(' ');
    row.style.gridTemplateColumns = (nc === spec.c.length ? tmpl : tmpl.slice(0, nc)).join(' ');
    const colEls = [];
    for (let i = 0; i < nc; i++) { const c = document.createElement('div'); c.className = 'apl-col'; row.appendChild(c); colEls.push(c); }
    const first = cards[0];
    body.insertBefore(row, first);
    cols.forEach((list, ci) => list.forEach(e => colEls[Math.min(ci, nc - 1)].appendChild(e)));
    if (nc < spec.c.length) {                         // two columns: the third column's cards under the shorter one
      const extra = [...colEls[nc - 1].children].filter(e => cols.slice(nc).some(l => l.includes(e)));
      extra.forEach(e => { const sh = colEls.reduce((a, b) => a.offsetHeight <= b.offsetHeight ? a : b); sh.appendChild(e); });
    }
    cards.filter(e => !used.has(e)).forEach(e => {    // not listed: the shortest column
      const sh = colEls.reduce((a, b) => a.offsetHeight <= b.offsetHeight ? a : b); sh.appendChild(e);
    });
    body.classList.add('apl-cols');
  }

  // ── frame ──────────────────────────────────────────────────────────────
  function render() {
    if (!inited) return;
    $('apl-tabs').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
    const tb = $('apl-tabs').querySelector('button.on');
    if (tb && tb.scrollIntoView && !OPT.wide) { const r = $('apl-tabs'); r.scrollLeft = Math.max(0, tb.offsetLeft - r.clientWidth / 2 + tb.offsetWidth / 2); }
    $('apl-ban').innerHTML = `Research only — not for flight operations · class <b>${CLS[S.cls]}</b>`;
    const body = $('apl-body');
    const keep = S.tab === 'fl' && document.activeElement && document.activeElement.id === 'apl-q';
    const pos = keep ? document.activeElement.selectionStart : null;
    body.innerHTML = ({ now: renderNow, app: renderApp, dep: renderDep, alo: renderAlo, ice: renderIce, turb: renderTurb,
                        gnss: renderGnss, fl: renderFl, map: renderMap }[S.tab] || renderNow)();
    body.classList.remove('apl-cols', 'apl-one');
    if (OPT.wide) wideLayout(body, S.tab);
    if (keep) { const q = $('apl-q'); q.focus(); try { q.setSelectionRange(pos, pos); } catch (_) { /* */ } }
    sub((SUB[S.tab] || SUB.now)(S.min));
  }

  function init(o) {
    if (o && o.sub) sub = o.sub;
    if (inited) return;
    inited = true;
    if (o) { OPT.wide = !!o.wide; OPT.wx = o.wx || null; if (o.wxSaved) OPT.wxSaved = o.wxSaved; }
    if (OPT.wide) $('v-pilot').classList.add('apl-wide');
    $('apl-tabs').innerHTML = Object.entries(TABS).map(([k, t]) => `<button type="button" data-tab="${k}">${t}</button>`).join('');
    const c = $('app-pilot-class'), w = $('app-pilot-min');
    c.value = S.cls; w.value = String(S.min);
    for (const el of [c, w]) el.dispatchEvent(new Event('change'));        // the chips follow
    c.addEventListener('change', () => {
      if (c.value === S.cls) return;
      S.cls = c.value; lsSet('ms_app_pilot_class', S.cls); D.ice = D.alo = null; render(); if (on) load();
    });
    w.addEventListener('change', () => {
      const v = parseInt(w.value, 10);
      if (v === S.min) return;
      S.min = v; lsSet('ms_app_pilot_min', S.min); D.now = D.app = D.dep = D.turb = null; render(); if (on) load();
    });
    $('apl-tabs').addEventListener('click', e => {
      const b = e.target.closest('button[data-tab]');
      if (!b || b.dataset.tab === S.tab) return;
      S.tab = b.dataset.tab; lsSet('ms_app_pilot_tab', S.tab); render(); load();
      if (!OPT.wide) $('v-pilot').scrollTop = 0;
    });
    const body = $('apl-body');
    body.addEventListener('click', e => {
      const r = e.target.closest('[data-rwy]'), dr = e.target.closest('[data-drwy]'), f = e.target.closest('[data-f]'),
            row = e.target.closest('.apl-row'), wx = e.target.closest('[data-wx]');
      const ht = e.target.closest('[data-hts]');
      if (ht) {                                            // Now: 3 or 7 heights
        if (ht.dataset.hts !== S.hts) { S.hts = ht.dataset.hts; lsSet('ms_app_pilot_hts', S.hts); load('now'); }
        return;
      }
      const nr = e.target.closest('[data-nrwy]');
      if (nr) {                                            // Now: Auto, or toggle a runway (up to three)
        const k = nr.dataset.nrwy;
        if (!k) S.nrwy = [];
        else if (S.nrwy.includes(k)) S.nrwy = S.nrwy.filter(x => x !== k);
        else S.nrwy = S.nrwy.concat(k).slice(-3);
        const order = (D.now && D.now.runways) || [];
        S.nrwy.sort((a, b) => order.indexOf(a) - order.indexOf(b));
        lsSet('ms_app_pilot_nrwy', S.nrwy.join(',')); load('now');
        return;
      }
      if (r) { S.rwy = r.dataset.rwy; lsSet('ms_app_pilot_rwy', S.rwy); load(); }
      else if (dr) { S.drwy = dr.dataset.drwy; lsSet('ms_app_pilot_drwy', S.drwy); load(); }
      else if (wx && OPT.wx) { OPT.wx(wx.dataset.wx); if (on) render(); }
      else if (f) { S.filt = f.dataset.f; lsSet('ms_app_pilot_filter', S.filt); render(); }
      else if (row) openFlight(row.dataset.k, row.dataset.id);
      else if (e.target.id === 'apl-back') { D.fl = null; render(); }
    });
    let qt = null;
    body.addEventListener('input', e => {
      if (e.target.id !== 'apl-q') return;
      S.q = e.target.value.trim(); lsSet('ms_app_pilot_q', S.q); D.fl = null;
      clearTimeout(qt); qt = setTimeout(() => { D.list = null; render(); load('fl'); }, 350);
    });
  }
  function show() { on = true; render(); load(); }
  function hide() { on = false; }
  function refresh() { if (on && S.tab !== 'fl' && S.tab !== 'map') load(); }
  function layout() { if (on) render(); }
  window.AppPilot = { init, show, hide, refresh, layout };
})();
