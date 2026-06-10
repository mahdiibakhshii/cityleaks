/**
 * Procedural pixel-art sprites for characters + enemies — authored in code, no
 * external image files. Each sprite is drawn into a tiny canvas at native pixel
 * resolution (16×24 for players, 16×16 for ghosts) and later uploaded as a
 * NearestFilter texture (see SpriteAtlas.ts) so it scales up crisp and chunky.
 *
 * Everything faces RIGHT; the renderer mirrors the quad's UVs for left-facing.
 * Walk animation is a 2-frame A/B step (frame 0 = stand/step-A, 1 = step-B).
 *
 * This module is THREE-free on purpose: the intro picker bakes the same specs to
 * a plain canvas for its previews (IntroOverlay.ts), and SpriteAtlas wraps them
 * for the game. A 1px dark outline is added automatically around every sprite
 * (outlineFrame) so the art stays legible over the busy city photo.
 */

export interface SpriteSpec {
  width: number;
  height: number;
  frames: number;
  outline: string; // halo color drawn around the silhouette
  draw: (ctx: CanvasRenderingContext2D, frame: number) => void;
}

type Ctx = CanvasRenderingContext2D;

// ─── pixel helpers (1 unit = 1 source pixel) ───

function rect(ctx: Ctx, x: number, y: number, w: number, h: number, c: string): void {
  ctx.fillStyle = c;
  ctx.fillRect(x, y, w, h);
}
function px(ctx: Ctx, x: number, y: number, c: string): void {
  ctx.fillStyle = c;
  ctx.fillRect(x, y, 1, 1);
}

/**
 * Two alternating legs with boots/feet, the shared walk motion for the humanoid
 * mascots. Legs sit at x=5..6 and x=9..10, rows 18..23; their lengths swap each
 * frame so the figure bobs like it's stepping.
 */
function drawLegs(ctx: Ctx, frame: number, leg: string, boot: string): void {
  const lh = frame === 0 ? 5 : 4; // left leg length
  const rh = frame === 0 ? 4 : 5; // right leg length
  rect(ctx, 5, 18, 2, lh, leg);
  rect(ctx, 4, 18 + lh - 1, 3, 1, boot); // left foot (toe back)
  rect(ctx, 9, 18, 2, rh, leg);
  rect(ctx, 9, 18 + rh - 1, 3, 1, boot); // right foot (toe forward, +x)
}

// ─── Pip — the plumber (Mario-ish, original) ───

function drawPlumber(ctx: Ctx, f: number): void {
  const skin = '#ffccaa';
  const cap = '#ef5350';
  const shirt = '#ef5350';
  const overall = '#2d6cdf';
  const boot = '#5a3a22';
  const eye = '#2a1a12';
  const stache = '#3a241a';

  drawLegs(ctx, f, overall, boot);
  // torso: blue overalls over red shirt
  rect(ctx, 4, 11, 8, 7, overall);
  rect(ctx, 4, 11, 8, 2, shirt); // shirt collar
  px(ctx, 6, 13, shirt); // strap
  px(ctx, 9, 13, shirt);
  // front arm (swings with the step)
  rect(ctx, 11, f === 0 ? 12 : 11, 2, 4, shirt);
  px(ctx, 12, f === 0 ? 16 : 15, skin); // hand
  // head
  rect(ctx, 4, 3, 8, 7, skin);
  rect(ctx, 5, 8, 6, 1, stache); // mustache
  px(ctx, 11, 6, skin); // nose nub
  rect(ctx, 9, 5, 2, 2, eye); // eye (faces right)
  // cap
  rect(ctx, 3, 2, 9, 2, cap);
  rect(ctx, 4, 1, 6, 1, cap);
  rect(ctx, 10, 3, 4, 1, cap); // brim forward
}

// ─── Dash — the speedy critter (Sonic-ish, original) ───

