# Server Specification

## Overview

A single Node.js process that:

1. Serves the built client as static files
2. Manages WebSocket connections via Socket.IO
3. Runs a 10 Hz game loop that broadcasts player positions
4. Maintains the 1000×1000 leak grid (anonymous visited cells)
5. Sends leak grid updates to the TouchDesigner room

## Bootstrap (index.ts)

```typescript
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { GameServer } from './GameServer';
import { LeakGrid } from './LeakGrid';
import { TDRoom } from './TDRoom';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',    // Allow Vite dev server in development
    methods: ['GET', 'POST'],
  },
});

// Serve static client files in production
app.use(express.static('../client/dist'));

// Health check endpoint
app.get('/api/status', (_req, res) => {
  res.json({
    players: gameServer.getPlayerCount(),
    leakedCells: leakGrid.getLeakedCount(),
    uptime: process.uptime(),
  });
});

const leakGrid = new LeakGrid();
leakGrid.loadFromDisk('./data/leak-grid.bin'); // Load persisted grid

const tdRoom = new TDRoom(io);
const gameServer = new GameServer(io, leakGrid, tdRoom);

gameServer.start();

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`CityLeaks server running on port ${PORT}`);
});
```

## GameServer.ts

### Player State

In-memory `Map` — no database for player data:

```typescript
interface PlayerState {
  id: string;       // Socket ID
  x: number;        // World position X
  y: number;        // World position Y
  color: string;    // Hex color, e.g., '#ff3366'
}

class GameServer {
  private players: Map<string, PlayerState> = new Map();
  private io: Server;
  private leakGrid: LeakGrid;
  private tdRoom: TDRoom;
  private tickInterval: NodeJS.Timeout | null = null;
  private readonly TICK_RATE = 10; // Hz
}
```

### Connection Handling

```typescript
setupSocketHandlers() {
  this.io.on('connection', (socket) => {
    // Assign random color
    const color = this.randomColor();

    // Assign starting position (random walkable point — or fixed spawn)
    const startX = MAP_WIDTH / 2;   // Center of map
    const startY = MAP_HEIGHT / 2;

    const playerState: PlayerState = {
      id: socket.id,
      x: startX,
      y: startY,
      color,
    };

    // Add to player map
    this.players.set(socket.id, playerState);

    // Join the game room
    socket.join('game');

    // Tell the new player about themselves
    socket.emit('player:self', {
      id: socket.id,
      x: startX,
      y: startY,
      color,
    });

    // Tell the new player about all existing players
    socket.emit('player:existing', Array.from(this.players.values()));

    // Tell everyone else about the new player
    socket.to('game').emit('player:join', playerState);

    // Handle movement
    socket.on('player:move', (data: { x: number; y: number }) => {
      const player = this.players.get(socket.id);
      if (!player) return;

      // Basic validation — clamp to map bounds
      player.x = clamp(data.x, 0, MAP_WIDTH);
      player.y = clamp(data.y, 0, MAP_HEIGHT);
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      this.players.delete(socket.id);
      this.io.to('game').emit('player:leave', { id: socket.id });
    });
  });
}
```

### Random Color Generation

Generate visually distinct, vibrant colors:

```typescript
private randomColor(): string {
  // Use HSL with full saturation for vivid colors, avoid very dark/light
  const hue = Math.floor(Math.random() * 360);
  const saturation = 70 + Math.floor(Math.random() * 30); // 70-100%
  const lightness = 45 + Math.floor(Math.random() * 20);  // 45-65%

  // Convert HSL to hex
  return hslToHex(hue, saturation, lightness);
}
```

### Game Tick (10 Hz)

```typescript
start() {
  this.setupSocketHandlers();

  this.tickInterval = setInterval(() => {
    this.tick();
  }, 1000 / this.TICK_RATE);

  // Persist leak grid every 30 seconds
  setInterval(() => {
    this.leakGrid.saveToDisk('./data/leak-grid.bin');
  }, 30_000);
}

private tick() {
  // 1. Build state array for broadcast
  const states = Array.from(this.players.values());

  // 2. Broadcast all positions to game room
  this.io.to('game').emit('state:update', states);

  // 3. Update leak grid for each player
  const newCells: number[] = [];
  for (const player of states) {
    const cell = this.leakGrid.worldToCell(player.x, player.y);
    if (this.leakGrid.mark(cell.cellX, cell.cellY)) {
      // This cell was newly marked
      newCells.push(cell.cellY * 1000 + cell.cellX);
    }
  }

  // 4. Send delta to TD room (if any new cells)
  if (newCells.length > 0) {
    this.tdRoom.sendDelta(newCells);
  }
}
```

### Map Dimension Constants

The server needs to know the total map dimensions for:
- Clamping player positions to valid bounds
- Converting world coordinates to leak grid cells

```typescript
// These must match config.ts on the client
const MAP_WIDTH = TILE_COLS * TILE_WIDTH_PX;   // total map width in world units
const MAP_HEIGHT = TILE_ROWS * TILE_HEIGHT_PX; // total map height in world units
```

These values should be in a shared config or environment variable.

### Player Count Soft Cap

For 100+ players, no special action needed — just log a warning:

```typescript
if (this.players.size >= 150) {
  console.warn(`Player count high: ${this.players.size}`);
  // Optionally: reject new connections
  // socket.emit('server:full'); socket.disconnect();
}
```

## Server-Side Collision (Optional Enhancement)

The current design trusts the client for collision. For anti-cheat, the server could also load the collision mask and validate positions. This is an **optional enhancement** — skip it for the initial build.

If implemented later:
- Load mask PNG files server-side using a library like `sharp` or `pngjs`
- On each `player:move`, check if the position is walkable
- If not walkable, ignore the update (keep previous position)
- This adds CPU cost per player per update but prevents cheating

## Package Dependencies (server/package.json)

```json
{
  "name": "cityleaks-server",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "express": "^4.21.0",
    "socket.io": "^4.8.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "tsx": "^4.19.0",
    "@types/express": "^4.17.21",
    "@types/node": "^22.0.0"
  }
}
```

## Server tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
```
