# Live linkage test of the desktop companion against the REAL ZCode main window (run only with the
# user's go-ahead). ZCode is moved, resized, maximized, minimized and restored through ordinary
# window-management calls (SetWindowPos / ShowWindow): no input injection, nothing written to ZCode.
# At the end the window is put back with its original WINDOWPLACEMENT. The companion runs with a
# temporary data folder and a temporary provider config, so the user's own companion settings and
# ZCode model configuration are never read or written.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$exe = Join-Path $root 'app\bin\BiubiuAI.exe'
$shot = Join-Path $PSScriptRoot 'live-zcode.png'
$tmp = Join-Path $env:TEMP ('mh-live-' + [guid]::NewGuid().ToString('N'))
$data = Join-Path $tmp 'data'
$log = Join-Path $data 'companion.log'
New-Item -ItemType Directory -Path $data -Force | Out-Null
$config = Join-Path $tmp 'provider_config.json'
[IO.File]::WriteAllText($config, '{"schemaVersion":1,"config":{"providerOrder":[],"providerConfigRules":{"providerRules":[]},"modelConfigRules":{"providerModelRules":[],"manualProviderModelRules":[]}}}', (New-Object Text.UTF8Encoding $false))
$env:BIUBIU_AI_DATA_DIR = $data
$env:BIUBIU_AI_CONFIG_PATH = $config
$env:BIUBIU_AI_REFRESH_CATALOG = '0'
Remove-Item Env:BIUBIU_AI_ZCODE_EXE -ErrorAction SilentlyContinue

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public static class L {
  public delegate bool P(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct WP { public int length, flags, showCmd; public PT minPos, maxPos; public R normal; }
  [StructLayout(LayoutKind.Sequential)] public struct MI { public int cbSize; public R monitor, work; public uint flags; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(P p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WP p);
  [DllImport("user32.dll")] public static extern bool SetWindowPlacement(IntPtr h, ref WP p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll", EntryPoint = "GetMonitorInfoW")] public static extern bool GetMonitorInfo(IntPtr m, ref MI info);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out R r, int s);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "QueryFullProcessImageNameW")] public static extern bool QueryFullProcessImageName(IntPtr p, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  public static void PerMonitor() { SetThreadDpiAwarenessContext(new IntPtr(-4)); }
  static bool ImageIs(uint pid, string exe) {
    IntPtr p = OpenProcess(0x1000, false, pid);
    if (p == IntPtr.Zero) return false;
    try { var s = new StringBuilder(1024); uint n = 1024; return QueryFullProcessImageName(p, 0, s, ref n) && string.Equals(Path.GetFileName(s.ToString()), exe, StringComparison.OrdinalIgnoreCase); }
    finally { CloseHandle(p); }
  }
  // Same rule as the companion: a visible, unowned, non-tool Chrome_WidgetWin_1 window with a title.
  public static IntPtr FindMain(string exe) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;
      if ((GetWindowLongPtr(h, -20).ToInt64() & 0x80) != 0) return true;
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      if (c.ToString() != "Chrome_WidgetWin_1" || GetWindowTextLength(h) == 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!ImageIs(pid, exe)) return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }
  public static List<IntPtr> Of(uint pid) {
    var list = new List<IntPtr>();
    EnumWindows((h, x) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static R Rect(IntPtr h) { R r; GetWindowRect(h, out r); return r; }
  public static R Frame(IntPtr h) { R r; if (DwmGetWindowAttribute(h, 9, out r, 16) != 0) GetWindowRect(h, out r); return r; }
  public static R Work(IntPtr h) { var mi = new MI(); mi.cbSize = Marshal.SizeOf(typeof(MI)); GetMonitorInfo(MonitorFromWindow(h, 2), ref mi); return mi.work; }
  public static WP GetPlacement(IntPtr h) { var p = new WP(); p.length = Marshal.SizeOf(typeof(WP)); GetWindowPlacement(h, ref p); return p; }
  public static bool SetPlacement(IntPtr h, WP p) { p.length = Marshal.SizeOf(typeof(WP)); return SetWindowPlacement(h, ref p); }
  // Places the visible frame (without invisible resize borders) at x, y with size w x hh.
  public static bool MoveFrame(IntPtr h, int x, int y, int w, int hh) {
    R r = Rect(h), f = Frame(h);
    int bl = f.L - r.L, bt = f.T - r.T, br = r.Rt - f.Rt, bb = r.B - f.B;
    return SetWindowPos(h, IntPtr.Zero, x - bl, y - bt, w + bl + br, hh + bt + bb, 0x0004 | 0x0010);
  }
  public static bool Shift(IntPtr h, int dx, int dy) { R r = Rect(h); return SetWindowPos(h, IntPtr.Zero, r.L + dx, r.T + dy, 0, 0, 0x0001 | 0x0004 | 0x0010); }
  public static bool Above(IntPtr ours, IntPtr target) {
    int n = 0;
    for (IntPtr h = GetWindow(target, 3); h != IntPtr.Zero && n < 4096; h = GetWindow(h, 3), n++) if (h == ours) return true;
    return false;
  }
}
'@
[L]::PerMonitor()

$script:passed = 0; $script:failed = 0; $script:offset = 0
function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { $script:passed++; [Console]::Out.WriteLine("PASS  $name  $detail") } else { $script:failed++; [Console]::Out.WriteLine("FAIL  $name  $detail") }
}
function Show-Rect($r) { "($($r.L),$($r.T))-($($r.Rt),$($r.B)) $($r.Rt - $r.L)x$($r.B - $r.T)" }
function Show-Expected($e) { "($($e.L),$($e.T))-($($e.R),$($e.B))" }
function Same($r, $e) { return ($r.L -eq $e.L) -and ($r.T -eq $e.T) -and ($r.Rt -eq $e.R) -and ($r.B -eq $e.B) }
function Px([double]$dip) { return [int][Math]::Round($dip * $script:s) }
function Wait-For([scriptblock]$cond, [int]$ms = 3000) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $ms) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 50 }
  return [bool](& $cond)
}
function Read-Log { if (Test-Path $log) { $fs = [IO.File]::Open($log, 'Open', 'Read', 'ReadWrite'); try { return (New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8)).ReadToEnd() } finally { $fs.Close() } }; return '' }
function Windows-Of { return ,@([L]::Of([uint32]$script:companion.Id)) }
function Width-Of($h) { $r = [L]::Rect($h); return $r.Rt - $r.L }
function Get-Panel { return (Windows-Of) | Where-Object { (Width-Of $_) -gt 200 } | Select-Object -First 1 }
function Get-Tab { return (Windows-Of) | Where-Object { (Width-Of $_) -le 200 } | Select-Object -First 1 }

