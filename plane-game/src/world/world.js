// The world facade: owns sky, terrain, sea, airports, clouds and the wind field, and exposes
// the environment interface used by the flight model ({ground(), wind}).

import * as THREE from 'three';
import { Sky } from './sky.js';
import { Terrain } from './terrain.js';
import { Water } from './water.js';
import { AirportScenery } from './airportScenery.js';
import { Clouds } from './clouds.js';
import { Towns } from './towns.js';
import { groundQuery, meshHeight } from './ground.js';
import { terrainHeight, AIRPORTS, WORLD_HALF, biomeAt, airfieldFactor } from './heightfield.js';
import { atmoUniforms } from '../gfx/atmosphere.js';
import { Wind } from '../physics/wind.js';

const KT = 0.514444;

export const WEATHER = {
  clear: { name: 'Clear skies', coverage: 0.04, base: 1800, stratus: 0, vis: 90000, wind: 4, turbulence: 0.04, fogHeight: 1900 },
  fair: { name: 'Fair weather cumulus', coverage: 0.3, base: 1500, stratus: 0, vis: 60000, wind: 8, turbulence: 0.14, fogHeight: 1800 },
  scattered: { name: 'Scattered clouds, breezy', coverage: 0.58, base: 1250, stratus: 0, vis: 40000, wind: 14, turbulence: 0.3, fogHeight: 1700 },
  overcast: { name: 'Overcast', coverage: 0.35, base: 850, stratus: 0.9, vis: 14000, wind: 12, turbulence: 0.25, fogHeight: 1500 },
  storm: { name: 'Stormy', coverage: 0.7, base: 600, stratus: 1.0, vis: 7000, wind: 30, turbulence: 0.62, fogHeight: 1400, rain: 1 },
  fog: { name: 'Fog', coverage: 0, base: 1500, stratus: 0, vis: 1300, wind: 2, turbulence: 0.02, fogHeight: 260 },
};

const _b = { forest: 0, farm: 0, conifer: 0, snow: 0, rock: 0, sand: 0 };
const _g = { h: 0, nx: 0, ny: 1, nz: 0, type: 0, mu: 0.8, rr: 0.02 };

export class World {
  constructor(scene, renderer, quality) {
    this.scene = scene;
    this.quality = quality;
    this.sky = new Sky(scene, renderer, { shadowSize: quality.shadowSize });
    this.terrain = new Terrain(scene, { res: quality.terrainRes, splitK: quality.splitK, trees: quality.trees, treeSpacing: quality.treeSpacing });
    this.water = new Water(scene);
    this.airports = new AirportScenery(scene);
    this.towns = new Towns(scene);
    this.clouds = new Clouds(scene);
    this.wind = new Wind();
    this.weatherId = 'fair';
    this.weather = WEATHER.fair;
    this.timeOfDay = 10;
    this.timeScale = 1;          // sim seconds of day per real second
    this.overview = null;
    this._up = 0; this._upT = 0;
    // environment for the physics
    const self = this;
    this.env = {
      wind: this.wind,
      ground(x, z, out) {
        groundQuery(x, z, out);
        if (out.type === 1) {
          // forests and rocks are no place to land
          const slope = Math.sqrt(Math.max(0, 1 / (out.ny * out.ny) - 1));
          biomeAt(x, z, out.h, slope, 1, 0, _b);
          if (_b.forest > 0.55 && airfieldFactor(x, z) < 0.02) { out.type = 2; out.rr = 0.3; }
        }
        return out;
      },
    };
    void self;
  }

  async init(onProgress) {
    const ov = await this.terrain.requestOverview(512, WORLD_HALF);
    this.overview = ov;
    this.water.setHeightMap(ov.overview, ov.size);
    if (onProgress) onProgress(0.2);
  }

  setTime(hours) { this.timeOfDay = hours; this.sky.setTime(hours); }

  /** opts: {weather id, windDir (deg from), windSpeed (kt), turbulence 0..1} — unspecified values come from the preset */
  setWeather(id, opts = {}) {
    const w = WEATHER[id] || WEATHER.fair;
    this.weatherId = id; this.weather = w;
    this.clouds.setWeather({ coverage: w.coverage, base: w.base, stratus: w.stratus });
    this.sky.setOvercast(w.stratus * 0.85);
    this.wind.speed = (opts.windSpeed ?? w.wind) * KT;
    this.wind.dirFrom = (opts.windDir ?? 250) * Math.PI / 180;
    this.wind.turbulence = opts.turbulence ?? w.turbulence;
    this.baseFog = 3.9 / w.vis;
    atmoUniforms.uFogDensity.value = this.baseFog;
    atmoUniforms.uFogHeight.value = w.fogHeight;
    this.rain = w.rain || 0;
  }

  groundHeight(x, z) { return Math.max(0, meshHeight(x, z)); }

  /** Per-frame update. focus: aircraft position; radius: shadow radius. */
  update(camera, focus, radius, agl, dt, now, viewport) {
    if (this.timeScale > 0 && dt > 0) {
      this.timeOfDay = (this.timeOfDay + dt * this.timeScale / 3600) % 24;
      if (Math.abs(this.timeOfDay - this.sky.time) > 0.01) this.sky.setTime(this.timeOfDay);
    }
    // cloud immersion thickens the haze
    const dens = this.clouds.densityAt(camera.position);
    this.cloudDensity = dens;
    atmoUniforms.uFogDensity.value = this.baseFog + dens * 0.012;
    const tint = 1 - 0.25 * this.sky.overcast;
    atmoUniforms.uFogTint.value.setScalar(tint);
    this.terrain.update(camera.position);
    this.sky.update(camera, focus, radius, agl, now);
    this.water.update(camera, this.sky, this.wind);
    this.clouds.update(camera, this.sky, this.wind, dt);
    this.airports.update(this.wind, this.sky.night, viewport.height, camera.fov, now);
    // orographic lift: wind blowing up a slope carries the air (and the aircraft) with it
    this._upT -= dt;
    if (this._upT <= 0) {
      this._upT = 0.15;
      const e = 60;
      const hx = (terrainHeight(focus.x + e, focus.z) - terrainHeight(focus.x - e, focus.z)) / (2 * e);
      const hz = (terrainHeight(focus.x, focus.z + e) - terrainHeight(focus.x, focus.z - e)) / (2 * e);
      const w = this.wind;
      const wx = -Math.cos(w.dirFrom) * w.speed, wz = -Math.sin(w.dirFrom) * w.speed;
      this._up = (wx * hx + wz * hz) * Math.exp(-Math.max(0, agl) / 450) * 0.9;
    }
    this.wind.updraft += (this._up - this.wind.updraft) * Math.min(1, dt * 1.5);
  }
}

export { AIRPORTS };
