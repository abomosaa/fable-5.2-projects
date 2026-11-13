import { shapeSvg } from '../map/icons';
import { hexToRgba, slotColor } from '../palette';
import { useStore } from '../state/store';
import type { LayerInfo } from '../types';

/** Legend / catalog swatch that mirrors how the layer is drawn on the map (shape + colour, line, area, ramp). */
export function LayerSymbol({ layer, size = 16 }: { layer: LayerInfo; size?: number }) {
  const theme = useStore((s) => s.theme);
  const palette = useStore((s) => s.palette);
  const color = slotColor(layer.render.color, theme, palette);
  const stroke = theme === 'dark' ? '#0c1117' : '#ffffff';
  const t = layer.render.type;
  if (t === 'line') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className="sym">
        <path d="M1 12 C5 2, 10 14, 15 4" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    );
  }
  if (t === 'polygon') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className="sym">
        <path d="M2 4 L11 2 L14 9 L8 14 L2 11 Z" fill={hexToRgba(color, 0.3)} stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
    );
  }
  if (t === 'choropleth') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className="sym">
        <rect x="1" y="3" width="4.4" height="10" fill={hexToRgba(color, 0.3)} />
        <rect x="5.8" y="3" width="4.4" height="10" fill={hexToRgba(color, 0.6)} />
        <rect x="10.6" y="3" width="4.4" height="10" fill={color} />
      </svg>
    );
  }
  if (t === 'heatmap') {
    const id = `hg-${layer.id}`;
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className="sym">
        <defs>
          <radialGradient id={id}>
            <stop offset="0" stopColor="#fff" />
            <stop offset="0.35" stopColor={color} />
            <stop offset="1" stopColor={hexToRgba(color, 0)} />
          </radialGradient>
        </defs>
        <circle cx="8" cy="8" r="8" fill={`url(#${id})`} />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className="sym">
      <path d={shapeSvg(layer.render.shape ?? 'circle')} fill={color} stroke={stroke} strokeWidth="3" strokeLinejoin="round" />
    </svg>
  );
}

const STATUS_META: Record<string, { label: string; cls: string; icon: string }> = {
  healthy: { label: 'Healthy', cls: 'good', icon: '✓' },
  delayed: { label: 'Delayed', cls: 'warning', icon: '◷' },
  rate_limited: { label: 'Rate limited', cls: 'warning', icon: '⏸' },
  stale: { label: 'Stale', cls: 'serious', icon: '!' },
  unavailable: { label: 'Unavailable', cls: 'critical', icon: '✕' },
  misconfigured: { label: 'Not configured', cls: 'neutral', icon: '⚙' },
  pending: { label: 'Pending', cls: 'neutral', icon: '…' },
  disabled: { label: 'Disabled', cls: 'neutral', icon: '–' },
};

/** Status is always icon + label, never colour alone. */
export function StatusBadge({ status, compact }: { status: string; compact?: boolean }) {
  const m = STATUS_META[status] ?? STATUS_META.pending!;
  return (
    <span className={`status ${m.cls} ${compact ? 'compact' : ''}`} data-status={status} title={m.label}>
      <span className="status-icon" aria-hidden="true">{m.icon}</span>
      {compact ? <span className="sr-only">{m.label}</span> : <span>{m.label}</span>}
    </span>
  );
}

export function statusLabel(status: string): string {
  return (STATUS_META[status] ?? STATUS_META.pending!).label;
}
