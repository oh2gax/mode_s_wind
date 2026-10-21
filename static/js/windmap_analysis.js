/**
 * windmap_analysis.js — field analysis for the Wind Map (no map code here).
 *
 *   wmAnalyse(cells, opts)        Barnes-type objective analysis of the cell
 *                                 winds / temperatures onto a regular node grid,
 *                                 only near data (nodes farther than 0.75 cell
 *                                 from any cell centre are left empty)
 *                                 (and the heights of the pressure surface, "h",
 *                                 from the cells' D-values where they have one)
 *   wmContours(grid, field, lvls) marching-squares contour segments (isotachs,
 *                                 height contours)
 *   wmStreamlines(grid, opts)     streamlines traced through the analysed wind
 *   wmJetCore(grid, minKt)        strongest analysed wind (jet core marker)
 *   wmJetAxis(grid, opts)         jet-stream axis: the line of strongest wind
 *                                 along the flow where it is at least minKt
 *
 * Coordinates: a flat local projection centred on (lat0, lon0) in km —
 * x = Δlon · 110.57 · cos(lat0), y = Δlat · 110.57 — the same as the grid
 * cells of web/api/windmap.py.
 */
(function (root) {
  const KM_PER_DEG_LAT = 110.57;

  function proj(lat0, lon0) {
    const kx = KM_PER_DEG_LAT * Math.cos(lat0 * Math.PI / 180);
    return {
      toXY: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * KM_PER_DEG_LAT],
      toLL: (x, y) => [lat0 + y / KM_PER_DEG_LAT, lon0 + x / kx],
    };
  }

  // Wind FROM direction / speed ↔ u (towards east), v (towards north)
  const toUV = (dir, spd) => {
    const r = dir * Math.PI / 180;
    return [-spd * Math.sin(r), -spd * Math.cos(r)];
  };
  const fromUV = (u, v) => [((Math.atan2(-u, -v) * 180 / Math.PI) + 360) % 360, Math.hypot(u, v)];

  /**
   * cells: [{lat, lon, wind_dir, wind_spd, temp, ac}]
   * opts:  {lat0, lon0, cellKm, spacingKm (default cellKm / 2), lengthKm (default cellKm)}
   * → {nx, ny, x0, y0, dx, u, v, spd, t, ok (Uint8Array), proj}
   */
  function wmAnalyse(cells, opts) {
    const P = proj(opts.lat0, opts.lon0);
    const cellKm = opts.cellKm;
    const dx = opts.spacingKm || cellKm / 2;
    const L = opts.lengthKm || cellKm;
    const reach = 0.75 * cellKm;            // a node needs a cell centre this close
    const cut = 3 * L;                       // ignore cells beyond this distance
    const pts = cells.map(c => {
      const [x, y] = P.toXY(c.lat, c.lon);
      const [u, v] = toUV(c.wind_dir, c.wind_spd);
      return { x, y, u, v, t: c.temp, w: Math.min(10, Math.max(1, c.ac || 1)),
               h: c.dval != null && c.dval_ac ? c.dval : null, hw: Math.min(10, c.dval_ac || 0) };
    });
    if (!pts.length) return null;
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const p of pts) {
      xmin = Math.min(xmin, p.x); xmax = Math.max(xmax, p.x);
      ymin = Math.min(ymin, p.y); ymax = Math.max(ymax, p.y);
    }
    const x0 = Math.floor((xmin - cellKm) / dx) * dx, y0 = Math.floor((ymin - cellKm) / dx) * dx;
    const nx = Math.round((xmax + cellKm - x0) / dx) + 1, ny = Math.round((ymax + cellKm - y0) / dx) + 1;
    const N = nx * ny;
    const u = new Float64Array(N), v = new Float64Array(N), t = new Float64Array(N).fill(NaN);
    const spd = new Float64Array(N).fill(NaN), ok = new Uint8Array(N);
    const h = new Float64Array(N).fill(NaN), hok = new Uint8Array(N);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = x0 + i * dx, y = y0 + j * dx;
        let near = Infinity, nearH = Infinity, sw = 0, su = 0, sv = 0, stw = 0, st = 0, shw = 0, sh = 0;
        for (const p of pts) {
          const r = Math.hypot(p.x - x, p.y - y);
          if (r < near) near = r;
          if (r > cut) continue;
          const e = Math.exp(-(r * r) / (L * L));
          const w = p.w * e;
          sw += w; su += w * p.u; sv += w * p.v;
          if (p.t != null) { stw += w; st += w * p.t; }
          if (p.h != null) { if (r < nearH) nearH = r; shw += p.hw * e; sh += p.hw * e * p.h; }
        }
        const k = j * nx + i;
        if (near <= reach && sw > 0) {
          ok[k] = 1;
          u[k] = su / sw; v[k] = sv / sw;
          spd[k] = Math.hypot(u[k], v[k]);
          if (stw > 0) t[k] = st / stw;
        }
        if (nearH <= reach && shw > 0) { hok[k] = 1; h[k] = sh / shw; }
      }
    }
    return { nx, ny, x0, y0, dx, u, v, spd, t, ok, h, hok, proj: P };
  }

  /** Marching squares: segments [[lat, lon], [lat, lon]] of field = level,
   *  only in squares whose four corners are analysed. → {level: [seg, …]} */
  function wmContours(g, field, levels, okKey = 'ok') {
    const out = {};
    const F = g[field], OK = g[okKey];
    const at = (i, j) => F[j * g.nx + i];
    const okAt = (i, j) => OK[j * g.nx + i];
    const ll = (i, j) => g.proj.toLL(g.x0 + i * g.dx, g.y0 + j * g.dx);
    for (const lv of levels) {
      const segs = [];
      for (let j = 0; j < g.ny - 1; j++) {
        for (let i = 0; i < g.nx - 1; i++) {
          if (!(okAt(i, j) && okAt(i + 1, j) && okAt(i, j + 1) && okAt(i + 1, j + 1))) continue;
          const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
          if ([a, b, c, d].some(Number.isNaN)) continue;
          // corners: a (i,j)  b (i+1,j)  c (i+1,j+1)  d (i,j+1)
          const pts = [];
          const edge = (v1, v2, p1, p2) => {
            if ((v1 < lv) !== (v2 < lv)) {
              const f = (lv - v1) / (v2 - v1);
              pts.push([p1[0] + f * (p2[0] - p1[0]), p1[1] + f * (p2[1] - p1[1])]);
            }
          };
          edge(a, b, [i, j], [i + 1, j]);
          edge(b, c, [i + 1, j], [i + 1, j + 1]);
          edge(c, d, [i + 1, j + 1], [i, j + 1]);
          edge(d, a, [i, j + 1], [i, j]);
          const toLL = p => ll(p[0], p[1]);
          if (pts.length === 2) segs.push([toLL(pts[0]), toLL(pts[1])]);
          else if (pts.length === 4) {                    // saddle: pair by the centre value
            const m = (a + b + c + d) / 4;
            if ((m < lv) === (a < lv)) { segs.push([toLL(pts[0]), toLL(pts[3])]); segs.push([toLL(pts[1]), toLL(pts[2])]); }
            else { segs.push([toLL(pts[0]), toLL(pts[1])]); segs.push([toLL(pts[2]), toLL(pts[3])]); }
          }
        }
      }
      if (segs.length) out[lv] = segs;
    }
    return out;
  }

  // Bilinear interpolation of u, v at grid coordinates (fi, fj); null outside
  function sampleUV(g, fi, fj) {
    const i = Math.floor(fi), j = Math.floor(fj);
    if (i < 0 || j < 0 || i >= g.nx - 1 || j >= g.ny - 1) return null;
    const k = j * g.nx + i;
    if (!(g.ok[k] && g.ok[k + 1] && g.ok[k + g.nx] && g.ok[k + g.nx + 1])) return null;
    const a = fi - i, b = fj - j;
    const mix = A => (A[k] * (1 - a) + A[k + 1] * a) * (1 - b) + (A[k + g.nx] * (1 - a) + A[k + g.nx + 1] * a) * b;
    return [mix(g.u), mix(g.v)];
  }

  /** Streamlines through the analysed wind: [[[lat, lon], …], …], each traced
   *  forwards and backwards from seeds every `seedStep` nodes; a line stops at
   *  the edge of the analysed area or where another line already runs. */
  function wmStreamlines(g, opts = {}) {
    const seedStep = opts.seedStep || 2, h = opts.stepNodes || 0.4, maxSteps = opts.maxSteps || 120;
    const occ = new Uint8Array(g.nx * g.ny);
    const lines = [];
    const occKey = (fi, fj) => Math.round(fj) * g.nx + Math.round(fi);
    const trace = (fi, fj, sign, own) => {
      const path = [];
      for (let s = 0; s < maxSteps; s++) {
        const w1 = sampleUV(g, fi, fj);
        if (!w1) break;
        const m1 = Math.hypot(w1[0], w1[1]);
        if (m1 < 0.5) break;
        const mi = fi + sign * h * w1[0] / m1 / 2, mj = fj + sign * h * w1[1] / m1 / 2;
        const w2 = sampleUV(g, mi, mj);                   // midpoint (RK2)
        if (!w2) break;
        const m2 = Math.hypot(w2[0], w2[1]);
        if (m2 < 0.5) break;
        fi += sign * h * w2[0] / m2; fj += sign * h * w2[1] / m2;
        const k = occKey(fi, fj);
        if (occ[k] && !own.has(k) && s > 2) break;          // ran into another line
        own.add(k);
        path.push([fi, fj]);
      }
      return path;
    };
    for (let j = 1; j < g.ny - 1; j += seedStep) {
      for (let i = 1; i < g.nx - 1; i += seedStep) {
        const k0 = j * g.nx + i;
        if (!g.ok[k0] || occ[k0]) continue;
        const own = new Set([k0]);
        const fw = trace(i, j, 1, own), bw = trace(i, j, -1, own);
        const path = bw.reverse().concat([[i, j]], fw);
        if (path.length < 6) continue;
        own.forEach(k => { occ[k] = 1; });
        lines.push(path.map(([fi, fj]) => g.proj.toLL(g.x0 + fi * g.dx, g.y0 + fj * g.dx)));
      }
    }
    return lines;
  }

  /** The strongest analysed wind: {lat, lon, spd, dir} or null when below minKt */
  function wmJetCore(g, minKt) {
    let best = -1, kb = -1;
    for (let k = 0; k < g.spd.length; k++) if (g.ok[k] && g.spd[k] > best) { best = g.spd[k]; kb = k; }
    if (kb < 0 || best < minKt) return null;
    const i = kb % g.nx, j = Math.floor(kb / g.nx);
    const [lat, lon] = g.proj.toLL(g.x0 + i * g.dx, g.y0 + j * g.dx);
    const [dir] = fromUV(g.u[kb], g.v[kb]);
    return { lat, lon, spd: best, dir };
  }

  /**
   * Jet-stream axis (the line of the aviation SIGWX jet symbol).
   * The mean flow direction of the analysed points with ≥ minKt defines an
   * along-flow (s) / across-flow (c) frame; the analysed grid is cut into
   * across-flow sections stepKm wide, and in each section the strongest
   * point is the axis.  The run of sections with ≥ minKt that contains the
   * overall maximum (gaps of one section bridged) is the jet; the across-flow
   * position is smoothed over three sections.  A point is "edge" when the
   * strongest wind of its section lies at the edge of the data across the
   * flow (the real axis may be beyond); otherwise the speed falls off on both
   * sides and the axis is inside the data.
   * → {pts: [{lat, lon, x, y, spd, dir, edge}], iMax, ex, ey (unit flow
   *    vector), nx, ny (unit vector to the left)} or null
   */
  function wmJetAxis(g, opts = {}) {
    const minKt = opts.minKt || 80;
    const step = opts.stepKm || 2 * g.dx;
    const N = g.nx * g.ny;
    let su = 0, sv = 0, n = 0;
    for (let k = 0; k < N; k++) {
      if (!g.ok[k] || !(g.spd[k] >= minKt)) continue;
      const w = g.spd[k] - minKt + 1;
      su += w * g.u[k]; sv += w * g.v[k]; n++;
    }
    if (!n) return null;
    const m = Math.hypot(su, sv);
    if (m < 1e-6) return null;
    const ex = su / m, ey = sv / m, lx = -ey, ly = ex;
    // sections across the flow
    const sec = new Map();
    for (let j = 0; j < g.ny; j++) {
      for (let i = 0; i < g.nx; i++) {
        const k = j * g.nx + i;
        if (!g.ok[k]) continue;
        const x = g.x0 + i * g.dx, y = g.y0 + j * g.dx;
        const s = x * ex + y * ey, c = x * lx + y * ly;
        const b = Math.round(s / step);
        let o = sec.get(b);
        if (!o) sec.set(b, o = { cmin: Infinity, cmax: -Infinity, best: -1, k: -1, c: 0 });
        o.cmin = Math.min(o.cmin, c); o.cmax = Math.max(o.cmax, c);
        if (g.spd[k] > o.best) { o.best = g.spd[k]; o.k = k; o.c = c; }
      }
    }
    const bins = [...sec.keys()].sort((a, b) => a - b);
    let bMax = null;
    for (const b of bins) if (bMax == null || sec.get(b).best > sec.get(bMax).best) bMax = b;
    if (bMax == null || sec.get(bMax).best < minKt) return null;
    const strong = b => sec.has(b) && sec.get(b).best >= minKt;
    let lo = bMax, hi = bMax;
    while (strong(lo - 1) || (!sec.has(lo - 1) && strong(lo - 2))) lo -= strong(lo - 1) ? 1 : 2;
    while (strong(hi + 1) || (!sec.has(hi + 1) && strong(hi + 2))) hi += strong(hi + 1) ? 1 : 2;
    const run = bins.filter(b => b >= lo && b <= hi && strong(b));
    const cs = run.map(b => sec.get(b).c);
    const pts = run.map((b, idx) => {
      const o = sec.get(b);
      const near = cs.slice(Math.max(0, idx - 1), idx + 2);
      const c = near.reduce((a, v) => a + v, 0) / near.length;
      const s = b * step;
      const x = s * ex + c * lx, y = s * ey + c * ly;
      const [lat, lon] = g.proj.toLL(x, y);
      const [dir] = fromUV(g.u[o.k], g.v[o.k]);
      const tol = 0.75 * g.dx;
      return { lat, lon, x, y, spd: o.best, dir, edge: !(o.c > o.cmin + tol && o.c < o.cmax - tol) };
    });
    const iMax = run.indexOf(bMax);
    return { pts, iMax, ex, ey, lx, ly };
  }

  const api = { wmAnalyse, wmContours, wmStreamlines, wmJetCore, wmJetAxis, wmToUV: toUV, wmFromUV: fromUV, wmProj: proj };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
