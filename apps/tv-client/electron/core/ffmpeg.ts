import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';

export function ffmpegPath(): string | null {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const p = require('ffmpeg-static') as string | null;
    if (!p) return null;
    const unpacked = p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    return fs.existsSync(unpacked) ? unpacked : fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

export interface StreamInfo {
  /** index among streams of the same type (for -map 0:a:N) */
  index: number;
  codec: string;
  lang?: string;
  title?: string;
  isDefault?: boolean;
  channels?: string;
  attachedPic?: boolean;
}

export interface ProbeResult {
  container: string;
  duration: number;
  video: StreamInfo[];
  audio: StreamInfo[];
  subtitles: StreamInfo[];
}

const OK_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1', 'hevc', 'theora']);
const OK_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8', 'alac']);
const OK_CONTAINER = /^(mov|mp4|m4a|3gp|3g2|mj2|matroska|webm|ogg|mp3|flac|wav)/;
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);

/** Parse the stderr of `ffmpeg -i file` (avoids shipping a separate ffprobe binary). */
export function parseFfmpegInfo(out: string): ProbeResult {
  const res: ProbeResult = { container: '', duration: 0, video: [], audio: [], subtitles: [] };
  const input = /Input #0, ([^ ]+?), from/.exec(out);
  if (input) res.container = input[1];
  const dur = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out);
  if (dur) res.duration = +dur[1] * 3600 + +dur[2] * 60 + parseFloat(dur[3]);

  const lines = out.split(/\r?\n/);
  let current: StreamInfo | null = null;
  for (const line of lines) {
    const m = /Stream #0:\d+(?:\[0x[0-9a-f]+\])?(?:\((\w+)\))?: (Video|Audio|Subtitle): ([\w-]+)/.exec(line);
    if (m) {
      const kind = m[2];
      const list = kind === 'Video' ? res.video : kind === 'Audio' ? res.audio : res.subtitles;
      current = {
        index: list.length,
        codec: m[3].toLowerCase(),
        lang: m[1] && m[1] !== 'und' ? m[1] : undefined,
        isDefault: /\(default\)/.test(line),
        attachedPic: /attached pic/.test(line),
      };
      if (kind === 'Audio') {
        const ch = /Hz, ([^,]+),/.exec(line);
        if (ch) current.channels = ch[1];
      }
      list.push(current);
      continue;
    }
    if (/^\s*Stream #/.test(line) || /^\S/.test(line)) {
      current = null;
      continue;
    }
    const t = /^\s+title\s*:\s*(.+)$/.exec(line);
    if (t && current && !current.title) current.title = t[1].trim();
  }
  res.video = res.video.filter((v) => !v.attachedPic);
  res.subtitles = res.subtitles.filter((s) => TEXT_SUBS.has(s.codec));
  return res;
}

const probeCache = new Map<string, { key: string; result: ProbeResult }>();

export function probe(input: string, timeoutMs = 30000): Promise<ProbeResult | null> {
  const bin = ffmpegPath();
  if (!bin) return Promise.resolve(null);
  let key = input;
  try {
    if (!/^https?:/.test(input)) {
      const st = fs.statSync(input);
      key = `${input}:${st.size}:${st.mtimeMs}`;
    }
  } catch {
    // ignore
  }
  const cached = probeCache.get(input);
  if (cached && cached.key === key) return Promise.resolve(cached.result);

  return new Promise((resolve) => {
    const p = spawn(bin, ['-hide_banner', '-i', input], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d: Buffer) => (err += d.toString('utf-8')));
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', () => {
      clearTimeout(t);
      resolve(null);
    });
    p.on('close', () => {
      clearTimeout(t);
      if (!/Input #0/.test(err)) return resolve(null);
      const result = parseFfmpegInfo(err);
      probeCache.set(input, { key, result });
      if (probeCache.size > 300) probeCache.delete(probeCache.keys().next().value as string);
      resolve(result);
    });
  });
}

export interface PlayDecision {
  direct: boolean;
  copyVideo: boolean;
  reason?: string;
}

export function decidePlayback(info: ProbeResult | null, fileName: string, audioIndex = 0): PlayDecision {
  const ext = path.extname(fileName).toLowerCase();
  if (!info) {
    const directExt = ['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.mp3', '.m4a', '.ogg', '.opus', '.flac', '.wav'];
    return { direct: directExt.includes(ext), copyVideo: true, reason: 'no-probe' };
  }
  const v = info.video[0];
  const a = info.audio[audioIndex] || info.audio[0];
  const videoOk = !v || OK_VIDEO.has(v.codec);
  const audioOk = !a || OK_AUDIO.has(a.codec);
  // Matroska is played by Chromium only through its WebM demuxer, which loses A/V sync on long
  // files with timestamp gaps — remux it (video copied, cheap) instead of playing it directly.
  const containerOk = OK_CONTAINER.test(info.container) && !['.avi', '.ts', '.m2ts', '.wmv', '.flv', '.mpg', '.mpeg', '.mkv'].includes(ext) && !/matroska/.test(info.container) || (/webm/.test(info.container) && ext === '.webm');
  if (videoOk && audioOk && containerOk) return { direct: true, copyVideo: true };
  return {
    direct: false,
    copyVideo: !!v && (v.codec === 'h264' || v.codec === 'hevc'),
    reason: !containerOk ? `container ${info.container}` : !videoOk ? `video ${v?.codec}` : `audio ${a?.codec}`,
  };
}

