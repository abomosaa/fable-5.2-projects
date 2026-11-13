/**
 * Pilot input: USB radio transmitters / gamepads through the Gamepad API, with
 * a keyboard fallback. Produces the four stick channels plus edge-triggered
 * actions (arm, reset, mode, ...).
 */
import { RcInput } from '../sim/fc';
import { clamp } from '../sim/math';

export interface AxisBinding {
  index: number;
  invert: boolean;
  /** Calibrated raw range. */
  min: number;
  max: number;
}

export type ArmBinding =
  | { type: 'none' }
  | { type: 'button'; index: number }
  | { type: 'axis'; index: number; invert: boolean };

export interface PadConfig {
  axes: { roll: AxisBinding; pitch: AxisBinding; yaw: AxisBinding; throttle: AxisBinding };
  /** 'full': whole stick travel = 0..100 %. 'upper': centre = 0 %, only the upper half is used. */
  throttleMode: 'full' | 'upper';
  deadband: number;
  arm: ArmBinding;
  buttons: { reset: number; mode: number; view: number; turtle: number };
}

export type Channel = 'roll' | 'pitch' | 'yaw' | 'throttle';
export const CHANNELS: Channel[] = ['throttle', 'yaw', 'pitch', 'roll'];

export type Action = 'armToggle' | 'arm' | 'disarm' | 'reset' | 'mode' | 'view' | 'turtle' | 'pause' | 'menu' | 'osd' | 'telemetry' | 'slower' | 'faster';

const ax = (index: number, invert = false): AxisBinding => ({ index, invert, min: -1, max: 1 });

/** Sensible defaults: Mode 2 on a standard gamepad, AETR on an RC radio in joystick mode. */
export function defaultPadConfig(pad: Gamepad): PadConfig {
  if (pad.mapping === 'standard') {
    return {
      axes: { yaw: ax(0), throttle: ax(1, true), roll: ax(2), pitch: ax(3, true) },
      // The left stick springs back to the middle: make the middle zero throttle.
      throttleMode: 'upper',
      deadband: 0.04,
      arm: { type: 'button', index: 0 },
      buttons: { reset: 1, mode: 2, view: 3, turtle: 4 },
    };
  }
  // EdgeTX / OpenTX / most radios: channels 1-4 = A E T R on axes 0-3, switches on the rest.
  return {
    axes: { roll: ax(0), pitch: ax(1), throttle: ax(2), yaw: ax(3) },
    throttleMode: 'full',
    deadband: 0.0,
    arm: pad.axes.length > 4 ? { type: 'axis', index: 4, invert: false } : { type: 'none' },
    buttons: { reset: -1, mode: -1, view: -1, turtle: -1 },
  };
}

export interface KeyboardConfig {
  /** Stick deflection produced by a held key, 0..1. */
  deflection: number;
}

export class Input {
  readonly rc: RcInput = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
  /** Where the sticks currently come from. */
  source: 'keyboard' | 'gamepad' = 'keyboard';
  padName = '';
  keyboard: KeyboardConfig = { deflection: 0.5 };
  /** Per-device configuration, keyed by Gamepad.id. */
  padConfigs: Record<string, PadConfig> = {};
  /** Called when a configuration changes and should be persisted. */
  onConfigChange: () => void = () => {};
  /** When true the keyboard is ignored (typing in the menu). */
  suspended = false;

  private keys = new Set<string>();
  private actions: Action[] = [];
  private prevButtons: boolean[] = [];
  private prevArmSwitch: boolean | null = null;
  private kbThrottle = 0;
  private kb = { roll: 0, pitch: 0, yaw: 0 };
  private activePad = -1;

