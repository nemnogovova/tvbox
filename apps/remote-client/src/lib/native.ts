import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface VolumeButtonEvent {
  direction: 'up' | 'down';
}

export interface IncomingLinkEvent {
  kind: 'magnet' | 'torrent' | 'url';
  url?: string;
  torrentBase64?: string;
  name?: string;
}

interface TvboxNativePlugin {
  addListener(event: 'volumeButton', cb: (e: VolumeButtonEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: 'incoming', cb: (e: IncomingLinkEvent) => void): Promise<PluginListenerHandle>;
  openExternal(options: { url: string }): Promise<void>;
  setVolumeKeysEnabled(options: { enabled: boolean }): Promise<void>;
  consumePending(): Promise<{ items: IncomingLinkEvent[] }>;
  startRemoteService(options: { server: string; token: string }): Promise<void>;
  stopRemoteService(): Promise<void>;
  getAppInfo(): Promise<{ version: string; build?: number }>;
}

const Native = registerPlugin<TvboxNativePlugin>('TvboxNative');

export const isNative = (): boolean => Capacitor.isNativePlatform();

function listen<E>(event: 'volumeButton' | 'incoming', cb: (e: E) => void): () => void {
  if (!isNative()) return () => {};
  let removed = false;
  let handle: PluginListenerHandle | null = null;
  void (Native.addListener as (e: string, c: (x: E) => void) => Promise<PluginListenerHandle>)(event, cb).then((h) => {
    if (removed) void h.remove();
    else handle = h;
  });
  return () => {
    removed = true;
    void handle?.remove();
  };
}

export const onVolumeButton = (cb: (e: VolumeButtonEvent) => void) => listen<VolumeButtonEvent>('volumeButton', cb);
export const onIncomingLink = (cb: (e: IncomingLinkEvent) => void) => listen<IncomingLinkEvent>('incoming', cb);

export async function consumePendingLinks(): Promise<IncomingLinkEvent[]> {
  if (!isNative()) return [];
  try {
    return (await Native.consumePending()).items || [];
  } catch {
    return [];
  }
}

export async function setVolumeKeysEnabled(enabled: boolean): Promise<void> {
  if (!isNative()) return;
  try {
    await Native.setVolumeKeysEnabled({ enabled });
  } catch {
    // older APK without this method
  }
}

export async function openExternal(url: string): Promise<void> {
  if (isNative()) {
    try {
      await Native.openExternal({ url });
      return;
    } catch {
      // fall through
    }
  }
  window.open(url, '_blank', 'noopener');
}

/** Android: notification + lock-screen controls + hardware volume keys while the app is in background. */
export async function startBackgroundControl(server: string, token: string): Promise<void> {
  if (!isNative()) return;
  try {
    await Native.startRemoteService({ server, token });
  } catch {
    // older APK
  }
}

export async function stopBackgroundControl(): Promise<void> {
  if (!isNative()) return;
  try {
    await Native.stopRemoteService();
  } catch {
    // older APK
  }
}

export async function nativeAppVersion(): Promise<string | null> {
  if (!isNative()) return null;
  try {
    return (await Native.getAppInfo()).version || null;
  } catch {
    return null;
  }
}
