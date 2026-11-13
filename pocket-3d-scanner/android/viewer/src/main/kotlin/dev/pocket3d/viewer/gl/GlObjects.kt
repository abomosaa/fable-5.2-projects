package dev.pocket3d.viewer.gl

import android.graphics.Bitmap
import android.opengl.GLES30
import android.opengl.GLUtils
import dev.pocket3d.core.mesh.TextureImage
import dev.pocket3d.viewer.scene.LineSet
import dev.pocket3d.viewer.scene.MeshBuffers
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.IdentityHashMap

/** A GL failure with the driver's own log, shown on screen instead of a black viewport. */
class GlException(message: String) : RuntimeException(message)

/** Limits of the GL context, reported once it exists. */
data class GlCaps(val maxTextureSize: Int, val msaaSamples: Int, val renderer: String, val version: String)

/** Compiled and linked program; every compile/link status is checked. */
internal class GlProgram(private val name: String, vertexSource: String, fragmentSource: String) {
    val id: Int

    init {
        val vs = compile(GLES30.GL_VERTEX_SHADER, vertexSource, "vertex")
        val fs = compile(GLES30.GL_FRAGMENT_SHADER, fragmentSource, "fragment")
        val p = GLES30.glCreateProgram()
        if (p == 0) throw GlException("Could not create shader program \"$name\" (GL error ${GLES30.glGetError()}).")
        GLES30.glAttachShader(p, vs)
        GLES30.glAttachShader(p, fs)
        GLES30.glLinkProgram(p)
        val status = IntArray(1)
        GLES30.glGetProgramiv(p, GLES30.GL_LINK_STATUS, status, 0)
        val log = GLES30.glGetProgramInfoLog(p) ?: ""
        GLES30.glDeleteShader(vs)
        GLES30.glDeleteShader(fs)
        if (status[0] != GLES30.GL_TRUE) {
            GLES30.glDeleteProgram(p)
            throw GlException("Shader program \"$name\" failed to link:\n${log.ifBlank { "(no log from the graphics driver)" }}")
        }
        id = p
    }

    private fun compile(type: Int, source: String, kind: String): Int {
        val s = GLES30.glCreateShader(type)
        if (s == 0) throw GlException("Could not create the $kind shader of \"$name\" (GL error ${GLES30.glGetError()}).")
        GLES30.glShaderSource(s, source)
        GLES30.glCompileShader(s)
        val status = IntArray(1)
        GLES30.glGetShaderiv(s, GLES30.GL_COMPILE_STATUS, status, 0)
        if (status[0] != GLES30.GL_TRUE) {
            val log = GLES30.glGetShaderInfoLog(s) ?: ""
            GLES30.glDeleteShader(s)
            throw GlException("The $kind shader of \"$name\" failed to compile:\n${log.ifBlank { "(no log from the graphics driver)" }}")
        }
        return s
    }

    fun uniform(uniformName: String): Int = GLES30.glGetUniformLocation(id, uniformName)
    fun use() = GLES30.glUseProgram(id)
}

/** The mesh program with its uniform locations. Shared by the viewer and the AR renderer. */
internal class MeshProgram {
    private val program = GlProgram("mesh", Shaders.MESH_VS, Shaders.MESH_FS)
    private val uMvp = program.uniform("uMvp")
    private val uNormalMat = program.uniform("uNormalMat")
    private val uTex = program.uniform("uTex")
    private val uMode = program.uniform("uMode")
    private val uHasTex = program.uniform("uHasTex")
    private val uStripe = program.uniform("uStripe")
    private val uBackTint = program.uniform("uBackTint")
    private val uPattern = program.uniform("uPattern")
    private val uColor = program.uniform("uColor")
    private val uExposure = program.uniform("uExposure")
    private val uCropMode = program.uniform("uCropMode")
    private val uCropCenter = program.uniform("uCropCenter")
    private val uCropAxes = program.uniform("uCropAxes")
    private val uCropHalf = program.uniform("uCropHalf")
    private val uPlane = program.uniform("uPlane")
    private val uWeakLimit = program.uniform("uWeakLimit")
    private val uNoneLimit = program.uniform("uNoneLimit")

