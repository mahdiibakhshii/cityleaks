# Build Phases

## Overview

The implementation is broken into 4 phases. Each phase produces a testable, working increment. **Phase 1 can start immediately** without waiting for tile assets from the user.

> **Status (2026-06-10):** Phases 1–3 complete. Phase 4 largely complete —
> real Vienna tiles + mask + overview generated, production build working
> (`npm start` via tsx), stress test passing (140 bots, avg ~5 ms tick).
> Also added beyond the original spec: the **leak grid is rendered in-game as
> paths** and on a new **monitor page**. Remaining/optional: PWA manifest +
> service-worker tile caching, live TouchDesigner verification. See
> [CLAUDE.md](../../CLAUDE.md) for the authoritative current state.

---

## Phase 1: Server Foundation

**Goal:** A running Socket.IO server that handles player connections, broadcasts state at 10 Hz, maintains the leak grid, and serves the TD room.

### Tasks

- [ ] Initialize `server/` project with `npm init`, install dependencies (express, socket.io, tsx, typescript)
- [ ] Create `server/tsconfig.json`
- [ ] Implement `shared/protocol.ts` with event names, constants, and type interfaces
- [ ] Implement `server/src/LeakGrid.ts` — bit-packed 1000×1000 grid with mark, query, serialize, persist, reset
- [ ] Implement `server/src/TDRoom.ts` — TD connection handler, full grid send, delta send, reset handler
- [ ] Implement `server/src/GameServer.ts` — player map, connection/disconnection, move handler, 10 Hz tick loop, leak grid integration
- [ ] Implement `server/src/index.ts` — Express + Socket.IO bootstrap, health endpoint, static serving
- [ ] Create `server/data/` directory for grid persistence

### Verification

- Start server with `npm run dev`
- Connect with a Socket.IO test client (or browser console) → receive `player:self`
- Open two connections → each sees the other via `state:update`
- Disconnect one → other receives `player:leave`
- Check `GET /api/status` returns player count and grid stats
- Connect as TD (`?role=td`) → receive `grid:full` buffer
- Verify grid persists after server restart

### Notes

- Use placeholder map dimensions (e.g., 5000×5000) until user provides real tile info
- No client UI yet — test with raw Socket.IO connections or a minimal HTML page

---

## Phase 2: Client Rendering & Local Movement

**Goal:** A Three.js application that renders map tiles, shows a player circle, handles keyboard + joystick input, and enforces collision with the mask.

### Tasks

- [ ] Initialize `client/` project with Vite + TypeScript (`npx create-vite`)
- [ ] Install dependencies: three, @types/three, nipplejs, socket.io-client
- [ ] Create `client/index.html` with viewport meta tags and joystick zone div
- [ ] Create `client/src/styles/main.css` — full-viewport canvas, touch-action, joystick positioning
- [ ] Implement `client/src/config.ts` — tile layout, map dimensions, player constants (all configurable)
- [ ] Implement `client/src/game/TileMap.ts` — load map tiles as textured planes, viewport culling
- [ ] Implement `client/src/game/CollisionMask.ts` — load mask tiles into canvas, pixel sampling, circle walkability check
- [ ] Implement `client/src/game/Camera.ts` — OrthographicCamera, follow player, clamp to bounds
- [ ] Implement `client/src/game/Player.ts` — circle mesh, movement with collision, wall sliding
- [ ] Implement `client/src/input/Keyboard.ts` — WASD + arrow keys
- [ ] Implement `client/src/input/Joystick.ts` — nipple.js wrapper
- [ ] Implement `client/src/input/InputManager.ts` — unified direction from keyboard + joystick
- [ ] Implement `client/src/game/Game.ts` — Three.js setup, game loop, orchestration
- [ ] Implement `client/src/main.ts` — entry point
- [ ] Create placeholder tiles (colored rectangles) if user hasn't provided real tiles yet
- [ ] Create placeholder mask (white with black rectangles) for testing collision

### Verification

- `npm run dev` → Vite serves the app on localhost:5173
- Map tiles display correctly, camera follows player
- Arrow keys / WASD move the player smoothly
- Player cannot walk through dark areas of the mask
- Wall sliding works (diagonal movement along walls is smooth, not sticky)
- On a phone (or Chrome DevTools mobile emulator): joystick appears, player moves with touch
- Joystick hidden on desktop (mouse/keyboard device)
- Resize browser → canvas and camera adjust correctly

### Notes

