import QRCode from 'qrcode';
import {
  STICKER_SPRAY_DEFAULT,
  type StickerDesign,
  type StickerQrPos,
  type StickerBorder,
  type StickerBackground,
} from '../../../shared/protocol';
import { sprayFill, sprayStrokes, layoutSprayText, toSprayParams, hashSeed } from './spraytext';
import {
  resolveTextFx,
  boldPxFor,
  maskFromText,
  maskFromStrokes,
  maskBBox,
  drawOutline,
  drawFelt,
} from './textfx';

/**
 * Sticker designer rendering. A "sticker" is the printable artwork for a note: a
 * white-background layout of the note's text + the note's chat QR code, sized
 * like a street sticker so several tile onto one A4 sheet. This module is the
 * single source of truth for how a StickerDesign config renders to pixels —
 * reused by the live preview, the saved-thumbnail, the download, and print.
 */

export interface StickerFont {
  id: string;
  label: string;
  /** CSS font-family string (may include fallbacks). */
  family: string;
  /** Font-weight token used in ctx.font. */
  weight: string;
}

export const STICKER_FONTS: StickerFont[] = [
  { id: 'seikora',   label: 'Seikora',          family: '"Seikora", Arial, sans-serif',          weight: '400' },
  { id: 'desimate',  label: 'Desimate Stonger',  family: '"DesimateStonger", Arial, sans-serif',  weight: '400' },
  { id: 'impact',    label: 'Impact',            family: '"ImpactLeak", Impact, "Arial Narrow", sans-serif', weight: '400' },
  { id: 'walnut',    label: 'Walnut',            family: '"Walnut", Georgia, serif',              weight: '400' },
  { id: 'vazirmatn', label: 'Vazirmatn (فارسی)', family: '"Vazirmatn", Tahoma, Arial, sans-serif', weight: '700' },
  { id: 'firstgay',  label: 'First Gay Americans', family: '"FirstGayAmericans", Arial, sans-serif', weight: '400' },
  { id: 'jewsstop',  label: 'Jews Say Stop Genocide', family: '"JewsSayStopGenocide", Arial, sans-serif', weight: '400' },
  { id: 'waymofire', label: 'Waymo Cars On Fire', family: '"WaymoCarsOnFire", Arial, sans-serif', weight: '400' },
  { id: 'risdstrike', label: 'RISD Teamsters Strike', family: '"RISDTeamstersStrike", Arial, sans-serif', weight: '400' },
  { id: 'default',   label: 'Default (Arial)',   family: '"Arial Narrow", Arial, sans-serif',     weight: '700' },
];

/** Unicode ranges covering Arabic/Persian script (incl. presentation forms). */
const ARABIC_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

/** True if the text contains Persian/Arabic script (needs RTL + a Persian font). */
export function hasArabic(text: string): boolean {
  return ARABIC_RE.test(text);
}

/**
 * The Hershey stroke ("tag") engine only has printable-ASCII glyphs. Any other
 * character (Persian, German umlauts, accents…) has no stroke data and would
 * render as a blank gap, so such text falls back to the solid-fill renderer.
 */
export function isStrokeRenderable(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[^\n\x20-\x7E]/.test(text);
}

/** Font to render with: force the Persian font for Arabic-script text. */
function pickFont(design: StickerDesign): StickerFont {
  return hasArabic(design.text) ? fontById('vazirmatn') : fontById(design.fontId);
}

export function fontById(id: string): StickerFont {
  return STICKER_FONTS.find((f) => f.id === id) ?? STICKER_FONTS[0];
}

/** Build the canvas font string for a given size + StickerFont. */
export function fontString(font: StickerFont, size: number): string {
  return `${font.weight} ${size}px ${font.family}`;
}

/** Ensure a font is loaded before canvas uses it; resolves immediately if cached. */
export async function ensureFont(font: StickerFont, size: number): Promise<void> {
  try {
    await document.fonts.load(fontString(font, size));
  } catch {
    // Non-fatal: canvas will fall back to the fallback family.
  }
}