# Expected placements, mirroring PanelPlacement / TabPlacement in BiubiuAI.cs (default settings:
# width 420, minimum 340, right side preferred, top offset 44).
function Expected-Outside($f, [bool]$right) {
  $top = [Math]::Max($f.T, $wa.T); $bottom = [Math]::Min($f.B, $wa.B)
  if ($bottom - $top -lt (Px 240)) { $top = $f.T; $bottom = $f.B }
  $room = if ($right) { $wa.Rt - $f.Rt } else { $f.L - $wa.L }
  $w = [Math]::Min((Px 420), $room)
  if ($right) { return @{ L = $f.Rt; T = $top; R = $f.Rt + $w; B = $bottom; Side = 'right' } }
  return @{ L = $f.L - $w; T = $top; R = $f.L; B = $bottom; Side = 'left' }
}
function Expected-Inside($f) {
  $m = Px 8; $top = $f.T + (Px 44); $bottom = [Math]::Max($top + (Px 200), $f.B - $m)
  $w = [Math]::Min((Px 420), [Math]::Max((Px 280), [int][Math]::Truncate(($f.Rt - $f.L) * 0.6)))
  $edge = $f.Rt - $m
  return @{ L = $edge - $w; T = $top; R = $edge; B = $bottom; Side = 'inside' }
}
function Expected-Auto($f) {
  if (($wa.Rt - $f.Rt) -ge (Px 340)) { return Expected-Outside $f $true }
  if (($f.L - $wa.L) -ge (Px 340)) { return Expected-Outside $f $false }
  return Expected-Inside $f
}
function Expected-Tab($f) {
  $w = Px 28; $hh = Px 92
  $top = [Math]::Max($f.T, [Math]::Min($f.T + (Px 100), $f.B - $hh))
  return @{ L = $f.Rt; T = $top; R = $f.Rt + $w; B = $top + $hh; Side = 'right' }
}
function Check-Panel([string]$step, [string]$side) {
  $ok = Wait-For { $p = Get-Panel; ($null -ne $p) -and (Same ([L]::Rect($p)) (Expected-Auto ([L]::Frame($zc)))) } 2500
  $f = [L]::Frame($zc); $e = Expected-Auto $f; $p = Get-Panel
  $actual = if ($p) { Show-Rect ([L]::Rect($p)) } else { 'no panel' }
  Check "$step / panel docked $($e.Side) of ZCode" $ok "actual $actual, expected $(Show-Expected $e), ZCode frame $(Show-Rect $f)"
  if ($side) { Check "$step / dock side is $side" ($e.Side -eq $side) "rooms: left $($f.L - $wa.L), right $($wa.Rt - $f.Rt), minimum $(Px 340)" }
  if ($p) { Check "$step / panel directly above ZCode in z-order" ([L]::Above($p, $zc)) '' }
  return $p
}
function Check-Hidden([string]$step) {
  $ok = Wait-For { (Windows-Of).Count -eq 0 } 3000
  Check "$step / companion hidden" $ok "companion windows: $((Windows-Of).Count)"
}

