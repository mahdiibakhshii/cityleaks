import { jsPDF } from 'jspdf';
import type { Note } from '../../../shared/protocol';
import {
  ensureDesignFont,
  makeQrCanvas,
  renderSticker,
} from './stickerRender';

/**
 * A4 print-sheet generation: bin-pack the saved sticker designs onto as few A4
 * pages as possible (the "intelligent alignment"), preview candidate layouts,
 * and export the chosen one as a multi-page PDF ready to print + cut.
 *
 * Stickers are packed in their NATIVE design pixels — those are already at print
 * resolution (~300 DPI, see stickerRender), so they map ~1:1 onto an A4 page
 * rasterized at the same DPI. Rotation (90°) is allowed so wide stickers pack
 * tighter. This module is the single source of truth for sheet geometry +
 * packing; the admin UI only drives it.
 */

// ─── A4 geometry (300 DPI) ───
const DPI = 300;
const MM_PER_IN = 25.4;
const mm = (v: number) => Math.round((v * DPI) / MM_PER_IN);

export const SHEET = {
  DPI,
  W_MM: 210,
  H_MM: 297,
  MARGIN_MM: 6, // white border the printer won't clip
  GUTTER_MM: 4, // gap between stickers (room for the scissors)
  PAGE_W: mm(210), // 2480 px
  PAGE_H: mm(297), // 3508 px
  MARGIN: mm(6),
  GUTTER: mm(4),
} as const;

/** Usable area inside the margins, in px. */
const USABLE_W = SHEET.PAGE_W - SHEET.MARGIN * 2;
const USABLE_H = SHEET.PAGE_H - SHEET.MARGIN * 2;

// ─── Packing types ───

export interface PackItem {
  id: string;
  w: number; // natural sticker width (px)
  h: number; // natural sticker height (px)
}

export interface Placement {
  id: string;
  x: number; // top-left within the page (px, includes margin)
  y: number;
  w: number; // OCCUPIED width on the page (swapped if rotated)
  h: number; // OCCUPIED height
  rotated: boolean; // sticker turned 90° to fit
}

export interface SheetPage {
  placements: Placement[];
}

export interface Candidate {
  strategy: string; // human label for the arrangement that produced it
  pages: SheetPage[];
  pageCount: number;
  fill: number; // 0..1 mean area utilization across pages
  /** Items that could not be placed (too big for a blank A4 even rotated). */
  dropped: string[];
}

// ─── MaxRects bin (one A4 page) ───

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A single page packed with MaxRects (Best-Short-Side-Fit). Items are padded by
 * the gutter while fitting, so neighbours never touch; the trailing gutter falls
 * off the usable edge harmlessly (the bin is the usable area inflated by one
 * gutter).
 */
class Bin {
  private free: Rect[];
  readonly placements: Placement[] = [];

  constructor(private allowRotate: boolean) {
    this.free = [{ x: 0, y: 0, w: USABLE_W + SHEET.GUTTER, h: USABLE_H + SHEET.GUTTER }];
  }

  /** Try to add an item; returns true if it fit. */
  insert(item: PackItem): boolean {
    const g = SHEET.GUTTER;
    const pad = (w: number, h: number) => ({ w: w + g, h: h + g });

    let best: { x: number; y: number; rotated: boolean; short: number; long: number } | null = null;
    const consider = (rect: Rect, w: number, h: number, rotated: boolean) => {
      if (w > rect.w || h > rect.h) return;
      const leftoverH = rect.w - w;
      const leftoverV = rect.h - h;
      const short = Math.min(leftoverH, leftoverV);
      const long = Math.max(leftoverH, leftoverV);
      if (!best || short < best.short || (short === best.short && long < best.long)) {
        best = { x: rect.x, y: rect.y, rotated, short, long };
      }
    };

    const up = pad(item.w, item.h);
    const rot = pad(item.h, item.w);
    for (const rect of this.free) {
      consider(rect, up.w, up.h, false);
      if (this.allowRotate) consider(rect, rot.w, rot.h, true);
    }
    if (!best) return false;

    const b = best as { x: number; y: number; rotated: boolean };
    const occW = b.rotated ? item.h : item.w;
    const occH = b.rotated ? item.w : item.h;
    const placed: Rect = { x: b.x, y: b.y, w: occW + g, h: occH + g };
    this.placements.push({
      id: item.id,
      x: SHEET.MARGIN + b.x,
      y: SHEET.MARGIN + b.y,
      w: occW,
      h: occH,
      rotated: b.rotated,
    });
    this.splitFree(placed);
    return true;
  }

