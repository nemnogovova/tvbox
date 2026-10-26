import { EventEmitter } from 'node:events';
import { session, WebContentsView, type BrowserWindow } from 'electron';
import type { PlayerCommand, PlayTarget, RendererReport } from '../../src/bridge';

/**
 * YouTube through the regular youtube.com watch page (not the embed player):
 * videos whose owners disabled embedding play fine, and the session is persistent,
 * so signing in to YouTube on the TV once gives Premium / age-restricted videos.
 */
const PARTITION = 'persist:youtube';
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// Google's sign-in page refuses "embedded" Chromium; it accepts a Firefox UA.
const LOGIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';

const PLAYER_CSS = `
html, body { overflow: hidden !important; background: #000 !important; }
#masthead-container, #secondary, #below, #related, #comments, ytd-watch-metadata, tp-yt-app-drawer,
ytd-mini-guide-renderer, #guide, ytd-popup-container, .ytp-paid-content-overlay, .ytp-pause-overlay,
.ytp-chrome-top, .ytp-chrome-bottom, .ytp-gradient-top, .ytp-gradient-bottom, .ytp-ce-element,
.iv-branding, .ytp-cards-teaser, .ytp-endscreen-content, ytd-consent-bump-v2-lightbox, tp-yt-iron-overlay-backdrop
  { display: none !important; }
#movie_player, ytd-player, #player-container, #player-container-outer, #full-bleed-container {
  position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
  max-width: none !important; max-height: none !important; z-index: 2147483646 !important; background: #000 !important;
}
#movie_player video { width: 100vw !important; height: 100vh !important; left: 0 !important; top: 0 !important; object-fit: contain !important; }
`;

const STATE_JS = `(() => {
  const p = document.getElementById('movie_player');
  const v = document.querySelector('#movie_player video') || document.querySelector('video');
  // auto-skip skippable ads, dismiss "are you still watching?"
  const skip = document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button');
  if (skip) skip.click();
  const still = document.querySelector('yt-confirm-dialog-renderer #confirm-button, .ytp-button[aria-label*="Yes"]');
  if (still && /still|ещё|еще/i.test(document.body.innerText.slice(0, 4000))) still.click();
  const err = document.querySelector('.ytp-error-content-wrap-reason, .ytp-error');
  const watch = location.hostname.endsWith('youtube.com') && location.pathname === '/watch';
  return {
    ready: !!(p && v),
    t: v ? v.currentTime : 0,
    d: v && isFinite(v.duration) ? v.duration : 0,
    paused: v ? v.paused : true,
    ended: v ? v.ended : false,
    waiting: v ? v.readyState < 3 : true,
    ad: !!document.querySelector('#movie_player.ad-showing'),
    title: !watch ? '' : (document.title || '').replace(/^\\(\\d+\\)\\s*/, '').replace(/ - YouTube$/, ''),
    error: err ? (err.innerText || 'error').trim().slice(0, 200) : null,
    href: location.href,
  };
})()`;

interface YtState {
  ready: boolean;
  t: number;
  d: number;
  paused: boolean;
  ended: boolean;
  waiting: boolean;
  ad: boolean;
  title: string;
  error: string | null;
  href: string;
}

export class YouTubeController extends EventEmitter {
  private view: WebContentsView | null = null;
  private target: PlayTarget | null = null;
  private timer: NodeJS.Timeout | null = null;
  private mode: 'idle' | 'play' | 'login' = 'idle';
  private titleSent = '';

  constructor(private readonly getWindow: () => BrowserWindow | null) {
    super();
  }

