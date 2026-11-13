package dev.pocket3d.capture.logic

import dev.pocket3d.core.capture.FrameAnalysis
import dev.pocket3d.core.capture.ViewSpacing
import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.project.TrackingSegment

/** A kept photo with a tracked pose (AR engine only). */
data class PoseSample(
    val position: Vec3,
    /** Unit viewing direction in the world. */
    val forward: Vec3,
    val segment: Int,
    /** dHash of the photo, if it was analysed. */
    val hash: Long? = null,
)

/**
 * Detects "turning in place": the camera rotates a lot while its viewing rays do not converge on
 * a point in front of it. Walking around an object makes the rays of successive photos meet at
 * the object; standing still and panning makes them meet at (or behind) the camera, which gives
 * a panorama with no parallax — photogrammetry cannot triangulate from that.
 */
object PanoramaDetector {
    const val WINDOW = 4
    const val MIN_SAMPLES = 3
    const val MIN_ROTATION_DEG = 30.0
    /** Translation below this over the whole window counts as "did not move". */
    const val STATIC_BASELINE_M = 0.04
    /** Rays that converge closer than this (or behind the camera) do not look at a common object. */
    const val MIN_PIVOT_DISTANCE_M = 0.12

    fun isTurningInPlace(samples: List<PoseSample>): Boolean {
        if (samples.isEmpty()) return false
        val seg = samples.last().segment
        val recent = samples.takeLastWhile { it.segment == seg }.takeLast(WINDOW)
        if (recent.size < MIN_SAMPLES) return false
        var rotation = 0.0
        var baseline = 0.0
        for (i in recent.indices) for (j in i + 1 until recent.size) {
            rotation = maxOf(rotation, ViewSpacing.angleDeg(recent[i].forward, recent[j].forward))
            baseline = maxOf(baseline, recent[i].position.distanceTo(recent[j].position).toDouble())
        }
        if (rotation < MIN_ROTATION_DEG) return false
        if (baseline < STATIC_BASELINE_M) return true
        val pivot = pivotDistance(recent) ?: return false
        return pivot < MIN_PIVOT_DISTANCE_M
    }

    /**
     * Mean signed distance, along each viewing ray, to the point closest to all rays (least
     * squares). Positive: the rays meet in front of the cameras (orbit). Around zero or negative:
     * they meet at or behind the cameras (panning). null if the rays are parallel.
     */
    fun pivotDistance(samples: List<PoseSample>): Double? {
        // Σ (I − f fᵀ) X = Σ (I − f fᵀ) p
        val a = DoubleArray(9)
        val b = DoubleArray(3)
        for (s in samples) {
            val f = s.forward.normalized()
            val fx = f.x.toDouble(); val fy = f.y.toDouble(); val fz = f.z.toDouble()
            val m = doubleArrayOf(
                1 - fx * fx, -fx * fy, -fx * fz,
                -fy * fx, 1 - fy * fy, -fy * fz,
                -fz * fx, -fz * fy, 1 - fz * fz,
            )
            val p = doubleArrayOf(s.position.x.toDouble(), s.position.y.toDouble(), s.position.z.toDouble())
            for (r in 0 until 3) {
                for (c in 0 until 3) a[r * 3 + c] += m[r * 3 + c]
                b[r] += m[r * 3] * p[0] + m[r * 3 + 1] * p[1] + m[r * 3 + 2] * p[2]
            }
        }
        val det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6])
        if (Math.abs(det) < 1e-6) return null
        val x = (b[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (b[1] * a[8] - a[5] * b[2]) + a[2] * (b[1] * a[7] - a[4] * b[2])) / det
        val y = (a[0] * (b[1] * a[8] - a[5] * b[2]) - b[0] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * b[2] - b[1] * a[6])) / det
        val z = (a[0] * (a[4] * b[2] - b[1] * a[7]) - a[1] * (a[3] * b[2] - b[1] * a[6]) + b[0] * (a[3] * a[7] - a[4] * a[6])) / det
        var sum = 0.0
        for (s in samples) {
            val f = s.forward.normalized()
            sum += (x - s.position.x) * f.x + (y - s.position.y) * f.y + (z - s.position.z) * f.z
        }
        return sum / samples.size
    }
}