/**
 * Ensure the font that this design will actually render with is loaded — the
 * chosen typeface, or the Persian font when the text is Arabic-script. Callers
 * should await this before `renderSticker` so custom fonts never fall back.
 */
export async function ensureDesignFont(design: StickerDesign): Promise<void> {
  await ensureFont(pickFont(design), design.fontSize);
}

/** A starting-point preset. The real render uses the resolved w/h/font/etc. */
export interface StickerPreset {
  id: string;
  label: string;
  w: number;
  h: number;
  fontSize: number;
  align: StickerDesign['align'];
  qrPos: StickerQrPos;
}

// Pixel sizes are at print resolution (~300dpi ⇒ a ~700px edge ≈ 60mm). Kept
// small + multiples-friendly so a page of them fits an A4 sheet.
export const STICKER_PRESETS: StickerPreset[] = [
  { id: 'oneRowRight', label: 'One row · QR right', w: 820, h: 240, fontSize: 96, align: 'left', qrPos: 'right' },
  { id: 'twoRowRight', label: 'Two rows · QR right', w: 640, h: 340, fontSize: 72, align: 'left', qrPos: 'right' },
  { id: 'qrLeft', label: 'QR left · text right', w: 820, h: 240, fontSize: 88, align: 'left', qrPos: 'left' },
  { id: 'qrBottom', label: 'Text top · QR bottom', w: 480, h: 600, fontSize: 80, align: 'center', qrPos: 'bottom' },
  { id: 'textOnly', label: 'Text only (no QR)', w: 640, h: 320, fontSize: 110, align: 'center', qrPos: 'none' },
];

export function presetById(id: string): StickerPreset | undefined {
  return STICKER_PRESETS.find((p) => p.id === id);
}

/** Build a fresh design from a preset for the given note text. */
export function designFromPreset(
  preset: StickerPreset,
  text: string,
  fontId = 'seikora'
): StickerDesign {
  return {
    template: preset.id,
    w: preset.w,
    h: preset.h,
    fontSize: preset.fontSize,
    align: preset.align,
    qrPos: preset.qrPos,
    qrScale: 1,
    fontId,
    text,
    updatedAt: Date.now(),
  };
}

/**
 * Suggest a starting template from the note's word count — the user's stated
 * rule of thumb (mostly driven by how much text there is). Always overridable.
 */
export function suggestPreset(text: string): StickerPreset {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words <= 4) return STICKER_PRESETS[0]; // one row + QR right
  if (words <= 12) return STICKER_PRESETS[1]; // two rows + QR right
  return STICKER_PRESETS[3]; // text top, QR bottom (more room)
}

/** Render a QR code for a URL to an offscreen canvas (white quiet-zone included). */
export async function makeQrCanvas(url: string): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  await QRCode.toCanvas(canvas, url, {
    width: 512,
    margin: 1,
    color: { dark: '#000000', light: '#ffffff' },
  });
  return canvas;
}

/**
 * Map "smart"/Unicode punctuation to plain ASCII before rendering. Mobile
 * keyboards (iOS/Android) silently insert curly apostrophes/quotes (’ “ ”), and
 * pasted text often carries en/em dashes or ellipses. The stroke-font ("tag")
 * engine only has ASCII 33–126 glyphs, so a curly apostrophe renders as a blank
 * gap — e.g. "can’t" became "can t". Normalizing here keeps every style (tag /
 * fill / plain) drawing the intended glyph from the chosen font.
 */
export function normalizeStickerText(text: string): string {
  return text
    .replace(/[‘’‚‛′]/g, "'") // ‘ ’ ‚ ‛ ′ → '
    .replace(/[“”„‟″]/g, '"') // “ ” „ ‟ ″ → "
    .replace(/[–—‒―−]/g, '-') // – — ‒ ― − → -
    .replace(/…/g, '...') // … → ...
    .replace(/[   ]/g, ' '); // non-breaking / figure / narrow spaces → space
}

