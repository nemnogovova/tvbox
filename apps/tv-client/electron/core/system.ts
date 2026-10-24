import { exec, execFile } from 'node:child_process';
import type { PowerAction } from '@tvbox/shared';

function run(cmd: string, args: string[] = [], opts?: { shell?: boolean }): Promise<string> {
  return new Promise((resolve, reject) => {
    if (opts?.shell) {
      exec(cmd, { windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
      return;
    }
    execFile(cmd, args, { windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

const WINDOWS_VOLUME_SCRIPT = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f1(); int f2(); int f3(); int f4(); int f5(); int f6(); int f7(); int f8(); int f9(); int f10();
  int f11(); int f12(); int f13();
  int SetMasterVolumeLevelScalar(float fLevel, System.Guid ctx);
  int f14();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int f15(); int f16(); int f17();
  int SetMute(bool bMute, System.Guid ctx);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref System.Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int f1();
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public static class Audio {
  static IAudioEndpointVolume GetVolume() {
    var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice device; int hr = enumerator.GetDefaultAudioEndpoint(0, 1, out device);
    var g = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
    IAudioEndpointVolume volume; device.Activate(ref g, 0x17, 0, out volume);
    return volume;
  }
  public static void SetVolume(float level) { GetVolume().SetMasterVolumeLevelScalar(level, Guid.Empty); }
  public static void SetMute(bool mute) { GetVolume().SetMute(mute, Guid.Empty); }
}
'@
if ($args.Length -gt 0) {
  if ($args[0] -eq 'mute') { [Audio]::SetMute([bool]::Parse($args[1])) }
  else { [Audio]::SetVolume([float]::Parse($args[0])) }
}
`;

export function platform(): 'win32' | 'darwin' | 'linux' {
  const p = process.platform;
  return p === 'win32' ? 'win32' : p === 'darwin' ? 'darwin' : 'linux';
}

export async function setSystemVolume(volume: number): Promise<void> {
  const v = Math.max(0, Math.min(1, volume));
  try {
    if (platform() === 'win32') {
      await run('powershell', ['-NoProfile', '-Command', WINDOWS_VOLUME_SCRIPT, String(v)]);
    } else if (platform() === 'darwin') {
      await run('osascript', ['-e', `set volume output volume ${Math.round(v * 100)}`]);
    } else {
      await run('amixer', ['-D', 'pulse', 'sset', 'Master', `${Math.round(v * 100)}%`]).catch(() =>
        run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${Math.round(v * 100)}%`]),
      );
    }
  } catch {
    // non-fatal
  }
}

export async function setSystemMuted(muted: boolean): Promise<void> {
  try {
    if (platform() === 'win32') {
      await run('powershell', ['-NoProfile', '-Command', WINDOWS_VOLUME_SCRIPT, 'mute', String(muted)]);
    } else if (platform() === 'darwin') {
      await run('osascript', ['-e', `set volume output muted ${muted ? 'true' : 'false'}`]);
    } else {
      await run('amixer', ['-D', 'pulse', 'sset', 'Master', muted ? 'mute' : 'unmute']).catch(() =>
        run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', muted ? '1' : '0']),
      );
    }
  } catch {
    // non-fatal
  }
}

export async function powerAction(action: PowerAction): Promise<void> {
  if (platform() === 'win32') {
    switch (action) {
      case 'sleep':
        await run('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']);
        break;
      case 'shutdown':
        await run('shutdown', ['/s', '/t', '0']);
        break;
      case 'reboot':
        await run('shutdown', ['/r', '/t', '0']);
        break;
    }
  } else if (platform() === 'darwin') {
    const map: Record<PowerAction, string> = {
      sleep: 'sleep',
      shutdown: 'shut down',
      reboot: 'restart',
    };
    await run('osascript', ['-e', `tell app "System Events" to ${map[action]}`]);
  } else {
    const map: Record<PowerAction, string> = {
      sleep: 'suspend',
      shutdown: 'poweroff',
      reboot: 'reboot',
    };
    await run('systemctl', [map[action]]);
  }
}
