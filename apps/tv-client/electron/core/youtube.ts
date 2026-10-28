import { EventEmitter } from 'node:events';
import path from 'node:path';
import { session, WebContentsView, type BrowserWindow, type Session } from 'electron';
import type { NavKey, YoutubeState } from '@tvbox/shared';
import type { PlayerCommand, PlayTarget, RendererReport } from '../../src/bridge';
import type { TvDatabase } from './db';

/**
 * YouTube as a TV app: the official YouTube TV interface (youtube.com/tv, the one smart TVs run)
 * in a view laid over the TVBox window.
 *  - made for a 10-foot screen and a D-pad: home, subscriptions, library, history, playlists, search,
 *  - the Google account is linked with a code on the phone (yt.be/activate) — nothing to type at the TV,
 *  - ads are cut out of the API responses (see youtube-preload.ts) and ad servers are blocked,
 *  - the view stays alive in the background for a while, so reopening YouTube is instant,
 *  - the view is shown only once YouTube has drawn its UI: no white flashes or half-loaded pages.
 */
const PARTITION = 'persist:youtube-tv';
const OLD_PARTITION = 'persist:youtube';
const TV_UA =
  'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.5 TV Safari/537.36';
const BASE = 'https://www.youtube.com/tv';
/** Free the memory if YouTube was not used for this long */
const KEEP_ALIVE_MS = 20 * 60 * 1000;

export const AD_HOSTS = [
  '*://*.doubleclick.net/*',
  '*://*.googlesyndication.com/*',
  '*://*.googleadservices.com/*',
  '*://imasdk.googleapis.com/*',
  '*://*.google-analytics.com/*',
  '*://www.youtube.com/pagead/*',
  '*://www.youtube.com/ptracking*',
  '*://www.youtube.com/api/stats/ads*',
  '*://www.youtube.com/get_midroll_*',
  '*://www.youtube.com/youtubei/v1/log_event*',
];

const STATE_JS = `(() => {
  const app = document.querySelector('ytlr-app');
  const text = document.body ? document.body.innerText : '';
  const all = document.body ? document.body.textContent : '';
  const v = document.querySelector('video');
  const pl = document.querySelector('.html5-video-player');
  let vd = null;
  try {
    const d = pl && pl.getVideoData && pl.getVideoData();
    const pr = pl && pl.getPlayerResponse && pl.getPlayerResponse();
    const det = pr && pr.videoDetails;
    if (d && d.video_id) vd = { id: d.video_id, title: d.title || (det && det.title) || '', author: d.author || (det && det.author) || '' };
  } catch (e) {}
  // "Введите код YKSM-SLYH" / "Enter the code ABC-DEF-GHI" (the format varies)
  const code = ((/(?:Введите код|Enter the code|код)\\s*([A-Z0-9]{3,5}(?:-[A-Z0-9]{3,5}){1,3})/i.exec(text) || /\\b([A-Z0-9]{3,5}(?:-[A-Z0-9]{3,5}){1,3})\\b/.exec(text) || [])[1]) || null;
  const focused = document.activeElement ? (document.activeElement.textContent || '').trim().slice(0, 60) : '';
  const shown = (sel) => { const e = document.querySelector(sel); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const guide = document.querySelector('ytlr-guide-response');
  const guideText = guide ? (guide.textContent || '').replace(/\\s+/g, ' ').trim() : '';
  return {
    ready: !!(app && app.children.length && (document.querySelector('ytlr-guide-response, ytlr-surface-page, ytlr-welcome, ytlr-account-selector, ytlr-search-container, ytlr-browse') || text.trim().length > 30)),
    // the side menu is filled in: "Войти / Sign in" at its top means nobody is signed in
    guide: /Главная|Home/.test(guideText),
    hash: location.hash || '#/',
    picker: shown('ytlr-welcome') || shown('ytlr-account-selector'),
    welcome: shown('ytlr-welcome') && !code,
    code: /yt\\.be\\/activate|youtube\\.com\\/activate/i.test(text) ? code : null,
    signedOut: /^(Войти|Sign in)/i.test(guideText) || /Вы вышли из аккаунта|You.re signed out/.test(all),
    focused,
    video: v ? { t: v.currentTime || 0, d: isFinite(v.duration) ? v.duration : 0, paused: v.paused, ended: v.ended, waiting: v.readyState < 3, muted: v.muted, rate: v.playbackRate } : null,
    ad: !!(pl && /\\bad-showing\\b|\\bad-interrupting\\b/.test(pl.className)),
    vd,
    removed: (window.__tvboxAdblock && window.__tvboxAdblock.removed) || 0,
    exit: window.__tvboxExit || 0,
  };
})()`;

