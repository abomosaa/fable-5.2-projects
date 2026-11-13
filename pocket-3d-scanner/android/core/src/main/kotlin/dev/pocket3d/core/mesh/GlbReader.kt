package dev.pocket3d.core.mesh

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Base64

/** The input is not a GLB 2.0 file this library can read (corrupt, truncated or using unsupported features). */
class GlbFormatException(message: String, cause: Throwable? = null) : IOException(message, cause)

/**
 * A model as stored in a GLB file.
 *
 * @property mesh all triangle geometry of the default scene, baked to world space and merged.
 * @property extras the glTF `asset.extras` object (the reconstruction pipeline stores scale and
 *   provenance metadata there); written back unchanged by [GlbWriter].
 * @property generator the glTF `asset.generator` string.
 * @property warnings human-readable notes about content that was skipped or approximated while
 *   reading (never set by the app; ignored by [GlbWriter]).
 */
class GlbDocument(
    val mesh: Mesh,
    val extras: JsonObject? = null,
    val generator: String? = null,
    val warnings: List<String> = emptyList(),
)

/**
 * Reader for binary glTF 2.0 (`.glb`).
 *
 * What is read: the default scene's node hierarchy (TRS or matrix transforms are baked into the
 * vertices; mirrored transforms flip the winding), all `TRIANGLES` primitives (indexed or not)
 * merged into one [Mesh] with per-face materials, `POSITION`, `NORMAL`, the `TEXCOORD_n` set used
 * by the base colour texture, the custom `_CONFIDENCE` scalar attribute, and per material
 * `baseColorFactor`, the base colour texture image (encoded bytes kept untouched) and
 * `extras.pocket3d_repaired`. Accessors may use any component type, `normalized`, `byteStride` and
 * offsets. Only materials referenced by geometry are kept, in order of first use; vertices not
 * referenced by any triangle are dropped.
 *
 * What is ignored: animations, skins, morph targets, cameras, lights, vertex colours, all other
 * textures and material parameters.
 *
 * What is rejected with a [GlbFormatException]: anything that is not a well-formed GLB 2.0
 * container, out-of-range indices/offsets, sparse accessors, external (non-`data:`) buffers or
 * images, required extensions that change how geometry is stored (Draco, meshopt), and files whose
 * only geometry is points/lines/strips/fans. Truncated or corrupt input never surfaces as an
 * index or cast exception.
 *
 * If some primitives lack an attribute that others have, missing normals are computed, missing
 * UVs become (0, 0) and missing confidence becomes 0 ("no evidence"), each with a warning.
 */
object GlbReader {
    /** Hard limit on merged geometry, to fail cleanly on instancing bombs instead of running out of memory. */
    const val MAX_VERTICES = 50_000_000
    private const val MAX_NODE_VISITS = 1_000_000
    private const val MAX_DEPTH = 256

    @Throws(GlbFormatException::class)
    fun read(bytes: ByteArray): GlbDocument {
        try {
            return Parser(bytes).parse()
        } catch (e: GlbFormatException) {
            throw e
        } catch (e: RuntimeException) {
            throw GlbFormatException("Malformed GLB: ${e.message ?: e.javaClass.simpleName}", e)
        } catch (e: StackOverflowError) {
            throw GlbFormatException("Malformed GLB: structure nested too deeply", e)
        }
    }

    /** Reads the stream to its end (does not close it). */
    @Throws(IOException::class)
    fun read(input: InputStream): GlbDocument = read(input.readBytes())

    @Throws(IOException::class)
    fun read(file: File): GlbDocument {
        if (file.length() > Int.MAX_VALUE - 16) throw GlbFormatException("GLB file is too large (${file.length()} bytes)")
        return read(file.readBytes())
    }

    private fun fail(msg: String): Nothing = throw GlbFormatException(msg)

    // ---- JSON helpers -------------------------------------------------------------------------

    private fun JsonObject.child(name: String): JsonElement? = this[name]?.takeUnless { it is JsonNull }

    private fun JsonObject.obj(name: String): JsonObject? =
        child(name)?.let { it as? JsonObject ?: fail("glTF property '$name' must be an object") }

    private fun JsonObject.arr(name: String): JsonArray? =
        child(name)?.let { it as? JsonArray ?: fail("glTF property '$name' must be an array") }

