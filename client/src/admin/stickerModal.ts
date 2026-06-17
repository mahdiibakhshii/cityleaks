/**
 * Sticker designer modal. Opened from the note-options panel, it presents a live
 * preview of the generative spray-paint ("tag") sticker plus all of its controls:
 * the base stroke font (face), PNG width/height, font size, QR size + alignment,
 * the full spray parameter set, and a "new seed" re-roll. Save persists the
 * design (ADMIN_NOTE_STICKER via the caller's onSave); Download exports the PNG.
 *
 * The design is a self-describing StickerDesign (style:'tag' + spray + seed), so
 * it re-opens and re-renders deterministically. All rendering goes through
 * renderSticker (the single source of truth for sticker pixels).
 */

import {
  STICKER,
  STICKER_SPRAY_DEFAULT,
  type Note,
  type StickerDesign,
  type StickerSpray,
  type StickerQrPos,
  type StickerAlign,
} from '../../../shared/protocol';
import { renderSticker, makeQrCanvas, downloadStickerPng } from './stickerRender';
import { hersheyFaces } from './spraytext';

export interface StickerModalOpts {
  note: Note;
  chatUrl: string;
  initial: StickerDesign | null;
  onSave: (design: StickerDesign) => void;
  onRemove: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Parse "s:futural p:scripts" into a per-letter override map (or undefined). */
function parseOverrides(s: string): Record<string, string> | undefined {
  const map: Record<string, string> = {};
  let n = 0;
  for (const tok of s.split(/[\s,]+/).filter(Boolean)) {
    const [ch, face] = tok.split(':');
    if (ch && ch.length === 1 && face) map[ch] = face;
    if (++n >= 64) break;
  }
  return Object.keys(map).length ? map : undefined;
}
function overridesToString(o?: Record<string, string>): string {
  if (!o) return '';
  return Object.entries(o)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
}

/** Make a fresh tag design for a note, or upgrade an existing/legacy one. */
function makeDraft(note: Note, initial: StickerDesign | null): StickerDesign {
  const base: StickerDesign = initial
    ? { ...initial }
    : {
        template: 'tag',
        w: 900,
        h: 320,
        fontSize: 88,
        align: 'left',
        qrPos: 'right',
        qrScale: 0.6,
        fontId: 'futural',
        text: note.text,
        updatedAt: Date.now(),
      };
  // Force the tag style + ensure spray/seed exist (upgrades legacy 'plain' designs).
  base.style = 'tag';
  base.spray = { ...STICKER_SPRAY_DEFAULT, ...(initial?.spray ?? {}) };
  base.seed = initial?.seed ?? (Math.random() * 0xffffffff) >>> 0;
  return base;
}

export function openStickerModal(opts: StickerModalOpts): void {
  const draft = makeDraft(opts.note, opts.initial);
  const spray = draft.spray as StickerSpray;

  let qrCanvas: HTMLCanvasElement | null = null;
  const preview = el('canvas', 'sticker-modal-canvas');

  // ── Shell ──
  const overlay = el('div', 'sticker-modal-overlay');
  const panel = el('div', 'sticker-modal');
  overlay.appendChild(panel);

  const header = el('div', 'sticker-modal-header');
  header.appendChild(el('div', 'sticker-modal-title', 'Design sticker'));
  const closeX = el('button', 'sticker-modal-x', '✕');
  header.appendChild(closeX);
  panel.appendChild(header);

  const body = el('div', 'sticker-modal-body');
  panel.appendChild(body);

  // Left: preview + dims caption.
  const previewWrap = el('div', 'sticker-modal-previewwrap');
  previewWrap.appendChild(preview);
  const dims = el('div', 'sticker-modal-dims');
  previewWrap.appendChild(dims);
  body.appendChild(previewWrap);

  // Right: scrollable controls.
  const controls = el('div', 'sticker-modal-controls');
  body.appendChild(controls);

  function close(): void {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }
  closeX.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);

  // ── Live render ──
  function rerender(): void {
    renderSticker(preview, draft, draft.qrPos === 'none' ? null : qrCanvas);
    dims.textContent = `${draft.w} × ${draft.h}px · seed ${draft.seed}`;
  }

