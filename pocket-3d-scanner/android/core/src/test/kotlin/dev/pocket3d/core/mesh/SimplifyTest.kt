package dev.pocket3d.core.mesh

import dev.pocket3d.core.math.Vec3
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.acos
import kotlin.math.sqrt

class SimplifyTest {
    private fun assertTargetReached(r: SimplifyResult, target: Int) {
        assertTrue("target $target not reached: ${r.faceCount}", r.targetReached)
        assertEquals(r.mesh.faceCount, r.faceCount)
        // an interior collapse removes two faces, so the count may undershoot by one
        assertTrue("face count ${r.faceCount} vs target $target", r.faceCount in (target - 1)..target)
    }

    private fun assertNoDegenerateFaces(m: Mesh) {
        val q = Fixtures.minFaceQuality(m)
        assertTrue("degenerate or sliver face, quality $q", q > 1e-3f)
        for (f in 0 until m.faceCount) {
            val a = m.indices[3 * f]; val b = m.indices[3 * f + 1]; val c = m.indices[3 * f + 2]
            assertTrue(a != b && b != c && a != c)
        }
    }

    private fun assertBoundsClose(a: Mesh, b: Mesh, tolerance: Float) {
        val x = Aabb.of(a.positions); val y = Aabb.of(b.positions)
        assertTrue("bbox min moved ${x.min.distanceTo(y.min)}", x.min.distanceTo(y.min) <= tolerance * x.diagonal)
        assertTrue("bbox max moved ${x.max.distanceTo(y.max)}", x.max.distanceTo(y.max) <= tolerance * x.diagonal)
    }

    /** Every output vertex must be an input vertex with the same position and uv, and no higher confidence. */
    private fun assertVerticesAreSubset(input: Mesh, output: Mesh) {
        val byKey = HashMap<List<Float>, Float>()
        for (v in 0 until input.vertexCount) {
            val key = listOf(input.positions[3 * v], input.positions[3 * v + 1], input.positions[3 * v + 2], input.uvs?.get(2 * v) ?: 0f, input.uvs?.get(2 * v + 1) ?: 0f)
            val c = input.confidence?.get(v) ?: 1f
            byKey[key] = minOf(byKey[key] ?: c, c)
        }
        for (v in 0 until output.vertexCount) {
            val key = listOf(output.positions[3 * v], output.positions[3 * v + 1], output.positions[3 * v + 2], output.uvs?.get(2 * v) ?: 0f, output.uvs?.get(2 * v + 1) ?: 0f)
            val original = byKey[key]
            assertTrue("output vertex $v is not an input vertex (position/uv was invented)", original != null)
            if (output.confidence != null) assertTrue("confidence was raised", output.confidence!![v] <= original!!)
        }
    }

    @Test fun sphereKeepsShapeTopologyAndOrientation() {
        val m = Fixtures.uvSphere(1f, 96, 48)
        val snapshot = m.positions.copyOf(); val snapshotIdx = m.indices.copyOf()
        val target = 1500
        val r = MeshOps.simplify(m, target)
        assertArrayEquals(snapshot, m.positions, 0f); assertArrayEquals(snapshotIdx, m.indices)
        assertTargetReached(r, target)
        assertEquals(m.faceCount, r.originalFaceCount)
        assertTrue(r.collapseCount >= (m.faceCount - target) / 2)
        val s = r.mesh
        assertNoDegenerateFaces(s)
        assertBoundsClose(m, s, 0.01f)
        assertVerticesAreSubset(m, s)

        val topo = MeshTopology.build(s)
        assertEquals(0, topo.boundaryEdgeCount); assertEquals(0, topo.nonManifoldEdgeCount)
        assertEquals(1, topo.faceComponents().count)
        assertEquals(2, topo.weldedCount - topo.edgeCount + s.faceCount) // still a sphere
        val v0 = MeshOps.signedVolume(m); val v1 = MeshOps.signedVolume(s)
        assertTrue(v1 > 0f)
        assertEquals(v0, v1, v0 * 0.02f)
        for (f in 0 until s.faceCount) assertTrue("face $f flipped", Fixtures.faceNormal(s, f).dot(Fixtures.centroid(s, f)) > 0f)
        for (v in 0 until s.vertexCount) assertTrue(Vec3.of(s.normals!!, 3 * v).dot(s.position(v)) > 0.97f)

        val forward = MeshOps.deviation(m, s); val backward = MeshOps.deviation(s, m)
        assertTrue("mean deviation ${forward.meanRelativeToDiagonal}", forward.meanRelativeToDiagonal < 0.002f)
        assertTrue("max deviation ${forward.maxRelativeToDiagonal}", forward.maxRelativeToDiagonal < 0.008f)
        assertTrue("max deviation back ${backward.maxRelativeToDiagonal}", backward.maxRelativeToDiagonal < 0.008f)
    }

