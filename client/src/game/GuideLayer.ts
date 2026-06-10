import * as THREE from 'three';
import { MAP, TILE_W, TILE_H, ASSETS, MASK, GUIDE, type TileCoord } from '../config';

interface GuideTile {
  mesh: THREE.Mesh;
  texture: THREE.Texture;
  material: THREE.ShaderMaterial;
}

/**
 * The walkability guide: a soft white glow that highlights the open (walkable)
 * streets in a halo around the player whenever they bump into a wall, then
 * fades out again.
 *
 * It renders the SAME collision-mask PNG tiles used by CollisionMask. In the
 * mask, buildings are opaque and walkable areas are transparent (alpha <
 * MASK.ALPHA_THRESHOLD), so the shader keeps the LOW-alpha (walkable) fragments
 * and paints them with GUIDE.COLOR, attenuated by a radial falloff around the
 * player and a single global fade opacity. One quad per mask tile, only the few
 * tiles within the halo radius are kept loaded, and tiles are released once the
 * glow has fully faded (so it costs nothing while the player roams freely).
 *
 * Orientation matches TileMap exactly: quads sit at (centerX, -centerY) in scene
 * space and the loaded texture renders upright (no UV flips), so the mask aligns
 * pixel-for-pixel with the photo tiles.
 */
export class GuideLayer {
  readonly group: THREE.Group;
  private loader = new THREE.TextureLoader();
  private tiles: Map<string, GuideTile> = new Map();
  private loading: Set<string> = new Set();

  private opacity = 0; // current global fade, 0..1
  private hold = 0; // seconds of "stay visible" remaining since last wall hit

  // Uniforms shared across every tile material so the fade + player position
  // are updated once per frame regardless of how many tiles are loaded.
  private readonly shared = {
    uColor: { value: new THREE.Color(GUIDE.COLOR) },
    uThreshold: { value: MASK.ALPHA_THRESHOLD / 255 },
    uMaxAlpha: { value: GUIDE.MAX_ALPHA },
    uOpacity: { value: 0 },
    uPlayer: { value: new THREE.Vector2(0, 0) }, // scene space (x, -y)
    uRadius: { value: GUIDE.RADIUS },
  };

  constructor() {
    this.group = new THREE.Group();
    this.group.position.z = GUIDE.Z;
    this.group.visible = false;
  }

  private key(col: number, row: number): string {
    return `${col}_${row}`;
  }

  /** Mask tiles (from MAP.TILES) overlapping a box of half-extent `margin` around (px,py). */
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

  private loadTile(col: number, row: number): void {
    const key = this.key(col, row);
    if (this.tiles.has(key) || this.loading.has(key)) return;
    this.loading.add(key);

    const url = ASSETS.MASK_TILE_PATH + ASSETS.tileName(col, row, ASSETS.TILE_EXTENSION_MASK);
    this.loader.load(
      url,
      (texture) => {
        this.loading.delete(key);
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;

        const material = new THREE.ShaderMaterial({
          uniforms: { uMask: { value: texture }, ...this.shared },
          vertexShader: /* glsl */ `
            varying vec2 vUv;
            varying vec2 vWorld;
            void main() {
              vUv = uv;
              vec4 wp = modelMatrix * vec4(position, 1.0);
              vWorld = wp.xy;
              gl_Position = projectionMatrix * viewMatrix * wp;
            }
          `,
          fragmentShader: /* glsl */ `
            uniform sampler2D uMask;
            uniform float uThreshold;
            uniform vec3 uColor;
            uniform float uMaxAlpha;
            uniform float uOpacity;
            uniform vec2 uPlayer;
            uniform float uRadius;
            varying vec2 vUv;
            varying vec2 vWorld;
            void main() {
              // Walkable = LOW alpha in the mask (buildings are opaque).
              float a = texture2D(uMask, vUv).a;
              if (a >= uThreshold) discard;

              // Soft halo: full strength at the player, gone by uRadius.
              float dist = distance(vWorld, uPlayer);
              float falloff = 1.0 - smoothstep(uRadius * 0.55, uRadius, dist);
              float alpha = uMaxAlpha * falloff * uOpacity;
              if (alpha <= 0.002) discard;
              gl_FragColor = vec4(uColor, alpha);
            }
          `,
          transparent: true,
          depthWrite: false,
        });

        const geometry = new THREE.PlaneGeometry(TILE_W, TILE_H);
        const mesh = new THREE.Mesh(geometry, material);
        const centerX = col * TILE_W + TILE_W / 2;
        const centerY = row * TILE_H + TILE_H / 2;
        mesh.position.set(centerX, -centerY, 0);

        this.tiles.set(key, { mesh, texture, material });
        this.group.add(mesh);
      },
      undefined,
      () => {
        this.loading.delete(key);
        console.warn(`Failed to load guide mask tile ${key} (${url})`);
      }
    );
  }

  private unloadTile(key: string): void {
    const tile = this.tiles.get(key);
    if (!tile) return;
    this.group.remove(tile.mesh);
    tile.mesh.geometry.dispose();
    tile.material.dispose();
    tile.texture.dispose();
    this.tiles.delete(key);
  }

  private unloadAll(): void {
    for (const key of [...this.tiles.keys()]) this.unloadTile(key);
  }

  /** Stream the mask tiles around the player; unload ones outside the halo. */
  private streamTiles(px: number, py: number): void {
    const want = this.tilesAround(px, py, GUIDE.RADIUS);
    const wantKeys = new Set(want.map((t) => this.key(t.col, t.row)));
    for (const t of want) this.loadTile(t.col, t.row);
    for (const key of [...this.tiles.keys()]) {
      if (!wantKeys.has(key)) this.unloadTile(key);
    }
  }

  /**
   * Drive the guide each frame. `hitWall` is true on any wall contact this step,
   * which (re)arms the hold timer; the glow eases in while held and eases out
   * once the timer lapses. Tiles are only kept loaded while it's visible.
   */
  update(px: number, py: number, dt: number, hitWall: boolean): void {
    if (hitWall) this.hold = GUIDE.HOLD;
    else this.hold = Math.max(0, this.hold - dt);

    // Ease toward 1 while held, toward 0 otherwise.
    const target = this.hold > 0 ? 1 : 0;
    const rate = target > this.opacity ? dt / GUIDE.FADE_IN : dt / GUIDE.FADE_OUT;
    if (target > this.opacity) this.opacity = Math.min(target, this.opacity + rate);
    else this.opacity = Math.max(target, this.opacity - rate);

    if (this.opacity <= 0 && target === 0) {
      // Fully faded and not re-triggered: drop the GPU resources.
      if (this.tiles.size > 0) this.unloadAll();
      this.group.visible = false;
      return;
    }

    this.group.visible = true;
    this.shared.uOpacity.value = this.opacity;
    this.shared.uPlayer.value.set(px, -py); // scene space matches the meshes
    this.streamTiles(px, py);
  }

  dispose(): void {
    this.unloadAll();
  }
}
