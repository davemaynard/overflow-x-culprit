// Copies the content script beside the demo page so GitHub Pages can serve a
// working demo at https://davemaynard.github.io/overflow-x-culprit. The page
// drives the same window.__overflowXCulprit API the toolbar button drives.
// Run by `npm run build:docs`; CI checks the copy is in sync with content.js.
import {copyFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

await copyFile(join(root, 'content.js'), join(root, 'docs/overflow-x-culprit.js'));
await writeFile(join(root, 'docs/.nojekyll'), '');

console.log('docs/overflow-x-culprit.js written from content.js');
