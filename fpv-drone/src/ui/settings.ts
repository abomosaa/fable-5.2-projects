/** User settings, persisted in localStorage. */
import { FcConfig, FlightMode, DEFAULT_RATES } from '../sim/fc';
import { EnvSettings, DEFAULT_ENV } from '../sim/environment';
import { PadConfig } from '../input/input';
import type { CameraMode, Quality } from '../render/view';

export interface Settings {
  drone: string;
  /** Starting spot id (see MapData.spawns). */
  spawn: string;
  mode: FlightMode;
  rates: FcConfig['rates'];
  throttleMid: number;
  throttleExpo: number;
  throttleLimit: number;
  airmode: boolean;
  /** FPV camera uptilt [deg]. */
  cameraTilt: number;
  /** Horizontal field of view on a 16:9 frame [deg]. */
  fov: number;
  /** 0 = rectilinear .. 1 = fisheye. */
  lens: number;
  view: CameraMode;
  quality: Quality;
  volume: number;
  env: EnvSettings;
  damage: boolean;
  timeScale: number;
  osd: { visible: boolean; horizon: boolean; sticks: boolean; telemetry: boolean; gateMarker: boolean };
  keyboardDeflection: number;
  pads: Record<string, PadConfig>;
}

export function defaultSettings(): Settings {
  return {
    drone: 'freestyle5',
    spawn: 'pad',
    mode: 'angle',
    rates: JSON.parse(JSON.stringify(DEFAULT_RATES)),
    throttleMid: 0.5,
    throttleExpo: 0,
    throttleLimit: 1,
    airmode: true,
    cameraTilt: 25,
    fov: 120,
    lens: 0.35,
    view: 'fpv',
    quality: 'high',
    volume: 0.6,
    env: { ...DEFAULT_ENV },
    damage: true,
    timeScale: 1,
    osd: { visible: true, horizon: false, sticks: true, telemetry: false, gateMarker: true },
    keyboardDeflection: 0.5,
    pads: {},
  };
}

const KEY = 'fpv-sim-settings-v1';

function merge<T>(base: T, over: unknown): T {
  if (over === null || typeof over !== 'object' || typeof base !== 'object' || base === null) {
    return (typeof over === typeof base ? over : base) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    if (k in out) out[k] = merge(out[k], v);
    else out[k] = v; // free-form maps (pads)
  }
  return out as T;
}

export function loadSettings(): Settings {
  const def = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return def;
    return merge(def, JSON.parse(raw));
  } catch {
    return def;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: settings just do not persist */
  }
}
