import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { MAP_BOUNDS, SPAWN, COLLISION_GRID_SIZE } from '../../shared/protocol';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Map bounds and spawn come from the shared tile layout so the client and
// server always agree. Update shared/protocol.ts MAP.TILES when tiles change.
export { MAP_BOUNDS, SPAWN, COLLISION_GRID_SIZE };

export const PORT = Number(process.env.PORT) || 3000;

// Admin page password. Override in production via env (ADMIN_PASSWORD=…); the
// default matches the simple local code requested for the installation.
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '252525';

// Where the leak grid is persisted. Resolved relative to the server's cwd.
export const GRID_FILE = path.resolve(process.cwd(), 'data', 'leak-grid.bin');

// Where sticky notes are persisted (JSON). Same data dir as the leak grid.
export const NOTES_FILE = path.resolve(process.cwd(), 'data', 'notes.json');

// Where persistent enemy-kill markers are stored (JSON). Same data dir.
export const KILLS_FILE = path.resolve(process.cwd(), 'data', 'kills.json');

// Cached server collision field (built once from the mask tiles). Same data dir.
export const COLLISION_FILE = path.resolve(process.cwd(), 'data', 'collision.bin');

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
