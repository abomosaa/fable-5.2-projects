package dev.pocket3d.viewer.gl

import android.graphics.Bitmap
import android.opengl.GLES30
import android.opengl.GLSurfaceView
import android.opengl.Matrix
import dev.pocket3d.core.mesh.TextureImage
import dev.pocket3d.viewer.camera.CameraSnapshot
import dev.pocket3d.viewer.scene.LineSet
import dev.pocket3d.viewer.scene.MeshBuffers
import java.nio.ByteBuffer
import java.nio.ByteOrder
import javax.microedition.khronos.egl.EGL10
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.egl.EGLDisplay
import javax.microedition.khronos.opengles.GL10

enum class ShadingMode(val label: String) { Textured("Textured"), Solid("Solid"), Wireframe("Wireframe"), Evidence("Evidence") }

enum class BackgroundStyle(val label: String, val top: FloatArray, val bottom: FloatArray) {
    Dark("Dark", floatArrayOf(0.078f, 0.090f, 0.102f), floatArrayOf(0.078f, 0.090f, 0.102f)),
    Mid("Grey", floatArrayOf(0.43f, 0.455f, 0.478f), floatArrayOf(0.43f, 0.455f, 0.478f)),
    Light("Light", floatArrayOf(0.914f, 0.925f, 0.937f), floatArrayOf(0.914f, 0.925f, 0.937f)),
    Gradient("Gradient", floatArrayOf(0.25f, 0.28f, 0.31f), floatArrayOf(0.07f, 0.08f, 0.09f));

    val isLight: Boolean get() = (top[0] + bottom[0]) * 0.5f > 0.6f
}

/** Magnifier drawn into a square of the viewport. Pixel values of the GL surface. */
data class Loupe(
    /** Magnified point (origin top-left). */
    val x: Float, val y: Float,
    /** Side of the screen region that is magnified. */
    val regionPx: Float,
    /** Where the magnified image is drawn (origin top-left) and its side length. */
    val left: Int, val top: Int, val sizePx: Int,
)

/** Everything that selects *how* the scene is drawn. Immutable; replaced as a whole. */
data class RenderSettings(
    val shading: ShadingMode = ShadingMode.Textured,
    val background: BackgroundStyle = BackgroundStyle.Dark,
    val showGrid: Boolean = false,
    val crop: CropPreview? = null,
    val loupe: Loupe? = null,
    val exposure: Float = 1f,
    val pointSizePx: Float = 4f,
)

/**
 * The viewer's renderer. Owns all GL objects; every method except the `@Volatile` setters must be
 * called on the GL thread (use `GLSurfaceView.queueEvent`). Drawing a frame allocates nothing.
 *
 * Scene content is pushed in as immutable data: [setMesh], [setLines], [setPoints], …; how it is
 * drawn is the immutable [settings]; from where is the immutable [camera].
 */
class SceneRenderer(private val host: Host) : GLSurfaceView.Renderer {
    interface Host {
        /** GL thread. A (new) context exists; all previously uploaded content is gone and must be pushed again. */
        fun onContextCreated(caps: GlCaps)
        /** GL thread. Something failed (shader compile, upload, out of memory); [message] is user-presentable. */
        fun onGlError(message: String)
    }

    @Volatile var camera: CameraSnapshot? = null
    @Volatile var settings: RenderSettings = RenderSettings()
    /** Samples of the chosen EGL config (0 = no multisampling), set by [MsaaConfigChooser]. */
    @Volatile var msaaSamples: Int = 0

    private var meshProgram: MeshProgram? = null
    private var lineProgram: GlProgram? = null
    private var wideProgram: GlProgram? = null
    private var pointProgram: GlProgram? = null
    private var bgProgram: GlProgram? = null
    private var uLineMvp = 0; private var uLineColor = 0
    private var uWideMvp = 0; private var uWideViewport = 0; private var uWideWidth = 0; private var uWideBias = 0
    private var uPointMvp = 0; private var uPointSize = 0
    private var uBgTop = 0; private var uBgBottom = 0

    private val mesh = MeshGpu()
    private val grid = FloatVbo(intArrayOf(3))
    private val points = FloatVbo(intArrayOf(3, 3))
    private val bgQuad = FloatVbo(intArrayOf(2))
    private val lineKeys = ArrayList<String>()
    private val lineSets = ArrayList<WideLinesGpu>()

