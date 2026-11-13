package dev.pocket3d.viewer

import dev.pocket3d.core.math.Mat4
import dev.pocket3d.core.math.Quat
import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.mesh.Aabb
import dev.pocket3d.viewer.camera.CameraSnapshot
import dev.pocket3d.viewer.camera.OrbitCamera
import dev.pocket3d.viewer.camera.StandardView
import dev.pocket3d.viewer.data.CamerasJson
import dev.pocket3d.viewer.scene.CameraPicker
import dev.pocket3d.viewer.scene.SceneBuilders
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.tan

class OrbitCameraTest {
    private fun assertVec(expected: Vec3, actual: Vec3, tol: Float = 1e-4f) {
        assertTrue("expected $expected but was $actual", expected.distanceTo(actual) <= tol)
    }

    private fun corners(b: Aabb) = (0 until 8).map {
        Vec3(if (it and 1 == 0) b.min.x else b.max.x, if (it and 2 == 0) b.min.y else b.max.y, if (it and 4 == 0) b.min.z else b.max.z)
    }

    @Test fun defaultCameraLooksDownMinusZFromFront() {
        val c = OrbitCamera(distance = 5f)
        assertVec(Vec3(0f, 0f, 5f), c.eye)
        assertVec(Vec3(0f, 0f, -1f), c.forward)
        assertVec(Vec3.X, c.right)
        assertVec(Vec3.Y, c.up)
        // the pivot sits on the view axis, [distance] in front of the camera
        val p = Mat4.transformPoint(c.viewMatrix(), c.pivot)
        assertVec(Vec3(0f, 0f, -5f), p)
    }

    @Test fun fitKeepsWholeBoundsInsideFrustum() {
        val boxes = listOf(
            Aabb(Vec3(-1f, -1f, -1f), Vec3(1f, 1f, 1f)),
            Aabb(Vec3(2f, -0.1f, -5f), Vec3(9f, 0.3f, -4.5f)),
            Aabb(Vec3(-0.002f, 0f, -0.001f), Vec3(0.002f, 0.03f, 0.001f)),
        )
        val views = StandardView.entries
        for (b in boxes) for (aspect in listOf(0.45f, 1f, 2.2f)) for (v in views) {
            val w = 1000; val h = (w / aspect).toInt()
            val cam = OrbitCamera().withScene(b.center, b.diagonal).standardView(v).fit(b, w.toFloat() / h)
            val vp = Mat4.mul(cam.projectionMatrix(w.toFloat() / h), cam.viewMatrix())
            for (corner in corners(b)) {
                val s = cam.project(corner, w, h)
                assertNotNull("corner behind camera", s)
                assertTrue("corner outside viewport: $s (aspect $aspect, $v)", s!!.x >= 0f && s.x <= w && s.y >= 0f && s.y <= h)
                // also inside the clip volume (near/far) of the projection the renderer uses
                val ndc = Mat4.transformPoint(vp, corner)
                assertTrue("corner outside clip volume: $ndc", abs(ndc.x) <= 1.0001f && abs(ndc.y) <= 1.0001f && abs(ndc.z) <= 1.0001f)
            }
            // and not wastefully far away: the bounding sphere fills at least 60 % of the smaller field of view
            val r = b.diagonal / 2
            val half = minOf(cam.fovY, cam.fovX(w.toFloat() / h)) / 2
            assertTrue(r / cam.distance >= 0.6f * kotlin.math.sin(half))
        }
    }

    @Test fun orbitKeepsPivotAndDistanceAndNeverFlips() {
        var cam = OrbitCamera(pivot = Vec3(1f, 2f, 3f), distance = 4f)
        repeat(200) { i ->
            cam = cam.orbit(13f * (i % 7 - 3), 17f, 800)
            assertEquals(4f, cam.eye.distanceTo(cam.pivot), 1e-4f)
            assertVec(Vec3(1f, 2f, 3f), cam.pivot)
            assertTrue(abs(cam.pitch) <= OrbitCamera.MAX_PITCH + 1e-6f)
            assertTrue("up must keep pointing up", cam.up.y > 0f)
        }
        // dragging right turns the camera to the left of the model (the model follows the finger)
        val right = OrbitCamera(distance = 4f).orbit(100f, 0f, 800)
        assertTrue(right.eye.x < 0f)
        // dragging down raises the camera
        val down = OrbitCamera(distance = 4f).orbit(0f, 100f, 800)
        assertTrue(down.eye.y > 0f)
    }

    @Test fun panMovesTheSceneWithTheFinger() {
        val cam = OrbitCamera(pivot = Vec3(0.3f, -0.2f, 0.1f), yaw = 0.7f, pitch = 0.4f, distance = 3f)
        val w = 1200; val h = 800
        val anchor = cam.pivot
        val before = cam.project(anchor, w, h)!!
        val moved = cam.pan(40f, -25f, h)
        val after = moved.project(anchor, w, h)!!
        assertEquals(before.x + 40f, after.x, 0.05f)
        assertEquals(before.y - 25f, after.y, 0.05f)
        assertEquals(cam.distance, moved.distance, 0f)
        assertEquals(cam.yaw, moved.yaw, 0f)
        assertVec(cam.eye - cam.pivot, moved.eye - moved.pivot)
    }

