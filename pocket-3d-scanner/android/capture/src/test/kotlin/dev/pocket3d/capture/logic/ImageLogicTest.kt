package dev.pocket3d.capture.logic

import dev.pocket3d.core.capture.FrameAnalysis
import dev.pocket3d.core.capture.ImageGeometry
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer

class ImageLogicTest {
    // --- device orientation → EXIF -------------------------------------------------------------

    @Test fun portraitPhoneWithTypicalBackSensorNeedsNinetyDegrees() {
        // Back sensors are usually mounted at 90°: a portrait photo is stored sideways, EXIF 6.
        assertEquals(90, DeviceOrientation.imageRotationCw(90, 0))
        assertEquals(6, DeviceOrientation.exifOrientation(90, 0))
    }

    @Test fun usualLandscapeGripStoresAnUprightImage() {
        // Right edge on top (OrientationEventListener = 270): the sensor image is already upright.
        assertEquals(0, DeviceOrientation.imageRotationCw(90, 270))
        assertEquals(1, DeviceOrientation.exifOrientation(90, 270))
    }

    @Test fun otherLandscapeAndUpsideDown() {
        assertEquals(3, DeviceOrientation.exifOrientation(90, 90))    // left edge on top → 180°
        assertEquals(8, DeviceOrientation.exifOrientation(90, 180))   // upside down → 270°
    }

    @Test fun sensorsMountedDifferently() {
        assertEquals(8, DeviceOrientation.exifOrientation(270, 0))
        assertEquals(1, DeviceOrientation.exifOrientation(0, 0))     // landscape-native devices
        assertEquals(6, DeviceOrientation.exifOrientation(0, 90))
    }

    @Test fun frontCamerasSubtractTheDeviceRotation() {
        assertEquals(270, DeviceOrientation.imageRotationCw(270, 0, frontFacing = true))
        assertEquals(180, DeviceOrientation.imageRotationCw(270, 90, frontFacing = true))
        assertEquals(0, DeviceOrientation.imageRotationCw(270, 270, frontFacing = true))
    }

    @Test fun exifOrientationAgreesWithCoreQuarterTurns() {
        for (sensor in listOf(0, 90, 180, 270)) for (device in listOf(0, 90, 180, 270)) {
            val exif = DeviceOrientation.exifOrientation(sensor, device)
            val (turns, mirrored) = ImageGeometry.exifQuarterTurns(exif)
            assertEquals(DeviceOrientation.imageRotationCw(sensor, device) / 90, turns)
            assertTrue(!mirrored)
        }
    }

    @Test fun rawOrientationSnapsToQuarterTurnsWithHysteresis() {
        assertEquals(0, DeviceOrientation.snap(10, 0))
        assertEquals(0, DeviceOrientation.snap(350, 0))
        assertEquals(0, DeviceOrientation.snap(50, 0))       // inside the hysteresis band: stays
        assertEquals(90, DeviceOrientation.snap(60, 0))
        assertEquals(90, DeviceOrientation.snap(40, 90))     // and does not flip back at once
        assertEquals(0, DeviceOrientation.snap(30, 90))
        assertEquals(270, DeviceOrientation.snap(275, 0))
        assertEquals(180, DeviceOrientation.snap(170, 0))
        assertEquals(0, DeviceOrientation.snap(355, 270))
    }

    @Test fun flatPhoneKeepsTheLastKnownOrientation() {
        assertEquals(270, DeviceOrientation.snap(-1, 270))
        assertEquals(0, DeviceOrientation.snap(-1, 0))
    }

    @Test fun cameraXTargetRotationIsTheInverseOfTheDeviceRotation() {
        assertEquals(0, DeviceOrientation.surfaceRotation(0))     // Surface.ROTATION_0
        assertEquals(3, DeviceOrientation.surfaceRotation(90))    // Surface.ROTATION_270
        assertEquals(2, DeviceOrientation.surfaceRotation(180))   // Surface.ROTATION_180
        assertEquals(1, DeviceOrientation.surfaceRotation(270))   // Surface.ROTATION_90
    }

    // --- YUV_420_888 → NV21 ----------------------------------------------------------------------

    /** Builds a plane with the given strides; padding bytes are 0x7F so that reading them is detected. */
    private fun plane(width: Int, height: Int, rowStride: Int, pixelStride: Int, value: (x: Int, y: Int) -> Int): ByteBuffer {
        // Like real camera buffers, the last row is not padded.
        val size = (height - 1) * rowStride + (width - 1) * pixelStride + 1
        val bytes = ByteArray(size) { 0x7F }
        for (y in 0 until height) for (x in 0 until width) bytes[y * rowStride + x * pixelStride] = value(x, y).toByte()
        return ByteBuffer.wrap(bytes)
    }

