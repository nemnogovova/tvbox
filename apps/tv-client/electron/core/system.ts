import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PowerAction } from '@tvbox/shared';

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

// Windows Core Audio via a persistent PowerShell process (compiling the C# shim
// once takes ~1s; afterwards every volume change is instant).
const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
  int j();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public static class TvboxAudio {
  static IAudioEndpointVolume Vol() {
    var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice dev = null;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out dev));
    IAudioEndpointVolume epv = null;
    var epvid = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref epvid, 23, 0, out epv));
    return epv;
  }
  public static float GetVolume() { float v = -1; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v; }
  public static void SetVolume(float v) { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(v, Guid.Empty)); }
  public static bool GetMute() { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
  public static void SetMute(bool m) { Marshal.ThrowExceptionForHR(Vol().SetMute(m, Guid.Empty)); }
}
'@
$inv = [Globalization.CultureInfo]::InvariantCulture
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    $p = $line.Split(' ')
    if ($p[0] -eq 'set') { [TvboxAudio]::SetVolume([float]::Parse($p[1], $inv)) }
    elseif ($p[0] -eq 'mute') { [TvboxAudio]::SetMute($p[1] -eq '1') }
    $v = [TvboxAudio]::GetVolume().ToString($inv)
    $m = if ([TvboxAudio]::GetMute()) { '1' } else { '0' }
    [Console]::Out.WriteLine("ok $v $m")
  } catch {
    [Console]::Out.WriteLine('err')
  }
}
`;

export interface VolumeState {
  volume: number;
  muted: boolean;
}

/** OS master volume. Falls back to an in-memory value when the OS API is unavailable. */
export class SystemVolume {
  private ps: ChildProcessWithoutNullStreams | null = null;
  private queue: ((line: string) => void)[] = [];
  private buf = '';
  state: VolumeState = { volume: 0.5, muted: false };
  available = true;

  private startPs(): ChildProcessWithoutNullStreams | null {
    if (process.platform !== 'win32') return null;
    if (this.ps && !this.ps.killed) return this.ps;
    const scriptFile = path.join(os.tmpdir(), 'tvbox-volume.ps1');
    try {
      fs.writeFileSync(scriptFile, PS_SCRIPT.replace(/\r?\n/g, '\r\n'), 'utf-8');
    } catch {
      this.available = false;
      return null;
    }
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], {
      windowsHide: true,
    });
    ps.stdout.setEncoding('utf-8');
    ps.stdout.on('data', (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line === 'ready' || !line) continue;
        const cb = this.queue.shift();
        cb?.(line);
      }
    });
    ps.on('exit', () => {
      this.ps = null;
      for (const cb of this.queue.splice(0)) cb('err');
    });
    ps.on('error', () => {
      this.available = false;
    });
    this.ps = ps;
    return ps;
  }

  private psCommand(cmd: string): Promise<VolumeState | null> {
    const ps = this.startPs();
    if (!ps) return Promise.resolve(null);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 8000);
      this.queue.push((line) => {
        clearTimeout(t);
        const m = /^ok ([\d.]+) ([01])/.exec(line);
        resolve(m ? { volume: Number(m[1]), muted: m[2] === '1' } : null);
      });
      ps.stdin.write(cmd + '\r\n');
    });
  }

  async refresh(): Promise<VolumeState> {
    if (this.applying) return this.state;
    const s = await this.read();
    // a change from the remote started meanwhile: that one wins over the older reading
    if (s && !this.applying) this.state = s;
    return this.state;
  }

  private async read(): Promise<VolumeState | null> {
    try {
      if (process.platform === 'win32') return await this.psCommand('get');
      if (process.platform === 'darwin') {
        const out = await run('osascript', ['-e', 'get volume settings']);
        const v = /output volume:(\d+)/.exec(out);
        const m = /output muted:(true|false)/.exec(out);
        return v ? { volume: Number(v[1]) / 100, muted: m?.[1] === 'true' } : null;
      }
      const out = await run('pactl', ['get-sink-volume', '@DEFAULT_SINK@']);
      const mute = await run('pactl', ['get-sink-mute', '@DEFAULT_SINK@']);
      const v = /(\d+)%/.exec(out);
      return v ? { volume: Number(v[1]) / 100, muted: /yes/.test(mute) } : null;
    } catch {
      return null;
    }
  }

  /** Volume asked for but not yet handed to the OS (presses in a row collapse into the last one). */
  private want: number | null = null;
  private applying: Promise<void> | null = null;

  /**
   * Answers at once with the new volume; the OS is updated in the background. Several quick
   * changes (phone volume keys held down) end in one OS call with the latest value instead of a
   * queue — and late OS answers no longer drag the reported volume back to an older value.
   */
  async setVolume(volume: number): Promise<VolumeState> {
    const v = Math.max(0, Math.min(1, volume));
    this.state = { volume: v, muted: false };
    this.want = v;
    if (!this.applying) this.applying = this.apply().finally(() => (this.applying = null));
    return this.state;
  }

  /** Wait until the OS has the last requested volume (tests, shutdown). */
  async settled(): Promise<VolumeState> {
    while (this.applying) await this.applying;
    return this.state;
  }

  private async apply(): Promise<void> {
    while (this.want !== null) {
      const v = this.want;
      this.want = null;
      try {
        if (process.platform === 'win32') {
          const s = (await this.psCommand(`set ${v.toFixed(3)}`)) && (await this.psCommand('mute 0'));
          if (s && this.want === null) this.state = s;
        } else if (process.platform === 'darwin') {
          await run('osascript', ['-e', `set volume output volume ${Math.round(v * 100)} without output muted`]);
        } else {
          await run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${Math.round(v * 100)}%`]);
          await run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', '0']);
        }
      } catch {
        // keep the in-memory value
      }
    }
  }

  async setMuted(muted: boolean): Promise<VolumeState> {
    this.state = { ...this.state, muted };
    try {
      if (process.platform === 'win32') {
        const s = await this.psCommand(`mute ${muted ? 1 : 0}`);
        if (s) this.state = s;
      } else if (process.platform === 'darwin') {
        await run('osascript', ['-e', `set volume output muted ${muted}`]);
      } else {
        await run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', muted ? '1' : '0']);
      }
    } catch {
      // ignore
    }
    return this.state;
  }

  dispose(): void {
    try {
      this.ps?.stdin.end();
      this.ps?.kill();
    } catch {
      // ignore
    }
  }
}

export async function powerAction(action: Exclude<PowerAction, 'restart-app'>): Promise<void> {
  if (process.platform === 'win32') {
    if (action === 'sleep') {
      await run('powershell.exe', [
        '-NoProfile',
        '-Command',
        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)",
      ]);
    } else {
      await run('shutdown.exe', [action === 'shutdown' ? '/s' : '/r', '/t', '0', '/f']);
    }
  } else if (process.platform === 'darwin') {
    const map = { sleep: 'sleep', shutdown: 'shut down', reboot: 'restart' } as const;
    await run('osascript', ['-e', `tell app "System Events" to ${map[action]}`]);
  } else {
    const map = { sleep: 'suspend', shutdown: 'poweroff', reboot: 'reboot' } as const;
    await run('systemctl', [map[action]]);
  }
}
