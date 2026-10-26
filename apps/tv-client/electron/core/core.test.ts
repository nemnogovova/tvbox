import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { TvDatabase } from './db';
import { decidePlayback, parseFfmpegInfo, transcodeArgs, srtToVtt } from './ffmpeg';
import { Library, mediaFromFile } from './library';
import { TmdbClient } from './tmdb';
import { startMediaServer, type MediaServer } from './media-server';
import { listDirectory, findExternalSubtitles } from './filesystem';
import { ConfigStore } from './config';
import type { TorrentEngine } from './torrents';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvbox-tv-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('TvDatabase (sql.js)', () => {
  it('stores media, progress, torrents and kv; persists to disk', async () => {
    const db = await TvDatabase.open(dir);
    db.upsertMedia({ id: 'm1', kind: 'movie', title: 'Dune', path: '/v/dune.mkv', origin: 'local', addedAt: 100, genres: ['Sci-Fi'] });
    db.upsertMedia({ id: 'm2', kind: 'movie', title: 'Arrival', path: '/v/arrival.mkv', origin: 'local', addedAt: 300 });
    db.saveProgress('m1', 120, 3600);
    db.upsertTorrent({ id: 'abc', name: 'x', magnet: 'magnet:?xt=urn:btih:abc', torrentB64: null, addedAt: 1, done: false, savePath: '/d' });
    db.setJson('idle', { a: 1 });
    expect(db.listMedia().map((m) => m.id)).toEqual(['m2', 'm1']);
    expect(db.getMedia('m1')).toMatchObject({ title: 'Dune', position: 120, duration: 3600, genres: ['Sci-Fi'] });
    expect(db.getMediaByPath('/v/arrival.mkv')?.id).toBe('m2');
    db.close();

    const db2 = await TvDatabase.open(dir);
    expect(db2.getMedia('m1')?.position).toBe(120);
    expect(db2.listTorrents()[0]).toMatchObject({ id: 'abc', done: false });
    expect(db2.getJson('idle')).toEqual({ a: 1 });
    db2.deleteMedia('m1');
    expect(db2.getMedia('m1')).toBeUndefined();
    expect(db2.getProgress('m1')).toBeUndefined();
    expect(db2.needsTmdb().map((m) => m.id)).toEqual(['m2']);
    db2.setTmdbTried('m2');
    expect(db2.needsTmdb()).toHaveLength(0);
    db2.close();
  });
});

const FFMPEG_OUT = `Input #0, matroska,webm, from 'The.Boys.S01E01.mkv':
  Metadata:
    title           : The Boys
  Duration: 01:00:12.50, start: 0.000000, bitrate: 5000 kb/s
  Stream #0:0(eng): Video: h264 (High), yuv420p(progressive), 1920x1080, SAR 1:1 DAR 16:9, 23.98 fps (default)
  Stream #0:1(rus): Audio: ac3, 48000 Hz, 5.1(side), fltp, 384 kb/s (default)
    Metadata:
      title           : Дубляж
  Stream #0:2(eng): Audio: aac (LC), 48000 Hz, stereo, fltp
  Stream #0:3(rus): Subtitle: subrip
    Metadata:
      title           : Форсированные
  Stream #0:4(eng): Subtitle: hdmv_pgs_subtitle
  Stream #0:5: Attachment: ttf
At least one output file must be specified`;

