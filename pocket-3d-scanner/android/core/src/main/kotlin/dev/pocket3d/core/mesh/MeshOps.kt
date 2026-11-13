package dev.pocket3d.core.mesh

import dev.pocket3d.core.math.Quat
import dev.pocket3d.core.math.Vec3
import kotlinx.serialization.Serializable
import kotlin.math.abs

/**
 * Box with arbitrary orientation: a point `p` is inside when the local coordinates
 * `rotation⁻¹ * (p - center)` are within `±halfExtents` on every axis.
 */
@Serializable
data class OrientedBox(val center: Vec3, val rotation: Quat, val halfExtents: Vec3) {
    /** World point -> box-local coordinates. */
    fun toLocal(p: Vec3): Vec3 = rotation.conjugate().rotate(p - center)

    /** Unit direction of local axis [i] (0 = x, 1 = y, 2 = z) in world space. */
    fun axis(i: Int): Vec3 = rotation.rotate(if (i == 0) Vec3.X else if (i == 1) Vec3.Y else Vec3.Z)

    fun contains(p: Vec3): Boolean {
        val l = toLocal(p)
        return abs(l.x) <= halfExtents.x && abs(l.y) <= halfExtents.y && abs(l.z) <= halfExtents.z
    }

    companion object {
        fun of(box: Aabb) = OrientedBox(box.center, Quat.IDENTITY, box.size * 0.5f)
    }
}

/** One connected piece of a mesh, see [MeshOps.components]. */
data class Component(
    /** Index in [ComponentInfo.components] (0 = largest surface area). */
    val id: Int,
    val faceCount: Int,
    val area: Float,
    val bounds: Aabb,
)

/** Connected components of a mesh, sorted by surface area (largest first). */
class ComponentInfo(
    /** Component id per face; an index into [components]. */
    val faceComponent: IntArray,
    val components: List<Component>,
) {
    val count: Int get() = components.size
}

/**
 * A closed boundary loop of the surface. This is either a hole in the scan or the outer rim of an
 * open scan (e.g. where the object met the table) — the two cannot be told apart reliably, so both
 * are reported.
 */
class Hole internal constructor(
    /** Index in the list returned by [MeshOps.findHoles] (0 = longest perimeter). */
    val index: Int,
    /**
     * Ordered loop positions, xyz per vertex (size 3 * [edgeCount]); the loop closes from the last
     * vertex back to the first. Order follows the winding of the adjacent faces, i.e. with the
     * existing surface on the left when looking at its front side.
     */
    val vertices: FloatArray,
    /** Number of edges (= number of vertices) in the loop. */
    val edgeCount: Int,
    val perimeter: Float,
    /** Edge-length weighted centroid of the loop polyline. */
    val centroid: Vec3,
    /** Approximate area: area of the loop projected onto its best-fit plane. */
    val area: Float,
    /**
     * Unit normal of the best-fit plane, pointing to the front side of a patch that would continue
     * the surrounding surface (zero vector for degenerate loops).
     */
    val normal: Vec3,
    internal val halfEdges: IntArray,
) {
    fun vertex(i: Int) = Vec3(vertices[3 * i], vertices[3 * i + 1], vertices[3 * i + 2])
}

/** Result of [MeshOps.fillHoles]. */
class HoleFillResult(
    /** The repaired mesh (the input instance itself if nothing was filled). */
    val mesh: Mesh,
    val filledHoleCount: Int,
    /** Number of faces added; they are the last [addedFaces] faces of [mesh]. */
    val addedFaces: Int,
    /** Selected holes that could not be triangulated safely and were left open. */
    val skippedHoleCount: Int,
    /** Index of the "repaired" material in `mesh.materials`, or -1 if nothing was filled. */
    val repairedMaterialIndex: Int,
)

/** Tuning for [MeshOps.simplify]. The defaults are meant for textured scans. */
@Serializable
data class SimplifyOptions(
    /**
     * Weight of the quadrics that keep open boundaries (hole rims, the outer rim of the scan) in
     * place, relative to ordinary surface error.
     */
    val boundaryWeight: Float = 10f,
    /** Weight of the quadrics that keep UV-seam curves in place. */
    val seamWeight: Float = 1f,
    /**
     * Weight of texture-space error against geometric error. With 1, sliding the texture by some
     * distance over the surface costs as much as moving the surface by that distance. 0 disables
     * the texture term (UVs still stay valid, but the texture may shift within a chart).
     */
    val uvWeight: Float = 1f,
    /** Never move or remove vertices on open boundaries. */
    val lockBoundary: Boolean = false,
    /**
     * Recompute vertex normals of the result as [MeshOps.recomputeNormals] does (only if the
     * input has normals). When false the surviving vertices keep their input normals.
     */
    val recomputeNormals: Boolean = true,
    /**
     * Largest angle allowed between a face created by a collapse and the smooth normal of the
     * *input* surface at each of its corners. Collapses beyond it are rejected (unless the input
     * face was already further off and the collapse does not make it worse). This stops shading
     * artefacts such as thin triangles standing almost perpendicular to a curved surface, and it
     * bounds how coarse a curved region can become: very low targets may then not be reached
     * ([SimplifyResult.targetReached] = false). 180 disables the check.
     */
    val maxNormalDeviationDegrees: Float = 60f,
)

