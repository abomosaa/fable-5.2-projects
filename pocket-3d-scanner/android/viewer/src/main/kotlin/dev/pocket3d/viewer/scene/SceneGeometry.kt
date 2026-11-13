package dev.pocket3d.viewer.scene

import dev.pocket3d.core.capture.CoverageGrid
import dev.pocket3d.core.edit.EditDocument
import dev.pocket3d.core.edit.EditOp
import dev.pocket3d.core.math.Mat4
import dev.pocket3d.core.math.Quat
import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.mesh.Aabb
import dev.pocket3d.core.mesh.Hole
import dev.pocket3d.core.mesh.Material
import dev.pocket3d.core.mesh.Mesh
import dev.pocket3d.core.project.ModelCamera
import dev.pocket3d.viewer.camera.OrbitCamera
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tan

/**
 * GPU-ready copy of a mesh: one interleaved vertex buffer (position, normal, uv, confidence =
 * [STRIDE_FLOATS] floats) and one 32-bit index buffer in which the faces are grouped by material,
 * so each material is one `glDrawElements` range. Built off the GL thread.
 */
class MeshBuffers(
    val vertexData: ByteBuffer,
    val vertexCount: Int,
    val indexData: ByteBuffer,
    val indexCount: Int,
    val ranges: List<Range>,
    val bounds: Aabb,
    val hasUvs: Boolean,
    val hasConfidence: Boolean,
) {
    /** [first] and [count] are in indices (not bytes, not faces). */
    class Range(val material: Material, val materialIndex: Int, val first: Int, val count: Int)

    val faceCount: Int get() = indexCount / 3

    companion object {
        const val STRIDE_FLOATS = 9
        const val STRIDE_BYTES = STRIDE_FLOATS * 4

        fun build(mesh: Mesh): MeshBuffers {
            val vCount = mesh.vertexCount
            val fCount = mesh.faceCount
            val pos = mesh.positions
            val nrm = mesh.normals ?: computeNormals(mesh)
            val uv = mesh.uvs
            val conf = mesh.confidence
            val vb = ByteBuffer.allocateDirect(vCount * STRIDE_BYTES).order(ByteOrder.nativeOrder())
            val fb = vb.asFloatBuffer()
            val row = FloatArray(STRIDE_FLOATS)
            for (i in 0 until vCount) {
                row[0] = pos[3 * i]; row[1] = pos[3 * i + 1]; row[2] = pos[3 * i + 2]
                row[3] = nrm[3 * i]; row[4] = nrm[3 * i + 1]; row[5] = nrm[3 * i + 2]
                if (uv != null) { row[6] = uv[2 * i]; row[7] = uv[2 * i + 1] } else { row[6] = 0f; row[7] = 0f }
                // Without evidence data nothing is claimed either way; 1 keeps such meshes neutral in
                // the evidence view (which is disabled in the UI for them anyway).
                row[8] = conf?.get(i) ?: 1f
                fb.put(row)
            }
            // group faces by material (stable)
            val matCount = max(mesh.materials.size, 1)
            val perMat = IntArray(matCount)
            for (f in 0 until fCount) perMat[mesh.materialOfFace(f).coerceIn(0, matCount - 1)]++
            val start = IntArray(matCount)
            for (m in 1 until matCount) start[m] = start[m - 1] + perMat[m - 1]
            val cursor = start.copyOf()
            val ib = ByteBuffer.allocateDirect(fCount * 12).order(ByteOrder.nativeOrder())
            val ii = ib.asIntBuffer()
            val idx = mesh.indices
            for (f in 0 until fCount) {
                val m = mesh.materialOfFace(f).coerceIn(0, matCount - 1)
                val at = cursor[m]++ * 3
                ii.put(at, idx[3 * f]); ii.put(at + 1, idx[3 * f + 1]); ii.put(at + 2, idx[3 * f + 2])
            }
            val fallback = Material("default")
            val ranges = ArrayList<Range>()
            for (m in 0 until matCount) if (perMat[m] > 0)
                ranges += Range(mesh.materials.getOrNull(m) ?: fallback, m, start[m] * 3, perMat[m] * 3)
            return MeshBuffers(vb, vCount, ib, fCount * 3, ranges, Aabb.of(pos), uv != null, conf != null)
        }

        /** Area-weighted vertex normals per render vertex (only used when a mesh comes without normals). */
        fun computeNormals(mesh: Mesh): FloatArray {
            val pos = mesh.positions; val idx = mesh.indices
            val n = FloatArray(pos.size)
            for (f in 0 until mesh.faceCount) {
                val a = idx[3 * f] * 3; val b = idx[3 * f + 1] * 3; val c = idx[3 * f + 2] * 3
                val e1x = pos[b] - pos[a]; val e1y = pos[b + 1] - pos[a + 1]; val e1z = pos[b + 2] - pos[a + 2]
                val e2x = pos[c] - pos[a]; val e2y = pos[c + 1] - pos[a + 1]; val e2z = pos[c + 2] - pos[a + 2]
                val nx = e1y * e2z - e1z * e2y; val ny = e1z * e2x - e1x * e2z; val nz = e1x * e2y - e1y * e2x
                for (v in intArrayOf(a, b, c)) { n[v] += nx; n[v + 1] += ny; n[v + 2] += nz }
            }
            var i = 0
            while (i < n.size) {
                val l = sqrt(n[i] * n[i] + n[i + 1] * n[i + 1] + n[i + 2] * n[i + 2])
                if (l > 1e-20f) { n[i] /= l; n[i + 1] /= l; n[i + 2] /= l } else { n[i] = 0f; n[i + 1] = 1f; n[i + 2] = 0f }
                i += 3
            }
            return n
        }

        /** Index buffer (direct, native order) with the three indices of every face where [mask] is true. */
        fun selectionIndices(mesh: Mesh, mask: BooleanArray): ByteBuffer {
            var n = 0
            for (m in mask) if (m) n++
            val bb = ByteBuffer.allocateDirect(n * 12).order(ByteOrder.nativeOrder())
            val ib = bb.asIntBuffer()
            val idx = mesh.indices
            for (f in mask.indices) if (mask[f]) { ib.put(idx[3 * f]); ib.put(idx[3 * f + 1]); ib.put(idx[3 * f + 2]) }
            return bb
        }
    }
}

