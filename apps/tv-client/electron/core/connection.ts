import { EventEmitter } from 'node:events';
import { io, type Socket } from 'socket.io-client';
import { app } from 'electron';
import { Events, type Ack, type AuthResult, type LinkStartResult } from '@tvbox/shared';
import type { ConfigStore } from './config';
import type { ConnState, IceServerLike, TvStatus } from '../../src/bridge';

type Handler = (data: Record<string, unknown>) => Promise<Ack<unknown>> | Ack<unknown>;

/**
 * Socket.io link to the backend.
 * Unpaired TV → asks for a link code (shown as QR on screen) → owner approves → session token.
 */
export class Connection extends EventEmitter {
  private socket: Socket | null = null;
  private handlers = new Map<string, Handler>();
  private pairTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  state: ConnState = 'connecting';
  pairing: TvStatus['pairing'] = null;
  publicUrl = '';
  error: string | undefined;

  constructor(private readonly config: ConfigStore) {
    super();
  }

  status(): TvStatus {
    return {
      conn: this.state,
      serverUrl: this.config.value.serverUrl,
      publicUrl: this.publicUrl || this.config.value.serverUrl,
      tvName: this.config.value.tvName,
      pairing: this.pairing,
      paired: Boolean(this.config.value.token),
      error: this.error,
    };
  }

  private setState(s: ConnState, error?: string): void {
    this.state = s;
    this.error = error;
    this.emit('status', this.status());
  }

  /** Register a request handler; the result is sent back as the socket.io ack. */
  handle(event: string, handler: Handler): void {
    this.handlers.set(event, handler);
    this.socket?.on(event, this.wrap(event, handler));
  }

  private wrap(event: string, handler: Handler) {
    return async (data: unknown, ack?: (res: unknown) => void) => {
      let res: Ack<unknown>;
      try {
        res = await handler((data && typeof data === 'object' ? data : {}) as Record<string, unknown>);
      } catch (e) {
        console.error(`[tv] handler ${event} failed`, e);
        res = { ok: false, error: (e as Error).message || 'error' };
      }
      if (typeof ack === 'function') ack(res);
    };
  }

  start(): void {
    this.stop();
    const url = this.config.value.serverUrl;
    this.setState('connecting');
    const s = io(url, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      timeout: 15000,
    });
    this.socket = s;
    void this.fetchPublicUrl();

    for (const [evt, h] of this.handlers) s.on(evt, this.wrap(evt, h));
    // a remote newer than this TV client: answer instead of letting it wait for a timeout
    s.onAny((event: string, ...args: unknown[]) => {
      if (this.handlers.has(event)) return;
      const ack = args[args.length - 1];
      if (typeof ack === 'function') (ack as (r: unknown) => void)({ ok: false, error: 'tv_outdated' });
    });

    s.on('connect', () => this.authenticate());
    s.on('disconnect', (reason) => {
      if (this.state !== 'replaced') this.setState('offline');
      if (reason === 'io server disconnect' && this.state !== 'replaced') {
        this.retryTimer = setTimeout(() => s.connect(), 2000);
      }
    });
    s.on('connect_error', () => {
      if (this.state !== 'pairing') this.setState('offline', 'Сервер недоступен');
    });
    s.on(Events.LINK_DONE, (p: { token?: string }) => {
      if (!p?.token) return;
      this.config.update({ token: p.token });
      this.pairing = null;
      this.authenticate();
    });
    s.on(Events.KICKED, (p: { reason?: string }) => {
      if (p?.reason === 'unpaired') {
        this.config.update({ token: '' });
        setTimeout(() => this.socket?.connect(), 500);
      } else if (p?.reason === 'replaced') {
        this.setState('replaced', 'К серверу подключился другой телевизор');
        this.retryTimer = setTimeout(() => {
          this.state = 'connecting';
          this.socket?.connect();
        }, 60000);
      }
    });
  }

  private authenticate(): void {
    const s = this.socket;
    if (!s) return;
    const token = this.config.value.token;
    if (!token) {
      void this.startPairing();
      return;
    }
    s.emit(Events.AUTH, { token, version: app.getVersion() }, (res: AuthResult) => {
      if (res?.ok && res.isTv) {
        this.pairing = null;
        if (this.pairTimer) clearTimeout(this.pairTimer);
        this.setState('online');
        this.emit('online');
      } else if (res?.error === 'invalid_token' || res?.error === 'tv_unpaired' || (res?.ok && !res.isTv)) {
        this.config.update({ token: '' });
        void this.startPairing();
      } else {
        this.setState('offline', res?.error);
      }
    });
  }

  private startPairing(): void {
    const s = this.socket;
    if (!s?.connected) return;
    if (this.pairTimer) clearTimeout(this.pairTimer);
    s.emit(Events.LINK_START, { kind: 'tv', name: this.config.value.tvName }, (res: LinkStartResult) => {
      if (!res?.ok || !res.code || !res.url) {
        this.setState('offline', 'Не удалось получить код подключения');
        this.pairTimer = setTimeout(() => this.startPairing(), 10000);
        return;
      }
      this.pairing = { code: res.code, url: res.url, expiresAt: res.expiresAt || Date.now() + 600000 };
      this.setState('pairing');
      // refresh the code shortly before it expires
      this.pairTimer = setTimeout(() => this.startPairing(), Math.max(30000, this.pairing.expiresAt - Date.now() - 30000));
    });
  }

  private async fetchPublicUrl(): Promise<void> {
    try {
      const res = await fetch(`${this.config.value.serverUrl}/api/config`);
      const body = (await res.json()) as { publicUrl?: string };
      if (body.publicUrl) {
        this.publicUrl = body.publicUrl;
        this.emit('status', this.status());
      }
    } catch {
      // ignore
    }
  }

  async iceServers(): Promise<IceServerLike[]> {
    const fallback: IceServerLike[] = [{ urls: ['stun:stun.l.google.com:19302'] }];
    try {
      const res = await fetch(`${this.config.value.serverUrl}/api/ice`, {
        headers: { Authorization: `Bearer ${this.config.value.token}` },
      });
      const body = (await res.json()) as { ok: boolean; iceServers?: IceServerLike[] };
      return body.ok && body.iceServers?.length ? body.iceServers : fallback;
    } catch {
      return fallback;
    }
  }

  get online(): boolean {
    return this.state === 'online' && !!this.socket?.connected;
  }

  emitEvent(event: string, data: unknown): void {
    if (this.online) this.socket!.emit(event, data);
  }

  stop(): void {
    if (this.pairTimer) clearTimeout(this.pairTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pairing = null;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
  }
}
