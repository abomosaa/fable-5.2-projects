package dev.pocket3d.viewer

import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.mesh.Aabb
import dev.pocket3d.core.mesh.MeshOps
import dev.pocket3d.core.mesh.MeshSelection
import dev.pocket3d.viewer.gl.TexturePolicy
import dev.pocket3d.viewer.gl.ThumbnailPixels
import dev.pocket3d.viewer.scene.EvidenceStats
import dev.pocket3d.viewer.scene.HoleList
import dev.pocket3d.viewer.scene.LineBuilder
import dev.pocket3d.viewer.scene.LineSet
import dev.pocket3d.viewer.scene.MeshBuffers
import dev.pocket3d.viewer.scene.SceneBuilders
import dev.pocket3d.viewer.scene.WireEdges
import dev.pocket3d.viewer.ui.strayFractionFromSlider
import dev.pocket3d.viewer.ui.straySliderFromFraction
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

class SceneGeometryTest {
    @Test fun holeListIsOrderedByPerimeterAndFlagsTheRim() {
        // 12×12 grid with a 1-quad hole, a 2×2 hole and a 3×1 hole; the outer rim is the longest loop
        val mesh = TestMeshes.grid(12, size = 12f) { i, j -> (i == 2 && j == 2) || (i in 5..6 && j in 5..6) || (i in 8..10 && j == 2) }
        val holes = MeshOps.findHoles(mesh)
        assertEquals(4, holes.size)
        val entries = HoleList.build(holes.shuffled(java.util.Random(3)), Aabb.of(mesh.positions).diagonal)
        val expected = listOf(48f, 8f, 8f, 4f)
        for (k in expected.indices) assertEquals(expected[k], entries[k].perimeter, 1e-4f)
        for (k in 1 until entries.size) assertTrue(entries[k - 1].perimeter >= entries[k].perimeter)
        assertEquals(holes.map { it.index }.toSet(), entries.map { it.index }.toSet())
        assertTrue(entries[0].likelyOuterRim)
        assertTrue(entries.drop(1).none { it.likelyOuterRim })
        // indices still address the engine's list
        for (e in entries) assertEquals(e.perimeter, holes[e.index].perimeter, 0f)
        assertEquals(8f, HoleList.defaultMaxPerimeter(entries), 1e-4f)
        assertEquals(3, HoleList.countUpTo(entries, 8.001f))
        assertEquals(1, HoleList.countUpTo(entries, 4.5f))
        assertEquals(0, HoleList.countUpTo(entries, 1f))
        // filling "all smaller than" the default leaves exactly the rim open
        val filled = MeshOps.fillHoles(mesh, null, HoleList.defaultMaxPerimeter(entries))
        assertEquals(3, filled.filledHoleCount)
        assertEquals(1, MeshOps.findHoles(filled.mesh).size)
        // a closed mesh has no entries; a lone small hole is not called a rim
        assertTrue(HoleList.build(MeshOps.findHoles(TestMeshes.sphere()), 2f).isEmpty())
        val sphereHole = MeshOps.removeFaces(TestMeshes.sphere(), BooleanArray(TestMeshes.sphere().faceCount) { it == 40 })
        assertFalse(HoleList.build(MeshOps.findHoles(sphereHole), 3.4f).single().likelyOuterRim)
    }

