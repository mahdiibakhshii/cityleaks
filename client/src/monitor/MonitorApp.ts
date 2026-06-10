import * as THREE from 'three';
import { io, Socket } from 'socket.io-client';
import {
  EVENTS,
  MAP_BOUNDS,
  type PlayerState,
  type PlayerPos,
  type PlayerLeave,
  type GridDelta,
  type GridStats,
  type Note,
  type EnemyState,
  type EnemyPos,
  type EnemyLeave,
  type EnemyDie,
  type KillMarker,
  enemyDef,
} from '../../../shared/protocol';
import { ASSETS, MONITOR } from '../config';
import { PathLayer } from '../game/PathLayer';
import { NoteLayer } from '../game/NoteLayer';
import { KillLayer } from '../game/KillLayer';
import { ExplosionBurst } from '../game/EnemyDeathFx';
import { RemotePlayer } from '../game/RemotePlayer';

// Explosion burst radius on the zoomed-out whole-map view (world units).
const MONITOR_BURST_RADIUS = Math.round(MAP_BOUNDS.width / 26);
// Player avatar render height on the whole-map view (world units) — large so the
// pixel mascot is clearly recognizable at full-city zoom.
const AVATAR_HEIGHT = Math.round(MAP_BOUNDS.width / 36);

/**
 * Spectator / monitoring view. Shows the WHOLE map (a single downscaled
 * overview image), the shared persistent path overlay (reusing PathLayer), and
 * every player's live position as a colored dot. No local player, no input.
 *
 * Connects with role=monitor so the server streams the grid + player positions
 * WITHOUT spawning a player or marking the leak grid for this client.
 */
export class MonitorApp {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private pathLayer: PathLayer;
  private noteLayer: NoteLayer;
  private killLayer: KillLayer;
  private avatars: AvatarManager;
  private enemyDots: DotManager;
  private bursts: ExplosionBurst[] = [];
  private socket: Socket;
  private clock = new THREE.Clock();
  private running = false;
  private hud: HTMLElement | null;
  private stats: GridStats | null = null;

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(MONITOR.BACKGROUND_COLOR);
    document.body.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    this.fitCamera();

    // Whole-map overview image, stretched across the full map bounds (z=0).
    this.addOverview();

    // Shared persistent paths (z=0.3) — same component the game uses.
    // Same pixel-art leaking-water look as in-game (banded blue + foam rim).
    this.pathLayer = new PathLayer({ pixelated: true });
    this.scene.add(this.pathLayer.mesh);

    // Sticky-note icons — scaled up for the zoomed-out whole-map view so they
    // read clearly when the entire ~17k-unit city is fit to one screen.
    this.noteLayer = new NoteLayer(Math.round(MAP_BOUNDS.width / 40));
    this.scene.add(this.noteLayer.group);

    // Persistent kill tombstones — scaled up for the whole-map view.
    this.killLayer = new KillLayer(Math.round(MAP_BOUNDS.width / 44));
    this.scene.add(this.killLayer.group);

    // Live players, rendered as their chosen character avatar (z=1).
    this.avatars = new AvatarManager();
    this.scene.add(this.avatars.group);

    // Live enemy dots (z=1.1, just above players so they read on the overview).
    this.enemyDots = new DotManager(1.1);
    this.scene.add(this.enemyDots.group);

    this.hud = document.getElementById('monitor-hud');
    this.socket = this.connect();

