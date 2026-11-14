import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const git = process.env.SAMEWAVE_GIT || 'git';
const tracked = execFileSync(git, ['ls-files', '-z']).toString().split('\0').filter(Boolean);
if (!tracked.length) throw new Error('No staged files to audit');
const forbiddenFile = /(^|\/)(backups|dist|node_modules|\.private|\.env(?:\..*)?)($|\/)|update-installed-copy|samewave-preferences|\.(key|pem|log)$/i;
const suspicious = [
  /\b[a-f0-9]{32,64}\b/i,
  /\b(?:ghp_|gho_|github_pat_|sk-proj-)[A-Za-z0-9_]{16,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\/Users\/[^/\s]+\//,
  /[A-Z]:\\Users\\[^\\\s]+\\/i
];
function audit(name, data) {
  if (/\.(png|jpg|jpeg|webp)$/i.test(name)) return;
  const text = data.toString('utf8');
  if (suspicious.some(pattern => pattern.test(text))) throw new Error(`Potential credential or private path in ${name}; values are intentionally hidden`);
}
for (const name of tracked) {
  if (forbiddenFile.test(name)) throw new Error(`Private/generated file staged: ${name}`);
  if (/\.(png|jpg|jpeg|webp)$/i.test(name)) continue;
  audit(name, execFileSync(git, ['show', `:${name}`], {maxBuffer: 16 * 1024 * 1024}));
}
const packaged = 'dist/同频-Chrome插件';
let assets = 0;
if (fs.existsSync(packaged)) {
  for (const name of fs.readdirSync(packaged, {recursive: true})) {
    const file = path.join(packaged, name);
    if (!fs.statSync(file).isFile()) continue;
    if (forbiddenFile.test(name)) throw new Error(`Private file in release: ${name}`);
    audit(name, fs.readFileSync(file)); assets++;
  }
}
console.log(`Public audit passed: ${tracked.length} staged files, ${assets} release files. No credential patterns or private home paths found.`);
