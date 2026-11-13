package dev.pocket3d.core.mesh

import kotlin.math.sqrt

/**
 * Quadric-error-metric edge collapse (Garland & Heckbert) with subset placement.
 *
 * Three levels of vertices are involved:
 *  - *welded* vertices: distinct positions. Collapses merge one welded vertex into a neighbour.
 *  - *wedges*: distinct (position, uv, material) combinations. A welded vertex on a UV seam or a
 *    material border has several wedges. Each wedge carries a quadric in (x, y, z, s*u, s*v) space
 *    (Garland & Heckbert 1998, "Simplifying surfaces with color and texture using quadric error
 *    metrics"), so the cost of a collapse measures geometric and texture-space error together.
 *  - render vertices of the input, which only provide the attribute values.
 *
 * A collapse A -> B is only legal if every wedge of A has exactly one wedge of B it shares a face
 * with. That single rule keeps seams, material borders and chart corners intact: a seam vertex
 * can only slide along its seam, with both sides moving together, and a vertex where three charts
 * meet cannot move at all.
 *
 * Since vertices are never moved, the 1-ring of a vertex changes only when one of its neighbours
 * is collapsed; after each collapse the surviving vertex and all its neighbours are re-evaluated,
 * which keeps every queued candidate valid and up to date.
 */
internal class Simplifier(private val mesh: Mesh, private val opt: SimplifyOptions) {
    private val topo = MeshTopology.build(mesh)
    private val weldedCount = topo.weldedCount
    private val faceTotal = mesh.faceCount
    private val uvs = mesh.uvs
    private val dim = if (uvs != null && opt.uvWeight > 0f) 5 else 3
    private val qn = dim * (dim + 1) / 2 + dim + 1

    // welded positions, centred on the bounding box for numerical accuracy
    private val wp = DoubleArray(3 * weldedCount)

    // faces
    private val fw = topo.faceWelded.copyOf()
    private val fwed = IntArray(3 * faceTotal)
    private val alive = BooleanArray(faceTotal)
    private var faces = 0

    // corner lists per welded vertex
    private val head = IntArray(weldedCount) { -1 }
    private val next = IntArray(3 * faceTotal)
    private val vAlive = BooleanArray(weldedCount)

    // wedges
    private var wedgeCount = 0
    private lateinit var wedgeBase: IntArray   // render vertex providing uv / normal
    private lateinit var wedgeConf: FloatArray
    private lateinit var wedgeU: DoubleArray   // uv scaled into the quadric space (dim 5 only)
    private lateinit var wedgeV: DoubleArray
    private lateinit var q: DoubleArray        // qn per wedge
    private lateinit var refN: DoubleArray     // unit smooth normal of the input surface per wedge (3 per wedge)
    private val minRefCos: Double =
        if (opt.maxNormalDeviationDegrees >= 180f) Double.NEGATIVE_INFINITY else Math.cos(Math.toRadians(opt.maxNormalDeviationDegrees.toDouble()))

    private val target = IntArray(weldedCount) { -1 }
    private val heap = IndexedMinHeap(weldedCount)

    // scratch for gather()
    private val mark = IntArray(weldedCount)
    private val slotOf = IntArray(weldedCount)
    private var stamp = 0
    private val mark2 = IntArray(weldedCount)
    private var stamp2 = 0
    private var cornerBuf = IntArray(32)
    private var cn = 0
    private var nb = IntArray(32)
    private var shared = IntArray(32)
    private var pairA = IntArray(64)
    private var pairN = IntArray(64)
    private var cost = DoubleArray(32)
    private var rn = 0
    private var wedge0 = -1
    private var wedge1 = -1
    private var wedgeKinds = 0
    private var ringArea = 0.0
    private val x = DoubleArray(5)
    private var tmpRing = IntArray(32)

    fun run(targetFaceCount: Int): SimplifyResult {
        require(targetFaceCount >= 0) { "targetFaceCount must be >= 0" }
        if (targetFaceCount >= faceTotal) return SimplifyResult(mesh, faceTotal, faceTotal, true, 0)
        setup()
        for (v in 0 until weldedCount) evaluate(v)
        var collapses = 0
        while (faces > targetFaceCount && heap.size > 0) {
            val a = heap.pop()
            collapse(a)
            collapses++
        }
        val out = buildResult()
        return SimplifyResult(out, out.faceCount, faceTotal, out.faceCount <= targetFaceCount, collapses)
    }

