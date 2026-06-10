import * as THREE from 'three';
import { GRID_SIZE, MAP_BOUNDS } from '../../../shared/protocol';
import { PATH } from '../config';

export interface PathLayerOptions {
  /**
   * Pixel-art water look: chunky 1-cell pixels (NearestFilter), banded-blue
   * palette, animated foam rim + shimmer. The in-game default.
   *
   * Set false for the monitor's zoomed-out whole-city view, where a 1000²
   * grid shrinks below 1px/cell and the pixel/foam detail would just alias —
   * there we keep a smooth flat trail (LinearFilter) like the original.
   */
  pixelated?: boolean;
}

/**
 * Renders the shared, persistent "leak" grid as pixel-art leaking water.
 *
 * The server keeps a 1000×1000 grid of every cell ANY player has ever visited
 * (anonymous, saved to disk). It sends the whole grid bit-packed on connect and
 * a small delta of newly-marked cells each tick. We unpack that into a
 * single-channel DataTexture drawn as ONE quad covering the whole map, between
 * the photo tiles (z=0) and the players (z=1).
 *
 * The fragment shader turns each visited cell into a chunky water pixel: a
 * per-cell hash picks a band from the DEEP→MID→LIGHT palette, a slow time
 * wobble gives a calm shimmer (plus a rare twinkle), and 4-neighbour sampling
 * detects trail edges to paint a bright animated FOAM rim. It stays cheap for
 * mobile — one quad, empty fragments discard after a single tap, and only the
 * trail itself does the 4 extra neighbour taps + a couple of sin()s.
 *
 * Coordinates: texel index == server cell index == cellY*GRID_SIZE + cellX. The
 * quad sits in scene space with three_y = -data_y like everything else; the
 * fragment shader flips V to match the +Y-down data grid.
 */
export class PathLayer {
  readonly mesh: THREE.Mesh;
  private data: Uint8Array<ArrayBuffer>;
  private texture: THREE.DataTexture;
  private material: THREE.ShaderMaterial;

