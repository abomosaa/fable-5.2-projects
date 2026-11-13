// Procedural 3D models of the flyable aircraft.
//
//   const model = buildAircraftModel(def);
//   scene.add(model.group);              // body frame: +X forward, +Y up, +Z right, origin = CG
//   model.update(state, dt);             // animate surfaces, gear, propeller, engines, lights
//   model.setCockpitView(true);          // hide what would block the pilot's eyes
//   model.anchors                        // attachment points for effects (body frame)

import * as THREE from 'three';
import {
  DEG, v3, Parts, mergeGeos, tx, mirrorZ, setUV, smoothStations, loft, lathe, ringLoft, tube, unitStrut, ellipsoid, box,
  plateXY, plateXZ, wheelGeos, buildWing, canvasTexture, paint, glass, glowTexture, FusePainter, WingPainter,
} from './modelkit.js';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const DOWN = v3(0, -1, 0);
// parts hidden from the pilot's eye still cast their shadow
const GHOST = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, fog: false });
GHOST.name = 'cockpit-ghost';
const _d = v3(), _q = new THREE.Quaternion();

// ============================================================================ rig

class Rig {
  constructor(def) {
    this.def = def;
    this.group = new THREE.Group();
    this.group.name = 'aircraft-' + def.id;
    this.parts = new Parts();
    this.mats = {};
    this.updaters = [];
    this.devices = [];
    this.cockpit = false;
    this.rules = { flapAngle: 30 * DEG, flapExt: 0, flapDrop: 0, flaperonDroop: 0, elevScale: 1 };
    this.anchors = {
      nozzles: [], wingtips: [], propHubs: [], landingLight: v3(), tailLight: v3(),
      pilotEye: v3(def.view.pilot[0], def.view.pilot[1], def.view.pilot[2]),
    };
    // shared materials
    this.mats.tire = paint(0x1b1b1d, { rough: 0.92, metal: 0 });
    this.mats.wheel = paint(0xffffff, { rough: 0.7, metal: 0.15, map: hubTexture() });
    this.mats.lens = paint(0xdfe6ea, { rough: 0.15, metal: 0.3 });
    this.mats.steel = paint(0xa9afb6, { rough: 0.32, metal: 0.85 });
    this.mats.chrome = paint(0xe6e9ee, { rough: 0.12, metal: 1 });
    this.mats.dark = paint(0x18191c, { rough: 0.7, metal: 0.2 });
    this.mats.black = paint(0x050506, { rough: 0.9, metal: 0 });
    this.mats.rubber = this.mats.tire;
  }

  /** add an individually animated mesh */
  mesh(geo, mat, o = {}) {
    const m = new THREE.Mesh(geo, typeof mat === 'string' ? this.mats[mat] : mat);
    const transparent = m.material.transparent;
    m.castShadow = o.shadow !== false && !transparent;
    m.receiveShadow = !transparent;
    if (o.hide) m.userData.hideInCockpit = true;
    (o.parent || this.group).add(m);
    return m;
  }

  /** wing half / fin: fixed structure goes to the merged bins, devices become hinged meshes */
  wing(spec, matKey, o = {}) {
    const w = buildWing(spec);
    this.parts.add(matKey, w.fixed, { hide: o.hide });
    for (const d of w.devices) {
      const pivot = new THREE.Group();
      pivot.position.copy(d.position); pivot.quaternion.copy(d.quaternion);
      const node = new THREE.Group();
      pivot.add(node);
      this.mesh(d.geo, o.deviceMat || matKey, { parent: node, hide: o.hide });
      this.group.add(pivot);
      d.node = node; d.pivot = pivot;
      if (o.scale) d.scale = o.scale;
      this.devices.push(d);
    }
    return w;
  }

  finish() {
    this.parts.build(this.mats, this.group);
    const rig = this;
    const hidden = [];
    this.group.traverse((o) => { if (o.userData.hideInCockpit) hidden.push(o); });
    return {
      group: this.group,
      anchors: this.anchors,
      update(state, dt) { rig.update(state, dt || 0); },
      setCockpitView(on) {
        on = !!on;
        if (on === rig.cockpit) return;
        rig.cockpit = on;
        for (const o of hidden) {
          if (o.isMesh && o.castShadow) {
            if (on) { o.userData.shownMaterial = o.material; o.material = GHOST; }
            else if (o.userData.shownMaterial) o.material = o.userData.shownMaterial;
          } else o.visible = !on;
        }
      },
    };
  }

  update(st, dt) {
    const s = st.surf, r = this.rules;
    for (const d of this.devices) {
      let a = 0, ext = 0, drop = 0;
      switch (d.type) {
        case 'aileron': a = -s.aileron * d.side + s.flap * r.flaperonDroop; break;
        case 'elevator': a = -s.elevator * r.elevScale; break;
        case 'rudder': a = s.rudder; break;
        case 'flap': a = s.flap * r.flapAngle; ext = s.flap * r.flapExt * d.chord; drop = s.flap * r.flapDrop * d.chord; break;
        default: break;
      }
      d.node.rotation.z = d.sign * a * (d.scale || 1);
      d.node.position.set(-ext, -d.sign * drop, 0);
    }
    for (const u of this.updaters) u(st, dt);
  }
}

// ============================================================================ shared components

let _hubTex = null;
function hubTexture() {
  if (_hubTex) return _hubTex;
  _hubTex = canvasTexture(128, 128, (ctx) => {
    ctx.fillStyle = '#c9ced4'; ctx.fillRect(0, 0, 128, 128);
    ctx.translate(64, 64);
    ctx.fillStyle = '#7d848c';
    for (let i = 0; i < 6; i++) { ctx.rotate(Math.PI / 3); ctx.beginPath(); ctx.ellipse(34, 0, 11, 8, 0, 0, 7); ctx.fill(); }
    ctx.fillStyle = '#5b626a'; ctx.beginPath(); ctx.arc(0, 0, 13, 0, 7); ctx.fill();
    ctx.fillStyle = '#e8ebee'; ctx.beginPath(); ctx.arc(0, 0, 7, 0, 7); ctx.fill();
    ctx.strokeStyle = '#8d949c'; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(0, 0, 58, 0, 7); ctx.stroke();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#1a1a1c'; ctx.fillRect(0, 0, 10, 10);          // tyre rubber texel
  }, { wrapT: THREE.ClampToEdgeWrapping });
  return _hubTex;
}

function makeWheel(rig, r, w, index) {
  const geos = wheelGeos(r, w);
  setUV(geos.tire, 0.02, 0.98);
  const m = rig.mesh(mergeGeos([geos.tire, geos.hub]), 'wheel', { parent: new THREE.Group() });
  const g = m.parent;
  g.userData.wheelIndex = index;
  return g;
}

/**
 * Landing gear leg. o: { index, top, axle (Vector3, wheel-axis midpoint, gear down, uncompressed),
 *   offsets [z...] wheel positions along the axle, radius, width, style 'oleo'|'spring'|'leaf', strutR,
 *   steer (bool), retract {axis, angle}, pants (bool), pantMat, strutMat }
 */
function addGear(rig, o) {
  const root = new THREE.Group();
  root.position.copy(o.top);
  rig.group.add(root);
  const steer = new THREE.Group();
  root.add(steer);
  const rel = o.axle.clone().sub(o.top);
  const len0 = rel.length();
  const sr = o.strutR ?? o.radius * 0.16;
  let outer = null, inner = null;
  if (o.style === 'spring') {
    outer = rig.mesh(unitStrut(sr * 1.25, sr * 0.8, 10), o.strutMat || 'steel', { parent: steer });
  } else if (o.style === 'leaf') {
    outer = rig.mesh(unitStrut(sr, sr * 0.75, 10, [5.5, 1]), o.strutMat || 'steel', { parent: steer });
  } else {
    outer = rig.mesh(unitStrut(sr * 1.3, sr * 1.3, 12), o.strutMat || 'steel', { parent: steer });
    inner = rig.mesh(unitStrut(sr * 0.82, sr * 0.82, 12), 'chrome', { parent: steer });
    // torque links
    const link = rig.mesh(box(sr * 3.2, sr * 0.9, sr * 0.9), 'steel', { parent: steer });
    link.position.set(-sr * 1.6, rel.y * 0.62, 0);
    link.rotation.z = 0.6;
    if (Math.abs(rel.z) > 0.05 || Math.abs(rel.x) > 0.25) link.visible = false;
  }
  const slide = new THREE.Group();
  steer.add(slide);
  const offs = o.offsets || [0];
  const span = Math.max(...offs) - Math.min(...offs);
  if (span > 0) {
    const ax = rig.mesh(tube(v3(0, 0, Math.min(...offs)), v3(0, 0, Math.max(...offs)), o.radius * 0.14, o.radius * 0.14, 10), 'steel', { parent: slide });
    ax.castShadow = false;
  } else if (o.fork) {
    // single-sided fork from the strut end to the wheel
    rig.mesh(tube(v3(0, 0, 0), v3(0, 0, offs[0]), o.radius * 0.13, o.radius * 0.13, 8), 'steel', { parent: slide });
  }
  const wheels = offs.map((z) => { const w = makeWheel(rig, o.radius, o.width, o.index); w.position.set(0, 0, z); slide.add(w); return w; });
  if (o.pants) {
    const p = ellipsoid(o.radius * 1.75, o.radius * 0.82, o.width * 0.95, 18, 12);
    // teardrop: stretch the aft half
    const pa = p.attributes.position;
    for (let i = 0; i < pa.count; i++) { const x = pa.getX(i); if (x < 0) pa.setX(i, x * 1.35); }
    p.computeVertexNormals();
    const pm = rig.mesh(p, o.pantMat || 'white', { parent: slide });
    pm.position.set(-o.radius * 0.1, o.radius * 0.24, offs[0]);
  }
  const place = (comp) => {
    slide.position.set(rel.x, rel.y + comp, rel.z);
    _d.copy(slide.position);
    const len = _d.length();
    _d.multiplyScalar(1 / len);
    outer.quaternion.setFromUnitVectors(DOWN, _d);
    if (inner) {
      outer.scale.y = len0 * 0.56;
      inner.position.copy(slide.position);
      inner.quaternion.setFromUnitVectors(DOWN, _d.negate());
      inner.scale.y = len0 * 0.62;
    } else outer.scale.y = len;
  };
  place(0);
  rig.updaters.push((st) => {
    const g = st.surf.gear ?? 1;
    if (o.retract) {
      root.visible = g > 0.02;
      const k = smooth(1 - g);
      root.quaternion.setFromAxisAngle(o.retract.axis, o.retract.angle * k);
    }
    const w = (st.wheels && st.wheels[o.index]) || null;
    const comp = w && g > 0.98 ? clamp(w.compression || 0, 0, len0 * 0.45) : 0;
    place(comp);
    steer.rotation.y = o.steer && w ? -(w.steer || 0) : 0;
    const ang = w ? -(w.angle || 0) : 0;
    for (const wh of wheels) wh.rotation.z = ang;
  });
  return { root, slide, wheels };
}

