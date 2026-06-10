import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';
import {
  COLLISION_GRID_SIZE,
  MAP,
  MAP_BOUNDS,
  TILE_W,
  TILE_H,
  type MapBounds,
  type TileCoord,
} from '../../shared/protocol';

// Mask rule (must match client/src/game/CollisionMask.ts → MASK.ALPHA_THRESHOLD):
// alpha >= 128 is a BLOCKED building; below it is walkable. Kept local because
// client and server never import each other; both derive layout from shared/.
const MASK_ALPHA_THRESHOLD = 128;

// Cache file layout: [int32 LE grid size][packed walkable bits]. The header lets
// us detect a COLLISION_GRID_SIZE change and rebuild instead of loading stale bits.
const CACHE_HEADER_BYTES = 4;

/**
 * Coarse, bit-packed WALKABLE grid spanning the full MAP_BOUNDS, used by the
 * server to drive enemies that stay on roads. Built once by decoding the same
 * mask PNG tiles the client streams (client/public/tiles/mask, copied into
 * client/dist/tiles/mask for production), then cached to disk so restarts are
 * instant.
 *
 * bit = 1 → walkable, 0 → blocked. Off-grid reads as blocked (like the client).
 * Mirrors the structure + idioms of LeakGrid and the helpers in CollisionMask.ts.
 */
export class CollisionField {
  private grid: Uint8Array;
  private readonly size: number;
  private _ready = false;
  private readonly maskDir: string;
  private readonly cacheFile: string;

  constructor(maskDir: string, cacheFile: string, size: number = COLLISION_GRID_SIZE) {
    this.size = size;
    this.maskDir = maskDir;
    this.cacheFile = cacheFile;
    this.grid = new Uint8Array(Math.ceil((size * size) / 8)); // all 0 = all blocked
  }

  /** True once the field is populated (from cache or a fresh build). */
  get ready(): boolean {
    return this._ready;
  }

  // ─── Coordinate conversion (mirrors LeakGrid.worldToCell) ───

  worldToCell(worldX: number, worldY: number): { cellX: number; cellY: number } {
    const cellX = Math.floor(((worldX - MAP_BOUNDS.minX) / MAP_BOUNDS.width) * this.size);
    const cellY = Math.floor(((worldY - MAP_BOUNDS.minY) / MAP_BOUNDS.height) * this.size);
    return { cellX, cellY };
  }

  private cellCenterWorld(cellX: number, cellY: number): { x: number; y: number } {
    return {
      x: MAP_BOUNDS.minX + ((cellX + 0.5) / this.size) * MAP_BOUNDS.width,
      y: MAP_BOUNDS.minY + ((cellY + 0.5) / this.size) * MAP_BOUNDS.height,
    };
  }

  // ─── Queries (mirror client/src/game/CollisionMask.ts) ───

  /** Is a single world point walkable? Off-grid / blocked → false. */
  isWalkable(worldX: number, worldY: number): boolean {
    const { cellX, cellY } = this.worldToCell(worldX, worldY);
    if (cellX < 0 || cellX >= this.size || cellY < 0 || cellY >= this.size) return false;
    const index = cellY * this.size + cellX;
    return (this.grid[index >> 3] & (1 << (index & 7))) !== 0;
  }

