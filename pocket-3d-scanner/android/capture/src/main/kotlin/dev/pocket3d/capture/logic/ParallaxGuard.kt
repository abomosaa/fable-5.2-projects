package dev.pocket3d.capture.logic

import dev.pocket3d.core.capture.ViewSpacing
import dev.pocket3d.core.math.Vec3
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.sqrt
import kotlin.math.tan

/**
 * Frame-to-frame image shift of the CENTRE of the picture (where the object is framed), from
 * 1-D projection profiles — cheap enough for every analysis frame, no feature matching.
 *
 * Why the centre: when the user orbits an object and keeps it centred, the phone rotates but
 * the centre of the picture keeps showing the object (shift ≈ 0). When the user merely turns
 * on the spot, the whole picture slides by f·tan(angle). The orientation sensor alone cannot
 * tell the two apart; this can.
 */
object ImageShift {
    class Shift(val dx: Float, val dy: Float, val confidence: Float)

    /** Central window (fractions of width / height) used for the profiles. */
    const val WINDOW = 0.5f
    const val MIN_CONFIDENCE = 0.45f

    /**
     * Shift of [cur] relative to [prev] in pixels (+dx: content moved right), or null when the
     * centre has too little structure to tell, or the frames are too different.
     */
    fun estimate(prev: ByteArray, cur: ByteArray, w: Int, h: Int): Shift? {
        if (prev.size != cur.size || w < 32 || h < 32 || prev.size < w * h) return null
        val x0 = ((1 - WINDOW) / 2 * w).toInt(); val x1 = w - x0
        val y0 = ((1 - WINDOW) / 2 * h).toInt(); val y1 = h - y0
        val colP = FloatArray(x1 - x0); val colC = FloatArray(x1 - x0)
        val rowP = FloatArray(y1 - y0); val rowC = FloatArray(y1 - y0)
        for (y in y0 until y1) {
            var sp = 0f; var sc = 0f
            val row = y * w
            for (x in x0 until x1) {
                val p = (prev[row + x].toInt() and 0xFF).toFloat(); val c = (cur[row + x].toInt() and 0xFF).toFloat()
                colP[x - x0] += p; colC[x - x0] += c
                sp += p; sc += c
            }
            rowP[y - y0] = sp; rowC[y - y0] = sc
        }
        val sx = bestShift(colP, colC) ?: return null
        val sy = bestShift(rowP, rowC) ?: return null
        return Shift(sx.first, sy.first, minOf(sx.second, sy.second))
    }

    /** (shift, normalised correlation) maximising the match of [b] against [a] shifted; null if flat. */
    private fun bestShift(a: FloatArray, b: FloatArray): Pair<Float, Float>? {
        val n = a.size
        val maxS = n / 3
        fun normalise(v: FloatArray): Boolean {
            var m = 0f; for (x in v) m += x; m /= n
            var s = 0f
            for (i in v.indices) { v[i] -= m; s += v[i] * v[i] }
            if (s <= 1e-3f * n) return false
            // A profile is a sum over hundreds of pixels: require real structure, not sensor noise.
            return sqrt(s / n) > 0.004f * 255f * n
        }
        if (!normalise(a) || !normalise(b)) return null
        var best = Float.NEGATIVE_INFINITY; var bestS = 0
        val scores = FloatArray(2 * maxS + 1)
        for (s in -maxS..maxS) {
            var num = 0f; var da = 0f; var db = 0f
            val from = maxOf(0, s); val to = minOf(n, n + s)
            for (i in from until to) {
                val x = a[i - s]; val y = b[i]
                num += x * y; da += x * x; db += y * y
            }
            val c = if (da > 0 && db > 0) num / sqrt(da * db) else 0f
            scores[s + maxS] = c
            if (c > best) { best = c; bestS = s }
        }
        if (best < MIN_CONFIDENCE) return null
        // parabolic sub-pixel refinement
        var sub = 0f
        val i = bestS + maxS
        if (i in 1 until scores.size - 1) {
            val l = scores[i - 1]; val r = scores[i + 1]
            val d = l - 2 * best + r
            if (abs(d) > 1e-6f) sub = (0.5f * (l - r) / d).coerceIn(-0.5f, 0.5f)
        }
        return (bestS + sub) to best
    }
}

