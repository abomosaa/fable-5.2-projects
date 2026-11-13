// Timeline geometry: track lanes and coordinate conversions.
import { TPS } from '../lib/time.js';

export const RULER_H = 26;
export const HEADER_W = 132;
export const TRACK_H = { video: 58, audio: 50, caption: 30 };
export const LANE_GAP = 1;
export const HANDLE_W = 7;
export const SNAP_PX = 8;

/** Lanes in display order with their vertical position (content coordinates, below the ruler). */
export function lanes(doc) {
  const out = [];
  let y = 0;
  for (const track of doc.tracks) {
    const h = TRACK_H[track.kind] || 50;
    out.push({ track, y, h });
    y += h + LANE_GAP;
  }
  return out;
}

export const lanesHeight = (ls) => (ls.length ? ls[ls.length - 1].y + ls[ls.length - 1].h : 0);

/** Lane under a content-space y (clamped to the nearest lane). */
export function laneAt(ls, y) {
  if (!ls.length) return null;
  for (const l of ls) if (y < l.y + l.h + LANE_GAP) return l;
  return ls[ls.length - 1];
}

export const xOf = (t, view) => (t / TPS) * view.pxPerSec - view.scrollX;
export const tOf = (x, view) => ((x + view.scrollX) / view.pxPerSec) * TPS;
