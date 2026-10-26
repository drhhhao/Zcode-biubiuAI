param([string]$OutDir = "$PSScriptRoot", [switch]$Shot)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Probe {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
}
"@
[Probe]::SetThreadDpiAwarenessContext([IntPtr]-4) | Out-Null
$found = New-Object System.Collections.ArrayList
$cb = [Probe+EnumProc]{ param($h, $l)
  $c = New-Object System.Text.StringBuilder 256; [Probe]::GetClassName($h, $c, 256) | Out-Null
  if ($c.ToString() -eq 'Chrome_WidgetWin_1') {
    $t = New-Object System.Text.StringBuilder 512; [Probe]::GetWindowText($h, $t, 512) | Out-Null
    $procId = 0; [Probe]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'ZCode') { [void]$found.Add([pscustomobject]@{ H = $h; Title = $t.ToString(); Pid = $procId; Path = $p.Path }) }
  }
  return $true }
[Probe]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$fg = [Probe]::GetForegroundWindow()
foreach ($w in $found) {
  $r = New-Object Probe+RECT; [Probe]::GetWindowRect($w.H, [ref]$r) | Out-Null
  $e = New-Object Probe+RECT; [Probe]::DwmGetWindowAttribute($w.H, 9, [ref]$e, 16) | Out-Null
  $cl = New-Object Probe+RECT; [Probe]::GetClientRect($w.H, [ref]$cl) | Out-Null
  $cloak = 0; [Probe]::DwmGetWindowAttribute($w.H, 14, [ref]$cloak, 4) | Out-Null
  $aw = [Probe]::GetAwarenessFromDpiAwarenessContext([Probe]::GetWindowDpiAwarenessContext($w.H))
  $style = [Probe]::GetWindowLong($w.H, -16); $ex = [Probe]::GetWindowLong($w.H, -20)
  "{0} title='{1}' pid={2} vis={3} icon={4} zoom={5} cloak={6} dpi={7} aware={8} fg={9} style=0x{10:X8} ex=0x{11:X8}" -f $w.H, $w.Title, $w.Pid, [Probe]::IsWindowVisible($w.H), [Probe]::IsIconic($w.H), [Probe]::IsZoomed($w.H), $cloak, [Probe]::GetDpiForWindow($w.H), $aw, ($fg -eq $w.H), $style, $ex
  "   win=({0},{1})-({2},{3}) ext=({4},{5})-({6},{7}) client={8}x{9} path={10}" -f $r.L,$r.T,$r.R,$r.B,$e.L,$e.T,$e.R,$e.B,$cl.R,$cl.B,$w.Path
  if ($Shot -and [Probe]::IsWindowVisible($w.H) -and -not [Probe]::IsIconic($w.H) -and $w.Title -eq 'ZCode') {
    $wd = $e.R - $e.L; $ht = $e.B - $e.T
    $bmp = New-Object System.Drawing.Bitmap $wd, 110
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($e.L, $e.T, 0, 0, $bmp.Size); $g.Dispose()
    $bmp.Save((Join-Path $OutDir 'zcode-titlebar.png'), [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    $full = New-Object System.Drawing.Bitmap $wd, $ht
    $g = [System.Drawing.Graphics]::FromImage($full); $g.CopyFromScreen($e.L, $e.T, 0, 0, $full.Size); $g.Dispose()
    $small = New-Object System.Drawing.Bitmap ([int]($wd*0.4)), ([int]($ht*0.4))
    $g = [System.Drawing.Graphics]::FromImage($small); $g.InterpolationMode = 'HighQualityBicubic'; $g.DrawImage($full, 0, 0, $small.Width, $small.Height); $g.Dispose()
    $small.Save((Join-Path $OutDir 'zcode-small.png'), [System.Drawing.Imaging.ImageFormat]::Png); $small.Dispose(); $full.Dispose()
    "   saved screenshots"
  }
}
if (-not $found.Count) { "no ZCode windows" }
