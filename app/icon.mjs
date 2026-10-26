// Draws the biubiu AI icon from app/lib/logo.mjs without any image library and writes it as PNG or ICO.
// Paths are flattened into short segments; a pixel's coverage is its distance to the line for strokes (so edges are
// smooth at every size) and 4 x 4 samples for fills. app/build.mjs embeds the ICO in the exe.
// Usage: node app/icon.mjs <file.ico>   |   node app/icon.mjs <file.png> <size> [--mark]   |   node app/icon.mjs <file.svg> [--mark]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { LOGO, logoSvg } from './lib/logo.mjs';

// Windows asks for these when it shows the exe in Explorer, the taskbar, Start and Alt+Tab at any scaling.
export const ICON_SIZES = Object.freeze([16, 20, 24, 32, 40, 48, 64, 96, 128, 256]);

// Lines that would be thinner than this many pixels are drawn this thick, so the small icons keep their outline.
const MIN_LINE = 1.25;

export function parsePath(d) {
  const parts = String(d).match(/[MLCZ][^MLCZ]*/g);
  if (!parts || parts[0][0] !== 'M') throw new Error('a path must start with M');
  const subpaths = [];
  let current = null, pen = null;
  for (const part of parts) {
    const n = part.slice(1).trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (n.some(v => !Number.isFinite(v))) throw new Error(`bad number in "${part}"`);
    const op = part[0];
    if (op === 'M') { pen = [n[0], n[1]]; current = { points: [pen], closed: false }; subpaths.push(current); for (let i = 2; i < n.length; i += 2) current.points.push(pen = [n[i], n[i + 1]]); }
    else if (op === 'L') for (let i = 0; i < n.length; i += 2) current.points.push(pen = [n[i], n[i + 1]]);
    else if (op === 'C') for (let i = 0; i < n.length; i += 6) {
      const [x1, y1, x2, y2, x3, y3] = n.slice(i, i + 6);
      for (let s = 1; s <= 32; s++) {
        const t = s / 32, u = 1 - t;
        current.points.push([u * u * u * pen[0] + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * pen[1] + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3]);
      }
      pen = [x3, y3];
    }
    else if (op === 'Z') current.closed = true;
    if ((op === 'M' || op === 'L') && n.length % 2 !== 0 || op === 'C' && n.length % 6 !== 0) throw new Error(`wrong number count in "${part}"`);
  }
  return subpaths;
}

function segmentsOf(subpaths, scale) {
  const segs = [];
  for (const { points, closed } of subpaths) {
    const pts = points.map(([x, y]) => [x * scale, y * scale]);
    if (closed) pts.push(pts[0]);
    for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]]);
  }
  return segs;
}

function bounds(segs, pad, size) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [ax, ay, bx, by] of segs) { x0 = Math.min(x0, ax, bx); y0 = Math.min(y0, ay, by); x1 = Math.max(x1, ax, bx); y1 = Math.max(y1, ay, by); }
  return [Math.max(0, Math.floor(x0 - pad - 1)), Math.max(0, Math.floor(y0 - pad - 1)), Math.min(size, Math.ceil(x1 + pad + 1)), Math.min(size, Math.ceil(y1 + pad + 1))];
}

