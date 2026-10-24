import fs from 'node:fs';
import path from 'node:path';
import type { MediaItem, MetadataUpdatePayload } from '@tvbox/shared';
import { parseTorrentName } from '@tvbox/shared';
import { TvDatabase } from './db';
import { TmdbClient } from './tmdb';
import { TorrentEngine } from './torrents';
import { isVideoFile, isAudioFile, isImageFile } from './filesystem';
import type { TvClientConfig } from './config';

export class MediaLibrary {
  constructor(
    private readonly db: TvDatabase,
    private readonly tmdb: TmdbClient,
    private readonly torrents: TorrentEngine,
    private readonly config: TvClientConfig,
  ) {}

  list(): MediaItem[] {
    const items = this.db.listMedia();
    return items.map((m) => {
      const p = this.db.getProgress(m.id);
      if (p) return { ...m, progress: p.position, duration: p.duration || m.duration };
      return m;
    });
  }

  scanLocal(): void {
    for (const dir of this.config.mediaDirs) {
      if (!fs.existsSync(dir)) continue;
      this.walk(dir, 3);
    }
  }

  private walk(dir: string, depth: number): void {
    if (depth <= 0) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        this.walk(full, depth - 1);
      } else if (e.isFile() && (isVideoFile(full) || isAudioFile(full) || isImageFile(full))) {
        this.addLocalFile(full, e.name);
      }
    }
  }

  private addLocalFile(fullPath: string, name: string): void {
    const id = `file:${fullPath}`;
    const existing = this.db.getMedia(id);
    if (existing) return;
    const stat = fs.statSync(fullPath);
    const parsed = parseTorrentName(name.replace(/\.[^.]+$/, ''));
    const type: MediaItem['type'] = isVideoFile(fullPath)
      ? parsed.isSeries
        ? 'episode'
        : 'movie'
      : isAudioFile(fullPath)
        ? 'audio'
        : 'photo';
    this.db.upsertMedia({
      id,
      type,
      title: parsed.title || name,
      path: fullPath,
      season: parsed.season,
      episode: parsed.episode,
      size: stat.size,
      addedAt: stat.mtimeMs,
    });
  }

  async onTorrentDone(torrentId: string): Promise<void> {
    const info = this.torrents.get(torrentId);
    if (!info) return;
    for (const file of info.files) {
      const filePath = this.torrents.getFilePath(torrentId, file.index);
      if (!filePath) continue;
      if (!isVideoFile(filePath) && !isAudioFile(filePath) && !isImageFile(filePath)) continue;
      const parsed = parseTorrentName(file.name.replace(/\.[^.]+$/, ''));
      const id = `torrent:${torrentId}:${file.index}`;
      let item: MediaItem = {
        id,
        type: isVideoFile(filePath) ? (parsed.isSeries ? 'episode' : 'movie') : isAudioFile(filePath) ? 'audio' : 'photo',
        title: parsed.title || file.name,
        path: filePath,
        season: parsed.season,
        episode: parsed.episode,
        size: file.length,
        addedAt: Date.now(),
      };
      const enriched = await this.tmdb.enrichFromTorrentName(file.name);
      if (enriched) {
        item = { ...enriched, ...item, poster: enriched.poster, backdrop: enriched.backdrop, overview: enriched.overview, rating: enriched.rating, releaseDate: enriched.releaseDate, genres: enriched.genres, tmdbId: enriched.tmdbId };
      }
      this.db.upsertMedia(item);
    }
  }

  saveProgress(mediaId: string, position: number, duration: number): void {
    this.db.saveProgress(mediaId, position, duration);
    const m = this.db.getMedia(mediaId);
    if (m) this.db.upsertMedia({ ...m, progress: position, duration: duration || m.duration });
  }

  delete(mediaId: string): void {
    const m = this.db.getMedia(mediaId);
    if (m?.path) {
      try {
        fs.unlinkSync(m.path);
      } catch {
        // already gone
      }
    }
    this.db.deleteMedia(mediaId);
  }

  async updateMetadata(payload: MetadataUpdatePayload): Promise<MediaItem | undefined> {
    const m = this.db.getMedia(payload.mediaId);
    if (!m) return undefined;
    const next: MediaItem = {
      ...m,
      ...(payload.title !== undefined ? { title: payload.title } : {}),
      ...(payload.overview !== undefined ? { overview: payload.overview } : {}),
      ...(payload.poster !== undefined ? { poster: payload.poster } : {}),
      ...(payload.backdrop !== undefined ? { backdrop: payload.backdrop } : {}),
      ...(payload.tmdbId !== undefined ? { tmdbId: payload.tmdbId } : {}),
      ...(payload.rating !== undefined ? { rating: payload.rating } : {}),
      ...(payload.releaseDate !== undefined ? { releaseDate: payload.releaseDate } : {}),
      ...(payload.genres !== undefined ? { genres: payload.genres } : {}),
    };
    this.db.upsertMedia(next);
    return next;
  }

  async searchAndApply(mediaId: string, query: string): Promise<MediaItem | undefined> {
    const m = this.db.getMedia(mediaId);
    if (!m) return undefined;
    const parsed = parseTorrentName(query);
    const result = await this.tmdb.searchBestMatch(parsed.searchQuery, parsed.year, parsed.isSeries);
    if (!result) return undefined;
    const next: MediaItem = {
      ...m,
      title: result.title,
      overview: result.overview,
      poster: result.poster,
      backdrop: result.backdrop,
      rating: result.rating,
      releaseDate: result.releaseDate,
      genres: result.genres,
      tmdbId: result.id,
    };
    this.db.upsertMedia(next);
    return next;
  }
}
