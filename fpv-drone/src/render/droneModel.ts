/**
 * Visual model of the quad, generated from the same airframe parameters the
 * physics uses (arm geometry, prop radius, battery size...).
 */
import * as THREE from 'three';
import { DroneParams, DerivedParams } from '../sim/params';
import { Drone } from '../sim/drone';

export class DroneModel {
  /** Root: origin at the vehicle's centre of gravity. */
  readonly root = new THREE.Group();
  /** FPV camera mount (position of the lens, before uptilt), in the root frame. */
  readonly cameraMount = new THREE.Vector3();
  private readonly props: THREE.Group[] = [];
  private readonly blades: THREE.Mesh[][] = [];
  private readonly discs: THREE.Mesh[] = [];
  private readonly angles = [0, 0, 0, 0];
  private readonly camPod: THREE.Group;
  private readonly led: THREE.Mesh;

  constructor(p: DroneParams, d: DerivedParams) {
    const body = new THREE.Group();
    // Model is built around the centre of the arm plane; shift so the root is the CG.
    body.position.set(d.modelOffset[0], d.modelOffset[1], d.modelOffset[2]);
    this.root.add(body);

    const carbon = new THREE.MeshStandardMaterial({ color: p.visual.frameColor, roughness: 0.45, metalness: 0.35 });
    const alu = new THREE.MeshStandardMaterial({ color: 0x8a8d93, roughness: 0.35, metalness: 0.9 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.6, metalness: 0.2 });
    const propMat = new THREE.MeshStandardMaterial({ color: p.visual.propColor, roughness: 0.4, metalness: 0, transparent: true, opacity: 1 });
    const batMat = new THREE.MeshStandardMaterial({ color: p.visual.batteryColor, roughness: 0.5, metalness: 0.1 });

    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      body.add(m);
      return m;
    };

    const mx = p.frame.motorX, mz = p.frame.motorZ;
    const R = p.rotor.radius;
    const bodyC = p.frame.components.find((c) => c.name === 'body')!;
    const [bw, bh, bl] = bodyC.size;
    const armLen = Math.hypot(mx, mz);
    const armW = Math.max(0.008, R * 0.2);

