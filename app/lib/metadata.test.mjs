import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { apiMetadata, MetadataCatalog, applyPlan, planFor, zcodeValues, zcodeRules, DEFAULTS } from './metadata.mjs';
import { BiubiuAI } from './core.mjs';
import { callTool } from './tools.mjs';

async function setup(t, entries, fetchImpl) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'biubiu-meta-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'provider_config.json');
  const doc = { schemaVersion: 1, config: { providerOrder: ['p'], providerConfigRules: { providerRules: [{ providerId: 'p', providerName: 'Provider', config: { group: 'standard-personal', access: { type: 'api-key', apiKey: 'private-key' }, api: { type: 'anthropic-messages', baseUrl: 'https://proxy.test' }, personalModelIds: [], modelOrder: [] } }] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] } } };
  await fs.writeFile(configPath, JSON.stringify(doc));
  const metadataCatalog = new MetadataCatalog({ dataDir: path.join(dir, 'cache'), refresh: false });
  const biubiu = new BiubiuAI({ configPath, metadataCatalog, fetchImpl: fetchImpl || (async () => Response.json({ data: entries })) });
  return { biubiu, configPath, doc, metadataCatalog, dir };
}
const rulesOf = async configPath => Object.fromEntries(JSON.parse(await fs.readFile(configPath, 'utf8')).config.modelConfigRules.providerModelRules.map(r => [r.modelId, r.config]));
const fetchAll = (biubiu, protocol = 'anthropic-messages') => biubiu.fetchModels({ baseUrl: 'https://proxy.test', apiKey: 'private-key', protocol });

test('API metadata covers declared sizes, modalities and supported effort values', () => {
  const m = apiMetadata({ context_window: 1048576, max_output_tokens: 393216, input_modalities: ['text', 'image'], effort: { supported_levels: ['low', 'high', 'max', 'unknown'], default_level: 'high' } });
  assert.equal(m.contextWindow, 1048576); assert.equal(m.maxOutputTokens, 393216); assert.deepEqual(m.reasoningLevels, ['low', 'high', 'max']); assert.equal(m.supportsImage, true);
  assert.deepEqual(apiMetadata({ context_window: '1000000', max_output_tokens: -1, effort: { supported_levels: 'high' } }), {});
});
test('Anthropic capabilities and OpenRouter fields are parsed without inventing missing levels', () => {
  assert.deepEqual(apiMetadata({ max_input_tokens: 200000, max_tokens: 64000, capabilities: { effort: { supported: true, low: { supported: true }, high: { supported: true } }, image_input: { supported: false } } }).reasoningLevels, ['low', 'high']);
  const r = apiMetadata({ context_length: 100000, top_provider: { max_completion_tokens: 20000 }, supported_parameters: ['reasoning'], architecture: { input_modalities: ['text'] } }); assert.equal(r.maxOutputTokens, 20000); assert.equal(r.reasoningLevels, undefined);
});