/** De-duplicated edge list for the wireframe view. */
object WireEdges {
    /** Vertex index pairs (a0, b0, a1, b1, …), each undirected edge once. */
    fun build(indices: IntArray): IntArray {
        val fCount = indices.size / 3
        val keys = LongArray(fCount * 3)
        var k = 0
        for (f in 0 until fCount) {
            val a = indices[3 * f]; val b = indices[3 * f + 1]; val c = indices[3 * f + 2]
            keys[k++] = key(a, b); keys[k++] = key(b, c); keys[k++] = key(c, a)
        }
        keys.sort()
        var unique = 0
        for (i in keys.indices) if (i == 0 || keys[i] != keys[i - 1]) unique++
        val out = IntArray(unique * 2)
        var o = 0
        for (i in keys.indices) if (i == 0 || keys[i] != keys[i - 1]) {
            out[o++] = (keys[i] ushr 32).toInt(); out[o++] = (keys[i] and 0xffffffffL).toInt()
        }
        return out
    }

    private fun key(a: Int, b: Int): Long = if (a < b) (a.toLong() shl 32) or b.toLong() else (b.toLong() shl 32) or a.toLong()

    fun toBuffer(edges: IntArray): ByteBuffer {
        val bb = ByteBuffer.allocateDirect(edges.size * 4).order(ByteOrder.nativeOrder())
        bb.asIntBuffer().put(edges)
        return bb
    }
}

/**
 * A set of line segments drawn as screen-space quads of constant pixel width (wide lines are not
 * guaranteed by OpenGL ES, so they are built explicitly).
 */
