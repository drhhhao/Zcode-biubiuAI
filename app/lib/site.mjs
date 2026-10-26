// Signs in to the user's sub2api-hub site and reads the account's balance, API keys and groups, so a customer can add a
// site key, or a whole group, to ZCode without copying a key. The password is sent once to log in and never kept. Keys
// stay in this module's memory: overview() returns each key's and group's id, name, state and the ZCode address it would
// use, and a key itself leaves only through key(id), which reveal_key (the eye button) and fetch_models use. groupKey()
// picks the key a group is added with, and makes one on the site only when the panel asked the user first; deleteKey()
// deletes one on the site, only after the panel asked too.
// The sign-in (access and refresh token) lives in memory. When the desktop host passes a 32-byte session key, it is
// also saved AES-256-GCM encrypted in the data directory, so it survives a restart; the preview and tests keep it in memory.
// handoff() gives the site window the desktop host opens an access token, never the refresh token (see there).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { PanelError } from './core.mjs';

export const SITE = Object.freeze({ origin: 'https://ro.biubiu007.com', name: 'biubiu AI' });
export const SESSION_FILE = 'site-session.json';
const AAD = Buffer.from('model-harbor site session v1');
const PAGE_SIZE = 20, MAX_PAGES = 25, RENEW_BEFORE_MS = 30000, HANDOFF_EVERY_MS = 10000;
const STATUS = { active: '正常', inactive: '停用', quota_exhausted: '额度用尽', expired: '已过期' };
const PLATFORMS = { anthropic: 'Claude', openai: 'GPT', gemini: 'Gemini', antigravity: 'Antigravity', grok: 'Grok', 'new-api': 'New API' };
// How ZCode reaches each group platform through the site's own gateway. Gemini groups speak only Gemini's API, which
// ZCode has no protocol for; other platforms (grok, new-api) are tried as OpenAI-compatible.
const ROUTES = { anthropic: ['anthropic-messages', ''], antigravity: ['anthropic-messages', '/antigravity'], openai: ['openai-responses', '/v1'] };
const UNSUPPORTED = { gemini: 'ZCode 暂不支持 Gemini 原生接口，这个 Key 只能查看。' };
const UNSUPPORTED_GROUP = { gemini: 'ZCode 暂不支持 Gemini 原生接口，不能添加这个分组。' };
// The keys the site makes to test its groups, named as its key page recognizes them; that page cannot delete them.
const TEST_KEY = /^(?:hub-[pc]test-(?:i:[a-z0-9][a-z0-9-]{1,10}[a-z0-9]-)?g:\d+|【subApiHub测试】g\d+)$/u;

// The sign-in is gone: never made, logged out, or refused by the site.
class SignedOut extends PanelError {}

