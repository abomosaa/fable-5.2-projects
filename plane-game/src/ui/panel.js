// Analog instrument panel for the piston aircraft (cockpit view): the classic "six pack" —
// airspeed, attitude, altimeter, turn coordinator, heading, vertical speed — plus a tachometer.
// Dial faces are rendered once into off-screen canvases; needles and cards are drawn live.

const DEG = Math.PI / 180, RAD = 180 / Math.PI;
const KT = 0.514444, FT = 0.3048, FPM = 0.00508;
const FONT = '"DejaVu Sans", "Segoe UI", Arial, sans-serif';

const cache = new Map();

function face(key, r, dpr, paint) {
  const k = `${key}:${Math.round(r * dpr)}`;
  let c = cache.get(k);
  if (!c) {
    const S = Math.ceil((r + 6) * 2 * dpr);
    c = document.createElement('canvas'); c.width = c.height = S;
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr); ctx.translate(r + 6, r + 6);
    // bezel and dial
    const g = ctx.createRadialGradient(0, -r * 0.3, r * 0.2, 0, 0, r + 5);
    g.addColorStop(0, '#3a3d42'); g.addColorStop(1, '#0b0c0e');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r + 5, 0, 6.3); ctx.fill();
    ctx.fillStyle = '#0d0f12'; ctx.beginPath(); ctx.arc(0, 0, r, 0, 6.3); ctx.fill();
    paint(ctx, r);
    cache.set(k, c);
  }
  return c;
}

function ticks(ctx, r, a0, a1, n, len, width, color = '#e8e8e8') {
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'butt';
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * i / n - Math.PI / 2;
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * (r - len), Math.sin(a) * (r - len)); ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); ctx.stroke();
  }
}
function label(ctx, text, a, rad, size, color = '#f2f2f2') {
  ctx.font = `bold ${size}px ${FONT}`; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, Math.cos(a - Math.PI / 2) * rad, Math.sin(a - Math.PI / 2) * rad);
}
function arc(ctx, r, a0, a1, width, color) {
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'butt';
  ctx.beginPath(); ctx.arc(0, 0, r, a0 - Math.PI / 2, a1 - Math.PI / 2); ctx.stroke();
}
function needle(ctx, x, y, a, len, width, color = '#f4f4f4', tail = 0.18) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(a);
  ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 2;
  ctx.fillStyle = color; ctx.beginPath();
  ctx.moveTo(-width / 2, len * tail); ctx.lineTo(-width / 2, -len * 0.8); ctx.lineTo(0, -len); ctx.lineTo(width / 2, -len * 0.8); ctx.lineTo(width / 2, len * tail); ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#1b1d20'; ctx.beginPath(); ctx.arc(x, y, width * 1.3, 0, 6.3); ctx.fill();
}

/** speed (kt) -> dial angle (rad, clockwise from the top) */
function asiAngle(v, vmax) {
  const t = Math.max(0, Math.min(1, (v - vmax * 0.16) / (vmax * 0.84)));
  return (22 + t * 316) * DEG;
}

