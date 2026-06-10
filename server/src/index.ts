import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { GameServer } from './GameServer';
import { LeakGrid } from './LeakGrid';
import { NoteStore } from './NoteStore';
import { TDRoom } from './TDRoom';
import { CollisionField } from './CollisionField';
import { EnemyManager } from './EnemyManager';
import { PORT, GRID_FILE, NOTES_FILE, COLLISION_FILE, MASK_TILES_DIR } from './config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*', // Allow the Vite dev server in development.
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 2e6, // 2 MB — comfortably fits the 125 KB grid buffer.
});

// Leak grid: load any persisted state on startup.
const leakGrid = new LeakGrid();
leakGrid.loadFromDisk(GRID_FILE);

// Sticky notes: load any persisted notes on startup.
const noteStore = new NoteStore();
noteStore.loadFromDisk(NOTES_FILE);

const tdRoom = new TDRoom(io);

// Server collision field for the wandering enemies (they stay on roads). Built
// from the mask tiles in the background — non-blocking, so the server starts
// listening immediately; enemies stay dormant until `ready`.
const collisionField = new CollisionField(MASK_TILES_DIR, COLLISION_FILE);
void collisionField.build();
const enemyManager = new EnemyManager(collisionField);

const gameServer = new GameServer(io, leakGrid, noteStore, tdRoom, enemyManager);

// Serve the built client (production) from client/dist.
const clientDist = path.resolve(__dirname, '../../client/dist');

// Clean URL for the monitor page (also available directly at /monitor.html).
app.get('/monitor', (_req, res) => {
  res.sendFile(path.join(clientDist, 'monitor.html'));
});

app.use(express.static(clientDist));

// Health / status endpoint.
app.get('/api/status', (_req, res) => {
  res.json({
    players: gameServer.getPlayerCount(),
    leakedCells: leakGrid.getLeakedCount(),
    leakedPercentage: leakGrid.getPercentage(),
    notes: gameServer.getNoteCount(),
    enemies: gameServer.getEnemyCount(),
    tickMs: gameServer.getTickMetrics(),
    uptime: process.uptime(),
  });
});

gameServer.start();

httpServer.listen(PORT, () => {
  console.log(`CityLeaks server running on port ${PORT}`);
});

// Persist the grid on graceful shutdown.
function shutdown(): void {
  console.log('Shutting down — saving leak grid + notes...');
  gameServer.stop();
  leakGrid.saveToDisk(GRID_FILE);
  noteStore.saveToDisk(NOTES_FILE);
  httpServer.close(() => process.exit(0));
  // Force-exit if close hangs.
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