export interface TranscodeOptions {
  input: string;
  start?: number;
  audioIndex?: number;
  copyVideo: boolean;
  videoCodec?: string;
  /** the TV could not keep up: fastest encoding, at most 720p */
  light?: boolean;
}

export function transcodeArgs(o: TranscodeOptions): string[] {
  // +genpts: rebuild missing timestamps (common in MKV rips)
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-fflags', '+genpts+discardcorrupt'];
  if (o.start && o.start > 0) {
    // With the video copied, the picture can only start at a keyframe (up to several seconds before
    // the requested point). Audio must start at the very same place: an accurate seek would trim it
    // to the requested time, leaving a hole at the start of the audio track, which Chromium closes up —
    // and the sound runs ahead of the picture by the distance to that keyframe.
    if (o.copyVideo) args.push('-noaccurate_seek');
    args.push('-ss', o.start.toFixed(3));
  }
  // Full video conversion (HEVC 10-bit, old codecs) has to run faster than real time or the
  // picture stalls every few seconds: decode on the graphics card when there is one (falls back
  // to the CPU by itself), and encode with a fast preset.
  if (!o.copyVideo) args.push('-hwaccel', 'auto');
  args.push('-i', o.input, '-map', '0:v:0?', '-map', `0:a:${o.audioIndex ?? 0}?`);
  if (o.copyVideo) {
    args.push('-c:v', 'copy');
    if (o.videoCodec === 'hevc') args.push('-tag:v', 'hvc1');
  } else {
    const w = o.light ? 1280 : 1920;
    args.push(
      '-c:v', 'libx264', '-preset', o.light ? 'ultrafast' : 'superfast', '-crf', o.light ? '23' : '22',
      // a keyframe every 2 s: the stream is sent in 2-second pieces (x264's default of one per
      // ~10 s made the player wait for a whole 10-second piece — slow start, stop-and-go playback)
      '-force_key_frames', 'expr:gte(t,n_forced*2)',
      '-pix_fmt', 'yuv420p', '-vf', `scale='min(${w},iw)':-2`,
    );
  }
  args.push(
    // Keep audio locked to the video clock: fill gaps / drop overlaps in the audio track
    // (otherwise A/V drift accumulates over an episode when the source has holes in its audio).
    '-af', 'aresample=async=1000:min_hard_comp=0.100',
    '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
    '-sn', '-dn',
    '-avoid_negative_ts', 'make_zero',
    '-max_interleave_delta', '0',
    '-max_muxing_queue_size', '4096',
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  );
  return args;
}

export function spawnFfmpeg(args: string[]): ChildProcessByStdio<null, Readable, null> | null {
  const bin = ffmpegPath();
  if (!bin) return null;
  return spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
}

export function subtitleArgs(input: string, subIndex: number | null, start = 0): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (start > 0) args.push('-ss', start.toFixed(2));
  args.push('-i', input);
  if (subIndex !== null) args.push('-map', `0:s:${subIndex}`);
  args.push('-f', 'webvtt', 'pipe:1');
  return args;
}

/** Convert SRT text to WebVTT (fallback for external subtitles when ffmpeg is unavailable). */
export function srtToVtt(srt: string): string {
  return (
    'WEBVTT\n\n' +
    srt
      .replace(/^﻿/, '')
      .replace(/\r/g, '')
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
      .trim()
  );
}

/**
 * Keyframes at and after <start> (a copy-video stream can only begin at one of them).
 * A stream started with -noaccurate_seek -ss <keyframe pts> has its time 0 at that keyframe's dts.
 */
export function keyframeArgs(input: string, start: number): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-noaccurate_seek', '-ss', start.toFixed(3), '-i', input, '-map', '0:v:0', '-c', 'copy', '-frames:v', '900', '-copyts', '-f', 'framecrc', '-'];
}

export interface Keyframe {
  pts: number;
  dts: number;
}

export function parseKeyframes(out: string, max = 12): Keyframe[] {
  const tb = /#tb 0: (\d+)\/(\d+)/.exec(out);
  if (!tb) return [];
  const k = Number(tb[1]) / Number(tb[2]);
  const res: Keyframe[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!/^0,/.test(line)) continue;
    const flags = /F=0x([0-9a-f]+)/i.exec(line);
    if (flags && (parseInt(flags[1], 16) & 1) === 0) continue; // not a keyframe
    const parts = line.split(',');
    const dts = Number(parts[1]) * k;
    const pts = Number(parts[2]) * k;
    if (Number.isFinite(dts) && Number.isFinite(pts)) res.push({ pts, dts: Math.max(0, dts) });
    if (res.length >= max) break;
  }
  return res;
}
