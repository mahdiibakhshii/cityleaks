import * as THREE from 'three';
import { type EnemyState, type EnemyPos } from '../../../shared/protocol';
import { EnemyEntity } from './EnemyEntity';

/**
 * Manages all enemy NPC instances on the client. Mirrors PlayerManager: a full
 * set arrives on connect (enemy:existing), spawns/despawns stream in
 * (enemy:join / enemy:leave), and positions update every tick (enemy:update).
 */
export class EnemyManager {
  readonly group: THREE.Group;
  private enemies: Map<string, EnemyEntity> = new Map();

  constructor() {
    this.group = new THREE.Group();
    this.group.position.z = 1;
  }

  addEnemy(id: string, x: number, y: number, color: string, kind: string): void {
    if (this.enemies.has(id)) return;
    const e = new EnemyEntity(x, y, color, kind);
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

  /** Replace the full set of enemies (used on (re)connect). */
  reset(states: EnemyState[]): void {
    for (const id of [...this.enemies.keys()]) this.removeEnemy(id);
    for (const s of states) this.addEnemy(s.id, s.x, s.y, s.color, s.kind);
  }

  /** Update interpolation targets from a server tick broadcast (positions only). */
  updateFromServer(positions: EnemyPos[]): void {
    for (const pos of positions) {
      this.enemies.get(pos.id)?.setTarget(pos.x, pos.y);
      // Unknown ids are ignored — enemy:join / enemy:existing carry color + kind.
    }
  }

  interpolateAll(dt: number): void {
    for (const e of this.enemies.values()) e.interpolate(dt);
  }

  get count(): number {
    return this.enemies.size;
  }
}
