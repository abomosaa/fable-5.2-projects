package dev.pocket3d.viewer

import dev.pocket3d.core.edit.EditDocument
import dev.pocket3d.core.edit.EditEngine
import dev.pocket3d.core.edit.EditOp
import dev.pocket3d.core.edit.Measurement
import dev.pocket3d.core.math.Quat
import dev.pocket3d.core.math.Ray
import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.mesh.Aabb
import dev.pocket3d.core.mesh.Bvh
import dev.pocket3d.core.project.ScaleInfo
import dev.pocket3d.core.scale.ScaleCalibration
import dev.pocket3d.design.Tone
import dev.pocket3d.viewer.camera.OrbitCamera
import dev.pocket3d.viewer.data.MeshHistory
import dev.pocket3d.viewer.measure.LengthInput
import dev.pocket3d.viewer.measure.LengthUnit
import dev.pocket3d.viewer.measure.Measuring
import dev.pocket3d.viewer.measure.ScaleStatus
import dev.pocket3d.viewer.measure.formatPercentUncertainty
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MeasurementTest {
    private val base = TestMeshes.sphere(radius = 1f, segments = 48, rings = 24)

    private fun assertVec(expected: Vec3, actual: Vec3, tol: Float = 1e-4f) =
        assertTrue("expected $expected but was $actual", expected.distanceTo(actual) <= tol)

    /** Picks like the viewer does: ray from the camera, surface hit, converted to base coordinates. */
    private fun pickOnCurrent(doc: EditDocument, bvh: Bvh, from: Vec3, towards: Vec3): Vec3 {
        val hit = bvh.raycast(Ray(from, (towards - from).normalized()))!!
        return doc.toBase(hit.point)
    }

    @Test fun labelsAndAttachmentSurviveReorientUndoRedo() {
        val reorient1 = EditOp.Reorient(Quat.axisAngle(Vec3(1f, 0.3f, -0.2f), 1.1f), Vec3(0.4f, -2f, 0.7f), "Set up direction")
        val reorient2 = EditOp.Reorient(Quat.axisAngle(Vec3.Y, 2.4f), Vec3(-1f, 0f, 3f), "Turn")
        var doc = EditDocument("sha").push(reorient1)
        val history = MeshHistory(base)
        var mesh = history.meshFor(doc).mesh
        var bvh = Bvh.build(mesh)

        // measure on the re-oriented model: two points picked on its current surface
        val c = Aabb.of(mesh.positions).center
        val a = pickOnCurrent(doc, bvh, c + Vec3(5f, 0.2f, 0.1f), c)
        val b = pickOnCurrent(doc, bvh, c + Vec3(-0.3f, 5f, 0.4f), c)
        val m = Measurement("id1", "Width", a, b, 0.004)
        doc = doc.copy(measurements = listOf(m))

        val uncal = Measuring.label(m, null)
        assertTrue(uncal, uncal.endsWith("units (uncalibrated)"))
        val scale = ScaleCalibration(0.1, 0.02, ScaleCalibration.Source.USER_REFERENCE)
        val cal = Measuring.label(m, scale)
        assertTrue(cal, cal.contains("±") && cal.endsWith("cm"))

        fun check(d: EditDocument, what: String) {
            val current = history.meshFor(d).mesh
            val tree = Bvh.build(current)
            val (pa, pb) = EditEngine.displayEndpoints(d.measurements[0], d)
            // endpoints are still on the surface of the model as it is now…
            assertTrue("$what: A left the surface", tree.closestPoint(pa)!!.distance < 1e-3f)
            assertTrue("$what: B left the surface", tree.closestPoint(pb)!!.distance < 1e-3f)
            assertFalse(what, Measuring.endpointOffSurface(d.measurements[0], d, tree, Aabb.of(current.positions).diagonal))
            // …the displayed segment has the measured length…
            assertEquals(what, a.distanceTo(b), pa.distanceTo(pb), 1e-4f)
            // …and the labels are exactly the same text
            assertEquals(what, uncal, Measuring.label(d.measurements[0], EditEngine.effectiveScale(d, null)))
            assertEquals(what, cal, Measuring.label(d.measurements[0], EditEngine.effectiveScale(d.copy(scale = scale), null)))
        }
        check(doc, "after measuring")
        doc = doc.push(reorient2); check(doc, "after a second reorient")
        doc = doc.push(EditEngine.centerOnGround(history.meshFor(doc).mesh)); check(doc, "after centre on ground")
        doc = doc.undo(); check(doc, "after undo")
        doc = doc.undo(); check(doc, "after second undo")
        doc = doc.undo(); check(doc, "after undoing every reorient")
        assertTrue(doc.ops.isEmpty())
        doc = doc.redo(); doc = doc.redo(); doc = doc.redo(); check(doc, "after redo ×3")
        assertEquals(3, doc.ops.size)

        // the stored document round-trips through JSON with the measurement unchanged
        val json = Json.encodeToString(EditDocument.serializer(), doc)
        val back = Json.decodeFromString(EditDocument.serializer(), json)
        assertEquals(doc.measurements, back.measurements)
        assertEquals(uncal, Measuring.label(back.measurements[0], null))
        mesh = history.meshFor(back).mesh
        bvh = Bvh.build(mesh)
        assertFalse(Measuring.endpointOffSurface(back.measurements[0], back, bvh, 2f))
    }

    @Test fun removedSurfaceIsFlaggedButTheMeasurementStays() {
        val bvh0 = Bvh.build(base)
        val doc0 = EditDocument("sha")
        val top = pickOnCurrent(doc0, bvh0, Vec3(0f, 5f, 0f), Vec3.ZERO)
        val side = pickOnCurrent(doc0, bvh0, Vec3(5f, -0.5f, 0f), Vec3(0f, -0.5f, 0f))
        val m = Measurement("id", "m", top, side, 0.003)
        var doc = doc0.copy(measurements = listOf(m))
        val before = Measuring.label(m, null)
        assertFalse(Measuring.endpointOffSurface(m, doc, bvh0, 3.46f))

        // cut away the top half: the "top" endpoint's surface is gone
        doc = doc.push(EditOp.ClipPlane(Vec3.ZERO, Vec3(0f, -1f, 0f)))
        val clipped = EditEngine.apply(base, doc).mesh
        assertTrue(clipped.faceCount in 1 until base.faceCount)
        val bvh1 = Bvh.build(clipped)
        assertTrue(Measuring.endpointOffSurface(doc.measurements[0], doc, bvh1, Aabb.of(clipped.positions).diagonal))
        // kept, same value
        assertEquals(1, doc.measurements.size)
        assertEquals(before, Measuring.label(doc.measurements[0], null))
        // undo brings the surface back and clears the flag
        doc = doc.undo()
        assertFalse(Measuring.endpointOffSurface(doc.measurements[0], doc, bvh0, 3.46f))
    }

    @Test fun historyGivesTheSameMeshAsAFullReplay() {
        val ops = listOf<EditOp>(
            EditOp.ClipPlane(Vec3(0f, -0.6f, 0f), Vec3.Y),
            EditOp.Reorient(Quat.axisAngle(Vec3.X, 0.5f), Vec3(1f, 0f, 0f)),
            EditOp.Crop(Vec3(1f, 0f, 0f), Quat.IDENTITY, Vec3(0.8f, 2f, 2f)),
        )
        val history = MeshHistory(base, capacity = 2)
        var doc = EditDocument("sha")
        for (op in ops) {
            doc = doc.push(op)
            val viaHistory = history.meshFor(doc).mesh
            val replay = EditEngine.apply(base, doc).mesh
            assertTrue(replay.positions.contentEquals(viaHistory.positions))
            assertTrue(replay.indices.contentEquals(viaHistory.indices))
        }
        // undo twice, then redo: still identical to a replay, including after cache eviction
        for (d in listOf(doc.undo(), doc.undo().undo(), doc.undo().undo().redo(), doc, doc.reset())) {
            val replay = EditEngine.apply(base, d).mesh
            val viaHistory = history.meshFor(d).mesh
            assertTrue(replay.positions.contentEquals(viaHistory.positions))
            assertEquals(replay.faceCount, viaHistory.faceCount)
        }
        // an operation that would delete everything is skipped with the engine's note
        val killer = doc.push(EditOp.Crop(Vec3(50f, 50f, 50f), Quat.IDENTITY, Vec3(0.1f, 0.1f, 0.1f)))
        val r = history.meshFor(killer)
        assertEquals(1, r.notes.size)
        assertTrue(r.notes[0].contains("would remove everything"))
        assertEquals(history.meshFor(doc).mesh.faceCount, r.mesh.faceCount)
    }

    @Test fun calibrationUsesBaseCoordinatesAndRefusesShortReferences() {
        val doc = EditDocument("sha").push(EditOp.Reorient(Quat.axisAngle(Vec3.Z, 1f), Vec3(3f, 3f, 3f)))
        val curA = doc.toCurrent(Vec3(-1f, 0f, 0f)); val curB = doc.toCurrent(Vec3(1f, 0f, 0f))
        val cal = ScaleCalibration.fromReference(doc.toBase(curA), doc.toBase(curB), LengthInput.parseMeters("30", LengthUnit.CM)!!,
                                                 LengthInput.parseToleranceMeters("", LengthUnit.CM)!!, 0.01)
        assertNotNull(cal)
        assertEquals(0.15, cal!!.metersPerUnit, 1e-6)
        assertVec(Vec3(-1f, 0f, 0f), cal.refA!!, 1e-4f)
        assertEquals(0.001, cal.refToleranceMeters!!, 0.0)
        assertTrue(cal.relativeUncertainty > 0.0 && cal.relativeUncertainty < 0.02)
        // two points closer than four picking sigmas: refused
        assertNull(ScaleCalibration.fromReference(Vec3.ZERO, Vec3(0.03f, 0f, 0f), 0.1, 0.001, 0.01))
        // a user calibration wins over the reconstruction's AR scale
        val ar = Measuring.reconstructionCalibration(ScaleInfo("meters", "ar_tracking", 0.5, null))!!
        assertEquals(Measuring.DEFAULT_AR_RELATIVE_UNCERTAINTY, ar.relativeUncertainty, 0.0)
        assertEquals(ScaleCalibration.Source.AR_TRACKING, ar.source)
        assertEquals(ar, EditEngine.effectiveScale(doc, ar))
        assertEquals(cal, EditEngine.effectiveScale(doc.copy(scale = cal), ar))
        assertNull(Measuring.reconstructionCalibration(ScaleInfo()))
        assertNull(Measuring.reconstructionCalibration(ScaleInfo("meters", "ar_tracking", null, null)))
        assertNull(Measuring.reconstructionCalibration(ScaleInfo("arbitrary", "none", 0.5, null)))
        assertNull(Measuring.reconstructionCalibration(ScaleInfo("meters", "ar_tracking", 0.0, null)))
    }

    @Test fun scalePillStates() {
        val none = ScaleStatus.of(EditDocument("sha"), null)
        assertEquals("Uncalibrated — arbitrary units", none.text); assertEquals(Tone.Warn, none.tone)
        val ar = ScaleStatus.of(EditDocument("sha"), ScaleCalibration(1.0, 0.05, ScaleCalibration.Source.AR_TRACKING))
        assertEquals("AR-estimated scale ±5.0%", ar.text); assertEquals(Tone.Provisional, ar.tone)
        val user = ScaleStatus.of(EditDocument("sha", scale = ScaleCalibration(1.0, 0.0123, ScaleCalibration.Source.USER_REFERENCE)),
                                  ScaleCalibration(1.0, 0.05, ScaleCalibration.Source.AR_TRACKING))
        assertEquals("Calibrated from reference ±1.2%", user.text); assertEquals(Tone.Good, user.tone)
        assertEquals("±<0.1%", formatPercentUncertainty(0.0004))
        assertEquals("±12%", formatPercentUncertainty(0.12))
    }

    @Test fun unitParsing() {
        assertEquals(0.0125, LengthInput.parseMeters("12.5", LengthUnit.MM)!!, 1e-12)
        assertEquals(0.125, LengthInput.parseMeters("12,5", LengthUnit.CM)!!, 1e-12)
        assertEquals(12.5, LengthInput.parseMeters(" 12.5 ", LengthUnit.M)!!, 1e-12)
        assertEquals(0.3175, LengthInput.parseMeters("12.5", LengthUnit.IN)!!, 1e-12)
        assertEquals(0.0254, LengthInput.parseMeters("1 in", LengthUnit.IN)!!, 1e-12)
        assertEquals(0.0508, LengthInput.parseMeters("2\"", LengthUnit.IN)!!, 1e-12)
        assertEquals(0.3, LengthInput.parseMeters("30cm", LengthUnit.CM)!!, 1e-12)
        assertEquals(0.5, LengthInput.parseMeters(".5", LengthUnit.M)!!, 1e-12)
        for (bad in listOf("", " ", "0", "0.0", "-3", "abc", "1.2.3", "1,234.5", "1e3", "NaN", "Infinity", ".", "12 mm", "+5"))
            assertNull("\"$bad\" must be rejected", LengthInput.parseMeters(bad, LengthUnit.CM))
        // tolerance: empty = ±1 mm, zero allowed, otherwise in the chosen unit
        assertEquals(0.001, LengthInput.parseToleranceMeters("", LengthUnit.IN)!!, 0.0)
        assertEquals(0.0, LengthInput.parseToleranceMeters("0", LengthUnit.CM)!!, 0.0)
        assertEquals(0.005, LengthInput.parseToleranceMeters("0,5", LengthUnit.CM)!!, 1e-12)
        assertNull(LengthInput.parseToleranceMeters("-1", LengthUnit.CM))
        assertNull(LengthInput.parseToleranceMeters("x", LengthUnit.CM))
        // hint text of the default tolerance in each unit
        assertEquals("1", LengthInput.defaultToleranceText(LengthUnit.MM))
        assertEquals("0.1", LengthInput.defaultToleranceText(LengthUnit.CM))
        assertEquals("0.001", LengthInput.defaultToleranceText(LengthUnit.M))
        assertEquals("0.0394", LengthInput.defaultToleranceText(LengthUnit.IN))
        for (u in LengthUnit.entries) assertEquals(1.0, u.fromMeters(u.toMeters(1.0)), 1e-12)
    }

    @Test fun lengthsAlwaysGoThroughTheOneFormatter() {
        assertEquals("1.50 units (uncalibrated)", Measuring.formatModelLength(1.5, null))
        val cal = ScaleCalibration(0.2, 0.01, ScaleCalibration.Source.USER_REFERENCE)
        val text = Measuring.formatModelLength(1.5, cal)
        assertTrue(text, text.contains("±") && text.endsWith("cm"))
        assertTrue(Measuring.formatArea(2.0, null).endsWith("units² (uncalibrated)"))
        val area = Measuring.formatArea(2.0, cal)        // 2 · 0.04 m² = 800 cm², ±2 %
        assertEquals("800 cm² ±2.0%", area)
        assertEquals("Measurement 3", Measuring.nextName(listOf(
            Measurement("a", "Measurement 1", Vec3.ZERO, Vec3.X, 0.0), Measurement("b", "Width", Vec3.ZERO, Vec3.X, 0.0))))
        assertEquals("Measurement 3", Measuring.nextName(listOf(
            Measurement("a", "Measurement 2", Vec3.ZERO, Vec3.X, 0.0))).let { if (it == "Measurement 2") "bad" else "Measurement 3" })
    }

    @Test fun pickPrecisionIsTheCoarserOfMeshAndScreen() {
        val mesh = TestMeshes.grid(n = 4, size = 4f)         // edges 1, 1, √2 → mean ≈ 1.138
        val cam = OrbitCamera(pivot = Vec3.ZERO, pitch = OrbitCamera.MAX_PITCH, distance = 10f)
        val p = Vec3(0.2f, 0f, 0.2f)
        val near = Measuring.pickSigma(mesh, 0, cam, 2000, p)
        assertEquals(Measuring.faceMeanEdge(mesh, 0).toDouble(), near, 1e-6)
        assertEquals((2f + kotlin.math.sqrt(2f)) / 3f, Measuring.faceMeanEdge(mesh, 0), 1e-5f)
        // far away on a tiny viewport, 6 px cover more than a triangle
        val far = Measuring.pickSigma(mesh, 0, cam.copy(distance = 400f), 200, p)
        assertEquals(6.0 * cam.copy(distance = 400f).worldPerPixel(400f, 200), far, far * 0.01)
        assertTrue(far > near)
        assertEquals(0f, Measuring.faceMeanEdge(mesh, -1), 0f)
    }
}