/**
 * Split text into render lines: honor explicit \n, then word-wrap each to width.
 * `width` may be a constant or a per-line function (`li` = the line index being
 * built) so an L-shaped (corner-QR) layout can narrow lines beside the logo.
 */
function layoutLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  width: number | ((li: number) => number)
): string[] {
  const widthFor = typeof width === 'function' ? width : () => width;
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    const words = rawLine.split(' ');
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= widthFor(out.length) || !line) {
        line = candidate;
      } else {
        out.push(line);
        line = word;
      }
    }
    out.push(line); // includes '' for blank lines (preserves spacing)
  }
  return out;
}

/** A computed sticker layout: the QR rect (if any) + the remaining text region. */
interface StickerLayout {
  qr: { x: number; y: number; size: number } | null;
  textX: number;
  textY: number;
  textW: number;
  textH: number;
  /**
   * L-shaped text exclusion (only set for the bottom-right `corner` QR): the text
   * region is the full sticker, but any line whose vertical band dips below
   * `exclude.y` must stop at `exclude.x` (the QR's left edge) so it wraps to the
   * LEFT of the logo instead of over it. Absent ⇒ a plain rectangular region.
   */
  exclude?: { x: number; y: number };
}

/**
 * The wrap + placement box for one text line. For an L-shaped (corner) layout a
 * line that reaches into the QR's vertical band is narrowed to the QR's left
 * edge; every other line (and all non-corner layouts) keeps the full width. Top-
 * anchored: `topY` is the top of the line's band.
 */
function lineRegionAt(
  topY: number,
  lineH: number,
  textX: number,
  textW: number,
  exclude?: { x: number; y: number }
): { x: number; w: number } {
  if (!exclude || topY + lineH <= exclude.y) return { x: textX, w: textW };
  return { x: textX, w: Math.max(Math.round(textW * 0.25), exclude.x - textX) };
}

/**
 * Resolve where the QR + text go for a design. The QR's auto slot is scaled by
 * `qrScale` (the admin's "QR size" slider), and the text takes whatever room is
 * left — so shrinking the QR gives the text more space. Shared by the renderer +
 * the auto-fit so they always agree.
 */
function stickerLayout(design: StickerDesign): StickerLayout {
  const { w, h, qrPos, qrScale } = design;
  const base = Math.round(Math.min(w, h) * 0.07);
  // A border eats into the content area: inset past the stroke (+ a small gap) so
  // text/QR never collide with the frame. Borderless designs keep their exact pad.
  const bw = design.border && design.border.width > 0 ? design.border.width : 0;
  const pad = bw > 0 ? Math.max(base, bw + Math.round(Math.min(w, h) * 0.03)) : base;
  const layout: StickerLayout = {
    qr: null,
    textX: pad,
    textY: pad,
    textW: w - pad * 2,
    textH: h - pad * 2,
  };
  if (qrPos === 'none') return layout;

  if (qrPos === 'corner') {
    // Small logo anchored bottom-right. The text region stays the FULL sticker
    // area (the default above), but `exclude` carves the logo's box out of it so
    // lines beside the QR wrap to its LEFT (an L-shape) instead of over it.
    const slot = Math.min(w - pad * 2, h - pad * 2) * 0.45;
    const size = slot * qrScale;
    const qx = w - pad - size;
    const qy = h - pad - size;
    // Small breathing gap so text can sit close to the logo without touching it.
    const gap = Math.round(Math.min(w, h) * 0.01);
    layout.qr = { x: qx, y: qy, size };
    layout.exclude = { x: qx - gap, y: qy - gap };
  } else if (qrPos === 'right' || qrPos === 'left') {
    const slot = Math.min(h - pad * 2, w * 0.5);
    const size = slot * qrScale;
    const y = (h - size) / 2;
    // Anchor the QR to its edge; the text takes ALL the remaining width, so a
    // smaller QR hands its freed space to the text.
    const x = qrPos === 'right' ? w - pad - size : pad;
    layout.qr = { x, y, size };
    layout.textW = w - pad * 2 - size - pad;
    if (qrPos === 'left') layout.textX = pad + size + pad;
  } else {
    // bottom-center: text takes all the remaining height above the QR.
    const slot = Math.min(w - pad * 2, h * 0.5);
    const size = slot * qrScale;
    const x = (w - size) / 2;
    const y = h - pad - size;
    layout.qr = { x, y, size };
    layout.textH = h - pad * 2 - size - pad;
  }
  return layout;
}

