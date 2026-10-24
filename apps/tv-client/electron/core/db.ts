import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { MediaItem, TorrentInfo, WidgetConfig, IdleSettings } from '@tvbox/shared';

export interface ProgressRow {
  mediaId: string;
  position: number;
  duration: number;
  updatedAt: number;
}

export class TvDatabase {
  private db: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, 'tvbox.db');
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS media (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        originalTitle TEXT,
        path TEXT,
        fileId TEXT,
        poster TEXT,
        backdrop TEXT,
        overview TEXT,
        rating REAL,
        releaseDate TEXT,
        genres TEXT,
        tmdbId INTEGER,
        seriesId TEXT,
        season INTEGER,
        episode INTEGER,
        episodeCount INTEGER,
        duration REAL,
        addedAt INTEGER,
        size INTEGER
      );
      CREATE TABLE IF NOT EXISTS progress (
        mediaId TEXT PRIMARY KEY,
        position REAL,
        duration REAL,
        updatedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS torrents (
        id TEXT PRIMARY KEY,
        infoHash TEXT,
        name TEXT,
        magnet TEXT,
        status TEXT,
        size INTEGER,
        downloaded INTEGER,
        addedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  }

  // ---- media ----
  upsertMedia(item: MediaItem): void {
    this.db
      .prepare(
        `INSERT INTO media (id, type, title, originalTitle, path, fileId, poster, backdrop, overview, rating,
          releaseDate, genres, tmdbId, seriesId, season, episode, episodeCount, duration, addedAt, size)
         VALUES (@id, @type, @title, @originalTitle, @path, @fileId, @poster, @backdrop, @overview, @rating,
          @releaseDate, @genres, @tmdbId, @seriesId, @season, @episode, @episodeCount, @duration, @addedAt, @size)
         ON CONFLICT(id) DO UPDATE SET
          title=excluded.title, type=excluded.type, poster=excluded.poster, backdrop=excluded.backdrop,
          overview=excluded.overview, rating=excluded.rating, releaseDate=excluded.releaseDate,
          genres=excluded.genres, tmdbId=excluded.tmdbId, seriesId=excluded.seriesId, season=excluded.season,
          episode=excluded.episode, episodeCount=excluded.episodeCount, duration=excluded.duration,
          size=excluded.size, path=COALESCE(excluded.path, media.path), fileId=COALESCE(excluded.fileId, media.fileId)`,
      )
      .run({
        ...item,
        genres: item.genres ? JSON.stringify(item.genres) : null,
        originalTitle: item.originalTitle ?? null,
        path: item.path ?? null,
        fileId: item.fileId ?? null,
        poster: item.poster ?? null,
        backdrop: item.backdrop ?? null,
        overview: item.overview ?? null,
        rating: item.rating ?? null,
        releaseDate: item.releaseDate ?? null,
        tmdbId: item.tmdbId ?? null,
        seriesId: item.seriesId ?? null,
        season: item.season ?? null,
        episode: item.episode ?? null,
        episodeCount: item.episodeCount ?? null,
        duration: item.duration ?? null,
        addedAt: item.addedAt ?? Date.now(),
        size: item.size ?? null,
      });
  }

  listMedia(): MediaItem[] {
    const rows = this.db.prepare('SELECT * FROM media ORDER BY addedAt DESC').all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToMedia(r));
  }

  getMedia(id: string): MediaItem | undefined {
    const row = this.db.prepare('SELECT * FROM media WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToMedia(row) : undefined;
  }

  deleteMedia(id: string): void {
    this.db.prepare('DELETE FROM media WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM progress WHERE mediaId = ?').run(id);
  }

  private rowToMedia(r: Record<string, unknown>): MediaItem {
    return {
      id: String(r.id),
      type: r.type as MediaItem['type'],
      title: String(r.title),
      originalTitle: r.originalTitle ? String(r.originalTitle) : undefined,
      path: r.path ? String(r.path) : undefined,
      fileId: r.fileId ? String(r.fileId) : undefined,
      poster: r.poster ? String(r.poster) : undefined,
      backdrop: r.backdrop ? String(r.backdrop) : undefined,
      overview: r.overview ? String(r.overview) : undefined,
      rating: r.rating != null ? Number(r.rating) : undefined,
      releaseDate: r.releaseDate ? String(r.releaseDate) : undefined,
      genres: r.genres ? (JSON.parse(String(r.genres)) as string[]) : undefined,
      tmdbId: r.tmdbId != null ? Number(r.tmdbId) : undefined,
      seriesId: r.seriesId ? String(r.seriesId) : undefined,
      season: r.season != null ? Number(r.season) : undefined,
      episode: r.episode != null ? Number(r.episode) : undefined,
      episodeCount: r.episodeCount != null ? Number(r.episodeCount) : undefined,
      duration: r.duration != null ? Number(r.duration) : undefined,
      addedAt: r.addedAt != null ? Number(r.addedAt) : undefined,
      size: r.size != null ? Number(r.size) : undefined,
    };
  }

  // ---- progress ----
  saveProgress(mediaId: string, position: number, duration: number): void {
    this.db
      .prepare(
        `INSERT INTO progress (mediaId, position, duration, updatedAt) VALUES (?, ?, ?, ?)
         ON CONFLICT(mediaId) DO UPDATE SET position=excluded.position, duration=excluded.duration, updatedAt=excluded.updatedAt`,
      )
      .run(mediaId, position, duration, Date.now());
  }

  getProgress(mediaId: string): ProgressRow | undefined {
    return this.db.prepare('SELECT * FROM progress WHERE mediaId = ?').get(mediaId) as ProgressRow | undefined;
  }

  // ---- torrents ----
  upsertTorrent(t: Partial<TorrentInfo>): void {
    this.db
      .prepare(
        `INSERT INTO torrents (id, infoHash, name, magnet, status, size, downloaded, addedAt)
         VALUES (@id, @infoHash, @name, @magnet, @status, @size, @downloaded, @addedAt)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, size=excluded.size, downloaded=excluded.downloaded, name=excluded.name`,
      )
      .run({
        id: t.id,
        infoHash: t.infoHash ?? null,
        name: t.name ?? '',
        magnet: t.magnet ?? null,
        status: t.status ?? 'downloading',
        size: t.size ?? 0,
        downloaded: t.downloaded ?? 0,
        addedAt: t.addedAt ?? Date.now(),
      });
  }

  deleteTorrent(id: string): void {
    this.db.prepare('DELETE FROM torrents WHERE id = ?').run(id);
  }

  // ---- settings ----
  saveSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return undefined;
    }
  }

  getWidgets(): WidgetConfig[] {
    return this.getSetting<WidgetConfig[]>('widgets') ?? [];
  }

  saveWidgets(widgets: WidgetConfig[]): void {
    this.saveSetting('widgets', widgets);
  }

  getIdleSettings(): IdleSettings | undefined {
    return this.getSetting<IdleSettings>('idleSettings');
  }

  saveIdleSettings(settings: IdleSettings): void {
    this.saveSetting('idleSettings', settings);
  }

  close(): void {
    this.db.close();
  }
}