    // ------------------------------------------------------------------ setup

    private fun setup() {
        val pos = mesh.positions
        val box = Aabb.of(pos)
        val cx = box.center.x.toDouble(); val cy = box.center.y.toDouble(); val cz = box.center.z.toDouble()
        for (w in 0 until weldedCount) {
            val r = topo.weldedRepresentative[w] * 3
            wp[3 * w] = pos[r] - cx; wp[3 * w + 1] = pos[r + 1] - cy; wp[3 * w + 2] = pos[r + 2] - cz
        }

        // canonical render vertex per (position, uv)
        val vCount = mesh.vertexCount
        val baseOf = IntArray(vCount)
        val baseConf = mesh.confidence?.copyOf()
        run {
            val first = IntArray(weldedCount) { -1 }
            val chain = IntArray(vCount) { -1 }
            for (v in 0 until vCount) {
                val w = topo.weldOf[v]
                var b = first[w]
                var found = -1
                if (uvs == null) found = b else {
                    val u = (uvs[2 * v] + 0f).toRawBits(); val t = (uvs[2 * v + 1] + 0f).toRawBits()
                    while (b >= 0) {
                        if ((uvs[2 * b] + 0f).toRawBits() == u && (uvs[2 * b + 1] + 0f).toRawBits() == t) { found = b; break }
                        b = chain[b]
                    }
                }
                if (found >= 0) {
                    baseOf[v] = found
                    if (baseConf != null && baseConf[v] < baseConf[found]) baseConf[found] = baseConf[v]
                } else {
                    baseOf[v] = v
                    chain[v] = first[w]; first[w] = v
                }
            }
        }

        // dense material ids
        val idx = mesh.indices
        val faceMat = IntArray(faceTotal)
        var matCount = 1
        mesh.faceMaterial?.let { fm ->
            val ids = LongIntMap(16)
            matCount = 0
            for (f in 0 until faceTotal) {
                val key = fm[f].toLong() and 0xffffffffL
                var id = ids.get(key)
                if (id < 0) { id = matCount++; ids.put(key, id) }
                faceMat[f] = id
            }
            if (matCount == 0) matCount = 1
        }

        // wedges
        val wedgeMap = LongIntMap(vCount + 16)
        val bases = IntList(vCount + 16)
        val wedgeMat = IntList(vCount + 16)
        for (f in 0 until faceTotal) {
            val a = fw[3 * f]; val b = fw[3 * f + 1]; val c = fw[3 * f + 2]
            if (a == b || b == c || a == c) continue
            alive[f] = true
            faces++
            for (k in 0 until 3) {
                val base = baseOf[idx[3 * f + k]]
                val key = pairKey(base, faceMat[f])
                var w = wedgeMap.get(key)
                if (w < 0) {
                    w = bases.size
                    wedgeMap.put(key, w)
                    bases.add(base); wedgeMat.add(faceMat[f])
                }
                fwed[3 * f + k] = w
            }
        }
        wedgeCount = bases.size
        wedgeBase = bases.toArray()
        wedgeConf = FloatArray(wedgeCount) { baseConf?.get(wedgeBase[it]) ?: 1f }

        // reference normals: area-weighted normal of the input faces around each wedge
        refN = DoubleArray(3 * wedgeCount)
        for (f in 0 until faceTotal) {
            if (!alive[f]) continue
            val a = fw[3 * f] * 3; val b = fw[3 * f + 1] * 3; val c = fw[3 * f + 2] * 3
            val e1x = wp[b] - wp[a]; val e1y = wp[b + 1] - wp[a + 1]; val e1z = wp[b + 2] - wp[a + 2]
            val e2x = wp[c] - wp[a]; val e2y = wp[c + 1] - wp[a + 1]; val e2z = wp[c + 2] - wp[a + 2]
            val nx = e1y * e2z - e1z * e2y; val ny = e1z * e2x - e1x * e2z; val nz = e1x * e2y - e1y * e2x
            if (!(nx.isFinite() && ny.isFinite() && nz.isFinite())) continue
            for (k in 0 until 3) {
                val o = fwed[3 * f + k] * 3
                refN[o] += nx; refN[o + 1] += ny; refN[o + 2] += nz
            }
        }
        for (w in 0 until wedgeCount) {
            val l = sqrt(refN[3 * w] * refN[3 * w] + refN[3 * w + 1] * refN[3 * w + 1] + refN[3 * w + 2] * refN[3 * w + 2])
            if (l > 0.0 && l.isFinite()) { refN[3 * w] /= l; refN[3 * w + 1] /= l; refN[3 * w + 2] /= l } else { refN[3 * w] = 0.0; refN[3 * w + 1] = 0.0; refN[3 * w + 2] = 0.0 }
        }

        // corner lists (ascending corner order)
        for (c in 3 * faceTotal - 1 downTo 0) {
            if (!alive[c / 3]) continue
            val w = fw[c]
            next[c] = head[w]; head[w] = c
            vAlive[w] = true
        }

        // texture scale per material: uv distance -> surface distance
        wedgeU = DoubleArray(if (dim == 5) wedgeCount else 0)
        wedgeV = DoubleArray(if (dim == 5) wedgeCount else 0)
        if (dim == 5) {
            val area3 = DoubleArray(matCount)
            val areaUv = DoubleArray(matCount)
            for (f in 0 until faceTotal) {
                if (!alive[f]) continue
                val i0 = idx[3 * f]; val i1 = idx[3 * f + 1]; val i2 = idx[3 * f + 2]
                val au = (uvs!![2 * i1] - uvs[2 * i0]).toDouble() * (uvs[2 * i2 + 1] - uvs[2 * i0 + 1]) -
                    (uvs[2 * i1 + 1] - uvs[2 * i0 + 1]).toDouble() * (uvs[2 * i2] - uvs[2 * i0])
                val a = Math.abs(au) * 0.5
                if (a > 0.0 && a.isFinite()) {
                    areaUv[faceMat[f]] += a
                    area3[faceMat[f]] += faceArea(mesh.positions, idx, f)
                }
            }
            for (w in 0 until wedgeCount) {
                val m = wedgeMat[w]
                val s = if (areaUv[m] > 0.0) opt.uvWeight * sqrt(area3[m] / areaUv[m]) else 0.0
                val u = uvs!![2 * wedgeBase[w]].toDouble(); val v = uvs[2 * wedgeBase[w] + 1].toDouble()
                wedgeU[w] = if (u.isFinite()) s * u else 0.0
                wedgeV[w] = if (v.isFinite()) s * v else 0.0
            }
        }

        // quadrics
        q = DoubleArray(qn * wedgeCount)
        val p = DoubleArray(dim); val r = DoubleArray(dim); val s = DoubleArray(dim)
        val e1 = DoubleArray(dim); val e2 = DoubleArray(dim)
        val tq = DoubleArray(qn)
        for (f in 0 until faceTotal) {
            if (!alive[f]) continue
            val area = faceArea(mesh.positions, idx, f)
            if (!(area > 0.0) || !area.isFinite()) continue
            point(3 * f, p); point(3 * f + 1, r); point(3 * f + 2, s)
            if (!frame(p, r, s, e1, e2)) continue
            // A = I - e1 e1^T - e2 e2^T, b = (p.e1) e1 + (p.e2) e2 - p, c = p.p - (p.e1)^2 - (p.e2)^2
            var pe1 = 0.0; var pe2 = 0.0; var pp = 0.0
            for (i in 0 until dim) { pe1 += p[i] * e1[i]; pe2 += p[i] * e2[i]; pp += p[i] * p[i] }
            var k = 0
            for (i in 0 until dim) for (j in i until dim) {
                tq[k++] = area * ((if (i == j) 1.0 else 0.0) - e1[i] * e1[j] - e2[i] * e2[j])
            }
            for (i in 0 until dim) tq[k++] = area * (pe1 * e1[i] + pe2 * e2[i] - p[i])
            tq[k] = area * (pp - pe1 * pe1 - pe2 * pe2)
            for (c in 0 until 3) {
                val o = fwed[3 * f + c] * qn
                for (i in 0 until qn) q[o + i] += tq[i]
            }
        }
        // constraint quadrics on open boundaries, seams / material borders and non-manifold edges
        for (e in 0 until topo.edgeCount) {
            val cnt = topo.edgeFaceCount(e)
            val weight: Double = when {
                cnt == 1 -> opt.boundaryWeight.toDouble()
                cnt == 2 -> {
                    val h0 = topo.edgeHalfEdge(e, 0); val h1 = topo.edgeHalfEdge(e, 1)
                    if (sameWedges(h0, h1)) 0.0 else opt.seamWeight.toDouble()
                }
                else -> maxOf(opt.boundaryWeight, opt.seamWeight).toDouble()
            }
            if (!(weight > 0.0)) continue
            for (i in 0 until cnt) {
                val h = topo.edgeHalfEdge(e, i)
                val hn = MeshTopology.nextInFace(h)
                point(h, p); point(hn, r); point(MeshTopology.prevInFace(h), s)
                if (!frame(p, r, s, e1, e2)) continue
                val a = fw[h] * 3; val b = fw[hn] * 3
                val dx = wp[a] - wp[b]; val dy = wp[a + 1] - wp[b + 1]; val dz = wp[a + 2] - wp[b + 2]
                val wgt = weight * (dx * dx + dy * dy + dz * dz)
                // hyperplane through the edge, perpendicular to the triangle: normal e2
                var mp = 0.0
                for (j in 0 until dim) mp += e2[j] * p[j]
                var k = 0
                for (i2 in 0 until dim) for (j in i2 until dim) tq[k++] = wgt * e2[i2] * e2[j]
                for (i2 in 0 until dim) tq[k++] = -wgt * mp * e2[i2]
                tq[k] = wgt * mp * mp
                val o0 = fwed[h] * qn; val o1 = fwed[hn] * qn
                for (j in 0 until qn) { q[o0 + j] += tq[j]; q[o1 + j] += tq[j] }
            }
        }
    }

