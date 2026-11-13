package dev.pocket3d.capture.engine

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import dev.pocket3d.core.capture.FrameAnalysis
import dev.pocket3d.core.math.Quat
import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.project.Distortion
import dev.pocket3d.core.project.ExposureInfo
import dev.pocket3d.core.project.FocusInfo
import dev.pocket3d.core.project.Intrinsics
import kotlinx.coroutines.flow.StateFlow
import java.io.File

internal enum class EngineKind { AR, CAMERA }

/** How viewpoints are known. Mirrors `TrackingInfo.mode`. */
internal enum class ViewpointSource(val wire: String) { ARCORE("arcore"), IMU("imu"), NONE("none") }

/** What the engine sees right now. Emitted several times per second; cheap to copy. */
internal data class LiveSample(
    val timeNs: Long = 0L,
    /** AR engine only: ARCore reports TRACKING. */
    val trackingOk: Boolean = false,
    /** AR engine only: "Tracking" / "Tracking paused" / "Starting…" */
    val trackingLabel: String? = null,
    /** AR engine only: concrete advice for the current tracking failure. */
    val trackingAdvice: String? = null,
    /**
     * AR engine only: number of times tracking was lost so far in this AR session. Poses with
     * different epochs must not be assumed to share a coordinate system.
     */
    val trackingEpoch: Int = 0,
    /** Tracked camera position in the AR world (metres). */
    val position: Vec3? = null,
    /** Viewing direction in the AR world. */
    val forward: Vec3? = null,
    /**
     * Viewpoint direction (object → camera, +Y up) estimated from orientation alone, under the
     * assumption that the camera is aimed at the object. null if no orientation is known.
     */
    val orientationDir: Vec3? = null,
    val angularSpeedDegS: Double? = null,
    val linearSpeedMS: Double? = null,
    /** AR engine only: object centre in the current AR world frame, when set and tracked. */
    val objectCenter: Vec3? = null,
    /** Image flags (blur / dark / overexposed) of the latest analysed live frame; null before the first one. */
    val liveFlags: List<String>? = null,
    val liveSharpness: Double? = null,
    val liveHash: Long? = null,
    /**
     * Camera engine only: shift of the centre of the live picture accumulated since the engine
     * started (analysis pixels), with the number of frame pairs that contributed / were analysed.
     * Input of the turning-on-the-spot check (ParallaxGuard).
     */
    val centreShiftX: Double = 0.0,
    val centreShiftY: Double = 0.0,
    val centreShiftValid: Long = 0,
    val centreShiftFrames: Long = 0,
    val analysisWidth: Int = 0,
    val analysisFocalPx: Float? = null,
)

internal sealed interface EngineStatus {
    data object Starting : EngineStatus
    data object Running : EngineStatus
    /** Temporarily not delivering images (e.g. another app holds the camera); recovers by itself. */
    data class Interrupted(val message: String) : EngineStatus
    /** Cannot run. [message] says exactly why; the caller offers the fallback. */
    data class Failed(val message: String) : EngineStatus
}

/** Slowly changing facts about the running engine, for labels. */
internal data class EngineInfo(
    val viewpointSource: ViewpointSource = ViewpointSource.NONE,
    /** Stored photo size, when known. */
    val photoWidth: Int = 0,
    val photoHeight: Int = 0,
    /** Width / height of the preview as shown in portrait (e.g. 3/4). */
    val previewAspect: Float = 3f / 4f,
    val lock: LockState = LockState(),
    /** ARCore Depth API support of this session; null = not an AR session. Detected, never used. */
    val arDepthSupported: Boolean? = null,
    val intrinsicsSource: String? = null,
    val cameraId: String? = null,
)

/** Focus / exposure / white-balance lock of the CameraX engine. */
internal data class LockState(
    /** At least one of AE / AF / AWB can be locked. */
    val anySupported: Boolean = false,
    val aeSupported: Boolean = false,
    val afSupported: Boolean = false,
    val awbSupported: Boolean = false,
    val fixedFocus: Boolean = false,
    val requested: Boolean = false,
    val inProgress: Boolean = false,
    /** Result of the last lock attempt, phrased for the user. */
    val detail: String? = null,
) {
    /** What the device cannot lock, in words; null if everything can be locked. */
    val unsupportedText: String? get() {
        val missing = buildList {
            if (!aeSupported) add("exposure")
            if (!afSupported && !fixedFocus) add("focus")
            if (!awbSupported) add("white balance")
        }
        return when {
            missing.isEmpty() -> null
            !anySupported -> "This camera cannot lock ${missing.joinToString(", ")} — keep the lighting constant."
            else -> "This camera cannot lock ${missing.joinToString(" or ")}."
        }
    }
}

