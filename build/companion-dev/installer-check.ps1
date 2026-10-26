# End-to-end check of the installer (npm run app:installer first). It installs dist\biubiuAI-Setup-<version>.exe
# silently into a temporary folder whose path has spaces and Chinese, checks the files, the Settings > Apps entry and the
# Start menu shortcut, runs the smoke test on the installed copy against the stand-in ZCode (FakeZCode.exe) with Node.js
# taken off PATH, updates it in place, then lets the installed copy update itself in one click from a stand-in for
# GitHub's latest release (and refuse a download whose SHA-256 differs), photographs the installer, the update question
# and the uninstaller, uninstalls it, installs once more
# into a folder holding other files to see they stay, and once through the window as a user clicks it. It refuses to run where biubiu AI is installed for real, never
# adds the start at sign-in or a desktop shortcut, never touches the companion's real data folder, and never starts the
# companion beside the real ZCode.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$setup = Join-Path $root "dist\biubiuAI-Setup-$version.exe"
$shots = Join-Path $root 'build\companion-dev'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ModelHarbor'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'biubiu AI.lnk'
$desktop = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'biubiu AI.lnk'
$realData = Join-Path $env:LOCALAPPDATA 'ModelHarbor'
$setupLog = Join-Path $env:TEMP 'biubiu-ai-setup.log'
$updateDownloads = Join-Path ([IO.Path]::GetTempPath()) 'biubiu-ai-update'

if (-not (Test-Path -LiteralPath $setup)) { throw "missing $setup; run npm run app:installer first" }
if (Test-Path $uninstallKey) { throw 'biubiu AI is installed on this machine (Settings > Apps lists it); uninstall it first, or check on another machine, so this check does not replace that entry' }
if (Test-Path -LiteralPath $startMenu) { throw 'a Start menu shortcut named biubiu AI exists already; this check would replace it' }

. (Join-Path $PSScriptRoot 'window-helpers.ps1')

