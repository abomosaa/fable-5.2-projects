package dev.pocket3d.core.mesh

import dev.pocket3d.core.math.Vec3
import kotlin.math.abs
import kotlin.math.sqrt

// Internal building blocks shared by the MeshOps implementations.

/** Area of face [f] in double precision. */
internal fun faceArea(pos: FloatArray, idx: IntArray, f: Int): Double {
    val i0 = idx[3 * f] * 3; val i1 = idx[3 * f + 1] * 3; val i2 = idx[3 * f + 2] * 3
    val ax = pos[i0].toDouble(); val ay = pos[i0 + 1].toDouble(); val az = pos[i0 + 2].toDouble()
    val e1x = pos[i1] - ax; val e1y = pos[i1 + 1] - ay; val e1z = pos[i1 + 2] - az
    val e2x = pos[i2] - ax; val e2y = pos[i2 + 1] - ay; val e2z = pos[i2 + 2] - az
    val nx = e1y * e2z - e1z * e2y; val ny = e1z * e2x - e1x * e2z; val nz = e1x * e2y - e1y * e2x
    return 0.5 * sqrt(nx * nx + ny * ny + nz * nz)
}

internal fun totalArea(mesh: Mesh): Double {
    var a = 0.0
    for (f in 0 until mesh.faceCount) a += faceArea(mesh.positions, mesh.indices, f)
    return a
}

/**
 * New mesh with only the faces where `keep[f]` is true (all faces if [keep] is null), dropping
 * vertices no kept face references and materials no kept face uses. Relative order of vertices,
 * faces and materials is preserved. Always allocates fresh arrays.
 */
internal fun subMesh(mesh: Mesh, keep: BooleanArray?): Mesh {
    val fCount = mesh.faceCount
    val vCount = mesh.vertexCount
    require(keep == null || keep.size == fCount) { "face mask size ${keep?.size} != face count $fCount" }
    val idx = mesh.indices
    val used = BooleanArray(vCount)
    val matCount = mesh.materials.size
    val matUsed = BooleanArray(matCount)
    var kept = 0
    for (f in 0 until fCount) {
        if (keep != null && !keep[f]) continue
        kept++
        used[idx[3 * f]] = true; used[idx[3 * f + 1]] = true; used[idx[3 * f + 2]] = true
        val m = mesh.materialOfFace(f)
        if (m in 0 until matCount) matUsed[m] = true
    }
    val remap = IntArray(vCount)
    var nv = 0
    for (v in 0 until vCount) remap[v] = if (used[v]) nv++ else -1
    val matRemap = IntArray(matCount)
    val newMaterials = ArrayList<Material>()
    for (m in 0 until matCount) {
        matRemap[m] = if (matUsed[m]) newMaterials.size else -1
        if (matUsed[m]) newMaterials.add(mesh.materials[m])
    }

    val positions = FloatArray(3 * nv)
    val normals = mesh.normals?.let { FloatArray(3 * nv) }
    val uvs = mesh.uvs?.let { FloatArray(2 * nv) }
    val conf = mesh.confidence?.let { FloatArray(nv) }
    for (v in 0 until vCount) {
        val n = remap[v]
        if (n < 0) continue
        positions[3 * n] = mesh.positions[3 * v]
        positions[3 * n + 1] = mesh.positions[3 * v + 1]
        positions[3 * n + 2] = mesh.positions[3 * v + 2]
        if (normals != null) {
            normals[3 * n] = mesh.normals!![3 * v]
            normals[3 * n + 1] = mesh.normals[3 * v + 1]
            normals[3 * n + 2] = mesh.normals[3 * v + 2]
        }
        if (uvs != null) {
            uvs[2 * n] = mesh.uvs!![2 * v]
            uvs[2 * n + 1] = mesh.uvs[2 * v + 1]
        }
        if (conf != null) conf[n] = mesh.confidence!![v]
    }
    val indices = IntArray(3 * kept)
    val faceMaterial = mesh.faceMaterial?.let { IntArray(kept) }
    var o = 0
    for (f in 0 until fCount) {
        if (keep != null && !keep[f]) continue
        indices[3 * o] = remap[idx[3 * f]]
        indices[3 * o + 1] = remap[idx[3 * f + 1]]
        indices[3 * o + 2] = remap[idx[3 * f + 2]]
        if (faceMaterial != null) {
            val m = mesh.faceMaterial!![f]
            faceMaterial[o] = if (m in 0 until matCount) matRemap[m] else 0
        }
        o++
    }
    return Mesh(positions, normals, uvs, conf, indices, faceMaterial, newMaterials)
}

