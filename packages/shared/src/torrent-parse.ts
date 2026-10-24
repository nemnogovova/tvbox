export interface ParsedTorrent {
  raw: string;
  cleanTitle: string;
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  quality?: string;
  codec?: string;
  audio?: string;
  releaseGroup?: string;
  isSeries: boolean;
  isMovie: boolean;
  searchQuery: string;
}

const QUALITIES = ['2160p', '1080p', '720p', '480p', '360p', '4K', 'UHD', 'HD', 'SD'];
const CODECS = ['x264', 'x265', 'h264', 'h265', 'hevc', 'av1', 'xvid', 'divx'];
const AUDIO = ['aac', 'ac3', 'eac3', 'ddp', 'dd', 'dts', 'flac', 'mp3', 'truehd', 'atmos'];
const SOURCE = ['web-dl', 'webrip', 'web', 'bluray', 'blu-ray', 'bdrip', 'brrip', 'dvdrip', 'hdtv', 'pdvd', 'remux', 'hdr', 'dv', 'hdr10', 'hdr10+', 'dovi'];

function stripBrackets(input: string): string {
  return input
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\{[^}]*\}/g, ' ');
}

export function parseTorrentName(raw: string): ParsedTorrent {
  const cleaned = stripBrackets(raw);
  const tokens = cleaned
    .split(/[\s._-]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const season = findSeason(cleaned);
  let episode = findEpisode(cleaned);
  const year = findYear(cleaned);
  const quality = findToken(tokens, QUALITIES);
  const codec = findToken(tokens, CODECS);
  const audio = findToken(tokens, AUDIO);
  const releaseGroup = findReleaseGroup(raw);

  if (season !== undefined && episode === undefined) {
    const combined = cleaned.match(/s\d{1,2}e\d{1,3}/i);
    if (combined) episode = parseInt(combined[0].match(/\d{1,3}$/)![0], 10);
  }

  if (season === undefined && episode === undefined) {
    const dashM = cleaned.match(/-\s*(\d{1,4})(?!\d)/);
    if (dashM) episode = parseInt(dashM[1], 10);
  }

  const stopIndex = findStopIndex(tokens, {
    quality,
    codec,
    audio,
    year,
    season,
    episode,
    releaseGroup,
  });

  const titleTokens = tokens.slice(0, stopIndex);
  let title = titleTokens.join(' ');

  if (!title) title = raw;

  let searchQuery = title;
  if (year && !season) {
    searchQuery = `${title} ${year}`;
  }

  return {
    raw,
    cleanTitle: title,
    title,
    year,
    season,
    episode,
    quality,
    codec,
    audio,
    releaseGroup,
    isSeries: season !== undefined || episode !== undefined,
    isMovie: season === undefined && episode === undefined,
    searchQuery,
  };
}

function findSeason(input: string): number | undefined {
  const m = input.match(/s(\d{1,2})/i) || input.match(/season[.\s-]*(\d{1,2})/i);
  return m ? parseInt(m[1], 10) : undefined;
}

function findEpisode(input: string): number | undefined {
  const m = input.match(/e\s?(\d{1,3})/i);
  return m ? parseInt(m[1], 10) : undefined;
}

function findYear(input: string): number | undefined {
  const m = input.match(/\b(19\d{2}|20\d{2})\b/);
  return m ? parseInt(m[1], 10) : undefined;
}

function findToken(tokens: string[], candidates: string[]): string | undefined {
  const lowered = tokens.map((t) => t.toLowerCase());
  return candidates.find((c) => lowered.includes(c));
}

function findReleaseGroup(raw: string): string | undefined {
  const m = raw.match(/-([a-z0-9]{1,12})$/i);
  if (!m) return undefined;
  const g = m[1].toUpperCase();
  const ignored = new Set([
    'WEB',
    'HDTV',
    'REMUX',
    'BLURAY',
    '1080P',
    '2160P',
    '720P',
    '480P',
    'X264',
    'X265',
    'HEVC',
    'AAC',
    'H264',
    'H265',
    'DD',
    'DTS',
    'HDR',
    'DV',
  ]);
  return ignored.has(g) ? undefined : g;
}

function findStopIndex(
  tokens: string[],
  meta: {
    quality?: string;
    codec?: string;
    audio?: string;
    year?: number;
    season?: number;
    episode?: number;
    releaseGroup?: string;
  },
): number {
  const lowered = tokens.map((t) => t.toLowerCase());
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const lt = lowered[i];
    const isYear = meta.year !== undefined && t === String(meta.year);
    const isSeasonToken = meta.season !== undefined && lt === `s${meta.season}`;
    const isEpisodeToken =
      (meta.episode !== undefined && t === String(meta.episode)) || /^e\d{1,3}$/.test(lt);
    const isCombined = /^s\d{1,2}e\d{1,3}$/.test(lt);
    if (
      (meta.quality && lt === meta.quality) ||
      (meta.codec && lt === meta.codec) ||
      (meta.audio && lt === meta.audio) ||
      isYear ||
      isSeasonToken ||
      isEpisodeToken ||
      isCombined ||
      SOURCE.includes(lt) ||
      (meta.releaseGroup && lt === meta.releaseGroup.toLowerCase())
    ) {
      return i;
    }
  }
  return tokens.length;
}
