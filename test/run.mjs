// End-to-end test for the detection engine, run against real Chrome.
//
//   npm test
//
// Loads test/fixture.html, injects content.js exactly as the extension would,
// and asserts the culprit set, the applied outlines, the overlay, resize
// rescans, and the clean no-overflow / clipped-at-viewport paths.

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const contentScript = path.join(here, '..', 'content.js');
const fixture = 'file://' + path.join(here, 'fixture.html');

let passed = 0;
let failed = 0;
function assert(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}
function assertSetEqual(name, actual, expected) {
  const a = [...actual].sort().join(', ');
  const e = [...expected].sort().join(', ');
  assert(name, a === e, `expected [${e}] got [${a}]`);
}

// Runs in the page: activate and report a serializable snapshot.
function snapshot() {
  const api = window.__overflowXCulprit;
  api.activate();
  const res = api.scan();
  const id = (el) => el.getAttribute('data-test') ||
    el.localName + (el.id ? '#' + el.id : '');
  return {
    active: api.active,
    overflows: res.overflows,
    clippedAtViewport: res.clippedAtViewport,
    clientWidth: res.clientWidth,
    scrollWidth: res.scrollWidth,
    culprits: res.culprits.map((c) => ({
      id: id(c.el),
      overflowPx: c.overflowPx,
      outline: getComputedStyle(c.el).outlineWidth + ' ' +
        getComputedStyle(c.el).outlineStyle + ' ' +
        getComputedStyle(c.el).outlineColor,
    })),
    overlayText: document.getElementById('overflow-x-culprit-overlay')?.textContent ?? null,
  };
}

const browser = await chromium
  .launch({ channel: 'chrome' })
  .catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });

// ---------------------------------------------------------------- fixture
await page.goto(fixture);
const scrollbarPx = await page.evaluate(
  () => window.innerWidth - document.documentElement.clientWidth);
console.log(`\nFixture scan (vertical scrollbar takes ${scrollbarPx}px of layout)`);

await page.addScriptTag({ path: contentScript });
const snap = await page.evaluate(snapshot);

const expected = new Set(
  ['neg-margin', 'nowrap', 'big-image', 'abs-right', 'transform-out', 'shadow-wide']);
// width:100vw only exceeds clientWidth where the scrollbar takes layout
// space; with overlay scrollbars (macOS) it must NOT be flagged.
if (scrollbarPx > 0) expected.add('vw100');

assert('page-level overflow detected', snap.overflows,
  `scrollWidth ${snap.scrollWidth} vs clientWidth ${snap.clientWidth}`);
assertSetEqual('exact culprit set (deduped roots only)',
  snap.culprits.map((c) => c.id), expected);
for (const neg of ['clipped-child', 'fixed-wide', 'transform-back']) {
  assert(`negative case not flagged: ${neg}`,
    !snap.culprits.some((c) => c.id === neg));
}
if (scrollbarPx === 0) {
  assert('vw100 not flagged with overlay scrollbars (100vw == clientWidth)',
    !snap.culprits.some((c) => c.id === 'vw100'));
}
for (const c of snap.culprits) {
  assert(`outline applied to ${c.id}`,
    c.outline === '3px solid rgb(229, 57, 53)', `got "${c.outline}"`);
}
assert('every culprit overflows by a positive amount',
  snap.culprits.every((c) => c.overflowPx > 0));
assert('overlay lists every culprit',
  snap.culprits.every((c) => snap.overlayText.includes(`+${c.overflowPx}px`)));

// A label like "div" identifies nothing on a page full of divs, and most
// elements carry neither id nor class. Every line must name something findable:
// an id, classes, a position among siblings, or an ancestor path.
const labels = await page.evaluate(() =>
  [...document.getElementById('overflow-x-culprit-overlay').children]
    .map((line) => line.textContent)
    .filter((text) => /\+\d+px$/.test(text))
    .map((text) => text.replace(/\s+\+\d+px$/, '')));
assert('overlay labels one line per culprit', labels.length === snap.culprits.length,
  `${labels.length} labels for ${snap.culprits.length} culprits`);
for (const label of labels) {
  assert(`"${label}" is findable, not a bare tag`,
    /[#.:>]/.test(label), 'no id, class, position or ancestor to go on');
}
// Two culprits sharing a label send you to the wrong element half the time.
assert('every label is distinct', new Set(labels).size === labels.length,
  labels.join(' | '));

// ----------------------------------------------------------------- resize
// Widen the viewport: fixed-width culprits (1600px image, 2400px shadow div)
// stop overflowing; the debounced rescan must clear their stale outlines.
await page.setViewportSize({ width: 2600, height: 600 });
await page.waitForTimeout(400);
const wide = await page.evaluate(() => {
  const api = window.__overflowXCulprit;
  const res = api.scan();
  const img = document.querySelector('[data-test="big-image"]');
  return {
    ids: res.culprits.map((c) => c.el.getAttribute('data-test')),
    overlayText: document.getElementById('overflow-x-culprit-overlay')?.textContent ?? '',
    imageOutline: getComputedStyle(img).outlineStyle,
  };
});
assertSetEqual('rescan after resize finds the still-overflowing set',
  wide.ids, ['neg-margin', 'nowrap', 'abs-right', 'transform-out']);
assert('stale outline cleared from big-image after resize',
  wide.imageOutline === 'none', `got "${wide.imageOutline}"`);
assert('overlay updated after resize', !wide.overlayText.includes('big-image'));

// ------------------------------------------------------------- deactivate
const after = await page.evaluate(() => {
  const api = window.__overflowXCulprit;
  api.deactivate();
  const el = document.querySelector('[data-test="neg-margin"]');
  return {
    active: api.active,
    outline: getComputedStyle(el).outlineStyle,
    overlayGone: !document.getElementById('overflow-x-culprit-overlay'),
  };
});
assert('deactivate restores outlines', after.outline === 'none');
assert('deactivate removes overlay', after.overlayGone);
assert('deactivate flips active off', !after.active);

// ------------------------------------------------------------ clean page
console.log('\nClean page (no overflow)');
await page.setViewportSize({ width: 1000, height: 600 });
await page.setContent(
  '<body style="margin:0"><p>nothing to see here</p></body>');
await page.addScriptTag({ path: contentScript });
const clean = await page.evaluate(snapshot);
assert('no overflow reported', !clean.overflows);
assert('zero culprits', clean.culprits.length === 0);
assert('overlay says no overflow',
  clean.overlayText.includes('No horizontal overflow'));

// -------------------------------------- overflow-x:hidden band-aid on body
console.log('\nPage with body { overflow-x: hidden } band-aid');
await page.setContent(
  '<body style="margin:0; overflow-x:hidden">' +
  '<div style="width:3000px; height:20px"></div></body>');
await page.addScriptTag({ path: contentScript });
const clipped = await page.evaluate(snapshot);
assert('viewport-level clip detected', clipped.clippedAtViewport);
assert('no culprits reported when the page cannot scroll',
  clipped.culprits.length === 0);

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
