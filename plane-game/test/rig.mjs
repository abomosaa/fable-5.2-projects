// find rigging offsets (aileron, rudder) that null roll and sideslip hands-off at cruise
import * as T from './lib.mjs';
const name = process.argv[2] || 'trainer';
const base = (await import(`../src/aircraft/${name}.js`)).default;
const kts = +(process.argv[3] || 105), dih = process.argv[4] ? +process.argv[4] : null;
function evalRig(ra, rr, secs = 12, verbose = false) {
  const def = structuredClone(base);
  if (dih !== null) def.surfaces[0].dihedral = dih;
  def.controls.rigAileron = ra; def.controls.rigRudder = rr;
  const ac = T.airStart(def, kts, 1500);
  ac.assist.autoRudder = false; ac.assist.autoTrim = false; ac.assist.bankHold = false;
  let betaAvg = 0, n = 0; const log = [];
  T.run(ac, secs, (t, a) => { if (t > 2) { betaAvg += a.beta; n++; } if (verbose && Math.round(t / T.PHYSICS_DT) % 4500 === 0) log.push(`${t.toFixed(0)}s alt=${a.pos.y.toFixed(0)} ias=${T.kt(a.ias)} roll=${T.deg(a.euler.roll)} hdg=${T.deg(a.euler.heading)} beta=${T.deg(a.beta)}`); });
  if (verbose) console.log('  ' + log.join('\n  ') + `\n  torqueFrac=${(ac.engines[0].shaftTorque / ac.engines[0].qRated).toFixed(3)}`);
  return [ac.euler.roll * T.RAD, (betaAvg / n) * T.RAD];
}
let ra = base.controls.rigAileron ?? 0, rr = base.controls.rigRudder ?? 0;
for (let it = 0; it < 12; it++) {
  const [r0, b0] = evalRig(ra, rr);
  const [r1, b1] = evalRig(ra + 0.1, rr);
  const [r2, b2] = evalRig(ra, rr + 0.1);
  // solve 2x2 for d(ra), d(rr)
  const a11 = (r1 - r0) / 0.1, a12 = (r2 - r0) / 0.1, a21 = (b1 - b0) / 0.1, a22 = (b2 - b0) / 0.1;
  const det = a11 * a22 - a12 * a21;
  const dra = (-r0 * a22 + b0 * a12) / det, drr = (-a11 * b0 + a21 * r0) / det;
  ra += T.clamp(dra, -0.5, 0.5) * 0.8; rr += T.clamp(drr, -0.5, 0.5) * 0.8;
  if (Math.abs(r0) < 0.05 && Math.abs(b0) < 0.01) break;
}
console.log(`rigAileron=${ra.toFixed(3)} rigRudder=${rr.toFixed(3)}`);
evalRig(ra, rr, 120, true);
