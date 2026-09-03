/**
 * Overflow-X Culprit - finds the elements causing a horizontal page scrollbar.
 *
 * Runs in two contexts:
 *  - Extension content script: background.js injects this file on every
 *    toolbar click. The first injection installs and activates the scanner;
 *    later injections hit the guard below and toggle it.
 *  - Test harness (test/run.mjs): injected as a plain script tag. All
 *    chrome.* wiring is guarded, and the harness drives the API on
 *    window.__overflowXCulprit directly.
 *
 * Measurement notes (verified empirically in Chrome; see test/run.mjs):
 *  - The viewport edge is document.documentElement.clientWidth, which
 *    excludes a classic vertical scrollbar. window.innerWidth includes it,
 *    which is exactly how naive scripts miss the width:100vw culprit.
 *  - CSS transforms count toward the page's scrollable overflow, and
 *    getBoundingClientRect() is transform-inclusive, so the two agree: a box
 *    translated past the right edge creates scroll; a box whose transform
 *    pulls it back inside does not.
 *  - Overflow past the LEFT edge creates no scroll in LTR pages, so only
 *    right edges are measured.
 */
(() => {
  'use strict';

  if (window.__overflowXCulprit) {
    window.__overflowXCulprit.toggle();
    return;
  }

  const OVERLAY_ID = 'overflow-x-culprit-overlay';
  const CLIPPING = new Set(['hidden', 'clip', 'auto', 'scroll', 'overlay']);
  const EDGE_SLACK = 1;  // px past the viewport before a box counts, absorbs subpixel rounding
  const DEDUP_SLACK = 2; // px within which a parent's edge is "the same overflow" as its child's

  // ------------------------------------------------------------- detection

  function pageInfo() {
    const scroller = document.scrollingElement || document.documentElement;
    const clientWidth = document.documentElement.clientWidth;
    const scrollWidth = scroller.scrollWidth;
    return {
      clientWidth,
      scrollWidth,
      overflowPx: scrollWidth - clientWidth,
      overflows: scrollWidth > clientWidth,
    };
  }

  /**
   * An element's right edge in document coordinates. Starts from the border
   * box (getBoundingClientRect, transform-inclusive). When overflow is
   * visible, raw content can stick out with no child element to blame -
   * white-space:nowrap text is the classic case - so scrollWidth extends the
   * edge. (scrollWidth is untransformed layout width; close enough, since
   * text overflow under a transform is rare.)
   */
  function rightEdge(el, style) {
    const rect = el.getBoundingClientRect();
    let right = rect.right;
    if (style.overflowX === 'visible' && el.scrollWidth > el.clientWidth) {
      right = Math.max(right, rect.left + el.clientLeft + el.scrollWidth);
    }
    return right + window.scrollX;
  }

  /**
   * Does this element clip (or scroll) its children horizontally? If so, the
   * children can cause container scroll but never page scroll. One special
   * case: overflow on <body> propagates to the viewport (it *is* the page
   * scrollbar) unless <html> already has a non-visible overflow - and a
   * propagated value leaves body itself behaving as overflow: visible.
   */
  function clipsChildren(el, style) {
    if (el === document.body &&
        getComputedStyle(document.documentElement).overflowX === 'visible') {
      return false;
    }
    return CLIPPING.has(style.overflowX);
  }

  /** Depth-first walk of the composed (light + open shadow) tree. */
  function collect(el, clipped, limit, out) {
    if (el.id === OVERLAY_ID) return;
    const style = getComputedStyle(el);
    if (style.display === 'none') return;
    // Fixed boxes ride the viewport; neither they nor their contents can
    // extend the page's scrollable area.
    if (style.position === 'fixed') return;

    if (!clipped) {
      const right = rightEdge(el, style);
      if (right > limit) out.push({ el, right });
    }

    // A clipping container can itself be a culprit (judged above), but
    // whatever pokes out of it is the container's problem, not the page's.
    const childClipped = clipped || clipsChildren(el, style);
    for (const child of el.children) collect(child, childClipped, limit, out);
    if (el.shadowRoot) {
      for (const child of el.shadowRoot.children) {
        collect(child, childClipped, limit, out);
      }
    }
  }

  function composedParent(el) {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  }

  function composedContains(ancestor, el) {
    for (let n = composedParent(el); n; n = composedParent(n)) {
      if (n === ancestor) return true;
    }
    return false;
  }

  /**
   * Keep only root culprits. An ancestor's scrollable overflow includes its
   * children's, so the whole chain above a culprit gets flagged too; when a
   * flagged descendant reaches (within rounding) the same right edge, the
   * descendant is the real producer and the ancestor is dropped.
   */
  function dedupe(found) {
    return found.filter((a) =>
      !found.some((b) =>
        b !== a &&
        b.right >= a.right - DEDUP_SLACK &&
        composedContains(a.el, b.el)
      )
    );
  }

  /**
   * Scan the page. Returns { clientWidth, scrollWidth, overflowPx, overflows,
   * clippedAtViewport, culprits: [{ el, right, overflowPx }] } with culprits
   * sorted worst-first.
   */
  function scan() {
    const info = pageInfo();
    const htmlOX = getComputedStyle(document.documentElement).overflowX;
    const bodyOX = document.body ? getComputedStyle(document.body).overflowX : 'visible';
    // The viewport's own overflow-x: html's value unless visible, else body's
    // (the standard propagation). hidden/clip here means the page cannot
    // scroll horizontally no matter what overflows.
    const viewportOX = htmlOX !== 'visible' ? htmlOX : bodyOX;
    const clippedAtViewport = viewportOX === 'hidden' || viewportOX === 'clip';

    let culprits = [];
    if (info.overflows && !clippedAtViewport) {
      const limit = info.clientWidth + EDGE_SLACK;
      const found = [];
      for (const child of document.documentElement.children) {
        collect(child, false, limit, found);
      }
      culprits = dedupe(found)
        .map(({ el, right }) => ({
          el,
          right,
          overflowPx: Math.round(right - info.clientWidth),
        }))
        .sort((a, b) => b.overflowPx - a.overflowPx);
    }
    return { ...info, clippedAtViewport, culprits };
  }

  // -------------------------------------------------------------------- UI

  const inExtension = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
  let active = false;
  let outlined = []; // [{ el, outline, outlineOffset }] previous inline values
  let resizeTimer = 0;

  // One element's own label: tag, plus whatever distinguishes it. An id is
  // unique so nothing more is needed; classes usually narrow it enough; a bare
  // tag needs its position among like-named siblings or it reads as "div".
  function step(el) {
    if (el.id) return el.localName + '#' + el.id;

    let label = el.localName;
    if (el.classList.length) label += '.' + [...el.classList].slice(0, 2).join('.');

    const parent = el.parentElement;
    if (!parent) return label;
    const twins = [...parent.children].filter(
      (sibling) => sibling.localName === el.localName && sibling.className === el.className,
    );
    if (twins.length > 1) label += ':nth-of-type(' + (twins.indexOf(el) + 1) + ')';
    return label;
  }

  // "div" tells you nothing on a page full of them, so walk up until the label
  // is either anchored to an id or carries enough ancestry to find by eye.
  // Inside a shadow root an element has no parentElement, so climbing stops
  // dead and every culprit in a component reads as "div". Cross to the host and
  // mark the hop, which is also the honest answer: that is where it lives.
  function climb(el) {
    if (el.parentElement) return {node: el.parentElement, shadow: false};
    const root = el.getRootNode();
    if (root instanceof ShadowRoot && root.host) return {node: root.host, shadow: true};
    return null;
  }

  function describe(el) {
    const parts = [step(el)];
    let up = climb(el);
    while (up && up.node !== document.body && up.node !== document.documentElement && parts.length < 3) {
      parts.unshift(step(up.node) + (up.shadow ? ' ::shadow' : ''));
      if (up.node.id) break;
      up = climb(up.node);
    }

    // Ancestors only earn their place when the element cannot stand alone.
    while (parts.length > 1 && parts.join(' > ').length > 48) parts.shift();
    const text = parts.join(' > ');
    return text.length > 48 ? '…' + text.slice(-47) : text;
  }

  function applyOutlines(culprits) {
    for (const { el } of culprits) {
      outlined.push({
        el,
        outline: el.style.getPropertyValue('outline'),
        outlineOffset: el.style.getPropertyValue('outline-offset'),
      });
      // outline, never border: border shifts layout and could change the
      // very overflow being measured.
      el.style.setProperty('outline', '3px solid #e53935', 'important');
      el.style.setProperty('outline-offset', '-3px', 'important');
    }
  }

  function clearOutlines() {
    for (const { el, outline, outlineOffset } of outlined) {
      if (outline) el.style.setProperty('outline', outline);
      else el.style.removeProperty('outline');
      if (outlineOffset) el.style.setProperty('outline-offset', outlineOffset);
      else el.style.removeProperty('outline-offset');
    }
    outlined = [];
  }

  function renderOverlay(result) {
    removeOverlay();
    const box = document.createElement('div');
    box.id = OVERLAY_ID;
    box.style.cssText = [
      'position: fixed', 'right: 12px', 'bottom: 12px', 'z-index: 2147483647',
      'max-width: 340px', 'max-height: 45vh', 'overflow: auto',
      'background: rgba(24, 28, 36, 0.95)', 'color: #e8eaf0',
      'font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
      'padding: 10px 14px', 'border-radius: 8px',
      'box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4)',
    ].join(';');

    const line = (text, color) => {
      const div = document.createElement('div');
      div.textContent = text;
      if (color) div.style.color = color;
      box.appendChild(div);
    };

    line('overflow-x culprit', '#8a93a6');
    if (!result.overflows) {
      line('No horizontal overflow. ' +
        `scrollWidth ${result.scrollWidth} = clientWidth ${result.clientWidth}.`);
    } else if (result.clippedAtViewport) {
      line(`Content is ${result.overflowPx}px too wide, but overflow-x on ` +
        'html/body clips it - no page scrollbar to debug.');
    } else if (result.culprits.length === 0) {
      line(`Page scrolls ${result.overflowPx}px but no unclipped culprit ` +
        'found (subpixel or exotic case - see console).');
    } else {
      line(`Page scrolls ${result.overflowPx}px past the ` +
        `${result.clientWidth}px viewport:`);
      for (const c of result.culprits) {
        line(`${describe(c.el)}  +${c.overflowPx}px`, '#ff8a80');
      }
    }
    document.documentElement.appendChild(box);
  }

  function removeOverlay() {
    document.getElementById(OVERLAY_ID)?.remove();
  }

  function updateBadge(count) {
    if (!inExtension) return;
    chrome.runtime
      .sendMessage({ type: 'overflow-x-culprit:badge', count })
      .catch(() => {});
  }

  function logResults(result) {
    if (!result.overflows) {
      console.log('overflow-x-culprit: no horizontal overflow on this page.');
      return;
    }
    if (result.culprits.length === 0) {
      console.log('overflow-x-culprit: overflow exists but is clipped; no page-scroll culprits.');
      return;
    }
    console.table(result.culprits.map((c) => ({
      element: describe(c.el),
      'overflow (px)': c.overflowPx,
    })));
    for (const c of result.culprits) {
      console.log(`+${c.overflowPx}px`, c.el); // clickable handles
    }
  }

  function rescan() {
    clearOutlines();
    const result = scan();
    applyOutlines(result.culprits);
    renderOverlay(result);
    updateBadge(result.culprits.length);
    logResults(result);
    return result;
  }

  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (active) rescan(); }, 150);
  }

  function activate() {
    if (active) return;
    active = true;
    window.addEventListener('resize', onResize);
    rescan();
  }

  function deactivate() {
    if (!active) return;
    active = false;
    window.removeEventListener('resize', onResize);
    clearTimeout(resizeTimer);
    clearOutlines();
    removeOverlay();
    updateBadge(null);
    console.log('overflow-x-culprit: cleared.');
  }

  window.__overflowXCulprit = {
    get active() { return active; },
    scan,
    activate,
    deactivate,
    toggle() { (active ? deactivate : activate)(); },
  };

  if (inExtension) window.__overflowXCulprit.toggle();
})();
