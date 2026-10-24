import path from 'node:path';
import fs from 'node:fs';
import express, { type Express } from 'express';
import type { BackendConfig } from './config';

export function createApp(config: BackendConfig): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, name: 'tvbox-backend', ts: Date.now() });
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      googleClientId: config.googleClientId,
      oauthConfigured: Boolean(config.googleClientId),
    });
  });

  const staticDir = path.resolve(config.staticDir);
  if (fs.existsSync(staticDir)) {
    app.use(express.static(staticDir, { maxAge: '1h', index: 'index.html' }));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  return app;
}