    window.addEventListener('resize', this.onResize);
  }

  private addOverview(): void {
    const loader = new THREE.TextureLoader();
    loader.load(
      ASSETS.OVERVIEW_PATH,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;

        const geometry = new THREE.PlaneGeometry(MAP_BOUNDS.width, MAP_BOUNDS.height);
        const material = new THREE.MeshBasicMaterial({ map: texture });
        const mesh = new THREE.Mesh(geometry, material);
        const cx = MAP_BOUNDS.minX + MAP_BOUNDS.width / 2;
        const cy = MAP_BOUNDS.minY + MAP_BOUNDS.height / 2;
        mesh.position.set(cx, -cy, 0);
        this.scene.add(mesh);
      },
      undefined,
      () => {
        console.warn(
          `Monitor overview not found at ${ASSETS.OVERVIEW_PATH}. ` +
            `Generate it with: python tools/split_tiles.py --overview-only`
        );
      }
    );
  }

  /** Orthographic "contain" fit: the entire map is visible, centered, with bars. */
  private fitCamera(): void {
    const aspect = window.innerWidth / window.innerHeight;
    const margin = 1 + MONITOR.FIT_MARGIN * 2;
    const mapW = MAP_BOUNDS.width * margin;
    const mapH = MAP_BOUNDS.height * margin;

    let viewW: number;
    let viewH: number;
    if (aspect >= mapW / mapH) {
      viewH = mapH;
      viewW = mapH * aspect;
    } else {
      viewW = mapW;
      viewH = mapW / aspect;
    }

    this.camera.left = -viewW / 2;
    this.camera.right = viewW / 2;
    this.camera.top = viewH / 2;
    this.camera.bottom = -viewH / 2;
    this.camera.updateProjectionMatrix();

    const cx = MAP_BOUNDS.minX + MAP_BOUNDS.width / 2;
    const cy = MAP_BOUNDS.minY + MAP_BOUNDS.height / 2;
    this.camera.position.set(cx, -cy, 10);
    this.camera.lookAt(cx, -cy, 0);
  }

  private connect(): Socket {
    const socket = io({
      query: { role: 'monitor' },
      transports: ['websocket', 'polling'],
      reconnection: true,
    });

    socket.on('connect', () => this.updateHud());
    socket.on('disconnect', () => {
      if (this.hud) this.hud.textContent = 'Reconnecting…';
    });

    socket.on(EVENTS.PLAYER_EXISTING, (players: PlayerState[]) => this.avatars.sync(players));
    socket.on(EVENTS.PLAYER_JOIN, (player: PlayerState) => this.avatars.add(player));
    socket.on(EVENTS.STATE_UPDATE, (positions: PlayerPos[]) =>
      this.avatars.updatePositions(positions)
    );
    socket.on(EVENTS.PLAYER_LEAVE, (data: PlayerLeave) => this.avatars.remove(data.id));

    socket.on(EVENTS.GRID_FULL, (buffer: ArrayBuffer) => this.pathLayer.applyFull(buffer));
    socket.on(EVENTS.GRID_DELTA, (data: GridDelta) => this.pathLayer.applyDelta(data.cells));

    socket.on(EVENTS.NOTE_EXISTING, (notes: Note[]) => this.noteLayer.setNotes(notes));
    socket.on(EVENTS.NOTE_NEW, (note: Note) => this.noteLayer.addNote(note));

    socket.on(EVENTS.ENEMY_EXISTING, (enemies: EnemyState[]) => this.enemyDots.sync(enemies));
    socket.on(EVENTS.ENEMY_JOIN, (enemy: EnemyState) => this.enemyDots.add(enemy));
    socket.on(EVENTS.ENEMY_UPDATE, (positions: EnemyPos[]) =>
      this.enemyDots.updatePositions(positions)
    );
    socket.on(EVENTS.ENEMY_LEAVE, (data: EnemyLeave) => this.enemyDots.remove(data.id));
    socket.on(EVENTS.ENEMY_DIE, (death: EnemyDie) => {
      this.enemyDots.remove(death.id);
      // Pop a big explosion at the kill so the hunt reads on the whole-map view.
      const burst = new ExplosionBurst(death.x, death.y, enemyDef(death.kind).color, MONITOR_BURST_RADIUS);
      this.bursts.push(burst);
      this.scene.add(burst.group);
    });

    socket.on(EVENTS.KILL_EXISTING, (markers: KillMarker[]) => this.killLayer.setMarkers(markers));
    socket.on(EVENTS.KILL_NEW, (marker: KillMarker) => this.killLayer.addMarker(marker));

    socket.on(EVENTS.GRID_STATS, (stats: GridStats) => {
      this.stats = stats;
      this.updateHud();
    });

    return socket;
  }

  private updateHud(): void {
    if (!this.hud) return;
    const players = this.stats?.playerCount ?? this.avatars.count;
    const pct = this.stats ? `${this.stats.percentage.toFixed(2)}%` : '—';
    this.hud.textContent = `Players: ${players}  ·  Explored: ${pct}`;
  }

  start(): void {
    this.running = true;
    this.clock.start();
    this.animate();
  }

  private animate = (): void => {
    if (!this.running) return;
    requestAnimationFrame(this.animate);
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.pathLayer.update(dt);
    this.avatars.interpolate(dt);
    this.enemyDots.interpolate(dt);
    if (this.bursts.length) {
      for (const b of this.bursts) b.update(dt);
      this.bursts = this.bursts.filter((b) => {
        if (b.finished) {
          this.scene.remove(b.group);
          b.dispose();
          return false;
        }
        return true;
      });
    }
    this.renderer.render(this.scene, this.camera);
  };

  private onResize = (): void => {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.fitCamera();
  };

  dispose(): void {
    this.running = false;
    window.removeEventListener('resize', this.onResize);
    this.socket.close();
  }
}