/**
 * Detects the turntable mistake: the phone does not move between photos, yet the pictures differ
 * a lot — so the object (or something else in view) is moving while the background stays put.
 * A reconstruction of such photos has two contradictory motions and fails or produces garbage.
 * This is a heuristic on a 64-bit image hash, worded as "seems" in the UI.
 */
object TurntableDetector {
    const val STATIC_TRANSLATION_M = 0.06
    const val STATIC_ROTATION_DEG = 6.0
    const val CHANGED_HASH_DISTANCE = 10
    /** Consecutive suspicious pairs needed (one pair can be a person walking through the background). */
    const val REQUIRED_PAIRS = 2

    fun pairSuspicious(a: PoseSample, b: PoseSample): Boolean {
        if (a.segment != b.segment) return false
        val ha = a.hash ?: return false
        val hb = b.hash ?: return false
        return a.position.distanceTo(b.position) < STATIC_TRANSLATION_M &&
            ViewSpacing.angleDeg(a.forward, b.forward) < STATIC_ROTATION_DEG &&
            FrameAnalysis.hammingDistance(ha, hb) >= CHANGED_HASH_DISTANCE
    }

    fun detect(samples: List<PoseSample>, requiredPairs: Int = REQUIRED_PAIRS): Boolean {
        if (samples.size < requiredPairs + 1) return false
        val recent = samples.takeLast(requiredPairs + 1)
        for (i in 0 until requiredPairs) if (!pairSuspicious(recent[i], recent[i + 1])) return false
        return true
    }
}

/**
 * AR tracking segments. A segment is a stretch of continuous tracking; poses of different
 * segments are never assumed to share a coordinate system. A new segment starts whenever
 * tracking comes back after a loss, when the AR session is re-created, and when a stored session
 * is continued after a restart.
 */
class SegmentTracker(restored: List<TrackingSegment> = emptyList()) {
    private val frames = LinkedHashMap<Int, MutableList<String>>()
    private var everTracked = false
    private var lost = false

    /** Segment id that the next tracked photo belongs to. */
    var current: Int = 0
        private set

    init {
        for (s in restored) frames.getOrPut(s.segment) { ArrayList() }.addAll(s.frames)
        // Whatever was tracked before this process started lives in an older coordinate system.
        if (frames.isNotEmpty()) current = frames.keys.max() + 1
    }

    /** Feeds the tracking state of every AR frame. Returns true when this update started a new segment. */
    fun onTracking(tracking: Boolean): Boolean {
        if (!tracking) {
            if (everTracked) lost = true
            return false
        }
        if (lost) {
            lost = false
            advance()
            return true
        }
        everTracked = true
        return false
    }

    /** The AR session was closed and a new one created: its world frame is unrelated. */
    fun onSessionRecreated() {
        if (everTracked) advance()
        everTracked = false
        lost = false
    }

    private fun advance() {
        // Do not burn ids for stretches in which no photo was taken.
        if (frames[current].isNullOrEmpty()) return
        current++
    }

    /**
     * Records a photo in [segment] — the segment that was current when the image was TAKEN,
     * which may be older than [current] if the photo was only confirmed later.
     */
    fun addFrame(frameId: String, segment: Int = current) { frames.getOrPut(segment) { ArrayList() }.add(frameId) }

    fun removeFrame(frameId: String) { frames.values.forEach { it.remove(frameId) } }

    fun retain(frameIds: Set<String>) { frames.values.forEach { it.retainAll(frameIds) } }

    fun segmentOf(frameId: String): Int? = frames.entries.firstOrNull { frameId in it.value }?.key

    /** Segments that contain photos, in order. */
    fun snapshot(): List<TrackingSegment> =
        frames.entries.filter { it.value.isNotEmpty() }.sortedBy { it.key }.map { TrackingSegment(it.key, it.value.toList()) }

    val segmentCount: Int get() = frames.values.count { it.isNotEmpty() }
}
