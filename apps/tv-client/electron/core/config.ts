import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SERVER_URL, type TvSettings } from '@tvbox/shared';

export interface TvConfig extends TvSettings {
  serverUrl: string;
  /** Session token issued by the backend after QR pairing */
  token: string;
  tvName: string;
}

export function dataDir(): string {
  return process.env.TVBOX_DATA_DIR || path.join(os.homedir(), '.tvbox');
}

function defaults(): TvConfig {
  return {
    serverUrl: DEFAULT_SERVER_URL,
    token: '',
    tvName: os.hostname() || 'Телевизор',
    tmdbApiKey: '',
    mediaDirs: [],
    downloadDir: path.join(os.homedir(), 'Videos', 'TVBox'),
    autostart: true,
    language: 'ru-RU',
    indexer: null,
  };
}

export class ConfigStore {
  private readonly file: string;
  value: TvConfig;

  constructor(dir = dataDir()) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'config.json');
    this.value = this.read();
  }

  private read(): TvConfig {
    const d = defaults();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Partial<TvConfig> & { backendUrl?: string };
      return {
        ...d,
        ...Object.fromEntries(Object.entries(raw).filter(([k, v]) => k in d && v !== undefined && v !== null)),
        serverUrl: String(raw.serverUrl || raw.backendUrl || d.serverUrl).replace(/\/$/, ''),
        mediaDirs: Array.isArray(raw.mediaDirs) ? raw.mediaDirs.filter((x) => typeof x === 'string') : d.mediaDirs,
      } as TvConfig;
    } catch {
      return d;
    }
  }

  update(patch: Partial<TvConfig>): TvConfig {
    this.value = { ...this.value, ...patch };
    if (patch.serverUrl) this.value.serverUrl = patch.serverUrl.trim().replace(/\/$/, '');
    if (patch.mediaDirs) this.value.mediaDirs = Array.from(new Set(patch.mediaDirs.map((d) => d.trim()).filter(Boolean)));
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.value, null, 2), 'utf-8');
    fs.renameSync(tmp, this.file);
    return this.value;
  }

  settings(): TvSettings {
    const { tmdbApiKey, mediaDirs, downloadDir, autostart, language, indexer } = this.value;
    return { tmdbApiKey, mediaDirs, downloadDir, autostart, language, indexer: indexer || null };
  }
}
