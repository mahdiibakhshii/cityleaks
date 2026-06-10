import * as fs from 'fs';
import * as path from 'path';
import type { KillMarker, MapBounds } from '../../shared/protocol';

/**
 * Persistent store of anonymous enemy-kill markers ("an enemy died here"). A
 * near-twin of NoteStore: markers are ownerless, survive restarts, and are sent
 * in full to every new client so the map accumulates a visible history of where
 * the city's hunts happened.
 *
 * Backed by a plain JSON file (kills are infrequent + tiny). Each new marker
 * triggers one coalesced async save of the whole list.
 */
export class KillStore {
  private kills: KillMarker[] = [];
  private nextId = 1;
  private saving = false;
  private saveQueued = false;

  /** All markers (oldest first). Sent to clients on connect. */
  getAll(): KillMarker[] {
    return this.kills;
  }

  getCount(): number {
    return this.kills.length;
  }

  /** Record a kill at a world position. Position is clamped to the map bounds. */
  create(x: number, y: number, kind: string, bounds: MapBounds): KillMarker {
    const marker: KillMarker = {
      id: `k${this.nextId++}`,
      x: Math.max(bounds.minX, Math.min(bounds.maxX, x)),
      y: Math.max(bounds.minY, Math.min(bounds.maxY, y)),
      kind,
      createdAt: Date.now(),
    };
    this.kills.push(marker);
    return marker;
  }

  /** Remove every kill marker (admin cleanup for a fresh run). */
  clear(): void {
    this.kills = [];
  }

  // ─── Persistence (JSON file) ───

  loadFromDisk(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      console.log('No existing kill markers found, starting fresh.');
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as KillMarker[];
      if (Array.isArray(parsed)) {
        this.kills = parsed.filter(
          (k) =>
            k &&
            typeof k.id === 'string' &&
            typeof k.x === 'number' &&
            typeof k.y === 'number' &&
            typeof k.kind === 'string'
        );
        for (const k of this.kills) {
          const num = Number(k.id.replace(/^k/, ''));
          if (Number.isFinite(num) && num >= this.nextId) this.nextId = num + 1;
        }
        console.log(`Kill markers loaded: ${this.kills.length}`);
      }
    } catch (err) {
      console.warn('Failed to read kill markers file, starting fresh:', err);
    }
  }

  /** Synchronous save — use only on shutdown (must finish before exit). */
  saveToDisk(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(this.kills));
    console.log(`Kill markers saved: ${this.kills.length}`);
  }

  /** Async save with simple coalescing (mirrors NoteStore.saveToDiskAsync). */
  async saveToDiskAsync(filePath: string): Promise<void> {
    if (this.saving) {
      this.saveQueued = true;
      return;
    }
    this.saving = true;
    try {
      const snapshot = JSON.stringify(this.kills);
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
