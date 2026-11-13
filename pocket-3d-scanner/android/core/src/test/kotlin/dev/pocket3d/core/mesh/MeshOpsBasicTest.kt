package dev.pocket3d.core.mesh

import dev.pocket3d.core.math.Mat4
import dev.pocket3d.core.math.Quat
import dev.pocket3d.core.math.Vec3
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs

class MeshOpsBasicTest {
    private fun snapshot(m: Mesh) = listOf(m.positions.copyOf(), m.normals?.copyOf(), m.uvs?.copyOf(), m.confidence?.copyOf())
    private fun assertUnchanged(m: Mesh, snap: List<FloatArray?>, idx: IntArray) {
        assertArrayEquals(snap[0], m.positions, 0f); assertArrayEquals(snap[1], m.normals, 0f)
        assertArrayEquals(snap[2], m.uvs, 0f); assertArrayEquals(snap[3], m.confidence, 0f)
        assertArrayEquals(idx, m.indices)
    }

    @Test fun removeFacesCompactsVerticesAndMaterials() {
        val a = Fixtures.planeGrid(2, 2, material = Fixtures.texturedMaterial("a"))
        val b = Fixtures.translate(Fixtures.planeGrid(2, 2, material = Material("b")), Vec3(5f, 0f, 0f))
        val c = Fixtures.translate(Fixtures.planeGrid(2, 2, material = Material("c", repaired = true)), Vec3(10f, 0f, 0f))
        val m = Fixtures.merge(a, b, c)
        val snap = snapshot(m); val idx = m.indices.copyOf()
        // remove all of b, and all of a except its first face
        val remove = BooleanArray(m.faceCount) { f -> (f in 1 until a.faceCount) || m.materialOfFace(f) == 1 }
        val r = MeshOps.removeFaces(m, remove)
        assertUnchanged(m, snap, idx)

        assertEquals(1 + c.faceCount, r.faceCount)
        assertEquals(3 + c.vertexCount, r.vertexCount)
        assertEquals(listOf("a", "c"), r.materials.map { it.name })
        assertSame(m.materials[0], r.materials[0])
        assertTrue(r.materials[1].repaired)
        assertEquals(0, r.materialOfFace(0))
        for (f in 1 until r.faceCount) assertEquals(1, r.materialOfFace(f))
        // attributes follow their vertices
        for (k in 0 until 3) {
            val src = m.indices[k]; val dst = r.indices[k]
            assertEquals(m.position(src), r.position(dst))
            assertEquals(m.uvs!![2 * src], r.uvs!![2 * dst], 0f)
            assertEquals(m.confidence!![src], r.confidence!![dst], 0f)
            assertEquals(m.normals!![3 * src + 1], r.normals!![3 * dst + 1], 0f)
        }
        // every vertex is referenced
        assertEquals(r.vertexCount, r.indices.toSet().size)

        val kept = MeshOps.keepFaces(m, BooleanArray(m.faceCount) { !remove[it] })
        assertArrayEquals(r.positions, kept.positions, 0f); assertArrayEquals(r.indices, kept.indices)
        assertThrows(IllegalArgumentException::class.java) { MeshOps.removeFaces(m, BooleanArray(3)) }
    }

    @Test fun removeAllFacesGivesEmptyMesh() {
        val m = Fixtures.uvSphere(1f, 8, 4)
        val r = MeshOps.removeFaces(m, BooleanArray(m.faceCount) { true })
        assertEquals(0, r.faceCount); assertEquals(0, r.vertexCount); assertEquals(0, r.materials.size)
        assertEquals(0, MeshOps.stats(r).componentCount)
    }

