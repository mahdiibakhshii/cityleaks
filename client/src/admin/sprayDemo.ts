/**
 * Dev-only demo for the spray-paint text engine (open /spray-demo.html on the
 * Vite dev server). Renders the same text across the tag styles (Hershey
 * script faces + fade modes) and the fill style, side by side, with live
 * sliders + a reseed button — so the look can be eyeballed and tuned before
 * wiring it into the sticker designer.
 */

import {
  DEFAULT_SPRAY,
  layoutSprayStrokes,
  sprayStrokes,
  sprayFill,
  wrapSprayText,
  hersheyFaces,
  hashSeed,
  type SprayParams,
  type HersheyKey,
  type SprayFade,
} from './spraytext';

const FACE_KEYS: HersheyKey[] = ['scripts', 'cursive', 'scriptc', 'futural'];

/** Parse a "s:futural p:scripts" string into a per-letter face override map. */
function parseOverrides(s: string): Partial<Record<string, HersheyKey>> {
  const map: Partial<Record<string, HersheyKey>> = {};
  for (const tok of s.split(/[\s,]+/).filter(Boolean)) {
    const [ch, face] = tok.split(':');
    if (ch && ch.length === 1 && (FACE_KEYS as string[]).includes(face)) {
      map[ch] = face as HersheyKey;
    }
  }
  return map;
}

const grid = document.getElementById('grid') as HTMLDivElement;

const W = 560;
const H = 200;

interface Tile {
  caption: string;
  build: (text: string, params: SprayParams) => HTMLCanvasElement;
}

function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  return c;
}

/** A tag-style tile for one Hershey face. */
function tagTile(fontKey: HersheyKey, label: string, alternates: boolean): Tile {
  return {
    caption: `tag · ${label}${alternates ? ' (+alts)' : ''}`,
    build(text, base) {
      const c = makeCanvas();
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, H);
      const params: SprayParams = { ...base, fontKey, alternates };
      const fontSize = 78;
      const scale = fontSize / 30;
      const lines = wrapSprayText(text, fontKey, scale, [], W - 48, base.tracking);
      const { strokes, bbox } = layoutSprayStrokes(lines, {
        x: 24, y: 24, w: W - 48, h: H - 48, fontSize, lineH: fontSize * base.lineSpacing, align: 'center',
      }, params);
      sprayStrokes(ctx, strokes, bbox, params);
      return c;
    },
  };
}

/** The fill style on a chosen TTF. */
function fillTile(font: string, label: string): Tile {
  return {
    caption: `fill · ${label}`,
    build(text, base) {
      const c = makeCanvas();
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, H);
      const fontSize = 92;
      const lines = text.split('\n');
      sprayFill(ctx, {
        x: 24, y: 28, w: W - 48, h: H - 56, fontSize, lineH: fontSize * base.lineSpacing,
        align: 'center', font: `700 ${fontSize}px ${font}`, lines,
      }, base);
      return c;
    },
  };
}

/** A tag tile that also shows it composited over a dark "wall" instead of white. */
function wallTile(fontKey: HersheyKey): Tile {
  return {
    caption: 'tag · on dark wall (sanity check)',
    build(text, base) {
      const c = makeCanvas();
      const ctx = c.getContext('2d')!;
      // faux concrete
      ctx.fillStyle = '#6b6b66';
      ctx.fillRect(0, 0, W, H);
      const params: SprayParams = { ...base, fontKey, color: '#101014' };
      const fontSize = 80;
      const lines = wrapSprayText(text, fontKey, fontSize / 30, [], W - 48, base.tracking);
      const { strokes, bbox } = layoutSprayStrokes(lines, {
        x: 24, y: 24, w: W - 48, h: H - 48, fontSize, lineH: fontSize * base.lineSpacing, align: 'center',
      }, params);
      sprayStrokes(ctx, strokes, bbox, params);
      return c;
    },
  };
}

