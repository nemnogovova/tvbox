import { app, BrowserWindow, ipcMain, powerSaveBlocker, screen, session, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_IDLE_SETTINGS,
  Events,
  WEBRTC_EVENTS,
  type Ack,
  type ControlCommand,
  type IdleSettings,
  type IndexerSettings,
  type InputEvent,
  type NavKey,
  type TorrentMeta,
  type MediaApplyTmdbPayload,
  type MediaUpdatePayload,
  type MusicSourceAddPayload,
  type MusicView,
  type PowerAction,
  type SignalMessage,
  type TorrentAddPayload,
  type TvSettings,
} from '@tvbox/shared';
import { ConfigStore, dataDir } from './core/config';
import { TvDatabase } from './core/db';
import { TmdbClient } from './core/tmdb';
import { TorrentEngine } from './core/torrents';
import { Library } from './core/library';
import { startMediaServer, type MediaServer } from './core/media-server';
import { SystemVolume, powerAction } from './core/system';
import { Connection } from './core/connection';
import { PlayerController } from './core/player';
import { listDirectory } from './core/filesystem';
import { AD_HOSTS, YouTubeController, navKeyFromKeyboard } from './core/youtube';
import { MusicService, registerMusicRoutes } from './core/music';
import { Updater } from './core/updater';
import { Uploads } from './core/uploads';
import { Previews } from './core/previews';
import { sendFile } from './core/media-server';
import { DesktopHelper } from './core/desktop';
import { AppLauncher } from './core/apps';
import { CursorHider } from './core/cursor';
import { CatalogService } from './core/catalog';
import { IndexerClient } from './core/indexer';
import type { CastState, RendererReport } from '../src/bridge';

import { installFileLog } from './core/log';

installFileLog(dataDir());
process.on('uncaughtException', (err) => console.error('[tv] uncaught', err));
process.on('unhandledRejection', (err) => console.error('[tv] unhandled', err));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('enable-blink-features', 'AudioVideoTracks');
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}

let win: BrowserWindow | null = null;

