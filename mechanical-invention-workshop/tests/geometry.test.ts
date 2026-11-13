import { beforeAll, describe, expect, it } from 'vitest';
import { createPart, createProject, geometryOf, massProps } from '../src/core/model/project';
import { PART_DEFS, defaultParams } from '../src/core/parts/catalog';
import { gearDims, involuteGearProfile, rackProfile, camLift, camProfile, camPitch } from '../src/core/parts/profiles';
import { areaProps, contoursOverlap, signedArea, transformPoly } from '../src/core/math/poly';
import { buildSolid, initKernel, intersectionArea, meshCheck } from '../src/core/geom/kernel';
import { findInterference } from '../src/core/assembly/interference';
import { Builder, GROUND } from '../src/core/model/builder';
import { DEG, RPM } from '../src/core/units';
import { autoLayer } from '../src/core/assembly/autolayer';
import { SimRunner } from '../src/core/sim/runner';
import { EXAMPLES } from '../src/examples';

beforeAll(async () => { await initKernel(); });
const P = createProject('t');

describe('involute spur gears', () => {
  it('standard proportions: pitch, base, tip, root diameters', () => {
    const d = gearDims(2, 20, 20 * DEG, 0);
    expect(d.pitchR).toBe(20);
    expect(d.baseR).toBeCloseTo(20 * Math.cos(20 * DEG), 12);
    expect(d.tipR).toBe(22);
    expect(d.rootR).toBe(17.5);
    expect(d.toothThickness).toBeCloseTo(Math.PI, 12);        // π·m/2
  });
  it('flank points satisfy the involute equation of the base circle (1e-9 mm)', () => {
    const m = 2, z = 24, a = 20 * DEG;
    const { poly, dims } = involuteGearProfile(m, z, a, 0);
    const inv = (x: number) => Math.tan(x) - x;
    let checked = 0;
    for (const [x, y] of poly) {
      const r = Math.hypot(x, y);
      if (r <= dims.baseR + 1e-6 || r >= dims.tipR - 1e-6) continue;
      // angular half-thickness at radius r must equal s/(2r_p) + inv(α) − inv(α_r)
      const ang = Math.atan2(y, x);
      const pitch = (2 * Math.PI) / z;
      const rel = Math.abs(((ang + pitch / 2) % pitch + pitch) % pitch - pitch / 2);
      const expected = dims.toothThickness / (2 * dims.pitchR) + inv(a) - inv(Math.acos(dims.baseR / r));
      expect(Math.abs(rel - expected) * r).toBeLessThan(1e-9);
      checked++;
    }
    expect(checked).toBeGreaterThan(z * 10);
    expect(signedArea(poly)).toBeGreaterThan(0);              // CCW
  });
  it('backlash clearance is cut into the geometry: tooth thickness at the pitch circle shrinks by backlash/2', () => {
    const t0 = gearDims(2, 20, 20 * DEG, 0).toothThickness, t1 = gearDims(2, 20, 20 * DEG, 0.2).toothThickness;
    expect(t0 - t1).toBeCloseTo(0.1, 12);
    const a0 = Math.abs(signedArea(involuteGearProfile(2, 20, 20 * DEG, 0).poly)), a1 = Math.abs(signedArea(involuteGearProfile(2, 20, 20 * DEG, 0.2).poly));
    expect(a1).toBeLessThan(a0);
  });
  it('meshing gears at the correct centre distance and phase do not overlap; too close → overlap is detected', () => {
    const b = new Builder('m', 't');
    const g1 = b.part('gear', 'G1', { module: 2, teeth: 15 }, { x: 0, y: 0 });
    const g2 = b.part('gear', 'G2', { module: 2, teeth: 31 }, { x: 46, y: 0 });
    b.revolute(GROUND, { x: 0, y: 0 }, g1, 'center'); b.revolute(GROUND, { x: 46, y: 0 }, g2, 'center');
    b.gear(g1, g2);
    const ok = b.solve().build();
    expect(findInterference(ok)).toEqual([]);
    // rotate one gear by half a tooth pitch without re-solving → teeth collide
    const bad = { ...ok, parts: ok.parts.map((p) => (p.id === g2 ? { ...p, pose: { ...p.pose, angle: p.pose.angle + Math.PI / 31 } } : p)) };
    const hit = findInterference(bad);
    expect(hit.length).toBe(1);
    expect(hit[0].area).toBeGreaterThan(0.5);
    // push the shafts 1 mm closer
    const close = { ...ok, parts: ok.parts.map((p) => (p.id === g2 ? { ...p, pose: { ...p.pose, x: p.pose.x - 1 } } : p)) };
    expect(findInterference(close).length).toBe(1);
  });
  it('rack pitch equals π·m and tooth count sets the length', () => {
    const r = rackProfile(1.5, 12, 20 * DEG, 0, 5);
    expect(r.pitch).toBeCloseTo(Math.PI * 1.5, 12);
    expect(r.length).toBeCloseTo(12 * Math.PI * 1.5, 12);
    expect(signedArea(r.poly)).toBeGreaterThan(0);
  });
});

