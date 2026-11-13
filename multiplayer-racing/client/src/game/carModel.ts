/**
 * Procedural low-poly race car. Local +Z is forward, matching the simulation
 * (heading = rotation about Y).
 */
import * as THREE from 'three';
import { VEHICLE } from '../../../shared/sim/vehicle';
import { nameTagTexture, numberTexture } from './textures';

const WHEEL_RADIUS = 0.36;
const WHEEL_X = 0.86;

export interface CarVisual {
  root: THREE.Group;
  /** Rolls and pitches with acceleration; child of root. */
  body: THREE.Group;
  /** Applies steering to the front wheels and spin to all four. */
  setWheels(steerAngle: number, spin: number): void;
  setBraking(on: boolean): void;
  /** Ghosted look for disconnected or stale cars. */
  setGhost(ghost: boolean): void;
  tag: THREE.Sprite;
  dispose(): void;
}

function bodyShape(): THREE.Shape {
  // Side profile: x runs along the car (+ = front), y is height.
  const shape = new THREE.Shape();
  shape.moveTo(-2.1, 0.3);
  shape.lineTo(-2.14, 0.72);
  shape.lineTo(-1.5, 0.82);
  shape.lineTo(-0.2, 0.84);
  shape.lineTo(0.9, 0.76);
  shape.lineTo(1.75, 0.6);
  shape.lineTo(2.16, 0.46);
  shape.lineTo(2.14, 0.26);
  shape.lineTo(-2.1, 0.24);
  shape.closePath();
  return shape;
}

function cabinShape(): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(-1.35, 0.82);
  shape.lineTo(-0.95, 1.24);
  shape.lineTo(0.05, 1.27);
  shape.lineTo(0.85, 0.8);
  shape.closePath();
  return shape;
}

/** Extrudes a side profile across the car's width and orients it to +Z forward. */
function extrudeProfile(shape: THREE.Shape, width: number, bevel: number): THREE.BufferGeometry {
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: width - bevel * 2,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 4,
  });
  geometry.translate(0, 0, -(width - bevel * 2) / 2);
  // Profile X (length) -> world Z, extrusion depth -> world X.
  geometry.rotateY(-Math.PI / 2);
  return geometry;
}

