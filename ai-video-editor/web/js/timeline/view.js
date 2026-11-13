// Timeline viewport helpers shared by the timeline, the toolbar and shortcuts.
import { setView, store } from '../state/store.js';
import { TPS } from '../lib/time.js';
import { transport } from '../player/transport.js';

export const MIN_PX_PER_SEC = 0.5;
export const MAX_PX_PER_SEC = 1200;
/** Width of the scrollable tracks area in CSS px (kept up to date by the timeline). */
export const viewport = { width: 800, height: 240 };

const clampZoom = (z) => Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, z));
export const ticksToPx = (t, pxPerSec = store.state.view.pxPerSec) => (t / TPS) * pxPerSec;
export const pxToTicks = (px, pxPerSec = store.state.view.pxPerSec) => (px / pxPerSec) * TPS;

/** Total scrollable width: the timeline plus generous room to drop clips after the end. */
export function contentWidth(state = store.state) {
  return ticksToPx(state.duration, state.view.pxPerSec) + Math.max(viewport.width * 0.6, 240);
}

export function clampScrollX(x, state = store.state) {
  return Math.max(0, Math.min(x, Math.max(0, contentWidth(state) - viewport.width)));
}

/** Zoom keeping the timeline position under `anchorPx` (default: the playhead, else centre) fixed. */
export function zoomTo(pxPerSec, anchorPx) {
  const { view } = store.state;
  const z = clampZoom(pxPerSec);
  if (z === view.pxPerSec) return;
  if (anchorPx == null) {
    const ph = ticksToPx(transport.time, view.pxPerSec) - view.scrollX;
    anchorPx = ph >= 0 && ph <= viewport.width ? ph : viewport.width / 2;
  }
  const t = pxToTicks(view.scrollX + anchorPx, view.pxPerSec);
  setView({ pxPerSec: z });
  setView({ scrollX: clampScrollX(ticksToPx(t, z) - anchorPx) });
}

export const zoomBy = (factor, anchorPx) => zoomTo(store.state.view.pxPerSec * factor, anchorPx);

export function zoomToFit() {
  const d = store.state.duration;
  const z = d > 0 ? clampZoom(((viewport.width - 48) / (d / TPS)) * 1) : 80;
  setView({ pxPerSec: z, scrollX: 0 });
}

/** Scroll horizontally so timeline time t is visible (with a margin). */
export function revealTime(t, { center = false } = {}) {
  const { view } = store.state;
  const x = ticksToPx(t, view.pxPerSec);
  const margin = Math.min(80, viewport.width / 5);
  if (center) return setView({ scrollX: clampScrollX(x - viewport.width / 2) });
  if (x < view.scrollX + margin) setView({ scrollX: clampScrollX(x - margin) });
  else if (x > view.scrollX + viewport.width - margin) setView({ scrollX: clampScrollX(x - viewport.width + margin) });
}
