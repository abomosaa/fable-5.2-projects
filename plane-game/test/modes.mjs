import * as T from './lib.mjs';
const name = process.argv[2] || 'trainer';
const def = (await import(`../src/aircraft/${name}.js`)).default;
const kts = +(process.argv[3] || 105), alt = +(process.argv[4] || 1500);
function trace(title, setup, secs, every, fields) {
  const ac = T.airStart(def, kts, alt);
  ac.assist.autoRudder = false; ac.assist.autoTrim = false; ac.assist.bankHold = false;
  setup(ac);
  const log = [];
  T.run(ac, secs, (t, a) => { if (Math.round(t / T.PHYSICS_DT) % Math.round(every / T.PHYSICS_DT) === 0) log.push(fields(t, a)); });
  console.log(title + (ac.crashed ? ' CRASH ' + ac.crashed.reason : '') + '\n  ' + log.join('\n  '));
}
// spiral: start with 15 deg bank
trace('SPIRAL (15deg bank release)', (ac) => { ac.q.setFromEuler(0, ac.euler.pitch, 15 * T.DEG); }, 60, 6, (t, a) => `${t.toFixed(0)}s roll=${T.deg(a.euler.roll)} hdg=${T.deg(a.euler.heading)} ias=${T.kt(a.ias)} alt=${a.pos.y.toFixed(0)}`);
// dutch roll: yaw kick
trace('DUTCH ROLL (yaw rate kick)', (ac) => { ac.omega.y += 0.25; }, 8, 0.5, (t, a) => `${t.toFixed(1)}s beta=${T.deg(a.beta)} roll=${T.deg(a.euler.roll)} yawrate=${T.deg(-a.omega.y)}`);
// short period: pitch kick
trace('SHORT PERIOD (pitch rate kick)', (ac) => { ac.omega.z += 0.25; }, 4, 0.25, (t, a) => `${t.toFixed(2)}s alpha=${T.deg(a.alpha)} q=${T.deg(a.omega.z)} nz=${a.nz.toFixed(2)}`);
// phugoid: speed disturbance
trace('PHUGOID (+10kt)', (ac) => { ac.vel.scale(1.1); }, 120, 8, (t, a) => `${t.toFixed(0)}s ias=${T.kt(a.ias)} alt=${a.pos.y.toFixed(0)} pitch=${T.deg(a.euler.pitch)}`);
