package dev.pocket3d.core.edit

import dev.pocket3d.core.math.Quat
import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.mesh.Aabb
import dev.pocket3d.core.mesh.Material
import dev.pocket3d.core.mesh.Mesh
import dev.pocket3d.core.mesh.MeshOps
import dev.pocket3d.core.scale.ScaleCalibration
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

class EditModelTest {
    /** Closed UV sphere (radius r) plus a small detached quad far away ("stray geometry"). */
    private fun sphereWithStray(r: Float = 1f, seg: Int = 24, rings: Int = 12): Mesh {
        val pos = ArrayList<Float>(); val idx = ArrayList<Int>(); val conf = ArrayList<Float>()
        for (j in 0..rings) for (i in 0 until seg) {
            val th = Math.PI * j / rings; val ph = 2 * Math.PI * i / seg
            val st = if (j == 0 || j == rings) 0.0 else sin(th)      // exact poles, so they weld
            pos += (r * st * cos(ph)).toFloat(); pos += (r * cos(th)).toFloat(); pos += (r * st * sin(ph)).toFloat()
            conf += 1f
        }
        for (j in 0 until rings) for (i in 0 until seg) {
            val a = j * seg + i; val b = j * seg + (i + 1) % seg; val c = (j + 1) * seg + i; val d = (j + 1) * seg + (i + 1) % seg
            if (j > 0) { idx += a; idx += b; idx += c }
            if (j < rings - 1) { idx += b; idx += d; idx += c }
        }
        val base = pos.size / 3
        for (p in listOf(floatArrayOf(5f, 0f, 0f), floatArrayOf(5.1f, 0f, 0f), floatArrayOf(5.1f, 0.1f, 0f), floatArrayOf(5f, 0.1f, 0f))) {
            pos += p[0]; pos += p[1]; pos += p[2]; conf += 0.2f
        }
        idx += base; idx += base + 1; idx += base + 2; idx += base; idx += base + 2; idx += base + 3
        return Mesh(pos.toFloatArray(), null, null, conf.toFloatArray(), idx.toIntArray(), null, listOf(Material("scan")))
    }

    private val json = Json { encodeDefaults = true }

    @Test fun undoRedoReplayIsExactAndBaseIsNeverMutated() {
        val base = sphereWithStray()
        val basePositions = base.positions.copyOf(); val baseIndices = base.indices.copyOf()
        var doc = EditDocument(baseSha256 = "abc")
        doc = doc.push(EditOp.KeepLargest(1))
        doc = doc.push(EditOp.ClipPlane(Vec3(0f, -0.5f, 0f), Vec3.Y))
        doc = doc.push(EditOp.Reorient(Quat.axisAngle(Vec3.X, (Math.PI / 2).toFloat()), Vec3(0f, 2f, 0f)))
        val full = EditEngine.apply(base, doc).mesh
        assertTrue(full.faceCount in 1 until base.faceCount)
        assertNotSame(base, full)
        assertTrue(base.positions.contentEquals(basePositions) && base.indices.contentEquals(baseIndices))

        val undone = doc.undo()
        assertEquals(2, undone.ops.size); assertEquals(1, undone.redo.size); assertTrue(undone.canRedo)
        val redone = undone.redo()
        assertEquals(doc.ops, redone.ops); assertFalse(redone.canRedo)
        val again = EditEngine.apply(base, redone).mesh
        assertTrue(again.positions.contentEquals(full.positions) && again.indices.contentEquals(full.indices))

        // a new edit after undo discards the redo branch
        val branched = undone.push(EditOp.RemoveSmallComponents(0.01f))
        assertTrue(branched.redo.isEmpty())
        // undo on an empty stack and redo with nothing to redo are no-ops
        assertEquals(EditDocument("x"), EditDocument("x").undo())
        assertEquals(doc, doc.redo())
        assertTrue(doc.reset().ops.isEmpty())
    }

    @Test fun documentSurvivesSerialisation() {
        var doc = EditDocument(baseSha256 = "abc")
        val mask = BooleanArray(100) { it in 3..9 || it == 50 || it >= 98 }
        doc = doc.push(EditOp.Crop(Vec3(0f, 0.1f, 0f), Quat.IDENTITY, Vec3(1f, 2f, 3f)))
            .push(EditOp.DeleteFaces.fromMask(mask))
            .push(EditOp.FillHoles(0.5f, listOf(Vec3(0f, 1f, 0f))))
            .push(EditOp.Simplify(5000))
            .copy(scale = ScaleCalibration.fromReference(Vec3.ZERO, Vec3(1f, 0f, 0f), 0.2, 0.001, 0.01),
                  measurements = listOf(Measurement("m1", "height", Vec3(0f, -1f, 0f), Vec3(0f, 1f, 0f), 0.01)))
        val back = json.decodeFromString(EditDocument.serializer(), json.encodeToString(EditDocument.serializer(), doc))
        assertEquals(doc, back)
        val del = back.ops[1] as EditOp.DeleteFaces
        assertTrue(del.toMask().contentEquals(mask))
        assertEquals(10, del.count)
        assertEquals(listOf(3, 7, 50, 1, 98, 2), del.runs)
    }

