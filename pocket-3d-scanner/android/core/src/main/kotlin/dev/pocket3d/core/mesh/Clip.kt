package dev.pocket3d.core.mesh

import dev.pocket3d.core.math.Vec3
import kotlin.math.sqrt

/** Vertices closer to the clip plane than this fraction of the largest coordinate count as lying on it. */
private const val SNAP_EPSILON = 1e-6

internal fun clipByPlaneImpl(mesh: Mesh, point: Vec3, normal: Vec3): Mesh {
    var nx = normal.x.toDouble(); var ny = normal.y.toDouble(); var nz = normal.z.toDouble()
    val nl = sqrt(nx * nx + ny * ny + nz * nz)
    require(nl > 0.0 && nl.isFinite()) { "plane normal must be a non-zero finite vector" }
    nx /= nl; ny /= nl; nz /= nl
    val px = point.x.toDouble(); val py = point.y.toDouble(); val pz = point.z.toDouble()

    val vCount = mesh.vertexCount
    val fCount = mesh.faceCount
    val pos = mesh.positions
    val idx = mesh.indices
    // Signed distance per render vertex. It depends on the position only, so duplicated seam
    // vertices are always classified identically. Vertices within float noise of the plane are
    // snapped onto it; otherwise a plane through a row of vertices would shave off zero-area slivers.
    var scale = maxOf(Math.abs(px), Math.abs(py), Math.abs(pz))
    for (x in pos) { val a = Math.abs(x.toDouble()); if (a > scale) scale = a }
    val snap = SNAP_EPSILON * scale
    val dist = DoubleArray(vCount) {
        val d = (pos[3 * it] - px) * nx + (pos[3 * it + 1] - py) * ny + (pos[3 * it + 2] - pz) * nz
        if (Math.abs(d) <= snap) 0.0 else d
    }

    val srcN = mesh.normals; val srcUv = mesh.uvs; val srcC = mesh.confidence
    val newPos = FloatList(); val newN = FloatList(); val newUv = FloatList(); val newC = FloatList()
    var newCount = 0
    val cuts = LongIntMap(1024)

    // Vertex where the edge from kept vertex [a] to removed vertex [b] meets the plane. Always
    // computed from the kept end towards the removed end, so the two triangles sharing an edge
    // (and seam duplicates of that edge) get bit-identical positions.
    fun cut(a: Int, b: Int): Int {
        val da = dist[a]
        if (da == 0.0) return a
        val key = pairKey(a, b)
        val existing = cuts.get(key)
        if (existing >= 0) return existing
        val t = da / (da - dist[b])
        val x = (pos[3 * a] + t * (pos[3 * b] - pos[3 * a])).toFloat()
        val y = (pos[3 * a + 1] + t * (pos[3 * b + 1] - pos[3 * a + 1])).toFloat()
        val z = (pos[3 * a + 2] + t * (pos[3 * b + 2] - pos[3 * a + 2])).toFloat()
        if (x == pos[3 * a] && y == pos[3 * a + 1] && z == pos[3 * a + 2]) {
            // rounds onto the kept vertex: reuse it instead of creating a zero-length edge
            cuts.put(key, a)
            return a
        }
        val id = vCount + newCount++
        newPos.add(x); newPos.add(y); newPos.add(z)
        if (srcN != null) {
            val ax = srcN[3 * a].toDouble(); val ay = srcN[3 * a + 1].toDouble(); val az = srcN[3 * a + 2].toDouble()
            var ix = ax + t * (srcN[3 * b] - ax); var iy = ay + t * (srcN[3 * b + 1] - ay); var iz = az + t * (srcN[3 * b + 2] - az)
            val l = sqrt(ix * ix + iy * iy + iz * iz)
            if (l > 1e-12) { ix /= l; iy /= l; iz /= l } else { ix = ax; iy = ay; iz = az }
            newN.add(ix.toFloat()); newN.add(iy.toFloat()); newN.add(iz.toFloat())
        }
        if (srcUv != null) {
            newUv.add((srcUv[2 * a] + t * (srcUv[2 * b] - srcUv[2 * a])).toFloat())
            newUv.add((srcUv[2 * a + 1] + t * (srcUv[2 * b + 1] - srcUv[2 * a + 1])).toFloat())
        }
        if (srcC != null) newC.add((srcC[a] + t * (srcC[b] - srcC[a])).toFloat())
        cuts.put(key, id)
        return id
    }

    val outIdx = IntList(idx.size)
    val outMat = if (mesh.faceMaterial != null) IntList(fCount) else null
    fun emit(a: Int, b: Int, c: Int, f: Int) {
        if (a == b || b == c || a == c) return
        outIdx.add(a); outIdx.add(b); outIdx.add(c)
        outMat?.add(mesh.faceMaterial!![f])
    }

    for (f in 0 until fCount) {
        val i0 = idx[3 * f]; val i1 = idx[3 * f + 1]; val i2 = idx[3 * f + 2]
        val in0 = dist[i0] >= 0.0; val in1 = dist[i1] >= 0.0; val in2 = dist[i2] >= 0.0
        val n = (if (in0) 1 else 0) + (if (in1) 1 else 0) + (if (in2) 1 else 0)
        if (n == 0) continue
        if (n == 3) { emit(i0, i1, i2, f); continue }
        // rotate so that the cyclic order (a, b, c) is preserved
        val a: Int; val b: Int; val c: Int
        if (n == 1) {
            // a is the single kept vertex
            if (in0) { a = i0; b = i1; c = i2 } else if (in1) { a = i1; b = i2; c = i0 } else { a = i2; b = i0; c = i1 }
            emit(a, cut(a, b), cut(a, c), f)
        } else {
            // c is the single removed vertex
            if (!in0) { a = i1; b = i2; c = i0 } else if (!in1) { a = i2; b = i0; c = i1 } else { a = i0; b = i1; c = i2 }
            val bc = cut(b, c)
            val ac = cut(a, c)
            emit(a, b, bc, f)
            emit(a, bc, ac, f)
        }
    }

    val total = vCount + newCount
    val positions = FloatArray(3 * total)
    System.arraycopy(pos, 0, positions, 0, pos.size)
    System.arraycopy(newPos.data, 0, positions, pos.size, 3 * newCount)
    val normals = srcN?.let { FloatArray(3 * total).also { o -> System.arraycopy(it, 0, o, 0, it.size); System.arraycopy(newN.data, 0, o, it.size, 3 * newCount) } }
    val uvs = srcUv?.let { FloatArray(2 * total).also { o -> System.arraycopy(it, 0, o, 0, it.size); System.arraycopy(newUv.data, 0, o, it.size, 2 * newCount) } }
    val conf = srcC?.let { FloatArray(total).also { o -> System.arraycopy(it, 0, o, 0, it.size); System.arraycopy(newC.data, 0, o, it.size, newCount) } }
    val combined = Mesh(positions, normals, uvs, conf, outIdx.toArray(), outMat?.toArray(), mesh.materials)
    return subMesh(combined, null)
}

internal fun cropToBoxImpl(mesh: Mesh, box: OrientedBox, keepInside: Boolean, clip: Boolean): Mesh {
    require(box.halfExtents.x >= 0f && box.halfExtents.y >= 0f && box.halfExtents.z >= 0f) { "halfExtents must be >= 0" }
    if (keepInside && clip) {
        var m = mesh
        for (i in 0 until 3) {
            val axis = box.axis(i)
            val h = box.halfExtents[i]
            m = clipByPlaneImpl(m, box.center + axis * h, -axis)
            m = clipByPlaneImpl(m, box.center - axis * h, axis)
        }
        return m
    }
    val pos = mesh.positions; val idx = mesh.indices
    val keep = BooleanArray(mesh.faceCount) { f ->
        val a = idx[3 * f] * 3; val b = idx[3 * f + 1] * 3; val c = idx[3 * f + 2] * 3
        val centroid = Vec3(
            (pos[a] + pos[b] + pos[c]) / 3f,
            (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3f,
            (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3f,
        )
        box.contains(centroid) == keepInside
    }
    return subMesh(mesh, keep)
}
