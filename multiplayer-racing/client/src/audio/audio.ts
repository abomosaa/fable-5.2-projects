/**
 * All sound is synthesised with the Web Audio API: no audio files, no
 * licensing. An engine voice for the local car (and quieter ones for nearby
 * rivals), tyre squeal, wind, off-road rumble and short one-shot cues.
 */
import type { Settings } from '../storage/settings';

const REMOTE_VOICES = 2;

interface EngineVoice {
  osc1: OscillatorNode;
  osc2: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private local: (EngineVoice & { osc3: OscillatorNode }) | null = null;
  private remotes: EngineVoice[] = [];
  private skidGain: GainNode | null = null;
  private skidFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;
  private rumbleGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private racing = false;
  private lastImpactAt = 0;

  constructor(private settings: Settings) {}

  /** Browsers only allow audio after a user gesture; call this from one. */
  unlock(): void {
    if (!this.ctx) {
      try {
        this.build();
      } catch {
        this.ctx = null;
        return;
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setSettings(settings: Settings): void {
    this.settings = settings;
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.ctx || !this.master || !this.engineBus || !this.sfxBus) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.settings.muted ? 0 : this.settings.masterVolume, t, 0.03);
    this.engineBus.gain.setTargetAtTime(this.settings.engineVolume, t, 0.03);
    this.sfxBus.gain.setTargetAtTime(this.settings.sfxVolume, t, 0.03);
  }

  private build(): void {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.ratio.value = 6;
    compressor.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.connect(compressor);
    this.engineBus = ctx.createGain();
    this.engineBus.connect(this.master);
    this.sfxBus = ctx.createGain();
    this.sfxBus.connect(this.master);
    this.applyVolumes();

    // Two seconds of white noise, shared by squeal, wind, rumble and impacts.
    const length = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let seed = 1234567;
    for (let i = 0; i < length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = (seed / 0x80000000 - 1) * 0.9;
    }
    this.noiseBuffer = buffer;

    const voice = (bus: GainNode): EngineVoice => {
      const osc1 = ctx.createOscillator();
      osc1.type = 'sawtooth';
      const osc2 = ctx.createOscillator();
      osc2.type = 'square';
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 1.2;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const mix2 = ctx.createGain();
      mix2.gain.value = 0.45;
      osc1.connect(filter);
      osc2.connect(mix2).connect(filter);
      filter.connect(gain).connect(bus);
      osc1.start();
      osc2.start();
      return { osc1, osc2, filter, gain };
    };

    const local = voice(this.engineBus);
    const osc3 = ctx.createOscillator();
    osc3.type = 'triangle';
    const mix3 = ctx.createGain();
    mix3.gain.value = 0.5;
    osc3.connect(mix3).connect(local.filter);
    osc3.start();
    this.local = { ...local, osc3 };
    for (let i = 0; i < REMOTE_VOICES; i++) this.remotes.push(voice(this.engineBus));

    const noise = (): AudioBufferSourceNode => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.start();
      return source;
    };
    this.skidFilter = ctx.createBiquadFilter();
    this.skidFilter.type = 'bandpass';
    this.skidFilter.frequency.value = 1300;
    this.skidFilter.Q.value = 3.5;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    noise().connect(this.skidFilter).connect(this.skidGain).connect(this.sfxBus);

    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 520;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    noise().connect(windFilter).connect(this.windGain).connect(this.sfxBus);

    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 140;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    noise().connect(rumbleFilter).connect(this.rumbleGain).connect(this.sfxBus);
  }

  /** Fades the continuous race sounds in or out. */
  setRacing(racing: boolean): void {
    this.racing = racing;
    if (!racing && this.ctx) {
      const t = this.ctx.currentTime;
      this.local?.gain.gain.setTargetAtTime(0, t, 0.15);
      for (const remote of this.remotes) remote.gain.gain.setTargetAtTime(0, t, 0.15);
      this.skidGain?.gain.setTargetAtTime(0, t, 0.1);
      this.windGain?.gain.setTargetAtTime(0, t, 0.2);
      this.rumbleGain?.gain.setTargetAtTime(0, t, 0.1);
    }
  }

  /**
   * Updates the continuous sounds of the car being followed.
   * @param rpm 0..1 engine speed; @param throttle 0..1; @param speed m/s;
   * @param slip 0..1 tyre slide; @param offroad 0..1.
   */
  updateLocal(rpm: number, throttle: number, speed: number, slip: number, offroad: number, onIce: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.local || !this.racing) return;
    const t = ctx.currentTime;
    const freq = 46 + rpm * 190;
    this.local.osc1.frequency.setTargetAtTime(freq, t, 0.03);
    this.local.osc2.frequency.setTargetAtTime(freq * 0.5, t, 0.03);
    this.local.osc3.frequency.setTargetAtTime(freq * 1.5, t, 0.03);
    this.local.filter.frequency.setTargetAtTime(260 + rpm * 1700 + throttle * 1500, t, 0.05);
    this.local.gain.gain.setTargetAtTime(0.07 + throttle * 0.13 + rpm * 0.05, t, 0.05);

