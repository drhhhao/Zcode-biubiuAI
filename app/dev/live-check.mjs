import fs from 'node:fs/promises';
import path from 'node:path';
import { BiubiuAI, CONFIG_PATH } from '../lib/core.mjs';

// Explicit integration check requested by the user. Logs contain no credentials.
const apply = process.argv.includes('--apply');
const chat = process.argv.includes('--chat');
const h = new BiubiuAI({ builtinConfigPath: 'E:/Zcode/resources/config/provider/zcode-builtin.json' });
const report = { checkedAt: new Date().toISOString(), configuration: CONFIG_PATH, apply, chat, providers: [] };
for (const p of (await h.providers()).providers) {
  const row = { name: p.name, id: p.id, baseUrl: p.baseUrl, protocol: p.protocol, previouslyConfigured: p.modelCount };
  report.providers.push(row);
  console.log(JSON.stringify({ provider: p.name, phase: 'fetch' }));
  try {
    const r = await h.fetchModels({ baseUrl: p.baseUrl, protocol: p.protocol, existingProviderId: p.id });
    row.fetch = { ok: true, count: r.count, endpoint: r.endpoint, models: r.models.map(m => m.id) };
    if (apply) row.import = await h.importModels({ sessionId: r.sessionId, modelIds: r.models.map(m => m.id), providerName: p.name });
  } catch (e) { row.fetch = { ok: false, error: e.message }; }
  console.log(JSON.stringify({ provider: p.name, fetch: row.fetch, imported: row.import }));
  if (!chat) continue;
  const doc = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  const saved = doc.config.providerConfigRules.providerRules.find(x => x.providerId === p.id);
  const ids = row.fetch.ok ? row.fetch.models : [...new Set([...(saved.config.personalModelIds || []), ...(saved.config.modelOrder || [])])];
  row.calls = [];
  for (const model of ids) {
    const apiKey = saved.config.access.apiKey;
    const base = p.baseUrl.replace(/\/+$/, '');
    const anthropic = p.protocol === 'anthropic-messages';
    const endpoint = anthropic ? `${base}${/\/v1$/.test(base) ? '' : '/v1'}/messages` : `${base}/chat/completions`;
    const headers = { ...(saved.config.api?.headers || {}), 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` };
    if (anthropic) { headers['x-api-key'] = apiKey; headers['anthropic-version'] = '2023-06-01'; }
    const body = { model, max_tokens: 32, messages: [{ role: 'user', content: 'Reply with exactly OK. No explanation.' }] };
    const start = Date.now();
    let item;
    try {
      const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45000), redirect: 'error' });
      const raw = await res.text(); let j; try { j = JSON.parse(raw); } catch {}
      const reply = anthropic ? j?.content?.filter(x => x.type === 'text').map(x => x.text).join('') : j?.choices?.[0]?.message?.content;
      let error = res.ok ? null : j?.error?.message || j?.message || `HTTP ${res.status}`;
      if (error) error = String(error).split(apiKey).join('[redacted]').slice(0,400);
      item = { model, status: res.status, ok: res.ok && typeof reply === 'string' && reply.trim() === 'OK', reply: typeof reply === 'string' ? reply.slice(0,100) : '', error: error || (res.ok && reply?.trim() !== 'OK' ? 'Response did not match expected OK; check reply for provider quota or other service message.' : null), elapsedMs: Date.now() - start };
    } catch (e) { item = { model, ok: false, error: e.name, elapsedMs: Date.now() - start }; }
    row.calls.push(item); console.log(JSON.stringify({ provider: p.name, call: item }));
  }
}
await fs.writeFile(new URL('../../build/plugin-era-reports/live-report.json', import.meta.url), JSON.stringify(report, null, 2));
console.log('Report saved: live-report.json');
