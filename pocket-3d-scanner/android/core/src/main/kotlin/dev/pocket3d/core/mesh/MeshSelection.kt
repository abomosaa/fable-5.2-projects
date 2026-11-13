package dev.pocket3d.core.mesh

import dev.pocket3d.core.math.Ray
import dev.pocket3d.core.math.Vec3
import kotlin.math.sqrt

/**
 * Face selection helpers for the editor (lasso, brush, "select connected"). Selections are
 * `BooleanArray`s with one entry per face, directly usable with [MeshOps.removeFaces] /
 * [MeshOps.keepFaces].
 */
object MeshSelection {
    /**
     * Faces whose centroid projects inside a screen-space polygon (lasso / rectangle select).
     *
     * @param bvh BVH of [mesh]; only used when [visibleOnly] is true.
     * @param viewProj column-major 4x4 `projection * view` matrix (model space -> clip space).
     * @param polygonNdc polygon corners as x, y pairs in normalised device coordinates (-1..1,
     *   +y up); implicitly closed. Self-intersecting polygons use the even-odd rule.
     * @param cameraPos camera position in model space (used for the occlusion test).
     * @param visibleOnly select only faces whose centroid is not hidden behind other geometry as
     *   seen from [cameraPos]. Back-facing faces count as visible when nothing is in front of them,
     *   matching the double-sided rendering of scans.
     *
     * Faces whose centroid is behind the camera (clip w <= 0) are never selected. The near/far
     * planes are not applied.
     */
    fun facesInScreenPolygon(
        mesh: Mesh,
        bvh: Bvh,
        viewProj: FloatArray,
        polygonNdc: FloatArray,
        cameraPos: Vec3,
        visibleOnly: Boolean,
    ): BooleanArray {
        require(viewProj.size == 16) { "viewProj must have 16 elements" }
        require(polygonNdc.size % 2 == 0) { "polygonNdc must contain x, y pairs" }
        val fCount = mesh.faceCount
        val out = BooleanArray(fCount)
        val n = polygonNdc.size / 2
        if (n < 3) return out
        var minX = Float.POSITIVE_INFINITY; var minY = minX
        var maxX = Float.NEGATIVE_INFINITY; var maxY = maxX
        for (i in 0 until n) {
            val x = polygonNdc[2 * i]; val y = polygonNdc[2 * i + 1]
            if (x < minX) minX = x; if (x > maxX) maxX = x
            if (y < minY) minY = y; if (y > maxY) maxY = y
        }
        val pos = mesh.positions; val idx = mesh.indices
        val m = viewProj
        val sceneDiagonal = if (visibleOnly) Aabb.of(pos).diagonal else 0f
        for (f in 0 until fCount) {
            val a = idx[3 * f] * 3; val b = idx[3 * f + 1] * 3; val c = idx[3 * f + 2] * 3
            val cx = (pos[a] + pos[b] + pos[c]) / 3f
            val cy = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3f
            val cz = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3f
            val w = m[3] * cx + m[7] * cy + m[11] * cz + m[15]
            if (!(w > 0f)) continue
            val x = (m[0] * cx + m[4] * cy + m[8] * cz + m[12]) / w
            val y = (m[1] * cx + m[5] * cy + m[9] * cz + m[13]) / w
            if (!(x >= minX && x <= maxX && y >= minY && y <= maxY)) continue
            // even-odd point in polygon
            var inside = false
            var j = n - 1
            for (i in 0 until n) {
                val xi = polygonNdc[2 * i]; val yi = polygonNdc[2 * i + 1]
                val xj = polygonNdc[2 * j]; val yj = polygonNdc[2 * j + 1]
                if ((yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside
                j = i
            }
            if (!inside) continue
            if (visibleOnly) {
                val dx = cx - cameraPos.x; val dy = cy - cameraPos.y; val dz = cz - cameraPos.z
                val d = sqrt(dx * dx + dy * dy + dz * dz)
                if (d > 0f) {
                    // stop just short of the face itself
                    val eps = maxOf(1e-3f * d, 1e-5f * sceneDiagonal)
                    val ray = Ray(cameraPos, Vec3(dx / d, dy / d, dz / d))
                    if (d > eps && bvh.anyHit(ray, d - eps)) continue
                }
            }
            out[f] = true
        }
        return out
    }

    /**
     * Faces touching the ball around [center] with [radius] (brush selection): a face is selected
     * when any point of the triangle is within [radius] of [center].
     */
    fun facesInSphere(mesh: Mesh, center: Vec3, radius: Float): BooleanArray {
        val fCount = mesh.faceCount
        val out = BooleanArray(fCount)
        if (!(radius >= 0f)) return out
        val pos = mesh.positions; val idx = mesh.indices
        val px = center.x.toDouble(); val py = center.y.toDouble(); val pz = center.z.toDouble()
        val r2 = radius.toDouble() * radius
        for (f in 0 until fCount) {
            val i0 = idx[3 * f] * 3; val i1 = idx[3 * f + 1] * 3; val i2 = idx[3 * f + 2] * 3
            // bounding box reject
            val lx = minOf(pos[i0], pos[i1], pos[i2]); val hx = maxOf(pos[i0], pos[i1], pos[i2])
            if (lx - radius > center.x || hx + radius < center.x) continue
            val ly = minOf(pos[i0 + 1], pos[i1 + 1], pos[i2 + 1]); val hy = maxOf(pos[i0 + 1], pos[i1 + 1], pos[i2 + 1])
            if (ly - radius > center.y || hy + radius < center.y) continue
            val lz = minOf(pos[i0 + 2], pos[i1 + 2], pos[i2 + 2]); val hz = maxOf(pos[i0 + 2], pos[i1 + 2], pos[i2 + 2])
            if (lz - radius > center.z || hz + radius < center.z) continue
            if (pointTriangleDist2(px, py, pz, pos, i0, i1, i2) <= r2) out[f] = true
        }
        return out
    }

    /**
     * Extend [selection] to every face connected (through shared edges of the welded topology) to
     * an already selected face, i.e. select whole connected components.
     * @param topology optional prebuilt topology of [mesh].
     */
    fun growSelectionToComponent(mesh: Mesh, selection: BooleanArray, topology: MeshTopology? = null): BooleanArray {
        require(selection.size == mesh.faceCount) { "selection size ${selection.size} != face count ${mesh.faceCount}" }
        val topo = topology ?: MeshTopology.build(mesh)
        require(topo.faceCount == mesh.faceCount) { "topology does not belong to this mesh" }
        val comps = topo.faceComponents()
        val hit = BooleanArray(comps.count)
        for (f in selection.indices) if (selection[f]) hit[comps.faceComponent[f]] = true
        return BooleanArray(selection.size) { hit[comps.faceComponent[it]] }
    }

    /** Number of selected faces. */
    fun count(selection: BooleanArray): Int {
        var n = 0
        for (s in selection) if (s) n++
        return n
    }

    private fun pointTriangleDist2(px: Double, py: Double, pz: Double, pos: FloatArray, i0: Int, i1: Int, i2: Int): Double {
        val ax = pos[i0].toDouble(); val ay = pos[i0 + 1].toDouble(); val az = pos[i0 + 2].toDouble()
        val abx = pos[i1] - ax; val aby = pos[i1 + 1] - ay; val abz = pos[i1 + 2] - az
        val acx = pos[i2] - ax; val acy = pos[i2 + 1] - ay; val acz = pos[i2 + 2] - az
        val apx = px - ax; val apy = py - ay; val apz = pz - az
        val d1 = abx * apx + aby * apy + abz * apz
        val d2 = acx * apx + acy * apy + acz * apz
        var v: Double; var w: Double
        run {
            if (d1 <= 0.0 && d2 <= 0.0) { v = 0.0; w = 0.0; return@run }
            val bpx = apx - abx; val bpy = apy - aby; val bpz = apz - abz
            val d3 = abx * bpx + aby * bpy + abz * bpz
            val d4 = acx * bpx + acy * bpy + acz * bpz
            if (d3 >= 0.0 && d4 <= d3) { v = 1.0; w = 0.0; return@run }
            val vc = d1 * d4 - d3 * d2
            if (vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0) { v = d1 / (d1 - d3); w = 0.0; return@run }
            val cpx = apx - acx; val cpy = apy - acy; val cpz = apz - acz
            val d5 = abx * cpx + aby * cpy + abz * cpz
            val d6 = acx * cpx + acy * cpy + acz * cpz
            if (d6 >= 0.0 && d5 <= d6) { v = 0.0; w = 1.0; return@run }
            val vb = d5 * d2 - d1 * d6
            if (vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0) { v = 0.0; w = d2 / (d2 - d6); return@run }
            val va = d3 * d6 - d5 * d4
            if (va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0) { w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); v = 1.0 - w; return@run }
            val denom = 1.0 / (va + vb + vc)
            v = vb * denom; w = vc * denom
        }
        val cx = abx * v + acx * w - apx; val cy = aby * v + acy * w - apy; val cz = abz * v + acz * w - apz
        return cx * cx + cy * cy + cz * cz
    }
}