/** Default crease angle (60 degrees) for normal smoothing across duplicated vertices. */
internal const val DEFAULT_COS_CREASE = 0.5

/**
 * Area-weighted unit vertex normals, smoothed over welded positions so that the render vertices
 * of a UV seam get the same normal.
 *
 * A render vertex always averages the faces that use it. Faces that only touch it through
 * another render vertex at the same position (the other side of a seam, or a repair patch with
 * its own rim vertices) are included only if their normal is within the crease angle
 * (`acos(cosCrease)`) of *every* face using the vertex itself. On a smooth surface every face
 * passes and seam duplicates get bit-identical normals; across a sharp crease (e.g. between the
 * wall of a cut-open object and the cap that closes it) each side keeps its own normal instead
 * of a blend that could face away from the faces it shades. Consequently such faces can never
 * pull a normal more than the crease angle away from any face of the vertex, however large
 * they are.
 *
 * Vertices without any non-degenerate face get (0, 1, 0).
 */
internal fun computeWeldedNormals(
    positions: FloatArray,
    indices: IntArray,
    weldOf: IntArray,
    weldedCount: Int,
    cosCrease: Double = DEFAULT_COS_CREASE,
): FloatArray {
    val fCount = indices.size / 3
    val vCount = positions.size / 3
    val fn = DoubleArray(3 * fCount)   // area-weighted face normals
    val own = DoubleArray(3 * vCount)  // sum over the faces using each render vertex
    val start = IntArray(weldedCount + 1)
    for (f in 0 until fCount) {
        val a = indices[3 * f]; val b = indices[3 * f + 1]; val c = indices[3 * f + 2]
        val ax = positions[3 * a].toDouble(); val ay = positions[3 * a + 1].toDouble(); val az = positions[3 * a + 2].toDouble()
        val e1x = positions[3 * b] - ax; val e1y = positions[3 * b + 1] - ay; val e1z = positions[3 * b + 2] - az
        val e2x = positions[3 * c] - ax; val e2y = positions[3 * c + 1] - ay; val e2z = positions[3 * c + 2] - az
        val nx = e1y * e2z - e1z * e2y; val ny = e1z * e2x - e1x * e2z; val nz = e1x * e2y - e1y * e2x
        if (nx.isFinite() && ny.isFinite() && nz.isFinite()) {
            fn[3 * f] = nx; fn[3 * f + 1] = ny; fn[3 * f + 2] = nz
            own[3 * a] += nx; own[3 * a + 1] += ny; own[3 * a + 2] += nz
            own[3 * b] += nx; own[3 * b + 1] += ny; own[3 * b + 2] += nz
            own[3 * c] += nx; own[3 * c + 1] += ny; own[3 * c + 2] += nz
        }
        start[weldOf[a] + 1]++; start[weldOf[b] + 1]++; start[weldOf[c] + 1]++
    }
    for (w in 0 until weldedCount) start[w + 1] += start[w]
    val fill = start.copyOf(weldedCount)
    val corners = IntArray(3 * fCount) // face corners grouped by welded vertex, ascending within a group
    for (c in 0 until 3 * fCount) corners[fill[weldOf[indices[c]]]++] = c

    val out = FloatArray(positions.size)
    val done = BooleanArray(vCount)
    fun store(v: Int, x: Double, y: Double, z: Double): Boolean {
        val l = sqrt(x * x + y * y + z * z)
        if (!(l > 1e-300) || l.isInfinite()) return false
        out[3 * v] = (x / l).toFloat(); out[3 * v + 1] = (y / l).toFloat(); out[3 * v + 2] = (z / l).toFloat()
        return true
    }
    /** Sum of the face normals around welded vertex [w] that render vertex [r] should see (r < 0: all). */
    fun gather(w: Int, r: Int, sum: DoubleArray) {
        sum[0] = 0.0; sum[1] = 0.0; sum[2] = 0.0
        val s = start[w]; val e = start[w + 1]
        for (i in s until e) {
            val c = corners[i]
            val f = 3 * (c / 3)
            val nx = fn[f]; val ny = fn[f + 1]; val nz = fn[f + 2]
            if (r >= 0 && indices[c] != r) {
                // a face of another render vertex: it must be within the crease angle of every own face
                val nl = sqrt(nx * nx + ny * ny + nz * nz)
                var compatible = true
                for (j in s until e) {
                    val cj = corners[j]
                    if (indices[cj] != r) continue
                    val g = 3 * (cj / 3)
                    val gx = fn[g]; val gy = fn[g + 1]; val gz = fn[g + 2]
                    val gl = sqrt(gx * gx + gy * gy + gz * gz)
                    if (gl > 0.0 && !(nx * gx + ny * gy + nz * gz > cosCrease * nl * gl)) { compatible = false; break }
                }
                if (!compatible) continue
            }
            sum[0] += nx; sum[1] += ny; sum[2] += nz
        }
    }
    val sum = DoubleArray(3)
    for (w in 0 until weldedCount) {
        val s = start[w]; val e = start[w + 1]
        if (s == e) continue
        val first = indices[corners[s]]
        var single = true
        for (i in s + 1 until e) if (indices[corners[i]] != first) { single = false; break }
        if (single) {
            done[first] = true
            if (!store(first, own[3 * first], own[3 * first + 1], own[3 * first + 2])) out[3 * first + 1] = 1f
            continue
        }
        for (i in s until e) {
            val r = indices[corners[i]]
            if (done[r]) continue
            done[r] = true
            gather(w, r, sum)
            if (!store(r, sum[0], sum[1], sum[2]) && !store(r, own[3 * r], own[3 * r + 1], own[3 * r + 2])) out[3 * r + 1] = 1f
        }
    }
    // vertices no face uses: the smooth normal of their position if there is one
    for (v in 0 until vCount) {
        if (done[v]) continue
        gather(weldOf[v], -1, sum)
        if (!store(v, sum[0], sum[1], sum[2])) out[3 * v + 1] = 1f
    }
    return out
}

