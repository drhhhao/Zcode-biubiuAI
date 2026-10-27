// Screenshots for docs/tutorial.md, written to docs/images/. The panel shots are the real panel in app mode, served by
// app/server.mjs's own server as the companion serves it, backed by the demo account and demo service (app/demo.mjs) and a
// temporary ZCode configuration, and driven in headless Edge over the DevTools protocol, so nothing reaches the real site,
// the real ZCode configuration or the network. The overview is a schematic: a plain frame for ZCode beside a real panel shot.
// --release photographs the latest GitHub release instead, through the system proxy Edge uses, or through HTTPS_PROXY
// when that is set (for a system proxy that is switched off).
// Usage: node build/companion-dev/docs-shots.mjs [--release]
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAppServer } from '../../app/server.mjs';
import { Harbor } from '../../app/lib/core.mjs';
import { MetadataCatalog } from '../../app/lib/metadata.mjs';
import { Site } from '../../app/lib/site.mjs';
import { DEMO, DEMO_SERVICE, demoBackend } from '../../app/demo.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = path.join(root, 'docs', 'images');
const EDGE = process.env.MODEL_HARBOR_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const REPO = 'https://github.com/drhhhao/Zcode-biubiuAI';
// The web view inside a 420-pixel panel, beside its 6-pixel grip and 12-pixel collapse bar.
const WIDTH = 402, HEIGHT = 900;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

// A DevTools client for one page.
class Page {
  constructor(url) { this.ws = new WebSocket(url); this.next = 0; this.waiting = new Map(); }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = resolve; this.ws.onerror = () => reject(new Error('DevTools connection failed'));
      this.ws.onmessage = e => { const m = JSON.parse(e.data); const w = this.waiting.get(m.id); if (!w) return; this.waiting.delete(m.id); if (m.error) w.reject(new Error(m.error.message)); else w.resolve(m.result); };
    });
  }
  send(method, params = {}) { const id = ++this.next; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject })); }
  async run(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async until(expression, what, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await this.run(expression)) return; await sleep(100); }
    throw new Error(`timed out waiting for ${what}`);
  }
  async view(width, height, scale = 2) { await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false }); }
  async go(url) { await this.send('Page.navigate', { url }); await this.until('document.readyState === "complete"', 'the page to load'); await this.run('document.fonts.ready.then(() => true)'); }
  // A band of the page, as wide as the panel, as a PNG file: from the top of one element (or of the page) to the bottom
  // of another, with some margin.
  async shot(file, { from = null, to, margin = 0, width = WIDTH } = {}) {
    await sleep(350);
    const edge = (selector, side) => `document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().${side} + scrollY`;
    const band = await this.run(`(() => { const top = ${from ? `${edge(from, 'top')} - ${margin}` : '0'}; return { y: Math.max(0, top), bottom: ${edge(to, 'bottom')} + ${margin} }; })()`);
    const clip = { x: 0, y: band.y, width, height: band.bottom - band.y, scale: 1 };
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
    await fs.writeFile(path.join(out, file), Buffer.from(data, 'base64'));
    console.log(`  ${file}`);
  }
}

// In every document: a stand-in for the host's message channel, so the page shows what it shows inside the companion
// (its 收起 button) and hears what the host would tell it, and a few helpers that click and type as a user would.
const PAGE_HELPERS = `
  window.chrome = window.chrome || {};
  window.chrome.webview = { listeners: [], postMessage() {}, addEventListener(type, fn) { if (type === 'message') this.listeners.push(fn); }, removeEventListener() {} };
  window.__docs = {
    hostSays(data) { for (const fn of window.chrome.webview.listeners) fn({ data }); return true; },
    byText(selector, text, within = document) { return [...within.querySelectorAll(selector)].find(e => e.textContent.trim() === text); },
    click(el) { if (!el) throw new Error('nothing to click'); el.scrollIntoView({ block: 'center' }); el.click(); return true; },
    fill(selector, value) { const el = document.querySelector(selector); el.focus(); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; },
    shown(selector) { const el = document.querySelector(selector); return Boolean(el) && !el.hidden && el.getClientRects().length > 0; },
    // Each tick redraws the list, so the next box is looked up again.
    tick(list, count) { let n = 0; for (; n < count; n++) { const box = [...document.querySelectorAll(list + ' input[type=checkbox]')].find(b => !b.checked && !b.disabled); if (!box) break; box.click(); } return n; }
  };`;

