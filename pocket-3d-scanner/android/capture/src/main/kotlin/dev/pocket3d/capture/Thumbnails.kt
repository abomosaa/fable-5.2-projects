package dev.pocket3d.capture

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.BrokenImage
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import dev.pocket3d.capture.logic.ReviewLogic
import dev.pocket3d.core.capture.ImageGeometry
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * Decodes down-sampled, upright thumbnails of stored photos off the main thread.
 *
 * Photos are stored un-rotated with an EXIF orientation tag (see [ImageGeometry]); the caller
 * passes the frame's `exifOrientation` and the thumbnail is rotated/mirrored for display only —
 * the stored file is never touched.
 */
internal object ThumbnailLoader {
    /** Few decodes at a time: a full-size JPEG needs tens of MB while it is being sampled. */
    @OptIn(ExperimentalCoroutinesApi::class)
    private val decodeDispatcher = Dispatchers.IO.limitedParallelism(3)

    private val cache = object : LruCache<String, Bitmap>(cacheBytes()) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.allocationByteCount
    }

    /** "path|orientation|target" -> full cache key of the last successful load (for [peek]). */
    private val lastKey = ConcurrentHashMap<String, String>()

    private fun cacheBytes(): Int {
        val max = Runtime.getRuntime().maxMemory()
        return (max / 8).coerceIn(8L shl 20, 48L shl 20).toInt()
    }

    private fun shortKey(file: File, exifOrientation: Int, targetPx: Int) = "${file.path}|$exifOrientation|$targetPx"

    /**
     * Thumbnail of [file] whose shorter side is at least [targetPx] (when the photo is that
     * large), displayed upright according to [exifOrientation] (1..8). Null if the file is
     * missing or cannot be decoded.
     */
    suspend fun load(file: File, exifOrientation: Int, targetPx: Int): ImageBitmap? = withContext(decodeDispatcher) {
        try {
            val length = file.length()
            if (length <= 0L) return@withContext null
            val short = shortKey(file, exifOrientation, targetPx)
            val key = "$short|$length|${file.lastModified()}"
            cache.get(key)?.let { lastKey[short] = key; return@withContext it.asImageBitmap() }
            val bitmap = decode(file, exifOrientation, targetPx) ?: return@withContext null
            cache.put(key, bitmap)
            lastKey[short] = key
            bitmap.asImageBitmap()
        } catch (c: CancellationException) {
            throw c
        } catch (t: Exception) {
            null
        } catch (oom: OutOfMemoryError) {
            cache.evictAll()
            null
        }
    }

    /**
     * Cached thumbnail from the last successful [load] with the same arguments, without touching
     * the disk (safe on the main thread). Used to avoid a placeholder flash while scrolling.
     */
    fun peek(file: File, exifOrientation: Int, targetPx: Int): ImageBitmap? {
        val key = lastKey[shortKey(file, exifOrientation, targetPx)] ?: return null
        return cache.get(key)?.asImageBitmap()
    }

    /** Drops every cached size of [file] (call after deleting or replacing the photo). */
    fun evict(file: File) {
        val prefix = file.path + "|"
        for (key in cache.snapshot().keys) if (key.startsWith(prefix)) cache.remove(key)
        lastKey.keys.removeAll { it.startsWith(prefix) }
    }

    private fun decode(file: File, exifOrientation: Int, targetPx: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val options = BitmapFactory.Options().apply {
            inSampleSize = ReviewLogic.sampleSize(bounds.outWidth, bounds.outHeight, targetPx)
            // Small grid thumbnails: half the memory of ARGB_8888 (ignored by decoders that cannot
            // honour it). Larger previews keep full colour depth to avoid visible banding.
            if (targetPx <= 400) inPreferredConfig = Bitmap.Config.RGB_565
        }
        val raw = BitmapFactory.decodeFile(file.path, options) ?: return null
        val (quarterTurnsCw, mirrored) = ImageGeometry.exifQuarterTurns(exifOrientation)
        if (quarterTurnsCw == 0 && !mirrored) return raw
        // EXIF 2/4/5/7 = horizontal mirror followed by the clockwise quarter turns.
        val m = Matrix()
        if (mirrored) m.postScale(-1f, 1f)
        if (quarterTurnsCw != 0) m.postRotate(90f * quarterTurnsCw)
        val upright = Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, m, true)
        if (upright !== raw) raw.recycle()
        return upright
    }
}

/**
 * Square-croppable thumbnail of a stored photo. Shows a neutral placeholder while decoding and a
 * broken-image icon if the file cannot be decoded.
 */
@Composable
internal fun FrameThumbnail(
    file: File,
    exifOrientation: Int,
    modifier: Modifier = Modifier,
    targetPx: Int = 256,
    contentDescription: String? = null,
) {
    val path = file.path
    var bitmap by remember(path, exifOrientation, targetPx) {
        mutableStateOf(ThumbnailLoader.peek(file, exifOrientation, targetPx))
    }
    var failed by remember(path, exifOrientation, targetPx) { mutableStateOf(false) }
    LaunchedEffect(path, exifOrientation, targetPx) {
        val loaded = ThumbnailLoader.load(file, exifOrientation, targetPx)
        if (loaded != null) { bitmap = loaded; failed = false } else { bitmap = null; failed = true }
    }
    Box(modifier.background(MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) {
        val b = bitmap
        when {
            b != null -> Image(bitmap = b, contentDescription = contentDescription, modifier = Modifier.fillMaxSize(),
                               contentScale = ContentScale.Crop)
            failed -> Icon(Icons.Outlined.BrokenImage, contentDescription = contentDescription ?: "Photo could not be decoded",
                           tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(28.dp))
        }
    }
}
