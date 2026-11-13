package dev.pocket3d.core.mesh

import dev.pocket3d.core.math.Vec3
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sqrt

class HolesTest {
    private fun isRepaired(m: Mesh, f: Int) = m.materials[m.materialOfFace(f)].repaired

    /** Sphere of radius 1 with the cap above ring `cutRing` (of 32) removed; returns mesh and the cut height. */
    private fun openSphere(cutRing: Int): Pair<Mesh, Double> {
        val rings = 32
        val s = Fixtures.uvSphere(1f, 64, rings, Fixtures.texturedMaterial())
        val yCut = Math.cos(PI * cutRing / rings)
        val m = MeshOps.removeFaces(s, BooleanArray(s.faceCount) { Fixtures.centroid(s, it).y > yCut })
        return m to yCut
    }

    @Test fun findsHoleOfSphereWithCapRemoved() {
        val (m, yCut) = openSphere(6)
        val holes = MeshOps.findHoles(m)
        assertEquals(1, holes.size)
        val h = holes[0]
        val r = sqrt(1 - yCut * yCut)
        assertEquals(0, h.index)
        assertEquals(64, h.edgeCount)
        assertEquals(3 * 64, h.vertices.size)
        assertEquals(2 * PI * r, h.perimeter.toDouble(), 2 * PI * r * 0.003)
        assertEquals(PI * r * r, h.area.toDouble(), PI * r * r * 0.005)
        assertTrue(h.centroid.distanceTo(Vec3(0f, yCut.toFloat(), 0f)) < 1e-4f)
        // a patch continuing the surface faces outward: +Y here
        assertTrue(h.normal.distanceTo(Vec3(0f, 1f, 0f)) < 1e-4f)
        for (i in 0 until h.edgeCount) {
            assertEquals(yCut.toFloat(), h.vertex(i).y, 1e-6f)
            // ordered: consecutive vertices are one rim edge apart
            assertEquals(2 * r * Math.sin(PI / 64), h.vertex(i).distanceTo(h.vertex((i + 1) % 64)).toDouble(), 1e-5)
        }
    }