class LineSet(
    /** ax, ay, az, bx, by, bz per segment. */
    val segments: FloatArray,
    /** One ARGB colour per segment. */
    val colors: IntArray,
    val widthPx: Float,
    /** False = always drawn on top of the model. */
    val depthTest: Boolean = true,
) {
    val segmentCount: Int get() = colors.size

    /**
     * Vertex data for the wide-line shader: 6 vertices per segment, each
     * (a.xyz, b.xyz, side, end, r, g, b, a) = [VERTEX_FLOATS] floats.
     */
    fun toVertexData(): FloatArray {
        val out = FloatArray(segmentCount * 6 * VERTEX_FLOATS)
        var o = 0
        for (s in 0 until segmentCount) {
            val c = colors[s]
            val a = (c ushr 24 and 0xff) / 255f; val r = (c ushr 16 and 0xff) / 255f
            val g = (c ushr 8 and 0xff) / 255f; val b = (c and 0xff) / 255f
            for (corner in 0 until 6) {
                for (j in 0 until 6) out[o++] = segments[s * 6 + j]
                out[o++] = SIDE[corner]; out[o++] = END[corner]
                out[o++] = r; out[o++] = g; out[o++] = b; out[o++] = a
            }
        }
        return out
    }

    companion object {
        const val VERTEX_FLOATS = 12
        private val SIDE = floatArrayOf(-1f, 1f, -1f, -1f, 1f, 1f)
        private val END = floatArrayOf(0f, 0f, 1f, 1f, 0f, 1f)
    }
}

class LineBuilder(initialSegments: Int = 64) {
    private var seg = FloatArray(initialSegments * 6)
    private var col = IntArray(initialSegments)
    private var n = 0

    val size: Int get() = n

    fun add(ax: Float, ay: Float, az: Float, bx: Float, by: Float, bz: Float, color: Int): LineBuilder {
        if (n == col.size) { seg = seg.copyOf(seg.size * 2); col = col.copyOf(col.size * 2) }
        val o = n * 6
        seg[o] = ax; seg[o + 1] = ay; seg[o + 2] = az; seg[o + 3] = bx; seg[o + 4] = by; seg[o + 5] = bz
        col[n++] = color
        return this
    }

    fun add(a: Vec3, b: Vec3, color: Int): LineBuilder = add(a.x, a.y, a.z, b.x, b.y, b.z, color)

    fun addSegments(segments: FloatArray, color: Int): LineBuilder {
        var i = 0
        while (i + 5 < segments.size) {
            add(segments[i], segments[i + 1], segments[i + 2], segments[i + 3], segments[i + 4], segments[i + 5], color); i += 6
        }
        return this
    }

    fun build(widthPx: Float, depthTest: Boolean = true): LineSet = LineSet(seg.copyOf(n * 6), col.copyOf(n), widthPx, depthTest)
}

/** A registered source camera placed in CURRENT model coordinates. */
class PlacedCamera(val source: ModelCamera, val position: Vec3, val rotation: Quat) {
    val fovYRad: Float get() = Math.toRadians(source.fovYDeg.coerceIn(5.0, 150.0)).toFloat()
    val aspect: Float get() = if (source.width > 0 && source.height > 0) source.width.toFloat() / source.height else 1.5f
    val forward: Vec3 get() = -rotation.rotate(Vec3.Z)
}

object SceneBuilders {
    /** Cumulative rotation of all Reorient edits (base → current). */
    fun currentRotation(doc: EditDocument?): Quat {
        var q = Quat.IDENTITY
        if (doc != null) for (op in doc.ops) if (op is EditOp.Reorient) q = (op.rotation * q).normalized()
        return q
    }

    /** Source cameras from cameras.json (base frame) moved into the current frame of the edit stack. */
    fun placeCameras(cameras: List<ModelCamera>, doc: EditDocument?): List<PlacedCamera> {
        val m = doc?.currentFromBase() ?: Mat4.identity()
        val r = currentRotation(doc)
        return cameras.filter { it.position.size == 3 && it.q.size == 4 }.map { c ->
            val q = Quat(c.q[0].toFloat(), c.q[1].toFloat(), c.q[2].toFloat(), c.q[3].toFloat()).normalized()
            PlacedCamera(c, Mat4.transformPoint(m, c.positionVec), (r * q).normalized())
        }
    }

