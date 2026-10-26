# Temporarily shows the minimized ZCode window without activating it, captures it with PrintWindow, then minimizes it again.
param([string]$OutDir = "$PSScriptRoot", [switch]$KeepOpen)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Peek {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
}
"@
[Peek]::SetThreadDpiAwarenessContext([IntPtr]-4) | Out-Null
$p = Get-Process ZCode -ErrorAction Stop | Where-Object { $_.MainWindowTitle -eq 'ZCode' } | Select-Object -First 1
if (-not $p) { $h = [IntPtr]16647664 } else { $h = $p.MainWindowHandle }
$wasIconic = [Peek]::IsIconic($h)
if ($wasIconic) { [Peek]::ShowWindow($h, 4) | Out-Null; Start-Sleep -Milliseconds 900 }
$r = New-Object Peek+RECT; [Peek]::GetWindowRect($h, [ref]$r) | Out-Null
$e = New-Object Peek+RECT; [Peek]::DwmGetWindowAttribute($h, 9, [ref]$e, 16) | Out-Null
"window=({0},{1})-({2},{3}) ext=({4},{5})-({6},{7})" -f $r.L,$r.T,$r.R,$r.B,$e.L,$e.T,$e.R,$e.B
$w = $r.R - $r.L; $ht = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp); $hdc = $g.GetHdc()
$ok = [Peek]::PrintWindow($h, $hdc, 2); $g.ReleaseHdc($hdc); $g.Dispose()
"printwindow=$ok"
$ox = $e.L - $r.L; $oy = $e.T - $r.T
$strip = $bmp.Clone((New-Object System.Drawing.Rectangle $ox, $oy, ($e.R - $e.L), 160), $bmp.PixelFormat)
$strip.Save((Join-Path $OutDir 'zcode-titlebar.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$right = $bmp.Clone((New-Object System.Drawing.Rectangle ($ox + ($e.R - $e.L) - 900), $oy, 900, 160), $bmp.PixelFormat)
$right.Save((Join-Path $OutDir 'zcode-titlebar-right.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$small = New-Object System.Drawing.Bitmap ([int]($w*0.35)), ([int]($ht*0.35))
$g = [System.Drawing.Graphics]::FromImage($small); $g.InterpolationMode = 'HighQualityBicubic'; $g.DrawImage($bmp, 0, 0, $small.Width, $small.Height); $g.Dispose()
$small.Save((Join-Path $OutDir 'zcode-small.png'), [System.Drawing.Imaging.ImageFormat]::Png)
# Sample colours of the title row for theme detection design.
foreach ($pt in @(@(200,20),@(600,20),@(1200,20),@(2000,20),@(600,300),@(1500,300),@(1500,900),@(300,900))) { $x=$pt[0]+$ox; $y=$pt[1]+$oy; if ($x -lt $w -and $y -lt $ht) { $c=$bmp.GetPixel($x,$y); "px({0},{1})=#{2:X2}{3:X2}{4:X2}" -f $pt[0],$pt[1],$c.R,$c.G,$c.B } }
$bmp.Dispose(); $strip.Dispose(); $right.Dispose(); $small.Dispose()
if ($wasIconic -and -not $KeepOpen) { [Peek]::ShowWindow($h, 7) | Out-Null; "re-minimized" }
