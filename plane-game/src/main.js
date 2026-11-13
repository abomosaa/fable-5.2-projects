// SKYWARD flight simulator — application entry point: renderer, game loop, flight setup,
// menus, warnings, landing evaluation.

import * as THREE from 'three';
import { installAtmosphere, applyAtmosphereToTree } from './gfx/atmosphere.js';
import { Effects, Rain } from './gfx/effects.js';
import { World, WEATHER, AIRPORTS } from './world/world.js';
import { airportWorld, airportLocal, nearestAirport } from './world/heightfield.js';
import { meshHeight } from './world/ground.js';
import { Aircraft, PHYSICS_DT } from './physics/aircraft.js';
import { Vec3, Quat, DEG, RAD, KT, FT, NM, FPM, clamp } from './core/math.js';
import { buildAircraftModel } from './aircraft/models.js';
import trainer from './aircraft/trainer.js';
import aerobat from './aircraft/aerobat.js';
import fighter from './aircraft/fighter.js';
import airliner from './aircraft/airliner.js';
import { Input } from './input.js';
import { CameraRig, CAMERA_NAMES } from './cameras.js';
import { Hud } from './ui/hud.js';
import { Audio } from './audio.js';

const DEFS = { trainer, aerobat, fighter, airliner };
const DEF_LIST = [trainer, aerobat, fighter, airliner];

const QUALITY = {
  low: { pixelRatio: 1, terrainRes: 48, splitK: 1.9, trees: true, treeSpacing: 24, shadowSize: 1024, antialias: false },
  medium: { pixelRatio: 1.5, terrainRes: 64, splitK: 2.3, trees: true, treeSpacing: 17, shadowSize: 2048, antialias: true },
  high: { pixelRatio: 2, terrainRes: 64, splitK: 2.8, trees: true, treeSpacing: 15, shadowSize: 4096, antialias: true },
};

const CRASH_TEXT = {
  gear: ['Landing gear collapsed', 'The touchdown was far too hard. Arrest the sink rate with a flare before the wheels meet the runway.'],
  impact: ['Crashed', 'The airframe struck the ground.'],
  water: ['Crashed into the sea', 'The aircraft hit the water at speed.'],
  ditched: ['Ditched', 'You put it down on the water. The aircraft is lost, but the crew is swimming.'],
  overstress: ['Structural failure', 'The load factor exceeded what the airframe can take and the wings failed.'],
  overspeed: ['Structural failure', 'Far beyond the never-exceed speed, flutter tore the aircraft apart.'],
  collision: ['Collision', 'The aircraft hit a building.'],
  trees: ['Crashed', 'The aircraft ran into trees and rough ground at speed.'],
};

const SCENARIOS = [
  { name: 'First flight', cfg: { aircraft: 'trainer', airport: 'KSKY', start: 'runway0', time: 9.5, weather: 'fair', windDir: 30, windSpeed: 6 } },
  { name: 'Mountain approach', cfg: { aircraft: 'trainer', airport: 'KMTN', start: 'final0', time: 16.5, weather: 'clear', windDir: 70, windSpeed: 5 } },
  { name: 'Aerobatics', cfg: { aircraft: 'aerobat', airport: 'KISL', start: 'air', time: 11, weather: 'fair', windDir: 250, windSpeed: 5 } },
  { name: 'Supersonic', cfg: { aircraft: 'fighter', airport: 'KNOR', start: 'air', time: 14, weather: 'scattered', windDir: 270, windSpeed: 12 } },
  { name: 'Crosswind landing', cfg: { aircraft: 'airliner', airport: 'KSKY', start: 'final0', time: 17.6, weather: 'scattered', windDir: 100, windSpeed: 22 } },
  { name: 'Night ILS', cfg: { aircraft: 'airliner', airport: 'KSKY', start: 'final1', time: 22.5, weather: 'overcast', windDir: 190, windSpeed: 8 } },
  { name: 'Storm', cfg: { aircraft: 'trainer', airport: 'KVAL', start: 'final0', time: 15, weather: 'storm', windDir: 160, windSpeed: 28 } },
];

