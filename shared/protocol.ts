// Shared protocol between client and server.
// Event names, payload interfaces, and game constants used by both sides.

// ─── Event Names ───
export const EVENTS = {
  PLAYER_SELF: 'player:self',
  PLAYER_EXISTING: 'player:existing',
  PLAYER_JOIN: 'player:join',
  PLAYER_LEAVE: 'player:leave',
  PLAYER_MOVE: 'player:move',
  STATE_UPDATE: 'state:update',
  GRID_FULL: 'grid:full',
  GRID_DELTA: 'grid:delta',
  GRID_STATS: 'grid:stats',
  GRID_RESET: 'grid:reset',
  // Sticky notes: anonymous text pinned to a map location ("sticking").
  NOTE_EXISTING: 'note:existing', // server → client: all notes on connect
  NOTE_NEW: 'note:new', // server → client: one newly stuck note
  NOTE_CREATE: 'note:create', // client → server: stick a note
  // Enemies: server-authoritative wandering NPCs (mirror the player events).
  ENEMY_EXISTING: 'enemy:existing', // server → client: all enemies on connect
  ENEMY_JOIN: 'enemy:join', // server → client: one enemy spawned
  ENEMY_LEAVE: 'enemy:leave', // server → client: one enemy despawned
  ENEMY_UPDATE: 'enemy:update', // server → client: enemy positions each tick
} as const;

// ─── Timing ───
export const TICK_RATE = 10; // Server broadcast Hz
export const CLIENT_SEND_RATE = 10; // Max client send Hz
export const GRID_SAVE_INTERVAL = 30_000; // ms between disk saves

// ─── Game ───
export const GRID_SIZE = 1000; // 1000×1000 leak grid
export const MAX_PLAYERS = 220; // Soft cap (target: 200 concurrent, 20 buffer)
export const PLAYER_RADIUS = 8; // World units
export const PLAYER_SPEED = 150; // World units per second

// ─── Server-side collision ───
//
// Clients collide against streamed full-res mask tiles (client/src/game/
// CollisionMask.ts). The SERVER needs its own walkability to drive enemies that
// stay on roads, so it builds a coarse bit-packed walkable grid spanning the
// full MAP_BOUNDS (server/src/CollisionField.ts). 2048² bits = 512 KB; over a
// 17×17 (17408²-unit) map that's ~8.5 units/cell — plenty for slow enemies.
export const COLLISION_GRID_SIZE = 2048;

// ─── Sticky notes ───
export const NOTE_MAX_LENGTH = 200; // Max characters in a stuck note (server-enforced)
export const NOTE_REVEAL_RADIUS = 120; // World units; closer than this reveals the text

// ─── Characters ───
//
// Player identity. Until now everyone was an anonymous colored circle; players
// may now pick one of four named characters, each a distinct SHAPE + signature
// color (drawn client-side from `shape`). Skipping the intro keeps the classic
// anonymous circle (id ANON_CHARACTER_ID), which uses a server-assigned RANDOM
// color instead of a signature one.
//
// The chosen character id rides in the Socket.IO handshake query (like `role`)
// and is echoed back in PlayerState so EVERY client renders the right shape.
//
// `abilities` is scaffolding only — the multipliers are all 1.0 today (the
// feature is visual-only for now). When real per-character gameplay lands, wire
// these in (movement speed, note-reveal radius) without changing the protocol.
export type CharacterShape = 'circle' | 'triangle' | 'square' | 'hexagon' | 'diamond';

export interface CharacterAbilities {
  speedMultiplier: number; // ×PLAYER_SPEED  (1.0 = baseline; not yet wired)
  revealRadiusMultiplier: number; // ×NOTE_REVEAL_RADIUS (1.0 = baseline; not yet wired)
}

export interface CharacterDef {
  id: string;
  name: string;
  description: string;
  shape: CharacterShape;
  // Signature color, or null to use a server-assigned random color (anonymous).
  color: string | null;
  abilities: CharacterAbilities;
}

// The anonymous circle — what "Skip" gives you. Random server color, no shape.
export const ANON_CHARACTER_ID = 'anon';

const NEUTRAL: CharacterAbilities = { speedMultiplier: 1, revealRadiusMultiplier: 1 };

