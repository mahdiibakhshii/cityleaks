// Client configuration. The tile LAYOUT (sizes, which tiles exist, bounds,
// spawn) lives in shared/protocol.ts so the server and client never disagree.
// This file holds client-only concerns: asset paths, mask threshold, camera,
// and player visuals.

import {
  MAP,
  MAP_BOUNDS,
  TILE_W,
  TILE_H,
  SPAWN,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  NOTE_REVEAL_RADIUS,
} from '../../shared/protocol';

export { MAP, MAP_BOUNDS, TILE_W, TILE_H, SPAWN };
export type { TileCoord } from '../../shared/protocol';

export const ASSETS = {
  MAP_TILE_PATH: '/tiles/map/',
  MASK_TILE_PATH: '/tiles/mask/',
  // Map photo tiles. '.webp' matches the default output of tools/split_tiles.py.
  TILE_EXTENSION_MAP: '.webp',
  // Masks must be PNG (lossless alpha).
  TILE_EXTENSION_MASK: '.png',
  // Naming: tile_{col}_{row}.ext  — negatives are fine, e.g. tile_-1_0.png
  tileName: (col: number, row: number, ext: string) => `tile_${col}_${row}${ext}`,
  // Downscaled whole-map image for the monitor page (tools/split_tiles.py).
  OVERVIEW_PATH: '/map_overview.webp',
};

export const MASK = {
  // Alpha >= threshold is BLOCKED (a building). Below it is walkable.
  // Your masks draw buildings opaque and leave walkable areas transparent.
  ALPHA_THRESHOLD: 128,
};

export const STREAM = {
  // Map tiles: how far (world units) beyond the viewport edge to begin loading
  // the next tile. Small + directional — only the side being approached is
  // pulled in (a corner only when near both edges). Movement is slow, so a
  // fraction of a tile gives seconds of lead time to decode + upload.
  TILE_PRELOAD_MARGIN: Math.round(0.2 * TILE_W),

  // Collision masks: keep mask tiles loaded within this radius (world units) of
  // the PLAYER; unload the rest. Must be comfortably larger than the player's
  // collision radius so a neighbor tile is ready well before the player reaches
  // its boundary (otherwise unloaded mask = invisible wall).
  MASK_STREAM_MARGIN: Math.round(0.4 * TILE_W),
};

export const PLAYER = {
  RADIUS: PLAYER_RADIUS, // world units (pixels)
  SPEED: PLAYER_SPEED, // world units per second
};

// Wandering enemy NPCs (server-authoritative). Visuals only — shape + color come
// from shared/protocol ENEMY_TYPES (by kind); these are render-side tweaks.
export const ENEMY = {
  // Render radius (world units). A touch bigger than the server collision radius
  // (ENEMY_RADIUS) so enemies read clearly against players.
  RADIUS: 11,
  // Draw order: same band as remote players (above map + paths).
  Z: 1,
  // Interpolation smoothing toward server targets (matches RemotePlayer).
  LERP: 10,
  // ─── The hunt (life tint + panic telegraph + death FX) ───
  // Body tint at FULL life is the enemy's own color (red-ish); as life drains it
  // lerps to this deep purple-black. These are the two thresholds the player reads.
  DYING_COLOR: '#2a0a33',
  // Panic telegraph: the walk cycle speeds up and the body jitters as panic → 1.
  PANIC_FPS_BOOST: 2.6, // extra walk FPS added at full panic (×, on top of SPRITE.WALK_FPS)
  PANIC_SHAKE: 2.4, // world-unit horizontal jitter amplitude at full panic
  // Death sequence timing (seconds): scream/shake, then the explosion pop.
  SCREAM_TIME: 0.5,
  BURST_TIME: 0.6,
  BURST_RADIUS: 95, // peak world radius of the explosion shockwave ring
};

// Persistent "an enemy died here" markers (mirrors NOTE). A tombstone icon is
// stuck at every kill location forever — the city's accumulating hunt history.
export const KILL = {
  ICON_SIZE: 40, // world units (in-game); the monitor passes a larger value
  Z: 1.4, // just below the note icons (1.5), above paths + guide
  STONE: '#b9c0cc', // tombstone fill
  STONE_DARK: '#8a93a3', // shading / cross
  OUTLINE: 'rgba(0,0,0,0.6)',
};

