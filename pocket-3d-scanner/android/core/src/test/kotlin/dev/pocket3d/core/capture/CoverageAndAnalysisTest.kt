package dev.pocket3d.core.capture

import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.project.FrameFlag
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random

class CoverageAndAnalysisTest {
    private val up = Vec3.Y
    private val ref = Vec3.Z

    private fun ring(n: Int, elevationDeg: Double, radius: Double = 1.0, fromDeg: Double = 0.0, toDeg: Double = 360.0): List<Vec3> =
        (0 until n).map { i ->
            val a = Math.toRadians(fromDeg + (toDeg - fromDeg) * i / n)
            val e = Math.toRadians(elevationDeg)
            Vec3((radius * cos(e) * sin(a)).toFloat(), (radius * sin(e)).toFloat(), (radius * cos(e) * cos(a)).toFloat())
        }

    @Test fun manyPhotosFromOneSpotFillExactlyOneCell() {
        val g = CoverageGrid()
        repeat(50) { g.addPosition(Vec3(1f, 0.2f, 0.1f), Vec3.ZERO, up, ref) }
        assertEquals(50, g.photos)
        assertEquals(1, g.azimuthCovered)
        assertEquals(1, g.bandsCovered)
        assertEquals(1f / 24f, g.ringFraction, 1e-6f)
        assertEquals(330.0, g.largestGapDeg, 1e-9)
    }

    @Test fun fullRingFillsAllSectorsOfOneBandOnly() {
        val g = CoverageGrid()
        ring(30, 10.0).forEach { g.addPosition(it, Vec3.ZERO, up, ref) }
        assertEquals(12, g.azimuthCovered)
        assertEquals(12, g.bandCovered(0)); assertEquals(0, g.bandCovered(1)); assertEquals(0, g.bandCovered(2))
        assertEquals(0.0, g.largestGapDeg, 1e-9)
        assertEquals(0.5f, g.ringFraction, 1e-6f)
        assertTrue(g.guidance().any { it.contains("one height") })
        ring(30, 35.0).forEach { g.addPosition(it, Vec3.ZERO, up, ref) }
        assertEquals(1f, g.ringFraction, 1e-6f)
        assertFalse(g.guidance().any { it.contains("one height") })
    }

    @Test fun halfOrbitReportsTheMissingSide() {
        val g = CoverageGrid()
        ring(15, 25.0, fromDeg = 0.0, toDeg = 180.0).forEach { g.addPosition(it, Vec3.ZERO, up, ref) }
        assertEquals(6, g.azimuthCovered)
        assertEquals(180.0, g.largestGapDeg, 1e-9)
        assertTrue(g.guidance().first().contains("180°"))
    }

    @Test fun coverageIsRelativeToTheObjectNotTheWorldOrigin() {
        val center = Vec3(3f, 1f, -2f)
        val g = CoverageGrid()
        // (start at 7° so that no viewpoint sits exactly on a sector boundary)
        ring(24, 30.0, fromDeg = 7.0, toDeg = 367.0).forEach { g.addPosition(it + center, center, up, ref) }
        assertEquals(12, g.azimuthCovered)
        assertEquals(12, g.bandCovered(1))
        assertEquals(List(12) { 2 }, g.counts[1].toList())
        // distance does not matter, only direction
        val h = CoverageGrid()
        ring(24, 30.0, radius = 7.0, fromDeg = 7.0, toDeg = 367.0).forEach { h.addPosition(it + center, center, up, ref) }
        assertEquals(g.counts.map { it.toList() }, h.counts.map { it.toList() })
    }

    @Test fun elevationBandsAndAzimuthWrap() {
        assertEquals(0, CoverageGrid.bandOf(-10.0)); assertEquals(0, CoverageGrid.bandOf(19.9))
        assertEquals(1, CoverageGrid.bandOf(20.0)); assertEquals(1, CoverageGrid.bandOf(49.9))
        assertEquals(2, CoverageGrid.bandOf(50.0)); assertEquals(2, CoverageGrid.bandOf(89.0))
        val g = CoverageGrid()
        assertEquals(g.binOf(-15.0), g.binOf(345.0))
        assertEquals(0, g.binOf(360.0)); assertEquals(11, g.binOf(359.9)); assertEquals(0, g.binOf(720.0))
        val (az, el) = CoverageGrid.azimuthElevation(Vec3(0f, 1f, 1f), Vec3.ZERO, up, ref)
        assertEquals(0.0, az, 1e-6); assertEquals(45.0, el, 1e-4)
    }

    @Test fun viewSpacingThresholds() {
        val a = Vec3(0f, 0f, -1f)
        fun dir(deg: Double) = Vec3(sin(Math.toRadians(deg)).toFloat(), 0f, -cos(Math.toRadians(deg)).toFloat())
        assertEquals(12.0, ViewSpacing.angleDeg(a, dir(12.0)), 1e-3)
        assertEquals(Double.POSITIVE_INFINITY, ViewSpacing.nearestAngleDeg(a, emptyList()), 0.0)
        assertEquals(5.0, ViewSpacing.nearestAngleDeg(dir(25.0), listOf(a, dir(20.0), dir(40.0))), 1e-3)
        assertEquals(1.0, ViewSpacing.estimatedOverlap(0.0), 0.0)
        assertEquals(0.0, ViewSpacing.estimatedOverlap(60.0), 0.0)
        assertTrue(ViewSpacing.estimatedOverlap(ViewSpacing.TARGET_STEP_DEG) > 0.7)
        assertTrue(ViewSpacing.DUPLICATE_DEG < ViewSpacing.TARGET_STEP_DEG && ViewSpacing.TARGET_STEP_DEG < ViewSpacing.MAX_STEP_DEG)
    }

