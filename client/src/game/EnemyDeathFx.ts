import * as THREE from 'three';
import { ENEMY } from '../config';

/**
 * A one-shot explosion burst played where an enemy dies: a bright expanding
 * shockwave ring in the enemy's color plus a quick white core flash, additively
 * blended so it pops against the city photo. Self-disposing — the EnemyManager
 * spawns one, ticks update(dt), and removes it once `finished`.
 */
export class ExplosionBurst {
  readonly group = new THREE.Group();
  private readonly ring: THREE.Mesh;
  private readonly core: THREE.Mesh;
  private readonly ringMat: THREE.MeshBasicMaterial;
  private readonly coreMat: THREE.MeshBasicMaterial;
  private t = 0;
  private done = false;
  private readonly radius: number;

  constructor(x: number, y: number, color: string, radius: number = ENEMY.BURST_RADIUS) {
    this.radius = radius;
    this.ringMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.72, 1.0, 36), this.ringMat);

    this.coreMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.core = new THREE.Mesh(new THREE.CircleGeometry(1, 24), this.coreMat);

    this.group.add(this.ring, this.core);
    // Sit just above the enemy band so the flash reads over everything nearby.
    this.group.position.set(x, -y, ENEMY.Z + 0.5);
  }

  get finished(): boolean {
    return this.done;
  }

  update(dt: number): void {
    this.t += dt;
    const p = this.t / ENEMY.BURST_TIME;
    if (p >= 1) {
      this.done = true;
      return;
    }
    // Ring: ease-out expansion, fading as it grows.
    const ease = 1 - Math.pow(1 - p, 3);
    const r = Math.max(0.001, this.radius * ease);
    this.ring.scale.set(r, r, 1);
    this.ringMat.opacity = (1 - p) * 0.9;
    // Core: a brief, fast-fading white flash.
    const coreR = Math.max(0.001, this.radius * 0.45 * (1 - p));
    this.core.scale.set(coreR, coreR, 1);
    this.coreMat.opacity = Math.max(0, 1 - p * 2.6) * 0.9;
  }

  dispose(): void {
    this.ring.geometry.dispose();
    this.core.geometry.dispose();
    this.ringMat.dispose();
    this.coreMat.dispose();
  }
}
