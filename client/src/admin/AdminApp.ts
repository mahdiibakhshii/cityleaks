import { io, Socket } from 'socket.io-client';
import {
  EVENTS,
  MAP_BOUNDS,
  getCharacter,
  ANON_CHARACTER_ID,
  type Note,
  type KillMarker,
  type AdminStats,
  type AdminPlayerInfo,
} from '../../../shared/protocol';
import { ASSETS } from '../config';

/** Tiny DOM helper: create an element with class + optional text. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = ''
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/**
 * The operator admin dashboard (served at /admin). A password unlocks a token
 * (POST /api/admin/login); the dashboard then connects role=admin with that
 * token and is the live console for the installation:
 *   - live server stats + connected-player list (with kick),
 *   - moderate notes (edit / delete) and one-click cleanups (paths/notes/kills),
 *   - broadcast a message to every player,
 *   - jump into the live game as the special Batman "creator" character.
 *
 * All authority is server-side: the page is purely a client of the authed admin
 * socket — the password/token check happens on the server.
 */
export class AdminApp {
  private root: HTMLElement;
  private socket: Socket | null = null;
  private token = '';

  // Live state.
  private notes = new Map<string, Note>();
  private kills: KillMarker[] = [];

  // Dashboard element refs (set when the dashboard is built).
  private statsEl: HTMLElement | null = null;
  private playersEl: HTMLElement | null = null;
  private notesEl: HTMLElement | null = null;
  private overview: HTMLCanvasElement | null = null;
  private overviewImg: HTMLImageElement | null = null;
  private editingId: string | null = null;
  private opacityInput: HTMLInputElement | null = null;
  private opacityLabel: HTMLElement | null = null;

  constructor() {
    this.root = document.getElementById('admin-root') ?? document.body;
  }

  start(): void {
    this.renderLogin();
  }

  // ─── Login ───