test('the plan: defaults where ZCode knows nothing, lowered and never raised, and nothing over what ZCode knows unless the service states less', () => {
  assert.deepEqual(DEFAULTS, { contextWindow: 256000, maxOutputTokens: 128000, reasoningLevels: ['low', 'high', 'max'] });
  assert.deepEqual(planFor(), { values: { contextWindow: 256000, maxOutputTokens: 128000, reasoningLevels: ['low', 'high', 'max'] }, sources: { contextWindow: 'default', maxOutputTokens: 'default', reasoningLevels: 'default' } });
  assert.deepEqual(planFor({}, { contextWindow: 300000 }, { contextWindow: 500000, maxOutputTokens: 256000 }).values, { contextWindow: 256000, maxOutputTokens: 128000, reasoningLevels: ['low', 'high', 'max'] }, 'a larger limit raises nothing');
  assert.deepEqual(planFor({}, { maxOutputTokens: 32000 }, { contextWindow: 200000, maxOutputTokens: 64000, reasoningLevels: ['low', 'medium', 'high'] }),
    { values: { contextWindow: 200000, maxOutputTokens: 32000, reasoningLevels: ['low', 'high'] }, sources: { contextWindow: 'catalog', maxOutputTokens: 'api', reasoningLevels: 'catalog' } }, 'the smallest stated limit wins, and max goes where it is not offered');
  assert.deepEqual(planFor({}, { reasoningLevels: [] }).values.reasoningLevels, ['disabled'], 'a model stated not to think gets thinking off only');
  assert.deepEqual(planFor({}, {}, { reasoningLevels: ['minimal', 'medium'] }).values.reasoningLevels, ['minimal', 'medium'], 'levels that miss all three are its own');
  assert.deepEqual(planFor({ contextWindow: 1050000, reasoningLevels: ['none', 'low', 'high'] }, { contextWindow: 2000000, reasoningLevels: ['low'] }, { maxOutputTokens: 64000 }).values, { maxOutputTokens: 64000 }, 'what ZCode knows is left to ZCode');
  assert.deepEqual(planFor({ contextWindow: 1050000, maxOutputTokens: 128000 }, { contextWindow: 400000, maxOutputTokens: 200000 }), { values: { contextWindow: 400000, reasoningLevels: ['low', 'high', 'max'] }, sources: { contextWindow: 'api', reasoningLevels: 'default' } }, 'unless the service itself states less');
  // The context never ends up at or below the output.
  assert.deepEqual(planFor({ maxOutputTokens: 384000, reasoningLevels: ['low'] }), { values: {}, sources: {} }, 'a default context under a known output goes, so ZCode\'s own context holds');
  assert.deepEqual(planFor({}, { contextWindow: 64000 }), { values: { contextWindow: 64000, maxOutputTokens: 32000, reasoningLevels: ['low', 'high', 'max'] }, sources: { contextWindow: 'api', maxOutputTokens: 'context', reasoningLevels: 'default' } }, 'below a stated context the output is cut to half of it');
  assert.deepEqual(planFor({ contextWindow: 100000, reasoningLevels: ['low'] }).values, { maxOutputTokens: 50000 }, 'and below a known one');
});

test('ZCode\'s values come from its rules as ZCode applies them, without its catch-all fallback', () => {
  const zcode = { modelConfigRules: {
    modelRules: [{ modelMatch: '.*', config: { properties: { contextWindow: 1000000 }, optionSpecs: { maxOutputTokens: { max: 128000 }, reasoningLevel: { values: ['disabled', 'enabled'] } } } }, { modelMatch: '.*claude-opus-5.*', config: { optionSpecs: { reasoningLevel: { values: ['low', 'high', 'max'] } } } }],
    modelApiRules: [{ modelMatch: '.*', apiTypeMatch: 'anthropic-messages', config: { properties: { contextWindow: 7 } } }, { modelMatch: '.*claude-opus-5.*', apiTypeMatch: 'openai-responses', config: { properties: { contextWindow: 400000 } } }],
    providerSiteRules: [{ modelMatch: '.*', baseUrlMatch: 'https://relay\\.test/v1', config: { properties: { contextWindow: 300000 } } }],
    templateModelRules: [{ templateId: 'tpl', modelId: 'm', config: { optionSpecs: { maxOutputTokens: { max: 8192 } } } }] } };
  assert.deepEqual(zcodeValues(zcode, { modelId: 'Claude-Opus-5-5', protocol: 'anthropic-messages', baseUrl: 'https://other.test' }), { reasoningLevels: ['low', 'high', 'max'] }, 'names match in any case; catch-all rules do not count');
  assert.deepEqual(zcodeValues(zcode, { modelId: 'claude-opus-5-5', protocol: 'openai-responses' }), { reasoningLevels: ['low', 'high', 'max'], contextWindow: 400000 }, 'a rule for one API type');
  assert.deepEqual(zcodeValues(zcode, { modelId: 'alias', protocol: 'anthropic-messages', baseUrl: 'https://relay.test/v1/' }), { contextWindow: 300000 }, 'a rule for one address, which ZCode compares without its trailing slash');
  assert.deepEqual(zcodeValues(zcode, { modelId: 'm', templateId: 'tpl' }), { maxOutputTokens: 8192 });
  assert.deepEqual(zcodeValues(zcode, { modelId: 'hark', protocol: 'anthropic-messages' }), {});
});

