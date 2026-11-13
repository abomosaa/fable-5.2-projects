package dev.pocket3d.core.mesh

import dev.pocket3d.core.math.Vec3
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Base64
import kotlin.math.sqrt

class GlbTest {
    private val outDir = File("build/glb-validation").apply { mkdirs() }
    private fun resource(name: String): ByteArray =
        javaClass.getResourceAsStream("/gltf-sample-assets/$name")?.use { it.readBytes() } ?: error("missing test resource $name")

    private fun texturedSphere(): Mesh = Fixtures.uvSphere(1f, 24, 12, Fixtures.texturedMaterial("atlas"))

    /** Sphere with a repaired cap, a second plain coloured material and a second textured one sharing the atlas image. */
    private fun multiMaterialMesh(): Mesh {
        val open = Fixtures.sphereWithoutCaps(1f, 32, 16, 0.72f, both = false)
        val filled = MeshOps.fillHoles(open).mesh
        val atlas = Fixtures.texturedMaterial("atlas")
        val materials = listOf(
            atlas,
            filled.materials[1],
            Material("painted", null, floatArrayOf(0.8f, 0.25f, 0.1f, 1f)),
            Material("atlas-again", atlas.baseColorTexture),
            Material("never-used", TextureImage("image/png", Fixtures.png(8, 9), "unused.png")),
        )
        val fm = IntArray(filled.faceCount) { f ->
            val c = Fixtures.centroid(filled, f)
            if (filled.materialOfFace(f) == 1) 1 else if (c.y < -0.5f) 2 else if (c.x < 0f) 3 else 0
        }
        return filled.copy(faceMaterial = fm, materials = materials)
    }

    // ------------------------------------------------------------------ round trips

    @Test fun roundTripSingleMaterialIsExact() {
        val mesh = texturedSphere()
        val extras = buildJsonObject {
            put("pocket3d_scale", buildJsonObject { put("metersPerUnit", 0.0123); put("source", "aruco") })
            put("captureId", "abc-123")
            put("frames", 42)
        }
        val bytes = GlbWriter.write(GlbDocument(mesh, extras, "Pocket 3D Scanner test 1.0"))
        File(outDir, "sphere-textured.glb").writeBytes(bytes)
        val doc = GlbReader.read(bytes)
        val m = doc.mesh
        assertEquals(emptyList<String>(), doc.warnings)
        assertEquals(extras, doc.extras)
        assertEquals("Pocket 3D Scanner test 1.0", doc.generator)
        // geometry bit-exact, same vertex and face order
        assertArrayEquals(mesh.positions, m.positions, 0f)
        assertArrayEquals(mesh.indices, m.indices)
        assertArrayEquals(mesh.uvs, m.uvs, 0f)
        assertArrayEquals(mesh.confidence, m.confidence, 0f)
        assertArrayEquals(mesh.normals, m.normals, 0f)
        assertNull(m.faceMaterial)
        // material and texture
        assertEquals(1, m.materials.size)
        val mat = m.materials[0]
        assertEquals("atlas", mat.name); assertFalse(mat.repaired)
        assertArrayEquals(floatArrayOf(1f, 1f, 1f, 1f), mat.baseColorFactor, 0f)
        val src = mesh.materials[0].baseColorTexture!!
        assertArrayEquals("texture bytes must be byte-identical", src.bytes, mat.baseColorTexture!!.bytes)
        assertEquals("image/png", mat.baseColorTexture!!.mimeType)
        assertEquals("atlas.png", mat.baseColorTexture!!.name)
        // writing what was read gives the identical file
        assertArrayEquals(bytes, GlbWriter.write(doc))
        // stream and file entry points agree
        val out = ByteArrayOutputStream(); GlbWriter.write(GlbDocument(mesh, extras, "Pocket 3D Scanner test 1.0"), out)
        assertArrayEquals(bytes, out.toByteArray())
        assertArrayEquals(mesh.positions, GlbReader.read(ByteArrayInputStream(bytes)).mesh.positions, 0f)
        val f = File(outDir, "sphere-textured.glb")
        assertArrayEquals(mesh.indices, GlbReader.read(f).mesh.indices)
        assertEquals(MeshOps.signedVolume(mesh), MeshOps.signedVolume(m), 0f)
    }

    @Test fun roundTripMultiMaterialKeepsFlagsAreasAndSharedImage() {
        val mesh = multiMaterialMesh()
        val bytes = GlbWriter.write(GlbDocument(mesh))
        File(outDir, "sphere-repaired-multimaterial.glb").writeBytes(bytes)
        val doc = GlbReader.read(bytes)
        val m = doc.mesh
        assertEquals(GlbWriter.DEFAULT_GENERATOR, doc.generator); assertNull(doc.extras)
        assertEquals(mesh.faceCount, m.faceCount)
        // unused material dropped, order kept
        assertEquals(listOf("atlas", MeshOps.REPAIRED_MATERIAL_NAME, "painted", "atlas-again"), m.materials.map { it.name })
        assertEquals(listOf(false, true, false, false), m.materials.map { it.repaired })
        assertArrayEquals(floatArrayOf(0.8f, 0.25f, 0.1f, 1f), m.materials[2].baseColorFactor, 0f)
        assertArrayEquals(floatArrayOf(0.5f, 0.5f, 0.5f, 1f), m.materials[1].baseColorFactor, 0f)
        assertNull(m.materials[1].baseColorTexture); assertNull(m.materials[2].baseColorTexture)
        assertSame("shared image must stay one image", m.materials[0].baseColorTexture, m.materials[3].baseColorTexture)
        assertArrayEquals(mesh.materials[0].baseColorTexture!!.bytes, m.materials[0].baseColorTexture!!.bytes)
        // faces are grouped by material; per material the surface is the same set of triangles
        for (k in 0..3) {
            val before = (0 until mesh.faceCount).filter { mesh.materialOfFace(it) == k }
            val after = (0 until m.faceCount).filter { m.materialOfFace(it) == k }
            assertEquals(before.size, after.size)
            for (i in before.indices) for (c in 0 until 3) {
                val a = mesh.indices[3 * before[i] + c]; val b = m.indices[3 * after[i] + c]
                assertEquals(mesh.position(a), m.position(b))
                assertEquals(mesh.uvs!![2 * a], m.uvs!![2 * b], 0f); assertEquals(mesh.uvs!![2 * a + 1], m.uvs!![2 * b + 1], 0f)
                assertEquals(mesh.confidence!![a], m.confidence!![b], 0f)
            }
        }
        assertEquals((0 until m.faceCount).map { m.materialOfFace(it) }, (0 until m.faceCount).map { m.materialOfFace(it) }.sorted())
        // still closed with the same volume: material borders weld back together
        assertEquals(0, MeshTopology.build(m).boundaryEdgeCount)
        assertEquals(MeshOps.signedVolume(mesh), MeshOps.signedVolume(m), 1e-5f)
        assertEquals(MeshOps.stats(mesh).repairedAreaFraction, MeshOps.stats(m).repairedAreaFraction, 1e-6f)
        // a second generation is stable
        assertArrayEquals(bytes, GlbWriter.write(GlbDocument(m)))
    }

