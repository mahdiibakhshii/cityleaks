import type { Server, Socket } from 'socket.io';
import {
  EVENTS,
  TICK_RATE,
  GRID_SAVE_INTERVAL,
  MAX_PLAYERS,
  GRID_SIZE,
  ANON_CHARACTER_ID,
  getCharacter,
  type PlayerState,
  type PlayerMove,
  type PlayerPos,
  type NoteCreate,
} from '../../shared/protocol';
import { LeakGrid } from './LeakGrid';
import { NoteStore } from './NoteStore';
import { TDRoom } from './TDRoom';
import { EnemyManager } from './EnemyManager';
import { MAP_BOUNDS, SPAWN, GRID_FILE, NOTES_FILE } from './config';

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
  private tdRoom: TDRoom;
  private enemyManager: EnemyManager;
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
    tdRoom: TDRoom,
    enemyManager: EnemyManager
  ) {
    this.io = io;
    this.leakGrid = leakGrid;
    this.noteStore = noteStore;
    this.tdRoom = tdRoom;
    this.enemyManager = enemyManager;
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
    socket.emit(EVENTS.ENEMY_EXISTING, this.enemyManager.getStates());

    socket.on('disconnect', () => {
      console.log('Monitor disconnected:', socket.id);
    });
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
    const character = getCharacter(charId);
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
      const note = this.noteStore.create(data, MAP_BOUNDS);
      if (!note) return;
      this.io.to('game').to('monitor').emit(EVENTS.NOTE_NEW, note);
      void this.noteStore.saveToDiskAsync(NOTES_FILE);
    });

    socket.on('disconnect', () => {
      this.players.delete(socket.id);
      this.io.to('game').to('monitor').emit(EVENTS.PLAYER_LEAVE, { id: socket.id });
    });
  }

  private tick(): void {
    const start = performance.now();
    const states = Array.from(this.players.values());

    // 1. Broadcast positions (slim PlayerPos — static color/character already sent on join).
    if (states.length > 0) {
      const positions: PlayerPos[] = states.map(({ id, x, y }) => ({ id, x, y }));
      this.io.to('game').to('monitor').emit(EVENTS.STATE_UPDATE, positions);
    }

    // 1b. Advance enemies (server-authoritative NPCs). Fixed dt = the tick period
    //     so motion is independent of broadcast jitter. Broadcast spawn/despawn
    //     deltas, then stream every enemy's position to game + monitor.
    const { spawned, despawned } = this.enemyManager.update(
      states.map(({ x, y }) => ({ x, y })),
      1 / TICK_RATE
    );
    for (const e of spawned) this.io.to('game').to('monitor').emit(EVENTS.ENEMY_JOIN, e);
    for (const id of despawned) {
      this.io.to('game').to('monitor').emit(EVENTS.ENEMY_LEAVE, { id });
    }
    if (this.enemyManager.count > 0) {
      this.io.to('game').to('monitor').emit(EVENTS.ENEMY_UPDATE, this.enemyManager.getPositions());
    }

    // 2. Update the leak grid for each player, collecting newly marked cells.
    const newCells: number[] = [];
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
    }

    // Record tick timing (EMA for a stable average; track the worst spike).
    const dur = performance.now() - start;
    this.lastTickMs = dur;
    this.avgTickMs = this.avgTickMs === 0 ? dur : this.avgTickMs * 0.95 + dur * 0.05;
    if (dur > this.maxTickMs) this.maxTickMs = dur;
  }

  private randomColor(): string {
    const hue = Math.floor(Math.random() * 360);
    const saturation = 70 + Math.floor(Math.random() * 30); // 70-100%
    const lightness = 45 + Math.floor(Math.random() * 20); // 45-65%
    return hslToHex(hue, saturation, lightness);
  }
}
