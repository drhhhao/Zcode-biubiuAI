import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Harbor } from './lib/core.mjs';
import { Site, SITE } from './lib/site.mjs';
import { callTool } from './lib/tools.mjs';
import { DEMO, demoBackend } from './demo.mjs';

// A disposable profile: this preview never writes to the real ZCode config.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-harbor-preview-'));
const configPath = path.join(dir, 'provider_config.json');
await fs.writeFile(configPath, JSON.stringify({ schemaVersion: 1, config: { providerOrder: [], providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] } } }));
// The demo account and demo service (app/demo.mjs) answer here, without the network; any other account signs in to the real
// site, and its imports still go to the temporary profile. The site keeps the sign-in in memory only.
const demo = demoBackend();
const site = new Site({ fetchImpl: (url, options) => demo.isDemo(options) ? demo.siteFetch(url, options) : fetch(url, options) });
const harbor = new Harbor({ configPath, refreshCatalog: false, site, fetchImpl: (url, options) => demo.serviceFetch(url, options) || fetch(url, options) });
const token = crypto.randomBytes(24).toString('hex');
const port = Number(process.env.MODEL_HARBOR_PREVIEW_PORT || 17862);
const server = http.createServer(async (req, res) => {
  const origin = `http://127.0.0.1:${port}`;
  if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403).end(); return; }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (req.method === 'GET' && req.url === '/') {
      let html = await fs.readFile(new URL('./lib/panel.html', import.meta.url), 'utf8');
      html = html.replace('<script>', `<script>window.__HARBOR_PREVIEW__=${JSON.stringify(token)};</script><script>`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html); return;
    }
    if (req.method === 'POST' && req.url === '/api/tool') {
      if (req.headers['x-harbor-preview'] !== token || (req.headers.origin && req.headers.origin !== origin)) { res.writeHead(403).end(); return; }
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 512000) { res.writeHead(413).end(); return; } }
      const { name, args } = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(await callTool(harbor, name, args))); return;
    }
    res.writeHead(404).end();
  } catch { res.writeHead(500).end('Preview error'); }
});
server.listen(port, '127.0.0.1', () => console.log(`biubiu AI preview: http://127.0.0.1:${port}\nDemo URL: https://api.example.com/v1\nDemo key: demo-key\nDemo ${SITE.name} account: ${DEMO.email} / ${DEMO.password} (other accounts sign in to ${SITE.origin})\nAll imports go to a temporary test profile.`));