    /** True if the two half-edges of a 2-face edge use identical wedges at both end points. */
    private fun sameWedges(h0: Int, h1: Int): Boolean {
        val n0 = MeshTopology.nextInFace(h0); val n1 = MeshTopology.nextInFace(h1)
        return if (fw[h0] == fw[n1]) fwed[h0] == fwed[n1] && fwed[n0] == fwed[h1]
        else fwed[h0] == fwed[h1] && fwed[n0] == fwed[n1] // inconsistent winding
    }

    /** Coordinates of face corner [c] in quadric space. */
    private fun point(c: Int, out: DoubleArray) {
        val w = fw[c] * 3
        out[0] = wp[w]; out[1] = wp[w + 1]; out[2] = wp[w + 2]
        if (dim == 5) { val wd = fwed[c]; out[3] = wedgeU[wd]; out[4] = wedgeV[wd] }
    }

    /** Orthonormal frame of the triangle (p, r, s): e1 along p->r, e2 towards s. False if degenerate. */
    private fun frame(p: DoubleArray, r: DoubleArray, s: DoubleArray, e1: DoubleArray, e2: DoubleArray): Boolean {
        var l = 0.0
        for (i in 0 until dim) { e1[i] = r[i] - p[i]; l += e1[i] * e1[i] }
        if (!(l > 0.0)) return false
        l = sqrt(l)
        var d = 0.0
        for (i in 0 until dim) { e1[i] /= l; e2[i] = s[i] - p[i]; d += e1[i] * e2[i] }
        var l2 = 0.0
        var full = 0.0
        for (i in 0 until dim) { full += e2[i] * e2[i]; e2[i] -= d * e1[i]; l2 += e2[i] * e2[i] }
        if (!(l2 > 1e-24 * full) || !(l2 > 0.0)) return false
        l2 = sqrt(l2)
        for (i in 0 until dim) e2[i] /= l2
        return true
    }

