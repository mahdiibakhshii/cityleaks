import { io, Socket } from 'socket.io-client';
import {
  EVENTS,
  CHAT_MAX_MSG_LENGTH,
  type ChatMessage,
  type ChatHistory,
  type ChatSend,
} from '../../../shared/protocol';

// Returning visitors who've already seen the explainer skip straight to the chat.
const INTRO_SEEN_KEY = 'cityleaks-chat-intro-seen';

/**
 * Anonymous per-note chat room. Each note in the city has a unique URL
 * (/c/<noteId>) printed as a QR code on the physical sticker. Opening it:
 *
 *   1. First-time scanners see a WELCOME screen explaining the project + this
 *      location-based chat, with two paths: open the chat, or explore CityLeaks.
 *   2. The CHAT thread itself: the note's real-sticker photo (if any) + its text
 *      as the "original post" at the top, then anonymous comments below, then an
 *      input bar.
 *
 * The server assigns a random color per session that persists as long as the
 * socket is alive; it's lost on reload (fully anonymous across sessions).
 */
export class ChatApp {
  private root: HTMLElement;
  private noteId: string;
  private socket: Socket | null = null;

  // Filled from the server's CHAT_HISTORY on connect.
  private myColor = '#8888aa';
  private noteText = '';
  private noteImage: string | null = null;
  private isAdminNote = false;
  private pendingHistory: ChatMessage[] = [];

  // Whether the chat shell (post card + list + input) has been built yet.
  private chatBuilt = false;

  // DOM refs built in renderChat().
  private statusBanner: HTMLDivElement | null = null;
  private messagesEl: HTMLDivElement | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private scrollBtn: HTMLButtonElement | null = null;

  // Auto-scroll unless user has scrolled up.
  private userScrolledUp = false;

  constructor(root: HTMLElement, noteId: string) {
    this.root = root;
    this.noteId = noteId;
  }

  start(): void {
    this.renderLoading();
    this.connect();
  }

  // ─── Top-level screens ───

  private renderLoading(): void {
    this.root.innerHTML = '<div class="chat-loading">Connecting…</div>';
  }

  private renderError(msg: string): void {
    this.root.innerHTML = `
      <div class="chat-error">
        <div class="chat-error-icon">!</div>
        <div>${msg}</div>
      </div>`;
  }

  /**
   * Welcome / explainer for someone who just scanned a QR code with no idea what
   * CityLeaks is. Explains the project + this chat, then offers two paths.
   */
  private renderIntro(): void {
    this.root.innerHTML = '';
    const screen = document.createElement('div');
    screen.className = 'chat-intro';

    const inner = document.createElement('div');
    inner.className = 'chat-intro-inner';

    const badge = document.createElement('div');
    badge.className = 'chat-intro-badge';
    badge.textContent = 'CITYLEAKS';

    const title = document.createElement('h1');
    title.className = 'chat-intro-title';
    title.textContent = 'You found a leak in the city.';

    const body = document.createElement('div');
    body.className = 'chat-intro-body';
    body.innerHTML = `
      <p>CityLeaks is a living map of Vienna. People roam it as little
         characters, leaving glowing trails and <strong>anonymous notes</strong>
         pinned to real places.</p>
      <p>This sticker marks one of those notes — left right here, at this exact
         spot. Below is its <strong>anonymous chat room</strong>: a place to talk
         with anyone else who passes by and scans it.</p>
      <p>No names. No accounts. Just this place, and whatever you have to say.</p>`;

    // The note preview teaser (so they see what they're about to join).
    const teaser = document.createElement('div');
    teaser.className = 'chat-intro-teaser';
    const teaserLabel = document.createElement('div');
    teaserLabel.className = 'chat-intro-teaser-label';
    teaserLabel.textContent = 'The note here says';
    const teaserText = document.createElement('div');
    teaserText.className = 'chat-intro-teaser-text' + (this.isAdminNote ? ' admin' : '');
    teaserText.textContent = this.noteText;
    teaser.append(teaserLabel, teaserText);

    const actions = document.createElement('div');
    actions.className = 'chat-intro-actions';

    const openBtn = document.createElement('button');
    openBtn.className = 'chat-intro-btn primary';
    openBtn.type = 'button';
    openBtn.textContent = 'Open the chat →';
    openBtn.addEventListener('click', () => {
      try { localStorage.setItem(INTRO_SEEN_KEY, '1'); } catch { /* private mode */ }
      this.renderChat();
    });

    const exploreBtn = document.createElement('a');
    exploreBtn.className = 'chat-intro-btn secondary';
    exploreBtn.href = '/';
    exploreBtn.textContent = 'Explore CityLeaks';

    actions.append(openBtn, exploreBtn);
    inner.append(badge, title, body, teaser, actions);
    screen.appendChild(inner);
    this.root.appendChild(screen);
  }

