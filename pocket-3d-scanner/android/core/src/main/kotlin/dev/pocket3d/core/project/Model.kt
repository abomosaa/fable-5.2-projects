package dev.pocket3d.core.project

import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.net.JobError
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/*
 * On-phone project data model. Everything is plain serialisable data; persistence lives behind
 * ProjectStore. Layout on disk (app-private storage):
 *
 *   projects/<projectId>/project.json
 *   projects/<projectId>/sessions/<sessionId>/session.json      capture session (frames metadata)
 *   projects/<projectId>/sessions/<sessionId>/frames/<frameId>.<ext>   ORIGINAL photo bytes
 *   projects/<projectId>/jobs/<jobId>/job.json                  reconstruction job record
 *   projects/<projectId>/jobs/<jobId>/sparse_preview.json       provisional preview (if received)
 *   projects/<projectId>/models/<modelId>/model.glb             reconstruction result, immutable
 *   projects/<projectId>/models/<modelId>/{cameras,diagnostics}.json
 *   projects/<projectId>/models/<modelId>/edits.json            edit stack, scale, measurements
 *   projects/<projectId>/models/<modelId>/thumbnail.png         rendered from the actual result
 */

@Serializable
data class Project(
    val id: String,
    val name: String,
    val createdAtMs: Long,
    val updatedAtMs: Long,
    val sessionIds: List<String> = emptyList(),
    val jobIds: List<String> = emptyList(),
    val modelIds: List<String> = emptyList(),
    /** Model shown by default. Changes only when a new job has fully succeeded or the user picks one. */
    val activeModelId: String? = null,
    val format: Int = 1,
)

/** Lightweight row for the library list. */
data class ProjectSummary(
    val project: Project,
    val frameCount: Int,
    val diskBytes: Long,
    val thumbnailPath: String?,
    /** Phase of the most recent job, or null if none was ever started. */
    val latestJobPhase: JobPhase?,
    val latestJobProgress: Float,
    val hasModel: Boolean,
)

@Serializable
enum class CaptureSource {
    /** Phone camera with ARCore motion tracking (tracked viewpoints, metric poses). */
    @SerialName("camera_ar") CAMERA_AR,
    /** Phone camera without AR tracking (orientation sensor guidance only). */
    @SerialName("camera") CAMERA,
    /** Photos imported from files / the photo picker. */
    @SerialName("import") IMPORT,
}

@Serializable
data class DeviceInfo(val manufacturer: String = "", val model: String = "", @SerialName("android_sdk") val androidSdk: Int = 0)

@Serializable
data class Intrinsics(val fx: Double, val fy: Double, val cx: Double, val cy: Double,
                      /** arcore | camera2 | exif */ val source: String)

@Serializable
data class Distortion(val model: String = "opencv5", val k: List<Double> = emptyList())

/**
 * AR tracking pose of the camera: camera-to-world, metres, world +Y up, camera axes GL-style
 * (+X right, +Y up, −Z forward) relative to the STORED image orientation. [segment] changes
 * whenever tracking was lost and re-initialised; poses of different segments must never be
 * assumed to share a coordinate system.
 */
@Serializable
data class CameraPose(val t: List<Double>, val q: List<Double>, val segment: Int = 0)

@Serializable data class FocusInfo(val locked: Boolean, @SerialName("distance_diopters") val distanceDiopters: Double? = null)
@Serializable data class ExposureInfo(val locked: Boolean, val iso: Int? = null, @SerialName("exposure_ns") val exposureNs: Long? = null)

@Serializable
data class FrameQuality(
    /** Variance of the Laplacian of the luma image (0..∞, higher = sharper), on a 480 px wide analysis image. */
    val sharpness: Double? = null,
    /** Fraction of pixels ≤ 8/255 and ≥ 247/255. */
    @SerialName("clipped_low") val clippedLow: Double? = null,
    @SerialName("clipped_high") val clippedHigh: Double? = null,
    @SerialName("mean_luma") val meanLuma: Double? = null,
    /** Estimated share of this view also seen by the previous kept view (0..1), when tracking allows. */
    val overlap: Double? = null,
)

/** Flags attached to weak frames. Names are part of the capture metadata format. */
object FrameFlag {
    const val BLUR = "blur"
    const val DARK = "dark"
    const val OVEREXPOSED = "overexposed"
    const val DUPLICATE = "duplicate"
    const val LOW_OVERLAP = "low_overlap"
    const val TRACKING_LOST = "tracking_lost"
    const val FAST_MOTION = "fast_motion"
    const val LOW_RESOLUTION = "low_resolution"
    const val NO_METADATA = "no_metadata"

    fun describe(flag: String): String = when (flag) {
        BLUR -> "Blurry — hold still or add light"
        DARK -> "Too dark — details are lost in shadow"
        OVEREXPOSED -> "Overexposed — highlights are blown out"
        DUPLICATE -> "Nearly identical to another photo"
        LOW_OVERLAP -> "Too far from the previous view — little overlap"
        TRACKING_LOST -> "Taken while motion tracking was lost"
        FAST_MOTION -> "Camera was moving fast"
        LOW_RESOLUTION -> "Low resolution"
        NO_METADATA -> "No camera metadata (focal length unknown)"
        else -> flag
    }
}

@Serializable
data class Frame(
    val id: String,
    /** Display / original file name. Never used as a path. */
    val name: String,
    /** File name inside the session's frames directory (generated by the app: "<id>.<ext>"). */
    val file: String,
    @SerialName("timestamp_ms") val timestampMs: Long? = null,
    /** Stored pixel size, before applying EXIF orientation. */
    val width: Int = 0,
    val height: Int = 0,
    @SerialName("exif_orientation") val exifOrientation: Int = 1,
    val intrinsics: Intrinsics? = null,
    val distortion: Distortion? = null,
    val pose: CameraPose? = null,
    val focus: FocusInfo? = null,
    val exposure: ExposureInfo? = null,
    val quality: FrameQuality = FrameQuality(),
    val flags: List<String> = emptyList(),
    val sizeBytes: Long = 0,
    val sha256: String = "",
    /** jpeg | png | webp | heic */
    val format: String = "jpeg",
    /** The user excluded this frame from reconstruction (the original file is kept). */
    val excluded: Boolean = false,
)

