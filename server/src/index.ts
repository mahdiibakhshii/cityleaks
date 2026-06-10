import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { GameServer } from './GameServer';
import { LeakGrid } from './LeakGrid';
import { NoteStore } from './NoteStore';
import { KillStore } from './KillStore';
import { TDRoom } from './TDRoom';
import { CollisionField } from './CollisionField';
import { EnemyManager } from './EnemyManager';
import { AdminAuth } from './AdminAuth';
import { PORT, GRID_FILE, NOTES_FILE, KILLS_FILE, COLLISION_FILE, MASK_TILES_DIR } from './config';

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

// Enemy-kill markers: load any persisted markers on startup.
const killStore = new KillStore();
killStore.loadFromDisk(KILLS_FILE);

const tdRoom = new TDRoom(io);

// Admin auth: password → short-lived bearer token. Gates the admin page and the
// live-game Batman identity (server-enforced).
const adminAuth = new AdminAuth();

// Server collision field for the wandering enemies (they stay on roads). Built
// from the mask tiles in the background — non-blocking, so the server starts
// listening immediately; enemies stay dormant until `ready`.
const collisionField = new CollisionField(MASK_TILES_DIR, COLLISION_FILE);
void collisionField.build();
const enemyManager = new EnemyManager(collisionField);

const gameServer = new GameServer(io, leakGrid, noteStore, killStore, tdRoom, enemyManager, adminAuth);

// Parse JSON bodies (used by the admin login endpoint).
app.use(express.json());

// Serve the built client (production) from client/dist.
const clientDist = path.resolve(__dirname, '../../client/dist');

// Clean URL for the monitor page (also available directly at /monitor.html).
app.get('/monitor', (_req, res) => {
  res.sendFile(path.join(clientDist, 'monitor.html'));
});

// Clean URL for the admin page (also available directly at /admin.html).
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(clientDist, 'admin.html'));
});

// Admin login: validate the password, mint a short-lived token. The token then
// authorizes the admin socket (role=admin) and the live-game Batman session.
app.post('/api/admin/login', (req, res) => {
  const token = adminAuth.login(req.body?.password);
  if (!token) {
    res.status(401).json({ error: 'invalid password' });
    return;
  }
  res.json({ token });
});

app.use(express.static(clientDist));

// Health / status endpoint.
app.get('/api/status', (_req, res) => {
  res.json({
    players: gameServer.getPlayerCount(),
    leakedCells: leakGrid.getLeakedCount(),
    leakedPercentage: leakGrid.getPercentage(),
    notes: gameServer.getNoteCount(),
    kills: gameServer.getKillCount(),
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
  console.log('Shutting down — saving leak grid + notes + kills...');
  gameServer.stop();
  leakGrid.saveToDisk(GRID_FILE);
  noteStore.saveToDisk(NOTES_FILE);
  killStore.saveToDisk(KILLS_FILE);
  httpServer.close(() => process.exit(0));
  // Force-exit if close hangs.
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
