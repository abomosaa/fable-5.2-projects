package dev.pocket3d.viewer.camera

import dev.pocket3d.core.math.Ray
import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.mesh.Aabb
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.android.awaitFrame
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlin.math.max

data class ViewportSize(val width: Int, val height: Int) {
    val aspect: Float get() = width.toFloat() / max(height, 1)
}

/**
 * Owns the camera on the main thread. Gestures and animations change it here; every change is
 * published as a [CameraSnapshot] through [onCamera] (which hands it to the GL thread and asks
 * for one frame — the viewer only renders when something changed).
 */
class ViewportController(private val scope: CoroutineScope, private val onCamera: (CameraSnapshot) -> Unit) {
    private val _camera = MutableStateFlow(OrbitCamera())
    val camera: StateFlow<OrbitCamera> = _camera
    private val _size = MutableStateFlow(ViewportSize(1, 1))
    val size: StateFlow<ViewportSize> = _size
    private var animation: Job? = null
    private var sceneBounds: Aabb? = null

    val width: Int get() = _size.value.width
    val height: Int get() = _size.value.height

    fun snapshot(): CameraSnapshot = CameraSnapshot(_camera.value, width, height)

    private fun publish(c: OrbitCamera) {
        _camera.value = c
        onCamera(CameraSnapshot(c, width, height))
    }

    fun setViewport(w: Int, h: Int) {
        if (w <= 0 || h <= 0) return
        val first = _size.value.width <= 1
        _size.value = ViewportSize(w, h)
        val b = sceneBounds
        // the very first layout: frame the model for the real aspect ratio
        if (first && b != null && animation?.isActive != true) publish(_camera.value.fit(b, _size.value.aspect))
        else publish(_camera.value)
    }

    /** Set the camera immediately (cancels a running animation). */
    fun set(c: OrbitCamera) {
        animation?.cancel()
        publish(c)
    }

    fun orbitBy(dx: Float, dy: Float) = set(_camera.value.orbit(dx, dy, height))
    fun panBy(dx: Float, dy: Float) = set(_camera.value.pan(dx, dy, height))
    fun zoomBy(factor: Float) = set(_camera.value.zoom(factor))

    fun ray(x: Float, y: Float): Ray = _camera.value.ray(x, y, width, height)
    fun project(p: Vec3): ScreenPoint? = _camera.value.project(p, width, height)

    /**
     * New scene extent (after loading or an edit). The camera keeps its view; the pivot is pulled
     * back to the model if an edit removed what it was on. With [reset] the model is framed anew.
     */
    fun setScene(bounds: Aabb, extraRadius: Float = 0f, reset: Boolean = false, pivotFix: ((Vec3) -> Vec3)? = null) {
        sceneBounds = bounds
        val r = max(bounds.diagonal * 0.5f, 1e-6f)
        val sceneR = max(r * 2.6f, extraRadius)
        var c = _camera.value.withScene(bounds.center, sceneR)
        if (reset) {
            c = c.standardView(StandardView.ThreeQuarter).fit(bounds, _size.value.aspect)
        } else {
            var p = pivotFix?.invoke(c.pivot) ?: c.pivot
            if (p.distanceTo(bounds.center) > r * 1.5f) p = bounds.center
            c = c.copy(pivot = p).zoom(1f)
        }
        set(c)
    }

    fun fit(bounds: Aabb? = sceneBounds, animate: Boolean = true) {
        val b = bounds ?: return
        val target = _camera.value.fit(b, _size.value.aspect)
        if (animate) animateTo(target) else set(target)
    }

    fun standardView(view: StandardView) {
        val b = sceneBounds
        var target = _camera.value.standardView(view)
        if (b != null) target = target.fit(b, _size.value.aspect)
        animateTo(target)
    }

    /** Move the orbit pivot to [point] without changing what is on screen more than necessary. */
    fun setPivot(point: Vec3) {
        val c = _camera.value
        // keep the eye where it is in depth: same viewing direction, distance to the new pivot
        val depth = (point - c.eye).dot(c.forward)
        animateTo(c.copy(pivot = point, distance = max(depth, c.sceneRadius * OrbitCamera.MIN_DISTANCE_FACTOR)), 220)
    }

    fun animateTo(target: OrbitCamera, durationMs: Long = 380, onEnd: (() -> Unit)? = null) {
        animation?.cancel()
        val start = _camera.value
        animation = scope.launch {
            val t0 = awaitFrame()
            while (true) {
                val now = awaitFrame()
                val t = ((now - t0) / 1_000_000f / durationMs).coerceIn(0f, 1f)
                // smoothstep ease
                val e = t * t * (3f - 2f * t)
                publish(OrbitCamera.lerp(start, target, e))
                if (t >= 1f) break
            }
            publish(target)
            onEnd?.invoke()
        }
    }

    fun cancelAnimation() { animation?.cancel() }
}
