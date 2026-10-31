/**
 * wx_layer.js — MEPS surface weather drawn on a Leaflet map (shared by the
 * Weather page, weather.js, and the Live Map overlay, live_map.js).
 *
 * A frame (from /api/weather/frames) holds integer lists on a regular grid in
 * the MEPS Lambert projection: p (hPa − 1000) × 10, r / s rain / snow of the
 * hour (mm × 100), c / l / m / h total / low / medium / high cloud %, f fog %,
 * b cloud base (m), u / v 10 m wind towards east / north and g 10 m gust
 * (kt).  WxLayer.create(map, opts) puts a canvas into its own pane (under
 * the aircraft on the Live Map) and draws:
 *   clouds   — the chosen cloud fields as grey (fog: yellow), denser with
 *              more cover (cells drawn opaque on an offscreen canvas, then
 *              the cover turned into transparency: no seams between cells)
 *   gusts    — shading of the 10 m gust from 25 kt (Beaufort 6) upwards
 *   rain     — radar-like colours by intensity, snow (≥ half of it) violet
 *   wind     — barbs of the 10 m wind, thinned to about 50 px apart (or of
 *              any u / v frame on the same projection: the Live Map's MEPS
 *              winds at a flight level, /api/meps/winds; opts.barb = [dark,
 *              light] colours, barbAt(point) = the barb under the cursor)
 *   pressure — isobars every 4 hPa with labels, highs H and lows L
 * The overall opacity is the canvas opacity (setOpacity).
 *
 * setOverlay(radar, grid) adds the FMI radar (sparse rain rs + coverage runs
 * cov on its own grid, the Live Map): its rain is drawn over the model's, the
 * model's rain is cut away inside the radar coverage, and a thin line marks
 * the edge of the coverage (outside it the model's rain, if any, is shown).
 * With opts modelOutline (the Live Map's Both, from 2026-10-26) the model's
 * rain inside the coverage is drawn as outlines over the radar's colours —
 * thin from 0.1 mm/h, thick from 1 mm/h — so the forecast can be compared
 * with what the radar observes without mixing the two.
 *
 * setFine(frame, grid) (from 2026-10-31) adds a detail frame on a finer grid
 * of the same projection — the 2.5 km MEPS box around the receiver: the
 * filled fields (clouds, gust, rain / snow) of the main frame are cut away
 * inside the box and drawn from the detail frame there, a faint dotted line
 * marks its edge, and the read-out (valuesAt) takes its values inside it.
 * Isobars and barbs stay those of the main frame.
 */
'use strict';

