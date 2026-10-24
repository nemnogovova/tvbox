export type Role = 'owner' | 'guest' | 'device';

export interface User {
  id: string;
  email: string;
  name: string;
  picture?: string;
  role: Role;
}

export type PlayerSource = 'none' | 'youtube' | 'local' | 'webrtc' | 'torrent';

export interface PlayerState {
  source: PlayerSource;
  playing: boolean;
  paused: boolean;
  title: string;
  subtitle?: string;
  duration: number;
  position: number;
  volume: number;
  muted: boolean;
  fullscreen: boolean;
  videoId?: string;
  mediaId?: string;
  startedAt?: number;
}

export type MediaType = 'movie' | 'series' | 'episode' | 'audio' | 'photo' | 'file';

export interface MediaItem {
  id: string;
  type: MediaType;
  title: string;
  originalTitle?: string;
  path?: string;
  fileId?: string;
  poster?: string;
  backdrop?: string;
  overview?: string;
  rating?: number;
  releaseDate?: string;
  genres?: string[];
  tmdbId?: number;
  seriesId?: string;
  season?: number;
  episode?: number;
  episodeCount?: number;
  progress?: number;
  duration?: number;
  addedAt?: number;
  size?: number;
}

export type TorrentStatus = 'downloading' | 'seeding' | 'done' | 'error' | 'paused';

export interface TorrentFile {
  index: number;
  name: string;
  path: string;
  length: number;
  downloaded: number;
  progress: number;
  streamUrl?: string;
}

export interface TorrentInfo {
  id: string;
  infoHash?: string;
  name: string;
  magnet?: string;
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  peers: number;
  size: number;
  downloaded: number;
  files: TorrentFile[];
  status: TorrentStatus;
  error?: string;
  streaming?: boolean;
  addedAt: number;
}

export interface GuestEntry {
  email: string;
  name?: string;
  addedAt: number;
}

export interface ServerConfig {
  guests: GuestEntry[];
  dictatorMode: boolean;
}

export type WidgetType =
  | 'clock'
  | 'weather'
  | 'continue-watching'
  | 'recently-added'
  | 'qr'
  | 'api'
  | 'custom';

export interface ApiWidgetConfig {
  url: string;
  refreshInterval?: number;
}

export interface CustomWidgetConfig {
  html: string;
  css: string;
  js: string;
}

export interface WidgetConfig {
  id: string;
  type: WidgetType;
  title?: string;
  gridArea?: string;
  enabled: boolean;
  api?: ApiWidgetConfig;
  custom?: CustomWidgetConfig;
  settings?: Record<string, unknown>;
}

export interface IdleSettings {
  showClock: boolean;
  showWeather: boolean;
  showQr: boolean;
  weatherCity?: string;
  screensaver: 'off' | 'black' | 'clock' | 'wallpaper';
  screensaverDelayMs: number;
  widgets: WidgetConfig[];
}

export type PowerAction = 'sleep' | 'shutdown' | 'reboot';

export type FsEntryKind = 'dir' | 'file' | 'video' | 'audio' | 'image' | 'other';

export interface FsEntry {
  name: string;
  path: string;
  kind: FsEntryKind;
  size?: number;
  modifiedAt?: number;
}

export interface PresenceInfo {
  tvConnected: boolean;
  ownerConnected: boolean;
  guestCount: number;
  tvId?: string;
}

export interface AuthPayload {
  idToken?: string;
  deviceToken?: string;
}

export interface AuthResult {
  ok: boolean;
  user?: User;
  error?: string;
  presence?: PresenceInfo;
}