    /** Wire pyramid of a camera: apex at the camera, base [size] in front of it, plus a tick marking "up". */
    fun addFrustum(b: LineBuilder, cam: PlacedCamera, size: Float, color: Int) {
        val tv = tan(cam.fovYRad / 2f); val th = tv * cam.aspect
        // keep very wide cameras from producing huge pyramids
        val k = size / max(1f, hypot(th, tv))
        val q = cam.rotation
        val c0 = cam.position
        val p00 = c0 + q.rotate(Vec3(-th * k, -tv * k, -k))
        val p10 = c0 + q.rotate(Vec3(th * k, -tv * k, -k))
        val p11 = c0 + q.rotate(Vec3(th * k, tv * k, -k))
        val p01 = c0 + q.rotate(Vec3(-th * k, tv * k, -k))
        b.add(c0, p00, color).add(c0, p10, color).add(c0, p11, color).add(c0, p01, color)
        b.add(p00, p10, color).add(p10, p11, color).add(p11, p01, color).add(p01, p00, color)
        val tip = c0 + q.rotate(Vec3(0f, tv * k * 1.45f, -k))
        b.add(p01.lerp(p11, 0.3f), tip, color).add(tip, p01.lerp(p11, 0.7f), color)
    }

    fun frusta(cameras: List<PlacedCamera>, size: Float, color: Int, selectedId: String?, selectedColor: Int): LineBuilder {
        val b = LineBuilder(cameras.size * 10 + 4)
        for (c in cameras) addFrustum(b, c, if (c.source.id == selectedId) size * 1.5f else size,
                                      if (c.source.id == selectedId) selectedColor else color)
        return b
    }

    /** Closed hole loops as segments. */
    fun addHoleLoops(b: LineBuilder, holes: List<Hole>, color: (Hole) -> Int) {
        for (h in holes) {
            val c = color(h)
            val n = h.edgeCount
            val v = h.vertices
            for (i in 0 until n) {
                val j = (i + 1) % n
                b.add(v[3 * i], v[3 * i + 1], v[3 * i + 2], v[3 * j], v[3 * j + 1], v[3 * j + 2], c)
            }
        }
    }

    /** Circle of [radius] around [center] in the plane spanned by unit vectors [u] and [v]. */
    fun addCircle(b: LineBuilder, center: Vec3, u: Vec3, v: Vec3, radius: Float, color: Int, steps: Int = 64) {
        var prev = center + u * radius
        for (i in 1..steps) {
            val a = 2.0 * PI * i / steps
            val p = center + u * (radius * cos(a).toFloat()) + v * (radius * sin(a).toFloat())
            b.add(prev, p, color); prev = p
        }
    }

    /** Three great circles — a see-through sphere. */
    fun addSphere(b: LineBuilder, center: Vec3, radius: Float, color: Int) {
        addCircle(b, center, Vec3.X, Vec3.Z, radius, color)
        addCircle(b, center, Vec3.X, Vec3.Y, radius, color)
        addCircle(b, center, Vec3.Z, Vec3.Y, radius, color)
    }

    /** Two unit vectors spanning the plane with unit normal [n]. */
    fun planeBasis(n: Vec3): Pair<Vec3, Vec3> {
        val helper = if (abs(n.y) < 0.9f) Vec3.Y else Vec3.X
        val u = helper.cross(n).normalized()
        val v = n.cross(u).normalized()
        return u to v
    }

    /** A "nice" grid spacing (1, 2 or 5 × 10^k) giving roughly [targetCells] cells across [extent]. */
    fun niceStep(extent: Float, targetCells: Int = 10): Float {
        if (!(extent > 0f) || extent.isInfinite()) return 1f
        val raw = extent / targetCells
        val p = 10.0.pow(floor(log10(raw.toDouble())))
        val f = raw / p
        val nice = if (f < 1.5) 1.0 else if (f < 3.5) 2.0 else if (f < 7.5) 5.0 else 10.0
        return (nice * p).toFloat()
    }

