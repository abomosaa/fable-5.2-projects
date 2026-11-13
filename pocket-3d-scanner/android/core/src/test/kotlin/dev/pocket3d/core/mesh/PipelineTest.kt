package dev.pocket3d.core.mesh

import dev.pocket3d.core.math.Mat4
import dev.pocket3d.core.math.Quat
import dev.pocket3d.core.math.Ray
import dev.pocket3d.core.math.Vec3
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PipelineTest {
    private fun assertClosedOutward(m: Mesh, step: String): Float {
        val t = MeshTopology.build(m)
        assertEquals("$step: open boundary", 0, t.boundaryEdgeCount)
        assertEquals("$step: non-manifold", 0, t.nonManifoldEdgeCount)
        val v = MeshOps.signedVolume(m)
        assertTrue("$step: signed volume $v must stay positive (winding flipped?)", v > 0f)
        // vertex normals agree with the winding
        var agree = 0
        for (f in 0 until m.faceCount) {
            val n = Fixtures.faceNormal(m, f)
            val i = m.indices[3 * f]
            if (n.dot(Vec3.of(m.normals!!, 3 * i)) > 0f) agree++
        }
        assertEquals("$step: vertex normals disagree with face winding", m.faceCount, agree)
        return v
    }

    /** The edit chain a user might apply, checking orientation after every operation. */
    @Test fun signedVolumeStaysPositiveThroughEveryOperation() {
        var m = Fixtures.merge(
            Fixtures.torus(1f, 0.4f, 96, 48, Fixtures.texturedMaterial()),
            Fixtures.translate(Fixtures.uvSphere(0.1f, 12, 6), Vec3(3f, 0f, 0f)), // a floater
        ).copy(faceMaterial = null).let { it.copy(materials = it.materials.take(1)) }
        var v = assertClosedOutward(m, "input")

        m = MeshOps.transform(m, Mat4.trs(Vec3(0.5f, 1f, -2f), Quat.axisAngle(Vec3(1f, 1f, 0f), 0.6f), 1.5f))
        v = assertClosedOutward(m, "rigid transform").also { assertEquals(v * 1.5f * 1.5f * 1.5f, it, v * 0.01f) }

        m = MeshOps.transform(m, Mat4.identity().also { it[10] = -1f }) // mirror z
        v = assertClosedOutward(m, "mirror").also { assertEquals(v, it, v * 1e-4f) }

        m = MeshOps.removeSmallComponents(m, 0.05f)
        assertEquals(1, MeshOps.components(m).count)
        v = assertClosedOutward(m, "remove floaters").also { assertTrue(it < v) }

        // cut the torus open, then repair it
        val box = Aabb.of(m.positions)
        val cut = MeshOps.clipByPlane(m, box.center + Vec3(0.3f, 0f, 0f), Vec3(-1f, 0.2f, 0.1f))
        assertTrue(MeshTopology.build(cut).boundaryEdgeCount > 0)
        for (f in 0 until cut.faceCount) assertTrue(Fixtures.faceNormal(cut, f).length() > 0f)
        val filled = MeshOps.fillHoles(cut)
        assertEquals(2, filled.filledHoleCount) // the plane crosses the tube twice
        m = filled.mesh
        v = assertClosedOutward(m, "clip + fill").also { assertTrue(it < v && it > 0.3f * v) }

        m = MeshOps.recomputeNormals(m)
        assertClosedOutward(m, "recompute normals")

        val simplified = MeshOps.simplify(m, m.faceCount / 5)
        assertTrue(simplified.targetReached)
        m = simplified.mesh
        v = assertClosedOutward(m, "simplify").also { assertEquals(v, it, v * 0.02f) }

        m = GlbReader.read(GlbWriter.write(GlbDocument(m))).mesh
        v = assertClosedOutward(m, "GLB round trip").also { assertEquals(v, it, v * 1e-5f) }
        assertTrue(m.materials.any { it.repaired })
        assertTrue(MeshOps.stats(m).repairedAreaFraction > 0.01f)

        m = MeshOps.cropToBox(m, OrientedBox.of(Aabb.of(m.positions)).let { it.copy(halfExtents = it.halfExtents * 2f) })
        assertClosedOutward(m, "crop to a box containing everything").also { assertEquals(v, it, v * 1e-5f) }

        // a ray from far outside hits a front face first
        val bvh = Bvh.build(m)
        val c = Aabb.of(m.positions).center
        val hit = bvh.raycast(Ray(c + Vec3(0f, 0f, 50f), Vec3(0f, 0f, -1f)), cullBackfaces = false)
        if (hit != null) assertTrue(hit.normal.z > 0f)
    }

    /** Arbitrary garbage connectivity must never crash or hang any operation. */
    @Test fun garbageMeshesDoNotBreakAnything() {
        val rng = SplitMix64(99)
        repeat(40) { round ->
            val vCount = 12 + (rng.nextDouble() * 30).toInt()
            val fCount = 20 + (rng.nextDouble() * 80).toInt()
            val pos = FloatArray(3 * vCount) { (rng.nextDouble() * 4).toInt() / 2f } // coarse lattice: many coincident points
            val idx = IntArray(3 * fCount) { (rng.nextDouble() * vCount).toInt() }   // degenerate, duplicate and non-manifold faces
            val uv = FloatArray(2 * vCount) { rng.nextDouble().toFloat() }
            val conf = FloatArray(vCount) { rng.nextDouble().toFloat() }
            val fm = IntArray(fCount) { (rng.nextDouble() * 3).toInt() }
            val materials = listOf(Material("a"), Fixtures.texturedMaterial("b"), Material("c", repaired = true))
            val m = Mesh(pos, null, if (round % 2 == 0) uv else null, if (round % 3 == 0) conf else null, idx, if (round % 4 == 0) null else fm, materials)
            fun check(x: Mesh, what: String) {
                for (i in x.indices) assertTrue("$what: index out of range", i in 0 until x.vertexCount)
                for (f in 0 until x.faceCount) assertTrue("$what: material out of range", x.materialOfFace(f) in x.materials.indices)
                for (p in x.positions) assertTrue("$what: non-finite position", p.isFinite())
            }
            val topo = MeshTopology.build(m)
            for (loop in topo.boundaryLoops()) assertEquals(loop.size, loop.toSet().size)
            assertTrue(topo.faceComponents().count >= 1)
            val stats = MeshOps.stats(m)
            assertEquals(MeshOps.components(m).count, stats.componentCount)
            assertEquals(MeshOps.findHoles(m).size, stats.holeCount)
            check(MeshOps.recomputeNormals(m), "normals")
            val filled = MeshOps.fillHoles(m)
            check(filled.mesh, "fill")
            assertEquals(m.faceCount + filled.addedFaces, filled.mesh.faceCount)
            check(MeshOps.clipByPlane(m, Vec3(0.7f, 0.6f, 0.9f), Vec3(1f, 0.3f, -0.2f)), "clip")
            check(MeshOps.cropToBox(m, OrientedBox(Vec3(1f, 1f, 1f), Quat.axisAngle(Vec3.Y, 0.4f), Vec3(0.8f, 0.6f, 0.7f))), "crop")
            val s = MeshOps.simplify(m, fCount / 3)
            check(s.mesh, "simplify")
            assertTrue(s.mesh.faceCount <= m.faceCount)
            assertEquals(MeshOps.simplify(m, fCount / 3).mesh.indices.toList(), s.mesh.indices.toList())
            check(MeshOps.keepLargestComponents(m, 2), "components")
            val bvh = Bvh.build(m)
            bvh.raycast(Ray(Vec3(-3f, 0.4f, 0.6f), Vec3(1f, 0.1f, 0.05f).normalized()))
            bvh.closestPoint(Vec3(0.3f, 0.2f, 0.1f))
            MeshSelection.facesInSphere(m, Vec3(1f, 1f, 1f), 0.5f)
            val reread = GlbReader.read(GlbWriter.write(GlbDocument(filled.mesh))).mesh
            check(reread, "glb")
            assertEquals(filled.mesh.faceCount, reread.faceCount)
            assertEquals(MeshOps.stats(filled.mesh).repairedAreaFraction, MeshOps.stats(reread).repairedAreaFraction, 1e-5f)
            ObjWriter.write(m, "x"); PlyWriter.write(m)
            if (stats.surfaceArea > 0f) MeshOps.deviation(m, s.mesh.takeIf { MeshOps.surfaceArea(it) > 0f } ?: m, 200)
        }
    }
}
