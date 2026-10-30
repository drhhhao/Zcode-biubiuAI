// Builds the biubiu AI installer, dist/biubiuAI-Setup-<version>.exe: one file a user double-clicks, picks a folder in and
// installs from (app/installer/Setup.cs). It carries the companion app/build.mjs built into app/bin, the local service
// with every file it loads, the Node.js runtime that runs this script, and Microsoft's WebView2 Runtime bootstrapper,
// which the installer runs only where Windows lacks the runtime. Node.js and the bootstrapper must carry their
// publishers' valid signatures, and the companion this version. Nothing is downloaded here: the bootstrapper and the
// Node.js license wait in build/installer-deps.
// Usage: npm run app:installer (builds app/bin first, then this).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { drawLogo, encodePng, iconFile } from '../icon.mjs';
import { VERSION } from '../lib/tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.dirname(here);
const ROOT = path.dirname(APP_DIR);
export const DEPS_DIR = path.join(ROOT, 'build', 'installer-deps');
export const DIST_DIR = path.join(ROOT, 'dist');
// What app/build.mjs puts in app/bin: the host, the WebView2 SDK libraries with their license files, and the icon.
export const BIN_FILES = Object.freeze(['ModelHarbor.exe', 'ModelHarbor.exe.config', 'biubiu.ico', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll', 'WebView2.LICENSE.txt', 'WebView2.NOTICE.txt']);
export const MICROSOFT = 'CN=Microsoft Corporation,';
export const OPENJS = 'CN=OpenJS Foundation,';
export const setupName = version => `biubiuAI-Setup-${version}.exe`;

// The local service and every file it loads: server.mjs, then each module it imports and each file a module opens beside
// itself (new URL('./…', import.meta.url)), followed through. Tests and development tools stay out.
export function serviceFiles(dir = APP_DIR) {
  const found = new Set(), queue = ['server.mjs'];
  while (queue.length) {
    const file = queue.shift();
    if (found.has(file)) continue;
    found.add(file);
    if (!file.endsWith('.mjs')) continue;
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const m of text.matchAll(/\bfrom ['"](\.{1,2}\/[^'"]+)['"]|new URL\(['"](\.{1,2}\/[^'"]+)['"], import\.meta\.url\)/g))
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1] || m[2])));
  }
  return [...found].sort();
}

// The zip's entries: app/ is the install folder (bin beside the service, as in this tree, and node beside bin, where the
// host looks for its runtime); webview2/ holds the bootstrapper, which the installer runs from the temp folder.
export function payloadEntries({ node, nodeLicense, bootstrapper, uninstaller, dir = APP_DIR }) {
  return [
    ...BIN_FILES.map(name => ({ name: `app/bin/${name}`, file: path.join(dir, 'bin', name) })),
    ...serviceFiles(dir).map(file => ({ name: `app/${file}`, file: path.join(dir, file) })),
    { name: 'app/node/node.exe', file: node },
    { name: 'app/node/LICENSE.txt', file: nodeLicense },
    { name: 'app/Uninstall.exe', file: uninstaller },
    { name: 'webview2/MicrosoftEdgeWebview2Setup.exe', file: bootstrapper }
  ];
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  return table;
})();

export function crc32(data) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(data);
  let c = -1;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// A plain zip: deflated entries with UTF-8 names and one fixed time, so the same files make the same installer.
export function zip(entries) {
  const time = 0, date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const title = Buffer.from(name, 'utf8'), packed = zlib.deflateRawSync(data, { level: 9 }), crc = crc32(data);
    const local = Buffer.alloc(30), header = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(title.length, 26);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x0800, 8); header.writeUInt16LE(8, 10);
    header.writeUInt16LE(time, 12); header.writeUInt16LE(date, 14); header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(packed.length, 20); header.writeUInt32LE(data.length, 24); header.writeUInt16LE(title.length, 28); header.writeUInt32LE(offset, 42);
    parts.push(local, title, packed);
    central.push(header, title);
    offset += local.length + title.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

// The installer's version and name, from lib/tools.mjs like every other version in the project.
export function releaseSource(title, version = VERSION) {
  return [
    `[assembly: System.Reflection.AssemblyTitle("${title}")]`,
    '[assembly: System.Reflection.AssemblyProduct("biubiu AI")]',
    `[assembly: System.Reflection.AssemblyVersion("${version}.0")]`,
    `[assembly: System.Reflection.AssemblyFileVersion("${version}.0")]`,
    `[assembly: System.Reflection.AssemblyInformationalVersion("${version}")]`,
    `namespace ModelHarbor.Setup { static class Release { public const string Version = "${version}"; } }`,
    ''
  ].join('\n');
}

function fail(message) { console.error(`installer build failed: ${message}`); process.exit(1); }

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

// Started from PowerShell 7 (as GitHub Actions runs npm), Windows PowerShell would inherit PowerShell 7's module path
// and fail to load its own Get-AuthenticodeSignature; without PSModulePath it builds its own (as in app/build.mjs).
const windowsPowerShellEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'));

function powershell(script, env = {}) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...windowsPowerShellEnv(), ...env }, encoding: 'utf8' });
  if (result.status !== 0) fail(`PowerShell failed: ${result.stderr || result.error?.message}`);
  return result.stdout.trim();
}

