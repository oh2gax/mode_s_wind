/**
 * ws_cond_chart.js — the ACI and ACI + WS chart of the Windshear page's
 * Wind Rose panel (from 2026-10-26 a module of its own, shared with the
 * mobile view /app).  Moved from windshear.js unchanged in what it draws.
 *
 *   const dots = WsCondChart.draw(ctx, W, H, readoutEl, {
 *     aph,        // /api/windshear/approach-history?window= rows (landings)
 *     cond,       // optional: the landings with a conditions index (default: from aph)
 *     dep,        // /api/windshear/departures?window= rows
 *     ga,         // go-arounds (ga_events of /api/windshear/state)
 *     met,        // optional: METARs with a windshear group (/api/wx/reports?ws=1 "metars")
 *     rep,        // optional: pilot reports near the airport (/api/wx/reports?near=1 "reports")
 *     hours,      // range 3 / 6 / 12 / 24
 *     withWs,     // false: ACI only; true: ACI + the windshear strip
 *     withEdr,    // with withWs: ACI + turbulence (EDR) + windshear, three strips (from 2026-10-29)
 *     parts,      // or (from 2026-10-30) the parts top to bottom, any of 'aci', 'edr', 'ws'
 *                 // (e.g. ['aci', 'edr'], ['edr', 'ws'], ['ws']) — overrides withWs / withEdr
 *     selMs,      // optional: the tapped flight's time — a line through all the strips
 *     fetchedMs,  // when the data arrived (0 = still loading)
 *     nowMs });   // optional, default Date.now()
 *   → [{x, y, dotR, label, color}] for the hover / tap read-out
 *
 * W / H are in the context's units (the caller may scale the context for a
 * high-density screen).  The colours and levels are the same as in
 * windshear.js (WS_LEVEL, WS_LV_COLOR, COND_* — keep them in step).
 *
 * WsCondChart.drawSpaceTime(ctx, W, H, readoutEl, { st, hours, fetchedMs })
 * draws the space–time diagram of the ST view (from 2026-10-27, see below).
 *
 * WsCondChart.drawBoundaryLayer(ctx, W, H, readoutEl, { bl, fl, hours, field, fetchedMs, nowMs, L })
 * draws the boundary layer (BL view, from 2026-10-29, see below); from
 * 2026-10-31 also flight by flight (field 'blh' / 'bld' / 'bls', fl from
 * /api/boundary/flights) as in the Sounding page's Time–height section.
 */
'use strict';

