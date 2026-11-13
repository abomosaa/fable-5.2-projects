/**
 * Keyboard and gamepad input. Produces the quantised `CarInput` that is sent
 * to the server and fed to client-side prediction, plus edge-triggered UI
 * actions (camera, pause).
 */
import { quantizeInput } from '../../../shared/protocol/binary';
import type { CarInput } from '../../../shared/sim/vehicle';
import type { Action, PadAction, Settings } from '../storage/settings';

export type UiAction = 'camera' | 'pause';

const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

export class InputManager {
  /** When false, driving input is neutral (menus, chat, results). */
  enabled = false;
  /** Called for edge-triggered actions. */
  onUiAction: ((action: UiAction) => void) | null = null;
  /** Name of the connected gamepad, or '' when there is none. */
  gamepadName = '';
  /** Whichever device produced input most recently. */
  lastDevice: 'keyboard' | 'gamepad' = 'keyboard';

  private readonly down = new Set<string>();
  private readonly padPressed = new Map<number, boolean>();
  private capture: ((code: string) => void) | null = null;
  private padCapture: ((button: number) => void) | null = null;
  private padSteer = 0;
  private padThrottle = 0;
  private padBrake = 0;
  private padHandbrake = false;
  private padReset = false;

  constructor(private settings: Settings) {
    window.addEventListener('keydown', (event) => this.onKey(event, true));
    window.addEventListener('keyup', (event) => this.onKey(event, false));
    window.addEventListener('blur', () => this.down.clear());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.down.clear();
    });
    window.addEventListener('gamepadconnected', (event) => {
      this.gamepadName = event.gamepad.id;
    });
    window.addEventListener('gamepaddisconnected', () => {
      this.gamepadName = '';
      this.padSteer = 0;
      this.padThrottle = 0;
      this.padBrake = 0;
      this.padHandbrake = false;
      this.padReset = false;
    });
  }

  setSettings(settings: Settings): void {
    this.settings = settings;
  }

  /** The next key press is reported to `callback` instead of being handled (remapping). */
  captureNextKey(callback: (code: string) => void): void {
    this.capture = callback;
  }

  captureNextPadButton(callback: (button: number) => void): void {
    this.padCapture = callback;
  }

  cancelCapture(): void {
    this.capture = null;
    this.padCapture = null;
  }

  private isTyping(event: KeyboardEvent): boolean {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return false;
    return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
  }

  private onKey(event: KeyboardEvent, pressed: boolean): void {
    if (this.capture && pressed) {
      event.preventDefault();
      event.stopPropagation();
      const callback = this.capture;
      this.capture = null;
      callback(event.code);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (this.isTyping(event)) {
      // Let Escape close menus even while a field has focus.
      if (pressed && !event.repeat && this.matches('pause', event.code)) this.onUiAction?.('pause');
      return;
    }
    if (pressed) {
      if (!event.repeat) {
        this.lastDevice = 'keyboard';
        if (this.matches('pause', event.code)) this.onUiAction?.('pause');
        else if (this.matches('camera', event.code)) this.onUiAction?.('camera');
      }
      this.down.add(event.code);
    } else {
      this.down.delete(event.code);
    }
    // Keep the page from scrolling while driving.
    if (this.enabled && (GAME_KEYS.has(event.code) || this.isBound(event.code))) event.preventDefault();
  }

  private matches(action: Action, code: string): boolean {
    return this.settings.keys[action].includes(code);
  }

  private isBound(code: string): boolean {
    for (const list of Object.values(this.settings.keys)) if (list.includes(code)) return true;
    return false;
  }

  private held(action: Action): boolean {
    for (const code of this.settings.keys[action]) if (this.down.has(code)) return true;
    return false;
  }

  /** Reads the gamepad. Call once per frame. */
  poll(): void {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    let pad: Gamepad | null = null;
    for (const candidate of pads) {
      if (candidate && candidate.connected) {
        pad = candidate;
        break;
      }
    }
    if (!pad) {
      this.padSteer = 0;
      this.padThrottle = 0;
      this.padBrake = 0;
      this.padHandbrake = false;
      this.padReset = false;
      return;
    }
    this.gamepadName = pad.id;

    if (this.padCapture) {
      for (let i = 0; i < pad.buttons.length; i++) {
        const now = pad.buttons[i]!.pressed;
        if (now && !this.padPressed.get(i)) {
          const callback = this.padCapture;
          this.padCapture = null;
          this.padPressed.set(i, true);
          callback(i);
          return;
        }
        this.padPressed.set(i, now);
      }
      return;
    }

    const deadzone = this.settings.padDeadzone;
    const raw = pad.axes[0] ?? 0;
    const magnitude = Math.abs(raw);
    let steer = 0;
    if (magnitude > deadzone) {
      const scaled = (magnitude - deadzone) / (1 - deadzone);
      // A gentle curve gives finer control around the centre.
      steer = Math.sign(raw) * Math.pow(scaled, 1.5);
    }
    // D-pad as a digital fallback.
    if (pad.buttons[14]?.pressed) steer = -1;
    if (pad.buttons[15]?.pressed) steer = 1;
    this.padSteer = steer;

    const value = (action: PadAction): number => {
      const button = pad.buttons[this.settings.pad[action]];
      return button ? Math.max(button.value, button.pressed ? 1 : 0) : 0;
    };
    this.padThrottle = value('accelerate');
    this.padBrake = value('brake');
    this.padHandbrake = value('handbrake') > 0.5;
    this.padReset = value('reset') > 0.5;

    for (const action of ['camera', 'pause'] as const) {
      const index = this.settings.pad[action];
      const now = (pad.buttons[index]?.pressed ?? false) === true;
      const before = this.padPressed.get(index) ?? false;
      if (now && !before) {
        this.lastDevice = 'gamepad';
        this.onUiAction?.(action);
      }
      this.padPressed.set(index, now);
    }
    if (Math.abs(steer) > 0.2 || this.padThrottle > 0.2 || this.padBrake > 0.2) this.lastDevice = 'gamepad';
  }

  /** Current driving input, already quantised to the wire format. */
  sample(): CarInput {
    if (!this.enabled) return quantizeInput(0, 0, 0, false, false);
    let steer = (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);
    let throttle = this.held('accelerate') ? 1 : 0;
    let brake = this.held('brake') ? 1 : 0;
    if (Math.abs(this.padSteer) > Math.abs(steer)) steer = this.padSteer;
    throttle = Math.max(throttle, this.padThrottle);
    brake = Math.max(brake, this.padBrake);
    return quantizeInput(
      steer,
      throttle,
      brake,
      this.held('handbrake') || this.padHandbrake,
      this.held('reset') || this.padReset,
    );
  }
}
