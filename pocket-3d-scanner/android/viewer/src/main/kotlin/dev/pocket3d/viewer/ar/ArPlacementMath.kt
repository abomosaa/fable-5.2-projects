package dev.pocket3d.viewer.ar

import dev.pocket3d.core.math.Mat4
import dev.pocket3d.core.math.Quat
import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.mesh.Aabb
import dev.pocket3d.core.scale.Length
import dev.pocket3d.core.scale.ScaleCalibration
import dev.pocket3d.design.Tone
import dev.pocket3d.viewer.measure.formatPercentUncertainty
import kotlin.math.abs
import kotlin.math.ln
import kotlin.math.exp
import kotlin.math.max

/** What the size label in AR says, and how trustworthy that is. */
data class ArSizeLabel(val text: String, val tone: Tone, val detail: String)

/**
 * How large the model is shown in AR. Pure logic, no ARCore types.
 *
 * Two situations, never mixed:
 *  - the model has a real-world scale ([scale] != null): it is shown at true size. The user may
 *    explicitly unlock scaling; any factor other than 1 is then labelled "Not to scale ×f".
 *  - the model has no scale: nothing is shown until the user chooses how long its longest side
 *    should be ([manualLongestMeters]); the result is labelled as manual, not measured.
 */
data class ArSizing(
    val scale: ScaleCalibration?,
    /** Longest side of the edited mesh's bounding box, model units. */
    val longestSideUnits: Float,
    val scaleUnlocked: Boolean = false,
    /** User factor on top of the true size; only meaningful with [scale] and [scaleUnlocked]. */
    val userFactor: Float = 1f,
    /** Chosen length of the longest side in metres when there is no [scale]; null = not chosen yet. */
    val manualLongestMeters: Float? = null,
) {
    val hasScale: Boolean get() = scale != null

    /** True when pinching changes the size. */
    val pinchScales: Boolean get() = if (hasScale) scaleUnlocked else manualLongestMeters != null

    /** True when the factor is (within rounding of the label) exactly true size. */
    val isTrueSize: Boolean get() = hasScale && (!scaleUnlocked || abs(userFactor - 1f) < 0.005f)

    /** Metres per model unit used for drawing, or null while no size has been chosen. */
    val metersPerUnit: Float?
        get() = when {
            scale != null -> (scale.metersPerUnit * (if (scaleUnlocked) userFactor else 1f)).toFloat()
            manualLongestMeters != null && longestSideUnits > 0f -> manualLongestMeters / longestSideUnits
            else -> null
        }

    val canPlace: Boolean get() = metersPerUnit != null

    /** Longest side as shown, metres. */
    val shownLongestMeters: Float? get() = metersPerUnit?.let { it * longestSideUnits }

    fun unlock(on: Boolean): ArSizing = if (on) copy(scaleUnlocked = true) else copy(scaleUnlocked = false, userFactor = 1f)

    /** Applies a pinch. Ignored unless [pinchScales]. */
    fun pinch(zoom: Float): ArSizing {
        if (!pinchScales || !(zoom > 0f) || zoom.isNaN() || zoom.isInfinite()) return this
        return if (hasScale) copy(userFactor = (userFactor * zoom).coerceIn(MIN_FACTOR, MAX_FACTOR))
        else copy(manualLongestMeters = (manualLongestMeters!! * zoom).coerceIn(MIN_MANUAL_METERS, MAX_MANUAL_METERS))
    }

    fun withManualLongest(meters: Float): ArSizing =
        if (hasScale) this else copy(manualLongestMeters = meters.coerceIn(MIN_MANUAL_METERS, MAX_MANUAL_METERS))

    fun label(): ArSizeLabel {
        val s = scale
        if (s == null) {
            val m = manualLongestMeters
                ?: return ArSizeLabel("Size not set", Tone.Warn,
                                      "This model has no real-world scale. Choose how long its longest side should be before placing it.")
            return ArSizeLabel("Longest side ≈ ${Length(m.toDouble(), 0.0, true).format()} (manual — not measured)", Tone.Warn,
                               "You chose this size. The model has no real-world scale, so it is not a measurement.")
        }
        if (!isTrueSize) {
            return ArSizeLabel("Not to scale ×${"%.2f".format(java.util.Locale.ROOT, userFactor)}", Tone.Warn,
                               "You changed the size. Turn off \"Unlock scale\" to return to true size.")
        }
        val pct = formatPercentUncertainty(s.relativeUncertainty)
        return if (s.source == ScaleCalibration.Source.USER_REFERENCE)
            ArSizeLabel("True size (calibrated $pct)", Tone.Good, "Shown at real size from your reference calibration.")
        else ArSizeLabel("AR-estimated size $pct", Tone.Provisional,
                         "Shown at the size estimated from motion tracking during capture. Calibrate with a known distance for a tighter result.")
    }

    companion object {
        const val MIN_FACTOR = 0.05f
        const val MAX_FACTOR = 20f
        const val MIN_MANUAL_METERS = 0.02f
        const val MAX_MANUAL_METERS = 5f

        /** Slider 0..1 ↔ longest side on a logarithmic scale between the manual limits. */
        fun manualFromSlider(v: Float): Float =
            exp(ln(MIN_MANUAL_METERS) + (ln(MAX_MANUAL_METERS) - ln(MIN_MANUAL_METERS)) * v.coerceIn(0f, 1f))

        fun sliderFromManual(meters: Float): Float =
            ((ln(meters.coerceIn(MIN_MANUAL_METERS, MAX_MANUAL_METERS)) - ln(MIN_MANUAL_METERS)) /
                (ln(MAX_MANUAL_METERS) - ln(MIN_MANUAL_METERS))).coerceIn(0f, 1f)
    }
}

/** Where the model sits relative to its anchor. */
object ArPlacementMath {
    /**
     * The model point that is put on the anchor: horizontally the centre of the edited mesh's
     * bounding box, vertically its lowest point — so the model stands on the plane wherever its
     * own origin happens to be (the reconstruction's origin is the estimated object centre, which
     * would otherwise sink the lower half into the floor).
     */
    fun contactPoint(bounds: Aabb): Vec3 = Vec3(bounds.center.x, bounds.min.y, bounds.center.z)

    /**
     * Model → anchor-local transform: move [contactPoint] to the origin, scale to metres, turn by
     * [yawRad] about the anchor's +Y (the plane normal). Model +Y stays along the plane normal.
     * Column-major 4×4.
     */
    fun localMatrix(bounds: Aabb, metersPerUnit: Float, yawRad: Float): FloatArray =
        Mat4.mul(Mat4.rotation(Quat.axisAngle(Vec3.Y, yawRad)),
                 Mat4.mul(Mat4.scale(metersPerUnit), Mat4.translation(-contactPoint(bounds))))

    /** Radius (metres) of the model's footprint on the plane, for the contact shadow. */
    fun footprintRadius(bounds: Aabb, metersPerUnit: Float): Float =
        max(bounds.size.x, bounds.size.z) * 0.5f * metersPerUnit

    /** Gentle global exposure from ARCore's average pixel intensity (0..1); 1 = unchanged. */
    fun exposure(pixelIntensity: Float): Float = (0.78f + 0.44f * pixelIntensity.coerceIn(0f, 1f)).coerceIn(0.75f, 1.15f)
}
