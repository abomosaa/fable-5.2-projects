package dev.pocket3d.core.edit

import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.mesh.Mesh
import dev.pocket3d.core.mesh.MeshOps
import dev.pocket3d.core.mesh.OrientedBox
import dev.pocket3d.core.scale.Length
import dev.pocket3d.core.scale.Measure
import dev.pocket3d.core.scale.ScaleCalibration

/**
 * Applies an [EditDocument] to the immutable base mesh. Pure and deterministic: the same base
 * mesh and operation list always yield the same result, which is what makes undo/redo (replay
 * of a shorter/longer prefix) and reopening a project exact.
 */
object EditEngine {
    class Result(
        val mesh: Mesh,
        /** One note per operation that did nothing or was skipped (shown to the user). */
        val notes: List<String>,
    )

    fun applyOp(mesh: Mesh, op: EditOp): Mesh = when (op) {
        is EditOp.Crop -> MeshOps.cropToBox(mesh, OrientedBox(op.center, op.rotation, op.halfExtents), op.keepInside,
                                            clip = true)
        is EditOp.ClipPlane -> MeshOps.clipByPlane(mesh, op.point, op.normal)
        is EditOp.DeleteFaces ->
            // The selection refers to the mesh as it was when the edit was made; if the mesh no
            // longer matches (should not happen with a deterministic replay) the op is skipped
            // rather than deleting unrelated faces.
            if (op.faceCountBefore == mesh.faceCount) MeshOps.removeFaces(mesh, op.toMask()) else mesh
        is EditOp.RemoveSmallComponents -> MeshOps.removeSmallComponents(mesh, op.minAreaFraction)
        is EditOp.KeepLargest -> MeshOps.keepLargestComponents(mesh, op.count)
        is EditOp.Reorient -> MeshOps.transform(mesh, op.matrix())
        is EditOp.FillHoles -> {
            val holes = MeshOps.findHoles(mesh)
            val wanted: Set<Int>? = op.holeCentroids?.let { cs ->
                holes.filter { h -> cs.any { c -> c.distanceTo(h.centroid) <= 1e-3f * maxOf(1f, h.perimeter) + 1e-6f } }
                    .map { it.index }.toSet()
            }
            MeshOps.fillHoles(mesh, wanted, op.maxPerimeter).mesh
        }
        is EditOp.Simplify ->
            if (mesh.faceCount > op.targetFaces) MeshOps.simplify(mesh, op.targetFaces).mesh else mesh
    }

    /** Applies all operations of [doc] to [base]. The base mesh is never modified. */
    fun apply(base: Mesh, doc: EditDocument): Result {
        var mesh = base
        val notes = ArrayList<String>()
        for (op in doc.ops) {
            val before = mesh
            val after = applyOp(mesh, op)
            if (after.faceCount == 0) {
                // Refuse to produce an empty model; keep the previous state and say so.
                notes += "\"${op.label}\" would remove everything and was skipped."
                continue
            }
            if (op is EditOp.DeleteFaces && op.faceCountBefore != before.faceCount)
                notes += "\"${op.label}\" no longer matches the model and was skipped."
            mesh = after
        }
        return Result(mesh, notes)
    }

    /** Effective scale: an explicit user calibration wins over the reconstruction's own scale. */
    fun effectiveScale(doc: EditDocument, reconstruction: ScaleCalibration?): ScaleCalibration? =
        doc.scale ?: reconstruction

    /** Length of a stored measurement; independent of Reorient edits because both ends are in base coordinates. */
    fun measure(m: Measurement, scale: ScaleCalibration?): Length = Measure.length(m.a, m.b, scale, m.pickSigmaUnits)

    /** Current-frame endpoints of a measurement for display. */
    fun displayEndpoints(m: Measurement, doc: EditDocument): Pair<Vec3, Vec3> = doc.toCurrent(m.a) to doc.toCurrent(m.b)

    /**
     * Rigid re-orientation that puts the mesh upright on the ground: the bounding-box centre
     * moves to x = z = 0 and the lowest point to y = 0.
     */
    fun centerOnGround(mesh: Mesh): EditOp.Reorient {
        val b = dev.pocket3d.core.mesh.Aabb.of(mesh.positions)
        return EditOp.Reorient(dev.pocket3d.core.math.Quat.IDENTITY,
                               Vec3(-b.center.x, -b.min.y, -b.center.z), "Centre on ground")
    }
}
