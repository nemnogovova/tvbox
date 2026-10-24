import type { MediaItem } from '@tvbox/shared';
import { parseTorrentName } from '@tvbox/shared';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMG_BASE = 'https://image.tmdb.org/t/p';

export interface TmdbSearchResult {
  id: number;
  mediaType: 'movie' | 'tv';
  title: string;
  originalTitle?: string;
  overview?: string;
  poster?: string;
  backdrop?: string;
  rating?: number;
  releaseDate?: string;
  genres?: string[];
  episodeCount?: number;
}

export class TmdbClient {
  constructor(private apiKey: string) {}

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${TMDB_BASE}${path}`);
    url.searchParams.set('api_key', this.apiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`TMDB ${res.status}`);
    return (await res.json()) as T;
  }

  async enrichFromTorrentName(rawName: string): Promise<MediaItem | null> {
    if (!this.apiKey) return null;
    const parsed = parseTorrentName(rawName);
    const result = await this.searchBestMatch(parsed.searchQuery, parsed.year, parsed.isSeries);
    if (!result) return null;

    return {
      id: `tmdb-${result.mediaType}-${result.id}`,
      type: result.mediaType === 'tv' ? 'series' : 'movie',
      title: result.title,
      originalTitle: result.originalTitle,
      overview: result.overview,
      poster: result.poster,
      backdrop: result.backdrop,
      rating: result.rating,
      releaseDate: result.releaseDate,
      genres: result.genres,
      tmdbId: result.id,
      seriesId: result.mediaType === 'tv' ? `tmdb-tv-${result.id}` : undefined,
      season: parsed.season,
      episode: parsed.episode,
      episodeCount: result.episodeCount,
    };
  }

  async searchBestMatch(query: string, year?: number, isSeries = false): Promise<TmdbSearchResult | null> {
    const type = isSeries ? 'tv' : 'movie';
    const data = await this.get<{ results: TmdbRaw[] }>(`/search/${type}`, {
      query,
      ...(year ? { year: String(year), include_adult: 'false' } : { include_adult: 'false' }),
    });
    const top = data.results?.[0];
    if (!top) return null;
    return this.mapRaw(top, type);
  }

  async getDetails(id: number, type: 'movie' | 'tv'): Promise<TmdbSearchResult | null> {
    const data = await this.get<TmdbRaw>(`/${type}/${id}`, {});
    return this.mapRaw(data, type);
  }

  private mapRaw(r: TmdbRaw, type: 'movie' | 'tv'): TmdbSearchResult {
    return {
      id: r.id,
      mediaType: type,
      title: (type === 'movie' ? r.title : r.name) ?? 'Unknown',
      originalTitle: r.original_title || r.original_name,
      overview: r.overview,
      poster: r.poster_path ? `${IMG_BASE}/w500${r.poster_path}` : undefined,
      backdrop: r.backdrop_path ? `${IMG_BASE}/w1280${r.backdrop_path}` : undefined,
      rating: r.vote_average,
      releaseDate: r.release_date || r.first_air_date,
      genres: r.genres?.map((g) => g.name),
      episodeCount: type === 'tv' ? r.number_of_episodes : undefined,
    };
  }
}

interface TmdbRaw {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  poster_path?: string;
  backdrop_path?: string;
  vote_average?: number;
  release_date?: string;
  first_air_date?: string;
  genres?: { name: string }[];
  number_of_episodes?: number;
}
