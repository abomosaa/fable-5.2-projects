/**
 * Settings / pause menu. Plain DOM, no framework.
 */
import { Settings, saveSettings, defaultSettings } from './settings';
import { Simulation, SIM_DT } from '../sim/simulation';
import { DRONE_PRESETS, getPreset, deriveParams, DroneParams } from '../sim/params';
import { Rotor } from '../sim/rotor';
import { Rng, GRAVITY } from '../sim/math';
import { actualRate, AxisRates } from '../sim/fc';
import { Environment } from '../sim/environment';
import { Input, CHANNELS, Channel, PadConfig } from '../input/input';

export type ApplyKind = 'drone' | 'fc' | 'env' | 'graphics' | 'audio' | 'input' | 'sim' | 'spawn';

export interface MenuHost {
  settings: Settings;
  sim: Simulation;
  input: Input;
  spawns: { id: string; name: string }[];
  apply(kind: ApplyKind): void;
  resume(): void;
  reset(): void;
}

type Tab = 'fly' | 'rates' | 'env' | 'controller' | 'display' | 'help';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props as { class?: string };
  Object.assign(e, rest);
  if (cls) e.className = cls;
  for (const c of children) e.append(c);
  return e;
}

/** Static thrust of one motor at a nominal 4.0 V/cell, from the same rotor model the sim flies. */
function staticThrust(p: DroneParams): number {
  const d = deriveParams(p);
  const r = new Rotor(p, d);
  const rng = new Rng(1);
  const v = p.battery.cells * 4.0;
  for (let i = 0; i < 1.2 / SIM_DT; i++) r.update(SIM_DT, 1.225, 1, v, true, 0, 0, 0, 1, rng);
  return r.thrust;
}

export class Menu {
  private readonly root: HTMLElement;
  private readonly host: MenuHost;
  private tab: Tab = 'fly';
  private content!: HTMLElement;
  private tabButtons = new Map<Tab, HTMLButtonElement>();
  private live: (() => void)[] = [];
  private thrustCache = new Map<string, number>();
  isOpen = false;

  constructor(root: HTMLElement, host: MenuHost) {
    this.root = root;
    this.host = host;
    this.build();
  }

  open(tab?: Tab): void {
    if (tab) this.tab = tab;
    this.isOpen = true;
    this.root.classList.add('open');
    this.render();
  }

  close(): void {
    this.isOpen = false;
    this.root.classList.remove('open');
    this.live = [];
  }

  /** Per-frame refresh of live widgets (controller monitor). */
  update(): void {
    if (!this.isOpen) return;
    for (const f of this.live) f();
  }

  private save(kind?: ApplyKind): void {
    if (kind) this.host.apply(kind);
    saveSettings(this.host.settings);
  }

  private build(): void {
    const side = el('div', { class: 'side' });
    side.append(
      el('div', { class: 'brand' }, 'FPV', el('span', {}, 'SIM')),
      el('div', { class: 'tagline' }, 'Physically based FPV quadcopter flight simulator'),
    );
    const tabs: [Tab, string][] = [
      ['fly', 'Fly'], ['rates', 'Rates & throttle'], ['env', 'Weather'], ['controller', 'Controller'], ['display', 'Display & sound'], ['help', 'Help'],
    ];
    for (const [id, label] of tabs) {
      const b = el('button', { class: 'tab', type: 'button' }, label);
      b.addEventListener('click', () => { this.tab = id; this.render(); });
      this.tabButtons.set(id, b);
      side.append(b);
    }
    side.append(el('div', { class: 'spacer' }));
    const fly = el('button', { class: 'btn primary', type: 'button' }, 'Fly');
    fly.addEventListener('click', () => this.host.resume());
    const reset = el('button', { class: 'btn', type: 'button' }, 'Reset drone');
    reset.addEventListener('click', () => { this.host.reset(); this.host.resume(); });
    side.append(reset, fly);
    this.content = el('div', { class: 'content' });
    this.root.append(el('div', { class: 'window' }, side, this.content));
    this.root.addEventListener('mousedown', (e) => { if (e.target === this.root) this.host.resume(); });
  }

