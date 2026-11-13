/**
 * Collision world: a terrain heightfield plus static primitives (boxes with yaw,
 * vertical cylinders, spheres), with a uniform grid broadphase. The drone is
 * represented by a handful of spheres, so every query is sphere-vs-primitive.
 */

export type SurfaceKind = 'hard' | 'soft';

export interface BoxShape {
  type: 'box';
  x: number; y: number; z: number;
  hx: number; hy: number; hz: number;
  /** Rotation about +Y [rad]. */
  yaw: number;
  cos: number; sin: number;
  surface: SurfaceKind;
}

export interface CylShape {
  type: 'cyl';
  /** Base centre. */
  x: number; y: number; z: number;
  radius: number;
  height: number;
  surface: SurfaceKind;
}

export interface SphereShape {
  type: 'sphere';
  x: number; y: number; z: number;
  radius: number;
  surface: SurfaceKind;
}

export type Shape = BoxShape | CylShape | SphereShape;

export interface Contact {
  /** Unit normal pointing from the surface towards the query sphere. */
  nx: number; ny: number; nz: number;
  /** Penetration depth [m]. */
  depth: number;
  surface: SurfaceKind;
  ground: boolean;
}

/** Regular-grid terrain; the renderer triangulates it with the same diagonal. */
export class Heightfield {
  readonly size: number;
  readonly n: number;
  readonly cell: number;
  readonly data: Float32Array;

  constructor(size: number, n: number, fn: (x: number, z: number) => number) {
    this.size = size;
    this.n = n;
    this.cell = size / n;
    this.data = new Float32Array((n + 1) * (n + 1));
    const half = size / 2;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        this.data[j * (n + 1) + i] = fn(-half + i * this.cell, -half + j * this.cell);
      }
    }
  }

  /** Terrain height at (x, z); exactly matches the rendered triangles. */
  heightAt(x: number, z: number): number {
    const n = this.n;
    const fx = (x + this.size / 2) / this.cell;
    const fz = (z + this.size / 2) / this.cell;
    let i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0) i = 0; else if (i > n - 1) i = n - 1;
    if (j < 0) j = 0; else if (j > n - 1) j = n - 1;
    let u = fx - i, v = fz - j;
    if (u < 0) u = 0; else if (u > 1) u = 1;
    if (v < 0) v = 0; else if (v > 1) v = 1;
    const row = n + 1;
    const h00 = this.data[j * row + i];
    const h10 = this.data[j * row + i + 1];
    const h01 = this.data[(j + 1) * row + i];
    const h11 = this.data[(j + 1) * row + i + 1];
    if (u + v <= 1) return h00 + u * (h10 - h00) + v * (h01 - h00);
    return h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
  }

  /** Surface normal (not normalised input-safe): returns components via out array. */
  normalAt(x: number, z: number, out: { nx: number; ny: number; nz: number }): void {
    const n = this.n;
    const fx = (x + this.size / 2) / this.cell;
    const fz = (z + this.size / 2) / this.cell;
    let i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0) i = 0; else if (i > n - 1) i = n - 1;
    if (j < 0) j = 0; else if (j > n - 1) j = n - 1;
    const u = fx - i, v = fz - j;
    const row = n + 1;
    const h00 = this.data[j * row + i];
    const h10 = this.data[j * row + i + 1];
    const h01 = this.data[(j + 1) * row + i];
    const h11 = this.data[(j + 1) * row + i + 1];
    let dhdx: number, dhdz: number;
    if (u + v <= 1) {
      dhdx = (h10 - h00) / this.cell;
      dhdz = (h01 - h00) / this.cell;
    } else {
      dhdx = (h11 - h01) / this.cell;
      dhdz = (h11 - h10) / this.cell;
    }
    const inv = 1 / Math.sqrt(dhdx * dhdx + 1 + dhdz * dhdz);
    out.nx = -dhdx * inv;
    out.ny = inv;
    out.nz = -dhdz * inv;
  }
}

const CELL = 8;
const MARGIN = 0.25;

function key(ix: number, iz: number): number {
  return (ix + 2048) * 4096 + (iz + 2048);
}

