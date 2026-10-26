import { useEffect, useState } from 'react';
import { Download, ListPlus, Magnet, Play, Upload, Youtube, Link2 } from 'lucide-react';
import { Events, classifyLink, type LinkKindGuess } from '@tvbox/shared';
import { act, control, toast, useStore } from '../store/store';
import { openLink, sendTorrentFile } from '../lib/actions';
import { startFileCast } from '../store/cast';
import { consumePendingLinks, onIncomingLink, onVolumeButton, setVolumeKeysEnabled, type IncomingLinkEvent } from '../lib/native';
import { getPref } from '../lib/config';
import { Sheet } from './ui';

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

export function GlobalInputs() {
  const [dragging, setDragging] = useState(false);
  const [pasted, setPasted] = useState<{ text: string; kind: LinkKindGuess } | null>(null);

  // ---------------------------------------------------------------- hotkeys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector('[role="dialog"]')) return;
      let handled = true;
      switch (e.code) {
        case 'Space':
          void control({ type: 'PLAY_PAUSE' });
          break;
        case 'ArrowLeft':
          void control({ type: 'SEEK_RELATIVE', delta: -10 });
          break;
        case 'ArrowRight':
          void control({ type: 'SEEK_RELATIVE', delta: 10 });
          break;
        case 'ArrowUp':
          void control({ type: 'VOLUME_STEP', delta: 0.05 });
          break;
        case 'ArrowDown':
          void control({ type: 'VOLUME_STEP', delta: -0.05 });
          break;
        case 'KeyM':
          void control({ type: 'MUTE' });
          break;
        case 'KeyF':
          void control({ type: 'FULLSCREEN' });
          break;
        case 'KeyN':
          void control({ type: 'NEXT' });
          break;
        case 'KeyP':
          void control({ type: 'PREVIOUS' });
          break;
        default:
          handled = false;
      }
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---------------------------------------------------------------- drag & drop
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (!useStore.getState().presence.tvConnected) {
        toast('Телевизор не в сети', 'error');
        return;
      }
      const files = Array.from(e.dataTransfer?.files || []);
      const torrents = files.filter((f) => /\.torrent$/i.test(f.name));
      const media = files.filter((f) => /^(video|audio|image)\//.test(f.type) || /\.(mkv|mp4|webm|mov|mp3|flac|jpe?g|png|webp)$/i.test(f.name));
      for (const t of torrents) void sendTorrentFile(t);
      if (media[0]) {
        void startFileCast(media[0]);
        if (media.length > 1) toast('Транслируем первый файл — остальные можно отправить после', 'info');
      }
      if (!torrents.length && !media.length) toast('Поддерживаются .torrent, видео, музыка и фото', 'warning');
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  // ---------------------------------------------------------------- paste anywhere
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return;
      const text = e.clipboardData?.getData('text')?.trim() || '';
      const kind = classifyLink(text);
      if (kind !== 'unknown') {
        e.preventDefault();
        setPasted({ text, kind });
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  // ---------------------------------------------------------------- PWA share target (?text= / ?url=)
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const shared = sp.get('url') || sp.get('text') || '';
    const m = shared.match(/(magnet:\?\S+|https?:\/\/\S+)/i);
    if (m && classifyLink(m[1]) !== 'unknown') {
      setPasted({ text: m[1], kind: classifyLink(m[1]) });
      window.history.replaceState({}, '', '/');
    }
  }, []);

  // ---------------------------------------------------------------- Android: volume keys + magnet/.torrent intents
  useEffect(() => {
    void setVolumeKeysEnabled(getPref('volumeKeys', true));
    const offVol = onVolumeButton((e) => void control({ type: 'VOLUME_STEP', delta: e.direction === 'up' ? 0.05 : -0.05 }));
    const handle = (e: IncomingLinkEvent) => {
      if (e.kind === 'torrent' && e.torrentBase64) {
        void act(Events.TORRENT_ADD, { torrentBase64: e.torrentBase64, name: e.name }, `«${e.name || 'Торрент'}» отправлен на ТВ`);
      } else if (e.url) {
        const kind = classifyLink(e.url);
        if (kind !== 'unknown') setPasted({ text: e.url, kind });
      }
    };
    const offLink = onIncomingLink(handle);
    void consumePendingLinks().then((items) => items.forEach(handle));
    return () => {
      offVol();
      offLink();
    };
  }, []);

  const close = () => setPasted(null);
  const run = async (fn: () => Promise<unknown>) => {
    close();
    await fn();
  };

  return (
    <>
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-[250] flex animate-fade-in items-center justify-center bg-ink-950/80 p-8 backdrop-blur-sm">
          <div className="flex h-full w-full flex-col items-center justify-center rounded-[36px] border-2 border-dashed border-ember/70 bg-ember/[0.04]">
            <Upload size={48} className="text-ember" />
            <p className="mt-4 text-2xl font-extrabold">Отпустите, чтобы отправить на ТВ</p>
            <p className="mt-2 text-fg-muted">.torrent — скачать · видео, музыка, фото — транслировать</p>
          </div>
        </div>
      )}

      <Sheet open={!!pasted} onClose={close} title="Запустить на телевизоре?">
        {pasted && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3 rounded-2xl bg-ink-800 p-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ember/15 text-ember">
                {pasted.kind === 'youtube' ? <Youtube size={20} /> : pasted.kind === 'magnet' ? <Magnet size={20} /> : <Link2 size={20} />}
              </div>
              <span className="min-w-0 flex-1 break-all text-sm text-fg-muted line-clamp-3">{pasted.text}</span>
            </div>
            {pasted.kind === 'magnet' ? (
              <div className="grid grid-cols-2 gap-2">
                <button className="btn-soft" onClick={() => run(() => act(Events.TORRENT_ADD, { magnet: pasted.text }, 'Добавлено в загрузки'))}>
                  <Download size={16} /> Скачать
                </button>
                <button className="btn-primary" onClick={() => run(() => openLink(pasted.text, 'play'))}>
                  <Play size={16} fill="currentColor" /> Смотреть
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <button className="btn-soft" onClick={() => run(() => openLink(pasted.text, 'queue'))}>
                  <ListPlus size={16} /> В очередь
                </button>
                <button className="btn-primary" onClick={() => run(() => openLink(pasted.text, 'play'))}>
                  <Play size={16} fill="currentColor" /> Смотреть
                </button>
              </div>
            )}
          </div>
        )}
      </Sheet>
    </>
  );
}
