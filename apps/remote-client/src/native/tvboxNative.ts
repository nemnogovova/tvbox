import { Capacitor, registerPlugin } from '@capacitor/core';

export interface VolumeButtonEvent {
  direction: 'up' | 'down';
}

export interface DeepLinkEvent {
  kind: 'magnet' | 'torrent';
  url?: string;
  torrentBase64?: string;
  name?: string;
}

interface TvboxNativePlugin {
  addListener(event: 'volumeButton', cb: (e: VolumeButtonEvent) => void): Promise<{ remove: () => void }>;
  addListener(event: 'deepLink', cb: (e: DeepLinkEvent) => void): Promise<{ remove: () => void }>;
}

const TvboxNative = registerPlugin<TvboxNativePlugin>('TvboxNative');

export function onVolumeButton(cb: (e: VolumeButtonEvent) => void): () => void {
  if (!Capacitor.isNativePlatform()) return () => {};
  let removed = false;
  let handle: { remove: () => void } | null = null;
  void TvboxNative.addListener('volumeButton', cb).then((h) => {
    if (removed) h.remove();
    else handle = h;
  });
  return () => {
    removed = true;
    handle?.remove();
  };
}

export function onDeepLink(cb: (e: DeepLinkEvent) => void): () => void {
  if (!Capacitor.isNativePlatform()) return () => {};
  let removed = false;
  let handle: { remove: () => void } | null = null;
  void TvboxNative.addListener('deepLink', cb).then((h) => {
    if (removed) h.remove();
    else handle = h;
  });
  return () => {
    removed = true;
    handle?.remove();
  };
}