    @Test fun fillClosesSphereAndFlagsRepairedSurface() {
        val (m, yCut) = openSphere(6)
        val snapshotPos = m.positions.copyOf(); val snapshotIdx = m.indices.copyOf()
        val result = MeshOps.fillHoles(m)
        val filled = result.mesh
        // input untouched, original geometry is an untouched prefix of the result
        assertArrayEquals(snapshotPos, m.positions, 0f); assertArrayEquals(snapshotIdx, m.indices)
        assertArrayEquals(m.positions, filled.positions.copyOf(m.positions.size), 0f)
        assertArrayEquals(m.indices, filled.indices.copyOf(m.indices.size))
        assertArrayEquals(m.uvs, filled.uvs!!.copyOf(m.uvs!!.size), 0f)
        assertArrayEquals(m.confidence, filled.confidence!!.copyOf(m.vertexCount), 0f)
        assertArrayEquals(m.normals, filled.normals!!.copyOf(m.normals!!.size), 0f)

        assertEquals(1, result.filledHoleCount); assertEquals(0, result.skippedHoleCount)
        assertEquals(filled.faceCount - m.faceCount, result.addedFaces)
        assertTrue(result.addedFaces >= 64)

        // closed, manifold, one piece
        val topo = MeshTopology.build(filled)
        assertEquals(0, topo.boundaryEdgeCount); assertEquals(0, topo.nonManifoldEdgeCount)
        assertEquals(1, topo.faceComponents().count)
        assertEquals(0, MeshOps.findHoles(filled).size)

        // volume: sphere minus the removed cap (the patch is a flat membrane)
        val capHeight = 1 - yCut
        val expected = 4.0 / 3.0 * PI - PI * capHeight * capHeight * (3 - capHeight) / 3
        assertEquals(expected, MeshOps.signedVolume(filled).toDouble(), expected * 0.01)
        // ... which for this small cap is close to the full sphere
        assertEquals(4.0 / 3.0 * PI, MeshOps.signedVolume(filled).toDouble(), 4.0 / 3.0 * PI * 0.03)

        // repaired faces: dedicated material, flagged, confidence 0, uv (0,0), outward normals, no slivers
        val rep = result.repairedMaterialIndex
        assertEquals(1, rep)
        assertEquals(2, filled.materials.size)
        assertSame(m.materials[0], filled.materials[0])
        assertEquals(MeshOps.REPAIRED_MATERIAL_NAME, filled.materials[rep].name)
        assertEquals("Repaired (unobserved)", filled.materials[rep].name)
        assertTrue(filled.materials[rep].repaired)
        assertEquals(null, filled.materials[rep].baseColorTexture)
        assertArrayEquals(floatArrayOf(0.5f, 0.5f, 0.5f, 1f), filled.materials[rep].baseColorFactor, 0f)
        var patchArea = 0.0
        for (f in 0 until filled.faceCount) {
            assertEquals(f >= m.faceCount, isRepaired(filled, f))
            if (f < m.faceCount) continue
            val n = Fixtures.faceNormal(filled, f)
            assertTrue("patch face $f is flipped or degenerate", n.y > 0f && n.normalized().y > 0.999f)
            patchArea += n.length() / 2
            for (k in 0 until 3) {
                val v = filled.indices[3 * f + k]
                assertTrue("patch faces must not reuse original vertices", v >= m.vertexCount)
                assertEquals(0f, filled.confidence!![v], 0f)
                assertEquals(0f, filled.uvs!![2 * v], 0f); assertEquals(0f, filled.uvs!![2 * v + 1], 0f)
                assertTrue(Vec3.of(filled.normals!!, 3 * v).y > 0.999f)
            }
        }
        val r = sqrt(1 - yCut * yCut)
        assertEquals(PI * r * r, patchArea, PI * r * r * 0.005)
        val patch = MeshOps.keepFaces(filled, BooleanArray(filled.faceCount) { it >= m.faceCount })
        assertTrue("patch has sliver triangles: ${Fixtures.minFaceQuality(patch)}", Fixtures.minFaceQuality(patch) > 0.2f)
        // subdivided to a sensible edge length: patch edges are comparable to the rim edges, not a 64-spoke fan
        val rimEdge = 2 * r * Math.sin(PI / 64)
        val ps = MeshOps.stats(patch)
        assertTrue("median patch edge ${ps.medianEdgeLength} vs rim edge $rimEdge", ps.medianEdgeLength > 0.7 * rimEdge && ps.medianEdgeLength < 3.5 * rimEdge)
        assertTrue(patch.vertexCount > 64 + 20)
        assertEquals(patchArea / MeshOps.surfaceArea(filled), MeshOps.stats(filled).repairedAreaFraction.toDouble(), 1e-4)
    }

