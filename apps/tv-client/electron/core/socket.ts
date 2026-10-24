import { io, type Socket } from 'socket.io-client';
import {
  Events,
  type ControlCommand,
  type PlayerState,
  type MediaItem,
  type TorrentInfo,
  type FsListResult,
  type SignalMessage,
  type WidgetConfig,
  type IdleSettings,
} from '@tvbox/shared';
import type { TvClientConfig } from './config';

export interface TvSocketHandlers {
  onControl: (cmd: ControlCommand) => void;
  onCatalogGet: () => void;
  onTorrentAdd: (payload: { magnet?: string; torrentBuffer?: string; name?: string }) => void;
  onTorrentRemove: (payload: { torrentId: string }) => void;
  onTorrentWatch: (payload: { torrentId: string; fileIndex?: number }) => void;
  onTorrentsGet: () => void;
  onFileDelete: (payload: { mediaId: string; fileId?: string }) => void;
  onMetadataUpdate: (payload: import('@tvbox/shared').MetadataUpdatePayload) => void;
  onFsList: (payload: { path?: string }) => void;
  onWidgetsGet: () => void;
  onWidgetsUpdate: (payload: { widgets: WidgetConfig[]; settings?: Partial<IdleSettings> }) => void;
  onPower: (payload: { action: 'sleep' | 'shutdown' | 'reboot' }) => void;
  onSignal: (event: string, msg: SignalMessage) => void;
}

export class TvSocketClient {
  private socket: Socket | null = null;
  private connected = false;

  constructor(
    private readonly config: TvClientConfig,
    private readonly handlers: TvSocketHandlers,
  ) {}

  connect(): void {
    this.socket = io(this.config.backendUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
    });
    const s = this.socket;

    s.on('connect', () => {
      this.connected = true;
      s.emit(Events.AUTH, { deviceToken: this.config.deviceToken });
    });
    s.on('disconnect', () => {
      this.connected = false;
    });
    s.on(Events.AUTH_RESULT, (res: { ok: boolean; error?: string }) => {
      if (!res.ok) console.error('[tv-client] auth failed:', res.error);
    });

    s.on(Events.CONTROL, (cmd: ControlCommand) => this.handlers.onControl(cmd));
    s.on(Events.CATALOG_GET, () => this.handlers.onCatalogGet());
    s.on(Events.TORRENT_ADD, (p) => this.handlers.onTorrentAdd(p ?? {}));
    s.on(Events.TORRENT_REMOVE, (p) => this.handlers.onTorrentRemove(p ?? {}));
    s.on(Events.TORRENT_WATCH, (p) => this.handlers.onTorrentWatch(p ?? {}));
    s.on(Events.TORRENTS_GET, () => this.handlers.onTorrentsGet());
    s.on(Events.FILE_DELETE, (p) => this.handlers.onFileDelete(p ?? {}));
    s.on(Events.METADATA_UPDATE, (p) => this.handlers.onMetadataUpdate(p ?? {}));
    s.on(Events.FS_LIST, (p) => this.handlers.onFsList(p ?? {}));
    s.on(Events.WIDGETS_GET, () => this.handlers.onWidgetsGet());
    s.on(Events.WIDGETS_UPDATE, (p) => this.handlers.onWidgetsUpdate(p ?? { widgets: [] }));
    s.on(Events.IDLE_SETTINGS_UPDATE, (p) => this.handlers.onWidgetsUpdate(p ?? { widgets: [] }));
    s.on(Events.POWER, (p) => this.handlers.onPower(p ?? { action: 'sleep' }));

    for (const evt of [Events.WEBRTC_OFFER, Events.WEBRTC_ANSWER, Events.WEBRTC_ICE, Events.WEBRTC_LEAVE]) {
      s.on(evt, (msg: SignalMessage) => this.handlers.onSignal(evt, msg));
    }
  }

  emitState(state: PlayerState): void {
    this.socket?.emit(Events.PLAYER_STATE, state);
  }
  emitCatalog(items: MediaItem[]): void {
    this.socket?.emit(Events.CATALOG, items);
  }
  emitCatalogUpdate(item: MediaItem): void {
    this.socket?.emit(Events.CATALOG_UPDATE, item);
  }
  emitTorrentList(items: TorrentInfo[]): void {
    this.socket?.emit(Events.TORRENT_LIST, items);
  }
  emitTorrentProgress(info: TorrentInfo): void {
    this.socket?.emit(Events.TORRENT_PROGRESS, info);
  }
  emitFsResult(result: FsListResult): void {
    this.socket?.emit(Events.FS_LIST_RESULT, result);
  }
  emitWidgetsResult(widgets: WidgetConfig[], settings: IdleSettings): void {
    this.socket?.emit(Events.WIDGETS_RESULT, { widgets, settings });
  }
  emitSignal(event: string, msg: SignalMessage): void {
    this.socket?.emit(event, msg);
  }
  isConnected(): boolean {
    return this.connected;
  }
}
