package dev.pocket3d.core.mesh

import dev.pocket3d.core.math.Vec3
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.roundToInt
import kotlin.math.sqrt

internal fun findHolesImpl(mesh: Mesh, topo: MeshTopology): List<Hole> {
    val pos = mesh.positions
    val idx = mesh.indices
    val raw = ArrayList<Hole>()
    for (loop in topo.boundaryLoopHalfEdges()) {
        val n = loop.size
        val verts = FloatArray(3 * n)
        for (i in 0 until n) {
            val v = idx[loop[i]] * 3
            verts[3 * i] = pos[v]; verts[3 * i + 1] = pos[v + 1]; verts[3 * i + 2] = pos[v + 2]
        }
        val g = LoopGeometry(DoubleArray(3 * n) { verts[it].toDouble() }, n)
        // The loop runs with the surface on its left, so its own (Newell) normal points to the back
        // side; a patch continuing the surface faces the opposite way.
        val normal = if (g.area > 0.0) Vec3((-g.nx / g.area).toFloat(), (-g.ny / g.area).toFloat(), (-g.nz / g.area).toFloat()) else Vec3.ZERO
        raw.add(
            Hole(
                index = -1, vertices = verts, edgeCount = n, perimeter = g.perimeter.toFloat(),
                centroid = Vec3(g.cx.toFloat(), g.cy.toFloat(), g.cz.toFloat()),
                area = g.area.toFloat(), normal = normal, halfEdges = loop,
            ),
        )
    }
    // longest perimeter first; stable, so ties keep the deterministic loop order
    val sorted = raw.sortedWith { a, b -> b.perimeter.compareTo(a.perimeter) }
    return sorted.mapIndexed { i, h -> Hole(i, h.vertices, h.edgeCount, h.perimeter, h.centroid, h.area, h.normal, h.halfEdges) }
}

/** Perimeter, length-weighted centroid and vector area (Newell) of a closed 3D polyline. */
private class LoopGeometry(q: DoubleArray, n: Int) {
    val perimeter: Double
    val cx: Double; val cy: Double; val cz: Double
    /** Vector area; its length is [area], its direction the normal for which the loop is counter-clockwise. */
    val nx: Double; val ny: Double; val nz: Double
    val area: Double

    init {
        var per = 0.0; var sx = 0.0; var sy = 0.0; var sz = 0.0
        for (i in 0 until n) {
            val j = if (i + 1 == n) 0 else i + 1
            val dx = q[3 * j] - q[3 * i]; val dy = q[3 * j + 1] - q[3 * i + 1]; val dz = q[3 * j + 2] - q[3 * i + 2]
            val l = sqrt(dx * dx + dy * dy + dz * dz)
            per += l
            sx += l * (q[3 * i] + q[3 * j]) * 0.5; sy += l * (q[3 * i + 1] + q[3 * j + 1]) * 0.5; sz += l * (q[3 * i + 2] + q[3 * j + 2]) * 0.5
        }
        perimeter = per
        if (per > 0.0) { cx = sx / per; cy = sy / per; cz = sz / per } else if (n > 0) { cx = q[0]; cy = q[1]; cz = q[2] } else { cx = 0.0; cy = 0.0; cz = 0.0 }
        var ax = 0.0; var ay = 0.0; var az = 0.0
        for (i in 0 until n) {
            val j = if (i + 1 == n) 0 else i + 1
            val px = q[3 * i] - cx; val py = q[3 * i + 1] - cy; val pz = q[3 * i + 2] - cz
            val rx = q[3 * j] - cx; val ry = q[3 * j + 1] - cy; val rz = q[3 * j + 2] - cz
            ax += py * rz - pz * ry; ay += pz * rx - px * rz; az += px * ry - py * rx
        }
        nx = ax * 0.5; ny = ay * 0.5; nz = az * 0.5
        area = sqrt(nx * nx + ny * ny + nz * nz)
    }
}

/** Triangulation of one loop: vertices 0 until n are the loop itself, n.. are [interior] points. */
private class Patch(val interior: DoubleArray, val tris: IntArray)

