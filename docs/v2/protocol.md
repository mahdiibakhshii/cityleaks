# Socket.IO Protocol

## Rooms

| Room Name | Who Joins | Purpose |
|---|---|---|
| `game` | Browser clients (players) | Player state synchronization |
| `td` | TouchDesigner client(s) | Leak grid data delivery |

Clients join rooms automatically on connection (server puts them in the right room based on a handshake query param or the connection handler).

**Game clients** connect normally — they are placed in the `game` room by default.

**TD clients** connect with a query parameter `?role=td` — the server detects this and puts them in the `td` room instead.

```typescript
// TD connects with:
const socket = io('http://server:3000', { query: { role: 'td' } });

// Server detects:
io.on('connection', (socket) => {
  const role = socket.handshake.query.role;
  if (role === 'td') {
    socket.join('td');
    tdRoom.onConnect(socket);
    return;
  }
  // Normal game client
  socket.join('game');
  // ... game handler setup
});
```

## Game Room Events

### Server → Client

#### `player:self`
Sent to a client immediately after connection. Contains their own player data.

```typescript
{
  id: string;      // Socket ID (used to identify self in state updates)
  x: number;       // Starting X position
  y: number;       // Starting Y position
  color: string;   // Assigned hex color, e.g., "#ff3366"
}
```

#### `player:existing`
Sent to a client immediately after connection. Array of all currently connected players (including self).

```typescript
[
  { id: string, x: number, y: number, color: string },
  { id: string, x: number, y: number, color: string },
  ...
]
```

#### `player:join`
Broadcast to all clients when a new player connects (excluding the new player themselves).

```typescript
{
  id: string;
  x: number;
  y: number;
  color: string;
}
```

#### `player:leave`
Broadcast to all clients when a player disconnects.

```typescript
{
  id: string;
}
```

#### `state:update`
Broadcast to all clients **10 times per second** (100ms interval). Contains the positions of all players.

```typescript
[
  { id: string, x: number, y: number, color: string },
  { id: string, x: number, y: number, color: string },
  ...
]
```

**Note:** This includes the local player's server-side position. The client can compare this with their local position for discrepancy detection, but should NOT snap to it (would cause jitter). Client-side position is authoritative for rendering; server position is authoritative for the leak grid.

### Client → Server

#### `player:move`
Sent by the client at a maximum rate of **10 Hz** (throttled client-side). Contains the player's current position after local collision resolution.

```typescript
{
  x: number;
  y: number;
}
```

The server updates the player's state with these coordinates (after clamping to map bounds).

## Sticky Note Events

Anonymous text pinned to a map location. Sent to **game and monitor** clients
(not TD). Full spec: [sticky-notes.md](sticky-notes.md).

### Server → Client

#### `note:existing`
Sent on connect (after the player/grid snapshots). Array of every persisted note.

```typescript
[
  { id: string, x: number, y: number, text: string, createdAt: number },
  ...
]
```

#### `note:new`
Broadcast to game + monitor whenever any player sticks a note (including the
author — there is no optimistic local insert).

```typescript
{ id: string, x: number, y: number, text: string, createdAt: number }
```

### Client → Server

#### `note:create`
A player "sticks" a note. The server trims/length-caps the text
(`NOTE_MAX_LENGTH`), rejects empty text, clamps `x`/`y` to map bounds, assigns
`id` + `createdAt`, persists to `server/data/notes.json`, then broadcasts
`note:new`.

```typescript
{ x: number, y: number, text: string }
```

## TD Room Events

### Server → TD

#### `grid:full`
Sent once when a TD client connects. The entire leak grid as a bit-packed binary buffer.

```typescript
// Payload: ArrayBuffer (125,000 bytes = 1,000,000 bits)
// Each bit: 0 = unvisited, 1 = visited (leaked)
// Bit layout: byte[i] contains bits for cells i*8 to i*8+7
// Cell index = row * 1000 + col
```

#### `grid:delta`
Sent every server tick (10 Hz) **only if new cells were marked** since the last tick. Contains an array of flat cell indices.

```typescript
{
  cells: number[];  // Array of flat indices into the 1000×1000 grid
                    // index = row * 1000 + col
                    // Example: cell (42, 17) → index = 17 * 1000 + 42 = 17042
}
```

**Typical payload size:** A few hundred bytes at most. With 100 players moving at 10 Hz, at most 100 new cells per tick (usually much fewer since players revisit cells).

#### `grid:stats`
Optional — sent with each delta for monitoring:

```typescript
{
  totalLeaked: number;    // Total cells marked out of 1,000,000
  percentage: number;     // totalLeaked / 1000000 * 100
  playerCount: number;    // Current online players
}
```

### TD → Server

#### `grid:reset`
Clears the entire leak grid. Used to start a fresh visualization session.

```typescript
{}  // No payload needed
```

The server:
1. Clears the in-memory grid
2. Saves the empty grid to disk (overwrites the persist file)
3. Confirms with `grid:full` (all zeros)

## Data Flow Diagram

```
                                        ┌─── 10 Hz ───┐
                                        │              │
  Client A ──player:move──► Server ──state:update──► Client A
  Client B ──player:move──►   │                    ► Client B
  Client C ──player:move──►   │                    ► Client C
                              │
                              ├── leak grid update ──┐
                              │                      │
                              │     ┌────────────────┘
                              │     │
                              └── grid:delta ──► TD Client
```

## Connection Lifecycle

### Game Client

```
1. Client opens page → Socket.IO connects
2. Server receives 'connection'
3. Server → Client: 'player:self' {id, x, y, color}
4. Server → Client: 'player:existing' [{...}, {...}]
5. Server → All others: 'player:join' {id, x, y, color}
6. Client starts sending 'player:move' at ≤10 Hz
7. Server sends 'state:update' at 10 Hz
   ... (game plays) ...
8. Client disconnects (tab close, network drop)
9. Server → All: 'player:leave' {id}
10. Server removes player from state map
```

### TD Client

```
1. TD connects with ?role=td
2. Server → TD: 'grid:full' (125 KB binary buffer)
3. Server sends 'grid:delta' each tick with new cells
   ... (visualization runs) ...
4. TD can send 'grid:reset' at any time
5. Server clears grid, sends new 'grid:full' (all zeros)
```

### Reconnection

Socket.IO handles reconnection automatically. On reconnect:
- Client gets a **new socket ID** (different player identity)
- Server treats them as a new player (new color, spawn position)
- Old ghost player was already removed on disconnect
- This is intentional — no persistent identity in CityLeaks

## Bandwidth Estimates

### Per Client (incoming from server)

| Event | Size per message | Rate | Bandwidth |
|---|---|---|---|
| `state:update` (100 players) | ~5 KB | 10 Hz | ~50 KB/s |
| `player:join` / `player:leave` | ~100 bytes | Rare | Negligible |

**~50 KB/s per client** with 100 players. Acceptable for mobile (4G = 1-10 MB/s+).

### Per Client (outgoing to server)

| Event | Size | Rate | Bandwidth |
|---|---|---|---|
| `player:move` | ~30 bytes | 10 Hz | ~300 B/s |

### TD Client (incoming)

| Event | Size | Rate | Bandwidth |
|---|---|---|---|
| `grid:full` (on connect) | 125 KB | Once | 125 KB |
| `grid:delta` | ~100-400 bytes | 10 Hz | ~1-4 KB/s |

Extremely lightweight.

## Constants (shared/protocol.ts)

```typescript
// Event names
export const EVENTS = {
  PLAYER_SELF: 'player:self',
  PLAYER_EXISTING: 'player:existing',
  PLAYER_JOIN: 'player:join',
  PLAYER_LEAVE: 'player:leave',
  PLAYER_MOVE: 'player:move',
  STATE_UPDATE: 'state:update',
  GRID_FULL: 'grid:full',
  GRID_DELTA: 'grid:delta',
  GRID_STATS: 'grid:stats',
  GRID_RESET: 'grid:reset',
  NOTE_EXISTING: 'note:existing',  // server → client: all notes on connect
  NOTE_NEW: 'note:new',            // server → client: one newly stuck note
  NOTE_CREATE: 'note:create',      // client → server: stick a note
} as const;

// Timing
export const TICK_RATE = 10;                    // Server broadcast Hz
export const CLIENT_SEND_RATE = 10;             // Max client send Hz
export const GRID_SAVE_INTERVAL = 30_000;       // ms between disk saves

// Game
export const GRID_SIZE = 1000;                  // 1000×1000 leak grid
export const MAX_PLAYERS = 150;                 // Soft cap
export const PLAYER_RADIUS = 8;                 // World units
export const PLAYER_SPEED = 150;                // World units per second

// Sticky notes
export const NOTE_MAX_LENGTH = 200;             // Max chars per note
export const NOTE_REVEAL_RADIUS = 120;          // World units to reveal text
```