    @Test fun measurementsStayAttachedThroughReorientAndUndo() {
        val base = sphereWithStray()
        val scale = ScaleCalibration.fromReference(Vec3(0f, -1f, 0f), Vec3(0f, 1f, 0f), 0.10, 0.0005, 0.005)!!   // Ø 10 cm
        val m = Measurement("m1", "equator", Vec3(-1f, 0f, 0f), Vec3(1f, 0f, 0f), 0.005)
        var doc = EditDocument("abc", scale = scale, measurements = listOf(m))
        val before = EditEngine.measure(m, EditEngine.effectiveScale(doc, null)).format()
        assertEquals(0.10, EditEngine.measure(m, scale).value, 1e-6)

        doc = doc.push(EditOp.Reorient(Quat.axisAngle(Vec3.Z, (Math.PI / 2).toFloat()), Vec3(3f, 0f, 0f), "Rotate"))
        doc = doc.push(EditEngine.centerOnGround(EditEngine.apply(base, doc.push(EditOp.KeepLargest(1))).mesh))
        // label is identical: the measurement lives in base coordinates
        assertEquals(before, EditEngine.measure(doc.measurements[0], EditEngine.effectiveScale(doc, null)).format())
        // displayed endpoints follow the model: they still lie on the transformed sphere's surface
        val mesh = EditEngine.apply(base, doc.push(EditOp.KeepLargest(1))).mesh
        val (a, b) = EditEngine.displayEndpoints(doc.measurements[0], doc)
        val box = Aabb.of(mesh.positions)
        assertEquals(2f, a.distanceTo(b), 1e-4f)
        for (p in listOf(a, b)) assertEquals(1f, p.distanceTo(box.center), 2e-2f)
        // round trip current <-> base
        val q = Vec3(0.3f, -0.2f, 0.9f)
        val rt = doc.toBase(doc.toCurrent(q))
        assertTrue(abs(rt.x - q.x) < 1e-4f && abs(rt.y - q.y) < 1e-4f && abs(rt.z - q.z) < 1e-4f)
        // undo both reorients: endpoints are back where they were picked
        val undone = doc.undo().undo()
        val (a0, _) = EditEngine.displayEndpoints(undone.measurements[0], undone)
        assertEquals(0f, a0.distanceTo(m.a), 1e-6f)
        assertEquals(before, EditEngine.measure(undone.measurements[0], EditEngine.effectiveScale(undone, null)).format())
    }

    @Test fun reorientNeverChangesSize() {
        val base = sphereWithStray()
        val doc = EditDocument("abc").push(EditOp.Reorient(Quat.axisAngle(Vec3(1f, 2f, 3f), 1.1f), Vec3(4f, 5f, 6f)))
        val out = EditEngine.apply(base, doc).mesh
        assertEquals(MeshOps.surfaceArea(base), MeshOps.surfaceArea(out), 1e-3f)
        assertEquals(base.faceCount, out.faceCount)
    }

    @Test fun centerOnGroundPutsLowestPointAtZeroAndCentreOnAxis() {
        val base = MeshOps.keepLargestComponents(sphereWithStray(), 1)
        val moved = MeshOps.transform(base, EditOp.Reorient(Quat.IDENTITY, Vec3(2f, 7f, -3f)).matrix())
        val op = EditEngine.centerOnGround(moved)
        val b = Aabb.of(EditEngine.applyOp(moved, op).positions)
        assertEquals(0f, b.min.y, 1e-5f); assertEquals(0f, b.center.x, 1e-5f); assertEquals(0f, b.center.z, 1e-5f)
    }

    @Test fun editsThatWouldDeleteEverythingAreRefusedWithANote() {
        val base = sphereWithStray()
        val doc = EditDocument("abc").push(EditOp.ClipPlane(Vec3(0f, 100f, 0f), Vec3.Y))   // nothing is above y = 100
        val r = EditEngine.apply(base, doc)
        assertEquals(base.faceCount, r.mesh.faceCount)
        assertEquals(1, r.notes.size)
        assertTrue(r.notes[0].contains("skipped"))
    }