    /**
     * Square grid of thin lines in the plane through [center] with normal [normal]; returned as
     * xyz pairs for `GL_LINES`. [halfExtent] is rounded up to a whole number of [step]s.
     */
    fun grid(center: Vec3, normal: Vec3, halfExtent: Float, step: Float): FloatArray {
        val (u, v) = planeBasis(normal.normalized())
        val n = max(1, Math.ceil((halfExtent / step).toDouble()).toInt()).coerceAtMost(200)
        val e = n * step
        val out = FloatArray((2 * n + 1) * 2 * 6)
        var o = 0
        fun put(p: Vec3) { out[o++] = p.x; out[o++] = p.y; out[o++] = p.z }
        for (i in -n..n) {
            val t = i * step
            put(center + u * t - v * e); put(center + u * t + v * e)
            put(center + v * t - u * e); put(center + v * t + u * e)
        }
        return out
    }

    /** Segments of a rectangle outline in the plane (for the trim-plane preview). */
    fun addPlaneQuad(b: LineBuilder, point: Vec3, normal: Vec3, halfExtent: Float, color: Int) {
        val (u, v) = planeBasis(normal.normalized())
        val c = arrayOf(point - u * halfExtent - v * halfExtent, point + u * halfExtent - v * halfExtent,
                        point + u * halfExtent + v * halfExtent, point - u * halfExtent + v * halfExtent)
        for (i in 0 until 4) b.add(c[i], c[(i + 1) % 4], color)
        b.add(c[0], c[2], color).add(c[1], c[3], color)
    }
}

/**
 * "Verified surface support": how much of the surface area is backed by photographic evidence,
 * from the per-vertex `_CONFIDENCE` values of the mesh itself (so it follows edits). The class
 * limits are the companion's: well supported ≥ 0.5, weak 0.15–0.5, no evidence < 0.15.
 */
data class EvidenceStats(
    val hasConfidence: Boolean,
    val wellSupported: Float,
    val weak: Float,
    val none: Float,
    /** Synthetic hole repair (never counted as observed). */
    val repaired: Float,
) {
    companion object {
        const val WELL = 0.5f
        const val WEAK = 0.15f

        fun of(mesh: Mesh): EvidenceStats {
            val conf = mesh.confidence
            val pos = mesh.positions; val idx = mesh.indices
            var well = 0.0; var weak = 0.0; var none = 0.0; var rep = 0.0
            val repairedMat = BooleanArray(mesh.materials.size) { mesh.materials[it].repaired }
            for (f in 0 until mesh.faceCount) {
                val a = idx[3 * f]; val b = idx[3 * f + 1]; val c = idx[3 * f + 2]
                val e1x = (pos[3 * b] - pos[3 * a]).toDouble(); val e1y = (pos[3 * b + 1] - pos[3 * a + 1]).toDouble(); val e1z = (pos[3 * b + 2] - pos[3 * a + 2]).toDouble()
                val e2x = (pos[3 * c] - pos[3 * a]).toDouble(); val e2y = (pos[3 * c + 1] - pos[3 * a + 1]).toDouble(); val e2z = (pos[3 * c + 2] - pos[3 * a + 2]).toDouble()
                val nx = e1y * e2z - e1z * e2y; val ny = e1z * e2x - e1x * e2z; val nz = e1x * e2y - e1y * e2x
                val area = 0.5 * sqrt(nx * nx + ny * ny + nz * nz)
                if (!area.isFinite()) continue
                val m = mesh.materialOfFace(f)
                if (m in repairedMat.indices && repairedMat[m]) { rep += area; continue }
                if (conf == null) { well += area; continue }
                val cf = (conf[a] + conf[b] + conf[c]) / 3f
                if (cf >= WELL) well += area else if (cf >= WEAK) weak += area else none += area
            }
            val total = well + weak + none + rep
            if (!(total > 0.0)) return EvidenceStats(conf != null, 0f, 0f, 0f, 0f)
            return EvidenceStats(conf != null, (well / total).toFloat(), (weak / total).toFloat(), (none / total).toFloat(),
                                 (rep / total).toFloat())
        }
    }
}

