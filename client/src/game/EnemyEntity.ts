import * as THREE from 'three';
import { ENEMY, SPRITE } from '../config';
import { enemyAtlas } from './sprites/SpriteAtlas';
import { CharacterSprite } from './sprites/CharacterSprite';

const MOVE_EPS = 4; // world units/sec below which a ghost is "idle"

/**
 * A server-driven enemy NPC: an animated Pac-Man-style ghost interpolated toward
 * the latest server position. Its own class so enemy visuals can diverge from
 * players freely.
 */
export class EnemyEntity {
  readonly sprite: CharacterSprite;
  private targetX: number;
  private targetY: number;
  private displayX: number;
  private displayY: number;

  constructor(x: number, y: number, color: string, _kind: string) {
    this.targetX = x;
    this.targetY = y;
    this.displayX = x;
    this.displayY = y;
    this.sprite = new CharacterSprite(enemyAtlas(color), SPRITE.ENEMY_HEIGHT, ENEMY.Z, SPRITE.GHOST_ANCHOR_Y);
    this.sprite.mesh.position.set(x, -y, ENEMY.Z);
  }

  get mesh(): THREE.Object3D {
    return this.sprite.mesh;
  }

  setTarget(x: number, y: number): void {
    this.targetX = x;
    this.targetY = y;
  }

  /** Exponential interpolation toward the latest server target. */
  interpolate(dt: number): void {
    const t = 1 - Math.exp(-ENEMY.LERP * dt);
    const nx = this.displayX + (this.targetX - this.displayX) * t;
    const ny = this.displayY + (this.targetY - this.displayY) * t;
    const dx = nx - this.displayX;
    const dy = ny - this.displayY;
    this.displayX = nx;
    this.displayY = ny;
    this.sprite.mesh.position.set(nx, -ny, ENEMY.Z);

    const speed = Math.hypot(dx, dy) / Math.max(dt, 1e-4);
    const facing = dx > 0.05 ? true : dx < -0.05 ? false : undefined;
    this.sprite.animate(dt, speed > MOVE_EPS, facing);
  }

  dispose(): void {
    this.sprite.dispose();
  }
}
