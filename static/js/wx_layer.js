/**
 * wx_layer.js — MEPS surface weather drawn on a Leaflet map (shared by the
 * Weather page, weather.js, and the Live Map overlay, live_map.js).
 *
 * A frame (from /api/weather/frames) holds integer lists on a regular grid in
 * the MEPS Lambert projection: p (hPa − 1000) × 10, r / s rain / snow of the
 * hour (mm × 100), c / l / m / h total / low / medium / high cloud %, f fog %,
 * b cloud base (m).  WxLayer.create(map, opts) puts a canvas into its own
 * pane (under the aircraft on the Live Map) and draws:
 *   clouds   — the chosen cloud fields as grey (fog: yellow), denser with
 *              more cover (cells drawn opaque on an offscreen canvas, then
 *              the cover turned into transparency: no seams between cells)
 *   rain     — radar-like colours by intensity, snow (≥ half of it) violet
 *   pressure — isobars every 4 hPa with labels, highs H and lows L
 * The overall opacity is the canvas opacity (setOpacity).
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
  //    GRS80, 27° E, k0 0.9996, false easting 500 km — inverse only ────────
  const TM35 = {
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
  const isLight = () => document.documentElement.dataset.theme === 'light';
  const theme = () => isLight()
    ? { iso: 'rgba(30,41,59,0.85)', isoLbl: '#1e293b', halo: 'rgba(241,245,249,0.9)', hi: '#1d4ed8', lo: '#b91c1c',
        cloud: [71, 85, 105], fog: [180, 120, 0] }
    : { iso: 'rgba(226,232,240,0.8)', isoLbl: '#e2e8f0', halo: 'rgba(15,25,35,0.85)', hi: '#60a5fa', lo: '#f87171',
        cloud: [226, 232, 240], fog: [250, 204, 21] };
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
    let o = { rain: true, clouds: [], pres: true };

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
      if (!frame || !geo) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const T = theme(), { nx, ny } = geo;
      const P = ll => map.latLngToContainerPoint(ll);
      const corP = new Array((nx + 1) * (ny + 1));          // corners projected when a cell needs them
      const C = k => corP[k] || (corP[k] = P(geo.cor(k)));
      const g2 = off.getContext('2d');
      const quad = (i, j, col) => {
        const a = C(j * (nx + 1) + i), b = C(j * (nx + 1) + i + 1), c = C((j + 1) * (nx + 1) + i + 1), d = C((j + 1) * (nx + 1) + i);
        g2.fillStyle = g2.strokeStyle = col;
        g2.beginPath(); g2.moveTo(a.x, a.y); g2.lineTo(b.x, b.y); g2.lineTo(c.x, c.y); g2.lineTo(d.x, d.y); g2.closePath();
        g2.fill(); g2.stroke();
      };
      const layer = alpha => {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = alpha; ctx.drawImage(off, 0, 0); ctx.globalAlpha = 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      };
      const begin = () => {
        g2.setTransform(1, 0, 0, 1, 0, 0); g2.clearRect(0, 0, off.width, off.height);
        g2.setTransform(dpr, 0, 0, dpr, 0, 0); g2.lineWidth = 0.8;
      };
      const f = frame;
      // clouds / fog: grey value = cover, then red → alpha in the field's colour
      for (const key of o.clouds) {
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
      // rain / snow
      if (o.rain && f.r) {
        begin();
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
          const k = j * nx + i, r = f.r[k];
          if (r == null || r < 10) continue;
          const cl = rainClass(r / 100);
          if (cl < 0) continue;
          const snow = f.s && f.s[k] != null && f.s[k] >= 0.5 * r;
          quad(i, j, (snow ? SNOW_C : RAIN_C)[cl]);
        }
        layer(opts.rainAlpha || 0.72);
      }
      if (o.pres && f.p) drawPressure(ctx, f, T, P);
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
      const i = Math.round((x - grid.x[0]) / grid.x[1]), j = Math.round((y - grid.y[0]) / grid.y[1]);
      if (i < 0 || j < 0 || i >= grid.x[2] || j >= grid.y[2]) return null;
      const k = j * grid.x[2] + i, f = frame, out = {};
      for (const key of ['p', 'r', 's', 'c', 'l', 'm', 'h', 'f', 'b']) if (f[key] && f[key][k] != null) out[key] = f[key][k];
      return out;
    }
    function describe(v, latlng) {
      if (!v) return '';
      const parts = latlng ? [`${latlng.lat.toFixed(2)}°N ${latlng.lng.toFixed(2)}°E`] : [];
      if (v.p != null) parts.push(`${(1000 + v.p / 10).toFixed(1)} hPa`);
      if (v.r != null) {
        const snow = v.s != null && v.r > 0 && v.s >= 0.5 * v.r;
        parts.push(v.r >= 5 ? `${snow ? 'snow' : 'rain'} ${(v.r / 100).toFixed(1)} mm/h` : 'dry');
      }
      for (const key of ['c', 'l', 'm', 'h', 'f']) if (v[key] != null) parts.push(`${CLOUD_NAME[key]} ${v[key]} %`);
      if (v.b != null && ((v.l != null && v.l >= 20) || (v.c != null && v.c >= 20) || (v.f != null && v.f >= 20)))
        parts.push(`cloud base ${(Math.round(v.b * 3.2808 / 100) * 100).toLocaleString('en').replace(/,/g, ' ')} ft`);
      return parts.join(' · ');
    }

    place();
    return {
      setFrame(f, g) {
        if (g) setGrid(g);
        if (f && f.rs && !f.r && grid) {          // sparse rain (the radar): [index, value, …] → a full list
          const r = new Array(grid.x[2] * grid.y[2]).fill(null);
          for (let q = 0; q < f.rs.length; q += 2) r[f.rs[q]] = f.rs[q + 1];
          f.r = r;
        }
        frame = f; draw();
      },
      setOptions(x) { Object.assign(o, x); draw(); },
      setOpacity(a) { canvas.style.opacity = String(a); },
      show(on) { canvas.style.display = on ? '' : 'none'; },
      redraw: draw,
      grid: () => grid,
      valuesAt, describe,
    };
  }

  function legendHtml(o) {
    const parts = [];
    const key = c => `<span class="wx-key" style="background:${c}"></span>`;
    if (o.rain) {
      parts.push('rain ' + RAIN_C.map((c, i) => `${key(c)} ${RAIN_T[i]}`).join(' ') + ' mm/h');
      parts.push('snow ' + SNOW_C.map(key).join(''));
    }
    const T = theme();
    if (o.pres) parts.push(`isobars every 4 hPa · <b style="color:${T.hi}">H</b> high · <b style="color:${T.lo}">L</b> low`);
    for (const c of o.clouds || []) parts.push(c === 'f' ? `<span class="wx-key" style="background:rgb(${T.fog})"></span> fog` : `grey: ${CLOUD_NAME[c]}`);
    return parts.join(' &nbsp;·&nbsp; ');
  }

  return { create, legendHtml, LCC, TM35, RAIN_T, RAIN_C, SNOW_C, CLOUD_NAME };
})();