export function drawPanel(hud, st) {
  const ctx = hud.ctx, w = hud.w, h = hud.h, s = hud.s, dpr = hud.dpr, ac = st.ac, def = ac.def;
  const H = Math.min(h * 0.4, 300 * s), top = h - H;
  // panel body with a curved glare shield
  ctx.save();
  const g = ctx.createLinearGradient(0, top - 26 * s, 0, h);
  g.addColorStop(0, '#16181b'); g.addColorStop(0.12, '#2a2d31'); g.addColorStop(1, '#17191c');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(0, top + 18 * s);
  ctx.bezierCurveTo(w * 0.2, top - 30 * s, w * 0.8, top - 30 * s, w, top + 18 * s);
  ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.lineWidth = 5 * s; ctx.stroke();
  ctx.restore();

  const r = Math.min(H * 0.19, 60 * s), gap = r * 0.3;
  const cx0 = w * 0.5 - (2 * r + gap), cy0 = top + r + gap * 1.35;
  const pos = (i) => [cx0 + (i % 3) * (2 * r + gap), cy0 + Math.floor(i / 3) * (2 * r + gap)];
  const put = (c, x, y) => ctx.drawImage(c, x - r - 6, y - r - 6, 2 * r + 12, 2 * r + 12);
  const fs = r * 0.19;

  // ---- 1 airspeed
  {
    const [x, y] = pos(0);
    const vmax = Math.ceil(def.limits.vne / KT / 20) * 20 + 20;
    put(face('asi' + def.id, r, dpr, (c, R) => {
      const L = def.limits, vs0 = def.ref.vs0 / KT, vs = def.ref.vs / KT;
      if (L.vfe) arc(c, R * 0.9, asiAngle(vs0, vmax), asiAngle(L.vfe / KT, vmax), R * 0.05, '#f1f1f1');
      arc(c, R * 0.82, asiAngle(vs, vmax), asiAngle((L.vno || L.vne * 0.8) / KT, vmax), R * 0.07, '#35b85a');
      arc(c, R * 0.82, asiAngle((L.vno || L.vne * 0.8) / KT, vmax), asiAngle(L.vne / KT, vmax), R * 0.07, '#e9c33a');
      const ar = asiAngle(L.vne / KT, vmax) - Math.PI / 2;
      c.strokeStyle = '#e23b2e'; c.lineWidth = R * 0.045; c.beginPath(); c.moveTo(Math.cos(ar) * R * 0.7, Math.sin(ar) * R * 0.7); c.lineTo(Math.cos(ar) * R, Math.sin(ar) * R); c.stroke();
      for (let v = Math.ceil(vmax * 0.16 / 10) * 10; v <= vmax; v += 10) {
        const a = asiAngle(v, vmax) - Math.PI / 2, big = v % 20 === 0;
        c.strokeStyle = '#eee'; c.lineWidth = big ? 2 : 1; c.beginPath(); c.moveTo(Math.cos(a) * R * (big ? 0.86 : 0.91), Math.sin(a) * R * (big ? 0.86 : 0.91)); c.lineTo(Math.cos(a) * R * 0.98, Math.sin(a) * R * 0.98); c.stroke();
        if (v % 40 === 0 || (vmax <= 220 && big)) label(c, String(v), a + Math.PI / 2, R * 0.68, R * 0.17);
      }
      label(c, 'KNOTS', Math.PI, R * 0.34, R * 0.12, '#aaa');
    }), x, y);
    needle(ctx, x, y, asiAngle(ac.cas / KT, vmax), r * 0.86, r * 0.08);
  }
  // ---- 2 attitude
  {
    const [x, y] = pos(1);
    put(face('ring', r, dpr, () => {}), x, y);
    const pitch = ac.euler.pitch * RAD, roll = ac.euler.roll, ppd = r * 0.034;
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, r * 0.94, 0, 6.3); ctx.clip();
    ctx.translate(x, y); ctx.rotate(-roll); ctx.translate(0, pitch * ppd);
    ctx.fillStyle = '#2f7bd0'; ctx.fillRect(-r * 3, -r * 6, r * 6, r * 6);
    ctx.fillStyle = '#7a4a22'; ctx.fillRect(-r * 3, 0, r * 6, r * 6);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(-r * 3, 0); ctx.lineTo(r * 3, 0); ctx.stroke();
    ctx.font = `${fs * 0.8}px ${FONT}`; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let p = -60; p <= 60; p += 5) {
      if (p === 0) continue;
      const yy = -p * ppd, wl = p % 10 === 0 ? r * 0.3 : r * 0.14;
      ctx.beginPath(); ctx.moveTo(-wl, yy); ctx.lineTo(wl, yy); ctx.stroke();
      if (p % 10 === 0) { ctx.fillText(String(Math.abs(p)), -wl - fs * 0.7, yy); ctx.fillText(String(Math.abs(p)), wl + fs * 0.7, yy); }
    }
    ctx.restore();
    // bank scale + pointer
    ctx.save(); ctx.translate(x, y);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    for (const a of [-60, -30, -20, -10, 0, 10, 20, 30, 60]) { const an = (a - 90) * DEG, l = a % 30 === 0 ? 0.14 : 0.08; ctx.beginPath(); ctx.moveTo(Math.cos(an) * r * 0.94, Math.sin(an) * r * 0.94); ctx.lineTo(Math.cos(an) * r * (0.94 - l), Math.sin(an) * r * (0.94 - l)); ctx.stroke(); }
    ctx.rotate(-roll); ctx.fillStyle = '#ffb52e'; ctx.beginPath(); ctx.moveTo(0, -r * 0.8); ctx.lineTo(-r * 0.07, -r * 0.66); ctx.lineTo(r * 0.07, -r * 0.66); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = '#ffb52e'; ctx.lineWidth = 3.5; ctx.beginPath(); ctx.moveTo(x - r * 0.55, y); ctx.lineTo(x - r * 0.2, y); ctx.lineTo(x - r * 0.1, y + r * 0.08); ctx.moveTo(x + r * 0.55, y); ctx.lineTo(x + r * 0.2, y); ctx.lineTo(x + r * 0.1, y + r * 0.08); ctx.stroke();
    ctx.fillStyle = '#ffb52e'; ctx.beginPath(); ctx.arc(x, y, 3, 0, 6.3); ctx.fill();
  }
  // ---- 3 altimeter
  {
    const [x, y] = pos(2);
    put(face('alt', r, dpr, (c, R) => {
      ticks(c, R * 0.98, 0, 2 * Math.PI, 50, R * 0.07, 1); ticks(c, R * 0.98, 0, 2 * Math.PI, 10, R * 0.13, 2.2);
      for (let i = 0; i < 10; i++) label(c, String(i), i * 36 * DEG, R * 0.7, R * 0.22);
      label(c, 'ALT  ×100 FT', 0, R * 0.36, R * 0.1, '#aaa');
    }), x, y);
    const alt = ac.pos.y / FT;
    needle(ctx, x, y, (alt / 10000) * 2 * Math.PI, r * 0.5, r * 0.11, '#ddd');
    needle(ctx, x, y, ((alt % 1000) / 1000) * 2 * Math.PI, r * 0.88, r * 0.06);
    ctx.fillStyle = '#000'; ctx.fillRect(x - r * 0.36, y + r * 0.3, r * 0.72, r * 0.26);
    ctx.font = `bold ${fs * 1.05}px ${FONT}`; ctx.fillStyle = '#e8ffe8'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.round(alt / 10) * 10), x, y + r * 0.44);
  }
  // ---- 4 turn coordinator
  {
    const [x, y] = pos(3);
    put(face('tc', r, dpr, (c, R) => {
      c.strokeStyle = '#eee'; c.lineWidth = 3;
      for (const a of [-90, 90]) for (const d of [0, 20]) { const an = (a + (a < 0 ? -d : d)) * DEG - Math.PI / 2; c.beginPath(); c.moveTo(Math.cos(an) * R * 0.82, Math.sin(an) * R * 0.82); c.lineTo(Math.cos(an) * R * 0.97, Math.sin(an) * R * 0.97); c.stroke(); }
      label(c, 'L', -112 * DEG, R * 0.68, R * 0.16); label(c, 'R', 112 * DEG, R * 0.68, R * 0.16);
      label(c, '2 MIN', Math.PI, R * 0.2, R * 0.1, '#aaa');
    }), x, y);
    // turn rate: standard rate (3 deg/s) puts the wing on the mark (20 deg)
    const rate = -ac.omega.y * Math.cos(ac.euler.roll) + ac.omega.z * Math.sin(ac.euler.roll);
    const a = Math.max(-35, Math.min(35, rate * RAD / 3 * 20)) * DEG;
    ctx.save(); ctx.translate(x, y - r * 0.05); ctx.rotate(a);
    ctx.fillStyle = '#f4f4f4'; ctx.fillRect(-r * 0.72, -r * 0.035, r * 1.44, r * 0.07);
    ctx.beginPath(); ctx.arc(0, 0, r * 0.12, 0, 6.3); ctx.fill(); ctx.fillRect(-r * 0.03, -r * 0.3, r * 0.06, r * 0.3); ctx.fillRect(-r * 0.2, -r * 0.3, r * 0.4, r * 0.05);
    ctx.restore();
    // inclinometer
    const by = y + r * 0.52, bw = r * 0.62;
    ctx.fillStyle = '#d9dccb'; ctx.beginPath(); ctx.roundRect(x - bw, by - r * 0.11, bw * 2, r * 0.22, r * 0.11); ctx.fill();
    ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x - r * 0.13, by - r * 0.11); ctx.lineTo(x - r * 0.13, by + r * 0.11); ctx.moveTo(x + r * 0.13, by - r * 0.11); ctx.lineTo(x + r * 0.13, by + r * 0.11); ctx.stroke();
    const ball = Math.max(-1, Math.min(1, -ac.ny / Math.max(0.3, Math.abs(ac.nz)) * 4));
    ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(x + ball * (bw - r * 0.11), by, r * 0.1, 0, 6.3); ctx.fill();
  }
  // ---- 5 heading indicator
  {
    const [x, y] = pos(4);
    put(face('ring', r, dpr, () => {}), x, y);
    ctx.save(); ctx.translate(x, y); ctx.rotate(-ac.euler.heading);
    ctx.strokeStyle = '#eee'; ctx.fillStyle = '#f2f2f2'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let d = 0; d < 360; d += 5) {
      const big = d % 10 === 0;
      ctx.lineWidth = big ? 1.8 : 1;
      ctx.save(); ctx.rotate(d * DEG);
      ctx.beginPath(); ctx.moveTo(0, -r * 0.96); ctx.lineTo(0, -r * (big ? 0.84 : 0.89)); ctx.stroke();
      if (d % 30 === 0) { ctx.font = `bold ${d % 90 === 0 ? fs * 1.15 : fs}px ${FONT}`; ctx.fillText(d % 90 === 0 ? 'NESW'[d / 90] : String(d / 10), 0, -r * 0.68); }
      ctx.restore();
    }
    if (ac.ap.engaged) { ctx.rotate(ac.ap.heading); ctx.fillStyle = '#ff7bf2'; ctx.fillRect(-r * 0.08, -r * 0.99, r * 0.16, r * 0.1); }
    ctx.restore();
    // fixed aeroplane symbol and lubber line
    ctx.strokeStyle = '#ffb52e'; ctx.lineWidth = 2.5; ctx.beginPath();
    ctx.moveTo(x, y - r * 0.4); ctx.lineTo(x, y + r * 0.32); ctx.moveTo(x - r * 0.3, y - r * 0.02); ctx.lineTo(x + r * 0.3, y - r * 0.02); ctx.moveTo(x - r * 0.12, y + r * 0.26); ctx.lineTo(x + r * 0.12, y + r * 0.26); ctx.stroke();
    ctx.fillStyle = '#ffb52e'; ctx.beginPath(); ctx.moveTo(x, y - r * 0.82); ctx.lineTo(x - r * 0.06, y - r * 0.97); ctx.lineTo(x + r * 0.06, y - r * 0.97); ctx.fill();
  }
  // ---- 6 vertical speed
  {
    const [x, y] = pos(5);
    const vsAngle = (fpm) => (-90 + Math.sign(fpm) * Math.min(1, Math.pow(Math.abs(fpm) / 2000, 0.75)) * 172) * DEG;
    put(face('vsi', r, dpr, (c, R) => {
      for (const v of [0, 500, 1000, 1500, 2000]) for (const sg of v ? [-1, 1] : [1]) {
        const a = vsAngle(sg * v) - Math.PI / 2;
        c.strokeStyle = '#eee'; c.lineWidth = 2; c.beginPath(); c.moveTo(Math.cos(a) * R * 0.84, Math.sin(a) * R * 0.84); c.lineTo(Math.cos(a) * R * 0.98, Math.sin(a) * R * 0.98); c.stroke();
        if (v % 1000 === 0) label(c, String(v / 100), a + Math.PI / 2, R * 0.66, R * 0.2);
      }
      for (let v = 100; v < 2000; v += 100) if (v % 500) for (const sg of [-1, 1]) { const a = vsAngle(sg * v) - Math.PI / 2; c.strokeStyle = '#ccc'; c.lineWidth = 1; c.beginPath(); c.moveTo(Math.cos(a) * R * 0.91, Math.sin(a) * R * 0.91); c.lineTo(Math.cos(a) * R * 0.98, Math.sin(a) * R * 0.98); c.stroke(); }
      label(c, 'UP', -55 * DEG, R * 0.42, R * 0.11, '#aaa'); label(c, 'DN', -125 * DEG, R * 0.42, R * 0.11, '#aaa');
      label(c, '×100 FT/MIN', 90 * DEG, R * 0.3, R * 0.085, '#aaa');
    }), x, y);
    needle(ctx, x, y, vsAngle(ac.vel.y / FPM), r * 0.86, r * 0.07);
  }
  // ---- tachometer + small read-outs right of the six pack
  {
    const x = cx0 + 3 * (2 * r + gap) + r * 0.25, y = cy0 + (2 * r + gap) * 0.5, R2 = r * 0.92;
    const e = ac.engines[0], rated = def.engines[0].ratedRpm, maxR = Math.ceil(rated * 1.2 / 500) * 500;
    const ang = (v) => (-135 + Math.max(0, Math.min(1, v / maxR)) * 270) * DEG;
    ctx.drawImage(face('tach' + def.id, R2, dpr, (c, R) => {
      arc(c, R * 0.84, ang(rated * 0.78), ang(rated), R * 0.07, '#35b85a');
      const ar = ang(rated) - Math.PI / 2;
      c.strokeStyle = '#e23b2e'; c.lineWidth = R * 0.05; c.beginPath(); c.moveTo(Math.cos(ar) * R * 0.72, Math.sin(ar) * R * 0.72); c.lineTo(Math.cos(ar) * R, Math.sin(ar) * R); c.stroke();
      for (let v = 0; v <= maxR; v += 100) { const a = ang(v) - Math.PI / 2, big = v % 500 === 0; c.strokeStyle = '#eee'; c.lineWidth = big ? 2 : 1; c.beginPath(); c.moveTo(Math.cos(a) * R * (big ? 0.84 : 0.92), Math.sin(a) * R * (big ? 0.84 : 0.92)); c.lineTo(Math.cos(a) * R * 0.98, Math.sin(a) * R * 0.98); c.stroke(); if (big) label(c, String(v / 100), a + Math.PI / 2, R * 0.66, R * 0.17); }
      label(c, 'RPM ×100', Math.PI, R * 0.42, R * 0.11, '#aaa');
    }), x - R2 - 6, y - R2 - 6, 2 * R2 + 12, 2 * R2 + 12);
    needle(ctx, x, y, ang(e.rpm), R2 * 0.84, R2 * 0.07);
  }
}