    // ---------------------------------------------------------------- image analysis
    private fun texture(w: Int, h: Int, seed: Int = 1): ByteArray {
        val r = Random(seed)
        // blocky random texture: strong edges at a 4 px scale
        val cells = Array(h / 4 + 1) { IntArray(w / 4 + 1) { r.nextInt(30, 226) } }
        return ByteArray(w * h) { i -> cells[(i / w) / 4][(i % w) / 4].toByte() }
    }

    private fun boxBlur(src: ByteArray, w: Int, h: Int, radius: Int): ByteArray {
        val out = ByteArray(src.size)
        for (y in 0 until h) for (x in 0 until w) {
            var s = 0; var n = 0
            for (dy in -radius..radius) for (dx in -radius..radius) {
                val xx = x + dx; val yy = y + dy
                if (xx in 0 until w && yy in 0 until h) { s += src[yy * w + xx].toInt() and 0xFF; n++ }
            }
            out[y * w + x] = (s / n).toByte()
        }
        return out
    }

    @Test fun blurLowersLaplacianVarianceAndIsFlagged() {
        val w = 160; val h = 120
        val sharp = texture(w, h)
        val blurred = boxBlur(sharp, w, h, 4)
        val vs = FrameAnalysis.laplacianVariance(sharp, w, h)
        val vb = FrameAnalysis.laplacianVariance(blurred, w, h)
        assertTrue("sharp=$vs blurred=$vb", vs > 20 * vb)
        assertFalse(FrameAnalysis.analyze(sharp, w, h).second.contains(FrameFlag.BLUR))
        assertTrue(FrameAnalysis.analyze(blurred, w, h).second.contains(FrameFlag.BLUR))
        assertEquals(0.0, FrameAnalysis.laplacianVariance(ByteArray(w * h) { 77 }, w, h), 1e-12)
    }

    @Test fun exposureFlags() {
        val w = 64; val h = 48
        val dark = ByteArray(w * h) { (it % 12).toByte() }
        val bright = ByteArray(w * h) { if (it % 3 == 0) 255.toByte() else 180.toByte() }
        val ok = texture(w, h)
        assertTrue(FrameAnalysis.analyze(dark, w, h).second.contains(FrameFlag.DARK))
        assertTrue(FrameAnalysis.analyze(bright, w, h).second.contains(FrameFlag.OVEREXPOSED))
        val (q, flags) = FrameAnalysis.analyze(ok, w, h)
        assertFalse(flags.contains(FrameFlag.DARK) || flags.contains(FrameFlag.OVEREXPOSED))
        assertEquals(1.0 / 3.0, FrameAnalysis.exposure(bright).clippedHigh, 0.01)
        assertTrue(q.meanLuma!! in 100.0..150.0)
    }

    @Test fun dHashSeparatesDuplicatesFromDifferentViews() {
        val w = 160; val h = 120
        val a = texture(w, h, seed = 3)
        val brighter = ByteArray(a.size) { ((a[it].toInt() and 0xFF) + 12).coerceAtMost(255).toByte() }
        val other = texture(w, h, seed = 99)
        val ha = FrameAnalysis.dHash(boxBlur(a, w, h, 6), w, h)
        assertTrue(FrameAnalysis.hammingDistance(ha, FrameAnalysis.dHash(boxBlur(brighter, w, h, 6), w, h)) <= FrameAnalysis.DUPLICATE_HASH_DISTANCE)
        assertTrue(FrameAnalysis.hammingDistance(ha, FrameAnalysis.dHash(boxBlur(other, w, h, 6), w, h)) > 12)
        assertEquals(0, FrameAnalysis.hammingDistance(ha, ha))
    }

    @Test fun downsampleHonoursStridesAndAverages() {
        // 8x4 image stored with row stride 10 and pixel stride 2
        val w = 8; val h = 4; val stride = 20; val px = 2
        val buf = ByteArray(stride * h)
        for (y in 0 until h) for (x in 0 until w) buf[y * stride + x * px] = (if (x < 4) 40 else 200).toByte()
        val (out, ow, oh) = FrameAnalysis.downsample(buf, w, h, stride, px, targetWidth = 4)
        assertEquals(4, ow); assertEquals(2, oh)
        assertEquals(listOf(40, 40, 200, 200, 40, 40, 200, 200), out.map { it.toInt() and 0xFF })
        // never upsamples
        val (same, sw, sh) = FrameAnalysis.downsample(ByteArray(12) { it.toByte() }, 4, 3, targetWidth = 480)
        assertEquals(4, sw); assertEquals(3, sh); assertEquals(12, same.size)
    }
}