interface PageState {
  ready: boolean;
  guide: boolean;
  hash: string;
  picker: boolean;
  welcome: boolean;
  code: string | null;
  signedOut: boolean;
  focused: string;
  video: { t: number; d: number; paused: boolean; ended: boolean; waiting: boolean; muted: boolean; rate: number } | null;
  ad: boolean;
  vd: { id: string; title: string; author: string } | null;
  removed: number;
  /** times YouTube asked to close itself (Back on its root screen) */
  exit: number;
}

const KEYS: Record<string, string> = {
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  enter: 'Enter',
  back: 'Escape',
  backspace: 'Backspace',
};

/** Electron key name -> DOM key / keyCode */
const DOM_KEYS: Record<string, [string, number]> = {
  Up: ['ArrowUp', 38],
  Down: ['ArrowDown', 40],
  Left: ['ArrowLeft', 37],
  Right: ['ArrowRight', 39],
  Enter: ['Enter', 13],
  Escape: ['Escape', 27],
  Backspace: ['Backspace', 8],
};

/** Runs inside the YouTube page (serialized with toString). */
function dispatchKey(key: string, keyCode: number): void {
  const target = (document.activeElement as HTMLElement | null) || document.body;
  for (const type of ['keydown', 'keyup']) {
    const e = new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true, composed: true });
    Object.defineProperty(e, 'keyCode', { get: () => keyCode });
    Object.defineProperty(e, 'which', { get: () => keyCode });
    target.dispatchEvent(e);
  }
}

/**
 * Start YouTube TV again at its home screen. loadURL() of the same page with another "#…"
 * is only a hash change (no reload), so the page is reloaded explicitly.
 */
function restart(wc: Electron.WebContents): void {
  if (wc.isDestroyed()) return;
  if (!wc.getURL().startsWith(BASE)) {
    void wc.loadURL(BASE + '#/').catch(() => undefined);
    return;
  }
  void wc
    .executeJavaScript(`history.replaceState(null, '', '/tv#/')`)
    .catch(() => undefined)
    .finally(() => {
      if (!wc.isDestroyed()) wc.reload();
    });
}

const watchHash = (id: string, t?: number, list?: string, index?: number) =>
  `#/watch?v=${encodeURIComponent(id)}${list ? `&list=${encodeURIComponent(list)}${index ? `&index=${index}` : ''}` : ''}${t && t > 1 ? `&t=${Math.floor(t)}s` : ''}`;

