import * as THREE from 'three';

export interface MapBoundsThree {
  /** Map extent in THREE/scene space (x == data x; y == -data y). */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface MapControlsOptions {
  minZoom?: number;
  maxZoom?: number;
  /** Fired on a click/tap that wasn't a drag or pinch (screen px). */
  onTap?: (clientX: number, clientY: number) => void;
}

/**
 * Zoom + pan for the monitor's orthographic map camera.
 *
 *  - mouse wheel / trackpad → zoom toward the cursor
 *  - two-finger pinch → zoom toward the pinch midpoint
 *  - drag (mouse or one finger) → pan
 *
 * The owner sets the BASE (zoom = 1, fully-contained) frustum on the camera via
 * its fit logic; this class only drives `camera.zoom` and `camera.position`,
 * clamped so the map can't be panned out of view. It also exposes world↔screen
 * projection helpers (for hit-testing note icons and anchoring DOM popups).
 */
export class MapControls {
  private camera: THREE.OrthographicCamera;
  private dom: HTMLElement;
  private bounds: MapBoundsThree;
  private minZoom: number;
  private maxZoom: number;
  private onTap?: (clientX: number, clientY: number) => void;

  // Active pointers (for drag vs. pinch).
  private pointers = new Map<number, { x: number; y: number }>();
  private lastPinchDist = 0;
  // Tap detection.
  private downPos: { x: number; y: number } | null = null;
  private moved = 0;
  private pinched = false;

  constructor(
    camera: THREE.OrthographicCamera,
    dom: HTMLElement,
    bounds: MapBoundsThree,
    opts: MapControlsOptions = {}
  ) {
    this.camera = camera;
    this.dom = dom;
    this.bounds = bounds;
    this.minZoom = opts.minZoom ?? 1;
    this.maxZoom = opts.maxZoom ?? 14;
    this.onTap = opts.onTap;

    dom.style.touchAction = 'none';
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('pointermove', this.onPointerMove);
    dom.addEventListener('pointerup', this.onPointerUp);
    dom.addEventListener('pointercancel', this.onPointerUp);
    dom.addEventListener('pointerleave', this.onPointerUp);
  }

  // ─── Projection helpers ───

  /** Screen px (viewport-relative) → world point on the z=0 plane. */
  clientToWorld(clientX: number, clientY: number): THREE.Vector3 {
    // Project against the canvas rect, not the window: on mobile the canvas only
    // fills the top map region, so it has a non-zero offset + smaller size.
    const r = this.dom.getBoundingClientRect();
    const ndcX = ((clientX - r.left) / r.width) * 2 - 1;
    const ndcY = -(((clientY - r.top) / r.height) * 2 - 1);
    return new THREE.Vector3(ndcX, ndcY, 0).unproject(this.camera);
  }

  /** World point → screen px (viewport-relative). */
  worldToClient(x: number, y: number): { x: number; y: number } {
    const r = this.dom.getBoundingClientRect();
    const v = new THREE.Vector3(x, y, 0).project(this.camera);
    return {
      x: r.left + (v.x * 0.5 + 0.5) * r.width,
      y: r.top + (-v.y * 0.5 + 0.5) * r.height,
    };
  }

  // ─── External control ───

  /** Re-clamp after the owner changed the base frustum (e.g. on resize). */
  onViewChanged(): void {
    this.clampPan();
  }

  /** Center the view on a world point and ensure at least `zoom`. */
  focusOn(x: number, y: number, zoom: number): void {
    this.camera.zoom = THREE.MathUtils.clamp(
      Math.max(this.camera.zoom, zoom),
      this.minZoom,
      this.maxZoom
    );
    this.camera.position.x = x;
    this.camera.position.y = y;
    this.camera.updateProjectionMatrix();
    this.clampPan();
  }

  // ─── Zoom ───

