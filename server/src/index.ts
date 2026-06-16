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
import { AdminAuth, ADMIN_TOKEN_TTL_MS } from './AdminAuth';
import { ADMIN_COOKIE, readAdminToken, auditLog, isValidNoteId } from './adminSecurity';
import { writeFileAtomic } from './atomicWrite';
import { EVENTS } from '../../shared/protocol';
import {
  PORT,
  IS_PRODUCTION,
  ADMIN_PASSWORD_INSECURE,
  GRID_FILE,
  NOTES_FILE,
  KILLS_FILE,
  COLLISION_FILE,
  MASK_TILES_DIR,
  NOTE_IMAGES_DIR,
} from './config';

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

// HARD REFUSE: never run in production with a weak/default admin password. The
// admin can wipe all notes/paths/kills, so a guessable password is a data-loss
// risk. (Dev keeps the convenient default — this only fires when NODE_ENV=production.)
if (IS_PRODUCTION && ADMIN_PASSWORD_INSECURE) {
  console.error(
    'FATAL: ADMIN_PASSWORD is unset, the public default, or too short (<10 chars). ' +
      'Set a strong ADMIN_PASSWORD in the environment before starting in production. Refusing to boot.'
  );
  process.exit(1);
}

// Server collision field for the wandering enemies (they stay on roads). Built
// from the mask tiles in the background — non-blocking, so the server starts
// listening immediately; enemies stay dormant until `ready`.
const collisionField = new CollisionField(MASK_TILES_DIR, COLLISION_FILE);
void collisionField.build();
const enemyManager = new EnemyManager(collisionField);

const gameServer = new GameServer(io, leakGrid, noteStore, killStore, tdRoom, enemyManager, adminAuth);

// Behind nginx in production: trust the first proxy hop so req.ip is the real
// client IP (nginx sets X-Forwarded-For), making per-IP login rate limiting work.
app.set('trust proxy', 1);

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

// Admin login: rate-limited per IP. On a correct password we mint a token and
// set it as an httpOnly, Secure (prod), SameSite=Strict cookie — the token never
// touches a URL or JS, so it can't leak via logs/history. The cookie then
// authorizes the admin socket (role=admin), the photo upload, and the live-game
// Batman session.
app.post('/api/admin/login', (req, res) => {
  const ip = req.ip ?? 'unknown';
  const wait = adminAuth.retryAfterMs(ip);
  if (wait > 0) {
    auditLog('admin login BLOCKED (locked out)', ip);
    res.status(429).json({ error: 'too many attempts', retryAfterMs: wait });
    return;
  }
  const token = adminAuth.login(req.body?.password);
  if (!token) {
    adminAuth.recordFailure(ip);
    auditLog('admin login FAILED', ip);
    res.status(401).json({ error: 'invalid password' });
    return;
  }
  adminAuth.resetFailures(ip);
  res.cookie(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'strict',
    maxAge: ADMIN_TOKEN_TTL_MS,
    path: '/',
  });
  auditLog('admin login OK', ip);
  res.json({ ok: true });
});

// Admin logout: revoke the token and clear the cookie.
app.post('/api/admin/logout', (req, res) => {
  const token = readAdminToken(req.headers.cookie);
  adminAuth.revoke(token);
  res.clearCookie(ADMIN_COOKIE, { path: '/' });
  res.json({ ok: true });
});

// Admins' real-sticker photos (one webp per note id). Served read-only; uploads
// go through the authed endpoint below. Long-lived cache: filenames are reused on
// replace, so clients cache-bust with ?v=<imageAt> (see noteImageUrl in protocol).
app.use(
  '/note-images',
  express.static(NOTE_IMAGES_DIR, { maxAge: '365d', immutable: true })
);

// Attach a real-world photo of a note's physical sticker. The admin page resizes
// + re-encodes the photo to webp client-side, then POSTs the raw bytes here with
// its bearer token + the target note id. We validate, store one file per note id
// (atomic write), record the pointer on the Note, and broadcast NOTE_UPDATE so
// every surface (game / monitor / admin) shows the photo live. Raw body (not
// multipart) keeps this dependency-free.
app.post(
  '/api/admin/note-image',
  express.raw({ type: ['image/webp', 'image/jpeg', 'image/png'], limit: '8mb' }),
  (req, res) => {
    const token = readAdminToken(req.headers.cookie);
    if (!adminAuth.validate(token)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const id = req.query.id;
    // Validate the id shape before it touches a filename (path-traversal guard),
    // then confirm the note exists.
    if (!isValidNoteId(id) || !noteStore.get(id)) {
      res.status(404).json({ error: 'unknown note' });
      return;
    }
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: 'empty image' });
      return;
    }
    const file = path.join(NOTE_IMAGES_DIR, `${id}.webp`);
    void writeFileAtomic(file, body)
      .then(() => {
        const note = noteStore.setImage(id, `/note-images/${id}.webp`, Date.now());
        if (!note) {
          res.status(404).json({ error: 'unknown note' });
          return;
        }
        io.to('game').to('monitor').to('admin').emit(EVENTS.NOTE_UPDATE, note);
        void noteStore.saveToDiskAsync(NOTES_FILE);
        auditLog('note image attached', `${id} (${req.ip})`);
        res.json({ ok: true, image: note.image, imageAt: note.imageAt });
      })
      .catch((err) => {
        console.error('Failed to write note image:', err);
        res.status(500).json({ error: 'write failed' });
      });
  }
);

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
