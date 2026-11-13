package dev.pocket3d.core.capture

import dev.pocket3d.core.math.Vec3
import kotlin.math.atan2
import kotlin.math.hypot
import kotlin.math.sqrt

/**
 * Viewpoint coverage: from where around the object photos were taken, binned by azimuth
 * (12 × 30°) and elevation band (low < 20°, mid 20–50°, high > 50°).
 *
 * This is an ESTIMATE of coverage based on camera viewpoints (tracked by AR, estimated from the
 * orientation sensor, or — after reconstruction — the registered camera positions). It is not
 * proof that the surface facing a covered direction was reconstructed; that "verified surface
 * coverage" only exists after reconstruction and is reported separately.
 *
 * A bin is filled by a photo taken from inside it. Taking more photos from the same place does
 * not fill anything else.
 */
class CoverageGrid(val azimuthBins: Int = AZIMUTH_BINS) {
    /** counts[band][azimuthBin] */
    val counts: Array<IntArray> = Array(BANDS) { IntArray(azimuthBins) }

    fun clear() { counts.forEach { it.fill(0) } }

    /** Adds a viewpoint given by azimuth (degrees, any range) and elevation (degrees). */
    fun add(azimuthDeg: Double, elevationDeg: Double) {
        counts[bandOf(elevationDeg)][binOf(azimuthDeg)]++
    }

    /**
     * Adds a camera at [position] looking at an object at [center], with [up] the vertical.
     * The azimuth reference direction is [reference] projected onto the horizontal plane.
     */
    fun addPosition(position: Vec3, center: Vec3, up: Vec3, reference: Vec3) {
        val (az, el) = azimuthElevation(position, center, up, reference)
        add(az, el)
    }

    fun binOf(azimuthDeg: Double): Int {
        val a = ((azimuthDeg % 360.0) + 360.0) % 360.0
        return (a / (360.0 / azimuthBins)).toInt().coerceIn(0, azimuthBins - 1)
    }

    val photos: Int get() = counts.sumOf { it.sum() }
    /** Azimuth sectors (of [azimuthBins]) with at least one photo in any band. */
    val azimuthCovered: Int get() = (0 until azimuthBins).count { a -> counts.any { it[a] > 0 } }
    val bandsCovered: Int get() = counts.count { row -> row.any { it > 0 } }
    fun bandCovered(band: Int): Int = counts[band].count { it > 0 }

    /** Fraction of the low+mid band cells that contain a photo (the top band is optional for many objects). */
    val ringFraction: Float get() = (bandCovered(0) + bandCovered(1)).toFloat() / (2 * azimuthBins)

    /** Largest run of consecutive empty azimuth sectors, in degrees (360 if nothing captured). */
    val largestGapDeg: Double get() {
        val filled = BooleanArray(azimuthBins) { a -> counts.any { it[a] > 0 } }
        if (filled.none { it }) return 360.0
        var best = 0; var run = 0
        for (i in 0 until 2 * azimuthBins) {
            if (!filled[i % azimuthBins]) { run++; if (run > best) best = run } else run = 0
        }
        return minOf(best, azimuthBins) * (360.0 / azimuthBins)
    }

    /** Specific, actionable hints derived from which cells are empty. */
    fun guidance(): List<String> {
        val out = ArrayList<String>()
        if (photos == 0) return listOf("Start anywhere and move around the object, keeping it centred.")
        val gap = largestGapDeg
        if (gap >= 60.0) out += "A ${gap.toInt()}° side of the object has no photos yet — keep walking around it."
        if (bandCovered(0) > 0 && bandCovered(1) + bandCovered(2) == 0 && azimuthCovered >= azimuthBins / 2)
            out += "All photos are from one height. Add a second ring from higher up, looking down at the object."
        if (bandCovered(1) + bandCovered(2) > 0 && bandCovered(0) == 0 && azimuthCovered >= azimuthBins / 2)
            out += "Add a ring from lower down so the sides and undercuts are seen."
        if (out.isEmpty() && bandCovered(2) == 0) out += "Optional: a few photos from above improve the top surface."
        return out
    }

    companion object {
        const val AZIMUTH_BINS = 12
        const val BANDS = 3
        val ELEVATION_EDGES_DEG = doubleArrayOf(20.0, 50.0)

        fun bandOf(elevationDeg: Double): Int = when {
            elevationDeg < ELEVATION_EDGES_DEG[0] -> 0
            elevationDeg < ELEVATION_EDGES_DEG[1] -> 1
            else -> 2
        }

        /** (azimuth°, elevation°) of [position] as seen from [center]. */
        fun azimuthElevation(position: Vec3, center: Vec3, up: Vec3, reference: Vec3): Pair<Double, Double> {
            val u = up.normalized()
            val p = position - center
            var ref = reference - u * reference.dot(u)
            if (ref.lengthSq() < 1e-10f) ref = if (kotlin.math.abs(u.x) < 0.9f) Vec3.X - u * u.x else Vec3.Z - u * u.z
            ref = ref.normalized()
            val side = u.cross(ref)
            val h = p.dot(u).toDouble()
            val x = p.dot(ref).toDouble()
            val y = p.dot(side).toDouble()
            val az = (Math.toDegrees(atan2(y, x)) + 360.0) % 360.0
            val el = Math.toDegrees(atan2(h, hypot(x, y)))
            return az to el
        }
    }
}

/**
 * Decides whether a new viewpoint adds useful information relative to the photos already kept,
 * for auto-capture and duplicate / low-overlap flags. Works on viewing directions (from tracked
 * poses, or from the orientation sensor under the orbit assumption).
 */
object ViewSpacing {
    /** Angle in degrees between two viewing directions (unit or not). */
    fun angleDeg(a: Vec3, b: Vec3): Double {
        val d = (a.normalized().dot(b.normalized())).toDouble().coerceIn(-1.0, 1.0)
        return Math.toDegrees(kotlin.math.acos(d))
    }

    /** Smallest angle between [dir] and any of [kept]; +∞ if none. */
    fun nearestAngleDeg(dir: Vec3, kept: List<Vec3>): Double = kept.minOfOrNull { angleDeg(dir, it) } ?: Double.POSITIVE_INFINITY

    /** A view closer than this to an existing one adds almost nothing. */
    const val DUPLICATE_DEG = 4.0
    /** Target step between neighbouring views (≈ 70–80 % image overlap for typical framing). */
    const val TARGET_STEP_DEG = 12.0
    /** Beyond this step feature matching between neighbours becomes unreliable. */
    const val MAX_STEP_DEG = 30.0

    /**
     * Rough overlap estimate between two views of the same object separated by [angleDeg]:
     * 1 at 0°, falling linearly to 0 at 45° (beyond which the same surface is seen too obliquely
     * to match). An estimate, labelled as such wherever it is displayed.
     */
    fun estimatedOverlap(angleDeg: Double): Double = (1.0 - angleDeg / 45.0).coerceIn(0.0, 1.0)

    /** Angular speed (deg/s) above which motion blur is likely at typical exposure times. */
    const val MAX_ANGULAR_SPEED_DEG_S = 25.0

    fun rms(values: DoubleArray): Double = if (values.isEmpty()) 0.0 else sqrt(values.sumOf { it * it } / values.size)
}
