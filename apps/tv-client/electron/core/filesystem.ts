import fs from 'node:fs';
import path from 'node:path';
import type { FsEntry, FsEntryKind } from '@tvbox/shared';

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.ts', '.m2ts']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

export function isVideoFile(p: string): boolean {
  return VIDEO_EXT.has(path.extname(p).toLowerCase());
}
export function isAudioFile(p: string): boolean {
  return AUDIO_EXT.has(path.extname(p).toLowerCase());
}
export function isImageFile(p: string): boolean {
  return IMAGE_EXT.has(path.extname(p).toLowerCase());
}

export function classify(p: string): FsEntryKind {
  const ext = path.extname(p).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (IMAGE_EXT.has(ext)) return 'image';
  return 'other';
}

export function listDirectory(input: string): FsEntry[] {
  const dir = input && input !== '/' ? path.resolve(input) : '';
  if (!dir) {
    return driveRoots();
  }
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const result: FsEntry[] = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        result.push({ name: e.name, path: full, kind: 'dir' });
      } else if (e.isFile()) {
        const stat = fs.statSync(full);
        result.push({ name: e.name, path: full, kind: classify(full), size: stat.size, modifiedAt: stat.mtimeMs });
      }
    }
    return result.sort((a, b) =>
      a.kind === 'dir' && b.kind !== 'dir' ? -1 : b.kind === 'dir' && a.kind !== 'dir' ? 1 : a.name.localeCompare(b.name),
    );
  } catch {
    return [];
  }
}

function driveRoots(): FsEntry[] {
  if (process.platform === 'win32') {
    const roots: FsEntry[] = [];
    for (let c = 65; c <= 90; c++) {
      const letter = `${String.fromCharCode(c)}:\\`;
      try {
        if (fs.existsSync(letter)) roots.push({ name: letter, path: letter, kind: 'dir' });
      } catch {
        // skip
      }
    }
    return roots;
  }
  return [{ name: '/', path: '/', kind: 'dir' }];
}
