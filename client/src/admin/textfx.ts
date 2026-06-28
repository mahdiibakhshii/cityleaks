/**
 * Letter-treatment effects for stickers — bold, coloured outline, and a fuzzy
 * "felt" texture fill — applied on top of any letter style (tag / fill / plain).
 *
 * The effects are mask-based so they work uniformly across styles: the caller
 * builds a white-on-transparent glyph MASK (from TTF text, or from the tag
 * style's centerline strokes), then this module dilates it for the outline and
 * clips fibre stamping to it for the felt fill. Bold is a glyph-silhouette
 * dilation (a stroke onto the fill/mask), handled per style by the renderer.
 *
 * Pure canvas, deterministic given the design seed.
 */

import { STICKER_TEXTFX_DEFAULT, type StickerDesign, type StickerTextFx } from '../../../shared/protocol';
import { mulberry32, type Pt } from './spraytext';

/** Resolve a design's (optional) letter effects to a full StickerTextFx. */
export function resolveTextFx(design: StickerDesign): StickerTextFx {
  return { ...STICKER_TEXTFX_DEFAULT, ...(design.textFx ?? {}) };
}

/** Px the bold dilation adds to the glyph silhouette (0 when bold is off). */
export function boldPxFor(fontSize: number, fx: StickerTextFx): number {
  return fx.bold ? fontSize * (0.02 + 0.06 * fx.boldAmount) : 0;
}

function rgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function newCanvas(w: number, h: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, ctx: c.getContext('2d')! };
}

export interface MaskBBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * White-on-transparent glyph mask from a TTF text block. `boldPx` fattens the
 * silhouette (so the mask matches an emboldened fill). Mirrors the baseline math
 * the renderer + sprayFill use so the mask lines up with the painted glyphs.
 */
export function maskFromText(
  w: number,
  h: number,
  font: string,
  lines: string[],
  anchorX: number,
  firstBaseline: number,
  lineH: number,
  align: CanvasTextAlign,
  boldPx = 0,
  direction: CanvasDirection = 'ltr',
  /** Optional per-line anchor X (L-shaped corner-QR layout); falls back to `anchorX`. */
  anchorXs?: number[]
): HTMLCanvasElement {
  const { c, ctx } = newCanvas(w, h);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.lineJoin = 'round';
  ctx.lineWidth = boldPx;
  ctx.font = font;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = align;
  ctx.direction = direction;
  lines.forEach((line, li) => {
    const y = firstBaseline + li * lineH;
    const ax = anchorXs?.[li] ?? anchorX;
    ctx.fillText(line, ax, y);
    if (boldPx > 0) ctx.strokeText(line, ax, y);
  });
  return c;
}

/** White-on-transparent mask from tag centerline strokes, stroked at `width` px. */
export function maskFromStrokes(w: number, h: number, strokes: Pt[][], width: number): HTMLCanvasElement {
  const { c, ctx } = newCanvas(w, h);
  ctx.strokeStyle = '#fff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, width);
  for (const poly of strokes) {
    if (poly.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
    ctx.stroke();
  }
  return c;
}

/** Tight bbox of a mask's painted (alpha>100) pixels, or null if empty. */
export function maskBBox(mask: HTMLCanvasElement): MaskBBox | null {
  const ctx = mask.getContext('2d')!;
  const { width: w, height: h } = mask;
  const data = ctx.getImageData(0, 0, w, h).data;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (data[((row + x) << 2) + 3] > 100) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Paint a coloured outline AROUND the letters by dilating the mask: stamp the
 * mask at offsets around a circle of radius `width`, tint the union to the
 * outline colour, and draw it. Call BEFORE the fill so the fill covers the
 * interior and only the `width`-wide rim remains.
 */
export function drawOutline(
  ctx: CanvasRenderingContext2D,
  mask: HTMLCanvasElement,
  width: number,
  color: string
): void {
  if (width <= 0) return;
  const { width: w, height: h } = mask;
  const { c: tmp, ctx: tctx } = newCanvas(w, h);
  const steps = Math.max(16, Math.ceil(width * 2.5));
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    tctx.drawImage(mask, Math.cos(a) * width, Math.sin(a) * width);
  }
  // Also stamp at half radius so thick outlines stay solid (no inner gap).
  if (width > 4) {
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      tctx.drawImage(mask, Math.cos(a) * width * 0.5, Math.sin(a) * width * 0.5);
    }
  }
  tctx.globalCompositeOperation = 'source-in';
  tctx.fillStyle = color;
  tctx.fillRect(0, 0, w, h);
  // Cut the glyph interior back out so the result is a true RIM — otherwise the
  // colour would show through semi-transparent spray fills and tint the letters.
  tctx.globalCompositeOperation = 'destination-out';
  tctx.drawImage(mask, 0, 0);
  ctx.drawImage(tmp, 0, 0);
}

/**
 * Felt / fuzzy fill: stamp many short fibres in `feltColor`, clipped to the glyph
 * mask, for a woolly fabric look. `feltFuzz` ranges fibre direction from combed
 * (mostly vertical) to fully random; `feltDensity` sets coverage; `feltLength`
 * sets fibre length. Drawn ON TOP of the fill.
 */
export function drawFelt(
  ctx: CanvasRenderingContext2D,
  mask: HTMLCanvasElement,
  bbox: MaskBBox,
  fx: StickerTextFx,
  seed: number
): void {
  if (!fx.felt || fx.feltDensity <= 0) return;
  const { width: w, height: h } = mask;
  const { c: tmp, ctx: tctx } = newCanvas(w, h);
  const r = mulberry32((seed ^ 0xfe17a1) >>> 0);
  const [fr, fg, fb] = rgb(fx.feltColor);
  tctx.lineCap = 'round';

  const area = bbox.w * bbox.h;
  const count = Math.floor(area * 0.02 * fx.feltDensity);
  const spread = Math.PI * fx.feltFuzz; // 0 = combed vertical, π = any direction
  for (let i = 0; i < count; i++) {
    const x = bbox.x + r() * bbox.w;
    const y = bbox.y + r() * bbox.h;
    const ang = -Math.PI / 2 + (r() - 0.5) * 2 * spread;
    const len = fx.feltLength * (0.35 + 0.65 * r());
    const dx = (Math.cos(ang) * len) / 2;
    const dy = (Math.sin(ang) * len) / 2;
    const alpha = 0.12 + r() * 0.45;
    tctx.strokeStyle = `rgba(${fr},${fg},${fb},${alpha})`;
    tctx.lineWidth = 0.5 + r() * 1.6;
    tctx.beginPath();
    tctx.moveTo(x - dx, y - dy);
    tctx.lineTo(x + dx, y + dy);
    tctx.stroke();
  }

  // Clip the fibre layer to the glyph shape, then composite onto the sticker.
  tctx.globalCompositeOperation = 'destination-in';
  tctx.drawImage(mask, 0, 0);
  ctx.drawImage(tmp, 0, 0);
}
