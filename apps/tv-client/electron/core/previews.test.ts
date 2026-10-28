import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { jpegOrientation, orientationFilter, Previews } from './previews';
import { Uploads } from './uploads';
import { SystemVolume } from './system';
import { ffmpegPath } from './ffmpeg';

/** Minimal JPEG header with an EXIF orientation tag (enough for the parser). */
function exifJpeg(orientation: number, littleEndian = false): Buffer {
  const u16 = (v: number) => (littleEndian ? Buffer.from([v & 255, v >> 8]) : Buffer.from([v >> 8, v & 255]));
  const u32 = (v: number) => {
    const b = Buffer.alloc(4);
    if (littleEndian) b.writeUInt32LE(v);
    else b.writeUInt32BE(v);
    return b;
  };
  const tiff = Buffer.concat([Buffer.from(littleEndian ? 'II' : 'MM', 'latin1'), u16(42), u32(8), u16(1), u16(0x0112), u16(3), u32(1), u16(orientation), u16(0), u32(0)]);
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), u16BE(app1.length + 2), app1, Buffer.from([0xff, 0xda, 0, 2])]);
}
const u16BE = (v: number) => Buffer.from([v >> 8, v & 255]);

describe('EXIF orientation', () => {
  it('reads the orientation of big- and little-endian EXIF', () => {
    expect(jpegOrientation(exifJpeg(6))).toBe(6);
    expect(jpegOrientation(exifJpeg(8, true))).toBe(8);
    expect(jpegOrientation(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBe(1);
    expect(jpegOrientation(Buffer.from('not a jpeg'))).toBe(1);
  });
  it('maps orientations to ffmpeg filters', () => {
    expect(orientationFilter(1)).toEqual([]);
    expect(orientationFilter(6)).toEqual(['transpose=1']);
    expect(orientationFilter(8)).toEqual(['transpose=2']);
    expect(orientationFilter(3)).toEqual(['hflip', 'vflip']);
  });
});

const hasFfmpeg = !!ffmpegPath();

describe.skipIf(!hasFfmpeg)('screensaver previews (ffmpeg)', () => {
  let dir: string;
  let uploads: Uploads;
  let previews: Previews;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvbox-prev-'));
    uploads = new Uploads(dir);
    previews = new Previews(dir, (n) => uploads.resolve(n));
    // a 1600×900 picture made by ffmpeg itself
    spawnSync(ffmpegPath()!, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1600x900', '-frames:v', '1', path.join(uploads.dir, 'pic.png')]);
  });

  it('makes a small JPEG preview as a data URL', async () => {
    const url = await previews.thumbDataUrl('pic.png');
    expect(url).toMatch(/^data:image\/jpeg;base64,/);
    expect(Buffer.from(url!.split(',')[1], 'base64').length).toBeLessThan(40_000);
  });

  it('makes a screen-sized copy once and reuses it', async () => {
    const a = await previews.display('pic.png', 800, 450);
    expect(a && fs.existsSync(a)).toBeTruthy();
    const t = fs.statSync(a!).mtimeMs;
    const b = await previews.display('pic.png', 800, 450);
    expect(b).toBe(a);
    expect(fs.statSync(b!).mtimeMs).toBe(t);
  });

  it('answers null for files that are not there', async () => {
    expect(await previews.thumbDataUrl('missing.jpg')).toBeNull();
    expect(await previews.display('../../etc/passwd', 800, 450)).toBeNull();
  });

  it('keeps fresh uploads when pruning (still being edited on a remote)', () => {
    fs.writeFileSync(path.join(uploads.dir, 'fresh.jpg'), 'x');
    const old = path.join(uploads.dir, 'old.jpg');
    fs.writeFileSync(old, 'x');
    const longAgo = new Date(Date.now() - 24 * 3600 * 1000);
    fs.utimesSync(old, longAgo, longAgo);
    uploads.prune(['pic.png']);
    expect(fs.existsSync(path.join(uploads.dir, 'fresh.jpg'))).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(path.join(uploads.dir, 'pic.png'))).toBe(true);
  });
});

// on Windows / macOS this would really change the PC's volume while building
describe.skipIf(process.platform !== 'linux')('system volume', () => {
  it('quick changes collapse and the reported volume never goes back', async () => {
    const v = new SystemVolume();
    const seen: number[] = [];
    let cur = 0.3;
    for (let i = 0; i < 10; i++) {
      cur = Math.round((cur + 0.05) * 100) / 100;
      seen.push((await v.setVolume(cur)).volume);
    }
    expect(seen).toEqual([0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8]);
    expect((await v.settled()).volume).toBe(0.8);
  });
});
