import * as fs from 'fs';
import * as path from 'path';
import { GRID_SIZE, type MapBounds } from '../../shared/protocol';

/**
 * Bit-packed 1000×1000 grid of visited ("leaked") cells.
 * Each cell is a single bit: 0 = unvisited, 1 = visited.
 * Total size: 1,000,000 bits = 125,000 bytes.
 */
export class LeakGrid {
  private grid: Uint8Array;
  private readonly size: number;
  private leakedCount = 0;

  constructor(size: number = GRID_SIZE) {
    this.size = size;
    const totalCells = size * size;
    const byteCount = Math.ceil(totalCells / 8);
    this.grid = new Uint8Array(byteCount); // All zeros = nothing leaked
  }

  // ─── Core Operations ───

  /**
   * Mark a cell as leaked.
   * Returns true if the cell was newly marked (was 0, now 1), false otherwise.
   */
  mark(cellX: number, cellY: number): boolean {
    if (cellX < 0 || cellX >= this.size || cellY < 0 || cellY >= this.size) {
      return false;
    }
    const index = cellY * this.size + cellX;
    const byteIdx = index >> 3; // Math.floor(index / 8)
    const bitIdx = index & 7; // index % 8
    const mask = 1 << bitIdx;

    if (this.grid[byteIdx] & mask) {
      return false; // Already marked
    }

    this.grid[byteIdx] |= mask;
    this.leakedCount++;
    return true;
  }

  /** Check if a cell is leaked. */
  isLeaked(cellX: number, cellY: number): boolean {
    if (cellX < 0 || cellX >= this.size || cellY < 0 || cellY >= this.size) {
      return false;
    }
    const index = cellY * this.size + cellX;
    const byteIdx = index >> 3;
    const bitIdx = index & 7;
    return (this.grid[byteIdx] & (1 << bitIdx)) !== 0;
  }

  // ─── Coordinate Conversion ───

  /**
   * Convert a world position to a grid cell, clamped to valid range.
   * The grid spans the full map bounds (which may start at negative coords).
   */
  worldToCell(worldX: number, worldY: number, bounds: MapBounds): { cellX: number; cellY: number } {
    const cellX = Math.floor(((worldX - bounds.minX) / bounds.width) * this.size);
    const cellY = Math.floor(((worldY - bounds.minY) / bounds.height) * this.size);
    return {
      cellX: Math.max(0, Math.min(this.size - 1, cellX)),
      cellY: Math.max(0, Math.min(this.size - 1, cellY)),
    };
  }

  // ─── Serialization ───

  /** Get the full grid as a Buffer (for sending to TD on connect). */
  getFullBuffer(): Buffer {
    return Buffer.from(this.grid);
  }

  getLeakedCount(): number {
    return this.leakedCount;
  }

  getPercentage(): number {
    return (this.leakedCount / (this.size * this.size)) * 100;
  }

  // ─── Persistence ───

  /** Synchronous save — use only on shutdown (must finish before exit). */
  saveToDisk(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, this.grid);
    console.log(
      `Leak grid saved: ${this.leakedCount} cells (${this.getPercentage().toFixed(2)}%)`
    );
  }

  /**
   * Async save for the periodic timer so a 125 KB disk write never blocks the
   * game tick. Snapshots the buffer first so concurrent marks during the write
   * can't tear the file.
   */
  async saveToDiskAsync(filePath: string): Promise<void> {
    const snapshot = Buffer.from(this.grid);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, snapshot);
    console.log(
      `Leak grid saved: ${this.leakedCount} cells (${this.getPercentage().toFixed(2)}%)`
    );
  }

  loadFromDisk(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      console.log('No existing leak grid found, starting fresh.');
      return;
    }
    const data = fs.readFileSync(filePath);
    if (data.length === this.grid.length) {
      this.grid = new Uint8Array(data);
      // Recount leaked cells (Brian Kernighan's bit-count).
      this.leakedCount = 0;
      for (let i = 0; i < this.grid.length; i++) {
        let byte = this.grid[i];
        while (byte) {
          this.leakedCount++;
          byte &= byte - 1;
        }
      }
      console.log(
        `Leak grid loaded: ${this.leakedCount} cells (${this.getPercentage().toFixed(2)}%)`
      );
    } else {
      console.warn('Grid file size mismatch, starting fresh.');
    }
  }

  /** Clear the entire grid. */
  reset(): void {
    this.grid.fill(0);
    this.leakedCount = 0;
  }
}
