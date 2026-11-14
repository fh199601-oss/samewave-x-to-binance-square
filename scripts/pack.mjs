import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
execFileSync(process.execPath, ['scripts/build-root.mjs'], {stdio: 'inherit'});
execFileSync(process.execPath, ['scripts/check.mjs'], {stdio: 'inherit'});
fs.mkdirSync('dist', {recursive: true});
const {version} = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const folder = '同频-Chrome插件';
const stage = `dist/${folder}`;
// Only this build directory is replaced. Browser profile data never enters the archive.
fs.rmSync(stage, {recursive: true, force: true});
fs.mkdirSync(stage, {recursive: true});
fs.cpSync('extension', `${stage}/extension`, {recursive: true, filter: file => !file.endsWith('.DS_Store')});
for (const file of ['manifest.json', 'README.md', 'PRIVACY.md', 'LICENSE']) fs.copyFileSync(file, `${stage}/${file}`);
// ASCII archive names remain intact when GitHub hosts release assets.
const archive = `samewave-chrome-v${version}.zip`;
const output = `dist/${archive}`;
fs.rmSync(output, {force: true});
execFileSync('/usr/bin/zip', ['-qr', archive, folder, '-x', '*/.DS_Store'], {cwd: 'dist'});
// macOS zip omits the UTF-8 filename flag. Set it on both headers so Windows
// extracts the Chinese outer folder name without depending on a local code page.
const zip = fs.readFileSync(output);
const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
if (end < 0) throw new Error('Invalid ZIP');
let cursor = zip.readUInt32LE(end + 16);
for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
  if (zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP entry');
  const nameLength = zip.readUInt16LE(cursor + 28);
  const nameBytes = zip.subarray(cursor + 46, cursor + 46 + nameLength);
  if (!Buffer.from(nameBytes.toString('utf8')).equals(nameBytes)) throw new Error('ZIP filename is not UTF-8');
  const local = zip.readUInt32LE(cursor + 42);
  zip.writeUInt16LE(zip.readUInt16LE(cursor + 8) | 0x0800, cursor + 8);
  zip.writeUInt16LE(zip.readUInt16LE(local + 6) | 0x0800, local + 6);
  cursor += 46 + nameLength + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
}
fs.writeFileSync(output, zip);
execFileSync('/usr/bin/unzip', ['-tqq', output]);
console.log(output);
