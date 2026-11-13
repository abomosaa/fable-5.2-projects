/**
 * On-screen display, laid out like a Betaflight OSD in the goggles: battery,
 * current, mAh, timer, throttle, speed, altitude, home arrow, mode, warnings.
 */
import { Simulation } from '../sim/simulation';
import { RAD2DEG } from '../sim/math';
import { Settings } from './settings';
import type { CameraMode } from '../render/view';

const FONT = "ui-monospace, 'DejaVu Sans Mono', 'Liberation Mono', Menlo, Consolas, monospace";

export class Osd {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private unit = 16;
  /** Transient centre message. */
  private flash = '';
  private flashUntil = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  resize(cssW: number, cssH: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    if (w !== this.w || h !== this.h) {
      this.w = this.canvas.width = w;
      this.h = this.canvas.height = h;
    }
    this.unit = Math.max(11, Math.min(h / 30, w / 46));
  }

  message(text: string, seconds = 2): void {
    this.flash = text;
    this.flashUntil = performance.now() + seconds * 1000;
  }

  private text(s: string, x: number, y: number, align: CanvasTextAlign = 'left', scale = 1, color = '#ffffff'): void {
    const c = this.ctx;
    c.font = `700 ${Math.round(this.unit * scale)}px ${FONT}`;
    c.textAlign = align;
    c.textBaseline = 'middle';
    c.lineJoin = 'round';
    c.lineWidth = Math.max(2, this.unit * scale * 0.2);
    c.strokeStyle = 'rgba(0,0,0,0.85)';
    c.strokeText(s, x, y);
    c.fillStyle = color;
    c.fillText(s, x, y);
  }