    @Test fun deleteFacesIsSkippedWhenItNoLongerMatchesTheMesh() {
        val base = sphereWithStray()
        val stale = EditOp.DeleteFaces(listOf(0, 10), faceCountBefore = base.faceCount + 5)
        val r = EditEngine.apply(base, EditDocument("abc").push(stale))
        assertEquals(base.faceCount, r.mesh.faceCount)
        assertEquals(1, r.notes.size)
        val ok = EditOp.DeleteFaces(listOf(0, 10), faceCountBefore = base.faceCount)
        assertEquals(base.faceCount - 10, EditEngine.apply(base, EditDocument("abc").push(ok)).mesh.faceCount)
    }

    @Test fun strayPiecesAndHoleRepairAreExplicitAndFlagged() {
        val base = sphereWithStray()
        assertEquals(2, MeshOps.components(base).count)
        val cleaned = EditEngine.apply(base, EditDocument("abc").push(EditOp.RemoveSmallComponents(0.05f))).mesh
        assertEquals(1, MeshOps.components(cleaned).count)
        // cut the top off -> one hole; nothing fills it until the user asks
        val cut = EditDocument("abc").push(EditOp.KeepLargest(1)).push(EditOp.ClipPlane(Vec3(0f, 0.6f, 0f), Vec3(0f, -1f, 0f)))
        val open = EditEngine.apply(base, cut).mesh
        assertEquals(0, MeshOps.findHoles(MeshOps.keepLargestComponents(base, 1)).size)
        assertEquals(1, MeshOps.findHoles(open).size)
        assertTrue(open.materials.none { it.repaired })
        val repaired = EditEngine.apply(base, cut.push(EditOp.FillHoles(Float.POSITIVE_INFINITY))).mesh
        assertEquals(0, MeshOps.findHoles(repaired).size)
        val repairedMat = repaired.materials.indexOfFirst { it.repaired }
        assertTrue(repairedMat >= 0)
        val repairedFaces = (0 until repaired.faceCount).filter { repaired.materialOfFace(it) == repairedMat }
        assertEquals(repaired.faceCount - open.faceCount, repairedFaces.size)
        // synthetic surface carries zero evidence; observed surface keeps its own
        val conf = repaired.confidence!!
        val newVertices = (open.vertexCount until repaired.vertexCount)
        assertTrue(newVertices.all { conf[it] == 0f })
        // undo removes the repair again
        assertEquals(1, MeshOps.findHoles(EditEngine.apply(base, cut.push(EditOp.FillHoles(1e9f)).undo()).mesh).size)
    }

    @Test fun repairedSurfaceStaysMarkedThroughSimplification() {
        val base = sphereWithStray(seg = 48, rings = 24)
        val doc = EditDocument("abc").push(EditOp.KeepLargest(1)).push(EditOp.ClipPlane(Vec3(0f, 0.6f, 0f), Vec3(0f, -1f, 0f)))
            .push(EditOp.FillHoles(Float.POSITIVE_INFINITY))
        val repaired = EditEngine.apply(base, doc).mesh
        val before = MeshOps.stats(repaired)
        assertTrue(before.repairedAreaFraction > 0.02f)
        val simplified = EditEngine.apply(base, doc.push(EditOp.Simplify(repaired.faceCount / 3))).mesh
        assertTrue(simplified.faceCount < repaired.faceCount * 0.6)
        val after = MeshOps.stats(simplified)
        // the synthetic patch is still a separate, flagged material covering the same share of the surface
        assertTrue(simplified.materials.any { it.repaired })
        assertEquals(before.repairedAreaFraction, after.repairedAreaFraction, 0.02f)
        assertEquals(0, MeshOps.findHoles(simplified).size)
        // and observed surface did not turn into "repaired" (or vice versa) at the seam
        val m = simplified.materials.indexOfFirst { it.repaired }
        val conf = simplified.confidence!!
        for (f in 0 until simplified.faceCount) if (simplified.materialOfFace(f) != m) {
            val i = simplified.indices
            assertTrue(conf[i[3 * f]] > 0f || conf[i[3 * f + 1]] > 0f || conf[i[3 * f + 2]] > 0f)
        }
    }

    @Test fun userCalibrationOverridesReconstructionScaleAndCanBeCleared() {
        val recon = ScaleCalibration(0.5, 0.05, ScaleCalibration.Source.AR_TRACKING)
        val user = ScaleCalibration.fromReference(Vec3.ZERO, Vec3(1f, 0f, 0f), 0.3, 0.001, 0.01)!!
        assertEquals(recon, EditEngine.effectiveScale(EditDocument("a"), recon))
        assertEquals(user, EditEngine.effectiveScale(EditDocument("a", scale = user), recon))
        assertNull(EditEngine.effectiveScale(EditDocument("a"), null))
    }
}
