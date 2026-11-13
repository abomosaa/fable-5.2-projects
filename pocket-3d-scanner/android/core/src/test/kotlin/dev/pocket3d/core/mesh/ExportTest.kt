package dev.pocket3d.core.mesh

import dev.pocket3d.core.math.Vec3
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

class ExportTest {
    // ---- a tiny OBJ / MTL parser, independent of the writer ----
    private class ObjFace(val v: IntArray, val vt: IntArray?, val vn: IntArray?, val group: String?, val material: String?)
    private class Obj {
        val v = ArrayList<FloatArray>(); val vt = ArrayList<FloatArray>(); val vn = ArrayList<FloatArray>()
        val faces = ArrayList<ObjFace>(); val mtllibs = ArrayList<String>()
    }

    private fun parseObj(bytes: ByteArray): Obj {
        val obj = Obj()
        var group: String? = null; var material: String? = null
        for (raw in String(bytes, Charsets.US_ASCII).lineSequence()) {
            val line = raw.trim()
            if (line.isEmpty() || line.startsWith("#")) continue
            val t = line.split(Regex("\\s+"))
            when (t[0]) {
                "v" -> obj.v.add(FloatArray(3) { parsePlain(t[it + 1]) })
                "vt" -> obj.vt.add(FloatArray(2) { parsePlain(t[it + 1]) })
                "vn" -> obj.vn.add(FloatArray(3) { parsePlain(t[it + 1]) })
                "g" -> group = t[1]
                "usemtl" -> material = t[1]
                "mtllib" -> obj.mtllibs.add(t[1])
                "f" -> {
                    assertEquals("only triangles expected", 4, t.size)
                    val parts = t.drop(1).map { it.split("/") }
                    val hasVt = parts[0].size > 1 && parts[0][1].isNotEmpty(); val hasVn = parts[0].size > 2
                    obj.faces.add(ObjFace(
                        IntArray(3) { parts[it][0].toInt() }, if (hasVt) IntArray(3) { parts[it][1].toInt() } else null,
                        if (hasVn) IntArray(3) { parts[it][2].toInt() } else null, group, material,
                    ))
                }
                else -> throw AssertionError("unexpected OBJ statement: $line")
            }
        }
        return obj
    }

    /** Strict plain-decimal float: what the simplest OBJ loaders accept (no exponent, no NaN). */
    private fun parsePlain(s: String): Float {
        assertTrue("number '$s' is not plain decimal", Regex("-?\\d+(\\.\\d+)?").matches(s))
        return s.toFloat()
    }

    private fun parseMtl(bytes: ByteArray): Map<String, Map<String, String>> {
        val out = LinkedHashMap<String, LinkedHashMap<String, String>>()
        var cur: LinkedHashMap<String, String>? = null
        for (raw in String(bytes, Charsets.UTF_8).lineSequence()) {
            val line = raw.trim()
            if (line.isEmpty()) continue
            if (line.startsWith("#")) { cur?.put("#", line); continue }
            val sp = line.indexOf(' ')
            val key = line.substring(0, sp); val value = line.substring(sp + 1)
            if (key == "newmtl") { cur = LinkedHashMap(); out[value] = cur } else cur!![key] = value
        }
        return out
    }

    private fun exportMesh(): Mesh {
        val atlas = Fixtures.texturedMaterial("my atlas")
        val a = Fixtures.planeGrid(3, 2, 1f, atlas) { x, z -> 1e-5f * x - 3.25e-7f * z }   // tiny values: no exponent notation allowed
        val b = Fixtures.translate(Fixtures.planeGrid(2, 2, 1f, Material("my atlas", atlas.baseColorTexture)), Vec3(2f, 0f, 0f)) // same name, same image
        val c = Fixtures.translate(Fixtures.planeGrid(1, 1, 1f, Material(MeshOps.REPAIRED_MATERIAL_NAME, null, floatArrayOf(0.5f, 0.5f, 0.5f, 1f), repaired = true)), Vec3(4f, 0f, 0f))
        val d = Fixtures.translate(Fixtures.planeGrid(1, 1, 1f, Material("tinted", TextureImage("image/jpeg", byteArrayOf(-1, -40, -1, 1, 2, 3), "t"), floatArrayOf(0.25f, 0.5f, 1f, 0.75f))), Vec3(6f, 0f, 0f))
        return Fixtures.merge(a, b, c, d)
    }

