import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { TvBridge } from '../src/bridge';

function on<T>(channel: string) {
  return (cb: (payload: T) => void) => {
    const handler = (_e: IpcRendererEvent, payload: T) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  };
}

const api: TvBridge = {
  getStatus: () => ipcRenderer.invoke('tv:status'),
  getCatalog: () => ipcRenderer.invoke('tv:catalog'),
  getIdle: () => ipcRenderer.invoke('tv:idle'),
  getIceServers: () => ipcRenderer.invoke('tv:ice'),
  setServerUrl: (url) => ipcRenderer.invoke('tv:setServer', url),
  report: (r) => ipcRenderer.send('tv:report', r),
  castState: (s) => ipcRenderer.send('tv:cast', s),
  signal: (event, msg) => ipcRenderer.send('tv:signal', { event, msg }),
  localKey: (key) => ipcRenderer.send('tv:key', key),
  onStatus: on('tv:status'),
  onLoad: on('player:load'),
  onCommand: on('player:cmd'),
  onCatalog: on('tv:catalog'),
  onIdle: on('tv:idle'),
  onSignal: on('tv:signal'),
  onCastStop: on('cast:stop'),
  onToast: on('tv:toast'),
};

contextBridge.exposeInMainWorld('tvbox', api);
