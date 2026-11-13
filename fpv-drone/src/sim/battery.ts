/**
 * LiPo pack: open-circuit voltage from state of charge, ohmic internal
 * resistance, and one RC polarisation branch (first-order Thevenin model).
 *
 *   V_terminal = OCV(soc) - I * R0 - V_rc
 *   dV_rc/dt   = (I * R1 - V_rc) / tau
 *
 * This reproduces the things a pilot actually sees on the OSD: instant sag on a
 * punch-out, slower additional droop under sustained load, recovery when
 * throttle is released, and the voltage cliff at the end of the pack.
 */
import { BatteryParams } from './params';
import { clamp } from './math';

/** Typical LiPo (LiCoO2/graphite) rest voltage per cell vs. state of charge. */
const OCV_SOC = [0, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
const OCV_V = [3.0, 3.3, 3.5, 3.62, 3.7, 3.74, 3.77, 3.8, 3.85, 3.91, 3.99, 4.09, 4.2];

export function cellOcv(soc: number): number {
  const s = clamp(soc, 0, 1);
  for (let i = 1; i < OCV_SOC.length; i++) {
    if (s <= OCV_SOC[i]) {
      const t = (s - OCV_SOC[i - 1]) / (OCV_SOC[i] - OCV_SOC[i - 1]);
      return OCV_V[i - 1] + t * (OCV_V[i] - OCV_V[i - 1]);
    }
  }
  return OCV_V[OCV_V.length - 1];
}

/** Polarisation resistance as a fraction of the ohmic resistance. */
const R1_RATIO = 0.55;
/** Polarisation time constant [s]. */
const TAU_RC = 5.0;

export class Battery {
  readonly p: BatteryParams;
  /** State of charge 0..1. */
  soc = 1;
  /** Polarisation voltage (whole pack) [V]. */
  vrc = 0;
  /** Charge drawn [Ah]. */
  usedAh = 0;
  /** Last terminal voltage [V] and current [A]. */
  voltage: number;
  current = 0;

  constructor(p: BatteryParams) {
    this.p = p;
    this.voltage = this.ocv();
  }

  reset(soc = 1): void {
    this.soc = soc;
    this.vrc = 0;
    this.usedAh = 0;
    this.current = 0;
    this.voltage = this.ocv();
  }

  /** Pack open-circuit voltage [V]. */
  ocv(): number {
    return this.p.cells * cellOcv(this.soc);
  }

  /** Total series ohmic resistance: cells + leads [ohm]. Rises as the pack empties. */
  r0(): number {
    const low = Math.max(0, 0.2 - this.soc) / 0.2;
    return this.p.cells * this.p.cellResistance * (1 + 1.5 * low * low) + this.p.leadResistance;
  }

  /** EMF seen behind R0: OCV minus polarisation. */
  emf(): number {
    return this.ocv() - this.vrc;
  }

  /** Advance the charge state with the pack current [A] (positive = discharge). */
  step(current: number, terminalVoltage: number, dt: number): void {
    this.current = current;
    this.voltage = terminalVoltage;
    const dAh = (current * dt) / 3600;
    this.usedAh += dAh;
    this.soc = clamp(this.soc - dAh / this.p.capacityAh, 0, 1);
    const r1 = this.p.cells * this.p.cellResistance * R1_RATIO;
    this.vrc += ((current * r1 - this.vrc) / TAU_RC) * dt;
  }
}
