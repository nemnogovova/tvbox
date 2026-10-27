import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { app, nativeImage, shell } from 'electron';
import type { AppEntry, AppsState, AppWindow } from '@tvbox/shared';
import type { DesktopHelper, RawAppsListing, RawWindow } from './desktop';
import type { TvDatabase } from './db';

type Override = Partial<Pick<AppEntry, 'name' | 'hidden' | 'pinned' | 'fullscreen' | 'args' | 'lastLaunchedAt'>>;

// Start menu entries that are not programs one would launch from a sofa
const JUNK_NAME =
  /uninstall|удал(ить|ение)|deinstall|readme|read me|help|справк|documentation|документац|license|лиценз|web ?site|веб-сайт|сайт|release notes|changelog|manual|руководство|support|поддержк|faq|what's new|что нового|\bsetup\b|repair|восстановлен|configure|настройк[аи] .*(сервер|драйвер)|debug|safe mode|report|crash|feedback|sdk|command prompt|командная строка/i;
const JUNK_TARGET = /\\(unins\d*|uninstall\w*|uninst|setup|install\w*|vc_?redist\w*|dxsetup|crashreport\w*|helper|updater?|update)\.exe$/i;
// Folders of Windows' own tools: listed, but hidden by default
const SYSTEM_FOLDER =
  /^(windows (accessories|administrative tools|system|powershell|tools|ease of access|kits)|accessibility|administrative tools|system tools|стандартные|служебные|средства администрирования|специальные возможности|windows powershell|инструменты windows|maintenance|startup|автозагрузка)/i;
const SYSTEM_STORE = /^(microsoft\.windows\.|windows\.|microsoft\.(aad|accounts|bing(news|weather)?|getstarted|people|windowsfeedbackhub|yourphone|windowsmaps|windowsalarms|windowscamera|windowssoundrecorder|windowscommunicationsapps|zunevideo|xboxgamecallableui|xboxidentityprovider|549981c3f5f10|ecapp|lockapp|sechealthui|win32webviewhost|desktopappinstaller|storepurchaseapp|vclibs|net\.native|ui\.xaml|services\.store|todos|powerautomatedesktop|windowsterminal|devhome|outlookforwindows|copilot|gethelp|messagingapp|office\.onenote|microsoftofficehub|clipchamp))/i;
const LAUNCHABLE_URL = /^(steam|com\.epicgames\.launcher|uplay|origin2?|battlenet|goggalaxy|heroic|itch|xbox|ms-[a-z-]+):/i;

const hash = (s: string) => crypto.createHash('sha1').update(s.toLowerCase()).digest('hex').slice(0, 12);
const clean = (s: string | undefined | null) => (s ? String(s).replace(/^"|"$/g, '').trim() : '');
const exists = (p: string) => {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
};
/** "C:\x\app.exe,0" -> "C:\x\app.exe" */
const iconPath = (s?: string | null) => clean((s || '').replace(/,\s*-?\d+$/, ''));

interface Draft extends Omit<AppEntry, 'id' | 'fullscreen'> {
  key: string;
  iconSource?: string;
  dir?: string;
  defaultHidden?: boolean;
}

interface Tracked {
  appId: string;
  name: string;
  kind: AppEntry['kind'];
  pid: number;
  startedAt: number;
  /** windows of this program that are open right now */
  windows: Set<string>;
  everHadWindow: boolean;
  lastWindowAt: number;
  fullscreen: boolean;
  /** windows that existed before the launch */
  before: Set<string>;
  /** windows already stretched / centered */
  handled: Set<string>;
  /** windows seen in the previous poll (stretched only once they settle) */
  seen: Set<string>;
}

// Launchers and helpers that open their own windows when a game starts through them
const LAUNCHER_EXE = /\\(steam|steamwebhelper|steamservice|epicgameslauncher|epicwebhelper|galaxyclient|galaxyclient helper|upc|uplaywebcore|battle\.net|agent|eadesktop|eabackgroundservice|origin|explorer|searchhost|startmenuexperiencehost|shellexperiencehost|textinputhost|systemsettings)\.exe$/i;

