// Generates real PNG icon files (16/48/128px) with zero dependencies.
// A hand-rolled PNG encoder (RGBA) using Node's built-in zlib.
//
// Draws the FaceScrap "Scrapbook" mark: a saved Facebook memory mounted as a
// photo card — a light card with a blue (accent) frame, a blue landscape
// (sun + two mountains) inside, and a gold media badge with a play glyph at the
// bottom-right corner. The geometry and palette are PARSED out of the inline
// SVG in src/sidepanel/sidepanel.html at build time — the HTML is the single
// source of truth, so reshaping the logo there reshapes these PNGs, and any
// unparseable drift fails the build instead of silently forking the mark.
// Transparent outside the rounded card, so the icon reads as a rounded tile on a
// light AND a dark browser toolbar. At 16px the two smallest details (sun, back
// mountain) are dropped so the card, its frame and one mountain stay legible.

import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// ── Parse the mark out of sidepanel.html's inline SVG (32×32 viewBox) ────────
const svg = (() => {
  const html = readFileSync(join(ROOT, 'src', 'sidepanel', 'sidepanel.html'), 'utf8');
  const m = html.match(/<svg[^>]*viewBox="0 0 32 32"[\s\S]*?<\/svg>/);
  if (!m) throw new Error('generate-icons: logo <svg viewBox="0 0 32 32"> not found in sidepanel.html');
  return m[0];
})();

function fail(what) {
  throw new Error(`generate-icons: could not parse the logo SVG's ${what} — keep the icon script in step`);
}

function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex) ?? fail(`color "${hex}"`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// The card: the SVG's only stroked rect. Center/half-size/radius for the SDF.
const cardTag =
  svg.match(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)" fill="(#\w{6})" stroke="(#\w{6})" stroke-width="([\d.]+)"/) ??
  fail('stroked card rect');
const [cardX, cardY, cardW, cardH, cardR] = cardTag.slice(1, 6).map(Number);
const CARD_RECT = { cx: cardX + cardW / 2, cy: cardY + cardH / 2, hx: cardW / 2, hy: cardH / 2, r: cardR };
const CARD = hexToRgb(cardTag[6]);
const FRAME = hexToRgb(cardTag[7]);
const FRAME_HALF = Number(cardTag[8]) / 2;

// The badge: the filled, unstroked rect (the clipPath rect has no fill).
const badgeTag =
  svg.match(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)" fill="(#\w{6})" \/>/) ??
  fail('badge rect');
const [bX, bY, bW, bH, bR] = badgeTag.slice(1, 6).map(Number);
const BADGE_RECT = { cx: bX + bW / 2, cy: bY + bH / 2, hx: bW / 2, hy: bH / 2, r: bR };
const GOLD = hexToRgb(badgeTag[6]);

// The sun.
const sunTag = svg.match(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)" fill="(#\w{6})"/) ?? fail('sun circle');
const SUN = { cx: Number(sunTag[1]), cy: Number(sunTag[2]), r: Number(sunTag[3]), rgb: hexToRgb(sunTag[4]) };

// Triangles, in document (paint) order: back mountain, front mountain, play glyph.
const TRI_RE = /<path d="M([\d.]+) ([\d.]+) L([\d.]+) ([\d.]+) L([\d.]+) ([\d.]+) Z" fill="(#\w{6})"/g;
const tris = [...svg.matchAll(TRI_RE)].map((m) => ({ pts: m.slice(1, 7).map(Number), rgb: hexToRgb(m[7]) }));
if (tris.length !== 3) fail(`three triangle paths (found ${tris.length})`);
const [BACK_MTN, FRONT_MTN, GLYPH] = tris;

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

// The scrapbook mark on its 32×32 grid, drawn from the parsed SVG shapes.
// `simple` (16px) drops the sun and back mountain. Returns [r,g,b] or null.
function markColor(u, v, simple) {
  // Badge sits on top of the card's bottom-right corner and just past its edge.
  if (roundedRectSDF(u, v, BADGE_RECT.cx, BADGE_RECT.cy, BADGE_RECT.hx, BADGE_RECT.hy, BADGE_RECT.r) <= 0) {
    return inTri(u, v, ...GLYPH.pts) ? GLYPH.rgb : GOLD;
  }
  const card = roundedRectSDF(u, v, CARD_RECT.cx, CARD_RECT.cy, CARD_RECT.hx, CARD_RECT.hy, CARD_RECT.r);
  if (card > FRAME_HALF) return null; // transparent outside the card
  if (card > -FRAME_HALF) return FRAME; // the stroked frame band
  // Interior, front-to-back: front mountain, back mountain, sun, card fill.
  if (inTri(u, v, ...FRONT_MTN.pts)) return FRONT_MTN.rgb;
  if (!simple && inTri(u, v, ...BACK_MTN.pts)) return BACK_MTN.rgb;
  if (!simple && Math.hypot(u - SUN.cx, v - SUN.cy) <= SUN.r) return SUN.rgb;
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
