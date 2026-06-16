import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { MAP_BOUNDS, SPAWN, COLLISION_GRID_SIZE } from '../../shared/protocol';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Map bounds and spawn come from the shared tile layout so the client and
// server always agree. Update shared/protocol.ts MAP.TILES when tiles change.
export { MAP_BOUNDS, SPAWN, COLLISION_GRID_SIZE };

export const PORT = Number(process.env.PORT) || 3000;

// True when running under PM2 in production (NODE_ENV set in ecosystem.config.cjs).
// Gates the hard-refuse-on-weak-password boot check + the Secure cookie flag.
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Admin page password. Override via env (ADMIN_PASSWORD=…). The weak default is
// for LOCAL DEV ONLY — in production the server refuses to boot unless a strong
// password is set (see ADMIN_PASSWORD_INSECURE + the check in index.ts).
const DEFAULT_ADMIN_PASSWORD = '252525';
const MIN_ADMIN_PASSWORD_LENGTH = 10;
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;

// The configured admin password is unsafe for production: it's the public
// default, or too short to resist guessing even with rate limiting.
export const ADMIN_PASSWORD_INSECURE =
  ADMIN_PASSWORD === DEFAULT_ADMIN_PASSWORD || ADMIN_PASSWORD.length < MIN_ADMIN_PASSWORD_LENGTH;

// Where the leak grid is persisted. Resolved relative to the server's cwd.
export const GRID_FILE = path.resolve(process.cwd(), 'data', 'leak-grid.bin');

// Where sticky notes are persisted (JSON). Same data dir as the leak grid.
export const NOTES_FILE = path.resolve(process.cwd(), 'data', 'notes.json');

// Where persistent enemy-kill markers are stored (JSON). Same data dir.
export const KILLS_FILE = path.resolve(process.cwd(), 'data', 'kills.json');

// Cached server collision field (built once from the mask tiles). Same data dir.
export const COLLISION_FILE = path.resolve(process.cwd(), 'data', 'collision.bin');

// Where admins' real-sticker photos are stored (one webp per note id). Same data
// dir as the notes themselves so it's persistent, gitignored, and synced/backed
// up alongside notes.json (see deploy/sync-data.sh). Served at /note-images.
export const NOTE_IMAGES_DIR = path.resolve(process.cwd(), 'data', 'note-images');

// Where per-note chat room messages are persisted (one JSON file per note id).
// Same data dir, gitignored, part of the sync/backup set.
export const CHATS_DIR = path.resolve(process.cwd(), 'data', 'chats');

// Directory of mask PNG tiles the server decodes to build its collision field.
// Production: Vite copies client/public/ into client/dist/, so masks live in
// client/dist/tiles/mask. Dev: they're served straight from client/public.
// Prefer whichever exists (dist first), resolved relative to this file.
export const MASK_TILES_DIR = (() => {
  const candidates = [
    path.resolve(__dirname, '../../client/dist/tiles/mask'),
    path.resolve(__dirname, '../../client/public/tiles/mask'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[1];
})();