    // ------------------------------------------------------------------ neighbourhood

    private fun growRing() {
        nb = nb.copyOf(nb.size * 2); shared = shared.copyOf(nb.size); cost = cost.copyOf(nb.size)
        pairA = pairA.copyOf(2 * nb.size); pairN = pairN.copyOf(2 * nb.size)
    }

    private fun visitNeighbour(v: Int, wedgeA: Int, wedgeN: Int) {
        val s: Int
        if (mark[v] != stamp) {
            mark[v] = stamp
            if (rn == nb.size) growRing()
            s = rn++
            slotOf[v] = s; nb[s] = v; shared[s] = 0
        } else s = slotOf[v]
        val k = shared[s]
        if (k < 2) { pairA[2 * s + k] = wedgeA; pairN[2 * s + k] = wedgeN }
        shared[s] = k + 1
    }

    /**
     * Collect the alive face corners of welded vertex [a] (dropping dead ones from its list), its
     * ring of neighbours with the number of faces shared with each, and its wedges.
     */
    private fun gather(a: Int) {
        stamp++
        cn = 0; rn = 0; wedgeKinds = 0; wedge0 = -1; wedge1 = -1; ringArea = 0.0
        var c = head[a]
        var prev = -1
        while (c >= 0) {
            val nx = next[c]
            if (!alive[c / 3]) {
                if (prev < 0) head[a] = nx else next[prev] = nx
            } else {
                if (cn == cornerBuf.size) cornerBuf = cornerBuf.copyOf(cn * 2)
                cornerBuf[cn++] = c
                prev = c
                val c1 = MeshTopology.nextInFace(c); val c2 = MeshTopology.prevInFace(c)
                val wa = fwed[c]
                if (wedgeKinds == 0) { wedge0 = wa; wedgeKinds = 1 } else if (wa != wedge0) {
                    if (wedgeKinds == 1) { wedge1 = wa; wedgeKinds = 2 } else if (wa != wedge1) wedgeKinds = 3
                }
                visitNeighbour(fw[c1], wa, fwed[c1])
                visitNeighbour(fw[c2], wa, fwed[c2])
                ringArea += triArea(a, fw[c1], fw[c2])
            }
            c = nx
        }
    }