internal fun fillHolesImpl(mesh: Mesh, holeIndices: Set<Int>?, maxPerimeter: Float): HoleFillResult {
    val topo = MeshTopology.build(mesh)
    val holes = findHolesImpl(mesh, topo)
    val addPos = FloatList()
    val addIdx = IntList()
    var filled = 0
    var skipped = 0
    for (hole in holes) {
        if (holeIndices != null && hole.index !in holeIndices) continue
        if (!(hole.perimeter <= maxPerimeter)) continue
        val n = hole.edgeCount
        // a loop passing twice through the same point cannot be closed by one disc
        val ids = IntArray(n) { topo.faceWelded[hole.halfEdges[it]] }
        ids.sort()
        var pinched = false
        for (i in 1 until n) if (ids[i] == ids[i - 1]) { pinched = true; break }
        // fill polygon = loop reversed, so that the patch winds like the surrounding faces
        val q = DoubleArray(3 * n)
        for (i in 0 until n) {
            val s = n - 1 - i
            q[3 * i] = hole.vertices[3 * s].toDouble(); q[3 * i + 1] = hole.vertices[3 * s + 1].toDouble(); q[3 * i + 2] = hole.vertices[3 * s + 2].toDouble()
        }
        val patch = if (pinched) null else triangulateLoop(q, n)
        if (patch == null) { skipped++; continue }
        val base = addPos.size / 3
        for (i in 0 until 3 * n) addPos.add(q[i].toFloat())
        for (x in patch.interior) addPos.add(x.toFloat())
        for (t in patch.tris) addIdx.add(base + t)
        filled++
    }
    if (filled == 0) return HoleFillResult(mesh, 0, 0, skipped, -1)

    val vOld = mesh.vertexCount
    val fOld = mesh.faceCount
    val added = addPos.size / 3
    val addedFaces = addIdx.size / 3
    val positions = FloatArray(3 * (vOld + added))
    System.arraycopy(mesh.positions, 0, positions, 0, 3 * vOld)
    System.arraycopy(addPos.data, 0, positions, 3 * vOld, 3 * added)
    val indices = IntArray(3 * (fOld + addedFaces))
    System.arraycopy(mesh.indices, 0, indices, 0, 3 * fOld)
    for (i in 0 until addIdx.size) indices[3 * fOld + i] = addIdx[i] + vOld

    var normals: FloatArray? = null
    if (mesh.normals != null) {
        normals = FloatArray(3 * (vOld + added))
        System.arraycopy(mesh.normals, 0, normals, 0, 3 * vOld)
        // patch normals: area-weighted over the patch faces only
        val identity = IntArray(added) { it }
        val pn = computeWeldedNormals(addPos.toArray(), addIdx.toArray(), identity, added)
        System.arraycopy(pn, 0, normals, 3 * vOld, 3 * added)
    }
    val uvs = mesh.uvs?.let { it.copyOf(2 * (vOld + added)) }          // new vertices: (0, 0)
    val conf = mesh.confidence?.let { it.copyOf(vOld + added) }         // new vertices: 0

    val materials = ArrayList(mesh.materials)
    // Faces of a mesh without materials implicitly use material 0; give them a real one so that
    // the repaired material cannot become their material.
    if (materials.isEmpty()) materials.add(Material("default"))
    var rep = materials.indexOfFirst { it.repaired }
    if (rep < 0) {
        rep = materials.size
        materials.add(Material(MeshOps.REPAIRED_MATERIAL_NAME, null, floatArrayOf(0.5f, 0.5f, 0.5f, 1f), repaired = true))
    }
    val faceMaterial = IntArray(fOld + addedFaces)
    mesh.faceMaterial?.let { System.arraycopy(it, 0, faceMaterial, 0, fOld) }
    for (f in fOld until fOld + addedFaces) faceMaterial[f] = rep
    return HoleFillResult(Mesh(positions, normals, uvs, conf, indices, faceMaterial, materials), filled, addedFaces, skipped, rep)
}

private const val RING_GROWTH = 1.3
private const val MAX_EAR_CLIP_VERTICES = 20000

/**
 * Triangulate the closed polygon [q] (xyz, [n] vertices, counter-clockwise around the wanted
 * patch normal). Returns null if no acceptable triangulation is found.
 */
