import { MAP, TILE_W, TILE_H, ASSETS, MASK, STREAM, type TileCoord } from '../config';

interface MaskTile {
  data: Uint8ClampedArray; // RGBA pixel data
  width: number;
  height: number;
}

/**
 * Streams collision-mask tiles near the player and answers walkability by
 * sampling the ALPHA channel: alpha >= MASK.ALPHA_THRESHOLD is BLOCKED
 * (a building); transparent areas are walkable.
 *
 * Only mask tiles within STREAM.MASK_STREAM_MARGIN of the player are kept in
 * memory; the rest are unloaded. The margin is far larger than the collision
 * radius, so a neighbor tile is always loaded before the player reaches it
 * (an unloaded tile reads as blocked, which would be an invisible wall).
 *
 * Data space is +Y down with origin at tile (0,0)'s top-left — this matches the
 * mask images directly (image (0,0) is top-left), so there is NO Y inversion.
 */
export class CollisionMask {
  private maskData: Map<string, MaskTile> = new Map();
  private loadingPromises: Map<string, Promise<void>> = new Map();
  private failed: Set<string> = new Set();
  private loadedAny = false;

  private key(col: number, row: number): string {
    return `${col}_${row}`;
  }

  /** Tiles (from MAP.TILES) overlapping a box of half-extent `margin` around (px,py). */
  private tilesAround(px: number, py: number, margin: number): TileCoord[] {
    const left = px - margin;
    const right = px + margin;
    const top = py - margin;
    const bottom = py + margin;
    return MAP.TILES.filter((t) => {
      const x0 = t.col * TILE_W;
      const x1 = x0 + TILE_W;
      const y0 = t.row * TILE_H;
      const y1 = y0 + TILE_H;
      return x1 > left && x0 < right && y1 > top && y0 < bottom;
    });
  }

  private loadTile(col: number, row: number): Promise<void> {
    const key = this.key(col, row);
    if (this.maskData.has(key) || this.failed.has(key)) return Promise.resolve();
    const existing = this.loadingPromises.get(key);
    if (existing) return existing;

    const url = ASSETS.MASK_TILE_PATH + ASSETS.tileName(col, row, ASSETS.TILE_EXTENSION_MASK);
    const promise = (async () => {
      try {
        const img = new Image();
        img.src = url;
        await img.decode();

        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0);

        const imageData = ctx.getImageData(0, 0, img.width, img.height);
        this.maskData.set(key, {
          data: imageData.data,
          width: img.width,
          height: img.height,
        });
        this.loadedAny = true;
      } catch (err) {
        this.failed.add(key); // Don't retry a missing/broken tile every frame.
        console.warn(`Failed to load mask tile ${key} (${url})`, err);
      }
    })().finally(() => {
      this.loadingPromises.delete(key);
    });

    this.loadingPromises.set(key, promise);
    return promise;
  }

  private unloadTile(key: string): void {
    this.maskData.delete(key); // Frees the pixel array for GC.
  }

  /**
   * Stream: ensure mask tiles near the player are loaded and unload far ones.
   * Call every frame (or a few times per second) with the player's position.
   */
  update(px: number, py: number): void {
    const want = this.tilesAround(px, py, STREAM.MASK_STREAM_MARGIN);
    const wantKeys = new Set(want.map((t) => this.key(t.col, t.row)));

    for (const t of want) this.loadTile(t.col, t.row); // fire-and-forget

    for (const key of [...this.maskData.keys()]) {
      if (!wantKeys.has(key)) this.unloadTile(key);
    }
  }

  /** Await the mask tiles around (px,py) — used before resolving the spawn. */
  async ensureLoaded(px: number, py: number): Promise<void> {
    const want = this.tilesAround(px, py, STREAM.MASK_STREAM_MARGIN);
    await Promise.all(want.map((t) => this.loadTile(t.col, t.row)));
    if (!this.loadedAny) {
      console.warn('No collision mask tiles loaded near spawn — check mask paths/names.');
    }
  }

  /** Is a single world point walkable? */
  isWalkable(worldX: number, worldY: number): boolean {
    // World units → source pixels (data space already matches image space).
    const pixelX = Math.floor(worldX / MAP.WORLD_SCALE);
    const pixelY = Math.floor(worldY / MAP.WORLD_SCALE);

    // Which tile? floor() handles negative coordinates correctly.
    const col = Math.floor(pixelX / MAP.TILE_WIDTH_PX);
    const row = Math.floor(pixelY / MAP.TILE_HEIGHT_PX);

    const tile = this.maskData.get(this.key(col, row));
    if (!tile) return false; // Off-map / not-yet-loaded = not walkable.

    const localX = pixelX - col * MAP.TILE_WIDTH_PX;
    const localY = pixelY - row * MAP.TILE_HEIGHT_PX;
    if (localX < 0 || localX >= tile.width || localY < 0 || localY >= tile.height) {
      return false;
    }

    // Sample alpha (index 3 of RGBA). Opaque = building = blocked.
    const alpha = tile.data[(localY * tile.width + localX) * 4 + 3];
    return alpha < MASK.ALPHA_THRESHOLD;
  }

  /** Is a circle (center + radius) fully walkable? Samples center + 8 perimeter points. */
  isCircleWalkable(worldX: number, worldY: number, radius: number): boolean {
    if (!this.isWalkable(worldX, worldY)) return false;
    const steps = 8;
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      if (!this.isWalkable(worldX + Math.cos(angle) * radius, worldY + Math.sin(angle) * radius)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Find the nearest walkable position by spiralling outward. Used when a player
   * spawns inside a building. Returns the input if already walkable, or null if
   * nothing is found within maxRadius (searches only loaded tiles).
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
        const angle = (i / samples) * Math.PI * 2;
        const x = worldX + Math.cos(angle) * r;
        const y = worldY + Math.sin(angle) * r;
        if (this.isCircleWalkable(x, y, radius)) return { x, y };
      }
    }
    return null;
  }
}

/**
 * Move with axis-separated wall sliding: try full move, then X-only, then
 * Y-only. Gives smooth sliding along walls instead of dead-stopping.
 *
 * `blocked` reports that the full intended move was NOT possible — i.e. the
 * circle touched a wall this step (whether it then slid or fully stopped). The
 * caller uses this to surface the walkability guide on any wall contact.
 */
export function moveWithSliding(
  currentX: number,
  currentY: number,
  dx: number,
  dy: number,
  radius: number,
  mask: CollisionMask
): { x: number; y: number; blocked: boolean } {
  if (mask.isCircleWalkable(currentX + dx, currentY + dy, radius)) {
    return { x: currentX + dx, y: currentY + dy, blocked: false };
  }
  if (dx !== 0 && mask.isCircleWalkable(currentX + dx, currentY, radius)) {
    return { x: currentX + dx, y: currentY, blocked: true };
  }
  if (dy !== 0 && mask.isCircleWalkable(currentX, currentY + dy, radius)) {
    return { x: currentX, y: currentY + dy, blocked: true };
  }
  return { x: currentX, y: currentY, blocked: true };
}
