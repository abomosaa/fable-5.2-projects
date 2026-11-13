/**
 * Unit system.
 *
 * INTERNAL CONSISTENT SYSTEM: millimetre – kilogram – second – radian.
 * Every number stored in a project file or used inside the solver is in this
 * system. Derived units follow without any hidden factors:
 *
 *   force      kg·mm/s²        = mN
 *   torque     mN·mm
 *   energy     mN·mm           = µJ
 *   power      mN·mm/s         = µW
 *   stiffness  mN/mm           = N/m
 *   density    kg/mm³
 *   inertia    kg·mm²
 *
 * Conversion to and from display units happens ONLY here.
 */

export type QuantityKind =
  | 'length' | 'angle' | 'mass' | 'time' | 'force' | 'torque'
  | 'speed' | 'angularSpeed' | 'acceleration' | 'angularAcceleration'
  | 'stiffness' | 'torsionStiffness' | 'damping' | 'rotDamping'
  | 'density' | 'power' | 'energy' | 'inertia' | 'area' | 'volume'
  | 'frequency' | 'ratio' | 'count';

/** factor: 1 display unit = factor internal units */
export const UNIT_TABLE: Record<QuantityKind, Record<string, number>> = {
  length: { mm: 1, cm: 10, m: 1000, in: 25.4, 'µm': 0.001 },
  angle: { rad: 1, deg: Math.PI / 180, rev: 2 * Math.PI },
  mass: { kg: 1, g: 1e-3, lb: 0.45359237, oz: 0.028349523125 },
  time: { s: 1, ms: 1e-3, min: 60 },
  force: { mN: 1, N: 1000, kN: 1e6, lbf: 4448.2216152605, gf: 9.80665 },
  torque: {
    'mN·mm': 1, 'N·mm': 1000, 'N·cm': 1e4, 'N·m': 1e6, 'mN·m': 1000,
    'lbf·in': 4448.2216152605 * 25.4, 'kgf·cm': 98066.5,
  },
  speed: { 'mm/s': 1, 'm/s': 1000, 'in/s': 25.4 },
  angularSpeed: { 'rad/s': 1, 'deg/s': Math.PI / 180, rpm: (2 * Math.PI) / 60 },
  acceleration: { 'mm/s²': 1, 'm/s²': 1000, g: 9806.65, 'in/s²': 25.4 },
  angularAcceleration: { 'rad/s²': 1, 'deg/s²': Math.PI / 180 },
  stiffness: { 'N/m': 1, 'mN/mm': 1, 'N/mm': 1000, 'lbf/in': 4448.2216152605 / 25.4 },
  torsionStiffness: {
    'mN·mm/rad': 1, 'N·mm/rad': 1000, 'N·m/rad': 1e6, 'N·mm/deg': (1000 * 180) / Math.PI, 'lbf·in/rad': 4448.2216152605 * 25.4,
  },
  damping: { 'N·s/m': 1, 'mN·s/mm': 1, 'N·s/mm': 1000, 'lbf·s/in': 4448.2216152605 / 25.4 },
  rotDamping: { 'mN·mm·s/rad': 1, 'N·mm·s/rad': 1000, 'N·m·s/rad': 1e6, 'lbf·in·s/rad': 4448.2216152605 * 25.4 },
  density: { 'kg/mm³': 1, 'g/cm³': 1e-6, 'kg/m³': 1e-9, 'lb/in³': 0.45359237 / 16387.064 },
  power: { 'µW': 1, mW: 1000, W: 1e6 },
  energy: { 'µJ': 1, mJ: 1000, J: 1e6, 'in·lbf': 4448.2216152605 * 25.4 },
  inertia: { 'kg·mm²': 1, 'g·mm²': 1e-3, 'g·cm²': 0.1, 'kg·m²': 1e6, 'lb·in²': 0.45359237 * 645.16 },
  area: { 'mm²': 1, 'cm²': 100, 'in²': 645.16 },
  volume: { 'mm³': 1, 'cm³': 1000, 'in³': 16387.064 },
  frequency: { Hz: 1 },
  ratio: { '': 1, '%': 0.01 },
  count: { '': 1 },
};

export type UnitPrefs = Partial<Record<QuantityKind, string>>;

