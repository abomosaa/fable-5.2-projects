package dev.pocket3d.viewer.gl

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import dev.pocket3d.core.mesh.TextureImage
import dev.pocket3d.viewer.camera.CameraSnapshot
import dev.pocket3d.viewer.scene.LineSet
import dev.pocket3d.viewer.scene.MeshBuffers
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.nio.ByteBuffer
import java.util.IdentityHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max

/** How one texture page is shown compared to how it is stored. */
data class TexturePageReport(
    val name: String,
    val originalWidth: Int, val originalHeight: Int,
    val shownWidth: Int, val shownHeight: Int,
    val encodedBytes: Int,
    val mimeType: String,
    /** Non-null when the page could not be decoded at all. */
    val error: String? = null,
) {
    val reduced: Boolean get() = error == null && (shownWidth < originalWidth || shownHeight < originalHeight)
}

data class TextureReport(val pages: List<TexturePageReport>, val loading: Boolean) {
    val anyReduced: Boolean get() = pages.any { it.reduced }
    val anyFailed: Boolean get() = pages.any { it.error != null }
}

/** Decides how much each texture page is downsampled for display. Pure. */
object TexturePolicy {
    /**
     * Power-of-two sample sizes (1 = full resolution) per page such that no page side exceeds
     * [maxSide] and the total number of decoded pixels stays within [pixelBudget]; when the budget
     * is exceeded the currently largest page is halved first.
     */
    fun sampleSizes(sizes: List<Pair<Int, Int>>, maxSide: Int, pixelBudget: Long): IntArray {
        val s = IntArray(sizes.size) { 1 }
        val limit = max(maxSide, 1)
        for (i in sizes.indices) while (max(sizes[i].first, sizes[i].second) / s[i] > limit) s[i] *= 2
        fun pixels(i: Int): Long = (sizes[i].first / s[i]).toLong() * (sizes[i].second / s[i])
        while (true) {
            var total = 0L
            var largest = -1
            for (i in sizes.indices) {
                total += pixels(i)
                if (largest < 0 || pixels(i) > pixels(largest)) largest = i
            }
            if (total <= pixelBudget || largest < 0 || pixels(largest) <= 256L * 256L) break
            s[largest] *= 2
        }
        return s
    }
}

/**
 * Main-thread facade of one 3D scene. It remembers the wanted content, so everything can be
 * pushed again whenever a view attaches or a new GL context appears (rotation, context loss),
 * and forwards changes to the GL thread as immutable data.
 */
