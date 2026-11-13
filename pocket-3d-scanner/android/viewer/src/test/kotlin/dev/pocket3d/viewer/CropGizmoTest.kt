package dev.pocket3d.viewer

import dev.pocket3d.core.math.Quat
import dev.pocket3d.core.math.Ray
import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.mesh.OrientedBox
import dev.pocket3d.viewer.camera.OrbitCamera
import dev.pocket3d.viewer.scene.CropGizmo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CropGizmoTest {
    private val box = OrientedBox(Vec3(1f, 2f, 3f), Quat.axisAngle(Vec3.Y, 0.6f), Vec3(0.5f, 1f, 1.5f))

    private fun assertVec(expected: Vec3, actual: Vec3, tol: Float = 1e-4f) =
        assertTrue("expected $expected but was $actual", expected.distanceTo(actual) <= tol)

    @Test fun handlesSitOnTheFacesAndPointOutwards() {
        for (f in 0 until CropGizmo.FACE_COUNT) {
            val c = CropGizmo.faceCenter(box, f)
            val n = CropGizmo.faceNormal(box, f)
            assertEquals(1f, n.length(), 1e-5f)
            val local = box.toLocal(c)
            val axis = CropGizmo.faceAxis(f)
            assertEquals(CropGizmo.faceSign(f) * box.halfExtents[axis], local[axis], 1e-4f)
            for (other in 0..2) if (other != axis) assertEquals(0f, local[other], 1e-4f)
            // outward: stepping along the normal leaves the box
            assertTrue(!box.contains(c + n * 0.01f))
            assertTrue(box.contains(c - n * 0.01f))
        }
        // opposite faces have opposite normals
        for (a in 0..2) assertVec(-CropGizmo.faceNormal(box, 2 * a), CropGizmo.faceNormal(box, 2 * a + 1))
    }

    @Test fun movingAFaceKeepsTheOppositeFaceFixed() {
        for (f in 0 until CropGizmo.FACE_COUNT) {
            val axis = CropGizmo.faceAxis(f); val s = CropGizmo.faceSign(f)
            val opposite = f xor 1
            val before = CropGizmo.faceCenter(box, opposite)
            val moved = CropGizmo.moveFace(box, f, s * (box.halfExtents[axis] + 0.7f), 0.01f)
            assertVec(before, CropGizmo.faceCenter(moved, opposite))
            assertEquals(box.halfExtents[axis] + 0.35f, moved.halfExtents[axis], 1e-4f)
            assertVec(CropGizmo.faceCenter(box, f) + CropGizmo.faceNormal(box, f) * 0.7f, CropGizmo.faceCenter(moved, f))
            // the other two extents and the orientation are untouched
            for (other in 0..2) if (other != axis) assertEquals(box.halfExtents[other], moved.halfExtents[other], 0f)
            assertEquals(box.rotation, moved.rotation)
        }
    }

    @Test fun aFaceCannotBePushedThroughTheOppositeOne() {
        val moved = CropGizmo.moveFace(box, 1, -50f, 0.05f)       // +X face dragged far to −X
        assertEquals(0.05f, moved.halfExtents.x, 1e-6f)
        assertVec(CropGizmo.faceCenter(box, 0), CropGizmo.faceCenter(moved, 0))
        assertTrue(moved.halfExtents.x > 0f)
    }

    @Test fun draggingFollowsThePointerRayAlongTheFaceNormal() {
        val cam = OrbitCamera(pivot = box.center, yaw = 0.3f, pitch = 0.5f, distance = 9f)
        val w = 1080; val h = 1920
        for (f in 0 until CropGizmo.FACE_COUNT) {
            val handle = CropGizmo.faceCenter(box, f)
            val s0 = cam.project(handle, w, h)!!
            val ray0 = cam.ray(s0.x, s0.y, w, h)
            val grab = CropGizmo.grabOffset(box, f, ray0)
            assertEquals("a ray through the handle has no grab offset", 0f, grab, 2e-3f)
            // the pointer moves to where a point 0.4 further out along the normal appears on screen
            val target = handle + CropGizmo.faceNormal(box, f) * 0.4f
            val s1 = cam.project(target, w, h)!!
            val dragged = CropGizmo.dragFace(box, f, cam.ray(s1.x, s1.y, w, h), grab, 0.01f)
            assertVec(target, CropGizmo.faceCenter(dragged, f), 3e-3f)
            assertVec(CropGizmo.faceCenter(box, f xor 1), CropGizmo.faceCenter(dragged, f xor 1), 1e-4f)
        }
    }

    @Test fun grabOffsetPreventsAJumpWhenTheHandleIsTouchedOffCentre() {
        val cam = OrbitCamera(pivot = box.center, yaw = 0.3f, pitch = 0.5f, distance = 9f)
        val s = cam.project(CropGizmo.faceCenter(box, 3), 1000, 1000)!!
        val ray = cam.ray(s.x + 14f, s.y - 9f, 1000, 1000)
        val same = CropGizmo.dragFace(box, 3, ray, CropGizmo.grabOffset(box, 3, ray), 0.01f)
        assertVec(box.center, same.center, 1e-4f)
        assertVec(box.halfExtents, same.halfExtents, 1e-4f)
    }

    @Test fun rayParallelToTheAxisLeavesTheBoxUnchanged() {
        val axis = box.axis(0)
        val ray = Ray(box.center + Vec3(0f, 5f, 0f), axis)
        assertNull(CropGizmo.pointerAlongAxis(box, 1, ray))
        assertEquals(box, CropGizmo.dragFace(box, 1, ray, 0f, 0.01f))
    }

    @Test fun axisParamFindsTheClosestPoint() {
        // line = X axis; ray passes over x = 2 heading down −Z, 1 above the line
        val t = CropGizmo.axisParam(Ray(Vec3(2f, 1f, 5f), Vec3(0f, 0f, -1f)), Vec3.ZERO, Vec3.X)
        assertEquals(2f, t!!, 1e-5f)
    }

    @Test fun moveAndRotateKeepSizeAndHeight() {
        val ray0 = Ray(Vec3(1f, 10f, 3f), Vec3(0f, -1f, 0f))
        val p0 = CropGizmo.horizontalPlanePoint(ray0, box.center.y)!!
        val delta = box.center - p0
        val moved = CropGizmo.dragMove(box, Ray(Vec3(4f, 10f, -2f), Vec3(0f, -1f, 0f)), delta)
        assertVec(Vec3(4f, 2f, -2f), moved.center)
        assertEquals(box.halfExtents, moved.halfExtents)
        assertEquals(box.rotation, moved.rotation)
        // a ray that never reaches the plane does nothing
        assertEquals(box, CropGizmo.dragMove(box, Ray(Vec3(0f, 10f, 0f), Vec3(0f, 1f, 0f)), delta))

        val turned = CropGizmo.rotateY(box, 0.25f)
        assertVec(box.center, turned.center)
        assertEquals(box.halfExtents, turned.halfExtents)
        assertEquals(CropGizmo.yawOf(box) + 0.25f, CropGizmo.yawOf(turned), 1e-4f)
        assertVec(Vec3.Y, turned.axis(1))
    }

    @Test fun edgesConnectTheCorners() {
        val seg = CropGizmo.edgeSegments(box)
        assertEquals(12 * 6, seg.size)
        val lengths = (0 until 12).map { Vec3.of(seg, it * 6).distanceTo(Vec3.of(seg, it * 6 + 3)) }.sorted()
        // four edges of each of the three lengths 2*hx, 2*hy, 2*hz
        for (i in 0 until 4) assertEquals(1f, lengths[i], 1e-4f)
        for (i in 4 until 8) assertEquals(2f, lengths[i], 1e-4f)
        for (i in 8 until 12) assertEquals(3f, lengths[i], 1e-4f)
        for (c in CropGizmo.corners(box)) {
            val l = box.toLocal(c)
            assertEquals(0.5f, kotlin.math.abs(l.x), 1e-4f); assertEquals(1f, kotlin.math.abs(l.y), 1e-4f); assertEquals(1.5f, kotlin.math.abs(l.z), 1e-4f)
        }
    }
}
