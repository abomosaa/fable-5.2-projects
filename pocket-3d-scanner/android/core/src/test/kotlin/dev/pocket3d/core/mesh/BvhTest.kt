package dev.pocket3d.core.mesh

import dev.pocket3d.core.math.Mat4
import dev.pocket3d.core.math.Ray
import dev.pocket3d.core.math.Vec3
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sqrt

class BvhTest {
    private fun rnd(r: SplitMix64, lo: Double, hi: Double) = (lo + (hi - lo) * r.nextDouble()).toFloat()
    private fun randomVec(r: SplitMix64, s: Double) = Vec3(rnd(r, -s, s), rnd(r, -s, s), rnd(r, -s, s))

    /** Brute force ray/triangle via plane intersection + same-side edge tests (a different method than the BVH uses). */
    private fun bruteRaycast(m: Mesh, ray: Ray, tMax: Double, cull: Boolean): Pair<Double, Int>? {
        var best: Pair<Double, Int>? = null
        val o = doubleArrayOf(ray.origin.x.toDouble(), ray.origin.y.toDouble(), ray.origin.z.toDouble())
        val d = doubleArrayOf(ray.dir.x.toDouble(), ray.dir.y.toDouble(), ray.dir.z.toDouble())
        fun sub(a: DoubleArray, b: DoubleArray) = doubleArrayOf(a[0] - b[0], a[1] - b[1], a[2] - b[2])
        fun cross(a: DoubleArray, b: DoubleArray) = doubleArrayOf(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
        fun dot(a: DoubleArray, b: DoubleArray) = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
        for (f in 0 until m.faceCount) {
            val p = Array(3) { k -> val v = m.indices[3 * f + k]; doubleArrayOf(m.positions[3 * v].toDouble(), m.positions[3 * v + 1].toDouble(), m.positions[3 * v + 2].toDouble()) }
            val n = cross(sub(p[1], p[0]), sub(p[2], p[0]))
            val denom = dot(n, d)
            if (denom == 0.0 || (cull && denom > 0.0)) continue
            val t = dot(n, sub(p[0], o)) / denom
            if (t <= 0.0 || t > tMax) continue
            val x = doubleArrayOf(o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2])
            var inside = true
            for (k in 0 until 3) if (dot(n, cross(sub(p[(k + 1) % 3], p[k]), sub(x, p[k]))) < 0.0) inside = false
            if (inside && (best == null || t < best.first)) best = t to f
        }
        return best
    }

    /** Brute force closest point: minimum over the three edge segments and the interior projection. */
    private fun bruteClosest(m: Mesh, q: Vec3): Double {
        fun segment(a: Vec3, b: Vec3): Double {
            val ab = b - a
            val t = ((q - a).dot(ab) / ab.lengthSq()).coerceIn(0f, 1f)
            return (a + ab * t).distanceTo(q).toDouble()
        }
        var best = Double.MAX_VALUE
        for (f in 0 until m.faceCount) {
            val a = m.position(m.indices[3 * f]); val b = m.position(m.indices[3 * f + 1]); val c = m.position(m.indices[3 * f + 2])
            var d = minOf(segment(a, b), segment(b, c), segment(c, a))
            val n = (b - a).cross(c - a).normalized()
            val proj = q - n * (q - a).dot(n)
            val inside = (b - a).cross(proj - a).dot(n) >= 0 && (c - b).cross(proj - b).dot(n) >= 0 && (a - c).cross(proj - c).dot(n) >= 0
            if (inside) d = minOf(d, abs((q - a).dot(n)).toDouble())
            best = minOf(best, d)
        }
        return best
    }

    private val scene: Mesh by lazy {
        Fixtures.merge(
            Fixtures.torus(1f, 0.35f, 40, 20),
            Fixtures.translate(Fixtures.uvSphere(0.5f, 24, 12), Vec3(0f, 0.9f, 0.2f)),
            Fixtures.translate(Fixtures.planeGrid(6, 6, 3f), Vec3(-1.5f, -0.6f, -1.5f)),
        )
    }

