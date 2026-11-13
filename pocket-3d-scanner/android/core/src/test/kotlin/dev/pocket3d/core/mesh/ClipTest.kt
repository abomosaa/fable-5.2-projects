package dev.pocket3d.core.mesh

import dev.pocket3d.core.math.Quat
import dev.pocket3d.core.math.Vec3
import kotlinx.serialization.json.Json
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sqrt

class ClipTest {
    private fun signedDistance(p: Vec3, point: Vec3, n: Vec3) = (p - point).dot(n.normalized())

    private fun assertAllOnKeptSide(m: Mesh, point: Vec3, n: Vec3, eps: Float = 2e-6f) {
        for (v in 0 until m.vertexCount) {
            val d = signedDistance(m.position(v), point, n)
            assertTrue("vertex $v is $d behind the plane", d >= -eps)
        }
    }

    @Test fun sphereCapAreaMatchesAnalyticValue() {
        val sphere = Fixtures.uvSphere(1f, 96, 48)
        val before = sphere.positions.copyOf(); val beforeIdx = sphere.indices.copyOf()
        // an oblique plane, so that it crosses triangles everywhere rather than following a ring
        val n = Vec3(0.3f, 1f, -0.2f).normalized()
        val h = 0.37f
        val point = n * h
        val cap = MeshOps.clipByPlane(sphere, point, n)
        assertArrayEquals(before, sphere.positions, 0f); assertArrayEquals(beforeIdx, sphere.indices)

        assertAllOnKeptSide(cap, point, n)
        assertEquals(2 * PI * (1 - h), MeshOps.surfaceArea(cap).toDouble(), 2 * PI * (1 - h) * 0.005)
        // the two halves add up exactly to the whole
        val rest = MeshOps.clipByPlane(sphere, point, -n)
        assertAllOnKeptSide(rest, point, -n)
        assertEquals(MeshOps.surfaceArea(sphere), MeshOps.surfaceArea(cap) + MeshOps.surfaceArea(rest), 1e-4f)
        assertTrue(Fixtures.minFaceArea(cap) > 0f)

        // the cut is one closed loop lying on the plane, a circle of radius sqrt(1 - h^2)
        val topo = MeshTopology.build(cap)
        assertEquals(0, topo.nonManifoldEdgeCount)
        assertEquals(1, topo.faceComponents().count)
        val holes = MeshOps.findHoles(cap)
        assertEquals(1, holes.size)
        assertEquals(topo.boundaryEdgeCount, holes[0].edgeCount)
        for (i in 0 until holes[0].edgeCount) assertEquals(0f, signedDistance(holes[0].vertex(i), point, n), 2e-6f)
        val r = sqrt(1.0 - h * h)
        assertEquals(2 * PI * r, holes[0].perimeter.toDouble(), 2 * PI * r * 0.003)
        assertEquals(PI * r * r, holes[0].area.toDouble(), PI * r * r * 0.005)
        assertTrue(holes[0].centroid.distanceTo(point) < 2e-3f)

        // normals stay unit length and outward, winding is preserved
        for (f in 0 until cap.faceCount) assertTrue(Fixtures.faceNormal(cap, f).dot(Fixtures.centroid(cap, f)) > 0f)
        for (v in 0 until cap.vertexCount) {
            val nv = Vec3.of(cap.normals!!, 3 * v)
            assertEquals(1f, nv.length(), 1e-5f)
            assertTrue(nv.dot(cap.position(v).normalized()) > 0.999f)
        }
        // capping the cut (explicit repair) gives a closed solid with the volume of a spherical cap
        val closed = MeshOps.fillHoles(cap).mesh
        assertEquals(0, MeshTopology.build(closed).boundaryEdgeCount)
        val capHeight = 1.0 - h
        assertEquals(PI * capHeight * capHeight * (3 - capHeight) / 3, MeshOps.signedVolume(closed).toDouble(), 0.01)
    }

