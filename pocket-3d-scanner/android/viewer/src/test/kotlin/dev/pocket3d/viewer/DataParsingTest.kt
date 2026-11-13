package dev.pocket3d.viewer

import dev.pocket3d.core.capture.CoverageGrid
import dev.pocket3d.core.edit.EditDocument
import dev.pocket3d.core.edit.EditOp
import dev.pocket3d.core.math.Quat
import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.mesh.Aabb
import dev.pocket3d.core.mesh.GlbReader
import dev.pocket3d.viewer.data.CamerasJson
import dev.pocket3d.viewer.data.Diagnostics
import dev.pocket3d.viewer.data.ModelExtras
import dev.pocket3d.viewer.data.ModelLoadException
import dev.pocket3d.viewer.data.ModelLoader
import dev.pocket3d.viewer.data.SparsePreview
import dev.pocket3d.viewer.scene.SceneBuilders
import dev.pocket3d.viewer.scene.ViewpointCoverage
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Base64

class DataParsingTest {
    private fun b64Floats(vararg v: Float): String {
        val bb = ByteBuffer.allocate(v.size * 4).order(ByteOrder.LITTLE_ENDIAN)
        v.forEach { bb.putFloat(it) }
        return Base64.getEncoder().encodeToString(bb.array())
    }

    @Test fun sparsePreviewDecodesLittleEndianFloatsAndColours() {
        val xyz = b64Floats(1f, 2f, 3f, -4.5f, 0f, 1e-3f)
        val rgb = Base64.getEncoder().encodeToString(byteArrayOf(255.toByte(), 0, 16, 1, 2, 3))
        val p = SparsePreview.parse("""
            {"provisional": true, "units": "arbitrary",
             "points": {"count": 2, "total_in_model": 9, "xyz_f32_b64": "$xyz", "rgb_u8_b64": "$rgb"},
             "cameras": [{"id": "0001", "name": "a.jpg", "position": [0, 0, 2], "q": [0, 0, 0, 1], "fov_y_deg": 50, "width": 400, "height": 300},
                         {"id": "bad", "position": [0, 0], "q": [0, 0, 0, 1]}],
             "unregistered": [{"id": "0007", "reason": "no_reliable_matches"}, {"id": "0008", "reason": "separate_group"}],
             "object": {"center": [0.1, 0.2, 0.3], "radius_estimate": 0.5},
             "ground": {"normal": [0, 2, 0], "d": 0.8}, "future_field": {"x": 1}}
        """)
        assertTrue(p.provisional)
        assertEquals(2, p.pointCount)
        assertEquals(9, p.totalPointsInModel)
        assertTrue(floatArrayOf(1f, 2f, 3f, -4.5f, 0f, 1e-3f).contentEquals(p.points))
        assertEquals(255, p.colors[0].toInt() and 0xff)
        assertEquals(1, p.cameras.size)                       // the malformed camera is dropped, not fatal
        assertEquals(2, p.unregistered.size)
        assertEquals(Vec3(0.1f, 0.2f, 0.3f), p.objectCenter)
        assertEquals(0.5f, p.objectRadius, 0f)
        // plane normalised: n = (0,1,0), d = 0.4 → y = −0.4
        assertEquals(Vec3.Y, p.ground!!.normal)
        assertEquals(-0.4f, p.ground!!.point.y, 1e-6f)
        assertEquals(1.4f, p.ground!!.signedDistance(Vec3(5f, 1f, 5f)), 1e-6f)

        val scene = SparseScene.build(p)
        assertEquals(12, scene.points.size)
        assertEquals(1f, scene.points[3], 0f); assertEquals(16 / 255f, scene.points[5], 1e-6f)
        assertEquals(10, scene.frusta.size)
        assertEquals(64 * 3, scene.guides.size)
        assertNotNull(scene.grid)
        assertTrue(scene.bounds.contains(p.objectCenter))
    }