  private render(): void {
    for (const [id, b] of this.tabButtons) b.classList.toggle('active', id === this.tab);
    this.live = [];
    const c = this.content;
    c.replaceChildren();
    c.scrollTop = 0;
    switch (this.tab) {
      case 'fly': this.renderFly(c); break;
      case 'rates': this.renderRates(c); break;
      case 'env': this.renderEnv(c); break;
      case 'controller': this.renderController(c); break;
      case 'display': this.renderDisplay(c); break;
      case 'help': this.renderHelp(c); break;
    }
  }

  /* ------------------------------------------------------------------ widgets */

  private slider(label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string, hint?: string): HTMLElement {
    const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(get()) });
    const val = el('div', { class: 'val' }, fmt(get()));
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      set(v);
      val.textContent = fmt(v);
    });
    input.setAttribute('aria-label', label);
    const row = el('div', { class: 'row' }, el('label', {}, label), input, val);
    if (hint) row.append(el('div', { class: 'hint' }, hint));
    return row;
  }

  private select<T extends string>(label: string, options: [T, string][], get: () => T, set: (v: T) => void, hint?: string): HTMLElement {
    const s = el('select');
    for (const [v, text] of options) s.append(el('option', { value: v, selected: v === get() }, text));
    s.addEventListener('change', () => set(s.value as T));
    s.setAttribute('aria-label', label);
    const row = el('div', { class: 'row' }, el('label', {}, label), s, el('div'));
    if (hint) row.append(el('div', { class: 'hint' }, hint));
    return row;
  }

  private check(label: string, get: () => boolean, set: (v: boolean) => void, hint?: string): HTMLElement {
    const i = el('input', { type: 'checkbox', checked: get() });
    i.addEventListener('change', () => set(i.checked));
    i.setAttribute('aria-label', label);
    const row = el('div', { class: 'row' }, el('label', {}, label), el('div', {}, i), el('div'));
    if (hint) row.append(el('div', { class: 'hint' }, hint));
    return row;
  }

  /* --------------------------------------------------------------------- tabs */

  private renderFly(c: HTMLElement): void {
    const s = this.host.settings;
    c.append(el('h2', {}, 'Ready to fly'));
    c.append(el('p', {}, 'The quad sits on the launch pad in front of you. Arm, raise the throttle gently and it will lift off at roughly a fifth of the stick travel. Everything it does afterwards comes out of the physics model - nothing is scripted.'));

    c.append(el('h3', {}, 'Aircraft'));
    const specs = el('div', { class: 'specs' });
    const desc = el('p');
    const fill = () => {
      const p = getPreset(s.drone);
      const d = deriveParams(p);
      let t = this.thrustCache.get(p.id);
      if (t === undefined) { t = staticThrust(p); this.thrustCache.set(p.id, t); }
      desc.textContent = p.description;
      const item = (v: string, k: string) => el('div', { class: 'spec' }, el('b', {}, v), el('span', {}, k));
      specs.replaceChildren(
        item(`${Math.round(d.mass * 1000)} g`, 'all-up weight'),
        item(`${((4 * t) / GRAVITY).toFixed(1)} kg`, 'static thrust'),
        item(`${((4 * t) / (d.mass * GRAVITY)).toFixed(1)} : 1`, 'thrust to weight'),
        item(`${p.battery.cells}S ${Math.round(p.battery.capacityAh * 1000)}`, 'battery (mAh)'),
      );
    };
    c.append(this.select('Airframe', DRONE_PRESETS.map((p) => [p.id, p.name] as [string, string]), () => s.drone, (v) => { s.drone = v; fill(); this.save('drone'); }));
    c.append(desc, specs);
    fill();
    c.append(this.select('Start from', this.host.spawns.map((p) => [p.id, p.name] as [string, string]), () => s.spawn, (v) => { s.spawn = v; this.save('spawn'); },
      'Where the quad is placed on reset. You (the pilot) always stand by the launch pad.'));

    c.append(el('h3', {}, 'Flight mode'));
    c.append(this.select('Mode', [['angle', 'Angle - self-levelling (start here)'], ['horizon', 'Horizon - self-levels, flips allowed'], ['acro', 'Acro - rate mode (real FPV)']], () => s.mode, (v) => { s.mode = v; this.save('fc'); },
      'Acro is what FPV pilots fly: the sticks command rotation rates and the quad holds whatever attitude you leave it in.'));
    c.append(this.select('View', [['fpv', 'FPV camera (goggles)'], ['los', 'Line of sight (pilot’s eyes)'], ['chase', 'Chase camera']], () => s.view, (v) => { s.view = v; this.save('graphics'); }));
    c.append(this.slider('Camera uptilt', 0, 60, 1, () => s.cameraTilt, (v) => { s.cameraTilt = v; this.save('graphics'); }, (v) => `${v}°`,
      'More tilt lets you see ahead while the quad leans forward at speed. 20-30° for cruising, 35-50° for racing.'));

    c.append(el('h3', {}, 'Training aids'));
    c.append(this.slider('Time scale', 0.2, 1, 0.05, () => s.timeScale, (v) => { s.timeScale = v; this.save('sim'); }, (v) => `${Math.round(v * 100)} %`,
      'Slow motion: the physics is unchanged, it just runs slower so you can see what your inputs do.'));
    c.append(this.check('Crash damage', () => s.damage, (v) => { s.damage = v; this.save('sim'); },
      'Hard impacts break the quad (reset needed) and prop strikes chip blades. Turn off to bounce off things while learning.'));
    c.append(this.check('Highlight next gate', () => s.osd.gateMarker, (v) => { s.osd.gateMarker = v; this.save('graphics'); }));

    const act = el('div', { class: 'actions' });
    const go = el('button', { class: 'btn primary', type: 'button' }, 'Fly');
    go.addEventListener('click', () => this.host.resume());
    act.append(go);
    c.append(act);
  }

  private renderRates(c: HTMLElement): void {
    const s = this.host.settings;
    c.append(el('h2', {}, 'Rates & throttle'));
    c.append(el('p', {}, 'Betaflight “Actual” rates. Centre sensitivity is how fast the quad rotates per unit of stick near the middle; max rate is the rotation speed at full deflection; expo keeps the centre soft while leaving the ends fast. Copy the numbers from your real quad and it will respond the same way here.'));

    const plot = el('canvas', { class: 'plot', width: 900, height: 300 });
    const draw = () => {
      const g = plot.getContext('2d')!;
      const W = plot.width, H = plot.height;
      g.clearRect(0, 0, W, H);
      const maxRate = Math.max(s.rates.roll.max, s.rates.pitch.max, s.rates.yaw.max, 200);
      g.strokeStyle = 'rgba(255,255,255,0.08)';
      g.lineWidth = 1;
      g.font = '18px system-ui, sans-serif';
      g.fillStyle = 'rgba(255,255,255,0.45)';
      for (let i = 0; i <= 4; i++) {
        const y = H - 24 - ((H - 44) * i) / 4;
        g.beginPath(); g.moveTo(50, y); g.lineTo(W - 10, y); g.stroke();
        g.fillText(String(Math.round((maxRate * i) / 4)), 4, y + 6);
      }
      g.fillText('stick deflection →   (deg/s)', W - 250, H - 4);
      const curve = (r: AxisRates, color: string) => {
        g.strokeStyle = color;
        g.lineWidth = 3;
        g.beginPath();
        for (let i = 0; i <= 100; i++) {
          const x = i / 100;
          const y = actualRate(x, r);
          const px = 50 + x * (W - 60), py = H - 24 - (y / maxRate) * (H - 44);
          if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
        }
        g.stroke();
      };
      curve(s.rates.yaw, '#8a96a3');
      curve(s.rates.pitch, '#7fdcff');
      curve(s.rates.roll, '#ff6a2b');
      g.fillStyle = '#ff6a2b'; g.fillText('roll', 60, 22);
      g.fillStyle = '#7fdcff'; g.fillText('pitch', 110, 22);
      g.fillStyle = '#8a96a3'; g.fillText('yaw', 170, 22);
    };
    c.append(plot);
    for (const axis of ['roll', 'pitch', 'yaw'] as const) {
      const r = s.rates[axis];
      c.append(el('h3', {}, axis));
      c.append(this.slider('Centre sensitivity', 10, 500, 5, () => r.center, (v) => { r.center = v; if (r.max < v) r.max = v; draw(); this.save('fc'); }, (v) => `${v} °/s`));
      c.append(this.slider('Max rate', 100, 1400, 10, () => r.max, (v) => { r.max = Math.max(v, r.center); draw(); this.save('fc'); }, (v) => `${v} °/s`));
      c.append(this.slider('Expo', 0, 1, 0.01, () => r.expo, (v) => { r.expo = v; draw(); this.save('fc'); }, (v) => v.toFixed(2)));
    }
    c.append(el('h3', {}, 'Throttle'));
    c.append(this.slider('Throttle limit', 0.4, 1, 0.01, () => s.throttleLimit, (v) => { s.throttleLimit = v; this.save('fc'); }, (v) => `${Math.round(v * 100)} %`,
      'Scales the whole throttle range, like Betaflight’s throttle limit. 60-70 % tames a powerful quad while you learn.'));
    c.append(this.slider('Throttle mid', 0.1, 0.9, 0.01, () => s.throttleMid, (v) => { s.throttleMid = v; this.save('fc'); }, (v) => v.toFixed(2)));
    c.append(this.slider('Throttle expo', 0, 1, 0.01, () => s.throttleExpo, (v) => { s.throttleExpo = v; this.save('fc'); }, (v) => v.toFixed(2),
      'Flattens the curve around the mid point for finer hover control.'));
    c.append(this.check('Air mode', () => s.airmode, (v) => { s.airmode = v; this.save('fc'); },
      'Keeps full attitude authority at zero throttle (needed for flips and dives). Off: motors just idle at zero throttle.'));
    const act = el('div', { class: 'actions' });
    const def = el('button', { class: 'btn small', type: 'button' }, 'Restore default rates');
    def.addEventListener('click', () => {
      const d = defaultSettings();
      s.rates = d.rates; s.throttleExpo = d.throttleExpo; s.throttleMid = d.throttleMid; s.throttleLimit = d.throttleLimit;
      this.save('fc');
      this.render();
    });
    act.append(def);
    c.append(act);
    draw();
  }

  private renderEnv(c: HTMLElement): void {
    const s = this.host.settings;
    c.append(el('h2', {}, 'Weather'));
    c.append(el('p', {}, 'Wind follows a logarithmic boundary-layer profile (calmer near the ground, stronger aloft) with Dryden turbulence on top. Air density comes from the temperature and field elevation and changes thrust, drag and hover throttle exactly as it does outdoors.'));
    const rho = el('div', { class: 'card' });
    const upd = () => {
      const e = new Environment(s.env);
      rho.replaceChildren(
        el('span', { class: 'k' }, 'Air density '), `${e.rho.toFixed(3)} kg/m³ (${Math.round((e.rho / 1.225) * 100)} % of sea-level standard)`,
        el('br'), el('span', { class: 'k' }, 'Wind at 2 m / 10 m / 50 m '), `${e.meanSpeedAt(2).toFixed(1)} / ${e.meanSpeedAt(10).toFixed(1)} / ${e.meanSpeedAt(50).toFixed(1)} m/s`,
      );
    };
    const set = () => { upd(); this.save('env'); };
    c.append(this.slider('Wind speed (at 10 m)', 0, 15, 0.5, () => s.env.windSpeed, (v) => { s.env.windSpeed = v; set(); }, (v) => `${v.toFixed(1)} m/s`, 'For reference: 5 m/s = 18 km/h is a breezy day; above 10 m/s is hard work for a 5″ quad.'));
    c.append(this.slider('Wind from', 0, 355, 5, () => s.env.windFrom, (v) => { s.env.windFrom = v; set(); }, (v) => `${v}° ${['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(v / 45) % 8]}`, 'You face north on the launch pad. The windsock beside it shows the result.'));
    c.append(this.slider('Turbulence', 0, 2, 0.1, () => s.env.turbulence, (v) => { s.env.turbulence = v; set(); }, (v) => v === 0 ? 'off' : `${v.toFixed(1)} ×`, 'Gust intensity relative to the standard value for the chosen mean wind.'));
    c.append(this.slider('Temperature', -10, 40, 1, () => s.env.temperatureC, (v) => { s.env.temperatureC = v; set(); }, (v) => `${v} °C`));
    c.append(this.slider('Field elevation', 0, 3000, 50, () => s.env.elevation, (v) => { s.env.elevation = v; set(); }, (v) => `${v} m`));
    c.append(rho);
    upd();
  }

  private renderController(c: HTMLElement): void {
    const host = this.host, input = host.input, s = host.settings;
    c.append(el('h2', {}, 'Controller'));
    const pads = input.pads();
    if (pads.length === 0) {
      c.append(el('p', {}, 'No controller detected. Plug in your radio (EdgeTX / OpenTX radios: choose “USB Joystick (HID)” when you connect the cable) or a gamepad, then move a stick or press a button so the browser can see it.'));
      c.append(el('div', { class: 'note' }, 'A real transmitter is by far the best way to practise: the muscle memory transfers directly to your quad. A gamepad works; the keyboard is only good enough for a first look.'));
      this.live.push(() => { if (input.pads().length > 0) this.render(); });
    } else {
      const pad = input.pad() ?? pads[0];
      const cfg = input.configFor(pad);
      const commit = () => { s.pads = input.padConfigs; saveSettings(s); };
      c.append(this.select('Device', pads.map((p) => [String(p.index), p.id.slice(0, 60)] as [string, string]), () => String(pad.index), (v) => { input.selectPad(parseInt(v, 10)); this.render(); }));

      const status = el('div', { class: 'note' }, 'Move each stick and check the bars. If a channel is wrong, press Detect and move that stick in the direction shown.');
      c.append(status);

      const table = el('table', { class: 'map' });
      table.append(el('tr', {}, el('th', {}, 'Channel'), el('th', {}, 'Axis'), el('th', {}, 'Invert'), el('th', {}, 'Output'), el('th', {}, '')));
      const dirText: Record<Channel, string> = { throttle: 'UP', yaw: 'RIGHT', pitch: 'FORWARD (up)', roll: 'RIGHT' };
      let detecting: { ch: Channel | 'arm'; base: number[]; baseButtons: boolean[]; btn: HTMLButtonElement } | null = null;
      for (const ch of CHANNELS) {
        const b = cfg.axes[ch];
        const sel = el('select');
        for (let i = 0; i < pad.axes.length; i++) sel.append(el('option', { value: String(i), selected: i === b.index }, `Axis ${i}`));
        sel.addEventListener('change', () => { b.index = parseInt(sel.value, 10); b.min = -1; b.max = 1; commit(); });
        const inv = el('input', { type: 'checkbox', checked: b.invert });
        inv.addEventListener('change', () => { b.invert = inv.checked; commit(); });
        inv.setAttribute('aria-label', `Invert ${ch}`);
        const ind = el('i');
        const bar = el('div', { class: 'bar' }, ind);
        const det = el('button', { class: 'btn small', type: 'button' }, 'Detect');
        det.addEventListener('click', () => {
          const p = input.pad();
          if (!p) return;
          if (detecting) detecting.btn.classList.remove('busy');
          detecting = { ch, base: [...p.axes], baseButtons: [], btn: det };
          det.classList.add('busy');
          status.textContent = `Move the ${ch.toUpperCase()} stick ${dirText[ch]} and hold it there...`;
        });
        table.append(el('tr', {}, el('td', {}, ch[0].toUpperCase() + ch.slice(1)), el('td', {}, sel), el('td', {}, inv), el('td', {}, bar), el('td', {}, det)));
        this.live.push(() => {
          const v = ch === 'throttle' ? input.rc.throttle * 2 - 1 : input.rc[ch];
          ind.style.left = `${50 + v * 50}%`;
          if (sel.value !== String(b.index)) sel.value = String(b.index);
          if (inv.checked !== b.invert) inv.checked = b.invert;
        });
      }
      c.append(table);

      // Detection / calibration state machine, polled every frame.
      let calib: { until: number; min: number[]; max: number[] } | null = null;
      this.live.push(() => {
        const p = input.pad();
        if (!p) return;
        if (detecting) {
          if (detecting.ch === 'arm') {
            const bi = p.buttons.findIndex((bt, i) => bt.pressed && !detecting!.baseButtons[i]);
            const m = Input.mostMovedAxis(p, detecting.base);
            if (bi >= 0) {
              cfg.arm = { type: 'button', index: bi };
            } else if (Math.abs(m.delta) > 0.6) {
              cfg.arm = { type: 'axis', index: m.index, invert: m.delta < 0 };
            } else {
              return;
            }
            status.textContent = cfg.arm.type === 'button' ? `Arm: button ${cfg.arm.index} (press to toggle).` : `Arm: switch on axis ${cfg.arm.index}.`;
          } else {
            const m = Input.mostMovedAxis(p, detecting.base);
            if (Math.abs(m.delta) < 0.45) return;
            const b = cfg.axes[detecting.ch];
            b.index = m.index;
            b.invert = m.delta < 0;
            b.min = -1; b.max = 1;
            status.textContent = `${detecting.ch.toUpperCase()} assigned to axis ${m.index}${b.invert ? ' (inverted)' : ''}.`;
          }
          detecting.btn.classList.remove('busy');
          detecting = null;
          commit();
          if (cfg.arm) armInfo.textContent = armText();
        }
        if (calib) {
          for (let i = 0; i < p.axes.length; i++) {
            calib.min[i] = Math.min(calib.min[i], p.axes[i]);
            calib.max[i] = Math.max(calib.max[i], p.axes[i]);
          }
          const left = (calib.until - performance.now()) / 1000;
          if (left > 0) {
            status.textContent = `Calibrating: move both sticks through their full range, into every corner... ${left.toFixed(0)} s`;
          } else {
            for (const ch of CHANNELS) {
              const b = cfg.axes[ch];
              const lo = calib.min[b.index], hi = calib.max[b.index];
              if (hi - lo > 0.4) { b.min = lo; b.max = hi; }
            }
            calib = null;
            calBtn.classList.remove('busy');
            status.textContent = 'Calibration stored.';
            commit();
          }
        }
      });

      c.append(el('h3', {}, 'Arming'));
      const armText = () => cfg.arm.type === 'none' ? 'Not assigned - use the Space bar.' : cfg.arm.type === 'button' ? `Button ${cfg.arm.index} toggles arm / disarm.` : `Switch on axis ${cfg.arm.index}${cfg.arm.invert ? ' (inverted)' : ''}: up = armed.`;
      const armInfo = el('span', {}, armText());
      const armDet = el('button', { class: 'btn small', type: 'button' }, 'Detect arm switch');
      armDet.addEventListener('click', () => {
        const p = input.pad();
        if (!p) return;
        if (detecting) detecting.btn.classList.remove('busy');
        detecting = { ch: 'arm', base: [...p.axes], baseButtons: p.buttons.map((b) => b.pressed), btn: armDet };
        armDet.classList.add('busy');
        status.textContent = 'Flip the switch (or press the button) you want to arm with...';
      });
      c.append(el('div', { class: 'card' }, armInfo, el('div', { class: 'actions' }, armDet)));

      c.append(el('h3', {}, 'Options'));
      c.append(this.select('Throttle stick', [['full', 'Full travel: bottom = 0 %, top = 100 %'], ['upper', 'Self-centring stick: centre = 0 %, top = 100 %']], () => cfg.throttleMode, (v) => { cfg.throttleMode = v; commit(); },
        'Radios have a throttle stick that stays where you put it - use full travel. On a gamepad the stick springs back to the middle; pick whichever you prefer.'));
      c.append(this.slider('Stick deadband', 0, 0.2, 0.01, () => cfg.deadband, (v) => { cfg.deadband = v; commit(); }, (v) => `${Math.round(v * 100)} %`, 'Leave at 0 for a radio with good gimbals; 3-6 % hides the slop of gamepad sticks.'));
      const act = el('div', { class: 'actions' });
      const calBtn = el('button', { class: 'btn small', type: 'button' }, 'Calibrate stick range');
      calBtn.addEventListener('click', () => {
        const p = input.pad();
        if (!p) return;
        calib = { until: performance.now() + 6000, min: [...p.axes], max: [...p.axes] };
        calBtn.classList.add('busy');
      });
      const defBtn = el('button', { class: 'btn small', type: 'button' }, 'Reset this device to defaults');
      defBtn.addEventListener('click', () => { input.resetConfig(pad); commit(); this.render(); });
      act.append(calBtn, defBtn);
      c.append(act);

      c.append(el('h3', {}, 'Raw input'));
      const raw = el('div', { class: 'rawaxes' });
      c.append(raw);
      this.live.push(() => {
        const p = input.pad();
        if (!p) return;
        const parts: string[] = [];
        for (let i = 0; i < p.axes.length; i++) parts.push(`axis ${i}: ${p.axes[i].toFixed(2)}`);
        const pressed = p.buttons.map((b, i) => (b.pressed ? i : -1)).filter((i) => i >= 0);
        parts.push(`buttons: ${pressed.length ? pressed.join(', ') : '-'}`);
        if (raw.childElementCount !== parts.length) raw.replaceChildren(...parts.map((t) => el('div', {}, t)));
        else parts.forEach((t, i) => { (raw.children[i] as HTMLElement).textContent = t; });
      });
    }

    c.append(el('h3', {}, 'Keyboard'));
    c.append(this.slider('Key deflection', 0.2, 1, 0.05, () => s.keyboardDeflection, (v) => { s.keyboardDeflection = v; this.save('input'); }, (v) => `${Math.round(v * 100)} %`,
      'How far a held key pushes the virtual stick. Keys are all-or-nothing, so keep this modest and use Angle mode.'));
  }

  private renderDisplay(c: HTMLElement): void {
    const s = this.host.settings;
    c.append(el('h2', {}, 'Display & sound'));
    c.append(el('h3', {}, 'FPV camera'));
    c.append(this.slider('Field of view', 80, 150, 1, () => s.fov, (v) => { s.fov = v; this.save('graphics'); }, (v) => `${v}°`, 'Horizontal, on a 16:9 frame. FPV cameras are very wide: 110-130° is typical in the goggles.'));
    c.append(this.slider('Lens distortion', 0, 1, 0.05, () => s.lens, (v) => { s.lens = v; this.save('graphics'); }, (v) => v === 0 ? 'none' : v.toFixed(2), '0 = perfect rectilinear projection, 1 = full fisheye. Real FPV lenses sit in between.'));
    c.append(el('h3', {}, 'On-screen display'));
    c.append(this.check('Show OSD', () => s.osd.visible, (v) => { s.osd.visible = v; this.save('graphics'); }));
    c.append(this.check('Stick monitor', () => s.osd.sticks, (v) => { s.osd.sticks = v; this.save('graphics'); }));
    c.append(this.check('Artificial horizon', () => s.osd.horizon, (v) => { s.osd.horizon = v; this.save('graphics'); }));
    c.append(this.check('Physics telemetry panel', () => s.osd.telemetry, (v) => { s.osd.telemetry = v; this.save('graphics'); }, 'Live rotor speeds, thrust, induced velocity, vortex-ring state, wind and battery internals.'));
    c.append(el('h3', {}, 'Rendering'));
    c.append(this.select('Quality', [['high', 'High'], ['medium', 'Medium'], ['low', 'Low (integrated graphics)']], () => s.quality, (v) => { s.quality = v; this.save('graphics'); }));
    c.append(el('h3', {}, 'Sound'));
    c.append(this.slider('Volume', 0, 1, 0.05, () => s.volume, (v) => { s.volume = v; this.save('audio'); }, (v) => `${Math.round(v * 100)} %`));
  }

  private renderHelp(c: HTMLElement): void {
    c.append(el('h2', {}, 'Help'));
    c.append(el('h3', {}, 'Keyboard'));
    const keys = el('div', { class: 'keys' });
    const k = (keysHtml: string[], text: string) => {
      const d = el('div');
      keysHtml.forEach((x, i) => { if (i) d.append(' '); d.append(el('kbd', {}, x)); });
      keys.append(d, el('span', {}, text));
    };
    k(['Space'], 'Arm / disarm');
    k(['W', 'S'], 'Throttle up / down (stays where you leave it; Shift = faster)');
    k(['X'], 'Throttle to zero');
    k(['A', 'D'], 'Yaw left / right');
    k(['↑', '↓'], 'Pitch forward / back');
    k(['←', '→'], 'Roll left / right');
    k(['R'], 'Reset the drone to the start location');
    k(['M'], 'Flight mode: Angle → Horizon → Acro');
    k(['C'], 'Camera: FPV → line of sight → chase');
    k(['T'], 'Turtle mode (flip over after a crash)');
    k(['[', ']'], 'Slow motion / faster');
    k(['H'], 'Toggle OSD');
    k(['Tab'], 'Physics telemetry');
    k(['P', 'Esc'], 'Pause / menu');
    c.append(keys);

    c.append(el('h3', {}, 'A sensible way to learn'));
    const ol = el('ol');
    const li = (html: string) => { const x = el('li'); x.innerHTML = html; ol.append(x); };
    li('<b>Hover in Angle mode.</b> Line-of-sight view, quad pointing away from you. Hold it over the pad at head height using only small throttle changes.');
    li('<b>Fly circuits in Angle mode</b> through the FPV camera. Use yaw and roll together to turn; watch how it balloons when you level out at speed.');
    li('<b>Switch to Acro</b> and go back to hovering. There is no self-levelling: every tilt you put in has to be taken out again. This is the real skill.');
    li('<b>Fly the gates.</b> The blue gate starts the lap timer; the next gate is highlighted.');
    li('<b>Add wind</b>, a heavier quad, a steeper camera angle. Then try the bando, the container tunnel and the barn.');
    c.append(ol);

    c.append(el('h3', {}, 'What is being simulated'));
    const ul = el('ul');
    const item = (html: string) => { const x = el('li'); x.innerHTML = html; ul.append(x); };
    item('<b>Rigid-body dynamics</b> at 4 kHz: full 3-axis inertia from the mass of every component, gyroscopic coupling of the four rotors.');
    item('<b>Propellers</b> by blade-element / momentum theory: thrust and torque depend on rpm, airspeed through and across the disc, air density. Translational lift, loss of thrust at speed, prop-wash (vortex ring state) when descending into your own wake, ground effect.');
    item('<b>Motors and ESCs</b>: back-EMF, winding resistance, commutation losses, current limit, active braking, rotor inertia. Yaw comes from real torque reaction.');
    item('<b>Battery</b>: LiPo discharge curve, internal resistance and voltage sag; punch-outs get weaker as the pack empties.');
    item('<b>Air</b>: anisotropic airframe drag, wind shear, turbulence, density from temperature and altitude.');
    item('<b>Flight controller</b>: Betaflight-style rates, PID loop with feed-forward, filters, mixer with air mode, and the same gain scaling.');
    item('<b>Contact</b>: spring-damper collisions with friction; prop strikes brake and damage that rotor.');
    c.append(ul);
    c.append(el('p', {}, 'See the README for the equations, the reference data the model is calibrated against, and its known limitations.'));
  }
}

export type { PadConfig };
