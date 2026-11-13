package dev.pocket3d.capture.logic

import dev.pocket3d.core.capture.CoverageGrid
import dev.pocket3d.core.capture.ViewSpacing
import dev.pocket3d.core.math.Quat
import dev.pocket3d.core.math.Vec3
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.sqrt

/**
 * Viewpoint directions. A "viewpoint direction" is the unit vector from the object towards the
 * camera in a gravity-aligned world with +Y up. It is either
 *  * tracked: (camera position − object centre) from AR poses, or
 *  * estimated: the reverse of the camera's viewing direction, which equals the viewpoint
 *    direction only under the orbit assumption (the camera is aimed at the object).
 */
object OrientationViewpoint {
    /** Android rotation-vector sensor values (x·sin(θ/2), y·sin(θ/2), z·sin(θ/2)[, cos(θ/2)]) → unit quaternion. */
    fun quatFromRotationVector(values: FloatArray): Quat {
        val x = values[0]; val y = values[1]; val z = values[2]
        val w = if (values.size >= 4) values[3] else sqrt(maxOf(0f, 1f - x * x - y * y - z * z))
        return Quat(x, y, z, w).normalized()
    }

    /**
     * Estimated viewpoint direction from the device orientation reported by the rotation-vector
     * sensor (device → world, world = East/North/Up). The back camera looks along the device's
     * −Z axis, so the direction back towards the camera is the device +Z axis in the world. The
     * result is re-expressed with +Y up (x = east, y = up, z = −north).
     */
    fun dirFromDeviceQuat(deviceToWorldEnu: Quat): Vec3 {
        val d = deviceToWorldEnu.rotate(Vec3.Z)
        return Vec3(d.x, d.z, -d.y)
    }

    /** Same for a GL-convention camera pose in a +Y-up world (ARCore): the reverse of the forward axis (−Z). */
    fun dirFromCameraQuat(cameraToWorld: Quat): Vec3 = cameraToWorld.rotate(Vec3.Z)

    /** (azimuth°, elevation°) of a viewpoint direction; azimuth is measured from world +X. */
    fun azimuthElevation(dir: Vec3): Pair<Double, Double> =
        CoverageGrid.azimuthElevation(dir, Vec3.ZERO, Vec3.Y, Vec3.X)

    /** Rotation angle in degrees between two orientations (precise for small angles). */
    fun angleDeg(a: Quat, b: Quat): Double {
        val r = a.conjugate() * b
        val v = sqrt(r.x.toDouble() * r.x + r.y.toDouble() * r.y + r.z.toDouble() * r.z)
        return Math.toDegrees(2.0 * atan2(v, abs(r.w.toDouble())))
    }
}

/** Exponentially smoothed rotation speed from successive orientation samples. */
class AngularSpeedEstimator(private val smoothing: Double = 0.3) {
    private var last: Quat? = null
    private var lastNs = 0L
    var degPerSec: Double = 0.0
        private set

    fun update(q: Quat, timeNs: Long): Double {
        val prev = last
        if (prev != null) {
            val dt = (timeNs - lastNs) / 1e9
            if (dt >= 1.0) degPerSec = 0.0           // stale: the stream was interrupted
            else if (dt > 1e-4) {
                val inst = OrientationViewpoint.angleDeg(prev, q) / dt
                degPerSec += smoothing * (inst - degPerSec)
            } else return degPerSec
        }
        last = q; lastNs = timeNs
        return degPerSec
    }

    fun reset() { last = null; degPerSec = 0.0 }
}

/** Exponentially smoothed translation speed (m/s) from successive tracked positions. */
class LinearSpeedEstimator(private val smoothing: Double = 0.3) {
    private var last: Vec3? = null
    private var lastNs = 0L
    var metersPerSec: Double = 0.0
        private set

    fun update(p: Vec3, timeNs: Long): Double {
        val prev = last
        if (prev != null) {
            val dt = (timeNs - lastNs) / 1e9
            if (dt >= 1.0) metersPerSec = 0.0
            else if (dt > 1e-4) {
                val inst = prev.distanceTo(p) / dt
                metersPerSec += smoothing * (inst - metersPerSec)
            } else return metersPerSec
        }
        last = p; lastNs = timeNs
        return metersPerSec
    }

    fun reset() { last = null; metersPerSec = 0.0 }
}