function drawDash(ctx: Ctx, f: number): void {
  const fur = '#16c79a';
  const furDark = '#0e8e6e';
  const muzzle = '#eafff7';
  const eye = '#15302b';
  const shoe = '#ffffff';

  drawLegs(ctx, f, fur, shoe); // big white sneakers
  // body with pale belly
  rect(ctx, 4, 11, 8, 7, fur);
  rect(ctx, 7, 12, 4, 5, muzzle);
  // front arm
  rect(ctx, 11, f === 0 ? 12 : 11, 2, 4, fur);
  // head
  rect(ctx, 4, 3, 8, 7, fur);
  rect(ctx, 8, 6, 4, 3, muzzle); // muzzle
  px(ctx, 12, 7, '#ff8c66'); // nose
  rect(ctx, 8, 4, 2, 2, eye); // eye
  // back spikes (point up-left)
  rect(ctx, 2, 4, 2, 2, fur);
  rect(ctx, 1, 6, 3, 2, fur);
  rect(ctx, 2, 8, 2, 2, furDark);
  px(ctx, 0, 7, furDark);
}

// ─── Pim — the little knight (maze guardian) ───

function drawKnight(ctx: Ctx, f: number): void {
  const armor = '#aab4c8';
  const dark = '#79839b';
  const plume = '#9b8cff';
  const visor = '#20242e';
  const boot = '#5a6273';

  drawLegs(ctx, f, dark, boot);
  // armor torso
  rect(ctx, 4, 11, 8, 7, armor);
  rect(ctx, 4, 15, 8, 1, dark); // belt
  rect(ctx, 7, 12, 2, 2, plume); // chest emblem
  // front arm
  rect(ctx, 11, f === 0 ? 12 : 11, 2, 4, armor);
  // helmet (covers the whole head)
  rect(ctx, 4, 2, 8, 8, armor);
  rect(ctx, 6, 6, 6, 1, visor); // visor slit
  rect(ctx, 4, 9, 8, 1, dark); // gorget
  px(ctx, 11, 4, dark); // rivet
  // plume
  rect(ctx, 3, 0, 2, 4, plume);
  px(ctx, 4, 1, plume);
}

// ─── Waddles — the brave duck (bird shape) ───

function drawDuck(ctx: Ctx, f: number): void {
  const body = '#ffd23f';
  const dark = '#e0ad1f';
  const beak = '#ff8c1a';
  const eye = '#20141a';
  const foot = '#ff8c1a';

  // webbed feet (alternate)
  if (f === 0) {
    rect(ctx, 5, 20, 3, 1, foot);
    rect(ctx, 6, 18, 1, 2, foot);
    rect(ctx, 9, 21, 3, 1, foot);
    rect(ctx, 10, 19, 1, 2, foot);
  } else {
    rect(ctx, 5, 21, 3, 1, foot);
    rect(ctx, 6, 19, 1, 2, foot);
    rect(ctx, 9, 20, 3, 1, foot);
    rect(ctx, 10, 18, 1, 2, foot);
  }
  // plump body
  rect(ctx, 4, 9, 9, 9, body);
  rect(ctx, 3, 11, 1, 4, body); // tail back
  rect(ctx, 5, 13, 5, 4, dark); // wing shading
  // head sits high on the body
  rect(ctx, 6, 4, 7, 6, body);
  rect(ctx, 13, 7, 3, 2, beak); // beak (faces right)
  px(ctx, 15, 8, beak);
  rect(ctx, 10, 6, 2, 2, eye); // eye
  px(ctx, 10, 6, '#ffffff'); // glint
}

// ─── Batman — the admin "creator" (dark cowl, cape, emblem) ───