  draw(sim: Simulation, s: Settings, view: CameraMode, source: string, fps: number): void {
    const c = this.ctx, w = this.w, h = this.h, u = this.unit;
    c.clearRect(0, 0, w, h);
    if (!s.osd.visible) return;
    const dr = sim.drone, fc = sim.fc;
    const now = performance.now();
    const blink = Math.floor(now / 400) % 2 === 0;
    const mx = w * 0.035, my = h * 0.05;
    const cells = dr.p.battery.cells;
    const vCell = dr.vbus / cells;

    // ---- top left: battery ---------------------------------------------------------
    const low = vCell < 3.5, crit = vCell < 3.3;
    const batColor = crit ? '#ff5544' : low ? '#ffcc33' : '#ffffff';
    this.text(`${dr.vbus.toFixed(1)}V`, mx, my, 'left', 1.25, batColor);
    this.text(`${vCell.toFixed(2)}V ${cells}S`, mx, my + u * 1.5, 'left', 0.9, batColor);
    this.text(`${dr.packCurrent.toFixed(1).padStart(5)}A`, mx, my + u * 2.8, 'left', 0.9);
    this.text(`${Math.round(dr.battery.usedAh * 1000).toString().padStart(4)}mAh`, mx, my + u * 4.0, 'left', 0.9);

    // ---- top right: timer, link ------------------------------------------------------
    const t = sim.armedTime;
    const mm = Math.floor(t / 60), ss = Math.floor(t % 60);
    this.text(`${mm.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`, w - mx, my, 'right', 1.25);
    this.text(fc.turtle ? 'TURTLE' : fc.cfg.mode === 'acro' ? 'ACRO' : fc.cfg.mode === 'angle' ? 'ANGL' : 'HOR', w - mx, my + u * 1.5, 'right', 0.9, fc.cfg.mode === 'acro' ? '#ffffff' : '#9fe8ff');
    this.text(`${sim.gLoad.toFixed(1)}G`, w - mx, my + u * 2.8, 'right', 0.9);
    if (sim.timeScale !== 1) this.text(`TIME x${sim.timeScale.toFixed(2)}`, w - mx, my + u * 4.0, 'right', 0.9, '#ffcc33');

    // ---- bottom left: throttle, speed ---------------------------------------------------
    const v = dr.vel;
    const speed = Math.hypot(v.x, v.y, v.z) * 3.6;
    this.text(`THR ${Math.round(fc.throttle * 100).toString().padStart(3)}%`, mx, h - my - u * 1.4, 'left', 0.9);
    this.text(`${Math.round(speed).toString().padStart(3)} km/h`, mx, h - my, 'left', 1.25);

    // ---- bottom right: altitude, home -----------------------------------------------------
    const sp = sim.spawn;
    const hx = sp.x - dr.pos.x, hz = sp.z - dr.pos.z;
    const hd = Math.hypot(hx, hz);
    const att = fc.attitude;
    this.text(`ALT ${dr.agl < 99.95 ? dr.agl.toFixed(1) : Math.round(dr.agl)} m`, w - mx, h - my, 'right', 1.25);
    this.text(`HOME ${Math.round(hd)} m`, w - mx - u * 1.6, h - my - u * 1.4, 'right', 0.9);
    // Home arrow: bearing to the launch point relative to the nose.
    const bearing = Math.atan2(hx, -hz) - att.heading;
    c.save();
    c.translate(w - mx - u * 0.6, h - my - u * 1.4);
    c.rotate(bearing);
    c.beginPath();
    c.moveTo(0, -u * 0.6); c.lineTo(u * 0.4, u * 0.5); c.lineTo(0, u * 0.25); c.lineTo(-u * 0.4, u * 0.5);
    c.closePath();
    c.lineWidth = u * 0.16; c.strokeStyle = 'rgba(0,0,0,0.85)'; c.stroke();
    c.fillStyle = '#ffffff'; c.fill();
    c.restore();

    // ---- centre: crosshair and optional artificial horizon ------------------------------
    if (view === 'fpv') {
      const cx = w / 2, cy = h / 2;
      c.lineWidth = Math.max(2, u * 0.12);
      for (const [col, lw] of [['rgba(0,0,0,0.7)', u * 0.26], ['#ffffff', u * 0.11]] as const) {
        c.strokeStyle = col; c.lineWidth = lw;
        c.beginPath();
        c.moveTo(cx - u * 0.9, cy); c.lineTo(cx - u * 0.3, cy);
        c.moveTo(cx + u * 0.3, cy); c.lineTo(cx + u * 0.9, cy);
        c.moveTo(cx, cy - u * 0.5); c.lineTo(cx, cy - u * 0.2);
        c.stroke();
      }
      if (s.osd.horizon) {
        // Pitch ladder scaled to the (rectilinear) centre of the lens.
        const tanV = (Math.tan((s.fov * Math.PI) / 360) / (16 / 9));
        const pxPerRad = (h / 2) / tanV * 0.8;
        const tilt = (s.cameraTilt * Math.PI) / 180;
        c.save();
        c.translate(cx, cy);
        c.rotate(-att.roll);
        const y = (att.pitch + tilt) * pxPerRad;
        for (const [col, lw] of [['rgba(0,0,0,0.6)', u * 0.26], ['#ffffff', u * 0.1]] as const) {
          c.strokeStyle = col; c.lineWidth = lw;
          c.beginPath();
          c.moveTo(-u * 7, y); c.lineTo(-u * 1.6, y);
          c.moveTo(u * 1.6, y); c.lineTo(u * 7, y);
          c.stroke();
        }
        c.restore();
      }
    }

    // ---- lap timing --------------------------------------------------------------------
    if (sim.gates.length > 0) {
      const l = sim.lap;
      const cur = l.running ? sim.time - l.lapStart : 0;
      const fmt = (x: number) => (x > 0 ? x.toFixed(2) + 's' : '--.--');
      const flashGate = sim.time - l.lastGateTime < 0.35;
      this.text(`GATE ${l.nextGate + 1}/${sim.gates.length}`, w / 2, my + u * 3.3, 'center', 0.85, flashGate ? '#66ff88' : '#ffffff');
      if (l.running || l.laps > 0) {
        this.text(`LAP ${l.laps + 1}  ${fmt(cur)}`, w / 2, my + u * 4.5, 'center', 0.85);
        if (l.laps > 0) this.text(`LAST ${fmt(l.lastLap)}  BEST ${fmt(l.bestLap)}`, w / 2, my + u * 5.7, 'center', 0.85, '#9fe8ff');
      }
    }

    // ---- warnings / state ----------------------------------------------------------------
    let warn = '', warnColor = '#ffcc33';
    if (sim.crashed) {
      warn = `CRASHED  ${Math.round(sim.crashSpeed * 3.6)} km/h IMPACT`;
      warnColor = '#ff5544';
    } else if (!fc.armed) {
      warn = sim.armBlock === 'THROTTLE' ? 'CANNOT ARM: THROTTLE NOT LOW'
        : sim.armBlock === 'ANGLE' ? 'CANNOT ARM: NOT LEVEL (TURTLE = T)'
        : 'DISARMED';
      warnColor = sim.armBlock ? '#ff5544' : '#ffffff';
    } else if (crit) {
      warn = blink ? 'LAND NOW' : '';
      warnColor = '#ff5544';
    } else if (low) {
      warn = blink ? 'LOW BATTERY' : '';
    }
    if (warn) this.text(warn, w / 2, my, 'center', 1.2, warnColor);
    if (sim.crashed) this.text('PRESS R TO RESET', w / 2, my + u * 1.6, 'center', 0.9);
    else if (!fc.armed) this.text(source === 'gamepad' ? 'ARM SWITCH / BUTTON TO ARM' : 'SPACE TO ARM   ESC = MENU', w / 2, my + u * 1.6, 'center', 0.8, 'rgba(255,255,255,0.85)');
    let damaged = 0;
    for (const r of dr.rotors) if (r.health < 0.98) damaged++;
    if (damaged > 0 && !sim.crashed) this.text(`PROP DAMAGE x${damaged}`, w / 2, h * 0.32, 'center', 0.9, '#ffcc33');

    if (now < this.flashUntil) this.text(this.flash, w / 2, h * 0.4, 'center', 1.1, '#9fe8ff');

    // ---- stick monitor ---------------------------------------------------------------------
    if (s.osd.sticks) {
      const size = u * 3.4, gap = u * 1.2;
      const y0 = h - my - size;
      const rc = sim.rc;
      const drawStick = (x0: number, sx: number, sy: number) => {
        c.fillStyle = 'rgba(0,0,0,0.28)';
        c.strokeStyle = 'rgba(255,255,255,0.75)';
        c.lineWidth = Math.max(1, u * 0.07);
        c.fillRect(x0, y0, size, size);
        c.strokeRect(x0, y0, size, size);
        c.beginPath();
        c.moveTo(x0 + size / 2, y0); c.lineTo(x0 + size / 2, y0 + size);
        c.moveTo(x0, y0 + size / 2); c.lineTo(x0 + size, y0 + size / 2);
        c.strokeStyle = 'rgba(255,255,255,0.25)';
        c.stroke();
        c.beginPath();
        c.arc(x0 + size / 2 + sx * size / 2, y0 + size / 2 - sy * size / 2, u * 0.28, 0, Math.PI * 2);
        c.fillStyle = '#ffffff';
        c.fill();
      };
      drawStick(w / 2 - gap / 2 - size, rc.yaw, rc.throttle * 2 - 1);
      drawStick(w / 2 + gap / 2, rc.roll, rc.pitch);
    }

    this.text(`${Math.round(fps)} fps`, w - mx, my + u * 5.2, 'right', 0.6, 'rgba(255,255,255,0.55)');
  }
}