    @Test fun interpolatesUvNormalAndConfidenceOnPlanarGrid() {
        // on this grid uv = (x, z) / 2 and confidence = x / 2, all linear in position
        val grid = Fixtures.planeGrid(9, 7, 2f, Fixtures.texturedMaterial())
        val point = Vec3(0.83f, 0f, 1.1f)
        val n = Vec3(1f, 0f, 0.45f)
        val cut = MeshOps.clipByPlane(grid, point, n)
        assertAllOnKeptSide(cut, point, n)
        assertTrue(cut.vertexCount > 0)
        var newVertices = 0
        for (v in 0 until cut.vertexCount) {
            val p = cut.position(v)
            assertEquals(p.x / 2f, cut.uvs!![2 * v], 1e-6f)
            assertEquals(p.z / 2f, cut.uvs!![2 * v + 1], 1e-6f)
            assertEquals(p.x / 2f, cut.confidence!![v], 1e-6f)
            assertEquals(Vec3(0f, 1f, 0f), Vec3.of(cut.normals!!, 3 * v))
            assertEquals(0f, p.y, 0f)
            if (abs(signedDistance(p, point, n)) < 2e-6f) newVertices++
        }
        assertTrue(newVertices > 5)
        for (f in 0 until cut.faceCount) assertTrue("winding must be kept", Fixtures.faceNormal(cut, f).y > 0f)
        // area of the kept part of the 2 x 2 square, computed by clipping the square polygon analytically
        assertEquals(clippedSquareArea(2f, point, n), MeshOps.surfaceArea(cut).toDouble(), 1e-5)
        assertEquals(1, cut.materials.size)
        // shared cut vertices: no cracks (one boundary loop, one component) and no T-junction duplicates
        val topo = MeshTopology.build(cut)
        assertEquals(1, topo.boundaryLoops().size)
        assertEquals(1, topo.faceComponents().count)
        assertEquals(cut.vertexCount, topo.weldedCount)
    }

    /** Area of {(x, z) in [0, size]^2 : (p - point) . n >= 0} by Sutherland-Hodgman on the square. */
    private fun clippedSquareArea(size: Float, point: Vec3, n: Vec3): Double {
        val poly = listOf(0.0 to 0.0, size.toDouble() to 0.0, size.toDouble() to size.toDouble(), 0.0 to size.toDouble())
        fun d(p: Pair<Double, Double>) = (p.first - point.x) * n.x + (p.second - point.z) * n.z
        val out = ArrayList<Pair<Double, Double>>()
        for (i in poly.indices) {
            val a = poly[i]; val b = poly[(i + 1) % poly.size]
            val da = d(a); val db = d(b)
            if (da >= 0) out.add(a)
            if ((da >= 0) != (db >= 0)) { val t = da / (da - db); out.add(a.first + t * (b.first - a.first) to a.second + t * (b.second - a.second)) }
        }
        var area = 0.0
        for (i in out.indices) { val a = out[i]; val b = out[(i + 1) % out.size]; area += a.first * b.second - b.first * a.second }
        return abs(area) / 2
    }

    @Test fun seamDuplicatesAreCutIdentically() {
        // the plane crosses the u seam of the sphere and of the torus: the cut must not open the seam
        for (m in listOf(Fixtures.uvSphere(1f, 40, 20), Fixtures.torus(1f, 0.4f, 40, 20))) {
            val n = Vec3(0.05f, 0.2f, 1f)
            val cut = MeshOps.clipByPlane(m, Vec3(0.01f, 0.02f, 0.03f), n)
            val topo = MeshTopology.build(cut)
            assertEquals(0, topo.nonManifoldEdgeCount)
            for (e in topo.boundaryEdges()) {
                for (w in intArrayOf(topo.edgeV0[e], topo.edgeV1[e])) {
                    val d = signedDistance(cut.position(topo.weldedRepresentative[w]), Vec3(0.01f, 0.02f, 0.03f), n)
                    assertEquals("boundary vertices must all lie on the cut plane", 0f, d, 3e-6f)
                }
            }
            for (v in 0 until cut.vertexCount) { assertTrue(cut.uvs!![2 * v] in 0f..1f); assertTrue(cut.uvs!![2 * v + 1] in 0f..1f) }
        }
        // sphere: one cut circle; torus cut through its hole: two
        assertEquals(1, MeshOps.findHoles(MeshOps.clipByPlane(Fixtures.uvSphere(1f, 40, 20), Vec3(0.01f, 0.02f, 0.03f), Vec3(0.05f, 0.2f, 1f))).size)
        val torusCut = MeshOps.clipByPlane(Fixtures.torus(1f, 0.4f, 40, 20), Vec3.ZERO, Vec3(0f, 0f, 1f))
        assertEquals(2, MeshOps.findHoles(torusCut).size)
        assertEquals(1, MeshOps.components(torusCut).count)
    }