const WsCondChart = (() => {
  const WS_LEVEL = { adv: { short: 'ADV' }, wsa: { short: 'WSA' }, mba: { short: 'MBA' } };
  const WS_LV_COLOR = { adv: '#3b82f6', wsa: '#d97706', mba: '#ef4444' };
  const COND_CLASS_COLORS_DARK  = { N: '#e2e8f0', R: '#a78bfa', T: '#22d3ee', W: '#fbbf24', B: '#f472b6', '?': '#94a3b8' };
  const COND_CLASS_COLORS_LIGHT = { N: '#334155', R: '#7c3aed', T: '#0891b2', W: '#b45309', B: '#db2777', '?': '#64748b' };
  const COND_LVL_COLORS = ['#34d399', '#a3e635', '#facc15', '#fb923c', '#f87171'];
  const COND_LVL_TEXT_LIGHT = ['#047857', '#4d7c0f', '#a16207', '#c2410c', '#b91c1c'];
  const isLight = () => document.documentElement.dataset.theme === 'light';
  const _condLvl = idx => idx == null ? null : idx < 2 ? 0 : idx < 4 ? 1 : idx < 6 ? 2 : idx < 8 ? 3 : 4;
  function _condTextColor(idx) {
    const l = _condLvl(idx);
    if (l == null) return null;
    return isLight() ? COND_LVL_TEXT_LIGHT[l] : COND_LVL_COLORS[l];
  }
  // v7 (28 Oct 2026): a WSA / MBA from a ramp also needs a headwind change of ≥ 14 kt
  function _wsLvOfSc(sc, loss, dv) {
    if (sc == null) return null;
    if (sc >= 15 && dv != null && Math.abs(dv) < 14) return 'adv';
    if (loss && sc >= 30) return 'mba';
    return sc >= 15 ? 'wsa' : sc >= 10 ? 'adv' : null;
  }
  const wrRangeLabel = h => (h === 24 ? '1d' : `${h}h`);
  function theme() {
    const light = isLight();
    return {
      noTraffic:  light ? '#64748b' : '#3d4b60',
      roseBg:     light ? '#e8edf3' : '#162030',
      roseOuter:  light ? '#b8c8d8' : '#243a52',
      roseRing:   light ? '#94a3b8' : '#28446f',
      roseLabel:  light ? '#475569' : '#475569',
    };
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
   * running median line (±30 min, ≥ 3 landings) over faint level bands.  A landing
   * with a windshear report of ADV or more gets a ring in its level's colour.
   *
   * ACI + WS view (wrView 'ws', from 2026-10-25): the same chart in the upper part
   * and, below it on the same time axis, the windshear strip in knots — per landing
   * the strongest headwind ramp (stem from 0, scaled to 1 km; loss down, gain up)
   * and the band change against the last 45 min (filled diamond), per departure its
   * band change (hollow diamond), go-arounds as triangles on the time axis, and the
   * ADV / WSA / MBA lines.  The two scales are never mixed: the ACI is a roughness
   * score 0–10, the windshear a headwind change in knots.
   */
  function _wsStrongLv(w) { return w && w.lvl && w.lvl !== 'none' ? w.lvl : null; }
  function _wsShortTxt(w) {
    if (!w) return 'no windshear report';
    const parts = [];
    if (w.band) parts.push(`band ${w.band.b} ft ${w.band.a > 0 ? '+' : ''}${Math.round(w.band.a)} kt`);
    if (w.loss) parts.push(`loss ramp ${w.loss.sc} kt/1 km`);
    if (w.gain) parts.push(`gain ramp ${w.gain.sc} kt/1 km`);
    if (w.fh != null) parts.push(`F ${w.fh.toFixed(2)}`);
    const lv = _wsStrongLv(w);
    // confirmation of a ramp alert by the neighbouring landings (from 27 Oct 2026)
    if (lv && w.cf) {
      const n = (w.cf.b || 0) + (w.cf.a || 0);
      parts.push(n ? `confirmed by ${n} landing${n > 1 ? 's' : ''}` : `isolated${w.cf.fin ? '' : ' so far'} (turbulence?)`);
    }
    return (lv ? WS_LEVEL[lv].short + ' · ' : '') + (parts.join(' · ') || 'nothing above the noise');
  }

  function draw(ctx, W, H, readout, d) {
    const wrAphEntries = d.aph || [], wrDepEntries = d.dep || [], wrGaEvents = d.ga || [];
    const wxMet = d.met || [], wxRep = d.rep || [];
    const wrCondEntries = d.cond || wrAphEntries.filter(e => e.cond && e.cond.idx != null);
    const wrCondHours = d.hours || 3, wrCondFetchedMs = d.fetchedMs || 0;
    const CT    = theme();
    const wrHistDots = [];
    const light = document.documentElement.dataset.theme === 'light';
    const CLS_COL = light ? COND_CLASS_COLORS_LIGHT : COND_CLASS_COLORS_DARK;
    // The parts, top to bottom (from 2026-10-30 any of them: d.parts, e.g. ['aci', 'edr']
    // or ['edr', 'ws'] or ['ws']); without d.parts as before: ACI, + EDR (withEdr),
    // + windshear (withWs)
    const P = Array.isArray(d.parts) && d.parts.length
      ? ['aci', 'edr', 'ws'].filter(x => d.parts.includes(x))
      : ['aci'].concat(d.withWs && d.withEdr ? ['edr'] : []).concat(d.withWs ? ['ws'] : []);
    const hasAci = P.includes('aci'), withEdr = P.includes('edr'), withWs = P.includes('ws');
    const nowMs = d.nowMs || Date.now();
    const spanMs = wrCondHours * 3_600_000;
    const t0 = nowMs - spanMs;
    const L = 24, R = 8, T = 22, B = 18;          // plot margins
    const GAP = 6;                                // between the parts
    const PW = W - L - R;
    // heights: the shares of each combination (the ACI + WS and the three-part
    // views as before 2026-10-30)
    const SHARE = { 'aci+ws': [0.56, 0.44], 'aci+edr+ws': [0.31, 0.33, 0.36], 'aci+edr': [0.55, 0.45], 'edr+ws': [0.48, 0.52] };
    const sh = SHARE[P.join('+')] || P.map(() => 1 / P.length);
    const avail = H - T - B - GAP * (P.length - 1);
    const box = {};
    let top = T;
    P.forEach((k, i) => {
      const h = i === P.length - 1 ? H - B - top : Math.round(avail * sh[i]);
      box[k] = { y: top, h };
      top += h + GAP;
    });
    const PH = hasAci ? box.aci.h : 0;                                        // ACI part
    const ET = withEdr ? box.edr.y : 0, EH = withEdr ? box.edr.h : 0;         // EDR strip
    const WT = withWs ? box.ws.y : 0, WH = withWs ? box.ws.h : 0;             // WS strip
    const xOf = ms  => L + (ms - t0) / spanMs * PW;
    const yOf = idx => T + PH - Math.max(0, Math.min(10, idx)) / 10 * PH;
    const grey = light ? '#94a3b8' : '#64748b';

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = CT.roseBg;
    ctx.fillRect(0, 0, W, H);

    // Level bands (0–2 smooth … 8–10 very rough)
    if (hasAci) {
      for (let l = 0; l < 5; l++) {
        ctx.globalAlpha = light ? 0.13 : 0.09;
        ctx.fillStyle = COND_LVL_COLORS[l];
        ctx.fillRect(L, yOf((l + 1) * 2), PW, yOf(l * 2) - yOf((l + 1) * 2));
      }
      ctx.globalAlpha = 1;
    }

    // Axes, y labels, hourly x ticks (labels under the lowest part)
    ctx.strokeStyle = CT.roseRing;
    ctx.lineWidth = 1;
    for (const k of P) ctx.strokeRect(L + 0.5, box[k].y + 0.5, PW, box[k].h);
    ctx.font = '9px "Courier New",monospace';
    ctx.fillStyle = CT.roseLabel;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    if (hasAci) for (let v = 0; v <= 10; v += P.length > 1 ? 5 : 2) ctx.fillText(String(v), L - 4, yOf(v));
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const tickH   = wrCondHours <= 6 ? 1 : wrCondHours <= 12 ? 2 : 3;   // hours between x labels
    const tickMs  = tickH * 3_600_000;
    const firstHour = Math.ceil(t0 / tickMs) * tickMs;
    const yBottom = H - B;
    for (let h = firstHour; h <= nowMs; h += tickMs) {
      const x = xOf(h);
      ctx.strokeStyle = CT.roseOuter;
      for (const k of P) { ctx.beginPath(); ctx.moveTo(x, box[k].y); ctx.lineTo(x, box[k].y + box[k].h); ctx.stroke(); }
      ctx.fillText(String(new Date(h).getUTCHours()).padStart(2, '0') + 'Z', x, yBottom + 4);
    }

    // Title + range
    ctx.font = '10px "Courier New",monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';  ctx.fillStyle = CT.roseLabel;
    const TNAME = { aci: 'approach conditions', edr: 'turbulence (EDR)', ws: 'windshear' };
    const title = P.map(k => TNAME[k]).join(' + ');
    ctx.fillText(title.charAt(0).toUpperCase() + title.slice(1), 5, 5);
    ctx.textAlign = 'right';
    ctx.fillText(wrRangeLabel(wrCondHours), W - 5, 5);

    const pts = wrCondEntries
      .filter(e => e.ts * 1000 >= t0 && e.ts * 1000 <= nowMs)
      .map(e => ({ ms: e.ts * 1000, idx: e.cond.idx, e }))
      .sort((a, b) => a.ms - b.ms);

    if (hasAci) {
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

      // Landing dots (hover tooltip reuses the Hist dot tooltip); ring = windshear ADV+
      for (const p of pts) {
        const x = xOf(p.ms), y = yOf(p.idx);
        const col = CLS_COL[p.e.cond.cls] || CLS_COL['?'];
        const lv = _wsStrongLv(p.e.shear);
        if (lv) {
          ctx.beginPath();
          ctx.arc(x, y, 5.5, 0, Math.PI * 2);
          ctx.strokeStyle = WS_LV_COLOR[lv];
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.fill();
        const lbl = `${p.e.time_utc} ${p.e.callsign || p.e.icao} ${p.e.aircraft_type || ''} ` +
                    `${p.e.runway || ''}: ${p.idx.toFixed(1)} ${p.e.cond.lbl}` +
                    (withWs || lv ? `\nWindshear: ${_wsShortTxt(p.e.shear)}` : '') +
                    (withEdr && p.e.edr && p.e.edr.m != null ? `\nEDR ${p.e.edr.m.toFixed(2)} (${EDR_NAME[edrCls(p.e.edr.m)]})` : '');
        wrHistDots.push({ x, y, dotR: 3, label: lbl, color: col });
      }
      if (!pts.length) {
        ctx.fillStyle = CT.noTraffic;
        ctx.font = '10px "Courier New",monospace';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(wrCondFetchedMs ? 'No scored landings yet' : 'Loading…', L + PW / 2, T + PH / 2);
      }
    }

    // ── EDR and windshear strips ─────────────────────────────────────────────
    let edrSum = null;
    if (withEdr) {
      edrSum = _drawEdrStrip(ctx, { L, PW, ET, EH, t0, nowMs, xOf, CT, light, CLS_COL, wrAphEntries, wrDepEntries, wrHistDots, sel: d.selMs });
      if (!edrSum) {
        ctx.fillStyle = CT.noTraffic;
        ctx.font = '10px "Courier New",monospace';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(wrCondFetchedMs ? 'No turbulence values in the range' : 'Loading…', L + PW / 2, ET + EH / 2);
      }
    }
    if (d.selMs) {                                     // the tapped flight, through all the strips
      const x = xOf(d.selMs);
      ctx.save(); ctx.strokeStyle = light ? '#0f172a' : '#ffffff'; ctx.globalAlpha = 0.55; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, H - B); ctx.stroke(); ctx.restore();
    }
    let wsSum = null;
    if (withWs) wsSum = _drawWsStrip(ctx, { L, PW, WT, WH, t0, nowMs, xOf, CT, light, grey, T, PH,
                                             wrAphEntries, wrDepEntries, wrGaEvents, wrCondFetchedMs, wrHistDots });
    if (withWs && wsSum) _drawOfficial(ctx, { L, PW, WT, WH, t0, nowMs, xOf, light, T, wxMet, wxRep, wrHistDots }, wsSum);

    // ── Readout ────────────────────────────────────────────────────────────────
    if (!readout) return wrHistDots;
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
    let line3 = '';
    if (wsSum) {
      const cnt = ['mba', 'wsa', 'adv'].filter(k => wsSum[k]).map(k =>
        `<span style="color:${WS_LV_COLOR[k]};font-weight:600">${wsSum[k]} ${WS_LEVEL[k].short}</span>`);
      line3 = `<br>WS ${wrRangeLabel(wrCondHours)}: ${cnt.length ? cnt.join(' ') : 'no alerts'} · ` +
        `${wsSum.arr} ldg, ${wsSum.dep} dep` + (wsSum.ga ? ` · ${wsSum.ga} GA` : '') +
        (wsSum.met || wsSum.rep ? '<br>' +
          [wsSum.met ? `<span style="color:${MET_WS_COL(light)};font-weight:600">METAR WS ${wsSum.metRwy}</span>` : '',
           wsSum.rep ? `<span style="color:${REP_COL(light)};font-weight:600">${wsSum.rep} pilot report${wsSum.rep === 1 ? '' : 's'} near</span>` : '']
            .filter(Boolean).join(' · ') : '') +
        `<br><span class="ws-cond-legend">│ ramp (1 km) · ◆ band landing · ◇ band departure · ▲ go-around · ` +
        `<span style="color:${MET_WS_COL(light)}">▬ METAR WS</span> · <span style="color:${REP_COL(light)}">P pilot report</span></span>`;
    }
    const edrLine = withEdr ? (edrSum ? edrSum.line : '<br>EDR: no turbulence values in the range') : '';
    const key = P.join('+');
    if (key === 'aci+edr+ws') {        // a compact read-out in the three-strip view (more room for the chart)
      const ws = line3.split('<br>').filter(Boolean)[0] || '';
      readout.innerHTML = `${line1} · ${line2}${edrLine}<br>${ws}<br><span class="ws-cond-legend">● landing ○ departure · ◆◇ band change · │ ramp</span>`;
    } else if (key === 'aci+edr') {    // ACI + EDR (the ACI view from 2026-10-30)
      readout.innerHTML = `${line1} · ${line2}${edrLine}<br><span class="ws-cond-legend">${legend} · EDR ● landing ○ departure${met}</span>`;
    } else if (key === 'edr+ws') {     // EDR + WS (the EDR view from 2026-10-30)
      readout.innerHTML = `${edrLine.replace(/^<br>/, '')}${line3}`;
    } else if (key === 'ws') {         // windshear only (the WS view from 2026-10-30)
      readout.innerHTML = line3.replace(/^<br>/, '');
    } else if (key === 'edr') {
      readout.innerHTML = edrLine.replace(/^<br>/, '');
    } else {
      readout.innerHTML = `${line1}<br>${line2}${line3}<br><span class="ws-cond-legend">${legend}${met}</span>`;
    }
    return wrHistDots;
  }

  // Official reports on the WS strip (from 2026-10-29): the METARs with a
  // windshear group ("WS R22L", manual METARs only, reported by pilots / ATC
  // below 1600 ft) as a bar along the top of the strip from the METAR until the
  // next one (30 min), and the pilot reports (ARS / WXREP) near the airport as
  // a "P" marker with a dotted line — so they can be compared with what the
  // Mode S landings and departures showed at the same time.
  const MET_WS_COL = light => light ? '#b45309' : '#fbbf24';
  const REP_COL    = light => light ? '#0f766e' : '#2dd4bf';
  const _hm = t => new Date(t * 1000).toISOString().slice(11, 16);
  function _drawOfficial(ctx, g, sum) {
    const { L, PW, WT, WH, t0, nowMs, xOf, light, T, wxMet, wxRep, wrHistDots } = g;
    const met = wxMet.filter(m => m.ws && m.ts * 1000 <= nowMs && m.ts * 1000 + 1_800_000 >= t0)
                     .sort((a, b) => a.ts - b.ts);
    const rep = wxRep.filter(r => { const t = (r.obs_ts || r.ts) * 1000; return t >= t0 && t <= nowMs; });
    const rwys = new Set();
    const mc = MET_WS_COL(light), rc = REP_COL(light);
    const yb = WT + 1;                                  // just inside the top of the strip
    ctx.save();
    for (const m of met) {
      const xa = Math.max(L, xOf(m.ts * 1000)), xb = Math.min(L + PW, xOf(m.ts * 1000 + 1_800_000));
      if (xb <= xa) continue;
      ctx.fillStyle = mc;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(xa, yb, Math.max(2, xb - xa - 1), 4);
      ctx.globalAlpha = 1;
      String(m.ws).split(' ').forEach(r => rwys.add(r === 'ALL' ? 'ALL RWY' : r));
      const tip = `METAR ${_hm(m.ts)}Z — windshear reported: ${m.ws === 'ALL' ? 'all runways' : m.ws}` +
                  `\n${m.raw}\n(manual METAR: windshear reported by aircraft / ATC between the surface and 1600 ft)`;
      wrHistDots.push({ x: (xa + xb) / 2, y: yb + 2, dotR: Math.max(4, (xb - xa) / 2), label: tip, color: mc });
    }
    // runway text once at the start of each run of consecutive METARs
    ctx.font = 'bold 8px "Courier New",monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    let prevEnd = -1e15;
    for (const m of met) {
      if (m.ts * 1000 - prevEnd > 60_000) {
        const x = Math.max(L + 2, xOf(m.ts * 1000));
        if (x < L + PW - 30) {
          ctx.fillStyle = mc;
          ctx.fillText(`WS ${m.ws === 'ALL' ? 'ALL' : m.ws}`, x, yb + 6);
        }
      }
      prevEnd = m.ts * 1000 + 1_800_000;
    }
    for (const r of rep) {
      const t = (r.obs_ts || r.ts) * 1000, x = xOf(t), y = yb + 22;
      ctx.strokeStyle = rc; ctx.globalAlpha = 0.5; ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, WT + WH); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = rc; ctx.fill();
      ctx.fillStyle = light ? '#ffffff' : '#0f172a';
      ctx.font = 'bold 8px "Courier New",monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('P', x, y + 0.5);
      const h = r.lo_ft != null ? (r.lo_ft === r.hi_ft ? ` at ${r.lo_ft} ft` : ` ${r.lo_ft}–${r.hi_ft} ft`) : '';
      wrHistDots.push({ x, y, dotR: 6, color: rc,
        label: `${r.kind} ${_hm(r.obs_ts || r.ts)}Z${r.ident ? ' ' + r.ident : ''}: ${r.phen || 'report'}${h}\n${r.raw}` });
    }
    ctx.restore();
    sum.met = met.length;
    sum.metRwy = [...rwys].join(' ');
    sum.rep = rep.length;
  }

  // EDR strip (from 2026-10-29; RESEARCH): the turbulence of each landing (dot) and
  // departure (ring) from collector/edr.py on a log scale 0.02–0.6 with the ICAO
  // Annex 3 peak-EDR limits of a medium aircraft — light 0.10, moderate 0.20,
  // severe 0.45 — and the running median (±30 min, ≥ 3 flights)
  const EDR_LIM = [[0.10, 'LGT', '#facc15', '#a16207'], [0.20, 'MOD', '#fb923c', '#c2410c'], [0.45, 'SEV', '#ef4444', '#b91c1c']];
  const edrCls = v => v >= 0.45 ? 3 : v >= 0.20 ? 2 : v >= 0.10 ? 1 : 0;
  const EDR_NAME = ['smooth', 'light', 'moderate', 'severe'];
  function edrCol(v, light) { const c = edrCls(v); return c === 0 ? (light ? '#047857' : '#34d399') : EDR_LIM[c - 1][light ? 3 : 2]; }
  function _drawEdrStrip(ctx, g) {
    const { L, PW, ET, EH, t0, nowMs, xOf, CT, light, wrAphEntries, wrDepEntries, wrHistDots } = g;
    const LO = 0.02, HI = 0.6;
    const yE = v => ET + EH - (Math.log(Math.max(LO, Math.min(HI, v)) / LO) / Math.log(HI / LO)) * (EH - 4) - 2;
    ctx.save();
    // class bands
    for (let i = 0; i < 3; i++) {
      const y1 = yE(EDR_LIM[i][0]), y2 = i < 2 ? yE(EDR_LIM[i + 1][0]) : ET;
      ctx.globalAlpha = light ? 0.12 : 0.10; ctx.fillStyle = EDR_LIM[i][2];
      ctx.fillRect(L, y2, PW, y1 - y2);
    }
    ctx.globalAlpha = 1;
    ctx.font = '8px "Courier New",monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    for (const [v, n, cd, cl] of EDR_LIM) {
      const y = Math.round(yE(v)) + 0.5;
      ctx.strokeStyle = light ? cl : cd; ctx.globalAlpha = 0.7; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + PW, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.globalAlpha = 1; ctx.fillStyle = light ? cl : cd; ctx.fillText(n, L + PW - 2, y - 1);
    }
    ctx.fillStyle = CT.roseLabel; ctx.font = '9px "Courier New",monospace'; ctx.textBaseline = 'middle';
    for (const v of (EH > 90 ? [0.05, 0.1, 0.2, 0.45] : [0.1, 0.2, 0.45])) ctx.fillText(String(v).replace('0.', '.'), L - 2, yE(v));
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText('EDR m⅔/s', L + 3, ET + EH - 2);
    const inR = e => e.edr && e.ts * 1000 >= t0 && e.ts * 1000 <= nowMs;
    const pts = wrAphEntries.filter(inR).map(e => ({ ms: e.ts * 1000, v: e.edr.m, e }))
      .concat((wrDepEntries || []).filter(inR).map(e => ({ ms: e.ts * 1000, v: e.edr.m, e, dep: true })))
      .sort((a, b) => a.ms - b.ms);
    // running median ±30 min
    ctx.strokeStyle = light ? '#7c3aed' : '#c4b5fd'; ctx.lineWidth = 2; ctx.beginPath(); let pen = false;
    for (let t = t0; t <= nowMs; t += 300_000) {
      const w = pts.filter(p => Math.abs(p.ms - t) <= 1_800_000).map(p => p.v).sort((a, b) => a - b);
      if (w.length < 3) { pen = false; continue; }
      const m = w[w.length >> 1];
      if (!pen) { ctx.moveTo(xOf(t), yE(m)); pen = true; } else ctx.lineTo(xOf(t), yE(m));
    }
    ctx.stroke();
    for (const p of pts) {
      const x = xOf(p.ms), y = yE(p.v), col = edrCol(p.v, light), sel = g.sel && Math.abs(g.sel - p.ms) < 1000;
      ctx.beginPath(); ctx.arc(x, y, sel ? 4.5 : p.dep ? 2.6 : 2.8, 0, Math.PI * 2);
      if (p.dep) { ctx.lineWidth = 1.6; ctx.strokeStyle = col; ctx.stroke(); }          // departure: hollow
      else { ctx.fillStyle = col; ctx.fill(); }
      if (sel) { ctx.lineWidth = 1.8; ctx.strokeStyle = light ? '#0f172a' : '#fff'; ctx.stroke(); }
      const ee = p.e.edr;
      const tm = p.e.time_utc || new Date(p.ms).toISOString().slice(11, 16);
      wrHistDots.push({ x, y, dotR: 3, color: col, ms: p.ms,
        label: `${tm} ${p.e.callsign || p.e.icao} ${p.e.aircraft_type || ''} ${p.e.runway || (p.e.shear && p.e.shear.rwy) || ''}${p.dep ? ' (departure)' : ''}: EDR ${ee.m.toFixed(2)} (${EDR_NAME[edrCls(ee.m)]})` +
               `\n200–1000 ft ${ee.lo != null ? ee.lo.toFixed(2) : '—'} · 1000–3000 ft ${ee.hi != null ? ee.hi.toFixed(2) : '—'} · strongest 2-km piece ${ee.pk.toFixed(2)}` });
    }
    ctx.restore();
    if (!pts.length) return null;
    const all = pts.map(p => p.v).sort((a, b) => a - b), med = all[all.length >> 1];
    const mx = pts.reduce((a, p) => (!a || p.v > a.v ? p : a), null);
    const last = pts.filter(p => nowMs - p.ms <= 3_600_000).map(p => p.v).sort((a, b) => a - b);
    const lm = last.length ? last[last.length >> 1] : null;
    return { line: `<br>EDR: last 1h ${lm != null ? `<span style="color:${edrCol(lm, light)}">${lm.toFixed(2)} ${EDR_NAME[edrCls(lm)]}</span>` : '—'} · ` +
      `median ${med.toFixed(2)} · max <span style="color:${edrCol(mx.v, light)}">${mx.v.toFixed(2)}</span> ${mx.e.callsign || ''} <span class="ws-research-tag">research</span>` };
  }

  /** The windshear strip of the ACI + WS view; returns the counts for the readout. */
  function _drawWsStrip(ctx, g) {
    const { L, PW, WT, WH, t0, nowMs, xOf, CT, light, grey, wrAphEntries, wrDepEntries, wrGaEvents, wrCondFetchedMs, wrHistDots } = g;
    const mid = WT + WH / 2;
    const inR = e => e.ts * 1000 >= t0 && e.ts * 1000 <= nowMs;
    const arr = wrAphEntries.filter(e => inR(e) && e.shear);
    const dep = wrDepEntries.filter(e => inR(e) && e.shear && e.shear.band);
    const ga  = wrGaEvents.filter(inR);
    // scale: ±20 kt, widened to ±40 / ±50 kt when needed
    let mx = 0;
    for (const e of arr) {
      const w = e.shear;
      if (w.loss) mx = Math.max(mx, w.loss.sc);
      if (w.gain) mx = Math.max(mx, w.gain.sc);
      if (w.band) mx = Math.max(mx, Math.abs(w.band.a));
    }
    for (const e of dep) mx = Math.max(mx, Math.abs(e.shear.band.a));
    const lim = mx > 38 ? 50 : mx > 19 ? 40 : 20;
    const yW = v => mid - Math.max(-lim, Math.min(lim, v)) / lim * (WH / 2 - 2);

    // threshold lines (ADV / WSA both ways, MBA for losses) and the zero line
    ctx.save();
    ctx.font = '8px "Courier New",monospace';
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    for (const [v, lv] of [[10, 'adv'], [15, 'wsa'], [-10, 'adv'], [-15, 'wsa'], [-30, 'mba']]) {
      if (Math.abs(v) >= lim) continue;
      const y = Math.round(yW(v)) + 0.5;
      ctx.strokeStyle = WS_LV_COLOR[lv];
      ctx.globalAlpha = 0.55;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + PW, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.9;
      if (v < 0) {                       // labelled once, on the loss side (the lines are symmetric)
        ctx.fillStyle = WS_LV_COLOR[lv];
        ctx.textBaseline = 'bottom';
        ctx.fillText(WS_LEVEL[lv].short, L + PW - 2, y - 1);
      }
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = CT.roseRing;
    ctx.beginPath(); ctx.moveTo(L, Math.round(mid) + 0.5); ctx.lineTo(L + PW, Math.round(mid) + 0.5); ctx.stroke();
    ctx.fillStyle = CT.roseLabel;
    ctx.font = '9px "Courier New",monospace';
    ctx.textBaseline = 'middle';
    for (const v of [lim, 0, -lim]) ctx.fillText(v > 0 ? `+${v}` : String(v), L - 2, yW(v) + (v === lim ? 4 : v === -lim ? -4 : 0));
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('kt HW', L + 3, WT + 2);
    ctx.restore();

    const sum = { adv: 0, wsa: 0, mba: 0, arr: arr.length, dep: dep.length, ga: ga.length };
    const lvCol = lv => (lv && lv !== 'none' ? WS_LV_COLOR[lv] : grey);
    const diamond = (x, y, r, col, filled) => {
      ctx.beginPath();
      ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
      if (filled) { ctx.fillStyle = col; ctx.fill(); }
      ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke();
    };
    // landings: ramps (stems) and band change (filled diamond)
    for (const e of arr.sort((a, b) => a.ts - b.ts)) {
      const w = e.shear, x = xOf(e.ts * 1000);
      const lv = _wsStrongLv(w);
      if (lv) sum[lv]++;
      const who = `${e.time_utc} ${e.callsign || e.icao} ${e.aircraft_type || ''} ${e.runway || ''} (landing)`;
      const tip = `${who}\nWindshear: ${_wsShortTxt(w)}` +
        (e.cond && e.cond.idx != null ? `\nACI ${e.cond.idx.toFixed(1)} ${e.cond.lbl}` : '');
      for (const [k, sign, loss] of [['loss', -1, true], ['gain', 1, false]]) {
        const r = w[k];
        if (!r || r.sc == null) continue;
        const rl = r.zone ? _wsLvOfSc(r.sc, loss, r.dv) : null;
        const y = yW(sign * r.sc);
        ctx.strokeStyle = lvCol(rl);
        ctx.lineWidth = rl ? 2.5 : 1.5;
        ctx.beginPath(); ctx.moveTo(x, mid); ctx.lineTo(x, y); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, rl ? 2.2 : 1.6, 0, Math.PI * 2); ctx.fillStyle = lvCol(rl); ctx.fill();
        wrHistDots.push({ x, y, dotR: 3, label: tip, color: lvCol(rl) === grey ? CT.roseLabel : lvCol(rl) });
      }
      if (w.band) {
        const y = yW(w.band.a);
        diamond(x, y, 3.5, lvCol(w.band.lvl), true);
        wrHistDots.push({ x, y, dotR: 4, label: tip, color: lvCol(w.band.lvl) === grey ? CT.roseLabel : lvCol(w.band.lvl) });
      }
    }
    // departures: band change (hollow diamond)
    for (const e of dep) {
      const w = e.shear, x = xOf(e.ts * 1000), y = yW(w.band.a);
      const lv = _wsStrongLv(w);
      if (lv) sum[lv]++;
      diamond(x, y, 3.5, lvCol(w.band.lvl), false);
      const tm = new Date(e.ts * 1000).toISOString().slice(11, 16);
      wrHistDots.push({ x, y, dotR: 4, color: lvCol(w.band.lvl) === grey ? CT.roseLabel : lvCol(w.band.lvl),
        label: `${tm} ${e.callsign || e.icao} ${e.aircraft_type || ''} ${w.rwy || ''} (departure${e.ga ? ', go-around climb-out' : ''})` +
               `\nWindshear: ${lv ? WS_LEVEL[lv].short + ' · ' : ''}band ${w.band.b} ft ${w.band.a > 0 ? '+' : ''}${Math.round(w.band.a)} kt ` +
               `against ${w.band.ref} kt (${w.band.n} flights in 45 min)` +
               (w.band.thr ? `\nTurboprop climb-out: limits ${w.band.thr} / ${+(w.band.thr * 1.5).toFixed(1)} kt` : '') });
    }
    // go-arounds: triangle on the time axis, dotted line through both parts
    const gaCol = light ? '#a21caf' : '#e879f9';
    for (const e of ga) {
      const x = xOf(e.ts * 1000), yb = WT + WH;
      ctx.save();
      ctx.strokeStyle = gaCol; ctx.globalAlpha = 0.45; ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, g.T); ctx.lineTo(x, yb); ctx.stroke();
      ctx.restore();
      ctx.beginPath();
      ctx.moveTo(x, yb - 7); ctx.lineTo(x + 4, yb - 1); ctx.lineTo(x - 4, yb - 1); ctx.closePath();
      ctx.fillStyle = gaCol; ctx.fill();
      const tm = new Date(e.ts * 1000).toISOString().slice(11, 16);
      wrHistDots.push({ x, y: yb - 4, dotR: 4, color: gaCol,
        label: `${tm} go-around ${e.callsign || e.icao} ${e.ac_type || ''} RWY ${e.rwy || '?'}` +
               `${e.count > 1 ? ` (${e.count}.)` : ''}${e.alt_ft != null ? ` at ${e.alt_ft} ft` : ''}` +
               (e.ws && e.ws !== 'none' ? `\nWindshear active: ${WS_LEVEL[e.ws] ? WS_LEVEL[e.ws].short : e.ws}` : '') });
    }
    if (!arr.length && !dep.length) {
      ctx.fillStyle = CT.noTraffic;
      ctx.font = '10px "Courier New",monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(wrCondFetchedMs ? 'No windshear reports in the range' : 'Loading…', L + PW / 2, mid - 10);
    }
    return sum;
  }

  /**
   * ST view (space–time diagram, from 2026-10-27): the headwind change of every
   * 200-ft band (400–1 800 ft) of every landing and departure against the flights
   * of the previous 45 min (/api/windshear/spacetime), as a time–height picture.
   * Time cells of 5–30 min (about 6 px or more): the median change of the
   * landings and departures in the cell, per band; colour blue = less headwind
   * than before, red = more (from 3 kt, full colour at 15 kt; smaller changes are
   * the normal scatter and stay background); a band without reference flights is
   * a thin grey tick.  A cell with a flight at or beyond its advisory limit gets a
   * small dot; flights with a windshear level get a marker in its colour above
   * the plot.  The hover lists the flights of the cell.  A front or a
   * shear layer shows as a streak through successive flights.
   *   d = { st: the API answer, hours, fetchedMs, nowMs }
   * → [{x, y, dotR, label, color}] for the hover read-out
   */
  const ST_FULL = 15, ST_FAINT = 3;
  /** Cell colour of a change a (kt); null below ST_FAINT (left as background). */
  function _stColor(a, light) {
    if (Math.abs(a) < ST_FAINT) return null;
    const k = Math.min(1, (Math.abs(a) - ST_FAINT) / (ST_FULL - ST_FAINT));
    const c = a < 0 ? (light ? [37, 99, 235] : [59, 130, 246]) : (light ? [220, 38, 38] : [239, 68, 68]);
    return `rgba(${c[0]},${c[1]},${c[2]},${(0.22 + 0.78 * k).toFixed(3)})`;
  }
  function drawSpaceTime(ctx, W, H, readout, d) {
    const st = d.st || null, hours = d.hours || 12, fetchedMs = d.fetchedMs || 0;
    const CT = theme(), light = isLight();
    const dots = [];
    const nowMs = d.nowMs || Date.now();
    const spanMs = hours * 3_600_000, t0 = nowMs - spanMs;
    const L = 34, R = 8, T = 26, B = 30;
    const PW = W - L - R, PH = H - T - B;
    const bands = (st && st.bands) || [400, 600, 800, 1000, 1200, 1400, 1600, 1800];
    const rowH = PH / bands.length;
    const xOf = ms => L + (ms - t0) / spanMs * PW;
    const yRow = b => T + PH - (bands.indexOf(b) + 1) * rowH;          // top of the band's row
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = CT.roseBg; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = CT.roseRing; ctx.lineWidth = 1;
    ctx.strokeRect(L + 0.5, T + 0.5, PW, PH);
    // band labels and row lines
    ctx.font = '9px "Courier New",monospace'; ctx.fillStyle = CT.roseLabel;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    bands.forEach((b, i) => {
      const y = T + PH - (i + 0.5) * rowH;
      if (i % (rowH < 14 ? 2 : 1) === 0) ctx.fillText(String(b), L - 4, y);
      if (i) { ctx.strokeStyle = CT.roseOuter; ctx.beginPath(); ctx.moveTo(L, T + PH - i * rowH); ctx.lineTo(L + PW, T + PH - i * rowH); ctx.stroke(); }
    });
    // hourly x ticks
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const tickH = hours <= 6 ? 1 : hours <= 12 ? 2 : 3, tickMs = tickH * 3_600_000;
    for (let h = Math.ceil(t0 / tickMs) * tickMs; h <= nowMs; h += tickMs) {
      const x = xOf(h);
      ctx.strokeStyle = CT.roseOuter; ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + PH); ctx.stroke();
      ctx.fillStyle = CT.roseLabel;
      ctx.fillText(String(new Date(h).getUTCHours()).padStart(2, '0') + 'Z', x, T + PH + 3);
    }
    // title, range, colour key
    ctx.font = '10px "Courier New",monospace'; ctx.textBaseline = 'top';
    ctx.textAlign = 'left'; ctx.fillStyle = CT.roseLabel;
    ctx.fillText('Headwind change vs previous 45 min (ft MSL)', 5, 5);
    ctx.textAlign = 'right'; ctx.fillText(wrRangeLabel(hours), W - 5, 5);
    // colour key at the right, the cell length at the left — shortened on a
    // narrow canvas (a phone, from 2026-10-28) so the two never overlap
    const binMinK = [5, 10, 15, 20, 30].find(m => m * 60_000 / spanMs * PW >= 6) || 30;
    ctx.font = '8px "Courier New",monospace';
    const narrow = W < 520;
    const rTxt = narrow ? '+15 kt' : '+15 more kt';
    const lK = narrow ? '−15' : 'less −15';
    const kx = Math.round(W - 4 - ctx.measureText(rTxt).width - 3 - 31 * 4), ky = H - 11;
    for (let i = 0; i <= 30; i++) {
      const a = -ST_FULL + i, c = _stColor(a, light);
      ctx.fillStyle = CT.roseBg; ctx.fillRect(kx + i * 4, ky, 4, 7);
      if (c) { ctx.fillStyle = c; ctx.fillRect(kx + i * 4, ky, 4, 7); }
    }
    ctx.strokeStyle = CT.roseRing; ctx.strokeRect(kx + 0.5, ky + 0.5, 31 * 4 - 1, 6);
    ctx.fillStyle = CT.roseLabel; ctx.textBaseline = 'middle';
    ctx.textAlign = 'right'; ctx.fillText(lK, kx - 3, ky + 4);
    ctx.textAlign = 'left';  ctx.fillText(rTxt, kx + 31 * 4 + 3, ky + 4);
    const room = kx - 3 - ctx.measureText(lK).width - 8 - L;
    const cellTxt = [`median of the flights per ${binMinK} min`, `median per ${binMinK} min`, `${binMinK} min`]
      .find(t => ctx.measureText(t).width <= room);
    if (cellTxt) { ctx.textAlign = 'left'; ctx.fillText(cellTxt, L, ky + 4); }

    const fl = ((st && st.flights) || []).filter(f => f.ts * 1000 >= t0 && f.ts * 1000 <= nowMs);
    if (!fl.length) {
      ctx.fillStyle = CT.noTraffic; ctx.font = '10px "Courier New",monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(fetchedMs ? 'No flights with band winds in the range' : 'Loading…', L + PW / 2, T + PH / 2);
      if (readout) readout.textContent = '';
      return dots;
    }
    // Time cells of 5–30 min (at least ~6 px wide): the median change of the flights
    // in the cell, per band — successive flights that agree build a coloured area, a
    // single flight's eddy is damped when others in the same cell disagree.
    const binMin = [5, 10, 15, 20, 30].find(m => m * 60_000 / spanMs * PW >= 6) || 30;
    const binMs = binMin * 60_000;
    const lvCol = { adv: '#3b82f6', wsa: '#d97706', mba: '#ef4444' };
    const edge = light ? 'rgba(15,23,42,0.75)' : 'rgba(226,232,240,0.8)';
    const cells = new Map();                         // "bin|band" → [{f, a, n, np, wd, ws}]
    let nArr = 0, nDep = 0, strong = 0;
    for (const f of fl) {
      f.ph === 'dep' ? nDep++ : nArr++;
      const bin = Math.floor(f.ts * 1000 / binMs);
      for (const [bk, v] of Object.entries(f.b)) {
        const b = Number(bk); if (!bands.includes(b)) continue;
        const k = bin + '|' + b;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push({ f, a: v[0], n: v[1], np: v[2], wd: v[3], ws: v[4] });
      }
      if (f.lvl && f.lvl !== 'none' && lvCol[f.lvl]) {      // level marker at the flight's time
        const x = xOf(f.ts * 1000);
        ctx.fillStyle = lvCol[f.lvl];
        ctx.beginPath(); ctx.moveTo(x - 3.5, T - 8); ctx.lineTo(x + 3.5, T - 8); ctx.lineTo(x, T - 2); ctx.closePath(); ctx.fill();
      }
    }
    const fmtA = a => a == null ? 'n/a' : `${a > 0 ? '+' : ''}${a.toFixed(1)}`;
    for (const [k, list] of cells) {
      const [bin, b] = k.split('|').map(Number);
      const xa = Math.max(L, xOf(bin * binMs)), xb = Math.min(L + PW, xOf((bin + 1) * binMs));
      if (xb <= xa) continue;
      const y = yRow(b) + 1, h = rowH - 2;
      const vals = list.filter(e => e.a != null).map(e => e.a);
      const med = vals.length ? Math.round(_median(vals) * 10) / 10 : null;
      if (med == null) {                                 // no reference flights yet
        ctx.fillStyle = CT.roseLabel; ctx.globalAlpha = 0.25;
        ctx.fillRect((xa + xb) / 2 - 0.5, y + h * 0.3, 1, h * 0.4); ctx.globalAlpha = 1;
      } else {
        const c = _stColor(med, light);
        if (c) { ctx.fillStyle = c; ctx.fillRect(xa, y, xb - xa - (xb - xa > 3 ? 1 : 0), h); }
      }
      // a flight at or beyond its advisory limit: dot in the cell
      const over = list.filter(e => e.a != null && Math.abs(e.a) >= (e.f.thr || (st.limits ? st.limits[0] : 10)));
      if (over.length) {
        strong += over.length;
        ctx.fillStyle = edge; ctx.beginPath();
        ctx.arc((xa + xb) / 2, y + h / 2, Math.max(1.2, Math.min(2.2, (xb - xa) / 3)), 0, 2 * Math.PI); ctx.fill();
      }
      const t1 = new Date(bin * binMs).toISOString().slice(11, 16), t2 = new Date((bin + 1) * binMs).toISOString().slice(11, 16);
      const lines = list.slice(0, 6).map(e => `${new Date(e.f.ts * 1000).toISOString().slice(11, 16)} ${(e.f.cs || '?').padEnd(8)} ${(e.f.type || '').padEnd(4)} ` +
        `${e.f.ph === 'dep' ? 'dep' : 'ldg'} ${String(e.f.rwy || '').padEnd(3)} ${fmtA(e.a).padStart(5)} kt  ${String(e.wd).padStart(3, '0')}°/${e.ws} kt`);
      dots.push({ x: (xa + xb) / 2, y: y + h / 2, dotR: Math.max(1, Math.min(xb - xa, h) / 2 - 4),
        color: med == null ? CT.roseLabel : (med < 0 ? (light ? '#2563eb' : '#60a5fa') : (light ? '#dc2626' : '#f87171')),
        label: `${t1}–${t2} UTC · ${b} ft: ${med == null ? 'no earlier flights to compare' : `median ${fmtA(med)} kt headwind vs the previous 45 min`}` +
               `\n${lines.join('\n')}${list.length > 6 ? `\n… ${list.length - 6} more` : ''}`,
        // the cell's flights, for a list beside the diagram (the phone view, from 2026-10-28)
        cell: { t1, t2, b, med, items: list.map(e => ({ ts: e.f.ts, cs: e.f.cs, type: e.f.type, ph: e.f.ph, rwy: e.f.rwy,
                                                        lvl: e.f.lvl, a: e.a, wd: e.wd, ws: e.ws })) } });
    }
    if (readout) readout.textContent = `${nArr} landings · ${nDep} departures · ${strong} band${strong === 1 ? '' : 's'} beyond the advisory limit`;
    return dots;
  }


  // ── Boundary layer (BL view, from 2026-10-29; RESEARCH) ─────────────────────
  // Time × height 0–5000 ft MSL from /api/boundary (collector/boundary.py), one
  // column per UTC hour (the hour in progress included): field 'wind' — the wind
  // speed of the 250-ft bins (kt colours), or 'temp' — the temperature of the
  // 200-ft bands 400–5000 ft (above 3000 ft from the climb-outs, from 30 Oct 2026) against the METAR temperature (red warmer = inversion,
  // blue colder); hatched where there were no flights.  The low-level jet's nose as
  // a diamond with its speed, joined hour to hour (the jet core); a surface
  // inversion as a red bar along the bottom.  Hover / tap: the cell, the jet, the
  // inversion.
  // d = { bl: [{ts, w: [[ft, kt, dir, n]], t: [[ft, °C, n]], tt, llj: {ft, kt, dir, drop, sh}, inv: {dT, top}, partial}],
  //       hours, field: 'wind' | 'temp', fetchedMs, nowMs }
  const BL_TOP = 5000;
  function _spdCol(v) {           // kt → colour (blue … green … yellow … red)
    const stops = [[0, [30, 58, 138]], [10, [14, 116, 144]], [20, [16, 185, 129]], [30, [234, 179, 8]], [40, [249, 115, 22]], [55, [220, 38, 38]]];
    let i = 0; while (i < stops.length - 2 && v > stops[i + 1][0]) i++;
    const [a, ca] = stops[i], [b, cb] = stops[i + 1], f = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return `rgb(${ca.map((c, k) => Math.round(c + (cb[k] - c) * f)).join(',')})`;
  }
  function _dtCol(v, light) {     // T − T_surface: blue colder … white … red warmer (inversion)
    const f = Math.max(-1, Math.min(1, v / 8));
    const w = light ? [248, 250, 252] : [226, 232, 240];
    const t = f >= 0 ? [220, 38, 38] : [37, 99, 235];
    const g = Math.abs(f);
    return `rgb(${w.map((c, k) => Math.round(c + (t[k] - c) * g)).join(',')})`;
  }
  // ── The boundary layer flight by flight (from 2026-10-31; RESEARCH) ──────────
  // The same fields and rules as the Sounding page's Time–height section
  // (static/js/timeheight.js flFilled / flRef / flDiff / flShear, hwFill /
  // chgFill / shFill — keep them in step): each landing and departure a column
  // held until the next flight (at most 20 min), 100-ft bins.
  //   'blh' headwind along the flight's runway (violet = tailwind)
  //   'bld' the change against the median of the flights of the previous 45 min
  //         in the same direction (±30°, ≥ 3), ±100 ft mean; ±2 kt nearly clear, full at ±12
  //   'bls' the vertical shear of the flight's own profile: the slope over ±200 ft
  //         (at least 4 of 5 values), kt per 100 ft; ±0.7 nearly clear, full at ±3
  const FL_HOLD = 20 * 60, FL_REF = 45 * 60, FL_BIN = 100, FL_DIR = 30;
  const FL_FIELDS = ['blh', 'bld', 'bls'];
  const _angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  const _flVal = (f, ft) => { const j = Math.round((ft - f.lo) / FL_BIN); return j >= 0 && j < f.v.length ? f.v[j] : null; };
  function _flFilled(f) {
    if (f._fill) return f._fill;
    const v = f.v, out = v.map(x => (x == null ? null : [x, false]));
    for (let j = 0; j < v.length; j++) {
      if (v[j] != null) continue;
      let a = j - 1; while (a >= 0 && v[a] == null) a--;
      let b = j + 1; while (b < v.length && v[b] == null) b++;
      if (a >= 0 && b < v.length && b - a <= 4) out[j] = [v[a] + (v[b] - v[a]) * (j - a) / (b - a), true];
    }
    return (f._fill = out);
  }
  function _flRef(f, rows) {
    if (f._ref !== undefined) return f._ref;
    f._ref = null;
    if (f.h == null) return null;
    const refs = rows.filter(o => o !== f && o.t < f.t && o.t >= f.t - FL_REF && o.h != null && _angDiff(o.h, f.h) <= FL_DIR);
    if (refs.length < 3) return null;
    const m = new Map();
    for (let j = 0; j < f.v.length; j++) {
      const ft = f.lo + j * FL_BIN, vs = [];
      for (const o of refs) { const v = _flVal(o, ft); if (v != null) vs.push(v); }
      if (vs.length >= 3) { vs.sort((a, b) => a - b); const k = vs.length >> 1; m.set(ft, vs.length % 2 ? vs[k] : (vs[k - 1] + vs[k]) / 2); }
    }
    return (f._ref = { n: refs.length, m });
  }
  function _flDiff(f, ref, j) {
    if (!ref) return null;
    const fv = _flFilled(f);
    let s = 0, n = 0;
    for (let k = j - 1; k <= j + 1; k++) {
      if (k < 0 || k >= fv.length || !fv[k]) continue;
      const r = ref.m.get(f.lo + k * FL_BIN);
      if (r == null) continue;
      s += fv[k][0] - r; n++;
    }
    return n ? s / n : null;
  }
  function _flShear(f, j) {
    const fv = _flFilled(f);
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let k = j - 2; k <= j + 2; k++) {
      if (k < 0 || k >= fv.length || !fv[k]) continue;
      const x = k - j, y = fv[k][0];
      n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    if (n < 4) return null;
    const den = n * sxx - sx * sx;
    return den ? (n * sxy - sx * sy) / den : null;
  }
  const _DIV = { neg: [37, 99, 235], pos: [220, 38, 38] };
  const _hwFill = v => v >= 0 ? _spdCol(v) : `rgba(168,85,247,${(0.35 + 0.6 * Math.min(1, -v / 10)).toFixed(2)})`;
  function _chgFill(v) {
    const k = Math.max(0, Math.min(1, (Math.abs(v) - 2) / 10)), c = v < 0 ? _DIV.neg : _DIV.pos;
    return `rgba(${c[0]},${c[1]},${c[2]},${(0.06 + 0.86 * k).toFixed(3)})`;
  }
  function _shFill(v) {
    const k = Math.max(0, Math.min(1, (Math.abs(v) - 0.7) / 2.3)), c = v < 0 ? _DIV.neg : _DIV.pos;
    return `rgba(${c[0]},${c[1]},${c[2]},${(0.05 + 0.87 * k).toFixed(3)})`;
  }
  const _sgn = (v, p = 1) => { const r = Math.abs(v) < 0.5 / 10 ** p ? 0 : v; return (r >= 0 ? '+' : '') + r.toFixed(p); };   // no "-0.0"
  // the flight columns; returns {n landings, n departures}
  function _drawFlights(ctx, d, geo, dots, CT, light) {
    const { L, T, PW, PH, xOf, yOf, t0, nowMs, field } = geo;
    const all = (d.fl || []).filter(f => f && f.v && f.lo != null);
    const rows = all.filter(f => f.t * 1000 >= t0 - FL_HOLD * 1000 && f.t * 1000 <= nowMs);
    const LV = { adv: '#3b82f6', wsa: '#d97706', mba: '#ef4444' };
    const DIRC = { '04': '#38bdf8', '05': '#38bdf8', '15': '#f59e0b', '14': '#f59e0b', '16': '#f59e0b', '22': '#2dd4bf', '23': '#2dd4bf', '33': '#f472b6', '34': '#f472b6', '32': '#f472b6' };
    const rwDir = f => (f.rw && /^\d\d/.test(f.rw) ? f.rw.slice(0, 2) : f.h != null ? String(Math.round(f.h / 10) % 36 || 36).padStart(2, '0') : '?');
    const plotBg = CT.roseBg;
    const cols = [];
    let nA = 0, nD = 0;
    ctx.save(); ctx.beginPath(); ctx.rect(L, T, PW, PH); ctx.clip();
    for (let i = 0; i < rows.length; i++) {
      const f = rows[i], nx = rows[i + 1];
      if (f.t * 1000 >= t0) f.k === 'd' ? nD++ : nA++;
      const x0 = xOf(f.t * 1000);
      const w = Math.max(1.5, Math.min((nx ? xOf(nx.t * 1000) : xOf(nowMs)) - x0, xOf((f.t + FL_HOLD) * 1000) - x0));
      const ref = field === 'bld' ? _flRef(f, all) : null;
      cols.push({ x0, w, f });
      const fv = _flFilled(f);
      for (let j = 0; j < fv.length; j++) {
        if (!fv[j]) continue;
        const [v, filled] = fv[j], ft = f.lo + j * FL_BIN;
        let col;
        if (field === 'blh') col = _hwFill(v);
        else if (field === 'bls') { const sh = _flShear(f, j); if (sh == null) continue; col = _shFill(sh); }
        else { const dv = _flDiff(f, ref, j); if (dv == null) continue; col = _chgFill(dv); }
        const ya = yOf(ft + FL_BIN / 2), yb = yOf(ft - FL_BIN / 2);
        ctx.globalAlpha = 1; ctx.fillStyle = plotBg; ctx.fillRect(x0, ya, w + 0.5, yb - ya + 0.5);
        ctx.globalAlpha = filled ? 0.6 : 1; ctx.fillStyle = col; ctx.fillRect(x0, ya, w + 0.5, yb - ya + 0.5);
        if (x0 + w < L || x0 > L + PW) continue;
        // hover: built only when read (a day has some 30 000 cells)
        dots.push({ x: Math.max(L, x0) + Math.min(w, L + PW - Math.max(L, x0)) / 2, y: (ya + yb) / 2,
          dotR: Math.max(1, Math.min(w, yb - ya) / 2 - 3), color: CT.roseLabel,
          get label() {
            const hm = new Date(f.t * 1000).toISOString().slice(11, 16);
            const lines = [`${hm}Z ${f.cs || '?'} ${f.ty || ''} ${f.k === 'd' ? 'departure' : 'landing'}${f.rw ? ' RWY ' + f.rw : ''} · ${ft} ft`,
              `headwind ${_sgn(v)} kt${v < 0 ? ' (tailwind)' : ''}${filled ? ' (gap filled)' : ''}`];
            const r = _flRef(f, all), rv = r && r.m.get(ft);
            if (rv != null) { const dv = _flDiff(f, r, j); lines.push(`${_sgn(v - rv)} kt against the median ${rv.toFixed(1)} kt of ${r.n} flights of the previous 45 min (±100 ft mean ${dv == null ? '–' : _sgn(dv)} kt)`); }
            else lines.push('fewer than 3 flights of the previous 45 min in the same direction at this height');
            const sh = _flShear(f, j);
            if (sh != null) lines.push(`shear ${_sgn(sh)} kt per 100 ft over ±200 ft (${Math.abs(sh) < 0.05 ? 'no shear' : sh > 0 ? 'more headwind higher up — a descent loses headwind' : 'less headwind higher up — a descent gains headwind'})`);
            if (f.lv && f.lv !== 'none') lines.push(`windshear ${f.lv.toUpperCase()}${f.wa ? ` at ${f.wa[0]}–${f.wa[1]} ft` : ''}`);
            lines.push(f.src === 'v7' ? 'TAS − GS of the BDS 5,0 replies (no ADS-B ground speed) · research' : 'both airspeed registers against the ADS-B ground speed (v8) · research');
            return lines.join('\n');
          } });
      }
      ctx.globalAlpha = 1;
    }
    // windshear alerts: the ramp (or band) outlined in the level's colour
    for (const c of cols) {
      if (!c.f.wa || !LV[c.f.lv]) continue;
      const ya = yOf(c.f.wa[1] + 50), yb = yOf(c.f.wa[0] - 50), ww = Math.max(c.w, 4);
      for (const [col, lw] of [[light ? '#ffffff' : '#0f172a', 3.5], [LV[c.f.lv], 1.8]]) {
        ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.strokeRect(c.x0 - 0.5, ya, ww + 1, yb - ya);
      }
    }
    // the landing runway along the top (the headwind is along each flight's runway)
    ctx.font = 'bold 9px "Courier New",monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    let lastLbl = -1e9, lastDir = null;
    for (const c of cols) {
      if (c.f.k !== 'a') continue;
      const dd = rwDir(c.f);
      ctx.fillStyle = DIRC[dd] || CT.roseLabel; ctx.fillRect(c.x0, T, c.w + 0.5, 3);
      const lx = Math.max(L, c.x0);                 // the first column may start left of the plot
      if (dd !== lastDir && lx >= lastLbl && c.x0 + c.w > L) {
        const t = `RWY ${dd}`;
        ctx.strokeStyle = light ? '#ffffff' : '#0f172a'; ctx.lineWidth = 3; ctx.strokeText(t, lx + 2, T + 13);
        ctx.fillStyle = DIRC[dd] || CT.roseLabel; ctx.fillText(t, lx + 2, T + 13);
        lastLbl = lx + ctx.measureText(t).width + 8;
      }
      lastDir = dd;
    }
    ctx.restore();
    return { nA, nD };
  }

  function drawBoundaryLayer(ctx, W, H, readout, d) {
    const CT = theme(), light = isLight(), dots = [];
    const hours = d.hours || 24, nowMs = d.nowMs || Date.now(), t0 = nowMs - hours * 3_600_000;
    // d.L: the left margin (from 2026-10-31 24 under the ACI / WS chart of the phone, so the hours line up)
    const L = d.L || 34, R = 8, T = 22, B = 18, PW = W - L - R, PH = H - T - B;
    const xOf = ms => L + (ms - t0) / (hours * 3_600_000) * PW;
    const yOf = ft => T + PH - Math.max(0, Math.min(BL_TOP, ft)) / BL_TOP * PH;
    const field = d.field || 'wind';
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = CT.roseBg; ctx.fillRect(0, 0, W, H);
    // hatch for no data
    ctx.save(); ctx.beginPath(); ctx.rect(L, T, PW, PH); ctx.clip();
    ctx.strokeStyle = light ? 'rgba(100,116,139,.18)' : 'rgba(148,163,184,.12)'; ctx.lineWidth = 1;
    for (let x = L - PH; x < L + PW; x += 7) { ctx.beginPath(); ctx.moveTo(x, T + PH); ctx.lineTo(x + PH, T); ctx.stroke(); }
    ctx.restore();
    const rows = (d.bl || []).filter(r => r.ts * 1000 >= t0 - 3_600_000 && r.ts * 1000 <= nowMs);
    const cw = PW / hours;
    const isFl = FL_FIELDS.includes(field);
    const flN = isFl ? _drawFlights(ctx, d, { L, T, PW, PH, xOf, yOf, t0, nowMs, field }, dots, CT, light) : null;
    ctx.save(); ctx.beginPath(); ctx.rect(L, T, PW, PH); ctx.clip();
    for (const r of (isFl ? [] : rows)) {
      const x = xOf(r.ts * 1000), x1 = xOf(r.ts * 1000 + 3_600_000);
      if (field === 'wind') for (const [ft, kt, dir, n] of r.w || []) {
        const ya = yOf(ft + 125), yb = yOf(ft - 125);
        ctx.fillStyle = _spdCol(kt); ctx.fillRect(x, ya, x1 - x + 0.5, yb - ya + 0.5);
        dots.push({ x: (x + x1) / 2, y: (ya + yb) / 2, dotR: Math.max(4, Math.min(cw, yb - ya) / 2),
          color: CT.roseLabel, label: `${_hm(r.ts)}–${_hm(r.ts + 3600)}Z${r.partial ? ' (so far)' : ''} ${ft} ft: ${String(dir).padStart(3, '0')}°/${kt} kt` + (n ? ` (${n} obs)` : '') });
      }
      if (field === 'temp' && r.tt != null) for (const [ft, tc] of r.t || []) {
        const ya = yOf(ft + 100), yb = yOf(ft - 100), v = tc - r.tt;
        ctx.fillStyle = _dtCol(v, light); ctx.fillRect(x, ya, x1 - x + 0.5, yb - ya + 0.5);
        dots.push({ x: (x + x1) / 2, y: (ya + yb) / 2, dotR: Math.max(4, Math.min(cw, yb - ya) / 2), color: CT.roseLabel,
          label: `${_hm(r.ts)}–${_hm(r.ts + 3600)}Z ${ft} ft: ${tc.toFixed(1)} °C, ${v >= 0 ? '+' : ''}${v.toFixed(1)} K against the surface (METAR ${r.tt} °C)` });
      }
    }
    ctx.restore();
    // axes
    ctx.strokeStyle = CT.roseRing; ctx.lineWidth = 1; ctx.strokeRect(L + 0.5, T + 0.5, PW, PH);
    ctx.font = '9px "Courier New",monospace'; ctx.fillStyle = CT.roseLabel; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let ft = 0; ft <= BL_TOP; ft += 1000) {
      ctx.fillText(ft ? `${ft / 1000}k` : '0', L - 4, yOf(ft));
      ctx.strokeStyle = CT.roseOuter; ctx.beginPath(); ctx.moveTo(L, Math.round(yOf(ft)) + 0.5); ctx.lineTo(L + PW, Math.round(yOf(ft)) + 0.5); ctx.stroke();
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const tickH = hours <= 6 ? 1 : hours <= 12 ? 2 : 3, tickMs = tickH * 3_600_000;
    for (let h = Math.ceil(t0 / tickMs) * tickMs; h <= nowMs; h += tickMs) {
      ctx.fillText(String(new Date(h).getUTCHours()).padStart(2, '0') + 'Z', xOf(h), T + PH + 4);
    }
    // inversion: a red bar along the bottom (clipped to the plot, like the cells)
    ctx.save(); ctx.beginPath(); ctx.rect(L, T, PW, PH); ctx.clip();
    for (const r of rows) {
      if (!r.inv) continue;
      const x = xOf(r.ts * 1000), x1 = xOf(r.ts * 1000 + 3_600_000);
      ctx.save(); ctx.globalAlpha = 0.9;
      ctx.fillStyle = light ? '#b91c1c' : '#f87171'; ctx.fillRect(x + 1, T + PH - 5, x1 - x - 2, 5);
      ctx.restore();
      dots.push({ x: (x + x1) / 2, y: T + PH - 3, dotR: 5, color: light ? '#b91c1c' : '#f87171',
        label: `${_hm(r.ts)}–${_hm(r.ts + 3600)}Z surface inversion: the air at 600–1000 ft ${r.inv.dT.toFixed(1)} K warmer than at the surface (METAR ${r.tt} °C), warmer than the surface up to about ${r.inv.top} ft` });
    }
    ctx.restore();
    // low-level jet: diamonds at the nose, joined hour to hour (the jet core)
    const jc = light ? '#0f172a' : '#ffffff';
    let prev = null;
    ctx.save();
    for (const r of rows.slice().sort((a, b) => a.ts - b.ts)) {
      if (!r.llj) { prev = null; continue; }
      const x = (xOf(r.ts * 1000) + xOf(r.ts * 1000 + 3_600_000)) / 2, y = yOf(r.llj.ft);
      if (prev && r.ts - prev.ts <= 3600) { ctx.strokeStyle = jc; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(x, y); ctx.stroke(); }
      ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y); ctx.closePath();
      ctx.fillStyle = jc; ctx.fill(); ctx.strokeStyle = light ? '#fff' : '#0f172a'; ctx.lineWidth = 1; ctx.stroke();
      if (cw > 14) { ctx.font = 'bold 8px "Courier New",monospace'; ctx.fillStyle = jc; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(String(r.llj.kt), x, y - 6); }
      dots.push({ x, y, dotR: 6, color: jc,
        label: `${_hm(r.ts)}–${_hm(r.ts + 3600)}Z low-level jet: ${r.llj.kt} kt from ${String(r.llj.dir).padStart(3, '0')}° at ${r.llj.ft} ft` +
               `\n${r.llj.drop} m/s weaker within 1500 ft above` + (r.llj.sh != null ? ` · shear below ${r.llj.sh} kt per 1000 ft` : '') });
      prev = { ts: r.ts, x, y };
    }
    ctx.restore();
    if (isFl ? !(flN.nA + flN.nD) : !rows.length) {
      ctx.fillStyle = CT.noTraffic; ctx.font = '10px "Courier New",monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(!d.fetchedMs ? 'Loading…' : isFl ? 'No flights with a headwind profile in the range' : 'No boundary-layer data in the range', L + PW / 2, T + PH / 2);
    }
    // title
    ctx.font = '10px "Courier New",monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = CT.roseLabel;
    const TITLE = { wind: 'Boundary layer · wind speed', temp: 'Boundary layer · temperature against the surface',
                    blh: 'Boundary layer · headwind per flight', bld: 'Boundary layer · headwind change per flight',
                    bls: 'Boundary layer · wind shear per flight' };
    const SHORT = { wind: 'BL · wind speed', temp: 'BL · temperature', blh: 'BL · headwind per flight', bld: 'BL · Δ headwind per flight', bls: 'BL · shear per flight' };
    const tt = ctx.measureText(TITLE[field] || TITLE.wind).width + 5 + 24 <= W ? TITLE[field] || TITLE.wind : SHORT[field] || SHORT.wind;
    ctx.fillText(tt, 5, 5);
    ctx.textAlign = 'right'; ctx.fillText(wrRangeLabel(hours), W - 5, 5);
    // the readout's first line kept short (from 2026-10-30; the inversion's 600–1000 ft is in its hover text):
    // a longer line wrapped and changed the chart's height when an inversion came or went
    if (readout) {
      const last = rows.filter(r => nowMs - r.ts * 1000 <= 2 * 3_600_000).sort((a, b) => b.ts - a.ts)[0];
      const nj = rows.filter(r => r.llj).length, ni = rows.filter(r => r.inv).length;
      const now = last ? [last.llj ? `<b>low-level jet ${last.llj.ft} ft ${last.llj.kt} kt</b> from ${String(last.llj.dir).padStart(3, '0')}°` : 'no low-level jet',
                          last.inv ? `<b style="color:${light ? '#b91c1c' : '#f87171'}">surface inversion +${last.inv.dT.toFixed(0)} K</b>` : 'no surface inversion'].join(' · ') : 'no data in the last hours';
      const sw = c => `<span style="color:${c}">■</span>`;
      const key = field === 'wind'
        ? ['0', '10', '20', '30', '40', '55'].map(v => `${sw(_spdCol(+v))}${v}`).join(' ') + ' kt'
        : field === 'temp'
        ? `${sw(_dtCol(-6, light))}−6 ${sw(_dtCol(0, light))}0 ${sw(_dtCol(6, light))}+6 K`
        : field === 'blh'
        ? `headwind ${sw(_hwFill(-8))}tail ` + ['0', '10', '20', '30', '40'].map(v => `${sw(_spdCol(+v))}${v}`).join(' ') + ' kt'
        : field === 'bld'
        ? `vs. the previous 45 min ${sw(_chgFill(-12))}−12 ${sw(_chgFill(-6))}−6 ±2 ${sw(_chgFill(6))}+6 ${sw(_chgFill(12))}+12 kt`
        : `shear ${sw(_shFill(-3))}−3 ${sw(_shFill(-1.5))}−1.5 ±0.7 ${sw(_shFill(1.5))}+1.5 ${sw(_shFill(3))}+3 kt / 100 ft`;
      const second = isFl ? `${wrRangeLabel(hours)}: ${flN.nA} landings · ${flN.nD} departures · jet ${nj} h · inversion ${ni} h`
                          : `${wrRangeLabel(hours)}: jet ${nj} h · inversion ${ni} h`;
      readout.innerHTML = `Last hour: ${now}<br>${second} <span class="ws-research-tag">research</span>` +
        `<br><span class="ws-cond-legend">◆ jet core · <span style="color:${light ? '#b91c1c' : '#f87171'}">▬ surface inversion</span> · ${key}${isFl ? ' · □ windshear alert' : ''} · ▨ no flights</span>`;
    }
    return dots;
  }

  return { draw, drawBoundaryLayer, drawSpaceTime, rangeLabel: wrRangeLabel };
})();
