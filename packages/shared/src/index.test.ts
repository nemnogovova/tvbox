import { describe, it, expect } from 'vitest';
import { parseMediaName, showKeyFor } from './torrent-parse';
import { canPerform, canPerformEvent, normalizeEmail } from './roles';
import { Events } from './events';
import { classifyLink, extractYouTubeId, extractYouTubeIndex, extractYouTubeList, extractYouTubeStart, formatDuration, normalizeLinkCode, randomCode } from './util';

describe('parseMediaName', () => {
  it('parses a typical series release', () => {
    const r = parseMediaName('The.Mandalorian.S03E01.1080p.WEB-DL.DDP5.1.H.264-NTb');
    expect(r).toMatchObject({ title: 'The Mandalorian', season: 3, episode: 1, quality: '1080p', isSeries: true });
    expect(r.releaseGroup).toBe('NTb');
    expect(r.searchQuery).toBe('The Mandalorian');
  });

  it('parses a movie with year and junk', () => {
    const r = parseMediaName('Dune.2021.2160p.BluRay.x265.10bit.HDR.DTS-HD.MA.7.1-RARBG');
    expect(r).toMatchObject({ title: 'Dune', year: 2021, quality: '2160p', isSeries: false });
  });

  it('keeps numeric titles', () => {
    expect(parseMediaName('1917.2019.1080p.BluRay.x264.mkv')).toMatchObject({ title: '1917', year: 2019 });
    expect(parseMediaName('2012 (2009) BDRip 720p')).toMatchObject({ title: '2012', year: 2009 });
  });

  it('handles anime style names', () => {
    const r = parseMediaName('[SubsPlease] Attack on Titan - 87 (1080p) [ABCDEF12].mkv');
    expect(r).toMatchObject({ title: 'Attack on Titan', episode: 87, releaseGroup: 'SubsPlease' });
  });

  it('handles underscores and lower-case markers', () => {
    expect(parseMediaName('The_Boys_S01E08_720p_HDTV_x264')).toMatchObject({ title: 'The Boys', season: 1, episode: 8 });
    expect(parseMediaName('Breaking Bad s05e14 1080p WEB-DL')).toMatchObject({ title: 'Breaking Bad', season: 5, episode: 14 });
    expect(parseMediaName('Friends 1x05 The One With.avi')).toMatchObject({ title: 'Friends', season: 1, episode: 5 });
  });

  it('handles russian tracker names', () => {
    const r = parseMediaName('Дюна / Dune (2021) WEB-DL 1080p | Лицензия');
    expect(r.title).toBe('Дюна');
    expect(r.altTitle).toBe('Dune');
    expect(r.year).toBe(2021);
    expect(r.searchQuery).toBe('Dune');
    const s = parseMediaName('Во все тяжкие (Сезон 2) WEB-DL');
    expect(s.title).toBe('Во все тяжкие');
    expect(s.season).toBe(2);
  });

  it('handles a plain name', () => {
    const r = parseMediaName('Interstellar');
    expect(r).toMatchObject({ title: 'Interstellar', isSeries: false });
    expect(r.season).toBeUndefined();
  });

  it('builds stable show keys', () => {
    expect(showKeyFor('The Boys')).toBe(showKeyFor('the  boys'));
    expect(showKeyFor('Ёлки')).toBe('елки');
  });
});

describe('roles', () => {
  it('owner can do everything', () => {
    expect(canPerform('owner', 'admin')).toBe(true);
    expect(canPerform('owner', 'power', true)).toBe(true);
  });

  it('guest permissions', () => {
    expect(canPerform('guest', 'control')).toBe(true);
    expect(canPerform('guest', 'torrent')).toBe(true);
    expect(canPerform('guest', 'webrtc')).toBe(true);
    expect(canPerform('guest', 'admin')).toBe(false);
    expect(canPerform('guest', 'power')).toBe(false);
    expect(canPerform('guest', 'library-edit')).toBe(false);
    expect(canPerform('guest', 'settings')).toBe(false);
  });

  it('dictator mode blocks guest actions but keeps browsing', () => {
    expect(canPerform('guest', 'control', true)).toBe(false);
    expect(canPerform('guest', 'torrent', true)).toBe(false);
    expect(canPerform('guest', 'catalog', true)).toBe(true);
    expect(canPerform('owner', 'control', true)).toBe(true);
  });

  it('maps events to categories', () => {
    expect(canPerformEvent('guest', Events.POWER)).toBe(false);
    expect(canPerformEvent('guest', Events.CONTROL)).toBe(true);
    expect(canPerformEvent('guest', 'unknown:event')).toBe(false);
  });

  it('normalizes email', () => {
    expect(normalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com');
  });
});

describe('util', () => {
  it('extracts youtube ids', () => {
    expect(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10')).toBe('dQw4w9WgXcQ');
    expect(extractYouTubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYouTubeId('https://youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYouTubeId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYouTubeId('https://example.com')).toBeNull();
    expect(extractYouTubeStart('https://youtu.be/x?t=1m30s')).toBe(90);
  });

  it('classifies links', () => {
    expect(classifyLink('magnet:?xt=urn:btih:abc')).toBe('magnet');
    expect(classifyLink('https://youtu.be/dQw4w9WgXcQ')).toBe('youtube');
    expect(classifyLink('https://cdn.example.com/a.mp4?x=1')).toBe('media-url');
    expect(classifyLink('hello')).toBe('unknown');
  });

  it('formats durations', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
  });

  it('generates and normalizes codes', () => {
    const c = randomCode(6);
    expect(c).toMatch(/^[A-Z2-9]{6}$/);
    expect(normalizeLinkCode(' ab-c d ')).toBe('ABCD');
  });
});

describe('YouTube playlists', () => {
  it('finds the playlist of a link', () => {
    expect(extractYouTubeList('https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG')).toBe('PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG');
    expect(extractYouTubeList('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&index=3')).toBe('RDdQw4w9WgXcQ');
    expect(extractYouTubeList('https://youtu.be/dQw4w9WgXcQ')).toBeNull();
    expect(extractYouTubeIndex('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&index=3')).toBe(3);
  });
  it('a playlist-only link has no video id but is a YouTube link', () => {
    const u = 'https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG';
    expect(extractYouTubeId(u)).toBeNull();
    expect(classifyLink(u)).toBe('youtube');
  });
});