  private applyZoom(factor: number, clientX: number, clientY: number): void {
    const before = this.clientToWorld(clientX, clientY);
    this.camera.zoom = THREE.MathUtils.clamp(
      this.camera.zoom * factor,
      this.minZoom,
      this.maxZoom
    );
    this.camera.updateProjectionMatrix();
    const after = this.clientToWorld(clientX, clientY);
    // Keep the world point under the cursor fixed.
    this.camera.position.x += before.x - after.x;
    this.camera.position.y += before.y - after.y;
    this.clampPan();
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    // Normalize wheel delta (line vs. pixel modes) to a gentle zoom step.
    const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const factor = Math.exp(-step * 0.0015);
    this.applyZoom(factor, e.clientX, e.clientY);
  };

  // ─── Pan + pinch (pointer events) ───

  private onPointerDown = (e: PointerEvent): void => {
    this.dom.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      this.downPos = { x: e.clientX, y: e.clientY };
      this.moved = 0;
      this.pinched = false;
      this.dom.style.cursor = 'grabbing';
    } else if (this.pointers.size === 2) {
      this.lastPinchDist = this.pinchDistance();
      this.pinched = true;
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;

    if (this.pointers.size === 1) {
      // Pan: move the camera by the world-space delta of the drag.
      const wPrev = this.clientToWorld(prev.x, prev.y);
      const wNow = this.clientToWorld(e.clientX, e.clientY);
      this.camera.position.x += wPrev.x - wNow.x;
      this.camera.position.y += wPrev.y - wNow.y;
      this.clampPan();
      this.moved += Math.hypot(e.clientX - prev.x, e.clientY - prev.y);
    }

    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size === 2) {
      const dist = this.pinchDistance();
      const mid = this.pinchMidpoint();
      if (this.lastPinchDist > 0) {
        this.applyZoom(dist / this.lastPinchDist, mid.x, mid.y);
      }
      this.lastPinchDist = dist;
      this.pinched = true;
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.dom.releasePointerCapture?.(e.pointerId);
    this.pointers.delete(e.pointerId);

    if (this.pointers.size < 2) this.lastPinchDist = 0;
    if (this.pointers.size === 0) {
      this.dom.style.cursor = '';
      // A click/tap: barely moved, single pointer, no pinch.
      if (!this.pinched && this.moved < 6 && this.downPos) {
        this.onTap?.(this.downPos.x, this.downPos.y);
      }
      this.downPos = null;
    }
  };

  private pinchDistance(): number {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  private pinchMidpoint(): { x: number; y: number } {
    const pts = [...this.pointers.values()];
    return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  }

  /**
   * Clamp camera position so the (zoom-scaled) view stays within the map. When
   * the view is larger than the map on an axis, the map is centered on it.
   */
  private clampPan(): void {
    const halfW = (this.camera.right - this.camera.left) / 2 / this.camera.zoom;
    const halfH = (this.camera.top - this.camera.bottom) / 2 / this.camera.zoom;
    const cx = (this.bounds.minX + this.bounds.maxX) / 2;
    const cy = (this.bounds.minY + this.bounds.maxY) / 2;
    const mapHalfW = (this.bounds.maxX - this.bounds.minX) / 2;
    const mapHalfH = (this.bounds.maxY - this.bounds.minY) / 2;

    this.camera.position.x =
      halfW >= mapHalfW
        ? cx
        : THREE.MathUtils.clamp(
            this.camera.position.x,
            this.bounds.minX + halfW,
            this.bounds.maxX - halfW
          );
    this.camera.position.y =
      halfH >= mapHalfH
        ? cy
        : THREE.MathUtils.clamp(
            this.camera.position.y,
            this.bounds.minY + halfH,
            this.bounds.maxY - halfH
          );
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.dom.removeEventListener('wheel', this.onWheel);
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    this.dom.removeEventListener('pointermove', this.onPointerMove);
    this.dom.removeEventListener('pointerup', this.onPointerUp);
    this.dom.removeEventListener('pointercancel', this.onPointerUp);
    this.dom.removeEventListener('pointerleave', this.onPointerUp);
  }
}
