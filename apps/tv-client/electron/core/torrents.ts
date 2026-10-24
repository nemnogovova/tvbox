import type { Readable } from 'node:stream';
import WebTorrent from 'webtorrent';
import type { TorrentInfo, TorrentStatus } from '@tvbox/shared';

// Minimal structural types for the WebTorrent objects we consume.
interface WtFile {
  name: string;
  path: string;
  length: number;
  downloaded: number;
  progress: number;
  select: () => void;
  createReadStream: (opts?: { start?: number; end?: number }) => Readable;
}

interface WtTorrent {
  infoHash: string;
  name: string;
  magnetURI: string;
  path: string;
  length: number;
  downloaded: number;
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  numPeers: number;
  files: WtFile[];
  ready: boolean;
  paused: boolean;
  select: (start: number, end: number, priority: number, notify: () => void) => void;
  destroy: () => void;
  on: (event: string, cb: (...args: never[]) => void) => void;
}

type Client = {
  add: (input: string | Buffer, opts: { path?: string }, cb: (t: WtTorrent) => void) => WtTorrent;
  get: (infoHash: string) => WtTorrent | null;
  remove: (infoHash: string, cb?: (err?: Error) => void) => void;
  on: (event: string, cb: (...args: never[]) => void) => void;
};

export interface TorrentHandle {
  id: string;
  infoHash: string;
  name: string;
  magnet: string;
  fileCount: number;
}

export class TorrentEngine {
  private client: Client;
  private torrents = new Map<string, WtTorrent>();
  private listeners = new Map<string, Set<(info: TorrentInfo) => void>>();

  constructor(private readonly opts: { uploadLimit?: number; downloadDir?: string } = {}) {
    // WebTorrent's constructor accepts config; cast through unknown.
    this.client = new WebTorrent({ uploadLimit: this.opts.uploadLimit ?? -1 }) as unknown as Client;
  }

  add(magnet: string): TorrentHandle {
    return this.addInput(magnet, magnet);
  }

  addBuffer(buffer: Buffer, name: string): TorrentHandle {
    return this.addInput(buffer, `buffer:${name}`);
  }

  private addInput(input: string | Buffer, id: string): TorrentHandle {
    const torrent = this.client.add(
      input,
      { path: this.opts.downloadDir },
      (t) => {
        this.torrents.set(id, t);
        this.attach(t, id);
        t.on('done', () => {
          this.emit(id);
          // Leech-only: stop seeding once the download completes.
          setTimeout(() => this.destroyTorrent(id), 5000);
        });
      },
    );
    this.torrents.set(id, torrent);
    this.attach(torrent, id);
    const handle: TorrentHandle = {
      id,
      infoHash: torrent.infoHash,
      name: torrent.name,
      magnet: typeof input === 'string' ? input : '',
      fileCount: torrent.files.length,
    };
    return handle;
  }

  private attach(t: WtTorrent, id: string): void {
    const events = ['download', 'upload', 'wire', 'done', 'error', 'ready'];
    for (const e of events) {
      t.on(e, () => this.emit(id));
    }
  }

  remove(id: string): void {
    this.destroyTorrent(id);
  }

  private destroyTorrent(id: string): void {
    const t = this.torrents.get(id);
    if (!t) return;
    this.torrents.delete(id);
    try {
      t.destroy();
    } catch {
      // already destroyed
    }
    this.emit(id);
  }

  list(): TorrentInfo[] {
    return Array.from(this.torrents.entries()).map(([id, t]) => this.toInfo(id, t));
  }

  get(id: string): TorrentInfo | undefined {
    const t = this.torrents.get(id);
    return t ? this.toInfo(id, t) : undefined;
  }

  watch(id: string, fileIndex = 0): WtFile | undefined {
    const t = this.torrents.get(id);
    if (!t) return undefined;
    const file = t.files[fileIndex] ?? t.files[0];
    if (file) file.select();
    return file;
  }

  createReadStream(id: string, fileIndex: number, start?: number, end?: number): Readable | undefined {
    const t = this.torrents.get(id);
    if (!t) return undefined;
    const file = t.files[fileIndex] ?? t.files[0];
    if (!file) return undefined;
    return file.createReadStream(start !== undefined && end !== undefined ? { start, end } : undefined);
  }

  fileLength(id: string, fileIndex: number): number {
    const t = this.torrents.get(id);
    const file = t?.files[fileIndex] ?? t?.files[0];
    return file?.length ?? 0;
  }

  getFilePath(id: string, fileIndex: number): string | undefined {
    const t = this.torrents.get(id);
    const file = t?.files[fileIndex] ?? t?.files[0];
    if (!t || !file) return undefined;
    return `${t.path}/${file.path}`;
  }

  onUpdate(id: string, cb: (info: TorrentInfo) => void): void {
    if (!this.listeners.has(id)) this.listeners.set(id, new Set());
    this.listeners.get(id)!.add(cb);
  }

  private emit(id: string): void {
    const info = this.get(id);
    if (!info) return;
    const set = this.listeners.get(id);
    if (set) for (const cb of set) cb(info);
  }

  private toInfo(id: string, t: WtTorrent): TorrentInfo {
    let status: TorrentStatus = 'downloading';
    if (t.paused) status = 'paused';
    else if (t.progress >= 1) status = 'done';
    return {
      id,
      infoHash: t.infoHash,
      name: t.name,
      magnet: t.magnetURI,
      progress: t.progress,
      downloadSpeed: t.downloadSpeed,
      uploadSpeed: t.uploadSpeed,
      peers: t.numPeers,
      size: t.length,
      downloaded: t.downloaded,
      status,
      files: t.files.map((f, i) => ({
        index: i,
        name: f.name,
        path: f.path,
        length: f.length,
        downloaded: f.downloaded,
        progress: f.progress,
      })),
      addedAt: Date.now(),
    };
  }
}
