/**
 * The 3D presentation of a race (and of the menu backdrop). Reads `RaceView`s
 * produced by the netcode and draws them; it never feeds anything back into
 * the simulation.
 */
import * as THREE from 'three';
import { CAR_COLORS, MAX_RACERS } from '../../../shared/constants';
import { CarFlag } from '../../../shared/protocol/binary';
import type { RaceInfo } from '../../../shared/protocol';
import { pointAt, type Track } from '../../../shared/sim/track';
import { VEHICLE, maxSteerAngle } from '../../../shared/sim/vehicle';
import type { RaceView } from '../net/raceClient';
import type { CameraMode, Quality, Settings } from '../storage/settings';
import { createCar, type CarVisual } from './carModel';
import { Effects } from './effects';
import { buildEnvironment, type Environment } from './trackBuilder';

interface CarEntry {
  visual: CarVisual;
  spin: number;
  roll: number;
  pitch: number;
  prevSpeed: number;
  /** Previous rear wheel positions for skid marks. */
  rearX: [number, number];
  rearZ: [number, number];
  hasRear: boolean;
  smokeBudget: number;
}

const WHEEL_RADIUS = 0.36;

export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.3, 4000);
  readonly effects = new Effects();
  /** Slot the camera follows (-1 = orbit the track). */
  followSlot = -1;
  cameraMode: CameraMode = 'chase';

  private track: Track | null = null;
  private raceInfo: RaceInfo | null = null;
  private environment: Environment | null = null;
  private readonly cars: Array<CarEntry | null> = Array.from({ length: MAX_RACERS }, () => null);
  private settings: Settings;
  private quality: Quality;
  private time = 0;
  private shake = 0;
  private readonly camPos = new THREE.Vector3(0, 60, -80);
  private readonly camLook = new THREE.Vector3();
  private camYaw = 0;
  private camSnap = true;
  private fov = 62;
  private orbitAngle = 0;
  private width = 0;
  private height = 0;
  private pmrem: THREE.PMREMGenerator | null = null;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private nextGate: number | null = null;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement, settings: Settings) {
    this.settings = settings;
    this.quality = settings.quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: settings.quality !== 'low', powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.add(this.effects.group);
    this.applyQuality();
    this.resize();
  }

  get currentTrack(): Track | null {
    return this.track;
  }

  setSettings(settings: Settings): void {
    const qualityChanged = settings.quality !== this.quality;
    this.settings = settings;
    this.cameraMode = settings.camera;
    if (qualityChanged) {
      this.quality = settings.quality;
      this.applyQuality();
      // Scenery density and shadow casters depend on quality: rebuild the
      // world, and the cars of the race in progress with it.
      const track = this.track;
      const race = this.raceInfo;
      if (track) {
        this.track = null;
        this.setTrack(track);
        if (race) this.setRace(race);
      }
    }
    this.effects.intensity = settings.reducedMotion ? 0.35 : this.quality === 'low' ? 0.6 : 1;
  }

  private applyQuality(): void {
    const ratio = Math.min(window.devicePixelRatio || 1, this.quality === 'high' ? 2 : this.quality === 'medium' ? 1.5 : 1);
    this.renderer.setPixelRatio(ratio);
    this.renderer.shadowMap.enabled = this.quality !== 'low';
    this.effects.intensity = this.settings.reducedMotion ? 0.35 : this.quality === 'low' ? 0.6 : 1;
    this.width = 0; // Force a resize with the new pixel ratio.
  }

  resize(): void {
    const canvas = this.renderer.domElement;
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ setup

  /** Builds (or rebuilds) the environment for a track. */
  setTrack(track: Track): void {
    if (this.track === track) return;
    this.disposeCars();
    if (this.environment) {
      this.scene.remove(this.environment.group);
      this.environment.dispose();
    }
    this.track = track;
    const environment = buildEnvironment(track, this.quality);
    this.environment = environment;
    this.scene.add(environment.group);
    this.scene.fog = environment.fog;
    this.effects.clear();
    this.effects.setSurface(track.def.theme === 'glacier');

    const sun = environment.sun;
    sun.castShadow = this.quality !== 'low';
    const size = this.quality === 'high' ? 2048 : 1024;
    sun.shadow.mapSize.set(size, size);
    const range = this.quality === 'high' ? 70 : 55;
    sun.shadow.camera.left = -range;
    sun.shadow.camera.right = range;
    sun.shadow.camera.top = range;
    sun.shadow.camera.bottom = -range;
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 320;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    sun.shadow.camera.updateProjectionMatrix();

    // Image-based lighting from the sky so paint, glass and ice reflect something.
    this.envTarget?.dispose();
    this.pmrem ??= new THREE.PMREMGenerator(this.renderer);
    const skyScene = new THREE.Scene();
    const skyCopy = environment.sky.clone();
    skyCopy.position.set(0, 0, 0);
    skyScene.add(skyCopy);
    this.envTarget = this.pmrem.fromScene(skyScene, 0.04);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = 0.55;

    this.nextGate = null;
    this.camSnap = true;
    this.orbitAngle = 0;
  }

  /** Creates the car models for a race. */
  setRace(race: RaceInfo): void {
    this.disposeCars();
    this.raceInfo = race;
    for (const info of race.cars) {
      const colour = CAR_COLORS[info.colour % CAR_COLORS.length]!;
      const visual = createCar(colour, info.slot + 1, info.name, info.isBot, this.quality !== 'low');
      visual.root.visible = false;
      this.scene.add(visual.root);
      this.cars[info.slot] = {
        visual,
        spin: 0,
        roll: 0,
        pitch: 0,
        prevSpeed: 0,
        rearX: [0, 0],
        rearZ: [0, 0],
        hasRear: false,
        smokeBudget: 0,
      };
    }
    this.effects.clear();
    this.camSnap = true;
  }

  /** Removes the cars of the race that just ended. */
  clearCars(): void {
    this.raceInfo = null;
    this.disposeCars();
  }

  private disposeCars(): void {
    for (let i = 0; i < this.cars.length; i++) {
      const entry = this.cars[i];
      if (!entry) continue;
      this.scene.remove(entry.visual.root);
      entry.visual.dispose();
      this.cars[i] = null;
    }
  }

  /** Marks which gate the followed car is heading for. */
  setNextGate(index: number | null): void {
    if (index === this.nextGate) return;
    this.nextGate = index;
    this.environment?.setNextGate(index);
  }

  // ---------------------------------------------------------------- effects

  impact(x: number, z: number, strength: number, local: boolean): void {
    this.effects.sparks(x, z, strength, this.track?.def.theme === 'glacier');
    if (local && !this.settings.reducedMotion) this.shake = Math.min(1, this.shake + 0.15 + strength * 0.05);
  }

  checkpointFlash(x: number, z: number): void {
    this.effects.flash(x, z);
  }

  // ------------------------------------------------------------------ frame

  /** Draws one frame. `view` is null for the menu backdrop. */
  render(view: RaceView | null, dt: number): void {
    this.resize();
    this.time += dt;
    const track = this.track;
    if (!track || !this.environment) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    const snow = track.def.theme === 'glacier';
    let follow: RaceView['cars'][number] | null = null;

    if (view) {
      for (let slot = 0; slot < MAX_RACERS; slot++) {
        const entry = this.cars[slot];
        if (!entry) continue;
        const car = view.cars[slot]!;
        const root = entry.visual.root;
        if (!car.present) {
          root.visible = false;
          entry.hasRear = false;
          continue;
        }
        root.visible = true;
        root.position.set(car.x, 0, car.z);
        root.rotation.y = car.yaw;

        // Wheels and body motion are derived purely from the replicated state.
        const lateral = car.vx * Math.cos(car.yaw) - car.vz * Math.sin(car.yaw);
        entry.spin += (car.forwardSpeed / WHEEL_RADIUS) * dt;
        entry.visual.setWheels(-car.steer * maxSteerAngle(car.forwardSpeed, lateral), entry.spin);
        entry.visual.setBraking(car.brake > 0.1 || (car.flags & CarFlag.HANDBRAKE) !== 0);
        const accel = dt > 0 ? (car.forwardSpeed - entry.prevSpeed) / dt : 0;
        entry.prevSpeed = car.forwardSpeed;
        const motion = this.settings.reducedMotion ? 0.3 : 1;
        const targetRoll = THREE.MathUtils.clamp(-car.yawRate * car.forwardSpeed * 0.0035, -0.09, 0.09) * motion;
        const targetPitch = THREE.MathUtils.clamp(-accel * 0.0035, -0.045, 0.06) * motion;
        const blend = 1 - Math.exp(-dt * 9);
        entry.roll += (targetRoll - entry.roll) * blend;
        entry.pitch += (targetPitch - entry.pitch) * blend;
        entry.visual.body.rotation.z = entry.roll;
        entry.visual.body.rotation.x = entry.pitch;
        entry.visual.setGhost(car.stale || (car.flags & CarFlag.DISCONNECTED) !== 0 || (car.flags & CarFlag.FINISHED) !== 0);
        // Name tags keep a readable, bounded size on screen: they neither
        // shrink to nothing far away nor fill the view when a car is alongside.
        const tag = entry.visual.tag;
        const distance = this.camera.position.distanceTo(root.position);
        tag.visible = this.settings.nameTags && this.followSlot !== slot && distance > 7 && distance < 220;
        if (tag.visible) {
          const k = THREE.MathUtils.clamp(distance / 30, 0.4, 3.2);
          tag.scale.set(4.4 * k, 0.83 * k, 1);
          tag.position.y = 2.2 + 0.55 * k;
        }

        this.carEffects(entry, car, dt, snow);
      }
      follow = this.followSlot >= 0 ? (view.cars[this.followSlot] ?? null) : null;
      if (follow && !follow.present) follow = null;
    }

    if (follow) this.followCamera(follow, dt);
    else this.orbitCamera(track, dt);

    // Shadows follow the action.
    const sun = this.environment.sun;
    sun.target.position.copy(this.camLook);
    sun.position.copy(this.environment.sunDirection).multiplyScalar(140).add(this.camLook);
    sun.target.updateMatrixWorld();

    this.effects.update(dt);
    this.environment.update(dt, this.time, this.camera.position, this.settings.reducedMotion);
    this.renderer.render(this.scene, this.camera);
  }

  private carEffects(entry: CarEntry, car: RaceView['cars'][number], dt: number, snow: boolean): void {
    const sin = Math.sin(car.yaw);
    const cos = Math.cos(car.yaw);
    const sliding = car.slip > 0.15 && car.speed > 6;
    const spinning = (car.flags & CarFlag.WHEELSPIN) !== 0 && car.speed > 1;
    const offroad = car.offroad > 0.5 && car.speed > 5;
    for (let w = 0; w < 2; w++) {
      const side = w === 0 ? 0.86 : -0.86;
      // Left of the car is (cos, -sin); the rear axle sits behind the centre.
      const x = car.x - sin * VEHICLE.cgToRear + cos * side;
      const z = car.z - cos * VEHICLE.cgToRear - sin * side;
      if (sliding && entry.hasRear && !offroad) this.effects.skid(entry.rearX[w]!, entry.rearZ[w]!, x, z, car.slip);
      entry.rearX[w] = x;
      entry.rearZ[w] = z;
      entry.smokeBudget += dt * 60;
      if (entry.smokeBudget >= 1) {
        if (sliding || spinning) this.effects.smoke(x, z, car.vx, car.vz, sliding ? 0.25 + car.slip * 0.6 : 0.3, snow);
        if (offroad) this.effects.dust(x, z, car.vx, car.vz, snow);
      }
    }
    if (entry.smokeBudget >= 1) entry.smokeBudget = 0;
    entry.hasRear = true;
  }

  private followCamera(car: RaceView['cars'][number], dt: number): void {
    const reduced = this.settings.reducedMotion;
    const speed = car.speed;
    // Look along the direction of travel at speed, along the nose when slow,
    // so a drift shows the car sideways instead of swinging the camera.
    let targetYaw = car.yaw;
    if (speed > 6 && car.forwardSpeed > 0) {
      const travel = Math.atan2(car.vx, car.vz);
      const diff = Math.atan2(Math.sin(travel - car.yaw), Math.cos(travel - car.yaw));
      targetYaw = car.yaw + diff * 0.55;
    }
    if (this.camSnap) this.camYaw = targetYaw;
    const yawDiff = Math.atan2(Math.sin(targetYaw - this.camYaw), Math.cos(targetYaw - this.camYaw));
    this.camYaw += yawDiff * (1 - Math.exp(-dt * (reduced ? 9 : 5.5)));

    let distance = 7.4;
    let height = 2.9;
    let lookAhead = 4.5;
    let baseFov = 62;
    switch (this.cameraMode) {
      case 'far':
        distance = 12.5;
        height = 5.2;
        lookAhead = 6;
        break;
      case 'hood':
        distance = -1.0;
        height = 1.3;
        lookAhead = 30;
        baseFov = 72;
        break;
      case 'top':
        distance = 0.01;
        height = 46 + Math.min(26, speed * 0.4);
        lookAhead = 6 + speed * 0.25;
        baseFov = 50;
        break;
      default:
        break;
    }

    const sin = Math.sin(this.camYaw);
    const cos = Math.cos(this.camYaw);
    const desired = this.tmp;
    const look = this.tmp2;
    if (this.cameraMode === 'hood') {
      const s = Math.sin(car.yaw);
      const c = Math.cos(car.yaw);
      desired.set(car.x - s * distance, height, car.z - c * distance);
      look.set(car.x + s * lookAhead, 0.9, car.z + c * lookAhead);
      this.camPos.copy(desired);
      this.camLook.copy(look);
    } else {
      desired.set(car.x - sin * distance, height, car.z - cos * distance);
      look.set(car.x + sin * lookAhead, this.cameraMode === 'top' ? 0 : 1.0, car.z + cos * lookAhead);
      if (this.camSnap) {
        this.camPos.copy(desired);
        this.camLook.copy(look);
      } else {
        const k = 1 - Math.exp(-dt * (reduced ? 14 : 9));
        this.camPos.lerp(desired, k);
        this.camLook.lerp(look, 1 - Math.exp(-dt * 12));
      }
    }
    this.camSnap = false;

    this.camera.position.copy(this.camPos);
    if (this.shake > 0.001 && !reduced) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake * 0.5;
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.35;
      this.shake *= Math.exp(-dt * 7);
    } else {
      this.shake = 0;
    }
    if (this.cameraMode === 'top') this.camera.up.set(sin, 0, cos);
    else this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.camLook);

    // Speed widens the field of view, unless motion is reduced.
    const targetFov = baseFov + (reduced || this.cameraMode === 'top' ? 0 : Math.min(16, speed * 0.24));
    this.fov += (targetFov - this.fov) * (1 - Math.exp(-dt * 4));
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** A slow fly-around used behind the menus and before data arrives. */
  private orbitCamera(track: Track, dt: number): void {
    this.orbitAngle += dt * (this.settings.reducedMotion ? 4 : 14);
    const spot = { x: 0, z: 0, yaw: 0 };
    pointAt(track, this.orbitAngle, 0, spot);
    const ahead = { x: 0, z: 0, yaw: 0 };
    pointAt(track, this.orbitAngle + 40, 0, ahead);
    const side = track.wallDist + 16;
    this.tmp.set(spot.x + Math.cos(spot.yaw) * side, 15, spot.z - Math.sin(spot.yaw) * side);
    this.tmp2.set(ahead.x, 0.5, ahead.z);
    if (this.camSnap) {
      this.camPos.copy(this.tmp);
      this.camLook.copy(this.tmp2);
      this.camSnap = false;
    } else {
      const k = 1 - Math.exp(-dt * 1.4);
      this.camPos.lerp(this.tmp, k);
      this.camLook.lerp(this.tmp2, k);
    }
    this.camera.position.copy(this.camPos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.camLook);
    if (this.camera.fov !== 58) {
      this.camera.fov = 58;
      this.fov = 58;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Forces the camera to jump to its target on the next frame (race start, teleport). */
  snapCamera(): void {
    this.camSnap = true;
  }
}
