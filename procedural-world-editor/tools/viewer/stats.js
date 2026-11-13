// Measurements of a glTF scene loaded with the stock three.js GLTFLoader. Used by the standalone
// viewer page (browser) and by tools/verify-export.mjs (Node, no rendering). Depends only on the
// THREE namespace passed in - nothing from the editor's src/ tree.
//
// Objects are identified through `userData` (glTF node `extras` written by the exporter), because
// GLTFLoader sanitises and de-duplicates node names.

function round(v, d = 4) {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

function trianglesOf(geometry) {
  const idx = geometry.getIndex();
  const n = idx ? idx.count : geometry.getAttribute('position')?.count || 0;
  return Math.floor(n / 3);
}

/** Evenly spaced sample indices 0..count-1 (always includes the first and last element). */
function sampleIndices(count, max) {
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  const out = [];
  for (let k = 0; k < max; k++) out.push(Math.round((k * (count - 1)) / (max - 1)));
  return out;
}

function meshesOf(obj) {
  const out = [];
  obj.traverse((o) => {
    if (o.isMesh) out.push(o);
  });
  return out;
}

/** Sum of triangle areas projected on the XZ plane (world space). */
function projectedArea(THREE, mesh) {
  const g = mesh.geometry;
  const pos = g.getAttribute('position');
  const idx = g.getIndex();
  const a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    c = new THREE.Vector3();
  const n = idx ? idx.count : pos.count;
  let area = 0;
  for (let t = 0; t + 2 < n; t += 3) {
    a.fromBufferAttribute(pos, idx ? idx.getX(t) : t).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(pos, idx ? idx.getX(t + 1) : t + 1).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(pos, idx ? idx.getX(t + 2) : t + 2).applyMatrix4(mesh.matrixWorld);
    area += Math.abs((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)) * 0.5;
  }
  return area;
}

/** Fraction of triangles whose geometric normal points upwards (counter-clockwise seen from +Y). */
function upFacingFraction(THREE, mesh) {
  const g = mesh.geometry;
  const pos = g.getAttribute('position');
  const idx = g.getIndex();
  const a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    c = new THREE.Vector3();
  const n = idx ? idx.count : pos.count;
  let up = 0,
    total = 0;
  for (let t = 0; t + 2 < n; t += 3) {
    a.fromBufferAttribute(pos, idx ? idx.getX(t) : t).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(pos, idx ? idx.getX(t + 1) : t + 1).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(pos, idx ? idx.getX(t + 2) : t + 2).applyMatrix4(mesh.matrixWorld);
    const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    if (ny > 0) up++;
    total++;
  }
  return total ? up / total : 0;
}

function vertexSamples(THREE, mesh, max) {
  const pos = mesh.geometry.getAttribute('position');
  const v = new THREE.Vector3();
  return sampleIndices(pos.count, max).map((i) => {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    return [round(v.x), round(v.y), round(v.z)];
  });
}

function boxOf(THREE, obj) {
  const box = new THREE.Box3().setFromObject(obj);
  return { min: box.min.toArray().map((v) => round(v, 3)), max: box.max.toArray().map((v) => round(v, 3)) };
}

/**
 * @param {object} THREE the three.js module namespace
 * @param {object} root  gltf.scene
 * @param {{terrainSamples?:number, waterSamples?:number, instanceSamples?:number, roadSamples?:number}} [o]
 */
export function collectStats(THREE, root, o = {}) {
  const terrainSamples = o.terrainSamples ?? 20000;
  const waterSamples = o.waterSamples ?? 6000;
  const instanceSamples = o.instanceSamples ?? 160;
  const roadSamples = o.roadSamples ?? 1500;
  root.updateMatrixWorld(true);
  const out = {
    source: 'three.js r' + THREE.REVISION + ' GLTFLoader',
    sceneBounds: null,
    sceneExtras: root.userData || {},
    groups: {},
    materials: [],
    terrain: null,
    water: [],
    structures: [],
    objects: [],
    scatter: [],
    roads: [],
    totals: { meshes: 0, instancedMeshes: 0, instances: 0, triangles: 0, instancedTriangles: 0 },
  };
  // ---- top-level groups (children of the `world` node) ----
  let world = null;
  root.traverse((n) => {
    if (!world && n.name === 'world') world = n;
  });
  world = world || root;
  const groupName = (child) => (child.userData?.kind === 'group' ? child.userData.group : child.userData?.kind === 'terrain' ? 'terrain' : child.name);
  for (const child of world.children) {
    const g = (out.groups[groupName(child)] ||= { meshes: 0, instancedMeshes: 0, instances: 0, triangles: 0, instancedTriangles: 0 });
    // an instanced node with several primitives becomes several InstancedMesh objects that share
    // the instance buffer: count instances once per glTF node (userData.kind === 'scatter')
    child.traverse((n) => {
      if (n.isMesh) {
        g.meshes++;
        const t = trianglesOf(n.geometry);
        g.triangles += t;
        if (n.isInstancedMesh) {
          g.instancedMeshes++;
          g.instancedTriangles += t * n.count;
        }
      }
      if (n.userData?.kind === 'scatter') {
        const im = meshesOf(n).find((m) => m.isInstancedMesh);
        if (im) g.instances += im.count;
      }
    });
    for (const k of Object.keys(out.totals)) out.totals[k] += g[k];
  }
  // ---- materials ----
  const mats = new Map();
  root.traverse((n) => {
    if (!n.isMesh) return;
    for (const m of Array.isArray(n.material) ? n.material : [n.material]) {
      if (!m || mats.has(m.uuid)) continue;
      mats.set(m.uuid, {
        name: m.name || '',
        type: m.type,
        hasMap: !!m.map,
        hasNormalMap: !!m.normalMap,
        transparent: !!m.transparent,
        alphaTest: m.alphaTest || 0,
        opacity: round(m.opacity ?? 1),
        transmission: round(m.transmission ?? 0),
        ior: m.ior !== undefined ? round(m.ior) : null,
        doubleSided: m.side === THREE.DoubleSide,
        color: m.color ? m.color.toArray().map((v) => round(v)) : null,
      });
    }
  });
  out.materials = [...mats.values()];
  // ---- typed objects ----
  const m4 = new THREE.Matrix4();
  const p = new THREE.Vector3(),
    q = new THREE.Quaternion(),
    s = new THREE.Vector3(),
    up = new THREE.Vector3();
  root.traverse((n) => {
    const kind = n.userData?.kind;
    if (kind === 'terrain') {
      const mesh = meshesOf(n)[0];
      if (!mesh) return;
      mesh.geometry.computeBoundingBox();
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      out.terrain = {
        bounds: boxOf(THREE, mesh),
        vertexCount: mesh.geometry.getAttribute('position').count,
        triangles: trianglesOf(mesh.geometry),
        hasNormals: !!mesh.geometry.getAttribute('normal'),
        hasUv: !!mesh.geometry.getAttribute('uv'),
        upFacing: round(upFacingFraction(THREE, mesh)),
        material: mat?.name || '',
        materialHasMap: !!mat?.map,
        extras: { ...n.userData },
        samples: vertexSamples(THREE, mesh, terrainSamples),
      };
    } else if (kind === 'water') {
      const mesh = meshesOf(n)[0];
      if (!mesh) return;
      const g = mesh.geometry;
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const uv1 = g.getAttribute('uv1');
      let maxFlow = 0;
      if (uv1) for (let i = 0; i < uv1.count; i++) maxFlow = Math.max(maxFlow, Math.hypot(uv1.getX(i), uv1.getY(i)));
      out.water.push({
        name: n.name,
        body: n.userData.body,
        id: n.userData.id,
        level: n.userData.level ?? null,
        vertexCount: g.getAttribute('position').count,
        triangles: trianglesOf(g),
        bounds: boxOf(THREE, mesh),
        areaXZ: round(projectedArea(THREE, mesh), 2),
        upFacing: round(upFacingFraction(THREE, mesh)),
        hasFlowAttribute: !!uv1,
        maxFlow: round(maxFlow),
        material: mat?.name || '',
        transmission: round(mat?.transmission ?? 0),
        transparent: !!mat?.transparent,
        samples: vertexSamples(THREE, mesh, waterSamples),
      });
    } else if (kind === 'structure' || kind === 'object') {
      n.matrixWorld.decompose(p, q, s);
      (kind === 'structure' ? out.structures : out.objects).push({
        id: n.userData.id,
        type: n.userData.type ?? null,
        model: n.userData.model ?? null,
        position: [round(p.x), round(p.y), round(p.z)],
        yawDeg: round((2 * Math.atan2(q.y, q.w) * 180) / Math.PI, 3),
        quaternion: q.toArray().map((v) => round(v, 5)),
        scale: round(s.x),
        meshes: meshesOf(n).length,
        triangles: meshesOf(n).reduce((a, m) => a + trianglesOf(m.geometry), 0),
        bounds: boxOf(THREE, n),
      });
    } else if (kind === 'scatter') {
      const ims = meshesOf(n).filter((m) => m.isInstancedMesh);
      const im = ims[0];
      if (!im) {
        out.scatter.push({ biome: n.userData.biome, layer: n.userData.layer, model: n.userData.model, count: 0, declaredCount: n.userData.count ?? null, primitives: 0, error: 'node did not load as an InstancedMesh' });
        return;
      }
      let minY = Infinity,
        maxY = -Infinity;
      for (const m of ims) {
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        minY = Math.min(minY, m.geometry.boundingBox.min.y);
        maxY = Math.max(maxY, m.geometry.boundingBox.max.y);
      }
      let minUpY = 1;
      const samples = sampleIndices(im.count, instanceSamples).map((i) => {
        im.getMatrixAt(i, m4);
        m4.premultiply(im.matrixWorld);
        m4.decompose(p, q, s);
        up.set(0, 1, 0).applyQuaternion(q);
        if (up.y < minUpY) minUpY = up.y;
        return [round(p.x), round(p.y), round(p.z), round(s.x), round(up.y)];
      });
      out.scatter.push({
        biome: n.userData.biome,
        layer: n.userData.layer,
        model: n.userData.model,
        modelIndex: n.userData.modelIndex ?? null,
        count: im.count,
        declaredCount: n.userData.count ?? null,
        primitives: ims.length,
        triangles: ims.reduce((a, m) => a + trianglesOf(m.geometry), 0),
        meshMinY: round(minY, 3),
        meshMaxY: round(maxY, 3),
        minUpY: round(minUpY),
        samples,
      });
    } else if (kind === 'road') {
      const mesh = meshesOf(n)[0];
      if (!mesh) return;
      out.roads.push({ id: n.userData.id ?? null, name: n.name, vertexCount: mesh.geometry.getAttribute('position').count, triangles: trianglesOf(mesh.geometry), upFacing: round(upFacingFraction(THREE, mesh)), bounds: boxOf(THREE, mesh), samples: vertexSamples(THREE, mesh, roadSamples) });
    }
  });
  out.sceneBounds = boxOf(THREE, root);
  return out;
}

/**
 * Reduce the number of drawn instances so the unculled, impostor-free viewer stays interactive:
 * keeps every k-th instance of every InstancedMesh. Returns the factor used (1 = untouched).
 * Call AFTER collectStats - this changes InstancedMesh.count.
 */
export function thinInstances(THREE, root, triangleBudget) {
  if (!triangleBudget || triangleBudget <= 0) return 1;
  let total = 0;
  const ims = [];
  root.traverse((n) => {
    if (n.isInstancedMesh) {
      ims.push(n);
      total += trianglesOf(n.geometry) * n.count;
    }
  });
  if (total <= triangleBudget) return 1;
  const k = Math.ceil(total / triangleBudget);
  const m = new THREE.Matrix4();
  for (const im of ims) {
    const keep = Math.max(1, Math.floor(im.count / k));
    for (let i = 0; i < keep; i++) {
      im.getMatrixAt(Math.min(im.count - 1, i * k + (k >> 1)), m);
      im.setMatrixAt(i, m);
    }
    im.count = keep;
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.computeBoundingBox();
  }
  return k;
}
