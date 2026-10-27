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
  function _wsLvOfSc(sc, loss) {
    if (sc == null) return null;
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
        const rl = r.zone ? _wsLvOfSc(r.sc, loss) : null;
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


  return { draw, rangeLabel: wrRangeLabel };
})();
