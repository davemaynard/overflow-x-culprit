// Generates icons/icon{16,32,48,128}.png from an inline SVG, rendered in
// headless Chrome via Playwright. Motif: a viewport frame with a red bar
// bursting past its right edge.
//
//   npm run icons

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'icons');
mkdirSync(outDir, { recursive: true });

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect x="2" y="2" width="124" height="124" rx="26" fill="#1b1f27"/>
  <rect x="20" y="26" width="66" height="76" rx="10"
        fill="none" stroke="#8a93a6" stroke-width="8"/>
  <rect x="32" y="53" width="58" height="22" rx="11" fill="#e53935"/>
  <path d="M86 42 L118 64 L86 86 Z" fill="#e53935"/>
</svg>`;

const browser = await chromium
  .launch({ channel: 'chrome' })
  .catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
await page.setContent(
  `<style>html,body{margin:0;background:transparent}svg{display:block;width:100%;height:100%}</style>${svg}`);

for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  const file = path.join(outDir, `icon${size}.png`);
  await page.screenshot({ path: file, omitBackground: true });
  console.log('wrote', file);
}
await browser.close();
