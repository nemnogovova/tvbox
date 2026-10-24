import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { TorrentEngine } from './torrents';

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

export function createStreamServer(torrents: TorrentEngine): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/stream/local') {
      serveLocalFile(req, res, url.searchParams.get('path') || '');
    } else if (url.pathname.startsWith('/stream/torrent/')) {
      serveTorrentFile(req, res, url, torrents);
    } else if (url.pathname === '/stream/remux') {
      serveRemux(req, res, url.searchParams.get('path') || '');
    } else if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
}

function parseRange(rangeHeader: string | undefined, size: number): { start: number; end: number } | null {
  if (!rangeHeader) return null;
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  if (!m) return null;
  let start = m[1] ? parseInt(m[1], 10) : 0;
  let end = m[2] ? parseInt(m[2], 10) : size - 1;
  if (isNaN(start) || start < 0) start = 0;
  if (isNaN(end) || end >= size) end = size - 1;
  if (start > end || start >= size) return null;
  return { start, end };
}

function writeRangeHeaders(
  res: http.ServerResponse,
  range: { start: number; end: number } | null,
  size: number,
  type: string,
): void {
  const headers: Record<string, string> = {
    'content-type': type,
    'accept-ranges': 'bytes',
  };
  if (range) {
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
      'content-length': String(range.end - range.start + 1),
    });
  } else {
    res.writeHead(200, { ...headers, 'content-length': String(size) });
  }
}

function serveLocalFile(req: http.IncomingMessage, res: http.ServerResponse, filePath: string): void {
  try {
    const resolved = path.resolve(filePath);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    const range = parseRange(req.headers.range, stat.size);
    writeRangeHeaders(res, range, stat.size, contentTypeFor(resolved));
    const stream = range
      ? fs.createReadStream(resolved, { start: range.start, end: range.end })
      : fs.createReadStream(resolved);
    stream.pipe(res);
    stream.on('error', () => res.destroy());
  } catch {
    res.writeHead(404);
    res.end();
  }
}

function serveTorrentFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  torrents: TorrentEngine,
): void {
  // /stream/torrent/:torrentId/:fileIndex?path=name
  const parts = url.pathname.split('/').filter(Boolean);
  const torrentId = decodeURIComponent(parts[2] || '');
  const fileIndex = parseInt(parts[3] || '0', 10);
  const size = torrents.fileLength(torrentId, fileIndex);
  const range = parseRange(req.headers.range, size);
  writeRangeHeaders(res, range, size, 'video/mp4');
  const stream = torrents.createReadStream(torrentId, fileIndex, range?.start, range?.end);
  if (!stream) {
    res.writeHead(404);
    res.end();
    return;
  }
  stream.pipe(res);
  stream.on('error', () => res.destroy());
}

function serveRemux(req: http.IncomingMessage, res: http.ServerResponse, filePath: string): void {
  // Transcode the audio track to AAC on the fly (copy video), useful for .mkv files
  // whose native audio codec Chromium cannot decode.
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const args = [
    '-i',
    resolved,
    '-map',
    '0:v:0?',
    '-map',
    '0:a:0?',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    '-f',
    'mp4',
    'pipe:1',
  ];
  const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  res.writeHead(200, { 'content-type': 'video/mp4' });
  ffmpeg.stdout.pipe(res);
  ffmpeg.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end('ffmpeg not available');
  });
  req.on('close', () => ffmpeg.kill('SIGKILL'));
}


