// Tool dispatch shared by the desktop companion server and the browser preview.
// Results keep the { content, structuredContent } shape that panel.html reads.
// API keys stay out of results (core.mjs and site.mjs keep credentials in their own memory), with one
// exception: reveal_key returns one saved provider's key, or one site key, when the user clicks its eye button.
// update_provider takes a new key but reports only what changed; site_login takes the site password and keeps none of it.
// site_add_group may make a key on the site, only with createKey after the panel asked; neither group tool returns a key.
// site_delete_key deletes one site key on the site, and its services in ZCode, after the panel asked; it returns no key.
// site_account with balanceOnly reads the balance alone, which the panel does every 30 seconds while it is shown.
import { PanelError } from './core.mjs';

export const VERSION = '0.8.10';
export const TOOL_NAMES = Object.freeze(['site_account', 'site_login', 'site_logout', 'site_add_group', 'site_remove_group', 'site_delete_key', 'list_providers', 'reveal_key', 'update_provider', 'delete_provider', 'fetch_models', 'get_models', 'test_model', 'import_models']);
export const PAGE_SIZE = 25;

function summary(name, data) {
  switch (name) {
    case 'site_account': case 'site_login': return data.signedIn && !data.keys ? (data.error ? data.error : `已读取 ${data.site.name} 余额。`) : data.signedIn ? `已读取 ${data.site.name} 账户：${data.keys.length} 个 Key、${data.groups?.length || 0} 个分组${data.error ? `；${data.error}` : '。'}` : `尚未登录 ${data.site.name}。`;
    case 'site_logout': return `已退出 ${data.site.name}。`;
    case 'site_add_group': return data.unchanged ? `分组「${data.groupName}」的模型已经都在 ZCode 里。` : `已把分组「${data.groupName}」的 ${data.added} 个模型添加到 ${data.providerName}${data.createdKey ? `，并在网站上新建了 Key「${data.createdKey}」` : ''}。`;
    case 'site_remove_group': return `已从 ZCode 删除分组「${data.groupName}」的 ${data.models} 个模型。`;
    case 'site_delete_key': return `已删除站内 Key「${data.keyName}」${data.removed.length ? `，并从 ZCode 删除了「${data.removed.join('」「')}」` : ''}。`;
    case 'fetch_models': return `已找到 ${data.count} 个模型。`;
    case 'import_models': return data.unchanged ? `这些模型已经在 ${data.providerName} 里了。` : `已向 ${data.providerName} 新增 ${data.added} 个模型。`;
    case 'test_model': return data.ok ? '简短调用通过；大上下文与输出上限未实测。' : '测试未通过，请查看面板结果。';
    case 'get_models': return '模型参数已读取。';
    case 'reveal_key': return data.siteKeyId ? '已读取所选的站内 Key。' : '已读取所选服务的 Key。';
    case 'update_provider': return data.unchanged ? `${data.providerName} 的地址和 Key 没有变化。` : `已更新 ${data.providerName} 的${data.urlChanged && data.keyChanged ? '地址和 Key' : data.urlChanged ? '地址' : ' Key'}。`;
    case 'delete_provider': return `已删除 ${data.providerName}。`;
    default: return '供应商列表已读取。';
  }
}

export async function callTool(harbor, name, args = {}) {
  try {
    if (!TOOL_NAMES.includes(name)) throw new PanelError('未知工具。');
    const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    let data;
    if (name === 'site_account') data = await harbor.siteAccount(input);
    else if (name === 'site_login') data = await harbor.siteLogin(input);
    else if (name === 'site_logout') data = await harbor.siteLogout();
    else if (name === 'site_add_group') data = await harbor.siteAddGroup(input);
    else if (name === 'site_remove_group') data = await harbor.siteRemoveGroup(input);
    else if (name === 'site_delete_key') data = await harbor.siteDeleteKey(input);
    else if (name === 'list_providers') data = await harbor.providers();
    else if (name === 'reveal_key') data = await harbor.revealKey(input);
    else if (name === 'update_provider') data = await harbor.updateProvider(input);
    else if (name === 'delete_provider') data = await harbor.deleteProvider(input);
    else if (name === 'fetch_models') {
      data = await harbor.fetchModels(input);
      const all = data.models;
      data = { ...data, models: all.slice(0, PAGE_SIZE), nextOffset: all.length > PAGE_SIZE ? PAGE_SIZE : null };
    }
    else if (name === 'get_models') data = harbor.getModels(input);
    else if (name === 'test_model') data = await harbor.testModel(input);
    else data = await harbor.importModels(input);
    return { content: [{ type: 'text', text: summary(name, data) }], structuredContent: data };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e instanceof PanelError ? e.message : '操作未完成，请稍后重试并检查本地配置权限。' }] };
  }
}
