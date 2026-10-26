import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import { sendFile, type MediaServer } from './media-server';
import type {
  MusicAlbum,
  MusicArtist,
  MusicBrowseResult,
  MusicCacheInfo,
  MusicItemResult,
  MusicPlaylist,
  MusicSource,
  MusicSourceAddPayload,
  MusicSourceKind,
  MusicTrack,
  MusicView,
} from '@tvbox/shared';

/**
 * Music services connected to the TV: Jellyfin and Subsonic-compatible servers
 * (Navidrome, Airsonic, Gonic, original Subsonic…).
 *
 * `cover` fields are opaque cover ids of the source; remotes resolve them with
 * MUSIC_COVER (a small data: URL), the TV renderer through the local media server.
 * Played tracks are kept in an LRU disk cache.
 */

export interface StoredSource extends MusicSource {
  /** Jellyfin */
  token?: string;
  userId?: string;
  deviceId?: string;
  /** Subsonic: the password is needed to sign every request */
  password?: string;
  /** Subsonic: server only accepts the legacy p=enc: auth */
  legacyAuth?: boolean;
}

export interface KvStore {
  getJson<T>(key: string): T | undefined;
  setJson(key: string, value: unknown): void;
}

const CLIENT = 'TVBox';
const VERSION = '3.0.0';
const PAGE = 60;

const httpError = (status: number, text = '') => new Error(status === 401 || status === 403 ? 'auth_failed' : `http_${status}${text ? `: ${text.slice(0, 120)}` : ''}`);

async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 20000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw httpError(res.status, await res.text().catch(() => ''));
    return (await res.json()) as T;
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') throw new Error('timeout');
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(err.message + String((err as { cause?: unknown }).cause || ''))) throw new Error('unreachable');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeServerUrl(u: string): string {
  let url = u.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, '').replace(/\/(web|app)(\/.*)?$/i, '');
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

interface Adapter {
  browse(view: MusicView, offset: number, limit: number): Promise<MusicBrowseResult>;
  item(type: 'album' | 'artist' | 'playlist', id: string): Promise<MusicItemResult>;
  search(query: string): Promise<MusicBrowseResult>;
  streamUrl(itemId: string): string;
  coverUrl(coverId: string, size: number): string;
  /** File extension of the original audio (for the cache) */
  ext(itemId: string): string;
}

// ---------------------------------------------------------------- Jellyfin
interface JfItem {
  Id: string;
  Name: string;
  Type?: string;
  AlbumArtist?: string;
  Artists?: string[];
  Album?: string;
  AlbumId?: string;
  ProductionYear?: number;
  ChildCount?: number;
  SongCount?: number;
  AlbumCount?: number;
  RunTimeTicks?: number;
  CumulativeRunTimeTicks?: number;
  IndexNumber?: number;
  Container?: string;
  ImageTags?: Record<string, string>;
  AlbumPrimaryImageTag?: string;
}

function jfAuthHeader(s: StoredSource): string {
  const parts = [`Client="${CLIENT}"`, `Device="TVBox TV"`, `DeviceId="${s.deviceId}"`, `Version="${VERSION}"`];
  if (s.token) parts.push(`Token="${s.token}"`);
  return `MediaBrowser ${parts.join(', ')}`;
}

