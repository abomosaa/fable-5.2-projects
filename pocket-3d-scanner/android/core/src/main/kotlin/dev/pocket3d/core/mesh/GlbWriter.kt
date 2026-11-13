package dev.pocket3d.core.mesh

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.IdentityHashMap
import kotlin.math.sqrt

/**
 * Writer for binary glTF 2.0 (`.glb`), producing files that pass the Khronos glTF-Validator.
 *
 * Layout: one scene, one node, one mesh with one primitive per material that is actually used by
 * at least one face (in material order). Each primitive has its own compact vertex data:
 * `POSITION` (with min/max), `NORMAL` (always written, unit length; computed when the mesh has
 * none or a stored normal is unusable), `TEXCOORD_0` when the mesh has UVs (for every primitive,
 * textured or not), the custom `_CONFIDENCE` float scalar when the mesh has confidence, and
 * 32-bit indices. Textures are embedded with their original encoded bytes.
 *
 * Materials are written with `metallicFactor` 0, `roughnessFactor` 1 and `doubleSided: true`. A
 * material with `repaired = true` gets `extras.pocket3d_repaired = true` (and keeps its own name),
 * which [GlbReader] maps back to [Material.repaired] — repaired surface stays identifiable.
 *
 * Consequences of this layout for a write/read round trip:
 *  - a single-material mesh whose vertices are all referenced comes back with identical vertex
 *    and face order;
 *  - with several materials, faces come back grouped by material and a vertex shared by faces of
 *    different materials is duplicated (it still welds, see [MeshTopology]);
 *  - unreferenced vertices, unused materials and faces touching non-finite positions are dropped;
 *  - a textured material on a mesh without UVs is written without its texture;
 *  - materials are always exported double sided, base colour factors are clamped to 0..1.
 *
 * WebP / KTX2 textures are referenced through `EXT_texture_webp` / `KHR_texture_basisu` (declared
 * as required, since no fallback image exists). Other non PNG/JPEG image types are written as
 * they are and will be reported by validators.
 */
object GlbWriter {
    const val DEFAULT_GENERATOR = "Pocket 3D Scanner"

    private const val FLOAT = 5126
    private const val UNSIGNED_INT = 5125
    private const val ARRAY_BUFFER = 34962
    private const val ELEMENT_ARRAY_BUFFER = 34963

    /** @throws IllegalArgumentException if the mesh has out-of-range indices or exceeds the 2 GB a ByteArray can hold. */
    fun write(doc: GlbDocument): ByteArray {
        val out = ByteArrayOutputStream()
        write(doc, out)
        return out.toByteArray()
    }

