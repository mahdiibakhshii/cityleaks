import {
  ENEMY_PER_PLAYERS,
  ENEMY_MIN,
  ENEMY_MAX,
  ENEMY_RADIUS,
  ENEMY_SPEED,
  ENEMY_TYPES,
  enemyDef,
  type EnemyState,
  type EnemyPos,
} from '../../shared/protocol';
import { MAP_BOUNDS, SPAWN } from './config';
import type { CollisionField } from './CollisionField';

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

interface Enemy {
  id: string;
  x: number;
  y: number;
  kind: string;
  color: string;
  hx: number; // current heading (unit vector)
  hy: number;
  spin: 1 | -1; // orbit direction in the comfort band (per-enemy variety)
}

type Point = { x: number; y: number };

// Context-steering parameters.
const STEER_SAMPLES = 12; // candidate directions tested per enemy per tick
const LOOKAHEAD = 80; // world units of clearance probed per direction

/**
 * Spawns and drives the wandering enemy NPCs (server-authoritative). Each enemy
 * keeps a comfortable distance from the nearest player — fleeing when crowded,
 * drifting back when abandoned, orbiting/wandering in between — and steers
 * toward open streets (via CollisionField) so it stays on roads and is hard to
 * corner. The population scales with the live player count.
 *
 * `update()` returns the per-tick spawn/despawn deltas so GameServer can
 * broadcast ENEMY_JOIN / ENEMY_LEAVE; positions go out every tick via
 * getPositions() → ENEMY_UPDATE. See shared/protocol.ts ENEMY_TYPES to add kinds.
 */
export class EnemyManager {
  private enemies: Map<string, Enemy> = new Map();
  private collision: CollisionField;
  private nextId = 1;

  constructor(collision: CollisionField) {
    this.collision = collision;
  }

  get count(): number {
    return this.enemies.size;
  }

  getStates(): EnemyState[] {
    return Array.from(this.enemies.values(), (e) => ({
      id: e.id,
      x: e.x,
      y: e.y,
      color: e.color,
      kind: e.kind,
    }));
  }

  getPositions(): EnemyPos[] {
    return Array.from(this.enemies.values(), (e) => ({ id: e.id, x: e.x, y: e.y }));
  }

  /**
   * Advance all enemies one tick and reconcile the population toward the target
   * for the current player count. Returns the spawn/despawn deltas this tick.
   */
  update(players: Point[], dt: number): { spawned: EnemyState[]; despawned: string[] } {
    const spawned: EnemyState[] = [];
    const despawned: string[] = [];

    // 1. Reconcile population (at most one change per tick → gentle churn).
    const target = this.targetCount(players.length);
    if (this.enemies.size < target) {
      const e = this.spawn(players);
      if (e) spawned.push({ id: e.id, x: e.x, y: e.y, color: e.color, kind: e.kind });
    } else if (this.enemies.size > target) {
      const id = this.pickDespawn(players);
      if (id) {
        this.enemies.delete(id);
        despawned.push(id);
      }
    }

    // 2. Steer each enemy.
    for (const e of this.enemies.values()) this.steer(e, players, dt);

    return { spawned, despawned };
  }

  /** Desired enemy count for a player count (0 while the collision field isn't ready). */
  private targetCount(playerCount: number): number {
    if (!this.collision.ready || playerCount === 0) return 0;
    return clamp(Math.ceil(playerCount / ENEMY_PER_PLAYERS), ENEMY_MIN, ENEMY_MAX);
  }

  private spawn(players: Point[]): Enemy | null {
    const def = ENEMY_TYPES[Math.floor(Math.random() * ENEMY_TYPES.length)];
    // Place near a random player, at a comfortable (not-too-close) distance.
    const anchor = players.length ? players[Math.floor(Math.random() * players.length)] : SPAWN;
    const angle = Math.random() * Math.PI * 2;
    const dist = def.fleeRadius + Math.random() * (def.leashRadius - def.fleeRadius) * 0.5;
    const pref = { x: anchor.x + Math.cos(angle) * dist, y: anchor.y + Math.sin(angle) * dist };
    const spot =
      this.collision.findNearestWalkable(pref.x, pref.y, ENEMY_RADIUS) ??
      this.collision.findNearestWalkable(SPAWN.x, SPAWN.y, ENEMY_RADIUS);
    if (!spot) return null; // No walkable ground found (collision field empty?).

    const heading = Math.random() * Math.PI * 2;
    const enemy: Enemy = {
      id: `enemy_${this.nextId++}`,
      x: spot.x,
      y: spot.y,
      kind: def.kind,
      color: def.color,
      hx: Math.cos(heading),
      hy: Math.sin(heading),
      spin: Math.random() < 0.5 ? 1 : -1,
    };
    this.enemies.set(enemy.id, enemy);
    return enemy;
  }

