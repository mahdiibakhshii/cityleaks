import * as THREE from 'three';
import {
  renderSpec,
  getPlayerSpec,
  getEnemySpec,
  isAnonSpec,
  type SpriteSpec,
} from './drawSprite';

/**
 * A baked sprite sheet: one NearestFilter texture holding all walk frames in a
 * horizontal strip, plus the frame count and per-frame pixel dimensions. Atlases
 * are CACHED and SHARED across every entity of the same kind — 150 players cost
 * a handful of tiny textures, not 150 uploads.
 */
export interface BakedAtlas {
  texture: THREE.Texture;
  frames: number;
  fw: number;
  fh: number;
}

const cache = new Map<string, BakedAtlas>();

function bake(key: string, spec: SpriteSpec): BakedAtlas {
  const hit = cache.get(key);
  if (hit) return hit;

  const canvas = renderSpec(spec);
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  // Authored as sRGB hex; sampled raw in our shader (no decode) → write straight
  // to the sRGB framebuffer so colors appear exactly as drawn.
  texture.colorSpace = THREE.NoColorSpace;

  const baked: BakedAtlas = { texture, frames: spec.frames, fw: spec.width, fh: spec.height };
  cache.set(key, baked);
  return baked;
}

/** Baked atlas for a character id. Unknown/anon ids share one tintable sheet. */
export function playerAtlas(id: string | undefined | null): BakedAtlas {
  const key = isAnonSpec(id) ? 'anon' : `p:${id}`;
  return bake(key, getPlayerSpec(id));
}

/** Baked atlas for an enemy ghost of the given body color. */
export function enemyAtlas(color: string): BakedAtlas {
  return bake(`e:${color}`, getEnemySpec(color));
}
