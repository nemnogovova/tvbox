import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import {
  Events,
  TV_REQUEST_EVENTS,
  TV_STREAM_EVENTS,
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
  type AdminState,
  type AppsState,
  type YoutubeState,
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
  type RegistrationMode,
  type SignalMessage,
  type SyncPayload,
  type TorrentInfo,
  type User,
} from '@tvbox/shared';
import type { BackendConfig } from './config';
import type { Account, JsonStore } from './store';
import type { AuthService } from './auth';

const KNOWN_EVENTS = new Set<string>(Object.values(Events));

interface SocketData {
  user?: User;
  isTv: boolean;
  /** The home this socket belongs to (null: a signed-in user without a home yet) */
  homeId: string | null;
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

/** What the server keeps for one home while its TV is online. */
interface HomeRuntime {
  tv: HubSocket | null;
  player: PlayerState;
  catalog: MediaItem[];
  torrents: TorrentInfo[];
  idle: IdleSettings | null;
  apps: AppsState | null;
  youtube: YoutubeState | null;
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
  /** Relay a remote request to the TV of the user's home (permission checks included; used by the REST API too). */
  relayToTv: (user: User, event: string, data: unknown, timeoutMs?: number) => Promise<Ack<unknown>>;
  player: (homeId: string | null | undefined) => PlayerState;
  presence: (homeId: string | null | undefined) => PresenceInfo;
  /** Disconnect every socket of an account (access revoked). */
  kickAccount: (accountId: string, reason: string) => void;
  broadcastAdmin: () => void;
}

const LINK_TTL_MS = 10 * 60 * 1000;
const roomOf = (homeId: string) => `h:${homeId}`;

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

  const links = new Map<string, PendingLink>();
  const runtimes = new Map<string, HomeRuntime>();
  const runtime = (homeId: string): HomeRuntime => {
    let r = runtimes.get(homeId);
    if (!r) {
      r = { tv: null, player: { ...EMPTY_PLAYER_STATE }, catalog: [], torrents: [], idle: null, apps: null, youtube: null };
      runtimes.set(homeId, r);
    }
    return r;
  };
  const tvOf = (homeId: string | null | undefined): HubSocket | null => (homeId ? runtimes.get(homeId)?.tv ?? null : null);

  const sockets = (): HubSocket[] => Array.from(io.sockets.sockets.values()) as HubSocket[];
  const reply = (ack: unknown, res: unknown) => {
    if (typeof ack === 'function') (ack as AckFn)(res);
  };

  // ------------------------------------------------------------------ presence / admin views
  const presence = (homeId: string | null | undefined): PresenceInfo => {
    if (!homeId) return { tvConnected: false, remotes: [] };
    const seen = new Map<string, { name: string; role: User['role'] }>();
    for (const s of sockets()) {
      const u = s.data.user;
      if (!u || s.data.isTv || s.data.homeId !== homeId) continue;
      seen.set(u.id, { name: u.name, role: u.role });
    }
    const tv = tvOf(homeId);
    return {
      tvConnected: !!tv,
      tvName: tv?.data.user?.name || store.getHome(homeId)?.tvName,
      tvVersion: tv?.data.version,
      remotes: Array.from(seen.values()),
    };
  };
  const broadcastPresence = (homeId: string | null | undefined) => {
    if (homeId) io.to(roomOf(homeId)).emit(Events.PRESENCE, presence(homeId));
  };