export class CollisionWorld {
  readonly terrain: Heightfield;
  readonly shapes: Shape[] = [];
  private grid = new Map<number, Shape[]>();
  private tmpN = { nx: 0, ny: 1, nz: 0 };

  constructor(terrain: Heightfield) {
    this.terrain = terrain;
  }

  addBox(x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw = 0, surface: SurfaceKind = 'hard'): BoxShape {
    const s: BoxShape = {
      type: 'box', x, y, z, hx: sx / 2, hy: sy / 2, hz: sz / 2, yaw,
      cos: Math.cos(yaw), sin: Math.sin(yaw), surface,
    };
    const r = Math.hypot(s.hx, s.hz);
    this.insert(s, x - r, z - r, x + r, z + r);
    return s;
  }

  addCylinder(x: number, y: number, z: number, radius: number, height: number, surface: SurfaceKind = 'hard'): CylShape {
    const s: CylShape = { type: 'cyl', x, y, z, radius, height, surface };
    this.insert(s, x - radius, z - radius, x + radius, z + radius);
    return s;
  }

  addSphere(x: number, y: number, z: number, radius: number, surface: SurfaceKind = 'hard'): SphereShape {
    const s: SphereShape = { type: 'sphere', x, y, z, radius, surface };
    this.insert(s, x - radius, z - radius, x + radius, z + radius);
    return s;
  }

  private insert(s: Shape, x0: number, z0: number, x1: number, z1: number): void {
    this.shapes.push(s);
    const i0 = Math.floor((x0 - MARGIN) / CELL), i1 = Math.floor((x1 + MARGIN) / CELL);
    const j0 = Math.floor((z0 - MARGIN) / CELL), j1 = Math.floor((z1 + MARGIN) / CELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = key(i, j);
        let list = this.grid.get(k);
        if (!list) {
          list = [];
          this.grid.set(k, list);
        }
        list.push(s);
      }
    }
  }

  groundHeight(x: number, z: number): number {
    return this.terrain.heightAt(x, z);
  }

  /**
   * Find all contacts of a sphere (radius must be < MARGIN) with the world.
   * Contacts are written into `out` (objects are reused); returns the count.
   */
  querySphere(cx: number, cy: number, cz: number, r: number, out: Contact[]): number {
    let count = 0;

    // Terrain
    const h = this.terrain.heightAt(cx, cz);
    if (cy - r < h + 0.5) {
      const n = this.tmpN;
      this.terrain.normalAt(cx, cz, n);
      // Distance from the sphere centre to the local tangent plane.
      const dist = (cy - h) * n.ny;
      if (dist < r) {
        const c = out[count] ?? (out[count] = newContact());
        c.nx = n.nx; c.ny = n.ny; c.nz = n.nz;
        c.depth = r - dist;
        c.surface = 'hard';
        c.ground = true;
        count++;
      }
    }

    const list = this.grid.get(key(Math.floor(cx / CELL), Math.floor(cz / CELL)));
    if (!list) return count;

    for (let k = 0; k < list.length; k++) {
      const s = list[k];
      let nx = 0, ny = 0, nz = 0, depth = -1;
      if (s.type === 'box') {
        // Into box-local coordinates.
        const dx = cx - s.x, dy = cy - s.y, dz = cz - s.z;
        const lx = dx * s.cos - dz * s.sin;
        const lz = dx * s.sin + dz * s.cos;
        const ly = dy;
        const qx = lx < -s.hx ? -s.hx : lx > s.hx ? s.hx : lx;
        const qy = ly < -s.hy ? -s.hy : ly > s.hy ? s.hy : ly;
        const qz = lz < -s.hz ? -s.hz : lz > s.hz ? s.hz : lz;
        let ex = lx - qx, ey = ly - qy, ez = lz - qz;
        const d2 = ex * ex + ey * ey + ez * ez;
        if (d2 > r * r) continue;
        let lnx: number, lny: number, lnz: number;
        if (d2 > 1e-12) {
          const d = Math.sqrt(d2);
          lnx = ex / d; lny = ey / d; lnz = ez / d;
          depth = r - d;
        } else {
          // Centre inside the box: push out through the nearest face.
          const px = s.hx - Math.abs(lx), py = s.hy - Math.abs(ly), pz = s.hz - Math.abs(lz);
          lnx = lny = lnz = 0;
          if (px <= py && px <= pz) { lnx = lx >= 0 ? 1 : -1; depth = px + r; }
          else if (py <= pz) { lny = ly >= 0 ? 1 : -1; depth = py + r; }
          else { lnz = lz >= 0 ? 1 : -1; depth = pz + r; }
        }
        nx = lnx * s.cos + lnz * s.sin;
        nz = -lnx * s.sin + lnz * s.cos;
        ny = lny;
      } else if (s.type === 'cyl') {
        const dx = cx - s.x, dz = cz - s.z;
        const ly = cy - s.y;
        if (ly < -r || ly > s.height + r) continue;
        const rad = Math.sqrt(dx * dx + dz * dz);
        if (rad > s.radius + r) continue;
        const qy = ly < 0 ? 0 : ly > s.height ? s.height : ly;
        const qr = rad > s.radius ? s.radius : rad;
        const er = rad - qr, ey = ly - qy;
        const d2 = er * er + ey * ey;
        if (d2 > r * r) continue;
        const ux = rad > 1e-9 ? dx / rad : 1, uz = rad > 1e-9 ? dz / rad : 0;
        if (d2 > 1e-12) {
          const d = Math.sqrt(d2);
          nx = (ux * er) / d; nz = (uz * er) / d; ny = ey / d;
          depth = r - d;
        } else {
          // Inside: nearest of side / top / bottom.
          const pr = s.radius - rad, pt = s.height - ly, pb = ly;
          if (pr <= pt && pr <= pb) { nx = ux; nz = uz; ny = 0; depth = pr + r; }
          else if (pt <= pb) { nx = 0; nz = 0; ny = 1; depth = pt + r; }
          else { nx = 0; nz = 0; ny = -1; depth = pb + r; }
        }
      } else {
        const dx = cx - s.x, dy = cy - s.y, dz = cz - s.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        const rr = r + s.radius;
        if (d2 > rr * rr) continue;
        const d = Math.sqrt(d2);
        if (d > 1e-9) { nx = dx / d; ny = dy / d; nz = dz / d; }
        else { nx = 0; ny = 1; nz = 0; }
        depth = rr - d;
      }
      if (depth > 0) {
        const c = out[count] ?? (out[count] = newContact());
        c.nx = nx; c.ny = ny; c.nz = nz;
        c.depth = depth;
        c.surface = s.surface;
        c.ground = false;
        count++;
      }
    }
    return count;
  }
}

