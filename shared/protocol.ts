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
  NOTE_REMOVE: 'note:remove', // server → client: one note deleted (admin) — {id}
  NOTE_UPDATE: 'note:update', // server → client: one note edited (admin) — full Note
  NOTE_RESET: 'note:reset', // server → client: all notes cleared (admin)
  // Enemies: server-authoritative wandering NPCs (mirror the player events).
  ENEMY_EXISTING: 'enemy:existing', // server → client: all enemies on connect
  ENEMY_JOIN: 'enemy:join', // server → client: one enemy spawned
  ENEMY_LEAVE: 'enemy:leave', // server → client: one enemy despawned (silent, e.g. pop. scaling)
  ENEMY_UPDATE: 'enemy:update', // server → client: enemy positions (+ life/panic) each tick
  ENEMY_DIE: 'enemy:die', // server → client: one enemy KILLED (death FX + hunter attribution)
  // Kill markers: persistent "an enemy died here" icons (mirror the sticky notes).
  KILL_EXISTING: 'kill:existing', // server → client: all kill markers on connect
  KILL_NEW: 'kill:new', // server → client: one newly placed kill marker
  KILL_RESET: 'kill:reset', // server → client: all kill markers cleared (admin)
  // Admin (server-enforced password gate). The admin page connects role=admin;
  // auth is the httpOnly session cookie (set at login), read from the socket
  // handshake — never a token in the query string. The live game grants the
  // Batman identity only when that same cookie is valid. All client→server admin
  // actions are trusted because the socket is already in the authed `admin` room.
  ADMIN_OK: 'admin:ok', // server → admin: token accepted
  ADMIN_DENIED: 'admin:denied', // server → admin: token rejected (then disconnect)
  ADMIN_STATS: 'admin:stats', // server → admin: live dashboard numbers (~1 Hz)
  ADMIN_PLAYERS: 'admin:players', // server → admin: live connected-player list (~1 Hz)
  ADMIN_ANNOUNCE: 'admin:announce', // server → game+monitor: transient broadcast message
  ADMIN_NOTE_DELETE: 'admin:note:delete', // admin → server: delete a note — {id}
  ADMIN_NOTE_EDIT: 'admin:note:edit', // admin → server: edit a note — {id,text}
  ADMIN_NOTE_IMAGE_REMOVE: 'admin:note:image:remove', // admin → server: detach a note's photo — {id}
  ADMIN_NOTE_STICKER: 'admin:note:sticker', // admin → server: save/clear a note's sticker design — {id, sticker|null}
  ADMIN_BROADCAST: 'admin:broadcast', // admin → server: broadcast a message — {text}
  ADMIN_RESET_PATHS: 'admin:reset:paths', // admin → server: wipe the leak grid
  ADMIN_RESET_NOTES: 'admin:reset:notes', // admin → server: wipe all notes
  ADMIN_RESET_KILLS: 'admin:reset:kills', // admin → server: wipe all kill markers
  ADMIN_KICK: 'admin:kick', // admin → server: disconnect a player — {id}
  // Monitor background-image opacity. Bidirectional: admin → server sets it
  // ({value} 0..1); server → monitor+admin broadcasts the current value (and
  // sends it to a monitor/admin on connect so they start in sync).
  ADMIN_MAP_OPACITY: 'admin:map-opacity',
  // Anonymous per-note chat rooms. Each note gets a chat room at /c/<noteId>.
  // Accessible only via the QR code printed on the physical sticker in the city.
  CHAT_HISTORY: 'chat:history', // server → client: last N messages on connect
  CHAT_MESSAGE: 'chat:message', // server → client: new message broadcast to room
  CHAT_SEND: 'chat:send',       // client → server: post a message
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

// ─── Batman: the admin "creator" character ───
//
// Deliberately NOT in CHARACTERS, so it never appears in the intro picker. It is
// only granted to a live-game socket that presents a valid admin token (see the
// server's handleGameConnection); a plain `?character=batman` falls back to the
// anonymous circle. Notes stuck by Batman are flagged `admin: true` and render in
// a distinct "creator" style. It renders everywhere via the `batman` sprite
// (client/src/game/sprites/drawSprite.ts) like any other character.
export const ADMIN_CHARACTER_ID = 'batman';