export class YouTubeController extends EventEmitter {
  private view: WebContentsView | null = null;
  private attached = false;
  private ready = false;
  private target: PlayTarget | null = null;
  private timer: NodeJS.Timeout | null = null;
  private destroyTimer: NodeJS.Timeout | null = null;
  private page: PageState | null = null;
  private st: YoutubeState = { open: false, mode: 'closed', signedIn: false, adsBlocked: 0 };
  private stJson = '';
  private videoId: string | null = null;
  /** The requested video actually reached the screen (before that, menus are just the way there) */
  private watchSeen = false;
  private pending: { hash: string; guest: boolean } | null = null;
  private adActive = false;
  private adWasMuted = false;
  private lastPickerKey = 0;
  private lastBackAtHome = 0;
  private picking = false;
  private loginRequested = false;
  private baseRemoved = 0;
  private lastExit = 0;
  private pickerSince = 0;
  private syntheticUntil = 0;

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly db: TvDatabase,
  ) {
    super();
    this.st.signedIn = !!db.getJson<boolean>('youtube:signedIn');
  }

  // ------------------------------------------------------------------ view lifecycle
  private ses(): Session {
    const ses = session.fromPartition(PARTITION);
    if (!(ses as Session & { __tvbox?: boolean }).__tvbox) {
      (ses as Session & { __tvbox?: boolean }).__tvbox = true;
      ses.setUserAgent(TV_UA, 'ru-RU,ru;q=0.9,en;q=0.7');
      ses.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'fullscreen' || perm === 'media'));
      ses.webRequest.onBeforeRequest({ urls: AD_HOSTS }, (_d, cb) => cb({ cancel: true }));
    }
    return ses;
  }

  private ensureView(): WebContentsView | null {
    const win = this.getWindow();
    if (!win) return null;
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    this.ses();
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        preload: path.join(__dirname, 'youtube-preload.js'),
        // the preload must run in the page's own world to see YouTube's responses; nothing is exposed
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    view.setBackgroundColor('#000000');
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('did-start-loading', () => {
      this.ready = false;
      // the page's counters start from zero again
      this.baseRemoved = 0;
      this.lastExit = 0;
    });
    view.webContents.on('render-process-gone', () => this.destroyView());
    // should the page still manage to close itself, don't keep talking to a dead view
    view.webContents.once('destroyed', () => {
      if (this.view !== view) return;
      this.view = null;
      this.attached = false;
      this.ready = false;
      this.page = null;
      const win = this.getWindow();
      try {
        if (win && !win.isDestroyed() && win.contentView.children.includes(view)) win.contentView.removeChildView(view);
      } catch {
        // ignore
      }
      if (this.target) this.emit('exit');
      else if (this.loginRequested) this.hide();
    });
    view.webContents.on('before-input-event', (e, input) => {
      // a keyboard at the TV: Esc on the YouTube home screen closes YouTube
      // (keys we send ourselves from the remote also pass through here — those are not the TV keyboard)
      if (input.type === 'keyDown' && Date.now() > this.syntheticUntil && (input.key === 'Escape' || input.key === 'BrowserBack') && this.atHome()) {
        e.preventDefault();
        this.backAtHome();
      }
    });
    this.view = view;
    this.ready = false;
    void view.webContents.loadURL(BASE + '#/');
    return view;
  }

  private destroyView(): void {
    const win = this.getWindow();
    if (this.view) {
      try {
        if (win && win.contentView.children.includes(this.view)) win.contentView.removeChildView(this.view);
        if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
      } catch {
        // ignore
      }
    }
    this.view = null;
    this.attached = false;
    this.ready = false;
    this.page = null;
  }

  private layout = (): void => {
    const win = this.getWindow();
    if (!win || !this.view) return;
    const [w, h] = win.getContentSize();
    this.view.setBounds({ x: 0, y: 0, width: w, height: h });
  };

  /** Lay the view over the window (only once YouTube has drawn something). */
  private attach(): void {
    const win = this.getWindow();
    if (!win || !this.view || this.attached) return;
    if (!win.contentView.children.includes(this.view)) win.contentView.addChildView(this.view);
    this.layout();
    win.off('resize', this.layout);
    win.on('resize', this.layout);
    this.attached = true;
    if (!win.isFocused()) win.focus();
    this.view.webContents.focus();
    this.emit('attached');
  }

  private detach(): void {
    const win = this.getWindow();
    if (win && this.view && win.contentView.children.includes(this.view)) win.contentView.removeChildView(this.view);
    win?.off('resize', this.layout);
    this.attached = false;
    win?.webContents.focus();
  }

  get webContents(): Electron.WebContents | null {
    return this.attached && this.view && !this.view.webContents.isDestroyed() ? this.view.webContents : null;
  }

  // ------------------------------------------------------------------ public API (used by the player)
  /** YouTube is on screen (playing / browsing, or showing the account-linking code). */
  get active(): boolean {
    return !!this.target || this.loginRequested;
  }

  get state(): YoutubeState {
    return this.st;
  }

  /** Show YouTube: a video (target.videoId) or the home screen. */
  play(target: PlayTarget): void {
    const view = this.ensureView();
    if (!view) return;
    if (this.destroyTimer) clearTimeout(this.destroyTimer);
    this.destroyTimer = null;
    const wasActive = !!this.target;
    this.target = target;
    this.videoId = target.videoId || null;
    this.watchSeen = false;
    if (target.videoId) this.go(watchHash(target.videoId, target.startAt, target.list, target.listIndex), true);
    else if (!wasActive && this.page && /^#\/watch/.test(this.page.hash)) this.loadHome();
    if (this.ready && !this.page?.picker) this.attach();
    this.report(target.videoId ? 'loading' : 'paused', 0, 0);
    this.publish({ open: true, mode: target.videoId ? 'watch' : 'browse', videoId: target.videoId, title: target.videoId ? target.title : undefined });
    this.startPolling(500);
  }

  /** Change the target without navigating (YouTube itself switched videos). */
  adopt(target: PlayTarget): void {
    this.target = target;
  }

  search(query: string): void {
    const q = query.trim();
    if (!q) return this.go('#/search', false);
    this.go(`#/search?q=${encodeURIComponent(q)}`, false);
  }

  /**
   * YouTube's home screen. Changing the hash to "#/" is not enough: over a playing video
   * YouTube TV keeps the player on screen and its focus breaks, so the app is reloaded at home.
   */
  home(): void {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    if (this.atHome() && !this.videoId && this.ready) return;
    const hadVideo = !!this.videoId;
    this.videoId = null;
    this.watchSeen = false;
    // TVBox's YouTube splash covers the restart; the view comes back once YouTube is at home
    this.detach();
    this.loadHome();
    this.publish({ open: true, mode: 'browse', videoId: undefined, title: undefined });
    if (hadVideo) this.emit('browse');
    this.report('paused', 0, 0);
    this.startPolling(500);
  }

  /** Reload YouTube TV at its home screen ("who's watching" / guest entry is handled as on first start). */
  private loadHome(): void {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    this.ready = false;
    this.pending = null;
    this.page = null;
    restart(wc);
  }

  /** Close YouTube (keeps the page in memory for a quick return). */
  hide(): void {
    const wc = this.view?.webContents;
    if (wc && !wc.isDestroyed()) {
      void wc.executeJavaScript(`document.querySelectorAll('video').forEach(v => v.pause())`).catch(() => undefined);
      // leave the watch page, so the next open starts at the home screen
      if (this.page && (/^#\/watch/.test(this.page.hash) || this.page.video)) this.loadHome();
    }
    this.detach();
    this.target = null;
    this.videoId = null;
    this.pending = null;
    this.loginRequested = false;
    this.stopPolling();
    this.publish({ open: false, mode: 'closed', code: undefined, videoId: undefined, title: undefined });
    if (this.destroyTimer) clearTimeout(this.destroyTimer);
    if (this.view) this.destroyTimer = setTimeout(() => this.destroyView(), KEEP_ALIVE_MS);
  }

  command(c: PlayerCommand): void {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    const js =
      c.type === 'toggle'
        ? `(() => { const v = document.querySelector('video'); if (v) v.paused ? v.play() : v.pause(); })()`
        : c.type === 'play'
          ? `document.querySelector('video')?.play()`
          : c.type === 'pause' || c.type === 'stop'
            ? `document.querySelector('video')?.pause()`
            : c.type === 'seek'
              ? `(() => { const p = document.querySelector('.html5-video-player'); const t = ${Number(c.position) || 0}; if (p && p.seekTo) p.seekTo(t, true); else { const v = document.querySelector('video'); if (v) v.currentTime = t; } })()`
              : '';
    if (js) void wc.executeJavaScript(js, true).catch(() => undefined);
    setTimeout(() => void this.poll(), 250);
  }

  /** D-pad from the remote. */
  nav(key: NavKey): void {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    if (key === 'home') return this.home();
    if (key === 'search') return this.go('#/search', false);
    if (key === 'playpause') return this.command({ type: 'toggle' });
    if (key === 'back' && this.atHome()) return this.backAtHome();
    const code = KEYS[key];
    if (!code) return;
    this.sendKey(code);
    setTimeout(() => void this.poll(), 300);
  }

  /** Text from the remote: a search query. */
  type(text: string): void {
    this.search(text);
  }

  /** Link a Google account: shows the activation code (enter it at yt.be/activate on the phone). */
  async login(): Promise<void> {
    if (this.st.signedIn) return;
    this.loginRequested = true;
    const view = this.ensureView();
    if (!view) return;
    // back to the welcome screen, where YouTube shows the activation code
    await this.ses().clearStorageData({ storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] });
    this.ready = false;
    restart(view.webContents);
    this.publish({ open: true, mode: 'login', code: undefined });
    this.startPolling(500);
  }

  async logout(): Promise<void> {
    await this.ses().clearStorageData();
    await session.fromPartition(OLD_PARTITION).clearStorageData().catch(() => undefined);
    this.setSignedIn(false);
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.ready = false;
      restart(this.view.webContents);
    }
  }

  async signedIn(): Promise<boolean> {
    return this.st.signedIn;
  }

  /** Small notification drawn inside YouTube (TVBox toasts are hidden under the view). */
  toast(message: string): void {
    const wc = this.webContents;
    if (!wc) return;
    const js = `(() => {
      const d = document.createElement('div');
      d.textContent = ${JSON.stringify(message)};
      d.style.cssText = 'position:fixed;right:2.5vw;top:3vh;z-index:2147483647;max-width:30vw;padding:1.1vw 1.5vw;border-radius:1.4vw;background:rgba(18,20,26,.92);color:#fff;font:600 1.15vw/1.35 system-ui,sans-serif;box-shadow:0 1vw 3vw rgba(0,0,0,.5);opacity:0;transform:translateY(-1vw);transition:all .35s ease';
      document.body.appendChild(d);
      requestAnimationFrame(() => { d.style.opacity = '1'; d.style.transform = 'none'; });
      setTimeout(() => { d.style.opacity = '0'; setTimeout(() => d.remove(), 400); }, 4500);
    })()`;
    void wc.executeJavaScript(js).catch(() => undefined);
  }

  // ------------------------------------------------------------------ internals
  private atHome(): boolean {
    const h = this.page?.hash || '#/';
    return (h === '#/' || h === '#' || h === '') && !this.page?.picker && !this.page?.code;
  }

  private backAtHome(): void {
    const now = Date.now();
    // first Back on the home screen goes to YouTube's side menu, the second one closes YouTube
    if (now - this.lastBackAtHome < 2500) {
      this.lastBackAtHome = 0;
      this.emit('exit');
      return;
    }
    this.lastBackAtHome = now;
    this.sendKey('Escape');
    this.toast('Нажмите «Назад» ещё раз, чтобы закрыть YouTube');
  }

  /**
   * Press a key inside YouTube. The key events are dispatched into the page itself:
   * Electron's sendInputEvent only reaches the page while the TVBox window has the OS focus,
   * which on a living-room PC is often not the case (another window, the desktop after login…).
   */
  private sendKey(keyCode: string): void {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    const k = DOM_KEYS[keyCode];
    if (!k) return;
    this.syntheticUntil = Date.now() + 400;
    void wc.executeJavaScript(`(${dispatchKey.toString()})(${JSON.stringify(k[0])}, ${k[1]})`, true).catch(() => undefined);
  }

  /** The requested video again (with its playlist), after YouTube dropped the deep link. */
  private reopenHash(): string {
    const t = this.target;
    const same = t?.videoId === this.videoId;
    return watchHash(this.videoId || '', same ? t?.startAt : undefined, same ? t?.list : undefined, same ? t?.listIndex : undefined);
  }

  private go(hash: string, guest: boolean): void {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    if (!this.ready || this.page?.picker) {
      // YouTube is still starting (or asks "who's watching"): navigate once it's ready
      this.pending = { hash, guest };
      return;
    }
    this.pending = null;
    void wc.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => undefined);
  }

  private startPolling(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), ms);
  }

  private stopPolling(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private setSignedIn(v: boolean): void {
    if (this.st.signedIn === v) return;
    this.db.setJson('youtube:signedIn', v);
    this.publish({ signedIn: v });
    if (v) this.emit('signed-in');
  }

  private async poll(): Promise<void> {
    this.timer = null;
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed() || (!this.target && !this.loginRequested)) return;
    let s: PageState | null = null;
    try {
      s = (await wc.executeJavaScript(STATE_JS, true)) as PageState;
    } catch {
      s = null;
    }
    if (s) await this.handle(s);
    if (this.target || this.loginRequested) this.startPolling(s?.video && !s.video.paused ? 1000 : 700);
  }

  private async handle(s: PageState): Promise<void> {
    const wc = this.view?.webContents;
    if (!wc) return;
    this.page = s;
    if (s.ready && !this.ready) {
      this.ready = true;
    }

    // Back on YouTube's root screen: YouTube wants to quit → close it in TVBox
    if (s.exit > this.lastExit) {
      this.lastExit = s.exit;
      if (this.target) this.emit('exit');
      else this.hide();
      return;
    }
    // keep TVBox's splash up while YouTube asks "who's watching" — TVBox answers that itself;
    // only linking an account needs that screen (and a stuck picker is shown after a while)
    if (s.picker) this.pickerSince ||= Date.now();
    else this.pickerSince = 0;
    const showable = !s.picker || this.loginRequested || Date.now() - this.pickerSince > 8000;
    if (this.ready && showable && (this.target || this.loginRequested) && !this.attached) this.attach();

    // signed in? (YouTube TV keeps its own tokens; the guide says "You're signed out" otherwise)
    if (s.ready && s.guide && !s.picker && !s.code) this.setSignedIn(!s.signedOut);

    // "Who's watching?" / welcome screen
    if (s.picker && !this.picking && Date.now() - this.lastPickerKey > 2500) {
      if (this.loginRequested) {
        // "Get started" / "Add account" is focused first: it opens the activation code
        this.lastPickerKey = Date.now();
        if (!s.code) this.sendKey('Enter');
      } else if (this.st.signedIn && !s.welcome) {
        // "who's watching?": the account tile comes first
        this.lastPickerKey = Date.now();
        this.sendKey('Enter');
        if (this.videoId) this.pending = { hash: this.reopenHash(), guest: false };
      } else {
        // no account yet: go in as a guest (home, search and videos work; the remote offers to link the account)
        void this.pickGuest(s.welcome);
      }
    }

    // activation code for linking the account
    if (s.code !== (this.st.code || null)) this.publish({ code: s.code || undefined, mode: s.code ? 'login' : this.st.mode === 'login' ? 'browse' : this.st.mode });
    if (this.loginRequested && !s.code && s.ready && s.guide && !s.picker && !s.signedOut) {
      this.loginRequested = false;
      this.setSignedIn(true);
      if (!this.target) this.hide();
    }

    if (s.ready && !s.picker && this.pending) {
      const p = this.pending;
      this.pending = null;
      void wc.executeJavaScript(`location.hash = ${JSON.stringify(p.hash)}`).catch(() => undefined);
      return;
    }

    // ads that still slipped through: mute and fast-forward
    if (s.ad && s.video) {
      if (!this.adActive) {
        this.adActive = true;
        this.adWasMuted = s.video.muted;
        this.publish({ adsBlocked: (this.st.adsBlocked || 0) + 1 });
      }
      void wc
        .executeJavaScript(
          `(() => { const v = document.querySelector('video'); if (!v) return; v.muted = true; v.playbackRate = 16; if (isFinite(v.duration) && v.duration > 0 && v.currentTime < v.duration - 0.3) v.currentTime = v.duration - 0.1;
            const skip = [...document.querySelectorAll('[class*="skip"], ytlr-skip-button-renderer, .ytp-ad-skip-button, .ytp-skip-ad-button')].find(e => e.offsetParent !== null);
            if (skip) { skip.focus && skip.focus(); skip.click && skip.click(); } })()`,
        )
        .catch(() => undefined);
      this.sendKey('Enter');
      return this.report('loading', 0, 0);
    }
    if (this.adActive && !s.ad) {
      this.adActive = false;
      void wc
        .executeJavaScript(`(() => { const v = document.querySelector('video'); if (v) { v.playbackRate = 1; v.muted = ${this.adWasMuted}; } })()`)
        .catch(() => undefined);
    }
    const removed = s.removed - this.baseRemoved;
    if (removed > 0) {
      this.baseRemoved = s.removed;
      this.publish({ adsBlocked: (this.st.adsBlocked || 0) + removed });
    }

    // what is on screen: a video or YouTube's menus
    const watching = /^#\/watch/.test(s.hash) && !!s.vd?.id;
    if (watching && s.vd) {
      this.watchSeen = true;
      if (s.vd.id !== this.videoId || (s.vd.title && s.vd.title !== this.st.title)) {
        this.videoId = s.vd.id;
        this.emit('watch', s.vd.id, s.vd.title, s.vd.author);
      }
      this.publish({ open: true, mode: 'watch', videoId: s.vd.id, title: s.vd.title || this.st.title });
    } else if (!s.code && !s.picker) {
      if (this.videoId && this.watchSeen && !this.pending && !/^#\/watch/.test(s.hash)) {
        this.videoId = null;
        this.watchSeen = false;
        this.emit('browse');
      }
      if (this.target && !this.videoId) this.publish({ open: true, mode: 'browse', videoId: undefined, title: undefined });
    }

    if (!this.target) return;
    const v = s.video;
    if (!watching || !v) return this.report(this.videoId ? 'loading' : 'paused', 0, 0);
    this.report(v.ended ? 'ended' : v.paused ? 'paused' : v.waiting ? 'loading' : 'playing', v.t, v.d);
  }

  /**
   * Not signed in and a video was asked for: answer "who's watching?" with "watch as guest".
   * The welcome screen first needs "Get started", which opens the sign-in options with the guest one.
   */
  private async pickGuest(welcome: boolean): Promise<void> {
    if (this.picking) return;
    this.picking = true;
    this.lastPickerKey = Date.now();
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const focused = async () =>
      String(await this.view?.webContents.executeJavaScript(`document.activeElement ? document.activeElement.textContent || '' : ''`).catch(() => '') ?? '');
    try {
      if (welcome) {
        this.sendKey('Enter');
        await wait(1500);
      }
      let found = false;
      for (let i = 0; i < 5 && this.view && !this.view.webContents.isDestroyed(); i++) {
        if (/гост|guest/i.test(await focused())) {
          found = true;
          break;
        }
        this.sendKey('Down');
        await wait(300);
      }
      if (found) {
        this.sendKey('Enter');
        // YouTube drops the deep link while asking: open the video again once it's past the picker
        if (this.videoId) this.pending = { hash: this.reopenHash(), guest: true };
      }
    } finally {
      this.lastPickerKey = Date.now();
      this.picking = false;
    }
  }

  private publish(patch: Partial<YoutubeState>): void {
    this.st = { ...this.st, ...patch };
    const json = JSON.stringify(this.st);
    if (json === this.stJson) return;
    this.stJson = json;
    this.emit('state', this.st);
  }

  private report(status: RendererReport['status'], position: number, duration: number, error?: string): void {
    if (!this.target) return;
    this.emit('report', { key: this.target.key, status, position, duration, error } satisfies RendererReport);
  }
}

/** Keyboard at the TV (keys that reached the TVBox page instead of YouTube). */
export function navKeyFromKeyboard(key: string): NavKey | null {
  const map: Record<string, NavKey> = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    Enter: 'enter',
    ' ': 'playpause',
    MediaPlayPause: 'playpause',
    Escape: 'back',
    BrowserBack: 'back',
    Backspace: 'backspace',
  };
  return map[key] || null;
}
