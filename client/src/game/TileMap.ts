import * as THREE from 'three';
import { MAP, TILE_W, TILE_H, ASSETS, STREAM } from '../config';
import type { Camera } from './Camera';

interface LoadedTile {
  mesh: THREE.Mesh;
  texture: THREE.Texture;
}

/**
 * Loads the explicitly-listed map photo tiles (MAP.TILES, which may include
 * negative coordinates) as textured planes and culls them to the camera view.
 *
 * Data space is +Y down with origin at tile (0,0)'s top-left. The scene stores
 * three_y = -data_y, so a tile's mesh is placed at (centerX, -centerY).
 * Textures render upright (standard Three.js +Y-up geometry; no flips needed).
 */
export class TileMap {
  readonly group: THREE.Group;
  private loader = new THREE.TextureLoader();
  private tiles: Map<string, LoadedTile> = new Map();
  private loading: Set<string> = new Set();
  // Global map-photo opacity (1 = normal). Driven by the kill "glitch" so the
  // background image can fade transparent while paths/players stay visible.
  private opacity = 1;

  constructor() {
    this.group = new THREE.Group();
    this.group.position.z = 0;
  }

  /**
   * Fade the whole map photo (all tiles, present + future) to `o` (0..1). Used by
   * the citywide kill glitch: at o<1 the photo goes transparent, revealing the
   * dark background, while the path overlay + characters keep rendering on top.
   */
  setOpacity(o: number): void {
    const transparent = o < 1;
    this.opacity = o;
    for (const { mesh } of this.tiles.values()) {
      const mat = mesh.material as THREE.MeshBasicMaterial;
      if (mat.transparent !== transparent) {
        mat.transparent = transparent; // toggling render state needs a recompile
        mat.needsUpdate = true;
      }
      mat.opacity = o; // just a uniform — cheap to change every frame
    }
  }

  private key(col: number, row: number): string {
    return `${col}_${row}`;
  }

  /** Data-space top-left corner of a tile. */
  private tileMinX(col: number): number {
    return col * TILE_W;
  }
  private tileMinY(row: number): number {
    return row * TILE_H;
  }

  private loadTile(col: number, row: number): void {
    const key = this.key(col, row);
    if (this.tiles.has(key) || this.loading.has(key)) return;
    this.loading.add(key);

    const url = ASSETS.MAP_TILE_PATH + ASSETS.tileName(col, row, ASSETS.TILE_EXTENSION_MAP);

    this.loader.load(
      url,
      (texture) => {
        this.loading.delete(key);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;

        const geometry = new THREE.PlaneGeometry(TILE_W, TILE_H);
        // Inherit the current global opacity so tiles streaming in mid-glitch
        // match the rest of the map.
        const material = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: this.opacity < 1,
          opacity: this.opacity,
        });
        const mesh = new THREE.Mesh(geometry, material);
        // Center in data space, negated Y for the scene.
        const centerX = this.tileMinX(col) + TILE_W / 2;
        const centerY = this.tileMinY(row) + TILE_H / 2;
        mesh.position.set(centerX, -centerY, 0);

        this.tiles.set(key, { mesh, texture });
        this.group.add(mesh);
      },
      undefined,
      () => {
        this.loading.delete(key);
        console.warn(`Failed to load map tile ${key} (${url})`);
      }
    );
  }

  private unloadTile(key: string): void {
    const tile = this.tiles.get(key);
    if (!tile) return;
    this.group.remove(tile.mesh);
    tile.mesh.geometry.dispose();
    (tile.mesh.material as THREE.MeshBasicMaterial).dispose();
    tile.texture.dispose();
    this.tiles.delete(key);
  }

  /**
   * Load tiles overlapping the camera view, plus a small directional preload
   * margin so the next tile is ready just before its edge scrolls into view.
   * Expanding the view rect by a margin (rather than a full tile on every side)
   * makes the overlap test inherently directional: a neighbor is pulled in only
   * on the side the player is approaching. Far tiles are unloaded.
   */
  updateVisibleTiles(camera: Camera): void {
    const m = STREAM.TILE_PRELOAD_MARGIN;
    const left = camera.dataX - camera.viewWidth / 2 - m;
    const right = camera.dataX + camera.viewWidth / 2 + m;
    const top = camera.dataY - camera.viewHeight / 2 - m;
    const bottom = camera.dataY + camera.viewHeight / 2 + m;

    const visible = new Set<string>();
    for (const t of MAP.TILES) {
      const tMinX = this.tileMinX(t.col);
      const tMaxX = tMinX + TILE_W;
      const tMinY = this.tileMinY(t.row);
      const tMaxY = tMinY + TILE_H;
      const overlaps = tMaxX > left && tMinX < right && tMaxY > top && tMinY < bottom;
      if (overlaps) {
        const key = this.key(t.col, t.row);
        visible.add(key);
        if (!this.tiles.has(key) && !this.loading.has(key)) this.loadTile(t.col, t.row);
      }
    }

    for (const key of [...this.tiles.keys()]) {
      if (!visible.has(key)) this.unloadTile(key);
    }
  }
}