    @Test fun meshBuffersInterleaveAndGroupByMaterial() {
        val mesh = TestMeshes.grid(4, twoMaterials = true)
        val b = MeshBuffers.build(mesh)
        assertEquals(mesh.vertexCount, b.vertexCount)
        assertEquals(mesh.faceCount * 3, b.indexCount)
        assertEquals(mesh.vertexCount * MeshBuffers.STRIDE_BYTES, b.vertexData.capacity())
        assertEquals(ByteOrder.nativeOrder(), b.vertexData.order())
        val fb = b.vertexData.asFloatBuffer()
        for (v in 0 until mesh.vertexCount) {
            for (k in 0..2) assertEquals(mesh.positions[3 * v + k], fb.get(v * 9 + k), 0f)
            assertEquals(1f, fb.get(v * 9 + 4), 0f)                       // normal +Y
            assertEquals(mesh.uvs!![2 * v], fb.get(v * 9 + 6), 0f)
            assertEquals(mesh.confidence!![v], fb.get(v * 9 + 8), 0f)
        }
        // ranges are contiguous, cover everything, and every face in a range has that range's material
        assertEquals(2, b.ranges.size)
        assertEquals(0, b.ranges[0].first)
        assertEquals(b.ranges[0].count, b.ranges[1].first)
        assertEquals(b.indexCount, b.ranges.sumOf { it.count })
        val ib = b.indexData.asIntBuffer()
        val faceByKey = HashMap<List<Int>, Int>()
        for (f in 0 until mesh.faceCount) faceByKey[listOf(mesh.indices[3 * f], mesh.indices[3 * f + 1], mesh.indices[3 * f + 2])] = f
        var seen = 0
        for (r in b.ranges) for (t in 0 until r.count / 3) {
            val key = listOf(ib.get(r.first + 3 * t), ib.get(r.first + 3 * t + 1), ib.get(r.first + 3 * t + 2))
            val f = faceByKey[key] ?: throw AssertionError("triangle $key is not in the mesh (winding changed?)")
            assertEquals(r.materialIndex, mesh.materialOfFace(f))
            assertTrue(r.material === mesh.materials[r.materialIndex])
            seen++
        }
        assertEquals(mesh.faceCount, seen)
        assertTrue(b.hasUvs); assertTrue(b.hasConfidence)

        // no normals / uvs / confidence: normals are computed, confidence is neutral
        val cube = MeshBuffers.build(TestMeshes.cube())
        assertFalse(cube.hasUvs); assertFalse(cube.hasConfidence)
        val cf = cube.vertexData.asFloatBuffer()
        for (v in 0 until 8) {
            val n = Vec3(cf.get(v * 9 + 3), cf.get(v * 9 + 4), cf.get(v * 9 + 5))
            assertEquals(1f, n.length(), 1e-4f)
            // outward on a cube centred at the origin
            assertTrue(n.dot(Vec3(cf.get(v * 9), cf.get(v * 9 + 1), cf.get(v * 9 + 2))) > 0f)
            assertEquals(1f, cf.get(v * 9 + 8), 0f)
        }
    }

    @Test fun selectionBufferHoldsExactlyTheSelectedFaces() {
        val mesh = TestMeshes.grid(4)
        val mask = BooleanArray(mesh.faceCount) { it % 5 == 0 }
        val bb = MeshBuffers.selectionIndices(mesh, mask)
        val n = MeshSelection.count(mask)
        assertEquals(n * 12, bb.capacity())
        val ib = bb.asIntBuffer()
        var k = 0
        for (f in mask.indices) if (mask[f]) for (c in 0..2) assertEquals(mesh.indices[3 * f + c], ib.get(k++))
        assertEquals(0, MeshBuffers.selectionIndices(mesh, BooleanArray(mesh.faceCount)).capacity())
    }

    @Test fun wireEdgesAreUnique() {
        val cube = WireEdges.build(TestMeshes.cube().indices)
        assertEquals(18 * 2, cube.size)                     // 12 cube edges + 6 face diagonals
        val set = HashSet<Pair<Int, Int>>()
        for (i in cube.indices step 2) { assertTrue(cube[i] < cube[i + 1]); assertTrue(set.add(cube[i] to cube[i + 1])) }
        // closed manifold: E = 3F / 2
        val s = TestMeshes.sphere()
        assertEquals(s.faceCount * 3 / 2 * 2, WireEdges.build(s.indices).size)
        assertEquals(0, WireEdges.build(IntArray(0)).size)
        assertEquals(cube.size * 4, WireEdges.toBuffer(cube).capacity())
    }

    @Test fun wideLineVerticesFormTwoTrianglesPerSegment() {
        val set = LineBuilder(1).add(Vec3(1f, 2f, 3f), Vec3(4f, 5f, 6f), 0x80FF8040.toInt()).add(Vec3.ZERO, Vec3.X, -1).build(3f, depthTest = false)
        assertEquals(2, set.segmentCount)
        val v = set.toVertexData()
        assertEquals(2 * 6 * LineSet.VERTEX_FLOATS, v.size)
        val corners = HashSet<Pair<Float, Float>>()
        for (c in 0 until 6) {
            val o = c * LineSet.VERTEX_FLOATS
            assertEquals(listOf(1f, 2f, 3f, 4f, 5f, 6f), v.slice(o until o + 6))
            corners += v[o + 6] to v[o + 7]
            assertEquals(1f, v[o + 8], 1e-6f); assertEquals(128 / 255f, v[o + 9], 1e-6f)
            assertEquals(64 / 255f, v[o + 10], 1e-6f); assertEquals(128 / 255f, v[o + 11], 1e-6f)
        }
        // all four corners of the quad are used
        assertEquals(setOf(-1f to 0f, 1f to 0f, -1f to 1f, 1f to 1f), corners)
        // the two triangles share the diagonal and wind the same way: (side, end) signed areas agree
        fun area(i: Int): Float {
            val p = (0..2).map { v[(i + it) * LineSet.VERTEX_FLOATS + 6] to v[(i + it) * LineSet.VERTEX_FLOATS + 7] }
            return (p[1].first - p[0].first) * (p[2].second - p[0].second) - (p[2].first - p[0].first) * (p[1].second - p[0].second)
        }
        assertTrue(area(0) * area(3) > 0f)
        assertFalse(set.depthTest); assertEquals(3f, set.widthPx, 0f)
    }