    @Test fun writerProducesTheDocumentedGltfStructure() {
        val bytes = GlbWriter.write(GlbDocument(multiMaterialMesh(), buildJsonObject { put("k", 1) }, "gen"))
        // container
        val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals(0x46546C67, bb.getInt(0)); assertEquals(2, bb.getInt(4)); assertEquals(bytes.size, bb.getInt(8))
        assertEquals(0, bytes.size % 4); assertEquals(0, bb.getInt(12) % 4)
        val json = TestGlb.json(bytes)
        val asset = json["asset"]!!.jsonObject
        assertEquals("2.0", asset["version"]!!.jsonPrimitive.content); assertEquals("gen", asset["generator"]!!.jsonPrimitive.content)
        assertEquals(1, asset["extras"]!!.jsonObject["k"]!!.jsonPrimitive.int)
        assertEquals(1, json["meshes"]!!.jsonArray.size); assertEquals(1, json["nodes"]!!.jsonArray.size)
        val prims = json["meshes"]!!.jsonArray[0].jsonObject["primitives"]!!.jsonArray
        assertEquals(4, prims.size) // one per used material
        val accessors = json["accessors"]!!.jsonArray; val views = json["bufferViews"]!!.jsonArray
        val binStart = TestGlb.binOffset(bytes)
        for ((pi, p) in prims.withIndex()) {
            val prim = p.jsonObject
            assertEquals(pi, prim["material"]!!.jsonPrimitive.int); assertEquals(4, prim["mode"]!!.jsonPrimitive.int)
            val attrs = prim["attributes"]!!.jsonObject
            assertEquals(setOf("POSITION", "NORMAL", "TEXCOORD_0", "_CONFIDENCE"), attrs.keys)
            val pos = accessors[attrs["POSITION"]!!.jsonPrimitive.int].jsonObject
            assertEquals("VEC3", pos["type"]!!.jsonPrimitive.content); assertEquals(5126, pos["componentType"]!!.jsonPrimitive.int)
            assertEquals("SCALAR", accessors[attrs["_CONFIDENCE"]!!.jsonPrimitive.int].jsonObject["type"]!!.jsonPrimitive.content)
            assertEquals(5126, accessors[attrs["_CONFIDENCE"]!!.jsonPrimitive.int].jsonObject["componentType"]!!.jsonPrimitive.int)
            // POSITION min/max match the stored floats exactly
            val view = views[pos["bufferView"]!!.jsonPrimitive.int].jsonObject
            assertEquals(34962, view["target"]!!.jsonPrimitive.int)
            val count = pos["count"]!!.jsonPrimitive.int
            val off = binStart + view["byteOffset"]!!.jsonPrimitive.int
            for (c in 0 until 3) {
                var mn = Float.POSITIVE_INFINITY; var mx = Float.NEGATIVE_INFINITY
                for (i in 0 until count) { val v = bb.getFloat(off + 12 * i + 4 * c); mn = minOf(mn, v); mx = maxOf(mx, v) }
                assertEquals(mn, pos["min"]!!.jsonArray[c].jsonPrimitive.double.toFloat(), 0f)
                assertEquals(mx, pos["max"]!!.jsonArray[c].jsonPrimitive.double.toFloat(), 0f)
                assertEquals(mn.toDouble(), pos["min"]!!.jsonArray[c].jsonPrimitive.double, 0.0)
            }
            // unit normals
            val nv = views[accessors[attrs["NORMAL"]!!.jsonPrimitive.int].jsonObject["bufferView"]!!.jsonPrimitive.int].jsonObject
            val noff = binStart + nv["byteOffset"]!!.jsonPrimitive.int
            for (i in 0 until count) {
                val x = bb.getFloat(noff + 12 * i); val y = bb.getFloat(noff + 12 * i + 4); val z = bb.getFloat(noff + 12 * i + 8)
                assertEquals(1f, sqrt(x * x + y * y + z * z), 1e-5f)
            }
            // u32 indices in an ELEMENT_ARRAY_BUFFER view
            val idx = accessors[prim["indices"]!!.jsonPrimitive.int].jsonObject
            assertEquals(5125, idx["componentType"]!!.jsonPrimitive.int)
            assertEquals(34963, views[idx["bufferView"]!!.jsonPrimitive.int].jsonObject["target"]!!.jsonPrimitive.int)
            assertEquals(0, idx["count"]!!.jsonPrimitive.int % 3)
        }
        for (v in views) assertEquals("bufferViews must be 4-byte aligned", 0, v.jsonObject["byteOffset"]!!.jsonPrimitive.int % 4)
        // materials
        val mats = json["materials"]!!.jsonArray.map { it.jsonObject }
        assertEquals(4, mats.size)
        for (m in mats) {
            assertTrue(m["doubleSided"]!!.jsonPrimitive.content == "true")
            val pbr = m["pbrMetallicRoughness"]!!.jsonObject
            assertEquals(0.0, pbr["metallicFactor"]!!.jsonPrimitive.double, 0.0); assertEquals(1.0, pbr["roughnessFactor"]!!.jsonPrimitive.double, 0.0)
        }
        assertEquals("Repaired (unobserved)", mats[1]["name"]!!.jsonPrimitive.content)
        assertEquals("true", mats[1]["extras"]!!.jsonObject["pocket3d_repaired"]!!.jsonPrimitive.content)
        assertNull(mats[0]["extras"]); assertNull(mats[1]["pbrMetallicRoughness"]!!.jsonObject["baseColorTexture"])
        assertNotNull(mats[0]["pbrMetallicRoughness"]!!.jsonObject["baseColorTexture"])
        // one image, one texture, one sampler; image stored verbatim
        assertEquals(1, json["images"]!!.jsonArray.size); assertEquals(1, json["textures"]!!.jsonArray.size)
        val sampler = json["samplers"]!!.jsonArray.single().jsonObject
        assertEquals(listOf(9729, 9987, 33071, 33071), listOf("magFilter", "minFilter", "wrapS", "wrapT").map { sampler[it]!!.jsonPrimitive.int })
        val image = json["images"]!!.jsonArray[0].jsonObject
        assertEquals("image/png", image["mimeType"]!!.jsonPrimitive.content)
        val iv = views[image["bufferView"]!!.jsonPrimitive.int].jsonObject
        assertNull(iv["target"])
        val png = Fixtures.png(8, 1)
        assertEquals(png.size, iv["byteLength"]!!.jsonPrimitive.int)
        assertArrayEquals(png, bytes.copyOfRange(binStart + iv["byteOffset"]!!.jsonPrimitive.int, binStart + iv["byteOffset"]!!.jsonPrimitive.int + png.size))
    }

