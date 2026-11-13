package dev.pocket3d.core.capture

import dev.pocket3d.core.project.FrameFlag
import dev.pocket3d.core.project.FrameQuality

/**
 * Image-quality measurements on a luma (Y) plane. Pure functions on byte arrays so they are
 * identical for live camera frames and imported photos and can be unit-tested with synthetic
 * images.
 */
object FrameAnalysis {
    /** Width of the analysis image. Sharpness values are only comparable at this size. */
    const val ANALYSIS_WIDTH = 480

    /** Variance of the Laplacian below this is flagged as blurred (calibrated on ANALYSIS_WIDTH images). */
    const val BLUR_THRESHOLD = 60.0
    const val DARK_MEAN_LUMA = 45.0
    const val CLIPPED_LOW_LIMIT = 0.35
    const val CLIPPED_HIGH_LIMIT = 0.12

    /**
     * Box-downsample a luma plane (row stride [stride], pixel stride [pixelStride]) to
     * [ANALYSIS_WIDTH] columns (or keep it if already smaller). Returns (pixels, width, height).
     */
    fun downsample(src: ByteArray, width: Int, height: Int, stride: Int = width, pixelStride: Int = 1,
                   targetWidth: Int = ANALYSIS_WIDTH): Triple<ByteArray, Int, Int> {
        val step = maxOf(1, width / targetWidth)
        val w = width / step
        val h = height / step
        val out = ByteArray(w * h)
        for (y in 0 until h) {
            for (x in 0 until w) {
                var sum = 0
                for (dy in 0 until step) {
                    val row = (y * step + dy) * stride
                    for (dx in 0 until step) sum += src[row + (x * step + dx) * pixelStride].toInt() and 0xFF
                }
                out[y * w + x] = (sum / (step * step)).toByte()
            }
        }
        return Triple(out, w, h)
    }

    /** Variance of the 4-neighbour Laplacian: the standard focus measure (higher = sharper). */
    fun laplacianVariance(luma: ByteArray, width: Int, height: Int): Double {
        if (width < 3 || height < 3) return 0.0
        var sum = 0.0; var sumSq = 0.0; var n = 0
        for (y in 1 until height - 1) {
            val row = y * width
            for (x in 1 until width - 1) {
                val i = row + x
                val c = luma[i].toInt() and 0xFF
                val lap = (luma[i - 1].toInt() and 0xFF) + (luma[i + 1].toInt() and 0xFF) +
                    (luma[i - width].toInt() and 0xFF) + (luma[i + width].toInt() and 0xFF) - 4 * c
                sum += lap; sumSq += lap.toDouble() * lap; n++
            }
        }
        val mean = sum / n
        return sumSq / n - mean * mean
    }

    data class Exposure(val meanLuma: Double, val clippedLow: Double, val clippedHigh: Double)

    fun exposure(luma: ByteArray): Exposure {
        if (luma.isEmpty()) return Exposure(0.0, 0.0, 0.0)
        var sum = 0L; var low = 0; var high = 0
        for (b in luma) {
            val v = b.toInt() and 0xFF
            sum += v
            if (v <= 8) low++ else if (v >= 247) high++
        }
        return Exposure(sum.toDouble() / luma.size, low.toDouble() / luma.size, high.toDouble() / luma.size)
    }

    /**
     * 64-bit difference hash of the image (9×8 grid). Two photos of the same view have a small
     * Hamming distance; used to flag duplicates among imported photos where no pose is known.
     */
    fun dHash(luma: ByteArray, width: Int, height: Int): Long {
        val gw = 9; val gh = 8
        val grid = IntArray(gw * gh)
        for (gy in 0 until gh) for (gx in 0 until gw) {
            val x0 = gx * width / gw; val x1 = maxOf(x0 + 1, (gx + 1) * width / gw)
            val y0 = gy * height / gh; val y1 = maxOf(y0 + 1, (gy + 1) * height / gh)
            var s = 0; var n = 0
            for (y in y0 until y1) for (x in x0 until x1) { s += luma[y * width + x].toInt() and 0xFF; n++ }
            grid[gy * gw + gx] = s / maxOf(n, 1)
        }
        var hash = 0L
        for (gy in 0 until gh) for (gx in 0 until gw - 1) {
            hash = (hash shl 1) or (if (grid[gy * gw + gx] > grid[gy * gw + gx + 1]) 1L else 0L)
        }
        return hash
    }

    fun hammingDistance(a: Long, b: Long): Int = java.lang.Long.bitCount(a xor b)

    /** dHash distance at or below which two photos are considered near-identical views. */
    const val DUPLICATE_HASH_DISTANCE = 4

    /** Full analysis of one luma image: metrics plus image-only flags (blur, dark, overexposed). */
    fun analyze(luma: ByteArray, width: Int, height: Int): Pair<FrameQuality, List<String>> {
        val sharp = laplacianVariance(luma, width, height)
        val e = exposure(luma)
        val flags = ArrayList<String>()
        if (sharp < BLUR_THRESHOLD) flags += FrameFlag.BLUR
        if (e.meanLuma < DARK_MEAN_LUMA || e.clippedLow > CLIPPED_LOW_LIMIT) flags += FrameFlag.DARK
        if (e.clippedHigh > CLIPPED_HIGH_LIMIT) flags += FrameFlag.OVEREXPOSED
        return FrameQuality(sharpness = sharp, clippedLow = e.clippedLow, clippedHigh = e.clippedHigh,
                            meanLuma = e.meanLuma) to flags
    }
}