    @Test fun repairedFlagSurvivesGlbRoundTripAndSecondFillReusesMaterial() {
        val both = Fixtures.sphereWithoutCaps(1f, 32, 16, 0.72f, both = true, bottomCut = 0.55f)
        val holes = MeshOps.findHoles(both)
        assertEquals(2, holes.size)
        // ranked by perimeter: the bottom hole (cut closer to the equator) is longer
        assertTrue(holes[0].perimeter > holes[1].perimeter)
        assertTrue(holes[0].centroid.y < 0f && holes[1].centroid.y > 0f)
        assertTrue(holes[0].normal.y < -0.99f && holes[1].normal.y > 0.99f)

        // fill only the smaller hole by index
        val first = MeshOps.fillHoles(both, setOf(1))
        assertEquals(1, first.filledHoleCount)
        val remaining = MeshOps.findHoles(first.mesh)
        assertEquals(1, remaining.size)
        assertEquals(holes[0].perimeter, remaining[0].perimeter, 1e-5f)
        for (f in both.faceCount until first.mesh.faceCount) assertTrue(Fixtures.centroid(first.mesh, f).y > 0f)

        // maxPerimeter excludes the big hole
        val limited = MeshOps.fillHoles(both, null, maxPerimeter = (holes[0].perimeter + holes[1].perimeter) / 2)
        assertEquals(1, limited.filledHoleCount)
        assertEquals(first.mesh.faceCount, limited.mesh.faceCount)
        val nothing = MeshOps.fillHoles(both, emptySet())
        assertEquals(0, nothing.filledHoleCount); assertSame(both, nothing.mesh); assertEquals(-1, nothing.repairedMaterialIndex)

        // round trip through GLB, then fill the second hole: the repaired material is reused, not duplicated
        val reread = GlbReader.read(GlbWriter.write(GlbDocument(first.mesh))).mesh
        assertEquals(first.mesh.faceCount, reread.faceCount)
        assertEquals(listOf(false, true), reread.materials.map { it.repaired })
        assertEquals(MeshOps.REPAIRED_MATERIAL_NAME, reread.materials[1].name)
        val repairedBefore = Fixtures.areaOf(first.mesh) { isRepaired(first.mesh, it) }
        assertEquals(repairedBefore, Fixtures.areaOf(reread) { isRepaired(reread, it) }, 1e-6)
        val second = MeshOps.fillHoles(reread)
        assertEquals(1, second.filledHoleCount)
        assertEquals(2, second.mesh.materials.size)
        assertEquals(1, second.repairedMaterialIndex)
        assertEquals(0, MeshTopology.build(second.mesh).boundaryEdgeCount)
        // unit sphere minus the caps above y = 0.7071 and below y = -0.5556 (cap volume pi h^2 (3 - h) / 3)
        val hTop = 1 - 0.70710677; val hBottom = 1 - 0.55557024
        val expectedVolume = 4.0 / 3.0 * PI - PI * hTop * hTop * (3 - hTop) / 3 - PI * hBottom * hBottom * (3 - hBottom) / 3
        assertEquals(expectedVolume, MeshOps.signedVolume(second.mesh).toDouble(), expectedVolume * 0.03)
        for (f in 0 until second.mesh.faceCount) {
            val c = Fixtures.centroid(second.mesh, f)
            val onCap = c.y > 0.70f || c.y < -0.55f
            if (isRepaired(second.mesh, f)) assertTrue(onCap)
        }
    }

    /** 12 x 12 grid with a non-convex, non-star-shaped (U-shaped) hole. */
    private fun gridWithUHole(): Pair<Mesh, Int> {
        val n = 12
        val g = Fixtures.planeGrid(n, n, n.toFloat())
        val remove = BooleanArray(g.faceCount)
        var cells = 0
        fun cell(ix: Int, iz: Int) { remove[2 * (iz * n + ix)] = true; remove[2 * (iz * n + ix) + 1] = true; cells++ }
        for (iz in 2..9) { cell(2, iz); cell(9, iz) }   // two long arms
        for (ix in 3..8) cell(ix, 2)                    // joined at the bottom
        return MeshOps.removeFaces(g, remove) to cells
    }

    @Test fun fillsNonConvexHoleWithoutFlippedTriangles() {
        val (m, cells) = gridWithUHole()
        val holes = MeshOps.findHoles(m)
        assertEquals(2, holes.size) // outer rim first, then the U
        assertEquals(48f, holes[0].perimeter, 1e-4f)
        assertEquals(cells.toFloat(), holes[1].area, 1e-3f)
        val result = MeshOps.fillHoles(m, setOf(1))
        assertEquals(1, result.filledHoleCount)
        val filled = result.mesh
        var patchArea = 0.0
        for (f in m.faceCount until filled.faceCount) {
            val nrm = Fixtures.faceNormal(filled, f)
            assertTrue("patch triangle $f is flipped or degenerate", nrm.y > 1e-4f)
            patchArea += nrm.length() / 2
            // inside the U: never covering surviving surface
            val c = Fixtures.centroid(filled, f)
            val inU = (c.x in 2f..3f && c.z in 2f..10f) || (c.x in 9f..10f && c.z in 2f..10f) || (c.x in 2f..10f && c.z in 2f..3f)
            assertTrue("patch triangle at $c is outside the hole", inU)
        }
        assertEquals(cells.toDouble(), patchArea, 1e-3)
        assertEquals(144f, MeshOps.surfaceArea(filled), 1e-3f)
        val topo = MeshTopology.build(filled)
        assertEquals(1, topo.boundaryLoops().size); assertEquals(48, topo.boundaryEdgeCount)
        assertEquals(0, topo.nonManifoldEdgeCount)
    }

