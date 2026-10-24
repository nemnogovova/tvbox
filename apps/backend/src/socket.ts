import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import {
  Events,
  canPerform,
  type AuthPayload,
  type AuthResult,
  type ControlCommand,
  type PlayerState,
  type PresenceInfo,
  type SignalMessage,
  type User,
  type CommandCategory,
  TORRENT_TARGET,
} from '@tvbox/shared';
import type { BackendConfig } from './config';
import { JsonStore } from './store';
import type { Authenticator } from './auth';

interface SocketData {
  user?: User;
  authed: boolean;
}

type TvboxSocket = Socket & { data: SocketData };

export interface SocketHubDeps {
  config: BackendConfig;
  store: JsonStore;
  authenticate: Authenticator;
}

const CATEGORY_BY_EVENT: Record<string, CommandCategory> = {
  [Events.CONTROL]: 'control',
  [Events.CATALOG_GET]: 'catalog',
  [Events.TORRENT_ADD]: 'torrent',
  [Events.TORRENT_REMOVE]: 'torrent',
  [Events.TORRENT_WATCH]: 'torrent',
  [Events.TORRENTS_GET]: 'torrent',
  [Events.FILE_DELETE]: 'file',
  [Events.METADATA_UPDATE]: 'file',
  [Events.FS_LIST]: 'fs',
  [Events.WEBRTC_OFFER]: 'webrtc',
  [Events.WEBRTC_ANSWER]: 'webrtc',
  [Events.WEBRTC_ICE]: 'webrtc',
  [Events.WEBRTC_LEAVE]: 'webrtc',
  [Events.WIDGETS_GET]: 'widgets',
  [Events.WIDGETS_UPDATE]: 'widgets',
  [Events.IDLE_SETTINGS_UPDATE]: 'widgets',
  [Events.POWER]: 'power',
  [Events.GUESTS_GET]: 'admin',
  [Events.GUESTS_UPDATE]: 'admin',
  [Events.DICTATOR_MODE]: 'admin',
};