export const ADMIN_CHARACTER: CharacterDef = {
  id: ADMIN_CHARACTER_ID,
  name: 'Batman',
  description: 'The creator. Leaves messages the whole city can tell apart.',
  shape: 'hexagon',
  color: '#11131a',
  abilities: NEUTRAL,
};

/**
 * Look up a character by id for RENDERING / color resolution. Resolves the
 * selectable characters PLUS the admin Batman (so the local Batman client can
 * read its color). This is NOT an authorization check — the server gates who is
 * allowed to BE Batman by validating the admin token, independently of this.
 * Returns undefined for anon / unknown ids.
 */
export function getCharacter(id: string | undefined | null): CharacterDef | undefined {
  if (!id) return undefined;
  if (id === ADMIN_CHARACTER_ID) return ADMIN_CHARACTER;
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
// Base roam speed. With ENEMY_PANIC_BOOST a fleeing enemy exceeds PLAYER_SPEED
// (150), so you CANNOT simply out-run and tag it — you must corner/trap it.
export const ENEMY_SPEED = 140; // world units/sec
export const ENEMY_FLEE_RADIUS = 170; // panic band inner edge — it lets you get close, THEN bolts
export const ENEMY_LEASH_RADIUS = 900; // default comfort band — outer edge

// ─── The hunt: aggression, fatigue, and the two kill paths ───
//
// Enemies are prey. They flee HARDER the closer a player gets (panic sprint), but
// sprinting burns STAMINA; an exhausted enemy is slow and catchable. Two ways to
// kill one (server/src/EnemyManager.ts):
//   • TRAP   — boxed in (walls + player bodies leave no open escape) → life drains
//              fast → dead in ~half a second. The dramatic, coordinated kill.
//   • EXHAUST — chased to empty stamina while kept point-blank → life bleeds out.
//              Slower; what a lone, relentless hunter relies on (no body wall).
// Tuned so a SOLO player can do it (hard, via dead-ends + wearing the enemy down)
// while a GROUP unlocks the fast body-wall trap. `life`/`panic` ride on EnemyPos
// so every client can tint (red→purple-black) + animate the panic/scream.
export const ENEMY_PANIC_BOOST = 0.6; // +60% flee speed at point-blank → ~224 u/s, well above PLAYER_SPEED
export const ENEMY_STAMINA_DRAIN = 0.32; // stamina/sec at full sprint (~3 s to empty — sprints longer)
export const ENEMY_STAMINA_REGEN = 0.3; // stamina/sec recovered when not fleeing (bounces back fast)
export const ENEMY_TIRED_SPEED = 0.62; // flee speed multiplier at empty stamina (tired but not crawling)
export const ENEMY_LIFE_DRAIN_TRAP = 1.5; // life/sec while fully boxed in (~0.67 s kill)
export const ENEMY_LIFE_DRAIN_EXHAUST = 0.22; // life/sec while exhausted AND held point-blank (slow bleed)
export const ENEMY_LIFE_REGEN = 0.25; // life/sec recovered when no player is pressuring
export const ENEMY_TRAP_RADIUS = 220; // players within this of the kill are credited hunters
export const ENEMY_PLAYER_BLOCK = 46; // a player this close to an escape probe blocks that route
export const ENEMY_ESCAPE_CLEARANCE = 36; // min open world units for a direction to count as escape
export const ENEMY_KILL_SPLASH_RADIUS = 90; // leak-grid disc painted where an enemy dies (world units)

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

// Player spawn, in tile (7,6) but lifted a quarter-tile NORTH (smaller Y = up on
// screen, since +Y is down) onto an easier-to-leave open street — the dead-center
// point sat in a cramped spot. findNearestWalkable() still spirals out from here
// to land on a walkable pixel if this exact point is inside a building. Tune the
// 0.25 lift to taste. (Enemies spawn near players on walkable ground, not here.)
export const SPAWN = { x: 7.5 * TILE_W, y: (6.5 - 0.25) * TILE_H };

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
// EnemyPos (below) carries the live position + condition each tick. Parallels
// PlayerState.
export interface EnemyState {
  id: string;
  x: number;
  y: number;
  color: string;
  kind: string; // ENEMY_TYPES[].kind
  life: number; // 0..1 remaining life (1 = healthy; drives the red→purple-black tint)
}

// Slim per-tick enemy update (sent in enemy:update). color/kind are static; life
// and panic change every tick and drive the tint + panic/scream animation.
export interface EnemyPos {
  id: string;
  x: number;
  y: number;
  life: number; // 0..1 remaining life
  panic: number; // 0..1 how hard it's fleeing right now (telegraph)
}

export interface EnemyLeave {
  id: string;
}

// An enemy was KILLED by the players (not a silent population despawn). Triggers
// the scream→explosion FX on every client; `by` lists the hunters near the kill
// (within ENEMY_TRAP_RADIUS) so their clients show the success popup.
export interface EnemyDie {
  id: string;
  x: number;
  y: number;
  kind: string;
  by: string[]; // socket ids credited with the kill
}

// A persistent "an enemy died here" marker, ownerless + saved forever (mirrors
// the sticky-note Note). Rendered as a tombstone icon on the map + monitor.
export interface KillMarker {
  id: string;
  x: number;
  y: number;
  kind: string; // which enemy kind fell here
  createdAt: number; // epoch ms
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
  admin?: boolean; // true = a "creator" note stuck by Batman (distinct icon + style)
  // A photo of the note's REAL physical sticker, placed in the city by an admin.
  // Relative URL served by the server (e.g. "/note-images/n12.webp"); absent =
  // text-only. The digital↔physical "feedback": the words returned as evidence
  // of their physical twin on a Vienna wall. Uploaded only via the authed admin
  // endpoint (POST /api/admin/note-image).
  image?: string;
  imageAt?: number; // epoch ms the photo was attached (also cache-busts the URL)
  // The printable "sticker design" generated for this note in the admin tool: a
  // white-background layout of the note's text + the chat QR code, sized like a
  // street sticker (several per A4). Stored as a self-describing CONFIG (not a
  // rendered image) so the admin can reopen + tweak it and re-render/print on
  // demand; kept SEPARATE from `image` (the real-sticker photo). Absent = no
  // design yet. See StickerDesign + ADMIN_NOTE_STICKER.
  sticker?: StickerDesign;
}

// ─── Sticker designer ───
//
// Bounds the server clamps an incoming design to (the admin renders client-side
// at this pixel resolution — small, print-friendly, several per A4 sheet).
export const STICKER = {
  MIN_SIZE: 120,
  MAX_SIZE: 2000,
  MIN_FONT: 8,
  MAX_FONT: 400,
  MAX_TEXT: 600, // allows the note text plus added spaces / newlines
  QR_MIN: 0.3, // QR may shrink to 30% of its auto slot (gives the text more room)
  QR_MAX: 1, // ...or fill the whole slot
} as const;

export type StickerAlign = 'left' | 'center' | 'right';
// Where the chat QR sits relative to the text ('none' = text-only sticker).
export type StickerQrPos = 'right' | 'left' | 'bottom' | 'none';

// A fully self-describing sticker layout. `template` is just the preset the admin
// last picked (so the UI can re-highlight it); the actual render is driven by the
// explicit w/h/fontSize/align/qrPos/text so it stays stable even if preset
// definitions change later.
export interface StickerDesign {
  template: string; // preset id last chosen (label/starting point only)
  w: number; // sticker pixel width  (design = print resolution)
  h: number; // sticker pixel height
  fontSize: number; // px
  align: StickerAlign;
  qrPos: StickerQrPos;
  qrScale: number; // QR size as a fraction of its auto-computed slot (STICKER.QR_MIN..QR_MAX)
  fontId: string; // key into STICKER_FONTS (client-side list); persisted so design re-opens correctly
  text: string; // editable sticker text (may add spaces / newlines vs note.text)
  updatedAt: number; // epoch ms
}

// Admin → server: save (`sticker` set) or clear (`sticker: null`) a note's design.
export interface AdminNoteSticker {
  id: string;
  sticker: StickerDesign | null;
}

// Validate + clamp an untrusted sticker design (from the admin socket). Returns a
// normalized StickerDesign, or null if it's structurally invalid. Mirrors
// NoteStore.create's defensive validation so a malformed payload can't persist.
export function normalizeStickerDesign(raw: unknown): StickerDesign | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.text !== 'string') return null;
  const text = d.text.slice(0, STICKER.MAX_TEXT);
  if (text.trim().length === 0) return null;
  const clamp = (v: unknown, lo: number, hi: number, dflt: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : dflt;
  const qrScale =
    typeof d.qrScale === 'number' && Number.isFinite(d.qrScale)
      ? Math.max(STICKER.QR_MIN, Math.min(STICKER.QR_MAX, d.qrScale))
      : 1;
  const align: StickerAlign =
    d.align === 'left' || d.align === 'center' || d.align === 'right' ? d.align : 'left';
  const qrPos: StickerQrPos =
    d.qrPos === 'right' || d.qrPos === 'left' || d.qrPos === 'bottom' || d.qrPos === 'none'
      ? d.qrPos
      : 'right';
  return {
    template: typeof d.template === 'string' ? d.template.slice(0, 40) : 'custom',
    w: clamp(d.w, STICKER.MIN_SIZE, STICKER.MAX_SIZE, 760),
    h: clamp(d.h, STICKER.MIN_SIZE, STICKER.MAX_SIZE, 240),
    fontSize: clamp(d.fontSize, STICKER.MIN_FONT, STICKER.MAX_FONT, 64),
    align,
    qrPos,
    qrScale,
    fontId: typeof d.fontId === 'string' && d.fontId.length > 0 ? d.fontId.slice(0, 40) : 'seikora',
    text,
    updatedAt: Date.now(),
  };
}

