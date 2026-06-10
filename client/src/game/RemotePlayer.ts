import * as THREE from 'three';
import { SPRITE } from '../config';
import { playerAtlas } from './sprites/SpriteAtlas';
import { CharacterSprite, srgbTint } from './sprites/CharacterSprite';
import { isAnonSpec } from './sprites/drawSprite';

const REMOTE_Z = 1;
const LERP_SPEED = 10; // Higher = snappier.
const MOVE_EPS = 4; // world units/sec below which a remote is "idle" (stand frame)

/** Another player: an animated mascot interpolated toward server positions. */
export class RemotePlayer {
  readonly sprite: CharacterSprite;
  private targetX: number;
  private targetY: number;
  private displayX: number;
  private displayY: number;
  private readonly anon: boolean;

  constructor(
    x: number,
    y: number,
    color: string,
    characterId?: string,
    height: number = SPRITE.PLAYER_HEIGHT
  ) {
    this.targetX = x;
    this.targetY = y;
    this.displayX = x;
    this.displayY = y;
    this.anon = isAnonSpec(characterId);
    const tint = this.anon ? srgbTint(color) : undefined;
    this.sprite = new CharacterSprite(playerAtlas(characterId), height, REMOTE_Z, SPRITE.ANCHOR_Y, tint);
    this.sprite.mesh.position.set(x, -y, REMOTE_Z);
  }

  get mesh(): THREE.Object3D {
    return this.sprite.mesh;
  }

  setTarget(x: number, y: number): void {
    this.targetX = x;
    this.targetY = y;
  }

  setColor(color: string): void {
    if (this.anon) this.sprite.setTint(srgbTint(color));
  }

  /** Exponential interpolation toward the latest server target; drives the walk. */
  interpolate(dt: number): void {
    const t = 1 - Math.exp(-LERP_SPEED * dt);
    const nx = this.displayX + (this.targetX - this.displayX) * t;
    const ny = this.displayY + (this.targetY - this.displayY) * t;
    const dx = nx - this.displayX;
    const dy = ny - this.displayY;
    this.displayX = nx;
    this.displayY = ny;
    this.sprite.mesh.position.set(nx, -ny, REMOTE_Z);

    const speed = Math.hypot(dx, dy) / Math.max(dt, 1e-4);
    const facing = dx > 0.05 ? true : dx < -0.05 ? false : undefined;
    this.sprite.animate(dt, speed > MOVE_EPS, facing);
  }

  dispose(): void {
    this.sprite.dispose();
  }
}
