import { create } from 'zustand';
import { io, type Socket } from 'socket.io-client';
import {
  EMPTY_PLAYER_STATE,
  Events,
  type Ack,
  type AdminState,
  type AuthResult,
  type ControlCommand,
  type IdleSettings,
  type LinkStartResult,
  type MediaItem,
  type MusicSource,
  type PlayerState,
  type PresenceInfo,
  type SyncPayload,
  type TorrentInfo,
  type User,
} from '@tvbox/shared';
import { getPref, getServerUrl, getToken, setServerUrl, setToken } from '../lib/config';
import { startBackgroundControl, stopBackgroundControl } from '../lib/native';

export type ToastKind = 'info' | 'success' | 'error' | 'warning';
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

type ConnStatus = 'connecting' | 'online' | 'offline';
type AuthState = 'unknown' | 'anon' | 'authed';

interface Optimistic {
  status?: PlayerState['status'];
  position?: number;
  volume?: number;
  muted?: boolean;
  until: number;
}

export interface StoreState {
  serverUrl: string;
  conn: ConnStatus;
  auth: AuthState;
  user: User | null;
  authError: string | null;
  deniedEmail: string | null;

  presence: PresenceInfo;
  player: PlayerState;
  playerReceivedAt: number;
  optimistic: Optimistic | null;
  catalog: MediaItem[];
  torrents: TorrentInfo[];
  idle: IdleSettings | null;
  admin: AdminState | null;
  toasts: Toast[];
  kickedReason: string | null;
  /** Music services connected to the TV (null = not loaded yet) */
  musicSources: MusicSource[] | null;
}

const initial: StoreState = {
  serverUrl: getServerUrl(),
  conn: 'connecting',
  auth: getToken() ? 'unknown' : 'anon',
  user: null,
  authError: null,
  deniedEmail: null,
  presence: { tvConnected: false, remotes: [] },
  player: { ...EMPTY_PLAYER_STATE },
  playerReceivedAt: Date.now(),
  optimistic: null,
  catalog: [],
  torrents: [],
  idle: null,
  admin: null,
  toasts: [],
  kickedReason: null,
  musicSources: null,
};

export const useStore = create<StoreState>(() => initial);
const set = useStore.setState;
const get = useStore.getState;

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

let toastSeq = 1;
export function toast(message: string, kind: ToastKind = 'info', ms = 3500): void {
  const id = toastSeq++;
  set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, message }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}

const ERROR_TEXT: Record<string, string> = {
  tv_offline: 'Телевизор не в сети',
  tv_timeout: 'Телевизор не ответил',
  forbidden: 'Недостаточно прав',
  dictator_mode: 'Владелец временно заблокировал управление',
  unauthorized: 'Нужно войти',
  not_found: 'Не найдено',
  offline: 'Нет связи с сервером',
  expired: 'Код устарел — попросите новый',
  owner_only: 'Подключить телевизор может только владелец',
  device_gone: 'Устройство уже отключилось',
  invalid_email: 'Некорректный email',
  invalid_credentials: 'Неверный логин или пароль',
  pending_approval: 'Аккаунт ждёт одобрения владельца',
  username_taken: 'Такой логин уже занят',
  weak_password: 'Пароль слишком короткий — минимум 4 символа',
  bad_username: 'Логин: 3–32 символа, буквы, цифры, точка, дефис или _',
  registration_closed: 'Регистрация закрыта владельцем',
  too_many_attempts: 'Слишком много попыток — подождите пару минут',
  wrong_password: 'Текущий пароль указан неверно',
  google_in_use: 'Этот Google-аккаунт уже привязан к другому пользователю',
  need_password: 'Сначала задайте логин и пароль — иначе вы не сможете войти',
  not_allowed: 'Этому аккаунту вход не разрешён',
  auth_failed: 'Сервер отклонил логин или пароль',
  unreachable: 'Телевизор не может достучаться до сервера — проверьте адрес',
  timeout: 'Сервер не ответил вовремя',
  not_subsonic: 'По этому адресу нет Subsonic / Navidrome',
  source_not_found: 'Источник удалён',
  queue_empty: 'Дальше ничего нет',
  no_update: 'Обновлений нет',
  not_supported: 'Обновление доступно только для установленной версии под Windows',
  unsupported_type: 'Такой формат файла не поддерживается',
  too_large: 'Файл слишком большой',
  bad_youtube_link: 'Не похоже на ссылку YouTube',
};
export const errorText = (code?: string) => (code && ERROR_TEXT[code]) || code || 'Ошибка';

// ---------------------------------------------------------------------------
// Socket
// ---------------------------------------------------------------------------

let socket: Socket | null = null;
let linkWaiter: ((token: string) => void) | null = null;

export function getSocket(): Socket | null {
  return socket;
}

export function request<T = unknown>(event: string, data?: unknown, timeoutMs = 25000): Promise<Ack<T>> {
  return new Promise((resolve) => {
    const s = socket;
    if (!s || !s.connected) return resolve({ ok: false, error: 'offline' });
    s.timeout(timeoutMs).emit(event, data ?? {}, (err: Error | null, res: Ack<T>) => {
      if (err) resolve({ ok: false, error: 'tv_timeout' });
      else resolve(res && typeof res === 'object' ? res : { ok: true });
    });
  });
}

