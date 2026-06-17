/**
 * Spray-paint text engine for stickers.
 *
 * Renders note text to look like graffiti sprayed on a wall, in two styles:
 *   - 'tag'  — thin single-stroke handwriting (centerline strokes from Hershey
 *              script faces) walked with a scatter-stamp spray brush, with a
 *              shaky-hand wobble + per-glyph variation + along-stroke fade + drips.
 *   - 'fill' — fat letterforms from a normal TTF, spray-FILLED inside the shape
 *              with a fuzzy overspray halo around the edge.
 *
 * Everything is DETERMINISTIC given `params.seed`, so a sticker re-renders
 * identically on demand (matching the StickerDesign config model) but each note
 * looks unique. Pure-canvas, no image assets, no deps.
 *
 * Letterform skeletons come from the public-domain Hershey vector fonts
 * (occidental script + sans), vendored as `hersheyFonts.json` (via the
 * techninja/hersheytextjs JSON port). In that encoding the baseline is y=22,
 * cap-line y=1, descenders reach y=34, and chars[] is indexed by `charCode-33`.
 */

import hersheyRaw from './hersheyFonts.json';
import type { StickerSpray } from '../../../shared/protocol';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SprayStyle = 'tag' | 'fill';
export type SprayFade = 'none' | 'tail' | 'global' | 'patchy';

export interface SprayParams {
  /** Paint colour (the "black spray"). */
  color: string;
  /** Which Hershey face drives the skeleton (tag style). */
  fontKey: HersheyKey;
  /** Pick a random alternate face per glyph for shape variation (tag style). */
  alternates: boolean;
  /**
   * Per-character face override (highest priority). Replaces specific letters
   * whose default shape reads wrong — e.g. `{ s: 'futural', p: 'futural' }` to
   * swap copperplate s/p for plainer forms while keeping the rest of the word.
   */
  glyphOverrides?: Partial<Record<string, HersheyKey>>;
  /** Dab coverage. Higher = more opaque, solid lines. */
  density: number;
  /** Tight inner-dab radius in px (the dense core of the line). */
  coreRadius: number;
  /** Wide soft-dab radius in px (the overspray halo around the line). */
  haloRadius: number;
  /** Alpha of the halo pass, 0..1. */
  haloStrength: number;
  /** Perpendicular gaussian spread of dabs in px (line fuzziness). */
  scatter: number;
  /** Along-stroke fade mode. */
  fade: SprayFade;
  /** Fade strength 0..1. */
  fadeAmount: number;
  /** Drip frequency 0..1 (gravity streaks from heavy spots). */
  drips: number;
  /** Drip length ratio — scales how far drips run (1 = default). */
  dripLength: number;
  /** High-frequency shaky-hand tremor amplitude in px. */
  wobble: number;
  /**
   * Low-frequency STRUCTURAL bending 0..1 — warps the whole letterform, not
   * just the edge. This is what turns neat copperplate into a rough wall tag.
   */
  roughness: number;
  /** Per-glyph slant (cursive lean) random range in radians, e.g. 0.3 ≈ ±17°. */
  slantVar: number;
  /** Per-glyph aspect/stretch random range 0..1 (tags squash + stretch letters). */
  stretch: number;
  /** Per-glyph baseline/scale jitter 0..1. */
  jitter: number;
  /** Extra letter spacing in font units (added to the base inter-glyph gap). */
  tracking: number;
  /** Line spacing as a multiple of fontSize (used to derive lineH). */
  lineSpacing: number;
  /** Stroke-weight swell/thin along the stroke 0..1 (pen pressure + speed). */
  pressure: number;
  /** End taper 0..1 — thins stroke ends into entry/exit flicks (handwritten). */
  taper: number;
  /** Ink pooling 0..1 — heavier soak at stroke ends + sharp corners (marker). */
  bleed: number;
  /** Global mist/grain amount 0..1. */
  grain: number;
  /** Deterministic seed. */
  seed: number;
}

export type HersheyKey = 'scripts' | 'cursive' | 'scriptc' | 'futural';