  // ── Control builders ──
  function group(title: string): HTMLDivElement {
    const g = el('div', 'sticker-modal-group');
    g.appendChild(el('div', 'sticker-modal-grouptitle', title));
    controls.appendChild(g);
    return g;
  }
  function range(
    parent: HTMLElement,
    label: string,
    get: () => number,
    set: (v: number) => void,
    min: number,
    max: number,
    step: number,
    fmt: (v: number) => string = (v) => String(v)
  ): void {
    const row = el('div', 'sticker-modal-row');
    row.appendChild(el('label', 'sticker-modal-label', label));
    const input = el('input', 'sticker-modal-range') as HTMLInputElement;
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(get());
    const val = el('span', 'sticker-modal-val', fmt(get()));
    input.addEventListener('input', () => {
      const v = Number(input.value);
      set(v);
      val.textContent = fmt(v);
      rerender();
    });
    row.append(input, val);
    parent.appendChild(row);
  }
  function numberInput(
    parent: HTMLElement,
    label: string,
    get: () => number,
    set: (v: number) => void,
    min: number,
    max: number
  ): void {
    const row = el('div', 'sticker-modal-row');
    row.appendChild(el('label', 'sticker-modal-label', label));
    const input = el('input', 'sticker-modal-num') as HTMLInputElement;
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.value = String(get());
    input.addEventListener('change', () => {
      let v = Math.round(Number(input.value));
      if (!Number.isFinite(v)) v = get();
      v = Math.max(min, Math.min(max, v));
      input.value = String(v);
      set(v);
      rerender();
    });
    row.appendChild(input);
    parent.appendChild(row);
  }
  function chips(
    parent: HTMLElement,
    label: string,
    options: { value: string; label: string }[],
    get: () => string,
    set: (v: string) => void
  ): void {
    const row = el('div', 'sticker-modal-row');
    row.appendChild(el('label', 'sticker-modal-label', label));
    const wrap = el('div', 'sticker-modal-chips');
    const btns = new Map<string, HTMLButtonElement>();
    for (const o of options) {
      const b = el('button', 'sticker-chip', o.label) as HTMLButtonElement;
      if (get() === o.value) b.classList.add('active');
      b.addEventListener('click', () => {
        set(o.value);
        for (const [v, btn] of btns) btn.classList.toggle('active', v === o.value);
        rerender();
      });
      btns.set(o.value, b);
      wrap.appendChild(b);
    }
    row.appendChild(wrap);
    parent.appendChild(row);
  }

  // ── TEXT ──
  const gText = group('Text');
  const ta = el('textarea', 'sticker-modal-textarea') as HTMLTextAreaElement;
  ta.value = draft.text;
  ta.addEventListener('input', () => {
    draft.text = ta.value;
    rerender();
  });
  gText.appendChild(ta);
  const useNote = el('button', 'sticker-modal-btn small', 'Use note text');
  useNote.addEventListener('click', () => {
    draft.text = opts.note.text;
    ta.value = draft.text;
    rerender();
  });
  gText.appendChild(useNote);

  // ── BASE FONT (face) ──
  const gFont = group('Base font (letter structure)');
  chips(
    gFont,
    'Face',
    hersheyFaces().map((f) => ({ value: f.key as string, label: f.label })),
    () => spray.fontKey,
    (v) => {
      spray.fontKey = v;
    }
  );
  // Per-letter overrides (swap individual letters to another face).
  const ovRow = el('div', 'sticker-modal-row');
  ovRow.appendChild(el('label', 'sticker-modal-label', 'Swap letters'));
  const ovInput = el('input', 'sticker-modal-text') as HTMLInputElement;
  ovInput.placeholder = 's:futural p:scripts';
  ovInput.value = overridesToString(spray.glyphOverrides);
  ovInput.addEventListener('input', () => {
    spray.glyphOverrides = parseOverrides(ovInput.value);
    rerender();
  });
  ovRow.appendChild(ovInput);
  gFont.appendChild(ovRow);

  // ── SIZE ──
  const gSize = group('Size (PNG output)');
  numberInput(gSize, 'Width px', () => draft.w, (v) => (draft.w = v), STICKER.MIN_SIZE, STICKER.MAX_SIZE);
  numberInput(gSize, 'Height px', () => draft.h, (v) => (draft.h = v), STICKER.MIN_SIZE, STICKER.MAX_SIZE);
  range(gSize, 'Font size', () => draft.fontSize, (v) => (draft.fontSize = v), STICKER.MIN_FONT, STICKER.MAX_FONT, 2, (v) => `${v}px`);
  chips(
    gSize,
    'Align',
    [
      { value: 'left', label: 'Left' },
      { value: 'center', label: 'Center' },
      { value: 'right', label: 'Right' },
    ],
    () => draft.align,
    (v) => (draft.align = v as StickerAlign)
  );

  // ── QR ──
  const gQr = group('QR code');
  chips(
    gQr,
    'Position',
    [
      { value: 'right', label: 'Right' },
      { value: 'left', label: 'Left' },
      { value: 'bottom', label: 'Bottom' },
      { value: 'none', label: 'None' },
    ],
    () => draft.qrPos,
    (v) => (draft.qrPos = v as StickerQrPos)
  );
  range(gQr, 'QR size', () => draft.qrScale, (v) => (draft.qrScale = v), STICKER.QR_MIN, STICKER.QR_MAX, 0.05, (v) => `${Math.round(v * 100)}%`);

