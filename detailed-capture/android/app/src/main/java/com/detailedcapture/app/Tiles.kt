package com.detailedcapture.app

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapRegionDecoder
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.os.Build
import android.util.LruCache
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.systemGestureExclusion
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.unit.IntSize
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.ceil
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/** A pyramid of image tiles. Level [maxLevel] is full resolution; every lower level halves the size. */
interface TileSource {
    val id: String
    val width: Int
    val height: Int
    val tileSize: Int
    val maxLevel: Int
    val minLevel: Int
    fun levelWidth(l: Int): Int = max(1, ((width.toLong() + (1L shl (maxLevel - l)) - 1) shr (maxLevel - l)).toInt())
    fun levelHeight(l: Int): Int = max(1, ((height.toLong() + (1L shl (maxLevel - l)) - 1) shr (maxLevel - l)).toInt())
    fun decode(level: Int, col: Int, row: Int): Bitmap?
    fun close() {}
}

private fun log2ceil(v: Int): Int {
    var l = 0
    while ((1L shl l) < v) l++
    return l
}

/** Deep-Zoom tiles written by the core (results/<run>/tiles/<level>/<col>_<row>.png). */
class DziTileSource(private val root: File, override val width: Int, override val height: Int, override val tileSize: Int = 512, private val ext: String = "png") : TileSource {
    override val id = root.absolutePath
    override val maxLevel = log2ceil(max(width, height))
    override val minLevel = max(0, maxLevel - log2ceil(ceil(max(width, height) / tileSize.toDouble()).toInt()))
    override fun decode(level: Int, col: Int, row: Int): Bitmap? {
        val f = File(root, "$level/${col}_$row.$ext")
        if (!f.exists()) return null
        val o = BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.HARDWARE }
        return BitmapFactory.decodeFile(f.absolutePath, o)
    }
}

/**
 * Reads tiles straight from an original photo file with [BitmapRegionDecoder]: the pixels shown are the actual
 * source pixels (down-sampled only by powers of two for lower levels). EXIF orientation is applied here.
 */
class RegionTileSource(private val file: File, private val orientation: Int) : TileSource {
    override val id = file.absolutePath + "#" + file.lastModified()
    private val decoder: BitmapRegionDecoder? = runCatching {
        if (Build.VERSION.SDK_INT >= 31) BitmapRegionDecoder.newInstance(file.absolutePath)
        else @Suppress("DEPRECATION") BitmapRegionDecoder.newInstance(file.absolutePath, false)
    }.getOrNull()
    private val sw = decoder?.width ?: 1
    private val sh = decoder?.height ?: 1
    private val swap = orientation in 5..8
    override val width = if (swap) sh else sw
    override val height = if (swap) sw else sh
    override val tileSize = 512
    override val maxLevel = log2ceil(max(width, height))
    override val minLevel = max(0, maxLevel - log2ceil(ceil(max(width, height) / tileSize.toDouble()).toInt()))
    val valid: Boolean get() = decoder != null

    override fun decode(level: Int, col: Int, row: Int): Bitmap? {
        val d = decoder ?: return null
        val sample = 1 shl (maxLevel - level)
        val x0 = col * tileSize * sample
        val y0 = row * tileSize * sample
        val x1 = min(width, x0 + tileSize * sample)
        val y1 = min(height, y0 + tileSize * sample)
        if (x1 <= x0 || y1 <= y0) return null
        // oriented rect -> stored rect
        val r = when (orientation) {
            3, 4 -> Rect(sw - x1, sh - y1, sw - x0, sh - y0)
            6, 7 -> Rect(y0, sh - x1, y1, sh - x0)
            8, 5 -> Rect(sw - y1, x0, sw - y0, x1)
            else -> Rect(x0, y0, x1, y1)
        }
        val o = BitmapFactory.Options().apply { inSampleSize = sample; inPreferredConfig = Bitmap.Config.ARGB_8888 }
        val raw = synchronized(d) { d.decodeRegion(r, o) } ?: return null
        val deg = when (orientation) { 3, 4 -> 180f; 6, 7 -> 90f; 8, 5 -> 270f; else -> 0f }
        if (deg == 0f && orientation != 2) return raw
        val m = Matrix()
        if (orientation == 2) m.postScale(-1f, 1f)
        m.postRotate(deg)
        val out = Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, m, false)
        if (out !== raw) raw.recycle()
        return out
    }

    override fun close() {
        runCatching { decoder?.recycle() }
    }
}

