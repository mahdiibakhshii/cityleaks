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
  private adminTexture: THREE.Texture;
  private material: THREE.SpriteMaterial;
  private adminMaterial: THREE.SpriteMaterial;
  private notes = new Map<string, { note: Note; sprite: THREE.Sprite }>();
  private revealedId: string | null = null;
  private readonly iconSize: number;

  /** iconSize is in WORLD units; the monitor passes a larger value for its
   *  zoomed-out whole-map view. Defaults to the in-game icon size. */
  constructor(iconSize: number = NOTE.ICON_SIZE) {
    this.iconSize = iconSize;
    // Two shared materials: anonymous player notes and the distinct "creator"
    // (Batman / admin) note. Per-sprite visibility hides a revealed note's icon.
    this.texture = makeNoteTexture(NOTE.ICON_PAPER, NOTE.ICON_FOLD, NOTE.ICON_ACCENT);
    this.adminTexture = makeNoteTexture(
      NOTE.ADMIN_ICON_PAPER,
      NOTE.ADMIN_ICON_FOLD,
      NOTE.ADMIN_ICON_ACCENT
    );
    this.material = new THREE.SpriteMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
    });
    this.adminMaterial = new THREE.SpriteMaterial({
      map: this.adminTexture,
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
    const sprite = new THREE.Sprite(note.admin ? this.adminMaterial : this.material);
    sprite.scale.set(this.iconSize, this.iconSize, 1);
    // Scene space stores three_y = -data_y like everything else.
    sprite.position.set(note.x, -note.y, NOTE.Z);
    this.group.add(sprite);
    this.notes.set(note.id, { note, sprite });
  }

  /** Remove one note (admin delete → NOTE_REMOVE). */
  removeNote(id: string): void {
    const entry = this.notes.get(id);
    if (!entry) return;
    this.group.remove(entry.sprite);
    this.notes.delete(id);
    if (this.revealedId === id) this.revealedId = null;
  }

  /** Update a note's stored data in place (admin edit / photo → NOTE_UPDATE).
   *  Keeps the existing sprite but refreshes text + image so the next reveal
   *  shows the new content. */
  updateNote(note: Note): void {
    const entry = this.notes.get(note.id);
    if (!entry) {
      this.addNote(note);
      return;
    }
    entry.note = note;
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
 * Draw a sticky-note icon onto a canvas → CanvasTexture. A paper square with a
 * folded top-right corner and a pin dot, outlined so it reads over any map
 * background. Colors are parameterized so the anonymous and "creator" (admin)
 * notes share one drawing routine.
 */
function makeNoteTexture(paper: string, fold: string, accent: string): THREE.CanvasTexture {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;

  const pad = 22;
  const foldSize = 30; // folded-corner size
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
  ctx.lineTo(right - foldSize, top);
  ctx.lineTo(right, top + foldSize);
  ctx.lineTo(right, bottom);
  ctx.lineTo(left, bottom);
  ctx.closePath();
  ctx.fillStyle = paper;
  ctx.fill();
  ctx.stroke();

  // The folded triangle in the corner.
  ctx.beginPath();
  ctx.moveTo(right - foldSize, top);
  ctx.lineTo(right - foldSize, top + foldSize);
  ctx.lineTo(right, top + foldSize);
  ctx.closePath();
  ctx.fillStyle = fold;
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

  // Pin dot at the top-left to make the marker pop.
  ctx.beginPath();
  ctx.arc(left, top, 9, 0, Math.PI * 2);
  ctx.fillStyle = accent;
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
