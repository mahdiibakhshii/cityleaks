import * as THREE from 'three';
import { CAMERA, MAP_BOUNDS, SPAWN } from '../config';

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * OrthographicCamera following the local player in DATA space (+Y down). The
 * scene stores three_y = -data_y, so the camera is placed at (dataX, -dataY).
 *
 * Zoom uses a "fit the shorter axis" rule: VIEW_MIN_SPAN world units are always
 * visible along the shorter screen dimension, so portrait and landscape both
 * fill the screen and show a consistent area around the player.
 */
export class Camera {
  readonly camera: THREE.OrthographicCamera;
  dataX: number;
  dataY: number;
  viewWidth = 0;
  viewHeight = 0;

  constructor() {
    this.dataX = SPAWN.x;
    this.dataY = SPAWN.y;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    this.computeView();
    this.apply();
  }

  private computeView(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const span = CAMERA.VIEW_MIN_SPAN;
    if (w >= h) {
      this.viewHeight = span;
      this.viewWidth = span * (w / h);
    } else {
      this.viewWidth = span;
      this.viewHeight = span * (h / w);
    }
    this.camera.left = -this.viewWidth / 2;
    this.camera.right = this.viewWidth / 2;
    this.camera.top = this.viewHeight / 2;
    this.camera.bottom = -this.viewHeight / 2;
    this.camera.updateProjectionMatrix();
  }

  private clampToBounds(): void {
    const halfW = this.viewWidth / 2;
    const halfH = this.viewHeight / 2;
    if (MAP_BOUNDS.width > this.viewWidth) {
      this.dataX = clamp(this.dataX, MAP_BOUNDS.minX + halfW, MAP_BOUNDS.maxX - halfW);
    } else {
      this.dataX = MAP_BOUNDS.minX + MAP_BOUNDS.width / 2;
    }
    if (MAP_BOUNDS.height > this.viewHeight) {
      this.dataY = clamp(this.dataY, MAP_BOUNDS.minY + halfH, MAP_BOUNDS.maxY - halfH);
    } else {
      this.dataY = MAP_BOUNDS.minY + MAP_BOUNDS.height / 2;
    }
  }

  private apply(): void {
    // Scene stores three_y = -data_y.
    this.camera.position.set(this.dataX, -this.dataY, 10);
    this.camera.lookAt(this.dataX, -this.dataY, 0);
  }

  resize(): void {
    this.computeView();
    this.clampToBounds();
    this.apply();
  }

  /** Smoothly follow a target (data space), clamped to map bounds. */
  follow(target: { x: number; y: number }, dt: number): void {
    const lerpFactor = 1 - Math.pow(CAMERA.FOLLOW_BASE, dt);
    this.dataX += (target.x - this.dataX) * lerpFactor;
    this.dataY += (target.y - this.dataY) * lerpFactor;
    this.clampToBounds();
    this.apply();
  }
}
