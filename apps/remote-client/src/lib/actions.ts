import { Events, classifyLink, extractYouTubeStart, type PlayRequest } from '@tvbox/shared';
import { act, control, toast } from '../store/store';

/** Handle a pasted / typed link: YouTube, magnet or a direct media URL. */
export async function openLink(text: string, mode: 'play' | 'queue' = 'play'): Promise<boolean> {
  const s = text.trim();
  const kind = classifyLink(s);
  if (kind === 'magnet') {
    const r = await act(Events.TORRENT_ADD, { magnet: s, play: mode === 'play' }, mode === 'play' ? 'Торрент добавлен — запустим, как только будет готово' : 'Торрент добавлен в загрузки');
    return r.ok;
  }
  let request: PlayRequest | null = null;
  if (kind === 'youtube') request = { source: 'youtube', url: s, startAt: extractYouTubeStart(s) };
  else if (kind === 'media-url' || /^https?:\/\//i.test(s)) request = { source: 'url', url: s };
  if (!request) {
    toast('Не похоже на ссылку YouTube, magnet или видео', 'warning');
    return false;
  }
  const ok = await control(mode === 'play' ? { type: 'PLAY_SOURCE', request } : { type: 'QUEUE_ADD', request });
  if (ok && mode === 'queue') toast('Добавлено в очередь', 'success');
  return ok;
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export async function sendTorrentFile(file: File, play = false): Promise<boolean> {
  if (file.size > 6 * 1024 * 1024) {
    toast('Слишком большой .torrent файл', 'error');
    return false;
  }
  const torrentBase64 = await fileToBase64(file);
  const r = await act(Events.TORRENT_ADD, { torrentBase64, name: file.name, play }, `«${file.name}» отправлен на ТВ`);
  return r.ok;
}
