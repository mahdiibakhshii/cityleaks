# Leak Grid System

## Concept

The leak grid is the core game mechanic. As players walk through the city, they "leak" — their collective movement permanently stains the map. The grid tracks **which parts of the city have been explored by anyone**, without recording who explored them.

Think of it as water seeping through a dry surface: once a cell is wet, it stays wet. The TouchDesigner visualization shows this as an expanding, flowing pattern of exploration.

## Grid Design

### Dimensions

- **1000 × 1000 cells** = 1,000,000 cells total
- Each cell maps to a rectangular area of the game map
- Cell size = `mapWidth / 1000` × `mapHeight / 1000` (in world units / pixels)

### Storage

Bit-packed `Uint8Array` — each cell is a single bit:

- **Size:** 1,000,000 bits = 125,000 bytes = **~122 KB**
- **Indexing:** `cellIndex = row * 1000 + col`
- **Byte:** `byteIndex = Math.floor(cellIndex / 8)`
- **Bit within byte:** `bitIndex = cellIndex % 8`

### Why Bit-Packed

At 1 byte per cell (simpler), the grid would be ~1 MB. At 1 bit per cell, it's 125 KB — small enough to send over a single WebSocket message when TD connects, and small enough to save to disk frequently.

## LeakGrid.ts Implementation

```typescript
class LeakGrid {
  private grid: Uint8Array;
  private readonly size: number;
  private leakedCount: number = 0;

  constructor(size: number = 1000) {
    this.size = size;
    const totalCells = size * size;
    const byteCount = Math.ceil(totalCells / 8);
    this.grid = new Uint8Array(byteCount); // All zeros = nothing leaked
  }

  // ─── Core Operations ───

  /**
   * Mark a cell as leaked.
   * Returns true if the cell was newly marked (was 0, now 1).
   * Returns false if it was already marked.
   */
  mark(cellX: number, cellY: number): boolean {
    if (cellX < 0 || cellX >= this.size || cellY < 0 || cellY >= this.size) {
      return false;
    }
    const index = cellY * this.size + cellX;
    const byteIdx = index >> 3;       // Math.floor(index / 8)
    const bitIdx = index & 7;         // index % 8
    const mask = 1 << bitIdx;

    if (this.grid[byteIdx] & mask) {
      return false; // Already marked
    }

    this.grid[byteIdx] |= mask;
    this.leakedCount++;
    return true;
  }

  /**
   * Check if a cell is leaked.
   */
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
   * Convert world position to grid cell.
   * mapWidth and mapHeight are the total map dimensions in world units.
   */
  worldToCell(
    worldX: number,
    worldY: number,
    mapWidth: number,
    mapHeight: number
  ): { cellX: number; cellY: number } {
    const cellX = Math.floor((worldX / mapWidth) * this.size);
    const cellY = Math.floor((worldY / mapHeight) * this.size);
    return {
      cellX: Math.max(0, Math.min(this.size - 1, cellX)),
      cellY: Math.max(0, Math.min(this.size - 1, cellY)),
    };
  }

  // ─── Serialization ───

  /**
   * Get the full grid as a buffer (for sending to TD on connect).
   */
  getFullBuffer(): Buffer {
    return Buffer.from(this.grid);
  }

  /**
   * Get stats.
   */
  getLeakedCount(): number {
    return this.leakedCount;
  }

  getPercentage(): number {
    return (this.leakedCount / (this.size * this.size)) * 100;
  }

  // ─── Persistence ───

  /**
   * Save grid to a binary file.
   */
  saveToDisk(path: string): void {
    const fs = require('fs');
    const dir = require('path').dirname(path);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path, this.grid);
    console.log(`Leak grid saved: ${this.leakedCount} cells (${this.getPercentage().toFixed(2)}%)`);
  }

  /**
   * Load grid from a binary file.
   */
  loadFromDisk(path: string): void {
    const fs = require('fs');
    if (!fs.existsSync(path)) {
      console.log('No existing leak grid found, starting fresh.');
      return;
    }
    const data = fs.readFileSync(path);
    if (data.length === this.grid.length) {
      this.grid = new Uint8Array(data);
      // Recount leaked cells
      this.leakedCount = 0;
      for (let i = 0; i < this.grid.length; i++) {
        // Count set bits in each byte (Brian Kernighan's method)
        let byte = this.grid[i];
        while (byte) {
          this.leakedCount++;
          byte &= byte - 1;
        }
      }
      console.log(`Leak grid loaded: ${this.leakedCount} cells (${this.getPercentage().toFixed(2)}%)`);
    } else {
      console.warn('Grid file size mismatch, starting fresh.');
    }
  }

  /**
   * Clear the entire grid.
   */
  reset(): void {
    this.grid.fill(0);
    this.leakedCount = 0;
  }
}
```

