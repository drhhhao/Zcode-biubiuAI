import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const LEVELS = ['disabled', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'enabled'];
// What an import gives a model where ZCode's own rules say nothing about it (ZCode's catch-all rule for every model does
// not count): a 256K context, 128K of output and the thinking levels low, high and max. Two rules keep it safe: a value
// ZCode's rules do give is left to ZCode, unless the service itself states a smaller limit; and a smaller limit, fewer
// levels or no thinking, stated by the service or the public model catalog, lowers a default but nothing raises one.
// biubiu AI writes these into a model newly added to a service and nothing else; anything more is set in ZCode.
export const DEFAULTS = Object.freeze({ contextWindow: 256000, maxOutputTokens: 128000, reasoningLevels: Object.freeze(['low', 'high', 'max']) });
const FIELDS = ['contextWindow', 'maxOutputTokens', 'reasoningLevels'];
const positive = n => Number.isSafeInteger(n) && n > 0 && n <= 100000000;
function levels(items) { return Array.isArray(items) ? [...new Set(items.filter(x => LEVELS.includes(x)))].sort((a, b) => LEVELS.indexOf(a) - LEVELS.indexOf(b)) : undefined; }
function bool(v) { return typeof v === 'boolean' ? v : undefined; }
function compact(o) { return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)); }