/** Result of [MeshOps.simplify]. */
class SimplifyResult(
    val mesh: Mesh,
    /** Face count of [mesh]. */
    val faceCount: Int,
    val originalFaceCount: Int,
    /** False if the constraints (seams, boundaries, flips, materials) stopped the reduction early. */
    val targetReached: Boolean,
    /** Number of edge collapses performed. */
    val collapseCount: Int,
)

/** Summary numbers for the inspection screen, see [MeshOps.stats]. */
data class MeshStats(
    val vertexCount: Int,
    val faceCount: Int,
    /** Number of distinct vertex positions (render vertices welded across UV seams). */
    val weldedVertexCount: Int,
    val surfaceArea: Float,
    val bounds: Aabb,
    /** Mean / median length over the unique edges of the welded topology. */
    val meanEdgeLength: Float,
    val medianEdgeLength: Float,
    val boundaryEdgeCount: Int,
    /** Number of closed boundary loops (includes the outer rim of an open scan). */
    val holeCount: Int,
    val nonManifoldEdgeCount: Int,
    val componentCount: Int,
    val lowConfidenceThreshold: Float,
    /**
     * Fraction of the surface area whose (linearly interpolated) confidence is below
     * [lowConfidenceThreshold]; null when the mesh carries no confidence data.
     */
    val lowConfidenceAreaFraction: Float?,
    /** Fraction of the surface area covered by faces of a `repaired` material. */
    val repairedAreaFraction: Float,
)

/**
 * One-sided surface deviation, see [MeshOps.deviation]. Distances are in mesh units; the
 * `...Relative` values are divided by [diagonal].
 */
data class DeviationStats(
    val mean: Float,
    val rms: Float,
    /** 95th percentile. */
    val p95: Float,
    val max: Float,
    /** Bounding-box diagonal of the `from` mesh. */
    val diagonal: Float,
    val sampleCount: Int,
) {
    val meanRelativeToDiagonal: Float get() = if (diagonal > 0f) mean / diagonal else 0f
    val rmsRelativeToDiagonal: Float get() = if (diagonal > 0f) rms / diagonal else 0f
    val p95RelativeToDiagonal: Float get() = if (diagonal > 0f) p95 / diagonal else 0f
    val maxRelativeToDiagonal: Float get() = if (diagonal > 0f) max / diagonal else 0f
}

/**
 * Mesh editing operations. Every function is pure: the input [Mesh] is never modified and a new
 * instance is returned. Returned meshes may share *unchanged* arrays (and always share
 * [Material] / [TextureImage] objects) with the input, so treat mesh arrays as immutable.
 *
 * All operations are deterministic: identical input gives bit-identical output.
 * They are CPU-bound and can take up to seconds on large meshes — call them off the UI thread.
 */
object MeshOps {
    /** Name of the material given to faces created by [fillHoles]. */
    const val REPAIRED_MATERIAL_NAME = "Repaired (unobserved)"

    /**
     * Remove the faces where `remove[f]` is true. Vertices that are no longer referenced and
     * materials that are no longer used are dropped; `faceMaterial` is re-indexed accordingly.
     * The relative order of the remaining vertices, faces and materials is preserved.
     */
    fun removeFaces(mesh: Mesh, remove: BooleanArray): Mesh {
        require(remove.size == mesh.faceCount) { "mask size ${remove.size} != face count ${mesh.faceCount}" }
        return subMesh(mesh, BooleanArray(remove.size) { !remove[it] })
    }

    /** Keep only the faces where `keep[f]` is true; see [removeFaces]. */
    fun keepFaces(mesh: Mesh, keep: BooleanArray): Mesh = subMesh(mesh, keep)

    /** Drop unreferenced vertices and unused materials without removing any face. */
    fun compact(mesh: Mesh): Mesh = subMesh(mesh, null)

