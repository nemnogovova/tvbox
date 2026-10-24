import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import type { PlayerState, SignalMessage, IdleSettings, WidgetConfig } from '@tvbox/shared';
import { loadTvConfig } from './core/config';
import { TvDatabase } from './core/db';
import { TmdbClient } from './core/tmdb';
import { TorrentEngine } from './core/torrents';
import { MediaLibrary } from './core/media';
import { createStreamServer } from './core/streaming';
import { TvSocketClient } from './core/socket';
import { listDirectory } from './core/filesystem';
import { powerAction, setSystemMuted, setSystemVolume } from './core/system';

const config = loadTvConfig();
const db = new TvDatabase(config.dataDir);
const tmdb = new TmdbClient(config.tmdbApiKey);
const torrents = new TorrentEngine({ downloadDir: path.join(config.dataDir, 'downloads') });
const media = new MediaLibrary(db, tmdb, torrents, config);
const streamServer = createStreamServer(torrents);
streamServer.listen(config.streamPort);

let mainWindow: BrowserWindow | null = null;

const defaultIdleSettings: IdleSettings = {
  showClock: true,
  showWeather: true,
  showQr: true,
  screensaver: 'black',
  screensaverDelayMs: 5 * 60 * 1000,
  widgets: [
    { id: 'clock', type: 'clock', enabled: true, gridArea: '1 / 1 / 3 / 5' },
    { id: 'qr', type: 'qr', enabled: true, gridArea: '1 / 5 / 3 / 7' },
    { id: 'weather', type: 'weather', enabled: true, gridArea: '3 / 1 / 5 / 3' },
    { id: 'continue', type: 'continue-watching', enabled: true, gridArea: '3 / 3 / 6 / 7' },
  ],
};

function getWidgets(): WidgetConfig[] {
  return db.getWidgets();
}
function getIdleSettings(): IdleSettings {
  return db.getIdleSettings() ?? defaultIdleSettings;
}

const socket = new TvSocketClient(config, {
  onControl: (cmd) => {
    if (cmd.type === 'PLAY_SOURCE') {
      resolveAndPlay(cmd);
    } else if (cmd.type === 'VOLUME') {
      setSystemVolume(cmd.volume);
      mainWindow?.webContents.send('tv:control', cmd);
    } else if (cmd.type === 'MUTE') {
      setSystemMuted(cmd.muted);
      mainWindow?.webContents.send('tv:control', cmd);
    } else {
      mainWindow?.webContents.send('tv:control', cmd);
    }
  },
  onCatalogGet: () => {
    socket.emitCatalog(media.list());
  },
  onTorrentAdd: (payload) => {
    try {
      if (payload.magnet) {
        const handle = torrents.add(payload.magnet);
        torrents.onUpdate(handle.id, (info) => {
          socket.emitTorrentProgress(info);
          if (info.status === 'done') void media.onTorrentDone(handle.id).then(() => socket.emitCatalog(media.list()));
        });
      } else if (payload.torrentBuffer) {
        const buf = Buffer.from(payload.torrentBuffer, 'base64');
        const handle = torrents.addBuffer(buf, payload.name || 'torrent');
        torrents.onUpdate(handle.id, (info) => {
          socket.emitTorrentProgress(info);
          if (info.status === 'done') void media.onTorrentDone(handle.id).then(() => socket.emitCatalog(media.list()));
        });
      }
      socket.emitTorrentList(torrents.list());
    } catch (e) {
      console.error('[tv-client] torrent add failed', e);
    }
  },
  onTorrentRemove: (payload) => {
    torrents.remove(payload.torrentId);
    socket.emitTorrentList(torrents.list());
  },
  onTorrentWatch: (payload) => {
    const file = torrents.watch(payload.torrentId, payload.fileIndex ?? 0);
    if (file) {
      const target = {
        kind: 'torrent' as const,
        url: `http://127.0.0.1:${config.streamPort}/stream/torrent/${encodeURIComponent(payload.torrentId)}/${payload.fileIndex ?? 0}`,
        title: file.name,
      };
      mainWindow?.webContents.send('tv:play', target);
    }
  },
  onTorrentsGet: () => {
    socket.emitTorrentList(torrents.list());
  },
  onFileDelete: (payload) => {
    media.delete(payload.mediaId);
    socket.emitCatalog(media.list());
  },
  onMetadataUpdate: (payload) => {
    void media.updateMetadata(payload).then((updated) => {
      if (updated) socket.emitCatalogUpdate(updated);
      socket.emitCatalog(media.list());
    });
  },
  onFsList: (payload) => {
    const result = { path: payload.path || '', entries: listDirectory(payload.path || '') };
    socket.emitFsResult(result);
  },
  onWidgetsGet: () => {
    socket.emitWidgetsResult(getWidgets(), getIdleSettings());
  },
  onWidgetsUpdate: (payload) => {
    db.saveWidgets(payload.widgets ?? []);
    if (payload.settings) {
      const next = { ...getIdleSettings(), ...payload.settings };
      db.saveIdleSettings(next);
    }
    const widgets = getWidgets();
    const settings = getIdleSettings();
    mainWindow?.webContents.send('tv:widgets', { widgets, settings });
    socket.emitWidgetsResult(widgets, settings);
  },
  onPower: (payload) => {
    void powerAction(payload.action);
  },
  onSignal: (event, msg) => {
    mainWindow?.webContents.send('tv:signal', { event, msg });
  },
});

