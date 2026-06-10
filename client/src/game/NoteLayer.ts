import * as THREE from 'three';
import type { Note } from '../../../shared/protocol';
import { NOTE } from '../config';

/**
 * Renders the always-visible sticky-note icons in world space and answers
 * "which note is the local player closest to (within reveal radius)?".
 *
 * Each note is a camera-facing sprite sharing one procedurally-drawn texture (a
 * little folded paper note with a blue pin) — no asset files needed. Sprites sit
 * at z=NOTE.Z, above the path overlay and below the local player. The actual
 * TEXT reveal is a DOM overlay handled by NoteUI; this layer only owns the map
 * markers and the proximity query.
 */
export class NoteLayer {
  readonly group = new THREE.Group();
  private texture: THREE.Texture;
  private material: THREE.SpriteMaterial;
  private notes = new Map<string, { note: Note; sprite: THREE.Sprite }>();
  private revealedId: string | null = null;
  private readonly iconSize: number;

  /** iconSize is in WORLD units; the monitor passes a larger value for its
   *  zoomed-out whole-map view. Defaults to the in-game icon size. */
  constructor(iconSize: number = NOTE.ICON_SIZE) {
    this.iconSize = iconSize;
    this.texture = makeNoteTexture();
    // One shared material; per-sprite visibility lets us hide a revealed note's
    // icon without touching the others.
    this.material = new THREE.SpriteMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
    });
  }

  /** Replace all notes (e.g. the NOTE_EXISTING snapshot on connect). */
  setNotes(notes: Note[]): void {
    for (const { sprite } of this.notes.values()) this.group.remove(sprite);
    this.notes.clear();
    for (const note of notes) this.addNote(note);
  }

  /** Add a single note (from NOTE_NEW or an optimistic local stick). */
  addNote(note: Note): void {
    if (this.notes.has(note.id)) return;
    const sprite = new THREE.Sprite(this.material);
    sprite.scale.set(this.iconSize, this.iconSize, 1);
    // Scene space stores three_y = -data_y like everything else.
    sprite.position.set(note.x, -note.y, NOTE.Z);
    this.group.add(sprite);
    this.notes.set(note.id, { note, sprite });
  }

  /**
   * Nearest note within NOTE.REVEAL_RADIUS of (x,y) in DATA coords, or null.
   * Linear scan — note counts are small relative to players.
   */
  getRevealNote(x: number, y: number): Note | null {
    const r2 = NOTE.REVEAL_RADIUS * NOTE.REVEAL_RADIUS;
    let best: Note | null = null;
    let bestD2 = r2;
    for (const { note } of this.notes.values()) {
      const dx = note.x - x;
      const dy = note.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = note;
      }
    }
    return best;
  }

  /** Mark which note is currently revealed so we can hide just its icon. */
  setRevealed(id: string | null): void {
    if (id === this.revealedId) return;
    this.revealedId = id;
    if (!NOTE.HIDE_ICON_WHEN_REVEALED) return;
    for (const [noteId, { sprite }] of this.notes) {
      sprite.visible = noteId !== id;
    }
  }
}

/**
 * Draw a sticky-note icon onto a canvas → CanvasTexture. A cream paper square
 * with a folded top-right corner and a blue pin dot, outlined so it reads over
 * any map background.
 */
function makeNoteTexture(): THREE.CanvasTexture {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;

  const pad = 22;
  const fold = 30; // folded-corner size
  const left = pad;
  const top = pad;
  const right = S - pad;
  const bottom = S - pad;

  ctx.lineJoin = 'round';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';

  // Paper body: square with the top-right corner cut off (the fold).
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(right - fold, top);
  ctx.lineTo(right, top + fold);
  ctx.lineTo(right, bottom);
  ctx.lineTo(left, bottom);
  ctx.closePath();
  ctx.fillStyle = NOTE.ICON_PAPER;
  ctx.fill();
  ctx.stroke();

  // The folded triangle in the corner.
  ctx.beginPath();
  ctx.moveTo(right - fold, top);
  ctx.lineTo(right - fold, top + fold);
  ctx.lineTo(right, top + fold);
  ctx.closePath();
  ctx.fillStyle = NOTE.ICON_FOLD;
  ctx.fill();
  ctx.stroke();

  // A couple of "text lines" hinting at writing.
  ctx.strokeStyle = 'rgba(0,0,0,0.30)';
  ctx.lineWidth = 5;
  const lineX1 = left + 12;
  const lineX2 = right - 12;
  for (const ly of [bottom - 34, bottom - 18]) {
    ctx.beginPath();
    ctx.moveTo(lineX1, ly);
    ctx.lineTo(lineX2, ly);
    ctx.stroke();
  }

  // Blue pin dot at the top-left to make the marker pop.
  ctx.beginPath();
  ctx.arc(left, top, 9, 0, Math.PI * 2);
  ctx.fillStyle = NOTE.ICON_ACCENT;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