$script:passed = 0; $script:failed = 0
function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { $script:passed++; [Console]::Out.WriteLine("PASS  $name  $detail") } else { $script:failed++; [Console]::Out.WriteLine("FAIL  $name  $detail") }
}
# Start-Process joins an argument array without quoting, so arguments go as one string with their own quotes.
function Run-Setup([string]$arguments) { return (Start-Process -FilePath $setup -ArgumentList $arguments -PassThru -Wait).ExitCode }
function Listed([string]$dir) { return @(Get-Content -LiteralPath (Join-Path $dir 'uninstall.list') -Encoding UTF8 | Where-Object { $_ -and -not $_.StartsWith('#') }) }
function Wait-Uninstalled([string]$dir) {
  $deadline = (Get-Date).AddSeconds(60)
  while (((Test-Path -LiteralPath $dir) -or (Test-Path $uninstallKey)) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
}

# Under LOCALAPPDATA rather than TEMP, which may be an 8.3 short path that process paths would not match.
$tmp = Join-Path $env:LOCALAPPDATA ('Temp\mh-setup-' + [guid]::NewGuid().ToString('N'))
$dir = Join-Path (Join-Path $tmp (Zh 'U+88C5 biubiu U+6D4BU+8BD5')) (Zh 'U+7A0BU+5E8F U+4F4DU+7F6E')
$uiDir = Join-Path $tmp 'ui install'
$ui = $null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dir) | Out-Null
$runBefore = (Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue).'ModelHarbor Companion'
$desktopBefore = Test-Path -LiteralPath $desktop
$dataBefore = Test-Path -LiteralPath $realData
$shell = New-Object -ComObject WScript.Shell
Remove-Item Env:MODEL_HARBOR_NODE, Env:MODEL_HARBOR_APP_SERVER -ErrorAction SilentlyContinue
$setupStart = Start-Process -FilePath $setup -PassThru
try {
  # The installer as a user first sees it, closed without installing.
  Check 'installer window / shown and closed' (Shot-Window $setupTitle (Join-Path $shots 'installer.png')) 'build\companion-dev\installer.png'
  Check 'installer window / nothing installed by closing' (-not (Test-Path $uninstallKey)) ''

  # A silent install into a path with spaces and Chinese.
  $code = Run-Setup "--silent --dir `"$dir`" --no-desktop --no-startup"
  Check 'install / exit code' ($code -eq 0) "exit $code"
  foreach ($f in 'bin\ModelHarbor.exe', 'bin\WebView2Loader.dll', 'bin\biubiu.ico', 'server.mjs', 'lib\core.mjs', 'lib\panel.html', 'lib\model-catalog.json', 'node\node.exe', 'node\LICENSE.txt', 'Uninstall.exe', 'uninstall.list') {
    Check "install / $f" (Test-Path -LiteralPath (Join-Path $dir $f)) ''
  }
  $files = @(Get-ChildItem -LiteralPath $dir -Recurse -File | ForEach-Object { $_.FullName.Substring($dir.Length + 1) })
  Check 'install / no tests or development tools' (@($files | Where-Object { $_ -match '\.test\.mjs$|preview|build\.mjs|icon\.mjs|logo\.mjs' }).Count -eq 0) ''
  $listed = Listed $dir
  Check 'install / the list names every file it put there' ((@(Compare-Object $listed $files)).Count -eq 0) "$($listed.Count) listed, $($files.Count) on disk"
  $node = Get-AuthenticodeSignature -LiteralPath (Join-Path $dir 'node\node.exe')
  Check 'install / Node.js keeps its signature' ($node.Status -eq 'Valid') "$($node.SignerCertificate.Subject)"
  $entry = Get-ItemProperty -Path $uninstallKey -ErrorAction SilentlyContinue
  Check 'install / Settings > Apps entry' ($entry -and $entry.DisplayName -eq 'biubiu AI' -and $entry.DisplayVersion -eq $version -and $entry.InstallLocation -eq $dir) "$($entry.DisplayName) $($entry.DisplayVersion)"
  Check 'install / uninstall command' ($entry.UninstallString -eq ('"' + (Join-Path $dir 'Uninstall.exe') + '"')) "$($entry.UninstallString)"
  Check 'install / Start menu shortcut' ((Test-Path -LiteralPath $startMenu) -and $shell.CreateShortcut($startMenu).TargetPath -eq (Join-Path $dir 'bin\ModelHarbor.exe')) ''
  Check 'install / no desktop shortcut when not asked' ((Test-Path -LiteralPath $desktop) -eq $desktopBefore) ''
  Check 'install / no start at sign-in when not asked' (((Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue).'ModelHarbor Companion') -eq $runBefore) ''

  # The installed copy passes the smoke test, with Node.js off PATH so only the runtime beside bin can serve it.
  $savedPath = $env:PATH
  $env:PATH = (($env:PATH -split ';') | Where-Object { $_ -and -not (Test-Path -LiteralPath (Join-Path $_ 'node.exe')) }) -join ';'
  $env:MODEL_HARBOR_EXE = Join-Path $dir 'bin\ModelHarbor.exe'
  try { $smoke = @(& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'smoke-host.ps1') 2>&1 | ForEach-Object { "$_" }) }
  finally { $env:PATH = $savedPath; Remove-Item Env:MODEL_HARBOR_EXE -ErrorAction SilentlyContinue }
  $smoke | Where-Object { $_ -match '^FAIL' } | ForEach-Object { [Console]::Out.WriteLine("      smoke: $_") }
  $summary = @($smoke | Where-Object { $_ -match '^SUMMARY' }) | Select-Object -Last 1
  Check 'installed copy / smoke test' ($summary -match 'failed=0') "$summary"
  Check 'installed copy / served by the bundled Node.js' (@($smoke | Where-Object { $_ -match '^PASS  node server / bundled runtime' }).Count -ge 1) ''

  # An update in place: the installed folder by default; a file the older version listed and this one lacks goes.
  $stale = Join-Path $dir 'lib\stale.mjs'
  [IO.File]::WriteAllText($stale, "// left by an older version`n", (New-Object Text.UTF8Encoding $false))
  [IO.File]::AppendAllText((Join-Path $dir 'uninstall.list'), "lib\stale.mjs`r`n", (New-Object Text.UTF8Encoding $false))
  $code = Run-Setup '--silent --no-desktop --no-startup'
  Check 'update / exit code' ($code -eq 0) "exit $code"
  Check 'update / into the installed folder' ((Get-ItemProperty -Path $uninstallKey).InstallLocation -eq $dir) ''
  Check 'update / a file the new version lacks is removed' (-not (Test-Path -LiteralPath $stale)) ''
  Check 'update / the list is the new one' (-not ((Listed $dir) -contains 'lib\stale.mjs')) ''

  # The companion's one-click update. A stand-in for GitHub's latest release on 127.0.0.1 (release-stand-in.mjs) names a
  # newer version whose installer is this one. The installed copy, with a temporary data folder and no ZCode to follow,
  # tells of it once; asked (--check-update) and answered yes, it downloads the installer through the stand-in's redirect,
  # checks its SHA-256 and runs it, which quits the companion, installs in place leaving the desktop shortcut and the
  # start at sign-in as they were, and starts it again. Then the stand-in names a SHA-256 the file does not have.
  $exeHere = Join-Path $dir 'bin\ModelHarbor.exe'
  $updateData = Join-Path $tmp 'update-data'
  $updateLog = Join-Path $updateData 'companion.log'
  $portFile = Join-Path $tmp 'stand-in.port'
  $standInLog = Join-Path $tmp 'stand-in.log'
  $askTitle = Zh 'biubiu AI U+66F4U+65B0'
  $fetched = '^GET /(download|files)/'
  function Log-Text { if (Test-Path -LiteralPath $updateLog) { return [string](Get-Content -LiteralPath $updateLog -Raw -Encoding UTF8) } return '' }
  # A companion started without the test's environment would write to the real data folder: stopped at once if so.
  $realLog = Join-Path $realData 'companion.log'
  $realLogSize = if (Test-Path -LiteralPath $realLog) { (Get-Item -LiteralPath $realLog).Length } else { 0 }
  function Escaped { return ((Test-Path -LiteralPath $realLog) -and ((Get-Item -LiteralPath $realLog).Length -ne $realLogSize)) }
  $standIn = Start-Process -FilePath (Get-Command node).Source -ArgumentList "`"$(Join-Path $PSScriptRoot 'release-stand-in.mjs')`" `"$setup`" 0.9.0 `"$portFile`"" -PassThru -NoNewWindow -RedirectStandardOutput $standInLog
  $deadline = (Get-Date).AddSeconds(15)
  while (-not (Test-Path -LiteralPath $portFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
  $port = (Get-Content -LiteralPath $portFile -Raw).Trim()
  $setupLines = @(Get-Content -LiteralPath $setupLog -Encoding UTF8).Count
  $env:MODEL_HARBOR_ZCODE_EXE = 'FakeZCode.exe'; $env:MODEL_HARBOR_DATA_DIR = $updateData; $env:MODEL_HARBOR_UPDATE_URL = "http://127.0.0.1:$port/latest"
  try {
    $first = Start-Process -FilePath $exeHere -ArgumentList '--background' -PassThru
    $deadline = (Get-Date).AddSeconds(40)
    while (-not ((Log-Text) -match 'update 0\.9\.0 told in a balloon') -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    $ini = [string](Get-Content -LiteralPath (Join-Path $updateData 'companion.ini') -Raw -ErrorAction SilentlyContinue)
    Check 'one-click update / a newer version is told' (((Log-Text) -match 'update 0\.9\.0 told in a balloon') -and ($ini -match 'updateSeen=0\.9\.0')) ''
    Check 'one-click update / the version that ran is remembered' ($ini -match ('version=' + [regex]::Escape($version))) ''
    Check 'one-click update / nothing downloaded on its own' (-not (Select-String -LiteralPath $standInLog -Pattern $fetched -Quiet)) ''

    $code = (Start-Process -FilePath $exeHere -ArgumentList '--check-update' -PassThru -Wait).ExitCode
    $ask = Wait-Window $askTitle
    Check 'one-click update / asks before downloading' (($code -eq 0) -and ($ask -ne [IntPtr]::Zero) -and -not (Select-String -LiteralPath $standInLog -Pattern $fetched -Quiet)) "exit $code"
    if ($ask -ne [IntPtr]::Zero) {
      Start-Sleep -Milliseconds 500
      [Win]::Save($ask, (Join-Path $shots 'update-ask.png'))
      [void][Win]::PressId($ask, 6)
    }
    Check 'one-click update / the companion quits for the installer' ($first.WaitForExit(90000)) ''
    $second = $null; $deadline = (Get-Date).AddSeconds(60)
    while (-not $second -and (Get-Date) -lt $deadline) {
      $second = Get-Process -Name ModelHarbor -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $first.Id -and $_.Path -eq $exeHere } | Select-Object -First 1
      if (-not $second) { Start-Sleep -Milliseconds 300 }
    }
    Check 'one-click update / installed and started again' ($null -ne $second) ''
    # Started again in the environment the companion had (its log goes on in the temporary data folder), never in the
    # real one.
    $deadline = (Get-Date).AddSeconds(15)
    while ($second -and -not (Escaped) -and ([regex]::Matches((Log-Text), 'companion \S+ starting').Count -lt 2) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if (Escaped) { Start-Process -FilePath $exeHere -ArgumentList '--quit' -Wait | Out-Null }
    Check 'one-click update / started again in the same environment' ((-not (Escaped)) -and [regex]::Matches((Log-Text), 'companion \S+ starting').Count -eq 2) ''
    Check 'one-click update / the SHA-256 checked before the installer ran' ((Log-Text) -match 'update 0\.9\.0 downloaded and verified; starting the installer') ''
    Check 'one-click update / downloaded once, through the redirect' (@(Select-String -LiteralPath $standInLog -Pattern '^GET /files/').Count -eq 1) ''
    $after = @(Get-Content -LiteralPath $setupLog -Encoding UTF8 | Select-Object -Skip $setupLines)
    Check 'one-click update / a silent install in place' ((@($after | Where-Object { $_ -match [regex]::Escape("install $version to $dir") }).Count -eq 1) -and (@($after | Where-Object { $_ -match 'update from biubiu AI' }).Count -eq 1)) ''
    Check 'one-click update / no desktop shortcut added' ((Test-Path -LiteralPath $desktop) -eq $desktopBefore) ''
    Check 'one-click update / start at sign-in untouched' (((Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue).'ModelHarbor Companion') -eq $runBefore) ''
    Check 'one-click update / Settings > Apps entry still here' ((Get-ItemProperty -Path $uninstallKey).InstallLocation -eq $dir) ''
    # Started again, it looks once more (the third look) and finds the version already told.
    $deadline = (Get-Date).AddSeconds(30)
    while (([regex]::Matches((Log-Text), 'update check: latest 0\.9\.0').Count -lt 3) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    Check 'one-click update / told only once' (([regex]::Matches((Log-Text), 'update check: latest 0\.9\.0').Count -ge 3) -and ([regex]::Matches((Log-Text), 'told in a balloon').Count -eq 1)) ''
    Check 'one-click update / the download cleared away' (@(Get-ChildItem -LiteralPath $updateDownloads -File -ErrorAction SilentlyContinue).Count -eq 0) ''

    # A SHA-256 that does not match: the download is refused and deleted, and nothing runs.
    Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$port/wrong-hash" | Out-Null
    $setupLines = @(Get-Content -LiteralPath $setupLog -Encoding UTF8).Count
    $code = (Start-Process -FilePath $exeHere -ArgumentList '--check-update' -PassThru -Wait).ExitCode
    $ask = Wait-Window $askTitle
    Check 'wrong SHA-256 / asks first' (($code -eq 0) -and ($ask -ne [IntPtr]::Zero)) "exit $code"
    if ($ask -ne [IntPtr]::Zero) { [void][Win]::PressId($ask, 6) }
    $refused = "update 0\.9\.0 refused: the download does not match GitHub's sha256"
    $deadline = (Get-Date).AddSeconds(60)
    while (-not ((Log-Text) -match $refused) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    Check 'wrong SHA-256 / refused' ((Log-Text) -match $refused) ''
    Start-Sleep -Seconds 2
    Check 'wrong SHA-256 / nothing installed, the companion stays' ((-not $second.HasExited) -and (@(Get-Content -LiteralPath $setupLog -Encoding UTF8).Count -eq $setupLines)) ''
    Check 'wrong SHA-256 / the download deleted' (@(Get-ChildItem -LiteralPath $updateDownloads -File -ErrorAction SilentlyContinue).Count -eq 0) ''
    Check 'one-click update / the real data folder untouched' (-not (Escaped)) ''
  } finally {
    if (Get-Process -Name ModelHarbor -ErrorAction SilentlyContinue) { Start-Process -FilePath $exeHere -ArgumentList '--quit' -Wait | Out-Null }
    Remove-Item Env:MODEL_HARBOR_ZCODE_EXE, Env:MODEL_HARBOR_DATA_DIR, Env:MODEL_HARBOR_UPDATE_URL -ErrorAction SilentlyContinue
    if ($standIn -and -not $standIn.HasExited) { try { $standIn.Kill() } catch { } }
  }

  # The uninstaller as a user first sees it (from its copy in the temp folder), closed without removing anything.
  Start-Process -FilePath (Join-Path $dir 'Uninstall.exe') | Out-Null
  Check 'uninstaller window / shown and closed' (Shot-Window $uninstallTitle (Join-Path $shots 'uninstaller.png')) 'build\companion-dev\uninstaller.png'
  Check 'uninstaller window / nothing removed by closing' ((Test-Path -LiteralPath (Join-Path $dir 'bin\ModelHarbor.exe')) -and (Test-Path $uninstallKey)) ''

  # A silent uninstall.
  $code = (Start-Process -FilePath (Join-Path $dir 'Uninstall.exe') -ArgumentList '--silent' -PassThru -Wait).ExitCode
  Check 'uninstall / handed to its copy' ($code -eq 0) "exit $code"
  Wait-Uninstalled $dir
  Check 'uninstall / install folder removed' (-not (Test-Path -LiteralPath $dir)) ''
  Check 'uninstall / the folder around it kept' (Test-Path -LiteralPath (Split-Path -Parent $dir)) ''
  Check 'uninstall / Settings > Apps entry removed' (-not (Test-Path $uninstallKey)) ''
  Check 'uninstall / Start menu shortcut removed' (-not (Test-Path -LiteralPath $startMenu)) ''
  Check 'uninstall / the companion''s data folder kept' ((Test-Path -LiteralPath $realData) -eq $dataBefore) ''
  Check 'uninstall / start at sign-in untouched' (((Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue).'ModelHarbor Companion') -eq $runBefore) ''

  # A folder that holds other files gets a biubiu AI folder of its own, and the other files outlive the uninstall.
  $shared = Join-Path $tmp (Zh 'U+6709U+6587U+4EF6U+7684U+6587U+4EF6U+5939')
  New-Item -ItemType Directory -Force -Path $shared | Out-Null
  [IO.File]::WriteAllText((Join-Path $shared 'notes.txt'), 'mine', (New-Object Text.UTF8Encoding $false))
  $code = Run-Setup "--silent --dir `"$shared`" --no-desktop --no-startup"
  $inside = Join-Path $shared 'biubiu AI'
  Check 'shared folder / installs into a folder of its own' (($code -eq 0) -and (Test-Path -LiteralPath (Join-Path $inside 'bin\ModelHarbor.exe')) -and ((Get-ItemProperty -Path $uninstallKey).InstallLocation -eq $inside)) "exit $code"
  $code = (Start-Process -FilePath (Join-Path $inside 'Uninstall.exe') -ArgumentList '--silent' -PassThru -Wait).ExitCode
  Wait-Uninstalled $inside
  Check 'shared folder / uninstalled' (($code -eq 0) -and -not (Test-Path -LiteralPath $inside) -and -not (Test-Path $uninstallKey)) ''
  Check 'shared folder / the other files stay' ((Get-Content -LiteralPath (Join-Path $shared 'notes.txt') -Raw) -eq 'mine') ''

  # An install through the window as a user clicks it: the install button, then the finish button with the start box
  # cleared. Had the box stayed ticked, the companion would follow the stand-in ZCode with a temporary data folder.
  $env:MODEL_HARBOR_ZCODE_EXE = 'FakeZCode.exe'; $env:MODEL_HARBOR_DATA_DIR = Join-Path $tmp 'ui-data'
  try {
    $ui = Start-Process -FilePath $setup -ArgumentList "--dir `"$uiDir`" --no-desktop --no-startup" -PassThru
    $window = Wait-Window $setupTitle
    Check 'window install / opened' ($window -ne [IntPtr]::Zero) ''
    Check 'window install / install pressed' (Press $window (Zh 'U+5B89U+88C5')) ''
    $finish = Find-Shown $window (Zh 'U+5B8CU+6210') 120
    Check 'window install / finished' ($null -ne $finish) ''
    $launch = [IntPtr](Find-Shown $window (Zh 'U+73B0U+5728U+542FU+52A8 biubiu AI') 5).Current.NativeWindowHandle
    Check 'window install / start box ticked at first' ([Win]::Ticked($launch)) ''
    [void][Win]::Press($launch)
    Start-Sleep -Milliseconds 400
    Check 'window install / start box cleared' (-not [Win]::Ticked($launch)) ''
    [Win]::Save($window, (Join-Path $shots 'installer-done.png'))
    [void][Win]::Press([IntPtr]$finish.Current.NativeWindowHandle)
    Check 'window install / closed' ($ui.WaitForExit(15000)) ''
    Check 'window install / files and entry' ((Test-Path -LiteralPath (Join-Path $uiDir 'bin\ModelHarbor.exe')) -and ((Get-ItemProperty -Path $uninstallKey).InstallLocation -eq $uiDir)) ''
    Start-Sleep -Seconds 2
    Check 'window install / biubiu AI not started' (-not (Get-Process -Name ModelHarbor -ErrorAction SilentlyContinue)) ''
  } finally { Remove-Item Env:MODEL_HARBOR_ZCODE_EXE, Env:MODEL_HARBOR_DATA_DIR -ErrorAction SilentlyContinue }
  $code = (Start-Process -FilePath (Join-Path $uiDir 'Uninstall.exe') -ArgumentList '--silent' -PassThru -Wait).ExitCode
  Wait-Uninstalled $uiDir
  Check 'window install / uninstalled' (($code -eq 0) -and -not (Test-Path -LiteralPath $uiDir) -and -not (Test-Path $uninstallKey)) ''
} finally {
  if (-not $setupStart.HasExited) { try { $setupStart.Kill() } catch { } }
  if ($ui -and -not $ui.HasExited) { try { $ui.Kill() } catch { } }
  foreach ($exe in @((Join-Path $uiDir 'bin\ModelHarbor.exe'), (Join-Path $dir 'bin\ModelHarbor.exe'),(Join-Path $tmp ((Zh 'U+6709U+6587U+4EF6U+7684U+6587U+4EF6U+5939') + '\biubiu AI\bin\ModelHarbor.exe')))) {
    if ((Test-Path -LiteralPath $exe) -and (Get-Process -Name ModelHarbor -ErrorAction SilentlyContinue)) { & $exe --quit | Out-Null }
  }
  if ((Test-Path $uninstallKey) -and ((Get-ItemProperty $uninstallKey).InstallLocation -like "$tmp*")) { Remove-Item $uninstallKey -Recurse }
  if ((Test-Path -LiteralPath $startMenu) -and ($shell.CreateShortcut($startMenu).TargetPath -like "$tmp*")) { Remove-Item -LiteralPath $startMenu }
  Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
  # The uninstaller's copies in the temp folder, which a real install clears on its next run.
  Start-Sleep -Seconds 1
  Get-ChildItem -LiteralPath $env:TEMP -Filter 'biubiu-ai-uninstall-*.exe' -ErrorAction SilentlyContinue | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
  # The one-click update's download folder, which only an installed copy uses; this machine has none.
  Remove-Item -LiteralPath $updateDownloads -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output "SUMMARY passed=$($script:passed) failed=$($script:failed)"
if ($script:failed -gt 0) {
  if (Test-Path -LiteralPath $setupLog) { Write-Output '--- setup log (last 30 lines)'; Get-Content -LiteralPath $setupLog -Tail 30 -Encoding UTF8 }
  exit 1
}