class SceneBridge(
    private val scope: CoroutineScope,
    /** Largest texture side to decode regardless of what the GPU allows. */
    private val maxTextureSide: Int = 4096,
    /** Total decoded texture pixels allowed. */
    private val texturePixelBudget: Long = 50_000_000L,
) {
    /** The attached view. */
    interface Target {
        fun queue(block: (SceneRenderer) -> Unit)
        fun requestRender()
        val renderer: SceneRenderer
    }

    private var target: Target? = null
    private var generation = 0

    private var mesh: MeshBuffers? = null
    private var wire: ByteBuffer? = null
    private var wireCount = 0
    private var selection: ByteBuffer? = null
    private var selectionCount = 0
    private var grid: FloatArray? = null
    private var points: FloatArray? = null
    private val lines = LinkedHashMap<String, LineSet>()
    private var camera: CameraSnapshot? = null
    var settings: RenderSettings = RenderSettings()
        private set

    /** Capabilities of the current GL context; null until one exists. */
    val caps = MutableStateFlow<GlCaps?>(null)
    /** A renderer failure to show instead of the 3D view. */
    val error = MutableStateFlow<String?>(null)
    val textureReport = MutableStateFlow<TextureReport?>(null)

    private val uploaded = IdentityHashMap<TextureImage, TexturePageReport>()
    private var textureJob: Job? = null

    val isAttached: Boolean get() = target != null

    fun attach(t: Target) {
        target = t
        // content is pushed when the context reports itself (onContextCreated)
        t.renderer.settings = settings
        t.renderer.camera = camera
    }

    fun detach(t: Target) {
        if (target !== t) return
        target = null
        caps.value = null
        textureJob?.cancel()
        uploaded.clear()
    }

    /** Called on the main thread when the attached view's GL context has been (re)created. */
    fun onContextCreated(t: Target, c: GlCaps) {
        if (target !== t) return
        generation++
        uploaded.clear()
        textureJob?.cancel()
        error.value = null
        caps.value = c
        val m = mesh; val w = wire; val wc = wireCount; val s = selection; val sc = selectionCount
        val g = grid; val p = points; val ls = lines.toMap()
        t.queue { r ->
            r.setMesh(m)
            if (w != null) r.setWire(w, wc)
            if (s != null) r.setSelection(s, sc)
            r.setGrid(g)
            r.setPoints(p)
            for ((k, v) in ls) r.setLines(k, v)
        }
        t.renderer.settings = settings
        t.renderer.camera = camera
        t.requestRender()
        ensureTextures()
    }

    fun onGlError(t: Target, message: String) {
        if (target === t) error.value = message
    }

    fun setCamera(snapshot: CameraSnapshot) {
        camera = snapshot
        target?.let { it.renderer.camera = snapshot; it.requestRender() }
    }

    fun updateSettings(transform: (RenderSettings) -> RenderSettings) {
        val next = transform(settings)
        if (next == settings) return
        settings = next
        target?.let { it.renderer.settings = next; it.requestRender() }
    }

    fun requestRender() { target?.requestRender() }

    /** Replaces the mesh. Wireframe edges and the selection of the previous mesh are dropped. */
    fun setMesh(buffers: MeshBuffers?) {
        mesh = buffers
        wire = null; wireCount = 0
        selection = null; selectionCount = 0
        target?.let { t -> t.queue { r -> r.setMesh(buffers) }; t.requestRender() }
        ensureTextures()
    }

    fun setWire(indices: ByteBuffer?, count: Int) {
        wire = indices; wireCount = count
        target?.let { t -> t.queue { r -> r.setWire(indices, count) }; t.requestRender() }
    }

    fun setSelection(indices: ByteBuffer?, count: Int) {
        selection = indices; selectionCount = count
        target?.let { t -> t.queue { r -> r.setSelection(indices, count) }; t.requestRender() }
    }

    fun setGrid(linesXyz: FloatArray?) {
        grid = linesXyz
        target?.let { t -> t.queue { r -> r.setGrid(linesXyz) }; t.requestRender() }
    }

    fun setPoints(xyzRgb: FloatArray?) {
        points = xyzRgb
        target?.let { t -> t.queue { r -> r.setPoints(xyzRgb) }; t.requestRender() }
    }

    fun setLines(key: String, set: LineSet?) {
        if (set == null || set.segmentCount == 0) { if (lines.remove(key) == null) return } else lines[key] = set
        val v = lines[key]
        target?.let { t -> t.queue { r -> r.setLines(key, v) }; t.requestRender() }
    }

    /** Suspends until the textures of the current mesh are on the GPU (or failed). */
    suspend fun awaitTextures() { textureJob?.join() }

    /**
     * Off-screen render of the current mesh from [snapshot]; RGBA bytes (bottom row first) or
     * null when no view is attached, the GL thread does not answer or rendering failed.
     */
    suspend fun renderOffscreen(snapshot: CameraSnapshot, sizePx: Int, background: BackgroundStyle): ByteBuffer? {
        val t = target ?: return null
        if (caps.value == null) return null
        val done = CompletableDeferred<ByteBuffer?>()
        t.queue { r -> done.complete(try { r.renderOffscreen(snapshot, sizePx, background) } catch (e: Throwable) { null }) }
        return withTimeoutOrNull(8000) { done.await() }
    }

    private fun ensureTextures() {
        val t = target ?: return
        val c = caps.value ?: return
        val m = mesh
        val images = ArrayList<TextureImage>()
        if (m != null) for (r in m.ranges) {
            val img = r.material.baseColorTexture ?: continue
            if (images.none { it === img }) images += img
        }
        val missing = images.filter { !uploaded.containsKey(it) }
        if (missing.isEmpty()) {
            if (textureJob?.isActive != true) publishReport(images, loading = false)
            return
        }
        val gen = generation
        val previous = textureJob
        textureJob = scope.launch {
            previous?.cancel()
            previous?.join()
            publishReport(images, loading = true)
            val maxSide = minOf(c.maxTextureSize, maxTextureSide)
            val bounds = withContext(Dispatchers.Default) { missing.map { decodeBounds(it) } }
            // budget what is already on the GPU, too
            val already = uploaded.values.sumOf { it.shownWidth.toLong() * it.shownHeight }
            val samples = TexturePolicy.sampleSizes(bounds.map { (it?.first ?: 1) to (it?.second ?: 1) }, maxSide,
                                                    max(texturePixelBudget - already, 1024L * 1024L))
            for ((i, img) in missing.withIndex()) {
                val b = bounds[i]
                if (b == null) {
                    uploaded[img] = TexturePageReport(img.name, 0, 0, 0, 0, img.bytes.size, img.mimeType,
                                                      error = "This texture image could not be decoded (${img.mimeType}).")
                    continue
                }
                val bmp = withContext(Dispatchers.Default) { decode(img, samples[i], maxSide) }
                if (bmp == null) {
                    uploaded[img] = TexturePageReport(img.name, b.first, b.second, 0, 0, img.bytes.size, img.mimeType,
                                                      error = "Not enough memory to show this texture.")
                    continue
                }
                val claimed = AtomicBoolean(false)
                val done = CompletableDeferred<Boolean>()
                val w = bmp.width; val h = bmp.height
                try {
                    t.queue { r ->
                        if (claimed.compareAndSet(false, true)) {
                            try { r.setTexture(img, bmp); done.complete(r.hasTexture(img)) }
                            catch (e: Throwable) { done.complete(false) }
                            finally { bmp.recycle() }
                        }
                    }
                    val ok = done.await()
                    if (generation == gen) {
                        uploaded[img] = if (ok) TexturePageReport(img.name, b.first, b.second, w, h, img.bytes.size, img.mimeType)
                        else TexturePageReport(img.name, b.first, b.second, 0, 0, img.bytes.size, img.mimeType,
                                               error = "The graphics driver rejected this texture.")
                        publishReport(images, loading = true)
                        t.requestRender()
                    }
                } finally {
                    // cancelled while the upload was still queued (view went away): free the bitmap ourselves
                    if (claimed.compareAndSet(false, true)) bmp.recycle()
                }
            }
            if (generation == gen) publishReport(images, loading = false)
        }
    }

    private fun publishReport(images: List<TextureImage>, loading: Boolean) {
        textureReport.value = TextureReport(images.mapNotNull { uploaded[it] }, loading)
    }

    private fun decodeBounds(img: TextureImage): Pair<Int, Int>? {
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(img.bytes, 0, img.bytes.size, o)
        return if (o.outWidth > 0 && o.outHeight > 0) o.outWidth to o.outHeight else null
    }

    private fun decode(img: TextureImage, sampleSize: Int, maxSide: Int): Bitmap? {
        var sample = max(sampleSize, 1)
        repeat(4) {
            try {
                val o = BitmapFactory.Options().apply { inSampleSize = sample; inPreferredConfig = Bitmap.Config.ARGB_8888 }
                var bmp = BitmapFactory.decodeByteArray(img.bytes, 0, img.bytes.size, o) ?: return null
                if (max(bmp.width, bmp.height) > maxSide) {
                    val k = maxSide.toFloat() / max(bmp.width, bmp.height)
                    val scaled = Bitmap.createScaledBitmap(bmp, max(1, (bmp.width * k).toInt()), max(1, (bmp.height * k).toInt()), true)
                    if (scaled !== bmp) bmp.recycle()
                    bmp = scaled
                }
                return bmp
            } catch (e: OutOfMemoryError) {
                sample *= 2
            }
        }
        return null
    }
}
