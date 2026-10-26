// A stand-in for GitHub's latest release, for installer-check.ps1; it never reaches GitHub. On 127.0.0.1 it answers
// /latest in the shape of https://api.github.com/repos/drhhhao/Zcode-biubiuAI/releases/latest, naming <version> and its
// installer biubiuAI-Setup-<version>.exe with the file's size and SHA-256, and serves that installer (the file given,
// whatever its own version) behind a redirect, as GitHub's download links are. POST /wrong-hash makes later answers name
// a SHA-256 the file does not have. Writes its port to <port file> and one line per request to stdout.
// Usage: node release-stand-in.mjs <installer> <version> <port file>
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';

const [installer, version, portFile] = process.argv.slice(2);
if (!installer || !version || !portFile) { console.error('usage: node release-stand-in.mjs <installer> <version> <port file>'); process.exit(2); }
const bytes = fs.readFileSync(installer);
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
const name = `biubiuAI-Setup-${version}.exe`;
let wrong = false;

const server = http.createServer((req, res) => {
  console.log(`${req.method} ${req.url}`);
  const port = server.address().port;
  if (req.method === 'POST' && req.url === '/wrong-hash') { wrong = true; res.writeHead(204).end(); return; }
  if (req.method === 'GET' && req.url === '/latest') {
    const digest = wrong ? [...sha].reverse().join('') : sha;
    const release = {
      tag_name: `v${version}`, name: `biubiu AI ${version}`, draft: false, prerelease: false,
      html_url: `https://github.com/drhhhao/Zcode-biubiuAI/releases/tag/v${version}`,
      assets: [{ name, size: bytes.length, digest: `sha256:${digest}`, browser_download_url: `http://127.0.0.1:${port}/download/${name}` }],
      body: `SHA-256: \`${digest}\``,
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(release));
    return;
  }
  if (req.method === 'GET' && req.url === `/download/${name}`) { res.writeHead(302, { Location: `/files/${name}` }).end(); return; }
  if (req.method === 'GET' && req.url === `/files/${name}`) { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length }).end(bytes); return; }
  res.writeHead(404).end();
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(server.address().port)));