internal fun transformImpl(mesh: Mesh, m: FloatArray): Mesh {
    require(m.size == 16) { "matrix must have 16 elements (column-major 4x4)" }
    for (x in m) require(x.isFinite()) { "matrix contains a non-finite element" }
    val m00 = m[0].toDouble(); val m10 = m[1].toDouble(); val m20 = m[2].toDouble()
    val m01 = m[4].toDouble(); val m11 = m[5].toDouble(); val m21 = m[6].toDouble()
    val m02 = m[8].toDouble(); val m12 = m[9].toDouble(); val m22 = m[10].toDouble()
    val tx = m[12].toDouble(); val ty = m[13].toDouble(); val tz = m[14].toDouble()
    // cofactors of the upper 3x3 (cof = det * inverse-transpose)
    val c00 = m11 * m22 - m12 * m21; val c01 = m12 * m20 - m10 * m22; val c02 = m10 * m21 - m11 * m20
    val c10 = m02 * m21 - m01 * m22; val c11 = m00 * m22 - m02 * m20; val c12 = m01 * m20 - m00 * m21
    val c20 = m01 * m12 - m02 * m11; val c21 = m02 * m10 - m00 * m12; val c22 = m00 * m11 - m01 * m10
    val det = m00 * c00 + m01 * c01 + m02 * c02
    require(det != 0.0) { "matrix is singular (determinant 0); it cannot be applied to a mesh" }

    val vCount = mesh.vertexCount
    val src = mesh.positions
    val positions = FloatArray(src.size)
    for (v in 0 until vCount) {
        val x = src[3 * v].toDouble(); val y = src[3 * v + 1].toDouble(); val z = src[3 * v + 2].toDouble()
        positions[3 * v] = (m00 * x + m01 * y + m02 * z + tx).toFloat()
        positions[3 * v + 1] = (m10 * x + m11 * y + m12 * z + ty).toFloat()
        positions[3 * v + 2] = (m20 * x + m21 * y + m22 * z + tz).toFloat()
    }
    var normals: FloatArray? = null
    val sn = mesh.normals
    if (sn != null) {
        normals = FloatArray(sn.size)
        // Fast path: the 3x3 part is s * Q with Q orthogonal (rotation or reflection). Then the
        // inverse-transpose is Q / s, i.e. normals transform like directions (then renormalise).
        val l0 = m00 * m00 + m10 * m10 + m20 * m20
        val l1 = m01 * m01 + m11 * m11 + m21 * m21
        val l2 = m02 * m02 + m12 * m12 + m22 * m22
        val d01 = m00 * m01 + m10 * m11 + m20 * m21
        val d02 = m00 * m02 + m10 * m12 + m20 * m22
        val d12 = m01 * m02 + m11 * m12 + m21 * m22
        val tol = 1e-6 * l0
        val uniform = abs(l0 - l1) <= tol && abs(l0 - l2) <= tol && abs(d01) <= tol && abs(d02) <= tol && abs(d12) <= tol
        // general path: n' = cof * n * sign(det)
        val s = if (det < 0) -1.0 else 1.0
        val n00 = if (uniform) m00 else c00 * s; val n01 = if (uniform) m01 else c01 * s; val n02 = if (uniform) m02 else c02 * s
        val n10 = if (uniform) m10 else c10 * s; val n11 = if (uniform) m11 else c11 * s; val n12 = if (uniform) m12 else c12 * s
        val n20 = if (uniform) m20 else c20 * s; val n21 = if (uniform) m21 else c21 * s; val n22 = if (uniform) m22 else c22 * s
        for (v in 0 until vCount) {
            val x = sn[3 * v].toDouble(); val y = sn[3 * v + 1].toDouble(); val z = sn[3 * v + 2].toDouble()
            val nx = n00 * x + n01 * y + n02 * z
            val ny = n10 * x + n11 * y + n12 * z
            val nz = n20 * x + n21 * y + n22 * z
            val l = sqrt(nx * nx + ny * ny + nz * nz)
            if (l > 0.0 && !l.isInfinite()) {
                normals[3 * v] = (nx / l).toFloat(); normals[3 * v + 1] = (ny / l).toFloat(); normals[3 * v + 2] = (nz / l).toFloat()
            }
        }
    }
    val indices = if (det < 0) {
        val src2 = mesh.indices
        IntArray(src2.size).also { out ->
            var i = 0
            while (i < src2.size) { out[i] = src2[i]; out[i + 1] = src2[i + 2]; out[i + 2] = src2[i + 1]; i += 3 }
        }
    } else mesh.indices
    return Mesh(positions, normals, mesh.uvs, mesh.confidence, indices, mesh.faceMaterial, mesh.materials)
}