    @Test fun transformRigidAndUniformScale() {
        val m = Fixtures.uvSphere(1f, 24, 12)
        val snap = snapshot(m); val idx = m.indices.copyOf()
        val q = Quat.axisAngle(Vec3(1f, 2f, 3f), 0.7f)
        val t = Vec3(3f, -2f, 5f)
        val r = MeshOps.transform(m, Mat4.trs(t, q, 2f))
        assertUnchanged(m, snap, idx)
        assertSame(m.indices, r.indices) // no flip needed
        assertEquals(8 * MeshOps.signedVolume(m), MeshOps.signedVolume(r), 0.05f)
        for (v in 0 until m.vertexCount) {
            val expected = q.rotate(m.position(v) * 2f) + t
            assertTrue(expected.distanceTo(r.position(v)) < 1e-5f)
            val n = Vec3.of(r.normals!!, 3 * v)
            assertEquals(1f, n.length(), 1e-5f)
            assertTrue(n.distanceTo(q.rotate(Vec3.of(m.normals!!, 3 * v))) < 1e-5f)
        }
    }

    @Test fun mirrorFlipsWindingAndKeepsNormalsOutward() {
        val m = Fixtures.uvSphere(1f, 24, 12)
        val mirror = Mat4.identity().also { it[0] = -1f; it[12] = 4f } // x -> 4 - x
        val r = MeshOps.transform(m, mirror)
        val centre = Vec3(4f, 0f, 0f)
        assertEquals(MeshOps.signedVolume(m), MeshOps.signedVolume(r), 1e-4f)
        assertTrue(MeshOps.signedVolume(r) > 0f)
        for (f in 0 until r.faceCount) {
            val out = Fixtures.centroid(r, f) - centre
            assertTrue("face normal must point outward", Fixtures.faceNormal(r, f).dot(out) > 0f)
            for (k in 0 until 3) {
                val v = r.indices[3 * f + k]
                assertTrue("vertex normal must point outward", Vec3.of(r.normals!!, 3 * v).dot(r.position(v) - centre) > 0.99f)
            }
        }
        // mirrored twice = original
        val back = MeshOps.transform(r, mirror)
        assertArrayEquals(m.indices, back.indices)
        assertArrayEquals(m.positions, back.positions, 1e-6f)
    }

    @Test fun nonUniformScaleUsesInverseTranspose() {
        val m = Fixtures.uvSphere(1f, 32, 16)
        val a = 2f; val b = 1f; val c = 0.5f
        val s = Mat4.identity().also { it[0] = a; it[5] = b; it[10] = c }
        val r = MeshOps.transform(m, s)
        for (v in 0 until r.vertexCount) {
            val p = r.position(v)
            // gradient of x^2/a^2 + y^2/b^2 + z^2/c^2
            val expected = Vec3(p.x / (a * a), p.y / (b * b), p.z / (c * c)).normalized()
            assertTrue(expected.distanceTo(Vec3.of(r.normals!!, 3 * v)) < 1e-4f)
        }
        assertEquals(MeshOps.signedVolume(m) * a * b * c, MeshOps.signedVolume(r), 1e-4f)
        // mirrored non-uniform scale: normals still outward
        val r2 = MeshOps.transform(m, Mat4.identity().also { it[0] = a; it[5] = -b; it[10] = c })
        assertTrue(MeshOps.signedVolume(r2) > 0f)
        for (v in 0 until r2.vertexCount) {
            val p = r2.position(v)
            assertTrue(Vec3(p.x / (a * a), p.y / (b * b), p.z / (c * c)).normalized().distanceTo(Vec3.of(r2.normals!!, 3 * v)) < 1e-4f)
        }
    }

    @Test fun transformRejectsSingularMatrix() {
        val m = Fixtures.planeGrid(2, 2)
        assertThrows(IllegalArgumentException::class.java) { MeshOps.transform(m, Mat4.identity().also { it[5] = 0f }) }
        assertThrows(IllegalArgumentException::class.java) { MeshOps.transform(m, Mat4.identity().also { it[12] = Float.NaN }) }
    }

