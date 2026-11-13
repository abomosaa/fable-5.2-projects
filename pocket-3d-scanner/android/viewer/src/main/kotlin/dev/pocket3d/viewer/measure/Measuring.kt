package dev.pocket3d.viewer.measure

import dev.pocket3d.core.edit.EditDocument
import dev.pocket3d.core.edit.EditEngine
import dev.pocket3d.core.edit.Measurement
import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.mesh.Bvh
import dev.pocket3d.core.mesh.Mesh
import dev.pocket3d.core.project.ScaleInfo
import dev.pocket3d.core.scale.Length
import dev.pocket3d.core.scale.ScaleCalibration
import dev.pocket3d.design.Tone
import dev.pocket3d.viewer.camera.OrbitCamera
import kotlin.math.max
import kotlin.math.roundToInt

/** Units offered when the user types a real-world distance. */
enum class LengthUnit(val symbol: String, val metersPerUnit: Double) {
    MM("mm", 0.001), CM("cm", 0.01), M("m", 1.0), IN("in", 0.0254);

    fun toMeters(value: Double): Double = value * metersPerUnit
    fun fromMeters(meters: Double): Double = meters / metersPerUnit
}

/** Parsing of the numbers typed into the calibration dialog. */
object LengthInput {
    /** Default tolerance of a user-stated reference distance: ±1 mm. */
    const val DEFAULT_TOLERANCE_METERS = 0.001

    /**
     * Parses a positive decimal number. Accepts a decimal comma, surrounding spaces and a trailing
     * unit symbol equal to [unit]; rejects everything else (empty, zero, negative, not a number,
     * thousands separators, a different unit).
     */
    fun parsePositive(text: String, unit: LengthUnit? = null): Double? {
        var s = text.trim().lowercase()
        if (unit != null) {
            val suffixes = when (unit) {
                LengthUnit.IN -> listOf("inches", "inch", "in", "\"")
                else -> listOf(unit.symbol)
            }
            for (suffix in suffixes) if (s.endsWith(suffix)) { s = s.removeSuffix(suffix).trim(); break }
        }
        if (s.isEmpty()) return null
        if (s.count { it == ',' } + s.count { it == '.' } > 1) return null
        s = s.replace(',', '.')
        if (!s.all { it.isDigit() || it == '.' }) return null
        if (s == ".") return null
        val v = s.toDoubleOrNull() ?: return null
        return if (v > 0.0 && v.isFinite()) v else null
    }

    /** Distance in metres from the typed text, or null if it is not a valid positive length. */
    fun parseMeters(text: String, unit: LengthUnit): Double? = parsePositive(text, unit)?.let { unit.toMeters(it) }

    /** Tolerance in metres: empty text means the default (±1 mm); zero is allowed. */
    fun parseToleranceMeters(text: String, unit: LengthUnit): Double? {
        val t = text.trim()
        if (t.isEmpty()) return DEFAULT_TOLERANCE_METERS
        val normalised = t.replace(',', '.')
        if (normalised.toDoubleOrNull() == 0.0) return 0.0
        return parseMeters(t, unit)
    }

    /** The default tolerance expressed in [unit], for the text field hint. */
    fun defaultToleranceText(unit: LengthUnit): String = formatPlain(unit.fromMeters(DEFAULT_TOLERANCE_METERS))

    /** Plain number without trailing zeros (for text fields, not for showing measured lengths). */
    fun formatPlain(v: Double): String {
        val s = "%.4f".format(java.util.Locale.ROOT, v)
        return if (s.contains('.')) s.trimEnd('0').trimEnd('.') else s
    }
}

/** "±3%" style text of a relative uncertainty; never shows 0 % for a non-zero value. */
fun formatPercentUncertainty(relative: Double): String {
    val pct = relative * 100.0
    return when {
        !(pct > 0.0) -> "±0%"
        pct < 0.1 -> "±<0.1%"
        pct < 10 -> "±${"%.1f".format(java.util.Locale.ROOT, pct)}%"
        else -> "±${pct.roundToInt()}%"
    }
}

/** What the permanent scale pill in the viewer header says. */
data class ScaleStatus(val text: String, val tone: Tone, val detail: String) {
    companion object {
        fun of(doc: EditDocument?, reconstruction: ScaleCalibration?): ScaleStatus {
            val user = doc?.scale
            return when {
                user != null -> ScaleStatus(
                    "Calibrated from reference ${formatPercentUncertainty(user.relativeUncertainty)}", Tone.Good,
                    "You marked a known distance on the model. Sizes are in real units with the stated uncertainty.")
                reconstruction != null -> ScaleStatus(
                    "AR-estimated scale ${formatPercentUncertainty(reconstruction.relativeUncertainty)}", Tone.Provisional,
                    "The scale comes from the phone's motion tracking during capture. Calibrate with a known distance for a tighter result.")
                else -> ScaleStatus(
                    "Uncalibrated — arbitrary units", Tone.Warn,
                    "Photos alone do not determine real-world size. Mark a known distance to calibrate.")
            }
        }
    }
}

