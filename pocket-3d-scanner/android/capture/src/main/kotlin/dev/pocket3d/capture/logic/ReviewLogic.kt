package dev.pocket3d.capture.logic

import dev.pocket3d.core.net.StatusResponse
import dev.pocket3d.core.project.Frame
import dev.pocket3d.core.project.FrameFlag

/**
 * Pure decision logic of the frame review screen: ordering, per-flag counts, the summary
 * warnings and the thumbnail sample size. No Android types, covered by JVM unit tests.
 */
internal object ReviewLogic {
    const val ORDER_TIME = "time"
    const val ORDER_NAME = "name"
    const val ORDER_MANUAL = "manual"

    /** Below this many included photos a reconstruction usually fails or has large holes. */
    const val RECOMMENDED_MIN_PHOTOS = 20
    /** Hard minimum used when the companion's own limit is not known (not paired / unreachable). */
    const val FALLBACK_MIN_PHOTOS = 3

    /** Flag display order; unknown flags follow alphabetically. */
    private val FLAG_ORDER = listOf(
        FrameFlag.BLUR, FrameFlag.FAST_MOTION, FrameFlag.DARK, FrameFlag.OVEREXPOSED, FrameFlag.DUPLICATE,
        FrameFlag.LOW_OVERLAP, FrameFlag.TRACKING_LOST, FrameFlag.LOW_RESOLUTION, FrameFlag.NO_METADATA,
    )

    /**
     * Numeric-aware, case-insensitive comparison: "IMG_2.jpg" < "IMG_10.jpg". Digit runs compare
     * by value (any length, leading zeros ignored); ties fall back to the plain string order so
     * the result is a total order.
     */
    fun naturalCompare(a: String, b: String): Int {
        var i = 0
        var j = 0
        while (i < a.length && j < b.length) {
            val ca = a[i]
            val cb = b[j]
            if (ca.isAsciiDigit() && cb.isAsciiDigit()) {
                var ie = i
                while (ie < a.length && a[ie].isAsciiDigit()) ie++
                var je = j
                while (je < b.length && b[je].isAsciiDigit()) je++
                var si = i
                while (si < ie - 1 && a[si] == '0') si++
                var sj = j
                while (sj < je - 1 && b[sj] == '0') sj++
                val lenA = ie - si
                val lenB = je - sj
                if (lenA != lenB) return lenA.compareTo(lenB)
                for (k in 0 until lenA) {
                    val d = a[si + k].compareTo(b[sj + k])
                    if (d != 0) return d
                }
                i = ie
                j = je
            } else {
                val d = ca.lowercaseChar().compareTo(cb.lowercaseChar())
                if (d != 0) return d
                i++
                j++
            }
        }
        val rest = (a.length - i).compareTo(b.length - j)
        return if (rest != 0) rest else a.compareTo(b)
    }

    private fun Char.isAsciiDigit() = this in '0'..'9'

    private val byName: Comparator<Frame> =
        Comparator<Frame> { x, y -> naturalCompare(x.name, y.name) }.thenBy { it.id }

    /** Capture time ascending, photos without a timestamp last; ties and unknowns by name. */
    private val byTime: Comparator<Frame> = Comparator<Frame> { x, y ->
        val tx = x.timestampMs
        val ty = y.timestampMs
        when {
            tx == null && ty == null -> 0
            tx == null -> 1
            ty == null -> -1
            else -> tx.compareTo(ty)
        }
    }.then(byName)

    fun comparator(ordering: String): Comparator<Frame>? = when (ordering) {
        ORDER_TIME -> byTime
        ORDER_NAME -> byName
        else -> null
    }

    /** Frames in the given ordering; unknown orderings ("manual") keep the stored order. */
    fun ordered(frames: List<Frame>, ordering: String): List<Frame> {
        val c = comparator(ordering) ?: return frames
        return frames.sortedWith(c)
    }

    fun orderedIds(frames: List<Frame>, ordering: String): List<String> = ordered(frames, ordering).map { it.id }

    fun orderingLabel(ordering: String): String = when (ordering) {
        ORDER_TIME -> "Capture time"
        ORDER_NAME -> "File name"
        else -> "Custom order"
    }

    /** Number of INCLUDED photos carrying each flag, in display order. Flags without photos are omitted. */
    fun flagCounts(frames: List<Frame>): List<Pair<String, Int>> {
        val counts = HashMap<String, Int>()
        for (f in frames) {
            if (f.excluded) continue
            for (flag in f.flags.distinct()) counts[flag] = (counts[flag] ?: 0) + 1
        }
        val known = FLAG_ORDER.filter { it in counts }
        val unknown = counts.keys.filter { it !in FLAG_ORDER }.sorted()
        return (known + unknown).map { it to counts.getValue(it) }
    }