const clean = (value, max = 100) => typeof value === 'string' || typeof value === 'number' ? String(value).replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, max) : '';
const amount = value => { const n = typeof value === 'string' && value.trim() ? Number(value) : value; return typeof n === 'number' && Number.isFinite(n) ? n : null; };
const list = value => Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
// The hub answers errors as { code, message, data: null } and successes unwrapped; a { code: 0, data } wrapper is accepted too.
const unwrap = data => data && typeof data === 'object' && !Array.isArray(data) && 'data' in data && (data.code === 0 || data.code === 200 || data.success === true) ? data.data : data;
const reason = data => clean(data?.message || data?.error?.message || (typeof data?.error === 'string' ? data.error : ''), 120);
// The site sends each full key; a masked one (with * or …) cannot be used.
const fullKey = value => typeof value === 'string' && value.length >= 8 && value.length <= 8192 && !/[\s*•…]|\.\.\./.test(value) ? value : '';
const settle = promise => promise.then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }));
// A failed read that overview() reports beside the rest; a lost sign-in or an unexpected error is thrown instead.
const fatal = r => r.status === 'rejected' && !(r.reason instanceof PanelError && !(r.reason instanceof SignedOut));
const tokens = data => typeof data?.accessToken === 'string' && data.accessToken && data.accessToken.length <= 8192 && typeof data.refreshToken === 'string' && data.refreshToken && data.refreshToken.length <= 8192 ? { accessToken: data.accessToken, refreshToken: data.refreshToken } : null;
function expiry(token) {
  try { const exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).exp; return Number.isFinite(exp) ? exp * 1000 : null; } catch { return null; }
}
async function readBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    length += value.length;
    if (length > 2 * 1024 * 1024) { await reader.cancel(); throw new PanelError('站点响应超过 2 MB，未继续读取。'); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

export class Site {
  constructor({ origin = SITE.origin, name = SITE.name, fetchImpl = fetch, timeoutMs = 20000, dataDir = '', sessionKey = '' } = {}) {
    this.origin = new URL(origin).origin; this.name = name; this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs;
    const key = typeof sessionKey === 'string' && sessionKey ? Buffer.from(sessionKey, 'base64') : null;
    this.file = typeof dataDir === 'string' && path.isAbsolute(dataDir) && key?.length === 32 ? path.join(dataDir, SESSION_FILE) : '';
    this.secret = this.file ? key : null;
    this.session = null; this.restoring = null; this.renewing = null; this.keys = new Map(); this.groups = new Map(); this.where = null;
    this.handedAt = 0;
  }
  info() { return { origin: this.origin, host: new URL(this.origin).host, name: this.name }; }
  // What the last overview read for the signed-in account; it goes with the sign-in.
  dropAccount() { this.keys.clear(); this.groups.clear(); this.where = null; }

  async login({ email, password } = {}) {
    const address = typeof email === 'string' ? email.trim() : '';
    if (!address || address.length > 254 || !address.includes('@') || /[\s\x00-\x1F]/.test(address)) throw new PanelError('请填写登录邮箱。');
    if (typeof password !== 'string' || !password || password.length > 256) throw new PanelError('请填写密码。');
    const r = await this.send('/auth/login', { method: 'POST', body: { email: address, password } });
    if (!r.ok) throw new PanelError(r.status === 429 ? '登录尝试太频繁，请稍后再试。' : reason(r.data) || (r.status === 400 || r.status === 401 ? '邮箱或密码不正确。' : `登录失败（HTTP ${r.status}），请稍后重试。`));
    const next = tokens(r.data);
    if (!next) throw new PanelError(`${this.name} 返回的登录信息无法识别，请稍后重试。`);
    await this.restore();
    this.session = { email: clean(r.data.user?.email, 254) || address, ...next }; this.dropAccount();
    await this.save();
    return this.overview();
  }
  async logout() {
    await this.restore();
    this.session = null; this.dropAccount();
    await this.save();
    return { signedIn: false, site: this.info() };
  }

  // The account's balance, keys and groups, read from the main platform's first account as the site itself shows them.
  // Problems after signing in come back in error, beside whatever could be read; only a lost sign-in signs out.
  async overview() {
    await this.restore();
    if (!this.session) return { signedIn: false, site: this.info() };
    const base = { signedIn: true, site: this.info(), email: this.session.email, balance: null, totalRecharged: null, keys: [], groups: [] };
    try {
      this.where = null;
      const { pid, accountId } = await this.place();
      const [balance, keys] = await Promise.allSettled([this.balanceSummary(pid, accountId), this.listKeys(pid, accountId)]);
      for (const r of [balance, keys]) if (fatal(r)) throw r.reason;
      // Groups come after the keys: a first read syncs the keys, and each group names the keys in it.
      const groups = await settle(this.listGroups(pid, accountId));
      if (fatal(groups)) throw groups.reason;
      const result = { ...base };
      if (balance.status === 'fulfilled') { result.balance = amount(balance.value?.balance); result.totalRecharged = amount(balance.value?.totalRecharged); }
      if (keys.status === 'fulfilled') {
        this.keys = new Map(keys.value.map(k => [k.id, k]));
        result.keys = keys.value.map(({ key, ...shown }) => ({ ...shown, hasKey: Boolean(key) }));
      }
      if (groups.status === 'fulfilled') {
        this.groups = new Map(groups.value.map(g => [g.id, g]));
        result.groups = groups.value.map(g => this.publicGroup(g));
      }
      const errors = [balance.status === 'rejected' ? `余额读取失败：${balance.reason.message}` : '', keys.status === 'rejected' ? `Key 读取失败：${keys.reason.message}` : '', groups.status === 'rejected' ? `分组读取失败：${groups.reason.message}` : ''].filter(Boolean);
      if (errors.length) result.error = errors.join(' ');
      return result;
    } catch (e) {
      if (e instanceof SignedOut) return { signedIn: false, site: this.info(), expired: true };
      if (e instanceof PanelError) return { ...base, error: e.message };
      throw e;
    }
  }
  // Only the balance, which the panel reads every 30 seconds while it is shown. Keys and groups are not read, so what the
  // last overview read stays as it was; the account is the one the last overview found. A failed read comes back in
  // error, and only a lost sign-in signs out, as in overview().
  async balance() {
    await this.restore();
    if (!this.session) return { signedIn: false, site: this.info() };
    const base = { signedIn: true, site: this.info(), email: this.session.email, balance: null, totalRecharged: null };
    try {
      const { pid, accountId } = await this.place();
      const data = await this.balanceSummary(pid, accountId);
      return { ...base, balance: amount(data?.balance), totalRecharged: amount(data?.totalRecharged) };
    } catch (e) {
      if (e instanceof SignedOut) return { signedIn: false, site: this.info(), expired: true };
      if (e instanceof PanelError) return { ...base, error: `余额读取失败：${e.message}` };
      throw e;
    }
  }
  balanceSummary(pid, accountId) { return this.api(`/client/platforms/${pid}/balance-summary?accountId=${encodeURIComponent(accountId)}`); }
  async listKeys(pid, accountId) {
    const route = `/client/platforms/${pid}/api-keys`, account = encodeURIComponent(accountId);
    const page = n => this.api(`${route}?customerAccountId=${account}&page=${n}&pageSize=${PAGE_SIZE}&keyScope=active`);
    let first = await page(1);
    // The site copies an account's keys from upstream on its 同步 button; a list never synced is empty until then.
    if (first?.syncMeta?.neverSynced === true) {
      try { await this.api(`${route}/sync`, { method: 'POST', body: { customerAccountId: accountId } }); }
      catch (e) { if (!(e instanceof PanelError) || e instanceof SignedOut) throw e; throw new PanelError(`还没有从上游同步过 Key，自动同步失败：${e.message}`); }
      first = await page(1);
    }
    const items = [...list(first)], total = Number(first?.total) || 0;
    for (let n = 2; items.length < total && n <= MAX_PAGES; n++) { const more = list(await page(n)); if (!more.length) break; items.push(...more); }
    const seen = new Set();
    return items.filter(k => k && !k.deletedAt && k.status !== 'deleted' && (k.localId ?? k.id) != null).map(k => this.keyEntry(k)).filter(k => !seen.has(k.id) && seen.add(k.id));
  }
  // A key's id is the site's own (localId), which its groups name the key by and its key page changes and deletes it
  // with; a list without one gives id.
  keyEntry(k) {
    const platform = clean(k.groupPlatform, 40).toLowerCase(), [protocol, route] = ROUTES[platform] || ['openai-chat-completions', '/v1'];
    const status = clean(k.status, 40), name = clean(k.name) || '未命名 Key', key = fullKey(k.key);
    const blocked = UNSUPPORTED[platform] || (!key ? '网站没有返回这个 Key 的完整内容。' : status === 'inactive' ? '这个 Key 已停用，请先在网站上启用。' : status === 'expired' ? '这个 Key 已过期，请在网站上续期或换一个 Key。' : '');
    return { id: String(k.localId ?? k.id), name, group: clean(k.groupName), platform, platformName: PLATFORMS[platform] || clean(k.groupPlatform, 40), status, statusLabel: STATUS[status] || status || '未知',
      baseUrl: `${this.origin}${route}`, protocol, blocked, testKey: typeof k.name === 'string' && TEST_KEY.test(k.name), quota: amount(k.quota), quotaUsed: amount(k.quotaUsed), expiresAt: clean(k.expiresAt, 40) || null, key };
  }
  // One key from the last overview, with its value, for reveal_key and fetch_models only.
  key(id) {
    const entry = (typeof id === 'string' || typeof id === 'number') && this.session ? this.keys.get(String(id)) : undefined;
    if (!entry) throw new PanelError('没有找到这个站内 Key，请刷新账户后再试。');
    return entry;
  }
  // The main platform and its first account, as the site's own pages pick them. overview() reads them afresh; adding or
  // removing a group and reading the balance alone use the last ones.
  async place() {
    if (this.where) return this.where;
    const platforms = list(await this.api('/client/platforms'));
    const platform = platforms.find(p => p?.isMain) || platforms[0];
    if (platform?.id == null) throw new PanelError('站点还没有可用的平台。');
    const pid = encodeURIComponent(platform.id);
    const account = list(await this.api(`/client/platforms/${pid}/accounts`))[0];
    if (account?.id == null) throw new PanelError('这个账号还没有录入平台账户，请先在网站上录入。');
    this.where = { pid, accountId: account.id };
    return this.where;
  }
  // The groups this account may use, each with the account's keys in it, as the site's group ranking lists them. A group
  // without an upstream id cannot take keys and is left out.
  async listGroups(pid, accountId) {
    const data = await this.api(`/client/platforms/${pid}/groups?customerAccountId=${encodeURIComponent(accountId)}`);
    const seen = new Set();
    return list(data).filter(g => g && g.upstreamGroupId != null).map(g => this.groupEntry(g)).filter(g => !seen.has(g.id) && seen.add(g.id));
  }
  groupEntry(g) {
    const platform = clean(g.platform, 40).toLowerCase(), [protocol, route] = ROUTES[platform] || ['openai-chat-completions', '/v1'];
    const keys = (Array.isArray(g.apiKeys) ? g.apiKeys : []).filter(k => k?.id != null).map(k => ({ id: String(k.id), key: fullKey(k.key) }));
    return { id: String(g.upstreamGroupId), name: clean(g.name) || '未命名分组', platform, platformName: PLATFORMS[platform] || clean(g.platform, 40), multiplier: amount(g.effectiveMultiplier),
      remark: clean(g.remark, 200), baseUrl: `${this.origin}${route}`, protocol, blocked: UNSUPPORTED_GROUP[platform] || '', keys };
  }
  // A group as the panel sees it: no keys, only whether one of them works as it is.
  publicGroup({ keys, baseUrl, protocol, ...shown }) { return { ...shown, hasUsableKey: keys.some(k => this.usable(k.id)) }; }
  usable(id) { const k = this.keys.get(id); return Boolean(k?.key) && k.status === 'active' && !k.blocked; }
  // One group as the site lists it now, with its keys.
  async group(id) {
    if (typeof id !== 'string' && typeof id !== 'number') throw new PanelError('没有找到这个分组，请刷新账户后再试。');
    const { pid, accountId } = await this.place();
    const group = (await this.listGroups(pid, accountId)).find(g => g.id === String(id));
    if (!group) throw new PanelError('没有找到这个分组，请刷新账户后再试。');
    this.groups.set(group.id, group);
    return group;
  }
  // The key a group is added with: one of its keys that works as it is, else, when the user agreed in the panel, a key
  // made on the site for the group with the site's own defaults (no quota, no expiry). Without create nothing is made.
  async groupKey(id, { create = false } = {}) {
    const group = await this.group(id);
    if (group.blocked) throw new PanelError(group.blocked);
    const { pid, accountId } = await this.place();
    if (group.keys.some(k => !this.keys.has(k.id))) this.keys = new Map((await this.listKeys(pid, accountId)).map(k => [k.id, k]));
    const found = group.keys.find(k => this.usable(k.id));
    if (found) return { group, key: this.keys.get(found.id), created: false };
    if (!create) throw new PanelError(`「${group.name}」还没有可用的 Key，需要先在网站上新建一个。`);
    const made = await this.api(`/client/platforms/${pid}/groups/${encodeURIComponent(group.id)}/keys?customerAccountId=${encodeURIComponent(accountId)}`, { method: 'POST', body: { name: `ZCode · ${group.name}`.slice(0, 50) } });
    if (made?.id == null) throw new PanelError(`${this.name} 没有返回新建的 Key，请刷新账户查看。`);
    const key = this.keyEntry({ status: 'active', ...made, groupName: group.name, groupPlatform: group.platform });
    if (!key.key) throw new PanelError(`已在网站上为「${group.name}」新建 Key「${key.name}」，但网站没有返回它的完整内容，请刷新账户后再试。`);
    this.keys.set(key.id, key); group.keys.push({ id: key.id, key: key.key });
    return { group, key, created: true };
  }
  // Deletes one of the account's keys on the site, as the site's own key page does after asking: the key goes upstream
  // too, and the site keeps it only as deleted. The site's test keys stay, as there.
  async deleteKey(id) {
    const k = this.key(id);
    if (k.testKey) throw new PanelError('这是网站用来测试分组的 Key，网站上也不能删除。');
    const { pid, accountId } = await this.place();
    await this.api(`/client/platforms/${pid}/api-keys/${encodeURIComponent(k.id)}?customerAccountId=${encodeURIComponent(accountId)}`, { method: 'DELETE' });
    this.keys.delete(k.id);
    for (const g of this.groups.values()) g.keys = g.keys.filter(x => x.id !== k.id);
    return { id: k.id, name: k.name };
  }

  // A signed-in request. An access token about to expire is renewed first, as the site does; a refused one is renewed once.
  async api(route, options = {}) {
    let session = await this.current();
    let r = await this.send(route, { ...options, token: session.accessToken });
    if (r.status === 401) {
      session = await this.renew(session);
      r = await this.send(route, { ...options, token: session.accessToken });
      if (r.status === 401) { await this.forget(session); throw new SignedOut('登录已过期，请重新登录。'); }
    }
    if (!r.ok) throw new PanelError(reason(r.data) || `${this.name} 暂时无法读取（HTTP ${r.status}），请稍后重试。`);
    return r.data;
  }
  async current() {
    await this.restore();
    const session = this.session;
    if (!session) throw new SignedOut('请先登录。');
    const exp = expiry(session.accessToken);
    return exp !== null && exp - Date.now() < RENEW_BEFORE_MS ? this.renew(session) : session;
  }
  // One renewal at a time: every refresh token works once, so a second renewal in parallel would be refused.
  renew(stale) {
    if (this.session !== stale) return this.session ? Promise.resolve(this.session) : Promise.reject(new SignedOut('登录已过期，请重新登录。'));
    this.renewing ||= this.refresh(stale).finally(() => { this.renewing = null; });
    return this.renewing;
  }
  async refresh(stale) {
    const r = await this.send('/auth/refresh', { method: 'POST', body: { refreshToken: stale.refreshToken } });
    if (r.status === 401 || r.status === 403) { await this.forget(stale); throw new SignedOut('登录已过期，请重新登录。'); }
    const next = r.ok ? tokens(r.data) : null;
    if (!next) throw new PanelError(`${this.name} 登录续期暂时失败，请稍后重试。`);
    // Logged out, or in again, while this renewal was under way: that newer state stands.
    if (this.session !== stale) { if (this.session) return this.session; throw new SignedOut('登录已过期，请重新登录。'); }
    this.session = { ...stale, ...next };
    await this.save();
    return this.session;
  }
  async forget(stale) { if (this.session !== stale) return; this.session = null; this.dropAccount(); await this.save(); }

  // An access token for the site window the desktop host opens, so the site's own pages show this account signed in.
  // The site's pages keep their sign-in in their own storage; the window starts them with a placeholder refresh token,
  // and the host answers their renewals itself by asking here. Each ask renews the sign-in, at most once every
  // HANDOFF_EVERY_MS, so the window gets a token with its whole lifetime ahead and this module keeps the only refresh
  // token that works: the window and the panel never renew past each other. Signed out, or refused, it says so.
  async handoff() {
    await this.restore();
    const session = this.session;
    if (!session) return { signedIn: false };
    try {
      const fresh = Date.now() - this.handedAt < HANDOFF_EVERY_MS ? await this.current() : await this.renew(session);
      this.handedAt = Date.now();
      return { signedIn: true, accessToken: fresh.accessToken };
    } catch (e) {
      if (e instanceof SignedOut) return { signedIn: false };
      throw e;
    }
  }

  async send(route, { method = 'GET', body, token } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    let response, data;
    try { response = await this.fetchImpl(`${this.origin}/api${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) }); }
    catch { throw new PanelError(`连接 ${this.name} 失败或超时，请检查网络后重试。`); }
    try { data = await readBody(response); }
    catch (e) { if (e instanceof PanelError) throw e; throw new PanelError(`与 ${this.name} 的连接中断，请稍后重试。`); }
    return { ok: response.ok, status: response.status, data: response.ok ? unwrap(data) : data };
  }

  // The saved sign-in is read once, on first use. A file this key cannot open (another user, a replaced key, damage) is deleted.
  restore() {
    this.restoring ||= (async () => {
      if (!this.file) return;
      let saved;
      try { saved = this.decrypt(await fs.readFile(this.file, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') await fs.rm(this.file, { force: true }).catch(() => {}); return; }
      const next = tokens(saved);
      if (!this.session && saved?.origin === this.origin && next) this.session = { email: clean(saved.email, 254), ...next };
    })();
    return this.restoring;
  }
  // Writes the sign-in through a temporary file, or deletes it once signed out. A sign-in that cannot be saved still
  // works until the companion restarts.
  async save() {
    if (!this.file) return;
    if (!this.session) { await fs.rm(this.file, { force: true }).catch(() => {}); return; }
    const temporary = `${this.file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(temporary, this.encrypt({ origin: this.origin, ...this.session }), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, this.file);
    } catch { await fs.unlink(temporary).catch(() => {}); }
  }
  encrypt(value) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.secret, iv, { authTagLength: 16 });
    cipher.setAAD(AAD);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
  }
  decrypt(raw) {
    const box = JSON.parse(raw);
    if (box?.v !== 1) throw new Error('unknown session file');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.secret, Buffer.from(box.iv, 'base64'), { authTagLength: 16 });
    decipher.setAAD(AAD); decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8'));
  }
}
