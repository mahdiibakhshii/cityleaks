import {
  ENEMY_PER_PLAYERS,
  ENEMY_MIN,
  ENEMY_MAX,
  ENEMY_RADIUS,
  ENEMY_SPEED,
  ENEMY_TYPES,
  ENEMY_PANIC_BOOST,
  ENEMY_STAMINA_DRAIN,
  ENEMY_STAMINA_REGEN,
  ENEMY_TIRED_SPEED,
  ENEMY_LIFE_DRAIN_TRAP,
  ENEMY_LIFE_DRAIN_EXHAUST,
  ENEMY_LIFE_REGEN,
  ENEMY_TRAP_RADIUS,
  ENEMY_PLAYER_BLOCK,
  ENEMY_ESCAPE_CLEARANCE,
  enemyDef,
  type EnemyState,
  type EnemyPos,
  type EnemyDie,
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
  stamina: number; // 1 = fresh, 0 = exhausted (sprinting drains it, resting refills)
  life: number; // 1 = healthy, 0 = dead (drains while trapped / exhausted-and-cornered)
  panic: number; // 0..1 smoothed "how hard am I fleeing" — telegraph + death tint
}

type Point = { x: number; y: number; id?: string };

// Context-steering parameters.
const STEER_SAMPLES = 12; // candidate directions tested per enemy per tick
const LOOKAHEAD = 80; // world units of clearance probed per direction
const PLAYER_PROBE = ENEMY_RADIUS + 28; // how far ahead an escape route is tested for a blocking player
const BLOCK2 = ENEMY_PLAYER_BLOCK * ENEMY_PLAYER_BLOCK;
const TRAP2 = ENEMY_TRAP_RADIUS * ENEMY_TRAP_RADIUS;

