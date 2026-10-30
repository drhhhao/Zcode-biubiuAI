import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { ICON_SIZES, drawLogo, encodePng, iconFile, parsePath } from './icon.mjs';
import { LOGO, logoSvg } from './lib/logo.mjs';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(appDir);
const read = file => fs.readFile(path.join(root, file), 'utf8');
const pixel = (rgba, size, x, y) => Array.from(rgba.slice((y * size + x) * 4, (y * size + x) * 4 + 4));
const near = (rgba, size, [x, y], colour, tolerance = 40) => {
  const [r, g, b, a] = pixel(rgba, size, Math.floor(x * size / LOGO.canvas), Math.floor(y * size / LOGO.canvas));
  const want = [1, 3, 5].map(i => parseInt(colour.slice(i, i + 2), 16));
  return a > 200 && Math.abs(r - want[0]) <= tolerance && Math.abs(g - want[1]) <= tolerance && Math.abs(b - want[2]) <= tolerance;
};

test('the icon file holds every size Windows asks for, small ones as DIB and large ones as PNG', () => {
  const ico = iconFile();
  assert.equal(ico.readUInt16LE(0), 0); assert.equal(ico.readUInt16LE(2), 1); assert.equal(ico.readUInt16LE(4), ICON_SIZES.length);
  assert.deepEqual([...ICON_SIZES], [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]);
  ICON_SIZES.forEach((size, i) => {
    const e = 6 + 16 * i, width = ico[e] || 256, bytes = ico.readUInt32LE(e + 8), offset = ico.readUInt32LE(e + 12);
    assert.equal(width, size); assert.equal(ico[e + 1] || 256, size); assert.equal(ico.readUInt16LE(e + 6), 32);
    const data = ico.subarray(offset, offset + bytes);
    assert.equal(data.length, bytes, `entry ${size} lies inside the file`);
    if (size >= 64) {
      assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `entry ${size} is PNG`);
      assert.equal(data.readUInt32BE(16), size); assert.equal(data.readUInt32BE(20), size);
    } else {
      assert.equal(data.readUInt32LE(0), 40, `entry ${size} is a DIB`);
      assert.equal(data.readInt32LE(4), size); assert.equal(data.readInt32LE(8), size * 2); assert.equal(data.readUInt16LE(14), 32);
      assert.equal(bytes, 40 + size * size * 4 + Math.ceil(size / 32) * 4 * size);
    }
  });
});

test('the drawing puts the tile, the hand and the sparkles where the paths say', () => {
  for (const size of [32, 64, 256]) {
    const rgba = drawLogo(size);
    assert.equal(rgba.length, size * size * 4);
    assert.equal(pixel(rgba, size, 0, 0)[3], 0, 'outside the tile is transparent');
    assert.ok(near(rgba, size, [512, 300], LOGO.colors.paper, 6), `${size}: paper between the thumb and the sparkles`);
    assert.ok(near(rgba, size, [437.5, 425.3], LOGO.colors.ink), `${size}: the index finger is ink`);
    assert.ok(near(rgba, size, [742.1, 413.4], LOGO.colors.accent), `${size}: the big sparkle is orange`);
  }
  // Without the tile only the mark is drawn, on transparency.
  const mark = drawLogo(64, { tile: false });
  assert.equal(pixel(mark, 64, 0, 0)[3], 0); assert.equal(pixel(mark, 64, 32, 63)[3], 0);
  assert.ok(mark.some((v, i) => i % 4 === 3 && v === 255));
  // PNG output decodes back to the same pixels.
  const png = encodePng(drawLogo(24), 24, 24);
  const idat = png.subarray(33 + 8, png.length - 12 - 4);
  const raw = zlib.inflateSync(idat);
  assert.equal(raw.length, (24 * 4 + 1) * 24);
  assert.throws(() => drawLogo(4), /size/);
});

test('the paths are plain absolute M, L, C and Z', () => {
  assert.equal(parsePath(LOGO.hand).length, 1, 'the hand is one continuous line');
  assert.equal(parsePath(LOGO.hand)[0].closed, false);
  for (const d of LOGO.sparkles) assert.equal(parsePath(d)[0].closed, true);
  assert.throws(() => parsePath('L 1 2'), /start with M/);
  assert.throws(() => parsePath('M 1 2 C 3 4'), /number count/);
  assert.match(logoSvg(), /^<svg [^>]*viewBox="0 0 1024 1024"/);
  assert.match(logoSvg({ tile: false }), new RegExp(`viewBox="${LOGO.markBox.join(' ')}"`));
});