    @Test fun meshWithoutUvsNormalsOrMaterials() {
        val src = Fixtures.uvSphere(1f, 16, 8, Fixtures.texturedMaterial())
        val bare = Mesh(src.positions, null, null, null, src.indices, null, emptyList())
        val bytes = GlbWriter.write(GlbDocument(bare))
        File(outDir, "sphere-bare.glb").writeBytes(bytes)
        val prim = TestGlb.json(bytes)["meshes"]!!.jsonArray[0].jsonObject["primitives"]!!.jsonArray.single().jsonObject
        assertEquals(setOf("POSITION", "NORMAL"), prim["attributes"]!!.jsonObject.keys)
        val m = GlbReader.read(bytes).mesh
        assertNull(m.uvs); assertNull(m.confidence)
        assertEquals("default", m.materials.single().name)
        for (v in 0 until m.vertexCount) assertTrue(Vec3.of(m.normals!!, 3 * v).dot(m.position(v)) > 0.98f) // computed, outward
        // textured material but no UVs: the texture reference is dropped rather than writing an invalid file
        val noUv = Mesh(src.positions, src.normals, null, null, src.indices, null, src.materials)
        val j = TestGlb.json(GlbWriter.write(GlbDocument(noUv)))
        assertNull(j["images"]); assertNull(j["textures"])
        assertNull(j["materials"]!!.jsonArray[0].jsonObject["pbrMetallicRoughness"]!!.jsonObject["baseColorTexture"])
        // partly textured mesh with UVs: the untextured primitive still carries TEXCOORD_0
        val mixed = Fixtures.merge(Fixtures.planeGrid(2, 2, 1f, Fixtures.texturedMaterial()), Fixtures.translate(Fixtures.planeGrid(2, 2, 1f, Material("plain")), Vec3(2f, 0f, 0f)))
        val mixedBytes = GlbWriter.write(GlbDocument(mixed))
        File(outDir, "planes-mixed.glb").writeBytes(mixedBytes)
        for (p in TestGlb.json(mixedBytes)["meshes"]!!.jsonArray[0].jsonObject["primitives"]!!.jsonArray) {
            assertTrue(p.jsonObject["attributes"]!!.jsonObject.containsKey("TEXCOORD_0"))
        }
    }

    @Test fun writerSanitisesBadInput() {
        // zero / non-unit / NaN normals, NaN uv, a NaN position, unreferenced vertex, out-of-range material index
        val pos = floatArrayOf(0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f, 0f, Float.NaN, 0f, 0f, 9f, 9f, 9f, 1f, 1f, 0f)
        val nrm = floatArrayOf(0f, 0f, 0f, 0f, 0f, 5f, Float.NaN, 0f, 0f, 0f, 0f, 1f, 0f, 0f, 1f, 0f, 0f, 1f)
        val uv = floatArrayOf(0f, 0f, Float.NaN, 0f, 0f, 1f, 0f, 0f, 0f, 0f, 1f, 1f)
        val conf = floatArrayOf(1f, Float.NaN, 0.5f, 1f, 1f, 0.25f)
        val mesh = Mesh(pos, nrm, uv, conf, intArrayOf(0, 1, 2, 0, 1, 3, 1, 5, 2), intArrayOf(0, 0, 7), listOf(Material("m", null, floatArrayOf(2f, -1f, Float.NaN, 0.5f))))
        val bytes = GlbWriter.write(GlbDocument(mesh))
        File(outDir, "sanitised.glb").writeBytes(bytes)
        val m = GlbReader.read(bytes).mesh
        assertEquals(2, m.faceCount)       // the face using the NaN vertex is dropped
        assertEquals(6, m.vertexCount)     // 3 for material m + 3 for the default material; vertex 4 unreferenced
        assertEquals(listOf("m", "default"), m.materials.map { it.name })
        assertArrayEquals(floatArrayOf(1f, 0f, 1f, 0.5f), m.materials[0].baseColorFactor, 0f)
        for (v in 0 until m.vertexCount) {
            val n = Vec3.of(m.normals!!, 3 * v)
            assertEquals(1f, n.length(), 1e-5f)
            assertEquals(1f, n.z, 1e-5f) // all faces lie in the XY plane, counter-clockwise about +Z
            assertTrue(m.uvs!![2 * v].isFinite() && m.confidence!![v].isFinite())
        }
        assertThrows(IllegalArgumentException::class.java) {
            GlbWriter.write(GlbDocument(Mesh(floatArrayOf(0f, 0f, 0f), null, null, null, intArrayOf(0, 1, 2), null, emptyList())))
        }
    }

    @Test fun emptyMeshRoundTrips() {
        val empty = Mesh(FloatArray(0), null, null, null, IntArray(0), null, emptyList())
        val bytes = GlbWriter.write(GlbDocument(empty, buildJsonObject { put("note", "all faces deleted") }))
        File(outDir, "empty.glb").writeBytes(bytes)
        val doc = GlbReader.read(bytes)
        assertEquals(0, doc.mesh.faceCount); assertEquals(0, doc.mesh.vertexCount)
        assertEquals("all faces deleted", doc.extras!!["note"]!!.jsonPrimitive.content)
    }

    // ------------------------------------------------------------------ files from other tools

    @Test fun readsKhronosBoxTextured() {
        val bytes = resource("BoxTextured.glb")
        val doc = GlbReader.read(bytes)
        val m = doc.mesh
        assertEquals("COLLADA2GLTF", doc.generator); assertNull(doc.extras)
        assertEquals(emptyList<String>(), doc.warnings)
        assertEquals(24, m.vertexCount); assertEquals(12, m.faceCount)
        assertEquals(8, MeshTopology.build(m).weldedCount)
        // unit cube, closed, outward oriented
        val box = Aabb.of(m.positions)
        assertTrue(box.min.distanceTo(Vec3(-0.5f, -0.5f, -0.5f)) < 1e-6f && box.max.distanceTo(Vec3(0.5f, 0.5f, 0.5f)) < 1e-6f)
        assertEquals(1f, MeshOps.signedVolume(m), 1e-6f)
        assertEquals(6f, MeshOps.surfaceArea(m), 1e-5f)
        assertEquals(0, MeshTopology.build(m).boundaryEdgeCount)
        // the node matrix (x, y, z) -> (x, z, -y) was baked: compare with the raw accessor data read here by hand
        // (POSITION: bufferView offset 0 + accessor offset 288, stride 12; NORMAL: offset 0)
        val bin = TestGlb.binOffset(bytes)
        val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        for (v in 0 until 24) {
            val raw = Vec3(bb.getFloat(bin + 288 + 12 * v), bb.getFloat(bin + 288 + 12 * v + 4), bb.getFloat(bin + 288 + 12 * v + 8))
            assertEquals(Vec3(raw.x, raw.z, -raw.y), m.position(v))
            val rawN = Vec3(bb.getFloat(bin + 12 * v), bb.getFloat(bin + 12 * v + 4), bb.getFloat(bin + 12 * v + 8))
            assertTrue(Vec3(rawN.x, rawN.z, -rawN.y).distanceTo(Vec3.of(m.normals!!, 3 * v)) < 1e-6f)
            // flat-shaded cube: the vertex normal is the axis the vertex's face looks along
            assertTrue(Vec3.of(m.normals!!, 3 * v).dot(m.position(v)) > 0.49f)
            assertEquals(bb.getFloat(bin + 576 + 8 * v), m.uvs!![2 * v], 0f); assertEquals(bb.getFloat(bin + 576 + 8 * v + 4), m.uvs!![2 * v + 1], 0f)
        }
        // 16-bit indices at bufferView offset 768
        for (i in 0 until 36) assertEquals(bb.getShort(bin + 768 + 2 * i).toInt() and 0xffff, m.indices[i])
        for (f in 0 until 12) assertTrue(Fixtures.faceNormal(m, f).dot(Fixtures.centroid(m, f)) > 0f)
        assertNull(m.confidence); assertNull(m.faceMaterial)
        // material + embedded PNG (bufferView offset 840, length 3750), bytes untouched
        val mat = m.materials.single()
        assertEquals("Texture", mat.name); assertFalse(mat.repaired)
        val tex = mat.baseColorTexture!!
        assertEquals("image/png", tex.mimeType); assertEquals(3750, tex.bytes.size)
        assertArrayEquals(bytes.copyOfRange(bin + 840, bin + 840 + 3750), tex.bytes)
        assertArrayEquals(byteArrayOf(0x89.toByte(), 'P'.code.toByte(), 'N'.code.toByte(), 'G'.code.toByte()), tex.bytes.copyOf(4))

        // re-export and read again: same model
        val again = GlbWriter.write(doc)
        File(outDir, "BoxTextured-reexport.glb").writeBytes(again)
        val m2 = GlbReader.read(again).mesh
        assertArrayEquals(m.positions, m2.positions, 0f); assertArrayEquals(m.indices, m2.indices); assertArrayEquals(m.uvs, m2.uvs, 0f)
        assertArrayEquals(tex.bytes, m2.materials[0].baseColorTexture!!.bytes)
    }