/**
 * Spawns and drives the wandering enemy NPCs (server-authoritative). Each enemy
 * keeps a comfortable distance from the nearest player — fleeing when crowded,
 * drifting back when abandoned, orbiting/wandering in between — and steers
 * toward open streets (via CollisionField) so it stays on roads.
 *
 * THE HUNT: the closer a player presses, the harder an enemy panic-sprints
 * (ENEMY_PANIC_BOOST), but sprinting burns stamina and a tired enemy is slow.
 * Players are treated as soft blockers of escape routes, so a body-wall (or a
 * dead-end) that leaves NO open escape "traps" the enemy and bleeds its life
 * fast; relentless point-blank pressure on an exhausted enemy bleeds it slowly.
 * When life hits 0 the enemy dies — see `update()`'s returned `died` deltas.
 *
 * `update()` returns the per-tick spawn / silent-despawn / KILLED deltas so
 * GameServer can broadcast ENEMY_JOIN / ENEMY_LEAVE / ENEMY_DIE; live positions
 * (+ life/panic) go out every tick via getPositions() → ENEMY_UPDATE.
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
      life: round2(e.life),
    }));
  }

  getPositions(): EnemyPos[] {
    return Array.from(this.enemies.values(), (e) => ({
      id: e.id,
      x: e.x,
      y: e.y,
      life: round2(e.life),
      panic: round2(e.panic),
    }));
  }

  /**
   * Advance all enemies one tick, kill any that have run out of life, and
   * reconcile the population toward the target for the current player count.
   * Returns the spawn / silent-despawn / killed deltas this tick.
   */
  update(
    players: Point[],
    dt: number
  ): { spawned: EnemyState[]; despawned: string[]; died: EnemyDie[] } {
    const spawned: EnemyState[] = [];
    const despawned: string[] = [];
    const died: EnemyDie[] = [];

    // 1. Steer + run the hunt simulation. Collect any enemy that just died.
    for (const e of this.enemies.values()) {
      this.steer(e, players, dt);
      if (e.life <= 0) {
        died.push({ id: e.id, x: e.x, y: e.y, kind: e.kind, by: this.huntersNear(e, players) });
      }
    }
    for (const d of died) this.enemies.delete(d.id);

    // 2. Reconcile population (at most one spawn/despawn per tick → gentle churn).
    const target = this.targetCount(players.length);
    if (this.enemies.size < target) {
      const e = this.spawn(players);
      if (e) {
        spawned.push({ id: e.id, x: e.x, y: e.y, color: e.color, kind: e.kind, life: e.life });
      }
    } else if (this.enemies.size > target) {
      const id = this.pickDespawn(players);
      if (id) {
        this.enemies.delete(id);
        despawned.push(id);
      }
    }

    return { spawned, despawned, died };
  }

  /** Players within the credit radius of a kill (the hunters who pulled it off). */
  private huntersNear(e: Enemy, players: Point[]): string[] {
    const ids: string[] = [];
    for (const p of players) {
      if (!p.id) continue;
      const dx = p.x - e.x;
      const dy = p.y - e.y;
      if (dx * dx + dy * dy <= TRAP2) ids.push(p.id);
    }
    return ids;
  }

  /** Desired enemy count for a player count (0 while the collision field isn't ready). */
  private targetCount(playerCount: number): number {
    if (!this.collision.ready || playerCount === 0) return 0;
    return clamp(Math.ceil(playerCount / ENEMY_PER_PLAYERS), ENEMY_MIN, ENEMY_MAX);
  }

  private spawn(players: Point[]): Enemy | null {
    const def = ENEMY_TYPES[Math.floor(Math.random() * ENEMY_TYPES.length)];
    // Place near a random player, on an open street a fair distance off (just
    // outside the panic band so it doesn't pop in already fleeing).
    const anchor = players.length ? players[Math.floor(Math.random() * players.length)] : SPAWN;
    const spot = this.findSpawnNear(anchor, def.fleeRadius);
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
      stamina: 1,
      life: 1,
      panic: 0,
    };
    this.enemies.set(enemy.id, enemy);
    return enemy;
  }

  /**
   * A walkable spawn spot AROUND an anchor (a player): try a ring of candidate
   * directions just outside the panic band and take the first that's directly on
   * an open street — so enemies appear on real nearby roads, never inside a
   * building and never right on top of the player. Falls back to a spiral search,
   * then the map spawn, so it always returns somewhere walkable.
   */
  private findSpawnNear(anchor: Point, fleeRadius: number): { x: number; y: number } | null {
    const minDist = fleeRadius + 60; // just past the panic band
    const span = 320; // how much farther out it may land
    const tries = 14;
    for (let i = 0; i < tries; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = minDist + Math.random() * span;
      const x = anchor.x + Math.cos(angle) * dist;
      const y = anchor.y + Math.sin(angle) * dist;
      if (this.collision.isCircleWalkable(x, y, ENEMY_RADIUS)) return { x, y };
    }
    // No clear ring spot — spiral out from a candidate, then the map spawn.
    const angle = Math.random() * Math.PI * 2;
    const pref = { x: anchor.x + Math.cos(angle) * minDist, y: anchor.y + Math.sin(angle) * minDist };
    return (
      this.collision.findNearestWalkable(pref.x, pref.y, ENEMY_RADIUS) ??
      this.collision.findNearestWalkable(SPAWN.x, SPAWN.y, ENEMY_RADIUS)
    );
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

  /** Is the escape route along (dx,dy) blocked by a player's body standing in it? */
  private playerBlocks(e: Enemy, dx: number, dy: number, players: Point[]): boolean {
    const px = e.x + dx * PLAYER_PROBE;
    const py = e.y + dy * PLAYER_PROBE;
    for (const p of players) {
      const qx = p.x - px;
      const qy = p.y - py;
      if (qx * qx + qy * qy <= BLOCK2) return true;
    }
    return false;
  }

  /** Pick a heading via context steering, run the hunt sim, and move one tick. */
  private steer(e: Enemy, players: Point[], dt: number): void {
    const def = enemyDef(e.kind);
    const { p, d2 } = this.nearest(e, players);
    const d = p ? Math.sqrt(d2) || 0.0001 : Infinity;
    const pressured = d < def.fleeRadius;

    // Panic builds toward 1 as the player closes in, SATURATING before point-blank
    // (within ~55% of the flee radius) so the enemy reads as fully panicked while
    // you're still approaching — i.e. it spends more time visibly panicking.
    const panicTarget = pressured ? clamp((def.fleeRadius - d) / (def.fleeRadius * 0.55), 0, 1) : 0;
    // Slow, asymmetric smoothing: panic ramps UP gradually (a visible build-up,
    // not an instant flip) and fades DOWN even slower, so enemies stay panicked
    // for a while after a player backs off.
    const panicRate = panicTarget > e.panic ? 2.5 : 1.2;
    e.panic += (panicTarget - e.panic) * Math.min(1, dt * panicRate);

    // Desired direction + how strongly to honor it, by distance band.
    let desX = e.hx;
    let desY = e.hy;
    let desiredWeight = 0.4;
    let speedScale = 0.6; // idle wander is slower
    let fleeing = false;
    if (p) {
      const awayX = (e.x - p.x) / d; // unit vector player → enemy
      const awayY = (e.y - p.y) / d;
      if (d < def.fleeRadius) {
        // Too close → flee directly away, HARDER the closer the player is.
        desX = awayX;
        desY = awayY;
        desiredWeight = 1.6;
        speedScale = 1 + e.panic * ENEMY_PANIC_BOOST;
        fleeing = true;
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

    // Score candidate directions and, in parallel, count viable ESCAPES (open
    // street + no player body in the way). Avoiding player-blocked routes both
    // makes the enemy refuse to squeeze between hunters AND reveals when it is
    // genuinely boxed in (zero escapes while pressured = trapped).
    let bestDx = e.hx;
    let bestDy = e.hy;
    let bestScore = -Infinity;
    let escapes = 0;
    const noise = def.wanderiness * 0.6;
    for (let i = 0; i < STEER_SAMPLES; i++) {
      const a = (i / STEER_SAMPLES) * Math.PI * 2;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const clr = this.collision.clearance(e.x, e.y, dx, dy, LOOKAHEAD);
      if (clr <= 0) continue; // immediately blocked by a wall
      const blocked = this.playerBlocks(e, dx, dy, players);
      if (clr >= ENEMY_ESCAPE_CLEARANCE && !blocked) escapes++;
      const score =
        0.9 * (clr / LOOKAHEAD) +
        desiredWeight * (dx * desX + dy * desY) +
        0.7 * (dx * e.hx + dy * e.hy) +
        (blocked ? -1.5 : 0) + // shun routes a hunter is standing in
        noise * (Math.random() - 0.5);
      if (score > bestScore) {
        bestScore = score;
        bestDx = dx;
        bestDy = dy;
      }
    }

    // ─── Fatigue + life: the two kill paths ───
    const trapped = pressured && escapes === 0;
    if (fleeing && e.panic > 0.15) {
      e.stamina -= ENEMY_STAMINA_DRAIN * dt * (0.4 + e.panic);
    } else {
      e.stamina += ENEMY_STAMINA_REGEN * dt;
    }
    e.stamina = clamp(e.stamina, 0, 1);

    if (trapped) {
      e.life -= ENEMY_LIFE_DRAIN_TRAP * dt; // boxed in → quick, dramatic kill
    } else if (pressured && e.stamina <= 0.05 && e.panic > 0.5) {
      e.life -= ENEMY_LIFE_DRAIN_EXHAUST * dt; // worn down + held point-blank → slow bleed
    } else if (!pressured) {
      e.life += ENEMY_LIFE_REGEN * dt; // got away → recover
    }
    e.life = clamp(e.life, 0, 1);
    if (e.life <= 0) return; // dead — GameServer broadcasts the death; skip the move

    // A tired enemy can't sprint: scale flee speed down toward ENEMY_TIRED_SPEED.
    if (fleeing) speedScale *= ENEMY_TIRED_SPEED + (1 - ENEMY_TIRED_SPEED) * e.stamina;

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

/** Round to 2 decimals to keep the per-tick enemy payload small. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
