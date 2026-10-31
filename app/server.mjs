// biubiu AI desktop companion server.
// Serves lib/panel.html and its tools to the WebView2 host over 127.0.0.1 only.
// Every API call needs the per-launch token the host passes in BIUBIU_AI_APP_TOKEN.
// API keys never appear in logs, and reach a response only through reveal_key: tool results come
// from lib/tools.mjs callTool, which returns a saved key or a site key only for that explicit request
// from the panel's eye button, and this server logs no request or response bodies.
// The site sign-in (lib/site.mjs) is saved encrypted in BIUBIU_AI_SESSION_DIR with the key the host
// passes in BIUBIU_AI_SESSION_KEY; without both it stays in memory until the server exits.
// The host asks for an access token for its site window over stdin and reads the answer on stdout (answerHost):
// that pipe belongs to the host alone, so the token never reaches the panel, a port or a log.
import http from 'node:http';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { BiubiuAI } from './lib/core.mjs';
import { Site } from './lib/site.mjs';
import { callTool, TOOL_NAMES, VERSION } from './lib/tools.mjs';

export const MAX_BODY = 512000;
export const APP_TOOLS = new Set(TOOL_NAMES);
const PANEL = new URL('./lib/panel.html', import.meta.url);
const THEMES = new Set(['light', 'dark']);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=()'
};

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a, 'utf8'), y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function contentSecurityPolicy(nonce) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ');
}

// Adds the launch token and a per-response nonce to lib/panel.html.
export function renderPanel(html, { token, nonce }) {
  if (!html.includes('<script>') || !html.includes('<style>')) throw new Error('panel.html is missing its inline script or style');
  const boot = `<script nonce="${nonce}">window.__BIUBIU_APP__=Object.freeze(${JSON.stringify({ token, version: VERSION })});</script>`;
  return html
    .replaceAll('<style>', `<style nonce="${nonce}">`)
    .replaceAll('<script>', `<script nonce="${nonce}">`)
    .replace(`<script nonce="${nonce}">`, `${boot}<script nonce="${nonce}">`);
}

function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function allow(req, res, methods) {
  if (methods.includes(req.method)) return;
  res.setHeader('Allow', methods.join(', '));
  throw new HttpError(405, 'Method not allowed');
}

// Reads the whole body before answering so the client always receives the status,
// including 413, instead of a reset connection.
async function readJson(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY * 8) { req.destroy(); throw new HttpError(413, 'Request too large'); }
  const chunks = [];
  let size = 0, overflow = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY * 8) { req.destroy(); throw new HttpError(413, 'Request too large'); }
    if (size > MAX_BODY) overflow = true; else chunks.push(chunk);
  }
  if (type !== 'application/json') throw new HttpError(415, 'Expected application/json');
  if (overflow) throw new HttpError(413, 'Request too large');
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Invalid JSON');
  return value;
}

export function createAppServer({ biubiu, token, log = () => {} }) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw new Error('A launch token of 32-256 URL-safe characters is required');
  const state = { mode: 'app', version: VERSION, theme: 'light', zcode: false };
  let inflight = 0;

  async function handle(req, res) {
    const { port } = server.address();
    const origin = `http://127.0.0.1:${port}`;
    for (const [name, value] of Object.entries(BASE_HEADERS)) res.setHeader(name, value);
    // Exact Host match blocks DNS rebinding and any other name for this socket.
    if (req.headers.host !== `127.0.0.1:${port}`) throw new HttpError(403, 'Forbidden');
    const url = new URL(req.url, origin);

    if (url.pathname === '/healthz') {
      allow(req, res, ['GET']);
      return send(res, 200, { ok: true, name: 'biubiu-ai-app', version: VERSION });
    }

    if (url.pathname === '/') {
      allow(req, res, ['GET']);
      if (!sameSecret(url.searchParams.get('k'), token)) throw new HttpError(403, 'Forbidden');
      const nonce = crypto.randomBytes(18).toString('base64');
      const html = renderPanel(await fs.readFile(PANEL, 'utf8'), { token, nonce });
      res.setHeader('Content-Security-Policy', contentSecurityPolicy(nonce));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (url.pathname === '/api/host' || url.pathname === '/api/tool') {
      if (req.headers.origin !== undefined && req.headers.origin !== origin) throw new HttpError(403, 'Forbidden');
      const site = req.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Forbidden');
      if (!sameSecret(req.headers['x-biubiu-app'], token)) throw new HttpError(403, 'Forbidden');

      if (url.pathname === '/api/host') {
        allow(req, res, ['GET', 'POST']);
        if (req.method === 'POST') {
          const body = await readJson(req);
          if (body.theme !== undefined && !THEMES.has(body.theme)) throw new HttpError(400, 'Invalid theme');
          if (body.zcode !== undefined && typeof body.zcode !== 'boolean') throw new HttpError(400, 'Invalid zcode flag');
          if (body.theme !== undefined) state.theme = body.theme;
          if (body.zcode !== undefined) state.zcode = body.zcode;
        }
        return send(res, 200, state);
      }

      allow(req, res, ['POST']);
      const body = await readJson(req);
      if (typeof body.name !== 'string' || !APP_TOOLS.has(body.name)) throw new HttpError(400, 'Unknown tool');
      if (body.args !== undefined && (body.args === null || typeof body.args !== 'object' || Array.isArray(body.args))) throw new HttpError(400, 'Invalid arguments');
      inflight++;
      try { return send(res, 200, await callTool(biubiu, body.name, body.args || {})); }
      finally { inflight--; }
    }

    throw new HttpError(404, 'Not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      const known = error instanceof HttpError;
      if (!known) log(`request failed: ${error?.message || 'unknown error'}`);
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      send(res, known ? error.status : 500, { error: known ? error.message : 'Internal error' });
    });
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  return { server, state, get inflight() { return inflight; } };
}

