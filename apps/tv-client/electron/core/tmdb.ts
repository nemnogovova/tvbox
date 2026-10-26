import type { TmdbResult } from '@tvbox/shared';

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';

interface RawResult {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  release_date?: string;
  first_air_date?: string;
  genres?: { id: number; name: string }[];
  popularity?: number;
}

export interface TmdbDetails extends TmdbResult {
  genres?: string[];
}

export interface TmdbEpisode {
  name?: string;
  overview?: string;
  still?: string;
}

export class TmdbClient {
  private cache = new Map<string, unknown>();

  constructor(
    private apiKey: string,
    private language = 'ru-RU',
  ) {}

  configure(apiKey: string, language: string): void {
    if (apiKey !== this.apiKey || language !== this.language) this.cache.clear();
    this.apiKey = apiKey.trim();
    this.language = language || 'ru-RU';
  }

  get enabled(): boolean {
    return Boolean(this.apiKey);
  }

  private async get<T>(pathname: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(API + pathname);
    const headers: Record<string, string> = { Accept: 'application/json' };
    // v4 "API Read Access Token" (JWT) vs classic v3 api_key
    if (this.apiKey.startsWith('eyJ')) headers.Authorization = `Bearer ${this.apiKey}`;
    else url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('language', this.language);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    const key = url.toString();
    if (this.cache.has(key)) return this.cache.get(key) as T;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(key, { headers, signal: ctrl.signal });
      if (res.status === 401) throw new Error('tmdb_unauthorized');
      if (!res.ok) throw new Error(`tmdb_${res.status}`);
      const body = (await res.json()) as T;
      if (this.cache.size > 500) this.cache.clear();
      this.cache.set(key, body);
      return body;
    } finally {
      clearTimeout(t);
    }
  }

  private map(r: RawResult, type: 'movie' | 'tv'): TmdbDetails {
    const date = r.release_date || r.first_air_date;
    return {
      id: r.id,
      type,
      title: (type === 'movie' ? r.title : r.name) || r.original_title || r.original_name || '—',
      originalTitle: r.original_title || r.original_name,
      year: date ? Number(date.slice(0, 4)) || undefined : undefined,
      overview: r.overview || undefined,
      poster: r.poster_path ? `${IMG}/w500${r.poster_path}` : undefined,
      backdrop: r.backdrop_path ? `${IMG}/w1280${r.backdrop_path}` : undefined,
      rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : undefined,
      genres: r.genres?.map((g) => g.name),
    };
  }

  async search(query: string, type: 'movie' | 'tv', year?: number): Promise<TmdbResult[]> {
    if (!this.enabled) throw new Error('no_tmdb_key');
    const params = type === 'movie' ? { query, year, include_adult: 'false' } : { query, first_air_date_year: year, include_adult: 'false' };
    const body = await this.get<{ results: RawResult[] }>(`/search/${type}`, params);
    return (body.results || []).slice(0, 15).map((r) => this.map(r, type));
  }

  /** Best match: tries with the year first, then without; then the other media type. */
  async bestMatch(query: string, type: 'movie' | 'tv', year?: number): Promise<TmdbDetails | null> {
    const attempts: [string, 'movie' | 'tv', number | undefined][] = [
      [query, type, year],
      [query, type, undefined],
      [query, type === 'movie' ? 'tv' : 'movie', year],
    ];
    for (const [q, t, y] of attempts) {
      if (!q) continue;
      const res = await this.search(q, t, y);
      if (res.length) return this.details(res[0].id, t);
      if (!y && t !== type) break;
    }
    return null;
  }

  async details(id: number, type: 'movie' | 'tv'): Promise<TmdbDetails> {
    const r = await this.get<RawResult>(`/${type}/${id}`);
    return this.map(r, type);
  }

  async episode(tvId: number, season: number, episode: number): Promise<TmdbEpisode | null> {
    try {
      const r = await this.get<{ name?: string; overview?: string; still_path?: string }>(`/tv/${tvId}/season/${season}/episode/${episode}`);
      return { name: r.name, overview: r.overview, still: r.still_path ? `${IMG}/w780${r.still_path}` : undefined };
    } catch {
      return null;
    }
  }
}