export const UNIT_PRESETS: Record<string, { label: string; prefs: UnitPrefs }> = {
  mmN: {
    label: 'mm · N · rpm',
    prefs: {
      length: 'mm', angle: 'deg', mass: 'g', time: 's', force: 'N', torque: 'N·mm',
      speed: 'mm/s', angularSpeed: 'rpm', acceleration: 'm/s²', angularAcceleration: 'rad/s²',
      stiffness: 'N/mm', torsionStiffness: 'N·mm/rad', damping: 'N·s/m', rotDamping: 'N·mm·s/rad',
      density: 'g/cm³', power: 'W', energy: 'mJ', inertia: 'g·mm²', area: 'mm²', volume: 'cm³',
      frequency: 'Hz', ratio: '', count: '',
    },
  },
  si: {
    label: 'SI (m · N · rad/s)',
    prefs: {
      length: 'm', angle: 'rad', mass: 'kg', time: 's', force: 'N', torque: 'N·m',
      speed: 'm/s', angularSpeed: 'rad/s', acceleration: 'm/s²', angularAcceleration: 'rad/s²',
      stiffness: 'N/m', torsionStiffness: 'N·m/rad', damping: 'N·s/m', rotDamping: 'N·m·s/rad',
      density: 'kg/m³', power: 'W', energy: 'J', inertia: 'kg·m²', area: 'mm²', volume: 'cm³',
      frequency: 'Hz', ratio: '', count: '',
    },
  },
  inch: {
    label: 'inch · lbf · rpm',
    prefs: {
      length: 'in', angle: 'deg', mass: 'lb', time: 's', force: 'lbf', torque: 'lbf·in',
      speed: 'in/s', angularSpeed: 'rpm', acceleration: 'in/s²', angularAcceleration: 'rad/s²',
      stiffness: 'lbf/in', torsionStiffness: 'lbf·in/rad', damping: 'lbf·s/in', rotDamping: 'lbf·in·s/rad',
      density: 'lb/in³', power: 'W', energy: 'in·lbf', inertia: 'lb·in²', area: 'in²', volume: 'in³',
      frequency: 'Hz', ratio: '', count: '',
    },
  },
};

export const DEFAULT_PREFS: UnitPrefs = UNIT_PRESETS.mmN.prefs;

export function unitFor(kind: QuantityKind, prefs: UnitPrefs = DEFAULT_PREFS): string {
  const u = prefs[kind] ?? DEFAULT_PREFS[kind];
  if (u !== undefined && UNIT_TABLE[kind][u] !== undefined) return u;
  return Object.keys(UNIT_TABLE[kind])[0];
}

/** internal → display */
export function toDisplay(value: number, kind: QuantityKind, prefs: UnitPrefs = DEFAULT_PREFS): number {
  return value / UNIT_TABLE[kind][unitFor(kind, prefs)];
}

/** display → internal */
export function fromDisplay(value: number, kind: QuantityKind, prefs: UnitPrefs = DEFAULT_PREFS): number {
  return value * UNIT_TABLE[kind][unitFor(kind, prefs)];
}

export function convert(value: number, kind: QuantityKind, from: string, to: string): number {
  const t = UNIT_TABLE[kind];
  if (t[from] === undefined) throw new Error(`Unknown ${kind} unit "${from}"`);
  if (t[to] === undefined) throw new Error(`Unknown ${kind} unit "${to}"`);
  return (value * t[from]) / t[to];
}

export function formatNumber(v: number, sig = 4): string {
  if (!Number.isFinite(v)) return v > 0 ? '∞' : v < 0 ? '−∞' : '—';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-4) return v.toExponential(Math.max(0, sig - 1)).replace('e+', 'e');
  const digits = Math.max(0, sig - 1 - Math.floor(Math.log10(a)));
  let s = v.toFixed(Math.min(digits, 8));
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

export function formatQuantity(
  value: number, kind: QuantityKind, prefs: UnitPrefs = DEFAULT_PREFS, sig = 4,
): string {
  const u = unitFor(kind, prefs);
  const n = formatNumber(toDisplay(value, kind, prefs), sig);
  return u ? `${n} ${u}` : n;
}