    // Arms.
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const arm = mesh(new THREE.BoxGeometry(armW, 0.005, armLen), carbon, (sx * mx) / 2, 0, (sz * mz) / 2);
      arm.rotation.y = Math.atan2(sx * mx, sz * mz);
    }
    // Bottom and top plates with standoffs.
    mesh(new THREE.BoxGeometry(bw, 0.003, bl), carbon, 0, 0.003, 0);
    mesh(new THREE.BoxGeometry(bw, 0.002, bl), carbon, 0, bh, 0);
    const so = new THREE.CylinderGeometry(0.0025, 0.0025, bh, 6);
    for (const sx of [-1, 1]) {
      for (const fz of [-0.46, -0.15, 0.15, 0.46]) {
        mesh(so, alu, sx * (bw / 2 - 0.004), bh / 2, fz * bl);
      }
    }
    // Electronics stack.
    mesh(new THREE.BoxGeometry(bw * 0.8, bh * 0.55, 0.036), dark, 0, bh * 0.4, 0.004);

    // Battery on the top plate with a strap.
    const bat = p.frame.components.find((c) => c.name === 'battery')!;
    mesh(new THREE.BoxGeometry(bat.size[0], bat.size[1], bat.size[2]), batMat, 0, bat.pos[1], 0);
    mesh(new THREE.BoxGeometry(bat.size[0] + 0.003, bat.size[1] + 0.003, 0.016), new THREE.MeshStandardMaterial({ color: 0xc62828, roughness: 0.8 }), 0, bat.pos[1], 0);
    // Label.
    mesh(new THREE.BoxGeometry(bat.size[0] * 0.8, 0.0006, bat.size[2] * 0.5), new THREE.MeshStandardMaterial({ color: 0xf2c200, roughness: 0.6 }), 0, bat.pos[1] + bat.size[1] / 2 + 0.0004, bat.size[2] * 0.18);

    // Action camera, if the build carries one.
    const ac = p.frame.components.find((c) => c.name === 'actioncam');
    if (ac) {
      const cam = mesh(new THREE.BoxGeometry(ac.size[0], ac.size[1], ac.size[2]), new THREE.MeshStandardMaterial({ color: 0x2b2d30, roughness: 0.5 }), ac.pos[0], ac.pos[1] + 0.012, ac.pos[2] - 0.02);
      cam.rotation.x = 0.45;
      const lens = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.01, 16), new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.1, metalness: 0.6 }), ac.pos[0] + 0.012, ac.pos[1] + 0.022, ac.pos[2] - 0.038);
      lens.rotation.x = Math.PI / 2 + 0.45;
    }

    // FPV camera pod between the front standoffs.
    // The lens sits just above the prop plane and ahead of the front standoffs, as
    // on most freestyle frames - so the props show up in the lower corners of a wide lens.
    const camY = Math.max(bh * 0.55, p.frame.rotorHeight + 0.009);
    const camZ = -bl / 2 - 0.006;
    this.camPod = new THREE.Group();
    this.camPod.position.set(0, camY, camZ + 0.008);
    body.add(this.camPod);
    const podBox = new THREE.Mesh(new THREE.BoxGeometry(0.019, 0.019, 0.016), dark);
    podBox.position.z = 0.006;
    this.camPod.add(podBox);
    const lensM = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.008, 0.012, 14), new THREE.MeshStandardMaterial({ color: 0x08080a, roughness: 0.15, metalness: 0.7 }));
    lensM.rotation.x = Math.PI / 2;
    lensM.position.z = -0.006;
    this.camPod.add(lensM);
    this.cameraMount.set(d.modelOffset[0], d.modelOffset[1] + camY, d.modelOffset[2] + camZ - 0.004);
    // Camera cage side plates.
    for (const sx of [-1, 1]) {
      mesh(new THREE.BoxGeometry(0.002, camY + 0.012, 0.03), carbon, sx * 0.0125, (camY + 0.012) / 2, camZ + 0.02);
    }

    // VTX antenna and receiver antennas at the back.
    const ant = mesh(new THREE.CylinderGeometry(0.0015, 0.0015, 0.06, 6), dark, 0, bh + 0.02, bl / 2 + 0.012);
    ant.rotation.x = -0.6;
    mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.014, 12), new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.5 }), 0, bh + 0.047, bl / 2 + 0.03);
    // Tail LED strip: the best orientation cue when flying line-of-sight.
    this.led = mesh(new THREE.BoxGeometry(bw * 0.9, 0.006, 0.003), new THREE.MeshStandardMaterial({ color: 0x200000, emissive: 0xff2010, emissiveIntensity: 6 }), 0, bh * 0.5, bl / 2 + 0.002);
    this.led.castShadow = false;

    // Motors and props.
    const motorSize = p.frame.components.find((c) => c.name === 'motor')!.size;
    const mr = motorSize[0] / 2, mh = motorSize[1];
    const bell = new THREE.CylinderGeometry(mr, mr, mh * 0.72, 20);
    const basePlate = new THREE.CylinderGeometry(mr * 0.9, mr * 0.7, mh * 0.28, 16);
    const hubGeo = new THREE.CylinderGeometry(R * 0.11, R * 0.11, 0.007, 12);
    const discGeo = new THREE.CircleGeometry(R, 40);
    discGeo.rotateX(-Math.PI / 2);
    const bladeGeo = this.bladeGeometry(R, p.rotor.chord, p.rotor.pitch);
    const discMatBase = new THREE.MeshBasicMaterial({ color: p.visual.propColor, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });

    for (let i = 0; i < 4; i++) {
      // Physics rotor positions are relative to the CG; convert to the model frame.
      const rx = d.rotorPos[i][0] - d.modelOffset[0];
      const rz = d.rotorPos[i][2] - d.modelOffset[2];
      mesh(basePlate, dark, rx, 0.0025 + mh * 0.14, rz);
      mesh(bell, alu, rx, 0.0025 + mh * 0.28 + mh * 0.36, rz);
      const prop = new THREE.Group();
      prop.position.set(rx, p.frame.rotorHeight, rz);
      body.add(prop);
      const hub = new THREE.Mesh(hubGeo, propMat);
      prop.add(hub);
      const bl3: THREE.Mesh[] = [];
      const spin = d.rotorSpin[i];
      for (let b = 0; b < p.rotor.blades; b++) {
        const blade = new THREE.Mesh(bladeGeo, propMat.clone());
        blade.rotation.y = (b / p.rotor.blades) * Math.PI * 2;
        // Mirror the blade for clockwise props so the leading edge is always high.
        if (spin < 0) blade.scale.z = -1;
        blade.castShadow = true;
        prop.add(blade);
        bl3.push(blade);
      }
      const disc = new THREE.Mesh(discGeo, discMatBase.clone());
      disc.position.y = 0.001;
      prop.add(disc);
      this.props.push(prop);
      this.blades.push(bl3);
      this.discs.push(disc);
    }
  }

  /** A twisted, tapered blade along +X. */
  private bladeGeometry(R: number, chord: number, pitch: number): THREE.BufferGeometry {
    const seg = 8;
    const pos: number[] = [], idx: number[] = [];
    for (let i = 0; i <= seg; i++) {
      const f = i / seg;
      const r = R * (0.12 + 0.88 * f);
      // Chord swells then tapers to the tip; twist decreases outboard (constant pitch distance).
      const c = chord * (0.75 + 0.9 * Math.sin(Math.min(1, f * 1.25) * Math.PI) * 0.55) * (f > 0.9 ? 1 - (f - 0.9) * 5 : 1);
      const tw = Math.atan(Math.tan(pitch) * 0.75 / Math.max(f, 0.25));
      const cz = Math.cos(tw) * c * 0.5, cy = Math.sin(tw) * c * 0.5;
      // CCW rotor (seen from above) moves towards -Z at +X; leading edge is high.
      pos.push(r, cy, -cz, r, -cy, cz);
    }
    for (let i = 0; i < seg; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  setCameraTilt(rad: number): void {
    this.camPod.rotation.x = rad;
  }

  /** Copy the physics state onto the model and animate the props. */
  update(drone: Drone, dt: number, onboard = false): void {
    const p = drone.pos, q = drone.q;
    this.root.position.set(p.x, p.y, p.z);
    this.root.quaternion.set(q.x, q.y, q.z, q.w);
    for (let i = 0; i < 4; i++) {
      const r = drone.rotors[i];
      const spin = drone.d.rotorSpin[i];
      this.angles[i] = (this.angles[i] + spin * r.omega * dt) % (Math.PI * 2);
      this.props[i].rotation.y = this.angles[i];
      // Above a few thousand rpm the eye (and the camera) only sees a disc.
      const rpm = Math.abs(r.rpm);
      const blur = THREE.MathUtils.smoothstep(rpm, 500, 4500);
      for (const b of this.blades[i]) {
        const m = b.material as THREE.MeshStandardMaterial;
        m.opacity = 1 - 0.9 * blur;
        m.transparent = blur > 0.01;
        b.castShadow = blur < 0.5;
      }
      const dm = this.discs[i].material as THREE.MeshBasicMaterial;
      dm.opacity = (onboard ? 0.1 : 0.22) * blur * (0.6 + 0.4 * r.health);
      this.discs[i].visible = blur > 0.02;
    }
  }
}
