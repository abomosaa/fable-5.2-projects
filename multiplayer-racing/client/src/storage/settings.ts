/**
 * Player preferences, persisted in localStorage. Everything read back from
 * storage is validated, so a corrupt or outdated entry can never break the game.
 */
import { NAME_MAX } from '../../../shared/constants';
import { sanitizeText } from '../../../shared/protocol/sanitize';

export const ACTIONS = ['accelerate', 'brake', 'left', 'right', 'handbrake', 'reset', 'camera', 'pause'] as const;
export type Action = (typeof ACTIONS)[number];

export const ACTION_LABELS: Record<Action, string> = {
  accelerate: 'Accelerate',
  brake: 'Brake / Reverse',
  left: 'Steer left',
  right: 'Steer right',
  handbrake: 'Handbrake (drift)',
  reset: 'Reset to track',
  camera: 'Change camera',
  pause: 'Menu',
};

export const PAD_ACTIONS = ['accelerate', 'brake', 'handbrake', 'reset', 'camera', 'pause'] as const;
export type PadAction = (typeof PAD_ACTIONS)[number];

export const CAMERA_MODES = ['chase', 'far', 'hood', 'top'] as const;
export type CameraMode = (typeof CAMERA_MODES)[number];
export const CAMERA_LABELS: Record<CameraMode, string> = {
  chase: 'Chase',
  far: 'Far chase',
  hood: 'Hood',
  top: 'Top-down',
};

export const QUALITY_LEVELS = ['low', 'medium', 'high'] as const;
export type Quality = (typeof QUALITY_LEVELS)[number];

export interface Settings {
  name: string;
  masterVolume: number;
  engineVolume: number;
  sfxVolume: number;
  muted: boolean;
  camera: CameraMode;
  reducedMotion: boolean;
  quality: Quality;
  units: 'kmh' | 'mph';
  nameTags: boolean;
  netStats: boolean;
  /** KeyboardEvent.code values, up to two per action. */
  keys: Record<Action, string[]>;
  /** Standard-mapping gamepad button indices. */
  pad: Record<PadAction, number>;
  padDeadzone: number;
}

export const DEFAULT_KEYS: Record<Action, string[]> = {
  accelerate: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
  reset: ['KeyR'],
  camera: ['KeyC'],
  pause: ['Escape'],
};

export const DEFAULT_PAD: Record<PadAction, number> = {
  accelerate: 7, // right trigger
  brake: 6, // left trigger
  handbrake: 0, // A / cross
  reset: 3, // Y / triangle
  camera: 2, // X / square
  pause: 9, // start
};

const STORAGE_KEY = 'apex-drift.settings.v1';

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function defaultSettings(): Settings {
  return {
    name: '',
    masterVolume: 0.7,
    engineVolume: 0.6,
    sfxVolume: 0.8,
    muted: false,
    camera: 'chase',
    reducedMotion: prefersReducedMotion(),
    quality: 'medium',
    units: 'kmh',
    nameTags: true,
    netStats: false,
    keys: structuredClone(DEFAULT_KEYS),
    pad: { ...DEFAULT_PAD },
    padDeadzone: 0.12,
  };
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === 'string' && (options as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function loadSettings(): Settings {
  const settings = defaultSettings();
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    return settings;
  }
  if (typeof raw !== 'object' || raw === null) return settings;
  const data = raw as Record<string, unknown>;
  if (typeof data.name === 'string') settings.name = sanitizeText(data.name, NAME_MAX);
  settings.masterVolume = num(data.masterVolume, settings.masterVolume, 0, 1);
  settings.engineVolume = num(data.engineVolume, settings.engineVolume, 0, 1);
  settings.sfxVolume = num(data.sfxVolume, settings.sfxVolume, 0, 1);
  settings.muted = bool(data.muted, settings.muted);
  settings.camera = oneOf(data.camera, CAMERA_MODES, settings.camera);
  settings.reducedMotion = bool(data.reducedMotion, settings.reducedMotion);
  settings.quality = oneOf(data.quality, QUALITY_LEVELS, settings.quality);
  settings.units = oneOf(data.units, ['kmh', 'mph'] as const, settings.units);
  settings.nameTags = bool(data.nameTags, settings.nameTags);
  settings.netStats = bool(data.netStats, settings.netStats);
  settings.padDeadzone = num(data.padDeadzone, settings.padDeadzone, 0, 0.6);
  if (typeof data.keys === 'object' && data.keys !== null) {
    const keys = data.keys as Record<string, unknown>;
    for (const action of ACTIONS) {
      const list = keys[action];
      if (!Array.isArray(list)) continue;
      const codes = list.filter((c): c is string => typeof c === 'string' && c.length > 0 && c.length < 32).slice(0, 2);
      settings.keys[action] = codes;
    }
  }
  if (typeof data.pad === 'object' && data.pad !== null) {
    const pad = data.pad as Record<string, unknown>;
    for (const action of PAD_ACTIONS) {
      const index = pad[action];
      if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < 32) settings.pad[action] = index;
    }
  }
  return settings;
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage full or disabled: preferences just will not persist.
  }
}

/** A friendly default name so nobody has to type before their first race. */
export function randomDriverName(): string {
  const first = ['Swift', 'Lucky', 'Rapid', 'Bold', 'Sly', 'Brave', 'Wild', 'Calm', 'Keen', 'Zippy'];
  const second = ['Falcon', 'Otter', 'Comet', 'Badger', 'Lynx', 'Heron', 'Viper', 'Moose', 'Gecko', 'Raven'];
  const pick = (list: string[]): string => list[Math.floor(Math.random() * list.length)]!;
  return `${pick(first)} ${pick(second)}`.slice(0, NAME_MAX);
}

/** Human readable label for a KeyboardEvent.code. */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  const names: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Space: 'Space',
    Escape: 'Esc',
    ShiftLeft: 'L Shift',
    ShiftRight: 'R Shift',
    ControlLeft: 'L Ctrl',
    ControlRight: 'R Ctrl',
    AltLeft: 'L Alt',
    AltRight: 'R Alt',
    Enter: 'Enter',
    Backspace: 'Backspace',
    Tab: 'Tab',
  };
  return names[code] ?? code;
}

/** Per-tab storage for the reconnect credential, so two tabs are two players. */
export function tabSessionStore(): { load(): { code: string; token: string } | null; save(s: { code: string; token: string }): void; clear(): void } {
  const KEY = 'apex-drift.session.v1';
  return {
    load() {
      try {
        const raw: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
        if (typeof raw !== 'object' || raw === null) return null;
        const { code, token } = raw as Record<string, unknown>;
        if (typeof code !== 'string' || typeof token !== 'string') return null;
        if (!/^[A-Z0-9]{5}$/.test(code) || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
        return { code, token };
      } catch {
        return null;
      }
    },
    save(session) {
      try {
        sessionStorage.setItem(KEY, JSON.stringify(session));
      } catch {
        // Without storage a reload simply cannot resume.
      }
    },
    clear() {
      try {
        sessionStorage.removeItem(KEY);
      } catch {
        // Ignore.
      }
    },
  };
}