describe('ffmpeg helpers', () => {
  it('parses stream info', () => {
    const p = parseFfmpegInfo(FFMPEG_OUT);
    expect(p.container).toBe('matroska,webm');
    expect(p.duration).toBeCloseTo(3612.5);
    expect(p.video).toHaveLength(1);
    expect(p.audio.map((a) => a.codec)).toEqual(['ac3', 'aac']);
    expect(p.audio[0]).toMatchObject({ lang: 'rus', title: 'Дубляж', isDefault: true });
    expect(p.subtitles).toHaveLength(1); // PGS is image based → dropped
    expect(p.subtitles[0].title).toBe('Форсированные');
  });

  it('decides between direct play and transcoding', () => {
    const p = parseFfmpegInfo(FFMPEG_OUT);
    expect(decidePlayback(p, 'x.mkv')).toMatchObject({ direct: false, copyVideo: true }); // AC3 audio
    expect(decidePlayback(p, 'x.mkv', 1)).toMatchObject({ direct: false, copyVideo: true }); // AAC track
    const avi = { ...p, container: 'avi', audio: [{ index: 0, codec: 'mp3' }], video: [{ index: 0, codec: 'mpeg4' }] };
    expect(decidePlayback(avi, 'x.avi')).toMatchObject({ direct: false, copyVideo: false });
    expect(decidePlayback(null, 'x.mp4').direct).toBe(true);
  });

  it('builds transcode args', () => {
    const a = transcodeArgs({ input: '/v/a.mkv', start: 90, audioIndex: 1, copyVideo: true, videoCodec: 'hevc' });
    expect(a).toEqual(expect.arrayContaining(['-noaccurate_seek', '-ss', '90.000', '-c:v', 'copy', '-tag:v', 'hvc1', '0:a:1?', 'pipe:1']));
    expect(transcodeArgs({ input: 'x', copyVideo: false })).toContain('libx264');
  });

  it('converts srt to vtt', () => {
    expect(srtToVtt('1\r\n00:00:01,000 --> 00:00:02,500\r\nПривет\r\n')).toBe('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nПривет');
  });
});

describe('library', () => {
  it('classifies files', () => {
    expect(mediaFromFile('/m/Dune.2021.2160p.mkv', 4e9)).toMatchObject({ kind: 'movie', title: 'Dune', year: 2021 });
    expect(mediaFromFile('/s/The.Boys.S02E03.1080p.mkv', 1e9)).toMatchObject({ kind: 'episode', title: 'The Boys', season: 2, episode: 3, showKey: 'the-boys' });
    expect(mediaFromFile('/s/Breaking Bad Season 1/S01E02.mkv', 1e9)).toMatchObject({ kind: 'episode', title: 'Breaking Bad', episode: 2 });
    expect(mediaFromFile('/m/clip.mp4', 20e6)).toMatchObject({ kind: 'video' });
    expect(mediaFromFile('/a/song.flac', 30e6)).toMatchObject({ kind: 'audio' });
    expect(mediaFromFile('/p/photo.jpg', 1e6)).toBeNull();
    expect(mediaFromFile('/m/movie-sample.mkv', 1e6)).toBeNull();
  });

  it('scans folders, tracks progress and finds the next episode', async () => {
    const db = await TvDatabase.open(null);
    const media = path.join(dir, 'media');
    fs.mkdirSync(path.join(media, 'Show'), { recursive: true });
    fs.writeFileSync(path.join(media, 'Show', 'Show.S01E01.mkv'), 'x');
    fs.writeFileSync(path.join(media, 'Show', 'Show.S01E02.mkv'), 'x');
    fs.writeFileSync(path.join(media, 'Film.2020.mkv'), 'x');
    fs.writeFileSync(path.join(media, 'readme.txt'), 'x');
    const lib = new Library(db, new TmdbClient(''), () => [media]);
    await lib.scan();
    const items = lib.list();
    expect(items).toHaveLength(3);
    const e1 = items.find((m) => m.episode === 1)!;
    expect(lib.nextEpisode(e1.id)?.episode).toBe(2);
    lib.saveProgress(e1.id, 100, 1000);
    expect(lib.get(e1.id)?.position).toBe(100);
    fs.rmSync(path.join(media, 'Film.2020.mkv'));
    await lib.scan();
    expect(lib.list()).toHaveLength(2);
    lib.update(e1.id, { title: 'Renamed' });
    expect(lib.get(e1.id)?.title).toBe('Renamed');
    await lib.delete(e1.id);
    expect(fs.existsSync(path.join(media, 'Show', 'Show.S01E01.mkv'))).toBe(false);
  });
});