## TouchDesigner Integration (TDRoom.ts)

```typescript
class TDRoom {
  private io: Server;

  constructor(io: Server) {
    this.io = io;
  }

  /**
   * Called when a TD client connects.
   * Sends the full grid as a binary buffer.
   */
  onConnect(socket: Socket, leakGrid: LeakGrid): void {
    console.log('TouchDesigner connected:', socket.id);

    // Send full grid
    socket.emit('grid:full', leakGrid.getFullBuffer());

    // Send current stats
    socket.emit('grid:stats', {
      totalLeaked: leakGrid.getLeakedCount(),
      percentage: leakGrid.getPercentage(),
    });

    // Handle reset request from TD
    socket.on('grid:reset', () => {
      console.log('Grid reset requested by TD');
      leakGrid.reset();
      leakGrid.saveToDisk('./data/leak-grid.bin');
      // Send cleared grid to all TD clients
      this.io.to('td').emit('grid:full', leakGrid.getFullBuffer());
    });
  }

  /**
   * Called each server tick with newly marked cell indices.
   */
  sendDelta(newCells: number[]): void {
    this.io.to('td').emit('grid:delta', { cells: newCells });
  }

  /**
   * Send stats update to TD.
   */
  sendStats(leakGrid: LeakGrid, playerCount: number): void {
    this.io.to('td').emit('grid:stats', {
      totalLeaked: leakGrid.getLeakedCount(),
      percentage: leakGrid.getPercentage(),
      playerCount,
    });
  }
}
```

## TouchDesigner Client-Side Reference

For the user's TouchDesigner implementation (not built by us, but documented here for protocol compatibility):

### Connecting

```python
# In TD, use a Socket.IO CHOP or Python script
# Connect with role=td query parameter
import socketio
sio = socketio.Client()
sio.connect('http://server:3000', headers={}, auth={}, transports=['websocket'])
# After connection, send a message to join as TD role
# Or use query: sio.connect('http://server:3000?role=td')
```

### Receiving Full Grid

```python
@sio.on('grid:full')
def on_full_grid(data):
    # data is a binary buffer, 125,000 bytes
    # Each byte contains 8 cells (bits)
    # Unpack into a 1000x1000 array:
    import numpy as np
    bits = np.unpackbits(np.frombuffer(data, dtype=np.uint8))
    grid = bits[:1000000].reshape(1000, 1000)
    # grid[row][col] = 0 or 1
    # Use this to initialize a TOP texture
```

### Receiving Deltas

```python
@sio.on('grid:delta')
def on_delta(data):
    cells = data['cells']  # List of flat indices
    for index in cells:
        row = index // 1000
        col = index % 1000
        # Set pixel (col, row) to "leaked" in your TOP texture
```

### Resetting

```python
sio.emit('grid:reset', {})
```

## Grid Lifecycle

```
Server start
  │
  ├── Load grid from data/leak-grid.bin (or start empty)
  │
  ├── Game tick (10 Hz):
  │   ├── For each player position → worldToCell → mark
  │   ├── Collect newly marked cells
  │   └── Send grid:delta to TD room
  │
  ├── Every 30 seconds:
  │   └── Save grid to data/leak-grid.bin
  │
  ├── On TD connect:
  │   └── Send grid:full (entire buffer)
  │
  ├── On grid:reset from TD:
  │   ├── Clear grid
  │   ├── Save to disk
  │   └── Send grid:full (zeros) to TD
  │
  └── Server shutdown:
      └── Save grid to disk
```

## Grid Statistics

For 100 players exploring a city map:

| Metric | Value |
|---|---|
| Total cells | 1,000,000 |
| Grid memory | 125 KB |
| Max new cells per tick | ~100 (one per player, if all in new cells) |
| Typical new cells per tick | 5-20 (players revisit cells frequently) |
| Delta message size | 20-200 bytes per tick |
| Time to fill 10% of grid | Depends on map size, movement patterns |
| Full grid buffer | 125 KB (sent once on TD connect) |

The grid is extremely efficient — both in memory and network bandwidth.
