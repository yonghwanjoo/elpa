// Draws the 1024px app icon (three message bars, the last one turned into a
// checked task) and writes it as a PNG. Usage: node scripts/make-icon.mjs <out.png>
import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/make-icon.mjs <out.png>');
  process.exit(1);
}

const S = 1024;
const px = new Uint8Array(S * S * 4);

// Signed distance to a rounded rectangle; negative means inside.
function roundRect(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
}
function segment(x, y, ax, ay, bx, by) {
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
}
function blend(i, [r, g, b], a) {
  if (a <= 0) return;
  const na = Math.min(1, a);
  const pa = px[i + 3] / 255;
  const oa = na + pa * (1 - na);
  px[i] = (r * na + px[i] * pa * (1 - na)) / oa;
  px[i + 1] = (g * na + px[i + 1] * pa * (1 - na)) / oa;
  px[i + 2] = (b * na + px[i + 2] * pa * (1 - na)) / oa;
  px[i + 3] = oa * 255;
}

const GREEN = [31, 111, 84];
const PAPER = [246, 244, 239];
const ORANGE = [226, 120, 60];

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const cover = (d) => Math.min(1, 0.5 - d); // 1px anti-aliased edge
    blend(i, GREEN, cover(roundRect(x, y, 512, 512, 412, 412, 190)));
    blend(i, PAPER, cover(roundRect(x, y, 452, 352, 190, 42, 42)) * 0.55);
    blend(i, PAPER, cover(roundRect(x, y, 512, 512, 250, 42, 42)) * 0.8);
    blend(i, ORANGE, cover(roundRect(x, y, 312, 672, 50, 50, 50)));
    blend(i, PAPER, cover(Math.min(segment(x, y, 290, 674, 306, 692), segment(x, y, 306, 692, 336, 654)) - 9));
    blend(i, PAPER, cover(roundRect(x, y, 582, 672, 180, 42, 42)));
  }
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter: none
  Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA

writeFileSync(out, Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]));
console.log(`wrote ${out}`);
