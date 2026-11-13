package dev.pocket3d.viewer

import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.mesh.Material
import dev.pocket3d.core.mesh.Mesh
import dev.pocket3d.core.mesh.TextureImage
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.CRC32
import java.util.zip.Deflater
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/** Small procedural meshes and the location of the real example reconstruction. */
object TestMeshes {
    /** Real pipeline output shipped in the repository (tests run with the module dir as working dir). */
    val REAL_DIR: File = listOf(File("../../results/textured_standard"), File("results/textured_standard"),
                                File("../results/textured_standard")).firstOrNull { File(it, "model.glb").isFile }
        ?: File("../../results/textured_standard")
    val REAL_GLB = File(REAL_DIR, "model.glb")
    val REAL_CAMERAS = File(REAL_DIR, "cameras.json")
    val REAL_DIAGNOSTICS = File(REAL_DIR, "diagnostics.json")
    val REAL_SPARSE = File(REAL_DIR, "sparse_preview.json")

    /** A real, decodable RGB PNG (the Android unit-test classpath has no java.awt, so it is encoded by hand). */
    fun png(size: Int = 4, seed: Int = 1): ByteArray {
        val raw = ByteArrayOutputStream()
        for (y in 0 until size) {
            raw.write(0)                                   // filter: none
            for (x in 0 until size) {
                val c = ((x * 31 + y * 17 + seed * 101) * 2654435761L).toInt()
                raw.write(c shr 16 and 0xff); raw.write(c shr 8 and 0xff); raw.write(c and 0xff)
            }
        }
        val deflater = Deflater()
        deflater.setInput(raw.toByteArray()); deflater.finish()
        val buf = ByteArray(4096); val z = ByteArrayOutputStream()
        while (!deflater.finished()) z.write(buf, 0, deflater.deflate(buf))
        val out = ByteArrayOutputStream()
        out.write(byteArrayOf(0x89.toByte(), 'P'.code.toByte(), 'N'.code.toByte(), 'G'.code.toByte(), 13, 10, 26, 10))
        fun int(v: Int) = byteArrayOf((v ushr 24).toByte(), (v ushr 16).toByte(), (v ushr 8).toByte(), v.toByte())
        fun chunk(type: String, data: ByteArray) {
            out.write(int(data.size)); val t = type.toByteArray(); out.write(t); out.write(data)
            val crc = CRC32(); crc.update(t); crc.update(data); out.write(int(crc.value.toInt()))
        }
        chunk("IHDR", int(size) + int(size) + byteArrayOf(8, 2, 0, 0, 0))
        chunk("IDAT", z.toByteArray())
        chunk("IEND", ByteArray(0))
        return out.toByteArray()
    }

    fun textured(name: String = "atlas", seed: Int = 1) = Material(name, TextureImage("image/png", png(4, seed), "$name.png"))

    /**
     * Flat grid in the XZ plane (y = 0), [n] × [n] quads covering [-size/2, size/2]², normals +Y,
     * with UVs and confidence = x-fraction. [skip] removes quads (i, j) to make holes. Faces with
     * i >= n / 2 use the second material when [twoMaterials].
     */
    fun grid(n: Int = 8, size: Float = 2f, twoMaterials: Boolean = false, skip: (Int, Int) -> Boolean = { _, _ -> false }): Mesh {
        val cols = n + 1
        val pos = FloatArray(cols * cols * 3); val nrm = FloatArray(cols * cols * 3)
        val uv = FloatArray(cols * cols * 2); val conf = FloatArray(cols * cols)
        for (j in 0..n) for (i in 0..n) {
            val k = j * cols + i
            pos[3 * k] = (i.toFloat() / n - 0.5f) * size; pos[3 * k + 1] = 0f; pos[3 * k + 2] = (j.toFloat() / n - 0.5f) * size
            nrm[3 * k + 1] = 1f
            uv[2 * k] = i.toFloat() / n; uv[2 * k + 1] = j.toFloat() / n
            conf[k] = i.toFloat() / n
        }
        val idx = ArrayList<Int>(); val mat = ArrayList<Int>()
        for (j in 0 until n) for (i in 0 until n) {
            if (skip(i, j)) continue
            val a = j * cols + i; val b = a + 1; val c = a + cols; val d = c + 1
            // counter-clockwise seen from +Y
            idx += listOf(a, c, b, b, c, d)
            val m = if (twoMaterials && i >= n / 2) 1 else 0
            mat += m; mat += m
        }
        val materials = if (twoMaterials) listOf(textured("page0", 1), textured("page1", 2)) else listOf(textured())
        return Mesh(pos, nrm, uv, conf, idx.toIntArray(), mat.toIntArray(), materials)
    }

    /** Closed UV sphere, counter-clockwise from outside, single untextured material, confidence 1. */
    fun sphere(radius: Float = 1f, segments: Int = 24, rings: Int = 12, center: Vec3 = Vec3.ZERO): Mesh {
        val pos = ArrayList<Float>(); val nrm = ArrayList<Float>()
        fun add(theta: Double, phi: Double): Int {
            val nx = (sin(theta) * cos(phi)).toFloat(); val ny = cos(theta).toFloat(); val nz = (sin(theta) * sin(phi)).toFloat()
            pos += center.x + nx * radius; pos += center.y + ny * radius; pos += center.z + nz * radius
            nrm += nx; nrm += ny; nrm += nz
            return pos.size / 3 - 1
        }
        val top = add(0.0, 0.0)
        val ringStart = IntArray(rings - 1)
        for (i in 1 until rings) {
            ringStart[i - 1] = pos.size / 3
            for (j in 0 until segments) add(PI * i / rings, 2 * PI * j / segments)
        }
        val bottom = add(PI, 0.0)
        val idx = ArrayList<Int>()
        for (j in 0 until segments) {
            val j1 = (j + 1) % segments
            idx += listOf(top, ringStart[0] + j1, ringStart[0] + j)
            for (i in 0 until rings - 2) {
                val a = ringStart[i] + j; val b = ringStart[i] + j1; val c = ringStart[i + 1] + j; val d = ringStart[i + 1] + j1
                idx += listOf(a, b, c, b, d, c)
            }
            idx += listOf(bottom, ringStart[rings - 2] + j, ringStart[rings - 2] + j1)
        }
        val v = pos.size / 3
        return Mesh(pos.toFloatArray(), nrm.toFloatArray(), null, FloatArray(v) { 1f }, idx.toIntArray(), null, listOf(Material("plain")))
    }

    /** Unit cube centred on the origin with 8 shared vertices and 12 triangles. */
    fun cube(): Mesh {
        val p = floatArrayOf(-.5f, -.5f, -.5f, .5f, -.5f, -.5f, .5f, .5f, -.5f, -.5f, .5f, -.5f,
                             -.5f, -.5f, .5f, .5f, -.5f, .5f, .5f, .5f, .5f, -.5f, .5f, .5f)
        val i = intArrayOf(0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3)
        return Mesh(p, null, null, null, i, null, listOf(Material("plain")))
    }
}
