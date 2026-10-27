import type { AppsState, IndexerSettings, IndexerStatus, YoutubeState } from './features';
// ---------------------------------------------------------------------------
// Users & roles
// ---------------------------------------------------------------------------

export type Role = 'owner' | 'guest' | 'device';

export interface User {
  /** TVBox account id */
  id: string;
  /** Google e-mail ('' for login/password accounts) */
  email: string;
  username?: string;
  name: string;
  picture?: string;
  role: Role;
}

export type AccountRole = 'owner' | 'guest' | 'pending';

/** What the account owner sees about their own account. */
export interface AccountInfo {
  id: string;
  name: string;
  username?: string;
  hasPassword: boolean;
  google?: { email: string; picture?: string };
  role: AccountRole;
  createdAt: number;
}

/** What the TVBox owner sees in the admin list. */
export interface AccountSummary {
  id: string;
  name: string;
  username?: string;
  email?: string;
  role: AccountRole;
  createdAt: number;
  lastSeenAt?: number;
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

export type PlayerSource = 'none' | 'youtube' | 'local' | 'torrent' | 'url' | 'webrtc' | 'music';
export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

/** What the remote asks the TV to play. */
export interface PlayRequest {
  source: 'youtube' | 'local' | 'torrent' | 'url' | 'music';
  /** Track of a connected music service (source: 'music') */
  track?: MusicTrack;
  /** YouTube link / direct http(s) media URL */
  url?: string;
  /** Absolute path of a file on the TV PC */
  path?: string;
  /** Catalog item id */
  mediaId?: string;
  torrentId?: string;
  fileIndex?: number;
  title?: string;
  /** Resume position in seconds (TV resumes from saved progress if omitted) */
  startAt?: number;
}

export interface QueueItem {
  id: string;
  title: string;
  request: PlayRequest;
}

export interface PlayerState {
  source: PlayerSource;
  status: PlayerStatus;
  title: string;
  subtitle?: string;
  poster?: string;
  backdrop?: string;
  duration: number;
  position: number;
  /** System (OS) volume, 0..1 */
  volume: number;
  muted: boolean;
  fullscreen: boolean;
  mediaId?: string;
  error?: string;
  queue: QueueItem[];
  /** Subtitle tracks available for the current item */
  subtitles?: { id: string; label: string }[];
  subtitleId?: string | null;
  /** Audio tracks (dubs) of the current file */
  audioTracks?: { index: number; label: string }[];
  audioIndex?: number;
  /** Music: artist / album line and repeat mode */
  artist?: string;
  album?: string;
  repeat?: RepeatMode;
  /** Can go to the previous track */
  hasPrevious?: boolean;
  updatedAt: number;
}

export type RepeatMode = 'off' | 'all' | 'one';

export const EMPTY_PLAYER_STATE: PlayerState = {
  source: 'none',
  status: 'idle',
  title: '',
  duration: 0,
  position: 0,
  volume: 0.5,
  muted: false,
  fullscreen: true,
  queue: [],
  updatedAt: 0,
};

// ---------------------------------------------------------------------------
// Media library
// ---------------------------------------------------------------------------

export type MediaKind = 'movie' | 'episode' | 'video' | 'audio' | 'photo';

export interface MediaItem {
  id: string;
  kind: MediaKind;
  /** Display title. For episodes: the show title. */
  title: string;
  /** Group key for series (all episodes of one show share it) */
  showKey?: string;
  episodeTitle?: string;
  season?: number;
  episode?: number;
  year?: number;
  path: string;
  origin: 'local' | 'torrent';
  /** Torrent infoHash if the file came from a torrent */
  torrentId?: string;
  poster?: string;
  backdrop?: string;
  overview?: string;
  rating?: number;
  genres?: string[];
  tmdbId?: number;
  tmdbType?: 'movie' | 'tv';
  size?: number;
  addedAt: number;
  /** Watch progress */
  position?: number;
  duration?: number;
  watchedAt?: number;
}

export interface TmdbResult {
  id: number;
  type: 'movie' | 'tv';
  title: string;
  originalTitle?: string;
  year?: number;
  overview?: string;
  poster?: string;
  backdrop?: string;
  rating?: number;
}

// ---------------------------------------------------------------------------
// Torrents
// ---------------------------------------------------------------------------

export type TorrentStatus = 'metadata' | 'downloading' | 'done' | 'error';

export interface TorrentFileInfo {
  index: number;
  name: string;
  length: number;
  progress: number;
  playable: boolean;
}

export interface TorrentInfo {
  id: string;
  name: string;
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  peers: number;
  size: number;
  downloaded: number;
  status: TorrentStatus;
  error?: string;
  files: TorrentFileInfo[];
  addedAt: number;
  /** Seconds until done (estimate) */
  eta?: number;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export interface GuestEntry {
  email: string;
  name?: string;
  addedAt: number;
}

export interface AdminState {
  /** Google e-mails invited as guests */
  guests: GuestEntry[];
  accounts: AccountSummary[];
  dictatorMode: boolean;
  /** Anyone may request access with login/password (owner approves) */
  registrationOpen: boolean;
}

// ---------------------------------------------------------------------------
// Idle screen / widgets
// ---------------------------------------------------------------------------

export type WidgetType =
  | 'clock'
  | 'weather'
  | 'continue'
  | 'recent'
  | 'qr'
  | 'api'
  | 'custom';

export interface WidgetConfig {
  id: string;
  type: WidgetType;
  title?: string;
  enabled: boolean;
  /** Grid size on the 12x6 idle-screen grid */
  w: number;
  h: number;
  /** API widget: URL returning JSON or text, optional dot-path to the value */
  apiUrl?: string;
  apiPath?: string;
  apiRefreshSec?: number;
  /** Custom widget */
  html?: string;
  css?: string;
  js?: string;
}

export type ScreensaverKind = 'off' | 'black' | 'clock' | 'wallpaper' | 'media';

/** Picture or video for the screensaver: an http(s) URL or a file uploaded to the TV (tvbox-file:<name>). */
export interface ScreensaverItem {
  id: string;
  type: 'image' | 'video';
  src: string;
  name?: string;
}

export interface IdleSettings {
  widgets: WidgetConfig[];
  weatherCity: string;
  screensaver: ScreensaverKind;
  screensaverMinutes: number;
  /** For 'media' */
  screensaverMedia?: ScreensaverItem[];
  /** Seconds per picture */
  screensaverInterval?: number;
  screensaverShuffle?: boolean;
  /** Show a small clock over pictures/videos */
  screensaverClock?: boolean;
  /** Mute screensaver videos */
  screensaverMuted?: boolean;
  wallpaper?: string;
}

export const DEFAULT_WIDGETS: WidgetConfig[] = [
  { id: 'clock', type: 'clock', enabled: true, w: 7, h: 2 },
  { id: 'weather', type: 'weather', enabled: true, w: 5, h: 2 },
  { id: 'continue', type: 'continue', enabled: true, w: 9, h: 2 },
  { id: 'qr', type: 'qr', enabled: true, w: 3, h: 2 },
  { id: 'recent', type: 'recent', enabled: true, w: 12, h: 2 },
];

export const DEFAULT_IDLE_SETTINGS: IdleSettings = {
  widgets: DEFAULT_WIDGETS,
  weatherCity: 'Belgrade',
  screensaver: 'clock',
  screensaverMinutes: 10,
  screensaverMedia: [],
  screensaverInterval: 20,
  screensaverShuffle: true,
  screensaverClock: true,
  screensaverMuted: true,
};

// ---------------------------------------------------------------------------
// TV settings (editable from the remote by the owner)
// ---------------------------------------------------------------------------

export interface TvSettings {
  tmdbApiKey: string;
  mediaDirs: string[];
  downloadDir: string;
  autostart: boolean;
  /** Language for TMDb metadata, e.g. ru-RU */
  language: string;
  /** Torrent search for the catalog (Jackett / Prowlarr) */
  indexer?: IndexerSettings | null;
  /** Read-only info reported by the TV */
  indexerStatus?: IndexerStatus;
  youtubeSignedIn?: boolean;
  version?: string;
}

// ---------------------------------------------------------------------------
// Filesystem browser
// ---------------------------------------------------------------------------

export type FsEntryKind = 'dir' | 'video' | 'audio' | 'image' | 'torrent' | 'app' | 'other';

export interface FsEntry {
  name: string;
  path: string;
  kind: FsEntryKind;
  size?: number;
  modifiedAt?: number;
}

export interface FsListResult {
  path: string;
  parent: string | null;
  entries: FsEntry[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Presence / auth
// ---------------------------------------------------------------------------

export interface PresenceInfo {
  tvConnected: boolean;
  tvName?: string;
  tvVersion?: string;
  remotes: { name: string; role: Role }[];
}

export interface AuthPayload {
  /** Session token issued by the backend (preferred) */
  token?: string;
  /** Raw Google ID token (web sign-in, exchanged for a session) */
  idToken?: string;
  /** Legacy static device token from .env */
  deviceToken?: string;
  /** App version of the connecting client (TV reports it) */
  version?: string;
}

export interface AuthResult {
  ok: boolean;
  user?: User;
  isTv?: boolean;
  /** Fresh session token (returned when signing in with a Google ID token) */
  token?: string;
  error?: string;
}

export type LinkKind = 'tv' | 'remote';

export interface LinkStartPayload {
  kind: LinkKind;
  name?: string;
}

export interface LinkStartResult {
  ok: boolean;
  code?: string;
  url?: string;
  expiresAt?: number;
  error?: string;
}

export interface LinkInfoResult {
  ok: boolean;
  kind?: LinkKind;
  name?: string;
  error?: string;
}

export interface LinkDonePayload {
  token: string;
}

/** Snapshot sent to a remote right after it authenticates. */
export interface SyncPayload {
  presence: PresenceInfo;
  player: PlayerState;
  catalog: MediaItem[];
  torrents: TorrentInfo[];
  idle: IdleSettings | null;
  admin: AdminState | null;
  apps?: AppsState | null;
  youtube?: YoutubeState | null;
}

export type PowerAction = 'sleep' | 'shutdown' | 'reboot' | 'restart-app';

/** Generic ack shape for request/response events */
export interface Ack<T = undefined> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ---------------------------------------------------------------------------
// Music services (Jellyfin, Subsonic / Navidrome)
// ---------------------------------------------------------------------------

export type MusicSourceKind = 'jellyfin' | 'subsonic';

export interface MusicSource {
  id: string;
  kind: MusicSourceKind;
  name: string;
  url: string;
  username: string;
  /** TVBox account that connected it */
  addedBy?: string;
  ok?: boolean;
  error?: string;
}

export interface MusicTrack {
  /** `${sourceId}:${itemId}` */
  id: string;
  sourceId: string;
  itemId: string;
  title: string;
  artist?: string;
  album?: string;
  albumId?: string;
  duration?: number;
  cover?: string;
  trackNo?: number;
  cached?: boolean;
}

export interface MusicAlbum {
  id: string;
  sourceId: string;
  title: string;
  artist?: string;
  year?: number;
  cover?: string;
  trackCount?: number;
}

export interface MusicArtist {
  id: string;
  sourceId: string;
  name: string;
  cover?: string;
  albumCount?: number;
}

export interface MusicPlaylist {
  id: string;
  sourceId: string;
  title: string;
  cover?: string;
  trackCount?: number;
  duration?: number;
}

export type MusicView = 'albums' | 'artists' | 'playlists' | 'recent' | 'random' | 'tracks';

export interface MusicBrowseResult {
  albums?: MusicAlbum[];
  artists?: MusicArtist[];
  playlists?: MusicPlaylist[];
  tracks?: MusicTrack[];
  hasMore?: boolean;
}

export interface MusicItemResult {
  title: string;
  subtitle?: string;
  cover?: string;
  tracks: MusicTrack[];
  albums?: MusicAlbum[];
}

export interface MusicCacheInfo {
  bytes: number;
  files: number;
  limitBytes: number;
}

// ---------------------------------------------------------------------------
// Releases / updates
// ---------------------------------------------------------------------------

export type ReleasePlatform = 'windows' | 'android';

export interface ReleaseInfo {
  version: string;
  file: string;
  size: number;
  url: string;
  publishedAt: number;
}

export type ReleasesManifest = Partial<Record<ReleasePlatform, ReleaseInfo>>;
