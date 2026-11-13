package dev.pocket3d.capture.logic

import dev.pocket3d.core.capture.FrameAnalysis
import java.nio.ByteBuffer

/**
 * YUV_420_888 plane handling. Android image planes come with arbitrary row strides (padding at
 * the end of each row) and pixel strides (1 = planar, 2 = interleaved chroma); the last row of a
 * plane is usually NOT padded, so a row is never read beyond the bytes that hold real pixels.
 *
 * All functions use absolute reads on duplicates and leave the callers' buffer positions alone.
 */
object YuvPacking {
    /**
     * Packs three YUV_420_888 planes into NV21 (full-resolution Y plane followed by interleaved
     * V,U at half resolution) — the layout `android.graphics.YuvImage` encodes to JPEG.
     */
    fun nv21(
        width: Int, height: Int,
        y: ByteBuffer, yRowStride: Int, yPixelStride: Int,
        u: ByteBuffer, uRowStride: Int, uPixelStride: Int,
        v: ByteBuffer, vRowStride: Int, vPixelStride: Int,
    ): ByteArray {
        require(width > 0 && height > 0) { "empty image" }
        val cw = (width + 1) / 2
        val ch = (height + 1) / 2
        val out = ByteArray(width * height + 2 * cw * ch)
        copyPlane(y, width, height, yRowStride, yPixelStride, out, 0, 1)
        // NV21 chroma order is V first, then U.
        copyPlane(v, cw, ch, vRowStride, vPixelStride, out, width * height, 2)
        copyPlane(u, cw, ch, uRowStride, uPixelStride, out, width * height + 1, 2)
        return out
    }

    /** Tightly packed copy (width × height bytes) of the luma plane. */
    fun luma(y: ByteBuffer, width: Int, height: Int, rowStride: Int, pixelStride: Int): ByteArray {
        val out = ByteArray(width * height)
        copyPlane(y, width, height, rowStride, pixelStride, out, 0, 1)
        return out
    }

    /**
     * Box-downsampled luma for quality analysis, identical to
     * `FrameAnalysis.downsample(luma(...), width, height)` but without the full-size copy.
     * Returns (pixels, width, height).
     */
    fun analysisLuma(y: ByteBuffer, width: Int, height: Int, rowStride: Int, pixelStride: Int,
                     targetWidth: Int = FrameAnalysis.ANALYSIS_WIDTH): Triple<ByteArray, Int, Int> {
        val step = maxOf(1, width / targetWidth)
        val w = width / step
        val h = height / step
        val out = ByteArray(w * h)
        if (w == 0 || h == 0) return Triple(out, w, h)
        val src = y.duplicate()
        val used = w * step
        val rowBytes = (used - 1) * pixelStride + 1
        val row = ByteArray(rowBytes)
        val sums = IntArray(w)
        val area = step * step
        for (oy in 0 until h) {
            sums.fill(0)
            for (dy in 0 until step) {
                src.position((oy * step + dy) * rowStride)
                src.get(row, 0, rowBytes)
                var i = 0
                for (ox in 0 until w) {
                    var s = 0
                    for (dx in 0 until step) { s += row[i].toInt() and 0xFF; i += pixelStride }
                    sums[ox] += s
                }
            }
            val base = oy * w
            for (ox in 0 until w) out[base + ox] = (sums[ox] / area).toByte()
        }
        return Triple(out, w, h)
    }

    private fun copyPlane(src: ByteBuffer, width: Int, height: Int, rowStride: Int, pixelStride: Int,
                          out: ByteArray, outOffset: Int, outStep: Int) {
        require(rowStride >= 1 && pixelStride >= 1) { "invalid strides" }
        val buf = src.duplicate()
        val rowBytes = (width - 1) * pixelStride + 1
        require(buf.limit() >= (height - 1) * rowStride + rowBytes) { "plane buffer is smaller than the image" }
        if (pixelStride == 1 && outStep == 1) {
            for (r in 0 until height) {
                buf.position(r * rowStride)
                buf.get(out, outOffset + r * width, width)
            }
            return
        }
        val row = ByteArray(rowBytes)
        var o = outOffset
        for (r in 0 until height) {
            buf.position(r * rowStride)
            buf.get(row, 0, rowBytes)
            var i = 0
            for (c in 0 until width) {
                out[o] = row[i]
                o += outStep
                i += pixelStride
            }
        }
    }
}
