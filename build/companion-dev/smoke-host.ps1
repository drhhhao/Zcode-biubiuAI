# Live check of the desktop companion with a stand-in ZCode window (FakeZCode.exe).
# The real ZCode is never touched: the companion follows FakeZCode.exe for this run only, and its
# settings, log and WebView2 data go to a temporary folder that is removed afterwards.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
# MODEL_HARBOR_EXE checks another build, such as an installed copy (build/companion-dev/installer-check.ps1).
$exe = if ($env:MODEL_HARBOR_EXE) { $env:MODEL_HARBOR_EXE } else { Join-Path $root 'app\bin\ModelHarbor.exe' }
$fakeExe = Join-Path $root 'build\companion-dev\FakeZCode.exe'
$shot = Join-Path $root 'build\companion-dev\panel.png'
$tmp = Join-Path $env:TEMP ('mh-smoke-' + [guid]::NewGuid().ToString('N'))
$data = Join-Path $tmp 'data'
$log = Join-Path $data 'companion.log'
New-Item -ItemType Directory -Path $data -Force | Out-Null
$config = Join-Path $tmp 'provider_config.json'
[IO.File]::WriteAllText($config, '{"schemaVersion":1,"config":{"providerOrder":[],"providerConfigRules":{"providerRules":[]},"modelConfigRules":{"providerModelRules":[],"manualProviderModelRules":[]}}}', (New-Object Text.UTF8Encoding $false))
$env:MODEL_HARBOR_DATA_DIR = $data
$env:MODEL_HARBOR_ZCODE_EXE = 'FakeZCode.exe'
$env:MODEL_HARBOR_CONFIG_PATH = $config
$env:MODEL_HARBOR_REFRESH_CATALOG = '0'
# An installed copy would look for updates on GitHub; installer-check.ps1 checks updating with a stand-in instead.
$env:MODEL_HARBOR_UPDATE_URL = 'off'

