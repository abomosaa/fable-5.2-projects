package dev.pocket3d.core.mesh

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Stanford PLY export, `binary_little_endian 1.0`.
 *
 * Vertex element (all `float`, one row per mesh vertex in mesh order):
 *  - `x y z` — position, unchanged (right-handed, +Y up, mesh units);
 *  - `nx ny nz` — only if the mesh has normals;
 *  - `s t` — only if the mesh has UVs. Like OBJ (and as MeshLab / Blender expect), PLY texture
 *    coordinates have their origin at the *bottom*-left, so `s = u`, `t = 1 - v`;
 *  - `confidence` — only if the mesh has confidence (0 = unobserved, 1 = well observed).
 *
 * Face element: `property list uchar int vertex_indices` (always 3 indices, counter-clockwise),
 * plus — only when the mesh contains faces of a repaired material — `property uchar repaired`
 * (1 for faces created by hole repair, else 0) so that the distinction survives this format too.
 *
 * PLY carries no materials or textures: a textured mesh keeps its UVs but the image itself is not
 * part of the file (export GLB or OBJ for that).
 */
object PlyWriter {
    /**
     * @param comments extra header `comment` lines (e.g. the unit statement); line breaks and
     *        non-ASCII characters are replaced so the header stays valid.
     */
    fun write(mesh: Mesh, comments: List<String> = emptyList()): ByteArray {
        val vCount = mesh.vertexCount
        val fCount = mesh.faceCount
        val normals = mesh.normals
        val uvs = mesh.uvs
        val conf = mesh.confidence
        val repairedMaterial = BooleanArray(mesh.materials.size) { mesh.materials[it].repaired }
        var anyRepaired = false
        if (repairedMaterial.any { it }) {
            for (f in 0 until fCount) {
                val m = mesh.materialOfFace(f)
                if (m in repairedMaterial.indices && repairedMaterial[m]) { anyRepaired = true; break }
            }
        }
        val header = buildString {
            append("ply\nformat binary_little_endian 1.0\ncomment Pocket 3D Scanner\n")
            for (c in comments) {
                append("comment ").append(c.map { ch -> if (ch in ' '..'~') ch else ' ' }.joinToString("").trim().take(200)).append('\n')
            }
            if (uvs != null) append("comment texture coordinates: s = u, t = 1 - v (origin bottom-left)\n")
            append("element vertex ").append(vCount).append('\n')
            append("property float x\nproperty float y\nproperty float z\n")
            if (normals != null) append("property float nx\nproperty float ny\nproperty float nz\n")
            if (uvs != null) append("property float s\nproperty float t\n")
            if (conf != null) append("property float confidence\n")
            append("element face ").append(fCount).append('\n')
            append("property list uchar int vertex_indices\n")
            if (anyRepaired) append("property uchar repaired\n")
            append("end_header\n")
        }.toByteArray(Charsets.US_ASCII)
        val vertexSize = 12 + (if (normals != null) 12 else 0) + (if (uvs != null) 8 else 0) + (if (conf != null) 4 else 0)
        val faceSize = 13 + (if (anyRepaired) 1 else 0)
        val total = header.size.toLong() + vertexSize.toLong() * vCount + faceSize.toLong() * fCount
        require(total < Int.MAX_VALUE - 16) { "mesh is too large for a single PLY (> 2 GB)" }
        val bb = ByteBuffer.allocate(total.toInt()).order(ByteOrder.LITTLE_ENDIAN)
        bb.put(header)
        val p = mesh.positions
        for (v in 0 until vCount) {
            bb.putFloat(p[3 * v]); bb.putFloat(p[3 * v + 1]); bb.putFloat(p[3 * v + 2])
            if (normals != null) { bb.putFloat(normals[3 * v]); bb.putFloat(normals[3 * v + 1]); bb.putFloat(normals[3 * v + 2]) }
            if (uvs != null) { bb.putFloat(uvs[2 * v]); bb.putFloat(1f - uvs[2 * v + 1]) }
            if (conf != null) bb.putFloat(conf[v])
        }
        val idx = mesh.indices
        for (f in 0 until fCount) {
            bb.put(3)
            bb.putInt(idx[3 * f]); bb.putInt(idx[3 * f + 1]); bb.putInt(idx[3 * f + 2])
            if (anyRepaired) {
                val m = mesh.materialOfFace(f)
                bb.put(if (m in repairedMaterial.indices && repairedMaterial[m]) 1 else 0)
            }
        }
        return bb.array()
    }
}
