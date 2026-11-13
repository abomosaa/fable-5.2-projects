package dev.pocket3d.viewer

import dev.pocket3d.core.edit.EditDocument
import dev.pocket3d.core.edit.EditOp
import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.mesh.Aabb
import dev.pocket3d.core.mesh.GlbReader
import dev.pocket3d.core.mesh.Mesh
import dev.pocket3d.core.mesh.MeshOps
import dev.pocket3d.core.scale.ScaleCalibration
import dev.pocket3d.viewer.export.ExportBuilder
import dev.pocket3d.viewer.export.ExportCheck
import dev.pocket3d.viewer.export.ExportFormat
import dev.pocket3d.viewer.export.ExportVerifier
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.ZipInputStream

class ExportTest {
    private val originalExtras = Json.parseToJsonElement("""
        {"other_tool": {"keep": 1},
         "pocket3d": {"format": 1, "preset": "standard", "settings_fingerprint": "abc123",
                      "scale": {"units": "arbitrary", "source": "none", "meters_per_unit": null, "relative_uncertainty": null, "note": "n"},
                      "suggested_crop": {"center": [0,0,0], "half_extents": [1,1,1], "rotation": [0,0,0,1], "basis": "b", "uncertain": false},
                      "holes_preserved": true}}
    """).jsonObject

    /** A two-material textured grid with a hole that has been repaired, so every honesty marker is present. */
    private fun repairedMesh(): Pair<Mesh, EditDocument> {
        val open = TestMeshes.grid(8, twoMaterials = true) { i, j -> i in 1..2 && j in 5..6 }
        val holes = MeshOps.findHoles(open)
        assertEquals(2, holes.size)
        val small = holes.minByOrNull { it.perimeter }!!
        val op = EditOp.FillHoles(small.perimeter * 1.01f)
        val filled = MeshOps.fillHoles(open, null, small.perimeter * 1.01f)
        assertEquals(1, filled.filledHoleCount)
        return filled.mesh to EditDocument("sha", ops = listOf(op))
    }

    private fun assertBounds(expected: Aabb, actual: Aabb, tol: Float) {
        for (i in 0..2) {
            assertEquals(expected.min[i], actual.min[i], tol)
            assertEquals(expected.max[i], actual.max[i], tol)
        }
    }

