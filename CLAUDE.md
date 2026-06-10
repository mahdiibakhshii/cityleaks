# CityLeaks v2 — Agent Guide

Real-time multiplayer 2D top-down **web** game (the old Unity prototype is discarded — ignore any Unity files). Players are colored circles moving over an orthographic photo of Vienna, constrained to roads by an alpha collision mask. Every visited cell is recorded in an anonymous, persistent **1000×1000 "leak grid"** that is: (a) rendered in-game as glowing water-blue **paths**, (b) streamed to a **monitor** page showing the whole city, and (c) streamed to **TouchDesigner** for visualization.

Full original spec: [docs/v2/](docs/v2/). This file is the quick operational map — keep it current.

## Run

**Dev** (two terminals):
```bash
cd server && npm install && npm run dev     # port 3000 (tsx watch, auto-reload)
cd client && npm install && npm run dev     # port 5173 (Vite, proxies /socket.io → :3000)
```
- Game: http://localhost:5173 — Monitor: http://localhost:5173/monitor.html
- Status/metrics: http://localhost:3000/api/status

**Production:**
```bash
cd client && npm run build                  # → client/dist (index.html + monitor.html)
cd server && npm start                       # serves client/dist on PORT||3000
```
- Game at `/`, monitor at `/monitor`.
- **The server runs TypeScript directly via `tsx` — there is NO server compile step.** Use `npm run typecheck` (tsc --noEmit) to type-check. (We deliberately don't `tsc`-emit the server: `moduleResolution: bundler` produces extensionless imports Node's ESM loader rejects. tsx sidesteps this and is the validated prod runner.)

## Deployment & CI/CD

**Live in production** on a Hetzner VPS, auto-deployed by GitHub Actions. Full runbook + scripts: [deploy/](deploy/) (`deploy/README.md`).

- **Repo:** https://github.com/mahdiibakhshii/cityleaks (public). **Server:** `root@167.233.102.255` (Ubuntu 26.04, 2 vCPU/4 GB + 2 GB swap), app at `/opt/cityleaks`. **Public URL:** **https://cityleaks.space** (also `www.`; `/monitor`, `/api/status`).
- **Stack on the box:** nginx reverse-proxies `:443/:80 → :3000` (WebSocket upgrade headers — see `deploy/nginx-cityleaks.conf`); PM2 process **`cityleaks`** runs `node --import tsx src/index.ts` (`deploy/ecosystem.config.cjs`) and is enabled on boot. Node is the **official v22 binary** in `/usr/local` (NodeSource has no `resolute`/26.04 repo).
- **Domain + HTTPS:** `cityleaks.space` via Namecheap A records → server IP; Let's Encrypt cert managed by **certbot** (auto-renews, added the `:443` block + HTTP→HTTPS redirect to the live nginx config). First-time + re-run details in `deploy/README.md`. The CI/CD deploy does NOT touch nginx, so TLS is undisturbed by pushes.
- **Deploy = push to `main`.** `.github/workflows/deploy.yml` builds the client on the runner, rsyncs `client/dist` to the server, `git reset --hard origin/main`, `npm ci --omit=dev`, `pm2 restart`. ~20 s end to end. Secrets: `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY` (a deploy-only key, separate from the local admin key `~/.ssh/cityleaks_hetzner`).
- **First-time provisioning** (already done once, re-runnable): `deploy/provision.sh` (swap, Node, PM2, nginx, fd/sysctl tuning, ufw, fail2ban) then `deploy/bootstrap-app.sh` (clone, build, PM2 start, nginx site, firewall).
- **Persistent data lives only on the server** at `/opt/cityleaks/server/data/` (leak grid, notes, kill markers, collision cache) — gitignored, untouched by deploys/reboots. Never commit it; never let a deploy delete it.
- **Ops:** `pm2 status` / `pm2 logs cityleaks` / `pm2 restart cityleaks`; health via `curl localhost:3000/api/status`.
- **Not yet done (optional):** SSH hardening (disable password auth), bump CI off the deprecated Node-20 actions.

## Golden rules (don't violate)

