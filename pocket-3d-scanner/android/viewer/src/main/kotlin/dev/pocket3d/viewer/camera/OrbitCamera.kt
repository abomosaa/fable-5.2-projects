package dev.pocket3d.viewer.camera

import dev.pocket3d.core.math.Mat4
import dev.pocket3d.core.math.Quat
import dev.pocket3d.core.math.Ray
import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.mesh.Aabb
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan
import kotlin.math.atan2
import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.tan

enum class StandardView { Front, Back, Left, Right, Top, Bottom, ThreeQuarter }

/** A world point projected to the viewport: pixel coordinates (origin top-left) and view depth (> 0). */
data class ScreenPoint(val x: Float, val y: Float, val depth: Float)

/**
 * Orbit ("turntable") camera, pure math and immutable so that every gesture produces a new value
 * that can be handed to the GL thread as is.
 *
 * Conventions (same as the model: right-handed, +Y up; camera axes GL-style, looking along −Z):
 *  - the camera looks at [pivot] from [distance] away;
 *  - camera-to-world rotation = Ry([yaw]) · Rx(−[pitch]) · Rz([roll]); with all angles zero the
 *    eye sits on the +Z side of the pivot ("front" view);
 *  - [pitch] is the elevation of the eye above the horizontal plane through the pivot;
 *  - [roll] is zero during normal orbiting and only used to reproduce the exact pose of a source
 *    photo ("look from this camera").
 *
 * [sceneCenter] / [sceneRadius] describe everything that must stay inside the depth range; they
 * only influence the near/far planes and the zoom limits.
 */