/** "Registered viewpoints": where the photos that made it into the reconstruction were taken from. */
object ViewpointCoverage {
    /**
     * 12 azimuth sectors × 3 elevation bands around [center] with +Y up, same binning as the
     * companion (azimuth measured from −Z).
     */
    fun of(cameraPositions: List<Vec3>, center: Vec3): CoverageGrid {
        val grid = CoverageGrid()
        for (p in cameraPositions) {
            if ((p - center).lengthSq() < 1e-12f) continue
            grid.addPosition(p, center, Vec3.Y, Vec3(0f, 0f, -1f))
        }
        return grid
    }

    fun summary(grid: CoverageGrid): String {
        if (grid.photos == 0) return "No registered viewpoints"
        val gap = grid.largestGapDeg
        return "${grid.azimuthCovered} of ${grid.azimuthBins} directions, ${grid.bandsCovered} of ${CoverageGrid.BANDS} height bands" +
            if (gap >= 60.0) " — largest gap ${gap.toInt()}°" else ""
    }
}

/** One row of the hole list. */
data class HoleEntry(
    /** Index for [dev.pocket3d.core.mesh.MeshOps.fillHoles] on the same mesh. */
    val index: Int,
    val perimeter: Float,
    val area: Float,
    val centroid: Vec3,
    val normal: Vec3,
    val edgeCount: Int,
    /**
     * The longest boundary of an open scan is usually its outer rim (where the object met the
     * table), not a hole. This cannot be decided reliably, so it is only a hint.
     */
    val likelyOuterRim: Boolean,
)

object HoleList {
    /**
     * Rows for the hole list, longest perimeter first (the order of `MeshOps.findHoles`, re-sorted
     * defensively). The first entry is flagged as the likely outer rim when it is clearly longer
     * than the next one or spans most of the model.
     */
    fun build(holes: List<Hole>, modelDiagonal: Float): List<HoleEntry> {
        val sorted = holes.sortedWith(compareByDescending<Hole> { it.perimeter }.thenBy { it.index })
        return sorted.mapIndexed { i, h ->
            val rim = i == 0 && h.perimeter > 1.2f * modelDiagonal &&
                (sorted.size == 1 || h.perimeter > 2f * sorted[1].perimeter)
            HoleEntry(h.index, h.perimeter, h.area, h.centroid, h.normal, h.edgeCount, rim)
        }
    }

    /** Number of holes with a perimeter of at most [maxPerimeter]. */
    fun countUpTo(entries: List<HoleEntry>, maxPerimeter: Float): Int = entries.count { it.perimeter <= maxPerimeter }

    /** Default "all smaller than" limit: everything except a likely outer rim. */
    fun defaultMaxPerimeter(entries: List<HoleEntry>): Float =
        entries.filter { !it.likelyOuterRim }.maxOfOrNull { it.perimeter } ?: 0f
}

/** Finding the source camera under a tap. */
object CameraPicker {
    /**
     * Index of the camera whose frustum (apex or centre of its base, [frustumSize] in front) is
     * closest to the tap on screen and within [maxDistPx]; null if none.
     */
    fun pick(cameras: List<PlacedCamera>, view: OrbitCamera, width: Int, height: Int, x: Float, y: Float,
             frustumSize: Float, maxDistPx: Float): Int? {
        var best = -1
        var bestD = maxDistPx
        for ((i, c) in cameras.withIndex()) {
            for (p in arrayOf(c.position, c.position + c.forward * (frustumSize * 0.6f))) {
                val s = view.project(p, width, height) ?: continue
                val d = hypot(s.x - x, s.y - y)
                if (d < bestD) { bestD = d; best = i }
            }
        }
        return if (best >= 0) best else null
    }
}
