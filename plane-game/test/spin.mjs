import * as T from './lib.mjs';
const name = process.argv[2] || 'aerobat';
const def = (await import(`../src/aircraft/${name}.js`)).default;
const ac = T.airStart(def, +(process.argv[3] || 75), 2500);
ac.assist.autoRudder = false; ac.assist.autoTrim = false; ac.assist.bankHold = false;
ac.ctrl.throttle = 0;
const log = [];
let turns = 0;
T.run(ac, 26, (t, a) => {
  const dir = +(process.argv[4] || -1);
  if (t < 6) { a.ctrl.pitch = Math.min(1, t * 0.2); a.ctrl.yaw = 0; a.ctrl.roll = T.clamp(-a.euler.roll * 3 - a.omega.x, -1, 1); }   // slow down, wings level
  else if (t < 14) { a.ctrl.pitch = 1; a.ctrl.yaw = dir; a.ctrl.roll = 0; }                       // pro-spin: full back stick, full rudder
  else if (t < 17) { a.ctrl.pitch = -0.3; a.ctrl.yaw = -dir; a.ctrl.roll = 0; }                    // recovery: opposite rudder, stick forward
  else { a.ctrl.yaw = 0; a.ctrl.pitch = a.euler.pitch < -0.1 ? 0.45 : 0; a.ctrl.roll = T.clamp(-a.euler.roll * 1.5, -1, 1); }
  if (t > 6 && t < 14) turns += -a.omega.y * Math.cos(a.euler.pitch) * T.PHYSICS_DT / (2 * Math.PI) * (a.omega.y > 0 ? 1 : 1);
  if (Math.round(t / T.PHYSICS_DT) % 450 === 0) log.push(`${t.toFixed(1)}s ias=${T.kt(a.ias)} alt=${a.pos.y.toFixed(0)} pitch=${T.deg(a.euler.pitch)} roll=${T.deg(a.euler.roll)} yawRate=${(-a.omega.y * T.RAD).toFixed(0)}°/s alpha=${T.deg(a.alpha)} beta=${T.deg(a.beta)} nz=${a.nz.toFixed(1)} vs=${T.fpm(a.vel.y)} stalled=${a.stalled.toFixed(2)}`);
});
console.log(log.join('\n'));
console.log('heading turns during pro-spin inputs:', Math.abs(turns).toFixed(1), ac.crashed ? 'CRASH ' + ac.crashed.reason : '');