let _discTex = {};
function propDiscTexture(blades, tipColor) {
  const key = blades + tipColor;
  if (_discTex[key]) return _discTex[key];
  _discTex[key] = canvasTexture(256, 256, (ctx) => {
    ctx.clearRect(0, 0, 256, 256);
    ctx.translate(128, 128);
    const g = ctx.createRadialGradient(0, 0, 10, 0, 0, 127);
    g.addColorStop(0, 'rgba(40,40,44,0.0)'); g.addColorStop(0.18, 'rgba(40,40,44,0.30)');
    g.addColorStop(0.6, 'rgba(50,50,54,0.20)'); g.addColorStop(0.9, 'rgba(60,60,64,0.24)');
    g.addColorStop(0.945, tipColor); g.addColorStop(0.985, tipColor); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 127, 0, 7); ctx.fill();
    // faint streaks so that the disc visibly turns
    for (let i = 0; i < blades * 2; i++) {
      ctx.rotate(Math.PI / blades);
      const lg = ctx.createLinearGradient(0, -22, 0, 22);
      lg.addColorStop(0, 'rgba(20,20,22,0)'); lg.addColorStop(0.5, i % 2 ? 'rgba(20,20,22,0.16)' : 'rgba(230,230,235,0.07)'); lg.addColorStop(1, 'rgba(20,20,22,0)');
      ctx.fillStyle = lg; ctx.beginPath(); ctx.moveTo(12, -5); ctx.lineTo(118, -22); ctx.lineTo(118, 22); ctx.lineTo(12, 5); ctx.fill();
    }
  }, { wrapT: THREE.ClampToEdgeWrapping });
  return _discTex[key];
}

/** twisted propeller blade along +Y; rotation axis X, turning clockwise seen from behind */
function bladeGeo(R, cMax, beta75 = 24 * DEG) {
  const rings = [];
  const stations = 9, pts = 10;
  for (let i = 0; i <= stations; i++) {
    const x = 0.14 + (1 - 0.14) * i / stations;
    const r = x * R;
    let c = cMax * R * (1 - 1.5 * (x - 0.42) * (x - 0.42));
    if (x < 0.25) c *= 0.45 + 0.55 * (x - 0.14) / 0.11;
    if (i === stations) c *= 0.35;
    else if (i === stations - 1) c *= 0.8;
    const th = Math.atan(0.75 * Math.tan(beta75) / x);
    const tk = c * lerp(0.26, 0.07, Math.min(1, (x - 0.14) / 0.6));
    const ring = [];
    for (let k = 0; k < pts; k++) {
      const a = 2 * Math.PI * k / pts;
      const u = Math.cos(a) * 0.5 * c;                // along the chord (leading edge +)
      const w = Math.sin(a) * 0.5 * tk * (1 - 0.35 * Math.cos(a));
      // chord direction: forward (X) by sin(theta), tangential (Z) by cos(theta)
      ring.push(v3(u * Math.sin(th) + w * Math.cos(th), r, u * Math.cos(th) - w * Math.sin(th)));
    }
    rings.push(ring);
  }
  return ringLoft(rings, { closed: true, capEnd: true });
}

/** o: { pos, diameter, blades, spinnerLen, spinnerR, engine (index), bladeMat, spinnerMat, tip } */
function addProp(rig, o) {
  const R = o.diameter / 2;
  const hub = new THREE.Group();
  hub.position.copy(o.pos);
  rig.group.add(hub);
  // spinner (ogive)
  const prof = [];
  const x0 = -o.spinnerR * 0.25;
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    prof.push([x0 + o.spinnerLen * t, o.spinnerR * Math.pow(Math.max(0, 1 - t * t), 0.62)]);
  }
  prof.unshift([x0 - 0.02, o.spinnerR * 0.96]);
  rig.mesh(lathe(prof.reverse(), 20, { capEnd: true }), o.spinnerMat, { parent: hub });
  const geos = [];
  for (let b = 0; b < o.blades; b++) {
    const g = bladeGeo(R, o.cMax ?? 0.15);
    g.rotateX(2 * Math.PI * b / o.blades);
    geos.push(g);
  }
  const bladeMat = rig.mats[o.bladeMat].clone();
  bladeMat.transparent = true;
  const blades = new THREE.Mesh(geos.length === 1 ? geos[0] : mergeList(geos), bladeMat);
  blades.castShadow = true;
  hub.add(blades);
  const discGeo = new THREE.CircleGeometry(R, 48);
  discGeo.rotateY(Math.PI / 2);
  const discMat = new THREE.MeshBasicMaterial({
    map: propDiscTexture(o.blades, o.tip || 'rgba(235,205,90,0.2)'), transparent: true, opacity: 0, depthWrite: false,
    side: THREE.DoubleSide, fog: false,
  });
  const disc = new THREE.Mesh(discGeo, discMat);
  disc.renderOrder = 5;
  disc.position.x = 0.02;
  hub.add(disc);
  let angle = 0.6, discAngle = 0;
  rig.updaters.push((st, dt) => {
    const e = (st.engines && st.engines[o.engine || 0]) || {};
    const rpm = e.rpm || 0;
    angle += rpm * (2 * Math.PI / 60) * dt;
    if (angle > 1e4) angle -= 1e4 * Math.floor(angle / 1e4);
    blades.rotation.x = angle;
    const k = clamp((rpm - 320) / 700, 0, 1);
    bladeMat.opacity = 1 - 0.93 * k;
    blades.visible = k < 0.999 || true;
    blades.castShadow = k < 0.5;
    bladeMat.depthWrite = k < 0.4;
    discMat.opacity = smooth(k) * 0.7;
    disc.visible = k > 0.01;
    discAngle += (2.2 + rpm * 0.0006) * dt;
    disc.rotation.x = discAngle;
  });
  rig.anchors.propHubs.push(o.pos.clone());
  return hub;
}

function mergeList(list) { return mergeGeos(list); }

/** lamp lens (static) + additive halo sprite that lights up. kind: nav | strobe | beacon | landing */
function addLamp(rig, pos, color, kind, size = 0.045, noLens = false) {
  if (!noLens) rig.parts.add('lens', tx(new THREE.SphereGeometry(size, 8, 6), { p: [pos.x, pos.y, pos.z] }));
  const sm = new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0, fog: false });
  const sp = new THREE.Sprite(sm);
  const base = kind === 'nav' ? size * 11 : kind === 'landing' ? size * 16 : size * 26;
  sp.scale.setScalar(base);
  sp.position.copy(pos);
  sp.renderOrder = 6;
  sp.visible = false;
  rig.group.add(sp);
  const phase = (pos.z > 0 ? 0.02 : 0) + (pos.y < 0 ? 0.5 : 0);
  rig.updaters.push((st) => {
    const L = st.lights || {};
    const t = (st.time || 0) + phase;
    let k = 0;
    if (kind === 'nav') k = L.nav ? 1 : 0;
    else if (kind === 'landing') k = L.landing && (st.surf.gear ?? 1) > 0.9 ? 1 : 0;
    else if (kind === 'strobe') { const f = t % 1.1; k = L.strobe && (f < 0.05 || (f > 0.14 && f < 0.19)) ? 1 : 0; }
    else if (kind === 'beacon') { const f = t % 1.25; k = L.beacon ? Math.max(0, 1 - Math.abs(f - 0.12) / 0.12) : 0; }
    sm.opacity = k * (kind === 'nav' ? 0.9 : 1);
    sp.visible = k > 0.01;
  });
  return sp;
}

function addPilot(rig, pos, suit = 0x3d4a35, helmet = 0xe9e9e4) {
  if (!rig.mats.suit) {
    rig.mats.suit = paint(suit, { rough: 0.85, metal: 0 });
    rig.mats.helmet = paint(helmet, { rough: 0.3, metal: 0.1 });
    rig.mats.visor = paint(0x101418, { rough: 0.08, metal: 0.9 });
  }
  const P = rig.parts, o = { hide: true };
  P.add('helmet', tx(ellipsoid(0.125, 0.135, 0.12, 14, 10), { p: [pos.x, pos.y, pos.z] }), o);
  P.add('visor', tx(ellipsoid(0.085, 0.07, 0.105, 12, 8), { p: [pos.x + 0.06, pos.y + 0.01, pos.z] }), o);
  P.add('suit', tx(ellipsoid(0.17, 0.27, 0.22, 12, 8), { p: [pos.x - 0.05, pos.y - 0.36, pos.z] }), o);
  P.add('suit', tx(ellipsoid(0.07, 0.07, 0.25, 8, 6), { p: [pos.x - 0.03, pos.y - 0.2, pos.z] }), o);
}

function tipAnchors(rig, wR, wL, s = 0.75) {
  rig.anchors.wingtips = [wL.pt(1, s, 0), wR.pt(1, s, 0)];
}

// ============================================================================ Kestrel 180 (trainer)

