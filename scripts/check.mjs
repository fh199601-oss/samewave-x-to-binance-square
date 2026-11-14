import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const manifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Must use MV3');
const entries = [manifest.background.service_worker, manifest.options_page, manifest.action.default_popup, ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap(x => x.js)];
for (const file of entries) if (!fs.existsSync(path.join('extension', file))) throw new Error(`Missing ${file}`);
const root = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
if (root.version !== manifest.version) throw new Error('Root manifest version is stale; run node scripts/build-root.mjs');
const rootEntries = [root.background.service_worker, root.options_page, root.action.default_popup, ...Object.values(root.icons), ...Object.values(root.action.default_icon), ...root.content_scripts.flatMap(x => x.js)];
for (const file of rootEntries) if (!fs.existsSync(file)) throw new Error(`Missing root asset ${file}`);
if (!rootEntries.every(file => file.startsWith('extension/'))) throw new Error('Root manifest must reference the same source tree');
const files = fs.readdirSync('extension', {recursive: true}).filter(x => x.endsWith('.js'));
for (const file of files) execFileSync(process.execPath, ['--check', path.join('extension', file)]);
for (const file of fs.readdirSync('extension', {recursive: true}).filter(x => /\.(js|json|html|css)$/.test(x))) {
  const data = fs.readFileSync(path.join('extension', file), 'utf8');
  if (/[a-f0-9]{32,64}/i.test(data)) throw new Error(`Possible embedded secret in ${file}`);
  if (/eval\(|new Function\(/.test(data)) throw new Error(`Dynamic evaluation in ${file}`);
}
console.log(`Manifest and ${files.length} JavaScript files checked; no embedded key detected.`);