    @Test fun raycastMatchesBruteForce() {
        val m = scene
        val bvh = Bvh.build(m)
        assertEquals(m.faceCount, bvh.triangleCount)
        val r = SplitMix64(42)
        var hits = 0
        repeat(1500) { i ->
            val origin = randomVec(r, 2.5)
            val target = randomVec(r, 1.0)
            val ray = Ray(origin, (target - origin).normalized())
            val cull = i % 3 == 0
            val tMax = if (i % 5 == 0) 2.0f else Float.POSITIVE_INFINITY
            val expected = bruteRaycast(m, ray, tMax.toDouble(), cull)
            val hit = bvh.raycast(ray, tMax, cull)
            assertEquals("ray $i anyHit", expected != null, bvh.anyHit(ray, tMax, cull))
            if (expected == null) { assertNull("ray $i: unexpected hit", hit); return@repeat }
            assertNotNull("ray $i: missed hit at ${expected.first}", hit)
            hits++
            assertEquals("ray $i distance", expected.first, hit!!.t.toDouble(), 1e-4)
            // the face may differ only when two faces are hit at the same distance (shared edge)
            if (hit.face != expected.second) assertEquals(expected.first, bruteRaycast(MeshOps.keepFaces(m, BooleanArray(m.faceCount) { it == hit.face }), ray, tMax.toDouble(), cull)!!.first, 1e-4)
            // consistency of the reported hit record
            assertTrue(hit.point.distanceTo(ray.at(hit.t)) < 1e-4f)
            assertEquals(1f, hit.b0 + hit.b1 + hit.b2, 1e-5f)
            assertTrue(hit.b0 >= -1e-6f && hit.b1 >= -1e-6f && hit.b2 >= -1e-6f)
            val a = m.position(m.indices[3 * hit.face]); val b = m.position(m.indices[3 * hit.face + 1]); val c = m.position(m.indices[3 * hit.face + 2])
            assertTrue((a * hit.b0 + b * hit.b1 + c * hit.b2).distanceTo(hit.point) < 1e-5f)
            assertTrue(hit.normal.distanceTo((b - a).cross(c - a).normalized()) < 1e-4f)
            if (cull) assertTrue(hit.normal.dot(ray.dir) < 0f)
        }
        assertTrue("too few hits to be meaningful: $hits", hits > 500)
    }

    @Test fun backfaceCullingFromInsideSphere() {
        val s = Fixtures.uvSphere(1f, 32, 16)
        val bvh = Bvh.build(s)
        val ray = Ray(Vec3(0.1f, 0.05f, 0f), Vec3(0.3f, 0.2f, 1f).normalized())
        val hit = bvh.raycast(ray)!!
        assertEquals(1f, hit.point.length(), 0.01f)
        assertTrue(hit.normal.dot(ray.dir) > 0f) // geometric normal is not flipped towards the ray
        assertNull(bvh.raycast(ray, cullBackfaces = true))
        assertFalse(bvh.anyHit(ray, cullBackfaces = true))
        // from outside: front face first, at distance |origin| - 1
        val outside = Ray(Vec3(0f, 0f, 5f), Vec3(0f, 0f, -1f))
        assertEquals(4f, bvh.raycast(outside, cullBackfaces = true)!!.t, 0.01f)
        assertNull(bvh.raycast(outside, 3.9f))
        assertTrue(bvh.anyHit(outside, 4.1f))
        // axis-aligned rays (zero direction components) and rays that miss
        assertNotNull(bvh.raycast(Ray(Vec3(0.2f, -5f, 0.1f), Vec3(0f, 1f, 0f))))
        assertNull(bvh.raycast(Ray(Vec3(1.5f, -5f, 0f), Vec3(0f, 1f, 0f))))
        assertNull(bvh.raycast(Ray(Vec3(0f, 0f, 5f), Vec3(0f, 0f, 1f))))
    }