function resolveAndPlay(cmd: { source?: string; url?: string; mediaId?: string; videoId?: string; torrentId?: string; title?: string }): void {
  if (cmd.source === 'youtube') {
    const videoId = cmd.videoId || extractYouTubeId(cmd.url || '');
    mainWindow?.webContents.send('tv:play', { kind: 'youtube', videoId, url: cmd.url, title: cmd.title });
    return;
  }
  if (cmd.source === 'local' && cmd.mediaId) {
    const item = media.list().find((m) => m.id === cmd.mediaId);
    if (item?.path) {
      mainWindow?.webContents.send('tv:play', {
        kind: 'local',
        url: `http://127.0.0.1:${config.streamPort}/stream/local?path=${encodeURIComponent(item.path)}`,
        title: item.title,
        mediaId: item.id,
      });
    }
    return;
  }
  if (cmd.source === 'local' && cmd.url) {
    mainWindow?.webContents.send('tv:play', {
      kind: 'local',
      url: `http://127.0.0.1:${config.streamPort}/stream/local?path=${encodeURIComponent(cmd.url)}`,
      title: cmd.title,
    });
    return;
  }
  if (cmd.source === 'torrent' && cmd.torrentId) {
    const file = torrents.watch(cmd.torrentId);
    if (file) {
      mainWindow?.webContents.send('tv:play', {
        kind: 'torrent',
        url: `http://127.0.0.1:${config.streamPort}/stream/torrent/${encodeURIComponent(cmd.torrentId)}/0`,
        title: cmd.title || file.name,
      });
    }
  }
}

function extractYouTubeId(url: string): string | undefined {
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /\/embed\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return undefined;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    frame: false,
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC from renderer
ipcMain.handle('tv:getInfo', () => ({
  streamPort: config.streamPort,
  backendUrl: config.backendUrl,
}));
ipcMain.handle('tv:getCatalog', () => media.list());
ipcMain.on('tv:playerState', (_e, state: PlayerState) => {
  socket.emitState(state);
});
ipcMain.on('tv:progress', (_e, p: { mediaId: string; position: number; duration: number }) => {
  if (p.mediaId) media.saveProgress(p.mediaId, p.position, p.duration);
});
ipcMain.on('tv:signal-reply', (_e, payload: { event: string; msg: SignalMessage }) => {
  socket.emitSignal(payload.event, payload.msg);
});
ipcMain.on('tv:widgets-get', () => {
  mainWindow?.webContents.send('tv:widgets', { widgets: getWidgets(), settings: getIdleSettings() });
});

app.whenReady().then(() => {
  media.scanLocal();
  socket.connect();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