    @Test fun sparsePreviewRejectsDamagedFilesWithReadableMessages() {
        fun failure(text: String): String = try { SparsePreview.parse(text); fail("expected failure"); "" }
            catch (e: IllegalArgumentException) { e.message!! }
        assertTrue(failure("not json {").contains("not valid JSON"))
        assertTrue(failure("[1, 2]").contains("unexpected structure"))
        assertTrue(failure("""{"points": {"xyz_f32_b64": "!!!!"}}""").contains("corrupt"))
        assertTrue(failure("""{"points": {"xyz_f32_b64": "${Base64.getEncoder().encodeToString(ByteArray(13))}"}}""").contains("truncated"))
        assertTrue(failure("""{"points": {"count": 5, "xyz_f32_b64": "${b64Floats(1f, 2f, 3f)}"}}""").contains("declared count"))
        assertTrue(failure("""{"points": {"xyz_f32_b64": "${b64Floats(1f, Float.NaN, 3f)}"}}""").contains("invalid numbers"))
        // an empty but well-formed preview is fine
        val empty = SparsePreview.parse("{}")
        assertEquals(0, empty.pointCount); assertTrue(empty.cameras.isEmpty()); assertNull(empty.ground)
        // colours of the wrong length are ignored rather than misapplied
        val p = SparsePreview.parse("""{"points": {"xyz_f32_b64": "${b64Floats(1f, 2f, 3f)}", "rgb_u8_b64": "AAAAAAAA"}}""")
        assertEquals(0, p.colors.size)
        assertEquals(0.8f, SparseScene.build(p).points[3], 0f)
    }

    @Test fun realSparsePreviewParses() {
        assumeTrue(TestMeshes.REAL_SPARSE.isFile)
        val text = TestMeshes.REAL_SPARSE.readText()
        val root = Json.parseToJsonElement(text).jsonObject
        val declared = root["points"]!!.jsonObject["count"].toString().toInt()
        val p = SparsePreview.parse(text)
        assertTrue(p.provisional)
        assertEquals(declared, p.pointCount)
        assertTrue(p.pointCount > 1000)
        assertEquals(p.pointCount * 3, p.colors.size)
        assertTrue(p.totalPointsInModel >= p.pointCount)
        assertTrue(p.cameras.size >= 3)
        assertEquals("arbitrary", p.units)
        assertTrue(p.objectRadius > 0f)
        // the tie points lie around the object: most within a few object radii of its centre
        var nearCount = 0
        for (i in 0 until p.pointCount) if (Vec3.of(p.points, 3 * i).distanceTo(p.objectCenter) < 6f * p.objectRadius) nearCount++
        assertTrue("only $nearCount of ${p.pointCount} points near the object", nearCount > p.pointCount * 0.8)
        // colours are not all one value (i.e. really decoded)
        assertTrue(p.colors.toSet().size > 16)
        // every camera looks roughly at the object
        val placed = SceneBuilders.placeCameras(p.cameras, null)
        val looking = placed.count { it.forward.dot((p.objectCenter - it.position).normalized()) > 0.5f }
        assertTrue(looking >= placed.size * 0.9)

        val scene = SparseScene.build(p)
        assertEquals(p.pointCount * 6, scene.points.size)
        assertEquals(p.cameras.size * 10, scene.frusta.size)
        for (c in placed) assertTrue(c.position.distanceTo(scene.bounds.center) <= scene.bounds.diagonal)
        assertTrue(scene.points.all { it.isFinite() })
    }

