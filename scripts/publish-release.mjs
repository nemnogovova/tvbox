// Uploads the freshly built apps to the TVBox server, so that
//  - the web remote shows "Download for Android / Windows" buttons,
//  - TV clients and the Android app see the update and install it on request.
//
//   node scripts/publish-release.mjs [--server https://tv.example.com]
//
// Needs the release token: .release-token in the repo root (deploy.ps1 saves it)
// or the RELEASE_TOKEN environment variable (same value as RELEASE_TOKEN in the server's .env).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argServer = process.argv.indexOf('--server');
const server = (argServer > 0 ? process.argv[argServer + 1] : process.env.TVBOX_SERVER || 'https://tv.nemnogovova.com').replace(/\/$/, '');
const tokenFile = path.join(root, '.release-token');
const token = (process.env.RELEASE_TOKEN || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf-8') : '')).trim();
const version = JSON.parse(fs.readFileSync(path.join(root, 'apps', 'tv-client', 'package.json'), 'utf-8')).version;

if (!token) {
  console.error('Нет токена публикации: запустите deploy.ps1 (он сохранит .release-token) или задайте RELEASE_TOKEN.');
  process.exit(1);
}

function newest(dir, re) {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => re.test(f))
    .map((f) => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files[0]?.f || null;
}

const targets = [
  { platform: 'windows', file: newest(path.join(root, 'apps', 'tv-client', 'release'), new RegExp(`^TVBox-Setup-${version.replace(/\./g, '\\.')}\\.exe$`)) },
  { platform: 'android', file: newest(path.join(root, 'release'), new RegExp(`^TVBox-Remote-${version.replace(/\./g, '\\.')}\\.apk$`)) },
];

let failed = false;
for (const { platform, file } of targets) {
  if (!file) {
    console.log(`- ${platform}: сборка ${version} не найдена, пропускаю`);
    continue;
  }
  const name = path.basename(file);
  const size = fs.statSync(file).size;
  process.stdout.write(`- ${platform}: загружаю ${name} (${(size / 1024 / 1024).toFixed(1)} МБ)… `);
  try {
    const res = await fetch(`${server}/api/releases/${platform}?version=${encodeURIComponent(version)}&file=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: fs.readFileSync(file),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
    console.log('готово');
  } catch (e) {
    failed = true;
    console.log(`ошибка: ${e.message}`);
  }
}
console.log(failed ? '\nПубликация завершилась с ошибками' : `\nОпубликовано: ${server} (версия ${version})`);
process.exit(failed ? 1 : 0);