test('a model ZCode has no rule for gets 256K, 128K and low, high and max, written only into the new model\'s rule', async t => {
  const { biubiu, configPath } = await setup(t, [{ id: 'hark' }, { id: 'Opus5.5' }]); const r = await fetchAll(biubiu);
  for (const m of r.models) { assert.deepEqual(m.metadata, { contextWindow: 256000, maxOutputTokens: 128000, reasoningLevels: ['low', 'high', 'max'] }); assert.deepEqual(m.sources, { contextWindow: 'default', maxOutputTokens: 'default', reasoningLevels: 'default' }); }
  const imported = await biubiu.importModels({ sessionId: r.sessionId, modelIds: ['hark', 'Opus5.5'], providerName: 'Provider', modelSettings: { hark: { contextWindow: 999 } } });
  assert.deepEqual([imported.added, imported.updatedParameters], [2, undefined]);
  const rules = await rulesOf(configPath);
  assert.deepEqual(rules.hark, { enabled: true, properties: { contextWindow: 256000 }, optionSpecs: { maxOutputTokens: { max: 128000 }, reasoningLevel: { values: ['low', 'high', 'max'] } } }, 'panel settings are no longer taken');
  assert.deepEqual(rules['Opus5.5'], rules.hark);
});

test('a model ZCode knows keeps ZCode\'s values; what ZCode leaves open gets the defaults, and a smaller stated limit wins', async t => {
  const { biubiu, configPath } = await setup(t, [{ id: 'gpt-5.6-sol' }, { id: 'claude-opus-5-5', context_window: 250000, max_output_tokens: 32000, effort: { supported_levels: ['low', 'high'] } }, { id: 'claude-sonnet-5-5' }, { id: 'deepseek-v4-pro' }]);
  const r = await fetchAll(biubiu, 'openai-responses'), model = id => r.models.find(m => m.id === id);
  // ZCode's rule for gpt-5.6 gives the context and the levels; the output it leaves open is the default.
  assert.deepEqual(model('gpt-5.6-sol').metadata, { contextWindow: 1050000, maxOutputTokens: 128000, reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] });
  assert.deepEqual(model('gpt-5.6-sol').plan, { maxOutputTokens: 128000 });
  // ZCode knows the Claude 5 levels only: the service states a smaller context and output, and those win over the defaults.
  assert.deepEqual([model('claude-opus-5-5').metadata, model('claude-opus-5-5').sources], [{ contextWindow: 250000, maxOutputTokens: 32000, reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }, { contextWindow: 'api', maxOutputTokens: 'api', reasoningLevels: 'zcode' }]);
  assert.deepEqual(model('claude-sonnet-5-5').plan, { contextWindow: 256000, maxOutputTokens: 128000 }, 'the catalog\'s 1M does not raise the default');
  // ZCode knows DeepSeek V4's 384K output but no context: the 256K default would leave no room, so ZCode's own 1M holds.
  const deepseek = (await biubiu.fetchModels({ baseUrl: 'https://proxy.test', apiKey: 'private-key', protocol: 'anthropic-messages' })).models.find(m => m.id === 'deepseek-v4-pro');
  assert.deepEqual([deepseek.plan, deepseek.metadata, deepseek.sources.contextWindow], [{}, { contextWindow: 1000000, maxOutputTokens: 384000, reasoningLevels: ['disabled', 'low', 'high', 'max'] }, 'zcode-fallback']);
  await biubiu.importModels({ sessionId: r.sessionId, modelIds: r.models.map(m => m.id), providerName: 'Provider' });
  const rules = await rulesOf(configPath);
  assert.deepEqual(rules['gpt-5.6-sol'], { enabled: true, optionSpecs: { maxOutputTokens: { max: 128000 } } }, 'ZCode\'s own values are not written, so they follow ZCode');
  assert.deepEqual(rules['claude-opus-5-5'], { enabled: true, properties: { contextWindow: 250000 }, optionSpecs: { maxOutputTokens: { max: 32000 } } });
});

test('the public catalog lowers the defaults for a model it knows: smaller limits, fewer levels, no thinking', async t => {
  const { biubiu } = await setup(t, [{ id: 'gpt-5' }, { id: 'claude-opus-4-5' }, { id: 'gpt-4.1' }]);
  const r = await fetchAll(biubiu, 'openai-chat-completions'), model = id => r.models.find(m => m.id === id).metadata;
  assert.deepEqual(model('gpt-5'), { contextWindow: 256000, maxOutputTokens: 128000, reasoningLevels: ['low', 'high'] }, 'its input limit of 272K is above the default; max is not offered');
  assert.deepEqual(model('claude-opus-4-5'), { contextWindow: 200000, maxOutputTokens: 64000, reasoningLevels: ['low', 'high'] });
  assert.deepEqual(model('gpt-4.1'), { contextWindow: 256000, maxOutputTokens: 32768, reasoningLevels: ['disabled'] });
});

