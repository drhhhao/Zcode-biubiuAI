// Checks the companion's site window (SiteForm) in a real WebView2 against a stand-in site, without the real site or any
// account: compiles SiteWindowCheck.cs against the built ModelHarbor.exe into a temporary folder, serves a stand-in site
// on 127.0.0.1, lets the window open it, and judges what the stand-in's page and server saw:
//   - the page starts with the placeholder sign-in: no access token, the window's marker for the refresh token;
//   - a renewal with the marker is answered by the window: twice with a token (and the marker again), then 401 when
//     signed out, then 503 without an answer; the token works for the stand-in's /api/auth/me;
//   - a renewal with another refresh token reaches the site with its body intact;
//   - the page cannot message the host; links elsewhere go to the "default browser" (printed here) and the page stays;
//   - after the first page, a reload keeps the sign-in the site has (the placeholder is not written again);
//   - the log (in the temporary data folder) has no token or marker.
// Then the pipe to Node (see below), and the tray icon's menu (TrayMenu): drawn in both themes over a backdrop of the
// harness's own, it must stay where it was placed, stack its rows evenly, round its corners (Windows 11), lie on the
// panel's paper without a gray column, wash only the row under the pointer, and show the mark, the chosen side and the
// startup box; both captures are saved as build/companion-dev/tray-menu.png.
// Usage: node build/companion-dev/site-window-check.mjs   (MODEL_HARBOR_EXE picks another build than app/bin)
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const exe = process.env.MODEL_HARBOR_EXE || path.join(root, 'app', 'bin', 'ModelHarbor.exe');
const sdk = path.join(root, 'build', 'webview2-sdk', 'pkg-1.0.4314.35');
let passed = 0, failed = 0;
const check = (name, ok, detail = '') => { if (ok) passed++; else failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`); };

// As app/build.mjs finds it.
function findCsc() {
  if (process.env.MODEL_HARBOR_CSC) return process.env.MODEL_HARBOR_CSC;
  for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean)) {
    const vs = path.join(base, 'Microsoft Visual Studio');
    if (!existsSync(vs)) continue;
    const list = dir => { try { return readdirSync(dir); } catch { return []; } };
    for (const year of list(vs).sort().reverse())
      for (const edition of list(path.join(vs, year))) {
        const csc = path.join(vs, year, edition, 'MSBuild', 'Current', 'Bin', 'Roslyn', 'csc.exe');
        if (existsSync(csc)) return csc;
      }
  }
  throw new Error('Roslyn csc.exe not found; set MODEL_HARBOR_CSC');
}

const page = `<!doctype html><meta charset="utf-8"><title>Stand-in site</title><body>stand-in site
<script>
(async () => {
  const post = (to, body) => fetch(to, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const read = async r => ({ status: r.status, body: await r.json().catch(() => null) });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  if (sessionStorage.getItem('phase') === 'reloaded') { await post('/report', { phase: 'reloaded', session: localStorage.getItem('auth_session'), origin: location.origin }); return; }
  const session = JSON.parse(localStorage.getItem('auth_session') || 'null');
  let posted = 'no channel';
  try { if (window.chrome && window.chrome.webview) { window.chrome.webview.postMessage('open-site'); posted = 'sent'; } } catch (e) { posted = 'refused'; }
  const result = { phase: 'first', session, webview: posted, legacy: [localStorage.getItem('access_token'), localStorage.getItem('refresh_token')] };
  const renew = token => post('/api/auth/refresh', { refreshToken: token }).then(read);
  result.r1 = await renew(session && session.refreshToken);
  result.me = (await fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + (result.r1.body && result.r1.body.accessToken) } })).status;
  result.r2 = await renew(session && session.refreshToken);
  result.r3 = await renew(session && session.refreshToken);
  result.r4 = await renew(session && session.refreshToken);
  result.other = await renew('not-the-marker');
  await post('/report', result);
  window.open('https://example.com/new-window', '_blank');
  await pause(1300);
  location.href = 'https://example.org/away';
  await pause(1300);
  try { window.chrome.webview.postMessage('open-site'); } catch (e) { }
  await post('/report', { phase: 'stayed', origin: location.origin });
  localStorage.setItem('auth_session', JSON.stringify({ ...session, refreshToken: 'changed-by-the-site' }));
  sessionStorage.setItem('phase', 'reloaded');
  location.reload();
})();
</script>`;

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mh-site-check-'));
const reports = [], passedThrough = [], me = [];
let child, out = '';
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (url.pathname === '/login' || url.pathname === '/')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(page); return; }
  if (req.method === 'POST' && url.pathname === '/api/auth/refresh') { passedThrough.push(body); res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ via: 'server' })); return; }
  if (req.method === 'GET' && url.pathname === '/api/auth/me') { me.push(req.headers.authorization || ''); const ok = /^Bearer harness-token-\d$/.test(req.headers.authorization || ''); res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' }).end('{}'); return; }
  if (req.method === 'POST' && url.pathname === '/report') { try { reports.push(JSON.parse(body)); } catch { } res.writeHead(204).end(); return; }
  res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

try {
  // Compile the harness against the built host, beside copies of it and the WebView2 libraries.
  const bin = path.join(tmp, 'bin');
  await fs.mkdir(bin);
  for (const [from, name] of [[exe, 'ModelHarbor.exe'], [path.join(sdk, 'lib', 'net462', 'Microsoft.Web.WebView2.Core.dll')], [path.join(sdk, 'lib', 'net462', 'Microsoft.Web.WebView2.WinForms.dll')], [path.join(sdk, 'runtimes', 'win-x64', 'native', 'WebView2Loader.dll')]])
    await fs.copyFile(from, path.join(bin, name || path.basename(from)));
  const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  // With the host's manifest and settings, so the harness is DPI-aware like the companion and draws at its scale.
  await fs.copyFile(path.join(root, 'app', 'host', 'ModelHarbor.exe.config'), path.join(bin, 'SiteWindowCheck.exe.config'));
  const compiled = spawnSync(findCsc(), ['/nologo', '/target:winexe', '/platform:x64', '/langversion:7.3', '/codepage:65001', `/out:${path.join(bin, 'SiteWindowCheck.exe')}`, `/lib:${framework}`, `/win32manifest:${path.join(root, 'app', 'host', 'app.manifest')}`,
    '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', `/r:${path.join(bin, 'ModelHarbor.exe')}`, `/r:${path.join(bin, 'Microsoft.Web.WebView2.Core.dll')}`, `/r:${path.join(bin, 'Microsoft.Web.WebView2.WinForms.dll')}`,
    path.join(here, 'SiteWindowCheck.cs')], { encoding: 'utf8' });
  check('harness compiles against the built host', compiled.status === 0, compiled.status === 0 ? '' : compiled.stdout + compiled.stderr);
  if (compiled.status !== 0) throw new Error('compile failed');

  // The host's log goes to the temporary data folder, never the real one.
  const data = path.join(tmp, 'data');
  child = spawn(path.join(bin, 'SiteWindowCheck.exe'), [origin, path.join(tmp, 'webview')], { env: { ...process.env, MODEL_HARBOR_DATA_DIR: data }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', b => { out += b; });
  child.stderr.on('data', b => { out += b; });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && !reports.some(r => r.phase === 'reloaded') && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 100));
  child.stdin.write('quit\n');
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); setTimeout(resolve, 5000); } });

  const first = reports.find(r => r.phase === 'first'), stayed = reports.find(r => r.phase === 'stayed'), reloaded = reports.find(r => r.phase === 'reloaded');
  const marker = first?.session?.refreshToken || '';
  check('the window opened the stand-in site', Boolean(first), out.trim().split('\n').slice(-3).join(' | '));
  if (first) {
    check('the page starts with the placeholder sign-in', first.session?.sessionId === 'model-harbor' && first.session?.version === 1 && first.session?.accessToken === null && /^model-harbor-[0-9a-f]{48}$/.test(marker), JSON.stringify({ ...first.session, refreshToken: marker ? '(marker)' : marker }));
    check('older stored tokens are cleared', first.legacy[0] === null && first.legacy[1] === null);
    check('the page cannot message the host', first.webview !== 'sent' || !out.includes('host got a message'), `page ${first.webview}, host ${out.includes('host got a message') ? 'got it' : 'got nothing'}`);
    check('a marked renewal gets a token and the marker again', first.r1.status === 200 && first.r1.body?.accessToken === 'harness-token-1' && first.r1.body?.refreshToken === marker, `status ${first.r1.status}`);
    check('the token works on the site', first.me === 200 && me[0] === 'Bearer harness-token-1');
    check('each marked renewal asks again', first.r2.status === 200 && first.r2.body?.accessToken === 'harness-token-2');
    check('signed out, the renewal is refused with 401', first.r3.status === 401, `status ${first.r3.status}`);
    check('without an answer, the renewal fails with 503', first.r4.status === 503, `status ${first.r4.status}`);
    check('a renewal without the marker reaches the site with its body intact', first.other.status === 401 && first.other.body?.via === 'server' && passedThrough.length === 1 && passedThrough[0] === '{"refreshToken":"not-the-marker"}', JSON.stringify(passedThrough));
  }
  const outside = out.split(/\r?\n/).filter(line => line.startsWith('outside ')).map(line => line.slice(8));
  check('a new window elsewhere goes to the default browser', outside.includes('https://example.com/new-window'), JSON.stringify(outside));
  check('a navigation elsewhere goes to the default browser', outside.includes('https://example.org/away'), JSON.stringify(outside));
  check('the page stays on the site', stayed?.origin === origin, stayed?.origin);
  check('a reload keeps the sign-in the site has', Boolean(reloaded) && JSON.parse(reloaded.session || 'null')?.refreshToken === 'changed-by-the-site', reloaded ? reloaded.session.replace(marker, '(marker)') : 'no reload report');
  check('the window asked four times', (out.match(/^asked /gm) || []).length === 4, (out.match(/^asked .*/gm) || []).join(', '));
  let log = '';
  try { log = await fs.readFile(path.join(data, 'companion.log'), 'utf8'); } catch { }
  check('the log says a sign-in was handed over', log.includes('site window: sign-in handed over'));
  check('the log has no token or marker', Boolean(log) && !log.includes('harness-token') && !(marker && log.includes(marker)));

  // The real pipe: how the host reads Node's answers, then the real app/server.mjs over its stdin, signed out in a
  // temporary data folder (no saved sign-in, a temporary config), so nothing reaches any site.
  const piped = spawnSync(path.join(bin, 'SiteWindowCheck.exe'), ['--pipe'], { encoding: 'utf8', timeout: 60000, env: { ...process.env, MODEL_HARBOR_DATA_DIR: path.join(tmp, 'pipe-data'), MODEL_HARBOR_APP_SERVER: path.join(root, 'app', 'server.mjs'), MODEL_HARBOR_CONFIG_PATH: path.join(tmp, 'provider_config.json'), MODEL_HARBOR_REFRESH_CATALOG: '0' } });
  const said = Object.fromEntries((piped.stdout || '').split(/\r?\n/).filter(Boolean).map(line => { const [kind, name, ...rest] = line.split(' '); return [`${kind} ${name}`, rest.join(' ')]; }));
  check('the host reads a token answer', said['parse token'] === '3 token (same)', said['parse token']);
  check('the host reads a signed-out answer', said['parse signed-out'] === '4 signed-out', said['parse signed-out']);
  check('an error, a missing or a broken token is no answer', said['parse error'] === '5 failed' && said['parse no-token'] === '6 failed' && said['parse bad-token'] === '7 failed');
  check('other lines are not answers', said['parse ready-line'] === 'none' && said['parse junk'] === 'none');
  check('before Node is ready, asking fails at once', said['ask before-start'] === 'failed', said['ask before-start']);
  check('the real server answers over the pipe (signed out here)', said['ask site-token'] === 'signed-out', said['ask site-token'] || said['ask server-failed'] || said['ask not-ready'] || (piped.stdout || '') + (piped.stderr || ''));
  check('an unknown question gets no answer', said['ask unknown'] === 'failed', said['ask unknown']);
  check('two questions at once get one answer each', said['ask together'] === 'signed-out signed-out', said['ask together']);
  check('after the server stops, asking fails at once', said['ask after-stop'] === 'failed', said['ask after-stop']);

  // The tray icon's menu, light and dark.
  const shot = path.join(here, 'tray-menu.png');
  const menu = spawnSync(path.join(bin, 'SiteWindowCheck.exe'), ['--menu', shot], { encoding: 'utf8', timeout: 60000, env: { ...process.env, MODEL_HARBOR_DATA_DIR: path.join(tmp, 'menu-data') } });
  const seen = Object.fromEntries((menu.stdout || '').split(/\r?\n/).filter(line => line.startsWith('menu ')).map(line => { const [, theme, name, ...rest] = line.split(' '); return [`${theme} ${name}`, rest.join(' ')]; }));
  check('the tray menu opened in both themes', menu.status === 0 && Object.keys(seen).length === 18, menu.status === 0 ? `${Object.keys(seen).length} results` : (menu.stdout || '') + (menu.stderr || '') + (menu.error ? menu.error.message : ''));
  for (const theme of ['light', 'dark']) {
    const saw = (...names) => names.map(name => seen[`${theme} ${name}`]);
    const ok = (...names) => saw(...names).every(result => result === 'ok');
    check(`${theme} tray menu: stays where the tray placed it`, ok('placed'), saw('placed').join());
    check(`${theme} tray menu: rows stacked evenly`, ok('rows'), saw('rows').join());
    check(`${theme} tray menu: rounded corners`, ok('rounded'), saw('rounded').join());
    check(`${theme} tray menu: on the panel's paper, no gray column`, ok('paper', 'no-column'), saw('paper', 'no-column').join(' / '));
    check(`${theme} tray menu: only the row under the pointer is washed`, ok('wash'), saw('wash').join());
    check(`${theme} tray menu: the title row shows the mark`, ok('mark'), saw('mark').join());
    check(`${theme} tray menu: the chosen side and the startup box`, ok('option', 'check-box'), saw('option', 'check-box').join(' / '));
  }
  check('the tray menu capture was saved', existsSync(shot), shot);
} catch (error) {
  failed++; console.log(`FAIL  unexpected error: ${error.message}`);
} finally {
  if (child && child.exitCode === null) child.kill();
  server.close();
  // WebView2's own processes outlive the harness by a few seconds and hold the profile folder until they end.
  let removed = false;
  for (let i = 0; i < 40 && !removed; i++) {
    try { await fs.rm(tmp, { recursive: true, force: true }); removed = !existsSync(tmp); } catch { }
    if (!removed) await new Promise(resolve => setTimeout(resolve, 500));
  }
  console.log(removed ? 'temporary folder removed' : `could not remove the temporary folder yet: ${tmp}`);
  console.log(`SUMMARY passed=${passed} failed=${failed}`);
  process.exitCode = failed ? 1 : 0;
}