    @Test fun readsKhronosDuck() {
        val bytes = resource("Duck.glb")
        val doc = GlbReader.read(bytes)
        val m = doc.mesh
        assertEquals(2399, m.vertexCount); assertEquals(4212, m.faceCount)
        assertEquals(emptyList<String>(), doc.warnings)
        // node matrix: uniform scale 0.01 (stored as the float 0.009999999776482582)
        val bin = TestGlb.binOffset(bytes)
        val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        val scale = 0.009999999776482582
        for (v in 0 until 2399 step 13) {
            val o = bin + 28788 + 12 * v
            val expected = Vec3((bb.getFloat(o) * scale).toFloat(), (bb.getFloat(o + 4) * scale).toFloat(), (bb.getFloat(o + 8) * scale).toFloat())
            assertTrue(expected.distanceTo(m.position(v)) < 1e-6f)
            assertEquals(1f, Vec3.of(m.normals!!, 3 * v).length(), 1e-3f)
        }
        val box = Aabb.of(m.positions)
        assertTrue(box.min.distanceTo(Vec3(-0.692985f, 0.09929370f, -0.613282f)) < 1e-5f)
        assertTrue(box.max.distanceTo(Vec3(0.961799f, 1.63970f, 0.539252f)) < 1e-5f)
        for (i in 0 until 12636 step 7) assertEquals(bb.getShort(bin + 76768 + 2 * i).toInt() and 0xffff, m.indices[i])
        val tex = m.materials.single().baseColorTexture!!
        assertEquals("blinn3-fx", m.materials[0].name)
        assertEquals(16302, tex.bytes.size)
        assertArrayEquals(bytes.copyOfRange(bin + 102040, bin + 102040 + 16302), tex.bytes)
        // a real-world mesh through the processing chain: vertex normals agree with face winding,
        // and simplification keeps it close
        var agree = 0
        for (f in 0 until m.faceCount) {
            val n = Fixtures.faceNormal(m, f)
            val v = m.indices[3 * f]
            if (n.dot(Vec3.of(m.normals!!, 3 * v)) > 0f) agree++
        }
        assertTrue("winding/normal agreement $agree of ${m.faceCount}", agree > m.faceCount * 0.99)
        val volume = MeshOps.signedVolume(m)
        assertTrue(volume > 0f)
        val simplified = MeshOps.simplify(m, 1500)
        assertTrue(simplified.faceCount <= 1500)
        assertTrue(MeshOps.deviation(m, simplified.mesh).maxRelativeToDiagonal < 0.02f)
        assertEquals(volume, MeshOps.signedVolume(simplified.mesh), volume * 0.03f)
        for (v in 0 until simplified.mesh.vertexCount) assertTrue(simplified.mesh.uvs!![2 * v] in 0f..1f && simplified.mesh.uvs!![2 * v + 1] in 0f..1f)
        File(outDir, "Duck-simplified.glb").writeBytes(GlbWriter.write(GlbDocument(simplified.mesh, doc.extras, doc.generator)))
    }

    // ------------------------------------------------------------------ hand-built files: reader features

    /** Tetrahedron (0,0,0) (1,0,0) (0,1,0) (0,0,1), outward winding, volume 1/6. */
    private val tetPositions = floatArrayOf(0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f)
    private val tetIndices = intArrayOf(0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3)

    private fun tetGlb(nodes: String, extraRoot: String = "", sceneNodes: String = "[0]"): ByteArray {
        val bin = TestGlb.Bin().floats(*tetPositions).u8(*tetIndices)
        val json = """{"asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":$sceneNodes}],"nodes":$nodes,
            "meshes":[{"primitives":[{"attributes":{"POSITION":0},"indices":1}]}],
            "accessors":[{"bufferView":0,"componentType":5126,"count":4,"type":"VEC3","min":[0,0,0],"max":[1,1,1]},
                         {"bufferView":1,"componentType":5121,"count":12,"type":"SCALAR"}],
            "bufferViews":[{"buffer":0,"byteOffset":0,"byteLength":48},{"buffer":0,"byteOffset":48,"byteLength":12}],
            "buffers":[{"byteLength":60}]$extraRoot}"""
        return TestGlb.container(json, bin.toByteArray())
    }

