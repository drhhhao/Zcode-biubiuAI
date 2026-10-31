import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { BiubiuAI } from './core.mjs';
import { Site, SITE, SESSION_FILE } from './site.mjs';
import { callTool } from './tools.mjs';
import { MetadataCatalog } from './metadata.mjs';

const ORIGIN = 'https://ro.biubiu007.com';
const jwt = exp => `e30.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.sig`;
const siteKey = (id, platform, extra = {}) => ({ id, name: `Key ${id}`, key: `sk-site-${id}-${'x'.repeat(16)}`, status: 'active', groupName: `${platform} 组`, groupPlatform: platform, quota: 0, quotaUsed: 0, ...extra });
const someKeys = () => [siteKey(1, 'anthropic'), siteKey(2, 'openai'), siteKey(3, 'gemini'), siteKey(4, 'anthropic', { status: 'inactive' }), siteKey(5, 'anthropic')];
// The account's groups, naming the keys in them; the last has no upstream id and takes no keys.
const someGroups = () => [
  { upstreamGroupId: 71, name: 'Claude 组', platform: 'anthropic', effectiveMultiplier: 1, remark: 'Claude 官方', keyIds: [1, 4, 5] },
  { upstreamGroupId: 72, name: 'GPT 组', platform: 'openai', effectiveMultiplier: '0.8', keyIds: [2] },
  { upstreamGroupId: 73, name: 'Gemini 组', platform: 'gemini', effectiveMultiplier: 0.5, keyIds: [3] },
  { upstreamGroupId: 74, name: 'Grok 组', platform: 'grok', effectiveMultiplier: 0.9, keyIds: [] },
  { upstreamGroupId: null, name: '未接入上游', platform: 'anthropic', keyIds: [] },
];

// A stand-in for the sub2api-hub API: rotating refresh tokens, JWT access tokens, the main platform 5 with account 9.
// A key may carry the site's own id (localId) beside id; its groups name it, and its key page deletes it, by that one.
function hub({ keys = someKeys(), groups = someGroups(), neverSynced = false } = {}) {
  const state = { calls: [], access: new Set(), refresh: new Set(), n: 0, refreshes: 0, synced: !neverSynced, keys, groups, nextKey: 100, loginTtl: 3600, failRefresh: 0, failDelete: 0, login: null };
  const issue = ttl => { state.n++; const accessToken = jwt(Math.floor(Date.now() / 1000) + ttl) + state.n, refreshToken = `refresh-${state.n}`; state.access.add(accessToken); state.refresh.add(refreshToken); return { accessToken, refreshToken }; };
  const fail = (status, message) => Response.json({ code: status, message, data: null }, { status });
  state.fetchImpl = async (url, options = {}) => {
    const u = new URL(url), body = options.body ? JSON.parse(options.body) : null, auth = options.headers?.Authorization || '';
    state.calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), method: options.method || 'GET', body, auth });
    assert.equal(u.origin, ORIGIN); assert.equal(options.redirect, 'error');
    if (u.pathname === '/api/auth/login') {
      if (state.login) return state.login(body);
      return body.email === 'user@example.com' && body.password === 'right-pass' ? Response.json({ ...issue(state.loginTtl), user: { email: 'user@example.com' } }) : fail(401, '邮箱或密码错误');
    }
    if (u.pathname === '/api/auth/refresh') {
      state.refreshes++;
      if (state.failRefresh) return fail(state.failRefresh, 'refresh refused');
      return state.refresh.delete(body.refreshToken) ? Response.json(issue(3600)) : fail(401, 'invalid refresh token');
    }
    if (!state.access.has(auth.replace(/^Bearer /, ''))) return fail(401, 'unauthorized');
    if (u.pathname === '/api/client/platforms') return Response.json([{ id: 3, name: 'other', isMain: false }, { id: 5, name: 'main', isMain: true }]);
    if (u.pathname === '/api/client/platforms/5/accounts') return Response.json([{ id: 9, email: 'upstream@example.com' }, { id: 10, email: 'second@example.com' }]);
    if (u.pathname === '/api/client/platforms/5/balance-summary' && u.searchParams.get('accountId') === '9') return Response.json({ email: 'upstream@example.com', balance: '42.5', totalRecharged: 100 });
    if (u.pathname === '/api/client/platforms/5/api-keys/sync' && options.method === 'POST') { state.synced = true; return Response.json({ addedCount: state.keys.length, removedCount: 0 }); }
    if (u.pathname === '/api/client/platforms/5/api-keys' && u.searchParams.get('customerAccountId') === '9') {
      const page = Number(u.searchParams.get('page')), size = Number(u.searchParams.get('pageSize')), all = state.synced ? state.keys : [];
      return Response.json({ items: all.slice((page - 1) * size, page * size), total: all.length, syncMeta: { neverSynced: !state.synced, ok: true } });
    }
    if (u.pathname === '/api/client/platforms/5/groups' && u.searchParams.get('customerAccountId') === '9') {
      const keysOf = ids => state.synced ? ids.map(id => state.keys.find(k => k.id === id)).filter(Boolean).map(k => ({ id: k.localId ?? k.id, name: k.name, key: k.key })) : [];
      return Response.json({ items: state.groups.map(({ keyIds, ...g }) => ({ ...g, apiKeys: keysOf(keyIds) })), apiKeySync: { neverSynced: !state.synced } });
    }
    const gone = /^\/api\/client\/platforms\/5\/api-keys\/(\w+)$/.exec(u.pathname);
    if (gone && options.method === 'DELETE' && u.searchParams.get('customerAccountId') === '9') {
      if (state.failDelete) return fail(state.failDelete, '上游删除失败');
      const key = state.keys.find(k => String(k.localId ?? k.id) === gone[1]);
      if (!key) return fail(404, '密钥不存在');
      state.keys = state.keys.filter(k => k !== key);
      for (const g of state.groups) g.keyIds = g.keyIds.filter(id => id !== key.id);
      return new Response(null, { status: 204 });
    }
    const made = /^\/api\/client\/platforms\/5\/groups\/(\w+)\/keys$/.exec(u.pathname);
    if (made && options.method === 'POST' && u.searchParams.get('customerAccountId') === '9') {
      const group = state.groups.find(g => String(g.upstreamGroupId) === made[1]);
      if (!group) return fail(404, '分组不存在');
      const key = siteKey(state.nextKey++, group.platform, { name: body.name, groupName: group.name });
      state.keys.push(key); group.keyIds.push(key.id);
      return Response.json({ id: key.id, name: key.name, key: key.key, status: 'active' });
    }
    return fail(404, 'not found');
  };
  return state;
}

async function setup(t, { site, keys, neverSynced, persist = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'biubiu-ai-site-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'provider_config.json');
  await fs.writeFile(configPath, JSON.stringify({ schemaVersion: 1, config: { providerOrder: [], providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] } } }));
  const state = hub({ keys, neverSynced }), sessionKey = crypto.randomBytes(32).toString('base64');
  const gateway = [];
  site ||= new Site({ fetchImpl: state.fetchImpl, ...(persist ? { dataDir: dir, sessionKey } : {}) });
  const biubiu = new BiubiuAI({ configPath, site, metadataCatalog: new MetadataCatalog({ dataDir: path.join(dir, 'cache'), refresh: false }), fetchImpl: async (url, options) => {
    gateway.push({ url, method: options.method || 'GET', headers: options.headers });
    return options.method === 'POST' ? Response.json({ content: [{ type: 'text', text: 'OK' }] }) : Response.json({ data: [{ id: 'model-a' }, { id: 'model-b' }] });
  } });
  return { dir, configPath, state, site, biubiu, gateway, sessionKey, config: async () => JSON.parse(await fs.readFile(configPath, 'utf8')) };
}
const login = biubiu => callTool(biubiu, 'site_login', { email: ' user@example.com ', password: 'right-pass' });
const secretsIn = (text, state) => ['sk-site-', 'right-pass', 'refresh-', ...state.access].filter(s => text.includes(s));

