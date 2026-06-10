# CityLeaks v2

Real-time multiplayer 2D top-down web game. Players are colored circles moving
over an orthographic city photo, constrained to roads by a collision mask. All
movement is anonymously tracked in a 1000×1000 "leak grid" that is rendered
in-game as glowing water-blue **paths**, shown on a whole-city **monitor page**,
and streamed to a **TouchDesigner** client. Full spec in [docs/v2/](docs/v2/).

> **New here?** Read **[CLAUDE.md](CLAUDE.md)** first — it's the current-state
> map: architecture, conventions, key files, asset pipeline, and how to extend.

## Structure

```
shared/protocol.ts   Event names, constants, tile layout, payload types (client + server)
server/              Node + Express + Socket.IO game server, leak grid, rooms (game/monitor/td)
client/              Vite + TypeScript + Three.js — game page + monitor page
tools/               Tile/overview generator (split_tiles.py), load test, smoke test
```

## Run (development)

Two terminals:

```bash
# 1. Game server (port 3000)
cd server && npm install && npm run dev

# 2. Web client (port 5173, proxies /socket.io → :3000)
cd client && npm install && npm run dev
```

- **Game:** http://localhost:5173 — open two tabs to see multiplayer. Desktop
  uses WASD / arrow keys; touch devices get a virtual joystick (bottom-left).
- **Monitor:** http://localhost:5173/monitor.html — whole-city spectator view
  with live paths + player dots (no controls).
- **Status:** `GET http://localhost:3000/api/status` → player count, leak %,
  and server tick metrics (`tickMs: {last, avg, max}`).

## Production

```bash
cd client && npm run build      # → client/dist/ (index.html + monitor.html)
cd server && npm start          # serves client/dist on PORT||3000
```

The server runs TypeScript directly via **`tsx`** — there is **no server build
step** (use `npm run typecheck` to type-check). It serves `client/dist/` as
static files: game at `/`, monitor at `/monitor`.

## Tiles & assets

Tiles are listed explicitly in **`shared/protocol.ts` → `MAP.TILES`** by
`(col, row)` **relative to origin tile (0,0)**; coordinates may be negative.
This is the single source of truth — both client and server read it, so there
is only ONE place to edit when tiles change.

```ts
// shared/protocol.ts
TILE_WIDTH_PX: 1024,
TILE_HEIGHT_PX: 1024,   // all tiles must share this size; set to your export size
TILES: [ {col:0,row:0}, {col:0,row:1}, {col:-1,row:0} ],
```

Drop assets here (filenames may contain negatives, e.g. `tile_-1_0.png`):

```
client/public/tiles/map/tile_{col}_{row}.png    (or .webp — set ASSETS.TILE_EXTENSION_MAP)
client/public/tiles/mask/tile_{col}_{row}.png   (PNG, alpha = collision)
```

- **Map tiles:** WebP (small) or PNG. Recommended **1024×1024**, power-of-two,
  uniform size (cheap ~4 MB GPU upload → smooth streaming; 2048 causes pop-in
  hitches on mobile). You bake the zoom/coverage into how you author each tile.
- **Mask tiles:** PNG with an alpha channel. **Transparent = walkable, opaque =
  blocked (building).** Building color is irrelevant; only opacity matters. Fill
  buildings fully (no transparent holes); hard edges (AA off) are cleanest. The
  threshold is `MASK.ALPHA_THRESHOLD` (alpha ≥ 128 = blocked) in
  `client/src/config.ts`.

**Real assets** — split a large source map + mask into tiles (and a monitor
overview) with the Python tool (`pip install pillow` once):

```bash
python tools/split_tiles.py        # → client/public/tiles/{map,mask}/ + map_overview.webp
```

It outputs 1024px WebP map tiles, PNG mask tiles, a `manifest.json`, and the
downscaled whole-map `map_overview.webp`, then prints the exact `MAP.TILES`
line to paste (e.g. `rectTiles(17, 17)`). Padded edge tiles keep real pixels
aligned. Useful flags: `--overview-only`, `--overview-map <img>` (overview
pixels from an alternate same-extent image), `--origin center`, `--map-format`.

**Dev placeholders** (no real assets needed) for whatever is in `MAP.TILES`:

```bash
node tools/gen-placeholders.mjs
```

## Coordinate convention

**Image coordinates: origin (0,0) at the top-left of tile (0,0), +X right,
+Y DOWN**, 1 unit = 1 source pixel. Movement, collision mask, leak grid, and
the server all use this directly with **no inversions**. Rendering is the only
place Y flips: the scene stores `three_y = -data_y` (a uniform mirror, so
textures stay upright and there are no winding issues).

## Tile streaming

Both map and mask tiles stream dynamically — nothing is loaded all at once, so
this scales to the full Vienna map.

- **Map tiles** (`TileMap`): load tiles overlapping the camera view, plus a small
  *directional* preload margin (`STREAM.TILE_PRELOAD_MARGIN`, ~0.2 tile) so the
  next tile is ready just before its edge scrolls in. Only the side the player
  is approaching is pulled in (corners only when near both edges); far tiles unload.
- **Mask tiles** (`CollisionMask`): keep only tiles within
  `STREAM.MASK_STREAM_MARGIN` (~0.4 tile) of the *player* loaded; unload the rest.
  The margin is far larger than the collision radius, so a neighbor mask is always
  ready before the player crosses into it (an unloaded mask reads as blocked).

Both run a few times per second (movement is slow). Tune the two margins in
`client/src/config.ts → STREAM`.

## Fullscreen / orientation

The camera fits the **shorter screen axis**: `CAMERA.VIEW_MIN_SPAN` world units
are always visible along the shorter dimension, so portrait and landscape both
fill the screen with a consistent view around the player. Recomputed on resize.

## Shared paths (leak grid overlay)

The 1000×1000 leak grid is the anonymous, persistent record of every cell any
player has walked. The server sends `grid:full` (125 KB) on connect and
`grid:delta` each tick; `client/src/game/PathLayer.ts` unpacks it into a texture
drawn over the whole map as a water-blue glow. It persists to disk
(`server/data/leak-grid.bin`), so new players see all prior paths. The local
player marks optimistically each frame (instant trail); the server delta
confirms. Color: `PATH.COLOR`. Finer paths: raise `GRID_SIZE` in
`shared/protocol.ts` (update the TD side too — buffer size changes).

## Monitor page

`/monitor` (dev: `/monitor.html`) is a spectator view of the **whole city** at
once: a downscaled `map_overview.webp`, the live paths (reusing `PathLayer`),
and every player as a colored dot. It connects as `role=monitor`, so the server
streams it the grid + positions **without spawning a player or marking cells**.
Tune in `client/src/config.ts → MONITOR`.

## TouchDesigner

Connect with `?role=td`. Receives `grid:full` (125 KB bit-packed buffer) on
connect, then `grid:delta` (`{cells: number[]}`) each tick when new cells are
marked. Send `grid:reset` to clear. See [docs/v2/leak-grid.md](docs/v2/leak-grid.md).

## Tests

```bash
node tools/smoke-test.mjs        # server running → 7 protocol checks (join/leave, state, TD grid)
node tools/load-test.mjs         # stress: 100 bots × 10 Hz moves; reads tick metrics from /api/status
BOTS=150 DURATION=30 node tools/load-test.mjs   # env: BOTS DURATION RATE URL MAP_SPAN STEP RAMP
```

Stress target: peak server tick < 50 ms while broadcasts hold ~10 Hz. Last run:
**140 bots → avg ~5 ms, peak ~41 ms, 0 errors.**
