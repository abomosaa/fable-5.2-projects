// Wind field: mean wind with a boundary-layer profile, Dryden-like turbulence (coloured noise
// whose intensity and length scale depend on height above ground), and terrain-driven updrafts.

import { Vec3, clamp, makeRng, gauss, smoothstep } from '../core/math.js';

export class Wind {
  constructor(seed = 12345) {
    this.speed = 0;        // m/s, reference wind at ~300 m above ground
    this.dirFrom = 0;      // rad, direction the wind blows FROM (0 = north, pi/2 = east)
    this.turbulence = 0;   // 0 calm .. 1 severe
    this.updraft = 0;      // m/s, set by the environment (ridge lift / thermals)
    this.rng = makeRng(seed);
    this.gust = new Vec3();
    this.rollGust = 0;     // rad/s equivalent rolling gust
    this.current = new Vec3();
  }

  /** Mean wind velocity (world frame) at the given height above ground / altitude. */
  mean(agl, alt, out) {
    const h = clamp(agl, 2, 300);
    const profile = Math.pow(h / 300, 0.17) * (1 + 0.9 * smoothstep(600, 9000, alt));
    const s = this.speed * profile;
    return out.set(-Math.cos(this.dirFrom) * s, 0, -Math.sin(this.dirFrom) * s);
  }

  /** Advance the gust state and return the total wind at the aircraft. */
  step(dt, agl, alt, tas, out) {
    this.mean(agl, alt, out);
    const t = this.turbulence;
    const mech = 0.12 * this.speed * Math.exp(-Math.max(agl, 0) / 350);
    const sigma = (0.3 + 3.4 * t) * t + mech * (0.4 + t);
    if (sigma > 1e-3) {
      const L = clamp(agl, 25, 450);
      const tau = L / Math.max(tas, 12);
      const k = dt / tau, kk = Math.sqrt(2 * k);
      const g = this.gust, rng = this.rng;
      g.x += -g.x * k + sigma * kk * gauss(rng);
      g.z += -g.z * k + sigma * kk * gauss(rng);
      // vertical gusts are damped close to the ground
      const sv = sigma * clamp(agl / 60, 0.25, 1);
      g.y += -g.y * k + sv * kk * gauss(rng);
      const tauP = 0.35 * tau;
      this.rollGust += -this.rollGust * dt / tauP + (sigma * 0.035) * Math.sqrt(2 * dt / tauP) * gauss(rng);
      out.add(g);
    } else {
      this.gust.set(0, 0, 0); this.rollGust = 0;
    }
    out.y += this.updraft;
    this.current.copy(out);
    return out;
  }
}
