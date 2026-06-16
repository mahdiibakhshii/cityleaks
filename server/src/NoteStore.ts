import * as fs from 'fs';
import { writeFileAtomic, writeFileAtomicSync } from './atomicWrite';
import { NOTE_MAX_LENGTH, type Note, type NoteCreate } from '../../shared/protocol';
import type { MapBounds } from '../../shared/protocol';

/**
 * Persistent store of anonymous sticky notes ("stuck" text pinned to a map
 * location). Mirrors LeakGrid's role for structured data: notes are ownerless,
 * survive restarts, and are sent in full to every new client.
 *
 * Backed by a plain JSON file (notes are rare + small, so JSON is plenty and
 * stays human-readable / inspectable). Writes are append-then-save: each new
 * note triggers one async save of the whole list.
 */
export class NoteStore {
  private notes: Note[] = [];
  private nextId = 1;
  private saving = false;
  private saveQueued = false;

  /** All notes (newest last). Sent to clients on connect. */
  getAll(): Note[] {
    return this.notes;
  }

  getCount(): number {
    return this.notes.length;
  }

  /**
   * Validate + create a note from a client request. Returns the stored Note, or
   * null if the text is empty/invalid. Position is clamped to the map bounds.
   * `admin` flags a "creator" note (stuck by Batman) so clients render it
   * distinctly.
   */
  create(req: NoteCreate, bounds: MapBounds, admin = false): Note | null {
    if (!req || typeof req.text !== 'string') return null;
    const text = req.text.trim().slice(0, NOTE_MAX_LENGTH);
    if (text.length === 0) return null;
    if (typeof req.x !== 'number' || typeof req.y !== 'number') return null;
    if (!Number.isFinite(req.x) || !Number.isFinite(req.y)) return null;

    const x = Math.max(bounds.minX, Math.min(bounds.maxX, req.x));
    const y = Math.max(bounds.minY, Math.min(bounds.maxY, req.y));

    const note: Note = {
      id: `n${this.nextId++}`,
      x,
      y,
      text,
      createdAt: Date.now(),
      ...(admin ? { admin: true } : {}),
    };
    this.notes.push(note);
    return note;
  }

  /** Delete a note by id. Returns true if a note was removed. */
  remove(id: string): boolean {
    const before = this.notes.length;
    this.notes = this.notes.filter((n) => n.id !== id);
    return this.notes.length !== before;
  }

  /**
   * Edit a note's text (admin moderation). Re-trims + clamps to NOTE_MAX_LENGTH.
   * Returns the updated Note, or null if not found / the new text is empty.
   */
  edit(id: string, text: unknown): Note | null {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim().slice(0, NOTE_MAX_LENGTH);
    if (trimmed.length === 0) return null;
    const note = this.notes.find((n) => n.id === id);
    if (!note) return null;
    note.text = trimmed;
    return note;
  }

  /** Remove every note (admin cleanup for a fresh run). */
  clear(): void {
    this.notes = [];
  }

  // ─── Persistence (JSON file) ───

  loadFromDisk(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      console.log('No existing notes found, starting fresh.');
      return;
    }
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Note[];
      if (Array.isArray(parsed)) {
        this.notes = parsed.filter(
          (n) =>
            n &&
            typeof n.id === 'string' &&
            typeof n.x === 'number' &&
            typeof n.y === 'number' &&
            typeof n.text === 'string'
        );
        // Resume id sequence past the highest existing numeric id.
        for (const n of this.notes) {
          const num = Number(n.id.replace(/^n/, ''));
          if (Number.isFinite(num) && num >= this.nextId) this.nextId = num + 1;
        }
        console.log(`Notes loaded: ${this.notes.length}`);
      }
    } catch (err) {
      console.warn('Failed to read notes file, starting fresh:', err);
    }
  }

  /** Synchronous save — use only on shutdown (must finish before exit). */
  saveToDisk(filePath: string): void {
    writeFileAtomicSync(filePath, JSON.stringify(this.notes));
    console.log(`Notes saved: ${this.notes.length}`);
  }

  /**
   * Async save with simple coalescing: if a save is already running, mark that
   * another is needed and run it once the current one finishes. Keeps rapid
   * note bursts from spawning overlapping writes.
   */
  async saveToDiskAsync(filePath: string): Promise<void> {
    if (this.saving) {
      this.saveQueued = true;
      return;
    }
    this.saving = true;
    try {
      const snapshot = JSON.stringify(this.notes);
      await writeFileAtomic(filePath, snapshot);
    } finally {
      this.saving = false;
      if (this.saveQueued) {
        this.saveQueued = false;
        await this.saveToDiskAsync(filePath);
      }
    }
  }
}
