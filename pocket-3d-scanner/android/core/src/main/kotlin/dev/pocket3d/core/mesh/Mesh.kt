package dev.pocket3d.core.mesh

import dev.pocket3d.core.math.Vec3

/**
 * Encoded texture image, kept as the original encoded bytes (PNG/JPEG) so that exporting never
 * recompresses a texture produced by the reconstruction pipeline.
 */
class TextureImage(val mimeType: String, val bytes: ByteArray, val name: String = "texture")

/** Unlit/PBR-lite material as needed for scanned assets. */
class Material(
    val name: String,
    val baseColorTexture: TextureImage? = null,
    /** RGBA, linear, multiplied with the texture (glTF baseColorFactor). */
    val baseColorFactor: FloatArray = floatArrayOf(1f, 1f, 1f, 1f),
    /**
     * True for the synthetic material used by explicit hole repair: these faces were NOT observed
     * by any camera. Exported as a separately named material so the distinction survives export.
     */
    val repaired: Boolean = false,
)

/**
 * Indexed triangle mesh. Vertices are *render* vertices: a geometric point that lies on a UV seam
 * appears several times with identical position but different UV. Topological algorithms must
 * weld by position (see MeshTopology).
 *
 * Conventions (identical to glTF 2.0): right-handed, +Y up, counter-clockwise front faces,
 * UV origin at the top-left of the image. Units are whatever the owning document states
 * (see ScaleInfo) — a Mesh itself is unit-less.
 */
class Mesh(
    /** xyz per vertex, size 3*vertexCount. */
    val positions: FloatArray,
    /** Unit normals per vertex (size 3*vertexCount) or null. */
    val normals: FloatArray?,
    /** uv per vertex (size 2*vertexCount) or null. */
    val uvs: FloatArray?,
    /**
     * Reconstruction evidence per vertex in 0..1 (size vertexCount), or null when the producer did
     * not provide it. 0 = no photographic support (unsupported/interpolated surface), 1 = well
     * observed. Vertices created by hole repair always get 0.
     */
    val confidence: FloatArray?,
    /** Three vertex indices per triangle. */
    val indices: IntArray,
    /** Material index per triangle (size faceCount), or null meaning material 0 for all faces. */
    val faceMaterial: IntArray?,
    val materials: List<Material>,
) {
    val vertexCount: Int get() = positions.size / 3
    val faceCount: Int get() = indices.size / 3

    init {
        require(positions.size % 3 == 0) { "positions size must be a multiple of 3" }
        require(indices.size % 3 == 0) { "indices size must be a multiple of 3" }
        require(normals == null || normals.size == positions.size) { "normals size mismatch" }
        require(uvs == null || uvs.size == vertexCount * 2) { "uvs size mismatch" }
        require(confidence == null || confidence.size == vertexCount) { "confidence size mismatch" }
        require(faceMaterial == null || faceMaterial.size == faceCount) { "faceMaterial size mismatch" }
    }

    fun position(i: Int) = Vec3(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2])
    fun materialOfFace(f: Int): Int = faceMaterial?.get(f) ?: 0

    fun copy(
        positions: FloatArray = this.positions,
        normals: FloatArray? = this.normals,
        uvs: FloatArray? = this.uvs,
        confidence: FloatArray? = this.confidence,
        indices: IntArray = this.indices,
        faceMaterial: IntArray? = this.faceMaterial,
        materials: List<Material> = this.materials,
    ) = Mesh(positions, normals, uvs, confidence, indices, faceMaterial, materials)
}

/** Axis-aligned bounding box. */
data class Aabb(val min: Vec3, val max: Vec3) {
    val center: Vec3 get() = (min + max) * 0.5f
    val size: Vec3 get() = max - min
    val diagonal: Float get() = size.length()
    fun contains(p: Vec3) = p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y && p.z >= min.z && p.z <= max.z

    companion object {
        fun of(positions: FloatArray): Aabb {
            if (positions.isEmpty()) return Aabb(Vec3.ZERO, Vec3.ZERO)
            var minX = Float.POSITIVE_INFINITY; var minY = minX; var minZ = minX
            var maxX = Float.NEGATIVE_INFINITY; var maxY = maxX; var maxZ = maxX
            var i = 0
            while (i < positions.size) {
                val x = positions[i]; val y = positions[i + 1]; val z = positions[i + 2]
                if (x < minX) minX = x; if (x > maxX) maxX = x
                if (y < minY) minY = y; if (y > maxY) maxY = y
                if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
                i += 3
            }
            return Aabb(Vec3(minX, minY, minZ), Vec3(maxX, maxY, maxZ))
        }
    }
}