/** A low-distortion alphabet strip for one face — to compare letterforms. */
function faceRefTile(fontKey: HersheyKey, label: string): Tile {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  return {
    caption: `ref · ${label} (native letterforms)`,
    build(_text, base) {
      const c = makeCanvas();
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, H);
      // Clean, legible: kill the distortion + overrides so you see the true shapes.
      const params: SprayParams = {
        ...base,
        fontKey,
        alternates: false,
        glyphOverrides: {},
        roughness: 0.08,
        wobble: 0.4,
        slantVar: 0.04,
        stretch: 0.04,
        jitter: 0.08,
        fadeAmount: 0,
        drips: 0,
        grain: 0.08,
        coreRadius: 1.6,
        haloStrength: 0,
        tracking: 2,
        pressure: 0.12,
        taper: 0.2,
        bleed: 0,
      };
      const fontSize = 46;
      const scale = fontSize / 30;
      const lines = wrapSprayText(alphabet, fontKey, scale, [], W - 36, params.tracking);
      const { strokes, bbox } = layoutSprayStrokes(lines, {
        x: 18, y: 18, w: W - 36, h: H - 36, fontSize, lineH: fontSize * 1.25, align: 'left',
      }, params);
      sprayStrokes(ctx, strokes, bbox, params);
      return c;
    },
  };
}

const faces = hersheyFaces();
const tiles: Tile[] = [
  tagTile('scripts', 'Script', true),
  tagTile('scripts', 'Script', false),
  tagTile('scriptc', 'Script heavy', false),
  tagTile('futural', 'Sans', false),
  fillTile('"DesimateStonger", Arial', 'Desimate'),
  fillTile('"Arial Narrow", Arial', 'Arial Narrow'),
  wallTile('scripts'),
  // Reference strips: compare each face's native letterforms to choose swaps.
  faceRefTile('scriptc', 'Script heavy'),
  faceRefTile('scripts', 'Script'),
  faceRefTile('cursive', 'Script alt'),
  faceRefTile('futural', 'Sans'),
];

let seed = 12345;

function readParams(): SprayParams {
  const v = (id: string) => parseFloat((document.getElementById(id) as HTMLInputElement).value);
  return {
    ...DEFAULT_SPRAY,
    seed,
    density: v('density'),
    scatter: v('scatter'),
    haloStrength: v('halo'),
    wobble: v('wobble'),
    roughness: v('roughness'),
    slantVar: v('slantVar'),
    stretch: v('stretch'),
    jitter: v('jitter'),
    tracking: v('tracking'),
    lineSpacing: v('lineSpacing'),
    pressure: v('pressure'),
    taper: v('taper'),
    bleed: v('bleed'),
    glyphOverrides: parseOverrides((document.getElementById('overrides') as HTMLInputElement).value),
    fadeAmount: v('fadeAmount'),
    fade: (document.getElementById('fade') as HTMLSelectElement).value as SprayFade,
    drips: v('drips'),
    dripLength: v('dripLength'),
    grain: v('grain'),
  };
}

function render() {
  const text = (document.getElementById('text') as HTMLInputElement).value || 'Stick around';
  const base = readParams();
  grid.innerHTML = '';
  for (const t of tiles) {
    const wrap = document.createElement('div');
    wrap.className = t.caption.includes('wall') ? 'tile wallwrap' : 'tile';
    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.textContent = t.caption;
    wrap.appendChild(cap);
    wrap.appendChild(t.build(text, base));
    grid.appendChild(wrap);
  }
}

// Re-render on any control change.
for (const el of Array.from(document.querySelectorAll('input,select'))) {
  el.addEventListener('input', render);
}
document.getElementById('reseed')!.addEventListener('click', () => {
  seed = (Math.random() * 0xffffffff) >>> 0;
  render();
});

// Custom fonts must be ready before the fill-style mask renders, else it falls
// back to a system font for the first paint.
void faces; // (referenced to keep the import meaningful)
Promise.all([
  document.fonts.load('700 92px "DesimateStonger"'),
  document.fonts.load('700 92px "Arial Narrow"'),
])
  .catch(() => undefined)
  .finally(render);
