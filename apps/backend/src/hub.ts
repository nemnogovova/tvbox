import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import {
  Events,
  TV_REQUEST_EVENTS,
  TV_BROADCAST_EVENTS,
  WEBRTC_EVENTS,
  EMPTY_PLAYER_STATE,
  canPerformEvent,
  isValidEmail,
  normalizeEmail,
  normalizeLinkCode,
  randomCode,
  type Ack,
  type AccountRole,
  type AuthPayload,
  type AuthResult,
  type GuestsUpdatePayload,
  type IdleSettings,
  type LinkInfoResult,
  type LinkKind,
  type LinkStartPayload,
  type LinkStartResult,
  type MediaItem,
  type PlayerState,
  type PresenceInfo,
  type SignalMessage,
  type SyncPayload,
  type TorrentInfo,
  type User,
} from '@tvbox/shared';
import type { BackendConfig } from './config';
import type { JsonStore } from './store';
import type { AuthService } from './auth';

interface SocketData {
  user?: User;
  isTv: boolean;
  version?: string;
}

type HubSocket = Socket & { data: SocketData };
type AckFn = (res: unknown) => void;

interface PendingLink {
  code: string;
  kind: LinkKind;
  name: string;
  socketId: string;
  expiresAt: number;
}

export interface HubDeps {
  config: BackendConfig;
  store: JsonStore;
  auth: AuthService;
  /** Ack timeout for requests relayed to the TV */
  tvTimeoutMs?: number;
  linkTtlMs?: number;
}

export interface Hub {
  io: Server;
  /** Relay a remote request to the TV with permission checks (used by the REST API too). */
  relayToTv: (user: User, event: string, data: unknown, timeoutMs?: number) => Promise<Ack<unknown>>;
  player: () => PlayerState;
  presence: () => PresenceInfo;
  /** Disconnect every socket of an account (access revoked). */
  kickAccount: (accountId: string, reason: string) => void;
  broadcastAdmin: () => void;
}

const LINK_TTL_MS = 10 * 60 * 1000;