describe('cams', () => {
  const segs = defaultParams('cam').segments;
  it('motion program: lift, continuity and closure', () => {
    expect(camLift(segs, 0).s).toBe(0);
    expect(camLift(segs, 60 * DEG).s).toBeCloseTo(5, 12);       // cycloidal mid-rise
    expect(camLift(segs, 120 * DEG).s).toBeCloseTo(10, 12);
    expect(camLift(segs, 150 * DEG).s).toBeCloseTo(10, 12);     // dwell
    expect(camLift(segs, 300 * DEG).s).toBeCloseTo(0, 12);
    // derivative matches a finite difference
    for (const th of [0.3, 1.1, 2.0, 3.6, 4.4]) {
      const h = 1e-6;
      expect(camLift(segs, th).ds).toBeCloseTo((camLift(segs, th + h).s - camLift(segs, th - h).s) / (2 * h), 5);
    }
    // cycloidal: zero velocity at both ends of the rise
    expect(camLift(segs, 1e-9).ds).toBeCloseTo(0, 6);
    expect(camLift(segs, 120 * DEG - 1e-9).ds).toBeCloseTo(0, 6);
  });
  it('cam surface is the inner offset of the pitch curve by the roller radius (1e-3 mm)', () => {
    const cp = { profile: 'segments' as const, baseRadius: 18, rollerRadius: 5, segments: segs };
    const prof = camProfile(cp);
    expect(prof.minR).toBeCloseTo(18, 6);
    expect(prof.maxR).toBeCloseTo(28, 3);
    expect(prof.warnings).toEqual([]);
    // every surface point is exactly one roller radius from its pitch point, and no pitch point is closer than that to any surface point
    for (let i = 0; i < prof.surface.length; i += 37) {
      const [sx, sy] = prof.surface[i], [px, py] = prof.pitch[i];
      expect(Math.hypot(sx - px, sy - py)).toBeCloseTo(5, 9);
      let min = Infinity;
      for (const [qx, qy] of prof.surface) min = Math.min(min, Math.hypot(qx - px, qy - py));
      expect(min).toBeGreaterThan(5 - 1e-3);
    }
  });
  it('eccentric cam: polar pitch function reproduces an offset circle', () => {
    const cp = { profile: 'eccentric' as const, baseRadius: 0, rollerRadius: 4, segments: [], discRadius: 20, eccentricity: 6 };
    for (const phi of [0, 0.7, 2.1, 3.9, 5.5]) {
      const { r } = camPitch(cp, phi);
      const x = r * Math.cos(phi) - 6, y = r * Math.sin(phi);
      expect(Math.hypot(x, y)).toBeCloseTo(24, 9);
    }
  });
  it('undercut and non-closing programs are reported', () => {
    const tight = camProfile({ profile: 'segments', baseRadius: 6, rollerRadius: 8, segments: [{ duration: 40 * DEG, lift: 14, law: 'harmonic' }, { duration: 40 * DEG, lift: 0, law: 'harmonic' }, { duration: 280 * DEG, lift: 0, law: 'dwell' }] });
    expect(tight.warnings.some((w) => /undercut/.test(w))).toBe(true);
    const open = camProfile({ profile: 'segments', baseRadius: 20, rollerRadius: 5, segments: [{ duration: 180 * DEG, lift: 8, law: 'cycloidal' }, { duration: 180 * DEG, lift: 8, law: 'dwell' }] });
    expect(open.warnings.some((w) => /does not close/.test(w))).toBe(true);
  });
});