export class AppLauncher extends EventEmitter {
  private apps: (AppEntry & { dir?: string; iconSource?: string })[] = [];
  private loading: Promise<void> | null = null;
  private loadedAt = 0;
  private iconCache = new Map<string, string | undefined>();
  private tracked: Tracked[] = [];
  private state: AppsState = { windows: [], tvboxForeground: true, launching: null };
  private stateJson = '';
  private pollTimer: NodeJS.Timeout | null = null;
  private exeIcons = new Map<string, string | undefined>();
  /** Why the list could not be built (shown on the remote) */
  private error: string | null = null;

  constructor(
    private readonly helper: DesktopHelper,
    private readonly db: TvDatabase,
    /** Native window handle of the TVBox window (decimal string) */
    private readonly tvboxHwnd: () => string | null,
    /** Bring TVBox back to the front */
    private readonly restoreTvbox: () => void,
  ) {
    super();
    const cached = db.getJson<AppEntry[]>('apps:cache');
    if (Array.isArray(cached)) this.apps = cached;
  }

  get available(): boolean {
    return this.helper.available;
  }

  // ------------------------------------------------------------------ catalogue of programs
  private overrides(): Record<string, Override> {
    return this.db.getJson<Record<string, Override>>('apps:overrides') || {};
  }

  private setOverride(id: string, patch: Override): void {
    const all = this.overrides();
    all[id] = { ...(all[id] || {}), ...patch };
    this.db.setJson('apps:overrides', all);
  }

  private custom(): (AppEntry & { dir?: string })[] {
    return this.db.getJson<(AppEntry & { dir?: string })[]>('apps:custom') || [];
  }

  async list(opts: { refresh?: boolean; includeHidden?: boolean } = {}): Promise<AppEntry[]> {
    const stale = Date.now() - this.loadedAt > 10 * 60 * 1000;
    if (opts.refresh || !this.loadedAt) {
      const p = this.load();
      // first open: answer with the cached list right away if we have one
      if (opts.refresh || !this.apps.length) await p;
    } else if (stale) void this.load();
    const list = this.view(opts.includeHidden);
    if (!list.length && this.error) throw new Error(this.error);
    return list;
  }

  private view(includeHidden = false): AppEntry[] {
    const ov = this.overrides();
    const out: AppEntry[] = [];
    for (const a of [...this.custom(), ...this.apps]) {
      const o = ov[a.id] || {};
      const e: AppEntry = {
        id: a.id,
        name: o.name || a.name,
        kind: a.kind,
        target: a.target,
        args: o.args ?? a.args,
        icon: a.icon,
        fullscreen: o.fullscreen ?? a.fullscreen,
        hidden: o.hidden ?? a.hidden,
        pinned: o.pinned ?? a.pinned,
        lastLaunchedAt: o.lastLaunchedAt ?? a.lastLaunchedAt,
      };
      if (e.hidden && !includeHidden) continue;
      out.push(e);
    }
    return out.sort(
      (a, b) =>
        Number(!!b.pinned) - Number(!!a.pinned) ||
        (b.lastLaunchedAt || 0) - (a.lastLaunchedAt || 0) ||
        a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' }),
    );
  }

