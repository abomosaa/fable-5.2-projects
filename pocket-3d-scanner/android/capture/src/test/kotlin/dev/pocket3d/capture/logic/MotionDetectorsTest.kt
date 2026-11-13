package dev.pocket3d.capture.logic

import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.project.TrackingSegment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.cos
import kotlin.math.sin

class MotionDetectorsTest {
    private val center = Vec3(0f, 0.8f, -1f)

    /** Camera on a circle of [radius] around [center], looking at the centre. */
    private fun orbit(azDeg: Double, radius: Double = 0.5, hash: Long? = null, segment: Int = 0): PoseSample {
        val az = Math.toRadians(azDeg)
        val p = center + Vec3((radius * cos(az)).toFloat(), 0.15f, (radius * sin(az)).toFloat())
        return PoseSample(p, (center - p).normalized(), segment, hash)
    }

    /** Camera held at arm's length [arm] from a body standing at [center], looking outwards. */
    private fun pan(azDeg: Double, arm: Double): PoseSample {
        val az = Math.toRadians(azDeg)
        val out = Vec3(cos(az).toFloat(), 0f, sin(az).toFloat())
        return PoseSample(center + out * arm.toFloat(), out, 0)
    }

    // --- panorama --------------------------------------------------------------------------------

    @Test fun normalOrbitIsNeverCalledTurningInPlace() {
        for (radius in listOf(0.25, 0.5, 1.5)) {
            val samples = ArrayList<PoseSample>()
            for (i in 0 until 30) {
                samples += orbit(i * 12.0, radius)
                assertFalse("radius=$radius i=$i", PanoramaDetector.isTurningInPlace(samples))
            }
        }
    }

    @Test fun pureRotationOnTheSpotIsDetected() {
        val samples = (0 until 4).map { pan(it * 15.0, arm = 0.0) }
        assertTrue(PanoramaDetector.isTurningInPlace(samples))
    }

    @Test fun panningAtArmsLengthIsDetected() {
        // The camera does translate (it swings on a 40 cm arm) but looks away from the pivot.
        val samples = (0 until 4).map { pan(it * 15.0, arm = 0.4) }
        assertTrue(PanoramaDetector.isTurningInPlace(samples))
        assertTrue(PanoramaDetector.pivotDistance(samples)!! < 0)
    }

    @Test fun smallRotationOrFewSamplesDoNotTrigger() {
        assertFalse(PanoramaDetector.isTurningInPlace((0 until 4).map { pan(it * 5.0, 0.0) }))   // 15° in total
        assertFalse(PanoramaDetector.isTurningInPlace((0 until 2).map { pan(it * 40.0, 0.0) }))  // 2 samples
        assertFalse(PanoramaDetector.isTurningInPlace(emptyList()))
    }

    @Test fun raisingTheCameraOverTheObjectIsNotAPanorama() {
        // Same azimuth, climbing from a low to a high viewpoint while aiming at the object.
        val samples = listOf(5.0, 25.0, 45.0, 65.0).map { elDeg ->
            val el = Math.toRadians(elDeg)
            val p = center + Vec3((0.5 * cos(el)).toFloat(), (0.5 * sin(el)).toFloat(), 0f)
            PoseSample(p, (center - p).normalized(), 0)
        }
        assertFalse(PanoramaDetector.isTurningInPlace(samples))
    }

    @Test fun pivotDistanceOfAnOrbitIsItsRadius() {
        val d = PanoramaDetector.pivotDistance((0 until 4).map { orbit(it * 12.0, 0.5) })!!
        // The cameras sit 15 cm above the centre: distance to it is sqrt(0.5² + 0.15²).
        assertEquals(Math.sqrt(0.5 * 0.5 + 0.15 * 0.15), d, 1e-3)
    }

    @Test fun parallelRaysHaveNoPivot() {
        val samples = (0 until 3).map { PoseSample(Vec3(it * 0.1f, 0f, 0f), Vec3(0f, 0f, -1f), 0) }
        assertNull(PanoramaDetector.pivotDistance(samples))
        assertFalse(PanoramaDetector.isTurningInPlace(samples))
    }

    @Test fun onlyTheCurrentSegmentIsConsidered() {
        // Three panning samples, but split over two tracking segments: positions are not comparable.
        val samples = listOf(pan(0.0, 0.0), pan(20.0, 0.0).copy(segment = 1), pan(40.0, 0.0).copy(segment = 1))
        assertFalse(PanoramaDetector.isTurningInPlace(samples))
    }

    // --- turntable -------------------------------------------------------------------------------

    private val hashA = 0x0123_4567_89AB_CDEFL
    private val hashB = hashA xor 0x0000_FFFF_FF00_0000L   // 24 bits differ
    private val hashC = hashB xor 0x00FF_0000_00FF_FF00L   // 24 bits differ from B

    @Test fun staticPoseWithChangingImageTriggers() {
        val samples = listOf(orbit(10.0, hash = hashA), orbit(10.0, hash = hashB), orbit(10.0, hash = hashC))
        assertTrue(TurntableDetector.pairSuspicious(samples[0], samples[1]))
        assertTrue(TurntableDetector.detect(samples))
    }