    @Test fun torusKeepsGenusAndDeviationSmall() {
        val m = Fixtures.torus(1f, 0.35f, 128, 64)
        val target = m.faceCount / 8
        val r = MeshOps.simplify(m, target)
        assertTargetReached(r, target)
        val s = r.mesh
        assertNoDegenerateFaces(s)
        assertBoundsClose(m, s, 0.01f)
        assertVerticesAreSubset(m, s)
        val topo = MeshTopology.build(s)
        assertEquals(0, topo.boundaryEdgeCount); assertEquals(0, topo.nonManifoldEdgeCount)
        assertEquals(0, topo.weldedCount - topo.edgeCount + s.faceCount) // still a torus
        assertEquals(MeshOps.signedVolume(m), MeshOps.signedVolume(s), MeshOps.signedVolume(m) * 0.02f)
        val d = MeshOps.deviation(m, s); val back = MeshOps.deviation(s, m)
        assertTrue("rms ${d.rmsRelativeToDiagonal}", d.rmsRelativeToDiagonal < 0.002f)
        assertTrue("max ${d.maxRelativeToDiagonal}", d.maxRelativeToDiagonal < 0.01f)
        assertTrue("max back ${back.maxRelativeToDiagonal}", back.maxRelativeToDiagonal < 0.01f)
    }

    @Test fun openBoundaryOfCylinderStaysPut() {
        val m = Fixtures.openCylinder(1f, 2f, 96, 24)
        val target = m.faceCount / 6
        val r = MeshOps.simplify(m, target)
        assertTargetReached(r, target)
        val s = r.mesh
        assertNoDegenerateFaces(s)
        val topo = MeshTopology.build(s)
        val loops = topo.boundaryLoops()
        assertEquals(2, loops.size)
        assertEquals(0, topo.nonManifoldEdgeCount)
        val original = MeshOps.findHoles(m)
        val after = MeshOps.findHoles(s)
        for (h in after) {
            val y = h.vertex(0).y
            assertTrue(y == 0f || y == 2f)
            for (i in 0 until h.edgeCount) {
                // rim vertices never leave the rim: same height, exactly on the circle
                assertEquals(y, h.vertex(i).y, 0f)
                assertEquals(1f, sqrt(h.vertex(i).x * h.vertex(i).x + h.vertex(i).z * h.vertex(i).z), 1e-6f)
            }
            // the rim silhouette does not creep: perimeter and enclosed area nearly unchanged
            assertTrue("rim perimeter shrank to ${h.perimeter}", h.perimeter > original[0].perimeter * 0.99f)
            assertTrue("rim area shrank to ${h.area}", h.area > original[0].area * 0.98f)
            assertTrue(h.edgeCount >= 24)
        }
        assertBoundsClose(m, s, 1e-6f)
        val d = MeshOps.deviation(m, s)
        assertTrue("max ${d.maxRelativeToDiagonal}", d.maxRelativeToDiagonal < 0.01f)
        // interior vertices went first: the wall is flat along its axis, so few rings remain
        assertTrue(after.sumOf { it.edgeCount } > s.vertexCount / 4)
    }

    /** Smallest cosine between a face normal and the (input) vertex normals at its corners. */
    private fun worstFaceVsVertexNormal(m: Mesh): Float {
        var worst = 1f
        for (f in 0 until m.faceCount) {
            val n = Fixtures.faceNormal(m, f).normalized()
            for (k in 0 until 3) worst = minOf(worst, n.dot(Vec3.of(m.normals!!, 3 * m.indices[3 * f + k])))
        }
        return worst
    }