test('signing in reads the balance and keys of the main platform\'s first account, and returns no key, token or password', async t => {
  const { biubiu, state } = await setup(t);
  const r = await login(biubiu);
  assert.equal(r.isError, undefined, r.content[0].text);
  const data = r.structuredContent;
  assert.equal(data.signedIn, true); assert.equal(data.email, 'user@example.com'); assert.deepEqual(data.site, { origin: ORIGIN, host: 'ro.biubiu007.com', name: SITE.name });
  assert.equal(data.balance, 42.5); assert.equal(data.totalRecharged, 100); assert.equal(data.error, undefined);
  assert.deepEqual(data.keys.map(k => [k.id, k.protocol, k.baseUrl, k.hasKey, Boolean(k.blocked)]), [
    ['1', 'anthropic-messages', ORIGIN, true, false], ['2', 'openai-responses', `${ORIGIN}/v1`, true, false], ['3', 'openai-chat-completions', `${ORIGIN}/v1`, true, true],
    ['4', 'anthropic-messages', ORIGIN, true, true], ['5', 'anthropic-messages', ORIGIN, true, false]]);
  assert.match(data.keys[2].blocked, /Gemini/); assert.match(data.keys[3].blocked, /停用/); assert.equal(data.keys[3].statusLabel, '停用');
  assert.deepEqual(secretsIn(JSON.stringify(r), state), []);
  assert.deepEqual(state.calls[0].body, { email: 'user@example.com', password: 'right-pass' }, 'the email is trimmed and sent once with the password');
  assert.ok(state.calls.slice(1).every(c => c.path.startsWith('/api/client/platforms') && c.auth.startsWith('Bearer ')));
  assert.deepEqual(state.calls.find(c => c.path.endsWith('/api-keys')).query, { customerAccountId: '9', page: '1', pageSize: '20', keyScope: 'active' });
  assert.match(r.content[0].text, /5 个 Key/);
});

test('before signing in, the account reads as signed out without contacting the site', async t => {
  const { biubiu, state } = await setup(t);
  const r = await callTool(biubiu, 'site_account');
  assert.deepEqual(r.structuredContent, { signedIn: false, site: { origin: ORIGIN, host: 'ro.biubiu007.com', name: SITE.name } });
  assert.equal(state.calls.length, 0);
  const none = await callTool(new BiubiuAI({ configPath: path.join(os.tmpdir(), 'missing.json'), refreshCatalog: false }), 'site_account');
  assert.equal(none.isError, true); assert.equal(none.content[0].text, '站内账户不可用。');
});

test('login problems are explained without echoing the password, and empty fields send nothing', async t => {
  const { biubiu, state } = await setup(t);
  const wrong = await callTool(biubiu, 'site_login', { email: 'user@example.com', password: 'wrong-pass' });
  assert.equal(wrong.isError, true); assert.equal(wrong.content[0].text, '邮箱或密码错误'); assert.ok(!JSON.stringify(wrong).includes('wrong-pass'));
  state.login = () => Response.json({ code: 429, message: 'too many' }, { status: 429 });
  assert.equal((await login(biubiu)).content[0].text, '登录尝试太频繁，请稍后再试。');
  state.login = () => Response.json({ code: 500, message: 'x'.repeat(500) }, { status: 500 });
  assert.equal((await login(biubiu)).content[0].text.length, 120);
  state.login = () => Response.json({ accessToken: 'only-one-token' });
  assert.match((await login(biubiu)).content[0].text, /无法识别/);
  const calls = state.calls.length;
  for (const args of [{ email: '', password: 'p' }, { email: 'no-at-sign', password: 'p' }, { email: 'user@example.com', password: '' }, { email: 'user@example.com' }]) {
    const r = await callTool(biubiu, 'site_login', args); assert.equal(r.isError, true);
  }
  assert.equal(state.calls.length, calls);
  const offline = new BiubiuAI({ configPath: path.join(os.tmpdir(), 'missing.json'), refreshCatalog: false, site: new Site({ fetchImpl: async () => { throw new TypeError('fetch failed'); } }) });
  assert.equal((await login(offline)).content[0].text, `连接 ${SITE.name} 失败或超时，请检查网络后重试。`);
  assert.equal((await callTool(biubiu, 'site_account')).structuredContent.signedIn, false, 'no failed attempt signs in');
});

test('a refused access token is renewed once for requests made together, and the rotated refresh token is kept', async t => {
  const { biubiu, site, state } = await setup(t);
  await login(biubiu);
  state.access.clear();
  const before = state.refreshes;
  await Promise.all([site.api('/client/platforms'), site.api('/client/platforms'), site.api('/client/platforms')]);
  assert.equal(state.refreshes - before, 1, 'every refresh token works once, so renewals must not run in parallel');
  state.access.clear();
  await site.api('/client/platforms');
  assert.equal(state.refreshes - before, 2, 'the second renewal used the rotated refresh token');
  assert.equal((await callTool(biubiu, 'site_account')).structuredContent.signedIn, true);
});

test('an access token about to expire is renewed before it is used', async t => {
  const { biubiu, state } = await setup(t);
  state.loginTtl = 10;
  const r = await login(biubiu);
  assert.equal(r.structuredContent.signedIn, true);
  assert.deepEqual(state.calls.slice(0, 3).map(c => c.path), ['/api/auth/login', '/api/auth/refresh', '/api/client/platforms']);
  assert.ok(!state.calls.some(c => c.path.startsWith('/api/client') && c.auth === `Bearer ${[...state.access][0]}`), 'the expiring token was not sent');
});

test('a refused renewal signs out and deletes the saved sign-in; a temporary failure keeps it', async t => {
  const { biubiu, site, state, dir } = await setup(t, { persist: true });
  const file = path.join(dir, SESSION_FILE);
  await login(biubiu);
  await fs.access(file);
  state.access.clear(); state.failRefresh = 502;
  let r = (await callTool(biubiu, 'site_account')).structuredContent;
  assert.equal(r.signedIn, true); assert.match(r.error, /续期暂时失败/);
  await fs.access(file);
  state.failRefresh = 401;
  r = (await callTool(biubiu, 'site_account')).structuredContent;
  assert.equal(r.signedIn, false); assert.equal(r.expired, true);
  await assert.rejects(fs.access(file));
  assert.throws(() => site.key('1'), /没有找到这个站内 Key/);
});

test('a key list never synced from upstream is synced once, then read across pages', async t => {
  const many = Array.from({ length: 45 }, (_, i) => siteKey(i + 1, 'openai'));
  const { biubiu, state } = await setup(t, { keys: many, neverSynced: true });
  const r = (await login(biubiu)).structuredContent;
  assert.equal(r.keys.length, 45);
  const syncs = state.calls.filter(c => c.path.endsWith('/api-keys/sync'));
  assert.deepEqual(syncs.map(c => [c.method, c.body]), [['POST', { customerAccountId: 9 }]]);
  assert.deepEqual(state.calls.filter(c => c.path.endsWith('/api-keys')).map(c => c.query.page), ['1', '1', '2', '3']);
  await callTool(biubiu, 'site_account');
  assert.equal(state.calls.filter(c => c.path.endsWith('/api-keys/sync')).length, 1);
});

test('reveal_key returns one site key by id, only while signed in', async t => {
  const { biubiu, state } = await setup(t);
  assert.equal((await callTool(biubiu, 'reveal_key', { siteKeyId: '1' })).isError, true, 'nothing before signing in');
  await login(biubiu);
  const r = await callTool(biubiu, 'reveal_key', { siteKeyId: '1' });
  assert.deepEqual(r.structuredContent, { siteKeyId: '1', apiKey: someKeys()[0].key });
  assert.equal(r.content[0].text, '已读取所选的站内 Key。');
  for (const args of [{ siteKeyId: '99' }, { siteKeyId: { id: '1' } }, { siteKeyId: null }]) {
    const e = await callTool(biubiu, 'reveal_key', args);
    assert.equal(e.isError, true, JSON.stringify(args)); assert.deepEqual(secretsIn(JSON.stringify(e), state), []);
  }
  await callTool(biubiu, 'site_logout');
  assert.equal((await callTool(biubiu, 'reveal_key', { siteKeyId: '1' })).isError, true, 'nothing after signing out');
});

