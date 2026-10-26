# Pictures of the installer for docs/tutorial.md, written to docs/images/ (npm run app:installer first): its page as a
# user first sees it (the default folder, both boxes ticked), the progress, its last page, and the uninstaller's question
# and last page. It installs into the default folder through the window and uninstalls again, the way installer-check.ps1
# does with temporary folders: it refuses to run where biubiu AI is installed or the default folder holds anything, clears
# both boxes before installing (no desktop shortcut, no start at sign-in) and the start box before finishing, and the
# companion would follow only the stand-in ZCode with a temporary data folder.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$setup = Join-Path $root "dist\biubiuAI-Setup-$version.exe"
$out = Join-Path $root 'docs\images'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ModelHarbor'
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'biubiu AI.lnk'
$dir = Join-Path $env:LOCALAPPDATA 'Programs\biubiu AI'

if (-not (Test-Path -LiteralPath $setup)) { throw "missing $setup; run npm run app:installer first" }
if ((Test-Path $uninstallKey) -or (Test-Path -LiteralPath $startMenu)) { throw 'biubiu AI is installed on this machine; uninstall it before taking the tutorial pictures' }
if ((Test-Path -LiteralPath $dir) -and @(Get-ChildItem -LiteralPath $dir -Force).Count) { throw "$dir holds files already; these pictures install there" }
New-Item -ItemType Directory -Force -Path $out | Out-Null

. (Join-Path $PSScriptRoot 'window-helpers.ps1')
function Ticked-Box([IntPtr]$window, [string]$name) { $el = Find-Shown $window $name 5; return [IntPtr]$el.Current.NativeWindowHandle }
function Clear-Box([IntPtr]$box) { if ([Win]::Ticked($box)) { [void][Win]::Press($box); Start-Sleep -Milliseconds 300 } }

$tmp = Join-Path $env:LOCALAPPDATA ('Temp\mh-docs-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$env:MODEL_HARBOR_ZCODE_EXE = 'FakeZCode.exe'; $env:MODEL_HARBOR_DATA_DIR = Join-Path $tmp 'data'; $env:MODEL_HARBOR_UPDATE_URL = 'off'
$ui = $null
try {
  # The installer's page, as it opens.
  $ui = Start-Process -FilePath $setup -PassThru
  $window = Wait-Window $setupTitle
  if ($window -eq [IntPtr]::Zero) { throw 'the installer window did not open' }
  Start-Sleep -Milliseconds 900
  [Win]::Save($window, (Join-Path $out 'install-1.png'))
  Clear-Box (Ticked-Box $window (Zh 'U+5728U+684CU+9762U+521BU+5EFAU+5FEBU+6377U+65B9U+5F0F'))
  Clear-Box (Ticked-Box $window (Zh 'U+767BU+5F55 Windows U+540EU+5728U+540EU+53F0U+5F85U+547DU+FF0CU+6253U+5F00 ZCode U+65F6U+81EAU+52A8U+51FAU+73B0'))
  if (-not (Press $window (Zh 'U+5B89U+88C5'))) { throw 'the install button was not found' }
  # The progress page, caught while it copies.
  if (Find-Shown $window (Zh 'U+6B63U+5728U+5B89U+88C5 biubiu AI') 10) { Start-Sleep -Milliseconds 250; [Win]::Save($window, (Join-Path $out 'install-2.png')) }
  $finish = Find-Shown $window (Zh 'U+5B8CU+6210') 120
  if (-not $finish) { throw 'the installer did not finish' }
  Start-Sleep -Milliseconds 600
  [Win]::Save($window, (Join-Path $out 'install-3.png'))
  Clear-Box (Ticked-Box $window (Zh 'U+73B0U+5728U+542FU+52A8 biubiu AI'))
  [void][Win]::Press([IntPtr]$finish.Current.NativeWindowHandle)
  if (-not $ui.WaitForExit(15000)) { throw 'the installer did not close' }

  # The uninstaller's question, then its last page.
  Start-Process -FilePath (Join-Path $dir 'Uninstall.exe') | Out-Null
  $window = Wait-Window $uninstallTitle
  if ($window -eq [IntPtr]::Zero) { throw 'the uninstaller window did not open' }
  Start-Sleep -Milliseconds 900
  [Win]::Save($window, (Join-Path $out 'uninstall-1.png'))
  if (-not (Press $window (Zh 'U+5378U+8F7D'))) { throw 'the uninstall button was not found' }
  $done = Find-Shown $window (Zh 'U+5B8CU+6210') 60
  if (-not $done) { throw 'the uninstaller did not finish' }
  Start-Sleep -Milliseconds 600
  [Win]::Save($window, (Join-Path $out 'uninstall-2.png'))
  [void][Win]::Press([IntPtr]$done.Current.NativeWindowHandle)
  $deadline = (Get-Date).AddSeconds(30)
  while (((Test-Path -LiteralPath $dir) -or (Test-Path $uninstallKey)) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
  Write-Output 'install-1.png, install-2.png, install-3.png, uninstall-1.png, uninstall-2.png'
} finally {
  if ($ui -and -not $ui.HasExited) { try { $ui.Kill() } catch { } }
  $exe = Join-Path $dir 'bin\ModelHarbor.exe'
  if ((Test-Path -LiteralPath $exe) -and (Get-Process -Name ModelHarbor -ErrorAction SilentlyContinue)) { & $exe --quit | Out-Null }
  # Whatever an interrupted run left in the default folder goes the way the uninstaller would take it.
  if (Test-Path -LiteralPath (Join-Path $dir 'Uninstall.exe')) {
    Start-Process -FilePath (Join-Path $dir 'Uninstall.exe') -ArgumentList '--silent' -Wait | Out-Null
    $deadline = (Get-Date).AddSeconds(30)
    while ((Test-Path -LiteralPath $dir) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
  }
  Remove-Item Env:MODEL_HARBOR_ZCODE_EXE, Env:MODEL_HARBOR_DATA_DIR, Env:MODEL_HARBOR_UPDATE_URL -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  Get-ChildItem -LiteralPath $env:TEMP -Filter 'biubiu-ai-uninstall-*.exe' -ErrorAction SilentlyContinue | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
}
Write-Output ('left behind: install folder ' + (Test-Path -LiteralPath $dir) + ', Settings entry ' + (Test-Path $uninstallKey) + ', Start menu shortcut ' + (Test-Path -LiteralPath $startMenu))