export function apiMetadata(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const contextWindow = [raw.context_window, raw.context_length, raw.contextWindow, raw.max_input_tokens, raw.top_provider?.context_length, raw.limit?.context].find(positive);
  const maxOutputTokens = [raw.max_output_tokens, raw.maxOutputTokens, raw.max_completion_tokens, raw.top_provider?.max_completion_tokens, raw.max_tokens, raw.limit?.output].find(positive);
  let reasoningLevels = levels(raw.effort?.supported_levels || raw.reasoning_effort_levels || raw.supported_reasoning_levels || raw.reasoning?.effort_levels);
  const effort = raw.capabilities?.effort;
  if (!reasoningLevels?.length && effort?.supported === true) reasoningLevels = levels(LEVELS.filter(l => effort[l]?.supported === true));
  if (effort?.supported === false || raw.reasoning === false) reasoningLevels = [];
  const input = raw.input_modalities || raw.architecture?.input_modalities || raw.modalities?.input;
  const supportsImage = Array.isArray(input) ? input.includes('image') : bool(raw.capabilities?.image_input?.supported);
  return compact({ contextWindow, maxOutputTokens, reasoningLevels, supportsImage, supportsToolCall: bool(raw.supports_tool_call ?? raw.tool_call), defaultReasoning: LEVELS.includes(raw.effort?.default_level) ? raw.effort.default_level : undefined });
}
export function configMetadata(config = {}) {
  return compact({ contextWindow: positive(config.properties?.contextWindow) ? config.properties.contextWindow : undefined, maxOutputTokens: positive(config.optionSpecs?.maxOutputTokens?.max) ? config.optionSpecs.maxOutputTokens.max : undefined, reasoningLevels: levels(config.optionSpecs?.reasoningLevel?.values) });
}
function match(pattern, value, anyCase = false) { try { return new RegExp(`^(?:${pattern})$`, anyCase ? 'i' : undefined).test(value); } catch { return false; } }
// The catalog's limits for a model. Where it gives an input limit below the context, that is as far as a conversation
// can go, so it counts as the context.
function catalogMetadata(m) {
  let reasoningLevels = levels(m.reasoning_options?.find(x => x.type === 'effort')?.values);
  if (m.reasoning === false) reasoningLevels = [];
  const context = [m.limit?.context, m.limit?.input].filter(positive);
  return compact({ contextWindow: context.length ? Math.min(...context) : undefined, maxOutputTokens: positive(m.limit?.output) ? m.limit.output : undefined, reasoningLevels });
}
// An address as ZCode compares it with its rules: without trailing slashes.
function ruleAddress(url) {
  try { const u = new URL(url), tail = `${u.search}${u.hash}`, whole = u.toString(); return `${(tail ? whole.slice(0, -tail.length) : whole).replace(/\/+$/, '')}${tail}`; } catch { return undefined; }
}
const version = name => (/^(\d+)\.(\d+)\.(\d+)/.exec(name) || []).slice(1, 4).map(Number);
const newer = (a, b) => { for (let i = 0; i < 3; i++) if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) > (b[i] ?? -1); return false; };
// ZCode's own rules: the file ZCODE_BUILTIN_PROVIDER_CONFIG_FILE names; else the copy ZCode keeps in its data folder for
// the newest version it has run (v2/runtime/provider/<platform>/<version>/endpoint-*/zcode-builtin.json), so a ZCode
// update brings its new rules here too; else the copy bundled with biubiu AI.
export async function zcodeRules({ file, zcodeDir } = {}) {
  if (file) { try { return JSON.parse(await fs.readFile(file, 'utf8')).config; } catch {} }
  if (zcodeDir) {
    const runtime = path.join(zcodeDir, 'runtime', 'provider'), copies = [];
    const list = async dir => { try { return (await fs.readdir(dir, { withFileTypes: true })).filter(d => d.isDirectory()); } catch { return []; } };
    for (const platform of await list(runtime)) {
      for (const release of await list(path.join(runtime, platform.name))) {
        for (const endpoint of (await list(path.join(runtime, platform.name, release.name))).filter(d => d.name.startsWith('endpoint-'))) {
          const at = path.join(runtime, platform.name, release.name, endpoint.name, 'zcode-builtin.json');
          try { copies.push({ at, v: version(release.name), stamp: (await fs.stat(at)).mtimeMs }); } catch {}
        }
      }
    }
    copies.sort((a, b) => newer(a.v, b.v) ? -1 : newer(b.v, a.v) ? 1 : b.stamp - a.stamp);
    for (const { at } of copies) { try { const config = JSON.parse(await fs.readFile(at, 'utf8')).config; if (config?.modelConfigRules) return config; } catch {} }
  }
  return JSON.parse(await fs.readFile(new URL('./zcode-catalog.json', import.meta.url), 'utf8')).config;
}
// The values ZCode's own rules give a model on a service, in the order ZCode applies them: by model name (any case), by
// name and API type, by address, then by the service's template. The catch-all rules for every model, ZCode's fallback,
// do not count: a model only they describe is one ZCode does not know.
export function zcodeValues(zcode, { modelId, protocol, baseUrl, templateId } = {}) {
  const rules = zcode?.modelConfigRules || {}, values = {}, address = baseUrl ? ruleAddress(baseUrl) : undefined;
  const take = config => Object.assign(values, configMetadata(config));
  const api = r => r.apiTypeMatch === undefined || (protocol != null && match(r.apiTypeMatch, protocol));
  for (const r of rules.modelRules || []) if (r.modelMatch !== '.*' && match(r.modelMatch, modelId, true)) take(r.config);
  for (const r of rules.modelApiRules || []) if (r.modelMatch !== '.*' && match(r.modelMatch, modelId, true) && api(r)) take(r.config);
  for (const r of rules.providerSiteRules || []) if (match(r.modelMatch, modelId, true) && api(r) && address !== undefined && match(r.baseUrlMatch, address)) take(r.config);
  for (const r of rules.templateModelRules || []) if (templateId && r.templateId === templateId && r.modelId === modelId) take(r.config);
  return values;
}
// What an import writes for one model, field by field, and where each value comes from (default, api or catalog).
// known is what ZCode's rules give, declared what the service states, listed what the public catalog has.
export function planFor(known = {}, declared = {}, listed = {}) {
  const values = {}, sources = {};
  for (const key of ['contextWindow', 'maxOutputTokens']) {
    if (known[key] != null) { if (declared[key] != null && declared[key] < known[key]) { values[key] = declared[key]; sources[key] = 'api'; } continue; }
    values[key] = DEFAULTS[key]; sources[key] = 'default';
    for (const [limit, from] of [[declared[key], 'api'], [listed[key], 'catalog']]) if (limit != null && limit < values[key]) { values[key] = limit; sources[key] = from; }
  }
  // A context no larger than the output leaves no room for the conversation, as with ZCode's 384K output for DeepSeek V4
  // under the 256K default: a default context then goes, so ZCode's own value holds, and below a stated or known
  // context the output is cut to half of it.
  const output = values.maxOutputTokens ?? known.maxOutputTokens, context = values.contextWindow ?? known.contextWindow;
  if (output != null && context != null && output >= context) {
    if (sources.contextWindow === 'default') { delete values.contextWindow; delete sources.contextWindow; }
    else { values.maxOutputTokens = Math.floor(context / 2); sources.maxOutputTokens = 'context'; }
  }
  if (known.reasoningLevels == null) {
    const stated = declared.reasoningLevels ?? listed.reasoningLevels, from = declared.reasoningLevels ? 'api' : 'catalog';
    const common = stated ? DEFAULTS.reasoningLevels.filter(l => stated.includes(l)) : [...DEFAULTS.reasoningLevels];
    // A model stated not to think gets thinking off only; one whose levels miss all three keeps its own.
    values.reasoningLevels = stated && !stated.length ? ['disabled'] : common.length ? common : stated;
    sources.reasoningLevels = !stated || common.length === DEFAULTS.reasoningLevels.length ? 'default' : from;
  }
  return { values, sources };
}
// ZCode's catch-all values for every model on an API type: what ZCode uses where nothing more specific is set.
export function zcodeFallback(zcode, { protocol } = {}) {
  const rules = zcode?.modelConfigRules || {}, values = {};
  for (const r of rules.modelRules || []) if (r.modelMatch === '.*') Object.assign(values, configMetadata(r.config));
  for (const r of rules.modelApiRules || []) if (r.modelMatch === '.*' && (r.apiTypeMatch === undefined || (protocol != null && match(r.apiTypeMatch, protocol)))) Object.assign(values, configMetadata(r.config));
  return values;
}

