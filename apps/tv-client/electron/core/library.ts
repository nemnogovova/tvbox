import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { mediaKindOfFile, parseMediaName, showKeyFor, type MediaItem } from '@tvbox/shared';
import type { TvDatabase } from './db';
import type { TmdbClient, TmdbDetails } from './tmdb';

export const mediaIdFor = (p: string) =>
  crypto.createHash('sha1').update(path.resolve(p).toLowerCase()).digest('hex').slice(0, 16);

const SKIP_DIRS = /^(\$recycle\.bin|system volume information|node_modules|\.git|sample|samples|extras|featurettes)$/i;

export function mediaFromFile(fullPath: string, size: number, extra: Partial<MediaItem> = {}): MediaItem | null {
  const name = path.basename(fullPath);
  const fileKind = mediaKindOfFile(name);
  if (!fileKind || fileKind === 'image') return null;
  if (/\bsample\b/i.test(name) && size < 150 * 1024 * 1024) return null;

  let parsed = parseMediaName(name);
  // "S01E02.mkv" inside "Show Name (Season 1)" → take the show title from the folder
  const parent = path.basename(path.dirname(fullPath));
  if (parsed.isSeries && (!parsed.title || /^(s\d+|e\d+|\d+)$/i.test(parsed.title))) {
    const p = parseMediaName(parent);
    parsed = { ...parsed, title: p.title, searchQuery: p.searchQuery, year: parsed.year ?? p.year };
  }
  if (!parsed.isSeries && fileKind === 'video') {
    const p = parseMediaName(parent);
    // Folder named "Show S02" with files "01. Name.mkv"
    if (p.isSeries && /^\d{1,3}\b/.test(name)) {
      parsed = { ...parsed, title: p.title, searchQuery: p.searchQuery, season: p.season ?? 1, episode: parseInt(name, 10), isSeries: true };
    }
  }

  let kind: MediaItem['kind'];
  if (fileKind === 'audio') kind = 'audio';
  else if (parsed.isSeries) kind = 'episode';
  else kind = !parsed.year && size > 0 && size < 250 * 1024 * 1024 ? 'video' : 'movie';

  const title = parsed.title || name.replace(/\.[^.]+$/, '');
  return {
    id: mediaIdFor(fullPath),
    kind,
    title,
    ...(kind === 'episode' ? { showKey: showKeyFor(title), season: parsed.season ?? 1, episode: parsed.episode } : {}),
    year: parsed.year,
    path: fullPath,
    origin: 'local',
    size,
    addedAt: Date.now(),
    ...extra,
  };
}

/** Library of media files on the TV PC (+ TMDb metadata), backed by SQLite. */
export class Library extends EventEmitter {
  private changeTimer: NodeJS.Timeout | null = null;
  private enriching = false;
  private scanning: Promise<void> | null = null;
  private showCache = new Map<string, TmdbDetails | null>();

  constructor(
    private readonly db: TvDatabase,
    private readonly tmdb: TmdbClient,
    private readonly getDirs: () => string[],
  ) {
    super();
  }

  list(): MediaItem[] {
    return this.db.listMedia();
  }

  get(id: string): MediaItem | undefined {
    return this.db.getMedia(id);
  }

