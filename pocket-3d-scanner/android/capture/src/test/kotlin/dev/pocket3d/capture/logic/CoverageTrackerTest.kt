package dev.pocket3d.capture.logic

import dev.pocket3d.core.capture.CoverageGrid
import dev.pocket3d.core.math.Quat
import dev.pocket3d.core.math.Vec3
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.cos
import kotlin.math.sin

class CoverageTrackerTest {
    private val center = Vec3(0.2f, 0.0f, -1.0f)

    private fun filledCells(t: CoverageTracker) = t.grid.counts.sumOf { row -> row.count { it > 0 } }

    /** Camera position on a ring of [radius] around [center] at [elevationDeg]. */
    private fun ring(azDeg: Double, elevationDeg: Double, radius: Double = 0.5): Vec3 {
        val az = Math.toRadians(azDeg); val el = Math.toRadians(elevationDeg)
        // Azimuth is measured from world +X towards −Z (counter-clockwise seen from above, +Y up).
        return center + Vec3((radius * cos(el) * cos(az)).toFloat(), (radius * sin(el)).toFloat(), (-radius * cos(el) * sin(az)).toFloat())
    }

    @Test fun fiftyPhotosFromOneSpotFillExactlyOneCell() {
        val t = CoverageTracker()
        val p = ring(37.0, 10.0)
        repeat(50) { t.addTracked("f$it", p, center, segment = 0) }
        assertEquals(50, t.grid.photos)
        assertEquals(50, t.size)
        assertEquals(1, filledCells(t))
        assertEquals(1, t.grid.azimuthCovered)
        assertEquals(1, t.grid.bandsCovered)
    }

    @Test fun fiftyPhotosWithHandShakeStillFillOneCell() {
        val t = CoverageTracker()
        // ±1 cm jitter around a spot in the middle of a sector (45° is the centre of sector 1).
        repeat(50) {
            val j = Vec3(0.01f * sin(it * 1.3f), 0.01f * cos(it * 0.7f), 0.01f * sin(it * 2.1f))
            t.addTracked("f$it", ring(45.0, 8.0) + j, center, segment = 0)
        }
        assertEquals(1, filledCells(t))
    }

    @Test fun fullRingOfThirtyPosesFillsAllTwelveSectorsOfOneBand() {
        val t = CoverageTracker()
        for (i in 0 until 30) t.addTracked("f$i", ring(i * 12.0 + 3.0, 5.0), center, segment = 0)
        assertEquals(12, t.grid.azimuthCovered)
        assertEquals(1, t.grid.bandsCovered)
        assertEquals(12, t.grid.bandCovered(0))
        assertEquals(0, t.grid.bandCovered(1))
        assertEquals(0.0, t.grid.largestGapDeg, 1e-9)
    }

    @Test fun halfRingLeavesHalfTheSectorsEmpty() {
        val t = CoverageTracker()
        for (i in 0 until 15) t.addTracked("f$i", ring(i * 12.0 + 3.0, 5.0), center, segment = 0)
        assertEquals(6, t.grid.azimuthCovered)
        assertEquals(180.0, t.grid.largestGapDeg, 1e-9)
    }

    @Test fun threeElevationRingsFillThreeBands() {
        val t = CoverageTracker()
        var n = 0
        for (el in listOf(5.0, 35.0, 65.0)) for (i in 0 until 30) t.addTracked("f${n++}", ring(i * 12.0 + 3.0, el), center, 0)
        assertEquals(3, t.grid.bandsCovered)
        assertEquals(36, filledCells(t))
    }

    @Test fun bandBoundariesMatchTheGrid() {
        val t = CoverageTracker()
        t.addTracked("low", ring(10.0, 19.0), center, 0)
        t.addTracked("mid", ring(10.0, 21.0), center, 0)
        t.addTracked("high", ring(10.0, 51.0), center, 0)
        assertEquals(1, t.grid.counts[0].sum())
        assertEquals(1, t.grid.counts[1].sum())
        assertEquals(1, t.grid.counts[2].sum())
    }

    @Test fun undoEmptiesTheCellAgain() {
        val t = CoverageTracker()
        t.addTracked("a", ring(10.0, 5.0), center, 0)
        t.addTracked("b", ring(100.0, 5.0), center, 0)
        assertEquals(2, filledCells(t))
        t.remove("b")
        assertEquals(1, filledCells(t))
        assertEquals(1, t.grid.photos)
        t.remove("does-not-exist")
        assertEquals(1, t.grid.photos)
        t.retain(emptySet())
        assertEquals(0, t.grid.photos)
    }

    @Test fun sameFrameIdIsNeverCountedTwice() {
        val t = CoverageTracker()
        t.addTracked("a", ring(10.0, 5.0), center, 0)
        t.addTracked("a", ring(200.0, 5.0), center, 0)
        assertEquals(1, t.grid.photos)
        assertEquals(1, filledCells(t))
    }

    @Test fun cameraAtTheCentreFallsBackToTheOrientationEstimate() {
        val t = CoverageTracker()
        t.addTracked("a", center, center, 0, orientationDir = Vec3(0f, 0f, 1f))
        assertEquals(1, t.size)
        assertEquals(0, t.trackedCount)
        assertEquals(1, t.estimatedCount)
        t.addTracked("b", center, center, 0, orientationDir = null)
        assertEquals(1, t.size)
    }

