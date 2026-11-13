package dev.pocket3d.core.mesh

import dev.pocket3d.core.math.Ray
import dev.pocket3d.core.math.Vec3
import kotlin.math.sqrt

/**
 * Bounding volume hierarchy over the triangles of a [Mesh] (binned-SAH build, flat arrays).
 *
 * The BVH references the mesh's `positions` / `indices` arrays directly, so it is only valid for
 * the mesh it was built from (and as long as those arrays are not modified). Faces with zero area
 * or non-finite coordinates are left out and can never be hit.
 *
 * Queries are read-only and allocate only a small traversal stack, so one instance can be queried
 * from several threads at once. Triangle math runs in double precision.
 */
class Bvh private constructor(
    private val positions: FloatArray,
    private val indices: IntArray,
    private val nodeBounds: FloatArray, // 6 per node: minX, minY, minZ, maxX, maxY, maxZ
    private val nodeLeft: IntArray,     // inner: index of left child (right = left + 1); leaf: first slot in tris
    private val nodeCount: IntArray,    // 0 = inner node, > 0 = leaf triangle count
    private val tris: IntArray,         // face ids, grouped by leaf
    private val maxDepth: Int,
) {
    /** Number of faces contained in the hierarchy (degenerate faces are excluded). */
    val triangleCount: Int get() = tris.size

    /** Number of BVH nodes. */
    val nodeTotal: Int get() = nodeCount.size

    /** Ray hit. Barycentrics satisfy `point = b0 * v0 + b1 * v1 + b2 * v2` for the face's three vertices. */
    class Hit(
        /** Distance along the (unit) ray direction. */
        val t: Float,
        val face: Int,
        val b0: Float,
        val b1: Float,
        val b2: Float,
        val point: Vec3,
        /** Unit geometric normal of the face from its counter-clockwise winding (not flipped towards the ray). */
        val normal: Vec3,
    )

    /** Result of [closestPoint]. */
    class ClosestHit(
        val point: Vec3,
        val distance: Float,
        val face: Int,
        val b0: Float,
        val b1: Float,
        val b2: Float,
    )

    /**
     * Nearest intersection of [ray] with the mesh in `(0, tMax]`, or null.
     * @param cullBackfaces ignore triangles whose front (counter-clockwise) side faces away from the ray origin.
     */
    fun raycast(ray: Ray, tMax: Float = Float.POSITIVE_INFINITY, cullBackfaces: Boolean = false): Hit? {
        val out = DoubleArray(3)
        val f = traverse(ray, tMax.toDouble(), cullBackfaces, false, out)
        if (f < 0) return null
        val t = out[0]; val u = out[1]; val v = out[2]
        val i0 = indices[3 * f] * 3; val i1 = indices[3 * f + 1] * 3; val i2 = indices[3 * f + 2] * 3
        val ax = positions[i0].toDouble(); val ay = positions[i0 + 1].toDouble(); val az = positions[i0 + 2].toDouble()
        val e1x = positions[i1] - ax; val e1y = positions[i1 + 1] - ay; val e1z = positions[i1 + 2] - az
        val e2x = positions[i2] - ax; val e2y = positions[i2 + 1] - ay; val e2z = positions[i2 + 2] - az
        var nx = e1y * e2z - e1z * e2y; var ny = e1z * e2x - e1x * e2z; var nz = e1x * e2y - e1y * e2x
        val nl = sqrt(nx * nx + ny * ny + nz * nz)
        if (nl > 0) { nx /= nl; ny /= nl; nz /= nl }
        val point = Vec3(
            (ax + u * e1x + v * e2x).toFloat(),
            (ay + u * e1y + v * e2y).toFloat(),
            (az + u * e1z + v * e2z).toFloat(),
        )
        return Hit(t.toFloat(), f, (1.0 - u - v).toFloat(), u.toFloat(), v.toFloat(), point, Vec3(nx.toFloat(), ny.toFloat(), nz.toFloat()))
    }

    /** True if anything is hit in `(0, tMax]` (early exit; use for occlusion tests). */
    fun anyHit(ray: Ray, tMax: Float = Float.POSITIVE_INFINITY, cullBackfaces: Boolean = false): Boolean =
        traverse(ray, tMax.toDouble(), cullBackfaces, true, null) >= 0

    /** Point on the mesh surface closest to [p], or null if nothing lies within [maxDist]. */
    fun closestPoint(p: Vec3, maxDist: Float = Float.POSITIVE_INFINITY): ClosestHit? {
        val out = DoubleArray(7)
        val md = maxDist.toDouble()
        val f = closest(p.x.toDouble(), p.y.toDouble(), p.z.toDouble(), if (md.isInfinite()) md else md * md, out)
        if (f < 0) return null
        return ClosestHit(
            Vec3(out[0].toFloat(), out[1].toFloat(), out[2].toFloat()),
            sqrt(out[3]).toFloat(), f, out[4].toFloat(), out[5].toFloat(), out[6].toFloat(),
        )
    }

    private fun traverse(ray: Ray, tMaxIn: Double, cull: Boolean, any: Boolean, out: DoubleArray?): Int {
        if (nodeCount.isEmpty()) return -1
        val ox = ray.origin.x.toDouble(); val oy = ray.origin.y.toDouble(); val oz = ray.origin.z.toDouble()
        val dx = ray.dir.x.toDouble(); val dy = ray.dir.y.toDouble(); val dz = ray.dir.z.toDouble()
        val ix = 1.0 / dx; val iy = 1.0 / dy; val iz = 1.0 / dz
        var best = tMaxIn
        var bestFace = -1
        var bestU = 0.0; var bestV = 0.0
        val stack = IntArray(2 * maxDepth + 8)
        var sp = 0
        stack[sp++] = 0
        while (sp > 0) {
            val n = stack[--sp]
            if (boxEntry(n, ox, oy, oz, ix, iy, iz, best) < 0.0) continue
            val cnt = nodeCount[n]
            if (cnt > 0) {
                val s = nodeLeft[n]
                for (k in s until s + cnt) {
                    val f = tris[k]
                    val i0 = indices[3 * f] * 3; val i1 = indices[3 * f + 1] * 3; val i2 = indices[3 * f + 2] * 3
                    val ax = positions[i0].toDouble(); val ay = positions[i0 + 1].toDouble(); val az = positions[i0 + 2].toDouble()
                    val e1x = positions[i1] - ax; val e1y = positions[i1 + 1] - ay; val e1z = positions[i1 + 2] - az
                    val e2x = positions[i2] - ax; val e2y = positions[i2 + 1] - ay; val e2z = positions[i2 + 2] - az
                    // Moeller-Trumbore
                    val px = dy * e2z - dz * e2y; val py = dz * e2x - dx * e2z; val pz = dx * e2y - dy * e2x
                    val det = e1x * px + e1y * py + e1z * pz
                    if (det == 0.0 || (cull && det < 0.0)) continue
                    val inv = 1.0 / det
                    val tx = ox - ax; val ty = oy - ay; val tz = oz - az
                    val u = (tx * px + ty * py + tz * pz) * inv
                    if (!(u >= 0.0 && u <= 1.0)) continue
                    val qx = ty * e1z - tz * e1y; val qy = tz * e1x - tx * e1z; val qz = tx * e1y - ty * e1x
                    val v = (dx * qx + dy * qy + dz * qz) * inv
                    if (!(v >= 0.0 && u + v <= 1.0)) continue
                    val t = (e2x * qx + e2y * qy + e2z * qz) * inv
                    if (t > 0.0 && t <= best && (t < best || bestFace < 0 || f < bestFace)) {
                        if (any) return f
                        best = t; bestFace = f; bestU = u; bestV = v
                    }
                }
            } else {
                val l = nodeLeft[n]
                val tl = boxEntry(l, ox, oy, oz, ix, iy, iz, best)
                val tr = boxEntry(l + 1, ox, oy, oz, ix, iy, iz, best)
                if (tl >= 0.0 && tr >= 0.0) {
                    // push the farther child first so the nearer one is visited first
                    if (tl <= tr) { stack[sp++] = l + 1; stack[sp++] = l } else { stack[sp++] = l; stack[sp++] = l + 1 }
                } else if (tl >= 0.0) stack[sp++] = l
                else if (tr >= 0.0) stack[sp++] = l + 1
            }
        }
        if (bestFace >= 0 && out != null) { out[0] = best; out[1] = bestU; out[2] = bestV }
        return bestFace
    }

    /** Entry distance of the ray into node [n]'s box (>= 0), or -1 if the box is missed within [tMax]. */
    private fun boxEntry(n: Int, ox: Double, oy: Double, oz: Double, ix: Double, iy: Double, iz: Double, tMax: Double): Double {
        val b = 6 * n
        var t0 = 0.0
        var t1 = tMax
        var a = (nodeBounds[b] - ox) * ix; var c = (nodeBounds[b + 3] - ox) * ix
        if (a > c) { val s = a; a = c; c = s }
        if (a > t0) t0 = a
        if (c < t1) t1 = c
        a = (nodeBounds[b + 1] - oy) * iy; c = (nodeBounds[b + 4] - oy) * iy
        if (a > c) { val s = a; a = c; c = s }
        if (a > t0) t0 = a
        if (c < t1) t1 = c
        a = (nodeBounds[b + 2] - oz) * iz; c = (nodeBounds[b + 5] - oz) * iz
        if (a > c) { val s = a; a = c; c = s }
        if (a > t0) t0 = a
        if (c < t1) t1 = c
        return if (t0 <= t1) t0 else -1.0
    }

    private fun boxDist2(n: Int, px: Double, py: Double, pz: Double): Double {
        val b = 6 * n
        var d = 0.0
        var lo = nodeBounds[b].toDouble(); var hi = nodeBounds[b + 3].toDouble()
        if (px < lo) d += (lo - px) * (lo - px) else if (px > hi) d += (px - hi) * (px - hi)
        lo = nodeBounds[b + 1].toDouble(); hi = nodeBounds[b + 4].toDouble()
        if (py < lo) d += (lo - py) * (lo - py) else if (py > hi) d += (py - hi) * (py - hi)
        lo = nodeBounds[b + 2].toDouble(); hi = nodeBounds[b + 5].toDouble()
        if (pz < lo) d += (lo - pz) * (lo - pz) else if (pz > hi) d += (pz - hi) * (pz - hi)
        return d
    }

    /**
     * Allocation-light closest point query. Writes `[x, y, z, dist^2, b0, b1, b2]` to [out] and
     * returns the face index, or -1 if nothing is within sqrt([maxDist2]).
     */
    internal fun closest(px: Double, py: Double, pz: Double, maxDist2: Double, out: DoubleArray, stackIn: IntArray? = null): Int {
        if (nodeCount.isEmpty()) return -1
        var best = maxDist2
        var bestFace = -1
        val stack = stackIn ?: IntArray(2 * maxDepth + 8)
        var sp = 0
        stack[sp++] = 0
        while (sp > 0) {
            val n = stack[--sp]
            val nd = boxDist2(n, px, py, pz)
            if (nd > best || (nd == best && bestFace >= 0)) continue
            val cnt = nodeCount[n]
            if (cnt > 0) {
                val s = nodeLeft[n]
                for (k in s until s + cnt) {
                    val f = tris[k]
                    val i0 = indices[3 * f] * 3; val i1 = indices[3 * f + 1] * 3; val i2 = indices[3 * f + 2] * 3
                    val ax = positions[i0].toDouble(); val ay = positions[i0 + 1].toDouble(); val az = positions[i0 + 2].toDouble()
                    val abx = positions[i1] - ax; val aby = positions[i1 + 1] - ay; val abz = positions[i1 + 2] - az
                    val acx = positions[i2] - ax; val acy = positions[i2 + 1] - ay; val acz = positions[i2 + 2] - az
                    val apx = px - ax; val apy = py - ay; val apz = pz - az
                    // Closest point on triangle (Ericson, Real-Time Collision Detection 5.1.5)
                    val d1 = abx * apx + aby * apy + abz * apz
                    val d2 = acx * apx + acy * apy + acz * apz
                    var v: Double; var w: Double
                    if (d1 <= 0.0 && d2 <= 0.0) { v = 0.0; w = 0.0 } else {
                        val bpx = apx - abx; val bpy = apy - aby; val bpz = apz - abz
                        val d3 = abx * bpx + aby * bpy + abz * bpz
                        val d4 = acx * bpx + acy * bpy + acz * bpz
                        if (d3 >= 0.0 && d4 <= d3) { v = 1.0; w = 0.0 } else {
                            val vc = d1 * d4 - d3 * d2
                            if (vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0) { v = d1 / (d1 - d3); w = 0.0 } else {
                                val cpx = apx - acx; val cpy = apy - acy; val cpz = apz - acz
                                val d5 = abx * cpx + aby * cpy + abz * cpz
                                val d6 = acx * cpx + acy * cpy + acz * cpz
                                if (d6 >= 0.0 && d5 <= d6) { v = 0.0; w = 1.0 } else {
                                    val vb = d5 * d2 - d1 * d6
                                    if (vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0) { v = 0.0; w = d2 / (d2 - d6) } else {
                                        val va = d3 * d6 - d5 * d4
                                        if (va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0) {
                                            w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); v = 1.0 - w
                                        } else {
                                            val denom = 1.0 / (va + vb + vc)
                                            v = vb * denom; w = vc * denom
                                        }
                                    }
                                }
                            }
                        }
                    }
                    val cx = abx * v + acx * w - apx
                    val cy = aby * v + acy * w - apy
                    val cz = abz * v + acz * w - apz
                    val dist2 = cx * cx + cy * cy + cz * cz
                    if (dist2 < best || (dist2 == best && (bestFace < 0 || f < bestFace))) {
                        best = dist2; bestFace = f
                        out[0] = ax + abx * v + acx * w
                        out[1] = ay + aby * v + acy * w
                        out[2] = az + abz * v + acz * w
                        out[3] = dist2
                        out[4] = if (1.0 - v - w > 0.0) 1.0 - v - w else 0.0; out[5] = v; out[6] = w
                    }
                }
            } else {
                val l = nodeLeft[n]
                val dl = boxDist2(l, px, py, pz)
                val dr = boxDist2(l + 1, px, py, pz)
                if (dl <= dr) {
                    if (dr <= best) stack[sp++] = l + 1
                    if (dl <= best) stack[sp++] = l
                } else {
                    if (dl <= best) stack[sp++] = l
                    if (dr <= best) stack[sp++] = l + 1
                }
            }
        }
        return bestFace
    }

    internal fun newStack(): IntArray = IntArray(2 * maxDepth + 8)

    companion object {
        private const val BINS = 12

        /** Build a BVH for [mesh]. O(F log F); about 0.3 s for 500k faces on a desktop JVM. */
        fun build(mesh: Mesh, maxLeafSize: Int = 4): Bvh {
            require(maxLeafSize >= 1) { "maxLeafSize must be >= 1" }
            val pos = mesh.positions
            val idx = mesh.indices
            val fCount = mesh.faceCount
            val cent = FloatArray(3 * fCount)
            val fb = FloatArray(6 * fCount)
            val order = IntList(fCount)
            for (f in 0 until fCount) {
                val i0 = idx[3 * f] * 3; val i1 = idx[3 * f + 1] * 3; val i2 = idx[3 * f + 2] * 3
                val ax = pos[i0]; val ay = pos[i0 + 1]; val az = pos[i0 + 2]
                val bx = pos[i1]; val by = pos[i1 + 1]; val bz = pos[i1 + 2]
                val cx = pos[i2]; val cy = pos[i2 + 1]; val cz = pos[i2 + 2]
                val e1x = (bx - ax).toDouble(); val e1y = (by - ay).toDouble(); val e1z = (bz - az).toDouble()
                val e2x = (cx - ax).toDouble(); val e2y = (cy - ay).toDouble(); val e2z = (cz - az).toDouble()
                val nx = e1y * e2z - e1z * e2y; val ny = e1z * e2x - e1x * e2z; val nz = e1x * e2y - e1y * e2x
                val n2 = nx * nx + ny * ny + nz * nz
                if (!(n2 > 0.0) || n2.isInfinite()) continue // degenerate or non-finite
                fb[6 * f] = minOf(ax, bx, cx); fb[6 * f + 1] = minOf(ay, by, cy); fb[6 * f + 2] = minOf(az, bz, cz)
                fb[6 * f + 3] = maxOf(ax, bx, cx); fb[6 * f + 4] = maxOf(ay, by, cy); fb[6 * f + 5] = maxOf(az, bz, cz)
                cent[3 * f] = (fb[6 * f] + fb[6 * f + 3]) * 0.5f
                cent[3 * f + 1] = (fb[6 * f + 1] + fb[6 * f + 4]) * 0.5f
                cent[3 * f + 2] = (fb[6 * f + 2] + fb[6 * f + 5]) * 0.5f
                order.add(f)
            }
            val tris = order.toArray()
            val n = tris.size
            if (n == 0) return Bvh(pos, idx, FloatArray(0), IntArray(0), IntArray(0), tris, 0)

            val maxNodes = 2 * n
            val bounds = FloatArray(6 * maxNodes)
            val left = IntArray(maxNodes)
            val count = IntArray(maxNodes)
            var nodes = 1
            var maxDepth = 0
            // explicit work stack: node, start, end, depth
            val work = IntList(256)
            work.add(0); work.add(0); work.add(n); work.add(0)
            var wp = 4
            val binCount = IntArray(BINS)
            val binB = FloatArray(6 * BINS)
            val rightArea = FloatArray(BINS)
            while (wp > 0) {
                val depth = work[--wp]; val end = work[--wp]; val start = work[--wp]; val node = work[--wp]
                if (depth > maxDepth) maxDepth = depth
                // node bounds + centroid bounds
                var minX = Float.POSITIVE_INFINITY; var minY = minX; var minZ = minX
                var maxX = Float.NEGATIVE_INFINITY; var maxY = maxX; var maxZ = maxX
                var cMinX = minX; var cMinY = minX; var cMinZ = minX
                var cMaxX = maxX; var cMaxY = maxX; var cMaxZ = maxX
                for (k in start until end) {
                    val f = tris[k]
                    if (fb[6 * f] < minX) minX = fb[6 * f]
                    if (fb[6 * f + 1] < minY) minY = fb[6 * f + 1]
                    if (fb[6 * f + 2] < minZ) minZ = fb[6 * f + 2]
                    if (fb[6 * f + 3] > maxX) maxX = fb[6 * f + 3]
                    if (fb[6 * f + 4] > maxY) maxY = fb[6 * f + 4]
                    if (fb[6 * f + 5] > maxZ) maxZ = fb[6 * f + 5]
                    val x = cent[3 * f]; val y = cent[3 * f + 1]; val z = cent[3 * f + 2]
                    if (x < cMinX) cMinX = x; if (x > cMaxX) cMaxX = x
                    if (y < cMinY) cMinY = y; if (y > cMaxY) cMaxY = y
                    if (z < cMinZ) cMinZ = z; if (z > cMaxZ) cMaxZ = z
                }
                bounds[6 * node] = minX; bounds[6 * node + 1] = minY; bounds[6 * node + 2] = minZ
                bounds[6 * node + 3] = maxX; bounds[6 * node + 4] = maxY; bounds[6 * node + 5] = maxZ
                val size = end - start
                if (size <= maxLeafSize) { left[node] = start; count[node] = size; continue }

                // split axis = longest centroid extent
                val ex = cMaxX - cMinX; val ey = cMaxY - cMinY; val ez = cMaxZ - cMinZ
                val axis = if (ex >= ey && ex >= ez) 0 else if (ey >= ez) 1 else 2
                val cMin = if (axis == 0) cMinX else if (axis == 1) cMinY else cMinZ
                val ext = if (axis == 0) ex else if (axis == 1) ey else ez
                var mid = -1
                if (ext > 0f) {
                    // binned SAH
                    java.util.Arrays.fill(binCount, 0)
                    for (b in 0 until BINS) {
                        binB[6 * b] = Float.POSITIVE_INFINITY; binB[6 * b + 1] = Float.POSITIVE_INFINITY; binB[6 * b + 2] = Float.POSITIVE_INFINITY
                        binB[6 * b + 3] = Float.NEGATIVE_INFINITY; binB[6 * b + 4] = Float.NEGATIVE_INFINITY; binB[6 * b + 5] = Float.NEGATIVE_INFINITY
                    }
                    val scale = BINS / ext
                    for (k in start until end) {
                        val f = tris[k]
                        var b = ((cent[3 * f + axis] - cMin) * scale).toInt()
                        if (b >= BINS) b = BINS - 1
                        if (b < 0) b = 0
                        binCount[b]++
                        for (c in 0 until 3) {
                            if (fb[6 * f + c] < binB[6 * b + c]) binB[6 * b + c] = fb[6 * f + c]
                            if (fb[6 * f + 3 + c] > binB[6 * b + 3 + c]) binB[6 * b + 3 + c] = fb[6 * f + 3 + c]
                        }
                    }
                    // sweep from the right
                    var aMinX = Float.POSITIVE_INFINITY; var aMinY = aMinX; var aMinZ = aMinX
                    var aMaxX = Float.NEGATIVE_INFINITY; var aMaxY = aMaxX; var aMaxZ = aMaxX
                    for (b in BINS - 1 downTo 1) {
                        if (binCount[b] > 0) {
                            if (binB[6 * b] < aMinX) aMinX = binB[6 * b]
                            if (binB[6 * b + 1] < aMinY) aMinY = binB[6 * b + 1]
                            if (binB[6 * b + 2] < aMinZ) aMinZ = binB[6 * b + 2]
                            if (binB[6 * b + 3] > aMaxX) aMaxX = binB[6 * b + 3]
                            if (binB[6 * b + 4] > aMaxY) aMaxY = binB[6 * b + 4]
                            if (binB[6 * b + 5] > aMaxZ) aMaxZ = binB[6 * b + 5]
                        }
                        rightArea[b] = halfArea(aMinX, aMinY, aMinZ, aMaxX, aMaxY, aMaxZ)
                    }
                    aMinX = Float.POSITIVE_INFINITY; aMinY = aMinX; aMinZ = aMinX
                    aMaxX = Float.NEGATIVE_INFINITY; aMaxY = aMaxX; aMaxZ = aMaxX
                    var leftN = 0
                    var bestCost = Float.POSITIVE_INFINITY
                    var bestBin = -1
                    for (b in 0 until BINS - 1) {
                        if (binCount[b] > 0) {
                            if (binB[6 * b] < aMinX) aMinX = binB[6 * b]
                            if (binB[6 * b + 1] < aMinY) aMinY = binB[6 * b + 1]
                            if (binB[6 * b + 2] < aMinZ) aMinZ = binB[6 * b + 2]
                            if (binB[6 * b + 3] > aMaxX) aMaxX = binB[6 * b + 3]
                            if (binB[6 * b + 4] > aMaxY) aMaxY = binB[6 * b + 4]
                            if (binB[6 * b + 5] > aMaxZ) aMaxZ = binB[6 * b + 5]
                        }
                        leftN += binCount[b]
                        val rightN = size - leftN
                        if (leftN == 0 || rightN == 0) continue
                        val cost = leftN * halfArea(aMinX, aMinY, aMinZ, aMaxX, aMaxY, aMaxZ) + rightN * rightArea[b + 1]
                        if (cost < bestCost) { bestCost = cost; bestBin = b }
                    }
                    if (bestBin >= 0) {
                        // partition in place: bins <= bestBin to the left
                        var i = start; var j = end - 1
                        while (i <= j) {
                            val f = tris[i]
                            var b = ((cent[3 * f + axis] - cMin) * scale).toInt()
                            if (b >= BINS) b = BINS - 1
                            if (b < 0) b = 0
                            if (b <= bestBin) i++ else { tris[i] = tris[j]; tris[j] = f; j-- }
                        }
                        mid = i
                    }
                }
                if (mid <= start || mid >= end) mid = start + size / 2 // coincident centroids: arbitrary halves
                val l = nodes
                nodes += 2
                left[node] = l; count[node] = 0
                work.ensure(wp + 8)
                work[wp++] = l + 1; work[wp++] = mid; work[wp++] = end; work[wp++] = depth + 1
                work[wp++] = l; work[wp++] = start; work[wp++] = mid; work[wp++] = depth + 1
            }
            return Bvh(pos, idx, bounds.copyOf(6 * nodes), left.copyOf(nodes), count.copyOf(nodes), tris, maxDepth)
        }

        private fun halfArea(minX: Float, minY: Float, minZ: Float, maxX: Float, maxY: Float, maxZ: Float): Float {
            val dx = maxX - minX; val dy = maxY - minY; val dz = maxZ - minZ
            if (dx < 0f) return 0f
            return dx * dy + dy * dz + dz * dx
        }

        private fun IntList.ensure(n: Int) { while (size < n) add(0) }
    }
}
