export interface ParsedName {
  raw: string;
  /** Clean human title (first part for "Русское / English" names) */
  title: string;
  /** Second title variant for "Русское / English" style names */
  altTitle?: string;
  year?: number;
  season?: number;
  episode?: number;
  quality?: string;
  releaseGroup?: string;
  isSeries: boolean;
  /** Best query for a TMDb search */
  searchQuery: string;
}

const MEDIA_EXT = /\.(mkv|mp4|m4v|avi|mov|wmv|webm|ts|m2ts|mpg|mpeg|flv|mp3|flac|m4a|aac|ogg|opus|wav|torrent)$/i;

// Tokens after which the title surely ended (case-insensitive, whole words).
const JUNK = [
  '2160p', '1080p', '1080i', '720p', '576p', '480p', '360p', '4k', 'uhd', 'fhd',
  'web-dl', 'webdl', 'web-dlrip', 'webrip', 'web', 'hdtv', 'hdtvrip', 'bluray', 'blu-ray', 'bdrip', 'brrip', 'bdremux',
  'dvdrip', 'dvd5', 'dvd9', 'hdrip', 'camrip', 'ts', 'tc', 'remux', 'hdr', 'hdr10', 'dv', 'dovi', 'sdr', 'imax',
  'x264', 'x265', 'h264', 'h265', 'h.264', 'h.265', 'hevc', 'avc', 'xvid', 'divx', 'av1', '10bit', '8bit',
  'aac', 'ac3', 'eac3', 'ddp', 'dd5', 'dts', 'dts-hd', 'truehd', 'atmos', 'flac', 'mp3', 'opus',
  'proper', 'repack', 'extended', 'unrated', 'directors', 'remastered', 'multi', 'dub', 'mvo', 'avo', 'dvo',
  'rus', 'eng', 'ukr', 'sub', 'subs', 'complete', 'amzn', 'nf', 'hmax', 'dsnp', 'atvp', 'itunes',
];
const JUNK_SET = new Set(JUNK);

const QUALITY_RE = /\b(2160p|1080p|1080i|720p|576p|480p|4k)\b/i;

export function stripExtension(name: string): string {
  return name.replace(MEDIA_EXT, '');
}

export function parseMediaName(input: string): ParsedName {
  const raw = input;
  let s = stripExtension(input.trim());

  // Release group in leading brackets: [SubsPlease] Show - 05
  let releaseGroup: string | undefined;
  const lead = s.match(/^\s*\[([^\]]+)\]\s*/);
  if (lead) {
    releaseGroup = lead[1];
    s = s.slice(lead[0].length);
  }
  // Trailing "-GROUP"
  const trail = s.match(/-([A-Za-z0-9]{2,15})$/);
  if (trail && !JUNK_SET.has(trail[1].toLowerCase()) && !/^\d+$/.test(trail[1])) {
    releaseGroup = releaseGroup || trail[1];
  }

  const quality = s.match(QUALITY_RE)?.[1]?.toLowerCase();

  // Year: prefer one in parentheses / brackets, else a standalone one (not at the very start)
  let year: number | undefined;
  const yParen = s.match(/[([]\s*((?:19|20)\d{2})\s*[)\]]/);
  if (yParen) year = parseInt(yParen[1], 10);

  // Normalise separators
  let t = s
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\(([^)]*)\)/g, ' ($1) ')
    // dots/underscores become spaces, except inside numbers like 5.1
    .replace(/(\d{2,})[._](?=\d)/g, '$1 ')
    .replace(/(?<!\d)[._]|[._](?!\d)/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Season / episode detection (order matters)
  let season: number | undefined;
  let episode: number | undefined;
  let stopAt = t.length;
  const mark = (idx: number | undefined) => {
    if (idx !== undefined && idx >= 0 && idx < stopAt) stopAt = idx;
  };

  const se = /\bS(\d{1,2})[ .-]?E(\d{1,3})(?:[-E]+\d{1,3})?\b/i.exec(t);
  if (se) {
    season = parseInt(se[1], 10);
    episode = parseInt(se[2], 10);
    mark(se.index);
  } else {
    const x = /\b(\d{1,2})x(\d{2,3})\b/i.exec(t);
    if (x) {
      season = parseInt(x[1], 10);
      episode = parseInt(x[2], 10);
      mark(x.index);
    }
  }
  if (season === undefined) {
    const sOnly = /(?<![\p{L}\p{N}])(?:S(\d{1,2})|Season\s*(\d{1,2})|Сезон\s*(\d{1,2})|(\d{1,2})\s*сезон)(?![\p{L}\p{N}])/iu.exec(t);
    if (sOnly) {
      season = parseInt(sOnly[1] || sOnly[2] || sOnly[3] || sOnly[4], 10);
      mark(sOnly.index);
    }
  }
  if (episode === undefined) {
    const eOnly = /(?<![\p{L}\p{N}])(?:E|Ep|Episode|Серия)\s*(\d{1,3})(?![\p{L}\p{N}])/iu.exec(t);
    if (eOnly) {
      episode = parseInt(eOnly[1], 10);
      mark(eOnly.index);
    }
  }
  if (season === undefined && episode === undefined) {
    // Anime style: "Show - 05" / "Show - 105"
    const anime = /\s-\s(\d{1,4})(?:v\d)?\b/.exec(t);
    if (anime && !/^(19|20)\d{2}$/.test(anime[1])) {
      episode = parseInt(anime[1], 10);
      mark(anime.index);
    }
  }

  // Year (standalone) — not at position 0 so titles like "1917" or "2012" survive
  const yearRe = /\(?\b((?:19|20)\d{2})\b\)?/g;
  let ym: RegExpExecArray | null;
  while ((ym = yearRe.exec(t))) {
    if (ym.index === 0) continue;
    if (year === undefined) year = parseInt(ym[1], 10);
    if (parseInt(ym[1], 10) === year) {
      mark(ym.index);
      break;
    }
  }

  // Junk tokens
  const words = t.split(' ');
  let pos = 0;
  for (const w of words) {
    const lw = w.toLowerCase().replace(/^[([]+|[)\],]+$/g, '');
    if (pos > 0 && (JUNK_SET.has(lw) || QUALITY_RE.test(lw))) {
      mark(pos);
      break;
    }
    pos += w.length + 1;
  }

  let titlePart = t.slice(0, stopAt).replace(/[\s\-–—:|,(.]+$/g, '').replace(/^[\s\-–—]+/, '').trim();
  if (!titlePart && stopAt > 0) titlePart = t.trim() || raw;

  // "Русское название / English title"
  let title = titlePart;
  let altTitle: string | undefined;
  const slash = titlePart.split(/\s+\/\s+|\s*\|\s*/).map((p) => p.trim()).filter(Boolean);
  if (slash.length >= 2) {
    title = slash[0];
    altTitle = slash[slash.length - 1];
  }
  title = tidy(title);
  if (altTitle) altTitle = tidy(altTitle);

  const isSeries = season !== undefined || episode !== undefined;
  // Prefer a Latin-script variant for TMDb search; it matches more reliably.
  const latin = [altTitle, title].find((v) => v && /[a-z]/i.test(v) && !/[а-яё]/i.test(v));
  const searchQuery = latin || title;

  return { raw, title, altTitle, year, season, episode, quality, releaseGroup, isSeries, searchQuery };
}

function tidy(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/\s*\(\s*\)\s*/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

/** Kept for backwards compatibility with older code. */
export const parseTorrentName = parseMediaName;

/** Lower-case alphanumeric key used to group episodes of the same show. */
export function showKeyFor(title: string): string {
  return title
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .trim()
    .replace(/\s+/g, '-');
}
