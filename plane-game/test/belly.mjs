import fdef from '../src/aircraft/fighter.js';
import adef from '../src/aircraft/airliner.js';
import tdef from '../src/aircraft/trainer.js';
import * as T from './lib.mjs';
function approach(def, kts, gearDown, label, env) {
  const ac = T.airStart(def, kts, 25, { gamma: -2.5, gearDown, flapIndex: def.flaps && !def.flaps.auto ? def.flaps.settings.length - 1 : 0 });
  if (env) ac.env = env;
  ac.ctrl.gearDown = gearDown;
  const ev = [];
  const gh = gearDown ? -Math.min(...ac.gear.wheels.map(w => w.r0.y)) : 1.0;
  let maxG = 0, stopT = -1, stopX = 0;
  T.run(ac, 60, (t, a) => {
    // hold a shallow descent, flare near the ground, then brake
    const h = a.agl - gh;
    const target = h > 6 ? -3 : h > 2 ? -1.2 : -0.5;
    a.ctrl.pitch = T.clamp((target - a.vel.y) * (a.fcs.fbw ? 0.12 : 0.25) - a.omega.z * 1.0, -1, 1);
    if (h < 3) a.ctrl.throttle = 0;
    a.ctrl.roll = T.clamp(-a.euler.roll * 2 - a.omega.x * 0.5, -1, 1);
    if (a.gear.onGround || a.gear.scrape > 0) { a.ctrl.throttle = 0; a.ctrl.brake = 1; a.ctrl.pitch = 0; }
    for (const e of a.events) ev.push(e.type + (e.part ? ':' + e.part : '') + (e.sink ? '@' + e.sink.toFixed(1) : ''));
    a.events.length = 0;
    maxG = Math.max(maxG, a.nz);
    if (stopT < 0 && t > 3 && a.vel.length() < 0.5) { stopT = t; stopX = a.pos.x; }
  });
  console.log(`[${label}] crashed=${ac.crashed ? ac.crashed.reason : 'no'} stop t=${stopT.toFixed(1)}s x=${stopX.toFixed(0)}m maxG=${maxG.toFixed(1)} y=${ac.pos.y.toFixed(2)} pitch=${T.deg(ac.euler.pitch)} roll=${T.deg(ac.euler.roll)} events=${[...new Set(ev)].slice(0, 8).join(',')}`);
}
approach(fdef, 150, true, 'fighter gear down');
approach(fdef, 150, false, 'fighter belly landing');
approach(adef, 140, true, 'airliner gear down');
approach(adef, 140, false, 'airliner belly landing');
approach(tdef, 62, true, 'trainer');
const water = { ground: (x, z, o) => { o.h = 0; o.nx = 0; o.ny = 1; o.nz = 0; o.type = 3; o.mu = 0.3; o.rr = 0.5; return o; }, wind: null };
approach(tdef, 62, true, 'trainer on water', water);
