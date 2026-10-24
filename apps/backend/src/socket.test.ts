import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import { Events, type User, type AuthResult } from '@tvbox/shared';
import { createSocketHub } from './socket';
import { JsonStore } from './store';
import type { BackendConfig } from './config';

const OWNER: User = { id: 'o1', email: 'nemnogovova@gmail.com', name: 'Owner', role: 'owner' };
const GUEST: User = { id: 'g1', email: 'guest@example.com', name: 'Guest', role: 'guest' };

function makeConfig(dir: string): BackendConfig {
  return {
    port: 3000,
    ownerEmail: OWNER.email,
    deviceToken: 'secret-device-token',
    googleClientId: '',
    dataDir: dir,
    staticDir: path.join(dir, 'static'),
  };
}

function authenticate(idToken?: string): Promise<User | null> {
  if (idToken === 'owner-token') return Promise.resolve(OWNER);
  if (idToken === 'guest-token') return Promise.resolve(GUEST);
  return Promise.resolve(null);
}

interface TestCtx {
  server: http.Server;
  io: ReturnType<typeof createSocketHub>;
  dir: string;
  store: JsonStore;
  close: () => Promise<void>;
}

async function startHub(): Promise<TestCtx> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvbox-hub-'));
  const store = new JsonStore(dir);
  store.addGuest(GUEST.email);
  const config = makeConfig(dir);
  const server = http.createServer();
  const io = createSocketHub(server, { config, store, authenticate });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return {
    server,
    io,
    dir,
    store,
    close: async () => {
      io.close();
      await new Promise<void>((r) => server.close(() => r()));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function connect(port: number): ClientSocket {
  return ioc(`http://localhost:${port}`, { forceNew: true, transports: ['websocket'] });
}

function auth(socket: ClientSocket, payload: { idToken?: string; deviceToken?: string }): Promise<AuthResult> {
  return new Promise((resolve) => {
    socket.emit(Events.AUTH, payload);
    socket.once(Events.AUTH_RESULT, resolve);
  });
}

function once(socket: ClientSocket, event: string): Promise<unknown> {
  return new Promise((resolve) => socket.once(event, resolve));
}

describe('socket hub', () => {
  let ctx: TestCtx;
  let port: number;

  beforeEach(async () => {
    ctx = await startHub();
    port = (ctx.server.address() as { port: number }).port;
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('authenticates the owner and the device', async () => {
    const owner = connect(port);
    const r1 = await auth(owner, { idToken: 'owner-token' });
    expect(r1.ok).toBe(true);
    expect(r1.user?.role).toBe('owner');

    const tv = connect(port);
    const r2 = await auth(tv, { deviceToken: 'secret-device-token' });
    expect(r2.ok).toBe(true);
    expect(r2.user?.role).toBe('device');
    expect(r2.presence?.tvConnected).toBe(true);

    owner.close();
    tv.close();
  });

  it('rejects unknown users and bad device tokens', async () => {
    const s = connect(port);
    const r1 = await auth(s, { idToken: 'bogus' });
    expect(r1.ok).toBe(false);

    const s2 = connect(port);
    const r2 = await auth(s2, { deviceToken: 'wrong' });
    expect(r2.ok).toBe(false);
    s.close();
    s2.close();
  });

  it('relays CONTROL from owner to TV', async () => {
    const tv = connect(port);
    await auth(tv, { deviceToken: 'secret-device-token' });

    const owner = connect(port);
    await auth(owner, { idToken: 'owner-token' });

    const received = once(tv, Events.CONTROL);
    owner.emit(Events.CONTROL, { type: 'PLAY' });
    await expect(received).resolves.toEqual({ type: 'PLAY' });

    owner.close();
    tv.close();
  });

  it('guest CAN add torrents but CANNOT send power commands', async () => {
    const tv = connect(port);
    await auth(tv, { deviceToken: 'secret-device-token' });
    const guest = connect(port);
    await auth(guest, { idToken: 'guest-token' });

    const torrentReceived = once(tv, Events.TORRENT_ADD);
    guest.emit(Events.TORRENT_ADD, { magnet: 'magnet:?xt=urn:btih:abc' });
    await expect(torrentReceived).resolves.toEqual({ magnet: 'magnet:?xt=urn:btih:abc' });

    let powerReceived = false;
    tv.on(Events.POWER, () => {
      powerReceived = true;
    });
    guest.emit(Events.POWER, { action: 'shutdown' });
    await new Promise((r) => setTimeout(r, 100));
    expect(powerReceived).toBe(false);

    guest.close();
    tv.close();
  });

  it('owner CAN send power commands', async () => {
    const tv = connect(port);
    await auth(tv, { deviceToken: 'secret-device-token' });
    const owner = connect(port);
    await auth(owner, { idToken: 'owner-token' });

    const received = once(tv, Events.POWER);
    owner.emit(Events.POWER, { action: 'reboot' });
    await expect(received).resolves.toEqual({ action: 'reboot' });

    owner.close();
    tv.close();
  });

  it('dictator mode blocks guest control but not owner', async () => {
    const tv = connect(port);
    await auth(tv, { deviceToken: 'secret-device-token' });
    const owner = connect(port);
    await auth(owner, { idToken: 'owner-token' });
    const guest = connect(port);
    await auth(guest, { idToken: 'guest-token' });

    owner.emit(Events.DICTATOR_MODE, true);
    await new Promise((r) => setTimeout(r, 100));
    expect(ctx.store.getConfig().dictatorMode).toBe(true);

    let guestBlocked = true;
    tv.on(Events.CONTROL, () => {
      guestBlocked = false;
    });
    guest.emit(Events.CONTROL, { type: 'PAUSE' });
    await new Promise((r) => setTimeout(r, 100));
    expect(guestBlocked).toBe(true);

    const received = once(tv, Events.CONTROL);
    owner.emit(Events.CONTROL, { type: 'PAUSE' });
    await expect(received).resolves.toEqual({ type: 'PAUSE' });

    owner.close();
    guest.close();
    tv.close();
  });

  it('broadcasts PLAYER_STATE from device to remotes', async () => {
    const tv = connect(port);
    await auth(tv, { deviceToken: 'secret-device-token' });
    const owner = connect(port);
    await auth(owner, { idToken: 'owner-token' });

    const state = { source: 'youtube', playing: true, paused: false, title: 'x', duration: 10, position: 2, volume: 1, muted: false, fullscreen: true };
    const received = once(owner, Events.PLAYER_STATE);
    tv.emit(Events.PLAYER_STATE, state);
    await expect(received).resolves.toEqual(state);

    owner.close();
    tv.close();
  });

  it('relays webrtc signaling from remote to tv and back', async () => {
    const tv = connect(port);
    await auth(tv, { deviceToken: 'secret-device-token' });
    const remote = connect(port);
    await auth(remote, { idToken: 'owner-token' });

    const offer = { from: 'x', to: 'tv', kind: 'offer', payload: { sdp: 'sdp1' } };
    const tvGot = once(tv, Events.WEBRTC_OFFER);
    remote.emit(Events.WEBRTC_OFFER, offer);
    const relayed = (await tvGot) as typeof offer;
    expect(relayed.payload).toEqual({ sdp: 'sdp1' });
    expect(relayed.from).toBe(remote.id);

    // tv answers back to the remote
    const remoteGot = once(remote, Events.WEBRTC_ANSWER);
    tv.emit(Events.WEBRTC_ANSWER, { from: 'tv', to: remote.id, kind: 'answer', payload: { sdp: 'sdp2' } });
    const answer = (await remoteGot) as typeof offer;
    expect(answer.payload).toEqual({ sdp: 'sdp2' });

    remote.close();
    tv.close();
  });

  it('serves owner guest list updates', async () => {
    const owner = connect(port);
    await auth(owner, { idToken: 'owner-token' });

    const result = once(owner, Events.GUESTS_RESULT);
    owner.emit(Events.GUESTS_UPDATE, { add: ['new@example.com'] });
    const cfg = (await result) as { guests: { email: string }[] };
    expect(cfg.guests.some((g) => g.email === 'new@example.com')).toBe(true);

    owner.close();
  });
});
