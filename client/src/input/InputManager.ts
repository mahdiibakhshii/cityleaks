import { Keyboard } from './Keyboard';
import { Joystick } from './Joystick';

/**
 * Merges keyboard and touch joystick into a single direction vector.
 * Joystick takes priority while it is being touched.
 */
export class InputManager {
  private keyboard: Keyboard;
  private joystick: Joystick | null = null;
  private enabled = true;
  readonly isTouchDevice: boolean;

  constructor() {
    this.keyboard = new Keyboard();
    this.isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (this.isTouchDevice) {
      this.joystick = new Joystick('joystick-zone');
    }
  }

  /** Freeze/unfreeze movement (e.g. while the note-compose modal is open). */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.keyboard.clear();
  }

  /** Returns a direction vector with components in [-1, 1], magnitude ≤ 1. */
  getDirection(): { x: number; y: number } {
    if (!this.enabled) return { x: 0, y: 0 };
    if (this.joystick && this.joystick.isActive()) {
      return this.joystick.getDirection();
    }
    return this.keyboard.getDirection();
  }

  dispose(): void {
    this.keyboard.dispose();
    this.joystick?.dispose();
  }
}
