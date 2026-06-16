import { io, Socket } from 'socket.io-client';
import {
  EVENTS,
  MAP_BOUNDS,
  getCharacter,
  ANON_CHARACTER_ID,
  noteImageUrl,
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

  // Dedicated notes-manager view (in-page swap from the dashboard).
  private notesCanvas: HTMLCanvasElement | null = null;
  private notesListEl: HTMLElement | null = null;
  private notesListTitle: HTMLElement | null = null;
  private notesDetailEl: HTMLElement | null = null;
  private notesMapRO: ResizeObserver | null = null;
  private selectedNoteId: string | null = null;
  private uploadStatus = '';

  // Notes-map zoom / pan state (canvas-pixel space).
  private notesZoom = 1;
  private notesPanX = 0;
  private notesPanY = 0;
  private notesPrevCanvasSize = 0;
  private notesPointers = new Map<number, { x: number; y: number }>();
  private notesLastPinchDist = 0;
  private notesMapDispose: (() => void) | null = null;

  constructor() {
    this.root = document.getElementById('admin-root') ?? document.body;
  }

  start(): void {
    // Try to resume an existing session: the admin token is an httpOnly cookie we
    // can't read from JS, so we just attempt the authed socket connect. A valid
    // cookie → straight to the dashboard (survives reloads for the cookie's TTL);
    // no/expired cookie → the server denies and we fall back to the login form.
    this.renderChecking();
    this.connect();
  }

  private renderChecking(): void {
    this.root.innerHTML = '';
    const wrap = el('div', 'admin-login');
    wrap.appendChild(el('div', 'admin-login-title', 'CityLeaks Admin'));
    wrap.appendChild(el('div', 'admin-login-error', 'Checking session…'));
    this.root.appendChild(wrap);
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
        credentials: 'same-origin', // accept the Set-Cookie session
      });
      if (res.status === 429) {
        const data = (await res.json().catch(() => ({}))) as { retryAfterMs?: number };
        const mins = Math.ceil((data.retryAfterMs ?? 0) / 60000);
        error.textContent = `Too many attempts. Try again in ~${Math.max(1, mins)} min.`;
        return;
      }
      if (!res.ok) {
        error.textContent = 'Wrong password.';
        return;
      }
      // Success: the server set the httpOnly session cookie; connect with it.
      this.connect();
    } catch {
      error.textContent = 'Could not reach the server.';
    }
  }

  // ─── Socket ───

  private connect(): void {
    // Don't stack sockets if we retry after a denial.
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    // The admin token is the httpOnly session cookie (sent automatically with the
    // same-origin handshake) — never a query param.
    const socket = io({
      query: { role: 'admin' },
      transports: ['websocket', 'polling'],
      reconnection: true,
    });
    this.socket = socket;

    socket.on(EVENTS.ADMIN_DENIED, () => {
      // Invalid/expired session: stop reconnecting and show the login form.
      socket.close();
      if (this.socket === socket) this.socket = null;
      this.renderLogin();
    });
    socket.on(EVENTS.ADMIN_OK, () => this.renderDashboard());

    socket.on(EVENTS.ADMIN_STATS, (stats: AdminStats) => this.renderStats(stats));
    socket.on(EVENTS.ADMIN_PLAYERS, (players: AdminPlayerInfo[]) => this.renderPlayers(players));

    socket.on(EVENTS.NOTE_EXISTING, (notes: Note[]) => {
      this.notes = new Map(notes.map((n) => [n.id, n]));
      this.renderNotes();
      this.renderOverview();
      this.refreshNotesView();
    });
    socket.on(EVENTS.NOTE_NEW, (note: Note) => {
      this.notes.set(note.id, note);
      this.renderNotes();
      this.renderOverview();
      this.refreshNotesView();
    });
    socket.on(EVENTS.NOTE_UPDATE, (note: Note) => {
      this.notes.set(note.id, note);
      this.renderNotes();
      this.refreshNotesView();
    });
    socket.on(EVENTS.NOTE_REMOVE, (data: { id: string }) => {
      this.notes.delete(data.id);
      this.renderNotes();
      this.renderOverview();
      this.refreshNotesView();
    });
    socket.on(EVENTS.NOTE_RESET, () => {
      this.notes.clear();
      this.renderNotes();
      this.renderOverview();
      this.refreshNotesView();
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

  /** Revoke the session server-side, clear the cookie, drop back to login. */
  private async logout(): Promise<void> {
    try {
      await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' });
    } catch {
      // Ignore network errors — we still tear down the client session below.
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.selectedNoteId = null;
    this.renderLogin();
  }

  // ─── Dashboard layout ───

  private renderDashboard(): void {
    // Leaving the notes view: drop its refs so its live-refresh no-ops.
    this.notesCanvas = null;
    this.notesDetailEl = null;
    this.notesMapDispose?.();
    this.notesMapDispose = null;
    this.root.innerHTML = '';
    const page = el('div', 'admin-page');

    const header = el('div', 'admin-header');
    header.appendChild(el('div', 'admin-title', 'CityLeaks — Admin'));
    const notesPageBtn = el('button', 'admin-btn', '🗒 Manage notes');
    notesPageBtn.addEventListener('click', () => this.renderNotesPage());
    header.appendChild(notesPageBtn);
    const batman = el('button', 'admin-btn admin-btn-batman', '🦇 Play as Batman');
    batman.addEventListener('click', () => {
      // Same-origin: the admin session cookie authorizes Batman server-side.
      window.open('/?batman=1', '_blank');
    });
    header.appendChild(batman);
    const logout = el('button', 'admin-btn', 'Log out');
    logout.addEventListener('click', () => void this.logout());
    header.appendChild(logout);
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

  // ─── Dedicated notes page (map + list + detail panel) ───

  /**
   * Full-screen overlay mirroring the monitor layout: the city map on the left
   * (click a pin to select a note) and a sidebar on the right with a compact
   * scrollable notes list at the top and a detail panel (edit / delete / photo)
   * below. In-page view swap — no new route.
   */
  private renderNotesPage(): void {
    // Null dashboard refs so their renderers no-op while we're on this view.
    this.statsEl = null;
    this.playersEl = null;
    this.notesEl = null;
    this.overview = null;
    this.opacityInput = null;
    this.opacityLabel = null;
    this.notesMapRO?.disconnect();
    this.notesMapRO = null;

    this.root.innerHTML = '';
    const page = el('div', 'admin-notes-page');

    // Header bar
    const header = el('div', 'admin-notes-header');
    header.appendChild(el('div', 'admin-title', 'Notes'));
    const back = el('button', 'admin-btn', '← Dashboard');
    back.addEventListener('click', () => {
      this.selectedNoteId = null;
      this.notesMapRO?.disconnect();
      this.notesMapRO = null;
      this.renderDashboard();
    });
    header.appendChild(back);
    page.appendChild(header);

    // Content area: map left + sidebar right
    const content = el('div', 'admin-notes-content');

    // Left: map pane
    const mapPane = el('div', 'admin-notes-map-pane');
    this.notesCanvas = el('canvas', 'admin-notes-map');
    mapPane.appendChild(this.notesCanvas);
    mapPane.appendChild(
      el('div', 'admin-notes-legend', '● note   ▲ creator   ◎ selected   📷 photo')
    );
    content.appendChild(mapPane);

    // Right: sidebar
    const sidebar = el('div', 'admin-notes-sidebar');

    this.notesListTitle = el('div', 'admin-notes-sidebar-title', `Notes (${this.notes.size})`);
    sidebar.appendChild(this.notesListTitle);

    this.notesListEl = el('div', 'admin-notes-list');
    sidebar.appendChild(this.notesListEl);

    this.notesDetailEl = el('div', 'admin-notes-detail');
    sidebar.appendChild(this.notesDetailEl);

    content.appendChild(sidebar);
    page.appendChild(content);
    this.root.appendChild(page);

    // Observe canvas resizes so the map redraws whenever the pane resizes.
    this.notesMapRO = new ResizeObserver(() => this.drawNotesMap());
    this.notesMapRO.observe(this.notesCanvas);

    // Lazily load the overview image then draw.
    if (!this.overviewImg) {
      this.overviewImg = new Image();
      this.overviewImg.onload = () => this.drawNotesMap();
      this.overviewImg.src = ASSETS.OVERVIEW_PATH;
    }
    this.renderNotesList();
    this.initNotesMapControls();
    this.drawNotesMap();
    this.renderNoteDetail();
  }

  /** Live-refresh the notes page (if open) after a NOTE_* event. */
  private refreshNotesView(): void {
    if (!this.notesCanvas) return;
    if (this.selectedNoteId && !this.notes.has(this.selectedNoteId)) {
      this.selectedNoteId = null;
    }
    if (this.notesListTitle) {
      this.notesListTitle.textContent = `Notes (${this.notes.size})`;
    }
    this.renderNotesList();
    this.drawNotesMap();
    this.renderNoteDetail();
  }

  /** Compact monitor-style list of all notes in the sidebar. */
  private renderNotesList(): void {
    const host = this.notesListEl;
    if (!host) return;
    host.innerHTML = '';
    const sorted = [...this.notes.values()].sort((a, b) => b.createdAt - a.createdAt);
    if (sorted.length === 0) {
      host.appendChild(el('div', 'admin-notes-detail-empty', 'No notes yet.'));
      return;
    }
    for (const note of sorted) {
      const classes = [
        'admin-note-row',
        note.admin ? 'creator' : '',
        note.id === this.selectedNoteId ? 'selected' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const row = el('div', classes);

      const textEl = el('div', 'admin-note-row-text', note.text);
      row.appendChild(textEl);

      const meta = el('div', 'admin-note-row-meta');
      if (note.image) meta.appendChild(el('span', 'admin-note-row-photo-badge', '📷'));
      meta.appendChild(el('span', '', note.admin ? 'Creator note' : 'Note'));
      row.appendChild(meta);

      row.addEventListener('click', () => {
        this.selectedNoteId = note.id;
        this.uploadStatus = '';
        this.drawNotesMap();
        this.renderNotesList();
        this.renderNoteDetail();
        // Scroll detail panel into view on mobile
        this.notesDetailEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      host.appendChild(row);
    }
  }

  /** Draw the overview with a pin per note; the selected note is ringed. */
  private drawNotesMap(): void {
    const canvas = this.notesCanvas;
    const img = this.overviewImg;
    if (!canvas) return;
    // The canvas has aspect-ratio:1 CSS so clientWidth === clientHeight.
    // Use clientWidth as the square internal resolution (falls back to 640).
    const size = canvas.clientWidth || 640;

    // Scale pan when the canvas pixel size changes (e.g. window resize).
    if (this.notesPrevCanvasSize > 0 && this.notesPrevCanvasSize !== size) {
      const scale = size / this.notesPrevCanvasSize;
      this.notesPanX *= scale;
      this.notesPanY *= scale;
      this.clampNotesPan(size);
    }
    this.notesPrevCanvasSize = size;

    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Apply zoom/pan so the rest of the drawing happens in map-pixel space.
    ctx.save();
    ctx.translate(this.notesPanX, this.notesPanY);
    ctx.scale(this.notesZoom, this.notesZoom);

    if (img && img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = '#11131a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    const toX = (wx: number) => ((wx - MAP_BOUNDS.minX) / MAP_BOUNDS.width) * canvas.width;
    const toY = (wy: number) => ((wy - MAP_BOUNDS.minY) / MAP_BOUNDS.height) * canvas.height;

    // Draw pins in map-pixel space, but counter-scale their size so they stay
    // the same number of screen pixels regardless of zoom level.
    const invZ = 1 / this.notesZoom;
    for (const n of this.notes.values()) {
      const x = toX(n.x);
      const y = toY(n.y);
      const r = (n.id === this.selectedNoteId ? 7 : 4) * invZ;
      if (n.admin) {
        ctx.fillStyle = '#ffd23f';
        ctx.beginPath();
        ctx.moveTo(x, y - r);
        ctx.lineTo(x - r, y + r * 0.8);
        ctx.lineTo(x + r, y + r * 0.8);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillStyle = n.image ? '#3ad17a' : '#2a9df4'; // green once it has a photo
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      if (n.id === this.selectedNoteId) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2 * invZ;
        ctx.beginPath();
        ctx.arc(x, y, r + 4 * invZ, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  /** Select the nearest note to a tap on the notes map (within ~18 screen px). */
  private handleNotesMapTap(clientX: number, clientY: number): void {
    const canvas = this.notesCanvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    // Screen-pixel position within the canvas element.
    const rawPx = ((clientX - rect.left) / rect.width) * canvas.width;
    const rawPy = ((clientY - rect.top) / rect.height) * canvas.height;

    // Convert a note's world coord to screen-canvas px (accounting for zoom/pan).
    const toScreenX = (wx: number) =>
      this.notesPanX + ((wx - MAP_BOUNDS.minX) / MAP_BOUNDS.width) * canvas.width * this.notesZoom;
    const toScreenY = (wy: number) =>
      this.notesPanY + ((wy - MAP_BOUNDS.minY) / MAP_BOUNDS.height) * canvas.height * this.notesZoom;

    let best: string | null = null;
    let bestD = 18; // screen-px hit radius
    for (const n of this.notes.values()) {
      const d = Math.hypot(rawPx - toScreenX(n.x), rawPy - toScreenY(n.y));
      if (d < bestD) {
        bestD = d;
        best = n.id;
      }
    }
    if (best) {
      this.selectedNoteId = best;
      this.uploadStatus = '';
      this.drawNotesMap();
      this.renderNotesList();
      this.renderNoteDetail();
    }
  }

  /** Render the detail panel for the selected note (edit / delete / photo). */
  private renderNoteDetail(): void {
    const host = this.notesDetailEl;
    if (!host) return;
    host.innerHTML = '';

    const note = this.selectedNoteId ? this.notes.get(this.selectedNoteId) : null;
    if (!note) {
      host.appendChild(
        el('div', 'admin-notes-detail-empty', 'Click a note on the map or list to manage it.')
      );
      return;
    }

    host.appendChild(el('div', 'admin-card-title', note.admin ? 'Creator note' : 'Note'));

    // Editable text.
    const ta = el('textarea', 'admin-textarea');
    ta.value = note.text;
    host.appendChild(ta);

    const textActions = el('div', 'admin-note-actions');
    const save = el('button', 'admin-btn admin-btn-small admin-btn-primary', 'Save text');
    save.addEventListener('click', () => {
      const text = ta.value.trim();
      if (text) this.emit(EVENTS.ADMIN_NOTE_EDIT, { id: note.id, text });
    });
    const del = el('button', 'admin-btn admin-btn-small admin-btn-danger', 'Delete note');
    del.addEventListener('click', () => {
      if (window.confirm('Delete this note?')) {
        this.emit(EVENTS.ADMIN_NOTE_DELETE, { id: note.id });
        this.selectedNoteId = null;
      }
    });
    textActions.append(save, del);
    host.appendChild(textActions);

    // Photo of the physical sticker.
    host.appendChild(el('div', 'admin-card-title', 'Real-sticker photo'));
    if (note.image) {
      const photo = el('img', 'admin-note-photo') as HTMLImageElement;
      photo.src = noteImageUrl(note) ?? note.image;
      photo.alt = 'real sticker';
      host.appendChild(photo);
      const photoActions = el('div', 'admin-note-actions');
      const replace = el('button', 'admin-btn admin-btn-small', 'Replace photo');
      replace.addEventListener('click', () => this.pickNoteImage(note.id));
      const remove = el('button', 'admin-btn admin-btn-small admin-btn-danger', 'Remove photo');
      remove.addEventListener('click', () => {
        if (window.confirm('Remove this photo?')) {
          this.emit(EVENTS.ADMIN_NOTE_IMAGE_REMOVE, { id: note.id });
        }
      });
      photoActions.append(replace, remove);
      host.appendChild(photoActions);
    } else {
      const drop = el('div', 'admin-dropzone', 'Drop a photo here, or click to choose');
      drop.addEventListener('click', () => this.pickNoteImage(note.id));
      drop.addEventListener('dragover', (e) => {
        e.preventDefault();
        drop.classList.add('dragover');
      });
      drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
      drop.addEventListener('drop', (e) => {
        e.preventDefault();
        drop.classList.remove('dragover');
        const file = e.dataTransfer?.files?.[0];
        if (file) void this.uploadNoteImage(note.id, file);
      });
      host.appendChild(drop);
    }

    if (this.uploadStatus) {
      host.appendChild(el('div', 'admin-upload-status', this.uploadStatus));
    }
  }

  /** Open a file picker, then upload the chosen image to the given note. */
  private pickNoteImage(id: string): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) void this.uploadNoteImage(id, file);
    });
    input.click();
  }

  /** Resize the photo to webp client-side, then POST it to the authed endpoint. */
  private async uploadNoteImage(id: string, file: File): Promise<void> {
    this.uploadStatus = 'Uploading…';
    this.renderNoteDetail();
    try {
      const blob = await resizeToWebp(file, 1600, 0.85);
      const res = await fetch(`/api/admin/note-image?id=${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/webp' },
        body: blob,
        credentials: 'same-origin', // send the admin session cookie
      });
      if (!res.ok) {
        this.uploadStatus = `Upload failed (${res.status}).`;
      } else {
        // The server broadcasts NOTE_UPDATE, which refreshes the view; clear status.
        this.uploadStatus = '';
      }
    } catch (err) {
      console.error('Image upload failed:', err);
      this.uploadStatus = 'Upload failed — could not read/encode the image.';
    }
    this.renderNoteDetail();
  }

  // ─── Notes-map zoom / pan ───

  private initNotesMapControls(): void {
    const canvas = this.notesCanvas;
    if (!canvas) return;

    // Reset transform state for a fresh notes-page visit.
    this.notesZoom = 1;
    this.notesPanX = 0;
    this.notesPanY = 0;
    this.notesPrevCanvasSize = 0;
    this.notesPointers.clear();
    this.notesLastPinchDist = 0;

    canvas.style.touchAction = 'none';
    canvas.style.cursor = 'grab';

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this.applyNotesZoom(Math.exp(-step * 0.0015), e.clientX, e.clientY);
    };

    let downPos: { x: number; y: number } | null = null;
    let moved = 0;
    let pinched = false;

    const onPointerDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      this.notesPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.notesPointers.size === 1) {
        downPos = { x: e.clientX, y: e.clientY };
        moved = 0;
        pinched = false;
        canvas.style.cursor = 'grabbing';
      } else if (this.notesPointers.size === 2) {
        this.notesLastPinchDist = this.notesPinchDistance();
        pinched = true;
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      const prev = this.notesPointers.get(e.pointerId);
      if (!prev) return;

      if (this.notesPointers.size === 1) {
        // Pan: one-finger drag in canvas pixels.
        const rect = canvas.getBoundingClientRect();
        this.notesPanX += (e.clientX - prev.x) * (canvas.width / rect.width);
        this.notesPanY += (e.clientY - prev.y) * (canvas.height / rect.height);
        this.clampNotesPan(canvas.width);
        this.drawNotesMap();
        moved += Math.hypot(e.clientX - prev.x, e.clientY - prev.y);
      }

      this.notesPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this.notesPointers.size === 2) {
        const dist = this.notesPinchDistance();
        const mid = this.notesPinchMidpoint();
        if (this.notesLastPinchDist > 0) {
          this.applyNotesZoom(dist / this.notesLastPinchDist, mid.x, mid.y);
        }
        this.notesLastPinchDist = dist;
        pinched = true;
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!this.notesPointers.has(e.pointerId)) return;
      canvas.releasePointerCapture(e.pointerId);
      this.notesPointers.delete(e.pointerId);

      if (this.notesPointers.size < 2) this.notesLastPinchDist = 0;
      if (this.notesPointers.size === 0) {
        canvas.style.cursor = 'grab';
        if (!pinched && moved < 6 && downPos) {
          this.handleNotesMapTap(downPos.x, downPos.y);
        }
        downPos = null;
      }
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerUp);

    this.notesMapDispose = () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerUp);
    };
  }

  private applyNotesZoom(factor: number, clientX: number, clientY: number): void {
    const canvas = this.notesCanvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    // Cursor position in canvas pixels.
    const px = ((clientX - rect.left) / rect.width) * canvas.width;
    const py = ((clientY - rect.top) / rect.height) * canvas.height;
    const newZoom = Math.max(1, Math.min(14, this.notesZoom * factor));
    // Keep the map point under the cursor fixed:
    //   before: px = panX + mapX * oldZoom
    //   after:  px = panX' + mapX * newZoom
    const mapX = (px - this.notesPanX) / this.notesZoom;
    const mapY = (py - this.notesPanY) / this.notesZoom;
    this.notesPanX = px - mapX * newZoom;
    this.notesPanY = py - mapY * newZoom;
    this.notesZoom = newZoom;
    this.clampNotesPan(canvas.width);
    this.drawNotesMap();
  }

  /** Keep pan so the zoomed map image always fills/covers the canvas. */
  private clampNotesPan(size: number): void {
    if (this.notesZoom <= 1) {
      this.notesPanX = 0;
      this.notesPanY = 0;
      return;
    }
    const minPan = size * (1 - this.notesZoom); // negative
    this.notesPanX = Math.max(minPan, Math.min(0, this.notesPanX));
    this.notesPanY = Math.max(minPan, Math.min(0, this.notesPanY));
  }

  private notesPinchDistance(): number {
    const pts = [...this.notesPointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  private notesPinchMidpoint(): { x: number; y: number } {
    const pts = [...this.notesPointers.values()];
    return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
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

/**
 * Downscale + re-encode an image File to a webp Blob entirely in the browser, so
 * the server stays dependency-free (no `sharp`) and uploads stay small. Caps the
 * longest edge to `maxDim`; never upscales.
 */
async function resizeToWebp(file: File, maxDim: number, quality: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('webp encode failed'))),
      'image/webp',
      quality
    );
  });
}

function formatUptime(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