    @Test fun outerRimIsReportedAndCanBeLeftOpen() {
        // an open scan: hemisphere bowl with a small hole in it
        val s = Fixtures.uvSphere(1f, 48, 24)
        val bowl = MeshOps.clipByPlane(s, Vec3.ZERO, Vec3(0f, 1f, 0f))
        val withHole = MeshOps.removeFaces(bowl, MeshSelection.facesInSphere(bowl, Vec3(1f, 1f, 0f).normalized(), 0.15f))
        val holes = MeshOps.findHoles(withHole)
        assertEquals(2, holes.size)
        assertEquals(2 * PI, holes[0].perimeter.toDouble(), 0.02) // the rim where the object met the table
        assertTrue(holes[1].perimeter > 0.9f && holes[1].perimeter < 2.5f)
        val r = MeshOps.fillHoles(withHole, maxPerimeter = 3f)
        assertEquals(1, r.filledHoleCount)
        val after = MeshOps.findHoles(r.mesh)
        assertEquals(1, after.size)
        assertEquals(holes[0].perimeter, after[0].perimeter, 1e-5f)
        // the patch sits where the hole was and faces outward
        for (f in withHole.faceCount until r.mesh.faceCount) {
            val c = Fixtures.centroid(r.mesh, f)
            assertTrue(c.distanceTo(Vec3(1f, 1f, 0f).normalized()) < 0.3f)
            assertTrue(Fixtures.faceNormal(r.mesh, f).normalized().dot(c.normalized()) > 0.8f)
        }
    }

    @Test fun fillsTriangleAndQuadHolesAndMeshesWithoutAttributes() {
        // a tetrahedron missing one face: hole of 3 edges
        val tet = Mesh(
            floatArrayOf(0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f),
            null, null, null, intArrayOf(0, 2, 1, 0, 1, 3, 0, 3, 2), null, emptyList(),
        )
        val r = MeshOps.fillHoles(tet)
        assertEquals(1, r.addedFaces)
        assertEquals(1f / 6f, MeshOps.signedVolume(r.mesh), 1e-6f)
        assertEquals(0, MeshTopology.build(r.mesh).boundaryEdgeCount)
        // a mesh without materials gets a real default material so that only the patch is "repaired"
        assertEquals(listOf(false, true), r.mesh.materials.map { it.repaired })
        assertEquals(listOf(0, 0, 0, 1), (0 until 4).map { r.mesh.materialOfFace(it) })
        assertEquals(null, r.mesh.uvs); assertEquals(null, r.mesh.confidence); assertEquals(null, r.mesh.normals)

        // grid with its centre cell removed: quad hole
        val g = Fixtures.planeGrid(3, 3, 3f)
        val quad = MeshOps.removeFaces(g, BooleanArray(g.faceCount) { it == 8 || it == 9 })
        val q = MeshOps.fillHoles(quad, setOf(1))
        assertEquals(9f, MeshOps.surfaceArea(q.mesh), 1e-5f)
        for (f in quad.faceCount until q.mesh.faceCount) assertTrue(Fixtures.faceNormal(q.mesh, f).y > 0.1f)
    }

    @Test fun pinchedHolesAreFilledSeparately() {
        val g = Fixtures.planeGrid(4, 4, 4f)
        val remove = BooleanArray(g.faceCount)
        for (c in intArrayOf(1 * 4 + 1, 2 * 4 + 2)) { remove[2 * c] = true; remove[2 * c + 1] = true }
        val m = MeshOps.removeFaces(g, remove)
        val holes = MeshOps.findHoles(m)
        assertEquals(listOf(16f, 4f, 4f), holes.map { it.perimeter })
        val r = MeshOps.fillHoles(m, setOf(1, 2))
        assertEquals(2, r.filledHoleCount); assertEquals(0, r.skippedHoleCount)
        assertEquals(16f, MeshOps.surfaceArea(r.mesh), 1e-5f)
        for (f in m.faceCount until r.mesh.faceCount) assertTrue(Fixtures.faceNormal(r.mesh, f).y > 0.1f)
    }

    @Test fun fillIsDeterministic() {
        val (m, _) = openSphere(9)
        val a = MeshOps.fillHoles(m).mesh; val b = MeshOps.fillHoles(m).mesh
        assertArrayEquals(a.positions, b.positions, 0f); assertArrayEquals(a.indices, b.indices)
    }
}