describe('part geometry, clearances and mass properties', () => {
  it('every catalogue part builds a closed solid whose volume equals the analytic layer volume', () => {
    for (const kind of Object.keys(PART_DEFS) as (keyof typeof PART_DEFS)[]) {
      if (kind === 'plate') continue;
      const part = createPart(kind, kind);
      const g = geometryOf(P, part);
      const solid = buildSolid(g.layers)!;
      const chk = meshCheck(solid.positions, solid.indices);
      expect(chk.closed, kind).toBe(true);
      expect(solid.status, kind).toBe('NoError');
      const mp = massProps(P, part);
      expect(Math.abs(solid.volume - mp.volume) / mp.volume, kind).toBeLessThan(1e-6);
      expect(Math.abs(chk.volume - mp.volume) / mp.volume, kind).toBeLessThan(1e-4);
    }
  });
  it('hole clearance is part of the geometry: modelled hole = nominal + clearance', () => {
    const link = createPart('link', 'l', 'L', { length: 50, holeDiameter: 4, width: 12 });
    const g0 = geometryOf({ ...P, clearances: { ...P.clearances, hole: 0 } }, link);
    const g1 = geometryOf({ ...P, clearances: { ...P.clearances, hole: 0.3 } }, { ...link, params: { ...link.params } });
    expect(g0.holes[0].d).toBe(4);
    expect(g1.holes[0].d).toBeCloseTo(4.3, 12);
    const a0 = areaProps(g0.layers[0].contours).area, a1 = areaProps(g1.layers[0].contours).area;
    // two holes grew: Δarea ≈ 2·π/4·(4.3² − 4²) (polygonal circles → 1 %)
    expect((a0 - a1) / (2 * (Math.PI / 4) * (4.3 ** 2 - 16))).toBeCloseTo(1, 1);
    // slider is narrower than its slot by 2 × slide clearance
    const sl = geometryOf(P, createPart('slider', 's', 'S', { width: 10, length: 20 }));
    const ys = sl.layers[0].contours[0].map((p) => p[1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(10 - 2 * P.clearances.slide, 9);
  });
  it('link mass properties match the closed form for a stadium with two holes (0.2 %)', () => {
    const L = 80, w = 12, t = 5, d = 4 + P.clearances.hole;
    const part = createPart('link', 'l', 'L', { length: L, width: w, thickness: t, holeDiameter: 4 });
    const mp = massProps(P, part);
    const area = L * w + Math.PI * (w / 2) ** 2 - 2 * Math.PI * (d / 2) ** 2;
    expect(Math.abs(mp.volume - area * t) / (area * t)).toBeLessThan(2e-3);
    expect(mp.mass).toBeCloseTo(1.24e-6 * mp.volume, 12);        // PLA 1.24 g/cm³
    expect(mp.cx).toBeCloseTo(L / 2, 6);
    expect(mp.cy).toBeCloseTo(0, 6);
    // polar inertia about the centroid: rectangle + two half discs − two holes (parallel axis)
    const r = w / 2;
    const Jrect = (L * w * (L * L + w * w)) / 12;
    const Jdisc = (Math.PI * r ** 4) / 2;                       // both half discs about their own disc centre
    const semiA = (Math.PI * r * r) / 2, c = (4 * r) / (3 * Math.PI);
    const Jcaps = Jdisc - 2 * semiA * c * c + 2 * semiA * (L / 2 + c) ** 2;
    const Jholes = 2 * ((Math.PI * (d / 2) ** 4) / 2 + Math.PI * (d / 2) ** 2 * (L / 2) ** 2);
    const J = Jrect + Jcaps - Jholes;
    expect(Math.abs(mp.inertia - 1.24e-6 * t * J) / (1.24e-6 * t * J)).toBeLessThan(2e-3);
  });
  it('mass and inertia overrides are honoured; motors use their catalogue mass', () => {
    const part = createPart('link', 'l');
    const base = massProps(P, part);
    const ov = massProps(P, { ...part, massOverride: { mass: 0.5 } });
    expect(ov.mass).toBe(0.5);
    expect(ov.inertia / base.inertia).toBeCloseTo(0.5 / base.mass, 9);
    expect(massProps(P, { ...part, massOverride: { mass: 0.5, inertia: 123 } }).inertia).toBe(123);
    expect(massProps(P, createPart('motor', 'm')).mass).toBe(0.28);
  });
  it('polygon overlap test and kernel intersection area agree', () => {
    const a = geometryOf(P, createPart('link', 'a', 'A', { length: 40 })).layers[0].contours;
    const far = a.map((c) => transformPoly(c, 0, 30, 0)), cross = a.map((c) => transformPoly(c, 20, -20, Math.PI / 2));
    expect(contoursOverlap(a, far)).toBe(false);
    expect(contoursOverlap(a, cross)).toBe(true);
    expect(intersectionArea(a, far)).toBe(0);
    expect(intersectionArea(a, cross)).toBeCloseTo(100, 0);     // 10 × 10 crossing
  });
});

describe('auto-stack layers', () => {
  it('raises only the parts that would collide during the motion and leaves a clean assembly unchanged', () => {
    // four-bar with every link on the same layer: pinned links overlap at their pins, and the coupler sweeps over the crank
    const b = new Builder('flat', 't');
    const c = b.part('link', 'Crank', { length: 30 }, { angle: Math.PI / 2 });
    const k = b.part('link', 'Coupler', { length: 90 }, { x: 0, y: 30, angle: 0.3 });
    const r = b.part('link', 'Rocker', { length: 70 }, { x: 100, y: 0, angle: Math.PI / 2 });
    const j = b.revolute(GROUND, { x: 0, y: 0 }, c, 'A'); b.revolute(c, 'B', k, 'A'); b.revolute(k, 'B', r, 'B'); b.revolute(GROUND, { x: 100, y: 0 }, r, 'A');
    b.motor(j, { speed: 60 * RPM, maxTorque: null });
    const flat = b.solve().build();
    const before = new SimRunner({ ...flat, sim: { ...flat.sim, mode: 'kinematic' } });
    before.advance(1200);
    expect(before.events.filter((e) => e.code.startsWith('interference')).length).toBeGreaterThan(0);
    const res = autoLayer(flat);
    expect(res.samples).toBeGreaterThan(50);
    expect(res.moved.map((m) => m.id)).toEqual([k]);            // only the coupler has to move
    expect(res.project.parts.find((p) => p.id === k)!.pose.z).toBeCloseTo(4.5, 9);   // one link thickness + 0.5 mm running gap
    const after = new SimRunner({ ...res.project, sim: { ...res.project.sim, mode: 'kinematic' } });
    after.advance(1200);
    expect(after.events.filter((e) => e.code.startsWith('interference'))).toEqual([]);
    expect(autoLayer(res.project).project).toBe(res.project);  // idempotent: nothing left to fix
    // parts that merely touch along Z (a motor flange under its mounting plate) are not "interference" and stay put
    const fb = EXAMPLES.find((e) => e.id === 'fourbar')!.build();
    const coupler = fb.parts.find((p) => p.name === 'Coupler')!, crank = fb.parts.find((p) => p.name === 'Crank')!;
    const lowered = { ...fb, parts: fb.parts.map((p) => (p.id === coupler.id ? { ...p, pose: { ...p.pose, z: crank.pose.z } } : p)) };
    const fix = autoLayer(lowered);
    expect(fix.moved.map((m) => m.id)).toEqual([coupler.id]);
    expect(fix.project.parts.find((p) => p.id === coupler.id)!.pose.z).toBeCloseTo(coupler.pose.z, 9);   // back to exactly the shipped layer
  });
});

describe('parts that cannot be built as specified are errors, and their export is refused', () => {
  it('link whose pin holes are as wide as the link: error, no silent hole-less part', async () => {
    const { checkPrintable, exportPartSTL } = await import('../src/core/export');
    const proj = { ...createProject('x'), parts: [createPart('link', 'l', 'Crank', { length: 30, width: 12, holeDiameter: 12 })] };
    const g = geometryOf(proj, proj.parts[0]);
    expect(g.errors.join(' ')).toMatch(/were NOT cut: this link has no pivot holes/);
    const rep = checkPrintable(proj, proj.parts[0]);
    expect(rep.exportable).toBe(false);
    expect(rep.issues.some((i) => i.severity === 'error' && /Export refused/.test(i.message))).toBe(true);
    const out = exportPartSTL(proj, 'l');
    expect(out.ok).toBe(false);
    expect(out.bytes).toBeUndefined();
    const { compile } = await import('../src/core/assembly/compile');
    expect(compile(proj, 'dynamic').issues.some((i) => i.code === 'geometry.invalid' && i.severity === 'error')).toBe(true);
  });
  it('follower whose stem vanishes under the slide clearance: error; plate holes that overlap or break the edge are reported', () => {
    const tight = { ...P, clearances: { ...P.clearances, slide: 2 } };
    const f = geometryOf(tight, createPart('follower', 'f', 'F', { stemWidth: 1 }));
    expect(f.errors.join(' ')).toMatch(/the stem cannot be made/);
    const ys = f.layers[0].contours[0].map((p) => p[1]);
    expect(Math.max(...ys)).toBeGreaterThan(40);                 // the stem is still drawn (at minimum feature size), not dropped
    const plate = geometryOf(P, createPart('baseplate', 'b', 'B', { width: 100, height: 50, cornerRadius: 8, holes: [{ x: 0, y: 0, d: 5 }, { x: 2, y: 0, d: 5 }, { x: 47, y: 22, d: 5 }, { x: 30, y: 0, d: 5 }, { x: 35.6, y: 0, d: 5 }] }));
    expect(plate.warnings.some((w) => /Holes H1 and H2 overlap/.test(w))).toBe(true);
    expect(plate.warnings.some((w) => /wall between holes H4 and H5/.test(w))).toBe(true);
    expect(plate.errors.some((w) => /Hole H3 .*breaks through or lies outside the plate outline/.test(w))).toBe(true);
    expect(plate.holes.map((h) => h.label)).toEqual(['H1', 'H2', 'H4', 'H5']);
  });
  it('mass uses the true region when holes overlap (matches the solid volume)', () => {
    const part = createPart('link', 'l', 'Short', { length: 1, width: 12, holeDiameter: 5, thickness: 4 });
    const solid = buildSolid(geometryOf(P, part).layers)!;
    const mp = massProps(P, part);
    expect(Math.abs(mp.volume - solid.volume) / solid.volume).toBeLessThan(1e-6);
  });
});