function send(channel: string, payload?: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

async function main(): Promise<void> {
  await app.whenReady();
  console.log(`[tv] TVBox ${app.getVersion()} starting (${process.platform}, Electron ${process.versions.electron})`);

  const config = new ConfigStore();
  const db = await TvDatabase.open(dataDir());
  const tmdb = new TmdbClient(config.value.tmdbApiKey, config.value.language);
  const torrents = new TorrentEngine(db, () => {
    fs.mkdirSync(config.value.downloadDir, { recursive: true });
    return config.value.downloadDir;
  });
  const library = new Library(db, tmdb, () => [...config.value.mediaDirs, config.value.downloadDir]);
  const rendererDir = path.join(__dirname, '..', 'dist');
  const server: MediaServer = await startMediaServer(torrents, fs.existsSync(rendererDir) ? rendererDir : null, 8765);
  const volume = new SystemVolume();
  const conn = new Connection(config);
  const youtube = new YouTubeController(() => win, db);
  // YouTube videos in the screensaver play in the TVBox page itself: no ads there either
  session.defaultSession.webRequest.onBeforeRequest({ urls: AD_HOSTS }, (_d, cb) => cb({ cancel: true }));
  const desktop = new DesktopHelper();
  const catalog = new CatalogService(tmdb, () => library.list());
  const indexer = new IndexerClient(() => config.value.indexer);
  // catalog info of torrents started from the catalog (title, poster, TMDb id)
  const torrentMeta = new Map<string, TorrentMeta>(Object.entries(db.getJson<Record<string, TorrentMeta>>('torrent:meta') || {}));
  const saveTorrentMeta = () => db.setJson('torrent:meta', Object.fromEntries(torrentMeta));
  const music = new MusicService(db, dataDir());
  registerMusicRoutes(server, music);
  const uploads = new Uploads(dataDir());
  const previews = new Previews(dataDir(), (n) => uploads.resolve(n));
  /** Size pictures are shown at: the TV's screen in physical pixels (at most 4K). */
  const screenPixels = () => {
    const d = screen.getPrimaryDisplay();
    const w = Math.round(d.size.width * d.scaleFactor);
    const h = Math.round(d.size.height * d.scaleFactor);
    const k = Math.min(1, 3840 / Math.max(w, 1), 2160 / Math.max(h, 1));
    return { w: Math.max(640, Math.round(w * k)), h: Math.max(360, Math.round(h * k)) };
  };
  server.route('/screensaver-file', async (req, res, url) => {
    const name = url.searchParams.get('n') || '';
    const p = uploads.resolve(name);
    if (!p) return void res.writeHead(404).end();
    // ?v=display: a copy at the screen's size (huge photos decode in an instant instead of seconds)
    if (url.searchParams.get('v') === 'display') {
      const { w, h } = screenPixels();
      const d = await previews.display(name, w, h).catch(() => null);
      if (d) return sendFile(req, res, d);
    }
    sendFile(req, res, p);
  });
  const updater = new Updater(() => config.value.serverUrl);

  const player = new PlayerController({
    library,
    torrents,
    server,
    volume,
    youtube,
    music,
    send,
    setFullscreen: (v) => {
      if (!win) return true;
      const next = v ?? !win.isFullScreen();
      win.setFullScreen(next);
      return next;
    },
    torrentMeta: (id) => torrentMeta.get(id.toLowerCase()),
  });

  // ------------------------------------------------------------------ app launcher
  const nativeHwnd = (): string | null => {
    if (!win || win.isDestroyed()) return null;
    const b = win.getNativeWindowHandle();
    return b.length >= 8 ? b.readBigUInt64LE(0).toString() : b.readUInt32LE(0).toString();
  };
  let wasFullscreen = true;
  const showTvbox = () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    if (wasFullscreen && !win.isFullScreen()) win.setFullScreen(true);
    win.show();
    win.focus();
  };
  const apps = new AppLauncher(desktop, db, nativeHwnd, showTvbox);
  apps.on('hide-tvbox', () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    // a program goes full screen on the TV: pause what TVBox was playing and step aside
    if (player.isPlaying) void player.control({ type: 'PAUSE' });
    wasFullscreen = win.isFullScreen();
    win.minimize();
  });
  apps.on('launching', (a: { name: string; icon?: string }) => send('tv:launching', a));
  apps.on('launched', () => send('tv:launching', null));
  apps.on('launch-failed', (name: string) => {
    send('tv:launching', null);
    toast(`«${name}» не открылся`, 'warning');
  });

  // ------------------------------------------------------------------ cursor
  const tvboxInFront = () => {
    if (!win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return false;
    return apps.available ? apps.getState().tvboxForeground || win.isFocused() : true;
  };
  const cursor = new CursorHider(
    () => win,
    () => [win?.webContents, youtube.webContents].filter((x): x is WebContents => !!x && !x.isDestroyed()),
    tvboxInFront,
    () => send('tv:activity'),
  );
  youtube.on('attached', () => cursor.nudge());

  const getIdle = (): IdleSettings => ({ ...DEFAULT_IDLE_SETTINGS, ...(db.getJson<Partial<IdleSettings>>('idle') || {}) });
  /** Uploaded files the idle screen uses (screensaver media + home background). */
  const idleFiles = (idle: IdleSettings): string[] =>
    [...(idle.screensaverMedia || []).map((m) => m.src), idle.wallpaper || '']
      .filter((src) => src.startsWith('tvbox-file:'))
      .map((src) => src.slice('tvbox-file:'.length));

  const applyAutostart = () => {
    if (!app.isPackaged) return;
    app.setLoginItemSettings({ openAtLogin: config.value.autostart, args: ['--autostart'] });
  };
  applyAutostart();

  // ------------------------------------------------------------------ broadcasting
  const pushCatalog = () => {
    const list = library.list();
    conn.emitEvent(Events.CATALOG, list);
    send('tv:catalog', list);
  };
  const pushAll = () => {
    pushCatalog();
    conn.emitEvent(Events.TORRENTS, torrents.list());
    conn.emitEvent(Events.IDLE, getIdle());
    conn.emitEvent(Events.PLAYER_STATE, player.state());
  };
  const toast = (message: string, kind: 'info' | 'success' | 'warning' | 'error' = 'info') => {
    conn.emitEvent(Events.TOAST, { message, kind });
    send('tv:toast', { message, kind });
    youtube.toast(message);
  };

  player.notify = (message, kind) => toast(message, kind);
  library.on('changed', pushCatalog);
  library.on('tmdb-error', (msg: string) => toast(msg, 'error'));
  torrents.on('update', (list) => conn.emitEvent(Events.TORRENTS, list));
  torrents.on('done', (_id: string, files: { fullPath: string; name: string; torrentId: string }[]) => {
    for (const f of files) {
      const item = library.addFile(f.fullPath, { origin: 'torrent', torrentId: f.torrentId });
      const meta = torrentMeta.get(f.torrentId.toLowerCase());
      // started from the catalog: we know exactly what it is
      if (item && meta && item.tmdbId !== meta.tmdbId && (item.kind === 'movie' || item.kind === 'episode')) {
        void library.applyTmdb(item.id, meta.tmdbId, meta.type, false).catch(() => undefined);
      }
    }
    if (files[0]) toast(`Загрузка завершена: ${files.length > 1 ? `${files.length} файлов` : files[0].name}`, 'success');
  });
  torrents.on('autoplay', (id: string, idx: number) => void player.autoplayTorrent(id, idx));

  let blocker: number | null = null;
  player.on('state', (s) => {
    conn.emitEvent(Events.PLAYER_STATE, s);
    torrents.setPlaybackActive(player.mediaActive);
    const playing = player.isPlaying;
    if (playing && blocker === null) blocker = powerSaveBlocker.start('prevent-display-sleep');
    if (!playing && blocker !== null) {
      powerSaveBlocker.stop(blocker);
      blocker = null;
    }
  });

  conn.on('status', (s) => send('tv:status', s));
  conn.on('online', () => {
    pushAll();
    conn.emitEvent(Events.APPS_STATE, apps.getState());
    conn.emitEvent(Events.YOUTUBE_STATE, youtube.state);
  });
  apps.on('state', (st) => conn.emitEvent(Events.APPS_STATE, st));
  youtube.on('state', (st) => conn.emitEvent(Events.YOUTUBE_STATE, st));

  // ------------------------------------------------------------------ remote requests
  const ok = <T>(data?: T): Ack<T> => ({ ok: true, data });

  /** D-pad from the remote: YouTube, the program in front, or TVBox's own player. */
  const nav = (key: NavKey): Ack<unknown> => {
    if (apps.appInFront && !win?.isFocused()) {
      if (key === 'home') {
        void apps.focus('tvbox');
        return ok();
      }
      const map: Record<NavKey, string> = {
        up: 'up',
        down: 'down',
        left: 'left',
        right: 'right',
        enter: 'enter',
        back: 'escape',
        backspace: 'backspace',
        playpause: 'playpause',
        home: 'escape',
        search: 'f',
      };
      desktop.key(map[key], key === 'search' ? ['ctrl'] : []);
      return ok();
    }
    cursor.nudge();
    if (player.youtubeOpen) {
      youtube.nav(key);
      return ok();
    }
    const cmd: ControlCommand | null =
      key === 'enter' || key === 'playpause'
        ? { type: 'PLAY_PAUSE' }
        : key === 'left'
          ? { type: 'SEEK_RELATIVE', delta: -10 }
          : key === 'right'
            ? { type: 'SEEK_RELATIVE', delta: 10 }
            : key === 'up'
              ? { type: 'VOLUME_STEP', delta: 0.05 }
              : key === 'down'
                ? { type: 'VOLUME_STEP', delta: -0.05 }
                : key === 'back' || key === 'home'
                  ? { type: 'STOP' }
                  : null;
    if (cmd) void player.control(cmd);
    return ok();
  };
  conn.handle(Events.CONTROL, async (raw) => {
    const cmd = raw as unknown as ControlCommand;
    if (cmd.type === 'NAV') return nav(cmd.key);
    if (cmd.type === 'TEXT') {
      const text = String(cmd.text || '').slice(0, 2000);
      if (apps.appInFront && !win?.isFocused()) desktop.text(text);
      else if (player.youtubeOpen) youtube.type(text);
      else return { ok: false, error: 'nothing_to_type_into' };
      return ok();
    }
    return player.control(cmd);
  });
  conn.handle(Events.CATALOG_GET, () => {
    const list = library.list();
    conn.emitEvent(Events.CATALOG, list);
    return ok(list);
  });
  conn.handle(Events.MEDIA_UPDATE, (p) => {
    const { mediaId, patch } = p as unknown as MediaUpdatePayload;
    return ok(library.update(mediaId, patch || {}));
  });
  conn.handle(Events.MEDIA_DELETE, async (p) => {
    const id = String(p.mediaId || '');
    if (player.state().mediaId === id) player.stop();
    await library.delete(id);
    return ok();
  });
  conn.handle(Events.TMDB_SEARCH, async (p) => {
    if (!tmdb.enabled) return { ok: false, error: 'no_tmdb_key' };
    return ok(await tmdb.search(String(p.query || ''), p.type === 'tv' ? 'tv' : 'movie'));
  });
  conn.handle(Events.MEDIA_APPLY_TMDB, async (p) => {
    const { mediaId, tmdbId, type, wholeShow } = p as unknown as MediaApplyTmdbPayload;
    await library.applyTmdb(mediaId, Number(tmdbId), type === 'tv' ? 'tv' : 'movie', !!wholeShow);
    return ok();
  });
  conn.handle(Events.LIBRARY_RESCAN, () => {
    void library.scan().then(() => library.retryTmdb());
    return ok();
  });
  conn.handle(Events.TORRENT_ADD, async (p) => {
    const { torrentBase64, torrentPath, play, link, meta } = p as unknown as TorrentAddPayload;
    let { magnet } = p as unknown as TorrentAddPayload;
    let buffer: Buffer | undefined;
    if (torrentBase64) buffer = Buffer.from(torrentBase64, 'base64');
    else if (torrentPath) buffer = await fs.promises.readFile(torrentPath);
    else if (link && !magnet) {
      try {
        const r = await indexer.resolveLink(String(link));
        magnet = r.magnet;
        buffer = r.buffer;
      } catch (e) {
        return { ok: false, error: (e as Error).message || 'download_failed' };
      }
    }
    if (!buffer && !(magnet && /^magnet:\?/i.test(magnet))) return { ok: false, error: 'bad_torrent' };
    const id = await torrents.add({ magnet, buffer }, { autoplay: !!play });
    if (meta && typeof meta === 'object' && Number(meta.tmdbId)) {
      torrentMeta.set(id.toLowerCase(), {
        tmdbId: Number(meta.tmdbId),
        type: meta.type === 'tv' ? 'tv' : 'movie',
        title: String(meta.title || '').slice(0, 200),
        year: Number(meta.year) || undefined,
        poster: typeof meta.poster === 'string' ? meta.poster : undefined,
        backdrop: typeof meta.backdrop === 'string' ? meta.backdrop : undefined,
      });
      saveTorrentMeta();
    }
    toast(play ? 'Торрент запущен — начнём показ, когда загрузится начало' : 'Торрент добавлен в загрузки', 'info');
    return ok({ id });
  });
  conn.handle(Events.TORRENT_REMOVE, (p) => {
    const id = String(p.torrentId || '');
    const cur = player.currentTorrentFile();
    if (cur?.torrentId === id) player.stop();
    const playingId = player.state().mediaId;
    const playingItem = playingId ? library.get(playingId) : undefined;
    const removed = torrents.remove(id, !!p.deleteFiles);
    // its file was being watched from the library: stop before it disappears
    if (playingItem && removed.some((f) => path.resolve(f).toLowerCase() === path.resolve(playingItem.path).toLowerCase())) player.stop();
    if (torrentMeta.delete(id.toLowerCase())) saveTorrentMeta();
    if (removed.length) library.removePaths(removed);
    return ok();
  });
  conn.handle(Events.FS_LIST, async (p) => ok(await listDirectory(p.path ? String(p.path) : undefined, config.value.mediaDirs, p.purpose === 'apps' ? 'apps' : 'media')));
  const publishIdle = (idle: IdleSettings) => {
    conn.emitEvent(Events.IDLE, idle);
    send('tv:idle', idle);
  };
  /**
   * In the background: previews for the remote (files uploaded before previews existed) and
   * screen-sized copies of the pictures, so the screensaver never waits for a huge photo.
   */
  let preparing = false;
  let prepareAgain = false;
  const prepareIdleMedia = async (): Promise<void> => {
    if (preparing) {
      prepareAgain = true;
      return;
    }
    preparing = true;
    try {
      do {
        prepareAgain = false;
        const idle = getIdle();
        const thumbs = new Map<string, string>();
        for (const m of idle.screensaverMedia || []) {
          if (!m.src.startsWith('tvbox-file:') || m.thumb) continue;
          const t = await previews.thumbDataUrl(m.src.slice('tvbox-file:'.length)).catch(() => null);
          if (t) thumbs.set(m.id, t);
        }
        const wall = idle.wallpaper?.startsWith('tvbox-file:') && !idle.wallpaperThumb ? await previews.thumbDataUrl(idle.wallpaper.slice('tvbox-file:'.length)).catch(() => null) : null;
        if (thumbs.size || wall) {
          const cur = getIdle(); // the settings may have changed meanwhile
          const upd: IdleSettings = {
            ...cur,
            screensaverMedia: (cur.screensaverMedia || []).map((m) => (!m.thumb && thumbs.has(m.id) ? { ...m, thumb: thumbs.get(m.id) } : m)),
            ...(wall && cur.wallpaper === idle.wallpaper ? { wallpaperThumb: wall } : {}),
          };
          db.setJson('idle', upd);
          publishIdle(upd);
        }
        const { w, h } = screenPixels();
        for (const n of idleFiles(getIdle())) await previews.display(n, w, h).catch(() => null);
      } while (prepareAgain);
    } finally {
      preparing = false;
    }
  };
  conn.handle(Events.IDLE_GET, () => ok(getIdle()));
  conn.handle(Events.IDLE_UPDATE, (p) => {
    const { _meta, ...patch } = p as Record<string, unknown>;
    void _meta;
    const next: IdleSettings = { ...getIdle(), ...(patch as Partial<IdleSettings>) };
    db.setJson('idle', next);
    const files = idleFiles(next);
    uploads.prune(files);
    previews.prune(files);
    publishIdle(next);
    void prepareIdleMedia();
    return ok(next);
  });
  const settingsInfo = async (): Promise<TvSettings> => ({
    ...config.settings(),
    youtubeSignedIn: await youtube.signedIn().catch(() => false),
    indexerStatus: await indexer.status(false),
    version: app.getVersion(),
  });
  conn.handle(Events.TV_SETTINGS_GET, async () => ok(await settingsInfo()));
  conn.handle(Events.TV_SETTINGS_UPDATE, async (p) => {
    const patch: Partial<TvSettings> = {};
    if (typeof p.tmdbApiKey === 'string') patch.tmdbApiKey = p.tmdbApiKey.trim();
    if (Array.isArray(p.mediaDirs)) patch.mediaDirs = (p.mediaDirs as unknown[]).map(String);
    if (typeof p.downloadDir === 'string' && p.downloadDir.trim()) patch.downloadDir = p.downloadDir.trim();
    if (typeof p.autostart === 'boolean') patch.autostart = p.autostart;
    if (typeof p.language === 'string') patch.language = p.language;
    if (p.indexer === null) patch.indexer = null;
    else if (p.indexer && typeof p.indexer === 'object') {
      const ix = p.indexer as Partial<IndexerSettings>;
      const url = String(ix.url || '').trim().replace(/\/$/, '');
      patch.indexer = url ? { kind: ix.kind === 'prowlarr' ? 'prowlarr' : 'jackett', url: /^https?:\/\//.test(url) ? url : `http://${url}`, apiKey: String(ix.apiKey || '').trim() } : null;
    }
    const before = config.settings();
    config.update(patch);
    tmdb.configure(config.value.tmdbApiKey, config.value.language);
    if (patch.autostart !== undefined) applyAutostart();
    if (patch.mediaDirs || patch.downloadDir) void library.scan();
    if ((patch.tmdbApiKey !== undefined && patch.tmdbApiKey !== before.tmdbApiKey) || (patch.language && patch.language !== before.language)) {
      library.retryTmdb();
    }
    return ok(await settingsInfo());
  });
  conn.handle(Events.POWER, (p) => {
    const action = String(p.action) as PowerAction;
    setTimeout(() => {
      if (action === 'restart-app') {
        app.relaunch();
        app.exit(0);
      } else if (['sleep', 'shutdown', 'reboot'].includes(action)) {
        player.stop();
        void powerAction(action as Exclude<PowerAction, 'restart-app'>).catch((e) => console.error('[tv] power', e));
      }
    }, 400);
    return ok();
  });
  conn.handle(Events.TV_UPDATE, async () => {
    const r = await updater.install();
    if (r.ok) toast('Устанавливаем обновление — TVBox перезапустится', 'info');
    return r;
  });
  conn.handle(Events.YOUTUBE_LOGIN, async () => {
    if (await youtube.signedIn()) return ok({ signedIn: true });
    if (!player.youtubeOpen) player.stop();
    await youtube.login();
    return ok();
  });
  conn.handle(Events.YOUTUBE_OPEN, async (p) => {
    const videoId = typeof p.videoId === 'string' ? p.videoId : undefined;
    const search = typeof p.search === 'string' ? p.search : undefined;
    return player.openYoutube({ videoId, search });
  });
  conn.handle(Events.YOUTUBE_LOGOUT, async () => {
    await youtube.logout();
    return ok(await settingsInfo());
  });
  youtube.on('signed-in', () => toast('YouTube: аккаунт подключён — рекомендации, подписки и история теперь ваши', 'success'));

  // ---- app launcher
  const fail0 = (e: unknown): Ack<never> => ({ ok: false, error: (e as Error).message || 'error' });
  conn.handle(Events.APPS_LIST, async (p) => {
    if (!apps.available) return { ok: false, error: 'not_supported' };
    return ok(await apps.list({ refresh: !!p.refresh, includeHidden: !!p.includeHidden }));
  });
  conn.handle(Events.APPS_LAUNCH, (p) => apps.launch(String(p.id || '')));
  conn.handle(Events.APPS_CLOSE, (p) =>
    apps.close({ hwnd: p.hwnd ? String(p.hwnd) : undefined, appId: p.appId ? String(p.appId) : undefined, force: !!p.force }),
  );
  conn.handle(Events.APPS_FOCUS, (p) => apps.focus(p.tvbox ? 'tvbox' : String(p.hwnd || '')));
  conn.handle(Events.APPS_WINDOW, (p) => apps.windowAction(String(p.hwnd || ''), String(p.action || '')));
  conn.handle(Events.APPS_ADD, async (p) => {
    try {
      return ok(await apps.addCustom(String(p.path || ''), typeof p.name === 'string' ? p.name : undefined));
    } catch (e) {
      return fail0(e);
    }
  });
  conn.handle(Events.APPS_UPDATE, (p) => {
    const r = apps.update(String(p.id || ''), (p.patch || {}) as Record<string, unknown>);
    return r ? ok(r) : { ok: false, error: 'not_found' };
  });
  conn.handle(Events.APPS_REMOVE, (p) => {
    apps.remove(String(p.id || ''));
    return ok();
  });
  // touchpad & keyboard from the remote (no acks, high frequency)
  let inputWarnedAt = 0;
  const mouseScale = () => {
    const d = screen.getPrimaryDisplay();
    return Math.max(1, (d.size.width * d.scaleFactor) / 1280);
  };
  conn.handle(Events.INPUT, (p) => {
    const events = Array.isArray(p.events) ? (p.events as InputEvent[]).slice(0, 200) : [];
    if (!desktop.available) return ok();
    // the helper is broken (policy, antivirus…): say so instead of silently ignoring the touchpad
    if (desktop.failure && Date.now() - inputWarnedAt > 60000) {
      inputWarnedAt = Date.now();
      toast(`Тачпад не работает: ${desktop.failure}`, 'error');
    }
    let dx = 0;
    let dy = 0;
    const flushMove = () => {
      if (dx || dy) desktop.move(dx * mouseScale(), dy * mouseScale());
      dx = 0;
      dy = 0;
    };
    for (const e of events) {
      if (!e || typeof e !== 'object') continue;
      if (e.t === 'move') {
        dx += Number(e.dx) || 0;
        dy += Number(e.dy) || 0;
        continue;
      }
      flushMove();
      if (e.t === 'click') desktop.click(e.b || 'left', !!e.double);
      else if (e.t === 'down') desktop.button(e.b || 'left', true);
      else if (e.t === 'up') desktop.button(e.b || 'left', false);
      else if (e.t === 'scroll') desktop.wheel(Number(e.dy) || 0, Number(e.dx) || 0);
      else if (e.t === 'key') desktop.key(String(e.key || ''), Array.isArray(e.mods) ? e.mods : []);
      else if (e.t === 'text') desktop.text(String(e.text || ''));
    }
    flushMove();
    return ok();
  });

  // ---- catalog & torrent search
  conn.handle(Events.CATALOG_HOME, async () => {
    try {
      const [home, ix] = await Promise.all([catalog.home(), indexer.status(false)]);
      return ok({ ...home, indexer: ix });
    } catch (e) {
      return fail0(e);
    }
  });
  conn.handle(Events.CATALOG_BROWSE, async (p) => {
    try {
      return ok(await catalog.browse(p as never));
    } catch (e) {
      return fail0(e);
    }
  });
  conn.handle(Events.CATALOG_DETAILS, async (p) => {
    try {
      return ok(await catalog.details(Number(p.id), p.type === 'tv' ? 'tv' : 'movie'));
    } catch (e) {
      return fail0(e);
    }
  });
  conn.handle(Events.TORRENT_SEARCH, async (p) => {
    try {
      if (p.tmdbId) {
        const type = p.type === 'tv' ? 'tv' : 'movie';
        const t = await catalog.searchTitles(Number(p.tmdbId), type);
        const season = p.season !== undefined && p.season !== null ? Number(p.season) : undefined;
        return ok(await indexer.search({ titles: t.titles, year: t.year, type, season }));
      }
      return ok(await indexer.search({ query: String(p.query || ''), type: p.type === 'tv' ? 'tv' : 'movie' }));
    } catch (e) {
      return fail0(e);
    }
  });
  conn.handle(Events.INDEXER_TEST, async (p) => {
    const s = p.url ? { kind: p.kind === 'prowlarr' ? 'prowlarr' : 'jackett', url: String(p.url).replace(/\/$/, ''), apiKey: String(p.apiKey || '') } as IndexerSettings : null;
    if (!s) return ok(await indexer.status(true));
    try {
      return ok({ mode: 'configured', kind: s.kind, url: s.url, trackers: await indexer.test(s) });
    } catch (e) {
      return fail0(e);
    }
  });

  // ---- music
  const metaUser = (p: Record<string, unknown>) => {
    const m = p._meta as { user?: { name?: string; email?: string } } | undefined;
    return m?.user?.name || m?.user?.email;
  };
  const fail = (e: unknown): Ack<never> => ({ ok: false, error: (e as Error).message || 'error' });
  conn.handle(Events.MUSIC_SOURCES, () => ok(music.list()));
  conn.handle(Events.MUSIC_SOURCE_ADD, async (p) => {
    try {
      const src = await music.add(p as unknown as MusicSourceAddPayload, metaUser(p));
      conn.emitEvent(Events.MUSIC_SOURCES_CHANGED, music.list());
      return ok(src);
    } catch (e) {
      return fail(e);
    }
  });
  conn.handle(Events.MUSIC_SOURCE_REMOVE, (p) => {
    music.remove(String(p.sourceId || p.id || ''));
    conn.emitEvent(Events.MUSIC_SOURCES_CHANGED, music.list());
    return ok(music.list());
  });
  conn.handle(Events.MUSIC_BROWSE, async (p) => {
    try {
      return ok(await music.browse(String(p.sourceId), String(p.view) as MusicView, Number(p.offset) || 0, Number(p.limit) || 60));
    } catch (e) {
      return fail(e);
    }
  });
  conn.handle(Events.MUSIC_ITEM, async (p) => {
    try {
      const type = p.type === 'artist' || p.type === 'playlist' ? p.type : 'album';
      return ok(await music.item(String(p.sourceId), type, String(p.id)));
    } catch (e) {
      return fail(e);
    }
  });
  conn.handle(Events.MUSIC_SEARCH, async (p) => {
    try {
      return ok(await music.search(String(p.query || ''), p.sourceId ? String(p.sourceId) : undefined));
    } catch (e) {
      return fail(e);
    }
  });
  conn.handle(Events.MUSIC_COVER, async (p) => {
    const url = await music.coverDataUrl(String(p.sourceId || ''), String(p.id || ''));
    return url ? ok(url) : { ok: false, error: 'no_cover' };
  });
  conn.handle(Events.MUSIC_CACHE, (p) => {
    if (p.clear) music.clearCache();
    if (typeof p.limitBytes === 'number') music.setCacheLimit(p.limitBytes);
    return ok(music.cacheInfo());
  });

  // ---- uploads (screensaver media)
  conn.handle(Events.UPLOAD_BEGIN, (p) => {
    try {
      return ok(uploads.begin(String(p.name || ''), Number(p.size) || 0));
    } catch (e) {
      return fail(e);
    }
  });
  conn.handle(Events.UPLOAD_CHUNK, (p) => {
    try {
      return ok({ received: uploads.chunk(String(p.uploadId), Number(p.index), p.data) });
    } catch (e) {
      return fail(e);
    }
  });
  conn.handle(Events.UPLOAD_END, async (p) => {
    try {
      const f = uploads.end(String(p.uploadId));
      // a small preview right away, so the remote shows what was uploaded
      const thumb = (await previews.thumbDataUrl(f.name).catch(() => null)) || undefined;
      return ok({ src: `tvbox-file:${f.name}`, name: f.name, thumb });
    } catch (e) {
      return fail(e);
    }
  });

  for (const evt of WEBRTC_EVENTS) {
    conn.handle(evt, (msg) => {
      send('tv:signal', { event: evt, msg });
      return ok();
    });
  }

  // ------------------------------------------------------------------ renderer IPC
  ipcMain.handle('tv:status', () => conn.status());
  ipcMain.on('tv:launch-cancel', () => send('tv:launching', null));
  ipcMain.handle('tv:catalog', () => library.list());
  ipcMain.handle('tv:idle', () => getIdle());
  ipcMain.handle('tv:ice', () => conn.iceServers());
  ipcMain.handle('tv:setServer', (_e, url: string) => {
    const u = String(url || '').trim();
    if (u) {
      config.update({ serverUrl: /^https?:\/\//.test(u) ? u : `https://${u}`, token: '' });
      conn.start();
    }
    return conn.status();
  });
  ipcMain.on('tv:report', (_e, r: RendererReport) => player.onReport(r));
  ipcMain.on('tv:cast', (_e, s: CastState) => player.onCastState(s));
  ipcMain.on('tv:signal', (_e, p: { event: string; msg: SignalMessage }) => conn.emitEvent(p.event, p.msg));
  ipcMain.on('tv:key', (_e, key: string) => {
    // YouTube is on screen but the keyboard focus stayed on the TVBox page: pass the key on
    if (player.youtubeOpen) {
      const nk = navKeyFromKeyboard(key);
      if (nk) youtube.nav(nk);
      return;
    }
    const map: Record<string, ControlCommand> = {
      ' ': { type: 'PLAY_PAUSE' },
      MediaPlayPause: { type: 'PLAY_PAUSE' },
      Enter: { type: 'PLAY_PAUSE' },
      ArrowLeft: { type: 'SEEK_RELATIVE', delta: -10 },
      ArrowRight: { type: 'SEEK_RELATIVE', delta: 10 },
      MediaTrackPrevious: { type: 'PREVIOUS' },
      MediaTrackNext: { type: 'NEXT' },
      ArrowUp: { type: 'VOLUME_STEP', delta: 0.05 },
      ArrowDown: { type: 'VOLUME_STEP', delta: -0.05 },
      AudioVolumeMute: { type: 'MUTE' },
      m: { type: 'MUTE' },
      Escape: { type: 'STOP' },
      MediaStop: { type: 'STOP' },
      BrowserBack: { type: 'STOP' },
      f: { type: 'FULLSCREEN' },
      F11: { type: 'FULLSCREEN' },
    };
    const cmd = map[key];
    if (cmd) void player.control(cmd);
  });

  // ------------------------------------------------------------------ window
  const createWindow = () => {
    const display = screen.getPrimaryDisplay();
    win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      fullscreen: true,
      frame: false,
      autoHideMenuBar: true,
      backgroundColor: '#05060a',
      title: 'TVBox',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    win.once('ready-to-show', () => win?.show());
    win.on('closed', () => (win = null));
    // keep the TV window on top of everything else
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'q') {
        e.preventDefault();
        app.quit();
      }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const dev = process.env.VITE_DEV_SERVER_URL;
    void win.loadURL(dev || `${server.base}/`);
  };
  createWindow();

  app.on('second-instance', () => {
    if (!win) createWindow();
    else {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  // ------------------------------------------------------------------ start
  conn.start();
  apps.start();
  cursor.start();
  torrents.restore();
  void library.scan();
  setTimeout(() => void prepareIdleMedia(), 15_000);
  void volume.refresh().then(() => player.emit('state', player.state()));
  setInterval(() => {
    const before = { ...volume.state };
    void volume.refresh().then((v) => {
      if (v.volume !== before.volume || v.muted !== before.muted) conn.emitEvent(Events.PLAYER_STATE, player.state());
    });
  }, 4000);
  setInterval(() => void library.scan(), 15 * 60 * 1000);
  // Updates install by themselves as soon as the TV is idle: the TV client must keep up with the
  // server and the remotes (a stale TV ignores new commands from an updated remote).
  const tryAutoUpdate = async () => {
    if (!updater.available || !app.isPackaged) return;
    const busy = player.isPlaying || player.youtubeOpen || apps.appInFront || !!apps.getState().launching;
    if (busy) return;
    console.log(`[tv] auto-update to ${updater.latest?.version}`);
    toast(`Устанавливаем обновление TVBox ${updater.latest?.version} — вернёмся через минуту`, 'info');
    const r = await updater.install();
    if (!r.ok) console.error('[tv] auto-update failed', r.error);
  };
  updater.on('available', () => setTimeout(() => void tryAutoUpdate(), 15_000));
  setTimeout(() => void updater.check(), 20_000);
  setInterval(() => void updater.check(), 30 * 60 * 1000);
  setInterval(() => void tryAutoUpdate(), 2 * 60 * 1000);

  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    player.stop();
    conn.stop();
    cursor.stop();
    apps.dispose();
    volume.dispose();
    server.close();
    db.close();
    void torrents.destroy().finally(() => app.exit(0));
  });
  app.on('window-all-closed', () => app.quit());
}
