import * as THREE from 'three';
import { type EnemyState, type EnemyPos, type EnemyDie } from '../../../shared/protocol';
import { ENEMY } from '../config';
import { EnemyEntity } from './EnemyEntity';
import { ExplosionBurst } from './EnemyDeathFx';
import { Sfx } from './audio/Sfx';

const FALLBACK_COLOR = '#ff2d6f'; // burst color if a death arrives for an unknown enemy

/**
 * Manages all enemy NPC instances on the client. Mirrors PlayerManager: a full
 * set arrives on connect (enemy:existing), spawns/despawns stream in
 * (enemy:join / enemy:leave), positions + condition update every tick
 * (enemy:update), and KILLS (enemy:die) trigger the scream→explosion sequence.
 */
export class EnemyManager {
  readonly group: THREE.Group;
  private enemies: Map<string, EnemyEntity> = new Map();
  // Enemies mid-death: shaking + screaming until SCREAM_TIME, then they pop.
  private dying: Map<string, { entity: EnemyEntity; t: number }> = new Map();
  private bursts: ExplosionBurst[] = [];
  private readonly sfx = new Sfx();

  constructor() {
    this.group = new THREE.Group();
    this.group.position.z = 1;
  }

  addEnemy(id: string, x: number, y: number, color: string, kind: string, life = 1): void {
    if (this.enemies.has(id)) return;
    const e = new EnemyEntity(x, y, color, kind, life);
    this.enemies.set(id, e);
    this.group.add(e.mesh);
  }

  removeEnemy(id: string): void {
    const e = this.enemies.get(id);
    if (!e) return;
    this.group.remove(e.mesh);
    e.dispose();
    this.enemies.delete(id);
  }

  /** Replace the full set of enemies (used on (re)connect). Clears any FX. */
  reset(states: EnemyState[]): void {
    for (const id of [...this.enemies.keys()]) this.removeEnemy(id);
    for (const [, d] of this.dying) {
      this.group.remove(d.entity.mesh);
      d.entity.dispose();
    }
    this.dying.clear();
    for (const b of this.bursts) {
      this.group.remove(b.group);
      b.dispose();
    }
    this.bursts = [];
    for (const s of states) this.addEnemy(s.id, s.x, s.y, s.color, s.kind, s.life);
  }

  /** Update interpolation targets + condition from a server tick broadcast. */
  updateFromServer(positions: EnemyPos[]): void {
    for (const pos of positions) {
      this.enemies.get(pos.id)?.setTarget(pos.x, pos.y, pos.life, pos.panic);
      // Unknown ids are ignored — enemy:join / enemy:existing carry color + kind.
    }
  }

  /** An enemy was hunted down: scream + shake now, explode after SCREAM_TIME. */
  killEnemy(death: EnemyDie): void {
    this.sfx.playScream();
    const e = this.enemies.get(death.id);
    if (!e) {
      // Already gone (raced with a despawn) — still pop a burst at the spot.
      this.spawnBurst(death.x, death.y, FALLBACK_COLOR);
      this.sfx.playExplosion();
      return;
    }
    this.enemies.delete(death.id);
    e.startDeath();
    this.dying.set(death.id, { entity: e, t: 0 });
  }

  interpolateAll(dt: number): void {
    for (const e of this.enemies.values()) e.interpolate(dt);

    // Advance dying enemies; when the scream finishes, pop the explosion.
    for (const [id, d] of this.dying) {
      d.t += dt;
      d.entity.interpolate(dt);
      if (d.t >= ENEMY.SCREAM_TIME) {
        this.spawnBurst(d.entity.worldX, d.entity.worldY, d.entity.color);
        this.sfx.playExplosion();
        this.group.remove(d.entity.mesh);
        d.entity.dispose();
        this.dying.delete(id);
      }
    }

    // Advance + retire explosion bursts.
    if (this.bursts.length) {
      for (const b of this.bursts) b.update(dt);
      this.bursts = this.bursts.filter((b) => {
        if (b.finished) {
          this.group.remove(b.group);
          b.dispose();
          return false;
        }
        return true;
      });
    }
  }

  private spawnBurst(x: number, y: number, color: string): void {
    const b = new ExplosionBurst(x, y, color);
    this.bursts.push(b);
    this.group.add(b.group);
  }

  get count(): number {
    return this.enemies.size;
  }
}