export const DEFAULT_SPRAY: SprayParams = {
  color: '#0b0b0b',
  fontKey: 'futural',
  alternates: false,
  density: 3,
  coreRadius: 1.8,
  haloRadius: 6.5,
  haloStrength: 0.22,
  scatter: 0.9,
  fade: 'global',
  fadeAmount: 0.5,
  drips: 0.25,
  dripLength: 0.9,
  wobble: 2,
  roughness: 0.6,
  slantVar: 0,
  stretch: 0.32,
  jitter: 0.2,
  tracking: 8,
  lineSpacing: 0.8,
  pressure: 0.05,
  taper: 0.35,
  bleed: 0.3,
  grain: 0.35,
  seed: 1,
};

interface Pt {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Hershey font data: parse the compact SVG-path `d` strings into polylines.
// ---------------------------------------------------------------------------

interface HersheyChar {
  o: number; // advance width (font units)
  d: string; // SVG path: M/L commands, "x,y x,y ..." (y down)
}
interface HersheyFace {
  label: string;
  baseline: number;
  capY: number;
  descender: number;
  chars: HersheyChar[];
}
const HERSHEY = hersheyRaw as unknown as Record<HersheyKey, HersheyFace>;

/** Hershey units between cap-line and baseline — used to scale to fontSize. */
const HERSHEY_BASELINE = 22;
/** Caps span ~21 units; we map fontSize → that span × this factor (≈ cap height). */
const HERSHEY_EM = 30;

interface ParsedGlyph {
  strokes: Pt[][]; // polylines in font units (y down, baseline at 22)
  advance: number;
}
const glyphCache = new Map<string, ParsedGlyph>();

/** Parse one glyph's `d` string into stroke polylines (M starts a new stroke). */
function parseGlyph(face: HersheyFace, code: number): ParsedGlyph {
  const idx = code - 33;
  const ch = idx >= 0 && idx < face.chars.length ? face.chars[idx] : undefined;
  if (!ch) return { strokes: [], advance: 12 }; // space / unknown: advance only
  const strokes: Pt[][] = [];
  let cur: Pt[] = [];
  // Tokens are "M", "L", or "x,y". Coordinates may be negative.
  const tokens = ch.d.match(/M|L|-?\d+,-?\d+/g) ?? [];
  for (const t of tokens) {
    if (t === 'M') {
      if (cur.length) strokes.push(cur);
      cur = [];
    } else if (t === 'L') {
      // continue current stroke
    } else {
      const [x, y] = t.split(',').map(Number);
      cur.push({ x, y });
    }
  }
  if (cur.length) strokes.push(cur);
  return { strokes, advance: ch.o };
}

function glyph(fontKey: HersheyKey, char: string): ParsedGlyph {
  const code = char.charCodeAt(0);
  const key = `${fontKey}:${code}`;
  let g = glyphCache.get(key);
  if (!g) {
    g = parseGlyph(HERSHEY[fontKey], code);
    glyphCache.set(key, g);
  }
  return g;
}

export function hersheyFaces(): { key: HersheyKey; label: string }[] {
  return (Object.keys(HERSHEY) as HersheyKey[]).map((key) => ({
    key,
    label: HERSHEY[key].label,
  }));
}

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) + 1-D coherent value noise (smooth "shaky hand").
// ---------------------------------------------------------------------------

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

/** Deterministic hash of a string → 32-bit int (for default seeds). */
export function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Coherent 1-D value noise in [-1,1] with smoothstep interpolation. */
class Noise1D {
  private g: number[] = [];
  constructor(seed: number, size = 256) {
    const r = mulberry32(seed);
    for (let i = 0; i < size; i++) this.g[i] = r() * 2 - 1;
  }
  at(x: number): number {
    const n = this.g.length;
    const i = Math.floor(x);
    const f = x - i;
    const a = this.g[((i % n) + n) % n];
    const b = this.g[(((i + 1) % n) + n) % n];
    const t = f * f * (3 - 2 * f);
    return a + (b - a) * t;
  }
  /** Two-octave fractal sample. */
  fbm(x: number): number {
    return this.at(x) * 0.7 + this.at(x * 2.3 + 17.1) * 0.3;
  }
}

