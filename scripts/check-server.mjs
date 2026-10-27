// Warns when the TVBox server is older than the apps that were just built
// (new remotes would send commands the old server silently ignores).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = (process.env.TVBOX_SERVER || 'https://tv.nemnogovova.com').replace(/\/$/, '');
const src = fs.readFileSync(path.join(root, 'packages', 'shared', 'src', 'index.ts'), 'utf-8');
const want = Number(/PROTOCOL_VERSION = (\d+)/.exec(src)?.[1] || 0);
try {
  const res = await fetch(`${server}/api/config`, { signal: AbortSignal.timeout(10000) });
  const have = Number((await res.json()).protocol) || 1;
  if (have < want) {
    console.log('\n**************************************************************');
    console.log(' СЕРВЕР TVBOX УСТАРЕЛ: каталог, игры, тачпад и YouTube');
    console.log(' не заработают, пока его не обновить. Запустите deploy.ps1');
    console.log('**************************************************************\n');
    process.exitCode = 2;
  } else console.log(`Сервер ${server} актуален (протокол ${have}).`);
} catch (e) {
  console.log(`Не удалось проверить сервер ${server}: ${e.message}`);
}
