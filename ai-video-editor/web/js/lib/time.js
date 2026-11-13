// Client mirror of the core time model (crates/core/src/time.rs).
// All project times are integer ticks: 1 tick = 1/705 600 000 s. The server is the
// authority for every edit; the client only needs frame-grid math for snapping,
// display and preview playback.

export const TPS = 705_600_000;
export const TICKS_PER_MS = TPS / 1000;

export const FPS_PRESETS = [
  { label: '23.976', num: 24000, den: 1001 },
  { label: '24', num: 24, den: 1 },
  { label: '25', num: 25, den: 1 },
  { label: '29.97', num: 30000, den: 1001 },
  { label: '30', num: 30, den: 1 },
  { label: '50', num: 50, den: 1 },
  { label: '59.94', num: 60000, den: 1001 },
  { label: '60', num: 60, den: 1 },
];

export const fpsValue = (fps) => fps.num / fps.den;
export const fpsLabel = (fps) => {
  const hit = FPS_PRESETS.find((p) => p.num === fps.num && p.den === fps.den);
  return hit ? hit.label : (fps.num / fps.den).toFixed(3).replace(/\.?0+$/, '');
};

/** Duration of one frame in ticks (exact integer for every supported rate). */
export function frameTicks(fps) {
  const n = TPS * fps.den;
  if (n % fps.num === 0) return n / fps.num;
  return Number((BigInt(TPS) * BigInt(fps.den)) / BigInt(fps.num));
}

export function frameToTicks(frame, fps) {
  const n = TPS * fps.den;
  if (n % fps.num === 0) return frame * (n / fps.num);
  return Number((BigInt(frame) * BigInt(TPS) * BigInt(fps.den)) / BigInt(fps.num));
}

export function ticksToFrameFloor(t, fps) {
  const ft = frameTicks(fps);
  let f = Math.floor(t / ft);
  while (frameToTicks(f + 1, fps) <= t) f++;
  while (frameToTicks(f, fps) > t) f--;
  return f;
}

export function ticksToFrameRound(t, fps) {
  const f = ticksToFrameFloor(t, fps);
  const lo = frameToTicks(f, fps);
  const hi = frameToTicks(f + 1, fps);
  return t - lo >= hi - t ? f + 1 : f;
}

/** Snap ticks to the nearest frame boundary. */
export const snapToFrame = (t, fps) => frameToTicks(ticksToFrameRound(t, fps), fps);
export const snapToFrameFloor = (t, fps) => frameToTicks(ticksToFrameFloor(t, fps), fps);

export const secondsToTicks = (s) => Math.round(s * TPS);
export const ticksToSeconds = (t) => t / TPS;
export const msToTicks = (ms) => Math.round(ms * TICKS_PER_MS);

/** Non-drop timecode HH:MM:SS:FF. */
export function timecode(t, fps) {
  const neg = t < 0;
  const frame = ticksToFrameFloor(Math.abs(t), fps);
  const base = Math.max(1, Math.round(fps.num / fps.den));
  const ff = frame % base;
  const total = Math.floor(frame / base);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${neg ? '-' : ''}${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}:${pad(ff, base > 100 ? 3 : 2)}`;
}

/** Compact clock for labels: 1:05.3, 12:00, 1:02:03 */
export function clock(t, { tenths = false } = {}) {
  const s = Math.max(0, t) / TPS;
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const sec = s % 60;
  const ss = tenths ? sec.toFixed(1).padStart(4, '0') : String(Math.floor(sec)).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Human duration: "4.2 s", "1 min 5 s", "1 h 2 min". */
export function humanDuration(t) {
  const s = Math.max(0, t) / TPS;
  if (s < 10) return `${s.toFixed(1).replace(/\.0$/, '')} s`;
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

// ---- clip time mapping (mirrors Clip in crates/core/src/model.rs) -----------------
export const clipEnd = (c) => c.start + c.duration;
export const speedValue = (c) => c.speed.num / c.speed.den;
/** Timeline → source ticks (float precision is fine for preview/display). */
export const sourceTimeAt = (c, t) => c.source_in + ((t - c.start) * c.speed.num) / c.speed.den;
/** Source → timeline ticks. */
export const timelineTimeOf = (c, s) => c.start + ((s - c.source_in) * c.speed.den) / c.speed.num;
export const sourceOut = (c) => c.source_in + (c.duration * c.speed.num) / c.speed.den;
/** Constant shared by linked clips of one asset while they are in sync. */
export const syncAnchor = (c) => c.start - (c.source_in * c.speed.den) / c.speed.num;

// ---- resolved layer evaluation (mirrors Layer in crates/core/src/resolve.rs) ------
const ramp = (r, t) => (t <= r.start ? 0 : t >= r.end ? 1 : (t - r.start) / (r.end - r.start));
/** Opacity / gain multiplier of a layer at timeline time t. */
export function layerEnvelope(l, t) {
  let v = 1;
  if (l.fade_in) v *= ramp(l.fade_in, t);
  if (l.fade_out) v *= 1 - ramp(l.fade_out, t);
  return v;
}
/** Horizontal slide offset in frame widths at t. */
export function layerOffsetX(l, t) {
  let dx = 0;
  if (l.slide_in) dx += l.slide_in.dx * (1 - ramp(l.slide_in, t));
  if (l.slide_out) dx += l.slide_out.dx * ramp(l.slide_out, t);
  return dx;
}
export const layerSourceAt = (l, t) => l.source_start + ((t - l.start) * l.speed.num) / l.speed.den;