    @Test fun objRoundTripsThroughIndependentParser() {
        val mesh = exportMesh()
        val files = ObjWriter.write(mesh, "scan")
        assertEquals(setOf("scan.obj", "scan.mtl", "scan_0.png", "scan_1.jpg"), files.keys)
        val obj = parseObj(files["scan.obj"]!!)
        assertEquals(listOf("scan.mtl"), obj.mtllibs)
        assertEquals(mesh.vertexCount, obj.v.size); assertEquals(mesh.vertexCount, obj.vt.size); assertEquals(mesh.vertexCount, obj.vn.size)
        assertEquals(mesh.faceCount, obj.faces.size)
        for (v in 0 until mesh.vertexCount) {
            // exact float round trip, also for the tiny heights
            assertEquals(mesh.position(v), Vec3(obj.v[v][0], obj.v[v][1], obj.v[v][2]))
            assertEquals(mesh.uvs!![2 * v], obj.vt[v][0], 0f)
            // V flip: OBJ's origin is bottom-left, ours top-left
            assertEquals(1f - mesh.uvs!![2 * v + 1], obj.vt[v][1], 0f)
            assertEquals(Vec3.of(mesh.normals!!, 3 * v), Vec3(obj.vn[v][0], obj.vn[v][1], obj.vn[v][2]))
        }
        assertTrue(obj.v.any { it[1] != 0f && Math.abs(it[1]) < 1e-5f })
        // a concrete corner: grid vertex (x = 0, z = 0) has uv (0, 0) = top-left of the image -> OBJ vt (0, 1)
        assertArrayEquals(floatArrayOf(0f, 1f), obj.vt[0], 0f)

        // faces: grouped by material in material order, 1-based v/vt/vn with equal indices, same winding
        val mtl = parseMtl(files["scan.mtl"]!!)
        assertEquals(listOf("my_atlas", "my_atlas_2", "Repaired_(unobserved)", "tinted"), mtl.keys.toList())
        val expectedOrder = (0 until mesh.faceCount).sortedBy { mesh.materialOfFace(it) } // stable
        for ((i, f) in expectedOrder.withIndex()) {
            val face = obj.faces[i]
            assertArrayEquals(IntArray(3) { mesh.indices[3 * f + it] + 1 }, face.v)
            assertArrayEquals(face.v, face.vt); assertArrayEquals(face.v, face.vn)
            assertEquals(mtl.keys.toList()[mesh.materialOfFace(f)], face.material)
            assertEquals(face.material, face.group)
        }
        // MTL
        assertEquals("scan_0.png", mtl["my_atlas"]!!["map_Kd"]); assertEquals("scan_0.png", mtl["my_atlas_2"]!!["map_Kd"])
        assertEquals("scan_1.jpg", mtl["tinted"]!!["map_Kd"])
        assertNull(mtl["Repaired_(unobserved)"]!!["map_Kd"])
        assertEquals("# pocket3d_repaired", mtl["Repaired_(unobserved)"]!!["#"])
        assertNull(mtl["my_atlas"]!!["#"])
        assertEquals("0.5 0.5 0.5", mtl["Repaired_(unobserved)"]!!["Kd"])
        assertEquals("0.25 0.5 1", mtl["tinted"]!!["Kd"]); assertEquals("0.75", mtl["tinted"]!!["d"])
        assertEquals("1 1 1", mtl["my_atlas"]!!["Kd"]); assertEquals("1", mtl["my_atlas"]!!["d"])
        // textures: original bytes, shared image written once
        assertArrayEquals(mesh.materials[0].baseColorTexture!!.bytes, files["scan_0.png"])
        assertArrayEquals(byteArrayOf(-1, -40, -1, 1, 2, 3), files["scan_1.jpg"])
    }

    @Test fun objWithoutUvsOrNormals() {
        val src = Fixtures.uvSphere(1f, 8, 4, Fixtures.texturedMaterial())
        val noUv = parseObj(ObjWriter.write(Mesh(src.positions, src.normals, null, null, src.indices, null, src.materials), "a")["a.obj"]!!)
        assertEquals(0, noUv.vt.size); assertEquals(src.vertexCount, noUv.vn.size)
        assertNull(noUv.faces[0].vt); assertArrayEquals(noUv.faces[0].v, noUv.faces[0].vn) // f v//vn
        val files = ObjWriter.write(Mesh(src.positions, null, null, null, src.indices, null, emptyList()), "b")
        assertEquals(setOf("b.obj", "b.mtl"), files.keys) // a textured material without UVs writes no texture; here: no materials at all
        val bare = parseObj(files["b.obj"]!!)
        assertNull(bare.faces[0].vt); assertNull(bare.faces[0].vn)
        assertEquals("default", bare.faces[0].material)
        assertEquals(src.faceCount, bare.faces.size)
        assertEquals(setOf("a.obj", "a.mtl"), ObjWriter.write(Mesh(src.positions, src.normals, null, null, src.indices, null, src.materials), "a").keys)
        assertThrows(IllegalArgumentException::class.java) { ObjWriter.write(src, "../evil") }
        assertThrows(IllegalArgumentException::class.java) { ObjWriter.write(src, "") }
    }

    // ---- a tiny binary PLY parser ----
    private class Ply(val vertexProps: List<String>, val faceProps: List<String>, val vertices: List<FloatArray>, val faces: List<IntArray>, val faceExtra: List<Int>, val comments: List<String>)