/**
 * Viewpoint coverage of the photos that were actually kept. One entry per stored photo; the grid
 * is always rebuilt from the entries, so undoing a photo or correcting the object centre can
 * never leave a cell filled that no photo was taken from.
 */
class CoverageTracker {
    data class Entry(
        val frameId: String,
        /** Unit viewpoint direction (object → camera), +Y up. */
        val dir: Vec3,
        /** true: from a tracked position relative to the object centre; false: orientation estimate. */
        val tracked: Boolean,
        /** Tracked camera position and its tracking segment, kept so the centre can be corrected later. */
        val position: Vec3? = null,
        val orientationDir: Vec3? = null,
        val segment: Int = -1,
    )

    private val entries = LinkedHashMap<String, Entry>()
    val grid = CoverageGrid()

    val size: Int get() = entries.size
    val trackedCount: Int get() = entries.values.count { it.tracked }
    val estimatedCount: Int get() = entries.values.count { !it.tracked }
    val directions: List<Vec3> get() = entries.values.map { it.dir }
    fun entries(): List<Entry> = entries.values.toList()
    fun contains(frameId: String): Boolean = entries.containsKey(frameId)

    /** Snapshot counts[band][azimuthBin] for the UI. */
    fun counts(): List<List<Int>> = grid.counts.map { it.toList() }

    fun clear() { entries.clear(); grid.clear() }

    /** Adds a photo whose viewpoint is only known from the viewing direction (orbit assumption). */
    fun addEstimated(frameId: String, dir: Vec3, position: Vec3? = null, segment: Int = -1) {
        val n = dir.normalized()
        if (n.lengthSq() < 0.5f) return
        put(Entry(frameId, n, tracked = false, position = position, orientationDir = n, segment = segment))
    }

    /**
     * Adds a photo taken from a tracked [position] around the object at [center]. Falls back to
     * [orientationDir] (estimate) when the camera is practically at the centre.
     */
    fun addTracked(frameId: String, position: Vec3, center: Vec3, segment: Int, orientationDir: Vec3? = null) {
        val d = position - center
        if (d.length() < MIN_CENTER_DISTANCE_M) {
            if (orientationDir != null) addEstimated(frameId, orientationDir, position, segment)
            return
        }
        put(Entry(frameId, d.normalized(), tracked = true, position = position,
                  orientationDir = orientationDir?.normalized(), segment = segment))
    }

    /** Restores an entry exactly as it was stored (after a restart). */
    fun restore(frameId: String, dir: Vec3, tracked: Boolean) {
        val n = dir.normalized()
        if (n.lengthSq() < 0.5f) return
        put(Entry(frameId, n, tracked))
    }

    fun remove(frameId: String) {
        if (entries.remove(frameId) != null) rebuild()
    }

    /** Keeps only the given photos (after frames were deleted elsewhere). */
    fun retain(frameIds: Set<String>) {
        if (entries.keys.retainAll(frameIds)) rebuild()
    }

    /**
     * The object centre of [segment] was (re)defined: recompute every photo of that segment that
     * has a tracked position. Photos of other segments are left alone — their positions are in a
     * coordinate system that is not known to match.
     */
    fun recenter(center: Vec3, segment: Int) {
        var changed = false
        for (e in entries.values.toList()) {
            val p = e.position ?: continue
            if (e.segment != segment) continue
            val d = p - center
            if (d.length() < MIN_CENTER_DISTANCE_M) continue
            entries[e.frameId] = e.copy(dir = d.normalized(), tracked = true)
            changed = true
        }
        if (changed) rebuild()
    }

    /** Smallest angle between [dir] and the viewpoint of any kept photo; +∞ when none is kept. */
    fun nearestAngleDeg(dir: Vec3): Double = ViewSpacing.nearestAngleDeg(dir, directions)

    private fun put(e: Entry) {
        val replaced = entries.put(e.frameId, e) != null
        if (replaced) rebuild() else addToGrid(e)
    }

    private fun addToGrid(e: Entry) {
        val (az, el) = OrientationViewpoint.azimuthElevation(e.dir)
        grid.add(az, el)
    }

    private fun rebuild() {
        grid.clear()
        entries.values.forEach(::addToGrid)
    }

    companion object {
        const val MIN_CENTER_DISTANCE_M = 0.05f
    }
}