// Every file must carry a valid Authenticode signature from the named publisher.
function requireSigned(files, subject) {
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $out=@(); foreach ($f in ($env:MH_VERIFY -split '\\|')) { $s=Get-AuthenticodeSignature -LiteralPath $f; $who=''; if ($s.SignerCertificate) { $who=$s.SignerCertificate.Subject }; $out += [pscustomobject]@{ file=$f; status=[string]$s.Status; subject=$who } }; ConvertTo-Json -Compress -InputObject @($out)`;
  for (const row of [JSON.parse(powershell(script, { MH_VERIFY: files.join('|') }))].flat()) {
    if (row.status !== 'Valid' || !String(row.subject).startsWith(subject)) fail(`${row.file} is not validly signed by ${subject} (${row.status}, ${row.subject || 'no signer'})`);
    console.log(`signature ok: ${path.basename(row.file)}`);
  }
}

function compile(csc, { out, title, resources, work }) {
  const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const release = path.join(work, `${path.basename(out, '.exe')}.release.cs`);
  fs.writeFileSync(release, releaseSource(title));
  const args = ['/nologo', '/noconfig', '/target:winexe', '/platform:anycpu', '/optimize+', '/deterministic', '/langversion:7.3', '/codepage:65001', '/warn:4',
    `/out:${out}`, `/win32manifest:${path.join(here, 'setup.manifest')}`, `/win32icon:${resources['biubiu.ico']}`, `/lib:${framework}`,
    '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:System.IO.Compression.dll',
    ...Object.entries(resources).map(([name, file]) => `/resource:${file},${name}`), path.join(here, 'Setup.cs'), release];
  const compiled = spawnSync(csc, args, { stdio: 'inherit' });
  if (compiled.status !== 0) fail(`csc exited with ${compiled.status ?? compiled.error?.message}`);
}

function main() {
  const csc = findCsc();
  const bin = path.join(APP_DIR, 'bin');
  for (const name of BIN_FILES) if (!fs.existsSync(path.join(bin, name))) fail(`app/bin/${name} is missing; run npm run app:build first`);
  const built = powershell('(Get-Item -LiteralPath $env:MH_FILE).VersionInfo.FileVersion', { MH_FILE: path.join(bin, 'ModelHarbor.exe') });
  if (built !== `${VERSION}.0`) fail(`app/bin/ModelHarbor.exe is ${built}, not ${VERSION}; run npm run app:build first`);
  const node = process.env.MODEL_HARBOR_BUNDLE_NODE || process.execPath;
  const nodeVersion = (spawnSync(node, ['--version'], { encoding: 'utf8' }).stdout || '').trim();
  if (Number((/^v(\d+)\./.exec(nodeVersion) || [])[1] || 0) < 22) fail(`${node} is ${nodeVersion || 'not Node.js'}; biubiu AI needs Node.js 22 or newer`);
  const nodeLicense = path.join(DEPS_DIR, 'node-LICENSE.txt'), bootstrapper = path.join(DEPS_DIR, 'MicrosoftEdgeWebview2Setup.exe');
  if (!fs.existsSync(nodeLicense)) fail(`the Node.js license is missing: put LICENSE from https://github.com/nodejs/node (the bundled version's tag) at ${nodeLicense}`);
  if (!fs.readFileSync(nodeLicense, 'utf8').startsWith('Node.js is licensed')) fail(`${nodeLicense} is not the Node.js license`);
  if (!fs.existsSync(bootstrapper)) fail(`the WebView2 Runtime bootstrapper is missing: put https://go.microsoft.com/fwlink/p/?LinkId=2124703 at ${bootstrapper}`);
  requireSigned([node], OPENJS);
  requireSigned([bootstrapper, ...['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll'].map(name => path.join(bin, name))], MICROSOFT);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'biubiu-installer-'));
  try {
    const icon = path.join(work, 'biubiu.ico'), logo = path.join(work, 'logo.png');
    fs.writeFileSync(icon, iconFile());
    fs.writeFileSync(logo, encodePng(drawLogo(192), 192, 192));
    const uninstaller = path.join(work, 'Uninstall.exe');
    compile(csc, { out: uninstaller, title: 'biubiu AI 卸载程序', resources: { 'biubiu.ico': icon, 'logo.png': logo }, work });
    const payload = path.join(work, 'payload.zip');
    const entries = payloadEntries({ node, nodeLicense, bootstrapper, uninstaller });
    fs.writeFileSync(payload, zip(entries.map(entry => ({ name: entry.name, data: fs.readFileSync(entry.file) }))));
    fs.mkdirSync(DIST_DIR, { recursive: true });
    const out = path.join(DIST_DIR, setupName(VERSION));
    compile(csc, { out, title: 'biubiu AI 安装程序', resources: { 'biubiu.ico': icon, 'logo.png': logo, 'payload.zip': payload }, work });
    const digest = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
    fs.writeFileSync(`${out}.sha256`, `${digest}  ${path.basename(out)}\n`);
    const installed = entries.filter(entry => entry.name.startsWith('app/')).reduce((sum, entry) => sum + fs.statSync(entry.file).size, 0);
    console.log(`  ${entries.length} files, Node.js ${nodeVersion}; installs ${(installed / 1048576).toFixed(1)} MB`);
    console.log(`built ${out}  ${(fs.statSync(out).size / 1048576).toFixed(1)} MB  sha256 ${digest}`);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