export function createCar(colour: number, number: number, name: string, isBot: boolean, shadows: boolean): CarVisual {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  const paint = track(new THREE.MeshStandardMaterial({ color: colour, roughness: 0.32, metalness: 0.45, envMapIntensity: 1.0 }));
  const dark = track(new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.6, metalness: 0.2 }));
  const glass = track(new THREE.MeshStandardMaterial({ color: 0x0c1420, roughness: 0.08, metalness: 0.7, envMapIntensity: 1.4 }));
  const rubber = track(new THREE.MeshStandardMaterial({ color: 0x0e0f12, roughness: 0.9 }));
  const rim = track(new THREE.MeshStandardMaterial({ color: 0xc9ced8, roughness: 0.35, metalness: 0.8 }));
  const headlight = track(new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: 1.6 }));
  const taillight = track(new THREE.MeshStandardMaterial({ color: 0x5a0a0a, emissive: 0xff1a1a, emissiveIntensity: 0.5 }));

  const shell = new THREE.Mesh(track(extrudeProfile(bodyShape(), VEHICLE.bodyWidth - 0.06, 0.07)), paint);
  shell.castShadow = shadows;
  body.add(shell);

  const cabin = new THREE.Mesh(track(extrudeProfile(cabinShape(), VEHICLE.bodyWidth - 0.42, 0.05)), glass);
  cabin.castShadow = shadows;
  body.add(cabin);

  const roof = new THREE.Mesh(track(new THREE.BoxGeometry(VEHICLE.bodyWidth - 0.56, 0.05, 0.92)), paint);
  roof.position.set(0, 1.275, -0.45);
  body.add(roof);

  const decal = new THREE.Mesh(
    track(new THREE.PlaneGeometry(0.7, 0.7)),
    track(new THREE.MeshBasicMaterial({ map: track(numberTexture(number)), transparent: true })),
  );
  decal.rotation.x = -Math.PI / 2;
  decal.rotation.z = Math.PI;
  decal.position.set(0, 1.305, -0.45);
  body.add(decal);

  // Splitter, skirts and rear wing.
  const splitter = new THREE.Mesh(track(new THREE.BoxGeometry(VEHICLE.bodyWidth, 0.06, 0.5)), dark);
  splitter.position.set(0, 0.24, 2.0);
  body.add(splitter);
  const wing = new THREE.Mesh(track(new THREE.BoxGeometry(VEHICLE.bodyWidth - 0.1, 0.05, 0.42)), dark);
  wing.position.set(0, 1.12, -1.95);
  wing.castShadow = shadows;
  body.add(wing);
  const strutGeometry = track(new THREE.BoxGeometry(0.06, 0.34, 0.22));
  for (const x of [-0.55, 0.55]) {
    const strut = new THREE.Mesh(strutGeometry, dark);
    strut.position.set(x, 0.95, -1.9);
    body.add(strut);
  }
  const endGeometry = track(new THREE.BoxGeometry(0.05, 0.26, 0.5));
  for (const x of [-0.9, 0.9]) {
    const end = new THREE.Mesh(endGeometry, paint);
    end.position.set(x, 1.1, -1.95);
    body.add(end);
  }

  const lightGeometry = track(new THREE.BoxGeometry(0.42, 0.11, 0.06));
  for (const x of [-0.62, 0.62]) {
    const front = new THREE.Mesh(lightGeometry, headlight);
    front.position.set(x, 0.52, 2.13);
    front.rotation.x = -0.3;
    body.add(front);
    const rear = new THREE.Mesh(lightGeometry, taillight);
    rear.position.set(x, 0.66, -2.15);
    body.add(rear);
  }

  // Wheels: a pivot (steering) holding a spinner (rolling).
  const tyreGeometry = track(new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.3, 14).rotateZ(Math.PI / 2));
  const rimGeometry = track(new THREE.CylinderGeometry(WHEEL_RADIUS * 0.6, WHEEL_RADIUS * 0.6, 0.31, 5).rotateZ(Math.PI / 2));
  const pivots: THREE.Group[] = [];
  const spinners: THREE.Group[] = [];
  const positions: Array<[number, number]> = [
    [WHEEL_X, VEHICLE.cgToFront],
    [-WHEEL_X, VEHICLE.cgToFront],
    [WHEEL_X, -VEHICLE.cgToRear],
    [-WHEEL_X, -VEHICLE.cgToRear],
  ];
  for (const [x, z] of positions) {
    const pivot = new THREE.Group();
    pivot.position.set(x, WHEEL_RADIUS, z);
    const spinner = new THREE.Group();
    const tyre = new THREE.Mesh(tyreGeometry, rubber);
    tyre.castShadow = shadows;
    spinner.add(tyre, new THREE.Mesh(rimGeometry, rim));
    pivot.add(spinner);
    root.add(pivot);
    pivots.push(pivot);
    spinners.push(spinner);
  }

  // Soft contact shadow that works even with shadow maps off.
  const blob = new THREE.Mesh(
    track(new THREE.PlaneGeometry(2.5, 5.0)),
    track(new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 })),
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.07;
  root.add(blob);

  const tagMaterial = track(
    new THREE.SpriteMaterial({ map: track(nameTagTexture(name, number, colour, isBot)), transparent: true, depthWrite: false, depthTest: false, fog: false }),
  );
  const tag = new THREE.Sprite(tagMaterial);
  tag.scale.set(4.4, 0.83, 1);
  tag.position.y = 2.75;
  tag.renderOrder = 20;
  root.add(tag);

  let ghosted = false;
  const fadeable = [paint, dark, glass, rubber, rim];

  return {
    root,
    body,
    tag,
    setWheels(steerAngle, spin) {
      pivots[0]!.rotation.y = steerAngle;
      pivots[1]!.rotation.y = steerAngle;
      for (const spinner of spinners) spinner.rotation.x = spin;
    },
    setBraking(on) {
      taillight.emissiveIntensity = on ? 3.2 : 0.5;
    },
    setGhost(ghost) {
      if (ghost === ghosted) return;
      ghosted = ghost;
      for (const material of fadeable) {
        material.transparent = ghost;
        material.opacity = ghost ? 0.4 : 1;
        material.depthWrite = !ghost;
        material.needsUpdate = true;
      }
    },
    dispose() {
      for (const item of disposables) item.dispose();
    },
  };
}