    @Test fun closestPointMatchesBruteForce() {
        val m = scene
        val bvh = Bvh.build(m)
        val r = SplitMix64(7)
        repeat(1000) { i ->
            val q = randomVec(r, 2.2)
            val expected = bruteClosest(m, q)
            val hit = bvh.closestPoint(q)!!
            assertEquals("point $i", expected, hit.distance.toDouble(), 1e-5)
            assertEquals(hit.distance, hit.point.distanceTo(q), 1e-5f)
            val a = m.position(m.indices[3 * hit.face]); val b = m.position(m.indices[3 * hit.face + 1]); val c = m.position(m.indices[3 * hit.face + 2])
            assertTrue((a * hit.b0 + b * hit.b1 + c * hit.b2).distanceTo(hit.point) < 1e-5f)
            assertTrue(hit.b0 >= 0f && hit.b1 >= 0f && hit.b2 >= 0f)
            // maxDist cuts off exactly at the true distance
            assertNull(bvh.closestPoint(q, (expected * 0.99).toFloat() - 1e-6f))
            assertNotNull(bvh.closestPoint(q, (expected * 1.01).toFloat() + 1e-6f))
        }
    }

    @Test fun closestPointOnSphereIsRadial() {
        val s = Fixtures.uvSphere(2f, 96, 48)
        val bvh = Bvh.build(s)
        val q = Vec3(3f, 4f, 12f) // |q| = 13
        val hit = bvh.closestPoint(q)!!
        assertEquals(11f, hit.distance, 0.01f)
        assertTrue(hit.point.distanceTo(q.normalized() * 2f) < 0.05f)
        assertEquals(2f, bvh.closestPoint(Vec3.ZERO)!!.distance, 0.01f)
    }

    @Test fun degenerateAndEmptyInput() {
        val empty = Bvh.build(Mesh(FloatArray(0), null, null, null, IntArray(0), null, emptyList()))
        assertEquals(0, empty.triangleCount)
        assertNull(empty.raycast(Ray(Vec3.ZERO, Vec3.X))); assertNull(empty.closestPoint(Vec3.ZERO)); assertFalse(empty.anyHit(Ray(Vec3.ZERO, Vec3.X)))
        // one good triangle, one zero-area triangle, many coincident triangles
        val pos = floatArrayOf(0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f, 0f, 2f, 2f, 2f)
        val idx = IntArray(3 * 40) { k -> if (k < 3) k else if (k < 6) 3 else k % 3 }
        val m = Mesh(pos, null, null, null, idx, null, emptyList())
        val bvh = Bvh.build(m)
        assertEquals(39, bvh.triangleCount)
        val hit = bvh.raycast(Ray(Vec3(0.2f, 0.2f, 1f), Vec3(0f, 0f, -1f)))!!
        assertEquals(1f, hit.t, 1e-6f)
        assertEquals(0, hit.face) // ties resolve to the lowest face index
        assertEquals(0, bvh.closestPoint(Vec3(0.2f, 0.2f, 1f))!!.face)
    }

    @Test fun largeMeshBuildsAndAnswersQuickly() {
        val m = Fixtures.torus(1f, 0.4f, 300, 300) // 180k faces
        val t0 = System.nanoTime()
        val bvh = Bvh.build(m)
        val buildMs = (System.nanoTime() - t0) / 1e6
        assertTrue(bvh.nodeTotal < 2 * m.faceCount)
        val r = SplitMix64(3)
        var hits = 0
        repeat(20000) {
            val o = randomVec(r, 3.0)
            if (bvh.raycast(Ray(o, (randomVec(r, 1.0) - o).normalized())) != null) hits++
        }
        assertTrue(hits > 5000)
        assertTrue("BVH build took $buildMs ms", buildMs < 5000)
        // surface point of the torus: distance ~0; centre of the tube: distance = minor radius
        assertEquals(0.4f, bvh.closestPoint(Vec3(1f, 0f, 0f))!!.distance, 1e-3f)
        assertEquals(0.6f, bvh.closestPoint(Vec3.ZERO)!!.distance, 1e-3f)
    }
}

