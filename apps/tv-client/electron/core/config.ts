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

const defaultDataDir = path.join(os.homedir(), '.tvbox');

export function loadTvConfig(env: NodeJS.ProcessEnv = process.env): TvClientConfig {
  const mediaDirs = (env.MEDIA_DIRS || '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);

  return {
    backendUrl: (env.BACKEND_URL || 'http://localhost:3000').replace(/\/$/, ''),
    deviceToken: env.DEVICE_TOKEN || '',
    tmdbApiKey: env.TMDB_API_KEY || '',
    mediaDirs,
    streamPort: Number(env.STREAM_PORT || 8765),
    dataDir: env.DATA_DIR || defaultDataDir,
  };
}
