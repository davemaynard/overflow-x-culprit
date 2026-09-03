// Captures docs/screenshot.png: the demo page with the scanner active, outlines
// applied, and the culprit panel showing. Shot from docs/ rather than from the
// test fixture, so the README shows the tool working on a page that looks like
// a page — which is what a reader is trying to picture.
//
//   npm run build:docs && npm run screenshot

import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = {'.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png'};

const server = createServer(async (request, response) => {
  try {
    const file = path.join(root, 'docs', new URL(request.url, 'http://localhost').pathname);
    // Read before replying: a 404 cannot be sent once the 200 headers have gone.
    const body = await readFile(file);
    response.writeHead(200, {'content-type': mime[path.extname(file)] ?? 'text/plain'});
    response.end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
});
await new Promise((resolve) => server.listen(0, resolve));

const browser = await chromium.launch({channel: 'chrome'}).catch(() => chromium.launch());
try {
  const page = await browser.newPage({viewport: {width: 1200, height: 820}, deviceScaleFactor: 2});
  await page.goto(`http://localhost:${server.address().port}/index.html`);
  await page.evaluate(() => document.fonts.ready);
  // Drive the page's own button, so the control's label and hint match the result shown.
  await page.click('#run');
  // Start at the first culprit, just under the sticky bar, so the panel and three
  // outlined culprits are in frame together without a stray line of the intro.
  await page.evaluate(() => {
    const bar = document.querySelector('.controls').getBoundingClientRect().height;
    const first = document.querySelector('section').getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, first - bar - 24);
  });
  await page.waitForTimeout(300);

  const file = path.join(root, 'docs/screenshot.png');
  await page.screenshot({path: file});
  console.log('wrote', path.relative(root, file));
} finally {
  await browser.close();
  server.close();
}
