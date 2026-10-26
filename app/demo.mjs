// The demo account and demo service behind the browser preview (app/preview.mjs) and the tutorial's screenshots
// (build/companion-dev/docs-shots.mjs): fake keys, groups, balance and models, answered here without the network.
// The local service never loads this file, so the installer does not carry it.
import { SITE } from './lib/site.mjs';

export const DEMO = Object.freeze({ email: 'demo@example.com', password: 'demo' });
export const DEMO_SERVICE = Object.freeze({ baseUrl: 'https://api.example.com/v1', apiKey: 'demo-key' });

// Each call starts a fresh demo: keys, groups and balance change as the panel uses them.
export function demoBackend() {
  const sampleIds = ['claude-opus-5-5', 'claude-sonnet-5-5', 'deepseek-v4-pro', 'gemini-3.8-pro', 'glm-5.3', 'gpt-6', 'gpt-6-mini', 'qwen3.8-plus'];
  const ok = () => Promise.resolve(Response.json({ content: [{ type: 'text', text: 'OK' }], choices: [{ message: { content: 'OK' } }], output: [{ content: [{ type: 'output_text', text: 'OK' }] }] }));
  const keys = [
    { id: 11, name: 'Claude 主力', key: 'sk-demo-claude-0123456789abcdef', status: 'active', groupName: 'Claude Max', groupPlatform: 'anthropic', quota: 0, quotaUsed: 12.34 },
    { id: 12, name: 'Codex', key: 'sk-demo-codex-0123456789abcdef', status: 'active', groupName: 'GPT Plus', groupPlatform: 'openai', quota: 100, quotaUsed: 37.5, expiresAt: '2027-03-31T00:00:00Z' },
    { id: 13, name: 'Gemini', key: 'sk-demo-gemini-0123456789abcdef', status: 'active', groupName: 'Gemini Pro', groupPlatform: 'gemini' },
    { id: 14, name: '旧 Key', key: 'sk-demo-old-0123456789abcdef', status: 'inactive', groupName: 'Claude Max', groupPlatform: 'anthropic' },
  ];
  // The demo groups name their keys; 添加分组 on a group without a working key makes a demo key here.
  const groups = [
    { upstreamGroupId: 101, name: 'Claude Max', platform: 'anthropic', effectiveMultiplier: 1, remark: 'Claude 官方渠道', keyIds: [11, 14] },
    { upstreamGroupId: 102, name: 'GPT Plus', platform: 'openai', effectiveMultiplier: 0.8, keyIds: [12] },
    { upstreamGroupId: 103, name: 'Gemini Pro', platform: 'gemini', effectiveMultiplier: 0.5, keyIds: [13] },
    { upstreamGroupId: 104, name: 'Claude Pro', platform: 'anthropic', effectiveMultiplier: 0.6, remark: '性价比渠道', keyIds: [] },
    { upstreamGroupId: 105, name: 'Grok 4', platform: 'grok', effectiveMultiplier: 0.9, keyIds: [] },
  ];
  // The demo balance drops a little on each read, as if in use, so the panel's 30-second balance reads show.
  let balance = 128.5;
  const models = { anthropic: ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'], openai: ['gpt-6', 'gpt-6-codex', 'gpt-6-mini'], grok: ['grok-5', 'grok-5-mini'] };
  const reply = (data, status = 200) => Promise.resolve(Response.json(data, { status }));

  function siteFetch(url, options) {
    const { pathname } = new URL(url), body = options.body ? JSON.parse(options.body) : {};
    if (pathname === '/api/client/platforms/1/groups') return reply({ items: groups.map(({ keyIds, ...g }) => ({ ...g, apiKeys: keyIds.map(id => keys.find(k => k.id === id)).map(k => ({ id: k.id, name: k.name, key: k.key })) })), apiKeySync: { neverSynced: false } });
    const made = /^\/api\/client\/platforms\/1\/groups\/(\d+)\/keys$/.exec(pathname);
    if (made && options.method === 'POST') {
      const group = groups.find(g => String(g.upstreamGroupId) === made[1]);
      if (!group) return reply({ code: 404, message: '分组不存在', data: null }, 404);
      const id = 20 + keys.length, key = { id, name: body.name, key: `sk-demo-${group.platform}-${id}-0123456789abcdef`, status: 'active', groupName: group.name, groupPlatform: group.platform, quota: 0, quotaUsed: 0 };
      keys.push(key); group.keyIds.push(id);
      return reply({ id, name: key.name, key: key.key, status: 'active' });
    }
    if (pathname === '/api/auth/login') return body.password === DEMO.password ? reply({ accessToken: 'demo-access', refreshToken: 'demo-refresh', user: { email: DEMO.email } }) : reply({ code: 401, message: '邮箱或密码错误', data: null }, 401);
    if (pathname === '/api/auth/refresh') return reply({ accessToken: 'demo-access', refreshToken: 'demo-refresh' });
    if (pathname === '/api/client/platforms') return reply([{ id: 1, name: 'biubiu AI', baseUrl: SITE.origin, isMain: true }]);
    if (pathname === '/api/client/platforms/1/accounts') return reply([{ id: 7, email: DEMO.email }]);
    if (pathname === '/api/client/platforms/1/balance-summary') { const now = balance; balance = Math.max(0, Math.round((balance - 0.37) * 100) / 100); return reply({ email: DEMO.email, balance: now, totalRecharged: 300 }); }
    if (pathname === '/api/client/platforms/1/api-keys') return reply({ items: keys, total: keys.length, syncMeta: { neverSynced: false, ok: true } });
    // 删除 on a demo key takes it out of the demo account and its group.
    const gone = /^\/api\/client\/platforms\/1\/api-keys\/(\d+)$/.exec(pathname);
    if (gone && options.method === 'DELETE') {
      const at = keys.findIndex(k => String(k.id) === gone[1]);
      if (at < 0) return reply({ code: 404, message: '密钥不存在', data: null }, 404);
      const [key] = keys.splice(at, 1);
      for (const g of groups) g.keyIds = g.keyIds.filter(id => id !== key.id);
      return reply({ success: true });
    }
    return reply({ code: 404, message: 'not found', data: null }, 404);
  }

  // Whether a site request belongs to the demo account: its sign-in, its renewal, or a call with its token.
  function isDemo(options) {
    const body = options.body ? JSON.parse(options.body) : {};
    return body.email === DEMO.email || body.refreshToken === 'demo-refresh' || options.headers?.Authorization === 'Bearer demo-access';
  }

  // The demo service, and the site's gateway for the demo keys; null for any other address.
  function serviceFetch(url, options) {
    const demoKey = keys.find(k => options.headers?.Authorization === `Bearer ${k.key}` && models[k.groupPlatform]);
    if (demoKey && url.startsWith(`${SITE.origin}/`)) return options.method === 'POST' ? ok() : reply({ data: models[demoKey.groupPlatform].map(id => ({ id })) });
    if (new URL(url).hostname !== new URL(DEMO_SERVICE.baseUrl).hostname) return null;
    if (options.method === 'POST') return ok();
    return Promise.resolve(Response.json({ data: sampleIds.map(id => ({ id, ...(id.startsWith('deepseek') ? { context_window: 1048576, max_output_tokens: 393216, effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' }, input_modalities: ['text'] } : {}) })) }));
  }

  return { isDemo, siteFetch, serviceFetch };
}
