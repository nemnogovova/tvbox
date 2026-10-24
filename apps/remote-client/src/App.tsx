import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from './store/store';
import { AuthScreen } from './components/AuthScreen';
import { Layout } from './components/Layout';
import { RemotePanel } from './components/RemotePanel';
import { CatalogPage } from './pages/CatalogPage';
import { DownloadsPage } from './pages/DownloadsPage';
import { CastPage } from './pages/CastPage';
import { SettingsPage } from './pages/SettingsPage';
import { castFile } from './lib/webrtc';
import { onVolumeButton, onDeepLink } from './native/tvboxNative';
import { Toast, type ToastData } from './components/Toast';

export type Tab = 'remote' | 'catalog' | 'downloads' | 'cast' | 'settings';

export default function App() {
  const { user, socket, control, addTorrent, connected, playerState } = useStore();
  const [tab, setTab] = useState<Tab>('remote');
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const positionRef = useRef(0);
  const volumeRef = useRef(1);
  const mutedRef = useRef(false);
  const fullscreenRef = useRef(false);

  useEffect(() => {
    if (playerState) {
      positionRef.current = playerState.position;
      volumeRef.current = playerState.volume;
      mutedRef.current = playerState.muted;
      fullscreenRef.current = playerState.fullscreen;
    }
  }, [playerState]);

  const pushToast = useCallback((message: string, kind: ToastData['kind'] = 'info') => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  // Global hotkeys (desktop browser)
  useEffect(() => {
    const isEditable = (el: EventTarget | null) => {
      const t = el as HTMLElement | null;
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    };
    const onKey = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          control({ type: 'PAUSE' });
          break;
        case 'ArrowLeft':
          control({ type: 'SEEK', position: Math.max(0, positionRef.current - 10) });
          break;
        case 'ArrowRight':
          control({ type: 'SEEK', position: positionRef.current + 10 });
          break;
        case 'ArrowUp':
          control({ type: 'VOLUME', volume: Math.min(1, volumeRef.current + 0.05) });
          break;
        case 'ArrowDown':
          control({ type: 'VOLUME', volume: Math.max(0, volumeRef.current - 0.05) });
          break;
        case 'm':
        case 'M':
          control({ type: 'MUTE', muted: !mutedRef.current });
          break;
        case 'f':
        case 'F':
          control({ type: 'FULLSCREEN', fullscreen: !fullscreenRef.current });
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [control]);

  // Drag & drop
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragOver(false);
    };
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (!socket) return;
      const files = Array.from(e.dataTransfer?.files || []);
      for (const file of files) {
        if (file.name.endsWith('.torrent')) {
          const buf = await file.arrayBuffer();
          socket.emit('torrent:add', { torrentBuffer: arrayBufferToBase64(buf), name: file.name });
          pushToast(`Torrent "${file.name}" sent to TV`, 'success');
        } else if (file.type.startsWith('video/') || file.type.startsWith('audio/') || file.type.startsWith('image/')) {
          try {
            await castFile(socket, file);
            pushToast(`Casting "${file.name}" to TV`, 'success');
          } catch {
            pushToast('Failed to cast file', 'error');
          }
        }
      }
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [socket, pushToast]);

  // Clipboard paste
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text')?.trim();
      if (!text) return;
      if (text.startsWith('magnet:')) {
        addTorrent(text);
        pushToast('Magnet link sent to TV', 'success');
      } else if (/youtube\.com|youtu\.be/i.test(text)) {
        control({ type: 'PLAY_SOURCE', source: 'youtube', url: text });
        pushToast('YouTube link sent to TV', 'success');
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addTorrent, control, pushToast]);

  // Native (Capacitor) integration: hardware volume keys + deep links
  useEffect(() => {
    const offVol = onVolumeButton((e) => {
      const delta = e.direction === 'up' ? 0.05 : -0.05;
      control({ type: 'VOLUME', volume: Math.min(1, Math.max(0, volumeRef.current + delta)) });
    });
    const offLink = onDeepLink((e) => {
      if (e.kind === 'magnet' && e.url) {
        addTorrent(e.url);
        pushToast('Magnet link sent to TV', 'success');
      } else if (e.kind === 'torrent' && e.torrentBase64) {
        socket?.emit('torrent:add', { torrentBuffer: e.torrentBase64, name: e.name });
        pushToast('Torrent sent to TV', 'success');
      }
    });
    return () => {
      offVol();
      offLink();
    };
  }, [control, addTorrent, socket, pushToast]);

  if (!user) {
    return (
      <>
        <AuthScreen />
        <Toast toasts={toasts} />
      </>
    );
  }

  return (
    <>
      <Layout
        tab={tab}
        onTab={setTab}
        remotePanel={<RemotePanel />}
        content={
          <>
            {tab === 'remote' && <div className="lg:hidden"><RemotePanel /></div>}
            {tab === 'catalog' && <CatalogPage />}
            {tab === 'downloads' && <DownloadsPage />}
            {tab === 'cast' && <CastPage />}
            {tab === 'settings' && <SettingsPage />}
          </>
        }
      />
      {!connected && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full bg-yellow-500/15 text-yellow-300 text-xs">
          Reconnecting…
        </div>
      )}
      {dragOver && (
        <div className="fixed inset-0 z-[100] bg-accent/10 border-2 border-dashed border-accent flex items-center justify-center pointer-events-none">
          <div className="text-center">
            <p className="text-2xl font-semibold">Drop to send to TV</p>
            <p className="text-sm text-gray-400">.torrent → download · video/audio/photo → cast</p>
          </div>
        </div>
      )}
      <Toast toasts={toasts} />
    </>
  );
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