  private ensureView(): WebContentsView | null {
    const win = this.getWindow();
    if (!win) return null;
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    const ses = session.fromPartition(PARTITION);
    ses.setUserAgent(CHROME_UA);
    ses.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'fullscreen' || perm === 'media'));
    const view = new WebContentsView({
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
    });
    view.setBackgroundColor('#000000');
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('dom-ready', () => this.onDomReady());
    view.webContents.on('did-navigate', () => this.onNavigate());
    view.webContents.on('did-navigate-in-page', () => this.onNavigate());
    view.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && this.mode === 'login') {
        e.preventDefault();
        this.hide();
      }
    });
    this.view = view;
    return view;
  }

  private layout(): void {
    const win = this.getWindow();
    if (!win || !this.view) return;
    const [w, h] = win.getContentSize();
    this.view.setBounds({ x: 0, y: 0, width: w, height: h });
  }

  private show(): void {
    const win = this.getWindow();
    if (!win || !this.view) return;
    if (!win.contentView.children.includes(this.view)) win.contentView.addChildView(this.view);
    this.layout();
    win.removeAllListeners('resize');
    win.on('resize', () => this.layout());
    this.view.webContents.focus();
  }

  hide(): void {
    const win = this.getWindow();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.view && !this.view.webContents.isDestroyed()) {
      try {
        void this.view.webContents.executeJavaScript(`document.querySelectorAll('video').forEach(v => v.pause())`).catch(() => undefined);
        this.view.webContents.loadURL('about:blank').catch(() => undefined);
      } catch {
        // ignore
      }
      if (win && win.contentView.children.includes(this.view)) win.contentView.removeChildView(this.view);
    }
    this.mode = 'idle';
    this.target = null;
  }

  get active(): boolean {
    return this.mode === 'play' && !!this.target;
  }

  /** Start playing a YouTube target (replaces the current video). */
  play(target: PlayTarget): void {
    const view = this.ensureView();
    if (!view || !target.videoId) return;
    this.target = target;
    this.mode = 'play';
    this.titleSent = '';
    view.webContents.setUserAgent(CHROME_UA);
    const t = Math.floor(target.startAt || 0);
    void view.webContents.loadURL(`https://www.youtube.com/watch?v=${encodeURIComponent(target.videoId)}${t ? `&t=${t}s` : ''}`);
    this.show();
    this.report('loading', 0, 0);
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.poll(), 1000);
  }

  /** Let the user sign in to YouTube on the TV (keyboard / mouse at the TV). */
  login(): void {
    const view = this.ensureView();
    if (!view) return;
    this.target = null;
    this.mode = 'login';
    if (this.timer) clearInterval(this.timer);
    view.webContents.setUserAgent(LOGIN_UA);
    void view.webContents.loadURL('https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F');
    this.show();
  }

  async logout(): Promise<void> {
    await session.fromPartition(PARTITION).clearStorageData();
  }

  async signedIn(): Promise<boolean> {
    const cookies = await session.fromPartition(PARTITION).cookies.get({ domain: '.youtube.com' });
    return cookies.some((c) => c.name === 'SAPISID' || c.name === '__Secure-3PAPISID');
  }

  command(c: PlayerCommand): void {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed() || this.mode !== 'play') return;
    const js =
      c.type === 'toggle'
        ? `(() => { const v = document.querySelector('#movie_player video'); if (v) v.paused ? v.play() : v.pause(); })()`
        : c.type === 'play'
          ? `document.querySelector('#movie_player video')?.play()`
          : c.type === 'pause' || c.type === 'stop'
            ? `document.querySelector('#movie_player video')?.pause()`
            : c.type === 'seek'
              ? `(() => { const p = document.getElementById('movie_player'); if (p && p.seekTo) p.seekTo(${Number(c.position) || 0}, true); else { const v = document.querySelector('video'); if (v) v.currentTime = ${Number(c.position) || 0}; } })()`
              : c.type === 'subtitles'
                ? `(() => { const p = document.getElementById('movie_player'); if (!p) return; ${c.id ? `p.loadModule && p.loadModule('captions'); p.setOption && p.setOption('captions', 'track', { languageCode: ${JSON.stringify(c.id)} });` : `p.unloadModule && p.unloadModule('captions');`} })()`
                : '';
    if (js) void wc.executeJavaScript(js, true).catch(() => undefined);
    setTimeout(() => void this.poll(), 200);
  }

  private onDomReady(): void {
    const wc = this.view?.webContents;
    if (!wc) return;
    const url = wc.getURL();
    if (this.mode === 'play' && /youtube\.com\/watch/.test(url)) {
      void wc.insertCSS(PLAYER_CSS);
      void wc.executeJavaScript(`setTimeout(() => window.dispatchEvent(new Event('resize')), 300); setTimeout(() => window.dispatchEvent(new Event('resize')), 1500);`).catch(() => undefined);
    }
    if (/consent\.(youtube|google)\.com/.test(url)) {
      // EU consent page: choose "Reject all" (the privacy-preserving option)
      void wc
        .executeJavaScript(
          `(() => { const b = [...document.querySelectorAll('button, input[type=submit]')].find(x => /reject|отклонить|odbij/i.test(x.innerText || x.value || x.getAttribute('aria-label') || '')); if (b) b.click(); })()`,
        )
        .catch(() => undefined);
    }
  }

  private onNavigate(): void {
    const wc = this.view?.webContents;
    if (!wc) return;
    const url = wc.getURL();
    if (this.mode === 'login' && /^https:\/\/(www|m)\.youtube\.com\//.test(url)) {
      this.emit('signed-in');
      this.hide();
    }
  }

  private async poll(): Promise<void> {
    const wc = this.view?.webContents;
    const target = this.target;
    if (!wc || wc.isDestroyed() || !target || this.mode !== 'play') return;
    let s: YtState | null = null;
    try {
      s = (await wc.executeJavaScript(STATE_JS, true)) as YtState;
    } catch {
      return;
    }
    if (!s || this.target !== target) return;
    if (/google\.[a-z.]+\/sorry|consent\./.test(s.href)) {
      // Google asks to prove we're not a bot: the page is on screen, a mouse/keyboard at the TV can solve it
      return this.report('error', 0, 0, 'YouTube просит подтвердить, что вы не робот — пройдите проверку на экране ТВ');
    }
    if (s.title && s.title !== this.titleSent && s.title !== 'YouTube') {
      this.titleSent = s.title;
      this.emit('title', target.key, s.title);
    }
    if (s.error) {
      this.report('error', s.t, s.d, s.error);
      return;
    }
    if (!s.ready) return this.report('loading', 0, 0);
    if (s.ad) return this.report('loading', 0, 0, undefined);
    this.report(s.ended ? 'ended' : s.paused ? 'paused' : s.waiting ? 'loading' : 'playing', s.t, s.d);
  }

  private report(status: RendererReport['status'], position: number, duration: number, error?: string): void {
    if (!this.target) return;
    this.emit('report', { key: this.target.key, status, position, duration, error } satisfies RendererReport);
  }
}
