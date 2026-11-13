/**
 * Tiny DOM helpers. User-controlled text only ever reaches the page through
 * `textContent` (never innerHTML), so names and chat cannot inject markup.
 */
import type { Track } from '../../../shared/sim/track';

type Child = Node | string | number | null | undefined | false;

export interface Props {
  class?: string;
  text?: string;
  title?: string;
  id?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  maxLength?: number;
  min?: number;
  max?: number;
  step?: number;
  checked?: boolean;
  disabled?: boolean;
  role?: string;
  tabIndex?: number;
  for?: string;
  autocomplete?: string;
  spellcheck?: boolean;
  aria?: Record<string, string>;
  data?: Record<string, string>;
  style?: Partial<CSSStyleDeclaration>;
  onClick?: (event: MouseEvent) => void;
  onInput?: (event: Event) => void;
  onChange?: (event: Event) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  onSubmit?: (event: SubmitEvent) => void;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props.class) element.className = props.class;
  if (props.text !== undefined) element.textContent = props.text;
  if (props.title) element.title = props.title;
  if (props.id) element.id = props.id;
  if (props.role) element.setAttribute('role', props.role);
  if (props.tabIndex !== undefined) element.tabIndex = props.tabIndex;
  if (props.for) element.setAttribute('for', props.for);
  if (props.aria) for (const [key, value] of Object.entries(props.aria)) element.setAttribute(`aria-${key}`, value);
  if (props.data) for (const [key, value] of Object.entries(props.data)) element.dataset[key] = value;
  if (props.style) Object.assign(element.style, props.style);
  if (element instanceof HTMLInputElement || element instanceof HTMLButtonElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
    if (props.disabled !== undefined) element.disabled = props.disabled;
  }
  if (element instanceof HTMLInputElement) {
    if (props.type) element.type = props.type;
    if (props.placeholder) element.placeholder = props.placeholder;
    if (props.maxLength !== undefined) element.maxLength = props.maxLength;
    if (props.min !== undefined) element.min = String(props.min);
    if (props.max !== undefined) element.max = String(props.max);
    if (props.step !== undefined) element.step = String(props.step);
    if (props.value !== undefined) element.value = props.value;
    if (props.checked !== undefined) element.checked = props.checked;
    if (props.autocomplete) element.autocomplete = props.autocomplete as AutoFill;
    if (props.spellcheck !== undefined) element.spellcheck = props.spellcheck;
  } else if (element instanceof HTMLButtonElement) {
    element.type = (props.type as 'button' | 'submit' | undefined) ?? 'button';
  }
  if (props.onClick) element.addEventListener('click', props.onClick as EventListener);
  if (props.onInput) element.addEventListener('input', props.onInput);
  if (props.onChange) element.addEventListener('change', props.onChange);
  if (props.onKeyDown) element.addEventListener('keydown', props.onKeyDown as EventListener);
  if (props.onSubmit) element.addEventListener('submit', props.onSubmit as EventListener);
  append(element, children);
  return element;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
}

export function clear(element: Element): void {
  while (element.firstChild) element.removeChild(element.firstChild);
}

/** Sets text only when it changed, to keep per-frame HUD updates cheap. */
export function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

export function toggleClass(element: Element, name: string, on: boolean): void {
  if (element.classList.contains(name) !== on) element.classList.toggle(name, on);
}

export function select<T extends string>(options: ReadonlyArray<{ value: T; label: string }>, value: T, onChange: (value: T) => void, props: Props = {}): HTMLSelectElement {
  const element = h('select', props);
  for (const option of options) {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    element.appendChild(node);
  }
  element.value = value;
  element.addEventListener('change', () => onChange(element.value as T));
  return element;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A small inline icon from a fixed, hard-coded path set. */
export function icon(name: keyof typeof ICONS, size = 18): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name]);
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  return svg;
}