object TileCache {
    private val maxBytes = (Runtime.getRuntime().maxMemory() / 4).coerceIn(48L * 1024 * 1024, 256L * 1024 * 1024).toInt()
    private val cache = object : LruCache<String, Bitmap>(maxBytes) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.allocationByteCount
    }
    private val pending = ConcurrentHashMap.newKeySet<String>()
    private val missing = ConcurrentHashMap.newKeySet<String>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO.limitedParallelism(3))
    val generation = mutableIntStateOf(0)

    fun key(s: TileSource, l: Int, c: Int, r: Int) = "${s.id}|$l|$c|$r"
    fun peek(s: TileSource, l: Int, c: Int, r: Int): Bitmap? = cache.get(key(s, l, c, r))

    fun request(s: TileSource, l: Int, c: Int, r: Int, stillWanted: () -> Boolean) {
        val k = key(s, l, c, r)
        if (missing.contains(k) || !pending.add(k)) return
        scope.launch {
            try {
                if (stillWanted()) {
                    val b = runCatching { s.decode(l, c, r) }.getOrNull()
                    if (b != null) {
                        cache.put(k, b)
                        generation.intValue++
                    } else missing.add(k)
                }
            } finally {
                pending.remove(k)
            }
        }
    }

    fun forget(prefix: String) {
        val snap = cache.snapshot()
        for (k in snap.keys) if (k.startsWith(prefix)) cache.remove(k)
        missing.removeIf { it.startsWith(prefix) }
    }
}

/** Pan / zoom state of a viewer over a content rectangle (content units are arbitrary, usually pixels). */
@Stable
class ViewportState(contentW: Float, contentH: Float) {
    var contentW by mutableFloatStateOf(contentW)
    var contentH by mutableFloatStateOf(contentH)
    var scale by mutableFloatStateOf(0f)        // screen px per content unit
    var offset by mutableStateOf(Offset.Zero)   // screen position of content origin
    var viewSize by mutableStateOf(IntSize.Zero)
    var maxScale = 12f

    val fitScale: Float get() = if (viewSize.width == 0) 1f else min(viewSize.width / contentW, viewSize.height / contentH)

    fun fit(fraction: Float = 0.96f) {
        if (viewSize.width == 0) return
        scale = fitScale * fraction
        offset = Offset((viewSize.width - contentW * scale) / 2f, (viewSize.height - contentH * scale) / 2f)
    }

    fun toScreen(p: Offset) = Offset(offset.x + p.x * scale, offset.y + p.y * scale)
    fun toContent(p: Offset) = Offset((p.x - offset.x) / scale, (p.y - offset.y) / scale)

    fun transform(centroid: Offset, pan: Offset, zoom: Float) {
        val ns = (scale * zoom).coerceIn(fitScale * 0.5f, max(maxScale, fitScale * 2f))
        val f = ns / scale
        offset = Offset(centroid.x - (centroid.x - offset.x) * f + pan.x, centroid.y - (centroid.y - offset.y) * f + pan.y)
        scale = ns
        clamp()
    }

    fun centerOn(content: Offset, newScale: Float? = null) {
        if (newScale != null) scale = newScale.coerceIn(fitScale * 0.5f, max(maxScale, fitScale * 2f))
        offset = Offset(viewSize.width / 2f - content.x * scale, viewSize.height / 2f - content.y * scale)
        clamp()
    }

    private fun clamp() {
        val w = contentW * scale
        val h = contentH * scale
        val mx = viewSize.width * 0.5f
        val my = viewSize.height * 0.5f
        offset = Offset(offset.x.coerceIn(mx - w, viewSize.width - mx), offset.y.coerceIn(my - h, viewSize.height - my))
    }
}

/** One image layer: tiles of [source] placed into content space by [matrix] (source px -> content units). */
class TileLayer(val source: TileSource, val matrix: Matrix = Matrix(), val clipFraction: (() -> Float)? = null, val colorFilter: android.graphics.ColorFilter? = null)

interface DragHandler {
    /** return true to capture this drag (content coordinates) */
    fun onDown(content: Offset, screenSlop: Float): Boolean
    fun onMove(content: Offset)
    fun onUp()
}

private val tilePaint = Paint(Paint.FILTER_BITMAP_FLAG)

