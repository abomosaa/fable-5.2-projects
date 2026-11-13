// Procedural audio (Web Audio API): everything is synthesised, no samples.
// Engine (piston firing harmonics / turbine whine + roar + afterburner), airflow, ground roll,
// stall horn, gear and flap motors, tyre chirps, warning tones, crash.

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

function noiseBuffer(ctx, seconds, color = 'white') {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
  let last = 0, b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    if (color === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    else if (color === 'pink') { b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2; }
    else d[i] = w;
  }
  // make the loop seamless
  const f = Math.floor(ctx.sampleRate * 0.05);
  for (let i = 0; i < f; i++) { const t = i / f; d[i] = d[i] * t + d[n - f + i] * (1 - t); }
  return buf;
}

/** One loop of piston-engine sound: harmonics of the crank rotation with strong firing orders. */
function pistonBuffer(ctx, firingOrder) {
  const revHz = 20, revs = 12;
  const n = Math.floor(ctx.sampleRate * revs / revHz);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
  let seed = 1337 + firingOrder;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 8) / 16777216; };
  const parts = [];
  for (let k = 1; k <= 64; k++) {
    const order = k * 0.5;
    const onFiring = Math.abs(order / firingOrder - Math.round(order / firingOrder)) < 1e-6 && order >= firingOrder;
    let amp = onFiring ? 1 / Math.pow(order / firingOrder, 0.85) : 0.16 / Math.pow(order, 0.7);
    if (order < firingOrder) amp *= 0.6;
    parts.push({ w: 2 * Math.PI * order * revHz / ctx.sampleRate, amp, ph: rnd() * 6.283 });
  }
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const p of parts) v += p.amp * Math.sin(p.w * i + p.ph);
    // exhaust crackle synchronised with the firing pulses
    const pulse = Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * firingOrder * revHz * i / ctx.sampleRate), 6);
    v += (Math.random() * 2 - 1) * pulse * 0.5;
    d[i] = v; peak = Math.max(peak, Math.abs(v));
  }
  for (let i = 0; i < n; i++) d[i] /= peak;
  return { buf, revHz };
}

export class Audio {
  constructor() {
    this.ctx = null;
    this.volume = 0.7;
    this.muted = false;
    this.ready = false;
    this.kind = null;
    this.nodes = {};
    this.t = {};                 // timers for repeating warnings
    this.speechOk = typeof window !== 'undefined' && 'speechSynthesis' in window;
    this.lastCallout = 1e9;
  }

