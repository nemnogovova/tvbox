import type { PlayerState, SignalMessage, IdleSettings, WidgetConfig, MediaItem } from '@tvbox/shared';

export interface PlayTarget {
  kind: 'youtube' | 'local' | 'torrent' | 'webrtc';
  url?: string;
  videoId?: string;
  title?: string;
  mediaId?: string;
}

export interface TvInfo {
  streamPort: number;
  backendUrl: string;
}

export interface TvBoxApi {
  getInfo: () => Promise<TvInfo>;
  getCatalog: () => Promise<MediaItem[]>;
  sendPlayerState: (state: PlayerState) => void;
  sendProgress: (p: { mediaId: string; position: number; duration: number }) => void;
  signalReply: (event: string, msg: SignalMessage) => void;
  requestWidgets: () => void;
  onControl: (cb: (cmd: unknown) => void) => () => void;
  onPlay: (cb: (target: PlayTarget) => void) => () => void;
  onSignal: (cb: (payload: { event: string; msg: SignalMessage }) => void) => () => void;
  onWidgets: (cb: (payload: { widgets: WidgetConfig[]; settings: IdleSettings }) => void) => () => void;
}
