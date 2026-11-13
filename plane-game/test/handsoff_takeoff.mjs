// take-off with no pilot input at all except full throttle: the assists must keep it straight
// and the take-off trim must fly it off the runway
import * as T from './lib.mjs';
for (const name of ['trainer', 'aerobat']) {
  const def = (await import(`../src/aircraft/${name}.js`)).default;
  const ac = T.make(def);
  ac.reset({ x: 0, z: 0, heading: 0, onGround: true });
  T.run(ac, 2);
  ac.ctrl.parkingBrake = false; ac.ctrl.throttle = 1;
  let lift = -1, maxDev = 0, maxRoll = 0, maxPitch = 0;
  const ok = T.run(ac, 60, (t, a) => {
    if (lift < 0 && a.agl > 3) lift = t;
    if (lift < 0) maxDev = Math.max(maxDev, Math.abs(a.pos.z));
    maxRoll = Math.max(maxRoll, Math.abs(a.euler.roll)); maxPitch = Math.max(maxPitch, a.euler.pitch);
  });
  console.log(`[hands-off take-off ${name}] ${ok ? 'ok' : 'CRASH ' + ac.crashed.reason} liftoff=${lift.toFixed(1)}s dev=${maxDev.toFixed(1)}m maxRoll=${T.deg(maxRoll)} maxPitch=${T.deg(maxPitch)} end: alt=${ac.pos.y.toFixed(0)}m ias=${T.kt(ac.ias)} vs=${T.fpm(ac.vel.y)} roll=${T.deg(ac.euler.roll)} hdg=${T.deg(ac.euler.heading)}`);
}