    @Test fun recenterRecomputesOnlyTheGivenSegment() {
        val t = CoverageTracker()
        // Taken before the object was set: viewing-direction estimate, with tracked positions.
        t.addEstimated("a", Vec3(1f, 0f, 0f), position = ring(90.0, 5.0), segment = 1)
        t.addEstimated("old", Vec3(1f, 0f, 0f), position = ring(180.0, 5.0), segment = 0)
        assertEquals(0, t.trackedCount)
        t.recenter(center, segment = 1)
        assertEquals(1, t.trackedCount)
        val a = t.entries().first { it.frameId == "a" }
        val (az, _) = OrientationViewpoint.azimuthElevation(a.dir)
        assertEquals(90.0, az, 0.01)
        assertFalse(t.entries().first { it.frameId == "old" }.tracked)
    }

    @Test fun nearestAngleIsInfiniteWithoutPhotosAndSmallAtAKeptView() {
        val t = CoverageTracker()
        assertTrue(t.nearestAngleDeg(Vec3.X).isInfinite())
        t.addTracked("a", ring(0.0, 0.0), center, 0)
        assertEquals(0.0, t.nearestAngleDeg(Vec3.X), 0.05)
        assertEquals(90.0, t.nearestAngleDeg(Vec3.Z), 0.05)
    }

    // --- orientation estimate ---------------------------------------------------------------

    /** Phone held upright in portrait, screen towards the user, camera looking at compass [headingDeg], pitched down by [pitchDownDeg]. */
    private fun deviceQuat(headingDeg: Double, pitchDownDeg: Double): Quat {
        // Device → ENU world. Upright facing north: device x = east, y = up, z = south → +90° about X.
        val upright = Quat.axisAngle(Vec3.X, Math.toRadians(90.0 - pitchDownDeg).toFloat())
        val yaw = Quat.axisAngle(Vec3.Z, Math.toRadians(-headingDeg).toFloat())   // compass heading is clockwise
        return yaw * upright
    }

    @Test fun uprightPhoneLooksHorizontally() {
        val dir = OrientationViewpoint.dirFromDeviceQuat(deviceQuat(0.0, 0.0))
        // Camera looks north, so the viewpoint lies south of the object: z = −north = +1.
        assertEquals(0f, dir.x, 1e-5f); assertEquals(0f, dir.y, 1e-5f); assertEquals(1f, dir.z, 1e-5f)
        val (_, el) = OrientationViewpoint.azimuthElevation(dir)
        assertEquals(0.0, el, 1e-3)
    }

    @Test fun lookingDownRaisesTheEstimatedElevation() {
        val (_, el) = OrientationViewpoint.azimuthElevation(OrientationViewpoint.dirFromDeviceQuat(deviceQuat(40.0, 45.0)))
        assertEquals(45.0, el, 1e-3)
        assertEquals(1, CoverageGrid.bandOf(el))
        val (_, top) = OrientationViewpoint.azimuthElevation(OrientationViewpoint.dirFromDeviceQuat(deviceQuat(40.0, 70.0)))
        assertEquals(2, CoverageGrid.bandOf(top))
    }

    @Test fun turningAFullCircleFillsAllSectorsButStandingStillFillsOne() {
        val t = CoverageTracker()
        for (i in 0 until 30) t.addEstimated("f$i", OrientationViewpoint.dirFromDeviceQuat(deviceQuat(i * 12.0 + 3.0, 5.0)))
        assertEquals(12, t.grid.azimuthCovered)
        assertEquals(30, t.estimatedCount)

        val still = CoverageTracker()
        repeat(50) { still.addEstimated("f$it", OrientationViewpoint.dirFromDeviceQuat(deviceQuat(77.0, 12.0))) }
        assertEquals(1, filledCells(still))
    }

    @Test fun arCameraQuatDirectionIsTheReverseOfForward() {
        // Identity GL camera looks along −Z; the viewpoint direction (object → camera) is +Z.
        assertEquals(Vec3.Z, OrientationViewpoint.dirFromCameraQuat(Quat.IDENTITY))
    }

    @Test fun rotationVectorWithoutScalarComponentIsCompleted() {
        val q = Quat.axisAngle(Vec3.Y, 1.0f)
        val a = OrientationViewpoint.quatFromRotationVector(floatArrayOf(q.x, q.y, q.z))
        val b = OrientationViewpoint.quatFromRotationVector(floatArrayOf(q.x, q.y, q.z, q.w))
        assertEquals(0.0, OrientationViewpoint.angleDeg(a, b), 1e-3)
    }

    @Test fun angularSpeedEstimatorConvergesToTheTrueRate() {
        val e = AngularSpeedEstimator()
        var t = 0L
        // 20°/s about Y sampled at 50 Hz.
        for (i in 0..200) {
            e.update(Quat.axisAngle(Vec3.Y, Math.toRadians(i * 0.4).toFloat()), t)
            t += 20_000_000L
        }
        assertEquals(20.0, e.degPerSec, 0.5)
        // A long gap resets instead of reporting a bogus average.
        e.update(Quat.axisAngle(Vec3.Y, 3f), t + 5_000_000_000L)
        assertEquals(0.0, e.degPerSec, 1e-9)
    }

    @Test fun linearSpeedEstimatorConvergesToTheTrueRate() {
        val e = LinearSpeedEstimator()
        var t = 0L
        for (i in 0..200) { e.update(Vec3(i * 0.004f, 0f, 0f), t); t += 20_000_000L }
        assertEquals(0.2, e.metersPerSec, 0.01)
    }
}
