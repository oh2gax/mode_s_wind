/**
 * ils_profile.js — the ILS vertical profile (3° glideslope, 0–15 NM) for the
 * mobile view /app (from 2026-10-26): a compact drawing of the same picture
 * as the Windshear page's ILS profile (windshear.js drawIlsProfile), from the
 * same data — /api/windshear/state — with the same conventions:
 *   glideslope   threshold elevation + 318.5 ft/NM + (1013.25 − QNH) × 27 ft
 *                + trim, ±300 ft band; aircraft dots coloured ON / HIGH / LOW
 *   trails       the last minute of each aircraft (gaps over 10 s left open)
 *   wind barbs   the server's barbs of the selected aircraft (barbs / barbs_hi:
 *                [dist NM, alt ft, kt, dir, src]), coloured by the meteo
 *                source, with the headwind or crosswind component on top
 *   NONE marks   hollow circles where no wind could be computed (amber: turn,
 *                grey: GPS freeze / gap)
 *   windshear    active alerts (ws_events) as bands across the profile
 *   METAR        the surface wind as a barb at the threshold
 *
 *   IlsProfile.draw(ctx, W, H, { aircraft, events, qnh, metarWind, thrElev,
 *     gsOffset, rangeNm, rwy, selIcao, barbs: 'lo' | 'hi' | 'off',
 *     comp: 'hw' | 'xw' | 'off', trails, alertLevel })  → [{x, y, icao}] dots
 */
'use strict';

