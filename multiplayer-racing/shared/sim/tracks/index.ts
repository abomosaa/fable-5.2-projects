import { buildTrack, type Track, type TrackDef } from '../track';
import { GLACIER } from './glacier';
import { HARBOR } from './harbor';

export const TRACK_DEFS: readonly TrackDef[] = [HARBOR, GLACIER];
export const TRACK_IDS: readonly string[] = TRACK_DEFS.map((d) => d.id);
export const DEFAULT_TRACK_ID = HARBOR.id;

const cache = new Map<string, Track>();

export function isTrackId(id: string): boolean {
  return TRACK_IDS.includes(id);
}

export function getTrackDef(id: string): TrackDef {
  const def = TRACK_DEFS.find((d) => d.id === id);
  if (!def) throw new Error(`Unknown track: ${id}`);
  return def;
}

/** Builds (once) and returns the immutable geometry of a track. */
export function getTrack(id: string): Track {
  let track = cache.get(id);
  if (!track) {
    track = buildTrack(getTrackDef(id));
    cache.set(id, track);
  }
  return track;
}