// ── Generative water background ───────────────────────────────────────────
// A canvas port of the in-game PathLayer water shader: each chunky square cell
// gets a per-cell hash that picks a band of the deep→mid→light blue palette
// (a second hash spreads brightness across the band), with an optional foam rim
// on patch edges. Deterministic from `seed` (no time term — a still snapshot).

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mixRgb(
  a: [number, number, number],
  b: [number, number, number],
  t: number
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function rgbStr(c: [number, number, number]): string {
  return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
}
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
/** Deterministic per-cell hash → [0,1) (integer-mixed, seed-salted). */
function hashCell(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2246822519)) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/**
 * A balanced grid that holds EXACTLY `count` cells inside a w×h rectangle with
 * the cells as square / equal as possible. `rows` is chosen so each cell is ~√
 * (area/count); cells are then distributed so the first `extra` rows carry one
 * more column (`base+1`) and the rest carry `base` — total = exactly `count`.
 * Shared by the renderer + the modal's readout so they always agree.
 */
export function waterGrid(
  w: number,
  h: number,
  count: number
): { rows: number; base: number; extra: number } {
  const n = Math.max(1, Math.round(count));
  const rows = Math.max(1, Math.min(n, Math.round(Math.sqrt((n * h) / w)) || 1));
  const base = Math.floor(n / rows);
  const extra = n - base * rows; // first `extra` rows get one extra column
  return { rows, base, extra };
}

