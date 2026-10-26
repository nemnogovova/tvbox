import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app } from 'electron';
import type { ReleaseInfo, ReleasesManifest } from '@tvbox/shared';

/** "1.10.2" > "1.9.9" */
export function newerVersion(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

/**
 * Checks the TVBox server for a newer Windows build and installs it on request
 * (silent NSIS install, then the app is started again).
 */
export class Updater extends EventEmitter {
  latest: ReleaseInfo | null = null;
  private busy = false;

  constructor(private readonly serverUrl: () => string) {
    super();
  }

  get current(): string {
    return app.getVersion();
  }

  get available(): boolean {
    return !!this.latest && newerVersion(this.latest.version, this.current);
  }

  async check(): Promise<ReleaseInfo | null> {
    try {
      const res = await fetch(`${this.serverUrl()}/api/releases`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: ReleasesManifest };
      const win = body.data?.windows || null;
      const wasAvailable = this.available;
      this.latest = win;
      if (this.available && !wasAvailable) this.emit('available', win);
      return win;
    } catch {
      return null;
    }
  }

  async install(): Promise<{ ok: boolean; error?: string }> {
    if (this.busy) return { ok: true };
    await this.check();
    if (!this.latest || !this.available) return { ok: false, error: 'no_update' };
    if (process.platform !== 'win32' || !app.isPackaged) return { ok: false, error: 'not_supported' };
    this.busy = true;
    try {
      const url = new URL(this.latest.url, this.serverUrl()).toString();
      const file = path.join(os.tmpdir(), `TVBox-Setup-${this.latest.version}.exe`);
      this.emit('progress', 0);
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
      const total = Number(res.headers.get('content-length') || this.latest.size || 0);
      const out = fs.createWriteStream(file);
      let got = 0;
      let lastPct = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
        const pct = total ? Math.floor((got / total) * 100) : 0;
        if (pct >= lastPct + 10) {
          lastPct = pct;
          this.emit('progress', pct);
        }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      if (this.latest.size && got !== this.latest.size) throw new Error('download incomplete');
      // Give TVBox ~3 s to quit, then install silently (/S) and start it again (--force-run)
      const child = spawn('cmd.exe', ['/d', '/c', `ping -n 4 127.0.0.1 >nul & start "" "${file}" /S --force-run`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
      child.unref();
      this.emit('installing');
      setTimeout(() => app.quit(), 300);
      return { ok: true };
    } catch (e) {
      this.busy = false;
      return { ok: false, error: (e as Error).message };
    }
  }
}