    /** Start drawing with this program. [mvp] is a column-major 4×4, [normalMat] a column-major 3×3. */
    fun begin(mvp: FloatArray, normalMat: FloatArray, exposure: Float, crop: CropPreview?) {
        program.use()
        GLES30.glUniformMatrix4fv(uMvp, 1, false, mvp, 0)
        GLES30.glUniformMatrix3fv(uNormalMat, 1, false, normalMat, 0)
        GLES30.glUniform1i(uTex, 0)
        GLES30.glUniform1f(uExposure, exposure)
        GLES30.glUniform1f(uWeakLimit, 0.5f)
        GLES30.glUniform1f(uNoneLimit, 0.15f)
        GLES30.glUniform1i(uPattern, 0)
        GLES30.glUniform1i(uBackTint, 1)
        if (crop == null) {
            GLES30.glUniform1i(uCropMode, Shaders.CROP_OFF)
        } else {
            GLES30.glUniform1i(uCropMode, crop.mode)
            GLES30.glUniform3f(uCropCenter, crop.center[0], crop.center[1], crop.center[2])
            GLES30.glUniformMatrix3fv(uCropAxes, 1, false, crop.axes, 0)
            GLES30.glUniform3f(uCropHalf, crop.half[0], crop.half[1], crop.half[2])
            GLES30.glUniform4f(uPlane, crop.plane[0], crop.plane[1], crop.plane[2], crop.plane[3])
        }
    }

    fun material(mode: Int, hasTexture: Boolean, stripe: Boolean, r: Float, g: Float, b: Float, a: Float) {
        GLES30.glUniform1i(uMode, mode)
        GLES30.glUniform1i(uHasTex, if (hasTexture) 1 else 0)
        GLES30.glUniform1i(uStripe, if (stripe) 1 else 0)
        GLES30.glUniform4f(uColor, r, g, b, a)
    }

    fun overlay(pattern: Int, backTint: Boolean) {
        GLES30.glUniform1i(uPattern, pattern)
        GLES30.glUniform1i(uBackTint, if (backTint) 1 else 0)
    }
}

/**
 * Live preview of a crop box or trim plane: the part that would be removed is drawn dithered and
 * desaturated. All values in model coordinates. Immutable.
 */
class CropPreview private constructor(val mode: Int, val center: FloatArray, val axes: FloatArray, val half: FloatArray,
                                      val plane: FloatArray) {
    companion object {
        /** [axes] = the three box axes as columns of a 3×3 matrix (column-major, 9 floats). */
        fun box(center: FloatArray, axes: FloatArray, half: FloatArray) =
            CropPreview(Shaders.CROP_BOX, center, axes, half, FloatArray(4))

        /** Everything with `n · p + d < 0` is shown as removed. */
        fun plane(nx: Float, ny: Float, nz: Float, d: Float) =
            CropPreview(Shaders.CROP_PLANE, FloatArray(3), floatArrayOf(1f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f), FloatArray(3),
                        floatArrayOf(nx, ny, nz, d))
    }
}

/** How the mesh pass is drawn. */
internal class MeshDrawStyle(val mode: Int, val flatR: Float = 0f, val flatG: Float = 0f, val flatB: Float = 0f)

/** GPU copy of a mesh. All methods must run on the GL thread. */
internal class MeshGpu {
    private var vao = 0
    private var vbo = 0
    private var ibo = 0
    private var wireIbo = 0
    private var selIbo = 0
    private var ranges: Array<MeshBuffers.Range> = emptyArray()
    private var rangeTexture = IntArray(0)
    private val textures = IdentityHashMap<TextureImage, Int>()
    var indexCount = 0; private set
    var wireIndexCount = 0; private set
    var selectionIndexCount = 0; private set
    val hasMesh: Boolean get() = vao != 0 && indexCount > 0

    /** The context was lost: forget every handle without deleting (they no longer exist). */
    fun contextLost() {
        vao = 0; vbo = 0; ibo = 0; wireIbo = 0; selIbo = 0
        indexCount = 0; wireIndexCount = 0; selectionIndexCount = 0
        ranges = emptyArray(); rangeTexture = IntArray(0)
        textures.clear()
    }

