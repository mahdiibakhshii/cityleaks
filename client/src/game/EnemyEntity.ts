import * as THREE from 'three';
import { ENEMY, SPRITE } from '../config';
import { ghostAtlas } from './sprites/SpriteAtlas';
import { GHOST_SCREAM_FRAME } from './sprites/drawSprite';
import { CharacterSprite, srgbTint } from './sprites/CharacterSprite';

const MOVE_EPS = 4; // world units/sec below which a ghost is "idle"

/**
 * A server-driven enemy NPC: an animated ghost interpolated toward the latest
 * server position. It tells the whole hunt story visually:
 *  - body color lerps from its healthy tint → ENEMY.DYING_COLOR as `life` drains,
 *  - it jitters + speeds up its walk as `panic` rises (the "press now" telegraph),
 *  - on death it freezes into the SCREAM frame and shakes hard (then the manager
 *    pops the explosion and removes it).
 */
export class EnemyEntity {
  readonly sprite: CharacterSprite;
  readonly color: string;
  private targetX: number;
  private targetY: number;
  private displayX: number;
  private displayY: number;
  private life: number; // smoothed (drives the tint)
  private targetLife: number;
  private panic = 0; // smoothed (drives shake + walk speed)
  private targetPanic = 0;
  private dying = false;
  private readonly healthyTint: THREE.Color;
  private readonly dyingTint: THREE.Color;
  private readonly tmpTint = new THREE.Color();

  constructor(x: number, y: number, color: string, _kind: string, life = 1) {
    this.color = color;
    this.targetX = x;
    this.targetY = y;
    this.displayX = x;
    this.displayY = y;
    this.life = life;
    this.targetLife = life;
    this.healthyTint = srgbTint(color);
    this.dyingTint = srgbTint(ENEMY.DYING_COLOR);
    this.sprite = new CharacterSprite(
      ghostAtlas(),
      SPRITE.ENEMY_HEIGHT,
      ENEMY.Z,
      SPRITE.GHOST_ANCHOR_Y,
      this.healthyTint.clone()
    );
    this.sprite.mesh.position.set(x, -y, ENEMY.Z);
    this.applyTint();
  }

  get mesh(): THREE.Object3D {
    return this.sprite.mesh;
  }

  get worldX(): number {
    return this.displayX;
  }

  get worldY(): number {
    return this.displayY;
  }

  setTarget(x: number, y: number, life: number, panic: number): void {
    this.targetX = x;
    this.targetY = y;
    this.targetLife = life;
    this.targetPanic = panic;
  }

  /** Begin the death sequence: lock into the scream frame and flush to "dying". */
  startDeath(): void {
    this.dying = true;
    this.targetPanic = 1;
    this.targetLife = 0;
    this.sprite.setFrameOverride(GHOST_SCREAM_FRAME);
  }

  /** Lerp body tint from healthy color → dying color as life drops to 0. */
  private applyTint(): void {
    this.tmpTint.copy(this.healthyTint).lerp(this.dyingTint, 1 - this.life);
    this.sprite.setTint(this.tmpTint);
  }

  /** Exponential interpolation toward the latest server target (+ telegraph). */
  interpolate(dt: number): void {
    this.life += (this.targetLife - this.life) * Math.min(1, dt * 6);
    this.panic += (this.targetPanic - this.panic) * Math.min(1, dt * 8);
    this.applyTint();

    let dx = 0;
    let dy = 0;
    if (!this.dying) {
      const t = 1 - Math.exp(-ENEMY.LERP * dt);
      const nx = this.displayX + (this.targetX - this.displayX) * t;
      const ny = this.displayY + (this.targetY - this.displayY) * t;
      dx = nx - this.displayX;
      dy = ny - this.displayY;
      this.displayX = nx;
      this.displayY = ny;
    }

    // Jitter the body: grows with panic, and is strong while dying ("buzzing").
    const amp = (this.dying ? 1 : this.panic) * ENEMY.PANIC_SHAKE;
    const sx = amp ? (Math.random() * 2 - 1) * amp : 0;
    const sy = amp ? (Math.random() * 2 - 1) * amp * 0.6 : 0;
    this.sprite.mesh.position.set(this.displayX + sx, -this.displayY + sy, ENEMY.Z);

    if (this.dying) {
      this.sprite.animate(dt, false); // frame override holds the scream face
      return;
    }
    const speed = Math.hypot(dx, dy) / Math.max(dt, 1e-4);
    const facing = dx > 0.05 ? true : dx < -0.05 ? false : undefined;
    // Panic speeds up the walk cycle by feeding the animator a scaled dt.
    const boostedDt = dt * (1 + this.panic * ENEMY.PANIC_FPS_BOOST);
    this.sprite.animate(boostedDt, speed > MOVE_EPS, facing);
  }

  dispose(): void {
    this.sprite.dispose();
  }
}