function newContact(): Contact {
  return { nx: 0, ny: 1, nz: 0, depth: 0, surface: 'hard', ground: true };
}

/** A timing gate: a rectangle in a vertical plane. */
export interface GateDef {
  x: number; y: number; z: number;
  /** Heading of the direction of travel through the gate [rad], 0 = -Z, clockwise. */
  heading: number;
  width: number;
  height: number;
}

/**
 * Did the segment p0->p1 pass through the gate opening in the forward direction?
 */
export function crossedGate(g: GateDef, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
  // Forward direction of the gate (heading convention: 0 = -Z, clockwise from above).
  const fx = Math.sin(g.heading), fz = -Math.cos(g.heading);
  const d0 = (x0 - g.x) * fx + (z0 - g.z) * fz;
  const d1 = (x1 - g.x) * fx + (z1 - g.z) * fz;
  if (!(d0 < 0 && d1 >= 0)) return false;
  const t = d0 / (d0 - d1);
  const px = x0 + (x1 - x0) * t, py = y0 + (y1 - y0) * t, pz = z0 + (z1 - z0) * t;
  // Lateral axis (right of travel): (-fz, fx) rotated... right = (cos h, sin h) in (x, z)
  const rx = Math.cos(g.heading), rz = Math.sin(g.heading);
  const lat = (px - g.x) * rx + (pz - g.z) * rz;
  return Math.abs(lat) <= g.width / 2 && Math.abs(py - g.y) <= g.height / 2;
}