test('a site key is sent only to the site gateway, and only on its own', async t => {
  const { biubiu, gateway, state } = await setup(t);
  await login(biubiu);
  const r = await callTool(biubiu, 'fetch_models', { baseUrl: ORIGIN, protocol: 'anthropic-messages', siteKeyId: '1' });
  assert.equal(r.structuredContent.count, 2); assert.deepEqual(secretsIn(JSON.stringify(r), state), []);
  assert.equal(gateway[0].url, `${ORIGIN}/models`);
  assert.equal(gateway[0].headers.Authorization, `Bearer ${someKeys()[0].key}`); assert.equal(gateway[0].headers['x-api-key'], someKeys()[0].key);
  const refused = [
    [{ baseUrl: 'https://elsewhere.test/v1', siteKeyId: '1' }, /只能发往 ro\.biubiu007\.com/],
    [{ baseUrl: `${ORIGIN}/v1`, siteKeyId: '2', apiKey: 'typed-key' }, /请清空 API Key/],
    [{ baseUrl: `${ORIGIN}/v1`, siteKeyId: '2', existingProviderId: 'mine' }, /取消选择已保存的服务/],
    [{ baseUrl: `${ORIGIN}/v1`, siteKeyId: '3' }, /Gemini/],
    [{ baseUrl: ORIGIN, protocol: 'anthropic-messages', siteKeyId: '4' }, /停用/],
    [{ baseUrl: ORIGIN, siteKeyId: '42' }, /没有找到这个站内 Key/],
  ];
  for (const [args, message] of refused) {
    const e = await callTool(biubiu, 'fetch_models', args);
    assert.equal(e.isError, true, JSON.stringify(args)); assert.match(e.content[0].text, message);
  }
  assert.equal(gateway.length, 1, 'no refused key reached any address');
});

test('two site keys of one group become two services, and adding a key again merges into its own service', async t => {
  const { biubiu, config } = await setup(t);
  await login(biubiu);
  const add = async (siteKeyId, modelIds, providerName) => {
    const fetched = await callTool(biubiu, 'fetch_models', { baseUrl: ORIGIN, protocol: 'anthropic-messages', siteKeyId });
    const r = await callTool(biubiu, 'import_models', { sessionId: fetched.structuredContent.sessionId, modelIds, providerName });
    assert.equal(r.isError, undefined, r.content[0].text); return r.structuredContent;
  };
  await add('1', ['model-a'], 'biubiu AI · Key 1');
  await add('5', ['model-a'], 'biubiu AI · Key 5');
  let rules = (await config()).config.providerConfigRules.providerRules;
  assert.deepEqual(rules.map(p => [p.providerName, p.config.access.apiKey, p.config.api.baseUrl]), [['biubiu AI · Key 1', someKeys()[0].key, ORIGIN], ['biubiu AI · Key 5', someKeys()[4].key, ORIGIN]]);
  await add('1', ['model-b'], 'ignored rename');
  rules = (await config()).config.providerConfigRules.providerRules;
  assert.equal(rules.length, 2); assert.deepEqual(rules[0].config.personalModelIds, ['model-a', 'model-b']); assert.equal(rules[0].config.access.apiKey, someKeys()[0].key);
  const account = (await callTool(biubiu, 'site_account')).structuredContent;
  assert.deepEqual(account.keys.map(k => k.inZCode || null), ['biubiu AI · Key 1', null, null, null, 'biubiu AI · Key 5']);
});

test('the saved sign-in is encrypted, survives a restart, and a different key or signing out discards it', async t => {
  const { biubiu, state, dir, sessionKey } = await setup(t, { persist: true });
  const file = path.join(dir, SESSION_FILE);
  await login(biubiu);
  const saved = await fs.readFile(file, 'utf8');
  assert.equal(JSON.parse(saved).v, 1);
  assert.deepEqual([...secretsIn(saved, state), ...['user@example.com', ORIGIN].filter(s => saved.includes(s))], [], 'nothing readable in the file');

  const restarted = new Site({ fetchImpl: state.fetchImpl, dataDir: dir, sessionKey });
  const logins = state.calls.filter(c => c.path === '/api/auth/login').length;
  const again = await restarted.overview();
  assert.equal(again.signedIn, true); assert.equal(again.email, 'user@example.com'); assert.equal(again.keys.length, 5);
  assert.equal(state.calls.filter(c => c.path === '/api/auth/login').length, logins, 'no new login');

  const memoryOnly = new Site({ fetchImpl: state.fetchImpl, dataDir: dir, sessionKey: crypto.randomBytes(16).toString('base64') });
  assert.equal(memoryOnly.file, '', 'a key of the wrong size saves nothing');
  assert.equal((await memoryOnly.overview()).signedIn, false);
  await fs.access(file);

  const other = new Site({ fetchImpl: state.fetchImpl, dataDir: dir, sessionKey: crypto.randomBytes(32).toString('base64') });
  assert.equal((await other.overview()).signedIn, false);
  await assert.rejects(fs.access(file), 'a sign-in this key cannot open is deleted');

  await restarted.login({ email: 'user@example.com', password: 'right-pass' });
  await fs.access(file);
  const out = await restarted.logout();
  assert.deepEqual(out, { signedIn: false, site: { origin: ORIGIN, host: 'ro.biubiu007.com', name: SITE.name } });
  await assert.rejects(fs.access(file));
  assert.deepEqual((await fs.readdir(dir)).filter(name => name.endsWith('.tmp')), []);
});
test('a sign-in saved under the old name (0.8.12 or earlier) still opens after the update, and is saved under the new one', async t => {
  const { biubiu, state, dir, sessionKey } = await setup(t, { persist: true });
  const file = path.join(dir, SESSION_FILE), secret = Buffer.from(sessionKey, 'base64');
  await login(biubiu);
  // The same sign-in, bound to the old name as an earlier version saved it.
  const box = JSON.parse(await fs.readFile(file, 'utf8')), aad = name => Buffer.from(`${name} site session v1`);
  const open = crypto.createDecipheriv('aes-256-gcm', secret, Buffer.from(box.iv, 'base64'), { authTagLength: 16 });
  open.setAAD(aad('biubiu-ai')); open.setAuthTag(Buffer.from(box.tag, 'base64'));
  const plain = Buffer.concat([open.update(Buffer.from(box.data, 'base64')), open.final()]);
  const iv = crypto.randomBytes(12), legacy = crypto.createCipheriv('aes-256-gcm', secret, iv, { authTagLength: 16 });
  legacy.setAAD(aad('model-harbor'));
  const data = Buffer.concat([legacy.update(plain), legacy.final()]);
  await fs.writeFile(file, JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: legacy.getAuthTag().toString('base64'), data: data.toString('base64') }));
  const updated = new Site({ fetchImpl: state.fetchImpl, dataDir: dir, sessionKey });
  const logins = state.calls.filter(c => c.path === '/api/auth/login').length;
  const again = await updated.overview();
  assert.equal(again.signedIn, true, 'still signed in after the update'); assert.equal(again.email, 'user@example.com');
  assert.equal(state.calls.filter(c => c.path === '/api/auth/login').length, logins, 'no new login');
  await updated.login({ email: 'user@example.com', password: 'right-pass' });
  const resaved = JSON.parse(await fs.readFile(file, 'utf8'));
  const check = crypto.createDecipheriv('aes-256-gcm', secret, Buffer.from(resaved.iv, 'base64'), { authTagLength: 16 });
  check.setAAD(aad('biubiu-ai')); check.setAuthTag(Buffer.from(resaved.tag, 'base64'));
  assert.doesNotThrow(() => Buffer.concat([check.update(Buffer.from(resaved.data, 'base64')), check.final()]), 'saved again under the new name');
});

