# Client Specification

## Three.js Setup (Game.ts)

### Renderer

```typescript
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Cap at 2x for mobile perf
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x1a1a2e); // Dark background visible at map edges
document.body.appendChild(renderer.domElement);
```

The canvas fills the entire viewport. Handle `window.resize` events to update renderer size and camera aspect.

### Scene Graph

```
THREE.Scene
│
├── mapGroup (THREE.Group)              z = 0
│   ├── tile_0_0 (Mesh: PlaneGeometry)
│   ├── tile_1_0 (Mesh: PlaneGeometry)
│   └── ... (loaded/unloaded dynamically)
│
├── remotePlayersGroup (THREE.Group)    z = 1
│   ├── player_abc (Mesh: CircleGeometry + colored material)
│   ├── player_def (Mesh: CircleGeometry + colored material)
│   └── ...
│
└── localPlayerGroup (THREE.Group)      z = 2
    └── localPlayer (Mesh: CircleGeometry + colored material)
```

Z-layering ensures:  map < remote players < local player (local always on top).

All geometry is on the **XY plane**. The OrthographicCamera looks down **-Z**.

### Camera (Camera.ts)

```typescript
const camera = new THREE.OrthographicCamera(
  -viewWidth / 2,   // left
   viewWidth / 2,   // right
   viewHeight / 2,  // top (Three.js: +Y is up)
  -viewHeight / 2,  // bottom
  0.1,              // near
  100               // far
);
camera.position.set(playerX, playerY, 10); // Z=10, looking down
camera.lookAt(playerX, playerY, 0);
```

**Viewport size** determines how much of the map is visible. This should be tuned so the player circle is a comfortable size on screen — roughly **800–1200 world units** wide depending on device.

**Follow behavior** — smooth lerp toward the player:

```typescript
function updateCamera(playerPos: THREE.Vector2, dt: number) {
  const lerpFactor = 1 - Math.pow(0.001, dt); // ~smooth follow
  camera.position.x += (playerPos.x - camera.position.x) * lerpFactor;
  camera.position.y += (playerPos.y - camera.position.y) * lerpFactor;

  // Clamp to map bounds so the camera doesn't show void
  camera.position.x = clamp(camera.position.x, viewWidth / 2, mapWidth - viewWidth / 2);
  camera.position.y = clamp(camera.position.y, viewHeight / 2, mapHeight - viewHeight / 2);

  camera.updateProjectionMatrix();
}
```

### Y-Axis Convention

**Important:** Three.js's default is +Y = up, but image coordinates have +Y = down. Choose **one** convention and stick with it. 

**Recommended approach:** Use Three.js's native +Y = up. When loading tile images, flip the PlaneGeometry's UV coordinates or set `texture.flipY = true` (Three.js does this by default for loaded textures). When sampling the collision mask pixel array, invert Y:

```typescript
// World Y (Three.js, +Y up) → Pixel Y (image, +Y down)
const pixelY = TOTAL_HEIGHT_PX - Math.floor(worldY);
```

**Or alternatively:** Work entirely in image coordinates (+Y down) by rotating the camera. This avoids all flipping but means Three.js's +Y points downward. Either approach works — just be consistent everywhere.

## Player Rendering (Player.ts)

### Local Player

```typescript
const geometry = new THREE.CircleGeometry(PLAYER_RADIUS, 32); // 32 segments for smooth circle
const material = new THREE.MeshBasicMaterial({ color: playerColor });
const mesh = new THREE.Mesh(geometry, material);
mesh.position.set(startX, startY, 2); // z=2 to render above everything
```

**Player constants (config.ts):**

```typescript
export const PLAYER = {
  RADIUS: 8,           // world units (pixels) — adjust based on map resolution
  SPEED: 150,          // world units per second
  COLOR: null,         // assigned randomly on join, or from server
};
```

### Movement Loop (per frame)

```typescript
function updatePlayer(dt: number) {
  const dir = inputManager.getDirection(); // {x, y} normalized or zero
  if (dir.x === 0 && dir.y === 0) return;

  const dx = dir.x * PLAYER.SPEED * dt;
  const dy = dir.y * PLAYER.SPEED * dt;

  const newPos = moveWithSliding(
    player.position.x, player.position.y,
    dx, dy,
    PLAYER.RADIUS, collisionMask
  );

  player.position.x = newPos.x;
  player.position.y = newPos.y;
  player.mesh.position.set(newPos.x, newPos.y, 2);
}
```