$zc = [IntPtr]::Zero; $original = $null; $script:companion = $null
try {
  if (Get-Process -Name BiubiuAI -ErrorAction SilentlyContinue) { & $exe --quit | Out-Null; Write-Output "stopped an earlier companion (exit $LASTEXITCODE)" }
  $zc = [L]::FindMain('ZCode.exe')
  if ($zc -eq [IntPtr]::Zero) { throw 'ZCode main window not found; open ZCode first' }
  $original = [L]::GetPlacement($zc)
  Write-Output "ZCode main window 0x$($zc.ToString('x')): showCmd $($original.showCmd), zoomed $([L]::IsZoomed($zc)), iconic $([L]::IsIconic($zc)), normal rect $(Show-Rect $original.normal)"

  # Bring ZCode to a normal window with room on its right.
  [L]::ShowWindow($zc, 9) | Out-Null
  Wait-For { -not [L]::IsIconic($zc) -and -not [L]::IsZoomed($zc) } 3000 | Out-Null
  $wa = [L]::Work($zc); $script:s = [L]::GetDpiForWindow($zc) / 96.0
  $waW = $wa.Rt - $wa.L; $waH = $wa.B - $wa.T
  $fw = [Math]::Min((Px 1100), $waW - (Px 420) - (Px 160)); $fh = [Math]::Min((Px 760), $waH - (Px 120))
  $x0 = $wa.L + (Px 60); $y0 = $wa.T + (Px 60)
  [L]::MoveFrame($zc, $x0, $y0, $fw, $fh) | Out-Null
  Start-Sleep -Milliseconds 600
  Write-Output "work area $(Show-Rect $wa), scale $script:s, ZCode frame $(Show-Rect ([L]::Frame($zc)))"

  # 1. Start: panel outside ZCode's right edge.
  $script:companion = Start-Process -FilePath $exe -PassThru
  $ready = Wait-For { (Read-Log) -match 'server ready on 127\.0\.0\.1:\d+' } 20000
  Check 'start / local server ready' $ready ''
  Start-Sleep -Seconds 2
  $p = Check-Panel 'start' 'right'
  if ($p) { Check 'start / did not take focus' ([L]::GetForegroundWindow() -ne $p) '' }

  # 2. Drag: 30 small moves, sampled while moving.
  $inSync = 0; $samples = 30
  for ($i = 0; $i -lt $samples; $i++) {
    [L]::Shift($zc, (Px 8), (Px 3)) | Out-Null
    Start-Sleep -Milliseconds 45
    $pp = Get-Panel; $f = [L]::Frame($zc)
    if ($pp -and (Same ([L]::Rect($pp)) (Expected-Auto $f))) { $inSync++ }
  }
  Check 'drag / panel kept up while moving' ($inSync -ge [int]($samples * 0.8)) "$inSync of $samples samples in place 45 ms after each move"
  Check-Panel 'drag end' 'right' | Out-Null

  # 3. Resize ZCode.
  $f = [L]::Frame($zc)
  [L]::MoveFrame($zc, $f.L, $f.T, $fw - (Px 120), $fh - (Px 80)) | Out-Null
  Check-Panel 'resize' 'right' | Out-Null

  # 4. Near the right screen edge: no room on the right, so the panel docks on the left.
  [L]::MoveFrame($zc, $wa.Rt - $fw - (Px 40), $y0, $fw, $fh) | Out-Null
  Check-Panel 'near right edge' 'left' | Out-Null
  [L]::MoveFrame($zc, $x0, $y0, $fw, $fh) | Out-Null
  Check-Panel 'back from edge' 'right' | Out-Null

  # 5. Maximize hides the companion; restore brings it back.
  [L]::ShowWindow($zc, 3) | Out-Null
  Check 'maximize / ZCode is maximized' (Wait-For { [L]::IsZoomed($zc) } 3000) ''
  Check-Hidden 'maximized'
  [L]::ShowWindow($zc, 9) | Out-Null
  Wait-For { -not [L]::IsZoomed($zc) } 3000 | Out-Null
  Check-Panel 'restored from maximize' 'right' | Out-Null

  # 6. Minimize hides it; restore brings it back.
  [L]::ShowWindow($zc, 6) | Out-Null
  Check 'minimize / ZCode is minimized' (Wait-For { [L]::IsIconic($zc) } 3000) ''
  Check-Hidden 'minimized'
  [L]::ShowWindow($zc, 9) | Out-Null
  Wait-For { -not [L]::IsIconic($zc) } 3000 | Out-Null
  Check-Panel 'restored from minimize' 'right' | Out-Null

  # 7. Collapse to the edge tab, follow ZCode while collapsed, expand again.
  & $exe --collapse | Out-Null
  Check 'collapse / signal accepted' ($LASTEXITCODE -eq 0) "exit $LASTEXITCODE"
  $ok = Wait-For { ($null -eq (Get-Panel)) -and ($null -ne (Get-Tab)) } 3000
  Check 'collapse / only the tab is shown' $ok "companion windows: $((Windows-Of).Count)"
  $ok = Wait-For { $t = Get-Tab; ($null -ne $t) -and (Same ([L]::Rect($t)) (Expected-Tab ([L]::Frame($zc)))) } 2500
  $t = Get-Tab; $e = Expected-Tab ([L]::Frame($zc))
  Check 'collapse / tab outside ZCode right edge' $ok "actual $(if ($t) { Show-Rect ([L]::Rect($t)) } else { 'no tab' }), expected $(Show-Expected $e)"
  [L]::Shift($zc, (Px 90), (Px 40)) | Out-Null
  $ok = Wait-For { $t = Get-Tab; ($null -ne $t) -and (Same ([L]::Rect($t)) (Expected-Tab ([L]::Frame($zc)))) } 2500
  Check 'collapsed / tab follows ZCode' $ok ''
  [L]::ShowWindow($zc, 3) | Out-Null
  Check-Hidden 'collapsed + maximized'
  [L]::ShowWindow($zc, 9) | Out-Null
  Check 'collapsed + restored / tab back' (Wait-For { $null -ne (Get-Tab) } 3000) ''
  & $exe --expand | Out-Null
  Check 'expand / signal accepted' ($LASTEXITCODE -eq 0) "exit $LASTEXITCODE"
  Check-Panel 'expanded' 'right' | Out-Null
  Check 'expanded / tab hidden' ($null -eq (Get-Tab)) ''

  # 8. ZCode almost as wide as the screen: no room on either side, the panel lies along ZCode's inner edge.
  [L]::MoveFrame($zc, $wa.L + (Px 30), $y0, $waW - (Px 60), $fh) | Out-Null
  Check-Panel 'no room outside' 'inside' | Out-Null

  # 9. Back to the normal layout and keep a screenshot of the panel and ZCode's right edge.
  [L]::MoveFrame($zc, $x0, $y0, $fw, $fh) | Out-Null
  $p = Check-Panel 'final' 'right'
  if ($p) {
    Start-Sleep -Milliseconds 800
    $f = [L]::Frame($zc); $r = [L]::Rect($p)
    $left = $f.Rt - (Px 120); $w = $r.Rt - $left; $hh = $r.B - $f.T
    $bmp = New-Object Drawing.Bitmap $w, $hh
    $g = [Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($left, $f.T, 0, 0, $bmp.Size); $g.Dispose()
    $bmp.Save($shot, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    Write-Output "screenshot (ZCode right edge + panel): $shot"
  }

  & $exe --quit | Out-Null
  Check 'quit / exit code' ($LASTEXITCODE -eq 0) "exit $LASTEXITCODE"
  Check 'quit / host stopped' (Wait-For { -not (Get-Process -Id $script:companion.Id -ErrorAction SilentlyContinue) } 5000) ''
}
catch { $script:failed++; Write-Output "FAIL  unexpected error: $($_.Exception.Message)" }
finally {
  if (Get-Process -Name BiubiuAI -ErrorAction SilentlyContinue) { & $exe --quit | Out-Null }
  if ($zc -ne [IntPtr]::Zero -and $null -ne $original) {
    [L]::ShowWindow($zc, 9) | Out-Null
    Start-Sleep -Milliseconds 300
    $restored = [L]::SetPlacement($zc, $original)
    Start-Sleep -Milliseconds 500
    $now = [L]::GetPlacement($zc)
    $same = ($now.showCmd -eq $original.showCmd) -and ($now.normal.L -eq $original.normal.L) -and ($now.normal.T -eq $original.normal.T) -and ($now.normal.Rt -eq $original.normal.Rt) -and ($now.normal.B -eq $original.normal.B)
    Check 'cleanup / ZCode window back where it was' ($restored -and $same) "showCmd $($now.showCmd) (was $($original.showCmd)), normal $(Show-Rect $now.normal) (was $(Show-Rect $original.normal))"
  }
  $text = Read-Log
  if ($text) { Write-Output '--- companion log'; Write-Output $text }
  Remove-Item Env:BIUBIU_AI_DATA_DIR, Env:BIUBIU_AI_CONFIG_PATH, Env:BIUBIU_AI_REFRESH_CATALOG -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 10 -and (Test-Path $tmp); $i++) { try { Remove-Item -LiteralPath $tmp -Recurse -Force } catch { Start-Sleep -Milliseconds 500 } }
  Write-Output "temp folder removed: $(-not (Test-Path $tmp))"
  Write-Output "SUMMARY passed=$($script:passed) failed=$($script:failed)"
}