    private fun triArea(a: Int, b: Int, c: Int): Double {
        val ax = wp[3 * a]; val ay = wp[3 * a + 1]; val az = wp[3 * a + 2]
        val e1x = wp[3 * b] - ax; val e1y = wp[3 * b + 1] - ay; val e1z = wp[3 * b + 2] - az
        val e2x = wp[3 * c] - ax; val e2y = wp[3 * c + 1] - ay; val e2z = wp[3 * c + 2] - az
        val nx = e1y * e2z - e1z * e2y; val ny = e1z * e2x - e1x * e2z; val nz = e1x * e2y - e1y * e2x
        return 0.5 * sqrt(nx * nx + ny * ny + nz * nz)
    }

    /** (Q[wa] + Q[wn]) evaluated at the location of wedge [wn], which sits on welded vertex [n]. */
    private fun wedgeError(wa: Int, wn: Int, n: Int): Double {
        x[0] = wp[3 * n]; x[1] = wp[3 * n + 1]; x[2] = wp[3 * n + 2]
        if (dim == 5) { x[3] = wedgeU[wn]; x[4] = wedgeV[wn] }
        val oa = wa * qn; val ob = wn * qn
        var k = 0
        var r = 0.0
        for (i in 0 until dim) {
            val xi = x[i]
            r += (q[oa + k] + q[ob + k]) * xi * xi; k++
            for (j in i + 1 until dim) { r += 2.0 * (q[oa + k] + q[ob + k]) * xi * x[j]; k++ }
        }
        for (i in 0 until dim) { r += 2.0 * (q[oa + k] + q[ob + k]) * x[i]; k++ }
        r += q[oa + k] + q[ob + k]
        return if (r > 0.0) r else 0.0
    }

    // ------------------------------------------------------------------ candidate evaluation

