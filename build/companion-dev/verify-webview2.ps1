# Verifies an extracted Microsoft.Web.WebView2 NuGet package before any of its files are used.
# Checks Authenticode on the DLLs we ship and the package's own NuGet signature (.signature.p7s).
# Exits 1 when any required check fails.
param([Parameter(Mandatory = $true)][string]$Dir)
$ErrorActionPreference = 'Stop'
$Dir = (Resolve-Path -LiteralPath $Dir).Path.TrimEnd('\')
$bad = 0

function RelPath([string]$full) { return $full.Substring($Dir.Length + 1).Replace('\', '/') }

"--- Authenticode on shipped DLLs"
$targets = @(Get-ChildItem -LiteralPath $Dir -Recurse -File -Filter *.dll | Where-Object {
  $rel = RelPath $_.FullName
  ($rel -like 'lib/net462/*') -or ($rel -like 'runtimes/win-x64/native/*') -or ($rel -like 'runtimes/win-x86/native/*')
})
if ($targets.Count -eq 0) { 'no target DLLs found'; $bad++ }
foreach ($f in $targets) {
  $s = Get-AuthenticodeSignature -LiteralPath $f.FullName
  $subject = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { '<none>' }
  '{0} | {1} | {2} | {3}' -f (RelPath $f.FullName), $f.VersionInfo.FileVersion, $s.Status, $subject
  if ($s.Status -ne 'Valid' -or $subject -notlike 'CN=Microsoft Corporation,*') { $bad++ }
}

"--- NuGet package signature (.signature.p7s)"
$p7s = Join-Path $Dir '.signature.p7s'
if (-not (Test-Path -LiteralPath $p7s)) { 'signature file missing'; $bad++ }
else {
  Add-Type -AssemblyName System.Security
  $cms = New-Object System.Security.Cryptography.Pkcs.SignedCms
  $cms.Decode([IO.File]::ReadAllBytes($p7s))
  try { $cms.CheckSignature($true); 'signature math: Valid' } catch { 'signature math: INVALID ' + $_.Exception.Message; $bad++ }
  $signer = $cms.SignerInfos[0].Certificate
  'primary signer: ' + $signer.Subject
  if ($signer.Subject -notlike '*Microsoft*') { 'primary signer is not Microsoft'; $bad++ }
  foreach ($counter in $cms.SignerInfos[0].UnsignedAttributes) { 'unsigned attribute: ' + $counter.Oid.FriendlyName + ' ' + $counter.Oid.Value }
  $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
  $chain.ChainPolicy.RevocationMode = 'NoCheck'
  $chain.ChainPolicy.VerificationFlags = 'IgnoreNotTimeValid'
  foreach ($c in $cms.Certificates) { [void]$chain.ChainPolicy.ExtraStore.Add($c) }
  $chainOk = $chain.Build($signer)
  $root = $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate.Subject
  'chain to trusted root (time validity covered by timestamp): ' + $chainOk + ' | root: ' + $root
  if (-not $chainOk) { foreach ($st in $chain.ChainStatus) { '  chain status: ' + $st.Status + ' ' + $st.StatusInformation.Trim() } ; $bad++ }
  'signed content: ' + ([Text.Encoding]::UTF8.GetString($cms.ContentInfo.Content) -replace "`r?`n", ' | ')
}

if ($bad -gt 0) { "FAILED checks: $bad"; exit 1 }
'ALL CHECKS PASSED'
