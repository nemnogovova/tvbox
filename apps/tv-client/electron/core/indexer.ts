import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseRelease,
  rankRelease,
  type IndexerSettings,
  type IndexerStatus,
  type TorrentResult,
  type TorrentSearchResult,
} from '@tvbox/shared';

/**
 * Torrent search through the user's own Jackett or Prowlarr.
 * Those tools hold the tracker accounts and do the scraping; TVBox only asks them and ranks
 * the answers. When nothing is configured, a Jackett / Prowlarr installed on this PC is found
 * automatically (its API key is read from its own config file), so usually there's nothing to set up.
 */

interface Raw {
  title: string;
  size: number;
  seeders: number;
  leechers: number;
  tracker: string;
  publishedAt?: number;
  magnet?: string;
  link?: string;
  infoHash?: string;
}

interface JackettResponse {
  Results?: {
    Title: string;
    Size?: number;
    Seeders?: number;
    Peers?: number;
    Tracker?: string;
    PublishDate?: string;
    MagnetUri?: string | null;
    Link?: string | null;
    InfoHash?: string | null;
  }[];
  Indexers?: { Name: string; Status: number; Results: number; Error?: string | null }[];
}

interface ProwlarrResult {
  title: string;
  size?: number;
  seeders?: number;
  leechers?: number;
  indexer?: string;
  publishDate?: string;
  magnetUrl?: string;
  downloadUrl?: string;
  infoHash?: string;
}

const CATEGORIES = { movie: [2000], tv: [5000] } as const;

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Jackett / Prowlarr installed on this PC (Windows service or user install). */
export function detectLocalIndexer(): IndexerSettings | null {
  const roots = [process.env.ProgramData || 'C:\\ProgramData', process.env.LOCALAPPDATA, process.env.APPDATA].filter(Boolean) as string[];
  for (const r of roots) {
    const cfg = readJson(path.join(r, 'Jackett', 'ServerConfig.json'));
    if (cfg && typeof cfg.APIKey === 'string' && cfg.APIKey) {
      const port = Number(cfg.Port) || 9117;
      const base = typeof cfg.BasePathOverride === 'string' && cfg.BasePathOverride ? `/${String(cfg.BasePathOverride).replace(/^\/|\/$/g, '')}` : '';
      return { kind: 'jackett', url: `http://127.0.0.1:${port}${base}`, apiKey: cfg.APIKey };
    }
  }
  for (const r of roots) {
    try {
      const xml = fs.readFileSync(path.join(r, 'Prowlarr', 'config.xml'), 'utf-8');
      const key = /<ApiKey>([^<]+)<\/ApiKey>/i.exec(xml)?.[1];
      if (key) {
        const port = Number(/<Port>(\d+)<\/Port>/i.exec(xml)?.[1]) || 9696;
        const base = /<UrlBase>([^<]*)<\/UrlBase>/i.exec(xml)?.[1]?.replace(/^\/|\/$/g, '');
        return { kind: 'prowlarr', url: `http://127.0.0.1:${port}${base ? `/${base}` : ''}`, apiKey: key };
      }
    } catch {
      // not installed here
    }
  }
  return null;
}

export class IndexerClient {
  private detected: { at: number; value: IndexerSettings | null } | null = null;
  private cache = new Map<string, { at: number; value: TorrentSearchResult }>();

  constructor(private readonly configured: () => IndexerSettings | null | undefined) {}

  /** Settings in use: configured ones, or a local Jackett / Prowlarr. */
  settings(): { s: IndexerSettings | null; mode: IndexerStatus['mode'] } {
    const c = this.configured();
    if (c && c.url && c.apiKey) return { s: c, mode: 'configured' };
    if (!this.detected || Date.now() - this.detected.at > 60_000) this.detected = { at: Date.now(), value: detectLocalIndexer() };
    return this.detected.value ? { s: this.detected.value, mode: 'auto' } : { s: null, mode: 'none' };
  }

  async status(test = false): Promise<IndexerStatus> {
    const { s, mode } = this.settings();
    if (!s) return { mode: 'none' };
    const base: IndexerStatus = { mode, kind: s.kind, url: s.url };
    if (!test) return base;
    try {
      return { ...base, trackers: await this.test(s) };
    } catch (e) {
      return { ...base, error: (e as Error).message };
    }
  }