const ALIASES: Record<string, string> = {
  '"': 'in', inch: 'in', inches: 'in', um: 'µm', micron: 'µm',
  degree: 'deg', degrees: 'deg', '°': 'deg', radian: 'rad', radians: 'rad', turn: 'rev', turns: 'rev',
  nmm: 'N·mm', 'n*mm': 'N·mm', 'n.mm': 'N·mm', 'n-mm': 'N·mm', nm: 'N·m', 'n*m': 'N·m', 'n.m': 'N·m',
  ncm: 'N·cm', 'n*cm': 'N·cm', mnm: 'mN·m', 'mn*m': 'mN·m', mnmm: 'mN·mm', 'mn*mm': 'mN·mm',
  'lbf*in': 'lbf·in', 'lbf.in': 'lbf·in', lbfin: 'lbf·in', 'in*lbf': 'lbf·in', 'kgf*cm': 'kgf·cm', kgfcm: 'kgf·cm',
  'mm/s2': 'mm/s²', 'mm/s^2': 'mm/s²', 'm/s2': 'm/s²', 'm/s^2': 'm/s²', 'in/s2': 'in/s²',
  'rad/s2': 'rad/s²', 'rad/s^2': 'rad/s²', 'deg/s2': 'deg/s²', 'deg/s^2': 'deg/s²',
  rpm: 'rpm', 'rev/min': 'rpm', 'g/cc': 'g/cm³', 'g/cm3': 'g/cm³', 'g/cm^3': 'g/cm³',
  'kg/m3': 'kg/m³', 'kg/m^3': 'kg/m³', 'kg/mm3': 'kg/mm³', 'kg/mm^3': 'kg/mm³',
  uw: 'µW', uj: 'µJ', w: 'W', mw: 'mW', j: 'J', mj: 'mJ', n: 'N', mn: 'mN', kn: 'kN',
  'n/m': 'N/m', 'n/mm': 'N/mm', 'mn/mm': 'mN/mm', 'lbf/in': 'lbf/in',
  'n*mm/rad': 'N·mm/rad', 'nmm/rad': 'N·mm/rad', 'n*m/rad': 'N·m/rad', 'n*mm/deg': 'N·mm/deg', 'nmm/deg': 'N·mm/deg',
  'n*s/m': 'N·s/m', 'ns/m': 'N·s/m', 'n*s/mm': 'N·s/mm', 'ns/mm': 'N·s/mm',
  'n*mm*s/rad': 'N·mm·s/rad', 'nmms/rad': 'N·mm·s/rad',
  'kg*mm2': 'kg·mm²', 'kg*mm^2': 'kg·mm²', 'g*mm2': 'g·mm²', 'g*mm^2': 'g·mm²', 'g*cm2': 'g·cm²', 'kg*m2': 'kg·m²',
  mm2: 'mm²', 'mm^2': 'mm²', cm2: 'cm²', mm3: 'mm³', 'mm^3': 'mm³', cm3: 'cm³', 'cm^3': 'cm³', hz: 'Hz',
  sec: 's', second: 's', seconds: 's', msec: 'ms', lbs: 'lb', pound: 'lb', pounds: 'lb',
  'lbf*in/rad': 'lbf·in/rad', 'lbf*s/in': 'lbf·s/in', 'lbf*in*s/rad': 'lbf·in·s/rad', 'lb/in3': 'lb/in³', 'lb/in^3': 'lb/in³', 'lb*in2': 'lb·in²', 'lb*in^2': 'lb·in²',
};

function resolveUnit(kind: QuantityKind, raw: string): string | null {
  const table = UNIT_TABLE[kind];
  const u = raw.trim();
  if (u === '') return null;
  if (table[u] !== undefined) return u;
  const lower = u.toLowerCase().replace(/\s+/g, '');
  for (const key of Object.keys(table)) if (key.toLowerCase() === lower) return key;
  const alias = ALIASES[lower];
  if (alias && table[alias] !== undefined) return alias;
  return null;
}

