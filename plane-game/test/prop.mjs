import { buildPropTable, propLookup } from '../src/physics/propeller.js';
import { DEG } from '../src/core/math.js';
const t0 = performance.now();
for (const pitch of [18, 21, 24]) {
  const tab = buildPropTable({ blades: 2, cMax: 0.15, designPitch: pitch * DEG, pitchMin: pitch * DEG, pitchMax: pitch * DEG });
  console.log('pitch', pitch);
  const o = {};
  for (const J of [0, 0.2, 0.4, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5, 2, 3]) {
    propLookup(tab, J, 0, o);
    console.log(`  J=${J.toFixed(2)} CT=${o.ct.toFixed(4)} CP=${o.cp.toFixed(4)} eta=${(J * o.ct / o.cp).toFixed(3)}`);
  }
}
const cs = buildPropTable({ blades: 3, cMax: 0.16, designPitch: 24 * DEG, pitchMin: 12 * DEG, pitchMax: 46 * DEG });
console.log('CS table rows', cs.nB, 'time ms', (performance.now() - t0).toFixed(0));
const o = {};
for (const b of [12, 20, 30, 40]) { propLookup(cs, 0.8, b * DEG, o); console.log(` beta=${b} J=0.8 CT=${o.ct.toFixed(4)} CP=${o.cp.toFixed(4)} eta=${(0.8 * o.ct / o.cp).toFixed(3)}`); }
