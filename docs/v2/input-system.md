# Input System

## Overview

The input system provides a **unified direction vector** from two sources:
- **Keyboard** (desktop) — Arrow keys and/or WASD
- **Virtual joystick** (mobile) — Touch-based analog stick using nipple.js

The system auto-detects the device type and shows/hides the joystick accordingly. Both inputs produce the same output: a normalized `{x, y}` direction vector with magnitude 0–1.

## InputManager.ts

Central class that merges inputs:

```typescript
class InputManager {
  private keyboard: Keyboard;
  private joystick: Joystick | null = null;
  private isTouchDevice: boolean;

  constructor() {
    this.keyboard = new Keyboard();

    // Detect touch capability
    this.isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

    if (this.isTouchDevice) {
      this.joystick = new Joystick('joystick-zone');
    }
  }

  // Returns direction vector with components in range [-1, 1]
  // Magnitude ≤ 1 (normalized for keyboard, analog for joystick)
  getDirection(): { x: number; y: number } {
    // Joystick takes priority if active (finger is on it)
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
```

## Keyboard.ts

Listens for `keydown` / `keyup` events, tracks currently pressed keys:

```typescript
class Keyboard {
  private keys: Set<string> = new Set();

  constructor() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  getDirection(): { x: number; y: number } {
    let x = 0;
    let y = 0;

    if (this.keys.has('ArrowLeft') || this.keys.has('KeyA')) x -= 1;
    if (this.keys.has('ArrowRight') || this.keys.has('KeyD')) x += 1;
    if (this.keys.has('ArrowUp') || this.keys.has('KeyW')) y += 1;    // +Y = up in Three.js
    if (this.keys.has('ArrowDown') || this.keys.has('KeyS')) y -= 1;

    // Normalize diagonal movement
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
```

**Important:** Use `e.code` (physical key position) not `e.key` (affected by language/layout). This ensures WASD works on non-QWERTY keyboards.

**Y-axis note:** If using the +Y=down image coordinate approach (see tile-system.md), flip the Y: ArrowUp/W → `y -= 1`, ArrowDown/S → `y += 1`.

## Joystick.ts (nipple.js wrapper)

[nipple.js](https://www.npmjs.com/package/nipplejs) is a lightweight virtual joystick library. Install via:

```
npm install nipplejs
```

```typescript
import nipplejs, { JoystickManager, EventData, JoystickOutputData } from 'nipplejs';

class Joystick {
  private manager: JoystickManager;
  private direction: { x: number; y: number } = { x: 0, y: 0 };
  private active: boolean = false;

  constructor(containerId: string) {
    const container = document.getElementById(containerId)!;

    this.manager = nipplejs.create({
      zone: container,
      mode: 'static',                    // Fixed position
      position: { left: '80px', bottom: '80px' },
      color: 'rgba(255, 255, 255, 0.3)', // Semi-transparent
      size: 120,                          // Diameter in pixels
      restOpacity: 0.5,
      fadeTime: 100,
    });

    this.manager.on('move', (_evt: EventData, data: JoystickOutputData) => {
      this.active = true;
      // data.vector gives {x, y} in range [-1, 1]
      this.direction.x = data.vector.x;
      this.direction.y = data.vector.y;  // nipple.js: +Y = up, matches Three.js
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
```

### Joystick CSS (in main.css)

```css
#joystick-zone {
  position: fixed;
  left: 0;
  bottom: 0;
  width: 200px;
  height: 200px;
  z-index: 10;
  /* Only shown on touch devices — hidden on desktop via JS or media query */
}

/* Hide on devices with a mouse/pointer */
@media (hover: hover) and (pointer: fine) {
  #joystick-zone {
    display: none;
  }
}
```

### Joystick Behavior Notes

| Setting | Value | Why |
|---|---|---|
| `mode: 'static'` | Fixed position | Prevents joystick from jumping to touch point |
| `position` | Bottom-left | Doesn't obscure the center of the screen |
| `size: 120` | 120px diameter | Large enough for fat fingers, small enough to not dominate |
| `restOpacity: 0.5` | Semi-transparent | Visible but not distracting |
| `color` | `rgba(255,255,255,0.3)` | Neutral, works on any map background |

### Dead Zone

nipple.js has a built-in dead zone of ~10% of the joystick radius. Very small movements are ignored. This prevents drift when the user's thumb rests on the joystick without intending to move.

## Touch Event Considerations

- **iOS Safari:** Requires `touch-action: none` on the canvas and joystick zone to prevent browser gestures (swipe-back navigation, pinch zoom)
- **Android Chrome:** Generally well-behaved, but also benefits from `touch-action: none`
- **Multi-touch:** nipple.js handles its own touch tracking. The canvas should `preventDefault()` on touch events to avoid conflicts.
- **Orientation:** The game works in both portrait and landscape. The joystick position stays fixed relative to the viewport corner.

## Input Priority

When both keyboard and joystick are available (e.g., a tablet with a keyboard):

1. If the joystick is currently being touched (`isActive() === true`), use joystick direction
2. Otherwise, use keyboard direction
3. If neither has input, direction = `{0, 0}` → player stops
