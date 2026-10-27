import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Windows desktop helper: one persistent PowerShell process with a small C# shim
 * (compiled once, ~1 s). It lists windows, launches / closes / focuses programs,
 * stretches windows over the screen and injects mouse & keyboard input.
 *
 * Protocol: "<id> <command> <args…>" per line; commands with id 0 get no answer
 * (used for input events so the touchpad never waits for a round trip).
 * Answers: "<id> <json>".
 */
const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class TvboxDesktop {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion u; }

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder s, ref int size);

  public static void Init() { try { SetProcessDPIAware(); } catch { } }

  static string Esc(string s) {
    if (s == null) return "";
    var sb = new StringBuilder();
    foreach (char c in s) {
      if (c == '"') sb.Append("\\\"");
      else if (c == '\\') sb.Append("\\\\");
      else if (c < 32) sb.Append("\\u" + ((int)c).ToString("x4"));
      else sb.Append(c);
    }
    return sb.ToString();
  }

  static string ExePath(uint pid) {
    IntPtr p = OpenProcess(0x1000, false, pid);
    if (p == IntPtr.Zero) return "";
    try {
      var sb = new StringBuilder(1024); int size = sb.Capacity;
      if (QueryFullProcessImageName(p, 0, sb, ref size)) return sb.ToString();
      return "";
    } finally { CloseHandle(p); }
  }

  public static string Windows(long self) {
    var sb = new StringBuilder("[");
    IntPtr fg = GetForegroundWindow();
    bool first = true;
    var exeCache = new Dictionary<uint, string>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      if (GetWindow(h, 4) != IntPtr.Zero) return true;
      long ex = GetWindowLongPtr(h, -20).ToInt64();
      if ((ex & 0x80) != 0) return true;
      int cloaked = 0;
      try { DwmGetWindowAttribute(h, 14, out cloaked, 4); } catch { }
      if (cloaked != 0) return true;
      int len = GetWindowTextLength(h);
      if (len == 0) return true;
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      string c = cls.ToString();
      if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd") return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == (uint)self) return true;
      var t = new StringBuilder(len + 2); GetWindowText(h, t, len + 2);
      string exe;
      if (!exeCache.TryGetValue(pid, out exe)) { exe = ExePath(pid); exeCache[pid] = exe; }
      if (!first) sb.Append(",");
      first = false;
      sb.Append("{\"hwnd\":\"" + h.ToInt64() + "\",\"pid\":" + pid + ",\"title\":\"" + Esc(t.ToString()) + "\",\"exe\":\"" + Esc(exe) + "\",\"cls\":\"" + Esc(c) + "\",\"fg\":" + (h == fg ? "true" : "false") + ",\"min\":" + (IsIconic(h) ? "true" : "false") + "}");
      return true;
    }, IntPtr.Zero);
    sb.Append("]");
    return sb.ToString();
  }

  public static string Close(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    if (!IsWindow(h)) return "false";
    PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
    return "true";
  }

  public static string Show(long hwnd, int cmd) {
    IntPtr h = new IntPtr(hwnd);
    if (!IsWindow(h)) return "false";
    ShowWindow(h, cmd);
    return "true";
  }

  public static string Focus(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    if (!IsWindow(h)) return "false";
    if (IsIconic(h)) ShowWindow(h, 9);
    IntPtr fg = GetForegroundWindow();
    uint d;
    uint fgThread = GetWindowThreadProcessId(fg, out d);
    uint me = GetCurrentThreadId();
    // a synthetic ALT tap lifts the foreground lock for this process
    Key(0x12, false, 0); Key(0x12, false, 2);
    if (fgThread != 0 && fgThread != me) AttachThreadInput(me, fgThread, true);
    bool ok = SetForegroundWindow(h);
    BringWindowToTop(h);
    if (fgThread != 0 && fgThread != me) AttachThreadInput(me, fgThread, false);
    return ok ? "true" : "false";
  }

  /** Borderless window over the whole monitor (works for most windowed programs). */
  public static string Borderless(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    if (!IsWindow(h)) return "\"gone\"";
    IntPtr mon = MonitorFromWindow(h, 2);
    MONITORINFO mi = new MONITORINFO();
    mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    if (!GetMonitorInfo(mon, ref mi)) return "\"nomonitor\"";
    RECT r; GetWindowRect(h, out r);
    long st = GetWindowLongPtr(h, -16).ToInt64();
    bool covers = r.Left <= mi.rcMonitor.Left && r.Top <= mi.rcMonitor.Top && r.Right >= mi.rcMonitor.Right && r.Bottom >= mi.rcMonitor.Bottom;
    if (covers && (st & 0x00C00000L) != 0x00C00000L) return "\"already\"";
    // fixed-size small windows (dialogs, splash screens, launchers) are left alone
    bool resizable = (st & 0x00040000L) != 0 || (st & 0x00010000L) != 0;
    long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
    long monArea = (long)(mi.rcMonitor.Right - mi.rcMonitor.Left) * (mi.rcMonitor.Bottom - mi.rcMonitor.Top);
    if (!resizable && area * 100 < monArea * 45) return "\"small\"";
    if (!resizable && !IsZoomed(h)) {
      // fixed-size game window: keep its size, just center it and drop the frame
      int w = r.Right - r.Left, hh = r.Bottom - r.Top;
      SetWindowPos(h, IntPtr.Zero, mi.rcMonitor.Left + Math.Max(0, (mi.rcMonitor.Right - mi.rcMonitor.Left - w) / 2), mi.rcMonitor.Top + Math.Max(0, (mi.rcMonitor.Bottom - mi.rcMonitor.Top - hh) / 2), 0, 0, 0x0001 | 0x0004 | 0x0040);
      return "\"centered\"";
    }
    if (IsZoomed(h) || IsIconic(h)) ShowWindow(h, 9);
    st &= ~(0x00C00000L | 0x00040000L | 0x00080000L | 0x00020000L | 0x00010000L);
    SetWindowLongPtr(h, -16, new IntPtr(st));
    long ex = GetWindowLongPtr(h, -20).ToInt64();
    ex &= ~(0x00000001L | 0x00000200L | 0x00020000L | 0x00000100L);
    SetWindowLongPtr(h, -20, new IntPtr(ex));
    SetWindowPos(h, IntPtr.Zero, mi.rcMonitor.Left, mi.rcMonitor.Top, mi.rcMonitor.Right - mi.rcMonitor.Left, mi.rcMonitor.Bottom - mi.rcMonitor.Top, 0x0020 | 0x0040 | 0x0004);
    return "\"ok\"";
  }

  public static string Launch(string file, string args, string dir) {
    var psi = new ProcessStartInfo(file);
    psi.UseShellExecute = true;
    psi.WindowStyle = ProcessWindowStyle.Maximized;
    if (!string.IsNullOrEmpty(args)) psi.Arguments = args;
    if (!string.IsNullOrEmpty(dir) && System.IO.Directory.Exists(dir)) psi.WorkingDirectory = dir;
    var p = Process.Start(psi);
    int id = 0;
    if (p != null) { try { id = p.Id; } catch { } }
    return id.ToString();
  }

  // ---------------------------------------------------------------- input
  static void Send(INPUT i) { SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))); }

  public static void Move(int dx, int dy) {
    POINT p; GetCursorPos(out p);
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    int x = Math.Max(vx, Math.Min(vx + vw - 1, p.X + dx));
    int y = Math.Max(vy, Math.Min(vy + vh - 1, p.Y + dy));
    INPUT i = new INPUT(); i.type = 0;
    i.u.mi.dx = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1));
    i.u.mi.dy = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
    i.u.mi.dwFlags = 0x0001 | 0x8000 | 0x4000;
    Send(i);
  }

  public static void Button(string b, bool down) {
    uint f = b == "right" ? (down ? 0x0008u : 0x0010u) : b == "middle" ? (down ? 0x0020u : 0x0040u) : (down ? 0x0002u : 0x0004u);
    INPUT i = new INPUT(); i.type = 0; i.u.mi.dwFlags = f; Send(i);
  }

  public static void Wheel(int dy, int dx) {
    if (dy != 0) { INPUT i = new INPUT(); i.type = 0; i.u.mi.dwFlags = 0x0800; i.u.mi.mouseData = unchecked((uint)dy); Send(i); }
    if (dx != 0) { INPUT i = new INPUT(); i.type = 0; i.u.mi.dwFlags = 0x01000; i.u.mi.mouseData = unchecked((uint)dx); Send(i); }
  }

  /** flags: 0 down, 2 up; extended keys get 1 added */
  public static void Key(int vk, bool extended, uint flags) {
    INPUT i = new INPUT(); i.type = 1;
    i.u.ki.wVk = (ushort)vk;
    i.u.ki.dwFlags = flags | (extended ? 1u : 0u);
    Send(i);
  }

  public static void Text(string s) {
    foreach (char c in s) {
      INPUT d = new INPUT(); d.type = 1; d.u.ki.wScan = c; d.u.ki.dwFlags = 0x0004; Send(d);
      INPUT u = new INPUT(); u.type = 1; u.u.ki.wScan = c; u.u.ki.dwFlags = 0x0004 | 0x0002; Send(u);
    }
  }
}
'@
[TvboxDesktop]::Init()

