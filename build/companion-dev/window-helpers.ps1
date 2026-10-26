# Window helpers for the installer scripts (installer-check.ps1, docs-installer.ps1): finding a window by its title,
# photographing it as Windows draws it, and clicking and reading its controls through MSAA and UI Automation.
# Dot-source it: . (Join-Path $PSScriptRoot 'window-helpers.ps1')
Add-Type -ReferencedAssemblies System.Drawing, Accessibility -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
public static class Win {
  delegate bool P(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] struct R { public int L, T, Rt, B; }
  [DllImport("user32.dll")] static extern bool EnumWindows(P p, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out R r, int s);
  public static void PerMonitor() { SetThreadDpiAwarenessContext(new IntPtr(-4)); }
  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { var s = new StringBuilder(256); GetWindowText(h, s, 256); if (IsWindowVisible(h) && s.ToString() == title) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  // The window as Windows draws it, title bar included, cut to its visible frame.
  public static void Save(IntPtr h, string file) {
    R r, f; GetWindowRect(h, out r);
    if (DwmGetWindowAttribute(h, 9, out f, 16) != 0) f = r;
    using (var whole = new Bitmap(r.Rt - r.L, r.B - r.T, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(whole)) { IntPtr dc = g.GetHdc(); PrintWindow(h, dc, 2); g.ReleaseHdc(dc); }
      using (var cut = whole.Clone(new Rectangle(f.L - r.L, f.T - r.T, f.Rt - f.L, f.B - f.T), PixelFormat.Format32bppArgb)) cut.Save(file, ImageFormat.Png);
    }
  }
  public static void Close(IntPtr h) { PostMessage(h, 0x10, IntPtr.Zero, IntPtr.Zero); }
  // Buttons and check boxes through MSAA, as a screen reader works them: the default action clicks, the state tells ticks.
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr h, uint id, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object acc);
  static Accessibility.IAccessible Acc(IntPtr h) {
    Guid iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71"); object acc;
    return AccessibleObjectFromWindow(h, 0xFFFFFFFC, ref iid, out acc) == 0 ? acc as Accessibility.IAccessible : null;
  }
  public static bool Press(IntPtr h) { var acc = Acc(h); if (acc == null) return false; acc.accDoDefaultAction(0); return true; }
  public static bool Ticked(IntPtr h) { var acc = Acc(h); return acc != null && (Convert.ToInt32(acc.get_accState(0)) & 0x10) != 0; }
}
'@
[Win]::PerMonitor()

# Windows PowerShell reads this file in the system code page, so Chinese is written as U+ escapes.
function Zh([string]$text) { return [regex]::Replace($text, 'U[+]([0-9A-F]{4})', { param($m) [string][char][Convert]::ToInt32($m.Groups[1].Value, 16) }) }
$setupTitle = Zh 'U+5B89U+88C5 biubiu AI'
$uninstallTitle = Zh 'U+5378U+8F7D biubiu AI'

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
function Wait-Window([string]$title) {
  $h = [IntPtr]::Zero; $deadline = (Get-Date).AddSeconds(20)
  while ($h -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200; $h = [Win]::Find($title) }
  return $h
}
# The control with this name in the window, once it is on screen; null when it does not come in time. Windows' managed
# UI Automation sees the installer's own painted controls only by name, so they are clicked through MSAA (Win.Press).
function Find-Shown([IntPtr]$window, [string]$name, [int]$seconds) {
  $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $name)
  $deadline = (Get-Date).AddSeconds($seconds)
  do {
    $el = [Windows.Automation.AutomationElement]::FromHandle($window).FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
    if ($el -and -not $el.Current.IsOffscreen) { return $el }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  return $null
}
function Press([IntPtr]$window, [string]$name) {
  $el = Find-Shown $window $name 10
  return (($null -ne $el) -and [Win]::Press([IntPtr]$el.Current.NativeWindowHandle))
}
# Photographs the window with this title (from any process), then closes it as the user's close button would.
function Shot-Window([string]$title, [string]$file) {
  $h = [IntPtr]::Zero; $deadline = (Get-Date).AddSeconds(20)
  while ($h -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200; $h = [Win]::Find($title) }
  if ($h -eq [IntPtr]::Zero) { return $false }
  Start-Sleep -Milliseconds 800
  [Win]::Save($h, $file)
  [Win]::Close($h)
  $deadline = (Get-Date).AddSeconds(10)
  while ([Win]::Find($title) -ne [IntPtr]::Zero -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
  return ([Win]::Find($title) -eq [IntPtr]::Zero)
}