  /** Must be called from a user gesture. */
  init() {
    if (this.ctx) { this.ctx.resume?.(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain(); this.master.gain.value = 0;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -16; this.comp.ratio.value = 8; this.comp.attack.value = 0.004; this.comp.release.value = 0.2;
    this.out = ctx.createGain(); this.out.gain.value = 0.8;
    this.master.connect(this.comp).connect(this.out).connect(ctx.destination);
    this.white = noiseBuffer(ctx, 2.5, 'white');
    this.pink = noiseBuffer(ctx, 3, 'pink');
    this.brown = noiseBuffer(ctx, 3, 'brown');
    const loop = (buffer, filterType, freq, q = 0.7) => {
      const src = ctx.createBufferSource(); src.buffer = buffer; src.loop = true;
      const filt = ctx.createBiquadFilter(); filt.type = filterType; filt.frequency.value = freq; filt.Q.value = q;
      const gain = ctx.createGain(); gain.gain.value = 0;
      src.connect(filt).connect(gain).connect(this.master); src.start();
      return { src, filt, gain };
    };
    const N = this.nodes;
    N.wind = loop(this.pink, 'bandpass', 600, 0.5);
    N.windHi = loop(this.white, 'highpass', 2500, 0.3);
    N.roll = loop(this.brown, 'lowpass', 110, 0.8);
    N.buffet = loop(this.brown, 'lowpass', 55, 1.2);
    N.jetRoar = loop(this.pink, 'lowpass', 500, 0.6);
    N.jetHiss = loop(this.white, 'bandpass', 3200, 0.8);
    N.ab = loop(this.brown, 'lowpass', 140, 1.0);
    N.motor = loop(this.pink, 'bandpass', 240, 6);
    N.rain = loop(this.white, 'bandpass', 5200, 0.4);
    // tonal sources
    const osc = (type, freq) => {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
      const g = ctx.createGain(); g.gain.value = 0;
      o.connect(g).connect(this.master); o.start();
      return { osc: o, gain: g };
    };
    N.whine1 = osc('sine', 900); N.whine2 = osc('sine', 1800); N.fan = osc('sawtooth', 120);
    N.horn = osc('square', 430);
    N.hornFilter = ctx.createBiquadFilter(); N.hornFilter.type = 'bandpass'; N.hornFilter.frequency.value = 900; N.hornFilter.Q.value = 1.2;
    N.horn.gain.disconnect(); N.horn.gain.connect(N.hornFilter).connect(this.master);
    this.ready = true;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, ctx.currentTime, 0.3);
  }

  setVolume(v) { this.volume = v; if (this.ready) this.master.gain.setTargetAtTime(this.muted ? 0 : v, this.ctx.currentTime, 0.05); }
  setMuted(m) { this.muted = m; this.setVolume(this.volume); }
  suspend() { if (this.ready) this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08); }
  resume() { if (this.ready) { this.ctx.resume?.(); this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.15); } }

  setAircraft(def) {
    if (!this.ready) { this.pendingDef = def; return; }
    this.pendingDef = null;
    const ctx = this.ctx, N = this.nodes;
    if (N.piston) { N.piston.src.stop(); N.piston.gain.disconnect(); N.piston = null; }
    const e = def.engines[0];
    this.kind = e.type;
    if (e.type === 'piston') {
      const order = e.sound === 'flat6' ? 3 : 2;
      const { buf, revHz } = pistonBuffer(ctx, order);
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 900; filt.Q.value = 0.5;
      const gain = ctx.createGain(); gain.gain.value = 0;
      src.connect(filt).connect(gain).connect(this.master); src.start();
      N.piston = { src, filt, gain, revHz, rated: e.ratedRpm };
    }
    this.big = def.id === 'airliner';
  }

  set(node, value, tc = 0.06) { node.setTargetAtTime(value, this.ctx.currentTime, tc); }

  /** one-shot filtered noise burst */
  burst({ type = 'bandpass', freq = 1000, q = 1, gain = 0.5, attack = 0.005, decay = 0.2, sweep = 0, buffer = 'white' }) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this[buffer]; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(30, freq * sweep), t + decay);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0008, t + attack + decay);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5); src.stop(t + attack + decay + 0.05);
  }
  tone({ freq = 880, type = 'sine', gain = 0.2, dur = 0.15, when = 0, slide = 0 }) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime + when;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.linearRampToValueAtTime(freq * slide, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.008); g.gain.setValueAtTime(gain, t + dur - 0.02); g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + dur + 0.02);
  }

  play(name, k = 1) {
    if (!this.ready) return;
    switch (name) {
      case 'chirp': this.burst({ type: 'bandpass', freq: 2600, q: 2.5, gain: 0.5 * k, decay: 0.22, sweep: 0.45 }); break;
      case 'thump': this.burst({ type: 'lowpass', freq: 130, q: 1, gain: 1.1 * k, decay: 0.3, buffer: 'brown' }); break;
      case 'clunk': this.burst({ type: 'lowpass', freq: 320, q: 2, gain: 0.7 * k, decay: 0.12, buffer: 'brown' }); this.tone({ freq: 95, type: 'triangle', gain: 0.25 * k, dur: 0.12 }); break;
      case 'click': this.burst({ type: 'bandpass', freq: 3200, q: 3, gain: 0.25, decay: 0.03 }); break;
      case 'scrape': this.burst({ type: 'bandpass', freq: 1400, q: 0.8, gain: 0.7 * k, decay: 0.7 }); break;
      case 'crash':
        this.burst({ type: 'lowpass', freq: 900, q: 0.5, gain: 2.2, decay: 2.2, sweep: 0.15, buffer: 'white' });
        this.burst({ type: 'lowpass', freq: 90, q: 1.2, gain: 2.5, decay: 2.8, buffer: 'brown' });
        this.burst({ type: 'highpass', freq: 3000, q: 0.5, gain: 0.8, decay: 0.5 });
        break;
      case 'splash': this.burst({ type: 'bandpass', freq: 1200, q: 0.4, gain: 1.6, decay: 1.6, sweep: 0.4 }); break;
      case 'apoff': for (let i = 0; i < 3; i++) this.tone({ freq: 1180 - i * 120, type: 'square', gain: 0.1, dur: 0.11, when: i * 0.14 }); break;
      case 'apon': this.tone({ freq: 880, gain: 0.12, dur: 0.09 }); this.tone({ freq: 1320, gain: 0.12, dur: 0.12, when: 0.1 }); break;
      case 'caution': this.tone({ freq: 720, type: 'triangle', gain: 0.16, dur: 0.14 }); this.tone({ freq: 720, type: 'triangle', gain: 0.16, dur: 0.14, when: 0.2 }); break;
      case 'whoop': this.tone({ freq: 480, type: 'sawtooth', gain: 0.13, dur: 0.32, slide: 1.9 }); this.tone({ freq: 480, type: 'sawtooth', gain: 0.13, dur: 0.32, slide: 1.9, when: 0.38 }); break;
      case 'overspeed': for (let i = 0; i < 4; i++) this.burst({ type: 'bandpass', freq: 2100, q: 6, gain: 0.5, decay: 0.035 }); break;
      case 'good': this.tone({ freq: 660, gain: 0.1, dur: 0.1 }); this.tone({ freq: 990, gain: 0.1, dur: 0.16, when: 0.11 }); break;
    }
  }

  say(text) {
    if (!this.speechOk || this.muted) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.15; u.pitch = 0.9; u.volume = Math.min(1, this.volume * 1.2);
      window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
    } catch { /* speech not available */ }
  }

  /**
   * @param s {ac, cameraMode, camDist (m, external views), radialVel (m/s away from the listener), warnings:Set, rain}
   */
  update(s, dt) {
    if (!this.ready) return;
    if (this.pendingDef) { const d = this.pendingDef; this.pendingDef = null; this.setAircraft(d); }
    const ac = s.ac, N = this.nodes;
    const inside = s.cameraMode === 'cockpit';
    // distance attenuation and Doppler shift for outside observers
    const ext = inside ? 1 : clamp(70 / (40 + s.camDist), 0.05, 1.25);
    const doppler = inside ? 1 : clamp(343 / (343 + s.radialVel), 0.6, 1.7);
    const e = ac.engines[0];
    const alive = !ac.crashed;

    if (this.kind === 'piston' && N.piston) {
      const p = N.piston;
      const rpm = Math.max(e.rpm, 0);
      const rate = clamp((rpm / 60) / p.revHz * doppler, 0.05, 6);
      p.src.playbackRate.setTargetAtTime(rate, this.ctx.currentTime, 0.04);
      const turning = rpm > 40 ? 1 : 0;
      const load = e.running ? 0.3 + 0.7 * clamp(e.load || 0, 0, 1) : 0.12;
      this.set(p.gain.gain, alive ? turning * load * (inside ? 0.5 : 0.75 * ext) : 0);
      this.set(p.filt.frequency, (inside ? 500 : 800) + (inside ? 1700 : 4200) * load * load);
      this.set(N.jetRoar.gain.gain, 0); this.set(N.jetHiss.gain.gain, 0); this.set(N.ab.gain.gain, 0);
      this.set(N.whine1.gain.gain, 0); this.set(N.whine2.gain.gain, 0); this.set(N.fan.gain.gain, 0);
    } else if (this.kind === 'jet') {
      let n1 = 0, ab = 0, thrust = 0;
      for (const en of ac.engines) { n1 = Math.max(n1, en.n1); ab = Math.max(ab, en.ab || 0); thrust += Math.abs(en.thrust); }
      const tf = clamp(thrust / (ac.def.engines.length * (ac.def.engines[0].abThrust || ac.def.engines[0].thrust)), 0, 1);
      const rev = ac.engines[0].reverse || 0;
      const k = alive ? 1 : 0;
      this.set(N.jetRoar.gain.gain, k * (0.05 + 1.1 * Math.pow(tf, 0.7) + 0.5 * rev * n1) * (inside ? 0.38 : 0.9 * ext));
      this.set(N.jetRoar.filt.frequency, (this.big ? 260 : 380) + 900 * n1 * doppler);
      this.set(N.jetHiss.gain.gain, k * (0.02 + 0.2 * n1 * n1) * (inside ? 0.25 : 0.8 * ext));
      this.set(N.jetHiss.filt.frequency, (2200 + 2600 * n1) * doppler);
      const wf = (this.big ? 240 : 420) + (this.big ? 2500 : 3900) * n1;
      N.whine1.osc.frequency.setTargetAtTime(wf * doppler, this.ctx.currentTime, 0.05);
      N.whine2.osc.frequency.setTargetAtTime(wf * 2.01 * doppler, this.ctx.currentTime, 0.05);
      const wg = k * clamp(n1 * 1.4, 0, 1) * (1 - 0.55 * tf) * (inside ? 0.016 : 0.045 * ext);
      this.set(N.whine1.gain.gain, wg); this.set(N.whine2.gain.gain, wg * 0.45);
      N.fan.osc.frequency.setTargetAtTime((this.big ? 62 : 95) * (0.4 + n1) * doppler, this.ctx.currentTime, 0.05);
      this.set(N.fan.gain.gain, k * n1 * n1 * (this.big ? 0.05 : 0.02) * (inside ? 0.5 : ext));
      this.set(N.ab.gain.gain, k * ab * (inside ? 0.7 : 1.3 * ext));
    }
    // airflow over the airframe
    const q = clamp(ac.qbar / 9000, 0, 1.4);
    const v = clamp(ac.tas / 120, 0, 3);
    this.set(N.wind.gain.gain, alive ? Math.pow(q, 0.6) * (inside ? 0.55 : 0.2 * ext) : 0);
    this.set(N.wind.filt.frequency, 280 + 520 * v);
    this.set(N.windHi.gain.gain, alive ? q * (inside ? 0.05 : 0.02) + ac.surf.spoiler * q * 0.12 + (ac.def.retractable ? ac.surf.gear * q * 0.18 : 0) : 0);
    // wheels on the ground
    const gs = Math.hypot(ac.vel.x, ac.vel.z);
    const rough = ac.gear.onGround ? (ac.gear.wheels.some((w) => w.contact && w.surface !== 0) ? 2.2 : 1) : 0;
    this.set(N.roll.gain.gain, alive ? rough * clamp(gs / 45, 0, 1.2) * (inside ? 0.9 : 0.35 * ext) : 0);
    this.set(N.roll.filt.frequency, 70 + gs * 2.2);
    this.set(N.buffet.gain.gain, alive ? ac.buffet * 1.4 + ac.gear.scrape * 2 : 0);
    // stall warning: horn in the piston aircraft, stick-shaker rattle in the jets
    const stall = alive && ac.stallWarning && !ac.gear.onGround;
    if (this.kind === 'piston') this.set(N.horn.gain.gain, stall ? 0.07 : 0, 0.02);
    else {
      this.set(N.horn.gain.gain, 0);
      if (stall) { this.t.shaker = (this.t.shaker || 0) - dt; if (this.t.shaker <= 0) { this.t.shaker = 0.05; this.burst({ type: 'bandpass', freq: 380, q: 3, gain: 0.5, decay: 0.03, buffer: 'brown' }); } }
    }
    // electric motors: gear and flaps in transit
    const gearMoving = ac.def.retractable && ac.surf.gear > 0.01 && ac.surf.gear < 0.99;
    const flapTarget = ac.def.flaps ? ac.def.flaps.settings[ac.ctrl.flapIndex] / ac.def.flaps.max : 0;
    const flapMoving = ac.def.flaps && Math.abs(ac.surf.flap - flapTarget) > 0.005;
    this.set(N.motor.gain.gain, alive ? (gearMoving ? 0.5 : flapMoving ? 0.22 : 0) * (inside ? 1 : 0.3 * ext) : 0);
    this.set(N.motor.filt.frequency, gearMoving ? 190 : 330);
    if (this._gearMoving && !gearMoving) this.play('clunk', inside ? 1 : 0.4 * ext);
    this._gearMoving = gearMoving;
    this.set(N.rain.gain.gain, (s.rain || 0) * (inside ? 0.12 : 0.06));

    // repeating warnings
    const W = s.warnings;
    const rep = (key, period, fn) => { if (!W.has(key)) { this.t[key] = 0; return; } this.t[key] = (this.t[key] || 0) - dt; if (this.t[key] <= 0) { this.t[key] = period; fn(); } };
    rep('PULL UP', 1.6, () => { this.play('whoop'); this.say('Pull up'); });
    rep('TERRAIN', 2.2, () => { this.play('caution'); this.say('Terrain'); });
    rep('OVERSPEED', 0.5, () => this.play('overspeed'));
    rep('LANDING GEAR', 1.5, () => { this.tone({ freq: 310, type: 'square', gain: 0.1, dur: 0.5 }); });
    rep('BANK ANGLE', 3, () => { this.play('caution'); this.say('Bank angle'); });

    // radio-altimeter call-outs on short final
    if (alive && !ac.gear.onGround && ac.vel.y < -0.3 && (!ac.def.retractable || ac.surf.gear > 0.9)) {
      const ft = (ac.agl - (s.gearHeight || 0)) / 0.3048;
      for (const c of [500, 100, 50, 30, 20, 10]) {
        if (ft < c && this.lastCallout > c) { if (c <= 100 || this.big) this.say(String(c)); break; }
      }
      this.lastCallout = ft;
    } else if (ac.gear.onGround || ac.vel.y > 1) this.lastCallout = 1e9;
  }
}