  /** Build the chat thread shell (post card + comments + input). */
  private renderChat(): void {
    this.chatBuilt = true;
    this.root.innerHTML = '';

    // Status banner (hidden when connected).
    const banner = document.createElement('div');
    banner.className = 'chat-status-banner ' + (this.socket?.connected ? 'hidden' : 'connecting');
    banner.textContent = 'Connecting…';
    this.statusBanner = banner;

    // Slim top bar with a link back to the project.
    const header = document.createElement('div');
    header.className = 'chat-topbar';
    const home = document.createElement('a');
    home.className = 'chat-topbar-home';
    home.href = '/';
    home.textContent = '‹ CityLeaks';
    const sub = document.createElement('span');
    sub.className = 'chat-topbar-sub';
    sub.textContent = 'anonymous chat';
    header.append(home, sub);

    // Scrollable thread.
    const messages = document.createElement('div');
    messages.className = 'chat-messages';
    this.messagesEl = messages;
    messages.addEventListener('scroll', () => {
      const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
      this.userScrolledUp = !atBottom;
      if (this.scrollBtn) this.scrollBtn.classList.toggle('visible', this.userScrolledUp);
    });

    // The "original post": image (optional) + the note's text.
    messages.appendChild(this.buildPostCard());

    // Divider before comments.
    const divider = document.createElement('div');
    divider.className = 'chat-comments-divider';
    divider.textContent = 'Comments';
    messages.appendChild(divider);

    // Scroll-to-bottom button.
    const scrollBtn = document.createElement('button');
    scrollBtn.className = 'chat-scroll-btn';
    scrollBtn.setAttribute('aria-label', 'Scroll to bottom');
    scrollBtn.textContent = '↓';
    scrollBtn.addEventListener('click', () => {
      this.scrollToBottom(true);
      this.userScrolledUp = false;
      scrollBtn.classList.remove('visible');
    });
    this.scrollBtn = scrollBtn;

    const body = document.createElement('div');
    body.style.cssText = 'position:relative;flex:1;display:flex;flex-direction:column;overflow:hidden;';
    body.append(messages, scrollBtn);

    // Input bar.
    const bar = document.createElement('div');
    bar.className = 'chat-input-bar';

    const textarea = document.createElement('textarea');
    textarea.className = 'chat-textarea';
    textarea.placeholder = 'Add a comment…';
    textarea.maxLength = CHAT_MAX_MSG_LENGTH;
    textarea.rows = 1;
    textarea.setAttribute('autocomplete', 'off');
    textarea.setAttribute('autocorrect', 'off');
    textarea.setAttribute('spellcheck', 'true');
    this.textarea = textarea;
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    });
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    });

    const sendBtn = document.createElement('button');
    sendBtn.className = 'chat-send-btn';
    sendBtn.type = 'button';
    sendBtn.setAttribute('aria-label', 'Send');
    sendBtn.textContent = '→';
    sendBtn.addEventListener('click', () => this.send());
    this.sendBtn = sendBtn;

    bar.append(textarea, sendBtn);

    this.root.append(banner, header, body, bar);

    // Populate any history we already received.
    this.populateMessages(this.pendingHistory);
  }

  /** The "original post" card: real-sticker photo (optional) + note text. */
  private buildPostCard(): HTMLDivElement {
    const card = document.createElement('div');
    card.className = 'chat-post' + (this.isAdminNote ? ' admin' : '');

    if (this.noteImage) {
      const figure = document.createElement('div');
      figure.className = 'chat-post-img';
      const img = document.createElement('img');
      img.src = this.noteImage;
      img.alt = 'The physical sticker in the city';
      img.loading = 'eager';
      // Tap to open the full photo in a new tab.
      img.addEventListener('click', () => window.open(this.noteImage!, '_blank'));
      figure.appendChild(img);
      card.appendChild(figure);
    }

    const label = document.createElement('div');
    label.className = 'chat-post-label';
    label.textContent = this.isAdminNote ? 'Creator note · left here' : 'Note left here';

    const text = document.createElement('div');
    text.className = 'chat-post-text';
    text.textContent = this.noteText;

    card.append(label, text);
    return card;
  }

  // ─── Socket ───

  private connect(): void {
    this.socket = io({
      query: { role: 'chat', note: this.noteId },
      reconnectionDelay: 1500,
      reconnectionDelayMax: 8000,
    });

    this.socket.on('connect', () => this.setBanner('hidden', ''));
    this.socket.on('disconnect', () => this.setBanner('disconnected', 'Disconnected — reconnecting…'));
    this.socket.on('connect_error', () => this.setBanner('connecting', 'Connecting…'));

    this.socket.on(EVENTS.CHAT_HISTORY, (data: ChatHistory) => {
      this.myColor = data.yourColor;
      this.noteText = data.note.text;
      this.noteImage = data.note.image ?? null;
      this.isAdminNote = data.note.admin ?? false;
      this.pendingHistory = data.messages;

      if (this.chatBuilt) {
        // A reconnect: just refresh the thread.
        this.populateMessages(data.messages);
      } else {
        // First load: show the intro for newcomers, else jump to the chat.
        let seen = false;
        try { seen = localStorage.getItem(INTRO_SEEN_KEY) === '1'; } catch { /* ignore */ }
        if (seen) this.renderChat();
        else this.renderIntro();
      }
    });

    this.socket.on(EVENTS.CHAT_MESSAGE, (msg: ChatMessage) => {
      if (!this.messagesEl) {
        // Message arrived while on the intro screen — keep it for when chat opens.
        this.pendingHistory.push(msg);
        return;
      }
      const empty = this.messagesEl.querySelector('.chat-empty');
      if (empty) empty.remove();
      this.appendMessage(msg, true);
      if (!this.userScrolledUp) this.scrollToBottom(false);
    });

    this.socket.on('chat:error', (payload: { error: string }) => {
      this.renderError(
        payload.error === 'unknown note'
          ? 'This note no longer exists.<br>The chat has closed.'
          : 'Could not connect to the chat room.'
      );
    });
  }

  // ─── Message rendering ───

  /** Clear + repopulate the comment list (keeps the post card + divider). */
  private populateMessages(messages: ChatMessage[]): void {
    if (!this.messagesEl) return;
    // Remove only comment rows / placeholders, keep the post card + divider.
    this.messagesEl
      .querySelectorAll('.chat-msg, .chat-empty')
      .forEach((n) => n.remove());

    if (messages.length === 0) {
      this.appendSystemMsg('No comments yet. Be the first to say something.');
    } else {
      for (const msg of messages) this.appendMessage(msg, false);
      this.scrollToBottom(false);
    }
  }

  private appendMessage(msg: ChatMessage, animate: boolean): void {
    if (!this.messagesEl) return;
    const isOwn = msg.color === this.myColor;

    const wrapper = document.createElement('div');
    wrapper.className = `chat-msg ${isOwn ? 'own' : 'other'}`;
    if (!animate) wrapper.style.animation = 'none';

    const meta = document.createElement('div');
    meta.className = 'chat-msg-meta';
    const dot = document.createElement('span');
    dot.className = 'chat-msg-dot';
    dot.style.background = msg.color;
    const timeEl = document.createElement('span');
    timeEl.textContent = this.relativeTime(msg.createdAt);
    timeEl.title = new Date(msg.createdAt).toLocaleTimeString();
    meta.append(dot, timeEl);

    const bubble = document.createElement('div');
    bubble.className = 'chat-msg-bubble';
    bubble.textContent = msg.text;
    if (!isOwn) bubble.style.setProperty('--msg-color', msg.color);

    wrapper.append(meta, bubble);
    this.messagesEl.appendChild(wrapper);
  }

  private appendSystemMsg(text: string): void {
    if (!this.messagesEl) return;
    const el = document.createElement('div');
    el.className = 'chat-empty';
    el.textContent = text;
    this.messagesEl.appendChild(el);
  }

  // ─── Helpers ───

  private send(): void {
    const ta = this.textarea;
    if (!ta || !this.socket?.connected) return;
    const text = ta.value.trim();
    if (!text) return;
    const payload: ChatSend = { text };
    this.socket.emit(EVENTS.CHAT_SEND, payload);
    ta.value = '';
    ta.style.height = 'auto';
    ta.focus();
  }

  private scrollToBottom(smooth: boolean): void {
    if (!this.messagesEl) return;
    this.messagesEl.scrollTo({
      top: this.messagesEl.scrollHeight,
      behavior: smooth ? 'smooth' : 'instant',
    });
  }

  private setBanner(state: 'hidden' | 'connecting' | 'disconnected', text: string): void {
    if (!this.statusBanner) return;
    this.statusBanner.className = `chat-status-banner ${state}`;
    this.statusBanner.textContent = text;
  }

  private relativeTime(epochMs: number): string {
    const diff = Math.floor((Date.now() - epochMs) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return new Date(epochMs).toLocaleDateString();
  }
}
