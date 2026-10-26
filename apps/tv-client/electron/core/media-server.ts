import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { TorrentEngine } from './torrents';
import { keyframeArgs, parseKeyframes, spawnFfmpeg, srtToVtt, subtitleArgs, transcodeArgs } from './ffmpeg';

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/webm', // Chromium plays Matroska through its WebM demuxer
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.vtt': 'text/vtt; charset=utf-8',
};

export const mimeFor = (p: string) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /bytes=(\d*)-(\d*)/.exec(header);
  if (!m) return null;
  let start: number;
  let end: number;
  if (m[1] === '' && m[2] !== '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1] || 0);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (Number.isNaN(start) || start > end || start >= size) return null;
  return { start, end };
}

export function sendFile(req: http.IncomingMessage, res: http.ServerResponse, p: string) {
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
    if (!st.isFile()) throw new Error('not file');
  } catch {
    res.writeHead(404).end();
    return;
  }
  const range = parseRange(req.headers.range, st.size);
  const headers: Record<string, string> = { 'content-type': mimeFor(p), 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
  if (range) {
    res.writeHead(206, { ...headers, 'content-range': `bytes ${range.start}-${range.end}/${st.size}`, 'content-length': String(range.end - range.start + 1) });
  } else {
    res.writeHead(200, { ...headers, 'content-length': String(st.size) });
  }
  if (req.method === 'HEAD') return res.end();
  const s = fs.createReadStream(p, range ? { start: range.start, end: range.end } : undefined);
  s.on('error', () => res.destroy());
  s.pipe(res);
}

export type Route = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => unknown;

export interface MediaServer {
  port: number;
  base: string;
  fileUrl: (p: string) => string;
  torrentUrl: (id: string, idx: number) => string;
  transcodeUrl: (src: string, o: { start?: number; audio?: number; copy: boolean; vcodec?: string }) => string;
  subsUrl: (src: string, o: { sub?: number; ext?: string; start?: number }) => string;
  /** Register an extra handler for an exact path (e.g. /music) */
  route: (pathname: string, handler: Route) => void;
  close: () => void;
}

