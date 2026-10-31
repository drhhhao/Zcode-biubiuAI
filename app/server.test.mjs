import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { VERSION } from './lib/tools.mjs';
import { APP_TOOLS, answerHost, renderPanel, sameSecret } from './server.mjs';
import { SITE } from './lib/site.mjs';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(appDir);
const seed = () => ({ schemaVersion: 1, config: { providerOrder: ['mine'], providerConfigRules: { providerRules: [{ providerId: 'mine', providerName: '现有供应商', config: { group: 'standard-personal', access: { type: 'api-key', apiKey: 'stored-secret' }, api: { type: 'anthropic-messages', baseUrl: 'https://provider.test' }, personalModelIds: ['old-model'], modelOrder: ['old-model'] } }] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] } } });

const exited = child => new Promise(resolve => { if (child.exitCode !== null) resolve(child.exitCode); else child.once('exit', code => resolve(code)); });

async function startServer(t, { sessionKey } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'biubiu-ai-app-test-'));
  const configPath = path.join(dir, 'provider_config.json');
  await fs.writeFile(configPath, JSON.stringify(seed()));
  const token = crypto.randomBytes(32).toString('hex');
  const env = { ...process.env, BIUBIU_AI_CONFIG_PATH: configPath, BIUBIU_AI_APP_TOKEN: token, BIUBIU_AI_HOST_PID: String(process.pid), BIUBIU_AI_REFRESH_CATALOG: '0' };
  delete env.NODE_OPTIONS; delete env.BIUBIU_AI_SESSION_KEY; delete env.BIUBIU_AI_SESSION_DIR;
  if (sessionKey) Object.assign(env, { BIUBIU_AI_SESSION_KEY: sessionKey, BIUBIU_AI_SESSION_DIR: dir });
  const child = spawn(process.execPath, [path.join(appDir, 'server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'], env });
  let out = '', err = '';
  child.stderr.on('data', b => { err += b; });
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited(child); await fs.rm(dir, { recursive: true, force: true }); });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server not ready: ${err}`)), 8000);
    child.stdout.on('data', b => {
      out += b;
      if (!out.includes('\n')) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(out.split('\n')[0])); } catch (e) { reject(e); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${err}`)); });
  });
  return { child, token, port: ready.port, ready, output: () => out, errors: () => err, configPath, dir };
}

