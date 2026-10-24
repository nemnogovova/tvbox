import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from './app';
import type { BackendConfig } from './config';

let dir: string;
let config: BackendConfig;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvbox-app-'));
  config = {
    port: 3000,
    ownerEmail: 'owner@example.com',
    deviceToken: 'tok',
    googleClientId: '',
    dataDir: dir,
    staticDir: path.join(dir, 'static'),
  };
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('express app', () => {
  it('responds to /api/health', async () => {
    const app = createApp(config);
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('serves static files when present', async () => {
    fs.mkdirSync(config.staticDir, { recursive: true });
    fs.writeFileSync(path.join(config.staticDir, 'index.html'), '<html>hello</html>');
    const app = createApp(config);
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('hello');
  });
});
