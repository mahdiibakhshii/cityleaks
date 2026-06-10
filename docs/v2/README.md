# CityLeaks v2 — Web-Native Multiplayer City Exploration Game

> **This folder contains the complete specification for building CityLeaks v2.**
> Read these documents in order before writing any code.

## What Is CityLeaks v2?

A **real-time multiplayer 2D top-down web game** where:

- Players are **colored circles** moving over a high-resolution **orthographic city photograph**
- Movement is constrained to **roads only** — a binary collision mask (white = walkable, dark = blocked) prevents walking through buildings
- A **camera follows** each player, scrolling the city image like a 2D top-down view
- Up to **100+ concurrent players** see each other in real-time
- All movement is tracked anonymously in a **1000×1000 "leak grid"** — when any player walks through a cell, it's permanently marked
- Players can pin anonymous **sticky notes** (short text) to a location; an icon marks each note and walking close reveals its text fullscreen (see [sticky-notes.md](sticky-notes.md))
- A **TouchDesigner** process connects to the server and receives the leak grid in real-time, visualizing collective movement as water-like flows
- The game must work on **mobile (iOS + Android) and desktop** browsers

## Context — What Exists Already

This project previously had a Unity-based prototype in `CityLeaksUnity/` and a Python pipeline in `pipeline/`. **Ignore all of that.** The v2 is a complete rewrite as a web application. The old code and docs outside `docs/v2/` are irrelevant.

## Documents (Read In Order)

| # | File | What It Covers |
|---|---|---|
| 1 | [architecture.md](architecture.md) | System architecture, tech stack, project structure, build & run commands |
| 2 | [tile-system.md](tile-system.md) | Map tile loading, collision mask, coordinate systems |
| 3 | [client-spec.md](client-spec.md) | Three.js renderer, game loop, camera, player rendering |
| 4 | [input-system.md](input-system.md) | Keyboard + mobile virtual joystick input handling |
| 5 | [server-spec.md](server-spec.md) | Node.js game server, player management, game loop |
| 6 | [protocol.md](protocol.md) | Socket.IO events, payloads, rooms, timing |
| 7 | [leak-grid.md](leak-grid.md) | 1000×1000 anonymous grid system + TouchDesigner integration |
| 8 | [build-phases.md](build-phases.md) | Implementation order, phases, verification checklist |
| 9 | [sticky-notes.md](sticky-notes.md) | Anonymous text pinned to map locations (added post-Phase-4) |

## What the User Provides (Not Built by the Agent)

These assets are **not in the repo yet**. The system must be designed to accept them via configuration:

1. **Tiled orthographic city photo** — multiple image tiles forming the full map. Naming convention, tile count, and pixel dimensions TBD by user.
2. **Binary collision mask tiles** — same resolution and layout as the map tiles. White pixels = walkable, dark pixels = blocked.
3. **TouchDesigner project** — connects to the server's `td` socket room and consumes leak grid data.

## Key Design Principles

1. **Separation of concerns** — Client handles rendering and input. Server is authoritative for player state and leak tracking.
2. **Mobile-first** — Touch input and responsive layout are not afterthoughts. The joystick and canvas must work on phones.
3. **Anonymous by design** — No user accounts, no persistent identity. Players are temporary colored circles. The leak grid and sticky notes persist (both anonymous/ownerless); player identity does not.
4. **Configurable tiles** — The tile system must be easily reconfigurable (tile count, naming, dimensions) since the user hasn't finalized them yet.
5. **Lean data** — The leak grid is 125 KB. Player state is in-memory only. No heavy database.
