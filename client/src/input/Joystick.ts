import nipplejs from 'nipplejs';
import type { JoystickManager, EventData, JoystickOutputData } from 'nipplejs';

/**
 * Virtual joystick wrapper (nipple.js) for touch devices.
 * nipple.js outputs +Y = up; data space is +Y down, so we negate Y.
 */
export class Joystick {
  private manager: JoystickManager;
  private direction: { x: number; y: number } = { x: 0, y: 0 };
  private active = false;

  constructor(containerId: string) {
    const container = document.getElementById(containerId)!;

    this.manager = nipplejs.create({
      zone: container,
      mode: 'static',
      position: { left: '80px', bottom: '80px' },
      color: 'rgba(255, 255, 255, 0.9)',
      size: 130,
      restOpacity: 0.9,
      fadeTime: 100,
    });

    this.manager.on('move', (_evt: EventData, data: JoystickOutputData) => {
      if (!data?.vector) return;
      this.active = true;
      this.direction.x = data.vector.x;
      this.direction.y = -data.vector.y; // nipple +Y up → data +Y down.
    });

    this.manager.on('end', () => {
      this.active = false;
      this.direction.x = 0;
      this.direction.y = 0;
    });
  }

  isActive(): boolean {
    return this.active;
  }

  getDirection(): { x: number; y: number } {
    return { ...this.direction };
  }

  dispose(): void {
    this.manager.destroy();
  }
}
