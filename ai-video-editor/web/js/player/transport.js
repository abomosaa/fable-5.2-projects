// Transport: the master timeline clock.
//
// The playhead position is the single source of truth for "where are we" — the
// timeline, the monitor, the transcript highlight and every media element follow
// it. It advances from a monotonic clock (performance.now) so it is frame-accurate
// and never drifts with decoder hiccups; media elements are slaved to it by the
// preview engine (player/engine.js), which may `stall()` the clock briefly while a
// source is still seeking so picture and sound stay in sync across cuts.

import { store } from '../state/store.js';
import { frameTicks, snapToFrame, TPS } from '../lib/time.js';

const listeners = new Set();
let time = 0; // ticks
let playing = false;
let rate = 1; // shuttle speed, may be negative
let stalled = false;
let raf = 0;
let lastNow = 0;
let loop = false;

const fps = () => store.state.doc?.settings.fps || { num: 30, den: 1 };
const duration = () => store.state.duration || 0;

function emit() {
  for (const fn of [...listeners]) fn(transport);
}

function tick(now) {
  raf = 0;
  if (!playing) return;
  const dt = Math.min(0.1, (now - lastNow) / 1000); // clamp long pauses (tab switch)
  lastNow = now;
  if (!stalled) {
    let t = time + dt * TPS * rate;
    const end = duration();
    if (rate > 0 && t >= end) {
      if (loop && end > 0) t = 0;
      else {
        time = end;
        playing = false;
        rate = 1;
        emit();
        return;
      }
    } else if (rate < 0 && t <= 0) {
      time = 0;
      playing = false;
      rate = 1;
      emit();
      return;
    }
    time = t;
  }
  emit();
  raf = requestAnimationFrame(tick);
}

export const transport = {
  /** Current timeline position in ticks (fractional while playing, frame-aligned when paused). */
  get time() {
    return time;
  },
  /** Position snapped to the frame grid (use for edits and display). */
  get frameTime() {
    return snapToFrame(Math.max(0, time), fps());
  },
  get playing() {
    return playing;
  },
  get rate() {
    return rate;
  },
  get stalled() {
    return stalled;
  },
  get loop() {
    return loop;
  },
  set loop(v) {
    loop = !!v;
    emit();
  },
  /** fn(transport) is called on every time or state change (≈ once per display frame while playing). */
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  play(r = 1) {
    if (!store.state.doc) return;
    if (r > 0 && time >= duration() - 1) time = 0; // restart from the top at the end
    rate = r;
    if (!playing) {
      playing = true;
      lastNow = performance.now();
      if (!raf) raf = requestAnimationFrame(tick);
    }
    emit();
  },
  pause() {
    if (!playing && rate === 1) return;
    playing = false;
    rate = 1;
    stalled = false;
    time = snapToFrame(Math.max(0, time), fps());
    emit();
  },
  toggle() {
    playing ? transport.pause() : transport.play();
  },
  /** Jump to a timeline position (clamped; snapped to the frame grid unless snap=false). */
  seek(t, { snap = true } = {}) {
    const max = Math.max(duration(), 0);
    let v = Math.min(Math.max(0, t), max);
    if (snap) v = Math.min(snapToFrame(v, fps()), snapToFrame(max, fps()));
    if (v === time) return;
    time = v;
    lastNow = performance.now();
    emit();
  },
  stepFrames(n) {
    if (playing) transport.pause();
    transport.seek(transport.frameTime + n * frameTicks(fps()));
  },
  /** J/K/L shuttle: repeated presses in one direction double the speed (1×, 2×, 4×, 8×). */
  shuttle(dir) {
    if (dir === 0) return transport.pause();
    const same = playing && Math.sign(rate) === dir;
    const next = same ? Math.min(8, Math.abs(rate) * 2) * dir : dir;
    transport.play(next);
  },
  /** Engine hook: freeze the clock while media catches up (does not change `playing`). */
  stall(v) {
    if (stalled === !!v) return;
    stalled = !!v;
    lastNow = performance.now();
    emit();
  },
  /** Reset when a project is closed. */
  reset(t = 0) {
    playing = false;
    rate = 1;
    stalled = false;
    time = Math.max(0, t);
    emit();
  },
};