    @Test fun handHeldJitterStillCountsAsStatic() {
        val a = orbit(10.0, hash = hashA)
        val b = orbit(11.5, hash = hashB)   // 1.5° on a 50 cm orbit = 1.3 cm
        val c = orbit(9.5, hash = hashC)
        assertTrue(TurntableDetector.detect(listOf(a, b, c)))
    }

    @Test fun normalOrbitDoesNotTriggerEvenThoughEveryImageDiffers() {
        val hashes = listOf(hashA, hashB, hashC)
        val samples = ArrayList<PoseSample>()
        for (i in 0 until 30) {
            samples += orbit(i * 12.0, hash = hashes[i % 3])
            assertFalse("i=$i", TurntableDetector.detect(samples))
        }
    }

    @Test fun staticPoseWithTheSameImageDoesNotTrigger() {
        val samples = listOf(orbit(10.0, hash = hashA), orbit(10.0, hash = hashA xor 0x3L), orbit(10.0, hash = hashA))
        assertFalse(TurntableDetector.detect(samples))
    }

    @Test fun aSingleChangedPairIsNotEnough() {
        // Somebody walked through the background once.
        assertFalse(TurntableDetector.detect(listOf(orbit(10.0, hash = hashA), orbit(10.0, hash = hashB))))
        assertFalse(TurntableDetector.detect(listOf(orbit(10.0, hash = hashA), orbit(10.0, hash = hashA), orbit(10.0, hash = hashB))))
    }

    @Test fun missingHashesOrDifferentSegmentsNeverTrigger() {
        assertFalse(TurntableDetector.detect(listOf(orbit(10.0), orbit(10.0), orbit(10.0))))
        assertFalse(TurntableDetector.detect(listOf(orbit(10.0, hash = hashA, segment = 0), orbit(10.0, hash = hashB, segment = 1),
                                                     orbit(10.0, hash = hashC, segment = 2))))
    }

    // --- segments --------------------------------------------------------------------------------

    @Test fun trackingRecoveryStartsANewSegment() {
        val s = SegmentTracker()
        assertFalse(s.onTracking(false))          // still initialising: not a loss
        assertFalse(s.onTracking(true))
        assertEquals(0, s.current)
        s.addFrame("a"); s.addFrame("b")
        assertFalse(s.onTracking(false))          // lost
        assertEquals(0, s.current)
        assertTrue(s.onTracking(true))            // recovered → new segment
        assertEquals(1, s.current)
        assertFalse(s.onTracking(true))
        s.addFrame("c")
        assertEquals(listOf(TrackingSegment(0, listOf("a", "b")), TrackingSegment(1, listOf("c"))), s.snapshot())
    }

    @Test fun repeatedLossesWithoutPhotosDoNotBurnSegmentIds() {
        val s = SegmentTracker()
        s.onTracking(true); s.addFrame("a")
        repeat(3) { s.onTracking(false); assertTrue(s.onTracking(true)) }
        assertEquals(1, s.current)
        s.addFrame("b")
        assertEquals(2, s.segmentCount)
    }

    @Test fun continuingAStoredSessionNeverReusesAnOldSegment() {
        val s = SegmentTracker(listOf(TrackingSegment(0, listOf("a")), TrackingSegment(3, listOf("b", "c"))))
        assertEquals(4, s.current)
        s.onTracking(true)
        s.addFrame("d")
        assertEquals(4, s.segmentOf("d"))
        assertEquals(3, s.segmentOf("b"))
        assertEquals(3, s.snapshot().size)
    }

    @Test fun recreatedArSessionStartsANewSegment() {
        val s = SegmentTracker()
        s.onTracking(true); s.addFrame("a")
        s.onSessionRecreated()
        assertEquals(1, s.current)
        assertFalse(s.onTracking(true))   // first tracking of the new session is not a "recovery"
        s.addFrame("b")
        assertEquals(1, s.segmentOf("b"))
    }

    @Test fun aPhotoConfirmedAfterARecoveryStaysInTheSegmentItWasTakenIn() {
        val s = SegmentTracker()
        s.onTracking(true); s.addFrame("a")
        val takenIn = s.current
        s.onTracking(false); s.onTracking(true)      // tracking lost and recovered while the user decides
        assertEquals(1, s.current)
        s.addFrame("weak-but-kept", takenIn)
        s.addFrame("b")
        assertEquals(listOf(TrackingSegment(0, listOf("a", "weak-but-kept")), TrackingSegment(1, listOf("b"))), s.snapshot())
    }

    @Test fun removedFramesLeaveNoEmptySegments() {
        val s = SegmentTracker()
        s.onTracking(true); s.addFrame("a")
        s.onTracking(false); s.onTracking(true); s.addFrame("b")
        s.removeFrame("b")
        assertEquals(listOf(TrackingSegment(0, listOf("a"))), s.snapshot())
        s.retain(emptySet())
        assertTrue(s.snapshot().isEmpty())
    }
}
