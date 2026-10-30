// Copies a published GitHub release of biubiu AI to the Gitee mirror, for .github/workflows/gitee.yml. Installed copies
// download the installer from Gitee first (quicker in China) and only run it when its size and SHA-256 are what GitHub
// records, so this script takes the installer from GitHub, checks it against GitHub's record, puts it on a Gitee
// release of the same tag and name, and then downloads it back from Gitee as a user would (no token) to check it again.
// The tag must already be on Gitee (the workflow pushes it first). Drafts and prereleases are never copied.
// Usage: node gitee-release.mjs <tag>
// Environment: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/name), GITEE_TOKEN, GITEE_REPOSITORY (owner/name).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tag = process.argv[2];
const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITEE_TOKEN, GITEE_REPOSITORY } = process.env;
if (!tag || !GITHUB_REPOSITORY || !GITEE_TOKEN || !GITEE_REPOSITORY) {
  console.error('usage: node gitee-release.mjs <tag>, with GITHUB_TOKEN, GITHUB_REPOSITORY, GITEE_TOKEN and GITEE_REPOSITORY set');
  process.exit(2);
}
const version = tag.replace(/^v/, '');
if (!/^\d+(\.\d+){1,3}$/.test(version)) fail(`${tag} is no version tag`);
const name = `biubiuAI-Setup-${version}.exe`;
const gitee = `https://gitee.com/api/v5/repos/${GITEE_REPOSITORY}`;

function fail(message) { console.error(`::error::${message}`); process.exit(1); }
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function github(path) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'biubiu-ai-release' };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}${path}`, { headers });
  if (!res.ok) fail(`GitHub ${path}: HTTP ${res.status}`);
  return res.json();
}

// The token goes in the query or the form, as Gitee's API takes it; it is never printed. Text goes form-encoded (Gitee
// answers a JSON body with Chinese in it with an HTML error page), files as multipart.
async function giteeApi(method, path, form) {
  const url = new URL(`${gitee}${path}`);
  let body;
  if (form) { form.set('access_token', GITEE_TOKEN); body = form; } else url.searchParams.set('access_token', GITEE_TOKEN);
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { method, body });
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : null;
    if (res.status === 404 && method === 'GET') return null;
    if (res.status < 500 || attempt === 3) fail(`Gitee ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
    await new Promise(done => setTimeout(done, 5000 * attempt));
  }
}

async function download(url, what) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'biubiu-ai-release' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (attempt === 4) fail(`could not download ${what}: ${e.message}`);
      console.log(`downloading ${what} failed (${e.message}), again in ${10 * attempt} s`);
      await new Promise(done => setTimeout(done, 10000 * attempt));
    }
  }
}

// GitHub's release and its record of the installer.
const release = await github(`/releases/tags/${encodeURIComponent(tag)}`);
if (release.draft || release.prerelease) fail(`${tag} is not published on GitHub; only published releases go to Gitee`);
const asset = (release.assets || []).find(a => a.name === name);
if (!asset || !/^sha256:[0-9a-f]{64}$/.test(asset.digest || '')) fail(`${tag} on GitHub has no ${name} with a SHA-256`);
const want = asset.digest.slice(7);
const bytes = await download(asset.browser_download_url, `${name} from GitHub`);
if (bytes.length !== asset.size || sha256(bytes) !== want) fail(`${name} from GitHub does not match GitHub's record`);
console.log(`${name}: ${bytes.length} bytes, SHA-256 ${want} (GitHub's record)`);

// The Gitee release of that tag, made if missing; its notes are GitHub's, which name the SHA-256.
let mirrored = await giteeApi('GET', `/releases/tags/${encodeURIComponent(tag)}`);
if (!mirrored || !mirrored.id) {
  const form = new URLSearchParams();
  form.set('tag_name', tag);
  form.set('name', release.name || `biubiu AI ${version}`);
  form.set('body', `${release.body || ''}\n\n（GitHub 发布页：${release.html_url}）`);
  form.set('prerelease', 'false');
  form.set('target_commitish', release.target_commitish || 'main');
  mirrored = await giteeApi('POST', '/releases', form);
  console.log(`made the Gitee release of ${tag}`);
} else console.log(`the Gitee release of ${tag} is already there`);

// An installer already there stays if it is GitHub's; anything else of that name goes.
const page = `https://gitee.com/${GITEE_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${name}`;
const files = (await giteeApi('GET', `/releases/${mirrored.id}/attach_files?per_page=100`)) || [];
let present = false;
for (const file of files.filter(f => f.name === name)) {
  const there = await download(file.browser_download_url, `${name} on Gitee`);
  if (!present && there.length === bytes.length && sha256(there) === want) { present = true; continue; }
  await giteeApi('DELETE', `/releases/${mirrored.id}/attach_files/${file.id}`);
  console.log(`removed a ${name} on Gitee that was not GitHub's`);
}
// The upload goes through curl: from GitHub's machines in the US it can take minutes before Gitee answers, longer than
// fetch waits for an answer's headers. When it fails, what reached Gitee is looked at before trying again.
async function landed() {
  const now = (await giteeApi('GET', `/releases/${mirrored.id}/attach_files?per_page=100`)) || [];
  for (const file of now.filter(f => f.name === name)) {
    const there = await download(file.browser_download_url, `${name} on Gitee`);
    if (there.length === bytes.length && sha256(there) === want) return true;
    await giteeApi('DELETE', `/releases/${mirrored.id}/attach_files/${file.id}`);
  }
  return false;
}
for (let attempt = 1; !present; attempt++) {
  const local = path.join(os.tmpdir(), name);
  fs.writeFileSync(local, bytes);
  // The token reaches curl on standard input, never on its command line.
  const curl = spawnSync('curl', ['--silent', '--show-error', '--fail-with-body', '--max-time', '1800', '--config', '-',
    '--form', `file=@${local}`, `${gitee}/releases/${mirrored.id}/attach_files`],
  { input: `form-string = "access_token=${GITEE_TOKEN}"\n`, encoding: 'utf8' });
  fs.rmSync(local, { force: true });
  if (curl.status === 0) { console.log(`uploaded ${name} to Gitee`); break; }
  console.log(`uploading ${name} to Gitee failed (curl ${curl.status}: ${(curl.stderr || '').trim().slice(0, 200)})`);
  if (await landed()) { console.log(`${name} reached Gitee all the same`); break; }
  if (attempt === 3) fail(`could not upload ${name} to Gitee`);
}

// As a user downloads it: no token, through Gitee's redirect.
const back = await download(page, `${name} back from Gitee`);
if (back.length !== bytes.length || sha256(back) !== want) fail(`${name} downloaded from Gitee does not match GitHub's record`);
console.log(`checked: ${page} is GitHub's installer`);
