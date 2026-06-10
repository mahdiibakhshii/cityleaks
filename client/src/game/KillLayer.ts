import * as THREE from 'three';
import type { KillMarker } from '../../../shared/protocol';
import { KILL } from '../config';

/**
 * Renders the persistent "an enemy died here" tombstone icons in world space —
 * the city's accumulating hunt history. A near-twin of NoteLayer but simpler:
 * markers are ownerless, never revealed/hidden, and only mark a spot. Each is a
 * camera-facing sprite sharing one procedurally-drawn tombstone texture (no
 * asset files). Sits at z=KILL.Z (above paths, below the note icons + players).
 */
/** Marker glyph: a tombstone (in-game) or a bold X (the monitor's kill spot). */
export type KillMarkerStyle = 'tombstone' | 'x';

export class KillLayer {
  readonly group = new THREE.Group();
  private readonly texture: THREE.Texture;
  private readonly material: THREE.SpriteMaterial;
  private readonly markers = new Map<string, THREE.Sprite>();
  private readonly iconSize: number;

  /** iconSize is in WORLD units; the monitor passes a larger value for its
   *  zoomed-out whole-map view. `style` picks the glyph — the in-game default is
   *  a tombstone; the monitor uses an 'x' to mark where a kill happened. */
  constructor(iconSize: number = KILL.ICON_SIZE, style: KillMarkerStyle = 'tombstone') {
    this.iconSize = iconSize;
    this.texture = style === 'x' ? makeXTexture() : makeTombstoneTexture();
    this.material = new THREE.SpriteMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
    });
  }

  /** Replace all markers (e.g. the KILL_EXISTING snapshot on connect). */
  setMarkers(markers: KillMarker[]): void {
    for (const sprite of this.markers.values()) this.group.remove(sprite);
    this.markers.clear();
    for (const m of markers) this.addMarker(m);
  }

  /** Add a single marker (from KILL_NEW). */
  addMarker(m: KillMarker): void {
    if (this.markers.has(m.id)) return;
    const sprite = new THREE.Sprite(this.material);
    sprite.scale.set(this.iconSize, this.iconSize, 1);
    // Scene space stores three_y = -data_y like everything else.
    sprite.position.set(m.x, -m.y, KILL.Z);
    this.group.add(sprite);
    this.markers.set(m.id, sprite);
  }
}

/**
 * Draw a little tombstone (rounded-top stone + cross + base) onto a canvas →
 * CanvasTexture, outlined so it reads over any map background.
 */
function makeTombstoneTexture(): THREE.CanvasTexture {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;

  ctx.lineJoin = 'round';
  ctx.lineWidth = 6;
  ctx.strokeStyle = KILL.OUTLINE;

  // Base / ground slab.
  ctx.fillStyle = KILL.STONE_DARK;
  roundRect(ctx, 30, 96, 68, 16, 5);
  ctx.fill();
  ctx.stroke();

  // Stone body: a rectangle with a rounded (arched) top.
  ctx.fillStyle = KILL.STONE;
  ctx.beginPath();
  ctx.moveTo(40, 100);
  ctx.lineTo(40, 56);
  ctx.arc(64, 56, 24, Math.PI, 0); // arched top
  ctx.lineTo(88, 100);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Engraved cross.
  ctx.fillStyle = KILL.STONE_DARK;
  ctx.fillRect(59, 44, 10, 40); // vertical
  ctx.fillRect(48, 56, 32, 10); // horizontal

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Draw a bold X (a red "kill happened here" cross) onto a canvas → CanvasTexture,
 * with a dark outline so it reads over the map overview. Used by the monitor.
 */
function makeXTexture(): THREE.CanvasTexture {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;

  const m = 30; // margin from the edges
  ctx.lineCap = 'round';

  // Dark outline stroke first (slightly thicker), then the red X on top.
  const strokeX = (width: number, color: string) => {
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(m, m);
    ctx.lineTo(S - m, S - m);
    ctx.moveTo(S - m, m);
    ctx.lineTo(m, S - m);
    ctx.stroke();
  };
  strokeX(26, 'rgba(0,0,0,0.7)');
  strokeX(16, '#ff3b5c');

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Path a rounded rectangle (no fill/stroke — caller does that). */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
