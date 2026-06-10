import * as THREE from 'three';
import {
  CLIENT_SEND_RATE,
  ANON_CHARACTER_ID,
  getCharacter,
} from '../../../shared/protocol';
import { BACKGROUND_COLOR, PLAYER } from '../config';
import { Camera } from './Camera';
import { TileMap } from './TileMap';
import { CollisionMask } from './CollisionMask';
import { PathLayer } from './PathLayer';
import { GuideLayer } from './GuideLayer';
import { NoteLayer } from './NoteLayer';
import { NoteUI } from './NoteUI';
import { Player } from './Player';
import { PlayerManager } from './PlayerManager';
import { EnemyManager } from './EnemyManager';
import { InputManager } from '../input/InputManager';
import { NetworkClient } from '../network/NetworkClient';

export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: Camera;
  private tileMap: TileMap;
  private collisionMask: CollisionMask;
  private pathLayer: PathLayer;
  private guideLayer: GuideLayer;
  private noteLayer: NoteLayer;
  private noteUI: NoteUI;
  private player: Player;
  private playerManager: PlayerManager;
  private enemyManager: EnemyManager;
  private input: InputManager;
  private network: NetworkClient | null = null;

  private clock = new THREE.Clock();
  private sendAccumulator = 0;
  private readonly sendInterval = 1 / CLIENT_SEND_RATE;
  private tileCullAccumulator = 0;
  private running = false;
  private statusEl: HTMLElement | null;
  private readonly characterId: string;

  constructor(spawnX: number, spawnY: number, characterId: string = ANON_CHARACTER_ID) {
    this.characterId = characterId;
    // Renderer.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(BACKGROUND_COLOR);
    document.body.appendChild(this.renderer.domElement);

    // Scene + camera.
    this.scene = new THREE.Scene();
    this.camera = new Camera();

    // Map + collision.
    this.tileMap = new TileMap();
    this.scene.add(this.tileMap.group);
    this.collisionMask = new CollisionMask();

    // Shared persistent path overlay (sits above the map, below players).
    this.pathLayer = new PathLayer();
    this.scene.add(this.pathLayer.mesh);

    // Walkability guide: soft white glow over open streets near the player,
    // surfaced on wall contact (above paths, below characters).
    this.guideLayer = new GuideLayer();
    this.scene.add(this.guideLayer.group);

    // Sticky-note icons (above paths, below players) + their DOM UI.
    this.noteLayer = new NoteLayer();
    this.scene.add(this.noteLayer.group);
    this.noteUI = new NoteUI({
      onSubmit: (text) => this.network?.sendNote(this.player.x, this.player.y, text),
      onComposeOpen: () => this.input.setEnabled(false),
      onComposeClose: () => this.input.setEnabled(true),
    });

    // Players. The local player takes the chosen character's shape + signature
    // color immediately (no white flash); the server confirms the color via
    // player:self (and assigns a random one for the anonymous circle).
    const character = getCharacter(this.characterId);
    this.playerManager = new PlayerManager();
    this.scene.add(this.playerManager.group);

    // Enemy NPCs (server-authoritative) — same draw band as remote players.
    this.enemyManager = new EnemyManager();
    this.scene.add(this.enemyManager.group);
    // Named characters render from their own sprite (color is ignored); the
    // anonymous figure is tinted with this placeholder until player:self arrives.
    this.player = new Player(spawnX, spawnY, this.characterId, character?.color ?? '#9aa0aa');
    this.scene.add(this.player.mesh);

    // Input.
    this.input = new InputManager();

    // UI status element.
    this.statusEl = document.getElementById('status');

    window.addEventListener('resize', this.onResize);
  }

  /** Load mask tiles near spawn, then snap the player to a walkable spawn. */
  async init(): Promise<void> {
    await this.collisionMask.ensureLoaded(this.player.x, this.player.y);

    const safe = this.collisionMask.findNearestWalkable(
      this.player.x,
      this.player.y,
      PLAYER.RADIUS
    );
    if (safe) this.player.setPosition(safe.x, safe.y);

    // Prime the camera onto the player.
    this.camera.follow(this.player.position, 1);
    this.tileMap.updateVisibleTiles(this.camera);
  }

  /** Attach networking. Called after init so spawn is resolved. */
  connect(): void {
    this.network = new NetworkClient({
      onSelf: (self) => {
        this.playerManager.setLocalId(self.id);
        this.player.setColor(self.color);
        // Keep our locally-resolved walkable spawn rather than snapping into
        // a possible building at the server's center spawn.
      },
      onExisting: (players) => {
        this.playerManager.reset(players);
      },
      onJoin: (player) => {
        this.playerManager.addPlayer(player.id, player.x, player.y, player.color, player.character);
      },
      onLeave: (data) => {
        this.playerManager.removePlayer(data.id);
      },
      onStateUpdate: (states) => {
        this.playerManager.updateFromServer(states);
      },
      onGridFull: (buffer) => {
        this.pathLayer.applyFull(buffer);
      },
      onGridDelta: (cells) => {
        this.pathLayer.applyDelta(cells);
      },
      onNotesExisting: (notes) => {
        this.noteLayer.setNotes(notes);
      },
      onNoteNew: (note) => {
        this.noteLayer.addNote(note);
      },
      onEnemiesExisting: (enemies) => {
        this.enemyManager.reset(enemies);
      },
      onEnemyJoin: (enemy) => {
        this.enemyManager.addEnemy(enemy.id, enemy.x, enemy.y, enemy.color, enemy.kind);
      },
      onEnemyLeave: (data) => {
        this.enemyManager.removeEnemy(data.id);
      },
      onEnemyUpdate: (positions) => {
        this.enemyManager.updateFromServer(positions);
      },
      onConnectionChange: (connected) => {
        this.showStatus(connected ? 'Connected' : 'Reconnecting…', !connected);
      },
    }, this.characterId);
  }

  start(): void {
    this.running = true;
    this.clock.start();
    this.animate();
  }

  private animate = (): void => {
    if (!this.running) return;
    requestAnimationFrame(this.animate);

    const dt = Math.min(this.clock.getDelta(), 0.1); // Clamp huge tab-switch dt.

    // 1. Input → move local player with collision, then lay our own trail
    //    immediately (the server delta confirms the same cell moments later).
    const direction = this.input.getDirection();
    const hitWall = this.player.update(direction, dt, this.collisionMask);
    this.pathLayer.markWorld(this.player.x, this.player.y);
    this.pathLayer.update(dt); // advance the water shimmer/foam animation

    // 1b. Walkability guide: glow the open streets near the player whenever a
    //     wall is touched, then fade out (manages its own tiles + opacity).
    this.guideLayer.update(this.player.x, this.player.y, dt, hitWall);

    // 2. Throttled position send.
    if (this.network) {
      this.sendAccumulator += dt;
      if (this.sendAccumulator >= this.sendInterval) {
        this.sendAccumulator %= this.sendInterval;
        this.network.sendPosition(this.player.x, this.player.y);
      }
    }

    // 3. Interpolate remote players + enemies.
    this.playerManager.interpolateAll(dt);
    this.enemyManager.interpolateAll(dt);

    // 4. Camera follow.
    this.camera.follow(this.player.position, dt);

    // 4b. Sticky notes: reveal the nearest note within range fullscreen; hide
    //     when we walk past the threshold (the "glitch" in the walk).
    const near = this.noteLayer.getRevealNote(this.player.x, this.player.y);
    if (near) {
      this.noteUI.showReveal(near.text, near.id);
      this.noteLayer.setRevealed(near.id);
    } else {
      this.noteUI.hideReveal();
      this.noteLayer.setRevealed(null);
    }

    // 5. Stream map tiles (camera view) + mask tiles (around the player).
    //    A few times per second is plenty given the slow movement + margins.
    this.tileCullAccumulator += dt;
    if (this.tileCullAccumulator >= 0.15) {
      this.tileCullAccumulator = 0;
      this.tileMap.updateVisibleTiles(this.camera);
      this.collisionMask.update(this.player.x, this.player.y);
    }

    // 6. Render.
    this.renderer.render(this.scene, this.camera.camera);
  };

  private onResize = (): void => {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.camera.resize();
  };

  private showStatus(text: string, warn: boolean): void {
    if (!this.statusEl) return;
    this.statusEl.textContent = text;
    this.statusEl.style.color = warn ? '#ff6464' : '#64ff96';
  }

  dispose(): void {
    this.running = false;
    window.removeEventListener('resize', this.onResize);
    this.input.dispose();
    this.guideLayer.dispose();
    this.noteUI.dispose();
    this.network?.dispose();
  }
}