    @Test fun planeThroughVerticesAndTrivialCases() {
        val grid = Fixtures.planeGrid(4, 4, 4f)
        // plane exactly through a grid line: no new vertices, no degenerate faces
        val half = MeshOps.clipByPlane(grid, Vec3(2f, 0f, 0f), Vec3(1f, 0f, 0f))
        assertEquals(16, half.faceCount)
        assertEquals(15, half.vertexCount)
        assertEquals(8f, MeshOps.surfaceArea(half), 1e-5f)
        assertTrue(Fixtures.minFaceArea(half) > 0.4f)
        // everything kept / everything removed
        val all = MeshOps.clipByPlane(grid, Vec3(-1f, 0f, 0f), Vec3(1f, 0f, 0f))
        assertArrayEquals(grid.positions, all.positions, 0f); assertArrayEquals(grid.indices, all.indices)
        val none = MeshOps.clipByPlane(grid, Vec3(5f, 0f, 0f), Vec3(1f, 0f, 0f))
        assertEquals(0, none.faceCount); assertEquals(0, none.vertexCount)
        // un-normalised normal gives the same result as a unit normal
        val a = MeshOps.clipByPlane(grid, Vec3(1.3f, 0f, 0f), Vec3(10f, 0f, 3f))
        val b = MeshOps.clipByPlane(grid, Vec3(1.3f, 0f, 0f), Vec3(10f, 0f, 3f).normalized())
        assertEquals(MeshOps.surfaceArea(b), MeshOps.surfaceArea(a), 1e-5f)
        assertThrows(IllegalArgumentException::class.java) { MeshOps.clipByPlane(grid, Vec3.ZERO, Vec3.ZERO) }
    }

    @Test fun clipKeepsPerFaceMaterials() {
        val a = Fixtures.planeGrid(4, 4, 1f, Material("a"))
        val b = Fixtures.translate(Fixtures.planeGrid(4, 4, 1f, Material("b", repaired = true)), Vec3(1f, 0f, 0f))
        val m = Fixtures.merge(a, b)
        val cut = MeshOps.clipByPlane(m, Vec3(0f, 0f, 0.37f), Vec3(0f, 0f, 1f))
        assertEquals(listOf("a", "b"), cut.materials.map { it.name })
        for (f in 0 until cut.faceCount) {
            val expected = if (Fixtures.centroid(cut, f).x < 1f) 0 else 1
            assertEquals(expected, cut.materialOfFace(f))
        }
        assertEquals(0.63, Fixtures.areaOf(cut) { cut.materials[cut.materialOfFace(it)].repaired }, 1e-5)
        // clipping away one material drops it
        val onlyA = MeshOps.clipByPlane(m, Vec3(0.9f, 0f, 0f), Vec3(-1f, 0f, 0f))
        assertEquals(listOf("a"), onlyA.materials.map { it.name })
    }

