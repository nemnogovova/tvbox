import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IndexerClient, detectLocalIndexer } from './indexer';

let server: http.Server;
let base = '';
const seen: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    seen.push(u.pathname + '?' + u.searchParams.toString());
    if (u.pathname === '/api/v2.0/indexers/all/results') {
      if (u.searchParams.get('apikey') !== 'KEY') return res.writeHead(401).end();
      const q = u.searchParams.get('Query') || '';
      res.setHeader('Content-Type', 'application/json');
      return res.end(
        JSON.stringify({
          Indexers: [
            { Name: 'RuTracker', Status: 2, Results: 3 },
            { Name: 'Broken', Status: 1, Results: 0, Error: 'login failed' },
          ],
          Results: /Dune|Дюна/.test(q)
            ? [
                { Title: 'Дюна: Часть вторая / Dune: Part Two [2024, WEB-DL 1080p] Dub', Size: 12e9, Seeders: 250, Peers: 270, Tracker: 'RuTracker', Link: `${base}/dl/1`, InfoHash: 'AAA' },
                { Title: 'Dune: Part Two 2024 2160p WEB-DL HDR', Size: 30e9, Seeders: 90, Peers: 95, Tracker: 'TPB', MagnetUri: 'magnet:?xt=urn:btih:BBB', InfoHash: 'BBB' },
                { Title: 'Dune: Part Two 2024 2160p WEB-DL HDR', Size: 30e9, Seeders: 40, Peers: 41, Tracker: 'Other', MagnetUri: 'magnet:?xt=urn:btih:BBB', InfoHash: 'bbb' },
                { Title: 'Dune 1984 BDRip', Size: 8e9, Seeders: 500, Peers: 510, Tracker: 'TPB', MagnetUri: 'magnet:?xt=urn:btih:CCC', InfoHash: 'CCC' },
                { Title: 'Дюна: Часть вторая [2024, CAMRip]', Size: 1.5e9, Seeders: 999, Peers: 1000, Tracker: 'X', MagnetUri: 'magnet:?xt=urn:btih:DDD', InfoHash: 'DDD' },
              ]
            : [],
        }),
      );
    }
    if (u.pathname === '/api/v1/search') {
      if (req.headers['x-api-key'] !== 'PKEY') return res.writeHead(401).end();
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify([{ title: 'Извне / From / Сезон: 2 [2023, WEB-DL 1080p] MVO', size: 2e10, seeders: 30, leechers: 3, indexer: 'RuTracker', downloadUrl: `${base}/dl/2`, infoHash: 'EEE' }]));
    }
    if (u.pathname === '/api/v1/indexer') return res.end(JSON.stringify([{ enable: true }, { enable: false }, { enable: true }]));
    if (u.pathname === '/dl/1') return res.writeHead(302, { Location: 'magnet:?xt=urn:btih:AAA&dn=dune' }).end();
    if (u.pathname === '/dl/2') return res.end(Buffer.from('d8:announce3:xyz4:infod4:name3:abcee'));
    if (u.pathname === '/dl/3') return res.writeHead(301, { Location: '/dl/2' }).end();
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('IndexerClient (Jackett)', () => {
  const client = () => new IndexerClient(() => ({ kind: 'jackett', url: base, apiKey: 'KEY' }));

  it('searches by catalog titles, merges duplicates and ranks the right release first', async () => {
    const r = await client().search({ titles: ['Дюна: Часть вторая', 'Dune: Part Two'], year: 2024, type: 'movie' });
    expect(r.queries).toEqual(['Дюна Часть вторая 2024', 'Dune Part Two 2024']);
    expect(seen.some((s) => s.includes('Category%5B%5D=2000'))).toBe(true);
    // BBB from two trackers → one row with the higher seed count
    expect(r.results.filter((x) => x.title.includes('2160p'))).toHaveLength(1);
    expect(r.results.find((x) => x.title.includes('2160p'))?.seeders).toBe(90);
    expect(r.results[0].title).toContain('Dub');
    expect(r.results[0].link).toBe(`${base}/dl/1`);
    const old = r.results.find((x) => x.title.startsWith('Dune 1984'));
    expect(old?.matched).toBe(false);
    const cam = r.results.find((x) => x.title.includes('CAMRip'));
    expect(r.results.indexOf(cam!)).toBeGreaterThan(1);
    expect(r.errors).toContain('Broken');
  });

  it('reports a wrong API key', async () => {
    const c = new IndexerClient(() => ({ kind: 'jackett', url: base, apiKey: 'nope' }));
    await expect(c.search({ query: 'Dune' })).rejects.toThrow(/API-ключ/);
  });

  it('turns indexer links into magnets or .torrent files', async () => {
    const c = client();
    expect(await c.resolveLink(`${base}/dl/1`)).toEqual({ magnet: 'magnet:?xt=urn:btih:AAA&dn=dune' });
    const t = await c.resolveLink(`${base}/dl/3`);
    expect(t.buffer?.[0]).toBe(0x64);
  });
});

describe('IndexerClient (Prowlarr)', () => {
  it('searches and counts enabled indexers', async () => {
    const c = new IndexerClient(() => ({ kind: 'prowlarr', url: base, apiKey: 'PKEY' }));
    const r = await c.search({ titles: ['Извне', 'From'], type: 'tv', season: 2 });
    expect(r.results[0]).toMatchObject({ matched: true, season: 2, pack: true, link: `${base}/dl/2` });
    expect(await c.test({ kind: 'prowlarr', url: base, apiKey: 'PKEY' })).toBe(2);
  });
});

describe('detectLocalIndexer', () => {
  it('finds Jackett installed on this PC and reads its API key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvbox-ix-'));
    fs.mkdirSync(path.join(dir, 'Jackett'));
    fs.writeFileSync(path.join(dir, 'Jackett', 'ServerConfig.json'), '﻿' + JSON.stringify({ Port: 9118, APIKey: 'abc123', BasePathOverride: null }));
    const prev = { ProgramData: process.env.ProgramData, LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA };
    process.env.ProgramData = dir;
    delete process.env.LOCALAPPDATA;
    delete process.env.APPDATA;
    try {
      expect(detectLocalIndexer()).toEqual({ kind: 'jackett', url: 'http://127.0.0.1:9118', apiKey: 'abc123' });
    } finally {
      Object.assign(process.env, prev);
    }
  });
});
