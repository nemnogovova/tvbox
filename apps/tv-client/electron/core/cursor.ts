import { screen, type BrowserWindow, type WebContents } from 'electron';

/**
 * Hides the mouse pointer over TVBox after a few seconds without movement.
 *
 * Done in the main process because the pointer may sit over any of TVBox's views (the TVBox
 * screen itself or YouTube on top of it), and the old renderer-only approach missed those
 * cases: YouTube's view never heard about it, and Chromium does not repaint the pointer
 * until the mouse moves again, so "cursor: none" set while the mouse was still did nothing.
 * Here the pointer position is polled globally, every view gets the hiding CSS, and a
 * synthetic mouse move at the same spot makes Chromium apply it at once.
 */
export class CursorHider {
  private timer: NodeJS.Timeout | null = null;
  private last = { x: -1, y: -1 };
  private lastMoveAt = Date.now();
  private hidden = false;
  private css = new Map<WebContents, { key: string; url: string }>();

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    /** All web contents drawn in the TV window (TVBox UI, YouTube, …) */
    private readonly targets: () => WebContents[],
    /** TVBox (not some other program) is what the user looks at */
    private readonly tvboxInFront: () => boolean,
    private readonly onActivity: () => void,
    private readonly idleMs = 2500,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 300);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Something was pressed on the remote / keyboard: hide the pointer right away. */
  nudge(): void {
    this.lastMoveAt = 0;
    this.tick();
  }

  private tick(): void {
    const p = screen.getCursorScreenPoint();
    const moved = p.x !== this.last.x || p.y !== this.last.y;
    const now = Date.now();
    if (moved) {
      const first = this.last.x === -1;
      this.last = p;
      if (!first) {
        this.lastMoveAt = now;
        this.onActivity();
        if (this.hidden) this.show();
        return;
      }
    }
    const front = this.tvboxInFront();
    if (!front) {
      if (this.hidden) this.show();
      return;
    }
    if (!this.hidden && now - this.lastMoveAt > this.idleMs) this.hide();
    else if (this.hidden) this.ensure();
  }

  private hide(): void {
    this.hidden = true;
    this.ensure();
    this.kick();
  }

  /** Make sure every view has the CSS (views appear, pages navigate). */
  private ensure(): void {
    const live = new Set(this.targets().filter((wc) => !wc.isDestroyed()));
    for (const wc of Array.from(this.css.keys())) if (!live.has(wc)) this.css.delete(wc);
    let added = false;
    for (const wc of live) {
      const url = wc.getURL();
      const cur = this.css.get(wc);
      if (cur && cur.url === url) continue;
      const entry = { key: '', url };
      this.css.set(wc, entry);
      added = true;
      wc.insertCSS('*, *::before, *::after { cursor: none !important; }', { cssOrigin: 'user' })
        .then((key) => {
          if (this.css.get(wc) === entry && this.hidden) entry.key = key;
          else void wc.removeInsertedCSS(key).catch(() => undefined);
        })
        .catch(() => this.css.delete(wc));
    }
    if (added) setTimeout(() => this.kick(), 60);
  }

  private show(): void {
    this.hidden = false;
    for (const [wc, e] of this.css) if (e.key && !wc.isDestroyed()) void wc.removeInsertedCSS(e.key).catch(() => undefined);
    this.css.clear();
  }

  /** Chromium re-evaluates the pointer only on mouse events: send one where the mouse already is. */
  private kick(): void {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    const b = win.getContentBounds();
    const p = screen.getCursorScreenPoint();
    const x = p.x - b.x;
    const y = p.y - b.y;
    if (x < 0 || y < 0 || x > b.width || y > b.height) return;
    for (const wc of this.targets()) {
      if (wc.isDestroyed()) continue;
      try {
        wc.sendInputEvent({ type: 'mouseMove', x, y });
      } catch {
        // ignore
      }
    }
  }
}
