// Parsing and ranking of torrent release names for the catalog ("Смотреть" → list of releases).

export interface ParsedRelease {
  /** 2160p / 1080p / 720p / SD */
  quality?: string;
  tags: string[];
  /** Season(s) covered: a single season or a range start */
  season?: number;
  seasonTo?: number;
  episode?: number;
  /** Whole season(s) rather than one episode */
  pack: boolean;
  years: number[];
  /** Russian dub / voice-over present */
  russianAudio: boolean;
  /** Camera / telesync rip — bad quality */
  cam: boolean;
  is3d: boolean;
}

const has = (re: RegExp, s: string) => re.test(s);

export function parseRelease(raw: string): ParsedRelease {
  const s = ` ${raw.replace(/[._]+/g, ' ')} `;
  const tags: string[] = [];
  let quality: string | undefined;
  if (has(/\b(2160p|4k|uhd)\b/i, s)) quality = '2160p';
  else if (has(/\b1080[pi]\b/i, s)) quality = '1080p';
  else if (has(/\b720p\b/i, s)) quality = '720p';
  else if (has(/\b(480p|576p|dvdrip|dvd5|dvd9|satrip|tvrip|vhsrip|xvid|divx)\b/i, s)) quality = 'SD';

  if (has(/\bremux\b/i, s)) tags.push('Remux');
  else if (has(/\b(blu-?ray|bdrip|bd-?rip|bdremux)\b/i, s)) tags.push('BluRay');
  else if (has(/\bweb-?dl\b/i, s)) tags.push('WEB-DL');
  else if (has(/\bweb-?rip\b/i, s)) tags.push('WEBRip');
  else if (has(/\bhdtv(rip)?\b/i, s)) tags.push('HDTV');
  if (has(/\b(dolby ?vision|dovi|dv)\b/i, s) && has(/\b(dolby ?vision|dovi|hdr|2160p|4k)\b/i, s)) tags.push('Dolby Vision');
  if (has(/\bhdr ?10\+|hdr10plus\b/i, s)) tags.push('HDR10+');
  else if (has(/\bhdr(10)?\b/i, s)) tags.push('HDR');
  if (has(/\b(hevc|x265|h ?265)\b/i, s)) tags.push('HEVC');

  // Russian release conventions: "Дубляж", "D" / "P" / "MVO" / "AVO" markers, studios
  const dub = has(/дубл|\bdub(bed)?\b|\| ?d\b|\bd\b(?= ?[|,\]])/i, s);
  const mvo = has(/многоголос|\bmvo\b|\| ?p\b|lostfilm|newstudio|hdrezka|rezka|кубик в кубе|kubik|jaskier|amedia|baibako|coldfilm|alexfilm|tvshows|ideafilm|novamedia|red head sound|кинопоиск|ozz|le-production|sdi media/i, s);
  const avo = has(/авторск|одноголос|\bavo\b|\bvo\b|гоблин|гаврилов|володарск|сербин|живов|пучков/i, s);
  if (dub) tags.push('Дубляж');
  else if (mvo) tags.push('Многоголосый');
  else if (avo) tags.push('Авторский');
  const sub = has(/субтитр|\bsubs?\b/i, s);
  if (sub && !dub && !mvo && !avo) tags.push('Субтитры');
  const russianAudio = dub || mvo || avo || has(/\brus\b|русск/i, s);

  const cam = has(/\b(camrip|cam-?rip|hdcam|ts|telesync|hdts|tc|telecine|screener|scr)\b/i, s) && !has(/\b(web|bd|blu)/i, s);
  const is3d = has(/\b3d\b|half-?sbs|half-?ou/i, s);
  if (is3d) tags.push('3D');

  // seasons / episodes
  let season: number | undefined;
  let seasonTo: number | undefined;
  let episode: number | undefined;
  let pack = false;
  let m: RegExpExecArray | null;
  if ((m = /\bs(\d{1,2}) ?e(\d{1,3})(?!\s*-\s*e?\d)/i.exec(s))) {
    season = +m[1];
    episode = +m[2];
  } else if ((m = /\bs(\d{1,2}) ?e\d{1,3} ?- ?e?\d{1,3}/i.exec(s))) {
    season = +m[1];
    pack = true;
  } else if ((m = /(?:сезон[ыа]?|seasons?)[:\s]*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?/i.exec(s))) {
    season = +m[1];
    if (m[2]) seasonTo = +m[2];
    pack = true;
  } else if ((m = /\b(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\s*(?:сезон|season)/i.exec(s))) {
    season = +m[1];
    if (m[2]) seasonTo = +m[2];
    pack = true;
  } else if ((m = /\bs(\d{1,2})(?:\s*-\s*s?(\d{1,2}))?\b/i.exec(s))) {
    season = +m[1];
    if (m[2]) seasonTo = +m[2];
    pack = true;
  }
  if (season !== undefined && !pack && has(/серии[:\s]*\d+\s*-\s*\d+|episodes?\s*\d+\s*-\s*\d+/i, s)) pack = true;
  if (has(/complete|полный сезон|все сезоны|all seasons/i, s)) pack = true;

  const years = Array.from(new Set((s.match(/\b(19[2-9]\d|20[0-4]\d)\b/g) || []).map(Number)));
  return { quality, tags, season, seasonTo, episode, pack, years, russianAudio, cam, is3d };
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .trim();

/** All significant words of the title are present in the release name. */
export function titleMatches(release: string, titles: string[]): boolean {
  const r = ` ${norm(release)} `;
  return titles.some((t) => {
    const words = norm(t)
      .split(' ')
      .filter((w) => w.length > 1 || /\d/.test(w));
    if (!words.length) return false;
    return words.every((w) => r.includes(` ${w} `) || (w.length > 4 && r.includes(w)));
  });
}

export interface RankInput {
  title: string;
  size: number;
  seeders: number;
  wanted: { titles: string[]; year?: number; type: 'movie' | 'tv'; season?: number };
}

/** Bigger is better: right title & year, Russian audio, 1080p, healthy seeds, sane size. */
export function rankRelease(r: RankInput, info = parseRelease(r.title)): { score: number; matched: boolean } {
  const { wanted } = r;
  const titleOk = titleMatches(r.title, wanted.titles);
  const yearOk =
    wanted.type === 'tv' || !wanted.year || !info.years.length || info.years.some((y) => Math.abs(y - (wanted.year as number)) <= 1);
  let seasonOk = true;
  if (wanted.type === 'tv' && wanted.season !== undefined) {
    if (info.season === undefined) seasonOk = info.pack;
    else seasonOk = info.season === wanted.season || (info.seasonTo !== undefined && info.season <= wanted.season && wanted.season <= info.seasonTo);
  }
  const matched = titleOk && yearOk && seasonOk;
  let score = 0;
  if (matched) score += 1000;
  else if (titleOk) score += 300;
  score += { '2160p': 150, '1080p': 200, '720p': 120, SD: 30 }[info.quality || ''] ?? 60;
  score += Math.log2(r.seeders + 1) * 45;
  if (r.seeders === 0) score -= 400;
  if (info.tags.includes('Дубляж')) score += 90;
  else if (info.tags.includes('Многоголосый')) score += 70;
  else if (info.tags.includes('Авторский')) score += 35;
  else if (info.russianAudio) score += 30;
  if (info.tags.includes('WEB-DL') || info.tags.includes('BluRay')) score += 25;
  if (info.cam) score -= 500;
  if (info.is3d) score -= 250;
  // streaming over the network: giant remuxes are slow to start
  const gb = r.size / 1024 ** 3;
  const big = wanted.type === 'movie' ? 35 : 120;
  if (gb > big) score -= Math.min(150, (gb - big) * 4);
  if (gb > 0 && gb < (wanted.type === 'movie' ? 0.4 : 0.15)) score -= 200;
  if (wanted.type === 'tv' && info.pack) score += 40;
  return { score: Math.round(score), matched };
}