1. **`shared/protocol.ts` is the SINGLE SOURCE OF TRUTH** for both client and server: event names, constants, the tile layout (`MAP.TILES`), computed `MAP_BOUNDS`, `SPAWN`, and all payload types. Tiles/spawn/grid size change **here only** — the server (`server/src/config.ts`) and client (`client/src/config.ts`) re-export from it.
2. **Client and server never import each other.** Both import `shared/`.
3. **Coordinate convention — IMAGE/DATA coords:** origin (0,0) at the top-left of tile (0,0), **+X right, +Y DOWN**, 1 unit = 1 source pixel. Movement, collision, leak grid, and the server all use this directly with **no inversion**. The ONLY place Y flips is rendering: meshes & cameras use `three_y = -data_y`. Never add a Y-inversion anywhere else.

## Current state — 2026-06-10

All four build phases are functionally complete and load-tested. Working today:
- **Multiplayer:** Socket.IO, 10 Hz server tick, join/leave/state broadcast, interpolation, reconnection, soft cap `MAX_PLAYERS=220` (targets ~200 concurrent). `state:update` broadcasts a **slim `PlayerPos` (id+x+y only)** — static `color`/`character` ride only on `player:join`/`player:existing`, halving per-tick payload + serialization for the 200-player target. (Same pattern for enemies via `EnemyPos`.)
- **Movement & collision:** keyboard + nipple.js joystick, wall-sliding against the alpha mask, spawn-into-building recovery (`findNearestWalkable`).
- **Streaming:** map tiles (camera view + directional preload margin) and mask tiles (player proximity) both stream/unload dynamically — scales to the full 17×17 Vienna grid.
- **Shared persistent paths:** the leak grid is rendered on every client via `PathLayer` as **pixel-art leaking water** — chunky NearestFilter cells shaded from a banded blue palette (`PATH.DEEP/MID/LIGHT`), a calm time-based shimmer + twinkle, and an animated bright **foam rim** on trail edges (4-neighbour edge detect). One fullscreen quad + one cheap shader pass (mobile-light); `PathLayer.update(dt)` drives the animation. Monitor uses `PathLayer({ pixelated })` (`pixelated:true` matches the game look). Persists to disk, anonymous, ownerless; new clients see all prior paths on connect.
- **Monitor page** (`/monitor`): whole-map "contain" view over a downscaled overview image, reusing `PathLayer` + `NoteLayer` + `KillLayer`. Live players render as their **character avatars** (`AvatarManager`, reusing `RemotePlayer` at a big `AVATAR_HEIGHT` so they walk + interpolate); enemies are red dots (`DotManager`); kills pop a big `ExplosionBurst`. Connects as `role=monitor` — spawns no player and marks no cells.
- **Sticky notes:** anonymous text "stuck" to a map location. A persistent "Stick a note" button opens a compose modal; submitting pins the note at the player's position. Each note shows an always-visible procedural paper icon (`NoteLayer`); walking within `NOTE_REVEAL_RADIUS` (120 units) reveals the text fullscreen (font auto-fitted, joystick stays usable on top), passing the threshold hides it. Notes are ownerless, capped at `NOTE_MAX_LENGTH` (200) chars, persisted to `server/data/notes.json`, and sent in full to every new client.
- **Intro + characters:** a DOM intro popup (`intro/IntroOverlay.ts`) shows on every page load before the game boots — phase 1 welcome panel (Skip/Next), phase 2 character picker. The 4 selectable characters live in `CHARACTERS` (shared/protocol): each renders in-game as an **original pixel-art mascot sprite** (Dash the critter, Pip the plumber, Waddles the duck, Pim the knight) with a **2-frame walk cycle**; **Skip** keeps an anonymous figure (`ANON_CHARACTER_ID`) tinted by the random server color. Choice rides in the Socket.IO handshake query `character` (like `role`); the server echoes the id in `PlayerState.character`, so **every** client renders the right sprite. The sprite system is **procedural pixel art authored in code** (no image assets): `game/sprites/drawSprite.ts` draws each 16×24 sprite into a canvas (auto 1px dark outline), `SpriteAtlas.ts` bakes it to a **cached** NearestFilter texture atlas (one per kind, shared across all instances), `CharacterSprite.ts` is the animated quad (UV frame-swap + L/R mirror + per-instance `uTint`), used by `Player`/`RemotePlayer`/`EnemyEntity`. `CharacterDef.shape` is now a coarse fallback only; the sprite is keyed by `id`. Picker previews bake the same sprite art (stand frame). Sizes/anchors live in `config.ts` `SPRITE`. `CharacterDef.abilities` is scaffolding (all 1.0) — **visual-only today**; wire into movement/reveal later without protocol changes. (`game/shapes.ts` is now unused legacy.)
- **Enemies (wandering NPCs):** server-authoritative entities that roam the city near players. Each keeps a **comfortable distance** from its nearest player — flees when crowded (`ENEMY_FLEE_RADIUS`), drifts back when abandoned (`ENEMY_LEASH_RADIUS`), orbits/wanders in between — and steers toward open streets (context steering) so it stays on roads. Population **scales with player count** (`ENEMY_PER_PLAYERS`, clamped `ENEMY_MIN`..`ENEMY_MAX`). Driven in the 10 Hz tick (`server/EnemyManager.ts`), broadcast like players (`ENEMY_*` events), rendered on every client as ghost sprites (`game/EnemyEntity.ts` + `game/EnemyManager.ts`) and on the monitor (a second `DotManager`). `ENEMY_TYPES` (shared/protocol) is the data-driven customization point (color/speed/radii/wanderiness per kind, parallel to `CHARACTERS`). Enemies stay on roads via a **server-side collision field** (see below).
- **The hunt (kill the enemies):** the cooperative mission. Enemies are prey: the closer a player presses, the harder they **panic-sprint** (`ENEMY_PANIC_BOOST`), but sprinting drains **stamina** and an exhausted enemy is slow + catchable; stamina regenerates when they get space. Two kill paths, both ending in death at **life ≤ 0**: **TRAP** — players' bodies are soft blockers of escape routes, so a body-wall or a dead-end with **zero open escape** drains life fast (instant-ish, dramatic, group play); **EXHAUST** — chase one down to empty stamina while held point-blank and its life bleeds out (slower, what a relentless solo hunter relies on). Tuned so solo is *possible but hard* (needs geometry + wearing it down) and a group is far faster. Visual telegraph: the body tint lerps **healthy color → `ENEMY.DYING_COLOR` (red→purple-black) by remaining `life`**, and it shakes + speeds its walk as `panic` rises (`life`+`panic` ride on `EnemyPos` every tick). On death: a **scream sprite frame + WebAudio shriek → explosion burst + boom** (`EnemyDeathFx`/`Sfx`), a celebratory **leak-grid splash** at the spot, and a **persistent tombstone** kill marker (`KillStore`/`KillLayer`, `server/data/kills.json`). The kill moment itself is the reward — there is **no success popup** (deliberately removed). The server still computes the credited hunters in `EnemyDie.by` (players within `ENEMY_TRAP_RADIUS`) — currently unused on the client, available if you want to reintroduce per-hunter feedback. All tuning is constants in shared/protocol (`ENEMY_PANIC_BOOST`, `ENEMY_STAMINA_*`, `ENEMY_TIRED_SPEED`, `ENEMY_LIFE_*`, `ENEMY_TRAP_RADIUS`, `ENEMY_PLAYER_BLOCK`, `ENEMY_ESCAPE_CLEARANCE`, `ENEMY_KILL_SPLASH_RADIUS`).
- **Production build** works (`npm run build` client, `npm start` server). Stress-tested: **140 bots, avg tick ~1.6 ms, peak ~3.5 ms, 0 errors** (< 50 ms budget; the hunt's player-blocking escape checks are negligible at the ≤`ENEMY_MAX` enemy cap).
- **Assets:** real Vienna map split into tiles + overview via `tools/split_tiles.py`.

Not done / optional (from Phase 4): PWA manifest + "Add to Home Screen", service-worker tile caching, live TouchDesigner verification against real TD.

## Key files

**server/src/**
- `index.ts` — Express + Socket.IO bootstrap, static serving of `client/dist`, `/monitor` alias, `/api/status` (players, leak %, notes, kills, enemies, `tickMs:{last,avg,max}`), graceful sync save of grid + notes + kills on SIGINT/SIGTERM. Kicks off the (non-blocking) `CollisionField.build()` and constructs the `EnemyManager`.
- `GameServer.ts` — player `Map`, connection routing by `role` (game/monitor/td), 10 Hz `tick()` (broadcast positions, mark leak cells, send deltas, advance + broadcast enemies, **handle enemy deaths**), tick-timing metrics. `handleEnemyDeath()` paints a celebratory leak splash (`markSplash`, disc of cells), drops a persistent kill marker, and broadcasts `ENEMY_DIE` + `KILL_NEW`.
- `LeakGrid.ts` — bit-packed 1000×1000 grid; `mark`, `worldToCell`, `getFullBuffer`, `saveToDisk` (sync, shutdown only) + `saveToDiskAsync` (periodic, non-blocking).
- `CollisionField.ts` — server walkability: coarse (`COLLISION_GRID_SIZE`=2048) bit-packed WALKABLE grid over `MAP_BOUNDS`, built by decoding the mask PNG tiles (`pngjs`) and **cached to `server/data/collision.bin`** (loads instantly on restart). The cache header stores the grid size **and a fingerprint of the mask tiles** (FNV hash over each tile's byte size), so it **auto-rebuilds when the mask is regenerated** or `COLLISION_GRID_SIZE` changes — no manual delete needed. Exposes `isWalkable`/`isCircleWalkable`/`clearance`/`findNearestWalkable`/`moveWithSliding` (server ports of `CollisionMask.ts`) and a `ready` flag.
- `EnemyManager.ts` — wandering-NPC AI + **the hunt** + lifecycle: context-steering toward open streets within a comfort distance band, population scaling, spawn/despawn. THE HUNT (see "Enemies" below): per-enemy `stamina`/`life`/`panic`; the closer a player presses the harder it panic-sprints (`ENEMY_PANIC_BOOST`) but sprinting drains stamina (a tired enemy is slow); players are soft blockers of escape routes, so a body-wall/dead-end with **zero open escape = trapped** → life drains fast (instant-ish kill), while exhausted-and-cornered bleeds life slowly. `update(players, dt)` (players carry `id` for kill credit) returns `{spawned, despawned, died}`; `getStates()`/`getPositions()` feed the `ENEMY_*` broadcasts (positions now include `life`+`panic`). All tuning is constants in `shared/protocol.ts`.
- `NoteStore.ts` — sticky notes: `create` (validate + clamp), `getAll`, JSON persistence (`saveToDisk` sync shutdown + coalesced `saveToDiskAsync` per new note).
- `KillStore.ts` — persistent enemy-kill markers (a near-twin of `NoteStore`): `create(x,y,kind,bounds)`, `getAll`, JSON persistence to `server/data/kills.json`. Ownerless tombstones, sent in full on connect.
- `TDRoom.ts` — TouchDesigner room (grid:full / delta / stats / reset). `config.ts` — re-exports + PORT, GRID_FILE, NOTES_FILE, KILLS_FILE, COLLISION_FILE, `MASK_TILES_DIR` (dist→public). New server dep: **`pngjs`** (pure-JS PNG decode for the collision field).

**client/src/**
- `config.ts` — client-only constants: `ASSETS` (tile paths, `.webp` map ext, `OVERVIEW_PATH`), `MASK.ALPHA_THRESHOLD`, `STREAM`, `PLAYER`, `ENEMY` (render radius/z/lerp + hunt visuals: `DYING_COLOR`, `PANIC_FPS_BOOST`, `PANIC_SHAKE`, `SCREAM_TIME`, `BURST_*`), `KILL` (tombstone icon), `CAMERA`, `PATH` (path color), `MONITOR`.
- `config.ts` also has `SPRITE` (character/enemy sprite world sizes, anchor, walk FPS) + the `PATH` water palette.
- `game/Game.ts` — orchestrator + rAF loop (takes the chosen `characterId`). `Camera.ts` (fit-shorter-axis). `TileMap.ts`, `CollisionMask.ts` (streaming). `PathLayer.ts` (**shared pixel-art water leak overlay — also used by the monitor**). `NoteLayer.ts` + `NoteUI.ts` (sticky notes). `KillLayer.ts` (in-world persistent tombstone icons, **also used by the monitor**). `Player/RemotePlayer/PlayerManager` + `EnemyEntity.ts`/`EnemyManager.ts` (server-driven NPC ghosts: life-tint, panic shake/anim, scream→explosion death sequence) + `EnemyDeathFx.ts` (`ExplosionBurst` shockwave) + `audio/Sfx.ts` (procedural WebAudio scream/boom) — all render via the sprite system below; `shapes.ts` is unused legacy.
- `game/sprites/` — the pixel-art sprite system. `drawSprite.ts` (THREE-free procedural pixel art: per-mascot `draw()` fns, the NEUTRAL ghost (`getGhostSpec`, 3 frames: walk A/B + **scream**, tinted live per-instance), auto outline, `renderSpec()` → canvas, the id/kind registry). `SpriteAtlas.ts` (bakes a spec → cached NearestFilter `BakedAtlas`; `playerAtlas(id)`/`ghostAtlas()` — one shared neutral ghost sheet). `CharacterSprite.ts` (animated quad: 2-frame walk, L/R mirror, tint, `setFrameOverride()` for the scream frame; `srgbTint()` helper).
- `intro/IntroOverlay.ts` — the two-phase intro popup (welcome → character select); `show()` resolves to the chosen character id (or `ANON_CHARACTER_ID`). DOM built in code, styled by `.intro-*` classes in `styles/main.css` (2×2 grid on mobile, 4-up row on desktop).
- `input/` (Keyboard, Joystick, InputManager). `network/NetworkClient.ts`. `main.ts` (game entry).
- `monitor/MonitorApp.ts` + `monitor.ts` + `client/monitor.html` — the spectator page. Players draw as character avatars via `AvatarManager` (wraps `RemotePlayer`, which now takes an optional render `height`); enemies via `DotManager`; enemy deaths via `ExplosionBurst`. Sizing consts at the top of `MonitorApp.ts` (`AVATAR_HEIGHT`, `MONITOR_BURST_RADIUS`).

**tools/** — `split_tiles.py` (tiles + overview generator), `load-test.mjs` (stress test), `smoke-test.mjs` (7 protocol checks), `note-test.mjs` (9 sticky-note protocol checks), `gen-placeholders.mjs` (dev placeholder tiles).

**deploy/** — production deployment (see Deployment & CI/CD above): `provision.sh` (server bootstrap), `bootstrap-app.sh` (first app bring-up), `ecosystem.config.cjs` (PM2), `nginx-cityleaks.conf` (reverse proxy), `README.md` (runbook). **`.github/workflows/deploy.yml`** — the push-to-`main` auto-deploy pipeline.

## Networking model

Three Socket.IO rooms, selected by handshake query `role`:
- **game** (default) — browser players; spawned, broadcast, marks leak cells. A second handshake query `character` (a `CHARACTERS` id, or absent = anonymous) sets the player's shape + signature color, echoed in `PlayerState.character`.
- **monitor** (`?role=monitor`, or just the monitor page) — receives grid + `state:update`; **no player, no leak marking**.
- **td** (`?role=td`) — TouchDesigner; grid:full on connect, grid:delta each tick, grid:reset.

Events live in `EVENTS` (shared/protocol): `player:self/existing/join/leave/move`, `state:update` (10 Hz positions), `grid:full` (125 KB bit-packed buffer on connect), `grid:delta` (`{cells:number[]}` new flat indices/tick), `grid:stats`, `grid:reset`, `note:existing` (all notes on connect), `note:new` (one stuck note, broadcast to game+monitor), `note:create` (client→server stick request), `enemy:existing` (all enemies on connect, to game+monitor), `enemy:join`/`enemy:leave` (one enemy spawned / **silently** despawned via pop. scaling), `enemy:update` (10 Hz enemy positions + `life`+`panic`, slim `EnemyPos`), `enemy:die` (one enemy KILLED by players — `EnemyDie{id,x,y,kind,by}` drives the death FX; `by` = credited hunters, currently unused client-side), `kill:existing` (all persistent kill markers on connect), `kill:new` (one new tombstone marker, to game+monitor).

## Leak grid & paths

1000×1000 bits = 125 KB, spanning the full `MAP_BOUNDS` (17408² for a 17×17 grid). `worldToCell` maps a position → cell; flat index = `cellY*GRID_SIZE + cellX` (same index used by the texture and the delta). Persisted to `server/data/leak-grid.bin`. `PathLayer` unpacks it into a `RedFormat` `DataTexture` drawn as one quad over `MAP_BOUNDS`, shaded with `PATH.COLOR`; local player marks optimistically each frame, server delta confirms. To make paths finer, raise `GRID_SIZE` in shared/protocol.ts (also update the TD side — buffer size changes).

## Asset pipeline

Originals (git-ignored) live in `tools/originals/`: `vienna_map.jpg` (16667², real map → tiles), `vienna_mask.png` (same size, alpha collision), `vienna_map_backwhite.jpg` (5000², **monitor overview only**).

```bash
python tools/split_tiles.py        # → client/public/tiles/{map,mask}/, manifest.json, map_overview.webp
```
- 16667 / 1024 → **17×17** grid; edge tiles padded (map black, mask opaque=blocked) so real pixels stay aligned and bounds = 17408².
- After splitting, set `MAP.TILES = rectTiles(17, 17)` in shared/protocol.ts.
- Useful flags: `--overview-only` (just rebuild the overview), `--overview-map <img>` (overview pixels from an alternate same-extent image while bounds come from the real map — this is how the backwhite monitor image is made), `--origin center`, `--map-format png`.
- Mask rule: **alpha ≥ 128 = blocked building, < 128 = walkable** (`MASK.ALPHA_THRESHOLD`).
- The **server** also reads these mask tiles once (via `pngjs`) to build its enemy collision field, caching the result to `server/data/collision.bin`. After re-splitting the mask the server **rebuilds the cache automatically** on next start (the cache header fingerprints the mask tiles' byte sizes; a `COLLISION_GRID_SIZE` change also rebuilds). No manual delete needed — just restart the server (a deploy/PM2 restart suffices in prod).

## Testing

```bash
node tools/smoke-test.mjs                    # server running → 7 protocol checks
node tools/note-test.mjs                       # server running → 9 sticky-note checks (URL env overrides port)
node tools/load-test.mjs                      # 100 bots / 20s; reads tick metrics from /api/status
BOTS=150 DURATION=30 node tools/load-test.mjs  # env: BOTS DURATION RATE URL MAP_SPAN STEP RAMP
```
Pass criteria: peak server tick < 50 ms while broadcasts hold ~10 Hz. Run a prod-like server (`tsx src/index.ts`, not `tsx watch`) on a scratch port for clean numbers.

## Gotchas

- Tiles are **1024px** WebP (≈4 MB GPU upload; 2048 hitches on mobile). Don't bump without reason.
- TS is strict; a `Uint8Array` field backing a `DataTexture` needs `Uint8Array<ArrayBuffer>` typing (TS 5.7).
- Game camera fits the **shorter** axis (cover/fullscreen); the monitor camera fits the **whole** map (contain/letterboxed).
- **Avatar SIZE is purely visual and decoupled from collision.** The rendered sprite size is `SPRITE.PLAYER_HEIGHT`/`ENEMY_HEIGHT` (client config) / `AVATAR_HEIGHT` (monitor); movement + wall-collision use `PLAYER.RADIUS`/`PLAYER.SPEED` and `ENEMY_RADIUS`. Enlarge the sprite consts freely to make characters bigger **without** changing step size or which buildings they bump. (`SPRITE.ANCHOR_Y` is a fraction of height, so feet stay on the road point at any size.)
- `tsx` must stay in server `dependencies` (not devDependencies) — it's the prod runtime.
- **Tiles are committed to git** (`client/public/tiles/`, ~66 MB) so the server is self-contained after `git clone` — do NOT re-add them to `.gitignore`. Originals (`tools/originals/`) and `server/data/` stay ignored.
- **Shell scripts must keep LF endings** (`.gitattributes` enforces `*.sh eol=lf`) — CRLF breaks bash on the Linux server.
- **Deploys run `git reset --hard origin/main` on the server** — anything not committed (and not gitignored) is wiped. Live state in `server/data/` is gitignored, so it's safe; don't put deploy-time state anywhere tracked.
