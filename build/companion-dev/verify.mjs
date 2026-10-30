// One command for checking a change on this machine: npm run verify.
// By default nothing opens on the screen (the user works beside it): npm test, and app:build, which compiles the host
// whenever the host or the files it embeds changed. The window checks open real windows on the desktop for a minute
// or two (a stand-in ZCode moved about, the panel, the site window, the tray menu in both themes) and run on a fresh
// GitHub machine after every push instead (.github/workflows/check.yml: app:site-check, and app:installer-check, which
// runs the whole smoke test against the installed copy); here they run only with --windows, after the user agreed.
// With --windows it looks at what differs from origin/main (commits not pushed yet, uncommitted and new files) and runs
// only the window checks that cover it, one after another, stopping at the first failure:
//   app:smoke      the host, the panel, the local service or the config writing changed (stand-in ZCode, temporary data);
//   app:site-check the host, the local service or the site account changed (stand-in site, no account).
// Nothing here installs or uninstalls anything unless --installer: the installer's end-to-end check installs into
// Settings > Apps and refuses to run where biubiu AI is installed.
// Usage: node build/companion-dev/verify.mjs [--windows] [--all] [--installer] [--list]
//   --windows    also the window checks that cover the change (windows flash on the screen);
//   --all        with --windows, every window check whatever changed;   --list   only say what would run.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = new Set(process.argv.slice(2));
const unknown = [...args].filter(a => !['--windows', '--all', '--installer', '--list'].includes(a));
if (unknown.length) { console.error(`unknown option ${unknown.join(' ')}; use --windows, --all, --installer or --list`); process.exit(2); }
if (args.has('--all') && !args.has('--windows')) { console.error('--all 只和 --windows 一起用：它让窗口检查全部跑一遍，会在屏幕上弹窗口。'); process.exit(2); }
const windows = args.has('--windows');

const git = (...a) => {
  const r = spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n').map(s => s.trim()).filter(Boolean) : null;
};

// What would reach GitHub: changes since the last commit origin/main has, plus the working tree and new files.
function changedFiles() {
  const base = git('merge-base', 'HEAD', 'origin/main')?.[0] || 'HEAD';
  const files = new Set([...(git('diff', '--name-only', base) || []), ...(git('ls-files', '--others', '--exclude-standard') || [])]);
  return [...files].sort();
}

// Which window check covers which files. Anything matching none is covered by npm test alone (docs, tests, metadata).
const SMOKE = [/^app\/host\//, /^app\/build\.mjs$/, /^app\/icon\.mjs$/, /^app\/lib\/logo\.mjs$/, /^app\/lib\/panel\.html$/,
  /^app\/server\.mjs$/, /^app\/lib\/core\.mjs$/, /^app\/lib\/tools\.mjs$/,
  /^build\/companion-dev\/(smoke-host\.ps1|FakeZCode\.(cs|exe))$/];
const SITE = [/^app\/host\//, /^app\/build\.mjs$/, /^app\/server\.mjs$/, /^app\/lib\/site\.mjs$/,
  /^build\/companion-dev\/(site-window-check\.mjs|SiteWindowCheck\.cs)$/];
const INSTALLER = [/^app\/installer\//, /^app\/host\//, /^build\/companion-dev\/(installer-check\.ps1|window-helpers\.ps1|release-stand-in\.mjs)$/];

const files = changedFiles();
const hits = rules => files.filter(f => rules.some(r => r.test(f)));
const smoke = args.has('--all') ? ['--all'] : hits(SMOKE);
const site = args.has('--all') ? ['--all'] : hits(SITE);
const installer = hits(INSTALLER);

const npm = (script, why) => ({ name: script === 'test' ? 'npm test' : `npm run ${script}`, why, cmd: ['npm', 'run', script] });
const steps = [npm('test', '每次都跑')];
const BUILD = [/^app\/host\//, /^app\/build\.mjs$/, /^app\/icon\.mjs$/, /^app\/lib\/logo\.mjs$/];
if (hits(BUILD).length || (windows && (smoke.length || site.length)) || args.has('--installer')) steps.push(npm('app:build', windows ? '编译宿主，下面的窗口检查用它' : '编译宿主（只编译，不打开窗口）'));
if (windows && smoke.length) steps.push(npm('app:smoke', why(smoke)));
if (windows && site.length) steps.push(npm('app:site-check', why(site)));
if (args.has('--installer')) steps.push(npm('app:installer', '打安装程序'), npm('app:installer-check', '按 --installer 在本机装、卸一遍'));

function why(list) { return list[0] === '--all' ? '--all' : `改了 ${list.slice(0, 3).join('、')}${list.length > 3 ? ` 等 ${list.length} 个文件` : ''}`; }

console.log(files.length ? `与 origin/main 相比改了 ${files.length} 个文件。` : '与 origin/main 相比没有改动。');
for (const s of steps) console.log(`  · ${s.name.padEnd(24)}${s.why}`);
const deferred = [...(smoke.length ? ['app:smoke'] : []), ...(site.length ? ['app:site-check'] : [])];
if (!windows && deferred.length)
  console.log(`  · 窗口检查（${deferred.join('、')}）  会在屏幕上弹窗口，本机不跑：推送后在 GitHub 的干净机器上跑（Actions →「检查」）；确需本机跑时加 --windows`);
if (installer.length && !args.has('--installer'))
  console.log(`  · 安装程序的端到端检查    改了 ${installer.slice(0, 3).join('、')}：推送后在 GitHub 的干净机器上跑（Actions →「检查」），本机不装不卸`);
if (args.has('--list')) process.exit(0);

const results = [];
for (const s of steps) {
  console.log(`\n=== ${s.name}`);
  const started = Date.now();
  // npm is npm.cmd on Windows, which only a shell runs.
  const r = spawnSync(s.cmd.join(' '), { cwd: root, stdio: 'inherit', shell: true });
  const ok = r.status === 0;
  results.push({ ...s, ok, seconds: Math.round((Date.now() - started) / 1000) });
  if (!ok) break;
}

console.log('\n=== 结果');
for (const r of results) console.log(`  ${r.ok ? '通过' : '失败'}  ${r.name.padEnd(24)}${r.seconds} 秒`);
const skipped = steps.slice(results.length);
for (const s of skipped) console.log(`  跳过  ${s.name}（前面失败了）`);
process.exitCode = results.every(r => r.ok) ? 0 : 1;