function distance(px, py, segs) {
  let best = Infinity;
  for (const [ax, ay, bx, by] of segs) {
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = ax + t * dx - px, ey = ay + t * dy - py, d = ex * ex + ey * ey;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

// Nonzero winding: the fills here are simple closed shapes.
function inside(px, py, segs) {
  let winding = 0;
  for (const [ax, ay, bx, by] of segs) {
    if (ay <= py) { if (by > py && (bx - ax) * (py - ay) - (px - ax) * (by - ay) > 0) winding++; }
    else if (by <= py && (bx - ax) * (py - ay) - (px - ax) * (by - ay) < 0) winding--;
  }
  return winding !== 0;
}

function hex(color) {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) throw new Error(`colour must be #rrggbb: ${color}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

// RGBA pixels (straight alpha) of the icon at size x size. tile: false draws only the mark, fitted to the square.
export function drawLogo(size, { tile = true, ink = LOGO.colors.ink, accent = LOGO.colors.accent } = {}) {
  if (!Number.isInteger(size) || size < 8 || size > 2048) throw new Error('size must be an integer from 8 to 2048');
  let scale = size / LOGO.canvas, shiftX = 0, shiftY = 0;
  if (!tile) {
    const [x, y, w, h] = LOGO.markBox, fit = size * 0.92 / Math.max(w, h);
    scale = fit; shiftX = (size - w * fit) / 2 - x * fit; shiftY = (size - h * fit) / 2 - y * fit;
  }
  const img = new Float64Array(size * size * 4); // premultiplied, 0..1
  const paint = (x, y, rgb, a) => {
    if (a <= 0) return;
    const i = (y * size + x) * 4, k = 1 - a;
    img[i] = rgb[0] * a + img[i] * k; img[i + 1] = rgb[1] * a + img[i + 1] * k; img[i + 2] = rgb[2] * a + img[i + 2] * k; img[i + 3] = a + img[i + 3] * k;
  };
  const shift = segs => segs.map(([ax, ay, bx, by]) => [ax + shiftX, ay + shiftY, bx + shiftX, by + shiftY]);

  if (tile) {
    // A rounded square: signed distance to its edge gives both the fill and the hairline around it.
    const t = LOGO.tile, x0 = t.x * scale, y0 = t.y * scale, s = t.size * scale, r = t.radius * scale;
    const edge = Math.max(t.edge * scale, 1), paper = hex(LOGO.colors.paper), line = hex(LOGO.colors.edge);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const qx = Math.abs(x + 0.5 - (x0 + s / 2)) - (s / 2 - r), qy = Math.abs(y + 0.5 - (y0 + s / 2)) - (s / 2 - r);
      const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
      paint(x, y, paper, Math.min(1, Math.max(0, 0.5 - sd)));
      paint(x, y, line, Math.min(1, Math.max(0, edge / 2 - Math.abs(sd + edge / 2) + 0.5)));
    }
  }

  const stroke = (segs, width, rgb) => {
    const half = Math.max(width, MIN_LINE) / 2, [bx0, by0, bx1, by1] = bounds(segs, half, size);
    for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) paint(x, y, rgb, Math.min(1, Math.max(0, half - distance(x + 0.5, y + 0.5, segs) + 0.5)));
  };
  const handSegs = shift(segmentsOf(parsePath(LOGO.hand), scale));
  stroke(handSegs, LOGO.handWidth * scale, hex(ink));

  const acc = hex(accent);
  for (const d of LOGO.sparkles) {
    const segs = shift(segmentsOf(parsePath(d), scale)), half = LOGO.sparkleRound * scale / 2, [bx0, by0, bx1, by1] = bounds(segs, half, size);
    for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) {
      let hits = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4, segs)) hits++;
      const rim = Math.min(1, Math.max(0, half - distance(x + 0.5, y + 0.5, segs) + 0.5));
      paint(x, y, acc, Math.max(hits / 16, rim));
    }
  }

  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < out.length; i += 4) {
    const a = img[i + 3];
    out[i + 3] = Math.round(a * 255);
    if (a > 0) for (let c = 0; c < 3; c++) out[i + c] = Math.round(Math.min(1, img[i + c] / a) * 255);
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xFFFFFFFF; for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) {
  const head = Buffer.alloc(4), tail = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  head.writeUInt32BE(data.length); tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

export function encodePng(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// A 32-bit DIB icon image: bottom-up BGRA, then the 1-bit mask, set where the pixel is fully transparent.
function dib(rgba, size) {
  const header = Buffer.alloc(40), pixels = Buffer.alloc(size * size * 4), row = Math.ceil(size / 32) * 4, mask = Buffer.alloc(row * size);
  header.writeUInt32LE(40, 0); header.writeInt32LE(size, 4); header.writeInt32LE(size * 2, 8); header.writeUInt16LE(1, 12); header.writeUInt16LE(32, 14); header.writeUInt32LE(size * size * 4, 20);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const s = (y * size + x) * 4, d = ((size - 1 - y) * size + x) * 4;
    pixels[d] = rgba[s + 2]; pixels[d + 1] = rgba[s + 1]; pixels[d + 2] = rgba[s]; pixels[d + 3] = rgba[s + 3];
    if (rgba[s + 3] === 0) mask[(size - 1 - y) * row + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return Buffer.concat([header, pixels, mask]);
}

// An .ico with every size in ICON_SIZES: classic DIB images up to 48, PNG from 64 (Windows reads both since Vista).
export function iconFile(sizes = ICON_SIZES) {
  const images = sizes.map(size => { const rgba = drawLogo(size); return { size, data: size >= 64 ? encodePng(rgba, size, size) : dib(rgba, size) }; });
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head[e] = size >= 256 ? 0 : size; head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6); head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map(i => i.data)]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, size] = process.argv.slice(2);
  if (!file) { console.error('usage: node app/icon.mjs <file.ico> | <file.png> <size> [--mark] | <file.svg> [--mark]'); process.exit(2); }
  if (file.toLowerCase().endsWith('.svg')) fs.writeFileSync(file, logoSvg({ tile: !process.argv.includes('--mark'), title: 'biubiu AI' }) + '\n');
  else if (file.toLowerCase().endsWith('.png')) {
    const n = Number(size || 256), rgba = drawLogo(n, { tile: !process.argv.includes('--mark') });
    fs.writeFileSync(file, encodePng(rgba, n, n));
  } else fs.writeFileSync(file, iconFile());
  console.log(`wrote ${file}`);
}