export function startMediaServer(torrents: TorrentEngine, rendererDir: string | null, port = 0): Promise<MediaServer> {
  const active = new Set<{ kill: () => void }>();
  const routes = new Map<string, Route>();

  const server = http.createServer((req, res) => {
    const host = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
      switch (url.pathname) {
        case '/health':
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
          return;
        case '/file':
          return sendFile(req, res, url.searchParams.get('p') || '');
        case '/transcode':
          return serveTranscode(req, res, url);
        case '/subs':
          return serveSubs(req, res, url);
        case '/seekpoint':
          return serveSeekpoint(res, url);
      }
      const extra = routes.get(url.pathname);
      if (extra) {
        void Promise.resolve(extra(req, res, url)).catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
        return;
      }
      const tm = /^\/torrent\/([a-f0-9]{40})\/(\d+)/i.exec(url.pathname);
      if (tm) return serveTorrent(req, res, tm[1].toLowerCase(), Number(tm[2]));
      if (rendererDir) return serveStatic(res, url.pathname, rendererDir);
      res.writeHead(404).end();
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  function serveTorrent(req: http.IncomingMessage, res: http.ServerResponse, id: string, idx: number) {
    const name = torrents.fileName(id, idx);
    const size = torrents.fileLength(id, idx);
    if (!name || !size) {
      res.writeHead(404).end();
      return;
    }
    // Completed (and possibly already released) torrents are served from disk.
    if (!torrents.isLive(id) || torrents.isComplete(id, idx)) {
      const p = torrents.filePath(id, idx);
      if (p && fs.existsSync(p) && fs.statSync(p).size === size) return sendFile(req, res, p);
    }
    const range = parseRange(req.headers.range, size) || { start: 0, end: size - 1 };
    const stream = torrents.createReadStream(id, idx, range.start, range.end);
    if (!stream) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(req.headers.range ? 206 : 200, {
      'content-type': mimeFor(name),
      'accept-ranges': 'bytes',
      'content-length': String(range.end - range.start + 1),
      ...(req.headers.range ? { 'content-range': `bytes ${range.start}-${range.end}/${size}` } : {}),
    });
    if (req.method === 'HEAD') {
      stream.destroy();
      return res.end();
    }
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  function serveTranscode(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const src = url.searchParams.get('src') || '';
    const proc = spawnFfmpeg(
      transcodeArgs({
        input: src,
        start: Number(url.searchParams.get('start') || 0),
        audioIndex: Number(url.searchParams.get('audio') || 0),
        copyVideo: url.searchParams.get('copy') === '1',
        videoCodec: url.searchParams.get('vcodec') || undefined,
      }),
    );
    if (!proc) {
      res.writeHead(501).end('ffmpeg not available');
      return;
    }
    const handle = { kill: () => proc.kill('SIGKILL') };
    active.add(handle);
    res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store' });
    proc.stdout.pipe(res);
    proc.on('close', () => {
      active.delete(handle);
      res.end();
    });
    req.on('close', handle.kill);
  }

  function serveSeekpoint(res: http.ServerResponse, url: URL) {
    const src = url.searchParams.get('src') || '';
    const start = Number(url.searchParams.get('start') || 0);
    const send = (keyframes: { pts: number; dts: number }[]) =>
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ keyframes }));
    const proc = start > 0 ? spawnFfmpeg(keyframeArgs(src, start)) : null;
    if (!proc) return send([]);
    let out = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), 20000);
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
    proc.on('close', () => {
      clearTimeout(timer);
      send(parseKeyframes(out));
    });
  }

  function serveSubs(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const src = url.searchParams.get('src') || '';
    const ext = url.searchParams.get('ext');
    const start = Number(url.searchParams.get('start') || 0);
    const sub = url.searchParams.get('sub');
    const input = ext || src;
    const proc = spawnFfmpeg(subtitleArgs(input, ext ? null : Number(sub || 0), start));
    if (!proc) {
      if (ext && /\.srt$/i.test(ext)) {
        res.writeHead(200, { 'content-type': MIME['.vtt'] }).end(srtToVtt(fs.readFileSync(ext, 'utf-8')));
      } else res.writeHead(501).end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME['.vtt'], 'cache-control': 'no-store' });
    proc.stdout.pipe(res);
    req.on('close', () => proc.kill('SIGKILL'));
  }

  function serveStatic(res: http.ServerResponse, pathname: string, root: string) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || !rel) rel = '/index.html';
    const full = path.normalize(path.join(root, rel));
    if (!full.startsWith(path.resolve(root))) {
      res.writeHead(403).end();
      return;
    }
    const target = fs.existsSync(full) && fs.statSync(full).isFile() ? full : path.join(root, 'index.html');
    res.writeHead(200, { 'content-type': mimeFor(target), 'cache-control': 'no-cache' });
    fs.createReadStream(target).pipe(res);
  }

  return new Promise((resolve, reject) => {
    const tryListen = (p: number) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && p !== 0) tryListen(0);
        else reject(err);
      });
      server.listen(p, '127.0.0.1', () => {
        const actual = (server.address() as AddressInfo).port;
        const base = `http://127.0.0.1:${actual}`;
        resolve({
          port: actual,
          base,
          fileUrl: (p2) => `${base}/file?p=${encodeURIComponent(p2)}`,
          torrentUrl: (id, idx) => `${base}/torrent/${id}/${idx}`,
          transcodeUrl: (src, o) =>
            `${base}/transcode?src=${encodeURIComponent(src)}&copy=${o.copy ? 1 : 0}&audio=${o.audio ?? 0}${o.vcodec ? `&vcodec=${o.vcodec}` : ''}${o.start ? `&start=${o.start.toFixed(2)}` : ''}`,
          subsUrl: (src, o) =>
            `${base}/subs?src=${encodeURIComponent(src)}${o.ext ? `&ext=${encodeURIComponent(o.ext)}` : `&sub=${o.sub ?? 0}`}${o.start ? `&start=${o.start.toFixed(2)}` : ''}`,
          route: (pathname, handler) => routes.set(pathname, handler),
          close: () => {
            for (const a of active) a.kill();
            server.close();
          },
        });
      });
    };
    tryListen(port);
  });
}