# Microsoft Store apps (shell:AppsFolder ids + their logos). Shortcuts and Steam are read by Node.
function Get-TvboxStoreApps {
  $store = New-Object System.Collections.ArrayList
  $pk = @{}
  try { foreach ($p in (Get-AppxPackage -ErrorAction SilentlyContinue)) { $pk[$p.PackageFamilyName] = $p.InstallLocation } } catch { }
  foreach ($a in (Get-StartApps | Where-Object { $_.AppID -like '*!*' })) {
    $parts = $a.AppID.Split('!')
    $logo = $null
    $loc = $pk[$parts[0]]
    if ($loc) {
      try {
        [xml]$m = [IO.File]::ReadAllText((Join-Path $loc 'AppxManifest.xml'))
        $app = @($m.Package.Applications.Application) | Where-Object { $_.Id -eq $parts[1] } | Select-Object -First 1
        $rel = $app.VisualElements.Square44x44Logo
        if (-not $rel) { $rel = $app.VisualElements.Square150x150Logo }
        if ($rel) {
          $full = Join-Path $loc $rel
          $dir = Split-Path $full -Parent
          $base = [IO.Path]::GetFileNameWithoutExtension($full)
          $cands = @(Get-ChildItem -LiteralPath $dir -Filter ($base + '*.png') -ErrorAction SilentlyContinue | Sort-Object { if ($_.Name -match 'targetsize-48(_altform-unplated)?\.png$') { 0 } elseif ($_.Name -match 'scale-200') { 1 } elseif ($_.Name -match 'targetsize-(64|96|256)') { 2 } else { 3 } })
          if ($cands.Count -gt 0) { $logo = $cands[0].FullName } elseif (Test-Path -LiteralPath $full) { $logo = $full }
        }
      } catch { }
    }
    [void]$store.Add(@{ name = $a.Name; appId = $a.AppID; logo = $logo })
  }
  if ($store.Count -eq 0) { return '[]' }
  return (ConvertTo-Json -InputObject @($store) -Compress -Depth 4)
}