  private load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const t0 = Date.now();
        // shortcuts and Steam are read directly; only Store apps need PowerShell (optional)
        const [shortcuts, steamPath, store] = await Promise.all([
          collectShortcuts().catch((e) => {
            console.error('[apps] shortcuts', e);
            return [];
          }),
          readSteamPath(),
          this.helper.available ? this.helper.storeApps().catch(() => null) : Promise.resolve(null),
        ]);
        const raw: RawAppsListing = { shortcuts, steamPath, store: store || [], registry: [] };
        const drafts = this.collect(raw);
        console.log(`[apps] ${shortcuts.length} shortcuts, ${store?.length ?? 'no'} store apps, steam: ${steamPath || '—'} → ${drafts.length} programs in ${Date.now() - t0} ms`);
        this.error = drafts.length ? null : this.helper.failure || 'Не нашлось ни одной программы';
        const apps = await Promise.all(
          drafts.map(async (d) => ({
            id: d.key,
            name: d.name,
            kind: d.kind,
            target: d.target,
            args: d.args,
            dir: d.dir,
            iconSource: d.iconSource,
            icon: await this.icon(d.iconSource || d.target),
            fullscreen: true,
            hidden: d.defaultHidden,
          })),
        );
        this.apps = apps;
        this.loadedAt = Date.now();
        this.db.setJson('apps:cache', apps);
      } catch (e) {
        console.error('[apps] listing failed', e);
        this.error = (e as Error).message || 'listing_failed';
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  private collect(raw: RawAppsListing): Draft[] {
    const out: Draft[] = [];
    const byTarget = new Set<string>();
    const byName = new Set<string>();
    const norm = (s: string) => s.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '');
    const add = (d: Draft) => {
      const t = d.target.toLowerCase() + '|' + (d.args || '').toLowerCase();
      const n = norm(d.name);
      if (byTarget.has(t) || byName.has(n)) return;
      byTarget.add(t);
      byName.add(n);
      out.push(d);
    };
    const list = <T>(x: T[] | T | undefined): T[] => (Array.isArray(x) ? x : x ? [x] : []);

    // Steam library first: proper names and the game's own icon
    for (const g of steamGames(raw.steamPath)) {
      add({ key: hash(`steam://rungameid/${g.appId}`), name: g.name, kind: 'steam', target: `steam://rungameid/${g.appId}`, iconSource: g.icon });
    }
    for (const s of list(raw.shortcuts)) {
      const name = clean(s.name);
      if (!name || JUNK_NAME.test(name)) continue;
      if (s.url !== undefined) {
        const url = clean(s.url);
        if (!LAUNCHABLE_URL.test(url)) continue;
        add({
          key: hash(url),
          name,
          kind: /^steam:/i.test(url) ? 'steam' : 'desktop',
          target: url,
          iconSource: iconPath(s.icon) || undefined,
        });
        continue;
      }
      const target = clean(s.target);
      // shortcuts to documents / folders are not programs
      if (target && !/\.(exe|bat|cmd|com|msc)$/i.test(target)) continue;
      if (target && (JUNK_TARGET.test(target) || /\\windows\\(system32|syswow64)\\(cmd|msiexec|rundll32)\.exe$/i.test(target))) continue;
      if (target && !exists(target)) continue;
      const icon = iconPath(s.icon);
      add({
        key: hash((target || s.path) + '|' + (s.args || '')),
        name,
        kind: 'desktop',
        // MSI "advertised" shortcuts have no target: launch the .lnk itself
        target: target || s.path,
        args: target ? s.args || undefined : undefined,
        dir: s.dir || (target ? path.dirname(target) : undefined),
        iconSource: icon && exists(icon) && !/\.(dll)$/i.test(icon) ? icon : target || s.path,
        defaultHidden: SYSTEM_FOLDER.test(s.folder || '') || /\\windows\\/i.test(target),
      });
    }
    for (const s of list(raw.store)) {
      const name = clean(s.name);
      if (!name || JUNK_NAME.test(name)) continue;
      add({
        key: hash(s.appId),
        name,
        kind: 'store',
        target: `shell:AppsFolder\\${s.appId}`,
        iconSource: s.logo || undefined,
        defaultHidden: SYSTEM_STORE.test(s.appId),
      });
    }
    for (const r of list(raw.registry)) {
      const name = clean(r.name);
      const exe = iconPath(r.icon);
      if (!name || JUNK_NAME.test(name) || !/\.exe$/i.test(exe) || JUNK_TARGET.test(exe) || !exists(exe)) continue;
      if (/\\windows\\|\\microsoft\\edgeupdate|\\installer\\/i.test(exe)) continue;
      add({ key: hash(exe + '|'), name, kind: 'desktop', target: exe, dir: path.dirname(exe), iconSource: exe });
    }
    return out;
  }

  private async icon(source?: string): Promise<string | undefined> {
    if (!source) return undefined;
    if (this.iconCache.has(source)) return this.iconCache.get(source);
    let url: string | undefined;
    try {
      if (/^(shell:|[a-z0-9.+-]{2,}:\/\/|steam:)/i.test(source)) url = undefined;
      else if (/\.(png|jpe?g|ico|bmp)$/i.test(source)) {
        const img = nativeImage.createFromPath(source);
        if (!img.isEmpty()) url = img.resize({ width: 64, height: 64, quality: 'best' }).toDataURL();
      } else if (exists(source)) {
        const img = await app.getFileIcon(source, { size: 'large' });
        if (!img.isEmpty()) url = img.toDataURL();
      }
    } catch {
      url = undefined;
    }
    this.iconCache.set(source, url);
    return url;
  }

  // ------------------------------------------------------------------ custom programs
  async addCustom(file: string, name?: string): Promise<AppEntry> {
    const p = path.resolve(String(file || ''));
    if (!/\.(exe|lnk|url|bat|cmd)$/i.test(p) || !exists(p)) throw new Error('not_found');
    const entry: AppEntry & { dir?: string } = {
      id: hash('custom|' + p),
      name: (name || '').trim() || path.basename(p).replace(/\.(exe|lnk|url|bat|cmd)$/i, ''),
      kind: 'custom',
      target: p,
      dir: path.dirname(p),
      icon: await this.icon(p),
      fullscreen: true,
      pinned: true,
    };
    const list = this.custom().filter((c) => c.id !== entry.id);
    list.unshift(entry);
    this.db.setJson('apps:custom', list);
    return entry;
  }

  update(id: string, patch: Override): AppEntry | null {
    const clean: Override = {};
    if (typeof patch.name === 'string') clean.name = patch.name.trim().slice(0, 80) || undefined;
    if (typeof patch.hidden === 'boolean') clean.hidden = patch.hidden;
    if (typeof patch.pinned === 'boolean') clean.pinned = patch.pinned;
    if (typeof patch.fullscreen === 'boolean') clean.fullscreen = patch.fullscreen;
    if (typeof patch.args === 'string') clean.args = patch.args.slice(0, 500);
    this.setOverride(id, clean);
    return this.view(true).find((a) => a.id === id) || null;
  }

  remove(id: string): void {
    const list = this.custom();
    if (list.some((c) => c.id === id)) this.db.setJson('apps:custom', list.filter((c) => c.id !== id));
    else this.setOverride(id, { hidden: true });
  }

  private find(id: string) {
    return [...this.custom(), ...this.apps].find((a) => a.id === id);
  }

  // ------------------------------------------------------------------ running programs
  async launch(id: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.available) return { ok: false, error: 'not_supported' };
    const a = this.find(id);
    if (!a) return { ok: false, error: 'not_found' };
    const view = this.view(true).find((x) => x.id === id);
    const name = view?.name || a.name;
    // already running: just bring it to the front
    const running = this.tracked.find((t) => t.appId === id && t.windows.size > 0);
    if (running) {
      const h = Array.from(running.windows)[0];
      this.hideTvbox();
      await this.helper.focus(h);
      this.schedule(400);
      return { ok: true };
    }
    const before = new Set((await this.helper.windows()).map((w) => w.hwnd));
    let file = a.target;
    let args = view?.args ?? a.args;
    if (a.kind === 'store') {
      file = 'explorer.exe';
      args = a.target;
    }
    this.state = { ...this.state, launching: { appId: id, name } };
    this.emit('launching', { name, icon: a.icon });
    this.publish(true);
    let pid = 0;
    try {
      if (this.helper.isReady) pid = await this.helper.launch(file, args, a.dir);
      else await launchWithoutHelper(a.kind, a.target, args, a.dir);
    } catch (e) {
      this.state = { ...this.state, launching: null };
      this.emit('launch-failed', name);
      this.publish(true);
      return { ok: false, error: (e as Error).message || 'launch_failed' };
    }
    this.setOverride(id, { lastLaunchedAt: Date.now() });
    this.tracked = this.tracked.filter((t) => t.appId !== id);
    this.tracked.push({
      appId: id,
      name,
      kind: a.kind,
      pid,
      startedAt: Date.now(),
      windows: new Set(),
      everHadWindow: false,
      lastWindowAt: 0,
      fullscreen: view?.fullscreen ?? true,
      before,
      handled: new Set(),
      seen: new Set(),
    });
    this.schedule(400);
    return { ok: true };
  }

  async close(opts: { hwnd?: string; appId?: string; force?: boolean }): Promise<{ ok: boolean; error?: string }> {
    const windows = await this.helper.windows();
    let targets: RawWindow[] = [];
    if (opts.hwnd) targets = windows.filter((w) => w.hwnd === opts.hwnd);
    else if (opts.appId) {
      const t = this.tracked.find((x) => x.appId === opts.appId);
      targets = windows.filter((w) => t?.windows.has(w.hwnd));
    }
    if (!targets.length) return { ok: false, error: 'not_found' };
    if (opts.force) {
      const pids = Array.from(new Set(targets.map((w) => w.pid)));
      await Promise.all(pids.map((pid) => killTree(pid)));
    } else {
      for (const w of targets) await this.helper.close(w.hwnd);
    }
    this.schedule(600);
    return { ok: true };
  }

  async focus(hwnd: string | 'tvbox'): Promise<{ ok: boolean }> {
    if (hwnd === 'tvbox') this.showTvbox();
    else {
      this.hideTvbox();
      await this.helper.focus(hwnd);
    }
    this.schedule(400);
    return { ok: true };
  }

  async windowAction(hwnd: string, action: string): Promise<{ ok: boolean; error?: string }> {
    if (action === 'fullscreen') {
      this.hideTvbox();
      await this.helper.focus(hwnd);
      const r = await this.helper.borderless(hwnd);
      this.schedule(400);
      return r === 'small' ? { ok: false, error: 'window_fixed_size' } : { ok: true };
    }
    if (action === 'maximize') await this.helper.show(hwnd, 3);
    else if (action === 'minimize') await this.helper.show(hwnd, 6);
    else return { ok: false, error: 'bad_action' };
    this.schedule(400);
    return { ok: true };
  }

  getState(): AppsState {
    return this.state;
  }

  /** Start watching windows (called once at startup). */
  start(): void {
    if (!this.available) return;
    this.helper.warm();
    this.schedule(3000);
    // have the list ready by the time someone opens "Games" on the remote
    setTimeout(() => void this.load(), 8000);
  }

  /** Mouse / keyboard / window control availability (PowerShell helper). */
  get controlError(): string | null {
    return this.helper.failure;
  }

  private hideTvbox(): void {
    this.emit('hide-tvbox');
  }

  private showTvbox(): void {
    this.restoreTvbox();
    const own = this.tvboxHwnd();
    if (own) void this.helper.focus(own);
  }

  private schedule(ms: number): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.poll(), ms);
  }

  private async poll(): Promise<void> {
    this.pollTimer = null;
    let next = 5000;
    try {
      const raw = await this.helper.windows();
      const own = this.tvboxHwnd();
      const now = Date.now();
      const live = new Set(raw.map((w) => w.hwnd));
      const fg = raw.find((w) => w.fg);
      const owner = (h: string) => this.tracked.find((t) => t.windows.has(h));

      for (const t of this.tracked) {
        for (const h of Array.from(t.windows)) if (!live.has(h)) t.windows.delete(h);
        // Steam / Epic / store apps start through a launcher: their game window may take a while
        const grace = t.kind === 'steam' || t.kind === 'store' || /^[a-z][a-z0-9+.-]*:/i.test(this.find(t.appId)?.target || '') ? 120_000 : 45_000;
        for (const w of raw) {
          if (t.before.has(w.hwnd) || t.windows.has(w.hwnd) || owner(w.hwnd) || w.hwnd === own) continue;
          const mine = w.pid === t.pid && t.pid > 0;
          if (!mine && (now - t.startedAt > grace || LAUNCHER_EXE.test(w.exe || ''))) continue;
          t.windows.add(w.hwnd);
        }
        if (t.windows.size) {
          if (!t.everHadWindow) {
            t.everHadWindow = true;
            // the program is on screen: get TVBox out of the way
            this.hideTvbox();
            void this.helper.focus(Array.from(t.windows)[0]);
            if (this.state.launching?.appId === t.appId) {
              this.state = { ...this.state, launching: null };
              this.emit('launched', t.name);
            }
          }
          t.lastWindowAt = now;
        }
        // make the program fill the screen once its window settled
        if (t.fullscreen) {
          for (const h of t.windows) {
            if (t.handled.has(h) || !t.seen.has(h)) continue;
            const w = raw.find((x) => x.hwnd === h);
            if (!w || w.min) continue;
            t.handled.add(h);
            void this.helper.borderless(h);
          }
        }
        t.seen = new Set(t.windows);
      }

      // programs we launched that are gone (no windows for a few seconds)
      const finished = this.tracked.filter((t) => t.everHadWindow && !t.windows.size && now - t.lastWindowAt > 2500);
      const expired = this.tracked.filter((t) => !t.everHadWindow && now - t.startedAt > 150_000);
      if (expired.some((t) => this.state.launching?.appId === t.appId)) {
        this.state = { ...this.state, launching: null };
        this.emit('launch-failed', expired[0].name);
      }
      if (finished.length || expired.length) {
        this.tracked = this.tracked.filter((t) => !finished.includes(t) && !expired.includes(t));
        const othersOnScreen = this.tracked.some((t) => t.windows.size > 0);
        if (finished.length && !othersOnScreen) this.showTvbox();
      }

      const windows: AppWindow[] = [];
      for (const w of raw) {
        if (w.hwnd === own) continue;
        if (w.exe && !this.exeIcons.has(w.exe)) this.exeIcons.set(w.exe, await this.icon(w.exe));
        const t = owner(w.hwnd);
        const entry = t ? this.find(t.appId) : undefined;
        windows.push({
          hwnd: w.hwnd,
          title: w.title,
          pid: w.pid,
          exe: w.exe ? path.basename(w.exe) : undefined,
          appId: t?.appId,
          icon: entry?.icon ?? this.exeIcons.get(w.exe),
          foreground: w.fg,
          minimized: w.min,
        });
      }
      // programs launched from TVBox first, then the rest
      windows.sort((a, b) => Number(!!b.appId) - Number(!!a.appId) || Number(!!b.foreground) - Number(!!a.foreground));

      this.state = {
        windows,
        tvboxForeground: !fg || fg.hwnd === own,
        launching: this.state.launching,
      };
      this.publish();
      next = this.tracked.length || this.state.launching ? 700 : windows.length ? 2500 : 4000;
    } catch (e) {
      console.error('[apps] poll', e);
    }
    this.schedule(next);
  }

  private publish(force = false): void {
    const json = JSON.stringify(this.state);
    if (!force && json === this.stateJson) return;
    this.stateJson = json;
    this.emit('state', this.state);
  }

  /** A program (not TVBox) is in front right now */
  get appInFront(): boolean {
    return !this.state.tvboxForeground;
  }

  dispose(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.helper.dispose();
  }
}