    private fun JsonObject.num(name: String): Double? = child(name)?.let { number(it, name) }

    private fun number(e: JsonElement, name: String): Double {
        val p = e as? JsonPrimitive
        if (p == null || p.isString) fail("glTF property '$name' must be a number")
        return p.content.toDoubleOrNull() ?: fail("glTF property '$name' must be a number")
    }

    private fun JsonObject.int(name: String): Int? = num(name)?.let {
        if (it != Math.rint(it) || it < Int.MIN_VALUE || it > Int.MAX_VALUE) fail("glTF property '$name' must be an integer, was $it")
        it.toInt()
    }

    private fun JsonObject.long(name: String): Long? = num(name)?.let {
        if (it != Math.rint(it) || Math.abs(it) > 9.0e15) fail("glTF property '$name' must be an integer, was $it")
        it.toLong()
    }

    private fun JsonObject.str(name: String): String? = child(name)?.let {
        val p = it as? JsonPrimitive
        if (p == null || !p.isString) fail("glTF property '$name' must be a string")
        p.content
    }

    private fun JsonObject.numbers(name: String, count: Int): DoubleArray? = arr(name)?.let { a ->
        if (a.size != count) fail("glTF property '$name' must have $count elements, has ${a.size}")
        DoubleArray(count) { i -> number(a[i], name).also { v -> if (!v.isFinite()) fail("glTF property '$name' is not finite") } }
    }

    private fun JsonArray.objAt(i: Int, what: String): JsonObject {
        if (i < 0 || i >= size) fail("$what index $i is out of range (count $size)")
        return this[i] as? JsonObject ?: fail("$what $i must be an object")
    }

    // ---- parser -------------------------------------------------------------------------------

    private class View(val data: ByteArray, val offset: Int, val length: Int, val stride: Int)

    private class Accessor(
        val data: ByteArray, val start: Int, val stride: Int, val count: Int,
        val componentType: Int, val normalized: Boolean, val components: Int,
    )

    private class Parser(private val bytes: ByteArray) {
        private lateinit var root: JsonObject
        private var bin: ByteArray? = null
        private var binOffset = 0
        private var binLength = 0
        private val warnings = LinkedHashSet<String>()

        private val buffersJson by lazy { root.arr("buffers") ?: JsonArray(emptyList()) }
        private val viewsJson by lazy { root.arr("bufferViews") ?: JsonArray(emptyList()) }
        private val accessorsJson by lazy { root.arr("accessors") ?: JsonArray(emptyList()) }
        private val nodesJson by lazy { root.arr("nodes") ?: JsonArray(emptyList()) }
        private val meshesJson by lazy { root.arr("meshes") ?: JsonArray(emptyList()) }
        private val materialsJson by lazy { root.arr("materials") ?: JsonArray(emptyList()) }
        private val texturesJson by lazy { root.arr("textures") ?: JsonArray(emptyList()) }
        private val imagesJson by lazy { root.arr("images") ?: JsonArray(emptyList()) }

        private val dataBuffers = HashMap<Int, ByteArray>()
        private val imageCache = HashMap<Int, TextureImage>()

        // output
        private val parts = ArrayList<Mesh>()
        private val partMaterial = ArrayList<Int>()
        private val materials = ArrayList<Material>()
        private val materialIds = HashMap<Int, Int>() // glTF material index (-1 = none) -> output index
        private var totalVertices = 0L
        private var nodeVisits = 0
        private val skippedModes = LinkedHashSet<String>()
        private var primitivesSeen = 0

