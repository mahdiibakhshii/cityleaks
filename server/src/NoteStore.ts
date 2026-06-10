import * as fs from 'fs';
import * as path from 'path';
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
   */
  create(req: NoteCreate, bounds: MapBounds): Note | null {
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
    };
    this.notes.push(note);
    return note;
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
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(this.notes));
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
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, snapshot);
    } finally {
      this.saving = false;
      if (this.saveQueued) {
        this.saveQueued = false;
        await this.saveToDiskAsync(filePath);
      }
    }
  }
}