    @Test fun realGlbExtrasCamerasAndDiagnostics() {
        assumeTrue(TestMeshes.REAL_GLB.isFile && TestMeshes.REAL_CAMERAS.isFile && TestMeshes.REAL_DIAGNOSTICS.isFile)
        val glb = ModelLoader.readGlb(TestMeshes.REAL_GLB)
        val mesh = glb.mesh
        assertTrue(mesh.faceCount > 10_000)
        assertNotNull("the companion's _CONFIDENCE attribute must arrive", mesh.confidence)
        assertTrue(mesh.materials.count { it.baseColorTexture != null } >= 1)

        val ex = ModelExtras.parse(glb.extras)
        assertNotNull(ex.scale); assertFalse(ex.scale!!.isMetric); assertEquals("arbitrary", ex.scale!!.units)
        assertNotNull(ex.preset); assertNotNull(ex.settingsFingerprint)
        val crop = ex.suggestedCrop!!
        assertTrue(crop.basis.isNotBlank())
        val bounds = Aabb.of(mesh.positions)
        // the suggestion is a sub-region of the delivered mesh (which includes the surroundings on purpose)
        assertTrue(bounds.contains(crop.box.center))
        assertTrue(crop.box.halfExtents.x * 2 < bounds.size.x * 1.05f)
        val g = ex.ground!!
        assertEquals(1f, g.normal.length(), 1e-5f)
        // the support plane lies within the vertical extent of the mesh, below the crop centre
        assertTrue(g.point.y >= bounds.min.y - 0.05f && g.point.y < crop.box.center.y)
        assertTrue(g.signedDistance(crop.box.center) > 0f)

        val cams = CamerasJson.parse(TestMeshes.REAL_CAMERAS.readText())
        assertTrue(cams.cameras.isNotEmpty())
        assertTrue(cams.cameras.all { it.name.isNotBlank() && it.sparsePoints > 0 && it.fovYDeg in 5.0..150.0 })
        // cameras follow Reorient edits rigidly: distances between them are preserved, positions use currentFromBase
        val doc = EditDocument("sha").push(EditOp.Reorient(Quat.axisAngle(Vec3(0.2f, 1f, 0.1f), 0.9f), Vec3(0.3f, 0.1f, -0.2f)))
        val before = SceneBuilders.placeCameras(cams.cameras, null)
        val after = SceneBuilders.placeCameras(cams.cameras, doc)
        for (i in before.indices) {
            assertTrue(doc.toCurrent(before[i].position).distanceTo(after[i].position) < 1e-4f)
            // the camera still looks at the same model point
            val target = before[i].position + before[i].forward
            assertTrue(doc.toCurrent(target).distanceTo(after[i].position + after[i].forward) < 1e-4f)
        }
        assertEquals(before[0].position.distanceTo(before[1].position), after[0].position.distanceTo(after[1].position), 1e-4f)

        // registered-viewpoint coverage reproduces the companion's own binning
        val diagRoot = Json.parseToJsonElement(TestMeshes.REAL_DIAGNOSTICS.readText()).jsonObject
        val grid = ViewpointCoverage.of(before.map { it.position }, Vec3.ZERO)
        assertEquals(cams.cameras.size, grid.photos)
        val vc = diagRoot["viewpoint_coverage"]?.jsonObject
        if (vc != null) {
            val expected = Json.decodeFromString<List<List<Int>>>(vc["counts"].toString())
            var differing = 0
            for (band in 0 until CoverageGrid.BANDS) for (a in 0 until grid.azimuthBins)
                if (expected[band][a] != grid.counts[band][a]) differing++
            // rounding of positions in cameras.json may move a camera that sits exactly on a bin edge
            assertTrue("coverage differs from the companion's in $differing cells", differing <= 4)
            assertEquals(vc["azimuth_bins_covered"].toString().toInt(), grid.azimuthCovered)
        }
        assertTrue(ViewpointCoverage.summary(grid).contains("of 12 directions"))

        val d = Diagnostics.parse(TestMeshes.REAL_DIAGNOSTICS.readText())
        assertEquals(diagRoot["warnings"].toString().let { Json.parseToJsonElement(it) as kotlinx.serialization.json.JsonArray }.size, d.warnings.size)
        assertTrue(d.warnings.all { it.message.isNotBlank() })
        assertTrue(d.limitations.isNotEmpty())
        assertEquals(mesh.materials.count { it.baseColorTexture != null }, d.texturePages.size)
        assertTrue(d.texturePages.all { it.width > 0 && it.height > 0 })
        assertEquals(cams.cameras.size, d.registeredFrames)
    }