/** request() that shows an error toast on failure */
export async function act<T = unknown>(event: string, data?: unknown, okMessage?: string): Promise<Ack<T>> {
  const res = await request<T>(event, data);
  if (!res.ok) toast(errorText(res.error), 'error');
  else if (okMessage) toast(okMessage, 'success');
  return res;
}

function authenticate(): void {
  const token = getToken();
  if (!socket || !token) {
    set({ auth: 'anon' });
    return;
  }
  socket.emit(Events.AUTH, { token }, (res: AuthResult) => {
    if (res?.ok && res.user) {
      set({ auth: 'authed', user: res.user, authError: null, deniedEmail: null, kickedReason: null });
      void request<MusicSource[]>(Events.MUSIC_SOURCES).then((r) => r.ok && set({ musicSources: r.data || [] }));
      if (getPref('bgControl', true)) void startBackgroundControl(get().serverUrl, token);
    } else {
      if (res?.error && res.error !== 'missing_credentials') setToken(null);
      set({ auth: 'anon', user: null, authError: res?.error === 'not_allowed' || res?.error === 'pending_approval' ? res.error : null });
    }
  });
}

export function connect(): void {
  socket?.removeAllListeners();
  socket?.disconnect();
  const url = get().serverUrl;
  const s = io(url, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 4000,
    timeout: 10000,
  });
  socket = s;
  set({ conn: 'connecting' });

  s.on('connect', () => {
    set({ conn: 'online' });
    authenticate();
  });
  s.on('disconnect', () => set({ conn: 'offline' }));
  s.on('connect_error', () => set({ conn: 'offline' }));

  s.on(Events.SYNC, (p: SyncPayload) =>
    set({
      presence: p.presence,
      player: p.player || { ...EMPTY_PLAYER_STATE },
      playerReceivedAt: Date.now(),
      catalog: p.catalog || [],
      torrents: p.torrents || [],
      idle: p.idle,
      admin: p.admin,
    }),
  );
  s.on(Events.PRESENCE, (p: PresenceInfo) => set({ presence: p }));
  s.on(Events.PLAYER_STATE, (p: PlayerState) => {
    const o = get().optimistic;
    set({ player: p, playerReceivedAt: Date.now(), optimistic: o && o.until > Date.now() ? o : null });
  });
  s.on(Events.CATALOG, (c: MediaItem[]) => set({ catalog: c }));
  s.on(Events.TORRENTS, (t: TorrentInfo[]) => set({ torrents: t }));
  s.on(Events.IDLE, (i: IdleSettings) => set({ idle: i }));
  s.on(Events.ADMIN, (a: AdminState) => set({ admin: a }));
  s.on(Events.MUSIC_SOURCES_CHANGED, (m: MusicSource[]) => set({ musicSources: m }));
  s.on(Events.TOAST, (t: { kind?: ToastKind; message: string }) => t?.message && toast(t.message, t.kind || 'info'));
  s.on(Events.ERROR, (e: { message?: string }) => e?.message && toast(e.message, 'error'));
  s.on(Events.KICKED, (e: { reason: string }) => {
    if (e?.reason === 'removed') {
      setToken(null);
      set({ auth: 'anon', user: null, kickedReason: 'Владелец отозвал ваш доступ' });
    }
  });
  s.on(Events.LINK_DONE, (p: { token: string }) => {
    if (p?.token && linkWaiter) linkWaiter(p.token);
  });
}

// Reconnect instantly when the phone wakes up / the app comes back from background.
// A WebView that was frozen often still believes its websocket is open, so after a
// longer pause the socket is re-created instead of waiting for the ping timeout.
let hiddenAt = 0;
export function resumeConnection(force = false): void {
  if (!socket) return;
  const away = hiddenAt ? Date.now() - hiddenAt : 0;
  hiddenAt = 0;
  if (!socket.connected) {
    set({ conn: 'connecting' });
    socket.connect();
  } else if (force || away > 8000) {
    // probe: if the server doesn't answer quickly, reconnect
    let answered = false;
    socket.timeout(2500).emit(Events.PING, {}, () => (answered = true));
    setTimeout(() => {
      if (!answered && socket) {
        set({ conn: 'connecting' });
        socket.disconnect().connect();
      }
    }, 2600);
  }
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else resumeConnection();
  });
  window.addEventListener('online', () => resumeConnection(true));
  window.addEventListener('focus', () => resumeConnection());
  window.addEventListener('pageshow', () => resumeConnection());
  // Capacitor (Android app) lifecycle events
  for (const target of [document, window] as EventTarget[]) {
    target.addEventListener('pause', () => (hiddenAt = Date.now()));
    target.addEventListener('resume', () => resumeConnection(true));
  }
}

// ---------------------------------------------------------------------------
// Auth actions
// ---------------------------------------------------------------------------

