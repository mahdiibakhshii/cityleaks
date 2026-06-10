// Generates placeholder map + mask tiles for the tiles listed in
// shared/protocol.ts (MAP.TILES), including negative coordinates.
//
// Map tiles: RGB, distinct color per (col,row), border + top-left corner marker
//            (to verify orientation/placement on screen).
// Mask tiles: RGBA — TRANSPARENT = walkable, OPAQUE black blocks = buildings,
//            matching the real mask format (alpha = collision).
//
// Run: node tools/gen-placeholders.mjs
import { deflateSync } from 'zlib';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Parse the tile list + dimensions straight out of the shared protocol so this
// stays in sync without importing TypeScript.
const proto = readFileSync(resolve(ROOT, 'shared/protocol.ts'), 'utf8');
const W = Number(/TILE_WIDTH_PX:\s*(\d+)/.exec(proto)[1]);
const H = Number(/TILE_HEIGHT_PX:\s*(\d+)/.exec(proto)[1]);
const tilesBlock = /TILES:\s*\[([\s\S]*?)\]/.exec(proto)[1];
const TILES = [...tilesBlock.matchAll(/\{\s*col:\s*(-?\d+),\s*row:\s*(-?\d+)\s*\}/g)].map((m) => ({
  col: Number(m[1]),
  row: Number(m[2]),
}));

// ─── Minimal PNG encoder (RGB type 2 or RGBA type 6, 8-bit) ───
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
};
function encodePNG(width, height, pix, channels) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2; // 6 = RGBA, 2 = RGB
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    pix.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 6 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
}

// ─── Map tile (RGB) ───
function mapTile(col, row, idx, total) {
  const buf = Buffer.alloc(W * H * 3);
  const [r, g, b] = hslToRgb((idx / total) * 360, 55, 45);
  const set = (x, y, R, G, B) => {
    const i = (y * W + x) * 3;
    buf[i] = R;
    buf[i + 1] = G;
    buf[i + 2] = B;
  };
  const rect = (x0, y0, x1, y1, R, G, B) => {
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++)
      for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) set(x, y, R, G, B);
  };
  rect(0, 0, W, H, r, g, b);
  const bw = 10;
  rect(0, 0, W, bw, 20, 20, 30);
  rect(0, H - bw, W, H, 20, 20, 30);
  rect(0, 0, bw, H, 20, 20, 30);
  rect(W - bw, 0, W, H, 20, 20, 30);
  // Top-left corner marker (image space) — confirms tile orientation on screen.
  rect(24, 24, 184, 184, 255, 255, 255);
  rect(48, 48, 160, 160, r, g, b);
  return encodePNG(W, H, buf, 3);
}

// ─── Mask tile (RGBA): transparent roads, opaque black buildings ───
function maskTile() {
  const buf = Buffer.alloc(W * H * 4); // all zero = fully transparent = walkable
  const rect = (x0, y0, x1, y1) => {
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++)
      for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
        const i = (y * W + x) * 4;
        buf[i] = 0; // R
        buf[i + 1] = 0; // G
        buf[i + 2] = 0; // B
        buf[i + 3] = 255; // A — opaque = building = blocked
      }
  };
  const block = 320;
  const road = 128;
  for (let y = road; y + block <= H; y += block + road)
    for (let x = road; x + block <= W; x += block + road) rect(x, y, x + block, y + block);
  return encodePNG(W, H, buf, 4);
}

const mapDir = resolve(ROOT, 'client/public/tiles/map');
const maskDir = resolve(ROOT, 'client/public/tiles/mask');
rmSync(mapDir, { recursive: true, force: true });
rmSync(maskDir, { recursive: true, force: true });
mkdirSync(mapDir, { recursive: true });
mkdirSync(maskDir, { recursive: true });

TILES.forEach((t, i) => {
  writeFileSync(resolve(mapDir, `tile_${t.col}_${t.row}.png`), mapTile(t.col, t.row, i, TILES.length));
  writeFileSync(resolve(maskDir, `tile_${t.col}_${t.row}.png`), maskTile());
});
console.log(`Generated ${TILES.length} map + ${TILES.length} mask tiles (${W}x${H}) for:`,
  TILES.map((t) => `(${t.col},${t.row})`).join(' '));
