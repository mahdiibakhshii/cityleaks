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
  noteImageUrl,
} from '../../../shared/protocol';
import { ASSETS, MONITOR } from '../config';
import { PathLayer } from '../game/PathLayer';
import { NoteLayer } from '../game/NoteLayer';
import { KillLayer } from '../game/KillLayer';
import { ExplosionBurst } from '../game/EnemyDeathFx';
import { RemotePlayer } from '../game/RemotePlayer';
import { MapControls } from './MapControls';
import { googleMapsUrl, formatLatLng } from '../../../shared/geo';

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
  // Map region the canvas lives in (top ~60% on mobile, full viewport on
  // desktop). The renderer + camera are sized to THIS element, not the window,
  // so the map shares the screen with the stacked notes panel on mobile.
  private mapEl: HTMLElement;
  private mapResizeObserver: ResizeObserver | null = null;
  private stats: GridStats | null = null;
  // Read-only notes side panel (text of every sticky note, live).
  private notes = new Map<string, Note>();
  private notesListEl: HTMLElement;
  // Background (overview) image opacity, controllable live from the admin page.
  private overviewMaterial: THREE.MeshBasicMaterial | null = null;
  private mapOpacity = 1;
  // Zoom/pan over the map (wheel + drag + pinch).
  private controls!: MapControls;
  private viewInitialized = false;
  // On-map note popup (click an icon to read it).
  private popupEl!: HTMLDivElement;
  private popupTextEl!: HTMLDivElement;
  private popupGeoEl!: HTMLAnchorElement;
  private popupThumbEl!: HTMLImageElement;
  private activeNoteId: string | null = null;
  // Fullscreen postcard lightbox (opened from a popup thumbnail).
  private lightboxEl!: HTMLDivElement;
  private lightboxImg!: HTMLImageElement;
  private lightboxText!: HTMLDivElement;
  // Calibration probe (/monitor?calibrate=1): prints image px of empty clicks.
  private calibrate = new URLSearchParams(location.search).has('calibrate');
  private calibrateEl: HTMLElement | null = null;

  constructor() {
    this.mapEl = document.getElementById('monitor-map') ?? document.body;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.mapEl.clientWidth, this.mapEl.clientHeight);
    this.renderer.setClearColor(MONITOR.BACKGROUND_COLOR);
    this.mapEl.appendChild(this.renderer.domElement);

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
    this.buildPopup();
    if (this.calibrate) this.buildCalibrateReadout();

    // Zoom + pan. Bounds are the map extent in THREE space (y is flipped).
    this.controls = new MapControls(
      this.camera,
      this.renderer.domElement,
      {
        minX: MAP_BOUNDS.minX,
        maxX: MAP_BOUNDS.maxX,
        minY: -MAP_BOUNDS.maxY,
        maxY: -MAP_BOUNDS.minY,
      },
      { minZoom: 1, maxZoom: 16, onTap: (cx, cy) => this.handleTap(cx, cy) }
    );

    this.socket = this.connect();

    window.addEventListener('resize', this.onResize);
    // The map pane's size is layout-derived (flex / aspect-ratio), so it can
    // change without a window resize (initial settle, notes growing, rotation).
    // Re-fit whenever it actually changes size to keep the map square + sharp.
    if (typeof ResizeObserver !== 'undefined') {
      this.mapResizeObserver = new ResizeObserver(() => this.onResize());
      this.mapResizeObserver.observe(this.mapEl);
    }
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
      if (note.id === this.activeNoteId) item.classList.add('active');
      item.dataset.id = note.id;

      // Card body: text + (optional) real-world location link.
      const body = document.createElement('div');
      body.className = 'monitor-note-body';

      const textEl = document.createElement('span');
      textEl.className = 'monitor-note-text';
      textEl.textContent = note.text;
      body.appendChild(textEl);

      // Real-world location link (only once the geo transform is calibrated).
      const url = googleMapsUrl(note.x, note.y);
      if (url) {
        const link = document.createElement('a');
        link.className = 'monitor-note-geo';
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = `📍 ${formatLatLng(note.x, note.y)}`;
        link.addEventListener('click', (e) => e.stopPropagation()); // don't refocus
        body.appendChild(link);
      }

      item.appendChild(body);

      // Actions row — reserved for upcoming per-note buttons (e.g. edit, delete,
      // flag, share). Append `.monitor-note-btn` children to `actions` and add
      // it to the card; styling is ready in main.css (`.monitor-note-actions`).
      // Buttons should `stopPropagation()` so they don't trigger the row's
      // focus-on-map click below. Left empty for now.
      // const actions = document.createElement('div');
      // actions.className = 'monitor-note-actions';
      // item.appendChild(actions);

      item.addEventListener('click', () => this.focusNote(note.id));
      this.notesListEl.appendChild(item);
    }
  }

  /** Build the (hidden) on-map note popup once. */
  private buildPopup(): void {
    const popup = document.createElement('div');
    popup.id = 'monitor-note-popup';

    const close = document.createElement('span');
    close.className = 'monitor-popup-close';
    close.textContent = '×';
    close.addEventListener('click', () => this.closePopup());

    this.popupTextEl = document.createElement('div');
    this.popupTextEl.className = 'monitor-popup-text';

    // Thumbnail of the note's real-sticker photo (if any) — click to enlarge.
    this.popupThumbEl = document.createElement('img');
    this.popupThumbEl.className = 'monitor-popup-thumb';
    this.popupThumbEl.alt = 'real sticker photo';
    this.popupThumbEl.style.display = 'none';
    this.popupThumbEl.addEventListener('click', () => {
      const note = this.activeNoteId ? this.notes.get(this.activeNoteId) : null;
      if (note) this.openLightbox(note);
    });

    this.popupGeoEl = document.createElement('a');
    this.popupGeoEl.className = 'monitor-popup-geo';
    this.popupGeoEl.target = '_blank';
    this.popupGeoEl.rel = 'noopener';

    popup.append(close, this.popupTextEl, this.popupThumbEl, this.popupGeoEl);
    document.body.appendChild(popup);
    this.popupEl = popup;

    this.buildLightbox();
  }

  /** Fullscreen postcard: the real-sticker photo + the note text, big. */
  private buildLightbox(): void {
    const box = document.createElement('div');
    box.id = 'monitor-note-lightbox';
    box.className = 'note-lightbox';

    const close = document.createElement('span');
    close.className = 'note-lightbox-close';
    close.textContent = '×';

    const card = document.createElement('div');
    card.className = 'note-card';
    const figure = document.createElement('figure');
    figure.className = 'note-card-photo';
    this.lightboxImg = document.createElement('img');
    this.lightboxImg.alt = '';
    figure.appendChild(this.lightboxImg);
    const body = document.createElement('div');
    body.className = 'note-card-body';
    this.lightboxText = document.createElement('div');
    this.lightboxText.className = 'note-card-text';
    const tag = document.createElement('div');
    tag.className = 'note-card-tag';
    tag.textContent = '📍 the real sticker, on a wall in the city';
    body.append(this.lightboxText, tag);
    card.append(figure, body);
    box.append(close, card);
    document.body.appendChild(box);
    this.lightboxEl = box;

    // Clicking the backdrop or the × closes it (but not clicks on the card).
    box.addEventListener('click', (e) => {
      if (e.target === box || e.target === close) this.closeLightbox();
    });
  }

  private openLightbox(note: Note): void {
    const url = noteImageUrl(note);
    if (!url) return;
    this.lightboxImg.src = url;
    this.lightboxText.textContent = note.text;
    this.lightboxEl.querySelector('.note-card')?.classList.toggle('admin', !!note.admin);
    this.lightboxEl.classList.add('visible');
  }

  private closeLightbox(): void {
    this.lightboxEl.classList.remove('visible');
  }

  /** Build the calibration coordinate readout (calibrate mode only). */
  private buildCalibrateReadout(): void {
    const el = document.createElement('div');
    el.id = 'monitor-calibrate';
    el.textContent = 'Calibrate: click a landmark to read its image x,y';
    document.body.appendChild(el);
    this.calibrateEl = el;
  }

  /**
   * A click/tap on the map: open the popup for the note icon under the cursor;
   * otherwise (in calibrate mode) report the clicked image coordinates; else
   * dismiss any open popup.
   */
  private handleTap(clientX: number, clientY: number): void {
    const note = this.noteAtScreen(clientX, clientY);
    if (note) {
      this.openPopup(note);
      this.setActiveRow(note.id);
      return;
    }
    if (this.calibrate) {
      const w = this.controls.clientToWorld(clientX, clientY);
      const dx = Math.round(w.x); // data x == world x
      const dy = Math.round(-w.y); // data y == -world y
      if (this.calibrateEl) {
        this.calibrateEl.textContent =
          `image x,y = ${dx}, ${dy}\n→ pair with this spot's lat,lng from Google Maps`;
      }
      console.log(`[calibrate] image x,y = ${dx}, ${dy}`);
      return;
    }
    this.closePopup();
  }

  /** Nearest note whose icon is under the given screen point, or null. */
  private noteAtScreen(clientX: number, clientY: number): Note | null {
    const iconHalf = Math.round(MAP_BOUNDS.width / 40) / 2;
    let best: Note | null = null;
    let bestD = Infinity;
    for (const note of this.notes.values()) {
      const center = this.controls.worldToClient(note.x, -note.y);
      const edge = this.controls.worldToClient(note.x + iconHalf, -note.y);
      const radius = Math.max(16, Math.hypot(edge.x - center.x, edge.y - center.y));
      const d = Math.hypot(clientX - center.x, clientY - center.y);
      if (d <= radius && d < bestD) {
        bestD = d;
        best = note;
      }
    }
    return best;
  }

  /** Center + zoom the map to a note and open its popup (from a list click). */
  private focusNote(id: string): void {
    const note = this.notes.get(id);
    if (!note) return;
    this.controls.focusOn(note.x, -note.y, 5);
    this.openPopup(note);
    this.setActiveRow(id);
  }

  private openPopup(note: Note): void {
    this.activeNoteId = note.id;
    this.popupTextEl.textContent = note.text;
    this.popupEl.classList.toggle('admin', !!note.admin);
    const imgUrl = noteImageUrl(note);
    if (imgUrl) {
      this.popupThumbEl.src = imgUrl;
      this.popupThumbEl.style.display = '';
    } else {
      this.popupThumbEl.style.display = 'none';
    }
    const url = googleMapsUrl(note.x, note.y);
    if (url) {
      this.popupGeoEl.href = url;
      this.popupGeoEl.textContent = `📍 ${formatLatLng(note.x, note.y)}`;
      this.popupGeoEl.style.display = '';
    } else {
      this.popupGeoEl.style.display = 'none';
    }
    this.popupEl.classList.add('visible');
    this.updatePopupPosition();
  }

  private closePopup(): void {
    this.activeNoteId = null;
    this.popupEl.classList.remove('visible');
    this.setActiveRow(null);
  }

  /** Anchor the open popup to its note's current on-screen position. */
  private updatePopupPosition(): void {
    if (!this.activeNoteId) return;
    const note = this.notes.get(this.activeNoteId);
    if (!note) {
      this.closePopup();
      return;
    }
    const p = this.controls.worldToClient(note.x, -note.y);
    const x = Math.max(90, Math.min(window.innerWidth - 90, p.x));
    this.popupEl.style.left = `${x}px`;
    this.popupEl.style.top = `${p.y}px`;
  }

  /**
   * Toggle the .active highlight on the matching list row and scroll it into
   * view, so selecting a note on the map also reveals it in the list.
   */
  private setActiveRow(id: string | null): void {
    for (const row of this.notesListEl.querySelectorAll('.monitor-note')) {
      const active = (row as HTMLElement).dataset.id === id;
      row.classList.toggle('active', active);
      if (active) {
        (row as HTMLElement).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
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
    const aspect = this.mapEl.clientWidth / Math.max(1, this.mapEl.clientHeight);
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

    // Only center on first fit — on resize, keep the user's zoom/pan (the base
    // frustum changed above; MapControls re-clamps the position below).
    if (!this.viewInitialized) {
      const cx = MAP_BOUNDS.minX + MAP_BOUNDS.width / 2;
      const cy = MAP_BOUNDS.minY + MAP_BOUNDS.height / 2;
      this.camera.position.set(cx, -cy, 10);
      this.camera.lookAt(cx, -cy, 0);
      this.viewInitialized = true;
    }
    this.camera.updateProjectionMatrix();
    this.controls?.onViewChanged();
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
      // Refresh the popup live if it's showing this note (e.g. photo attached).
      if (this.activeNoteId === note.id) this.openPopup(note);
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
    if (this.activeNoteId) this.updatePopupPosition();
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
    this.renderer.setSize(this.mapEl.clientWidth, this.mapEl.clientHeight);
    this.fitCamera();
  };

  dispose(): void {
    this.running = false;
    window.removeEventListener('resize', this.onResize);
    this.mapResizeObserver?.disconnect();
    this.controls.dispose();
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
