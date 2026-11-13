/**
 * Synthesised motor / propeller sound. Throttle management by ear is a real
 * piloting skill, so pitch follows each motor's actual rpm: blade-pass tone,
 * electrical whine and broadband prop noise, with distance attenuation and
 * Doppler shift when watching line-of-sight.
 */
import { Simulation } from '../sim/simulation';

const SOUND_SPEED = 343;

interface MotorVoice {
  blade: OscillatorNode;
  whine: OscillatorNode;
  bladeGain: GainNode;
  whineGain: GainNode;
}

export class SimAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private voices: MotorVoice[] = [];
  private noiseGain: GainNode | null = null;
  private noiseFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;
  private volume = 0.6;
  private lastDist = -1;
  private lastImpact = 0;

  /** Must be called from a user gesture. */
  start(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 6;
    master.connect(comp).connect(ctx.destination);
    this.master = master;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 5200;
    lp.Q.value = 0.4;
    lp.connect(master);

    for (let i = 0; i < 4; i++) {
      const blade = ctx.createOscillator();
      blade.type = 'sawtooth';
      blade.frequency.value = 0;
      // Slight detune per motor: four props never sound identical.
      blade.detune.value = (i - 1.5) * 9;
      const whine = ctx.createOscillator();
      whine.type = 'triangle';
      whine.frequency.value = 0;
      const bladeGain = ctx.createGain();
      bladeGain.gain.value = 0;
      const whineGain = ctx.createGain();
      whineGain.gain.value = 0;
      const pan = ctx.createStereoPanner();
      pan.pan.value = i < 2 ? 0.25 : -0.25;
      blade.connect(bladeGain).connect(pan);
      whine.connect(whineGain).connect(pan);
      pan.connect(lp);
      blade.start();
      whine.start();
      this.voices.push({ blade, whine, bladeGain, whineGain });
    }

    // Broadband noise: prop wash (band-passed) and airflow (low-passed).
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const mk = () => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.start();
      return src;
    };
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 900;
    nf.Q.value = 0.7;
    const ng = ctx.createGain();
    ng.gain.value = 0;
    mk().connect(nf).connect(ng).connect(master);
    this.noiseFilter = nf;
    this.noiseGain = ng;

    const wf = ctx.createBiquadFilter();
    wf.type = 'lowpass';
    wf.frequency.value = 420;
    const wg = ctx.createGain();
    wg.gain.value = 0;
    mk().connect(wf).connect(wg).connect(master);
    this.windGain = wg;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }

  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /**
   * @param listener position of the ears, or null when riding on board (FPV)
   */
  update(sim: Simulation, listener: { x: number; y: number; z: number } | null, dt: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const dr = sim.drone;
    const blades = dr.p.rotor.blades;
    const wMax = ((dr.p.motor.kv * 2 * Math.PI) / 60) * dr.p.battery.cells * 4.2 * 0.68;

    let gain = 1, doppler = 1;
    if (listener) {
      const dx = dr.pos.x - listener.x, dy = dr.pos.y - listener.y, dz = dr.pos.z - listener.z;
      const dist = Math.max(0.5, Math.hypot(dx, dy, dz));
      gain = Math.min(1, 3 / dist);
      if (this.lastDist > 0 && dt > 0) {
        const vr = (dist - this.lastDist) / (dt * Math.max(sim.timeScale, 0.01));
        doppler = SOUND_SPEED / (SOUND_SPEED + Math.max(-150, Math.min(150, vr)));
      }
      this.lastDist = dist;
    } else {
      this.lastDist = -1;
      gain = 0.8;
    }
    // Slow motion lowers the pitch, as it would on a slowed recording.
    doppler *= Math.max(0.25, Math.min(1, sim.timeScale));

    let thrust = 0;
    for (let i = 0; i < 4; i++) {
      const r = dr.rotors[i];
      const w = Math.abs(r.omega);
      const rev = w / (2 * Math.PI);
      const x = Math.min(1.2, w / wMax);
      const v = this.voices[i];
      v.blade.frequency.setTargetAtTime(Math.max(1, rev * blades * doppler), now, 0.012);
      v.whine.frequency.setTargetAtTime(Math.max(1, rev * 7 * doppler), now, 0.012);
      // Loudness rises steeply with tip speed; a damaged prop is rougher.
      const a = Math.pow(x, 1.7) * (1 + 1.5 * (1 - r.health));
      v.bladeGain.gain.setTargetAtTime(0.16 * a * gain, now, 0.02);
      v.whineGain.gain.setTargetAtTime(0.035 * Math.pow(x, 1.2) * gain, now, 0.02);
      thrust += Math.abs(r.thrust);
    }
    const tMax = 4 * 16 * (dr.d.mass / 0.6);
    const load = Math.min(1.2, thrust / tMax);
    let vrs = 0;
    for (let i = 0; i < 4; i++) vrs = Math.max(vrs, dr.rotors[i].vrs);
    // Prop wash gets audibly rough when descending through the wake.
    this.noiseGain!.gain.setTargetAtTime((0.05 + 0.5 * load + 0.25 * vrs * load) * gain * 0.5, now, 0.03);
    this.noiseFilter!.frequency.setTargetAtTime((500 + 2600 * Math.sqrt(load)) * doppler, now, 0.03);
    const va = dr.airVelBody;
    const air = Math.hypot(va.x, va.y, va.z);
    this.windGain!.gain.setTargetAtTime(listener ? 0 : Math.min(0.5, (air / 45) ** 2 * 0.5), now, 0.05);
  }

  private beep(freq: number, dur: number, when = 0, vol = 0.18, type: OscillatorType = 'square'): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || ctx.state !== 'running') return;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.005);
    g.gain.setValueAtTime(vol, t + dur - 0.01);
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private burst(vol: number, dur: number, cutoff: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || ctx.state !== 'running') return;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(this.master);
    src.start();
  }

  event(e: string, value: number): void {
    switch (e) {
      case 'arm':
        // ESC start-up style rising tones.
        this.beep(1047, 0.07, 0, 0.1);
        this.beep(1319, 0.07, 0.09, 0.1);
        this.beep(1568, 0.1, 0.18, 0.1);
        break;
      case 'disarm':
        this.beep(1319, 0.07, 0, 0.09);
        this.beep(880, 0.12, 0.09, 0.09);
        break;
      case 'gate':
        this.beep(1760, 0.06, 0, 0.1, 'sine');
        break;
      case 'lap':
        this.beep(1760, 0.08, 0, 0.12, 'sine');
        this.beep(2349, 0.16, 0.1, 0.12, 'sine');
        break;
      case 'crash':
        this.burst(0.9, 0.5, 1800);
        break;
      case 'impact': {
        // Several parts of the frame usually touch down within a few milliseconds: one thump.
        const now = performance.now();
        if (now - this.lastImpact < 90) break;
        this.lastImpact = now;
        this.burst(Math.min(0.6, 0.06 * value), 0.12, 900 + value * 120);
        break;
      }
    }
  }
}