test('site problems after signing in are reported beside what could be read', async t => {
  const { biubiu, state } = await setup(t);
  await login(biubiu);
  const original = state.fetchImpl;
  const site = biubiu.site;
  site.fetchImpl = async (url, options) => new URL(url).pathname.endsWith('/balance-summary') ? Response.json({ code: 502, message: '上游余额同步失败', data: null }, { status: 502 }) : original(url, options);
  const r = (await callTool(biubiu, 'site_account')).structuredContent;
  assert.equal(r.signedIn, true); assert.equal(r.balance, null); assert.equal(r.keys.length, 5); assert.equal(r.error, '余额读取失败：上游余额同步失败');
  site.fetchImpl = async () => { throw new TypeError('fetch failed'); };
  const offline = (await callTool(biubiu, 'site_account')).structuredContent;
  assert.equal(offline.signedIn, true); assert.match(offline.error, /失败或超时/); assert.deepEqual(offline.keys, []);
  assert.equal((await callTool(biubiu, 'reveal_key', { siteKeyId: '1' })).isError, undefined, 'keys read before stay usable while the site is unreachable');
  // A failing site whose server answers in bare English gets a plain sentence; its own Chinese reasons pass on as above.
  site.fetchImpl = async (url, options) => new URL(url).pathname.startsWith('/api/client/') ? Response.json({ code: 500, message: 'Internal Server Error', data: null }, { status: 500 }) : original(url, options);
  const broken = (await callTool(biubiu, 'site_account')).structuredContent;
  assert.deepEqual([broken.signedIn, broken.error, broken.groups, broken.keys], [true, `${SITE.name} 网站暂时出错（HTTP 500），请稍后重试。`, [], []]);
});

test('the balance alone is read with the last account found, without the keys or groups, which stay usable', async t => {
  const { biubiu, state } = await setup(t);
  const out = await callTool(biubiu, 'site_account', { balanceOnly: true });
  assert.deepEqual(out.structuredContent, { signedIn: false, site: { origin: ORIGIN, host: 'ro.biubiu007.com', name: SITE.name } });
  assert.equal(state.calls.length, 0, 'nothing is sent before signing in');
  await login(biubiu);
  const before = state.calls.length;
  state.keys[0] = { ...state.keys[0], name: 'renamed on the site' };
  const r = await callTool(biubiu, 'site_account', { balanceOnly: true });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(r.structuredContent, { signedIn: true, site: { origin: ORIGIN, host: 'ro.biubiu007.com', name: SITE.name }, email: 'user@example.com', balance: 42.5, totalRecharged: 100 });
  assert.equal(r.content[0].text, `已读取 ${SITE.name} 余额。`);
  assert.deepEqual(state.calls.slice(before).map(c => [c.path, c.query]), [['/api/client/platforms/5/balance-summary', { accountId: '9' }]], 'one request: the platform and account are the last ones found');
  assert.deepEqual(secretsIn(JSON.stringify(r), state), []);
  assert.deepEqual((await callTool(biubiu, 'reveal_key', { siteKeyId: '1' })).structuredContent, { siteKeyId: '1', apiKey: someKeys()[0].key }, 'the keys read before stay usable');
  assert.equal((await callTool(biubiu, 'site_account', { balanceOnly: 'yes' })).structuredContent.keys.length, 5, 'only balanceOnly: true reads the balance alone');

  // After a restart the sign-in comes back from the file, and the platform and account are found first.
  const restarted = new BiubiuAI({ configPath: path.join(os.tmpdir(), 'missing.json'), refreshCatalog: false, site: new Site({ fetchImpl: state.fetchImpl }) });
  restarted.site.session = biubiu.site.session;
  const fresh = state.calls.length;
  assert.equal((await callTool(restarted, 'site_account', { balanceOnly: true })).structuredContent.balance, 42.5);
  assert.deepEqual(state.calls.slice(fresh).map(c => c.path), ['/api/client/platforms', '/api/client/platforms/5/accounts', '/api/client/platforms/5/balance-summary']);

  const site = biubiu.site, working = site.fetchImpl;
  site.fetchImpl = async (url, options) => new URL(url).pathname.endsWith('/balance-summary') ? Response.json({ code: 502, message: '上游余额同步失败', data: null }, { status: 502 }) : working(url, options);
  const failed = await callTool(biubiu, 'site_account', { balanceOnly: true });
  assert.equal(failed.isError, undefined);
  assert.deepEqual([failed.structuredContent.signedIn, failed.structuredContent.balance, failed.structuredContent.error, failed.content[0].text], [true, null, '余额读取失败：上游余额同步失败', '余额读取失败：上游余额同步失败']);
  site.fetchImpl = working;
  state.access.clear(); state.failRefresh = 401;
  assert.deepEqual((await callTool(biubiu, 'site_account', { balanceOnly: true })).structuredContent, { signedIn: false, site: { origin: ORIGIN, host: 'ro.biubiu007.com', name: SITE.name }, expired: true }, 'a refused renewal signs out');
  assert.equal((await callTool(biubiu, 'reveal_key', { siteKeyId: '1' })).isError, true, 'and the keys go with the sign-in');
});

const keysMade = state => state.calls.filter(c => c.method === 'POST' && /\/groups\/\w+\/keys$/.test(c.path));

test('signing in lists the account\'s groups without their keys; a group without an upstream id is left out', async t => {
  const { biubiu, state } = await setup(t);
  const r = await login(biubiu), data = r.structuredContent;
  assert.deepEqual(data.groups.map(g => [g.id, g.name, g.platformName, g.multiplier, Boolean(g.blocked), g.hasUsableKey]), [
    ['71', 'Claude 组', 'Claude', 1, false, true], ['72', 'GPT 组', 'GPT', 0.8, false, true], ['73', 'Gemini 组', 'Gemini', 0.5, true, false], ['74', 'Grok 组', 'Grok', 0.9, false, false]]);
  assert.equal(data.groups[2].blocked, 'ZCode 暂不支持'); assert.equal(data.groups[0].remark, 'Claude 官方');
  assert.ok(data.groups.every(g => !('keys' in g) && !('baseUrl' in g) && g.inZCode === undefined));
  assert.deepEqual(secretsIn(JSON.stringify(r), state), []);
  assert.deepEqual(state.calls.find(c => c.path.endsWith('/groups')).query, { customerAccountId: '9' });
  assert.match(r.content[0].text, /5 个 Key、4 个分组/);
});

test('adding a group with a working key puts all of its models in ZCode as one service and makes no key', async t => {
  const { biubiu, state, gateway, config } = await setup(t);
  await login(biubiu);
  const r = await callTool(biubiu, 'site_add_group', { groupId: '71' });
  assert.equal(r.isError, undefined, r.content[0].text);
  const out = r.structuredContent;
  assert.deepEqual([out.groupId, out.groupName, out.providerName, out.models, out.added, out.createdKey], ['71', 'Claude 组', 'biubiu AI · Claude 组', 2, 2, undefined]);
  assert.deepEqual(keysMade(state), [], 'the group had a working key');
  assert.equal(gateway.at(-1).headers.Authorization, `Bearer ${someKeys()[0].key}`, 'its first working key: key 4 is disabled');
  const rules = (await config()).config.providerConfigRules.providerRules;
  assert.deepEqual(rules.map(p => [p.providerName, p.config.api.type, p.config.api.baseUrl, p.config.access.apiKey, p.config.personalModelIds]), [['biubiu AI · Claude 组', 'anthropic-messages', ORIGIN, someKeys()[0].key, ['model-a', 'model-b']]]);
  assert.deepEqual(secretsIn(JSON.stringify(r), state), []); assert.equal(biubiu.sessions.size, 0, 'the fetch behind it is not kept');
  const account = (await callTool(biubiu, 'site_account')).structuredContent;
  assert.deepEqual(account.groups.map(g => g.inZCode || null), [[{ name: 'biubiu AI · Claude 组', modelCount: 2 }], null, null, null]);
  const again = await callTool(biubiu, 'site_add_group', { groupId: '71' });
  assert.equal(again.structuredContent.unchanged, true); assert.match(again.content[0].text, /已经都在 ZCode 里/);
});

