import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TvDatabase } from './db';
import type { MediaItem } from '@tvbox/shared';

let dir: string;
let db: TvDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvbox-db-'));
  db = new TvDatabase(dir);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('TvDatabase', () => {
  it('upserts and reads media with genres serialization', () => {
    const item: MediaItem = {
      id: 'm1',
      type: 'movie',
      title: 'Dune',
      genres: ['Sci-Fi', 'Adventure'],
      rating: 8.2,
      releaseDate: '2021-10-22',
      tmdbId: 438631,
    };
    db.upsertMedia(item);
    const got = db.getMedia('m1');
    expect(got?.title).toBe('Dune');
    expect(got?.genres).toEqual(['Sci-Fi', 'Adventure']);
    expect(got?.rating).toBe(8.2);
    expect(got?.tmdbId).toBe(438631);
  });

  it('updates an existing media item without losing path', () => {
    db.upsertMedia({ id: 'm1', type: 'movie', title: 'Old', path: '/videos/old.mkv' });
    db.upsertMedia({ id: 'm1', type: 'movie', title: 'New' });
    const got = db.getMedia('m1');
    expect(got?.title).toBe('New');
    expect(got?.path).toBe('/videos/old.mkv');
  });

  it('saves and retrieves progress', () => {
    db.saveProgress('m1', 123.5, 3600);
    const p = db.getProgress('m1');
    expect(p?.position).toBe(123.5);
    expect(p?.duration).toBe(3600);

    db.saveProgress('m1', 200, 3600);
    expect(db.getProgress('m1')?.position).toBe(200);
  });

  it('stores widgets and idle settings as JSON', () => {
    const widgets = [
      { id: 'clock', type: 'clock' as const, enabled: true },
      { id: 'w1', type: 'custom' as const, enabled: true, custom: { html: '<p>x</p>', css: '', js: '' } },
    ];
    db.saveWidgets(widgets);
    expect(db.getWidgets()).toEqual(widgets);

    db.saveIdleSettings({ showClock: false, showWeather: true, showQr: true, screensaver: 'black', screensaverDelayMs: 5000, widgets });
    const s = db.getIdleSettings();
    expect(s?.showClock).toBe(false);
    expect(s?.screensaver).toBe('black');
  });

  it('lists media ordered by addedAt desc', () => {
    db.upsertMedia({ id: 'a', type: 'movie', title: 'A', addedAt: 100 });
    db.upsertMedia({ id: 'b', type: 'movie', title: 'B', addedAt: 300 });
    db.upsertMedia({ id: 'c', type: 'movie', title: 'C', addedAt: 200 });
    expect(db.listMedia().map((m) => m.id)).toEqual(['b', 'c', 'a']);
  });

  it('deletes media and cascades progress', () => {
    db.upsertMedia({ id: 'x', type: 'movie', title: 'X' });
    db.saveProgress('x', 10, 100);
    db.deleteMedia('x');
    expect(db.getMedia('x')).toBeUndefined();
    expect(db.getProgress('x')).toBeUndefined();
  });
});
