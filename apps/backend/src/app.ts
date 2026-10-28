import path from 'node:path';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import express, { type Express, type Request, type Response } from 'express';
import { Events, PROTOCOL_VERSION, type ControlCommand, type ReleaseInfo, type ReleasePlatform, type ReleasesManifest, type User, type InviteInfo } from '@tvbox/shared';
import type { BackendConfig } from './config';
import type { AuthService } from './auth';
import type { Hub } from './hub';
import type { JsonStore } from './store';
import { turnCredentials } from './tokens';

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export function iceServersFor(config: BackendConfig, userKey: string): IceServer[] {
  const servers: IceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  if (config.turnSecret && config.turnHost) {
    const cred = turnCredentials(config.turnSecret, userKey);
    servers.push({ urls: `stun:${config.turnHost}:3478` });
    servers.push({
      urls: [`turn:${config.turnHost}:3478?transport=udp`, `turn:${config.turnHost}:3478?transport=tcp`],
      ...cred,
    });
  }
  return servers;
}

function bearer(req: Request): string {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

/** Very small in-memory rate limiter for login / registration. */
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) {
      hits.set(key, { n: 1, reset: now + windowMs });
      if (hits.size > 5000) hits.clear();
      return true;
    }
    h.n++;
    return h.n <= max;
  };
}

const PLATFORMS: ReleasePlatform[] = ['windows', 'android'];