    /** Writes the complete file to [out] (not closed, not flushed). */
    fun write(doc: GlbDocument, out: OutputStream) {
        val mesh = doc.mesh
        val vCount = mesh.vertexCount
        val fCount = mesh.faceCount
        val idx = mesh.indices
        val pos = mesh.positions
        for (i in idx) require(i in 0 until vCount) { "mesh index $i is out of range (vertex count $vCount)" }

        // ---- group faces by material slot (slot materials.size = faces without a valid material)
        val matCount = mesh.materials.size
        val slotOfFace = IntArray(fCount)
        val slotFaces = IntArray(matCount + 1)
        val finite = BooleanArray(vCount) { pos[3 * it].isFinite() && pos[3 * it + 1].isFinite() && pos[3 * it + 2].isFinite() }
        for (f in 0 until fCount) {
            if (!(finite[idx[3 * f]] && finite[idx[3 * f + 1]] && finite[idx[3 * f + 2]])) { slotOfFace[f] = -1; continue }
            val m = mesh.materialOfFace(f)
            val slot = if (m in 0 until matCount) m else matCount
            slotOfFace[f] = slot
            slotFaces[slot]++
        }

        val srcNormals = mesh.normals
        var computedNormals: FloatArray? = null
        fun fallbackNormals(): FloatArray {
            computedNormals?.let { return it }
            val t = MeshTopology.build(mesh)
            return computeWeldedNormals(pos, idx, t.weldOf, t.weldedCount).also { computedNormals = it }
        }

        val sections = ArrayList<ByteArray>()
        var binLength = 0L
        val bufferViews = ArrayList<JsonObject>()
        val accessors = ArrayList<JsonObject>()
        fun addView(data: ByteArray, target: Int?): Int {
            val padded = (data.size + 3) and 3.inv()
            val bytes = if (padded == data.size) data else data.copyOf(padded)
            bufferViews.add(
                buildJsonObject {
                    put("buffer", 0); put("byteOffset", binLength); put("byteLength", data.size)
                    if (target != null) put("target", target)
                },
            )
            sections.add(bytes)
            binLength += padded
            require(binLength < Int.MAX_VALUE - (1 shl 20)) { "mesh is too large for a single GLB (> 2 GB)" }
            return bufferViews.size - 1
        }
        fun floatBytes(a: FloatArray): ByteArray {
            val bb = ByteBuffer.allocate(a.size * 4).order(ByteOrder.LITTLE_ENDIAN)
            bb.asFloatBuffer().put(a)
            return bb.array()
        }
        fun addFloatAccessor(a: FloatArray, type: String, components: Int, withBounds: Boolean): Int {
            val view = addView(floatBytes(a), ARRAY_BUFFER)
            accessors.add(
                buildJsonObject {
                    put("bufferView", view); put("componentType", FLOAT); put("count", a.size / components); put("type", type)
                    if (withBounds) {
                        val mn = FloatArray(components) { Float.POSITIVE_INFINITY }
                        val mx = FloatArray(components) { Float.NEGATIVE_INFINITY }
                        for (i in a.indices) {
                            val c = i % components
                            if (a[i] < mn[c]) mn[c] = a[i]
                            if (a[i] > mx[c]) mx[c] = a[i]
                        }
                        put("min", JsonArray(mn.map { JsonPrimitive(it.toDouble()) }))
                        put("max", JsonArray(mx.map { JsonPrimitive(it.toDouble()) }))
                    }
                },
            )
            return accessors.size - 1
        }

        // ---- materials, textures, images (only for used slots)
        val hasUvs = mesh.uvs != null
        val materialsJson = ArrayList<JsonObject>()
        val texturesJson = ArrayList<JsonObject>()
        val imagesJson = ArrayList<JsonObject>()
        val pendingImages = ArrayList<TextureImage>()
        val textureOfImage = IdentityHashMap<TextureImage, Int>()
        val extensionsUsed = LinkedHashSet<String>()
        val materialOfSlot = IntArray(matCount + 1) { -1 }
        for (slot in 0..matCount) {
            if (slotFaces[slot] == 0) continue
            val material = if (slot < matCount) mesh.materials[slot] else Material("default")
            materialOfSlot[slot] = materialsJson.size
            val image = if (hasUvs) material.baseColorTexture else null
            var textureIndex = -1
            if (image != null) {
                textureIndex = textureOfImage.getOrPut(image) {
                    val imageIndex = pendingImages.size
                    pendingImages.add(image)
                    val ext = when (image.mimeType) {
                        "image/webp" -> "EXT_texture_webp"
                        "image/ktx2" -> "KHR_texture_basisu"
                        else -> null
                    }
                    texturesJson.add(
                        buildJsonObject {
                            put("sampler", 0)
                            if (ext == null) put("source", imageIndex) else {
                                extensionsUsed.add(ext)
                                put("extensions", buildJsonObject { put(ext, buildJsonObject { put("source", imageIndex) }) })
                            }
                        },
                    )
                    texturesJson.size - 1
                }
            }
            materialsJson.add(
                buildJsonObject {
                    put("name", material.name)
                    put(
                        "pbrMetallicRoughness",
                        buildJsonObject {
                            val c = material.baseColorFactor
                            put("baseColorFactor", JsonArray(List(4) { i ->
                                val v = if (c.size == 4 && c[i].isFinite()) c[i].coerceIn(0f, 1f) else 1f
                                JsonPrimitive(v.toDouble())
                            }))
                            if (textureIndex >= 0) put("baseColorTexture", buildJsonObject { put("index", textureIndex) })
                            put("metallicFactor", 0.0)
                            put("roughnessFactor", 1.0)
                        },
                    )
                    put("doubleSided", true)
                    if (material.repaired) put("extras", buildJsonObject { put("pocket3d_repaired", true) })
                },
            )
        }

        // ---- geometry: one primitive per used slot
        val primitives = ArrayList<JsonObject>()
        val localId = IntArray(vCount)
        for (slot in 0..matCount) {
            val faces = slotFaces[slot]
            if (faces == 0) continue
            java.util.Arrays.fill(localId, -1)
            for (f in 0 until fCount) {
                if (slotOfFace[f] != slot) continue
                localId[idx[3 * f]] = 0; localId[idx[3 * f + 1]] = 0; localId[idx[3 * f + 2]] = 0
            }
            var nv = 0
            for (v in 0 until vCount) if (localId[v] == 0) localId[v] = nv++
            val p = FloatArray(3 * nv)
            val n = FloatArray(3 * nv)
            val uv = if (hasUvs) FloatArray(2 * nv) else null
            val conf = if (mesh.confidence != null) FloatArray(nv) else null
            for (v in 0 until vCount) {
                val o = localId[v]
                if (o < 0) continue
                p[3 * o] = pos[3 * v]; p[3 * o + 1] = pos[3 * v + 1]; p[3 * o + 2] = pos[3 * v + 2]
                var nx = 0.0; var ny = 0.0; var nz = 0.0
                if (srcNormals != null) { nx = srcNormals[3 * v].toDouble(); ny = srcNormals[3 * v + 1].toDouble(); nz = srcNormals[3 * v + 2].toDouble() }
                var l = sqrt(nx * nx + ny * ny + nz * nz)
                if (!(l > 1e-6) || !l.isFinite()) {
                    val fb = fallbackNormals() // always unit length
                    nx = fb[3 * v].toDouble(); ny = fb[3 * v + 1].toDouble(); nz = fb[3 * v + 2].toDouble(); l = 1.0
                }
                // normals that are already unit length (within float rounding) are written bit-exactly
                if (Math.abs(l - 1.0) <= 1e-5) l = 1.0
                n[3 * o] = (nx / l).toFloat(); n[3 * o + 1] = (ny / l).toFloat(); n[3 * o + 2] = (nz / l).toFloat()
                if (uv != null) {
                    val a = mesh.uvs!![2 * v]; val b = mesh.uvs[2 * v + 1]
                    uv[2 * o] = if (a.isFinite()) a else 0f
                    uv[2 * o + 1] = if (b.isFinite()) b else 0f
                }
                if (conf != null) { val c = mesh.confidence!![v]; conf[o] = if (c.isFinite()) c else 0f }
            }
            val ib = ByteBuffer.allocate(faces * 12).order(ByteOrder.LITTLE_ENDIAN)
            for (f in 0 until fCount) {
                if (slotOfFace[f] != slot) continue
                ib.putInt(localId[idx[3 * f]]); ib.putInt(localId[idx[3 * f + 1]]); ib.putInt(localId[idx[3 * f + 2]])
            }
            val posAccessor = addFloatAccessor(p, "VEC3", 3, true)
            val normalAccessor = addFloatAccessor(n, "VEC3", 3, false)
            val uvAccessor = if (uv != null) addFloatAccessor(uv, "VEC2", 2, false) else -1
            val confAccessor = if (conf != null) addFloatAccessor(conf, "SCALAR", 1, false) else -1
            val indexView = addView(ib.array(), ELEMENT_ARRAY_BUFFER)
            accessors.add(buildJsonObject { put("bufferView", indexView); put("componentType", UNSIGNED_INT); put("count", faces * 3); put("type", "SCALAR") })
            val indexAccessor = accessors.size - 1
            primitives.add(
                buildJsonObject {
                    put(
                        "attributes",
                        buildJsonObject {
                            put("POSITION", posAccessor)
                            put("NORMAL", normalAccessor)
                            if (uvAccessor >= 0) put("TEXCOORD_0", uvAccessor)
                            if (confAccessor >= 0) put("_CONFIDENCE", confAccessor)
                        },
                    )
                    put("indices", indexAccessor)
                    put("material", materialOfSlot[slot])
                    put("mode", 4)
                },
            )
        }

        // ---- images go last in the buffer
        for (image in pendingImages) {
            val view = addView(image.bytes, null)
            imagesJson.add(buildJsonObject { put("bufferView", view); put("mimeType", image.mimeType); put("name", image.name) })
        }

        val json = buildJsonObject {
            put(
                "asset",
                buildJsonObject {
                    put("version", "2.0")
                    put("generator", doc.generator ?: DEFAULT_GENERATOR)
                    doc.extras?.let { put("extras", it) }
                },
            )
            if (extensionsUsed.isNotEmpty()) {
                put("extensionsUsed", JsonArray(extensionsUsed.map { JsonPrimitive(it) }))
                put("extensionsRequired", JsonArray(extensionsUsed.map { JsonPrimitive(it) }))
            }
            put("scene", 0)
            put("scenes", buildJsonArray { add(buildJsonObject { put("nodes", buildJsonArray { add(JsonPrimitive(0)) }) }) })
            put("nodes", buildJsonArray { add(buildJsonObject { put("name", "scan"); if (primitives.isNotEmpty()) put("mesh", 0) }) })
            if (primitives.isNotEmpty()) {
                put("meshes", buildJsonArray { add(buildJsonObject { put("name", "scan"); put("primitives", JsonArray(primitives)) }) })
                put("materials", JsonArray(materialsJson))
                put("accessors", JsonArray(accessors))
                put("bufferViews", JsonArray(bufferViews))
                put("buffers", buildJsonArray { add(buildJsonObject { put("byteLength", binLength) }) })
            }
            if (texturesJson.isNotEmpty()) {
                putSampler()
                put("textures", JsonArray(texturesJson))
                put("images", JsonArray(imagesJson))
            }
        }

        // ---- container
        val jsonRaw = json.toString().toByteArray(Charsets.UTF_8)
        val jsonPadded = (jsonRaw.size + 3) and 3.inv()
        val hasBin = binLength > 0
        val total = 12L + 8 + jsonPadded + (if (hasBin) 8 + binLength else 0)
        require(total < Int.MAX_VALUE) { "mesh is too large for a single GLB (> 2 GB)" }
        val header = ByteBuffer.allocate(20).order(ByteOrder.LITTLE_ENDIAN)
        header.putInt(0x46546C67).putInt(2).putInt(total.toInt()).putInt(jsonPadded).putInt(0x4E4F534A)
        out.write(header.array())
        out.write(jsonRaw)
        for (i in jsonRaw.size until jsonPadded) out.write(0x20)
        if (hasBin) {
            val binHeader = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN)
            binHeader.putInt(binLength.toInt()).putInt(0x004E4942)
            out.write(binHeader.array())
            for (s in sections) out.write(s)
        }
    }

    private fun JsonObjectBuilder.putSampler() {
        put(
            "samplers",
            buildJsonArray {
                add(
                    buildJsonObject {
                        put("magFilter", 9729)  // LINEAR
                        put("minFilter", 9987)  // LINEAR_MIPMAP_LINEAR
                        put("wrapS", 33071)     // CLAMP_TO_EDGE
                        put("wrapT", 33071)
                    },
                )
            },
        )
    }
}