    @Test fun facesDoNotTurnAwayFromTheInputSurface() {
        // Regression: next to the UV seam of a torus the simplifier used to leave thin triangles
        // spanning the curved tube edge-on, their normals ~85 degrees off the surface.
        // Keeping the input normals (recomputeNormals = false) lets us compare every output face
        // with the true surface normal at its corners.
        val t = Fixtures.torus(1f, 0.4f, 96, 48, Fixtures.texturedMaterial())
        val capped = MeshOps.fillHoles(MeshOps.clipByPlane(t, Vec3(0.3f, 0f, 0f), Vec3(-1f, 0.2f, 0.1f))).mesh
        for (input in listOf(t, capped)) {
            val target = input.faceCount / 5
            val r = MeshOps.simplify(input, target, SimplifyOptions(recomputeNormals = false))
            assertTargetReached(r, target)
            assertNoDegenerateFaces(r.mesh)
            // default limit: 60 degrees (cos = 0.5) against the smooth normals of the input faces;
            // the fixture's analytic normals differ from those by a few degrees at most
            val worst = worstFaceVsVertexNormal(r.mesh)
            assertTrue("a face is ${Math.toDegrees(Math.acos(worst.toDouble()))} degrees off the input surface", worst > 0.45f)
        }
        // a tighter limit is honoured, a lifted one reproduces the old behaviour on this input
        val tight = MeshOps.simplify(capped, capped.faceCount / 5, SimplifyOptions(recomputeNormals = false, maxNormalDeviationDegrees = 40f))
        assertTrue(worstFaceVsVertexNormal(tight.mesh) > Math.cos(Math.toRadians(45.0)).toFloat())
        val unlimited = MeshOps.simplify(capped, capped.faceCount / 5, SimplifyOptions(recomputeNormals = false, maxNormalDeviationDegrees = 180f))
        assertTrue("expected the unlimited run to show the defect", worstFaceVsVertexNormal(unlimited.mesh) < 0.3f)
        // an impossible demand is reported, not silently violated: a sphere cannot become 8 faces within 30 degrees
        val sphere = Fixtures.uvSphere(1f, 32, 16)
        val coarse = MeshOps.simplify(sphere, 8, SimplifyOptions(recomputeNormals = false, maxNormalDeviationDegrees = 30f))
        assertTrue(!coarse.targetReached && coarse.faceCount > 8)
        assertTrue(worstFaceVsVertexNormal(coarse.mesh) > Math.cos(Math.toRadians(35.0)).toFloat())
    }

    @Test fun lockBoundaryKeepsEveryRimVertex() {
        val m = Fixtures.openCylinder(1f, 2f, 48, 12)
        val r = MeshOps.simplify(m, m.faceCount / 4, SimplifyOptions(lockBoundary = true))
        val before = MeshOps.findHoles(m); val after = MeshOps.findHoles(r.mesh)
        assertEquals(before.map { it.edgeCount }, after.map { it.edgeCount })
        assertEquals(before.map { it.perimeter }, after.map { it.perimeter })
        assertTrue(r.mesh.faceCount < m.faceCount / 2)
    }

