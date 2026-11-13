package dev.pocket3d.core.capture

import dev.pocket3d.core.math.Quat
import dev.pocket3d.core.math.Vec3

/**
 * Image / camera coordinate conventions shared with the companion (see
 * companion/pocket3d_companion/pipeline/geom.py — the two implementations are kept in lock-step
 * by mirrored unit tests).
 *
 *  * Pixel coordinates: origin at the top-left corner of the top-left pixel, +x right, +y down.
 *  * Photos are stored un-rotated with an EXIF orientation tag; reconstruction works on upright
 *    pixels, so intrinsics measured on the stored image must be rotated with [rotateIntrinsics].
 *  * AR poses use the GL camera frame (+X right, +Y up, −Z forward) of the stored image.
 */
object ImageGeometry {
    /** (clockwise quarter turns, mirrored) needed to display a stored image upright. */
    fun exifQuarterTurns(orientation: Int): Pair<Int, Boolean> = when (orientation) {
        1 -> 0 to false
        2 -> 0 to true
        3 -> 2 to false
        4 -> 2 to true
        5 -> 3 to true
        6 -> 1 to false
        7 -> 1 to true
        8 -> 3 to false
        else -> 0 to false
    }

    /** EXIF orientation tag for an un-mirrored image that must be rotated [degreesCw] to be upright. */
    fun exifOrientationForRotation(degreesCw: Int): Int = when (((degreesCw % 360) + 360) % 360) {
        90 -> 6
        180 -> 3
        270 -> 8
        else -> 1
    }

    fun uprightSize(width: Int, height: Int, quarterTurnsCw: Int): Pair<Int, Int> =
        if (quarterTurnsCw % 2 != 0) height to width else width to height

    /** Map a continuous pixel coordinate of the stored image to the upright image. */
    fun rotatePixel(x: Double, y: Double, width: Int, height: Int, quarterTurnsCw: Int): Pair<Double, Double> =
        when (((quarterTurnsCw % 4) + 4) % 4) {
            0 -> x to y
            1 -> (height - y) to x
            2 -> (width - x) to (height - y)
            else -> y to (width - x)
        }

    data class Pinhole(val fx: Double, val fy: Double, val cx: Double, val cy: Double)

    /** Pinhole intrinsics of the upright image given those of the stored image. */
    fun rotateIntrinsics(k: Pinhole, width: Int, height: Int, quarterTurnsCw: Int): Pinhole =
        when (((quarterTurnsCw % 4) + 4) % 4) {
            0 -> k
            1 -> Pinhole(k.fy, k.fx, height - k.cy, k.cx)
            2 -> Pinhole(k.fx, k.fy, width - k.cx, height - k.cy)
            else -> Pinhole(k.fy, k.fx, k.cy, width - k.cx)
        }

    /** Scale intrinsics when the image is resized by [sx], [sy] (new size / old size). */
    fun scaleIntrinsics(k: Pinhole, sx: Double, sy: Double) = Pinhole(k.fx * sx, k.fy * sy, k.cx * sx, k.cy * sy)

    /**
     * Intrinsics of a centred crop/scale: Android reports sensor intrinsics for the active pixel
     * array; a captured image is a crop of that array ([cropLeft], [cropTop], [cropWidth],
     * [cropHeight] in active-array pixels) scaled to [outWidth] x [outHeight].
     */
    fun cropScaleIntrinsics(k: Pinhole, cropLeft: Double, cropTop: Double, cropWidth: Double, cropHeight: Double,
                            outWidth: Int, outHeight: Int): Pinhole {
        val sx = outWidth / cropWidth
        val sy = outHeight / cropHeight
        return Pinhole(k.fx * sx, k.fy * sy, (k.cx - cropLeft) * sx, (k.cy - cropTop) * sy)
    }

    /** Camera viewing direction (unit) in world coordinates for a GL-convention camera pose. */
    fun forward(q: Quat): Vec3 = q.rotate(Vec3(0f, 0f, -1f))
    fun up(q: Quat): Vec3 = q.rotate(Vec3(0f, 1f, 0f))
}