data class OrbitCamera(
    val pivot: Vec3 = Vec3.ZERO,
    val yaw: Float = 0f,
    val pitch: Float = 0f,
    val roll: Float = 0f,
    val distance: Float = 3f,
    val fovY: Float = DEFAULT_FOV_Y,
    val sceneCenter: Vec3 = Vec3.ZERO,
    val sceneRadius: Float = 1f,
) {
    /** Camera-to-world rotation. */
    val rotation: Quat
        get() = (Quat.axisAngle(Vec3.Y, yaw) * Quat.axisAngle(Vec3.X, -pitch) * Quat.axisAngle(Vec3.Z, roll)).normalized()

    val eye: Vec3 get() = pivot + rotation.rotate(Vec3.Z) * distance
    val forward: Vec3 get() = -rotation.rotate(Vec3.Z)
    val right: Vec3 get() = rotation.rotate(Vec3.X)
    val up: Vec3 get() = rotation.rotate(Vec3.Y)

    /** World → camera. */
    fun viewMatrix(): FloatArray = Mat4.mul(Mat4.rotation(rotation.conjugate()), Mat4.translation(-eye))

    /** Near and far plane distances that enclose the scene sphere from the current eye point. */
    fun clipPlanes(): Pair<Float, Float> {
        val r = max(sceneRadius, 1e-6f)
        val dc = eye.distanceTo(sceneCenter)
        val near = max(r * 0.004f, (dc - r) * 0.5f)
        val far = max(dc + r * 1.5f, near * 4f)
        return near to far
    }

    fun projectionMatrix(aspect: Float): FloatArray {
        val (near, far) = clipPlanes()
        return Mat4.perspective(fovY, max(aspect, 1e-4f), near, far)
    }

    fun fovX(aspect: Float): Float = 2f * atan(tan(fovY / 2f) * aspect)

    /** World size of one pixel at view depth [depth] for a viewport [viewportHeight] pixels high. */
    fun worldPerPixel(depth: Float, viewportHeight: Int): Float =
        2f * depth * tan(fovY / 2f) / max(viewportHeight, 1)

    /**
     * One-finger drag: rotate around the pivot. Dragging the full viewport height turns by 180°.
     * The pitch is kept just short of the poles so "up" never flips; any roll left over from
     * "look from this camera" is eased out.
     */
    fun orbit(dxPx: Float, dyPx: Float, viewportHeight: Int): OrbitCamera {
        val k = PI.toFloat() / max(viewportHeight, 1)
        return copy(
            yaw = wrapAngle(yaw - dxPx * k),
            pitch = (pitch + dyPx * k).coerceIn(-MAX_PITCH, MAX_PITCH),
            roll = if (abs(roll) < 1e-3f) 0f else roll * 0.8f,
        )
    }

    /** Two-finger drag: move the pivot in the view plane so the scene follows the fingers. */
    fun pan(dxPx: Float, dyPx: Float, viewportHeight: Int): OrbitCamera {
        val s = worldPerPixel(distance, viewportHeight)
        return copy(pivot = pivot - right * (dxPx * s) + up * (dyPx * s))
    }

    /** Pinch: [factor] > 1 moves closer. The distance stays within sane limits of the scene size. */
    fun zoom(factor: Float): OrbitCamera {
        if (!(factor > 0f) || factor.isNaN() || factor.isInfinite()) return this
        val r = max(sceneRadius, 1e-6f)
        return copy(distance = (distance / factor).coerceIn(r * MIN_DISTANCE_FACTOR, r * MAX_DISTANCE_FACTOR))
    }

    /** Look at the same pivot with the same distance from one of the standard directions. */
    fun standardView(view: StandardView): OrbitCamera = when (view) {
        StandardView.Front -> copy(yaw = 0f, pitch = 0f, roll = 0f)
        StandardView.Back -> copy(yaw = PI.toFloat(), pitch = 0f, roll = 0f)
        StandardView.Right -> copy(yaw = (PI / 2).toFloat(), pitch = 0f, roll = 0f)
        StandardView.Left -> copy(yaw = (-PI / 2).toFloat(), pitch = 0f, roll = 0f)
        StandardView.Top -> copy(yaw = 0f, pitch = MAX_PITCH, roll = 0f)
        StandardView.Bottom -> copy(yaw = 0f, pitch = -MAX_PITCH, roll = 0f)
        StandardView.ThreeQuarter -> copy(yaw = Math.toRadians(35.0).toFloat(), pitch = Math.toRadians(24.0).toFloat(), roll = 0f)
    }

    /**
     * Frame [bounds] completely: the pivot moves to the centre of the box and the distance is
     * chosen so that the bounding sphere fits both the vertical and the horizontal field of view.
     * The viewing direction is kept.
     */
    fun fit(bounds: Aabb, aspect: Float, margin: Float = 1.06f): OrbitCamera {
        val r = max(bounds.diagonal / 2f, 1e-6f)
        val half = min(fovY, fovX(max(aspect, 1e-4f))) / 2f
        return copy(pivot = bounds.center, distance = r / sin(half) * margin, roll = 0f)
    }

    /** Update the scene sphere used for clip planes / zoom limits. */
    fun withScene(center: Vec3, radius: Float): OrbitCamera =
        copy(sceneCenter = center, sceneRadius = max(radius, 1e-6f))

    /** Ray through pixel ([xPx], [yPx]) (origin top-left) of a [width] × [height] viewport. */
    fun ray(xPx: Float, yPx: Float, width: Int, height: Int): Ray {
        val w = max(width, 1); val h = max(height, 1)
        val ndcX = 2f * xPx / w - 1f
        val ndcY = 1f - 2f * yPx / h
        val t = tan(fovY / 2f)
        val dirCam = Vec3(ndcX * t * w / h, ndcY * t, -1f).normalized()
        return Ray(eye, rotation.rotate(dirCam).normalized())
    }

    /** Projects a world point to pixels; null when the point is behind the camera. */
    fun project(p: Vec3, width: Int, height: Int): ScreenPoint? {
        val w = max(width, 1); val h = max(height, 1)
        val pc = rotation.conjugate().rotate(p - eye)
        val depth = -pc.z
        if (!(depth > 1e-6f)) return null
        val t = tan(fovY / 2f)
        val ndcX = pc.x / depth / (t * w / h)
        val ndcY = pc.y / depth / t
        return ScreenPoint((ndcX + 1f) * 0.5f * w, (1f - ndcY) * 0.5f * h, depth)
    }

    /**
     * The view of a source photo: eye at [position], orientation [q] (camera axes GL-style, as in
     * cameras.json). The resulting [viewMatrix] equals the inverse of that pose. The pivot is put
     * [focusDistance] in front of the camera so that orbiting afterwards turns around what the
     * photo looked at.
     *
     * Field of view: when the viewport has the photo's aspect ratio the vertical field of view is
     * the photo's; otherwise it is widened just enough that the whole photo frame is visible
     * (see [photoFrameFraction] for where the frame then lies).
     */
    fun lookFrom(position: Vec3, q: Quat, cameraFovY: Float, imageAspect: Float, viewAspect: Float,
                 focusDistance: Float): OrbitCamera {
        val qn = q.normalized()
        val back = qn.rotate(Vec3.Z)
        val pitch = atan2(back.y, hypot(back.x, back.z))
        val yaw = if (abs(back.x) < 1e-7f && abs(back.z) < 1e-7f) 0f else atan2(back.x, back.z)
        val q0 = Quat.axisAngle(Vec3.Y, yaw) * Quat.axisAngle(Vec3.X, -pitch)
        val qr = (q0.conjugate() * qn).normalized()
        val roll = wrapAngle(2f * atan2(qr.z, qr.w))
        val d = max(focusDistance, 1e-5f)
        return copy(pivot = position - back * d, yaw = yaw, pitch = pitch, roll = roll, distance = d,
                    fovY = fovForPhoto(cameraFovY, imageAspect, viewAspect))
    }

    companion object {
        val DEFAULT_FOV_Y: Float = Math.toRadians(40.0).toFloat()
        val MAX_PITCH: Float = Math.toRadians(89.5).toFloat()
        const val MIN_DISTANCE_FACTOR = 0.02f
        const val MAX_DISTANCE_FACTOR = 12f

        /** Maps any angle to (−π, π]. */
        fun wrapAngle(a: Float): Float {
            val twoPi = (2 * PI).toFloat()
            var x = a % twoPi
            if (x > PI) x -= twoPi
            if (x <= -PI) x += twoPi
            return x
        }

        /** Vertical field of view that shows the complete photo frame in a viewport of [viewAspect]. */
        fun fovForPhoto(cameraFovY: Float, imageAspect: Float, viewAspect: Float): Float {
            val tanV = tan(cameraFovY.coerceIn(0.02f, 3.0f) / 2f)
            val tanH = tanV * max(imageAspect, 1e-4f)
            return 2f * atan(max(tanV, tanH / max(viewAspect, 1e-4f)))
        }

        /**
         * Size of the photo frame relative to the viewport (width fraction, height fraction) after
         * [lookFrom]; one of the two is 1.
         */
        fun photoFrameFraction(cameraFovY: Float, imageAspect: Float, viewAspect: Float): Pair<Float, Float> {
            val viewFov = fovForPhoto(cameraFovY, imageAspect, viewAspect)
            val hFrac = tan(cameraFovY.coerceIn(0.02f, 3.0f) / 2f) / tan(viewFov / 2f)
            val wFrac = hFrac * imageAspect / max(viewAspect, 1e-4f)
            return min(wFrac, 1f) to min(hFrac, 1f)
        }

        /** Smooth interpolation for view animations (shortest way round for the angles, log distance). */
        fun lerp(a: OrbitCamera, b: OrbitCamera, t: Float): OrbitCamera {
            if (t <= 0f) return a
            if (t >= 1f) return b
            fun ang(x: Float, y: Float) = x + wrapAngle(y - x) * t
            return OrbitCamera(
                pivot = a.pivot.lerp(b.pivot, t),
                yaw = wrapAngle(ang(a.yaw, b.yaw)),
                pitch = a.pitch + (b.pitch - a.pitch) * t,
                roll = wrapAngle(ang(a.roll, b.roll)),
                distance = exp(ln(max(a.distance, 1e-9f)) * (1 - t) + ln(max(b.distance, 1e-9f)) * t),
                fovY = a.fovY + (b.fovY - a.fovY) * t,
                sceneCenter = b.sceneCenter,
                sceneRadius = b.sceneRadius,
            )
        }
    }
}

