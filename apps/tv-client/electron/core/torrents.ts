import { EventEmitter } from 'node:events';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { mediaKindOfFile, type TorrentFileInfo, type TorrentInfo } from '@tvbox/shared';
import type { TvDatabase, TorrentRow } from './db';

// Structural types for the bits of WebTorrent 1.x we use.
interface WtFile {
  name: string;
  path: string;
  length: number;
  /** byte offset of the file inside the torrent */
  offset: number;
  downloaded: number;
  progress: number;
  done: boolean;
  select: (priority?: number) => void;
  deselect: () => void;
  createReadStream: (opts?: { start?: number; end?: number }) => Readable;
}

interface WtTorrent extends EventEmitter {
  infoHash: string;
  name: string;
  magnetURI: string;
  torrentFile?: Buffer;
  path: string;
  length: number;
  downloaded: number;
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  numPeers: number;
  timeRemaining: number;
  files: WtFile[];
  pieceLength: number;
  bitfield?: { get: (i: number) => boolean };
  ready: boolean;
  done: boolean;
  destroyed: boolean;
  destroy: (opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void) => void;
}

interface WtClient extends EventEmitter {
  add: (input: string | Buffer, opts: Record<string, unknown>, cb?: (t: WtTorrent) => void) => WtTorrent;
  destroy: (cb?: () => void) => void;
  throttleUpload: (rate: number) => void;
  throttleDownload?: (rate: number) => void;
}

interface StoredFile {
  index: number;
  name: string;
  path: string;
  length: number;
}

interface Entry {
  id: string;
  row: TorrentRow;
  torrent: WtTorrent | null;
  files: StoredFile[];
  error?: string;
  autoplay: boolean;
  autoplayFired: boolean;
  streams: number;
  pendingDestroy: boolean;
  destroyTimer?: NodeJS.Timeout;
}

export interface CompletedFile {
  torrentId: string;
  fullPath: string;
  name: string;
  length: number;
}

const isPlayable = (name: string) => mediaKindOfFile(name) !== null;

/**
 * WebTorrent wrapper:
 *  - sequential download (stream while downloading)
 *  - leech-only: once a torrent is complete (and nobody is streaming it) it is destroyed,
 *    so the client stops seeding and frees the uplink; files stay on disk.
 */