function buildTrainer(def) {
  const rig = new Rig(def);
  const P = rig.parts, M = rig.mats;
  const C = { white: '#f3f3ee', blue: '#1d4f91', navy: '#12305c', red: '#d6452a', glassA: '#182330', glassB: '#3b5266' };

  // ---- fuselage
  const SPLIT = 0.86;
  const keys = [
    { x: 1.76, top: 0.21, bot: -0.31, w: 0.30, n: 3.0, mid: -0.05 },
    { x: 1.69, top: 0.31, bot: -0.41, w: 0.44, n: 3.2, mid: -0.05 },
    { x: 1.50, top: 0.36, bot: -0.47, w: 0.50, n: 3.2, mid: -0.06 },
    { x: 0.95, top: 0.42, bot: -0.60, w: 0.56, n: 3.0, mid: -0.08 },
    { x: 0.80, top: 0.46, bot: -0.64, w: 0.57, n: 3.0, mid: -0.08 },
    { x: 0.42, top: 0.93, bot: -0.70, w: 0.59, n: 3.2, mid: -0.06 },
    { x: 0.20, top: 0.98, bot: -0.72, w: 0.60, n: 3.4, mid: -0.05 },
    { x: -0.70, top: 0.98, bot: -0.72, w: 0.59, n: 3.4, mid: -0.05 },
    { x: -1.25, top: 0.93, bot: -0.68, w: 0.55, n: 3.2, mid: -0.03 },
    { x: -1.90, top: 0.64, bot: -0.52, w: 0.42, n: 2.8, mid: 0.0 },
    { x: -2.80, top: 0.42, bot: -0.32, w: 0.27, n: 2.5, mid: 0.04 },
    { x: -3.80, top: 0.31, bot: -0.14, w: 0.15, n: 2.4, mid: 0.085 },
    { x: -4.70, top: 0.26, bot: 0.0, w: 0.07, n: 2.4, mid: 0.13 },
    { x: -5.12, top: 0.21, bot: 0.07, w: 0.025, n: 2.2, mid: 0.14 },
  ];
  const st = smoothStations(keys, 0.11, [SPLIT]);
  const U0 = 1.76, UL = 1.76 + 5.12;
  const TW = 2048, TH = 512;
  const fp = new FusePainter(st, TW, TH, U0, UL);
  const stripe = (x) => (x > -1.4 ? -0.16 - 0.03 * (x - 0.2) : -0.112 + (x + 1.4) * -0.07);
  const sillF = (x) => 0.47 + 0.02 * (0.8 - x);
  const fuseTex = canvasTexture(TW, TH, (ctx) => {
    ctx.fillStyle = C.white; ctx.fillRect(0, 0, TW, TH);
    // lower fuselage colour and pin stripes
    ctx.fillStyle = C.blue; fp.underBelly(ctx, 1.76, -5.12, stripe); ctx.fill();
    for (const side of [1, -1]) {
      ctx.fillStyle = C.red; fp.band(ctx, side, 1.76, -5.12, (x) => stripe(x) + 0.035, (x) => stripe(x) + 0.085); ctx.fill();
      ctx.fillStyle = C.navy; fp.band(ctx, side, 1.76, -5.12, (x) => stripe(x) + 0.115, (x) => stripe(x) + 0.135); ctx.fill();
    }
    // glazing
    const gl = ctx.createLinearGradient(0, 0, 0, TH);
    gl.addColorStop(0, C.glassA); gl.addColorStop(0.25, C.glassB); gl.addColorStop(0.5, C.glassA); gl.addColorStop(0.75, C.glassB); gl.addColorStop(1, C.glassA);
    ctx.fillStyle = gl;
    fp.overTop(ctx, 0.79, 0.45, sillF); ctx.fill();                                    // windshield
    fp.overTop(ctx, -1.3, -1.86, (x) => 0.5 + (x + 1.86) * 0.1); ctx.fill();            // rear window
    for (const side of [1, -1]) {
      fp.poly(ctx, [[0.36, 0.42], [0.30, 0.86], [-0.36, 0.88], [-0.36, 0.40]], side); ctx.fill();
      fp.poly(ctx, [[-0.46, 0.40], [-0.46, 0.88], [-1.1, 0.84], [-1.2, 0.42]], side); ctx.fill();
      // window frames and door outline
      ctx.strokeStyle = '#d9d9d3'; ctx.lineWidth = 5; ctx.lineJoin = 'round';
      fp.poly(ctx, [[0.36, 0.42], [0.30, 0.86], [-0.36, 0.88], [-0.36, 0.40]], side); ctx.stroke();
      fp.poly(ctx, [[-0.46, 0.40], [-0.46, 0.88], [-1.1, 0.84], [-1.2, 0.42]], side); ctx.stroke();
      ctx.strokeStyle = 'rgba(60,65,72,0.55)'; ctx.lineWidth = 2;
      fp.poly(ctx, [[0.44, -0.52], [0.40, 0.92], [-0.41, 0.94], [-0.41, -0.54]], side); ctx.stroke();
      fp.text(ctx, 'K-180SW', -2.85, 0.16, side, 0.2, 'bold 100px Arial, Helvetica, sans-serif', C.navy, 0.18);
    }
    // cowling seams
    ctx.strokeStyle = 'rgba(70,75,82,0.5)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(fp.X(SPLIT), 0); ctx.lineTo(fp.X(SPLIT), TH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(fp.X(1.74), TH * 0.5); ctx.lineTo(fp.X(SPLIT), TH * 0.5); ctx.stroke();
  });
  M.fuse = paint(0xffffff, { map: fuseTex, rough: 0.36, metal: 0.05 });
  const iSplit = st.findIndex((s) => Math.abs(s.x - SPLIT) < 1e-6);
  const lo = { uOrigin: U0, uLength: UL, seg: 32 };
  P.add('fuse', loft(st.slice(0, iSplit + 1), { ...lo, capStart: true, capStartUV: [(U0 - 1.2) / UL, fp.v(1.2, 0.25, 1)] }));
  P.add('fuse', loft(st.slice(iSplit), lo), { hide: true });
  // firewall / instrument panel bulkhead, visible from the cockpit only
  P.add('dark', loft([{ ...st[iSplit], x: SPLIT + 0.001 }, { ...st[iSplit], x: SPLIT - 0.004 }], { seg: 32, capEnd: true }));
  // cooling inlets and landing light recess on the cowl face
  for (const z of [-0.2, 0.2]) P.add('black', tx(ellipsoid(0.012, 0.085, 0.11, 10, 8), { p: [1.765, 0.02, z] }));
  P.add('black', tx(ellipsoid(0.012, 0.05, 0.13, 10, 8), { p: [1.763, -0.2, 0] }));
  // exhaust stack
  P.add('steel', tube(v3(1.25, -0.5, 0.2), v3(1.05, -0.66, 0.22), 0.035, 0.035, 10));

  // ---- flying surfaces
  const wingTex = canvasTexture(1024, 256, (ctx, W, H) => {
    const wp = new WingPainter(W, H);
    ctx.fillStyle = C.white; ctx.fillRect(0, 0, W, H);
    for (const up of [true, false]) {
      ctx.fillStyle = C.blue; wp.rect(ctx, 0.93, 1.1, 0, 1, up);
      ctx.fillStyle = C.red; wp.rect(ctx, 0.905, 0.922, 0, 1, up);
    }
    ctx.fillStyle = '#9aa0a6';
    for (const e of [0.2, 0.3]) { ctx.beginPath(); ctx.arc(wp.X(e), wp.Y(0.32, true), 5, 0, 7); ctx.fill(); }
    // wing walk / hinge shadow lines
    ctx.fillStyle = 'rgba(40,44,50,0.35)'; wp.rect(ctx, 0.08, 0.96, 0.722, 0.728, true); wp.rect(ctx, 0.08, 0.96, 0.722, 0.728, false);
  }, { wrapT: THREE.ClampToEdgeWrapping });
  M.wing = paint(0xffffff, { map: wingTex, rough: 0.36, metal: 0.05 });
  const wd = def.surfaces[0];
  const wingSpec = (side) => ({
    rootLE: wd.rootLE, semiSpan: wd.semiSpan, rootChord: wd.rootChord, tipChord: wd.tipChord, sweepLE: wd.sweepLE,
    dihedral: 1.7, incidence: wd.incidence, twist: wd.twist, tcRoot: 0.12, tcTip: 0.12, camber: 0.02, side,
    panels: [
      { from: 0, to: 0.08 },
      { from: 0.08, to: 0.5, cut: 0.72, type: 'flap' },
      { from: 0.5, to: 0.96, cut: 0.75, type: 'aileron' },
      { from: 0.96, to: 1 },
    ],
  });
  const wR = rig.wing(wingSpec(1), 'wing'), wL = rig.wing(wingSpec(-1), 'wing');
  tipAnchors(rig, wR, wL);
  rig.rules.flapAngle = 30 * DEG; rig.rules.flapExt = 0.22; rig.rules.flapDrop = 0.06;
  const hd = def.surfaces[1];
  const stabSpec = (side) => ({
    rootLE: hd.rootLE, semiSpan: hd.semiSpan, rootChord: hd.rootChord, tipChord: hd.tipChord, sweepLE: hd.sweepLE,
    incidence: hd.incidence, tcRoot: 0.09, tcTip: 0.09, side, chordSegs: 9,
    panels: [{ from: 0, to: 0.06 }, { from: 0.06, to: 0.95, cut: 0.58, type: 'elevator' }, { from: 0.95, to: 1 }],
  });
  rig.wing(stabSpec(1), 'wing'); rig.wing(stabSpec(-1), 'wing');
  const vd = def.surfaces[2];
  const finTex = canvasTexture(256, 256, (ctx, W, H) => {
    const wp = new WingPainter(W, H);
    ctx.fillStyle = C.white; ctx.fillRect(0, 0, W, H);
    for (const up of [true, false]) {
      ctx.fillStyle = C.blue; wp.poly(ctx, [[0.42, 0], [1.1, 0], [1.1, 1], [0.72, 1]], up); ctx.fill();
      ctx.fillStyle = C.red; wp.poly(ctx, [[0.34, 0], [0.38, 0], [0.68, 1], [0.64, 1]], up); ctx.fill();
    }
  }, { wrapT: THREE.ClampToEdgeWrapping });
  M.fin = paint(0xffffff, { map: finTex, rough: 0.36, metal: 0.05 });
  const fin = rig.wing({
    rootLE: vd.rootLE, semiSpan: vd.semiSpan, rootChord: vd.rootChord, tipChord: vd.tipChord, sweepLE: vd.sweepLE,
    tcRoot: 0.09, tcTip: 0.09, vertical: true, chordSegs: 9,
    panels: [{ from: 0, to: 0.04 }, { from: 0.04, to: 0.95, cut: 0.6, type: 'rudder' }, { from: 0.95, to: 1 }],
  }, 'fin');
  // dorsal fillet
  P.add('fuse_plain', plateXY([[-2.6, 0.4], [-3.72, 0.3], [-4.05, 0.72]], 0.035, 0.01));
  M.fuse_plain = paint(0xf3f3ee, { rough: 0.36, metal: 0.05 });

  // wing struts (streamlined tubes)
  for (const w of [wR, wL]) {
    const s = w.side;
    P.add('fuse_plain', tube(v3(0.28, -0.52, s * 0.57), w.pt(0.43, 0.32, -1), 0.022, 0.02, 10, { flat: [3.4, 1] }));
  }
  // antennas, pitot, tail tie-down
  P.add('fuse_plain', plateXY([[-0.25, 1.0], [-0.42, 1.0], [-0.52, 1.32], [-0.46, 1.32]], 0.012));
  P.add('fuse_plain', plateXY([[-0.95, 0.98], [-1.1, 0.98], [-1.18, 1.24], [-1.13, 1.24]], 0.012));
  const pit = wL.pt(0.42, 0.2, -1);
  P.add('steel', tube(pit, pit.clone().add(v3(0, -0.1, 0)), 0.008, 0.008, 6));
  P.add('steel', tube(pit.clone().add(v3(0, -0.1, 0)), pit.clone().add(v3(0.22, -0.1, 0)), 0.008, 0.006, 6));

  // ---- propeller, gear, lights
  const e = def.engines[0];
  M.blade = paint(0x1c1d20, { rough: 0.45, metal: 0.3 });
  M.spinner = paint(0xf0f0ec, { rough: 0.25, metal: 0.25 });
  addProp(rig, { pos: v3(e.pos[0], e.pos[1], e.pos[2]), diameter: e.prop.diameter, blades: e.prop.blades, spinnerLen: 0.34, spinnerR: 0.17, bladeMat: 'blade', spinnerMat: 'spinner', cMax: 0.16 });
  const g = def.gear;
  addGear(rig, { index: 0, top: v3(g[0].pos[0] + 0.05, -0.47, 0), axle: v3(g[0].pos[0], g[0].pos[1] + g[0].radius, 0), offsets: [0], radius: g[0].radius, width: 0.115, style: 'oleo', strutR: 0.026, steer: true });
  for (const i of [1, 2]) {
    const s = Math.sign(g[i].pos[2]);
    addGear(rig, {
      index: i, top: v3(g[i].pos[0] + 0.06, -0.6, s * 0.5), axle: v3(g[i].pos[0], g[i].pos[1] + g[i].radius, s * (Math.abs(g[i].pos[2]) - 0.1)),
      offsets: [s * 0.1], radius: g[i].radius, width: 0.15, style: 'spring', strutR: 0.03, strutMat: 'fuse_plain', fork: true,
    });
  }
  addLamp(rig, wL.pt(1.005, 0.2, 0), 0xff2a1a, 'nav');
  addLamp(rig, wR.pt(1.005, 0.2, 0), 0x18ff5a, 'nav');
  addLamp(rig, wL.pt(1.005, 0.5, 0), 0xffffff, 'strobe', 0.035);
  addLamp(rig, wR.pt(1.005, 0.5, 0), 0xffffff, 'strobe', 0.035);
  addLamp(rig, fin.pt(1.0, 0.3, 0).add(v3(0, 0.05, 0)), 0xff2020, 'beacon');
  rig.anchors.tailLight.set(-5.14, 0.15, 0);
  addLamp(rig, rig.anchors.tailLight, 0xffffff, 'nav', 0.03);
  rig.anchors.landingLight.set(1.775, -0.2, 0);
  addLamp(rig, rig.anchors.landingLight, 0xfff4d6, 'landing', 0.05);
  rig.anchors.nozzles.push(v3(1.03, -0.68, 0.22));
  return rig.finish();
}