    @Test fun gridAndGuides() {
        assertEquals(0.1f, SceneBuilders.niceStep(1f), 1e-6f)
        assertEquals(0.2f, SceneBuilders.niceStep(2.4f), 1e-6f)
        assertEquals(0.5f, SceneBuilders.niceStep(4f), 1e-6f)
        assertEquals(100f, SceneBuilders.niceStep(900f), 1e-3f)
        assertEquals(1f, SceneBuilders.niceStep(0f), 0f)
        val g = SceneBuilders.grid(Vec3(1f, -2f, 3f), Vec3.Y, 0.95f, 0.2f)
        assertEquals((2 * 5 + 1) * 2 * 6, g.size)
        for (i in g.indices step 3) {
            assertEquals(-2f, g[i + 1], 1e-6f)
            assertTrue(kotlin.math.abs(g[i] - 1f) <= 1.0001f && kotlin.math.abs(g[i + 2] - 3f) <= 1.0001f)
        }
        val (u, v) = SceneBuilders.planeBasis(Vec3(0.3f, 0.8f, -0.5f).normalized())
        assertEquals(0f, u.dot(v), 1e-5f); assertEquals(0f, u.dot(Vec3(0.3f, 0.8f, -0.5f)), 1e-5f)
        val b = LineBuilder()
        SceneBuilders.addSphere(b, Vec3(1f, 1f, 1f), 2f, -1)
        val s = b.build(1f)
        for (i in 0 until s.segmentCount) assertEquals(2f, Vec3.of(s.segments, i * 6).distanceTo(Vec3(1f, 1f, 1f)), 1e-4f)
    }

    @Test fun evidenceSharesAddUp() {
        // confidence = x fraction on a uniform grid: thirds of the area fall predictably
        val mesh = TestMeshes.grid(20)
        val e = EvidenceStats.of(mesh)
        assertTrue(e.hasConfidence)
        assertEquals(1f, e.wellSupported + e.weak + e.none + e.repaired, 1e-5f)
        assertEquals(0.5f, e.wellSupported, 0.04f)
        assertEquals(0.35f, e.weak, 0.04f)
        assertEquals(0.15f, e.none, 0.04f)
        assertEquals(0f, e.repaired, 0f)
        // repaired patches are counted separately, never as observed
        val open = TestMeshes.grid(8) { i, j -> i in 3..4 && j in 3..4 }
        val small = MeshOps.findHoles(open).minByOrNull { it.perimeter }!!
        val filled = MeshOps.fillHoles(open, setOf(small.index)).mesh
        val ef = EvidenceStats.of(filled)
        assertEquals(4f / 64f, ef.repaired, 1e-3f)
        assertEquals(MeshOps.stats(filled).repairedAreaFraction, ef.repaired, 1e-4f)
        val none = EvidenceStats.of(TestMeshes.cube())
        assertFalse(none.hasConfidence)
    }

    @Test fun realModelBuffersAndAnalysis() {
        assumeTrue(TestMeshes.REAL_GLB.isFile)
        val mesh = dev.pocket3d.core.mesh.GlbReader.read(TestMeshes.REAL_GLB).mesh
        val b = MeshBuffers.build(mesh)
        assertEquals(mesh.faceCount, b.faceCount)
        assertEquals(mesh.materials.size, b.ranges.size)
        assertTrue(b.hasConfidence && b.hasUvs)
        val e = EvidenceStats.of(mesh)
        assertEquals(1f, e.wellSupported + e.weak + e.none + e.repaired, 1e-4f)
        assertTrue(e.wellSupported > 0.5f)
        val holes = MeshOps.findHoles(mesh)
        val entries = HoleList.build(holes, b.bounds.diagonal)
        assertEquals(holes.size, entries.size)
        for (k in 1 until entries.size) assertTrue(entries[k - 1].perimeter >= entries[k].perimeter)
        val edges = WireEdges.build(mesh.indices)
        assertTrue(edges.size / 2 in mesh.faceCount..mesh.faceCount * 3)
    }

