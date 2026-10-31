/* ATC-style map display, shared by the Live Map and the Windshear map
 * (from 2026-10-30): history plots, speed vectors, range rings and the
 * radar-display labels with leader lines and automatic anti-overlap, all drawn
 * on one canvas layer; the ATC map lines (airport, ILS / RNP finals, coastline)
 * and the ATC colours; the Hover's extended label of the aircraft under the
 * mouse (from 30 Oct 2026).
 *
 * A generic European radar-display look, after the conventions of systems such
 * as Thales TopSky, whose screens and settings are not
 * public — not a copy of any one system.  A research display, not for air
 * traffic control.  The colours follow the page theme: dark grey in Dark,
 * light grey in Light.
 */
const AtcDisplay = (() => {
  const PAL = {
    // dark: a little darker from 31 Oct 2026 (bg #1b2027 before)
    dark:  { bg: '#161a20', apt: '#5b6573', ils: '#46566a', rnp: '#6b5a3c', coast: '#36414e', ring: '#2c3540', ringTxt: '#4f5a67',
             low: '#d1fae5', high: '#9ca3af', sel: '#facc15', leader: '#7b8594', ga: '#ef4444', extBg: '#0c1015' },
    // light: a darker mid grey from 31 Oct 2026 (bg #cfd2d5, ring #b3b8be, ringTxt #8a9099, coast #8b9bb0 before)
    light: { bg: '#b7bbc0', apt: '#59626e', ils: '#2a4a7a', rnp: '#8a5a1c', coast: '#7a899e', ring: '#9ea4ab', ringTxt: '#737a84',
             low: '#0b3b2c', high: '#4b5563', sel: '#1d4ed8', leader: '#5d6672', ga: '#dc2626', extBg: '#e9ebed' },
  };
  const isLight = () => document.documentElement.dataset.theme === 'light';
  const pal = () => PAL[isLight() ? 'light' : 'dark'];
  const LOW_FT       = 6000;              // below: the light symbol colour
  const HIST_STEPS   = [0, 5, 10, 20];    // history plots shown
  const VEC_STEPS    = [0, 30, 60, 120];  // speed vector, s
  const RING_STEPS   = [0, 5, 10];        // range rings, NM apart (0 = off)
  const HIST_EVERY_S = 5;                 // a plot kept ≥ 5 s after the previous (updates every 3 s → ~6 s)
  const MAX_TRAIL    = 40;
  const lsInt = (k, steps, dflt) => {
    try { const v = parseInt(localStorage.getItem(k), 10); return steps.includes(v) ? v : dflt; }
    catch (_) { return dflt; }
  };
  const lsSet = (k, v) => { try { localStorage.setItem(k, String(v)); } catch (_) { /* private mode */ } };

  // Keep a history plot: [lat, lon, ts] when ≥ HIST_EVERY_S after the previous and moved
  function addTrail(t, lat, lon, ts) {
    const last = t[t.length - 1];
    if (last && ts - last[2] < HIST_EVERY_S) return;
    if (last && Math.abs(last[0] - lat) < 1e-5 && Math.abs(last[1] - lon) < 1e-5) return;   // standing still
    t.push([lat, lon, ts]);
    if (t.length > MAX_TRAIL) t.shift();
  }

  // The point sec seconds ahead along the track at the ground speed (great circle)
  function vecEnd(lat, lon, trackDeg, gsKt, sec) {
    const d = gsKt * sec / 3600 * 1852 / 6371000, br = trackDeg * Math.PI / 180;
    const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
    const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(br));
    const lo2 = lo + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
    return [la2 * 180 / Math.PI, lo2 * 180 / Math.PI];
  }

  // Own panes: the canvas (plots, vectors, labels) above the weather and the ATC
  // map lines, under the aircraft symbols (markerPane 600); the ATC map lines
  // above the weather overlay (350–365)
  function ensurePanes(map) {
    if (!map.getPane('livePlots')) {
      map.createPane('livePlots').style.zIndex = 450;
      map.getPane('livePlots').style.pointerEvents = 'none';
    }
    if (!map.getPane('atcMapPane')) {
      map.createPane('atcMapPane').style.zIndex = 370;
      map.getPane('atcMapPane').style.pointerEvents = 'none';
    }
  }

  // One canvas over the map; draw(g, map, W, H) is called on redraw() and after
  // a pan, zoom or resize (hidden during the zoom animation)
  const CanvasLayer = L.Layer.extend({
    initialize(draw) { this._draw = draw; },
    onAdd(m) {
      this._c = L.DomUtil.create('canvas', 'live-plot-layer');
      m.getPane('livePlots').appendChild(this._c);
      m.on('moveend zoomend resize viewreset', this._reset, this);
      m.on('zoomstart', this._hide, this);
      this._reset();
    },
    onRemove(m) {
      m.off('moveend zoomend resize viewreset', this._reset, this);
      m.off('zoomstart', this._hide, this);
      this._c.remove();
    },
    _hide() { this._c.style.visibility = 'hidden'; },
    _reset() {
      const m = this._map, sz = m.getSize(), dpr = window.devicePixelRatio || 1;
      L.DomUtil.setPosition(this._c, m.containerPointToLayerPoint([0, 0]));
      this._c.width  = Math.round(sz.x * dpr);
      this._c.height = Math.round(sz.y * dpr);
      this._c.style.width  = sz.x + 'px';
      this._c.style.height = sz.y + 'px';
      this._c.style.visibility = '';
      this.redraw();
    },
    redraw() {
      if (!this._map) return;
      const c = this._c, g = c.getContext('2d'), dpr = window.devicePixelRatio || 1;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, c.width, c.height);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._draw(g, this._map, c.width / dpr, c.height / dpr);
      g.globalAlpha = 1;
    },
  });
  function canvasLayer(map, draw) { ensurePanes(map); return new CanvasLayer(draw).addTo(map); }

  // History plots: small filled squares, older ones fainter (stronger on the pale
  // Light-theme map); pts oldest first.  Pushes their boxes to obst.
  function drawPlots(g, m, pts, histN, col, fade, obst) {
    const light = isLight(), aNew = light ? 0.95 : 0.85, aOld = light ? 0.45 : 0.25;
    const n = pts.length;
    g.fillStyle = col;
    for (let k = 0; k < n; k++) {
      const age = n - 1 - k;                     // 0 = the newest plot
      const q = m.latLngToContainerPoint([pts[k][0], pts[k][1]]);
      g.globalAlpha = (aNew - (aNew - aOld) * age / Math.max(1, histN - 1)) * fade;
      g.fillRect(q.x - 1.75, q.y - 1.75, 3.5, 3.5);
      if (obst) obst.push({ x: q.x - 2, y: q.y - 2, w: 4, h: 4 });
    }
  }

  // Speed vector from the square's edge to where the aircraft is after sec s
  function drawVector(g, m, p0, ac, sec, col, alpha, width, obst) {
    if (!sec || ac.track == null || !(ac.groundspeed > 30)) return;
    const pe = m.latLngToContainerPoint(vecEnd(ac.lat, ac.lon, ac.track, ac.groundspeed, sec));
    const dx = pe.x - p0.x, dy = pe.y - p0.y, L0 = Math.hypot(dx, dy);
    if (L0 <= 6) return;
    g.globalAlpha = alpha;
    g.strokeStyle = col;
    g.lineWidth = width;
    g.beginPath();
    g.moveTo(p0.x + dx * 5 / L0, p0.y + dy * 5 / L0);
    g.lineTo(pe.x, pe.y);
    g.stroke();
    if (obst) for (let d = 8; d < L0; d += 8) obst.push({ x: p0.x + dx * d / L0 - 2, y: p0.y + dy * d / L0 - 2, w: 4, h: 4 });
  }

  // Range rings every step NM from the airport (to 30 NM), with their distance
  function drawRings(g, m, W, H, step, lat, lon) {
    if (!step) return;
    const P = pal(), c = m.latLngToContainerPoint([lat, lon]);
    const pxPerNm = Math.abs(m.latLngToContainerPoint([lat + 1 / 60, lon]).y - c.y);
    if (pxPerNm * step < 14) return;                  // zoomed far out: no rings
    g.globalAlpha = 1;
    g.strokeStyle = P.ring; g.lineWidth = 1;
    g.fillStyle = P.ringTxt; g.font = '10px Consolas, "DejaVu Sans Mono", monospace';
    g.textAlign = 'center'; g.textBaseline = 'bottom';
    for (let nm = step; nm <= 30; nm += step) {
      const r = nm * pxPerNm;
      g.beginPath(); g.arc(c.x, c.y, r, 0, 2 * Math.PI); g.stroke();
      if (c.y - r > 8 && c.y - r < H) g.fillText(String(nm), c.x, c.y - r - 1);
    }
    g.textAlign = 'left';
  }

  // The label lines of an aircraft at a label level (the pages' Lbl buttons):
  // one item, or callsign / level, trend and selected level in hundreds of feet
  // (019↑060) / ground speed in tens of knots and type (19 AT75).  lvl3(pa) gives
  // the three-digit level (QNH altitude up to the transition altitude, FL above).
  function labelLines(ac, lv, cs, lvl3) {
    if (lv === 'off') return null;
    if (lv === 'cs')   return [cs];
    if (lv === 'reg')  return [ac.registration || cs];
    if (lv === 'icao') return [ac.icao];
    if (lv === 'type') return [ac.aircraft_type || '—'];
    const vr = ac.vert_rate, tr = vr == null ? ' ' : vr >= 300 ? '↑' : vr <= -300 ? '↓' : ' ';
    const sel = lv === 'full' && ac.sel_alt != null ? String(Math.round(ac.sel_alt / 100)).padStart(3, '0') : '';
    const l2 = ac.landed ? 'landed' : ((ac.altitude == null ? '---' : lvl3(ac.altitude)) + tr + sel).trimEnd();
    if (lv === 'alt') return [cs, l2];
    const gs = ac.groundspeed != null ? String(Math.round(ac.groundspeed / 10)).padStart(2, '0') : '--';
    return [cs, l2, `${gs} ${ac.aircraft_type || ''}`.trimEnd()];
  }

  // Labels with leader lines, placed so that they do not overlap: each tries 16
  // positions (8 directions, near and far) and takes the one with the least
  // overlap with the labels already placed, the aircraft symbols and the history
  // plots and speed vectors (obst), inside the map; it keeps its last position
  // (pos[key]) while that stays free, so the labels do not jump.  The selected
  // aircraft first, then from the lowest up (the approach traffic).
  // items: { key, p (container point), lines, col, sel, fade, alt, ga (GA mark), gaOn,
  //          ext (the hover's extended label: placed first, on a dark backing with a frame) }
  // Returns the label boxes, key → { x, y, w, h } (the hover keeps a label open
  // while the mouse is on it).
  const DIRS = [[1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1]];   // NE first
  const LH = 13;
  // fs: the font size in px (12 by default; the phone's Weather view 10, from 2026-10-30)
  // opt (from 2026-10-31, the phone's approach map): font — a whole CSS font instead of
  // the monospaced one; lh — the line height in px; halo — an outline colour under the
  // text (labels over a street map); leader — the leader-line colour
  function drawLabels(g, items, W, H, obst, pos, fs = 12, opt = {}) {
    const P = pal(), lh = opt.lh || Math.round(fs * LH / 12);
    g.font = opt.font || `${fs}px Consolas, "DejaVu Sans Mono", "Courier New", monospace`;
    g.textBaseline = 'top';
    for (const it of items) {
      const ws = it.lines.map((t, i) => g.measureText(t + (i === 0 && it.ga ? ' GA' : '')).width);
      it.w = Math.ceil(Math.max(...ws)) + 4;
      it.h = it.lines.length * lh + 2;
    }
    const syms = items.map(it => ({ x: it.p.x - 6, y: it.p.y - 6, w: 12, h: 12, key: it.key }));
    const ov = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
                         Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const rectFor = (it, k) => {
      const [dx, dy] = DIRS[k % 8], r = k < 8 ? 22 : 44, u = dx && dy ? 0.7071 : 1;
      const ax = it.p.x + dx * r * u, ay = it.p.y + dy * r * u;
      const x = dx > 0 ? ax : dx < 0 ? ax - it.w : ax - it.w / 2;
      const y = dy < 0 ? ay - it.h : dy > 0 ? ay : ay - it.h / 2;
      return { x, y, w: it.w, h: it.h, ax, ay, ux: dx * u, uy: dy * u };
    };
    const ALL = Array.from({ length: 16 }, (_, i) => i);
    items.sort((a, b) => (!!b.ext - !!a.ext) || (b.sel - a.sel) || (a.alt - b.alt));
    const placed = [], rects = {};
    for (const it of items) {
      const prev = pos[it.key];
      const order = prev != null ? [prev, ...ALL.filter(i => i !== prev)] : ALL;
      let best = null, bestCost = Infinity;
      for (const k of order) {
        const R = rectFor(it, k);
        let cost = k >= 8 ? 1 : 0;                     // a near position first
        for (const q of placed) cost += ov(R, q) * 4;
        for (const q of syms) if (q.key !== it.key) cost += ov(R, q) * 8;
        for (const q of obst) cost += ov(R, q) * 2;
        // outside the map: a fixed cost, and (from 2026-10-31) more the more of the label is
        // outside, so that a large label (the extended one) is not placed half off the map
        if (R.x < 0 || R.y < 0 || R.x + R.w > W || R.y + R.h > H)
          cost += 50 + (R.w * R.h - Math.max(0, Math.min(R.x + R.w, W) - Math.max(R.x, 0)) * Math.max(0, Math.min(R.y + R.h, H) - Math.max(R.y, 0))) * 8;
        if (k === prev && cost <= 1) { best = { k, R }; break; }
        if (cost < bestCost) { bestCost = cost; best = { k, R }; }
      }
      pos[it.key] = best.k;
      placed.push(best.R);
      const R = best.R;
      rects[it.key] = R;
      if (it.ext) {                                    // the extended label: a backing and a thin frame
        g.globalAlpha = 0.9;
        g.fillStyle = P.extBg;
        g.fillRect(R.x - 3, R.y - 2, R.w + 6, R.h + 3);
        g.globalAlpha = 0.5;
        g.strokeStyle = it.col; g.lineWidth = 1;
        g.strokeRect(Math.round(R.x - 3) + 0.5, Math.round(R.y - 2) + 0.5, Math.round(R.w + 6) - 1, Math.round(R.h + 3) - 1);
      }
      g.globalAlpha = it.fade;
      g.strokeStyle = it.sel ? it.col : (opt.leader || P.leader); g.lineWidth = 1;
      g.beginPath(); g.moveTo(it.p.x + R.ux * 6, it.p.y + R.uy * 6); g.lineTo(R.ax, R.ay); g.stroke();
      if (opt.halo) {                                  // an outline under the text (street maps)
        g.strokeStyle = opt.halo; g.lineWidth = 3; g.lineJoin = 'round';
        it.lines.forEach((t, i) => g.strokeText(t, R.x + 2, R.y + 1 + i * lh));
      }
      g.fillStyle = it.col;
      it.lines.forEach((t, i) => g.fillText(t, R.x + 2, R.y + 1 + i * lh));
      if (it.ga && it.gaOn) {                          // go-around: a red GA after the callsign
        g.fillStyle = P.ga;
        g.fillText('GA', R.x + 2 + g.measureText(it.lines[0] + ' ').width, R.y + 1);
      }
    }
    g.globalAlpha = 1;
    return rects;
  }

  // ── Hover (from 30 Oct 2026): the extended label ──────────────────────────
  // With the Hover button on (ATC style), the label of the aircraft under the
  // mouse grows into an extended label with the values the receiver has just
  // heard from it (/api/live/ac/<icao>: the latest Comm-B BDS 5,0 / 6,0 replies,
  // ADS-B quality and the selected altitude — read from memory, nothing stored),
  // fetched at once and every 2 s while the mouse stays on it.
  const HOVER_POLL_MS = 2000;
  const HOVER_HIT_PX  = 10;                // the mouse within 10 px of the symbol
  const sgn = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v);
  const pad3 = v => String(v).padStart(3, '0');
  const norm180 = d => ((d % 360) + 540) % 360 - 180;

  // The six lines of the extended label.  ac: the aircraft as on the map (the
  // stream); x: the hover reply (or null while it is on its way); o: { cs, lvl3,
  // apt: [lat, lon, name] }.  A value not heard within 20 s shows as ---.
  function extLines(ac, x, o) {
    x = x || {};
    const b5 = x.b50 || {}, b6 = x.b60 || {};
    const alt = ac.altitude, vr = ac.vert_rate;
    const tr = vr == null ? ' ' : vr >= 300 ? '↑' : vr <= -300 ? '↓' : ' ';
    const selA = x.sel ?? ac.sel_alt;
    const l1 = [o.cs, ac.aircraft_type || x.type, ac.registration || x.reg].filter(Boolean).join('  ');
    const lvl = ac.landed ? 'landed' : (alt == null ? '---' : o.lvl3(alt)) + tr;
    const mode = x.app ? '  APP' : x.ap ? '  AP' : '';
    const l2 = `${lvl}  sel ${selA != null ? pad3(Math.round(selA / 100)) : '---'}  VR ${vr != null ? sgn(Math.round(vr / 10) * 10) : '---'}${mode}`;
    const gs = ac.groundspeed ?? b5.gs;
    const l3 = `GS ${gs != null ? Math.round(gs) : '---'}  TAS ${b5.tas != null ? Math.round(b5.tas) : '---'}  IAS ${b6.ias != null ? Math.round(b6.ias) : '---'}  M${b6.mach != null ? '.' + pad3(Math.round(b6.mach * 1000)) : ' ---'}`;
    // track and heading magnetic (the true track less the declination at the aircraft)
    const decl = x.decl ?? 0, trkT = ac.track ?? b5.trk;
    const mtrk = trkT != null ? Math.round(((trkT - decl) % 360 + 360) % 360) : null;
    const mh = b6.mhdg != null ? Math.round((b6.mhdg % 360 + 360) % 360) : null;
    const dr = mtrk != null && mh != null ? Math.round(norm180(mtrk - mh)) : null;
    const roll = b5.roll;
    const l4 = `MH ${mh != null ? pad3(mh) : '---'}  TRK ${mtrk != null ? pad3(mtrk) : '---'}  DR ${dr == null ? '---' : dr ? (dr < 0 ? 'L' : 'R') + Math.abs(dr) : '0'}  ROLL ${roll == null ? '---' : Math.abs(roll) < 0.5 ? '0' : (roll < 0 ? 'L' : 'R') + Math.round(Math.abs(roll))}`;
    // wind, its head / tail and cross components on the track, the temperature
    const wd = x.wdir ?? ac.best_wind_dir, ws = x.wspd ?? ac.best_wind_spd, t = x.temp ?? ac.best_temp;
    let l5 = wd != null && ws != null ? `W ${pad3(Math.round(wd) % 360 || 360)}/${Math.round(ws)}` : 'W ---';
    if (wd != null && ws != null && trkT != null) {
      const rel = (wd - trkT) * Math.PI / 180, hw = Math.round(ws * Math.cos(rel)), xw = Math.round(ws * Math.sin(rel));
      l5 += `  ${hw >= 0 ? 'HW' : 'TW'} ${Math.abs(hw)}  XW ${Math.abs(xw)}${xw > 0 ? 'R' : xw < 0 ? 'L' : ''}`;
    }
    l5 += `  SAT ${t != null ? sgn(Math.round(t)) : '---'}`;
    // distance and bearing from the airport, NACp, the squawk
    let l6 = '';
    if (o.apt && ac.lat != null && ac.lon != null) {
      const dy = (ac.lat - o.apt[0]) * 60, dx = (ac.lon - o.apt[1]) * 60 * Math.cos(ac.lat * Math.PI / 180);
      l6 = `${Math.hypot(dx, dy).toFixed(1)} NM ${pad3(Math.round((Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360) % 360)}° ${o.apt[2]}  `;
    }
    l6 += `NACp ${x.nacp ?? '-'}${x.sq ? '  SQ ' + x.sq : ''}`;
    return [l1, l2, l3, l4, l5, l6];
  }

  // The hover on one map: opts = { active() — the ATC style and the Hover button
  // on; targets() — [[key, lat, lon], ...] of the aircraft shown; rects() — the
  // label boxes of the last draw; redraw() }.  Returns { key(), data() }: the
  // aircraft under the mouse (null = none) and its latest hover reply.
  function hover(map, opts) {
    const el = map.getContainer();
    let key = null, data = null, timer = null, raf = 0, mx = 0, my = 0;
    const poll = k => fetch(`/api/live/ac/${encodeURIComponent(k)}`)
      .then(r => r.ok ? r.json() : null).catch(() => null)
      .then(d => { if (k === key) { data = d; opts.redraw(); } });
    function set(k) {
      if (k === key) return;
      key = k; data = null;
      clearInterval(timer); timer = null;
      if (k) {
        poll(k);
        timer = setInterval(() => { if (key && !document.hidden) poll(key); }, HOVER_POLL_MS);
      }
      opts.redraw();
    }
    function pick() {
      raf = 0;
      if (!opts.active()) { set(null); return; }
      // the open label keeps open while the mouse is on it
      const R = key && (opts.rects() || {})[key];
      if (R && mx >= R.x - 4 && mx <= R.x + R.w + 4 && my >= R.y - 3 && my <= R.y + R.h + 2) return;
      let best = null, bd = HOVER_HIT_PX;
      for (const [k, lat, lon] of opts.targets()) {
        const p = map.latLngToContainerPoint([lat, lon]), d = Math.hypot(p.x - mx, p.y - my);
        if (d <= bd) { bd = d; best = k; }
      }
      set(best);
    }
    el.addEventListener('mousemove', e => {
      const r = el.getBoundingClientRect();
      mx = e.clientX - r.left; my = e.clientY - r.top;
      if (!raf) raf = requestAnimationFrame(pick);
    });
    el.addEventListener('mouseleave', () => set(null));
    return { key: () => key, data: () => data, clear: () => set(null) };
  }

  // Lines as label obstacles (from 30 Oct 2026; general from 31 Oct 2026, the phone's
  // approach map): small boxes every 6 px along the LineString / MultiLineString
  // features, in container pixels, inside the map
  function lineObstacles(map, features, W, H) {
    const out = [];
    for (const f of features || []) {
      if (!f || !f.geometry) continue;
      const cs = f.geometry.type === 'LineString' ? [f.geometry.coordinates]
               : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [];
      for (const line of cs) for (let i = 1; i < line.length; i++) {
        const a = map.latLngToContainerPoint([line[i - 1][1], line[i - 1][0]]),
              b = map.latLngToContainerPoint([line[i][1], line[i][0]]);
        if (Math.max(a.x, b.x) < -10 || Math.min(a.x, b.x) > W + 10 ||
            Math.max(a.y, b.y) < -10 || Math.min(a.y, b.y) > H + 10) continue;
        const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 6));
        for (let j = 0; j <= n; j++) {
          const x = a.x + (b.x - a.x) * j / n, y = a.y + (b.y - a.y) * j / n;
          if (x >= -4 && y >= -4 && x <= W + 4 && y <= H + 4) out.push({ x: x - 3, y: y - 3, w: 6, h: 6 });
        }
      }
    }
    return out;
  }

  // The ATC map lines (coastline, airport, EFHK ILS / RNP finals), loaded at the
  // first show, drawn on a canvas in their own pane; show(on) adds or removes
  // them in the current theme's colours; obstacles(W, H) gives
  // the finals as label obstacles while they are shown
  function mapLines(map) {
    ensurePanes(map);
    const renderer = L.canvas({ pane: 'atcMapPane', padding: 0.3 });
    let layer = null, geo = null, seq = 0;
    async function show(on) {
      const my = ++seq;
      if (on && !geo) {
        const [ils, apt, coast] = await Promise.all(['efhk_ils', 'efhk_apt', 'efhk_coast']
          .map(n => fetch(`/overlays/${n}.geojson`).then(r => r.ok ? r.json() : null).catch(() => null)));
        geo = { ils, apt, coast };
      }
      if (my !== seq) return;                          // a newer call decides
      if (layer) { layer.remove(); layer = null; }
      if (!on) return;
      const P = pal(), grp = L.layerGroup();
      const opt = st => ({ renderer, interactive: false, style: st });
      if (geo.coast) L.geoJSON(geo.coast, opt({ color: P.coast, weight: 1, opacity: 0.9, fill: false })).addTo(grp);
      if (geo.apt)   L.geoJSON(geo.apt,   opt({ color: P.apt,   weight: 1, opacity: 0.9, fill: false })).addTo(grp);
      if (geo.ils) {
        const efhk = { type: 'FeatureCollection', features: (geo.ils.features || []).filter(f => f.properties && f.properties.airport === 'EFHK') };
        L.geoJSON(efhk, opt(f => f.properties?.approach_type === 'RNP'
          ? { color: P.rnp, weight: 1, opacity: 0.9, dashArray: '8 5', fill: false }
          : { color: P.ils, weight: 1, opacity: 0.9, dashArray: '4 4', fill: false })).addTo(grp);
      }
      layer = grp.addTo(map);
    }
    // The EFHK finals as small boxes every 6 px along them (in container pixels,
    // inside the map), for the labels to keep clear of the approach lines
    // (from 30 Oct 2026): the leading aircraft on a final otherwise put its label
    // straight ahead, over the line, when nothing else was in the way.
    function obstacles(W, H) {
      if (!layer || !geo || !geo.ils) return [];
      return lineObstacles(map, (geo.ils.features || []).filter(f => f.properties && f.properties.airport === 'EFHK'), W, H);
    }
    return { show, obstacles };
  }

  // Legend: the three symbol colours and the research notice
  // o.noSel: without the selected colour (the Windshear map, from 30 Oct 2026 evening)
  function legendHtml(o) {
    const P = pal();
    return `<span class="legend-sq" style="border-color:${P.low}"></span> below ${LOW_FT.toLocaleString('en-US')} ft
      <span class="legend-sq" style="border-color:${P.high}"></span> above
      ${o && o.noSel ? '' : `<span class="legend-sq" style="border-color:${P.sel}"></span> selected`}
      <span class="legend-note" title="A radar-display look for research and comparison: positions as received by this station (ADS-B / MLAT), not certified surveillance data">Research display — not for air traffic control</span>`;
  }

  // Boxes of the visible page elements over the map (control bars, panels,
  // legend) in map-container pixels, for the labels to keep clear of
  function domObstacles(map, selectors) {
    const mr = map.getContainer().getBoundingClientRect(), out = [];
    for (const el of document.querySelectorAll(selectors)) {
      if (el.hidden || !el.offsetParent) continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.height) out.push({ x: r.left - mr.left - 4, y: r.top - mr.top - 4, w: r.width + 8, h: r.height + 8 });
    }
    return out;
  }

  // Monochrome symbol colour: below LOW_FT light, above grey
  const symColor = ac => ac.altitude != null && ac.altitude < LOW_FT ? pal().low : pal().high;

  return { pal, isLight, LOW_FT, HIST_STEPS, VEC_STEPS, RING_STEPS, MAX_TRAIL, lsInt, lsSet,
           addTrail, vecEnd, canvasLayer, drawPlots, drawVector, drawRings, labelLines, drawLabels, lineObstacles,
           extLines, hover, mapLines, legendHtml, symColor, domObstacles };
})();
