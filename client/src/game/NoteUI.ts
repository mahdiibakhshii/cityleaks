import { NOTE_MAX_LENGTH } from '../../../shared/protocol';

export interface NoteUICallbacks {
  /** User submitted the compose form with this (non-empty, trimmed) text. */
  onSubmit: (text: string) => void;
  /** Compose modal opened — caller should freeze player movement. */
  onComposeOpen: () => void;
  /** Compose modal closed (submit or cancel) — caller should resume movement. */
  onComposeClose: () => void;
}

/**
 * All DOM for sticky notes:
 *  - a persistent "Stick a note" button (bottom-right),
 *  - a compose modal (textarea + char counter + submit/cancel),
 *  - a fullscreen reveal overlay that shows a note's text, font-fitted to fill
 *    the screen. The overlay is pointer-events:none and sits BELOW the joystick
 *    so the player keeps moving (and on mobile the joystick stays usable on top).
 *
 * Elements are created in code and styled via classes in styles/main.css.
 */
export class NoteUI {
  private cb: NoteUICallbacks;
  private button: HTMLButtonElement;
  private modal: HTMLDivElement;
  private textarea: HTMLTextAreaElement;
  private counter: HTMLSpanElement;
  private reveal: HTMLDivElement;
  private revealText: HTMLDivElement;
  private currentRevealKey: string | null = null;

  constructor(callbacks: NoteUICallbacks) {
    this.cb = callbacks;

    // ─── Fullscreen reveal overlay (non-interactive) ───
    this.reveal = document.createElement('div');
    this.reveal.className = 'note-reveal';
    this.revealText = document.createElement('div');
    this.revealText.className = 'note-reveal-text';
    this.reveal.appendChild(this.revealText);
    document.body.appendChild(this.reveal);

    // ─── "Stick a note" button ───
    this.button = document.createElement('button');
    this.button.className = 'note-button';
    this.button.type = 'button';
    this.button.setAttribute('aria-label', 'Stick a note');
    this.button.innerHTML = '<span class="note-button-icon">✎</span>';
    this.button.addEventListener('click', () => this.openCompose());
    document.body.appendChild(this.button);

    // ─── Compose modal ───
    this.modal = document.createElement('div');
    this.modal.className = 'note-modal';

    const panel = document.createElement('div');
    panel.className = 'note-panel';

    const title = document.createElement('div');
    title.className = 'note-panel-title';
    title.textContent = 'Stick a note here';

    this.textarea = document.createElement('textarea');
    this.textarea.className = 'note-textarea';
    this.textarea.maxLength = NOTE_MAX_LENGTH;
    this.textarea.placeholder = 'Leave an anonymous note at this spot…';
    this.textarea.addEventListener('input', () => this.updateCounter());

    this.counter = document.createElement('span');
    this.counter.className = 'note-counter';

    const actions = document.createElement('div');
    actions.className = 'note-actions';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'note-btn note-btn-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.closeCompose());

    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'note-btn note-btn-submit';
    submit.textContent = 'Stick';
    submit.addEventListener('click', () => this.submit());

    actions.append(this.counter, cancel, submit);
    panel.append(title, this.textarea, actions);
    this.modal.appendChild(panel);
    // Click outside the panel closes the modal.
    this.modal.addEventListener('mousedown', (e) => {
      if (e.target === this.modal) this.closeCompose();
    });
    document.body.appendChild(this.modal);

    this.updateCounter();
    window.addEventListener('resize', this.onResize);
  }

  // ─── Reveal overlay ───

  /**
   * Show a note's text fullscreen. Keyed by id so we only re-fit the font when
   * the revealed note actually changes (called every frame while in range).
   */
  showReveal(text: string, key: string): void {
    if (this.currentRevealKey === key) return;
    this.currentRevealKey = key;
    this.revealText.textContent = text;
    this.reveal.classList.add('visible');
    this.fitRevealText();
  }

  hideReveal(): void {
    if (this.currentRevealKey === null) return;
    this.currentRevealKey = null;
    this.reveal.classList.remove('visible');
  }

  /** Binary-search a font size so the text fills the screen without overflowing. */
  private fitRevealText(): void {
    const el = this.revealText;
    const maxBox = this.reveal.clientHeight;
    if (maxBox === 0) return; // not laid out yet
    let lo = 14;
    let hi = Math.min(window.innerWidth, window.innerHeight) * 0.6;
    // 8 iterations gets us within ~0.4% — visually exact.
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      el.style.fontSize = `${mid}px`;
      const fits =
        el.scrollWidth <= this.reveal.clientWidth &&
        el.scrollHeight <= this.reveal.clientHeight;
      if (fits) lo = mid;
      else hi = mid;
    }
    el.style.fontSize = `${lo}px`;
  }

  private onResize = (): void => {
    if (this.currentRevealKey !== null) this.fitRevealText();
  };

  // ─── Compose modal ───

  private openCompose(): void {
    this.textarea.value = '';
    this.updateCounter();
    this.modal.classList.add('visible');
    this.cb.onComposeOpen();
    // Focus after the modal is shown (mobile keyboards need the visible input).
    setTimeout(() => this.textarea.focus(), 0);
  }

  private closeCompose(): void {
    if (!this.modal.classList.contains('visible')) return;
    this.modal.classList.remove('visible');
    this.textarea.blur();
    this.cb.onComposeClose();
  }

  private submit(): void {
    const text = this.textarea.value.trim();
    if (text.length === 0) {
      this.closeCompose();
      return;
    }
    this.cb.onSubmit(text);
    this.closeCompose();
  }

  private updateCounter(): void {
    const len = this.textarea.value.length;
    this.counter.textContent = `${len}/${NOTE_MAX_LENGTH}`;
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.button.remove();
    this.modal.remove();
    this.reveal.remove();
  }
}