  const memberSummaries = (homeId: string) => {
    const home = store.getHome(homeId);
    if (!home) return [];
    return home.members
      .map((m) => {
        const a = store.getAccount(m.accountId);
        return a ? store.summary(a, m.role) : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => (a.role === b.role ? a.createdAt - b.createdAt : a.role === 'owner' ? -1 : 1));
  };

  /** What a socket's user may see: their home (if they own it) and the server (if they run it). */
  const adminStateFor = (s: HubSocket): AdminState => {
    const u = s.data.user!;
    const home = store.getHome(s.data.homeId);
    const owner = !!home && store.memberRole(home, u.id) === 'owner';
    const members = home ? memberSummaries(home.id) : [];
    let server: AdminState['server'] = null;
    if (u.admin) {
      const accounts = store.accounts.slice().sort((a, b) => a.createdAt - b.createdAt);
      server = {
        registration: store.registration,
        pending: accounts.filter((a) => store.statusOf(a) === 'pending').map((a) => store.summary(a, 'pending')),
        accounts: accounts
          .filter((a) => store.statusOf(a) === 'active')
          .map((a) => ({ ...store.summary(a, 'guest'), admin: store.isAdmin(a) || undefined, homes: store.homesOf(a.id).map((x) => x.home.name) })),
        homes: store.homes.map((h) => ({
          id: h.id,
          name: h.name,
          owners: h.members.filter((m) => m.role === 'owner').map((m) => store.getAccount(m.accountId)?.name || '?'),
          members: h.members.length,
          tvName: h.tvName,
          tvOnline: !!tvOf(h.id),
          createdAt: h.createdAt,
        })),
      };
    }
    return {
      guests: owner && home ? home.invites.map((g) => ({ ...g })) : [],
      accounts: [...(server?.pending || []), ...(owner ? members : [])],
      dictatorMode: !!home?.dictatorMode,
      registrationOpen: store.registration !== 'closed',
      home: owner && home ? { id: home.id, name: home.name, inviteCode: home.inviteCode, inviteUrl: `${config.publicUrl}/join/${home.inviteCode}`, tvName: home.tvName } : null,
      members,
      server,
    };
  };
  const seesAdmin = (s: HubSocket) => !!s.data.user && !s.data.isTv && (s.data.user.role === 'owner' || !!s.data.user.admin);
  /** Owners and server admins get their (individual) admin view. */
  const broadcastAdmin = () => {
    for (const s of sockets()) if (seesAdmin(s)) s.emit(Events.ADMIN, adminStateFor(s));
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

  function kickTv(homeId: string, reason: string) {
    const tv = tvOf(homeId);
    if (tv) kick(tv, reason);
  }

  // ------------------------------------------------------------------ attaching sockets
  function attachTv(socket: HubSocket, homeId: string) {
    const rt = runtime(homeId);
    if (rt.tv && rt.tv !== socket) kick(rt.tv, 'replaced');
    rt.tv = socket;
    socket.data.isTv = true;
    socket.data.homeId = homeId;
    if (socket.data.user?.name) store.setTvName(homeId, socket.data.user.name);
  }

  /** (Re)join a remote to its user's current home and send it everything it needs. */
  function attachRemote(socket: HubSocket) {
    const user = socket.data.user!;
    const prev = socket.data.homeId;
    const homeId = user.homeId ?? null;
    if (prev && prev !== homeId) socket.leave(roomOf(prev));
    socket.data.homeId = homeId;
    if (homeId) socket.join(roomOf(homeId));
    const rt = homeId ? runtimes.get(homeId) : undefined;
    const sync: SyncPayload = {
      user,
      presence: presence(homeId),
      player: rt?.player ?? { ...EMPTY_PLAYER_STATE },
      catalog: rt?.catalog ?? [],
      torrents: rt?.torrents ?? [],
      idle: rt?.idle ?? null,
      admin: seesAdmin(socket) ? adminStateFor(socket) : null,
      apps: rt?.apps ?? null,
      youtube: rt?.youtube ?? null,
    };
    socket.emit(Events.SYNC, sync);
    if (prev !== homeId) broadcastPresence(prev);
  }

  /**
   * An account's homes or roles changed: every device it uses gets the new state at once
   * (no sign-in again). Removed / unapproved accounts are signed out.
   */
  function refreshAccount(accountId: string, notice?: string) {
    const a = store.getAccount(accountId);
    const homes = new Set<string | null>();
    for (const s of sockets()) {
      if (s.data.isTv || s.data.user?.id !== accountId) continue;
      if (!a || store.statusOf(a) === 'pending') {
        kick(s, 'removed');
        continue;
      }
      homes.add(s.data.homeId);
      s.data.user = auth.userFor(a);
      attachRemote(s);
      homes.add(s.data.homeId);
      if (notice) s.emit(Events.TOAST, { kind: 'info', message: notice });
    }
    for (const h of homes) broadcastPresence(h);
  }

  function refreshHomeMembers(homeId: string, ids: string[], notice?: string) {
    for (const id of ids) refreshAccount(id, notice);
    broadcastPresence(homeId);
  }

  function relayToTv(user: User, evt: string, data: unknown, timeoutMs = tvTimeoutMs): Promise<Ack<unknown>> {
    const home = store.getHome(user.homeId);
    if (!home) return Promise.resolve({ ok: false, error: 'no_home' });
    if (!canPerformEvent(user.role, evt, home.dictatorMode)) {
      const err = user.role === 'guest' && home.dictatorMode ? 'dictator_mode' : 'forbidden';
      return Promise.resolve({ ok: false, error: err });
    }
    const tv = tvOf(home.id);
    if (!tv) return Promise.resolve({ ok: false, error: 'tv_offline' });
    const meta = { by: { id: user.id, name: user.name, email: user.email, role: user.role } };
    const body = data && typeof data === 'object' && !Array.isArray(data) ? { ...(data as object), _meta: meta } : { _meta: meta };
    return new Promise((resolve) => {
      tv.timeout(timeoutMs).emit(evt, body, (err: Error | null, res: Ack<unknown>) => {
        resolve(err ? { ok: false, error: 'tv_timeout' } : res && typeof res === 'object' ? res : { ok: true });
      });
    });
  }

  io.on('connection', (raw: Socket) => {
    const socket = raw as HubSocket;
    socket.data = { isTv: false, homeId: null };

    // A newer remote / TV may send events this server doesn't know yet: answer them instead of
    // leaving the sender waiting for a timeout (and tell it to update the server).
    socket.onAny((event: string, ...args: unknown[]) => {
      if (KNOWN_EVENTS.has(event)) return;
      const ack = args[args.length - 1];
      if (typeof ack === 'function') (ack as AckFn)({ ok: false, error: 'server_outdated' });
    });

    /** The account behind this (remote) socket, fresh from the store. */
    const account = (): Account | undefined => (socket.data.user && !socket.data.isTv ? store.getAccount(socket.data.user.id) : undefined);
    /** Re-read the user (role / home may have changed) — every check below works with fresh data. */
    const freshUser = (): User | null => {
      const a = account();
      if (!a) return null;
      socket.data.user = auth.userFor(a);
      return socket.data.user;
    };

    // ------------------------------------------------------------- auth
    socket.on(Events.PING, (_d: unknown, ack?: AckFn) => reply(ack, { ok: true }));

    socket.on(Events.AUTH, async (payload: AuthPayload, ack?: AckFn) => {
      const p = payload && typeof payload === 'object' ? payload : {};
      let result: AuthResult;
      if (socket.data.user) {
        result = { ok: true, user: socket.data.user, isTv: socket.data.isTv };
      } else {
        const invite = typeof p.invite === 'string' ? p.invite : undefined;
        let out;
        if (p.token) out = auth.verifySession(p.token);
        else if (p.idToken) out = await auth.signInWithGoogle(p.idToken, invite);
        else if (p.deviceToken) out = auth.verifyLegacyDeviceToken(p.deviceToken);
        else out = { ok: false as const, error: 'missing_credentials' };

        if (!out.ok) {
          result = { ok: false, error: out.error };
        } else {
          socket.data.user = out.user;
          socket.data.version = typeof p.version === 'string' ? p.version.slice(0, 32) : undefined;
          if (out.isTv) attachTv(socket, out.user.homeId!);
          else attachRemote(socket);
          result = { ok: true, user: out.user, isTv: out.isTv, token: out.token };
        }
      }
      reply(ack, result);
      if (result.ok) {
        broadcastPresence(socket.data.homeId);
        if (socket.data.isTv) broadcastAdmin();
      }
    });

    // ------------------------------------------------------------- linking (QR pairing)
    socket.on(Events.LINK_START, (payload: LinkStartPayload, ack?: AckFn) => {
      pruneLinks();
      const kind: LinkKind = payload?.kind === 'tv' ? 'tv' : 'remote';
      const name = String(payload?.name || (kind === 'tv' ? 'Телевизор' : 'Устройство')).slice(0, 60);
      for (const [c, l] of links) if (l.socketId === socket.id) links.delete(c);
      if (links.size > 500) return reply(ack, { ok: false, error: 'busy' } satisfies LinkStartResult);
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

    /**
     * The signed-in user confirms a code shown by a device.
     * A TV joins one of the user's own homes (by default the current one, or a new one with
     * {homeId: 'new'}); a user without a home of their own gets a new home for it.
     */
    socket.on(Events.LINK_APPROVE, (payload: { code?: string; homeId?: string }, ack?: AckFn) => {
      pruneLinks();
      const user = freshUser();
      if (!user) return reply(ack, { ok: false, error: 'unauthorized' });
      const code = normalizeLinkCode(payload?.code || '');
      const l = links.get(code);
      if (!l) return reply(ack, { ok: false, error: 'expired' });
      const target = io.sockets.sockets.get(l.socketId);
      if (!target) {
        links.delete(code);
        return reply(ack, { ok: false, error: 'device_gone' });
      }
      if (l.kind === 'remote') {
        links.delete(code);
        target.emit(Events.LINK_DONE, { token: auth.issueUserToken(user) });
        return reply(ack, { ok: true });
      }
      const owned = store.homesOf(user.id).filter((x) => x.role === 'owner');
      let homeId: string;
      if (payload?.homeId && payload.homeId !== 'new') {
        // a TV goes only into a home the user owns
        if (!owned.some((x) => x.home.id === payload.homeId)) return reply(ack, { ok: false, error: 'owner_only' });
        homeId = payload.homeId;
      } else if (payload?.homeId === 'new' || !owned.length) {
        homeId = store.createHome(user.id, l.name).id;
      } else {
        homeId = owned.some((x) => x.home.id === user.homeId) ? user.homeId! : owned[0].home.id;
      }
      links.delete(code);
      store.setTvName(homeId, l.name);
      store.updateAccount(user.id, { activeHomeId: homeId });
      target.emit(Events.LINK_DONE, { token: auth.issueTvToken(homeId, l.name) });
      reply(ack, { ok: true, data: { homeId } });
      refreshAccount(user.id);
      broadcastAdmin();
    });

    // ------------------------------------------------------------- remote -> TV requests
    for (const evt of TV_REQUEST_EVENTS) {
      socket.on(evt, async (data: unknown, ack?: AckFn) => {
        const user = socket.data.user;
        if (!user || socket.data.isTv) return reply(ack, { ok: false, error: 'unauthorized' } satisfies Ack);
        reply(ack, await relayToTv(user, evt, data, evt === Events.MUSIC_SOURCE_ADD ? 40000 : tvTimeoutMs));
      });
    }

    // ------------------------------------------------------------- remote -> TV streams (touchpad), no acks
    for (const evt of TV_STREAM_EVENTS) {
      socket.on(evt, (data: unknown) => {
        const user = socket.data.user;
        const tv = tvOf(socket.data.homeId);
        if (!user || socket.data.isTv || !tv) return;
        if (!canPerformEvent(user.role, evt, !!store.getHome(socket.data.homeId)?.dictatorMode)) return;
        if (!data || typeof data !== 'object') return;
        tv.emit(evt, data);
      });
    }

    // ------------------------------------------------------------- TV -> remotes broadcasts (its own home only)
    for (const evt of TV_BROADCAST_EVENTS) {
      socket.on(evt, (data: unknown) => {
        const homeId = socket.data.homeId;
        if (!socket.data.isTv || !homeId || tvOf(homeId) !== socket) return;
        const rt = runtime(homeId);
        if (evt === Events.PLAYER_STATE) rt.player = data as PlayerState;
        else if (evt === Events.CATALOG && Array.isArray(data)) rt.catalog = data as MediaItem[];
        else if (evt === Events.TORRENTS && Array.isArray(data)) rt.torrents = data as TorrentInfo[];
        else if (evt === Events.IDLE) rt.idle = data as IdleSettings;
        else if (evt === Events.APPS_STATE) rt.apps = data as AppsState;
        else if (evt === Events.YOUTUBE_STATE) rt.youtube = data as YoutubeState;
        io.to(roomOf(homeId)).emit(evt, data);
      });
    }

    // ------------------------------------------------------------- WebRTC signaling (within a home)
    for (const evt of WEBRTC_EVENTS) {
      socket.on(evt, (msg: SignalMessage) => {
        const user = socket.data.user;
        if (!user || !msg || typeof msg !== 'object') return;
        if (socket.data.isTv) {
          const target = io.sockets.sockets.get(String(msg.to)) as HubSocket | undefined;
          if (target?.data.user && !target.data.isTv && target.data.homeId === socket.data.homeId) target.emit(evt, { ...msg, from: 'tv' });
          return;
        }
        if (!canPerformEvent(user.role, evt, !!store.getHome(socket.data.homeId)?.dictatorMode)) {
          socket.emit(Events.ERROR, { code: 'forbidden', message: 'Трансляция запрещена' });
          return;
        }
        const tv = tvOf(socket.data.homeId);
        if (!tv) {
          socket.emit(Events.ERROR, { code: 'tv_offline', message: 'Телевизор не в сети' });
          return;
        }
        tv.emit(evt, { ...msg, from: socket.id, label: msg.label || user.name });
      });
    }

    // ------------------------------------------------------------- home: owner tools
    /** The owner of the current home (fresh check), or an error answer. */
    const homeOwner = (evt: string, ack?: AckFn): { user: User; homeId: string } | null => {
      const user = freshUser();
      const homeId = user?.homeId;
      if (!user || !homeId || !canPerformEvent(user.role, evt)) {
        reply(ack, { ok: false, error: user && !homeId ? 'no_home' : 'forbidden' });
        return null;
      }
      return { user, homeId };
    };
    const serverAdmin = (ack?: AckFn): User | null => {
      const user = freshUser();
      if (!user?.admin) {
        reply(ack, { ok: false, error: 'forbidden' });
        return null;
      }
      return user;
    };
    const adminOk = (ack?: AckFn) => {
      broadcastAdmin();
      reply(ack, { ok: true, data: adminStateFor(socket) });
    };

    socket.on(Events.ADMIN_GET, (_d: unknown, ack?: AckFn) => {
      const user = freshUser();
      if (!user || !(user.role === 'owner' || user.admin)) return reply(ack, { ok: false, error: 'forbidden' });
      reply(ack, { ok: true, data: adminStateFor(socket) });
    });

    socket.on(Events.GUESTS_UPDATE, (payload: GuestsUpdatePayload, ack?: AckFn) => {
      const me = homeOwner(Events.GUESTS_UPDATE, ack);
      if (!me) return;
      const add = Array.isArray(payload?.add) ? payload.add : [];
      const remove = Array.isArray(payload?.remove) ? payload.remove : [];
      for (const e of add) if (!isValidEmail(e)) return reply(ack, { ok: false, error: 'invalid_email' });
      for (const e of add) {
        store.addInvite(me.homeId, e);
        // someone with that Google account already exists: they are in right away
        const a = store.findByGoogle('', normalizeEmail(e));
        if (a && !store.memberRole(store.getHome(me.homeId), a.id)) {
          if (a.status === 'pending') store.updateAccount(a.id, { status: 'active' });
          store.addMember(me.homeId, a.id, 'guest');
          refreshAccount(a.id);
        }
      }
      for (const e of remove) {
        const gone = store.removeInvite(me.homeId, e);
        refreshHomeMembers(me.homeId, gone, `Вас убрали из дома «${store.getHome(me.homeId)?.name || ''}»`);
      }
      adminOk(ack);
    });

    /**
     * {id, role}: the server admin approves an account waiting for approval; the owner of a
     * home makes a member an owner / a guest ('pending' — removes them from the home).
     */
    socket.on(Events.ACCOUNT_UPDATE, (payload: { id?: string; role?: AccountRole }, ack?: AckFn) => {
      const user = freshUser();
      if (!user) return reply(ack, { ok: false, error: 'forbidden' });
      const id = String(payload?.id || '');
      const role = payload?.role;
      if (!['owner', 'guest', 'pending'].includes(String(role))) return reply(ack, { ok: false, error: 'bad_role' });
      if (id === user.id) return reply(ack, { ok: false, error: 'self' });
      const target = store.getAccount(id);
      if (!target) return reply(ack, { ok: false, error: 'not_found' });
      if (store.statusOf(target) === 'pending') {
        if (!user.admin) return reply(ack, { ok: false, error: 'forbidden' });
        if (role !== 'pending') store.updateAccount(id, { status: 'active' });
        return adminOk(ack);
      }
      const me = homeOwner(Events.ACCOUNT_UPDATE, ack);
      if (!me) return;
      const home = store.getHome(me.homeId)!;
      if (!store.memberRole(home, id)) return reply(ack, { ok: false, error: 'not_found' });
      if (role === 'pending') {
        store.removeMember(me.homeId, id);
        refreshAccount(id, `Вас убрали из дома «${home.name}»`);
      } else {
        store.setMemberRole(me.homeId, id, role as 'owner' | 'guest');
        refreshAccount(id);
      }
      broadcastPresence(me.homeId);
      adminOk(ack);
    });

    socket.on(Events.MEMBER_REMOVE, (payload: { id?: string }, ack?: AckFn) => {
      const me = homeOwner(Events.MEMBER_REMOVE, ack);
      if (!me) return;
      const id = String(payload?.id || '');
      if (id === me.user.id) return reply(ack, { ok: false, error: 'self' });
      const home = store.getHome(me.homeId)!;
      if (!store.removeMember(me.homeId, id)) return reply(ack, { ok: false, error: 'not_found' });
      refreshAccount(id, `Вас убрали из дома «${home.name}»`);
      broadcastPresence(me.homeId);
      adminOk(ack);
    });

    /** Server admin: delete an account everywhere. Owners of a home (older remotes): remove from the home. */
    socket.on(Events.ACCOUNT_DELETE, (payload: { id?: string }, ack?: AckFn) => {
      const user = freshUser();
      if (!user) return reply(ack, { ok: false, error: 'forbidden' });
      const id = String(payload?.id || '');
      if (id === user.id) return reply(ack, { ok: false, error: 'self' });
      if (user.admin) {
        const affected = new Set<string>();
        for (const { home } of store.homesOf(id)) for (const m of home.members) affected.add(m.accountId);
        const { deleted, homesDeleted } = store.deleteAccount(id);
        if (!deleted) return reply(ack, { ok: false, error: 'not_found' });
        kickAccount(id, 'removed');
        for (const h of homesDeleted) {
          kickTv(h, 'unpaired');
          runtimes.delete(h);
        }
        for (const a of affected) if (a !== id) refreshAccount(a);
        return adminOk(ack);
      }
      const me = homeOwner(Events.ACCOUNT_DELETE, ack);
      if (!me) return;
      const home = store.getHome(me.homeId)!;
      if (!store.removeMember(me.homeId, id)) return reply(ack, { ok: false, error: 'not_found' });
      refreshAccount(id, `Вас убрали из дома «${home.name}»`);
      adminOk(ack);
    });

    socket.on(Events.REGISTRATION_SET, (payload: { open?: boolean; mode?: RegistrationMode }, ack?: AckFn) => {
      if (!serverAdmin(ack)) return;
      const modes: RegistrationMode[] = ['open', 'approval', 'closed'];
      const mode = modes.includes(payload?.mode as RegistrationMode) ? (payload!.mode as RegistrationMode) : payload?.open ? 'approval' : 'closed';
      store.setRegistration(mode);
      adminOk(ack);
    });

    socket.on(Events.DICTATOR_MODE, (payload: { enabled?: boolean } | boolean, ack?: AckFn) => {
      const me = homeOwner(Events.DICTATOR_MODE, ack);
      if (!me) return;
      const enabled = typeof payload === 'boolean' ? payload : Boolean(payload?.enabled);
      store.setDictatorMode(me.homeId, enabled);
      broadcastAdmin();
      io.to(roomOf(me.homeId)).emit(Events.TOAST, {
        kind: enabled ? 'warning' : 'info',
        message: enabled ? 'Владелец включил «режим диктатора»: управление гостям недоступно' : 'Режим диктатора выключен',
      });
      reply(ack, { ok: true, data: adminStateFor(socket) });
    });

    socket.on(Events.TV_UNPAIR, (_d: unknown, ack?: AckFn) => {
      const me = homeOwner(Events.TV_UNPAIR, ack);
      if (!me) return;
      store.bumpTvTokenVersion(me.homeId);
      kickTv(me.homeId, 'unpaired');
      reply(ack, { ok: true });
    });

    socket.on(Events.HOME_RENAME, (payload: { name?: string }, ack?: AckFn) => {
      const me = homeOwner(Events.HOME_RENAME, ack);
      if (!me) return;
      if (!store.renameHome(me.homeId, String(payload?.name || ''))) return reply(ack, { ok: false, error: 'bad_name' });
      refreshHomeMembers(me.homeId, store.getHome(me.homeId)!.members.map((m) => m.accountId));
      adminOk(ack);
    });

    socket.on(Events.HOME_INVITE_RESET, (_d: unknown, ack?: AckFn) => {
      const me = homeOwner(Events.HOME_INVITE_RESET, ack);
      if (!me) return;
      store.resetInviteCode(me.homeId);
      adminOk(ack);
    });

    socket.on(Events.HOME_DELETE, (_d: unknown, ack?: AckFn) => {
      const me = homeOwner(Events.HOME_DELETE, ack);
      if (!me) return;
      const home = store.getHome(me.homeId)!;
      const members = home.members.map((m) => m.accountId);
      kickTv(home.id, 'unpaired');
      store.deleteHome(home.id);
      runtimes.delete(home.id);
      for (const id of members) refreshAccount(id, id === me.user.id ? undefined : `Дом «${home.name}» удалён`);
      reply(ack, { ok: true });
      broadcastAdmin();
    });

    // ------------------------------------------------------------- home: any member
    socket.on(Events.HOME_SWITCH, (payload: { homeId?: string }, ack?: AckFn) => {
      const user = freshUser();
      if (!user) return reply(ack, { ok: false, error: 'unauthorized' });
      const home = store.getHome(String(payload?.homeId || ''));
      if (!home || !store.memberRole(home, user.id)) return reply(ack, { ok: false, error: 'not_found' });
      store.updateAccount(user.id, { activeHomeId: home.id });
      reply(ack, { ok: true });
      refreshAccount(user.id);
    });

    socket.on(Events.HOME_JOIN, (payload: { code?: string }, ack?: AckFn) => {
      const user = freshUser();
      if (!user) return reply(ack, { ok: false, error: 'unauthorized' });
      const home = store.findHomeByInvite(String(payload?.code || ''));
      if (!home) return reply(ack, { ok: false, error: 'invite_invalid' });
      const was = store.memberRole(home, user.id);
      store.addMember(home.id, user.id, 'guest');
      store.updateAccount(user.id, { activeHomeId: home.id });
      reply(ack, { ok: true, data: { homeId: home.id, name: home.name } });
      refreshAccount(user.id);
      if (!was) {
        io.to(roomOf(home.id)).emit(Events.TOAST, { kind: 'info', message: `${user.name} теперь в доме «${home.name}»` });
        broadcastAdmin();
      }
    });

    socket.on(Events.HOME_LEAVE, (payload: { homeId?: string }, ack?: AckFn) => {
      const user = freshUser();
      if (!user) return reply(ack, { ok: false, error: 'unauthorized' });
      const home = store.getHome(String(payload?.homeId || user.homeId || ''));
      const role = store.memberRole(home, user.id);
      if (!home || !role) return reply(ack, { ok: false, error: 'not_found' });
      if (role === 'owner' && store.ownerCount(home) <= 1) return reply(ack, { ok: false, error: 'last_owner' });
      store.removeMember(home.id, user.id);
      reply(ack, { ok: true });
      refreshAccount(user.id);
      broadcastPresence(home.id);
      broadcastAdmin();
    });

    // ------------------------------------------------------------- disconnect
    socket.on('disconnect', () => {
      for (const [c, l] of links) if (l.socketId === socket.id) links.delete(c);
      const homeId = socket.data.homeId;
      if (homeId && socket.data.isTv && tvOf(homeId) === socket) {
        const rt = runtime(homeId);
        rt.tv = null;
        rt.player = { ...EMPTY_PLAYER_STATE, updatedAt: Date.now() };
        io.to(roomOf(homeId)).emit(Events.PLAYER_STATE, rt.player);
        broadcastAdmin();
      }
      if (socket.data.user) broadcastPresence(homeId);
    });
  });

  return {
    io,
    relayToTv,
    player: (homeId) => (homeId ? runtimes.get(homeId)?.player : undefined) ?? { ...EMPTY_PLAYER_STATE },
    presence,
    kickAccount,
    broadcastAdmin,
  };
}