/** Tiny arithmetic evaluator: + - * / ^ ( ) unary minus, constants pi. */
export function evalArithmetic(src: string): number {
  let i = 0;
  const s = src.replace(/\s+/g, '').replace(/−/g, '-').replace(/×/g, '*').replace(/÷/g, '/');
  const peek = () => s[i];
  function primary(): number {
    if (peek() === '(') {
      i++;
      const v = expr();
      if (peek() !== ')') throw new Error('Missing )');
      i++;
      return v;
    }
    if (peek() === '-') { i++; return -power(); }
    if (peek() === '+') { i++; return power(); }
    if (s.startsWith('pi', i)) { i += 2; return Math.PI; }
    const m = /^(\d+\.?\d*(e[+-]?\d+)?|\.\d+(e[+-]?\d+)?)/i.exec(s.slice(i));
    if (!m) throw new Error(`Unexpected "${s.slice(i, i + 6) || 'end'}"`);
    i += m[0].length;
    return parseFloat(m[0]);
  }
  function power(): number {
    const b = primary();
    if (peek() === '^') { i++; return Math.pow(b, power()); }
    return b;
  }
  function term(): number {
    let v = power();
    while (peek() === '*' || peek() === '/') {
      const op = s[i++];
      const r = power();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }
  function expr(): number {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = s[i++];
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  const v = expr();
  if (i !== s.length) throw new Error(`Unexpected "${s.slice(i, i + 6)}"`);
  return v;
}

export interface ParseResult { ok: boolean; value: number; error?: string; unit?: string }

/**
 * Parse user text such as "25", "1.5 in", "2*pi rad", "120 rpm", "0.4 N*m" into
 * an INTERNAL value of the given kind. Bare numbers use the preferred unit.
 */
export function parseQuantity(text: string, kind: QuantityKind, prefs: UnitPrefs = DEFAULT_PREFS): ParseResult {
  const t = text.trim().replace(/−/g, '-');
  if (t === '') return { ok: false, value: NaN, error: 'Empty value' };
  if (/^(inf|infinity|∞)$/i.test(t)) return { ok: true, value: Infinity };
  // plain arithmetic (including scientific notation such as 1e-3) in the preferred unit
  try {
    const n = evalArithmetic(t);
    if (!Number.isNaN(n)) { const u = unitFor(kind, prefs); return { ok: true, value: n * UNIT_TABLE[kind][u], unit: u }; }
  } catch { /* has a unit or is invalid: continue */ }
  // sums of terms that each carry their own unit: "60 mm + 1 in"
  const terms = splitTerms(t);
  if (terms.length > 1) {
    let total = 0;
    for (const term of terms) {
      const r = parseTerm(term.text, kind, prefs);
      if (!r.ok) return r;
      total += term.sign * r.value;
    }
    return { ok: true, value: total };
  }
  return parseTerm(t, kind, prefs);
}

/** split "a + b - c" at top-level + / − (not inside parentheses, not the sign of an exponent or a unary sign) */
function splitTerms(t: string): { sign: number; text: string }[] {
  const out: { sign: number; text: string }[] = [];
  let depth = 0, start = 0, sign = 1;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if ((ch === '+' || ch === '-') && depth === 0) {
      const before = t.slice(start, i).trim();
      if (before === '') continue;                                  // unary sign of the term
      if (/[*/^(]$/.test(before)) continue;                          // sign after an operator
      if (/\d[eE]$/.test(t.slice(0, i))) continue;                   // exponent sign: 1e-3
      out.push({ sign, text: before });
      sign = ch === '+' ? 1 : -1;
      start = i + 1;
    }
  }
  out.push({ sign, text: t.slice(start).trim() });
  return out.filter((x) => x.text !== '');
}

function parseTerm(text: string, kind: QuantityKind, prefs: UnitPrefs): ParseResult {
  const t = text.trim();
  if (t === '') return { ok: false, value: NaN, error: 'Empty value' };
  // split trailing unit: longest suffix that resolves to a unit of this kind
  let numPart = t;
  let unit: string | null = null;
  const m = /^(.*?[\d)\s.]|pi)\s*([a-zA-Zµ°"%][a-zA-Zµ°"%·*./^²³0-9-]*)$/.exec(t);
  if (m) {
    const cand = resolveUnit(kind, m[2]);
    if (cand !== null) { unit = cand; numPart = m[1]; }
    else if (!/^pi$/i.test(m[2])) {
      return { ok: false, value: NaN, error: `Unknown unit "${m[2]}" for ${kind}. Try: ${Object.keys(UNIT_TABLE[kind]).filter(Boolean).join(', ')}` };
    }
  }
  let n: number;
  try { n = evalArithmetic(numPart); } catch (e) {
    return { ok: false, value: NaN, error: (e as Error).message };
  }
  if (Number.isNaN(n)) return { ok: false, value: NaN, error: 'Not a number' };
  const u = unit ?? unitFor(kind, prefs);
  return { ok: true, value: n * UNIT_TABLE[kind][u], unit: u };
}

export const G_STANDARD = 9806.65; // mm/s²
export const DEG = Math.PI / 180;
export const RPM = (2 * Math.PI) / 60;