- Use placeholder tiles if real ones aren't available yet — the system should be configurable
- Configure `vite.config.ts` to proxy `/socket.io` to the server for dev mode

---

## Phase 3: Multiplayer Integration

**Goal:** Connect the client to the server. Multiple browsers see each other as colored circles in real-time.

### Tasks

- [ ] Implement `client/src/network/NetworkClient.ts` — Socket.IO client, connect, send moves, receive state
- [ ] Implement `client/src/game/RemotePlayer.ts` — circle mesh, target position, interpolation
- [ ] Implement `client/src/game/PlayerManager.ts` — create/destroy/update remote players from server events
- [ ] Wire NetworkClient into Game.ts:
  - On `player:self` → set local player color and position
  - On `player:existing` → create RemotePlayer instances for all
  - On `player:join` → add new RemotePlayer
  - On `player:leave` → remove RemotePlayer
  - On `state:update` → update all RemotePlayer targets
- [ ] Throttle `player:move` sends to 10 Hz in the game loop
- [ ] Handle reconnection (Socket.IO auto-reconnects; re-initialize player state on reconnect)
- [ ] Add connection status indicator (optional but helpful — "Connected" / "Reconnecting...")

### Verification

- Open two browser tabs (or two devices on same network)
- Both players see each other's colored circles
- Movement is smooth (interpolation, no teleporting)
- Close one tab → other tab removes that player's circle
- Reopen tab → new player appears (new color, new position)
- Open `/api/status` → shows correct player count
- Test on phone + desktop simultaneously

---

## Phase 4: Polish & TD Integration

**Goal:** Production-ready polish, load testing, TD connection verification.

### Tasks

- [x] Swap in real tile images (via `tools/split_tiles.py` → 17×17 WebP tiles)
- [x] Swap in real collision mask (PNG alpha tiles from the same splitter)
- [ ] Tune player speed and radius to feel right on the real map (in progress)
- [ ] Add PWA manifest (`manifest.json`) for "Add to Home Screen" on mobile
- [ ] Add service worker for offline caching of tiles (optional)
- [x] Production build — client `npm run build`; server runs via `tsx` (`npm start`), served from Express
- [ ] Test TD connection (against live TouchDesigner):
  - Connect TD client → verify `grid:full` received correctly
  - Walk around in browsers → verify `grid:delta` events arrive
  - Send `grid:reset` from TD → verify grid clears
- [x] Stress test (`tools/load-test.mjs`):
  - Bot script creates N fake Socket.IO connections (env `BOTS`, default 100)
  - Each bot random-walks and sends `player:move` at 10 Hz
  - Server tick instrumented + exposed on `/api/status` (`tickMs`)
  - **Result: 140 bots → avg ~5 ms, peak ~41 ms, 0 errors (< 50 ms budget)**
  - Periodic leak-grid save made async so it can't block a tick
- [x] Handle edge cases:
  - Player spawns inside a building → `findNearestWalkable` spirals out
  - Mask tiles failing to load read as blocked (no clip-through); server reconnect shows "Reconnecting…"

### Verification

- Real map tiles render correctly on phone and desktop
- Collision feels accurate (player doesn't clip through buildings)
- 100 simulated bots + 1 real player → game is still smooth
- TD receives and visualizes the leak grid
- Grid persists across server restarts
- PWA install works on Android and iOS

---

## Quick Reference — What to Build First

```
1. shared/protocol.ts          ← types + constants used everywhere
2. server/ (all files)         ← can test with raw WebSocket
3. client/ (rendering + input) ← can test offline with placeholders
4. client/network/             ← connect client to server
5. Polish + TD                 ← tune with real assets
```

## Dependency Graph

```
shared/protocol.ts ─────────────┬──────────────────┐
                                │                  │
                    ┌───────────▼──────┐   ┌───────▼─────────┐
                    │  server/         │   │  client/         │
                    │  ├─ LeakGrid.ts  │   │  ├─ config.ts    │
                    │  ├─ TDRoom.ts    │   │  ├─ Game.ts      │
                    │  ├─ GameServer.ts│   │  ├─ TileMap.ts   │
                    │  └─ index.ts     │   │  ├─ Collision.ts │
                    └──────────────────┘   │  ├─ Player.ts    │
                                           │  ├─ Input/       │
                                           │  └─ Network/     │
                                           └─────────────────┘
```

No circular dependencies. `shared/` is imported by both `client/` and `server/`. Client and server never import from each other.