/**
 * Decides, without position tracking, whether the phone is orbiting the object or just turning
 * on the spot, by comparing how far the centre of the picture slid ([ImageShift], accumulated)
 * with how far it would have slid under a pure rotation by the angle the orientation sensor
 * reports. Used only in the orientation-estimate capture mode; AR mode has real positions.
 *
 * It is an estimate: an object that does not fill the centre of the frame, or a blank centre,
 * gives no verdict rather than a wrong one where possible, and the UI words it as "it looks like".
 */
class ParallaxGuard(
    /** Focal length in analysis-image pixels; null → assume a typical phone main camera (≈ 67° across the long side). */
    private val focalPx: () -> Float?,
) {
    enum class Verdict { ORBIT, TURNING, UNKNOWN }

    private var dirAtCapture: Vec3? = null
    private var shiftAtCapture: Pair<Double, Double>? = null
    private var validAtCapture = 0L
    private var framesAtCapture = 0L
    private var lastDir: Vec3? = null
    private var lastShift: Pair<Double, Double>? = null
    private var lastValid = 0L
    private var lastFrames = 0L
    private var lastWidth = 0
    var turningSteps = 0
        private set
    var lastVerdict = Verdict.UNKNOWN
        private set

    /** Two consecutive steps without parallax: warn and pause auto capture. */
    val turningInPlace: Boolean get() = turningSteps >= 2

    /**
     * @param dir viewing-direction estimate from the orientation sensor (any consistent vector)
     * @param cumDx/cumDy image shift accumulated by the engine since it started (analysis pixels)
     * @param validFrames number of frame pairs that contributed a shift so far
     * @param frames number of frame pairs analysed so far
     */
    fun onSample(dir: Vec3?, cumDx: Double, cumDy: Double, validFrames: Long, frames: Long, analysisWidth: Int) {
        lastDir = dir ?: lastDir
        lastShift = cumDx to cumDy
        lastValid = validFrames; lastFrames = frames; lastWidth = analysisWidth
    }

    /** Ratio measured-shift / pure-rotation-shift since the last kept photo, or null if not judgeable (yet). */
    fun currentRatio(): Double? {
        val d0 = dirAtCapture ?: return null
        val s0 = shiftAtCapture ?: return null
        val d1 = lastDir ?: return null
        val s1 = lastShift ?: return null
        val angle = ViewSpacing.angleDeg(d0, d1)
        if (angle < MIN_ANGLE_DEG || angle > 60.0) return null
        val frames = lastFrames - framesAtCapture
        val valid = lastValid - validAtCapture
        if (frames < 3 || valid < 0.6 * frames) return null        // the centre was not trackable
        val f = focalPx() ?: (DEFAULT_FOCAL_PER_WIDTH * lastWidth)
        if (f <= 0f) return null
        val expected = f * tan(Math.toRadians(angle))
        return hypot(s1.first - s0.first, s1.second - s0.second) / expected
    }

    fun verdictNow(): Verdict = when (val r = currentRatio()) {
        null -> Verdict.UNKNOWN
        else -> if (r >= TURNING_RATIO) Verdict.TURNING else if (r <= ORBIT_RATIO) Verdict.ORBIT else Verdict.UNKNOWN
    }

    /** Call when a photo was kept: closes the step since the previous photo. */
    fun onCapture() {
        if (dirAtCapture != null) {
            lastVerdict = verdictNow()
            when (lastVerdict) {
                Verdict.TURNING -> turningSteps++
                Verdict.ORBIT -> turningSteps = 0
                Verdict.UNKNOWN -> {}
            }
        }
        dirAtCapture = lastDir
        shiftAtCapture = lastShift
        validAtCapture = lastValid; framesAtCapture = lastFrames
    }

    /** Auto capture should wait: the previous step had no parallax and the current one looks the same. */
    fun holdAutoCapture(): Boolean = turningSteps >= 1 && verdictNow() == Verdict.TURNING

    fun reset() {
        dirAtCapture = null; shiftAtCapture = null; turningSteps = 0; lastVerdict = Verdict.UNKNOWN
    }

    companion object {
        const val MIN_ANGLE_DEG = 6.0
        const val TURNING_RATIO = 0.6
        const val ORBIT_RATIO = 0.35
        const val DEFAULT_FOCAL_PER_WIDTH = 0.75f
    }
}
