import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_SIZE = 300 * 1024 * 1024;
const ALLOWED = /\.(jpe?g|png|gif|webp|avif|bmp|mp4|webm|m4v|mov)$/i;

interface Pending {
  file: string;
  final: string;
  size: number;
  received: number;
  next: number;
  fd: number;
  at: number;
}

/** Files sent from a remote in chunks (screensaver pictures / videos). */
export class Uploads {
  private pending = new Map<string, Pending>();
  readonly dir: string;

  constructor(baseDir: string) {
    this.dir = path.join(baseDir, 'screensaver');
    fs.mkdirSync(this.dir, { recursive: true });
    setInterval(() => this.gc(), 60_000).unref();
  }

  begin(name: string, size: number): { uploadId: string; chunkSize: number } {
    const base = path.basename(String(name || 'file')).replace(/[^\p{L}\p{N}._ -]+/gu, '_').slice(-80);
    if (!ALLOWED.test(base)) throw new Error('unsupported_type');
    if (!(size > 0) || size > MAX_SIZE) throw new Error('too_large');
    const uploadId = crypto.randomBytes(8).toString('hex');
    const ext = path.extname(base);
    const stem = base.slice(0, -ext.length) || 'file';
    let final = path.join(this.dir, base);
    for (let i = 2; fs.existsSync(final); i++) final = path.join(this.dir, `${stem} (${i})${ext}`);
    const file = `${final}.${uploadId}.part`;
    this.pending.set(uploadId, { file, final, size, received: 0, next: 0, fd: fs.openSync(file, 'w'), at: Date.now() });
    return { uploadId, chunkSize: 512 * 1024 };
  }

  chunk(uploadId: string, index: number, data: unknown): number {
    const p = this.pending.get(uploadId);
    if (!p) throw new Error('unknown_upload');
    if (index !== p.next) throw new Error('bad_chunk_order');
    const buf = Buffer.isBuffer(data)
      ? data
      : data instanceof ArrayBuffer
        ? Buffer.from(data)
        : ArrayBuffer.isView(data)
          ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
          : typeof data === 'string'
            ? Buffer.from(data, 'base64')
            : null;
    if (!buf) throw new Error('bad_chunk');
    if (p.received + buf.length > p.size) throw new Error('too_large');
    fs.writeSync(p.fd, buf);
    p.received += buf.length;
    p.next++;
    p.at = Date.now();
    return p.received;
  }

  end(uploadId: string): { name: string; path: string } {
    const p = this.pending.get(uploadId);
    if (!p) throw new Error('unknown_upload');
    this.pending.delete(uploadId);
    fs.closeSync(p.fd);
    if (p.received !== p.size) {
      fs.rmSync(p.file, { force: true });
      throw new Error('incomplete');
    }
    fs.renameSync(p.file, p.final);
    return { name: path.basename(p.final), path: p.final };
  }

  /** Absolute path of an uploaded file by name (null if it does not exist / escapes the folder). */
  resolve(name: string): string | null {
    const full = path.join(this.dir, path.basename(name));
    return fs.existsSync(full) ? full : null;
  }

  remove(name: string): void {
    const full = this.resolve(name);
    if (full) fs.rmSync(full, { force: true });
  }

  /** Remove uploaded files that are no longer referenced by the screensaver settings. */
  prune(keep: string[]): void {
    const set = new Set(keep.map((n) => path.basename(n)));
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.part') && !set.has(f)) fs.rmSync(path.join(this.dir, f), { force: true });
    }
  }

  private gc(): void {
    for (const [id, p] of this.pending) {
      if (Date.now() - p.at > 10 * 60_000) {
        try {
          fs.closeSync(p.fd);
        } catch {
          // ignore
        }
        fs.rmSync(p.file, { force: true });
        this.pending.delete(id);
      }
    }
  }
}