    @Test fun planarTexturedGridKeepsTextureMapping() {
        // a wavy height field with a planar atlas: uv = (x, z) / size
        val size = 4f
        val m = Fixtures.planeGrid(60, 60, size, Fixtures.texturedMaterial()) { x, z -> 0.15f * (Math.sin(2.0 * x) * Math.cos(1.5 * z)).toFloat() }
        val target = m.faceCount / 10
        val r = MeshOps.simplify(m, target)
        assertTargetReached(r, target)
        val s = r.mesh
        assertNoDegenerateFaces(s)
        assertVerticesAreSubset(m, s)
        assertBoundsClose(m, s, 0.01f)
        for (v in 0 until s.vertexCount) {
            val u = s.uvs!![2 * v]; val w = s.uvs!![2 * v + 1]
            assertTrue(u in 0f..1f && w in 0f..1f)
            // exact atlas coordinates are kept
            assertEquals(s.positions[3 * v] / size, u, 1e-6f); assertEquals(s.positions[3 * v + 2] / size, w, 1e-6f)
        }
        // no triangle is flipped in texture space or in 3D, and texel density does not collapse
        var uvArea = 0.0
        for (f in 0 until s.faceCount) {
            val a = s.indices[3 * f]; val b = s.indices[3 * f + 1]; val c = s.indices[3 * f + 2]
            val signed = (s.uvs!![2 * b] - s.uvs!![2 * a]) * (s.uvs!![2 * c + 1] - s.uvs!![2 * a + 1]) -
                (s.uvs!![2 * b + 1] - s.uvs!![2 * a + 1]) * (s.uvs!![2 * c] - s.uvs!![2 * a])
            // the grid faces +Y with u ~ x, v ~ z: all uv triangles have the same (negative) orientation
            assertTrue("uv triangle $f flipped ($signed)", signed < 0f)
            assertTrue(Fixtures.faceNormal(s, f).y > 0f)
            uvArea += abs(signed) / 2.0
        }
        assertEquals("the atlas chart must stay fully covered", 1.0, uvArea, 1e-4)
        // texture-space distortion: where does a texel land now compared to before?
        // sample the simplified surface, find the closest original surface point, compare uv
        val bvh = Bvh.build(m)
        val rng = SplitMix64(7)
        var worst = 0.0; var sum = 0.0
        val samples = 4000
        repeat(samples) {
            val f = (rng.nextDouble() * s.faceCount).toInt()
            var b0 = rng.nextDouble(); var b1 = rng.nextDouble()
            if (b0 + b1 > 1) { b0 = 1 - b0; b1 = 1 - b1 }
            val b2 = 1 - b0 - b1
            val i = IntArray(3) { s.indices[3 * f + it] }
            val p = s.position(i[0]) * b0.toFloat() + s.position(i[1]) * b1.toFloat() + s.position(i[2]) * b2.toFloat()
            val u = b0 * s.uvs!![2 * i[0]] + b1 * s.uvs!![2 * i[1]] + b2 * s.uvs!![2 * i[2]]
            val w = b0 * s.uvs!![2 * i[0] + 1] + b1 * s.uvs!![2 * i[1] + 1] + b2 * s.uvs!![2 * i[2] + 1]
            val hit = bvh.closestPoint(p)!!
            val j = IntArray(3) { m.indices[3 * hit.face + it] }
            val ou = hit.b0 * m.uvs!![2 * j[0]] + hit.b1 * m.uvs!![2 * j[1]] + hit.b2 * m.uvs!![2 * j[2]]
            val ow = hit.b0 * m.uvs!![2 * j[0] + 1] + hit.b1 * m.uvs!![2 * j[1] + 1] + hit.b2 * m.uvs!![2 * j[2] + 1]
            val e = sqrt((u - ou) * (u - ou) + (w - ow) * (w - ow))
            sum += e; if (e > worst) worst = e
        }
        // one grid cell is 1/60 = 0.0167 in uv
        assertTrue("worst texture shift $worst", worst < 0.01)
        assertTrue("mean texture shift ${sum / samples}", sum / samples < 0.002)
        // the outer rim (and with it the atlas chart outline) stays a square: same footprint, and the
        // wavy rim polyline is not shortened noticeably
        val rim = MeshOps.findHoles(s).single()
        val originalRim = MeshOps.findHoles(m).single()
        assertTrue("rim ${rim.perimeter} vs ${originalRim.perimeter}", rim.perimeter > originalRim.perimeter * 0.995f && rim.perimeter <= originalRim.perimeter + 1e-4f)
        for (i in 0 until rim.edgeCount) {
            val p = rim.vertex(i)
            assertTrue("rim vertex $p left the square outline", p.x == 0f || p.x == size || p.z == 0f || p.z == size)
        }
    }

