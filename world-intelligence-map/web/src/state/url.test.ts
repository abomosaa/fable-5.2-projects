import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTERS } from '../types';
import { decodeState, encodeState } from './url';

describe('shareable URL state', () => {
  it('round-trips map position, live window, layers and filters', () => {
    const state = {
      view: { zoom: 4.25, lat: 35.1234, lng: -120.5 },
      time: { mode: 'live' as const, windowSec: 604800 },
      layers: ['earthquakes', 'nws-warnings', 'wb-population'],
      filters: { ...DEFAULT_FILTERS, sources: ['usgs-earthquakes'], categories: ['earthquake', 'severe weather'], countries: ['USA', 'JPN'], sevMin: 2, sevMax: 4, sevUnknown: false, confMin: 0.5, confUnknown: false, fresh: ['fresh' as const, 'recent' as const], q: 'tōhoku & coast' },
      selected: 'usgs-earthquakes:us6000abcd',
      theme: 'light' as const,
      palette: 'cvd' as const,
    };
    const decoded = decodeState(encodeState(state));
    expect(decoded).toEqual(state);
  });

  it('round-trips a historical range with playback cursor and sliding window', () => {
    const state = {
      view: { zoom: 2, lat: 0, lng: 0 },
      time: { mode: 'range' as const, from: Date.UTC(2026, 10, 1), to: Date.UTC(2026, 10, 10, 12, 30), cursor: Date.UTC(2026, 10, 5, 6), windowSec: 86400 },
      layers: ['earthquakes'],
      filters: { ...DEFAULT_FILTERS },
    };
    const decoded = decodeState(encodeState(state));
    expect(decoded.time).toEqual(state.time);
    const cumulative = { ...state, time: { ...state.time, cursor: state.time.to, windowSec: 0 } };
    expect(decodeState(encodeState(cumulative)).time).toEqual(cumulative.time);
  });

  it('distinguishes "all layers off" from "layers not specified"', () => {
    const off = encodeState({ view: { zoom: 1, lat: 0, lng: 0 }, time: { mode: 'live', windowSec: 86400 }, layers: [], filters: { ...DEFAULT_FILTERS } });
    expect(off).toContain('&l=');
    expect(decodeState(off).layers).toEqual([]);
    expect(decodeState('#m=1.00/0.0000/0.0000').layers).toBeUndefined();
  });

  it('ignores malformed input instead of throwing', () => {
    expect(decodeState('#m=abc/1/2&t=nonsense&sev=9-1&conf=7&l=ok-layer,<script>,UPPER&fr=bogus,fresh&th=neon&cc=us,usa&q=%E0%A4%A')).toEqual({
      layers: ['ok-layer'],
      filters: { ...DEFAULT_FILTERS, fresh: ['fresh'], countries: ['USA'] },
    });
    expect(decodeState('')).toEqual({});
    expect(decodeState('#t=2026-11-10T00:00:00Z~2026-11-01T00:00:00Z').time).toBeUndefined(); // from after to
  });
});
