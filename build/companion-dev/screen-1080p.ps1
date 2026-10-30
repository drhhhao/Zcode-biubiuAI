# Sets the primary screen to 1920 x 1080 for the window checks on GitHub's machines, whose screen starts at 1024 x 768:
# too small for the stand-in ZCode with the panel beside it, so the checks of the side the panel takes, and of its
# theme, would judge a layout no user has. Only the check workflow runs this (.github/workflows/check.yml); it is
# never needed on a real desktop.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Display {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
    public int dmFields, dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency, dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettings(string device, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ChangeDisplaySettings(ref DEVMODE dm, int flags);
  // DISP_CHANGE_SUCCESSFUL is 0; DM_PELSWIDTH | DM_PELSHEIGHT.
  public static int Set(int width, int height) {
    var dm = new DEVMODE();
    dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    if (!EnumDisplaySettings(null, -1, ref dm)) return -100;
    dm.dmPelsWidth = width; dm.dmPelsHeight = height; dm.dmFields = 0x80000 | 0x100000;
    return ChangeDisplaySettings(ref dm, 0);
  }
  // The mode in use now, read afresh: Windows Forms keeps the screen it saw first in a process.
  public static string Current() {
    var dm = new DEVMODE();
    dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    return EnumDisplaySettings(null, -1, ref dm) ? dm.dmPelsWidth + "x" + dm.dmPelsHeight : "unknown";
  }
}
'@
$before = [Display]::Current()
$result = [Display]::Set(1920, 1080)
Start-Sleep -Seconds 2
$after = [Display]::Current()
Write-Output "screen: $before -> $after (ChangeDisplaySettings $result)"
if ($after -ne '1920x1080') { Write-Output '::warning::the screen could not be set to 1920x1080; the window checks may judge a cramped layout' }