/**
 * Everything the GL thread needs to draw one frame from a camera, precomputed on the thread that
 * owns the camera so that drawing allocates nothing. Immutable.
 */
class CameraSnapshot(val camera: OrbitCamera, val width: Int, val height: Int) {
    val view: FloatArray = camera.viewMatrix()
    val proj: FloatArray = camera.projectionMatrix(width.toFloat() / max(height, 1))
    val viewProj: FloatArray = Mat4.mul(proj, view)
    val eye: Vec3 = camera.eye

    /** Upper-left 3×3 of [view] (column-major): rotates model normals into view space. */
    val normalMatrix: FloatArray = floatArrayOf(view[0], view[1], view[2], view[4], view[5], view[6], view[8], view[9], view[10])

    /**
     * Projection for a magnifier: the square region of [regionPx] pixels around ([xPx], [yPx])
     * fills the whole (square) target viewport. Returned as `pick · proj · view`.
     */
    fun magnifiedViewProj(xPx: Float, yPx: Float, regionPx: Float): FloatArray {
        val w = max(width, 1).toFloat(); val h = max(height, 1).toFloat()
        val ndcX = 2f * xPx / w - 1f
        val ndcY = 1f - 2f * yPx / h
        val sx = w / max(regionPx, 1f)
        val sy = h / max(regionPx, 1f)
        val pick = Mat4.identity()
        pick[0] = sx; pick[5] = sy
        pick[12] = -ndcX * sx; pick[13] = -ndcY * sy
        return Mat4.mul(pick, viewProj)
    }
}
