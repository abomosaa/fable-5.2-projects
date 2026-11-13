/**
 * Colour system.
 *
 * Layers reference named colour slots; this module resolves a slot to a concrete colour for the active
 * theme (light / dark surface) and palette:
 *   standard – eight validated categorical hues (each stepped separately for light and dark surfaces) + brown/grey
 *   cvd      – Okabe–Ito hues, chosen for colour-vision-deficiency separation
 * With dozens of layers no palette can keep every pair distinguishable by hue alone, so colour is never the only
 * channel: every layer also has a symbol shape, a legend entry and its name in tooltips and lists.
 * Magnitude (choropleths, heat maps) always uses a single-hue light→dark ramp; polarity uses blue↔red around grey.
 */
import type { SlotColor } from './types';

export type Theme = 'dark' | 'light';
export type PaletteMode = 'standard' | 'cvd';

const STANDARD: Record<Theme, Record<SlotColor, string>> = {
  light: { blue: '#2a78d6', orange: '#eb6834', teal: '#1baf7a', yellow: '#eda100', pink: '#e87ba4', green: '#008300', purple: '#6250d6', red: '#e34948', brown: '#8a5a2b', gray: '#6b6a66' },
  dark: { blue: '#3987e5', orange: '#d95926', teal: '#199e70', yellow: '#c98500', pink: '#d55181', green: '#008300', purple: '#9085e9', red: '#e66767', brown: '#a9774a', gray: '#9c9b94' },
};

const CVD: Record<Theme, Record<SlotColor, string>> = {
  light: { blue: '#0072B2', orange: '#E69F00', teal: '#009E73', yellow: '#B8A800', pink: '#CC79A7', green: '#4C8C2B', purple: '#7A5FA8', red: '#D55E00', brown: '#7B4B1E', gray: '#666666' },
  dark: { blue: '#56B4E9', orange: '#E69F00', teal: '#009E73', yellow: '#F0E442', pink: '#CC79A7', green: '#7FBF5A', purple: '#A893D6', red: '#D55E00', brown: '#B08050', gray: '#A0A0A0' },
};

export function slotColor(slot: SlotColor, theme: Theme, palette: PaletteMode): string {
  return (palette === 'cvd' ? CVD : STANDARD)[theme][slot] ?? '#888888';
}

/** Single-hue sequential ramp (5 classes). On a dark surface the low end recedes into the surface. */
export function sequentialRamp(theme: Theme): string[] {
  const light = ['#cde2fb', '#86b6ef', '#3987e5', '#1c5cab', '#0d366b'];
  const dark = ['#12365f', '#1c5cab', '#3987e5', '#86b6ef', '#dcebfd'];
  return theme === 'dark' ? dark : light;
}

/** Diverging ramp: blue (negative) ↔ red (positive) around a neutral grey midpoint. */
export function divergingRamp(theme: Theme): string[] {
  return theme === 'dark' ? ['#3987e5', '#1f4f8f', '#383835', '#96383a', '#e66767'] : ['#1c5cab', '#86b6ef', '#e6e5e1', '#f0a09f', '#c83838'];
}

export const STATUS_COLORS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b', neutral: '#8a8a86' } as const;

export function surface(theme: Theme): { water: string; land: string; border: string; label: string; halo: string; graticule: string; ink: string } {
  return theme === 'dark'
    ? { water: '#0c1117', land: '#1b222b', border: '#3b4654', label: '#aab4c0', halo: '#0c1117', graticule: '#161d26', ink: '#f0efec' }
    : { water: '#dfe9f2', land: '#fbfbf8', border: '#b3bcc6', label: '#4a535e', halo: '#fbfbf8', graticule: '#d3dee9', ink: '#0b0b0b' };
}

export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