    @Test fun texturePolicyRespectsGpuLimitAndBudget() {
        // fits: untouched
        assertTrue(intArrayOf(1, 1).contentEquals(TexturePolicy.sampleSizes(listOf(4096 to 4096, 4096 to 4096), 4096, 50_000_000)))
        // larger than the GPU limit: halved until it fits
        assertTrue(intArrayOf(2).contentEquals(TexturePolicy.sampleSizes(listOf(8192 to 8192), 4096, 500_000_000)))
        assertTrue(intArrayOf(4, 1).contentEquals(TexturePolicy.sampleSizes(listOf(8192 to 4096, 2048 to 2048), 2048, 500_000_000)))
        // over budget: the largest page gives way first, and the total ends within budget
        val sizes = listOf(8192 to 8192, 4096 to 4096, 1024 to 1024)
        val s = TexturePolicy.sampleSizes(sizes, 8192, 40_000_000)
        val total = sizes.indices.sumOf { (sizes[it].first / s[it]).toLong() * (sizes[it].second / s[it]) }
        assertTrue(total <= 40_000_000)
        assertEquals(1, s[2])
        assertTrue(s[0] >= 2)
        // an impossible budget terminates and never goes below a usable size
        val tiny = TexturePolicy.sampleSizes(listOf(4096 to 4096), 4096, 1)
        assertTrue(4096 / tiny[0] in 128..256)
        assertEquals(0, TexturePolicy.sampleSizes(emptyList(), 4096, 1).size)
    }

    @Test fun thumbnailPixelsAreFlippedAndAveraged() {
        // 4×4 RGBA, bottom row first: bottom rows red, top rows blue; left half darker
        val size = 4
        val buf = ByteBuffer.allocateDirect(size * size * 4).order(ByteOrder.nativeOrder())
        for (y in 0 until size) for (x in 0 until size) {
            val v = if (x < 2) 100 else 200
            buf.put(if (y < 2) v.toByte() else 0); buf.put(0); buf.put(if (y >= 2) v.toByte() else 0); buf.put(255.toByte())
        }
        val full = ThumbnailPixels.toArgb(buf, size, 1)
        assertEquals(16, full.size)
        assertEquals(0xFF000064.toInt(), full[0])                 // top-left = top GL row = blue, dark
        assertEquals(0xFF0000C8.toInt(), full[3])
        assertEquals(0xFF640000.toInt(), full[12])                // bottom-left = red
        val half = ThumbnailPixels.toArgb(buf, size, 2)
        assertEquals(listOf(0xFF000064.toInt(), 0xFF0000C8.toInt(), 0xFF640000.toInt(), 0xFFC80000.toInt()), half.toList())
        // the thumbnail camera frames the model in a square
        val bounds = Aabb(Vec3(-1f, 0f, -0.2f), Vec3(1f, 3f, 0.2f))
        val snap = ThumbnailPixels.camera(bounds)
        for (i in 0 until 8) {
            val c = Vec3(if (i and 1 == 0) -1f else 1f, if (i and 2 == 0) 0f else 3f, if (i and 4 == 0) -0.2f else 0.2f)
            val s = snap.camera.project(c, 512, 512)!!
            assertTrue(s.x in 0f..512f && s.y in 0f..512f)
        }
        assertTrue(snap.camera.eye.y > bounds.center.y)           // seen slightly from above
    }

    @Test fun straySliderIsLogarithmicAndInvertible() {
        assertEquals(1e-4f, strayFractionFromSlider(0f), 1e-9f)
        assertEquals(1f, strayFractionFromSlider(1f), 1e-6f)
        assertEquals(0.01f, strayFractionFromSlider(0.5f), 1e-6f)
        for (v in listOf(0f, 0.2f, 0.5f, 0.77f, 1f)) assertEquals(v, straySliderFromFraction(strayFractionFromSlider(v)), 1e-4f)
    }
}
