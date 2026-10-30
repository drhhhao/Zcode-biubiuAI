// The Release notes of a version, for the release workflow (.github/workflows/release.yml), from CHANGELOG.md.
//   node build/companion-dev/release-notes.mjs --check <version>
//     fails unless CHANGELOG.md has a section "## <version>" with something in it
//   node build/companion-dev/release-notes.mjs <version> --setup <installer> [--since <tag>] [--repo <owner/name>] [--out <file>]
//     writes the notes: how to download and install, the version's changes, how to update, the installer's SHA-256.
//     --since is the newest published release: versions after it that never went out (a draft redone, a version
//     skipped) are listed too, each under its own heading.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

// The sections from "## <version>" down to the one of `since` (not included), or that section alone.
export function changes(text, version, since = '') {
  const lines = text.replace(/\r\n/g, '\n').split('\n'), start = lines.indexOf(`## ${version}`);
  if (start < 0) throw new Error(`CHANGELOG.md has no section "## ${version}"`);
  const stop = since.replace(/^v/, ''), sections = [];
  for (let i = start; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      if (i > start && (!stop || lines[i] === `## ${stop}`)) break;
      sections.push({ version: lines[i].slice(3).trim(), body: [] });
    } else sections[sections.length - 1].body.push(lines[i]);
  }
  const filled = sections.map(s => ({ ...s, body: s.body.join('\n').trim() }));
  const empty = filled.find(s => !s.body);
  if (empty) throw new Error(`CHANGELOG.md says nothing under "## ${empty.version}"`);
  return filled.length === 1 ? filled[0].body : filled.map(s => `#### ${s.version}\n\n${s.body}`).join('\n\n');
}

export function notes({ version, changelog, setupName, size, sha256, since = '', repo = 'drhhhao/Zcode-biubiuAI' }) {
  return [
    '## 下载',
    '',
    `点下面 **Assets** 里的 **\`${setupName}\`**（约 ${Math.round(size / 1048576)} MB）。双击、确认安装位置、点「安装」即可，不需要另装 Node.js 等运行环境。`,
    '',
    `不会用？请看 **[图文使用教程](https://github.com/${repo}/blob/main/docs/tutorial.md)**。`,
    '',
    '## 这个版本',
    '',
    changes(changelog, version, since),
    '',
    '## 从旧版本升级',
    '',
    `装着 0.8.9 及以上版本的 biubiu AI 会在屏幕右下角提醒一次新版本，点通知、托盘菜单的「更新到 ${version}…」或面板底部的「新版本 ${version} · 更新」，确认后自动下载、核对并安装，设置和网站登录都保留。也可以下载上面的安装程序再装一次。`,
    '',
    '0.8.8 还没有更新提醒：请下载上面的安装程序双击安装一次，它会装回原来的位置，设置和网站登录都会保留。以后有新版本，biubiu AI 会自己提醒。',
    '',
    '## 系统要求',
    '',
    '64 位 Windows 10 / 11，已安装 ZCode。',
    '',
    '## 提示',
    '',
    '安装程序暂未数字签名，第一次运行时 Windows 可能提示“Windows 已保护你的电脑”，点「更多信息」→「仍要运行」。',
    '',
    `SHA-256：\`${sha256}\``,
    ''
  ].join('\n');
}

function main(args) {
  const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] || '' : ''; };
  const changelog = fs.readFileSync(CHANGELOG, 'utf8');
  if (args[0] === '--check') { changes(changelog, args[1]); console.log(`CHANGELOG.md has the changes of ${args[1]}`); return; }
  const version = args[0], setup = option('--setup');
  if (!version || !setup) throw new Error('usage: release-notes.mjs <version> --setup <installer> [--since <tag>] [--repo <owner/name>] [--out <file>]');
  const data = fs.readFileSync(setup);
  const text = notes({ version, changelog, setupName: path.basename(setup), size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), since: option('--since'), repo: option('--repo') || undefined });
  const out = option('--out');
  if (out) fs.writeFileSync(out, text); else process.stdout.write(text);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`::error::${e.message}`); process.exit(1); }
}