/** Signed volume enclosed by the mesh (positive for a closed mesh with outward counter-clockwise faces). */
internal fun signedVolumeImpl(mesh: Mesh): Double {
    val p = mesh.positions; val idx = mesh.indices
    if (mesh.vertexCount == 0) return 0.0
    // integrate relative to the first vertex to reduce cancellation
    val ox = p[0].toDouble(); val oy = p[1].toDouble(); val oz = p[2].toDouble()
    var vol = 0.0
    for (f in 0 until mesh.faceCount) {
        val a = idx[3 * f] * 3; val b = idx[3 * f + 1] * 3; val c = idx[3 * f + 2] * 3
        val ax = p[a] - ox; val ay = p[a + 1] - oy; val az = p[a + 2] - oz
        val bx = p[b] - ox; val by = p[b + 1] - oy; val bz = p[b + 2] - oz
        val cx = p[c] - ox; val cy = p[c + 1] - oy; val cz = p[c + 2] - oz
        vol += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)
    }
    return vol / 6.0
}

internal fun componentsImpl(mesh: Mesh, topo: MeshTopology): ComponentInfo {
    val fc = topo.faceComponents()
    val n = fc.count
    val area = DoubleArray(n)
    val counts = IntArray(n)
    val mins = FloatArray(3 * n) { Float.POSITIVE_INFINITY }
    val maxs = FloatArray(3 * n) { Float.NEGATIVE_INFINITY }
    val pos = mesh.positions; val idx = mesh.indices
    for (f in 0 until mesh.faceCount) {
        val c = fc.faceComponent[f]
        counts[c]++
        area[c] += faceArea(pos, idx, f)
        for (k in 0 until 3) {
            val v = idx[3 * f + k] * 3
            for (a in 0 until 3) {
                val x = pos[v + a]
                if (x < mins[3 * c + a]) mins[3 * c + a] = x
                if (x > maxs[3 * c + a]) maxs[3 * c + a] = x
            }
        }
    }
    // sort by area descending; ties keep the order of lowest face index (stable sort)
    val order = (0 until n).sortedWith { a, b -> area[b].compareTo(area[a]) }
    val newId = IntArray(n)
    val list = ArrayList<Component>(n)
    for ((rank, c) in order.withIndex()) {
        newId[c] = rank
        list.add(
            Component(
                rank, counts[c], area[c].toFloat(),
                Aabb(Vec3(mins[3 * c], mins[3 * c + 1], mins[3 * c + 2]), Vec3(maxs[3 * c], maxs[3 * c + 1], maxs[3 * c + 2])),
            ),
        )
    }
    val faceComponent = IntArray(mesh.faceCount) { newId[fc.faceComponent[it]] }
    return ComponentInfo(faceComponent, list)
}

