// The biubiu AI mark: a finger gun drawn as one continuous line, firing two four-pointed AI sparkles ("biu biu").
// This file is the only source of its shape and colours. app/icon.mjs draws the exe icon from it at build time; the
// host's Logo class (app/host/ModelHarbor.cs) and the panel footer (app/lib/panel.html) carry copies of the same paths,
// which app/lib/core.test.mjs compares with these. To change the drawing, edit build/companion-dev/logo-design.mjs,
// run it, and paste its output here and into those copies.
// Coordinates are on a 1024 x 1024 canvas; the paths use only absolute M, L, C and Z.
export const LOGO = Object.freeze({
  canvas: 1024,
  // the app icon's rounded tile, as Windows 11 app icons leave a margin around theirs
  tile: Object.freeze({ x: 100, y: 100, size: 824, radius: 184, edge: 4 }),
  colors: Object.freeze({ paper: '#F6F4F0', edge: '#E4E1DB', ink: '#1B1B1C', accent: '#EA580C' }),
  // one stroke: wrist, back of the hand, thumb, top of the index finger, fingertip, underside, two knuckles, wrist
  hand: 'M 289.6 779.3 C 273.2 728.6 256.1 680.8 245.4 630.2 C 234.1 577 234.9 535.1 241.4 500.4 L 218.5 392.6 C 212 362 228.5 334.9 253.1 329.6 C 277.7 324.4 303.8 342.5 310.3 373.1 L 326.4 448.9 L 548.6 401.7 C 576.5 395.8 603.9 413.6 609.9 441.5 C 615.8 469.4 598 496.9 570.1 502.8 L 461 526 C 497.5 521 517.3 555.7 504.1 585 C 495.5 603.5 479.3 612.5 462.1 616.1 C 495.4 616 511.8 647.3 499.3 673.6 C 489.7 693.7 466.8 704.1 441.3 708.1 C 422.7 712.1 414 723.7 415.9 752.5',
  handWidth: 54.4,
  // filled, with their points rounded by a line of sparkleRound in the same colour
  sparkles: Object.freeze([
    'M 742.1 330.4 C 750.9 376.9 778.6 404.5 825.1 413.4 C 778.6 422.3 750.9 449.9 742.1 496.4 C 733.2 449.9 705.6 422.3 659.1 413.4 C 705.6 404.5 733.2 376.9 742.1 330.4 Z',
    'M 766.8 226.5 C 770.9 248.1 783.7 260.9 805.3 265 C 783.7 269.1 770.9 282 766.8 303.5 C 762.7 282 749.8 269.1 728.3 265 C 749.8 260.9 762.7 248.1 766.8 226.5 Z'
  ]),
  sparkleRound: 18,
  // the drawn mark without the tile: x, y, width, height
  markBox: Object.freeze([189.9, 217.5, 644.2, 589])
});

// SVG of the mark. tile: true draws the app icon (tile and mark); false only the mark, cropped to markBox, with the hand
// in `ink` (e.g. 'currentColor' to follow the text colour).
export function logoSvg({ tile = true, size, ink = LOGO.colors.ink, accent = LOGO.colors.accent, title } = {}) {
  const [x, y, w, h] = LOGO.markBox;
  const view = tile ? `0 0 ${LOGO.canvas} ${LOGO.canvas}` : `${x} ${y} ${w} ${h}`;
  const t = LOGO.tile;
  const dims = size ? ` width="${size}" height="${tile ? size : Math.round(size * h / w)}"` : '';
  const label = title ? ` role="img" aria-label="${title}"` : ' aria-hidden="true"';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view}"${dims}${label}>`
    + (tile ? `<rect x="${t.x}" y="${t.y}" width="${t.size}" height="${t.size}" rx="${t.radius}" fill="${LOGO.colors.paper}" stroke="${LOGO.colors.edge}" stroke-width="${t.edge}"/>` : '')
    + `<path d="${LOGO.hand}" fill="none" stroke="${ink}" stroke-width="${LOGO.handWidth}" stroke-linecap="round" stroke-linejoin="round"/>`
    + LOGO.sparkles.map(d => `<path d="${d}" fill="${accent}" stroke="${accent}" stroke-width="${LOGO.sparkleRound}" stroke-linejoin="round"/>`).join('')
    + '</svg>';
}
