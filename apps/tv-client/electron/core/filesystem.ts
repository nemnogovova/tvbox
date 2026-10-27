import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mediaKindOfFile, type FsEntry, type FsEntryKind, type FsListResult } from '@tvbox/shared';

export function classify(name: string): FsEntryKind {
  if (/\.torrent$/i.test(name)) return 'torrent';
  if (/\.(exe|lnk|url|bat|cmd)$/i.test(name)) return 'app';
  return mediaKindOfFile(name) ?? 'other';
}

function appRoots(): FsEntry[] {
  const out: FsEntry[] = [];
  const add = (p: string | undefined, name: string) => {
    if (!p) return;
    try {
      if (fs.statSync(p).isDirectory() && !out.some((e) => e.path.toLowerCase() === p.toLowerCase())) out.push({ name, path: p, kind: 'dir' });
    } catch {
      // missing
    }
  };
  const home = os.homedir();
  add(path.join(home, 'Desktop'), 'Рабочий стол');
  add(path.join(home, 'Downloads'), 'Загрузки');
  add(process.env.ProgramFiles, 'Program Files');
  add(process.env['ProgramFiles(x86)'], 'Program Files (x86)');
  add(process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'), 'Программы пользователя');
  for (const steam of [process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)']!, 'Steam', 'steamapps', 'common'), 'D:\\SteamLibrary\\steamapps\\common', 'E:\\SteamLibrary\\steamapps\\common']) {
    add(steam || undefined, `Игры Steam${steam && /^[A-Z]:\\SteamLibrary/i.test(steam) ? ` (${steam.slice(0, 2)})` : ''}`);
  }
  add('C:\\Games', 'C:\\Games');
  add('D:\\Games', 'D:\\Games');
  for (let c = 67; c <= 90; c++) add(`${String.fromCharCode(c)}:\\`, `Диск ${String.fromCharCode(c)}:`);
  return out;
}

function roots(extra: string[]): FsEntry[] {
  const out: FsEntry[] = [];
  const add = (p: string, name?: string) => {
    try {
      if (fs.statSync(p).isDirectory() && !out.some((e) => e.path === p)) out.push({ name: name || p, path: p, kind: 'dir' });
    } catch {
      // missing
    }
  };
  for (const d of extra) add(d, `★ ${path.basename(d) || d}`);
  const home = os.homedir();
  add(path.join(home, 'Videos'), 'Видео');
  add(path.join(home, 'Downloads'), 'Загрузки');
  add(path.join(home, 'Desktop'), 'Рабочий стол');
  add(path.join(home, 'Music'), 'Музыка');
  add(path.join(home, 'Pictures'), 'Изображения');
  if (process.platform === 'win32') {
    for (let c = 67; c <= 90; c++) add(`${String.fromCharCode(c)}:\\`, `Диск ${String.fromCharCode(c)}:`);
  } else {
    add('/', '/');
    add('/media', '/media');
    add('/mnt', '/mnt');
  }
  return out;
}

export async function listDirectory(input: string | undefined, favorites: string[], purpose: 'media' | 'apps' = 'media'): Promise<FsListResult> {
  const dir = input ? path.resolve(input) : '';
  if (!dir) return { path: '', parent: null, entries: purpose === 'apps' && process.platform === 'win32' ? appRoots() : roots(favorites) };
  const parentDir = path.dirname(dir);
  const parent = parentDir === dir ? '' : parentDir;
  try {
    const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    const entries: FsEntry[] = [];
    for (const e of dirents) {
      if (e.name.startsWith('.') || e.name.startsWith('$')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) entries.push({ name: e.name, path: full, kind: 'dir' });
      else if (e.isFile()) {
        let size: number | undefined;
        let modifiedAt: number | undefined;
        try {
          const st = await fs.promises.stat(full);
          size = st.size;
          modifiedAt = st.mtimeMs;
        } catch {
          // unreadable
        }
        entries.push({ name: e.name, path: full, kind: classify(e.name), size, modifiedAt });
      }
    }
    const rank = (k: FsEntryKind) => (k === 'dir' ? 0 : purpose === 'apps' ? (k === 'app' ? 1 : 2) : k === 'other' || k === 'app' ? 2 : 1);
    entries.sort((a, b) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name, 'ru', { numeric: true }));
    return { path: dir, parent, entries };
  } catch (e) {
    return { path: dir, parent, entries: [], error: `Нет доступа: ${(e as Error).message}` };
  }
}

/** External subtitle files that sit next to a video (same base name). */
export function findExternalSubtitles(videoPath: string): { path: string; label: string }[] {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
  const out: { path: string; label: string }[] = [];
  const read = (d: string) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const isSub = (n: string) => /\.(srt|vtt|ass|ssa)$/i.test(n);
  const label = (n: string, strip: string) =>
    n.slice(0, -path.extname(n).length).slice(strip.length).replace(/^[.\s_-]+/, '') || 'Внешние';

  for (const e of read(dir)) {
    if (e.isFile() && isSub(e.name) && e.name.toLowerCase().startsWith(base)) {
      out.push({ path: path.join(dir, e.name), label: label(e.name, base) });
    } else if (e.isDirectory() && /^(subs?|subtitles|субтитры)$/i.test(e.name)) {
      const subDir = path.join(dir, e.name);
      for (const s of read(subDir)) {
        if (s.isFile() && isSub(s.name) && s.name.toLowerCase().includes(base)) {
          out.push({ path: path.join(subDir, s.name), label: label(s.name, '') });
        } else if (s.isDirectory() && s.name.toLowerCase() === base) {
          for (const f of read(path.join(subDir, s.name))) {
            if (f.isFile() && isSub(f.name)) out.push({ path: path.join(subDir, s.name, f.name), label: label(f.name, '') });
          }
        }
      }
    }
  }
  return out.slice(0, 12);
}
