import { build } from 'esbuild';

const external = ['electron', 'better-sqlite3', 'webtorrent', 'socket.io-client', 'qrcode'];

await build({
  entryPoints: ['electron/main.ts', 'electron/preload.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external,
  outdir: 'dist-electron',
  sourcemap: false,
  logLevel: 'info',
});