// The four selectable characters. Order is the UI order (left→right on desktop,
// row-major on mobile). Edit freely; the picker and renderer are data-driven.
// Each character renders in-game as an original pixel-art mascot sprite with a
// walk cycle (client/src/game/sprites/). `shape` is now only a coarse fallback
// (e.g. monitor dots) — the sprite is selected by `id`. `color` is the signature
// tint used for the picker swatch and the monitor dot.
export const CHARACTERS: CharacterDef[] = [
  {
    id: 'dash',
    name: 'Dash',
    description: 'A blur on the streets. Bolts in straight, fearless lines.',
    shape: 'triangle',
    color: '#16c79a',
    abilities: NEUTRAL,
  },
  {
    id: 'plumber',
    name: 'Pip',
    description: 'Tough and trusty. Stomps out steady, deliberate trails.',
    shape: 'square',
    color: '#ef5350',
    abilities: NEUTRAL,
  },
  {
    id: 'duck',
    name: 'Waddles',
    description: 'Curious and quick. Paddles into every corner of town.',
    shape: 'circle',
    color: '#ffd23f',
    abilities: NEUTRAL,
  },
  {
    id: 'knight',
    name: 'Pim',
    description: 'Brave and dutiful. Charts every alley of the maze.',
    shape: 'hexagon',
    color: '#9b8cff',
    abilities: NEUTRAL,
  },
];

/** Look up a selectable character by id. Returns undefined for anon / unknown. */
export function getCharacter(id: string | undefined | null): CharacterDef | undefined {
  if (!id) return undefined;
  return CHARACTERS.find((c) => c.id === id);
}

/** Resolve any id (including unknown / anon) to a concrete shape for rendering. */
export function shapeForCharacter(id: string | undefined | null): CharacterShape {
  return getCharacter(id)?.shape ?? 'circle';
}

// ─── Enemies ───
//
// Server-authoritative wandering NPCs. They are NOT players: spawned by the
// server, driven by NPC steering in the 10 Hz tick, and broadcast to every
// client (and the monitor) via the ENEMY_* events — so everyone sees the same
// enemies, exactly like players. They stay on roads using the server collision
// field (server/src/CollisionField.ts).
//
// Behavior (server/src/EnemyManager.ts): each enemy keeps a COMFORTABLE distance
// from the nearest player — it flees when crowded (< fleeRadius), drifts back
// when abandoned (> leashRadius), and orbits/wanders in between, always steering
// toward open streets so players can't easily corner it.
//
// The population SCALES with the player count. `abilities`/contact effects are
// intentionally absent for now (ambient only) — add gameplay consequences later
// by extending EnemyDef + a new event, without touching the existing protocol.
//
// `ENEMY_TYPES` is the data-driven customization point (parallel to CHARACTERS):
// add kinds with distinct shapes/colors/tuning here and they render everywhere
// automatically (EnemyState.kind carries the kind to every client).
export interface EnemyDef {
  kind: string;
  name: string;
  shape: CharacterShape;
  color: string;
  speedMultiplier: number; // ×ENEMY_SPEED
  fleeRadius: number; // closer than this → flee (world units)
  leashRadius: number; // farther than this → drift back toward players
  wanderiness: number; // 0..1 random-heading jitter in the comfort band
}

// Population scaling + movement tuning (server/src/EnemyManager.ts).
export const ENEMY_PER_PLAYERS = 4; // ~1 enemy per this many players
export const ENEMY_MIN = 2; // floor while ≥1 player is online
export const ENEMY_MAX = 12; // hard cap on simultaneous enemies
export const ENEMY_RADIUS = 9; // world units (collision + render)
export const ENEMY_SPEED = 110; // world units/sec (a touch slower than players)
export const ENEMY_FLEE_RADIUS = 240; // default comfort band — inner edge
export const ENEMY_LEASH_RADIUS = 900; // default comfort band — outer edge

export const ENEMY_TYPES: EnemyDef[] = [
  {
    // Renders as a Pac-Man-style ghost (client/src/game/sprites/), body tinted
    // with `color`. `shape` is a vestigial fallback only.
    kind: 'wanderer',
    name: 'The Haunt',
    shape: 'diamond',
    color: '#ff2d6f', // hot magenta-red — clearly "not a player"
    speedMultiplier: 1,
    fleeRadius: ENEMY_FLEE_RADIUS,
    leashRadius: ENEMY_LEASH_RADIUS,
    wanderiness: 0.5,
  },
];

/** Look up an enemy kind. Falls back to the first type for unknown kinds. */
export function enemyDef(kind: string | undefined | null): EnemyDef {
  return ENEMY_TYPES.find((e) => e.kind === kind) ?? ENEMY_TYPES[0];
}

/** Resolve any enemy kind to a concrete shape for rendering. */
export function shapeForEnemy(kind: string | undefined | null): CharacterShape {
  return enemyDef(kind).shape;
}