/** Start menu and desktop shortcuts (.lnk / .url), read with Electron (no PowerShell needed). */
export async function collectShortcuts(): Promise<NonNullable<RawAppsListing['shortcuts']>> {
  if (process.platform !== 'win32') return [];
  const home = os.homedir();
  const programData = process.env.ProgramData || 'C:\\ProgramData';
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const roots: { dir: string; desktop: boolean }[] = [
    { dir: path.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), desktop: false },
    { dir: path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), desktop: false },
    { dir: path.join(home, 'Desktop'), desktop: true },
    { dir: path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop'), desktop: true },
    { dir: path.join(home, 'OneDrive', 'Desktop'), desktop: true },
  ];
  const out: NonNullable<RawAppsListing['shortcuts']> = [];
  const walk = async (dir: string, depth: number, desktop: boolean) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!desktop && depth < 4) await walk(full, depth + 1, desktop);
        continue;
      }
      const ext = path.extname(e.name).toLowerCase();
      const name = e.name.slice(0, -ext.length);
      const folder = path.basename(dir);
      if (ext === '.lnk') {
        try {
          const l = shell.readShortcutLink(full);
          out.push({ name, path: full, folder, desktop, target: l.target || '', args: l.args || '', icon: l.icon || '', dir: l.cwd || '' });
        } catch {
          // MSI "advertised" shortcut: no readable target, launch the .lnk itself
          out.push({ name, path: full, folder, desktop, target: '', args: '', icon: '', dir: '' });
        }
      } else if (ext === '.url') {
        try {
          const txt = await fs.promises.readFile(full, 'utf-8');
          const url = /^URL=(.*)$/m.exec(txt)?.[1]?.trim() || '';
          const icon = /^IconFile=(.*)$/m.exec(txt)?.[1]?.trim() || '';
          out.push({ name, path: full, folder, desktop, url, icon });
        } catch {
          // unreadable
        }
      }
    }
  };
  for (const r of roots) await walk(r.dir, 0, r.desktop);
  return out;
}