private fun DrawScope.drawLayer(layer: TileLayer, vp: ViewportState) {
    val src = layer.source
    val total = Matrix(layer.matrix)
    total.postScale(vp.scale, vp.scale)
    total.postTranslate(vp.offset.x, vp.offset.y)
    val inv = Matrix()
    if (!total.invert(inv)) return
    var clipRight = size.width
    layer.clipFraction?.let { clipRight = size.width * it() }
    // visible region in source pixels
    val corners = floatArrayOf(0f, 0f, clipRight, 0f, clipRight, size.height, 0f, size.height)
    inv.mapPoints(corners)
    val vx0 = max(0f, minOf(corners[0], corners[2], corners[4], corners[6]))
    val vy0 = max(0f, minOf(corners[1], corners[3], corners[5], corners[7]))
    val vx1 = min(src.width.toFloat(), maxOf(corners[0], corners[2], corners[4], corners[6]))
    val vy1 = min(src.height.toFloat(), maxOf(corners[1], corners[3], corners[5], corners[7]))
    if (vx1 <= vx0 || vy1 <= vy0) return
    // screen px per source px (geometric mean of the local scale at the view centre)
    val v = FloatArray(9).also { total.getValues(it) }
    val eff = sqrt(kotlin.math.abs(v[0] * v[4] - v[1] * v[3])).coerceAtLeast(1e-6f)
    val want = (src.maxLevel + ceil(ln(eff.toDouble()) / ln(2.0)).toInt()).coerceIn(src.minLevel, src.maxLevel)
    tilePaint.isFilterBitmap = eff < 3f   // beyond 300 % show honest pixels instead of smoothing them
    tilePaint.colorFilter = layer.colorFilter
    drawIntoCanvas { c ->
        val nc = c.nativeCanvas
        nc.save()
        if (layer.clipFraction != null) nc.clipRect(0f, 0f, clipRight, size.height)
        nc.concat(total)
        val dst = RectF()
        fun drawLevel(l: Int, request: Boolean): Boolean {
            val f = (1 shl (src.maxLevel - l)).toFloat()
            val ts = src.tileSize * f
            val c0 = (vx0 / ts).toInt()
            val r0 = (vy0 / ts).toInt()
            val c1 = min(((src.levelWidth(l) - 1) / src.tileSize), (vx1 / ts).toInt())
            val r1 = min(((src.levelHeight(l) - 1) / src.tileSize), (vy1 / ts).toInt())
            var all = true
            val eps = 0.35f / eff
            for (r in r0..r1) for (cc in c0..c1) {
                val b = TileCache.peek(src, l, cc, r)
                if (b != null) {
                    val x = cc * ts
                    val y = r * ts
                    val w = min(ts, src.width - x)
                    val h = min(ts, src.height - y)
                    dst.set(x, y, x + w + eps, y + h + eps)
                    nc.drawBitmap(b, null, dst, tilePaint)
                } else {
                    all = false
                    if (request) TileCache.request(src, l, cc, r) { true }
                }
            }
            return all
        }
        drawLevel(src.minLevel, true)
        // if the wanted level is incomplete, show whatever coarser detail is already cached underneath
        if (want > src.minLevel) {
            for (l in max(src.minLevel + 1, want - 3) until want) drawLevel(l, false)
            drawLevel(want, true)
        }
        nc.restore()
    }
}

@Composable
fun TileViewer(
    state: ViewportState,
    layers: List<TileLayer>,
    modifier: Modifier = Modifier,
    onTap: ((Offset) -> Unit)? = null,
    onLongPress: ((Offset) -> Unit)? = null,
    dragHandler: DragHandler? = null,
    overlay: (DrawScope.(ViewportState) -> Unit)? = null,
) {
    val gen by TileCache.generation
    val slop = LocalViewConfiguration.current.touchSlop
    val tap by rememberUpdatedState(onTap)
    val longPress by rememberUpdatedState(onLongPress)
    val handler by rememberUpdatedState(dragHandler)
    var lastTap by remember { mutableStateOf(0L to Offset.Zero) }
    Canvas(
        modifier
            .fillMaxSize()
            .clipToBounds()
            .then(if (dragHandler != null) Modifier.systemGestureExclusion() else Modifier)  // handles near the screen edge must not trigger "back"
            .onSizeChanged {
                val first = state.viewSize.width == 0 || state.scale == 0f
                state.viewSize = it
                if (first) state.fit()
            }
            .pointerInput(state) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    val captured = handler?.onDown(state.toContent(down.position), slop * 2.2f / state.scale) ?: false
                    var moved = false
                    var travel = Offset.Zero
                    var maxPointers = 1
                    val t0 = down.uptimeMillis
                    var tUp = t0
                    var upPos = down.position
                    while (true) {
                        val ev = awaitPointerEvent()
                        val pressed = ev.changes.filter { it.pressed }
                        if (pressed.isEmpty()) {
                            ev.changes.firstOrNull()?.let { tUp = it.uptimeMillis; upPos = it.position }
                            break
                        }
                        maxPointers = max(maxPointers, pressed.size)
                        if (captured && pressed.size == 1) {
                            handler?.onMove(state.toContent(pressed[0].position))
                            pressed[0].consume()
                            moved = true
                        } else {
                            val zoom = ev.calculateZoom()
                            val pan = ev.calculatePan()
                            travel += pan
                            if (!moved && (travel.getDistance() > slop || kotlin.math.abs(zoom - 1f) > 0.02f)) moved = true
                            if (moved) {
                                state.transform(ev.calculateCentroid(useCurrent = false), pan, zoom)
                                ev.changes.forEach { it.consume() }
                            }
                        }
                    }
                    if (captured) handler?.onUp()
                    else if (!moved && maxPointers == 1) {
                        val c = state.toContent(upPos)
                        if (tUp - t0 > 450 && longPress != null) longPress?.invoke(c)
                        else if (tap != null) tap?.invoke(c)
                        else {
                            // double tap zooms in (only when single taps have no meaning on this screen)
                            if (tUp - lastTap.first < 320 && (upPos - lastTap.second).getDistance() < slop * 3) {
                                state.transform(upPos, Offset.Zero, if (state.scale < state.maxScale * 0.9f) 2.5f else state.fitScale / state.scale)
                                lastTap = 0L to Offset.Zero
                            } else lastTap = tUp to upPos
                        }
                    }
                }
            }
    ) {
        @Suppress("UNUSED_EXPRESSION") gen  // redraw when tiles arrive
        if (state.scale > 0f) {
            for (l in layers) drawLayer(l, state)
            overlay?.invoke(this, state)
        }
    }
    DisposableEffect(Unit) { onDispose { } }
}