    @Test fun textureTermLimitsDistortionWhereGeometryGivesNoGuidance() {
        // A perfectly flat grid with a non-affine (warped) atlas: every collapse has zero geometric
        // error, so only the texture term can tell good collapses from bad ones.
        val n = 48
        val flat = Fixtures.planeGrid(n, n, 1f, Fixtures.texturedMaterial())
        fun warpU(x: Double, z: Double) = 0.1 + 0.8 * x + 0.05 * Math.sin(2 * PI * z)
        fun warpV(x: Double, z: Double) = 0.1 + 0.8 * z + 0.05 * Math.sin(2 * PI * x)
        val uv = FloatArray(flat.vertexCount * 2) { i ->
            val x = flat.positions[3 * (i / 2)].toDouble(); val z = flat.positions[3 * (i / 2) + 2].toDouble()
            (if (i % 2 == 0) warpU(x, z) else warpV(x, z)).toFloat()
        }
        val m = flat.copy(uvs = uv)
        /** Largest and mean distance, in uv units, between the texel shown at a surface point and the one the atlas assigns to it. */
        fun distortion(s: Mesh): Pair<Double, Double> {
            val rng = SplitMix64(3)
            var worst = 0.0; var sum = 0.0
            val samples = 6000
            repeat(samples) {
                val f = (rng.nextDouble() * s.faceCount).toInt()
                var b0 = rng.nextDouble(); var b1 = rng.nextDouble()
                if (b0 + b1 > 1) { b0 = 1 - b0; b1 = 1 - b1 }
                val b = doubleArrayOf(b0, b1, 1 - b0 - b1)
                var x = 0.0; var z = 0.0; var u = 0.0; var v = 0.0
                for (k in 0 until 3) {
                    val i = s.indices[3 * f + k]
                    x += b[k] * s.positions[3 * i]; z += b[k] * s.positions[3 * i + 2]
                    u += b[k] * s.uvs!![2 * i]; v += b[k] * s.uvs!![2 * i + 1]
                }
                val e = sqrt((u - warpU(x, z)) * (u - warpU(x, z)) + (v - warpV(x, z)) * (v - warpV(x, z)))
                sum += e; if (e > worst) worst = e
            }
            return worst to sum / samples
        }
        val target = m.faceCount / 8
        val aware = MeshOps.simplify(m, target)
        val blind = MeshOps.simplify(m, target, SimplifyOptions(uvWeight = 0f))
        assertTargetReached(aware, target); assertTargetReached(blind, target)
        assertNoDegenerateFaces(aware.mesh)
        assertVerticesAreSubset(m, aware.mesh)
        for (v in 0 until aware.mesh.vertexCount) assertTrue(aware.mesh.uvs!![2 * v] in 0f..1f && aware.mesh.uvs!![2 * v + 1] in 0f..1f)
        val base = distortion(m)
        val a = distortion(aware.mesh); val b = distortion(blind.mesh)
        File("build").mkdirs()
        File("build/simplify-uv-distortion.txt").writeText("input max ${base.first} mean ${base.second}\nuvWeight=1 max ${a.first} mean ${a.second}\nuvWeight=0 max ${b.first} mean ${b.second}\n")
        // bounded: the warp has an amplitude of 0.05; one input cell is 0.017 wide in uv
        assertTrue("max texture distortion ${a.first}", a.first < 0.004)
        assertTrue("mean texture distortion ${a.second}", a.second < 0.0012)
        // and better than ignoring the texture: the worst texel shift is well under that of a
        // purely geometric simplification (measured: about 0.0017 vs 0.0048), the mean is no worse
        assertTrue("texture-aware max ${a.first} vs blind ${b.first}", a.first < 0.6 * b.first)
        assertTrue("texture-aware mean ${a.second} vs blind ${b.second}", a.second <= b.second)
    }

