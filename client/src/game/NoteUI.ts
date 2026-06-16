import { NOTE_MAX_LENGTH } from '../../../shared/protocol';
import { googleMapsUrl, formatLatLng } from '../../../shared/geo';

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
 *  - when the revealed note has a photo: a thumbnail above the text (clickable,
 *    pointer-events:auto despite the non-interactive parent) that opens a
 *    full-size image lightbox with an optional georeferenced Maps link.
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
  private thumbnail: HTMLDivElement;
  private thumbnailImg: HTMLImageElement;
  private revealText: HTMLDivElement;
  private lightbox: HTMLDivElement;
  private lightboxImg: HTMLImageElement;
  private lightboxGeo: HTMLAnchorElement;
  private currentRevealKey: string | null = null;
  private currentNotePos: { x: number; y: number } | null = null;

  // Transient admin broadcast overlay (distinct from note reveals).
  private announce: HTMLDivElement;
  private announceText: HTMLDivElement;
  private announceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(callbacks: NoteUICallbacks) {
    this.cb = callbacks;

    // ─── Fullscreen reveal overlay (non-interactive, except the thumbnail) ───
    // Column layout: thumbnail (when present) sits above the text, both centered.
    this.reveal = document.createElement('div');
    this.reveal.className = 'note-reveal';

    // Thumbnail lives inside the reveal so it stays naturally above the text.
    // pointer-events:auto in CSS overrides the parent's none so it's clickable.
    this.thumbnail = document.createElement('div');
    this.thumbnail.className = 'note-img-thumbnail';
    this.thumbnailImg = document.createElement('img');
    this.thumbnailImg.alt = '';
    this.thumbnail.appendChild(this.thumbnailImg);
    this.thumbnail.addEventListener('click', () => this.openLightbox());
    this.reveal.appendChild(this.thumbnail);

    this.revealText = document.createElement('div');
    this.revealText.className = 'note-reveal-text';
    this.reveal.appendChild(this.revealText);

    document.body.appendChild(this.reveal);

    // ─── Fullscreen image lightbox (no background layer; user closes explicitly) ───
    this.lightbox = document.createElement('div');
    this.lightbox.className = 'note-img-lightbox';

    const lbClose = document.createElement('button');
    lbClose.className = 'note-img-lightbox-close';
    lbClose.type = 'button';
    lbClose.setAttribute('aria-label', 'Close image');
    lbClose.textContent = '×';
    lbClose.addEventListener('click', () => this.closeLightbox());

    this.lightboxImg = document.createElement('img');
    this.lightboxImg.alt = '';

    this.lightboxGeo = document.createElement('a');
    this.lightboxGeo.className = 'note-img-lightbox-geo';
    this.lightboxGeo.target = '_blank';
    this.lightboxGeo.rel = 'noopener noreferrer';
    this.lightboxGeo.style.display = 'none';

    const lbContent = document.createElement('div');
    lbContent.className = 'note-img-lightbox-content';
    lbContent.append(this.lightboxImg, this.lightboxGeo);

    // Clicking outside the image+link block closes the lightbox.
    this.lightbox.addEventListener('click', (e) => {
      if (!lbContent.contains(e.target as Node) && e.target !== lbClose) {
        this.closeLightbox();
      }
    });

    this.lightbox.append(lbClose, lbContent);
    document.body.appendChild(this.lightbox);

    // ─── Admin broadcast overlay (non-interactive, auto-dismissed) ───
    this.announce = document.createElement('div');
    this.announce.className = 'admin-announce';
    this.announceText = document.createElement('div');
    this.announceText.className = 'admin-announce-text';
    this.announce.appendChild(this.announceText);
    document.body.appendChild(this.announce);

    // ─── "Take the spray out" button (opens the compose modal) ───
    this.button = document.createElement('button');
    this.button.className = 'note-button';
    this.button.type = 'button';
    this.button.setAttribute('aria-label', 'Take the spray out and write here');
    this.button.textContent = 'Take the spray out';
    this.button.addEventListener('click', () => this.openCompose());
    document.body.appendChild(this.button);

    // ─── Compose modal ───
    this.modal = document.createElement('div');
    this.modal.className = 'note-modal';

    const panel = document.createElement('div');
    panel.className = 'note-panel';

    const title = document.createElement('div');
    title.className = 'note-panel-title';
    title.textContent = 'Spray your words here';

    this.textarea = document.createElement('textarea');
    this.textarea.className = 'note-textarea';
    this.textarea.maxLength = NOTE_MAX_LENGTH;
    this.textarea.placeholder = 'Write your words here — others will read them when they pass by this spot.';
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
    submit.textContent = 'Spray';
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
   * noteX/Y feed the georeferenced Maps link in the image lightbox.
   */
  showReveal(
    text: string,
    key: string,
    isAdmin = false,
    image: string | null = null,
    noteX?: number,
    noteY?: number,
  ): void {
    if (this.currentRevealKey === key) return;
    this.currentRevealKey = key;
    this.currentNotePos =
      noteX != null && noteY != null ? { x: noteX, y: noteY } : null;

    this.reveal.classList.toggle('admin', isAdmin);
    this.reveal.classList.add('visible');
    this.revealText.textContent = text;
    this.fitRevealText();

    if (image) {
      this.thumbnailImg.src = image;
      this.thumbnail.classList.add('visible');
    } else {
      this.thumbnail.classList.remove('visible');
    }
  }

  /**
   * Flash a transient admin broadcast over the screen in the distinct creator
   * style (like a note reveal, but auto-dismissed). A new broadcast replaces the
   * current one and restarts the timer.
   */
  showAnnouncement(text: string, durationMs = 6000): void {
    this.announceText.textContent = text;
    this.announce.classList.add('visible');
    if (this.announceTimer) clearTimeout(this.announceTimer);
    this.announceTimer = setTimeout(() => {
      this.announce.classList.remove('visible');
      this.announceTimer = null;
    }, durationMs);
  }

  hideReveal(): void {
    if (this.currentRevealKey === null) return;
    this.currentRevealKey = null;
    this.currentNotePos = null;
    this.reveal.classList.remove('visible');
    this.thumbnail.classList.remove('visible');
  }

  /**
   * Binary-search a font size so the text fits its column without overflowing,
   * then CAP it so short notes stay a comfortable reading size instead of
   * blowing up to fill the whole screen. The text wraps inside a centered column
   * (see `.note-reveal-text` max-width) so longer notes align tidily.
   */
  private fitRevealText(): void {
    const el = this.revealText;
    if (this.reveal.clientHeight === 0) return; // not laid out yet
    // Upper bound: a fraction of the shorter screen axis, with an absolute
    // ceiling — keeps text readable, not gigantic, on any screen size.
    const cap = Math.min(72, Math.min(window.innerWidth, window.innerHeight) * 0.11);
    let lo = 14;
    let hi = Math.max(lo, cap);
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

  private openLightbox(): void {
    this.lightboxImg.src = this.thumbnailImg.src;

    const pos = this.currentNotePos;
    const url = pos ? googleMapsUrl(pos.x, pos.y) : null;
    const label = pos ? formatLatLng(pos.x, pos.y) : null;
    if (url && label) {
      this.lightboxGeo.href = url;
      this.lightboxGeo.textContent = `📍 ${label}`;
      this.lightboxGeo.style.display = '';
    } else {
      this.lightboxGeo.style.display = 'none';
    }

    this.lightbox.classList.add('visible');
  }

  private closeLightbox(): void {
    this.lightbox.classList.remove('visible');
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
    if (this.announceTimer) clearTimeout(this.announceTimer);
    this.button.remove();
    this.modal.remove();
    this.reveal.remove();
    this.lightbox.remove();
    this.announce.remove();
  }
}
