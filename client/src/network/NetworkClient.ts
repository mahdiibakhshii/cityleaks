import { io, Socket } from 'socket.io-client';
import {
  EVENTS,
  type PlayerSelf,
  type PlayerState,
  type PlayerPos,
  type PlayerLeave,
  type GridDelta,
  type Note,
  type EnemyState,
  type EnemyPos,
  type EnemyLeave,
} from '../../../shared/protocol';

export interface NetworkCallbacks {
  onSelf: (self: PlayerSelf) => void;
  onExisting: (players: PlayerState[]) => void;
  onJoin: (player: PlayerState) => void;
  onLeave: (data: PlayerLeave) => void;
  onStateUpdate: (positions: PlayerPos[]) => void;
  onConnectionChange: (connected: boolean) => void;
  onGridFull: (buffer: ArrayBuffer) => void;
  onGridDelta: (cells: number[]) => void;
  onNotesExisting: (notes: Note[]) => void;
  onNoteNew: (note: Note) => void;
  onEnemiesExisting: (enemies: EnemyState[]) => void;
  onEnemyJoin: (enemy: EnemyState) => void;
  onEnemyLeave: (data: EnemyLeave) => void;
  onEnemyUpdate: (positions: EnemyPos[]) => void;
}

/** Socket.IO client: connects, forwards server events, throttles outgoing moves. */
export class NetworkClient {
  private socket: Socket;
  private callbacks: NetworkCallbacks;

  constructor(callbacks: NetworkCallbacks, characterId: string) {
    this.callbacks = callbacks;

    // In dev, Vite proxies /socket.io to the server. Default same-origin connect.
    // The chosen character rides in the handshake query (like `role`); the server
    // uses it to assign our shape + signature color and echo both to all clients.
    this.socket = io({
      transports: ['websocket', 'polling'],
      reconnection: true,
      query: { character: characterId },
    });

    this.socket.on('connect', () => this.callbacks.onConnectionChange(true));
    this.socket.on('disconnect', () => this.callbacks.onConnectionChange(false));

    this.socket.on(EVENTS.PLAYER_SELF, (self: PlayerSelf) => this.callbacks.onSelf(self));
    this.socket.on(EVENTS.PLAYER_EXISTING, (players: PlayerState[]) =>
      this.callbacks.onExisting(players)
    );
    this.socket.on(EVENTS.PLAYER_JOIN, (player: PlayerState) =>
      this.callbacks.onJoin(player)
    );
    this.socket.on(EVENTS.PLAYER_LEAVE, (data: PlayerLeave) =>
      this.callbacks.onLeave(data)
    );
    this.socket.on(EVENTS.STATE_UPDATE, (positions: PlayerPos[]) =>
      this.callbacks.onStateUpdate(positions)
    );

    // Persistent shared leak grid: full snapshot on connect, deltas each tick.
    this.socket.on(EVENTS.GRID_FULL, (buffer: ArrayBuffer) =>
      this.callbacks.onGridFull(buffer)
    );
    this.socket.on(EVENTS.GRID_DELTA, (data: GridDelta) =>
      this.callbacks.onGridDelta(data.cells)
    );

    // Sticky notes: full set on connect, one event per newly-stuck note.
    this.socket.on(EVENTS.NOTE_EXISTING, (notes: Note[]) =>
      this.callbacks.onNotesExisting(notes)
    );
    this.socket.on(EVENTS.NOTE_NEW, (note: Note) => this.callbacks.onNoteNew(note));

    // Enemy NPCs: full set on connect, spawn/despawn events, positions per tick.
    this.socket.on(EVENTS.ENEMY_EXISTING, (enemies: EnemyState[]) =>
      this.callbacks.onEnemiesExisting(enemies)
    );
    this.socket.on(EVENTS.ENEMY_JOIN, (enemy: EnemyState) => this.callbacks.onEnemyJoin(enemy));
    this.socket.on(EVENTS.ENEMY_LEAVE, (data: EnemyLeave) => this.callbacks.onEnemyLeave(data));
    this.socket.on(EVENTS.ENEMY_UPDATE, (positions: EnemyPos[]) =>
      this.callbacks.onEnemyUpdate(positions)
    );
  }

  sendPosition(x: number, y: number): void {
    if (!this.socket.connected) return;
    this.socket.emit(EVENTS.PLAYER_MOVE, { x, y });
  }

  /** "Stick" a note: send text + the world position to pin it at. */
  sendNote(x: number, y: number, text: string): void {
    if (!this.socket.connected) return;
    this.socket.emit(EVENTS.NOTE_CREATE, { x, y, text });
  }

  get id(): string | undefined {
    return this.socket.id;
  }

  dispose(): void {
    this.socket.close();
  }
}
