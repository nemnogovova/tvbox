import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import { Events, type AuthResult, type LinkStartResult, type SyncPayload } from '@tvbox/shared';
import { createServer, type TvboxServer } from './index';
import { JsonStore } from './store';
import { signToken, verifyToken, turnCredentials } from './tokens';
import type { GoogleVerifier } from './auth';

const OWNER = 'nemnogovova@gmail.com';
const GUEST = 'guest@example.com';

const verifyGoogle: GoogleVerifier = async (t) => {
  if (t === 'g-owner') return { sub: 'o1', email: OWNER, name: 'Owner' };
  if (t === 'g-guest') return { sub: 'g1', email: GUEST, name: 'Guest' };
  if (t === 'g-stranger') return { sub: 's1', email: 'stranger@example.com', name: 'Stranger' };
  return null;
};

let dir: string;
let srv: TvboxServer;
let port: number;
const clients: ClientSocket[] = [];

function env(): NodeJS.ProcessEnv {
  return {
    OWNER_EMAIL: OWNER,
    GOOGLE_CLIENT_ID: 'test-client',
    SESSION_SECRET: 'x'.repeat(64),
    DEVICE_TOKEN: 'legacy-device',
    DATA_DIR: dir,
    STATIC_DIR: path.join(dir, 'static'),
    PUBLIC_URL: 'https://tv.example.com',
    TURN_SECRET: 'turnsecret',
    TURN_HOST: 'tv.example.com',
    RELEASE_TOKEN: 'rel-token',
  };
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvbox-be-'));
  srv = createServer(env(), { verifyGoogle, tvTimeoutMs: 500 });
  srv.store.addGuest(GUEST);
  port = await srv.listen(0);
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function connect(): ClientSocket {
  const c = ioc(`http://localhost:${port}`, { forceNew: true, transports: ['websocket'] });
  clients.push(c);
  return c;
}

function emitAck<T>(s: ClientSocket, evt: string, data?: unknown): Promise<T> {
  return new Promise((resolve) => s.emit(evt, data, (res: T) => resolve(res)));
}

function next<T>(s: ClientSocket, evt: string): Promise<T> {
  return new Promise((resolve) => s.once(evt, resolve));
}

async function remote(idToken: string): Promise<{ s: ClientSocket; res: AuthResult; sync: SyncPayload }> {
  const s = connect();
  const syncP = next<SyncPayload>(s, Events.SYNC);
  const res = await emitAck<AuthResult>(s, Events.AUTH, { idToken });
  const sync = res.ok ? await syncP : (undefined as unknown as SyncPayload);
  return { s, res, sync };
}

async function pairedTv(): Promise<ClientSocket> {
  const tv = connect();
  const start = await emitAck<LinkStartResult>(tv, Events.LINK_START, { kind: 'tv', name: 'Living room' });
  const done = next<{ token: string }>(tv, Events.LINK_DONE);
  const { s: owner } = await remote('g-owner');
  const approve = await emitAck<{ ok: boolean }>(owner, Events.LINK_APPROVE, { code: start.code });
  expect(approve.ok).toBe(true);
  const { token } = await done;
  const res = await emitAck<AuthResult>(tv, Events.AUTH, { token });
  expect(res.ok).toBe(true);
  expect(res.isTv).toBe(true);
  return tv;
}

describe('tokens', () => {
  it('signs and verifies, rejects tampering', () => {
    const t = signToken({ k: 'tv', v: 1, name: 'TV', iat: Date.now() }, 'secret');
    expect(verifyToken(t, 'secret')).toMatchObject({ k: 'tv', v: 1 });
    expect(verifyToken(t, 'other')).toBeNull();
    expect(verifyToken(t.replace(/^./, 'A'), 'secret')).toBeNull();
    expect(verifyToken('garbage', 'secret')).toBeNull();
  });

  it('rejects expired tokens', () => {
    const t = signToken({ k: 'tv', v: 1, name: 'TV', iat: Date.now() - 1000 }, 's');
    expect(verifyToken(t, 's', 10)).toBeNull();
  });

  it('builds TURN credentials', () => {
    const c = turnCredentials('s', 'a@b.c');
    expect(c.username).toMatch(/^\d+:a@b\.c$/);
    expect(c.credential.length).toBeGreaterThan(10);
  });
});

describe('JsonStore', () => {
  it('dedupes guests, persists, toggles flags', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tvbox-store-'));
    const a = new JsonStore(d);
    a.addGuest('Alice@Example.com');
    a.addGuest('alice@example.com ');
    a.setDictatorMode(true);
    const v = a.bumpTvTokenVersion();
    const b = new JsonStore(d);
    expect(b.getAdminState().guests).toHaveLength(1);
    expect(b.isGuest('ALICE@example.com')).toBe(true);
    expect(b.dictatorMode).toBe(true);
    expect(b.tvTokenVersion).toBe(v);
    expect(b.removeGuest('alice@example.com')).toBe(true);
    expect(b.isGuest('alice@example.com')).toBe(false);
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe('http api', () => {
  it('health + config', async () => {
    const h = await request(srv.httpServer).get('/api/health');
    expect(h.body.ok).toBe(true);
    const c = await request(srv.httpServer).get('/api/config');
    expect(c.body).toMatchObject({ googleClientId: 'test-client', oauthConfigured: true, turn: true });
  });

  it('allows cross-origin API calls (Android app / TV client)', async () => {
    const pre = await request(srv.httpServer).options('/api/ice').set('Origin', 'https://localhost').set('Access-Control-Request-Headers', 'authorization');
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('*');
    expect(pre.headers['access-control-allow-headers']).toMatch(/Authorization/);
    const c = await request(srv.httpServer).get('/api/config').set('Origin', 'https://localhost');
    expect(c.headers['access-control-allow-origin']).toBe('*');
  });

  it('exchanges google token for a session and serves ICE servers', async () => {
    const r = await request(srv.httpServer).post('/api/auth/google').send({ credential: 'g-owner' });
    expect(r.status).toBe(200);
    expect(r.body.user.role).toBe('owner');
    const me = await request(srv.httpServer).get('/api/auth/me').set('Authorization', `Bearer ${r.body.token}`);
    expect(me.body.user.email).toBe(OWNER);
    const ice = await request(srv.httpServer).get('/api/ice').set('Authorization', `Bearer ${r.body.token}`);
    expect(ice.body.iceServers.some((s: { urls: string | string[] }) => String(s.urls).includes('turn:'))).toBe(true);
  });

  it('puts strangers on the waiting list, rejects bad tokens', async () => {
    const r = await request(srv.httpServer).post('/api/auth/google').send({ credential: 'g-stranger' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('pending_approval');
    srv.store.setRegistrationOpen(false);
    const r2 = await request(srv.httpServer).post('/api/auth/google').send({ credential: 'g-stranger' });
    expect(r2.body.error).toBe('pending_approval'); // already has a pending account
    expect(srv.store.getAdminState().accounts.find((a) => a.email === 'stranger@example.com')?.role).toBe('pending');
    const bad = await request(srv.httpServer).post('/api/auth/google').send({ credential: 'nope' });
    expect(bad.status).toBe(401);
    const me = await request(srv.httpServer).get('/api/auth/me').set('Authorization', 'Bearer x.y');
    expect(me.status).toBe(401);
  });

  it('serves the SPA with fallback for /link/:code', async () => {
    fs.mkdirSync(path.join(dir, 'static'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'static', 'index.html'), '<html>remote</html>');
    const r = await request(srv.httpServer).get('/link/ABC123');
    expect(r.status).toBe(200);
    expect(r.text).toContain('remote');
    const api = await request(srv.httpServer).get('/api/unknown');
    expect(api.status).toBe(404);
  });
});

describe('socket hub', () => {
  it('authenticates owner and guest, rejects strangers', async () => {
    const o = await remote('g-owner');
    expect(o.res.ok).toBe(true);
    expect(o.res.user?.role).toBe('owner');
    expect(o.res.token).toBeTruthy();
    expect(o.sync.admin).not.toBeNull();
    const g = await remote('g-guest');
    expect(g.res.user?.role).toBe('guest');
    expect(g.sync.admin).toBeNull();
    const x = await remote('g-stranger');
    expect(x.res).toMatchObject({ ok: false, error: 'pending_approval' });
  });

  it('session token keeps working without Google', async () => {
    const o = await remote('g-owner');
    const s = connect();
    const res = await emitAck<AuthResult>(s, Events.AUTH, { token: o.res.token });
    expect(res.ok).toBe(true);
    expect(res.user?.email).toBe(OWNER);
  });

  it('pairs a TV by code (owner only) and relays commands with acks', async () => {
    const { s: guest } = await remote('g-guest');
    const tvA = connect();
    const start = await emitAck<LinkStartResult>(tvA, Events.LINK_START, { kind: 'tv', name: 'TV' });
    expect(start.url).toBe(`https://tv.example.com/link/${start.code}`);
    const info = await emitAck<{ ok: boolean; kind: string }>(guest, Events.LINK_INFO, { code: start.code!.toLowerCase() });
    expect(info).toMatchObject({ ok: true, kind: 'tv' });
    const denied = await emitAck<{ ok: boolean; error: string }>(guest, Events.LINK_APPROVE, { code: start.code });
    expect(denied.error).toBe('owner_only');

    const tv = await pairedTv();
    tv.on(Events.CONTROL, (cmd: { type: string; _meta: { by: { email: string } } }, ack: (r: unknown) => void) => {
      ack({ ok: true, data: { got: cmd.type, by: cmd._meta.by.email } });
    });
    const res = await emitAck<{ ok: boolean; data: { got: string; by: string } }>(guest, Events.CONTROL, { type: 'PLAY_PAUSE' });
    expect(res).toEqual({ ok: true, data: { got: 'PLAY_PAUSE', by: GUEST } });
  });

  it('links a remote device to the approving user', async () => {
    const phone = connect();
    const start = await emitAck<LinkStartResult>(phone, Events.LINK_START, { kind: 'remote', name: 'Pixel' });
    const done = next<{ token: string }>(phone, Events.LINK_DONE);
    const { s: guest } = await remote('g-guest');
    expect((await emitAck<{ ok: boolean }>(guest, Events.LINK_APPROVE, { code: start.code })).ok).toBe(true);
    const { token } = await done;
    const res = await emitAck<AuthResult>(phone, Events.AUTH, { token });
    expect(res.user?.email).toBe(GUEST);
    expect(res.isTv).toBe(false);
  });

  it('reports tv_offline and tv_timeout', async () => {
    const { s: owner } = await remote('g-owner');
    expect(await emitAck(owner, Events.CATALOG_GET, {})).toEqual({ ok: false, error: 'tv_offline' });
    await pairedTv(); // never answers
    expect(await emitAck(owner, Events.CATALOG_GET, {})).toEqual({ ok: false, error: 'tv_timeout' });
  });

  it('enforces guest permissions and dictator mode', async () => {
    const tv = await pairedTv();
    let powerCalls = 0;
    tv.on(Events.POWER, (_p: unknown, ack: (r: unknown) => void) => {
      powerCalls++;
      ack({ ok: true });
    });
    tv.on(Events.TORRENT_ADD, (_p: unknown, ack: (r: unknown) => void) => ack({ ok: true }));
    tv.on(Events.CONTROL, (_p: unknown, ack: (r: unknown) => void) => ack({ ok: true }));
    const { s: guest } = await remote('g-guest');
    const { s: owner } = await remote('g-owner');

    expect(await emitAck(guest, Events.TORRENT_ADD, { magnet: 'magnet:?xt=urn:btih:abc' })).toEqual({ ok: true });
    expect(await emitAck(guest, Events.POWER, { action: 'shutdown' })).toEqual({ ok: false, error: 'forbidden' });
    expect(powerCalls).toBe(0);
    expect(await emitAck(owner, Events.POWER, { action: 'sleep' })).toEqual({ ok: true });
    expect(powerCalls).toBe(1);

    const admin = await emitAck<{ ok: boolean; data: { dictatorMode: boolean } }>(owner, Events.DICTATOR_MODE, { enabled: true });
    expect(admin.data.dictatorMode).toBe(true);
    expect(await emitAck(guest, Events.CONTROL, { type: 'PAUSE' })).toEqual({ ok: false, error: 'dictator_mode' });
    expect(await emitAck(owner, Events.CONTROL, { type: 'PAUSE' })).toEqual({ ok: true });
  });

  it('caches TV broadcasts and sends them in SYNC', async () => {
    const tv = await pairedTv();
    const { s: owner } = await remote('g-owner');
    const got = next<{ title: string }>(owner, Events.PLAYER_STATE);
    tv.emit(Events.PLAYER_STATE, { title: 'Dune', status: 'playing' });
    expect((await got).title).toBe('Dune');
    tv.emit(Events.CATALOG, [{ id: 'm1', title: 'Dune' }]);
    await new Promise((r) => setTimeout(r, 50));
    const late = await remote('g-guest');
    expect(late.sync.player.title).toBe('Dune');
    expect(late.sync.catalog).toHaveLength(1);
    expect(late.sync.presence.tvConnected).toBe(true);
  });

  it('ignores broadcasts from non-TV sockets', async () => {
    const { s: owner } = await remote('g-owner');
    const { s: guest } = await remote('g-guest');
    let received = false;
    owner.on(Events.PLAYER_STATE, () => (received = true));
    guest.emit(Events.PLAYER_STATE, { title: 'fake' });
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toBe(false);
  });

  it('relays WebRTC signaling between a remote and the TV', async () => {
    const tv = await pairedTv();
    const { s: phone } = await remote('g-guest');
    const tvGot = next<{ from: string; sid: string; payload: unknown; label: string }>(tv, Events.WEBRTC_OFFER);
    phone.emit(Events.WEBRTC_OFFER, { to: 'tv', sid: 's1', payload: { sdp: 'offer' } });
    const offer = await tvGot;
    expect(offer.from).toBe(phone.id);
    expect(offer.label).toBe('Guest');
    const phoneGot = next<{ from: string; payload: unknown }>(phone, Events.WEBRTC_ANSWER);
    tv.emit(Events.WEBRTC_ANSWER, { to: offer.from, sid: 's1', payload: { sdp: 'answer' } });
    expect(await phoneGot).toMatchObject({ from: 'tv', payload: { sdp: 'answer' } });
  });

  it('removing a guest kicks them, unpair kicks the TV', async () => {
    const tv = await pairedTv();
    const { s: guest } = await remote('g-guest');
    const { s: owner } = await remote('g-owner');
    const kicked = next<{ reason: string }>(guest, Events.KICKED);
    const res = await emitAck<{ ok: boolean; data: { guests: unknown[] } }>(owner, Events.GUESTS_UPDATE, { remove: [GUEST] });
    expect(res.data.guests).toHaveLength(0);
    expect((await kicked).reason).toBe('removed');

    const tvKicked = next<{ reason: string }>(tv, Events.KICKED);
    await emitAck(owner, Events.TV_UNPAIR, {});
    expect((await tvKicked).reason).toBe('unpaired');
  });

  it('guests cannot use admin events', async () => {
    const { s: guest } = await remote('g-guest');
    expect(await emitAck(guest, Events.GUESTS_UPDATE, { add: ['x@y.z'] })).toEqual({ ok: false, error: 'forbidden' });
    expect(await emitAck(guest, Events.ADMIN_GET, {})).toEqual({ ok: false, error: 'forbidden' });
  });

  it('accepts the legacy device token', async () => {
    const s = connect();
    const res = await emitAck<AuthResult>(s, Events.AUTH, { deviceToken: 'legacy-device' });
    expect(res).toMatchObject({ ok: true, isTv: true });
  });
});

describe('login / password accounts', () => {
  const post = (url: string, body: unknown, token?: string) => {
    const r = request(srv.httpServer).post(url).send(body as object);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };

  it('registration waits for owner approval, then login works', async () => {
    const reg = await post('/api/auth/register', { username: 'Vasya', password: '1234', name: 'Вася' });
    expect(reg.status).toBe(202);
    expect(reg.body).toMatchObject({ ok: false, error: 'pending_approval', pending: true });
    expect((await post('/api/auth/login', { username: 'vasya', password: '1234' })).body.error).toBe('pending_approval');
    expect((await post('/api/auth/login', { username: 'vasya', password: 'nope' })).body.error).toBe('invalid_credentials');
    expect((await post('/api/auth/register', { username: 'vasya', password: '1234' })).body.error).toBe('username_taken');
    expect((await post('/api/auth/register', { username: 'x', password: '1' })).body.error).toBe('bad_username');

    const { s: owner } = await remote('g-owner');
    const acc = srv.store.findByUsername('vasya')!;
    const res = await emitAck<{ ok: boolean; data: { accounts: { id: string; role: string }[] } }>(owner, Events.ACCOUNT_UPDATE, { id: acc.id, role: 'guest' });
    expect(res.data.accounts.find((a) => a.id === acc.id)?.role).toBe('guest');

    const login = await post('/api/auth/login', { username: 'VASYA', password: '1234' });
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ role: 'guest', username: 'vasya', name: 'Вася' });
    const s = connect();
    expect((await emitAck<AuthResult>(s, Events.AUTH, { token: login.body.token })).ok).toBe(true);

    // owner deletes the account → kicked, token stops working
    const kicked = next<{ reason: string }>(s, Events.KICKED);
    await emitAck(owner, Events.ACCOUNT_DELETE, { id: acc.id });
    expect((await kicked).reason).toBe('removed');
    expect((await request(srv.httpServer).get('/api/auth/me').set('Authorization', `Bearer ${login.body.token}`)).status).toBe(401);
  });

  it('closed registration is rejected', async () => {
    srv.store.setRegistrationOpen(false);
    expect((await post('/api/auth/register', { username: 'petya', password: '1234' })).body.error).toBe('registration_closed');
  });

  it('first account becomes owner when Google sign-in is not configured', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tvbox-nogoogle-'));
    const s2 = createServer({ ...env(), GOOGLE_CLIENT_ID: '', OWNER_EMAIL: '', DATA_DIR: d });
    const a = await request(s2.httpServer).post('/api/auth/register').send({ username: 'admin', password: '0000' });
    expect(a.body.user.role).toBe('owner');
    const b = await request(s2.httpServer).post('/api/auth/register').send({ username: 'guest1', password: '0000' });
    expect(b.body.error).toBe('pending_approval');
    await s2.close();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('links a password to a Google account and Google to a password account', async () => {
    const g = await post('/api/auth/google', { credential: 'g-owner' });
    const token = g.body.token as string;
    const set = await post('/api/account/password', { username: 'boss', password: 'qwerty' }, token);
    expect(set.body).toMatchObject({ ok: true, data: { hasPassword: true, username: 'boss', google: { email: OWNER } } });
    const login = await post('/api/auth/login', { username: 'boss', password: 'qwerty' });
    expect(login.body.user).toMatchObject({ role: 'owner', email: OWNER });
    // changing the password needs the current one
    expect((await post('/api/account/password', { password: 'zzzz' }, token)).body.error).toBe('wrong_password');
    const me = await request(srv.httpServer).get('/api/account').set('Authorization', `Bearer ${login.body.token}`);
    expect(me.body.data.role).toBe('owner');

    srv.store.setRegistrationOpen(true);
    await post('/api/auth/register', { username: 'local1', password: '1111' });
    srv.store.updateAccount(srv.store.findByUsername('local1')!.id, { role: 'guest' });
    const l = await post('/api/auth/login', { username: 'local1', password: '1111' });
    expect((await post('/api/account/google', { credential: 'g-owner' }, l.body.token)).body.error).toBe('google_in_use');
    const link = await post('/api/account/google', { credential: 'g-guest' }, l.body.token);
    expect(link.body.data.google.email).toBe(GUEST);
    const unlink = await request(srv.httpServer).delete('/api/account/google').set('Authorization', `Bearer ${l.body.token}`);
    expect(unlink.body.ok).toBe(true);
  });

  it('keeps sessions issued by TVBox 2.0 (sub = Google id)', async () => {
    const legacy = signToken({ k: 'user', sub: 'o1', email: OWNER, name: 'Owner', iat: Date.now() }, 'x'.repeat(64));
    const me = await request(srv.httpServer).get('/api/auth/me').set('Authorization', `Bearer ${legacy}`);
    expect(me.body.user.role).toBe('owner');
  });
});

describe('REST control (Android background service)', () => {
  it('relays commands and returns the player state', async () => {
    const tv = await pairedTv();
    tv.on(Events.CONTROL, (cmd: { type: string }, ack: (r: unknown) => void) => ack({ ok: true, data: cmd.type }));
    tv.emit(Events.PLAYER_STATE, { title: 'Song', status: 'playing' });
    const g = await request(srv.httpServer).post('/api/auth/google').send({ credential: 'g-guest' });
    await new Promise((r) => setTimeout(r, 50));
    const st = await request(srv.httpServer).get('/api/player').set('Authorization', `Bearer ${g.body.token}`);
    expect(st.body.data.title).toBe('Song');
    const c = await request(srv.httpServer).post('/api/control').set('Authorization', `Bearer ${g.body.token}`).send({ type: 'PLAY_PAUSE' });
    expect(c.body).toEqual({ ok: true, data: 'PLAY_PAUSE' });
    const p = await request(srv.httpServer).post('/api/control').send({ type: 'PLAY_PAUSE' });
    expect(p.status).toBe(401);
  });
});

describe('releases', () => {
  it('accepts uploads with the release token and serves downloads', async () => {
    const body = Buffer.alloc(4096, 7);
    const bad = await request(srv.httpServer).post('/api/releases/android?version=2.1.0&file=TVBox.apk').set('Authorization', 'Bearer nope').send(body);
    expect(bad.status).toBe(401);
    const up = await request(srv.httpServer)
      .post('/api/releases/android?version=2.1.0&file=TVBox-Remote-2.1.0.apk')
      .set('Authorization', 'Bearer rel-token')
      .set('Content-Type', 'application/octet-stream')
      .send(body);
    expect(up.body.data).toMatchObject({ version: '2.1.0', size: 4096, url: '/downloads/android/TVBox-Remote-2.1.0.apk' });
    const m = await request(srv.httpServer).get('/api/releases');
    expect(m.body.data.android.version).toBe('2.1.0');
    const dl = await request(srv.httpServer).get('/download/android').redirects(1).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toContain('TVBox-Remote-2.1.0.apk');
    expect((dl.body as Buffer).length).toBe(4096);
    // a newer build replaces the old file
    await request(srv.httpServer).post('/api/releases/android?version=2.1.1&file=TVBox-Remote-2.1.1.apk').set('Authorization', 'Bearer rel-token').send(body);
    expect(fs.readdirSync(path.join(dir, 'releases', 'android'))).toEqual(['TVBox-Remote-2.1.1.apk']);
  });
});
