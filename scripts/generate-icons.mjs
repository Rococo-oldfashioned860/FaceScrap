// Generates real PNG icon files (16/48/128px) with zero dependencies.
// A hand-rolled PNG encoder (RGBA) using Node's built-in zlib.
//
// Draws the FaceScrap "Scrapbook" mark: a saved Facebook memory mounted as a
// photo card — a light card with a blue (accent) frame, a blue landscape
// (sun + two mountains) inside, and a gold media badge with a play
// glyph at the bottom-right corner. Geometry lives on a 32×32 unit grid, mirroring
// the inline SVG in src/sidepanel/sidepanel.html; the two MUST stay in step.
// Transparent outside the rounded card, so the icon reads as a rounded tile on a
// light AND a dark browser toolbar. At 16px the two smallest details (sun, back
// mountain) are dropped so the card, its frame and one mountain stay legible.

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

// Palette — mirrors the inline SVG's baked colors and the panel's tokens.
const CARD = [238, 243, 251]; // #EEF3FB — the photo card
const FRAME = [77, 158, 255]; // #4D9EFF — the frame (the extension's accent blue)
const GOLD = [244, 185, 66]; // #F4B942 — sun + media badge
const BLUE = [77, 158, 255]; // #4D9EFF — front mountain
const BLUE_LT = [124, 156, 255]; // #7C9CFF — back mountain
const INK = [23, 33, 60]; // #17213C — the badge's play glyph

// Signed distance to a rounded rectangle centered at (cx,cy), half-size (hx,hy),
// corner radius r. Negative inside.
function roundedRectSDF(px, py, cx, cy, hx, hy, r) {
  const dx = Math.abs(px - cx) - (hx - r);
  const dy = Math.abs(py - cy) - (hy - r);
  return dx > 0 && dy > 0 ? Math.hypot(dx, dy) - r : Math.max(dx, dy) - r;
}

// Barycentric-sign point-in-triangle test.
function inTri(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// The scrapbook mark on its 32×32 grid (matches sidepanel.html's inline SVG):
//   card   rounded rect center (16,16) half 13, r 7, coral 2px frame;
//   badge  rounded rect center (25.75,25.75) half 4.25, r 2.5, gold, play glyph;
//   sun    circle (21.5,11.5) r 3.1; mountains two triangles.
// `simple` (16px) drops the sun and back mountain. Returns [r,g,b] or null.
function markColor(u, v, simple) {
  // Badge sits on top of the card's bottom-right corner and just past its edge.
  if (roundedRectSDF(u, v, 25.75, 25.75, 4.25, 4.25, 2.5) <= 0) {
    return inTri(u, v, 24.9, 24.3, 27.6, 25.9, 24.9, 27.5) ? INK : GOLD;
  }
  const card = roundedRectSDF(u, v, 16, 16, 13, 13, 7);
  if (card > 1) return null; // transparent outside the card
  if (card > -1) return FRAME; // the ~2px frame
  // Interior, front-to-back: front mountain, back mountain, sun, card fill.
  if (inTri(u, v, 19.5, 16.5, 28, 24.5, 11, 24.5)) return BLUE;
  if (!simple && inTri(u, v, 12, 13, 20, 24.5, 4, 24.5)) return BLUE_LT;
  if (!simple && Math.hypot(u - 21.5, v - 11.5) <= 3.1) return GOLD;
  return CARD;
}

// Map a pixel to the 32-grid and sample the mark; transparent outside the card.
function sample(px, py, size) {
  return markColor((px / size) * 32, (py / size) * 32, size <= 16);
}

// 4×4 supersampling: the card corners and mountain edges need anti-aliasing.
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