  constructor(opts: PathLayerOptions = {}) {
    const pixelated = opts.pixelated ?? true;

    this.data = new Uint8Array(new ArrayBuffer(GRID_SIZE * GRID_SIZE));
    this.texture = new THREE.DataTexture(
      this.data,
      GRID_SIZE,
      GRID_SIZE,
      THREE.RedFormat,
      THREE.UnsignedByteType
    );
    // Pixel-art needs crisp square cells; the smooth overview keeps blending.
    const filter = pixelated ? THREE.NearestFilter : THREE.LinearFilter;
    this.texture.minFilter = filter;
    this.texture.magFilter = filter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uGrid: { value: this.texture },
        uTexel: { value: new THREE.Vector2(1 / GRID_SIZE, 1 / GRID_SIZE) },
        uTime: { value: 0 },
        uIntensity: { value: PATH.INTENSITY },
        uPixelated: { value: pixelated ? 1 : 0 },
        uShimmer: { value: PATH.SHIMMER },
        uFoamBoost: { value: PATH.FOAM_ALPHA_BOOST },
        uDeep: { value: new THREE.Color(PATH.DEEP) },
        uMid: { value: new THREE.Color(PATH.MID) },
        uLight: { value: new THREE.Color(PATH.LIGHT) },
        uFoam: { value: new THREE.Color(PATH.FOAM) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uGrid;
        uniform vec2 uTexel;
        uniform float uTime;
        uniform float uIntensity;
        uniform float uPixelated;
        uniform float uShimmer;
        uniform float uFoamBoost;
        uniform vec3 uDeep;
        uniform vec3 uMid;
        uniform vec3 uLight;
        uniform vec3 uFoam;
        varying vec2 vUv;

        // Cheap per-cell hash — no texture, no trig.
        float hash(vec2 p) {
          p = fract(p * vec2(123.34, 345.45));
          p += dot(p, p + 34.345);
          return fract(p.x * p.y);
        }

        void main() {
          // Data grid is +Y down; plane V is +Y up — flip V to match.
          vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
          float c = texture2D(uGrid, uv).r;
          if (c <= 0.0) discard; // Empty cells cost just this one tap.

          // Smooth overview path (monitor): flat blue, no pixel detail.
          if (uPixelated < 0.5) {
            gl_FragColor = vec4(uMid, c * uIntensity);
            return;
          }

          // Integer cell coordinate drives all per-cell variation.
          vec2 cell = floor(uv / uTexel);
          float n = hash(cell);

          // Calm shimmer: slow per-cell brightness wobble (0..1), plus a rare
          // twinkle that pops a cell brighter for a moment.
          float shimmer = sin(uTime * 0.8 + n * 6.2831) * 0.5 + 0.5;
          float twinkle = step(0.93, hash(cell + floor(uTime * 0.6))) * 0.35;

          // Banded palette: hash picks the base band, shimmer nudges it.
          float t = clamp(n * 0.7 + shimmer * uShimmer, 0.0, 1.0);
          vec3 col = mix(uDeep, uMid, smoothstep(0.0, 0.55, t));
          col = mix(col, uLight, smoothstep(0.55, 1.0, t));
          col += twinkle;

          // Foam rim: a cell is an edge if any 4-neighbour is empty water.
          float up    = texture2D(uGrid, uv + vec2(0.0, uTexel.y)).r;
          float down  = texture2D(uGrid, uv - vec2(0.0, uTexel.y)).r;
          float left  = texture2D(uGrid, uv - vec2(uTexel.x, 0.0)).r;
          float right = texture2D(uGrid, uv + vec2(uTexel.x, 0.0)).r;
          float edge = step(up * down * left * right, 0.0); // any neighbour empty

          float foamPulse = sin(uTime * 1.6 + n * 6.2831) * 0.5 + 0.5;
          col = mix(col, uFoam, edge * (0.55 + 0.45 * foamPulse));

          float alpha = uIntensity + edge * uFoamBoost;
          gl_FragColor = vec4(col, min(alpha, 1.0));
        }
      `,
      transparent: true,
      depthWrite: false,
    });

    const geometry = new THREE.PlaneGeometry(MAP_BOUNDS.width, MAP_BOUNDS.height);
    this.mesh = new THREE.Mesh(geometry, this.material);
    const centerX = MAP_BOUNDS.minX + MAP_BOUNDS.width / 2;
    const centerY = MAP_BOUNDS.minY + MAP_BOUNDS.height / 2;
    this.mesh.position.set(centerX, -centerY, PATH.Z);
  }

  /** Advance the water animation clock. Call once per frame with delta seconds. */
  update(dt: number): void {
    this.material.uniforms.uTime.value += dt;
  }

  /** Replace the whole grid from the bit-packed buffer sent on connect. */
  applyFull(buffer: ArrayBuffer | Uint8Array): void {
    const packed = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const n = GRID_SIZE * GRID_SIZE;
    for (let i = 0; i < n; i++) {
      this.data[i] = packed[i >> 3] & (1 << (i & 7)) ? 255 : 0;
    }
    this.texture.needsUpdate = true;
  }

  /** Mark newly-visited cells (flat indices) from a server delta. */
  applyDelta(cells: number[]): void {
    let changed = false;
    for (const index of cells) {
      if (index >= 0 && index < this.data.length && this.data[index] !== 255) {
        this.data[index] = 255;
        changed = true;
      }
    }
    if (changed) this.texture.needsUpdate = true;
  }

  /**
   * Optimistically mark the cell under a world position so the LOCAL player's
   * trail appears instantly (the server delta confirms the same cell shortly
   * after). Uses the same math as the server's worldToCell().
   */
  markWorld(worldX: number, worldY: number): void {
    const cellX = Math.floor(((worldX - MAP_BOUNDS.minX) / MAP_BOUNDS.width) * GRID_SIZE);
    const cellY = Math.floor(((worldY - MAP_BOUNDS.minY) / MAP_BOUNDS.height) * GRID_SIZE);
    if (cellX < 0 || cellX >= GRID_SIZE || cellY < 0 || cellY >= GRID_SIZE) return;
    const index = cellY * GRID_SIZE + cellX;
    if (this.data[index] !== 255) {
      this.data[index] = 255;
      this.texture.needsUpdate = true;
    }
  }
}