test('a refreshed public catalog keeps only what an import reads, and a fetch finds the service\'s own host in it once', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'biubiu-catalog-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  t.mock.method(Date, 'now', () => Date.parse('2100-01-01T00:00:00Z'));
  const asked = [], listing = { relay: { id: 'relay', name: 'Relay', api: 'https://relay.test/v1', models: {
    'hark-1': { id: 'hark-1', canonical_model_id: 'hark', limit: { context: 64000, output: 16000 }, reasoning: false, modalities: { input: ['text', 'image'] }, tool_call: true, cost: { input: 1 } },
    'hark-2': { id: 'hark-2', limit: { context: 200000, input: 100000, output: 32000 }, reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }], modalities: { input: ['text'] } } } } };
  const catalog = new MetadataCatalog({ dataDir: dir, zcodeDir: dir, fetchImpl: async url => { asked.push(url); return Response.json(listing); } });
  const hosts = t.mock.method(catalog, 'sameHostProviders');
  const plans = Object.fromEntries((await catalog.enrich([{ id: 'hark-1' }, { id: 'hark-2' }, { id: 'hark-3' }], { baseUrl: 'https://relay.test/v1', protocol: 'openai-chat-completions' })).map(m => [m.id, m.plan]));
  assert.deepEqual(asked, ['https://models.dev/api.json']);
  assert.deepEqual(plans['hark-1'], { contextWindow: 64000, maxOutputTokens: 16000, reasoningLevels: ['disabled'] });
  assert.deepEqual(plans['hark-2'], { contextWindow: 100000, maxOutputTokens: 32000, reasoningLevels: ['low', 'high'] }, 'the input limit counts as the context');
  assert.deepEqual(plans['hark-3'], { contextWindow: 256000, maxOutputTokens: 128000, reasoningLevels: ['low', 'high', 'max'] });
  assert.equal(hosts.mock.callCount(), 1, 'the providers on the service\'s host are found once for the whole fetch');
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'model-catalog.json'), 'utf8'));
  assert.deepEqual(saved.providers.relay, { id: 'relay', api: 'https://relay.test/v1', models: {
    'hark-1': { id: 'hark-1', limit: { context: 64000, output: 16000 }, reasoning: false },
    'hark-2': { id: 'hark-2', limit: { context: 200000, input: 100000, output: 32000 }, reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] } } }, 'no canonical ids, modalities, tool flags or prices');
});

test('a model the service already has keeps its rule as it is; a new model fills only the fields its rule leaves empty', async t => {
  const { biubiu, doc, configPath } = await setup(t, [{ id: 'claude-opus-5-5' }, { id: 'hark' }]);
  const kept = { enabled: true, properties: { contextWindow: 500000, inputFormat: { supportsImage: true } }, optionSpecs: { reasoningLevel: { values: ['high'], map: '{"effort": reasoningLevel}' } } };
  doc.config.providerConfigRules.providerRules[0].config.personalModelIds = ['hark'];
  doc.config.modelConfigRules.providerModelRules.push({ providerId: 'p', modelId: 'claude-opus-5-5', config: kept }, { providerId: 'p', modelId: 'hark', config: { enabled: false } });
  await fs.writeFile(configPath, JSON.stringify(doc));
  const r = await biubiu.fetchModels({ baseUrl: 'https://proxy.test', existingProviderId: 'p', protocol: 'anthropic-messages' });
  const opus = r.models.find(m => m.id === 'claude-opus-5-5');
  assert.deepEqual([opus.metadata.contextWindow, opus.sources.contextWindow, opus.metadata.reasoningLevels], [500000, 'saved', ['high']], 'what the service holds is shown');
  await biubiu.importModels({ sessionId: r.sessionId, modelIds: ['claude-opus-5-5', 'hark'], providerName: 'Provider' });
  const rules = await rulesOf(configPath);
  assert.deepEqual(rules['claude-opus-5-5'], { ...kept, optionSpecs: { ...kept.optionSpecs, maxOutputTokens: { max: 128000 } } }, 'new to the service: only the empty output is filled');
  assert.deepEqual(rules.hark, { enabled: false }, 'already in the service: left as it is');
});

