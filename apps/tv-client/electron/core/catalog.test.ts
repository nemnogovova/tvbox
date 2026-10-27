import { describe, expect, it } from 'vitest';
import type { MediaItem } from '@tvbox/shared';
import { CatalogService } from './catalog';
import type { TmdbClient } from './tmdb';

const raw = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Фильм ${id}`,
  original_title: `Movie ${id}`,
  poster_path: `/p${id}.jpg`,
  backdrop_path: `/b${id}.jpg`,
  overview: 'Описание',
  vote_average: 7.85,
  vote_count: 1000,
  release_date: '2024-03-01',
  genre_ids: [28],
  ...extra,
});

function fakeTmdb(): { tmdb: TmdbClient; calls: string[] } {
  const calls: string[] = [];
  const tmdb = {
    enabled: true,
    language: 'ru-RU',
    request: async (p: string, params: Record<string, unknown> = {}) => {
      calls.push(`${p} ${JSON.stringify(params)}`);
      if (p.startsWith('/genre/')) return { genres: [{ id: 28, name: 'боевик' }] };
      if (p === '/trending/all/day') return { results: [{ ...raw(1), media_type: 'movie' }, { ...raw(2, { name: 'Сериал 2', title: undefined }), media_type: 'tv' }, { ...raw(3), media_type: 'person' }] };
      if (p === '/movie/10/recommendations') return { results: [raw(11), raw(12), raw(10)] };
      if (p === '/movie/10') {
        return {
          ...raw(10),
          genres: [{ id: 28, name: 'боевик' }],
          runtime: 155,
          videos: { results: [{ key: 'en1', name: 'Trailer', site: 'YouTube', type: 'Trailer', iso_639_1: 'en' }, { key: 'ru1', name: 'Трейлер', site: 'YouTube', type: 'Trailer', iso_639_1: 'ru' }] },
          credits: { cast: [{ name: 'Актёр', character: 'Герой', profile_path: '/a.jpg' }], crew: [{ name: 'Режиссёр', job: 'Director' }] },
          recommendations: { results: [raw(11)] },
          similar: { results: [raw(12)] },
          release_dates: { results: [{ iso_3166_1: 'RU', release_dates: [{ certification: '16' }] }] },
          external_ids: { imdb_id: 'tt1' },
        };
      }
      return { results: [raw(100 + calls.length), raw(200 + calls.length), raw(300 + calls.length), raw(400 + calls.length), { ...raw(500), original_language: 'ja' }], page: 1, total_pages: 3 };
    },
  } as unknown as TmdbClient;
  return { tmdb, calls };
}

const lib: MediaItem[] = [
  { id: 'm1', kind: 'movie', title: 'Фильм 10', path: 'C:/m.mkv', origin: 'local', tmdbId: 10, tmdbType: 'movie', addedAt: 1, watchedAt: 5 },
];

describe('CatalogService', () => {
  it('builds the home screen: hero, personal recommendations, shelves, genres', async () => {
    const { tmdb } = fakeTmdb();
    const home = await new CatalogService(tmdb, () => lib).home();
    expect(home.hero.map((h) => h.type)).toEqual(['movie', 'tv']);
    expect(home.hero[0]).toMatchObject({ rating: 7.9, poster: 'https://image.tmdb.org/t/p/w342/p1.jpg', backdrop: 'https://image.tmdb.org/t/p/w1280/b1.jpg' });
    expect(home.sections.length).toBeGreaterThan(8);
    expect(home.genres.movie[0]).toEqual({ id: 28, name: 'Боевик' });
    // cartoons shelf drops Japanese animation (anime has its own shelf)
    const cartoons = home.sections.find((s) => s.id === 'cartoons');
    expect(cartoons?.items.some((i) => i.id === 500)).toBe(false);
  });

  it('gives details with localized trailers first, cast, certification and library link', async () => {
    const { tmdb } = fakeTmdb();
    const d = await new CatalogService(tmdb, () => lib).details(10, 'movie');
    expect(d.trailers[0].key).toBe('ru1');
    expect(d).toMatchObject({ certification: '16+', runtime: 155, imdbId: 'tt1', directors: ['Режиссёр'], libraryIds: ['m1'], inLibrary: true });
    expect(d.recommendations.map((r) => r.id)).toEqual([11, 12]);
  });

  it('browses with filters', async () => {
    const { tmdb, calls } = fakeTmdb();
    const page = await new CatalogService(tmdb, () => []).browse({ kind: 'tv', genre: 80, sort: 'rating', yearFrom: 2010, yearTo: 2019, minRating: 7 });
    expect(page.totalPages).toBe(3);
    const call = calls.find((c) => c.startsWith('/discover/tv'))!;
    expect(call).toContain('"with_genres":80');
    expect(call).toContain('"sort_by":"vote_average.desc"');
    expect(call).toContain('"first_air_date.gte":"2010-01-01"');
    expect(call).toContain('"vote_average.gte":7');
  });
});