export function createHub(httpServer: HttpServer, deps: HubDeps): Hub {
  const { config, store, auth } = deps;
  const tvTimeoutMs = deps.tvTimeoutMs ?? 20000;
  const linkTtl = deps.linkTtlMs ?? LINK_TTL_MS;

  const io = new Server(httpServer, {
    cors: { origin: true, credentials: true },
    // .torrent files and upload chunks travel through the socket
    maxHttpBufferSize: 8 * 1024 * 1024,
    pingInterval: 15000,
    pingTimeout: 15000,
  });

  let tvSocket: HubSocket | null = null;
  const links = new Map<string, PendingLink>();
  const cache: {
    player: PlayerState;
    catalog: MediaItem[];
    torrents: TorrentInfo[];
    idle: IdleSettings | null;
  } = { player: { ...EMPTY_PLAYER_STATE }, catalog: [], torrents: [], idle: null };

  const sockets = (): HubSocket[] => Array.from(io.sockets.sockets.values()) as HubSocket[];
  const adminState = () => store.getAdminState(config.ownerEmail);

  const presence = (): PresenceInfo => {
    const seen = new Map<string, { name: string; role: User['role'] }>();
    for (const s of sockets()) {
      const u = s.data.user;
      if (!u || s.data.isTv) continue;
      seen.set(u.id, { name: u.name, role: u.role });
    }
    return {
      tvConnected: !!tvSocket,
      tvName: tvSocket?.data.user?.name || store.tvName,
      tvVersion: tvSocket?.data.version,
      remotes: Array.from(seen.values()),
    };
  };
  const broadcastPresence = () => io.to('remotes').emit(Events.PRESENCE, presence());
  const broadcastAdmin = () => io.to('owners').emit(Events.ADMIN, adminState());

  const reply = (ack: unknown, res: unknown) => {
    if (typeof ack === 'function') (ack as AckFn)(res);
  };

  const pruneLinks = () => {
    const now = Date.now();
    for (const [code, l] of links) if (l.expiresAt < now) links.delete(code);
  };

  function kick(socket: HubSocket, reason: string) {
    socket.emit(Events.KICKED, { reason });
    setTimeout(() => socket.disconnect(true), 50);
  }

  function kickAccount(accountId: string, reason: string) {
    for (const s of sockets()) if (s.data.user?.id === accountId && !s.data.isTv) kick(s, reason);
  }

  function attachTv(socket: HubSocket) {
    if (tvSocket && tvSocket !== socket) kick(tvSocket, 'replaced');
    tvSocket = socket;
    socket.data.isTv = true;
    socket.join('tv');
    if (socket.data.user?.name) store.setTvName(socket.data.user.name);
  }

  function attachRemote(socket: HubSocket) {
    socket.join('remotes');
    if (socket.data.user?.role === 'owner') socket.join('owners');
    const sync: SyncPayload = {
      presence: presence(),
      player: cache.player,
      catalog: cache.catalog,
      torrents: cache.torrents,
      idle: cache.idle,
      admin: socket.data.user?.role === 'owner' ? adminState() : null,
    };
    socket.emit(Events.SYNC, sync);
  }

  function relayToTv(user: User, evt: string, data: unknown, timeoutMs = tvTimeoutMs): Promise<Ack<unknown>> {
    if (!canPerformEvent(user.role, evt, store.dictatorMode)) {
      const err = user.role === 'guest' && store.dictatorMode ? 'dictator_mode' : 'forbidden';
      return Promise.resolve({ ok: false, error: err });
    }
    if (!tvSocket) return Promise.resolve({ ok: false, error: 'tv_offline' });
    const meta = { by: { id: user.id, name: user.name, email: user.email, role: user.role } };
    const body = data && typeof data === 'object' && !Array.isArray(data) ? { ...(data as object), _meta: meta } : { _meta: meta };
    const tv = tvSocket;
    return new Promise((resolve) => {
      tv.timeout(timeoutMs).emit(evt, body, (err: Error | null, res: Ack<unknown>) => {
        resolve(err ? { ok: false, error: 'tv_timeout' } : res && typeof res === 'object' ? res : { ok: true });
      });
    });
  }

  io.on('connection', (raw: Socket) => {
    const socket = raw as HubSocket;
    socket.data = { isTv: false };

    // ------------------------------------------------------------- auth
    socket.on(Events.PING, (_d: unknown, ack?: AckFn) => reply(ack, { ok: true }));

    socket.on(Events.AUTH, async (payload: AuthPayload, ack?: AckFn) => {
      const p = payload && typeof payload === 'object' ? payload : {};
      let result: AuthResult;
      if (socket.data.user) {
        result = { ok: true, user: socket.data.user, isTv: socket.data.isTv };
      } else {
        let out;
        if (p.token) out = auth.verifySession(p.token);
        else if (p.idToken) out = await auth.signInWithGoogle(p.idToken);
        else if (p.deviceToken) out = auth.verifyLegacyDeviceToken(p.deviceToken);
        else out = { ok: false as const, error: 'missing_credentials' };

        if (!out.ok) {
          result = { ok: false, error: out.error };
        } else {
          socket.data.user = out.user;
          socket.data.version = typeof p.version === 'string' ? p.version.slice(0, 32) : undefined;
          if (out.isTv) attachTv(socket);
          else attachRemote(socket);
          result = { ok: true, user: out.user, isTv: out.isTv, token: out.token };
        }
      }
      reply(ack, result);
      if (result.ok) broadcastPresence();
    });

    // ------------------------------------------------------------- linking (QR pairing)
    socket.on(Events.LINK_START, (payload: LinkStartPayload, ack?: AckFn) => {
      pruneLinks();
      const kind: LinkKind = payload?.kind === 'tv' ? 'tv' : 'remote';
      const name = String(payload?.name || (kind === 'tv' ? 'Телевизор' : 'Устройство')).slice(0, 60);
      for (const [c, l] of links) if (l.socketId === socket.id) links.delete(c);
      if (links.size > 200) return reply(ack, { ok: false, error: 'busy' } satisfies LinkStartResult);
      let code = randomCode(6);
      while (links.has(code)) code = randomCode(6);
      const expiresAt = Date.now() + linkTtl;
      links.set(code, { code, kind, name, socketId: socket.id, expiresAt });
      reply(ack, { ok: true, code, url: `${config.publicUrl}/link/${code}`, expiresAt } satisfies LinkStartResult);
    });

    socket.on(Events.LINK_INFO, (payload: { code?: string }, ack?: AckFn) => {
      pruneLinks();
      const l = links.get(normalizeLinkCode(payload?.code || ''));
      if (!l) return reply(ack, { ok: false, error: 'expired' } satisfies LinkInfoResult);
      reply(ack, { ok: true, kind: l.kind, name: l.name } satisfies LinkInfoResult);
    });

    socket.on(Events.LINK_APPROVE, (payload: { code?: string }, ack?: AckFn) => {
      pruneLinks();
      const user = socket.data.user;
      if (!user || socket.data.isTv) return reply(ack, { ok: false, error: 'unauthorized' });
      const code = normalizeLinkCode(payload?.code || '');
      const l = links.get(code);
      if (!l) return reply(ack, { ok: false, error: 'expired' });
      if (l.kind === 'tv' && user.role !== 'owner') return reply(ack, { ok: false, error: 'owner_only' });
      const target = io.sockets.sockets.get(l.socketId);
      if (!target) {
        links.delete(code);
        return reply(ack, { ok: false, error: 'device_gone' });
      }
      const token = l.kind === 'tv' ? auth.issueTvToken(l.name) : auth.issueUserToken(user);
      links.delete(code);
      target.emit(Events.LINK_DONE, { token });
      reply(ack, { ok: true });
    });

    // ------------------------------------------------------------- remote -> TV requests
    for (const evt of TV_REQUEST_EVENTS) {
      socket.on(evt, async (data: unknown, ack?: AckFn) => {
        const user = socket.data.user;
        if (!user || socket.data.isTv) return reply(ack, { ok: false, error: 'unauthorized' } satisfies Ack);
        reply(ack, await relayToTv(user, evt, data, evt === Events.MUSIC_SOURCE_ADD ? 40000 : tvTimeoutMs));
      });
    }

    // ------------------------------------------------------------- TV -> remotes broadcasts
    for (const evt of TV_BROADCAST_EVENTS) {
      socket.on(evt, (data: unknown) => {
        if (!socket.data.isTv || tvSocket !== socket) return;
        if (evt === Events.PLAYER_STATE) cache.player = data as PlayerState;
        else if (evt === Events.CATALOG && Array.isArray(data)) cache.catalog = data as MediaItem[];
        else if (evt === Events.TORRENTS && Array.isArray(data)) cache.torrents = data as TorrentInfo[];
        else if (evt === Events.IDLE) cache.idle = data as IdleSettings;
        io.to('remotes').emit(evt, data);
      });
    }

    // ------------------------------------------------------------- WebRTC signaling
    for (const evt of WEBRTC_EVENTS) {
      socket.on(evt, (msg: SignalMessage) => {
        const user = socket.data.user;
        if (!user || !msg || typeof msg !== 'object') return;
        if (socket.data.isTv) {
          const target = io.sockets.sockets.get(String(msg.to)) as HubSocket | undefined;
          if (target?.data.user && !target.data.isTv) target.emit(evt, { ...msg, from: 'tv' });
          return;
        }
        if (!canPerformEvent(user.role, evt, store.dictatorMode)) {
          socket.emit(Events.ERROR, { code: 'forbidden', message: 'Трансляция запрещена' });
          return;
        }
        if (!tvSocket) {
          socket.emit(Events.ERROR, { code: 'tv_offline', message: 'Телевизор не в сети' });
          return;
        }
        tvSocket.emit(evt, { ...msg, from: socket.id, label: msg.label || user.name });
      });
    }

    // ------------------------------------------------------------- admin (server side)
    const ownerOnly = (evt: string, ack?: AckFn): User | null => {
      const user = socket.data.user;
      if (!user || socket.data.isTv || !canPerformEvent(user.role, evt)) {
        reply(ack, { ok: false, error: 'forbidden' });
        return null;
      }
      return user;
    };
    const adminOk = (ack?: AckFn) => {
      broadcastAdmin();
      broadcastPresence();
      reply(ack, { ok: true, data: adminState() });
    };

    socket.on(Events.ADMIN_GET, (_d: unknown, ack?: AckFn) => {
      if (!ownerOnly(Events.ADMIN_GET, ack)) return;
      reply(ack, { ok: true, data: adminState() });
    });

    socket.on(Events.GUESTS_UPDATE, (payload: GuestsUpdatePayload, ack?: AckFn) => {
      if (!ownerOnly(Events.GUESTS_UPDATE, ack)) return;
      const add = Array.isArray(payload?.add) ? payload.add : [];
      const remove = Array.isArray(payload?.remove) ? payload.remove : [];
      for (const e of add) {
        if (!isValidEmail(e)) return reply(ack, { ok: false, error: 'invalid_email' });
        if (normalizeEmail(e) === config.ownerEmail) continue;
        store.addGuest(e);
      }
      for (const e of remove) {
        if (store.removeGuest(e)) {
          for (const s of sockets()) if (s.data.user?.email && s.data.user.email === normalizeEmail(e) && s.data.user.role !== 'owner') kick(s, 'removed');
        }
      }
      adminOk(ack);
    });

    socket.on(Events.ACCOUNT_UPDATE, (payload: { id?: string; role?: AccountRole }, ack?: AckFn) => {
      const me = ownerOnly(Events.ACCOUNT_UPDATE, ack);
      if (!me) return;
      const id = String(payload?.id || '');
      const role = payload?.role;
      if (!['owner', 'guest', 'pending'].includes(String(role))) return reply(ack, { ok: false, error: 'bad_role' });
      if (id === me.id) return reply(ack, { ok: false, error: 'self' });
      if (!store.updateAccount(id, { role })) return reply(ack, { ok: false, error: 'not_found' });
      if (role === 'pending') kickAccount(id, 'removed');
      else
        for (const s of sockets())
          if (s.data.user?.id === id) {
            // new role takes effect on the next sign-in; reconnect them now
            kick(s, 'role_changed');
          }
      adminOk(ack);
    });

    socket.on(Events.ACCOUNT_DELETE, (payload: { id?: string }, ack?: AckFn) => {
      const me = ownerOnly(Events.ACCOUNT_DELETE, ack);
      if (!me) return;
      const id = String(payload?.id || '');
      if (id === me.id) return reply(ack, { ok: false, error: 'self' });
      const a = store.getAccount(id);
      if (a?.google?.email) store.removeGuest(a.google.email);
      if (!store.deleteAccount(id)) return reply(ack, { ok: false, error: 'not_found' });
      kickAccount(id, 'removed');
      adminOk(ack);
    });

    socket.on(Events.REGISTRATION_SET, (payload: { open?: boolean }, ack?: AckFn) => {
      if (!ownerOnly(Events.REGISTRATION_SET, ack)) return;
      store.setRegistrationOpen(Boolean(payload?.open));
      adminOk(ack);
    });

    socket.on(Events.DICTATOR_MODE, (payload: { enabled?: boolean } | boolean, ack?: AckFn) => {
      if (!ownerOnly(Events.DICTATOR_MODE, ack)) return;
      const enabled = typeof payload === 'boolean' ? payload : Boolean(payload?.enabled);
      store.setDictatorMode(enabled);
      broadcastAdmin();
      io.to('remotes').emit(Events.TOAST, {
        kind: enabled ? 'warning' : 'info',
        message: enabled ? 'Владелец включил «режим диктатора»: управление гостям недоступно' : 'Режим диктатора выключен',
      });
      reply(ack, { ok: true, data: adminState() });
    });

    socket.on(Events.TV_UNPAIR, (_d: unknown, ack?: AckFn) => {
      if (!ownerOnly(Events.TV_UNPAIR, ack)) return;
      store.bumpTvTokenVersion();
      if (tvSocket) kick(tvSocket, 'unpaired');
      reply(ack, { ok: true });
    });

    // ------------------------------------------------------------- disconnect
    socket.on('disconnect', () => {
      for (const [c, l] of links) if (l.socketId === socket.id) links.delete(c);
      if (tvSocket === socket) {
        tvSocket = null;
        cache.player = { ...EMPTY_PLAYER_STATE, updatedAt: Date.now() };
        io.to('remotes').emit(Events.PLAYER_STATE, cache.player);
      }
      if (socket.data.user) broadcastPresence();
    });
  });

  return { io, relayToTv, player: () => cache.player, presence, kickAccount, broadcastAdmin };
}
