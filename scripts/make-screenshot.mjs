// Captures docs/screenshot.png: the test fixture with the scanner active,
// outlines applied, and the culprit overlay showing.
//
//   npm run screenshot

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
mkdirSync(path.join(here, '..', 'docs'), { recursive: true });

const browser = await chromium
  .launch({ channel: 'chrome' })
  .catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
await page.goto('file://' + path.join(here, '..', 'test', 'fixture.html'));
await page.addScriptTag({ path: path.join(here, '..', 'content.js') });
await page.evaluate(() => window.__overflowXCulprit.activate());
await page.waitForTimeout(200);
const file = path.join(here, '..', 'docs', 'screenshot.png');
await page.screenshot({ path: file });
console.log('wrote', file);
await browser.close();