/**
 * Renders live players on the whole-map view as their chosen CHARACTER AVATAR
 * (the same pixel-art mascot they use in-game) rather than a plain dot — reusing
 * RemotePlayer so the avatars interpolate + play their walk cycle. Named
 * characters show their mascot; anonymous players show the figure tinted by
 * their server color. Mirrors DotManager's API so the socket handlers are
 * interchangeable.
 */
class AvatarManager {
  readonly group = new THREE.Group();
  private avatars = new Map<string, RemotePlayer>();

  get count(): number {
    return this.avatars.size;
  }

  /** Add/update avatars to exactly match the given players; remove the rest. */
  sync(players: PlayerState[]): void {
    const seen = new Set<string>();
    for (const p of players) {
      seen.add(p.id);
      const existing = this.avatars.get(p.id);
      if (existing) existing.setTarget(p.x, p.y);
      else this.add(p);
    }
    for (const id of [...this.avatars.keys()]) if (!seen.has(id)) this.remove(id);
  }

  add(p: PlayerState): void {
    if (this.avatars.has(p.id)) return;
    const rp = new RemotePlayer(p.x, p.y, p.color, p.character, AVATAR_HEIGHT);
    this.group.add(rp.mesh);
    this.avatars.set(p.id, rp);
  }

  /** Update interpolation targets from a slim tick broadcast. */
  updatePositions(positions: PlayerPos[]): void {
    for (const p of positions) this.avatars.get(p.id)?.setTarget(p.x, p.y);
  }

  remove(id: string): void {
    const rp = this.avatars.get(id);
    if (!rp) return;
    this.group.remove(rp.mesh);
    rp.dispose();
    this.avatars.delete(id);
  }

  interpolate(dt: number): void {
    for (const rp of this.avatars.values()) rp.interpolate(dt);
  }
}

interface Dot {
  mesh: THREE.Mesh;
  targetX: number;
  targetY: number;
  dispX: number;
  dispY: number;
}

// Minimal shape a dot needs — satisfied by both PlayerState and EnemyState.
type DotInput = { id: string; x: number; y: number; color: string };

/** Maintains one colored dot per entity (player or enemy), synced to state. */
class DotManager {
  readonly group = new THREE.Group();
  private dots = new Map<string, Dot>();
  private geometry = new THREE.CircleGeometry(MONITOR.DOT_RADIUS, 24);
  private readonly z: number;

  constructor(z = 1) {
    this.z = z;
  }

  get count(): number {
    return this.dots.size;
  }

  /** Add/update dots to exactly match the given list; remove the rest. */
  sync(items: DotInput[]): void {
    const seen = new Set<string>();
    for (const p of items) {
      seen.add(p.id);
      const existing = this.dots.get(p.id);
      if (existing) {
        existing.targetX = p.x;
        existing.targetY = p.y;
      } else {
        this.add(p);
      }
    }
    for (const id of [...this.dots.keys()]) {
      if (!seen.has(id)) this.remove(id);
    }
  }

  /** Create a dot for a newly added entity. */
  add(p: DotInput): void {
    if (this.dots.has(p.id)) return;
    const material = new THREE.MeshBasicMaterial({ color: p.color });
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.position.set(p.x, -p.y, this.z);
    this.group.add(mesh);
    this.dots.set(p.id, { mesh, targetX: p.x, targetY: p.y, dispX: p.x, dispY: p.y });
  }

  /** Update interpolation targets from a slim tick broadcast (no color needed). */
  updatePositions(positions: PlayerPos[]): void {
    for (const p of positions) {
      const dot = this.dots.get(p.id);
      if (dot) {
        dot.targetX = p.x;
        dot.targetY = p.y;
      }
    }
  }

  remove(id: string): void {
    const dot = this.dots.get(id);
    if (!dot) return;
    this.group.remove(dot.mesh);
    (dot.mesh.material as THREE.MeshBasicMaterial).dispose();
    this.dots.delete(id);
  }

  interpolate(dt: number): void {
    const t = 1 - Math.exp(-MONITOR.DOT_LERP * dt);
    for (const dot of this.dots.values()) {
      dot.dispX += (dot.targetX - dot.dispX) * t;
      dot.dispY += (dot.targetY - dot.dispY) * t;
      dot.mesh.position.set(dot.dispX, -dot.dispY, this.z);
    }
  }
}
