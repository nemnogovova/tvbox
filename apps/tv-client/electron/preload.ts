import { contextBridge, ipcRenderer } from 'electron';
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

const api: TvBoxApi = {
  getInfo: () => ipcRenderer.invoke('tv:getInfo'),
  getCatalog: () => ipcRenderer.invoke('tv:getCatalog'),
  saveSettings: (s) => ipcRenderer.invoke('tv:saveConfig', s),
  testConnection: (url, token) => ipcRenderer.invoke('tv:testConnection', url, token),
  pickDirectory: () => ipcRenderer.invoke('tv:pickDirectory'),
  sendPlayerState: (state) => ipcRenderer.send('tv:playerState', state),
  sendProgress: (p) => ipcRenderer.send('tv:progress', p),
  signalReply: (event, msg) => ipcRenderer.send('tv:signal-reply', { event, msg }),
  requestWidgets: () => ipcRenderer.send('tv:widgets-get'),
  onControl: (cb) => {
    const handler = (_e: unknown, cmd: unknown) => cb(cmd);
    ipcRenderer.on('tv:control', handler);
    return () => ipcRenderer.removeListener('tv:control', handler);
  },
  onPlay: (cb) => {
    const handler = (_e: unknown, target: PlayTarget) => cb(target);
    ipcRenderer.on('tv:play', handler);
    return () => ipcRenderer.removeListener('tv:play', handler);
  },
  onSignal: (cb) => {
    const handler = (_e: unknown, payload: { event: string; msg: SignalMessage }) => cb(payload);
    ipcRenderer.on('tv:signal', handler);
    return () => ipcRenderer.removeListener('tv:signal', handler);
  },
  onWidgets: (cb) => {
    const handler = (_e: unknown, payload: { widgets: WidgetConfig[]; settings: IdleSettings }) => cb(payload);
    ipcRenderer.on('tv:widgets', handler);
    return () => ipcRenderer.removeListener('tv:widgets', handler);
  },
};

contextBridge.exposeInMainWorld('tvbox', api);