  private changed(): void {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.emit('changed');
    }, 400);
  }

  addFile(fullPath: string, extra: Partial<MediaItem> = {}): MediaItem | null {
    let size = 0;
    try {
      size = fs.statSync(fullPath).size;
    } catch {
      return null;
    }
    const existing = this.db.getMediaByPath(fullPath);
    if (existing) {
      if (extra.origin && existing.origin !== extra.origin) {
        this.db.upsertMedia({ ...existing, ...extra });
        this.changed();
      }
      return existing;
    }
    const item = mediaFromFile(fullPath, size, extra);
    if (!item) return null;
    this.db.upsertMedia(item);
    this.changed();
    void this.enrich();
    return item;
  }

  scan(): Promise<void> {
    if (this.scanning) return this.scanning;
    this.scanning = this.doScan().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private async doScan(): Promise<void> {
    const dirs = this.getDirs().filter((d) => {
      try {
        return fs.statSync(d).isDirectory();
      } catch {
        return false;
      }
    });
    const seen = new Set<string>();
    const walk = async (dir: string, depth: number) => {
      if (depth > 8) return;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.test(e.name)) await walk(full, depth + 1);
        } else if (e.isFile()) {
          const k = mediaKindOfFile(e.name);
          if (k === 'video' || k === 'audio') {
            seen.add(path.resolve(full).toLowerCase());
            this.addFile(full);
          }
        }
      }
    };
    for (const d of dirs) await walk(d, 0);

    // Drop entries whose file disappeared
    for (const m of this.db.listMedia()) {
      if (seen.has(path.resolve(m.path).toLowerCase())) continue;
      if (!fs.existsSync(m.path)) {
        this.db.deleteMedia(m.id);
        this.changed();
      }
    }
    this.changed();
    void this.enrich();
  }

  /** Fetch TMDb metadata for new items (sequentially, gently). */
  async enrich(): Promise<void> {
    if (this.enriching || !this.tmdb.enabled) return;
    this.enriching = true;
    try {
      for (;;) {
        const batch = this.db.needsTmdb().filter((m) => m.kind === 'movie' || m.kind === 'episode');
        const audio = this.db.needsTmdb().filter((m) => m.kind !== 'movie' && m.kind !== 'episode');
        for (const a of audio) this.db.setTmdbTried(a.id);
        if (!batch.length) break;
        for (const m of batch) {
          try {
            await this.enrichOne(m);
          } catch (e) {
            if ((e as Error).message === 'tmdb_unauthorized') {
              this.emit('tmdb-error', 'Неверный ключ TMDb');
              return;
            }
          }
          this.db.setTmdbTried(m.id);
          await new Promise((r) => setTimeout(r, 120));
        }
      }
    } finally {
      this.enriching = false;
    }
  }

  private async enrichOne(m: MediaItem): Promise<void> {
    const parsed = parseMediaName(path.basename(m.path));
    if (m.kind === 'movie') {
      const query = m.title !== parsed.title ? m.title : parsed.searchQuery;
      const d = await this.tmdb.bestMatch(query, 'movie', m.year ?? parsed.year);
      if (d) this.applyDetails(m, d);
      return;
    }
    const key = m.showKey || showKeyFor(m.title);
    let show = this.showCache.get(key);
    if (show === undefined) {
      show = await this.tmdb.bestMatch(m.title === parsed.title ? parsed.searchQuery : m.title, 'tv', undefined);
      this.showCache.set(key, show);
    }
    if (show) await this.applyShow(m, show);
  }

  private applyDetails(m: MediaItem, d: TmdbDetails): MediaItem {
    const next: MediaItem = {
      ...m,
      title: d.title,
      year: d.year ?? m.year,
      overview: d.overview,
      poster: d.poster,
      backdrop: d.backdrop,
      rating: d.rating,
      genres: d.genres,
      tmdbId: d.id,
      tmdbType: d.type,
    };
    if (d.type === 'tv') {
      next.kind = 'episode';
      next.showKey = `tmdb-tv-${d.id}`;
      next.season = next.season ?? 1;
    } else if (m.kind === 'episode') {
      next.kind = 'movie';
      delete next.showKey;
    }
    this.db.upsertMedia(next);
    this.changed();
    return next;
  }

  private async applyShow(m: MediaItem, show: TmdbDetails): Promise<void> {
    const next = this.applyDetails(m, show);
    if (next.episode !== undefined) {
      const ep = await this.tmdb.episode(show.id, next.season ?? 1, next.episode);
      if (ep) {
        this.db.upsertMedia({ ...next, episodeTitle: ep.name || next.episodeTitle });
        this.changed();
      }
    }
  }

  async applyTmdb(mediaId: string, tmdbId: number, type: 'movie' | 'tv', wholeShow: boolean): Promise<void> {
    const m = this.db.getMedia(mediaId);
    if (!m) throw new Error('not_found');
    const d = await this.tmdb.details(tmdbId, type);
    const targets = wholeShow && m.kind === 'episode' ? this.list().filter((x) => x.showKey === m.showKey) : [m];
    for (const t of targets) {
      if (type === 'tv') {
        if (t.kind !== 'episode') t.kind = 'episode';
        await this.applyShow(t, d);
      } else this.applyDetails(t, d);
      this.db.setTmdbTried(t.id);
    }
    if (type === 'tv' && m.showKey) this.showCache.set(m.showKey, d);
  }

  update(mediaId: string, patch: Partial<MediaItem>): MediaItem {
    const m = this.db.getMedia(mediaId);
    if (!m) throw new Error('not_found');
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== '')) as Partial<MediaItem>;
    const next: MediaItem = { ...m, ...clean };
    if (m.kind === 'episode' && clean.title && clean.title !== m.title && !m.tmdbId) next.showKey = showKeyFor(clean.title);
    this.db.upsertMedia(next);
    this.db.setTmdbTried(mediaId);
    this.changed();
    return next;
  }

  async delete(mediaId: string): Promise<void> {
    const m = this.db.getMedia(mediaId);
    if (!m) throw new Error('not_found');
    await fs.promises.rm(m.path, { force: true });
    this.db.deleteMedia(mediaId);
    this.changed();
  }

  removePaths(paths: string[]): void {
    const set = new Set(paths.map((p) => path.resolve(p).toLowerCase()));
    for (const m of this.list()) if (set.has(path.resolve(m.path).toLowerCase())) this.db.deleteMedia(m.id);
    this.changed();
  }

  saveProgress(mediaId: string, position: number, duration: number): void {
    if (!this.db.getMedia(mediaId)) return;
    this.db.saveProgress(mediaId, position, duration);
    this.changed();
  }

  getProgress(mediaId: string) {
    return this.db.getProgress(mediaId);
  }

  /** Next episode of the same show (for auto-play). */
  nextEpisode(mediaId: string): MediaItem | undefined {
    const m = this.get(mediaId);
    if (!m || m.kind !== 'episode' || !m.showKey) return undefined;
    const eps = this.list()
      .filter((x) => x.showKey === m.showKey)
      .sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || a.path.localeCompare(b.path));
    const i = eps.findIndex((x) => x.id === m.id);
    return i >= 0 ? eps[i + 1] : undefined;
  }

  retryTmdb(): void {
    this.showCache.clear();
    this.db.resetTmdbTried();
    void this.enrich();
  }
}
