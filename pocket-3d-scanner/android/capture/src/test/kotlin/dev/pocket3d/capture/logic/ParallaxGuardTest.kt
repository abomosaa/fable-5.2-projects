package dev.pocket3d.capture.logic

import dev.pocket3d.core.math.Vec3
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.tan
import kotlin.random.Random

class ParallaxGuardTest {
    private val w = 160; private val h = 120

    /** A textured scene much larger than the frame; views are crops at an offset (ox, oy). */
    private val scene: Array<IntArray> = run {
        val r = Random(5)
        val cells = Array(60) { IntArray(120) { r.nextInt(20, 236) } }
        Array(360) { y -> IntArray(720) { x -> cells[y / 6][x / 6] } }
    }

    private fun view(ox: Int, oy: Int): ByteArray = ByteArray(w * h) { i -> scene[100 + oy + i / w][250 + ox + i % w].toByte() }

    @Test fun measuresKnownShiftsOfTheCentreWithSubPixelAccuracy() {
        val a = view(0, 0)
        for ((dx, dy) in listOf(0 to 0, 7 to 0, -12 to 0, 0 to 5, 9 to -6, -20 to 10)) {
            val s = ImageShift.estimate(a, view(-dx, -dy), w, h)!!       // content moved by (+dx, +dy)
            assertEquals("dx for $dx,$dy", dx.toFloat(), s.dx, 0.6f)
            assertEquals("dy for $dx,$dy", dy.toFloat(), s.dy, 0.6f)
            assertTrue(s.confidence >= ImageShift.MIN_CONFIDENCE)
        }
    }

    @Test fun flatOrUnrelatedFramesGiveNoShiftRatherThanAWrongOne() {
        val flat = ByteArray(w * h) { 120 }
        assertNull(ImageShift.estimate(flat, flat, w, h))
        val r = Random(1)
        val noise = ByteArray(w * h) { (118 + r.nextInt(5)).toByte() }   // sensor noise on a blank wall
        assertNull(ImageShift.estimate(flat, noise, w, h))
        assertNull(ImageShift.estimate(view(0, 0), view(300, 130).reversedArray(), w, h))
        assertNull(ImageShift.estimate(ByteArray(10), ByteArray(10), w, h))
    }

    private fun dir(yawDeg: Double) = Vec3(sin(Math.toRadians(yawDeg)).toFloat(), 0f, -cos(Math.toRadians(yawDeg)).toFloat())

    /** Simulates one capture step: the phone turns by [stepDeg]; the picture centre slides by [slideFraction] of the pure-rotation amount. */
    private fun step(g: ParallaxGuard, state: DoubleArray, stepDeg: Double, slideFraction: Double, f: Float, trackable: Boolean = true) {
        val frames = 10
        for (i in 1..frames) {
            state[0] += stepDeg / frames
            state[1] += slideFraction * f * tan(Math.toRadians(stepDeg / frames))     // slide of this frame pair
            state[2] += 1.0
            if (trackable) state[3] += 1.0
            g.onSample(dir(state[0]), state[1], 0.0, state[3].toLong(), state[2].toLong(), 480)
        }
        g.onCapture()
    }

    @Test fun orbitingKeepsTheObjectCentredAndIsNotFlagged() {
        val f = 360f
        val g = ParallaxGuard { f }
        val st = DoubleArray(4)
        g.onSample(dir(0.0), 0.0, 0.0, 0, 0, 480); g.onCapture()
        repeat(8) { step(g, st, 12.0, 0.08, f) }                  // object stays in the centre: tiny residual slide
        assertEquals(ParallaxGuard.Verdict.ORBIT, g.lastVerdict)
        assertFalse(g.turningInPlace); assertFalse(g.holdAutoCapture())
    }

    @Test fun turningOnTheSpotIsFlaggedAfterTwoStepsAndPausesAutoCapture() {
        val f = 360f
        val g = ParallaxGuard { f }
        val st = DoubleArray(4)
        g.onSample(dir(0.0), 0.0, 0.0, 0, 0, 480); g.onCapture()
        step(g, st, 12.0, 1.0, f)                                 // the whole picture slides with the rotation
        assertEquals(ParallaxGuard.Verdict.TURNING, g.lastVerdict)
        assertFalse("one step is not enough to accuse the user", g.turningInPlace)
        // while the next step looks the same, auto capture waits instead of taking another useless photo
        for (i in 1..10) { st[0] += 1.2; st[1] += f * tan(Math.toRadians(1.2)); st[2] += 1.0; st[3] += 1.0
            g.onSample(dir(st[0]), st[1], 0.0, st[3].toLong(), st[2].toLong(), 480) }
        assertTrue(g.holdAutoCapture())
        g.onCapture()
        assertTrue(g.turningInPlace)
        // the user starts walking around the object: the warning clears
        step(g, st, 12.0, 0.05, f)
        assertFalse(g.turningInPlace); assertFalse(g.holdAutoCapture())
    }

    @Test fun abstainsWhenTheCentreCannotBeTrackedOrTheStepIsTiny() {
        val f = 360f
        val g = ParallaxGuard { f }
        val st = DoubleArray(4)
        g.onSample(dir(0.0), 0.0, 0.0, 0, 0, 480); g.onCapture()
        step(g, st, 12.0, 1.0, f, trackable = false)              // blank wall in the centre: no verdict
        assertEquals(ParallaxGuard.Verdict.UNKNOWN, g.lastVerdict)
        step(g, st, 2.0, 1.0, f)                                  // 2° is within sensor noise
        assertEquals(ParallaxGuard.Verdict.UNKNOWN, g.lastVerdict)
        assertFalse(g.turningInPlace)
        assertNull(ParallaxGuard { f }.currentRatio())
    }

    @Test fun usesATypicalFocalLengthWhenTheCameraReportsNone() {
        val g = ParallaxGuard { null }
        val st = DoubleArray(4)
        val assumed = ParallaxGuard.DEFAULT_FOCAL_PER_WIDTH * 480
        g.onSample(dir(0.0), 0.0, 0.0, 0, 0, 480); g.onCapture()
        step(g, st, 12.0, 1.0, assumed); step(g, st, 12.0, 1.0, assumed)
        assertTrue(g.turningInPlace)
        assertNotNull(g.lastVerdict)
    }
}