class DeviationTest {
    @Test fun deviationBetweenConcentricSpheres() {
        val a = Fixtures.uvSphere(1f, 96, 48); val b = Fixtures.uvSphere(1.1f, 96, 48)
        val d = MeshOps.deviation(a, b)
        assertEquals(20000, d.sampleCount)
        assertEquals(0.1f, d.mean, 0.003f); assertEquals(0.1f, d.rms, 0.003f); assertEquals(0.1f, d.p95, 0.003f); assertEquals(0.1f, d.max, 0.003f)
        assertEquals(sqrt(12f), d.diagonal, 0.01f)
        assertEquals(d.mean / d.diagonal, d.meanRelativeToDiagonal, 1e-7f)
        assertEquals(d.max / d.diagonal, d.maxRelativeToDiagonal, 1e-7f)
        assertTrue(d.mean <= d.rms && d.rms <= d.max && d.p95 <= d.max)
        // identical meshes: zero
        val zero = MeshOps.deviation(a, a, 2000)
        assertEquals(0f, zero.max, 1e-6f)
    }

    @Test fun deviationIsOneSidedAndAreaWeighted() {
        // `from` = unit square at y = 0; `to` = the left half of it. Samples on the right half are
        // x - 0.5 away: mean = 1/8, max = 1/2, rms = sqrt(1/24), p95 = 0.45
        val from = Fixtures.planeGrid(8, 8, 1f)
        val to = MeshOps.clipByPlane(from, Vec3(0.5f, 0f, 0f), Vec3(-1f, 0f, 0f))
        val d = MeshOps.deviation(from, to, 40000, seed = 5)
        assertEquals(0.125f, d.mean, 0.003f)
        assertEquals(sqrt(1f / 24f), d.rms, 0.003f)
        assertEquals(0.45f, d.p95, 0.005f)
        assertEquals(0.5f, d.max, 0.002f)
        // the other direction: every point of `to` lies on `from`
        assertEquals(0f, MeshOps.deviation(to, from, 5000).max, 1e-6f)
        // area weighting must not depend on tessellation: a finer left half gives the same numbers
        val fine = Fixtures.merge(
            MeshOps.clipByPlane(Fixtures.planeGrid(64, 64, 1f), Vec3(0.5f, 0f, 0f), Vec3(-1f, 0f, 0f)),
            MeshOps.clipByPlane(Fixtures.planeGrid(2, 2, 1f), Vec3(0.5f, 0f, 0f), Vec3(1f, 0f, 0f)),
        )
        assertEquals(0.125f, MeshOps.deviation(fine, to, 40000, seed = 5).mean, 0.003f)
    }

    @Test fun deterministicPerSeed() {
        val a = Fixtures.torus(1f, 0.3f, 32, 16); val b = Fixtures.torus(1f, 0.32f, 24, 12)
        val d1 = MeshOps.deviation(a, b, 3000, seed = 11); val d2 = MeshOps.deviation(a, b, 3000, seed = 11)
        assertEquals(d1, d2)
        val d3 = MeshOps.deviation(a, b, 3000, seed = 12)
        assertTrue(d1 != d3)
        assertEquals(d1.mean, d3.mean, 0.002f)
        assertEquals(d1, MeshOps.deviation(a, b, 3000, seed = 11, toBvh = Bvh.build(b)))
    }
}

class MeshSelectionTest {
    private val eye = Vec3(0f, 0f, 5f)
    private val viewProj = Mat4.mul(Mat4.perspective((PI / 3).toFloat(), 1f, 0.1f, 100f), Mat4.lookAt(eye, Vec3.ZERO, Vec3.Y))
    private val fullScreen = floatArrayOf(-1f, -1f, 1f, -1f, 1f, 1f, -1f, 1f)

