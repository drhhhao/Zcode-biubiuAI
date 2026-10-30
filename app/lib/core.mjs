import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { MetadataCatalog, apiMetadata, applyPlan } from './metadata.mjs';

export const CONFIG_PATH = process.env.MODEL_HARBOR_CONFIG_PATH || path.join(process.env.ZCODE_DATA_BASE_DIR || path.join(os.homedir(), '.zcode'), 'v2', 'provider_config.json');
const PROTOCOLS = new Set(['openai-chat-completions', 'anthropic-messages', 'openai-responses']);
// Fallback for the template used on this machine. Prefer the host's own catalog.
const DEFAULT_TEMPLATES = [{ templateId: 'deepseek', config: { api: { type: 'anthropic-messages', baseUrl: 'https://api.deepseek.com/anthropic' }, builtinModelIds: ['deepseek-flash', 'deepseek-v4-pro'] } }];
export class PanelError extends Error {}
// A service that ZCode's default model, or another setting, still uses, so it is not deleted.
class StillUsed extends PanelError { constructor(providerName) { super('ZCode 的默认模型或其他设置还在使用这个服务。请先在 ZCode 里换成其他服务的模型，再删除。'); this.providerName = providerName; } }

export function normalizeUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new PanelError('请填写完整的接口地址，例如 https://api.example.com/v1'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new PanelError('接口地址只支持 HTTP / HTTPS，请移除账号、查询参数和 # 后缀。');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|messages|responses|models)$/, '').replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}
function validateConfig(doc) {
  if (doc.schemaVersion !== 1 || !Array.isArray(doc.config?.providerConfigRules?.providerRules) || !Array.isArray(doc.config?.modelConfigRules?.providerModelRules) || !Array.isArray(doc.config?.modelConfigRules?.manualProviderModelRules)) throw new PanelError('当前 ZCode 配置格式与此版本 biubiu AI 不兼容，未修改配置。');
  return doc;
}
async function readConfig(file) {
  try { const raw = await fs.readFile(file, 'utf8'); return { raw, doc: validateConfig(JSON.parse(raw.replace(/^\uFEFF/, ''))) }; }
  catch (e) {
    if (e.code === 'ENOENT') throw new PanelError('尚未找到 ZCode 模型配置。请先在 ZCode 的模型设置里保存一个供应商，再回来导入。');
    if (e instanceof PanelError) throw e;
    throw new PanelError('无法读取 ZCode 模型配置，请检查文件是否为有效 JSON。');
  }
}
// After each write only the ten newest backups stay. Only the names changeConfig gives are deleted,
// provider_config-<UTC time>-<random>.json, which sort by time; the backup just made counts as the newest even if the
// clock went back. Best effort: the config is already saved, so a file that cannot be deleted waits for the next write.
const BACKUPS_KEPT = 10, BACKUP_NAME = /^provider_config-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-[0-9a-f]{8}\.json$/;
async function pruneBackups(dir, made) {
  const names = (await fs.readdir(dir).catch(() => [])).filter(name => BACKUP_NAME.test(name) && name !== made).sort();
  if (made) names.push(made);
  await Promise.all(names.slice(0, -BACKUPS_KEPT).map(name => fs.unlink(path.join(dir, name)).catch(() => {})));
}
// A provider's models as ZCode lists them: in modelOrder, then any built-in or personal model that order leaves out.
function providerModels(config) {
  const ids = new Set([...(config.builtinModelIds || []), ...(config.personalModelIds || [])].filter(id => typeof id === 'string'));
  return [...new Set([...[...(config.modelOrder || [])].filter(id => ids.has(id)), ...ids])];
}
// The services list_providers shows; only these can be revealed, changed or deleted from the panel.
const listed = p => p.config?.group === 'standard-personal' && Boolean(p.config?.api?.baseUrl);
// True when anything under value still names the provider, such as ZCode's default model choice.
function mentions(value, id) {
  if (Array.isArray(value)) return value.some(v => mentions(v, id));
  return Boolean(value) && typeof value === 'object' && (value.providerId === id || Object.values(value).some(v => mentions(v, id)));
}
// True when anything under value still names one model of the provider, such as ZCode's default model choice.
function mentionsModel(value, id, modelId) {
  if (Array.isArray(value)) return value.some(v => mentionsModel(v, id, modelId));
  return Boolean(value) && typeof value === 'object' && ((value.providerId === id && value.modelId === modelId) || Object.values(value).some(v => mentionsModel(v, id, modelId)));
}
// A template service takes its address from ZCode's built-in template, so only its key can be changed here.
function publicProvider(p) {
  const models = providerModels(p.config);
  return { id: p.providerId, name: p.providerName || p.providerId, baseUrl: p.config.api?.baseUrl || '', protocol: p.config.api?.type || '', hasKey: Boolean(p.config.access?.apiKey), fixedAddress: Boolean(p.templateId), modelCount: models.length, models };
}
export function parseModels(doc) {
  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.data) ? doc.data : doc?.models;
  if (!Array.isArray(list)) throw new PanelError('接口返回的内容不是可识别的模型列表。支持 data 数组、models 数组或直接数组。');
  const models = new Map();
  for (const x of list) {
    const id = typeof x === 'string' ? x : x?.id || x?.name;
    if (typeof id !== 'string' || !id.trim() || id.length > 512 || /[\x00-\x1F]/.test(id)) continue;
    const clean = id.trim();
    if (!models.has(clean)) { const meta = apiMetadata(x); models.set(clean, { id: clean, ...(Object.keys(meta).length ? { apiMetadata: meta } : {}) }); }
    if (models.size > 5000) throw new PanelError('返回的模型超过 5000 个，请使用范围更小的供应商接口。');
  }
  if (!models.size) throw new PanelError('接口连接成功，但没有返回任何模型。请检查密钥权限或供应商配置。');
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}
async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new PanelError('模型列表响应为空。');
  const chunks = []; let length = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length;
    if (length > 4 * 1024 * 1024) { await reader.cancel(); throw new PanelError('接口响应超过 4 MB，未继续读取。'); } chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new PanelError('接口没有返回 JSON 模型列表，请确认 URL 指向 API 服务。'); }
}

