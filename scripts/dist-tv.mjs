// Builds the Windows installer of the TV client.
// If the previous build folder is locked (antivirus, Explorer, a leftover process), it is not
// fatal: the build goes into a fresh folder and the installer is copied to apps/tv-client/release.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tv = path.join(root, 'apps', 'tv-client');
const rel = path.join(tv, 'release');
const run = (cmd) => execSync(cmd, { cwd: tv, stdio: 'inherit', shell: true });

run('npm run build');

// clean up previous builds; whatever is locked stays
fs.mkdirSync(rel, { recursive: true });
for (const d of fs.readdirSync(rel)) {
  if (!/^(win-unpacked|build-\d+)$/.test(d)) continue;
  try {
    fs.rmSync(path.join(rel, d), { recursive: true, force: true, maxRetries: 4, retryDelay: 500 });
  } catch {
    // locked
  }
}

let out = 'release';
if (fs.existsSync(path.join(rel, 'win-unpacked'))) {
  out = `release/build-${Date.now()}`;
  console.warn(`\n[!] Старая папка release\\win-unpacked занята другим процессом — собираем в ${out.replace('/', '\\')}.`);
  console.warn('    Её удалит следующая сборка, когда файл освободится (или после перезагрузки).\n');
}
run(`npx electron-builder --win --x64 --publish never --config.directories.output=${out}`);

if (out !== 'release') {
  const dir = path.join(tv, out);
  for (const f of fs.readdirSync(dir)) {
    if (/\.exe$|\.blockmap$|^latest\.yml$/.test(f)) fs.copyFileSync(path.join(dir, f), path.join(rel, f));
  }
}
console.log('\nУстановщик: apps\\tv-client\\release');