    @Test fun bakesNodeHierarchyWithTrsMatrixAndMirror() {
        val h = sqrt(0.5)
        // node 0: translate (10, 0, 0), children 1 and 2
        // node 1: rotate 90 deg about Z, scale 2      -> p' = Rz(2p) + (10, 0, 0)
        // node 2: matrix mirroring x, then translate (0, 5, 0) -> p' = (-x, y + 5, z) + (10, 0, 0)
        // node 3: second scene root, non-uniform scale (1, 2, 3), instance of the same mesh
        val nodes = """[{"translation":[10,0,0],"children":[1,2]},
            {"mesh":0,"rotation":[0,0,$h,$h],"scale":[2,2,2]},
            {"mesh":0,"matrix":[-1,0,0,0, 0,1,0,0, 0,0,1,0, 0,5,0,1]},
            {"mesh":0,"scale":[1,2,3],"camera":0}]"""
        val doc = GlbReader.read(tetGlb(nodes, extraRoot = ""","cameras":[{"type":"perspective","perspective":{"yfov":1,"znear":0.1}}]""", sceneNodes = "[0,3]"))
        val m = doc.mesh
        assertEquals(12, m.vertexCount); assertEquals(12, m.faceCount)
        fun p(i: Int) = Vec3(tetPositions[3 * i], tetPositions[3 * i + 1], tetPositions[3 * i + 2])
        for (i in 0 until 4) {
            val s = p(i)
            // Rz(90): (x, y) -> (-y, x)
            assertTrue(Vec3(-2 * s.y + 10, 2 * s.x, 2 * s.z).distanceTo(m.position(i)) < 1e-5f)
            assertTrue(Vec3(-s.x + 10, s.y + 5, s.z).distanceTo(m.position(4 + i)) < 1e-6f)
            assertTrue(Vec3(s.x, 2 * s.y, 3 * s.z).distanceTo(m.position(8 + i)) < 1e-6f)
        }
        // mirrored instance: winding flipped so that it is still outward; the others keep their order
        assertArrayEquals(tetIndices, m.indices.copyOfRange(0, 12))
        assertArrayEquals(IntArray(12) { tetIndices[if (it % 3 == 1) it + 1 else if (it % 3 == 2) it - 1 else it] + 4 }, m.indices.copyOfRange(12, 24))
        val comps = MeshOps.components(m)
        assertEquals(3, comps.count)
        val volumes = (0 until 3).map { c -> MeshOps.signedVolume(MeshOps.keepFaces(m, BooleanArray(m.faceCount) { comps.faceComponent[it] == c })) }.sorted()
        assertEquals(1f / 6f, volumes[0], 1e-5f)   // mirrored: positive, not -1/6
        assertEquals(1f, volumes[1], 1e-5f)        // scale (1, 2, 3)
        assertEquals(8f / 6f, volumes[2], 1e-4f)   // scale 2
        assertNull(m.normals); assertNull(m.uvs)
        assertEquals("default", m.materials.single().name)
    }

    @Test fun bakesNormalsWithInverseTransposeAndMirror() {
        // one triangle in the plane x + y = 1 with its true normal; node: scale (1, 3, 1) mirrored in z
        val n = sqrt(0.5).toFloat()
        val bin = TestGlb.Bin().floats(1f, 0f, 0f, 0f, 1f, 0f, 0f, 1f, 1f).floats(n, n, 0f, n, n, 0f, n, n, 0f)
        val json = """{"asset":{"version":"2.0"},"scenes":[{"nodes":[0]}],"nodes":[{"mesh":0,"scale":[1,3,-1]}],
            "meshes":[{"primitives":[{"attributes":{"POSITION":0,"NORMAL":1}}]}],
            "accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3"},{"bufferView":0,"byteOffset":36,"componentType":5126,"count":3,"type":"VEC3"}],
            "bufferViews":[{"buffer":0,"byteLength":72}],"buffers":[{"byteLength":72}]}"""
        val m = GlbReader.read(TestGlb.container(json, bin.toByteArray())).mesh
        // transformed plane: x + y/3 = 1 -> normal (1, 1/3, 0) normalised
        val expected = Vec3(1f, 1f / 3f, 0f).normalized()
        for (v in 0 until 3) assertTrue(expected.distanceTo(Vec3.of(m.normals!!, 3 * v)) < 1e-6f)
        // winding was flipped to match: geometric normal agrees with the vertex normals
        assertTrue(Fixtures.faceNormal(m, 0).normalized().distanceTo(expected) < 1e-6f)
        assertArrayEquals(intArrayOf(0, 2, 1), m.indices)
    }