/** Paint the generative pixel water background across the whole sticker. */
export function drawWaterBackground(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  bg: StickerBackground
): void {
  // The "dry" base fills everything first; water cells are painted over it.
  ctx.fillStyle = bg.base;
  ctx.fillRect(0, 0, w, h);

  const seed = bg.seed >>> 0;
  const bandSeed = (seed ^ 0x85ebca6b) >>> 0;
  const deep = hexToRgb(bg.deep);
  const mid = hexToRgb(bg.mid);
  const light = hexToRgb(bg.light);

  // Shade one cell from the palette by its per-cell hash (variation spreads it).
  const cellColor = (cx: number, cy: number): [number, number, number] => {
    const n = hashCell(cx, cy, seed);
    const s = hashCell(cx, cy, bandSeed);
    const t = Math.min(1, Math.max(0, n * 0.7 + s * bg.variation));
    let col = mixRgb(deep, mid, smoothstep(0, 0.55, t));
    col = mixRgb(col, light, smoothstep(0.55, 1, t));
    return col;
  };

  ctx.globalAlpha = bg.opacity;

  if (bg.mode === 'count') {
    // Data-viz: exactly `count` cells (one per submitted text), tiled as evenly
    // as possible. Pixel-snapped row/column edges so the tiling has no seams.
    const { rows, base, extra } = waterGrid(w, h, bg.count);
    for (let r = 0; r < rows; r++) {
      const cols = base + (r < extra ? 1 : 0);
      if (cols <= 0) continue;
      const y0 = Math.round((r * h) / rows);
      const y1 = Math.round(((r + 1) * h) / rows);
      for (let c = 0; c < cols; c++) {
        const x0 = Math.round((c * w) / cols);
        const x1 = Math.round(((c + 1) * w) / cols);
        ctx.fillStyle = rgbStr(cellColor(c, r));
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
    }
    ctx.globalAlpha = 1;
    return;
  }

  // 'size' mode: uniform pixelSize grid with optional patchy coverage + foam.
  const ps = Math.max(2, Math.round(bg.pixelSize));
  const cols = Math.ceil(w / ps);
  const rows = Math.ceil(h / ps);
  const fillSeed = (seed ^ 0x9e3779b9) >>> 0;
  const foam = hexToRgb(bg.foamColor);
  const full = bg.coverage >= 1;
  const isWater = (cx: number, cy: number): boolean => {
    if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return false;
    return full || hashCell(cx, cy, fillSeed) < bg.coverage;
  };
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if (!isWater(cx, cy)) continue;
      let col = cellColor(cx, cy);
      // Foam rim: a cell with any empty 4-neighbour (only happens when coverage<1).
      if (bg.foam > 0 && !full) {
        const edge =
          !isWater(cx, cy - 1) || !isWater(cx, cy + 1) || !isWater(cx - 1, cy) || !isWater(cx + 1, cy);
        if (edge) col = mixRgb(col, foam, bg.foam);
      }
      ctx.fillStyle = rgbStr(col);
      ctx.fillRect(cx * ps, cy * ps, ps, ps);
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * Stroke the decorative frame just inside the sticker edge. The stroke's OUTER
 * edge sits flush to the canvas edge (centerline inset by half the width); a
 * positive `radius` rounds the corners (clamped so it can't exceed the half-side).
 */
function drawBorder(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  border: StickerBorder
): void {
  const bw = border.width;
  const inset = bw / 2;
  const rw = w - bw;
  const rh = h - bw;
  if (rw <= 0 || rh <= 0) return;
  const r = Math.max(0, Math.min(border.radius, Math.min(rw, rh) / 2));
  ctx.save();
  ctx.strokeStyle = border.color;
  ctx.lineWidth = bw;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (r > 0 && typeof ctx.roundRect === 'function') {
    ctx.roundRect(inset, inset, rw, rh, r);
  } else {
    ctx.rect(inset, inset, rw, rh);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * Render a sticker design into `canvas` at its design pixel resolution. `qr` is
 * the pre-rendered QR canvas (ignored when qrPos==='none'). Pure + deterministic.
 */
export function renderSticker(
  canvas: HTMLCanvasElement,
  design: StickerDesign,
  qr: HTMLCanvasElement | null
): void {
  design = { ...design, text: normalizeStickerText(design.text) };
  const { w, h, align } = design;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Persian/Arabic needs right-to-left layout; the stroke ("tag") engine can't
  // draw non-ASCII glyphs, so such text renders via the solid-fill path instead.
  const dir: CanvasDirection = hasArabic(design.text) ? 'rtl' : 'ltr';
  const effectiveStyle =
    design.style === 'tag' && !isStrokeRenderable(design.text) ? 'fill' : design.style;

  // Sticker background: generative pixel water (if configured) or plain white.
  if (design.background && design.background.kind === 'water') {
    drawWaterBackground(ctx, w, h, design.background);
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
  }

  // Optional decorative frame, drawn just inside the sticker edge (under content).
  if (design.border && design.border.width > 0) {
    drawBorder(ctx, w, h, design.border);
  }

  const { qr: qrRect, textX, textY, textW, textH, exclude } = stickerLayout(design);
  if (qr && qrRect) {
    ctx.drawImage(qr, qrRect.x, qrRect.y, qrRect.size, qrRect.size);
  }

  // Vertical nudge of the first text row, as a fraction of sticker height (0 ⇒
  // each style's default position). Shifts every render path uniformly.
  const offY = (design.textOffsetY ?? 0) * h;

  // Per-line wrap/placement region: full width, except an L-shaped (corner-QR)
  // layout narrows lines beside the logo. `topY0` is the top of the FIRST line;
  // each style passes its own top + line height so the band test lands right.
  const lineBoxAt = (li: number, topY0: number, lineH: number): { x: number; w: number } =>
    lineRegionAt(topY0 + li * lineH, lineH, textX, textW, exclude);
  const anchorFor = (box: { x: number; w: number }): number =>
    align === 'left' ? box.x : align === 'right' ? box.x + box.w : box.x + box.w / 2;

  // Letter treatments (bold / outline / felt) — shared across all three styles
  // via a glyph mask: the outline dilates it (drawn before the fill) and the felt
  // fibres clip to it (drawn after). `boldPx` fattens the glyph silhouette.
  const fx = resolveTextFx(design);
  const fxSeed = (design.seed ?? hashSeed(design.text)) >>> 0;
  const boldPx = boldPxFor(design.fontSize, fx);
  const needMask = fx.strokeWidth > 0 || fx.felt;
  const applyFelt = (mask: HTMLCanvasElement | null): void => {
    if (!mask || !fx.felt) return;
    const bb = maskBBox(mask);
    if (bb) drawFelt(ctx, mask, bb, fx, fxSeed);
  };

  // Generative spray-paint ("tag") text — the stroke-font spray engine.
  if (effectiveStyle === 'tag') {
    const spray = design.spray ?? STICKER_SPRAY_DEFAULT;
    let params = toSprayParams(spray, fxSeed);
    // Bold: fatten the spray strokes (heavier core + denser coverage).
    if (fx.bold) {
      params = {
        ...params,
        coreRadius: params.coreRadius * (1 + 0.9 * fx.boldAmount),
        density: params.density * (1 + 0.6 * fx.boldAmount),
      };
    }
    const tagLineH = design.fontSize * params.lineSpacing;
    const { strokes, bbox } = layoutSprayText(
      {
        text: design.text,
        x: textX,
        y: textY + offY,
        w: textW,
        h: textH,
        fontSize: design.fontSize,
        align,
        // L-shape (corner QR): narrow + place each line beside the logo, not over it.
        lineWidth: exclude ? (li) => lineBoxAt(li, textY + offY, tagLineH).w : undefined,
        lineBox: exclude ? (li) => lineBoxAt(li, textY + offY, tagLineH) : undefined,
      },
      params
    );
    // Silhouette width ≈ the painted stroke thickness (core + scatter spread).
    const tagWidth = Math.max(3, params.coreRadius * 2.5 + params.scatter);
    const mask = needMask ? maskFromStrokes(w, h, strokes, tagWidth) : null;
    if (mask && fx.strokeWidth > 0) drawOutline(ctx, mask, fx.strokeWidth, fx.strokeColor);
    sprayStrokes(ctx, strokes, bbox, params);
    applyFelt(mask);
    return;
  }

  // Spray-FILLED solid font (e.g. Impact): fat TTF letterforms filled with spray
  // + an overspray halo. Uses `fontId` for the typeface and the spray look params.
  if (effectiveStyle === 'fill') {
    const spray = design.spray ?? STICKER_SPRAY_DEFAULT;
    const font = pickFont(design);
    const fontStr = fontString(font, design.fontSize);
    ctx.font = fontStr;
    ctx.textBaseline = 'alphabetic';
    const lineH = design.fontSize * Math.max(spray.lineSpacing, 1); // solid lines mustn't overlap
    // Corner QR is top-anchored so the wrap's band test matches where lines land.
    const fillTop = textY + offY;
    const lines = layoutLines(ctx, design.text, exclude ? (li) => lineBoxAt(li, fillTop, lineH).w : textW);
    const blockH = lines.length * lineH;
    const startY = exclude ? fillTop : textY + Math.max(0, (textH - blockH) / 2) + offY;
    const firstBaseline = startY + design.fontSize * 0.78; // matches sprayFill's baseline
    const lineBox = exclude ? (li: number) => lineBoxAt(li, startY, lineH) : undefined;
    const anchorXs = lines.map((_, li) => anchorFor(lineBoxAt(li, startY, lineH)));
    const mask = needMask
      ? maskFromText(w, h, fontStr, lines, anchorXs[0] ?? 0, firstBaseline, lineH, align, boldPx, dir, anchorXs)
      : null;
    if (mask && fx.strokeWidth > 0) drawOutline(ctx, mask, fx.strokeWidth, fx.strokeColor);
    sprayFill(
      ctx,
      { x: textX, y: startY, w: textW, h: textH, fontSize: design.fontSize, lineH, align, font: fontStr, lines, boldPx, direction: dir, lineBox },
      toSprayParams(spray, fxSeed)
    );
    applyFelt(mask);
    return;
  }

  // Plain text block (legacy TTF), vertically centered within the text region.
  const font = pickFont(design);
  const fontStr = fontString(font, design.fontSize);
  ctx.textBaseline = 'alphabetic';
  ctx.font = fontStr;
  ctx.textAlign = align;
  ctx.direction = dir;

  const lineH = design.fontSize * 1.12;
  // Corner QR is top-anchored so the wrap's band test matches where lines land.
  const plainTop = textY + offY;
  const lines = layoutLines(ctx, design.text, exclude ? (li) => lineBoxAt(li, plainTop, lineH).w : textW);
  const blockH = lines.length * lineH;
  const startTop = exclude ? plainTop : textY + (textH - blockH) / 2 + offY;
  const firstBaseline = startTop + design.fontSize * 0.82;
  const anchorXs = lines.map((_, li) => anchorFor(lineBoxAt(li, startTop, lineH)));

  const mask = needMask
    ? maskFromText(w, h, fontStr, lines, anchorXs[0] ?? 0, firstBaseline, lineH, align, boldPx, dir, anchorXs)
    : null;
  if (mask && fx.strokeWidth > 0) drawOutline(ctx, mask, fx.strokeWidth, fx.strokeColor);

  // Fill (+ a same-colour stroke to embolden when bold is on).
  ctx.fillStyle = '#000000';
  ctx.strokeStyle = '#000000';
  ctx.lineJoin = 'round';
  ctx.lineWidth = boldPx;
  let cy = firstBaseline;
  lines.forEach((line, li) => {
    const ax = anchorXs[li];
    ctx.fillText(line, ax, cy);
    if (boldPx > 0) ctx.strokeText(line, ax, cy);
    cy += lineH;
  });
  applyFelt(mask);
}

/**
 * Auto-fit: largest fontSize (within [min,max]) at which the wrapped text block
 * fits the text region of this design. Lets the admin one-click size the text.
 */
export function fitFontSize(
  design: StickerDesign,
  min = 16,
  max = 320
): number {
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return design.fontSize;
  design = { ...design, text: normalizeStickerText(design.text) };
  const { textX, textY, textW, textH, exclude } = stickerLayout(design);
  const font = pickFont(design);

  let best = min;
  for (let size = min; size <= max; size += 2) {
    probe.font = fontString(font, size);
    const lineH = size * 1.12;
    const widthFor = exclude
      ? (li: number) => lineRegionAt(textY + li * lineH, lineH, textX, textW, exclude).w
      : textW;
    const lines = layoutLines(probe, design.text, widthFor);
    const blockH = lines.length * size * 1.12;
    // Also ensure every line fits its own (possibly L-narrowed) width.
    const overflow = lines.some(
      (l, li) => probe.measureText(l).width > (typeof widthFor === 'function' ? widthFor(li) : widthFor)
    );
    if (blockH <= textH && !overflow) best = size;
    else break;
  }
  return best;
}

/** Trigger a PNG download of a rendered sticker canvas (crisp line art for print). */
export function downloadStickerPng(canvas: HTMLCanvasElement, noteId: string): void {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sticker-${noteId}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
}