const WxLayer = (() => {
  // ── MEPS Lambert projection (as collector/meps.py) ─────────────────────
  const LCC = (() => {
    const R = 6371000, lat1 = 63.3 * Math.PI / 180, lon0 = 15;
    const n = Math.sin(lat1);
    const F = Math.cos(lat1) * Math.pow(Math.tan(Math.PI / 4 + lat1 / 2), n) / n;
    const rho0 = R * F / Math.pow(Math.tan(Math.PI / 4 + lat1 / 2), n);
    return {
      xy(lat, lon) {
        const rho = R * F / Math.pow(Math.tan(Math.PI / 4 + lat * Math.PI / 360), n);
        const th = n * (lon - lon0) * Math.PI / 180;
        return [rho * Math.sin(th), rho0 - rho * Math.cos(th)];
      },
      latlon(x, y) {
        const rho = Math.sign(n) * Math.hypot(x, rho0 - y);
        const th = Math.atan2(x, rho0 - y);
        return [(2 * Math.atan(Math.pow(R * F / rho, 1 / n)) - Math.PI / 2) * 180 / Math.PI, lon0 + th / n * 180 / Math.PI];
      },
    };
  })();

  // ── ETRS-TM35FIN (EPSG:3067, the FMI radar grid): transverse Mercator,
  //    GRS80, 27° E, k0 0.9996, false easting 500 km (forward xy from 2026-10-30,
  //    for the phone's radar read-out) ─────────────────────────────────────
  const TM35 = {
    xy(latDeg, lonDeg) {
      const a = 6378137, f = 1 / 298.257222101, e2 = f * (2 - f), ep2 = e2 / (1 - e2), k0 = 0.9996, lon0 = 27 * Math.PI / 180;
      const p = latDeg * Math.PI / 180, l = lonDeg * Math.PI / 180, sp = Math.sin(p), cp = Math.cos(p), tp = Math.tan(p);
      const N = a / Math.sqrt(1 - e2 * sp * sp), T = tp * tp, C = ep2 * cp * cp, A = (l - lon0) * cp;
      const M = a * ((1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256) * p - (3 * e2 / 8 + 3 * e2 * e2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * p)
              + (15 * e2 * e2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * p) - (35 * e2 ** 3 / 3072) * Math.sin(6 * p));
      const E = 500000 + k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120);
      const Nn = k0 * (M + N * tp * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
      return [E, Nn];
    },
    latlon(E, N) {
      const a = 6378137, f = 1 / 298.257222101, e2 = f * (2 - f), ep2 = e2 / (1 - e2), k0 = 0.9996, lon0 = 27 * Math.PI / 180;
      const mu = N / k0 / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256));
      const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
      const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
               + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
      const sp = Math.sin(p1), cp = Math.cos(p1), tp = Math.tan(p1);
      const C1 = ep2 * cp * cp, T1 = tp * tp, N1 = a / Math.sqrt(1 - e2 * sp * sp), R1 = a * (1 - e2) / Math.pow(1 - e2 * sp * sp, 1.5);
      const D = (E - 500000) / (N1 * k0);
      const lat = p1 - (N1 * tp / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24
                + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
      const lon = lon0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / cp;
      return [lat * 180 / Math.PI, lon * 180 / Math.PI];
    },
  };

  // ── Colours ────────────────────────────────────────────────────────────
  const RAIN_T = [0.1, 0.5, 1, 2, 5, 10];                                  // mm / h
  const RAIN_C = ['#7dd3fc', '#3b82f6', '#22c55e', '#facc15', '#ef4444', '#ec4899'];
  const SNOW_C = ['#ede9fe', '#ddd6fe', '#c4b5fd', '#a78bfa', '#8b5cf6', '#d946ef'];
  const rainClass = mm => { let k = -1; for (let i = 0; i < RAIN_T.length; i++) if (mm >= RAIN_T[i]) k = i; return k; };
  // 10 m gust (kt): Beaufort 6 / gale 8 / strong gale 9 / storm 10 / violent storm 11 / hurricane 12
  const GUST_T = [25, 34, 41, 48, 56, 64];
  const GUST_C = ['#fde68a', '#fdba74', '#f97316', '#dc2626', '#9d174d', '#581c87'];
  const gustClass = kt => { let k = -1; for (let i = 0; i < GUST_T.length; i++) if (kt >= GUST_T[i]) k = i; return k; };
  const BARB_PX = 50;                                                      // barb spacing on screen
  // meteorological wind barb at (cx, cy), staff pointing to where the wind comes from
  function barb(g, cx, cy, dir, spd) {
    const s = Math.round(spd / 5) * 5;
    const r = dir * Math.PI / 180, ux = Math.sin(r), uy = -Math.cos(r);
    const L = 15, fx = -uy, fy = ux;
    const tx = cx + ux * L, ty = cy + uy * L;
    if (s < 5) { g.beginPath(); g.arc(cx, cy, 2.2, 0, 2 * Math.PI); g.stroke(); return; }   // calm: circle
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(tx, ty); g.stroke();
    let rem = s, pos = 0;
    while (rem >= 50) {
      const ax = tx - ux * pos, ay = ty - uy * pos;
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax + fx * 7 - ux * 2, ay + fy * 7 - uy * 2);
      g.lineTo(ax - ux * 4, ay - uy * 4); g.closePath(); g.fill();
      pos += 5; rem -= 50;
    }
    while (rem >= 10) {
      const ax = tx - ux * pos, ay = ty - uy * pos;
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax + fx * 7 + ux * 2, ay + fy * 7 + uy * 2); g.stroke();
      pos += 3.5; rem -= 10;
    }
    if (rem >= 5) {
      const ax = tx - ux * (pos || 3), ay = ty - uy * (pos || 3);
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax + fx * 3.5 + ux, ay + fy * 3.5 + uy); g.stroke();
    }
  }
  const windDir = (u, v) => (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
  const isLight = () => document.documentElement.dataset.theme === 'light';
  const theme = () => isLight()
    ? { iso: 'rgba(30,41,59,0.85)', isoLbl: '#1e293b', halo: 'rgba(241,245,249,0.9)', hi: '#1d4ed8', lo: '#b91c1c',
        cloud: [71, 85, 105], fog: [180, 120, 0], radarEdge: 'rgba(15,118,110,0.75)', barb: '#0f172a', fineEdge: 'rgba(30,41,59,0.45)',
        mrain: '#1e293b', mrainHalo: 'rgba(255,255,255,0.75)' }
    : { iso: 'rgba(226,232,240,0.8)', isoLbl: '#e2e8f0', halo: 'rgba(15,25,35,0.85)', hi: '#60a5fa', lo: '#f87171',
        cloud: [226, 232, 240], fog: [250, 204, 21], radarEdge: 'rgba(45,212,191,0.7)', barb: '#f8fafc', fineEdge: 'rgba(226,232,240,0.4)',
        mrain: '#f8fafc', mrainHalo: 'rgba(15,25,35,0.7)' };
  const CLOUD_NAME = { c: 'cloud cover', l: 'low cloud', m: 'medium cloud', h: 'high cloud', f: 'fog' };

  function smooth(v, nx, ny, r) {
    if (r <= 0) return v;
    const out = new Array(v.length);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let s = 0, n = 0;
      for (let b = Math.max(0, j - r); b <= Math.min(ny - 1, j + r); b++)
        for (let a = Math.max(0, i - r); a <= Math.min(nx - 1, i + r); a++) {
          const x = v[b * nx + a]; if (x != null) { s += x; n++; }
        }
      out[j * nx + i] = n ? s / n : null;
    }
    return out;
  }
  // lat/lon of the grid points and cell corners, computed when first needed
  function buildGeo(g) {
    const [x0, dx, nx] = g.x, [y0, dy, ny] = g.y;
    const inv = g.proj === 'tm35fin' ? TM35.latlon : LCC.latlon;
    const pts = new Array(nx * ny), cor = new Array((nx + 1) * (ny + 1));
    return {
      nx, ny,
      pt(k) { return pts[k] || (pts[k] = inv(x0 + (k % nx) * dx, y0 + Math.floor(k / nx) * dy)); },
      cor(k) { return cor[k] || (cor[k] = inv(x0 + (k % (nx + 1) - 0.5) * dx, y0 + (Math.floor(k / (nx + 1)) - 0.5) * dy)); },
    };
  }

  // radar frame: sparse rain → full list; coverage runs → mask and outline
  // segments [i0, j0, i1, j1] in corner indices (merged along rows / columns)
  function prepRadar(f, g) {
    const nx = g.x[2], ny = g.y[2];
    if (f.rs && !f.r) {
      const r = new Array(nx * ny).fill(null);
      for (let q = 0; q < f.rs.length; q += 2) r[f.rs[q]] = f.rs[q + 1];
      f.r = r;
    }
    if (f.cov && !f.edges) {
      const m = new Uint8Array(nx * ny);
      for (let q = 0; q < f.cov.length; q += 3) m.fill(1, f.cov[q] * nx + f.cov[q + 1], f.cov[q] * nx + f.cov[q + 2] + 1);
      const at = (i, j) => (i >= 0 && j >= 0 && i < nx && j < ny) ? m[j * nx + i] : 0;
      const e = [];
      for (let j = 0; j <= ny; j++) {           // horizontal edges (between rows j-1 and j)
        let s0 = -1;
        for (let i = 0; i <= nx; i++) {
          const d = i < nx && at(i, j - 1) !== at(i, j);
          if (d && s0 < 0) s0 = i;
          if (!d && s0 >= 0) { e.push([s0, j, i, j]); s0 = -1; }
        }
      }
      for (let i = 0; i <= nx; i++) {           // vertical edges (between columns i-1 and i)
        let s0 = -1;
        for (let j = 0; j <= ny; j++) {
          const d = j < ny && at(i - 1, j) !== at(i, j);
          if (d && s0 < 0) s0 = j;
          if (!d && s0 >= 0) { e.push([i, s0, i, j]); s0 = -1; }
        }
      }
      f.edges = e;
    }
    return f;
  }
  // a long straight run of a projected grid is not straight on the map: split it
  const SPLIT = 24;

  // ── The layer ──────────────────────────────────────────────────────────
  // opts: pane (name, created with zIndex), zIndex, cloudMax (alpha at 100 %),
  //       rainAlpha, isoWidth (isobar line scale)
  function create(map, opts = {}) {
    const paneName = opts.pane || 'wxPane';
    if (!map.getPane(paneName)) {
      const p = map.createPane(paneName);
      p.style.zIndex = opts.zIndex || 350;
      p.style.pointerEvents = 'none';
    }
    const canvas = L.DomUtil.create('canvas', 'wx-canvas');
    canvas.style.position = 'absolute'; canvas.style.left = '0'; canvas.style.top = '0';
    canvas.style.pointerEvents = 'none';
    map.getPane(paneName).appendChild(canvas);
    const off = document.createElement('canvas');
    let frame = null, grid = null, geo = null, gridKey = '';
    let ov = null, ovGrid = null, ovGeo = null, ovKey = '';     // the radar (setOverlay)
    let fine = null, fineGrid = null, fineGeo = null, fineKey = '';  // the 2.5 km box (setFine)
    let o = { rain: true, clouds: [], pres: true, wind: false, gust: false };
    let drawn = [];            // barbs drawn last: [x, y, dir, spd, grid index] (barbAt)

    function place() {
      const size = map.getSize(), dpr = window.devicePixelRatio || 1;
      L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
      canvas.width = Math.round(size.x * dpr); canvas.height = Math.round(size.y * dpr);
      canvas.style.width = size.x + 'px'; canvas.style.height = size.y + 'px';
      off.width = canvas.width; off.height = canvas.height;
      draw();
    }
    map.on('zoomstart', () => { canvas.style.visibility = 'hidden'; });
    map.on('zoomend moveend resize', () => { canvas.style.visibility = ''; place(); });

    function setGrid(g) {
      const k = JSON.stringify(g);
      if (k !== gridKey) { gridKey = k; grid = g; geo = g ? buildGeo(g) : null; }
    }

    function draw() {
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const hasF = frame && geo, hasO = ov && ovGeo;
      drawn = [];
      if (!hasF && !hasO) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const T = theme();
      const P = ll => map.latLngToContainerPoint(ll);
      const g2 = off.getContext('2d');
      // cell quads of a grid, corners projected when a cell needs them
      const quads = gg => {
        const nx = gg.nx, corP = new Array((gg.nx + 1) * (gg.ny + 1));
        const C = k => corP[k] || (corP[k] = P(gg.cor(k)));
        const fn = (i, j, col, i1 = i) => {          // cells i … i1 of row j as one quad
          const a = C(j * (nx + 1) + i), b = C(j * (nx + 1) + i1 + 1), c = C((j + 1) * (nx + 1) + i1 + 1), d = C((j + 1) * (nx + 1) + i);
          if (col) g2.fillStyle = g2.strokeStyle = col;
          g2.beginPath(); g2.moveTo(a.x, a.y); g2.lineTo(b.x, b.y); g2.lineTo(c.x, c.y); g2.lineTo(d.x, d.y); g2.closePath();
          g2.fill(); g2.stroke();
        };
        fn.C = C;
        return fn;
      };
      const quad = hasF ? quads(geo) : null;
      const nx = hasF ? geo.nx : 0, ny = hasF ? geo.ny : 0;
      const layer = alpha => {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = alpha; ctx.drawImage(off, 0, 0); ctx.globalAlpha = 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      };
      const begin = () => {
        g2.setTransform(1, 0, 0, 1, 0, 0); g2.clearRect(0, 0, off.width, off.height);
        g2.setTransform(dpr, 0, 0, dpr, 0, 0); g2.lineWidth = 0.8;
      };
      const f = hasF ? frame : {};
      // the 2.5 km box: its outline (corners along the edge, split for the projection),
      // cut out of a layer and filled from the detail frame
      const hasFine = hasF && fine && fineGeo && !grid.proj && !fineGrid.proj;
      const fq = hasFine ? quads(fineGeo) : null, fnx = hasFine ? fineGeo.nx : 0, fny = hasFine ? fineGeo.ny : 0;
      const fineRing = () => {
        const pts = [], n1 = fnx + 1, E = 25;
        for (let i = 0; i < fnx; i += E) pts.push(fq.C(i));
        for (let j = 0; j < fny; j += E) pts.push(fq.C(j * n1 + fnx));
        for (let i = fnx; i > 0; i -= E) pts.push(fq.C(fny * n1 + i));
        for (let j = fny; j > 0; j -= E) pts.push(fq.C(j * n1));
        return pts;
      };
      const fineCut = () => {                        // clear the box in the layer being drawn
        if (!hasFine) return;
        const pts = fineRing();
        g2.save(); g2.globalCompositeOperation = 'destination-out'; g2.fillStyle = '#000';
        g2.beginPath(); pts.forEach((q, k) => k ? g2.lineTo(q.x, q.y) : g2.moveTo(q.x, q.y)); g2.closePath(); g2.fill();
        g2.restore();
      };
      // the detail frame's cells: colour(frame, k) → css colour or null
      const fineCells = colour => {
        if (!hasFine) return false;
        let any = false;
        for (let j = 0; j < fny; j++) for (let i = 0; i < fnx; i++) {
          const col = colour(fine, j * fnx + i);
          if (col) { fq(i, j, col); any = true; }
        }
        return any;
      };
      // clouds / fog: grey value = cover, then red → alpha in the field's colour
      for (const key of (hasF ? o.clouds : [])) {
        const v = f[key];
        if (!v) continue;
        begin();
        let any = false;
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
          const c = v[j * nx + i];
          if (c == null || c < 15) continue;
          const g = Math.round(255 * c / 100);
          quad(i, j, `rgb(${g},${g},${g})`); any = true;
        }
        if (hasFine) {
          fineCut();
          if (fineCells((fr, k) => { const c = fr[key] && fr[key][k]; if (c == null || c < 15) return null;
                                      const g = Math.round(255 * c / 100); return `rgb(${g},${g},${g})`; })) any = true;
        }
        if (!any) continue;
        const img = g2.getImageData(0, 0, off.width, off.height), px = img.data;
        const [cr, cg, cb] = key === 'f' ? T.fog : T.cloud;
        const k = (opts.cloudMax || 0.38) * (key === 'f' ? 1.3 : 1);
        for (let q = 0; q < px.length; q += 4) {
          const a = px[q + 3] ? px[q] * k * px[q + 3] / 255 : 0;
          px[q] = cr; px[q + 1] = cg; px[q + 2] = cb; px[q + 3] = a;
        }
        g2.putImageData(img, 0, 0);
        layer(1);
      }
      // 10 m gust: shading from 25 kt, under the rain
      if (hasF && o.gust && f.g) {
        begin();
        let any = false;
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
          const v = f.g[j * nx + i];
          if (v == null) continue;
          const cl = gustClass(v);
          if (cl >= 0) { quad(i, j, GUST_C[cl]); any = true; }
        }
        if (hasFine) {
          fineCut();
          if (fineCells((fr, k) => { const v = fr.g && fr.g[k]; const cl = v == null ? -1 : gustClass(v); return cl >= 0 ? GUST_C[cl] : null; })) any = true;
        }
        if (any) layer(o.gustAlpha != null ? o.gustAlpha : (opts.gustAlpha || (isLight() ? 0.55 : 0.72)));   // o.gustAlpha: the Live Map opacity slider
      }
      // rain / snow: the model's, cut away inside the radar coverage, then the radar's;
      // o.rainAlpha / o.radarAlpha (the phone's opacity options, from 2026-10-30): each its own opacity,
      // otherwise the two together at opts.rainAlpha (the Live Map, the Weather page)
      const oq = hasO ? quads(ovGeo) : null;
      const rainA = opts.rainAlpha || 0.72, sepA = o.rainAlpha != null || o.radarAlpha != null;
      if (o.rain && (f.r || (hasO && ov.r))) {
        begin();
        let any = false;
        if (f.r) {
          for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
            const k = j * nx + i, r = f.r[k];
            if (r == null || r < 10) continue;
            const cl = rainClass(r / 100);
            if (cl < 0) continue;
            const snow = f.s && f.s[k] != null && f.s[k] >= 0.5 * r;
            quad(i, j, (snow ? SNOW_C : RAIN_C)[cl]); any = true;
          }
          if (hasFine && fine.r) {
            fineCut();
            if (fineCells((fr, k) => {
              const r = fr.r[k];
              if (r == null || r < 10) return null;
              const cl = rainClass(r / 100);
              if (cl < 0) return null;
              return ((fr.s && fr.s[k] != null && fr.s[k] >= 0.5 * r) ? SNOW_C : RAIN_C)[cl];
            })) any = true;
          }
          if (any && hasO && ov.cov) {
            g2.globalCompositeOperation = 'destination-out';
            g2.fillStyle = g2.strokeStyle = '#000';
            for (let q = 0; q < ov.cov.length; q += 3)
              for (let i = ov.cov[q + 1]; i <= ov.cov[q + 2]; i += SPLIT) oq(i, ov.cov[q], null, Math.min(i + SPLIT - 1, ov.cov[q + 2]));
            g2.globalCompositeOperation = 'source-over';
          }
          if (sepA && any) { layer(o.rainAlpha != null ? o.rainAlpha : rainA); begin(); any = false; }
        }
        if (hasO && ov.r) {
          const onx = ovGeo.nx;
          for (let q = 0; q < (ov.rs || []).length; q += 2) {
            const k = ov.rs[q], cl = rainClass(ov.rs[q + 1] / 100);
            if (cl >= 0) { oq(k % onx, Math.floor(k / onx), RAIN_C[cl]); any = true; }
          }
        }
        if (any) layer(sepA && hasO ? (o.radarAlpha != null ? o.radarAlpha : rainA) : sepA ? (o.rainAlpha != null ? o.rainAlpha : rainA) : rainA);
      }
      // the model's rain inside the radar coverage as outlines (clipped to the coverage)
      if (hasF && hasO && o.rain && o.modelOutline && f.r && ov.cov) {
        ctx.save();
        ctx.beginPath();
        for (let q = 0; q < ov.cov.length; q += 3) {
          const j = ov.cov[q], onx1 = ovGeo.nx + 1;
          for (let i = ov.cov[q + 1]; i <= ov.cov[q + 2]; i += SPLIT) {
            const i1 = Math.min(i + SPLIT - 1, ov.cov[q + 2]);
            const a = oq.C(j * onx1 + i), b = oq.C(j * onx1 + i1 + 1), c = oq.C((j + 1) * onx1 + i1 + 1), d = oq.C((j + 1) * onx1 + i);
            ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath();
          }
        }
        ctx.clip();
        const C = quad.C, nx1 = nx + 1;
        for (const [cl0, w] of [[0, 1], [2, 2]]) {            // ≥ 0.1 mm/h thin, ≥ 1 mm/h thick
          const m = (i, j) => {
            if (i < 0 || j < 0 || i >= nx || j >= ny) return false;
            const r = f.r[j * nx + i];
            return r != null && rainClass(r / 100) >= cl0;
          };
          ctx.beginPath();
          let any = false;
          for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
            if (i < nx && m(i, j - 1) !== m(i, j)) {          // edge along the top of cell (i, j)
              const a = C(j * nx1 + i), b = C(j * nx1 + i + 1);
              ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); any = true;
            }
            if (j < ny && m(i - 1, j) !== m(i, j)) {          // edge along the left of cell (i, j)
              const a = C(j * nx1 + i), b = C((j + 1) * nx1 + i);
              ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); any = true;
            }
          }
          if (!any) continue;
          ctx.lineCap = 'round';
          ctx.strokeStyle = T.mrainHalo; ctx.lineWidth = w + 2; ctx.stroke();
          ctx.strokeStyle = T.mrain; ctx.lineWidth = w; ctx.stroke();
        }
        ctx.restore();
      }
      // the edge of the radar coverage
      if (hasO && ov.edges && o.outline !== false) {
        ctx.beginPath();
        for (const [i0, j0, i1, j1] of ov.edges) {
          const n = Math.max(1, Math.ceil(Math.max(i1 - i0, j1 - j0) / SPLIT));
          for (let s = 0; s <= n; s++) {
            const i = Math.round(i0 + (i1 - i0) * s / n), j = Math.round(j0 + (j1 - j0) * s / n);
            const p = oq.C(j * (ovGeo.nx + 1) + i);
            if (s) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
          }
        }
        ctx.strokeStyle = T.radarEdge; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
        ctx.stroke(); ctx.setLineDash([]);
      }
      // the edge of the 2.5 km box: a faint dotted line
      if (hasFine && o.fineEdge !== false) {
        const pts = fineRing();
        ctx.beginPath(); pts.forEach((q, k) => k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)); ctx.closePath();
        ctx.strokeStyle = T.fineEdge; ctx.lineWidth = 1; ctx.setLineDash([1.5, 3]); ctx.stroke(); ctx.setLineDash([]);
      }
      if (hasF && o.wind && f.u && f.v) drawBarbs(ctx, f, T, P);
      if (hasF && o.pres && f.p) drawPressure(ctx, f, T, P);
    }

    // barbs of the 10 m wind on every n-th grid point (about BARB_PX apart on
    // the screen; the same points while panning), only inside the view
    function drawBarbs(ctx, f, T, P) {
      const { nx, ny } = geo;
      const c = map.getSize(), mid = Math.floor(ny / 2) * nx + Math.floor(nx / 2);
      const a = P(geo.pt(mid)), b = P(geo.pt(mid + 1));
      const cell = Math.max(0.5, Math.hypot(b.x - a.x, b.y - a.y));
      const n = Math.max(1, Math.ceil(BARB_PX / cell));
      ctx.lineCap = 'round';
      const line = [];
      for (let j = 0; j < ny; j += n) for (let i = 0; i < nx; i += n) {
        const k = j * nx + i, u = f.u[k], v = f.v[k];
        if (u == null || v == null) continue;
        const q = P(geo.pt(k));
        if (q.x < -20 || q.y < -20 || q.x > c.x + 20 || q.y > c.y + 20) continue;
        line.push([q.x, q.y, windDir(u, v), Math.hypot(u, v), k]);
      }
      drawn = line;
      const bc = opts.barb ? opts.barb[isLight() ? 1 : 0] : T.barb;
      for (const pass of ['halo', 'line']) {
        ctx.strokeStyle = ctx.fillStyle = pass === 'halo' ? T.halo : bc;
        ctx.lineWidth = pass === 'halo' ? 3.2 : 1.3;
        for (const [x, y, d, sp] of line) barb(ctx, x, y, d, sp);
      }
    }

    function drawPressure(ctx, f, T, P) {
      const { nx, ny } = geo;
      const km = grid.x[1] / 1000;
      if (!f._p) {                               // smoothed fields, once per frame
        f._p = smooth(f.p.map(v => v == null ? null : 1000 + v / 10), nx, ny, Math.max(1, Math.round(30 / km)));
        f._ps = smooth(f._p, nx, ny, Math.max(1, Math.round(60 / km)));
      }
      const p = f._p, ps = f._ps;
      const pts = new Array(nx * ny);
      for (let k = 0; k < nx * ny; k++) pts[k] = P(geo.pt(k));
      let lo = Infinity, hi = -Infinity;
      for (const v of p) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      if (!isFinite(lo)) return;
      const levels = [];
      for (let L = Math.ceil(lo / 4) * 4; L <= hi; L += 4) levels.push(L);
      const W = canvas.width / (window.devicePixelRatio || 1), H = canvas.height / (window.devicePixelRatio || 1);
      const labels = [];
      const ws = opts.isoWidth || 1;
      ctx.strokeStyle = T.iso;
      for (const L of levels) {
        ctx.lineWidth = (L === 1000 ? 1.9 : 1.1) * ws;
        ctx.beginPath();
        const mids = [];
        for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
          const ia = j * nx + i, ib = ia + 1, ic = ia + nx + 1, id = ia + nx;
          const va = p[ia], vb = p[ib], vc = p[ic], vd = p[id];
          if (va == null || vb == null || vc == null || vd == null) continue;
          const cut = [];
          const edge = (v1, v2, k1, k2) => {
            if ((v1 - L) * (v2 - L) < 0) {
              const t = (L - v1) / (v2 - v1), A = pts[k1], B = pts[k2];
              cut.push([A.x + (B.x - A.x) * t, A.y + (B.y - A.y) * t]);
            }
          };
          edge(va, vb, ia, ib); edge(vb, vc, ib, ic); edge(vc, vd, ic, id); edge(vd, va, id, ia);
          if (cut.length === 2) {
            ctx.moveTo(cut[0][0], cut[0][1]); ctx.lineTo(cut[1][0], cut[1][1]);
            mids.push([(cut[0][0] + cut[1][0]) / 2, (cut[0][1] + cut[1][1]) / 2]);
          } else if (cut.length === 4) {
            const centre = (va + vb + vc + vd) / 4;
            const pairs = (centre - L) * (va - L) > 0 ? [[0, 3], [1, 2]] : [[0, 1], [2, 3]];
            for (const [m, n] of pairs) { ctx.moveTo(cut[m][0], cut[m][1]); ctx.lineTo(cut[n][0], cut[n][1]); }
          }
        }
        ctx.stroke();
        let placed = 0;
        for (let q = 0; q < mids.length && placed < 4; q += 7) {
          const [x, y] = mids[q];
          if (x < 30 || y < 20 || x > W - 30 || y > H - 20) continue;
          if (labels.some(l => Math.hypot(l[0] - x, l[1] - y) < (l[2] === L ? 260 : 55))) continue;
          labels.push([x, y, L]); placed++;
        }
      }
      ctx.font = 'bold 10px "Courier New", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const [x, y, L] of labels) {
        ctx.lineWidth = 3; ctx.strokeStyle = T.halo; ctx.strokeText(String(L), x, y);
        ctx.fillStyle = T.isoLbl; ctx.fillText(String(L), x, y);
      }
      // highs and lows on a smoother field: extreme within ~250 km, at least 1 hPa from the ring around
      const R = Math.max(3, Math.round(250 / km)), E = Math.max(2, Math.round(40 / km));
      if (!f._marks) {
        const marks = [];
        for (let j = E; j < ny - E; j++) for (let i = E; i < nx - E; i++) {
          const v = ps[j * nx + i];
          if (v == null) continue;
          let lmin = true, lmax = true;           // a local extreme of its 3 × 3 neighbours first
          for (let b = j - 1; b <= j + 1; b++) for (let a = i - 1; a <= i + 1; a++) {
            const w = ps[b * nx + a];
            if (w == null || (a === i && b === j)) continue;
            if (w <= v) lmin = false;
            if (w >= v) lmax = false;
          }
          if (!lmin && !lmax) continue;
          let isMin = true, isMax = true, ring = 0, rn = 0;
          for (let b = Math.max(0, j - R); b <= Math.min(ny - 1, j + R) && (isMin || isMax); b++)
            for (let a = Math.max(0, i - R); a <= Math.min(nx - 1, i + R); a++) {
              const w = ps[b * nx + a];
              if (w == null || (a === i && b === j)) continue;
              if (w < v || (w === v && b * nx + a < j * nx + i)) isMin = false;
              if (w > v || (w === v && b * nx + a < j * nx + i)) isMax = false;
              if (Math.max(Math.abs(a - i), Math.abs(b - j)) === R) { ring += w; rn++; }
            }
          if (!(isMin || isMax) || !rn) continue;
          const dpth = v - ring / rn;
          if (isMin && dpth <= -1) marks.push({ i, j, t: 'L', v: p[j * nx + i] });
          if (isMax && dpth >= 1) marks.push({ i, j, t: 'H', v: p[j * nx + i] });
        }
        f._marks = marks;
      }
      for (const m of f._marks) {
        const q = pts[m.j * nx + m.i];
        ctx.font = 'bold 22px system-ui, sans-serif';
        ctx.lineWidth = 4; ctx.strokeStyle = T.halo; ctx.strokeText(m.t, q.x, q.y - 6);
        ctx.fillStyle = m.t === 'H' ? T.hi : T.lo; ctx.fillText(m.t, q.x, q.y - 6);
        ctx.font = 'bold 11px "Courier New", monospace';
        const txt = String(Math.round(m.v));
        ctx.lineWidth = 3; ctx.strokeText(txt, q.x, q.y + 12); ctx.fillText(txt, q.x, q.y + 12);
      }
    }

    // values of the frame at a map position (hover read-out)
    function valuesAt(latlng) {
      if (!frame || !grid || grid.proj) return null;
      const [x, y] = LCC.xy(latlng.lat, latlng.lng);
      if (fine && fineGrid && !fineGrid.proj) {                 // inside the 2.5 km box: its values
        const i = Math.round((x - fineGrid.x[0]) / fineGrid.x[1]), j = Math.round((y - fineGrid.y[0]) / fineGrid.y[1]);
        if (i >= 0 && j >= 0 && i < fineGrid.x[2] && j < fineGrid.y[2]) {
          const k = j * fineGrid.x[2] + i, out = { fine: 1 };
          for (const key of ['p', 'r', 's', 'c', 'l', 'm', 'h', 'f', 'b', 'u', 'v', 'g', 't']) if (fine[key] && fine[key][k] != null) out[key] = fine[key][k];
          return out;
        }
      }
      const i = Math.round((x - grid.x[0]) / grid.x[1]), j = Math.round((y - grid.y[0]) / grid.y[1]);
      if (i < 0 || j < 0 || i >= grid.x[2] || j >= grid.y[2]) return null;
      const k = j * grid.x[2] + i, f = frame, out = {};
      for (const key of ['p', 'r', 's', 'c', 'l', 'm', 'h', 'f', 'b', 'u', 'v', 'g', 't']) if (f[key] && f[key][k] != null) out[key] = f[key][k];
      return out;
    }
    function describe(v, latlng) {
      if (!v) return '';
      const parts = latlng ? [`${latlng.lat.toFixed(2)}°N ${latlng.lng.toFixed(2)}°E`] : [];
      if (v.p != null) parts.push(`${(1000 + v.p / 10).toFixed(1)} hPa`);
      if (v.u != null && v.v != null) {
        const sp = Math.hypot(v.u, v.v);
        parts.push(sp < 1 ? 'wind calm' : `wind ${String(Math.round(windDir(v.u, v.v)) % 360).padStart(3, '0')}° ${Math.round(sp)} kt (${(sp * 0.514444).toFixed(0)} m/s)`);
      }
      if (v.g != null) parts.push(`gust ${v.g} kt (${(v.g * 0.514444).toFixed(0)} m/s)`);
      if (v.r != null) {
        const snow = v.s != null && v.r > 0 && v.s >= 0.5 * v.r;
        parts.push(v.r >= 5 ? `${snow ? 'snow' : 'rain'} ${(v.r / 100).toFixed(1)} mm/h` : 'dry');
      }
      for (const key of ['c', 'l', 'm', 'h', 'f']) if (v[key] != null) parts.push(`${CLOUD_NAME[key]} ${v[key]} %`);
      if (v.b != null && ((v.l != null && v.l >= 20) || (v.c != null && v.c >= 20) || (v.f != null && v.f >= 20)))
        parts.push(`cloud base ${(Math.round(v.b * 3.2808 / 100) * 100).toLocaleString('en').replace(/,/g, ' ')} ft`);
      if (v.fine) parts.push('2.5 km grid');
      return parts.join(' · ');
    }

    place();
    return {
      setFrame(f, g) {
        if (g) setGrid(g);
        if (f && f.rs && !f.r && grid) prepRadar(f, grid);
        frame = f; draw();
      },
      // the FMI radar over the frame (or alone: setFrame(null))
      setOverlay(f, g) {
        if (g) {
          const k = JSON.stringify(g);
          if (k !== ovKey) { ovKey = k; ovGrid = g; ovGeo = buildGeo(g); }
        }
        ov = f && ovGrid ? prepRadar(f, ovGrid) : null; draw();
      },
      setOptions(x) { Object.assign(o, x); draw(); },
      // the 2.5 km detail frame (null: none) on its grid
      // (quiet: no redraw — a setFrame follows)
      setFine(f, g, quiet) {
        if (g) {
          const k = JSON.stringify(g);
          if (k !== fineKey) { fineKey = k; fineGrid = g; fineGeo = buildGeo(g); }
        }
        const nf = f && fineGrid ? f : null;
        if (nf === fine) return;
        fine = nf;
        if (!quiet) draw();
      },
      fineShown: () => !!(fine && fineGeo),
      setOpacity(a) { canvas.style.opacity = String(a); },
      show(on) { canvas.style.display = on ? '' : 'none'; },
      redraw: draw,
      grid: () => grid,
      // the barb drawn nearest to a container point (within r px): {k, dir, spd, values} or null
      barbAt(pt, r = 12) {
        if (!frame || canvas.style.display === 'none') return null;
        let best = null, bd = r * r;
        for (const b of drawn) {
          const d = (b[0] - pt.x) ** 2 + (b[1] - pt.y) ** 2;
          if (d <= bd) { bd = d; best = b; }
        }
        if (!best) return null;
        const vals = {};
        for (const key of ['u', 'v', 'g', 't']) if (frame[key] && frame[key][best[4]] != null) vals[key] = frame[key][best[4]];
        return { k: best[4], dir: best[2], spd: best[3], values: vals, latlng: geo.pt(best[4]) };
      },
      valuesAt, describe,
      // the radar's rain at a map position (from 2026-10-30, the phone's tap):
      // null = no radar shown; {in: false} outside its coverage; {in: true, r: mm/h × 100 (0 = dry)}
      radarAt(latlng) {
        if (!ov || !ovGrid) return null;
        const [E, N] = TM35.xy(latlng.lat, latlng.lng);
        const i = Math.round((E - ovGrid.x[0]) / ovGrid.x[1]), j = Math.round((N - ovGrid.y[0]) / ovGrid.y[1]);
        if (i < 0 || j < 0 || i >= ovGrid.x[2] || j >= ovGrid.y[2]) return { in: false };
        let cov = !ov.cov;
        for (let q = 0; !cov && q < ov.cov.length; q += 3) if (ov.cov[q] === j && i >= ov.cov[q + 1] && i <= ov.cov[q + 2]) cov = true;
        if (!cov) return { in: false };
        return { in: true, r: (ov.r && ov.r[j * ovGrid.x[2] + i]) || 0 };
      },
    };
  }

  function legendHtml(o) {
    const parts = [];
    if (o.edge) parts.push(`<span style="display:inline-block;width:16px;border-top:1px dashed ${theme().radarEdge};vertical-align:middle"></span> edge of the radar coverage`);
    if (o.edge && o.rain && o.modelOutline) {
      const T = theme(), ln = w => `<span style="display:inline-block;width:16px;border-top:${w}px solid ${T.mrain};box-shadow:0 0 0 1px ${T.mrainHalo};vertical-align:middle"></span>`;
      parts.push(`${ln(1)} ${ln(2)} the model's rain inside the radar area (from 0.1 / 1 mm/h)`);
    }
    const key = c => `<span class="wx-key" style="background:${c}"></span>`;
    if (o.rain) {
      parts.push('rain ' + RAIN_C.map((c, i) => `${key(c)} ${RAIN_T[i]}`).join(' ') + ' mm/h');
      parts.push('snow ' + SNOW_C.map(key).join(''));
    }
    const T = theme();
    if (o.gust) parts.push('gust ' + GUST_C.map((c, i) => `${key(c)} ${GUST_T[i]}`).join(' ') + ' kt');
    if (o.wind) parts.push(`barbs: ${o.windLabel || '10 m wind'} (kt; half feather 5, feather 10, pennant 50)`);
    if (o.pres) parts.push(`isobars every 4 hPa · <b style="color:${T.hi}">H</b> high · <b style="color:${T.lo}">L</b> low`);
    if (o.fine) parts.push(`<span style="display:inline-block;width:16px;border-top:1px dotted ${theme().fineEdge.replace(/[\d.]+\)$/, '0.9)')};vertical-align:middle"></span> 2.5 km detail area`);
    for (const c of o.clouds || []) parts.push(c === 'f' ? `<span class="wx-key" style="background:rgb(${T.fog})"></span> fog` : `grey: ${CLOUD_NAME[c]}`);
    return parts.join(' &nbsp;·&nbsp; ');
  }

  return { create, legendHtml, barb, windDir, LCC, TM35, RAIN_T, RAIN_C, SNOW_C, CLOUD_NAME, GUST_T, GUST_C };
})();
