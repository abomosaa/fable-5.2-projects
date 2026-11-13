package dev.pocket3d.capture.logic

import dev.pocket3d.core.capture.ImageGeometry

/**
 * Physical device orientation → stored-image orientation. The capture UI may be portrait-locked,
 * so the EXIF orientation of a photo must come from how the phone is actually held
 * (`OrientationEventListener`), never from the display rotation.
 *
 * "Device rotation" here is the `OrientationEventListener` convention snapped to quarter turns:
 * 0 = natural (portrait on phones), 90 = device turned clockwise so its left edge is on top,
 * 180 = upside down, 270 = right edge on top (the usual landscape grip).
 */
object DeviceOrientation {
    /**
     * Snaps a raw `OrientationEventListener` angle to 0/90/180/270. A reading of −1 (phone lying
     * flat, orientation unknown) keeps [previous]; [hysteresisDeg] stops flicker near 45°.
     */
    fun snap(orientationDeg: Int, previous: Int, hysteresisDeg: Int = 10): Int {
        if (orientationDeg < 0) return previous
        val o = ((orientationDeg % 360) + 360) % 360
        val diff = Math.abs(o - previous).let { if (it > 180) 360 - it else it }
        if (diff <= 45 + hysteresisDeg) return previous
        return ((o + 45) / 90 * 90) % 360
    }

    /**
     * Clockwise rotation (0/90/180/270) that makes the sensor image upright, per the Camera2
     * contract for `JPEG_ORIENTATION`: back cameras add the device rotation to the sensor
     * orientation, front cameras subtract it.
     */
    fun imageRotationCw(sensorOrientation: Int, deviceRotationCw: Int, frontFacing: Boolean = false): Int {
        val device = if (frontFacing) -deviceRotationCw else deviceRotationCw
        return (((sensorOrientation + device) % 360) + 360) % 360
    }

    /** EXIF orientation tag to store with an un-rotated sensor image. */
    fun exifOrientation(sensorOrientation: Int, deviceRotationCw: Int, frontFacing: Boolean = false): Int =
        ImageGeometry.exifOrientationForRotation(imageRotationCw(sensorOrientation, deviceRotationCw, frontFacing))

    /**
     * `Surface.ROTATION_*` constant (0..3) to hand to CameraX as target rotation for a device
     * rotation: the display rotation is the inverse of the device rotation.
     */
    fun surfaceRotation(deviceRotationCw: Int): Int = when (((deviceRotationCw % 360) + 360) % 360) {
        90 -> 3    // Surface.ROTATION_270
        180 -> 2   // Surface.ROTATION_180
        270 -> 1   // Surface.ROTATION_90
        else -> 0  // Surface.ROTATION_0
    }
}