export const ICONS = {
  gear: 'M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.500 7.500 0 0 0-1.700 1l-2.400-1-2 3.400 2 1.600a7.600 7.600 0 0 0 0 2l-2 1.600 2 3.400 2.400-1a7.500 7.500 0 0 0 1.700 1l.4 2.500h4l.4-2.500a7.500 7.500 0 0 0 1.700-1l2.400 1 2-3.400zM13 15.200a3.200 3.200 0 1 1 0-6.400 3.200 3.200 0 0 1 0 6.400z',
  crown: 'M3 8l4.500 4L12 5l4.500 7L21 8l-2 10H5z',
  check: 'M9.500 16.200L5.300 12l-1.400 1.400 5.600 5.600 11-11-1.400-1.400z',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm1 9.600l3.200 1.900-.8 1.300L11 13.300V7h2z',
  eye: 'M12 5C6.500 5 2.700 9.500 1.500 12c1.200 2.500 5 7 10.500 7s9.300-4.500 10.500-7C21.300 9.500 17.500 5 12 5zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-2.200a1.800 1.800 0 1 0 0-3.600 1.800 1.800 0 0 0 0 3.600z',
  wheel: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 3a7 7 0 0 1 6.700 5H5.300A7 7 0 0 1 12 5zm-7 7.500l5 1.300V19A7 7 0 0 1 5 12.500zm9 6.500v-5.200l5-1.300a7 7 0 0 1-5 6.500z',
  bot: 'M11 2h2v3h4a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3h4zM8.500 10a1.500 1.500 0 1 0 0 3 1.500 1.500 0 0 0 0-3zm7 0a1.500 1.500 0 1 0 0 3 1.500 1.500 0 0 0 0-3zM8 15v1.500h8V15z',
  link: 'M10.600 13.400a1 1 0 0 1 0-1.400l3.500-3.500a3 3 0 1 1 4.200 4.200l-1.700 1.800-1.500-1.500 1.800-1.700a1 1 0 0 0-1.400-1.400L12 13.400a1 1 0 0 1-1.400 0zm2.800-2.800a1 1 0 0 1 0 1.400l-3.500 3.500a3 3 0 1 1-4.200-4.200l1.700-1.800 1.500 1.500-1.800 1.700a1 1 0 0 0 1.400 1.400l3.500-3.500a1 1 0 0 1 1.400 0z',
  refresh: 'M17.600 6.400A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.800-4.200L13 11h7V4z',
  warning: 'M12 2L1 21h22zm1 15h-2v-2h2zm0-4h-2V9h2z',
  signal: 'M3 18h3v3H3zm5-4h3v7H8zm5-5h3v12h-3zm5-6h3v18h-3z',
  x: 'M18.300 5.700L12 12l6.300 6.300-1.400 1.400L10.600 13.400 4.300 19.700l-1.400-1.400L9.200 12 2.900 5.700l1.400-1.400 6.300 6.300 6.300-6.300z',
  flag: 'M5 3v18h2v-7h11l-2-4 2-4H7V3z',
  volume: 'M4 9v6h4l5 4V5L8 9zm11.500 3a4 4 0 0 0-2-3.500v7a4 4 0 0 0 2-3.500z',
  mute: 'M4 9v6h4l5 4V5L8 9zm15.300.700L17.600 11l1.700 1.700-1.300 1.300-1.700-1.700-1.700 1.700-1.300-1.300 1.700-1.700-1.700-1.700 1.300-1.300 1.700 1.700 1.700-1.700z',
  play: 'M7 4v16l13-8z',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM1 20v-2c0-2.700 5.300-4 8-4s8 1.300 8 4v2zm18 0v-2c0-1.200-.600-2.200-1.600-3 2.300.300 5.600 1.400 5.600 3v2z',
} as const;

/** Formats milliseconds as m:ss.mmm. */
export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '-:--.---';
  const total = Math.round(ms);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/** Formats a signed gap in seconds, e.g. "+1.234" / "-0.050". */
export function formatDelta(ms: number): string {
  const sign = ms < 0 ? '-' : '+';
  return `${sign}${(Math.abs(ms) / 1000).toFixed(3)}`;
}

export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export function colourHex(colour: number): string {
  return `#${colour.toString(16).padStart(6, '0')}`;
}

/** Draws a track outline into a canvas (used for thumbnails and the minimap). */
export function drawTrackOutline(canvas: HTMLCanvasElement, track: Track, options: { road: string; edge: string; line: string; padding?: number }): { scale: number; offsetX: number; offsetZ: number } {
  const ctx = canvas.getContext('2d');
  const padding = options.padding ?? 10;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < track.n; i++) {
    minX = Math.min(minX, track.px[i]!);
    maxX = Math.max(maxX, track.px[i]!);
    minZ = Math.min(minZ, track.pz[i]!);
    maxZ = Math.max(maxZ, track.pz[i]!);
  }
  const scale = Math.min((canvas.width - padding * 2) / (maxX - minX), (canvas.height - padding * 2) / (maxZ - minZ));
  const offsetX = (canvas.width - (maxX - minX) * scale) / 2 - minX * scale;
  const offsetZ = (canvas.height - (maxZ - minZ) * scale) / 2 - minZ * scale;
  if (!ctx) return { scale, offsetX, offsetZ };
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const path = (): void => {
    ctx.beginPath();
    for (let i = 0; i <= track.n; i++) {
      const k = i % track.n;
      const x = track.px[k]! * scale + offsetX;
      const y = track.pz[k]! * scale + offsetZ;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  };
  path();
  ctx.strokeStyle = options.edge;
  ctx.lineWidth = Math.max(5, track.halfWidth * 2 * scale + 4);
  ctx.stroke();
  path();
  ctx.strokeStyle = options.road;
  ctx.lineWidth = Math.max(3, track.halfWidth * 2 * scale);
  ctx.stroke();
  // Start/finish line.
  const start = track.gates[0]!;
  const span = Math.max(5, track.halfWidth * scale + 3);
  ctx.strokeStyle = options.line;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(start.cx * scale + offsetX + start.tz * span, start.cz * scale + offsetZ - start.tx * span);
  ctx.lineTo(start.cx * scale + offsetX - start.tz * span, start.cz * scale + offsetZ + start.tx * span);
  ctx.stroke();
  return { scale, offsetX, offsetZ };
}
