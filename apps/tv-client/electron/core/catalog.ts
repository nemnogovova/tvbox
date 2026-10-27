import type {
  CatalogBrowsePayload,
  CatalogDetails,
  CatalogGenre,
  CatalogHome,
  CatalogItem,
  CatalogKind,
  CatalogPage,
  CatalogSection,
  MediaItem,
} from '@tvbox/shared';
import type { TmdbClient } from './tmdb';

const IMG = 'https://image.tmdb.org/t/p';

interface Raw {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  vote_count?: number;
  release_date?: string;
  first_air_date?: string;
  genre_ids?: number[];
  popularity?: number;
  adult?: boolean;
  original_language?: string;
}

const notAnime = (r: RawList | null): RawList | null => (r ? { ...r, results: (r.results || []).filter((x) => x.original_language !== 'ja') } : r);

interface RawList {
  results?: Raw[];
  page?: number;
  total_pages?: number;
}

interface RawVideo {
  key: string;
  name: string;
  site: string;
  type: string;
  official?: boolean;
  iso_639_1?: string;
}

interface RawDetails extends Raw {
  genres?: { id: number; name: string }[];
  tagline?: string;
  runtime?: number;
  episode_run_time?: number[];
  production_countries?: { iso_3166_1: string; name: string }[];
  origin_country?: string[];
  status?: string;
  seasons?: { season_number: number; name: string; episode_count: number; air_date?: string; poster_path?: string | null }[];
  number_of_seasons?: number;
  created_by?: { name: string }[];
  imdb_id?: string;
  external_ids?: { imdb_id?: string };
  videos?: { results?: RawVideo[] };
  credits?: { cast?: { name: string; character?: string; profile_path?: string | null }[]; crew?: { name: string; job: string }[] };
  recommendations?: RawList;
  similar?: RawList;
  release_dates?: { results?: { iso_3166_1: string; release_dates: { certification: string }[] }[] };
  content_ratings?: { results?: { iso_3166_1: string; rating: string }[] };
}

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/**
 * Movie & series catalog on top of TMDb: shelves for the home screen, browsing by genre,
 * rating and year, search, and rich details (trailers, cast, seasons, recommendations).
 */
export class CatalogService {
  private genreCache = new Map<CatalogKind, CatalogGenre[]>();

  constructor(
    private readonly tmdb: TmdbClient,
    private readonly library: () => MediaItem[],
  ) {}

  get enabled(): boolean {
    return this.tmdb.enabled;
  }