  /** MaxRects split: replace every free rect overlapping `used` with its remnants. */
  private splitFree(used: Rect): void {
    const next: Rect[] = [];
    for (const fr of this.free) {
      if (!this.overlaps(fr, used)) {
        next.push(fr);
        continue;
      }
      // Up to four remnant rectangles around `used`.
      if (used.x > fr.x) next.push({ x: fr.x, y: fr.y, w: used.x - fr.x, h: fr.h });
      if (used.x + used.w < fr.x + fr.w)
        next.push({ x: used.x + used.w, y: fr.y, w: fr.x + fr.w - (used.x + used.w), h: fr.h });
      if (used.y > fr.y) next.push({ x: fr.x, y: fr.y, w: fr.w, h: used.y - fr.y });
      if (used.y + used.h < fr.y + fr.h)
        next.push({ x: fr.x, y: used.y + used.h, w: fr.w, h: fr.y + fr.h - (used.y + used.h) });
    }
    this.free = this.prune(next);
  }

  private overlaps(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  /** Drop free rects fully contained in another (the cost of MaxRects overlap). */
  private prune(rects: Rect[]): Rect[] {
    const out: Rect[] = [];
    for (let i = 0; i < rects.length; i++) {
      const a = rects[i];
      if (a.w <= 0 || a.h <= 0) continue;
      let contained = false;
      for (let j = 0; j < rects.length; j++) {
        if (i === j) continue;
        const b = rects[j];
        if (a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h) {
          // Tie-break so two identical rects don't both get dropped.
          if (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && i < j) continue;
          contained = true;
          break;
        }
      }
      if (!contained) out.push(a);
    }
    return out;
  }
}

// ─── Packing across pages + generative candidates ───

/** Largest sticker that fits a blank usable area (rotated if allowed). */
function fits(item: PackItem, allowRotate: boolean): boolean {
  const g = SHEET.GUTTER;
  const up = item.w + g <= USABLE_W + g && item.h + g <= USABLE_H + g;
  const rot = allowRotate && item.h + g <= USABLE_W + g && item.w + g <= USABLE_H + g;
  return up || rot;
}

/** Pack an ordered item list across as many A4 pages as needed. */
function packOrder(items: PackItem[], allowRotate: boolean): { pages: SheetPage[]; dropped: string[] } {
  const bins: Bin[] = [];
  const dropped: string[] = [];
  for (const item of items) {
    if (!fits(item, allowRotate)) {
      dropped.push(item.id);
      continue;
    }
    // Try existing pages first (better fill), else open a new one.
    let placed = false;
    for (const bin of bins) {
      if (bin.insert(item)) {
        placed = true;
        break;
      }
    }
    if (!placed) {
      const bin = new Bin(allowRotate);
      bin.insert(item);
      bins.push(bin);
    }
  }
  return { pages: bins.map((b) => ({ placements: b.placements })), dropped };
}

/** Deterministic PRNG so a candidate (seed) reproduces + "regenerate" re-rolls. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(arr: T[], rnd: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function fillRatio(pages: SheetPage[], items: PackItem[]): number {
  if (pages.length === 0) return 0;
  const area = new Map(items.map((i) => [i.id, i.w * i.h]));
  let used = 0;
  for (const p of pages) for (const pl of p.placements) used += area.get(pl.id) ?? 0;
  return used / (pages.length * USABLE_W * USABLE_H);
}

/**
 * Produce several packing candidates (varied sort orders + seeded shuffles), each
 * scored best-first by fewest pages then highest fill. `seed` re-rolls the random
 * arrangements so the UI's "Regenerate" yields fresh options.
 */
export function generateCandidates(items: PackItem[], allowRotate: boolean, seed = 1): Candidate[] {
  const byArea = [...items].sort((a, b) => b.w * b.h - a.w * a.h);
  const byHeight = [...items].sort((a, b) => b.h - a.h);
  const byWidth = [...items].sort((a, b) => b.w - a.w);
  const byMaxSide = [...items].sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h));
  const rnd = mulberry32(seed);
  const orders: [string, PackItem[]][] = [
    ['By area', byArea],
    ['By height', byHeight],
    ['By width', byWidth],
    ['By longest side', byMaxSide],
    ['Shuffled A', shuffled(items, rnd)],
    ['Shuffled B', shuffled(items, rnd)],
  ];

  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const [strategy, order] of orders) {
    const { pages, dropped } = packOrder(order, allowRotate);
    const sig = pages.map((p) => p.placements.map((pl) => pl.id).join(',')).join('|');
    if (seen.has(sig)) continue; // collapse identical layouts
    seen.add(sig);
    candidates.push({
      strategy,
      pages,
      pageCount: pages.length,
      fill: fillRatio(pages, items),
      dropped,
    });
  }
  candidates.sort((a, b) => a.pageCount - b.pageCount || b.fill - a.fill);
  return candidates;
}

