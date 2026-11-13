/**
 * Atmosphere and wind.
 *
 * - Air density from the ISA pressure lapse at the field elevation and the
 *   chosen outside-air temperature (ideal gas law).
 * - Mean wind follows the neutral logarithmic boundary-layer profile.
 * - Turbulence is a Dryden-type model (MIL-F-8785C low-altitude scales and
 *   intensities), realised as Gauss-Markov processes driven by white noise.
 */
import { Rng, Vec3, DEG2RAD, clamp } from './math';

export interface EnvSettings {
  /** Outside air temperature at the field [deg C]. */
  temperatureC: number;
  /** Field elevation above mean sea level [m]. */
  elevation: number;
  /** Mean wind speed at 10 m above ground [m/s]. */
  windSpeed: number;
  /** Direction the wind blows FROM, compass degrees (0 = north = -Z, 90 = east = +X). */
  windFrom: number;
  /** Turbulence intensity multiplier (1 = MIL-spec for the given mean wind). */
  turbulence: number;
}

export const DEFAULT_ENV: EnvSettings = {
  temperatureC: 18,
  elevation: 120,
  windSpeed: 2.0,
  windFrom: 250,
  turbulence: 1,
};

/** Aerodynamic roughness length of short grass [m]. */
const Z0 = 0.03;
const LOG_REF = Math.log(10 / Z0);
const FT = 0.3048;

export class Environment {
  settings: EnvSettings;
  /** Air density [kg/m^3]. */
  rho = 1.225;
  /** Unit vector the wind blows TOWARDS (horizontal). */
  private dirX = 0;
  private dirZ = 0;
  /** Turbulence state: along-wind, cross-wind, vertical [m/s]. */
  private gu = 0;
  private gv = 0;
  private gw = 0;
  private rng: Rng;
  /** Last sampled total wind (world frame), for telemetry. */
  readonly lastWind: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(settings: EnvSettings = DEFAULT_ENV, seed = 1234567) {
    this.settings = { ...settings };
    this.rng = new Rng(seed);
    this.apply();
  }

  set(settings: Partial<EnvSettings>): void {
    Object.assign(this.settings, settings);
    this.apply();
  }

  private apply(): void {
    const s = this.settings;
    // ISA pressure at elevation, actual temperature for density.
    const p = 101325 * Math.pow(1 - 2.25577e-5 * s.elevation, 5.25588);
    this.rho = p / (287.058 * (s.temperatureC + 273.15));
    const a = s.windFrom * DEG2RAD;
    // Blowing from compass angle a -> travelling towards a + 180 deg.
    // Compass: north = -Z, east = +X  => unit vector of bearing a is (sin a, 0, -cos a).
    this.dirX = -Math.sin(a);
    this.dirZ = Math.cos(a);
  }

  /** Mean wind speed at height above ground [m/s]. */
  meanSpeedAt(agl: number): number {
    if (agl <= Z0) return 0;
    return (this.settings.windSpeed * Math.log(agl / Z0)) / LOG_REF;
  }

  /** Mean wind vector (no gusts) at a height above ground. */
  meanWindAt(out: Vec3, agl: number): Vec3 {
    const u = this.meanSpeedAt(agl);
    out.x = this.dirX * u;
    out.y = 0;
    out.z = this.dirZ * u;
    return out;
  }

  /**
   * Advance the turbulence state and return the wind vector at the vehicle.
   * @param agl       height above ground [m]
   * @param airspeed  speed of the vehicle through the air mass [m/s]
   */
  step(out: Vec3, dt: number, agl: number, airspeed: number): Vec3 {
    const s = this.settings;
    const mean = this.meanSpeedAt(agl);
    let u = 0, v = 0, w = 0;
    if (s.turbulence > 0 && s.windSpeed > 0.05) {
      const hFt = clamp(agl, 1.5, 300) / FT;
      const w20 = (s.windSpeed * Math.log(6.096 / Z0)) / LOG_REF;
      const k = 0.177 + 0.000823 * hFt;
      const sigW = 0.1 * w20 * s.turbulence;
      const sigU = sigW / Math.pow(k, 0.4);
      const lW = hFt * FT;
      const lU = (hFt / Math.pow(k, 1.2)) * FT;
      // The frozen turbulence field is swept past the vehicle at its airspeed.
      const V = Math.max(airspeed, 0.5 * mean, 0.5);
      const aU = V / lU;
      const aW = V / lW;
      const sq = Math.sqrt(dt);
      this.gu += -aU * this.gu * dt + sigU * Math.sqrt(2 * aU) * sq * this.rng.gauss();
      this.gv += -aU * this.gv * dt + sigU * Math.sqrt(2 * aU) * sq * this.rng.gauss();
      this.gw += -aW * this.gw * dt + sigW * Math.sqrt(2 * aW) * sq * this.rng.gauss();
      // Vertical gusts must vanish at the surface.
      const wFade = clamp(agl / 2, 0, 1);
      u = this.gu;
      v = this.gv;
      w = this.gw * wFade;
    } else {
      this.gu = this.gv = this.gw = 0;
    }
    // Along-wind axis = (dirX, dirZ); cross-wind axis = (-dirZ, dirX).
    out.x = this.dirX * (mean + u) - this.dirZ * v;
    out.y = w;
    out.z = this.dirZ * (mean + u) + this.dirX * v;
    this.lastWind.x = out.x;
    this.lastWind.y = out.y;
    this.lastWind.z = out.z;
    return out;
  }

  resetGusts(): void {
    this.gu = this.gv = this.gw = 0;
  }
}
