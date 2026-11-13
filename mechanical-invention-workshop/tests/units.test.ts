import { describe, expect, it } from 'vitest';
import { convert, evalArithmetic, formatQuantity, fromDisplay, parseQuantity, toDisplay, UNIT_PRESETS, UNIT_TABLE, G_STANDARD, RPM } from '../src/core/units';

describe('unit system (internal: mm · kg · s · rad, force mN, torque mN·mm)', () => {
  it('converts lengths, forces, torques exactly', () => {
    expect(convert(1, 'length', 'in', 'mm')).toBeCloseTo(25.4, 12);
    expect(convert(1, 'length', 'm', 'mm')).toBe(1000);
    expect(convert(1, 'force', 'N', 'mN')).toBe(1000);
    expect(convert(1, 'force', 'lbf', 'N')).toBeCloseTo(4.4482216152605, 12);
    expect(convert(1, 'torque', 'N·m', 'mN·mm')).toBe(1e6);
    expect(convert(1, 'torque', 'N·mm', 'mN·mm')).toBe(1000);
    expect(convert(1, 'torque', 'lbf·in', 'N·m')).toBeCloseTo(0.1129848290276167, 12);
    expect(convert(60, 'angularSpeed', 'rpm', 'rad/s')).toBeCloseTo(2 * Math.PI, 12);
    expect(convert(180, 'angle', 'deg', 'rad')).toBeCloseTo(Math.PI, 14);
    expect(convert(1, 'density', 'g/cm³', 'kg/mm³')).toBeCloseTo(1e-6, 18);
    expect(convert(1, 'stiffness', 'N/mm', 'N/m')).toBe(1000);
    expect(convert(1, 'power', 'W', 'µW')).toBe(1e6);
    expect(convert(1, 'acceleration', 'g', 'mm/s²')).toBe(G_STANDARD);
  });
  it('is internally consistent: derived units need no hidden factors', () => {
    // 1 kg · 1 mm/s² = 1 mN ;  1 mN · 1 mm = 1 µJ ; 1 mN·mm · 1 rad/s = 1 µW
    expect(UNIT_TABLE.force.mN).toBe(1);
    expect(UNIT_TABLE.energy['µJ']).toBe(1);
    expect(UNIT_TABLE.power['µW']).toBe(1);
    // weight of 1 kg in N
    expect(toDisplay(1 * G_STANDARD, 'force', { force: 'N' })).toBeCloseTo(9.80665, 12);
    // kinetic energy ½·m·v² of 2 kg at 3 m/s = 9 J
    expect(toDisplay(0.5 * 2 * 3000 ** 2, 'energy', { energy: 'J' })).toBeCloseTo(9, 12);
    // power = torque × speed: 0.5 N·m at 120 rpm = 6.283 W
    expect(toDisplay(0.5e6 * 120 * RPM, 'power', { power: 'W' })).toBeCloseTo(0.5 * 4 * Math.PI, 12);
  });
  it('round-trips every unit of every kind', () => {
    for (const [kind, table] of Object.entries(UNIT_TABLE)) {
      for (const u of Object.keys(table)) {
        const prefs = { [kind]: u } as any;
        expect(fromDisplay(toDisplay(123.456, kind as any, prefs), kind as any, prefs)).toBeCloseTo(123.456, 9);
      }
    }
    for (const p of Object.values(UNIT_PRESETS)) for (const [k, u] of Object.entries(p.prefs)) expect(UNIT_TABLE[k as keyof typeof UNIT_TABLE][u!]).toBeDefined();
  });
  it('parses numbers with units and arithmetic', () => {
    expect(parseQuantity('25.4', 'length').value).toBe(25.4);
    expect(parseQuantity('1 in', 'length').value).toBeCloseTo(25.4, 12);
    expect(parseQuantity('2.5cm', 'length').value).toBeCloseTo(25, 12);
    expect(parseQuantity('3*(2+1) mm', 'length').value).toBe(9);
    expect(parseQuantity('90 deg', 'angle').value).toBeCloseTo(Math.PI / 2, 14);
    expect(parseQuantity('2*pi rad', 'angle').value).toBeCloseTo(2 * Math.PI, 14);
    expect(parseQuantity('pi/2 rad', 'angle').value).toBeCloseTo(Math.PI / 2, 14);
    expect(parseQuantity('120 rpm', 'angularSpeed').value).toBeCloseTo(4 * Math.PI, 12);
    expect(parseQuantity('0.4 N*m', 'torque').value).toBeCloseTo(4e5, 6);
    expect(parseQuantity('50 Nmm', 'torque').value).toBe(50000);
    expect(parseQuantity('-3 N', 'force').value).toBe(-3000);
    expect(parseQuantity('1e-3 kg', 'mass').value).toBeCloseTo(1e-3, 15);
    expect(parseQuantity('30', 'angle', { angle: 'deg' }).value).toBeCloseTo(Math.PI / 6, 14);
    expect(parseQuantity('∞', 'torque').value).toBe(Infinity);
    // scientific notation and sums of terms with their own units
    expect(parseQuantity('1e3', 'length').value).toBe(1000);
    expect(parseQuantity('6e1', 'length').value).toBe(60);
    expect(parseQuantity('2.5e-1 in', 'length').value).toBeCloseTo(6.35, 12);
    expect(parseQuantity('60 mm + 1 in', 'length').value).toBeCloseTo(85.4, 12);
    expect(parseQuantity('1 in - 5.4 mm', 'length').value).toBeCloseTo(20, 12);
    expect(parseQuantity('1e3 N*mm + 1 N*m', 'torque').value).toBeCloseTo(2e6, 6);
    // imperial display units added for the inch preset
    expect(convert(1, 'inertia', 'lb·in²', 'kg·mm²')).toBeCloseTo(0.45359237 * 25.4 * 25.4, 9);
    expect(convert(1, 'density', 'lb/in³', 'g/cm³')).toBeCloseTo(27.679905, 5);
  });
  it('rejects wrong or unknown units with an explanation', () => {
    const r = parseQuantity('5 kg', 'length');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Unknown unit/);
    expect(parseQuantity('abc', 'length').ok).toBe(false);
    expect(parseQuantity('', 'length').ok).toBe(false);
    expect(parseQuantity('2+', 'length').ok).toBe(false);
    expect(() => evalArithmetic('1/(')).toThrow();
  });
  it('formats with the display unit', () => {
    expect(formatQuantity(25.4, 'length', { length: 'in' })).toBe('1 in');
    expect(formatQuantity(1500, 'force', { force: 'N' })).toBe('1.5 N');
    expect(formatQuantity(Infinity, 'torque', { torque: 'N·mm' })).toBe('∞ N·mm');
  });
});