private fun triangulateLoop(q: DoubleArray, n: Int): Patch? {
    if (n < 3) return null
    val g = LoopGeometry(q, n)
    if (!(g.perimeter > 0.0) || !g.perimeter.isFinite()) return null
    if (n == 3) {
        val t = intArrayOf(0, 1, 2)
        return if (minArea3d(q, DoubleArray(0), n, t) > 0.0) Patch(DoubleArray(0), t) else null
    }
    val meanEdge = g.perimeter / n
    if (g.area > 1e-12 * g.perimeter * g.perimeter) {
        // orthonormal basis (u, v) of the best-fit plane with u x v = normal
        val nx = g.nx / g.area; val ny = g.ny / g.area; val nz = g.nz / g.area
        var ux: Double; var uy: Double; var uz: Double
        if (abs(nx) <= abs(ny) && abs(nx) <= abs(nz)) { ux = 0.0; uy = -nz; uz = ny } else if (abs(ny) <= abs(nz)) { ux = nz; uy = 0.0; uz = -nx } else { ux = -ny; uy = nx; uz = 0.0 }
        val ul = sqrt(ux * ux + uy * uy + uz * uz)
        ux /= ul; uy /= ul; uz /= ul
        val vx = ny * uz - nz * uy; val vy = nz * ux - nx * uz; val vz = nx * uy - ny * ux
        val project = { p: DoubleArray, count: Int ->
            DoubleArray(2 * count) { k ->
                val i = k / 2
                val dx = p[3 * i] - g.cx; val dy = p[3 * i + 1] - g.cy; val dz = p[3 * i + 2] - g.cz
                if (k % 2 == 0) dx * ux + dy * uy + dz * uz else dx * vx + dy * vy + dz * vz
            }
        }
        val p2 = project(q, n)
        val eps = 1e-6 * meanEdge * meanEdge
        var star = true
        for (i in 0 until n) {
            val j = if (i + 1 == n) 0 else i + 1
            if (p2[2 * i] * p2[2 * j + 1] - p2[2 * i + 1] * p2[2 * j] <= eps) { star = false; break }
        }
        if (star) {
            val patch = ringFill(q, n, g, meanEdge)
            if (patch != null) {
                val i2 = project(patch.interior, patch.interior.size / 3)
                if (minArea2d(p2, i2, n, patch.tris) > 0.0 && minArea3d(q, patch.interior, n, patch.tris) > 0.0) return patch
            }
        }
        if (n <= MAX_EAR_CLIP_VERTICES) {
            val tris = earClip(p2, n, 1e-9 * meanEdge * meanEdge)
            if (tris != null && minArea3d(q, DoubleArray(0), n, tris) > 0.0) return Patch(DoubleArray(0), tris)
        }
    }
    // No usable plane (e.g. a slit whose two sides run back along each other) or a projection
    // that is not a simple polygon: leave the hole open rather than risk flipped triangles.
    return null
}

private fun minArea2d(loop2: DoubleArray, interior2: DoubleArray, n: Int, tris: IntArray): Double {
    fun x(i: Int) = if (i < n) loop2[2 * i] else interior2[2 * (i - n)]
    fun y(i: Int) = if (i < n) loop2[2 * i + 1] else interior2[2 * (i - n) + 1]
    var m = Double.POSITIVE_INFINITY
    var t = 0
    while (t < tris.size) {
        val a = tris[t]; val b = tris[t + 1]; val c = tris[t + 2]
        val area = 0.5 * ((x(b) - x(a)) * (y(c) - y(a)) - (y(b) - y(a)) * (x(c) - x(a)))
        if (!(area >= m)) m = area
        t += 3
    }
    return m
}

private fun minArea3d(loop: DoubleArray, interior: DoubleArray, n: Int, tris: IntArray): Double {
    fun c(i: Int, k: Int) = if (i < n) loop[3 * i + k] else interior[3 * (i - n) + k]
    var m = Double.POSITIVE_INFINITY
    var t = 0
    while (t < tris.size) {
        val a = tris[t]; val b = tris[t + 1]; val d = tris[t + 2]
        val e1x = c(b, 0) - c(a, 0); val e1y = c(b, 1) - c(a, 1); val e1z = c(b, 2) - c(a, 2)
        val e2x = c(d, 0) - c(a, 0); val e2y = c(d, 1) - c(a, 1); val e2z = c(d, 2) - c(a, 2)
        val nx = e1y * e2z - e1z * e2y; val ny = e1z * e2x - e1x * e2z; val nz = e1x * e2y - e1y * e2x
        val area = 0.5 * sqrt(nx * nx + ny * ny + nz * nz)
        if (!(area >= m)) m = area
        t += 3
    }
    return m
}

/**
 * Fill a loop that is star-shaped around its centroid with concentric rings: ring k is the loop
 * scaled towards the centroid, resampled with fewer vertices so that edge lengths grow by
 * [RING_GROWTH] per ring; the innermost ring is closed with a fan to the centroid.
 */
