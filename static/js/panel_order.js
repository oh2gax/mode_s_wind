/**
 * panel_order.js — the panels of a page can be dragged into another order
 * (from the evening of 2026-11-21: the Statistics page, and the Recorder and
 * Charts views of its MLAT tab).
 *
 *   PanelOrder.attach({ root, groupSel, keyOf, key, reset, scroll, visible })
 *
 *   root      the element that holds the panels (.mst-panel) — in columns
 *             (groupSel, e.g. '.mst-col': the Statistics page, the Recorder view;
 *             '.mlc-col': the Charts view's bands and columns) or directly (a grid
 *             of rows; no page uses that now — rows leave holes under short panels)
 *   keyOf     panel → its name in the saved order (default: data-pk)
 *   key       the localStorage key of the saved order
 *   reset     a button that puts the original order back; shown only while the
 *             order differs from it (and visible() is true, when given)
 *   scroll    the element that scrolls while a panel is dragged near its upper
 *             or lower edge (default: root)
 *
 * A panel is taken by its title bar (.gps-panel-hdr) with the mouse or a pen —
 * not by touch, where the same gesture scrolls — and moves in the layout itself
 * while the pointer goes over the others: nothing floats, and a panel is as
 * wide as the place it is put in.  In a grid it takes the place of the panel under the pointer; in
 * columns it goes above or below that panel (its upper or lower half), or to
 * the end of a column when dropped in the free room under it; while a panel is
 * dragged the columns are outlined, so that an empty one can be found.  Esc puts
 * it back.
 * The order is a convenience of this browser: nothing goes to the server.  A
 * panel the saved order does not know (added in a later version) goes where the
 * page has it, after the panel it follows there.
 */
