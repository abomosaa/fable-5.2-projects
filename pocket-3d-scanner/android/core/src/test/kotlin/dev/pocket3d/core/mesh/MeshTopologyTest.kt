package dev.pocket3d.core.mesh

import dev.pocket3d.core.math.Vec3
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI

class MeshTopologyTest {
    @Test fun fixturesAreClosedAndOutwardOriented() {
        val sphere = Fixtures.uvSphere(1f, 64, 32)
        assertEquals(4.0 / 3.0 * PI, MeshOps.signedVolume(sphere).toDouble(), 0.02)
        val torus = Fixtures.torus(1f, 0.35f, 96, 48)
        assertEquals(2 * PI * PI * 0.35 * 0.35, MeshOps.signedVolume(torus).toDouble(), 0.02)
        for (m in listOf(sphere, torus)) {
            val t = MeshTopology.build(m)
            assertEquals(0, t.boundaryEdgeCount)
            assertEquals(0, t.nonManifoldEdgeCount)
            // vertex normals of the fixtures agree with face winding
            for (f in 0 until m.faceCount) {
                val n = Fixtures.faceNormal(m, f)
                val v = m.indices[3 * f + 1]
                assertTrue(n.dot(Vec3(m.normals!![3 * v], m.normals!![3 * v + 1], m.normals!![3 * v + 2])) > 0f)
            }
        }
    }

    @Test fun weldsSeamDuplicates() {
        val segments = 16; val rings = 8
        val m = Fixtures.uvSphere(1f, segments, rings)
        val t = MeshTopology.build(m)
        assertEquals((segments + 1) * (rings + 1) - 2, m.vertexCount)
        assertEquals(2 * segments * (rings - 1), m.faceCount)
        assertEquals(m.vertexCount, m.indices.toSet().size)
        // 2 poles + (rings - 1) rings of `segments` distinct points
        assertEquals(2 + (rings - 1) * segments, t.weldedCount)
        // Euler characteristic of a sphere: V - E + F = 2
        assertEquals(2, t.weldedCount - t.edgeCount + m.faceCount)
        // welded vertices really share a position, representatives are the lowest index
        for (v in 0 until m.vertexCount) {
            val r = t.weldedRepresentative[t.weldOf[v]]
            assertTrue(r <= v)
            assertEquals(m.position(r), m.position(v))
        }
        // every edge has exactly two faces and opposite half-edges are mutual
        for (e in 0 until t.edgeCount) assertEquals(2, t.edgeFaceCount(e))
        for (f in 0 until m.faceCount) for (k in 0 until 3) {
            val g = t.adjacentFace(f, k)
            assertTrue(g >= 0 && g != f)
            assertTrue((0 until 3).any { t.adjacentFace(g, it) == f })
        }
    }

    @Test fun torusEulerCharacteristicIsZero() {
        val m = Fixtures.torus(1f, 0.3f, 20, 10)
        val t = MeshTopology.build(m)
        assertEquals(20 * 10, t.weldedCount)
        assertEquals(0, t.weldedCount - t.edgeCount + m.faceCount)
        assertEquals(1, t.faceComponents().count)
    }

    @Test fun negativeZeroWeldsWithPositiveZero() {
        val m = Mesh(
            floatArrayOf(0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f, 0f, -0f, 0f, -0f, 1f, 0f, 0f, 0f, 0f, 1f),
            null, null, null, intArrayOf(0, 1, 2, 3, 5, 4), null, emptyList(),
        )
        val t = MeshTopology.build(m)
        assertEquals(4, t.weldedCount)
        assertEquals(5, t.edgeCount)
        assertEquals(1, t.faceComponents().count)
    }

    @Test fun boundaryLoopsOfOpenCylinderAreOrderedAndClosed() {
        val segments = 24
        val m = Fixtures.openCylinder(1f, 2f, segments, 5)
        val t = MeshTopology.build(m)
        assertEquals(2 * segments, t.boundaryEdgeCount)
        assertEquals(2 * segments, t.boundaryEdges().size)
        val loops = t.boundaryLoops()
        val he = t.boundaryLoopHalfEdges()
        assertEquals(2, loops.size)
        for ((li, loop) in loops.withIndex()) {
            assertEquals(segments, loop.size)
            assertEquals(segments, loop.toSet().size)
            val y = m.position(t.weldedRepresentative[loop[0]]).y
            for (i in loop.indices) {
                // consecutive vertices are joined by the boundary half-edge listed for the loop
                val h = he[li][i]
                assertEquals(loop[i], t.faceWelded[h])
                assertEquals(loop[(i + 1) % loop.size], t.faceWelded[MeshTopology.nextInFace(h)])
                assertTrue(t.isBoundaryEdge(t.faceEdges[h]))
                assertEquals(y, m.position(t.weldedRepresentative[loop[i]]).y, 0f)
            }
        }
        // loop direction follows face winding: for outward faces the top rim runs clockwise seen from +Y
        val top = loops.first { m.position(t.weldedRepresentative[it[0]]).y > 1f }
        var twiceArea = 0.0
        for (i in top.indices) {
            val a = m.position(t.weldedRepresentative[top[i]]); val b = m.position(t.weldedRepresentative[top[(i + 1) % top.size]])
            twiceArea += a.z * b.x - a.x * b.z // signed area about +Y
        }
        assertTrue("top rim must run clockwise about +Y, got $twiceArea", twiceArea < 0)
    }