/** hinged upper-surface panel (spoiler / speed brake) on a wing built by rig.wing() */
function addSpoilerPanel(rig, w, e0, e1, s0, s1, matKey, maxAngle = 45 * DEG) {
  const A = w.pt(e0, s0, 1), B = w.pt(e1, s0, 1), C0 = w.pt(e0, s1, 1);
  const zA = B.clone().sub(A).normalize();
  const len = C0.distanceTo(A), L = B.distanceTo(A);
  const xA = A.clone().sub(C0); xA.addScaledVector(zA, -xA.dot(zA)).normalize();
  const yA = v3().crossVectors(zA, xA);
  const up = yA.y >= 0 ? 1 : -1;
  const g = box(len, 0.03, L * 0.985);
  g.translate(-len / 2, up * 0.012, L / 2);
  const pivot = new THREE.Group();
  pivot.position.copy(A);
  pivot.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xA, yA, zA));
  const m = rig.mesh(g, matKey, { parent: pivot });
  rig.group.add(pivot);
  rig.updaters.push((st) => { m.rotation.z = -up * maxAngle * (st.surf.spoiler || 0); });
}

/** body-frame geometry turning about an arbitrary axis through `pivot`; returns setAngle(rad) */
function addMovable(rig, geo, matKey, pivot, axis, o = {}) {
  const g = new THREE.Group();
  g.position.copy(pivot);
  geo.translate(-pivot.x, -pivot.y, -pivot.z);
  rig.mesh(geo, matKey, { parent: g, hide: o.hide });
  rig.group.add(g);
  const ax = axis.clone().normalize();
  return (angle) => g.quaternion.setFromAxisAngle(ax, angle);
}

// ============================================================================ Vortex 330 (aerobat)

function buildAerobat(def) {
  const rig = new Rig(def);
  const P = rig.parts, M = rig.mats;
  const C = { red: '#c41f1b', dred: '#8e1512', white: '#f5f5f1', black: '#131315', gold: '#e9b528' };
  const keys = [
    { x: 1.78, top: 0.24, bot: -0.27, w: 0.30, n: 2.5, mid: -0.02 },
    { x: 1.68, top: 0.36, bot: -0.40, w: 0.43, n: 2.6, mid: -0.03 },
    { x: 1.30, top: 0.42, bot: -0.50, w: 0.47, n: 2.6, mid: -0.05 },
    { x: 0.90, top: 0.44, bot: -0.56, w: 0.46, n: 2.6, mid: -0.06 },
    { x: 0.40, top: 0.44, bot: -0.60, w: 0.45, n: 2.6, mid: -0.08 },
    { x: -0.40, top: 0.42, bot: -0.58, w: 0.44, n: 2.6, mid: -0.08 },
    { x: -1.40, top: 0.46, bot: -0.50, w: 0.40, n: 2.5, mid: -0.03 },
    { x: -2.40, top: 0.38, bot: -0.36, w: 0.30, n: 2.4, mid: 0.0 },
    { x: -3.40, top: 0.30, bot: -0.22, w: 0.19, n: 2.4, mid: 0.04 },
    { x: -4.40, top: 0.25, bot: -0.08, w: 0.08, n: 2.3, mid: 0.085 },
    { x: -4.97, top: 0.2, bot: 0.0, w: 0.03, n: 2.2, mid: 0.1 },
  ];
  const st = smoothStations(keys, 0.11);
  const U0 = 1.78, UL = 1.78 + 4.97, TW = 2048, TH = 512;
  const fp = new FusePainter(st, TW, TH, U0, UL);
  const tOf = (x) => (U0 - x) / UL;
  const yc = (x) => -0.24 + 0.44 * Math.pow(tOf(x), 1.25);
  const hw = (x) => 0.15 * Math.pow(1 - tOf(x), 0.8) + 0.018;
  const fuseTex = canvasTexture(TW, TH, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, TW, 0);
    g.addColorStop(0, C.red); g.addColorStop(1, C.dred);
    ctx.fillStyle = g; ctx.fillRect(0, 0, TW, TH);
    for (const side of [1, -1]) {
      ctx.fillStyle = C.black; fp.band(ctx, side, 1.78, -4.97, (x) => yc(x) - hw(x) - 0.03, (x) => yc(x) + hw(x) + 0.03, 60); ctx.fill();
      ctx.fillStyle = C.white; fp.band(ctx, side, 1.78, -4.97, (x) => yc(x) - hw(x), (x) => yc(x) + hw(x), 60); ctx.fill();
      ctx.fillStyle = C.gold; fp.band(ctx, side, 1.5, -4.97, (x) => yc(x) + hw(x) + 0.06, (x) => yc(x) + hw(x) + 0.085, 60); ctx.fill();
      fp.text(ctx, 'VORTEX', -0.55, 0.19, side, 0.19, 'italic bold 100px Arial, Helvetica, sans-serif', C.white, 0);
      fp.text(ctx, '330', 1.25, 0.16, side, 0.22, 'italic bold 100px Arial, Helvetica, sans-serif', C.gold, 0);
    }
    // cockpit tub under the canopy
    ctx.fillStyle = '#17181b'; fp.overTop(ctx, 0.42, -1.5, () => 0.37); ctx.fill();
  });
  M.fuse = paint(0xffffff, { map: fuseTex, rough: 0.3, metal: 0.08 });
  M.red = paint(0xc41f1b, { rough: 0.3, metal: 0.08 });
  M.white = paint(0xf5f5f1, { rough: 0.3, metal: 0.08 });
  P.add('fuse', loft(st, { uOrigin: U0, uLength: UL, seg: 32, capStart: true, capStartUV: [0.02, fp.v(1.7, 0.3, 1)] }));
  for (const z of [-0.19, 0.19]) P.add('black', tx(ellipsoid(0.012, 0.075, 0.1, 10, 8), { p: [1.785, 0.03, z] }));
  for (const z of [-0.2, 0.2]) P.add('steel', tube(v3(1.2, -0.5, z), v3(0.98, -0.6, z), 0.03, 0.03, 10));

  // canopy and pilot
  const cst = smoothStations([
    { x: 0.46, top: 0.47, bot: 0.4, w: 0.09, mid: 0.41, n: 2 },
    { x: 0.22, top: 0.70, bot: 0.38, w: 0.29, mid: 0.4, n: 2 },
    { x: -0.10, top: 0.88, bot: 0.38, w: 0.36, mid: 0.4, n: 2 },
    { x: -0.42, top: 0.95, bot: 0.37, w: 0.38, mid: 0.39, n: 2 },
    { x: -0.90, top: 0.90, bot: 0.38, w: 0.36, mid: 0.4, n: 2 },
    { x: -1.30, top: 0.71, bot: 0.4, w: 0.28, mid: 0.42, n: 2 },
    { x: -1.58, top: 0.50, bot: 0.42, w: 0.11, mid: 0.44, n: 2 },
  ], 0.08);
  M.glass = glass(0x1b2a38, 0.4);
  rig.mesh(loft(cst, { seg: 24 }), 'glass', { hide: true }).renderOrder = 4;
  addPilot(rig, v3(-0.6, 0.72, 0), 0x25324a, 0xf2f2ee);
  P.add('dark', tx(box(0.08, 0.5, 0.42), { p: [-0.88, 0.5, 0] }), { hide: true });

  // flying surfaces
  const wingTex = canvasTexture(1024, 512, (ctx, W, H) => {
    const wp = new WingPainter(W, H);
    ctx.fillStyle = C.red; ctx.fillRect(0, 0, W, H);
    // sunburst on top
    ctx.fillStyle = C.white;
    for (const [a, b] of [[0.0, 0.1], [0.24, 0.38], [0.55, 0.7], [0.88, 1.0]]) { wp.poly(ctx, [[-0.08, 0.45], [1.05, a], [1.05, b]], true); ctx.fill(); }
    ctx.fillStyle = C.black;
    for (const [a, b] of [[0.1, 0.125], [0.38, 0.405], [0.7, 0.725]]) { wp.poly(ctx, [[-0.08, 0.45], [1.05, a], [1.05, b]], true); ctx.fill(); }
    // checkerboard underneath
    ctx.fillStyle = C.white; wp.rect(ctx, 0, 1.1, 0, 1, false);
    ctx.fillStyle = C.black;
    const de = 0.07;
    for (let i = 0; i < 16; i++) for (let j = 0; j < 4; j++) if ((i + j) % 2 === 0) wp.rect(ctx, 0.3 + i * de, 0.3 + (i + 1) * de, j * 0.25, (j + 1) * 0.25, false);
    ctx.fillStyle = C.red; wp.rect(ctx, 0, 0.3, 0, 1, false);
  }, { wrapT: THREE.ClampToEdgeWrapping });
  M.wing = paint(0xffffff, { map: wingTex, rough: 0.3, metal: 0.08 });
  const wd = def.surfaces[0];
  const wingSpec = (side) => ({
    rootLE: wd.rootLE, semiSpan: wd.semiSpan, rootChord: wd.rootChord, tipChord: wd.tipChord, sweepLE: wd.sweepLE,
    dihedral: wd.dihedral, incidence: 0, twist: 0, tcRoot: 0.16, tcTip: 0.12, camber: 0, side,
    panels: [{ from: 0, to: 0.14 }, { from: 0.14, to: 0.98, cut: 0.7, type: 'aileron' }, { from: 0.98, to: 1 }],
  });
  const wR = rig.wing(wingSpec(1), 'wing'), wL = rig.wing(wingSpec(-1), 'wing');
  tipAnchors(rig, wR, wL, 0.9);
  const hd = def.surfaces[1];
  const stabSpec = (side) => ({
    rootLE: hd.rootLE, semiSpan: hd.semiSpan, rootChord: hd.rootChord, tipChord: hd.tipChord, sweepLE: hd.sweepLE,
    tcRoot: 0.1, tcTip: 0.09, side, chordSegs: 9,
    panels: [{ from: 0, to: 0.07 }, { from: 0.07, to: 0.95, cut: 0.5, type: 'elevator' }, { from: 0.95, to: 1 }],
  });
  rig.wing(stabSpec(1), 'wing'); rig.wing(stabSpec(-1), 'wing');
  const vd = def.surfaces[2];
  const finTex = canvasTexture(256, 256, (ctx, W, H) => {
    const wp = new WingPainter(W, H);
    ctx.fillStyle = C.red; ctx.fillRect(0, 0, W, H);
    for (const up of [true, false]) {
      ctx.fillStyle = C.white;
      for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) if ((i + j) % 2 === 0) wp.rect(ctx, i * 0.125, (i + 1) * 0.125, 0.5 + j * 0.125, 0.5 + (j + 1) * 0.125, up);
      ctx.fillStyle = C.black;
      for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) if ((i + j) % 2 === 1) wp.rect(ctx, i * 0.125, (i + 1) * 0.125, 0.5 + j * 0.125, 0.5 + (j + 1) * 0.125, up);
      ctx.fillStyle = C.gold; wp.rect(ctx, 0, 1.1, 0.455, 0.49, up);
    }
  }, { wrapT: THREE.ClampToEdgeWrapping });
  M.fin = paint(0xffffff, { map: finTex, rough: 0.3, metal: 0.08 });
  const fin = rig.wing({
    rootLE: vd.rootLE, semiSpan: vd.semiSpan, rootChord: vd.rootChord, tipChord: vd.tipChord, sweepLE: vd.sweepLE,
    tcRoot: 0.1, tcTip: 0.09, vertical: true, chordSegs: 9,
    panels: [{ from: 0, to: 0.05 }, { from: 0.05, to: 0.95, cut: 0.5, type: 'rudder' }, { from: 0.95, to: 1 }],
  }, 'fin');

  // propeller, gear, lights
  const e = def.engines[0];
  M.blade = paint(0x202124, { rough: 0.4, metal: 0.35 });
  M.spinner = paint(0xc41f1b, { rough: 0.22, metal: 0.3 });
  addProp(rig, { pos: v3(e.pos[0], e.pos[1], e.pos[2]), diameter: e.prop.diameter, blades: e.prop.blades, spinnerLen: 0.44, spinnerR: 0.2, bladeMat: 'blade', spinnerMat: 'spinner', cMax: 0.15, tip: 'rgba(240,240,240,0.2)' });
  const g = def.gear;
  for (const i of [0, 1]) {
    const s = Math.sign(g[i].pos[2]);
    addGear(rig, {
      index: i, top: v3(g[i].pos[0], -0.5, s * 0.3), axle: v3(g[i].pos[0], g[i].pos[1] + g[i].radius, s * (Math.abs(g[i].pos[2]) - 0.09)),
      offsets: [s * 0.09], radius: g[i].radius, width: 0.13, style: 'leaf', strutR: 0.012, strutMat: 'white', pants: true, pantMat: 'red', fork: true,
    });
  }
  addGear(rig, { index: 2, top: v3(g[2].pos[0] + 0.2, -0.1, 0), axle: v3(g[2].pos[0], g[2].pos[1] + g[2].radius, 0), offsets: [0], radius: g[2].radius, width: 0.05, style: 'spring', strutR: 0.012, steer: true });
  addLamp(rig, wL.pt(1.01, 0.25, 0), 0xff2a1a, 'nav', 0.035);
  addLamp(rig, wR.pt(1.01, 0.25, 0), 0x18ff5a, 'nav', 0.035);
  addLamp(rig, wL.pt(1.01, 0.55, 0), 0xffffff, 'strobe', 0.03);
  addLamp(rig, wR.pt(1.01, 0.55, 0), 0xffffff, 'strobe', 0.03);
  addLamp(rig, fin.pt(1.0, 0.35, 0).add(v3(0, 0.05, 0)), 0xff2020, 'beacon', 0.035);
  rig.anchors.tailLight.set(-4.99, 0.12, 0);
  addLamp(rig, rig.anchors.tailLight, 0xffffff, 'nav', 0.028);
  rig.anchors.landingLight.set(1.79, -0.2, 0);
  addLamp(rig, rig.anchors.landingLight, 0xfff4d6, 'landing', 0.045);
  rig.anchors.nozzles.push(v3(0.96, -0.61, -0.2), v3(0.96, -0.61, 0.2));
  return rig.finish();
}