    /** Find the cheapest legal collapse of welded vertex [a] and (re)queue it. Requires no gather() state. */
    private fun evaluate(a: Int) {
        target[a] = -1
        if (!vAlive[a]) { heap.remove(a); return }
        gather(a)
        if (cn == 0) { vAlive[a] = false; heap.remove(a); return }
        var boundaryEdges = 0
        var nonManifold = false
        for (s in 0 until rn) { if (shared[s] == 1) boundaryEdges++ else if (shared[s] > 2) nonManifold = true }
        val isBoundary = boundaryEdges > 0
        if (nonManifold || wedgeKinds > 2 || (isBoundary && (boundaryEdges != 2 || opt.lockBoundary))) {
            heap.remove(a); return
        }
        var any = false
        for (s in 0 until rn) {
            val n = nb[s]
            val sh = shared[s]
            var c = Double.POSITIVE_INFINITY
            if (!(isBoundary && sh != 1)) {
                if (wedgeKinds == 1) {
                    if (sh == 1 || pairN[2 * s] == pairN[2 * s + 1]) c = wedgeError(wedge0, pairN[2 * s], n)
                } else if (sh == 2 && pairA[2 * s] != pairA[2 * s + 1]) {
                    c = wedgeError(pairA[2 * s], pairN[2 * s], n) + wedgeError(pairA[2 * s + 1], pairN[2 * s + 1], n)
                }
                if (c < Double.POSITIVE_INFINITY) {
                    val dx = wp[3 * a] - wp[3 * n]; val dy = wp[3 * a + 1] - wp[3 * n + 1]; val dz = wp[3 * a + 2] - wp[3 * n + 2]
                    c += REGULARISATION * ringArea * (dx * dx + dy * dy + dz * dz)
                    if (c.isNaN()) c = Double.POSITIVE_INFINITY else any = true
                }
            }
            cost[s] = c
        }
        while (any) {
            var best = -1
            for (s in 0 until rn) {
                val c = cost[s]
                if (c < Double.POSITIVE_INFINITY && (best < 0 || c < cost[best] || (c == cost[best] && nb[s] < nb[best]))) best = s
            }
            if (best < 0) break
            if (isLegal(a, best)) {
                target[a] = nb[best]
                heap.update(a, cost[best])
                return
            }
            cost[best] = Double.POSITIVE_INFINITY
        }
        heap.remove(a)
    }

    private fun partnerOf(wedgeA: Int, slot: Int): Int =
        if (wedgeKinds == 1 || pairA[2 * slot] == wedgeA) pairN[2 * slot] else pairN[2 * slot + 1]