    /** Ids of included photos with at least one flag ("select all flagged"). */
    fun flaggedIncludedIds(frames: List<Frame>): List<String> =
        frames.filter { !it.excluded && it.flags.isNotEmpty() }.map { it.id }

    /** Short badge text of a flag: the part of [FrameFlag.describe] before the advice. */
    fun shortFlagLabel(flag: String): String = FrameFlag.describe(flag).substringBefore(" — ")

    enum class Severity { INFO, WARN, BLOCK }

    data class Notice(val severity: Severity, val title: String, val body: String? = null)

    data class Summary(
        val total: Int,
        val included: Int,
        val excluded: Int,
        val flaggedIncluded: Int,
        val flagCounts: List<Pair<String, Int>>,
        /** Minimum photo count enforced for "Continue". */
        val minRequired: Int,
        /** True if [minRequired]/[maxAllowed] come from the paired companion's status. */
        val limitsFromCompanion: Boolean,
        val maxAllowed: Int?,
        val notices: List<Notice>,
        val canContinue: Boolean,
        /** Why "Continue" is disabled, or null. */
        val blockReason: String?,
    ) {
        val limitsText: String
            get() = if (limitsFromCompanion && maxAllowed != null) "Companion accepts $minRequired–$maxAllowed photos"
            else "Companion limits unknown until it is connected"
    }

    /**
     * Summary of a session for the review header. [limits] are the paired companion's limits
     * when its status is known; null means unknown (only the absolute minimum is enforced).
     */
    fun summarize(frames: List<Frame>, limits: StatusResponse.Limits?): Summary {
        val total = frames.size
        val included = frames.count { !it.excluded }
        val flaggedIncluded = frames.count { !it.excluded && it.flags.isNotEmpty() }
        val min = maxOf(1, limits?.minImages ?: FALLBACK_MIN_PHOTOS)
        val max = limits?.maxImages
        val notices = ArrayList<Notice>()
        var block: String? = null

        if (included < min) {
            block = when {
                total == 0 -> "Add photos to continue."
                included == 0 -> "No photos are included. Include at least $min to continue."
                limits != null -> "The companion needs at least $min photos; $included ${plural(included, "is", "are")} included."
                else -> "At least $min photos are needed for any reconstruction; $included ${plural(included, "is", "are")} included."
            }
            notices += Notice(Severity.BLOCK, "Not enough photos", block)
        } else if (included < RECOMMENDED_MIN_PHOTOS) {
            notices += Notice(
                Severity.WARN, "Only $included ${plural(included, "photo", "photos")} included — usually too few",
                "One ring around the object takes about 30 overlapping photos. With fewer than " +
                    "$RECOMMENDED_MIN_PHOTOS the reconstruction often fails or has large holes.",
            )
        }
        if (max != null && included > max) {
            notices += Notice(
                Severity.WARN, "More photos than the companion accepts",
                "The paired companion accepts at most $max photos; $included are included. " +
                    "Exclude ${included - max} or the upload will be rejected.",
            )
        }
        if (flaggedIncluded > 0) {
            notices += Notice(
                Severity.INFO,
                "$flaggedIncluded included ${plural(flaggedIncluded, "photo has", "photos have")} quality flags",
                "Flags are automatic on-phone checks, not a verdict. Blurry or badly exposed photos can " +
                    "lower reconstruction quality — look at them and exclude the weak ones.",
            )
        }
        return Summary(
            total = total, included = included, excluded = total - included, flaggedIncluded = flaggedIncluded,
            flagCounts = flagCounts(frames), minRequired = min, limitsFromCompanion = limits != null,
            maxAllowed = max, notices = notices, canContinue = block == null, blockReason = block,
        )
    }

    private fun plural(n: Int, one: String, many: String) = if (n == 1) one else many

    /**
     * Power-of-two `inSampleSize` for decoding a [width] x [height] image so that its SHORTER side
     * stays at least [targetPx] (the thumbnail is centre-cropped, so the short side sets sharpness).
     */
    fun sampleSize(width: Int, height: Int, targetPx: Int): Int {
        if (width <= 0 || height <= 0 || targetPx <= 0) return 1
        val short = minOf(width, height)
        var sample = 1
        while (short / (sample * 2) >= targetPx && sample < 64) sample *= 2
        return sample
    }
}
