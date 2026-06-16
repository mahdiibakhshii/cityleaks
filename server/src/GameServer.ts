import type { Server, Socket } from 'socket.io';
import {
  EVENTS,
  TICK_RATE,
  GRID_SAVE_INTERVAL,
  MAX_PLAYERS,
  GRID_SIZE,
  ANON_CHARACTER_ID,
  ADMIN_CHARACTER_ID,
  ADMIN_CHARACTER,
  ENEMY_KILL_SPLASH_RADIUS,
  getCharacter,
  type PlayerState,
  type PlayerMove,
  type PlayerPos,
  type NoteCreate,
  type EnemyDie,
  type AdminPlayerInfo,
  type AdminStats,
  type AdminNoteEdit,
  type AdminNoteSticker,
  type AdminBroadcast,
  type AdminKick,
  type AdminMapOpacity,
} from '../../shared/protocol';
import { LeakGrid } from './LeakGrid';
import { NoteStore } from './NoteStore';
import { KillStore } from './KillStore';
import { ChatStore } from './ChatStore';
import { TDRoom } from './TDRoom';
import { EnemyManager } from './EnemyManager';
import { AdminAuth } from './AdminAuth';
import { readAdminToken, auditLog, isValidNoteId } from './adminSecurity';
import * as fs from 'fs';
import * as path from 'path';
import { MAP_BOUNDS, SPAWN, GRID_FILE, NOTES_FILE, KILLS_FILE, NOTE_IMAGES_DIR } from './config';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Convert HSL to a hex color string. h in [0,360], s/l in [0,100]. */
function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const color = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export class GameServer {
  private players: Map<string, PlayerState> = new Map();
  private io: Server;
  private leakGrid: LeakGrid;
  private noteStore: NoteStore;
  private killStore: KillStore;
  private chatStore: ChatStore;
  private tdRoom: TDRoom;
  private enemyManager: EnemyManager;
  private adminAuth: AdminAuth;
  // Socket ids of authed Batman (admin) players, so their notes are flagged.
  private adminSocketIds = new Set<string>();
  // Monitor background-image opacity (0..1), set by the admin, broadcast to the
  // monitor room. In-memory only — resets to fully opaque on restart.
  private mapOpacity = 1;
  private tickInterval: NodeJS.Timeout | null = null;
  private saveInterval: NodeJS.Timeout | null = null;
  private statsTickCounter = 0;

  // Tick timing metrics (ms), for load testing / health monitoring.
  private lastTickMs = 0;
  private avgTickMs = 0;
  private maxTickMs = 0;

  constructor(
    io: Server,
    leakGrid: LeakGrid,
    noteStore: NoteStore,
    killStore: KillStore,
    chatStore: ChatStore,
    tdRoom: TDRoom,
    enemyManager: EnemyManager,
    adminAuth: AdminAuth
  ) {
    this.io = io;
    this.leakGrid = leakGrid;
    this.noteStore = noteStore;
    this.killStore = killStore;
    this.chatStore = chatStore;
    this.tdRoom = tdRoom;
    this.enemyManager = enemyManager;
    this.adminAuth = adminAuth;
  }

  getPlayerCount(): number {
    return this.players.size;
  }

  getNoteCount(): number {
    return this.noteStore.getCount();
  }

  getEnemyCount(): number {
    return this.enemyManager.count;
  }

  /** Tick timing metrics in milliseconds (for /api/status + load testing). */
  getTickMetrics(): { last: number; avg: number; max: number } {
    return {
      last: Number(this.lastTickMs.toFixed(3)),
      avg: Number(this.avgTickMs.toFixed(3)),
      max: Number(this.maxTickMs.toFixed(3)),
    };
  }

  start(): void {
    this.setupSocketHandlers();

    this.tickInterval = setInterval(() => this.tick(), 1000 / TICK_RATE);

    this.saveInterval = setInterval(() => {
      void this.leakGrid.saveToDiskAsync(GRID_FILE);
    }, GRID_SAVE_INTERVAL);
  }

  stop(): void {
    if (this.tickInterval) clearInterval(this.tickInterval);
    if (this.saveInterval) clearInterval(this.saveInterval);
    this.tickInterval = null;
    this.saveInterval = null;
  }

  private setupSocketHandlers(): void {
    this.io.on('connection', (socket: Socket) => {
      // TouchDesigner clients are routed to the TD room and handled separately.
      if (socket.handshake.query.role === 'td') {
        socket.join('td');
        this.tdRoom.onConnect(socket, this.leakGrid, this.players.size);
        return;
      }

      // Monitor (spectator) clients: receive grid + player positions but are
      // NOT players — no spawn, no leak marking, no join broadcast.
      if (socket.handshake.query.role === 'monitor') {
        this.handleMonitorConnection(socket);
        return;
      }

      // Admin clients: gated by a valid token (minted at /api/admin/login).
      if (socket.handshake.query.role === 'admin') {
        this.handleAdminConnection(socket);
        return;
      }

      // Chat clients are handled by the chat room handler in index.ts.
      if (socket.handshake.query.role === 'chat') return;

      this.handleGameConnection(socket);
    });
  }

  private handleMonitorConnection(socket: Socket): void {
    socket.join('monitor');
    console.log('Monitor connected:', socket.id);

    // Full persistent grid + current players so the view populates immediately.
    socket.emit(EVENTS.GRID_FULL, this.leakGrid.getFullBuffer());
    socket.emit(EVENTS.PLAYER_EXISTING, Array.from(this.players.values()));
    socket.emit(EVENTS.NOTE_EXISTING, this.noteStore.getAll());
    socket.emit(EVENTS.KILL_EXISTING, this.killStore.getAll());
    socket.emit(EVENTS.ENEMY_EXISTING, this.enemyManager.getStates());
    socket.emit(EVENTS.ADMIN_MAP_OPACITY, { value: this.mapOpacity });

    socket.on('disconnect', () => {
      console.log('Monitor disconnected:', socket.id);
    });
  }

  /**
   * Admin dashboard connection. The handshake must carry a valid token (from
   * /api/admin/login); otherwise we deny + disconnect. Once authed, the socket
   * joins the `admin` room (which receives live ADMIN_STATS / ADMIN_PLAYERS each
   * second) and may issue privileged actions — trusted implicitly because the
   * socket is already authed.
   */
  private handleAdminConnection(socket: Socket): void {
    // The admin token rides in the httpOnly cookie sent with the socket
    // handshake (never in the query string).
    const token = readAdminToken(socket.handshake.headers.cookie);
    if (!this.adminAuth.validate(token)) {
      socket.emit(EVENTS.ADMIN_DENIED);
      socket.disconnect(true);
      return;
    }

    socket.join('admin');
    socket.emit(EVENTS.ADMIN_OK);
    const adminIp = socket.handshake.address;
    auditLog('admin socket connected', `${socket.id} (${adminIp})`);

    // Initial snapshots so the dashboard populates immediately.
    socket.emit(EVENTS.NOTE_EXISTING, this.noteStore.getAll());
    socket.emit(EVENTS.KILL_EXISTING, this.killStore.getAll());
    socket.emit(EVENTS.ADMIN_STATS, this.buildAdminStats());
    socket.emit(EVENTS.ADMIN_PLAYERS, this.buildAdminPlayers());
    socket.emit(EVENTS.ADMIN_MAP_OPACITY, { value: this.mapOpacity });

    // ─── Note moderation ───
    socket.on(EVENTS.ADMIN_NOTE_DELETE, (data: { id?: string }) => {
      const id = data?.id;
      if (!isValidNoteId(id)) return;
      if (!this.noteStore.remove(id)) return;
      // The note's photo (if any) is now orphaned — delete it too.
      fs.rm(path.join(NOTE_IMAGES_DIR, `${id}.webp`), { force: true }, () => {});
      // Delete the note's chat room (messages + file on disk).
      this.chatStore.deleteRoom(id);
      this.io.to('game').to('monitor').to('admin').emit(EVENTS.NOTE_REMOVE, { id });
      void this.noteStore.saveToDiskAsync(NOTES_FILE);
      auditLog('note deleted', `${id} (${adminIp})`);
    });

    socket.on(EVENTS.ADMIN_NOTE_EDIT, (data: AdminNoteEdit) => {
      const id = data?.id;
      if (!isValidNoteId(id)) return;
      const note = this.noteStore.edit(id, data.text);
      if (!note) return;
      this.io.to('game').to('monitor').to('admin').emit(EVENTS.NOTE_UPDATE, note);
      void this.noteStore.saveToDiskAsync(NOTES_FILE);
      auditLog('note edited', `${id} (${adminIp})`);
    });

    // Detach a note's real-sticker photo (the upload itself is the HTTP endpoint
    // POST /api/admin/note-image). Clears the pointer, deletes the file, and
    // broadcasts the now-text-only note.
    socket.on(EVENTS.ADMIN_NOTE_IMAGE_REMOVE, (data: { id?: string }) => {
      const id = data?.id;
      if (!isValidNoteId(id)) return;
      const note = this.noteStore.clearImage(id);
      if (!note) return;
      fs.rm(path.join(NOTE_IMAGES_DIR, `${id}.webp`), { force: true }, () => {});
      this.io.to('game').to('monitor').to('admin').emit(EVENTS.NOTE_UPDATE, note);
      void this.noteStore.saveToDiskAsync(NOTES_FILE);
      auditLog('note image removed', `${id} (${adminIp})`);
    });

    // Save (or clear) a note's printable sticker design. The design is a
    // self-describing config (validated/clamped in NoteStore.setSticker); pass
    // sticker:null to remove. Broadcasts the updated note so every surface sees it.
    socket.on(EVENTS.ADMIN_NOTE_STICKER, (data: AdminNoteSticker) => {
      const id = data?.id;
      if (!isValidNoteId(id)) return;
      const note = this.noteStore.setSticker(id, data.sticker);
      if (!note) return;
      this.io.to('game').to('monitor').to('admin').emit(EVENTS.NOTE_UPDATE, note);
      void this.noteStore.saveToDiskAsync(NOTES_FILE);
      auditLog(data.sticker ? 'note sticker saved' : 'note sticker cleared', `${id} (${adminIp})`);
    });

    // ─── Broadcast a message to every player (transient, distinct style) ───
    socket.on(EVENTS.ADMIN_BROADCAST, (data: AdminBroadcast) => {
      const text = typeof data?.text === 'string' ? data.text.trim().slice(0, 280) : '';
      if (text.length === 0) return;
      this.io
        .to('game')
        .to('monitor')
        .emit(EVENTS.ADMIN_ANNOUNCE, { id: `a${Date.now()}`, text });
    });

    // ─── Cleanups (fresh-run resets) — destructive, so audited. ───
    socket.on(EVENTS.ADMIN_RESET_PATHS, () => {
      this.leakGrid.reset();
      void this.leakGrid.saveToDiskAsync(GRID_FILE);
      this.io.to('game').to('monitor').emit(EVENTS.GRID_RESET);
      this.tdRoom.sendReset(this.leakGrid);
      auditLog('RESET all paths', adminIp);
    });

    socket.on(EVENTS.ADMIN_RESET_NOTES, () => {
      this.noteStore.clear();
      this.chatStore.clearAll();
      void this.noteStore.saveToDiskAsync(NOTES_FILE);
      this.io.to('game').to('monitor').to('admin').emit(EVENTS.NOTE_RESET);
      auditLog('RESET all notes', adminIp);
    });

    socket.on(EVENTS.ADMIN_RESET_KILLS, () => {
      this.killStore.clear();
      void this.killStore.saveToDiskAsync(KILLS_FILE);
      this.io.to('game').to('monitor').to('admin').emit(EVENTS.KILL_RESET);
      auditLog('RESET all kill markers', adminIp);
    });

    // ─── Kick a connected player ───
    socket.on(EVENTS.ADMIN_KICK, (data: AdminKick) => {
      if (!data || typeof data.id !== 'string') return;
      this.io.sockets.sockets.get(data.id)?.disconnect(true);
      auditLog('player kicked', `${data.id} (${adminIp})`);
    });

    // ─── Monitor background-image opacity ───
    socket.on(EVENTS.ADMIN_MAP_OPACITY, (data: AdminMapOpacity) => {
      if (!data || typeof data.value !== 'number' || !Number.isFinite(data.value)) return;
      this.mapOpacity = Math.max(0, Math.min(1, data.value));
      this.io.to('monitor').to('admin').emit(EVENTS.ADMIN_MAP_OPACITY, { value: this.mapOpacity });
    });

    socket.on('disconnect', () => {
      console.log('Admin disconnected:', socket.id);
    });
  }

  private buildAdminStats(): AdminStats {
    return {
      players: this.players.size,
      leakedPercentage: this.leakGrid.getPercentage(),
      enemies: this.enemyManager.count,
      notes: this.noteStore.getCount(),
      kills: this.killStore.getCount(),
      tickMs: this.getTickMetrics(),
      uptime: process.uptime(),
    };
  }

  private buildAdminPlayers(): AdminPlayerInfo[] {
    return Array.from(this.players.values()).map(({ id, x, y, color, character }) => ({
      id,
      x,
      y,
      color,
      character,
    }));
  }

  private handleGameConnection(socket: Socket): void {
    if (this.players.size >= MAX_PLAYERS) {
      console.warn(`Player count at cap (${this.players.size}); rejecting ${socket.id}`);
      socket.emit('server:full');
      socket.disconnect(true);
      return;
    }

    // Character chosen in the intro, passed in the handshake query (like `role`).
    // A known character supplies its signature color + shape; anon / unknown
    // falls back to the classic random color and the circle shape.
    const rawCharId = socket.handshake.query.character;
    const charId = Array.isArray(rawCharId) ? rawCharId[0] : rawCharId;

    // Batman is privileged: only granted to a socket presenting a valid admin
    // session cookie (server-enforced). A bare ?character=batman with no/invalid
    // cookie falls through to the anonymous circle. An authed Batman is also
    // flagged so its notes are marked as "creator" notes.
    const adminToken = readAdminToken(socket.handshake.headers.cookie);
    const isAuthedBatman =
      charId === ADMIN_CHARACTER_ID && this.adminAuth.validate(adminToken);

    let character;
    if (charId === ADMIN_CHARACTER_ID) {
      character = isAuthedBatman ? ADMIN_CHARACTER : undefined; // unauthed → anon
    } else {
      character = getCharacter(charId);
    }
    if (isAuthedBatman) this.adminSocketIds.add(socket.id);

    const color = character?.color ?? this.randomColor();
    const startX = SPAWN.x;
    const startY = SPAWN.y;

    const playerState: PlayerState = {
      id: socket.id,
      x: startX,
      y: startY,
      color,
      character: character?.id ?? ANON_CHARACTER_ID,
    };
    this.players.set(socket.id, playerState);
    socket.join('game');

    // Tell the new player about themselves.
    socket.emit(EVENTS.PLAYER_SELF, playerState);

    // Tell the new player about all existing players (including self).
    socket.emit(EVENTS.PLAYER_EXISTING, Array.from(this.players.values()));

    // Send the full persistent leak grid so the new player sees every path
    // walked so far (anonymous, survives restarts). Deltas stream each tick.
    socket.emit(EVENTS.GRID_FULL, this.leakGrid.getFullBuffer());

    // Send every sticky note (anonymous, persistent) so the new player sees all
    // pinned text from the start.
    socket.emit(EVENTS.NOTE_EXISTING, this.noteStore.getAll());

    // Send every persistent kill marker so the new player sees the city's hunt
    // history (tombstones where enemies have fallen).
    socket.emit(EVENTS.KILL_EXISTING, this.killStore.getAll());

    // Send the current enemies so the new player sees them immediately (positions
    // then stream every tick via ENEMY_UPDATE).
    socket.emit(EVENTS.ENEMY_EXISTING, this.enemyManager.getStates());

    // Tell everyone else (game + monitor) about the new player.
    socket.to('game').to('monitor').emit(EVENTS.PLAYER_JOIN, playerState);

    socket.on(EVENTS.PLAYER_MOVE, (data: PlayerMove) => {
      const player = this.players.get(socket.id);
      if (!player) return;
      if (typeof data?.x !== 'number' || typeof data?.y !== 'number') return;
      player.x = clamp(data.x, MAP_BOUNDS.minX, MAP_BOUNDS.maxX);
      player.y = clamp(data.y, MAP_BOUNDS.minY, MAP_BOUNDS.maxY);
    });

    // A player "sticks" a note: validate + persist, then broadcast to everyone
    // (game + monitor) so the icon appears for all clients live.
    socket.on(EVENTS.NOTE_CREATE, (data: NoteCreate) => {
      const note = this.noteStore.create(data, MAP_BOUNDS, this.adminSocketIds.has(socket.id));
      if (!note) return;
      this.io.to('game').to('monitor').to('admin').emit(EVENTS.NOTE_NEW, note);
      void this.noteStore.saveToDiskAsync(NOTES_FILE);
    });

    socket.on('disconnect', () => {
      this.players.delete(socket.id);
      this.adminSocketIds.delete(socket.id);
      this.io.to('game').to('monitor').emit(EVENTS.PLAYER_LEAVE, { id: socket.id });
    });
  }

  private tick(): void {
    const start = performance.now();
    const states = Array.from(this.players.values());

    // Newly leaked cells this tick (player trails + enemy-death splashes), sent
    // as one combined grid delta at the end.
    const newCells: number[] = [];

    // 1. Broadcast positions (slim PlayerPos — static color/character already sent on join).
    if (states.length > 0) {
      const positions: PlayerPos[] = states.map(({ id, x, y }) => ({ id, x, y }));
      this.io.to('game').to('monitor').emit(EVENTS.STATE_UPDATE, positions);
    }

    // 1b. Advance enemies (server-authoritative NPCs). Fixed dt = the tick period
    //     so motion is independent of broadcast jitter. Broadcast spawn / silent
    //     despawn / KILLED deltas, then stream every enemy's position to game +
    //     monitor. Player ids ride along so the hunt can credit nearby hunters.
    const { spawned, despawned, died } = this.enemyManager.update(
      states.map(({ id, x, y }) => ({ id, x, y })),
      1 / TICK_RATE
    );
    for (const e of spawned) this.io.to('game').to('monitor').emit(EVENTS.ENEMY_JOIN, e);
    for (const id of despawned) {
      this.io.to('game').to('monitor').emit(EVENTS.ENEMY_LEAVE, { id });
    }
    for (const death of died) this.handleEnemyDeath(death, newCells);
    if (this.enemyManager.count > 0) {
      this.io.to('game').to('monitor').emit(EVENTS.ENEMY_UPDATE, this.enemyManager.getPositions());
    }

    // 2. Update the leak grid for each player, collecting newly marked cells.
    for (const player of states) {
      const { cellX, cellY } = this.leakGrid.worldToCell(player.x, player.y, MAP_BOUNDS);
      if (this.leakGrid.mark(cellX, cellY)) {
        newCells.push(cellY * GRID_SIZE + cellX);
      }
    }

    // 3. Send delta to the TD room AND the game room (only if new cells were
    //    marked) so every player's path overlay updates live.
    if (newCells.length > 0) {
      this.tdRoom.sendDelta(newCells);
      this.io.to('game').to('monitor').emit(EVENTS.GRID_DELTA, { cells: newCells });
    }

    // 4. Send stats roughly once per second (every TICK_RATE ticks).
    this.statsTickCounter++;
    if (this.statsTickCounter >= TICK_RATE) {
      this.statsTickCounter = 0;
      this.tdRoom.sendStats(this.leakGrid, this.players.size);
      this.io.to('monitor').emit(EVENTS.GRID_STATS, {
        totalLeaked: this.leakGrid.getLeakedCount(),
        percentage: this.leakGrid.getPercentage(),
        playerCount: this.players.size,
      });
      // Live admin dashboard + player list.
      this.io.to('admin').emit(EVENTS.ADMIN_STATS, this.buildAdminStats());
      this.io.to('admin').emit(EVENTS.ADMIN_PLAYERS, this.buildAdminPlayers());
    }

    // Record tick timing (EMA for a stable average; track the worst spike).
    const dur = performance.now() - start;
    this.lastTickMs = dur;
    this.avgTickMs = this.avgTickMs === 0 ? dur : this.avgTickMs * 0.95 + dur * 0.05;
    if (dur > this.maxTickMs) this.maxTickMs = dur;
  }

  /**
   * An enemy was hunted down. Paint a celebratory leak splash where it fell
   * (collecting the new cells into this tick's delta), drop a persistent kill
   * marker, and broadcast the death so every client plays the scream→explosion
   * FX (and the credited hunters' clients show the success popup).
   */
  private handleEnemyDeath(death: EnemyDie, newCells: number[]): void {
    this.markSplash(death.x, death.y, newCells);
    const marker = this.killStore.create(death.x, death.y, death.kind, MAP_BOUNDS);
    this.io.to('game').to('monitor').emit(EVENTS.ENEMY_DIE, death);
    this.io.to('game').to('monitor').emit(EVENTS.KILL_NEW, marker);
    void this.killStore.saveToDiskAsync(KILLS_FILE);
  }

  /** Mark a filled disc of leak cells around a world point (a "burst" of leak). */
  private markSplash(worldX: number, worldY: number, newCells: number[]): void {
    const center = this.leakGrid.worldToCell(worldX, worldY, MAP_BOUNDS);
    // Convert the world radius to a cell radius via the grid's cells-per-unit.
    const rCells = Math.max(1, Math.round((ENEMY_KILL_SPLASH_RADIUS / MAP_BOUNDS.width) * GRID_SIZE));
    const r2 = rCells * rCells;
    for (let dy = -rCells; dy <= rCells; dy++) {
      for (let dx = -rCells; dx <= rCells; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const cx = center.cellX + dx;
        const cy = center.cellY + dy;
        if (this.leakGrid.mark(cx, cy)) newCells.push(cy * GRID_SIZE + cx);
      }
    }
  }

  getKillCount(): number {
    return this.killStore.getCount();
  }

  private randomColor(): string {
    const hue = Math.floor(Math.random() * 360);
    const saturation = 70 + Math.floor(Math.random() * 30); // 70-100%
    const lightness = 45 + Math.floor(Math.random() * 20); // 45-65%
    return hslToHex(hue, saturation, lightness);
  }
}
