import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from './store';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvbox-store-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('JsonStore', () => {
  it('adds and dedupes guests case-insensitively', () => {
    const store = new JsonStore(dir);
    store.addGuest('Alice@Example.com');
    store.addGuest('alice@example.com');
    expect(store.getConfig().guests).toHaveLength(1);
    expect(store.isGuest('ALICE@example.com')).toBe(true);
  });

  it('removes guests', () => {
    const store = new JsonStore(dir);
    store.addGuest('bob@example.com');
    expect(store.removeGuest('BOB@example.com')).toBe(true);
    expect(store.removeGuest('bob@example.com')).toBe(false);
    expect(store.isGuest('bob@example.com')).toBe(false);
  });

  it('toggles dictator mode', () => {
    const store = new JsonStore(dir);
    expect(store.getConfig().dictatorMode).toBe(false);
    store.setDictatorMode(true);
    expect(store.getConfig().dictatorMode).toBe(true);
  });

  it('persists across instances', () => {
    const a = new JsonStore(dir);
    a.addGuest('carol@example.com');
    a.setDictatorMode(true);

    const b = new JsonStore(dir);
    expect(b.isGuest('carol@example.com')).toBe(true);
    expect(b.getConfig().dictatorMode).toBe(true);
  });
});