    @Test fun zoomScalesDistanceWithinLimits() {
        val cam = OrbitCamera(distance = 4f, sceneRadius = 1f)
        assertEquals(2f, cam.zoom(2f).distance, 1e-6f)
        assertEquals(8f, cam.zoom(0.5f).distance, 1e-6f)
        assertEquals(OrbitCamera.MIN_DISTANCE_FACTOR, cam.zoom(1e9f).distance, 1e-6f)
        assertEquals(OrbitCamera.MAX_DISTANCE_FACTOR, cam.zoom(1e-9f).distance, 1e-6f)
        assertEquals(cam, cam.zoom(Float.NaN))
        assertEquals(cam, cam.zoom(0f))
        assertVec(cam.pivot, cam.zoom(3f).pivot)
    }

    @Test fun rayAndProjectRoundTrip() {
        val cam = OrbitCamera(pivot = Vec3(0.1f, 0.2f, -0.3f), yaw = -1.1f, pitch = 0.6f, roll = 0.2f, distance = 2.5f)
        val w = 1080; val h = 1920
        for ((x, y) in listOf(0f to 0f, 540f to 960f, 1079f to 10f, 123.5f to 1777.25f, 900f to 300f)) {
            val ray = cam.ray(x, y, w, h)
            assertEquals(1f, ray.dir.length(), 1e-5f)
            assertVec(cam.eye, ray.origin)
            for (t in listOf(0.5f, 2.5f, 40f)) {
                val s = cam.project(ray.at(t), w, h)!!
                assertEquals(x, s.x, 0.02f)
                assertEquals(y, s.y, 0.02f)
            }
        }
        // centre pixel looks along the forward axis; points behind the camera do not project
        assertVec(cam.forward, cam.ray(w / 2f, h / 2f, w, h).dir)
        assertNull(cam.project(cam.eye - cam.forward, w, h))
        // project agrees with the matrices handed to the renderer
        val snap = CameraSnapshot(cam, w, h)
        val p = Vec3(0.4f, 0.1f, 0.2f)
        val ndc = Mat4.transformPoint(snap.viewProj, p)
        val s = cam.project(p, w, h)!!
        assertEquals((ndc.x + 1f) * 0.5f * w, s.x, 0.05f)
        assertEquals((1f - ndc.y) * 0.5f * h, s.y, 0.05f)
    }

    private fun poseViewMatrix(position: Vec3, q: Quat): FloatArray = Mat4.invert(Mat4.trs(position, q, 1f))!!

    private fun assertMatrix(expected: FloatArray, actual: FloatArray, tol: Float) {
        for (i in 0 until 16) assertEquals("element $i", expected[i], actual[i], tol)
    }

    @Test fun lookFromReproducesArbitraryPoses() {
        val poses = listOf(
            Vec3(0f, 0f, 3f) to Quat.IDENTITY,
            Vec3(1f, 2f, 3f) to Quat.axisAngle(Vec3(0.3f, 1f, -0.2f), 1.9f),
            Vec3(-2f, 0.5f, 0.1f) to (Quat.axisAngle(Vec3.Y, -2.2f) * Quat.axisAngle(Vec3.X, 0.9f) * Quat.axisAngle(Vec3.Z, 2.8f)),
            Vec3(0f, 5f, 0f) to Quat.axisAngle(Vec3.X, (-Math.PI / 2).toFloat()),          // straight down
            Vec3(0f, -5f, 0f) to (Quat.axisAngle(Vec3.X, (Math.PI / 2).toFloat()) * Quat.axisAngle(Vec3.Z, 1f)), // straight up, rolled
            Vec3(0.2f, 0.1f, -0.7f) to Quat(-0.5f, 0.5f, 0.5f, 0.5f),
        )
        for ((pos, q) in poses) {
            val cam = OrbitCamera(yaw = 1f, pitch = -0.3f, distance = 9f).lookFrom(pos, q, 0.8f, 1.5f, 1.5f, 1.7f)
            assertVec(pos, cam.eye, 1e-4f)
            assertMatrix(poseViewMatrix(pos, q.normalized()), cam.viewMatrix(), 2e-4f)
            assertEquals(1.7f, cam.distance, 1e-6f)
            // the pivot is on the optical axis
            assertVec(pos + q.normalized().rotate(Vec3(0f, 0f, -1f)) * 1.7f, cam.pivot, 1e-4f)
        }
    }

