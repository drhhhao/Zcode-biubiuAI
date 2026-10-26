// Builds the WebView2 desktop companion into app/bin with the Roslyn C# compiler.
// Uses the official Microsoft.Web.WebView2 NuGet package extracted under build/webview2-sdk,
// checks its version and Microsoft signatures, and never downloads anything itself.
// Usage: node app/build.mjs [--run]
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { iconFile } from './icon.mjs';

export const WEBVIEW2_VERSION = '1.0.4314.35';
const appDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(appDir);
const hostDir = path.join(appDir, 'host');
const binDir = path.join(appDir, 'bin');
const exe = path.join(binDir, 'ModelHarbor.exe');

function fail(message) { console.error(`build failed: ${message}`); process.exit(1); }

function findCsc() {
  const fromEnv = process.env.MODEL_HARBOR_CSC;
  if (fromEnv) { if (fs.existsSync(fromEnv)) return fromEnv; fail(`MODEL_HARBOR_CSC does not exist: ${fromEnv}`); }
  for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean)) {
    const vs = path.join(base, 'Microsoft Visual Studio');
    if (!fs.existsSync(vs)) continue;
    for (const year of fs.readdirSync(vs).sort().reverse()) {
      const yearDir = path.join(vs, year);
      if (!fs.statSync(yearDir).isDirectory()) continue;
      for (const edition of fs.readdirSync(yearDir)) {
        const csc = path.join(yearDir, edition, 'MSBuild', 'Current', 'Bin', 'Roslyn', 'csc.exe');
        if (fs.existsSync(csc)) return csc;
      }
    }
  }
  fail('Roslyn csc.exe not found. Install Visual Studio Build Tools with the C# compiler, or set MODEL_HARBOR_CSC.');
}

function findSdk() {
  const dir = process.env.MODEL_HARBOR_WEBVIEW2_SDK || path.join(root, 'build', 'webview2-sdk', `pkg-${WEBVIEW2_VERSION}`);
  const files = {
    nuspec: path.join(dir, 'Microsoft.Web.WebView2.nuspec'),
    core: path.join(dir, 'lib', 'net462', 'Microsoft.Web.WebView2.Core.dll'),
    winforms: path.join(dir, 'lib', 'net462', 'Microsoft.Web.WebView2.WinForms.dll'),
    loader: path.join(dir, 'runtimes', 'win-x64', 'native', 'WebView2Loader.dll'),
    license: path.join(dir, 'LICENSE.txt'),
    notice: path.join(dir, 'NOTICE.txt')
  };
  for (const [name, file] of Object.entries(files)) if (!fs.existsSync(file)) fail(`WebView2 SDK ${name} missing: ${file}. Extract Microsoft.Web.WebView2 ${WEBVIEW2_VERSION} from nuget.org there, or set MODEL_HARBOR_WEBVIEW2_SDK.`);
  const version = fs.readFileSync(files.nuspec, 'utf8').match(/<version>([^<]+)<\/version>/)?.[1];
  if (version !== WEBVIEW2_VERSION) fail(`WebView2 SDK version is ${version}, expected ${WEBVIEW2_VERSION}`);
  return files;
}

// Authenticode check through PowerShell; every shipped DLL must be validly signed by Microsoft.
function verifySignatures(files) {
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $out=@(); foreach ($f in ($env:MH_VERIFY -split '\\|')) { $s=Get-AuthenticodeSignature -LiteralPath $f; $subject=''; if ($s.SignerCertificate) { $subject=$s.SignerCertificate.Subject }; $out += [pscustomobject]@{ file=$f; status=[string]$s.Status; subject=$subject } }; ConvertTo-Json -Compress -InputObject @($out)`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...process.env, MH_VERIFY: files.join('|') }, encoding: 'utf8' });
  if (result.status !== 0) fail(`signature check could not run: ${result.stderr || result.error?.message}`);
  let rows;
  try { rows = JSON.parse(result.stdout.trim()); } catch { fail(`signature check returned unreadable output: ${result.stdout}`); }
  for (const row of [rows].flat()) {
    if (row.status !== 'Valid' || !String(row.subject).startsWith('CN=Microsoft Corporation,')) fail(`${row.file} is not validly signed by Microsoft (${row.status}, ${row.subject || 'no signer'})`);
    console.log(`signature ok: ${path.basename(row.file)}`);
  }
}

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function copyVerified(from, name) {
  const to = path.join(binDir, name);
  fs.copyFileSync(from, to);
  if (sha256(from) !== sha256(to)) fail(`copy of ${name} does not match its source`);
}

const csc = findCsc();
const sdk = findSdk();
verifySignatures([sdk.core, sdk.winforms, sdk.loader]);

if (fs.existsSync(exe)) {
  const quit = spawnSync(exe, ['--quit'], { timeout: 20000 });
  if (quit.status !== 0) fail('a running biubiu AI companion did not exit; quit it from the tray icon and build again');
}
fs.mkdirSync(binDir, { recursive: true });
// The app icon, drawn from app/lib/logo.mjs: embedded in the exe, and beside it so windows can load every size.
const icon = path.join(binDir, 'biubiu.ico');
fs.writeFileSync(icon, iconFile());

const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const args = [
  '/nologo', '/noconfig', '/target:winexe', '/platform:x64', '/optimize+', '/deterministic', '/langversion:7.3', '/codepage:65001', '/warn:4',
  `/out:${exe}`, `/win32manifest:${path.join(hostDir, 'app.manifest')}`, `/win32icon:${icon}`, `/lib:${framework}`,
  '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll', '/r:System.Security.dll', '/r:System.Windows.Forms.dll',
  `/r:${sdk.core}`, `/r:${sdk.winforms}`,
  path.join(hostDir, 'ModelHarbor.cs')
];
console.log(`compiling with ${csc}`);
const compiled = spawnSync(csc, args, { stdio: 'inherit' });
if (compiled.status !== 0) fail(`csc exited with ${compiled.status ?? compiled.error?.message}`);

copyVerified(sdk.core, 'Microsoft.Web.WebView2.Core.dll');
copyVerified(sdk.winforms, 'Microsoft.Web.WebView2.WinForms.dll');
copyVerified(sdk.loader, 'WebView2Loader.dll');
copyVerified(sdk.license, 'WebView2.LICENSE.txt');
copyVerified(sdk.notice, 'WebView2.NOTICE.txt');
copyVerified(path.join(hostDir, 'ModelHarbor.exe.config'), 'ModelHarbor.exe.config');

for (const name of fs.readdirSync(binDir).sort()) console.log(`  ${name}  ${fs.statSync(path.join(binDir, name)).size} bytes`);
console.log(`built ${exe}`);

if (process.argv.includes('--run')) {
  spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  console.log('companion started');
}
