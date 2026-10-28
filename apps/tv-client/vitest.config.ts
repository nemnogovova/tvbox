import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@tvbox/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) },
  },
  test: { include: ['electron/core/core.test.ts', 'electron/core/catalog.test.ts', 'electron/core/indexer.test.ts', 'electron/core/previews.test.ts', 'electron/core/torrents.test.ts'], environment: 'node' },
});
