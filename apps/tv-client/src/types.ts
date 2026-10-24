import type { PlayerState, SignalMessage, IdleSettings, WidgetConfig, MediaItem } from '@tvbox/shared';

export interface PlayTarget {
  kind: 'youtube' | 'local' | 'torrent' | 'webrtc';
  url?: string;
  videoId?: string;
  title?: string;
  mediaId?: string;
}

export interface TvSettings {
  backendUrl: string;
  deviceToken: string;
  tmdbApiKey: string;
  mediaDirs: string[];
}

export interface TvInfo extends TvSettings {
  streamPort: number;
  configured: boolean;
}

export interface TestResult {
  ok: boolean;
  message: string;
}

export interface TvBoxApi {
  getInfo: () => Promise<TvInfo>;
  getCatalog: () => Promise<MediaItem[]>;
  saveSettings: (s: TvSettings) => Promise<{ ok: boolean; configured: boolean }>;
  testConnection: (backendUrl: string, deviceToken: string) => Promise<TestResult>;
  pickDirectory: () => Promise<string[]>;
  sendPlayerState: (state: PlayerState) => void;
  sendProgress: (p: { mediaId: string; position: number; duration: number }) => void;
  signalReply: (event: string, msg: SignalMessage) => void;
  requestWidgets: () => void;
  onControl: (cb: (cmd: unknown) => void) => () => void;
  onPlay: (cb: (target: PlayTarget) => void) => () => void;
  onSignal: (cb: (payload: { event: string; msg: SignalMessage }) => void) => () => void;
  onWidgets: (cb: (payload: { widgets: WidgetConfig[]; settings: IdleSettings }) => void) => () => void;
}