  /** Number of trackers the indexer has; throws with a readable error. */
  async test(s: IndexerSettings): Promise<number> {
    const url = s.url.replace(/\/$/, '');
    if (s.kind === 'prowlarr') {
      const res = await fetchWithTimeout(`${url}/api/v1/indexer`, { headers: { 'X-Api-Key': s.apiKey } }, 10000);
      if (res.status === 401) throw new Error('Неверный API-ключ Prowlarr');
      if (!res.ok) throw new Error(`Prowlarr ответил ${res.status}`);
      const list = (await res.json()) as { enable?: boolean }[];
      return list.filter((x) => x.enable !== false).length;
    }
    const res = await fetchWithTimeout(`${url}/api/v2.0/indexers/all/results?apikey=${encodeURIComponent(s.apiKey)}&Query=tvbox-test`, {}, 30000);
    if (res.status === 401 || res.status === 403) throw new Error('Неверный API-ключ Jackett');
    if (!res.ok) throw new Error(`Jackett ответил ${res.status}`);
    const body = (await res.json()) as JackettResponse;
    return (body.Indexers || []).length;
  }

  private async query(s: IndexerSettings, q: string, cats: readonly number[] | null): Promise<{ results: Raw[]; errors: string[] }> {
    const url = s.url.replace(/\/$/, '');
    if (s.kind === 'prowlarr') {
      const u = new URL(`${url}/api/v1/search`);
      u.searchParams.set('query', q);
      u.searchParams.set('type', 'search');
      for (const c of cats || []) u.searchParams.append('categories', String(c));
      u.searchParams.set('limit', '200');
      const res = await fetchWithTimeout(u.toString(), { headers: { 'X-Api-Key': s.apiKey } }, 45000);
      if (!res.ok) throw new Error(res.status === 401 ? 'Неверный API-ключ Prowlarr' : `Prowlarr ответил ${res.status}`);
      const list = (await res.json()) as ProwlarrResult[];
      return {
        errors: [],
        results: list.map((r) => ({
          title: r.title,
          size: r.size || 0,
          seeders: r.seeders || 0,
          leechers: r.leechers || 0,
          tracker: r.indexer || 'Prowlarr',
          publishedAt: r.publishDate ? Date.parse(r.publishDate) || undefined : undefined,
          magnet: r.magnetUrl?.startsWith('magnet:') ? r.magnetUrl : undefined,
          link: r.downloadUrl || (r.magnetUrl && !r.magnetUrl.startsWith('magnet:') ? r.magnetUrl : undefined),
          infoHash: r.infoHash || undefined,
        })),
      };
    }
    const u = new URL(`${url}/api/v2.0/indexers/all/results`);
    u.searchParams.set('apikey', s.apiKey);
    u.searchParams.set('Query', q);
    for (const c of cats || []) u.searchParams.append('Category[]', String(c));
    const res = await fetchWithTimeout(u.toString(), {}, 45000);
    if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'Неверный API-ключ Jackett' : `Jackett ответил ${res.status}`);
    const body = (await res.json()) as JackettResponse;
    return {
      errors: (body.Indexers || []).filter((i) => i.Status === 1 || i.Error).map((i) => i.Name),
      results: (body.Results || []).map((r) => ({
        title: r.Title,
        size: r.Size || 0,
        seeders: r.Seeders || 0,
        leechers: Math.max(0, (r.Peers || 0) - (r.Seeders || 0)),
        tracker: r.Tracker || 'Jackett',
        publishedAt: r.PublishDate ? Date.parse(r.PublishDate) || undefined : undefined,
        magnet: r.MagnetUri || undefined,
        link: r.Link || undefined,
        infoHash: r.InfoHash || undefined,
      })),
    };
  }

  /**
   * Search releases. For catalog items several queries run at once (localized and original title,
   * with the year for movies) and the answers are merged and ranked.
   */
  async search(opts: { titles?: string[]; year?: number; type?: 'movie' | 'tv'; season?: number; query?: string }): Promise<TorrentSearchResult> {
    const { s } = this.settings();
    if (!s) throw new Error('no_indexer');
    const type = opts.type || 'movie';
    const titles = (opts.titles || []).filter(Boolean);
    const queries = opts.query?.trim()
      ? [opts.query.trim()]
      : Array.from(
          new Set(
            titles.flatMap((t) => {
              const clean = t.replace(/[:!?«»"]/g, ' ').replace(/\s+/g, ' ').trim();
              if (type === 'movie' && opts.year) return [`${clean} ${opts.year}`];
              return [clean];
            }),
          ),
        ).slice(0, 3);
    if (!queries.length) return { results: [], queries: [] };

    const key = JSON.stringify([s.url, queries, type, opts.season]);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;

    const cats = opts.query ? null : CATEGORIES[type];
    const runs = await Promise.allSettled(queries.map((q) => this.query(s, q, cats)));
    let raw: Raw[] = [];
    const errors = new Set<string>();
    for (const r of runs) {
      if (r.status === 'fulfilled') {
        raw.push(...r.value.results);
        r.value.errors.forEach((e) => errors.add(e));
      } else errors.add(r.reason?.message || 'error');
    }
    // some trackers file things under their own categories: retry once without the category filter
    if (raw.length < 5 && cats && runs.some((r) => r.status === 'fulfilled')) {
      const again = await Promise.allSettled(queries.map((q) => this.query(s, q, null)));
      for (const r of again) if (r.status === 'fulfilled') raw.push(...r.value.results);
    }
    if (!raw.length && runs.every((r) => r.status === 'rejected')) {
      throw new Error((runs[0] as PromiseRejectedResult).reason?.message || 'indexer_failed');
    }

    // merge duplicates (same infohash or the same name on several trackers)
    const byKey = new Map<string, Raw>();
    for (const r of raw) {
      if (!r.title || (!r.magnet && !r.link)) continue;
      const k = (r.infoHash || '').toLowerCase() || `${r.title.toLowerCase()}|${Math.round(r.size / 1e6)}`;
      const prev = byKey.get(k);
      if (!prev || r.seeders > prev.seeders) byKey.set(k, r);
    }
    raw = Array.from(byKey.values());

    const wanted = { titles: titles.length ? titles : queries, year: opts.year, type, season: opts.season };
    const results: TorrentResult[] = raw
      .map((r) => {
        const info = parseRelease(r.title);
        const { score, matched } = rankRelease({ title: r.title, size: r.size, seeders: r.seeders, wanted }, info);
        return {
          id: crypto.createHash('sha1').update(`${r.infoHash || ''}|${r.title}|${r.size}|${r.tracker}`).digest('hex').slice(0, 16),
          title: r.title,
          size: r.size,
          seeders: r.seeders,
          leechers: r.leechers,
          tracker: r.tracker,
          publishedAt: r.publishedAt,
          magnet: r.magnet,
          link: r.magnet ? undefined : r.link,
          quality: info.quality,
          tags: info.tags,
          season: info.season,
          pack: info.pack,
          score,
          matched: opts.query ? true : matched,
        };
      })
      .filter((r) => !opts.query || r.seeders > 0 || r.score > 0)
      .sort((a, b) => Number(b.matched) - Number(a.matched) || b.score - a.score)
      .slice(0, 80);

    const value: TorrentSearchResult = { results, queries, errors: errors.size ? Array.from(errors).slice(0, 6) : undefined };
    this.cache.set(key, { at: Date.now(), value });
    if (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value as string);
    return value;
  }

  /**
   * Turn an indexer download link into something WebTorrent can open:
   * Jackett / Prowlarr either answer with the .torrent file or redirect to a magnet link.
   */
  async resolveLink(link: string): Promise<{ magnet?: string; buffer?: Buffer }> {
    let url = link;
    for (let i = 0; i < 5; i++) {
      if (url.startsWith('magnet:')) return { magnet: url };
      const res = await fetchWithTimeout(url, { redirect: 'manual' }, 30000);
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) break;
        url = loc.startsWith('magnet:') ? loc : new URL(loc, url).toString();
        continue;
      }
      if (!res.ok) throw new Error(`download_failed_${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // a .torrent is a bencoded dictionary: starts with "d"
      if (buf[0] === 0x64) return { buffer: buf };
      const text = buf.toString('utf-8', 0, Math.min(buf.length, 4000));
      const m = /magnet:\?[^"'<\s]+/.exec(text);
      if (m) return { magnet: m[0].replace(/&amp;/g, '&') };
      throw new Error('not_a_torrent');
    }
    throw new Error('download_failed');
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('Индексатор не ответил вовремя');
    const code = (e as { cause?: { code?: string } }).cause?.code;
    if (code === 'ECONNREFUSED') throw new Error('Jackett / Prowlarr не запущен');
    throw e;
  } finally {
    clearTimeout(t);
  }
}