        fun parse(): GlbDocument {
            readContainer()
            val asset = root.obj("asset") ?: fail("Not a glTF 2.0 file: 'asset' is missing")
            val version = asset.str("version") ?: fail("Not a glTF 2.0 file: 'asset.version' is missing")
            if (!version.startsWith("2.")) fail("Unsupported glTF version '$version' (only 2.x is supported)")
            asset.str("minVersion")?.let { if (!it.startsWith("2.0")) fail("File requires glTF $it; only 2.0 is supported") }
            root.arr("extensionsRequired")?.forEach { e ->
                val name = (e as? JsonPrimitive)?.content ?: fail("'extensionsRequired' must contain strings")
                if (!isHarmlessExtension(name)) fail("File requires the glTF extension '$name', which is not supported")
            }

            val onPath = BooleanArray(nodesJson.size)
            val identity = doubleArrayOf(1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)
            val scenes = root.arr("scenes")
            if (scenes != null && scenes.size > 0) {
                val sceneIndex = root.int("scene") ?: 0
                val scene = scenes.objAt(sceneIndex, "scene")
                scene.arr("nodes")?.forEach { visitNode(intOf(it, "scene.nodes"), identity, onPath, 0) }
            } else {
                // No scene: use every root node (a node that is nobody's child).
                val isChild = BooleanArray(nodesJson.size)
                for (i in 0 until nodesJson.size) {
                    nodesJson.objAt(i, "node").arr("children")?.forEach { c ->
                        val ci = intOf(c, "node.children")
                        if (ci in isChild.indices) isChild[ci] = true
                    }
                }
                for (i in 0 until nodesJson.size) if (!isChild[i]) visitNode(i, identity, onPath, 0)
                if (nodesJson.size == 0) for (m in 0 until meshesJson.size) addMesh(m, identity, "mesh $m")
            }

            if (parts.isEmpty() && skippedModes.isNotEmpty()) {
                fail("The file contains no triangle geometry (only ${skippedModes.joinToString()}); only TRIANGLES primitives are supported")
            }
            if (skippedModes.isNotEmpty()) warnings.add("Skipped non-triangle primitives: ${skippedModes.joinToString()}")
            return GlbDocument(merge(), asset.obj("extras"), asset.str("generator"), warnings.toList())
        }

        private fun isHarmlessExtension(name: String) =
            name.startsWith("KHR_materials_") || name == "KHR_lights_punctual" || name == "KHR_mesh_quantization" ||
                name == "KHR_xmp_json_ld" || name == "KHR_texture_transform" || name == "EXT_texture_webp" || name == "KHR_texture_basisu"

        private fun intOf(e: JsonElement, name: String): Int {
            val d = number(e, name)
            if (d != Math.rint(d) || d < Int.MIN_VALUE || d > Int.MAX_VALUE) fail("glTF property '$name' must contain integers")
            return d.toInt()
        }

        private fun readContainer() {
            if (bytes.size < 12) fail("Not a GLB file: only ${bytes.size} bytes (the header alone is 12)")
            val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
            if (bb.getInt(0) != 0x46546C67) fail("Not a GLB file: bad magic (expected 'glTF')")
            val version = bb.getInt(4)
            if (version != 2) fail("Unsupported GLB container version $version (only 2 is supported)")
            val declared = bb.getInt(8).toLong() and 0xffffffffL
            if (declared < 20) fail("Invalid GLB: declared length $declared is too small")
            if (declared > bytes.size) fail("Truncated GLB: header declares $declared bytes but only ${bytes.size} are present")
            val end = declared.toInt()
            var p = 12
            var json: String? = null
            var index = 0
            while (p < end) {
                if (end - p < 8) fail("Invalid GLB: truncated chunk header at offset $p")
                val len = bb.getInt(p).toLong() and 0xffffffffL
                val type = bb.getInt(p + 4)
                val dataStart = p + 8
                if (len > end - dataStart) fail("Invalid GLB: chunk at offset $p declares $len bytes but only ${end - dataStart} remain")
                when {
                    index == 0 -> {
                        if (type != 0x4E4F534A) fail("Invalid GLB: first chunk must be JSON")
                        var s = dataStart
                        var l = len.toInt()
                        if (l >= 3 && bytes[s] == 0xEF.toByte() && bytes[s + 1] == 0xBB.toByte() && bytes[s + 2] == 0xBF.toByte()) { s += 3; l -= 3 }
                        json = String(bytes, s, l, Charsets.UTF_8)
                    }
                    type == 0x004E4942 && bin == null -> { bin = bytes; binOffset = dataStart; binLength = len.toInt() }
                    else -> Unit // unknown chunk types must be ignored
                }
                // chunks are padded to 4 bytes; tolerate files that omit the final padding
                p = dataStart + len.toInt()
                p = minOf(end, (p + 3) and 3.inv())
                index++
            }
            if (json == null) fail("Invalid GLB: no JSON chunk")
            val element = try {
                Json.parseToJsonElement(json)
            } catch (e: IllegalArgumentException) {
                throw GlbFormatException("Invalid GLB: the JSON chunk cannot be parsed (${e.message?.lineSequence()?.firstOrNull()})", e)
            }
            root = element as? JsonObject ?: fail("Invalid GLB: the JSON chunk is not an object")
        }