    @Test fun cropToOrientedBoxClipsExactly() {
        val sphere = Fixtures.uvSphere(1f, 64, 32)
        val box = OrientedBox(Vec3(0.2f, 0.1f, 0f), Quat.axisAngle(Vec3(0f, 0f, 1f), 0.5f), Vec3(0.6f, 2f, 2f))
        val cropped = MeshOps.cropToBox(sphere, box)
        assertTrue(cropped.faceCount > 0)
        for (v in 0 until cropped.vertexCount) {
            val l = box.toLocal(cropped.position(v))
            assertTrue(abs(l.x) <= 0.6f + 3e-6f)
        }
        // the slab |x'| <= 0.6 through a unit sphere, offset c from the centre along x': a zone of area 2 pi (h1 + h2)
        val c = box.toLocal(Vec3.ZERO).x // sphere centre in box coordinates
        val lo = maxOf(-1f, -0.6f - c); val hi = minOf(1f, 0.6f - c)
        assertEquals(2 * PI * (hi - lo), MeshOps.surfaceArea(cropped).toDouble(), 0.03)
        assertEquals(2, MeshOps.findHoles(cropped).size)
        assertTrue(Fixtures.minFaceArea(cropped) > 0f)
        for (f in 0 until cropped.faceCount) assertTrue(Fixtures.faceNormal(cropped, f).dot(Fixtures.centroid(cropped, f)) > 0f)
        // a box that contains everything changes nothing
        val same = MeshOps.cropToBox(sphere, OrientedBox(Vec3.ZERO, Quat.IDENTITY, Vec3(2f, 2f, 2f)))
        assertArrayEquals(sphere.indices, same.indices)
    }

    @Test fun cropByCentroidAndOutside() {
        val grid = Fixtures.planeGrid(10, 10, 10f)
        val box = OrientedBox(Vec3(5f, 0f, 5f), Quat.IDENTITY, Vec3(2.5f, 1f, 2.5f))
        val inside = MeshOps.cropToBox(grid, box, keepInside = true, clip = false)
        val outside = MeshOps.cropToBox(grid, box, keepInside = false, clip = false)
        val expectedInside = (0 until grid.faceCount).count { box.contains(Fixtures.centroid(grid, it)) }
        assertTrue(expectedInside in 40..60)
        assertEquals(expectedInside, inside.faceCount)
        assertEquals(grid.faceCount - expectedInside, outside.faceCount)
        // whole faces: areas are multiples of half a cell
        assertEquals(expectedInside * 0.5f, MeshOps.surfaceArea(inside), 1e-4f)
        // keepInside = false with clip = true is documented to fall back to whole-face removal
        val fallback = MeshOps.cropToBox(grid, box, keepInside = false, clip = true)
        assertArrayEquals(outside.indices, fallback.indices)
        // exact clip for comparison: the 5 x 5 square
        assertEquals(25f, MeshOps.surfaceArea(MeshOps.cropToBox(grid, box)), 1e-4f)
    }

    @Test fun orientedBoxSerializesAndContains() {
        val box = OrientedBox(Vec3(1f, 2f, 3f), Quat.axisAngle(Vec3.Y, (PI / 2).toFloat()), Vec3(1f, 0.5f, 0.25f))
        val json = Json.encodeToString(OrientedBox.serializer(), box)
        assertEquals(box, Json.decodeFromString(OrientedBox.serializer(), json))
        // rotating +90 deg about Y maps local +X to world -Z
        assertTrue(box.axis(0).distanceTo(Vec3(0f, 0f, -1f)) < 1e-6f)
        assertTrue(box.contains(Vec3(1f, 2f, 3f - 0.9f)))
        assertTrue(!box.contains(Vec3(1.9f, 2f, 3f)))
        assertTrue(box.contains(Vec3(1.2f, 2.4f, 3f)))
        val aabb = OrientedBox.of(Aabb(Vec3(0f, 0f, 0f), Vec3(2f, 4f, 6f)))
        assertEquals(Vec3(1f, 2f, 3f), aabb.center); assertEquals(Vec3(1f, 2f, 3f), aabb.halfExtents)
    }
}
