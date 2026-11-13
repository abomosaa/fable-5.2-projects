/**
 * Builds the 3D environment of a track from the same geometry the simulation
 * uses: road, verges, kerbs, barriers, start line, checkpoint markers and
 * themed scenery. What you see is exactly what the physics collides with.
 */
import * as THREE from 'three';
import { mergeGeometries as mergeBufferGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng } from '../../../shared/sim/rng';
import { makeQuery, pointAt, queryTrackBrute, type Track } from '../../../shared/sim/track';
import type { Quality } from '../storage/settings';
import {
  bannerTexture,
  barrierTexture,
  checkerTexture,
  chevronTexture,
  crowdTexture,
  dotTexture,
  groundTexture,
  kerbTexture,
  roadTexture,
  skyTexture,
  vergeTexture,
} from './textures';

export interface Environment {
  group: THREE.Group;
  sun: THREE.DirectionalLight;
  /** Direction from the scene towards the sun. */
  sunDirection: THREE.Vector3;
  fog: THREE.Fog;
  /** Scene used to bake reflections (sky only). */
  sky: THREE.Mesh;
  /** Highlights the gate the followed car must pass next (null hides it). */
  setNextGate(index: number | null): void;
  update(dt: number, time: number, camera: THREE.Vector3, reducedMotion: boolean): void;
  dispose(): void;
}

interface Theme {
  skyTop: string;
  skyMid: string;
  skyHorizon: string;
  fog: number;
  fogNear: number;
  fogFar: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  sun: number;
  sunIntensity: number;
  sunDirection: [number, number, number];
  wallHeight: number;
}

const THEMES: Record<'harbor' | 'glacier', Theme> = {
  harbor: {
    skyTop: '#2f6fcf',
    skyMid: '#8dbfee',
    skyHorizon: '#f3dcb6',
    fog: 0xe6d6b8,
    fogNear: 260,
    fogFar: 1500,
    hemiSky: 0xcfe2ff,
    hemiGround: 0x6b7a48,
    hemiIntensity: 1.25,
    sun: 0xfff1da,
    sunIntensity: 2.7,
    sunDirection: [0.45, 0.72, -0.35],
    wallHeight: 0.95,
  },
  glacier: {
    skyTop: '#4a7ab2',
    skyMid: '#a8c5e2',
    skyHorizon: '#e9f1f8',
    fog: 0xdde8f3,
    fogNear: 140,
    fogFar: 950,
    hemiSky: 0xe3eeff,
    hemiGround: 0xbfd0e4,
    hemiIntensity: 1.45,
    sun: 0xffffff,
    sunIntensity: 2.1,
    sunDirection: [-0.4, 0.62, 0.45],
    wallHeight: 1.3,
  },
};

/** Merges geometries into one; mixes of indexed and non-indexed input are fine. */
function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeBufferGeometries(parts.map((part) => (part.index ? part.toNonIndexed() : part)));
  if (!merged) throw new Error('Could not merge scenery geometry');
  return merged;
}

