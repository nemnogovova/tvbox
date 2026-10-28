import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ffmpegPath } from './ffmpeg';

const IMAGE = /\.(jpe?g|png|webp|avif|bmp|gif)$/i;
const VIDEO = /\.(mp4|webm|m4v|mov)$/i;

/** EXIF orientation of a JPEG (1 = as stored). Only the first 128 KB are looked at. */
export function jpegOrientation(buf: Buffer): number {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return 1;
  let off = 2;
  while (off + 4 < buf.length) {
    if (buf[off] !== 0xff) return 1;
    const marker = buf[off + 1];
    const len = buf.readUInt16BE(off + 2);
    if (marker === 0xe1 && buf.toString('latin1', off + 4, off + 10) === 'Exif\0\0') {
      const tiff = off + 10;
      const le = buf.toString('latin1', tiff, tiff + 2) === 'II';
      const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
      const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
      const ifd = tiff + u32(tiff + 4);
      if (ifd + 2 > buf.length) return 1;
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > buf.length) break;
        if (u16(e) === 0x0112) {
          const v = u16(e + 8);
          return v >= 1 && v <= 8 ? v : 1;
        }
      }
      return 1;
    }
    if (marker === 0xda) return 1; // image data starts: no EXIF
    off += 2 + len;
  }
  return 1;
}

/** ffmpeg filters that turn a picture upright for an EXIF orientation. */
export function orientationFilter(o: number): string[] {
  switch (o) {
    case 2:
      return ['hflip'];
    case 3:
      return ['hflip', 'vflip'];
    case 4:
      return ['vflip'];
    case 5:
      return ['transpose=0'];
    case 6:
      return ['transpose=1'];
    case 7:
      return ['transpose=3'];
    case 8:
      return ['transpose=2'];
    default:
      return [];
  }
}

function readHead(file: string): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(128 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Small previews (for the remote) and screen-sized copies (for the TV) of screensaver files.
 * A 45-megapixel photo takes the TV seconds to decode and hundreds of MB of memory; a copy at
 * the screen's size shows instantly. Copies are made once with ffmpeg and cached on disk;
 * the pictures are turned upright by their EXIF orientation (the same way browsers show them).
 */
export class Previews {
  private readonly dir: string;
  private chain: Promise<unknown> = Promise.resolve();
  private inflight = new Map<string, Promise<string | null>>();

  constructor(
    baseDir: string,
    private readonly resolve: (name: string) => string | null,
  ) {
    this.dir = path.join(baseDir, 'screensaver-cache');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** JPEG preview ~360 px wide as a data: URL (null when it can't be made). */
  async thumbDataUrl(name: string): Promise<string | null> {
    const file = await this.make(name, 'thumb', 320, 320, 7);
    if (!file) return null;
    try {
      return `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`;
    } catch {
      return null;
    }
  }

  /** Path of a copy that fits the screen (images only); null → serve the original. */
  display(name: string, width: number, height: number): Promise<string | null> {
    if (!IMAGE.test(name) || /\.gif$/i.test(name)) return Promise.resolve(null);
    return this.make(name, `d${width}x${height}`, width, height, 3);
  }

  /** Forget cached copies of files that are gone. */
  prune(keep: string[]): void {
    const set = new Set(keep.map((n) => path.basename(n)));
    try {
      for (const f of fs.readdirSync(this.dir)) {
        const src = f.replace(/\.[^.]+\.jpg$/, '');
        if (!set.has(src)) fs.rmSync(path.join(this.dir, f), { force: true });
      }
    } catch {
      // ignore
    }
  }

  private make(name: string, kind: string, w: number, h: number, q: number): Promise<string | null> {
    const src = this.resolve(name);
    if (!src || !(IMAGE.test(src) || VIDEO.test(src))) return Promise.resolve(null);
    const out = path.join(this.dir, `${path.basename(src)}.${kind}.jpg`);
    try {
      if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) return Promise.resolve(out);
    } catch {
      // make it again
    }
    const key = out;
    const running = this.inflight.get(key);
    if (running) return running;
    // one ffmpeg at a time: previews are made in the background, the TV keeps playing smoothly
    const job = this.chain
      .catch(() => undefined)
      .then(() => this.ffmpeg(src, out, w, h, q))
      .finally(() => this.inflight.delete(key));
    this.chain = job;
    this.inflight.set(key, job);
    return job;
  }

  private async ffmpeg(src: string, out: string, w: number, h: number, q: number): Promise<string | null> {
    const bin = ffmpegPath();
    if (!bin) return null;
    const video = VIDEO.test(src);
    let orient = 1;
    if (/\.jpe?g$/i.test(src)) {
      try {
        orient = jpegOrientation(readHead(src));
      } catch {
        orient = 1;
      }
    }
    const filters = [...orientationFilter(orient), `scale='min(iw,${w})':'min(ih,${h})':force_original_aspect_ratio=decrease`];
    const tmp = `${out}.part.jpg`;
    const run = (seek: boolean) =>
      new Promise<boolean>((resolve) => {
        const args = ['-y', '-v', 'error', ...(video ? [] : ['-noautorotate']), ...(seek ? ['-ss', '1'] : []), '-i', src, '-vf', filters.join(','), '-frames:v', '1', '-q:v', String(q), tmp];
        const p = spawn(bin, args, { windowsHide: true, stdio: 'ignore' });
        const t = setTimeout(() => p.kill(), 60_000);
        p.on('error', () => resolve(false));
        p.on('exit', (code) => {
          clearTimeout(t);
          resolve(code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 0);
        });
      });
    let ok = await run(video);
    if (!ok && video) ok = await run(false); // shorter than a second
    if (!ok) {
      fs.rmSync(tmp, { force: true });
      return null;
    }
    fs.renameSync(tmp, out);
    return out;
  }
}