test('adding a group in ZCode again adds what its service lacks, with the key that service has, and makes no second service', async t => {
  const { biubiu, state, config } = await setup(t);
  await login(biubiu);
  // Key 5 of the Claude group went in with one of its models: the group shows as in ZCode, model-b still missing.
  await addKey(biubiu, '5', ['model-a'], 'biubiu AI · Key 5');
  const account = (await callTool(biubiu, 'site_account')).structuredContent;
  assert.deepEqual(account.groups.find(g => g.id === '71').inZCode, [{ name: 'biubiu AI · Key 5', modelCount: 1 }]);
  // Key 1 is the group's first working key; the group's service has key 5, so the missing model joins that service.
  const r = await callTool(biubiu, 'site_add_group', { groupId: '71' });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual([r.structuredContent.providerName, r.structuredContent.added, r.structuredContent.createdKey], ['biubiu AI · Key 5', 1, undefined]);
  const rules = (await config()).config.providerConfigRules.providerRules;
  assert.deepEqual(rules.map(p => [p.providerName, p.config.access.apiKey, p.config.personalModelIds]), [['biubiu AI · Key 5', someKeys()[4].key, ['model-a', 'model-b']]]);
  assert.deepEqual(keysMade(state), []); assert.deepEqual(secretsIn(JSON.stringify(r), state), []);
  assert.equal((await callTool(biubiu, 'site_add_group', { groupId: '71' })).structuredContent.unchanged, true, 'nothing left to add');
});

test('a group without a working key gets a key made on the site only when the panel asked, with the site\'s defaults', async t => {
  const { biubiu, state, config } = await setup(t);
  await login(biubiu);
  const refused = await callTool(biubiu, 'site_add_group', { groupId: '74' });
  assert.equal(refused.isError, true); assert.match(refused.content[0].text, /「Grok 组」还没有可用的 Key/);
  assert.deepEqual(keysMade(state), []);
  const [first, second] = await Promise.all([callTool(biubiu, 'site_add_group', { groupId: '74', createKey: true }), callTool(biubiu, 'site_add_group', { groupId: '74', createKey: true })]);
  assert.equal(first.isError, undefined, first.content[0].text); assert.equal(second.isError, undefined, second.content[0].text);
  assert.deepEqual(keysMade(state).map(c => [c.path, c.query, c.body]), [['/api/client/platforms/5/groups/74/keys', { customerAccountId: '9' }, { name: 'ZCode · Grok 组' }]], 'one key, even for two clicks at once');
  assert.equal(first.structuredContent.createdKey, 'ZCode · Grok 组'); assert.match(first.content[0].text, /新建了 Key「ZCode · Grok 组」/);
  assert.equal(second.structuredContent.unchanged, true);
  const rules = (await config()).config.providerConfigRules.providerRules;
  assert.deepEqual(rules.map(p => [p.providerName, p.config.api.type, p.config.api.baseUrl, p.config.access.apiKey]), [['biubiu AI · Grok 组', 'openai-chat-completions', `${ORIGIN}/v1`, state.keys.at(-1).key]]);
  assert.deepEqual(secretsIn(JSON.stringify([first, second]), state), []);
  const account = (await callTool(biubiu, 'site_account')).structuredContent;
  assert.equal(account.keys.length, 6);
  assert.deepEqual(account.groups.find(g => g.id === '74'), { id: '74', name: 'Grok 组', platform: 'grok', platformName: 'Grok', multiplier: 0.9, remark: '', blocked: '', hasUsableKey: true, inZCode: [{ name: 'biubiu AI · Grok 组', modelCount: 2 }], keyId: '100' });
  await callTool(biubiu, 'site_remove_group', { groupId: '74' });
  assert.equal((await callTool(biubiu, 'site_add_group', { groupId: '74' })).isError, undefined, 'the key made before is used again');
  assert.equal(keysMade(state).length, 1);
});

test('a Gemini group, an unknown group or a signed-out account adds nothing and makes no key', async t => {
  const { biubiu, state, config, gateway } = await setup(t);
  const before = JSON.stringify(await config());
  assert.equal((await callTool(biubiu, 'site_add_group', { groupId: '71' })).content[0].text, '请先登录。');
  assert.equal((await callTool(biubiu, 'site_remove_group', { groupId: '71' })).content[0].text, '请先登录。');
  await login(biubiu);
  for (const [args, message] of [[{ groupId: '73', createKey: true }, /Gemini/], [{ groupId: '99', createKey: true }, /没有找到这个分组/], [{ groupId: { id: '71' } }, /没有找到这个分组/], [{}, /没有找到这个分组/]]) {
    const r = await callTool(biubiu, 'site_add_group', args);
    assert.equal(r.isError, true, JSON.stringify(args)); assert.match(r.content[0].text, message);
  }
  assert.deepEqual(keysMade(state), []); assert.equal(gateway.length, 0); assert.equal(JSON.stringify(await config()), before);
});

test('removing a group deletes every ZCode service with one of its keys, with backups, and keeps the keys on the site', async t => {
  const { biubiu, state, config, configPath } = await setup(t);
  await login(biubiu);
  await callTool(biubiu, 'site_add_group', { groupId: '71' });
  // Key 5 of the same group, added earlier through the connect form, is the group's too.
  const fetched = await callTool(biubiu, 'fetch_models', { baseUrl: ORIGIN, protocol: 'anthropic-messages', siteKeyId: '5' });
  await callTool(biubiu, 'import_models', { sessionId: fetched.structuredContent.sessionId, modelIds: ['model-a'], providerName: 'biubiu AI · Key 5' });
  await callTool(biubiu, 'site_add_group', { groupId: '72' });
  // The same key saved by hand for another address is not the group's service.
  let doc = await config();
  doc.config.providerConfigRules.providerRules.push({ providerId: 'elsewhere', providerName: '别处', config: { group: 'standard-personal', access: { type: 'api-key', apiKey: someKeys()[0].key }, api: { type: 'openai-chat-completions', baseUrl: 'https://elsewhere.test/v1' }, personalModelIds: ['model-a'] } });
  await fs.writeFile(configPath, JSON.stringify(doc));
  const gone = doc.config.providerConfigRules.providerRules.filter(p => ['biubiu AI · Claude 组', 'biubiu AI · Key 5'].includes(p.providerName)).map(p => p.providerId);
  const backups = async () => (await fs.readdir(path.join(path.dirname(configPath), 'backups', 'biubiu-ai'))).length;
  const saved = await backups();
  const r = await callTool(biubiu, 'site_remove_group', { groupId: '71' });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(r.structuredContent, { groupId: '71', groupName: 'Claude 组', removed: ['biubiu AI · Claude 组', 'biubiu AI · Key 5'], models: 3 });
  assert.match(r.content[0].text, /删除分组「Claude 组」的 3 个模型/);
  doc = await config();
  assert.deepEqual(doc.config.providerConfigRules.providerRules.map(p => p.providerName), ['biubiu AI · GPT 组', '别处']);
  assert.ok(!JSON.stringify(doc.config.modelConfigRules).includes(gone[0]) && !JSON.stringify(doc.config.modelConfigRules).includes(gone[1]), 'their model settings went with them');
  assert.equal(await backups(), saved + 2, 'one backup for each service removed');
  assert.ok(!state.calls.some(c => c.method === 'DELETE'), 'no key is deleted on the site');
  assert.deepEqual(secretsIn(JSON.stringify(r), state), []);
  const nothing = await callTool(biubiu, 'site_remove_group', { groupId: '71' });
  assert.equal(nothing.isError, true); assert.equal(nothing.content[0].text, 'ZCode 里没有「Claude 组」的服务。');
  // A service ZCode's default model still uses stays.
  doc.config.defaultModel = { providerId: doc.config.providerConfigRules.providerRules[0].providerId, modelId: 'model-a' };
  await fs.writeFile(configPath, JSON.stringify(doc));
  const refused = await callTool(biubiu, 'site_remove_group', { groupId: '72' });
  assert.equal(refused.isError, true); assert.match(refused.content[0].text, /默认模型/);
  assert.equal((await config()).config.providerConfigRules.providerRules.length, 2);
});