// A site key gets a service of its own, so two keys of one site group never overwrite each other's key.
const keyMatches = (p, s) => !s.siteKey || p.config?.access?.apiKey === s.apiKey;

export class Harbor {
  constructor({ configPath = CONFIG_PATH, fetchImpl = fetch, timeoutMs = 12000, builtinConfigPath = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || process.env.MODEL_HARBOR_BUILTIN_PATH, refreshCatalog = true, metadataCatalog, site = null } = {}) { this.configPath = configPath; this.site = site; this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs; this.sessions = new Map(); this.builtinConfigPath = builtinConfigPath; this.metadataCatalog = metadataCatalog || new MetadataCatalog({ builtinConfigPath, zcodeDir: path.dirname(configPath), refresh: refreshCatalog }); }
  async resolvedProvider(p) {
    let templates = DEFAULT_TEMPLATES;
    if (this.builtinConfigPath) { try { templates = JSON.parse(await fs.readFile(this.builtinConfigPath, 'utf8')).config.providerConfigRules.templateRules; } catch {} }
    const fallback = templates?.find(t => t.templateId === p.templateId)?.config || {};
    return { ...p, config: { ...fallback, ...p.config, api: { ...fallback.api, ...p.config.api }, access: { ...fallback.access, ...p.config.access } } };
  }
  async personalProviders() {
    const { doc } = await readConfig(this.configPath);
    const resolved = await Promise.all(doc.config.providerConfigRules.providerRules.map(p => this.resolvedProvider(p)));
    return resolved.filter(listed);
  }
  // The rule behind a service the panel lists; changes and deletes reach no other provider.
  async listedProvider(doc, providerId) {
    const target = typeof providerId === 'string' && providerId ? doc.config.providerConfigRules.providerRules.find(p => p.providerId === providerId) : null;
    const resolved = target ? await this.resolvedProvider(target) : null;
    if (!resolved || !listed(resolved)) throw new PanelError('没有找到这个服务，可能已在 ZCode 里删除。');
    return { target, resolved };
  }
  async providers() { return { providers: (await this.personalProviders()).map(publicProvider) }; }
  requireSite() { if (!this.site) throw new PanelError('站内账户不可用。'); return this.site; }
  // balanceOnly reads the balance alone, for the panel's timer; the keys and groups the last full read found stay as they were.
  async siteAccount({ balanceOnly = false } = {}) { const site = this.requireSite(); return balanceOnly === true ? site.balance() : this.markInZCode(await site.overview()); }
  async siteLogin(input) { return this.markInZCode(await this.requireSite().login(input)); }
  siteLogout() { return this.requireSite().logout(); }
  // Marks each site key, and each site group, with the ZCode services that already hold it; the comparison stays on the server.
  // A group also names, by id only, the site key (keyId) the panel opens its models with, under the group, to choose which
  // of them ZCode uses: the key its service in ZCode uses, or for a group not in ZCode one of its keys that works.
  async markInZCode(data) {
    if (!data.keys?.length && !data.groups?.length) return data;
    const providers = await this.personalProviders().catch(() => []);
    for (const k of data.keys || []) {
      const value = this.site.keys.get(k.id)?.key, p = value && providers.find(p => p.config.access?.apiKey === value);
      if (p) k.inZCode = p.providerName || p.providerId;
    }
    for (const g of data.groups || []) {
      const group = this.site.groups.get(g.id), held = this.groupProviders(providers, group);
      if (!held.length) { const key = group?.keys.find(k => this.site.usable(k.id)); if (key && !g.blocked) g.keyId = key.id; continue; }
      g.inZCode = held.map(p => ({ name: p.providerName || p.providerId, modelCount: providerModels(p.config).length }));
      const values = new Set(held.map(p => p.config.access?.apiKey));
      const key = group.keys.map(k => this.site.keys.get(k.id)).find(k => k?.key && !k.blocked && values.has(k.key));
      if (key) g.keyId = key.id;
    }
    return data;
  }
  // The listed services on the site's own address.
  siteProviders(providers) {
    const onSite = url => { try { return new URL(url).origin === this.site.origin; } catch { return false; } };
    return providers.filter(p => onSite(p.config.api?.baseUrl));
  }
  // The listed services that use one of a site group's keys on the site's own address.
  groupProviders(providers, group) {
    const values = new Set((group?.keys || []).map(k => k.key).filter(Boolean));
    return this.siteProviders(providers).filter(p => values.has(p.config.access?.apiKey));
  }
  // 添加分组: the group's own key, or a key made on the site after the panel asked, fetches the group's models from the
  // site's gateway, and all of them go to ZCode in one write, as a service named after the group. A group already in
  // ZCode goes with the key its service there has, so the models it lacks join that service instead of a second one.
  // The panel adds no model unticked: it passes keyOnly, which stops once the key is found or made and returns its id
  // alone, and then opens the group's models with that key (as with markInZCode's keyId) for the user to tick.
  async siteAddGroup({ groupId, createKey = false, keyOnly = false } = {}) {
    const site = this.requireSite();
    return this.oneSiteChange(async () => {
      const inZCode = new Set(this.siteProviders(await this.personalProviders().catch(() => [])).map(p => p.config.access?.apiKey).filter(Boolean));
      const { group, key, created } = await site.groupKey(groupId, { create: createKey === true, prefer: value => inZCode.has(value) });
      if (keyOnly === true) return { groupId: group.id, groupName: group.name, keyId: key.id, ...(created ? { createdKey: key.name } : {}) };
      let fetched;
      try {
        fetched = await this.fetchModels({ baseUrl: key.baseUrl, protocol: key.protocol, siteKeyId: key.id });
        const r = await this.importModels({ sessionId: fetched.sessionId, modelIds: fetched.models.map(m => m.id), providerName: `${site.name} · ${group.name}`.slice(0, 100) });
        return { groupId: group.id, groupName: group.name, providerName: r.providerName, models: fetched.count, added: r.added, ...(created ? { createdKey: key.name } : {}), ...(r.unchanged ? { unchanged: true } : {}) };
      } catch (e) {
        if (created && e instanceof PanelError) throw new PanelError(`已在网站上为「${group.name}」新建 Key「${key.name}」，但没能加入 ZCode：${e.message} 再次添加会沿用这个 Key。`);
        throw e;
      } finally { if (fetched) this.sessions.delete(fetched.sessionId); }
    });
  }
  // 删除分组: every listed service that uses one of the group's keys on the site's address leaves ZCode, each through
  // deleteProvider (a backup each, and refused while ZCode's default model is there). The keys on the site stay.
  async siteRemoveGroup({ groupId } = {}) {
    const site = this.requireSite();
    return this.oneSiteChange(async () => {
      const group = await site.group(groupId);
      const held = this.groupProviders(await this.personalProviders(), group);
      if (!held.length) throw new PanelError(`ZCode 里没有「${group.name}」的服务。`);
      const removed = [];
      for (const p of held) {
        try { removed.push((await this.deleteProvider({ providerId: p.providerId })).providerName); }
        catch (e) { if (removed.length && e instanceof PanelError) throw new PanelError(`已删除「${removed.join('」「')}」；「${p.providerName || p.providerId}」没有删除：${e.message}`); throw e; }
      }
      return { groupId: group.id, groupName: group.name, removed, models: held.reduce((n, p) => n + providerModels(p.config).length, 0) };
    });
  }
  // 删除站内 Key: every listed service that holds the key, at any address, leaves ZCode first, all in one write and without
  // a backup, since the user confirmed it in the panel; only then is the key deleted on the site, so ZCode never keeps a
  // key the site no longer has. While ZCode's default model, or another setting, still uses one of them, nothing is
  // deleted, in ZCode or on the site.
  async siteDeleteKey({ siteKeyId } = {}) {
    const site = this.requireSite();
    return this.oneSiteChange(async () => {
      const k = site.key(siteKeyId);
      if (k.testKey) throw new PanelError('这是网站用来测试分组的 Key，网站上也不能删除。');
      const held = k.key ? (await this.personalProviders()).filter(p => p.config.access?.apiKey === k.key) : [];
      let removed = [];
      if (held.length) {
        try { ({ removed } = await this.changeConfig(async doc => ({ removed: await this.removeProviders(doc, held.map(p => p.providerId)) }), '本次删除已取消。请再试一次。', { backup: false })); }
        catch (e) {
          if (e instanceof StillUsed) throw new PanelError(`「${e.providerName}」还在被 ZCode 的默认模型或其他设置使用，网站上的 Key 和 ZCode 里的服务都没有删除。请先在 ZCode 里换成其他服务的模型，再删除。`);
          if (e instanceof PanelError) throw new PanelError(`${e.message} 网站上的 Key 没有删除。`);
          throw e;
        }
      }
      try { await site.deleteKey(k.id); }
      catch (e) { if (removed.length && e instanceof PanelError) throw new PanelError(`已从 ZCode 删除「${removed.join('」「')}」，但网站上的 Key 没有删除：${e.message}`); throw e; }
      return { siteKeyId: k.id, keyName: k.name, removed, models: held.reduce((n, p) => n + providerModels(p.config).length, 0) };
    });
  }
  // One site change at a time (a group added or removed, a key deleted), so two quick clicks cannot make two keys for
  // one group, nor delete a key while a group is being added with it.
  oneSiteChange(work) { const run = (this.siteChanges || Promise.resolve()).then(work); this.siteChanges = run.catch(() => {}); return run; }
  // The only result that carries a key: one listed provider's, or one site key's, when the panel's eye button asks for it.
  async revealKey({ providerId, siteKeyId } = {}) {
    if (siteKeyId !== undefined) {
      const k = this.requireSite().key(siteKeyId);
      if (!k.key) throw new PanelError('网站没有返回这个 Key 的完整内容。');
      return { siteKeyId: k.id, apiKey: k.key };
    }
    const p = typeof providerId === 'string' && providerId ? (await this.personalProviders()).find(x => x.providerId === providerId) : null;
    if (!p) throw new PanelError('没有找到这个服务，可能已在 ZCode 里删除。');
    const apiKey = p.config.access?.apiKey;
    if (typeof apiKey !== 'string' || !apiKey) throw new PanelError('这个服务没有保存 Key。');
    return { id: p.providerId, apiKey };
  }
  async fetchModels({ baseUrl, apiKey = '', protocol = 'openai-chat-completions', existingProviderId = '', siteKeyId } = {}) {
    baseUrl = normalizeUrl(baseUrl);
    if (!PROTOCOLS.has(protocol)) throw new PanelError('请选择支持的接口协议。');
    if (typeof apiKey !== 'string' || apiKey.length > 8192 || /[\r\n]/.test(apiKey)) throw new PanelError('API Key 格式无效。');
    let savedHeaders, savedKey, siteKey = false;
    // A site key is filled in here, never by the panel, and goes only to the site's own gateway.
    if (siteKeyId !== undefined && siteKeyId !== '') {
      const site = this.requireSite(), k = site.key(siteKeyId);
      if (existingProviderId || apiKey.trim()) throw new PanelError('已选择站内 Key，请清空 API Key 并取消选择已保存的服务。');
      if (new URL(baseUrl).origin !== site.origin) throw new PanelError(`站内 Key 只能发往 ${new URL(site.origin).host} 的接口地址。`);
      if (k.blocked) throw new PanelError(k.blocked);
      apiKey = k.key; siteKey = true;
    }
    if (existingProviderId) {
      const { doc } = await readConfig(this.configPath);
      const original = doc.config.providerConfigRules.providerRules.find(p => p.providerId === existingProviderId);
      const saved = original ? await this.resolvedProvider(original) : null;
      if (!saved || !saved.config.api?.baseUrl || normalizeUrl(saved.config.api.baseUrl) !== baseUrl) throw new PanelError('地址已变更，请填写这个地址对应的 API Key。');
      savedKey = saved.config.access?.apiKey || '';
      apiKey = apiKey.trim() || savedKey;
      savedHeaders = saved.config.api.headers;
    }
    apiKey = apiKey.trim();
    if (!apiKey) throw new PanelError('请输入 API Key，或选择已保存密钥的供应商。');
    const headers = { ...(savedHeaders || {}), Accept: 'application/json', Authorization: `Bearer ${apiKey}` };
    if (protocol === 'anthropic-messages') { headers['x-api-key'] = apiKey; headers['anthropic-version'] = '2023-06-01'; }
    const candidates = [...new Set([`${baseUrl}/models`, ...(/\/(v\d+|v\d+beta)$/.test(baseUrl) ? [] : [`${baseUrl}/v1/models`]), ...(/\/anthropic$/.test(baseUrl) ? [`${baseUrl.slice(0, -10)}/models`, `${baseUrl.slice(0, -10)}/v1/models`] : [])])];
    const failures = [];
    for (const endpoint of candidates) {
      let response;
      try { response = await this.fetchImpl(endpoint, { headers, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) }); }
      catch { failures.push('连接失败或超时'); continue; }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) throw new PanelError(`接口拒绝访问（${response.status}），请检查 API Key 和模型列表权限。`);
        failures.push(`HTTP ${response.status}`); continue;
      }
      let models;
      try { models = parseModels(await boundedJson(response)); } catch (e) { failures.push(e instanceof PanelError ? e.message : '无法读取响应'); continue; }
      // The service an import would add to; models it already has come back marked inZCode, and the ones it has that the
      // service no longer lists come back in missing, so the panel can offer to take them out.
      let providerId = existingProviderId, templateId, savedRules = [], saved = new Set(), personal = [];
      try {
        const { doc } = await readConfig(this.configPath);
        const candidate = doc.config.providerConfigRules.providerRules.find(p => p.providerId === existingProviderId) || doc.config.providerConfigRules.providerRules.find(p => p.config?.api?.baseUrl && normalizeUrl(p.config.api.baseUrl) === baseUrl && p.config.api.type === protocol && keyMatches(p, { siteKey, apiKey }));
        providerId = candidate?.providerId; templateId = candidate?.templateId;
        savedRules = [...doc.config.modelConfigRules.providerModelRules, ...doc.config.modelConfigRules.manualProviderModelRules];
        if (candidate) { const config = (await this.resolvedProvider(candidate)).config; saved = new Set(providerModels(config)); personal = [...saved].filter(id => config.personalModelIds?.includes(id)); }
      } catch {}
      models = (await this.metadataCatalog.enrich(models, { baseUrl, protocol, providerId, templateId, savedRules })).map(m => saved.has(m.id) ? { ...m, inZCode: true } : m);
      const listedIds = new Set(models.map(m => m.id)), missing = personal.filter(id => !listedIds.has(id));
      const now = Date.now();
      for (const [id, s] of this.sessions) if (now - s.created > 30 * 60 * 1000) this.sessions.delete(id);
      if (this.sessions.size >= 40) this.sessions.delete(this.sessions.keys().next().value);
      const sessionId = crypto.randomUUID();
      this.sessions.set(sessionId, { created: now, baseUrl, apiKey, protocol, models, missing, existingProviderId, savedHeaders, savedKey, siteKey });
      return { sessionId, models, missing, endpoint, baseUrl, count: models.length };
    }
    throw new PanelError(`未找到可用的模型列表：${[...new Set(failures)].join('；')}。请确认服务商支持 /models 或 /v1/models。`);
  }
  getModels({ sessionId, offset = 0 } = {}) {
    const s = this.sessions.get(sessionId);
    if (!s || Date.now() - s.created > 30 * 60 * 1000) throw new PanelError('拉取结果已过期，请重新拉取。');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > s.models.length) throw new PanelError('模型分页位置无效。');
    return { models: s.models.slice(offset, offset + 25), nextOffset: offset + 25 < s.models.length ? offset + 25 : null };
  }
  // 测试连接: one short request to one model of a fetch, asking for the reply OK with at most 2048 tokens of output and
  // no thinking settings, to see that the model answers through this service at all.
  async testModel({ sessionId, modelId } = {}) {
    const s = this.sessions.get(sessionId);
    if (!s || Date.now() - s.created > 30 * 60 * 1000) throw new PanelError('拉取结果已过期，请重新拉取。');
    const model = s.models.find(m => m.id === modelId);
    if (!model) throw new PanelError('只能测试本次拉取的模型。');
    const cap = Math.min(model.metadata?.maxOutputTokens || 2048, 2048);
    const base = s.baseUrl, prompt = 'Reply with exactly OK. No explanation.';
    const headers = { ...(s.savedHeaders || {}), 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` };
    let endpoint, body;
    if (s.protocol === 'anthropic-messages') {
      endpoint = `${base}${/\/v1$/.test(base) ? '' : '/v1'}/messages`; headers['x-api-key'] = s.apiKey; headers['anthropic-version'] = '2023-06-01';
      body = { model: modelId, max_tokens: cap, messages: [{ role: 'user', content: prompt }] };
    } else if (s.protocol === 'openai-responses') {
      endpoint = `${base}/responses`; body = { model: modelId, max_output_tokens: cap, input: prompt };
    } else {
      endpoint = `${base}/chat/completions`; body = { model: modelId, max_completion_tokens: cap, messages: [{ role: 'user', content: prompt }] };
    }
    const start = Date.now();
    try {
      const res = await this.fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30000) });
      const data = await boundedJson(res);
      const text = s.protocol === 'anthropic-messages' ? data.content?.filter(c => c.type === 'text').map(c => c.text).join('') : s.protocol === 'openai-responses' ? data.output?.flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('') : data.choices?.[0]?.message?.content;
      const clean = value => String(value || '').split(s.apiKey).join('[redacted]').slice(0, 250);
      return { modelId, ok: res.ok && typeof text === 'string' && text.trim() === 'OK', status: res.status, elapsedMs: Date.now() - start, reply: clean(text), error: res.ok ? text?.trim() === 'OK' ? null : '接口有响应，但未返回预期文本；请检查额度提示、输出截断或协议差异。' : clean(data.error?.message || data.message || `HTTP ${res.status}`), outputCapUsed: cap, scope: 'short-text-only' };
    } catch (e) { return { modelId, ok: false, elapsedMs: Date.now() - start, error: e instanceof PanelError ? e.message : '请求失败或超时，请检查接口连接。', scope: 'short-text-only' }; }
  }
  // Adds the chosen models of a fetch to their service. A model new to the service gets the fetch's plan for it
  // (metadata.mjs: ZCode's own values where its rules know the model, else 256K / 128K / low·high·max, lowered by what
  // the service or the catalog states), only in fields its rule leaves empty; models the service already has, and every
  // other service, stay as they are. Everything else about a model is set in ZCode.
  // removeModelIds takes models out of that service instead (the panel's unticked ones): only models of this fetch, or
  // ones the service has that the fetch no longer listed, only models added to it rather than built in, never the last
  // one, and none that ZCode's default model or another setting still names; their model settings go with them.
  async importModels({ sessionId, modelIds = [], removeModelIds = [], providerName } = {}) {
    const s = this.sessions.get(sessionId);
    if (!s || Date.now() - s.created > 30 * 60 * 1000) { this.sessions.delete(sessionId); throw new PanelError('拉取结果已过期，请重新拉取模型。'); }
    if (!Array.isArray(removeModelIds) || removeModelIds.length > 5000 || removeModelIds.some(id => typeof id !== 'string' || (!s.models.some(m => m.id === id) && !s.missing?.includes(id)))) throw new PanelError('只能移除本次读取时这个服务里的模型，请重新读取模型。');
    if (!Array.isArray(modelIds) || (!modelIds.length && !removeModelIds.length) || modelIds.length > 5000 || modelIds.some(id => !s.models.some(m => m.id === id))) throw new PanelError('请至少选择一个本次拉取的模型。');
    if (modelIds.some(id => removeModelIds.includes(id))) throw new PanelError('同一个模型不能既添加又移除。');
    providerName = String(providerName || new URL(s.baseUrl).hostname).trim();
    if (!providerName || providerName.length > 100 || /[\x00-\x1F]/.test(providerName)) throw new PanelError('供应商名称应为 1–100 个字符。');
    return this.changeConfig(async doc => {
      const rules = doc.config.providerConfigRules.providerRules;
      let target = s.existingProviderId ? rules.find(p => p.providerId === s.existingProviderId) : rules.find(p => p.config?.group === 'standard-personal' && p.config.api?.baseUrl && normalizeUrl(p.config.api.baseUrl) === s.baseUrl && p.config.api.type === s.protocol && keyMatches(p, s));
      const resolvedTarget = target ? await this.resolvedProvider(target) : null;
      // The saved key may only be the one fetched with or the one this session brings, so a key changed in the
      // services list after fetching is never overwritten by an import.
      const savedKey = resolvedTarget?.config.access?.apiKey || '';
      if (s.existingProviderId && (!target || normalizeUrl(resolvedTarget.config.api?.baseUrl) !== s.baseUrl || resolvedTarget.config.api?.type !== s.protocol || (savedKey !== s.savedKey && savedKey !== s.apiKey))) throw new PanelError('原供应商配置已变化，请重新选择供应商并拉取。');
      const created = !target;
      if (target && target.config?.group !== 'standard-personal') throw new PanelError('只支持导入自定义供应商。');
      if (created && removeModelIds.length) throw new PanelError('这个服务已不在 ZCode 里，没有可移除的模型。请重新读取模型。');
      if (!target) {
        target = { providerId: `model-harbor-${crypto.randomUUID()}`, providerName, config: { group: 'standard-personal', access: { type: 'api-key', apiKey: s.apiKey }, api: { type: s.protocol, baseUrl: s.baseUrl, ...(s.savedHeaders ? { headers: s.savedHeaders } : {}) }, personalModelIds: [], modelOrder: [] } };
        rules.push(target);
        doc.config.providerOrder = [...(doc.config.providerOrder || rules.filter(p => p !== target).map(p => p.providerId)), target.providerId];
      }
      const credentialChanged = !created && target.config.access?.apiKey !== s.apiKey;
      if (credentialChanged) target.config.access = { ...target.config.access, type: 'api-key', apiKey: s.apiKey };
      const existing = new Set([...(resolvedTarget?.config.builtinModelIds || []), ...(target.config.personalModelIds || [])]);
      const selected = [...new Set(modelIds)];
      const added = selected.filter(id => !existing.has(id));
      target.config.personalModelIds = [...new Set([...(target.config.personalModelIds || []), ...added])];
      target.config.modelOrder = [...new Set([...(target.config.modelOrder || []), ...target.config.personalModelIds])];
      const modelRules = doc.config.modelConfigRules, fresh = new Set(added);
      let rulesAdded = false;
      for (const modelId of selected) {
        let rule = [...modelRules.providerModelRules, ...modelRules.manualProviderModelRules].find(r => r.providerId === target.providerId && r.modelId === modelId);
        if (!rule) { rule = { providerId: target.providerId, modelId, config: { enabled: true } }; modelRules.providerModelRules.push(rule); rulesAdded = true; }
        if (fresh.has(modelId)) applyPlan(rule.config, s.models.find(m => m.id === modelId).plan);
      }
      const builtin = new Set(resolvedTarget?.config.builtinModelIds || []), removed = [];
      for (const modelId of new Set(removeModelIds)) {
        if (builtin.has(modelId)) throw new PanelError(`「${modelId}」是 ZCode 内置的模型，不能在这里移除。`);
        if (!target.config.personalModelIds?.includes(modelId)) continue;
        target.config.personalModelIds = target.config.personalModelIds.filter(id => id !== modelId);
        target.config.modelOrder = (target.config.modelOrder || []).filter(id => id !== modelId);
        modelRules.providerModelRules = modelRules.providerModelRules.filter(r => r.providerId !== target.providerId || r.modelId !== modelId);
        modelRules.manualProviderModelRules = modelRules.manualProviderModelRules.filter(r => r.providerId !== target.providerId || r.modelId !== modelId);
        if (mentionsModel(doc.config, target.providerId, modelId)) throw new PanelError(`「${modelId}」还是 ZCode 的默认模型，或在其他设置里使用，没有改动。请先在 ZCode 里换成其他模型，再取消勾选。`);
        removed.push(modelId);
      }
      if (removed.length && !builtin.size && !target.config.personalModelIds.length) throw new PanelError('至少要保留一个模型，没有改动。不再使用这个服务的话，请删除它。');
      if (!created && !added.length && !removed.length && !credentialChanged && !rulesAdded) return { added: 0, removed: 0, selected: selected.length, providerName: target.providerName, unchanged: true };
      return { added: added.length, removed: removed.length, selected: selected.length, providerName: target.providerName, created };
    }, '本次导入已取消。请再次点击导入。');
  }
  // Changes a listed service's address or key. An empty key keeps the saved one, and the result never carries a key.
  async updateProvider({ providerId, baseUrl, apiKey = '' } = {}) {
    if (typeof apiKey !== 'string' || apiKey.length > 8192 || /[\r\n]/.test(apiKey)) throw new PanelError('API Key 格式无效。');
    const address = normalizeUrl(baseUrl), key = apiKey.trim();
    return this.changeConfig(async doc => {
      const { target, resolved } = await this.listedProvider(doc, providerId);
      let urlChanged; try { urlChanged = normalizeUrl(resolved.config.api.baseUrl) !== address; } catch { urlChanged = true; }
      if (urlChanged && target.templateId) throw new PanelError('这个服务的地址来自 ZCode 内置模板，这里只能修改 Key。');
      const keyChanged = Boolean(key) && key !== resolved.config.access?.apiKey;
      if (urlChanged) target.config.api = { ...target.config.api, baseUrl: address };
      if (keyChanged) target.config.access = { ...target.config.access, type: 'api-key', apiKey: key };
      return { id: target.providerId, providerName: target.providerName || target.providerId, urlChanged, keyChanged, ...(urlChanged || keyChanged ? {} : { unchanged: true }) };
    }, '本次修改已取消。请再试一次。');
  }
  // Removes a listed service with its place in the provider order and its model settings. A service that other settings
  // still name, such as ZCode's default model, stays.
  async deleteProvider({ providerId } = {}) {
    return this.changeConfig(async doc => {
      const [providerName] = await this.removeProviders(doc, [providerId]);
      return { id: providerId, providerName };
    }, '本次删除已取消。请再试一次。');
  }
  // Takes listed services out of the parsed config, with their places in the provider order and their model settings,
  // and returns their names. If other settings still name one of them, such as ZCode's default model, it throws
  // StillUsed and the write is cancelled, so none of them goes.
  async removeProviders(doc, providerIds) {
    const config = doc.config, modelRules = config.modelConfigRules, gone = [];
    for (const providerId of providerIds) {
      const { target } = await this.listedProvider(doc, providerId), id = target.providerId;
      config.providerConfigRules.providerRules = config.providerConfigRules.providerRules.filter(p => p !== target);
      if (Array.isArray(config.providerOrder)) config.providerOrder = config.providerOrder.filter(x => x !== id);
      modelRules.providerModelRules = modelRules.providerModelRules.filter(r => r.providerId !== id);
      modelRules.manualProviderModelRules = modelRules.manualProviderModelRules.filter(r => r.providerId !== id);
      gone.push({ id, name: target.providerName || id });
    }
    const used = gone.find(p => mentions(config, p.id));
    if (used) throw new StillUsed(used.name);
    return gone.map(p => p.name);
  }
  // Every change to the ZCode config goes through here: one writer at a time, the old file backed up as it was (unless
  // backup is false: deleting a site key, which the user confirmed), and nothing written if ZCode saved the file in the
  // meantime; after the write the ten newest backups stay. change edits the parsed config and returns the result; a
  // result marked unchanged writes nothing.
  async changeConfig(change, cancelled, { backup = true } = {}) {
    const lockPath = `${this.configPath}.model-harbor.lock`;
    let lock;
    try { lock = await fs.open(lockPath, 'wx', 0o600); } catch { throw new PanelError('配置正被同步，或上次写入未完成。请稍后重试；若一直出现，请检查配置旁的 model-harbor.lock 文件。'); }
    let temporary;
    try {
      const { doc, raw } = await readConfig(this.configPath);
      const result = await change(doc);
      validateConfig(doc);
      if (result.unchanged) return result;
      const suffix = crypto.randomBytes(4).toString('hex'), backupDir = path.join(path.dirname(this.configPath), 'backups', 'model-harbor');
      let backupPath;
      if (backup) {
        await fs.mkdir(backupDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        backupPath = path.join(backupDir, `provider_config-${stamp}-${suffix}.json`);
        await fs.writeFile(backupPath, raw, { mode: 0o600, flag: 'wx' });
      }
      temporary = `${this.configPath}.model-harbor-${suffix}.tmp`;
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(doc, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
      if (await fs.readFile(this.configPath, 'utf8') !== raw) throw new PanelError(`ZCode 刚刚更新了配置，${cancelled}`);
      await fs.rename(temporary, this.configPath); temporary = null;
      await pruneBackups(backupDir, backupPath && path.basename(backupPath));
      return backupPath ? { ...result, backupPath } : result;
    } finally { if (temporary) await fs.unlink(temporary).catch(() => {}); await lock.close(); await fs.unlink(lockPath).catch(() => {}); }
  }
}