    @Test fun planeHasOneBoundaryLoop() {
        val m = Fixtures.planeGrid(7, 5)
        val t = MeshTopology.build(m)
        assertEquals(2 * (7 + 5), t.boundaryEdgeCount)
        assertEquals(1, t.boundaryLoops().size)
        assertEquals(2 * (7 + 5), t.boundaryLoops()[0].size)
        assertEquals(m.vertexCount, t.weldedCount)
    }

    @Test fun bowTieBoundaryLoopsAreSeparated() {
        // two triangles sharing only one vertex: two loops of three edges each
        val m = Mesh(
            floatArrayOf(0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f, 0f, -1f, 0f, 0f, 0f, -1f, 0f),
            null, null, null, intArrayOf(0, 1, 2, 0, 3, 4), null, emptyList(),
        )
        val t = MeshTopology.build(m)
        val loops = t.boundaryLoops()
        assertEquals(2, loops.size)
        assertEquals(listOf(3, 3), loops.map { it.size })
        assertEquals(2, t.faceComponents().count) // vertex contact does not connect faces
    }

    @Test fun pinchedHoleLoopsAreSeparated() {
        // 4x4 grid, remove two diagonal cells that touch in one vertex: 2 holes + outer rim
        val g = Fixtures.planeGrid(4, 4)
        val remove = BooleanArray(g.faceCount)
        fun cell(ix: Int, iz: Int) { remove[2 * (iz * 4 + ix)] = true; remove[2 * (iz * 4 + ix) + 1] = true }
        cell(1, 1); cell(2, 2)
        val m = MeshOps.removeFaces(g, remove)
        val loops = MeshTopology.build(m).boundaryLoops()
        assertEquals(listOf(4, 4, 16), loops.map { it.size }.sorted())
    }

    @Test fun detectsNonManifoldEdge() {
        // three triangles around one edge
        val m = Mesh(
            floatArrayOf(0f, 0f, 0f, 0f, 1f, 0f, 1f, 0f, 0f, -1f, 0f, 0f, 0f, 0f, 1f),
            null, null, null, intArrayOf(0, 1, 2, 1, 0, 3, 0, 1, 4), null, emptyList(),
        )
        val t = MeshTopology.build(m)
        assertEquals(1, t.nonManifoldEdgeCount)
        val e = t.nonManifoldEdges()[0]
        assertEquals(3, t.edgeFaceCount(e))
        assertEquals(setOf(0, 1), setOf(t.edgeV0[e], t.edgeV1[e]))
        assertEquals(setOf(0, 1, 2), (0 until 3).map { t.edgeFace(e, it) }.toSet())
        assertEquals(6, t.boundaryEdgeCount)
        assertEquals(-1, t.adjacentFace(0, 0))
        assertEquals(1, t.faceComponents().count)
    }

    @Test fun degenerateFacesAreIsolated() {
        val m = Mesh(
            floatArrayOf(0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 0f),
            null, null, null, intArrayOf(0, 1, 2, 0, 3, 1), null, emptyList(),
        )
        val t = MeshTopology.build(m)
        assertEquals(3, t.edgeCount)
        assertArrayEquals(intArrayOf(-1, -1, -1), t.faceEdges.copyOfRange(3, 6))
        assertEquals(2, t.faceComponents().count)
    }

    @Test fun faceComponentsOfDisjointMeshes() {
        val a = Fixtures.uvSphere(1f, 12, 6)
        val b = Fixtures.translate(Fixtures.torus(1f, 0.2f, 10, 6), Vec3(5f, 0f, 0f))
        val m = Fixtures.merge(a, b)
        val c = MeshTopology.build(m).faceComponents()
        assertEquals(2, c.count)
        for (f in 0 until m.faceCount) assertEquals(if (f < a.faceCount) 0 else 1, c.faceComponent[f])
    }

    @Test fun emptyMesh() {
        val t = MeshTopology.build(Mesh(FloatArray(0), null, null, null, IntArray(0), null, emptyList()))
        assertEquals(0, t.weldedCount); assertEquals(0, t.edgeCount)
        assertEquals(0, t.boundaryLoops().size); assertEquals(0, t.faceComponents().count)
    }
}
