package dev.pocket3d.viewer.ar

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.opengl.GLES11Ext
import android.opengl.GLES30
import android.opengl.GLSurfaceView
import android.opengl.Matrix
import com.google.ar.core.Anchor
import com.google.ar.core.Coordinates2d
import com.google.ar.core.Frame
import com.google.ar.core.LightEstimate
import com.google.ar.core.Plane
import com.google.ar.core.Pose
import com.google.ar.core.Session
import com.google.ar.core.TrackingFailureReason
import com.google.ar.core.TrackingState
import com.google.ar.core.exceptions.CameraNotAvailableException
import com.google.ar.core.exceptions.SessionPausedException
import dev.pocket3d.core.mesh.TextureImage
import dev.pocket3d.viewer.gl.FloatVbo
import dev.pocket3d.viewer.gl.GlException
import dev.pocket3d.viewer.gl.GlProgram
import dev.pocket3d.viewer.gl.MeshDrawStyle
import dev.pocket3d.viewer.gl.MeshGpu
import dev.pocket3d.viewer.gl.MeshProgram
import dev.pocket3d.viewer.gl.Shaders
import dev.pocket3d.viewer.scene.MeshBuffers
import java.util.concurrent.ConcurrentLinkedQueue
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10
import kotlin.math.max

/** Touch input for the GL thread. */
sealed interface ArInput {
    /** Place (or move) the model where the tap hits a detected plane. */
    data class Tap(val x: Float, val y: Float) : ArInput
    /** Finger position while dragging the placed model along the plane. */
    data class DragTo(val x: Float, val y: Float) : ArInput
    data object DragEnd : ArInput
    data object Remove : ArInput
}

/** What the renderer observes, reported to the UI whenever it changes. */
data class ArStatus(
    val cameraTracking: Boolean = false,
    /** Why tracking is not available, in words; null while tracking or still starting. */
    val trackingProblem: String? = null,
    val planeFound: Boolean = false,
    val placed: Boolean = false,
    /** The model is placed but currently not drawn because its anchor is not tracked. */
    val modelHidden: Boolean = false,
    /** A tap or drag did not hit a detected surface. */
    val missedSurface: Boolean = false,
    /** Unrecoverable problem (camera unavailable, GL failure). */
    val error: String? = null,
    val texturesReduced: Boolean = false,
)

/**
 * Placement state that outlives a GL view (rotation): the anchor, the turn about the vertical and
 * the size. [anchor] and [dragPose] are only touched on the GL thread; the rest is written by the
 * UI and read by the GL thread.
 */
class ArPlacement {
    var anchor: Anchor? = null
    var dragPose: Pose? = null
    @Volatile var yawRad: Float = 0f
    /** Metres per model unit, or 0 while no size has been chosen (nothing can be placed). */
    @Volatile var metersPerUnit: Float = 0f
    @Volatile var matchBrightness: Boolean = true
    val input = ConcurrentLinkedQueue<ArInput>()

    /** Call when the session ends (GL thread stopped). */
    fun release() {
        try { anchor?.detach() } catch (e: Exception) { /* session already closed */ }
        anchor = null
        dragPose = null
        input.clear()
    }
}

/**
 * Draws the ARCore camera image, the detected planes and the placed model. Follows the structure
 * of Google's `hello_ar_java` sample: the camera texture is an external OES texture owned here,
 * `Session.update()` runs on the GL thread once per frame, display geometry is pushed on surface
 * changes.
 */
