package dev.pocket3d.core.edit

import dev.pocket3d.core.math.Mat4
import dev.pocket3d.core.math.Quat
import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.scale.ScaleCalibration
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Non-destructive editing. The reconstruction result (model.glb) is never modified: the current
 * mesh is always `base` with the operations in [EditDocument.ops] applied in order. Undo moves
 * the last operation to [EditDocument.redo]; a new operation clears the redo list.
 *
 * Coordinates: every stored point (measurements, scale reference) is kept in BASE model
 * coordinates. Only [EditOp.Reorient] changes the coordinate frame; its cumulative matrix maps
 * base → current coordinates, so stored points follow the model through any orientation /
 * centring edits and through undo/redo without being rewritten.
 */
@Serializable
sealed class EditOp {
    abstract val label: String

    /** Keep (or remove) what lies inside an oriented box given in CURRENT coordinates at the time of the edit. */
    @Serializable @SerialName("crop")
    data class Crop(val center: Vec3, val rotation: Quat, val halfExtents: Vec3, val keepInside: Boolean = true) : EditOp() {
        override val label get() = if (keepInside) "Crop to box" else "Cut out box"
    }

    /** Clip away everything on the negative side of a plane (current coordinates). */
    @Serializable @SerialName("clip_plane")
    data class ClipPlane(val point: Vec3, val normal: Vec3) : EditOp() {
        override val label get() = "Trim below plane"
    }

    /**
     * Delete an explicit set of faces of the mesh as it was when the edit was made. Encoded as
     * sorted runs [start0, length0, start1, length1, …] to stay small for large selections.
     */
    @Serializable @SerialName("delete_faces")
    data class DeleteFaces(val runs: List<Int>, val faceCountBefore: Int) : EditOp() {
        override val label get() = "Delete selection"
        val count: Int get() { var n = 0; var i = 1; while (i < runs.size) { n += runs[i]; i += 2 }; return n }

        fun toMask(): BooleanArray {
            val mask = BooleanArray(faceCountBefore)
            var i = 0
            while (i + 1 < runs.size) {
                val s = runs[i]; val l = runs[i + 1]
                for (k in s until minOf(s + l, faceCountBefore)) mask[k] = true
                i += 2
            }
            return mask
        }

        companion object {
            fun fromMask(mask: BooleanArray): DeleteFaces {
                val runs = ArrayList<Int>()
                var i = 0
                while (i < mask.size) {
                    if (mask[i]) {
                        val s = i
                        while (i < mask.size && mask[i]) i++
                        runs += s; runs += i - s
                    } else i++
                }
                return DeleteFaces(runs, mask.size)
            }
        }
    }

    /** Remove connected pieces smaller than [minAreaFraction] of the largest piece. */
    @Serializable @SerialName("remove_small")
    data class RemoveSmallComponents(val minAreaFraction: Float) : EditOp() {
        override val label get() = "Remove stray pieces"
    }

    /** Keep only the [count] largest connected pieces. */
    @Serializable @SerialName("keep_largest")
    data class KeepLargest(val count: Int = 1) : EditOp() {
        override val label get() = "Keep largest piece"
    }

    /**
     * Rigid re-orientation / re-centring: current' = rotation · current + translation. Never
     * contains scale — real-world scale is a separate, explicit calibration.
     */
    @Serializable @SerialName("reorient")
    data class Reorient(val rotation: Quat, val translation: Vec3, val what: String = "Reorient") : EditOp() {
        override val label get() = what
        fun matrix(): FloatArray = Mat4.trs(translation, rotation, 1f)
    }

    /**
     * Explicit repair: close holes with synthetic surface. The new faces are NOT observed
     * geometry; they carry a separate "repaired" material and zero confidence forever.
     * [maxPerimeter] in current units; holes with a longer boundary are left open. If
     * [holeCentroids] is non-null only the holes whose centroid matches one of them are filled.
     */
    @Serializable @SerialName("fill_holes")
    data class FillHoles(val maxPerimeter: Float, val holeCentroids: List<Vec3>? = null) : EditOp() {
        override val label get() = "Repair holes (synthetic)"
    }

    @Serializable @SerialName("simplify")
    data class Simplify(val targetFaces: Int) : EditOp() {
        override val label get() = "Simplify to ${targetFaces / 1000}k faces"
    }
}

/** A point-to-point measurement; endpoints in BASE model coordinates. */
@Serializable
data class Measurement(
    val id: String,
    val name: String,
    val a: Vec3,
    val b: Vec3,
    /** Picking precision per endpoint in model units when the measurement was taken. */
    val pickSigmaUnits: Double,
    val createdAtMs: Long = 0,
)

@Serializable
data class EditDocument(
    /** SHA-256 of the model.glb these edits belong to; edits are never applied to another model. */
    val baseSha256: String,
    val ops: List<EditOp> = emptyList(),
    val redo: List<EditOp> = emptyList(),
    /** User scale calibration (overrides the reconstruction's scale statement when present). */
    val scale: ScaleCalibration? = null,
    val measurements: List<Measurement> = emptyList(),
    val format: Int = 1,
) {
    val canUndo: Boolean get() = ops.isNotEmpty()
    val canRedo: Boolean get() = redo.isNotEmpty()

    fun push(op: EditOp) = copy(ops = ops + op, redo = emptyList())
    fun undo() = if (ops.isEmpty()) this else copy(ops = ops.dropLast(1), redo = redo + ops.last())
    fun redo() = if (redo.isEmpty()) this else copy(ops = ops + redo.last(), redo = redo.dropLast(1))
    fun reset() = copy(ops = emptyList(), redo = emptyList())

    /** Matrix mapping BASE coordinates to CURRENT coordinates (product of all Reorient ops). */
    fun currentFromBase(): FloatArray {
        var m = Mat4.identity()
        for (op in ops) if (op is EditOp.Reorient) m = Mat4.mul(op.matrix(), m)
        return m
    }

    fun baseFromCurrent(): FloatArray = Mat4.invert(currentFromBase()) ?: Mat4.identity()

    fun toCurrent(basePoint: Vec3): Vec3 = Mat4.transformPoint(currentFromBase(), basePoint)
    fun toBase(currentPoint: Vec3): Vec3 = Mat4.transformPoint(baseFromCurrent(), currentPoint)
}