    /**
     * Apply the affine transform [m] (column-major 4x4, as in [dev.pocket3d.core.math.Mat4]; the
     * projective row is ignored). Normals are transformed with the inverse-transpose and
     * renormalised. If the determinant is negative (mirroring) the triangle winding is flipped so
     * front faces stay front faces.
     * @throws IllegalArgumentException if [m] is singular or not finite.
     */
    fun transform(mesh: Mesh, m: FloatArray): Mesh = transformImpl(mesh, m)

    /**
     * Recompute area-weighted vertex normals. Normals are accumulated over the welded topology,
     * so duplicated seam vertices get identical normals and seams do not show as shading breaks.
     *
     * Smoothing across *duplicated* vertices stops at sharp creases: faces reached only through
     * another render vertex at the same position contribute only if their normal is within
     * [creaseAngleDegrees] of every one of the vertex's own faces. This keeps, for example, the rim between a
     * cut-open surface and the repair patch closing it crisp, instead of producing blended normals
     * that face away from some of the faces they shade. Faces sharing one render vertex are always
     * smoothed together. Pass 180 to smooth across everything.
     */
    fun recomputeNormals(mesh: Mesh, creaseAngleDegrees: Float = 60f): Mesh {
        require(creaseAngleDegrees in 0f..180f) { "creaseAngleDegrees must be within 0..180" }
        val topo = MeshTopology.build(mesh)
        val cos = if (creaseAngleDegrees >= 180f) Double.NEGATIVE_INFINITY else Math.cos(Math.toRadians(creaseAngleDegrees.toDouble()))
        return mesh.copy(normals = computeWeldedNormals(mesh.positions, mesh.indices, topo.weldOf, topo.weldedCount, cos))
    }

    /**
     * Cut the mesh with the plane through [point] with normal [normal] and keep the half the
     * normal points to. Triangles crossing the plane are split; uv, normal and confidence of the
     * new vertices are interpolated linearly. Neighbouring triangles share the vertices created on
     * their common edge, so the cut is a clean open boundary (it is *not* capped — use
     * [fillHoles] for that, which marks the cap as repaired).
     *
     * Vertices on the plane count as kept, where "on" means within 1e-6 of the largest coordinate
     * magnitude (float noise), so a cut along an existing row of vertices does not leave slivers.
     * New vertices are on the plane up to float rounding.
     */
    fun clipByPlane(mesh: Mesh, point: Vec3, normal: Vec3): Mesh = clipByPlaneImpl(mesh, point, normal)

    /**
     * Crop to an oriented box.
     *  - `keepInside = true, clip = true`: exact crop; faces crossing a box side are split (six
     *    successive [clipByPlane] cuts).
     *  - `clip = false`: whole faces are kept or removed depending on whether their centroid is
     *    inside the box (kept if `keepInside`, removed otherwise).
     *  - `keepInside = false, clip = true`: **falls back to whole-face removal by centroid** (same
     *    as `clip = false`); cutting a box-shaped notch out of the surface is not implemented.
     */
    fun cropToBox(mesh: Mesh, box: OrientedBox, keepInside: Boolean = true, clip: Boolean = true): Mesh =
        cropToBoxImpl(mesh, box, keepInside, clip)

    /**
     * Connected components over the welded topology (faces are connected through shared edges,
     * also across UV seams), sorted by surface area, largest first.
     */
    fun components(mesh: Mesh): ComponentInfo = componentsImpl(mesh, MeshTopology.build(mesh))

    /**
     * Remove every component whose surface area is smaller than [minAreaFraction] times the area
     * of the **largest** component (so the largest component always survives for fractions <= 1).
     */
    fun removeSmallComponents(mesh: Mesh, minAreaFraction: Float): Mesh {
        val info = components(mesh)
        if (info.count == 0) return subMesh(mesh, null)
        val limit = info.components[0].area * minAreaFraction
        val keep = BooleanArray(mesh.faceCount) { info.components[info.faceComponent[it]].area >= limit }
        return subMesh(mesh, keep)
    }

    /** Keep only the [n] components with the largest surface area. */
    fun keepLargestComponents(mesh: Mesh, n: Int): Mesh {
        require(n >= 0) { "n must be >= 0" }
        val info = components(mesh)
        return subMesh(mesh, BooleanArray(mesh.faceCount) { info.faceComponent[it] < n })
    }

    /**
     * All closed boundary loops, sorted by perimeter (longest first; for an open scan the first
     * entry is typically the outer rim). [Hole.index] is the position in the returned list and is
     * what [fillHoles] expects.
     */
    fun findHoles(mesh: Mesh): List<Hole> = findHolesImpl(mesh, MeshTopology.build(mesh))

