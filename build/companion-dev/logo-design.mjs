// Design source of the biubiu AI mark: a finger gun drawn as one continuous line (wrist, back of the hand, thumb,
// index finger, two curled knuckles, wrist) firing two four-pointed AI sparkles, "biu biu". The hand is drawn on its own
// grid pointing right, then tilted, scaled and centred on the 1024 canvas of the icon tile.
// Prints the baked constants for app/lib/logo.mjs. Usage: node build/companion-dev/logo-design.mjs
const HAND = 'M 316 868 C 308 790 298 716 298 640 C 298 560 312 500 332 452 L 332 290 C 332 244 364 210 401 210 C 438 210 470 244 470 290 L 470 404 L 804 404 C 846 404 880 438 880 480 C 880 522 846 556 804 556 L 640 556 C 694 560 712 616 684 654 C 666 678 640 686 614 686 C 662 696 676 746 650 780 C 630 806 594 814 556 812 C 528 812 512 826 506 868';
const TIP = [880, 480], PIVOT = [600, 540];
const design = { rotate: -12, scale: 0.68, stroke: 80, gap: 20, big: 83, small: 38.5, smallAt: [55, -140], round: 18, pinch: 0.16 };

const a = design.rotate * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
const place = ([x, y]) => [((x - PIVOT[0]) * cos - (y - PIVOT[1]) * sin) * design.scale, ((x - PIVOT[0]) * sin + (y - PIVOT[1]) * cos) * design.scale];

// Path numbers come in x, y pairs after M / L / C; the transform is affine, so moving the control points moves the curve.
function mapPath(d, f) {
  const out = [];
  for (const part of d.match(/[MLCZ][^MLCZ]*/g)) {
    const nums = part.slice(1).trim().split(/[\s,]+/).filter(Boolean).map(Number);
    const pts = [];
    for (let i = 0; i < nums.length; i += 2) pts.push(f([nums[i], nums[i + 1]]));
    out.push(part[0] + (pts.length ? ' ' + pts.map(([x, y]) => `${round(x)} ${round(y)}`).join(' ') : ''));
  }
  return out.join(' ');
}
const round = n => Math.round(n * 10) / 10;

// The sparkles sit beyond the fingertip, along the finger.
const [tx, ty] = place(TIP), edge = design.stroke / 2 * design.scale;
const reach = edge + design.gap + design.big * 1.06;
const big = [tx + reach * cos, ty + reach * sin];
const small = [big[0] + design.smallAt[0] * cos - design.smallAt[1] * sin, big[1] + design.smallAt[0] * sin + design.smallAt[1] * cos];
function sparkle([cx, cy], r, k = design.pinch) {
  // four points joined by concave curves (each quadratic written as a cubic)
  const pts = [[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]];
  const ctrl = [[cx + r * k, cy - r * k], [cx + r * k, cy + r * k], [cx - r * k, cy + r * k], [cx - r * k, cy - r * k]];
  let d = `M ${round(pts[0][0])} ${round(pts[0][1])}`;
  for (let i = 0; i < 4; i++) {
    const p0 = pts[i], p2 = pts[(i + 1) % 4], q = ctrl[i];
    const c1 = [p0[0] + 2 / 3 * (q[0] - p0[0]), p0[1] + 2 / 3 * (q[1] - p0[1])], c2 = [p2[0] + 2 / 3 * (q[0] - p2[0]), p2[1] + 2 / 3 * (q[1] - p2[1])];
    d += ` C ${round(c1[0])} ${round(c1[1])} ${round(c2[0])} ${round(c2[1])} ${round(p2[0])} ${round(p2[1])}`;
  }
  return d + ' Z';
}

// Bounds of the drawn mark (curves sampled, the line's half width added) to centre it on the canvas.
function bounds(d, pad) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  let pen = null;
  for (const part of d.match(/[MLCZ][^MLCZ]*/g)) {
    const n = part.slice(1).trim().split(/[\s,]+/).filter(Boolean).map(Number);
    const add = (x, y) => { box[0] = Math.min(box[0], x - pad); box[1] = Math.min(box[1], y - pad); box[2] = Math.max(box[2], x + pad); box[3] = Math.max(box[3], y + pad); };
    if (part[0] === 'M' || part[0] === 'L') { pen = [n[0], n[1]]; add(...pen); }
    if (part[0] === 'C') {
      for (let t = 0; t <= 1; t += 1 / 32) {
        const u = 1 - t, x = u * u * u * pen[0] + 3 * u * u * t * n[0] + 3 * u * t * t * n[2] + t * t * t * n[4], y = u * u * u * pen[1] + 3 * u * u * t * n[1] + 3 * u * t * t * n[3] + t * t * t * n[5];
        add(x, y);
      }
      pen = [n[4], n[5]];
    }
  }
  return box;
}
const handRaw = mapPath(HAND, place);
const sparkRaw = [sparkle(big, design.big), sparkle(small, design.small)];
const boxes = [bounds(handRaw, design.stroke / 2 * design.scale), ...sparkRaw.map(d => bounds(d, design.round / 2))];
const box = [Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])), Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))];
const shift = [512 - (box[0] + box[2]) / 2, 512 - (box[1] + box[3]) / 2];
const move = ([x, y]) => [x + shift[0], y + shift[1]];
const hand = mapPath(handRaw, move);
const sparkles = sparkRaw.map(d => mapPath(d, move));
const view = [box[0] + shift[0], box[1] + shift[1], box[2] - box[0], box[3] - box[1]].map(round);

console.log(JSON.stringify({ hand, handWidth: round(design.stroke * design.scale), sparkles, sparkleRound: design.round, markBox: view }, null, 2));