    /** Topological and geometric checks for collapsing [a] into the neighbour in ring slot [slot]. Uses gather(a) state. */
    private fun isLegal(a: Int, slot: Int): Boolean {
        val n = nb[slot]
        // link condition: the only common neighbours are the vertices opposite the shared faces
        stamp2++
        var c = head[n]
        while (c >= 0) {
            if (alive[c / 3]) {
                mark2[fw[MeshTopology.nextInFace(c)]] = stamp2
                mark2[fw[MeshTopology.prevInFace(c)]] = stamp2
            }
            c = next[c]
        }
        var common = 0
        for (s in 0 until rn) if (s != slot && mark2[nb[s]] == stamp2) common++
        if (common != shared[slot]) return false

        val ax = wp[3 * a]; val ay = wp[3 * a + 1]; val az = wp[3 * a + 2]
        val bx = wp[3 * n]; val by = wp[3 * n + 1]; val bz = wp[3 * n + 2]
        for (i in 0 until cn) {
            val ca = cornerBuf[i]
            val c1 = MeshTopology.nextInFace(ca); val c2 = MeshTopology.prevInFace(ca)
            val v1 = fw[c1]; val v2 = fw[c2]
            if (v1 == n || v2 == n) continue
            if (mark2[v1] == stamp2 && mark2[v2] == stamp2 && faceExists(n, v1, v2)) return false
            val p1x = wp[3 * v1]; val p1y = wp[3 * v1 + 1]; val p1z = wp[3 * v1 + 2]
            val p2x = wp[3 * v2]; val p2y = wp[3 * v2 + 1]; val p2z = wp[3 * v2 + 2]
            val dx = p2x - p1x; val dy = p2y - p1y; val dz = p2z - p1z
            val opp2 = dx * dx + dy * dy + dz * dz
            // old triangle (a, v1, v2)
            var e1x = p1x - ax; var e1y = p1y - ay; var e1z = p1z - az
            var e2x = p2x - ax; var e2y = p2y - ay; var e2z = p2z - az
            val ox = e1y * e2z - e1z * e2y; val oy = e1z * e2x - e1x * e2z; val oz = e1x * e2y - e1y * e2x
            val oldMax = maxOf(opp2, e1x * e1x + e1y * e1y + e1z * e1z, e2x * e2x + e2y * e2y + e2z * e2z)
            // new triangle (n, v1, v2)
            e1x = p1x - bx; e1y = p1y - by; e1z = p1z - bz
            e2x = p2x - bx; e2y = p2y - by; e2z = p2z - bz
            val nx = e1y * e2z - e1z * e2y; val ny = e1z * e2x - e1x * e2z; val nz = e1x * e2y - e1y * e2x
            val newMax = maxOf(opp2, e1x * e1x + e1y * e1y + e1z * e1z, e2x * e2x + e2y * e2y + e2z * e2z)
            val o2 = ox * ox + oy * oy + oz * oz
            val n2 = nx * nx + ny * ny + nz * nz
            val oldQuality = if (oldMax > 0.0) o2 / (oldMax * oldMax) else 0.0
            val newQuality = if (newMax > 0.0) n2 / (newMax * newMax) else 0.0
            // no (near-)degenerate triangles, unless the triangle was at least as bad before
            if (newQuality < MIN_QUALITY && newQuality <= oldQuality) return false
            // no normal flips
            if (oldQuality >= MIN_QUALITY) {
                val dot = ox * nx + oy * ny + oz * nz
                if (!(dot > MIN_NORMAL_COS * sqrt(o2 * n2))) return false
            }
            // The face must not turn away from the input surface: its normal has to stay within
            // the allowed angle of the original smooth normal at each of its corners (or at least
            // not get worse where the input already exceeds it). Comparing against the previous
            // state alone would let the error creep, e.g. into thin triangles that span a curved
            // region edge-on and end up nearly perpendicular to the surface.
            if (n2 > 0.0) {
                val inl = 1.0 / sqrt(n2)
                val iol = if (o2 > 0.0) 1.0 / sqrt(o2) else 0.0
                val wa = fwed[ca]
                if (turnsAway(nx, ny, nz, inl, ox, oy, oz, iol, partnerOf(wa, slot), wa) ||
                    turnsAway(nx, ny, nz, inl, ox, oy, oz, iol, fwed[c1], fwed[c1]) ||
                    turnsAway(nx, ny, nz, inl, ox, oy, oz, iol, fwed[c2], fwed[c2])
                ) return false
            }
            // no flips or collapses in texture space
            if (uvs != null) {
                val ba = 2 * wedgeBase[fwed[ca]]
                val bp = 2 * wedgeBase[partnerOf(fwed[ca], slot)]
                val b1 = 2 * wedgeBase[fwed[c1]]; val b2 = 2 * wedgeBase[fwed[c2]]
                val u1 = uvs[b1].toDouble(); val w1 = uvs[b1 + 1].toDouble()
                val u2 = uvs[b2].toDouble(); val w2 = uvs[b2 + 1].toDouble()
                val oldUv = (u1 - uvs[ba]) * (w2 - uvs[ba + 1]) - (w1 - uvs[ba + 1]) * (u2 - uvs[ba])
                val newUv = (u1 - uvs[bp]) * (w2 - uvs[bp + 1]) - (w1 - uvs[bp + 1]) * (u2 - uvs[bp])
                if ((oldUv > 0.0 && !(newUv > 0.0)) || (oldUv < 0.0 && !(newUv < 0.0))) return false
            }
        }
        return true
    }

    /**
     * True if the new face normal (n, scaled by [inl]) deviates from the reference normal of
     * [newWedge] by more than the allowed angle *and* by more than the old normal (o, scaled by
     * [iol]) deviated from the reference normal of [oldWedge].
     */
    private fun turnsAway(
        nx: Double, ny: Double, nz: Double, inl: Double, ox: Double, oy: Double, oz: Double, iol: Double, newWedge: Int, oldWedge: Int,
    ): Boolean {
        val r = 3 * newWedge
        val dNew = (nx * refN[r] + ny * refN[r + 1] + nz * refN[r + 2]) * inl
        if (dNew >= minRefCos) return false
        if (iol == 0.0) return false // the old face was degenerate: anything is an improvement
        val ro = 3 * oldWedge
        val dOld = (ox * refN[ro] + oy * refN[ro + 1] + oz * refN[ro + 2]) * iol
        return dNew < dOld - 1e-9
    }

    private fun faceExists(n: Int, v1: Int, v2: Int): Boolean {
        var c = head[n]
        while (c >= 0) {
            if (alive[c / 3]) {
                val a = fw[MeshTopology.nextInFace(c)]; val b = fw[MeshTopology.prevInFace(c)]
                if ((a == v1 && b == v2) || (a == v2 && b == v1)) return true
            }
            c = next[c]
        }
        return false
    }

    // ------------------------------------------------------------------ collapse