const IlsProfile = (() => {
  const GS_FT_PER_NM = 318.5, GS_TOL_FT = 300, MAX_FT = 5000;
  const RWY_HEADINGS = { '04L': 47, '04R': 47, '22L': 227, '22R': 227, '15': 152, '33': 323 };
  const SRC_COLOR = { MRAR: '#3b82f6', COMPUTED: '#10b981', MHR: '#f59e0b', JSON: '#a855f7', NONE: '#6b7280' };
  const GS_COLOR = { ON: '#6ee7b7', HIGH: '#fcd34d', LOW: '#fca5a5', FAR: '#6b7280' };
  const GS_COLOR_LIGHT = { ON: '#047857', HIGH: '#b45309', LOW: '#b91c1c', FAR: '#64748b' };
  const LV = { adv: { short: 'ADV', col: '#3b82f6', rank: 0 }, wsa: { short: 'WSA', col: '#d97706', rank: 1 },
               mba: { short: 'MBA', col: '#ef4444', rank: 2 } };
  const isLight = () => document.documentElement.dataset.theme === 'light';
  const theme = () => {
    const l = isLight();
    return {
      bg: l ? '#eef2f7' : '#162030', grid: l ? '#c5d0da' : '#28394f',
      gsband: l ? 'rgba(37,99,235,0.08)' : 'rgba(56,189,248,0.07)', gsline: l ? '#2563eb' : '#38bdf8',
      axis: l ? '#475569' : '#64748b', none: l ? '#64748b' : '#3d4b60',
      trail: l ? 'rgba(0,0,0,0.26)' : 'rgba(255,255,255,0.32)', metar: l ? '#0284c7' : '#38bdf8',
      labelBg: l ? 'rgba(238,242,247,0.88)' : 'rgba(22,32,48,0.85)', hint: l ? '#64748b' : '#475569',
    };
  };
  const hwKt = (s, d, h) => s * Math.cos((d - h) * Math.PI / 180);
  const xwKt = (s, d, h) => s * Math.sin((d - h) * Math.PI / 180);
  const rwyMatch = (r, f) => !f || (f === '04L&R' ? (r === '04L' || r === '04R') : f === '22L&R' ? (r === '22L' || r === '22R') : r === f);

  function barb(ctx, x, y, kt, dir, color) {
    if (kt == null || dir == null) return;
    const spd = Math.round(kt / 5) * 5;
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.5;
    if (spd === 0) { ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.stroke(); return; }
    const r = dir * Math.PI / 180, L = 18, ex = x + L * Math.sin(r), ey = y - L * Math.cos(r);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();
    let rem = spd, pos = 0;
    const step = 4;
    while (rem >= 50) {
      const sx = ex - pos * Math.sin(r), sy = ey + pos * Math.cos(r);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + 9 * Math.cos(r), sy + 9 * Math.sin(r));
      ctx.lineTo(sx + step * Math.sin(r), sy - step * Math.cos(r)); ctx.closePath(); ctx.fill();
      pos += step + 2; rem -= 50;
    }
    while (rem >= 10) {
      const sx = ex - pos * Math.sin(r), sy = ey + pos * Math.cos(r);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + 8 * Math.cos(r), sy + 8 * Math.sin(r)); ctx.stroke();
      pos += step; rem -= 10;
    }
    if (rem >= 5) {
      const sx = ex - pos * Math.sin(r), sy = ey + pos * Math.cos(r);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + 4 * Math.cos(r), sy + 4 * Math.sin(r)); ctx.stroke();
    }
  }

  function gsStatus(ac, base) {
    if (ac.dist_thr_nm == null || ac.dist_thr_nm > 20) return 'FAR';
    const d = ac.altitude - (base + ac.dist_thr_nm * GS_FT_PER_NM);
    return Math.abs(d) <= GS_TOL_FT ? 'ON' : d > 0 ? 'HIGH' : 'LOW';
  }

  function draw(ctx, W, H, o) {
    const T = theme(), light = isLight();
    const narrow = W < 520;
    const M = { left: narrow ? 40 : 52, right: 10, top: 16, bottom: 30 };
    const PW = W - M.left - M.right, PH = H - M.top - M.bottom;
    const range = o.rangeNm || 15;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = T.bg; ctx.fillRect(0, 0, W, H);
    if (PW < 40 || PH < 40) return [];
    const X = d => M.left + (1 - d / range) * PW;
    const Y = a => M.top + (1 - a / MAX_FT) * PH;
    const mono = px => `${px}px "Courier New", monospace`;

    // grid and axes
    ctx.strokeStyle = T.grid; ctx.lineWidth = 1;
    const aStep = PH < 260 ? 1000 : 500;
    for (let a = 0; a <= MAX_FT; a += 500) { ctx.beginPath(); ctx.moveTo(M.left, Y(a)); ctx.lineTo(M.left + PW, Y(a)); ctx.stroke(); }
    const dStep = range <= 7.5 ? 2.5 : 5;
    for (let d = 0; d <= range + 1e-6; d += dStep) { ctx.beginPath(); ctx.moveTo(X(d), M.top); ctx.lineTo(X(d), M.top + PH); ctx.stroke(); }
    ctx.fillStyle = T.axis; ctx.font = mono(narrow ? 9 : 10); ctx.textAlign = 'right';
    for (let a = aStep; a <= MAX_FT; a += aStep) ctx.fillText(a.toLocaleString('en').replace(/,/g, ' '), M.left - 4, Y(a) + 3);
    ctx.textAlign = 'center';
    for (let d = 0; d <= range + 1e-6; d += dStep) ctx.fillText(d === 0 ? 'THR' : String(d), X(d), M.top + PH + 12);
    ctx.fillText('NM from threshold · ft', M.left + PW / 2, H - 4);

    // glideslope
    const qnh = o.qnh || 1013.25, qnhCorr = (1013.25 - qnh) * 27;
    const base = (o.thrElev || 179) + (o.gsOffset || 0) + qnhCorr;
    const gs = d => base + d * GS_FT_PER_NM;
    const gMax = Math.min(range, (MAX_FT - base) / GS_FT_PER_NM);
    ctx.save();
    ctx.beginPath(); ctx.rect(M.left, M.top, PW, PH); ctx.clip();             // the band stays inside the plot
    ctx.beginPath();
    ctx.moveTo(X(0), Y(gs(0) + GS_TOL_FT)); ctx.lineTo(X(gMax), Y(gs(gMax) + GS_TOL_FT));
    ctx.lineTo(X(gMax), Y(gs(gMax) - GS_TOL_FT)); ctx.lineTo(X(0), Y(gs(0) - GS_TOL_FT)); ctx.closePath();
    ctx.fillStyle = T.gsband; ctx.fill();
    ctx.beginPath(); ctx.moveTo(X(0), Y(gs(0))); ctx.lineTo(X(gMax), Y(gs(gMax)));
    ctx.strokeStyle = T.gsline; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.globalAlpha = 0.7; ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.restore();

    // windshear bands (active alerts at or above the chosen level)
    const minRank = o.alertLevel === 'off' ? 99 : (LV[o.alertLevel] || LV.wsa).rank;
    for (const e of o.events || []) {
      const lv = LV[e.lvl] || LV.adv;
      if (lv.rank < minRank || !rwyMatch(e.rwy, o.rwy)) continue;
      const a1 = e.a1 ?? 0, a2 = e.a2 ?? 0, yt = Y(Math.max(a1, a2)), yb = Y(Math.min(a1, a2));
      if (yb - yt <= 0) continue;
      ctx.fillStyle = lv.col + '22'; ctx.fillRect(M.left, yt, PW, yb - yt);
      ctx.strokeStyle = lv.col + '88'; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(M.left, yt); ctx.lineTo(M.left + PW, yt); ctx.moveTo(M.left, yb); ctx.lineTo(M.left + PW, yb); ctx.stroke();
      ctx.setLineDash([]);
      const kt = Math.round(e.kind === 'band' ? Math.abs(e.a) : Math.abs(e.dv));
      ctx.fillStyle = lv.col; ctx.font = mono(10); ctx.textAlign = 'right';
      ctx.fillText(`${lv.short}${e.ph === 'dep' ? ' DEP' : ''} ${kt}kt${e.dir === 'loss' ? '▼' : e.dir === 'gain' ? '▲' : ''}`, M.left + PW - 4, (yt + yb) / 2 + 4);
    }

    const acs = (o.aircraft || []).filter(a => a.in_corridor && a.dist_thr_nm != null && rwyMatch(a.approach_runway, o.rwy));
    const pal = light ? GS_COLOR_LIGHT : GS_COLOR;
    const dots = [], labels = [];
    const now = Date.now() / 1000;
    for (const ac of acs) {
      const col = pal[gsStatus(ac, base)] || pal.FAR;
      if (o.trails && Array.isArray(ac.history) && ac.history.length > 1) {
        ctx.beginPath();
        let first = true, prev = null;
        for (const h of ac.history) {
          if (h.dist_thr > range || h.altitude > MAX_FT) continue;
          const gap = prev != null && h.ts - prev > 10;
          if (first || gap) { ctx.moveTo(X(h.dist_thr), Y(h.altitude)); first = false; } else ctx.lineTo(X(h.dist_thr), Y(h.altitude));
          prev = h.ts;
        }
        ctx.strokeStyle = T.trail; ctx.lineWidth = 1; ctx.stroke();
      }
      if (ac.dist_thr_nm > range || ac.altitude > MAX_FT) continue;
      const x = X(ac.dist_thr_nm), y = Y(ac.altitude);
      const stale = ac.altitude < 1000 && now - (ac.last_seen || now) > 10;
      ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fillStyle = col + '22'; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, ac.icao === o.selIcao ? 6 : 5, 0, Math.PI * 2);
      ctx.fillStyle = stale ? T.axis : col; ctx.fill();
      ctx.strokeStyle = ac.icao === o.selIcao ? (light ? '#0f172a' : '#f8fafc') : '#000';
      ctx.lineWidth = ac.icao === o.selIcao ? 2 : 1; ctx.stroke();
      dots.push({ x, y, icao: ac.icao });
      if (!stale) labels.push({ text: (ac.callsign || ac.icao) + (ac.ap ? '*' : ''), x, y, col, right: x > M.left + PW * 0.7 });
    }
    if (!acs.length) {
      ctx.fillStyle = T.none; ctx.font = '13px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('No approach traffic', M.left + PW / 2, M.top + PH / 2);
    }

    // barbs and NONE marks of the selected aircraft
    const sel = (o.aircraft || []).find(a => a.icao === o.selIcao);
    if (o.barbs !== 'off' && sel) {
      const list = (o.barbs === 'hi' ? sel.barbs_hi : sel.barbs) || [];
      const hdg = RWY_HEADINGS[sel.approach_runway] ?? RWY_HEADINGS[o.rwy] ?? null;
      const ann = narrow ? 0 : 1;
      for (const b of list) {
        const [d, a, kt, dir, src] = b;
        if (d == null || d < 0 || d > range || a == null || a < 0 || a > MAX_FT) continue;
        const bx = X(d), by = Y(a);
        const c = src && src !== 'NONE' ? SRC_COLOR[src] || SRC_COLOR.NONE : (light ? '#64748b' : '#94a3b8');
        barb(ctx, bx, by, kt, dir, c);
        if (o.comp !== 'off' && hdg != null) {
          const v = o.comp === 'xw' ? xwKt(kt, dir, hdg) : hwKt(kt, dir, hdg);
          const cc = o.comp === 'hw'
            ? (v > 5 ? (light ? '#15803d' : '#4ade80') : v < -5 ? (light ? '#b91c1c' : '#f87171') : (light ? '#a16207' : '#fbbf24'))
            : (Math.abs(v) >= 10 ? (light ? '#b91c1c' : '#fca5a5') : Math.abs(v) >= 5 ? (light ? '#a16207' : '#fcd34d') : (light ? '#047857' : '#6ee7b7'));
          ctx.fillStyle = cc; ctx.font = `bold ${mono(10 - ann)}`; ctx.textAlign = 'center';
          ctx.fillText(`${v >= 0 ? '+' : ''}${Math.round(v)}`, bx, by - 24 < M.top + 6 ? by + 16 : by - 24);
        }
      }
      ctx.lineWidth = 1.5;
      for (const n of sel.none_hist || []) {
        const [d, a, why] = n;
        if (d < 0 || d > range || a < 0 || a > MAX_FT) continue;
        ctx.strokeStyle = why === 'qc' ? '#fb923c' : '#6b7280';
        ctx.beginPath(); ctx.arc(X(d), Y(a), 3, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = SRC_COLOR[sel.meteo_source] || (light ? '#64748b' : '#94a3b8');
      ctx.font = `bold ${mono(10)}`; ctx.textAlign = 'left';
      ctx.fillText(`${sel.callsign || sel.icao} · ${list.length} barbs${o.comp !== 'off' && hdg != null ? ` · ${o.comp.toUpperCase()} ${sel.approach_runway || o.rwy}` : ''}`,
                   M.left + 4, M.top + PH - 6);          // bottom left: below the glideslope, free of barbs
    } else if (o.barbs !== 'off' && acs.length) {
      ctx.fillStyle = T.hint; ctx.font = mono(10); ctx.textAlign = 'left';
      ctx.fillText('Tap an aircraft for its wind barbs', M.left + 4, M.top + PH - 6);
    }

    // METAR surface wind at the threshold
    const mw = o.metarWind;
    if (o.barbs !== 'off' && mw && mw.spd != null) {
      const x = X(0) - 10, y = Y(gs(0));
      if (mw.variable || mw.dir == null) { ctx.strokeStyle = T.metar; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.stroke(); }
      else barb(ctx, x, y, mw.spd, mw.dir, T.metar);
      // the text in the top right corner (high above the threshold: always free)
      ctx.fillStyle = T.metar; ctx.font = `bold ${mono(10)}`; ctx.textAlign = 'right';
      ctx.fillText(`METAR ${mw.dir == null || mw.variable ? 'VRB' : String(mw.dir).padStart(3, '0')}/${mw.spd}${mw.gust ? 'G' + mw.gust : ''} kt`, M.left + PW - 4, M.top + 12);
    }

    // callsign labels last, on a background, moved up when they overlap
    ctx.font = `bold ${mono(10)}`; ctx.textBaseline = 'alphabetic';
    const placed = [];
    for (const L of labels.sort((a, b) => b.y - a.y)) {
      const w = ctx.measureText(L.text).width + 6, h = 12;
      const bx = L.right ? L.x - 9 - w : L.x + 6;
      let by = L.y - 17;
      for (let k = 0; k < 6; k++) {
        const hit = placed.find(r => bx < r.x + r.w && bx + w > r.x && by < r.y + r.h && by + h > r.y);
        if (!hit) break;
        by = hit.y - h - 1;
      }
      by = Math.max(M.top, by);
      placed.push({ x: bx, y: by, w, h });
      ctx.fillStyle = T.labelBg; ctx.fillRect(bx, by, w, h);
      ctx.fillStyle = L.col; ctx.textAlign = 'left'; ctx.fillText(L.text, bx + 3, by + 10);
    }
    return dots;
  }

  return { draw, gsStatus, RWY_HEADINGS, hwKt };
})();