    @Test fun recomputedNormalsAreSmoothAcrossSeams() {
        val src = Fixtures.uvSphere(1f, 32, 16)
        val m = MeshOps.recomputeNormals(src.copy(normals = null))
        val t = MeshTopology.build(m)
        for (v in 0 until m.vertexCount) {
            val n = Vec3.of(m.normals!!, 3 * v)
            assertEquals(1f, n.length(), 1e-5f)
            // on a sphere the smooth normal is the radial direction
            assertTrue("normal deviates at vertex $v", n.dot(m.position(v).normalized()) > 0.995f)
            // seam duplicates get bit-identical normals
            val r = t.weldedRepresentative[t.weldOf[v]]
            assertEquals(Vec3.of(m.normals!!, 3 * r), n)
        }
        assertNotSame(src.normals, m.normals)
    }

    @Test fun recomputedNormalsAreAreaWeighted() {
        // a big face in the XZ plane and a tiny face in the XY plane share an edge
        val m = Mesh(
            floatArrayOf(0f, 0f, 0f, 1f, 0f, 0f, 0f, 0f, -10f, 0f, 0.1f, 0f),
            null, null, null, intArrayOf(0, 1, 2, 0, 3, 1), null, emptyList(),
        )
        val n = Vec3.of(MeshOps.recomputeNormals(m).normals!!, 0)
        // areas: 5 (normal +Y) and 0.05 (normal -Z)
        val expected = (Vec3(0f, 1f, 0f) * 5f + Vec3(0f, 0f, -1f) * 0.05f).normalized()
        assertTrue(expected.distanceTo(n) < 1e-5f)
    }

    /** Smallest cosine between any face normal and the vertex normals at its corners. */
    private fun worstNormalAgreement(m: Mesh): Float {
        var worst = 1f
        for (f in 0 until m.faceCount) {
            val fnrm = Fixtures.faceNormal(m, f).normalized()
            for (k in 0 until 3) worst = minOf(worst, fnrm.dot(Vec3.of(m.normals!!, 3 * m.indices[3 * f + k])))
        }
        return worst
    }

    @Test fun normalsAreNotBlendedAcrossSharpCreasesBetweenDuplicatedVertices() {
        // The part of a sphere above the plane at height 0.2, capped from below: the cap faces -n
        // and meets the wall at acos(-0.2) = 101.5 degrees all around the rim; it has its own
        // (duplicated) rim vertices.
        val n = Vec3(0.2f, 1f, 0.6f).normalized()
        val cut = MeshOps.clipByPlane(Fixtures.uvSphere(1f, 48, 24), n * 0.2f, n)
        val capped = MeshOps.fillHoles(cut).mesh
        val m = MeshOps.recomputeNormals(capped.copy(normals = null))
        for (f in 0 until m.faceCount) {
            // cap vertices get exactly the cap normal, wall vertices stay radial: nothing is blended over the crease
            val repaired = m.materials[m.materialOfFace(f)].repaired
            for (k in 0 until 3) {
                val v = m.indices[3 * f + k]
                val vn = Vec3.of(m.normals!!, 3 * v)
                if (repaired) assertTrue("cap normal ${vn.dot(-n)}", vn.dot(-n) > 0.9999f)
                else assertTrue("wall normal ${vn.dot(m.position(v).normalized())}", vn.dot(m.position(v).normalized()) > 0.99f)
            }
        }
        val crisp = worstNormalAgreement(m)
        assertTrue("crease-aware agreement $crisp", crisp > 0.97f)
        // with the crease limit lifted everything at the rim is blended: normals lean far away from their faces
        val blended = worstNormalAgreement(MeshOps.recomputeNormals(capped, 180f))
        assertTrue("expected visible blending without the crease limit, got $blended", blended < 0.9f)
        assertThrows(IllegalArgumentException::class.java) { MeshOps.recomputeNormals(capped, 200f) }
    }