const $ = (id) => document.getElementById(id);
const store = {
  get(key, def) { try { const v = localStorage.getItem('skyward.' + key); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(key, v) { try { localStorage.setItem('skyward.' + key, JSON.stringify(v)); } catch { /* private mode */ } },
};
const fmtTime = (h) => { const hh = Math.floor(h) % 24, mm = Math.floor((h - Math.floor(h)) * 60); return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`; };

class Game {
  constructor() {
    this.state = 'loading';
    this.settings = Object.assign({ quality: 'medium', volume: 0.7, autoRudder: true, autoTrim: true, bankHold: true, damage: true, gEffects: true, timeFlow: false }, store.get('settings', {}));
    this.cfg = Object.assign({ aircraft: 'trainer', airport: 'KSKY', start: 'runway0', time: 10, weather: 'fair', windDir: 30, windSpeed: 8 }, store.get('flight', {}));
    if (!DEFS[this.cfg.aircraft]) this.cfg.aircraft = 'trainer';
    if (!AIRPORTS.find((a) => a.id === this.cfg.airport)) this.cfg.airport = 'KSKY';
    if (!WEATHER[this.cfg.weather]) this.cfg.weather = 'fair';
    this.ac = null; this.model = null; this.def = null;
    this.acc = 0; this.clock = 0; this.last = 0;
    this.prevPos = new Vec3(); this.prevQ = new Quat(); this._q = new Quat();
    this.renderPos = new THREE.Vector3(); this.renderQuat = new THREE.Quaternion();
    this.nav = { airport: AIRPORTS[0], manual: false };
    this.warnings = []; this.warnSet = new Set();
    this.lightsOn = false; this.smokeOn = false;
    this.gStress = 0; this.redStress = 0;
    this.terrainWarnT = 0; this.terrainAhead = false;
    this.landing = null; this.reportT = 0; this.hintT = 0; this.crashT = -1;
    this.trailPrev = []; this.dustT = 0;
    this.hudState = { stick: { pitch: 0, roll: 0, yaw: 0 }, warnings: this.warnings };
    this.frameCount = 0; this.fps = 60; this.fpsT = 0;
    this.menuSpin = 0.7;
    this._v = new THREE.Vector3(); this._v2 = new THREE.Vector3(); this._w = { x: 0, z: 0 }; this._l = { u: 0, v: 0 };
    this.noseDir = new THREE.Vector3();
  }

  // ================================================================== boot
  async init() {
    const q = QUALITY[this.settings.quality] || QUALITY.medium;
    this.quality = q;
    installAtmosphere();
    const canvas = $('gl');
    const renderer = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: q.antialias, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.62;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0xffffff, 1e-9);     // enables the (replaced) fog shader chunks
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.25, 320000);
    this.scene.add(this.camera);
    this.setLoad(0.08, 'Building the island…');
    this.world = new World(this.scene, renderer, q);
    await this.world.init();
    this.setLoad(0.3, 'Charting the map…');
    this.hud = new Hud($('hud'));
    this.hud.setOverview(this.world.overview.overview, this.world.overview.size, this.world.overview.half);
    this.effects = new Effects(this.scene);
    this.rain = new Rain(this.scene);
    this.rig = new CameraRig(this.camera);
    this.audio = new Audio();
    this.audio.volume = this.settings.volume;
    this.input = new Input(canvas);
    this.bindInput();
    // landing light
    this.spot = new THREE.SpotLight(0xfff2d8, 0, 1400, 0.24, 0.7, 1.6);
    this.spot.castShadow = false;
    this.scene.add(this.spot); this.scene.add(this.spot.target);
    this.buildMenu();
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.state === 'flying') this.pause(); });
    this.setLoad(0.4, 'Rolling the aircraft out…');
    await this.spawn(this.menuCfg(), true);
    this.setLoad(1, 'Ready');
    this.showMenu();
    $('loading').classList.add('hidden');
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
    window.__game = this;
  }

  setLoad(f, text) { $('load-fill').style.width = Math.round(f * 100) + '%'; if (text) $('load-text').textContent = text; }

  resize() {
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  /** Dynamic resolution: shed pixels when the frame rate stays low, restore them when there is headroom. */
  adaptResolution() {
    if (this.state !== 'flying' && this.state !== 'menu') { this._slow = 0; this._fast = 0; return; }
    const max = Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio);
    const cur = this.renderer.getPixelRatio();
    if (this.fps < 42) { this._slow = (this._slow || 0) + 1; this._fast = 0; }
    else if (this.fps > 57) { this._fast = (this._fast || 0) + 1; this._slow = 0; }
    else { this._slow = 0; this._fast = 0; }
    let next = cur;
    if (this._slow >= 5 && cur > 0.6) next = Math.max(0.6, cur - 0.2);
    else if (this._fast >= 30 && cur < max) next = Math.min(max, cur + 0.1);
    if (next !== cur) { this.renderer.setPixelRatio(next); this.renderer.setSize(window.innerWidth, window.innerHeight, false); this._slow = 0; this._fast = 0; }
  }

  // ================================================================== flight setup
  menuCfg() { return { ...this.cfg, start: 'runway0', showroom: true }; }

  startLabel(a, key) {
    const r0 = a.runways[0].id, r1 = a.runways[1].id;
    return { runway0: `Runway ${r0} — take-off`, runway1: `Runway ${r1} — take-off`, final0: `Final approach runway ${r0}`, final1: `Final approach runway ${r1}`, air: 'In the air overhead' }[key];
  }

  /** Create the aircraft + model and place it according to cfg. */
  async spawn(cfg, showroom = false) {
    const def = DEFS[cfg.aircraft];
    const world = this.world;
    if (this.model) this.scene.remove(this.model.group);
    this.effects.clear();
    this.def = def;
    const ac = this.ac = new Aircraft(def, world.env);
    ac.assist.autoRudder = this.settings.autoRudder; ac.assist.autoTrim = this.settings.autoTrim; ac.assist.bankHold = this.settings.bankHold;
    ac.realism.structural = this.settings.damage;
    this.models = this.models || {};
    if (!this.models[def.id]) { const m = buildAircraftModel(def); applyAtmosphereToTree(m.group); this.models[def.id] = m; }
    this.model = this.models[def.id];
    this._cockpit = null;
    this.scene.add(this.model.group);
    this.model.group.visible = true;
    this.audio.setAircraft(def);
    world.setTime(cfg.time);
    world.setWeather(cfg.weather, { windDir: cfg.windDir, windSpeed: cfg.windSpeed });
    world.timeScale = this.settings.timeFlow && !showroom ? 60 : 0;
    world.wind.gust.set(0, 0, 0);

    const a = AIRPORTS.find((x) => x.id === cfg.airport) || AIRPORTS[0];
    const half = a.length / 2;
    const jet = def.engines[0].type === 'jet';
    let opts;
    const start = cfg.start || 'runway0';
    const secondary = start.endsWith('1');
    const hdg = ((a.heading + (secondary ? 180 : 0)) % 360) * DEG;
    const sgn = secondary ? -1 : 1;                 // landing / take-off direction along +u or -u
    if (start.startsWith('runway')) {
      const off = Math.min(a.length * 0.12, def.id === 'airliner' ? 90 : 45);
      airportWorld(a, sgn * (-half + off), 0, this._w);
      opts = { x: this._w.x, z: this._w.z, heading: hdg, onGround: true, parkingBrake: true, flapIndex: def.id === 'airliner' ? 2 : 0 };
    } else if (start.startsWith('final')) {
      const dist = (def.id === 'airliner' ? 6 : def.id === 'fighter' ? 5 : 3) * NM;
      airportWorld(a, sgn * (-half - dist), 0, this._w);
      const alt = a.elevation + (dist + 300) * Math.tan(3 * DEG);
      const fi = def.flaps ? (def.id === 'trainer' ? 2 : def.flaps.settings.length - 1) : 0;
      opts = { x: this._w.x, z: this._w.z, heading: hdg, altitude: alt, speed: def.speeds.approach * (def.id === 'airliner' ? 1.0 : 1.08), onGround: false, flapIndex: fi, gearDown: true, gamma: -3, trimGamma: -3 };
    } else {
      const agl = def.id === 'fighter' ? 6000 : def.id === 'airliner' ? 3000 : def.id === 'aerobat' ? 1300 : 1000;
      airportWorld(a, sgn * -half * 0.2, 0, this._w);
      opts = { x: this._w.x, z: this._w.z, heading: hdg, altitude: a.elevation + agl, speed: def.speeds.cruise * 0.92, onGround: false, gearDown: !def.retractable ? true : false };
    }
    this.startOpts = opts; this.startCfg = { ...cfg };
    ac.reset(opts);
    if (!opts.onGround) ac.trimInAir(opts.speed, opts.trimGamma || 0, 40);
    this.gearHeight = -Math.min(...ac.gear.wheels.map((w) => w.r0.y));
    this.prevPos.copy(ac.pos); this.prevQ.copy(ac.q);
    this.syncRender(1);
    // terrain around the start point must exist before the first frame
    this.camera.position.set(ac.pos.x - 30, ac.pos.y + 15, ac.pos.z - 30);
    await world.terrain.preload(this.camera.position, (n) => this.setLoad(0.4 + 0.55 * Math.min(1, n / 500), 'Loading scenery…'));
    if (opts.onGround) {
      // the height field is exact now: settle on the gear
      ac.reset(opts);
      for (let i = 0; i < 600; i++) ac.step(PHYSICS_DT);
      ac.events.length = 0;
    }
    this.prevPos.copy(ac.pos); this.prevQ.copy(ac.q);
    this.acc = 0;
    this.nav.airport = a; this.nav.manual = false; this.nav.runwayIndex = secondary ? 1 : 0;
    this.landing = null; this.crashT = -1; this.gStress = 0; this.redStress = 0;
    this.trailPrev.length = 0;
    this.smokeOn = false;
    this.lightsOn = world.sky.night > 0.3;
    this.rig.first = true;
    world.sky.updateEnvironment(performance.now() / 1000, true);
  }

  showMenu() {
    this.state = 'menu';
    this.input.enabled = false;
    if (this.input.mouseYoke) this.input.setMouseYoke(false);
    this.rig.setMode('orbit'); this.rig.zoom = 1.25; this.rig.orbitEl = 0.16;
    $('menu').classList.remove('hidden');
    for (const id of ['pause', 'crash', 'report', 'hint']) $(id).classList.add('hidden');
    this.audio.suspend();
    this.refreshMenu();
  }

  async startFlight(cfg) {
    this.audio.init();
    while (this._respawning) await new Promise((r) => setTimeout(r, 40));
    store.set('flight', this.cfg);
    $('fade').classList.add('on');
    $('menu').classList.add('hidden');
    for (const id of ['pause', 'crash', 'report']) $(id).classList.add('hidden');
    this.state = 'starting';
    await new Promise((r) => setTimeout(r, 380));
    await this.spawn(cfg, false);
    this.rig.setMode(cfg.start && !cfg.start.startsWith('runway') ? 'chase' : 'chase');
    this.rig.zoom = 1;
    this.input.enabled = true;
    this.state = 'flying';
    this.audio.resume();
    this.last = performance.now();
    $('fade').classList.remove('on');
    const onGround = this.ac.gear.onGround || this.startOpts.onGround;
    this.hint(onGround ? 'Press B to release the parking brake, hold R for power, steer with Q / E  ·  / shows all controls' : 'You have control  ·  / shows all controls', 9);
  }

  hint(text, seconds = 6) { const h = $('hint'); h.textContent = text; h.classList.remove('hidden'); this.hintT = seconds; }

  // ================================================================== menu wiring
  buildMenu() {
    const list = $('aircraft-list');
    for (const d of DEF_LIST) {
      const el = document.createElement('div');
      el.className = 'card'; el.dataset.id = d.id;
      const specs = Object.entries(d.specs).map(([k, v]) => `<span>${k}</span><span>${v}</span>`).join('');
      el.innerHTML = `<div class="name">${d.name}</div><div class="cat">${d.category}</div><div class="desc">${d.description}</div><div class="specs">${specs}</div>`;
      el.addEventListener('click', () => { if (this.cfg.aircraft !== d.id) { this.cfg.aircraft = d.id; this.refreshMenu(); this.respawnShowroom(); } });
      list.appendChild(el);
    }
    const selA = $('sel-airport');
    for (const a of AIRPORTS) selA.add(new Option(`${a.id} — ${a.name}`, a.id));
    selA.addEventListener('change', () => { this.cfg.airport = selA.value; this.refreshMenu(); this.respawnShowroom(); });
    $('sel-start').addEventListener('change', () => { this.cfg.start = $('sel-start').value; this.refreshMenu(); });
    const selW = $('sel-weather');
    for (const [id, w] of Object.entries(WEATHER)) selW.add(new Option(w.name, id));
    selW.addEventListener('change', () => {
      this.cfg.weather = selW.value; this.cfg.windSpeed = WEATHER[selW.value].wind;
      this.applyConditions(); this.refreshMenu();
    });
    $('rng-time').addEventListener('input', () => { this.cfg.time = +$('rng-time').value; this.world.setTime(this.cfg.time); this.refreshMenu(); });
    $('rng-winddir').addEventListener('input', () => { this.cfg.windDir = +$('rng-winddir').value; this.applyConditions(); this.refreshMenu(); });
    $('rng-windspd').addEventListener('input', () => { this.cfg.windSpeed = +$('rng-windspd').value; this.applyConditions(); this.refreshMenu(); });
    const sc = $('scenarios');
    for (const s of SCENARIOS) {
      const b = document.createElement('button');
      b.textContent = s.name;
      b.addEventListener('click', () => { Object.assign(this.cfg, s.cfg); this.refreshMenu(); this.startFlight({ ...this.cfg }); });
      sc.appendChild(b);
    }
    $('btn-fly').addEventListener('click', () => this.startFlight({ ...this.cfg }));
    // dialogs
    const open = (id) => $(id).classList.remove('hidden'), close = (id) => $(id).classList.add('hidden');
    $('btn-help').addEventListener('click', () => open('help'));
    $('btn-help-close').addEventListener('click', () => close('help'));
    $('btn-pause-help').addEventListener('click', () => open('help'));
    $('btn-settings').addEventListener('click', () => open('settings'));
    $('btn-pause-settings').addEventListener('click', () => open('settings'));
    $('btn-settings-close').addEventListener('click', () => close('settings'));
    $('btn-resume').addEventListener('click', () => this.resume());
    $('btn-restart').addEventListener('click', () => this.startFlight(this.startCfg));
    $('btn-quit').addEventListener('click', () => this.toMenu());
    $('btn-crash-restart').addEventListener('click', () => this.startFlight(this.startCfg));
    $('btn-crash-menu').addEventListener('click', () => this.toMenu());
    // settings
    const s = this.settings;
    $('sel-quality').value = s.quality;
    $('sel-quality').addEventListener('change', () => { s.quality = $('sel-quality').value; store.set('settings', s); store.set('flight', this.cfg); location.reload(); });
    $('rng-volume').value = s.volume; $('vol-label').textContent = Math.round(s.volume * 100) + '%';
    $('rng-volume').addEventListener('input', () => { s.volume = +$('rng-volume').value; $('vol-label').textContent = Math.round(s.volume * 100) + '%'; this.audio.setVolume(s.volume); store.set('settings', s); });
    const chk = (id, key, apply) => {
      $(id).checked = s[key];
      $(id).addEventListener('change', () => { s[key] = $(id).checked; store.set('settings', s); if (apply) apply(); });
    };
    chk('chk-autorudder', 'autoRudder', () => { if (this.ac) this.ac.assist.autoRudder = s.autoRudder; });
    chk('chk-autotrim', 'autoTrim', () => { if (this.ac) this.ac.assist.autoTrim = s.autoTrim; });
    chk('chk-bankhold', 'bankHold', () => { if (this.ac) this.ac.assist.bankHold = s.bankHold; });
    chk('chk-damage', 'damage', () => { if (this.ac) this.ac.realism.structural = s.damage; });
    chk('chk-geffects', 'gEffects');
    chk('chk-timeflow', 'timeFlow', () => { this.world.timeScale = s.timeFlow && this.state !== 'menu' ? 60 : 0; });
  }

  applyConditions() { this.world.setWeather(this.cfg.weather, { windDir: this.cfg.windDir, windSpeed: this.cfg.windSpeed }); }

  refreshMenu() {
    const c = this.cfg;
    for (const el of document.querySelectorAll('#aircraft-list .card')) el.classList.toggle('sel', el.dataset.id === c.aircraft);
    const a = AIRPORTS.find((x) => x.id === c.airport);
    $('sel-airport').value = c.airport;
    $('airport-info').textContent = `${a.description} Runway ${a.runways[0].id}/${a.runways[1].id}, ${Math.round(a.length)} m × ${a.width} m, elevation ${Math.round(a.elevation / FT)} ft.`;
    const ss = $('sel-start');
    ss.innerHTML = '';
    for (const k of ['runway0', 'runway1', 'final0', 'final1', 'air']) ss.add(new Option(this.startLabel(a, k), k));
    ss.value = c.start;
    $('rng-time').value = c.time; $('time-label').textContent = fmtTime(c.time);
    $('sel-weather').value = c.weather;
    $('rng-winddir').value = c.windDir; $('winddir-label').textContent = String(c.windDir).padStart(3, '0') + '°';
    $('rng-windspd').value = c.windSpeed; $('windspd-label').textContent = c.windSpeed + ' kt';
    const d = DEFS[c.aircraft];
    const warn = d.id === 'airliner' && a.length < 1800 ? ' — <b>this runway is too short for the airliner</b>' : '';
    $('summary').innerHTML = `<b>${d.name}</b> · ${a.name} · ${this.startLabel(a, c.start)} · ${fmtTime(c.time)} · ${WEATHER[c.weather].name}${warn}`;
  }

  async respawnShowroom() {
    if (this.state !== 'menu' || this._respawning) { this._respawnAgain = true; return; }
    this._respawning = true;
    $('fade').classList.add('on');
    await new Promise((r) => setTimeout(r, 260));
    do { this._respawnAgain = false; await this.spawn(this.menuCfg(), true); } while (this._respawnAgain);
    $('fade').classList.remove('on');
    this._respawning = false;
  }

  async toMenu() {
    $('fade').classList.add('on');
    for (const id of ['pause', 'crash', 'report', 'hint']) $(id).classList.add('hidden');
    this.state = 'starting';
    await new Promise((r) => setTimeout(r, 300));
    await this.spawn(this.menuCfg(), true);
    this.showMenu();
    $('fade').classList.remove('on');
  }

  pause() { if (this.state !== 'flying') return; this.state = 'paused'; $('pause').classList.remove('hidden'); this.audio.suspend(); if (this.input.mouseYoke) this.input.setMouseYoke(false); }
  resume() { if (this.state !== 'paused') return; this.state = 'flying'; for (const id of ['pause', 'help', 'settings']) $(id).classList.add('hidden'); this.audio.resume(); this.last = performance.now(); }

  // ================================================================== input actions
  bindInput() {
    const I = this.input, flying = () => this.state === 'flying' && this.ac && !this.ac.crashed;
    const toast = (t, col) => this.hud.toast(t, col);
    I.on('gear', () => {
      if (!flying()) return;
      const ac = this.ac;
      if (!ac.def.retractable) return toast('Fixed landing gear');
      if (ac.gear.onGround) return toast('Gear lever locked on the ground');
      ac.ctrl.gearDown = !ac.ctrl.gearDown; this.audio.play('click');
      toast(ac.ctrl.gearDown ? 'Gear DOWN' : 'Gear UP');
    });
    const flaps = (d) => {
      if (!flying()) return;
      const ac = this.ac, f = ac.def.flaps;
      if (!f || f.auto) return toast(f ? 'Flaps are automatic on this aircraft' : 'No flaps on this aircraft');
      const i = clamp(ac.ctrl.flapIndex + d, 0, f.settings.length - 1);
      if (i !== ac.ctrl.flapIndex) { ac.ctrl.flapIndex = i; this.audio.play('click'); }
      toast('Flaps ' + (f.labels ? f.labels[i] : f.settings[i] + '°'));
    };
    I.on('flapsDown', () => flaps(1)); I.on('flapsUp', () => flaps(-1));
    I.on('parkingBrake', () => { if (!flying()) return; const c = this.ac.ctrl; c.parkingBrake = !c.parkingBrake; this.audio.play('click'); toast(c.parkingBrake ? 'Parking brake SET' : 'Parking brake released'); });
    I.on('spoiler', () => { if (!flying()) return; const ac = this.ac; if (ac.def.id === 'trainer' || ac.def.id === 'aerobat') return toast('No speed brakes on this aircraft'); ac.ctrl.spoiler = ac.ctrl.spoiler > 0.5 ? 0 : 1; toast(ac.ctrl.spoiler ? 'Speed brakes OUT' : 'Speed brakes IN'); });
    I.on('reverse', () => {
      if (!flying()) return; const ac = this.ac;
      if (!ac.def.engines[0].reverser) return toast('No thrust reversers on this aircraft');
      if (!ac.gear.onGround && !ac.ctrl.reverse) return toast('Reversers are locked in flight');
      ac.ctrl.reverse = !ac.ctrl.reverse; toast(ac.ctrl.reverse ? 'Reverse thrust' : 'Reversers stowed');
    });
    I.on('engine', () => {
      if (!flying()) return; const ac = this.ac;
      const running = ac.engines.some((e) => e.running);
      for (const e of ac.engines) { if (running) e.stop(); else e.start(); }
      toast(running ? 'Engine shut down' : (ac.fuel > 0 ? 'Engine start' : 'No fuel'));
    });
    I.on('autopilot', () => {
      if (!flying()) return; const ac = this.ac;
      if (ac.ap.engaged) { ac.ap.engaged = false; this.audio.play('apoff'); return toast('Autopilot OFF', '#ffc247'); }
      if (ac.gear.onGround) return toast('Autopilot unavailable on the ground');
      ac.ap.engage(); this.audio.play('apon'); toast('Autopilot ON — arrows set heading / altitude', '#5df59a');
    });
    I.on('autothrottle', () => {
      if (!flying()) return; const ac = this.ac;
      if (ac.ap.autothrottle) { ac.ctrl.throttle = ac.ap.throttle; ac.ap.autothrottle = false; return toast('Autothrottle OFF', '#ffc247'); }
      ac.ap.engageAutothrottle(); toast('Autothrottle ON — R / F set speed', '#5df59a');
    });
    I.on('apDisengaged', () => { this.audio.play('apoff'); toast('Autopilot OFF — manual control', '#ffc247'); });
    I.on('throttleIdle', () => { if (flying() && !this.ac.ap.autothrottle) this.ac.ctrl.throttle = 0; });
    I.on('throttleFull', () => { if (flying() && !this.ac.ap.autothrottle) this.ac.ctrl.throttle = 1; });
    I.on('camera', (m) => { if (this.state === 'flying' || this.state === 'paused') { this.rig.setMode(m); toast(CAMERA_NAMES[m]); } });
    I.on('cycleCamera', () => { if (this.state === 'flying') { this.rig.cycle(); toast(CAMERA_NAMES[this.rig.mode]); } });
    I.on('recenter', () => this.rig.recenter());
    I.on('pause', () => { if (this.state === 'flying') this.pause(); else if (this.state === 'paused') this.resume(); });
    I.on('menu', () => {
      const openDlg = ['help', 'settings'].find((id) => !$(id).classList.contains('hidden'));
      if (openDlg) return $(openDlg).classList.add('hidden');
      if (this.state === 'flying') this.pause(); else if (this.state === 'paused') this.resume();
    });
    I.on('hud', () => { this.hud.visible = !this.hud.visible; });
    I.on('panel', () => { this.hud.panelOn = !this.hud.panelOn; toast(this.hud.panelOn ? 'Analog instrument panel' : 'Head-up symbology'); });
    I.on('map', () => { this.hud.cycleMapRange(); });
    I.on('nav', () => {
      if (!flying()) return;
      const i = AIRPORTS.indexOf(this.nav.airport);
      this.nav.airport = AIRPORTS[(i + 1) % AIRPORTS.length]; this.nav.manual = true;
      toast(`NAV ${this.nav.airport.id} — ${this.nav.airport.name}`, '#62e4ff');
    });
    I.on('lights', () => { if (!flying()) return; this.lightsOn = !this.lightsOn; this.audio.play('click'); toast(this.lightsOn ? 'Landing lights ON' : 'Landing lights OFF'); });
    I.on('smoke', () => { if (!flying()) return; this.smokeOn = !this.smokeOn; toast(this.smokeOn ? 'Smoke ON' : 'Smoke OFF'); });
    I.on('mouseYoke', () => { if (this.state === 'flying') I.setMouseYoke(!I.mouseYoke); });
    I.on('mouseYokeChanged', (on) => toast(on ? 'Mouse yoke ON — right click centres, Y to release' : 'Mouse yoke OFF'));
    I.on('help', () => { const h = $('help'); h.classList.toggle('hidden'); if (!h.classList.contains('hidden') && this.state === 'flying') this.pause(); });
    I.on('confirm', () => { if (this.state === 'crashed') this.startFlight(this.startCfg); });
  }

  // ================================================================== per-frame
  syncRender(alpha) {
    const ac = this.ac, p = this.prevPos, q = this._q.copy(this.prevQ).slerp(ac.q, alpha);
    this.renderPos.set(p.x + (ac.pos.x - p.x) * alpha, p.y + (ac.pos.y - p.y) * alpha, p.z + (ac.pos.z - p.z) * alpha);
    this.renderQuat.set(q.x, q.y, q.z, q.w);
    this.model.group.position.copy(this.renderPos);
    this.model.group.quaternion.copy(this.renderQuat);
  }

  frame(tms) {
    requestAnimationFrame((t) => this.frame(t));
    const dtReal = Math.min(0.1, Math.max(0, (tms - this.last) / 1000));
    this.last = tms;
    const now = tms / 1000;
    this.frameCount++; this.fpsT += dtReal;
    if (this.fpsT > 0.5) { this.fps = this.frameCount / this.fpsT; this.frameCount = 0; this.fpsT = 0; this.adaptResolution(); }
    const ac = this.ac;
    if (!ac || this.state === 'starting' || this.state === 'loading') { return; }
    const running = this.state === 'flying' || this.state === 'menu' || this.state === 'crashed';
    const dt = running ? dtReal : 0;
    this.clock += dt;

    // --- controls and physics
    if (this.state === 'flying') { this.input.update(dt, ac); if (this.onFrame) this.onFrame(dt, ac); }
    if (running && !ac.crashed) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= PHYSICS_DT && steps < 40) {
        this.prevPos.copy(ac.pos); this.prevQ.copy(ac.q);
        ac.step(PHYSICS_DT);
        this.acc -= PHYSICS_DT; steps++;
        if (ac.crashed) break;
      }
      if (steps >= 40) this.acc = 0;
      if (this.state === 'flying') this.postPhysics(dt);
    }
    this.syncRender(ac.crashed ? 1 : clamp(this.acc / PHYSICS_DT, 0, 1));
    this.processEvents();

    // --- aircraft visuals
    const night = this.world.sky.night;
    const model = this.model;
    this._lights = this._lights || { nav: false, strobe: false, beacon: false, landing: false };
    this._lights.nav = night > 0.25 || this.lightsOn; this._lights.strobe = !ac.crashed; this._lights.beacon = ac.engines.some((e) => e.running); this._lights.landing = this.lightsOn;
    this._mstate = this._mstate || {};
    Object.assign(this._mstate, { surf: ac.surf, engines: ac.engines, wheels: ac.gear.wheels, time: this.clock, lights: this._lights });
    model.update(this._mstate, dt);
    const cockpit = this.rig.mode === 'cockpit' && this.state !== 'menu';
    if (this._cockpit !== cockpit || this._cockpitModel !== model) { model.setCockpitView(cockpit); this._cockpit = cockpit; this._cockpitModel = model; }

    // --- camera
    const look = this.input.takeLook();
    if (this.state === 'menu') { this.rig.orbitAz += dtReal * 0.1; }
    this._rs = this._rs || { groundHeight: (x, z) => this.world.groundHeight(x, z) };
    Object.assign(this._rs, { pos: this.renderPos, quat: this.renderQuat, ac, def: this.def, eye: model.anchors.pilotEye });
    this.rig.update(dtReal, this._rs, look);

    // --- landing light
    if (this.lightsOn && !ac.crashed) {
      this._v.copy(model.anchors.landingLight).applyQuaternion(this.renderQuat).add(this.renderPos);
      this.spot.position.copy(this._v);
      this._v2.set(60, -9, 0).applyQuaternion(this.renderQuat).add(this._v);
      this.spot.target.position.copy(this._v2);
      this.spot.target.updateMatrixWorld();
      this.spot.intensity = 30000 * (0.25 + 0.75 * night);
    } else this.spot.intensity = 0;

    // --- world, effects
    this.world.update(this.camera, this.renderPos, this.def.ref.b * 0.75 + 5, ac.agl, dt, now, { height: window.innerHeight });
    this.emitTrails(dt);
    this.effects.update(dt, this.camera, this.world.sky, this.world.wind);
    this.rain.update(dtReal, this.camera, this.world.wind, this.world.rain * (this.camera.position.y < this.world.clouds.base + 100 ? 1 : 0), this.world.sky);
    this.renderer.render(this.scene, this.camera);

    // --- overlays
    this.updateOverlays(dt, dtReal);
    if (this.state === 'flying' || this.state === 'paused' || this.state === 'crashed') {
      this.updateHudState();
      this.hud.draw(this.state === 'crashed' ? null : this.hudState, dtReal);
    } else this.hud.draw(null, dtReal);

    // --- sound
    if (this.state === 'flying' || this.state === 'crashed') {
      const cd = this.camera.position.distanceTo(this.renderPos);
      let rv = 0;
      if (cd > 1) rv = ((this.renderPos.x - this.camera.position.x) * ac.vel.x + (this.renderPos.y - this.camera.position.y) * ac.vel.y + (this.renderPos.z - this.camera.position.z) * ac.vel.z) / cd;
      const fixed = this.rig.mode === 'flyby' || this.rig.mode === 'tower';
      this._as = this._as || {};
      Object.assign(this._as, { ac, cameraMode: this.rig.mode, camDist: cd, radialVel: fixed ? rv : 0, warnings: this.warnSet, rain: this.world.rain, gearHeight: this.gearHeight });
      this.audio.update(this._as, dt);
    }
  }

  /** Game rules evaluated after the physics: obstacles, rough ground, landing roll-out. */
  postPhysics(dt) {
    const ac = this.ac, world = this.world;
    if (ac.crashed) return;
    // buildings
    if (ac.agl < 60) {
      const hit = (bx, by, bz) => {
        this._v.set(bx, by, bz).applyQuaternion(this.renderQuat);
        const x = ac.pos.x + this._v.x, y = ac.pos.y + this._v.y, z = ac.pos.z + this._v.z;
        return world.airports.hitsObstacle(x, y, z) || world.towns.hits(x, y, z);
      };
      const b = this.def.ref.b / 2;
      if (hit(2, 0, 0) || hit(0, 0, b) || hit(0, 0, -b) || hit(-3, 0, 0)) ac.crash('collision');
    }
    // forests and boulders at speed
    if (ac.gear.onGround) {
      const gs = Math.hypot(ac.vel.x, ac.vel.z);
      if (gs > 20 && ac.gear.wheels.some((w) => w.contact && w.surface === 2)) ac.crash('trees');
    }
    // landing roll-out bookkeeping
    const L = this.landing;
    if (L && !L.stopped) {
      if (!ac.gear.onGround && ac.airTime > 0.25 && !L.airborneAgain) { L.airborneAgain = true; }
      if (ac.gear.onGround && L.airborneAgain) { L.bounces++; L.airborneAgain = false; }
      if (ac.gear.onGround && ac.vel.length() < 1.0 && ac.time - L.time > 2) {
        L.stopped = true;
        const dist = Math.hypot(ac.pos.x - L.x, ac.pos.z - L.z);
        this.showReport(L, dist);
        this.audio.play('good');
      }
      if (ac.airTime > 6) this.landing = null;       // touch-and-go
    }
  }

  processEvents() {
    const ac = this.ac, ev = ac.events;
    if (!ev.length) return;
    const inside = this.rig.mode === 'cockpit';
    for (const e of ev) {
      if (this.state === 'menu') continue;
      switch (e.type) {
        case 'touchdown': {
          const fpm = e.sink / FPM;
          this.audio.play('thump', clamp(e.sink / 2.5, 0.25, 1.6));
          this.rig.bump(clamp(e.sink / 3, 0.1, 1.2));
          const na = nearestAirport(e.x, e.z).airport;
          airportLocal(na, e.x, e.z, this._l);
          const onRunway = Math.abs(this._l.u) < na.length / 2 + 60 && Math.abs(this._l.v) < na.width / 2 + 2;
          // which way are we landing?
          const along = Math.cos(e.heading) * na.dirX + Math.sin(e.heading) * na.dirZ;
          const fromThreshold = along >= 0 ? this._l.u + na.length / 2 : na.length / 2 - this._l.u;
          this.landing = { time: ac.time, x: e.x, z: e.z, fpm, g: 0, ias: e.ias, onRunway, offset: this._l.v * (along >= 0 ? 1 : -1), fromThreshold, airport: na, bounces: 0, airborneAgain: false, stopped: false,
            runway: na.runways[along >= 0 ? 0 : 1].id, roll: e.roll, drift: e.drift, peakG: ac.nz };
          this.showReport(this.landing, null);
          break;
        }
        case 'chirp': {
          this.audio.play('chirp', inside ? 0.5 : 0.9);
          const w = ac.gear.wheels.find((x) => x.name === e.wheel);
          if (w && w.surface === 0) { this._v.set(w.r0.x, w.r0.y, w.r0.z).applyQuaternion(this.renderQuat).add(this.renderPos); this.effects.tyreSmoke(this._v.x, this._v.y, this._v.z, ac.vel.x, ac.vel.z, clamp(ac.vel.length() / 60, 0.4, 1.5)); }
          break;
        }
        case 'propstrike': this.audio.play('scrape'); this.hud.toast('PROPELLER STRIKE — engine stopped', '#ff5a44', 4); break;
        case 'scrape': this.audio.play('scrape', 0.8); this.rig.bump(0.5); this.hud.toast(`Airframe contact: ${e.part}`, '#ffc247', 3); break;
        case 'ap-disconnect': this.audio.play('apoff'); this.hud.toast('Autopilot disconnected', '#ffc247'); break;
        case 'crash': this.onCrash(e); break;
      }
    }
    ev.length = 0;
  }

  onCrash(e) {
    const ac = this.ac, p = this.renderPos;
    const scale = clamp(this.def.ref.b / 11, 0.8, 3);
    if (e.reason === 'ditched') { this.effects.splash(p.x, 0.5, p.z, scale); this.audio.play('splash'); }
    else if (e.reason === 'water') { this.effects.splash(p.x, 0.5, p.z, scale * 1.6); this.audio.play('splash'); this.audio.play('crash'); this.model.group.visible = false; }
    else {
      const violent = e.reason !== 'gear' || e.speed > 45;
      this.effects.explosion(p.x, Math.max(p.y, this.world.groundHeight(p.x, p.z)) + 1, p.z, violent ? scale : scale * 0.5, ac.vel.x, ac.vel.y, ac.vel.z);
      this.audio.play('crash');
      if (violent) this.model.group.visible = false;
    }
    this.rig.bump(1.5);
    // step back and watch from a distance
    const az = this.rig.az;
    this.rig.setMode('orbit');
    this.rig.orbitAz = az + 0.5; this.rig.orbitEl = 0.3; this.rig.zoom = 4;
    this.state = 'crashed';
    this.input.enabled = false;
    if (this.input.mouseYoke) this.input.setMouseYoke(false);
    this.crashT = 1.6;
    const [title, text] = CRASH_TEXT[e.reason] || CRASH_TEXT.impact;
    $('crash-title').textContent = title; $('crash-text').textContent = text;
    $('report').classList.add('hidden');
  }

  showReport(L, rollout) {
    const grade = L.fpm < 120 ? ['Butter!', '#5df59a'] : L.fpm < 250 ? ['Smooth landing', '#5df59a'] : L.fpm < 420 ? ['Firm landing', '#eaf6ff'] : L.fpm < 650 ? ['Hard landing', '#ffc247'] : ['Very hard landing', '#ff5a44'];
    const rows = [['Touchdown rate', `${Math.round(L.fpm)} ft/min`], ['Speed', `${Math.round(L.ias / KT)} kt`]];
    if (L.onRunway) {
      rows.push(['Runway', `${L.airport.id} ${L.runway}`]);
      rows.push(['Off centreline', `${Math.abs(L.offset).toFixed(1)} m ${L.offset > 0.3 ? 'right' : L.offset < -0.3 ? 'left' : ''}`]);
      rows.push(['Past the threshold', `${Math.round(L.fromThreshold)} m`]);
    } else rows.push(['Surface', 'off runway']);
    if (Math.abs(L.drift) > 3 * DEG) rows.push(['Crab at touchdown', `${Math.abs(L.drift * RAD).toFixed(0)}°`]);
    if (L.bounces) rows.push(['Bounces', String(L.bounces)]);
    if (rollout != null) rows.push(['Landing roll', `${Math.round(rollout)} m`]);
    $('report').innerHTML = `<div class="title">${rollout != null ? 'Full stop' : 'Touchdown'}</div><div class="grade" style="color:${grade[1]}">${grade[0]}</div><div class="grid">${rows.map((r) => `<span>${r[0]}</span><span>${r[1]}</span>`).join('')}</div>`;
    $('report').classList.remove('hidden');
    this.reportT = rollout != null ? 9 : 6;
  }

  emitTrails(dt) {
    const ac = this.ac, model = this.model;
    if (!ac || ac.crashed || this.state === 'menu') { this.trailPrev.length = 0; return; }
    const noz = model.anchors.nozzles || [];
    const jet = this.def.engines[0].type === 'jet';
    const contrail = jet && ac.pos.y > 7800 && ac.engines.some((e) => e.running);
    const smoke = this.smokeOn && ac.engines.some((e) => e.running);
    for (let i = 0; i < noz.length; i++) {
      this._v.copy(noz[i]).applyQuaternion(this.renderQuat).add(this.renderPos);
      const prev = this.trailPrev[i] || (this.trailPrev[i] = { p: this._v.clone(), o: {} });
      if (smoke) {
        Object.assign(prev.o, { life: 9, s0: 0.5, s1: 7, r: 0.92, g: 0.92, b: 0.95, a: 0.5, drag: 1.5, jitter: 0.25, vx: ac.vel.x * 0.05, vy: ac.vel.y * 0.05, vz: ac.vel.z * 0.05, fadeIn: 0.05 });
        this.effects.trail(prev.p, this._v, jet ? 4 : 2.2, prev.o);
      } else if (contrail) {
        Object.assign(prev.o, { life: 26, s0: 2.5, s1: 22, r: 1, g: 1, b: 1, a: 0.42, drag: 0.4, jitter: 0.6, vx: 0, vy: 0, vz: 0, fadeIn: 0.6 });
        this.effects.trail(prev.p, this._v, 16, prev.o);
      }
      prev.p.copy(this._v);
    }
    // dust behind the wheels on unpaved ground
    if (ac.gear.onGround) {
      const gs = Math.hypot(ac.vel.x, ac.vel.z);
      this.dustT -= dt * gs;
      if (gs > 6 && this.dustT < 0) {
        this.dustT = 5;
        for (const w of ac.gear.wheels) if (w.contact && w.surface !== 0) { this._v.set(w.r0.x, w.r0.y, w.r0.z).applyQuaternion(this.renderQuat).add(this.renderPos); this.effects.dust(this._v.x, this._v.y, this._v.z, ac.vel.x, ac.vel.z); }
      }
      // skidding tyres
      if (ac.gear.maxSkid > 0.55 && gs > 12 && Math.random() < dt * 14) {
        for (const w of ac.gear.wheels) if (w.contact && w.slip > 0.5 && w.surface === 0) { this._v.set(w.r0.x, w.r0.y, w.r0.z).applyQuaternion(this.renderQuat).add(this.renderPos); this.effects.tyreSmoke(this._v.x, this._v.y, this._v.z, ac.vel.x, ac.vel.z, 0.6); }
      }
    }
  }

  updateOverlays(dt, dtReal) {
    const ac = this.ac;
    // cloud white-out
    $('whiteout').style.opacity = this.state === 'menu' ? 0 : (this.world.cloudDensity * 0.8 * (1 - 0.6 * this.world.sky.night)).toFixed(3);
    // g-induced loss of vision
    if (this.settings.gEffects && this.state === 'flying' && this.rig.mode === 'cockpit') {
      const tol = this.def.id === 'fighter' ? 6.5 : this.def.id === 'aerobat' ? 5.5 : 4.5;
      this.gStress = clamp(this.gStress + (ac.nz > tol ? (ac.nz - tol) * 0.22 : -0.45) * dt, 0, 1.15);
      this.redStress = clamp(this.redStress + (ac.nz < -2 ? (-2 - ac.nz) * 0.4 : -0.6) * dt, 0, 1);
    } else { this.gStress = Math.max(0, this.gStress - dt); this.redStress = Math.max(0, this.redStress - dt); }
    const g = $('gfx');
    if (this.gStress > 0.01 || this.redStress > 0.01) {
      const k = this.gStress, r = this.redStress;
      g.style.opacity = 1;
      g.style.background = r > k
        ? `radial-gradient(ellipse at center, rgba(160,0,0,${(r * 0.35).toFixed(3)}) 0%, rgba(120,0,0,${Math.min(0.95, r * 1.1).toFixed(3)}) 80%)`
        : `radial-gradient(ellipse at center, rgba(0,0,0,${Math.max(0, k * 1.5 - 0.6).toFixed(3)}) ${Math.max(0, 55 - k * 55).toFixed(0)}%, rgba(0,0,0,${Math.min(1, k * 1.6).toFixed(3)}) ${Math.max(20, 100 - k * 60).toFixed(0)}%)`;
    } else if (g.style.opacity !== '0') g.style.opacity = 0;
    // timed panels
    if (this.reportT > 0) { this.reportT -= dtReal; if (this.reportT <= 0) $('report').classList.add('hidden'); }
    if (this.hintT > 0) { this.hintT -= dtReal; if (this.hintT <= 0) $('hint').classList.add('hidden'); }
    if (this.crashT > 0) { this.crashT -= dtReal; if (this.crashT <= 0 && this.state === 'crashed') $('crash').classList.remove('hidden'); }
  }

  updateHudState() {
    const ac = this.ac, st = this.hudState, def = this.def;
    st.ac = ac; st.camera = this.camera; st.cameraMode = this.rig.mode; st.cameraName = CAMERA_NAMES[this.rig.mode];
    st.wind = this.world.wind; st.clock = fmtTime(this.world.timeOfDay);
    st.gearHeight = this.gearHeight;
    st.stick.pitch = this.ac.ap.engaged ? ac.ap.pitch : this.input.pitch; st.stick.roll = ac.ap.engaged ? ac.ap.roll : this.input.roll; st.stick.yaw = this.input.yaw;
    st.noseDir = this.noseDir.set(1, 0, 0).applyQuaternion(this.renderQuat);

    // --- navigation target: follow the nearest airport unless the pilot picked one
    if (!this.nav.manual) { const n = nearestAirport(ac.pos.x, ac.pos.z); if (n.airport !== this.nav.airport && n.distance < Math.hypot(ac.pos.x - this.nav.airport.x, ac.pos.z - this.nav.airport.z) - 1500) this.nav.airport = n.airport; }
    const a = this.nav.airport;
    const dx = a.x - ac.pos.x, dz = a.z - ac.pos.z;
    const nav = st.nav || (st.nav = {});
    nav.airport = a; nav.distance = Math.hypot(dx, dz); nav.bearing = Math.atan2(dz, dx) * RAD;
    // the runway end we would land on: the one whose landing direction points away from us
    const toward = dx * a.dirX + dz * a.dirZ;         // > 0: we are on the approach side of the primary runway
    const k = toward >= 0 ? 0 : 1, sgn = k === 0 ? 1 : -1;
    const rw = nav.runway || (nav.runway = {});
    rw.id = a.runways[k].id; rw.dx = a.dirX * sgn; rw.dz = a.dirZ * sgn;
    rw.x = a.x - rw.dx * a.length / 2; rw.z = a.z - rw.dz * a.length / 2;
    // ILS deviations
    st.ils = null;
    if (a.ils) {
      const rx = ac.pos.x - rw.x, rz = ac.pos.z - rw.z;
      const along = rx * rw.dx + rz * rw.dz, cross = -rx * rw.dz + rz * rw.dx;   // cross > 0: right of the centreline
      if (along < 300 && along > -32000 && Math.abs(Math.atan2(cross, a.length - along)) < 0.6) {
        const aim = a.length >= 2400 ? 420 : a.length >= 1200 ? 300 : 150;     // abeam the PAPI
        const gsAngle = Math.atan2(ac.pos.y - this.gearHeight - a.elevation, Math.max(1, aim - along)) * RAD;
        const ils = this._ils || (this._ils = {});
        ils.loc = Math.atan2(cross, a.length - along) * RAD;
        ils.gs = gsAngle - 3; ils.dme = Math.max(0, -along) / NM;
        st.ils = ils;
      }
    }

    // --- warnings
    const W = this.warnings, S = this.warnSet; W.length = 0; S.clear();
    const add = (text, level = 1, flash = true) => { W.push({ text, level, flash }); S.add(text); };
    const lim = def.limits, airborne = !ac.gear.onGround;
    if (ac.stallWarning) add('STALL', 2);
    if (ac.cas > lim.vne || (lim.mmo && ac.mach > lim.mmo)) add('OVERSPEED', 2);
    const sink = -ac.vel.y;
    const landingCfg = (!def.retractable || ac.surf.gear > 0.9) && nav.distance < 6000;
    if (airborne && ac.agl > 4 && sink > 3 && ac.agl / sink < (landingCfg ? 2.5 : 7)) add('PULL UP', 2);
    else {
      this.terrainWarnT -= 1 / 60;
      if (this.terrainWarnT <= 0) {
        this.terrainWarnT = 0.25; this.terrainAhead = false;
        if (airborne && !landingCfg && ac.agl > 20) {
          for (const t of [5, 10, 16]) {
            const px = ac.pos.x + ac.vel.x * t, pz = ac.pos.z + ac.vel.z * t, py = ac.pos.y + ac.vel.y * t;
            if (meshHeight(px, pz) + 40 > py) { this.terrainAhead = true; break; }
          }
        }
      }
      if (this.terrainAhead) add('TERRAIN', 2);
    }
    if (airborne && def.retractable && ac.surf.gear < 0.5 && ac.agl < 230 && ac.throttleCmd < 0.35 && ac.vel.y < 0) add('LANDING GEAR', 1);
    if (def.flaps && !def.flaps.auto && ac.surf.flap > 0.05 && lim.vfe && ac.cas > lim.vfe * (1.35 - 0.35 * ac.surf.flap)) add('FLAP OVERSPEED', 1);
    if (lim.vle && def.retractable && ac.surf.gear > 0.2 && ac.cas > lim.vle) add('GEAR OVERSPEED', 1);
    if (airborne && (ac.nz > lim.gPos || ac.nz < lim.gNeg)) add('G LIMIT', 1);
    if (airborne && Math.abs(ac.euler.roll) > 70 * DEG && def.id === 'airliner') add('BANK ANGLE', 1);
    if (ac.fuelFraction < 0.06) add(ac.fuel <= 0 ? 'FUEL EXHAUSTED' : 'LOW FUEL', ac.fuel <= 0 ? 2 : 1, false);
    if (airborne && !ac.engines.some((e) => e.running)) add('ENGINE OUT', 2, false);
    if (!airborne && ac.ctrl.parkingBrake && ac.throttleCmd > 0.3) add('PARKING BRAKE — PRESS B', 1, false);
    if (ac.damage.prop) add('ENGINE DAMAGED', 1, false);
  }
}

const game = new Game();
game.init().catch((err) => {
  console.error(err);
  const t = $('load-text');
  if (t) { t.textContent = 'Could not start: ' + (err && err.message ? err.message : err) + ' — WebGL 2 and a recent browser are required.'; t.style.color = '#ff8a70'; }
});