    private fun yv(x: Int, y: Int) = (x * 7 + y * 13) and 0xFF
    private fun uv(x: Int, y: Int) = (200 + x + y * 3) and 0xFF
    private fun vv(x: Int, y: Int) = (20 + x * 5 + y) and 0xFF

    private fun expectedNv21(w: Int, h: Int): ByteArray {
        val out = ByteArray(w * h * 3 / 2)
        for (y in 0 until h) for (x in 0 until w) out[y * w + x] = yv(x, y).toByte()
        var o = w * h
        for (y in 0 until h / 2) for (x in 0 until w / 2) { out[o++] = vv(x, y).toByte(); out[o++] = uv(x, y).toByte() }
        return out
    }

    @Test fun packsTightPlanarPlanes() {
        val w = 8; val h = 6
        val nv21 = YuvPacking.nv21(w, h, plane(w, h, w, 1, ::yv), w, 1,
                                   plane(w / 2, h / 2, w / 2, 1, ::uv), w / 2, 1, plane(w / 2, h / 2, w / 2, 1, ::vv), w / 2, 1)
        assertArrayEquals(expectedNv21(w, h), nv21)
    }

    @Test fun packsPaddedRowsAndInterleavedChroma() {
        // The common device layout: row stride > width, chroma pixel stride 2.
        val w = 8; val h = 6
        val nv21 = YuvPacking.nv21(w, h, plane(w, h, 16, 1, ::yv), 16, 1,
                                   plane(w / 2, h / 2, 16, 2, ::uv), 16, 2, plane(w / 2, h / 2, 16, 2, ::vv), 16, 2)
        assertArrayEquals(expectedNv21(w, h), nv21)
    }

    @Test fun packsUnusualStrides() {
        val w = 6; val h = 4
        val nv21 = YuvPacking.nv21(w, h, plane(w, h, 11, 1, ::yv), 11, 1,
                                   plane(w / 2, h / 2, 9, 3, ::uv), 9, 3, plane(w / 2, h / 2, 5, 1, ::vv), 5, 1)
        assertArrayEquals(expectedNv21(w, h), nv21)
    }

