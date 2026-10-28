import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { TorrentEngine } from './torrents';
import type { TvDatabase } from './db';

const collect = (s: Readable) =>
  new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = [];
    s.on('data', (d: Buffer) => parts.push(Buffer.from(d)));
    s.on('end', () => resolve(Buffer.concat(parts)));
    s.on('error', reject);
  });

/** An engine with one fake torrent: 10 pieces of 16 bytes, the first `have` pieces on disk. */
function engineWith(have: number, done = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvbox-tor-'));
  const data = Buffer.from(Array.from({ length: 160 }, (_, i) => i));
  // only the downloaded pieces are real on disk; the rest is still zeros
  const disk = Buffer.alloc(160);
  data.copy(disk, 0, 0, have * 16);
  fs.writeFileSync(path.join(dir, 'ep.mkv'), disk);
  const swarmFrom: number[] = [];
  const file = {
    name: 'ep.mkv',
    path: 'ep.mkv',
    length: 160,
    offset: 0,
    downloaded: have * 16,
    progress: have / 10,
    done,
    select: () => undefined,
    deselect: () => undefined,
    createReadStream: ({ start = 0, end = 159 } = {}) => {
      swarmFrom.push(start);
      return Readable.from([data.subarray(start, end + 1)]);
    },
  };
  const torrent = { path: dir, files: [file], pieceLength: 16, ready: true, destroyed: false, bitfield: { get: (i: number) => i < have } };
  const engine = new TorrentEngine({} as TvDatabase, () => dir);
  (engine as unknown as { entries: Map<string, unknown> }).entries.set('t', {
    id: 't',
    row: { done },
    torrent,
    files: [{ index: 0, name: 'ep.mkv', path: 'ep.mkv', length: 160 }],
    streams: 0,
    pendingDestroy: false,
  });
  return { engine, data, swarmFrom };
}

describe('reading torrent files', () => {
  it('reads the downloaded part from disk and only the rest from the swarm', async () => {
    const { engine, data, swarmFrom } = engineWith(6);
    expect(engine.firstMissingByte('t', 0, 0, 159)).toBe(96);
    const out = await collect(engine.createReadStream('t', 0, 10, 159)!);
    expect(out.equals(data.subarray(10, 160))).toBe(true);
    expect(swarmFrom).toEqual([96]);
  });

  it('a range that is fully downloaded never touches the swarm', async () => {
    const { engine, data, swarmFrom } = engineWith(6);
    const out = await collect(engine.createReadStream('t', 0, 0, 80)!);
    expect(out.equals(data.subarray(0, 81))).toBe(true);
    expect(swarmFrom).toEqual([]);
  });

  it('a range starting at a missing piece goes to the swarm', async () => {
    const { engine, data, swarmFrom } = engineWith(2);
    const out = await collect(engine.createReadStream('t', 0, 40, 100)!);
    expect(out.equals(data.subarray(40, 101))).toBe(true);
    expect(swarmFrom).toEqual([40]);
  });
});