    private var surfaceW = 1
    private var surfaceH = 1
    private var failed = false
    private var maxTextureSize = 2048

    private val pick = FloatArray(16)
    private val loupeVp = FloatArray(16)
    private val solidStyle = MeshDrawStyle(Shaders.MODE_SOLID)
    private val texturedStyle = MeshDrawStyle(Shaders.MODE_TEXTURED)
    private val evidenceStyle = MeshDrawStyle(Shaders.MODE_EVIDENCE)
    private val wireBaseStyle = MeshDrawStyle(Shaders.MODE_FLAT, 0.13f, 0.145f, 0.16f)

    // ---- GLSurfaceView.Renderer ----------------------------------------------------------------

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        failed = false
        mesh.contextLost(); grid.contextLost(); points.contextLost(); bgQuad.contextLost()
        lineKeys.clear(); lineSets.clear()
        try {
            meshProgram = MeshProgram()
            lineProgram = GlProgram("lines", Shaders.LINE_VS, Shaders.COLOR_FS).also {
                uLineMvp = it.uniform("uMvp"); uLineColor = it.uniform("uColor")
            }
            wideProgram = GlProgram("wide lines", Shaders.WIDE_LINE_VS, Shaders.VERTEX_COLOR_FS).also {
                uWideMvp = it.uniform("uMvp"); uWideViewport = it.uniform("uViewport")
                uWideWidth = it.uniform("uWidth"); uWideBias = it.uniform("uDepthBias")
            }
            pointProgram = GlProgram("points", Shaders.POINT_VS, Shaders.POINT_FS).also {
                uPointMvp = it.uniform("uMvp"); uPointSize = it.uniform("uPointSize")
            }
            bgProgram = GlProgram("background", Shaders.BACKGROUND_VS, Shaders.BACKGROUND_FS).also {
                uBgTop = it.uniform("uTop"); uBgBottom = it.uniform("uBottom")
            }
            bgQuad.set(floatArrayOf(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f))
            val v = IntArray(1)
            GLES30.glGetIntegerv(GLES30.GL_MAX_TEXTURE_SIZE, v, 0)
            maxTextureSize = if (v[0] > 0) v[0] else 2048
            checkError("renderer setup")
            host.onContextCreated(GlCaps(maxTextureSize, msaaSamples, GLES30.glGetString(GLES30.GL_RENDERER) ?: "",
                                         GLES30.glGetString(GLES30.GL_VERSION) ?: ""))
        } catch (e: GlException) {
            fail(e.message ?: "The 3D renderer could not start.")
        }
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
        surfaceW = maxOf(width, 1); surfaceH = maxOf(height, 1)
    }

    override fun onDrawFrame(gl: GL10?) {
        val s = settings
        val cam = camera
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
        GLES30.glViewport(0, 0, surfaceW, surfaceH)
        if (failed || cam == null) {
            GLES30.glClearColor(s.background.bottom[0], s.background.bottom[1], s.background.bottom[2], 1f)
            GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT or GLES30.GL_DEPTH_BUFFER_BIT)
            return
        }
        try {
            drawScene(cam.viewProj, cam.normalMatrix, s, surfaceW, surfaceH, overlays = true)
            val l = s.loupe
            if (l != null && l.sizePx > 0) {
                val bottom = surfaceH - l.top - l.sizePx
                GLES30.glEnable(GLES30.GL_SCISSOR_TEST)
                GLES30.glScissor(l.left, bottom, l.sizePx, l.sizePx)
                GLES30.glViewport(l.left, bottom, l.sizePx, l.sizePx)
                val w = maxOf(cam.width, 1).toFloat(); val h = maxOf(cam.height, 1).toFloat()
                val sx = w / maxOf(l.regionPx, 1f); val sy = h / maxOf(l.regionPx, 1f)
                val ndcX = 2f * l.x / w - 1f; val ndcY = 1f - 2f * l.y / h
                Matrix.setIdentityM(pick, 0)
                pick[0] = sx; pick[5] = sy; pick[12] = -ndcX * sx; pick[13] = -ndcY * sy
                Matrix.multiplyMM(loupeVp, 0, pick, 0, cam.viewProj, 0)
                drawScene(loupeVp, cam.normalMatrix, s, l.sizePx, l.sizePx, overlays = true)
                GLES30.glDisable(GLES30.GL_SCISSOR_TEST)
                GLES30.glViewport(0, 0, surfaceW, surfaceH)
            }
        } catch (e: GlException) {
            fail(e.message ?: "Drawing failed.")
        }
    }

    private fun fail(message: String) {
        if (!failed) { failed = true; host.onGlError(message) }
    }

    // ---- content (GL thread) -------------------------------------------------------------------

    private inline fun guarded(block: () -> Unit) {
        if (failed) return
        try { block() } catch (e: GlException) { fail(e.message ?: "A graphics operation failed.") }
        catch (e: OutOfMemoryError) { fail("Not enough memory for the 3D view.") }
    }

    fun setMesh(buffers: MeshBuffers?) = guarded { mesh.upload(buffers) }
    fun setWire(indices: ByteBuffer?, count: Int) = guarded { mesh.setWire(indices, count) }
    fun setSelection(indices: ByteBuffer?, count: Int) = guarded { mesh.setSelection(indices, count) }
    fun hasTexture(image: TextureImage): Boolean = mesh.hasTexture(image)
    fun setTexture(image: TextureImage, bitmap: Bitmap) = guarded { mesh.setTexture(image, bitmap) }

    /** Thin grid lines (xyz pairs for GL_LINES) or null. */
    fun setGrid(lines: FloatArray?) = guarded { grid.set(lines); grid.trim() }

    /** Interleaved xyz + rgb (0..1) per point, or null. */
    fun setPoints(xyzRgb: FloatArray?) = guarded { points.set(xyzRgb); points.trim() }

    /** Adds, replaces or (with null) removes the wide-line set named [key]. */
    fun setLines(key: String, lines: LineSet?) = guarded {
        val i = lineKeys.indexOf(key)
        if (lines == null || lines.segmentCount == 0) {
            if (i >= 0) { lineKeys.removeAt(i); lineSets.removeAt(i).vbo.set(null) }
            return@guarded
        }
        if (i >= 0) lineSets[i].set(lines)
        else { lineKeys += key; lineSets += WideLinesGpu().also { it.set(lines) } }
    }

    // ---- drawing -------------------------------------------------------------------------------

    private fun drawScene(viewProj: FloatArray, normalMat: FloatArray, s: RenderSettings, vw: Int, vh: Int, overlays: Boolean) {
        val bg = s.background
        GLES30.glDisable(GLES30.GL_BLEND)
        GLES30.glDepthMask(true)
        GLES30.glClearColor(bg.bottom[0], bg.bottom[1], bg.bottom[2], 1f)
        GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT or GLES30.GL_DEPTH_BUFFER_BIT)
        GLES30.glDisable(GLES30.GL_CULL_FACE)
        if (bg == BackgroundStyle.Gradient) {
            GLES30.glDisable(GLES30.GL_DEPTH_TEST)
            bgProgram!!.use()
            GLES30.glUniform3f(uBgTop, bg.top[0], bg.top[1], bg.top[2])
            GLES30.glUniform3f(uBgBottom, bg.bottom[0], bg.bottom[1], bg.bottom[2])
            bgQuad.draw(GLES30.GL_TRIANGLE_STRIP)
        }
        GLES30.glEnable(GLES30.GL_DEPTH_TEST)
        GLES30.glDepthFunc(GLES30.GL_LEQUAL)

        // ground grid
        if (overlays && s.showGrid && grid.vertexCount > 0) {
            GLES30.glEnable(GLES30.GL_BLEND)
            GLES30.glBlendFunc(GLES30.GL_SRC_ALPHA, GLES30.GL_ONE_MINUS_SRC_ALPHA)
            lineProgram!!.use()
            GLES30.glUniformMatrix4fv(uLineMvp, 1, false, viewProj, 0)
            if (bg.isLight) GLES30.glUniform4f(uLineColor, 0.2f, 0.22f, 0.25f, 0.45f)
            else GLES30.glUniform4f(uLineColor, 0.85f, 0.9f, 0.95f, 0.28f)
            GLES30.glLineWidth(1f)
            grid.draw(GLES30.GL_LINES)
            GLES30.glDisable(GLES30.GL_BLEND)
        }

        // model
        if (mesh.hasMesh) {
            val mp = meshProgram!!
            mp.begin(viewProj, normalMat, s.exposure, s.crop)
            when (s.shading) {
                ShadingMode.Textured -> mesh.drawMaterials(mp, texturedStyle)
                ShadingMode.Solid -> mesh.drawMaterials(mp, solidStyle)
                ShadingMode.Evidence -> mesh.drawMaterials(mp, evidenceStyle)
                ShadingMode.Wireframe -> {
                    GLES30.glEnable(GLES30.GL_POLYGON_OFFSET_FILL)
                    GLES30.glPolygonOffset(1f, 1f)
                    mesh.drawMaterials(mp, wireBaseStyle)
                    GLES30.glDisable(GLES30.GL_POLYGON_OFFSET_FILL)
                    lineProgram!!.use()
                    GLES30.glUniformMatrix4fv(uLineMvp, 1, false, viewProj, 0)
                    GLES30.glUniform4f(uLineColor, 0.78f, 0.86f, 0.92f, 1f)
                    GLES30.glLineWidth(1f)
                    mesh.drawWire()
                }
            }
            if (overlays && mesh.selectionIndexCount > 0) {
                mp.begin(viewProj, normalMat, 1f, null)
                mp.overlay(1, false)
                mp.material(Shaders.MODE_FLAT, false, false, 1.0f, 0.55f, 0.10f, 0.78f)
                GLES30.glEnable(GLES30.GL_BLEND)
                GLES30.glBlendFunc(GLES30.GL_SRC_ALPHA, GLES30.GL_ONE_MINUS_SRC_ALPHA)
                GLES30.glEnable(GLES30.GL_POLYGON_OFFSET_FILL)
                GLES30.glPolygonOffset(-1f, -1f)
                mesh.drawSelection()
                GLES30.glDisable(GLES30.GL_POLYGON_OFFSET_FILL)
                GLES30.glDisable(GLES30.GL_BLEND)
            }
        }

        // sparse points
        if (points.vertexCount > 0) {
            pointProgram!!.use()
            GLES30.glUniformMatrix4fv(uPointMvp, 1, false, viewProj, 0)
            GLES30.glUniform1f(uPointSize, s.pointSizePx)
            points.draw(GLES30.GL_POINTS)
        }

        // wide lines: hole rims, camera frusta, gizmos
        if (overlays && lineSets.size > 0) {
            GLES30.glEnable(GLES30.GL_BLEND)
            GLES30.glBlendFunc(GLES30.GL_SRC_ALPHA, GLES30.GL_ONE_MINUS_SRC_ALPHA)
            wideProgram!!.use()
            GLES30.glUniformMatrix4fv(uWideMvp, 1, false, viewProj, 0)
            GLES30.glUniform2f(uWideViewport, vw.toFloat(), vh.toFloat())
            for (i in 0 until lineSets.size) {
                val ls = lineSets[i]
                if (ls.depthTest) GLES30.glEnable(GLES30.GL_DEPTH_TEST) else GLES30.glDisable(GLES30.GL_DEPTH_TEST)
                GLES30.glUniform1f(uWideWidth, ls.widthPx)
                GLES30.glUniform1f(uWideBias, if (ls.depthTest) 0.0006f else 0f)
                ls.vbo.draw(GLES30.GL_TRIANGLES)
            }
            GLES30.glEnable(GLES30.GL_DEPTH_TEST)
            GLES30.glDisable(GLES30.GL_BLEND)
        }
    }

    // ---- thumbnail -----------------------------------------------------------------------------

    /**
     * Renders the model off screen (textured, no overlays) into a [sizePx]² framebuffer and
     * returns the pixels as RGBA bytes, bottom row first, or null if that was not possible.
     * GL thread only.
     */
    fun renderOffscreen(snapshot: CameraSnapshot, sizePx: Int, background: BackgroundStyle): ByteBuffer? {
        if (failed || !mesh.hasMesh) return null
        val size = sizePx.coerceAtMost(maxTextureSize)
        val ids = IntArray(1)
        GLES30.glGenFramebuffers(1, ids, 0); val fbo = ids[0]
        GLES30.glGenTextures(1, ids, 0); val color = ids[0]
        GLES30.glGenRenderbuffers(1, ids, 0); val depth = ids[0]
        var result: ByteBuffer? = null
        try {
            GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, color)
            GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_RGBA8, size, size, 0, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, null)
            GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR)
            GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
            GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, 0)
            GLES30.glBindRenderbuffer(GLES30.GL_RENDERBUFFER, depth)
            GLES30.glRenderbufferStorage(GLES30.GL_RENDERBUFFER, GLES30.GL_DEPTH_COMPONENT24, size, size)
            GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, fbo)
            GLES30.glFramebufferTexture2D(GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0, GLES30.GL_TEXTURE_2D, color, 0)
            GLES30.glFramebufferRenderbuffer(GLES30.GL_FRAMEBUFFER, GLES30.GL_DEPTH_ATTACHMENT, GLES30.GL_RENDERBUFFER, depth)
            if (GLES30.glCheckFramebufferStatus(GLES30.GL_FRAMEBUFFER) == GLES30.GL_FRAMEBUFFER_COMPLETE) {
                GLES30.glViewport(0, 0, size, size)
                val s = RenderSettings(shading = ShadingMode.Textured, background = background)
                drawScene(snapshot.viewProj, snapshot.normalMatrix, s, size, size, overlays = false)
                val buf = ByteBuffer.allocateDirect(size * size * 4).order(ByteOrder.nativeOrder())
                GLES30.glPixelStorei(GLES30.GL_PACK_ALIGNMENT, 1)
                GLES30.glReadPixels(0, 0, size, size, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, buf)
                if (GLES30.glGetError() == GLES30.GL_NO_ERROR) result = buf
            }
        } catch (e: GlException) {
            result = null
        } catch (e: OutOfMemoryError) {
            result = null
        } finally {
            GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
            ids[0] = fbo; GLES30.glDeleteFramebuffers(1, ids, 0)
            ids[0] = color; GLES30.glDeleteTextures(1, ids, 0)
            ids[0] = depth; GLES30.glDeleteRenderbuffers(1, ids, 0)
            GLES30.glViewport(0, 0, surfaceW, surfaceH)
            while (GLES30.glGetError() != GLES30.GL_NO_ERROR) { /* drain */ }
        }
        return result
    }
}

