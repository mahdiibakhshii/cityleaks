# Tile System & Collision Mask

## Overview

The game world is a high-resolution orthographic city photograph, split into a grid of image tiles. A matching set of collision mask tiles defines where players can walk (white) and where they're blocked (dark/black).

## Coordinate System

The game uses a 2D coordinate system where:

- **Origin (0, 0)** = top-left corner of the full map image
- **+X** = rightward
- **+Y** = downward (matches screen/image coordinates)
- **Units** = pixels of the source image (1 world unit = 1 pixel at native zoom)

The Three.js scene is set up so that the XY plane is the map surface. The OrthographicCamera looks down the -Z axis.

```
(0,0) ────────────────────► +X
  │
  │    ┌───────┬───────┐
  │    │ 0,0   │ 1,0   │   ← tile grid
  │    ├───────┼───────┤
  │    │ 0,1   │ 1,1   │
  │    └───────┴───────┘
  ▼
  +Y
```

## Configuration (config.ts)

All tile-related values live in `config.ts` and must be easy to change when the user provides final assets:

```typescript
export const MAP_CONFIG = {
  // Tile grid dimensions
  TILE_COLS: 5,             // number of tile columns — USER WILL SPECIFY
  TILE_ROWS: 5,             // number of tile rows — USER WILL SPECIFY

  // Pixel dimensions of each tile image
  TILE_WIDTH_PX: 1024,      // pixels — USER WILL SPECIFY
  TILE_HEIGHT_PX: 1024,     // pixels — USER WILL SPECIFY

  // Derived (computed from above)
  // TOTAL_WIDTH_PX = TILE_COLS * TILE_WIDTH_PX
  // TOTAL_HEIGHT_PX = TILE_ROWS * TILE_HEIGHT_PX

  // File paths
  MAP_TILE_PATH: '/tiles/map/',     // e.g., /tiles/map/tile_0_0.webp
  MASK_TILE_PATH: '/tiles/mask/',   // e.g., /tiles/mask/tile_0_0.png
  TILE_EXTENSION_MAP: '.webp',      // or '.png', '.jpg'
  TILE_EXTENSION_MASK: '.png',      // always PNG (lossless, no artifacts)

  // Tile naming function
  // Default: tile_{col}_{row}.ext
  tileName: (col: number, row: number, ext: string) => `tile_${col}_${row}${ext}`,

  // World scale: how many world units per pixel
  // 1.0 means 1 pixel = 1 world unit. Adjust if the map is very large.
  WORLD_SCALE: 1.0,
};
```

## Map Tile Loading (TileMap.ts)

### Responsibilities
1. Create a Three.js `PlaneGeometry` for each tile, textured with the map image
2. Position each plane in the correct grid location
3. Load only tiles that are near the camera viewport (+ 1 tile buffer)
4. Unload tiles that are far away to save GPU memory

### Implementation Details

Each tile is a `THREE.Mesh`:
```typescript
const geometry = new THREE.PlaneGeometry(TILE_WIDTH_PX, TILE_HEIGHT_PX);
const material = new THREE.MeshBasicMaterial({ map: texture });
const mesh = new THREE.Mesh(geometry, material);

// Position: tile (col, row) → world position of the tile's center
mesh.position.set(
  col * TILE_WIDTH_PX + TILE_WIDTH_PX / 2,
  row * TILE_HEIGHT_PX + TILE_HEIGHT_PX / 2,
  0  // z = 0, flat on the XY plane
);
```

### Texture Settings
```typescript
texture.minFilter = THREE.LinearFilter;
texture.magFilter = THREE.LinearFilter;  // or NearestFilter for pixel-crisp look
texture.colorSpace = THREE.SRGBColorSpace;
```

### Tile Visibility Culling

On each frame (or every few frames for performance), compute which tiles overlap the camera's visible area:

```typescript
function getVisibleTiles(camera: THREE.OrthographicCamera): Set<string> {
  const left = camera.position.x + camera.left;
  const right = camera.position.x + camera.right;
  const top = camera.position.y + camera.top;     // Note: OrthographicCamera top/bottom
  const bottom = camera.position.y + camera.bottom;

  const buffer = 1; // load 1 extra tile around the edge
  const minCol = Math.max(0, Math.floor(left / TILE_WIDTH_PX) - buffer);
  const maxCol = Math.min(TILE_COLS - 1, Math.floor(right / TILE_WIDTH_PX) + buffer);
  const minRow = Math.max(0, Math.floor(top / TILE_HEIGHT_PX) - buffer);
  const maxRow = Math.min(TILE_ROWS - 1, Math.floor(bottom / TILE_HEIGHT_PX) + buffer);

  const visible = new Set<string>();
  for (let c = minCol; c <= maxCol; c++) {
    for (let r = minRow; r <= maxRow; r++) {
      visible.add(`${c}_${r}`);
    }
  }
  return visible;
}
```

