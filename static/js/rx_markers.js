/**
 * rx_markers.js — the receivers on the maps (from 2026-11-02; moved here from
 * base.html in the evening of 2 Nov 2026 so that the mobile view's Weather map
 * uses the same markers).  Loaded by base.html (Live Map, Weather, Wind Map)
 * and app.html (the phone's Weather view).
 */
// ── The receivers on the maps (from 2026-11-02) ────────────────────────────────
// Before, a blue dot at RECEIVER_LAT / RECEIVER_LON — the map centre at the airport, not
// the antenna.  Now each receiver at its own position as the Statistics page uses it (the
// Radarcape's GPS, readsb's receiver.json or ANTENNA_LAT / LON), rounded to 0.01°
// (/api/coverage); refreshed every 10 min (every minute until a position is known).
// The same small triangle as the Live Map's coverage markers (later on 2 Nov 2026; before a
// filled dot): RX-01 light blue (blue in the Light theme), RX-02 violet, then teal and amber,
// labelled RX-01 / RX-02 when there are several (colours in style.css .ms-rx-*, so a theme
// switch needs no redraw).  Live Map, Weather and Wind Map: msRxMarkers(map) returns a layer group.
// opts.passive: the triangles take no taps (the phone's Weather view finds them in its own tap
// handler, as the aircraft; each marker carries options.rx and options.rxText).
window.msRxMarkers = function (map, opts) {
  var TYPE = { radarcape: 'Radarcape', airspy: 'AirSpy', readsb: 'readsb' };
  var esc = function (v) { return String(v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var tri = function (r, i, n) {
    var lbl = n > 1 ? '<span class="ms-rx-lbl">' + esc(String(r.id || '').replace(/^MODES-/, '') || 'Receiver') + '</span>' : '';
    return L.divIcon({ className: 'ms-rx-tri ms-rx-' + (i % 4), iconSize: [12, 12], iconAnchor: [6, 7],
      html: '<svg width="12" height="12" viewBox="-6 -7 12 12" aria-hidden="true"><polygon points="0,-6 5,3.5 -5,3.5"/></svg>' + lbl });
  };
  var g = L.layerGroup(), known = false, timer = null;
  var load = function () {
    fetch('/api/coverage?hours=1', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      // a receiver whose position is not known yet (src "centre": the map centre) is left
      // out; the colours stay with the receivers' order
      var all = (d && d.receivers) || [];
      var ok = function (r) { return r.lat != null && r.lon != null && r.src !== 'centre'; };
      if (!all.some(ok)) return;
      g.clearLayers();
      all.forEach(function (r, i) {
        if (!ok(r)) return;
        var txt = (r.id || 'Receiver') + (r.name ? ' · ' + r.name : '') + (r.type ? ' — ' + (TYPE[r.type] || r.type) : '');
        var mk = L.marker([r.lat, r.lon], { icon: tri(r, i, all.length), keyboard: false,
                                            interactive: !(opts && opts.passive), rx: r, rxText: txt });
        if (opts && opts.passive) { g.addLayer(mk); return; }
        g.addLayer(mk.bindTooltip(
          esc(r.id || 'Receiver') + (r.name ? ' · ' + esc(r.name) : '') +
          (r.type ? ' — ' + esc(TYPE[r.type] || r.type) : '') + ' (position to about 1 km)'));
      });
      if (!known) { known = true; clearInterval(timer); timer = setInterval(function () { if (!document.hidden) load(); }, 600000); }
    }).catch(function () {});
  };
  load();
  timer = setInterval(function () { if (!document.hidden) load(); }, 60000);   // until a position is known
  return g;
};