    @Test fun uvSeamIsNotSmearedOnSphere() {
        val m = Fixtures.uvSphere(1f, 96, 48, Fixtures.texturedMaterial())
        val r = MeshOps.simplify(m, m.faceCount / 6)
        assertTargetReached(r, m.faceCount / 6)
        val s = r.mesh
        assertVerticesAreSubset(m, s)
        var worst = 0.0
        for (f in 0 until s.faceCount) {
            val i = IntArray(3) { s.indices[3 * f + it] }
            val us = i.map { s.uvs!![2 * it] }
            // no triangle spans the seam (that would smear the whole atlas width across one face)
            assertTrue("face $f spans the u seam: $us", us.max() - us.min() < 0.25f)
            // the texture stays where it was: compare interpolated uv at the centroid with the analytic mapping
            val c = Fixtures.centroid(s, f)
            if (abs(c.normalized().y) > 0.9f) continue // longitude is ill-defined near the poles
            val dir = c.normalized()
            var u = atan2(dir.z, dir.x) / (2 * PI); if (u < 0) u += 1.0
            val v = acos(dir.y.toDouble()) / PI
            val iu = us.average(); val iv = i.map { s.uvs!![2 * it + 1] }.average()
            var du = abs(iu - u); if (du > 0.5) du = 1 - du
            worst = maxOf(worst, du, abs(iv - v))
        }
        assertTrue("texture shifted by $worst", worst < 0.01)
        // seam vertices are still duplicated in pairs (u = 0 and u = 1) at identical positions
        // (the poles are left out: there the fixture has one vertex per segment rather than a pair)
        val seam0 = (0 until s.vertexCount).filter { s.uvs!![2 * it] == 0f && Math.abs(s.positions[3 * it + 1]) < 1f }.map { s.position(it) }.toSet()
        val seam1 = (0 until s.vertexCount).filter { s.uvs!![2 * it] == 1f && Math.abs(s.positions[3 * it + 1]) < 1f }.map { s.position(it) }.toSet()
        assertTrue(seam0.size >= 4)
        assertEquals(seam0, seam1)
        assertEquals(0, MeshTopology.build(s).boundaryEdgeCount)
    }

    @Test fun materialsAndRepairedPatchAreNeverMixed() {
        // sphere with a filled (repaired) cap, plus a second textured material on the lower half
        val open = Fixtures.sphereWithoutCaps(1f, 64, 32, 0.78f, both = false) // clean cut along the ring at y = 0.773
        val filled = MeshOps.fillHoles(open).mesh
        val materials = filled.materials + Fixtures.texturedMaterial("lower", 2)
        val fm = IntArray(filled.faceCount) { f -> if (filled.materialOfFace(f) == 1) 1 else if (Fixtures.centroid(filled, f).y < 0f) 2 else 0 }
        val m = filled.copy(faceMaterial = fm, materials = materials)
        fun areas(x: Mesh) = (0..2).map { k -> Fixtures.areaOf(x) { f -> x.materialOfFace(f) == k } }
        val before = areas(m)
        val r = MeshOps.simplify(m, m.faceCount / 5)
        assertTargetReached(r, m.faceCount / 5)
        val s = r.mesh
        assertSame("materials list must be passed through untouched", m.materials, s.materials)
        assertEquals(listOf(false, true, false), s.materials.map { it.repaired })
        val after = areas(s)
        for (k in 0..2) assertEquals("area of material $k changed", before[k], after[k], before[k] * 0.02)
        for (f in 0 until s.faceCount) {
            val c = Fixtures.centroid(s, f)
            when (s.materialOfFace(f)) {
                1 -> assertTrue("repaired face left the cap: $c", c.y > 0.77f && Fixtures.faceNormal(s, f).normalized().y > 0.99f)
                2 -> assertTrue(c.y < 0f)
                else -> assertTrue("observed face $c", c.y > 0f && c.y < 0.774f)
            }
            // repaired vertices keep confidence 0, and are never shared with observed surface
            for (k in 0 until 3) {
                val v = s.indices[3 * f + k]
                if (s.materialOfFace(f) == 1) { assertEquals(0f, s.confidence!![v], 0f); assertEquals(0f, s.uvs!![2 * v], 0f) }
            }
        }
        assertEquals(0, MeshTopology.build(s).boundaryEdgeCount)
        assertTrue(MeshOps.signedVolume(s) > 0f)
        assertVerticesAreSubset(m, s)
    }

    @Test fun confidenceIsTheMinimumOfMergedVertices() {
        // flat grid, so everything collapses freely; confidence = x / size
        val m = Fixtures.planeGrid(20, 20, 1f)
        val s = MeshOps.simplify(m, 40).mesh
        assertVerticesAreSubset(m, s)
        // at least some vertex absorbed a lower-confidence neighbour
        assertTrue((0 until s.vertexCount).any { s.confidence!![it] < s.positions[3 * it] - 1e-6f })
        assertTrue(s.confidence!!.all { it in 0f..1f })
        // a mesh without confidence stays without
        assertEquals(null, MeshOps.simplify(m.copy(confidence = null), 40).mesh.confidence)
    }