    @Test fun extrasAndDiagnosticsAreLenient() {
        assertEquals(ModelExtras(), ModelExtras.parse(null))
        assertEquals(ModelExtras(), ModelExtras.parse(Json.parseToJsonElement("""{"something": 1}""").jsonObject))
        val odd = ModelExtras.parse(Json.parseToJsonElement("""
            {"pocket3d": {"scale": "oops", "suggested_crop": {"center": [0,0,0], "half_extents": [1,0,1]},
                          "ground": null, "preset": 7, "frame": []}}""").jsonObject)
        assertNull(odd.scale); assertNull(odd.suggestedCrop); assertNull(odd.ground); assertNull(odd.preset)
        val metric = ModelExtras.parse(Json.parseToJsonElement("""
            {"pocket3d": {"scale": {"units": "meters", "source": "ar_tracking", "meters_per_unit": 1.0, "relative_uncertainty": 0.04},
                          "suggested_crop": {"center": [1,2,3], "half_extents": [1,2,3], "rotation": [0,0,0,2], "uncertain": true}}}""").jsonObject)
        assertTrue(metric.scale!!.isMetric)
        assertTrue(metric.suggestedCrop!!.uncertain)
        assertEquals(Quat.IDENTITY, metric.suggestedCrop!!.box.rotation)
        assertEquals(Diagnostics(), Diagnostics.parse("[]"))
        val d = Diagnostics.parse("""{"warnings": ["plain text", {"code": "c", "message": "m"}, {"code": "no message"}, 5]}""")
        assertEquals(listOf("plain text", "m"), d.warnings.map { it.message })
        assertEquals("No reliable matches with the other photos", CamerasJson.describeReason("no_reliable_matches"))
        assertEquals("Matched only a separate group of photos, not the main model", CamerasJson.describeReason("separate_group"))
        assertEquals("Too blurry", CamerasJson.describeReason("too_blurry"))
        assertTrue(CamerasJson.parse("""{"cameras": [], "unregistered": [{"id": "1"}], "new_key": 1}""").unregistered.size == 1)
    }

    @Test fun corruptModelFilesGiveClearErrorsNotCrashes() {
        val dir = File(System.getProperty("java.io.tmpdir"), "p3d-viewer-test-${System.nanoTime()}").apply { mkdirs() }
        try {
            fun load(bytes: ByteArray): ModelLoadException {
                val f = File(dir, "model.glb").apply { writeBytes(bytes) }
                return try { ModelLoader.readGlb(f); throw AssertionError("expected a load failure") } catch (e: ModelLoadException) { e }
            }
            assertEquals("The model file is damaged", load(ByteArray(0)).title)
            assertEquals("The model file is damaged", load("this is not a model".toByteArray()).title)
            assertEquals("The model file is damaged", load(ByteArray(4096) { (it * 7).toByte() }).title)
            val good = dev.pocket3d.core.mesh.GlbWriter.write(dev.pocket3d.core.mesh.GlbDocument(TestMeshes.grid(4)))
            assertEquals("The model file is damaged", load(good.copyOf(good.size / 2)).title)
            assertTrue(load(good.copyOf(good.size / 2)).detail.isNotBlank())
            val missing = try { ModelLoader.readGlb(File(dir, "nope.glb")); null } catch (e: ModelLoadException) { e }
            assertNotNull(missing)
            // and the intact file loads
            File(dir, "ok.glb").writeBytes(good)
            assertEquals(GlbReader.read(good).mesh.faceCount, ModelLoader.readGlb(File(dir, "ok.glb")).mesh.faceCount)
        } finally {
            dir.deleteRecursively()
        }
    }
}