  // ── SPRAY LOOK ──
  const gSpray = group('Spray look');
  range(gSpray, 'Density', () => spray.density, (v) => (spray.density = v), 0.1, 3, 0.05);
  range(gSpray, 'Core radius', () => spray.coreRadius, (v) => (spray.coreRadius = v), 0.5, 12, 0.1);
  range(gSpray, 'Scatter', () => spray.scatter, (v) => (spray.scatter = v), 0, 12, 0.1);
  range(gSpray, 'Halo radius', () => spray.haloRadius, (v) => (spray.haloRadius = v), 0, 30, 0.5);
  range(gSpray, 'Halo strength', () => spray.haloStrength, (v) => (spray.haloStrength = v), 0, 0.5, 0.01);
  range(gSpray, 'Drips', () => spray.drips, (v) => (spray.drips = v), 0, 1, 0.05);
  range(gSpray, 'Drip length', () => spray.dripLength, (v) => (spray.dripLength = v), 0, 4, 0.1, (v) => `${v.toFixed(1)}×`);
  range(gSpray, 'Grain', () => spray.grain, (v) => (spray.grain = v), 0, 1, 0.05);
  chips(
    gSpray,
    'Fade',
    [
      { value: 'patchy', label: 'Patchy' },
      { value: 'tail', label: 'Tail' },
      { value: 'global', label: 'Global' },
      { value: 'none', label: 'None' },
    ],
    () => spray.fade,
    (v) => (spray.fade = v)
  );
  range(gSpray, 'Fade amount', () => spray.fadeAmount, (v) => (spray.fadeAmount = v), 0, 1, 0.05);

  // ── HANDWRITTEN ──
  const gHand = group('Handwritten effects');
  range(gHand, 'Pressure', () => spray.pressure, (v) => (spray.pressure = v), 0, 1, 0.05);
  range(gHand, 'Taper (ends)', () => spray.taper, (v) => (spray.taper = v), 0, 1, 0.05);
  range(gHand, 'Bleed (pooling)', () => spray.bleed, (v) => (spray.bleed = v), 0, 1, 0.05);
  range(gHand, 'Wobble (tremor)', () => spray.wobble, (v) => (spray.wobble = v), 0, 8, 0.1);
  range(gHand, 'Roughness (bend)', () => spray.roughness, (v) => (spray.roughness = v), 0, 2, 0.05);
  range(gHand, 'Slant', () => spray.slantVar, (v) => (spray.slantVar = v), 0, 0.8, 0.02);
  range(gHand, 'Stretch', () => spray.stretch, (v) => (spray.stretch = v), 0, 0.8, 0.02);
  range(gHand, 'Jitter', () => spray.jitter, (v) => (spray.jitter = v), 0, 1, 0.05);
  range(gHand, 'Letter spacing', () => spray.tracking, (v) => (spray.tracking = v), -3, 20, 0.5);
  range(gHand, 'Line spacing', () => spray.lineSpacing, (v) => (spray.lineSpacing = v), 0.8, 2.5, 0.05);

  // ── COLOR + SEED ──
  const gMisc = group('Paint & seed');
  const colorRow = el('div', 'sticker-modal-row');
  colorRow.appendChild(el('label', 'sticker-modal-label', 'Colour'));
  const color = el('input', 'sticker-modal-color') as HTMLInputElement;
  color.type = 'color';
  color.value = /^#[0-9a-fA-F]{6}$/.test(spray.color) ? spray.color : '#0b0b0b';
  color.addEventListener('input', () => {
    spray.color = color.value;
    rerender();
  });
  colorRow.appendChild(color);
  gMisc.appendChild(colorRow);

  const altRow = el('div', 'sticker-modal-row');
  altRow.appendChild(el('label', 'sticker-modal-label', 'Mix script alts'));
  const alt = el('input', 'sticker-modal-check') as HTMLInputElement;
  alt.type = 'checkbox';
  alt.checked = spray.alternates;
  alt.addEventListener('change', () => {
    spray.alternates = alt.checked;
    rerender();
  });
  altRow.appendChild(alt);
  gMisc.appendChild(altRow);

  const seedRow = el('div', 'sticker-modal-row');
  seedRow.appendChild(el('label', 'sticker-modal-label', 'Seed'));
  const reseed = el('button', 'sticker-modal-btn small', '🎲 New seed');
  reseed.addEventListener('click', () => {
    draft.seed = (Math.random() * 0xffffffff) >>> 0;
    rerender();
  });
  seedRow.appendChild(reseed);
  gMisc.appendChild(seedRow);

  // ── Footer actions ──
  const footer = el('div', 'sticker-modal-footer');
  const save = el('button', 'sticker-modal-btn primary', opts.initial ? 'Update sticker' : 'Save sticker');
  save.addEventListener('click', () => {
    opts.onSave({ ...draft, updatedAt: Date.now() });
    close();
  });
  const download = el('button', 'sticker-modal-btn', 'Download PNG');
  download.addEventListener('click', () => downloadStickerPng(preview, opts.note.id));
  footer.append(save, download);
  if (opts.initial) {
    const remove = el('button', 'sticker-modal-btn danger', 'Remove');
    remove.addEventListener('click', () => {
      if (!window.confirm('Remove this sticker design?')) return;
      opts.onRemove();
      close();
    });
    footer.appendChild(remove);
  }
  panel.appendChild(footer);

  document.body.appendChild(overlay);

  // Build the QR (if needed), then do the first render.
  void makeQrCanvas(opts.chatUrl)
    .then((c) => {
      qrCanvas = c;
    })
    .catch(() => undefined)
    .finally(rerender);
}