internal fun statsImpl(mesh: Mesh, threshold: Float): MeshStats {
    val topo = MeshTopology.build(mesh)
    val pos = mesh.positions; val idx = mesh.indices
    var area = 0.0
    var lowArea = 0.0
    var repairedArea = 0.0
    val conf = mesh.confidence
    val t = threshold.toDouble()
    for (f in 0 until mesh.faceCount) {
        val a = faceArea(pos, idx, f)
        area += a
        val m = mesh.materialOfFace(f)
        if (m in mesh.materials.indices && mesh.materials[m].repaired) repairedArea += a
        if (conf != null) {
            // exact fraction of the triangle where the linearly interpolated confidence is < t
            var c0 = conf[idx[3 * f]].toDouble(); var c1 = conf[idx[3 * f + 1]].toDouble(); var c2 = conf[idx[3 * f + 2]].toDouble()
            if (c0 > c1) { val s = c0; c0 = c1; c1 = s }
            if (c1 > c2) { val s = c1; c1 = c2; c2 = s }
            if (c0 > c1) { val s = c0; c0 = c1; c1 = s }
            val frac = when {
                t <= c0 -> 0.0
                t > c2 -> 1.0
                t <= c1 -> (t - c0) * (t - c0) / ((c1 - c0) * (c2 - c0))
                c2 > c1 -> 1.0 - (c2 - t) * (c2 - t) / ((c2 - c1) * (c2 - c0))
                else -> 1.0
            }
            lowArea += a * frac
        }
    }
    val lengths = FloatArray(topo.edgeCount)
    var sum = 0.0
    for (e in 0 until topo.edgeCount) {
        val a = topo.weldedRepresentative[topo.edgeV0[e]] * 3
        val b = topo.weldedRepresentative[topo.edgeV1[e]] * 3
        val dx = (pos[a] - pos[b]).toDouble(); val dy = (pos[a + 1] - pos[b + 1]).toDouble(); val dz = (pos[a + 2] - pos[b + 2]).toDouble()
        val l = sqrt(dx * dx + dy * dy + dz * dz)
        lengths[e] = l.toFloat()
        sum += l
    }
    lengths.sort()
    val median = when {
        lengths.isEmpty() -> 0f
        lengths.size % 2 == 1 -> lengths[lengths.size / 2]
        else -> (lengths[lengths.size / 2 - 1] + lengths[lengths.size / 2]) * 0.5f
    }
    return MeshStats(
        vertexCount = mesh.vertexCount,
        faceCount = mesh.faceCount,
        weldedVertexCount = topo.weldedCount,
        surfaceArea = area.toFloat(),
        bounds = Aabb.of(pos),
        meanEdgeLength = if (lengths.isEmpty()) 0f else (sum / lengths.size).toFloat(),
        medianEdgeLength = median,
        boundaryEdgeCount = topo.boundaryEdgeCount,
        holeCount = topo.boundaryLoopHalfEdges().size,
        nonManifoldEdgeCount = topo.nonManifoldEdgeCount,
        componentCount = topo.faceComponents().count,
        lowConfidenceThreshold = threshold,
        lowConfidenceAreaFraction = if (conf == null) null else if (area > 0) (lowArea / area).toFloat() else 0f,
        repairedAreaFraction = if (area > 0) (repairedArea / area).toFloat() else 0f,
    )
}
