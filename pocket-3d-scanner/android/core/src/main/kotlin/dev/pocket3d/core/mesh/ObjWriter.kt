package dev.pocket3d.core.mesh

import java.util.IdentityHashMap

/**
 * Wavefront OBJ export (with MTL and texture files).
 *
 * Conventions:
 *  - Coordinates are written unchanged (right-handed, +Y up, same units as the mesh); faces keep
 *    their counter-clockwise winding.
 *  - Texture coordinates: OBJ puts the V origin at the *bottom*-left of the image while [Mesh]
 *    (like glTF) uses the top-left, so every `vt` is written as `(u, 1 - v)`.
 *  - One `v` (and `vt` / `vn` when present) per mesh vertex, in mesh order, so OBJ index
 *    `i + 1` is mesh vertex `i`; faces are written as `f v/vt/vn` with equal indices.
 *  - Faces are grouped by material, in material order: each used material gets `g <name>` and
 *    `usemtl <name>`. Material names are made OBJ-safe (whitespace -> `_`) and unique.
 *  - The MTL file defines `Kd` / `d` from the base colour factor and `map_Kd` for the texture.
 *    Texture files are written with their original encoded bytes as `<baseName>_<n>.<ext>`.
 *  - Faces created by hole repair stay identifiable: their material keeps its own group and
 *    name, and its MTL entry carries the comment `# pocket3d_repaired`.
 *  - OBJ has no per-vertex scalar channel: `confidence` is **not** exported (use GLB or PLY).
 *  - Numbers are written in plain decimal notation (no exponents) with full float precision.
 */
object ObjWriter {
    /**
     * @param baseName file name stem, without directory or extension.
     * @return file name -> content: `<baseName>.obj`, `<baseName>.mtl` and one file per distinct texture.
     */
    fun write(mesh: Mesh, baseName: String): Map<String, ByteArray> {
        require(baseName.isNotEmpty() && baseName.none { it == '/' || it == '\\' || it.isISOControl() } && baseName.trim() == baseName) {
            "baseName must be a plain file name stem"
        }
        val files = LinkedHashMap<String, ByteArray>()
        val vCount = mesh.vertexCount
        val fCount = mesh.faceCount
        val matCount = mesh.materials.size

        // faces per material slot; slot matCount collects faces without a valid material
        val slotFaces = IntArray(matCount + 1)
        for (f in 0 until fCount) {
            val m = mesh.materialOfFace(f)
            slotFaces[if (m in 0 until matCount) m else matCount]++
        }

        // unique, OBJ-safe material names and texture file names
        val names = arrayOfNulls<String>(matCount + 1)
        val usedNames = HashSet<String>()
        val textureFile = IdentityHashMap<TextureImage, String>()
        val mtl = StringBuilder()
        mtl.append("# Pocket 3D Scanner\n")
        for (slot in 0..matCount) {
            if (slotFaces[slot] == 0) continue
            val material = if (slot < matCount) mesh.materials[slot] else Material("default")
            var name = material.name.trim().replace(Regex("[\\s\\p{Cntrl}]+"), "_").ifEmpty { "material" }
            if (!usedNames.add(name)) {
                var k = 2
                while (!usedNames.add("${name}_$k")) k++
                name = "${name}_$k"
            }
            names[slot] = name
            mtl.append("\nnewmtl ").append(name).append('\n')
            if (material.repaired) mtl.append("# pocket3d_repaired\n")
            val c = material.baseColorFactor
            fun channel(i: Int) = if (c.size == 4 && c[i].isFinite()) c[i].coerceIn(0f, 1f) else 1f
            mtl.append("Ka 0 0 0\nKd ").appendNumber(channel(0)).append(' ').appendNumber(channel(1)).append(' ').appendNumber(channel(2)).append('\n')
            mtl.append("Ks 0 0 0\nd ").appendNumber(channel(3)).append("\nillum 1\n")
            val image = material.baseColorTexture
            if (image != null && mesh.uvs != null) {
                val file = textureFile.getOrPut(image) {
                    val ext = when (image.mimeType) {
                        "image/png" -> "png"; "image/jpeg" -> "jpg"; "image/webp" -> "webp"; "image/ktx2" -> "ktx2"
                        else -> "bin"
                    }
                    "${baseName}_${textureFile.size}.$ext"
                }
                mtl.append("map_Kd ").append(file).append('\n')
            }
        }

        val sb = StringBuilder(64 * vCount + 48 * fCount + 256)
        sb.append("# Pocket 3D Scanner\n# vertices: ").append(vCount).append(", faces: ").append(fCount).append('\n')
        sb.append("mtllib ").append(baseName).append(".mtl\n")
        val p = mesh.positions
        for (v in 0 until vCount) {
            sb.append("v ").appendNumber(p[3 * v]).append(' ').appendNumber(p[3 * v + 1]).append(' ').appendNumber(p[3 * v + 2]).append('\n')
        }
        val uv = mesh.uvs
        if (uv != null) for (v in 0 until vCount) {
            sb.append("vt ").appendNumber(uv[2 * v]).append(' ').appendNumber(1f - uv[2 * v + 1]).append('\n')
        }
        val n = mesh.normals
        if (n != null) for (v in 0 until vCount) {
            sb.append("vn ").appendNumber(n[3 * v]).append(' ').appendNumber(n[3 * v + 1]).append(' ').appendNumber(n[3 * v + 2]).append('\n')
        }
        val idx = mesh.indices
        for (slot in 0..matCount) {
            if (slotFaces[slot] == 0) continue
            sb.append("g ").append(names[slot]).append("\nusemtl ").append(names[slot]).append('\n')
            for (f in 0 until fCount) {
                val m = mesh.materialOfFace(f)
                if ((if (m in 0 until matCount) m else matCount) != slot) continue
                sb.append('f')
                for (k in 0 until 3) {
                    val i = idx[3 * f + k] + 1
                    sb.append(' ').append(i)
                    if (uv != null) sb.append('/').append(i)
                    if (n != null) { if (uv == null) sb.append('/'); sb.append('/').append(i) }
                }
                sb.append('\n')
            }
        }
        files["$baseName.obj"] = sb.toString().toByteArray(Charsets.US_ASCII)
        files["$baseName.mtl"] = mtl.toString().toByteArray(Charsets.UTF_8)
        for ((image, file) in textureFile) files[file] = image.bytes
        return files
    }

    /** Shortest exact decimal representation without exponent; non-finite values become 0. */
    private fun StringBuilder.appendNumber(f: Float): StringBuilder {
        if (!f.isFinite()) return append('0')
        if (f == 0f) return append('0')
        val s = f.toString()
        if (s.indexOf('E') < 0) return append(if (s.endsWith(".0")) s.substring(0, s.length - 2) else s)
        return append(java.math.BigDecimal(s).toPlainString())
    }
}