test('a key made for a group is named in the error when its models cannot be read, and the next add uses it', async t => {
  const { biubiu, state, config } = await setup(t);
  await login(biubiu);
  const working = biubiu.fetchImpl;
  biubiu.fetchImpl = async () => Response.json({ error: 'upstream down' }, { status: 502 });
  const r = await callTool(biubiu, 'site_add_group', { groupId: '74', createKey: true });
  assert.equal(r.isError, true); assert.match(r.content[0].text, /^已在网站上为「Grok 组」新建 Key「ZCode · Grok 组」，但没能加入 ZCode：未找到可用的模型列表/);
  assert.deepEqual(secretsIn(JSON.stringify(r), state), []); assert.equal((await config()).config.providerConfigRules.providerRules.length, 0);
  biubiu.fetchImpl = working;
  const again = await callTool(biubiu, 'site_add_group', { groupId: '74' });
  assert.equal(again.isError, undefined, again.content[0].text);
  assert.equal(keysMade(state).length, 1);
});

test('the site window gets an access token from handoff, renewed for it, and never the refresh token', async t => {
  const { biubiu, site, state, dir, sessionKey } = await setup(t, { persist: true });
  assert.deepEqual(await site.handoff(), { signedIn: false }, 'signed out, there is nothing to hand over');
  assert.equal(state.calls.length, 0);
  await login(biubiu);
  const before = state.refreshes, refreshTokens = new Set(state.refresh);
  const first = await site.handoff();
  assert.deepEqual(Object.keys(first).sort(), ['accessToken', 'signedIn']); assert.equal(first.signedIn, true);
  assert.ok(state.access.has(first.accessToken)); assert.equal(state.refreshes - before, 1, 'renewed, so the window gets a token with its whole lifetime ahead');
  assert.ok(!JSON.stringify(first).includes('refresh-'), 'no refresh token leaves the module');
  assert.ok(![...refreshTokens].some(token => state.refresh.has(token)), 'the refresh token the panel had is used up, and the module keeps the new one');
  // A page asking again at once gets the same token: at most one renewal every 10 seconds.
  assert.equal((await site.handoff()).accessToken, first.accessToken); assert.equal(state.refreshes - before, 1);
  // Later asks renew again, and the panel goes on with the newest pair, so the two never renew past each other.
  site.handedAt -= 10000;
  const later = await site.handoff();
  assert.notEqual(later.accessToken, first.accessToken); assert.equal(state.refreshes - before, 2); assert.equal(state.refresh.size, 1);
  const account = (await callTool(biubiu, 'site_account')).structuredContent;
  assert.deepEqual([account.signedIn, account.error], [true, undefined]);
  assert.equal(state.calls.at(-1).auth, `Bearer ${later.accessToken}`, 'the panel reads with the token the window has');
  // The saved sign-in follows each renewal, so the companion still signs in after a restart.
  const restarted = new Site({ fetchImpl: state.fetchImpl, dataDir: dir, sessionKey });
  assert.equal((await restarted.balance()).balance, 42.5);
  // A refused renewal signs the panel out too, and the window learns it on its next ask.
  site.handedAt -= 10000; state.failRefresh = 401;
  assert.deepEqual(await site.handoff(), { signedIn: false });
  assert.equal((await callTool(biubiu, 'site_account')).structuredContent.signedIn, false);
});

test('a renewal for the site window that fails for now is an error, and the sign-in stays', async t => {
  const { biubiu, site, state } = await setup(t);
  await login(biubiu);
  state.failRefresh = 502;
  await assert.rejects(site.handoff(), /续期暂时失败/);
  state.failRefresh = 0;
  assert.equal((await site.handoff()).signedIn, true);
  assert.equal((await callTool(biubiu, 'site_account')).structuredContent.signedIn, true);
});

const deletes = state => state.calls.filter(c => c.method === 'DELETE');
// Adds a site key's models to ZCode as the site page does: fetched by the key's id alone, then imported.
async function addKey(biubiu, siteKeyId, modelIds, providerName, { baseUrl = ORIGIN, protocol = 'anthropic-messages' } = {}) {
  const fetched = await callTool(biubiu, 'fetch_models', { baseUrl, protocol, siteKeyId });
  assert.equal(fetched.isError, undefined, fetched.content[0].text);
  const r = await callTool(biubiu, 'import_models', { sessionId: fetched.structuredContent.sessionId, modelIds, providerName });
  assert.equal(r.isError, undefined, r.content[0].text);
  return fetched.structuredContent;
}

test('fetching a site key\'s models again marks the ones its own ZCode service already has', async t => {
  const { biubiu } = await setup(t);
  await login(biubiu);
  const first = await addKey(biubiu, '1', ['model-a'], 'biubiu AI · Key 1');
  assert.ok(first.models.every(m => m.inZCode === undefined), 'nothing is in ZCode yet');
  const again = (await callTool(biubiu, 'fetch_models', { baseUrl: ORIGIN, protocol: 'anthropic-messages', siteKeyId: '1' })).structuredContent;
  assert.deepEqual(again.models.map(m => [m.id, m.inZCode ?? false]), [['model-a', true], ['model-b', false]]);
  const other = (await callTool(biubiu, 'fetch_models', { baseUrl: ORIGIN, protocol: 'anthropic-messages', siteKeyId: '5' })).structuredContent;
  assert.ok(other.models.every(m => m.inZCode === undefined), 'another key of the same group has a service of its own');
});

test('deleting a site key takes every ZCode service holding it out first, without a backup, then deletes the key on the site', async t => {
  const { biubiu, state, config, configPath } = await setup(t);
  await login(biubiu);
  await addKey(biubiu, '1', ['model-a', 'model-b'], 'biubiu AI · Key 1');
  await callTool(biubiu, 'site_add_group', { groupId: '72' });
  // The same key saved by hand at another address stops working with it, and goes too.
  const doc = await config();
  doc.config.providerConfigRules.providerRules.push({ providerId: 'elsewhere', providerName: '别处', config: { group: 'standard-personal', access: { type: 'api-key', apiKey: someKeys()[0].key }, api: { type: 'openai-chat-completions', baseUrl: 'https://elsewhere.test/v1' }, personalModelIds: ['model-a'] } });
  await fs.writeFile(configPath, JSON.stringify(doc));
  assert.equal((await callTool(biubiu, 'site_account')).structuredContent.keys[0].testKey, false);
  const backups = async () => (await fs.readdir(path.join(path.dirname(configPath), 'backups', 'biubiu-ai'))).length;
  const saved = await backups();
  const r = await callTool(biubiu, 'site_delete_key', { siteKeyId: '1' });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(r.structuredContent, { siteKeyId: '1', keyName: 'Key 1', removed: ['biubiu AI · Key 1', '别处'], models: 3 });
  assert.equal(r.content[0].text, '已删除站内 Key「Key 1」，并从 ZCode 删除了「biubiu AI · Key 1」「别处」。');
  assert.deepEqual((await config()).config.providerConfigRules.providerRules.map(p => p.providerName), ['biubiu AI · GPT 组'], 'the other key\'s service stays');
  assert.equal(await backups(), saved, 'no backup: the user confirmed it in the panel');
  assert.deepEqual(deletes(state).map(c => [c.path, c.query, c.body]), [['/api/client/platforms/5/api-keys/1', { customerAccountId: '9' }, null]], 'deleted as the site\'s own key page does');
  assert.ok(deletes(state)[0].auth.startsWith('Bearer '));
  assert.deepEqual(secretsIn(JSON.stringify(r), state), []);
  // The key leaves the account, its group and reveal_key.
  const account = (await callTool(biubiu, 'site_account')).structuredContent;
  assert.deepEqual(account.keys.map(k => k.id), ['2', '3', '4', '5']);
  assert.equal(account.groups.find(g => g.id === '71').hasUsableKey, true, 'key 5 is left in the group');
  assert.equal((await callTool(biubiu, 'reveal_key', { siteKeyId: '1' })).isError, true);
  // A key in no ZCode service is deleted on the site alone.
  const plain = await callTool(biubiu, 'site_delete_key', { siteKeyId: '5' });
  assert.deepEqual([plain.structuredContent, plain.content[0].text], [{ siteKeyId: '5', keyName: 'Key 5', removed: [], models: 0 }, '已删除站内 Key「Key 5」。']);
  assert.equal((await callTool(biubiu, 'site_account')).structuredContent.groups.find(g => g.id === '71').hasUsableKey, false, 'only the disabled key 4 is left');
});