    @Test fun packingDoesNotMoveTheCallersBufferPositions() {
        val w = 4; val h = 2
        val y = plane(w, h, 8, 1, ::yv); val u = plane(2, 1, 4, 2, ::uv); val v = plane(2, 1, 4, 2, ::vv)
        y.position(3)
        YuvPacking.nv21(w, h, y, 8, 1, u, 4, 2, v, 4, 2)
        assertEquals(3, y.position()); assertEquals(0, u.position()); assertEquals(0, v.position())
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsABufferThatIsTooSmall() {
        YuvPacking.nv21(8, 6, ByteBuffer.allocate(10), 8, 1, ByteBuffer.allocate(12), 4, 1, ByteBuffer.allocate(12), 4, 1)
    }

    @Test fun lumaCopyDropsRowPadding() {
        val w = 5; val h = 3
        val luma = YuvPacking.luma(plane(w, h, 9, 1, ::yv), w, h, 9, 1)
        assertEquals(w * h, luma.size)
        for (y in 0 until h) for (x in 0 until w) assertEquals(yv(x, y), luma[y * w + x].toInt() and 0xFF)
    }

    @Test fun analysisLumaEqualsCoreDownsampleOfTheTightPlane() {
        val w = 1000; val h = 26; val stride = 1024
        val buf = plane(w, h, stride, 1) { x, y -> (x * 31 + y * 17 + (x * y) % 11) and 0xFF }
        val tight = YuvPacking.luma(buf, w, h, stride, 1)
        val (expected, ew, eh) = FrameAnalysis.downsample(tight, w, h)
        val (actual, aw, ah) = YuvPacking.analysisLuma(buf, w, h, stride, 1)
        assertEquals(ew, aw); assertEquals(eh, ah)
        assertEquals(500, aw)   // step 2
        assertArrayEquals(expected, actual)
    }

    @Test fun analysisLumaKeepsSmallImagesUnchanged() {
        val w = 12; val h = 5
        val buf = plane(w, h, 16, 1, ::yv)
        val (actual, aw, ah) = YuvPacking.analysisLuma(buf, w, h, 16, 1)
        assertEquals(w, aw); assertEquals(h, ah)
        assertArrayEquals(YuvPacking.luma(buf, w, h, 16, 1), actual)
    }

    // --- Camera2 calibration → stored-image intrinsics -------------------------------------------

    private val active = Camera2Geometry.RectI(0, 0, 4000, 3000)

    @Test fun fullSensorOutputOnlyScales() {
        val k = Camera2Geometry.intrinsicsForStoredImage(floatArrayOf(3000f, 3000f, 2010f, 1490f, 0f), active, active, null, 2000, 1500)!!
        assertEquals(1500.0, k.fx, 1e-9); assertEquals(1500.0, k.fy, 1e-9)
        assertEquals(1005.0, k.cx, 1e-9); assertEquals(745.0, k.cy, 1e-9)
    }

    @Test fun sixteenByNineOutputIsACentredCrop() {
        // 4000 × 2250 is cut from the middle of the 4000 × 3000 array: 375 rows removed at the top.
        val k = Camera2Geometry.intrinsicsForStoredImage(floatArrayOf(3000f, 3000f, 2000f, 1500f, 0f), active, active, null, 4000, 2250)!!
        assertEquals(3000.0, k.fx, 1e-9)
        assertEquals(2000.0, k.cx, 1e-9)
        assertEquals(1125.0, k.cy, 1e-9)
    }

    @Test fun cropRegionAndPreCorrectionOffsetAreApplied() {
        val activeOff = Camera2Geometry.RectI(8, 8, 4008, 3008)
        val pre = Camera2Geometry.RectI(0, 0, 4016, 3016)
        // 2× digital zoom: the central 2000 × 1500 of the active array, stored as 4000 × 3000.
        val crop = Camera2Geometry.RectI(1000, 750, 3000, 2250)
        val k = Camera2Geometry.intrinsicsForStoredImage(floatArrayOf(3000f, 3000f, 2008f, 1508f, 0f), pre, activeOff, crop, 4000, 3000)!!
        assertEquals(6000.0, k.fx, 1e-9)
        assertEquals(2000.0, k.cx, 1e-9)   // (2008 − 8 − 1000) × 2
        assertEquals(1500.0, k.cy, 1e-9)
    }

    @Test fun pixelsRotatedByTheCameraRotateTheIntrinsicsToo() {
        // Stored 3000 × 4000 (portrait pixels, EXIF 1) from a 4000 × 3000 sensor read-out rotated 90° cw.
        val k = Camera2Geometry.intrinsicsForStoredImage(floatArrayOf(3000f, 3100f, 2100f, 1400f, 0f), active, active, null,
                                                         3000, 4000, pixelsRotatedQuarterTurnsCw = 1)!!
        val expected = ImageGeometry.rotateIntrinsics(ImageGeometry.Pinhole(3000.0, 3100.0, 2100.0, 1400.0), 4000, 3000, 1)
        assertEquals(expected, k)
        assertEquals(3100.0, k.fx, 1e-9)
        assertEquals(1600.0, k.cx, 1e-9)   // height − cy
        assertEquals(2100.0, k.cy, 1e-9)
    }

    @Test fun missingOrImplausibleCalibrationIsRejected() {
        assertNull(Camera2Geometry.intrinsicsForStoredImage(null, active, active, null, 4000, 3000))
        assertNull(Camera2Geometry.intrinsicsForStoredImage(floatArrayOf(0f, 0f, 0f, 0f, 0f), active, active, null, 4000, 3000))
        // Principal point in the corner: a placeholder, not a calibration.
        assertNull(Camera2Geometry.intrinsicsForStoredImage(floatArrayOf(3000f, 3000f, 0f, 0f, 0f), active, active, null, 4000, 3000))
        // Focal length of 100 px on a 4000 px image would be a 174° field of view.
        assertNull(Camera2Geometry.intrinsicsForStoredImage(floatArrayOf(100f, 100f, 2000f, 1500f, 0f), active, active, null, 4000, 3000))
        assertNull(Camera2Geometry.intrinsicsForStoredImage(floatArrayOf(Float.NaN, 3000f, 2000f, 1500f, 0f), active, active, null, 4000, 3000))
        assertNull(Camera2Geometry.intrinsicsForStoredImage(floatArrayOf(3000f, 3000f, 2000f, 1500f, 0f), active, null, null, 4000, 3000))
        assertNotNull(Camera2Geometry.intrinsicsForStoredImage(floatArrayOf(3000f, 3000f, 2000f, 1500f, 0f), null, active, null, 4000, 3000))
    }

    @Test fun lensDistortionIsReorderedToOpenCv() {
        // Camera2: κ1, κ2, κ3 radial, κ4, κ5 tangential → OpenCV k1, k2, p1, p2, k3.
        assertEquals(listOf(0.5, 0.25, 0.0625, 0.03125, 0.125),
                     Camera2Geometry.opencvDistortion(floatArrayOf(0.5f, 0.25f, 0.125f, 0.0625f, 0.03125f)))
        assertNull(Camera2Geometry.opencvDistortion(null))
        assertNull(Camera2Geometry.opencvDistortion(floatArrayOf(0.1f, 0.2f)))
        assertNull(Camera2Geometry.opencvDistortion(floatArrayOf(0.1f, Float.NaN, 0f, 0f, 0f)))
    }
}
