/** True if the event target is a focused text field (typing, not playing). */
function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

/**
 * Tracks pressed keys (by physical code) and produces a normalized direction.
 * Data space is +Y DOWN, so "up" keys produce y = -1 (move toward smaller y).
 */
export class Keyboard {
  private keys: Set<string> = new Set();

  constructor() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (isEditable(e.target)) return; // Don't drive movement while typing a note.
    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  /** Drop all held keys (used when input is disabled, e.g. composing a note). */
  clear(): void {
    this.keys.clear();
  }

  getDirection(): { x: number; y: number } {
    let x = 0;
    let y = 0;

    if (this.keys.has('ArrowLeft') || this.keys.has('KeyA')) x -= 1;
    if (this.keys.has('ArrowRight') || this.keys.has('KeyD')) x += 1;
    if (this.keys.has('ArrowUp') || this.keys.has('KeyW')) y -= 1; // +Y down → up = -1
    if (this.keys.has('ArrowDown') || this.keys.has('KeyS')) y += 1;

    const len = Math.sqrt(x * x + y * y);
    if (len > 0) {
      x /= len;
      y /= len;
    }
    return { x, y };
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }
}