    @Test fun vertexNormalsNeverFaceAwayFromTheirFacesAtAnAcuteCappedCut() {
        // A torus cut by an oblique plane and capped: around each rim the angle between cap and
        // wall varies from acute to obtuse. Blending over the acute part used to give wall
        // vertices normals pointing away from the faces they shade, most visibly after
        // simplification, when the flat caps consist of a few large (heavily weighted) triangles.
        val t = Fixtures.torus(1f, 0.4f, 96, 48)
        val capped = MeshOps.fillHoles(MeshOps.clipByPlane(t, Vec3(0.3f, 0f, 0f), Vec3(-1f, 0.2f, 0.1f))).mesh
        assertEquals(0, MeshTopology.build(capped).boundaryEdgeCount)
        val simplified = MeshOps.simplify(capped, capped.faceCount / 5).mesh // recomputes normals
        // On the dense mesh a blended normal stays within the 60 degree crease angle of every face (cos 60 = 0.5).
        val dense = worstNormalAgreement(MeshOps.recomputeNormals(capped))
        assertTrue("dense mesh: worst agreement $dense", dense > 0.5f)
        // On the coarse mesh the faces around one vertex differ more among themselves; still clearly front-facing.
        val coarse = worstNormalAgreement(simplified)
        assertTrue("simplified mesh: worst agreement $coarse", coarse > 0.3f)
        assertEquals(coarse, worstNormalAgreement(MeshOps.recomputeNormals(simplified)), 0f)
        // the regression itself: unlimited smoothing of the simplified mesh produces back-facing normals
        assertTrue(worstNormalAgreement(MeshOps.recomputeNormals(simplified, 180f)) < 0f)
        assertTrue(worstNormalAgreement(MeshOps.recomputeNormals(capped, 180f)) <= dense)
    }

    @Test fun smoothSeamsStaySmoothWithACreaseOnTheSameMesh() {
        // torus: two crossing UV seams, everything smooth -> all duplicates still share one normal
        val m = MeshOps.recomputeNormals(Fixtures.torus(1f, 0.4f, 24, 12).copy(normals = null))
        val t = MeshTopology.build(m)
        val src = Fixtures.torus(1f, 0.4f, 24, 12)
        for (v in 0 until m.vertexCount) {
            assertEquals(Vec3.of(m.normals!!, 3 * t.weldedRepresentative[t.weldOf[v]]), Vec3.of(m.normals!!, 3 * v))
            assertTrue(Vec3.of(m.normals!!, 3 * v).dot(Vec3.of(src.normals!!, 3 * v)) > 0.98f)
        }
    }

    @Test fun componentsSortedByArea() {
        val small = Fixtures.translate(Fixtures.uvSphere(0.2f, 10, 6), Vec3(4f, 0f, 0f))
        val big = Fixtures.uvSphere(1f, 16, 8)
        val mid = Fixtures.translate(Fixtures.torus(0.5f, 0.1f, 12, 6), Vec3(0f, 5f, 0f))
        val m = Fixtures.merge(small, big, mid)
        val info = MeshOps.components(m)
        assertEquals(3, info.count)
        assertEquals(listOf(big.faceCount, mid.faceCount, small.faceCount), info.components.map { it.faceCount })
        assertEquals(listOf(0, 1, 2), info.components.map { it.id })
        assertEquals(MeshOps.surfaceArea(big), info.components[0].area, 1e-3f)
        assertEquals(MeshOps.surfaceArea(small), info.components[2].area, 1e-4f)
        assertTrue(info.components[2].bounds.min.distanceTo(Vec3(3.8f, -0.2f, -0.2f)) < 0.02f)
        assertTrue(info.components[2].bounds.max.distanceTo(Vec3(4.2f, 0.2f, 0.2f)) < 0.02f)
        for (f in 0 until m.faceCount) {
            val expected = if (f < small.faceCount) 2 else if (f < small.faceCount + big.faceCount) 0 else 1
            assertEquals(expected, info.faceComponent[f])
        }

        val largest = MeshOps.keepLargestComponents(m, 1)
        assertEquals(big.faceCount, largest.faceCount); assertEquals(big.vertexCount, largest.vertexCount)
        assertEquals(1, largest.materials.size)
        assertEquals(big.faceCount + mid.faceCount, MeshOps.keepLargestComponents(m, 2).faceCount)
        assertEquals(m.faceCount, MeshOps.keepLargestComponents(m, 10).faceCount)

        // torus area / sphere area ~ 0.157, small sphere ~ 0.04
        assertEquals(big.faceCount + mid.faceCount, MeshOps.removeSmallComponents(m, 0.1f).faceCount)
        assertEquals(big.faceCount, MeshOps.removeSmallComponents(m, 0.5f).faceCount)
        assertEquals(m.faceCount, MeshOps.removeSmallComponents(m, 0.001f).faceCount)
        assertTrue(MeshOps.signedVolume(MeshOps.removeSmallComponents(m, 0.5f)) > 0f)
    }