    private fun parsePly(bytes: ByteArray): Ply {
        val marker = "end_header\n".toByteArray()
        var end = -1
        outer@ for (i in 0..bytes.size - marker.size) { for (k in marker.indices) if (bytes[i + k] != marker[k]) continue@outer; end = i + marker.size; break }
        assertTrue("no end_header", end > 0)
        val lines = String(bytes, 0, end, Charsets.US_ASCII).trim().lines()
        assertEquals("ply", lines[0]); assertEquals("format binary_little_endian 1.0", lines[1])
        var vCount = 0; var fCount = 0; var element = ""
        val vp = ArrayList<String>(); val fp = ArrayList<String>(); val comments = ArrayList<String>()
        for (l in lines.drop(2)) {
            val t = l.split(" ")
            when (t[0]) {
                "comment" -> comments.add(l.removePrefix("comment "))
                "element" -> { element = t[1]; if (element == "vertex") vCount = t[2].toInt() else if (element == "face") fCount = t[2].toInt() else throw AssertionError(l) }
                "property" -> if (element == "vertex") { assertEquals("float", t[1]); vp.add(t[2]) } else fp.add(l.removePrefix("property "))
                "end_header" -> Unit
                else -> throw AssertionError("unexpected header line: $l")
            }
        }
        val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN); bb.position(end)
        val vertices = List(vCount) { FloatArray(vp.size) { bb.getFloat() } }
        assertEquals("list uchar int vertex_indices", fp[0])
        val extra = ArrayList<Int>()
        val faces = List(fCount) {
            assertEquals(3, bb.get().toInt())
            val f = IntArray(3) { bb.getInt() }
            if (fp.size > 1) extra.add(bb.get().toInt())
            f
        }
        assertEquals("trailing bytes", 0, bb.remaining())
        return Ply(vp, fp, vertices, faces, extra, comments)
    }

    @Test fun plyRoundTripsThroughIndependentParser() {
        val mesh = Fixtures.uvSphere(1.5f, 12, 6, Fixtures.texturedMaterial())
        val ply = parsePly(PlyWriter.write(mesh))
        assertEquals(listOf("x", "y", "z", "nx", "ny", "nz", "s", "t", "confidence"), ply.vertexProps)
        assertEquals(listOf("list uchar int vertex_indices"), ply.faceProps)
        assertEquals(mesh.vertexCount, ply.vertices.size); assertEquals(mesh.faceCount, ply.faces.size)
        for (v in 0 until mesh.vertexCount) {
            val p = ply.vertices[v]
            assertEquals(mesh.position(v), Vec3(p[0], p[1], p[2]))
            assertEquals(Vec3.of(mesh.normals!!, 3 * v), Vec3(p[3], p[4], p[5]))
            assertEquals(mesh.uvs!![2 * v], p[6], 0f)
            assertEquals(1f - mesh.uvs!![2 * v + 1], p[7], 0f) // V flip
            assertEquals(mesh.confidence!![v], p[8], 0f)
        }
        for (f in 0 until mesh.faceCount) assertArrayEquals(mesh.indices.copyOfRange(3 * f, 3 * f + 3), ply.faces[f])
        assertTrue(ply.comments.any { it.contains("t = 1 - v") })
    }

    @Test fun plyOptionalPropertiesAndRepairedFlag() {
        val src = Fixtures.planeGrid(2, 2)
        val bare = parsePly(PlyWriter.write(Mesh(src.positions, null, null, null, src.indices, null, emptyList())))
        assertEquals(listOf("x", "y", "z"), bare.vertexProps)
        assertEquals(8, bare.faces.size)
        val confOnly = parsePly(PlyWriter.write(Mesh(src.positions, null, null, src.confidence, src.indices, null, emptyList())))
        assertEquals(listOf("x", "y", "z", "confidence"), confOnly.vertexProps)
        assertEquals(src.confidence!![5], confOnly.vertices[5][3], 0f)

        // repaired faces are flagged per face
        val open = MeshOps.removeFaces(Fixtures.planeGrid(3, 3, 3f), BooleanArray(18) { it == 8 || it == 9 })
        val filled = MeshOps.fillHoles(open, setOf(1)).mesh
        val ply = parsePly(PlyWriter.write(filled))
        assertEquals(listOf("list uchar int vertex_indices", "uchar repaired"), ply.faceProps)
        assertEquals(filled.faceCount, ply.faceExtra.size)
        for (f in 0 until filled.faceCount) assertEquals(if (f >= open.faceCount) 1 else 0, ply.faceExtra[f])
        for (v in open.vertexCount until filled.vertexCount) assertEquals(0f, ply.vertices[v][ply.vertexProps.indexOf("confidence")], 0f)
        // a repaired material that no face uses does not add the property
        val unused = parsePly(PlyWriter.write(open.copy(materials = open.materials + Material("r", repaired = true))))
        assertFalse(unused.faceProps.contains("uchar repaired"))
        // empty mesh is a valid file
        val empty = parsePly(PlyWriter.write(Mesh(FloatArray(0), null, null, null, IntArray(0), null, emptyList())))
        assertEquals(0, empty.vertices.size); assertEquals(0, empty.faces.size)
    }
}