    @Test fun lookFromMatchesEveryRealSourceCamera() {
        assumeTrue(TestMeshes.REAL_CAMERAS.isFile)
        val doc = CamerasJson.parse(TestMeshes.REAL_CAMERAS.readText())
        assertTrue(doc.cameras.size >= 3)
        val placed = SceneBuilders.placeCameras(doc.cameras, null)
        assertEquals(doc.cameras.size, placed.size)
        for (pc in placed) {
            val cam = OrbitCamera().lookFrom(pc.position, pc.rotation, pc.fovYRad, pc.aspect, pc.aspect, 1f)
            assertMatrix(poseViewMatrix(pc.position, pc.rotation), cam.viewMatrix(), 3e-4f)
            assertEquals(pc.fovYRad, cam.fovY, 1e-5f)
            // cameras.json also stores the forward vector: must agree with the quaternion convention
            val f = pc.source.forward
            assertVec(Vec3(f[0].toFloat(), f[1].toFloat(), f[2].toFloat()), cam.forward, 2e-3f)
            // the cameras of a converging capture look towards the object at the origin
            assertTrue(pc.forward.dot((Vec3.ZERO - pc.position).normalized()) > 0.5f)
        }
    }

    @Test fun photoFieldOfViewFitsTheWholeFrame() {
        val fov = Math.toRadians(45.0).toFloat()
        // same aspect: identical vertical field of view, frame fills the viewport
        assertEquals(fov, OrbitCamera.fovForPhoto(fov, 1.5f, 1.5f), 1e-6f)
        assertEquals(1f to 1f, OrbitCamera.photoFrameFraction(fov, 1.5f, 1.5f).let { (a, b) -> Math.round(a * 1e4f) / 1e4f to Math.round(b * 1e4f) / 1e4f })
        // landscape photo in a portrait viewport: horizontal field of view decides
        val view = OrbitCamera.fovForPhoto(fov, 16f / 9f, 9f / 16f)
        val tanH = tan(fov / 2f) * 16f / 9f
        assertEquals(tanH, tan(view / 2f) * 9f / 16f, 1e-5f)
        val (wf, hf) = OrbitCamera.photoFrameFraction(fov, 16f / 9f, 9f / 16f)
        assertEquals(1f, wf, 1e-4f)
        assertEquals((9f / 16f) / (16f / 9f), hf, 1e-4f)
    }

    @Test fun lerpEndsExactlyAndTakesTheShortWayRound() {
        val a = OrbitCamera(yaw = 3.0f, distance = 2f)
        val b = OrbitCamera(yaw = -3.0f, distance = 8f, pivot = Vec3(1f, 0f, 0f))
        assertEquals(a, OrbitCamera.lerp(a, b, 0f))
        assertEquals(b, OrbitCamera.lerp(a, b, 1f))
        val mid = OrbitCamera.lerp(a, b, 0.5f)
        assertTrue("went the long way: ${mid.yaw}", abs(abs(mid.yaw) - Math.PI.toFloat()) < 0.15f)
        assertEquals(4f, mid.distance, 1e-4f)
    }

    @Test fun magnifierCentresTheTouchedPoint() {
        val cam = OrbitCamera(yaw = 0.4f, pitch = 0.2f, distance = 3f)
        val snap = CameraSnapshot(cam, 1000, 600)
        val p = Vec3(0.3f, -0.2f, 0.4f)
        val s = cam.project(p, 1000, 600)!!
        val m = snap.magnifiedViewProj(s.x, s.y, 50f)
        val ndc = Mat4.transformPoint(m, p)
        assertEquals(0f, ndc.x, 1e-3f); assertEquals(0f, ndc.y, 1e-3f)
        // a point 25 px to the right lands on the right edge of the magnifier
        val q = cam.ray(s.x + 25f, s.y, 1000, 600).at(s.depth)
        assertEquals(1f, Mat4.transformPoint(m, q).x, 2e-2f)
    }

    @Test fun pickerFindsTheCameraUnderTheTap() {
        assumeTrue(TestMeshes.REAL_CAMERAS.isFile)
        val placed = SceneBuilders.placeCameras(CamerasJson.parse(TestMeshes.REAL_CAMERAS.readText()).cameras, null)
        val view = OrbitCamera().withScene(Vec3.ZERO, 3f).standardView(StandardView.ThreeQuarter).copy(distance = 4f)
        val target = placed[placed.size / 2]
        val s = view.project(target.position, 1080, 1920)!!
        val hit = CameraPicker.pick(placed, view, 1080, 1920, s.x + 3f, s.y - 2f, 0.05f, 40f)
        assertNotNull(hit)
        // another camera may project within a few pixels, but the picked one must be at least as close
        val picked = view.project(placed[hit!!].position, 1080, 1920)!!
        assertTrue(kotlin.math.hypot(picked.x - s.x - 3f, picked.y - s.y + 2f) <= 40f)
        assertNull(CameraPicker.pick(placed, view, 1080, 1920, -500f, -500f, 0.05f, 40f))
    }
}