/** A photo that was written to disk by an engine but is not yet committed to the session. */
internal class RawCapture(
    val file: File,
    val timestampMs: Long,
    /** Stored pixel size, before applying [exifOrientation]. */
    val width: Int,
    val height: Int,
    val exifOrientation: Int,
    val intrinsics: Intrinsics?,
    val distortion: Distortion?,
    /** AR pose at the time the image was taken; null unless ARCore was TRACKING. */
    val position: Vec3?,
    val rotation: Quat?,
    /** AR engine was active but not tracking when the image was taken. */
    val trackingLost: Boolean,
    /** [LiveSample.trackingEpoch] at the moment the image was taken. */
    val trackingEpoch: Int = 0,
    val orientationDir: Vec3?,
    val angularSpeedDegS: Double?,
    val linearSpeedMS: Double?,
    val focus: FocusInfo?,
    val exposure: ExposureInfo?,
    /** Luma of the stored image at analysis size (pixels, width, height); null if it could not be produced. */
    val analysisLuma: Triple<ByteArray, Int, Int>?,
)

internal sealed interface CaptureOutcome {
    class Success(val raw: RawCapture) : CaptureOutcome
    /** Nothing usable was written; [message] is shown to the user. */
    class Failure(val message: String) : CaptureOutcome
}

internal interface CaptureEngine {
    val kind: EngineKind
    val live: StateFlow<LiveSample>
    val status: StateFlow<EngineStatus>
    val info: StateFlow<EngineInfo>

    /**
     * Takes one photo and writes it to [target] (a file from `ProjectStore.newFrameTempFile`).
     * This is the only encode of that image.
     * @param deviceRotationCw physical device rotation (see `DeviceOrientation`)
     */
    suspend fun capture(target: File, deviceRotationCw: Int): CaptureOutcome
}

/** Result of aiming the reticle at the object (AR engine). */
internal sealed interface ObjectHit {
    /** @param surface what was hit, in words ("a depth point", "a tracked feature point", "a detected surface") */
    class Found(val center: Vec3, val distanceM: Float, val surface: String) : ObjectHit
    class Missed(val reason: String) : ObjectHit
}

/** Engines that can locate the object in the tracked world. */
internal interface ObjectAiming {
    /** Hit-tests the centre of the view against depth, feature points and detected planes. */
    suspend fun setObjectAtReticle(): ObjectHit
}

/** Engines that can hold focus / exposure / white balance. */
internal interface ExposureLocking {
    fun setLock(lock: Boolean)
}

internal object JpegLuma {
    /**
     * Luma of a stored photo, box-filtered to [FrameAnalysis.ANALYSIS_WIDTH] columns, in stored
     * (un-rotated) orientation — the same measurement the importer makes, so sharpness values of
     * captured and imported photos are comparable. null if the file cannot be decoded.
     */
    fun analysisLuma(file: File, knownWidth: Int = 0): Triple<ByteArray, Int, Int>? {
        var width = knownWidth
        if (width <= 0) {
            val b = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.path, b)
            width = b.outWidth
            if (width <= 0) return null
        }
        var sample = 1
        while (width / (sample * 2) >= FrameAnalysis.ANALYSIS_WIDTH) sample *= 2
        val opts = BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        val bitmap = try { BitmapFactory.decodeFile(file.path, opts) } catch (t: Throwable) { null } ?: return null
        try {
            val w = bitmap.width
            val h = bitmap.height
            if (w <= 0 || h <= 0) return null
            val luma = ByteArray(w * h)
            val row = IntArray(w)
            for (y in 0 until h) {
                bitmap.getPixels(row, 0, w, 0, y, w, 1)
                val base = y * w
                for (x in 0 until w) {
                    val p = row[x]
                    // BT.601 luma, integer arithmetic
                    luma[base + x] = ((((p shr 16) and 0xFF) * 77 + ((p shr 8) and 0xFF) * 150 + (p and 0xFF) * 29) shr 8).toByte()
                }
            }
            return FrameAnalysis.downsample(luma, w, h)
        } finally {
            bitmap.recycle()
        }
    }
}
