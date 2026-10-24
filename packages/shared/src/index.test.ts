import { describe, it, expect } from 'vitest';
import { parseTorrentName } from './torrent-parse';
import { canPerform, normalizeEmail } from './roles';

describe('parseTorrentName', () => {
  it('parses a typical series release', () => {
    const r = parseTorrentName('The.Mandalorian.S03E01.1080p.WEB-DL.DDP5.1.H.264-NTb');
    expect(r.isSeries).toBe(true);
    expect(r.season).toBe(3);
    expect(r.episode).toBe(1);
    expect(r.title).toBe('The Mandalorian');
    expect(r.quality).toBe('1080p');
    expect(r.releaseGroup).toBe('NTB');
    expect(r.searchQuery).toBe('The Mandalorian');
  });

  it('parses a movie with year and quality', () => {
    const r = parseTorrentName('Dune.2021.2160p.BluRay.x265.10bit.HDR.DTS-HD.MA.7.1-RARBG');
    expect(r.isMovie).toBe(true);
    expect(r.year).toBe(2021);
    expect(r.title).toBe('Dune');
    expect(r.quality).toBe('2160p');
  });

  it('strips bracket junk and formats title', () => {
    const r = parseTorrentName('[SubsPlease] Attack on Titan - 87 (1080p) [WEB].mkv');
    expect(r.title).toBe('Attack on Titan');
    expect(r.episode).toBe(87);
  });

  it('handles dots and underscores', () => {
    const r = parseTorrentName('The_Boys_S01E08_720p_HDTV_x264');
    expect(r.title).toBe('The Boys');
    expect(r.season).toBe(1);
    expect(r.episode).toBe(8);
  });

  it('detects russian-style episode marker', () => {
    const r = parseTorrentName('Breaking Bad s05e14 1080p WEB-DL');
    expect(r.season).toBe(5);
    expect(r.episode).toBe(14);
    expect(r.title).toBe('Breaking Bad');
  });

  it('handles a plain movie name', () => {
    const r = parseTorrentName('Interstellar');
    expect(r.isMovie).toBe(true);
    expect(r.title).toBe('Interstellar');
    expect(r.season).toBeUndefined();
  });
});

describe('roles', () => {
  it('owner can do everything', () => {
    expect(canPerform('owner', 'admin')).toBe(true);
    expect(canPerform('owner', 'power')).toBe(true);
    expect(canPerform('owner', 'file')).toBe(true);
  });

  it('guest cannot do admin/power/file', () => {
    expect(canPerform('guest', 'control')).toBe(true);
    expect(canPerform('guest', 'torrent')).toBe(true);
    expect(canPerform('guest', 'admin')).toBe(false);
    expect(canPerform('guest', 'power')).toBe(false);
    expect(canPerform('guest', 'file')).toBe(false);
  });

  it('dictator mode blocks guests', () => {
    expect(canPerform('guest', 'control', true)).toBe(false);
    expect(canPerform('owner', 'control', true)).toBe(true);
  });

  it('normalizes email', () => {
    expect(normalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com');
  });
});