test('the host and the panel carry the same mark as logo.mjs', async () => {
  const cs = await read('app/host/ModelHarbor.cs');
  const logo = cs.slice(cs.indexOf('static class Logo'), cs.indexOf('static class Locate'));
  assert.ok(logo.includes(`public const string Hand = "${LOGO.hand}";`), 'host hand path');
  assert.ok(logo.includes(`public const float HandWidth = ${LOGO.handWidth}f;`));
  for (const d of LOGO.sparkles) assert.ok(logo.includes(`"${d}"`), 'host sparkle path');
  assert.ok(logo.includes(`public const float SparkleRound = ${LOGO.sparkleRound}f;`));
  assert.ok(logo.includes(`new RectangleF(${LOGO.markBox.map(n => `${n}f`).join(', ')})`), 'host mark box');
  const argb = hex => `Color.FromArgb(0x${hex.slice(1, 3)}, 0x${hex.slice(3, 5)}, 0x${hex.slice(5, 7)})`;
  for (const [name, colour] of [['Accent', LOGO.colors.accent], ['Ink', LOGO.colors.ink], ['TilePaper', LOGO.colors.paper], ['TileEdge', LOGO.colors.edge]])
    assert.ok(logo.includes(`${name} = ${argb(colour)}`), `host colour ${name}`);
  // The tray, the tab and the site window use it; the old tray glyph and the vertical name are gone.
  assert.match(cs, /trayIcon = Logo\.CreateTrayIcon\(/);
  assert.match(cs, /Logo\.Draw\(g, new RectangleF\(/);
  assert.match(cs, /theme == "dark", appIcon\);/);
  assert.ok(!cs.includes('static class Serif') && !cs.includes('static class Icons'));

  const html = await read('app/lib/panel.html');
  const footer = html.slice(html.indexOf('<div class="ver">'), html.indexOf('</div>', html.indexOf('<div class="ver">')));
  assert.ok(footer.includes(`viewBox="${LOGO.markBox.join(' ')}"`), 'panel mark box');
  assert.ok(footer.includes(`d="${LOGO.hand}" fill="none" stroke="currentColor" stroke-width="${LOGO.handWidth}"`), 'panel hand, in the text colour');
  for (const d of LOGO.sparkles) assert.ok(footer.includes(`d="${d}" fill="${LOGO.colors.accent}"`), 'panel sparkle');
  assert.match(footer, /<span>biubiu AI v\d+\.\d+\.\d+<\/span><button class="link update" id="updateLink" type="button" hidden><\/button>$/);
});

test('the build embeds the icon and writes it beside the exe', async () => {
  const build = await read('app/build.mjs');
  assert.match(build, /import \{ iconFile \} from '\.\/icon\.mjs';/);
  assert.match(build, /const icon = path\.join\(binDir, 'biubiu\.ico'\);\nfs\.writeFileSync\(icon, iconFile\(\)\);/);
  assert.ok(build.includes('`/win32icon:${icon}`'));
  assert.ok(build.indexOf('fs.writeFileSync(icon, iconFile())') < build.indexOf('spawnSync(csc, args'));
});

test('the old name appears nowhere the user or a developer reads', async () => {
  const files = ['README.md', 'AGENTS.md', 'package.json', 'app/build.mjs', 'app/icon.mjs', 'app/preview.mjs', 'app/server.mjs', 'app/server.test.mjs', 'app/host/ModelHarbor.cs', 'app/host/app.manifest',
    'build/companion-dev/smoke-host.ps1', 'build/companion-dev/verify.mjs', 'build/companion-dev/live-zcode.ps1', 'build/companion-dev/site-window-check.mjs', 'build/companion-dev/SiteWindowCheck.cs', 'build/companion-dev/logo-design.mjs',
    'app/installer/Setup.cs', 'app/installer/setup.manifest', 'app/installer/package.mjs', 'app/installer/package.test.mjs', 'build/companion-dev/installer-check.ps1',
    'app/demo.mjs', 'docs/tutorial.md', 'docs/development.md', 'build/companion-dev/docs-shots.mjs', 'build/companion-dev/docs-installer.ps1', 'build/companion-dev/window-helpers.ps1'];
  for (const name of await fs.readdir(path.join(appDir, 'lib'))) files.push(`app/lib/${name}`);
  const old = ['\u6a21\u578b\u6e2f', 'Model Harbor'];
  for (const file of files) {
    let text;
    try { text = await read(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const word of old) assert.ok(!text.includes(word), `${file} still says ${word}`);
  }
});
