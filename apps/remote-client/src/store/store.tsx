import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  Events,
  type AuthResult,
  type ControlCommand,
  type GuestEntry,
  type IdleSettings,
  type MediaItem,
  type PlayerState,
  type PresenceInfo,
  type TorrentInfo,
  type User,
  type WidgetConfig,
  type FsListResult,
  type PowerAction,
  type MetadataUpdatePayload,
} from '@tvbox/shared';
import { SERVER_URL } from '../lib/config';

export interface StoreValue {
  connected: boolean;
  connecting: boolean;
  user: User | null;
  authError: string | null;
  presence: PresenceInfo;
  playerState: PlayerState | null;
  catalog: MediaItem[];
  torrents: TorrentInfo[];
  guests: GuestEntry[];
  dictatorMode: boolean;
  widgets: WidgetConfig[];
  idleSettings: IdleSettings | null;
  fsResult: FsListResult | null;
  socket: Socket | null;

  signIn: (idToken: string) => void;
  signOut: () => void;
  control: (cmd: ControlCommand) => void;
  addTorrent: (magnet: string) => void;
  removeTorrent: (id: string) => void;
  watchTorrent: (id: string, fileIndex?: number) => void;
  requestCatalog: () => void;
  requestTorrents: () => void;
  requestFs: (path?: string) => void;
  deleteFile: (mediaId: string, fileId?: string) => void;
  updateMetadata: (payload: MetadataUpdatePayload) => void;
  sendPower: (action: PowerAction) => void;
  updateGuests: (add: string[], remove: string[]) => void;
  setDictatorMode: (enabled: boolean) => void;
  updateWidgets: (widgets: WidgetConfig[], settings?: Partial<IdleSettings>) => void;
  emitSignal: (event: string, payload: unknown) => void;
}

const defaultPlayer: PlayerState = {
  source: 'none',
  playing: false,
  paused: true,
  title: 'Nothing playing',
  duration: 0,
  position: 0,
  volume: 1,
  muted: false,
  fullscreen: false,
};

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [presence, setPresence] = useState<PresenceInfo>({
    tvConnected: false,
    ownerConnected: false,
    guestCount: 0,
  });
  const [playerState, setPlayerState] = useState<PlayerState>(defaultPlayer);
  const [catalog, setCatalog] = useState<MediaItem[]>([]);
  const [torrents, setTorrents] = useState<TorrentInfo[]>([]);
  const [guests, setGuests] = useState<GuestEntry[]>([]);
  const [dictatorMode, setDictatorMode] = useState(false);
  const [widgets, setWidgets] = useState<WidgetConfig[]>([]);
  const [idleSettings, setIdleSettings] = useState<IdleSettings | null>(null);
  const [fsResult, setFsResult] = useState<FsListResult | null>(null);

  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io(SERVER_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 8000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      setConnecting(false);
      const saved = localStorage.getItem('tvbox.idToken');
      if (saved) socket.emit(Events.AUTH, { idToken: saved });
    });
    socket.on('disconnect', () => {
      setConnected(false);
    });
    socket.on(Events.AUTH_RESULT, (res: AuthResult) => {
      if (res.ok && res.user) {
        setUser(res.user);
        setAuthError(null);
        localStorage.setItem('tvbox.idToken', localStorage.getItem('tvbox.idToken') || '');
      } else {
        setUser(null);
        setAuthError(res.error || 'Authentication failed');
        localStorage.removeItem('tvbox.idToken');
      }
    });
    socket.on(Events.PRESENCE, (p: PresenceInfo) => setPresence(p));
    socket.on(Events.PLAYER_STATE, (s: PlayerState) => setPlayerState(s));
    socket.on(Events.CATALOG, (items: MediaItem[]) => setCatalog(items));
    socket.on(Events.CATALOG_UPDATE, (item: MediaItem) => {
      setCatalog((prev) => {
        const i = prev.findIndex((m) => m.id === item.id);
        if (i === -1) return [...prev, item];
        const next = [...prev];
        next[i] = item;
        return next;
      });
    });
    socket.on(Events.TORRENT_LIST, (items: TorrentInfo[]) => setTorrents(items));
    socket.on(Events.TORRENT_PROGRESS, (item: TorrentInfo) => {
      setTorrents((prev) => {
        const i = prev.findIndex((t) => t.id === item.id);
        if (i === -1) return [...prev, item];
        const next = [...prev];
        next[i] = item;
        return next;
      });
    });
    socket.on(Events.GUESTS_RESULT, (cfg: { guests: GuestEntry[]; dictatorMode: boolean }) => {
      setGuests(cfg.guests);
      setDictatorMode(cfg.dictatorMode);
    });
    socket.on(Events.WIDGETS_RESULT, (r: { widgets: WidgetConfig[]; settings: IdleSettings }) => {
      setWidgets(r.widgets);
      setIdleSettings(r.settings);
    });
    socket.on(Events.FS_LIST_RESULT, (r: FsListResult) => setFsResult(r));
    socket.on(Events.ERROR, (e: { message?: string }) => {
      if (e?.message) setAuthError(e.message);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  const emit = useCallback((event: string, payload?: unknown) => {
    socketRef.current?.emit(event, payload);
  }, []);

  const signIn = useCallback(
    (idToken: string) => {
      localStorage.setItem('tvbox.idToken', idToken);
      setConnecting(true);
      socketRef.current?.emit(Events.AUTH, { idToken });
    },
    [],
  );

  const signOut = useCallback(() => {
    localStorage.removeItem('tvbox.idToken');
    setUser(null);
    socketRef.current?.disconnect();
    socketRef.current?.connect();
  }, []);

  const value: StoreValue = {
    connected,
    connecting,
    user,
    authError,
    presence,
    playerState,
    catalog,
    torrents,
    guests,
    dictatorMode,
    widgets,
    idleSettings,
    fsResult,
    socket: socketRef.current,
    signIn,
    signOut,
    control: (cmd) => emit(Events.CONTROL, cmd),
    addTorrent: (magnet) => emit(Events.TORRENT_ADD, { magnet }),
    removeTorrent: (id) => emit(Events.TORRENT_REMOVE, { torrentId: id }),
    watchTorrent: (id, fileIndex) => emit(Events.TORRENT_WATCH, { torrentId: id, fileIndex }),
    requestCatalog: () => emit(Events.CATALOG_GET),
    requestTorrents: () => emit(Events.TORRENTS_GET),
    requestFs: (path) => emit(Events.FS_LIST, { path }),
    deleteFile: (mediaId, fileId) => emit(Events.FILE_DELETE, { mediaId, fileId }),
    updateMetadata: (payload) => emit(Events.METADATA_UPDATE, payload),
    sendPower: (action) => emit(Events.POWER, { action }),
    updateGuests: (add, remove) => emit(Events.GUESTS_UPDATE, { add, remove }),
    setDictatorMode: (enabled) => emit(Events.DICTATOR_MODE, enabled),
    updateWidgets: (w, settings) => emit(Events.WIDGETS_UPDATE, { widgets: w, settings }),
    emitSignal: (event, payload) => emit(event, payload),
  };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used within StoreProvider');
  return ctx;
}

export function useIsOwner(): boolean {
  return useStore().user?.role === 'owner';
}