test('a key ZCode\'s default model still uses, a test key of the site or an unknown key is deleted nowhere', async t => {
  const keys = [...someKeys(), siteKey(6, 'anthropic', { name: 'hub-ptest-g:71' }), siteKey(7, 'openai', { name: '【subApiHub测试】g72' }), siteKey(8, 'openai', { name: 'hub-ctest-i:abc-1-g:72' })];
  const { biubiu, state, config, configPath } = await setup(t, { keys });
  assert.equal((await callTool(biubiu, 'site_delete_key', { siteKeyId: '1' })).isError, true, 'nothing before signing in');
  const account = (await login(biubiu)).structuredContent;
  assert.deepEqual(account.keys.map(k => k.testKey), [false, false, false, false, false, true, true, true]);
  await addKey(biubiu, '1', ['model-a'], 'biubiu AI · Key 1');
  // Of the two services holding key 1, ZCode's default model uses the second: neither goes, nor the key on the site.
  const doc = await config();
  doc.config.providerConfigRules.providerRules.push({ providerId: 'elsewhere', providerName: '别处', config: { group: 'standard-personal', access: { type: 'api-key', apiKey: someKeys()[0].key }, api: { type: 'openai-chat-completions', baseUrl: 'https://elsewhere.test/v1' }, personalModelIds: ['model-a'] } });
  doc.config.defaultModel = { providerId: 'elsewhere', modelId: 'model-a' };
  await fs.writeFile(configPath, JSON.stringify(doc));
  const before = await fs.readFile(configPath, 'utf8');
  const refused = await callTool(biubiu, 'site_delete_key', { siteKeyId: '1' });
  assert.equal(refused.isError, true);
  assert.equal(refused.content[0].text, '「别处」还在被 ZCode 的默认模型或其他设置使用，网站上的 Key 和 ZCode 里的服务都没有删除。请先在 ZCode 里换成其他服务的模型，再删除。');
  assert.equal(await fs.readFile(configPath, 'utf8'), before, 'all or nothing: the first service stays too');
  for (const [args, message] of [[{ siteKeyId: '6' }, /测试分组/], [{ siteKeyId: '7' }, /测试分组/], [{ siteKeyId: '8' }, /测试分组/], [{ siteKeyId: '99' }, /没有找到这个站内 Key/], [{ siteKeyId: { id: '1' } }, /没有找到这个站内 Key/], [{}, /没有找到这个站内 Key/]]) {
    const r = await callTool(biubiu, 'site_delete_key', args);
    assert.equal(r.isError, true, JSON.stringify(args)); assert.match(r.content[0].text, message);
  }
  assert.deepEqual(deletes(state), [], 'nothing reached the site');
  assert.equal((await callTool(biubiu, 'site_account')).structuredContent.keys.length, 8);
});

test('a key the site fails to delete after its services left ZCode says so, and deleting it again finishes', async t => {
  const { biubiu, state, config } = await setup(t);
  await login(biubiu);
  await addKey(biubiu, '1', ['model-a'], 'biubiu AI · Key 1');
  state.failDelete = 502;
  const failed = await callTool(biubiu, 'site_delete_key', { siteKeyId: '1' });
  assert.equal(failed.isError, true);
  assert.equal(failed.content[0].text, '已从 ZCode 删除「biubiu AI · Key 1」，但网站上的 Key 没有删除：上游删除失败');
  assert.deepEqual((await config()).config.providerConfigRules.providerRules, []);
  state.failDelete = 0;
  const again = await callTool(biubiu, 'site_delete_key', { siteKeyId: '1' });
  assert.deepEqual(again.structuredContent, { siteKeyId: '1', keyName: 'Key 1', removed: [], models: 0 });
  // A sign-in the site no longer takes deletes nothing more, and signs out.
  state.access.clear(); state.failRefresh = 401;
  const out = await callTool(biubiu, 'site_delete_key', { siteKeyId: '2' });
  assert.equal(out.content[0].text, '登录已过期，请重新登录。');
  assert.equal((await callTool(biubiu, 'site_account')).structuredContent.signedIn, false);
  assert.equal(deletes(state).length, 3);
});

test('keys go by the site\'s own id (localId), which its groups name them by and its key page deletes them with', async t => {
  const { biubiu, state } = await setup(t, { keys: someKeys().map(k => ({ ...k, localId: k.id + 500 })) });
  const data = (await login(biubiu)).structuredContent;
  assert.deepEqual(data.keys.map(k => k.id), ['501', '502', '503', '504', '505']);
  assert.deepEqual(data.groups.map(g => [g.id, g.hasUsableKey]), [['71', true], ['72', true], ['73', false], ['74', false]], 'each group finds its own keys');
  const r = await callTool(biubiu, 'site_add_group', { groupId: '71' });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(keysMade(state), [], 'the group\'s working key is used, and no key is made');
  assert.equal((await callTool(biubiu, 'site_account')).structuredContent.keys[0].inZCode, 'biubiu AI · Claude 组');
  const removed = await callTool(biubiu, 'site_delete_key', { siteKeyId: '505' });
  assert.equal(removed.isError, undefined, removed.content[0].text);
  assert.deepEqual(deletes(state).map(c => c.path), ['/api/client/platforms/5/api-keys/505']);
});

// A model gateway whose list the test changes as the site's own list does: ids is read at every request.
function serveModels(biubiu, ids) {
  biubiu.fetchImpl = async (url, options) => options.method === 'POST'
    ? Response.json({ content: [{ type: 'text', text: 'OK' }] })
    : Response.json({ data: ids.map(id => ({ id })) });
}
const ruleIds = (rules, providerId) => rules.filter(r => r.providerId === providerId).map(r => r.modelId);

test('each site key bills at its group\'s multiplier', async t => {
  const { biubiu, state } = await setup(t);
  const data = (await login(biubiu)).structuredContent;
  assert.deepEqual(data.keys.map(k => [k.id, k.multiplier ?? null]), [['1', 1], ['2', 0.8], ['3', 0.5], ['4', 1], ['5', 1]]);
  assert.deepEqual(secretsIn(JSON.stringify(data), state), []);
});

test('a group in ZCode names the site key its service uses, and fetching that key again lists the models the site dropped', async t => {
  const { biubiu, state } = await setup(t);
  await login(biubiu);
  const listed = ['model-a', 'model-b', 'model-c'];
  serveModels(biubiu, listed);
  const added = await callTool(biubiu, 'site_add_group', { groupId: '71' });
  assert.equal(added.isError, undefined, added.content[0].text);
  const account = (await callTool(biubiu, 'site_account')).structuredContent;
  const group = account.groups.find(g => g.id === '71');
  assert.deepEqual(group.inZCode, [{ name: 'biubiu AI · Claude 组', modelCount: 3 }]);
  assert.equal(group.keyId, '1', 'the group\'s service holds key 1');
  assert.deepEqual(account.groups.filter(g => g.id !== '71').map(g => [g.id, g.keyId ?? null]), [['72', '2'], ['73', null], ['74', null]], 'another group names a working key of its own; a Gemini group or one without a key names none');
  listed.splice(1); // the site no longer lists model-b and model-c
  const fetched = await callTool(biubiu, 'fetch_models', { baseUrl: ORIGIN, protocol: 'anthropic-messages', siteKeyId: '1' });
  assert.equal(fetched.isError, undefined, fetched.content[0].text);
  assert.deepEqual(fetched.structuredContent.models.map(m => [m.id, m.inZCode ?? false]), [['model-a', true]]);
  assert.deepEqual(fetched.structuredContent.missing, ['model-b', 'model-c']);
  assert.deepEqual(secretsIn(JSON.stringify(fetched), state), []);
});

