// Packs everything the VPS needs into deploy/tvbox-server.tgz (pre-built — the 1 GB server never runs Vite/tsc).
// Usage: npm run build:shared && npm run build:backend && npm run build:remote && node scripts/make-bundle.mjs
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'deploy', '.bundle');
const tgz = path.join(root, 'deploy', 'tvbox-server.tgz');

const need = ['packages/shared/dist/index.js', 'apps/backend/dist/index.js', 'apps/remote-client/dist/index.html'];
for (const f of need) {
  if (!fs.existsSync(path.join(root, f))) {
    console.error(`Missing ${f} — run the builds first (npm run build:shared && npm run build:backend && npm run build:remote)`);
    process.exit(1);
  }
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'server'), { recursive: true });
const cp = (from, to) => fs.cpSync(path.join(root, from), path.join(out, to), { recursive: true });

for (const f of ['Dockerfile', '.dockerignore', 'docker-compose.yml', 'Caddyfile', 'server-setup.sh']) cp(`deploy/${f}`, f);
cp('apps/backend/dist', 'server/dist');
cp('apps/remote-client/dist', 'server/public');
cp('packages/shared/dist', 'server/shared/dist');
fs.writeFileSync(
  path.join(out, 'server', 'shared', 'package.json'),
  JSON.stringify({ name: '@tvbox/shared', version: '2.0.0', main: 'dist/index.js', types: 'dist/index.d.ts' }, null, 2),
);
const be = JSON.parse(fs.readFileSync(path.join(root, 'apps/backend/package.json'), 'utf-8'));
const deps = { ...be.dependencies, '@tvbox/shared': 'file:./shared' };
fs.writeFileSync(
  path.join(out, 'server', 'package.json'),
  JSON.stringify({ name: 'tvbox-server', version: be.version, private: true, main: 'dist/index.js', dependencies: deps }, null, 2),
);
// normalise line endings of the shell script (it may come from a Windows checkout)
const sh = path.join(out, 'server-setup.sh');
fs.writeFileSync(sh, fs.readFileSync(sh, 'utf-8').replace(/\r\n/g, '\n'));

fs.rmSync(tgz, { force: true });
execSync(`tar -czf "${tgz}" -C "${out}" .`, { stdio: 'inherit' });
fs.rmSync(out, { recursive: true, force: true });
console.log(`Bundle ready: ${tgz} (${Math.round(fs.statSync(tgz).size / 1024)} KB)`);