  private renderLogin(errorMsg = ''): void {
    this.root.innerHTML = '';
    const wrap = el('div', 'admin-login');
    const panel = el('form', 'admin-login-panel');
    panel.appendChild(el('div', 'admin-login-title', 'CityLeaks Admin'));

    const input = el('input', 'admin-login-input');
    input.type = 'password';
    input.placeholder = 'Password';
    input.autocomplete = 'current-password';
    panel.appendChild(input);

    const error = el('div', 'admin-login-error', errorMsg);
    panel.appendChild(error);

    const button = el('button', 'admin-btn admin-btn-primary', 'Enter');
    button.type = 'submit';
    panel.appendChild(button);

    panel.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.attemptLogin(input.value, error);
    });

    wrap.appendChild(panel);
    this.root.appendChild(wrap);
    setTimeout(() => input.focus(), 0);
  }

  private async attemptLogin(password: string, error: HTMLElement): Promise<void> {
    error.textContent = '';
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        error.textContent = 'Wrong password.';
        return;
      }
      const data = (await res.json()) as { token: string };
      this.token = data.token;
      this.connect();
    } catch {
      error.textContent = 'Could not reach the server.';
    }
  }

  // ─── Socket ───

  private connect(): void {
    const socket = io({
      query: { role: 'admin', token: this.token },
      transports: ['websocket', 'polling'],
      reconnection: true,
    });
    this.socket = socket;

    socket.on(EVENTS.ADMIN_DENIED, () => {
      this.token = '';
      this.renderLogin('Session rejected. Log in again.');
    });
    socket.on(EVENTS.ADMIN_OK, () => this.renderDashboard());

    socket.on(EVENTS.ADMIN_STATS, (stats: AdminStats) => this.renderStats(stats));
    socket.on(EVENTS.ADMIN_PLAYERS, (players: AdminPlayerInfo[]) => this.renderPlayers(players));

    socket.on(EVENTS.NOTE_EXISTING, (notes: Note[]) => {
      this.notes = new Map(notes.map((n) => [n.id, n]));
      this.renderNotes();
      this.renderOverview();
    });
    socket.on(EVENTS.NOTE_NEW, (note: Note) => {
      this.notes.set(note.id, note);
      this.renderNotes();
      this.renderOverview();
    });
    socket.on(EVENTS.NOTE_UPDATE, (note: Note) => {
      this.notes.set(note.id, note);
      this.renderNotes();
    });
    socket.on(EVENTS.NOTE_REMOVE, (data: { id: string }) => {
      this.notes.delete(data.id);
      this.renderNotes();
      this.renderOverview();
    });
    socket.on(EVENTS.NOTE_RESET, () => {
      this.notes.clear();
      this.renderNotes();
      this.renderOverview();
    });

    socket.on(EVENTS.KILL_EXISTING, (markers: KillMarker[]) => {
      this.kills = markers.slice();
      this.renderOverview();
    });
    socket.on(EVENTS.KILL_NEW, (marker: KillMarker) => {
      this.kills.push(marker);
      this.renderOverview();
    });
    socket.on(EVENTS.KILL_RESET, () => {
      this.kills = [];
      this.renderOverview();
    });

    socket.on(EVENTS.ADMIN_MAP_OPACITY, (data: { value: number }) => {
      if (typeof data?.value !== 'number') return;
      this.setOpacityControl(data.value);
    });
  }

  /** Reflect the current map-image opacity in the slider + label (no emit). */
  private setOpacityControl(value: number): void {
    const v = Math.max(0, Math.min(1, value));
    if (this.opacityInput) this.opacityInput.value = String(v);
    if (this.opacityLabel) this.opacityLabel.textContent = `${Math.round(v * 100)}%`;
  }

  private emit(event: string, payload?: unknown): void {
    this.socket?.emit(event, payload);
  }

  // ─── Dashboard layout ───

  private renderDashboard(): void {
    this.root.innerHTML = '';
    const page = el('div', 'admin-page');

    const header = el('div', 'admin-header');
    header.appendChild(el('div', 'admin-title', 'CityLeaks — Admin'));
    const batman = el('button', 'admin-btn admin-btn-batman', '🦇 Play as Batman');
    batman.addEventListener('click', () => {
      window.open(`/?admin=${encodeURIComponent(this.token)}`, '_blank');
    });
    header.appendChild(batman);
    page.appendChild(header);

    const grid = el('div', 'admin-grid');

    // Stats card.
    const statsCard = this.card('Server');
    this.statsEl = el('div', 'admin-stats');
    statsCard.appendChild(this.statsEl);
    grid.appendChild(statsCard);

    // Broadcast card.
    const broadcastCard = this.card('Broadcast to players');
    const ta = el('textarea', 'admin-textarea');
    ta.placeholder = 'Message shown to every player (in the creator style)…';
    const sendBtn = el('button', 'admin-btn admin-btn-primary', 'Send');
    sendBtn.addEventListener('click', () => {
      const text = ta.value.trim();
      if (!text) return;
      this.emit(EVENTS.ADMIN_BROADCAST, { text });
      ta.value = '';
    });
    broadcastCard.append(ta, sendBtn);
    grid.appendChild(broadcastCard);

    // Cleanup card.
    const cleanupCard = this.card('Cleanup (fresh run)');
    cleanupCard.appendChild(
      this.dangerButton('Reset paths', 'Wipe ALL leak paths for every player. Continue?', () =>
        this.emit(EVENTS.ADMIN_RESET_PATHS)
      )
    );
    cleanupCard.appendChild(
      this.dangerButton('Reset notes', 'Delete ALL sticky notes. Continue?', () =>
        this.emit(EVENTS.ADMIN_RESET_NOTES)
      )
    );
    cleanupCard.appendChild(
      this.dangerButton('Reset kill markers', 'Delete ALL kill tombstones. Continue?', () =>
        this.emit(EVENTS.ADMIN_RESET_KILLS)
      )
    );
    grid.appendChild(cleanupCard);

    // Monitor background-image opacity card.
    const opacityCard = this.card('Monitor background image');
    const opacityRow = el('div', 'admin-row');
    this.opacityInput = el('input', 'admin-range') as HTMLInputElement;
    this.opacityInput.type = 'range';
    this.opacityInput.min = '0';
    this.opacityInput.max = '1';
    this.opacityInput.step = '0.05';
    this.opacityInput.value = '1';
    this.opacityLabel = el('span', 'admin-stat-val', '100%');
    this.opacityInput.addEventListener('input', () => {
      const v = Number(this.opacityInput!.value);
      if (this.opacityLabel) this.opacityLabel.textContent = `${Math.round(v * 100)}%`;
      this.emit(EVENTS.ADMIN_MAP_OPACITY, { value: v });
    });
    opacityRow.append(this.opacityInput, this.opacityLabel);
    opacityCard.appendChild(opacityRow);
    opacityCard.appendChild(
      el('div', 'admin-legend', 'Fades the map photo on the monitor (paths/notes stay).')
    );
    grid.appendChild(opacityCard);

    // Overview map card.
    const mapCard = this.card('Map (notes + kills)');
    this.overview = el('canvas', 'admin-overview');
    mapCard.appendChild(this.overview);
    mapCard.appendChild(
      el('div', 'admin-legend', '● note   ▲ creator note   ✕ kill')
    );
    grid.appendChild(mapCard);

    // Players card.
    const playersCard = this.card('Players');
    this.playersEl = el('div', 'admin-list');
    playersCard.appendChild(this.playersEl);
    grid.appendChild(playersCard);

    // Notes card.
    const notesCard = this.card('Notes');
    this.notesEl = el('div', 'admin-list');
    notesCard.appendChild(this.notesEl);
    grid.appendChild(notesCard);

    page.appendChild(grid);
    this.root.appendChild(page);

    // Load the overview image once, then (re)draw.
    this.overviewImg = new Image();
    this.overviewImg.onload = () => this.renderOverview();
    this.overviewImg.src = ASSETS.OVERVIEW_PATH;

    this.renderNotes();
    this.renderOverview();
  }

  private card(title: string): HTMLElement {
    const c = el('div', 'admin-card');
    c.appendChild(el('div', 'admin-card-title', title));
    return c;
  }

  private dangerButton(label: string, confirmMsg: string, action: () => void): HTMLButtonElement {
    const btn = el('button', 'admin-btn admin-btn-danger', label);
    btn.addEventListener('click', () => {
      if (window.confirm(confirmMsg)) action();
    });
    return btn;
  }

  // ─── Section renderers ───

  private renderStats(s: AdminStats): void {
    if (!this.statsEl) return;
    const rows: [string, string][] = [
      ['Players online', String(s.players)],
      ['Enemies', String(s.enemies)],
      ['Explored', `${s.leakedPercentage.toFixed(2)}%`],
      ['Notes', String(s.notes)],
      ['Kill markers', String(s.kills)],
      ['Tick (avg / max)', `${s.tickMs.avg.toFixed(1)} / ${s.tickMs.max.toFixed(1)} ms`],
      ['Uptime', formatUptime(s.uptime)],
    ];
    this.statsEl.innerHTML = '';
    for (const [k, v] of rows) {
      const row = el('div', 'admin-stat-row');
      row.append(el('span', 'admin-stat-key', k), el('span', 'admin-stat-val', v));
      this.statsEl.appendChild(row);
    }
  }

  private renderPlayers(players: AdminPlayerInfo[]): void {
    if (!this.playersEl) return;
    this.playersEl.innerHTML = '';
    if (players.length === 0) {
      this.playersEl.appendChild(el('div', 'admin-empty', 'No players online.'));
      return;
    }
    for (const p of players) {
      const row = el('div', 'admin-row');
      const swatch = el('span', 'admin-swatch');
      swatch.style.background = p.color;
      const name = getCharacter(p.character)?.name ?? (p.character || ANON_CHARACTER_ID);
      const label = el('span', 'admin-row-label', `${name} · ${p.id.slice(0, 6)}`);
      const kick = el('button', 'admin-btn admin-btn-small admin-btn-danger', 'Kick');
      kick.addEventListener('click', () => this.emit(EVENTS.ADMIN_KICK, { id: p.id }));
      row.append(swatch, label, kick);
      this.playersEl.appendChild(row);
    }
  }

  private renderNotes(): void {
    if (!this.notesEl) return;
    this.notesEl.innerHTML = '';
    const notes = [...this.notes.values()].sort((a, b) => b.createdAt - a.createdAt);
    if (notes.length === 0) {
      this.notesEl.appendChild(el('div', 'admin-empty', 'No notes.'));
      return;
    }
    for (const note of notes) {
      this.notesEl.appendChild(this.noteRow(note));
    }
  }

  private noteRow(note: Note): HTMLElement {
    const row = el('div', 'admin-note');
    if (note.admin) row.classList.add('admin-note-creator');

    if (this.editingId === note.id) {
      const ta = el('textarea', 'admin-textarea');
      ta.value = note.text;
      const save = el('button', 'admin-btn admin-btn-small admin-btn-primary', 'Save');
      save.addEventListener('click', () => {
        const text = ta.value.trim();
        if (text) this.emit(EVENTS.ADMIN_NOTE_EDIT, { id: note.id, text });
        this.editingId = null;
        this.renderNotes();
      });
      const cancel = el('button', 'admin-btn admin-btn-small', 'Cancel');
      cancel.addEventListener('click', () => {
        this.editingId = null;
        this.renderNotes();
      });
      const actions = el('div', 'admin-note-actions');
      actions.append(save, cancel);
      row.append(ta, actions);
      return row;
    }

    const text = el('div', 'admin-note-text', note.text);
    const actions = el('div', 'admin-note-actions');
    const edit = el('button', 'admin-btn admin-btn-small', 'Edit');
    edit.addEventListener('click', () => {
      this.editingId = note.id;
      this.renderNotes();
    });
    const del = el('button', 'admin-btn admin-btn-small admin-btn-danger', 'Delete');
    del.addEventListener('click', () => {
      if (window.confirm('Delete this note?')) this.emit(EVENTS.ADMIN_NOTE_DELETE, { id: note.id });
    });
    actions.append(edit, del);
    row.append(text, actions);
    return row;
  }

  /** Draw the overview image with note + kill dots plotted by world coords. */
  private renderOverview(): void {
    const canvas = this.overview;
    const img = this.overviewImg;
    if (!canvas) return;
    // Keep the canvas at the map's aspect ratio, capped to its CSS width.
    const cssW = canvas.clientWidth || 320;
    const aspect = MAP_BOUNDS.height / MAP_BOUNDS.width;
    canvas.width = Math.round(cssW);
    canvas.height = Math.round(cssW * aspect);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (img && img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = '#11131a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    const toX = (wx: number) => ((wx - MAP_BOUNDS.minX) / MAP_BOUNDS.width) * canvas.width;
    const toY = (wy: number) => ((wy - MAP_BOUNDS.minY) / MAP_BOUNDS.height) * canvas.height;

    // Notes: blue dots (gold triangles for creator notes).
    for (const n of this.notes.values()) {
      const x = toX(n.x);
      const y = toY(n.y);
      if (n.admin) {
        ctx.fillStyle = '#ffd23f';
        ctx.beginPath();
        ctx.moveTo(x, y - 4);
        ctx.lineTo(x - 4, y + 3);
        ctx.lineTo(x + 4, y + 3);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillStyle = '#2a9df4';
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Kills: red ✕.
    ctx.strokeStyle = '#ff4d6d';
    ctx.lineWidth = 2;
    for (const k of this.kills) {
      const x = toX(k.x);
      const y = toY(k.y);
      ctx.beginPath();
      ctx.moveTo(x - 3, y - 3);
      ctx.lineTo(x + 3, y + 3);
      ctx.moveTo(x + 3, y - 3);
      ctx.lineTo(x - 3, y + 3);
      ctx.stroke();
    }
  }
}

function formatUptime(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
