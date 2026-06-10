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
// Trail thickening on the monitor, in leak-grid cells, so the path reads at
// full-city zoom. 1 cell ≈ MAP_BOUNDS.width / GRID_SIZE units. (Radius 2 ≈ a
// 5-cell-wide trail — about half the earlier thickness.)
const MONITOR_PATH_DILATE = 2;

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
  private bursts: ExplosionBurst[] = [];
  private socket: Socket;
  private clock = new THREE.Clock();
  private running = false;
  private hud: HTMLElement | null;
  private stats: GridStats | null = null;
  // Read-only notes side panel (text of every sticky note, live).
  private notes = new Map<string, Note>();
  private notesListEl: HTMLElement;
  // Background (overview) image opacity, controllable live from the admin page.
  private overviewMaterial: THREE.MeshBasicMaterial | null = null;
  private mapOpacity = 1;

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
    // Thickened ~10× (dilate radius in grid cells) so trails stay visible when
    // the whole ~17k-unit city is zoomed to fit one screen.
    this.pathLayer = new PathLayer({ pixelated: true, dilate: MONITOR_PATH_DILATE });
    this.scene.add(this.pathLayer.mesh);

    // Sticky-note icons — scaled up for the zoomed-out whole-map view so they
    // read clearly when the entire ~17k-unit city is fit to one screen.
    this.noteLayer = new NoteLayer(Math.round(MAP_BOUNDS.width / 40));
    this.scene.add(this.noteLayer.group);

    // Persistent kill markers — a small X at every spot a kill happened. (No
    // live enemy positions are shown on the monitor.)
    this.killLayer = new KillLayer(Math.round(MAP_BOUNDS.width / 90), 'x');
    this.scene.add(this.killLayer.group);

    // Live players, rendered as their chosen character avatar (z=1).
    this.avatars = new AvatarManager();
    this.scene.add(this.avatars.group);

    this.hud = document.getElementById('monitor-hud');
    this.notesListEl = this.buildNotesPanel();
    this.socket = this.connect();

    window.addEventListener('resize', this.onResize);
  }

  /** Build the read-only notes side panel; returns its scrollable list element. */
  private buildNotesPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.id = 'monitor-notes';
    const title = document.createElement('div');
    title.className = 'monitor-notes-title';
    title.textContent = 'Notes';
    const list = document.createElement('div');
    list.className = 'monitor-notes-list';
    panel.append(title, list);
    document.body.appendChild(panel);
    return list;
  }

  /** Re-render the notes list (newest first). Read-only — no controls. */
  private renderNotesList(): void {
    const notes = [...this.notes.values()].sort((a, b) => b.createdAt - a.createdAt);
    this.notesListEl.innerHTML = '';
    if (notes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'monitor-note-empty';
      empty.textContent = 'No notes yet.';
      this.notesListEl.appendChild(empty);
      return;
    }
    for (const note of notes) {
      const item = document.createElement('div');
      item.className = 'monitor-note' + (note.admin ? ' monitor-note-creator' : '');
      item.textContent = note.text;
      this.notesListEl.appendChild(item);
    }
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
        // transparent:true so the admin-controlled opacity can fade the image
        // out (revealing the dark background) without touching the path overlay.
        const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true });
        material.opacity = this.mapOpacity; // apply any value received before load
        this.overviewMaterial = material;
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
    socket.on(EVENTS.GRID_RESET, () => this.pathLayer.clear());

    socket.on(EVENTS.NOTE_EXISTING, (notes: Note[]) => {
      this.noteLayer.setNotes(notes);
      this.notes = new Map(notes.map((n) => [n.id, n]));
      this.renderNotesList();
    });
    socket.on(EVENTS.NOTE_NEW, (note: Note) => {
      this.noteLayer.addNote(note);
      this.notes.set(note.id, note);
      this.renderNotesList();
    });
    socket.on(EVENTS.NOTE_UPDATE, (note: Note) => {
      this.noteLayer.updateNote(note);
      this.notes.set(note.id, note);
      this.renderNotesList();
    });
    socket.on(EVENTS.NOTE_REMOVE, (data: { id: string }) => {
      this.noteLayer.removeNote(data.id);
      this.notes.delete(data.id);
      this.renderNotesList();
    });
    socket.on(EVENTS.NOTE_RESET, () => {
      this.noteLayer.setNotes([]);
      this.notes.clear();
      this.renderNotesList();
    });

    // Live enemy positions are NOT shown on the monitor — only where a kill
    // happened. On a death, pop a burst at the spot (the persistent X marker
    // arrives via KILL_NEW).
    socket.on(EVENTS.ENEMY_DIE, (death: EnemyDie) => {
      const burst = new ExplosionBurst(death.x, death.y, enemyDef(death.kind).color, MONITOR_BURST_RADIUS);
      this.bursts.push(burst);
      this.scene.add(burst.group);
    });

    socket.on(EVENTS.KILL_EXISTING, (markers: KillMarker[]) => this.killLayer.setMarkers(markers));
    socket.on(EVENTS.KILL_NEW, (marker: KillMarker) => this.killLayer.addMarker(marker));
    socket.on(EVENTS.KILL_RESET, () => this.killLayer.setMarkers([]));

    socket.on(EVENTS.GRID_STATS, (stats: GridStats) => {
      this.stats = stats;
      this.updateHud();
    });

    socket.on(EVENTS.ADMIN_MAP_OPACITY, (data: { value: number }) =>
      this.setMapOpacity(data?.value)
    );

    return socket;
  }

  /** Apply the admin-set background-image opacity (0..1). */
  private setMapOpacity(value: unknown): void {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    this.mapOpacity = Math.max(0, Math.min(1, value));
    if (this.overviewMaterial) {
      this.overviewMaterial.opacity = this.mapOpacity;
      this.overviewMaterial.needsUpdate = true;
    }
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
