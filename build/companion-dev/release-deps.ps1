# Fetches the third-party files the build and the installer need but the repository does not carry, for the release
# workflow (.github/workflows/release.yml) on a fresh GitHub machine. On this machine they are already in place and
# nothing is fetched: a file that exists is never replaced.
#   build/webview2-sdk/pkg-<version>/       Microsoft.Web.WebView2 from nuget.org, the exact package app/build.mjs expects
#   build/installer-deps/node-LICENSE.txt   LICENSE of the bundled Node.js, from its tag on github.com/nodejs/node
#   build/installer-deps/MicrosoftEdgeWebview2Setup.exe   the WebView2 Runtime bootstrapper from Microsoft
# The package and the license are checked against pinned SHA-256s; the bootstrapper changes over time, so its Microsoft
# signature is checked instead. app/build.mjs and app/installer/package.mjs check the signatures again.
$ErrorActionPreference = 'Stop'
# Started from PowerShell 7 (npm or a GitHub step under pwsh), Windows PowerShell inherits pwsh's PSModulePath and
# cannot load its own Microsoft.PowerShell.Security (Get-AuthenticodeSignature): keep only Windows PowerShell's folders.
if ($PSVersionTable.PSEdition -eq 'Desktop') {
  $env:PSModulePath = (@($env:PSModulePath -split ';' | Where-Object { $_ -and $_ -notmatch '\\PowerShell\\(7|Modules)' -and $_ -notmatch '\\Documents\\PowerShell\\' }) + (Join-Path $PSHOME 'Modules') | Select-Object -Unique) -join ';'
}
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

# Pinned: change these together with WEBVIEW2_VERSION in app/build.mjs, or with node-version in the release workflow.
$WebView2Version = '1.0.4314.35'
$WebView2Sha256 = '90778deb1b77e36292828b4b5833c9255c27533f40e0ddd55891ae718944edc4'
$NodeLicenses = @{ 'v24.19.0' = '148eacf7863ef4329224a29398623077200a27194aa075569faf4a0a85566ca5' }

function Sha256($file) { (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() }

function Fetch($url, $file) {
    New-Item -ItemType Directory -Force (Split-Path $file -Parent) | Out-Null
    for ($try = 1; ; $try++) {
        try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file; return }
        catch { if ($try -ge 3) { throw "download failed after 3 tries: $url ($($_.Exception.Message))" }; Start-Sleep -Seconds (5 * $try) }
    }
}

# The WebView2 SDK, unpacked as nuget.org has it.
$built = Join-Path $root 'app\build.mjs'
if ((Get-Content -Raw -LiteralPath $built) -notmatch "WEBVIEW2_VERSION = '$([regex]::Escape($WebView2Version))'") { throw "app/build.mjs expects another WebView2 SDK than $WebView2Version; update this script" }
$sdk = Join-Path $root "build\webview2-sdk\pkg-$WebView2Version"
if (Test-Path -LiteralPath (Join-Path $sdk 'Microsoft.Web.WebView2.nuspec')) { Write-Host "WebView2 SDK $WebView2Version already in place" }
else {
    $name = "microsoft.web.webview2.$WebView2Version.nupkg"
    $package = Join-Path $root "build\webview2-sdk\download\$name"
    if (-not (Test-Path -LiteralPath $package)) { Fetch "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$WebView2Version/$name" $package }
    $got = Sha256 $package
    if ($got -ne $WebView2Sha256) { Remove-Item -LiteralPath $package; throw "$name has SHA-256 $got, expected $WebView2Sha256" }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($package, $sdk)
    Write-Host "WebView2 SDK $WebView2Version unpacked (sha256 ok)"
}

# The license of the Node.js that runs the packaging, which is the one the installer bundles.
$license = Join-Path $root 'build\installer-deps\node-LICENSE.txt'
if (Test-Path -LiteralPath $license) { Write-Host 'Node.js license already in place' }
else {
    $node = (& node --version).Trim()
    if (-not $NodeLicenses.ContainsKey($node)) { throw "no pinned license hash for Node.js $node; pin the workflow's node-version or add its LICENSE hash here" }
    Fetch "https://raw.githubusercontent.com/nodejs/node/$node/LICENSE" $license
    $got = Sha256 $license
    if ($got -ne $NodeLicenses[$node]) { Remove-Item -LiteralPath $license; throw "the Node.js $node license has SHA-256 $got, expected $($NodeLicenses[$node])" }
    Write-Host "Node.js $node license fetched (sha256 ok)"
}

# The WebView2 Runtime bootstrapper: whatever Microsoft serves now, as long as Microsoft signed it.
$bootstrapper = Join-Path $root 'build\installer-deps\MicrosoftEdgeWebview2Setup.exe'
if (Test-Path -LiteralPath $bootstrapper) { Write-Host 'WebView2 Runtime bootstrapper already in place' }
else {
    Fetch 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' $bootstrapper
    $s = Get-AuthenticodeSignature -LiteralPath $bootstrapper
    if ($s.Status -ne 'Valid' -or -not $s.SignerCertificate.Subject.StartsWith('CN=Microsoft Corporation')) {
        Remove-Item -LiteralPath $bootstrapper
        throw "the WebView2 Runtime bootstrapper is not validly signed by Microsoft ($($s.Status))"
    }
    Write-Host 'WebView2 Runtime bootstrapper fetched (Microsoft signature ok)'
}