// Client → server request to stick a note. The server validates text length and
// clamps the position to the map bounds before assigning id / createdAt.
export interface NoteCreate {
  x: number;
  y: number;
  text: string;
}

// Resolve a note's photo to a cache-busted URL (the filename is reused on
// replace, so we version it by imageAt). Returns null for text-only notes. Used
// by every surface that shows the real-sticker photo (game / monitor / admin).
export function noteImageUrl(note: Note): string | null {
  if (!note.image) return null;
  return note.imageAt ? `${note.image}?v=${note.imageAt}` : note.image;
}

// ─── Admin payloads ───

// A transient broadcast message shown to every player (like a note reveal, but
// in the distinct "creator" style) for a few seconds, then auto-dismissed.
export interface AdminAnnounce {
  id: string;
  text: string;
}

// One row of the admin's live player list (sent in ADMIN_PLAYERS).
export interface AdminPlayerInfo {
  id: string;
  x: number;
  y: number;
  color: string;
  character: string;
}

// The admin live dashboard snapshot (sent ~1 Hz in ADMIN_STATS).
export interface AdminStats {
  players: number;
  leakedPercentage: number;
  enemies: number;
  notes: number;
  kills: number;
  tickMs: { last: number; avg: number; max: number };
  uptime: number;
}

// Admin action request payloads.
export interface AdminNoteEdit {
  id: string;
  text: string;
}
export interface AdminBroadcast {
  text: string;
}
export interface AdminKick {
  id: string;
}
export interface AdminMapOpacity {
  value: number; // 0 (transparent) .. 1 (opaque)
}

// ─── Per-note anonymous chat rooms ───
//
// Every stuck note gets a chat room at /c/<noteId>. Accessible only via the QR
// code on the physical sticker — closing the loop between the digital city and
// the physical streets. Chatters are fully anonymous: the server assigns a color
// per session; no login, no persistent identity.
export const CHAT_MAX_MESSAGES = 200;  // ring buffer per room (oldest dropped)
export const CHAT_MAX_MSG_LENGTH = 300; // server-enforced per-message character cap

// A single chat message in a note's room.
export interface ChatMessage {
  id: string;       // unique: `cm${noteId}_${counter}`
  noteId: string;
  text: string;
  color: string;    // hex color assigned by the server to this session
  createdAt: number; // epoch ms
}

// Client → server: post a message (noteId comes from socket handshake).
export interface ChatSend {
  text: string;
}

// Server → client: the last N messages on connect.
export interface ChatHistory {
  noteId: string;
  // The note context (the "original post"): its text, creator flag, and the
  // resolved real-sticker photo URL (cache-busted) or null for text-only notes.
  note: { text: string; admin?: boolean; image?: string | null };
  messages: ChatMessage[];
  yourColor: string; // the color the server assigned to this session
}
