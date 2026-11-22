/**
 * panel_order.js — the panels of a page can be dragged into another order
 * (from the evening of 2026-11-21: the Statistics page, and the Recorder and
 * Charts views of its MLAT tab).
 *
 *   PanelOrder.attach({ root, groupSel, keyOf, key, reset, scroll, visible, fold, touch, panelSel })
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
 *   fold      (from 2026-11-22) the localStorage key of the folded panels: every
 *             title bar gets a small button that folds the panel to that bar
 *   touch     (from 2026-11-22, the phone view /app) true: a panel is also taken
 *             by a finger held on its title bar for a moment (a plain swipe
 *             scrolls as before); while it is carried, all panels show their
 *             title bars only
 *   panelSel  what a panel is (default '.mst-panel'); the phone's Statistics view
 *             moves the section that wraps each panel
 *
 * A panel is taken by its title bar (.gps-panel-hdr) with the mouse or a pen —
 * by touch only with the option above, where a swipe scrolls — and moves in the layout itself
 * while the pointer goes over the others: nothing floats, and a panel is as
 * wide as the place it is put in.  In a grid it takes the place of the panel under the pointer; in
 * columns it goes above or below that panel (its upper or lower half), or to
 * the end of a column when dropped in the free room under it; while a panel is
 * dragged the columns are outlined, so that an empty one can be found.  Esc puts
 * it back.
 * The order and the folded panels are a convenience of this browser: nothing goes to the server.  A
 * panel the saved order does not know (added in a later version) goes where the
 * page has it, after the panel it follows there.
 */