(function () {
  'use strict';
  const CSS = '.po-hdr{cursor:grab}'
    + '.po-dragging,.po-dragging *{cursor:grabbing!important;user-select:none;-webkit-user-select:none}'
    + '.mst-panel.po-drag{outline:2px solid var(--accent,#3b82f6);outline-offset:-2px;opacity:.55}'
    + '.po-dragging .po-grp{min-height:56px;outline:1px dashed rgba(148,163,184,.55);outline-offset:3px;border-radius:6px}';
  let styled = false;

  function attach(o) {
    const root = o && o.root;
    if (!root) return null;
    if (!styled) { const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); styled = true; }
    const cols = !!o.groupSel, scroller = o.scroll || root;
    const keyOf = o.keyOf || (p => p.dataset.pk);
    const groups = () => cols ? [...root.children].filter(g => g.matches(o.groupSel)) : [root];
    const isPanel = p => p.nodeType === 1 && p.classList.contains('mst-panel') && !!keyOf(p);
    const panelsOf = g => [...g.children].filter(isPanel);
    const layout = () => groups().map(g => panelsOf(g).map(keyOf));
    const ser = l => l.map(g => g.join(',')).join('|');
    const DEF = layout();
    const lsGet = () => { try { return localStorage.getItem(o.key) || ''; } catch (_) { return ''; } };
    const lsSet = v => { try { if (v) localStorage.setItem(o.key, v); else localStorage.removeItem(o.key); } catch (_) { /* a convenience only */ } };

    function apply(l) {
      const gs = groups(), by = {}, used = new Set();
      gs.forEach(g => panelsOf(g).forEach(p => { by[keyOf(p)] = p; }));
      const out = gs.map((g, i) => (l[i] || []).filter(k => by[k] && !used.has(k) && used.add(k)));
      DEF.forEach((keys, i) => keys.forEach((k, n) => {       // panels the list does not have: where the page has them
        if (used.has(k) || !by[k] || !out[i]) return;
        let at = 0;
        for (let j = n - 1; j >= 0; j--) { const q = out[i].indexOf(keys[j]); if (q >= 0) { at = q + 1; break; } }
        out[i].splice(at, 0, k); used.add(k);
      }));
      out.forEach((keys, i) => keys.forEach(k => gs[i].appendChild(by[k])));
    }
    function changed() {
      const now = ser(layout()), same = now === ser(DEF);
      lsSet(same ? '' : now);
      if (o.reset) o.reset.style.display = same || (o.visible && !o.visible()) ? 'none' : '';
    }
    { const saved = lsGet(); if (saved) apply(saved.split('|').map(g => g ? g.split(',') : [])); changed(); }
    if (o.reset) o.reset.addEventListener('click', () => { apply(DEF); changed(); });
    if (cols) groups().forEach(g => g.classList.add('po-grp'));
    groups().forEach(g => panelsOf(g).forEach(p => {
      const h = p.querySelector(':scope > .gps-panel-hdr');
      if (h) { h.classList.add('po-hdr'); if (!h.title) h.title = 'Drag to move this panel'; }
    }));

    let d = null;                                              // the drag: { el, hdr, id, x, y, px, py, from, live, last, raf }
    function under(x, y) {
      const e = document.elementFromPoint(x, y);
      if (!e || !root.contains(e)) return {};
      const p = e.closest('.mst-panel'), gs = groups();
      if (p && isPanel(p) && gs.includes(p.parentNode)) return { panel: p };
      const g = cols ? e.closest(o.groupSel) : null;
      return g && gs.includes(g) ? { group: g } : {};
    }
    function move() {
      const t = under(d.px, d.py), el = d.el;
      if (cols) {
        if (t.panel && t.panel !== el) {                       // above or below the panel under the pointer
          const r = t.panel.getBoundingClientRect(), before = d.py < r.top + r.height / 2;
          const ref = before ? t.panel : t.panel.nextElementSibling;
          if (ref !== el && !(el.parentNode === t.panel.parentNode && el.nextElementSibling === ref)) t.panel.parentNode.insertBefore(el, ref);
        } else if (t.group) {                                  // the free room under a column's last panel
          let low = -Infinity;
          panelsOf(t.group).forEach(p => { if (p !== el && p.offsetParent) low = Math.max(low, p.getBoundingClientRect().bottom); });
          if (d.py > low && t.group.lastElementChild !== el) t.group.appendChild(el);
        }
        return;
      }
      if (!t.panel || t.panel === el) { d.last = null; return; }
      if (t.panel === d.last) return;                          // the same neighbour as after the last move: wait until the pointer leaves it
      root.insertBefore(el, t.panel.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING ? t.panel : t.panel.nextElementSibling);
      d.last = under(d.px, d.py).panel || null;                // what lies under the pointer in the new layout
      if (d.last === el) d.last = null;
    }
    function autoScroll() {                                    // near the upper or lower edge of the view: scroll it
      if (!d || !d.live) return;
      const r = scroller.getBoundingClientRect(), m = 60;
      const v = d.py < r.top + m ? -Math.min(18, (r.top + m - d.py) / 3) : d.py > r.bottom - m ? Math.min(18, (d.py - r.bottom + m) / 3) : 0;
      if (v) { const s0 = scroller.scrollTop; scroller.scrollTop += v; if (scroller.scrollTop !== s0) move(); }
      d.raf = requestAnimationFrame(autoScroll);
    }
    function end(keep) {
      if (!d) return;
      const q = d; d = null;
      cancelAnimationFrame(q.raf);
      try { q.hdr.releasePointerCapture(q.id); } catch (_) { /* already released */ }
      q.el.classList.remove('po-drag'); root.classList.remove('po-dragging');
      if (!q.live) return;
      if (!keep) apply(q.from);
      changed();
    }
    root.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.pointerType === 'touch' || d) return;
      const hdr = e.target.closest('.gps-panel-hdr'), el = hdr && hdr.parentNode;
      if (!el || !isPanel(el) || !groups().includes(el.parentNode)) return;
      if (e.target.closest('button, select, input, textarea, a, label, [role="button"], [tabindex]')) return;
      d = { el, hdr, id: e.pointerId, x: e.clientX, y: e.clientY, px: e.clientX, py: e.clientY, from: layout(), live: false, last: null, raf: 0 };
    });
    window.addEventListener('pointermove', e => {
      if (!d || e.pointerId !== d.id) return;
      d.px = e.clientX; d.py = e.clientY;
      if (!d.live) {
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;        // a click, not a drag
        d.live = true;
        try { d.hdr.setPointerCapture(d.id); } catch (_) { /* the drag works without it */ }
        d.el.classList.add('po-drag'); root.classList.add('po-dragging');
        try { window.getSelection().removeAllRanges(); } catch (_) { /* nothing selected */ }
        d.raf = requestAnimationFrame(autoScroll);
      }
      e.preventDefault();
      move();
    });
    window.addEventListener('pointerup', e => { if (d && e.pointerId === d.id) end(true); });
    window.addEventListener('pointercancel', e => { if (d && e.pointerId === d.id) end(false); });
    window.addEventListener('keydown', e => { if (d && d.live && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(false); } }, true);
    window.addEventListener('blur', () => end(false));
    return { refresh: changed, layout, reset: () => { apply(DEF); changed(); } };
  }
  window.PanelOrder = { attach };
})();
