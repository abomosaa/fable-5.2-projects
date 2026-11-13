package dev.pocket3d.viewer.ui

import android.app.ActivityManager
import android.content.Context
import android.opengl.GLSurfaceView
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.pocket3d.design.InfoBanner
import dev.pocket3d.design.Tone
import dev.pocket3d.viewer.camera.ViewportController
import dev.pocket3d.viewer.gl.GlCaps
import dev.pocket3d.viewer.gl.MsaaConfigChooser
import dev.pocket3d.viewer.gl.SceneBridge
import dev.pocket3d.viewer.gl.SceneRenderer

/** What the tools want to know about touches in the viewport. Coordinates are viewport pixels. */
interface ViewportInput {
    fun onTap(x: Float, y: Float) {}
    fun onDoubleTap(x: Float, y: Float) {}
    /** A finger rested without moving. Return true to turn the rest of the gesture into a tool drag. */
    fun onLongPress(x: Float, y: Float): Boolean = false
    /** A one-finger drag starts at ([x], [y]). Return true if a tool takes it (otherwise it orbits). */
    fun onToolDragStart(x: Float, y: Float): Boolean = false
    fun onToolDrag(x: Float, y: Float) {}
    /** [commit] is false when the drag was interrupted (a second finger came down). */
    fun onToolDragEnd(commit: Boolean) {}
}

internal fun deviceSupportsGles3(context: Context): Boolean {
    val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return true
    return am.deviceConfigurationInfo.reqGlEsVersion >= 0x00030000
}

/**
 * The GL viewport with the standard navigation gestures: one finger orbits (unless a tool takes
 * the drag), two fingers pan and pinch-zoom, double tap is forwarded to [input].
 * [overlay] is drawn above the 3D view in the same coordinate space.
 */
@Composable
fun Viewport3D(
    bridge: SceneBridge,
    controller: ViewportController,
    input: ViewportInput,
    description: String,
    modifier: Modifier = Modifier,
    overlay: @Composable BoxScope.() -> Unit = {},
) {
    val context = LocalContext.current
    if (!remember { deviceSupportsGles3(context) }) {
        Box(modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            InfoBanner("This device cannot show the 3D view",
                       body = "The viewer needs OpenGL ES 3.0, which this device does not provide.", tone = Tone.Bad)
        }
        return
    }
    val currentInput = rememberUpdatedState(input)
    val lifecycle = LocalLifecycleOwner.current.lifecycle

    val holder = remember(bridge) { GlViewHolder(bridge) }
    DisposableEffect(holder, lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> holder.view?.onResume()
                Lifecycle.Event.ON_PAUSE -> holder.view?.onPause()
                else -> {}
            }
        }
        lifecycle.addObserver(observer)
        onDispose {
            lifecycle.removeObserver(observer)
            holder.release()
        }
    }

    Box(
        modifier
            .onSizeChanged { controller.setViewport(it.width, it.height) }
            .semantics { contentDescription = description }
    ) {
        AndroidView(factory = { ctx -> holder.create(ctx) }, modifier = Modifier.fillMaxSize())
        Box(Modifier.fillMaxSize().pointerInput(controller) { viewportGestures(controller) { currentInput.value } })
        overlay()
    }
}

/** Creates the GLSurfaceView and connects it to the [SceneBridge]. */
private class GlViewHolder(private val bridge: SceneBridge) {
    var view: GLSurfaceView? = null
        private set
    private var target: SceneBridge.Target? = null

    fun create(context: Context): GLSurfaceView {
        val v = GLSurfaceView(context)
        lateinit var t: SceneBridge.Target
        val renderer = SceneRenderer(object : SceneRenderer.Host {
            override fun onContextCreated(caps: GlCaps) { v.post { bridge.onContextCreated(t, caps) } }
            override fun onGlError(message: String) { v.post { bridge.onGlError(t, message) } }
        })
        t = object : SceneBridge.Target {
            override val renderer: SceneRenderer = renderer
            override fun queue(block: (SceneRenderer) -> Unit) { v.queueEvent { block(renderer) } }
            override fun requestRender() { v.requestRender() }
        }
        v.setEGLContextClientVersion(3)
        v.setEGLConfigChooser(MsaaConfigChooser { samples -> renderer.msaaSamples = samples })
        v.preserveEGLContextOnPause = true
        v.setRenderer(renderer)
        v.renderMode = GLSurfaceView.RENDERMODE_WHEN_DIRTY
        view = v
        target = t
        bridge.attach(t)
        return v
    }

    fun release() {
        target?.let { bridge.detach(it) }
        view?.onPause()
        target = null
        view = null
    }
}

private suspend fun PointerInputScope.viewportGestures(controller: ViewportController, input: () -> ViewportInput) {
    val slop = viewConfiguration.touchSlop
    val longPressMs = viewConfiguration.longPressTimeoutMillis
    val doubleTapMs = viewConfiguration.doubleTapTimeoutMillis
    var lastTapTime = 0L
    var lastTapPos = Offset.Unspecified
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false)
        controller.cancelAnimation()
        val start = down.position
        val downTime = down.uptimeMillis
        // 0 = undecided, 1 = orbit, 2 = tool drag, 3 = two fingers
        var mode = 0
        var toolActive = false
        var longPressChecked = false
        var lastUptime = downTime
        while (true) {
            val event = if (mode == 0 && !longPressChecked) {
                val remaining = (longPressMs - (lastUptime - downTime)).coerceAtLeast(1)
                withTimeoutOrNull(remaining) { awaitPointerEvent() }
            } else awaitPointerEvent()
            if (event == null) {
                longPressChecked = true
                if (input().onLongPress(start.x, start.y)) { mode = 2; toolActive = true }
                continue
            }
            val pressed = event.changes.filter { it.pressed }
            if (pressed.isEmpty()) {
                event.changes.forEach { lastUptime = it.uptimeMillis }
                break
            }
            lastUptime = pressed[0].uptimeMillis
            if (pressed.size >= 2) {
                if (toolActive) { input().onToolDragEnd(false); toolActive = false }
                mode = 3
                val zoom = event.calculateZoom()
                val pan = event.calculatePan()
                if (zoom != 1f && zoom > 0f) controller.zoomBy(zoom)
                if (pan != Offset.Zero) controller.panBy(pan.x, pan.y)
                event.changes.forEach { it.consume() }
                continue
            }
            val c = pressed[0]
            when (mode) {
                0 -> if ((c.position - start).getDistance() > slop) {
                    if (input().onToolDragStart(start.x, start.y)) {
                        mode = 2; toolActive = true
                        input().onToolDrag(c.position.x, c.position.y)
                    } else mode = 1
                    c.consume()
                }
                1 -> {
                    val d = c.positionChange()
                    if (d != Offset.Zero) controller.orbitBy(d.x, d.y)
                    c.consume()
                }
                2 -> {
                    if (toolActive) input().onToolDrag(c.position.x, c.position.y)
                    c.consume()
                }
                else -> c.consume() // after a two-finger gesture the remaining finger does nothing
            }
        }
        if (toolActive) {
            input().onToolDragEnd(true)
        } else if (mode == 0) {
            val isDouble = lastTapPos != Offset.Unspecified && lastUptime - lastTapTime <= doubleTapMs &&
                (start - lastTapPos).getDistance() <= slop * 4
            if (isDouble) {
                input().onDoubleTap(start.x, start.y)
                lastTapPos = Offset.Unspecified
            } else {
                input().onTap(start.x, start.y)
                lastTapPos = start; lastTapTime = lastUptime
            }
        }
    }
}
