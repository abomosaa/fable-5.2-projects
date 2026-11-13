import { divergingRamp, sequentialRamp, type Theme } from '../palette';
import type { ChoroplethLayer } from '../types';
import { fmtNumber } from './format';

export interface ChoroClasses {
  /** Upper-exclusive thresholds between classes (length = colors.length - 1). */
  thresholds: number[];
  colors: string[];
  labels: string[];
}

/** Class breaks and colours for a choropleth layer. Sequential: quantile classes on one hue. Diverging: symmetric around zero. */
export function choroClasses(layer: ChoroplethLayer, theme: Theme): ChoroClasses | null {
  const values = Object.values(layer.values).map((x) => x.v);
  if (!values.length || layer.min == null || layer.max == null) return null;
  if (layer.scale === 'diverging') {
    const abs = values.map(Math.abs).sort((a, b) => a - b);
    const a = Math.max(abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.8))] ?? 0, 1e-9);
    const thresholds = [-a, -a / 4, a / 4, a];
    const colors = divergingRamp(theme);
    const f = (n: number) => fmtNumber(n);
    return { thresholds, colors, labels: [`< ${f(-a)}`, `${f(-a)} to ${f(-a / 4)}`, `${f(-a / 4)} to ${f(a / 4)}`, `${f(a / 4)} to ${f(a)}`, `≥ ${f(a)}`] };
  }
  const ramp = sequentialRamp(theme);
  const thresholds = layer.breaks.filter((b) => b > layer.min! && b <= layer.max!);
  const n = thresholds.length + 1;
  // spread the available classes over the ramp so few classes still use its full range
  const colors = Array.from({ length: n }, (_, i) => ramp[n === 1 ? 2 : Math.round((i * (ramp.length - 1)) / (n - 1))]!);
  const labels = Array.from({ length: n }, (_, i) => {
    if (n === 1) return fmtNumber(layer.min!);
    if (i === 0) return `< ${fmtNumber(thresholds[0]!)}`;
    if (i === n - 1) return `≥ ${fmtNumber(thresholds[n - 2]!)}`;
    return `${fmtNumber(thresholds[i - 1]!)} – ${fmtNumber(thresholds[i]!)}`;
  });
  return { thresholds, colors, labels };
}

export function classIndex(v: number, thresholds: number[]): number {
  let i = 0;
  while (i < thresholds.length && v >= thresholds[i]!) i++;
  return i;
}
