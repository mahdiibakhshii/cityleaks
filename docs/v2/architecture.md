# Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        RUNTIME SYSTEM                               │
│                                                                     │
│  ┌──────────────────────────┐       ┌────────────────────────────┐  │
│  │  Web Client (Browser)    │       │  Game Server (Node.js)     │  │
│  │                          │       │                            │  │
│  │  Three.js scene          │  WS   │  Socket.IO                 │  │
│  │  ├─ Map tile planes      │◄─────►│  ├─ "game" room (browsers) │  │
│  │  ├─ Player circles       │       │  └─ "td" room (TouchDesigner)│ │
│  │  └─ OrthographicCamera   │       │                            │  │
│  │                          │       │  Game loop (10 Hz)         │  │
│  │  Collision mask (canvas) │       │  ├─ Broadcast positions    │  │
│  │  Input (keyboard/joypad) │       │  ├─ Update leak grid       │  │
│  │                          │       │  └─ Send grid deltas to TD │  │
│  └──────────────────────────┘       │                            │  │
│                                     │  Leak grid (1000×1000 bits)│  │
│  ┌──────────────────────────┐       │  Periodic save to disk     │  │
│  │  TouchDesigner Client    │  WS   │                            │  │
│  │  Receives leak grid data │◄──────│                            │  │
│  │  Renders flow visuals    │       └────────────────────────────┘  │
│  └──────────────────────────┘                                       │
│                                                                     │
│  ┌──────────────────────────┐                                       │
│  │  Static File Server      │                                       │
│  │  Serves map + mask tiles │──────► Browser loads via HTTP          │
│  │  (Express static or CDN) │                                       │
│  └──────────────────────────┘                                       │
└─────────────────────────────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology | Version | Purpose |
|---|---|---|---|
| Client bundler | **Vite** | latest | Dev server, HMR, TypeScript, production build |
| Client language | **TypeScript** | 5.x | Type safety across client and server |
| Client renderer | **Three.js** | r168+ | WebGL rendering — OrthographicCamera, textured planes, circle meshes |
| Mobile joystick | **nipple.js** | ^0.10 | Virtual joystick overlay for touch devices |
| Networking (client) | **socket.io-client** | ^4.x | WebSocket with reconnection + fallback |
| Server runtime | **Node.js** | 20+ LTS | JavaScript server |
| Server framework | **Express** | ^4.x | HTTP server for static files + health endpoint |
| Networking (server) | **socket.io** | ^4.x | WebSocket server with rooms |
| Persistence | **File system** | — | Leak grid saved as binary file (no database) |

## Project Structure

All new code lives in two top-level directories: `client/` and `server/`. There is also a `shared/` directory for types used by both.

```
f:\unity projects\CityLeaks\
│
├── client/                          # Vite + Three.js web client
│   ├── index.html                   # Single HTML page, mounts canvas
│   ├── package.json                 # Dependencies: three, nipplejs, socket.io-client
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── public/
│   │   └── tiles/                   # Static tile assets (user provides)
│   │       ├── map/                 # Orthographic photo tiles
│   │       │   ├── tile_0_0.webp    # Example naming — configurable
│   │       │   ├── tile_1_0.webp
│   │       │   └── ...
│   │       └── mask/                # Collision mask tiles (matching layout)
│   │           ├── tile_0_0.png     # White = walkable, black = blocked
│   │           ├── tile_1_0.png
│   │           └── ...
│   └── src/
│       ├── main.ts                  # Entry — creates Game instance, starts loop
│       ├── config.ts                # All configurable constants (tile layout, speeds, etc.)
│       ├── game/
│       │   ├── Game.ts              # Three.js setup, render loop, orchestrator
│       │   ├── Camera.ts            # OrthographicCamera, follow player, clamp to map bounds
│       │   ├── TileMap.ts           # Load/unload map tile textures onto planes
│       │   ├── CollisionMask.ts     # Load mask into canvas, pixel-sample walkability
│       │   ├── Player.ts            # Local player — circle mesh, movement, collision
│       │   ├── RemotePlayer.ts      # Other player — interpolated position, colored circle
│       │   └── PlayerManager.ts     # Create/destroy/update all remote player instances
│       ├── input/
│       │   ├── InputManager.ts      # Unified direction vector from keyboard + joystick
│       │   ├── Keyboard.ts          # Arrow keys / WASD
│       │   └── Joystick.ts          # nipple.js wrapper
│       ├── network/
│       │   └── NetworkClient.ts     # Socket.IO connect, send moves, receive state
│       └── styles/
│           └── main.css             # Full-viewport canvas, joystick positioning
│
├── server/                          # Node.js + Socket.IO game server
│   ├── package.json                 # Dependencies: express, socket.io
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                 # Express + Socket.IO bootstrap, starts game loop
│       ├── GameServer.ts            # Player state, 10 Hz tick, broadcasts
│       ├── LeakGrid.ts              # 1000×1000 bit grid, mark/query/serialize
│       ├── TDRoom.ts                # TouchDesigner room handler
│       └── types.ts                 # Server-side type definitions
│
├── shared/                          # Shared between client and server
│   └── protocol.ts                  # Event names, payload interfaces, constants
│
├── docs/v2/                         # These specification documents
└── ... (legacy Unity/pipeline code — ignore)
```

## Setup & Run Commands

### Server

```bash
cd server
npm install
npm run dev          # ts-node or tsx with watch mode
```

Server listens on port `3000` by default (configurable via `PORT` env var).

### Client

```bash
cd client
npm install
npm run dev          # Vite dev server with HMR
```

Vite dev server on port `5173`. In development, configure `vite.config.ts` to proxy `/socket.io` requests to the server on port 3000.

### Production

```bash
cd client
npm run build        # Outputs to client/dist/
```

In production, the Express server in `server/` serves the built client from `client/dist/` as static files, plus the tile assets.

## Network Topology

```
Browser Client 1  ──┐
Browser Client 2  ──┤
       ...        ──┼── WebSocket ──► Game Server (port 3000)
Browser Client N  ──┤                    ├── "game" room
TouchDesigner     ──┘                    └── "td" room
```

All connections go to a single Node.js process. No load balancer needed for 100 players.
