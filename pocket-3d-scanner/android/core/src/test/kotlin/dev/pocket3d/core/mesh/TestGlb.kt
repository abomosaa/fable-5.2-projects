package dev.pocket3d.core.mesh

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Test-side GLB container tools, independent of GlbReader / GlbWriter. */
object TestGlb {
    /** Little-endian byte buffer builder with 4-byte alignment helper. */
    class Bin {
        private val out = ByteArrayOutputStream()
        val size: Int get() = out.size()
        fun floats(vararg v: Float): Bin { val b = ByteBuffer.allocate(4 * v.size).order(ByteOrder.LITTLE_ENDIAN); v.forEach { b.putFloat(it) }; out.write(b.array()); return this }
        fun u8(vararg v: Int): Bin { v.forEach { out.write(it) }; return this }
        fun u16(vararg v: Int): Bin { val b = ByteBuffer.allocate(2 * v.size).order(ByteOrder.LITTLE_ENDIAN); v.forEach { b.putShort(it.toShort()) }; out.write(b.array()); return this }
        fun u32(vararg v: Int): Bin { val b = ByteBuffer.allocate(4 * v.size).order(ByteOrder.LITTLE_ENDIAN); v.forEach { b.putInt(it) }; out.write(b.array()); return this }
        fun bytes(v: ByteArray): Bin { out.write(v); return this }
        fun align(): Bin { while (out.size() % 4 != 0) out.write(0); return this }
        fun toByteArray(): ByteArray = out.toByteArray()
    }

    /** Assemble a GLB from JSON text and an optional binary chunk. */
    fun container(json: String, bin: ByteArray?): ByteArray {
        var j = json.toByteArray(Charsets.UTF_8)
        while (j.size % 4 != 0) j += ' '.code.toByte()
        var b = bin
        if (b != null) while (b!!.size % 4 != 0) b += 0
        val total = 12 + 8 + j.size + (if (b != null) 8 + b.size else 0)
        val out = ByteBuffer.allocate(total).order(ByteOrder.LITTLE_ENDIAN)
        out.putInt(0x46546C67).putInt(2).putInt(total)
        out.putInt(j.size).putInt(0x4E4F534A).put(j)
        if (b != null) out.putInt(b.size).putInt(0x004E4942).put(b)
        return out.array()
    }

    /** JSON chunk of a GLB, parsed with a plain JSON parser. */
    fun json(glb: ByteArray): JsonObject {
        val bb = ByteBuffer.wrap(glb).order(ByteOrder.LITTLE_ENDIAN)
        val len = bb.getInt(12)
        return Json.parseToJsonElement(String(glb, 20, len, Charsets.UTF_8)) as JsonObject
    }

    /** Offset of the binary chunk payload within the GLB. */
    fun binOffset(glb: ByteArray): Int = 20 + ByteBuffer.wrap(glb).order(ByteOrder.LITTLE_ENDIAN).getInt(12) + 8

    /** The JSON text of a GLB with [edit] applied, re-packed with the same binary chunk. */
    fun editJson(glb: ByteArray, edit: (String) -> String): ByteArray {
        val bb = ByteBuffer.wrap(glb).order(ByteOrder.LITTLE_ENDIAN)
        val len = bb.getInt(12)
        val text = String(glb, 20, len, Charsets.UTF_8)
        val binStart = 20 + len
        val bin = if (binStart + 8 <= glb.size) glb.copyOfRange(binStart + 8, binStart + 8 + bb.getInt(binStart)) else null
        val edited = edit(text)
        require(edited != text) { "edit did not change the JSON" }
        return container(edited, bin)
    }
}