Load new visible tiles, dispose textures + remove meshes for tiles no longer visible.

## Collision Mask (CollisionMask.ts)

### How It Works

The collision mask is a set of images with the **exact same tile layout and pixel resolution** as the map tiles. Each pixel is either:
- **White (R > 128)** → walkable
- **Dark/Black (R ≤ 128)** → blocked (building, obstacle)

### Loading

Each mask tile is loaded into an **off-screen `<canvas>` element**, then its pixel data is extracted into a `Uint8ClampedArray` for fast lookup:

```typescript
class CollisionMask {
  private maskData: Map<string, {
    data: Uint8ClampedArray;  // RGBA pixel data
    width: number;
    height: number;
  }> = new Map();

  async loadTile(col: number, row: number): Promise<void> {
    const img = new Image();
    img.src = `${MASK_TILE_PATH}${tileName(col, row, MASK_EXT)}`;
    await img.decode();

    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);

    const imageData = ctx.getImageData(0, 0, img.width, img.height);
    this.maskData.set(`${col}_${row}`, {
      data: imageData.data,
      width: img.width,
      height: img.height,
    });
  }
}
```

### Querying Walkability

```typescript
isWalkable(worldX: number, worldY: number): boolean {
  // Convert world coords to pixel coords
  const pixelX = Math.floor(worldX / WORLD_SCALE);
  const pixelY = Math.floor(worldY / WORLD_SCALE);

  // Determine which tile this pixel falls in
  const col = Math.floor(pixelX / TILE_WIDTH_PX);
  const row = Math.floor(pixelY / TILE_HEIGHT_PX);

  const tileKey = `${col}_${row}`;
  const tile = this.maskData.get(tileKey);
  if (!tile) return false; // Off-map = not walkable

  // Local pixel within the tile
  const localX = pixelX - col * TILE_WIDTH_PX;
  const localY = pixelY - row * TILE_HEIGHT_PX;

  // Bounds check
  if (localX < 0 || localX >= tile.width || localY < 0 || localY >= tile.height) {
    return false;
  }

  // Sample the red channel (index 0 of RGBA)
  const index = (localY * tile.width + localX) * 4;
  return tile.data[index] > 128;
}
```

### Circle Collision (Player Has Radius)

The player is not a point — it's a circle with a radius. To prevent the circle from overlapping buildings, sample multiple points around the circle's edge:

```typescript
isCircleWalkable(worldX: number, worldY: number, radius: number): boolean {
  // Check center
  if (!this.isWalkable(worldX, worldY)) return false;

  // Check 8 points around the perimeter
  const steps = 8;
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    const px = worldX + Math.cos(angle) * radius;
    const py = worldY + Math.sin(angle) * radius;
    if (!this.isWalkable(px, py)) return false;
  }
  return true;
}
```

### Mask Tiles — Loading Strategy

Load mask tiles for the area around the player (same viewport culling as map tiles, or slightly larger buffer). Mask data is small (pixel arrays) so keeping a few extra in memory is fine.

**Important:** Mask tiles should be **PNG** (lossless compression). JPEG/WebP compression creates artifacts that would cause incorrect collision at building edges.

## Wall Sliding

When the player tries to move diagonally into a wall, try each axis independently:

```typescript
function moveWithSliding(
  currentX: number, currentY: number,
  dx: number, dy: number,
  radius: number, mask: CollisionMask
): { x: number; y: number } {
  // Try full movement
  if (mask.isCircleWalkable(currentX + dx, currentY + dy, radius)) {
    return { x: currentX + dx, y: currentY + dy };
  }
  // Try X only
  if (dx !== 0 && mask.isCircleWalkable(currentX + dx, currentY, radius)) {
    return { x: currentX + dx, y: currentY };
  }
  // Try Y only
  if (dy !== 0 && mask.isCircleWalkable(currentX, currentY + dy, radius)) {
    return { x: currentX, y: currentY + dy };
  }
  // Stuck
  return { x: currentX, y: currentY };
}
```

This gives smooth wall-sliding behavior instead of dead-stopping on contact.
