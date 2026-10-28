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
 *     hours,      // range 3 / 6 / 12 / 24
 *     withWs,     // false: ACI only; true: ACI + the windshear strip
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
    const wrCondEntries = d.cond || wrAphEntries.filter(e => e.cond && e.cond.idx != null);
    const wrCondHours = d.hours || 3, wrCondFetchedMs = d.fetchedMs || 0;
    const CT    = theme();
    const wrHistDots = [];
    const light = document.documentElement.dataset.theme === 'light';
    const CLS_COL = light ? COND_CLASS_COLORS_LIGHT : COND_CLASS_COLORS_DARK;
    const withWs = !!d.withWs;
    const nowMs = d.nowMs || Date.now();
    const spanMs = wrCondHours * 3_600_000;
    const t0 = nowMs - spanMs;
    const L = 24, R = 8, T = 22, B = 18;          // plot margins
    const GAP = 6;                                // between the ACI and the WS part
    const PW = W - L - R;
    const PH = withWs ? Math.round((H - T - B - GAP) * 0.56) : H - T - B;   // ACI part
    const WT = T + PH + GAP, WH = H - B - WT;                               // WS strip
    const xOf = ms  => L + (ms - t0) / spanMs * PW;
    const yOf = idx => T + PH - Math.max(0, Math.min(10, idx)) / 10 * PH;
    const grey = light ? '#94a3b8' : '#64748b';

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = CT.roseBg;
    ctx.fillRect(0, 0, W, H);

    // Level bands (0–2 smooth … 8–10 very rough)
    for (let l = 0; l < 5; l++) {
      ctx.globalAlpha = light ? 0.13 : 0.09;
      ctx.fillStyle = COND_LVL_COLORS[l];
      ctx.fillRect(L, yOf((l + 1) * 2), PW, yOf(l * 2) - yOf((l + 1) * 2));
    }
    ctx.globalAlpha = 1;

    // Axes, y labels, hourly x ticks (labels under the lowest part)
    ctx.strokeStyle = CT.roseRing;
    ctx.lineWidth = 1;
    ctx.strokeRect(L + 0.5, T + 0.5, PW, PH);
    if (withWs) ctx.strokeRect(L + 0.5, WT + 0.5, PW, WH);
    ctx.font = '9px "Courier New",monospace';
    ctx.fillStyle = CT.roseLabel;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let v = 0; v <= 10; v += withWs ? 5 : 2) ctx.fillText(String(v), L - 4, yOf(v));
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const tickH   = wrCondHours <= 6 ? 1 : wrCondHours <= 12 ? 2 : 3;   // hours between x labels
    const tickMs  = tickH * 3_600_000;
    const firstHour = Math.ceil(t0 / tickMs) * tickMs;
    const yBottom = withWs ? WT + WH : T + PH;
    for (let h = firstHour; h <= nowMs; h += tickMs) {
      const x = xOf(h);
      ctx.strokeStyle = CT.roseOuter;
      ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + PH); ctx.stroke();
      if (withWs) { ctx.beginPath(); ctx.moveTo(x, WT); ctx.lineTo(x, WT + WH); ctx.stroke(); }
      ctx.fillText(String(new Date(h).getUTCHours()).padStart(2, '0') + 'Z', x, yBottom + 4);
    }

    // Title + range
    ctx.font = '10px "Courier New",monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';  ctx.fillStyle = CT.roseLabel;
    ctx.fillText(withWs ? 'Approach conditions + windshear' : 'Approach conditions', 5, 5);
    ctx.textAlign = 'right';
    ctx.fillText(wrRangeLabel(wrCondHours), W - 5, 5);

    const pts = wrCondEntries
      .filter(e => e.ts * 1000 >= t0 && e.ts * 1000 <= nowMs)
      .map(e => ({ ms: e.ts * 1000, idx: e.cond.idx, e }))
      .sort((a, b) => a.ms - b.ms);

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
                  (withWs || lv ? `\nWindshear: ${_wsShortTxt(p.e.shear)}` : '');
      wrHistDots.push({ x, y, dotR: 3, label: lbl, color: col });
    }
    if (!pts.length) {
      ctx.fillStyle = CT.noTraffic;
      ctx.font = '10px "Courier New",monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(wrCondFetchedMs ? 'No scored landings yet' : 'Loading…', L + PW / 2, T + PH / 2);
    }

    // ── Windshear strip (ACI + WS view) ─────────────────────────────────────────
    let wsSum = null;
    if (withWs) wsSum = _drawWsStrip(ctx, { L, PW, WT, WH, t0, nowMs, xOf, CT, light, grey, T, PH,
                                             wrAphEntries, wrDepEntries, wrGaEvents, wrCondFetchedMs, wrHistDots });

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
        `<br><span class="ws-cond-legend">│ ramp (1 km) · ◆ band landing · ◇ band departure · ▲ go-around</span>`;
    }
    readout.innerHTML = `${line1}<br>${line2}${line3}<br><span class="ws-cond-legend">${legend}${met}</span>`;
    return wrHistDots;
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

  return { draw, drawSpaceTime, rangeLabel: wrRangeLabel };
})();
