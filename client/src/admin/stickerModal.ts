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
  STICKER_WATER_DEFAULT,
  STICKER_TEXTFX_DEFAULT,
  type Note,
  type StickerDesign,
  type StickerSpray,
  type StickerBackground,
  type StickerTextFx,
  type StickerQrPos,
  type StickerAlign,
  type StickerTextStyle,
} from '../../../shared/protocol';
import {
  renderSticker,
  makeQrCanvas,
  downloadStickerPng,
  ensureDesignFont,
  fontById,
  waterGrid,
  STICKER_FONTS,
} from './stickerRender';
import { hersheyFaces } from './spraytext';

export interface StickerModalOpts {
  note: Note;
  chatUrl: string;
  initial: StickerDesign | null;
  // The most recently saved sticker design (any note), used to seed the defaults
  // of a BRAND-NEW sticker so the admin's last-used look carries over. Ignored
  // when editing an existing design (`initial`).
  defaults?: StickerDesign | null;
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

/**
 * How many texts had been submitted when this note was written — i.e. the note's
 * 1-based creation order. Note ids are assigned sequentially (`n1`, `n2`, …), so
 * the numeric part IS that running total (counts this note). Used as the data-viz
 * pixel count: one background cell per submitted text.
 */
function noteSubmissionCount(note: Note): number {
  const n = parseInt(note.id.replace(/^n/, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
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
function makeDraft(
  note: Note,
  initial: StickerDesign | null,
  defaults: StickerDesign | null
): StickerDesign {
  // Editing → start from the existing design. New → start from the last-saved
  // design (carry over the admin's last-used look), else hardcoded defaults.
  const seedFrom = initial ?? defaults ?? null;
  const base: StickerDesign = seedFrom
    ? { ...seedFrom }
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
  // A new sticker (even one seeded from a prior design) gets THIS note's text.
  if (!initial) base.text = note.text;
  // Keep the chosen style ('plain' = clean TTF, 'fill' = spray-filled TTF);
  // anything else defaults to the generative spray strokes.
  if (base.style !== 'fill' && base.style !== 'plain') base.style = 'tag';
  base.spray = { ...STICKER_SPRAY_DEFAULT, ...(seedFrom?.spray ?? {}) };
  base.seed = initial?.seed ?? (Math.random() * 0xffffffff) >>> 0;
  // Carry over the border (incl. its absence) when editing; for a brand-new
  // sticker with no inherited border, default to a 10px square black frame.
  if (seedFrom?.border) base.border = { ...seedFrom.border };
  if (!initial && !base.border) base.border = { width: 10, color: '#000000', radius: 0 };
  // Generative background. Carry over an EXISTING design's background as-is (so
  // editing respects what's there). But default to the data-viz water bg whenever
  // there's none yet — this covers brand-new stickers AND existing/legacy designs
  // saved before this feature (so opening + saving an old sticker applies water,
  // no delete-and-recreate needed). When we mint the background fresh (or for any
  // brand-new sticker), we re-roll the pattern seed and pin the cell count to THIS
  // note's submission number (how many texts existed when it was written = the
  // numeric note id). An explicit White is still selectable via the modal toggle.
  if (seedFrom?.background) base.background = { ...seedFrom.background };
  const freshBg = !base.background;
  if (freshBg) base.background = { ...STICKER_WATER_DEFAULT };
  if (freshBg || !initial) {
    base.background = {
      ...(base.background as StickerBackground),
      seed: (Math.random() * 0xffffffff) >>> 0,
      count: noteSubmissionCount(note),
    };
  }
  return base;
}

export function openStickerModal(opts: StickerModalOpts): void {
  const draft = makeDraft(opts.note, opts.initial, opts.defaults ?? null);
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
  // Set by the Background group to refresh its "rows × cols" readout (the grid
  // depends on w/h, which other groups change), called at the end of rerender.
  let updateBgInfo: () => void = () => {};
  function rerender(): void {
    renderSticker(preview, draft, draft.qrPos === 'none' ? null : qrCanvas);
    dims.textContent = `${draft.w} × ${draft.h}px · seed ${draft.seed}`;
    updateBgInfo();
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
  function colorInput(
    parent: HTMLElement,
    label: string,
    get: () => string,
    set: (v: string) => void
  ): void {
    const row = el('div', 'sticker-modal-row');
    row.appendChild(el('label', 'sticker-modal-label', label));
    const input = el('input', 'sticker-modal-color') as HTMLInputElement;
    input.type = 'color';
    input.value = /^#[0-9a-fA-F]{6}$/.test(get()) ? get() : '#ffffff';
    input.addEventListener('input', () => {
      set(input.value);
      rerender();
    });
    row.appendChild(input);
    parent.appendChild(row);
  }
  function checkbox(
    parent: HTMLElement,
    label: string,
    get: () => boolean,
    set: (v: boolean) => void
  ): void {
    const row = el('div', 'sticker-modal-row');
    row.appendChild(el('label', 'sticker-modal-label', label));
    const input = el('input', 'sticker-modal-check') as HTMLInputElement;
    input.type = 'checkbox';
    input.checked = get();
    input.addEventListener('change', () => {
      set(input.checked);
      rerender();
    });
    row.appendChild(input);
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

  // ── LETTER STYLE ──
  const gStyle = group('Letter style');
  chips(
    gStyle,
    'Style',
    [
      { value: 'tag', label: 'Spray strokes' },
      { value: 'fill', label: 'Solid font (Impact…)' },
      { value: 'plain', label: 'Plain font' },
    ],
    () => (draft.style === 'fill' || draft.style === 'plain' ? draft.style : 'tag'),
    (v) => {
      draft.style = v as StickerTextStyle;
      if (v === 'fill' || v === 'plain') {
        // Default to a real solid typeface if the design still carries a tag face.
        if (!STICKER_FONTS.some((f) => f.id === draft.fontId)) draft.fontId = 'impact';
        void ensureDesignFont(draft).then(rerender);
      }
    }
  );
  // Solid typeface for the 'fill'/'plain' styles (the TTF letterforms drawn
  // spray-filled, or — for 'plain' — exactly as the typeface looks).
  chips(
    gStyle,
    'Solid font',
    STICKER_FONTS.map((f) => ({ value: f.id, label: f.label })),
    () => fontById(draft.fontId).id,
    (v) => {
      draft.fontId = v;
      void ensureDesignFont(draft).then(rerender);
    }
  );

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

  // ── LETTER EFFECTS (bold · outline · felt) ──
  const gFx = group('Letter effects');
  // Local working copy; written onto the design on every change (an all-off fx is
  // dropped server-side by normalizeStickerTextFx, so it stays clean when saved).
  const fxState: StickerTextFx = { ...STICKER_TEXTFX_DEFAULT, ...(draft.textFx ?? {}) };
  const syncFx = (): void => {
    draft.textFx = { ...fxState };
  };
  checkbox(gFx, 'Bold', () => fxState.bold, (v) => { fxState.bold = v; syncFx(); });
  range(gFx, 'Bold amount', () => fxState.boldAmount, (v) => { fxState.boldAmount = v; syncFx(); }, 0, 1, 0.02, (v) => `${Math.round(v * 100)}%`);
  range(gFx, 'Outline width', () => fxState.strokeWidth, (v) => { fxState.strokeWidth = v; syncFx(); }, 0, STICKER.TEXT_STROKE_MAX, 1, (v) => (v === 0 ? 'none' : `${v}px`));
  colorInput(gFx, 'Outline colour', () => fxState.strokeColor, (v) => { fxState.strokeColor = v; syncFx(); });
  checkbox(gFx, 'Felt texture', () => fxState.felt, (v) => { fxState.felt = v; syncFx(); });
  range(gFx, 'Felt density', () => fxState.feltDensity, (v) => { fxState.feltDensity = v; syncFx(); }, 0, 1, 0.02, (v) => `${Math.round(v * 100)}%`);
  range(gFx, 'Felt fibre length', () => fxState.feltLength, (v) => { fxState.feltLength = v; syncFx(); }, 0, STICKER.FELT_LEN_MAX, 1, (v) => `${Math.round(v)}px`);
  range(gFx, 'Felt fuzz', () => fxState.feltFuzz, (v) => { fxState.feltFuzz = v; syncFx(); }, 0, 1, 0.02, (v) => `${Math.round(v * 100)}%`);
  colorInput(gFx, 'Felt colour', () => fxState.feltColor, (v) => { fxState.feltColor = v; syncFx(); });

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
  range(
    gSize,
    'First row ↕ (from top)',
    () => draft.textOffsetY ?? 0,
    (v) => (draft.textOffsetY = v),
    -0.5,
    1,
    0.01,
    (v) => `${Math.round(v * 100)}%`
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
      { value: 'corner', label: 'Corner ↘' },
      { value: 'none', label: 'None' },
    ],
    () => draft.qrPos,
    (v) => (draft.qrPos = v as StickerQrPos)
  );
  range(gQr, 'QR size', () => draft.qrScale, (v) => (draft.qrScale = v), STICKER.QR_MIN, STICKER.QR_MAX, 0.05, (v) => `${Math.round(v * 100)}%`);

  // ── BORDER (frame) ──
  const gBorder = group('Border (frame)');
  const border = {
    width: draft.border?.width ?? 0,
    color: draft.border?.color ?? '#000000',
    radius: draft.border?.radius ?? 0,
  };
  // The border only exists on the design when its thickness is > 0.
  const syncBorder = (): void => {
    draft.border = border.width > 0 ? { ...border } : undefined;
  };
  range(
    gBorder,
    'Thickness',
    () => border.width,
    (v) => {
      border.width = v;
      syncBorder();
    },
    0,
    STICKER.BORDER_MAX_WIDTH,
    1,
    (v) => (v === 0 ? 'none' : `${v}px`)
  );
  range(
    gBorder,
    'Corner radius',
    () => border.radius,
    (v) => {
      border.radius = v;
      syncBorder();
    },
    0,
    STICKER.BORDER_MAX_RADIUS,
    2,
    (v) => (v === 0 ? 'square' : `${v}px`)
  );
  const bColorRow = el('div', 'sticker-modal-row');
  bColorRow.appendChild(el('label', 'sticker-modal-label', 'Colour'));
  const bColor = el('input', 'sticker-modal-color') as HTMLInputElement;
  bColor.type = 'color';
  bColor.value = /^#[0-9a-fA-F]{6}$/.test(border.color) ? border.color : '#000000';
  bColor.addEventListener('input', () => {
    border.color = bColor.value;
    syncBorder();
    rerender();
  });
  bColorRow.appendChild(bColor);
  gBorder.appendChild(bColorRow);

  // ── BACKGROUND (generative pixel water) ──
  const gBg = group('Background (pixel water)');
  // Local working copy: seeded from the design's background, else the water
  // default. Only written onto the design (as a fresh copy) while the kind is on.
  const bgState: StickerBackground = { ...STICKER_WATER_DEFAULT, ...(draft.background ?? {}) };
  let bgOn = !!draft.background;
  const syncBg = (): void => {
    draft.background = bgOn ? { ...bgState } : undefined;
  };
  // Sub-controls live in their own box so they can be hidden when bg is off.
  const bgBody = el('div', 'sticker-modal-subgroup');
  // Mode-specific boxes, swapped by the Layout toggle.
  const countBox = el('div', 'sticker-modal-subgroup');
  const sizeBox = el('div', 'sticker-modal-subgroup');
  const applyMode = (): void => {
    countBox.style.display = bgState.mode === 'count' ? '' : 'none';
    sizeBox.style.display = bgState.mode === 'size' ? '' : 'none';
  };

  chips(
    gBg,
    'Type',
    [
      { value: 'none', label: 'White' },
      { value: 'water', label: 'Pixel water' },
    ],
    () => (bgOn ? 'water' : 'none'),
    (v) => {
      bgOn = v === 'water';
      bgBody.style.display = bgOn ? '' : 'none';
      syncBg();
    }
  );
  gBg.appendChild(bgBody);
  bgBody.style.display = bgOn ? '' : 'none';

  // Layout: one cell per submitted text (data-viz) vs a fixed pixel size.
  chips(
    bgBody,
    'Layout',
    [
      { value: 'count', label: 'One per text' },
      { value: 'size', label: 'Fixed px size' },
    ],
    () => bgState.mode,
    (v) => {
      bgState.mode = v as StickerBackground['mode'];
      applyMode();
      syncBg();
    }
  );

  // — Count mode: exactly `count` cells, one per submitted text —
  bgBody.appendChild(countBox);
  const noteCount = noteSubmissionCount(opts.note);
  numberInput(
    countBox,
    'Pixels (texts)',
    () => bgState.count,
    (v) => { bgState.count = v; syncBg(); },
    STICKER.BG_MIN_COUNT,
    STICKER.BG_MAX_COUNT
  );
  const bgInfo = el('div', 'sticker-modal-dims');
  countBox.appendChild(bgInfo);
  updateBgInfo = (): void => {
    if (!bgOn || bgState.mode !== 'count') return;
    const { rows, base, extra } = waterGrid(draft.w, draft.h, bgState.count);
    const layout = extra === 0 ? `${rows} × ${base}` : `${rows} rows · ${base}–${base + 1} cols`;
    bgInfo.textContent = `${bgState.count} cells (${layout})`;
  };
  const useCountRow = el('div', 'sticker-modal-row');
  const useCount = el('button', 'sticker-modal-btn small', `Use note's count (${noteCount})`);
  useCount.addEventListener('click', () => {
    bgState.count = noteCount;
    syncBg();
    rerender(); // also re-syncs the number input's displayed value below
    countNum.value = String(noteCount);
  });
  useCountRow.appendChild(useCount);
  countBox.appendChild(useCountRow);
  // Grab the count's number input so the "use note count" button can sync it.
  const countNum = countBox.querySelector('input[type="number"]') as HTMLInputElement;

  // — Size mode: uniform pixel grid with optional patchy coverage + foam —
  bgBody.appendChild(sizeBox);
  range(sizeBox, 'Pixel size', () => bgState.pixelSize, (v) => { bgState.pixelSize = v; syncBg(); }, STICKER.BG_MIN_PIXEL, STICKER.BG_MAX_PIXEL, 1, (v) => `${v}px`);
  range(sizeBox, 'Coverage', () => bgState.coverage, (v) => { bgState.coverage = v; syncBg(); }, 0, 1, 0.02, (v) => `${Math.round(v * 100)}%`);
  range(sizeBox, 'Foam (edges)', () => bgState.foam, (v) => { bgState.foam = v; syncBg(); }, 0, 1, 0.02, (v) => `${Math.round(v * 100)}%`);

  // — Shared look controls (both modes) —
  range(bgBody, 'Variation', () => bgState.variation, (v) => { bgState.variation = v; syncBg(); }, 0, 1, 0.02, (v) => `${Math.round(v * 100)}%`);
  range(bgBody, 'Opacity', () => bgState.opacity, (v) => { bgState.opacity = v; syncBg(); }, 0, 1, 0.02, (v) => `${Math.round(v * 100)}%`);
  colorInput(bgBody, 'Base', () => bgState.base, (v) => { bgState.base = v; syncBg(); });
  colorInput(bgBody, 'Deep', () => bgState.deep, (v) => { bgState.deep = v; syncBg(); });
  colorInput(bgBody, 'Mid', () => bgState.mid, (v) => { bgState.mid = v; syncBg(); });
  colorInput(bgBody, 'Light', () => bgState.light, (v) => { bgState.light = v; syncBg(); });
  colorInput(bgBody, 'Foam colour', () => bgState.foamColor, (v) => { bgState.foamColor = v; syncBg(); });
  const bgSeedRow = el('div', 'sticker-modal-row');
  bgSeedRow.appendChild(el('label', 'sticker-modal-label', 'Pattern seed'));
  const bgReseed = el('button', 'sticker-modal-btn small', '🎲 New pattern');
  bgReseed.addEventListener('click', () => {
    bgState.seed = (Math.random() * 0xffffffff) >>> 0;
    syncBg();
    rerender();
  });
  bgSeedRow.appendChild(bgReseed);
  bgBody.appendChild(bgSeedRow);
  applyMode();

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

  // Build the QR + load the solid font (if any), then do the first render.
  void Promise.all([
    makeQrCanvas(opts.chatUrl)
      .then((c) => {
        qrCanvas = c;
      })
      .catch(() => undefined),
    ensureDesignFont(draft).catch(() => undefined),
  ]).finally(rerender);
}