// One request from the desktop host, a JSON line on stdin: { id, op }. The only op is 'site-token', an access token for
// the site window the host opens (Site.handoff); the answer is a JSON line for stdout with the same id: signedIn, and
// the token in base64 when signed in, or an error. The refresh token never leaves lib/site.mjs. Anything that is not a
// request is ignored.
export async function answerHost(line, site) {
  let request;
  try { request = JSON.parse(line); } catch { return null; }
  if (!request || typeof request !== 'object' || !Number.isSafeInteger(request.id) || request.id < 1) return null;
  const reply = { event: 'host-reply', id: request.id };
  if (request.op !== 'site-token') return { ...reply, error: 'unknown' };
  try {
    const r = await site.handoff();
    return r.signedIn ? { ...reply, signedIn: true, token: Buffer.from(r.accessToken, 'utf8').toString('base64') } : { ...reply, signedIn: false };
  } catch { return { ...reply, error: 'failed' }; }
}

export async function main({ env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const fromHost = Boolean(env.BIUBIU_AI_APP_TOKEN);
  const token = env.BIUBIU_AI_APP_TOKEN || crypto.randomBytes(32).toString('hex');
  if (!TOKEN_PATTERN.test(token)) throw new Error('BIUBIU_AI_APP_TOKEN must be 32-256 URL-safe characters');
  const requestedPort = Number(env.BIUBIU_AI_APP_PORT || 0);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('BIUBIU_AI_APP_PORT must be an integer between 0 and 65535');

  const site = new Site({ dataDir: env.BIUBIU_AI_SESSION_DIR || '', sessionKey: env.BIUBIU_AI_SESSION_KEY || '' });
  delete env.BIUBIU_AI_SESSION_KEY;
  const biubiu = new BiubiuAI({ refreshCatalog: env.BIUBIU_AI_REFRESH_CATALOG !== '0', site });
  const app = createAppServer({ biubiu, token, log: message => stderr.write(`[biubiu-ai-app] ${message}\n`) });
  const { server } = app;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(requestedPort, '127.0.0.1', resolve); });
  const port = server.address().port;
  stdout.write(JSON.stringify({ event: 'ready', port, version: VERSION }) + '\n');
  if (!fromHost) stderr.write(`biubiu AI companion server (development): http://127.0.0.1:${port}/?k=${token}\nThis page edits the real ZCode configuration, with automatic backup.\n`);

  let closing = false;
  // Lets an import, change or delete that is writing the config finish, so its lock and backup stay consistent.
  const shutdown = async code => {
    if (closing) return;
    closing = true;
    server.close();
    server.closeIdleConnections();
    const deadline = Date.now() + 10000;
    while (app.inflight > 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    server.closeAllConnections();
    process.exit(code);
  };

  const hostPid = Number(env.BIUBIU_AI_HOST_PID);
  if (Number.isInteger(hostPid) && hostPid > 0) {
    readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
      if (line.length > 4096) return;
      answerHost(line, site).then(reply => { if (reply && !closing) stdout.write(JSON.stringify(reply) + '\n'); });
    });
    process.stdin.on('end', () => shutdown(0));
    process.stdin.on('error', () => shutdown(0));
    process.stdin.resume();
    setInterval(() => {
      try { process.kill(hostPid, 0); } catch (error) { if (error.code === 'ESRCH') shutdown(0); }
    }, 2000).unref();
  }
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  return { server, port, token };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => { process.stderr.write(`[biubiu-ai-app] failed to start: ${error?.message || error}\n`); process.exit(1); });
}