internal class ArRenderer(
    private val session: Session,
    private val placement: ArPlacement,
    private val buffers: MeshBuffers,
    private val displayRotation: () -> Int,
    private val onStatus: (ArStatus) -> Unit,
) : GLSurfaceView.Renderer {
    private var cameraTexture = 0
    private var bgProgram: GlProgram? = null
    private var planeProgram: GlProgram? = null
    private var shadowProgram: GlProgram? = null
    private var meshProgram: MeshProgram? = null
    private var uPlaneMvp = 0; private var uPlaneColor = 0; private var uPlaneCell = 0
    private var uShadowMvp = 0; private var uShadowStrength = 0
    private val mesh = MeshGpu()
    private val bgQuad = FloatVbo(intArrayOf(2, 2))
    private val planeVbo = FloatVbo(intArrayOf(3))
    private val shadowQuad = FloatVbo(intArrayOf(2))
    private val pendingTextures = ArrayList<TextureImage>()
    private var texturesReduced = false

    @Volatile var geometryChanged = true
    private var width = 1
    private var height = 1
    private var failed: String? = null
    private var lastStatus: ArStatus? = null
    private var missedSurface = false

    private val ndcQuad = floatArrayOf(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f)
    private val uvQuad = FloatArray(8)
    private val bgData = FloatArray(16)
    private val view = FloatArray(16)
    private val proj = FloatArray(16)
    private val viewProj = FloatArray(16)
    private val anchorM = FloatArray(16)
    private val localM = FloatArray(16)
    private val modelM = FloatArray(16)
    private val mvp = FloatArray(16)
    private val mv = FloatArray(16)
    private val normalM = FloatArray(9)
    private val planeM = FloatArray(16)
    private val shadowM = FloatArray(16)
    private var planeData = FloatArray(3 * 64)
    private val texturedStyle = MeshDrawStyle(Shaders.MODE_TEXTURED)
    private val contact = floatArrayOf(buffers.bounds.center.x, buffers.bounds.min.y, buffers.bounds.center.z)
    private val footprint = max(buffers.bounds.size.x, buffers.bounds.size.z) * 0.5f

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        failed = null
        mesh.contextLost(); bgQuad.contextLost(); planeVbo.contextLost(); shadowQuad.contextLost()
        try {
            val ids = IntArray(1)
            GLES30.glGenTextures(1, ids, 0)
            cameraTexture = ids[0]
            GLES30.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, cameraTexture)
            GLES30.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
            GLES30.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)
            GLES30.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR)
            GLES30.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
            session.setCameraTextureName(cameraTexture)

            bgProgram = GlProgram("camera background", Shaders.CAMERA_BG_VS, Shaders.CAMERA_BG_FS).also {
                it.use(); GLES30.glUniform1i(it.uniform("uCamera"), 0)
            }
            planeProgram = GlProgram("planes", Shaders.PLANE_VS, Shaders.PLANE_FS).also {
                uPlaneMvp = it.uniform("uMvp"); uPlaneColor = it.uniform("uColor"); uPlaneCell = it.uniform("uCell")
            }
            shadowProgram = GlProgram("contact shadow", Shaders.SHADOW_VS, Shaders.SHADOW_FS).also {
                uShadowMvp = it.uniform("uMvp"); uShadowStrength = it.uniform("uStrength")
            }
            meshProgram = MeshProgram()
            shadowQuad.set(floatArrayOf(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f))
            mesh.upload(buffers)
            pendingTextures.clear()
            for (r in buffers.ranges) r.material.baseColorTexture?.let { img -> if (pendingTextures.none { it === img }) pendingTextures += img }
            geometryChanged = true
        } catch (e: GlException) {
            failed = e.message ?: "The AR renderer could not start."
        }
    }

    override fun onSurfaceChanged(gl: GL10?, w: Int, h: Int) {
        width = max(w, 1); height = max(h, 1)
        GLES30.glViewport(0, 0, width, height)
        geometryChanged = true
    }

    override fun onDrawFrame(gl: GL10?) {
        GLES30.glClearColor(0f, 0f, 0f, 1f)
        GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT or GLES30.GL_DEPTH_BUFFER_BIT)
        val fail = failed
        if (fail != null) { report(ArStatus(error = fail)); return }
        try {
            if (geometryChanged) {
                geometryChanged = false
                session.setDisplayGeometry(displayRotation(), width, height)
            }
            decodeOneTexture()
            val frame = try {
                session.update()
            } catch (e: SessionPausedException) {
                return
            } catch (e: CameraNotAvailableException) {
                report(ArStatus(error = "The camera is not available. Another app may be using it — close it and try again."))
                return
            }
            drawBackground(frame)
            val camera = frame.camera
            val tracking = camera.trackingState == TrackingState.TRACKING
            var planeFound = false
            var hidden = false
            if (tracking) {
                camera.getViewMatrix(view, 0)
                camera.getProjectionMatrix(proj, 0, NEAR, FAR)
                Matrix.multiplyMM(viewProj, 0, proj, 0, view, 0)
                handleInput(frame)
                planeFound = drawPlanes()
                hidden = !drawModel(frame)
            } else {
                // Without tracking the anchor pose is stale: do not draw the model at a guessed place.
                placement.input.clear()
                placement.dragPose = null
                hidden = placement.anchor != null
            }
            val anchor = placement.anchor
            if (anchor != null && anchor.trackingState == TrackingState.STOPPED) {
                // ARCore gave up on this anchor for good; the placement is gone.
                anchor.detach(); placement.anchor = null
            }
            report(ArStatus(
                cameraTracking = tracking,
                trackingProblem = if (tracking) null else describe(camera.trackingFailureReason, camera.trackingState),
                planeFound = planeFound,
                placed = placement.anchor != null || placement.dragPose != null,
                modelHidden = hidden && placement.anchor != null,
                missedSurface = missedSurface,
                texturesReduced = texturesReduced,
            ))
        } catch (e: GlException) {
            failed = e.message
        } catch (e: Throwable) {
            // ARCore reports fatal session problems as unchecked exceptions
            failed = "AR stopped working: ${e.message ?: e.javaClass.simpleName}"
        }
    }

    private fun report(s: ArStatus) {
        if (s != lastStatus) { lastStatus = s; onStatus(s) }
    }

    private fun describe(reason: TrackingFailureReason, state: TrackingState): String = when (reason) {
        TrackingFailureReason.INSUFFICIENT_LIGHT -> "It is too dark to track. Add light."
        TrackingFailureReason.EXCESSIVE_MOTION -> "The phone is moving too fast. Move it slowly."
        TrackingFailureReason.INSUFFICIENT_FEATURES -> "The camera sees too little detail. Point it at a textured surface, not a blank wall or floor."
        TrackingFailureReason.CAMERA_UNAVAILABLE -> "The camera is in use by another app."
        TrackingFailureReason.BAD_STATE -> "Motion tracking is in a bad state. Leave AR and open it again."
        else -> if (state == TrackingState.STOPPED) "Motion tracking has stopped." else "Starting motion tracking — move the phone slowly."
    }

    /** Scan textures are decoded one per frame at AR-friendly resolution so the camera image keeps flowing. */
    private fun decodeOneTexture() {
        if (pendingTextures.isEmpty()) return
        val img = pendingTextures.removeAt(pendingTextures.size - 1)
        try {
            val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(img.bytes, 0, img.bytes.size, o)
            if (o.outWidth <= 0) return
            var sample = 1
            while (max(o.outWidth, o.outHeight) / sample > AR_MAX_TEXTURE) sample *= 2
            if (sample > 1) texturesReduced = true
            val bmp: Bitmap = BitmapFactory.decodeByteArray(img.bytes, 0, img.bytes.size,
                BitmapFactory.Options().apply { inSampleSize = sample }) ?: return
            try { mesh.setTexture(img, bmp) } finally { bmp.recycle() }
        } catch (e: OutOfMemoryError) {
            texturesReduced = true
        } catch (e: GlException) {
            // the model is drawn without this page (shaded grey) rather than not at all
        }
    }

    private fun drawBackground(frame: Frame) {
        if (frame.hasDisplayGeometryChanged() || bgQuad.vertexCount == 0) {
            frame.transformCoordinates2d(Coordinates2d.OPENGL_NORMALIZED_DEVICE_COORDINATES, ndcQuad, Coordinates2d.TEXTURE_NORMALIZED, uvQuad)
            for (i in 0 until 4) {
                bgData[4 * i] = ndcQuad[2 * i]; bgData[4 * i + 1] = ndcQuad[2 * i + 1]
                bgData[4 * i + 2] = uvQuad[2 * i]; bgData[4 * i + 3] = uvQuad[2 * i + 1]
            }
            bgQuad.set(bgData)
        }
        if (frame.timestamp == 0L) return   // no camera image yet
        GLES30.glDisable(GLES30.GL_DEPTH_TEST)
        GLES30.glDepthMask(false)
        GLES30.glDisable(GLES30.GL_BLEND)
        bgProgram!!.use()
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
        GLES30.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, cameraTexture)
        bgQuad.draw(GLES30.GL_TRIANGLE_STRIP)
        GLES30.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, 0)
        GLES30.glDepthMask(true)
        GLES30.glEnable(GLES30.GL_DEPTH_TEST)
    }

    /** First hit on the inside of a detected horizontal, upward-facing plane, or null. */
    private fun hitPlane(frame: Frame, x: Float, y: Float): com.google.ar.core.HitResult? {
        for (hit in frame.hitTest(x, y)) {
            val t = hit.trackable
            if (t is Plane && t.type == Plane.Type.HORIZONTAL_UPWARD_FACING && t.isPoseInPolygon(hit.hitPose) &&
                t.trackingState == TrackingState.TRACKING) return hit
        }
        return null
    }

    private fun handleInput(frame: Frame) {
        while (true) {
            val e = placement.input.poll() ?: break
            when (e) {
                is ArInput.Tap -> {
                    if (placement.metersPerUnit <= 0f) continue
                    val hit = hitPlane(frame, e.x, e.y)
                    missedSurface = hit == null
                    if (hit != null) {
                        placement.anchor?.detach()
                        placement.anchor = hit.createAnchor()
                        placement.dragPose = null
                    }
                }
                is ArInput.DragTo -> {
                    if (placement.anchor == null && placement.dragPose == null) continue
                    val hit = hitPlane(frame, e.x, e.y)
                    missedSurface = hit == null
                    if (hit != null) placement.dragPose = hit.hitPose
                }
                ArInput.DragEnd -> {
                    // re-anchor where the drag ended, so the model is held by ARCore again
                    val p = placement.dragPose
                    if (p != null) {
                        placement.anchor?.detach()
                        placement.anchor = session.createAnchor(p)
                        placement.dragPose = null
                    }
                    missedSurface = false
                }
                ArInput.Remove -> {
                    placement.anchor?.detach()
                    placement.anchor = null
                    placement.dragPose = null
                    missedSurface = false
                }
            }
        }
    }

    private fun drawPlanes(): Boolean {
        var any = false
        var programBound = false
        for (plane in session.getAllTrackables(Plane::class.java)) {
            if (plane.trackingState != TrackingState.TRACKING || plane.subsumedBy != null) continue
            if (plane.type != Plane.Type.HORIZONTAL_UPWARD_FACING) continue
            any = true
            val poly = plane.polygon ?: continue
            val n = poly.limit() / 2
            if (n < 3) continue
            val needed = (n + 2) * 3
            if (planeData.size < needed) planeData = FloatArray(needed * 2)
            // triangle fan around the plane centre; opaque in the middle, fading out at the boundary
            planeData[0] = 0f; planeData[1] = 0f; planeData[2] = 1f
            for (i in 0..n) {
                val k = i % n
                planeData[3 * (i + 1)] = poly.get(2 * k)
                planeData[3 * (i + 1) + 1] = poly.get(2 * k + 1)
                planeData[3 * (i + 1) + 2] = 0.15f
            }
            planeVbo.set(planeData, needed)
            if (!programBound) {
                programBound = true
                GLES30.glEnable(GLES30.GL_BLEND)
                GLES30.glBlendFunc(GLES30.GL_SRC_ALPHA, GLES30.GL_ONE_MINUS_SRC_ALPHA)
                GLES30.glDepthMask(false)
                planeProgram!!.use()
                GLES30.glUniform4f(uPlaneColor, 1f, 1f, 1f, 0.8f)
                GLES30.glUniform1f(uPlaneCell, 0.1f)
            }
            plane.centerPose.toMatrix(planeM, 0)
            Matrix.multiplyMM(mvp, 0, viewProj, 0, planeM, 0)
            GLES30.glUniformMatrix4fv(uPlaneMvp, 1, false, mvp, 0)
            planeVbo.draw(GLES30.GL_TRIANGLE_FAN)
        }
        if (programBound) { GLES30.glDepthMask(true); GLES30.glDisable(GLES30.GL_BLEND) }
        return any
    }

    /** Returns false when a placed model could not be drawn because its anchor is not tracked. */
    private fun drawModel(frame: Frame): Boolean {
        val mpu = placement.metersPerUnit
        val anchor = placement.anchor
        val drag = placement.dragPose
        if (mpu <= 0f || (anchor == null && drag == null)) return true
        if (drag != null) drag.toMatrix(anchorM, 0)
        else {
            if (anchor!!.trackingState != TrackingState.TRACKING) return false
            anchor.pose.toMatrix(anchorM, 0)
        }
        // local = Ry(yaw) · S(metres per unit) · T(−contact point): the lowest point of the edited
        // mesh, centred horizontally, sits on the anchor; model +Y is the plane normal.
        Matrix.setIdentityM(localM, 0)
        Matrix.rotateM(localM, 0, Math.toDegrees(placement.yawRad.toDouble()).toFloat(), 0f, 1f, 0f)
        Matrix.scaleM(localM, 0, mpu, mpu, mpu)
        Matrix.translateM(localM, 0, -contact[0], -contact[1], -contact[2])
        Matrix.multiplyMM(modelM, 0, anchorM, 0, localM, 0)

        // contact shadow
        GLES30.glEnable(GLES30.GL_BLEND)
        GLES30.glBlendFunc(GLES30.GL_SRC_ALPHA, GLES30.GL_ONE_MINUS_SRC_ALPHA)
        GLES30.glDepthMask(false)
        val r = footprint * mpu * 1.25f
        System.arraycopy(anchorM, 0, shadowM, 0, 16)
        Matrix.translateM(shadowM, 0, 0f, 0.002f, 0f)
        Matrix.scaleM(shadowM, 0, r, 1f, r)
        Matrix.multiplyMM(mvp, 0, viewProj, 0, shadowM, 0)
        shadowProgram!!.use()
        GLES30.glUniformMatrix4fv(uShadowMvp, 1, false, mvp, 0)
        GLES30.glUniform1f(uShadowStrength, 0.35f)
        shadowQuad.draw(GLES30.GL_TRIANGLE_STRIP)
        GLES30.glDepthMask(true)
        GLES30.glDisable(GLES30.GL_BLEND)

        Matrix.multiplyMM(mvp, 0, viewProj, 0, modelM, 0)
        Matrix.multiplyMM(mv, 0, view, 0, modelM, 0)
        normalM[0] = mv[0]; normalM[1] = mv[1]; normalM[2] = mv[2]
        normalM[3] = mv[4]; normalM[4] = mv[5]; normalM[5] = mv[6]
        normalM[6] = mv[8]; normalM[7] = mv[9]; normalM[8] = mv[10]
        var exposure = 1f
        if (placement.matchBrightness) {
            val le = frame.lightEstimate
            if (le.state == LightEstimate.State.VALID) exposure = ArPlacementMath.exposure(le.pixelIntensity)
        }
        GLES30.glDisable(GLES30.GL_CULL_FACE)
        meshProgram!!.begin(mvp, normalM, exposure, null)
        mesh.drawMaterials(meshProgram!!, texturedStyle)
        return true
    }

    companion object {
        const val NEAR = 0.05f
        const val FAR = 50f
        /** Texture pages are shown at up to this size in AR to leave memory for the camera pipeline. */
        const val AR_MAX_TEXTURE = 2048
    }
}
