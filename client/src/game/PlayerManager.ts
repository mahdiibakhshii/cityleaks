import * as THREE from 'three';
import { type PlayerState, type PlayerPos } from '../../../shared/protocol';
import { RemotePlayer } from './RemotePlayer';

/**
 * Manages all remote player instances. The local player is excluded by id so
 * it isn't drawn twice.
 */
export class PlayerManager {
  readonly group: THREE.Group;
  private players: Map<string, RemotePlayer> = new Map();
  private localId: string | null = null;

  constructor() {
    this.group = new THREE.Group();
    this.group.position.z = 1;
  }

  setLocalId(id: string): void {
    this.localId = id;
    // If the local id was created as a remote (e.g. from player:existing), drop it.
    this.removePlayer(id);
  }

  addPlayer(id: string, x: number, y: number, color: string, character?: string): void {
    if (id === this.localId || this.players.has(id)) return;
    const rp = new RemotePlayer(x, y, color, character);
    this.players.set(id, rp);
    this.group.add(rp.mesh);
  }

  removePlayer(id: string): void {
    const rp = this.players.get(id);
    if (!rp) return;
    this.group.remove(rp.mesh);
    rp.dispose();
    this.players.delete(id);
  }

  /** Replace the full set of remote players (used on (re)connect). */
  reset(states: PlayerState[]): void {
    for (const id of [...this.players.keys()]) this.removePlayer(id);
    for (const s of states) this.addPlayer(s.id, s.x, s.y, s.color, s.character);
  }

  /** Update interpolation targets from a server tick broadcast (positions only). */
  updateFromServer(positions: PlayerPos[]): void {
    for (const pos of positions) {
      if (pos.id === this.localId) continue;
      this.players.get(pos.id)?.setTarget(pos.x, pos.y);
      // Unknown ids are ignored here — player:join / player:existing carry color+shape.
    }
  }

  interpolateAll(dt: number): void {
    for (const rp of this.players.values()) rp.interpolate(dt);
  }

  get count(): number {
    return this.players.size;
  }
}
