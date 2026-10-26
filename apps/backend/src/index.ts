import http from 'node:http';
import type { Server } from 'socket.io';
import { loadConfig, loadDotEnv, type BackendConfig } from './config';
import { JsonStore } from './store';
import { AuthService, createGoogleVerifier, type GoogleVerifier } from './auth';
import { createApp } from './app';
import { createHub, type Hub } from './hub';

export interface TvboxServer {
  config: BackendConfig;
  httpServer: http.Server;
  io: Server;
  hub: Hub;
  store: JsonStore;
  auth: AuthService;
  listen: (port?: number) => Promise<number>;
  close: () => Promise<void>;
}

export function createServer(
  env: NodeJS.ProcessEnv = process.env,
  opts: { verifyGoogle?: GoogleVerifier; tvTimeoutMs?: number } = {},
): TvboxServer {
  const config = loadConfig(env);
  const store = new JsonStore(config.dataDir);
  const auth = new AuthService(config, store, opts.verifyGoogle ?? createGoogleVerifier(config.googleClientId));
  let hub: Hub | null = null;
  const app = createApp(config, auth, () => hub);
  const httpServer = http.createServer(app);
  hub = createHub(httpServer, { config, store, auth, tvTimeoutMs: opts.tvTimeoutMs });
  const io = hub.io;

  return {
    config,
    httpServer,
    io,
    hub,
    store,
    auth,
    listen: (port = config.port) =>
      new Promise<number>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, () => {
          httpServer.removeListener('error', reject);
          const addr = httpServer.address();
          resolve(typeof addr === 'object' && addr ? addr.port : port);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        io.close(() => resolve());
      }),
  };
}

if (require.main === module) {
  loadDotEnv();
  const server = createServer();
  server
    .listen()
    .then((port) => {
      const c = server.config;
      console.log(`[tvbox] listening on :${port} (${c.publicUrl})`);
      console.log(`[tvbox] owner=${c.ownerEmail || c.ownerUsername || '(first account)'} google=${c.googleClientId ? 'on' : 'OFF'} turn=${c.turnSecret ? 'on' : 'off'}`);
    })
    .catch((err) => {
      console.error('[tvbox] failed to start', err);
      process.exit(1);
    });
  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
