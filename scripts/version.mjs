// App version shared by the TV client, the remote (web + APK) and the release manifest.
//   node scripts/version.mjs          → print the current version
//   node scripts/version.mjs bump     → 3.0.4 → 3.0.5
//   node scripts/version.mjs 3.1.0    → set an explicit version
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['package.json', 'apps/tv-client/package.json', 'apps/remote-client/package.json'].map((f) => path.join(root, f));

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf-8'));
const current = read(files[1]).version;
const arg = process.argv[2];

let next = current;
if (arg === 'bump' || arg === 'patch') {
  const [a, b, c] = current.split('.').map((x) => parseInt(x, 10) || 0);
  next = `${a}.${b}.${c + 1}`;
} else if (arg === 'minor') {
  const [a, b] = current.split('.').map((x) => parseInt(x, 10) || 0);
  next = `${a}.${b + 1}.0`;
} else if (arg && /^\d+\.\d+\.\d+$/.test(arg)) {
  next = arg;
} else if (arg) {
  console.error(`Unknown argument: ${arg}`);
  process.exit(1);
}

if (next !== current) {
  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf-8');
    fs.writeFileSync(f, raw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`));
  }
  console.log(`TVBox version: ${current} → ${next}`);
} else {
  console.log(next);
}