// ============================================================================ F-21 Peregrine (fighter)

let _flameTex = null;
function flameTexture() {
  if (_flameTex) return _flameTex;
  _flameTex = canvasTexture(64, 256, (ctx) => {
    // v = 1 (canvas top) at the nozzle, v = 0 at the flame tip
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, 'rgba(190,210,255,0.9)'); g.addColorStop(0.1, 'rgba(255,215,160,0.8)');
    g.addColorStop(0.4, 'rgba(255,125,50,0.5)'); g.addColorStop(0.75, 'rgba(215,70,40,0.2)'); g.addColorStop(1, 'rgba(120,40,40,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 256);
    // shock diamonds
    for (let i = 0; i < 6; i++) {
      const y = 22 + i * 30, a = 0.5 * (1 - i / 6.5);
      const d = ctx.createLinearGradient(0, y - 9, 0, y + 9);
      d.addColorStop(0, 'rgba(255,255,255,0)'); d.addColorStop(0.5, `rgba(255,235,200,${a})`); d.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = d; ctx.fillRect(0, y - 9, 64, 18);
    }
  }, { wrapT: THREE.ClampToEdgeWrapping });
  return _flameTex;
}

function buildFighter(def) {
  const rig = new Rig(def);
  const P = rig.parts, M = rig.mats;
  const C = { base: '#8a929a', dark: '#69727b', radome: '#5b6269', glare: '#3b4046', tub: '#18191c', low: '#a0a7ad' };
  const keys = [
    { x: 7.32, top: -0.14, bot: -0.16, w: 0.01, n: 2, mid: -0.15 },
    { x: 7.0, top: -0.03, bot: -0.27, w: 0.115, n: 2, mid: -0.15 },
    { x: 6.4, top: 0.13, bot: -0.39, w: 0.26, n: 2, mid: -0.13 },
    { x: 5.6, top: 0.29, bot: -0.49, w: 0.40, n: 2.1, mid: -0.1 },
    { x: 4.8, top: 0.43, bot: -0.57, w: 0.50, n: 2.2, mid: -0.06 },
    { x: 4.0, top: 0.52, bot: -0.62, w: 0.58, n: 2.3, mid: -0.02 },
    { x: 3.2, top: 0.58, bot: -0.64, w: 0.66, n: 2.4, mid: 0.0 },
    { x: 2.4, top: 0.70, bot: -0.72, w: 0.80, n: 2.5, mid: 0.02 },
    { x: 1.5, top: 0.74, bot: -0.88, w: 0.95, n: 2.6, mid: 0.03 },
    { x: 0.5, top: 0.74, bot: -0.93, w: 1.02, n: 2.7, mid: 0.03 },
    { x: -1.0, top: 0.72, bot: -0.90, w: 1.0, n: 2.7, mid: 0.03 },
    { x: -2.5, top: 0.70, bot: -0.82, w: 0.92, n: 2.6, mid: 0.02 },
    { x: -4.0, top: 0.66, bot: -0.70, w: 0.78, n: 2.4, mid: 0.0 },
    { x: -5.5, top: 0.62, bot: -0.62, w: 0.66, n: 2.2, mid: 0.0 },
    { x: -6.5, top: 0.60, bot: -0.60, w: 0.61, n: 2.0, mid: 0.0 },
  ];
  const st = smoothStations(keys, 0.2);
  const U0 = 7.32, UL = 7.32 + 6.5, TW = 2048, TH = 512;
  const fp = new FusePainter(st, TW, TH, U0, UL);
  const fuseTex = canvasTexture(TW, TH, (ctx) => {
    ctx.fillStyle = C.base; ctx.fillRect(0, 0, TW, TH);
    ctx.fillStyle = C.low; fp.underBelly(ctx, 6.0, -6.5, () => -0.35); ctx.fill();
    ctx.save(); ctx.filter = 'blur(7px)';
    ctx.fillStyle = C.dark; fp.overTop(ctx, 5.4, -6.5, (x) => 0.22 + 0.1 * Math.sin(x * 1.3)); ctx.fill();
    ctx.restore();
    ctx.fillStyle = C.radome; ctx.fillRect(0, 0, fp.X(6.05), TH);
    ctx.fillStyle = C.glare; fp.overTop(ctx, 6.0, 4.7, (x) => 0.12 + (6.0 - x) * 0.17); ctx.fill();
    ctx.fillStyle = C.tub; fp.overTop(ctx, 4.72, 1.95, (x) => 0.36 + (4.72 - x) * 0.07); ctx.fill();
    // panel lines
    ctx.strokeStyle = 'rgba(30,34,40,0.22)'; ctx.lineWidth = 1.5;
    for (const x of [6.05, 5.2, 4.2, 3.0, 1.9, 0.6, -0.8, -2.2, -3.6, -5.0, -6.1]) { ctx.beginPath(); ctx.moveTo(fp.X(x), 0); ctx.lineTo(fp.X(x), TH); ctx.stroke(); }
    for (const side of [1, -1]) {
      // formation lights
      ctx.fillStyle = '#c9d37a';
      fp.poly(ctx, [[5.25, -0.02], [5.25, 0.05], [4.7, 0.07], [4.7, 0.0]], side); ctx.fill();
      fp.poly(ctx, [[-4.3, 0.2], [-4.3, 0.27], [-4.9, 0.27], [-4.9, 0.2]], side); ctx.fill();
      // emblem: ring with a forward chevron
      const ring = (r) => { const pts = []; for (let i = 0; i < 28; i++) { const a = i / 28 * Math.PI * 2; pts.push([-2.9 + Math.cos(a) * r, 0.02 + Math.sin(a) * r]); } return pts; };
      ctx.fillStyle = '#3d444b'; fp.poly(ctx, ring(0.3), side); ctx.fill();
      ctx.fillStyle = C.base; fp.poly(ctx, ring(0.235), side); ctx.fill();
      ctx.fillStyle = '#3d444b'; fp.poly(ctx, [[-2.68, 0.02], [-3.02, 0.2], [-2.94, 0.02], [-3.02, -0.16]], side); ctx.fill();
      fp.text(ctx, 'PG-021', 3.85, -0.2, side, 0.2, 'bold 100px Arial, Helvetica, sans-serif', '#3d444b');
    }
  });
  M.fuse = paint(0xffffff, { map: fuseTex, rough: 0.5, metal: 0.25 });
  M.grey = paint(0x8a929a, { rough: 0.5, metal: 0.25 });
  M.dgrey = paint(0x5b6269, { rough: 0.5, metal: 0.3 });
  M.nozzle = paint(0x4a4a4e, { rough: 0.38, metal: 0.9 });
  M.nozzleIn = paint(0x2a2625, { rough: 0.6, metal: 0.6, side: THREE.DoubleSide });
  P.add('fuse', loft(st, { uOrigin: U0, uLength: UL, seg: 36 }));
  // pitot boom
  P.add('steel', tube(v3(7.3, -0.15, 0), v3(7.95, -0.15, 0), 0.02, 0.008, 8));

  // chin intake
  const ist = smoothStations([
    { x: 3.02, top: -0.53, bot: -0.97, w: 0.40, n: 3.2 },
    { x: 2.92, top: -0.48, bot: -1.04, w: 0.47, n: 3.2 },
    { x: 2.2, top: -0.48, bot: -1.04, w: 0.56, n: 3.2 },
    { x: 1.2, top: -0.48, bot: -1.01, w: 0.70, n: 3.0 },
    { x: 0.2, top: -0.48, bot: -0.95, w: 0.84, n: 2.8 },
    { x: -1.0, top: -0.48, bot: -0.86, w: 0.78, n: 2.6 },
  ], 0.25);
  P.add('grey', loft(ist, { seg: 28 }));
  P.add('black', loft([{ x: 3.0, top: -0.56, bot: -0.95, w: 0.37, n: 3.2 }, { x: 2.99, top: -0.56, bot: -0.95, w: 0.37, n: 3.2 }], { seg: 28, capStart: true }));

  // canopy, pilot, seat
  const cst = smoothStations([
    { x: 4.78, top: 0.47, bot: 0.38, w: 0.08, mid: 0.4, n: 2 },
    { x: 4.45, top: 0.80, bot: 0.4, w: 0.30, mid: 0.43, n: 2 },
    { x: 3.9, top: 1.10, bot: 0.44, w: 0.40, mid: 0.47, n: 2 },
    { x: 3.3, top: 1.25, bot: 0.48, w: 0.43, mid: 0.5, n: 2 },
    { x: 2.7, top: 1.16, bot: 0.52, w: 0.40, mid: 0.55, n: 2 },
    { x: 2.2, top: 0.93, bot: 0.56, w: 0.30, mid: 0.6, n: 2 },
    { x: 1.88, top: 0.74, bot: 0.6, w: 0.12, mid: 0.64, n: 2 },
  ], 0.12);
  M.glass = glass(0x3a2e16, 0.36);
  rig.mesh(loft(cst, { seg: 24 }), 'glass', { hide: true }).renderOrder = 4;
  addPilot(rig, v3(3.28, 0.98, 0), 0x3d4a35, 0xdfe2e4);
  P.add('dark', tx(box(0.12, 0.85, 0.44), { p: [2.93, 0.72, 0], r: [0, 0, -0.26] }), { hide: true });
  P.add('dark', tx(box(0.5, 0.1, 0.5), { p: [3.9, 0.56, 0] }), { hide: true });

  // wings (thin, blended into the body by strakes)
  const wingTex = canvasTexture(512, 512, (ctx, W, H) => {
    const wp = new WingPainter(W, H);
    ctx.fillStyle = C.low; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = C.base; wp.rect(ctx, 0, 1.1, 0, 1, true);
    ctx.save(); ctx.filter = 'blur(6px)';
    ctx.fillStyle = C.dark; wp.poly(ctx, [[0, 0.25], [0.55, 0.1], [0.8, 0.5], [0.45, 0.9], [0, 0.8]], true); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(30,34,40,0.25)'; ctx.lineWidth = 1.5;
    for (const e of [0.24, 0.5, 0.76]) { ctx.beginPath(); ctx.moveTo(wp.X(e), 0); ctx.lineTo(wp.X(e), H); ctx.stroke(); }
    ctx.fillStyle = '#c9d37a'; wp.rect(ctx, 0.9, 0.97, 0.3, 0.36, true);
  }, { wrapT: THREE.ClampToEdgeWrapping });
  M.wing = paint(0xffffff, { map: wingTex, rough: 0.5, metal: 0.25 });
  const wd = def.surfaces[0];
  const wingSpec = (side) => ({
    rootLE: wd.rootLE, semiSpan: wd.semiSpan, rootChord: wd.rootChord, tipChord: wd.tipChord, sweepLE: wd.sweepLE,
    dihedral: 0, incidence: 0, twist: wd.twist, tcRoot: 0.05, tcTip: 0.04, camber: 0, side, tip: 'flat', chordSegs: 10,
    panels: [{ from: 0, to: 0.24 }, { from: 0.24, to: 0.76, cut: 0.78, type: 'aileron' }, { from: 0.76, to: 1 }],
  });
  const wR = rig.wing(wingSpec(1), 'wing'), wL = rig.wing(wingSpec(-1), 'wing');
  tipAnchors(rig, wR, wL, 0.8);
  rig.rules.flaperonDroop = 20 * DEG;
  const strake = plateXZ([[5.35, 0.42], [4.6, 0.6], [3.6, 0.82], [2.6, 1.02], [1.9, 1.2], [1.45, 1.36], [1.1, 0.9], [1.6, 0.5], [5.35, 0.36]], 0.07, 0.02);
  strake.translate(0, 0.05, 0);
  P.add('grey', strake); P.add('grey', mirrorZ(strake));

  // all-moving stabilators (with a little differential for roll)
  const hd = def.surfaces[1];
  const stabGeo = (side) => buildWing({
    rootLE: hd.rootLE, semiSpan: hd.semiSpan, rootChord: hd.rootChord, tipChord: hd.tipChord, sweepLE: hd.sweepLE,
    dihedral: hd.dihedral, tcRoot: 0.05, tcTip: 0.04, side, tip: 'flat', chordSegs: 8, panels: [{ from: 0.2, to: 1 }],
  });
  const sR = stabGeo(1), sL = stabGeo(-1);
  const dih = hd.dihedral * DEG;
  const setR = addMovable(rig, sR.fixed, 'wing', sR.pt(0.2, 0.55, 0), v3(0, Math.sin(dih), Math.cos(dih)));
  const setL = addMovable(rig, sL.fixed, 'wing', sL.pt(0.2, 0.55, 0), v3(0, -Math.sin(dih), Math.cos(dih)));
  rig.updaters.push((s) => { setR(-s.surf.elevator - 0.25 * s.surf.aileron); setL(-s.surf.elevator + 0.25 * s.surf.aileron); });

  // fin, ventral fins
  const vd = def.surfaces[2];
  const finTex = canvasTexture(256, 256, (ctx, W, H) => {
    const wp = new WingPainter(W, H);
    ctx.fillStyle = C.base; ctx.fillRect(0, 0, W, H);
    for (const up of [true, false]) {
      ctx.fillStyle = C.dark; wp.rect(ctx, 0.86, 1.1, 0, 1, up);
      ctx.fillStyle = '#3d444b'; wp.rect(ctx, 0.8, 0.83, 0, 1, up);
      ctx.fillStyle = '#c9d37a'; wp.rect(ctx, 0.52, 0.72, 0.3, 0.34, up);
    }
  }, { wrapT: THREE.ClampToEdgeWrapping });
  M.fin = paint(0xffffff, { map: finTex, rough: 0.5, metal: 0.25 });
  const fin = rig.wing({
    rootLE: vd.rootLE, semiSpan: vd.semiSpan, rootChord: vd.rootChord, tipChord: vd.tipChord, sweepLE: vd.sweepLE,
    tcRoot: 0.055, tcTip: 0.045, vertical: true, tip: 'flat', chordSegs: 8,
    panels: [{ from: 0, to: 0.08 }, { from: 0.08, to: 0.88, cut: 0.72, type: 'rudder' }, { from: 0.88, to: 1 }],
  }, 'fin');
  // fin root fairing
  P.add('grey', loft(smoothStations([
    { x: -2.9, top: 0.7, bot: 0.5, w: 0.03 }, { x: -4.2, top: 0.95, bot: 0.5, w: 0.16 }, { x: -5.6, top: 0.98, bot: 0.5, w: 0.17 }, { x: -6.45, top: 0.82, bot: 0.5, w: 0.06 },
  ], 0.3), { seg: 12, capStart: true, capEnd: true }));
  for (const s of [1, -1]) {
    const vf = plateXY([[-4.1, -0.5], [-5.4, -0.5], [-5.55, -1.0], [-4.75, -1.0]], 0.05, 0.015);
    P.add('grey', tx(vf, { p: [0, 0, s * 0.42], r: [s * 0.3, 0, 0] }));
  }

  // wingtip rails and missiles
  M.missile = paint(0xe8e8e4, { rough: 0.4, metal: 0.2 });
  for (const w of [wR, wL]) {
    const s = w.side, tl = w.pt(1, 0, 0), tt = w.pt(1, 1, 0), z = tl.z + s * 0.07;
    P.add('dgrey', tube(v3(tl.x + 0.5, tl.y, z), v3(tt.x - 0.35, tl.y, z), 0.05, 0.05, 8));
    const x0 = tl.x + 1.15, zm = z + s * 0.1;
    P.add('missile', lathe([[x0, 0.002], [x0 - 0.12, 0.04], [x0 - 0.32, 0.064], [x0 - 2.75, 0.064], [x0 - 2.85, 0.05]], 10, { capEnd: true }).translate(0, tl.y, zm));
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + k * Math.PI / 2;
      for (const [xa, len, span] of [[x0 - 0.55, 0.22, 0.16], [x0 - 2.35, 0.48, 0.24]]) {
        const fg = plateXY([[xa, 0.05], [xa - len * 0.5, 0.05 + span], [xa - len, 0.05 + span], [xa - len, 0.05]], 0.012);
        P.add('missile', tx(fg, { r: [a, 0, 0], p: [0, tl.y, zm] }));
      }
    }
  }

  // nozzle and afterburner
  P.add('nozzle', lathe([[-6.42, 0.625], [-6.66, 0.605]], 28));
  // variable-area nozzle: the petals pivot at their base, so only the exit radius changes
  const NZ_LEN = 0.82;
  const petals = [
    rig.mesh(lathe([[0, 0.6], [-0.4, 0.565], [-NZ_LEN, 0.5]], 28), 'nozzle'),
    rig.mesh(lathe([[-NZ_LEN, 0.48], [-0.4, 0.54], [0.25, 0.56]], 28), 'nozzleIn', { shadow: false }),
  ];
  for (const m of petals) { m.position.set(-6.6, 0, 0); m.userData.base = m.geometry.attributes.position.array.slice(); }
  let nzK = -1;
  const setNozzle = (k) => {
    if (Math.abs(k - nzK) < 0.004) return;
    nzK = k;
    for (const m of petals) {
      const a = m.geometry.attributes.position, b = m.userData.base;
      for (let i = 0; i < a.count; i++) {
        const sc = 1 + (k - 1) * clamp(-b[i * 3] / NZ_LEN, 0, 1);
        a.setY(i, b[i * 3 + 1] * sc); a.setZ(i, b[i * 3 + 2] * sc);
      }
      a.needsUpdate = true;
    }
  };
  const glowMat = new THREE.MeshStandardMaterial({ color: 0x1a1412, emissive: 0xff7a30, emissiveIntensity: 0, roughness: 0.8 });
  const holder = new THREE.Mesh(new THREE.CircleGeometry(0.55, 28).rotateY(-Math.PI / 2), glowMat);
  holder.position.set(-6.4, 0, 0);
  rig.group.add(holder);
  const flameMat = (op) => new THREE.MeshBasicMaterial({ map: flameTexture(), transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const cone = (len, r) => lathe([[0, r], [-len * 0.25, r * 0.92], [-len * 0.6, r * 0.6], [-len, r * 0.06]], 20, { uv: (i, j) => [j / 20, 1 - i / 3] });
  const fOut = new THREE.Mesh(cone(5.2, 0.44), flameMat(0.5)), fIn = new THREE.Mesh(cone(3.0, 0.26), flameMat(0.7));
  for (const f of [fOut, fIn]) { f.position.set(-7.3, 0, 0); f.renderOrder = 7; f.visible = false; rig.group.add(f); }
  rig.updaters.push((s) => {
    const e = (s.engines && s.engines[0]) || {};
    const ab = clamp(e.ab || 0, 0, 1), n1 = e.n1 ?? 0.3;
    const open = Math.max(ab, clamp(1 - (n1 - 0.3) / 0.25, 0, 1) * 0.85);
    const k = lerp(0.76, 1, open);
    setNozzle(k);
    const fl = 1 + 0.06 * Math.sin((s.time || 0) * 61) + 0.04 * Math.sin((s.time || 0) * 37 + 1.3);
    glowMat.emissiveIntensity = (e.running === false ? 0 : 0.15 + 0.5 * clamp((n1 - 0.6) / 0.4, 0, 1)) + ab * 5 * fl;
    fOut.visible = fIn.visible = ab > 0.02;
    fOut.scale.set((0.35 + 0.65 * ab) * fl, k, k); fIn.scale.set((0.4 + 0.6 * ab) * (2 - fl), k, k);
    fOut.material.opacity = 0.5 * smooth(ab * 1.5); fIn.material.opacity = 0.7 * smooth(ab * 1.5);
  });
  rig.anchors.nozzles.push(v3(-7.42, 0, 0));

  // split speed brakes beside the nozzle
  for (const sz of [1, -1]) for (const sy of [1, -1]) {
    const set = addMovable(rig, tx(box(0.95, 0.03, 0.36), { p: [-5.9, 0.02 * sy, sz * 0.8] }), 'grey', v3(-5.42, 0.02 * sy, sz * 0.8), v3(0, 0, 1));
    rig.updaters.push((st) => set(-sy * 42 * DEG * (st.surf.spoiler || 0)));
  }

  // landing gear
  const g = def.gear;
  addGear(rig, { index: 0, top: v3(g[0].pos[0] + 0.08, -0.56, 0), axle: v3(g[0].pos[0], g[0].pos[1] + g[0].radius, 0), offsets: [0], radius: g[0].radius, width: 0.14, style: 'oleo', strutR: 0.04, steer: true, retract: { axis: v3(0, 0, 1), angle: -100 * DEG } });
  for (const i of [1, 2]) {
    const s = Math.sign(g[i].pos[2]);
    addGear(rig, {
      index: i, top: v3(g[i].pos[0] + 0.2, -0.7, s * 0.62), axle: v3(g[i].pos[0], g[i].pos[1] + g[i].radius, s * (Math.abs(g[i].pos[2]) - 0.14)),
      offsets: [s * 0.14], radius: g[i].radius, width: 0.2, style: 'oleo', strutR: 0.05, fork: true, retract: { axis: v3(0, 0, 1), angle: 96 * DEG },
    });
  }
  // lights
  addLamp(rig, wL.pt(1.0, 0.1, 0).add(v3(0.2, 0, -0.13)), 0xff2a1a, 'nav', 0.04);
  addLamp(rig, wR.pt(1.0, 0.1, 0).add(v3(0.2, 0, 0.13)), 0x18ff5a, 'nav', 0.04);
  addLamp(rig, fin.pt(1.0, 0.5, 0).add(v3(0, 0.04, 0)), 0xffffff, 'strobe', 0.04);
  addLamp(rig, v3(-0.5, -0.95, 0), 0xff2020, 'beacon', 0.04);
  rig.anchors.tailLight.copy(fin.pt(0.9, 1.0, 0)).add(v3(-0.03, 0, 0));
  addLamp(rig, rig.anchors.tailLight, 0xffffff, 'nav', 0.03);
  rig.anchors.landingLight.set(g[0].pos[0] + 0.1, -1.05, 0);            // on the nose gear leg
  addLamp(rig, rig.anchors.landingLight, 0xfff4d6, 'landing', 0.05, true);
  return rig.finish();
}

// ============================================================================ Meridian 320 (airliner)

let _fanTex = null;
function fanTexture() {
  if (_fanTex) return _fanTex;
  _fanTex = canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#0b0c0e'; ctx.fillRect(0, 0, 256, 256);
    ctx.translate(128, 128);
    for (let i = 0; i < 24; i++) {
      ctx.rotate(Math.PI / 12);
      const g = ctx.createLinearGradient(0, -14, 0, 14);
      g.addColorStop(0, '#15171a'); g.addColorStop(0.5, '#4d535b'); g.addColorStop(1, '#101114');
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(30, -3); ctx.quadraticCurveTo(80, -22, 126, -10); ctx.lineTo(126, 12); ctx.quadraticCurveTo(80, 4, 30, 5); ctx.fill();
    }
    ctx.fillStyle = '#16181b'; ctx.beginPath(); ctx.arc(0, 0, 36, 0, 7); ctx.fill();
  }, { wrapT: THREE.ClampToEdgeWrapping });
  return _fanTex;
}