// Pixel-art character/enemy sprites (client/src/game/sprites/). Each entity is a
// textured quad showing an animated walk cycle baked from procedural pixel art.
export const SPRITE = {
  // On-screen size in world units. PURELY VISUAL — collision/movement use
  // PLAYER.RADIUS + PLAYER.SPEED, so enlarging these makes the avatar bigger
  // WITHOUT changing the step size or which buildings it bumps into.
  // Players are 16×24 px art (taller than wide); width is derived from the aspect.
  PLAYER_HEIGHT: 44,
  // Ghosts are 16×16 px.
  ENEMY_HEIGHT: 36,
  // Fraction of height to raise the quad so a character's FEET sit near its
  // road point (its center/collision position) instead of straddling it.
  ANCHOR_Y: 0.34,
  GHOST_ANCHOR_Y: 0.1,
  // Walk-cycle frames per second (2-frame A/B step).
  WALK_FPS: 6,
};

export const CAMERA = {
  // World units visible along the SHORTER screen axis. Keeps the player's
  // surroundings consistent in portrait and landscape (fullscreen, no bars).
  VIEW_MIN_SPAN: 1000,
  // Follow smoothing base (smaller = snappier).
  FOLLOW_BASE: 0.001,
};

// Shared persistent "leak" paths overlay (the 1000×1000 grid every player has
// ever walked). Rendered as a soft glow between the map photo and the players.
export const PATH = {
  COLOR: 0x2a9df4, // Legacy water-blue base (kept for any external reference).
  INTENSITY: 0.8, // Max opacity of a fully-walked cell.
  Z: 0.3, // Draw order: above map tiles (0), below players (1).
  // Pixel-art water palette — quantized into discrete shades like a sprite.
  // Each visited cell becomes one chunky water pixel shaded deep→mid→light;
  // cells on the trail's edge get the bright FOAM rim.
  DEEP: 0x1a5fb4, // Deepest water (cell interiors, darker band).
  MID: 0x2a9df4, // Mid water (the signature leak blue).
  LIGHT: 0x6fc8ff, // Highlight band (catches the shimmer).
  FOAM: 0xd4f1ff, // Bright foam/shoreline rim on the trail edges.
  SHIMMER: 0.35, // Subtle brightness wobble amount (0 = dead still, 1 = busy).
  FOAM_ALPHA_BOOST: 0.18, // Edge cells are a touch more opaque than interiors.
};

// Walkability guide: a soft white glow that highlights the open (walkable)
// streets in a halo around the player whenever they bump into a building, then
// fades out. Reads the same mask PNG tiles as collision (alpha < threshold =
// walkable) and renders them with a radial falloff + global fade.
export const GUIDE = {
  COLOR: 0xffffff, // Soft white glow over walkable streets.
  MAX_ALPHA: 0.38, // Peak opacity of a walkable cell at the player's feet.
  // Halo radius (world units) around the player; the glow fades to nothing at
  // the edge. ~1/3 of the shorter view span — a useful patch without flooding.
  RADIUS: 320,
  // Fade timing (seconds): how fast it appears, how long it lingers after the
  // last wall contact, and how slowly it fades back out.
  FADE_IN: 0.18,
  HOLD: 1.4,
  FADE_OUT: 0.9,
  // Draw order: just above the leak paths (0.3), below every character.
  Z: 0.4,
};

// Sticky notes: anonymous text pinned to a map location. An always-visible icon
// marks each note; walking within REVEAL_RADIUS shows the text fullscreen.
export const NOTE = {
  // World units: closer than this to a note reveals its text (server-shared).
  REVEAL_RADIUS: NOTE_REVEAL_RADIUS,
  // Icon size in WORLD units (drawn as a camera-facing sprite over the map).
  ICON_SIZE: 44,
  // Draw order: above paths (0.3) and below the local player (2).
  Z: 1.5,
  // Procedural icon colors.
  ICON_PAPER: '#fdf6c8', // note paper
  ICON_FOLD: '#e6d98f', // folded corner
  ICON_ACCENT: '#2a9df4', // pin / accent (matches PATH water-blue)
  // Hide a note's own icon while its text is revealed fullscreen (less clutter).
  HIDE_ICON_WHEN_REVEALED: true,
};

// Monitor (spectator) page: shows the whole map fit-to-screen with the live
// paths and every player's position. No local player, no controls.
export const MONITOR = {
  // Fractional empty margin around the map so it isn't flush to the screen edge.
  FIT_MARGIN: 0.04,
  // Player dot radius in WORLD units. Sized relative to the map so dots stay
  // visible when the entire ~17k-unit map is zoomed to fit one screen.
  DOT_RADIUS: Math.round(MAP_BOUNDS.width / 180),
  // Smoothing for dot movement (higher = snappier; matches RemotePlayer feel).
  DOT_LERP: 10,
  // Letterbox / background color behind the map.
  BACKGROUND_COLOR: 0x0d0d16,
};

// Background shown beyond the map edges / void.
export const BACKGROUND_COLOR = 0x1a1a2e;