Add-Type -AssemblyName System.Drawing, System.Windows.Forms, UIAutomationClient, UIAutomationTypes
Add-Type -ReferencedAssemblies System.Drawing, System.Windows.Forms -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
// A plain white window that never takes focus, put directly below another window to show what lies outside its shape.
public class Backdrop : Form {
  public Backdrop() { FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; StartPosition = FormStartPosition.Manual; BackColor = Color.White; }
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams { get { var cp = base.CreateParams; cp.ExStyle |= 0x80 | 0x08000000; return cp; } }
}
public static class W {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public static Backdrop Behind(IntPtr above, int x, int y, int w, int h) {
    var f = new Backdrop(); f.Bounds = new Rectangle(x, y, w, h); f.Show();
    SetWindowPos(f.Handle, above, x, y, w, h, 0x0010);
    Application.DoEvents();
    return f;
  }
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);
  // Whether this machine draws rounded window corners at all: a black window asks for them (DWMWCP_ROUND) in front of a
  // white backdrop, and its corner is looked at. Windows Server, which GitHub's checks run on, draws them square.
  public static bool RoundCorners() {
    var back = new Backdrop(); back.Bounds = new Rectangle(80, 80, 240, 160); back.TopMost = true; back.Show();
    var probe = new Backdrop(); probe.BackColor = Color.Black; probe.Bounds = new Rectangle(120, 120, 160, 80); probe.TopMost = true; probe.Show();
    try {
      int round = 2;
      if (DwmSetWindowAttribute(probe.Handle, 33, ref round, 4) != 0) return false;
      for (int i = 0; i < 15; i++) { Application.DoEvents(); Thread.Sleep(30); }
      return Luma(probe.Left, probe.Top) > 150;
    } catch { return false; }
    finally { probe.Close(); probe.Dispose(); back.Close(); back.Dispose(); }
  }
  public static int Luma(int x, int y) {
    using (var b = new Bitmap(1, 1)) {
      using (var g = Graphics.FromImage(b)) g.CopyFromScreen(x, y, 0, 0, new Size(1, 1));
      var c = b.GetPixel(0, 0); return (int)(0.299 * c.R + 0.587 * c.G + 0.114 * c.B);
    }
  }
  public delegate bool P(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(P p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out R r, int s);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  public static void PerMonitor() { SetThreadDpiAwarenessContext(new IntPtr(-4)); }
  public static List<IntPtr> Of(uint pid) {
    var list = new List<IntPtr>();
    EnumWindows((h, x) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  // A left click, or a double click, on the process's tray icon, as Windows reports it to the icon's own hidden window:
  // Windows Forms' NotifyIcon takes WM_USER + 1024 with the mouse message in lParam; its other windows ignore it.
  public static void TrayClick(uint pid, bool twice) {
    var all = new List<IntPtr>();
    EnumWindows((h, x) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && Cls(h).StartsWith("WindowsForms10.Window")) all.Add(h); return true; }, IntPtr.Zero);
    foreach (IntPtr h in all) {
      PostMessage(h, 0x800, IntPtr.Zero, new IntPtr(0x201)); PostMessage(h, 0x800, IntPtr.Zero, new IntPtr(0x202));
      if (twice) { PostMessage(h, 0x800, IntPtr.Zero, new IntPtr(0x203)); PostMessage(h, 0x800, IntPtr.Zero, new IntPtr(0x202)); }
    }
  }
  // Ctrl+Alt+M, which the companion holds as a global hotkey, so no other program sees it.
  public static void HotKey() {
    keybd_event(0x11, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x4D, 0, 0, UIntPtr.Zero);
    keybd_event(0x4D, 0, 2, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero); keybd_event(0x11, 0, 2, UIntPtr.Zero);
  }
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static R Rect(IntPtr h) { R r; GetWindowRect(h, out r); return r; }
  public static R Frame(IntPtr h) { R r; if (DwmGetWindowAttribute(h, 9, out r, 16) != 0) GetWindowRect(h, out r); return r; }
  public static bool Above(IntPtr ours, IntPtr target) {
    int n = 0;
    for (IntPtr h = GetWindow(target, 3); h != IntPtr.Zero && n < 4096; h = GetWindow(h, 3), n++) if (h == ours) return true;
    return false;
  }
  // Samples the companion's panel (its visible window wider than 200 pixels) every few milliseconds for ms
  // milliseconds and returns the largest share of a 9-pixel grid over it (its outermost pixels left out) that lay
  // within 8 of the given color. samples counts the samples, taken only while the panel is shown.
  public static double MostOf(uint pid, int red, int green, int blue, int ms, out int samples) {
    double most = 0; samples = 0;
    var clock = Stopwatch.StartNew();
    while (clock.ElapsedMilliseconds < ms) {
      foreach (IntPtr h in Of(pid)) {
        R r;
        if (!GetWindowRect(h, out r) || r.Rt - r.L <= 200 || r.B - r.T <= 8) continue;
        int w = r.Rt - r.L, ht = r.B - r.T, hit = 0, all = 0;
        using (var b = new Bitmap(w, ht, PixelFormat.Format32bppArgb)) {
          using (var g = Graphics.FromImage(b)) g.CopyFromScreen(r.L, r.T, 0, 0, b.Size, CopyPixelOperation.SourceCopy);
          var d = b.LockBits(new Rectangle(0, 0, w, ht), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
          int stride = d.Stride / 4; var px = new int[stride * ht];
          Marshal.Copy(d.Scan0, px, 0, px.Length); b.UnlockBits(d);
          for (int y = 4; y < ht - 4; y += 9)
            for (int x = 4; x < w - 4; x += 9) {
              int c = px[y * stride + x]; all++;
              if (Math.Abs(((c >> 16) & 255) - red) <= 8 && Math.Abs(((c >> 8) & 255) - green) <= 8 && Math.Abs((c & 255) - blue) <= 8) hit++;
            }
        }
        samples++;
        most = Math.Max(most, (double)hit / Math.Max(1, all));
        break;
      }
      Thread.Sleep(3);
    }
    return most;
  }
}
'@
[W]::PerMonitor()
# Whether Windows here draws rounded window corners at all; Check-Corners judges them only then.
$script:roundCorners = [W]::RoundCorners()
Write-Output "rounded window corners on this machine: $script:roundCorners"

$script:passed = 0; $script:failed = 0; $script:offset = 0
function Check([string]$name, [bool]$ok, [string]$detail) {
  # Written straight to the console so results never leak into a function's return value.
  if ($ok) { $script:passed++; [Console]::Out.WriteLine("PASS  $name  $detail") } else { $script:failed++; [Console]::Out.WriteLine("FAIL  $name  $detail") }
}
function Show-Rect($r) { "($($r.L),$($r.T))-($($r.Rt),$($r.B)) $($r.Rt - $r.L)x$($r.B - $r.T)" }
function Show-Expected($e) { "($($e.L),$($e.T))-($($e.R),$($e.B))" }
function Mark-Log { $script:offset = 0; if (Test-Path $log) { $script:offset = (Get-Item $log).Length } }
function Read-LogSinceMark {
  if (-not (Test-Path $log)) { return '' }
  $fs = [IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
  try { $fs.Seek($script:offset, 'Begin') | Out-Null; return (New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8)).ReadToEnd() } finally { $fs.Close() }
}
function Wait-Ready {
  for ($i = 0; $i -lt 100; $i++) {
    Start-Sleep -Milliseconds 200
    if ((Read-LogSinceMark) -match 'server ready on 127\.0\.0\.1:(\d+)') { return [int]$Matches[1] }
  }
  return $null
}
function Start-Fake {
  $psi = New-Object Diagnostics.ProcessStartInfo $fakeExe
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true
  $p = [Diagnostics.Process]::Start($psi)
  $line = $p.StandardOutput.ReadLine()
  if ($line -notmatch '^ready (\d+) (-?\d+) (-?\d+) (\d+) (\d+)$') { throw "stand-in ZCode did not start: $line" }
  [pscustomobject]@{ P = $p; H = [IntPtr][long]$Matches[1]; WA = @([int]$Matches[2], [int]$Matches[3], [int]$Matches[4], [int]$Matches[5]) }
}
function Send-Fake($fake, [string]$command) {
  $fake.P.StandardInput.WriteLine($command); $fake.P.StandardInput.Flush()
  $reply = $fake.P.StandardOutput.ReadLine()
  if ($reply -ne ('ok ' + $command.Split(' ')[0])) { throw "stand-in ZCode answered '$reply' to '$command'" }
}
function Get-Windows([int]$procId) { return ,@([W]::Of([uint32]$procId)) }
function Width($h) { $r = [W]::Rect($h); return $r.Rt - $r.L }
function Px([double]$dip, [double]$s) { return [int][Math]::Round($dip * $s) }
function Work-Area($fake) { return @{ L = $fake.WA[0]; T = $fake.WA[1]; R = $fake.WA[0] + $fake.WA[2]; B = $fake.WA[1] + $fake.WA[3] } }
# Mirrors PanelPlacement in ModelHarbor.cs with default settings (width 420, minimum 340, right side
# preferred, top offset 44): outside ZCode's right edge, else outside its left edge, else inside.
function Expected-Panel($f, [double]$s, $wa) {
  $min = Px 340 $s; $want = Px 420 $s
  $top = [Math]::Max($f.T, $wa.T); $bottom = [Math]::Min($f.B, $wa.B)
  if ($bottom - $top -lt (Px 240 $s)) { $top = $f.T; $bottom = $f.B }
  $roomRight = $wa.R - $f.Rt; $roomLeft = $f.L - $wa.L
  if ($roomRight -ge $min) { $w = [Math]::Min($want, $roomRight); return @{ L = $f.Rt; T = $top; R = $f.Rt + $w; B = $bottom; Side = 'right' } }
  if ($roomLeft -ge $min) { $w = [Math]::Min($want, $roomLeft); return @{ L = $f.L - $w; T = $top; R = $f.L; B = $bottom; Side = 'left' } }
  $m = Px 8 $s; $itop = $f.T + (Px 44 $s); $ibottom = [Math]::Max($itop + (Px 200 $s), $f.B - $m)
  $w = [Math]::Min($want, [Math]::Max((Px 280 $s), [int][Math]::Truncate(($f.Rt - $f.L) * 0.6)))
  $edge = $f.Rt - $m
  return @{ L = $edge - $w; T = $itop; R = $edge; B = $ibottom; Side = 'inside' }
}
# Mirrors TabPlacement: on the side the panel would take, outside ZCode when the tab fits there.
function Expected-Tab($f, [double]$s, $wa) {
  $w = Px 28 $s; $h = Px 92 $s
  $t = [Math]::Max($f.T, [Math]::Min($f.T + (Px 100 $s), $f.B - $h))
  $right = (Expected-Panel $f $s $wa).Side -ne 'left'
  $room = if ($right) { $wa.R - $f.Rt } else { $f.L - $wa.L }
  if ($room -ge $w) { $l = if ($right) { $f.Rt } else { $f.L - $w } }
  else { $l = if ($right) { $f.Rt - $w - (Px 6 $s) } else { $f.L + (Px 6 $s) } }
  return @{ L = $l; T = $t; R = $l + $w; B = $t + $h }
}
function Same($r, $e) { return ($r.L -eq $e.L) -and ($r.T -eq $e.T) -and ($r.Rt -eq $e.R) -and ($r.B -eq $e.B) }
# Share of a 9-pixel grid over the window that lies within 8 of the given color, its outermost pixels left out.
function Background-Share($h, $want) {
  $r = [W]::Rect($h); $w = $r.Rt - $r.L; $ht = $r.B - $r.T
  if ($w -le 0 -or $ht -le 0) { return 0 }
  $b = New-Object Drawing.Bitmap $w, $ht
  $g = [Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($r.L, $r.T, 0, 0, $b.Size); $g.Dispose()
  $hit = 0; $all = 0
  for ($y = 4; $y -lt $ht - 4; $y += 9) {
    for ($x = 4; $x -lt $w - 4; $x += 9) {
      $c = $b.GetPixel($x, $y); $all++
      if (([Math]::Abs($c.R - $want[0]) -le 8) -and ([Math]::Abs($c.G - $want[1]) -le 8) -and ([Math]::Abs($c.B - $want[2]) -le 8)) { $hit++ }
    }
  }
  $b.Dispose(); return $hit / [Math]::Max(1, $all)
}
function Check-Panel([string]$step, $fake, [int]$procId, [string]$side = '') {
  $wins = Get-Windows $procId
  $panel = $wins | Where-Object { (Width $_) -gt 200 } | Select-Object -First 1
  Check "$step / panel visible" ($null -ne $panel) "companion windows: $($wins.Count)"
  if ($null -eq $panel) { return $null }
  $f = [W]::Frame($fake.H); $s = [W]::GetDpiForWindow($fake.H) / 96.0
  $e = Expected-Panel $f $s (Work-Area $fake); $r = [W]::Rect($panel)
  Check "$step / panel docked $($e.Side) of ZCode" (Same $r $e) "actual $(Show-Rect $r), expected $(Show-Expected $e), ZCode frame $(Show-Rect $f), scale $s"
  if ($side) { Check "$step / dock side is $side" ($e.Side -eq $side) "rooms: left $($f.L - $fake.WA[0]), right $($fake.WA[0] + $fake.WA[2] - $f.Rt)" }
  Check "$step / panel directly above ZCode in z-order" ([W]::Above($panel, $fake.H)) ''
  return $panel
}
function Check-Tab([string]$step, $fake, [int]$procId) {
  $wins = Get-Windows $procId
  $tab = $wins | Where-Object { (Width $_) -le 200 } | Select-Object -First 1
  Check "$step / only the tab is shown" (($wins.Count -eq 1) -and ($null -ne $tab)) "companion windows: $($wins.Count)"
  if ($null -eq $tab) { return $null }
  $f = [W]::Frame($fake.H); $s = [W]::GetDpiForWindow($fake.H) / 96.0
  $e = Expected-Tab $f $s (Work-Area $fake); $r = [W]::Rect($tab)
  Check "$step / tab position" (Same $r $e) "actual $(Show-Rect $r), expected $(Show-Expected $e), ZCode frame $(Show-Rect $f)"
  Check "$step / tab above ZCode in z-order" ([W]::Above($tab, $fake.H)) ''
  return $tab
}
function Check-Theme([string]$step, $panel, [string]$theme) {
  # The two themes swap ink and paper, so one pixel cannot tell them apart: text or the ink-filled button in one theme
  # has the other's background color. Most of the panel is page background, so require it on 60% of a grid instead.
  # The companion re-samples ZCode on its own timer, so poll for up to 8 seconds instead of one fixed wait.
  $want = if ($theme -eq 'dark') { @(0x1c, 0x1c, 0x1c) } else { @(0xf9, 0xf8, 0xf6) }
  $deadline = (Get-Date).AddSeconds(8); $ok = $false; $tries = 0
  do {
    $tries++
    $share = Background-Share $panel $want; $ok = $share -ge 0.6
    if (-not $ok) { Start-Sleep -Milliseconds 500 }
  } while (-not $ok -and (Get-Date) -lt $deadline)
  Check "$step / panel theme is $theme" $ok ("{0:P0} of the panel has the $theme background after $tries sample(s)" -f $share)
}
# Run right after ZCode is restored in front of a backdrop of the opposite brightness. While Windows animates ZCode
# back from the taskbar the screen still shows the backdrop in its place; the panel must not switch to the wrong
# theme meanwhile, not even for a moment. Watches the panel for two seconds; text and ink-filled controls carry the
# other theme's color too, so a switch only counts when it covers 30% of the panel (a real one covers well over 60%).
# Rounded corners, checked in the dark theme: a white window directly behind the companion window, a little larger on
# the side away from ZCode, shows through the outer corners, while the middle of that edge is the window's own dark
# color. Square corners would show the window's color there too. With $shot, a picture of the window's top.
function Check-Corners([string]$step, $win, [string]$shot = '') {
  $r = [W]::Rect($win)
  $b = [W]::Behind($win, $r.L - 60, $r.T - 24, ($r.Rt - $r.L) + 84, ($r.B - $r.T) + 48)
  try {
    Start-Sleep -Milliseconds 400
    $top = [W]::Luma($r.Rt - 2, $r.T + 1); $bottom = [W]::Luma($r.Rt - 2, $r.B - 2); $middle = [W]::Luma($r.Rt - 3, [int](($r.T + $r.B) / 2))
    # Where Windows draws square window corners (Windows Server, as on GitHub) only the edge's own color is checked.
    if ($script:roundCorners) { Check "$step / outer corners rounded" (($top -gt 150) -and ($bottom -gt 150) -and ($middle -lt 100)) "luma: top corner $top, bottom corner $bottom, middle of the edge $middle" }
    else { Write-Output "SKIP  $step / outer corners rounded: this Windows draws square window corners (luma: top corner $top, middle of the edge $middle)" }
    if ($shot) {
      $w = ($r.Rt - $r.L) + 56; $h = [Math]::Min(220, $r.B - $r.T + 16)
      $bmp = New-Object Drawing.Bitmap $w, $h
      $g = [Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($r.L - 40, $r.T - 16, 0, 0, $bmp.Size); $g.Dispose()
      $bmp.Save($shot, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
      Write-Output "corner screenshot (the window's top on a white stand-in backdrop): $shot"
    }
  } finally { $b.Close(); $b.Dispose() }
}
function Check-NoFlash([string]$step, [int]$procId, [string]$wrong) {
  $want = if ($wrong -eq 'dark') { @(0x1c, 0x1c, 0x1c) } else { @(0xf9, 0xf8, 0xf6) }
  $samples = 0
  $most = [W]::MostOf([uint32]$procId, $want[0], $want[1], $want[2], 2000, [ref]$samples)
  Check "$step / panel shown again" ($samples -gt 0) "$samples sample(s) while shown"
  Check "$step / no $wrong flash" (($samples -gt 0) -and ($most -lt 0.3)) ("at most {0:P0} of the panel had the $wrong background" -f $most)
}
# The saved-key checks read the page through UI Automation: how many key texts are masked or show the fake key,
# and the state of the service's eye toggle. The key itself is never printed.
$mask = [string]::new([char]0x2022, 12)
$fakeKey = 'smoke-fake-key-0123456789'
$newKey = 'smoke-new-key-9876543210'
function Get-Keys([int]$procId) {
  $masked = 0; $shown = 0; $eye = $null; $pressed = ''
  $wins = Get-Windows $procId
  $panel = $wins | Where-Object { (Width $_) -gt 200 } | Select-Object -First 1
  if ($panel) {
    $all = [Windows.Automation.AutomationElement]::FromHandle($panel).FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
    foreach ($el in $all) {
      try { $name = $el.Current.Name; $type = $el.Current.ControlType } catch { continue }
      if ($name -eq $mask) { $masked++ } elseif (($name -eq $fakeKey) -or ($name -eq $newKey)) { $shown++ }
      elseif (($type -eq [Windows.Automation.ControlType]::Button) -and ($name -like '*Smoke Service*Key*')) { $eye = $el }
    }
    $p = $null
    if ($eye -and $eye.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $pressed = [string]$p.Current.ToggleState }
  }
  return [pscustomobject]@{ Masked = $masked; Shown = $shown; Eye = $eye; Pressed = $pressed }
}
function Wait-Keys([int]$procId, [scriptblock]$until) {
  $deadline = (Get-Date).AddSeconds(15)
  do { $k = Get-Keys $procId; if (& $until $k) { return $k }; Start-Sleep -Milliseconds 300 } while ((Get-Date) -lt $deadline)
  return $k
}
function Show-Keys($k) { "masked $($k.Masked), shown $($k.Shown), eye $($k.Pressed)" }
# The eye is a toggle button (aria-pressed), which UI Automation exposes through the Toggle pattern.
function Reveal-Key([int]$procId) {
  $k = Get-Keys $procId
  if ($k.Eye) { $k.Eye.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern).Toggle() }
  return Wait-Keys $procId { param($x) $x.Shown -ge 1 }
}
# Changing and deleting the service goes through its own buttons, found by their accessible names, and the edit
# fields, found by their element ids. The names are Chinese, so they are built from code points to keep this file ASCII.
function Text([int[]]$codes) { return -join ($codes | ForEach-Object { [char]$_ }) }
$newUrl = 'https://moved.example.com/v1'
$editName = (Text 0x4FEE, 0x6539, 0x300C) + 'Smoke Service' + (Text 0x300D)
$dropName = (Text 0x5220, 0x9664, 0x300C) + 'Smoke Service' + (Text 0x300D)
$saveName = Text 0x4FDD, 0x5B58
$confirmName = Text 0x786E, 0x8BA4, 0x5220, 0x9664
$nameProperty = [Windows.Automation.AutomationElement]::NameProperty
$idProperty = [Windows.Automation.AutomationElement]::AutomationIdProperty
function Find-Now([int]$procId, $property, [string]$value) {
  $wins = Get-Windows $procId
  $panel = $wins | Where-Object { (Width $_) -gt 200 } | Select-Object -First 1
  if (-not $panel) { return $null }
  return [Windows.Automation.AutomationElement]::FromHandle($panel).FindFirst([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.PropertyCondition]::new($property, $value))
}
function Find-Element([int]$procId, $property, [string]$value) {
  $deadline = (Get-Date).AddSeconds(15)
  do { $el = Find-Now $procId $property $value; if ($el) { return $el }; Start-Sleep -Milliseconds 300 } while ((Get-Date) -lt $deadline)
  return $null
}
function Wait-Gone([int]$procId, $property, [string]$value) {
  $deadline = (Get-Date).AddSeconds(15)
  do { if (-not (Find-Now $procId $property $value)) { return $true }; Start-Sleep -Milliseconds 300 } while ((Get-Date) -lt $deadline)
  return $false
}
function Press([int]$procId, [string]$name) {
  $el = Find-Element $procId $nameProperty $name
  if (-not $el) { return $false }
  $el.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke(); return $true
}
function Fill([int]$procId, [string]$id, [string]$value) {
  $el = Find-Element $procId $idProperty $id
  if (-not $el) { return $false }
  $el.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($value); return $true
}
# The panel opens on its site account page; the saved services are on the connect page. The pages are tabs (role tab),
# which Chromium shows to UI Automation as tab items with the SelectionItem pattern; selecting one clicks it. Invoke is
# only a fallback.
$connectName = Text 0x8FDE, 0x63A5, 0x670D, 0x52A1
function Open-Page([int]$procId, [string]$name) {
  $tabItem = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::TabItem)
  $condition = [Windows.Automation.AndCondition]::new([Windows.Automation.PropertyCondition]::new($nameProperty, $name), $tabItem)
  $deadline = (Get-Date).AddSeconds(15)
  do {
    # Get-Windows returns its list as one object; piped straight on, $_ would be the whole list, not one window.
    $wins = Get-Windows $procId
    $panel = $wins | Where-Object { (Width $_) -gt 200 } | Select-Object -First 1
    $tab = $null
    if ($panel) { $tab = [Windows.Automation.AutomationElement]::FromHandle($panel).FindFirst([Windows.Automation.TreeScope]::Descendants, $condition) }
    if ($tab) {
      $p = $null
      if ($tab.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select() } else { $tab.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke() }
      return $true
    }
    Start-Sleep -Milliseconds 300
  } while ((Get-Date) -lt $deadline)
  return $false
}
function Wait-Config([scriptblock]$until) {
  $deadline = (Get-Date).AddSeconds(15)
  do { try { $c = [IO.File]::ReadAllText($config) | ConvertFrom-Json; if (& $until $c) { return $c } } catch { }; Start-Sleep -Milliseconds 300 } while ((Get-Date) -lt $deadline)
  return $c
}
function Count-Backups { $dir = Join-Path $tmp 'backups\model-harbor'; if (Test-Path $dir) { return @(Get-ChildItem -LiteralPath $dir -File).Count } else { return 0 } }

$fake = $null; $companion = $null
try {
  if (Get-Process -Name ModelHarbor -ErrorAction SilentlyContinue) { & $exe --quit | Out-Null; Write-Output "stopped an earlier companion (exit $LASTEXITCODE)" }

  # Start: expanded panel on the right of ZCode, dark theme, no focus taken.
  $fake = Start-Fake
  Write-Output "stand-in ZCode: pid $($fake.P.Id), work area $($fake.WA -join ','), frame $(Show-Rect ([W]::Frame($fake.H))), scale $([W]::GetDpiForWindow($fake.H) / 96.0)"
  Mark-Log
  $companion = Start-Process -FilePath $exe -PassThru
  $port = Wait-Ready
  Check 'start / server ready' ($null -ne $port) "port $port"
  Start-Sleep -Seconds 3
  $panel = Check-Panel 'start' $fake $companion.Id
  Check 'start / no startup note with ZCode in sight' (-not ((Read-LogSinceMark) -match 'startup notice')) ''
  if ($panel) {
    Check 'start / did not take focus' ([W]::GetForegroundWindow() -ne $panel) ''
    Check-Theme 'start' $panel 'dark'
    Check-Corners 'start' $panel (Join-Path $root 'build\companion-dev\panel-corners.png')
  }

  # ZCode comes back from the taskbar in front of something white: the dark panel must not flash light.
  if ($panel) {
    Send-Fake $fake 'backdrop white'
    Send-Fake $fake 'min'
    Start-Sleep -Milliseconds 1500
    Send-Fake $fake 'restore'
    Check-NoFlash 'restore over white' $companion.Id 'light'
    Send-Fake $fake 'backdrop off'
    Check-Theme 'restore over white' $panel 'dark'
  }

  # A second --background launch must leave the single instance alone.
  $second = Start-Process -FilePath $exe -ArgumentList '--background' -PassThru -Wait
  Check 'second launch / exits at once' ($second.ExitCode -eq 0) "exit $($second.ExitCode)"
  $count = @(Get-Process -Name ModelHarbor -ErrorAction SilentlyContinue).Count
  Check 'second launch / single instance' ($count -eq 1) "ModelHarbor processes: $count"

  # Move and resize ZCode.
  $wa = $fake.WA
  Send-Fake $fake ('move {0} {1} {2} {3}' -f ($wa[0] + 300), ($wa[1] + 200), [Math]::Min(1400, $wa[2] - 400), [Math]::Min(900, $wa[3] - 300))
  Start-Sleep -Milliseconds 1500
  $panel = Check-Panel 'after move' $fake $companion.Id

  # Theme follows ZCode.
  Send-Fake $fake 'light'
  Start-Sleep -Milliseconds 2500
  if ($panel) { Check-Theme 'after light' $panel 'light' }

  # Minimize and restore, in front of something black this time: the light panel must not flash dark.
  Send-Fake $fake 'backdrop black'
  Send-Fake $fake 'min'
  Start-Sleep -Milliseconds 1500
  $n = (Get-Windows $companion.Id).Count
  Check 'minimized / companion hidden' ($n -eq 0) "companion windows: $n"
  Send-Fake $fake 'restore'
  Check-NoFlash 'restore over black' $companion.Id 'dark'
  Send-Fake $fake 'backdrop off'
  $panel = Check-Panel 'after restore' $fake $companion.Id 'right'
  if ($panel) { Check-Theme 'after restore' $panel 'light' }

  # Maximized, ZCode leaves no room beside it: the tab lies along its inner edge, and the panel opens over ZCode only
  # when asked for there. Restoring brings the panel back outside; maximizing again shows only the tab again.
  Send-Fake $fake 'max'
  Start-Sleep -Milliseconds 1500
  Check-Tab 'maximized' $fake $companion.Id | Out-Null
  & $exe --expand | Out-Null
  Start-Sleep -Milliseconds 1200
  Check-Panel 'maximized, asked for' $fake $companion.Id 'inside' | Out-Null
  Send-Fake $fake 'restore'
  Start-Sleep -Milliseconds 1500
  $panel = Check-Panel 'after unmaximize' $fake $companion.Id 'right'
  Send-Fake $fake 'max'
  Start-Sleep -Milliseconds 1500
  Check-Tab 'maximized again' $fake $companion.Id | Out-Null
  Send-Fake $fake 'restore'
  Start-Sleep -Milliseconds 1500
  $panel = Check-Panel 'after the second unmaximize' $fake $companion.Id 'right'

  # Near the right screen edge there is no room on the right, so the panel docks on ZCode's left.
  $fw = [Math]::Min(1400, $wa[2] - 400); $fh = [Math]::Min(900, $wa[3] - 300)
  Send-Fake $fake ('move {0} {1} {2} {3}' -f ($wa[0] + $wa[2] - $fw - 40), ($wa[1] + 200), $fw, $fh)
  Start-Sleep -Milliseconds 1500
  Check-Panel 'near right edge' $fake $companion.Id 'left' | Out-Null

  # Wide enough that neither side has room for the minimum width: the panel lies along ZCode's inner right edge.
  Send-Fake $fake ('move {0} {1} {2} {3}' -f ($wa[0] + 200), ($wa[1] + 200), ($wa[2] - 400), $fh)
  Start-Sleep -Milliseconds 1500
  Check-Panel 'no room either side' $fake $companion.Id 'inside' | Out-Null
  & $exe --collapse | Out-Null
  Start-Sleep -Milliseconds 1200
  $wins = Get-Windows $companion.Id
  $tab = $wins | Where-Object { (Width $_) -le 200 } | Select-Object -First 1
  Check 'no room either side / collapsed to the tab' (($wins.Count -eq 1) -and ($null -ne $tab)) "companion windows: $($wins.Count)"
  if ($tab) {
    $f = [W]::Frame($fake.H); $s = [W]::GetDpiForWindow($fake.H) / 96.0
    $e = Expected-Tab $f $s (Work-Area $fake); $r = [W]::Rect($tab)
    Check 'no room either side / tab position' (Same $r $e) "actual $(Show-Rect $r), expected $(Show-Expected $e)"
  }
  & $exe --expand | Out-Null
  Start-Sleep -Milliseconds 1200
  Send-Fake $fake ('move {0} {1} {2} {3}' -f ($wa[0] + 300), ($wa[1] + 200), $fw, $fh)
  Start-Sleep -Milliseconds 1500
  $panel = Check-Panel 'back from edge' $fake $companion.Id 'right'

  # Collapse to the edge tab and expand again from the command line.
  & $exe --collapse | Out-Null
  Check 'collapse / exit code' ($LASTEXITCODE -eq 0) "exit $LASTEXITCODE"
  Start-Sleep -Milliseconds 1200
  $wins = Get-Windows $companion.Id
  $tab = $wins | Where-Object { (Width $_) -le 200 } | Select-Object -First 1
  Check 'collapse / only the tab is shown' (($wins.Count -eq 1) -and ($null -ne $tab)) "companion windows: $($wins.Count)"
  if ($tab) {
    $f = [W]::Frame($fake.H); $s = [W]::GetDpiForWindow($fake.H) / 96.0
    $e = Expected-Tab $f $s (Work-Area $fake); $r = [W]::Rect($tab)
    Check 'collapse / tab outside the ZCode edge' (Same $r $e) "actual $(Show-Rect $r), expected $(Show-Expected $e)"
  }
  & $exe --expand | Out-Null
  Check 'expand / exit code' ($LASTEXITCODE -eq 0) "exit $LASTEXITCODE"
  Start-Sleep -Milliseconds 1200
  $panel = Check-Panel 'expanded' $fake $companion.Id 'right'
  $wins = Get-Windows $companion.Id
  Check 'expanded / tab hidden' (@($wins | Where-Object { (Width $_) -le 200 }).Count -eq 0) "companion windows: $($wins.Count)"

  # A click on the tray icon folds the panel to the tab and brings it back; a double click toggles once.
  [W]::TrayClick([uint32]$companion.Id, $false); Start-Sleep -Milliseconds 1200
  Check-Tab 'tray click' $fake $companion.Id | Out-Null
  [W]::TrayClick([uint32]$companion.Id, $false); Start-Sleep -Milliseconds 1200
  Check-Panel 'tray click again' $fake $companion.Id 'right' | Out-Null
  [W]::TrayClick([uint32]$companion.Id, $true); Start-Sleep -Milliseconds 1200
  Check-Tab 'tray double click' $fake $companion.Id | Out-Null
  & $exe --expand | Out-Null
  Start-Sleep -Milliseconds 1200
  # Out of sight, a click on the tray icon or the hotkey asks for the panel: it is there when ZCode is back, not folded
  # away to the tab.
  Send-Fake $fake 'min'
  Start-Sleep -Milliseconds 1500
  [W]::TrayClick([uint32]$companion.Id, $false); Start-Sleep -Milliseconds 800
  Send-Fake $fake 'restore'
  Start-Sleep -Milliseconds 1500
  $panel = Check-Panel 'tray click while ZCode is minimized' $fake $companion.Id 'right'
  if ((Read-LogSinceMark) -match 'hotkey is unavailable') { Write-Output 'SKIP  hotkey while ZCode is minimized: another program holds Ctrl+Alt+M' }
  else {
    Send-Fake $fake 'min'
    Start-Sleep -Milliseconds 1500
    [W]::HotKey(); Start-Sleep -Milliseconds 800
    Send-Fake $fake 'restore'
    Start-Sleep -Milliseconds 1500
    $panel = Check-Panel 'hotkey while ZCode is minimized' $fake $companion.Id 'right'
  }

  # ZCode closes and opens again.
  Send-Fake $fake 'quit'
  $fake.P.WaitForExit(5000) | Out-Null
  Start-Sleep -Milliseconds 1500
  $n = (Get-Windows $companion.Id).Count
  Check 'ZCode closed / companion hidden' ($n -eq 0) "companion windows: $n"
  Check 'ZCode closed / companion keeps running' (-not $companion.HasExited) ''
  $fake = Start-Fake
  Start-Sleep -Milliseconds 2500
  $panel = Check-Panel 'ZCode reopened' $fake $companion.Id
  if ($panel) {
    Check-Theme 'ZCode reopened' $panel 'dark'
    & $exe --collapse | Out-Null
    Start-Sleep -Milliseconds 1200
    $wins = Get-Windows $companion.Id
    $tab = $wins | Where-Object { (Width $_) -le 200 } | Select-Object -First 1
    if ($tab) { Check-Corners 'collapsed tab' $tab (Join-Path $root 'build\companion-dev\tab.png') } else { Check 'collapsed tab / shown' $false '' }
    & $exe --expand | Out-Null
    Start-Sleep -Milliseconds 1200
    $r = [W]::Rect($panel)
    $bmp = New-Object Drawing.Bitmap ($r.Rt - $r.L), ($r.B - $r.T)
    $g = [Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size); $g.Dispose()
    $bmp.Save($shot, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    Write-Output "panel screenshot (panel area only): $shot"
  }

  # Child processes: Node bound to loopback, no token on any command line.
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($companion.Id)")
  foreach ($c in $children) { Check "child $($c.Name) / no token on command line" (-not ($c.CommandLine -match 'k=|TOKEN|[0-9a-f]{64}')) "pid $($c.ProcessId)" }
  $nodes = @($children | Where-Object { $_.Name -eq 'node.exe' })
  Check 'node server / one child' ($nodes.Count -eq 1) "count $($nodes.Count)"
  # An installed copy runs the Node.js the installer put beside bin, whatever PATH holds.
  $bundled = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $exe) '..\node\node.exe'))
  if (Test-Path -LiteralPath $bundled) { Check 'node server / bundled runtime' (($nodes.Count -eq 1) -and ($nodes[0].ExecutablePath -eq $bundled)) "$($nodes[0].ExecutablePath)" }
  $listen = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $nodes.ProcessId -contains $_.OwningProcess })
  Check 'node server / listens on loopback only' (($listen.Count -ge 1) -and (@($listen | Where-Object { $_.LocalAddress -ne '127.0.0.1' }).Count -eq 0)) (($listen | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" }) -join ' ')

  # --quit stops everything.
  & $exe --quit | Out-Null
  Check 'quit / exit code' ($LASTEXITCODE -eq 0) "exit $LASTEXITCODE"
  Start-Sleep -Seconds 1
  Check 'quit / host stopped' (-not (Get-Process -Id $companion.Id -ErrorAction SilentlyContinue)) ''
  foreach ($c in $children) { Check "quit / $($c.Name) stopped" (-not (Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue)) "pid $($c.ProcessId)" }

  # Started while ZCode is minimized, the companion comes up in the theme it saw last (dark), so when ZCode comes
  # back from the taskbar in front of something white the panel neither starts light nor flashes light.
  Send-Fake $fake 'backdrop white'
  Send-Fake $fake 'min'
  Mark-Log
  $companion = Start-Process -FilePath $exe -PassThru
  $port = Wait-Ready
  Check 'started while minimized / server ready' ($null -ne $port) "port $port"
  Start-Sleep -Seconds 3
  # Started by hand with nothing in sight, it says it is running and where it will show.
  Check 'started while minimized / says it is running' ((Read-LogSinceMark) -match 'startup notice: zcode minimized') ''
  Send-Fake $fake 'restore'
  Check-NoFlash 'started while minimized' $companion.Id 'light'
  Send-Fake $fake 'backdrop off'
  & $exe --quit | Out-Null
  Check 'started while minimized / quit' ($LASTEXITCODE -eq 0) "exit $LASTEXITCODE"
  Start-Sleep -Seconds 1

  # --background, as at sign-in, shows the panel or the tab as the user left it, and says nothing even while ZCode is
  # out of sight.
  Mark-Log
  $companion = Start-Process -FilePath $exe -ArgumentList '--background' -PassThru
  $port = Wait-Ready
  Check 'background / server ready' ($null -ne $port) "port $port"
  Start-Sleep -Seconds 3
  Check-Panel 'background, left expanded' $fake $companion.Id 'right' | Out-Null
  & $exe --collapse | Out-Null
  Start-Sleep -Milliseconds 1200
  & $exe --quit | Out-Null
  Check 'background quit / exit code' ($LASTEXITCODE -eq 0) "exit $LASTEXITCODE"
  Start-Sleep -Seconds 1
  Check 'background quit / host stopped' (-not (Get-Process -Id $companion.Id -ErrorAction SilentlyContinue)) ''
  Send-Fake $fake 'min'
  Mark-Log
  $companion = Start-Process -FilePath $exe -ArgumentList '--background' -PassThru
  $port = Wait-Ready
  Check 'background, left collapsed / server ready' ($null -ne $port) "port $port"
  Start-Sleep -Seconds 3
  Check 'background / no startup note' (-not ((Read-LogSinceMark) -match 'startup notice')) ''
  Send-Fake $fake 'restore'
  Start-Sleep -Milliseconds 1500
  Check-Tab 'background, left collapsed' $fake $companion.Id | Out-Null
  # The runs below start with the panel out again.
  & $exe --expand | Out-Null
  Start-Sleep -Milliseconds 1200
  & $exe --quit | Out-Null
  Check 'background, left collapsed / quit' ($LASTEXITCODE -eq 0) "exit $LASTEXITCODE"
  Start-Sleep -Seconds 1

  # Saved keys: masked by default, the eye shows the full key, and collapsing or ZCode hiding masks it again.
  # Only this last run has a service, saved with a fake key in the temporary config.
  [IO.File]::WriteAllText($config, '{"schemaVersion":1,"config":{"providerOrder":["smoke"],"providerConfigRules":{"providerRules":[{"providerId":"smoke","providerName":"Smoke Service","config":{"group":"standard-personal","access":{"type":"api-key","apiKey":"' + $fakeKey + '"},"api":{"type":"openai-chat-completions","baseUrl":"https://fake.example.com/v1"},"personalModelIds":["m1"]}}]},"modelConfigRules":{"providerModelRules":[],"manualProviderModelRules":[]}}}', (New-Object Text.UTF8Encoding $false))
  Mark-Log
  $companion = Start-Process -FilePath $exe -PassThru
  $port = Wait-Ready
  Check 'keys / server ready' ($null -ne $port) "port $port"
  Check 'keys / connect page opens' (Open-Page $companion.Id $connectName) ''
  $k = Wait-Keys $companion.Id { param($x) $x.Masked -ge 1 }
  Check 'keys / saved key masked by default' (($k.Masked -eq 1) -and ($k.Shown -eq 0) -and ($k.Pressed -eq 'Off')) (Show-Keys $k)
  $k = Reveal-Key $companion.Id
  Check 'keys / eye shows the full key' (($k.Shown -eq 1) -and ($k.Masked -eq 0) -and ($k.Pressed -eq 'On')) (Show-Keys $k)
  & $exe --collapse | Out-Null
  Start-Sleep -Milliseconds 1200
  & $exe --expand | Out-Null
  $k = Wait-Keys $companion.Id { param($x) $x.Masked -ge 1 }
  Check 'keys / masked again after collapse and expand' (($k.Masked -eq 1) -and ($k.Shown -eq 0) -and ($k.Pressed -eq 'Off')) (Show-Keys $k)
  $k = Reveal-Key $companion.Id
  Check 'keys / eye shows the key again' ($k.Shown -eq 1) (Show-Keys $k)
  Send-Fake $fake 'min'
  Start-Sleep -Milliseconds 1500
  Send-Fake $fake 'restore'
  $k = Wait-Keys $companion.Id { param($x) $x.Masked -ge 1 }
  Check 'keys / masked again after ZCode is minimized and restored' (($k.Masked -eq 1) -and ($k.Shown -eq 0) -and ($k.Pressed -eq 'Off')) (Show-Keys $k)

  # Changing and deleting the service from the panel: the temporary config follows, each write leaves one backup,
  # the new key stays masked until its eye is clicked, and delete only happens after the confirm button.
  $rules = { param($c) @($c.config.providerConfigRules.providerRules) }
  Check 'change / edit opens' (Press $companion.Id $editName) ''
  $filled = (Fill $companion.Id 'svcUrl0' $newUrl) -and (Fill $companion.Id 'svcKey0' $newKey)
  Check 'change / address and key typed' $filled ''
  Check 'change / save' (Press $companion.Id $saveName) ''
  $c = Wait-Config { param($x) @(& $rules $x)[0].config.api.baseUrl -eq $newUrl }
  $rule = @(& $rules $c)[0]
  Check 'change / address saved' ($rule.config.api.baseUrl -eq $newUrl) "baseUrl $($rule.config.api.baseUrl)"
  Check 'change / key saved' ($rule.config.access.apiKey -eq $newKey) ''
  Check 'change / one backup' ((Count-Backups) -eq 1) "backups $(Count-Backups)"
  Check 'change / panel shows the new address' ($null -ne (Find-Element $companion.Id $nameProperty $newUrl)) ''
  Check 'change / edit fields gone after saving' (Wait-Gone $companion.Id $idProperty 'svcKey0') ''
  $k = Wait-Keys $companion.Id { param($x) $x.Masked -ge 1 }
  Check 'change / new key masked' (($k.Masked -eq 1) -and ($k.Shown -eq 0) -and ($k.Pressed -eq 'Off')) (Show-Keys $k)
  $k = Reveal-Key $companion.Id
  Check 'change / eye shows the new key' (($k.Shown -eq 1) -and ($k.Pressed -eq 'On')) (Show-Keys $k)
  Check 'delete / asks first' ((Press $companion.Id $dropName) -and ($null -ne (Find-Element $companion.Id $nameProperty $confirmName))) ''
  Check 'delete / nothing removed before confirming' (@(& $rules ([IO.File]::ReadAllText($config) | ConvertFrom-Json)).Count -eq 1) ''
  Check 'delete / confirm' (Press $companion.Id $confirmName) ''
  $c = Wait-Config { param($x) @(& $rules $x).Count -eq 0 }
  Check 'delete / service removed from the config' ((@(& $rules $c).Count -eq 0) -and (@($c.config.providerOrder).Count -eq 0)) "rules $(@(& $rules $c).Count), order $(@($c.config.providerOrder).Count)"
  Check 'delete / second backup' ((Count-Backups) -eq 2) "backups $(Count-Backups)"
  Check 'delete / service gone from the panel' (Wait-Gone $companion.Id $nameProperty $editName) ''
  $k = Get-Keys $companion.Id
  Check 'delete / no key left on the page' (($k.Masked -eq 0) -and ($k.Shown -eq 0)) (Show-Keys $k)
  & $exe --quit | Out-Null
  Check 'keys quit / exit code' ($LASTEXITCODE -eq 0) "exit $LASTEXITCODE"
  Start-Sleep -Seconds 1
  $text = Read-LogSinceMark
  Check 'keys / keys never written to the log' (-not ($text.Contains($fakeKey) -or $text.Contains($newKey))) ''
}
catch { $script:failed++; Write-Output "FAIL  unexpected error: $($_.Exception.Message)" }
finally {
  if ($fake -and -not $fake.P.HasExited) { try { Send-Fake $fake 'quit' } catch { }; if (-not $fake.P.WaitForExit(3000)) { $fake.P.Kill() } }
  if (Get-Process -Name ModelHarbor -ErrorAction SilentlyContinue) { & $exe --quit | Out-Null }
  if (Test-Path $log) { Write-Output '--- companion log (whole test run)'; Get-Content -LiteralPath $log -Encoding UTF8 }
  Remove-Item Env:MODEL_HARBOR_DATA_DIR, Env:MODEL_HARBOR_ZCODE_EXE, Env:MODEL_HARBOR_CONFIG_PATH, Env:MODEL_HARBOR_REFRESH_CATALOG, Env:MODEL_HARBOR_UPDATE_URL -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 10 -and (Test-Path $tmp); $i++) { try { Remove-Item -LiteralPath $tmp -Recurse -Force } catch { Start-Sleep -Milliseconds 500 } }
  Write-Output "temp folder removed: $(-not (Test-Path $tmp))"
  Write-Output "SUMMARY passed=$($script:passed) failed=$($script:failed)"
}
# A failure is the exit code too, for npm run verify and the GitHub check.
if ($script:failed -gt 0) { exit 1 }
