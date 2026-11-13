package dev.pocket3d.capture.logic

import dev.pocket3d.core.capture.FrameAnalysis
import dev.pocket3d.core.capture.ViewSpacing
import dev.pocket3d.core.project.FrameFlag
import dev.pocket3d.core.project.FrameQuality

/** What is known about the camera's motion and viewpoint at the moment a frame is judged. */
data class ViewContext(
    /**
     * Angle to the nearest kept viewpoint. null = no viewing direction is known (no tracking and
     * no orientation sensor); +∞ = a direction is known but no photo has been kept yet.
     */
    val nearestKeptDeg: Double? = null,
    val angularSpeedDegS: Double? = null,
    /** Translation speed; only known with AR tracking. */
    val linearSpeedMS: Double? = null,
    /** AR engine is active but not TRACKING. */
    val trackingLost: Boolean = false,
    /** dHash distance to the previously kept photo, when both hashes exist. */
    val hashDistanceToPrevious: Int? = null,
)

/** Things worth telling the user while they are still framing (before a photo is taken). */
enum class LiveWarning(val text: String) {
    MOTION_BLUR_RISK("Moving too fast — slow down to avoid blur"),
    SOFT_IMAGE("Image looks soft — hold steady or add light"),
    TOO_DARK("Too dark — add light"),
    OVEREXPOSED("Overexposed — avoid glare and direct light"),
    LOW_OVERLAP("Far from your other photos — little overlap, go back a bit"),
    NEAR_DUPLICATE("Same view as an existing photo — move on"),
}

/**
 * Classifies frames as weak. The same rules flag a stored photo ([judge]) and warn about the
 * live view ([liveWarnings]); auto-capture skips anything this calls weak, a manual capture of a
 * weak frame asks the user to keep or discard it.
 */
object FrameJudge {
    /** Translation speed above which motion blur is likely for a close object. */
    const val MAX_LINEAR_SPEED_M_S = 0.6
    /** Two photos from (nearly) the same direction count as duplicates only if they also look alike. */
    const val SIMILAR_HASH_DISTANCE = 10
    /** After a capture the live view is trivially "the same view": do not nag for this long. */
    const val DUPLICATE_HINT_DELAY_MS = 2500L

    /**
     * Final flags and quality of a captured photo.
     * @param quality image measurements of the stored photo (`FrameAnalysis.analyze`)
     * @param imageFlags blur / dark / overexposed flags from the same analysis
     */
    fun judge(quality: FrameQuality, imageFlags: List<String>, ctx: ViewContext): Pair<FrameQuality, List<String>> {
        val flags = LinkedHashSet(imageFlags)
        if (isFast(ctx)) flags += FrameFlag.FAST_MOTION
        if (ctx.trackingLost) flags += FrameFlag.TRACKING_LOST
        val nearest = ctx.nearestKeptDeg
        val hash = ctx.hashDistanceToPrevious
        var overlap: Double? = null
        if (nearest != null && nearest.isFinite()) {
            overlap = ViewSpacing.estimatedOverlap(nearest)
            if (nearest > ViewSpacing.MAX_STEP_DEG) flags += FrameFlag.LOW_OVERLAP
            // Same direction AND similar content. A static camera whose image changed is not a
            // duplicate — that is the turntable case, reported by TurntableDetector instead.
            if (nearest < ViewSpacing.DUPLICATE_DEG && (hash == null || hash <= SIMILAR_HASH_DISTANCE)) flags += FrameFlag.DUPLICATE
        }
        if (hash != null && hash <= FrameAnalysis.DUPLICATE_HASH_DISTANCE && nearest == null) flags += FrameFlag.DUPLICATE
        return quality.copy(overlap = overlap) to flags.toList()
    }

    fun isFast(ctx: ViewContext): Boolean =
        (ctx.angularSpeedDegS ?: 0.0) > ViewSpacing.MAX_ANGULAR_SPEED_DEG_S ||
            (ctx.linearSpeedMS ?: 0.0) > MAX_LINEAR_SPEED_M_S