function gaussian(r: () => number): number {
  // Box–Muller (one value).
  let u = 0;
  let v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// Geometry helpers: resample a polyline to even arc-length spacing.
// ---------------------------------------------------------------------------

function resample(poly: Pt[], step: number): Pt[] {
  if (poly.length < 2) return poly.slice();
  const out: Pt[] = [poly[0]];
  let carry = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const b = poly[i];
    let segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen === 0) continue;
    const dx = (b.x - a.x) / segLen;
    const dy = (b.y - a.y) / segLen;
    let d = step - carry;
    while (d <= segLen) {
      out.push({ x: a.x + dx * d, y: a.y + dy * d });
      d += step;
    }
    carry = segLen - (d - step);
  }
  const last = poly[poly.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

// ---------------------------------------------------------------------------
// Layout: turn text lines into positioned, jittered centerline strokes (px).
// ---------------------------------------------------------------------------

export interface SprayLayoutOpts {
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  lineH: number;
  align: 'left' | 'center' | 'right';
}

/**
 * Pick the (deterministic) face for a char. Priority: an explicit per-letter
 * override → a random alternate (if enabled) → the base face.
 */
function pickFace(
  c: string,
  fontKey: HersheyKey,
  alts: HersheyKey[],
  overrides?: Partial<Record<string, HersheyKey>>
): HersheyKey {
  const o = overrides?.[c];
  if (o && o in HERSHEY) return o;
  if (!alts.length) return fontKey;
  const i = (Math.imul(c.charCodeAt(0), 2654435761) >>> 0) % alts.length;
  return alts[i];
}

/** Base inter-glyph gap in font units, before `tracking` is added. */
const BASE_GAP = 1.2;
/** Base word-space advance in font units. */
const SPACE_ADV = 12;

/** Measure the px width of a single line at a given scale. */
function lineWidth(
  line: string,
  fontKey: HersheyKey,
  scale: number,
  alts: HersheyKey[],
  tracking = 0,
  overrides?: Partial<Record<string, HersheyKey>>
): number {
  let adv = 0;
  for (const c of line) {
    if (c === ' ') {
      adv += SPACE_ADV + tracking;
      continue;
    }
    adv += glyph(pickFace(c, fontKey, alts, overrides), c).advance + BASE_GAP + tracking;
  }
  return adv * scale;
}

/** Wrap text to the text region width using the stroke-font metrics. */
export function wrapSprayText(
  text: string,
  fontKey: HersheyKey,
  scale: number,
  alts: HersheyKey[],
  maxWidth: number,
  tracking = 0,
  overrides?: Partial<Record<string, HersheyKey>>
): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const words = raw.split(' ');
    let line = '';
    for (const word of words) {
      const cand = line ? `${line} ${word}` : word;
      if (lineWidth(cand, fontKey, scale, alts, tracking, overrides) <= maxWidth || !line) line = cand;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Build the centerline strokes (in canvas px) for the whole text block,
 * applying per-glyph alternate selection, transform jitter, and coherent-noise
 * wobble. Returns strokes + the tight bbox (for grain/fade scoping).
 */
export function layoutSprayStrokes(
  lines: string[],
  opts: SprayLayoutOpts,
  params: SprayParams
): { strokes: Pt[][]; bbox: { x: number; y: number; w: number; h: number } } {
  const scale = opts.fontSize / HERSHEY_EM;
  const r = mulberry32(params.seed ^ 0x9e3779b9);
  const wob = new Noise1D(params.seed ^ 0x1234, 512);
  const alts: HersheyKey[] = params.alternates
    ? (['scripts', 'cursive', 'scriptc'].filter((k) => k in HERSHEY) as HersheyKey[])
    : [];

  const strokes: Pt[][] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  // Slow baseline drift across the whole block (a hand that doesn't stay level).
  const driftNoise = new Noise1D(params.seed ^ 0x55aa, 256);

  lines.forEach((line, li) => {
    const baseY = opts.y + li * opts.lineH + opts.fontSize * 0.78;
    const lw = lineWidth(line, params.fontKey, scale, alts, params.tracking, params.glyphOverrides);
    let penX =
      opts.align === 'left'
        ? opts.x
        : opts.align === 'right'
          ? opts.x + opts.w - lw
          : opts.x + (opts.w - lw) / 2;

    for (const c of line) {
      if (c === ' ') {
        penX += (SPACE_ADV + params.tracking) * scale;
        continue;
      }
      const g = glyph(pickFace(c, params.fontKey, alts, params.glyphOverrides), c);

      // Per-glyph affine: independent slant + x/y stretch + baseline bounce, so
      // every letter is a different shape (the "generative" wall-tag look). Y is
      // scaled independently of X so letters squash and stretch like real tags.
      const ji = params.jitter;
      const slant = (r() - 0.5) * params.slantVar; // radians
      const xs = scale * (1 + (r() - 0.5) * (0.18 * ji + params.stretch * 0.5));
      const ys = scale * (1 + (r() - 0.5) * (0.18 * ji + params.stretch));
      const bounce = (r() - 0.5) * opts.fontSize * 0.1 * ji;
      const cos = Math.cos(slant);
      const sin = Math.sin(slant);
      const baseDrift = driftNoise.fbm(penX * 0.004) * opts.fontSize * 0.07;
      const phase = penX * 0.7 + li * 130; // decorrelate the warp per glyph/line

      for (const stroke of g.strokes) {
        // Map font units → px (baseline at HERSHEY_BASELINE), slanted about baseline.
        const mapped: Pt[] = stroke.map((p) => {
          const lx = p.x * xs;
          const ly = (p.y - HERSHEY_BASELINE) * ys;
          return {
            x: penX + lx * cos - ly * sin,
            y: baseY + bounce + baseDrift + lx * sin + ly * cos,
          };
        });
        // Resample, then warp: low-freq structural bend (roughness) + hi-freq tremor.
        const rs = resample(mapped, Math.max(1.2, opts.fontSize * 0.04));
        const warped = warpStroke(rs, wob, opts.fontSize, params.wobble, params.roughness, phase);
        strokes.push(warped);
        for (const p of warped) {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
      }
      penX += (g.advance + BASE_GAP + params.tracking) * xs;
    }
  });

  const pad = params.haloRadius + params.scatter + 4;
  const bbox =
    strokes.length === 0
      ? { x: opts.x, y: opts.y, w: opts.w, h: opts.h }
      : {
          x: minX - pad,
          y: minY - pad,
          w: maxX - minX + pad * 2,
          h: maxY - minY + pad * 2,
        };
  return { strokes, bbox };
}

/**
 * Warp a resampled polyline perpendicular to its tangent with THREE coherent
 * bands, so the distortion reshapes the letter rather than just fuzzing its edge:
 *   - low  freq, big amp  → structural bend of the whole stroke (roughness)
 *   - mid  freq           → hand waviness (wobble)
 *   - high freq, small amp → fine tremor
 * Amplitudes scale with fontSize so the look is size-independent.
 */
function warpStroke(
  poly: Pt[],
  noise: Noise1D,
  fontSize: number,
  wobble: number,
  roughness: number,
  phase: number
): Pt[] {
  if (poly.length < 2 || (wobble <= 0 && roughness <= 0)) return poly;
  const ampLow = roughness * fontSize * 0.16;
  const ampMid = wobble;
  const ampHi = wobble * 0.4;
  const out: Pt[] = [];
  let arc = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[Math.max(0, i - 1)];
    const b = poly[Math.min(poly.length - 1, i + 1)];
    let tx = b.x - a.x;
    let ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    const nx = -ty; // perpendicular
    const ny = tx;
    if (i > 0) arc += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y);
    const d =
      noise.at(arc * 0.012 + phase) * ampLow +
      noise.at(arc * 0.05 + phase * 1.7 + 11) * ampMid +
      noise.at(arc * 0.13 + phase * 2.3 + 29) * ampHi;
    out.push({ x: poly[i].x + nx * d, y: poly[i].y + ny * d });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Spray brush: a baked soft radial dab, stamped with scatter + density falloff.
// ---------------------------------------------------------------------------

function bakeDab(color: string): HTMLCanvasElement {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, withAlpha(color, 1));
  g.addColorStop(0.55, withAlpha(color, 0.85));
  g.addColorStop(1, withAlpha(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

function withAlpha(color: string, a: number): string {
  // color is a hex like #rrggbb or #rgb.
  let h = color.replace('#', '');
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function fadeFactor(t: number, mode: SprayFade, amount: number, noise: Noise1D, phase: number): number {
  switch (mode) {
    case 'none':
      return 1;
    case 'tail': // each stroke fades toward its end
      return 1 - amount * smooth01(t);
    case 'global': // whole word fades left→right (t is global x in 0..1)
      return 1 - amount * t;
    case 'patchy': {
      // noise-modulated coverage — like uneven paint, occasional dropouts.
      const n = (noise.fbm(t * 6 + phase) + 1) / 2; // 0..1
      return 1 - amount * (1 - n);
    }
  }
}
function smooth01(t: number): number {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
}

/** Stroke-weight multiplier that thins toward both ends (entry/exit flicks). */
function endTaper(t: number, amount: number): number {
  if (amount <= 0) return 1;
  const edge = 0.16 + amount * 0.14; // fraction of length that ramps
  const ramp = Math.min(smooth01(t / edge), smooth01((1 - t) / edge)); // 0 at tips → 1 mid
  return 1 - amount * (1 - ramp);
}

/** Turn angle at `p` between the incoming and outgoing direction (0=straight..π). */
function corner(a: Pt, p: Pt, b: Pt): number {
  const inx = p.x - a.x;
  const iny = p.y - a.y;
  const outx = b.x - p.x;
  const outy = b.y - p.y;
  const il = Math.hypot(inx, iny) || 1;
  const ol = Math.hypot(outx, outy) || 1;
  const dot = (inx * outx + iny * outy) / (il * ol);
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

/**
 * Spray the centerline strokes onto ctx. Walks each stroke by arc length,
 * scattering halo + core dabs with density/alpha modulated by the fade profile,
 * then drips from heavy spots, then a global grain mist.
 */
export function sprayStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: Pt[][],
  bbox: { x: number; y: number; w: number; h: number },
  params: SprayParams
): void {
  const dab = bakeDab(params.color);
  const r = mulberry32(params.seed ^ 0xa5a5a5);
  const fadeNoise = new Noise1D(params.seed ^ 0x7777, 256);
  const pressNoise = new Noise1D(params.seed ^ 0x2468, 256);
  const drips: { x: number; y: number; rad: number }[] = [];

  const stampStep = 1.6; // px between dab clusters along the stroke
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';

  for (let si = 0; si < strokes.length; si++) {
    const poly = resample(strokes[si], stampStep);
    if (poly.length < 2) continue;
    const total = poly.length;

    for (let i = 0; i < total; i++) {
      const p = poly[i];
      const tLocal = i / (total - 1); // 0..1 along this stroke
      const tGlobal = bbox.w > 0 ? (p.x - bbox.x) / bbox.w : tLocal;
      const tForFade = params.fade === 'global' ? tGlobal : tLocal;
      const cov = fadeFactor(tForFade, params.fade, params.fadeAmount, fadeNoise, si * 3.1);

      // tangent / normal for perpendicular scatter
      const a = poly[Math.max(0, i - 1)];
      const b = poly[Math.min(total - 1, i + 1)];
      let tx = b.x - a.x;
      let ty = b.y - a.y;
      const len = Math.hypot(tx, ty) || 1;
      const nx = -ty / len;
      const ny = tx / len;

      // STROKE WEIGHT — pen pressure (coherent swell/thin) × end taper. This is
      // what makes a geometric sans read as a hand-drawn marker stroke.
      const arc = i * stampStep;
      const press = 1 + pressNoise.fbm(arc * 0.03 + si * 7.7) * params.pressure * 0.85;
      const weight = Math.max(0.12, endTaper(tLocal, params.taper) * press);
      const scatterW = params.scatter * (0.35 + 0.65 * weight); // crisp where thin

      // HALO pass — wide, faint, far scatter (overspray aura).
      const haloCount = params.haloStrength > 0 ? 1 + Math.floor(params.density * 1.5) : 0;
      for (let k = 0; k < haloCount; k++) {
        const off = gaussian(r) * scatterW * 1.8;
        const tj = (r() - 0.5) * stampStep;
        stamp(
          ctx,
          dab,
          p.x + nx * off + (tx / len) * tj,
          p.y + ny * off + (ty / len) * tj,
          params.haloRadius * (0.5 + 0.5 * weight) * (0.7 + r() * 0.6),
          params.haloStrength * cov * (0.4 + r() * 0.6)
        );
      }

      // CORE pass — tight, dense, the solid line; radius scaled by stroke weight.
      const coreCount = 1 + Math.floor(params.density * 3);
      let heavy = 0;
      for (let k = 0; k < coreCount; k++) {
        const off = gaussian(r) * scatterW;
        const tj = (r() - 0.5) * stampStep;
        const alpha = (0.35 + r() * 0.5) * cov * (0.55 + 0.45 * weight);
        heavy += alpha;
        stamp(
          ctx,
          dab,
          p.x + nx * off + (tx / len) * tj,
          p.y + ny * off + (ty / len) * tj,
          params.coreRadius * weight * (0.7 + r() * 0.7),
          alpha
        );
      }

      // BLEED — ink pooling at stroke ends and at sharp corners (marker soak).
      if (params.bleed > 0) {
        const aW = poly[Math.max(0, i - 3)];
        const bW = poly[Math.min(total - 1, i + 3)];
        const turn = corner(aW, p, bW); // 0 straight .. PI hairpin
        const atEnd = i === 0 || i === total - 1;
        if ((atEnd || (turn > 0.9 && r() < 0.4)) && cov > 0.4) {
          stamp(
            ctx,
            dab,
            p.x,
            p.y,
            params.coreRadius * weight * (1.4 + params.bleed * 1.3),
            (0.4 + 0.4 * params.bleed) * cov
          );
        }
      }

      // DRIP seed from heavy, well-covered spots.
      if (params.drips > 0 && cov > 0.6 && heavy > 1.0 && r() < params.drips * 0.02) {
        drips.push({ x: p.x + nx * gaussian(r) * scatterW, y: p.y, rad: params.coreRadius * weight });
      }
    }
  }

  // DRIPS — gravity streaks tapering downward (length scaled by dripLength).
  for (const d of drips) {
    const length = (10 + r() * 55) * (0.5 + params.coreRadius / 3) * params.dripLength;
    if (length < 1) continue;
    const steps = Math.max(4, Math.floor(length / 2));
    let wander = 0;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      wander += (r() - 0.5) * 0.6;
      const rad = d.rad * (0.9 - 0.5 * t);
      stamp(ctx, dab, d.x + wander, d.y + t * length, rad, 0.5 * (1 - t * 0.5));
    }
  }

  // GRAIN — global mist of fine specks over the text bbox.
  if (params.grain > 0) {
    const area = bbox.w * bbox.h;
    const count = Math.floor(area * 0.0006 * params.grain);
    for (let i = 0; i < count; i++) {
      const x = bbox.x + r() * bbox.w;
      const y = bbox.y + r() * bbox.h;
      stamp(ctx, dab, x, y, 0.5 + r() * 1.1, 0.04 + r() * 0.08);
    }
  }
  ctx.restore();
}

function stamp(
  ctx: CanvasRenderingContext2D,
  dab: HTMLCanvasElement,
  x: number,
  y: number,
  radius: number,
  alpha: number
): void {
  if (alpha <= 0.003 || radius <= 0.1) return;
  ctx.globalAlpha = Math.min(1, alpha);
  const d = radius * 2;
  ctx.drawImage(dab, x - radius, y - radius, d, d);
}

// ---------------------------------------------------------------------------
// High-level helpers used by the sticker renderer (persisted StickerSpray →
// render params, and a one-call wrap + layout + spray of a text block).
// ---------------------------------------------------------------------------

/** Map a persisted (plain-data) StickerSpray + seed to engine render params. */
export function toSprayParams(spray: StickerSpray, seed: number): SprayParams {
  return {
    ...spray,
    fontKey: spray.fontKey as HersheyKey,
    fade: spray.fade as SprayFade,
    glyphOverrides: spray.glyphOverrides as Partial<Record<string, HersheyKey>> | undefined,
    seed,
  };
}

export interface SprayTextRegion {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  align: 'left' | 'center' | 'right';
}

const SCRIPT_ALTS: HersheyKey[] = ['scripts', 'cursive', 'scriptc'];

/** Wrap, lay out and spray a text block into a region (used by the sticker render). */
export function drawSprayText(
  ctx: CanvasRenderingContext2D,
  region: SprayTextRegion,
  params: SprayParams
): void {
  const scale = region.fontSize / HERSHEY_EM;
  const alts = params.alternates ? SCRIPT_ALTS.filter((k) => k in HERSHEY) : [];
  const lines = wrapSprayText(
    region.text,
    params.fontKey,
    scale,
    alts,
    region.w,
    params.tracking,
    params.glyphOverrides
  );
  const { strokes, bbox } = layoutSprayStrokes(
    lines,
    {
      x: region.x,
      y: region.y,
      w: region.w,
      h: region.h,
      fontSize: region.fontSize,
      lineH: region.fontSize * params.lineSpacing,
      align: region.align,
    },
    params
  );
  sprayStrokes(ctx, strokes, bbox, params);
}

// ---------------------------------------------------------------------------
// FILL style: spray INSIDE a TTF letterform mask + a fuzzy overspray halo.
// ---------------------------------------------------------------------------

export interface FillTextOpts extends SprayLayoutOpts {
  /** CSS font string for the mask text, e.g. '700 96px "Arial Narrow"'. */
  font: string;
  lines: string[];
}

/**
 * Render fat letterforms by drawing the TTF text to a mask, then spray-filling
 * inside it (rejection sampling) plus an overspray halo around the edge. Reuses
 * the same baked dab + seeded RNG so it sits beside the tag style.
 */
export function sprayFill(
  ctx: CanvasRenderingContext2D,
  opts: FillTextOpts,
  params: SprayParams
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;

  // 1) Build a mask of the letterforms (white text on transparent).
  const mask = document.createElement('canvas');
  mask.width = w;
  mask.height = h;
  const mctx = mask.getContext('2d')!;
  mctx.fillStyle = '#fff';
  mctx.font = opts.font;
  mctx.textBaseline = 'alphabetic';
  mctx.textAlign = opts.align;
  const anchorX =
    opts.align === 'left' ? opts.x : opts.align === 'right' ? opts.x + opts.w : opts.x + opts.w / 2;
  opts.lines.forEach((line, li) => {
    mctx.fillText(line, anchorX, opts.y + li * opts.lineH + opts.fontSize * 0.78);
  });

  const md = mctx.getImageData(0, 0, w, h).data;
  const inside = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    return md[(((y | 0) * w + (x | 0)) << 2) + 3] > 100;
  };

  // bbox of the mask
  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (md[((y * w + x) << 2) + 3] > 100) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX) return; // nothing drawn

  const dab = bakeDab(params.color);
  const r = mulberry32(params.seed ^ 0xc3c3c3);
  const fadeNoise = new Noise1D(params.seed ^ 0x9090, 256);
  const bw = maxX - minX;
  const bh = maxY - minY;
  ctx.save();

  // 2) Overspray halo: draw the mask shape softly blurred at low alpha.
  ctx.save();
  ctx.globalAlpha = params.haloStrength * 1.6;
  ctx.filter = `blur(${params.haloRadius}px)`;
  // tint the mask to the paint colour via source-in on an offscreen
  const halo = document.createElement('canvas');
  halo.width = w;
  halo.height = h;
  const hctx = halo.getContext('2d')!;
  hctx.drawImage(mask, 0, 0);
  hctx.globalCompositeOperation = 'source-in';
  hctx.fillStyle = params.color;
  hctx.fillRect(0, 0, w, h);
  ctx.drawImage(halo, 0, 0);
  ctx.restore();

  // 3) Spray-fill: rejection-sample points inside the mask, stamp core dabs.
  const area = bw * bh;
  const samples = Math.floor(area * 0.08 * params.density);
  for (let i = 0; i < samples; i++) {
    const x = minX + r() * bw;
    const y = minY + r() * bh;
    if (!inside(x, y)) continue;
    const tGlobal = bw > 0 ? (x - minX) / bw : 0;
    const cov = fadeFactor(tGlobal, params.fade, params.fadeAmount, fadeNoise, 0);
    stamp(ctx, dab, x, y, params.coreRadius * (0.6 + r() * 0.8), (0.3 + r() * 0.5) * cov);
  }

  // 4) Grain mist over the bbox.
  if (params.grain > 0) {
    const count = Math.floor(area * 0.0006 * params.grain);
    for (let i = 0; i < count; i++) {
      stamp(ctx, dab, minX + r() * bw, minY + r() * bh, 0.5 + r() * 1.0, 0.03 + r() * 0.07);
    }
  }
  ctx.restore();
}
