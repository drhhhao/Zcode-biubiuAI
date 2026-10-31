import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../lib/tools.mjs';
import { APP_DIR, BIN_FILES, crc32, payloadEntries, releaseSource, serviceFiles, setupName, zip } from './package.mjs';
import { CHANGELOG, changes, notes } from '../../build/companion-dev/release-notes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = file => fs.readFile(path.join(APP_DIR, file), 'utf8');

// Reads a zip as the installer's ZipArchive does: the central directory first, then each entry's local header and data.
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const files = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50);
    const flags = buffer.readUInt16LE(at + 8), method = buffer.readUInt16LE(at + 10), crc = buffer.readUInt32LE(at + 16);
    const packed = buffer.readUInt32LE(at + 20), size = buffer.readUInt32LE(at + 24), nameLength = buffer.readUInt16LE(at + 28);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8'), local = buffer.readUInt32LE(at + 42);
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = zlib.inflateRawSync(buffer.subarray(start, start + packed));
    files.push({ name, flags, method, crc, size, data });
    at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  return files;
}

test('the installer carries the local service and every file it loads, and no tests or development tools', async () => {
  const files = serviceFiles();
  for (const file of ['server.mjs', 'lib/core.mjs', 'lib/metadata.mjs', 'lib/site.mjs', 'lib/tools.mjs', 'lib/panel.html', 'lib/model-catalog.json', 'lib/zcode-catalog.json'])
    assert.ok(files.includes(file), file);
  for (const file of files) {
    assert.ok(!/\.test\.mjs$|preview|build|icon|logo|(^|\/)dev\//.test(file), `${file} is not part of the service`);
    await fs.access(path.join(APP_DIR, file));
  }
  const entries = payloadEntries({ node: 'node.exe', nodeLicense: 'LICENSE', bootstrapper: 'setup.exe', uninstaller: 'Uninstall.exe' });
  const names = entries.map(e => e.name);
  for (const name of BIN_FILES) assert.ok(names.includes(`app/bin/${name}`), name);
  for (const name of ['app/server.mjs', 'app/node/node.exe', 'app/node/LICENSE.txt', 'app/Uninstall.exe', 'webview2/MicrosoftEdgeWebview2Setup.exe']) assert.ok(names.includes(name), name);
  assert.equal(new Set(names).size, names.length, 'no file twice');
  assert.ok(names.every(name => name.startsWith('app/') || name.startsWith('webview2/')));
  assert.equal(setupName(VERSION), `biubiuAI-Setup-${VERSION}.exe`);
});

test('the zip holds each file whole under its UTF-8 name, and the same files make the same zip', () => {
  const files = [
    { name: 'app/server.mjs', data: Buffer.from('export const ok = true;\n'.repeat(200)) },
    { name: 'app/lib/面板 说明.txt', data: Buffer.from('纸色与墨色', 'utf8') },
    { name: 'app/node/node.exe', data: crypto.randomBytes(300000) },
    { name: 'app/empty.txt', data: Buffer.alloc(0) }
  ];
  const packed = zip(files);
  const back = unzip(packed);
  assert.deepEqual(back.map(f => f.name), files.map(f => f.name));
  back.forEach((f, i) => {
    assert.ok(f.data.equals(files[i].data), f.name);
    assert.equal(f.size, files[i].data.length);
    assert.equal(f.crc, crc32(files[i].data));
    assert.equal(f.method, 8, 'deflated');
    assert.equal(f.flags & 0x0800, 0x0800, 'names flagged as UTF-8');
  });
  assert.ok(packed.equals(zip(files)), 'a fixed time keeps the installer reproducible');
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('the installer and the companion agree on the companion\'s names, and the host runs the Node.js beside bin', async () => {
  const setup = await read('installer/Setup.cs'), host = await read('host/BiubiuAI.cs');
  const value = (source, pattern) => { const m = source.match(pattern); assert.ok(m, String(pattern)); return m[1]; };
  assert.equal(value(setup, /QuitEvent = @"([^"]+)"/), value(host, /QuitEventName = @"([^"]+)"/));
  assert.equal(value(setup, /Mutex = @"([^"]+)"/), value(host, /MutexName = @"([^"]+)"/));
  assert.equal(value(setup, /RunValue = "([^"]+)"/), value(host, /const string ValueName = "([^"]+)"/));
  assert.equal(value(setup, /RunKey = @"([^"]+)"/), value(host, /const string RunKey = @"([^"]+)"/));
  assert.ok(setup.includes('Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "biubiu AI")') && host.includes('public const string DataFolder = "biubiu AI";'), 'the same data folder');
  // Up to 0.8.12 the names were the project's old working name: both sides know the same old ones, to carry an install over.
  const legacy = [['data folder', /LocalApplicationData\), "(ModelHarbor)"\)/], ['quit event', /QuitEvent(?:Name)? = @"(Local\\ModelHarbor\.Companion\.Quit)"/], ['startup entry', /RunValue = "(ModelHarbor Companion)"/]];
  for (const [name, pattern] of legacy)
    assert.equal(value(setup.slice(setup.indexOf('static class Legacy')), pattern), value(host.slice(host.indexOf('static class Legacy')), pattern), name);
  assert.ok(setup.includes('public const string Exe = "BiubiuAI.exe";') && setup.includes('return Path.Combine(dir, "bin", Exe);'));
  // bin beside the service, and node beside bin: where Locate looks before PATH.
  assert.ok(host.includes('string bundled = Path.GetFullPath(Path.Combine(Paths.AppDir, "..", "node", "node.exe"));'));
  assert.ok(host.indexOf('string bundled =') < host.indexOf('Environment.GetEnvironmentVariable("PATH")'), 'the bundled runtime comes before PATH');
  assert.ok(host.includes('string beside = Path.GetFullPath(Path.Combine(Paths.AppDir, "..", "server.mjs"));'));
  assert.ok(releaseSource('t').includes(`public const string Version = "${VERSION}";`) && releaseSource('t').includes(`AssemblyFileVersion("${VERSION}.0")`));
});

test('the installer installs for the current user only, stays out of ZCode, and removes only what it listed', async () => {
  const setup = await read('installer/Setup.cs'), manifest = await fs.readFile(path.join(here, 'setup.manifest'), 'utf8');
  // No elevation prompt, though Windows would guess one from the name Setup.
  assert.match(manifest, /<requestedExecutionLevel level="asInvoker" uiAccess="false"\/>/);
  assert.ok(setup.includes('Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", Name)'), 'per-user default folder');
  assert.ok(setup.includes('Registry.CurrentUser.CreateSubKey(Product.UninstallKey)') && !setup.includes('Registry.LocalMachine.CreateSubKey'), 'Settings > Apps for this user');
  assert.ok(!/\.zcode|provider_config/.test(setup), 'nothing of ZCode');
  // The start at sign-in is the companion's own entry, written only when ticked.
  assert.ok(setup.includes('if (startup == true) RunQuiet(exe, "--install-startup");'));
  assert.ok(setup.includes('else if (startup == false && StartupPointsInto(dir)) RunQuiet(exe, "--uninstall-startup");'));
  // biubiu AI starts through Explorer (unelevated) only after a UAC prompt; otherwise directly, keeping the environment
  // the companion's update ran the installer with.
  assert.ok(setup.includes('if (ElevatedByPrompt()) Process.Start(new ProcessStartInfo("explorer.exe", "\\"" + exe + "\\"") { UseShellExecute = false });'));
  assert.ok(setup.includes('GetTokenInformation(identity.Token, TokenElevationType, out type, sizeof(int), out returned) && type == TokenElevationTypeFull;'));
  assert.ok(!setup.includes('IsInRole(WindowsBuiltInRole.Administrator)'));
  // The companion's one-click update (--update) leaves the desktop shortcut and the start at sign-in as the user had them.
  assert.ok(setup.includes('case "--update": o.Update = true; break;'));
  assert.ok(setup.includes('Run(dir, o.Update ? (bool?)null : o.Desktop, o.Update ? (bool?)null : o.Startup, (percent, text) => { });'));
  assert.ok(setup.includes('if (desktop == true) Shortcut.Create(Product.DesktopLink, exe);') && setup.includes('else if (desktop == false && Shortcut.PointsInto(Product.DesktopLink, dir)) TryDelete(Product.DesktopLink);'));
  // Paths from the zip or the list never leave the install folder, and the data folder goes only when asked.
  assert.ok(setup.includes('if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException('));
  assert.match(setup, /if \(removeData\)\s*\{[^}]*foreach \(var data in new\[\] \{ Product\.DataDir, Legacy\.DataDir \}\)[^}]*\{[^}]*Directory\.Delete\(data, true\)/, 'the data folder, under the new name or the old one, only when asked');
  assert.deepEqual([...setup.matchAll(/Directory\.Delete\((\w+), true\)/g)].map(m => m[1]).sort(), ['data', 'temp'], 'one place deletes the data folder, the other its own temp folder');
  // An update from an old-named install leaves one entry in Settings > Apps, a desktop shortcut and a startup entry that
  // start the renamed program, and quits the old program by its old names.
  assert.ok(setup.includes('else if (desktop == null && Shortcut.PointsInto(Product.DesktopLink, dir)) Shortcut.Create(Product.DesktopLink, exe);'));
  assert.ok(setup.includes('else if (startup == null && StartupPointsInto(dir, Legacy.RunValue, Legacy.ExeIn(dir))) RunQuiet(exe, "--migrate-startup");'));
  assert.ok(setup.includes('DropLegacyEntry(dir);') && setup.includes('Registry.CurrentUser.DeleteSubKeyTree(Legacy.UninstallKey, false);'));
  assert.ok(setup.includes('foreach (var name in new[] { Product.QuitEvent, Legacy.QuitEvent })') && setup.includes('return Held(Product.Mutex) || Held(Legacy.Mutex);'));
  assert.ok(setup.includes('return From(Product.UninstallKey) ?? From(Legacy.UninstallKey);'));
  // After the companion quits, files are replaced or deleted only once nothing runs from the install folder any more.
  assert.equal(setup.split('Running.Settle(dir, 10000);').length, 3, 'installing and uninstalling both wait');
  for (const at of ['再重新安装。");\n            Running.Settle(dir, 10000);', '再卸载。");\n            Running.Settle(dir, 10000);']) assert.ok(setup.includes(at), at);
  // A folder with other files gets a biubiu AI folder of its own, so the uninstaller's clean-up never meets them.
  assert.ok(setup.includes('if (Directory.Exists(full) && !Holds(full) && !Empty(full)) return Path.Combine(full, Product.Name);'));
  for (const line of setup.split('\n').filter(l => l.includes('SetupLog.Write('))) assert.ok(!/[Kk]ey\b|token|password/.test(line.replace(/"[^"]*"/g, '""')), line.trim());
});
// The release workflow publishes nothing without the version's changes in CHANGELOG.md, so a version bump needs them.
test('CHANGELOG.md has the changes of this version, and the release notes carry them with the installer SHA-256', async () => {
  const changelog = await fs.readFile(CHANGELOG, 'utf8');
  assert.match(changes(changelog, VERSION), /^- /);
  const text = ['# 更新记录', '', '## 1.0.2', '', '- 二', '', '## 1.0.1', '', '- 一', '', '## 1.0.0', '', '- 零', '', '## 0.9', '', ''].join(String.fromCharCode(10));
  assert.equal(changes(text, '1.0.2'), '- 二');
  assert.equal(changes(text, '1.0.2', 'v1.0.0'), ['#### 1.0.2', '', '- 二', '', '#### 1.0.1', '', '- 一'].join(String.fromCharCode(10)), 'versions that never went out come along');
  assert.throws(() => changes(text, '1.0.3'), /no section "## 1.0.3"/);
  assert.throws(() => changes(text, '0.9'), /nothing under "## 0.9"/);
  const sha256 = 'ab'.repeat(32), tick = String.fromCharCode(96);
  const body = notes({ version: VERSION, changelog, setupName: setupName(VERSION), size: 38005248, sha256 });
  for (const part of [`**${tick}${setupName(VERSION)}${tick}**（约 36 MB）`, changes(changelog, VERSION), `「更新到 ${VERSION}…」`, `SHA-256：${tick}${sha256}${tick}`]) assert.ok(body.includes(part), part);
  assert.ok(!body.includes(String.fromCharCode(92) + 'n'), 'no literal backslash-n in the notes');
});