export class TorrentEngine extends EventEmitter {
  private client: WtClient | null = null;
  private entries = new Map<string, Entry>();
  private updateTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: TvDatabase,
    private readonly getDownloadDir: () => string,
  ) {
    super();
  }

  // ------------------------------------------------------------------ playback comes first
  // WebTorrent runs in the same process that serves the video to the player. A season downloading
  // at full speed can keep that process so busy that the picture freezes every few seconds.
  // While something plays, the download speed is lowered as long as the process lags, and
  // raised again once it is responsive (and fully released when playback stops).
  private playing = false;
  private lag: IntervalHistogram | null = null;
  private lagTimer: NodeJS.Timeout | null = null;
  private limit = -1;
  private calm = 0;

  setPlaybackActive(active: boolean): void {
    if (active === this.playing) return;
    this.playing = active;
    if (active) {
      if (!this.lag) {
        this.lag = monitorEventLoopDelay({ resolution: 20 });
        this.lag.enable();
      }
      this.lag.reset();
      this.calm = 0;
      if (!this.lagTimer) this.lagTimer = setInterval(() => this.adjustForPlayback(), 3000);
    } else {
      if (this.lagTimer) clearInterval(this.lagTimer);
      this.lagTimer = null;
      this.lag?.disable();
      this.lag = null;
      this.setLimit(-1);
    }
  }

  private adjustForPlayback(): void {
    const h = this.lag;
    if (!h || !this.client) return;
    const p99 = h.percentile(99) / 1e6;
    const mean = h.mean / 1e6;
    h.reset();
    const speed = Array.from(this.entries.values()).reduce((sum, e) => sum + (e.torrent && !e.torrent.destroyed ? e.torrent.downloadSpeed : 0), 0);
    const busy = p99 > 150 || mean > 50;
    if (busy && speed > 512 * 1024) {
      this.calm = 0;
      this.setLimit(Math.max(1024 * 1024, Math.round((this.limit > 0 ? Math.min(this.limit, speed) : speed) * 0.5)));
      console.log(`[torrents] playback lags (event loop p99 ${p99.toFixed(0)} ms): downloads limited to ${(this.limit / 1048576).toFixed(1)} MB/s`);
    } else if (!busy && this.limit > 0 && ++this.calm >= 4) {
      this.calm = 0;
      const next = Math.round(this.limit * 1.5);
      this.setLimit(next > 64 * 1024 * 1024 ? -1 : next);
    }
  }

  private setLimit(bytesPerSec: number): void {
    if (bytesPerSec === this.limit) return;
    this.limit = bytesPerSec;
    try {
      this.client?.throttleDownload?.(bytesPerSec);
    } catch {
      // older WebTorrent: no throttling
    }
  }

  private ensureClient(): WtClient {
    if (!this.client) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const WebTorrent = require('webtorrent') as new (opts: Record<string, unknown>) => WtClient;
      this.client = new WebTorrent({ maxConns: 80, dht: true, lsd: true, webSeeds: true });
      this.client.on('error', (err: Error) => console.error('[torrents] client error', err.message));
    }
    return this.client;
  }

  /** Re-add unfinished torrents after a restart. */
  restore(): void {
    for (const row of this.db.listTorrents()) {
      const files = this.db.getJson<StoredFile[]>(`torrent-files:${row.id}`) || [];
      const entry: Entry = { id: row.id, row, torrent: null, files, autoplay: false, autoplayFired: true, streams: 0, pendingDestroy: false };
      this.entries.set(row.id, entry);
      if (!row.done) {
        const input = row.torrentB64 ? Buffer.from(row.torrentB64, 'base64') : row.magnet;
        if (input) this.start(entry, input);
      }
    }
    this.scheduleUpdate();
  }

  add(input: { magnet?: string; buffer?: Buffer }, opts: { autoplay?: boolean } = {}): Promise<string> {
    const source = input.buffer ?? input.magnet;
    if (!source) return Promise.reject(new Error('no_input'));
    return new Promise((resolve, reject) => {
      const client = this.ensureClient();
      let settled = false;
      let torrent: WtTorrent;
      try {
        torrent = client.add(source, { path: this.getDownloadDir() });
      } catch (e) {
        reject(e);
        return;
      }
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      torrent.on('error', () => undefined); // never let an 'error' event crash the app
      torrent.once('error', fail);
      torrent.once('infoHash', () => {
        if (settled) return;
        settled = true;
        torrent.removeListener('error', fail);
        const id = torrent.infoHash;
        const existing = this.entries.get(id);
        if (existing && existing.torrent && existing.torrent !== torrent) {
          // duplicate: WebTorrent destroys the new instance itself
          existing.autoplay = existing.autoplay || !!opts.autoplay;
          existing.autoplayFired = false;
          resolve(id);
          return;
        }
        const row: TorrentRow = existing?.row ?? {
          id,
          name: torrent.name || '',
          magnet: input.magnet ?? null,
          torrentB64: input.buffer ? input.buffer.toString('base64') : null,
          addedAt: Date.now(),
          done: false,
          savePath: this.getDownloadDir(),
        };
        row.done = false;
        this.db.upsertTorrent(row);
        const entry: Entry = existing ?? { id, row, torrent: null, files: [], autoplay: false, autoplayFired: false, streams: 0, pendingDestroy: false };
        entry.autoplay = !!opts.autoplay;
        entry.autoplayFired = false;
        entry.error = undefined;
        this.entries.set(id, entry);
        this.attach(entry, torrent);
        resolve(id);
      });
    });
  }

  private start(entry: Entry, input: string | Buffer): void {
    try {
      const t = this.ensureClient().add(input, { path: entry.row.savePath || this.getDownloadDir() });
      this.attach(entry, t);
    } catch (e) {
      entry.error = (e as Error).message;
    }
  }

  private attach(entry: Entry, t: WtTorrent): void {
    entry.torrent = t;
    const onMeta = () => {
      entry.row.name = t.name;
      entry.row.torrentB64 = t.torrentFile ? Buffer.from(t.torrentFile).toString('base64') : entry.row.torrentB64;
      entry.row.magnet = t.magnetURI || entry.row.magnet;
      entry.files = t.files.map((f, index) => ({ index, name: f.name, path: f.path, length: f.length }));
      this.db.upsertTorrent(entry.row);
      this.db.setJson(`torrent-files:${entry.id}`, entry.files);
      this.scheduleUpdate();
    };
    if (t.ready) onMeta();
    else t.once('ready', onMeta);
    t.on('download', () => {
      this.checkAutoplay(entry);
      this.scheduleUpdate();
    });
    t.on('wire', () => this.scheduleUpdate());
    t.on('error', (err: Error) => {
      entry.error = err.message;
      this.scheduleUpdate();
    });
    t.on('warning', () => undefined);
    t.on('done', () => this.onDone(entry));
    if (t.ready && t.done) this.onDone(entry);
  }

  /** The largest playable file (the movie / episode). */
  mainFileIndex(id: string): number | undefined {
    const e = this.entries.get(id);
    const files = e?.files || [];
    const playable = files.filter((f) => isPlayable(f.name)).sort((a, b) => b.length - a.length);
    return playable[0]?.index;
  }

  private checkAutoplay(entry: Entry): void {
    if (!entry.autoplay || entry.autoplayFired || !entry.torrent?.ready) return;
    const idx = this.mainFileIndex(entry.id);
    if (idx === undefined) return;
    const f = entry.torrent.files[idx];
    const need = Math.min(20 * 1024 * 1024, f.length * 0.03);
    if (f.done || f.downloaded >= need) {
      entry.autoplayFired = true;
      this.emit('autoplay', entry.id, idx);
    }
  }

  private onDone(entry: Entry): void {
    if (entry.row.done) return;
    const t = entry.torrent;
    if (!t) return;
    entry.row.done = true;
    entry.row.name = t.name;
    this.db.upsertTorrent(entry.row);
    const completed: CompletedFile[] = t.files
      .filter((f) => isPlayable(f.name))
      .map((f) => ({ torrentId: entry.id, fullPath: path.join(t.path, f.path), name: f.name, length: f.length }));
    this.emit('done', entry.id, completed);
    this.checkAutoplay(entry);
    this.releaseIfIdle(entry);
    this.scheduleUpdate();
  }

  /** Stop seeding a finished torrent unless it is being streamed right now. */
  private releaseIfIdle(entry: Entry): void {
    if (!entry.row.done || !entry.torrent) return;
    if (entry.streams > 0) {
      entry.pendingDestroy = true;
      return;
    }
    clearTimeout(entry.destroyTimer);
    entry.destroyTimer = setTimeout(() => {
      if (entry.streams > 0 || !entry.torrent) return;
      const t = entry.torrent;
      entry.torrent = null;
      entry.pendingDestroy = false;
      t.destroy({ destroyStore: false });
      this.scheduleUpdate();
    }, 15000);
  }

  remove(id: string, deleteFiles: boolean): string[] {
    const e = this.entries.get(id);
    const removedPaths: string[] = [];
    if (!e) return removedPaths;
    const savePath = e.row.savePath || this.getDownloadDir();
    const files = e.files;
    const finish = () => {
      if (!deleteFiles) return;
      for (const f of files) {
        const full = path.join(savePath, f.path);
        removedPaths.push(full);
        fs.rm(full, { force: true }, () => undefined);
      }
      // remove the torrent's top folder if it became empty
      const top = files[0]?.path.split(/[\\/]/)[0];
      if (top && files.length > 1) fs.rm(path.join(savePath, top), { recursive: true, force: true }, () => undefined);
    };
    if (e.torrent) e.torrent.destroy({ destroyStore: false }, () => finish());
    else finish();
    if (!e.torrent && deleteFiles) {
      for (const f of files) removedPaths.push(path.join(savePath, f.path));
    }
    clearTimeout(e.destroyTimer);
    this.entries.delete(id);
    this.db.deleteTorrent(id);
    this.db.setJson(`torrent-files:${id}`, null);
    this.scheduleUpdate();
    return removedPaths;
  }

  /** Playable files of a torrent (index + name), in torrent order. */
  playableFiles(id: string): { index: number; name: string }[] {
    return (this.entries.get(id)?.files || []).filter((f) => isPlayable(f.name)).map((f) => ({ index: f.index, name: f.name }));
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Absolute path of a torrent file on disk (may still be incomplete). */
  filePath(id: string, index: number): string | null {
    const e = this.entries.get(id);
    const f = e?.files.find((x) => x.index === index);
    if (!e || !f) return null;
    return path.join(e.torrent?.path || e.row.savePath || this.getDownloadDir(), f.path);
  }

  isComplete(id: string, index: number): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    if (e.row.done) return true;
    return !!e.torrent?.files[index]?.done;
  }

  fileName(id: string, index: number): string | null {
    return this.entries.get(id)?.files.find((f) => f.index === index)?.name ?? null;
  }

  fileLength(id: string, index: number): number {
    return this.entries.get(id)?.files.find((f) => f.index === index)?.length ?? 0;
  }

  /**
   * First byte (file-relative, from `start` up to `end`) that is not downloaded and verified yet;
   * end + 1 when the whole range is on disk.
   */
  firstMissingByte(id: string, index: number, start: number, end: number): number {
    const t = this.entries.get(id)?.torrent;
    const f = t?.files[index];
    if (!t || !f || !t.ready) return start;
    if (f.done) return end + 1;
    const bf = t.bitfield;
    const pl = t.pieceLength;
    if (!bf || !(pl > 0)) return start;
    const first = Math.floor((f.offset + start) / pl);
    const last = Math.floor((f.offset + end) / pl);
    for (let p = first; p <= last; p++) {
      if (!bf.get(p)) return Math.max(start, p * pl - f.offset);
    }
    return end + 1;
  }

  /**
   * Read a byte range of a torrent file. What is already downloaded is read straight from the
   * file on disk (fast, no torrent machinery in between); only from the first missing piece on
   * does the read go through the swarm, which waits for those pieces and fetches them first.
   * A "100 %" episode whose last piece (shared with the next episode) is not verified yet used to
   * be read entirely through the swarm stream — and stuttered while the season kept downloading.
   */
  createReadStream(id: string, index: number, start: number, end: number): Readable | null {
    const e = this.entries.get(id);
    const t = e?.torrent;
    const f = t?.files[index];
    if (!e || !t || !f) return null;
    const diskPath = path.join(t.path, f.path);
    const missing = this.firstMissingByte(id, index, start, end);
    if (missing > start && fs.existsSync(diskPath)) {
      const out = new PassThrough({ highWaterMark: 1024 * 1024 });
      const disk = fs.createReadStream(diskPath, { start, end: Math.min(end, missing - 1), highWaterMark: 1024 * 1024 });
      disk.on('error', (err) => out.destroy(err));
      if (missing > end) {
        disk.pipe(out);
        return out;
      }
      // the rest of this file comes first in the swarm while the downloaded part is being read
      f.select(1);
      disk.pipe(out, { end: false });
      disk.on('end', () => {
        if (out.destroyed) return;
        const rest = this.swarmStream(e, f, missing, end);
        rest.on('error', (err) => out.destroy(err));
        out.on('close', () => rest.destroy());
        rest.pipe(out);
      });
      return out;
    }
    return this.swarmStream(e, f, start, end);
  }

  /** Stream a file straight from the swarm (prioritised, sequential). */
  private swarmStream(e: Entry, f: WtFile, start: number, end: number): Readable {
    f.select(1);
    const s = f.createReadStream({ start, end });
    e.streams++;
    clearTimeout(e.destroyTimer);
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      e.streams = Math.max(0, e.streams - 1);
      if (e.pendingDestroy) this.releaseIfIdle(e);
    };
    s.on('close', done);
    s.on('end', done);
    s.on('error', done);
    return s;
  }

  /** Is the torrent still active in the swarm? */
  isLive(id: string): boolean {
    return !!this.entries.get(id)?.torrent;
  }

  list(): TorrentInfo[] {
    return Array.from(this.entries.values())
      .map((e) => this.info(e))
      .sort((a, b) => b.addedAt - a.addedAt);
  }

  private info(e: Entry): TorrentInfo {
    const t = e.torrent;
    const live = !!t && !t.destroyed;
    const done = e.row.done;
    const files: TorrentFileInfo[] = e.files.map((f) => {
      const wf = live ? t!.files[f.index] : undefined;
      return {
        index: f.index,
        name: f.name,
        length: f.length,
        progress: done ? 1 : wf ? wf.progress : 0,
        playable: isPlayable(f.name),
      };
    });
    const size = live && t!.ready ? t!.length : e.files.reduce((s, f) => s + f.length, 0);
    return {
      id: e.id,
      name: (live && t!.name) || e.row.name || '',
      progress: done ? 1 : live ? t!.progress : 0,
      downloadSpeed: live && !done ? t!.downloadSpeed : 0,
      uploadSpeed: live ? t!.uploadSpeed : 0,
      peers: live ? t!.numPeers : 0,
      size,
      downloaded: done ? size : live ? t!.downloaded : 0,
      status: e.error ? 'error' : done ? 'done' : live && t!.ready ? 'downloading' : 'metadata',
      error: e.error,
      files,
      addedAt: e.row.addedAt,
      eta: live && !done && Number.isFinite(t!.timeRemaining) ? Math.round(t!.timeRemaining / 1000) : undefined,
    };
  }

  private scheduleUpdate(): void {
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      this.emit('update', this.list());
    }, 1000);
  }

  destroy(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.client) return resolve();
      this.client.destroy(() => resolve());
      setTimeout(resolve, 3000);
    });
  }
}