/** Steam install folder (registry, then the usual places). */
export function readSteamPath(): Promise<string | null> {
  const guesses = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Steam'),
  ];
  const fallback = () => guesses.find((g) => exists(path.join(g, 'steamapps'))) || null;
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      const m = /SteamPath\s+REG_SZ\s+(.+)/i.exec(String(stdout || ''));
      const p = m ? path.normalize(m[1].trim()) : null;
      resolve(!err && p && exists(p) ? p : fallback());
    });
  });
}

/** Launch without the PowerShell helper (no pid, windows are matched by time). */
async function launchWithoutHelper(kind: AppEntry['kind'], target: string, args?: string, dir?: string): Promise<void> {
  if (kind === 'store' || /^shell:/i.test(target)) {
    spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:\\/i.test(target)) {
    await shell.openExternal(target);
    return;
  }
  if (args && /\.(exe|bat|cmd)$/i.test(target)) {
    spawn(target, args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((x) => x.replace(/^"|"$/g, '')) || [], {
      cwd: dir && exists(dir) ? dir : path.dirname(target),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    }).unref();
    return;
  }
  const err = await shell.openPath(target);
  if (err) throw new Error(err);
}

const STEAM_TOOLS = /^(steamworks|steam linux runtime|proton|steamvr|steam controller|spacewar|source sdk|dedicated server|redistributable)/i;