/** Text block for the telemetry panel (physics internals). */
export function telemetryText(sim: Simulation): string {
  const dr = sim.drone, fc = sim.fc;
  const va = dr.airVelBody;
  const air = Math.hypot(va.x, va.y, va.z);
  const wnd = dr.wind;
  const windSp = Math.hypot(wnd.x, wnd.z);
  const windFrom = ((Math.atan2(-wnd.x, wnd.z) * RAD2DEG) + 360) % 360;
  const att = fc.attitude;
  const L: string[] = [];
  const f = (x: number, d = 1, n = 6) => x.toFixed(d).padStart(n);
  L.push(`airframe   ${dr.p.id}  ${(dr.d.mass * 1000).toFixed(0)} g`);
  L.push(`attitude   hdg ${f(((att.heading * RAD2DEG) + 360) % 360, 0, 4)}  pitch ${f(att.pitch * RAD2DEG, 0, 4)}  roll ${f(att.roll * RAD2DEG, 0, 4)}`);
  L.push(`rates d/s  R ${f(fc.gyro[0], 0, 5)}  P ${f(fc.gyro[1], 0, 5)}  Y ${f(fc.gyro[2], 0, 5)}`);
  L.push(`setpoint   R ${f(fc.setpoint[0], 0, 5)}  P ${f(fc.setpoint[1], 0, 5)}  Y ${f(fc.setpoint[2], 0, 5)}`);
  L.push(`airspeed   ${f(air)} m/s   climb ${f(dr.vel.y)} m/s`);
  L.push(`wind       ${f(windSp)} m/s from ${f(windFrom, 0, 3)}   vert ${f(wnd.y)}`);
  L.push(`density    ${sim.env.rho.toFixed(3)} kg/m3`);
  L.push(`thrust     ${f(dr.totalThrust)} N   T/W ${f(dr.totalThrust / (dr.d.mass * 9.80665), 2, 5)}`);
  L.push(`battery    ${f(dr.vbus, 2)} V  ${f(dr.packCurrent)} A  ${f(dr.vbus * dr.packCurrent, 0, 5)} W  SoC ${f(dr.battery.soc * 100, 0, 3)} %`);
  L.push('motor      rpm   thrust    amps   vi   AoA  VRS');
  const names = ['RR', 'FR', 'RL', 'FL'];
  for (let i = 0; i < 4; i++) {
    const r = dr.rotors[i];
    L.push(` ${names[i]}  ${f(r.rpm, 0, 6)}  ${f(r.thrust, 2, 6)} N ${f(r.current, 1, 6)} ${f(r.vi, 1, 5)} ${f(r.alpha * RAD2DEG, 0, 4)}  ${r.vrs > 0.05 ? (r.vrs * 100).toFixed(0).padStart(3) + '%' : '  - '}`);
  }
  L.push(`contacts   ${dr.contacts}   step ${(1e6 / 4000).toFixed(0)} us (4 kHz)`);
  return L.join('\n');
}
