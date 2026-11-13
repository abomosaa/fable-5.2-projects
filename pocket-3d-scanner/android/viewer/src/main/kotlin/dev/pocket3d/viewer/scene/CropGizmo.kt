package dev.pocket3d.viewer.scene

import dev.pocket3d.core.math.Quat
import dev.pocket3d.core.math.Ray
import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.mesh.Aabb
import dev.pocket3d.core.mesh.OrientedBox
import kotlin.math.abs
import kotlin.math.max

/**
 * Handle math of the crop box. Pure functions on [OrientedBox] so the gizmo can be unit tested
 * without a screen.
 *
 * Faces are numbered `axis * 2 + side` with side 0 = the face on the negative end of the local
 * axis and side 1 = the positive end (0: −X, 1: +X, 2: −Y, 3: +Y, 4: −Z, 5: +Z).
 */
object CropGizmo {
    const val FACE_COUNT = 6

    fun faceAxis(face: Int): Int = face / 2
    fun faceSign(face: Int): Float = if (face % 2 == 0) -1f else 1f

    /** Outward unit normal of [face] in world space. */
    fun faceNormal(box: OrientedBox, face: Int): Vec3 = box.axis(faceAxis(face)) * faceSign(face)

    /** Centre of [face] in world space — where its drag handle sits. */
    fun faceCenter(box: OrientedBox, face: Int): Vec3 =
        box.center + faceNormal(box, face) * box.halfExtents[faceAxis(face)]

    /**
     * Parameter `t` of the point `origin + t · dir` on a line that is closest to [ray]
     * ([dir] must be a unit vector). Null when the ray is (nearly) parallel to the line, in which
     * case dragging along that line is undefined.
     */
    fun axisParam(ray: Ray, origin: Vec3, dir: Vec3): Float? {
        val w = origin - ray.origin
        val b = dir.dot(ray.dir)
        val d = dir.dot(w)
        val e = ray.dir.dot(w)
        val denom = 1f - b * b
        if (denom < 1e-5f) return null
        return (b * e - d) / denom
    }

    /**
     * Signed position along the face normal's axis (measured from the box centre) that the pointer
     * [ray] indicates; used both when grabbing a handle (to remember the grab offset) and while
     * dragging.
     */
    fun pointerAlongAxis(box: OrientedBox, face: Int, ray: Ray): Float? =
        axisParam(ray, box.center, box.axis(faceAxis(face)))

    /**
     * Move one face along its normal so that it lies at signed axis position [axisPosition]
     * (relative to the centre of [box]); the opposite face stays where it is. The box never gets
     * thinner than `2 · minHalfExtent`.
     */
    fun moveFace(box: OrientedBox, face: Int, axisPosition: Float, minHalfExtent: Float): OrientedBox {
        val axis = faceAxis(face)
        val s = faceSign(face)
        val h = box.halfExtents[axis]
        val fixed = -s * h
        val extent = max(2f * minHalfExtent, s * (axisPosition - fixed))
        val moved = fixed + s * extent
        val newHalf = extent / 2f
        val shift = (moved + fixed) / 2f
        val he = box.halfExtents
        val newHe = when (axis) {
            0 -> Vec3(newHalf, he.y, he.z)
            1 -> Vec3(he.x, newHalf, he.z)
            else -> Vec3(he.x, he.y, newHalf)
        }
        return OrientedBox(box.center + box.axis(axis) * shift, box.rotation, newHe)
    }

    /**
     * Drag a face handle: [start] is the box when the drag began, [grabOffset] the difference
     * between the face position and the pointer position along the axis at that moment (so the
     * handle does not jump under the finger). Returns [start] unchanged when the pointer ray is
     * parallel to the axis.
     */
    fun dragFace(start: OrientedBox, face: Int, ray: Ray, grabOffset: Float, minHalfExtent: Float): OrientedBox {
        val t = pointerAlongAxis(start, face, ray) ?: return start
        return moveFace(start, face, t + grabOffset, minHalfExtent)
    }

    /** Grab offset for [dragFace] at the moment the handle is touched. */
    fun grabOffset(box: OrientedBox, face: Int, ray: Ray): Float {
        val t = pointerAlongAxis(box, face, ray) ?: return 0f
        return faceSign(face) * box.halfExtents[faceAxis(face)] - t
    }

    /** Point where [ray] crosses the horizontal plane y = [height], or null if it does not (in front of the origin). */
    fun horizontalPlanePoint(ray: Ray, height: Float): Vec3? {
        if (abs(ray.dir.y) < 1e-5f) return null
        val t = (height - ray.origin.y) / ray.dir.y
        if (t <= 0f) return null
        return ray.at(t)
    }

    /**
     * Drag the whole box horizontally: the centre follows the pointer on the horizontal plane
     * through the box centre; [grabDelta] = centre − grabbed plane point at drag start.
     */
    fun dragMove(start: OrientedBox, ray: Ray, grabDelta: Vec3): OrientedBox {
        val p = horizontalPlanePoint(ray, start.center.y) ?: return start
        return OrientedBox(Vec3(p.x + grabDelta.x, start.center.y, p.z + grabDelta.z), start.rotation, start.halfExtents)
    }

    /** Rotate the box about the vertical (+Y) axis through its centre by [radians]. */
    fun rotateY(box: OrientedBox, radians: Float): OrientedBox =
        OrientedBox(box.center, (Quat.axisAngle(Vec3.Y, radians) * box.rotation).normalized(), box.halfExtents)

    /** Yaw of the box (rotation of its local X axis about +Y), radians. */
    fun yawOf(box: OrientedBox): Float {
        val x = box.axis(0)
        return kotlin.math.atan2(-x.z, x.x)
    }

    /** The 8 corners, index bits: 1 = +X, 2 = +Y, 4 = +Z. */
    fun corners(box: OrientedBox): Array<Vec3> = Array(8) { i ->
        val l = Vec3(
            if (i and 1 != 0) box.halfExtents.x else -box.halfExtents.x,
            if (i and 2 != 0) box.halfExtents.y else -box.halfExtents.y,
            if (i and 4 != 0) box.halfExtents.z else -box.halfExtents.z,
        )
        box.center + box.rotation.rotate(l)
    }

    /** The 12 edges as segments (ax, ay, az, bx, by, bz per edge). */
    fun edgeSegments(box: OrientedBox): FloatArray {
        val c = corners(box)
        val out = FloatArray(12 * 6)
        var k = 0
        for (i in 0 until 8) for (bit in intArrayOf(1, 2, 4)) {
            if (i and bit == 0) {
                val a = c[i]; val b = c[i or bit]
                out[k++] = a.x; out[k++] = a.y; out[k++] = a.z
                out[k++] = b.x; out[k++] = b.y; out[k++] = b.z
            }
        }
        return out
    }

    /** A box around [bounds], slightly enlarged, used when the reconstruction made no suggestion. */
    fun fromBounds(bounds: Aabb, grow: Float = 1.0f): OrientedBox =
        OrientedBox(bounds.center, Quat.IDENTITY, bounds.size * (0.5f * grow))

    /** Smallest allowed half extent for a model of the given size. */
    fun minHalfExtent(bounds: Aabb): Float = max(bounds.diagonal * 0.005f, 1e-6f)
}