    /**
     * Explicit repair: close boundary loops with new triangles.
     *
     * @param holeIndices indices into [findHoles] of this same mesh; null = all holes.
     * @param maxPerimeter only loops with a perimeter up to this value are filled (use it to
     *   leave the outer rim of an open scan alone).
     *
     * Each loop is triangulated in its best-fit plane: concentric rings towards the centroid with
     * edge lengths that start at the rim's mean edge length and grow gradually inwards when the
     * loop is star-shaped around its centroid, otherwise ear clipping (no interior vertices).
     * Loops that cannot be triangulated without flipped or degenerate triangles — zero-area slits,
     * loops whose projection onto their best-fit plane crosses itself, loops with more than 20000
     * edges that are not star-shaped — are left open and counted in
     * [HoleFillResult.skippedHoleCount]. The patch spans the loop like a membrane; it does not
     * try to guess the missing shape.
     *
     * Honesty guarantees: the new faces are appended after the existing faces, the existing
     * vertices and faces are left untouched (patches use their own duplicated rim vertices), every
     * patch vertex has `confidence = 0` (if the mesh has confidence), uv (0, 0) (if the mesh has
     * UVs), and all patch faces use a dedicated material with `repaired = true` named
     * [REPAIRED_MATERIAL_NAME] (an existing repaired material is reused). That flag survives GLB
     * export and import.
     */
    fun fillHoles(
        mesh: Mesh,
        holeIndices: Set<Int>? = null,
        maxPerimeter: Float = Float.POSITIVE_INFINITY,
    ): HoleFillResult = fillHolesImpl(mesh, holeIndices, maxPerimeter)

    /**
     * Reduce the mesh to about [targetFaceCount] faces with quadric-error edge collapses
     * (Garland–Heckbert), in a texture-safe way:
     *  - vertices are only ever merged into an existing neighbour (no new positions or UVs), so
     *    every remaining vertex keeps its exact position and UV;
     *  - vertices on a UV seam only collapse along the seam, with both sides of the seam moving
     *    together, so charts never bleed into each other;
     *  - the collapse cost includes the texture-space error of the affected triangles
     *    ([SimplifyOptions.uvWeight]), plus extra quadrics that hold open boundaries and seams in
     *    place; boundary vertices only collapse along the boundary;
     *  - collapses that would flip a triangle (in 3D or in UV space), turn it more than
     *    [SimplifyOptions.maxNormalDeviationDegrees] away from the input surface, break
     *    manifoldness or change which material a surface region has are rejected. Materials
     *    (including the `repaired` flag) are passed through unchanged;
     *  - `confidence` of a merged vertex is the minimum of the vertices merged into it (never
     *    overstates evidence).
     *
     * The result has at most [targetFaceCount] faces (one less when the last collapse removes two)
     * unless constraints block further collapses, see [SimplifyResult.targetReached]. Faces that
     * are degenerate after welding are dropped.
     *
     * Cost: roughly 0.2–0.4 s per 100k input faces on a desktop JVM; working memory is about
     * 250 bytes per input vertex.
     */
    fun simplify(mesh: Mesh, targetFaceCount: Int, options: SimplifyOptions = SimplifyOptions()): SimplifyResult =
        Simplifier(mesh, options).run(targetFaceCount)

    /**
     * Statistics for display. [lowConfidenceThreshold] sets what counts as weakly supported
     * surface for [MeshStats.lowConfidenceAreaFraction].
     */
    fun stats(mesh: Mesh, lowConfidenceThreshold: Float = 0.3f): MeshStats = statsImpl(mesh, lowConfidenceThreshold)

    /**
     * One-sided surface deviation: [samples] points are drawn uniformly by area on the surface of
     * [from] and for each the distance to the closest point on the surface of [to] is measured.
     * `deviation(original, simplified)` answers "how far does the original surface lie from the
     * simplified one"; call it both ways and take the larger values for a symmetric measure.
     * Deterministic for a given [seed].
     * @param toBvh optional prebuilt BVH of [to].
     * @throws IllegalArgumentException if either mesh has no surface (no non-degenerate face).
     */
    fun deviation(from: Mesh, to: Mesh, samples: Int = 20000, seed: Long = 1, toBvh: Bvh? = null): DeviationStats =
        deviationImpl(from, to, samples, seed, toBvh)

    /** Total surface area. */
    fun surfaceArea(mesh: Mesh): Float = totalArea(mesh).toFloat()

    /**
     * Signed enclosed volume. Meaningful for closed meshes: positive when faces are wound
     * counter-clockwise seen from outside, negative when the mesh is inside-out.
     */
    fun signedVolume(mesh: Mesh): Float = signedVolumeImpl(mesh).toFloat()
}