(function () {
  'use strict';
  const CSS = '.po-hdr{cursor:grab}'
    + '.po-dragging,.po-dragging *{cursor:grabbing!important;user-select:none;-webkit-user-select:none}'
    + '.po-drag{outline:2px solid var(--accent,#3b82f6);outline-offset:-2px;opacity:.55}'
    + '.po-touch .po-hdr{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}'
    + '.po-hdr-f{position:relative;padding-right:30px!important}'
    + '.po-fold-btn{position:absolute;right:3px;top:50%;transform:translateY(-50%);width:24px;height:22px;padding:0;border:0;border-radius:4px;'
    + 'background:transparent;color:var(--text-3,#94a3b8);font-size:12px;line-height:22px;cursor:pointer}'
    + '.po-fold-btn:hover,.po-fold-btn:focus-visible{background:rgba(148,163,184,.22);color:var(--text-1,#e2e8f0)}'
    + '.po-folded>:not(.gps-panel-hdr),.po-tmpfold>:not(.gps-panel-hdr){display:none!important}'
    + '.po-tmpfold{min-height:0!important;height:auto!important;flex:0 0 auto!important}'
    + '.po-folded{min-height:0!important;height:auto!important;flex:0 0 auto!important}'
    + '.po-folded>.gps-panel-hdr{border-bottom-color:transparent}'
    + '.po-dragging .po-grp{min-height:56px;outline:1px dashed rgba(148,163,184,.55);outline-offset:3px;border-radius:6px}';
  let styled = false;

  function attach(o) {
    const root = o && o.root;
    if (!root) return null;
    if (!styled) { const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); styled = true; }
    const cols = !!o.groupSel, scroller = o.scroll || root;
    const keyOf = o.keyOf || (p => p.dataset.pk);
    const groups = () => cols ? [...root.children].filter(g => g.matches(o.groupSel)) : [root];
    const PSEL = o.panelSel || '.mst-panel';
    const isPanel = p => p.nodeType === 1 && p.matches(PSEL) && !!keyOf(p);
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
    // ── Folding (from 2026-11-22): a panel folded to its title bar; the names of the folded ones are kept ──
    const hdrOf = p => p.querySelector('.gps-panel-hdr');
    const boxOf = p => { const h = hdrOf(p); return h ? h.parentNode : p; };       // what is folded: the element the title bar is in
    const allPanels = () => groups().reduce((a, g) => a.concat(panelsOf(g)), []);
    const foldedKeys = () => allPanels().filter(p => boxOf(p).classList.contains('po-folded')).map(keyOf);
    function setFold(p, on, quiet) {
      const h = hdrOf(p), b = h && h.querySelector(':scope > .po-fold-btn');
      boxOf(p).classList.toggle('po-folded', on);
      if (b) { b.textContent = on ? '\u25B8' : '\u25BE'; b.setAttribute('aria-expanded', on ? 'false' : 'true'); b.title = on ? 'Open this panel' : 'Fold this panel to its title bar'; }
      if (quiet) return;
      try { const v = foldedKeys().join(','); if (v) localStorage.setItem(o.fold, v); else localStorage.removeItem(o.fold); } catch (_) { /* a convenience only */ }
      // an opened panel's charts and maps were sized while it was hidden: let them measure again
      if (!on) requestAnimationFrame(() => { try { window.dispatchEvent(new Event('resize')); } catch (_) { /* old browser */ } });
      try { root.dispatchEvent(new CustomEvent('po-fold', { bubbles: true, detail: { key: keyOf(p), folded: on } })); } catch (_) { /* old browser */ }
    }
    function changed() {
      const now = ser(layout()), same = now === ser(DEF) && !(o.fold && foldedKeys().length);
      lsSet(now === ser(DEF) ? '' : now);
      if (o.reset) o.reset.style.display = same || (o.visible && !o.visible()) ? 'none' : '';
    }
    { const saved = lsGet(); if (saved) apply(saved.split('|').map(g => g ? g.split(',') : [])); changed(); }
    const resetAll = () => { apply(DEF); if (o.fold) allPanels().forEach(p => { if (boxOf(p).classList.contains('po-folded')) setFold(p, false); }); changed(); };
    if (o.reset) o.reset.addEventListener('click', resetAll);
    if (cols) groups().forEach(g => g.classList.add('po-grp'));
    groups().forEach(g => panelsOf(g).forEach(p => {
      const h = hdrOf(p);
      if (h) { h.classList.add('po-hdr'); if (!h.title) h.title = o.touch ? 'Hold and drag to move this panel' : 'Drag to move this panel'; }
    }));
    if (o.touch) root.classList.add('po-touch');
    if (o.fold) {
      let was = [];
      try { was = (localStorage.getItem(o.fold) || '').split(',').filter(Boolean); } catch (_) { /* a convenience only */ }
      allPanels().forEach(p => {
        const h = hdrOf(p);
        if (!h) return;
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'po-fold-btn';
        b.addEventListener('click', e => { e.stopPropagation(); setFold(p, !boxOf(p).classList.contains('po-folded')); changed(); });
        h.classList.add('po-hdr-f'); h.appendChild(b);
        setFold(p, was.includes(keyOf(p)), true);
      });
      changed();
    }

    let d = null;                                              // the drag: { el, hdr, id, x, y, px, py, from, live, last, raf }
    function under(x, y) {
      const e = document.elementFromPoint(x, y);
      if (!e || !root.contains(e)) return {};
      const p = e.closest(PSEL), gs = groups();
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
      // only towards the edge the pointer has been moved to: a panel taken by a title bar that lies at the upper edge
      // (a phone, after a jump to that panel) must not start the view scrolling under a finger that rests
      const v = d.py < r.top + m && d.py < d.y - 10 ? -Math.min(18, (r.top + m - d.py) / 3)
        : d.py > r.bottom - m && d.py > d.y + 10 ? Math.min(18, (d.py - r.bottom + m) / 3) : 0;
      if (v) { const s0 = scroller.scrollTop; scroller.scrollTop += v; if (scroller.scrollTop !== s0) move(); }
      d.raf = requestAnimationFrame(autoScroll);
    }
    function end(keep) {
      if (!d) return;
      const q = d; d = null;
      cancelAnimationFrame(q.raf); clearTimeout(q.tmr);
      try { q.hdr.releasePointerCapture(q.id); } catch (_) { /* already released */ }
      q.el.classList.remove('po-drag'); root.classList.remove('po-dragging');
      if (!q.live) return;
      if (!keep) apply(q.from);
      if (q.touch) compact(false, q.el);
      changed();
    }
    root.addEventListener('pointerdown', e => {
      const touch = e.pointerType === 'touch';
      if (e.button !== 0 || (touch && !o.touch) || d) return;
      const hdr = e.target.closest('.gps-panel-hdr'), el = hdr && hdr.closest(PSEL);
      if (!el || !isPanel(el) || !groups().includes(el.parentNode)) return;
      if (e.target.closest('button, select, input, textarea, a, label, [role="button"], [tabindex]')) return;
      d = { el, hdr, id: e.pointerId, x: e.clientX, y: e.clientY, px: e.clientX, py: e.clientY, from: layout(), live: false, last: null, raf: 0, touch, tmr: 0 };
      // a finger: the panel is taken when it has rested on the title bar for a moment; a swipe before that scrolls
      if (touch) d.tmr = setTimeout(() => { if (d && d.touch && !d.live) { lift(); try { navigator.vibrate && navigator.vibrate(12); } catch (_) { /* no vibration */ } } }, 420);
    });
    // With a finger the panels are tall against the screen: while one is carried, all show their title bars only, so
    // that the whole list is within reach; the carried bar stays under the finger.  They open again when it is put down.
    function compact(on, el) {
      const h = hdrOf(el), y0 = h ? h.getBoundingClientRect().top : 0;
      allPanels().forEach(p => boxOf(p).classList.toggle('po-tmpfold', on));
      if (h) scroller.scrollTop += h.getBoundingClientRect().top - y0;
      if (!on) {
        requestAnimationFrame(() => { try { window.dispatchEvent(new Event('resize')); } catch (_) { /* old browser */ } });
        try { root.dispatchEvent(new CustomEvent('po-fold', { bubbles: true, detail: { key: keyOf(el), folded: false } })); } catch (_) { /* old browser */ }
      }
    }
    function lift() {
      d.live = true;
      if (d.touch) compact(true, d.el);
      try { d.hdr.setPointerCapture(d.id); } catch (_) { /* the drag works without it */ }
      d.el.classList.add('po-drag'); root.classList.add('po-dragging');
      try { window.getSelection().removeAllRanges(); } catch (_) { /* nothing selected */ }
      d.raf = requestAnimationFrame(autoScroll);
    }
    // while a panel is held by a finger the page must not scroll under it (and no long-press menu)
    window.addEventListener('touchmove', e => { if (d && d.touch && d.live && e.cancelable) e.preventDefault(); }, { passive: false });
    root.addEventListener('contextmenu', e => { if (d && d.touch) e.preventDefault(); });
    window.addEventListener('pointermove', e => {
      if (!d || e.pointerId !== d.id) return;
      d.px = e.clientX; d.py = e.clientY;
      if (!d.live) {
        if (d.touch) { if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8) end(false); return; }   // a swipe: the page scrolls
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;        // a click, not a drag
        lift();
      }
      e.preventDefault();
      move();
    });
    window.addEventListener('pointerup', e => { if (d && e.pointerId === d.id) end(true); });
    window.addEventListener('pointercancel', e => { if (d && e.pointerId === d.id) end(false); });
    window.addEventListener('keydown', e => { if (d && d.live && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(false); } }, true);
    window.addEventListener('blur', () => end(false));
    return { refresh: changed, layout, reset: resetAll, folded: foldedKeys };
  }
  window.PanelOrder = { attach };
})();