@Serializable
data class TrackingSegment(val segment: Int, val frames: List<String>)

@Serializable
data class TrackingInfo(
    /** arcore | imu | none */
    val mode: String = "none",
    val segments: List<TrackingSegment> = emptyList(),
)

@Serializable
data class CaptureSession(
    val id: String,
    val projectId: String,
    val createdAtMs: Long,
    val updatedAtMs: Long,
    val source: CaptureSource,
    val device: DeviceInfo = DeviceInfo(),
    val frames: List<Frame> = emptyList(),
    val tracking: TrackingInfo = TrackingInfo(),
    /** Object centre chosen/estimated during an AR capture, AR world frame (metres). */
    val objectCenterAr: List<Double>? = null,
    /** Import ordering key chosen by the user: "name" | "time" | "manual". */
    val ordering: String = "time",
    val format: Int = 1,
) {
    val includedFrames: List<Frame> get() = frames.filter { !it.excluded }
}

@Serializable
data class StageTiming(val stage: String, val seconds: Double)

@Serializable
data class ReconJob(
    val id: String,
    val projectId: String,
    val sessionId: String,
    val preset: String,
    val settings: JsonObject = JsonObject(emptyMap()),
    /** Frames submitted for this job, in order. */
    val frameIds: List<String>,
    val phase: JobPhase = JobPhase.PENDING,
    val createdAtMs: Long,
    val updatedAtMs: Long,
    /** Companion that owns the remote job (server_id), so a different companion is never polled for it. */
    val companionId: String? = null,
    val companionName: String? = null,
    val attempt: Int = 1,
    val uploadedBytes: Long = 0,
    val totalBytes: Long = 0,
    val remoteState: String? = null,
    val stage: String? = null,
    val stageIndex: Int = 0,
    val stageCount: Int = 0,
    val stageProgress: Float = 0f,
    val overallProgress: Float = 0f,
    val message: String = "",
    val queuePosition: Int = 0,
    val lastEventSeq: Long = 0,
    val error: JobError? = null,
    /** Latest diagnostics object reported by the companion (registered cameras, coverage, …). */
    val diagnostics: JsonObject = JsonObject(emptyMap()),
    val hasSparsePreview: Boolean = false,
    /** Model created from this job once it COMPLETED. */
    val modelId: String? = null,
    /** Human-readable reason while waiting (e.g. "Companion unreachable — retrying"). */
    val waitingReason: String? = null,
    val startedAtMs: Long? = null,
    val finishedAtMs: Long? = null,
)

@Serializable
data class ModelVersion(
    val id: String,
    val projectId: String,
    val jobId: String,
    val sessionId: String,
    val preset: String,
    val settingsFingerprint: String = "",
    val createdAtMs: Long,
    val glbSha256: String,
    val glbBytes: Long,
    val vertexCount: Int = 0,
    val faceCount: Int = 0,
    val textureBytes: Long = 0,
    val registeredCameras: Int = 0,
    val inputFrames: Int = 0,
    /** Scale information delivered by the reconstruction ("arbitrary" unless validated AR scale). */
    val reconstructionScale: ScaleInfo = ScaleInfo(),
    val name: String = "",
)

/** Scale statement of a reconstruction, mirrors `asset.extras.pocket3d.scale` in the GLB. */
@Serializable
data class ScaleInfo(
    /** "meters" or "arbitrary". */
    val units: String = "arbitrary",
    /** none | ar_tracking | user_reference */
    val source: String = "none",
    @SerialName("meters_per_unit") val metersPerUnit: Double? = null,
    @SerialName("relative_uncertainty") val relativeUncertainty: Double? = null,
    val note: String = "",
) {
    val isMetric: Boolean get() = units == "meters" && metersPerUnit != null
}

/** A registered camera in the model frame, from cameras.json. */
@Serializable
data class ModelCamera(
    val id: String, val name: String = "", val index: Int = 0,
    val position: List<Double>, val q: List<Double>, val forward: List<Double> = emptyList(),
    val width: Int = 0, val height: Int = 0, val fx: Double = 0.0, val fy: Double = 0.0,
    val cx: Double = 0.0, val cy: Double = 0.0,
    @SerialName("fov_y_deg") val fovYDeg: Double = 45.0,
    @SerialName("sparse_points") val sparsePoints: Int = 0,
) {
    val positionVec: Vec3 get() = Vec3(position[0].toFloat(), position[1].toFloat(), position[2].toFloat())
}

@Serializable
data class UnregisteredFrame(val id: String, val reason: String = "")

@Serializable
data class CamerasDocument(
    val format: Int = 1, val frame: String = "model", val units: String = "arbitrary",
    val cameras: List<ModelCamera> = emptyList(),
    val unregistered: List<UnregisteredFrame> = emptyList(),
    val rejected: List<UnregisteredFrame> = emptyList(),
)

/** What deleting something will remove — shown to the user before they confirm. */
data class DeletionPlan(
    val projectName: String,
    val photoCount: Int,
    val photoBytes: Long,
    val modelCount: Int,
    val modelBytes: Long,
    val totalBytes: Long,
    /** Sessions that also exist on a paired companion (copies that deletion can remove remotely). */
    val companionSessionIds: List<String>,
    val companionName: String?,
    val companionReachable: Boolean,
)
