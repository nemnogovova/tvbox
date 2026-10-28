import type { NavKey, TorrentMeta } from './features';
import type { PlayRequest, IdleSettings, MediaItem, PowerAction, RepeatMode, TvSettings, MusicSourceKind, MusicView } from './types';

export type ControlCommand =
  | { type: 'PLAY_PAUSE' }
  | { type: 'PLAY' }
  | { type: 'PAUSE' }
  | { type: 'STOP' }
  | { type: 'SEEK'; position: number }
  | { type: 'SEEK_RELATIVE'; delta: number }
  | { type: 'VOLUME'; volume: number }
  | { type: 'VOLUME_STEP'; delta: number }
  | { type: 'MUTE'; muted?: boolean }
  | { type: 'FULLSCREEN'; fullscreen?: boolean }
  | { type: 'SUBTITLES'; id: string | null }
  | { type: 'AUDIO_TRACK'; index: number }
  | { type: 'PLAY_SOURCE'; request: PlayRequest }
  | { type: 'QUEUE_ADD'; request: PlayRequest }
  | { type: 'QUEUE_REMOVE'; id: string }
  | { type: 'QUEUE_CLEAR' }
  /** Replace the queue: play requests[startIndex], the rest is queued */
  | { type: 'QUEUE_SET'; requests: PlayRequest[]; startIndex?: number; shuffle?: boolean }
  | { type: 'QUEUE_JUMP'; id: string }
  | { type: 'QUEUE_MOVE'; id: string; to: number }
  | { type: 'QUEUE_SHUFFLE' }
  | { type: 'REPEAT'; mode: RepeatMode }
  | { type: 'PREVIOUS' }
  | { type: 'NEXT' }
  /** D-pad: goes to YouTube TV, the program in front or the TVBox screen */
  | { type: 'NAV'; key: NavKey }
  /** Type text into whatever has focus on the TV (YouTube search, a program) */
  | { type: 'TEXT'; text: string };

export type ControlType = ControlCommand['type'];

export interface TorrentAddPayload {
  magnet?: string;
  /** base64 encoded .torrent file */
  torrentBase64?: string;
  /** Path of a .torrent file on the TV PC */
  torrentPath?: string;
  /** Indexer download link (Jackett / Prowlarr); resolved by the TV */
  link?: string;
  name?: string;
  /** Start streaming as soon as possible */
  play?: boolean;
  /** Catalog item the torrent belongs to (correct title / poster right away) */
  meta?: TorrentMeta;
}

export interface TorrentRemovePayload {
  torrentId: string;
  deleteFiles?: boolean;
}

export interface MediaUpdatePayload {
  mediaId: string;
  patch: Partial<Pick<MediaItem, 'title' | 'overview' | 'poster' | 'backdrop' | 'year' | 'season' | 'episode' | 'episodeTitle'>>;
}

export interface MediaDeletePayload {
  mediaId: string;
}

export interface TmdbSearchPayload {
  query: string;
  type?: 'movie' | 'tv';
}

export interface MediaApplyTmdbPayload {
  mediaId: string;
  tmdbId: number;
  type: 'movie' | 'tv';
  /** Apply to every episode of the same show */
  wholeShow?: boolean;
}

export interface FsListPayload {
  path?: string;
  /** apps – start from Program Files / games folders and show programs */
  purpose?: 'media' | 'apps';
}

export interface PowerPayload {
  action: PowerAction;
}

export type IdleUpdatePayload = Partial<IdleSettings>;
export type TvSettingsUpdatePayload = Partial<TvSettings>;

export interface GuestsUpdatePayload {
  add?: string[];
  remove?: string[];
}

export interface SignalMessage {
  /** Socket id of the sender, or 'tv' (filled in by the server) */
  from?: string;
  /** Target socket id, or 'tv' */
  to: string;
  /** Session id of one cast (lets the TV drop stale signaling) */
  sid: string;
  payload?: unknown;
  /** Optional description shown on the TV */
  label?: string;
}

export interface MusicSourceAddPayload {
  kind: MusicSourceKind;
  url: string;
  username: string;
  password: string;
  name?: string;
}

export interface MusicBrowsePayload {
  sourceId: string;
  view: MusicView;
  offset?: number;
  limit?: number;
}

export interface MusicItemPayload {
  sourceId: string;
  type: 'album' | 'artist' | 'playlist';
  id: string;
}

export interface MusicSearchPayload {
  query: string;
  sourceId?: string;
}

export interface UploadBeginPayload {
  name: string;
  size: number;
  type: string;
  /** screensaver pictures / videos, or the home screen background */
  purpose: 'screensaver' | 'wallpaper';
}

export interface UploadEndResult {
  src: string;
  name: string;
  /** small JPEG preview (data: URL) for the remote */
  thumb?: string;
}

export interface UploadChunkPayload {
  uploadId: string;
  index: number;
  data: ArrayBuffer | Uint8Array;
}
