import QRCode from 'qrcode';
import {
  STICKER_SPRAY_DEFAULT,
  type StickerDesign,
  type StickerQrPos,
  type StickerBorder,
} from '../../../shared/protocol';
import { drawSprayText, toSprayParams, hashSeed } from './spraytext';

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
  { id: 'default',   label: 'Default (Arial)',   family: '"Arial Narrow", Arial, sans-serif',     weight: '700' },
];

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

/** Split text into render lines: honor explicit \n, then word-wrap each to width. */
function layoutLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    const words = rawLine.split(' ');
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth || !line) {
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

  if (qrPos === 'right' || qrPos === 'left') {
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
  const { w, h, align } = design;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // White sticker background.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  // Optional decorative frame, drawn just inside the sticker edge (under content).
  if (design.border && design.border.width > 0) {
    drawBorder(ctx, w, h, design.border);
  }

  const { qr: qrRect, textX, textY, textW, textH } = stickerLayout(design);
  if (qr && qrRect) {
    ctx.drawImage(qr, qrRect.x, qrRect.y, qrRect.size, qrRect.size);
  }

  // Generative spray-paint ("tag") text — the stroke-font spray engine.
  if (design.style === 'tag') {
    const spray = design.spray ?? STICKER_SPRAY_DEFAULT;
    const seed = design.seed ?? hashSeed(design.text);
    drawSprayText(
      ctx,
      { text: design.text, x: textX, y: textY, w: textW, h: textH, fontSize: design.fontSize, align },
      toSprayParams(spray, seed)
    );
    return;
  }

  // Plain text block (legacy TTF), vertically centered within the text region.
  const font = fontById(design.fontId);
  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'alphabetic';
  ctx.font = fontString(font, design.fontSize);
  ctx.textAlign = align;

  const lines = layoutLines(ctx, design.text, textW);
  const lineH = design.fontSize * 1.12;
  const blockH = lines.length * lineH;
  let cy = textY + (textH - blockH) / 2 + design.fontSize * 0.82; // first baseline

  const anchorX =
    align === 'left' ? textX : align === 'right' ? textX + textW : textX + textW / 2;

  for (const line of lines) {
    ctx.fillText(line, anchorX, cy);
    cy += lineH;
  }
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
  const { textW, textH } = stickerLayout(design);
  const font = fontById(design.fontId);

  let best = min;
  for (let size = min; size <= max; size += 2) {
    probe.font = fontString(font, size);
    const lines = layoutLines(probe, design.text, textW);
    const blockH = lines.length * size * 1.12;
    // Also ensure the widest line actually fits (single very long word).
    const widest = Math.max(...lines.map((l) => probe.measureText(l).width), 0);
    if (blockH <= textH && widest <= textW) best = size;
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
