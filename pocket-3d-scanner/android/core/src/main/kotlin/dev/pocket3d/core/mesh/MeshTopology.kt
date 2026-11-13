package dev.pocket3d.core.mesh

/**
 * Connectivity of a [Mesh] after welding render vertices that share an *exactly* identical
 * position (UV-seam duplicates) into topological ("welded") vertices.
 *
 * Terminology:
 *  - *half-edge* `h = 3 * face + corner`: the directed edge from corner `corner` of the face to the
 *    next corner (`(corner + 1) % 3`), in the face's winding order.
 *  - *edge*: an undirected pair of welded vertices, with the list of half-edges lying on it.
 *    1 half-edge = open boundary, 2 = regular interior edge, > 2 = non-manifold.
 *
 * Faces that are degenerate after welding (two corners at the same position) take no part in the
 * edge structure: their [faceEdges] entries are -1 and each one forms its own connected component.
 *
 * Everything is stored in flat primitive arrays; building is O(V + F) with open-addressing hash
 * tables, so a 500k-face mesh takes well under a second on a phone-class CPU.
 * Instances are immutable and safe to share between threads.
 */
class MeshTopology private constructor(
    /** Render vertex count of the source mesh. */
    val vertexCount: Int,
    val faceCount: Int,
    /** Number of distinct vertex positions. */
    val weldedCount: Int,
    /** Render vertex -> welded vertex id (size [vertexCount]). */
    val weldOf: IntArray,
    /** Welded vertex id -> lowest render vertex index having that position (size [weldedCount]). */
    val weldedRepresentative: IntArray,
    /** Welded vertex ids per face corner (size 3 * [faceCount]). */
    val faceWelded: IntArray,
    val edgeCount: Int,
    /** Smaller welded vertex id of each edge. */
    val edgeV0: IntArray,
    /** Larger welded vertex id of each edge. */
    val edgeV1: IntArray,
    /** Edge id of each half-edge (size 3 * [faceCount]); -1 for welded-degenerate faces. */
    val faceEdges: IntArray,
    private val edgeStart: IntArray,
    private val edgeHalfEdges: IntArray,
) {
    /** Number of faces (half-edges) on edge [e]. */
    fun edgeFaceCount(e: Int): Int = edgeStart[e + 1] - edgeStart[e]

    /** The [i]-th half-edge (`3 * face + corner`) on edge [e], `i < edgeFaceCount(e)`. */
    fun edgeHalfEdge(e: Int, i: Int): Int = edgeHalfEdges[edgeStart[e] + i]

    /** The [i]-th face on edge [e]. */
    fun edgeFace(e: Int, i: Int): Int = edgeHalfEdges[edgeStart[e] + i] / 3

    fun isBoundaryEdge(e: Int): Boolean = edgeFaceCount(e) == 1
    fun isNonManifoldEdge(e: Int): Boolean = edgeFaceCount(e) > 2

    /** Edges with exactly one face. */
    val boundaryEdgeCount: Int by lazy(LazyThreadSafetyMode.PUBLICATION) {
        var n = 0
        for (e in 0 until edgeCount) if (edgeFaceCount(e) == 1) n++
        n
    }

    /** Edges shared by more than two faces. */
    val nonManifoldEdgeCount: Int by lazy(LazyThreadSafetyMode.PUBLICATION) {
        var n = 0
        for (e in 0 until edgeCount) if (edgeFaceCount(e) > 2) n++
        n
    }

    /** Ids of all boundary edges, ascending. */
    fun boundaryEdges(): IntArray {
        val out = IntList()
        for (e in 0 until edgeCount) if (edgeFaceCount(e) == 1) out.add(e)
        return out.toArray()
    }

    /** Ids of all non-manifold edges, ascending. */
    fun nonManifoldEdges(): IntArray {
        val out = IntList()
        for (e in 0 until edgeCount) if (edgeFaceCount(e) > 2) out.add(e)
        return out.toArray()
    }

    /**
     * The face on the other side of half-edge `3 * face + corner`, or -1 if the edge is a boundary,
     * non-manifold, or the face is degenerate.
     */
    fun adjacentFace(face: Int, corner: Int): Int {
        val h = oppositeHalfEdge(3 * face + corner)
        return if (h < 0) -1 else h / 3
    }

    /** The other half-edge on a 2-face edge, or -1. */
    internal fun oppositeHalfEdge(h: Int): Int {
        val e = faceEdges[h]
        if (e < 0) return -1
        val s = edgeStart[e]
        if (edgeStart[e + 1] - s != 2) return -1
        return if (edgeHalfEdges[s] == h) edgeHalfEdges[s + 1] else edgeHalfEdges[s]
    }

    private val loops: List<IntArray> by lazy(LazyThreadSafetyMode.PUBLICATION) { computeBoundaryLoops() }

    /**
     * Closed boundary loops as ordered half-edge ids. Consecutive half-edges are head-to-tail and
     * follow the winding of their faces (the surface is on the left of the direction of travel
     * when seen from the front side).
     *
     * Every loop is *simple*: it passes through each welded vertex at most once. Where boundaries
     * touch in a single vertex (two holes meeting corner to corner, or two surface patches joined
     * at one point) they are reported as separate loops. Each loop starts at its lowest half-edge
     * id and loops are ordered by that id, so the result is deterministic.
     *
     * Boundary edge chains that do not close (possible only around non-manifold or
     * inconsistently wound geometry) are not reported.
     */
    fun boundaryLoopHalfEdges(): List<IntArray> = loops

    /** Same loops as [boundaryLoopHalfEdges], as ordered welded vertex ids (origin of each half-edge). */
    fun boundaryLoops(): List<IntArray> = loops.map { l -> IntArray(l.size) { faceWelded[l[it]] } }

    private fun computeBoundaryLoops(): List<IntArray> {
        val result = ArrayList<IntArray>()
        if (boundaryEdgeCount == 0) return result
        val heCount = 3 * faceCount
        val isBoundaryHe = BooleanArray(heCount)
        // Fallback lookup: boundary half-edges by origin vertex (singly linked lists).
        val outHead = IntArray(weldedCount) { -1 }
        val outNext = IntArray(heCount) { -1 }
        for (h in heCount - 1 downTo 0) {
            val e = faceEdges[h]
            if (e >= 0 && edgeFaceCount(e) == 1) {
                isBoundaryHe[h] = true
                val o = faceWelded[h]
                outNext[h] = outHead[o]; outHead[o] = h
            }
        }
        val visited = BooleanArray(heCount)
        val cur = IntList()
        val stack = IntArray(boundaryEdgeCount)
        val stackPos = IntArray(weldedCount) { -1 }
        for (start in 0 until heCount) {
            if (!isBoundaryHe[start] || visited[start]) continue
            cur.clear()
            var h = start
            var closed = false
            while (true) {
                visited[h] = true
                cur.add(h)
                val n = nextBoundaryHalfEdge(h, isBoundaryHe, visited, outHead, outNext)
                if (n == start) { closed = true; break }
                if (n < 0 || visited[n]) break
                h = n
            }
            if (!closed) continue
            // Split the closed walk at vertices it passes more than once, giving simple loops.
            var sp = 0
            for (i in 0 until cur.size) {
                val he = cur[i]
                val origin = faceWelded[he]
                val at = stackPos[origin]
                if (at >= 0) {
                    result.add(normalisedLoop(stack, at, sp))
                    for (k in at until sp) stackPos[faceWelded[stack[k]]] = -1
                    sp = at
                }
                stackPos[origin] = sp
                stack[sp++] = he
            }
            result.add(normalisedLoop(stack, 0, sp))
            for (k in 0 until sp) stackPos[faceWelded[stack[k]]] = -1
        }
        result.sortBy { it[0] }
        return result
    }

    /** Copy of `stack[from until to]`, rotated to start at its smallest element. */
    private fun normalisedLoop(stack: IntArray, from: Int, to: Int): IntArray {
        val n = to - from
        var best = 0
        for (i in 1 until n) if (stack[from + i] < stack[from + best]) best = i
        return IntArray(n) { stack[from + (best + it) % n] }
    }

    /** Boundary half-edge following [h] around the head vertex of [h]. */
    private fun nextBoundaryHalfEdge(
        h: Int, isBoundaryHe: BooleanArray, visited: BooleanArray, outHead: IntArray, outNext: IntArray,
    ): Int {
        val pivot = faceWelded[nextInFace(h)]
        // Rotate around the pivot through the fan of faces until the next boundary edge.
        var cand = nextInFace(h)
        var guard = 0
        while (guard++ < 3 * faceCount) {
            if (isBoundaryHe[cand]) return cand
            val opp = oppositeHalfEdge(cand)
            if (opp < 0) break
            // In a consistently wound mesh the opposite half-edge ends at the pivot.
            if (faceWelded[nextInFace(opp)] != pivot) break
            cand = nextInFace(opp)
        }
        // Fallback for non-manifold / inconsistently wound neighbourhoods: any unvisited boundary
        // half-edge leaving the pivot.
        var o = outHead[pivot]
        var first = -1
        while (o >= 0) {
            if (!visited[o]) return o
            if (first < 0) first = o
            o = outNext[o]
        }
        return first
    }

    /** Result of [faceComponents]. */
    class FaceComponents(
        /** Component id per face, in 0 until [count]; ids are ordered by lowest contained face index. */
        val faceComponent: IntArray,
        val count: Int,
    )

    /**
     * Connected components of faces, where faces are connected when they share an edge of the
     * welded topology (including non-manifold edges). Faces touching only in a single vertex are
     * *not* connected.
     */
    fun faceComponents(): FaceComponents {
        val comp = IntArray(faceCount) { -1 }
        var count = 0
        val stack = IntList(64)
        for (seed in 0 until faceCount) {
            if (comp[seed] >= 0) continue
            comp[seed] = count
            stack.clear(); stack.add(seed)
            var sp = 1
            while (sp > 0) {
                val f = stack[--sp]
                for (k in 0 until 3) {
                    val e = faceEdges[3 * f + k]
                    if (e < 0) continue
                    for (i in edgeStart[e] until edgeStart[e + 1]) {
                        val g = edgeHalfEdges[i] / 3
                        if (comp[g] < 0) {
                            comp[g] = count
                            if (sp < stack.size) stack[sp] = g else stack.add(g)
                            sp++
                        }
                    }
                }
            }
            count++
        }
        return FaceComponents(comp, count)
    }

    companion object {
        /** The half-edge following [h] in its face (its origin is the head of [h]). */
        fun nextInFace(h: Int): Int = if (h % 3 == 2) h - 2 else h + 1

        /** The half-edge preceding [h] in its face. */
        fun prevInFace(h: Int): Int = if (h % 3 == 0) h + 2 else h - 1

        /** Build the welded topology of [mesh]. */
        fun build(mesh: Mesh): MeshTopology {
            val pos = mesh.positions
            val idx = mesh.indices
            val vCount = mesh.vertexCount
            val fCount = mesh.faceCount

            // --- weld by exact position (with -0.0 == +0.0) ---
            val weldOf = IntArray(vCount)
            var cap = 8
            while (cap < vCount * 2L && cap < (1 shl 30)) cap = cap shl 1
            val mask = cap - 1
            val table = IntArray(cap) { -1 }
            val reps = IntList(maxOf(16, vCount / 2))
            for (v in 0 until vCount) {
                val bx = (pos[3 * v] + 0f).toRawBits()
                val by = (pos[3 * v + 1] + 0f).toRawBits()
                val bz = (pos[3 * v + 2] + 0f).toRawBits()
                var h = bx * -0x61c88647 + by
                h = h * -0x61c88647 + bz
                h = h xor (h ushr 15)
                h *= -0x7a143589
                h = h xor (h ushr 13)
                var i = h and mask
                while (true) {
                    val r = table[i]
                    if (r < 0) {
                        table[i] = v
                        weldOf[v] = reps.size
                        reps.add(v)
                        break
                    }
                    if ((pos[3 * r] + 0f).toRawBits() == bx &&
                        (pos[3 * r + 1] + 0f).toRawBits() == by &&
                        (pos[3 * r + 2] + 0f).toRawBits() == bz
                    ) {
                        weldOf[v] = weldOf[r]
                        break
                    }
                    i = (i + 1) and mask
                }
            }
            val weldedCount = reps.size

            // --- edges ---
            val fw = IntArray(idx.size) { weldOf[idx[it]] }
            val faceEdges = IntArray(idx.size) { -1 }
            val map = LongIntMap(fCount * 3 / 2 + 16)
            val ev0 = IntList(fCount * 3 / 2 + 16)
            val ev1 = IntList(fCount * 3 / 2 + 16)
            val counts = IntList(fCount * 3 / 2 + 16)
            for (f in 0 until fCount) {
                val a = fw[3 * f]; val b = fw[3 * f + 1]; val c = fw[3 * f + 2]
                if (a == b || b == c || a == c) continue
                for (k in 0 until 3) {
                    val p = fw[3 * f + k]
                    val q = fw[3 * f + (if (k == 2) 0 else k + 1)]
                    val key = edgeKey(p, q)
                    var e = map.get(key)
                    if (e < 0) {
                        e = ev0.size
                        map.put(key, e)
                        ev0.add(if (p < q) p else q)
                        ev1.add(if (p < q) q else p)
                        counts.add(0)
                    }
                    counts[e] = counts[e] + 1
                    faceEdges[3 * f + k] = e
                }
            }
            val eCount = ev0.size
            val start = IntArray(eCount + 1)
            for (e in 0 until eCount) start[e + 1] = start[e] + counts[e]
            val fill = start.copyOf(eCount)
            val hes = IntArray(start[eCount])
            for (h in faceEdges.indices) {
                val e = faceEdges[h]
                if (e >= 0) hes[fill[e]++] = h
            }
            return MeshTopology(
                vCount, fCount, weldedCount, weldOf, reps.toArray(), fw,
                eCount, ev0.toArray(), ev1.toArray(), faceEdges, start, hes,
            )
        }
    }
}
