import http from 'node:http';
import { loadConfig } from './config';
import { JsonStore } from './store';
import { createGoogleAuthenticator } from './auth';
import { createApp } from './app';
import { createSocketHub } from './socket';

export interface TvboxServer {
  config: ReturnType<typeof loadConfig>;
  httpServer: http.Server;
  io: ReturnType<typeof createSocketHub>;
  store: JsonStore;
  listen: (port?: number) => Promise<number>;
  close: () => Promise<void>;
}

export function createServer(env: NodeJS.ProcessEnv = process.env): TvboxServer {
  const config = loadConfig(env);
  const store = new JsonStore(config.dataDir);
  const authenticate = createGoogleAuthenticator(
    config.googleClientId,
    config.ownerEmail,
    (email) => store.isGuest(email),
  );

  const app = createApp(config);
  const httpServer = http.createServer(app);
  const io = createSocketHub(httpServer, { config, store, authenticate });

  return {
    config,
    httpServer,
    io,
    store,
    listen: (port = config.port) =>
      new Promise<number>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, () => {
          httpServer.removeListener('error', reject);
          resolve(port);
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        io.close(() => {
          httpServer.close((err) => (err ? reject(err) : resolve()));
        });
      }),
  };
}

if (require.main === module) {
  const server = createServer();
  server
    .listen()
    .then((port) => {
      console.log(`[tvbox-backend] listening on :${port}`);
      console.log(`[tvbox-backend] owner=${server.config.ownerEmail}`);
      console.log(`[tvbox-backend] static=${server.config.staticDir}`);
    })
    .catch((err) => {
      console.error('[tvbox-backend] failed to start', err);
      process.exit(1);
    });
}
