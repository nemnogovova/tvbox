import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface BackendConfig {
  port: number;
  publicUrl: string;
  ownerEmail: string;
  /** Login of the owner for installations without Google sign-in (optional) */
  ownerUsername: string;
  googleClientId: string;
  /** Token that allows build scripts to publish releases */
  releaseToken: string;
  sessionSecret: string;
  deviceToken: string;
  turnSecret: string;
  turnHost: string;
  dataDir: string;
  staticDir: string;
}

/** Minimal .env loader (only for local development; Docker passes env directly). */
export function loadDotEnv(file = path.resolve(process.cwd(), '.env')): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

function readOrCreateSecret(dataDir: string): string {
  const file = path.join(dataDir, 'session.secret');
  try {
    const s = fs.readFileSync(file, 'utf-8').trim();
    if (s.length >= 32) return s;
  } catch {
    // create below
  }
  const s = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const ownerEmail = (env.OWNER_EMAIL || '').trim().toLowerCase();
  const dataDir = path.resolve(env.DATA_DIR || path.resolve(__dirname, '..', 'data'));
  const port = Number(env.PORT || 3000);
  return {
    port,
    publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    ownerEmail,
    ownerUsername: (env.OWNER_USERNAME || '').trim().toLowerCase(),
    releaseToken: (env.RELEASE_TOKEN || '').trim(),
    googleClientId: (env.GOOGLE_CLIENT_ID || '').trim(),
    sessionSecret: (env.SESSION_SECRET || '').trim() || readOrCreateSecret(dataDir),
    deviceToken: (env.DEVICE_TOKEN || '').trim(),
    turnSecret: (env.TURN_SECRET || '').trim(),
    turnHost: (env.TURN_HOST || '').trim(),
    dataDir,
    staticDir: path.resolve(env.STATIC_DIR || path.resolve(__dirname, '..', '..', 'remote-client', 'dist')),
  };
}
