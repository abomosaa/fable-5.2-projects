package dev.pocket3d.capture.logic

import dev.pocket3d.core.capture.ImageGeometry
import kotlin.math.tan

/**
 * Converts Camera2 lens calibration (`LENS_INTRINSIC_CALIBRATION`, `LENS_DISTORTION`) into the
 * capture-metadata conventions: pinhole intrinsics in pixels of the STORED image, OpenCV
 * 5-parameter distortion.
 */
object Camera2Geometry {
    data class RectI(val left: Int, val top: Int, val right: Int, val bottom: Int) {
        val width: Int get() = right - left
        val height: Int get() = bottom - top
    }

    /**
     * @param calibration `[f_x, f_y, c_x, c_y, s]` in pixels of the pre-correction active array,
     *   origin at its top-left corner
     * @param preCorrection `SENSOR_INFO_PRE_CORRECTION_ACTIVE_ARRAY_SIZE` (pixel-array coordinates), if known
     * @param active `SENSOR_INFO_ACTIVE_ARRAY_SIZE` (pixel-array coordinates)
     * @param cropRegion `SCALER_CROP_REGION` of the capture, relative to the active array's
     *   top-left; null = the full active array (no digital zoom)
     * @param storedWidth stored pixel size of the photo, before applying its EXIF orientation
     * @param pixelsRotatedQuarterTurnsCw quarter turns the camera already applied to the pixels
     *   (0 when the rotation is only expressed as an EXIF tag, which is the normal case)
     * @return null when the reported calibration is missing or implausible (many devices report
     *   zeros or placeholders); the focal length then comes from EXIF and the reconstruction.
     */
    fun intrinsicsForStoredImage(
        calibration: FloatArray?, preCorrection: RectI?, active: RectI?, cropRegion: RectI?,
        storedWidth: Int, storedHeight: Int, pixelsRotatedQuarterTurnsCw: Int = 0,
    ): ImageGeometry.Pinhole? {
        if (calibration == null || calibration.size < 4 || active == null) return null
        if (storedWidth <= 0 || storedHeight <= 0 || active.width <= 0 || active.height <= 0) return null
        val fx = calibration[0].toDouble(); val fy = calibration[1].toDouble()
        var cx = calibration[2].toDouble(); var cy = calibration[3].toDouble()
        if (!(fx.isFinite() && fy.isFinite() && cx.isFinite() && cy.isFinite()) || fx <= 0.0 || fy <= 0.0) return null
        // Pre-correction origin → active-array origin (both rectangles live in pixel-array coordinates).
        if (preCorrection != null) { cx += preCorrection.left - active.left; cy += preCorrection.top - active.top }

        val turns = ((pixelsRotatedQuarterTurnsCw % 4) + 4) % 4
        // Size of the image in sensor orientation (before any pixel rotation by the camera).
        val outW = if (turns % 2 == 1) storedHeight else storedWidth
        val outH = if (turns % 2 == 1) storedWidth else storedHeight

        // Camera2 crops the crop region centrally to the aspect ratio of the output stream.
        val crop = cropRegion ?: RectI(0, 0, active.width, active.height)
        if (crop.width <= 0 || crop.height <= 0) return null
        var left = crop.left.toDouble(); var top = crop.top.toDouble()
        var w = crop.width.toDouble(); var h = crop.height.toDouble()
        val outAspect = outW.toDouble() / outH
        if (outAspect > w / h) {
            val nh = w / outAspect
            top += (h - nh) / 2; h = nh
        } else {
            val nw = h * outAspect
            left += (w - nw) / 2; w = nw
        }
        var k = ImageGeometry.cropScaleIntrinsics(ImageGeometry.Pinhole(fx, fy, cx, cy), left, top, w, h, outW, outH)
        if (!plausible(k, outW, outH)) return null
        if (turns != 0) k = ImageGeometry.rotateIntrinsics(k, outW, outH, turns)
        return k
    }

    /** Principal point near the centre, field of view between 20° and 140°, roughly square pixels. */
    fun plausible(k: ImageGeometry.Pinhole, width: Int, height: Int): Boolean {
        if (k.cx < 0.3 * width || k.cx > 0.7 * width || k.cy < 0.3 * height || k.cy > 0.7 * height) return false
        val longSide = maxOf(width, height).toDouble()
        val f = if (width >= height) k.fx else k.fy
        val minF = longSide / (2 * tan(Math.toRadians(70.0)))
        val maxF = longSide / (2 * tan(Math.toRadians(10.0)))
        if (f < minF || f > maxF) return false
        val ratio = k.fx / k.fy
        return ratio in 0.9..1.1
    }

    /**
     * Camera2 `LENS_DISTORTION` is `[κ1, κ2, κ3, κ4, κ5]` with κ1..κ3 radial and κ4, κ5 tangential
     * in the same functional form as OpenCV (x_d = x(1 + κ1 r² + κ2 r⁴ + κ3 r⁶) + κ4·2xy + κ5(r² + 2x²)),
     * so OpenCV's `[k1, k2, p1, p2, k3]` is `[κ1, κ2, κ4, κ5, κ3]`.
     */
    fun opencvDistortion(lensDistortion: FloatArray?): List<Double>? {
        if (lensDistortion == null || lensDistortion.size < 5) return null
        if (lensDistortion.any { !it.isFinite() }) return null
        val d = lensDistortion
        return listOf(d[0].toDouble(), d[1].toDouble(), d[3].toDouble(), d[4].toDouble(), d[2].toDouble())
    }
}
