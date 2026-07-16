// Generates real PNG icon files (16/48/128px) with zero dependencies.
// A hand-rolled PNG encoder (RGBA) using Node's built-in zlib.
// Draws the FaceScrap "Flow route" mark: the page (origin ring) loops out
// through a D-bowl and lands as a saved file — blue route, green destination
// node, pink filed square. White tile, hairline border; solid-blue mono glyph
// at 16px. Geometry lives on a 32×32 unit grid, mirroring the Figma vector.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'icons');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(size, pixel) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BLUE = [22, 111, 229]; // #166FE5 — route stroke, origin ring, mono glyph
const GREEN = [66, 183, 42]; // #42B72A — destination node (the save)
const PINK = [252, 167, 181]; // #FCA7B5 — filed square
const TILE = [255, 255, 255]; // #FFFFFF — light tile
const BORDER = [206, 208, 212]; // #CED0D4 — hairline (tile border)

// Signed distance to a rounded rectangle centered at (cx,cy), half-size (hx,hy),
// corner radius r. Negative inside.
function roundedRectSDF(px, py, cx, cy, hx, hy, r) {
  const dx = Math.abs(px - cx) - (hx - r);
  const dy = Math.abs(py - cy) - (hy - r);
  return dx > 0 && dy > 0 ? Math.hypot(dx, dy) - r : Math.max(dx, dy) - r;
}

// "Flow route" mark on its 32×32 grid (Figma node `FaceScrap/Flow/Logo Mark`):
// D-bowl = right half-ellipse centered (8.5, 16) rx 15 ry 9, 2-wide stroke;
// stem capsule x 8.5, y∈[10.5, 21.5], 1.5 wide; origin ring at (8.5, 7) r 3.5
// with a punched hole; green node at (23.5, 16) r 3.5; pink filed square
// centered (8.5, 25), 6×6, r 1.5. `mono` collapses every part to one color
// and thickens the strokes so the 16px glyph survives.
function markColor(u, v, mono) {
  if (roundedRectSDF(u, v, 8.5, 25, 3, 3, 1.5) <= 0) return mono || PINK;
  if (Math.hypot(u - 23.5, v - 16) <= 3.5) return mono || GREEN;
  const dOrigin = Math.hypot(u - 8.5, v - 7);
  if (dOrigin <= 4.25) return dOrigin >= (mono ? 2.35 : 2.75) ? (mono || BLUE) : null; // ring; hole shows the tile
  const stemHalf = mono ? 1.2 : 0.75;
  if (roundedRectSDF(u, v, 8.5, 16, stemHalf, 5.5 + stemHalf, stemHalf) <= 0) return mono || BLUE;
  if (u >= 8.5) {
    // Half-ellipse stroke via scaled-circle distance — exact enough under 4×4 SS.
    const d = (Math.hypot((u - 8.5) / 15, (v - 16) / 9) - 1) * 9;
    if (Math.abs(d) <= (mono ? 1.5 : 1)) return mono || BLUE;
  }
  return null;
}

// One sub-sample: transparent outside the tile, hairline border at its edge,
// multicolor glyph (solid blue at 16px) over the light tile.
function sample(px, py, size) {
  const c = size / 2;
  const tileDist = roundedRectSDF(px, py, c, c, c, c, size * 0.22);
  if (tileDist > 0) return null;
  const glyphRatio = size <= 16 ? 0.94 : 0.8;
  const g0 = (size * (1 - glyphRatio)) / 2;
  const u = ((px - g0) / (size * glyphRatio)) * 32;
  const v = ((py - g0) / (size * glyphRatio)) * 32;
  const col = markColor(u, v, size <= 16 ? BLUE : null);
  if (col) return col;
  return tileDist > -1 ? BORDER : TILE;
}

// 4×4 supersampling: the R's curved edges need anti-aliasing.
function pixel(x, y, size) {
  const SS = 4;
  let r = 0, g = 0, b = 0, hits = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const col = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, size);
      if (!col) continue;
      r += col[0];
      g += col[1];
      b += col[2];
      hits++;
    }
  }
  if (hits === 0) return [0, 0, 0, 0];
  return [Math.round(r / hits), Math.round(g / hits), Math.round(b / hits), Math.round((hits / (SS * SS)) * 255)];
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 48, 128]) {
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, encodePNG(size, pixel));
  console.log(`🎨 wrote icons/icon-${size}.png`);
}
