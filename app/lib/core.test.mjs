import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Harbor, normalizeUrl, parseModels } from './core.mjs';
import { callTool, TOOL_NAMES, VERSION } from './tools.mjs';
import { MetadataCatalog } from './metadata.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const seed = () => ({ schemaVersion: 1, config: { providerOrder: ['mine'], defaultModelSelection: { providerId: 'mine', modelId: 'old-model' }, providerConfigRules: { providerRules: [{ providerId: 'mine', providerName: '现有供应商', config: { group: 'standard-personal', access: { type: 'api-key', apiKey: 'stored-secret' }, api: { type: 'anthropic-messages', baseUrl: 'https://provider.test' }, personalModelIds: ['old-model'], modelOrder: ['old-model'] } }] }, modelConfigRules: { providerModelRules: [{ providerId: 'mine', modelId: 'old-model', config: { enabled: false, properties: { contextWindow: 500000, inputFormat: { supportsImage: true } } } }], manualProviderModelRules: [] } } });
async function fixture(t, fetchImpl = async () => Response.json({ data: [{ id: 'new-model' }, { id: 'old-model' }] })) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-harbor-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'provider_config.json'); await fs.writeFile(configPath, JSON.stringify(seed()));
  return { dir, configPath, harbor: new Harbor({ configPath, fetchImpl, metadataCatalog: new MetadataCatalog({ dataDir: path.join(dir, 'cache'), refresh: false }) }) };
}
// Files outside app/lib (the project package.json) are read relative to this folder; missing files read as null.
async function readJson(rel) { try { return JSON.parse(await fs.readFile(path.join(root, rel), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
test('accepts API endpoint URLs and rejects credentials/query injection', () => {
  assert.equal(normalizeUrl(' https://api.test/v1/chat/completions/ '), 'https://api.test/v1');
  for (const url of ['file:///etc/passwd', 'https://u:p@api.test', 'https://api.test?key=secret', 'wrong']) assert.throws(() => normalizeUrl(url));
  assert.deepEqual(parseModels({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] }), [{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(parseModels({ models: ['x'] }), [{ id: 'x' }]);
});
test('providers never expose stored keys', async t => {
  const { harbor } = await fixture(t); const json = JSON.stringify(await harbor.providers()); assert.ok(!json.includes('stored-secret')); assert.ok(json.includes('现有供应商'));
});
test('list_providers names each service\'s models in ZCode\'s order and counts the same names', async t => {
  const { harbor, configPath } = await fixture(t);
  const doc = seed(), p = doc.config.providerConfigRules.providerRules[0];
  p.config.personalModelIds = ['b-model', 'old-model', 7, 'c-model', 'b-model']; p.config.modelOrder = ['c-model', 'removed-model', 'old-model'];
  await fs.writeFile(configPath, JSON.stringify(doc));
  const listed = (await callTool(harbor, 'list_providers')).structuredContent.providers[0];
  assert.deepEqual(listed.models, ['c-model', 'old-model', 'b-model']); assert.equal(listed.modelCount, 3);
  assert.ok(!/secret/.test(JSON.stringify(listed)));
});
test('fetch falls back to /v1/models and keeps secrets out of results', async t => {
  const urls = []; const { harbor } = await fixture(t, async (url, opts) => { urls.push(url); assert.equal(opts.redirect, 'error'); assert.equal(opts.headers.Authorization, 'Bearer secret-key'); return url.endsWith('/v1/models') ? Response.json({ data: [{ id: 'new-model' }] }) : new Response('', { status: 404 }); });
  const r = await harbor.fetchModels({ baseUrl: 'https://new.test', apiKey: 'secret-key' }); assert.equal(r.count, 1); assert.equal(urls.length, 2); assert.ok(!JSON.stringify(r).includes('secret-key'));
});
test('rejects unauthorized endpoints without reflecting response bodies', async t => {
  const { harbor } = await fixture(t, async () => new Response('stored-secret', { status: 401 }));
  const r = await callTool(harbor, 'fetch_models', { baseUrl: 'https://new.test', apiKey: 'secret-key' }); assert.equal(r.isError, true); assert.ok(!JSON.stringify(r).includes('secret')); assert.match(r.content[0].text, /401/);
});
test('saved credentials cannot be sent to a changed endpoint', async t => {
  let called = false; const { harbor } = await fixture(t, async () => { called = true; return Response.json({ data: [] }); });
  await assert.rejects(harbor.fetchModels({ baseUrl: 'https://attacker.test', existingProviderId: 'mine' }), /地址已变更/); assert.equal(called, false);
});
test('merges models, preserves saved settings and exact backup; reimport is a no-op', async t => {
  const { harbor, configPath, dir } = await fixture(t); const original = await fs.readFile(configPath, 'utf8');
  const session = await harbor.fetchModels({ baseUrl: 'https://provider.test', existingProviderId: 'mine', protocol: 'anthropic-messages' });
  const imported = await harbor.importModels({ sessionId: session.sessionId, modelIds: ['old-model', 'new-model'], providerName: 'Ignored rename' });
  assert.equal(imported.added, 1); assert.equal(await fs.readFile(imported.backupPath, 'utf8'), original);
  const saved = JSON.parse(await fs.readFile(configPath, 'utf8')); assert.deepEqual(saved.config.defaultModelSelection, seed().config.defaultModelSelection);
  assert.deepEqual(saved.config.modelConfigRules.providerModelRules[0], seed().config.modelConfigRules.providerModelRules[0]);
  assert.deepEqual(saved.config.providerConfigRules.providerRules[0].config.personalModelIds, ['old-model', 'new-model']);
  assert.deepEqual((await harbor.providers()).providers[0].models, ['old-model', 'new-model']);
  const again =await harbor.importModels({ sessionId: session.sessionId, modelIds: ['new-model'], providerName: 'Mine' }); assert.equal(again.unchanged, true);
  assert.equal((await fs.readdir(path.join(dir, 'backups', 'model-harbor'))).length, 1);
});
test('new supplier gets selected models only, correct protocol and provider order', async t => {
  const { harbor, configPath } = await fixture(t); const s = await harbor.fetchModels({ baseUrl: 'https://new.test/v1', apiKey: 'new-secret', protocol: 'openai-responses' });
  const r = await harbor.importModels({ sessionId: s.sessionId, modelIds: ['new-model'], providerName: 'New API' }); assert.equal(r.created, true);
  const saved = JSON.parse(await fs.readFile(configPath, 'utf8')); const p = saved.config.providerConfigRules.providerRules[1];
  assert.equal(p.config.access.apiKey, 'new-secret'); assert.equal(p.config.api.type, 'openai-responses'); assert.deepEqual(p.config.personalModelIds, ['new-model']); assert.deepEqual(saved.config.providerOrder, ['mine', p.providerId]);
});
test('verified new key updates matching provider without duplicating it', async t => {
  const { harbor, configPath } = await fixture(t); const s = await harbor.fetchModels({ baseUrl: 'https://provider.test', apiKey: 'replacement', protocol: 'anthropic-messages' });
  await harbor.importModels({ sessionId: s.sessionId, modelIds: ['old-model'], providerName: 'Same endpoint' }); const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(saved.config.providerConfigRules.providerRules.length, 1); assert.equal(saved.config.providerConfigRules.providerRules[0].config.access.apiKey, 'replacement');
});
test('invalid selections, expired sessions and incompatible files leave config unchanged', async t => {
  const { harbor, configPath } = await fixture(t); const before = await fs.readFile(configPath, 'utf8'); const s = await harbor.fetchModels({ baseUrl: 'https://new.test', apiKey: 'key' });
  await assert.rejects(harbor.importModels({ sessionId: s.sessionId, modelIds: ['invented'], providerName: 'Name' }));
  harbor.sessions.get(s.sessionId).created = 0; await assert.rejects(harbor.importModels({ sessionId: s.sessionId, modelIds: ['new-model'] }), /过期/);
  assert.equal(await fs.readFile(configPath, 'utf8'), before); await fs.writeFile(configPath, '{"schemaVersion":999}'); await assert.rejects(harbor.providers(), /不兼容/);
});
test('concurrent lock prevents overwriting another operation', async t => {
  const { harbor, configPath } = await fixture(t); const s = await harbor.fetchModels({ baseUrl: 'https://new.test', apiKey: 'key' }); await fs.writeFile(`${configPath}.model-harbor.lock`, '');
  const before = await fs.readFile(configPath, 'utf8'); await assert.rejects(harbor.importModels({ sessionId: s.sessionId, modelIds: ['new-model'] }), /同步/); assert.equal(await fs.readFile(configPath, 'utf8'), before);
  await assert.rejects(harbor.updateProvider({ providerId: 'mine', baseUrl: 'https://provider.test', apiKey: 'other-key' }), /同步/);
  await assert.rejects(harbor.deleteProvider({ providerId: 'mine' }), /同步/); assert.equal(await fs.readFile(configPath, 'utf8'), before);
});
test('a change is dropped when ZCode saves the config while it is being written', async t => {
  const { harbor, configPath, dir } = await fixture(t);
  const zcode = JSON.stringify({ ...seed(), saved: 'by ZCode' }), resolve = harbor.resolvedProvider.bind(harbor);
  harbor.resolvedProvider = async p => { await fs.writeFile(configPath, zcode); return resolve(p); };
  await assert.rejects(harbor.updateProvider({ providerId: 'mine', baseUrl: 'https://moved.test' }), /ZCode 刚刚更新了配置，本次修改已取消/);
  assert.equal(await fs.readFile(configPath, 'utf8'), zcode);
  assert.deepEqual((await fs.readdir(dir)).filter(name => name !== 'backups' && name !== 'cache'), ['provider_config.json'], 'no temporary file or lock is left');
});
test('update_provider changes a listed service\'s address or key with a backup, keeps the key when left empty and never returns it', async t => {
  const { harbor, configPath, dir } = await fixture(t); const original = await fs.readFile(configPath, 'utf8');
  const moved = await callTool(harbor, 'update_provider', { providerId: 'mine', baseUrl: 'https://moved.test/v1/chat/completions', apiKey: '' });
  assert.deepEqual([moved.isError, moved.structuredContent.urlChanged, moved.structuredContent.keyChanged], [undefined, true, false]); assert.ok(!/secret/.test(JSON.stringify(moved)));
  assert.equal(await fs.readFile(moved.structuredContent.backupPath, 'utf8'), original);
  const saved = JSON.parse(await fs.readFile(configPath, 'utf8')), p = saved.config.providerConfigRules.providerRules[0];
  assert.deepEqual(p.config.api, { type: 'anthropic-messages', baseUrl: 'https://moved.test/v1' }); assert.equal(p.config.access.apiKey, 'stored-secret');
  assert.deepEqual(saved.config.modelConfigRules, seed().config.modelConfigRules); assert.deepEqual(saved.config.defaultModelSelection, seed().config.defaultModelSelection);
  const rotated = await callTool(harbor, 'update_provider', { providerId: 'mine', baseUrl: 'https://moved.test/v1', apiKey: ' rotated-secret ' });
  assert.deepEqual([rotated.structuredContent.urlChanged, rotated.structuredContent.keyChanged], [false, true]); assert.ok(!/secret/.test(JSON.stringify(rotated)));
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')).config.providerConfigRules.providerRules[0].config.access, { type: 'api-key', apiKey: 'rotated-secret' });
  const same = await harbor.updateProvider({ providerId: 'mine', baseUrl: 'https://moved.test/v1/', apiKey: 'rotated-secret' });
  assert.equal(same.unchanged, true); assert.equal((await fs.readdir(path.join(dir, 'backups', 'model-harbor'))).length, 2);
});
test('each write keeps the ten newest backups it made and leaves every other file alone', async t => {
  const { harbor, configPath, dir } = await fixture(t), folder = path.join(dir, 'backups', 'model-harbor');
  const days = (year, n) => Array.from({ length: n }, (_, i) => `provider_config-${year}-01-${String(i + 1).padStart(2, '0')}T00-00-00-000Z-0123abcd.json`);
  const listing = async () => (await fs.readdir(folder)).sort(), put = names => Promise.all(names.map(name => fs.writeFile(path.join(folder, name), name)));
  const old = days(2026, 12), others = ['provider_config-mine.json', `${old[0]}.bak`, 'notes.txt'];
  await fs.mkdir(folder, { recursive: true }); await put([...old, ...others]);
  await fs.writeFile(path.join(dir, 'backups', old[0]), 'not ours');
  const first = await harbor.updateProvider({ providerId: 'mine', baseUrl: 'https://moved.test' });
  assert.deepEqual(await listing(), [...others, ...old.slice(3), path.basename(first.backupPath)].sort(), 'the three oldest go');
  // Backups made while the clock ran ahead sort after the one just made, which stays all the same.
  const ahead = days(2999, 10), before = await fs.readFile(configPath, 'utf8'); await put(ahead);
  const second = await harbor.updateProvider({ providerId: 'mine', baseUrl: 'https://provider.test' });
  assert.equal(await fs.readFile(second.backupPath, 'utf8'), before);
  assert.deepEqual(await listing(), [...others, ...ahead.slice(1), path.basename(second.backupPath)].sort());
  // A write without a backup, as deleting a site key, keeps ten too.
  const kept = await listing(); await put(days(2000, 2));
  await harbor.changeConfig(async () => ({}), '', { backup: false });
  assert.deepEqual(await listing(), kept);
  assert.equal(await fs.readFile(path.join(dir, 'backups', old[0]), 'utf8'), 'not ours');
});
test('update_provider refuses bad input, unlisted services and a template service\'s address without touching the config', async t => {
  const { harbor, configPath } = await fixture(t);
  const doc = seed(), rules = doc.config.providerConfigRules.providerRules;
  rules.push({ providerId: 'deepseek', templateId: 'deepseek', providerName: 'DeepSeek', config: { group: 'standard-personal', access: { type: 'api-key', apiKey: 'template-secret' } } });
  rules.push({ providerId: 'other', providerName: '非自定义', config: { group: 'builtin', access: { type: 'api-key', apiKey: 'other-secret' }, api: { type: 'openai-chat-completions', baseUrl: 'https://other.test' } } });
  await fs.writeFile(configPath, JSON.stringify(doc)); const before = await fs.readFile(configPath, 'utf8');
  assert.deepEqual((await harbor.providers()).providers.map(p => [p.id, p.fixedAddress]), [['mine', false], ['deepseek', true]]);
  for (const [args, message] of [[{ providerId: 'mine', baseUrl: 'https://u:p@moved.test' }, /HTTP/], [{ providerId: 'mine', baseUrl: 'https://provider.test', apiKey: 'line\nbreak' }, /格式无效/], [{ providerId: 'mine', baseUrl: 'https://provider.test', apiKey: 42 }, /格式无效/],
    [{ providerId: 'missing', baseUrl: 'https://provider.test' }, /没有找到/], [{ baseUrl: 'https://provider.test' }, /没有找到/], [{ providerId: 'other', baseUrl: 'https://other.test', apiKey: 'x' }, /没有找到/], [{ providerId: 'deepseek', baseUrl: 'https://elsewhere.test' }, /内置模板/]]) {
    const r = await callTool(harbor, 'update_provider', args);
    assert.equal(r.isError, true, JSON.stringify(args)); assert.match(r.content[0].text, message); assert.ok(!/secret/.test(JSON.stringify(r)), JSON.stringify(args));
  }
  assert.equal(await fs.readFile(configPath, 'utf8'), before);
  await harbor.updateProvider({ providerId: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'new-template-secret' });
  const p = JSON.parse(await fs.readFile(configPath, 'utf8')).config.providerConfigRules.providerRules[1];
  assert.equal(p.config.api, undefined, 'the template still supplies the address'); assert.equal(p.config.access.apiKey, 'new-template-secret');
});
test('delete_provider removes a listed service with its order entry and model settings, but not the default model\'s service', async t => {
  const { harbor, configPath } = await fixture(t);
  const other = { providerId: 'other', providerName: '非自定义', config: { group: 'builtin', api: { type: 'openai-chat-completions', baseUrl: 'https://other.test' } } };
  const expected = seed(); expected.config.providerConfigRules.providerRules.push(other);
  const doc = structuredClone(expected), config = doc.config;
  config.providerConfigRules.providerRules.push({ providerId: 'spare', providerName: '备用', config: { group: 'standard-personal', access: { type: 'api-key', apiKey: 'spare-secret' }, api: { type: 'openai-chat-completions', baseUrl: 'https://spare.test' }, personalModelIds: ['s-1'] } });
  config.providerOrder.push('spare');
  config.modelConfigRules.providerModelRules.push({ providerId: 'spare', modelId: 's-1', config: { enabled: true } });
  config.modelConfigRules.manualProviderModelRules.push({ providerId: 'spare', modelId: 's-2', config: { enabled: true } });
  await fs.writeFile(configPath, JSON.stringify(doc)); const before = await fs.readFile(configPath, 'utf8');
  const removed = await callTool(harbor, 'delete_provider', { providerId: 'spare' });
  assert.equal(removed.structuredContent.providerName, '备用'); assert.ok(!/secret/.test(JSON.stringify(removed)));
  assert.equal(await fs.readFile(removed.structuredContent.backupPath, 'utf8'), before);
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), expected);
  const kept = await fs.readFile(configPath, 'utf8');
  for (const args of [{ providerId: 'mine' }, { providerId: 'other' }, { providerId: 'spare' }, {}, undefined]) assert.equal((await callTool(harbor, 'delete_provider', args)).isError, true, JSON.stringify(args));
  assert.match((await callTool(harbor, 'delete_provider', { providerId: 'mine' })).content[0].text, /默认模型/);
  assert.equal(await fs.readFile(configPath, 'utf8'), kept);
  const free = seed(); delete free.config.defaultModelSelection; await fs.writeFile(configPath, JSON.stringify(free));
  await harbor.deleteProvider({ providerId: 'mine' });
  const empty = JSON.parse(await fs.readFile(configPath, 'utf8')).config;
  assert.deepEqual([empty.providerOrder, empty.providerConfigRules.providerRules, empty.modelConfigRules.providerModelRules], [[], [], []]);
});
test('an import fetched before the key was changed in the services list does not write the old key back', async t => {
  const { harbor, configPath } = await fixture(t);
  const stale = await harbor.fetchModels({ baseUrl: 'https://provider.test', existingProviderId: 'mine', protocol: 'anthropic-messages' });
  await harbor.updateProvider({ providerId: 'mine', baseUrl: 'https://provider.test', apiKey: 'rotated-secret' }); const changed = await fs.readFile(configPath, 'utf8');
  await assert.rejects(harbor.importModels({ sessionId: stale.sessionId, modelIds: ['new-model'] }), /原供应商配置已变化/);
  assert.equal(await fs.readFile(configPath, 'utf8'), changed);
  const typed = await harbor.fetchModels({ baseUrl: 'https://provider.test', apiKey: 'typed-secret', existingProviderId: 'mine', protocol: 'anthropic-messages' });
  await harbor.importModels({ sessionId: typed.sessionId, modelIds: ['new-model'] });
  await harbor.importModels({ sessionId: typed.sessionId, modelIds: ['new-model', 'old-model'] });
  assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).config.providerConfigRules.providerRules[0].config.access.apiKey, 'typed-secret', 'the key a session brings may be imported again');
});
test('only the panel tools are callable and unknown names fail without throwing', async () => {
  assert.deepEqual([...TOOL_NAMES].sort(), ['delete_provider', 'fetch_models', 'get_models', 'import_models', 'list_providers', 'reveal_key', 'site_account', 'site_add_group', 'site_delete_key', 'site_login', 'site_logout', 'site_remove_group', 'test_model', 'update_provider']);
  for (const name of ['open_model_harbor', 'nope', undefined]) {
    const r = await callTool(null, name);
    assert.equal(r.isError, true); assert.equal(r.content[0].text, '未知工具。');
  }
});
test('every version field stays in sync and the ZCode plugin form is gone', async () => {
  const project = await readJson('../../package.json'); assert.equal(project.version, VERSION);
  const html = await fs.readFile(path.join(root, 'panel.html'), 'utf8'); assert.ok(html.includes(`v${VERSION}`));
  assert.ok(!html.includes('window.zcode'));
  const exists = rel => fs.stat(path.join(root, rel)).then(() => true, () => false);
  for (const gone of ['../../plugins', '.zcode-plugin', 'server.mjs', 'commands']) assert.equal(await exists(gone), false, gone);
});
test('simplified panel keeps the core flow; models are tested, not tuned', async () => {
  const html = await fs.readFile(path.join(root, 'panel.html'), 'utf8');
  for (const id of ['savedProvider', 'baseUrl', 'apiKey', 'protocol', 'providerName', 'fetchBtn', 'list', 'importBtn', 'status']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /<details id="more">[\s\S]*id="protocol"[\s\S]*id="providerName"[\s\S]*<\/details>/);
  assert.match(html, /id="pickCard" hidden/); assert.match(html, /id="search"[^>]*hidden/);
  // biubiu AI sets no model parameter by hand any more (they are changed in ZCode); 测试 stays, beside each model.
  for (const gone of ['advancedBtn', '调整参数', '还原识别值', 'modelSettings', 'function editor(', 'class="chip']) assert.ok(!html.includes(gone), gone);
  assert.equal(html.split("call('test_model', { sessionId: ").length, 3, 'one 测试 on each page, with the model and nothing else');
  assert.match(html, /line\.append\(row, testLink\(m, '测试', runTest\)\)/);
  for (const removed of ['class="hero"', 'empty-art', 'sourceNames', 'selectedTab', 'MODEL HARBOR']) assert.ok(!html.includes(removed), removed);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]; assert.equal(scripts.length, 1); assert.doesNotThrow(() => new vm.Script(scripts[0][1]));
  for (const tool of TOOL_NAMES) assert.ok(html.includes(`'${tool}'`), tool);
});
test('imported services stay listed with their URL and a masked key that only the eye button reveals', async () => {
  const html = await fs.readFile(path.join(root, 'panel.html'), 'utf8');
  assert.match(html, /id="savedCard" hidden/); assert.match(html, /id="savedList" role="list"/);
  assert.match(html, /<button class="eye" id="toggleKey" type="button" aria-pressed="false"/); assert.match(html, /<template id="eyeIcons">/);
  assert.equal(html.split("call('reveal_key'").length, 2, 'only the eye button asks for a key');
  assert.match(html, /addEventListener\('visibilitychange'/);
});
test('the panel has two pages: the site account first, then connecting a service, picking models and the imported services', async () => {
  const html = await fs.readFile(path.join(root, 'panel.html'), 'utf8');
  const order = ['role="tablist"', 'id="siteTab"', 'id="connectTab"', 'id="sitePage"', 'id="siteCard"', 'id="connectPage"', 'id="connectForm"', 'id="pickCard"', 'id="status"', 'id="savedCard"'].map(marker => html.indexOf(marker));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), JSON.stringify(order));
  assert.match(html, /id="siteTab" type="button" role="tab" aria-selected="true" aria-controls="sitePage"/);
  assert.match(html, /id="connectTab" type="button" role="tab" aria-selected="false" aria-controls="connectPage" tabindex="-1"/);
  assert.match(html, /id="sitePage" role="tabpanel" aria-labelledby="siteTab">/); assert.match(html, /id="connectPage" role="tabpanel" aria-labelledby="connectTab" hidden>/);
  assert.match(html, /\nhtml\{overflow-anchor:none\}\n/, 'scroll anchoring stays off: with a focused tab stuck at the top it throws the panel to its top or bottom');

  // The page code runs against stand-ins for the tabs, the pages, the header above the tabs and the window's scroll.
  const start = html.indexOf('  const PAGES = '), keys = html.indexOf("$('pageTabs').addEventListener('keydown'"), end = html.indexOf('\n  });\n', keys) + 6;
  // blank collects every moment with no page shown, even between two statements: a layout then pulls a scrolled panel to its top.
  const els = {}, scrolls = [], blank = [];
  const node = id => {
    let hidden = id === 'connectPage';
    return { id, tabIndex: 0, attrs: {}, listeners: {}, setAttribute(k, v) { this.attrs[k] = String(v); }, addEventListener(type, f) { this.listeners[type] = f; }, focus() { ctx.focused = id; },
      get hidden() { return hidden; }, set hidden(value) { hidden = value; if (els.sitePage?.hidden && els.connectPage?.hidden) blank.push(id); } };
  };
  for (const id of ['pageTabs', 'siteTab', 'connectTab', 'sitePage', 'connectPage']) els[id] = node(id);
  const ctx = { page: 'site', siteMissing: false, scrollY: 0, focused: null, $: id => els[id], scrollTo: (x, y) => { scrolls.push(y); ctx.scrollY = y; },
    document: { querySelector: () => ({ getBoundingClientRect: () => ({ bottom: 200 - ctx.scrollY }) }) } };
  vm.runInNewContext(html.slice(start, end), ctx);
  const shown = () => [ctx.page, els.siteTab.attrs['aria-selected'], els.connectTab.attrs['aria-selected'], els.sitePage.hidden, els.connectPage.hidden, els.siteTab.tabIndex, els.connectTab.tabIndex];
  els.connectTab.onclick();
  assert.deepEqual(shown(), ['connect', 'false', 'true', true, false, -1, 0]); assert.deepEqual(scrolls, [], 'with the header in sight the panel does not scroll');
  ctx.scrollY = 900; els.siteTab.onclick();
  assert.deepEqual(shown(), ['site', 'true', 'false', false, true, 0, -1]); assert.deepEqual(scrolls, [200], 'scrolled past the header, the page opens at its top, under the tabs');
  const press = key => { let prevented = false; els.pageTabs.listeners.keydown({ key, preventDefault() { prevented = true; } }); return prevented; };
  assert.equal(press('ArrowRight'), true); assert.deepEqual([ctx.page, ctx.focused], ['connect', 'connectTab']);
  assert.equal(press('ArrowRight'), true); assert.equal(ctx.page, 'site', 'the arrows wrap around');
  press('End'); assert.equal(ctx.page, 'connect'); press('Home'); assert.equal(ctx.page, 'site');
  press('ArrowLeft'); assert.equal(ctx.page, 'connect', 'so does the left arrow'); assert.equal(press('Enter'), false);
  ctx.noSite();
  assert.deepEqual([els.pageTabs.hidden, ...shown()], [true, 'connect', 'false', 'true', true, false, -1, 0], 'without a site account only the connect page is left, without tabs');
  els.siteTab.onclick(); assert.equal(ctx.page, 'connect');
  assert.deepEqual(blank, [], 'a page hides only after the other one shows');

  // A site key's models open on the site page itself and never on the connect page; problems on the site page are
  // reported there, not in the status line, which belongs to the connect page.
  const source = name => { const at = html.search(new RegExp(`\\n  (async )?function ${name}\\(`)) + 1; assert.ok(at > 0, name); return html.slice(at, html.indexOf('\n  }\n', at)); };
  for (const name of ['siteKeyItem', 'keyModels', 'openPick', 'addPicked', 'deleteKey']) assert.doesNotMatch(source(name), /showPage|connectForm|savedProvider|(?<![A-Za-z])status\(/, name);
  assert.ok(!html.includes("showPage('connect'") && !html.includes('useSiteKey'), 'nothing moves a site key to the connect page');
  assert.match(source('siteKeyItem'), /\{ siteKeyId: k\.id \}, siteFailed\)/);
  const failed = html.split('\n').find(line => line.includes('async function siteFailed(')), logout = html.slice(html.indexOf("$('siteLogout').onclick"), html.indexOf('\n  };\n', html.indexOf("$('siteLogout').onclick")));
  for (const code of [failed, logout]) { assert.ok(code.includes('siteProblem('), code); assert.ok(!code.includes('status('), code); }
});
test('while the panel is shown and signed in, the balance alone is read every 30 seconds; hiding the panel stops it', async () => {
  const html = await fs.readFile(path.join(root, 'panel.html'), 'utf8');
  const source = name => { const at = html.search(new RegExp(`\\n  (async )?function ${name}\\(`)) + 1; assert.ok(at > 0, name); return html.slice(at, html.indexOf('\n  }\n', at) + 4); };
  // Every place that changes the account or the panel's state goes through watchBalance, which keeps one timer at most.
  assert.match(source('renderSite'), /^ {2}function renderSite\(\) \{\n {4}\$\('siteLoading'\)\.hidden = !!site;\n {4}watchBalance\(\);/);
  assert.match(source('loadSite'), /const seq = \+\+siteSeq; balanceAt = Date\.now\(\);[\s\S]*siteAt = balanceAt = Date\.now\(\);[\s\S]*renderSite\(\)/);
  assert.match(html, /call\('site_login'[^\n]*siteAt = balanceAt = Date\.now\(\)/);
  assert.match(html, /let shown = !document\.hidden,/);
  assert.match(html, /webview\.postMessage\('hide'\); webview\.postMessage\('ready'\); \}/, 'the page asks the host whether the panel is shown once it listens');
  assert.equal(html.split("call('site_account', { balanceOnly: true })").length, 2);

  const els = {}, timers = new Map(), calls = [], answers = [];
  const $ = id => els[id] ||= { id, value: '', textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); }, replaceChildren(...n) { this.children = n; } };
  const account = balance => ({ signedIn: true, site: { name: 'biubiu AI', host: 'ro.biubiu007.com' }, email: 'user@example.com', balance, totalRecharged: 100 });
  const ctx = {
    $, el: (tag, cls, text) => ({ tag, text }), money: n => typeof n === 'number' ? n.toFixed(2) : '—', BALANCE_EVERY: 30000,
    shown: true, bridge: () => {}, site: null, siteSeq: 0, siteAt: 0, asking: null, balanceTimer: 0, balanceAt: 0, balanceReading: false,
    now: 1000, Date: { now: () => ctx.now }, nextTimer: 1,
    setTimeout: (f, ms) => { const id = ctx.nextTimer++; timers.set(id, { f, at: ctx.now + ms }); return id; }, clearTimeout: id => { timers.delete(id); },
    call: (name, args) => { calls.push([name, args]); const next = answers.shift(); return next instanceof Error ? Promise.reject(next) : Promise.resolve(next); },
    loads: [], loadProviders() { ctx.loads.push('providers'); }, loadSite(force) { ctx.loads.push(`site ${force}`); },
    renders: 0, renderSite() { ctx.renders++; ctx.watchBalance(); if (ctx.site) ctx.renderBalance(); }, hideKey() {}, renderServices() {}, updateControls() {},
  };
  vm.runInNewContext(['renderBalance', 'watchBalance', 'readBalance', 'panelShown'].map(source).join('\n'), ctx);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const wait = async ms => { ctx.now += ms; for (const [id, t] of [...timers]) if (t.at <= ctx.now) { timers.delete(id); t.f(); } await settle(); };
  const shownBalance = () => [els.siteBalance?.textContent, els.siteTabNote?.textContent, els.siteTab?.attrs['aria-label']];

  // A full read at 1000 brought the account; the balance alone follows 30 seconds later, and only it is redrawn.
  ctx.site = { ...account(10), keys: ['kept'] }; ctx.balanceAt = 1000; ctx.renderSite();
  assert.equal(timers.size, 1);
  await wait(29999); assert.deepEqual(calls, [], 'nothing before 30 seconds');
  answers.push(account(9.5)); await wait(1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['site_account', { balanceOnly: true }]], 'made in the page, so compared as JSON');
  assert.deepEqual(shownBalance(), ['9.50', '9.50', 'biubiu AI，余额 9.50']);
  assert.deepEqual([ctx.site.keys, ctx.renders, timers.size], [['kept'], 1, 1], 'the keys and groups are not read or redrawn, and one timer is left');
  answers.push(account(9)); await wait(30000);
  assert.equal(calls.length, 2); assert.equal(shownBalance()[0], '9.00');

  // Hiding the panel stops it; showing it again re-reads what it re-read before, and the balance at once when it is due.
  ctx.panelShown(false);
  assert.equal(timers.size, 0); await wait(120000); assert.equal(calls.length, 2, 'nothing while hidden');
  answers.push(account(8)); ctx.panelShown(true);
  assert.deepEqual(ctx.loads, ['providers', 'site false']);
  await wait(0); assert.equal(calls.length, 3); assert.equal(shownBalance()[0], '8.00');
  ctx.panelShown(true); assert.deepEqual(ctx.loads, ['providers', 'site false'], 'the host saying the panel is shown again changes nothing');
  assert.equal(timers.size, 1);

  // A failed read keeps the last balance in sight and tries again 30 seconds later.
  answers.push({ ...account(null), error: '余额读取失败：上游余额同步失败' }); await wait(30000);
  answers.push(new Error('biubiu AI 本地服务连接失败')); await wait(30000);
  assert.equal(calls.length, 5); assert.equal(shownBalance()[0], '8.00'); assert.equal(timers.size, 1);

  // One read at a time; a full read, a login or a logout that starts meanwhile wins over it.
  let answer; answers.push(new Promise(resolve => { answer = resolve; }));
  ctx.call = (name, args) => { calls.push([name, args]); return answers.shift(); };
  await wait(30000); assert.equal(calls.length, 6);
  ctx.renderSite(); await wait(60000); assert.equal(calls.length, 6, 'no second read while one is under way');
  ctx.siteSeq++; ctx.site = account(50); answer(account(1)); await settle();
  assert.equal(ctx.site.balance, 50); assert.equal(timers.size, 1);

  // A lost sign-in turns the site page into the login form, and the timer stops.
  const renders = ctx.renders;
  answers.push(Promise.resolve({ signedIn: false, site: { name: 'biubiu AI' }, expired: true })); await wait(30000);
  assert.deepEqual([ctx.site.signedIn, ctx.site.expired, ctx.renders, timers.size], [false, true, renders + 1, 0]);
  assert.deepEqual(shownBalance().slice(1), ['未登录', 'biubiu AI，未登录']);
  await wait(120000); assert.equal(calls.length, 7);
});
test('a group row adds with its own key at once, asks in the row before a key is made on the site, and deletes only after 确认删除', async () => {
  const html = await fs.readFile(path.join(root, 'panel.html'), 'utf8');
  const start = html.indexOf('  function groupRow('), source = html.slice(start, html.indexOf('\n  }\n', start) + 4), ask = html.split('\n').find(line => line.startsWith('  function openAsk('));
  const node = tag => ({ tag, children: [], attrs: {}, dataset: {}, append(...n) { this.children.push(...n); }, setAttribute(k, v) { this.attrs[k] = String(v); } });
  const el = (tag, cls, text) => { const n = node(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const all = (n, match) => [...(match(n) ? [n] : []), ...n.children.flatMap(c => typeof c === 'object' ? all(c, match) : [])];
  const button = (n, text) => all(n, c => c.tag === 'button' && c.textContent === text)[0];
  const calls = [], renders = [], statuses = [];
  const ctx = { el, busy: false, bridge: () => {}, asking: null, groupOutcome: null, renderGroups: focus => renders.push(focus), siteStatus: text => { statuses.push(text); ctx.groupOutcome = null; },
    addGroup: (g, createKey) => calls.push(['add', g.id, createKey]), removeGroup: g => calls.push(['remove', g.id]) };
  vm.runInNewContext(`${source}\n${ask}`, ctx);
  const ready = { id: '1', name: 'gpt-plus', platformName: 'GPT', multiplier: 0.3, hasUsableKey: true };
  const row = ctx.groupRow(ready);
  assert.equal(all(row, c => c.className === 'grate')[0].textContent, '×0.3');
  button(row, '添加').onclick();
  assert.deepEqual(calls, [['add', '1', false]], 'a group with a working key is added at once, and no key is made');
  const bare = { id: '2', name: 'grok-heavy', platformName: 'Grok', multiplier: 0.3, hasUsableKey: false };
  button(ctx.groupRow(bare), '添加').onclick();
  assert.deepEqual([{ ...ctx.asking }, renders.at(-1), calls.length], [{ id: '2', kind: 'key' }, '2:cancel', 1], 'it asks in the row first, with 取消 focused');
  let asked = ctx.groupRow(bare);
  assert.match(all(asked, c => c.className === 'svcask')[0].textContent, /「grok-heavy」还没有可用的 Key。要在网站上为它新建一个 Key（不限额度、不过期）/);
  button(asked, '取消').onclick();
  assert.deepEqual([ctx.asking, renders.at(-1), calls.length], [null, '2:action', 1], '取消 makes nothing and goes back to 添加');
  button(ctx.groupRow(bare), '添加').onclick(); button(ctx.groupRow(bare), '新建 Key 并添加').onclick();
  assert.deepEqual(calls.at(-1), ['add', '2', true], 'createKey only from the question\'s own button');
  const held = { id: '3', name: 'ccmax满血', platformName: 'Claude', multiplier: 1.6, hasUsableKey: true, inZCode: [{ name: 'biubiu AI · ccmax满血', modelCount: 4 }] };
  asked = ctx.groupRow(held);
  assert.equal(asked.className, 'grow on'); assert.equal(button(asked, '添加'), undefined);
  assert.deepEqual([all(asked, c => c.className === 'gnote')[0].textContent, all(asked, c => c.className === 'gnote')[0].title], ['已加入 ZCode · 4 个模型', 'ZCode 里的「biubiu AI · ccmax满血」']);
  button(asked, '删除').onclick();
  assert.deepEqual({ ...ctx.asking }, { id: '3', kind: 'delete' }); assert.equal(calls.length, 2, 'nothing is deleted before 确认删除');
  button(ctx.groupRow(held), '确认删除').onclick();
  assert.deepEqual(calls.at(-1), ['remove', '3']);
  // 补全 adds at once what ZCode lacks of a group it has, with no key made; without a working key there is nothing to
  // add it with, and only 删除 is left.
  ctx.asking = null;
  assert.deepEqual(all(ctx.groupRow(held), c => c.tag === 'button').map(b => b.textContent), ['补全', '删除']);
  button(ctx.groupRow(held), '补全').onclick();
  assert.deepEqual(calls.at(-1), ['add', '3', false]);
  assert.deepEqual(all(ctx.groupRow({ ...held, hasUsableKey: false }), c => c.tag === 'button').map(b => b.textContent), ['删除']);
  // A change's outcome shows in its own row, where the user clicked, and nowhere else; asking in that row clears it.
  const outcome = n => all(n, c => c.className === 'note' || c.className === 'note fail').map(c => [c.className, c.textContent]);
  ctx.groupOutcome = { id: '1', text: '已添加分组「gpt-plus」：2 个模型加入 ZCode「biubiu AI · gpt-plus」。', error: false };
  assert.deepEqual(outcome(ctx.groupRow(ready)), [['note', ctx.groupOutcome.text]]);
  assert.deepEqual(outcome(ctx.groupRow(bare)), []);
  ctx.groupOutcome = { id: '2', text: '「grok-heavy」还没有可用的 Key，需要先在网站上新建一个。', error: true };
  assert.deepEqual(outcome(ctx.groupRow(bare)), [['note fail', ctx.groupOutcome.text]]);
  button(ctx.groupRow(bare), '添加').onclick();
  assert.deepEqual([statuses.at(-1), ctx.groupOutcome, outcome(ctx.groupRow(bare))], ['', null, []], 'a new question clears the last outcome');
  const gemini ={ id: '4', name: 'Gemini Pro', platformName: 'Gemini', multiplier: 0.5, hasUsableKey: true, blocked: 'ZCode 暂不支持 Gemini 原生接口，不能添加这个分组。' };
  const blocked = ctx.groupRow(gemini);
  assert.deepEqual(all(blocked, c => c.tag === 'button'), [], 'a Gemini group has no button'); assert.match(all(blocked, c => c.className === 'gnote')[0].textContent, /Gemini/);
  for (const tool of ['site_add_group', 'site_remove_group']) assert.equal(html.split(`call('${tool}'`).length, 2, tool);
});
test('the group list is called empty only when the site could be read, and a change\'s outcome shows in its row, under the list only when the row is gone', async () => {
  const html = await fs.readFile(path.join(root, 'panel.html'), 'utf8');
  const source = name => { const at = html.search(new RegExp(`\\n  (async )?function ${name}\\(`)) + 1; assert.ok(at > 0, name); return html.slice(at, html.indexOf('\n  }\n', at) + 4); };
  const all = (n, match) => [...(match(n) ? [n] : []), ...n.children.flatMap(c => all(c, match))];
  const node = tag => {
    const n = { tag, children: [], attrs: {}, dataset: {}, style: {}, hidden: false, classes: new Set(), className: '',
      append(...c) { for (const x of c) x.parent = n; n.children.push(...c); }, replaceChildren(...c) { for (const x of c) x.parent = n; n.children = c; },
      setAttribute(k, v) { n.attrs[k] = String(v); }, remove() { n.parent.children = n.parent.children.filter(c => c !== n); },
      querySelector(selector) { const cls = /^\.([\w-]+)$/.exec(selector)?.[1]; return cls ? all(n, c => c !== n && c.className.split(' ').includes(cls))[0] || null : null; } };
    n.classList = { toggle(c, on) { if (on) n.classes.add(c); else n.classes.delete(c); } };
    return n;
  };
  const el = (tag, cls, text) => { const n = node(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const els = { siteGroupsPart: node('div'), siteGroupCount: node('span'), siteGroups: node('div'), siteStatus: node('div') };
  const ctx = { el, $: id => els[id], CSS: { escape: s => s }, window: {}, busy: false, bridge: () => {}, asking: null, groupOutcome: null, site: null, addGroup() {}, removeGroup() {} };
  vm.runInNewContext(['renderGroups', 'groupRow', 'openAsk', 'siteStatus'].map(source).join('\n'), ctx);
  const texts = n => all(n, c => c.textContent !== undefined && !c.children.length).map(c => c.textContent);
  const groups = [{ id: '1', name: 'gpt-plus', platformName: 'GPT', hasUsableKey: true }, { id: '2', name: 'claude-max', platformName: 'Claude', hasUsableKey: true }];

  // A site that could not be read is no answer about the account's groups: no 还没有可用的分组 then.
  ctx.site = { signedIn: true, error: 'biubiu AI 网站暂时出错（HTTP 500），请稍后重试。', groups: [] }; ctx.renderGroups();
  assert.deepEqual(els.siteGroups.children, []);
  ctx.site = { signedIn: true, groups: [] }; ctx.renderGroups();
  assert.deepEqual(texts(els.siteGroups), ['这个账户还没有可用的分组。']);

  // The outcome of a change shows in its row; the line under the list keeps it for screen readers, off screen.
  ctx.site = { signedIn: true, groups };
  ctx.siteStatus('已添加分组「gpt-plus」：2 个模型加入 ZCode「biubiu AI · gpt-plus」。', false, '1'); ctx.renderGroups();
  const row = id => all(els.siteGroups, c => c.className.startsWith('grow') && c.children.some(m => all(m, x => x.className === 'gname' && x.textContent === groups.find(g => g.id === id).name).length))[0];
  assert.ok(texts(row('1')).includes(ctx.groupOutcome.text)); assert.ok(!texts(row('2')).includes(ctx.groupOutcome.text));
  assert.deepEqual([els.siteStatus.textContent, els.siteStatus.style.display, els.siteStatus.classes.has('aside')], [ctx.groupOutcome.text, 'block', true]);
  // A failure that empties the list shows under it instead, unless the error above the list says the same.
  ctx.siteStatus('「gpt-plus」还没有可用的 Key，需要先在网站上新建一个。', true, '1');
  ctx.site = { signedIn: true, error: 'biubiu AI 网站暂时出错（HTTP 500），请稍后重试。', groups: [] }; ctx.renderGroups();
  assert.deepEqual([els.siteStatus.classes.has('aside'), els.siteStatus.classes.has('error'), els.siteStatus.style.display], [false, true, 'block']);
  ctx.siteStatus(ctx.site.error, true, '1'); ctx.renderGroups();
  assert.deepEqual([els.siteStatus.classes.has('aside'), els.siteStatus.textContent], [true, ctx.site.error], 'said once on screen, still heard');
  // A new action clears the outcome, in its row too.
  ctx.site = { signedIn: true, groups }; ctx.siteStatus('已从 ZCode 删除分组「gpt-plus」的 2 个模型。', false, '1'); ctx.renderGroups();
  assert.equal(all(els.siteGroups, c => c.className === 'gask goutcome').length, 1);
  ctx.siteStatus('');
  assert.deepEqual([ctx.groupOutcome, all(els.siteGroups, c => c.className === 'gask goutcome').length, els.siteStatus.style.display], [null, 0, 'none']);
});
test('a site key\'s models open under it on the site page and are added from there; 删除 asks in its row before the key leaves the site', async () => {
  const html = await fs.readFile(path.join(root, 'panel.html'), 'utf8');
  const source = name => { const at = html.search(new RegExp(`\\n  (async )?function ${name}\\(`)) + 1; assert.ok(at > 0, name); return html.slice(at, html.indexOf('\n  }\n', at) + 4); };
  const all = (n, match) => [...(match(n) ? [n] : []), ...n.children.flatMap(c => all(c, match))];
  let focused = null;
  const node = tag => ({ tag, children: [], attrs: {}, dataset: {}, style: {}, hidden: false, disabled: false, classList: { toggle() {} },
    append(...n) { this.children.push(...n); }, replaceChildren(...n) { this.children = n; }, setAttribute(k, v) { this.attrs[k] = String(v); }, focus() { focused = this; }, scrollIntoView() {},
    querySelectorAll() { return all(this, c => c.tag === 'input'); }, querySelector(selector) { const wanted = /data-focus="([^"]+)"/.exec(selector)[1]; return all(this, c => c.dataset.focus === wanted)[0] || null; } });
  const el = (tag, cls, text) => { const n = node(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const els = { siteKeys: node('div'), siteKeyCount: node('span'), siteKeyStatus: node('div') };
  const calls = [], loads = [], answers = {}, settle = () => new Promise(resolve => setImmediate(resolve));
  const keys = [
    { id: '7', name: 'Key 7', group: 'Claude 组', platformName: 'Claude', statusLabel: '正常', hasKey: true, baseUrl: 'https://ro.biubiu007.com', protocol: 'anthropic-messages', blocked: '', testKey: false },
    { id: '8', name: 'hub-ptest-g:71', group: 'Claude 组', platformName: 'Claude', statusLabel: '正常', hasKey: true, baseUrl: 'https://ro.biubiu007.com', protocol: 'anthropic-messages', blocked: '', testKey: true },
    { id: '9', name: 'Gemini', group: 'Gemini 组', platformName: 'Gemini', statusLabel: '正常', hasKey: true, baseUrl: 'https://ro.biubiu007.com/v1', protocol: 'openai-chat-completions', blocked: 'ZCode 暂不支持 Gemini 原生接口，这个 Key 只能查看。', testKey: false },
  ];
  // No showPage, connect form or status line here: touching any of them throws.
  const ctx = { el, $: id => els[id], CSS: { escape: s => s }, MASK: '•', window: {}, busy: false, action: '', bridge: () => {}, pick: null, keyAsking: null,
    site: { signedIn: true, site: { name: 'biubiu AI', origin: 'https://ro.biubiu007.com' }, keys, groups: [] },
    money: String, hostname: () => 'ro.biubiu007.com', keyEye: () => node('span'), siteFailed() {}, groupStatus: [], siteStatus: text => ctx.groupStatus.push(text), describe: v => v.contextWindow ? `上下文 ${v.contextWindow}` : '未识别参数',
    setBusy(value, kind = '') { ctx.busy = value; ctx.action = value ? kind : ''; }, loadSite: async () => { loads.push('site'); }, loadProviders: async () => { loads.push('providers'); },
    call: async (name, args) => { calls.push([name, JSON.parse(JSON.stringify(args))]); const answer = answers[name]; if (answer instanceof Error) throw answer; return structuredClone(answer); } };
  vm.runInNewContext(['renderKeys', 'siteKeyItem', 'keyAsk', 'keyModels', 'addButton', 'allModels', 'openPick', 'closePick', 'addPicked', 'testPicked', 'askKey', 'deleteKey', 'keyStatus', 'testLink', 'testNote'].map(source).join('\n'), ctx);
  const item = i => els.siteKeys.children[i], button = (n, text) => all(n, c => c.tag === 'button' && c.textContent === text)[0];
  const buttons = n => all(n, c => c.tag === 'button').map(b => b.textContent), ticks = () => all(item(0), c => c.type === 'checkbox').map(t => [t.dataset.id, t.checked, t.disabled]);
  const picker = () => all(item(0), c => c.className === 'keypick')[0], text = (n, cls) => all(n, c => c.className === cls).map(c => c.textContent);

  ctx.renderKeys();
  assert.deepEqual([buttons(item(0)), buttons(item(1)), buttons(item(2))], [['删除', '添加到 ZCode'], ['添加到 ZCode'], ['删除']], 'a test key has no 删除, a key ZCode cannot use no models');
  assert.equal(text(item(2), 'note')[0], keys[2].blocked);

  // 添加到 ZCode reads the key's models by its id alone and lists them under it, on this page.
  answers.fetch_models = { sessionId: 's1', count: 3, nextOffset: null, models: [{ id: 'model-a', metadata: { contextWindow: 200000 }, inZCode: true }, { id: 'model-b', metadata: {} }, { id: 'model-c', metadata: {} }] };
  button(item(0), '添加到 ZCode').onclick();
  assert.deepEqual([ctx.busy, text(picker(), 'empty'), buttons(item(0))], [true, ['正在读取模型…'], ['删除', '正在读取…']]);
  await settle();
  assert.deepEqual(calls, [['fetch_models', { baseUrl: 'https://ro.biubiu007.com', protocol: 'anthropic-messages', siteKeyId: '7' }]], 'no key and no saved service go with it');
  assert.deepEqual([ctx.busy, focused.textContent, focused.attrs['aria-expanded'], focused.attrs['aria-controls']], [false, '收起', 'true', 'keyPick']);
  assert.equal(text(picker(), 'found')[0], '找到 3 个，1 个已在 ZCode，勾选要添加的模型');
  assert.deepEqual(ticks(), [['model-a', true, true], ['model-b', false, false], ['model-c', false, false]], 'a model already in ZCode stays ticked and cannot be unticked');
  assert.equal(text(picker(), 'meta')[0], '已在 ZCode · 上下文 200000');
  // 测试 beside a model sends one short request for it, and its outcome stays under the model.
  answers.test_model = { modelId: 'model-b', ok: true, elapsedMs: 1200 };
  all(item(0), c => c.attrs['aria-label'] === '测试 model-b')[0].onclick(); await settle();
  assert.deepEqual(calls.at(-1), ['test_model', { sessionId: 's1', modelId: 'model-b' }]);
  assert.deepEqual([text(picker(), 'testnote pass'), focused.dataset.focus, ctx.busy], [['✓ 可以正常调用（1.2 秒）'], '7:test:model-b', false]);
  const add = () => all(item(0), c => c.className === 'primary')[0];
  assert.deepEqual([add().textContent, add().disabled], ['添加到 ZCode', true]);
  button(item(0), '全选').onclick(); assert.equal(add().textContent, '添加到 ZCode（2 个）'); assert.equal(button(item(0), '取消全选').textContent, '取消全选');
  button(item(0), '取消全选').onclick(); assert.equal(add().disabled, true);
  const tick = all(item(0), c => c.type === 'checkbox')[1]; tick.checked = true; tick.onchange();
  assert.deepEqual([add().textContent, add().disabled, focused.dataset.id], ['添加到 ZCode（1 个）', false, 'model-b'], 'a tick keeps the focus on its model');

  // The ticked models go to the key's own service; the list stays open with them in ZCode.
  answers.import_models = { added: 1, providerName: 'biubiu AI · Key 7', created: true };
  add().onclick(); await settle();
  assert.deepEqual(calls.at(-1), ['import_models', { sessionId: 's1', modelIds: ['model-b'], providerName: 'biubiu AI · Key 7' }]);
  assert.deepEqual(loads, ['site', 'providers'], 'the account and the services are read again');
  assert.deepEqual(ticks(), [['model-a', true, true], ['model-b', true, true], ['model-c', false, false]]);
  assert.match(text(picker(), 'note').join(' '), /已把 1 个模型添加到「biubiu AI · Key 7」/);
  button(item(0), '收起').onclick();
  assert.deepEqual([ctx.pick, picker(), focused.textContent], [null, undefined, '添加到 ZCode']);

  // 删除 asks in the row; 取消 deletes nothing, 确认删除 deletes the key on the site and its services in ZCode.
  calls.length = 0; loads.length = 0;
  button(item(0), '删除').onclick();
  assert.match(text(item(0), 'svcask')[0], /^删除站内 Key「Key 7」？网站上的这个 Key 会一起删除，之后不能再用。$/); assert.equal(focused.textContent, '取消');
  button(item(0), '取消').onclick();
  assert.deepEqual([ctx.keyAsking, text(item(0), 'svcask'), focused.textContent, calls], [null, [], '删除', []], 'nothing is deleted before 确认删除');
  keys[0].inZCode = 'biubiu AI · Key 7';
  button(item(0), '删除').onclick();
  assert.match(text(item(0), 'svcask')[0], /网站上的这个 Key 会一起删除，之后不能再用；ZCode 里使用它的「biubiu AI · Key 7」也会删除。$/, 'deleting a key keeps no backup');
  answers.site_delete_key = new Error('「biubiu AI · Key 7」还在被 ZCode 的默认模型或其他设置使用，网站上的 Key 和 ZCode 里的服务都没有删除。请先在 ZCode 里换成其他服务的模型，再删除。');
  button(item(0), '确认删除').onclick(); await settle();
  assert.deepEqual(calls, [['site_delete_key', { siteKeyId: '7' }]]);
  assert.deepEqual([text(item(0), 'note fail')[0], focused.textContent, ctx.busy], [answers.site_delete_key.message, '取消', false], 'a refusal stays in the question');
  answers.site_delete_key = { siteKeyId: '7', keyName: 'Key 7', removed: ['biubiu AI · Key 7'], models: 2 };
  button(item(0), '确认删除').onclick(); await settle();
  assert.deepEqual([ctx.keyAsking, els.siteKeyStatus.textContent, els.siteKeyStatus.style.display], [null, '已删除站内 Key「Key 7」，并从 ZCode 删除了「biubiu AI · Key 7」。', 'block']);
  assert.deepEqual(loads, ['site', 'providers', 'site', 'providers']);
  assert.deepEqual(ctx.groupStatus, ['', '', ''], 'each key action clears the last group outcome, so only the newest shows');

  // Models that cannot be read say why under the key, with 重试.
  answers.fetch_models = new Error('接口拒绝访问（401），请检查 API Key 和模型列表权限。');
  button(item(0), '选择模型').onclick(); await settle();
  assert.deepEqual([text(picker(), 'note fail'), buttons(picker())], [[answers.fetch_models.message], ['重试']]);
  assert.equal(els.siteKeyStatus.style.display, 'none', 'a new action clears the last outcome');
  // More than eight models get a search box over them.
  answers.fetch_models = { sessionId: 's2', count: 9, nextOffset: null, models: Array.from({ length: 9 }, (_, i) => ({ id: i ? `gpt-${i}` : 'claude-x', metadata: {} })) };
  button(item(0), '重试').onclick(); await settle();
  const search = all(picker(), c => c.tag === 'input' && c.type === 'search')[0];
  search.value = 'claude'; search.oninput();
  assert.deepEqual(ticks().map(([id]) => id), ['claude-x']);
  assert.equal(html.split("call('site_delete_key'").length, 2);
});
test('an imported service shows its model names on click, without a request, and keeps them open across re-renders', async () => {
  const html = await fs.readFile(path.join(root, 'panel.html'), 'utf8');
  const start = html.indexOf('  function serviceItem('), source = html.slice(start, html.indexOf('\n  }\n', start) + 4);
  const node = tag => ({ tag, children: [], attrs: {}, append(...n) { this.children.push(...n); }, setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; } });
  const el = (tag, cls, text) => { const n = node(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const calls = [], changes = [], openModels = new Set(), find = (n, tag) => n.tag === tag ? n : n.children.map(c => find(c, tag)).find(Boolean);
  const serviceChanges = p => { changes.push(p.id); return node('div'); };
  const serviceItem = vm.runInNewContext(`(${source.trim()})`, { el, openModels, serviceChanges, MASK: '•', call: async name => { calls.push(name); return {}; } });
  const p = { id: 'svc', name: '服务', baseUrl: 'https://svc.test/v1', hasKey: false, modelCount: 2, models: ['m-2', 'm-1'] };
  let item = serviceItem(p, 0), toggle = find(item, 'button'), list = find(item, 'ul');
  assert.equal(toggle.textContent, '2 个模型'); assert.equal(toggle.attrs['aria-expanded'], 'false'); assert.equal(toggle.attrs['aria-controls'], list.id); assert.equal(list.hidden, true);
  assert.deepEqual(list.children.map(li => li.textContent), ['m-2', 'm-1']);
  toggle.onclick(); assert.equal(toggle.attrs['aria-expanded'], 'true'); assert.equal(list.hidden, false);
  item = serviceItem(p, 0); assert.equal(find(item, 'ul').hidden, false, 'still open after the list is rebuilt');
  find(item, 'button').onclick(); assert.equal(find(item, 'ul').hidden, true); assert.equal(openModels.size, 0);
  const older = serviceItem({ ...p, models: undefined }, 0);
  assert.equal(find(older, 'button'), undefined); assert.equal(find(older, 'ul'), undefined, 'a server without model names leaves the count as text');
  assert.deepEqual(changes, ['svc', 'svc'], 'nor does it get 修改 / 删除, which that server cannot do');
  assert.deepEqual(calls, []);
});
test('a service is changed or deleted from its own item: the key field starts empty and deleting asks first', async () => {
  const html = await fs.readFile(path.join(root, 'panel.html'), 'utf8');
  const start = html.indexOf('  function serviceChanges('), source = html.slice(start, html.indexOf('\n  }\n', start) + 4);
  let focused = null;
  const node = tag => ({ tag, children: [], attrs: {}, dataset: {}, hidden: false, disabled: false, isConnected: true, value: '', append(...n) { this.children.push(...n); }, replaceChildren(...n) { this.children = n; }, setAttribute(k, v) { this.attrs[k] = String(v); }, focus() { focused = this; } });
  const el = (tag, cls, text) => { const n = node(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const all = (n, match) => [...(match(n) ? [n] : []), ...n.children.flatMap(c => all(c, match))];
  const button = (n, text) => all(n, c => c.tag === 'button' && c.textContent === text)[0];
  const settle = () => new Promise(resolve => setImmediate(resolve)), submit = form => form.onsubmit({ preventDefault() {} });
  const calls = [], statuses = [];
  const ctx = { el, busy: false, openModels: new Set(['svc']), window: {}, $: () => ({ value: '' }), eyeIcons: () => node('svg'), eye: (b, shown) => b.setAttribute('aria-pressed', String(shown)),
    status: text => statuses.push(text), render() {}, pickSaved() {}, setBusy: value => { ctx.busy = value; }, loadProviders: async () => { calls.push(['list_providers']); },
    call: async (name, args) => { calls.push([name, { ...args }]); return { providerName: '服务', keyChanged: true }; } };
  const serviceChanges = vm.runInNewContext(`(${source.trim()})`, ctx);
  const p = { id: 'svc', name: '服务', baseUrl: 'https://svc.test/v1', hasKey: true, fixedAddress: false, modelCount: 2 };

  const foot = serviceChanges(p, 0, node('dl'));
  assert.deepEqual(foot.children.map(b => [b.textContent, b.attrs['aria-label']]), [['修改', '修改「服务」'], ['删除', '删除「服务」']]);
  button(foot, '删除').onclick();
  assert.match(all(foot, c => c.className === 'svcask')[0].textContent, /删除「服务」和它的 2 个模型/); assert.equal(focused, button(foot, '取消'));
  button(foot, '取消').onclick(); assert.equal(button(foot, '确认删除'), undefined); assert.equal(focused, button(foot, '删除'));
  assert.deepEqual(calls, [], 'nothing is deleted until it is confirmed');
  button(foot, '删除').onclick(); button(foot, '确认删除').onclick(); await settle();
  assert.deepEqual(calls, [['delete_provider', { providerId: 'svc' }], ['list_providers']]);
  assert.equal(ctx.openModels.has('svc'), false); assert.match(statuses.at(-1), /已从 ZCode 删除「服务」/); assert.equal(ctx.busy, false);

  calls.length = 0;
  const info = node('dl'), edit = serviceChanges(p, 0, info);
  button(edit, '修改').onclick();
  const form = all(edit, c => c.tag === 'form')[0], [url, key] = all(form, c => c.tag === 'input');
  assert.equal(info.hidden, true); assert.equal(url.value, 'https://svc.test/v1'); assert.equal(url.disabled, false); assert.equal(focused, url);
  assert.deepEqual([key.value, key.type, key.placeholder], ['', 'password', '留空则保持原 Key'], 'the saved key is never filled in');
  url.value = ' https://moved.test/v1 '; key.value = ' new-key '; submit(form); await settle();
  assert.deepEqual(calls, [['update_provider', { providerId: 'svc', baseUrl: 'https://moved.test/v1', apiKey: 'new-key' }], ['list_providers']]);
  assert.match(statuses.at(-1), /已更新「服务」的 Key/);

  ctx.call = async () => { throw new Error('请填写完整的接口地址'); };
  const failing = serviceChanges(p, 0, node('dl')); button(failing, '修改').onclick();
  const failed = all(failing, c => c.tag === 'form')[0]; submit(failed); await settle();
  const error = all(failed, c => c.className === 'note fail')[0];
  assert.deepEqual([error.hidden, error.textContent, ctx.busy], [false, '请填写完整的接口地址', false], 'a refused change keeps the form open with the reason');
  button(failing, '取消').onclick(); assert.equal(focused, button(failing, '修改'));
  const rebuilt = serviceChanges(p, 0, node('dl')); button(rebuilt, '修改').onclick();
  const gone = all(rebuilt, c => c.tag === 'form')[0]; all(gone, c => c.className === 'note fail')[0].isConnected = false;
  submit(gone); await settle();
  assert.equal(statuses.at(-1), '请填写完整的接口地址', 'a refusal after the list was rebuilt, as when the panel hides, still reaches the status line');

  const template = serviceChanges({ ...p, fixedAddress: true }, 1, node('dl')); button(template, '修改').onclick();
  const [fixedUrl, fixedKey] = all(template, c => c.tag === 'input');
  assert.deepEqual([fixedUrl.disabled, fixedUrl.dataset.change, focused], [true, undefined, fixedKey], 'a template address stays read-only, even after a write re-enables the form');
});
test('reveal_key returns one listed provider key on request and nothing else', async t => {
  const { harbor, configPath } = await fixture(t);
  const doc = seed(), rules = doc.config.providerConfigRules.providerRules;
  rules.push({ providerId: 'nokey', providerName: '没有 Key', config: { group: 'standard-personal', access: { type: 'api-key', apiKey: '' }, api: { type: 'openai-chat-completions', baseUrl: 'https://nokey.test' } } });
  rules.push({ providerId: 'other', providerName: '非自定义', config: { group: 'builtin', access: { type: 'api-key', apiKey: 'other-secret' }, api: { type: 'openai-chat-completions', baseUrl: 'https://other.test' } } });
  await fs.writeFile(configPath, JSON.stringify(doc)); const before = await fs.readFile(configPath, 'utf8');
  const listed = await callTool(harbor, 'list_providers');
  assert.deepEqual(listed.structuredContent.providers.map(p => [p.id, p.baseUrl, p.hasKey]), [['mine', 'https://provider.test', true], ['nokey', 'https://nokey.test', false]]);
  assert.ok(!/secret/.test(JSON.stringify(listed)));
  const r = await callTool(harbor, 'reveal_key', { providerId: 'mine' });
  assert.deepEqual(r.structuredContent, { id: 'mine', apiKey: 'stored-secret' }); assert.ok(!r.content[0].text.includes('stored-secret'));
  for (const args of [undefined, null, {}, { providerId: '' }, { providerId: ['mine'] }, { providerId: 'missing' }, { providerId: 'nokey' }, { providerId: 'other' }]) {
    const e = await callTool(harbor, 'reveal_key', args);
    assert.equal(e.isError, true, JSON.stringify(args)); assert.equal(e.structuredContent, undefined); assert.ok(!/secret/.test(JSON.stringify(e)), JSON.stringify(args));
  }
  assert.equal(await fs.readFile(configPath, 'utf8'), before);
});
test('template-only provider resolves its URL and reuses its key without duplicating built-in models', async t => {
  const requests = [];
  const { harbor, configPath } = await fixture(t, async (url, opts) => { requests.push(url); assert.equal(opts.headers.Authorization, 'Bearer stored-secret'); return url === 'https://api.deepseek.com/models' ? Response.json({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }) : new Response('', { status: 404 }); });
  const doc = seed(); const p = doc.config.providerConfigRules.providerRules[0]; p.providerId = 'deepseek'; p.templateId = 'deepseek'; delete p.config.api; p.config.personalModelIds = []; p.config.modelOrder = ['deepseek-flash', 'deepseek-v4-pro'];
  await fs.writeFile(configPath, JSON.stringify(doc));
  const listed = (await harbor.providers()).providers[0]; assert.equal(listed.baseUrl, 'https://api.deepseek.com/anthropic'); assert.equal(listed.modelCount, 2);
  assert.deepEqual(listed.models, ['deepseek-flash', 'deepseek-v4-pro']);
  const r = await harbor.fetchModels({ baseUrl: listed.baseUrl, protocol: listed.protocol, existingProviderId: listed.id });
  assert.ok(requests.includes('https://api.deepseek.com/models'));
  const imported = await harbor.importModels({ sessionId: r.sessionId, modelIds: r.models.map(m => m.id) }); assert.equal(imported.added, 0);
  const saved = JSON.parse(await fs.readFile(configPath, 'utf8')); assert.deepEqual(saved.config.providerConfigRules.providerRules[0].config.personalModelIds, []); assert.equal(saved.config.providerConfigRules.providerRules[0].config.api, undefined);
});
test('the site page opens with the account and its total top-ups beside 刷新 and 退出登录, then the balance and the link that opens the site', async () => {
  const html = await fs.readFile(path.join(root, 'panel.html'), 'utf8');
  const page = html.slice(html.indexOf('<section class="part" id="siteCard">'), html.indexOf('<div class="page" id="connectPage"'));
  assert.ok(page.length > 0 && !page.includes('<h2'), 'no heading: the tab names the site, and the link and the login note its address');
  const order = ['id="siteLogin"', 'id="siteAccount"', 'id="siteInfo"', 'id="siteRefresh"', 'id="siteLogout"', 'class="balance"', 'id="siteBalance"', 'id="siteOpen"', 'id="siteError"', 'id="siteGroupsPart"', 'id="siteKeys"'].map(marker => page.indexOf(marker));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), JSON.stringify(order));
  assert.match(page, /<button class="link siteopen" id="siteOpen" type="button" hidden>/);
  const source = name => { const at = html.indexOf(`  function ${name}(`); return html.slice(at, html.indexOf('\n  }\n', at) + 4); };
  const els = {};
  const $ = id => els[id] ||= { id, hidden: true, textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); } };
  const ctx = { $, window: {}, openSite: null, site: { signedIn: true, email: 'user@example.com', site: { host: 'ro.biubiu007.com', origin: 'https://ro.biubiu007.com' } } };
  vm.runInNewContext(source('renderOpen'), ctx);
  ctx.renderOpen(); assert.equal(els.siteOpen.hidden, true, 'hidden while there is no way to open the site');
  ctx.openSite = () => {}; ctx.renderOpen();
  assert.deepEqual([els.siteOpen.hidden, els.siteOpenText.textContent, els.siteOpen.attrs['aria-label']], [false, '打开 ro.biubiu007.com', '打开 ro.biubiu007.com，已登录 user@example.com']);
  // The desktop host opens it signed in; the preview, without a host, can only open the login page in a tab.
  assert.ok(html.includes("if (webview) { tellHost = message => webview.postMessage(message); openSite = () => tellHost('open-site'); $('updateLink').onclick = () => tellHost('update'); }"));
  assert.ok(html.includes("openSite = () => { const origin = site?.site?.origin; if (origin) window.open(`${origin}/login`, '_blank', 'noopener'); };"));
  assert.ok(html.includes("$('siteOpen').onclick = () => { if (openSite && site?.signedIn) openSite(); };"));
  assert.ok(html.includes("else if (e.data?.type === 'site-window' && e.data.error) siteProblem(String(e.data.error));"), 'a window that did not open says so on the site page');
});
test('cards, buttons, fields, notices, check boxes and the scroll bar are rounded like the window', async () => {
  const html = await fs.readFile(path.join(root, 'panel.html'), 'utf8');
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const rule = selector => { const at = css.indexOf(`${selector}{`); assert.ok(at >= 0, selector); return css.slice(at, css.indexOf('}', at)); };
  for (const selector of ['.primary', '.small', '.status', '.note.fail', '.row input', '.tag', '.dot', '::-webkit-scrollbar-thumb', '.input,.select', '#connectForm,#siteLogin,.acct,.list,#savedList,#siteKeys,.gplat>[role=list]']) assert.match(rule(selector), /border-radius:/, selector);
  // A native popup takes the select's own background, so it stays opaque, in the page color.
  assert.match(rule('.select'), /background-color:var\(--bg\)/);
});