export class MetadataCatalog {
  constructor({ builtinConfigPath, zcodeDir, dataDir, refresh = true, fetchImpl = fetch } = {}) {
    // The cache folder in ZCode's cache had the project's old working name up to 0.8.12; an installed copy's default one
    // takes it over once (the host sets BIUBIU_AI_CARRY_OVER there), so tests and development runs never move it.
    if (!dataDir && !process.env.BIUBIU_AI_DATA_DIR && process.env.BIUBIU_AI_CARRY_OVER === '1') this.legacyDir = path.join(os.homedir(), '.zcode/v2/cache/model-harbor');
    dataDir ||= process.env.BIUBIU_AI_DATA_DIR || path.join(os.homedir(), '.zcode/v2/cache/biubiu-ai'); this.builtinConfigPath = builtinConfigPath; this.zcodeDir = zcodeDir; this.dataDir = dataDir; this.refresh = refresh; this.fetchImpl = fetchImpl; this.promise = null; }
  async load() {
    if (!this.promise) this.promise = this.#load().catch(() => ({ providers: {}, zcode: {}, fetchedAt: null }));
    return this.promise;
  }
  async #load() {
    const bundled = JSON.parse(await fs.readFile(new URL('./model-catalog.json', import.meta.url), 'utf8'));
    let catalog = bundled;
    if (this.legacyDir) await fs.rename(this.legacyDir, this.dataDir).catch(() => {});
    const cache = path.join(this.dataDir, 'model-catalog.json');
    try { const saved = JSON.parse(await fs.readFile(cache, 'utf8')); if (saved.providers && Date.parse(saved.fetchedAt) > Date.parse(catalog.fetchedAt)) catalog = saved; } catch {}
    if (this.refresh && Date.now() - Date.parse(catalog.fetchedAt) > 24 * 60 * 60 * 1000) {
      try {
        const res = await this.fetchImpl('https://models.dev/api.json', { signal: AbortSignal.timeout(5000), redirect: 'error' });
        if (!res.ok) throw new Error('catalog fetch failed');
        const reader = res.body.getReader(); const chunks = []; let bytes = 0;
        while (true) { const r = await reader.read(); if (r.done) break; bytes += r.value.length; if (bytes > 12 * 1024 * 1024) { await reader.cancel(); throw new Error('catalog too large'); } chunks.push(r.value); }
        const all = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const providers = {};
        // Only what an import reads (catalogMetadata, findCatalogModel) is kept: without the models' canonical ids,
        // modalities and tool flags, the cache and its copy in memory are about 40% smaller.
        for (const [id, p] of Object.entries(all)) if (p && typeof p.models === 'object') providers[id] = { id, api: p.api, models: Object.fromEntries(Object.entries(p.models).map(([key, m]) => [key, { id: m.id, limit: m.limit, reasoning: m.reasoning, reasoning_options: m.reasoning_options }])) };
        if (Object.keys(providers).length) { catalog = { fetchedAt: new Date().toISOString(), source: 'https://models.dev/api.json', providers }; await fs.mkdir(this.dataDir, { recursive: true }); await fs.writeFile(cache, JSON.stringify(catalog)); }
      } catch { /* Offline use keeps the bundled or previously cached public catalog. */ }
    }
    return { ...catalog, zcode: await zcodeRules({ file: this.builtinConfigPath, zcodeDir: this.zcodeDir }) };
  }
  // The catalog's providers on the service's own host. The same for every model of a fetch, so enrich finds them once
  // instead of parsing every provider's address again for each model (3000 models made 1.4 million URLs).
  sameHostProviders(baseUrl, providers) {
    let host;
    try { host = new URL(baseUrl).hostname; } catch { return []; }
    return Object.values(providers).filter(p => { try { return new URL(p.api).hostname === host; } catch { return false; } });
  }
  findCatalogModel(id, baseUrl, providers, sameHost = this.sameHostProviders(baseUrl, providers)) {
    const clean = id.toLowerCase().replace(/^(anthropic|openai|deepseek|google|zai|zhipuai|moonshotai|alibaba|xai)\//, '');
    const vendor = /^claude-/.test(clean) ? 'anthropic' : /^(gpt-|o[134](?:-|$))/.test(clean) ? 'openai' : /^deepseek-/.test(clean) ? 'deepseek' : /^gemini-/.test(clean) ? 'google' : /^glm-/.test(clean) ? 'zai' : /^qwen/.test(clean) ? 'alibaba' : null;
    const candidates = [...sameHost, ...(vendor && providers[vendor] ? [providers[vendor]] : [])];
    for (const provider of candidates) {
      const models = Object.values(provider.models || {});
      const m = models.find(m => String(m.id).toLowerCase() === clean || String(m.id).toLowerCase() === id.toLowerCase());
      if (m) return { model: m, provider: provider.id };
      const dated = models.find(m => String(m.id).toLowerCase().replace(/-\d{8}$/, '') === clean);
      if (dated) return { model: dated, provider: provider.id };
    }
    return null;
  }
  // Each model with the values ZCode will use once it is imported (metadata, with where each comes from) and the values
  // the import writes (plan). A value the service's saved rule already holds stays as it is.
  async enrich(models, { baseUrl, protocol, providerId, templateId, savedRules = [] } = {}) {
    const catalog = await this.load(), providers = catalog.providers || {};
    const sameHost = this.sameHostProviders(baseUrl, providers), fallback = zcodeFallback(catalog.zcode, { protocol });
    return models.map(model => {
      const known = zcodeValues(catalog.zcode, { modelId: model.id, protocol, baseUrl, templateId });
      const found = this.findCatalogModel(model.id, baseUrl, providers, sameHost);
      const { values: plan, sources: planned } = planFor(known, model.apiMetadata || {}, found ? catalogMetadata(found.model) : {});
      const saved = savedRules.find(r => r.providerId === providerId && r.modelId === model.id), kept = saved ? configMetadata(saved.config) : {};
      const metadata = {}, sources = {};
      for (const key of FIELDS) {
        const [value, source] = kept[key] != null ? [kept[key], 'saved'] : plan[key] != null ? [plan[key], planned[key]] : known[key] != null ? [known[key], 'zcode'] : [fallback[key], 'zcode-fallback'];
        if (value != null) { metadata[key] = value; sources[key] = source; }
      }
      return { id: model.id, metadata, sources, plan };
    });
  }
}

// Writes an import's values into a model's rule, each only where the rule has none yet.
export function applyPlan(config, plan = {}) {
  const before = JSON.stringify(config), values = levels(plan.reasoningLevels);
  if (positive(plan.contextWindow) && config.properties?.contextWindow == null) { config.properties ||= {}; config.properties.contextWindow = plan.contextWindow; }
  if (positive(plan.maxOutputTokens) && config.optionSpecs?.maxOutputTokens?.max == null) { config.optionSpecs ||= {}; config.optionSpecs.maxOutputTokens = { ...config.optionSpecs.maxOutputTokens, max: plan.maxOutputTokens }; }
  if (values?.length && config.optionSpecs?.reasoningLevel?.values == null) { config.optionSpecs ||= {}; config.optionSpecs.reasoningLevel = { ...config.optionSpecs.reasoningLevel, values }; }
  return JSON.stringify(config) !== before;
}