function drawBatman(ctx: Ctx, f: number): void {
  const suit = '#3a3f4d'; // grey body suit
  const dark = '#23262e'; // cowl / cape / gloves / boots (near-black)
  const skin = '#e7b48c'; // exposed jaw
  const emblem = '#ffd23f'; // bat emblem + utility belt
  const eye = '#dfe7ff'; // white eye slits

  // Cape draping down the back (left side, since the figure faces right).
  rect(ctx, 2, 10, 3, 9, dark);
  px(ctx, 1, 12, dark);
  px(ctx, 1, 16, dark);

  drawLegs(ctx, f, dark, dark); // dark legs + boots

  // Torso + utility belt + chest emblem.
  rect(ctx, 4, 11, 8, 7, suit);
  rect(ctx, 4, 15, 8, 1, emblem);
  rect(ctx, 6, 12, 4, 2, emblem);
  px(ctx, 6, 13, suit);
  px(ctx, 9, 13, suit);
  // front arm
  rect(ctx, 11, f === 0 ? 12 : 11, 2, 4, dark);

  // Head: cowl with a small exposed jaw and pointy ears.
  rect(ctx, 4, 3, 8, 6, dark); // cowl
  rect(ctx, 5, 9, 6, 1, dark); // cowl chin line
  rect(ctx, 8, 8, 4, 2, skin); // exposed jaw (faces right)
  rect(ctx, 4, 1, 2, 2, dark); // left ear
  rect(ctx, 9, 1, 2, 2, dark); // right ear
  // white eye slits (faces right)
  rect(ctx, 8, 5, 2, 1, eye);
  px(ctx, 7, 5, eye);
}

// ─── Anonymous figure — single tintable silhouette (Skip) ───

function drawAnon(ctx: Ctx, f: number): void {
  // All white; tinted per-player by the server color at runtime (uTint). Kept
  // faceless to read as "anonymous".
  const body = '#ffffff';
  const boot = '#dcdce4';
  drawLegs(ctx, f, body, boot);
  rect(ctx, 4, 11, 8, 7, body); // torso
  rect(ctx, 11, f === 0 ? 12 : 11, 2, 4, body); // arm
  rect(ctx, 4, 3, 8, 7, body); // head
}

// ─── Ghost — the enemy (Pac-Man-style) ───
//
// Drawn NEUTRAL (light body, white eyes, dark pupils) and tinted at runtime via
// the sprite's uTint so the enemy's color can shift live from healthy → dying
// (red → purple-black) as its life drains. The dark pupils survive any tint, so
// the eyes still read on a fully saturated body. Frame 2 is the SCREAM face,
// forced during the death sequence (CharacterSprite.setFrameOverride).
export const GHOST_FRAMES = 3;
export const GHOST_SCREAM_FRAME = 2;

const GHOST_BODY = '#e6e6f0'; // light, so the tint reads as the body color
const GHOST_NOTCH = '#a6a6b6'; // darker skirt shade for definition under tint
const GHOST_WHITE = '#ffffff'; // eye whites — brightest, so they pop when tinted
const GHOST_PUPIL = '#191b24'; // near-black pupils — stay dark through any tint

function ghostBell(ctx: Ctx, f: number): void {
  // domed top
  rect(ctx, 5, 1, 6, 1, GHOST_BODY);
  rect(ctx, 4, 2, 8, 1, GHOST_BODY);
  rect(ctx, 3, 3, 10, 1, GHOST_BODY);
  rect(ctx, 2, 4, 12, 9, GHOST_BODY); // main bell
  // wavy skirt (humps shift by frame so it "walks")
  const off = f === 0 ? 0 : 2;
  for (let i = 0; i < 3; i++) {
    const x = 2 + ((i * 4 + off) % 12);
    rect(ctx, x, 13, 2, 2, GHOST_BODY); // hump down
    px(ctx, x + 2, 13, GHOST_NOTCH); // notch shade
  }
}

function drawGhost(ctx: Ctx, f: number): void {
  if (f === GHOST_SCREAM_FRAME) {
    drawGhostScream(ctx);
    return;
  }
  ghostBell(ctx, f);
  // calm eyes look forward (right)
  rect(ctx, 5, 5, 2, 3, GHOST_WHITE);
  rect(ctx, 9, 5, 2, 3, GHOST_WHITE);
  rect(ctx, 6, 6, 1, 2, GHOST_PUPIL);
  rect(ctx, 10, 6, 1, 2, GHOST_PUPIL);
}