    /**
     * Warnings for the live view.
     * @param liveFlags image flags of the latest analysed preview frame, or null if none was analysed yet
     */
    fun liveWarnings(liveFlags: List<String>?, ctx: ViewContext, msSinceLastCapture: Long): List<LiveWarning> {
        val out = ArrayList<LiveWarning>()
        if (isFast(ctx)) out += LiveWarning.MOTION_BLUR_RISK
        if (liveFlags != null) {
            if (FrameFlag.BLUR in liveFlags && LiveWarning.MOTION_BLUR_RISK !in out) out += LiveWarning.SOFT_IMAGE
            if (FrameFlag.DARK in liveFlags) out += LiveWarning.TOO_DARK
            if (FrameFlag.OVEREXPOSED in liveFlags) out += LiveWarning.OVEREXPOSED
        }
        val nearest = ctx.nearestKeptDeg
        if (nearest != null && nearest.isFinite()) {
            if (nearest > ViewSpacing.MAX_STEP_DEG) out += LiveWarning.LOW_OVERLAP
            else if (nearest < ViewSpacing.DUPLICATE_DEG && msSinceLastCapture >= DUPLICATE_HINT_DELAY_MS) out += LiveWarning.NEAR_DUPLICATE
        }
        return out
    }

    /** One line per problem for the "Keep anyway / Discard" prompt. */
    fun describe(flags: List<String>): List<String> = flags.map { FrameFlag.describe(it) }
}

enum class AutoDecision(val fire: Boolean, val hint: String?) {
    FIRE(true, null),
    DISABLED(false, null),
    NOT_ARMED(false, "Frame the object and press the shutter once — auto capture continues from there"),
    TRACKING_LOST(false, "Auto capture is paused until motion tracking is back"),
    NO_DIRECTION(false, "Auto capture needs AR tracking or an orientation sensor — use the shutter"),
    STORAGE_BLOCKED(false, "Storage is almost full"),
    BUSY(false, null),
    TOO_SOON(false, null),
    TOO_CLOSE(false, "Keep moving around the object"),
    TOO_FAST(false, "Slow down — the next photo is taken when the phone is steady"),
    POOR_QUALITY(false, "Waiting for a sharp, well-lit view"),
}

data class AutoCaptureInput(
    val enabled: Boolean,
    /** The user pressed the shutter once in this run, i.e. the object is framed. */
    val armed: Boolean,
    /** AR engine: auto capture requires TRACKING. Orientation engine: false. */
    val trackingRequired: Boolean,
    val trackingOk: Boolean,
    /** Angle to the nearest kept viewpoint: null = no direction known, +∞ = nothing kept yet. */
    val nearestKeptDeg: Double?,
    val angularSpeedDegS: Double?,
    val linearSpeedMS: Double? = null,
    /** Image flags of the latest analysed live frame; null = not analysed yet. */
    val liveFlags: List<String>?,
    val busy: Boolean,
    val storageBlocked: Boolean,
    val msSinceLastCapture: Long,
)

/**
 * Auto capture: take a photo when the viewpoint is at least one target step away from every kept
 * photo, the phone is moving slowly, and the live image is sharp and well exposed. It never
 * fires while tracking is lost, and it never fires on a direction that is not known.
 */
object AutoCaptureDecider {
    const val MIN_INTERVAL_MS = 700L

    fun decide(i: AutoCaptureInput): AutoDecision {
        if (!i.enabled) return AutoDecision.DISABLED
        if (i.trackingRequired && !i.trackingOk) return AutoDecision.TRACKING_LOST
        val nearest = i.nearestKeptDeg ?: return AutoDecision.NO_DIRECTION
        if (i.storageBlocked) return AutoDecision.STORAGE_BLOCKED
        if (!i.armed) return AutoDecision.NOT_ARMED
        if (i.busy) return AutoDecision.BUSY
        if (i.msSinceLastCapture < MIN_INTERVAL_MS) return AutoDecision.TOO_SOON
        if (nearest < ViewSpacing.TARGET_STEP_DEG) return AutoDecision.TOO_CLOSE
        if (FrameJudge.isFast(ViewContext(angularSpeedDegS = i.angularSpeedDegS, linearSpeedMS = i.linearSpeedMS)))
            return AutoDecision.TOO_FAST
        // Without a speed estimate or a live analysis there is no evidence the frame would be
        // good; auto capture then waits instead of guessing.
        if (i.angularSpeedDegS == null || i.liveFlags == null) return AutoDecision.POOR_QUALITY
        if (i.liveFlags.any { it == FrameFlag.BLUR || it == FrameFlag.DARK || it == FrameFlag.OVEREXPOSED })
            return AutoDecision.POOR_QUALITY
        return AutoDecision.FIRE
    }
}