  /** Choose which enemy to remove when over target: the one farthest from all players. */
  private pickDespawn(players: Point[]): string | null {
    let worstId: string | null = null;
    let worstDist = -1;
    for (const e of this.enemies.values()) {
      const d = players.length ? Math.sqrt(this.nearest(e, players).d2) : 0;
      if (d > worstDist) {
        worstDist = d;
        worstId = e.id;
      }
    }
    return worstId;
  }

  private nearest(e: Enemy, players: Point[]): { p: Point | null; d2: number } {
    let p: Point | null = null;
    let d2 = Infinity;
    for (const q of players) {
      const dx = q.x - e.x;
      const dy = q.y - e.y;
      const sq = dx * dx + dy * dy;
      if (sq < d2) {
        d2 = sq;
        p = q;
      }
    }
    return { p, d2 };
  }

  /** Pick a heading via context steering and move the enemy one tick. */
  private steer(e: Enemy, players: Point[], dt: number): void {
    const def = enemyDef(e.kind);
    const { p, d2 } = this.nearest(e, players);

    // Desired direction + how strongly to honor it, by distance band.
    let desX = e.hx;
    let desY = e.hy;
    let desiredWeight = 0.4;
    let speedScale = 0.6; // idle wander is slower
    if (p) {
      const d = Math.sqrt(d2) || 0.0001;
      const awayX = (e.x - p.x) / d; // unit vector player → enemy
      const awayY = (e.y - p.y) / d;
      if (d < def.fleeRadius) {
        // Too close → flee directly away (ramp up as the player closes in).
        desX = awayX;
        desY = awayY;
        desiredWeight = 1.6;
        speedScale = 1;
      } else if (d > def.leashRadius) {
        // Too far → drift back toward the player.
        desX = -awayX;
        desY = -awayY;
        desiredWeight = 1.1;
        speedScale = 0.9;
      } else {
        // Comfort band → orbit tangentially with a little wander.
        desX = -awayY * e.spin;
        desY = awayX * e.spin;
        desiredWeight = 0.6;
        speedScale = 0.75;
      }
    }

    // Score candidate directions: openness (anti-trap) + desired + momentum + noise.
    let bestDx = e.hx;
    let bestDy = e.hy;
    let bestScore = -Infinity;
    const noise = def.wanderiness * 0.6;
    for (let i = 0; i < STEER_SAMPLES; i++) {
      const a = (i / STEER_SAMPLES) * Math.PI * 2;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const clr = this.collision.clearance(e.x, e.y, dx, dy, LOOKAHEAD);
      if (clr <= 0) continue; // immediately blocked
      const score =
        0.9 * (clr / LOOKAHEAD) +
        desiredWeight * (dx * desX + dy * desY) +
        0.7 * (dx * e.hx + dy * e.hy) +
        noise * (Math.random() - 0.5);
      if (score > bestScore) {
        bestScore = score;
        bestDx = dx;
        bestDy = dy;
      }
    }

    // Move with wall-sliding, clamp to bounds, and update the heading from the
    // ACTUAL displacement so momentum reflects real movement (not the intent).
    const speed = ENEMY_SPEED * def.speedMultiplier * speedScale;
    const moved = this.collision.moveWithSliding(
      e.x,
      e.y,
      bestDx * speed * dt,
      bestDy * speed * dt,
      ENEMY_RADIUS
    );
    const nx = clamp(moved.x, MAP_BOUNDS.minX, MAP_BOUNDS.maxX);
    const ny = clamp(moved.y, MAP_BOUNDS.minY, MAP_BOUNDS.maxY);
    const mvx = nx - e.x;
    const mvy = ny - e.y;
    const len = Math.hypot(mvx, mvy);
    if (len > 0.01) {
      e.hx = mvx / len;
      e.hy = mvy / len;
    }
    e.x = nx;
    e.y = ny;
  }
}