    @Test fun readsAccessorVariants() {
        // primitive A: interleaved POSITION+NORMAL+TEXCOORD (stride 32) at an accessor offset, u16 indices at an offset,
        //              _CONFIDENCE as normalised u8 with stride 4
        // primitive B: non-indexed, TEXCOORD_0 normalised u16, _CONFIDENCE normalised u16, no normals
        // primitive C: u32 indices, TEXCOORD_0 normalised u8, _CONFIDENCE float
        val bin = TestGlb.Bin()
        bin.floats(99f, 99f, 99f, 99f) // 16 bytes of padding before the interleaved data
        val quad = arrayOf(floatArrayOf(0f, 0f, 0f), floatArrayOf(1f, 0f, 0f), floatArrayOf(1f, 1f, 0f), floatArrayOf(0f, 1f, 0f))
        for ((i, p) in quad.withIndex()) bin.floats(p[0], p[1], p[2], 0f, 0f, 1f, p[0] * 0.5f, 1f - p[1] * 0.25f)
        val interleavedEnd = bin.size                                   // 16 + 4 * 32 = 144
        bin.u16(7, 7, 0, 1, 2, 0, 2, 3)                                 // 144: two junk entries, then 6 indices
        bin.align()                                                     // 160
        val confA = bin.size; bin.u8(0, 9, 9, 9, 51, 9, 9, 9, 255, 9, 9, 9, 102, 9, 9, 9) // 160: stride 4
        val posB = bin.size; bin.floats(0f, 0f, 1f, 1f, 0f, 1f, 0f, 1f, 1f)                // 176
        val uvB = bin.size; bin.u16(0, 65535, 13107, 0, 65535, 32768)                       // 212
        bin.align()
        val confB = bin.size; bin.u16(0, 65535, 6554); bin.align()                          // 224
        val posC = bin.size; bin.floats(0f, 0f, 2f, 1f, 0f, 2f, 0f, 1f, 2f)                 // 232
        val uvC = bin.size; bin.u8(0, 255, 51, 0, 255, 128); bin.align()                    // 268
        val confC = bin.size; bin.floats(0.125f, 0.5f, 0.875f)                              // 276
        val idxC = bin.size; bin.u32(2, 1, 0)                                               // 288
        assertEquals(144, interleavedEnd)
        val json = """{"asset":{"version":"2.0","generator":"hand","extras":{"a":[1,2,{"b":null}]}},"scene":0,"scenes":[{"nodes":[0]}],
          "nodes":[{"mesh":0}],
          "meshes":[{"primitives":[
            {"attributes":{"POSITION":0,"NORMAL":1,"TEXCOORD_0":2,"_CONFIDENCE":3,"COLOR_0":2},"indices":4,"mode":4},
            {"attributes":{"POSITION":5,"TEXCOORD_0":6,"_CONFIDENCE":7}},
            {"attributes":{"POSITION":8,"TEXCOORD_0":9,"_CONFIDENCE":10},"indices":11}]}],
          "accessors":[
            {"bufferView":0,"byteOffset":0,"componentType":5126,"count":4,"type":"VEC3"},
            {"bufferView":0,"byteOffset":12,"componentType":5126,"count":4,"type":"VEC3"},
            {"bufferView":0,"byteOffset":24,"componentType":5126,"count":4,"type":"VEC2"},
            {"bufferView":2,"componentType":5121,"normalized":true,"count":4,"type":"SCALAR"},
            {"bufferView":1,"byteOffset":4,"componentType":5123,"count":6,"type":"SCALAR"},
            {"bufferView":3,"componentType":5126,"count":3,"type":"VEC3"},
            {"bufferView":4,"componentType":5123,"normalized":true,"count":3,"type":"VEC2"},
            {"bufferView":5,"componentType":5123,"normalized":true,"count":3,"type":"SCALAR"},
            {"bufferView":6,"componentType":5126,"count":3,"type":"VEC3"},
            {"bufferView":7,"componentType":5121,"normalized":true,"count":3,"type":"VEC2"},
            {"bufferView":8,"componentType":5126,"count":3,"type":"SCALAR"},
            {"bufferView":9,"componentType":5125,"count":3,"type":"SCALAR"}],
          "bufferViews":[
            {"buffer":0,"byteOffset":16,"byteLength":128,"byteStride":32},
            {"buffer":0,"byteOffset":144,"byteLength":16},
            {"buffer":0,"byteOffset":$confA,"byteLength":16,"byteStride":4},
            {"buffer":0,"byteOffset":$posB,"byteLength":36},
            {"buffer":0,"byteOffset":$uvB,"byteLength":12},
            {"buffer":0,"byteOffset":$confB,"byteLength":6},
            {"buffer":0,"byteOffset":$posC,"byteLength":36},
            {"buffer":0,"byteOffset":$uvC,"byteLength":6},
            {"buffer":0,"byteOffset":$confC,"byteLength":12},
            {"buffer":0,"byteOffset":$idxC,"byteLength":12}],
          "buffers":[{"byteLength":${bin.size}}]}"""
        val doc = GlbReader.read(TestGlb.container(json, bin.toByteArray()))
        val m = doc.mesh
        assertEquals("hand", doc.generator)
        assertEquals("""{"a":[1,2,{"b":null}]}""", doc.extras.toString())
        assertEquals(10, m.vertexCount); assertEquals(4, m.faceCount)
        assertArrayEquals(intArrayOf(0, 1, 2, 0, 2, 3, 4, 5, 6, 9, 8, 7), m.indices)
        // A
        for ((i, p) in quad.withIndex()) {
            assertEquals(Vec3(p[0], p[1], p[2]), m.position(i))
            assertEquals(Vec3(0f, 0f, 1f), Vec3.of(m.normals!!, 3 * i))
            assertEquals(p[0] * 0.5f, m.uvs!![2 * i], 0f); assertEquals(1f - p[1] * 0.25f, m.uvs!![2 * i + 1], 0f)
        }
        assertArrayEquals(floatArrayOf(0f, 0.2f, 1f, 0.4f), m.confidence!!.copyOfRange(0, 4), 1e-7f)
        // B
        assertEquals(Vec3(1f, 0f, 1f), m.position(5))
        assertArrayEquals(floatArrayOf(0f, 1f, 0.2f, 0f, 1f, 32768f / 65535f), m.uvs!!.copyOfRange(8, 14), 1e-6f)
        assertArrayEquals(floatArrayOf(0f, 1f, 6554f / 65535f), m.confidence!!.copyOfRange(4, 7), 1e-7f)
        // C
        assertEquals(Vec3(0f, 1f, 2f), m.position(9))
        assertArrayEquals(floatArrayOf(0f, 1f, 0.2f, 0f, 1f, 128f / 255f), m.uvs!!.copyOfRange(14, 20), 1e-6f)
        assertArrayEquals(floatArrayOf(0.125f, 0.5f, 0.875f), m.confidence!!.copyOfRange(7, 10), 0f)
        // normals were missing on B and C: computed (+Z for B; C is wound clockwise about +Z, so -Z), with a warning
        assertEquals(Vec3(0f, 0f, 1f), Vec3.of(m.normals!!, 3 * 4))
        assertEquals(Vec3(0f, 0f, -1f), Vec3.of(m.normals!!, 3 * 7))
        assertTrue(doc.warnings.single().contains("normals"))
    }

    private fun materialGlb(materials: String, images: String, extra: String = "", imageBytes: ByteArray = Fixtures.png(4, 3)): ByteArray {
        val bin = TestGlb.Bin().floats(0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f, 0f).floats(0f, 0f, 1f, 0f, 0f, 1f).floats(0.5f, 0.5f, 0.25f, 0.25f, 0.75f, 0.75f)
        val imgOffset = bin.size
        bin.bytes(imageBytes)
        val json = """{"asset":{"version":"2.0"},"scenes":[{"nodes":[0,1]}],"nodes":[{"mesh":0},{"mesh":1,"translation":[0,0,1]}],
          "meshes":[{"primitives":[{"attributes":{"POSITION":0,"TEXCOORD_0":1,"TEXCOORD_1":2},"material":0}]},
                    {"primitives":[{"attributes":{"POSITION":0,"TEXCOORD_0":1,"TEXCOORD_1":2},"material":1}]}],
          "materials":$materials,
          "textures":[{"source":0,"sampler":0},{"source":1}],"samplers":[{}],"images":$images,
          "accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3"},{"bufferView":1,"componentType":5126,"count":3,"type":"VEC2"},
                       {"bufferView":2,"componentType":5126,"count":3,"type":"VEC2"}],
          "bufferViews":[{"buffer":0,"byteLength":36},{"buffer":0,"byteOffset":36,"byteLength":24},{"buffer":0,"byteOffset":60,"byteLength":24},
                         {"buffer":0,"byteOffset":$imgOffset,"byteLength":${imageBytes.size}}],
          "buffers":[{"byteLength":${bin.size}}]$extra}"""
        return TestGlb.container(json, bin.toByteArray())
    }

    @Test fun readsMaterialsImagesAndIgnoresUnusedFeatures() {
        val png = Fixtures.png(4, 3)
        val other = Fixtures.png(4, 5)
        val dataUri = "data:image/png;base64," + Base64.getEncoder().encodeToString(other)
        val materials = """[
          {"name":"observed","pbrMetallicRoughness":{"baseColorFactor":[0.5,0.25,1,0.75],"baseColorTexture":{"index":0},"metallicRoughnessTexture":{"index":1}},
           "normalTexture":{"index":1},"emissiveFactor":[1,1,1],"extensions":{"KHR_materials_unlit":{}},"extras":{"pocket3d_repaired":false}},
          {"pbrMetallicRoughness":{"baseColorTexture":{"index":1,"texCoord":1}},"extras":{"pocket3d_repaired":true,"other":5}}]"""
        val images = """[{"bufferView":3,"name":"atlas"},{"uri":"$dataUri"}]"""
        val extra = ""","extensionsUsed":["KHR_materials_unlit"],"extensionsRequired":["KHR_materials_unlit"],
          "animations":[{"channels":[],"samplers":[]}],"skins":[{"joints":[0]}],"cameras":[{"type":"orthographic"}],"extras":{"x":1}"""
        val doc = GlbReader.read(materialGlb(materials, images, extra, png))
        val m = doc.mesh
        assertEquals(2, m.materials.size)
        val a = m.materials[0]; val b = m.materials[1]
        assertEquals("observed", a.name); assertFalse(a.repaired)
        assertArrayEquals(floatArrayOf(0.5f, 0.25f, 1f, 0.75f), a.baseColorFactor, 0f)
        assertArrayEquals(png, a.baseColorTexture!!.bytes)
        assertEquals("image/png", a.baseColorTexture!!.mimeType) // sniffed: the image has no mimeType
        assertEquals("atlas", a.baseColorTexture!!.name)
        assertEquals("material_1", b.name); assertTrue(b.repaired)
        assertArrayEquals(other, b.baseColorTexture!!.bytes); assertEquals("image/png", b.baseColorTexture!!.mimeType)
        assertArrayEquals(intArrayOf(0, 1), m.faceMaterial)
        // material 0 samples TEXCOORD_0, material 1 samples TEXCOORD_1
        assertArrayEquals(floatArrayOf(0f, 0f, 1f, 0f, 0f, 1f, 0.5f, 0.5f, 0.25f, 0.25f, 0.75f, 0.75f), m.uvs, 0f)
        assertEquals(Vec3(0f, 1f, 1f), m.position(5))
    }