/** A flat strip following the track between two lateral offsets. */
function ribbon(track: Track, latLeft: number, latRight: number, y: number, vLength: number, include?: (i: number) => boolean): THREE.BufferGeometry {
  const n = track.n;
  const positions = new Float32Array((n + 1) * 2 * 3);
  const normals = new Float32Array((n + 1) * 2 * 3);
  const uvs = new Float32Array((n + 1) * 2 * 2);
  for (let i = 0; i <= n; i++) {
    const k = i % n;
    const lx = track.tz[k]!;
    const lz = -track.tx[k]!;
    const s = i === n ? track.length : track.s[k]!;
    const o = i * 6;
    positions[o] = track.px[k]! + lx * latLeft;
    positions[o + 1] = y;
    positions[o + 2] = track.pz[k]! + lz * latLeft;
    positions[o + 3] = track.px[k]! + lx * latRight;
    positions[o + 4] = y;
    positions[o + 5] = track.pz[k]! + lz * latRight;
    normals[o + 1] = 1;
    normals[o + 4] = 1;
    uvs[i * 4] = 0;
    uvs[i * 4 + 1] = s / vLength;
    uvs[i * 4 + 2] = 1;
    uvs[i * 4 + 3] = s / vLength;
  }
  const index: number[] = [];
  for (let i = 0; i < n; i++) {
    if (include && !include(i)) continue;
    const a = i * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  return geometry;
}

/** Sweeps a cross-section (offset from the barrier line, height) along one side of the track. */
function extrude(track: Track, side: 1 | -1, profile: ReadonlyArray<readonly [number, number]>, uLength: number): THREE.BufferGeometry {
  const n = track.n;
  const m = profile.length;
  const positions = new Float32Array((n + 1) * m * 3);
  const uvs = new Float32Array((n + 1) * m * 2);
  const across: number[] = [0];
  for (let k = 1; k < m; k++) {
    across.push(across[k - 1]! + Math.hypot(profile[k]![0] - profile[k - 1]![0], profile[k]![1] - profile[k - 1]![1]));
  }
  const total = across[m - 1]! || 1;
  for (let i = 0; i <= n; i++) {
    const j = i % n;
    const lx = track.tz[j]!;
    const lz = -track.tx[j]!;
    const s = i === n ? track.length : track.s[j]!;
    for (let k = 0; k < m; k++) {
      const lat = side * (track.wallDist + profile[k]![0]);
      const o = (i * m + k) * 3;
      positions[o] = track.px[j]! + lx * lat;
      positions[o + 1] = profile[k]![1];
      positions[o + 2] = track.pz[j]! + lz * lat;
      uvs[(i * m + k) * 2] = s / uLength;
      uvs[(i * m + k) * 2 + 1] = 1 - across[k]! / total;
    }
  }
  const index: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < m - 1; k++) {
      const a = i * m + k;
      const b = a + m;
      if (side === 1) index.push(a, a + 1, b, a + 1, b + 1, b);
      else index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

function tinted(geometry: THREE.BufferGeometry, colour: number): THREE.BufferGeometry {
  const c = new THREE.Color(colour);
  const count = geometry.getAttribute('position').count;
  const data = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    data[i * 3] = c.r;
    data[i * 3 + 1] = c.g;
    data[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(data, 3));
  return geometry;
}

interface Placement {
  x: number;
  z: number;
  scale: number;
  rotation: number;
}

/** Scatters points around the track, never on the road or inside the barriers. */
function scatter(track: Track, rng: Rng, count: number, minClear: number, maxDistance: number, accept?: (x: number, z: number) => boolean): Placement[] {
  const out: Placement[] = [];
  const q = makeQuery();
  const b = track.bounds;
  const pad = maxDistance;
  for (let attempt = 0; attempt < count * 12 && out.length < count; attempt++) {
    const x = rng.range(b.minX - pad, b.maxX + pad);
    const z = rng.range(b.minZ - pad, b.maxZ + pad);
    const d = queryTrackBrute(track, x, z, q).dist;
    if (d < track.wallDist + minClear || d > track.wallDist + maxDistance) continue;
    if (accept && !accept(x, z)) continue;
    out.push({ x, z, scale: rng.range(0.75, 1.35), rotation: rng.range(0, Math.PI * 2) });
  }
  return out;
}

function instanced(geometry: THREE.BufferGeometry, material: THREE.Material, placements: Placement[], y = 0, shadows = true): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  placements.forEach((p, i) => {
    position.set(p.x, y, p.z);
    rotation.setFromAxisAngle(up, p.rotation);
    scale.setScalar(p.scale);
    matrix.compose(position, rotation, scale);
    mesh.setMatrixAt(i, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = shadows;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  return mesh;
}

export function buildEnvironment(track: Track, quality: Quality): Environment {
  const themeName = track.def.theme;
  const theme = THEMES[themeName];
  const group = new THREE.Group();
  const rng = new Rng(themeName === 'harbor' ? 9001 : 9002);
  const density = quality === 'low' ? 0.45 : quality === 'high' ? 1.4 : 1;
  const b = track.bounds;
  const centreX = (b.minX + b.maxX) / 2;
  const centreZ = (b.minZ + b.maxZ) / 2;
  const animated: Array<(dt: number, time: number, camera: THREE.Vector3, reducedMotion: boolean) => void> = [];

  // ---- Sky, light, fog.
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1800, 24, 16),
    new THREE.MeshBasicMaterial({ map: skyTexture(theme.skyTop, theme.skyMid, theme.skyHorizon), side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  sky.position.set(centreX, 0, centreZ);
  sky.renderOrder = -10;
  group.add(sky);
  const fog = new THREE.Fog(theme.fog, theme.fogNear, theme.fogFar);
  group.add(new THREE.HemisphereLight(theme.hemiSky, theme.hemiGround, theme.hemiIntensity));
  const sunDirection = new THREE.Vector3(...theme.sunDirection).normalize();
  const sun = new THREE.DirectionalLight(theme.sun, theme.sunIntensity);
  sun.position.copy(sunDirection).multiplyScalar(120);
  group.add(sun, sun.target);
  // A sun disc, low in the sky.
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(70, 24),
    new THREE.MeshBasicMaterial({ color: themeName === 'harbor' ? 0xfff3c4 : 0xffffff, fog: false, transparent: true, opacity: 0.9, depthWrite: false }),
  );
  disc.position.copy(sunDirection).multiplyScalar(1700).add(sky.position);
  disc.lookAt(sky.position);
  disc.renderOrder = -9;
  group.add(disc);

  // ---- Ground.
  const groundMap = groundTexture(themeName);
  const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) + 3200;
  groundMap.repeat.set(span / 28, span / 28);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(span, span),
    new THREE.MeshStandardMaterial({ map: groundMap, roughness: themeName === 'harbor' ? 1 : 0.85, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(centreX, -0.02, centreZ);
  ground.receiveShadow = true;
  group.add(ground);

  // ---- Verge, road, kerbs. Stacked a few centimetres apart to avoid z-fighting.
  const vergeMap = vergeTexture(themeName);
  const verge = new THREE.Mesh(
    ribbon(track, track.wallDist, -track.wallDist, 0.0, 10),
    new THREE.MeshStandardMaterial({ map: vergeMap, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
  );
  verge.receiveShadow = true;
  group.add(verge);

  const road = new THREE.Mesh(
    ribbon(track, track.halfWidth, -track.halfWidth, 0.02, 14),
    new THREE.MeshStandardMaterial({
      map: roadTexture(themeName),
      roughness: themeName === 'harbor' ? 0.82 : 0.22,
      metalness: themeName === 'harbor' ? 0.02 : 0.1,
      envMapIntensity: themeName === 'harbor' ? 0.35 : 1.1,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  road.receiveShadow = true;
  group.add(road);

  if (themeName === 'harbor') {
    const corner = (i: number): boolean => Math.abs(track.curv[i]!) > 0.0075;
    const kerbMaterial = new THREE.MeshStandardMaterial({
      map: kerbTexture(),
      roughness: 0.7,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    for (const side of [1, -1] as const) {
      const inner = side * (track.halfWidth - 0.15);
      const outer = side * (track.halfWidth + 0.95);
      const kerb = new THREE.Mesh(ribbon(track, Math.max(inner, outer), Math.min(inner, outer), 0.04, 4, corner), kerbMaterial);
      kerb.receiveShadow = true;
      group.add(kerb);
    }
  }

  // ---- Barriers: exactly on the line the physics collides with.
  const wallMap = barrierTexture(themeName);
  const wallMaterial = new THREE.MeshStandardMaterial({ map: wallMap, roughness: themeName === 'harbor' ? 0.8 : 0.9, side: THREE.DoubleSide });
  const h = theme.wallHeight;
  const profile: Array<[number, number]> =
    themeName === 'harbor'
      ? [
          [0, 0],
          [0, h],
          [0.5, h],
          [0.5, 0],
        ]
      : [
          [0, 0],
          [0.5, h * 0.8],
          [1.4, h],
          [2.6, h * 0.85],
          [4.2, 0],
        ];
  for (const side of [1, -1] as const) {
    const wall = new THREE.Mesh(extrude(track, side, profile, themeName === 'harbor' ? 8 : 6), wallMaterial);
    wall.castShadow = quality !== 'low';
    wall.receiveShadow = true;
    group.add(wall);
  }

  // ---- Start/finish line and gantry.
  const start = track.gates[0]!;
  const startYaw = Math.atan2(start.tx, start.tz);
  const line = new THREE.Mesh(
    new THREE.PlaneGeometry(track.halfWidth * 2, 2.4),
    new THREE.MeshStandardMaterial({ map: checkerTexture(), roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
  );
  line.rotation.set(-Math.PI / 2, 0, -startYaw);
  line.position.set(start.cx, 0.05, start.cz);
  line.receiveShadow = true;
  group.add(line);

  const gantry = new THREE.Group();
  gantry.position.set(start.cx, 0, start.cz);
  gantry.rotation.y = startYaw;
  const steel = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.5, metalness: 0.6 });
  const reach = track.wallDist + 0.9;
  for (const x of [reach, -reach]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, 7.4, 0.6), steel);
    post.position.set(x, 3.7, 0);
    post.castShadow = true;
    gantry.add(post);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(reach * 2 + 0.6, 0.5, 0.7), steel);
  beam.position.set(0, 7.2, 0);
  beam.castShadow = true;
  gantry.add(beam);
  const bannerMaterial = new THREE.MeshBasicMaterial({
    map: bannerTexture(track.def.name, themeName === 'harbor' ? '#c2410c' : '#1d4ed8', '#ffffff'),
    side: THREE.DoubleSide,
  });
  const banner = new THREE.Mesh(new THREE.PlaneGeometry(reach * 2 - 1, 1.5), bannerMaterial);
  banner.position.set(0, 6.1, -0.4);
  banner.rotation.y = Math.PI;
  gantry.add(banner);
  group.add(gantry);

  // ---- Grid boxes.
  const gridMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const gridGeometry = new THREE.PlaneGeometry(2.4, 0.22);
  for (const slot of track.grid) {
    const mark = new THREE.Mesh(gridGeometry, gridMaterial);
    mark.rotation.set(-Math.PI / 2, 0, -slot.yaw);
    mark.position.set(slot.x + Math.sin(slot.yaw) * 2.5, 0.05, slot.z + Math.cos(slot.yaw) * 2.5);
    group.add(mark);
  }

  // ---- Checkpoint posts at every gate.
  const posts: Placement[] = [];
  for (const gate of track.gates) {
    if (gate.index === 0) continue;
    const yaw = Math.atan2(gate.tx, gate.tz);
    for (const side of [1, -1]) {
      // On the barrier itself, never inside the drivable corridor.
      const lat = side * (track.wallDist + (themeName === 'harbor' ? 0.25 : 1.2));
      posts.push({ x: gate.cx + gate.tz * lat, z: gate.cz - gate.tx * lat, scale: 1, rotation: yaw });
    }
  }
  const postGeometry = mergeGeometries([
    tinted(new THREE.BoxGeometry(0.16, 3.2, 0.16).translate(0, 1.6, 0), 0x30343f),
    tinted(new THREE.BoxGeometry(0.8, 0.8, 0.08).translate(0, 3.1, 0), themeName === 'harbor' ? 0xffc21a : 0xff7a1a),
  ]);
  group.add(instanced(postGeometry, new THREE.MeshLambertMaterial({ vertexColors: true }), posts, 0, quality !== 'low'));

  // ---- The "next checkpoint" marker (one object, moved from gate to gate).
  const marker = new THREE.Group();
  const chevrons = chevronTexture();
  chevrons.repeat.set(Math.round(track.halfWidth * 2 / 2.4), 1);
  const curtain = new THREE.Mesh(
    new THREE.PlaneGeometry(track.halfWidth * 2, 2.4),
    new THREE.MeshBasicMaterial({
      map: chevrons,
      color: 0x58e6ff,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    }),
  );
  curtain.position.y = 1.5;
  marker.add(curtain);
  const strip = new THREE.Mesh(
    new THREE.PlaneGeometry(track.halfWidth * 2, 0.7),
    new THREE.MeshBasicMaterial({ color: 0x58e6ff, transparent: true, opacity: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 }),
  );
  strip.rotation.x = -Math.PI / 2;
  strip.position.y = 0.06;
  marker.add(strip);
  const pillarMaterial = new THREE.MeshBasicMaterial({ color: 0x9ff3ff, transparent: true, opacity: 0.9, fog: false });
  for (const x of [track.halfWidth + 0.1, -track.halfWidth - 0.1]) {
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 3.4, 8), pillarMaterial);
    pillar.position.set(x, 1.7, 0);
    marker.add(pillar);
  }
  marker.visible = false;
  group.add(marker);
  animated.push((_dt, time, _camera, reducedMotion) => {
    if (!marker.visible) return;
    if (!reducedMotion) chevrons.offset.y = -(time * 0.9) % 1;
    (curtain.material as THREE.MeshBasicMaterial).opacity = reducedMotion ? 0.45 : 0.38 + Math.sin(time * 5) * 0.12;
  });

  // ---- Scenery.
  const startSide = (() => {
    const q = makeQuery();
    const probe = { x: 0, z: 0, yaw: 0 };
    let best: 1 | -1 = 1;
    let bestClear = -1;
    for (const side of [1, -1] as const) {
      pointAt(track, track.length - 30, side * (track.wallDist + 22), probe);
      const clear = queryTrackBrute(track, probe.x, probe.z, q).dist;
      if (clear > bestClear) {
        bestClear = clear;
        best = side;
      }
    }
    return best;
  })();

  // Grandstand beside the start straight.
  {
    const stand = new THREE.Group();
    const spot = { x: 0, z: 0, yaw: 0 };
    pointAt(track, track.length - 32, startSide * (track.wallDist + 11), spot);
    stand.position.set(spot.x, 0, spot.z);
    stand.rotation.y = spot.yaw + (startSide === 1 ? -Math.PI / 2 : Math.PI / 2);
    const crowd = crowdTexture();
    crowd.repeat.set(4, 1);
    const crowdMaterial = new THREE.MeshLambertMaterial({ map: crowd });
    const concrete = new THREE.MeshLambertMaterial({ color: themeName === 'harbor' ? 0x8b909b : 0x7c8796 });
    for (let row = 0; row < 5; row++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(46, 1.1, 2.2), row % 2 === 0 ? crowdMaterial : concrete);
      step.position.set(0, 0.55 + row * 1.1, -row * 2.2);
      step.castShadow = quality !== 'low';
      stand.add(step);
      const people = new THREE.Mesh(new THREE.PlaneGeometry(46, 1.2), crowdMaterial);
      people.position.set(0, 1.7 + row * 1.1, -row * 2.2 - 0.9);
      stand.add(people);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(48, 0.4, 13), new THREE.MeshLambertMaterial({ color: themeName === 'harbor' ? 0xc2410c : 0x1d4ed8 }));
    roof.position.set(0, 9.4, -5.5);
    roof.rotation.x = 0.12;
    roof.castShadow = quality !== 'low';
    stand.add(roof);
    for (const x of [-23, 0, 23]) {
      const pole = new THREE.Mesh(new THREE.BoxGeometry(0.4, 9.5, 0.4), steel);
      pole.position.set(x, 4.7, -11);
      stand.add(pole);
    }
    group.add(stand);
  }

  if (themeName === 'harbor') {
    let rawMinZ = Infinity;
    for (let i = 0; i < track.n; i++) rawMinZ = Math.min(rawMinZ, track.pz[i]!);
    const quayZ = rawMinZ - track.wallDist - 26;

    // Water beyond the quay.
    const waterMaterial = new THREE.MeshStandardMaterial({ color: 0x1f6f9c, roughness: 0.12, metalness: 0.2, envMapIntensity: 1.2 });
    const water = new THREE.Mesh(new THREE.PlaneGeometry(span, 1700), waterMaterial);
    water.rotation.x = -Math.PI / 2;
    water.position.set(centreX, -0.6, quayZ - 850);
    group.add(water);
    const quay = new THREE.Mesh(new THREE.BoxGeometry(span, 1.6, 2), new THREE.MeshLambertMaterial({ color: 0x70757f }));
    quay.position.set(centreX, -0.75, quayZ);
    group.add(quay);
    // Hide the lawn under the water line.
    const onLand = (_x: number, z: number): boolean => z > quayZ + 6;

    // Trees.
    const tree = mergeGeometries([
      tinted(new THREE.CylinderGeometry(0.22, 0.32, 2.2, 6).translate(0, 1.1, 0), 0x6b4a2f),
      tinted(new THREE.IcosahedronGeometry(2.1, 0).translate(0, 3.6, 0), 0x3f8a3a),
      tinted(new THREE.IcosahedronGeometry(1.5, 0).translate(0.5, 5.1, 0.2), 0x4c9a45),
    ]);
    const trees = instanced(tree, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), scatter(track, rng, Math.round(420 * density), 5, 150, onLand), 0, quality !== 'low');
    const tint = new THREE.Color();
    for (let i = 0; i < trees.count; i++) {
      tint.setHSL(0.27 + rng.range(-0.04, 0.05), 0.5, rng.range(0.42, 0.6));
      trees.setColorAt(i, tint);
    }
    group.add(trees);

    // Shipping containers stacked near the quay and around the infield.
    const colours = [0xc2410c, 0x1d4ed8, 0x15803d, 0xca8a04, 0x7e22ce, 0xb91c1c, 0x0e7490, 0xd4d4d8];
    const containerGeometry = new THREE.BoxGeometry(12, 2.6, 2.5);
    const containerPlacements = scatter(track, rng, Math.round(26 * density), 7, 70, (_x, z) => z > quayZ + 8 && (z < quayZ + 60 || rng.next() < 0.25));
    const boxes: Placement[] = [];
    const boxHeights: number[] = [];
    for (const p of containerPlacements) {
      const yaw = Math.round(p.rotation / (Math.PI / 2)) * (Math.PI / 2);
      const stack = rng.int(1, 3);
      for (let level = 0; level < stack; level++) {
        boxes.push({ x: p.x, z: p.z, scale: 1, rotation: yaw + rng.range(-0.04, 0.04) });
        boxHeights.push(1.3 + level * 2.6);
      }
    }
    const containers = new THREE.InstancedMesh(containerGeometry, new THREE.MeshLambertMaterial({ color: 0xffffff }), boxes.length);
    const matrix = new THREE.Matrix4();
    const up = new THREE.Vector3(0, 1, 0);
    boxes.forEach((p, i) => {
      matrix.compose(new THREE.Vector3(p.x, boxHeights[i]!, p.z), new THREE.Quaternion().setFromAxisAngle(up, p.rotation), new THREE.Vector3(1, 1, 1));
      containers.setMatrixAt(i, matrix);
      containers.setColorAt(i, tint.setHex(rng.pick(colours)));
    });
    containers.castShadow = quality !== 'low';
    containers.frustumCulled = false;
    group.add(containers);

    // Gantry cranes on the quay.
    const craneMaterial = new THREE.MeshLambertMaterial({ color: 0xd97706 });
    for (let i = 0; i < 4; i++) {
      const crane = new THREE.Group();
      const x = b.minX + ((i + 0.5) / 4) * (b.maxX - b.minX) + rng.range(-25, 25);
      crane.position.set(x, 0, quayZ + 5);
      for (const [lx, lz] of [
        [-7, -4],
        [7, -4],
        [-7, 4],
        [7, 4],
      ] as const) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(1, 34, 1), craneMaterial);
        leg.position.set(lx, 17, lz);
        crane.add(leg);
      }
      const deck = new THREE.Mesh(new THREE.BoxGeometry(16, 2, 10), craneMaterial);
      deck.position.y = 34;
      crane.add(deck);
      const boom = new THREE.Mesh(new THREE.BoxGeometry(3, 2, 60), craneMaterial);
      boom.position.set(0, 37, -18);
      crane.add(boom);
      crane.traverse((o) => {
        if (o instanceof THREE.Mesh) o.castShadow = quality === 'high';
      });
      group.add(crane);
    }

    // A slow swell so the water is not a flat sheet.
    animated.push((_dt, time, _camera, reducedMotion) => {
      if (!reducedMotion) water.position.y = -0.6 + Math.sin(time * 0.6) * 0.06;
    });
  } else {
    // Snow-capped pines.
    const pine = mergeGeometries([
      tinted(new THREE.CylinderGeometry(0.18, 0.28, 1.6, 6).translate(0, 0.8, 0), 0x5a4030),
      tinted(new THREE.ConeGeometry(2.0, 3.4, 7).translate(0, 3.0, 0), 0x2f5d46),
      tinted(new THREE.ConeGeometry(1.5, 2.8, 7).translate(0, 4.9, 0), 0x3a6f55),
      tinted(new THREE.ConeGeometry(0.95, 2.0, 7).translate(0, 6.5, 0), 0xf2f7fb),
    ]);
    group.add(
      instanced(pine, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), scatter(track, rng, Math.round(520 * density), 5, 170), 0, quality !== 'low'),
    );

    // Boulders.
    const rock = tinted(new THREE.IcosahedronGeometry(1.4, 0).scale(1, 0.7, 1.2), 0x8a94a3);
    const rocks = scatter(track, rng, Math.round(140 * density), 4.5, 90).map((p) => ({ ...p, scale: p.scale * rng.range(0.5, 2.2) }));
    group.add(instanced(rock, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), rocks, 0.3, quality !== 'low'));

    // Reflector poles along both road edges make the white road readable.
    const poleGeometry = mergeGeometries([
      tinted(new THREE.CylinderGeometry(0.06, 0.06, 1.5, 6).translate(0, 0.75, 0), 0xff7a1a),
      tinted(new THREE.BoxGeometry(0.16, 0.22, 0.16).translate(0, 1.4, 0), 0x202632),
    ]);
    const poles: Placement[] = [];
    const spot = { x: 0, z: 0, yaw: 0 };
    for (let s = 0; s < track.length; s += 14) {
      for (const side of [1, -1]) {
        // Planted in the snow bank, outside the line the physics collides with.
        pointAt(track, s + (side === 1 ? 0 : 7), side * (track.wallDist + 0.75), spot);
        poles.push({ x: spot.x, z: spot.z, scale: 1, rotation: 0 });
      }
    }
    group.add(instanced(poleGeometry, new THREE.MeshLambertMaterial({ vertexColors: true }), poles, theme.wallHeight * 0.75, false));

    // A ring of mountains on the horizon.
    const mountainGeometry = mergeGeometries([
      tinted(new THREE.ConeGeometry(1, 1, 7, 1, true), 0x6f8097),
      tinted(new THREE.ConeGeometry(0.42, 0.42, 7).translate(0, 0.292, 0), 0xf5f9fd),
    ]);
    const mountainMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const peaks = Math.round(26 * (quality === 'low' ? 0.7 : 1));
    const mountains = new THREE.InstancedMesh(mountainGeometry, mountainMaterial, peaks);
    const matrix = new THREE.Matrix4();
    const radius = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 0.5 + 420;
    for (let i = 0; i < peaks; i++) {
      const angle = (i / peaks) * Math.PI * 2 + rng.range(-0.08, 0.08);
      const distance = radius + rng.range(0, 260);
      const height = rng.range(150, 330);
      const width = rng.range(150, 260);
      matrix.compose(
        new THREE.Vector3(centreX + Math.cos(angle) * distance, height / 2 - 4, centreZ + Math.sin(angle) * distance),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, 6)),
        new THREE.Vector3(width, height, width),
      );
      mountains.setMatrixAt(i, matrix);
    }
    mountains.frustumCulled = false;
    group.add(mountains);

    // A frozen lake.
    const lakeSpot = scatter(track, rng, 1, 34, 120)[0];
    if (lakeSpot) {
      const lake = new THREE.Mesh(
        new THREE.CircleGeometry(30, 28),
        new THREE.MeshStandardMaterial({ color: 0x9cc7e6, roughness: 0.08, metalness: 0.25, envMapIntensity: 1.3 }),
      );
      lake.rotation.x = -Math.PI / 2;
      lake.scale.set(1.5, 1, 1);
      lake.position.set(lakeSpot.x, 0.02, lakeSpot.z);
      group.add(lake);
    }

    // Falling snow in a box that follows the camera.
    const flakes = quality === 'low' ? 500 : quality === 'high' ? 2200 : 1300;
    const box = 70;
    const positions = new Float32Array(flakes * 3);
    for (let i = 0; i < flakes; i++) {
      positions[i * 3] = rng.range(-box, box);
      positions[i * 3 + 1] = rng.range(0, 34);
      positions[i * 3 + 2] = rng.range(-box, box);
    }
    const snowGeometry = new THREE.BufferGeometry();
    snowGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const snow = new THREE.Points(
      snowGeometry,
      new THREE.PointsMaterial({ color: 0xffffff, size: 0.3, map: dotTexture(), transparent: true, opacity: 0.9, depthWrite: false, sizeAttenuation: true }),
    );
    snow.frustumCulled = false;
    group.add(snow);
    animated.push((dt, _time, camera, reducedMotion) => {
      const fall = (reducedMotion ? 2 : 6) * dt;
      const drift = (reducedMotion ? 0.3 : 1.6) * dt;
      const data = snowGeometry.getAttribute('position') as THREE.BufferAttribute;
      const array = data.array as Float32Array;
      for (let i = 0; i < flakes; i++) {
        let y = array[i * 3 + 1]! - fall;
        if (y < 0) y += 34;
        array[i * 3 + 1] = y;
        array[i * 3] = array[i * 3]! + drift > box ? array[i * 3]! + drift - box * 2 : array[i * 3]! + drift;
      }
      data.needsUpdate = true;
      snow.position.set(camera.x, 0, camera.z);
    });
  }

  return {
    group,
    sun,
    sunDirection,
    fog,
    sky,
    setNextGate(index) {
      const gate = index === null ? undefined : track.gates[index];
      if (!gate) {
        marker.visible = false;
        return;
      }
      marker.visible = true;
      marker.position.set(gate.cx, 0, gate.cz);
      marker.rotation.y = Math.atan2(gate.tx, gate.tz);
    },
    update(dt, time, camera, reducedMotion) {
      for (const fn of animated) fn(dt, time, camera, reducedMotion);
    },
    dispose() {
      const textures = new Set<THREE.Texture>();
      group.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
        for (const material of materials) {
          const map = (material as THREE.MeshStandardMaterial).map;
          if (map) textures.add(map);
          material.dispose();
        }
      });
      for (const texture of textures) texture.dispose();
    },
  };
}