// proxy, for the release page only: Edge otherwise goes through the system proxy, and without one GitHub's page may not
// load its assets list.
async function withEdge(work, { proxy = '' } = {}) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'biubiu-docs-edge-'));
  const port = await freePort();
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-component-update', '--mute-audio', ...(proxy ? [`--proxy-server=${proxy}`] : []), 'about:blank'], { stdio: 'ignore' });
  try {
    let target;
    for (let i = 0; i < 100 && !target; i++) {
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch {}
      if (!target) await sleep(150);
    }
    if (!target) throw new Error('Edge did not open its DevTools port');
    const page = new Page(target.webSocketDebuggerUrl);
    await page.open();
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await work(page);
    page.ws.close();
  } finally {
    edge.kill();
    await sleep(500);
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

async function panelShots() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'biubiu-docs-'));
  const configPath = path.join(tmp, 'provider_config.json');
  await fs.writeFile(configPath, JSON.stringify({ schemaVersion: 1, config: { providerOrder: [], providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] } } }));
  const demo = demoBackend(), offline = () => Promise.reject(new Error('the tutorial shots stay offline'));
  const site = new Site({ fetchImpl: (url, options) => demo.isDemo(options) ? demo.siteFetch(url, options) : offline() });
  const harbor = new Harbor({ configPath, site, fetchImpl: (url, options) => demo.serviceFetch(url, options) || offline(), metadataCatalog: new MetadataCatalog({ dataDir: path.join(tmp, 'cache'), zcodeDir: tmp, refresh: false }) });
  const token = crypto.randomBytes(24).toString('hex');
  const { server, state } = createAppServer({ harbor, token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/?k=${token}`;
  try {
    await withEdge(async page => {
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_HELPERS });
      await page.view(WIDTH, HEIGHT);
      await page.go(url);
      await page.until('__docs.shown("#siteLogin")', 'the sign-in form');
      await page.shot('panel-site-login.png', { to: '.ver', margin: 24 });

      // Signed in to the demo account: balance, groups, keys.
      await page.run(`__docs.fill('#siteEmail', ${JSON.stringify(DEMO.email)}) && __docs.fill('#sitePassword', ${JSON.stringify(DEMO.password)}) && __docs.click(document.querySelector('#siteLoginBtn'))`);
      await page.until('__docs.shown("#siteAccount") && document.querySelectorAll("#siteGroups .grow").length > 0 && document.querySelectorAll("#siteKeys .svc").length > 0', 'the account');
      await page.run('scrollTo(0, 0), true');
      await page.shot('panel-site-account.png', { to: '#siteGroupsPart', margin: 16 });
      await page.shot('panel-site-keys.png', { from: ':has(> #siteKeyCount)', to: '.ver', margin: 16 });

      // 添加分组 on a group without a key: the panel asks before making one, then adds every model of the group.
      const row = `[...document.querySelectorAll('#siteGroups .grow')].find(r => r.querySelector('.gname')?.textContent === 'Claude Pro')`;
      await page.run(`__docs.click(${row}.querySelector('.gact button'))`);
      await page.until(`Boolean(${row}?.querySelector('.gask'))`, 'the question under the group');
      await page.shot('panel-group-ask.png', { from: '#siteGroupsPart', to: '#siteGroupsPart', margin: 8 });
      await page.run(`__docs.click(__docs.byText('button', '新建 Key 并添加', ${row}))`);
      // The outcome shows in the group's own row.
      await page.until(`document.querySelector('#siteGroups .goutcome')?.textContent.startsWith('已添加分组')`, 'the group to be added');
      await page.until(`!document.querySelector('#siteGroups button:disabled')`, 'the panel to be ready');
      await page.shot('panel-group-added.png', { from: '#siteGroupsPart', to: '#siteGroupsPart', margin: 8 });

      // A site key's models, opened under it and ticked.
      const key = `[...document.querySelectorAll('#siteKeys .svc')].find(k => k.querySelector('.svcname')?.textContent === 'Codex')`;
      await page.run(`__docs.click(__docs.byText('button', '添加到 ZCode', ${key}))`);
      await page.until(`document.querySelectorAll('#keyPick input[type=checkbox]').length > 0`, 'the key\'s models');
      await page.run(`__docs.tick('#keyPick', 2)`);
      await page.shot('panel-key-models.png', { from: '#siteKeys .svc:has(#keyPick)', to: '#siteKeys .svc:has(#keyPick)', margin: 8 });
      await page.run(`__docs.click(document.querySelector('#keyPickAdd'))`);
      await page.until(`[...document.querySelectorAll('#keyPick .note')].some(n => n.textContent.startsWith('已把') || n.classList.contains('fail'))`, 'the key\'s models to be added');
      await page.until(`![...document.querySelectorAll('#siteKeys button:not(#keyPickAdd)')].some(b => b.disabled)`, 'the panel to be ready');

      // 连接服务: an address and a key, the models found, a few ticked.
      await page.run(`__docs.click(document.querySelector('#connectTab'))`);
      await page.until('__docs.shown("#connectPage")', 'the connect page');
      await page.run(`__docs.fill('#baseUrl', ${JSON.stringify(DEMO_SERVICE.baseUrl)}) && __docs.fill('#apiKey', ${JSON.stringify(DEMO_SERVICE.apiKey)}) && __docs.click(document.querySelector('#fetchBtn'))`);
      await page.until(`document.querySelectorAll('#list input[type=checkbox]').length >= 8`, 'the models');
      await page.run(`__docs.tick('#list', 3)`);
      await page.run('scrollTo(0, 0), true');
      await page.shot('panel-connect.png', { to: '#pickCard', margin: 16 });

      // Added to ZCode: the services list with its keys behind dots, then one opened for 修改.
      await page.run(`__docs.click(document.querySelector('#importBtn'))`);
      await page.until(`document.querySelector('#status')?.textContent.startsWith('已把')`, 'the import');
      await page.until(`document.querySelectorAll('#savedList .svc').length >= 3`, 'the services list');
      await page.shot('panel-saved.png', { from: '#savedCard', to: '#savedCard', margin: 8 });
      const service = `[...document.querySelectorAll('#savedList .svc')].find(s => s.textContent.includes('api.example.com'))`;
      await page.run(`__docs.click(__docs.byText('button', '修改', ${service}))`);
      await page.until(`Boolean(${service}?.querySelector('input'))`, 'the edit fields');
      await page.shot('panel-saved-edit.png', { from: '#savedCard', to: '#savedCard', margin: 8 });

      // The footer once the host has found a newer version (an example number).
      await page.run(`__docs.hostSays({ type: 'update', version: '0.9.0', state: 'available', percent: 0 })`);
      await page.until(`__docs.shown('#updateLink')`, 'the footer\'s update link');
      await page.shot('panel-update.png', { from: '.ver', to: '.ver', margin: 18 });

      // The same account in the dark theme, which follows ZCode's.
      state.theme = 'dark';
      await page.go(url);
      await page.until('__docs.shown("#siteAccount") && document.querySelectorAll("#siteKeys .svc").length > 0', 'the account in the dark theme');
      await page.shot('panel-dark.png', { to: '#siteGroupsPart', margin: 16 });

      // The overview: a plain frame standing for ZCode, beside the real panel (light).
      const panel = (await fs.readFile(path.join(out, 'panel-site-account.png'))).toString('base64');
      await page.view(980, 700, 1.5);
      await page.go('data:text/html;charset=utf-8,' + encodeURIComponent(overviewHtml(panel)));
      await page.shot('overview.png', { from: '#stage', to: '#stage', width: 980 });
    });
  } finally {
    server.close();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// A schematic, not a picture of ZCode: an empty dark frame named ZCode, the panel docked on its right edge.
function overviewHtml(panel) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
    body{margin:0;background:#e9e6e0;font:14px/1.5 'Segoe UI','Microsoft YaHei UI',sans-serif;color:#1c1c1c}
    #stage{padding:28px 28px 20px;width:924px;box-sizing:content-box}
    .row{display:flex;align-items:stretch}
    .zcode{flex:1;height:620px;border-radius:10px 0 0 10px;background:#1f2024;box-shadow:0 10px 30px rgba(0,0,0,.25);display:flex;flex-direction:column;overflow:hidden}
    .title{height:34px;background:#18191c;color:#c9c9c9;display:flex;align-items:center;padding:0 14px;font-size:13px;letter-spacing:.02em}
    .body{flex:1;display:flex}.side{width:150px;background:#1a1b1e;border-right:1px solid #2a2b30}
    .main{flex:1;display:flex;align-items:center;justify-content:center;color:#6f7075;font-size:15px}
    .panel{width:300px;height:620px;border-radius:0 10px 10px 0;overflow:hidden;background:#f9f8f6;box-shadow:0 10px 30px rgba(0,0,0,.25)}
    .panel img{width:300px;display:block}
    .labels{display:flex;margin-top:14px;font-size:13px;color:#5a5a5a}.labels .z{flex:1;text-align:center}.labels .p{width:300px;text-align:center;color:#c2410c}
  </style><div id="stage"><div class="row"><div class="zcode"><div class="title">ZCode</div><div class="body"><div class="side"></div><div class="main">ZCode 窗口</div></div></div><div class="panel"><img src="data:image/png;base64,${panel}" alt=""></div></div><div class="labels"><span class="z">ZCode（示意）</span><span class="p">biubiu AI 面板，贴在 ZCode 右侧</span></div></div>`;
}

async function releaseShot() {
  await withEdge(async page => {
    await page.view(1280, 900, 1.5);
    await page.go(`${REPO}/releases/latest`);
    // GitHub loads the Assets list only once it scrolls into view, and a long release note puts it below the window.
    await page.until(`(document.querySelector('include-fragment[src*="expanded_assets"]')?.scrollIntoView({ block: 'center' }), [...document.querySelectorAll('a')].some(a => /biubiuAI-Setup-.*\\.exe$/.test(a.getAttribute('href') || '')))`, 'the release assets', 60000);
    // From the release's title to its Assets, with the installer's row outlined so the tutorial can point at it.
    await page.run(`(() => {
      const a = [...document.querySelectorAll('a')].find(a => /biubiuAI-Setup-.*\\.exe$/.test(a.getAttribute('href') || ''));
      const row = a.closest('li') || a;
      row.style.outline = '3px solid #ea580c'; row.style.outlineOffset = '2px'; row.style.borderRadius = '6px';
      row.id = 'docsAsset';
      const title = [...document.querySelectorAll('h1, h2')].find(h => /biubiu AI \\d/.test(h.textContent));
      (title || document.querySelector('main') || document.body).id ||= 'docsTitle';
      return true;
    })()`);
    const from = await page.run(`'#' + CSS.escape(([...document.querySelectorAll('h1, h2')].find(h => /biubiu AI \\d/.test(h.textContent)) || document.querySelector('main') || document.body).id)`);
    await page.shot('github-release.png', { from, to: '#docsAsset', margin: 28, width: 1280 });
  }, { proxy: process.env.HTTPS_PROXY || process.env.https_proxy || '' });
}

await fs.mkdir(out, { recursive: true });
if (process.argv.includes('--release')) await releaseShot(); else await panelShots();