test('an import writes no thinking program, and no value over one the rule holds', () => {
  const c = { optionSpecs: { maxOutputTokens: { max: 8000 } } };
  assert.equal(applyPlan(c, { contextWindow: 128000, maxOutputTokens: 16000, reasoningLevels: ['high', 'low', 'bogus'], map: 'bad-code' }), true);
  assert.deepEqual(c, { properties: { contextWindow: 128000 }, optionSpecs: { maxOutputTokens: { max: 8000 }, reasoningLevel: { values: ['low', 'high'] } } });
  assert.equal(applyPlan(c, { contextWindow: 1 }), false);
});

test('ZCode\'s rules come from the copy ZCode keeps for its newest version, or the file named for them', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'biubiu-zcode-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const copy = async (release, contextWindow) => {
    const at = path.join(dir, 'runtime', 'provider', 'windows-x86_64', release, 'endpoint-1');
    await fs.mkdir(at, { recursive: true });
    await fs.writeFile(path.join(at, 'zcode-builtin.json'), JSON.stringify({ revision: 1, config: { modelConfigRules: { modelRules: [{ modelMatch: 'hark', config: { properties: { contextWindow } } }] } } }));
  };
  await copy('3.16.2', 111111); await copy('3.17.0', 64000); await copy('0.0.0-dev', 999);
  const known = async options => zcodeValues(await zcodeRules(options), { modelId: 'hark' }).contextWindow;
  assert.equal(await known({ zcodeDir: dir }), 64000, 'the newest version');
  const named = path.join(dir, 'named.json');
  await fs.writeFile(named, JSON.stringify({ config: { modelConfigRules: { modelRules: [{ modelMatch: 'hark', config: { properties: { contextWindow: 32000 } } }] } } }));
  assert.equal(await known({ file: named, zcodeDir: dir }), 32000, 'the file named for them first');
  const bundled = await zcodeRules({ zcodeDir: path.join(dir, 'missing') });
  assert.equal(bundled.modelConfigRules.modelRules[0].modelMatch, '.*', 'else the copy bundled with biubiu AI');
  const biubiu = new BiubiuAI({ configPath: path.join(dir, 'provider_config.json'), refreshCatalog: false });
  assert.equal(biubiu.metadataCatalog.zcodeDir, dir, 'the companion reads them beside ZCode\'s own config');
});

test('测试连接 sends one short request without thinking settings and catches quota messages returned as HTTP 200', async t => {
  let mode = 'ok', body;
  const { biubiu } = await setup(t, [], async (url, opts) => {
    if (!opts.method) return Response.json({ data: [{ id: 'hark', effort: { supported_levels: ['low', 'high'] } }] });
    body = JSON.parse(opts.body); return Response.json({ content: [{ type: 'text', text: mode === 'ok' ? 'OK' : 'Your token quota is exhausted' }] });
  });
  const r = await fetchAll(biubiu);
  const good = await biubiu.testModel({ sessionId: r.sessionId, modelId: 'hark', reasoningLevel: 'high' });
  assert.equal(good.ok, true); assert.equal(body.max_tokens, 2048); assert.equal(body.thinking, undefined); assert.equal(body.output_config, undefined);
  mode = 'quota'; assert.equal((await biubiu.testModel({ sessionId: r.sessionId, modelId: 'hark' })).ok, false);
  await assert.rejects(biubiu.testModel({ sessionId: r.sessionId, modelId: 'other' }), /只能测试本次拉取的模型/); assert.ok(!JSON.stringify(good).includes('private-key'));
});
test('large model lists are paginated under the UI tool result size limit', async t => {
  const { biubiu } = await setup(t, Array.from({ length: 80 }, (_, i) => ({ id: 'model-' + i, context_window: 100000, max_output_tokens: 16000, effort: { supported_levels: ['low', 'high'] } })));
  const r = await callTool(biubiu, 'fetch_models', { baseUrl: 'https://proxy.test', apiKey: 'private-key' }); assert.equal(r.structuredContent.models.length, 25); assert.ok(Buffer.byteLength(JSON.stringify(r.structuredContent)) < 64000);
  const next = await callTool(biubiu, 'get_models', { sessionId: r.structuredContent.sessionId, offset: 25 }); assert.equal(next.structuredContent.models.length, 25); assert.equal(next.structuredContent.nextOffset, 50);
});
test('self-contained panel scripts parse as JavaScript', async () => {
  const html = await fs.readFile(new URL('./panel.html', import.meta.url), 'utf8'); const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]); assert.equal(scripts.length, 1); for (const script of scripts) new vm.Script(script);
});