/**
 * Picks an RGB888 OpenGL ES 3 config with a depth buffer, preferring 4× multisampling and
 * falling back to no multisampling when the device does not offer it.
 */
class MsaaConfigChooser(private val onChosen: (samples: Int) -> Unit) : GLSurfaceView.EGLConfigChooser {
    override fun chooseConfig(egl: EGL10, display: EGLDisplay): EGLConfig {
        for ((samples, depth) in listOf(4 to 24, 4 to 16, 0 to 24, 0 to 16)) {
            val c = choose(egl, display, samples, depth)
            if (c != null) { onChosen(samples); return c }
        }
        throw IllegalArgumentException("This device offers no OpenGL ES 3.0 display configuration.")
    }

    private fun choose(egl: EGL10, display: EGLDisplay, samples: Int, depth: Int): EGLConfig? {
        val attribs = intArrayOf(
            EGL10.EGL_RED_SIZE, 8, EGL10.EGL_GREEN_SIZE, 8, EGL10.EGL_BLUE_SIZE, 8,
            EGL10.EGL_DEPTH_SIZE, depth,
            EGL10.EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT,
            EGL10.EGL_SAMPLE_BUFFERS, if (samples > 0) 1 else 0,
            EGL10.EGL_SAMPLES, samples,
            EGL10.EGL_NONE,
        )
        val count = IntArray(1)
        if (!egl.eglChooseConfig(display, attribs, null, 0, count) || count[0] <= 0) return null
        val configs = arrayOfNulls<EGLConfig>(count[0])
        if (!egl.eglChooseConfig(display, attribs, configs, configs.size, count)) return null
        val value = IntArray(1)
        // prefer the config whose sample count matches exactly
        for (c in configs) {
            if (c == null) continue
            egl.eglGetConfigAttrib(display, c, EGL10.EGL_SAMPLES, value)
            if (value[0] == samples) return c
        }
        return if (samples == 0) configs.firstOrNull { it != null } else null
    }

    private companion object { const val EGL_OPENGL_ES3_BIT = 0x40 }
}