### Remote Players (RemotePlayer.ts)

Each remote player has:
- A `CircleGeometry` mesh with their assigned color
- A **target position** (latest from server) and **display position** (interpolated)

```typescript
class RemotePlayer {
  mesh: THREE.Mesh;
  targetX: number;
  targetY: number;
  displayX: number;
  displayY: number;

  // Called when server sends a new position
  setTarget(x: number, y: number) {
    this.targetX = x;
    this.targetY = y;
  }

  // Called every frame — interpolate toward target
  interpolate(dt: number) {
    const lerpSpeed = 10; // Higher = snappier
    const t = 1 - Math.pow(Math.E, -lerpSpeed * dt);
    this.displayX += (this.targetX - this.displayX) * t;
    this.displayY += (this.targetY - this.displayY) * t;
    this.mesh.position.set(this.displayX, this.displayY, 1);
  }
}
```

### PlayerManager.ts

Manages the set of all remote players:

```typescript
class PlayerManager {
  private players: Map<string, RemotePlayer> = new Map();
  private group: THREE.Group;

  addPlayer(id: string, x: number, y: number, color: string): void {
    const rp = new RemotePlayer(x, y, color);
    this.players.set(id, rp);
    this.group.add(rp.mesh);
  }

  removePlayer(id: string): void {
    const rp = this.players.get(id);
    if (rp) {
      this.group.remove(rp.mesh);
      rp.mesh.geometry.dispose();
      (rp.mesh.material as THREE.MeshBasicMaterial).dispose();
      this.players.delete(id);
    }
  }

  // Called when server broadcasts state
  updateFromServer(states: PlayerState[]): void {
    for (const state of states) {
      const rp = this.players.get(state.id);
      if (rp) {
        rp.setTarget(state.x, state.y);
      }
      // Don't add new players here — wait for player:join event
    }
  }

  // Called every frame
  interpolateAll(dt: number): void {
    for (const rp of this.players.values()) {
      rp.interpolate(dt);
    }
  }
}
```

## Game Loop (Game.ts)

```typescript
class Game {
  private clock = new THREE.Clock();
  private networkSendAccumulator = 0;
  private readonly NETWORK_SEND_INTERVAL = 1 / 10; // 10 Hz

  start() {
    this.animate();
  }

  private animate = () => {
    requestAnimationFrame(this.animate);

    const dt = this.clock.getDelta();

    // 1. Read input
    const direction = this.inputManager.getDirection();

    // 2. Move local player (with collision)
    this.player.update(direction, dt, this.collisionMask);

    // 3. Send position to server (throttled to 10 Hz)
    this.networkSendAccumulator += dt;
    if (this.networkSendAccumulator >= this.NETWORK_SEND_INTERVAL) {
      this.networkSendAccumulator -= this.NETWORK_SEND_INTERVAL;
      this.network.sendPosition(this.player.x, this.player.y);
    }

    // 4. Interpolate remote players
    this.playerManager.interpolateAll(dt);

    // 5. Update camera
    this.camera.follow(this.player.position, dt);

    // 6. Update visible tiles
    this.tileMap.updateVisibleTiles(this.camera);

    // 7. Render
    this.renderer.render(this.scene, this.camera.camera);
  };
}
```

## Responsive Layout (main.css)

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html, body {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #1a1a2e;
  touch-action: none;         /* Prevent browser gestures */
  -webkit-touch-callout: none;
  user-select: none;
}

canvas {
  display: block;
  width: 100% !important;
  height: 100% !important;
}
```

**Critical CSS for mobile:**
- `touch-action: none` — prevents pinch-zoom, scroll, and other browser gestures that would interfere with the joystick
- `user-select: none` — prevents text selection on long-press
- `overflow: hidden` — prevents elastic scrolling on iOS Safari

## index.html

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="mobile-web-app-capable" content="yes" />
  <title>CityLeaks</title>
  <link rel="stylesheet" href="/src/styles/main.css" />
</head>
<body>
  <!-- Three.js canvas is appended by Game.ts -->
  <!-- Joystick container is appended by Joystick.ts -->
  <div id="joystick-zone"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

The `viewport` meta tag with `maximum-scale=1.0, user-scalable=no` is critical to prevent double-tap zoom and pinch-zoom on mobile.
