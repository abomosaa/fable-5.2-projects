package dev.pocket3d.core.capture

import dev.pocket3d.core.capture.ImageGeometry.Pinhole
import dev.pocket3d.core.math.Quat
import dev.pocket3d.core.math.Vec3
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Mirrors companion/tests/test_pipeline_units.py (rotate_intrinsics / rotate_pixel / EXIF
 * table): the phone and the companion must agree exactly on these conventions.
 */
class ImageGeometryTest {
    private fun project(k: Pinhole, x: Double, y: Double, z: Double) = (k.fx * x / z + k.cx) to (k.fy * y / z + k.cy)

    /** p_upright = R(turns) · p_stored for CV camera coordinates — same matrices as geom.py. */
    private fun rotateCam(turns: Int, x: Double, y: Double, z: Double): Triple<Double, Double, Double> = when (turns) {
        0 -> Triple(x, y, z)
        1 -> Triple(-y, x, z)
        2 -> Triple(-x, -y, z)
        else -> Triple(y, -x, z)
    }

    @Test fun rotatedIntrinsicsAgreeWithPixelRotationForEveryQuarterTurn() {
        val w = 4000; val h = 3000
        val k = Pinhole(3100.0, 3080.0, 1987.0, 1522.0)
        val pts = listOf(Triple(0.3, -0.2, 2.0), Triple(-0.7, 0.4, 3.5), Triple(0.05, 0.9, 5.0))
        for (turns in 0..3) {
            val kr = ImageGeometry.rotateIntrinsics(k, w, h, turns)
            for ((x, y, z) in pts) {
                val (u, v) = project(k, x, y, z)
                val expected = ImageGeometry.rotatePixel(u, v, w, h, turns)
                val (xr, yr, zr) = rotateCam(turns, x, y, z)
                val got = project(kr, xr, yr, zr)
                assertEquals("turns=$turns u", expected.first, got.first, 1e-9)
                assertEquals("turns=$turns v", expected.second, got.second, 1e-9)
            }
            assertEquals(if (turns % 2 == 1) h to w else w to h, ImageGeometry.uprightSize(w, h, turns))
        }
    }

    @Test fun sameNumbersAsTheCompanionImplementation() {
        // literal values also asserted in the Python tests (0002: fx 500, fy 510, cx 300, cy 250, 640x480, 1 turn)
        val r = ImageGeometry.rotateIntrinsics(Pinhole(500.0, 510.0, 300.0, 250.0), 640, 480, 1)
        assertEquals(510.0, r.fx, 0.0); assertEquals(500.0, r.fy, 0.0)
        assertEquals(480 - 250.0, r.cx, 0.0); assertEquals(300.0, r.cy, 0.0)
    }

    /**
     * The same literal table is asserted in companion/tests/test_pipeline_units.py
     * (`test_rotation_conventions_match_the_phone_literals`): if one side changes a sign or swaps
     * an axis, one of the two suites fails.
     */
    @Test fun rotationConventionsMatchTheCompanionLiterals() {
        val k = Pinhole(1000.0, 1010.0, 620.0, 350.0)       // stored image 1280 x 720
        val expectK = mapOf(
            0 to doubleArrayOf(1000.0, 1010.0, 620.0, 350.0),
            1 to doubleArrayOf(1010.0, 1000.0, 370.0, 620.0),
            2 to doubleArrayOf(1000.0, 1010.0, 660.0, 370.0),
            3 to doubleArrayOf(1010.0, 1000.0, 350.0, 660.0))
        val expectPixel = mapOf(                              // stored pixel (100, 40)
            0 to (100.0 to 40.0), 1 to (680.0 to 100.0), 2 to (1180.0 to 680.0), 3 to (40.0 to 1180.0))
        for (t in 0..3) {
            val r = ImageGeometry.rotateIntrinsics(k, 1280, 720, t)
            val e = expectK.getValue(t)
            assertEquals(e[0], r.fx, 0.0); assertEquals(e[1], r.fy, 0.0); assertEquals(e[2], r.cx, 0.0); assertEquals(e[3], r.cy, 0.0)
            assertEquals(expectPixel.getValue(t), ImageGeometry.rotatePixel(100.0, 40.0, 1280, 720, t))
        }
    }

    @Test fun exifOrientationTable() {
        assertEquals(0 to false, ImageGeometry.exifQuarterTurns(1))
        assertEquals(2 to false, ImageGeometry.exifQuarterTurns(3))
        assertEquals(1 to false, ImageGeometry.exifQuarterTurns(6))
        assertEquals(3 to false, ImageGeometry.exifQuarterTurns(8))
        assertEquals(0 to true, ImageGeometry.exifQuarterTurns(2))
        assertEquals(2 to true, ImageGeometry.exifQuarterTurns(4))
        assertEquals(3 to true, ImageGeometry.exifQuarterTurns(5))
        assertEquals(1 to true, ImageGeometry.exifQuarterTurns(7))
        assertEquals(0 to false, ImageGeometry.exifQuarterTurns(0))
        assertEquals(0 to false, ImageGeometry.exifQuarterTurns(42))
        // tag written for a given clockwise display rotation round-trips through the table
        for ((deg, turns) in listOf(0 to 0, 90 to 1, 180 to 2, 270 to 3, -90 to 3, 450 to 1)) {
            val tag = ImageGeometry.exifOrientationForRotation(deg)
            assertEquals(turns to false, ImageGeometry.exifQuarterTurns(tag))
        }
    }

    @Test fun cropScaleIntrinsicsMatchesManualComputation() {
        // sensor 4000x3000 active array, captured image is the centred 4000x2250 crop scaled to 1920x1080
        val k = Pinhole(3000.0, 3000.0, 2010.0, 1490.0)
        val r = ImageGeometry.cropScaleIntrinsics(k, 0.0, 375.0, 4000.0, 2250.0, 1920, 1080)
        assertEquals(3000 * 0.48, r.fx, 1e-9); assertEquals(3000 * 0.48, r.fy, 1e-9)
        assertEquals(2010 * 0.48, r.cx, 1e-9); assertEquals((1490 - 375) * 0.48, r.cy, 1e-9)
        val s = ImageGeometry.scaleIntrinsics(k, 0.5, 0.25)
        assertEquals(1500.0, s.fx, 0.0); assertEquals(750.0, s.fy, 0.0); assertEquals(1005.0, s.cx, 0.0); assertEquals(372.5, s.cy, 0.0)
    }

    @Test fun glCameraLooksDownMinusZ() {
        val f = ImageGeometry.forward(Quat.IDENTITY)
        assertEquals(-1f, f.z, 1e-6f)
        val yaw90 = Quat.axisAngle(Vec3.Y, (Math.PI / 2).toFloat())      // turn left by 90°
        val f2 = ImageGeometry.forward(yaw90)
        assertEquals(-1f, f2.x, 1e-6f); assertEquals(0f, f2.z, 1e-6f)
        assertEquals(1f, ImageGeometry.up(yaw90).y, 1e-6f)
    }
}