test('taking models out of a service removes them and their settings, with a backup, and leaves other services alone', async t => {
  const { biubiu, state, config, configPath } = await setup(t);
  await login(biubiu);
  const listed = ['model-a', 'model-b', 'model-c'];
  serveModels(biubiu, listed);
  for (const groupId of ['71', '72']) assert.equal((await callTool(biubiu, 'site_add_group', { groupId })).isError, undefined);
  let doc = await config();
  const claude = doc.config.providerConfigRules.providerRules.find(p => p.providerName === 'biubiu AI · Claude 组');
  const gpt = doc.config.providerConfigRules.providerRules.find(p => p.providerName === 'biubiu AI · GPT 组');
  const gptRules = JSON.stringify(doc.config.modelConfigRules.providerModelRules.filter(r => r.providerId === gpt.providerId));
  listed.splice(1); // the site no longer lists model-b and model-c
  let fetched = (await callTool(biubiu, 'fetch_models', { baseUrl: ORIGIN, protocol: 'anthropic-messages', siteKeyId: '1' })).structuredContent;
  assert.deepEqual(fetched.missing, ['model-b', 'model-c']);
  const beforeRaw = await fs.readFile(configPath, 'utf8');
  const onlyRemoved = await callTool(biubiu, 'import_models', { sessionId: fetched.sessionId, modelIds: [], removeModelIds: ['model-b', 'model-a'] });
  assert.equal(onlyRemoved.isError, undefined, onlyRemoved.content[0].text);
  assert.deepEqual([onlyRemoved.structuredContent.added, onlyRemoved.structuredContent.removed], [0, 2]);
  assert.equal(onlyRemoved.content[0].text, '已从 biubiu AI · Claude 组 移除 2 个模型。');
  assert.equal(await fs.readFile(onlyRemoved.structuredContent.backupPath, 'utf8'), beforeRaw, 'the config as it was is backed up');
  doc = await config();
  const claudeNow = doc.config.providerConfigRules.providerRules.find(p => p.providerName === 'biubiu AI · Claude 组');
  assert.deepEqual(claudeNow.config.personalModelIds, ['model-c']);
  assert.deepEqual(claudeNow.config.modelOrder, ['model-c']);
  assert.deepEqual(ruleIds(doc.config.modelConfigRules.providerModelRules, claude.providerId), ['model-c']);
  assert.deepEqual(ruleIds(doc.config.modelConfigRules.manualProviderModelRules, claude.providerId), []);
  assert.equal(JSON.stringify(doc.config.providerConfigRules.providerRules.find(p => p.providerName === 'biubiu AI · GPT 组')), JSON.stringify(gpt), 'the other service is unchanged');
  assert.equal(JSON.stringify(doc.config.modelConfigRules.providerModelRules.filter(r => r.providerId === gpt.providerId)), gptRules, 'and so are its model settings');
  // One model still listed leaves while another the site dropped comes back, in one write.
  fetched = (await callTool(biubiu, 'fetch_models', { baseUrl: ORIGIN, protocol: 'anthropic-messages', siteKeyId: '1' })).structuredContent;
  assert.deepEqual(fetched.missing, ['model-c']);
  const both = await callTool(biubiu, 'import_models', { sessionId: fetched.sessionId, modelIds: ['model-a'], removeModelIds: ['model-c'] });
  assert.equal(both.isError, undefined, both.content[0].text);
  assert.deepEqual([both.structuredContent.added, both.structuredContent.removed], [1, 1]);
  assert.equal(both.content[0].text, '已向 biubiu AI · Claude 组 新增 1 个、移除 1 个模型。');
  doc = await config();
  const final = doc.config.providerConfigRules.providerRules.find(p => p.providerName === 'biubiu AI · Claude 组');
  assert.deepEqual(final.config.personalModelIds, ['model-a']);
  assert.deepEqual(final.config.modelOrder, ['model-a']);
  assert.deepEqual(ruleIds(doc.config.modelConfigRules.providerModelRules, claude.providerId), ['model-a']);
  assert.deepEqual(secretsIn(JSON.stringify([onlyRemoved, both]), state), []);
});

test('unticking is refused for every model, a model ZCode still uses, one not in the fetch or one also ticked, leaving the config as it was', async t => {
  const { biubiu, config, configPath } = await setup(t);
  await login(biubiu);
  serveModels(biubiu, ['model-a', 'model-b']);
  assert.equal((await callTool(biubiu, 'site_add_group', { groupId: '71' })).isError, undefined);
  const doc = await config(), target = doc.config.providerConfigRules.providerRules[0];
  const before = await fs.readFile(configPath, 'utf8');
  const fetched = (await callTool(biubiu, 'fetch_models', { baseUrl: ORIGIN, protocol: 'anthropic-messages', siteKeyId: '1' })).structuredContent;
  assert.deepEqual(fetched.missing, []);
  const refused = async (args, message) => {
    const r = await callTool(biubiu, 'import_models', { sessionId: fetched.sessionId, ...args });
    assert.equal(r.isError, true, JSON.stringify(args)); assert.match(r.content[0].text, message);
    assert.equal(await fs.readFile(configPath, 'utf8'), before, JSON.stringify(args));
  };
  await refused({ modelIds: [], removeModelIds: ['model-a', 'model-b'] }, /至少要保留一个模型/);
  await refused({ modelIds: [], removeModelIds: ['model-zzz'] }, /只能移除本次读取/);
  await refused({ modelIds: ['model-a'], removeModelIds: ['model-a'] }, /既添加又移除/);
  // ZCode's own setting still naming the model keeps it.
  doc.config.defaultModelSelection = { providerId: target.providerId, modelId: 'model-a' };
  await fs.writeFile(configPath, JSON.stringify(doc));
  const used = await fs.readFile(configPath, 'utf8');
  const kept = await callTool(biubiu, 'import_models', { sessionId: fetched.sessionId, modelIds: [], removeModelIds: ['model-a'] });
  assert.equal(kept.isError, true); assert.match(kept.content[0].text, /默认模型/);
  assert.equal(await fs.readFile(configPath, 'utf8'), used);
  // A service that is not in ZCode has nothing to take out.
  const other = (await callTool(biubiu, 'fetch_models', { baseUrl: `${ORIGIN}/v1`, protocol: 'openai-responses', siteKeyId: '2' })).structuredContent;
  const none = await callTool(biubiu, 'import_models', { sessionId: other.sessionId, modelIds: [], removeModelIds: ['model-a'] });
  assert.equal(none.isError, true); assert.match(none.content[0].text, /已不在 ZCode/);
  assert.equal(await fs.readFile(configPath, 'utf8'), used);
});

test('添加 in the panel only finds or makes the group\'s key, by keyOnly, and adds no model', async t => {
  const { biubiu, state, config } = await setup(t);
  await login(biubiu);
  serveModels(biubiu, ['model-a', 'model-b']);
  const before = JSON.stringify(await config());
  const found = await callTool(biubiu, 'site_add_group', { groupId: '71', keyOnly: true });
  assert.deepEqual([found.structuredContent, found.content[0].text], [{ groupId: '71', groupName: 'Claude 组', keyId: '1' }, '已找到分组「Claude 组」可用的 Key。']);
  const refused = await callTool(biubiu, 'site_add_group', { groupId: '74', keyOnly: true });
  assert.equal(refused.isError, true, 'no key is made without createKey'); assert.deepEqual(keysMade(state), []);
  const made = await callTool(biubiu, 'site_add_group', { groupId: '74', keyOnly: true, createKey: true });
  assert.deepEqual([made.structuredContent, made.content[0].text], [{ groupId: '74', groupName: 'Grok 组', keyId: '100', createdKey: 'ZCode · Grok 组' }, '已在网站上为分组「Grok 组」新建 Key「ZCode · Grok 组」。']);
  assert.equal(keysMade(state).length, 1);
  assert.equal(JSON.stringify(await config()), before, 'no model went to ZCode');
  assert.deepEqual(secretsIn(JSON.stringify([found, made]), state), []);
  // The key made is listed with the account, so the panel opens the group's models with it.
  const account = (await callTool(biubiu, 'site_account')).structuredContent;
  assert.equal(account.groups.find(g => g.id === '74').keyId, '100');
  assert.ok(account.keys.some(k => k.id === '100'));
});
