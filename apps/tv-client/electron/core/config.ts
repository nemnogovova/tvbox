import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface TvClientConfig {
  backendUrl: string;
  deviceToken: string;
  tmdbApiKey: string;
  mediaDirs: string[];
  streamPort: number;
  dataDir: string;
}

export interface TvClientSettings {
  backendUrl: string;
  deviceToken: string;
  tmdbApiKey: string;
  mediaDirs: string[];
}

const defaultDataDir = path.join(os.homedir(), '.tvbox');

export function getDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATA_DIR || defaultDataDir;
}

export function loadTvConfig(env: NodeJS.ProcessEnv = process.env): TvClientConfig {
  const dataDir = getDataDir(env);
  const file = readConfigFile(dataDir);

  const envMediaDirs = (env.MEDIA_DIRS || '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);

  return {
    backendUrl: (file.backendUrl || env.BACKEND_URL || 'http://localhost:3000').replace(/\/$/, ''),
    deviceToken: file.deviceToken || env.DEVICE_TOKEN || '',
    tmdbApiKey: file.tmdbApiKey || env.TMDB_API_KEY || '',
    mediaDirs: file.mediaDirs && file.mediaDirs.length > 0 ? file.mediaDirs : envMediaDirs,
    streamPort: Number(env.STREAM_PORT || 8765),
    dataDir,
  };
}

export function isConfigured(cfg: TvClientConfig): boolean {
  return Boolean(cfg.backendUrl && cfg.deviceToken);
}

export function saveConfigFile(dataDir: string, settings: TvClientSettings): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const payload = {
    backendUrl: settings.backendUrl.replace(/\/$/, ''),
    deviceToken: settings.deviceToken.trim(),
    tmdbApiKey: settings.tmdbApiKey.trim(),
    mediaDirs: settings.mediaDirs.map((d) => d.trim()).filter(Boolean),
  };
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(payload, null, 2), 'utf-8');
}

function readConfigFile(dataDir: string): Partial<TvClientSettings> {
  try {
    const file = path.join(dataDir, 'config.json');
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<TvClientSettings>;
    return {
      backendUrl: typeof parsed.backendUrl === 'string' ? parsed.backendUrl : undefined,
      deviceToken: typeof parsed.deviceToken === 'string' ? parsed.deviceToken : undefined,
      tmdbApiKey: typeof parsed.tmdbApiKey === 'string' ? parsed.tmdbApiKey : undefined,
      mediaDirs: Array.isArray(parsed.mediaDirs) ? parsed.mediaDirs : undefined,
    };
  } catch {
    return {};
  }
}
