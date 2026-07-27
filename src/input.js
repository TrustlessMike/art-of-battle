/**
 * The mouse does two jobs, exactly as it does in For Honor.
 *
 * Free: it steers — yaw and pitch, ordinary first-person look.
 * Locked on: the fighter turns to face their opponent on its own, so the mouse
 * is released to set the guard. It behaves as a virtual stick that stays where
 * you flicked it, so your guard persists until you deliberately move it.
 */

const DEAD = 0.42;

/**
 * Physical key identity, with a fallback.
 *
 * Everything here is keyed off `KeyboardEvent.code` so the bindings follow key
 * position rather than the character produced. Some event sources — synthetic
 * events, a few IMEs, remote-desktop and accessibility paths — supply only
 * `key`, and without this the entire keyboard would be dead for them.
 */
function codeOf(e) {
  if (e.code) return e.code;
  const k = e.key;
  if (!k) return '';
  if (k === ' ') return 'Space';
  if (k.length === 1) {
    if (/[a-z]/i.test(k)) return `Key${k.toUpperCase()}`;
    if (/[0-9]/.test(k)) return `Digit${k}`;
  }
  return k;                    // Enter, ArrowLeft, Tab, Backspace, ...
}

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.stick = { x: 0.8, y: -0.2 };   // starts in the right guard
    this.guard = 'right';
    this.guardChanged = false;
    this.sensitivity = 0.0075;
    this.lookSensitivity = 0.0022;
    this.locked = false;
    this.lockedOn = false;      // set by the game each frame
    this.yaw = 0;
    this.pitch = 0;
    this.maxPitch = 1.15;

    this.pressed = {
      light: false, heavy: false, feint: false, gb: false, dodge: false,
      restart: false, pause: false, toggleLock: false, cycleQuality: false,
      difficulty: null, gadgetSlot: null,
      cycleWeapon: 0,
    };
    this.heavyHeld = false;
    this.heavyReleased = false;
    this.anyInput = false;
    // Raw edge-triggered keys + typed text, for menus that want neither the
    // guard stick nor the combat bindings. An ordered queue rather than a set:
    // if a frame runs long — or the tab is backgrounded and rAF pauses — several
    // presses land between flushes, and every one of them should count.
    this.justPressed = [];
    this.typed = '';

    this._bind();
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener('click', () => {
      if (!this.locked) c.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === c;
    });

    document.addEventListener('mousemove', (e) => {
      if (this.locked) {
        if (this.lockedOn) {
          this._moveStick(e.movementX * this.sensitivity,
            -e.movementY * this.sensitivity);
        } else {
          this._look(e.movementX, e.movementY);
        }
        return;
      }
      // Without pointer lock the cursor's offset from the centre of the screen
      // drives whichever job the mouse currently has, so the game stays fully
      // playable in contexts where lock is unavailable.
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      const nx = (e.clientX - cx) / (window.innerWidth * 0.22);
      const ny = -(e.clientY - cy) / (window.innerHeight * 0.22);
      if (this.lockedOn) {
        this._setStick(nx, ny);
      } else if (this._lastX !== undefined) {
        this._look(e.clientX - this._lastX, e.clientY - this._lastY);
      }
      this._lastX = e.clientX;
      this._lastY = e.clientY;
    });

    c.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.anyInput = true;
      if (e.button === 0) this.pressed.light = true;
      if (e.button === 2) { this.pressed.heavy = true; this.heavyHeld = true; }
      if (e.button === 1) this.pressed.gb = true;
    });
    c.addEventListener('mouseup', (e) => {
      if (e.button === 2 && this.heavyHeld) {
        this.heavyHeld = false;
        this.heavyReleased = true;
      }
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const code = codeOf(e);
      this.keys.add(code);
      this.anyInput = true;
      this.justPressed.push(code);
      if (e.key && e.key.length === 1) this.typed += e.key;
      else if (code === 'Backspace') this.typed += '\b';
      switch (code) {
        case 'Space': this.pressed.dodge = true; e.preventDefault(); break;
        case 'KeyF': this.pressed.feint = true; break;
        case 'KeyE': this.pressed.gb = true; break;
        case 'KeyR': this.pressed.restart = true; break;
        case 'KeyP': this.pressed.pause = true; break;
        case 'KeyQ': this.pressed.toggleLock = true; break;
        case 'KeyG': this.pressed.cycleQuality = true; break;
        // Keyboard guard, for players who would rather not use the mouse.
        case 'ArrowUp': this._setStick(0, 1); break;
        case 'ArrowLeft': this._setStick(-1, 0); break;
        case 'ArrowRight': this._setStick(1, 0); break;
        case 'KeyJ': this.pressed.light = true; break;
        case 'KeyK': this.pressed.heavy = true; this.heavyHeld = true; break;
        // Number keys pick utility in a match, difficulty on the title card.
        case 'Digit1': this.pressed.difficulty = 'squire'; this.pressed.gadgetSlot = 0; break;
        case 'Digit2': this.pressed.difficulty = 'warrior'; this.pressed.gadgetSlot = 1; break;
        case 'Digit3': this.pressed.difficulty = 'warlord'; this.pressed.gadgetSlot = 2; break;
        case 'Digit4': this.pressed.gadgetSlot = 3; break;
        case 'Tab':
          this.pressed.cycleWeapon = e.shiftKey ? -1 : 1;
          e.preventDefault();
          break;
      }
    });
    window.addEventListener('keyup', (e) => {
      const code = codeOf(e);
      this.keys.delete(code);
      if (code === 'KeyK' && this.heavyHeld) {
        this.heavyHeld = false;
        this.heavyReleased = true;
      }
    });
    window.addEventListener('blur', () => this.keys.clear());
  }

  _look(dx, dy) {
    this.yaw -= dx * this.lookSensitivity;
    this.pitch -= dy * this.lookSensitivity;
    if (this.pitch > this.maxPitch) this.pitch = this.maxPitch;
    if (this.pitch < -this.maxPitch) this.pitch = -this.maxPitch;
  }

  _moveStick(dx, dy) {
    this.stick.x += dx;
    this.stick.y += dy;
    const len = Math.hypot(this.stick.x, this.stick.y);
    if (len > 1) {
      this.stick.x /= len;
      this.stick.y /= len;
    }
    this._resolveGuard();
  }

  _setStick(x, y) {
    const len = Math.hypot(x, y);
    this.stick.x = len > 1 ? x / len : x;
    this.stick.y = len > 1 ? y / len : y;
    this._resolveGuard();
  }

  _resolveGuard() {
    const { x, y } = this.stick;
    if (Math.hypot(x, y) < DEAD) return;
    const next = (y > Math.abs(x) * 0.85) ? 'top' : (x < 0 ? 'left' : 'right');
    if (next !== this.guard) {
      this.guard = next;
      this.guardChanged = true;
    }
  }

  /** Movement vector in camera/character space: x = strafe, y = forward. */
  move(out = { x: 0, y: 0 }) {
    const k = this.keys;
    out.x = (k.has('KeyA') ? 1 : 0) - (k.has('KeyD') ? 1 : 0);
    out.y = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const len = Math.hypot(out.x, out.y);
    if (len > 1) { out.x /= len; out.y /= len; }
    return out;
  }

  /** Consume this frame's edge-triggered inputs. */
  flush() {
    const p = { ...this.pressed, heavyReleased: this.heavyReleased,
      guardChanged: this.guardChanged };
    for (const k in this.pressed) {
      if (k === 'difficulty' || k === 'gadgetSlot') this.pressed[k] = null;
      else if (k === 'cycleWeapon') this.pressed[k] = 0;
      else this.pressed[k] = false;
    }
    p.keys = this.justPressed;
    p.typed = this.typed;
    this.justPressed = [];
    this.typed = '';
    this.heavyReleased = false;
    this.guardChanged = false;
    return p;
  }
}