describe('filesystem', () => {
  it('lists directories with parents and kinds', async () => {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'a.mkv'), 'x');
    fs.writeFileSync(path.join(dir, 'b.torrent'), 'x');
    const r = await listDirectory(dir, []);
    expect(r.entries[0]).toMatchObject({ name: 'sub', kind: 'dir' });
    expect(r.entries.find((e) => e.name === 'a.mkv')?.kind).toBe('video');
    expect(r.entries.find((e) => e.name === 'b.torrent')?.kind).toBe('torrent');
    expect(r.parent).toBe(path.dirname(dir));
    const roots = await listDirectory(undefined, [dir]);
    expect(roots.parent).toBeNull();
    expect(roots.entries.some((e) => e.path === dir)).toBe(true);
  });

  it('finds external subtitles', () => {
    fs.writeFileSync(path.join(dir, 'Movie.mkv'), 'x');
    fs.writeFileSync(path.join(dir, 'Movie.rus.srt'), 'x');
    fs.mkdirSync(path.join(dir, 'Subs'));
    fs.writeFileSync(path.join(dir, 'Subs', 'Movie.eng.srt'), 'x');
    fs.writeFileSync(path.join(dir, 'Other.srt'), 'x');
    const subs = findExternalSubtitles(path.join(dir, 'Movie.mkv'));
    expect(subs.map((s) => s.label).sort()).toEqual(['Movie.eng', 'rus']);
  });
});

describe('config', () => {
  it('persists and normalizes', () => {
    const c = new ConfigStore(dir);
    expect(c.value.serverUrl).toBe('https://tv.nemnogovova.com');
    c.update({ serverUrl: 'https://x.example.com/', mediaDirs: [' D:\\Films ', 'D:\\Films', ''] });
    const c2 = new ConfigStore(dir);
    expect(c2.value.serverUrl).toBe('https://x.example.com');
    expect(c2.value.mediaDirs).toEqual(['D:\\Films']);
  });
});

describe('media server', () => {
  let server: MediaServer;
  const fakeTorrents = {
    fileName: () => null,
    fileLength: () => 0,
  } as unknown as TorrentEngine;

  beforeEach(async () => {
    server = await startMediaServer(fakeTorrents, null, 0);
  });
  afterEach(() => server.close());

  const get = (url: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      http
        .get(url, { headers }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks), headers: res.headers }));
        })
        .on('error', reject);
    });

  it('serves files with byte ranges', async () => {
    const f = path.join(dir, 'v.mp4');
    fs.writeFileSync(f, Buffer.from('0123456789'));
    const full = await get(server.fileUrl(f));
    expect(full.status).toBe(200);
    expect(full.headers['content-type']).toBe('video/mp4');
    const part = await get(server.fileUrl(f), { Range: 'bytes=2-5' });
    expect(part.status).toBe(206);
    expect(part.body.toString()).toBe('2345');
    expect(part.headers['content-range']).toBe('bytes 2-5/10');
    const tail = await get(server.fileUrl(f), { Range: 'bytes=-3' });
    expect(tail.body.toString()).toBe('789');
    expect((await get(server.fileUrl(path.join(dir, 'missing.mp4')))).status).toBe(404);
  });

  it('rejects foreign Host headers (DNS rebinding)', async () => {
    const r = await get(`${server.base}/health`, { Host: 'evil.example.com' });
    expect(r.status).toBe(403);
  });
});

describe('v3 helpers', () => {
  it('compares versions', async () => {
    const { newerVersion } = await import('./updater');
    expect(newerVersion('3.0.10', '3.0.9')).toBe(true);
    expect(newerVersion('3.0.0', '3.0.0')).toBe(false);
    expect(newerVersion('2.9.9', '3.0.0')).toBe(false);
  });
  it('normalizes music server urls', async () => {
    const { normalizeServerUrl } = await import('./music');
    expect(normalizeServerUrl('192.168.1.5:8096/web/index.html')).toBe('http://192.168.1.5:8096');
    expect(normalizeServerUrl('https://music.example.com/')).toBe('https://music.example.com');
  });
  it('transcodes with A/V sync filters', () => {
    const args = transcodeArgs({ input: 'x.mkv', copyVideo: true });
    expect(args.join(' ')).toContain('aresample=async');
    expect(args).toContain('+genpts+discardcorrupt');
  });
});

describe('keyframes', () => {
  it('parses framecrc output', async () => {
    const { parseKeyframes } = await import('./ffmpeg');
    const out = '#tb 0: 1/1000\n0,      19920,      20000,       40,       97, 0x78092028\n0,      19960,      20160,       40,     1000, 0x1, F=0x0\n0,      29920,      30000,       40,      100, 0x564c1e2e\n';
    expect(parseKeyframes(out)).toEqual([{ pts: 20, dts: 19.92 }, { pts: 30, dts: 29.92 }]);
  });
});
