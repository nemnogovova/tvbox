import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

export interface BackendConfig {
  port: number;
  ownerEmail: string;
  deviceToken: string;
  googleClientId: string;
  dataDir: string;
  staticDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const ownerEmail = (env.OWNER_EMAIL || '').trim().toLowerCase();
  const deviceToken = (env.DEVICE_TOKEN || '').trim();
  if (!ownerEmail) {
    throw new Error('OWNER_EMAIL is required');
  }
  if (!deviceToken) {
    throw new Error('DEVICE_TOKEN is required');
  }
  return {
    port: Number(env.PORT || 3000),
    ownerEmail,
    deviceToken,
    googleClientId: (env.GOOGLE_CLIENT_ID || '').trim(),
    dataDir: env.DATA_DIR || path.resolve(__dirname, '..', 'data'),
    staticDir: env.STATIC_DIR || path.resolve(__dirname, '..', '..', 'remote-client', 'dist'),
  };
}