object Measuring {
    /** Relative uncertainty assumed for an AR-tracking scale when the companion did not state one. */
    const val DEFAULT_AR_RELATIVE_UNCERTAINTY = 0.05

    /** The reconstruction's own scale statement as a calibration, or null when it is not metric. */
    fun reconstructionCalibration(info: ScaleInfo?): ScaleCalibration? {
        if (info == null || !info.isMetric) return null
        val mpu = info.metersPerUnit ?: return null
        if (!(mpu > 0.0) || !mpu.isFinite()) return null
        return ScaleCalibration(mpu, info.relativeUncertainty ?: DEFAULT_AR_RELATIVE_UNCERTAINTY,
                                ScaleCalibration.Source.AR_TRACKING)
    }

    /** Mean edge length of face [face] — the local mesh resolution at a pick. */
    fun faceMeanEdge(mesh: Mesh, face: Int): Float {
        if (face < 0 || face >= mesh.faceCount) return 0f
        val a = mesh.position(mesh.indices[3 * face])
        val b = mesh.position(mesh.indices[3 * face + 1])
        val c = mesh.position(mesh.indices[3 * face + 2])
        return (a.distanceTo(b) + b.distanceTo(c) + c.distanceTo(a)) / 3f
    }

    /**
     * Picking precision of a surface point in model units: the larger of the local mesh
     * resolution and the size of [pixels] screen pixels at the depth of the pick.
     */
    fun pickSigma(mesh: Mesh, face: Int, camera: OrbitCamera, viewportHeight: Int, point: Vec3, pixels: Float = 6f): Double {
        val depth = (point - camera.eye).dot(camera.forward).coerceAtLeast(0f)
        val screen = camera.worldPerPixel(depth, viewportHeight) * pixels
        return max(faceMeanEdge(mesh, face), screen).toDouble()
    }

    /** The one and only way a measurement becomes text. */
    fun label(m: Measurement, scale: ScaleCalibration?): String = EditEngine.measure(m, scale).format()

    /** Formats an arbitrary model-space length through the same path as measurements. */
    fun formatModelLength(units: Double, scale: ScaleCalibration?): String =
        if (scale == null) Length(units, 0.0, false).format()
        else Length(units * scale.metersPerUnit, units * scale.metersPerUnit * scale.relativeUncertainty, true).format()

    /**
     * Surface area in words: square model units when uncalibrated (labelled as such), otherwise
     * m² / cm² with the uncertainty that follows from the scale (twice its relative uncertainty).
     */
    fun formatArea(unitsSquared: Double, scale: ScaleCalibration?): String {
        fun sig(x: Double, digits: Int): String {
            if (x == 0.0 || !x.isFinite()) return "0"
            val d = (digits - 1 - kotlin.math.floor(kotlin.math.log10(kotlin.math.abs(x))).toInt()).coerceIn(0, 6)
            return "%.${d}f".format(java.util.Locale.ROOT, x)
        }
        if (scale == null) return "${sig(unitsSquared, 3)} units² (uncalibrated)"
        val m2 = unitsSquared * scale.metersPerUnit * scale.metersPerUnit
        val rel = 2.0 * scale.relativeUncertainty
        val (v, unit) = if (m2 >= 1.0) m2 to "m²" else m2 * 1e4 to "cm²"
        return "${sig(v, 3)} $unit ${formatPercentUncertainty(rel)}"
    }

    /**
     * How far a displayed endpoint may be from the current surface before the measurement is
     * flagged: a few times the picking precision, but at least a small fraction of the model size.
     */
    fun surfaceTolerance(m: Measurement, modelDiagonal: Float): Float =
        max(4.0 * m.pickSigmaUnits, 2e-3 * modelDiagonal).toFloat()

    /**
     * True when an endpoint of [m] no longer lies on the current surface (its surface was removed
     * by a later edit). The measurement itself stays valid — it was taken on the original surface.
     */
    fun endpointOffSurface(m: Measurement, doc: EditDocument, bvh: Bvh, modelDiagonal: Float): Boolean {
        val tol = surfaceTolerance(m, modelDiagonal)
        val (a, b) = EditEngine.displayEndpoints(m, doc)
        return bvh.closestPoint(a, tol) == null || bvh.closestPoint(b, tol) == null
    }

    /** Next free default name "Measurement N". */
    fun nextName(existing: List<Measurement>): String {
        var n = existing.size + 1
        val names = existing.map { it.name }.toSet()
        while ("Measurement $n" in names) n++
        return "Measurement $n"
    }
}