  private libraryIds(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const m of this.library()) {
      if (!m.tmdbId || !m.tmdbType) continue;
      const k = `${m.tmdbType}:${m.tmdbId}`;
      const list = map.get(k) || [];
      list.push(m.id);
      map.set(k, list);
    }
    return map;
  }

  private map(r: Raw, kind?: CatalogKind, lib = this.libraryIds()): CatalogItem | null {
    const type: CatalogKind | null = kind || (r.media_type === 'movie' || r.media_type === 'tv' ? r.media_type : null);
    if (!type || r.adult) return null;
    const date = r.release_date || r.first_air_date;
    const title = (type === 'movie' ? r.title : r.name) || r.original_title || r.original_name;
    if (!title) return null;
    return {
      id: r.id,
      type,
      title,
      originalTitle: (type === 'movie' ? r.original_title : r.original_name) || undefined,
      year: date ? Number(date.slice(0, 4)) || undefined : undefined,
      overview: r.overview || undefined,
      poster: r.poster_path ? `${IMG}/w342${r.poster_path}` : undefined,
      backdrop: r.backdrop_path ? `${IMG}/w1280${r.backdrop_path}` : undefined,
      rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : undefined,
      voteCount: r.vote_count,
      genreIds: r.genre_ids,
      inLibrary: lib.has(`${type}:${r.id}`) || undefined,
    };
  }

  private list(raw: RawList | null | undefined, kind?: CatalogKind, lib = this.libraryIds()): CatalogItem[] {
    const seen = new Set<string>();
    const out: CatalogItem[] = [];
    for (const r of raw?.results || []) {
      const it = this.map(r, kind, lib);
      if (!it || !it.poster) continue;
      const k = `${it.type}:${it.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(it);
    }
    return out;
  }

  async genres(kind: CatalogKind): Promise<CatalogGenre[]> {
    const cached = this.genreCache.get(kind);
    if (cached) return cached;
    const r = await this.tmdb.request<{ genres?: CatalogGenre[] }>(`/genre/${kind}/list`);
    const list = (r.genres || []).map((g) => ({ id: g.id, name: g.name.charAt(0).toUpperCase() + g.name.slice(1) }));
    if (list.length) this.genreCache.set(kind, list);
    return list;
  }

  // ------------------------------------------------------------------ home
  async home(): Promise<CatalogHome> {
    if (!this.enabled) throw new Error('no_tmdb_key');
    const lib = this.libraryIds();
    const safe = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
    const discover = (kind: CatalogKind, params: Record<string, string | number | undefined>) =>
      safe(this.tmdb.request<RawList>(`/discover/${kind}`, { include_adult: 'false', ...params }));

    const shelves: { id: string; title: string; kind?: CatalogKind; req: Promise<RawList | null>; browse?: CatalogBrowsePayload }[] = [
      { id: 'trending-movie', title: 'Фильмы недели', kind: 'movie', req: safe(this.tmdb.request<RawList>('/trending/movie/week')), browse: { kind: 'movie', sort: 'trending' } },
      { id: 'trending-tv', title: 'Сериалы, которые смотрят сейчас', kind: 'tv', req: safe(this.tmdb.request<RawList>('/trending/tv/week')), browse: { kind: 'tv', sort: 'trending' } },
      {
        id: 'new-movie',
        title: 'Новинки кино',
        kind: 'movie',
        req: discover('movie', { sort_by: 'popularity.desc', 'primary_release_date.gte': daysAgo(150), 'primary_release_date.lte': today(), 'vote_count.gte': 40 }),
        browse: { kind: 'movie', sort: 'new' },
      },
      {
        id: 'cartoons',
        title: 'Мультфильмы',
        kind: 'movie',
        req: discover('movie', { with_genres: 16, sort_by: 'popularity.desc', 'vote_count.gte': 200 }).then(notAnime),
        browse: { kind: 'movie', special: 'animation' },
      },
      {
        id: 'top-tv',
        title: 'Лучшие сериалы всех времён',
        kind: 'tv',
        req: discover('tv', { sort_by: 'vote_average.desc', 'vote_count.gte': 2500, without_genres: '16,10767,10763' }),
        browse: { kind: 'tv', sort: 'rating' },
      },
      {
        id: 'anime',
        title: 'Аниме',
        kind: 'tv',
        req: discover('tv', { with_genres: 16, with_original_language: 'ja', sort_by: 'popularity.desc', 'vote_count.gte': 150 }),
        browse: { kind: 'tv', special: 'anime' },
      },
      {
        id: 'top-movie',
        title: 'Фильмы с высоким рейтингом',
        kind: 'movie',
        req: discover('movie', { sort_by: 'vote_average.desc', 'vote_count.gte': 5000 }),
        browse: { kind: 'movie', sort: 'rating' },
      },
      {
        id: 'russian',
        title: 'Российское кино и сериалы',
        req: Promise.all([
          discover('movie', { with_original_language: 'ru', sort_by: 'popularity.desc', 'vote_count.gte': 30 }),
          discover('tv', { with_original_language: 'ru', sort_by: 'popularity.desc', 'vote_count.gte': 20 }),
        ]).then(([m, t]) => ({
          results: interleave(
            (m?.results || []).map((r) => ({ ...r, media_type: 'movie' })),
            (t?.results || []).map((r) => ({ ...r, media_type: 'tv' })),
          ),
        })),
        browse: { kind: 'movie', special: 'russian' },
      },
      {
        id: 'family',
        title: 'Для всей семьи',
        kind: 'movie',
        req: discover('movie', { with_genres: 10751, sort_by: 'popularity.desc', 'vote_count.gte': 300 }),
        browse: { kind: 'movie', genre: 10751 },
      },
      { id: 'comedy', title: 'Комедии', kind: 'movie', req: discover('movie', { with_genres: 35, sort_by: 'popularity.desc', 'vote_count.gte': 300 }), browse: { kind: 'movie', genre: 35 } },
      { id: 'scifi', title: 'Фантастика', kind: 'movie', req: discover('movie', { with_genres: 878, sort_by: 'popularity.desc', 'vote_count.gte': 300 }), browse: { kind: 'movie', genre: 878 } },
      { id: 'horror', title: 'Ужасы', kind: 'movie', req: discover('movie', { with_genres: 27, sort_by: 'popularity.desc', 'vote_count.gte': 200 }), browse: { kind: 'movie', genre: 27 } },
      { id: 'crime-tv', title: 'Детективы и криминал', kind: 'tv', req: discover('tv', { with_genres: 80, sort_by: 'popularity.desc', 'vote_count.gte': 200 }), browse: { kind: 'tv', genre: 80 } },
      { id: 'docs', title: 'Документальное', kind: 'movie', req: discover('movie', { with_genres: 99, sort_by: 'popularity.desc', 'vote_count.gte': 100 }), browse: { kind: 'movie', genre: 99 } },
    ];

    const [trendingAll, forYou, movieGenres, tvGenres, ...lists] = await Promise.all([
      safe(this.tmdb.request<RawList>('/trending/all/day')),
      safe(this.recommendedForYou(lib)),
      this.genres('movie').catch(() => []),
      this.genres('tv').catch(() => []),
      ...shelves.map((x) => x.req),
    ]);

    const hero = this.list(trendingAll, undefined, lib)
      .filter((x) => x.backdrop && x.overview)
      .slice(0, 8);
    const sections: CatalogSection[] = [];
    if (forYou && forYou.length >= 6) sections.push({ id: 'for-you', title: 'Рекомендуем вам', items: forYou.slice(0, 24) });
    shelves.forEach((sh, i) => {
      const items = this.list(lists[i] as RawList | null, sh.kind, lib).slice(0, 24);
      if (items.length >= 4) sections.push({ id: sh.id, title: sh.title, items, browse: sh.browse });
    });
    return { hero, sections, genres: { movie: movieGenres, tv: tvGenres } };
  }

  /** "Because you watched…": TMDb recommendations for what was watched / added recently. */
  private async recommendedForYou(lib: Map<string, string[]>): Promise<CatalogItem[]> {
    const seeds: { id: number; type: CatalogKind }[] = [];
    const seen = new Set<string>();
    const items = [...this.library()].sort((a, b) => (b.watchedAt || b.addedAt || 0) - (a.watchedAt || a.addedAt || 0));
    for (const m of items) {
      if (!m.tmdbId || !m.tmdbType) continue;
      const k = `${m.tmdbType}:${m.tmdbId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      seeds.push({ id: m.tmdbId, type: m.tmdbType });
      if (seeds.length >= 5) break;
    }
    if (!seeds.length) return [];
    const lists = await Promise.all(
      seeds.map((s) => this.tmdb.request<RawList>(`/${s.type}/${s.id}/recommendations`).then((r) => this.list(r, s.type, lib)).catch(() => [] as CatalogItem[])),
    );
    // round-robin over the seeds, skip what is already in the library
    const out: CatalogItem[] = [];
    const keys = new Set<string>();
    for (let i = 0; i < 20; i++) {
      for (const l of lists) {
        const it = l[i];
        if (!it || it.inLibrary) continue;
        const k = `${it.type}:${it.id}`;
        if (keys.has(k)) continue;
        keys.add(k);
        out.push(it);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ browse / search
  async browse(p: CatalogBrowsePayload): Promise<CatalogPage> {
    if (!this.enabled) throw new Error('no_tmdb_key');
    const kind: CatalogKind = p.kind === 'tv' ? 'tv' : 'movie';
    const page = Math.max(1, Math.min(500, Number(p.page) || 1));
    const lib = this.libraryIds();
    const pack = (r: RawList | null, k?: CatalogKind): CatalogPage => ({
      items: this.list(r, k, lib),
      page: r?.page || page,
      totalPages: Math.min(500, r?.total_pages || 1),
    });

    const query = (p.query || '').trim();
    if (query) {
      const r = await this.tmdb.request<RawList>('/search/multi', { query, page, include_adult: 'false' });
      return pack({ ...r, results: (r.results || []).filter((x) => x.media_type === 'movie' || x.media_type === 'tv') });
    }
    if (p.sort === 'trending' && !p.genre && !p.special) {
      return pack(await this.tmdb.request<RawList>(`/trending/${kind}/week`, { page }), kind);
    }

    const params: Record<string, string | number | undefined> = { include_adult: 'false', page };
    const dateField = kind === 'movie' ? 'primary_release_date' : 'first_air_date';
    switch (p.sort || 'popular') {
      case 'rating':
        params.sort_by = 'vote_average.desc';
        params['vote_count.gte'] = kind === 'movie' ? 1500 : 500;
        break;
      case 'new':
        params.sort_by = `${dateField}.desc`;
        params[`${dateField}.lte`] = today();
        params['vote_count.gte'] = 15;
        break;
      default:
        params.sort_by = 'popularity.desc';
        params['vote_count.gte'] = 20;
    }
    if (p.genre) params.with_genres = p.genre;
    if (p.special === 'animation') {
      params.with_genres = [16, p.genre].filter(Boolean).join(',');
    } else if (p.special === 'anime') {
      params.with_genres = [16, p.genre].filter(Boolean).join(',');
      params.with_original_language = 'ja';
    } else if (p.special === 'kids') {
      params.with_genres = [10751, p.genre].filter(Boolean).join(',');
    } else if (p.special === 'russian') {
      params.with_original_language = 'ru';
    }
    if (p.yearFrom) params[`${dateField}.gte`] = `${p.yearFrom}-01-01`;
    if (p.yearTo) params[`${dateField}.lte`] = `${p.yearTo}-12-31`;
    if (p.minRating) params['vote_average.gte'] = p.minRating;
    const r = await this.tmdb.request<RawList>(`/discover/${kind}`, params);
    return pack(p.special === 'animation' ? notAnime(r) : r, kind);
  }

  // ------------------------------------------------------------------ details
  async details(id: number, type: CatalogKind): Promise<CatalogDetails> {
    if (!this.enabled) throw new Error('no_tmdb_key');
    const lang = this.tmdb.language.split('-')[0];
    const r = await this.tmdb.request<RawDetails>(`/${type}/${id}`, {
      append_to_response: `videos,credits,recommendations,similar,external_ids,${type === 'movie' ? 'release_dates' : 'content_ratings'}`,
      include_video_language: `${lang},en,null`,
    });
    const lib = this.libraryIds();
    const base = this.map({ ...r, genre_ids: r.genres?.map((g) => g.id) }, type, lib);
    if (!base) throw new Error('not_found');

    // trailers: user's language first, then official English ones
    let videos = (r.videos?.results || []).filter((v) => v.site === 'YouTube' && /trailer|teaser/i.test(v.type));
    if (!videos.length) {
      // TMDb often has a localized title but only English trailers
      const en = await this.tmdb.request<{ results?: RawVideo[] }>(`/${type}/${id}/videos`, { language: 'en-US' }).catch(() => null);
      videos = (en?.results || []).filter((v) => v.site === 'YouTube' && /trailer|teaser/i.test(v.type));
    }
    videos.sort(
      (a, b) =>
        Number(b.iso_639_1 === lang) - Number(a.iso_639_1 === lang) ||
        Number(b.type === 'Trailer') - Number(a.type === 'Trailer') ||
        Number(!!b.official) - Number(!!a.official),
    );

    const cert =
      type === 'movie'
        ? pickCert(
            (r.release_dates?.results || []).map((x) => ({ c: x.iso_3166_1, v: x.release_dates.map((d) => d.certification).find(Boolean) || '' })),
          )
        : pickCert((r.content_ratings?.results || []).map((x) => ({ c: x.iso_3166_1, v: x.rating })));

    const recs = this.list(r.recommendations, type, lib);
    const similar = recs.length < 8 ? this.list(r.similar, type, lib) : [];
    const runtime = r.runtime || r.episode_run_time?.[0];

    return {
      ...base,
      poster: r.poster_path ? `${IMG}/w500${r.poster_path}` : base.poster,
      backdrop: r.backdrop_path ? `${IMG}/original${r.backdrop_path}` : base.backdrop,
      genres: (r.genres || []).map((g) => g.name.charAt(0).toUpperCase() + g.name.slice(1)),
      tagline: r.tagline || undefined,
      runtime: runtime || undefined,
      countries: (r.production_countries?.map((c) => c.name) || r.origin_country || []).slice(0, 3),
      certification: cert || undefined,
      status: r.status,
      seasons:
        type === 'tv'
          ? (r.seasons || [])
              .filter((s) => s.season_number > 0 && s.episode_count > 0)
              .map((s) => ({
                number: s.season_number,
                name: s.name,
                episodes: s.episode_count,
                year: s.air_date ? Number(s.air_date.slice(0, 4)) : undefined,
                poster: s.poster_path ? `${IMG}/w342${s.poster_path}` : undefined,
              }))
          : undefined,
      trailers: videos.slice(0, 4).map((v) => ({ key: v.key, name: v.name })),
      cast: (r.credits?.cast || []).slice(0, 14).map((c) => ({
        name: c.name,
        character: c.character || undefined,
        photo: c.profile_path ? `${IMG}/w185${c.profile_path}` : undefined,
      })),
      directors:
        type === 'movie'
          ? (r.credits?.crew || []).filter((c) => c.job === 'Director').map((c) => c.name).slice(0, 3)
          : (r.created_by || []).map((c) => c.name).slice(0, 3),
      recommendations: [...recs, ...similar].slice(0, 20),
      libraryIds: lib.get(`${type}:${id}`) || [],
      imdbId: r.imdb_id || r.external_ids?.imdb_id || undefined,
    };
  }

  /** Titles used to search for releases of an item (localized + original). */
  async searchTitles(id: number, type: CatalogKind): Promise<{ titles: string[]; year?: number }> {
    const d = await this.tmdb.request<RawDetails>(`/${type}/${id}`);
    const title = (type === 'movie' ? d.title : d.name) || '';
    const original = (type === 'movie' ? d.original_title : d.original_name) || '';
    const titles = Array.from(new Set([title, original].map((t) => t.trim()).filter(Boolean)));
    // non-Latin original titles (Japanese, Korean…) are useless on most trackers: add the English one
    if (original && !/^[\p{Script=Latin}\p{Script=Cyrillic}\d\s\p{P}]+$/u.test(original)) {
      const en = await this.tmdb.request<RawDetails>(`/${type}/${id}`, { language: 'en-US' }).catch(() => null);
      const enTitle = (type === 'movie' ? en?.title : en?.name)?.trim();
      if (enTitle && !titles.includes(enTitle)) titles.push(enTitle);
    }
    const date = d.release_date || d.first_air_date;
    return { titles, year: date ? Number(date.slice(0, 4)) || undefined : undefined };
  }
}

function pickCert(list: { c: string; v: string }[]): string {
  for (const c of ['RU', 'US', 'GB', 'DE']) {
    const x = list.find((l) => l.c === c && l.v);
    if (x) return /^\d+$/.test(x.v) ? `${x.v}+` : x.v;
  }
  return list.find((l) => l.v)?.v || '';
}

function interleave<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]) out.push(a[i]);
    if (b[i]) out.push(b[i]);
  }
  return out;
}