    @Test fun rejectsUnsupportedContentWithClearMessages() {
        fun messageOf(bytes: ByteArray): String = assertThrows(GlbFormatException::class.java) { GlbReader.read(bytes) }.message!!
        val okMaterials = """[{"pbrMetallicRoughness":{"baseColorTexture":{"index":0}}},{}]"""
        // external image / missing source
        assertTrue(messageOf(materialGlb(okMaterials, """[{"uri":"textures/atlas.png"},{"bufferView":3}]""")).contains("external file"))
        assertTrue(messageOf(materialGlb(okMaterials, """[{"uri":"data:image/png;base64,@@@"},{"bufferView":3}]""")).contains("base64"))
        // the same broken image is fine when no used material references it
        assertEquals(2, GlbReader.read(materialGlb("""[{},{}]""", """[{"uri":"textures/atlas.png"},{"bufferView":3}]""")).mesh.faceCount)
        // required extensions that change how geometry is stored
        assertTrue(messageOf(materialGlb(okMaterials, """[{"bufferView":3},{"bufferView":3}]""", ""","extensionsRequired":["KHR_draco_mesh_compression"]""")).contains("KHR_draco_mesh_compression"))
        // non-triangle primitives only
        val lines = tetGlb("""[{"mesh":0}]""").let { g -> TestGlb.editJson(g) { it.replace(""""indices":1}""", """"indices":1,"mode":1}""") } }
        assertTrue(messageOf(lines).contains("LINES"))
        val strip = tetGlb("""[{"mesh":0}]""").let { g -> TestGlb.editJson(g) { it.replace(""""indices":1}""", """"indices":1,"mode":5}""") } }
        assertTrue(messageOf(strip).contains("TRIANGLE_STRIP"))
        // mixed: triangles are read, the rest is skipped with a warning
        val mixed = tetGlb("""[{"mesh":0}]""").let { g ->
            TestGlb.editJson(g) { it.replace(""""indices":1}]""", """"indices":1},{"attributes":{"POSITION":0},"mode":0}]""") }
        }
        val doc = GlbReader.read(mixed)
        assertEquals(4, doc.mesh.faceCount)
        assertTrue(doc.warnings.single().contains("POINTS"))
        // sparse accessors, external buffers
        assertTrue(messageOf(TestGlb.editJson(tetGlb("""[{"mesh":0}]""")) { it.replace(""""count":4,""", """"count":4,"sparse":{"count":1},""") }).contains("sparse"))
        assertTrue(messageOf(TestGlb.editJson(tetGlb("""[{"mesh":0}]""")) { it.replace("""[{"byteLength":60}]""", """[{"byteLength":60,"uri":"scan.bin"}]""") }).contains("external file"))
    }

    // ------------------------------------------------------------------ malformed input

    private fun assertRejected(bytes: ByteArray, expectInMessage: String? = null) {
        val e = assertThrows(GlbFormatException::class.java) { GlbReader.read(bytes) }
        if (expectInMessage != null) assertTrue("message '${e.message}' should mention '$expectInMessage'", e.message!!.contains(expectInMessage, ignoreCase = true))
    }

    @Test fun rejectsBrokenContainers() {
        val good = GlbWriter.write(GlbDocument(texturedSphere()))
        assertRejected(ByteArray(0), "not a GLB")
        assertRejected(ByteArray(11), "not a GLB")
        assertRejected("this is definitely not a glb file".toByteArray(), "magic")
        assertRejected("""{"asset":{"version":"2.0"}}""".toByteArray(), "magic") // a .gltf JSON file
        fun patched(offset: Int, value: Int) = good.copyOf().also { ByteBuffer.wrap(it).order(ByteOrder.LITTLE_ENDIAN).putInt(offset, value) }
        assertRejected(patched(4, 1), "version")
        assertRejected(patched(4, 3), "version")
        assertRejected(patched(8, good.size + 4), "truncated")
        assertRejected(patched(8, 16))
        assertRejected(patched(12, good.size), "chunk")           // JSON chunk longer than the file
        assertRejected(patched(12, -8), "chunk")                  // 0xFFFFFFF8
        assertRejected(patched(16, 0x004E4942), "JSON")           // first chunk is not JSON
        // declared length shorter than the data: the BIN chunk is cut off
        assertRejected(patched(8, good.size - 64))
        // header only, then a container without a BIN chunk although buffers need one
        assertRejected(good.copyOf(12))
        val jsonLen = ByteBuffer.wrap(good).order(ByteOrder.LITTLE_ENDIAN).getInt(12)
        val noBin = good.copyOf(20 + jsonLen).also { ByteBuffer.wrap(it).order(ByteOrder.LITTLE_ENDIAN).putInt(8, 20 + jsonLen) }
        assertRejected(noBin, "binary chunk")
        // trailing garbage after the declared length is ignored
        assertEquals(texturedSphere().faceCount, GlbReader.read(good + ByteArray(7) { 0x55 }).mesh.faceCount)
    }