    if (this.skidGain && this.skidFilter) {
      // Ice hisses, asphalt squeals.
      this.skidFilter.frequency.setTargetAtTime(onIce ? 2600 : 1150 + slip * 500, t, 0.08);
      this.skidFilter.Q.setTargetAtTime(onIce ? 0.8 : 3.5, t, 0.08);
      const level = slip * Math.min(1, speed / 12) * (onIce ? 0.16 : 0.3);
      this.skidGain.gain.setTargetAtTime(level, t, 0.06);
    }
    this.windGain?.gain.setTargetAtTime(Math.min(0.32, (speed / 70) ** 2 * 0.32), t, 0.2);
    this.rumbleGain?.gain.setTargetAtTime(offroad * Math.min(1, speed / 10) * 0.7, t, 0.06);
  }

  /** Engine note of a nearby rival. `distance` in metres. */
  updateRemote(index: number, rpm: number, distance: number): void {
    const ctx = this.ctx;
    const voice = this.remotes[index];
    if (!ctx || !voice) return;
    const t = ctx.currentTime;
    const audible = this.racing && distance < 70;
    const freq = 50 + rpm * 200;
    voice.osc1.frequency.setTargetAtTime(freq, t, 0.05);
    voice.osc2.frequency.setTargetAtTime(freq * 0.5, t, 0.05);
    voice.filter.frequency.setTargetAtTime(300 + rpm * 1400, t, 0.08);
    const level = audible ? 0.09 / (1 + (distance / 9) ** 2) : 0;
    voice.gain.gain.setTargetAtTime(level, t, 0.1);
  }

  silenceRemote(index: number): void {
    const voice = this.remotes[index];
    if (this.ctx && voice) voice.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
  }

  // ------------------------------------------------------------ one-shots

  private tone(freq: number, start: number, duration: number, type: OscillatorType, level: number, glideTo?: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxBus) return;
    const t = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t + duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(level, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(gain).connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  private burst(start: number, duration: number, level: number, cutoff: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxBus || !this.noiseBuffer) return;
    const t = ctx.currentTime + start;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(level, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    source.connect(filter).connect(gain).connect(this.sfxBus);
    source.start(t, Math.random());
    source.stop(t + duration + 0.05);
  }

  countdown(final: boolean): void {
    if (final) this.tone(880, 0, 0.6, 'square', 0.22);
    else this.tone(440, 0, 0.18, 'square', 0.2);
  }

  checkpoint(): void {
    this.tone(990, 0, 0.09, 'sine', 0.22);
    this.tone(1320, 0.07, 0.12, 'sine', 0.2);
  }

  lap(best: boolean): void {
    const notes = best ? [660, 880, 1100, 1320] : [660, 880, 990];
    notes.forEach((f, i) => this.tone(f, i * 0.09, 0.16, 'triangle', 0.24));
  }

  finish(won: boolean): void {
    const notes = won ? [523, 659, 784, 1047, 784, 1047] : [523, 659, 784, 659];
    notes.forEach((f, i) => this.tone(f, i * 0.14, 0.26, 'triangle', 0.26));
  }

  impact(strength: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    // Scraping a wall reports many impacts; do not machine-gun the sound.
    if (ctx.currentTime - this.lastImpactAt < 0.12) return;
    this.lastImpactAt = ctx.currentTime;
    const level = Math.min(0.6, 0.12 + strength * 0.035);
    this.burst(0, 0.22, level, 900 + strength * 120);
    this.tone(95, 0, 0.2, 'sine', level, 45);
  }

  penalty(): void {
    this.tone(196, 0, 0.22, 'sawtooth', 0.18);
    this.tone(147, 0.2, 0.32, 'sawtooth', 0.18);
  }

  reset(): void {
    this.tone(300, 0, 0.25, 'sine', 0.2, 900);
  }

  overtake(gained: boolean): void {
    if (gained) this.tone(740, 0, 0.1, 'triangle', 0.16, 1100);
    else this.tone(520, 0, 0.12, 'triangle', 0.14, 380);
  }

  /** Two soft descending pips: the connection is struggling. */
  networkWarning(): void {
    this.tone(620, 0, 0.12, 'sine', 0.16);
    this.tone(410, 0.16, 0.16, 'sine', 0.16);
  }

  ui(kind: 'click' | 'join' | 'error' | 'ready'): void {
    switch (kind) {
      case 'click':
        this.tone(700, 0, 0.05, 'sine', 0.08);
        break;
      case 'join':
        this.tone(520, 0, 0.1, 'sine', 0.14);
        this.tone(780, 0.09, 0.14, 'sine', 0.14);
        break;
      case 'ready':
        this.tone(660, 0, 0.08, 'triangle', 0.14);
        this.tone(990, 0.08, 0.12, 'triangle', 0.14);
        break;
      case 'error':
        this.tone(220, 0, 0.2, 'square', 0.1);
        break;
    }
  }
}