    fun upload(b: MeshBuffers?) {
        if (b == null) { indexCount = 0; ranges = emptyArray(); rangeTexture = IntArray(0); wireIndexCount = 0; selectionIndexCount = 0; return }
        val ids = IntArray(1)
        if (vao == 0) { GLES30.glGenVertexArrays(1, ids, 0); vao = ids[0] }
        if (vbo == 0) { GLES30.glGenBuffers(1, ids, 0); vbo = ids[0] }
        if (ibo == 0) { GLES30.glGenBuffers(1, ids, 0); ibo = ids[0] }
        GLES30.glBindVertexArray(vao)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, vbo)
        b.vertexData.position(0)
        GLES30.glBufferData(GLES30.GL_ARRAY_BUFFER, b.vertexCount * MeshBuffers.STRIDE_BYTES, b.vertexData, GLES30.GL_STATIC_DRAW)
        val stride = MeshBuffers.STRIDE_BYTES
        GLES30.glEnableVertexAttribArray(0); GLES30.glVertexAttribPointer(0, 3, GLES30.GL_FLOAT, false, stride, 0)
        GLES30.glEnableVertexAttribArray(1); GLES30.glVertexAttribPointer(1, 3, GLES30.GL_FLOAT, false, stride, 12)
        GLES30.glEnableVertexAttribArray(2); GLES30.glVertexAttribPointer(2, 2, GLES30.GL_FLOAT, false, stride, 24)
        GLES30.glEnableVertexAttribArray(3); GLES30.glVertexAttribPointer(3, 1, GLES30.GL_FLOAT, false, stride, 32)
        GLES30.glBindBuffer(GLES30.GL_ELEMENT_ARRAY_BUFFER, ibo)
        b.indexData.position(0)
        GLES30.glBufferData(GLES30.GL_ELEMENT_ARRAY_BUFFER, b.indexCount * 4, b.indexData, GLES30.GL_STATIC_DRAW)
        GLES30.glBindVertexArray(0)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, 0)
        indexCount = b.indexCount
        ranges = b.ranges.toTypedArray()
        rangeTexture = IntArray(ranges.size)
        refreshRangeTextures()
        // edge and selection buffers belong to the previous mesh
        wireIndexCount = 0
        selectionIndexCount = 0
        checkError("mesh upload")
    }

    private fun refreshRangeTextures() {
        for (i in ranges.indices) rangeTexture[i] = ranges[i].material.baseColorTexture?.let { textures[it] } ?: 0
    }

    fun setWire(indices: ByteBuffer?, count: Int) {
        wireIbo = setIndexBuffer(wireIbo, indices, count)
        wireIndexCount = if (indices == null) 0 else count
    }

    fun setSelection(indices: ByteBuffer?, count: Int) {
        selIbo = setIndexBuffer(selIbo, indices, count)
        selectionIndexCount = if (indices == null) 0 else count
    }

    private fun setIndexBuffer(existing: Int, indices: ByteBuffer?, count: Int): Int {
        if (indices == null || count == 0 || vao == 0) return existing
        var id = existing
        if (id == 0) { val ids = IntArray(1); GLES30.glGenBuffers(1, ids, 0); id = ids[0] }
        GLES30.glBindVertexArray(vao)
        GLES30.glBindBuffer(GLES30.GL_ELEMENT_ARRAY_BUFFER, id)
        indices.position(0)
        GLES30.glBufferData(GLES30.GL_ELEMENT_ARRAY_BUFFER, count * 4, indices, GLES30.GL_DYNAMIC_DRAW)
        GLES30.glBindVertexArray(0)
        checkError("index upload")
        return id
    }

    fun hasTexture(image: TextureImage): Boolean = textures.containsKey(image)

    /** Uploads [bitmap] as the texture of [image] with mipmaps and trilinear filtering. Does not recycle the bitmap. */
    fun setTexture(image: TextureImage, bitmap: Bitmap) {
        val ids = IntArray(1)
        val old = textures[image]
        if (old != null) { ids[0] = old; GLES30.glDeleteTextures(1, ids, 0) }
        GLES30.glGenTextures(1, ids, 0)
        val tex = ids[0]
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, tex)
        GLES30.glPixelStorei(GLES30.GL_UNPACK_ALIGNMENT, 1)
        GLUtils.texImage2D(GLES30.GL_TEXTURE_2D, 0, bitmap, 0)
        GLES30.glGenerateMipmap(GLES30.GL_TEXTURE_2D)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR_MIPMAP_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_REPEAT)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_REPEAT)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, 0)
        val err = GLES30.glGetError()
        if (err != GLES30.GL_NO_ERROR) {
            ids[0] = tex; GLES30.glDeleteTextures(1, ids, 0)
            textures.remove(image)
            refreshRangeTextures()
            throw GlException("Texture upload failed (${bitmap.width}×${bitmap.height}, GL error 0x${Integer.toHexString(err)}).")
        }
        textures[image] = tex
        refreshRangeTextures()
    }

    /**
     * Draws every material range. Textured materials whose texture is not uploaded yet are drawn
     * as shaded grey so geometry is visible while textures decode.
     */
    fun drawMaterials(p: MeshProgram, style: MeshDrawStyle) {
        if (!hasMesh) return
        GLES30.glBindVertexArray(vao)
        GLES30.glBindBuffer(GLES30.GL_ELEMENT_ARRAY_BUFFER, ibo)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
        for (i in ranges.indices) {
            val r = ranges[i]
            val m = r.material
            val tex = rangeTexture[i]
            if (style.mode == Shaders.MODE_TEXTURED) {
                val f = m.baseColorFactor
                if (tex != 0) {
                    GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, tex)
                    p.material(Shaders.MODE_TEXTURED, true, m.repaired, f[0], f[1], f[2], 1f)
                } else if (m.baseColorTexture != null) {
                    p.material(Shaders.MODE_SOLID, false, m.repaired, 1f, 1f, 1f, 1f)
                } else {
                    p.material(Shaders.MODE_TEXTURED, false, m.repaired, f[0], f[1], f[2], 1f)
                }
            } else {
                p.material(style.mode, false, m.repaired, style.flatR, style.flatG, style.flatB, 1f)
            }
            GLES30.glDrawElements(GLES30.GL_TRIANGLES, r.count, GLES30.GL_UNSIGNED_INT, r.first * 4)
        }
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, 0)
        GLES30.glBindVertexArray(0)
    }

    /** `GL_LINES` over the de-duplicated edges; the caller has bound a program using attribute 0 only. */
    fun drawWire() {
        if (!hasMesh || wireIndexCount == 0 || wireIbo == 0) return
        GLES30.glBindVertexArray(vao)
        GLES30.glBindBuffer(GLES30.GL_ELEMENT_ARRAY_BUFFER, wireIbo)
        GLES30.glDrawElements(GLES30.GL_LINES, wireIndexCount, GLES30.GL_UNSIGNED_INT, 0)
        GLES30.glBindVertexArray(0)
    }

    fun drawSelection() {
        if (!hasMesh || selectionIndexCount == 0 || selIbo == 0) return
        GLES30.glBindVertexArray(vao)
        GLES30.glBindBuffer(GLES30.GL_ELEMENT_ARRAY_BUFFER, selIbo)
        GLES30.glDrawElements(GLES30.GL_TRIANGLES, selectionIndexCount, GLES30.GL_UNSIGNED_INT, 0)
        GLES30.glBindVertexArray(0)
    }

    fun release() {
        val ids = IntArray(1)
        for (b in intArrayOf(vbo, ibo, wireIbo, selIbo)) if (b != 0) { ids[0] = b; GLES30.glDeleteBuffers(1, ids, 0) }
        if (vao != 0) { ids[0] = vao; GLES30.glDeleteVertexArrays(1, ids, 0) }
        for (t in textures.values) { ids[0] = t; GLES30.glDeleteTextures(1, ids, 0) }
        contextLost()
    }
}

