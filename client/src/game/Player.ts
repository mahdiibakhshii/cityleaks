import * as THREE from 'three';
import { ANON_CHARACTER_ID } from '../../../shared/protocol';
import { PLAYER, SPRITE } from '../config';
import { CollisionMask, moveWithSliding } from './CollisionMask';
import { playerAtlas } from './sprites/SpriteAtlas';
import { CharacterSprite, srgbTint } from './sprites/CharacterSprite';
import { isAnonSpec } from './sprites/drawSprite';

const PLAYER_Z = 2;

/** The local player: an animated pixel-art mascot that moves with collision + wall sliding. */
export class Player {
  readonly sprite: CharacterSprite;
  x: number;
  y: number;
  private readonly anon: boolean;

  constructor(x: number, y: number, characterId: string = ANON_CHARACTER_ID, color = '#ffffff') {
    this.x = x;
    this.y = y;
    this.anon = isAnonSpec(characterId);
    const tint = this.anon ? srgbTint(color) : undefined;
    this.sprite = new CharacterSprite(playerAtlas(characterId), SPRITE.PLAYER_HEIGHT, PLAYER_Z, SPRITE.ANCHOR_Y, tint);
    this.sprite.mesh.position.set(x, -y, PLAYER_Z);
  }

  /** The renderable object (kept as `.mesh` so callers are unchanged). */
  get mesh(): THREE.Object3D {
    return this.sprite.mesh;
  }

  get position(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  /** Anonymous players take the server-assigned color as their sprite tint. */
  setColor(color: string): void {
    if (this.anon) this.sprite.setTint(srgbTint(color));
  }

  setPosition(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.sprite.mesh.position.set(x, -y, PLAYER_Z);
  }

  /** Move according to an input direction, resolving collisions against the mask. */
  update(direction: { x: number; y: number }, dt: number, mask: CollisionMask): void {
    const moving = direction.x !== 0 || direction.y !== 0;
    if (moving) {
      const dx = direction.x * PLAYER.SPEED * dt;
      const dy = direction.y * PLAYER.SPEED * dt;
      const next = moveWithSliding(this.x, this.y, dx, dy, PLAYER.RADIUS, mask);
      this.x = next.x;
      this.y = next.y;
      this.sprite.mesh.position.set(this.x, -this.y, PLAYER_Z);
    }
    const facing = direction.x > 0 ? true : direction.x < 0 ? false : undefined;
    this.sprite.animate(dt, moving, facing);
  }
}