    @Test fun rejectsEveryTruncation() {
        for (bytes in listOf(resource("BoxTextured.glb"), GlbWriter.write(GlbDocument(multiMaterialMesh())))) {
            val step = if (bytes.size < 10000) 1 else 37
            val jsonLen = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).getInt(12)
            val binHeader = 20 + jsonLen
            var n = 0
            while (n < bytes.size) {
                // (a) the file simply ends early
                val plain = bytes.copyOf(n)
                // (b) ... and the header length was "repaired" to match (as a careless tool would)
                val fixedHeader = plain.copyOf().also { if (n >= 12) ByteBuffer.wrap(it).order(ByteOrder.LITTLE_ENDIAN).putInt(8, n) }
                // (c) ... and the BIN chunk length too, so that the container itself is consistent
                val fixedChunk = fixedHeader.copyOf().also { if (n >= binHeader + 8) ByteBuffer.wrap(it).order(ByteOrder.LITTLE_ENDIAN).putInt(binHeader, n - binHeader - 8) }
                for ((variant, cut) in listOf(plain, fixedHeader, fixedChunk).withIndex()) {
                    try {
                        GlbReader.read(cut)
                        fail("a file truncated to $n of ${bytes.size} bytes was accepted (variant $variant)")
                    } catch (e: GlbFormatException) {
                        assertTrue(e.message!!.isNotBlank())
                    } // anything else (IndexOutOfBounds, BufferUnderflow, ...) fails the test
                }
                n += step
            }
        }
    }

    @Test fun rejectsBrokenJsonAndReferences() {
        val base = tetGlb("""[{"mesh":0}]""")
        assertEquals(4, GlbReader.read(base).mesh.faceCount)
        fun edit(from: String, to: String) = TestGlb.editJson(base) { require(it.contains(from)) { "pattern '$from' not in JSON" }; it.replace(from, to) }
        assertRejected(TestGlb.container("{ not json", null), "JSON")
        assertRejected(TestGlb.container("[1,2,3]", null), "not an object")
        assertRejected(TestGlb.container("{}", null), "asset")
        assertRejected(edit(""""version":"2.0"""", """"version":"1.0""""), "version")
        assertRejected(edit(""""version":"2.0"""", """"version":2"""))
        assertRejected(edit(""""scene":0""", """"scene":3"""), "scene")
        assertRejected(edit(""""scenes":[{"nodes":[0]}]""", """"scenes":[{"nodes":[5]}]"""), "node")
        assertRejected(edit(""""nodes":[{"mesh":0}]""", """"nodes":[{"mesh":2}]"""), "mesh")
        assertRejected(edit(""""nodes":[{"mesh":0}]""", """"nodes":[{"mesh":0,"children":[0]}]"""), "ancestor")
        assertRejected(edit(""""nodes":[{"mesh":0}]""", """"nodes":[{"mesh":0,"matrix":[1,2,3]}]"""), "matrix")
        assertRejected(edit(""""nodes":[{"mesh":0}]""", """"nodes":[{"mesh":0,"scale":[1,"a",1]}]"""), "scale")
        assertRejected(edit(""""POSITION":0""", """"POSITION":9"""), "accessor")
        assertRejected(edit(""""POSITION":0""", """"POSITION":-1"""), "accessor")
        assertRejected(edit(""""POSITION":0""", """"POSITION":"zero""""), "POSITION")
        assertRejected(edit(""""indices":1""", """"indices":0"""), "indices")              // float VEC3 accessor as indices
        assertRejected(edit(""""count":4""", """"count":5"""), "truncated")                 // needs 60 bytes of a 48 byte view
        assertRejected(edit(""""count":4""", """"count":3"""), "vertex")                    // indices now reference vertex 3 of 3
        assertRejected(edit(""""count":4""", """"count":-4"""))
        assertRejected(edit(""""count":4""", """"count":4.5"""), "integer")
        assertRejected(edit(""""count":4""", """"count":1e12"""))
        assertRejected(edit(""""count":12""", """"count":11"""), "multiple of 3")
        assertRejected(edit(""""count":12""", """"count":13"""), "truncated")
        assertRejected(edit(""""type":"VEC3"""", """"type":"VEC2""""), "VEC3")
        assertRejected(edit(""""type":"VEC3"""", """"type":"BANANA""""), "type")
        assertRejected(edit(""""componentType":5126""", """"componentType":5130"""), "componentType")
        assertRejected(edit(""""componentType":5121""", """"componentType":5120"""), "unsigned")
        assertRejected(edit(""""byteOffset":48,"byteLength":12""", """"byteOffset":56,"byteLength":12"""), "exceeds")
        assertRejected(edit(""""byteOffset":48,"byteLength":12""", """"byteOffset":-4,"byteLength":12"""))
        assertRejected(edit(""""byteOffset":0,"byteLength":48""", """"byteOffset":0,"byteLength":48,"byteStride":8"""), "byteStride")
        assertRejected(edit(""""bufferViews":[{"buffer":0""", """"bufferViews":[{"buffer":1"""), "buffer")
        assertRejected(edit(""""buffers":[{"byteLength":60}]""", """"buffers":[{"byteLength":6000}]"""), "binary chunk")
        assertRejected(edit(""""buffers":[{"byteLength":60}]""", """"buffers":[{"byteLength":40}]"""), "exceeds")
        assertRejected(edit(""""meshes":[{"primitives":[""", """"meshes":[{"primitive":["""), "primitives")
        assertRejected(edit(""""accessors":[""", """"accessors":{"a":["""))
        // NaN positions (the bytes of the first float replaced)
        val nan = base.copyOf().also { ByteBuffer.wrap(it).order(ByteOrder.LITTLE_ENDIAN).putFloat(TestGlb.binOffset(it), Float.NaN) }
        assertRejected(nan, "non-finite")
        // an index beyond the vertex count, in the binary data
        val badIndex = base.copyOf().also { it[TestGlb.binOffset(it) + 48 + 5] = 200.toByte() }
        assertRejected(badIndex, "vertex 200")
    }

    @Test fun survivesRandomCorruption() {
        // flip random bytes: the reader must either produce a mesh or throw GlbFormatException, never anything else
        val sources = listOf(resource("BoxTextured.glb"), GlbWriter.write(GlbDocument(multiMaterialMesh())), tetGlb("""[{"mesh":0,"scale":[1,2,3]}]"""))
        val rng = SplitMix64(2024)
        var rejected = 0; var accepted = 0
        for ((si, src) in sources.withIndex()) {
            val jsonEnd = 20 + ByteBuffer.wrap(src).order(ByteOrder.LITTLE_ENDIAN).getInt(12)
            repeat(1500) { round ->
                val bytes = src.copyOf()
                val edits = 1 + (rng.nextLong() and 3).toInt()
                repeat(edits) {
                    // mostly the header and JSON (structure), sometimes the binary payload
                    val region = if (rng.nextDouble() < 0.8) minOf(jsonEnd + 8, bytes.size) else bytes.size
                    val at = (rng.nextDouble() * region).toInt()
                    bytes[at] = when ((rng.nextLong() and 3).toInt()) {
                        0 -> (rng.nextLong() and 0xff).toByte()
                        1 -> '9'.code.toByte()
                        2 -> (bytes[at].toInt() xor (1 shl (rng.nextLong() and 7).toInt())).toByte()
                        else -> '-'.code.toByte()
                    }
                }
                try {
                    val m = GlbReader.read(bytes).mesh
                    // whatever was accepted must be a self-consistent mesh
                    for (i in m.indices) assertTrue(i in 0 until m.vertexCount)
                    for (f in 0 until m.faceCount) assertTrue(m.materialOfFace(f) in m.materials.indices)
                    accepted++
                } catch (e: GlbFormatException) {
                    rejected++
                } catch (e: Throwable) {
                    throw AssertionError("source $si round $round: reader crashed with $e", e)
                }
            }
        }
        assertTrue("fuzzing never produced an invalid file ($rejected rejected, $accepted accepted)", rejected > 500)
        assertTrue(accepted > 100)
    }
}