export function createApp(config: BackendConfig, auth: AuthService, store: JsonStore, getHub: () => Hub | null): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // The Android app (https://localhost in a WebView) and the TV client call the API cross-origin.
  // Auth uses bearer tokens (no cookies), so a wildcard origin is safe.
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  const json = express.json({ limit: '64kb' });
  const authLimit = limiter(12, 5 * 60 * 1000);

  const inviteOf = (req: Request): string | undefined => (typeof req.body?.invite === 'string' ? req.body.invite : undefined);

  const requireUser = (req: Request, res: Response): User | null => {
    const out = auth.verifySession(bearer(req));
    if (!out.ok || out.isTv) {
      res.status(401).json({ ok: false, error: out.ok ? 'not_a_user' : out.error });
      return null;
    }
    return out.user;
  };

  // ------------------------------------------------------------------ info
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, name: 'tvbox-backend', version: 3, ts: Date.now() });
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      googleClientId: config.googleClientId,
      oauthConfigured: Boolean(config.googleClientId),
      passwordAuth: true,
      registration: store.registration,
      publicUrl: config.publicUrl,
      turn: Boolean(config.turnSecret && config.turnHost),
      protocol: PROTOCOL_VERSION,
    });
  });

  // ------------------------------------------------------------------ auth
  app.post('/api/auth/google', json, async (req, res) => {
    const credential = String(req.body?.credential || '');
    if (!credential) return res.status(400).json({ ok: false, error: 'missing_credential' });
    const out = await auth.signInWithGoogle(credential, inviteOf(req));
    // a new account may be waiting for approval: owners see the request right away
    getHub()?.broadcastAdmin();
    if (!out.ok) return res.status(out.error === 'invalid_google_token' ? 401 : 403).json(out);
    return res.json({ ok: true, token: out.token, user: out.user });
  });

  app.post('/api/auth/register', json, (req, res) => {
    if (!authLimit(`r:${req.ip}`)) return res.status(429).json({ ok: false, error: 'too_many_attempts' });
    const out = auth.register(String(req.body?.username || ''), String(req.body?.password || ''), req.body?.name ? String(req.body.name) : undefined, inviteOf(req));
    if (out.ok || out.pending) getHub()?.broadcastAdmin();
    if (!out.ok) return res.status(out.error === 'pending_approval' ? 202 : 400).json(out);
    return res.json({ ok: true, token: out.token, user: out.user });
  });

  app.post('/api/auth/login', json, (req, res) => {
    if (!authLimit(`l:${req.ip}`)) return res.status(429).json({ ok: false, error: 'too_many_attempts' });
    const out = auth.login(String(req.body?.username || ''), String(req.body?.password || ''), inviteOf(req));
    if (!out.ok) return res.status(out.error === 'pending_approval' ? 403 : 401).json(out);
    return res.json({ ok: true, token: out.token, user: out.user });
  });

  /** What an invitation link leads to (shown before signing in). */
  app.get('/api/invite/:code', (req, res) => {
    if (!authLimit(`i:${req.ip}`)) return res.status(429).json({ ok: false, error: 'too_many_attempts' });
    const home = store.findHomeByInvite(req.params.code);
    if (!home) return res.status(404).json({ ok: false, error: 'invite_invalid' });
    const owner = home.members.find((m) => m.role === 'owner');
    const data: InviteInfo = { homeName: home.name, ownerName: (owner && store.getAccount(owner.accountId)?.name) || '' };
    res.json({ ok: true, data });
  });

  app.get('/api/auth/me', (req, res) => {
    const out = auth.verifySession(bearer(req));
    if (!out.ok) return res.status(401).json(out);
    return res.json({ ok: true, user: out.user, isTv: out.isTv });
  });

  // ------------------------------------------------------------------ own account
  app.get('/api/account', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    res.json({ ok: true, data: auth.accountInfo(user.id) });
  });

  app.post('/api/account/password', json, (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!authLimit(`p:${user.id}`)) return res.status(429).json({ ok: false, error: 'too_many_attempts' });
    const out = auth.setPassword(user.id, req.body?.username, String(req.body?.password || ''), req.body?.currentPassword);
    res.status(out.ok ? 200 : 400).json({ ...out, data: auth.accountInfo(user.id) });
  });

  app.post('/api/account/google', json, async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const out = await auth.linkGoogle(user.id, String(req.body?.credential || ''));
    res.status(out.ok ? 200 : 400).json({ ...out, data: auth.accountInfo(user.id) });
  });

  app.delete('/api/account/google', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const out = auth.unlinkGoogle(user.id);
    res.status(out.ok ? 200 : 400).json({ ...out, data: auth.accountInfo(user.id) });
  });

  // ------------------------------------------------------------------ media / control (Android background service)
  app.get('/api/player', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const hub = getHub();
    res.json({ ok: true, data: hub?.player(user.homeId), presence: hub?.presence(user.homeId) });
  });

  app.post('/api/control', json, async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const hub = getHub();
    if (!hub) return res.status(503).json({ ok: false, error: 'starting' });
    const cmd = req.body as ControlCommand;
    if (!cmd || typeof cmd.type !== 'string') return res.status(400).json({ ok: false, error: 'bad_command' });
    res.json(await hub.relayToTv(user, Events.CONTROL, cmd));
  });

  app.get('/api/ice', (req, res) => {
    const out = auth.verifySession(bearer(req));
    if (!out.ok) return res.status(401).json(out);
    return res.json({ ok: true, iceServers: iceServersFor(config, out.user.id) });
  });

  // ------------------------------------------------------------------ releases (app downloads + updates)
  const releasesDir = path.join(config.dataDir, 'releases');
  const manifestFile = path.join(releasesDir, 'latest.json');
  const readManifest = (): ReleasesManifest => {
    try {
      return JSON.parse(fs.readFileSync(manifestFile, 'utf-8')) as ReleasesManifest;
    } catch {
      return {};
    }
  };

  app.get('/api/releases', (_req, res) => {
    res.json({ ok: true, data: readManifest() });
  });

  app.post('/api/releases/:platform', async (req, res) => {
    const platform = req.params.platform as ReleasePlatform;
    if (!PLATFORMS.includes(platform)) return res.status(400).json({ ok: false, error: 'bad_platform' });
    const token = bearer(req);
    const owner = auth.verifySession(token);
    const allowed = (config.releaseToken && token === config.releaseToken) || (owner.ok && !!owner.user.admin);
    if (!allowed) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const version = String(req.query.version || '').trim();
    const file = path.basename(String(req.query.file || '')).replace(/[^\w.\-]+/g, '_');
    if (!/^\d+\.\d+\.\d+/.test(version) || !file) return res.status(400).json({ ok: false, error: 'bad_meta' });
    const dir = path.join(releasesDir, platform);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${file}.uploading`);
    try {
      await pipeline(req, fs.createWriteStream(tmp));
      const size = fs.statSync(tmp).size;
      if (size < 1024) throw new Error('too small');
      fs.renameSync(tmp, path.join(dir, file));
      const manifest = readManifest();
      const info: ReleaseInfo = { version, file, size, url: `/downloads/${platform}/${encodeURIComponent(file)}`, publishedAt: Date.now() };
      manifest[platform] = info;
      fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
      // keep only the current build
      for (const f of fs.readdirSync(dir)) if (f !== file && !f.startsWith('.')) fs.rmSync(path.join(dir, f), { force: true });
      res.json({ ok: true, data: info });
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  app.get('/download/:platform', (req, res) => {
    const info = readManifest()[req.params.platform as ReleasePlatform];
    if (!info) return res.status(404).type('text/plain').send('Сборка ещё не опубликована');
    res.redirect(302, info.url);
  });

  app.use(
    '/downloads',
    express.static(releasesDir, {
      index: false,
      dotfiles: 'ignore',
      setHeaders: (res, filePath) => {
        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
        res.setHeader('Cache-Control', 'no-cache');
        if (filePath.endsWith('.apk')) res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      },
    }),
  );

  app.use('/api', (_req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

  // ------------------------------------------------------------------ remote web app
  const staticDir = config.staticDir;
  const indexFile = path.join(staticDir, 'index.html');
  app.use(
    express.static(staticDir, {
      index: false,
      setHeaders: (res, filePath) => {
        if (/[\\/]assets[\\/]/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );
  // SPA fallback (also serves /link/:code pairing pages)
  app.get('*', (_req, res) => {
    if (!fs.existsSync(indexFile)) {
      res.status(503).type('text/plain').send('Remote client is not built yet');
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexFile);
  });

  return app;
}