    @Test fun deterministicAndIdempotentAtTarget() {
        val m = Fixtures.torus(1f, 0.3f, 64, 32, Fixtures.texturedMaterial())
        val a = MeshOps.simplify(m, 900).mesh; val b = MeshOps.simplify(m, 900).mesh
        assertArrayEquals(a.positions, b.positions, 0f); assertArrayEquals(a.indices, b.indices)
        assertArrayEquals(a.uvs, b.uvs, 0f); assertArrayEquals(a.confidence, b.confidence, 0f); assertArrayEquals(a.normals, b.normals, 0f)
        // target >= face count: the same instance comes back
        val same = MeshOps.simplify(m, m.faceCount)
        assertSame(m, same.mesh); assertEquals(0, same.collapseCount); assertTrue(same.targetReached)
    }

    @Test fun worksOnTriangleSoupAndWithoutUvs() {
        // unshared vertices (three per face) must not block simplification
        val src = Fixtures.uvSphere(1f, 48, 24)
        val soupPos = FloatArray(src.faceCount * 9); val soupUv = FloatArray(src.faceCount * 6)
        for (c in src.indices.indices) {
            val v = src.indices[c]
            System.arraycopy(src.positions, 3 * v, soupPos, 3 * c, 3); System.arraycopy(src.uvs!!, 2 * v, soupUv, 2 * c, 2)
        }
        val soup = Mesh(soupPos, null, soupUv, null, IntArray(src.faceCount * 3) { it }, null, src.materials)
        val r = MeshOps.simplify(soup, 600)
        assertTargetReached(r, 600)
        assertTrue(r.mesh.vertexCount < 600)
        assertEquals(0, MeshTopology.build(r.mesh).boundaryEdgeCount)

        val plain = Mesh(src.positions, null, null, null, src.indices, null, emptyList())
        val p = MeshOps.simplify(plain, 600)
        assertTargetReached(p, 600)
        assertEquals(null, p.mesh.uvs); assertEquals(null, p.mesh.normals)
        assertTrue(MeshOps.deviation(plain, p.mesh).maxRelativeToDiagonal < 0.02f)
    }

    @Test fun reportsWhenConstraintsStopEarly() {
        // a single quad cannot go below 2 faces without destroying its outline
        val quad = Fixtures.planeGrid(1, 1)
        val r = MeshOps.simplify(quad, 0)
        assertEquals(r.mesh.faceCount, r.faceCount)
        if (r.faceCount > 0) assertTrue(!r.targetReached)
        // extreme target on a closed surface: still a valid closed manifold, however coarse
        val s = MeshOps.simplify(Fixtures.uvSphere(1f, 32, 16), 4)
        val topo = MeshTopology.build(s.mesh)
        assertEquals(0, topo.boundaryEdgeCount); assertEquals(0, topo.nonManifoldEdgeCount)
        assertTrue(s.mesh.faceCount >= 4)
        assertEquals(s.faceCount <= 4, s.targetReached)
        assertTrue(MeshOps.signedVolume(s.mesh) > 0f)
    }

    @Test fun performance300kTo50k() {
        // 388 x 388 torus = 301,088 faces with uv seams and confidence
        val m = Fixtures.torus(1f, 0.4f, 388, 388, Fixtures.texturedMaterial())
        assertTrue(m.faceCount > 300_000)
        MeshOps.simplify(Fixtures.torus(1f, 0.4f, 120, 120), 5000) // JIT warm-up on a small mesh
        val t0 = System.nanoTime()
        val r = MeshOps.simplify(m, 50_000)
        val seconds = (System.nanoTime() - t0) / 1e9
        assertTargetReached(r, 50_000)
        val d = MeshOps.deviation(m, r.mesh)
        val line = "simplify ${m.faceCount} -> ${r.faceCount} faces: %.2f s, deviation mean %.5f%% max %.5f%% of diagonal".format(
            seconds, d.meanRelativeToDiagonal * 100, d.maxRelativeToDiagonal * 100,
        )
        println(line)
        File("build").mkdirs()
        File("build/simplify-timing.txt").writeText(line + "\n")
        assertTrue("simplification took $seconds s", seconds < 20.0)
        assertEquals(0, MeshTopology.build(r.mesh).boundaryEdgeCount)
        assertTrue(d.maxRelativeToDiagonal < 0.002f)
    }
}