export async function jellyfinLogin(url: string, username: string, password: string, deviceId: string): Promise<{ token: string; userId: string; serverName?: string }> {
  const s = { deviceId } as StoredSource;
  const out = await fetchJson<{ AccessToken: string; User: { Id: string }; ServerId?: string }>(`${url}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: jfAuthHeader(s), 'X-Emby-Authorization': jfAuthHeader(s) },
    body: JSON.stringify({ Username: username, Pw: password }),
  });
  if (!out?.AccessToken) throw new Error('auth_failed');
  let serverName: string | undefined;
  try {
    serverName = (await fetchJson<{ ServerName?: string }>(`${url}/System/Info/Public`)).ServerName;
  } catch {
    // optional
  }
  return { token: out.AccessToken, userId: out.User.Id, serverName };
}

class JellyfinAdapter implements Adapter {
  private exts = new Map<string, string>();
  constructor(private readonly s: StoredSource) {}

  private get<T>(p: string, q: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const u = new URL(`${this.s.url}${p}`);
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
    return fetchJson<T>(u.toString(), { headers: { Authorization: jfAuthHeader(this.s), 'X-Emby-Token': this.s.token || '' } });
  }

  private items(q: Record<string, string | number | boolean | undefined>) {
    return this.get<{ Items: JfItem[]; TotalRecordCount: number }>(`/Users/${this.s.userId}/Items`, {
      Recursive: true,
      Fields: 'ChildCount,ProductionYear,CumulativeRunTimeTicks,SongCount,AlbumCount',
      EnableImageTypes: 'Primary',
      ...q,
    });
  }

  private track = (i: JfItem): MusicTrack => {
    if (i.Container) this.exts.set(i.Id, i.Container.split(',')[0]);
    return {
      id: `${this.s.id}:${i.Id}`,
      sourceId: this.s.id,
      itemId: i.Id,
      title: i.Name,
      artist: i.Artists?.join(', ') || i.AlbumArtist,
      album: i.Album,
      albumId: i.AlbumId,
      duration: i.RunTimeTicks ? i.RunTimeTicks / 1e7 : undefined,
      trackNo: i.IndexNumber,
      cover: i.ImageTags?.Primary ? i.Id : i.AlbumPrimaryImageTag && i.AlbumId ? i.AlbumId : undefined,
    };
  };

  private album = (i: JfItem): MusicAlbum => ({
    id: i.Id,
    sourceId: this.s.id,
    title: i.Name,
    artist: i.AlbumArtist || i.Artists?.join(', '),
    year: i.ProductionYear,
    cover: i.ImageTags?.Primary ? i.Id : undefined,
    trackCount: i.ChildCount ?? i.SongCount,
  });

  private artist = (i: JfItem): MusicArtist => ({
    id: i.Id,
    sourceId: this.s.id,
    name: i.Name,
    cover: i.ImageTags?.Primary ? i.Id : undefined,
    albumCount: i.AlbumCount ?? i.ChildCount,
  });

  private playlist = (i: JfItem): MusicPlaylist => ({
    id: i.Id,
    sourceId: this.s.id,
    title: i.Name,
    cover: i.ImageTags?.Primary ? i.Id : undefined,
    trackCount: i.ChildCount,
    duration: i.CumulativeRunTimeTicks ? i.CumulativeRunTimeTicks / 1e7 : undefined,
  });

  async browse(view: MusicView, offset: number, limit: number): Promise<MusicBrowseResult> {
    const page = { StartIndex: offset, Limit: limit };
    switch (view) {
      case 'albums':
      case 'recent': {
        const r = await this.items({
          IncludeItemTypes: 'MusicAlbum',
          SortBy: view === 'recent' ? 'DateCreated,SortName' : 'SortName',
          SortOrder: view === 'recent' ? 'Descending' : 'Ascending',
          ...page,
        });
        return { albums: r.Items.map(this.album), hasMore: offset + r.Items.length < r.TotalRecordCount };
      }
      case 'artists': {
        const r = await this.get<{ Items: JfItem[]; TotalRecordCount: number }>('/Artists/AlbumArtists', {
          userId: this.s.userId,
          Fields: 'ChildCount',
          EnableImageTypes: 'Primary',
          SortBy: 'SortName',
          ...page,
        });
        return { artists: r.Items.map(this.artist), hasMore: offset + r.Items.length < r.TotalRecordCount };
      }
      case 'playlists': {
        const r = await this.items({ IncludeItemTypes: 'Playlist', MediaTypes: 'Audio', SortBy: 'SortName', ...page });
        return { playlists: r.Items.map(this.playlist), hasMore: offset + r.Items.length < r.TotalRecordCount };
      }
      case 'random':
      case 'tracks': {
        const r = await this.items({
          IncludeItemTypes: 'Audio',
          SortBy: view === 'random' ? 'Random' : 'Album,ParentIndexNumber,IndexNumber,SortName',
          Fields: 'Container',
          ...page,
        });
        return { tracks: r.Items.map(this.track), hasMore: view !== 'random' && offset + r.Items.length < r.TotalRecordCount };
      }
    }
  }

  async item(type: 'album' | 'artist' | 'playlist', id: string): Promise<MusicItemResult> {
    if (type === 'album') {
      const [info, r] = await Promise.all([
        this.get<JfItem>(`/Users/${this.s.userId}/Items/${id}`),
        this.items({ ParentId: id, IncludeItemTypes: 'Audio', SortBy: 'ParentIndexNumber,IndexNumber,SortName', Fields: 'Container' }),
      ]);
      return {
        title: info.Name,
        subtitle: [info.AlbumArtist, info.ProductionYear].filter(Boolean).join(' · '),
        cover: info.ImageTags?.Primary ? info.Id : undefined,
        tracks: r.Items.map(this.track),
      };
    }
    if (type === 'playlist') {
      const [info, r] = await Promise.all([
        this.get<JfItem>(`/Users/${this.s.userId}/Items/${id}`),
        this.get<{ Items: JfItem[] }>(`/Playlists/${id}/Items`, { userId: this.s.userId, Fields: 'Container', EnableImageTypes: 'Primary' }),
      ]);
      return { title: info.Name, cover: info.ImageTags?.Primary ? info.Id : undefined, tracks: r.Items.map(this.track) };
    }
    const [info, albums, tracks] = await Promise.all([
      this.get<JfItem>(`/Users/${this.s.userId}/Items/${id}`),
      this.items({ AlbumArtistIds: id, IncludeItemTypes: 'MusicAlbum', SortBy: 'ProductionYear,SortName', SortOrder: 'Descending' }),
      this.items({ ArtistIds: id, IncludeItemTypes: 'Audio', SortBy: 'Album,ParentIndexNumber,IndexNumber', Limit: 300, Fields: 'Container' }),
    ]);
    return {
      title: info.Name,
      subtitle: `${albums.Items.length} альб.`,
      cover: info.ImageTags?.Primary ? info.Id : undefined,
      albums: albums.Items.map(this.album),
      tracks: tracks.Items.map(this.track),
    };
  }

  async search(query: string): Promise<MusicBrowseResult> {
    const [tracks, albums, artists] = await Promise.all([
      this.items({ searchTerm: query, IncludeItemTypes: 'Audio', Limit: 40, Fields: 'Container' }),
      this.items({ searchTerm: query, IncludeItemTypes: 'MusicAlbum', Limit: 20 }),
      this.get<{ Items: JfItem[] }>('/Artists', { userId: this.s.userId, searchTerm: query, Limit: 20, EnableImageTypes: 'Primary' }),
    ]);
    return { tracks: tracks.Items.map(this.track), albums: albums.Items.map(this.album), artists: artists.Items.map(this.artist) };
  }

  streamUrl(itemId: string): string {
    return `${this.s.url}/Audio/${encodeURIComponent(itemId)}/stream?static=true&api_key=${encodeURIComponent(this.s.token || '')}&deviceId=${encodeURIComponent(this.s.deviceId || '')}`;
  }

  coverUrl(coverId: string, size: number): string {
    return `${this.s.url}/Items/${encodeURIComponent(coverId)}/Images/Primary?maxHeight=${size}&maxWidth=${size}&quality=85`;
  }

  ext(itemId: string): string {
    return this.exts.get(itemId) || 'audio';
  }
}

// ---------------------------------------------------------------- Subsonic / Navidrome
interface SsSong {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  albumId?: string;
  duration?: number;
  track?: number;
  coverArt?: string;
  suffix?: string;
  isDir?: boolean;
}
interface SsAlbum {
  id: string;
  name?: string;
  title?: string;
  artist?: string;
  year?: number;
  coverArt?: string;
  songCount?: number;
  song?: SsSong[];
}
interface SsArtist {
  id: string;
  name: string;
  coverArt?: string;
  albumCount?: number;
  album?: SsAlbum[];
}
interface SsPlaylist {
  id: string;
  name: string;
  songCount?: number;
  duration?: number;
  coverArt?: string;
  entry?: SsSong[];
}
type SsResponse = {
  status: 'ok' | 'failed';
  error?: { code: number; message: string };
  [k: string]: unknown;
};

class SubsonicAdapter implements Adapter {
  private exts = new Map<string, string>();
  private artistCache: { at: number; list: MusicArtist[] } | null = null;
  constructor(private readonly s: StoredSource) {}

  authQuery(): URLSearchParams {
    const q = new URLSearchParams({ u: this.s.username, v: '1.16.1', c: CLIENT, f: 'json' });
    if (this.s.legacyAuth) {
      q.set('p', `enc:${Buffer.from(this.s.password || '', 'utf-8').toString('hex')}`);
    } else {
      const salt = crypto.randomBytes(8).toString('hex');
      q.set('t', crypto.createHash('md5').update(`${this.s.password || ''}${salt}`).digest('hex'));
      q.set('s', salt);
    }
    return q;
  }

  url(method: string, params: Record<string, string | number | undefined> = {}): string {
    const q = this.authQuery();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
    return `${this.s.url}/rest/${method}.view?${q.toString()}`;
  }

  async call<T = SsResponse>(method: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const out = await fetchJson<{ 'subsonic-response'?: SsResponse }>(this.url(method, params));
    const r = out['subsonic-response'];
    if (!r) throw new Error('not_subsonic');
    if (r.status !== 'ok') {
      const code = r.error?.code;
      if (code === 40 || code === 41 || code === 44) throw new Error(code === 41 ? 'token_auth_unsupported' : 'auth_failed');
      throw new Error(r.error?.message || 'subsonic_error');
    }
    return r as unknown as T;
  }

  private track = (x: SsSong): MusicTrack => {
    if (x.suffix) this.exts.set(x.id, x.suffix);
    return {
      id: `${this.s.id}:${x.id}`,
      sourceId: this.s.id,
      itemId: x.id,
      title: x.title,
      artist: x.artist,
      album: x.album,
      albumId: x.albumId,
      duration: x.duration,
      trackNo: x.track,
      cover: x.coverArt,
    };
  };

  private album = (a: SsAlbum): MusicAlbum => ({
    id: a.id,
    sourceId: this.s.id,
    title: a.name || a.title || '—',
    artist: a.artist,
    year: a.year,
    cover: a.coverArt,
    trackCount: a.songCount,
  });

  private artist = (a: SsArtist): MusicArtist => ({ id: a.id, sourceId: this.s.id, name: a.name, cover: a.coverArt, albumCount: a.albumCount });

  private playlist = (p: SsPlaylist): MusicPlaylist => ({
    id: p.id,
    sourceId: this.s.id,
    title: p.name,
    cover: p.coverArt,
    trackCount: p.songCount,
    duration: p.duration,
  });

  async browse(view: MusicView, offset: number, limit: number): Promise<MusicBrowseResult> {
    switch (view) {
      case 'albums':
      case 'recent': {
        const r = await this.call<{ albumList2?: { album?: SsAlbum[] } }>('getAlbumList2', {
          type: view === 'recent' ? 'newest' : 'alphabeticalByName',
          size: limit,
          offset,
        });
        const list = r.albumList2?.album || [];
        return { albums: list.map(this.album), hasMore: list.length === limit };
      }
      case 'artists': {
        if (!this.artistCache || Date.now() - this.artistCache.at > 5 * 60_000) {
          const r = await this.call<{ artists?: { index?: { artist?: SsArtist[] }[] } }>('getArtists');
          const list = (r.artists?.index || []).flatMap((i) => i.artist || []).map(this.artist);
          this.artistCache = { at: Date.now(), list };
        }
        const all = this.artistCache.list;
        return { artists: all.slice(offset, offset + limit), hasMore: offset + limit < all.length };
      }
      case 'playlists': {
        const r = await this.call<{ playlists?: { playlist?: SsPlaylist[] } }>('getPlaylists');
        const all = r.playlists?.playlist || [];
        return { playlists: all.slice(offset, offset + limit).map(this.playlist), hasMore: offset + limit < all.length };
      }
      case 'random': {
        const r = await this.call<{ randomSongs?: { song?: SsSong[] } }>('getRandomSongs', { size: Math.min(limit, 500) });
        return { tracks: (r.randomSongs?.song || []).map(this.track), hasMore: false };
      }
      case 'tracks': {
        // Subsonic has no "all songs" listing; an empty search3 query returns everything on Navidrome/most servers
        const r = await this.call<{ searchResult3?: { song?: SsSong[] } }>('search3', {
          query: '',
          songCount: limit,
          songOffset: offset,
          albumCount: 0,
          artistCount: 0,
        });
        const list = r.searchResult3?.song || [];
        return { tracks: list.map(this.track), hasMore: list.length === limit };
      }
    }
  }

  async item(type: 'album' | 'artist' | 'playlist', id: string): Promise<MusicItemResult> {
    if (type === 'album') {
      const r = await this.call<{ album: SsAlbum }>('getAlbum', { id });
      const a = r.album;
      return {
        title: a.name || '—',
        subtitle: [a.artist, a.year].filter(Boolean).join(' · '),
        cover: a.coverArt,
        tracks: (a.song || []).map(this.track),
      };
    }
    if (type === 'playlist') {
      const r = await this.call<{ playlist: SsPlaylist }>('getPlaylist', { id });
      return { title: r.playlist.name, cover: r.playlist.coverArt, tracks: (r.playlist.entry || []).map(this.track) };
    }
    const r = await this.call<{ artist: SsArtist }>('getArtist', { id });
    const albums = r.artist.album || [];
    // tracks of the first albums (Subsonic has no "all songs of artist")
    const details = await Promise.all(
      albums.slice(0, 12).map((a) =>
        this.call<{ album: SsAlbum }>('getAlbum', { id: a.id })
          .then((x) => x.album.song || [])
          .catch(() => [] as SsSong[]),
      ),
    );
    return {
      title: r.artist.name,
      subtitle: `${albums.length} альб.`,
      cover: r.artist.coverArt,
      albums: albums.map(this.album),
      tracks: details.flat().map(this.track),
    };
  }

  async search(query: string): Promise<MusicBrowseResult> {
    const r = await this.call<{ searchResult3?: { song?: SsSong[]; album?: SsAlbum[]; artist?: SsArtist[] } }>('search3', {
      query,
      songCount: 40,
      albumCount: 20,
      artistCount: 20,
    });
    const s = r.searchResult3 || {};
    return { tracks: (s.song || []).map(this.track), albums: (s.album || []).map(this.album), artists: (s.artist || []).map(this.artist) };
  }

  streamUrl(itemId: string): string {
    return this.url('stream', { id: itemId, format: 'raw' });
  }

  coverUrl(coverId: string, size: number): string {
    return this.url('getCoverArt', { id: coverId, size });
  }

  ext(itemId: string): string {
    return this.exts.get(itemId) || 'audio';
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const DEFAULT_CACHE_LIMIT = 5 * 1024 ** 3;
const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  webm: 'audio/webm',
  webma: 'audio/webm',
};
export const audioMime = (ext: string) => AUDIO_MIME[ext.toLowerCase()] || 'audio/mpeg';

const safe = (s: string) => s.replace(/[^\w.-]+/g, '_').slice(0, 120);

export class MusicService {
  private sources: StoredSource[];
  private adapters = new Map<string, Adapter>();
  private downloads = new Map<string, Promise<void>>();
  private readonly cacheDir: string;
  private readonly coverDir: string;

  constructor(
    private readonly kv: KvStore,
    baseDir: string,
  ) {
    this.sources = kv.getJson<StoredSource[]>('music.sources') || [];
    this.cacheDir = path.join(baseDir, 'music-cache');
    this.coverDir = path.join(this.cacheDir, 'covers');
    fs.mkdirSync(this.coverDir, { recursive: true });
    // leftovers of interrupted downloads
    for (const f of fs.readdirSync(this.cacheDir)) if (f.endsWith('.part')) fs.rmSync(path.join(this.cacheDir, f), { force: true });
  }

  private save(): void {
    this.kv.setJson('music.sources', this.sources);
  }

  private publicSource(s: StoredSource): MusicSource {
    return { id: s.id, kind: s.kind, name: s.name, url: s.url, username: s.username, addedBy: s.addedBy, ok: s.ok, error: s.error };
  }

  list(): MusicSource[] {
    return this.sources.map((s) => this.publicSource(s));
  }

  get hasSources(): boolean {
    return this.sources.length > 0;
  }

  private source(id: string): StoredSource {
    const s = this.sources.find((x) => x.id === id);
    if (!s) throw new Error('source_not_found');
    return s;
  }

  private adapter(id: string): Adapter {
    let a = this.adapters.get(id);
    if (!a) {
      const s = this.source(id);
      a = s.kind === 'jellyfin' ? new JellyfinAdapter(s) : new SubsonicAdapter(s);
      this.adapters.set(id, a);
    }
    return a;
  }

  async add(p: MusicSourceAddPayload, addedBy?: string): Promise<MusicSource> {
    const kind: MusicSourceKind = p.kind === 'jellyfin' ? 'jellyfin' : 'subsonic';
    const url = normalizeServerUrl(p.url || '');
    const username = String(p.username || '').trim();
    if (!url || !username) throw new Error('bad_params');
    const id = `m${crypto.randomBytes(4).toString('hex')}`;
    const s: StoredSource = { id, kind, url, username, name: p.name?.trim() || '', addedBy, ok: true };
    if (kind === 'jellyfin') {
      s.deviceId = `tvbox-${crypto.randomBytes(6).toString('hex')}`;
      const out = await jellyfinLogin(url, username, String(p.password || ''), s.deviceId);
      s.token = out.token;
      s.userId = out.userId;
      s.name = s.name || out.serverName || 'Jellyfin';
    } else {
      s.password = String(p.password || '');
      const a = new SubsonicAdapter(s);
      try {
        await a.call('ping');
      } catch (e) {
        if ((e as Error).message !== 'token_auth_unsupported') throw e;
        s.legacyAuth = true;
        await new SubsonicAdapter(s).call('ping');
      }
      s.name = s.name || (/navidrome/i.test(url) ? 'Navidrome' : 'Subsonic');
    }
    // same server + user again → replace
    this.sources = this.sources.filter((x) => !(x.url === s.url && x.username.toLowerCase() === s.username.toLowerCase()));
    this.sources.push(s);
    this.save();
    return this.publicSource(s);
  }

  remove(id: string): void {
    const s = this.sources.find((x) => x.id === id);
    if (!s) return;
    if (s.kind === 'jellyfin' && s.token) {
      void fetch(`${s.url}/Sessions/Logout`, { method: 'POST', headers: { Authorization: jfAuthHeader(s) } }).catch(() => undefined);
    }
    this.sources = this.sources.filter((x) => x.id !== id);
    this.adapters.delete(id);
    this.save();
  }

  private async guard<T>(id: string, fn: (a: Adapter) => Promise<T>): Promise<T> {
    const s = this.source(id);
    try {
      const out = await fn(this.adapter(id));
      if (!s.ok) {
        s.ok = true;
        s.error = undefined;
        this.save();
      }
      return out;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === 'auth_failed' || msg === 'unreachable') {
        s.ok = false;
        s.error = msg;
        this.save();
      }
      throw e;
    }
  }

  private markCached<T extends MusicBrowseResult | MusicItemResult>(r: T): T {
    for (const t of r.tracks || []) t.cached = this.isCached(t.sourceId, t.itemId);
    return r;
  }

  async browse(sourceId: string, view: MusicView, offset = 0, limit = PAGE): Promise<MusicBrowseResult> {
    return this.markCached(await this.guard(sourceId, (a) => a.browse(view, Math.max(0, offset), Math.min(Math.max(limit, 1), 500))));
  }

  async item(sourceId: string, type: 'album' | 'artist' | 'playlist', id: string): Promise<MusicItemResult> {
    return this.markCached(await this.guard(sourceId, (a) => a.item(type, id)));
  }

  async search(query: string, sourceId?: string): Promise<MusicBrowseResult> {
    const q = query.trim();
    if (!q) return { tracks: [], albums: [], artists: [] };
    const ids = sourceId ? [sourceId] : this.sources.map((s) => s.id);
    const parts = await Promise.all(ids.map((id) => this.guard(id, (a) => a.search(q)).catch(() => ({}) as MusicBrowseResult)));
    return this.markCached({
      tracks: parts.flatMap((p) => p.tracks || []),
      albums: parts.flatMap((p) => p.albums || []),
      artists: parts.flatMap((p) => p.artists || []),
    });
  }

  // ------------------------------------------------------------------ covers
  coverFile(sourceId: string, coverId: string): string {
    return path.join(this.coverDir, `${safe(sourceId)}_${safe(coverId)}.jpg`);
  }

  /** Small cover image, cached on disk. */
  async cover(sourceId: string, coverId: string): Promise<Buffer | null> {
    const file = this.coverFile(sourceId, coverId);
    try {
      return await fs.promises.readFile(file);
    } catch {
      // fetch below
    }
    try {
      const res = await fetch(this.adapter(sourceId).coverUrl(coverId, 300));
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) return null;
      await fs.promises.writeFile(file, buf).catch(() => undefined);
      return buf;
    } catch {
      return null;
    }
  }

  async coverDataUrl(sourceId: string, coverId: string): Promise<string | null> {
    const buf = await this.cover(sourceId, coverId);
    if (!buf) return null;
    const mime = buf[0] === 0x89 ? 'image/png' : buf[0] === 0x52 ? 'image/webp' : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  }

  // ------------------------------------------------------------------ audio + cache
  private cachePrefix(sourceId: string, itemId: string): string {
    return `${safe(sourceId)}_${safe(itemId)}.`;
  }

  cachedFile(sourceId: string, itemId: string): string | null {
    const prefix = this.cachePrefix(sourceId, itemId);
    try {
      const f = fs.readdirSync(this.cacheDir).find((x) => x.startsWith(prefix) && !x.endsWith('.part'));
      return f ? path.join(this.cacheDir, f) : null;
    } catch {
      return null;
    }
  }

  isCached(sourceId: string, itemId: string): boolean {
    return !!this.cachedFile(sourceId, itemId);
  }

  upstream(sourceId: string, itemId: string): { url: string; ext: string } {
    const a = this.adapter(sourceId);
    return { url: a.streamUrl(itemId), ext: a.ext(itemId) };
  }

  /** Download a track into the cache (once). */
  ensureCached(sourceId: string, itemId: string): Promise<void> {
    const key = `${sourceId}:${itemId}`;
    if (this.isCached(sourceId, itemId)) {
      const f = this.cachedFile(sourceId, itemId);
      if (f) fs.utimes(f, new Date(), new Date(), () => undefined);
      return Promise.resolve();
    }
    const running = this.downloads.get(key);
    if (running) return running;
    const job = (async () => {
      const { url, ext: guess } = this.upstream(sourceId, itemId);
      const res = await fetch(url);
      if (!res.ok || !res.body) throw httpError(res.status);
      const type = res.headers.get('content-type') || '';
      const ext =
        guess !== 'audio'
          ? guess
          : (Object.entries(AUDIO_MIME).find(([, m]) => type.startsWith(m))?.[0] ?? (/flac/.test(type) ? 'flac' : 'mp3'));
      const part = path.join(this.cacheDir, `${this.cachePrefix(sourceId, itemId)}${ext}.part`);
      const out = fs.createWriteStream(part);
      const { Readable } = await import('node:stream');
      const { pipeline } = await import('node:stream/promises');
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), out);
      fs.renameSync(part, part.slice(0, -5));
      this.enforceLimit();
    })()
      .catch((e) => {
        console.warn('[music] cache failed', key, (e as Error).message);
        for (const f of fs.readdirSync(this.cacheDir)) {
          if (f.startsWith(this.cachePrefix(sourceId, itemId)) && f.endsWith('.part')) fs.rmSync(path.join(this.cacheDir, f), { force: true });
        }
      })
      .finally(() => this.downloads.delete(key));
    this.downloads.set(key, job);
    return job;
  }

  get cacheLimit(): number {
    return this.kv.getJson<number>('music.cacheLimit') || DEFAULT_CACHE_LIMIT;
  }

  setCacheLimit(bytes: number): void {
    this.kv.setJson('music.cacheLimit', Math.max(256 * 1024 ** 2, Math.round(bytes)));
    this.enforceLimit();
  }

  private files(): { p: string; size: number; at: number }[] {
    try {
      return fs
        .readdirSync(this.cacheDir, { withFileTypes: true })
        .filter((d) => d.isFile() && !d.name.endsWith('.part'))
        .map((d) => {
          const p = path.join(this.cacheDir, d.name);
          const st = fs.statSync(p);
          return { p, size: st.size, at: st.mtimeMs };
        });
    } catch {
      return [];
    }
  }

  enforceLimit(): void {
    const files = this.files().sort((a, b) => a.at - b.at);
    let total = files.reduce((s, f) => s + f.size, 0);
    const limit = this.cacheLimit;
    for (const f of files) {
      if (total <= limit) break;
      fs.rmSync(f.p, { force: true });
      total -= f.size;
    }
  }

  cacheInfo(): MusicCacheInfo {
    const files = this.files();
    return { bytes: files.reduce((s, f) => s + f.size, 0), files: files.length, limitBytes: this.cacheLimit };
  }

  clearCache(): void {
    for (const f of this.files()) fs.rmSync(f.p, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Local HTTP routes used by the TV renderer
// ---------------------------------------------------------------------------


export function registerMusicRoutes(server: MediaServer, music: MusicService): void {
  // /music?s=<sourceId>&i=<itemId> — from cache, else proxied (with Range) while caching in background
  server.route('/music', async (req, res, url) => {
    const s = url.searchParams.get('s') || '';
    const i = url.searchParams.get('i') || '';
    const cached = music.cachedFile(s, i);
    if (cached) {
      fs.utimes(cached, new Date(), new Date(), () => undefined);
      return sendFile(req, res, cached);
    }
    let up: { url: string; ext: string };
    try {
      up = music.upstream(s, i);
    } catch {
      res.writeHead(404).end();
      return;
    }
    void music.ensureCached(s, i);
    await proxy(req, res, up.url, up.ext);
  });

  server.route('/music-cover', async (_req, res, url) => {
    const buf = await music.cover(url.searchParams.get('s') || '', url.searchParams.get('c') || '');
    if (!buf) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': buf[0] === 0x89 ? 'image/png' : 'image/jpeg', 'cache-control': 'max-age=86400' });
    res.end(buf);
  });
}

async function proxy(req: http.IncomingMessage, res: http.ServerResponse, url: string, ext: string): Promise<void> {
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());
  try {
    const up = await fetch(url, { headers: req.headers.range ? { Range: String(req.headers.range) } : {}, signal: ctrl.signal });
    const headers: Record<string, string> = { 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
    const type = up.headers.get('content-type');
    headers['content-type'] = type && /^audio\//.test(type) ? type : audioMime(ext);
    for (const h of ['content-length', 'content-range']) {
      const v = up.headers.get(h);
      if (v) headers[h] = v;
    }
    res.writeHead(up.status, headers);
    if (req.method === 'HEAD' || !up.body) return void res.end();
    const { Readable } = await import('node:stream');
    const body = Readable.fromWeb(up.body as import('node:stream/web').ReadableStream);
    body.on('error', () => res.destroy());
    body.pipe(res);
  } catch {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  }
}
