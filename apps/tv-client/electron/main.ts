import { app, BrowserWindow, ipcMain, powerSaveBlocker, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_IDLE_SETTINGS,
  Events,
  WEBRTC_EVENTS,
  type Ack,
  type ControlCommand,
  type IdleSettings,
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
import { YouTubeController } from './core/youtube';
import { MusicService, registerMusicRoutes } from './core/music';
import { Updater } from './core/updater';
import { Uploads } from './core/uploads';
import { sendFile } from './core/media-server';
import type { CastState, RendererReport } from '../src/bridge';

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
  const youtube = new YouTubeController(() => win);
  const music = new MusicService(db, dataDir());
  registerMusicRoutes(server, music);
  const uploads = new Uploads(dataDir());
  server.route('/screensaver-file', (req, res, url) => {
    const p = uploads.resolve(url.searchParams.get('n') || '');
    if (!p) return void res.writeHead(404).end();
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
  });

  const getIdle = (): IdleSettings => ({ ...DEFAULT_IDLE_SETTINGS, ...(db.getJson<Partial<IdleSettings>>('idle') || {}) });

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
  };

  library.on('changed', pushCatalog);
  library.on('tmdb-error', (msg: string) => toast(msg, 'error'));
  torrents.on('update', (list) => conn.emitEvent(Events.TORRENTS, list));
  torrents.on('done', (_id: string, files: { fullPath: string; name: string; torrentId: string }[]) => {
    for (const f of files) library.addFile(f.fullPath, { origin: 'torrent', torrentId: f.torrentId });
    if (files[0]) toast(`Загрузка завершена: ${files.length > 1 ? `${files.length} файлов` : files[0].name}`, 'success');
  });
  torrents.on('autoplay', (id: string, idx: number) => void player.autoplayTorrent(id, idx));

  let blocker: number | null = null;
  player.on('state', (s) => {
    conn.emitEvent(Events.PLAYER_STATE, s);
    const playing = player.isPlaying;
    if (playing && blocker === null) blocker = powerSaveBlocker.start('prevent-display-sleep');
    if (!playing && blocker !== null) {
      powerSaveBlocker.stop(blocker);
      blocker = null;
    }
  });

  conn.on('status', (s) => send('tv:status', s));
  conn.on('online', pushAll);

  // ------------------------------------------------------------------ remote requests
  const ok = <T>(data?: T): Ack<T> => ({ ok: true, data });

  conn.handle(Events.CONTROL, async (cmd) => player.control(cmd as unknown as ControlCommand));
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
    const { magnet, torrentBase64, torrentPath, play } = p as unknown as TorrentAddPayload;
    let buffer: Buffer | undefined;
    if (torrentBase64) buffer = Buffer.from(torrentBase64, 'base64');
    else if (torrentPath) buffer = await fs.promises.readFile(torrentPath);
    if (!buffer && !(magnet && /^magnet:\?/i.test(magnet))) return { ok: false, error: 'bad_torrent' };
    const id = await torrents.add({ magnet, buffer }, { autoplay: !!play });
    toast(play ? 'Торрент запущен — начнём показ, когда загрузится начало' : 'Торрент добавлен в загрузки', 'info');
    return ok({ id });
  });
  conn.handle(Events.TORRENT_REMOVE, (p) => {
    const id = String(p.torrentId || '');
    const cur = player.currentTorrentFile();
    if (cur?.torrentId === id) player.stop();
    const removed = torrents.remove(id, !!p.deleteFiles);
    if (removed.length) library.removePaths(removed);
    return ok();
  });
  conn.handle(Events.FS_LIST, async (p) => ok(await listDirectory(p.path ? String(p.path) : undefined, config.value.mediaDirs)));
  conn.handle(Events.IDLE_GET, () => ok(getIdle()));
  conn.handle(Events.IDLE_UPDATE, (p) => {
    const { _meta, ...patch } = p as Record<string, unknown>;
    void _meta;
    const next: IdleSettings = { ...getIdle(), ...(patch as Partial<IdleSettings>) };
    db.setJson('idle', next);
    if (Array.isArray(next.screensaverMedia)) {
      uploads.prune(next.screensaverMedia.filter((m) => m.src.startsWith('tvbox-file:')).map((m) => m.src.slice('tvbox-file:'.length)));
    }
    conn.emitEvent(Events.IDLE, next);
    send('tv:idle', next);
    return ok(next);
  });
  const settingsInfo = async (): Promise<TvSettings> => ({
    ...config.settings(),
    youtubeSignedIn: await youtube.signedIn().catch(() => false),
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
  conn.handle(Events.YOUTUBE_LOGIN, () => {
    player.stop();
    youtube.login();
    toast('Войдите в аккаунт YouTube на экране телевизора (клавиатура и мышь). Esc — отмена.', 'info');
    return ok();
  });
  conn.handle(Events.YOUTUBE_LOGOUT, async () => {
    await youtube.logout();
    return ok(await settingsInfo());
  });
  youtube.on('signed-in', () => toast('YouTube: вход выполнен', 'success'));

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
  conn.handle(Events.UPLOAD_END, (p) => {
    try {
      const f = uploads.end(String(p.uploadId));
      return ok({ src: `tvbox-file:${f.name}`, name: f.name });
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
  torrents.restore();
  void library.scan();
  void volume.refresh().then(() => player.emit('state', player.state()));
  setInterval(() => {
    const before = { ...volume.state };
    void volume.refresh().then((v) => {
      if (v.volume !== before.volume || v.muted !== before.muted) conn.emitEvent(Events.PLAYER_STATE, player.state());
    });
  }, 4000);
  setInterval(() => void library.scan(), 15 * 60 * 1000);
  updater.on('available', (r: { version: string }) => toast(`Доступно обновление TVBox ${r.version} — его можно установить из настроек на пульте`, 'info'));
  setTimeout(() => void updater.check(), 20_000);
  setInterval(() => void updater.check(), 6 * 60 * 60 * 1000);

  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    player.stop();
    conn.stop();
    volume.dispose();
    server.close();
    db.close();
    void torrents.destroy().finally(() => app.exit(0));
  });
  app.on('window-all-closed', () => app.quit());
}