        // ---- scene graph ----

        private fun visitNode(index: Int, parent: DoubleArray, onPath: BooleanArray, depth: Int) {
            val node = nodesJson.objAt(index, "node")
            if (onPath[index]) fail("Invalid glTF: node $index is its own ancestor")
            if (depth > MAX_DEPTH) fail("Invalid glTF: node hierarchy deeper than $MAX_DEPTH levels")
            if (++nodeVisits > MAX_NODE_VISITS) fail("Invalid glTF: node hierarchy has more than $MAX_NODE_VISITS node instances")
            val world = mul(parent, localMatrix(node))
            node.int("mesh")?.let { addMesh(it, world, node.str("name") ?: "node $index") }
            val children = node.arr("children")
            if (children != null && children.size > 0) {
                onPath[index] = true
                children.forEach { visitNode(intOf(it, "node.children"), world, onPath, depth + 1) }
                onPath[index] = false
            }
        }

        private fun localMatrix(node: JsonObject): DoubleArray {
            node.numbers("matrix", 16)?.let { return it }
            val t = node.numbers("translation", 3)
            val r = node.numbers("rotation", 4)
            val s = node.numbers("scale", 3)
            val m = doubleArrayOf(1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)
            if (r != null) {
                var x = r[0]; var y = r[1]; var z = r[2]; var w = r[3]
                val l = Math.sqrt(x * x + y * y + z * z + w * w)
                if (l > 0.0) { x /= l; y /= l; z /= l; w /= l } else { x = 0.0; y = 0.0; z = 0.0; w = 1.0 }
                m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y + z * w); m[2] = 2 * (x * z - y * w)
                m[4] = 2 * (x * y - z * w); m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z + x * w)
                m[8] = 2 * (x * z + y * w); m[9] = 2 * (y * z - x * w); m[10] = 1 - 2 * (x * x + y * y)
            }
            if (s != null) for (c in 0 until 3) for (row in 0 until 3) m[4 * c + row] *= s[c]
            if (t != null) { m[12] = t[0]; m[13] = t[1]; m[14] = t[2] }
            return m
        }

        private fun mul(a: DoubleArray, b: DoubleArray): DoubleArray {
            val r = DoubleArray(16)
            for (c in 0 until 4) for (row in 0 until 4) {
                var s = 0.0
                for (k in 0 until 4) s += a[k * 4 + row] * b[c * 4 + k]
                r[c * 4 + row] = s
            }
            return r
        }

        // ---- geometry ----

        private fun addMesh(meshIndex: Int, world: DoubleArray, where: String) {
            val mesh = meshesJson.objAt(meshIndex, "mesh")
            val prims = mesh.arr("primitives") ?: fail("Invalid glTF: mesh $meshIndex has no primitives")
            var identity = true
            for (i in 0 until 16) if (world[i] != (if (i % 5 == 0) 1.0 else 0.0)) identity = false
            val m = FloatArray(16) { world[it].toFloat() }
            for (pi in 0 until prims.size) {
                val prim = prims.objAt(pi, "primitive")
                primitivesSeen++
                val mode = prim.int("mode") ?: 4
                if (mode != 4) {
                    skippedModes.add(
                        when (mode) {
                            0 -> "POINTS"; 1 -> "LINES"; 2 -> "LINE_LOOP"; 3 -> "LINE_STRIP"
                            5 -> "TRIANGLE_STRIP"; 6 -> "TRIANGLE_FAN"; else -> "mode $mode"
                        },
                    )
                    continue
                }
                prim.obj("extensions")?.let { ext ->
                    for (name in ext.keys) {
                        if (name == "KHR_draco_mesh_compression" || name == "EXT_meshopt_compression") {
                            fail("Mesh $meshIndex uses '$name' compression, which is not supported")
                        }
                    }
                }
                val gltfMaterial = prim.int("material") ?: -1
                var local = readPrimitive(prim, meshIndex, pi, texCoordSetOf(gltfMaterial)) ?: continue
                if (!identity) {
                    var ok = true
                    for (v in m) if (!v.isFinite()) ok = false
                    val det = world[0] * (world[5] * world[10] - world[9] * world[6]) -
                        world[4] * (world[1] * world[10] - world[9] * world[2]) +
                        world[8] * (world[1] * world[6] - world[5] * world[2])
                    if (!ok || det == 0.0 || !det.isFinite() ||
                        m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]) == 0f
                    ) {
                        warnings.add("Skipped mesh of '$where': its transform is singular or not finite")
                        continue
                    }
                    local = try {
                        transformImpl(local, m)
                    } catch (e: IllegalArgumentException) {
                        warnings.add("Skipped mesh of '$where': its transform is singular or not finite")
                        continue
                    }
                }
                totalVertices += local.vertexCount
                if (totalVertices > MAX_VERTICES) fail("Model is too large: more than $MAX_VERTICES vertices after instancing")
                parts.add(local)
                partMaterial.add(materialFor(gltfMaterial))
            }
        }

        private fun readPrimitive(prim: JsonObject, meshIndex: Int, primIndex: Int, texCoordSet: Int): Mesh? {
            val what = "mesh $meshIndex primitive $primIndex"
            val attrs = prim.obj("attributes") ?: fail("Invalid glTF: $what has no attributes")
            val posIndex = attrs.int("POSITION")
            if (posIndex == null) {
                warnings.add("Skipped $what: it has no POSITION attribute")
                return null
            }
            val posAcc = accessor(posIndex, "$what POSITION")
            if (posAcc.components != 3) fail("Invalid glTF: $what POSITION must be VEC3")
            val positions = readFloats(posAcc)
            val vCount = posAcc.count
            for (x in positions) if (!x.isFinite()) fail("Invalid glTF: $what has non-finite vertex positions")

            fun attribute(name: String, components: Int): FloatArray? {
                val ai = attrs.int(name) ?: return null
                val acc = accessor(ai, "$what $name")
                if (acc.components != components) fail("Invalid glTF: $what $name has ${acc.components} components, expected $components")
                if (acc.count != vCount) fail("Invalid glTF: $what $name has ${acc.count} elements but POSITION has $vCount")
                return readFloats(acc)
            }
            val normals = attribute("NORMAL", 3)
            var uvs = attribute("TEXCOORD_$texCoordSet", 2)
            if (uvs == null && texCoordSet != 0) uvs = attribute("TEXCOORD_0", 2)
            val conf = attribute("_CONFIDENCE", 1)
            if (uvs != null) for (i in uvs.indices) if (!uvs[i].isFinite()) uvs[i] = 0f
            if (conf != null) for (i in conf.indices) if (!conf[i].isFinite()) conf[i] = 0f

            val indexAccessor = prim.int("indices")
            val indices: IntArray
            if (indexAccessor != null) {
                val acc = accessor(indexAccessor, "$what indices")
                if (acc.components != 1) fail("Invalid glTF: $what indices must be SCALAR")
                if (acc.componentType != 5121 && acc.componentType != 5123 && acc.componentType != 5125) {
                    fail("Invalid glTF: $what indices have component type ${acc.componentType} (must be unsigned byte/short/int)")
                }
                indices = readIndices(acc)
                for (i in indices) if (i < 0 || i >= vCount) fail("Invalid glTF: $what references vertex ${i.toLong() and 0xffffffffL} but has only $vCount vertices")
            } else {
                indices = IntArray(vCount) { it }
            }
            if (indices.size % 3 != 0) fail("Invalid glTF: $what has ${indices.size} indices, which is not a multiple of 3")
            if (indices.isEmpty()) return null
            // compact: accessors may be shared between primitives, each using a small part
            return subMesh(Mesh(positions, normals, uvs, conf, indices, null, emptyList()), null)
        }

        private fun merge(): Mesh {
            var v = 0; var f = 0
            var anyNormals = false; var anyUvs = false; var anyConf = false
            var missingNormals = false; var missingUvs = false; var missingConf = false
            for (p in parts) {
                v += p.vertexCount; f += p.faceCount
                if (p.normals != null) anyNormals = true else missingNormals = true
                if (p.uvs != null) anyUvs = true else missingUvs = true
                if (p.confidence != null) anyConf = true else missingConf = true
            }
            if (anyNormals && missingNormals) warnings.add("Some primitives have no normals; they were computed")
            if (anyUvs && missingUvs) warnings.add("Some primitives have no texture coordinates; (0, 0) was used")
            if (anyConf && missingConf) warnings.add("Some primitives have no _CONFIDENCE attribute; 0 (no evidence) was used")
            val positions = FloatArray(3 * v)
            val normals = if (anyNormals) FloatArray(3 * v) else null
            val uvs = if (anyUvs) FloatArray(2 * v) else null
            val conf = if (anyConf) FloatArray(v) else null
            val indices = IntArray(3 * f)
            val faceMaterial = IntArray(f)
            var vo = 0; var fo = 0
            for ((pi, p) in parts.withIndex()) {
                val n = p.vertexCount
                System.arraycopy(p.positions, 0, positions, 3 * vo, 3 * n)
                if (normals != null) {
                    val src = p.normals ?: MeshTopology.build(p).let { t -> computeWeldedNormals(p.positions, p.indices, t.weldOf, t.weldedCount) }
                    System.arraycopy(src, 0, normals, 3 * vo, 3 * n)
                }
                if (uvs != null && p.uvs != null) System.arraycopy(p.uvs, 0, uvs, 2 * vo, 2 * n)
                if (conf != null && p.confidence != null) System.arraycopy(p.confidence, 0, conf, vo, n)
                for (i in p.indices.indices) indices[3 * fo + i] = p.indices[i] + vo
                java.util.Arrays.fill(faceMaterial, fo, fo + p.faceCount, partMaterial[pi])
                vo += n; fo += p.faceCount
            }
            return Mesh(positions, normals, uvs, conf, indices, if (materials.size > 1) faceMaterial else null, materials)
        }

        // ---- materials ----

        /** Index n of the TEXCOORD_n set the material's base colour texture samples. */
        private fun texCoordSetOf(gltfIndex: Int): Int {
            if (gltfIndex < 0) return 0
            val set = materialsJson.objAt(gltfIndex, "material").obj("pbrMetallicRoughness")?.obj("baseColorTexture")?.int("texCoord") ?: 0
            if (set < 0) fail("Invalid glTF: material $gltfIndex has a negative texCoord")
            return set
        }

        private fun materialFor(gltfIndex: Int): Int {
            materialIds[gltfIndex]?.let { return it }
            val material: Material
            if (gltfIndex < 0) {
                material = Material("default")
            } else {
                val json = materialsJson.objAt(gltfIndex, "material")
                val pbr = json.obj("pbrMetallicRoughness")
                val factor = pbr?.numbers("baseColorFactor", 4)?.let { d -> FloatArray(4) { d[it].toFloat() } } ?: floatArrayOf(1f, 1f, 1f, 1f)
                var image: TextureImage? = null
                val texInfo = pbr?.obj("baseColorTexture")
                if (texInfo != null) {
                    val textureIndex = texInfo.int("index") ?: fail("Invalid glTF: material $gltfIndex baseColorTexture has no index")
                    image = textureImage(textureIndex)
                    if (texInfo.obj("extensions")?.containsKey("KHR_texture_transform") == true) {
                        warnings.add("Material $gltfIndex uses KHR_texture_transform, which is ignored; its texture may be misplaced")
                    }
                }
                val repaired = (json.obj("extras")?.get("pocket3d_repaired") as? JsonPrimitive)?.let { !it.isString && it.content == "true" } ?: false
                material = Material(json.str("name") ?: "material_$gltfIndex", image, factor, repaired)
            }
            val id = materials.size
            materials.add(material)
            materialIds[gltfIndex] = id
            return id
        }

        private fun textureImage(textureIndex: Int): TextureImage {
            val texture = texturesJson.objAt(textureIndex, "texture")
            val ext = texture.obj("extensions")
            val source = texture.int("source")
                ?: ext?.obj("EXT_texture_webp")?.int("source")
                ?: ext?.obj("KHR_texture_basisu")?.int("source")
                ?: fail("Invalid glTF: texture $textureIndex has no image source")
            imageCache[source]?.let { return it }
            val image = imagesJson.objAt(source, "image")
            val name = image.str("name") ?: "image_$source"
            var mime = image.str("mimeType")
            val data: ByteArray
            val viewIndex = image.int("bufferView")
            if (viewIndex != null) {
                val view = view(viewIndex, "image $source")
                data = view.data.copyOfRange(view.offset, view.offset + view.length)
            } else {
                val uri = image.str("uri") ?: fail("Invalid glTF: image $source has neither bufferView nor uri")
                if (!uri.startsWith("data:")) fail("Image $source is stored in an external file ('${uri.take(80)}'); only images embedded in the GLB are supported")
                val (m, d) = decodeDataUri(uri, "image $source")
                data = d
                if (mime == null && m.startsWith("image/")) mime = m
            }
            val result = TextureImage(mime ?: sniffMime(data), data, name)
            imageCache[source] = result
            return result
        }

        private fun sniffMime(d: ByteArray): String = when {
            d.size >= 8 && d[0] == 0x89.toByte() && d[1] == 'P'.code.toByte() && d[2] == 'N'.code.toByte() && d[3] == 'G'.code.toByte() -> "image/png"
            d.size >= 3 && d[0] == 0xFF.toByte() && d[1] == 0xD8.toByte() && d[2] == 0xFF.toByte() -> "image/jpeg"
            d.size >= 12 && d[0] == 'R'.code.toByte() && d[1] == 'I'.code.toByte() && d[8] == 'W'.code.toByte() && d[9] == 'E'.code.toByte() -> "image/webp"
            d.size >= 12 && d[0] == 0xAB.toByte() && d[1] == 'K'.code.toByte() && d[2] == 'T'.code.toByte() && d[3] == 'X'.code.toByte() -> "image/ktx2"
            else -> "application/octet-stream"
        }

        private fun decodeDataUri(uri: String, what: String): Pair<String, ByteArray> {
            val comma = uri.indexOf(',')
            if (comma < 0) fail("Invalid glTF: $what has a malformed data URI")
            val meta = uri.substring(5, comma)
            if (!meta.endsWith(";base64")) fail("Invalid glTF: $what uses a data URI that is not base64 encoded")
            val bytes = try {
                Base64.getDecoder().decode(uri.substring(comma + 1))
            } catch (e: IllegalArgumentException) {
                throw GlbFormatException("Invalid glTF: $what contains invalid base64 data", e)
            }
            return Pair(meta.removeSuffix(";base64"), bytes)
        }

        // ---- binary access ----

        private fun view(index: Int, what: String): View {
            val json = viewsJson.objAt(index, "bufferView")
            val bufferIndex = json.int("buffer") ?: fail("Invalid glTF: bufferView $index has no buffer")
            val bufferJson = buffersJson.objAt(bufferIndex, "buffer")
            val data: ByteArray
            val base: Int
            val size: Long
            val uri = bufferJson.str("uri")
            val declared = bufferJson.long("byteLength") ?: fail("Invalid glTF: buffer $bufferIndex has no byteLength")
            if (uri == null) {
                if (bufferIndex != 0) fail("Invalid glTF: buffer $bufferIndex has no uri but is not the first buffer")
                data = bin ?: fail("Invalid GLB: $what needs the binary chunk, but the file has none")
                base = binOffset
                if (declared < 0 || declared > binLength) fail("Invalid GLB: buffer 0 declares $declared bytes but the binary chunk has $binLength")
                size = declared
            } else {
                if (!uri.startsWith("data:")) fail("Buffer $bufferIndex is stored in an external file ('${uri.take(80)}'); only self-contained GLB files are supported")
                data = dataBuffers.getOrPut(bufferIndex) { decodeDataUri(uri, "buffer $bufferIndex").second }
                base = 0
                size = minOf(declared, data.size.toLong())
                if (declared > data.size) fail("Invalid glTF: buffer $bufferIndex declares $declared bytes but its data URI holds ${data.size}")
            }
            val offset = json.long("byteOffset") ?: 0L
            val length = json.long("byteLength") ?: fail("Invalid glTF: bufferView $index has no byteLength")
            val stride = json.int("byteStride") ?: 0
            if (offset < 0 || length < 0 || offset + length > size) {
                fail("Invalid GLB: bufferView $index (offset $offset, length $length) exceeds its buffer of $size bytes; the file may be truncated")
            }
            if (stride < 0 || stride > 4096) fail("Invalid glTF: bufferView $index has byteStride $stride")
            return View(data, base + offset.toInt(), length.toInt(), stride)
        }

        private fun accessor(index: Int, what: String): Accessor {
            val json = accessorsJson.objAt(index, "accessor")
            if (json.child("sparse") != null) fail("Unsupported glTF feature: $what uses a sparse accessor")
            val viewIndex = json.int("bufferView") ?: fail("Invalid glTF: $what (accessor $index) has no bufferView")
            val view = view(viewIndex, what)
            val componentType = json.int("componentType") ?: fail("Invalid glTF: accessor $index has no componentType")
            val componentSize = when (componentType) {
                5120, 5121 -> 1
                5122, 5123 -> 2
                5125, 5126 -> 4
                else -> fail("Invalid glTF: accessor $index has unknown componentType $componentType")
            }
            val type = json.str("type") ?: fail("Invalid glTF: accessor $index has no type")
            val components = when (type) {
                "SCALAR" -> 1; "VEC2" -> 2; "VEC3" -> 3; "VEC4" -> 4; "MAT2" -> 4; "MAT3" -> 9; "MAT4" -> 16
                else -> fail("Invalid glTF: accessor $index has unknown type '$type'")
            }
            val count = json.long("count") ?: fail("Invalid glTF: accessor $index has no count")
            val offset = json.long("byteOffset") ?: 0L
            val elementSize = components * componentSize
            val stride = if (view.stride != 0) view.stride else elementSize
            if (stride < elementSize) fail("Invalid glTF: accessor $index has byteStride $stride smaller than its element size $elementSize")
            if (count < 0 || offset < 0) fail("Invalid glTF: accessor $index has a negative count or offset")
            if (count > MAX_VERTICES * 6L) fail("Model is too large: accessor $index has $count elements")
            val needed = if (count == 0L) 0L else offset + stride.toLong() * (count - 1) + elementSize
            if (needed > view.length) {
                fail("Invalid GLB: $what (accessor $index) needs $needed bytes but its bufferView has ${view.length}; the file may be truncated")
            }
            val normalized = (json.child("normalized") as? JsonPrimitive)?.content == "true"
            return Accessor(view.data, view.offset + offset.toInt(), stride, count.toInt(), componentType, normalized, components)
        }

        private fun readFloats(a: Accessor): FloatArray {
            val n = a.components
            val total = a.count.toLong() * n
            if (total > Int.MAX_VALUE - 16) fail("Model is too large")
            val out = FloatArray(total.toInt())
            val bb = ByteBuffer.wrap(a.data).order(ByteOrder.LITTLE_ENDIAN)
            var o = 0
            for (i in 0 until a.count) {
                val p = a.start + i * a.stride
                when (a.componentType) {
                    5126 -> for (c in 0 until n) out[o++] = bb.getFloat(p + 4 * c)
                    5121 -> for (c in 0 until n) { val v = a.data[p + c].toInt() and 0xff; out[o++] = if (a.normalized) v / 255f else v.toFloat() }
                    5123 -> for (c in 0 until n) { val v = bb.getShort(p + 2 * c).toInt() and 0xffff; out[o++] = if (a.normalized) v / 65535f else v.toFloat() }
                    5120 -> for (c in 0 until n) { val v = a.data[p + c].toInt(); out[o++] = if (a.normalized) maxOf(v / 127f, -1f) else v.toFloat() }
                    5122 -> for (c in 0 until n) { val v = bb.getShort(p + 2 * c).toInt(); out[o++] = if (a.normalized) maxOf(v / 32767f, -1f) else v.toFloat() }
                    else -> for (c in 0 until n) { val v = bb.getInt(p + 4 * c).toLong() and 0xffffffffL; out[o++] = if (a.normalized) (v / 4294967295.0).toFloat() else v.toFloat() }
                }
            }
            return out
        }

        private fun readIndices(a: Accessor): IntArray {
            val out = IntArray(a.count)
            val bb = ByteBuffer.wrap(a.data).order(ByteOrder.LITTLE_ENDIAN)
            for (i in 0 until a.count) {
                val p = a.start + i * a.stride
                out[i] = when (a.componentType) {
                    5121 -> a.data[p].toInt() and 0xff
                    5123 -> bb.getShort(p).toInt() and 0xffff
                    else -> bb.getInt(p) // values >= 2^31 become negative and are rejected by the range check
                }
            }
            return out
        }
    }
}