    private fun collapse(a: Int) {
        val n = target[a]
        gather(a)
        if (n < 0 || mark[n] != stamp) { evaluate(a); return } // defensive: stale candidate
        val slot = slotOf[n]
        // merge wedge quadrics and confidence
        mergeWedge(wedge0, partnerOf(wedge0, slot))
        if (wedgeKinds == 2) mergeWedge(wedge1, partnerOf(wedge1, slot))
        // re-link faces
        for (i in 0 until cn) {
            val c = cornerBuf[i]
            val f = c / 3
            val base = 3 * f
            if (fw[base] == n || fw[base + 1] == n || fw[base + 2] == n) {
                alive[f] = false
                faces--
            } else {
                fw[c] = n
                fwed[c] = partnerOf(fwed[c], slot)
                next[c] = head[n]; head[n] = c
            }
        }
        head[a] = -1
        vAlive[a] = false
        heap.remove(a)
        // the 1-ring changed for n and for every neighbour of n
        gather(n)
        val count = rn
        if (tmpRing.size < count) tmpRing = IntArray(count * 2)
        System.arraycopy(nb, 0, tmpRing, 0, count)
        val ring = tmpRing
        for (i in 0 until count) evaluate(ring[i])
        evaluate(n)
    }

    private fun mergeWedge(from: Int, to: Int) {
        val of = from * qn; val ot = to * qn
        for (i in 0 until qn) q[ot + i] += q[of + i]
        if (wedgeConf[from] < wedgeConf[to]) wedgeConf[to] = wedgeConf[from]
    }

    // ------------------------------------------------------------------ output

    private fun buildResult(): Mesh {
        val vCount = mesh.vertexCount
        val outId = IntArray(vCount) { -1 }
        for (f in 0 until faceTotal) {
            if (!alive[f]) continue
            for (k in 0 until 3) outId[wedgeBase[fwed[3 * f + k]]] = 0
        }
        var nv = 0
        for (v in 0 until vCount) if (outId[v] == 0) outId[v] = nv++
        val positions = FloatArray(3 * nv)
        val srcN = mesh.normals
        val normals = if (srcN != null) FloatArray(3 * nv) else null
        val outUv = if (uvs != null) FloatArray(2 * nv) else null
        val conf = if (mesh.confidence != null) FloatArray(nv) { Float.POSITIVE_INFINITY } else null
        for (v in 0 until vCount) {
            val o = outId[v]
            if (o < 0) continue
            positions[3 * o] = mesh.positions[3 * v]; positions[3 * o + 1] = mesh.positions[3 * v + 1]; positions[3 * o + 2] = mesh.positions[3 * v + 2]
            if (normals != null) { normals[3 * o] = srcN!![3 * v]; normals[3 * o + 1] = srcN[3 * v + 1]; normals[3 * o + 2] = srcN[3 * v + 2] }
            if (outUv != null) { outUv[2 * o] = uvs!![2 * v]; outUv[2 * o + 1] = uvs[2 * v + 1] }
        }
        val indices = IntArray(3 * faces)
        val faceMaterial = mesh.faceMaterial?.let { IntArray(faces) }
        var o = 0
        for (f in 0 until faceTotal) {
            if (!alive[f]) continue
            for (k in 0 until 3) {
                val wd = fwed[3 * f + k]
                val id = outId[wedgeBase[wd]]
                indices[3 * o + k] = id
                if (conf != null && wedgeConf[wd] < conf[id]) conf[id] = wedgeConf[wd]
            }
            if (faceMaterial != null) faceMaterial[o] = mesh.faceMaterial!![f]
            o++
        }
        var out = Mesh(positions, normals, outUv, conf, indices, faceMaterial, mesh.materials)
        if (normals != null && opt.recomputeNormals) {
            val t = MeshTopology.build(out)
            out = out.copy(normals = computeWeldedNormals(positions, indices, t.weldOf, t.weldedCount))
        }
        return out
    }

    private companion object {
        /** Tie-breaker towards short edges where the quadric error is (near) zero, e.g. on flat areas. */
        const val REGULARISATION = 1e-6
        /** Minimum (2 * area / longest edge^2)^2 of a triangle created by a collapse. */
        const val MIN_QUALITY = 1e-6
        /** Minimum cosine between a face normal before and after a collapse. */
        const val MIN_NORMAL_COS = 0.2
    }
}