/** The terrified, cornered face — wide eyes + a gaping mouth (used on death). */
function drawGhostScream(ctx: Ctx): void {
  ghostBell(ctx, 0);
  // big round panicked eyes, pupils shrunk + raised
  rect(ctx, 4, 4, 3, 4, GHOST_WHITE);
  rect(ctx, 9, 4, 3, 4, GHOST_WHITE);
  px(ctx, 5, 4, GHOST_PUPIL);
  px(ctx, 10, 4, GHOST_PUPIL);
  // raised "surprised" brows
  rect(ctx, 4, 3, 3, 1, GHOST_NOTCH);
  rect(ctx, 9, 3, 3, 1, GHOST_NOTCH);
  // gaping mouth
  rect(ctx, 6, 9, 4, 3, GHOST_PUPIL);
  px(ctx, 6, 9, GHOST_BODY);
  px(ctx, 9, 9, GHOST_BODY);
}

// ─── outline pass ───

/**
 * Paint a 1px halo (outline color) around the opaque silhouette inside one
 * frame's sub-rectangle. Reads the just-drawn pixels, so call AFTER drawing.
 * Sprite art must stay ≥1px inset from the frame edges so the halo has room and
 * doesn't bleed into neighbouring frames.
 */
function outlineFrame(ctx: Ctx, x0: number, w: number, h: number, color: string): void {
  const img = ctx.getImageData(x0, 0, w, h);
  const d = img.data;
  const opaque = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 0;
  const halo: [number, number][] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] !== 0) continue;
      if (opaque(x - 1, y) || opaque(x + 1, y) || opaque(x, y - 1) || opaque(x, y + 1)) {
        halo.push([x, y]);
      }
    }
  }
  ctx.fillStyle = color;
  for (const [x, y] of halo) ctx.fillRect(x0 + x, y, 1, 1);
}

/**
 * Bake a spec's frames into one horizontal-strip canvas (frame 0 | frame 1 | …)
 * with outlines applied. Used by both SpriteAtlas (→ THREE texture) and the
 * intro picker (→ preview). Browser-only (needs a 2D canvas).
 */
export function renderSpec(spec: SpriteSpec): HTMLCanvasElement {
  const { width, height, frames, outline, draw } = spec;
  const canvas = document.createElement('canvas');
  canvas.width = width * frames;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  for (let f = 0; f < frames; f++) {
    ctx.save();
    ctx.translate(f * width, 0);
    draw(ctx, f);
    ctx.restore();
  }
  for (let f = 0; f < frames; f++) outlineFrame(ctx, f * width, width, height, outline);
  return canvas;
}

// ─── registry ───

const PLAYER_SPECS: Record<string, SpriteSpec> = {
  dash: { width: 16, height: 24, frames: 2, outline: '#0c1f1a', draw: drawDash },
  plumber: { width: 16, height: 24, frames: 2, outline: '#1a0f0c', draw: drawPlumber },
  duck: { width: 16, height: 24, frames: 2, outline: '#5a3d0a', draw: drawDuck },
  knight: { width: 16, height: 24, frames: 2, outline: '#23262e', draw: drawKnight },
  // Batman — the admin "creator" character. Not in the intro picker (CHARACTERS),
  // but registered here so every client renders it when granted server-side.
  batman: { width: 16, height: 24, frames: 2, outline: '#0a0b0f', draw: drawBatman },
};

// Anonymous figure (Skip / unknown ids). Dark outline; body tinted at runtime.
const ANON_SPEC: SpriteSpec = { width: 16, height: 24, frames: 2, outline: '#23252b', draw: drawAnon };

/** True when `id` is not one of the named characters (→ tintable anon sprite). */
export function isAnonSpec(id: string | undefined | null): boolean {
  return !id || !(id in PLAYER_SPECS);
}

/** Sprite spec for a character id (falls back to the anonymous figure). */
export function getPlayerSpec(id: string | undefined | null): SpriteSpec {
  return (id && PLAYER_SPECS[id]) || ANON_SPEC;
}

/**
 * Sprite spec for the enemy ghost — NEUTRAL (untinted) so a single baked atlas
 * is shared across every enemy and tinted live per-instance (uTint) from healthy
 * to dying. 3 frames: 0/1 = walk, 2 = scream (forced during the death sequence).
 */
export function getGhostSpec(): SpriteSpec {
  return {
    width: 16,
    height: 16,
    frames: GHOST_FRAMES,
    outline: '#15151a',
    draw: drawGhost,
  };
}
