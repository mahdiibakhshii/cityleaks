import * as THREE from 'three';
import { SPRITE } from '../../config';
import type { BakedAtlas } from './SpriteAtlas';

/**
 * An animated pixel-art sprite quad: a textured plane that plays a 2-frame walk
 * cycle while moving, rests on the stand frame when idle, and mirrors itself to
 * face left/right. Shared atlas texture, per-instance ShaderMaterial (cheap) so
 * each entity has its own frame/flip/tint.
 *
 * The owning entity positions `mesh` each frame and calls animate(); the quad's
 * geometry is raised by `anchorY` so the character's FEET sit near that point.
 */
export class CharacterSprite {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private facingRight = true;
  private animT = 0;
  private frameOverride: number | null = null;

  constructor(atlas: BakedAtlas, worldHeight: number, z: number, anchorY: number, tint?: THREE.Color) {
    const worldWidth = (worldHeight * atlas.fw) / atlas.fh;
    const geometry = new THREE.PlaneGeometry(worldWidth, worldHeight);
    geometry.translate(0, worldHeight * anchorY, 0);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: atlas.texture },
        uFrames: { value: atlas.frames },
        uFrame: { value: 0 },
        uFlip: { value: 0 },
        uTint: { value: (tint ?? new THREE.Color(1, 1, 1)).clone() },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform float uFrames;
        uniform float uFrame;
        uniform float uFlip;
        uniform vec3 uTint;
        varying vec2 vUv;
        void main() {
          // Mirror horizontally for left-facing; clamp inside the frame so we
          // never sample a neighbouring frame at the seam.
          float lx = uFlip > 0.5 ? (1.0 - vUv.x) : vUv.x;
          lx = clamp(lx, 0.001, 0.999);
          float u = (uFrame + lx) / uFrames;
          vec4 t = texture2D(uMap, vec2(u, vUv.y));
          if (t.a < 0.5) discard;
          gl_FragColor = vec4(t.rgb * uTint, t.a);
        }
      `,
      transparent: true,
      depthWrite: false,
    });

    this.mesh = new THREE.Mesh(geometry, this.mat);
    this.mesh.position.z = z;
  }

  setTint(color: THREE.Color): void {
    (this.mat.uniforms.uTint.value as THREE.Color).copy(color);
  }

  /**
   * Force a specific atlas frame (e.g. a scream frame), ignoring the walk cycle,
   * until cleared with `null`. Used by the enemy death sequence.
   */
  setFrameOverride(frame: number | null): void {
    this.frameOverride = frame;
    if (frame !== null) this.mat.uniforms.uFrame.value = frame;
  }

  /**
   * Advance the walk animation. `moving` plays the cycle (idle shows the stand
   * frame); `facingRight` left undefined keeps the previous facing (so moving
   * straight up/down doesn't reset which way the character looks).
   */
  animate(dt: number, moving: boolean, facingRight?: boolean): void {
    if (facingRight !== undefined) this.facingRight = facingRight;
    this.mat.uniforms.uFlip.value = this.facingRight ? 0 : 1;
    if (this.frameOverride !== null) {
      this.mat.uniforms.uFrame.value = this.frameOverride;
      return;
    }
    if (moving) {
      this.animT += dt;
      this.mat.uniforms.uFrame.value = Math.floor(this.animT * SPRITE.WALK_FPS) % 2;
    } else {
      this.animT = 0;
      this.mat.uniforms.uFrame.value = 0;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    // Texture is shared/cached across instances — never disposed here.
  }
}

/**
 * Build a THREE.Color holding raw sRGB components (no linearization), so a tint
 * multiply preserves the authored hue against the raw-sampled sprite texels.
 */
export function srgbTint(hex: string): THREE.Color {
  const n = parseInt(hex.replace('#', ''), 16);
  return new THREE.Color().setRGB(
    ((n >> 16) & 255) / 255,
    ((n >> 8) & 255) / 255,
    (n & 255) / 255,
    THREE.LinearSRGBColorSpace
  );
}
