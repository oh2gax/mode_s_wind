/**
 * windmap_xsection.js — vertical cross-section along a line on the Wind Map.
 *
 * "Section" puts the map in drawing mode: the first click sets A, the second
 * B; /api/windmap/xsection (web/api/windmap.py build_xsection) bins all
 * observations of the period within ±width of the line by distance along it
 * and by the time–height altitude layers.  The panel at the bottom of the map
 * shows distance A → B across and altitude (square-root pressure-altitude
 * scale, as the time–height section) up, coloured by
 *   anomaly  temperature minus the mean of the layer along the section
 *   wind     wind speed (10-kt steps)
 *   normal   wind component across the section (+ from left to right
 *            looking from A to B: red; − blue)
 *   dval     D-value of the pressure surface (GNSS heights, calibrated)
 * with wind barbs and the 0 / −10 / −20 °C isotherms.  Reloaded with the map.
 *
 * window.WmXsection = { init(opts), reload(range), active() }
 */
(function () {
  const $ = id => document.getElementById(id);
  const light = () => document.documentElement.dataset.theme === 'light';
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } };
  const isaP = ft => ft <= 36089 ? 1013.25 * Math.pow(1 - 6.8756e-6 * ft, 5.2559) : 226.32 * Math.exp(-(ft - 36089) / 20806);
  const fmtFt = ft => ft >= 6000 ? `FL${String(Math.round(ft / 100)).padStart(3, '0')}` : `${ft.toLocaleString('en').replace(/,/g, ' ')} ft`;
  const SPD = ['#1e3a5f', '#1d4e89', '#1f6fa8', '#21918c', '#2fa86e', '#6cc24a', '#b5d334',
               '#f2d930', '#f7b32b', '#f28a1e', '#e5592b', '#c7303c', '#9b1d4c', '#6e1458'];
  const spdFill = v => SPD[Math.max(0, Math.min(SPD.length - 1, Math.floor(v / 10)))];
  function divFill(v, full) {
    const k = Math.min(1, Math.abs(v) / full), c = v < 0 ? [37, 99, 235] : [220, 38, 38];
    return `rgba(${c[0]},${c[1]},${c[2]},${(0.08 + 0.82 * k).toFixed(3)})`;
  }
  const FULL = { anomaly: 4, normal: 60, dval: 300 };

  let opts = null, map = null, mode = 'off', A = null, B = null, data = null, lineLayer = null, geo = null, seq = 0;
  let field = lsGet('ms_wm_xs_field', 'anomaly');

  function setMode(m) {
    mode = m;
    $('wm-xs-btn').classList.toggle('active', m !== 'off' || !!data);
    map.getContainer().style.cursor = m === 'draw' ? 'crosshair' : '';
    if (m === 'draw') opts.status('Section: click the start point A on the map, then the end point B (Esc cancels)');
  }
  function drawLine() {
    lineLayer.clearLayers();
    if (!A) return;
    const col = light() ? '#0f172a' : '#f8fafc';
    const mk = (p, t) => L.marker(p, { interactive: false, icon: L.divIcon({ className: 'wm-iso-label',
      html: `<span style="color:${col};font-size:12px">${t}</span>`, iconSize: [14, 14], iconAnchor: [-4, 14] }) }).addTo(lineLayer);
    L.circleMarker(A, { radius: 4, color: col, weight: 2, fillOpacity: 1, fillColor: col, interactive: false }).addTo(lineLayer);
    mk(A, 'A');
    if (B) {
      L.polyline([A, B], { color: col, weight: 2.5, opacity: 0.9, dashArray: '8 5', interactive: false }).addTo(lineLayer);
      L.circleMarker(B, { radius: 4, color: col, weight: 2, fillOpacity: 1, fillColor: col, interactive: false }).addTo(lineLayer);
      mk(B, 'B');
    }
  }
  // capture phase on the map container: a click on a barb (marker) counts too
  function onDomClick(ev) {
    if (mode !== 'draw') return;
    if (ev.target.closest && ev.target.closest('.leaflet-control')) return;
    ev.stopPropagation(); ev.preventDefault();
    onClick({ latlng: map.mouseEventToLatLng(ev) });
  }
  function onClick(e) {
    if (mode !== 'draw') return;
    if (!A || B) { A = [e.latlng.lat, e.latlng.lng]; B = null; drawLine(); opts.status('Section: now click the end point B'); return; }
    B = [e.latlng.lat, e.latlng.lng];
    drawLine();
    setMode('off');
    if (opts.restore) opts.restore();
    $('wm-xs').classList.remove('wm-hidden');
    reload();
  }
  function close() {
    A = B = data = null; lineLayer.clearLayers(); $('wm-xs').classList.add('wm-hidden'); setMode('off');
  }

  async function reload(range) {
    if (!A || !B) return;
    const r = range || opts.range();
    if (!r || r.error) return;
    const req = ++seq;
    const cell = opts.cellKm();
    $('wm-xs-meta').textContent = 'Loading…';
    try {
      const u = `/api/windmap/xsection?lat1=${A[0].toFixed(4)}&lon1=${A[1].toFixed(4)}&lat2=${B[0].toFixed(4)}&lon2=${B[1].toFixed(4)}` +
                `&start=${r.start}&end=${r.end}&width=${cell}&step=${cell / 2}${opts.gnss() ? '&gnss_ok=1' : ''}`;
      const d = await fetch(u).then(x => x.json());
      if (req !== seq) return;
      data = d;
      render();
    } catch (e) {
      $('wm-xs-meta').textContent = 'Error loading the section.';
      console.error(e);
    }
  }

  function render() {
    const cv = $('wm-xs-canvas'), box = $('wm-xs-box');
    if (!cv || !box || !data || data.error) { if (data && data.error) $('wm-xs-meta').textContent = data.error; return; }
    const W = box.clientWidth, H = box.clientHeight;
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const Lt = light();
    const C = { bg: Lt ? '#f8fafc' : '#0f1923', plot: Lt ? '#eef2f6' : '#131e2b', grid: Lt ? '#cbd5e1' : '#243447',
                ink: Lt ? '#0f172a' : '#e2e8f0', ink2: Lt ? '#475569' : '#94a3b8', barb: Lt ? '#0f172a' : '#e2e8f0',
                iso0: Lt ? '#0369a1' : '#38bdf8', iso: Lt ? '#0e7490' : '#67e8f9' };
    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
    const layers = data.layers, nL = layers.length - 1, nb = data.bins;
    // grids
    const T = [], WD = [], WS = [], N = [], D = [];
    for (let b = 0; b < nb; b++) { T.push(new Array(nL).fill(null)); WD.push(new Array(nL).fill(null)); WS.push(new Array(nL).fill(null)); N.push(new Array(nL).fill(0)); D.push(new Array(nL).fill(null)); }
    let topL = 0;
    for (const c of data.cells) {
      const i = layers.indexOf(c[1]);
      if (i < 0 || i >= nL || c[0] >= nb) continue;
      T[c[0]][i] = c[2]; WD[c[0]][i] = c[3]; WS[c[0]][i] = c[4]; N[c[0]][i] = c[5]; D[c[0]][i] = c[6];
      topL = Math.max(topL, i);
    }
    topL = Math.max(topL, Math.min(nL - 1, 12));
    const mean = new Array(nL).fill(null);
    for (let i = 0; i < nL; i++) {
      let s = 0, w = 0;
      for (let b = 0; b < nb; b++) if (T[b][i] != null) { s += T[b][i] * N[b][i]; w += N[b][i]; }
      if (w) mean[i] = s / w;
    }
    // across-section unit vector (right of A→B) for the normal component
    const brg = data.dir_deg * Math.PI / 180;
    const rx = Math.cos(brg), ry = -Math.sin(brg);            // right-hand normal: east/north components
    const val = (b, i) => {
      if (field === 'anomaly') return T[b][i] != null && mean[i] != null ? T[b][i] - mean[i] : null;
      if (field === 'wind') return WS[b][i];
      if (field === 'dval') return D[b][i];
      if (field === 'normal') {
        if (WS[b][i] == null) return null;
        const r = WD[b][i] * Math.PI / 180, u = -WS[b][i] * Math.sin(r), v = -WS[b][i] * Math.cos(r);
        return u * rx + v * ry;
      }
      return null;
    };
    const fill = v => field === 'wind' ? spdFill(v) : divFill(v, FULL[field] || 4);
    const ml = 62, mr = 46, mt = 16, mb = 30;
    const pw = W - ml - mr, ph = H - mt - mb;
    const sq = ft => Math.sqrt(Math.max(0, ft) + 1500);
    const sBot = sq(0), sTop = sq(layers[topL + 1]);
    const y = ft => mt + ph * (sTop - sq(ft)) / (sTop - sBot);
    const bw = pw / nb;
    const x = b => ml + b * bw;
    geo = { ml, mt, pw, ph, bw, y, topL, layers, T, WD, WS, N, D, mean, val, nb };
    g.fillStyle = C.plot; g.fillRect(ml, mt, pw, ph);
    for (let b = 0; b < nb; b++) for (let i = 0; i <= topL; i++) {
      const v = val(b, i);
      if (v == null) continue;
      g.globalAlpha = N[b][i] < 2 ? 0.5 : 1;
      g.fillStyle = fill(v);
      g.fillRect(x(b), y(layers[i + 1]), bw + 0.5, y(layers[i]) - y(layers[i + 1]) + 0.5);
    }
    g.globalAlpha = 1;
    // axes
    g.font = '10px system-ui'; g.fillStyle = C.ink2; g.textAlign = 'right';
    for (const f of [0, 2000, 5000, 10000, 14000, 18000, 24000, 30000, 34000, 38000, 42000].filter(f => f <= layers[topL + 1])) {
      const yy = y(f);
      g.strokeStyle = C.grid; g.globalAlpha = 0.35; g.beginPath(); g.moveTo(ml, yy); g.lineTo(ml + pw, yy); g.stroke(); g.globalAlpha = 1;
      g.fillText(fmtFt(f), ml - 5, yy + 3);
      g.textAlign = 'left'; g.fillText(`${Math.round(isaP(f))}`, ml + pw + 5, yy + 3); g.textAlign = 'right';
    }
    g.textAlign = 'center';
    const kmStep = data.length_km > 400 ? 100 : 50;
    for (let km = 0; km <= data.length_km; km += kmStep) {
      const xx = ml + km / data.length_km * pw;
      g.strokeStyle = C.ink2; g.beginPath(); g.moveTo(xx, mt + ph); g.lineTo(xx, mt + ph + 4); g.stroke();
      g.fillText(`${km}`, xx, mt + ph + 14);
    }
    g.fillStyle = C.ink; g.font = 'bold 12px system-ui';
    g.textAlign = 'left'; g.fillText('A', ml, mt + ph + 26);
    g.textAlign = 'right'; g.fillText('B', ml + pw, mt + ph + 26);
    g.font = '10px system-ui'; g.fillStyle = C.ink2; g.textAlign = 'center'; g.fillText('km along the section', ml + pw / 2, mt + ph + 26);
    // isotherms: lowest crossing per bin, joined
    for (const [th, col, w, dash] of [[0, C.iso0, 2, []], [-10, C.iso, 1.2, [5, 4]], [-20, C.iso, 1.2, [2, 3]]]) {
      let prev = null;
      g.strokeStyle = col; g.lineWidth = w; g.setLineDash(dash);
      for (let b = 0; b < nb; b++) {
        let pt = null;
        for (let i = 0; i < topL; i++) {
          const a = T[b][i], c = T[b][i + 1];
          if (a == null || c == null) continue;
          if ((a - th) * (c - th) <= 0 && a !== c) {
            const za = (layers[i] + layers[i + 1]) / 2, zb = (layers[i + 1] + layers[i + 2]) / 2;
            pt = [x(b) + bw / 2, y(za + (th - a) / (c - a) * (zb - za))]; break;
          }
        }
        if (pt && prev && b - prev.b <= 2) { g.beginPath(); g.moveTo(prev.pt[0], prev.pt[1]); g.lineTo(pt[0], pt[1]); g.stroke(); }
        if (pt) prev = { b, pt };
      }
      g.setLineDash([]);
    }
    // barbs (every layer that has room)
    if (bw >= 18) {
      const rows = []; let lastY = Infinity;
      for (let i = 0; i <= topL; i++) { const yc = y((layers[i] + layers[i + 1]) / 2); if (lastY - yc >= 24) { rows.push(i); lastY = yc; } }
      for (const [col, lw] of [[Lt ? 'rgba(248,250,252,0.85)' : 'rgba(15,25,35,0.8)', 2.6], [C.barb, 1]]) {
        g.strokeStyle = col; g.fillStyle = col; g.lineWidth = lw;
        for (let b = 0; b < nb; b++) for (const i of rows) {
          if (WS[b][i] == null) continue;
          barb(g, x(b) + bw / 2, y((layers[i] + layers[i + 1]) / 2), WD[b][i], WS[b][i]);
        }
      }
    }
    g.strokeStyle = C.grid; g.lineWidth = 1; g.strokeRect(ml + 0.5, mt + 0.5, pw, ph);
    const dirTxt = `${Math.round(data.dir_deg)}°`;
    $('wm-xs-meta').textContent = `A ${data.a[0].toFixed(2)}°N ${data.a[1].toFixed(2)}°E → B ${data.b[0].toFixed(2)}°N ${data.b[1].toFixed(2)}°E · ` +
      `${Math.round(data.length_km)} km towards ${dirTxt}, ±${data.width_km} km, bins ${data.step_km} km · ${data.aircraft} a/c, ${data.obs_used} obs · ` +
      `${data.period_start} – ${data.period_end}`;
    renderLegend();
  }
  function barb(g, cx, cy, dir, spd) {
    const s = Math.round(spd / 5) * 5, r = dir * Math.PI / 180, ux = Math.sin(r), uy = -Math.cos(r);
    const L = 13, fx = -uy, fy = ux, tx = cx + ux * L, ty = cy + uy * L;
    g.beginPath(); g.arc(cx, cy, 1.3, 0, 2 * Math.PI); g.fill();
    if (s < 5) return;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(tx, ty); g.stroke();
    let rem = s, pos = 0;
    while (rem >= 50) { const ax = tx - ux * pos, ay = ty - uy * pos; g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax + fx * 6 - ux * 2, ay + fy * 6 - uy * 2); g.lineTo(ax - ux * 4, ay - uy * 4); g.closePath(); g.fill(); pos += 5; rem -= 50; }
    while (rem >= 10) { const ax = tx - ux * pos, ay = ty - uy * pos; g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax + fx * 6 + ux * 2, ay + fy * 6 + uy * 2); g.stroke(); pos += 3; rem -= 10; }
    if (rem >= 5) { const ax = tx - ux * (pos || 3), ay = ty - uy * (pos || 3); g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax + fx * 3 + ux, ay + fy * 3 + uy); g.stroke(); }
  }
  function renderLegend() {
    const el = $('wm-xs-legend');
    if (!el) return;
    if (field === 'wind') el.innerHTML = 'Wind speed ' + SPD.map(c => `<span class="th-sw" style="background:${c}"></span>`).join('') + ' <span class="th-lt">0 · 50 · 100 · 130+ kt</span>';
    else {
      const t = { anomaly: 'Temperature minus the layer mean along the section <span class="th-bar"></span> <span class="th-lt">−4 · 0 · +4 K</span>',
                  normal: 'Wind across the section <span class="th-bar"></span> <span class="th-lt">−60 kt (right → left) · 0 · +60 kt (left → right, looking A → B)</span>',
                  dval: 'Height of the pressure surface vs standard (D-value, GNSS) <span class="th-bar"></span> <span class="th-lt">−300 · 0 · +300 m</span>' };
      el.innerHTML = t[field] || '';
    }
    el.innerHTML += ' <span class="th-lt">· faint: 1 aircraft</span>';
  }
  function hover(ev) {
    const tip = $('wm-xs-tip');
    if (!geo || !data) { tip.style.display = 'none'; return; }
    const rect = $('wm-xs-canvas').getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    const { ml, mt, pw, ph, bw, y, topL, layers } = geo;
    if (mx < ml || mx > ml + pw || my < mt || my > mt + ph) { tip.style.display = 'none'; return; }
    const b = Math.floor((mx - ml) / bw);
    let i = null;
    for (let k = 0; k <= topL; k++) if (my <= y(layers[k]) && my >= y(layers[k + 1])) { i = k; break; }
    if (i == null || !(geo.N[b] && geo.N[b][i])) { tip.style.display = 'none'; return; }
    const km0 = b * data.step_km, km1 = Math.min(data.length_km, (b + 1) * data.step_km);
    const parts = [`<b>${Math.round(km0)}–${Math.round(km1)} km from A</b> · ${fmtFt(layers[i])}–${fmtFt(layers[i + 1])} (${Math.round(isaP(layers[i + 1]))}–${Math.round(isaP(layers[i]))} hPa)`];
    if (geo.T[b][i] != null) parts.push(`T ${geo.T[b][i].toFixed(1)} °C` + (geo.mean[i] != null ? ` <span class="mini-tip-dim">(${(geo.T[b][i] - geo.mean[i]) >= 0 ? '+' : ''}${(geo.T[b][i] - geo.mean[i]).toFixed(1)} K from the section mean)</span>` : ''));
    if (geo.WS[b][i] != null) {
      const nrm = (() => { field; const r = geo.WD[b][i] * Math.PI / 180, u = -geo.WS[b][i] * Math.sin(r), v = -geo.WS[b][i] * Math.cos(r);
        const br = data.dir_deg * Math.PI / 180; return u * Math.cos(br) - v * Math.sin(br); })();
      parts.push(`wind ${Math.round(geo.WD[b][i])}° ${Math.round(geo.WS[b][i])} kt <span class="mini-tip-dim">(across the section ${nrm >= 0 ? '+' : ''}${Math.round(nrm)} kt)</span>`);
    }
    if (geo.D[b][i] != null) parts.push(`pressure surface at ${Math.round(((layers[i] + layers[i + 1]) / 2) * 0.3048 + geo.D[b][i]).toLocaleString('en').replace(/,/g, ' ')} m <span class="mini-tip-dim">(D ${geo.D[b][i] >= 0 ? '+' : ''}${Math.round(geo.D[b][i])} m)</span>`);
    parts.push(`<span class="mini-tip-dim">${geo.N[b][i] || 0} aircraft</span>`);
    tip.innerHTML = parts.join('<br>');
    tip.style.display = '';
    const box = $('wm-xs-box');
    tip.style.left = Math.min(box.clientWidth - tip.offsetWidth - 4, mx + 14) + 'px';
    tip.style.top = Math.max(2, Math.min(box.clientHeight - tip.offsetHeight - 4, my + 10)) + 'px';
  }

  function init(o) {
    opts = o; map = o.map;
    lineLayer = L.layerGroup().addTo(map);
    map.getContainer().addEventListener('click', onDomClick, true);
    $('wm-xs-btn').addEventListener('click', () => { if (mode === 'draw') setMode('off'); else setMode('draw'); });
    $('wm-xs-close').addEventListener('click', close);
    $('wm-xs-field').value = field;
    $('wm-xs-field').addEventListener('change', e => { field = e.target.value; lsSet('ms_wm_xs_field', field); render(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && mode === 'draw') { setMode('off'); if (opts.restore) opts.restore(); } });
    const cv = $('wm-xs-canvas');
    cv.addEventListener('mousemove', hover);
    cv.addEventListener('mouseleave', () => { $('wm-xs-tip').style.display = 'none'; });
    new ResizeObserver(() => { if (data) render(); }).observe($('wm-xs-box'));
  }
  window.WmXsection = { init, reload, render: () => { drawLine(); render(); }, active: () => !!(A && B) };
})();