    @Test fun lassoSelectsFacesWhoseCentroidProjectsInside() {
        val s = Fixtures.uvSphere(1f, 48, 24)
        val bvh = Bvh.build(s)
        // a triangle-shaped lasso
        val poly = floatArrayOf(-0.1f, -0.2f, 0.25f, -0.05f, 0.0f, 0.3f)
        val sel = MeshSelection.facesInScreenPolygon(s, bvh, viewProj, poly, eye, visibleOnly = false)
        fun insideTriangle(x: Float, y: Float): Boolean {
            fun side(ax: Float, ay: Float, bx: Float, by: Float) = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
            return side(poly[0], poly[1], poly[2], poly[3]) > 0 && side(poly[2], poly[3], poly[4], poly[5]) > 0 && side(poly[4], poly[5], poly[0], poly[1]) > 0
        }
        var selected = 0
        for (f in 0 until s.faceCount) {
            val ndc = Mat4.transformPoint(viewProj, Fixtures.centroid(s, f))
            assertEquals("face $f", insideTriangle(ndc.x, ndc.y), sel[f])
            if (sel[f]) selected++
        }
        assertEquals(selected, MeshSelection.count(sel))
        // without the visibility test both the near and the far side of the sphere are picked
        assertTrue(sel.indices.any { sel[it] && Fixtures.centroid(s, it).z > 0.5f })
        assertTrue(sel.indices.any { sel[it] && Fixtures.centroid(s, it).z < -0.5f })

        val visible = MeshSelection.facesInScreenPolygon(s, bvh, viewProj, poly, eye, visibleOnly = true)
        for (f in 0 until s.faceCount) {
            if (visible[f]) { assertTrue(sel[f]); assertTrue(Fixtures.centroid(s, f).z > 0f) }
            // every selected near-side face is visible
            if (sel[f] && Fixtures.centroid(s, f).z > 0.3f) assertTrue(visible[f])
        }
        assertTrue(MeshSelection.count(visible) in 1 until selected)
    }

    @Test fun visibleOnlySelectsExactlyTheFrontOfAConvexShape() {
        val s = Fixtures.uvSphere(1f, 48, 24)
        val bvh = Bvh.build(s)
        val all = MeshSelection.facesInScreenPolygon(s, bvh, viewProj, fullScreen, eye, visibleOnly = false)
        assertEquals(s.faceCount, MeshSelection.count(all))
        val visible = MeshSelection.facesInScreenPolygon(s, bvh, viewProj, fullScreen, eye, visibleOnly = true)
        for (f in 0 until s.faceCount) {
            // on a convex solid a face is visible iff it faces the camera
            val c = Fixtures.centroid(s, f)
            val facing = Fixtures.faceNormal(s, f).normalized().dot((eye - c).normalized())
            if (facing > 0.02f) assertTrue("front face $f not selected", visible[f])
            if (facing < -0.02f) assertFalse("hidden face $f selected", visible[f])
        }
    }

    @Test fun occluderHidesFacesAndFacesBehindCameraAreIgnored() {
        // a small quad between the camera and a big quad, both facing +Z
        fun quad(size: Float, z: Float): Mesh {
            val g = Fixtures.planeGrid(8, 8, size)
            // rotate the XZ grid to the XY plane (y -> z) and centre it
            val m = floatArrayOf(1f, 0f, 0f, 0f, 0f, 0f, 1f, 0f, 0f, -1f, 0f, 0f, -size / 2, size / 2, z, 1f)
            return MeshOps.transform(g, m)
        }
        val back = quad(2f, 0f); val front = quad(0.5f, 2f)
        val m = Fixtures.merge(back, front)
        val bvh = Bvh.build(m)
        val visible = MeshSelection.facesInScreenPolygon(m, bvh, viewProj, fullScreen, eye, visibleOnly = true)
        var hidden = 0
        for (f in 0 until m.faceCount) {
            val c = Fixtures.centroid(m, f)
            if (f >= back.faceCount) { assertTrue(visible[f]); continue }
            // shadow of the front quad on the back quad, projected from the eye: half-size 0.25 * 5 / 3
            val shadow = 0.25f * 5f / 3f
            val inShadow = abs(c.x) < shadow && abs(c.y) < shadow
            if (abs(abs(c.x) - shadow) > 0.01f && abs(abs(c.y) - shadow) > 0.01f) assertEquals("face $f at $c", !inShadow, visible[f])
            if (!visible[f]) hidden++
        }
        assertTrue(hidden > 10)
        // camera inside the scene looking away: nothing in front
        val awayEye = Vec3(0f, 0f, 5f)
        val away = Mat4.mul(Mat4.perspective((PI / 3).toFloat(), 1f, 0.1f, 100f), Mat4.lookAt(awayEye, Vec3(0f, 0f, 10f), Vec3.Y))
        assertEquals(0, MeshSelection.count(MeshSelection.facesInScreenPolygon(m, bvh, away, fullScreen, awayEye, visibleOnly = false)))
        // degenerate polygons select nothing
        assertEquals(0, MeshSelection.count(MeshSelection.facesInScreenPolygon(m, bvh, viewProj, floatArrayOf(0f, 0f, 1f, 1f), eye, false)))
    }

