/**
 * Binary STL writer / reader. Units are millimetres (stated in the header).
 *
 * Layout: 80-byte header, uint32 triangle count, then per triangle 12 float32
 * (normal, v1, v2, v3) + uint16 attribute = 50 bytes. Everything little-endian.
 */
import type { SolidMesh } from '../geom/kernel';

export function meshToBinarySTL(mesh: SolidMesh, name: string): Uint8Array {
  const nt = Math.floor(mesh.indices.length / 3);
  const bytes = new Uint8Array(84 + 50 * nt);
  const view = new DataView(bytes.buffer);
  // Header must not begin with "solid" (ASCII-STL sniffing) and must be plain ASCII.
  const header = `binary STL; units=mm; ${name}`.replace(/[^\x20-\x7e]/g, '?').slice(0, 80);
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i);
  view.setUint32(80, nt, true);
  const P = mesh.positions, I = mesh.indices;
  let o = 84;
  for (let t = 0; t < nt; t++) {
    const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) { nx /= len; ny /= len; nz /= len; } else { nx = 0; ny = 0; nz = 0; }
    view.setFloat32(o, nx, true); view.setFloat32(o + 4, ny, true); view.setFloat32(o + 8, nz, true);
    o += 12;
    for (const k of [a, b, c]) {
      view.setFloat32(o, P[k], true); view.setFloat32(o + 4, P[k + 1], true); view.setFloat32(o + 8, P[k + 2], true);
      o += 12;
    }
    view.setUint16(o, 0, true);
    o += 2;
  }
  return bytes;
}

export interface ParsedSTL {
  /** welded vertex positions (xyz triples) */
  positions: Float32Array;
  indices: Uint32Array;
  triangles: number;
  /** stored facet normals, 3 per triangle */
  normals: Float32Array;
  header: string;
}

/**
 * Parse a binary STL and weld vertices that are bit-for-bit identical, which
 * restores the indexed topology of a mesh written by meshToBinarySTL.
 */
export function parseBinarySTL(bytes: Uint8Array): ParsedSTL {
  if (bytes.length < 84) throw new Error('Not a binary STL: file is shorter than the 84-byte preamble.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nt = view.getUint32(80, true);
  if (bytes.length !== 84 + 50 * nt) throw new Error(`Binary STL size mismatch: header says ${nt} triangles (${84 + 50 * nt} bytes) but the file has ${bytes.length} bytes.`);
  let header = '';
  for (let i = 0; i < 80 && bytes[i] !== 0; i++) header += String.fromCharCode(bytes[i]);
  const indices = new Uint32Array(nt * 3);
  const normals = new Float32Array(nt * 3);
  const pos: number[] = [];
  const index = new Map<string, number>();
  let o = 84;
  for (let t = 0; t < nt; t++) {
    normals[3 * t] = view.getFloat32(o, true); normals[3 * t + 1] = view.getFloat32(o + 4, true); normals[3 * t + 2] = view.getFloat32(o + 8, true);
    o += 12;
    for (let k = 0; k < 3; k++) {
      // key on the raw bit patterns (−0 is normalised to +0 so they weld)
      const x = view.getFloat32(o, true) + 0, y = view.getFloat32(o + 4, true) + 0, z = view.getFloat32(o + 8, true) + 0;
      const key = `${x === 0 ? 0 : view.getUint32(o, true)}_${y === 0 ? 0 : view.getUint32(o + 4, true)}_${z === 0 ? 0 : view.getUint32(o + 8, true)}`;
      let id = index.get(key);
      if (id === undefined) { id = pos.length / 3; index.set(key, id); pos.push(x, y, z); }
      indices[3 * t + k] = id;
      o += 12;
    }
    o += 2;
  }
  return { positions: new Float32Array(pos), indices, triangles: nt, normals, header };
}