/** A dynamic vertex buffer of plain floats with a fixed attribute layout. GL thread only. */
internal class FloatVbo(private val attributeSizes: IntArray) {
    private var vao = 0
    private var vbo = 0
    private val stride = attributeSizes.sum()
    var vertexCount = 0; private set
    private var scratch: FloatBuffer? = null

    fun contextLost() { vao = 0; vbo = 0; vertexCount = 0 }

    fun set(data: FloatArray?, floatCount: Int = data?.size ?: 0) {
        if (data == null || floatCount == 0) { vertexCount = 0; return }
        val ids = IntArray(1)
        if (vao == 0) { GLES30.glGenVertexArrays(1, ids, 0); vao = ids[0] }
        if (vbo == 0) { GLES30.glGenBuffers(1, ids, 0); vbo = ids[0] }
        var fb = scratch
        if (fb == null || fb.capacity() < floatCount) {
            fb = ByteBuffer.allocateDirect(floatCount * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()
            scratch = fb
        }
        fb!!.clear()
        fb.put(data, 0, floatCount)
        fb.position(0)
        GLES30.glBindVertexArray(vao)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, vbo)
        GLES30.glBufferData(GLES30.GL_ARRAY_BUFFER, floatCount * 4, fb, GLES30.GL_DYNAMIC_DRAW)
        var offset = 0
        for (i in attributeSizes.indices) {
            GLES30.glEnableVertexAttribArray(i)
            GLES30.glVertexAttribPointer(i, attributeSizes[i], GLES30.GL_FLOAT, false, stride * 4, offset * 4)
            offset += attributeSizes[i]
        }
        GLES30.glBindVertexArray(0)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, 0)
        vertexCount = floatCount / stride
    }

    /** Releases the CPU-side staging buffer (after a large one-off upload). */
    fun trim() { scratch = null }

    fun draw(primitive: Int) {
        if (vertexCount == 0 || vao == 0) return
        GLES30.glBindVertexArray(vao)
        GLES30.glDrawArrays(primitive, 0, vertexCount)
        GLES30.glBindVertexArray(0)
    }
}

/** One uploaded [LineSet]. */
internal class WideLinesGpu {
    val vbo = FloatVbo(intArrayOf(3, 3, 2, 4))
    var widthPx = 2f
    var depthTest = true

    fun set(lines: LineSet) {
        vbo.set(lines.toVertexData())
        vbo.trim()
        widthPx = lines.widthPx
        depthTest = lines.depthTest
    }
}

internal fun checkError(where: String) {
    val err = GLES30.glGetError()
    if (err != GLES30.GL_NO_ERROR) {
        // drain further errors so the next check is meaningful
        while (GLES30.glGetError() != GLES30.GL_NO_ERROR) { /* drain */ }
        throw GlException("OpenGL error 0x${Integer.toHexString(err)} during $where." +
            if (err == GLES30.GL_OUT_OF_MEMORY) " The graphics memory is exhausted." else "")
    }
}
