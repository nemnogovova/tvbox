// Types shared by the Electron main process, the preload script and the renderer.
import type { IdleSettings, MediaItem, PlayerSource, SignalMessage } from '@tvbox/shared';

export interface IceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface TranscodeSpec {
  /** Base URL of the transcode endpoint without the &start= parameter */
  base: string;
}

export interface SubtitleTrack {
  id: string;
  label: string;
  /** Base URL; renderer appends &start=<offset> for transcoded streams */
  url: string;
}

export interface PlayTarget {
  key: string;
  kind: 'youtube' | 'video' | 'audio' | 'image';
  source: Exclude<PlayerSource, 'none' | 'webrtc'>;
  title: string;
  subtitle?: string;
  poster?: string;
  backdrop?: string;
  mediaId?: string;
  videoId?: string;
  /** Direct URL (native seeking) */
  url?: string;
  /** Transcoded stream (seeking restarts ffmpeg at an offset) */
  transcode?: TranscodeSpec;
  /** Transcode to fall back to if the direct URL fails to decode */
  fallback?: TranscodeSpec;
  duration?: number;
  startAt?: number;
  subtitles?: SubtitleTrack[];
  audioTracks?: { index: number; label: string }[];
  audioIndex?: number;
  /** Music track info */
  artist?: string;
  album?: string;
  /** Poster reference for remotes (music covers live on the TV: "music-cover:<sourceId>:<coverId>") */
  coverRef?: string;
}

export type RendererStatus = 'loading' | 'playing' | 'paused' | 'error' | 'ended';

export interface RendererReport {
  key: string;
  status: RendererStatus;
  position: number;
  duration: number;
  error?: string;
  subtitleId?: string | null;
  /** Direct playback failed — please give me the transcoded variant */
  needFallback?: boolean;
  /** Switching audio natively is impossible — restart with this track */
  needAudio?: number;
}

export type PlayerCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'toggle' }
  | { type: 'seek'; position: number }
  | { type: 'stop' }
  | { type: 'subtitles'; id: string | null }
  | { type: 'audio'; index: number };

export type ConnState = 'connecting' | 'pairing' | 'online' | 'offline' | 'replaced';

export interface TvStatus {
  conn: ConnState;
  serverUrl: string;
  publicUrl: string;
  tvName: string;
  pairing: { code: string; url: string; expiresAt: number } | null;
  paired: boolean;
  error?: string;
}

export interface CastState {
  active: boolean;
  label?: string;
  kind?: 'stream' | 'image';
}

export interface TvBridge {
  getStatus: () => Promise<TvStatus>;
  getCatalog: () => Promise<MediaItem[]>;
  getIdle: () => Promise<IdleSettings>;
  getIceServers: () => Promise<IceServerLike[]>;
  setServerUrl: (url: string) => Promise<TvStatus>;
  report: (r: RendererReport) => void;
  castState: (s: CastState) => void;
  signal: (event: string, msg: SignalMessage) => void;
  localKey: (key: string) => void;
  onStatus: (cb: (s: TvStatus) => void) => () => void;
  onLoad: (cb: (t: PlayTarget | null) => void) => () => void;
  onCommand: (cb: (c: PlayerCommand) => void) => () => void;
  onCatalog: (cb: (c: MediaItem[]) => void) => () => void;
  onIdle: (cb: (s: IdleSettings) => void) => () => void;
  onSignal: (cb: (p: { event: string; msg: SignalMessage }) => void) => () => void;
  onCastStop: (cb: () => void) => () => void;
  onToast: (cb: (t: { message: string; kind?: string }) => void) => () => void;
  /** The mouse moved (tracked by the main process) */
  onActivity: (cb: () => void) => () => void;
  /** A program is starting from the remote (null when it is on screen / failed) */
  onLaunching: (cb: (a: { name: string; icon?: string } | null) => void) => () => void;
}

declare global {
  interface Window {
    tvbox: TvBridge;
  }
}