export async function signInWithGoogle(credential: string): Promise<void> {
  try {
    const res = await fetch(`${get().serverUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    const body = (await res.json()) as { ok: boolean; token?: string; error?: string; email?: string };
    if (!body.ok || !body.token) {
      set({ authError: body.error || 'error', deniedEmail: body.email || null, auth: 'anon' });
      return;
    }
    setToken(body.token);
    set({ auth: 'unknown', authError: null, deniedEmail: null });
    authenticate();
  } catch {
    set({ authError: 'network' });
  }
}

async function postAuth(path: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${get().serverUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const out = (await res.json()) as { ok: boolean; token?: string; error?: string };
    if (!out.ok || !out.token) {
      set({ authError: out.error || 'error', auth: 'anon' });
      return false;
    }
    setToken(out.token);
    set({ auth: 'unknown', authError: null, deniedEmail: null, kickedReason: null });
    authenticate();
    return true;
  } catch {
    set({ authError: 'network' });
    return false;
  }
}

export const signInWithPassword = (username: string, password: string) => postAuth('/api/auth/login', { username, password });
export const registerAccount = (username: string, password: string, name?: string) => postAuth('/api/auth/register', { username, password, name });
export const clearAuthError = () => set({ authError: null, deniedEmail: null });

/** Authenticated REST call to the backend. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    const res = await fetch(`${get().serverUrl}${path}`, {
      method: init.method || (init.body !== undefined ? 'POST' : 'GET'),
      headers: { Authorization: `Bearer ${getToken() || ''}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    return (await res.json()) as { ok: boolean; data?: T; error?: string };
  } catch {
    return { ok: false, error: 'offline' };
  }
}

export function signInWithToken(token: string): void {
  setToken(token);
  set({ auth: 'unknown' });
  authenticate();
}

export function signOut(): void {
  void stopBackgroundControl();
  setToken(null);
  set({ auth: 'anon', user: null, admin: null, musicSources: null });
  connect();
}

export function changeServer(url: string | null): void {
  setServerUrl(url);
  set({ serverUrl: getServerUrl() });
  connect();
}

/** Start the "link this device" flow (used by the APK, where Google sign-in can't run in a WebView). */
export async function startDeviceLink(name: string): Promise<LinkStartResult> {
  const s = socket;
  if (!s?.connected) return { ok: false, error: 'offline' };
  return new Promise((resolve) => {
    linkWaiter = (token) => {
      linkWaiter = null;
      signInWithToken(token);
    };
    s.emit(Events.LINK_START, { kind: 'remote', name }, (res: LinkStartResult) => resolve(res));
  });
}

// ---------------------------------------------------------------------------
// Player helpers (optimistic UI)
// ---------------------------------------------------------------------------

function optimistic(patch: Omit<Optimistic, 'until'>, ms = 1500): void {
  set((s) => ({ optimistic: { ...(s.optimistic && s.optimistic.until > Date.now() ? s.optimistic : {}), ...patch, until: Date.now() + ms } }));
}

export function effectivePlayer(s: StoreState): PlayerState {
  const o = s.optimistic;
  if (!o || o.until < Date.now()) return s.player;
  return {
    ...s.player,
    ...(o.status ? { status: o.status } : {}),
    ...(o.position !== undefined ? { position: o.position } : {}),
    ...(o.volume !== undefined ? { volume: o.volume } : {}),
    ...(o.muted !== undefined ? { muted: o.muted } : {}),
  };
}

export async function control(cmd: ControlCommand): Promise<boolean> {
  const p = effectivePlayer(get());
  switch (cmd.type) {
    case 'PLAY_PAUSE':
      if (p.status === 'playing' || p.status === 'paused') optimistic({ status: p.status === 'playing' ? 'paused' : 'playing', position: livePosition(get()) });
      break;
    case 'SEEK':
      optimistic({ position: cmd.position });
      break;
    case 'SEEK_RELATIVE':
      optimistic({ position: Math.max(0, Math.min(p.duration || Infinity, livePosition(get()) + cmd.delta)) });
      break;
    case 'VOLUME':
      optimistic({ volume: cmd.volume, muted: false }, 2500);
      break;
    case 'VOLUME_STEP':
      optimistic({ volume: Math.max(0, Math.min(1, p.volume + cmd.delta)), muted: false }, 2500);
      break;
    case 'MUTE':
      optimistic({ muted: cmd.muted ?? !p.muted });
      break;
  }
  const res = await request(Events.CONTROL, cmd);
  if (!res.ok) {
    set({ optimistic: null });
    toast(errorText(res.error), 'error');
  }
  return res.ok;
}

/** Position interpolated since the last state update. */
export function livePosition(s: StoreState): number {
  const p = effectivePlayer(s);
  const o = s.optimistic;
  if (o && o.until > Date.now() && o.position !== undefined) return o.position;
  if (p.status !== 'playing') return p.position;
  const elapsed = (Date.now() - s.playerReceivedAt) / 1000;
  const pos = p.position + elapsed;
  return p.duration > 0 ? Math.min(pos, p.duration) : pos;
}

export const isOwner = (s: StoreState) => s.user?.role === 'owner';
