import * as THREE from 'three';
import type { CharacterShape } from '../../../shared/protocol';

/**
 * Build the flat geometry for a character shape, inscribed in `radius`.
 *
 * THREE.CircleGeometry(radius, n) is a regular n-gon, so the named characters
 * are just low-segment circles with a rotation that orients them nicely:
 *   triangle → point up,  square → axis-aligned,  diamond → point up (45° off),
 *   hexagon → flat top.  The anonymous circle is a smooth 32-gon.
 *
 * Keeping all player shapes here means Player, RemotePlayer (and future
 * walk-sprite swaps) share one source of truth.
 */
export function createShapeGeometry(shape: CharacterShape, radius: number): THREE.BufferGeometry {
  switch (shape) {
    case 'triangle': {
      // Slightly larger so the sparse triangle reads at the same footprint.
      const g = new THREE.CircleGeometry(radius * 1.15, 3);
      g.rotateZ(Math.PI / 2); // vertex up
      return g;
    }
    case 'square': {
      const g = new THREE.CircleGeometry(radius * 1.08, 4);
      g.rotateZ(Math.PI / 4); // diamond-of-4 → axis-aligned square
      return g;
    }
    case 'diamond':
      return new THREE.CircleGeometry(radius * 1.08, 4); // point up/down/left/right
    case 'hexagon': {
      const g = new THREE.CircleGeometry(radius * 1.05, 6);
      g.rotateZ(Math.PI / 6); // flat top
      return g;
    }
    case 'circle':
    default:
      return new THREE.CircleGeometry(radius, 32);
  }
}
