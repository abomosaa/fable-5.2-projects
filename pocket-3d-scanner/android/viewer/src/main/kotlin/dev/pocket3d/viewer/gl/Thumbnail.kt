package dev.pocket3d.viewer.gl

import android.graphics.Bitmap
import dev.pocket3d.core.mesh.Aabb
import dev.pocket3d.viewer.camera.CameraSnapshot
import dev.pocket3d.viewer.camera.OrbitCamera
import dev.pocket3d.viewer.camera.StandardView
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer

/** Pixel plumbing of the thumbnail; pure so it can be tested without a GPU. */
object ThumbnailPixels {
    /**
     * Converts `glReadPixels` output (RGBA bytes, bottom row first, [size]² pixels) to ARGB ints
     * with the top row first, averaging [factor]×[factor] blocks (simple supersampling).
     * The result has (size / factor)² pixels.
     */
    fun toArgb(rgba: ByteBuffer, size: Int, factor: Int): IntArray {
        require(factor >= 1 && size % factor == 0) { "size must be a multiple of factor" }
        require(rgba.capacity() >= size * size * 4) { "pixel buffer too small" }
        val outSize = size / factor
        val out = IntArray(outSize * outSize)
        val n = factor * factor
        for (oy in 0 until outSize) for (ox in 0 until outSize) {
            var r = 0; var g = 0; var b = 0
            for (dy in 0 until factor) for (dx in 0 until factor) {
                val sx = ox * factor + dx
                val sy = size - 1 - (oy * factor + dy)
                val o = (sy * size + sx) * 4
                r += rgba.get(o).toInt() and 0xff
                g += rgba.get(o + 1).toInt() and 0xff
                b += rgba.get(o + 2).toInt() and 0xff
            }
            out[oy * outSize + ox] = (0xff shl 24) or ((r / n) shl 16) or ((g / n) shl 8) or (b / n)
        }
        return out
    }

    /** The ¾ view used for thumbnails: slightly from above, the whole model framed in a square. */
    fun camera(bounds: Aabb): CameraSnapshot {
        val r = maxOf(bounds.diagonal * 0.5f, 1e-6f)
        val cam = OrbitCamera(fovY = Math.toRadians(30.0).toFloat())
            .withScene(bounds.center, r * 1.2f)
            .standardView(StandardView.ThreeQuarter)
            .fit(bounds, 1f, margin = 1.02f)
        return CameraSnapshot(cam, 1, 1)
    }
}

object Thumbnail {
    const val SIZE = 512
    private const val SUPERSAMPLE = 2

    /**
     * Renders the model that is currently in [bridge] (textured, neutral background, no overlays)
     * and returns PNG bytes, or null if no GL view is available right now.
     */
    suspend fun render(bridge: SceneBridge, bounds: Aabb): ByteArray? {
        val caps = bridge.caps.value ?: return null
        val factor = if (caps.maxTextureSize >= SIZE * SUPERSAMPLE) SUPERSAMPLE else 1
        val px = bridge.renderOffscreen(ThumbnailPixels.camera(bounds), SIZE * factor, BackgroundStyle.Gradient) ?: return null
        return kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) {
            val argb = ThumbnailPixels.toArgb(px, SIZE * factor, factor)
            val bmp = Bitmap.createBitmap(argb, SIZE, SIZE, Bitmap.Config.ARGB_8888)
            val out = ByteArrayOutputStream(256 * 1024)
            val ok = bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
            bmp.recycle()
            if (ok) out.toByteArray() else null
        }
    }
}
