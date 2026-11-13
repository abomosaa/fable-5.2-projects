// Pilot input: keyboard (with smoothed virtual stick), mouse yoke (pointer lock), mouse look,
// and gamepads / joysticks through the Gamepad API.

import { clamp, approach } from './core/math.js';

const AXIS_KEYS = {
  pitchUp: ['KeyS', 'ArrowDown'], pitchDown: ['KeyW', 'ArrowUp'],
  rollLeft: ['KeyA', 'ArrowLeft'], rollRight: ['KeyD', 'ArrowRight'],
  yawLeft: ['KeyQ'], yawRight: ['KeyE'],
  throttleUp: ['KeyR', 'PageUp', 'Equal', 'NumpadAdd'], throttleDown: ['KeyF', 'PageDown', 'Minus', 'NumpadSubtract'],
  brake: ['Space'],
  trimUp: ['Period'], trimDown: ['Comma'],
};

// one-shot actions on key press: [code, shift?] -> action
const ACTIONS = [
  ['KeyG', false, 'gear'], ['KeyV', false, 'flapsDown'], ['KeyV', true, 'flapsUp'],
  ['BracketRight', false, 'flapsDown'], ['BracketLeft', false, 'flapsUp'],
  ['KeyB', false, 'parkingBrake'], ['KeyX', false, 'spoiler'], ['KeyT', false, 'reverse'],
  ['KeyI', false, 'engine'], ['KeyZ', false, 'autopilot'], ['KeyU', false, 'autothrottle'],
  ['KeyC', false, 'cycleCamera'], ['Digit1', false, 'cam:chase'], ['Digit2', false, 'cam:cockpit'],
  ['Digit3', false, 'cam:orbit'], ['Digit4', false, 'cam:flyby'], ['Digit5', false, 'cam:tower'],
  ['KeyP', false, 'pause'], ['Escape', false, 'menu'], ['KeyH', false, 'hud'], ['KeyM', false, 'map'],
  ['KeyN', false, 'nav'], ['KeyL', false, 'lights'], ['KeyO', false, 'smoke'], ['KeyY', false, 'mouseYoke'],
  ['Slash', false, 'help'], ['F1', false, 'help'], ['Enter', false, 'confirm'], ['Backspace', false, 'recenter'],
  ['Digit0', false, 'throttleIdle'], ['Digit9', false, 'throttleFull'], ['KeyJ', false, 'panel'],
];

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.handlers = {};
    this.enabled = false;            // flight controls active
    this.pitch = 0; this.roll = 0; this.yaw = 0;
    this.kPitch = 0; this.kRoll = 0; this.kYaw = 0;
    this.mouseYoke = false; this.mx = 0; this.my = 0;
    this.look = { dx: 0, dy: 0, wheel: 0, dragging: false };
    this.gamepadActive = false;
    this._padPrev = [];
    this.sensitivity = 1;

    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('mousedown', (e) => {
      if (this.mouseYoke && document.pointerLockElement === canvas) { if (e.button !== 0) { this.mx = 0; this.my = 0; } return; }
      this.look.dragging = true;
    });
    window.addEventListener('mouseup', () => { this.look.dragging = false; });
    window.addEventListener('mousemove', (e) => {
      if (this.mouseYoke && document.pointerLockElement === canvas) {
        this.mx = clamp(this.mx + e.movementX * 0.0022 * this.sensitivity, -1, 1);
        this.my = clamp(this.my + e.movementY * 0.0022 * this.sensitivity, -1, 1);
      } else if (this.look.dragging) { this.look.dx += e.movementX; this.look.dy += e.movementY; }
    });
    canvas.addEventListener('wheel', (e) => { this.look.wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement !== canvas && this.mouseYoke) { this.mouseYoke = false; this.emit('mouseYokeChanged', false); }
    });
  }

  on(action, fn) { (this.handlers[action] ||= []).push(fn); return this; }
  emit(action, arg) { const h = this.handlers[action]; if (h) for (const f of h) f(arg); }

  onKey(e, down) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;
    const code = e.code;
    if (down) {
      if (!e.repeat) {
        for (const [c, shift, action] of ACTIONS) {
          if (c !== code) continue;
          if (c === 'KeyV' && !!e.shiftKey !== shift) continue;
          if (action.startsWith('cam:')) this.emit('camera', action.slice(4)); else this.emit(action);
          break;
        }
      }
      this.keys.add(code);
    } else this.keys.delete(code);
    // keep the browser from scrolling / triggering quick-find while flying
    if (this.enabled && !e.ctrlKey && !e.metaKey && !e.altKey &&
        (code.startsWith('Arrow') || code === 'Space' || code === 'Slash' || code === 'PageUp' || code === 'PageDown' || code === 'Backspace' || code === 'F1' || code === 'Quote')) {
      e.preventDefault();
    }
  }

  held(name) {
    for (const k of AXIS_KEYS[name]) if (this.keys.has(k)) return true;
    return false;
  }
  heldArrow(name) {
    const map = { pitchUp: 'ArrowDown', pitchDown: 'ArrowUp', rollLeft: 'ArrowLeft', rollRight: 'ArrowRight' };
    return this.keys.has(map[name]);
  }

  setMouseYoke(on) {
    this.mouseYoke = on;
    this.mx = 0; this.my = 0;
    if (on) this.canvas.requestPointerLock?.();
    else if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.emit('mouseYokeChanged', on);
  }

  pollGamepad(dt, ac) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = null;
    for (const p of pads) if (p && p.connected && p.axes.length >= 2) { gp = p; break; }
    if (!gp) { this.gamepadActive = false; return null; }
    const dz = (v, d = 0.09) => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d));
    const expo = (v) => Math.sign(v) * Math.pow(Math.abs(v), 1.5);
    const out = { roll: expo(dz(gp.axes[0])), pitch: expo(dz(gp.axes[1])), yaw: 0, throttleRate: 0, brake: 0 };
    const std = gp.mapping === 'standard';
    if (gp.axes.length >= 4) { out.yaw = expo(dz(gp.axes[2])); if (std) out.throttleRate = -dz(gp.axes[3], 0.2) * 0.6; }
    const b = (i) => (gp.buttons[i] ? gp.buttons[i].value : 0);
    if (std) {
      out.throttleRate += (b(7) - b(6)) * 0.7;
      out.yaw += b(5) - b(4);
      out.brake = b(0);
      const press = (i, action, arg) => { const v = b(i) > 0.5; if (v && !this._padPrev[i]) this.emit(action, arg); this._padPrev[i] = v; };
      press(1, 'gear'); press(2, 'flapsDown'); press(3, 'flapsUp'); press(9, 'pause'); press(8, 'cycleCamera');
      press(14, 'spoiler'); press(15, 'reverse'); press(10, 'autopilot');
      if (b(12) > 0.5) ac.ctrl.trim = clamp(ac.ctrl.trim - 0.25 * dt, -1, 1);
      if (b(13) > 0.5) ac.ctrl.trim = clamp(ac.ctrl.trim + 0.25 * dt, -1, 1);
    } else if (gp.axes.length >= 3 && gp.axes.length < 4) {
      // simple joystick: third axis is usually twist or throttle
      out.yaw = expo(dz(gp.axes[2]));
    }
    this.gamepadActive = Math.abs(out.roll) + Math.abs(out.pitch) + Math.abs(out.yaw) > 0.02 || this.gamepadActive;
    return out;
  }

  /** Read devices and write the control positions into the aircraft. */
  update(dt, ac) {
    if (!this.enabled || !ac) return;
    const c = ac.ctrl;
    const ap = ac.ap.engaged;
    // --- keyboard virtual stick
    let tp = 0, tr = 0;
    if (ap) {
      // with the autopilot engaged the arrow keys move its targets; W/A/S/D take over manually
      const wasd = (this.keys.has('KeyW') ? -1 : 0) + (this.keys.has('KeyS') ? 1 : 0);
      const ad = (this.keys.has('KeyD') ? 1 : 0) + (this.keys.has('KeyA') ? -1 : 0);
      if (wasd !== 0 || ad !== 0) { ac.ap.disengage(); this.emit('apDisengaged'); }
      else {
        if (this.heldArrow('rollLeft')) ac.ap.heading -= 0.35 * dt;
        if (this.heldArrow('rollRight')) ac.ap.heading += 0.35 * dt;
        if (this.heldArrow('pitchDown')) ac.ap.altitude += 60 * dt * Math.max(1, ac.ap.vsLimit / 5);
        if (this.heldArrow('pitchUp')) ac.ap.altitude = Math.max(60, ac.ap.altitude - 60 * dt * Math.max(1, ac.ap.vsLimit / 5));
      }
    } else {
      tp = (this.held('pitchUp') ? 1 : 0) - (this.held('pitchDown') ? 1 : 0);
      tr = (this.held('rollRight') ? 1 : 0) - (this.held('rollLeft') ? 1 : 0);
    }
    const ty = (this.held('yawRight') ? 1 : 0) - (this.held('yawLeft') ? 1 : 0);
    const move = (cur, target, rateOut, rateBack) => approach(cur, target, (target === 0 || Math.sign(target) !== Math.sign(cur) ? rateBack : rateOut) * dt);
    this.kPitch = move(this.kPitch, tp, 1.5, 3.5);
    this.kRoll = move(this.kRoll, tr, 2.6, 5.0);
    this.kYaw = move(this.kYaw, ty, 2.6, 4.5);
    let pitch = this.kPitch, roll = this.kRoll, yaw = this.kYaw, brake = this.held('brake') ? 1 : 0;

    // --- mouse yoke
    if (this.mouseYoke) {
      pitch = clamp(pitch + this.my, -1, 1);
      roll = clamp(roll + this.mx, -1, 1);
    }
    // --- gamepad
    const gp = this.pollGamepad(dt, ac);
    let thrRate = (this.held('throttleUp') ? 1 : 0) - (this.held('throttleDown') ? 1 : 0);
    if (gp) {
      if (Math.abs(gp.pitch) > Math.abs(pitch)) pitch = gp.pitch;
      if (Math.abs(gp.roll) > Math.abs(roll)) roll = gp.roll;
      if (Math.abs(gp.yaw) > Math.abs(yaw)) yaw = clamp(gp.yaw, -1, 1);
      thrRate += gp.throttleRate;
      brake = Math.max(brake, gp.brake);
      if (ap && (Math.abs(gp.pitch) > 0.4 || Math.abs(gp.roll) > 0.4)) { ac.ap.disengage(); this.emit('apDisengaged'); }
    }
    this.pitch = pitch; this.roll = roll; this.yaw = yaw;
    c.pitch = pitch; c.roll = roll; c.yaw = yaw; c.brake = brake;
    if (thrRate !== 0) {
      if (ac.ap.autothrottle) ac.ap.speed = Math.max(ac.def.ref.vs0 * 1.1, ac.ap.speed + thrRate * 8 * dt);
      else c.throttle = clamp(c.throttle + thrRate * 0.45 * dt, 0, 1);
    }
    const trimRate = (this.held('trimUp') ? 1 : 0) - (this.held('trimDown') ? 1 : 0);
    if (trimRate !== 0) c.trim = clamp(c.trim + trimRate * 0.18 * dt, -1, 1);
  }

  /** Consume accumulated mouse-look deltas. */
  takeLook() {
    const l = this.look, r = { dx: l.dx, dy: l.dy, wheel: l.wheel };
    l.dx = 0; l.dy = 0; l.wheel = 0;
    return r;
  }
}