    @Test fun facesInSphereUsesTriangleDistance() {
        // one huge triangle: its centroid is far from the brush but the brush touches the face
        val big = Mesh(floatArrayOf(0f, 0f, 0f, 30f, 0f, 0f, 0f, 30f, 0f), null, null, null, intArrayOf(0, 1, 2), null, emptyList())
        assertTrue(MeshSelection.facesInSphere(big, Vec3(1f, 1f, 0.5f), 0.6f)[0])
        assertFalse(MeshSelection.facesInSphere(big, Vec3(1f, 1f, 0.5f), 0.4f)[0])
        assertFalse(MeshSelection.facesInSphere(big, Vec3(-1f, -1f, 0f), 1.3f)[0])
        assertTrue(MeshSelection.facesInSphere(big, Vec3(-1f, -1f, 0f), 1.5f)[0])

        val g = Fixtures.planeGrid(20, 20, 20f)
        val c = Vec3(10.3f, 0f, 9.6f)
        val sel = MeshSelection.facesInSphere(g, c, 3f)
        val bvhDistance = { f: Int -> Bvh.build(MeshOps.keepFaces(g, BooleanArray(g.faceCount) { it == f })).closestPoint(c)!!.distance }
        for (f in 0 until g.faceCount step 7) assertEquals("face $f", bvhDistance(f) <= 3f, sel[f])
        // selected area is a little more than the disc (whole faces touching it)
        val area = MeshSelection.count(sel) * 0.5
        assertTrue(area > PI * 9 && area < PI * 16)
        assertEquals(0, MeshSelection.count(MeshSelection.facesInSphere(g, Vec3(10f, 5f, 10f), 3f)))
    }

    @Test fun growSelectionToComponent() {
        val a = Fixtures.uvSphere(1f, 12, 6)
        val b = Fixtures.translate(Fixtures.uvSphere(1f, 12, 6), Vec3(5f, 0f, 0f))
        val c = Fixtures.translate(Fixtures.torus(1f, 0.2f, 12, 6), Vec3(0f, 5f, 0f))
        val m = Fixtures.merge(a, b, c)
        val seed = BooleanArray(m.faceCount)
        seed[a.faceCount + 3] = true // one face of b
        val grown = MeshSelection.growSelectionToComponent(m, seed)
        for (f in 0 until m.faceCount) assertEquals(f >= a.faceCount && f < a.faceCount + b.faceCount, grown[f])
        assertTrue(seed.count { it } == 1) // input not modified
        seed[0] = true
        assertEquals(a.faceCount + b.faceCount, MeshSelection.count(MeshSelection.growSelectionToComponent(m, seed, MeshTopology.build(m))))
        assertEquals(0, MeshSelection.count(MeshSelection.growSelectionToComponent(m, BooleanArray(m.faceCount))))
        // the grown selection plugs straight into removeFaces
        assertEquals(c.faceCount, MeshOps.removeFaces(m, MeshSelection.growSelectionToComponent(m, seed)).faceCount)
    }
}
