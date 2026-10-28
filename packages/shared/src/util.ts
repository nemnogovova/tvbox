/** Extract an 11-char YouTube video id from a URL or a bare id. */
export function extractYouTubeId(input: string): string | null {
  const s = (input || '').trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube(?:-nocookie)?\.com\/(?:embed|shorts|live|v)\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m) return m[1];
  }
  return null;
}

/** Playlist id of a YouTube link (…?list=PL…), or null. Radio mixes (RD…) included. */
export function extractYouTubeList(input: string): string | null {
  const m = /[?&]list=([A-Za-z0-9_-]{10,})/.exec((input || '').trim());
  return m ? m[1] : null;
}

/** Position in a playlist (…&index=5, 1-based), or undefined. */
export function extractYouTubeIndex(input: string): number | undefined {
  const m = /[?&]index=(\d{1,4})/.exec(input || '');
  return m ? Math.max(1, parseInt(m[1], 10)) : undefined;
}

/** Extract a start time (seconds) from a YouTube URL (?t=90, ?t=1m30s, &start=90). */
export function extractYouTubeStart(input: string): number | undefined {
  const m = (input || '').match(/[?&#](?:t|start)=([0-9hms]+)/);
  if (!m) return undefined;
  const v = m[1];
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  const h = /(\d+)h/.exec(v)?.[1];
  const mi = /(\d+)m/.exec(v)?.[1];
  const se = /(\d+)s/.exec(v)?.[1];
  return (h ? +h * 3600 : 0) + (mi ? +mi * 60 : 0) + (se ? +se : 0);
}

export type LinkKindGuess = 'youtube' | 'magnet' | 'media-url' | 'unknown';

/** Classify a pasted string: YouTube link, magnet, direct media URL. */
export function classifyLink(input: string): LinkKindGuess {
  const s = (input || '').trim();
  if (!s) return 'unknown';
  if (/^magnet:\?/i.test(s)) return 'magnet';
  if (/^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(s)) return 'youtube';
  if (/^https?:\/\/\S+\.(mp4|m4v|webm|mkv|mov|mp3|m3u8|ogg|flac|wav|jpg|jpeg|png|gif|webp)(\?\S*)?$/i.test(s)) return 'media-url';
  return 'unknown';
}

export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const s = Math.floor(totalSeconds % 60);
  const m = Math.floor((totalSeconds / 60) % 60);
  const h = Math.floor(totalSeconds / 3600);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatSpeed(bps: number): string {
  return `${formatBytes(bps)}/с`;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomCode(length = 6, rnd: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[Math.floor(rnd() * CODE_ALPHABET.length)];
  return out;
}

export function normalizeLinkCode(code: string): string {
  return String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12);
}

export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mkv', 'webm', 'avi', 'mov', 'wmv', 'ts', 'm2ts', 'mpg', 'mpeg', 'flv', '3gp'];
export const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma'];
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'heic'];

export function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export function mediaKindOfFile(name: string): 'video' | 'audio' | 'image' | null {
  const e = extOf(name);
  if (VIDEO_EXTENSIONS.includes(e)) return 'video';
  if (AUDIO_EXTENSIONS.includes(e)) return 'audio';
  if (IMAGE_EXTENSIONS.includes(e)) return 'image';
  return null;
}