private fun ringFill(q: DoubleArray, n: Int, g: LoopGeometry, meanEdge: Double): Patch? {
    var radius = 0.0
    for (i in 0 until n) {
        val dx = q[3 * i] - g.cx; val dy = q[3 * i + 1] - g.cy; val dz = q[3 * i + 2] - g.cz
        radius += sqrt(dx * dx + dy * dy + dz * dz)
    }
    radius /= n
    if (!(radius > 0.0)) return null
    val ringScale = ArrayList<Double>()
    val ringCount = IntList()
    var s = 1.0
    var step = meanEdge / radius
    var growth = 1.0
    var prevCount = n
    while (ringScale.size < 256) {
        val next = s - step
        if (next < 0.75 * step * RING_GROWTH) break
        growth *= RING_GROWTH
        val count = maxOf(3, minOf(prevCount, (n * next / growth).roundToInt()))
        ringScale.add(next); ringCount.add(count)
        prevCount = count
        s = next
        step *= RING_GROWTH
    }
    val rings = ringScale.size
    var interiorCount = 1
    for (k in 0 until rings) interiorCount += ringCount[k]
    val interior = DoubleArray(3 * interiorCount)
    val ringStart = IntArray(rings + 1) // vertex index of ring k+1's first vertex
    var o = 0
    for (k in 0 until rings) {
        ringStart[k] = n + o
        val cnt = ringCount[k]
        val sc = ringScale[k]
        for (j in 0 until cnt) {
            val x = j.toDouble() * n / cnt
            var i = floor(x).toInt()
            if (i >= n) i = n - 1
            val f = x - i
            val i1 = if (i + 1 == n) 0 else i + 1
            for (a in 0 until 3) {
                val b = q[3 * i + a] + f * (q[3 * i1 + a] - q[3 * i + a])
                val c = if (a == 0) g.cx else if (a == 1) g.cy else g.cz
                interior[3 * o + a] = c + sc * (b - c)
            }
            o++
        }
    }
    val centre = n + o
    interior[3 * o] = g.cx; interior[3 * o + 1] = g.cy; interior[3 * o + 2] = g.cz

    val tris = IntList()
    var aStart = 0
    var aCount = n
    for (k in 0 until rings) {
        val bStart = ringStart[k]
        val bCount = ringCount[k]
        var i = 0; var j = 0
        while (i < aCount || j < bCount) {
            val advanceOuter = if (i >= aCount) false else if (j >= bCount) true else (i + 1).toLong() * bCount <= (j + 1).toLong() * aCount
            if (advanceOuter) {
                tris.add(aStart + i % aCount); tris.add(aStart + (i + 1) % aCount); tris.add(bStart + j % bCount)
                i++
            } else {
                tris.add(aStart + i % aCount); tris.add(bStart + (j + 1) % bCount); tris.add(bStart + j % bCount)
                j++
            }
        }
        aStart = bStart; aCount = bCount
    }
    for (i in 0 until aCount) {
        tris.add(aStart + i); tris.add(aStart + (i + 1) % aCount); tris.add(centre)
    }
    return Patch(interior, tris.toArray())
}

/**
 * Ear clipping of a simple counter-clockwise polygon given as 2D points (x, y pairs).
 * O(n^2) for typical input. Returns null if the polygon is not simple enough to finish.
 */
private fun earClip(p: DoubleArray, n: Int, eps: Double): IntArray? {
    val prev = IntArray(n) { if (it == 0) n - 1 else it - 1 }
    val next = IntArray(n) { if (it + 1 == n) 0 else it + 1 }
    val tris = IntList(3 * (n - 2))
    var remaining = n
    var i = 0
    var sinceLastEar = 0
    while (remaining > 3) {
        if (sinceLastEar > remaining) return null
        val a = prev[i]; val c = next[i]
        if (isEar(p, a, i, c, next, eps)) {
            tris.add(a); tris.add(i); tris.add(c)
            next[a] = c; prev[c] = a
            remaining--
            sinceLastEar = 0
            i = c
        } else {
            i = next[i]
            sinceLastEar++
        }
    }
    val a = prev[i]; val c = next[i]
    if (cross2(p, a, i, c) <= eps) return null
    tris.add(a); tris.add(i); tris.add(c)
    return tris.toArray()
}

private fun cross2(p: DoubleArray, a: Int, b: Int, c: Int): Double =
    (p[2 * b] - p[2 * a]) * (p[2 * c + 1] - p[2 * a + 1]) - (p[2 * b + 1] - p[2 * a + 1]) * (p[2 * c] - p[2 * a])

private fun isEar(p: DoubleArray, a: Int, b: Int, c: Int, next: IntArray, eps: Double): Boolean {
    if (cross2(p, a, b, c) <= eps) return false
    var v = next[c]
    while (v != a) {
        val x = p[2 * v]; val y = p[2 * v + 1]
        val coincident = (x == p[2 * a] && y == p[2 * a + 1]) || (x == p[2 * b] && y == p[2 * b + 1]) || (x == p[2 * c] && y == p[2 * c + 1])
        if (!coincident && cross2(p, a, b, v) >= 0.0 && cross2(p, b, c, v) >= 0.0 && cross2(p, c, a, v) >= 0.0) return false
        v = next[v]
    }
    return true
}
