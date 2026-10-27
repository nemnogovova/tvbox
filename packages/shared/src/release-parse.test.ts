import { describe, expect, it } from 'vitest';
import { parseRelease, rankRelease, titleMatches } from './release-parse';

describe('parseRelease', () => {
  it('reads a typical rutracker movie release', () => {
    const r = parseRelease('Дюна: Часть вторая / Dune: Part Two (Дени Вильнёв) [2024, США, фантастика, WEB-DL 1080p] Dub + Original + Sub');
    expect(r.quality).toBe('1080p');
    expect(r.tags).toContain('WEB-DL');
    expect(r.tags).toContain('Дубляж');
    expect(r.russianAudio).toBe(true);
    expect(r.years).toContain(2024);
    expect(r.cam).toBe(false);
  });

  it('reads the "| D |" marker and 4K HDR', () => {
    const r = parseRelease('Оппенгеймер / Oppenheimer (2023) UHD WEB-DL 2160p | HDR | D | Лицензия');
    expect(r.quality).toBe('2160p');
    expect(r.tags).toEqual(expect.arrayContaining(['HDR', 'Дубляж']));
  });

  it('reads season packs', () => {
    const a = parseRelease('Извне / From / Сезон: 2 / Серии: 1-10 из 10 [2023, США, ужасы, WEB-DL 1080p] MVO (LostFilm)');
    expect(a.season).toBe(2);
    expect(a.pack).toBe(true);
    expect(a.tags).toContain('Многоголосый');
    const b = parseRelease('The.Bear.S03.1080p.WEB-DL.H.265-NTb');
    expect(b.season).toBe(3);
    expect(b.pack).toBe(true);
    expect(b.tags).toContain('HEVC');
    const c = parseRelease('Severance.S02E05.1080p.WEB.h264');
    expect(c).toMatchObject({ season: 2, episode: 5, pack: false });
    const d = parseRelease('Друзья / Friends / Сезон: 1-10 [1994-2004, BDRip 720p]');
    expect(d).toMatchObject({ season: 1, seasonTo: 10, pack: true, quality: '720p' });
  });

  it('flags camrips', () => {
    expect(parseRelease('Movie 2026 CAMRip').cam).toBe(true);
    expect(parseRelease('Movie 2026 HDTS 1080p').cam).toBe(true);
    expect(parseRelease('Movie 2026 WEB-DL 1080p DTS').cam).toBe(false);
  });
});

describe('titleMatches', () => {
  it('matches Russian or original titles, ignoring punctuation and ё', () => {
    expect(titleMatches('Ёлки 5 (2016) WEB-DL', ['Елки 5'])).toBe(true);
    expect(titleMatches('Dune: Part Two 2024', ['Дюна: Часть вторая', 'Dune: Part Two'])).toBe(true);
    expect(titleMatches('Dune 1984', ['Dune: Part Two'])).toBe(false);
  });
});

describe('rankRelease', () => {
  const wanted = { titles: ['Дюна: Часть вторая', 'Dune: Part Two'], year: 2024, type: 'movie' as const };
  it('prefers matched, dubbed 1080p with seeds over a camrip and a wrong title', () => {
    const good = rankRelease({ title: 'Дюна: Часть вторая / Dune: Part Two [2024, WEB-DL 1080p] Dub', size: 12e9, seeders: 300, wanted });
    const cam = rankRelease({ title: 'Дюна: Часть вторая [2024, CAMRip] ', size: 1.4e9, seeders: 900, wanted });
    const wrong = rankRelease({ title: 'Dune (1984) BDRip 1080p Dub', size: 10e9, seeders: 500, wanted });
    expect(good.matched).toBe(true);
    expect(wrong.matched).toBe(false);
    expect(good.score).toBeGreaterThan(cam.score);
    expect(good.score).toBeGreaterThan(wrong.score);
  });
  it('checks the season of series', () => {
    const w = { titles: ['Извне', 'From'], type: 'tv' as const, season: 2 };
    expect(rankRelease({ title: 'Извне / From / Сезон: 2 [2023, WEB-DL 1080p]', size: 20e9, seeders: 50, wanted: w }).matched).toBe(true);
    expect(rankRelease({ title: 'Извне / From / Сезон: 1 [2022, WEB-DL 1080p]', size: 20e9, seeders: 50, wanted: w }).matched).toBe(false);
    expect(rankRelease({ title: 'Извне / From / Сезоны: 1-3 [2022-2024]', size: 60e9, seeders: 50, wanted: w }).matched).toBe(true);
  });
});