    @Test fun statsOfSphereWithCapRemoved() {
        val closed = Fixtures.uvSphere(1f, 48, 24)
        val s = MeshOps.stats(closed)
        assertEquals(closed.vertexCount, s.vertexCount); assertEquals(closed.faceCount, s.faceCount)
        assertEquals(2 + 23 * 48, s.weldedVertexCount)
        assertEquals(4 * PI, s.surfaceArea.toDouble(), 0.05)
        assertEquals(0, s.boundaryEdgeCount); assertEquals(0, s.holeCount); assertEquals(0, s.nonManifoldEdgeCount)
        assertEquals(1, s.componentCount)
        assertTrue(s.bounds.min.distanceTo(Vec3(-1f, -1f, -1f)) < 1e-3f && s.bounds.max.distanceTo(Vec3(1f, 1f, 1f)) < 1e-3f)
        assertTrue(s.medianEdgeLength > 0.05f && s.medianEdgeLength < 0.15f)
        assertTrue(abs(s.meanEdgeLength - s.medianEdgeLength) < 0.05f)
        assertEquals(0f, s.repairedAreaFraction, 0f)
        // confidence = polar angle / pi; the area with confidence < c is a cap of height 1 - cos(pi c): fraction (1 - cos(pi c)) / 2
        assertEquals((1 - Math.cos(PI * 0.3)) / 2, s.lowConfidenceAreaFraction!!.toDouble(), 0.005)
        assertEquals((1 - Math.cos(PI * 0.75)) / 2, MeshOps.stats(closed, 0.75f).lowConfidenceAreaFraction!!.toDouble(), 0.005)
        assertEquals(0f, MeshOps.stats(closed, 0f).lowConfidenceAreaFraction!!, 0f)
        assertEquals(1f, MeshOps.stats(closed, 1.5f).lowConfidenceAreaFraction!!, 0f)

        val open = Fixtures.sphereWithoutCaps(1f, 48, 24, 0.8f, both = true)
        val o = MeshOps.stats(open)
        assertEquals(2, o.holeCount); assertEquals(96, o.boundaryEdgeCount); assertEquals(1, o.componentCount)
        assertNull(MeshOps.stats(open.copy(confidence = null)).lowConfidenceAreaFraction)

        val filled = MeshOps.fillHoles(open).mesh
        val f = MeshOps.stats(filled)
        assertEquals(0, f.holeCount)
        val capArea = Fixtures.areaOf(filled) { filled.materials[filled.materialOfFace(it)].repaired }
        assertTrue(capArea > 0.5)
        assertEquals(capArea / f.surfaceArea, f.repairedAreaFraction.toDouble(), 1e-4)
    }

    @Test fun statsMedianEdgeLengthOnGrid() {
        // unit cells: 2*n*(n+1) edges of length 1 and n*n diagonals of length sqrt(2)
        val n = 6
        val s = MeshOps.stats(Fixtures.planeGrid(n, n, n.toFloat()))
        assertEquals(1f, s.medianEdgeLength, 1e-6f)
        val edges = 2 * n * (n + 1); val diagonals = n * n
        assertEquals((edges + diagonals * Math.sqrt(2.0)) / (edges + diagonals), s.meanEdgeLength.toDouble(), 1e-5)
        assertEquals(1, s.holeCount) // the outer rim
        assertEquals(4 * n, s.boundaryEdgeCount)
    }
}
