import { build } from 'esbuild';

// Native / asset-carrying packages stay external and are shipped in node_modules.
const external = ['electron', 'webtorrent', 'sql.js', 'ffmpeg-static', 'bufferutil', 'utf-8-validate', 'utp-native'];

await build({
  entryPoints: ['electron/main.ts', 'electron/preload.ts', 'electron/youtube-preload.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external,
  outdir: 'dist-electron',
  sourcemap: false,
  logLevel: 'info',
});
