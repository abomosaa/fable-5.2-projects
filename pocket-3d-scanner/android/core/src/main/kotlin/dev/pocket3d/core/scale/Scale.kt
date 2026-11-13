package dev.pocket3d.core.scale

import dev.pocket3d.core.math.Vec3
import kotlinx.serialization.Serializable
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.sqrt

/**
 * Real-world scale of a model.
 *
 * RGB photogrammetry recovers shape only up to an unknown scale factor. A model therefore has
 * no trustworthy size until either (a) the user marks two points whose real distance they know,
 * or (b) the reconstruction validated AR-tracking poses against the recovered camera positions.
 * All coordinates are stored in the reconstruction's own "model units"; this class converts.
 */
@Serializable
data class ScaleCalibration(
    /** Metres per model unit. */
    val metersPerUnit: Double,
    /** One-sigma relative uncertainty of [metersPerUnit] (e.g. 0.02 = ±2 %). */
    val relativeUncertainty: Double,
    val source: Source,
    /** For USER_REFERENCE: the two reference points in base-model coordinates and the stated distance. */
    val refA: Vec3? = null,
    val refB: Vec3? = null,
    val refDistanceMeters: Double? = null,
    val refToleranceMeters: Double? = null,
) {
    @Serializable
    enum class Source {
        /** User marked a known distance on the model. */
        USER_REFERENCE,
        /** Estimated by the companion from validated AR tracking poses. */
        AR_TRACKING,
    }

    companion object {
        /** Relative dimension error that remains after a perfect one-distance calibration (measured: 1–3 %). */
        const val SHAPE_UNCERTAINTY = 0.015

        /**
         * Calibrate from a known real distance between two picked points.
         *
         * @param modelDistance distance between the picked points in model units
         * @param realMeters the distance the user states
         * @param realToleranceMeters how well the user knows that distance (one sigma)
         * @param pickSigmaUnits picking precision per endpoint in model units (≈ local mesh edge
         *        length / screen precision)
         * @return null if the inputs cannot yield a meaningful scale
         */
        fun fromReference(a: Vec3, b: Vec3, realMeters: Double, realToleranceMeters: Double,
                          pickSigmaUnits: Double): ScaleCalibration? {
            val modelDistance = a.distanceTo(b).toDouble()
            if (!(modelDistance > 0.0) || !(realMeters > 0.0) || realMeters.isInfinite()) return null
            if (pickSigmaUnits < 0 || realToleranceMeters < 0) return null
            // A reference that is not clearly longer than the picking noise is useless.
            if (modelDistance < 4.0 * pickSigmaUnits) return null
            // Three independent contributions: how well the user knows the reference, how precisely
            // its two ends were picked, and the shape accuracy of photogrammetry itself — after a
            // one-distance calibration, other dimensions of the reference objects were still off
            // by 1–3 % (docs/MEASURED-RESULTS.md), so no calibration is reported tighter than that.
            val rel = sqrt((realToleranceMeters / realMeters).pow(2) + 2.0 * (pickSigmaUnits / modelDistance).pow(2) +
                           SHAPE_UNCERTAINTY.pow(2))
            return ScaleCalibration(realMeters / modelDistance, rel, Source.USER_REFERENCE, a, b, realMeters,
                                    realToleranceMeters)
        }
    }
}

/** A measured length with its uncertainty, or an explicitly unit-less length. */
data class Length(
    /** Value in metres if [metric], otherwise in arbitrary model units. */
    val value: Double,
    /** One-sigma uncertainty in the same unit as [value]. */
    val sigma: Double,
    val metric: Boolean,
) {
    /**
     * Human-readable text. Metric values are rounded to the precision their uncertainty supports
     * (never more digits than justified) and always carry the ± term; non-metric values are
     * labelled as arbitrary units so they cannot be mistaken for a measurement.
     */
    fun format(): String {
        if (!metric) return "${trim(value, 3)} units (uncalibrated)"
        val (scale, unit) = when {
            abs(value) >= 1.0 -> 1.0 to "m"
            abs(value) >= 0.01 -> 100.0 to "cm"
            else -> 1000.0 to "mm"
        }
        val v = value * scale
        val s = sigma * scale
        if (!(s > 0.0)) return "${trim(v, 2)} $unit"
        // one significant digit of sigma decides the number of decimals
        val exp = floor(log10(s)).toInt()
        val decimals = (-exp).coerceIn(0, 4)
        val q = 10.0.pow(-decimals)
        val vr = Math.round(v / q) * q
        val sr = maxOf(q, Math.ceil(s / q - 1e-9) * q)
        return "${"%.${decimals}f".format(java.util.Locale.ROOT, vr)} ± ${"%.${decimals}f".format(java.util.Locale.ROOT, sr)} $unit"
    }

    private fun trim(x: Double, sig: Int): String {
        if (x == 0.0) return "0"
        val d = (sig - 1 - floor(log10(abs(x))).toInt()).coerceIn(0, 6)
        return "%.${d}f".format(java.util.Locale.ROOT, x)
    }
}

object Measure {
    /**
     * Length between two points given in model units.
     * @param pickSigmaUnits picking precision per endpoint, in model units
     */
    fun length(a: Vec3, b: Vec3, calibration: ScaleCalibration?, pickSigmaUnits: Double): Length {
        val d = a.distanceTo(b).toDouble()
        val pick = sqrt(2.0) * pickSigmaUnits
        if (calibration == null) return Length(d, pick, metric = false)
        val m = d * calibration.metersPerUnit
        val sigma = sqrt((m * calibration.relativeUncertainty).pow(2) + (pick * calibration.metersPerUnit).pow(2))
        return Length(m, sigma, metric = true)
    }
}