/** Installed Steam games (libraryfolders.vdf + appmanifest_*.acf). */
export function steamGames(steamPath?: string | null): { appId: string; name: string; icon?: string }[] {
  if (!steamPath) return [];
  const root = path.normalize(steamPath);
  const libs = new Set<string>([root]);
  try {
    const vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf-8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(path.normalize(m[1].replace(/\\\\/g, '\\')));
  } catch {
    // no library file
  }
  const cache = path.join(root, 'appcache', 'librarycache');
  const out: { appId: string; name: string; icon?: string }[] = [];
  for (const lib of libs) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(path.join(lib, 'steamapps')).filter((f) => /^appmanifest_\d+\.acf$/i.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const acf = fs.readFileSync(path.join(lib, 'steamapps', f), 'utf-8');
        const appId = /"appid"\s+"(\d+)"/i.exec(acf)?.[1];
        const name = /"name"\s+"([^"]+)"/i.exec(acf)?.[1];
        if (!appId || !name || appId === '228980' || STEAM_TOOLS.test(name)) continue;
        if (out.some((g) => g.appId === appId)) continue;
        let icon: string | undefined;
        for (const c of [path.join(cache, `${appId}_icon.jpg`), path.join(cache, appId, 'icon.jpg')]) if (exists(c)) icon = icon || c;
        if (!icon) {
          // newer Steam: librarycache/<appid>/<hash>.jpg — the smallest jpg is the icon
          try {
            const dir = path.join(cache, appId);
            const jpgs = fs
              .readdirSync(dir)
              .filter((x) => /^[0-9a-f]{40}\.jpg$/i.test(x))
              .map((x) => ({ x, size: fs.statSync(path.join(dir, x)).size }))
              .sort((a, b) => a.size - b.size);
            if (jpgs[0]) icon = path.join(dir, jpgs[0].x);
          } catch {
            // no cache
          }
        }
        out.push({ appId, name, icon });
      } catch {
        // unreadable manifest
      }
    }
  }
  return out;
}

function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      try {
        process.kill(pid);
      } catch {
        // gone
      }
      return resolve();
    }
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}
