import fs from 'node:fs';
import path from 'node:path';
import initSqlJs, { type Database, type SqlValue } from 'sql.js';
import type { MediaItem } from '@tvbox/shared';

export interface TorrentRow {
  id: string;
  name: string;
  magnet: string | null;
  torrentB64: string | null;
  addedAt: number;
  done: boolean;
  savePath: string;
}

export interface ProgressRow {
  position: number;
  duration: number;
  watchedAt: number;
}

/**
 * SQLite (sql.js / WebAssembly — no native modules to rebuild for Electron).
 * The whole DB lives in memory and is flushed to disk with a short debounce.
 */
export class TvDatabase {
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  private constructor(
    private readonly db: Database,
    private readonly file: string | null,
  ) {
    this.migrate();
  }

  static async open(dir: string | null): Promise<TvDatabase> {
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    const wasmBinary = fs.readFileSync(wasmPath);
    const SQL = await initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
    let file: string | null = null;
    let data: Uint8Array | undefined;
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, 'tvbox.sqlite');
      try {
        data = fs.readFileSync(file);
      } catch {
        data = undefined;
      }
    }
    let db: Database;
    try {
      db = new SQL.Database(data);
      db.exec('SELECT 1');
    } catch {
      // corrupt file: keep a backup and start fresh
      if (file && fs.existsSync(file)) fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      db = new SQL.Database();
    }
    return new TvDatabase(db, file);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS media (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        data TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        tmdb_tried INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS progress (
        media_id TEXT PRIMARY KEY,
        position REAL NOT NULL,
        duration REAL NOT NULL,
        watched_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS torrents (
        id TEXT PRIMARY KEY,
        name TEXT,
        magnet TEXT,
        torrent_b64 TEXT,
        added_at INTEGER NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        save_path TEXT
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  // ------------------------------------------------------------------ helpers
  private all(sql: string, params: SqlValue[] = []): Record<string, SqlValue>[] {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows: Record<string, SqlValue>[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  private run(sql: string, params: SqlValue[] = []): void {
    this.db.run(sql, params);
    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 1500);
  }

  flush(): void {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(this.db.export()));
    fs.renameSync(tmp, this.file);
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.flush();
    this.db.close();
  }

  // ------------------------------------------------------------------ media
  private rowToMedia(r: Record<string, SqlValue>): MediaItem {
    const m = JSON.parse(String(r.data)) as MediaItem;
    if (r.position !== null && r.position !== undefined) {
      m.position = Number(r.position);
      m.duration = Number(r.pduration) || m.duration;
      m.watchedAt = Number(r.watched_at);
    }
    return m;
  }

  listMedia(): MediaItem[] {
    return this.all(
      `SELECT m.data, p.position, p.duration AS pduration, p.watched_at
       FROM media m LEFT JOIN progress p ON p.media_id = m.id
       ORDER BY m.added_at DESC`,
    ).map((r) => this.rowToMedia(r));
  }

  getMedia(id: string): MediaItem | undefined {
    const r = this.all(
      `SELECT m.data, p.position, p.duration AS pduration, p.watched_at
       FROM media m LEFT JOIN progress p ON p.media_id = m.id WHERE m.id = ?`,
      [id],
    )[0];
    return r ? this.rowToMedia(r) : undefined;
  }

  getMediaByPath(p: string): MediaItem | undefined {
    const r = this.all('SELECT id FROM media WHERE path = ?', [p])[0];
    return r ? this.getMedia(String(r.id)) : undefined;
  }

  upsertMedia(item: MediaItem): void {
    const { position, duration, watchedAt, ...rest } = item;
    void position;
    void watchedAt;
    const data = JSON.stringify({ ...rest, ...(duration ? { duration } : {}) });
    this.run(
      `INSERT INTO media (id, path, data, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET path = excluded.path, data = excluded.data`,
      [item.id, item.path, data, item.addedAt || Date.now()],
    );
  }

  deleteMedia(id: string): void {
    this.run('DELETE FROM media WHERE id = ?', [id]);
    this.run('DELETE FROM progress WHERE media_id = ?', [id]);
  }

  needsTmdb(): MediaItem[] {
    return this.all('SELECT data FROM media WHERE tmdb_tried = 0').map((r) => JSON.parse(String(r.data)) as MediaItem);
  }

  setTmdbTried(id: string, tried = true): void {
    this.run('UPDATE media SET tmdb_tried = ? WHERE id = ?', [tried ? 1 : 0, id]);
  }

  resetTmdbTried(): void {
    this.run(`UPDATE media SET tmdb_tried = 0 WHERE json_extract(data, '$.tmdbId') IS NULL`);
  }

  // ------------------------------------------------------------------ progress
  saveProgress(mediaId: string, position: number, duration: number): void {
    this.run(
      `INSERT INTO progress (media_id, position, duration, watched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(media_id) DO UPDATE SET position = excluded.position, duration = excluded.duration, watched_at = excluded.watched_at`,
      [mediaId, position, duration, Date.now()],
    );
  }

  getProgress(mediaId: string): ProgressRow | undefined {
    const r = this.all('SELECT position, duration, watched_at FROM progress WHERE media_id = ?', [mediaId])[0];
    return r ? { position: Number(r.position), duration: Number(r.duration), watchedAt: Number(r.watched_at) } : undefined;
  }

  // ------------------------------------------------------------------ torrents
  upsertTorrent(t: TorrentRow): void {
    this.run(
      `INSERT INTO torrents (id, name, magnet, torrent_b64, added_at, done, save_path) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, magnet = COALESCE(excluded.magnet, torrents.magnet),
         torrent_b64 = COALESCE(excluded.torrent_b64, torrents.torrent_b64), done = excluded.done, save_path = excluded.save_path`,
      [t.id, t.name, t.magnet, t.torrentB64, t.addedAt, t.done ? 1 : 0, t.savePath],
    );
  }

  listTorrents(): TorrentRow[] {
    return this.all('SELECT * FROM torrents ORDER BY added_at DESC').map((r) => ({
      id: String(r.id),
      name: String(r.name ?? ''),
      magnet: r.magnet ? String(r.magnet) : null,
      torrentB64: r.torrent_b64 ? String(r.torrent_b64) : null,
      addedAt: Number(r.added_at),
      done: Number(r.done) === 1,
      savePath: String(r.save_path ?? ''),
    }));
  }

  deleteTorrent(id: string): void {
    this.run('DELETE FROM torrents WHERE id = ?', [id]);
  }

  // ------------------------------------------------------------------ key/value
  getJson<T>(key: string): T | undefined {
    const r = this.all('SELECT value FROM kv WHERE key = ?', [key])[0];
    if (!r) return undefined;
    try {
      return JSON.parse(String(r.value)) as T;
    } catch {
      return undefined;
    }
  }

  setJson(key: string, value: unknown): void {
    this.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(value)]);
  }
}
