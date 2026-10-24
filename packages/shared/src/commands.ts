import type {
  PlayerState,
  MediaItem,
  TorrentInfo,
  GuestEntry,
  WidgetConfig,
  IdleSettings,
  PowerAction,
  FsEntry,
} from './types';

export interface PlayCommand {
  type: 'PLAY';
  videoId?: string;
  mediaId?: string;
}

export interface PauseCommand {
  type: 'PAUSE';
}

export interface ResumeCommand {
  type: 'RESUME';
}

export interface SeekCommand {
  type: 'SEEK';
  position: number;
}

export interface VolumeCommand {
  type: 'VOLUME';
  volume: number;
}

export interface MuteCommand {
  type: 'MUTE';
  muted: boolean;
}

export interface FullscreenCommand {
  type: 'FULLSCREEN';
  fullscreen: boolean;
}

export interface PlaySourceCommand {
  type: 'PLAY_SOURCE';
  source: 'youtube' | 'local' | 'torrent' | 'webrtc';
  url?: string;
  mediaId?: string;
  videoId?: string;
  torrentId?: string;
  title?: string;
}

export interface StopCommand {
  type: 'STOP';
}

export type ControlCommand =
  | PlayCommand
  | PauseCommand
  | ResumeCommand
  | SeekCommand
  | VolumeCommand
  | MuteCommand
  | FullscreenCommand
  | PlaySourceCommand
  | StopCommand;

export interface CatalogGetPayload {
  requestId?: string;
}

export interface TorrentAddPayload {
  magnet?: string;
  torrentBuffer?: string;
  name?: string;
}

export interface TorrentWatchPayload {
  torrentId: string;
  fileIndex?: number;
}

export interface FileDeletePayload {
  mediaId: string;
  fileId?: string;
}

export interface MetadataUpdatePayload {
  mediaId: string;
  title?: string;
  overview?: string;
  poster?: string;
  backdrop?: string;
  tmdbId?: number;
  rating?: number;
  releaseDate?: string;
  genres?: string[];
}

export interface FsListPayload {
  path?: string;
}

export interface FsListResult {
  path: string;
  entries: FsEntry[];
}

export interface PowerPayload {
  action: PowerAction;
}

export interface GuestsUpdatePayload {
  add?: string[];
  remove?: string[];
}

export interface GuestsResult {
  guests: GuestEntry[];
  dictatorMode: boolean;
}

export interface WidgetsUpdatePayload {
  widgets: WidgetConfig[];
  settings?: Partial<IdleSettings>;
}

export interface WidgetsResult {
  widgets: WidgetConfig[];
  settings: IdleSettings;
}

export interface SignalMessage {
  from: string;
  to: string;
  kind: 'offer' | 'answer' | 'ice';
  payload: unknown;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

export const TORRENT_TARGET = 'tv';