// ─── Map / tile layout (SINGLE SOURCE OF TRUTH for client + server) ───
//
// Coordinate convention: IMAGE coordinates. Origin (0,0) is the TOP-LEFT corner
// of the origin tile (0,0). +X = right, +Y = DOWN. 1 world unit = 1 source pixel
// (times WORLD_SCALE). Rendering negates Y (three_y = -world_y) so +Y is down on
// screen; nothing else inverts.
//
// Tiles are listed explicitly by (col,row) RELATIVE to the origin tile and may be
// negative. The map bounds are computed from whichever tiles are present.
export interface TileCoord {
  col: number;
  row: number;
}

/**
 * Build a full rectangular grid of tile coordinates — handy when a single large
 * image is sliced into a cols×rows grid (see tools/split_tiles.py). originCol /
 * originRow shift which cell is (0,0); pass the same values the splitter used.
 *
 *   TILES: rectTiles(17, 17)            // (0,0) at top-left
 *   TILES: rectTiles(17, 17, 8, 8)      // (0,0) at the center cell
 */
export function rectTiles(cols: number, rows: number, originCol = 0, originRow = 0): TileCoord[] {
  const tiles: TileCoord[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push({ col: c - originCol, row: r - originRow });
    }
  }
  return tiles;
}

export const MAP = {
  // Pixel dimensions of EACH tile image. All tiles must share this size.
  // 1024 is the recommended streaming sweet spot (cheap ~4 MB GPU upload, no
  // hitches as tiles stream in). Set this to your real exported tile size.
  TILE_WIDTH_PX: 1024,
  TILE_HEIGHT_PX: 1024,
  // World units per source pixel.
  WORLD_SCALE: 1.0,
  // The tiles that exist, relative to origin tile (0,0). Add/remove freely.
  TILES: rectTiles(17, 17),
};

// Tile size in world units.
export const TILE_W = MAP.TILE_WIDTH_PX * MAP.WORLD_SCALE;
export const TILE_H = MAP.TILE_HEIGHT_PX * MAP.WORLD_SCALE;

export interface MapBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

function computeBounds(): MapBounds {
  let minCol = Infinity;
  let maxCol = -Infinity;
  let minRow = Infinity;
  let maxRow = -Infinity;
  for (const t of MAP.TILES) {
    minCol = Math.min(minCol, t.col);
    maxCol = Math.max(maxCol, t.col);
    minRow = Math.min(minRow, t.row);
    maxRow = Math.max(maxRow, t.row);
  }
  const minX = minCol * TILE_W;
  const minY = minRow * TILE_H;
  const maxX = (maxCol + 1) * TILE_W;
  const maxY = (maxRow + 1) * TILE_H;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export const MAP_BOUNDS = computeBounds();

// Spawn at the center of tile (7,6). findNearestWalkable() spirals out from
// here to land on a walkable pixel if this exact point is inside a building.
export const SPAWN = { x: 7.5 * TILE_W, y: 6.5 * TILE_H };

// ─── Payload Interfaces ───
export interface PlayerState {
  id: string;
  x: number;
  y: number;
  color: string;
  character: string; // character id (CHARACTERS[].id) or ANON_CHARACTER_ID
}

export interface PlayerSelf {
  id: string;
  x: number;
  y: number;
  color: string;
  character: string; // character id (CHARACTERS[].id) or ANON_CHARACTER_ID
}

// Lightweight position update sent every tick in state:update.
// color/character are static and already sent on player:join / player:existing.
export interface PlayerPos {
  id: string;
  x: number;
  y: number;
}

export interface PlayerLeave {
  id: string;
}

// An enemy NPC. color/kind are static (sent on enemy:existing / enemy:join);
// EnemyPos (below) carries only the position each tick. Parallels PlayerState.
export interface EnemyState {
  id: string;
  x: number;
  y: number;
  color: string;
  kind: string; // ENEMY_TYPES[].kind
}

// Slim per-tick enemy position update (sent in enemy:update). color/kind static.
export interface EnemyPos {
  id: string;
  x: number;
  y: number;
}

export interface EnemyLeave {
  id: string;
}

export interface PlayerMove {
  x: number;
  y: number;
}

export interface GridDelta {
  cells: number[]; // Flat indices: index = row * GRID_SIZE + col
}

export interface GridStats {
  totalLeaked: number;
  percentage: number;
  playerCount: number;
}

// A sticky note: anonymous, ownerless text pinned to a world location and
// persisted forever (like the leak grid). Coords are IMAGE/DATA coords.
export interface Note {
  id: string;
  x: number;
  y: number;
  text: string;
  createdAt: number; // epoch ms
}

// Client → server request to stick a note. The server validates text length and
// clamps the position to the map bounds before assigning id / createdAt.
export interface NoteCreate {
  x: number;
  y: number;
  text: string;
}