function request(port, { method = 'GET', path: target = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: { Host: `127.0.0.1:${port}`, ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const api = (s, target, { method = 'POST', body, headers = {} } = {}) => request(s.port, { method, path: target, body, headers: { 'Content-Type': 'application/json', 'X-Biubiu-App': s.token, Origin: `http://127.0.0.1:${s.port}`, ...headers } });

test('ready line reports a loopback port and the health check needs no secrets', async t => {
  const s = await startServer(t);
  assert.equal(s.ready.event, 'ready'); assert.equal(s.ready.version, VERSION); assert.ok(s.port > 0);
  const health = await request(s.port, { path: '/healthz' });
  assert.equal(health.status, 200); assert.deepEqual(JSON.parse(health.text), { ok: true, name: 'biubiu-ai-app', version: VERSION });
  assert.ok(!s.output().includes(s.token)); assert.ok(!s.errors().includes(s.token)); assert.ok(!health.text.includes(s.token));
});

test('panel page requires the launch key and ships a nonce-only CSP', async t => {
  const s = await startServer(t);
  assert.equal((await request(s.port)).status, 403);
  assert.equal((await request(s.port, { path: '/?k=wrong' })).status, 403);
  const page = await request(s.port, { path: `/?k=${s.token}` });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.equal(page.headers['x-frame-options'], 'DENY'); assert.equal(page.headers['cache-control'], 'no-store');
  const csp = page.headers['content-security-policy'];
  assert.ok(!csp.includes('unsafe-inline')); assert.match(csp, /default-src 'none'/); assert.match(csp, /connect-src 'self'/);
  const nonce = csp.match(/script-src 'nonce-([^']+)'/)[1];
  assert.match(csp, new RegExp(`style-src 'nonce-${nonce.replace(/[+/=]/g, m => `\\${m}`)}'`));
  const tags = [...page.text.matchAll(/<(script|style)\b[^>]*>/g)].map(m => m[0]);
  assert.equal(tags.filter(tag => tag.startsWith('<script')).length, 2);
  for (const tag of tags) assert.ok(tag.includes(`nonce="${nonce}"`), tag);
  assert.match(page.text, /window\.__BIUBIU_APP__=Object\.freeze/);
  assert.ok(page.text.includes(`v${VERSION}`));
});

test('requests with a foreign Host header are refused', async t => {
  const s = await startServer(t);
  for (const host of [`localhost:${s.port}`, 'evil.test', `127.0.0.1:${s.port + 1}`]) assert.equal((await request(s.port, { path: '/healthz', headers: { Host: host } })).status, 403, host);
});

test('tool API enforces token, origin, fetch site, content type and payload rules', async t => {
  const s = await startServer(t);
  const list = JSON.stringify({ name: 'list_providers', args: {} });
  assert.equal((await api(s, '/api/tool', { body: list, headers: { 'X-Biubiu-App': '' } })).status, 403);
  assert.equal((await api(s, '/api/tool', { body: list, headers: { 'X-Biubiu-App': 'x'.repeat(64) } })).status, 403);
  assert.equal((await api(s, '/api/tool', { body: list, headers: { Origin: 'http://evil.test' } })).status, 403);
  assert.equal((await api(s, '/api/tool', { body: list, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await api(s, '/api/tool', { body: list, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await api(s, '/api/tool', { body: '{not json' })).status, 400);
  assert.equal((await api(s, '/api/tool', { body: JSON.stringify({ name: 'open_biubiu_ai' }) })).status, 400);
  assert.equal((await api(s, '/api/tool', { body: JSON.stringify({ name: 'nope' }) })).status, 400);
  assert.equal((await api(s, '/api/tool', { body: JSON.stringify({ name: 'list_providers', args: [] }) })).status, 400);
  assert.equal((await api(s, '/api/tool', { method: 'GET' })).status, 405);
  assert.equal((await api(s, '/api/tool', { body: JSON.stringify({ name: 'list_providers', pad: 'x'.repeat(600000) }) })).status, 413);
  const ok = await api(s, '/api/tool', { body: list });
  assert.equal(ok.status, 200);
  const data = JSON.parse(ok.text);
  assert.equal(data.structuredContent.providers[0].name, '现有供应商');
  assert.ok(!ok.text.includes('stored-secret'));
  assert.equal(await fs.readFile(s.configPath, 'utf8'), JSON.stringify(seed()));
});

test('reveal_key answers only the tokened panel, is never cached and never logged', async t => {
  const s = await startServer(t);
  const reveal = JSON.stringify({ name: 'reveal_key', args: { providerId: 'mine' } });
  for (const headers of [{ 'X-Biubiu-App': '' }, { Origin: 'http://evil.test' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const denied = await api(s, '/api/tool', { body: reveal, headers });
    assert.equal(denied.status, 403, JSON.stringify(headers)); assert.ok(!denied.text.includes('stored-secret'));
  }
  const ok = await api(s, '/api/tool', { body: reveal });
  assert.equal(ok.status, 200); assert.equal(ok.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(ok.text).structuredContent, { id: 'mine', apiKey: 'stored-secret' });
  const missing = await api(s, '/api/tool', { body: JSON.stringify({ name: 'reveal_key', args: { providerId: 'gone' } }) });
  assert.equal(missing.status, 200); assert.equal(JSON.parse(missing.text).isError, true); assert.ok(!missing.text.includes('stored-secret'));
  assert.ok(!s.output().includes('stored-secret')); assert.ok(!s.errors().includes('stored-secret'));
  assert.equal(await fs.readFile(s.configPath, 'utf8'), JSON.stringify(seed()));
});

test('update_provider and delete_provider change the config for the tokened panel without echoing or logging a key', async t => {
  const s = await startServer(t);
  const update = JSON.stringify({ name: 'update_provider', args: { providerId: 'mine', baseUrl: 'https://moved.test/v1', apiKey: 'rotated-secret' } });
  assert.equal((await api(s, '/api/tool', { body: update, headers: { 'X-Biubiu-App': '' } })).status, 403);
  assert.equal(await fs.readFile(s.configPath, 'utf8'), JSON.stringify(seed()));
  const updated = await api(s, '/api/tool', { body: update });
  assert.equal(updated.status, 200); assert.equal(updated.headers['cache-control'], 'no-store'); assert.ok(!updated.text.includes('secret'));
  assert.deepEqual([JSON.parse(updated.text).structuredContent.urlChanged, JSON.parse(updated.text).structuredContent.keyChanged], [true, true]);
  const saved = JSON.parse(await fs.readFile(s.configPath, 'utf8')).config.providerConfigRules.providerRules[0].config;
  assert.deepEqual([saved.api.baseUrl, saved.access.apiKey], ['https://moved.test/v1', 'rotated-secret']);
  const removed = await api(s, '/api/tool', { body: JSON.stringify({ name: 'delete_provider', args: { providerId: 'mine' } }) });
  assert.equal(removed.status, 200); assert.equal(JSON.parse(removed.text).isError, undefined);
  assert.deepEqual(JSON.parse(await fs.readFile(s.configPath, 'utf8')).config.providerConfigRules.providerRules, []);
  assert.ok(!s.output().includes('secret')); assert.ok(!s.errors().includes('secret'));
});

test('the site account answers only the tokened panel, starts signed out, and never shows the session key or a password', async t => {
  const sessionKey = crypto.randomBytes(32).toString('base64');
  const s = await startServer(t, { sessionKey });
  const account = JSON.stringify({ name: 'site_account', args: {} });
  assert.equal((await api(s, '/api/tool', { body: account, headers: { 'X-Biubiu-App': '' } })).status, 403);
  const ok = await api(s, '/api/tool', { body: account });
  assert.equal(ok.status, 200); assert.equal(ok.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(ok.text).structuredContent, { signedIn: false, site: { origin: 'https://ro.biubiu007.com', host: 'ro.biubiu007.com', name: 'biubiu AI' } });
  const login = await api(s, '/api/tool', { body: JSON.stringify({ name: 'site_login', args: { email: 'not-an-email', password: 'pw-secret' } }) });
  assert.equal(JSON.parse(login.text).isError, true, 'refused before any request to the site');
  const reveal = await api(s, '/api/tool', { body: JSON.stringify({ name: 'reveal_key', args: { siteKeyId: '1' } }) });
  assert.equal(JSON.parse(reveal.text).isError, true);
  const out = await api(s, '/api/tool', { body: JSON.stringify({ name: 'site_logout', args: {} }) });
  assert.equal(JSON.parse(out.text).structuredContent.signedIn, false);
  for (const text of [s.output(), s.errors(), ok.text, login.text, reveal.text, out.text]) { assert.ok(!text.includes(sessionKey)); assert.ok(!text.includes('pw-secret')); }
  assert.deepEqual((await fs.readdir(s.dir)).filter(name => name.startsWith('site-session')), [], 'nothing is saved while signed out');
  assert.equal(await fs.readFile(s.configPath, 'utf8'), JSON.stringify(seed()));
});

test('host state round-trips theme and rejects invalid values', async t => {
  const s = await startServer(t);
  assert.equal((await request(s.port, { path: '/api/host' })).status, 403);
  const initial = JSON.parse((await api(s, '/api/host', { method: 'GET' })).text);
  assert.deepEqual(initial, { mode: 'app', version: VERSION, theme: 'light', zcode: false });
  const updated = await api(s, '/api/host', { body: JSON.stringify({ theme: 'dark', zcode: true }) });
  assert.equal(updated.status, 200); assert.equal(JSON.parse(updated.text).theme, 'dark');
  assert.equal((await api(s, '/api/host', { body: JSON.stringify({ theme: 'blue' }) })).status, 400);
  assert.equal((await api(s, '/api/host', { body: JSON.stringify({ zcode: 'yes' }) })).status, 400);
  assert.deepEqual(JSON.parse((await api(s, '/api/host', { method: 'GET' })).text), { mode: 'app', version: VERSION, theme: 'dark', zcode: true });
});

test('server exits when the host closes its stdin', async t => {
  const s = await startServer(t);
  s.child.stdin.end();
  const code = await Promise.race([exited(s.child), new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))]);
  assert.equal(code, 0);
});

test('helpers compare secrets in constant time and refuse a panel without inline assets', async () => {
  assert.equal(sameSecret('abc', 'abc'), true); assert.equal(sameSecret('abc', 'abd'), false); assert.equal(sameSecret(undefined, 'abc'), false); assert.equal(sameSecret('ab', 'abc'), false);
  assert.throws(() => renderPanel('<html></html>', { token: 't'.repeat(32), nonce: 'n' }));
  assert.deepEqual([...APP_TOOLS].sort(), ['delete_provider', 'fetch_models', 'get_models', 'import_models', 'list_providers', 'reveal_key', 'site_account', 'site_add_group', 'site_delete_key', 'site_login', 'site_logout', 'site_remove_group', 'test_model', 'update_provider']);
});

test('panel supports the companion bridge and the preview, and no longer the ZCode plugin host', async () => {
  const html = await fs.readFile(path.join(appDir, 'lib', 'panel.html'), 'utf8');
  for (const marker of ['window.__BIUBIU_APP__', "'X-Biubiu-App'", 'window.__BIUBIU_PREVIEW__', "postMessage('hide')"]) assert.ok(html.includes(marker), marker);
  assert.ok(!html.includes('window.zcode'));
  await assert.rejects(fs.stat(path.join(root, 'plugins')));
  assert.match(html, /id="appHide"[^>]*hidden/);
});

test('desktop host sources carry the shared version and per-monitor DPI awareness', async () => {
  const cs = await fs.readFile(path.join(appDir, 'host', 'BiubiuAI.cs'), 'utf8');
  assert.ok(cs.includes(`public const string Version = "${VERSION}";`));
  assert.ok(cs.includes(`AssemblyInformationalVersion("${VERSION}")`));
  assert.ok(cs.includes(`AssemblyVersion("${VERSION}.0")`));
  const manifest = await fs.readFile(path.join(appDir, 'host', 'app.manifest'), 'utf8');
  assert.ok(manifest.includes(`version="${VERSION}.0"`));
  assert.match(manifest, /PerMonitorV2/);
  assert.ok(!/BIUBIU_AI_APP_TOKEN[^;\n]*Log\.Write/.test(cs), 'token must never be logged');
});

test('the desktop host keeps the site session key DPAPI-protected for the current user and never logs it', async () => {
  const cs = await fs.readFile(path.join(appDir, 'host', 'BiubiuAI.cs'), 'utf8');
  const start = cs.indexOf('static class SessionKey'), keyClass = cs.slice(start, cs.indexOf('\n    }\n', start));
  assert.ok(start > 0, 'the host has a SessionKey class');
  assert.match(keyClass, /ProtectedData\.Protect\([^;]*DataProtectionScope\.CurrentUser\)/);
  assert.match(keyClass, /ProtectedData\.Unprotect\([^;]*DataProtectionScope\.CurrentUser\)/);
  for (const line of cs.split('\n').filter(l => l.includes('Log.Write('))) assert.ok(!/\bkey\b|sessionKey|SESSION_KEY/.test(line.replace(/"[^"]*"/g, '""')), line.trim());
  assert.match(cs, /psi\.EnvironmentVariables\["BIUBIU_AI_SESSION_KEY"\] = sessionKey;/);
  assert.match(cs, /psi\.EnvironmentVariables\["BIUBIU_AI_SESSION_DIR"\] = Paths\.DataDir;/);
  assert.match(await fs.readFile(path.join(appDir, 'server.mjs'), 'utf8'), /delete env\.BIUBIU_AI_SESSION_KEY;/, 'Node drops the key from its environment once read');
  assert.ok((await fs.readFile(path.join(appDir, 'build.mjs'), 'utf8')).includes('/r:System.Security.dll'));
});

test('the desktop host tells the page when the panel hides or shows, and when the page is ready, so revealed keys are masked again and the balance is read only while shown', async () => {
  const cs = await fs.readFile(path.join(appDir, 'host', 'BiubiuAI.cs'), 'utf8');
  const html = await fs.readFile(path.join(appDir, 'lib', 'panel.html'), 'utf8');
  // WinForms leaves the web view "visible" while the form is hidden, so visibilitychange alone never fires in the host.
  const panel = cs.slice(cs.indexOf('sealed class PanelForm : Form'), cs.indexOf('sealed class TabForm : Form'));
  const hook = panel.indexOf('protected override void OnVisibleChanged(EventArgs e)'), post = panel.indexOf('void PostPanel()');
  assert.ok(hook > 0, 'the panel form reports its own visibility');
  assert.match(panel.slice(hook, panel.indexOf('\n        }\n', hook)), /base\.OnVisibleChanged\(e\);\s*PostPanel\(\);$/);
  assert.ok(post > 0 && panel.slice(post, post + 400).includes('PostWebMessageAsJson("{\\"type\\":\\"panel\\",\\"visible\\":" + (Visible ? "true" : "false") + "}")'));
  // The page may load in a hidden panel, or in one shown before it listened: it says ready once it listens.
  assert.ok(panel.includes('else if (message == "ready") { PostPanel(); SendUpdate(); SendTour(); }'));
  assert.ok(html.includes("webview.postMessage('ready');"));
  assert.ok(html.includes("else if (e.data?.type === 'panel') panelShown(e.data.visible === true);"));
  assert.ok(html.includes("document.addEventListener('visibilitychange', () => panelShown(!document.hidden));"));
});

test('the desktop host keeps Node and the hidden panel small in memory', async () => {
  const cs = await fs.readFile(path.join(appDir, 'host', 'BiubiuAI.cs'), 'utf8');
  // Node: a capped young generation, and two libuv pool threads whatever the launching shell sets.
  const flags = cs.match(/const string NodeFlags = "([^"]+)";/);
  assert.ok(flags, 'the host names the flags it starts Node with');
  assert.equal(flags[1], '--max-semi-space-size=2');
  assert.ok(cs.includes('var psi = new ProcessStartInfo(node, NodeFlags + " \\"" + script + "\\"")'));
  assert.ok(cs.includes('const string PoolThreads = "2";') && cs.includes('psi.EnvironmentVariables["UV_THREADPOOL_SIZE"] = PoolThreads;'));
  const accepted = spawn(process.execPath, [...flags[1].split(' '), '-e', '0'], { stdio: 'ignore' });
  assert.equal(await exited(accepted), 0, 'this Node accepts the flags');
  // The panel's web view: memory target Low while the panel is hidden and Normal while it shows, set whenever the page
  // is told, so a page that loads in a hidden panel is covered too.
  const panel = cs.slice(cs.indexOf('sealed class PanelForm : Form'), cs.indexOf('sealed class TabForm : Form'));
  const post = panel.indexOf('void PostPanel()');
  assert.ok(panel.slice(post, panel.indexOf('\n        }\n', post)).includes('SetMemoryTarget();'));
  assert.ok(panel.includes('web.CoreWebView2.MemoryUsageTargetLevel = Visible ? CoreWebView2MemoryUsageTargetLevel.Normal : CoreWebView2MemoryUsageTargetLevel.Low;'));
});

test('the page waits for a WebView2 message channel that appears after its script starts', async () => {
  const html = await fs.readFile(path.join(appDir, 'lib', 'panel.html'), 'utf8');
  // Reading window.chrome.webview once at start-up lost the host's theme and panel messages in about a quarter of loads.
  assert.equal(html.split('window.chrome?.webview').length, 2, 'the page reads the channel in one place only');
  assert.ok(html.includes('const webview = await hostChannel();'));
  const source = html.match(/^ {2}function hostChannel\(.*$/m);
  assert.ok(source, 'the page has a hostChannel helper');
  const window = { chrome: {} }, channel = { postMessage() {} };
  const hostChannel = vm.runInNewContext(`(${source[0].trim()})`, { window, setTimeout });
  setTimeout(() => { window.chrome.webview = channel; }, 40);
  assert.equal(await hostChannel(), channel, 'a channel that arrives late is still found');
  delete window.chrome.webview;
  assert.equal(await hostChannel(2), undefined, 'without a host the page stops looking');
});

test('the host asks for the site window\'s access token on stdin, and only its own pipe carries the answer', async t => {
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.sig';
  const site = { handoff: async () => ({ signedIn: true, accessToken: token }) };
  assert.deepEqual(await answerHost('{"id":7,"op":"site-token"}', site), { event: 'host-reply', id: 7, signedIn: true, token: Buffer.from(token).toString('base64') });
  assert.deepEqual(await answerHost('{"id":8,"op":"site-token"}', { handoff: async () => ({ signedIn: false }) }), { event: 'host-reply', id: 8, signedIn: false });
  assert.deepEqual(await answerHost('{"id":9,"op":"site-token"}', { handoff: async () => { throw new Error('renewal failed'); } }), { event: 'host-reply', id: 9, error: 'failed' });
  assert.deepEqual(await answerHost('{"id":10,"op":"reveal_key"}', site), { event: 'host-reply', id: 10, error: 'unknown' }, 'one question only');
  for (const line of ['', 'not json', '[]', 'null', '{"op":"site-token"}', '{"id":0,"op":"site-token"}', '{"id":"1","op":"site-token"}', '{"id":1.5,"op":"site-token"}']) assert.equal(await answerHost(line, site), null, line);

  // Through a real server, as the host asks: one line in on stdin (with Windows line ends), one line out on stdout.
  const s = await startServer(t);
  const replies = () => s.output().split('\n').slice(1).filter(Boolean).map(line => JSON.parse(line));
  const wait = async n => { for (let i = 0; i < 100 && replies().length < n; i++) await new Promise(resolve => setTimeout(resolve, 30)); return replies(); };
  s.child.stdin.write('{"id":1,"op":"site-token"}\r\nnot a request\r\n{"id":2,"op":"site-token"}\r\n');
  assert.deepEqual(await wait(2), [{ event: 'host-reply', id: 1, signedIn: false }, { event: 'host-reply', id: 2, signedIn: false }], 'signed out, and nothing for the line that is not a request');
  // The tool API has no way to the token.
  const asked = await api(s, '/api/tool', { body: JSON.stringify({ name: 'site_token', args: {} }) });
  assert.equal(asked.status, 400);
  assert.ok(!s.errors().includes('host-reply'));
});

test('the site window shows only the site, InPrivate, and answers only its own renewals, with a token Node hands over', async () => {
  const cs = await fs.readFile(path.join(appDir, 'host', 'BiubiuAI.cs'), 'utf8');
  const html = await fs.readFile(path.join(appDir, 'lib', 'panel.html'), 'utf8');
  const form = cs.slice(cs.indexOf('sealed class SiteForm : Form'), cs.indexOf('sealed class Companion : ApplicationContext'));
  assert.ok(form.includes(`public const string SiteOrigin = "${SITE.origin}";`), 'the host opens the site Node signs in to');
  for (const line of ['options.IsInPrivateModeEnabled = true;', 'settings.IsWebMessageEnabled = false;', 'settings.AreHostObjectsAllowed = false;', 'settings.IsPasswordAutosaveEnabled = false;'])
    assert.ok(form.includes(line), line);
  // The site starts with no access token and the marker for its refresh token; only a renewal with the marker is answered.
  assert.ok(form.includes("accessToken: null, refreshToken: \" + Json.Quote(marker) + \""));
  assert.ok(form.includes('core.AddWebResourceRequestedFilter(origin + refreshPath, CoreWebView2WebResourceContext.All);'));
  assert.ok(form.includes('if (!fromSite || !CarriesMarker(body)) { request.Content = new MemoryStream(body); return; }'), 'any other request goes on with its body');
  assert.ok(form.includes('json = "{\\"accessToken\\":" + Json.Quote(reply.Token) + ",\\"refreshToken\\":" + Json.Quote(marker) + "}";'), 'the answer carries the marker, never a refresh token');
  assert.ok(form.includes('if (IsSite(e.Uri) || e.Uri == "about:blank") return;\n            e.Cancel = true;'), 'other addresses leave the window');
  for (const line of form.split('\n').filter(l => l.includes('Log.Write('))) assert.ok(!/Token|marker|[Uu]ri\b|json/.test(line.replace(/"[^"]*"/g, '""')), line.trim());
  // The token travels on Node's stdin and stdout only, which the host alone holds.
  assert.ok(cs.includes('launch.Process.StandardInput.WriteLine("{\\"id\\":"'));
  assert.ok(cs.includes('if (launch.Ready != 0) { Answer(line); continue; }'));
  assert.ok(cs.includes('new SiteForm(SiteForm.SiteOrigin, () => server.Ask("site-token"), SiteForm.OpenInBrowser,'));
  // The page asks the host to open it from the link under the balance, and to close it on signing out.
  assert.ok(cs.includes('else if (message == "open-site")') && cs.includes('else if (message == "site-signed-out")'));
  assert.ok(html.includes("openSite = () => tellHost('open-site');") && html.includes("tellHost?.('site-signed-out');"));
});

test('the panel and its collapsed tab have the rounded corners of ZCode\'s own window', async () => {
  const cs = await fs.readFile(path.join(appDir, 'host', 'BiubiuAI.cs'), 'utf8');
  const panel = cs.slice(cs.indexOf('sealed class PanelForm : Form'), cs.indexOf('sealed class TabForm : Form'));
  const tab = cs.slice(cs.indexOf('sealed class TabForm : Form'), cs.indexOf('sealed class TrayMenu : ContextMenuStrip'));
  assert.ok(panel.includes('Native.TrySetCorner(Handle, Native.DWMWCP_ROUND);'));
  assert.ok(tab.includes('rounded = Native.TrySetCorner(Handle, Native.DWMWCP_ROUND);'));
  assert.ok(tab.includes('if (!rounded) using (var pen = new Pen(Frame, 1f)) g.DrawRectangle('), 'the tab paints a square frame only where Windows draws no rounded border');
  assert.ok(!cs.includes('DONOTROUND'));
});

test('the tray icon\'s menu is drawn like the panel: its theme, rounded corners, the mark on top, the panel\'s own marks', async () => {
  const cs = await fs.readFile(path.join(appDir, 'host', 'BiubiuAI.cs'), 'utf8');
  const menu = cs.slice(cs.indexOf('sealed class TrayMenu : ContextMenuStrip'), cs.indexOf('static class Shapes'));
  const companion = cs.slice(cs.indexOf('sealed class Companion : ApplicationContext'), cs.indexOf('static class Native'));
  assert.ok(menu.length > 0 && companion.length > 0);
  // The companion's menu, in the panel's theme; nowhere a menu in WinForms' default look.
  assert.ok(companion.includes('readonly TrayMenu menu = new TrayMenu();'));
  assert.ok(!cs.includes('new ContextMenuStrip('));
  assert.ok(companion.includes('menu.ApplyTheme(theme == "dark");'));
  // Windows 11 rounds it and draws its border and shadow; no square classic shadow.
  assert.ok(menu.includes('DropShadowEnabled = false;'));
  assert.ok(menu.includes('rounded = Native.TrySetCorner(Handle, Native.DWMWCP_ROUND);'));
  assert.ok(menu.includes('Native.TrySetBorderColor(Handle, Palette.Line(dark));'));
  // Its own renderer paints every part WinForms would, in the panel's palette.
  assert.ok(menu.includes('Renderer = new TrayMenuRenderer(this);'));
  for (const part of ['OnRenderToolStripBackground', 'OnRenderToolStripBorder', 'OnRenderImageMargin', 'OnRenderMenuItemBackground', 'OnRenderItemText', 'OnRenderItemCheck', 'OnRenderItemImage', 'OnRenderSeparator'])
    assert.ok(menu.includes(`protected override void ${part}(`), part);
  for (const color of ['Palette.Paper(menu.Dark)', 'Palette.Hover(menu.Dark)', 'Palette.Ink(menu.Dark)', 'Palette.Muted(menu.Dark)', 'Palette.Line(menu.Dark)'])
    assert.ok(menu.includes(color), color);
  // The title row shows the mark, the name and the version, and is no command.
  assert.ok(menu.includes('Logo.Draw(g, new RectangleF('));
  assert.ok(menu.includes('Text = "biubiu AI", ShortcutKeyDisplayString = "v" + Program.Version') && menu.includes('Enabled = false'));
  assert.ok(menu.includes('public override bool CanSelect { get { return false; } }'));
  // The rows: the side to dock on is one of two, the startup entry a check box, the hotkey written when it is ours.
  for (const row of ['menu.Add("展开面板"', 'menu.Add("重新加载面板"', 'menu.Add("优先贴在 ZCode 右侧", () => SetDock(false), TrayMenu.Mark.Option)', 'menu.Add("优先贴在 ZCode 左侧", () => SetDock(true), TrayMenu.Mark.Option)',
    'menu.Add("登录 Windows 时在后台待命", () => ToggleStartup(), TrayMenu.Mark.Check)', 'menu.Add("打开日志文件夹"', 'menu.Add("检查更新", () => OnUpdateItem())', 'menu.Add("退出 biubiu AI"'])
    assert.ok(companion.includes(row), row);
  assert.ok(companion.includes('toggleItem.ShortcutKeyDisplayString = hotKeyRegistered ? "Ctrl+Alt+M" : null;'));
  // It lays out its own rows, and has its size before the tray places it.
  assert.ok(menu.includes('SetItemLocation(item, new Point(0, y));'));
  assert.ok(/public ToolStripMenuItem Add\([^)]*\)\s*\{[\s\S]*?Items\.Add\(item\);\s*Arrange\(\);\s*return item;/.test(menu));
});

test('updates come from GitHub Releases: an installed copy tells of a newer version once, updates only when the user says yes, downloads from the Gitee mirror first and runs only an installer whose SHA-256 is GitHub\'s', async () => {
  const cs = await fs.readFile(path.join(appDir, 'host', 'BiubiuAI.cs'), 'utf8');
  const html = await fs.readFile(path.join(appDir, 'lib', 'panel.html'), 'utf8');
  const updates = cs.slice(cs.indexOf('static class Updates'), cs.indexOf('// The site in a window of its own'));
  const companion = cs.slice(cs.indexOf('sealed class Companion : ApplicationContext'), cs.indexOf('static class Native'));
  const body = (text, signature) => { const at = text.indexOf(signature); assert.ok(at > 0, signature); return text.slice(at, text.indexOf('\n        }\n', at)); };
  assert.ok(updates.length > 0 && companion.length > 0);
  // The latest release of the public repository (GitHub leaves out drafts and prereleases), read through the system proxy.
  assert.ok(updates.includes('public const string Repository = "https://github.com/drhhhao/Zcode-biubiuAI";'));
  assert.ok(updates.includes('const string LatestRelease = "https://api.github.com/repos/drhhhao/Zcode-biubiuAI/releases/latest";'));
  assert.ok(!/\.Proxy\s*=/.test(updates), 'the system proxy stays');
  // The installer of that version, only from the repository's release downloads (or a stand-in on 127.0.0.1 in tests),
  // and only with the SHA-256 GitHub records for it.
  assert.ok(updates.includes('public static string InstallerName(string version) { return "biubiuAI-Setup-" + version + ".exe"; }'));
  assert.ok(updates.includes('bool fromRepository = url != null && url.StartsWith(Repository + "/releases/download/", StringComparison.Ordinal);'));
  assert.ok(updates.includes('bool fromStandIn = StandIn && url != null && url.StartsWith("http://127.0.0.1:", StringComparison.Ordinal);'));
  assert.ok(updates.includes('if (digest != null && Regex.IsMatch(digest, "^sha256:[0-9a-fA-F]{64}$")) release.Sha256 = digest.Substring(7).ToLowerInvariant();'));
  assert.ok(updates.includes('public bool Checkable { get { return Installer != null && Sha256 != null; } }') || cs.includes('public bool Checkable { get { return Installer != null && Sha256 != null; } }'));
  assert.ok(body(updates, 'public static string Mismatch(').includes('using (var sha = SHA256.Create())'));
  // Only a copy the installer put in place looks, and "off" turns it off.
  assert.ok(updates.includes('public static bool Enabled { get { return !Off && File.Exists(Path.Combine(InstallDir, "uninstall.list")); } }'));
  assert.ok(companion.includes('if (Updates.Enabled) updateTimer.Start();') && companion.includes('updateItem.Available = Updates.Enabled;'));
  // Told once per version: the balloon only for a version not told before, remembered first.
  const check = body(companion, 'async void CheckForUpdate(bool asked)');
  const told = check.indexOf('else if (update != null && update.Version != settings.UpdateSeen)');
  assert.ok(told > 0 && check.indexOf('Remember(update);', told) < check.indexOf('tray.ShowBalloonTip(', told));
  assert.equal(companion.split('tray.ShowBalloonTip(').length, 3, 'Notify and the one update balloon');
  assert.ok(body(companion, 'void Notify(string message)').includes('balloonOffersUpdate = false;'), 'only the update balloon starts an update when clicked');
  // Nothing is downloaded before the user says yes; the installer runs only after its size and SHA-256 match.
  const confirm = body(companion, 'void ConfirmUpdate()');
  assert.ok(confirm.indexOf('MessageBox.Show(') > 0 && confirm.indexOf('if (answer != DialogResult.Yes)') > confirm.indexOf('MessageBox.Show(') && confirm.indexOf('RunUpdate(release);') > confirm.indexOf('if (answer != DialogResult.Yes)'));
  assert.equal(cs.split('RunUpdate(').length, 3, 'RunUpdate is called from ConfirmUpdate only');
  const run = body(companion, 'async void RunUpdate(Release release)');
  const mismatch = run.indexOf('Updates.Mismatch(file, release)'), refused = run.indexOf('if (problem != null)'), started = run.indexOf('Updates.Run(file)');
  assert.ok(mismatch > 0 && refused > mismatch && started > refused, 'download, check, then run');
  // The same installer from the Gitee mirror first (tagged and named as on GitHub), GitHub's own when it is missing or
  // differs; either one only with GitHub's size and SHA-256.
  assert.ok(updates.includes('public const string MirrorRepository = "https://gitee.com/drhhhao_0/Zcode-biubiuAI";'));
  assert.ok(updates.includes('if (!StandIn) return MirrorRepository + "/releases/download/v" + version + "/" + name;'));
  const mirror = run.indexOf('sources.Add(new KeyValuePair<string, string>("Gitee", release.Mirror));'), github = run.indexOf('sources.Add(new KeyValuePair<string, string>("GitHub", release.Installer));');
  assert.ok(mirror > 0 && github > mirror && run.indexOf('foreach (var from in sources)') > github && mismatch > github, 'Gitee, then GitHub, each checked');
  assert.ok(run.includes('if (mismatch == null) { source = from.Key; break; }'));
  assert.ok(body(updates, 'public static Process Run(string file)').includes('"--silent --update --launch --dir \\""'), 'silently into this installation, keeping the user\'s shortcuts and start at sign-in');
  // The log never gets an address.
  for (const line of (updates + companion).split('\n').filter(l => l.includes('Log.Write('))) assert.ok(!/Installer|Page|url|Override|Request/.test(line.replace(/"[^"]*"/g, '""')), line.trim());
  // --check-update asks a running companion to look now.
  assert.ok(cs.includes('case "--check-update": o.CheckUpdate = true; break;') && cs.includes('else if (index == 5) Post(() => CheckForUpdate(true));'));

  // The page: the footer link appears only for a newer version the host tells of, shows its progress, and passes clicks on.
  assert.ok(html.includes("else if (e.data?.type === 'update') showUpdate(e.data);"));
  assert.ok(cs.includes('else if (message == "update") { var handler = UpdateRequested; if (handler != null) handler(this, EventArgs.Empty); }'));
  const at = html.indexOf('  function showUpdate(');
  const els = {};
  const $ = id => els[id] ||= { id, hidden: true, disabled: false, textContent: '' };
  const ctx = { $ };
  vm.runInNewContext(html.slice(at, html.indexOf('\n  }\n', at) + 4), ctx);
  ctx.showUpdate({ type: 'update', version: null, state: 'available', percent: 0 });
  assert.equal(els.updateLink.hidden, true);
  ctx.showUpdate({ type: 'update', version: '0.9.0', state: 'available', percent: 0 });
  assert.deepEqual([els.updateLink.hidden, els.updateLink.disabled, els.updateLink.textContent], [false, false, '新版本 0.9.0 · 更新']);
  ctx.showUpdate({ type: 'update', version: '0.9.0', state: 'downloading', percent: 45 });
  assert.deepEqual([els.updateLink.disabled, els.updateLink.textContent], [true, '正在下载 0.9.0（45%）']);
  ctx.showUpdate({ type: 'update', version: '0.9.0', state: 'installing', percent: 100 });
  assert.deepEqual([els.updateLink.disabled, els.updateLink.textContent], [true, '正在安装 0.9.0…']);
  ctx.showUpdate({ type: 'update', version: null, state: 'available', percent: 0 });
  assert.equal(els.updateLink.hidden, true);
});

test('使用教程 starts by itself once for a new install, from the tray at any time, and never in the window checks', async () => {
  const cs = await fs.readFile(path.join(appDir, 'host', 'BiubiuAI.cs'), 'utf8');
  // No settings file yet is a new install; tour=pending keeps it until the page says the guide was seen.
  assert.ok(cs.includes('if (!File.Exists(Paths.SettingsFile)) { s.TourPending = true; return s; }'));
  assert.ok(cs.includes('s.TourPending = value == "pending";') && cs.includes('TourPending ? "tour=pending'));
  assert.ok(cs.includes('else if (message == "tour-done") { tourWanted = false;'));
  assert.ok(cs.includes('panel.TourSeen += (s, e) => { if (settings.TourPending) { settings.TourPending = false; settings.Save(); } };'));
  assert.match(cs, /if \(settings\.TourPending && !string\.Equals\(\(Environment\.GetEnvironmentVariable\("BIUBIU_AI_TOUR"\) \?\? ""\)\.Trim\(\), "off", StringComparison\.OrdinalIgnoreCase\)\) panel\.StartTour\(\);/);
  assert.ok(cs.includes('tourItem = menu.Add("使用教程", () => ShowTour());'));
  // The window checks start with empty data folders, which a new install's guide would cover.
  for (const script of ['smoke-host.ps1', 'installer-check.ps1', 'docs-installer.ps1']) {
    const text = await fs.readFile(path.join(appDir, '..', 'build', 'companion-dev', script), 'utf8');
    assert.ok(text.includes("$env:BIUBIU_AI_TOUR = 'off'"), script);
  }
});

test('an installed copy updated from an old-named version carries its data folder over, setting aside one a development build left', async () => {
  const cs = await fs.readFile(path.join(appDir, 'host', 'BiubiuAI.cs'), 'utf8');
  const at = cs.indexOf('static string ResolveDataDir()'), resolve = cs.slice(at, cs.indexOf('\n        }\n', at));
  // A stand-in data folder (tests) comes first, so nothing is carried over there; nor in a development build.
  assert.ok(resolve.indexOf('BIUBIU_AI_DATA_DIR') < resolve.indexOf('Legacy.InstalledCopy'));
  assert.ok(resolve.includes('if (!Legacy.InstalledCopy || !Directory.Exists(Legacy.DataDir)) return dir;'));
  // Only a new folder without a sign-in, beside an old one with it, is set aside, under a new name and never deleted.
  assert.ok(resolve.includes('if (Directory.Exists(dir) && !File.Exists(Path.Combine(dir, SessionFile)) && File.Exists(Path.Combine(Legacy.DataDir, SessionFile)))'));
  assert.ok(resolve.includes('if (!Move(dir, aside)) return dir;') && !/Directory\.Delete/.test(resolve));
  assert.ok(resolve.includes('if (!Move(Legacy.DataDir, dir)) return Legacy.DataDir;'), 'a folder that cannot move yet is used where it is');
  assert.match(cs, /catch \(IOException\) when \(attempt < 150\) \{ Thread\.Sleep\(100\); \}/, 'tried for up to 15 seconds');
  // The installer's --migrate-startup run is usually first to look for the folder, so it moves it: every way in logs that.
  for (const option of ['InstallStartup', 'UninstallStartup', 'MigrateStartup']) assert.match(cs, new RegExp(`if \\(options\\.${option}\\) \\{ NoteDataFolder\\(\\); `), option);
  assert.ok(cs.includes('NoteDataFolder();\n                if (Legacy.InstalledCopy) Startup.Migrate();'));
});
