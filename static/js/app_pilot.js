/**
 * app_pilot.js — the phone's Pilot view (/app, from 2026-11-05): what the aircraft
 * before you measured at EFHK, for the briefing on the ground, the turnaround and
 * the debrief.  For the users with the Pilot right (web/rights.py — the server
 * leaves the tile, the view and this script out for everyone else, and
 * /api/pilot/* answers 403).  Research only.
 *
 *  - Now: the METAR, the runways in use, the wind on final (head / cross at the
 *    surface and 500 / 1000 / 2000 ft above the runway), the windshear reports
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
  const TABS = { now: 'Now', app: 'Approach', ice: 'Icing', fl: 'My flight' };
  const LV = { adv: 'ADV', wsa: 'WSA', mba: 'MBA' };
  const S = {
    tab: lsGet('ms_app_pilot_tab', 'now'),
    cls: lsGet('ms_app_pilot_class', 'T'),
    min: parseInt(lsGet('ms_app_pilot_min', '60'), 10),
    rwy: lsGet('ms_app_pilot_rwy', ''),
    filt: lsGet('ms_app_pilot_filter', 'all'),          // all / cls
    q: lsGet('ms_app_pilot_q', ''),
  };
  if (!TABS[S.tab]) S.tab = 'now';
  if (!CLS[S.cls]) S.cls = 'T';
  if (![30, 60, 120].includes(S.min)) S.min = 60;
  if (!['all', 'cls'].includes(S.filt)) S.filt = 'all';
  let on = false, inited = false, sub = () => {};
  const D = { now: null, app: null, ice: null, list: null, fl: null };
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
      if (tab === 'now') D.now = await get(`/api/pilot/brief?min=${S.min}`);
      else if (tab === 'app') {
        D.app = await get(`/api/pilot/approach?min=${S.min}${S.rwy ? '&rwy=' + encodeURIComponent(S.rwy) : ''}`);
        if (D.app && D.app.rwy && D.app.rwy !== S.rwy && !(D.app.runways || {})[S.rwy]) S.rwy = '';
      } else if (tab === 'ice') D.ice = await get(`/api/pilot/icing?cls=${S.cls}`);
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
    const W = Math.max(280, Math.min(560, ($('v-pilot').clientWidth || 360) - 28)), H = o.h || 300;
    const L = 40, R = o.right || 44, T = 24, B = 30, w = W - L - R, h = H - T - B;
    const x = v => L + (v - o.x0) / (o.x1 - o.x0) * w, y = z => T + (o.z1 - z) / (o.z1 - o.z0) * h;
    const s = [`<svg class="apl-svg" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">`];
    for (let v = Math.ceil(o.x0 / o.xs) * o.xs; v <= o.x1; v += o.xs)
      s.push(`<line class="g" x1="${x(v)}" y1="${T}" x2="${x(v)}" y2="${T + h}"/><text class="t" x="${x(v)}" y="${T + h + 12}" text-anchor="middle">${v}</text>`);
    for (let z = o.z0; z <= o.z1; z += o.zs)
      s.push(`<line class="g" x1="${L}" y1="${y(z)}" x2="${L + w}" y2="${y(z)}"/><text class="t" x="${L - 4}" y="${y(z) + 3}" text-anchor="end">${num(z)}</text>`);
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
    (d.rows || []).slice(0, 2).forEach((e, i) => {
      const rows = [['Surface (METAR)', e.sfc], ['500 ft', e['500']], ['1000 ft', e['1000']], ['2000 ft', e['2000']]];
      out.push(card(`Wind on final ${esc(e.rwy)}`, `${e.n} landing${e.n > 1 ? 's' : ''}, median`,
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

  // ── frame ──────────────────────────────────────────────────────────────
  function render() {
    if (!inited) return;
    $('apl-tabs').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
    $('apl-ban').innerHTML = `Research only — not for flight operations · class <b>${CLS[S.cls]}</b>`;
    const body = $('apl-body');
    const keep = S.tab === 'fl' && document.activeElement && document.activeElement.id === 'apl-q';
    const pos = keep ? document.activeElement.selectionStart : null;
    body.innerHTML = S.tab === 'now' ? renderNow() : S.tab === 'app' ? renderApp() : S.tab === 'ice' ? renderIce() : renderFl();
    if (keep) { const q = $('apl-q'); q.focus(); try { q.setSelectionRange(pos, pos); } catch (_) { /* */ } }
    sub({ now: `EFHK now · last ${S.min} min`, app: 'final approach by runway', ice: 'freezing levels · warm layers', fl: 'debrief' }[S.tab]);
  }

  function init(o) {
    if (o && o.sub) sub = o.sub;
    if (inited) return;
    inited = true;
    const c = $('app-pilot-class'), w = $('app-pilot-min');
    c.value = S.cls; w.value = String(S.min);
    for (const el of [c, w]) el.dispatchEvent(new Event('change'));        // the chips follow
    c.addEventListener('change', () => {
      if (c.value === S.cls) return;
      S.cls = c.value; lsSet('ms_app_pilot_class', S.cls); D.ice = null; render(); if (on) load();
    });
    w.addEventListener('change', () => {
      const v = parseInt(w.value, 10);
      if (v === S.min) return;
      S.min = v; lsSet('ms_app_pilot_min', S.min); D.now = D.app = null; render(); if (on) load();
    });
    $('apl-tabs').addEventListener('click', e => {
      const b = e.target.closest('button[data-tab]');
      if (!b || b.dataset.tab === S.tab) return;
      S.tab = b.dataset.tab; lsSet('ms_app_pilot_tab', S.tab); render(); load();
      $('v-pilot').scrollTop = 0;
    });
    const body = $('apl-body');
    body.addEventListener('click', e => {
      const r = e.target.closest('[data-rwy]'), f = e.target.closest('[data-f]'), row = e.target.closest('.apl-row');
      if (r) { S.rwy = r.dataset.rwy; lsSet('ms_app_pilot_rwy', S.rwy); load(); }
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
  function refresh() { if (on && S.tab !== 'fl') load(); }
  function layout() { if (on) render(); }
  window.AppPilot = { init, show, hide, refresh, layout };
})();