[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $sp = $line.IndexOf(' ')
  if ($sp -lt 0) { continue }
  $id = $line.Substring(0, $sp)
  $rest = $line.Substring($sp + 1)
  $p = $rest.Split(' ')
  $out = 'null'
  try {
    switch ($p[0]) {
      'move' { [TvboxDesktop]::Move([int]$p[1], [int]$p[2]) }
      'btn' { [TvboxDesktop]::Button($p[1], $p[2] -eq 'down') }
      'wheel' { [TvboxDesktop]::Wheel([int]$p[1], [int]$p[2]) }
      'key' { [TvboxDesktop]::Key([int]$p[1], $p[2] -eq '1', [uint32]$p[3]) }
      'text' { [TvboxDesktop]::Text([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1]))) }
      'windows' { $out = [TvboxDesktop]::Windows([long]$p[1]) }
      'close' { $out = [TvboxDesktop]::Close([long]$p[1]) }
      'focus' { $out = [TvboxDesktop]::Focus([long]$p[1]) }
      'show' { $out = [TvboxDesktop]::Show([long]$p[1], [int]$p[2]) }
      'borderless' { $out = [TvboxDesktop]::Borderless([long]$p[1]) }
      'launch' {
        $j = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1])) | ConvertFrom-Json
        $out = [TvboxDesktop]::Launch($j.file, $j.args, $j.dir)
      }
      'storeapps' { $out = Get-TvboxStoreApps }
    }
  } catch {
    $msg = $_.Exception.Message -replace '\\', '/' -replace '"', "'" -replace '[\r\n\t]+', ' '
    $out = '{"error":"' + $msg + '"}'
  }
  if ($id -ne '0') { [Console]::Out.WriteLine($id + ' ' + $out) }
}
`;

export interface RawWindow {
  hwnd: string;
  pid: number;
  title: string;
  exe: string;
  cls: string;
  fg: boolean;
  min: boolean;
}

export interface RawAppsListing {
  shortcuts?: { name: string; path: string; folder?: string; desktop?: boolean; target?: string; args?: string; icon?: string; dir?: string; url?: string }[];
  store?: { name: string; appId: string; logo?: string | null }[];
  registry?: { name: string; icon?: string; loc?: string }[];
  steamPath?: string | null;
}

const VK: Record<string, [number, boolean]> = {
  enter: [0x0d, false],
  escape: [0x1b, false],
  backspace: [0x08, false],
  tab: [0x09, false],
  space: [0x20, false],
  delete: [0x2e, true],
  insert: [0x2d, true],
  up: [0x26, true],
  down: [0x28, true],
  left: [0x25, true],
  right: [0x27, true],
  home: [0x24, true],
  end: [0x23, true],
  pageup: [0x21, true],
  pagedown: [0x22, true],
  win: [0x5b, true],
  alt: [0x12, false],
  ctrl: [0x11, false],
  shift: [0x10, false],
  volumeup: [0xaf, true],
  volumedown: [0xae, true],
  mute: [0xad, true],
  playpause: [0xb3, true],
  printscreen: [0x2c, true],
};
for (let i = 1; i <= 12; i++) VK[`f${i}`] = [0x6f + i, false];

export function virtualKey(key: string): [number, boolean] | null {
  const k = key.toLowerCase();
  if (VK[k]) return VK[k];
  if (/^[a-z0-9]$/.test(k)) return [k.toUpperCase().charCodeAt(0), false];
  return null;
}

export class DesktopHelper {
  private ps: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private seq = 1;
  private pending = new Map<string, (v: string) => void>();
  private readyWaiters: (() => void)[] = [];
  private ready = false;
  private stderr = '';
  private lastStart = 0;
  private readyTimer: NodeJS.Timeout | null = null;
  /** Why the helper doesn't work (shown on the remote) */
  failure: string | null = null;
  readonly available = process.platform === 'win32';

  private start(): ChildProcessWithoutNullStreams | null {
    if (!this.available) return null;
    if (this.ps && !this.ps.killed && this.ps.exitCode === null) return this.ps;
    // after a failure don't respawn PowerShell on every touchpad move: retry once a minute
    if (this.failure && Date.now() - this.lastStart < 60000) return null;
    this.lastStart = Date.now();
    const file = path.join(os.tmpdir(), 'tvbox-desktop.ps1');
    try {
      // UTF-8 with BOM so Windows PowerShell 5 reads the script as Unicode
      fs.writeFileSync(file, '\uFEFF' + PS_SCRIPT.replace(/\r?\n/g, '\r\n'), 'utf-8');
    } catch {
      return null;
    }
    this.ready = false;
    this.stderr = '';
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true });
    // compiling the C# part takes ~1–3 s; much longer means something (policy, antivirus) blocks it
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => {
      if (this.ready || this.ps !== ps) return;
      this.fail(`PowerShell-помощник не запустился за 30 с${this.stderr ? `: ${this.stderr}` : ''}`);
      try {
        ps.kill();
      } catch {
        // ignore
      }
    }, 30000);
    ps.stdout.setEncoding('utf-8');
    ps.stderr.setEncoding('utf-8');
    ps.stderr.on('data', (d: string) => {
      console.warn('[desktop]', d.trim().slice(0, 500));
      if (this.stderr.length < 600) this.stderr += d.replace(/\s+/g, ' ').slice(0, 600 - this.stderr.length);
    });
    ps.stdout.on('data', (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, '');
        this.buf = this.buf.slice(i + 1);
        if (line === 'ready') {
          this.ready = true;
          this.failure = null;
          if (this.readyTimer) clearTimeout(this.readyTimer);
          console.log('[desktop] helper ready');
          for (const w of this.readyWaiters.splice(0)) w();
          continue;
        }
        const sp = line.indexOf(' ');
        if (sp < 0) continue;
        const cb = this.pending.get(line.slice(0, sp));
        if (cb) {
          this.pending.delete(line.slice(0, sp));
          cb(line.slice(sp + 1));
        }
      }
    });
    ps.on('exit', (code) => {
      if (this.ps === ps) this.ps = null;
      if (!this.ready) this.fail(`PowerShell-помощник завершился (код ${code})${this.stderr ? `: ${this.stderr}` : ''}`);
      this.ready = false;
      for (const cb of this.pending.values()) cb('null');
      this.pending.clear();
    });
    ps.on('error', (e) => this.fail(`Не удалось запустить PowerShell: ${e.message}`));
    this.ps = ps;
    return ps;
  }

  private fail(reason: string): void {
    this.failure = reason.slice(0, 400);
    console.error('[desktop]', this.failure);
    for (const w of this.readyWaiters.splice(0)) void w;
    for (const cb of this.pending.values()) cb('null');
    this.pending.clear();
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** Warm up (compiling the C# shim takes a moment). */
  warm(): void {
    this.start();
  }

  private write(line: string): boolean {
    const ps = this.start();
    if (!ps) return false;
    const send = () => {
      try {
        ps.stdin.write(line + '\r\n');
      } catch {
        // process died
      }
    };
    if (this.ready) send();
    else if (this.readyWaiters.length < 300) this.readyWaiters.push(send);
    return true;
  }

  /** Fire-and-forget command. */
  fire(cmd: string): void {
    this.write(`0 ${cmd}`);
  }

  call<T = unknown>(cmd: string, timeoutMs = 15000): Promise<T | null> {
    return new Promise((resolve) => {
      const id = String(this.seq++);
      const t = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(id, (raw) => {
        clearTimeout(t);
        try {
          resolve(JSON.parse(raw) as T);
        } catch {
          resolve(null);
        }
      });
      if (!this.write(`${id} ${cmd}`)) {
        clearTimeout(t);
        this.pending.delete(id);
        resolve(null);
      }
    });
  }

  // ---------------------------------------------------------------- windows
  async windows(selfPid = process.pid): Promise<RawWindow[]> {
    const r = await this.call<RawWindow[] | RawWindow>(`windows ${selfPid}`, 8000);
    if (!r) return [];
    return Array.isArray(r) ? r : [r];
  }

  close(hwnd: string): Promise<boolean | null> {
    return this.call<boolean>(`close ${Number(hwnd)}`);
  }

  focus(hwnd: string): Promise<boolean | null> {
    return this.call<boolean>(`focus ${Number(hwnd)}`);
  }

  /** ShowWindow: 3 maximize, 6 minimize, 9 restore */
  show(hwnd: string, cmd: number): Promise<boolean | null> {
    return this.call<boolean>(`show ${Number(hwnd)} ${cmd}`);
  }

  borderless(hwnd: string): Promise<string | null> {
    return this.call<string>(`borderless ${Number(hwnd)}`);
  }

  async launch(file: string, args?: string, dir?: string): Promise<number> {
    const b64 = Buffer.from(JSON.stringify({ file, args: args || '', dir: dir || '' }), 'utf-8').toString('base64');
    const r = await this.call<number | { error: string }>(`launch ${b64}`, 30000);
    if (r && typeof r === 'object' && 'error' in r) throw new Error(r.error);
    return typeof r === 'number' ? r : 0;
  }

  /** Microsoft Store apps (needs the helper). */
  async storeApps(): Promise<NonNullable<RawAppsListing['store']> | null> {
    const r = await this.call<NonNullable<RawAppsListing['store']> | NonNullable<RawAppsListing['store']>[number] | { error: string }>('storeapps', 60000);
    if (!r || (typeof r === 'object' && 'error' in r && !Array.isArray(r))) return null;
    return Array.isArray(r) ? r : [r as NonNullable<RawAppsListing['store']>[number]];
  }

  // ---------------------------------------------------------------- input
  move(dx: number, dy: number): void {
    const x = Math.round(dx);
    const y = Math.round(dy);
    if (x || y) this.fire(`move ${x} ${y}`);
  }

  button(b: 'left' | 'right' | 'middle', down: boolean): void {
    this.fire(`btn ${b} ${down ? 'down' : 'up'}`);
  }

  click(b: 'left' | 'right' | 'middle' = 'left', double = false): void {
    for (let i = 0; i < (double ? 2 : 1); i++) {
      this.button(b, true);
      this.button(b, false);
    }
  }

  wheel(dy: number, dx = 0): void {
    const y = Math.round(dy);
    const x = Math.round(dx);
    if (x || y) this.fire(`wheel ${y} ${x}`);
  }

  key(key: string, mods: string[] = []): boolean {
    const vk = virtualKey(key);
    if (!vk) return false;
    const modKeys = mods.map((m) => virtualKey(m)).filter((x): x is [number, boolean] => !!x);
    for (const [code, ext] of modKeys) this.fire(`key ${code} ${ext ? 1 : 0} 0`);
    this.fire(`key ${vk[0]} ${vk[1] ? 1 : 0} 0`);
    this.fire(`key ${vk[0]} ${vk[1] ? 1 : 0} 2`);
    for (const [code, ext] of modKeys.reverse()) this.fire(`key ${code} ${ext ? 1 : 0} 2`);
    return true;
  }

  text(s: string): void {
    if (!s) return;
    this.fire(`text ${Buffer.from(s.slice(0, 2000), 'utf-8').toString('base64')}`);
  }

  dispose(): void {
    try {
      this.ps?.stdin.end();
      this.ps?.kill();
    } catch {
      // ignore
    }
    this.ps = null;
  }
}