export function createSocketHub(httpServer: HttpServer, deps: SocketHubDeps): Server {
  const { config, store, authenticate } = deps;

  const io = new Server(httpServer, {
    cors: { origin: true, credentials: true },
    maxHttpBufferSize: 2 * 1024 * 1024,
  });

  let tvSocket: TvboxSocket | null = null;
  let guestCount = 0;

  const presence = (): PresenceInfo => ({
    tvConnected: !!tvSocket,
    ownerConnected: Array.from(io.sockets.sockets.values()).some(
      (s) => (s as TvboxSocket).data.user?.role === 'owner',
    ),
    guestCount,
    tvId: tvSocket?.id,
  });

  const broadcastPresence = () => io.emit(Events.PRESENCE, presence());

  const socketIdToUser = (id: string): TvboxSocket | undefined =>
    io.sockets.sockets.get(id) as TvboxSocket | undefined;

  io.on('connection', (rawSocket: Socket) => {
    const socket = rawSocket as TvboxSocket;
    socket.data = { authed: false };

    socket.on(Events.AUTH, async (payload: AuthPayload) => {
      const result = await handleAuth(socket, payload);
      socket.emit(Events.AUTH_RESULT, result);
      if (result.ok) broadcastPresence();
    });

    // Player state broadcast from the TV device
    socket.on(Events.PLAYER_STATE, (state: PlayerState) => {
      if (socket.data.user?.role !== 'device') return;
      io.emit(Events.PLAYER_STATE, state);
    });

    // Events broadcast by the TV to every authenticated remote
    const tvBroadcasts = [
      Events.CATALOG,
      Events.CATALOG_UPDATE,
      Events.TORRENT_LIST,
      Events.TORRENT_PROGRESS,
      Events.WIDGETS_RESULT,
      Events.FS_LIST_RESULT,
    ];
    for (const evt of tvBroadcasts) {
      socket.on(evt, (data: unknown) => {
        if (socket.data.user?.role !== 'device') return;
        io.emit(evt, data);
      });
    }

    // Relay a request from a remote to the TV (with permission checks)
    const relayToTv = [
      Events.CONTROL,
      Events.CATALOG_GET,
      Events.TORRENT_ADD,
      Events.TORRENT_REMOVE,
      Events.TORRENT_WATCH,
      Events.TORRENTS_GET,
      Events.FILE_DELETE,
      Events.METADATA_UPDATE,
      Events.FS_LIST,
      Events.WIDGETS_GET,
      Events.WIDGETS_UPDATE,
      Events.IDLE_SETTINGS_UPDATE,
      Events.POWER,
    ];
    for (const evt of relayToTv) {
      socket.on(evt, (data: unknown) => {
        if (!requirePermission(socket, evt)) return;
        if (!tvSocket) {
          socket.emit(Events.ERROR, { code: 'TV_OFFLINE', message: 'TV client is offline' });
          return;
        }
        tvSocket.emit(evt, data);
      });
    }

    // WebRTC signaling relay (both directions)
    for (const evt of [Events.WEBRTC_OFFER, Events.WEBRTC_ANSWER, Events.WEBRTC_ICE, Events.WEBRTC_LEAVE]) {
      socket.on(evt, (msg: SignalMessage) => {
        if (!socket.data.authed) return;
        const from = socket.data.user?.role === 'device' ? 'tv' : socket.id;
        const out: SignalMessage = { ...msg, from };
        if (msg.to === TORRENT_TARGET || msg.to === 'tv') {
          if (!tvSocket) return;
          tvSocket.emit(evt, out);
        } else {
          const target = socketIdToUser(msg.to);
          if (target) target.emit(evt, out);
        }
      });
    }

    // Admin operations handled by the server directly
    socket.on(Events.GUESTS_GET, () => {
      if (!requirePermission(socket, Events.GUESTS_GET)) return;
      socket.emit(Events.GUESTS_RESULT, store.getConfig());
    });

    socket.on(Events.GUESTS_UPDATE, (payload: { add?: string[]; remove?: string[] }) => {
      if (!requirePermission(socket, Events.GUESTS_UPDATE)) return;
      if (payload.add) for (const email of payload.add) store.addGuest(email);
      if (payload.remove) for (const email of payload.remove) store.removeGuest(email);
      io.emit(Events.GUESTS_RESULT, store.getConfig());
    });

    socket.on(Events.DICTATOR_MODE, (enabled: boolean) => {
      if (!requirePermission(socket, Events.DICTATOR_MODE)) return;
      store.setDictatorMode(Boolean(enabled));
      io.emit(Events.GUESTS_RESULT, store.getConfig());
    });

    socket.on('disconnect', () => {
      if (tvSocket === socket) {
        tvSocket = null;
      }
      if (socket.data.user?.role === 'guest') guestCount = Math.max(0, guestCount - 1);
      broadcastPresence();
    });
  });

  function requirePermission(socket: TvboxSocket, event: string): boolean {
    if (!socket.data.authed || !socket.data.user) return false;
    const category = CATEGORY_BY_EVENT[event];
    if (!category) return true;
    return canPerform(socket.data.user.role, category, store.getConfig().dictatorMode);
  }

  async function handleAuth(socket: TvboxSocket, payload: AuthPayload): Promise<AuthResult> {
    if (socket.data.authed) {
      return { ok: true, user: socket.data.user, presence: presence() };
    }

    // Device auth
    if (payload?.deviceToken) {
      if (payload.deviceToken !== config.deviceToken) {
        return { ok: false, error: 'Invalid device token' };
      }
      const user: User = { id: 'tv-device', email: 'device', name: 'TV Device', role: 'device' };
      socket.data.user = user;
      socket.data.authed = true;
      if (tvSocket && tvSocket !== socket) tvSocket.disconnect(true);
      tvSocket = socket;
      return { ok: true, user, presence: presence() };
    }

    // User auth
    const user = await authenticate(payload?.idToken);
    if (!user) {
      return { ok: false, error: 'Authentication failed' };
    }
    socket.data.user = user;
    socket.data.authed = true;
    if (user.role === 'guest') guestCount += 1;
    return { ok: true, user, presence: presence() };
  }

  return io;
}