// ─── Sticker rendering (rendered once, reused for every preview + the PDF) ───

export interface PreparedSticker {
  id: string;
  w: number; // natural px
  h: number;
  canvas: HTMLCanvasElement; // sticker rendered at native resolution
}

/**
 * Render each note's saved sticker to a native-resolution canvas (awaiting its
 * font + QR first), keyed by id. Returns one PreparedSticker per note that has a
 * sticker design. `origin` builds each note's chat URL for its QR.
 */
export async function prepareStickers(notes: Note[], origin: string): Promise<PreparedSticker[]> {
  const out: PreparedSticker[] = [];
  for (const note of notes) {
    const design = note.sticker;
    if (!design) continue;
    await ensureDesignFont(design);
    const qr = design.qrPos !== 'none' ? await makeQrCanvas(`${origin}/c/${note.id}`) : null;
    const canvas = document.createElement('canvas');
    renderSticker(canvas, design, qr);
    out.push({ id: note.id, w: design.w, h: design.h, canvas });
  }
  return out;
}

/** Pack items derived from prepared stickers. */
export function packItems(prepared: PreparedSticker[]): PackItem[] {
  return prepared.map((p) => ({ id: p.id, w: p.w, h: p.h }));
}

/**
 * Draw one A4 page (with its packed stickers) into a canvas at `scale` (1 = full
 * print resolution, <1 = preview thumbnail). Rotated placements are drawn turned
 * 90°. White background = the sheet.
 */
export function renderSheetCanvas(
  page: SheetPage,
  prepared: PreparedSticker[],
  scale: number
): HTMLCanvasElement {
  const byId = new Map(prepared.map((p) => [p.id, p]));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(SHEET.PAGE_W * scale);
  canvas.height = Math.round(SHEET.PAGE_H * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';

  for (const pl of page.placements) {
    const st = byId.get(pl.id);
    if (!st) continue;
    ctx.save();
    ctx.scale(scale, scale);
    if (pl.rotated) {
      // 90° clockwise: the natural w maps to the vertical extent.
      ctx.translate(pl.x + pl.w, pl.y);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(st.canvas, 0, 0, st.w, st.h);
    } else {
      ctx.drawImage(st.canvas, pl.x, pl.y, st.w, st.h);
    }
    ctx.restore();
  }
  return canvas;
}

/** Build a multi-page A4 PDF (one page per sheet) at full print resolution. */
export function sheetsToPdf(pages: SheetPage[], prepared: PreparedSticker[]): jsPDF {
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  pages.forEach((page, i) => {
    if (i > 0) pdf.addPage();
    const canvas = renderSheetCanvas(page, prepared, 1);
    const dataUrl = canvas.toDataURL('image/png');
    pdf.addImage(dataUrl, 'PNG', 0, 0, SHEET.W_MM, SHEET.H_MM);
  });
  return pdf;
}

/** Trigger a download of the candidate as a print-ready PDF. */
export function downloadSheetsPdf(
  pages: SheetPage[],
  prepared: PreparedSticker[],
  filename: string
): void {
  sheetsToPdf(pages, prepared).save(filename);
}