    @Test fun calibratedGlbIsBakedToMetres() {
        val (mesh, doc) = repairedMesh()
        val scale = ScaleCalibration(0.25, 0.03, ScaleCalibration.Source.USER_REFERENCE)
        val art = ExportBuilder.build(ExportFormat.GLB, mesh, originalExtras, doc, scale, "My model: v2!", 1_700_000_000)
        assertEquals("My_model_v2.glb", art.fileName)
        assertTrue(art.metric)

        val back = GlbReader.read(art.bytes)
        // geometry: same counts, bounds multiplied by metres-per-unit
        assertEquals(mesh.faceCount, back.mesh.faceCount)
        assertEquals(art.expected.vertexCount, back.mesh.vertexCount)
        val src = Aabb.of(mesh.positions)
        assertBounds(Aabb(src.min * 0.25f, src.max * 0.25f), Aabb.of(back.mesh.positions), 1e-6f)
        assertEquals(MeshOps.surfaceArea(mesh) * 0.0625f, MeshOps.surfaceArea(back.mesh), 1e-4f)

        // honesty markers survive: evidence values and the repaired material
        assertNotNull(back.mesh.confidence)
        val repairedBefore = (0 until mesh.faceCount).count { mesh.materials[mesh.materialOfFace(it)].repaired }
        val repairedAfter = (0 until back.mesh.faceCount).count { back.mesh.materials[back.mesh.materialOfFace(it)].repaired }
        assertTrue(repairedBefore > 0)
        assertEquals(repairedBefore, repairedAfter)
        assertTrue(back.mesh.materials.any { it.repaired && it.name == MeshOps.REPAIRED_MATERIAL_NAME })
        // textures are carried byte for byte
        val texturesBefore = mesh.materials.mapNotNull { it.baseColorTexture }.map { it.bytes.toList() }.toSet()
        val texturesAfter = back.mesh.materials.mapNotNull { it.baseColorTexture }.map { it.bytes.toList() }.toSet()
        assertEquals(texturesBefore, texturesAfter)

        // extras: scale statement replaced, provenance kept, edit record added
        val p3 = back.extras!!["pocket3d"]!!.jsonObject
        val s = p3["scale"]!!.jsonObject
        assertEquals("meters", s["units"]!!.jsonPrimitive.content)
        assertEquals("user_reference", s["source"]!!.jsonPrimitive.content)
        assertEquals(1.0, s["meters_per_unit"]!!.jsonPrimitive.double, 0.0)
        assertEquals(0.03, s["relative_uncertainty"]!!.jsonPrimitive.double, 1e-12)
        assertTrue(s["note"]!!.jsonPrimitive.content.isNotBlank())
        assertEquals("standard", p3["preset"]!!.jsonPrimitive.content)
        assertEquals("abc123", p3["settings_fingerprint"]!!.jsonPrimitive.content)
        assertTrue(p3["edited"]!!.jsonPrimitive.boolean)
        assertEquals(listOf("Repair holes (synthetic)"), p3["edit_ops"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(1_700_000_000L, p3["exported_unix"]!!.jsonPrimitive.long)
        assertEquals(0.25, p3["export_transform"]!!.jsonObject["units_per_source_unit"]!!.jsonPrimitive.double, 0.0)
        assertEquals(16, p3["export_transform"]!!.jsonObject["current_from_source"]!!.jsonArray.size)
        assertNotNull(p3["suggested_crop"])
        assertEquals(1, back.extras!!["other_tool"]!!.jsonObject["keep"]!!.jsonPrimitive.long.toInt())

        assertTrue(ExportVerifier.verify(art, art.bytes) is ExportCheck.Ok)
    }

    @Test fun arEstimatedScaleIsLabelledAsSuch() {
        val (mesh, doc) = repairedMesh()
        val art = ExportBuilder.build(ExportFormat.GLB, mesh, originalExtras, doc,
                                      ScaleCalibration(2.0, 0.05, ScaleCalibration.Source.AR_TRACKING), "m", 1)
        val s = GlbReader.read(art.bytes).extras!!["pocket3d"]!!.jsonObject["scale"]!!.jsonObject
        assertEquals("meters", s["units"]!!.jsonPrimitive.content)
        assertEquals("ar_tracking", s["source"]!!.jsonPrimitive.content)
        assertTrue(art.unitsStatement.contains("AR-estimated"))
    }

    @Test fun uncalibratedGlbStaysInArbitraryUnitsAndSaysSo() {
        val (mesh, _) = repairedMesh()
        val art = ExportBuilder.build(ExportFormat.GLB, mesh, originalExtras, EditDocument("sha"), null, "", 5)
        assertEquals("model.glb", art.fileName)
        assertFalse(art.metric)
        assertTrue(art.unitsStatement.contains("No real-world scale"))
        val back = GlbReader.read(art.bytes)
        assertBounds(Aabb.of(mesh.positions), Aabb.of(back.mesh.positions), 0f)
        val p3 = back.extras!!["pocket3d"]!!.jsonObject
        val s = p3["scale"]!!.jsonObject
        assertEquals("arbitrary", s["units"]!!.jsonPrimitive.content)
        assertEquals("none", s["source"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, s["meters_per_unit"])
        assertFalse(p3["edited"]!!.jsonPrimitive.boolean)
        assertTrue(p3["edit_ops"]!!.jsonArray.isEmpty())
        assertTrue(ExportVerifier.verify(art, art.bytes) is ExportCheck.Ok)
    }

    @Test fun missingOriginalExtrasStillProduceAScaleStatement() {
        val art = ExportBuilder.build(ExportFormat.GLB, TestMeshes.sphere(), null, EditDocument("sha"), null, "x", 5)
        val p3 = GlbReader.read(art.bytes).extras!!["pocket3d"]!!.jsonObject
        assertEquals("arbitrary", p3["scale"]!!.jsonObject["units"]!!.jsonPrimitive.content)
    }

    @Test fun selfCheckCatchesCorruptedWrites() {
        val (mesh, doc) = repairedMesh()
        val art = ExportBuilder.build(ExportFormat.GLB, mesh, originalExtras, doc, null, "m", 1)
        val good = art.bytes

        // truncated (disk full, interrupted stream)
        val truncated = ExportVerifier.verify(art, good.copyOf(good.size - 100))
        assertTrue(truncated is ExportCheck.Failed)
        assertTrue((truncated as ExportCheck.Failed).reason.contains("incomplete"))
        assertTrue(ExportVerifier.verify(art, ByteArray(0)) is ExportCheck.Failed)

        // same length, damaged header
        val badMagic = good.copyOf().also { it[0] = 'X'.code.toByte() }
        assertTrue(ExportVerifier.verify(art, badMagic) is ExportCheck.Failed)

        // same length, a vertex position overwritten inside the binary chunk
        val jsonLen = ByteBuffer.wrap(good, 12, 4).order(ByteOrder.LITTLE_ENDIAN).int
        val binStart = 20 + jsonLen + 8
        val moved = good.copyOf()
        ByteBuffer.wrap(moved, binStart, 4).order(ByteOrder.LITTLE_ENDIAN).putFloat(12345f)
        val r = ExportVerifier.verify(art, moved)
        assertTrue("a moved vertex must fail the check", r is ExportCheck.Failed)

        // same length, one flipped bit in texture/attribute data far from the header
        val flipped = good.copyOf().also { it[it.size - 9] = (it[it.size - 9].toInt() xor 0x10).toByte() }
        assertTrue(ExportVerifier.verify(art, flipped) is ExportCheck.Failed)

        // zeros of the right length
        assertTrue(ExportVerifier.verify(art, ByteArray(good.size)) is ExportCheck.Failed)
        // and the untouched bytes pass
        assertTrue(ExportVerifier.verify(art, good.copyOf()) is ExportCheck.Ok)
    }

    @Test fun objZipContainsEverythingNeeded() {
        val (mesh, doc) = repairedMesh()
        val scale = ScaleCalibration(0.5, 0.02, ScaleCalibration.Source.USER_REFERENCE)
        val art = ExportBuilder.build(ExportFormat.OBJ_ZIP, mesh, originalExtras, doc, scale, "vase", 9)
        assertEquals("vase.zip", art.fileName)
        assertEquals("application/zip", art.format.mimeType)
        val files = LinkedHashMap<String, ByteArray>()
        ZipInputStream(art.bytes.inputStream()).use { z ->
            while (true) { val e = z.nextEntry ?: break; files[e.name] = z.readBytes() }
        }
        assertEquals(art.expected.zipEntries, files.keys.toList())
        assertTrue("vase.obj" in files); assertTrue("vase.mtl" in files)
        assertTrue("README.txt" in files); assertTrue("vase_pocket3d.json" in files)
        val textures = files.keys.filter { it.endsWith(".png") }
        assertEquals(2, textures.size)
        val obj = String(files["vase.obj"]!!)
        val mtl = String(files["vase.mtl"]!!)
        assertTrue(obj.contains("mtllib vase.mtl"))
        assertEquals(mesh.vertexCount, obj.lineSequence().count { it.startsWith("v ") })
        assertEquals(mesh.faceCount, obj.lineSequence().count { it.startsWith("f ") })
        for (t in textures) assertTrue("mtl must reference $t", mtl.contains(t))
        assertTrue("repaired faces stay identifiable", mtl.contains("pocket3d_repaired"))
        // scale baked: the widest OBJ x coordinate is half the mesh's
        val maxX = obj.lineSequence().filter { it.startsWith("v ") }.maxOf { it.split(' ')[1].toFloat() }
        assertEquals(Aabb.of(mesh.positions).max.x * 0.5f, maxX, 1e-6f)
        assertTrue(String(files["README.txt"]!!).contains("metres"))
        val side = Json.parseToJsonElement(String(files["vase_pocket3d.json"]!!)).jsonObject
        assertEquals("meters", side["pocket3d"]!!.jsonObject["scale"]!!.jsonObject["units"]!!.jsonPrimitive.content)

        assertTrue(ExportVerifier.verify(art, art.bytes) is ExportCheck.Ok)
        val broken = art.bytes.copyOf().also { it[it.size / 2] = (it[it.size / 2].toInt() xor 0x55).toByte() }
        assertTrue(ExportVerifier.verify(art, broken) is ExportCheck.Failed)
        assertTrue(ExportVerifier.verify(art, art.bytes.copyOf(art.bytes.size / 2)) is ExportCheck.Failed)

        // without a scale the README warns
        val plain = ExportBuilder.build(ExportFormat.OBJ_ZIP, mesh, originalExtras, doc, null, "vase", 9)
        ZipInputStream(plain.bytes.inputStream()).use { z ->
            while (true) { val e = z.nextEntry ?: break; if (e.name == "README.txt") assertTrue(String(z.readBytes()).contains("ARBITRARY")) }
        }
    }

    @Test fun plyKeepsEvidenceAndRepairedFlags() {
        val (mesh, doc) = repairedMesh()
        val art = ExportBuilder.build(ExportFormat.PLY, mesh, originalExtras, doc, null, "m", 1)
        assertEquals("m.ply", art.fileName)
        val header = String(art.bytes, 0, minOf(art.bytes.size, 600))
        assertTrue(header.startsWith("ply"))
        assertTrue(header.contains("element vertex ${mesh.vertexCount}"))
        assertTrue(header.contains("element face ${mesh.faceCount}"))
        assertTrue(header.contains("confidence"))
        assertTrue(header.contains("repaired"))
        assertTrue(ExportVerifier.verify(art, art.bytes) is ExportCheck.Ok)
        assertTrue(ExportVerifier.verify(art, art.bytes.copyOf().also { it[it.size - 1] = (it[it.size - 1] + 1).toByte() }) is ExportCheck.Failed)
    }

    @Test fun exportMetadataDoesNotRepeatStatementsThatEditsMadeUntrue() {
        val (mesh, repairedDoc) = repairedMesh()
        // (a) a repair was applied: the file must not claim that holes were preserved
        val p3 = ExportBuilder.buildExtras(originalExtras, repairedDoc, null, 1)["pocket3d"]!!.jsonObject
        assertEquals("false", p3["holes_preserved"].toString())
        assertTrue(p3["repaired_note"].toString().contains("synthetic"))
        assertTrue(p3.containsKey("suggested_crop"))               // nothing was cropped: the suggestion still applies
        // (b) cropped: the suggestion for the uncropped model is dropped, holes are still preserved
        val croppedDoc = EditDocument("sha", ops = listOf(EditOp.ClipPlane(Vec3(0f, 0f, 0f), Vec3.Y)))
        val c3 = ExportBuilder.buildExtras(originalExtras, croppedDoc, null, 1)["pocket3d"]!!.jsonObject
        assertFalse(c3.containsKey("suggested_crop"))
        assertEquals("true", c3["holes_preserved"].toString())
        // (c) untouched: everything is carried over unchanged
        val u3 = ExportBuilder.buildExtras(originalExtras, EditDocument("sha"), null, 1)["pocket3d"]!!.jsonObject
        assertEquals("true", u3["holes_preserved"].toString()); assertTrue(u3.containsKey("suggested_crop"))
        // PLY states its units in the header, calibrated or not, and mentions repaired faces
        val cal = ScaleCalibration(0.25, 0.02, ScaleCalibration.Source.USER_REFERENCE)
        val plyCal = String(ExportBuilder.build(ExportFormat.PLY, mesh, originalExtras, repairedDoc, cal, "m", 1).bytes.copyOf(600), Charsets.ISO_8859_1)
        assertTrue(plyCal, plyCal.contains("comment units: meters") && plyCal.contains("0.020") && plyCal.contains("repaired"))
        val plyRaw = String(ExportBuilder.build(ExportFormat.PLY, mesh, originalExtras, EditDocument("sha"), null, "m", 1).bytes.copyOf(600), Charsets.ISO_8859_1)
        assertTrue(plyRaw, plyRaw.contains("comment units: arbitrary"))
        assertTrue(plyRaw.indexOf("comment units") < plyRaw.indexOf("element vertex"))
    }

    @Test fun emptyMeshIsRefused() {
        val empty = MeshOps.removeFaces(TestMeshes.cube(), BooleanArray(12) { true })
        try {
            ExportBuilder.build(ExportFormat.GLB, empty, null, EditDocument("sha"), null, "m", 1)
            org.junit.Assert.fail("expected a refusal")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("nothing to export"))
        }
    }

    @Test fun safeBaseNames() {
        assertEquals("model", ExportBuilder.safeBaseName("  "))
        assertEquals("model", ExportBuilder.safeBaseName("../.."))
        assertEquals("a_b", ExportBuilder.safeBaseName("a/b"))
        assertEquals("Vase_3", ExportBuilder.safeBaseName(" Vase #3 "))
        assertTrue(ExportBuilder.safeBaseName("x".repeat(500)).length <= 48)
    }

    @Test fun realModelExportsAndVerifies() {
        assumeTrue(TestMeshes.REAL_GLB.isFile)
        val src = GlbReader.read(TestMeshes.REAL_GLB)
        val mesh = src.mesh
        val (expectedVertices, expectedFaces) = ExportBuilder.expectedGlbCounts(mesh)
        assertEquals(mesh.faceCount, expectedFaces)
        val scale = ScaleCalibration(0.31, 0.012, ScaleCalibration.Source.USER_REFERENCE)
        val art = ExportBuilder.build(ExportFormat.GLB, mesh, src.extras, EditDocument("sha"), scale, "Buddha", 42)
        val check = ExportVerifier.verify(art, art.bytes)
        assertTrue("self-check failed: $check", check is ExportCheck.Ok)
        val back = GlbReader.read(art.bytes)
        assertEquals(expectedVertices, back.mesh.vertexCount)
        assertEquals(mesh.faceCount, back.mesh.faceCount)
        val b = Aabb.of(mesh.positions)
        assertBounds(Aabb(b.min * 0.31f, b.max * 0.31f), Aabb.of(back.mesh.positions), 1e-6f)
        // both 4096² JPEG pages are embedded untouched
        val pagesBefore = mesh.materials.mapNotNull { it.baseColorTexture }
        val pagesAfter = back.mesh.materials.mapNotNull { it.baseColorTexture }
        assertEquals(pagesBefore.size, pagesAfter.size)
        for (i in pagesBefore.indices) assertTrue(pagesBefore[i].bytes.contentEquals(pagesAfter[i].bytes))
        // the companion's provenance is carried over next to the new scale statement
        val p3 = back.extras!!["pocket3d"]!!.jsonObject
        assertEquals(src.extras!!["pocket3d"]!!.jsonObject["settings_fingerprint"], p3["settings_fingerprint"])
        assertEquals("meters", p3["scale"]!!.jsonObject["units"]!!.jsonPrimitive.content)
        assertTrue(p3["job_id"] is kotlinx.serialization.json.JsonPrimitive)
        assertFalse((p3 as JsonObject).isEmpty())
    }
}
