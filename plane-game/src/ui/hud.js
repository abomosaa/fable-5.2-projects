// Head-up display drawn on a 2D canvas above the 3D view: speed / altitude / heading tapes,
// attitude (conformal pitch ladder in the cockpit, attitude ball outside), flight-path vector,
// ILS deviation, engine and configuration status, moving map, warnings and messages.

import { AIRPORTS } from '../world/heightfield.js';
import { drawPanel } from './panel.js';

const DEG = Math.PI / 180, RAD = 180 / Math.PI;
const KT = 0.514444, FT = 0.3048, FPM = 0.00508, NM = 1852;

const COL = {
  main: '#e9fff1', green: '#5df59a', amber: '#ffc247', red: '#ff5a44', magenta: '#ff7bf2', cyan: '#62e4ff',
  dim: 'rgba(233,255,241,0.55)', panel: 'rgba(6,14,22,0.42)', panelEdge: 'rgba(160,220,255,0.22)',
};
const FONT = '"DejaVu Sans Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

function hdgLabel(d) {
  d = ((Math.round(d) % 360) + 360) % 360;
  if (d === 0) return 'N'; if (d === 90) return 'E'; if (d === 180) return 'S'; if (d === 270) return 'W';
  return String(d / 10).padStart(2, '0');
}

export class Hud {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.visible = true;
    this.mapRangeIndex = 1;
    this.mapRanges = [6000, 18000, 50000];
    this.mapImage = null;
    this.mapHalf = 65536;
    this.toasts = [];
    this.w = 0; this.h = 0; this.s = 1; this.dpr = 1;
    this.blink = 0;
    this.panelOn = true;         // analog panel in the cockpit of the piston aircraft
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    this.s = Math.max(0.72, Math.min(1.7, Math.min(w / 1280, h / 720)));
  }

  /** Build the moving-map background from the terrain overview heights. */
  setOverview(data, size, half) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const ctx = c.getContext('2d'), img = ctx.createImageData(size, size), d = img.data;
    const ramp = [[-300, [9, 26, 52]], [-40, [14, 44, 82]], [-1, [26, 70, 110]], [0, [150, 142, 104]], [5, [62, 92, 52]], [150, [52, 80, 46]], [500, [70, 86, 54]],
      [1100, [92, 86, 72]], [1800, [118, 114, 110]], [2300, [196, 198, 204]], [4000, [230, 232, 238]]];
    const cell = 2 * half / size;
    for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
      const i = size - 1 - py, j = px;                    // row i <-> north, column j <-> east
      const hgt = data[i * size + j];
      let col = ramp[ramp.length - 1][1];
      for (let k = 1; k < ramp.length; k++) if (hgt <= ramp[k][0]) {
        const a = ramp[k - 1], b = ramp[k], t = Math.max(0, Math.min(1, (hgt - a[0]) / (b[0] - a[0])));
        col = [a[1][0] + (b[1][0] - a[1][0]) * t, a[1][1] + (b[1][1] - a[1][1]) * t, a[1][2] + (b[1][2] - a[1][2]) * t];
        break;
      }
      let shade = 1;
      if (hgt > 0) {
        const hn = data[Math.min(size - 1, i + 1) * size + j], he = data[i * size + Math.min(size - 1, j + 1)];
        shade = Math.max(0.55, Math.min(1.5, 1 + ((hgt - hn) + (hgt - he)) / cell * 1.6));
      }
      const o = (py * size + px) * 4;
      d[o] = Math.min(255, col[0] * shade); d[o + 1] = Math.min(255, col[1] * shade); d[o + 2] = Math.min(255, col[2] * shade); d[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    this.mapImage = c; this.mapHalf = half;
  }

  toast(text, color = COL.main, seconds = 2.6) {
    if (this.toasts.length && this.toasts[this.toasts.length - 1].text === text) { this.toasts[this.toasts.length - 1].t = seconds; return; }
    this.toasts.push({ text, color, t: seconds, life: seconds });
    if (this.toasts.length > 4) this.toasts.shift();
  }

  cycleMapRange() { this.mapRangeIndex = (this.mapRangeIndex + 1) % this.mapRanges.length; }

  // ------------------------------------------------------------------ primitives
  text(str, x, y, size, color = COL.main, align = 'left', weight = '') {
    const ctx = this.ctx;
    ctx.font = `${weight} ${Math.round(size * this.s)}px ${FONT}`;
    ctx.textAlign = align; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3 * this.s; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineJoin = 'round';
    ctx.strokeText(str, x, y);
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }
  line(x0, y0, x1, y1, color = COL.main, width = 1.6) {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = (width + 2) * this.s;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = width * this.s;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }
  panel(x, y, w, h, r = 6) {
    const ctx = this.ctx;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, r * this.s);
    ctx.fillStyle = COL.panel; ctx.fill();
    ctx.strokeStyle = COL.panelEdge; ctx.lineWidth = 1; ctx.stroke();
  }

  // ------------------------------------------------------------------ main
  draw(st, dt) {
    const ctx = this.ctx;
    this.resize();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    this.blink = (this.blink + dt) % 1;
    if (!st || !st.ac) return;
    if (this.visible) {
      const ac = st.ac;
      const analog = st.cameraMode === 'cockpit' && this.panelOn && ac.def.engines[0].type === 'piston';
      if (analog) {
        this.drawNavMarkers(st);
        drawPanel(this, st);
        if (st.ils) this.drawIls(this.w / 2, this.h * 0.5 + 40 * this.s, this.w / 2 + 230 * this.s, this.h * 0.36, st.ils);
      } else {
        if (st.cameraMode === 'cockpit') this.drawConformal(st);
        else if (st.cameraMode === 'chase' || st.cameraMode === 'orbit') this.drawAttitudeBall(st);
        this.drawNavMarkers(st);
        this.drawSpeedTape(ac, st);
        this.drawAltTape(ac, st);
        this.drawHeadingTape(ac, st);
      }
      this.drawStatus(ac, st);
      this.drawMap(ac, st);
      this.drawNav(ac, st);
      this.drawWarnings(ac, st);
    }
    this.drawToasts(dt);
  }

  // ------------------------------------------------------------------ tapes
  drawSpeedTape(ac, st) {
    const ctx = this.ctx, s = this.s;
    const jet = ac.def.engines[0].type === 'jet';
    const x = Math.max(26 * s, this.w * 0.5 - 520 * s), cy = this.h * 0.5, H = 290 * s, W = 70 * s;
    const kts = ac.cas / KT;
    const ppk = (jet ? 1.15 : 2.5) * s, step = jet ? 20 : 10, labelEvery = jet ? 40 : 20;
    this.panel(x, cy - H / 2, W, H);
    ctx.save();
    ctx.beginPath(); ctx.rect(x, cy - H / 2, W + 10 * s, H); ctx.clip();
    // limit bands
    const yOf = (v) => cy - (v - kts) * ppk;
    const vne = ac.def.limits.vne / KT, vs = (ac.surf.flap > 0.5 ? ac.def.ref.vs0 : ac.def.ref.vs) / KT * Math.sqrt(Math.max(0.3, ac.mass / (ac.def.mass.empty + ac.def.mass.fuelMax * 0.5)));
    ctx.fillStyle = 'rgba(255,70,50,0.75)'; ctx.fillRect(x + W - 6 * s, yOf(vne + 400), 6 * s, yOf(vne) - yOf(vne + 400));
    ctx.fillStyle = 'rgba(255,190,60,0.8)'; ctx.fillRect(x + W - 6 * s, yOf(vs), 6 * s, yOf(0) - yOf(vs));
    const v0 = Math.floor((kts - H / 2 / ppk) / step) * step;
    for (let v = Math.max(0, v0); v < kts + H / 2 / ppk + step; v += step) {
      const y = yOf(v);
      const major = v % labelEvery === 0;
      this.line(x + W - (major ? 14 : 8) * s, y, x + W - 1, y, COL.main, 1.3);
      if (major) this.text(String(v), x + W - 18 * s, y, 13, COL.main, 'right');
    }
    if (ac.ap.autothrottle) {
      const y = Math.max(cy - H / 2 + 5, Math.min(cy + H / 2 - 5, yOf(ac.ap.speed / KT)));
      ctx.fillStyle = COL.magenta; ctx.beginPath(); ctx.moveTo(x + W, y); ctx.lineTo(x + W + 9 * s, y - 6 * s); ctx.lineTo(x + W + 9 * s, y + 6 * s); ctx.fill();
    }
    ctx.restore();
    // read-out
    ctx.fillStyle = 'rgba(0,0,0,0.78)'; ctx.strokeStyle = COL.main; ctx.lineWidth = 1.3 * s;
    ctx.beginPath(); ctx.roundRect(x - 4 * s, cy - 15 * s, W - 8 * s, 30 * s, 4 * s); ctx.fill(); ctx.stroke();
    this.text(kts.toFixed(0), x + W - 18 * s, cy, 21, kts > vne ? COL.red : COL.main, 'right', 'bold');
    this.text('KT', x + 4 * s, cy - H / 2 - 11 * s, 11, COL.dim);
    this.text('GS ' + (Math.hypot(ac.vel.x, ac.vel.z) / KT).toFixed(0), x + 2 * s, cy + H / 2 + 12 * s, 12, COL.dim);
    if (jet || ac.mach > 0.4) this.text('M ' + ac.mach.toFixed(2), x + 2 * s, cy + H / 2 + 28 * s, 13, ac.def.limits.mmo && ac.mach > ac.def.limits.mmo ? COL.red : COL.main);
    // g and angle of attack
    this.text('G ' + ac.nz.toFixed(1), x + 2 * s, cy - H / 2 - 44 * s, 13, ac.nz > ac.def.limits.gPos * 0.9 || ac.nz < ac.def.limits.gNeg * 0.9 ? COL.red : COL.main);
    this.text('α ' + (ac.alpha * RAD).toFixed(1) + '°', x + 2 * s, cy - H / 2 - 28 * s, 13, ac.stallWarning ? COL.amber : COL.main);
  }

  drawAltTape(ac, st) {
    const ctx = this.ctx, s = this.s;
    const W = 84 * s, H = 290 * s, x = Math.min(this.w - 26 * s - W - 26 * s, this.w * 0.5 + 520 * s - W), cy = this.h * 0.5;
    const alt = ac.pos.y / FT;
    const ppf = 0.29 * s;
    this.panel(x, cy - H / 2, W, H);
    ctx.save();
    ctx.beginPath(); ctx.rect(x - 12 * s, cy - H / 2, W + 12 * s, H); ctx.clip();
    const yOf = (v) => cy - (v - alt) * ppf;
    const a0 = Math.floor((alt - H / 2 / ppf) / 100) * 100;
    for (let v = a0; v < alt + H / 2 / ppf + 100; v += 100) {
      const y = yOf(v), major = v % 500 === 0;
      this.line(x + 1, y, x + (major ? 14 : 8) * s, y, COL.main, 1.3);
      if (major) this.text(String(v), x + 18 * s, y, 13, COL.main, 'left');
    }
    // ground level on the tape
    const gy = yOf((ac.pos.y - ac.agl) / FT);
    if (gy < cy + H / 2) { ctx.fillStyle = 'rgba(190,120,50,0.6)'; ctx.fillRect(x, gy, W, cy + H / 2 - gy); }
    if (ac.ap.engaged) {
      const y = Math.max(cy - H / 2 + 5, Math.min(cy + H / 2 - 5, yOf(ac.ap.altitude / FT)));
      ctx.fillStyle = COL.magenta; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 9 * s, y - 6 * s); ctx.lineTo(x - 9 * s, y + 6 * s); ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = 'rgba(0,0,0,0.78)'; ctx.strokeStyle = COL.main; ctx.lineWidth = 1.3 * s;
    ctx.beginPath(); ctx.roundRect(x + 8 * s, cy - 15 * s, W, 30 * s, 4 * s); ctx.fill(); ctx.stroke();
    this.text(alt.toFixed(0), x + W + 2 * s, cy, 21, COL.main, 'right', 'bold');
    this.text('FT', x + W - 18 * s, cy - H / 2 - 11 * s, 11, COL.dim);
    // vertical speed
    const vs = ac.vel.y / FPM;
    const vx = x + W + 14 * s;
    const vy = (v) => cy - Math.sign(v) * Math.min(1, Math.pow(Math.abs(v) / 4000, 0.6)) * H * 0.42;
    this.line(vx, cy - H * 0.42, vx, cy + H * 0.42, COL.dim, 1);
    for (const m of [-2000, -1000, -500, 500, 1000, 2000]) this.line(vx - 3 * s, vy(m), vx + 3 * s, vy(m), COL.dim, 1);
    this.line(vx - 6 * s, cy, vx + 6 * s, cy, COL.main, 1.4);
    ctx.fillStyle = Math.abs(vs) > 3000 ? COL.amber : COL.green;
    ctx.beginPath(); ctx.moveTo(vx - 6 * s, vy(vs)); ctx.lineTo(vx + 7 * s, vy(vs) - 5 * s); ctx.lineTo(vx + 7 * s, vy(vs) + 5 * s); ctx.fill();
    this.text((vs >= 0 ? '+' : '') + (Math.round(vs / 10) * 10), x + W, cy + H / 2 + 12 * s, 13, COL.main, 'right');
    this.text('FPM', x + W + 4 * s, cy + H / 2 + 12 * s, 10, COL.dim);
    if (ac.agl < 762) this.text('RA ' + Math.max(0, (ac.agl - st.gearHeight) / FT).toFixed(0), x + W, cy + H / 2 + 29 * s, 14, ac.agl < 150 ? COL.amber : COL.green, 'right', 'bold');
  }

  drawHeadingTape(ac, st) {
    const ctx = this.ctx, s = this.s;
    const cx = this.w / 2, y = 30 * s, W = 430 * s, Hh = 30 * s, ppd = 5.2 * s;
    const hdg = ac.euler.heading * RAD;
    this.panel(cx - W / 2, y - Hh / 2, W, Hh);
    ctx.save();
    ctx.beginPath(); ctx.rect(cx - W / 2, y - Hh / 2 - 12 * s, W, Hh + 24 * s); ctx.clip();
    const d0 = Math.floor((hdg - W / 2 / ppd) / 5) * 5;
    for (let d = d0; d < hdg + W / 2 / ppd + 5; d += 5) {
      const x = cx + (d - hdg) * ppd, major = ((d % 10) + 10) % 10 === 0;
      this.line(x, y + Hh / 2 - (major ? 9 : 5) * s, x, y + Hh / 2 - 1, COL.main, 1.2);
      if (major) {
        const lab = hdgLabel(d);
        this.text(lab, x, y - 3 * s, lab.length === 1 ? 15 : 12, lab.length === 1 ? COL.green : COL.main, 'center', lab.length === 1 ? 'bold' : '');
      }
    }
    const rel = (b) => { let d = b - hdg; d = ((d + 540) % 360) - 180; return d; };
    // ground track
    const gs = Math.hypot(ac.vel.x, ac.vel.z);
    if (gs > 5) {
      const tr = rel(Math.atan2(ac.vel.z, ac.vel.x) * RAD), x = cx + tr * ppd;
      ctx.strokeStyle = COL.green; ctx.lineWidth = 1.5 * s; ctx.beginPath();
      ctx.moveTo(x, y + Hh / 2 + 2 * s); ctx.lineTo(x - 5 * s, y + Hh / 2 + 9 * s); ctx.lineTo(x, y + Hh / 2 + 16 * s); ctx.lineTo(x + 5 * s, y + Hh / 2 + 9 * s); ctx.closePath(); ctx.stroke();
    }
    if (ac.ap.engaged) {
      const x = Math.max(cx - W / 2 + 6, Math.min(cx + W / 2 - 6, cx + rel(ac.ap.heading * RAD) * ppd));
      ctx.fillStyle = COL.magenta; ctx.fillRect(x - 6 * s, y + Hh / 2 - 5 * s, 12 * s, 5 * s);
    }
    if (st.nav) {
      const x = Math.max(cx - W / 2 + 6, Math.min(cx + W / 2 - 6, cx + rel(st.nav.bearing) * ppd));
      ctx.strokeStyle = COL.cyan; ctx.lineWidth = 2 * s; ctx.beginPath(); ctx.arc(x, y + Hh / 2 + 7 * s, 4.5 * s, 0, 6.3); ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = 'rgba(0,0,0,0.8)'; ctx.strokeStyle = COL.main; ctx.lineWidth = 1.3 * s;
    ctx.beginPath(); ctx.roundRect(cx - 27 * s, y - Hh / 2 - 4 * s, 54 * s, 26 * s, 4 * s); ctx.fill(); ctx.stroke();
    this.text(String(Math.round(hdg) % 360).padStart(3, '0'), cx, y - 2 * s + 6 * s - 6 * s + 2 * s, 18, COL.main, 'center', 'bold');
  }

  // ------------------------------------------------------------------ attitude
  project(st, dx, dy, dz) {
    // direction (world) -> screen, or null when behind the camera
    const e = st.camera.matrixWorldInverse.elements, p = st.camera.projectionMatrix.elements;
    const x = e[0] * dx + e[4] * dy + e[8] * dz, y = e[1] * dx + e[5] * dy + e[9] * dz, z = e[2] * dx + e[6] * dy + e[10] * dz;
    if (z > -1e-3) return null;
    return [this.w / 2 + (p[0] * x / -z) * this.w / 2, this.h / 2 - (p[5] * y / -z) * this.h / 2];
  }

  drawConformal(st) {
    const ac = st.ac, s = this.s;
    const psi = ac.euler.heading;
    const dir = (pitchDeg, dAz) => {
      const p = pitchDeg * DEG, a = psi + dAz * DEG;
      return this.project(st, Math.cos(p) * Math.cos(a), Math.sin(p), Math.cos(p) * Math.sin(a));
    };
    const pitch = ac.euler.pitch * RAD;
    const p0 = Math.round(pitch / 5) * 5;
    for (let p = p0 - 20; p <= p0 + 20; p += 5) {
      if (p > 90 || p < -90) continue;
      const half = p === 0 ? 60 : p % 10 === 0 ? 7 : 4, gap = p === 0 ? 0 : 2.6;
      const a = dir(p, -half), b = dir(p, -gap), c = dir(p, gap), d = dir(p, half);
      if (!a || !b || !c || !d) continue;
      if (p === 0) { this.line(a[0], a[1], d[0], d[1], COL.green, 1.5); continue; }
      const col = COL.green;
      if (p < 0) { this.ctx.setLineDash([6 * s, 5 * s]); }
      this.line(a[0], a[1], b[0], b[1], col, 1.4); this.line(c[0], c[1], d[0], d[1], col, 1.4);
      this.ctx.setLineDash([]);
      if (p % 10 === 0) { this.text(String(Math.abs(p)), a[0] - 14 * s, a[1], 12, col, 'center'); this.text(String(Math.abs(p)), d[0] + 14 * s, d[1], 12, col, 'center'); }
    }
    // aircraft reference (where the nose points)
    const nose = st.noseDir ? this.project(st, st.noseDir.x, st.noseDir.y, st.noseDir.z) : null;
    if (nose) {
      const [x, y] = nose;
      this.line(x - 26 * s, y, x - 9 * s, y, COL.main, 2); this.line(x + 9 * s, y, x + 26 * s, y, COL.main, 2);
      this.line(x - 9 * s, y, x, y + 7 * s, COL.main, 2); this.line(x + 9 * s, y, x, y + 7 * s, COL.main, 2);
    }
    // flight path vector: where the aircraft is actually going
    const sp = ac.vel.length();
    if (sp > 12) {
      const v = this.project(st, ac.vel.x / sp, ac.vel.y / sp, ac.vel.z / sp);
      if (v) {
        const ctx = this.ctx, [x, y] = v, r = 7 * s;
        ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 4 * s; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.3); ctx.stroke();
        ctx.strokeStyle = COL.green; ctx.lineWidth = 2 * s; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.3); ctx.stroke();
        this.line(x - r - 12 * s, y, x - r, y, COL.green, 2); this.line(x + r, y, x + r + 12 * s, y, COL.green, 2); this.line(x, y - r, x, y - r - 8 * s, COL.green, 2);
      }
    }
    this.drawSlip(this.w / 2, this.h - 58 * s, ac);
    if (st.ils) this.drawIls(this.w / 2, this.h * 0.5 + 150 * s, this.w / 2 + 200 * s, this.h / 2, st.ils);
  }

  drawSlip(cx, y, ac) {
    const ctx = this.ctx, s = this.s, W = 84 * s;
    ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.strokeStyle = COL.dim; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(cx - W / 2, y - 7 * s, W, 14 * s, 7 * s); ctx.fill(); ctx.stroke();
    this.line(cx - 9 * s, y - 7 * s, cx - 9 * s, y + 7 * s, COL.dim, 1); this.line(cx + 9 * s, y - 7 * s, cx + 9 * s, y + 7 * s, COL.dim, 1);
    const ball = Math.max(-1, Math.min(1, -ac.ny / Math.max(0.3, Math.abs(ac.nz)) * 4));
    ctx.fillStyle = COL.main; ctx.beginPath(); ctx.arc(cx + ball * (W / 2 - 8 * s), y, 6 * s, 0, 6.3); ctx.fill();
  }

  drawAttitudeBall(st) {
    const ctx = this.ctx, s = this.s, ac = st.ac;
    const cx = this.w / 2, cy = this.h - 108 * s, R = 62 * s;
    const pitch = ac.euler.pitch * RAD, roll = ac.euler.roll;
    const ppd = 2.2 * s;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.3); ctx.clip();
    ctx.translate(cx, cy); ctx.rotate(-roll); ctx.translate(0, pitch * ppd);
    ctx.fillStyle = 'rgba(52,118,190,0.82)'; ctx.fillRect(-R * 3, -R * 6, R * 6, R * 6);
    ctx.fillStyle = 'rgba(122,82,44,0.86)'; ctx.fillRect(-R * 3, 0, R * 6, R * 6);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 * s; ctx.beginPath(); ctx.moveTo(-R * 3, 0); ctx.lineTo(R * 3, 0); ctx.stroke();
    ctx.font = `${Math.round(10 * s)}px ${FONT}`; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let p = -90; p <= 90; p += 5) {
      if (p === 0) continue;
      const y = -p * ppd, wl = p % 10 === 0 ? 20 * s : 9 * s;
      if (Math.abs(y + pitch * ppd) > R * 1.2) continue;
      ctx.beginPath(); ctx.moveTo(-wl, y); ctx.lineTo(wl, y); ctx.stroke();
      if (p % 10 === 0) { ctx.fillText(String(Math.abs(p)), -wl - 9 * s, y); ctx.fillText(String(Math.abs(p)), wl + 9 * s, y); }
    }
    ctx.restore();
    // bezel, roll scale and pointer
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 4 * s; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.3); ctx.stroke();
    ctx.strokeStyle = COL.main; ctx.lineWidth = 1.4 * s; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.3); ctx.stroke();
    for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const r0 = R + 1 * s, r1 = R + (a % 30 === 0 ? 9 : 5) * s, an = (a - 90) * DEG;
      this.line(cx + Math.cos(an) * r0, cy + Math.sin(an) * r0, cx + Math.cos(an) * r1, cy + Math.sin(an) * r1, COL.main, 1.2);
    }
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(-roll);
    ctx.fillStyle = Math.abs(roll) > 60 * DEG ? COL.amber : COL.main;
    ctx.beginPath(); ctx.moveTo(0, -R + 1); ctx.lineTo(-6 * s, -R + 11 * s); ctx.lineTo(6 * s, -R + 11 * s); ctx.fill();
    ctx.restore();
    // fixed aircraft symbol
    this.line(cx - 34 * s, cy, cx - 12 * s, cy, COL.amber, 3); this.line(cx + 12 * s, cy, cx + 34 * s, cy, COL.amber, 3);
    ctx.fillStyle = COL.amber; ctx.beginPath(); ctx.arc(cx, cy, 3 * s, 0, 6.3); ctx.fill();
    this.drawSlip(cx, cy + R + 22 * s, ac);
    if (st.ils) this.drawIls(cx, cy - R - 20 * s, cx + R + 22 * s, cy, st.ils);
    // control position: stick (roll, pitch) and rudder
    const bx = cx - R - 78 * s, by = cy - 4 * s, B = 26 * s;
    this.panel(bx - B, by - B, B * 2, B * 2, 3);
    this.line(bx - B, by, bx + B, by, COL.dim, 0.8); this.line(bx, by - B, bx, by + B, COL.dim, 0.8);
    ctx.fillStyle = COL.green; ctx.beginPath(); ctx.arc(bx + st.stick.roll * (B - 4 * s), by + st.stick.pitch * (B - 4 * s), 4 * s, 0, 6.3); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillRect(bx - B, by + B + 5 * s, B * 2, 6 * s);
    ctx.fillStyle = COL.green; ctx.fillRect(bx + st.stick.yaw * (B - 3 * s) - 3 * s, by + B + 4 * s, 6 * s, 8 * s);
    // trim index
    ctx.fillStyle = COL.cyan; ctx.fillRect(bx + B + 3 * s, by + ac.ctrl.trim * (B - 2 * s) - 2 * s, 5 * s, 4 * s);
  }

  drawIls(lx, ly, gx, gy, ils) {
    const ctx = this.ctx, s = this.s;
    const dot = (x, y) => { ctx.strokeStyle = COL.main; ctx.lineWidth = 1.2 * s; ctx.beginPath(); ctx.arc(x, y, 2.6 * s, 0, 6.3); ctx.stroke(); };
    const diamond = (x, y, col) => { ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(x, y - 7 * s); ctx.lineTo(x + 6 * s, y); ctx.lineTo(x, y + 7 * s); ctx.lineTo(x - 6 * s, y); ctx.fill(); };
    // localiser: full scale 2.5 deg
    const sp = 20 * s;
    for (const k of [-2, -1, 1, 2]) dot(lx + k * sp, ly);
    this.line(lx, ly - 7 * s, lx, ly + 7 * s, COL.main, 1.5);
    const l = Math.max(-1, Math.min(1, ils.loc / 2.5));
    diamond(lx - l * sp * 2, ly, Math.abs(l) < 1 ? COL.magenta : COL.dim);
    // glide slope: full scale 0.7 deg
    for (const k of [-2, -1, 1, 2]) dot(gx, gy + k * sp);
    this.line(gx - 7 * s, gy, gx + 7 * s, gy, COL.main, 1.5);
    const g = Math.max(-1, Math.min(1, ils.gs / 0.7));
    diamond(gx, gy + g * sp * 2, Math.abs(g) < 1 ? COL.magenta : COL.dim);
  }

  // ------------------------------------------------------------------ world markers
  drawNavMarkers(st) {
    if (st.cameraMode === 'flyby' || st.cameraMode === 'tower') return;
    const ac = st.ac, s = this.s, cp = st.camera.position;
    for (const a of AIRPORTS) {
      const dx = a.x - cp.x, dy = a.elevation - cp.y, dz = a.z - cp.z;
      const dist = Math.hypot(dx, dy, dz);
      const isNav = st.nav && st.nav.airport === a;
      if (dist < 900 || (!isNav && dist > 60000)) continue;
      const p = this.project(st, dx / dist, dy / dist, dz / dist);
      if (!p) continue;
      const [x, y] = p;
      if (x < 40 || x > this.w - 40 || y < 70 * s || y > this.h - 40) continue;
      const col = isNav ? COL.cyan : COL.dim;
      const ctx = this.ctx;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 3.5 * s;
      ctx.beginPath(); ctx.moveTo(x, y - 6 * s); ctx.lineTo(x + 6 * s, y); ctx.lineTo(x, y + 6 * s); ctx.lineTo(x - 6 * s, y); ctx.closePath(); ctx.stroke();
      ctx.strokeStyle = col; ctx.lineWidth = 1.6 * s; ctx.stroke();
      this.text(`${a.id}  ${(Math.hypot(a.x - ac.pos.x, a.z - ac.pos.z) / NM).toFixed(1)} NM`, x, y - 16 * s, 11, col, 'center');
    }
  }

  // ------------------------------------------------------------------ status cluster
  drawStatus(ac, st) {
    const ctx = this.ctx, s = this.s, def = ac.def;
    const x = 22 * s, W = 232 * s, H = 142 * s, y = this.h - H - 20 * s;
    this.panel(x, y, W, H);
    const e = ac.engines[0];
    // throttle column
    const tx = x + 14 * s, ty = y + 24 * s, th = H - 46 * s, tw = 14 * s;
    this.text('THR', tx + tw / 2, y + 12 * s, 10, COL.dim, 'center');
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(tx, ty, tw, th);
    const thr = ac.throttleCmd;
    const ab = e.hasAB ? e.abDetent : 1;
    ctx.fillStyle = thr > ab + 0.001 ? COL.amber : COL.green;
    ctx.fillRect(tx, ty + th * (1 - thr), tw, th * thr);
    if (e.hasAB) this.line(tx - 3 * s, ty + th * (1 - ab), tx + tw + 3 * s, ty + th * (1 - ab), COL.amber, 1.2);
    this.text(Math.round(thr * 100) + '%', tx + tw / 2, y + H - 11 * s, 12, COL.main, 'center');
    // engine read-outs
    const cx = x + 46 * s;
    let row = y + 16 * s;
    const kv = (k, v, col = COL.main) => { this.text(k, cx, row, 11, COL.dim); this.text(v, x + W - 12 * s, row, 14, col, 'right', 'bold'); row += 19 * s; };
    if (e.type === 'piston') kv('RPM', e.running || e.rpm > 20 ? String(Math.round(e.rpm / 10) * 10) : 'OFF', e.rpm > def.engines[0].ratedRpm * 1.02 ? COL.red : COL.main);
    else {
      const n1 = ac.engines.map((en) => (en.n1 * 100).toFixed(0)).join(' / ');
      kv('N1 %', n1 + (e.ab > 0.05 ? ' AB' : ''), e.ab > 0.05 ? COL.amber : COL.main);
    }
    if (ac.engines.some((en) => en.reverse > 0.05)) { this.text('REV', cx + 44 * s, row - 19 * s, 12, COL.amber, 'left', 'bold'); }
    const ff = ac.engines.reduce((a, en) => a + en.fuelFlow, 0);
    const endurance = ff > 1e-5 ? ac.fuel / ff / 60 : 0;
    kv('FUEL', `${Math.round(ac.fuelFraction * 100)}%` + (endurance > 0 && endurance < 600 ? `  ${endurance < 100 ? endurance.toFixed(0) + 'm' : (endurance / 60).toFixed(1) + 'h'}` : ''), ac.fuelFraction < 0.1 ? COL.red : COL.main);
    if (def.flaps) {
      const lab = def.flaps.labels ? def.flaps.labels[ac.ctrl.flapIndex] : def.flaps.settings[ac.ctrl.flapIndex] + '°';
      const moving = Math.abs(ac.surf.flap - def.flaps.settings[ac.ctrl.flapIndex] / def.flaps.max) > 0.01;
      kv('FLAPS', lab, moving ? COL.amber : ac.ctrl.flapIndex ? COL.green : COL.main);
    } else kv('FLAPS', '—', COL.dim);
    if (def.retractable) {
      const g = ac.surf.gear;
      kv('GEAR', g > 0.99 ? 'DOWN' : g < 0.01 ? 'UP' : 'TRANSIT', g > 0.99 ? COL.green : g < 0.01 ? COL.main : COL.amber);
    } else kv('GEAR', 'FIXED', COL.dim);
    kv('TRIM', (ac.ctrl.trim >= 0 ? '+' : '') + (ac.ctrl.trim * 100).toFixed(0), COL.main);
    // annunciators
    let ax = cx; const ay = y + H - 13 * s;
    const ann = (label, on, col) => {
      ctx.font = `bold ${Math.round(10 * s)}px ${FONT}`;
      const w = ctx.measureText(label).width + 10 * s;
      ctx.fillStyle = on ? col : 'rgba(255,255,255,0.07)'; ctx.beginPath(); ctx.roundRect(ax, ay - 8 * s, w, 16 * s, 3 * s); ctx.fill();
      ctx.fillStyle = on ? '#08131c' : 'rgba(255,255,255,0.3)'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(label, ax + 5 * s, ay + 0.5);
      ax += w + 5 * s;
    };
    ann('BRK', ac.ctrl.brake > 0.1 || ac.ctrl.parkingBrake, ac.ctrl.parkingBrake ? COL.red : COL.amber);
    ann('SPLR', ac.surf.spoiler > 0.05, COL.amber);
    ann('AP', ac.ap.engaged, COL.green);
    ann('A/T', ac.ap.autothrottle, COL.green);
    // wind read-out and view name beside the cluster
    const w = st.wind, lx = x + W + 14 * s;
    this.text(`${st.cameraName}`, lx, y + H - 46 * s, 11, COL.dim);
    this.text(`${st.clock}`, lx, y + H - 30 * s, 11, COL.dim);
    if (w) {
      const from = ((w.dirFrom * RAD) % 360 + 360) % 360;
      this.text(`WIND ${String(Math.round(from)).padStart(3, '0')}° / ${(w.speed / KT).toFixed(0)} KT`, lx + 26 * s, y + H - 12 * s, 12, COL.dim);
      // arrow relative to the aircraft heading (points where the wind is blowing to)
      const rel = w.dirFrom + Math.PI - ac.euler.heading;
      const ox = lx + 9 * s, oy = y + H - 13 * s, L = 10 * s;
      ctx.save(); ctx.translate(ox, oy); ctx.rotate(rel);
      ctx.strokeStyle = COL.cyan; ctx.lineWidth = 2 * s; ctx.beginPath(); ctx.moveTo(0, L); ctx.lineTo(0, -L); ctx.moveTo(-4 * s, -L + 6 * s); ctx.lineTo(0, -L); ctx.lineTo(4 * s, -L + 6 * s); ctx.stroke();
      ctx.restore();
    }
  }

  // ------------------------------------------------------------------ moving map
  drawMap(ac, st) {
    const ctx = this.ctx, s = this.s;
    const R = 92 * s, cx = this.w - R - 26 * s, cy = this.h - R - 24 * s;
    const range = this.mapRanges[this.mapRangeIndex];
    const ppm = R / range;
    const hdg = ac.euler.heading;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.3); ctx.clip();
    ctx.fillStyle = '#0c2238'; ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    ctx.translate(cx, cy); ctx.rotate(-hdg);
    if (this.mapImage) {
      const size = this.mapImage.width, mpp = 2 * this.mapHalf / size;       // metres per image pixel
      // image pixel of the aircraft
      const px = (ac.pos.z + this.mapHalf) / mpp, py = (this.mapHalf - ac.pos.x) / mpp;
      const k = mpp * ppm;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.mapImage, -px * k, -py * k, size * k, size * k);
    }
    // world -> map (north up before rotation): east = +x on canvas, north = -y
    const mx = (wz) => (wz - ac.pos.z) * ppm, my = (wx) => -(wx - ac.pos.x) * ppm;
    for (const a of AIRPORTS) {
      const hx = a.dirX * a.length / 2, hz = a.dirZ * a.length / 2;
      const isNav = st.nav && st.nav.airport === a;
      ctx.strokeStyle = isNav ? COL.cyan : '#ffffff'; ctx.lineWidth = Math.max(2 * s, a.width * ppm);
      ctx.beginPath(); ctx.moveTo(mx(a.z - hz), my(a.x - hx)); ctx.lineTo(mx(a.z + hz), my(a.x + hx)); ctx.stroke();
      ctx.save(); ctx.translate(mx(a.z), my(a.x)); ctx.rotate(hdg);
      ctx.font = `bold ${Math.round(10 * s)}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.strokeText(a.id, 0, -11 * s);
      ctx.fillStyle = isNav ? COL.cyan : '#ffffff'; ctx.fillText(a.id, 0, -11 * s);
      ctx.restore();
    }
    if (st.nav) {
      const a = st.nav.airport;
      ctx.strokeStyle = 'rgba(98,228,255,0.7)'; ctx.lineWidth = 1.2 * s; ctx.setLineDash([5 * s, 4 * s]);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(mx(a.z), my(a.x)); ctx.stroke(); ctx.setLineDash([]);
      if (st.nav.runway) {
        // extended centreline of the selected runway
        const r = st.nav.runway, L = 9 * NM;
        ctx.strokeStyle = 'rgba(255,123,242,0.75)'; ctx.lineWidth = 1.2 * s;
        ctx.beginPath(); ctx.moveTo(mx(r.z), my(r.x)); ctx.lineTo(mx(r.z - r.dz * L), my(r.x - r.dx * L)); ctx.stroke();
      }
    }
    ctx.restore();
    // frame, range ring, north pointer, own ship
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 4 * s; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.3); ctx.stroke();
    ctx.strokeStyle = COL.panelEdge; ctx.lineWidth = 1.5 * s; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.3); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, R / 2, 0, 6.3); ctx.stroke();
    const na = -hdg - Math.PI / 2;
    this.text('N', cx + Math.cos(na) * (R - 10 * s), cy + Math.sin(na) * (R - 10 * s), 12, COL.amber, 'center', 'bold');
    ctx.fillStyle = COL.amber; ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, cy - 9 * s); ctx.lineTo(cx + 6 * s, cy + 7 * s); ctx.lineTo(cx, cy + 3 * s); ctx.lineTo(cx - 6 * s, cy + 7 * s); ctx.closePath(); ctx.fill(); ctx.stroke();
    this.text(`${(range / NM).toFixed(0)} NM`, cx - R + 4 * s, cy - R - 2 * s, 11, COL.dim);
  }

  drawNav(ac, st) {
    if (!st.nav) return;
    const s = this.s, n = st.nav;
    const x = this.w - 26 * s, y = this.h - 2 * 92 * s - 62 * s;
    const rw = n.runway ? `  RWY ${n.runway.id}` : '';
    this.text(`${n.airport.id}${rw}`, x, y, 14, COL.cyan, 'right', 'bold');
    this.text(`${String(Math.round(n.bearing + 360) % 360).padStart(3, '0')}°   ${(n.distance / NM).toFixed(1)} NM`, x, y + 17 * s, 13, COL.main, 'right');
    if (st.ils) this.text(`ILS  ${st.ils.dme.toFixed(1)} NM`, x, y - 17 * s, 12, COL.magenta, 'right');
  }

  // ------------------------------------------------------------------ warnings
  drawWarnings(ac, st) {
    const s = this.s, cx = this.w / 2;
    let y = 84 * s;
    const on = this.blink < 0.6;
    const warn = (label, col, flash = true) => {
      if (!flash || on) {
        const ctx = this.ctx;
        ctx.font = `bold ${Math.round(20 * s)}px ${FONT}`;
        const w = ctx.measureText(label).width + 26 * s;
        ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.beginPath(); ctx.roundRect(cx - w / 2, y - 15 * s, w, 30 * s, 5 * s); ctx.fill();
        ctx.strokeStyle = col; ctx.lineWidth = 1.5 * s; ctx.stroke();
        this.text(label, cx, y + 1, 20, col, 'center', 'bold');
      }
      y += 36 * s;
    };
    for (const w of st.warnings) warn(w.text, w.level === 2 ? COL.red : COL.amber, w.flash !== false);
    if (ac.ap.engaged) {
      this.text(`AP   HDG ${String(Math.round(((ac.ap.heading * RAD) % 360 + 360) % 360)).padStart(3, '0')}   ALT ${Math.round(ac.ap.altitude / FT / 10) * 10}` + (ac.ap.autothrottle ? `   SPD ${Math.round(ac.ap.speed / KT)}` : ''), cx, 62 * s, 13, COL.magenta, 'center', 'bold');
    } else if (ac.ap.autothrottle) this.text(`A/THR   SPD ${Math.round(ac.ap.speed / KT)}`, cx, 62 * s, 13, COL.magenta, 'center', 'bold');
  }

  drawToasts(dt) {
    const s = this.s, cx = this.w / 2;
    let y = this.h * 0.5 + 96 * s;
    for (const t of this.toasts) t.t -= dt;
    this.toasts = this.toasts.filter((t) => t.t > 0);
    for (const t of this.toasts) {
      const a = Math.min(1, t.t / 0.4, (t.life - t.t) / 0.15 + 0.2);
      this.ctx.globalAlpha = Math.max(0, a);
      this.text(t.text, cx, y, 16, t.color, 'center', 'bold');
      y += 24 * s;
    }
    this.ctx.globalAlpha = 1;
  }
}
