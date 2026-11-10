/**
 * sndcal.js — Calendar view of the Sounding page (from 2026-11-10).
 *
 * One row per UTC day (the newest at the top), one column per UTC hour, each
 * cell coloured by one quantity of that hour (/api/sounding/calendar →
 * web/api/th_extra.py calendar):
 *   inv   surface inversion: T(600–1 000 ft) − T(surface), K (bl_hours)
 *   llj   low-level jet below 5 000 ft, kt (bl_hours)
 *   wind  wind speed of the area profile's 2 000–3 000 ft layer, kt
 *   ws    landings / departures with a windshear level
 *   edr   turbulence: median EDR of the hour's flights (research)
 *   gnss  share of aircraft with a degraded GNSS position, %
 *   ac    aircraft behind the hourly area profile
 * Weeks at a glance: which nights had an inversion, when the jet blew, which
 * days were rough.  Hover for all values of the hour; click opens that day in
 * the Time–height section.
 *
 * window.SndCal = { init(opts), load(), render() }
 */
(function () {
  const $ = id => document.getElementById(id);
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } };
  const pad = n => String(n).padStart(2, '0');
  const light = () => document.documentElement.dataset.theme === 'light';
  const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const st = { q: lsGet('ms_cal_q', 'inv'), days: parseInt(lsGet('ms_cal_days', '56'), 10) || 56 };
  let data = null, byTs = null, geo = null, openDay = null, seq = 0;

  // classes: [lower limit, colour, label]; a value below the first limit is the "zero" class
  const seqc = (dark, lite) => (light() ? lite : dark);
  const Q = {
    inv: { title: 'Surface inversion', unit: 'K', idx: 1, zero: 'flights, no inversion',
           cls: () => [[0.3, seqc('#4c3a8f', '#c4b5fd'), '< 1'], [1, seqc('#6d55c9', '#a78bfa'), '1–2'], [2, seqc('#8b74ee', '#8b5cf6'), '2–4'],
                       [4, seqc('#b3a2ff', '#6d28d9'), '4–6'], [6, seqc('#ede9fe', '#4c1d95'), '≥ 6 K']] },
    llj: { title: 'Low-level jet', unit: 'kt', idx: 3, zero: 'wind data, no jet',
           cls: () => [[1, '#0e7490', '< 20'], [20, '#10b981', '20–25'], [25, '#eab308', '25–30'], [30, '#f97316', '30–40'], [40, '#dc2626', '≥ 40 kt']] },
    wind: { title: 'Wind at 2 000–3 000 ft', unit: 'kt', idx: 5,
            cls: () => [[0, '#1d4e89', '< 10'], [10, '#21918c', '10–20'], [20, '#6cc24a', '20–30'], [30, '#f2d930', '30–40'], [40, '#f28a1e', '40–50'], [50, '#c7303c', '≥ 50 kt']] },
    ws: { title: 'Windshear reports', unit: '', idx: 7, zero: 'flights, no report',
          cls: () => [[1, '#eab308', '1'], [2, '#f97316', '2'], [3, '#ef4444', '3–4'], [5, '#b91c1c', '≥ 5 per hour']] },
    edr: { title: 'Turbulence (EDR, median of the flights)', unit: '', idx: 9,
           cls: () => [[0, '#1e3a5f', 'smooth'], [0.05, '#2fa86e', 'slight'], [0.10, '#f2d930', 'light'], [0.20, '#f28a1e', 'moderate'], [0.45, '#c7303c', 'severe']] },
    gnss: { title: 'GNSS-degraded aircraft', unit: '%', idx: 11,
            cls: () => [[0, seqc('#334155', '#cbd5e1'), '< 5'], [5, '#a16207', '5–20'], [20, '#f59e0b', '20–50'], [50, '#f97316', '50–80'], [80, '#ef4444', '≥ 80 %']] },
    ac: { title: 'Aircraft in the area profile', unit: '', idx: 12,
          cls: () => [[0, '#ef4444', '< 8 (low)'], [8, '#f59e0b', '8–19'], [20, seqc('#0e7490', '#67b7c9'), '20–39'], [40, seqc('#22d3ee', '#0e7490'), '≥ 40']] },
  };
  const ZERO = () => (light() ? '#dbe3ec' : '#1f2c3b');
  function fillOf(q, v) {
    const cls = Q[q].cls();
    if (v < cls[0][0]) return ZERO();
    let c = cls[0][1];
    for (const b of cls) if (v >= b[0]) c = b[1];
    return c;
  }
  const fmtFt = ft => `${Math.round(ft).toLocaleString('en').replace(/,/g, ' ')} ft`;

  function render() {
    const cv = $('cal-canvas'), box = $('cal-box');
    if (!cv || !box || box.clientWidth === 0) return;
    const L = light();
    const C = { bg: L ? '#f8fafc' : '#0f1923', plot: L ? '#eef2f6' : '#131e2b', ink: L ? '#0f172a' : '#e2e8f0', ink2: L ? '#475569' : '#94a3b8',
                grid: L ? '#cbd5e1' : '#243447', wk: L ? '#94a3b8' : '#3b4b5f' };
    const nD = data ? data.days : st.days;
    const ml = 78, mr = 14, mt = 24, mb = 8;
    const W = box.clientWidth - 14;                                   // room for the scroll bar
    const rh = Math.max(11, Math.min(22, Math.floor((box.clientHeight - mt - mb) / nD)));
    const H = mt + mb + nD * rh;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
    if (!data) { g.fillStyle = C.ink2; g.font = '13px system-ui'; g.fillText('Loading…', 20, 30); return; }
    const cw = (W - ml - mr) / 24;
    geo = { ml, mt, cw, rh, nD, W };
    g.fillStyle = C.plot; g.fillRect(ml, mt, cw * 24, rh * nD);
    g.font = '11px system-ui'; g.textAlign = 'center'; g.fillStyle = C.ink2;
    for (let h = 0; h < 24; h++) g.fillText(pad(h), ml + (h + 0.5) * cw, mt - 8);
    g.textAlign = 'right'; g.fillText('UTC', ml - 8, mt - 8);
    const q = Q[st.q], last = data.start + (nD - 1) * 86400;
    for (let r = 0; r < nD; r++) {
      const day = last - r * 86400, d = new Date(day * 1000), y0 = mt + r * rh;
      if (rh >= 13 || d.getUTCDay() === 1 || r === 0) {
        g.fillStyle = d.getUTCDay() === 0 || d.getUTCDay() === 6 ? C.ink2 : C.ink; g.textAlign = 'right'; g.font = `${Math.min(11, rh - 1)}px system-ui`;
        g.fillText(`${DAY[d.getUTCDay()]} ${d.getUTCDate()}.${d.getUTCMonth() + 1}.`, ml - 8, y0 + rh / 2 + 4);
      }
      for (let h = 0; h < 24; h++) {
        const row = byTs.get(day + h * 3600), v = row ? row[q.idx] : null;
        if (v == null) continue;
        g.fillStyle = fillOf(st.q, v);
        g.fillRect(ml + h * cw + 0.5, y0 + 0.5, cw - 1, rh - 1);
      }
      if (d.getUTCDay() === 1) {                                       // a line above each Monday
        g.strokeStyle = C.wk; g.lineWidth = 1; g.beginPath(); g.moveTo(ml - 70, y0 + rh + 0.5); g.lineTo(ml + cw * 24, y0 + rh + 0.5); g.stroke();
      }
    }
    g.strokeStyle = C.grid; g.lineWidth = 1; g.strokeRect(ml + 0.5, mt + 0.5, cw * 24, rh * nD);
    // the hour in progress
    const nowH = Math.floor(Date.now() / 3600000) * 3600, rr = Math.round((last - Math.floor(nowH / 86400) * 86400) / 86400);
    if (rr >= 0 && rr < nD) {
      const h = (nowH / 3600) % 24;
      g.strokeStyle = C.ink; g.setLineDash([3, 2]); g.strokeRect(ml + h * cw + 0.5, mt + rr * rh + 0.5, cw - 1, rh - 1); g.setLineDash([]);
    }
  }

  function renderLegend() {
    const el = $('cal-legend'), q = Q[st.q];
    if ($('cal-title')) $('cal-title').textContent = `Calendar · ${q.title}${data ? ` · ${data.days} days` : ''}`;
    if (!el) return;
    const sw = c => `<span class="th-sw" style="background:${c}"></span>`;
    el.innerHTML = (q.zero ? sw(ZERO()) + `<span class="th-lt">${q.zero}</span> ` : '') +
      q.cls().map(b => sw(b[1]) + `<span class="th-lt">${b[2]}</span>`).join(' ') +
      ' <span class="th-lt">· empty: no data · line: start of a week · click: open the day in the Time–height section</span>';
  }

  function locate(ev) {
    if (!geo || !data) return null;
    const rect = $('cal-canvas').getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    const h = Math.floor((mx - geo.ml) / geo.cw), r = Math.floor((my - geo.mt) / geo.rh);
    if (h < 0 || h > 23 || r < 0 || r >= geo.nD) return null;
    const day = data.start + (geo.nD - 1 - r) * 86400;
    return { mx, my, day, ts: day + h * 3600, row: byTs.get(day + h * 3600) };
  }
  function hover(ev) {
    const tip = $('cal-tip'), h = locate(ev);
    if (!h) { tip.style.display = 'none'; return; }
    const d = new Date(h.ts * 1000);
    const parts = [`<b>${DAY[d.getUTCDay()]} ${d.getUTCDate()}.${d.getUTCMonth() + 1}. ${pad(d.getUTCHours())}–${pad((d.getUTCHours() + 1) % 24)} UTC</b>`];
    const r = h.row;
    if (!r) parts.push('<span class="mini-tip-dim">no data for this hour</span>');
    else {
      const b = (k, t) => st.q === k ? `<b>${t}</b>` : t;
      if (r[1] != null) parts.push(b('inv', r[1] > 0 ? `surface inversion +${r[1].toFixed(1)} K${r[2] ? `, top about ${fmtFt(r[2])}` : ''}` : 'no surface inversion'));
      if (r[3] != null) parts.push(b('llj', r[3] > 0 ? `low-level jet ${r[3]} kt${r[4] ? ` at ${fmtFt(r[4])}` : ''}` : 'no low-level jet'));
      if (r[5] != null) parts.push(b('wind', `wind at 2 000–3 000 ft ${r[6] != null ? String(r[6]).padStart(3, '0') + '° ' : ''}${r[5]} kt`));
      if (r[8]) parts.push(b('ws', `windshear reports ${r[7] || 0}`) + ` <span class="mini-tip-dim">of ${r[8]} flights</span>`);
      if (r[9] != null) parts.push(b('edr', `turbulence EDR ${r[9].toFixed(2)}`) + ` <span class="mini-tip-dim">(median of ${r[10]} flights, research)</span>`);
      if (r[11] != null) parts.push(b('gnss', `GNSS degraded ${r[11]} % of the aircraft`));
      if (r[12] != null) parts.push(b('ac', `${r[12]} aircraft in the area profile`));
    }
    parts.push('<span class="mini-tip-dim">click: open this day in the Time–height section</span>');
    tip.innerHTML = parts.join('<br>');
    tip.style.display = '';
    const box = $('cal-box');
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.max(2, Math.min(box.clientWidth - tw - 18, h.mx + 14)) + 'px';
    tip.style.top = Math.max(box.scrollTop + 2, Math.min(box.scrollTop + box.clientHeight - th - 4, h.my + 14)) + 'px';
  }
  function click(ev) {
    const h = locate(ev);
    if (!h || !openDay) return;
    const d = new Date(h.day * 1000);
    openDay(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, st.q);
  }

  async function load() {
    const req = ++seq, meta = $('sounding-meta');
    if (meta && !meta.textContent) meta.textContent = 'Loading…';
    try {
      const d = await fetch(`/api/sounding/calendar?days=${st.days}`).then(r => r.json());
      if (req !== seq) return;
      data = d; byTs = new Map((d.hours || []).map(r => [r[0], r]));
      const n = (d.hours || []).filter(r => r[Q[st.q].idx] != null).length;
      if (meta) meta.textContent = `${d.days} days · ${n} hours with a value`;
      renderLegend(); render();
    } catch (e) {
      if (meta) meta.textContent = 'Error loading the calendar.';
      console.error(e);
    }
  }
  function syncControls() {
    if ($('cal-q')) $('cal-q').value = st.q;
    document.querySelectorAll('#cal-days-btns .snd-mode-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.days, 10) === st.days));
  }
  function init(opts = {}) {
    openDay = opts.openDay || null;
    if (![28, 56, 120].includes(st.days)) st.days = 56;
    if (!Q[st.q] || ($('cal-q') && ![...$('cal-q').options].some(o => o.value === st.q))) st.q = 'inv';   // GNSS: Full view only
    syncControls();
    if ($('cal-q')) $('cal-q').addEventListener('change', e => {
      st.q = e.target.value; lsSet('ms_cal_q', st.q); renderLegend(); render();
      const meta = $('sounding-meta');
      if (meta && data) meta.textContent = `${data.days} days · ${(data.hours || []).filter(r => r[Q[st.q].idx] != null).length} hours with a value`;
    });
    document.querySelectorAll('#cal-days-btns .snd-mode-btn').forEach(b => b.addEventListener('click', () => {
      st.days = parseInt(b.dataset.days, 10); lsSet('ms_cal_days', st.days); syncControls(); load();
    }));
    const cv = $('cal-canvas');
    if (!cv) return;
    cv.addEventListener('mousemove', hover);
    cv.addEventListener('mouseleave', () => { $('cal-tip').style.display = 'none'; });
    cv.addEventListener('click', click);
    new ResizeObserver(() => { if ($('cal-box').clientWidth) render(); }).observe($('cal-box'));
  }

  window.SndCal = { init, load, render };
})();