  /** Is a circle (center + radius) fully walkable? Samples center + 8 perimeter points. */
  isCircleWalkable(worldX: number, worldY: number, radius: number): boolean {
    if (!this.isWalkable(worldX, worldY)) return false;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      if (!this.isWalkable(worldX + Math.cos(a) * radius, worldY + Math.sin(a) * radius)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Distance (world units, capped at `maxDist`) the point can travel along
   * (dirX,dirY) before leaving walkable ground. Used by enemy steering to favor
   * open streets and avoid dead-ends — the bigger this is, the less trappable.
   */
  clearance(worldX: number, worldY: number, dirX: number, dirY: number, maxDist: number): number {
    const step = 12;
    for (let d = step; d <= maxDist; d += step) {
      if (!this.isWalkable(worldX + dirX * d, worldY + dirY * d)) return d - step;
    }
    return maxDist;
  }

  /**
   * Nearest walkable position, spiralling outward (ports CollisionMask.find-
   * NearestWalkable). Returns the input if already clear, else null past maxRadius.
   */
  findNearestWalkable(
    worldX: number,
    worldY: number,
    radius: number,
    maxRadius = 4000,
    step = 16
  ): { x: number; y: number } | null {
    if (this.isCircleWalkable(worldX, worldY, radius)) return { x: worldX, y: worldY };
    for (let r = step; r <= maxRadius; r += step) {
      const samples = Math.max(8, Math.floor((2 * Math.PI * r) / step));
      for (let i = 0; i < samples; i++) {
        const a = (i / samples) * Math.PI * 2;
        const x = worldX + Math.cos(a) * r;
        const y = worldY + Math.sin(a) * r;
        if (this.isCircleWalkable(x, y, radius)) return { x, y };
      }
    }
    return null;
  }

  /**
   * Axis-separated wall sliding (ports moveWithSliding in CollisionMask.ts):
   * try the full move, then X-only, then Y-only — smooth sliding along walls.
   */
  moveWithSliding(
    x: number,
    y: number,
    dx: number,
    dy: number,
    radius: number
  ): { x: number; y: number } {
    if (this.isCircleWalkable(x + dx, y + dy, radius)) return { x: x + dx, y: y + dy };
    if (dx !== 0 && this.isCircleWalkable(x + dx, y, radius)) return { x: x + dx, y };
    if (dy !== 0 && this.isCircleWalkable(x, y + dy, radius)) return { x, y: y + dy };
    return { x, y };
  }

  // ─── Build / cache ───

  private setWalkable(cellX: number, cellY: number): void {
    const index = cellY * this.size + cellX;
    this.grid[index >> 3] |= 1 << (index & 7);
  }

  private countWalkable(): number {
    let n = 0;
    for (let i = 0; i < this.grid.length; i++) {
      let b = this.grid[i];
      while (b) {
        n++;
        b &= b - 1;
      }
    }
    return n;
  }

  /**
   * Populate the field: load the disk cache if valid, otherwise decode every
   * mask tile and write the cache. Non-blocking — yields to the event loop
   * between tiles so the server keeps ticking while the field builds. Sets
   * `ready` when done (enemies stay dormant until then).
   */
  async build(): Promise<void> {
    if (await this.tryLoadCache()) {
      this._ready = true;
      return;
    }

    console.log(
      `CollisionField: building ${this.size}×${this.size} walkable grid from mask tiles in ${this.maskDir} ...`
    );
    const startedAt = Date.now();
    let decoded = 0;
    let missing = 0;

    for (const tile of MAP.TILES) {
      const ok = await this.bakeTile(tile);
      if (ok) decoded++;
      else missing++;
      // Yield so a heavy decode never stalls the 10 Hz tick.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    this._ready = true;
    const pct = ((this.countWalkable() / (this.size * this.size)) * 100).toFixed(1);
    console.log(
      `CollisionField ready: ${decoded} tiles decoded` +
        (missing ? `, ${missing} missing` : '') +
        ` — ${pct}% walkable (${Date.now() - startedAt} ms).`
    );
    await this.saveCache();
  }

  /** Decode one mask tile and OR its walkable pixels into the coarse grid. */
  private async bakeTile(tile: TileCoord): Promise<boolean> {
    const file = path.join(this.maskDir, `tile_${tile.col}_${tile.row}.png`);
    let png: PNG;
    try {
      png = PNG.sync.read(await fs.promises.readFile(file));
    } catch {
      return false; // Missing/broken tile → its area stays blocked (safe).
    }

    // World extent of this tile, and the coarse cells whose CENTER falls inside it.
    const x0 = tile.col * TILE_W;
    const y0 = tile.row * TILE_H;
    const x1 = x0 + TILE_W;
    const y1 = y0 + TILE_H;
    const c0 = this.worldToCell(x0, y0);
    const c1 = this.worldToCell(x1, y1);

    for (let cy = Math.max(0, c0.cellY); cy <= Math.min(this.size - 1, c1.cellY); cy++) {
      for (let cx = Math.max(0, c0.cellX); cx <= Math.min(this.size - 1, c1.cellX); cx++) {
        const center = this.cellCenterWorld(cx, cy);
        if (center.x < x0 || center.x >= x1 || center.y < y0 || center.y >= y1) continue;
        // World units → tile-local source pixels (WORLD_SCALE is 1:1 with px).
        const lx = Math.floor((center.x - x0) / MAP.WORLD_SCALE);
        const ly = Math.floor((center.y - y0) / MAP.WORLD_SCALE);
        if (lx < 0 || lx >= png.width || ly < 0 || ly >= png.height) continue;
        const alpha = png.data[(ly * png.width + lx) * 4 + 3];
        if (alpha < MASK_ALPHA_THRESHOLD) this.setWalkable(cx, cy);
      }
    }
    return true;
  }

  private async tryLoadCache(): Promise<boolean> {
    try {
      const buf = await fs.promises.readFile(this.cacheFile);
      if (buf.length !== CACHE_HEADER_BYTES + this.grid.length) return false;
      if (buf.readInt32LE(0) !== this.size) return false;
      this.grid = new Uint8Array(buf.subarray(CACHE_HEADER_BYTES));
      console.log(
        `CollisionField: loaded cache (${this.cacheFile}) — ` +
          `${((this.countWalkable() / (this.size * this.size)) * 100).toFixed(1)}% walkable.`
      );
      return true;
    } catch {
      return false;
    }
  }

  private async saveCache(): Promise<void> {
    try {
      const header = Buffer.alloc(CACHE_HEADER_BYTES);
      header.writeInt32LE(this.size, 0);
      await fs.promises.mkdir(path.dirname(this.cacheFile), { recursive: true });
      await fs.promises.writeFile(this.cacheFile, Buffer.concat([header, Buffer.from(this.grid)]));
      console.log(`CollisionField: cache written to ${this.cacheFile}.`);
    } catch (err) {
      console.warn('CollisionField: failed to write cache (non-fatal):', err);
    }
  }

  /** Exposed for completeness / future tooling. */
  get bounds(): MapBounds {
    return MAP_BOUNDS;
  }
}