  constructor(target: Window) {
    target.addEventListener('keydown', (e) => this.onKey(e, true));
    target.addEventListener('keyup', (e) => this.onKey(e, false));
    target.addEventListener('blur', () => this.keys.clear());
    target.addEventListener('gamepadconnected', () => this.pickPad());
    target.addEventListener('gamepaddisconnected', () => this.pickPad());
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.code === 'Escape') {
      if (down && !e.repeat) this.actions.push('menu');
      e.preventDefault();
      return;
    }
    if (this.suspended) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const code = e.code;
    if (down) {
      if (!e.repeat) {
        switch (code) {
          case 'Space': this.actions.push('armToggle'); break;
          case 'KeyR': this.actions.push('reset'); break;
          case 'KeyM': this.actions.push('mode'); break;
          case 'KeyC': case 'KeyV': this.actions.push('view'); break;
          case 'KeyT': this.actions.push('turtle'); break;
          case 'KeyP': this.actions.push('pause'); break;
          case 'KeyH': this.actions.push('osd'); break;
          case 'F3': case 'Tab': this.actions.push('telemetry'); break;
          case 'BracketLeft': case 'Minus': this.actions.push('slower'); break;
          case 'BracketRight': case 'Equal': this.actions.push('faster'); break;
          case 'KeyX': this.kbThrottle = 0; break;
        }
      }
      this.keys.add(code);
    } else {
      this.keys.delete(code);
    }
    if (code.startsWith('Arrow') || code === 'Space' || code === 'Tab' || code === 'F3') e.preventDefault();
  }

  /** Connected gamepads (non-null). */
  pads(): Gamepad[] {
    const list = navigator.getGamepads ? navigator.getGamepads() : [];
    const out: Gamepad[] = [];
    for (const p of list) if (p && p.connected) out.push(p);
    return out;
  }

  private pickPad(): void {
    const pads = this.pads();
    if (pads.length === 0) {
      this.activePad = -1;
      return;
    }
    if (!pads.some((p) => p.index === this.activePad)) {
      // Prefer something that is not a standard gamepad: probably a real radio.
      const radio = pads.find((p) => p.mapping !== 'standard' && p.axes.length >= 4);
      this.activePad = (radio ?? pads[0]).index;
    }
    this.prevButtons = [];
    this.prevArmSwitch = null;
  }

  selectPad(index: number): void {
    this.activePad = index;
    this.prevButtons = [];
    this.prevArmSwitch = null;
  }

  /** The gamepad currently used for flying, if any. */
  pad(): Gamepad | null {
    if (this.activePad < 0) {
      this.pickPad();
      if (this.activePad < 0) return null;
    }
    const list = navigator.getGamepads ? navigator.getGamepads() : [];
    const p = list[this.activePad];
    if (!p || !p.connected) {
      this.activePad = -1;
      return null;
    }
    return p;
  }

  configFor(pad: Gamepad): PadConfig {
    let c = this.padConfigs[pad.id];
    if (!c) {
      c = defaultPadConfig(pad);
      this.padConfigs[pad.id] = c;
    }
    return c;
  }

  resetConfig(pad: Gamepad): void {
    this.padConfigs[pad.id] = defaultPadConfig(pad);
    this.prevArmSwitch = null;
    this.onConfigChange();
  }

  private readAxis(pad: Gamepad, b: AxisBinding): number {
    const raw = pad.axes[b.index] ?? 0;
    const span = b.max - b.min;
    let v = span > 0.05 ? ((raw - b.min) / span) * 2 - 1 : raw;
    v = clamp(v, -1, 1);
    return b.invert ? -v : v;
  }

  private static deadband(v: number, d: number): number {
    if (d <= 0) return v;
    const a = Math.abs(v);
    if (a < d) return 0;
    return (Math.sign(v) * (a - d)) / (1 - d);
  }

  /** Sample all devices. Call once per frame. */
  poll(dt: number): void {
    const pad = this.pad();
    const rc = this.rc;
    if (pad) {
      this.source = 'gamepad';
      this.padName = pad.id;
      const c = this.configFor(pad);
      rc.roll = Input.deadband(this.readAxis(pad, c.axes.roll), c.deadband);
      rc.pitch = Input.deadband(this.readAxis(pad, c.axes.pitch), c.deadband);
      rc.yaw = Input.deadband(this.readAxis(pad, c.axes.yaw), c.deadband);
      const t = this.readAxis(pad, c.axes.throttle);
      rc.throttle = c.throttleMode === 'full' ? (t + 1) / 2 : Math.max(0, t);

      // Buttons (edge-triggered).
      const pressed = pad.buttons.map((b) => b.pressed);
      const edge = (i: number) => i >= 0 && pressed[i] && !this.prevButtons[i];
      if (c.arm.type === 'button' && edge(c.arm.index)) this.actions.push('armToggle');
      if (edge(c.buttons.reset)) this.actions.push('reset');
      if (edge(c.buttons.mode)) this.actions.push('mode');
      if (edge(c.buttons.view)) this.actions.push('view');
      if (edge(c.buttons.turtle)) this.actions.push('turtle');
      this.prevButtons = pressed;

      // Arm switch on an axis (how radios expose their switches).
      if (c.arm.type === 'axis') {
        const raw = pad.axes[c.arm.index] ?? 0;
        const on = (c.arm.invert ? -raw : raw) > 0.3;
        if (this.prevArmSwitch !== null && on !== this.prevArmSwitch) this.actions.push(on ? 'arm' : 'disarm');
        this.prevArmSwitch = on;
      }
    } else {
      this.source = 'keyboard';
      this.padName = '';
      const k = this.keys;
      const d = this.keyboard.deflection;
      const tgtRoll = (k.has('ArrowRight') ? d : 0) - (k.has('ArrowLeft') ? d : 0);
      const tgtPitch = (k.has('ArrowUp') ? d : 0) - (k.has('ArrowDown') ? d : 0);
      const tgtYaw = (k.has('KeyD') ? d : 0) - (k.has('KeyA') ? d : 0);
      // Keys are on/off; ease the virtual sticks so the quad is not kicked.
      const ease = 1 - Math.exp(-dt * 14);
      this.kb.roll += (tgtRoll - this.kb.roll) * ease;
      this.kb.pitch += (tgtPitch - this.kb.pitch) * ease;
      this.kb.yaw += (tgtYaw - this.kb.yaw) * ease;
      const fast = k.has('ShiftLeft') || k.has('ShiftRight') ? 2.2 : 1;
      if (k.has('KeyW')) this.kbThrottle += 0.45 * fast * dt;
      if (k.has('KeyS')) this.kbThrottle -= 0.6 * fast * dt;
      this.kbThrottle = clamp(this.kbThrottle, 0, 1);
      rc.roll = this.kb.roll;
      rc.pitch = this.kb.pitch;
      rc.yaw = this.kb.yaw;
      rc.throttle = this.kbThrottle;
    }
  }

  /** Zero the keyboard throttle (after a reset). */
  resetThrottle(): void {
    this.kbThrottle = 0;
  }

  /** Actions triggered since the last call. */
  takeActions(): Action[] {
    const a = this.actions;
    this.actions = [];
    return a;
  }

  /**
   * Find the axis that moved the most relative to a snapshot (for "move the
   * stick to assign" in the controller setup).
   */
  static mostMovedAxis(pad: Gamepad, baseline: number[]): { index: number; delta: number } {
    let best = -1, bestD = 0;
    for (let i = 0; i < pad.axes.length; i++) {
      const d = pad.axes[i] - (baseline[i] ?? 0);
      if (Math.abs(d) > Math.abs(bestD)) {
        bestD = d;
        best = i;
      }
    }
    return { index: best, delta: bestD };
  }
}