function buildAirliner(def) {
  const rig = new Rig(def);
  const P = rig.parts, M = rig.mats;
  const C = { white: '#f6f7f8', belly: '#c3c9cf', teal: '#0c7f8c', navy: '#12325e', sky: '#49b6c4', glassA: '#131c26', glassB: '#2c3e50' };
  const CY = 0.415;
  const keys = [
    { x: 18.42, top: 0.14, bot: 0.06, w: 0.04, mid: 0.1 },
    { x: 18.15, top: 0.62, bot: -0.40, w: 0.55, mid: 0.12 },
    { x: 17.6, top: 1.12, bot: -0.85, w: 1.05, mid: 0.18 },
    { x: 16.8, top: 1.62, bot: -1.22, w: 1.52, mid: 0.26 },
    { x: 15.8, top: 2.05, bot: -1.46, w: 1.84, mid: 0.33 },
    { x: 14.6, top: 2.33, bot: -1.58, w: 1.98, mid: 0.39 },
    { x: 13.2, top: 2.45, bot: -1.62, w: 2.035, mid: CY },
    { x: -6.5, top: 2.45, bot: -1.62, w: 2.035, mid: CY },
    { x: -9.5, top: 2.45, bot: -1.25, w: 1.98, mid: 0.6 },
    { x: -12.5, top: 2.44, bot: -0.72, w: 1.72, mid: 0.86 },
    { x: -15.0, top: 2.40, bot: -0.18, w: 1.30, mid: 1.11 },
    { x: -17.0, top: 2.32, bot: 0.40, w: 0.85, mid: 1.36 },
    { x: -18.6, top: 2.20, bot: 1.05, w: 0.42, mid: 1.62 },
    { x: -19.25, top: 1.98, bot: 1.52, w: 0.13, mid: 1.75 },
  ].map((k) => ({ ...k, n: 2 }));
  const st = smoothStations(keys, 0.45);
  const U0 = 18.42, UL = 18.42 + 19.25, TW = 4096, TH = 1024;
  const fp = new FusePainter(st, TW, TH, U0, UL);
  const fuseTex = canvasTexture(TW, TH, (ctx) => {
    ctx.fillStyle = C.white; ctx.fillRect(0, 0, TW, TH);
    ctx.fillStyle = C.belly; fp.underBelly(ctx, 17.6, -17.5, () => -0.92); ctx.fill();
    // tail swoosh
    const front = (y, off) => { const s = clamp((y + 1.62) / 4.07, 0, 1); return -4.2 - 5.6 * s - 1.5 * Math.sin(Math.PI * s) + off; };
    const sweep = (off, side) => {
      ctx.beginPath();
      for (let i = 0; i <= 40; i++) {
        const y = -1.62 + 4.07 * i / 40, x = front(y, off);
        const px = fp.X(x), py = fp.Y(x, Math.min(y, 2.44), side);
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, side > 0 ? TH : 0);
      }
      ctx.lineTo(fp.X(front(2.45, off)), TH / 2); ctx.lineTo(TW, TH / 2); ctx.lineTo(TW, side > 0 ? TH : 0); ctx.closePath();
    };
    for (const side of [1, -1]) {
      ctx.fillStyle = C.sky; sweep(1.7, side); ctx.fill();
      ctx.fillStyle = C.white; sweep(1.25, side); ctx.fill();
      const g = ctx.createLinearGradient(fp.X(-4), 0, fp.X(-19), 0);
      g.addColorStop(0, C.teal); g.addColorStop(1, C.navy);
      ctx.fillStyle = g; sweep(0, side); ctx.fill();
    }
    for (const side of [1, -1]) {
      // cabin windows
      for (let x = 13.3; x > -11.2; x -= 0.533) {
        if (Math.abs(x - 1.05) < 0.3 || Math.abs(x + 0.02) < 0.3) continue;
        ctx.fillStyle = '#d5d9dd'; fp.poly(ctx, [[x + 0.15, 0.76], [x + 0.15, 1.18], [x - 0.15, 1.18], [x - 0.15, 0.76]], side); ctx.fill();
        ctx.fillStyle = C.glassA; fp.poly(ctx, [[x + 0.115, 0.8], [x + 0.115, 1.14], [x - 0.115, 1.14], [x - 0.115, 0.8]], side);
        ctx.lineJoin = 'round'; ctx.lineWidth = 4; ctx.strokeStyle = C.glassA; ctx.fill(); ctx.stroke();
      }
      // doors and exits
      ctx.strokeStyle = 'rgba(70,78,88,0.75)'; ctx.lineWidth = 3;
      for (const [xa, xb, ya, yb] of [[14.75, 13.85, -0.55, 1.42], [-11.7, -12.55, -0.3, 1.5], [1.3, 0.8, 0.5, 1.45], [0.23, -0.27, 0.5, 1.45]]) {
        fp.poly(ctx, [[xa, ya], [xa, yb], [xb, yb], [xb, ya]], side); ctx.stroke();
      }
      for (const x of [14.3, -12.12]) { ctx.fillStyle = C.glassA; fp.poly(ctx, [[x + 0.1, 0.85], [x + 0.1, 1.1], [x - 0.1, 1.1], [x - 0.1, 0.85]], side); ctx.fill(); }
      // flight-deck side windows
      ctx.fillStyle = C.glassA;
      fp.poly(ctx, [[16.66, 0.92], [16.62, 1.5], [16.22, 1.6], [16.12, 0.98]], side); ctx.fill();
      fp.poly(ctx, [[16.04, 1.0], [16.14, 1.6], [15.72, 1.52], [15.7, 1.08]], side); ctx.fill();
      fp.text(ctx, 'MERIDIAN', 9.2, 1.62, side, 0.7, 'bold 100px Arial, Helvetica, sans-serif', C.navy);
      fp.text(ctx, 'SK-MRD', -13.3, 1.15, side, 0.32, 'bold 100px Arial, Helvetica, sans-serif', '#ffffff');
    }
    // windshield (wraps over the nose) with a centre post
    ctx.fillStyle = C.glassA; fp.overTop(ctx, 17.28, 16.74, (x) => 0.95 - (17.28 - x) * 0.08); ctx.fill();
    ctx.strokeStyle = C.white; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(fp.X(17.3), TH / 2); ctx.lineTo(fp.X(16.7), TH / 2); ctx.stroke();
    // nose cone seam
    ctx.strokeStyle = 'rgba(70,78,88,0.5)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(fp.X(17.75), 0); ctx.lineTo(fp.X(17.75), TH); ctx.stroke();
  }, { aniso: 16 });
  M.fuse = paint(0xffffff, { map: fuseTex, rough: 0.3, metal: 0.1 });
  M.white = paint(0xf6f7f8, { rough: 0.3, metal: 0.1 });
  M.belly = paint(0xc3c9cf, { rough: 0.4, metal: 0.15 });
  M.accent = paint(0x0c7f8c, { rough: 0.3, metal: 0.15 });
  P.add('fuse', loft(st, { uOrigin: U0, uLength: UL, seg: 40, capEnd: true, capEndUV: [0.999, 0.25] }), { hide: true });
  // wing-to-body fairing
  P.add('belly', loft(smoothStations([
    { x: 8.6, top: -1.2, bot: -1.5, w: 0.5, n: 3 }, { x: 7.2, top: -0.9, bot: -1.74, w: 1.85, n: 3.5 },
    { x: 4.5, top: -0.55, bot: -1.8, w: 2.25, n: 4 }, { x: 0.0, top: -0.55, bot: -1.82, w: 2.3, n: 4 },
    { x: -3.5, top: -0.65, bot: -1.8, w: 2.2, n: 4 }, { x: -6.0, top: -0.95, bot: -1.7, w: 1.6, n: 3.5 }, { x: -7.6, top: -1.25, bot: -1.5, w: 0.5, n: 3 },
  ], 0.5), { seg: 28 }), { hide: true });

  // ---- wing
  const wingTex = canvasTexture(2048, 512, (ctx, W, H) => {
    const wp = new WingPainter(W, H);
    ctx.fillStyle = '#d3d8dd'; ctx.fillRect(0, 0, W, H);
    for (const up of [true, false]) {
      ctx.fillStyle = '#b9c0c7'; wp.rect(ctx, 0.12, 1.1, 0, 0.055, up);            // slat / leading edge metal
      ctx.fillStyle = 'rgba(60,66,74,0.4)';
      wp.rect(ctx, 0.1, 0.98, 0.755, 0.762, up);
      for (const e of [0.38, 0.74, 0.76, 0.96]) wp.rect(ctx, e - 0.0012, e + 0.0012, 0.55, 1, up);
    }
    ctx.fillStyle = '#c4cad0'; wp.rect(ctx, 0.3, 0.72, 0.6, 0.745, true);
    ctx.fillStyle = 'rgba(60,66,74,0.45)';
    for (const e of [0.3, 0.405, 0.51, 0.615, 0.72]) wp.rect(ctx, e - 0.001, e + 0.001, 0.6, 0.745, true);
    ctx.fillStyle = '#f0f1f2'; wp.rect(ctx, 0, 0.14, 0, 1, true); wp.rect(ctx, 0, 0.14, 0, 1, false);
  }, { wrapT: THREE.ClampToEdgeWrapping });
  M.wing = paint(0xffffff, { map: wingTex, rough: 0.35, metal: 0.3 });
  const wd = def.surfaces[0];
  const wingSpec = (side) => ({
    rootLE: wd.rootLE, semiSpan: wd.semiSpan, rootChord: wd.rootChord, tipChord: wd.tipChord, sweepLE: wd.sweepLE,
    dihedral: wd.dihedral, incidence: wd.incidence, twist: wd.twist, tcRoot: 0.135, tcTip: 0.1, camber: 0.014, side, tip: 'flat',
    panels: [
      { from: 0, to: 0.1 },
      { from: 0.1, to: 0.38, cut: 0.76, type: 'flap' },
      { from: 0.38, to: 0.74, cut: 0.76, type: 'flap' },
      { from: 0.74, to: 0.76 },
      { from: 0.76, to: 0.96, cut: 0.74, type: 'aileron' },
      { from: 0.96, to: 1 },
    ],
  });
  const wR = rig.wing(wingSpec(1), 'wing'), wL = rig.wing(wingSpec(-1), 'wing');
  tipAnchors(rig, wR, wL, 0.9);
  rig.rules.flapAngle = 34 * DEG; rig.rules.flapExt = 0.62; rig.rules.flapDrop = 0.16;
  for (const w of [wR, wL]) {
    for (const [a, b] of [[0.3, 0.405], [0.405, 0.51], [0.51, 0.615], [0.615, 0.72]]) addSpoilerPanel(rig, w, a + 0.004, b - 0.004, 0.6, 0.745, 'wing');
    // flap track fairings
    for (const e of [0.2, 0.42, 0.63]) {
      const p = w.pt(e, 0.8, -1);
      P.add('white', tx(ellipsoid(1.5, 0.2, 0.17, 14, 8), { p: [p.x - 0.1, p.y - 0.14, p.z], r: [0, 0, 0.06] }));
    }
    // sharklet
    const tl = w.pt(1, 0, 0), s = w.side;
    const sh = buildWing({
      semiSpan: 2.3, rootChord: wd.tipChord, tipChord: 0.55, sweepLE: 40, tcRoot: 0.09, tcTip: 0.08, side: 1, chordSegs: 8,
      frame: new THREE.Matrix4().makeTranslation(tl.x, tl.y, tl.z).multiply(new THREE.Matrix4().makeRotationX((s > 0 ? -78 : -102) * DEG)).multiply(new THREE.Matrix4().makeRotationZ(wd.incidence * 0 * DEG)),
      panels: [{ from: 0, to: 1 }],
    });
    P.add('accent', sh.fixed);
  }
  rig.rules.elevScale = 1.5;
  const hd = def.surfaces[1];
  const stabSpec = (side) => ({
    rootLE: hd.rootLE, semiSpan: hd.semiSpan, rootChord: hd.rootChord, tipChord: hd.tipChord, sweepLE: hd.sweepLE,
    dihedral: hd.dihedral, incidence: hd.incidence, tcRoot: 0.1, tcTip: 0.09, side, chordSegs: 9,
    panels: [{ from: 0, to: 0.1 }, { from: 0.1, to: 0.95, cut: 0.7, type: 'elevator' }, { from: 0.95, to: 1 }],
  });
  rig.wing(stabSpec(1), 'white'); rig.wing(stabSpec(-1), 'white');
  const vd = def.surfaces[2];
  const finTex = canvasTexture(512, 512, (ctx, W, H) => {
    const wp = new WingPainter(W, H);
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, C.navy); g.addColorStop(1, C.teal);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    for (const up of [true, false]) {
      // crescent mark
      const cx = wp.X(0.52), cy = wp.Y(0.48, up);
      ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.ellipse(cx, cy, 92, 60, 0, 0, 7); ctx.fill();
      ctx.fillStyle = C.teal; ctx.beginPath(); ctx.ellipse(cx + 26, cy, 80, 50, 0, 0, 7); ctx.fill();
      ctx.fillStyle = C.sky; wp.poly(ctx, [[0.0, 0.0], [0.07, 0.0], [0.45, 1], [0.38, 1]], up); ctx.fill();
    }
  }, { wrapT: THREE.ClampToEdgeWrapping });
  M.fin = paint(0xffffff, { map: finTex, rough: 0.3, metal: 0.1 });
  const fin = rig.wing({
    rootLE: vd.rootLE, semiSpan: vd.semiSpan, rootChord: vd.rootChord, tipChord: vd.tipChord, sweepLE: vd.sweepLE,
    tcRoot: 0.1, tcTip: 0.09, vertical: true, chordSegs: 9,
    panels: [{ from: 0, to: 0.05 }, { from: 0.05, to: 0.95, cut: 0.7, type: 'rudder' }, { from: 0.95, to: 1 }],
  }, 'fin');

  // ---- engines
  M.lip = paint(0xd9dde2, { rough: 0.16, metal: 1 });
  M.core = paint(0x6d6f73, { rough: 0.35, metal: 0.9 });
  const fanMat = new THREE.MeshStandardMaterial({ map: fanTexture(), roughness: 0.4, metalness: 0.7 });
  M.spin = paint(0x2a2c30, { rough: 0.3, metal: 0.6 });
  def.engines.forEach((e, ei) => {
    const ey = e.pos[1], ez = e.pos[2], s = Math.sign(ez);
    const at = (g) => g.translate(0, ey, ez);
    P.add('white', at(lathe([[4.2, 1.1], [3.6, 1.17], [2.6, 1.17], [2.22, 1.13]], 32)));
    P.add('lip', at(lathe([[4.02, 0.9], [4.2, 0.93], [4.33, 0.99], [4.31, 1.06], [4.2, 1.1]], 32)));
    P.add('dark', at(lathe([[4.02, 0.9], [3.5, 0.88]], 32, { inside: true })));
    P.add('dark', at(lathe([[2.24, 1.04], [1.5, 1.02]], 32)));                       // cascade vanes
    P.add('core', at(lathe([[1.4, 0.7], [0.95, 0.64], [0.4, 0.54], [0.0, 0.43]], 24)));
    P.add('core', at(lathe([[0.02, 0.34], [-0.3, 0.2], [-0.62, 0.015]], 20)));
    P.add('black', at(lathe([[1.0, 0.9], [1.0, 0.62]], 24)));
    P.add('black', at(lathe([[0.02, 0.43], [0.02, 0.34]], 20)));
    // pylon
    const wing = s > 0 ? wR : wL, eta = Math.abs(ez) / wd.semiSpan;
    const le = wing.pt(eta, 0.02, -1), aft = wing.pt(eta, 0.55, -1);
    const py = plateXY([[4.0, ey + 1.02], [le.x + 0.1, le.y + 0.02], [aft.x, aft.y + 0.02], [aft.x + 0.5, aft.y - 0.3], [1.3, ey + 0.75], [2.4, ey + 1.1]], 0.3, 0.06);
    P.add('white', py.translate(0, 0, ez));
    // translating reverser sleeve
    const sleeve = rig.mesh(lathe([[2.25, 1.13], [1.7, 1.06], [1.02, 0.92], [1.0, 0.88]], 32), 'white');
    sleeve.position.set(0, ey, ez);
    // fan and spinner
    const fan = new THREE.Mesh(new THREE.CircleGeometry(0.89, 40).rotateY(Math.PI / 2), fanMat);
    fan.position.set(3.5, ey, ez);
    rig.group.add(fan);
    const spinner = rig.mesh(lathe([[0.55, 0.004], [0.4, 0.12], [0.2, 0.22], [0, 0.28]], 16), 'spin', { parent: fan, shadow: false });
    const mark = rig.mesh(tx(box(0.02, 0.03, 0.2), { p: [0.25, 0.14, 0.05], r: [0, 0.5, 0] }), 'white', { parent: spinner, shadow: false });
    mark.castShadow = false;
    let ang = ei;
    rig.updaters.push((st, dt) => {
      const en = (st.engines && st.engines[ei]) || {};
      ang += (en.n1 ?? 0.2) * 60 * dt;
      fan.rotation.x = ang % (Math.PI * 2);
      sleeve.position.x = -0.6 * smooth(en.reverse || 0);
    });
    rig.anchors.nozzles.push(v3(-0.6, ey, ez));
  });

  // ---- landing gear
  const g = def.gear;
  addGear(rig, { index: 0, top: v3(g[0].pos[0], -1.45, 0), axle: v3(g[0].pos[0], g[0].pos[1] + g[0].radius, 0), offsets: [-0.25, 0.25], radius: g[0].radius, width: 0.2, style: 'oleo', strutR: 0.07, steer: true, retract: { axis: v3(0, 0, 1), angle: 98 * DEG } });
  for (const i of [1, 2]) {
    const s = Math.sign(g[i].pos[2]);
    addGear(rig, {
      index: i, top: v3(g[i].pos[0], -0.75, s * (Math.abs(g[i].pos[2]) - 0.15)), axle: v3(g[i].pos[0], g[i].pos[1] + g[i].radius, g[i].pos[2]),
      offsets: [-0.45, 0.45], radius: g[i].radius, width: 0.4, style: 'oleo', strutR: 0.11, retract: { axis: v3(1, 0, 0), angle: s * 82 * DEG },
    });
  }

  // ---- lights and antennas
  P.add('white', plateXY([[6.2, 2.44], [5.7, 2.44], [5.55, 2.8], [5.75, 2.8]], 0.03), { hide: true });
  P.add('white', plateXY([[-2.0, 2.44], [-2.5, 2.44], [-2.65, 2.78], [-2.45, 2.78]], 0.03), { hide: true });
  addLamp(rig, wL.pt(1.0, 0.15, 0).add(v3(0, 0, -0.06)), 0xff2a1a, 'nav', 0.07);
  addLamp(rig, wR.pt(1.0, 0.15, 0).add(v3(0, 0, 0.06)), 0x18ff5a, 'nav', 0.07);
  addLamp(rig, wL.pt(1.0, 0.6, 0).add(v3(0, 0, -0.06)), 0xffffff, 'strobe', 0.06);
  addLamp(rig, wR.pt(1.0, 0.6, 0).add(v3(0, 0, 0.06)), 0xffffff, 'strobe', 0.06);
  addLamp(rig, v3(2.0, 2.5, 0), 0xff2020, 'beacon', 0.08);
  addLamp(rig, v3(-1.0, -1.86, 0), 0xff2020, 'beacon', 0.08);
  rig.anchors.tailLight.set(-19.3, 1.75, 0);
  addLamp(rig, rig.anchors.tailLight, 0xffffff, 'strobe', 0.06);
  rig.anchors.landingLight.set(g[0].pos[0] + 0.12, -1.9, 0);           // on the nose gear leg
  addLamp(rig, rig.anchors.landingLight, 0xfff4d6, 'landing', 0.09, true);
  addLamp(rig, wL.pt(0.13, 0.03, 0).add(v3(0.05, -0.1, 0)), 0xfff4d6, 'landing', 0.08);
  addLamp(rig, wR.pt(0.13, 0.03, 0).add(v3(0.05, -0.1, 0)), 0xfff4d6, 'landing', 0.08);
  return rig.finish();
}

// ============================================================================ registry

const BUILDERS = { trainer: buildTrainer, aerobat: buildAerobat, fighter: buildFighter, airliner: buildAirliner };

export function buildAircraftModel(def) {
  const b = BUILDERS[def.id];
  if (!b) throw new Error('no 3D model for aircraft ' + def.id);
  return b(def);
}

export function registerBuilder(id, fn) { BUILDERS[id] = fn; }
export { Rig, addGear, addProp, addLamp, addPilot, tipAnchors, makeWheel };
